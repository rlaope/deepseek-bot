/**
 * Progress on the person's message as the bot's own reaction, for Discord and Telegram: what `Transport.mark` asks
 * for, kept per message. Slack's is its own (`slack.ts`), written first, with the same rules.
 *
 * The platform supplies the calls. `add` shows one reaction; `remove`, where the platform has it, takes one off — a
 * platform without it (Telegram) replaces the bot's reaction with each `add`; `held` says which of the bot's are on a
 * message, read once when a turn's first mark is not "taken" (a restart came between). The wanted mark is shown before the
 * others come off, so the message is never bare; a burst is merged into its newest mark; a remove that failed is
 * tried again by the next mark; and the end, which has no next mark, is tried again after a pause, a few times.
 *
 * A call answers how it went: `refused` stops every mark until the gateway restarts (said once), `gone` lets that
 * message go (deleted, or a chat that does not allow the reaction), `failed` is worth another try.
 */
import type { ProgressMark, Target } from '../types/transport.js'

export type MarkOutcome = 'ok' | 'failed' | 'gone' | 'refused'

export interface MarkNames {
  seen: string
  /** One per tenth, 1 to 9; a single name when the platform has no digits. */
  working: string[]
  done: string
  failed: string
  stopped: string
}

export interface MarkHost {
  names: MarkNames
  add(channel: string, ts: string, name: string): Promise<MarkOutcome>
  remove?: (channel: string, ts: string, name: string) => Promise<MarkOutcome>
  /** Which reactions of the bot's a message already carries, or null when that cannot be read. */
  held?: (channel: string, ts: string) => Promise<string[] | null>
  log: (...parts: unknown[]) => void
  /** Said once, when a call comes back `refused`. */
  refusal: string
  /** The pause unit between tries of the end (×1, ×5, ×15). */
  retryMs: number
}

const END_PAUSES = [1, 5, 15]

export function reactionMarks(host: MarkHost): (target: Target, ts: string, state: ProgressMark) => void {
  const { names, log, remove } = host
  // By the name without U+FE0F, which a platform may write either way (a keycap, ⏹️): the name this sends.
  const bare = (name: string) => name.replace(/\uFE0F/g, '')
  const ours = new Map([names.seen, ...names.working, names.done, names.failed, names.stopped].map((n) => [bare(n), n]))
  let refused = false
  type Marked = { shown: Set<string>; want: string; ended: boolean; dead: boolean; running: boolean; read: boolean }
  const marked = new Map<string, Marked>()

  function nameOf(state: ProgressMark): string {
    if (state.kind !== 'working') return names[state.kind]
    const at = Math.min(names.working.length, Math.max(1, Math.round(state.tenths * names.working.length / 9)))
    return names.working[at - 1]
  }

  function mark(target: Target, ts: string, state: ProgressMark): void {
    if (refused) return
    const key = `${target.channel}:${ts}`
    const name = nameOf(state)
    let entry = marked.get(key)
    if (entry === undefined) {
      // The first mark this process makes on a message is "taken" — unless a restart came between: then what this bot
      // left on it is read first, so a digit from before is taken off. Nothing to read where an add replaces.
      entry = { shown: new Set(), want: name, ended: false, dead: false, running: false, read: state.kind === 'seen' || remove === undefined }
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

  /** True when the outcome ends this message's marks (or every mark). */
  function over(outcome: MarkOutcome, entry: Marked): boolean {
    if (outcome === 'refused') {
      if (!refused) log(`progress marks: ${host.refusal}; no more marks until the gateway restarts`)
      refused = true
      marked.clear()
      return true
    }
    if (outcome === 'gone') { entry.dead = true; return true }
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
        if (!entry.shown.has(want)) {
          const r = await host.add(channel, ts, want).catch(() => 'failed' as const)
          // Refused for this message (too many reactions on it, say): ours still come off, so no digit stays.
          if (r === 'gone' && remove !== undefined) for (const old of [...entry.shown]) await remove(channel, ts, old).catch(() => 'failed')
          if (over(r, entry)) return
          if (r === 'ok') {
            // Without a remove, an add replaces what was there.
            if (remove === undefined) entry.shown.clear()
            entry.shown.add(want)
          } else failed = true
        }
        // Only once the wanted one is on: a newer mark's own pass takes these off.
        for (const old of failed || remove === undefined ? [] : [...entry.shown]) {
          if (old === want || entry.want !== want) continue
          const r = await remove(channel, ts, old).catch(() => 'failed' as const)
          if (over(r, entry)) return
          if (r === 'ok') entry.shown.delete(old)
          else failed = true
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

  return mark
}
