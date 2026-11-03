/**
 * Candidates for what is being typed: a /command the terminal handles, or an @file of the
 * workspace. Positions are grapheme indexes, as the editor counts them.
 */
import { graphemes } from './render/width.js'

export interface CommandInfo {
  name: string
  /** The argument it takes, as help shows it ("<n|id>"), if any. */
  usage?: string
  hint: string
  /** Whether it needs an argument: then choosing it puts it in, rather than running it. */
  args: boolean
}

export interface Completion {
  /** The text from..to (the cursor) that a chosen item replaces. */
  from: number
  to: number
  items: Array<{ label: string; insert: string; hint: string; run: boolean }>
}

export function complete(text: string, cursor: number, commands: readonly CommandInfo[], files?: (query: string) => string[]): Completion | null {
  const chars = graphemes(text)
  const before = chars.slice(0, cursor).join('')
  // A command: everything typed so far is "/" and the start of a name. "/Users/me" is not one.
  const command = /^\/([a-z]*)$/.exec(before)
  if (command !== null && cursor === chars.length) {
    const items = commands.filter((c) => c.name.startsWith(command[1])).map((c) => ({
      label: `/${c.name}`,
      // A space for an argument it takes, needed or not: tab leaves the cursor where it goes.
      insert: `/${c.name}${c.args || c.usage !== undefined ? ' ' : ''}`,
      hint: [c.usage, c.hint].filter(Boolean).join(' '),
      run: !c.args,
    }))
    return items.length === 0 ? null : { from: 0, to: cursor, items }
  }
  // A file: an @ that starts a word, up to the cursor.
  const mention = files === undefined ? null : /(^|\s)@([^\s@]*)$/.exec(before)
  if (mention !== null && files !== undefined) {
    const query = mention[2]
    const from = graphemes(before.slice(0, before.length - query.length - 1)).length
    const items = files(query).slice(0, 8).map((path) => ({ label: `@${path}`, insert: `@${path}${path.endsWith('/') ? '' : ' '}`, hint: '', run: false }))
    return items.length === 0 ? null : { from, to: cursor, items }
  }
  return null
}
