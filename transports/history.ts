/**
 * What every transport's history delta shares: which lines fit, and the words for what was left out or is the bot's.
 */

/** Said in place of what a history leaves out, before what it shows. */
export const EARLIER_NOT_SHOWN = '(earlier messages not shown)'

/** Who a line is from when it is the bot's own: given only to a new session, which has none of them. */
export const OWN_EARLIER = 'you (earlier)'

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
