/**
 * What every transport's history delta shares: which lines fit, and the words for what was left out or is the bot's.
 */

/** Said in place of what a history leaves out, before what it shows. */
export const EARLIER_NOT_SHOWN = '(earlier messages not shown)'

/** Who a line is from when it is the bot's own: given only to a new session, which has none of them. */
export const OWN_EARLIER = 'you (earlier)'

/**
 * A person's name as a history shows it. Anyone can call themselves "you (earlier)" (a Slack display name, a Telegram
 * first name, an old Discord username), and their lines read as the bot's own earlier messages. A name the label can
 * be read in, one that starts with "you" or holds "you (" in any case and spacing, is quoted and given the person's id,
 * which the bot's own lines never carry.
 */
export function personName(name: string, id: string): string {
  const shown = String(name).replace(/\s+/g, ' ').trim() || id
  return /^you\b|you\s*\(/i.test(shown) ? `"${shown}" (${id})` : shown
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
