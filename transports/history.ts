/**
 * What every transport's history delta shares: which lines fit, the marker on the bot's own lines, and what people
 * wrote as a history shows it.
 */

/** Said in place of what a history leaves out, before what it shows. */
export const EARLIER_NOT_SHOWN = '(earlier messages not shown)'

/**
 * The adapter's marker at the start of each of the bot's own earlier lines, given only to a new session, which has
 * none of them. One of the markers the core's `defuse` marks as quoted anywhere it did not put one.
 */
export const OWN_MARKER = '[your earlier message]'

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
export function newestThatFit(lines: readonly string[], maxChars: number): number {
  let chars = 0
  let n = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    if (chars + lines[i].length > maxChars) break
    chars += lines[i].length
    n++
  }
  return n
}
