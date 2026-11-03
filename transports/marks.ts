/**
 * Progress on the person's message as the bot's own reaction, for Slack, Discord and Telegram: what `Transport.mark`
 * asks for, kept per message.
 *
 * The platform supplies the calls. `add` shows one reaction; `remove`, where the platform has it, takes one off — a
 * platform without it (Telegram) replaces the bot's reaction with each `add`; `held` says which of the bot's are on a
 * message, read once when a turn's first mark is not "taken" (a restart came between). The wanted mark is shown before the
 * others come off, so the message is never bare; a burst is merged into its newest mark; a remove that failed is
 * tried again by the next mark; and the end, which has no next mark, is tried again after a pause, a few times.
 *
 * A call answers how it went: `refused` stops every mark until the gateway restarts (said once), `gone` lets that
 * message go (deleted, or a chat that does not allow the reaction) once ours are taken off it where they can be,
 * `unreachable` lets it go with no other call on it (a platform that can tell the message or its channel is out of
 * reach), `failed` is worth another try.
 *
 * The `marks` setting chooses how much of this shows: `progress` all of it, `simple` no digit (taken, then the end),
 * `off` none — but the salute for a quiet word, which is an answer, not progress.
 *
 * The model's own reaction (`react`, from `[react:👍]`) goes on the same message by the same calls, after the mark it
 * finds there, and is kept apart from the marks: the marks never take it off, even one with a mark's name. Where an add
 * replaces (Telegram), it takes the place of the check, and a cross still replaces it. One that does not go on is said
 * and let go, never swapped for another.
 */
import type { ProgressMark, Target } from '../types/transport.js'

export type MarkOutcome = 'ok' | 'failed' | 'gone' | 'unreachable' | 'refused'

export type MarksMode = 'progress' | 'simple' | 'off'
export const MARKS_MODES: readonly MarksMode[] = ['progress', 'simple', 'off']

/** What the model may put on a message, on every platform that has the emoji: each platform maps the ones it has. */
export const REACTIONS = ['👍', '👎', '✅', '❌', '👀', '🙏', '🔥', '🎉', '😂', '❤️', '🤔', '🫡'] as const

export interface MarkNames {
  seen: string
  /** One per tenth, 1 to 9; a single name when the platform has no digits. */
  working: string[]
  done: string
  failed: string
  stopped: string
  quiet: string
}

export interface MarkHost {
  names: MarkNames
  add(channel: string, ts: string, name: string): Promise<MarkOutcome>
  /** `clearing`: ours coming off a message let go as `gone`, whose answers are not acted on. */
  remove?: (channel: string, ts: string, name: string, clearing: boolean) => Promise<MarkOutcome>
  /** Which reactions of the bot's a message already carries, or null when that cannot be read. */
  held?: (channel: string, ts: string) => Promise<string[] | null>
  log: (...parts: unknown[]) => void
  /** Said once, when a call comes back `refused`: read then, so it can name what the platform answered. */
  refusal: string
  /** The pause unit between tries of the end (×1, ×5, ×15). */
  retryMs: number
  /** The `marks` setting, validated at start; unset or empty is `progress`. */
  mode?: MarksMode
  /** The model's reactions this platform can put (of `REACTIONS`), each with the name it is sent by. */
  reactions: Partial<Record<(typeof REACTIONS)[number], string>>
}

// Spread over a minute: three tries within one rate window would all be refused together.
const END_PAUSES = [1, 5, 15]

export interface Marks {
  (target: Target, ts: string, state: ProgressMark): void
  /** Of `REACTIONS`, those this platform can put. */
  readonly reactions: string[]
  /** The model's reaction on a message: one of `reactions`, anything else is said and not put. */
  react(target: Target, ts: string, emoji: string): void
  /** Diagnostic only: messages whose marks are still held. */
  readonly messages: number
}

export function reactionMarks(host: MarkHost): Marks {
  const { names, log, remove } = host
  // Unset or empty is the default.
  const mode = host.mode || 'progress'
  // By the name without U+FE0F, which a platform may write either way (a keycap, ⏹️): the name this sends.
  const bare = (name: string) => name.replace(/\uFE0F/g, '')
  const ours = new Map([names.seen, ...names.working, names.done, names.failed, names.stopped, names.quiet].map((n) => [bare(n), n]))
  let refused = false
  // `model`: the model's reactions by the name sent, true once on.
  type Marked = { shown: Set<string>; want: string | null; model: Map<string, boolean>; ended: boolean; dead: boolean; running: boolean; read: boolean }
  const marked = new Map<string, Marked>()

  function nameOf(state: ProgressMark): string {
    if (state.kind !== 'working') return names[state.kind]
    const at = Math.min(names.working.length, Math.max(1, Math.round(state.tenths * names.working.length / 9)))
    return names.working[at - 1]
  }

  function mark(target: Target, ts: string, state: ProgressMark): void {
    if (refused) return
    if (mode === 'off' && state.kind !== 'quiet') return
    if (mode === 'simple' && state.kind === 'working') return
    const key = `${target.channel}:${ts}`
    const name = nameOf(state)
    let entry = marked.get(key)
    if (entry === undefined) {
      // The first mark this process makes on a message is "taken" — unless a restart came between: then what this bot
      // left on it is read first, so a digit from before is taken off. Nothing to read where an add replaces.
      entry = { shown: new Set(), want: name, model: new Map(), ended: false, dead: false, running: false, read: state.kind === 'seen' || remove === undefined }
      marked.set(key, entry)
    }
    const end = state.kind !== 'seen' && state.kind !== 'working'
    // A message that is gone is remembered until its turn ends, so its digits are not asked for one by one.
    if (entry.dead) { if (end) marked.delete(key); return }
    if (entry.ended) return
    entry.want = name
    entry.ended = end
    if (!entry.running) void settle(target.channel, ts, key, entry)
  }

  function react(target: Target, ts: string, emoji: string): void {
    const name = (host.reactions as Record<string, string | undefined>)[emoji]
    if (name === undefined) { log(`reaction ${emoji} not put on ${ts}: not one this platform can put`); return }
    if (refused) { log(`reaction ${emoji} not put on ${ts}: ${host.refusal}`); return }
    const key = `${target.channel}:${ts}`
    let entry = marked.get(key)
    // No mark on it (marks off, a turn that did not mention it): an entry of its own, which nothing else will end.
    if (entry === undefined) {
      entry = { shown: new Set(), want: null, model: new Map(), ended: true, dead: false, running: false, read: true }
      marked.set(key, entry)
    }
    if (entry.dead) { log(`reaction ${emoji} not put on ${ts}: the message cannot take reactions`); return }
    if (!entry.model.has(name)) entry.model.set(name, false)
    if (!entry.running) void settle(target.channel, ts, key, entry)
  }

  /** True when the outcome ends this message's marks (or every mark). */
  function over(outcome: MarkOutcome, entry: Marked): boolean {
    if (outcome === 'refused') {
      if (!refused) log(`progress marks: ${host.refusal}; no more marks until the gateway restarts`)
      refused = true
      marked.clear()
      return true
    }
    if (outcome === 'gone' || outcome === 'unreachable') { entry.dead = true; return true }
    return false
  }

  async function settle(channel: string, ts: string, key: string, entry: Marked): Promise<void> {
    entry.running = true
    try {
      if (!entry.read) {
        entry.read = true
        const held = host.held === undefined ? null : await host.held(channel, ts).catch(() => null)
        // Not read: what a lost turn can have left (eyes, a digit) may be there, so each is taken off. Never the mark
        // wanted now, which must still be added.
        for (const n of held ?? [names.seen, ...names.working]) {
          const own = ours.get(bare(n))
          if (own !== undefined && (held !== null || own !== entry.want)) entry.shown.add(own)
        }
      }
      for (let tries = 0; ;) {
        const want = entry.want
        let failed = false
        // The model's reaction already on is that mark too; where an add replaces, the model's takes the check's place.
        if (want !== null && entry.model.get(want) === true) entry.shown.add(want)
        const yields = remove === undefined && want === names.done && entry.model.size > 0
        if (want !== null && !yields && !entry.shown.has(want)) {
          const r = await host.add(channel, ts, want).catch(() => 'failed' as const)
          // Refused for this message (too many reactions on it, say): ours still come off, so no digit stays.
          if (r === 'gone' && remove !== undefined) for (const old of [...entry.shown]) await remove(channel, ts, old, true).catch(() => 'failed')
          if (over(r, entry)) return
          if (r === 'ok') {
            // Without a remove, an add replaces what was there: the model's reaction too.
            if (remove === undefined) { entry.shown.clear(); for (const [n, on] of entry.model) if (on) entry.model.delete(n) }
            entry.shown.add(want)
          } else failed = true
        }
        // Only once the wanted one is on: a newer mark's own pass takes these off. Never the model's.
        for (const old of failed || remove === undefined ? [] : [...entry.shown]) {
          if (old === want || entry.want !== want || entry.model.has(old)) continue
          const r = await remove(channel, ts, old, false).catch(() => 'failed' as const)
          if (over(r, entry)) return
          if (r === 'ok') entry.shown.delete(old)
          else failed = true
        }
        // The model's, after the mark: where an add replaces, the last one put is the one that shows. Tried once: one
        // that does not go on is said and let go, and where it was to take the check's place, the check goes on (the
        // check comes after the reaction, so the next pass puts it).
        for (const [name, on] of [...entry.model]) {
          if (on) continue
          if (entry.shown.has(name)) { entry.model.set(name, true); continue }
          const r = await host.add(channel, ts, name).catch(() => 'failed' as const)
          if (r === 'ok') {
            if (remove === undefined) entry.shown.clear()
            entry.model.set(name, true)
            continue
          }
          log(`reaction ${Object.keys(host.reactions).find((e) => (host.reactions as Record<string, string>)[e] === name) ?? name} not put on ${ts}: ${r}`)
          entry.model.delete(name)
          if ((r === 'refused' || r === 'unreachable') && over(r, entry)) return
        }
        if (entry.want !== want) continue   // a newer mark came meanwhile
        // A digit that failed waits for the next digit; the end has none, so it is tried again after a pause.
        if (!failed || !entry.ended || tries >= END_PAUSES.length) return
        await new Promise((r) => setTimeout(r, host.retryMs * END_PAUSES[tries++]).unref?.())
      }
    } catch (e) {
      log(`progress marks: ${String((e as Error)?.message ?? e)}`)
    } finally {
      entry.running = false
      if (entry.ended && marked.get(key) === entry) marked.delete(key)
    }
  }

  const reactions = REACTIONS.filter((e) => host.reactions[e] !== undefined)
  return Object.defineProperties(Object.assign(mark, { reactions, react }), { messages: { get: () => marked.size } }) as unknown as Marks
}
