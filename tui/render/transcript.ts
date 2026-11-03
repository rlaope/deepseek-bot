/**
 * The scrollable conversation: blocks laid out once per width, a viewport over the result, and
 * a drag selection in the same coordinates.
 *
 * Layout is cached per block and invalidated by a version number, so a streamed answer re-wraps
 * only itself — the hundred messages above it cost nothing per token. The viewport follows the
 * bottom until the user scrolls away, and says how much arrived while they were reading.
 *
 * A new width (a resize) or palette is laid out lazily: the blocks in view and a screen around them
 * at once, every other one as an estimate of its lines (from its layout at the width before) until it
 * comes near the view, so a resize of a long session costs a screen, not the whole scrollback. A
 * block coming into view above the reader's place moves that place by what its estimate was off.
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

/** What stands for a line of a block not yet laid out at this width: never drawn, the view lays it out first. */
const PENDING: Line = Object.freeze({ spans: [], soft: false }) as Line

export interface Point { line: number; col: number }

export class Transcript {
  private blocks: Block[] = []
  private cache = new Map<string, Cached>()
  private flat: Line[] = []
  /** Where each block's lines are in `flat`, in order; `exact` false while they are an estimate. */
  private spans: Array<{ block: Block; from: number; to: number; exact: boolean }> = []
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
    const at = new Map(this.spans.map((s) => [s.block, s.to - s.from]))
    for (const block of this.blocks.splice(0, count)) {
      lines += at.get(block) ?? this.cache.get(block.id)?.lines.length ?? 0
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
    this.build(width)
    change()
    this.dirty = true
    this.quiet = true
    this.build(width)
  }

  /** All lines at this width, every block laid out. Cheap when nothing changed. */
  layout(width: number): Line[] {
    this.build(width)
    this.ensure(() => [0, Infinity])
    return this.flat
  }

  /** How many lines there are at this width, those of blocks not yet laid out at it estimated. */
  count(width: number): number {
    this.build(width)
    return this.flat.length
  }

  /**
   * The lines at this width: a block whose content changed (or is new) laid out, one only of another width or
   * palette estimated (`ensure` lays it out).
   */
  private build(width: number): void {
    const theme = themeGeneration()
    if (!this.dirty && width === this.flatWidth && theme === this.flatTheme) return
    const before = this.flat.length
    // Another width or palette: every block above may take another number of lines, so the reader's place and the
    // selection are kept on their blocks rather than on their line numbers.
    if (width !== this.flatWidth || theme !== this.flatTheme) this.reassemble(width, theme)
    else this.assemble(width, theme)
    const grew = this.flat.length - before
    this.dirty = false
    if (!this.follow && grew > 0 && width === this.lastWidth && !this.quiet) this.unseen += grew
    this.quiet = false
    this.lastWidth = width
  }

  /** `flat` and `spans` from the cache, what is new or changed laid out. */
  private assemble(width: number, theme: number): void {
    const out: Line[] = []
    const spans: Array<{ block: Block; from: number; to: number; exact: boolean }> = []
    for (const block of this.blocks) {
      let hit = this.cache.get(block.id)
      const exact = hit !== undefined && hit.version === block.version && hit.width === width && hit.theme === theme
      const from = out.length
      if (hit === undefined || hit.version !== block.version) {
        hit = { version: block.version, width, theme, lines: block.lines(width) }
        this.cache.set(block.id, hit)
      } else if (!exact) {
        // Laid out at another width: about as many lines as there it took, fewer on a wider pane.
        const guess = Math.max(1, Math.round((hit!.lines.length * hit!.width) / Math.max(1, width)))
        for (let k = 0; k < guess; k++) out.push(PENDING)
        spans.push({ block, from, to: out.length, exact: false })
        continue
      }
      for (const line of hit!.lines) out.push(line)
      spans.push({ block, from, to: out.length, exact: true })
    }
    this.spans = spans
    if (this.cache.size > this.blocks.length * 2) {
      const live = new Set(this.blocks.map((b) => b.id))
      for (const id of this.cache.keys()) if (!live.has(id)) this.cache.delete(id)
    }
    this.flat = out
    this.flatWidth = width
    this.flatTheme = theme
  }

  /**
   * Lay out the estimated blocks with a line in [from, to). One above the reader's place moves it by what its
   * estimate was off, so the lines in view stay. Returns whether any was laid out.
   */
  private ensure(range: () => [number, number]): boolean {
    const width = this.flatWidth
    const theme = this.flatTheme
    let any = false
    for (;;) {
      const [from, to] = range()
      const due = this.spans.filter((s) => !s.exact && s.to > from && s.from < to)
      if (due.length === 0) return any
      any = true
      for (const s of due) this.cache.set(s.block.id, { version: s.block.version, width, theme, lines: s.block.lines(width) })
      this.reassemble(width, theme)
    }
  }

  /**
   * `assemble`, with the reader's place (unless following) and the selection's ends kept where they were in their
   * blocks: a block's line count changing above them moves them with it, and within a block that changed they keep
   * their share of it.
   */
  private reassemble(width: number, theme: number): void {
    const top = this.follow ? null : this.mark(this.top)
    const ends = this.selection === null ? null : [this.mark(this.selection.anchor.line), this.mark(this.selection.head.line)]
    this.assemble(width, theme)
    if (top !== null) this.top = this.place(top, this.top)
    if (ends !== null && this.selection !== null) {
      this.selection.anchor = { ...this.selection.anchor, line: this.place(ends[0], this.selection.anchor.line) }
      this.selection.head = { ...this.selection.head, line: this.place(ends[1], this.selection.head.line) }
    }
  }

  /** A line as its block and where in it: what `place` finds again after the lines moved. */
  private mark(line: number): { block: Block; offset: number; size: number } | null {
    const block = this.blockAt(line)
    const s = block === null ? undefined : this.spans.find((x) => x.block === block)
    return s === undefined ? null : { block: s.block, offset: line - s.from, size: s.to - s.from }
  }

  private place(at: { block: Block; offset: number; size: number } | null, fallback: number): number {
    const s = at === null ? undefined : this.spans.find((x) => x.block === at.block)
    if (at === null || s === undefined) return fallback
    const size = s.to - s.from
    return s.from + Math.min(Math.max(0, size - 1), Math.floor((at.offset * size) / Math.max(1, at.size)))
  }

  /** The visible slice for a viewport of `height` rows, adjusting `top` for follow mode. */
  visible(width: number, height: number): Line[] {
    this.build(width)
    this.lastHeight = height
    const settle = () => {
      const maxTop = Math.max(0, this.flat.length - height)
      if (this.follow) this.top = maxTop
      this.top = Math.max(0, Math.min(this.top, maxTop))
    }
    settle()
    // The rows in view laid out, and a screen above and below them, so a scroll finds them ready.
    this.ensure(() => { settle(); return [this.top - height, this.top + 2 * height] })
    const maxTop = Math.max(0, this.flat.length - height)
    // At the bottom again — the viewport grew, or what was hidden fits — is following again: nothing is unseen.
    if (this.top >= maxTop) { this.follow = true; this.unseen = 0 }
    return this.flat.slice(this.top, this.top + height)
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
    this.build(width)
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
    // Laid out first: its ends move with their lines, so they are read again after.
    this.ensure(() => { const { anchor: a, head: h } = this.selection!; return [Math.min(a.line, h.line), Math.max(a.line, h.line) + 1] })
    return extract(this.flat, this.selection.anchor, this.selection.head)
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
