/**
 * Markdown tables as lists, for the platforms that show a table as its pipes: Slack, Discord and Telegram render
 * none, and an answer with one arrived as rows of `|` and a line of dashes. A row becomes a bullet, its first
 * cell in bold and the rest after a dash; with three columns or more, each later cell is named by its header.
 * A table inside a fenced code block is code, and stays; so does one with a row that has more cells than its
 * header, or a cell with an odd number of backticks (a pipe left unescaped in a code span or a link), which
 * would otherwise be rewritten wrongly. As in GFM, a line that starts a list, a heading or a quote ends a
 * table without outer pipes, even when it has pipes of its own.
 *
 * Not a code block of aligned columns: the code fonts these platforms use give Hangul no fixed width, so the
 * columns would not line up in the language this bot is most often spoken to in.
 */

/** A pipe that is not escaped. */
const PIPE = /(?<!\\)\|/

/** A row's cells: split at the pipes that are not escaped, the outer ones dropped, `\|` read as a pipe. */
function cells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(PIPE).map((cell) => cell.trim().replace(/\\\|/g, '|'))
}

/** A table's second line: cells of dashes, an alignment colon at either end, between pipes. Checked cell by cell. */
function separator(line: string): string[] | null {
  if (!PIPE.test(line)) return null
  const parts = cells(line)
  return parts.every((cell) => /^:?-+:?$/.test(cell)) ? parts : null
}

/** A line that starts a block of its own (a list item, a heading, a quote) ends a table. */
const BLOCK = /^\s*([-*+]|\d+[.)]|#{1,6}|>)\s/

function bullet(header: string[], row: string[]): string {
  // A first cell with stars of its own (bold already, a glob, `**kwargs`) or in italics is left as it is: bold around
  // it would break.
  const first = row[0]
  const lead = first === '' ? '' : first.includes('*') || /^_.*_$/.test(first) ? first : `**${first}**`
  const named = row.slice(1)
    .map((cell, k) => cell === '' ? '' : header.length > 2 && header[k + 1] ? `${header[k + 1]}: ${cell}` : cell)
    .filter((cell) => cell !== '')
  if (lead === '') return `- ${named.join(' · ')}`
  return named.length === 0 ? `- ${lead}` : `- ${lead} — ${named.join(' · ')}`
}

export function tablesAsLists(markdown: string): string {
  const lines = markdown.split('\n')
  const out: string[] = []
  let fence: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const mark = /^\s*(```|~~~)/.exec(line)?.[1]
    if (mark !== undefined && (fence === null || fence === mark)) { fence = fence === null ? mark : null; out.push(line); continue }
    const next = lines[i + 1]
    const header = fence !== null || !PIPE.test(line) || next === undefined ? null : cells(line)
    if (header === null || separator(next)?.length !== header.length) { out.push(line); continue }
    let j = i + 2
    const rows: string[][] = []
    for (; j < lines.length && PIPE.test(lines[j]) && lines[j].trim() !== '' && !BLOCK.test(lines[j]); j++) rows.push(cells(lines[j]))
    if (rows.some((row) => row.length > header.length || row.some((cell) => (cell.match(/`/g) ?? []).length % 2 === 1))) {
      for (const kept of lines.slice(i, j)) out.push(kept)
      i = j - 1
      continue
    }
    const filled = rows.filter((row) => row.some((cell) => cell !== ''))
    if (filled.length === 0 && header.some((cell) => cell !== '')) out.push(`- ${header.filter((cell) => cell !== '').join(' · ')}`)
    for (const row of filled) out.push(bullet(header, row))
    i = j - 1
  }
  return out.join('\n')
}
