/**
 * The scrollable conversation: blocks laid out once per width, a viewport over the result, and
 * a drag selection in the same coordinates.
 *
 * Layout is cached per block and invalidated by a version number, so a streamed answer re-wraps
 * only itself — the hundred messages above it cost nothing per token. The viewport follows the
 * bottom until the user scrolls away, and says how much arrived while they were reading.
 */
import { extract, type Line } from './text.js'
import { themeGeneration } from './style.js'

export interface Block {
  id: string
  /** Bump when the content changes; the cached layout is dropped. A string may carry an animation frame. */
  version: number | string
  lines(width: number): Line[]
  /** What the person sent, on a block of their own words: held at the top while a reader scrolls past it. */
  prompt?: string
}

interface Cached { version: number | string; width: number; theme: number; lines: Line[] }

export interface Point { line: number; col: number }

export class Transcript {
  private blocks: Block[] = []
  private cache = new Map<string, Cached>()
  private flat: Line[] = []
  /** Where each block's lines are in `flat`, in order. */
  private spans: Array<{ block: Block; from: number; to: number }> = []
  private flatWidth = -1
  /** The palette the layout was made in: a light terminal's answer draws every block again. */
  private flatTheme = -1
  private dirty = true
  /** First visible line. */
  top = 0
  /** Stick to the bottom as content grows. */
  follow = true
  /** Lines added below the viewport since the user scrolled away. */
  unseen = 0
  /** The next layout's growth is blocks folded or unfolded, not lines that arrived. */
  private quiet = false
  private lastHeight = 0
  private lastWidth = -1
  selection: { anchor: Point; head: Point } | null = null

  get size(): number {
    return this.flat.length
  }

  /**
   * Blocks kept on screen. A long session drops its oldest ones beyond this — the session log
   * keeps the conversation, and a terminal that held every block would grow without end.
   */
  static readonly MAX_BLOCKS = 2000

  push(block: Block): void {
    this.blocks.push(block)
    if (this.blocks.length > Transcript.MAX_BLOCKS) this.dropOldest(this.blocks.length - Transcript.MAX_BLOCKS)
    this.dirty = true
  }

  /** Start over: no blocks, at the bottom, nothing selected. */
  clear(): void {
    this.blocks = []
    this.cache.clear()
    this.top = 0
    this.follow = true
    this.unseen = 0
    this.selection = null
    this.dirty = true
  }

  remove(id: string): void {
    const i = this.blocks.findIndex((b) => b.id === id)
    if (i === -1) return
    this.blocks.splice(i, 1)
    this.cache.delete(id)
    this.selection = null   // line numbers moved under it
    this.dirty = true
  }

  private dropOldest(count: number): void {
    let lines = 0
    for (const block of this.blocks.splice(0, count)) {
      lines += this.cache.get(block.id)?.lines.length ?? 0
      this.cache.delete(block.id)
    }
    // Keep a reader's place: the lines above them went away, not the lines they were reading.
    if (!this.follow) this.top = Math.max(0, this.top - lines)
    this.selection = null
  }

  /** Call after mutating a block in place (and bumping its version). */
  touch(): void {
    this.dirty = true
  }

  /**
   * Fold or unfold blocks: what that adds is not new lines for a reader scrolled away. Laid out before and
   * after the change, so lines that arrived before it still count, and ones that arrive after it do too.
   */
  refold(width: number, change: () => void): void {
    this.layout(width)
    change()
    this.dirty = true
    this.quiet = true
    this.layout(width)
  }

  /** All lines at this width. Cheap when nothing changed. */
  layout(width: number): Line[] {
    const theme = themeGeneration()
    if (!this.dirty && width === this.flatWidth && theme === this.flatTheme) return this.flat
    const before = this.flat.length
    const out: Line[] = []
    const spans: Array<{ block: Block; from: number; to: number }> = []
    for (const block of this.blocks) {
      let hit = this.cache.get(block.id)
      if (hit === undefined || hit.version !== block.version || hit.width !== width || hit.theme !== theme) {
        hit = { version: block.version, width, theme, lines: block.lines(width) }
        this.cache.set(block.id, hit)
      }
      const from = out.length
      for (const line of hit.lines) out.push(line)
      spans.push({ block, from, to: out.length })
    }
    this.spans = spans
    if (this.cache.size > this.blocks.length * 2) {
      const live = new Set(this.blocks.map((b) => b.id))
      for (const id of this.cache.keys()) if (!live.has(id)) this.cache.delete(id)
    }
    const grew = out.length - before
    this.flat = out
    this.flatWidth = width
    this.flatTheme = theme
    this.dirty = false
    if (!this.follow && grew > 0 && width === this.lastWidth && !this.quiet) this.unseen += grew
    this.quiet = false
    this.lastWidth = width
    return out
  }

  /** The visible slice for a viewport of `height` rows, adjusting `top` for follow mode. */
  visible(width: number, height: number): Line[] {
    const lines = this.layout(width)
    this.lastHeight = height
    const maxTop = Math.max(0, lines.length - height)
    if (this.follow) this.top = maxTop
    this.top = Math.max(0, Math.min(this.top, maxTop))
    // At the bottom again — the viewport grew, or what was hidden fits — is following again: nothing is unseen.
    if (this.top >= maxTop) { this.follow = true; this.unseen = 0 }
    return lines.slice(this.top, this.top + height)
  }

  /** Scroll by `delta` lines (negative is up). Reaching the bottom resumes following. */
  scroll(delta: number): void {
    const maxTop = Math.max(0, this.flat.length - this.lastHeight)
    this.top = Math.max(0, Math.min(maxTop, this.top + delta))
    this.follow = this.top >= maxTop
    if (this.follow) this.unseen = 0
  }

  toBottom(): void {
    this.follow = true
    this.unseen = 0
  }

  /** To the first line; following again only when everything fits. */
  toTop(): void {
    this.top = 0
    this.follow = this.flat.length <= this.lastHeight
    if (this.follow) this.unseen = 0
  }

  /**
   * Change a block in place (a fold turned over), keeping its first line on the row it is on: a long
   * result unfolded at the bottom shows its head, not its tail.
   */
  keepInPlace(block: Block, width: number, change: () => void): void {
    this.layout(width)
    const before = this.spans.find((s) => s.block === block)
    this.refold(width, change)
    const after = this.spans.find((s) => s.block === block)
    if (before === undefined || after === undefined) return
    // A head above the view comes to its second row (the first may hold a prompt), so what was folded is seen.
    const row = before.from >= this.top ? before.from - this.top : 1
    const maxTop = Math.max(0, this.flat.length - this.lastHeight)
    this.top = Math.max(0, Math.min(maxTop, after.from - row))
    this.follow = this.top >= maxTop
    if (this.follow) this.unseen = 0
  }

  /** The block a transcript line belongs to, or null. */
  blockAt(line: number): Block | null {
    let lo = 0
    let hi = this.spans.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const s = this.spans[mid]
      if (line < s.from) hi = mid - 1
      else if (line >= s.to) lo = mid + 1
      else return s.block
    }
    return null
  }

  /**
   * While scrolled up, the last prompt whose lines are all above the viewport: what the lines in view
   * answer. Null at the bottom, or when a prompt is itself in view at the top.
   */
  promptAbove(): string | null {
    if (this.follow) return null
    let found: string | null = null
    for (const s of this.spans) {
      if (s.from > this.top) break
      if (s.block.prompt !== undefined) found = s.to <= this.top ? s.block.prompt : null
    }
    return found
  }

  /** Viewport row → transcript line, or null below the content. */
  lineAt(row: number): number | null {
    const line = this.top + row
    return line >= 0 && line < this.flat.length ? line : null
  }

  beginSelection(at: Point): void {
    this.selection = { anchor: at, head: at }
  }

  extendSelection(at: Point): void {
    if (this.selection !== null) this.selection.head = at
  }

  /** The selected text, or '' when the selection is empty. */
  selectedText(): string {
    if (this.selection === null) return ''
    const { anchor, head } = this.selection
    if (anchor.line === head.line && anchor.col === head.col) return ''
    return extract(this.flat, anchor, head)
  }

  /** Whether the cell (line, col) is inside the selection, for highlighting. */
  isSelected(line: number, col: number): boolean {
    if (this.selection === null) return false
    const { anchor, head } = this.selection
    const [a, b] = anchor.line < head.line || (anchor.line === head.line && anchor.col <= head.col) ? [anchor, head] : [head, anchor]
    if (line < a.line || line > b.line) return false
    if (line === a.line && col < a.col) return false
    if (line === b.line && col >= b.col) return false
    return true
  }
}
