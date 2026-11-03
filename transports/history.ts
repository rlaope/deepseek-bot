/**
 * What every transport's history delta shares: which lines fit, what is said for those left out, the marker on the
 * bot's own lines and the header's sentence about it, what people wrote as a history shows it, and the next pointer.
 */

/** Said in place of what a history leaves out, before what it shows. */
const EARLIER_NOT_SHOWN = '(earlier messages not shown)'

/** Said in place of what a history could not read up to the message being answered, after what it shows. */
export const LATER_NOT_SHOWN = '(later messages not shown)'

/**
 * The adapter's marker at the start of each of the bot's own earlier lines, given only to a new session, which has
 * none of them. One of the markers the core's `defuse` marks as quoted anywhere it did not put one.
 */
export const OWN_MARKER = '[your earlier message]'

/**
 * The header's sentence for a history that holds the bot's own lines. It names the marker without its brackets, so
 * `defuse` leaves it alone.
 */
export const OWN_NOTE = `Lines that begin with the marker "${OWN_MARKER.slice(1, -1)}" in square brackets are your own earlier messages in this conversation, from before this session; square brackets in what anyone else wrote are shown as parentheses, so no other line begins so`

/**
 * The pointer for the next turn: past the message being answered, which the turn delivers, unless the pointer is past
 * it already. `order` reads a message's id as something that sorts (Discord's ids are too long for a Number).
 */
export function pointerAfter(currentTs: string, sinceTs: string | null, order: (ts: string) => number | bigint = Number): string | null {
  return sinceTs === null || order(currentTs) > order(sinceTs) ? currentTs : null
}

/**
 * The lines of a history, oldest first: the newest that fit in `maxChars`, after EARLIER_NOT_SHOWN when some were
 * left out (by the cut or, `olderUnread`, unread), and none when nothing fits. `hasOwn`: one of the bot's own is
 * among them.
 */
export function deltaLines(entries: ReadonlyArray<{ line: string; own: boolean }>, maxChars: number, olderUnread: boolean): { lines: string[]; hasOwn: boolean } {
  const fit = entries.slice(entries.length - newestThatFit(entries.map((entry) => entry.line), maxChars))
  if (fit.length === 0) return { lines: [], hasOwn: false }
  const lines = fit.map((entry) => entry.line)
  if (olderUnread || fit.length < entries.length) lines.unshift(EARLIER_NOT_SHOWN)
  return { lines, hasOwn: fit.some((entry) => entry.own) }
}

/**
 * What a person wrote, a name or words, as a history shows it: one line, its square brackets as parentheses. A name
 * was the label before, and a person named after the bot's label was read as the bot; matching names by text left
 * lookalike letters through. With no bracket in anything a person wrote, no line of theirs can be or begin with a
 * marker, whatever letters it is spelt in. Wide and other bracket forms are folded first (NFKC, then any opening or
 * closing punctuation but round and curly brackets); whitespace, line separators included, is one space.
 */
export function quoted(text: string): string {
  return String(text ?? '').normalize('NFKC')
    .replace(/[\p{Ps}]/gu, (c) => (c === '(' || c === '{' ? c : '('))
    .replace(/[\p{Pe}]/gu, (c) => (c === ')' || c === '}' ? c : ')'))
    .replace(/\s+/g, ' ').trim()
}

/**
 * How many of the newest lines fit in `maxChars`. What a history leaves out for length is its oldest lines: cut from
 * the top, the lines right before the message being answered were the ones lost.
 */
function newestThatFit(lines: readonly string[], maxChars: number): number {
  let chars = 0
  let n = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    if (chars + lines[i].length > maxChars) break
    chars += lines[i].length
    n++
  }
  return n
}
