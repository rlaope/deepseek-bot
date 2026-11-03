/**
 * Test doubles for the TUI: a terminal that records what was written and can be driven with
 * input, a clock the test advances by hand, and a small VT emulator that replays the written
 * bytes into a grid so a test can read the screen the user would see.
 */
import { graphemes, graphemeWidth } from '../dist/tui/render/width.js'

/** `widthOf`: how wide this terminal draws a grapheme — one may draw an emoji made by VS16 narrower than we count. */
export function emulator(cols, rows, widthOf = graphemeWidth) {
  const grid: Array<{ ch: string; style: string; link?: string }> = Array.from({ length: cols * rows }, () => ({ ch: ' ', style: '' }))
  let x = 0, y = 0, pen = '', link = ''
  const state = { cursorVisible: true, cursor: { x: 0, y: 0 }, altScreen: false, mouse: false }
  function apply(data) {
    let i = 0
    while (i < data.length) {
      if (data[i] === '\x1b') {
        if (data[i + 1] === '[') {
          const m = /^\x1b\[([?\d;]*)([A-Za-z])/.exec(data.slice(i))
          if (m === null) throw new Error(`bad CSI at ${i}: ${JSON.stringify(data.slice(i, i + 12))}`)
          const [seq, params, final] = m
          if (final === 'H') { const [r, c] = params.split(';').map(Number); y = (r || 1) - 1; x = (c || 1) - 1 }
          else if (final === 'J' && params === '2') { for (const cell of grid) { cell.ch = ' '; cell.style = '' } }
          else if (final === 'm') pen = seq === '\x1b[0m' ? '' : seq
          else if (params === '?25' && final === 'l') state.cursorVisible = false
          else if (params === '?25' && final === 'h') { state.cursorVisible = true; state.cursor = { x, y } }
          else if (params === '?1049') state.altScreen = final === 'h'
          else if (params === '?1002') state.mouse = final === 'h'
          i += seq.length
          continue
        }
        if (data[i + 1] === ']') {
          const end = data.indexOf('\x07', i)
          const payload = data.slice(i + 2, end)
          // OSC 8: the hyperlink the following cells belong to ('' closes it).
          if (payload.startsWith('8;')) link = payload.slice(payload.indexOf(';', 2) + 1)
          i = end + 1
          continue
        }
        throw new Error(`unexpected ESC at ${i}`)
      }
      let end = data.indexOf('\x1b', i)
      if (end === -1) end = data.length
      for (const g of graphemes(data.slice(i, end))) {
        const w = widthOf(g)
        if (x < cols && y < rows) {
          grid[y * cols + x] = link === '' ? { ch: g, style: pen } : { ch: g, style: pen, link }
          if (w === 2 && x + 1 < cols) grid[y * cols + x + 1] = link === '' ? { ch: '', style: pen } : { ch: '', style: pen, link }
        }
        x += w
      }
      i = end
    }
  }
  /** One row as text (continuation cells skipped). */
  function row(r) {
    let s = ''
    for (let c = 0; c < cols; c++) s += grid[r * cols + c].ch
    return s
  }
  function text() {
    return Array.from({ length: rows }, (_, r) => row(r).replace(/ +$/, '')).join('\n')
  }
  /** Row and column of the first occurrence of `needle`, or null. */
  function find(needle) {
    for (let r = 0; r < rows; r++) {
      const line = row(r)
      const at = line.indexOf(needle)
      if (at !== -1) {
        let col = 0
        for (const g of graphemes(line.slice(0, at))) col += graphemeWidth(g)
        return { row: r, col }
      }
    }
    return null
  }
  return { grid, apply, row, text, find, state }
}

export function fakeClock() {
  let time = 1_000_000
  const timers = []
  return {
    now: () => time,
    setTimer: (fn, ms) => { const t = { at: time + ms, fn }; timers.push(t); return t },
    clearTimer: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1) },
    advance(ms) {
      const target = time + ms
      for (;;) {
        timers.sort((a, b) => a.at - b.at)
        if (timers.length === 0 || timers[0].at > target) break
        const t = timers.shift()
        time = Math.max(time, t.at)
        t.fn()
      }
      time = target
    },
  }
}

export function fakeTerminal(cols = 80, rows = 24) {
  const out = []
  const inputs = []
  const resizes = []
  let raw = false
  let screen = emulator(cols, rows)
  const io = {
    write: (d) => { out.push(d); screen.apply(d) },
    columns: () => cols,
    rows: () => rows,
    setRawMode: (on) => { raw = on },
    onInput: (fn) => { inputs.push(fn); return () => inputs.splice(inputs.indexOf(fn), 1) },
    onResize: (fn) => { resizes.push(fn); return () => resizes.splice(resizes.indexOf(fn), 1) },
  }
  return {
    io, out,
    get screen() { return screen },
    get raw() { return raw },
    type(data) { for (const fn of [...inputs]) fn(data) },
    resize(c, r) { cols = c; rows = r; screen = emulator(c, r); for (const fn of resizes) fn() },
  }
}
