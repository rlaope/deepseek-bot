/**
 * Styled lines and word wrapping by display width.
 *
 * A `Line` is what every view produces and what the transcript, the selection and the screen
 * consume: spans of text with a style, a flag saying whether it continues the previous line
 * (soft wrap — copied without a newline), and spans marked as decoration (a prompt mark, an
 * indent) that a copy leaves out.
 */
import { expandTabs, graphemes, graphemeWidth, stringWidth } from './width.js'

export interface Span {
  text: string
  /** SGR string; '' is the default style. */
  style: string
  /** Prefixes and indents: drawn, never copied. */
  decor?: boolean
  /** A hyperlink target (OSC 8): the terminal makes the text clickable. */
  link?: string
}

export interface Line {
  spans: Span[]
  /** True when this line is the continuation of a wrapped line. */
  soft: boolean
  /** On a soft line: the source text the wrap removed at the break (a space), restored on copy. */
  gap?: string
}

/**
 * Break one paragraph into lines no wider than `width`, preferring spaces. A word longer than the
 * line is broken where it overflows. Never returns an empty array.
 */
export function wrapPlain(text: string, width: number): string[] {
  return wrap(text, width).map((piece) => piece.text)
}

/**
 * `wrapPlain`, keeping what each break removed (`gap`: the spaces at the break) so a copy of
 * soft-wrapped lines can put the source text back together exactly.
 */
export function wrap(text: string, width: number): Array<{ text: string; gap: string }> {
  const max = Math.max(1, width)
  if (stringWidth(text) <= max) return [{ text, gap: '' }]
  const out: Array<{ text: string; gap: string }> = []
  let line: string[] = []
  let widths: number[] = []
  let used = 0
  let lastSpace = -1
  let gap = ''   // what the break before the current line removed

  for (const g of graphemes(text)) {
    const w = graphemeWidth(g)
    while (used + w > max && line.length > 0) {
      // A space that overflows breaks right here: the line before it fits as it is.
      const at = g === ' ' ? line.length : lastSpace >= 0 ? lastSpace : line.length
      let cut = at
      let resume = g === ' ' || lastSpace < 0 ? at : at + 1
      while (cut > 0 && line[cut - 1] === ' ') cut--
      while (resume < line.length && line[resume] === ' ') resume++
      out.push({ text: line.slice(0, cut).join(''), gap })
      gap = line.slice(cut, resume).join('')
      line = line.slice(resume)
      widths = widths.slice(resume)
      used = widths.reduce((a, b) => a + b, 0)
      lastSpace = line.lastIndexOf(' ')
    }
    if (line.length === 0 && g === ' ' && out.length > 0) { gap += ' '; continue }   // no leading space after a break
    line.push(g)
    widths.push(w)
    used += w
    if (g === ' ') lastSpace = line.length - 1
  }
  if (line.length > 0 || out.length === 0) out.push({ text: line.join(''), gap })
  return out
}

/** Tab stops in plain text, a terminal's: a tool's output was written for one. */
const TAB_STOP = 8

/**
 * Lay out a block of text under a first-line prefix and a hanging indent, e.g. `› ` then `  `.
 * Newlines in `text` are hard breaks; tabs go to the next stop from the start of their line.
 */
export function layout(
  text: string,
  width: number,
  style: string,
  prefix: { first: Span; rest: Span },
): Line[] {
  const inner = Math.max(1, width - Math.max(stringWidth(prefix.first.text), stringWidth(prefix.rest.text)))
  const lines: Line[] = []
  for (const paragraph of text.split('\n')) {
    wrap(expandTabs(paragraph, TAB_STOP), inner).forEach((piece, i) => {
      const lead = lines.length === 0 ? prefix.first : prefix.rest
      lines.push({ spans: [{ ...lead, decor: true }, { text: piece.text, style }], soft: i > 0, ...(i > 0 ? { gap: piece.gap } : {}) })
    })
  }
  return lines
}

/**
 * The text between two points of a list of lines, as a user expects it on the clipboard:
 * decoration left out, soft-wrapped lines joined without a newline, trailing spaces trimmed.
 * Points are (line index, display column); `to` is exclusive in its column.
 */
export function extract(lines: Line[], from: { line: number; col: number }, to: { line: number; col: number }): string {
  const [a, b] = from.line < to.line || (from.line === to.line && from.col <= to.col) ? [from, to] : [to, from]
  let out = ''
  for (let i = a.line; i <= b.line && i < lines.length; i++) {
    const line = lines[i]
    const startCol = i === a.line ? a.col : 0
    const endCol = i === b.line ? b.col : Infinity
    let col = 0
    let piece = ''
    for (const span of line.spans) {
      for (const g of graphemes(span.text)) {
        const w = graphemeWidth(g)
        if (!span.decor && col >= startCol && col < endCol) piece += g
        // A wide character whose first column is before the start but second is inside counts.
        else if (!span.decor && w === 2 && col + 1 === startCol && endCol > startCol) piece += g
        col += w
      }
    }
    if (i > a.line) out = line.soft ? out + (line.gap ?? '') : out.replace(/ +$/, '') + '\n'
    out += piece
  }
  return out.replace(/ +$/, '')
}
