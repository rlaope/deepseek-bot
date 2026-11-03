/**
 * The frame: a grid of cells, and the bytes that turn the previous frame into this one.
 *
 * This is where the TUI is fast or slow. A streamed answer changes a few cells per chunk, and a
 * renderer that repaints the screen for each one writes kilobytes per token and flickers. The
 * diff writes only the cells that changed, merges nearby changes into one run (a cursor move
 * costs more than a few unchanged cells), and wraps the whole frame in synchronized output so
 * the terminal shows it at once.
 */
import { graphemes, graphemeWidth } from './width.js'

/** One terminal column. A wide character's second column is a continuation: `ch` is ''. */
export interface Cell {
  ch: string
  /** The style's SGR string; '' is the terminal default. */
  style: string
  /** The hyperlink (OSC 8) the cell belongs to; absent for plain text. */
  link?: string
}

export const BLANK: Cell = Object.freeze({ ch: ' ', style: '' })

export const SYNC_BEGIN = '\x1b[?2026h'
export const SYNC_END = '\x1b[?2026l'

export class Screen {
  readonly cols: number
  readonly rows: number
  readonly cells: Cell[]
  /** Where the hardware cursor should rest after the frame, or null to keep it hidden. */
  cursor: { x: number; y: number } | null = null

  constructor(cols: number, rows: number) {
    this.cols = Math.max(1, cols)
    this.rows = Math.max(1, rows)
    this.cells = new Array(this.cols * this.rows).fill(BLANK)
  }

  at(x: number, y: number): Cell {
    return this.cells[y * this.cols + x]
  }

  /**
   * Draw text from (x, y), clipped at `maxX` (exclusive, default the right edge).
   * Returns the column after the last cell written.
   */
  put(x: number, y: number, text: string, style = '', maxX = this.cols, link?: string): number {
    if (y < 0 || y >= this.rows) return x
    const limit = Math.min(maxX, this.cols)
    let col = x
    for (const g of graphemes(text)) {
      const w = graphemeWidth(g)
      if (w === 0) continue
      if (col + w > limit) break
      if (col >= 0) {
        this.release(y, col)
        if (w === 2) this.release(y, col + 1)
        this.cells[y * this.cols + col] = link === undefined ? { ch: g, style } : { ch: g, style, link }
        if (w === 2) this.cells[y * this.cols + col + 1] = link === undefined ? { ch: '', style } : { ch: '', style, link }
      }
      col += w
    }
    return col
  }

  /** Paint `width` cells from (x, y) with blanks of `style`. */
  fill(x: number, y: number, width: number, style = ''): void {
    if (y < 0 || y >= this.rows) return
    const cell = style === '' ? BLANK : { ch: ' ', style }
    for (let col = Math.max(0, x); col < Math.min(this.cols, x + width); col++) {
      this.release(y, col)
      this.cells[y * this.cols + col] = cell
    }
  }

  /**
   * About to overwrite (x, y): if it is half of a wide character, blank the other half, so a
   * frame never holds a lead without its continuation or the reverse.
   */
  private release(y: number, x: number): void {
    const i = y * this.cols + x
    const cell = this.cells[i]
    if (cell.ch === '' && x > 0) this.cells[i - 1] = { ch: ' ', style: this.cells[i - 1].style }
    else if (x + 1 < this.cols && this.cells[i + 1].ch === '') this.cells[i + 1] = { ch: ' ', style: this.cells[i + 1].style }
  }
}

/**
 * A grapheme of more than one code point (an emoji made by VS16, a ZWJ sequence, a flag, a base with its
 * marks): terminals disagree on how wide they draw it. ⚠️ is two columns in some and one in xterm's, and a
 * run written after a narrower one lands a column to the left, leaving its old last cell on screen.
 */
function uncertain(g: string): boolean {
  return g.length > 2 || (g.length === 2 && g.codePointAt(0)! < 0x10000)
}

function same(a: Cell, b: Cell): boolean {
  return a === b || (a.ch === b.ch && a.style === b.style && a.link === b.link)
}

/** Unchanged cells shorter than this between two changes are rewritten rather than skipped. */
const MERGE_GAP = 4

/**
 * Bytes that bring the terminal from `prev` to `next`. With no `prev` (first frame, resize) the
 * screen is cleared and every non-blank cell written. The result is wrapped in synchronized
 * output and leaves the cursor where `next.cursor` says, or hidden.
 */
export function diff(prev: Screen | null, next: Screen): string {
  const full = prev === null || prev.cols !== next.cols || prev.rows !== next.rows
  let out = SYNC_BEGIN + '\x1b[?25l'
  if (full) out += '\x1b[0m\x1b[2J'
  let pen: string | null = full ? '' : null   // the SGR currently active on the terminal; null = unknown

  for (let y = 0; y < next.rows; y++) {
    const row = y * next.cols
    let x = 0
    while (x < next.cols) {
      // Find the next changed cell.
      if (full ? same(next.cells[row + x], BLANK) : same(prev!.cells[row + x], next.cells[row + x])) { x++; continue }
      let start = x
      // Never start a run on a continuation cell: its glyph is drawn from the cell before.
      if (next.cells[row + start].ch === '' && start > 0) start--
      // Extend the run while changes keep coming within MERGE_GAP.
      let end = x + 1
      let gap = 0
      for (let k = end; k < next.cols; k++) {
        const changed = full ? !same(next.cells[row + k], BLANK) : !same(prev!.cells[row + k], next.cells[row + k])
        if (changed) { end = k + 1; gap = 0 } else if (++gap >= MERGE_GAP) break
      }
      // A run that ends on a wide character's lead must include its continuation.
      if (end < next.cols && next.cells[row + end].ch === '') end++
      out += `\x1b[${y + 1};${start + 1}H`
      let link = ''
      for (let k = start; k < end; k++) {
        const cell = next.cells[row + k]
        if (cell.ch === '') continue
        // A hyperlink is opened where its cells start and closed where they end, within the run.
        if ((cell.link ?? '') !== link) { link = cell.link ?? ''; out += `\x1b]8;;${link}\x07` }
        if (pen !== cell.style) { out += cell.style === '' ? '\x1b[0m' : cell.style; pen = cell.style }
        if (uncertain(cell.ch)) {
          // Its cells blanked first, then the glyph, then the cursor put where the next cell is, however wide the
          // terminal drew it.
          const w = k + 1 < next.cols && next.cells[row + k + 1].ch === '' ? 2 : 1
          out += `${' '.repeat(w)}\x1b[${y + 1};${k + 1}H${cell.ch}\x1b[${y + 1};${k + w + 1}H`
        } else out += cell.ch
      }
      if (link !== '') out += '\x1b]8;;\x07'
      x = end
    }
  }
  if (pen !== null && pen !== '') out += '\x1b[0m'
  if (next.cursor !== null) out += `\x1b[${next.cursor.y + 1};${next.cursor.x + 1}H\x1b[?25h`
  return out + SYNC_END
}
