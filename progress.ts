/**
 * The in-place progress message.
 *
 * A turn can run for minutes, and a single static "working on it" tells the user
 * nothing. What they want to know is that it is still moving. This tracks one
 * message per conversation, updates it in place as the agent works, and hands the
 * message id back at the end so the answer can replace it rather than arrive as a
 * second message.
 *
 * It is a separate module because it is the part with rules worth testing — create
 * once, throttle the rest, never leave a message behind — and none of those rules
 * need an agent, a platform, or a turn to exercise.
 */
import { messages } from './messages.js'

export interface ProgressTarget {
  channel: string
  threadTs: string | null
}

export interface ProgressPoster {
  /** Sends, or replaces `replace` when given. Resolves to the message id, or null. */
  post(target: ProgressTarget, text: string, options?: { replace?: string | null }): Promise<{ ts: string } | null>
}

/**
 * How far along a turn is, in tenths, for a mark on the person's message: 1 at once, rising as the turn passes the
 * time a turn usually takes and slowing as it goes (1 - e^(-t/typical)), never 10 — that is the end's own mark.
 * A guess: nothing reports how much of a turn is left.
 */
export function tenthsOf(elapsedMs: number, typicalMs: number): number {
  return Math.min(9, Math.max(1, Math.floor(10 * (1 - Math.exp(-elapsedMs / Math.max(1, typicalMs))))))
}

/** The time a turn usually takes: the median of the last twenty answered, 30 s before any. */
export function typicalTurns() {
  const last: number[] = []
  return {
    record(ms: number): void { last.push(ms); if (last.length > 20) last.shift() },
    ms(): number {
      if (last.length === 0) return 30_000
      const sorted = [...last].sort((a, b) => a - b)
      return sorted[Math.floor(sorted.length / 2)]
    },
  }
}

export interface ProgressOptions {
  post: ProgressPoster['post']
  /** Everything but the first update waits at least this long between edits. */
  throttleMs: number
  /** Prefix for the message, e.g. "⏳ Ari is working…". A function is read at each render. */
  label: string | (() => string)
  now?: () => number
  log?: (...parts: unknown[]) => void
  /** How the tools so far are counted, in the deployment's language: "2 tools (bash)". */
  tools?: (n: number, last: string) => string
  /** Called once a conversation's message exists, with its id: the core records it for a restart. */
  onPosted?: (key: string, ts: string) => void
}

interface Entry {
  target: ProgressTarget
  ts: string | null
  lastUpdate: number
  tools: string[]
  startedAt: number
  /** The renders asked for so far, run one after another. */
  chain: Promise<void>
}

export function createProgressTracker(options: ProgressOptions) {
  const entries = new Map<string, Entry>()
  const now = options.now ?? (() => Date.now())
  const log = options.log ?? (() => {})

  /** "2 tools (bash) · 34s" — enough to see it is moving, short enough to read. */
  function summary(entry: Entry): string {
    const parts: string[] = []
    if (entry.tools.length > 0) {
      const last = entry.tools[entry.tools.length - 1]
      parts.push((options.tools ?? messages('en').tools)(entry.tools.length, last))
    }
    const seconds = Math.round((now() - entry.startedAt) / 1000)
    if (seconds >= 5) parts.push(`${seconds}s`)
    const label = typeof options.label === 'function' ? options.label() : options.label
    return parts.length === 0 ? label : `${label} — ${parts.join(' · ')}`
  }

  /**
   * One render at a time per conversation. A render asked for while the first post is still in flight
   * waits for it and then edits that message. Run side by side, both saw no message yet and both posted;
   * the answer replaced one, and the other stayed in the thread saying "작업 중" for good.
   */
  function render(key: string, entry: Entry): Promise<void> {
    entry.lastUpdate = now()
    const run = entry.chain.then(async () => {
      const text = summary(entry)
      if (entry.ts === null) {
        const posted = await options.post(entry.target, text)
        entry.ts = posted?.ts ?? null
        if (entry.ts !== null) options.onPosted?.(key, entry.ts)
        return
      }
      await options.post(entry.target, text, { replace: entry.ts })
    })
    // A failed render is the caller's to report; it must not stop the next one.
    entry.chain = run.catch(() => {})
    return run
  }

  return {
    /**
     * Record activity. Creates the message the first time, edits it afterwards,
     * and skips edits that would land inside the throttle window.
     */
    async note(key: string, target: ProgressTarget, toolName?: string): Promise<void> {
      let entry = entries.get(key)
      if (entry === undefined) {
        entry = { target, ts: null, lastUpdate: 0, tools: [], startedAt: now(), chain: Promise.resolve() }
        entries.set(key, entry)
      }
      if (toolName !== undefined) entry.tools.push(toolName)
      // Never rendered, rather than "no message id yet": a first post still in flight has no id either.
      const first = entry.lastUpdate === 0
      if (!first && now() - entry.lastUpdate < options.throttleMs) return
      await render(key, entry)
    },

    /** Create or edit now, ignoring the throttle: used when a turn turns slow. */
    async force(key: string, target: ProgressTarget): Promise<void> {
      let entry = entries.get(key)
      if (entry === undefined) {
        entry = { target, ts: null, lastUpdate: 0, tools: [], startedAt: now(), chain: Promise.resolve() }
        entries.set(key, entry)
      }
      await render(key, entry)
    },

    /** Wait for every render already asked for, so the answer takes the place of a message that exists. */
    async settle(key: string): Promise<void> {
      const entry = entries.get(key)
      if (entry === undefined) return
      // Until nothing more was queued while waiting: a render another message asked for meanwhile
      // would otherwise run after the answer had taken this message's place.
      let seen: Promise<void> | null = null
      while (seen !== entry.chain) { seen = entry.chain; await seen }
    },

    /** The message to replace with the answer, if one was posted. Clears the entry. */
    take(key: string): { ts: string | null; target: ProgressTarget } | null {
      const entry = entries.get(key)
      if (entry === undefined) return null
      entries.delete(key)
      return { ts: entry.ts, target: entry.target }
    },

    /** Whether this conversation has a message, or one on its way: a first post in flight counts. */
    tracks(key: string): boolean { return entries.has(key) },

    /** Whether a message already exists for this conversation. */
    has(key: string): boolean { return entries.get(key)?.ts !== null && entries.get(key) !== undefined },

    /** Drop tracking without posting anything, for a turn that produced no message. */
    forget(key: string): void { entries.delete(key) },

    /** How many conversations are being tracked, for tests and diagnostics. */
    size(): number { return entries.size },
  }
}
