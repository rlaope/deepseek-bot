/**
 * The TUI renderer, against a fake terminal.
 *
 * The claims worth pinning are the ones a screenshot cannot prove: that the bytes a diff writes
 * really turn the old frame into the new one (checked by replaying them through a small VT
 * emulator, over hundreds of random edits with Hangul in them), that a streamed answer costs a
 * few cells per frame instead of a repaint, that every frame is synchronized, that a drag copies
 * what the user saw, and that every way out puts the terminal back.
 *
 * Run: node test/tui-render.test.ts
 */
import './dist-fresh.ts'   // fails loudly on a stale dist

import { EventEmitter } from 'node:events'
import { fit, graphemes, graphemeWidth, stringWidth } from '../dist/tui/render/width.js'
import { Screen, diff, SYNC_BEGIN, SYNC_END } from '../dist/tui/render/screen.js'
import { InputParser } from '../dist/tui/render/input.js'
import { Terminal, ENTER, RESTORE, restoreOnExit } from '../dist/tui/render/terminal.js'
import { wrapPlain, layout, extract } from '../dist/tui/render/text.js'
import { Transcript } from '../dist/tui/render/transcript.js'
import { Editor } from '../dist/tui/render/editor.js'
import { banner, BANNER_WIDTHS } from '../dist/tui/render/banner.js'
import { welcomeBlock } from '../dist/tui/blocks.js'
import { copy, osc52 } from '../dist/tui/render/clipboard.js'
import { emulator, fakeTerminal, fakeClock } from './tui-fakes.ts'
import { sgr, detectColorMode, rgbTo256, backgroundOf, useBackground, themeGeneration, theme, palette } from '../dist/tui/render/style.js'
import { markdown } from '../dist/tui/render/markdown.js'
import { lineDiff } from '../dist/tui/render/linediff.js'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function sameScreen(emu, screen) {
  for (let i = 0; i < screen.cells.length; i++) {
    const a = emu.grid[i], b = screen.cells[i]
    if (a.ch !== b.ch || (a.ch !== ' ' && a.style !== b.style) || (a.ch === ' ' && a.style !== b.style)) {
      return `cell ${i % screen.cols},${Math.floor(i / screen.cols)}: emulator ${JSON.stringify(a)} vs frame ${JSON.stringify(b)}`
    }
  }
  return null
}

// Deterministic randomness, so a failure reproduces.
let seed = 0x5eed
const rand = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n }
const ALPHABET = ['a', 'b', 'Z', ' ', '.', '가', '한', '글', '👍', '│', '█', '›']
const STYLES = ['', sgr({ bold: true }, 'truecolor'), sgr({ fg: [46, 123, 255] }, 'truecolor'), sgr({ inverse: true }, 'truecolor')]
const randomText = (n) => Array.from({ length: n }, () => ALPHABET[rand(ALPHABET.length)]).join('')

// 1. Width.
{
  check('width: Hangul syllable is 2 columns', graphemeWidth('가') === 2)
  check('width: ASCII is 1', stringWidth('abc') === 3)
  check('width: mixed Hangul and ASCII', stringWidth('한글abc') === 7)
  check('width: emoji is 2', stringWidth('👍') === 2)
  check('width: base + combining mark is 1', stringWidth('é') === 1)
  check('width: VS16 emoji presentation is 2', stringWidth('❤️') === 2)
  check('width: control characters are 0', stringWidth('\x07') === 0)
}

// 2. Diff correctness: replay the bytes through the emulator, over random edits.
{
  const cols = 40, rows = 10
  const emu = emulator(cols, rows)
  let prev = null
  let failure = null
  let frames = 0
  for (let round = 0; round < 300 && failure === null; round++) {
    const next = new Screen(cols, rows)
    if (prev !== null) next.cells.splice(0, next.cells.length, ...prev.cells)
    const edits = 1 + rand(4)
    for (let e = 0; e < edits; e++) {
      if (rand(5) === 0) next.fill(rand(cols), rand(rows), rand(12), STYLES[rand(STYLES.length)])
      else next.put(rand(cols), rand(rows), randomText(1 + rand(10)), STYLES[rand(STYLES.length)])
    }
    const bytes = diff(prev, next)
    if (!bytes.startsWith(SYNC_BEGIN) || !bytes.endsWith(SYNC_END)) failure = `frame ${round} not synchronized`
    emu.apply(bytes)
    failure = failure ?? sameScreen(emu, next)
    prev = next
    frames++
  }
  check('diff: 300 random frames with Hangul and emoji replay to the intended screen', failure === null, failure ?? `${frames} frames`)
}

// 3. Diff writes little for a small change, and never clears the screen to do it.
{
  const a = new Screen(80, 24)
  a.put(0, 5, '어제 #dev 스레드 기준으로 정리하면')
  const b = new Screen(80, 24)
  b.cells.splice(0, b.cells.length, ...a.cells)
  b.put(stringWidth('어제 #dev 스레드 기준으로 정리하면'), 5, ' 다음')
  const bytes = diff(a, b)
  check('diff: appending a word writes only that word', bytes.length < 60 && !bytes.includes('\x1b[2J'), `${bytes.length} bytes`)
  check('diff: an unchanged frame writes only the sync wrapper', diff(a, a).replace(SYNC_BEGIN, '').replace(SYNC_END, '') === '\x1b[?25l')
}

// 4. Input parsing.
{
  const p = new InputParser()
  const ev = (s) => p.feed(s)
  const k = (e) => e.map((x) => x.type === 'key' ? `${x.ctrl ? 'C-' : ''}${x.alt ? 'M-' : ''}${x.shift ? 'S-' : ''}${x.name === 'char' ? x.ch : x.name}` : x.type === 'paste' ? `paste:${x.text}` : `${x.action}:${x.button}@${x.x},${x.y}`).join(' ')
  check('input: arrows and ctrl', k(ev('\x1b[A\x1b[1;5D\x03')) === 'up C-left C-c', k(ev('\x1b[A\x1b[1;5D\x03')))
  check('input: Hangul text arrives as characters', k(ev('안녕')) === '안 녕')
  check('input: Alt+Enter is a newline request', k(ev('\x1b\r')) === 'M-enter')
  check('input: CSI u Shift+Enter', k(ev('\x1b[13;2u')) === 'S-enter')
  check('input: SGR mouse down, drag, up, wheel', k(ev('\x1b[<0;10;5M\x1b[<32;12;5M\x1b[<0;12;5m\x1b[<65;3;3M')) === 'down:0@9,4 drag:0@11,4 up:0@11,4 wheel:1@2,2')
  check('input: bracketed paste keeps newlines and is one event', k(ev('\x1b[200~line1\nline2\x1b[201~')) === 'paste:line1\nline2')
  const q = new InputParser()
  const split1 = q.feed('\x1b[200~par')
  const split2 = q.feed('t\x1b[20')
  const split3 = q.feed('1~x')
  check('input: a paste split across chunks', split1.length === 0 && split2.length === 0 && k(split3) === 'paste:part x', k(split3))
  const r = new InputParser()
  check('input: a sequence split across chunks', r.feed('\x1b[').length === 0 && k(r.feed('B')) === 'down')
  const s = new InputParser()
  check('input: lone ESC waits, then flushes as escape', s.feed('\x1b').length === 0 && s.pending && k(s.flush()) === 'escape')
}

// 5. Wrapping and extraction.
{
  check('wrap: at spaces', JSON.stringify(wrapPlain('the quick brown fox', 10)) === JSON.stringify(['the quick', 'brown fox']), JSON.stringify(wrapPlain('the quick brown fox', 10)))
  // '어제 슬랙에서' is 13 columns (2+2+1+8), so 13 is the narrowest width that keeps it on one line.
  check('wrap: Korean words at spaces', JSON.stringify(wrapPlain('어제 슬랙에서 얘기한 배포 일정', 13)) === JSON.stringify(['어제 슬랙에서', '얘기한 배포', '일정']), JSON.stringify(wrapPlain('어제 슬랙에서 얘기한 배포 일정', 13)))
  check('wrap: one column narrower moves the second word down', JSON.stringify(wrapPlain('어제 슬랙에서 얘기한 배포 일정', 12)) === JSON.stringify(['어제', '슬랙에서', '얘기한 배포', '일정']))
  check('wrap: a long word breaks where it overflows', JSON.stringify(wrapPlain('abcdefghij', 4)) === JSON.stringify(['abcd', 'efgh', 'ij']))
  check('wrap: a wide character is never split across a 1-column remainder', wrapPlain('가나다', 5).every((l) => stringWidth(l) <= 5) && wrapPlain('가나다', 5).join('') === '가나다')
  const lines = layout('첫 줄은 꽤 길어서 접힌다\n둘째', 14, '', { first: { text: '› ', style: '' }, rest: { text: '  ', style: '' } })
  const all = extract(lines, { line: 0, col: 0 }, { line: lines.length - 1, col: 99 })
  check('extract: a copy reproduces the source — soft wraps rejoined with their space, hard breaks kept, prefixes left out', lines.length > 2 && all === '첫 줄은 꽤 길어서 접힌다\n둘째', JSON.stringify(all))
  const one = layout('가나다라', 20, '', { first: { text: '› ', style: '' }, rest: { text: '  ', style: '' } })
  // '› ' is 2 columns; '나' starts at column 4 and covers 4–5. A drag starting at column 5 still copies it.
  check('extract: starting inside a wide character includes it', extract(one, { line: 0, col: 5 }, { line: 0, col: 8 }) === '나다', JSON.stringify(extract(one, { line: 0, col: 5 }, { line: 0, col: 8 })))
}

// 6. Transcript: follow, scroll away, unseen count, selection.
{
  const t = new Transcript()
  const blocks = []
  const add = (id, text) => {
    const block = { id, version: 0, text, lines(w) { return layout(this.text, w, '', { first: { text: '› ', style: '' }, rest: { text: '  ', style: '' } }) } }
    blocks.push(block); t.push(block); return block
  }
  for (let i = 0; i < 30; i++) add(`m${i}`, `message ${i}`)
  const v1 = t.visible(40, 10)
  check('transcript: follows the bottom', v1[9].spans[1].text === 'message 29')
  t.scroll(-5)
  check('transcript: scrolling up stops following', !t.follow && t.visible(40, 10)[9].spans[1].text === 'message 24')
  add('m30', 'message 30'); add('m31', 'message 31')
  t.visible(40, 10)
  check('transcript: lines arriving while scrolled away are counted', t.unseen === 2, `unseen ${t.unseen}`)
  t.toBottom()
  check('transcript: back to the bottom resumes following', t.visible(40, 10)[9].spans[1].text === 'message 31' && t.unseen === 0)
  // Scrolled up, then given room for all of it (the input box gave its rows to a choice): at the bottom again,
  // so a line arriving now is in view, not counted as unseen.
  t.scroll(-3)
  t.visible(40, 40)
  add('m32', 'message 32')
  t.visible(40, 40)
  check('transcript: given room for every line, it follows again and counts nothing unseen', t.follow && t.unseen === 0, `follow ${t.follow} unseen ${t.unseen}`)
  const last = blocks[blocks.length - 1]
  let calls = 0
  const original = blocks[0].lines
  blocks[0].lines = function (w) { calls++; return original.call(this, w) }
  last.text = 'message 31 grew'; last.version++; t.touch()
  t.visible(40, 10)
  check('transcript: a changed block re-wraps alone', calls === 0)
  t.beginSelection({ line: 30, col: 2 }); t.extendSelection({ line: 31, col: 9 })
  check('transcript: selection spans messages', t.selectedText() === 'message 30\nmessage', JSON.stringify(t.selectedText()))
}

// 7. Editor.
{
  const e = new Editor()
  e.insert('안녕하세요')
  e.backspace()
  check('editor: backspace removes one syllable', e.text === '안녕하세')
  e.left(); e.left(); e.insert('x')
  check('editor: cursor moves by grapheme', e.text === '안녕x하세' && e.cursor === 3)
  const wrap = new Editor()
  wrap.insert('가나다라마')   // 10 columns into a 5-column box: 가나 | 다라 | 마
  const l = wrap.layout(5)
  check('editor: wide characters wrap whole', JSON.stringify(l.rows) === JSON.stringify(['가나', '다라', '마']), JSON.stringify(l.rows))
  check('editor: cursor after the last character', l.cursor.x === 2 && l.cursor.y === 2, JSON.stringify(l.cursor))
  wrap.up(5)
  // Row 1 is '다라': its positions are before 다 (x 0) and before 라 (x 2); x 4 does not exist because 마 wrapped.
  check('editor: up moves a visual row to the nearest column', wrap.layout(5).cursor.y === 1 && wrap.cursor === 3, JSON.stringify({ c: wrap.layout(5).cursor, i: wrap.cursor }))
  const h = new Editor()
  h.insert('first'); h.submit(); h.insert('second'); h.submit(); h.insert('draft')
  h.up(40)
  check('editor: up on the first row recalls history', h.text === 'second')
  h.up(40); h.down(40); h.down(40)
  check('editor: down past history restores the draft', h.text === 'draft')
}

// 8. Terminal lifecycle, frame coalescing, restore, and the streaming budget.
{
  const f = fakeTerminal()
  const clock = fakeClock()
  let renders = 0
  const term = new Terminal({ io: f.io, render: (s) => { renders++; s.put(0, 0, 'hi') }, onEvent: () => {}, ...clock })
  term.start()
  check('terminal: start enters fullscreen with mouse and paste, in raw mode', f.out[0] === ENTER && f.raw)
  term.requestRender(); term.requestRender(); term.requestRender()
  clock.advance(20)
  check('terminal: three requests inside one frame draw one frame', renders === 2, `renders ${renders}`)
  term.requestRender(true)
  check('terminal: an urgent request draws immediately', renders === 3)
  f.resize(100, 30)
  check('terminal: a resize repaints the whole screen', term.stats.fullRepaints === 2 && f.out[f.out.length - 1].includes('\x1b[2J'))
  term.restore(); term.restore()
  check('terminal: restore writes the reset once and leaves raw mode', f.out.filter((d) => d === RESTORE).length === 1 && !f.raw)
  check('terminal: every frame is synchronized', f.out.filter((d) => d !== ENTER && d !== RESTORE).every((d) => d.startsWith(SYNC_BEGIN) && d.endsWith(SYNC_END)))
}

{
  // Streaming 1,000 chunks into an answer: frames are coalesced, nothing repaints, and the
  // bytes per frame stay proportional to what changed.
  const f = fakeTerminal(100, 30)
  const clock = fakeClock()
  const t = new Transcript()
  const answer = { id: 'a', version: 0, text: '', lines(w) { return layout(this.text, w, '', { first: { text: '  ', style: '' }, rest: { text: '  ', style: '' } }) } }
  t.push({ id: 'q', version: 0, lines: (w) => layout('질문', w, '', { first: { text: '› ', style: '' }, rest: { text: '  ', style: '' } }) })
  t.push(answer)
  const term = new Terminal({
    io: f.io,
    render: (s) => { t.visible(s.cols, s.rows).forEach((line, y) => { let x = 0; for (const span of line.spans) x = s.put(x, y, span.text, span.style) }) },
    onEvent: () => {},
    ...clock,
  })
  term.start()
  const before = { ...term.stats }
  const words = ['배포', '일정은', 'staging', '먼저,', '그다음', 'production.']
  for (let i = 0; i < 1000; i++) {
    answer.text += (i === 0 ? '' : ' ') + words[i % words.length]
    answer.version++; t.touch()
    term.requestRender()
    clock.advance(2)   // 1,000 chunks over 2 seconds: 500 chunks per second
  }
  clock.advance(50)
  const frames = term.stats.frames - before.frames
  const bytes = term.stats.bytes - before.bytes
  check('stream: 1,000 chunks at 500/s are coalesced to about 60 frames per second', frames >= 100 && frames <= 130, `${frames} frames`)
  check('stream: no full repaint while streaming', term.stats.fullRepaints === before.fullRepaints, `${term.stats.fullRepaints - before.fullRepaints} repaints`)
  // A full 100×30 repaint of this content is several kilobytes; a frame here adds a few words.
  check('stream: bytes per frame stay small', bytes / frames < 400, `${Math.round(bytes / frames)} bytes/frame`)
  term.restore()
}

{
  const f = fakeTerminal()
  const term = new Terminal({ io: f.io, render: () => {}, onEvent: () => {}, ...fakeClock() })
  term.start()
  const proc: EventEmitter & { stderr?: { write: () => void }; exit?: (code: number) => void } = new EventEmitter()
  proc.stderr = { write: () => {} }
  let code = null
  proc.exit = (c) => { code = c }
  const off = restoreOnExit(term, proc)
  proc.emit('uncaughtException', new Error('boom'))
  check('restore: an uncaught exception restores the terminal and exits 1', f.out.includes(RESTORE) && code === 1)
  off()
  check('restore: the hooks can be removed', proc.listenerCount('uncaughtException') === 0)
}

// 9. The banner, colour, clipboard.
{
  const rowText = (l) => l.spans.map((sp) => sp.text).join('')
  check('banner: one line needs 93 columns, two lines 68', BANNER_WIDTHS.one === 93 && BANNER_WIDTHS.two === 68, JSON.stringify(BANNER_WIDTHS))
  check('banner: it says DEEPSEEK BOT', rowText(banner(140, 'none')[0]) === '  ██████╗ ███████╗███████╗██████╗ ███████╗███████╗███████╗██╗  ██╗   ██████╗  ██████╗ ████████╗', rowText(banner(140, 'none')[0]))
  check('banner: on two lines, BOT sits below the end of DEEPSEEK', rowText(banner(80, 'none')[6]) === `${' '.repeat(2 + 42)}██████╗  ██████╗ ████████╗`, JSON.stringify(rowText(banner(80, 'none')[6])))
  check('banner: the narrow wordmark says deepseek-bot', rowText(banner(60, 'none')[0]) === '  ◆ deepseek-bot', rowText(banner(60, 'none')[0]))
  check('banner: 80 columns get the two-line mark, 140 the one-line, 60 the wordmark', banner(80, 'truecolor').length === 12 && banner(140, 'truecolor').length === 6 && banner(60, 'truecolor').length === 1)
  check('banner: no colour codes under NO_COLOR', banner(80, 'none').every((l) => l.spans.every((s) => s.style === '')))
  const top = banner(80, 'truecolor')[0].spans[1].style, bottom = banner(80, 'truecolor')[11].spans[1].style
  check('banner: a gradient from light to deep blue', top.includes('38;2;91;155;255') && bottom.includes('38;2;11;63;168'), `${JSON.stringify(top)} → ${JSON.stringify(bottom)}`)
  // The welcome block's letters, at the widths the docs give: none under 70, two lines from 70, one from 95.
  const welcome = (width, room = 100) => welcomeBlock(() => ({ version: '0.2.0', model: 'm', workspace: '~/w', session: 's', room }), 'none').lines(width).map(rowText)
  // A row of the letters has a block or a double line in it; the box's lines are single.
  const lettered = (rows) => rows.filter((r) => /[█╗╝║═]/.test(r)).length
  check('welcome: letters by width — 69 none, 70 and 94 two lines, 95 one line', lettered(welcome(69)) === 0 && lettered(welcome(70)) === 12 && lettered(welcome(94)) === 12 && lettered(welcome(95)) === 6,
    [69, 70, 94, 95].map((w) => lettered(welcome(w))).join(' '))
  const one = welcome(95)
  check('welcome: under one line of letters the box is as wide as they are', one.find((r) => r.includes('╭'))?.trimEnd().length === one.find((r) => r.includes('████████╗'))?.trimEnd().length, `${one.find((r) => r.includes('╭'))?.trimEnd().length} ${one.find((r) => r.includes('████████╗'))?.trimEnd().length}`)
  check('welcome: letters only when they and the box fit the rows: 15 for one line, 21 for two', lettered(welcome(95, 15)) === 6 && lettered(welcome(95, 14)) === 0 && lettered(welcome(80, 21)) === 12 && lettered(welcome(80, 20)) === 0,
    [lettered(welcome(95, 15)), lettered(welcome(95, 14)), lettered(welcome(80, 21)), lettered(welcome(80, 20))].join(' '))
  check('fit: text that fits is left alone; longer text is cut with …', fit('deepseek', 10) === 'deepseek' && fit('deepseek-bot', 8) === 'deepsee…' && stringWidth(fit('한국어 텍스트', 6)) <= 6, fit('한국어 텍스트', 6))
  check('colour: NO_COLOR wins, COLORTERM=truecolor is 24-bit, otherwise 256', detectColorMode({ NO_COLOR: '1', COLORTERM: 'truecolor' }) === 'none' && detectColorMode({ COLORTERM: 'truecolor' }) === 'truecolor' && detectColorMode({}) === '256')
  check('colour: the logo blue maps into the 256 cube', rgbTo256([0x2e, 0x7b, 0xff]) === 33, String(rgbTo256([0x2e, 0x7b, 0xff])))

  const written = []
  let ran = null
  const local = copy('복사된 텍스트', { env: {}, platform: 'darwin', write: (d) => written.push(d), run: (cmd, input) => { ran = { cmd, input }; return true } })
  check('clipboard: local macOS uses pbcopy', local === 'pbcopy' && ran.cmd === 'pbcopy' && ran.input === '복사된 텍스트' && written.length === 0)
  const remote = copy('복사된 텍스트', { env: { SSH_TTY: '/dev/ttys001' }, platform: 'darwin', write: (d) => written.push(d), run: () => { throw new Error('must not run pbcopy over ssh') } })
  check('clipboard: over SSH, OSC 52 with UTF-8 base64', remote === 'osc52' && written[0] === osc52('복사된 텍스트') && Buffer.from(written[0].slice(7, -1), 'base64').toString('utf8') === '복사된 텍스트')
  const fallback = copy('x', { env: {}, platform: 'darwin', write: (d) => written.push(d), run: () => false })
  check('clipboard: pbcopy failing falls back to OSC 52', fallback === 'osc52')
}

// 10. Markdown for answers.
{
  const st = { text: 'T', bold: 'B', italic: 'I', code: 'C', heading: 'H', quote: 'Q', codeBlock: 'K', dim: 'D', link: 'L' }
  const md = (text, width = 60) => markdown(text, width, st, { text: '  ', style: '' })
  const plain = (line) => line.spans.filter((sp) => !sp.decor).map((sp) => sp.text).join('')
  const styled = (line, style) => line.spans.filter((sp) => sp.style === style && !sp.decor).map((sp) => sp.text).join('|')

  const inline = md('배포는 **staging** 먼저, `npm test` 통과 후 [문서](https://ex.am/ple) :warning: *허용*', 200)
  check('markdown: markers are not drawn', plain(inline[0]) === '배포는 staging 먼저, npm test 통과 후 문서 (https://ex.am/ple) ⚠ 허용', plain(inline[0]))
  check('markdown: bold, code, link and Slack *bold* get their styles', styled(inline[0], 'B') === 'staging|허용' && styled(inline[0], 'C') === 'npm test' && styled(inline[0], 'L') === '문서')
  const wrapped = md('배포는 **staging** 먼저, `npm test` 통과 후 [문서](https://ex.am/ple) :warning: *허용*', 30)
  check('markdown: wrapped, the styled text still reads the same when copied', wrapped.length > 1 && extract(wrapped, { line: 0, col: 0 }, { line: wrapped.length - 1, col: 99 }) === '배포는 staging 먼저, npm test 통과 후 문서 (https://ex.am/ple) ⚠ 허용', JSON.stringify(extract(wrapped, { line: 0, col: 0 }, { line: wrapped.length - 1, col: 99 })))
  const ident = md('snake_case_name 와 2*3*4 그리고 _강조_')
  check('markdown: underscores and asterisks inside words stay as written', plain(ident[0]) === 'snake_case_name 와 2*3*4 그리고 강조' && styled(ident[0], 'I') === '강조', plain(ident[0]))
  check('markdown: an unknown :shortcode: stays text', plain(md('비율은 3:4:5 이고 :notacode: 그대로')[0]) === '비율은 3:4:5 이고 :notacode: 그대로')

  const blocks = md(['# 계획', '', '- 첫째', '  - 둘째', '1. 하나', '> 인용문', '---', '```bash', 'echo "a  b"', '```'].join('\n'))
  const decor = (line) => line.spans.filter((sp) => sp.decor).map((sp) => sp.text).join('')
  check('markdown: a heading is styled, without its #', plain(blocks[0]) === '계획' && styled(blocks[0], 'H') === '계획')
  check('markdown: bullets and numbers become marks', decor(blocks[2]) === '  • ' && decor(blocks[3]) === '    • ' && decor(blocks[4]) === '  1. ')
  check('markdown: a quote gets a bar', decor(blocks[5]) === '  │ ' && styled(blocks[5], 'Q') === '인용문')
  check('markdown: a rule is a line', /^─+$/.test(blocks[6].spans.map((sp) => sp.text).join('').trim()))
  check('markdown: a code block shows its language and keeps its spacing', plain(blocks[7]) === '' && blocks[7].spans.some((sp) => sp.text === 'bash') && plain(blocks[8]) === 'echo "a  b"' && decor(blocks[8]) === '  │ ')

  const code = md(['```', 'const value = someFunction(argumentOne, argumentTwo)', '```'].join('\n'), 24)
  const words = md('the quick brown fox jumps over the lazy dog', 24)
  check('markdown: code wraps where it overflows, prose at its spaces', code.length > 1 && plain(code[0]).length === 20 && words.every((l) => !plain(l).startsWith(' ') && !plain(l).endsWith(' ')), JSON.stringify(code.map(plain)))
  const copied = extract(words, { line: 0, col: 0 }, { line: words.length - 1, col: 99 })
  check('markdown: a copy across wrapped prose is the sentence as written', copied === 'the quick brown fox jumps over the lazy dog', JSON.stringify(copied))
  const copiedCode = extract(code, { line: 0, col: 0 }, { line: code.length - 1, col: 99 })
  check('markdown: a copy of wrapped code is the line as written, without the bar', copiedCode === 'const value = someFunction(argumentOne, argumentTwo)', JSON.stringify(copiedCode))
  check('markdown: no leading or trailing blank lines', md('\n\n본문\n\n').length === 1)
}

// 12. A line diff, for an edit's card.
{
  const ops = (a, b) => (lineDiff(a, b) ?? []).map((d) => `${d.op}${d.text}`).join('|')
  check('linediff: a changed line is a removal and an addition, the rest kept', ops(['a', 'b', 'c'], ['a', 'x', 'c']) === ' a|-b|+x| c', ops(['a', 'b', 'c'], ['a', 'x', 'c']))
  check('linediff: a new file is all additions', ops([], ['x', 'y']) === '+x|+y')
  check('linediff: an insertion keeps both neighbours', ops(['a', 'c'], ['a', 'b', 'c']) === ' a|+b| c')
  const big = Array.from({ length: 2000 }, (_, i) => `l${i}`)
  check('linediff: inputs too large to compare are not compared, and it says so', lineDiff(big, big.map((l) => `${l}!`)) === null && lineDiff(['a'], ['b']) !== null)
}

// 11. Links that can be clicked, tables, and highlighted code.
{
  const st = { text: 'T', bold: 'B', italic: 'I', code: 'C', heading: 'H', quote: 'Q', codeBlock: 'K', dim: 'D', link: 'L',
    keyword: 'KW', string: 'ST', comment: 'CM', number: 'NU' }
  const md = (text, width = 60) => markdown(text, width, st, { text: '  ', style: '' })
  const styled = (line, style) => line.spans.filter((sp) => sp.style === style && !sp.decor).map((sp) => sp.text).join('|')
  const drawn = (line) => line.spans.map((sp) => sp.text).join('')

  // Links: OSC 8 on the label and on a bare URL; only http(s) and mailto; nothing with a control character.
  const linked = md('[문서](https://ex.am/ple) 와 https://raw.example/path?q=1. 그리고 [위험](javascript:alert)', 200)
  const links = linked[0].spans.filter((sp) => sp.link !== undefined).map((sp) => `${sp.text}→${sp.link}`)
  check('markdown: a link and a bare URL carry their target, without the sentence\'s full stop', links.includes('문서→https://ex.am/ple') && links.includes('https://raw.example/path?q=1→https://raw.example/path?q=1'), JSON.stringify(links))
  check('markdown: a link to anything but http(s) or mailto is text only', !linked[0].spans.some((sp) => /javascript/.test(sp.link ?? '')) && drawn(linked[0]).includes('위험'))
  check('markdown: a URL with a control character is no link', !md('[x](https://a.b/\x1b[2Jc)')[0].spans.some((sp) => sp.link !== undefined))
  // Found in review: C1 controls (U+0080-9F) are escapes to some terminals, and a huge URL is rewritten per row.
  check('markdown: a URL with a C1 control or anything outside printable ASCII is no link', !md('[x](https://a/\u009c\u009d52;c;x\u009c)')[0].spans.some((sp) => sp.link !== undefined) && !md('[x](https://a/한글)')[0].spans.some((sp) => sp.link !== undefined))
  check('markdown: a URL too long to be one is no link', !md(`[x](https://a/${'p'.repeat(3000)})`, 200)[0].spans.some((sp) => sp.link !== undefined))
  const wiki = md('문서 https://en.wikipedia.org/wiki/Foo_(bar) 와 (참고 https://ex.am/ple)', 200)[0].spans.filter((sp) => sp.link !== undefined).map((sp) => sp.link)
  check('markdown: a bare URL keeps its own parentheses and leaves the sentence\'s', JSON.stringify(wiki) === JSON.stringify(['https://en.wikipedia.org/wiki/Foo_(bar)', 'https://ex.am/ple']), JSON.stringify(wiki))
  // Hostile input must not stall the layout, which runs on every streamed frame.
  const timed = (text) => { const at = Date.now(); md(text, 80); return Date.now() - at }
  const spaces = timed(`ls | wc\n${' '.repeat(80_000)}x`)
  check('markdown: a line of spaces under a row with a pipe is laid out quickly', spaces < 1500, `${spaces}ms`)
  const brackets = timed('['.repeat(80_000))
  check('markdown: a run of brackets is laid out quickly', brackets < 1500, `${brackets}ms`)
  const closers = timed(`https://a${')'.repeat(40_000)}`)
  check('markdown: a URL followed by a run of closing brackets is laid out quickly', closers < 1500, `${closers}ms`)
  const korean = md('https://x.com에서 확인, 그리고 (https://a.b/c)(https://d.e/f)', 200)[0].spans.filter((sp) => sp.link !== undefined).map((sp) => sp.link)
  check('markdown: a bare URL ends where printable ASCII ends, and two in brackets are two', JSON.stringify(korean) === JSON.stringify(['https://x.com', 'https://a.b/c', 'https://d.e/f']), JSON.stringify(korean))
  // A link to the wrong page is worse than none: a path that goes on in Korean is not linked by
  // its ASCII part, and a URL's own bracket pairs are not taken for the start of another URL.
  const wrong = md('https://namu.wiki/w/대한민국 그리고 https://a/(x)(y) 끝', 200)[0].spans.filter((sp) => sp.link !== undefined).map((sp) => sp.link)
  check('markdown: a path continuing outside ASCII is not linked short, and (x)(y) stays one URL', JSON.stringify(wrong) === JSON.stringify(['https://a/(x)(y)']), JSON.stringify(wrong))
  const paths = md('https://namu.wiki/w/LG전자 와 https://example.com/docs/를 참고, https://x.com에서', 200)[0].spans.filter((sp) => sp.link !== undefined).map((sp) => sp.link)
  check('markdown: only a bare host may run into Korean and still be a link', JSON.stringify(paths) === JSON.stringify(['https://x.com']), JSON.stringify(paths))
  const punctuated = md('문서는 https://example.com/docs。 그리고 “https://example.com/a/b” 참고', 200)[0].spans.filter((sp) => sp.link !== undefined).map((sp) => sp.link)
  check('markdown: a path followed by punctuation of another script is still a link', JSON.stringify(punctuated) === JSON.stringify(['https://example.com/docs', 'https://example.com/a/b']), JSON.stringify(punctuated))
  // Found in review: only closing punctuation ends a URL. A dash, a middle dot or an ellipsis may be
  // part of the path, so a path followed by one is not linked short to the wrong page.
  const inner = md('https://en.wikipedia.org/wiki/Navier–Stokes_equations 와 https://namu.wiki/w/BTS·블랙핑크 와 https://a.b/c…', 200)[0].spans.filter((sp) => sp.link !== undefined).map((sp) => sp.link)
  check('markdown: a dash, a middle dot or an ellipsis after a path does not end it into a wrong link', JSON.stringify(inner) === JSON.stringify([]), JSON.stringify(inner))
  const overlong = md(`https://${'a'.repeat(2000)}.${'b'.repeat(40)} 끝`, 200)[0].spans.filter((sp) => sp.link !== undefined)
  check('markdown: a URL longer than the bound is not linked to its first part', overlong.length === 0, `${overlong.length} link(s), ${overlong[0]?.link?.length ?? 0} chars`)
  const repeated = timed('(https://a.b/c)'.repeat(40_000))
  check('markdown: many bracketed URLs in a row are laid out quickly', repeated < 1500, `${repeated}ms`)

  const screen = new Screen(30, 2)
  screen.put(0, 0, '문서', 'L', 30, 'https://ex.am/ple')
  screen.put(5, 0, 'plain')
  const bytes = diff(null, screen)
  check('screen: a link is opened before its text and closed after it', bytes.includes('\x1b]8;;https://ex.am/ple\x07L문서\x1b]8;;\x07'), JSON.stringify(bytes))
  const term = emulator(30, 2)
  term.apply(bytes)
  check('screen: the terminal sees the label linked and the rest not', term.grid[0].link === 'https://ex.am/ple' && term.grid[2].link === 'https://ex.am/ple' && term.grid[5].link === undefined)
  const unlinked = new Screen(30, 2)
  unlinked.put(0, 0, '문서', 'L')
  check('screen: a link added to unchanged text is redrawn', diff(unlinked, screen).includes('\x1b]8;;https://ex.am/ple\x07'))

  // Tables: borders, aligned columns by display width, header in bold; wider than the screen, left as written.
  const table = md(['| 이름 | 수량 | 비고 |', '|:---|---:|:-:|', '| 사과 | 3 | **신선** |', '| 배 | 12 |'].join('\n'), 60)
  const rows = table.map(drawn)
  check('markdown: a table is drawn with borders and aligned columns', JSON.stringify(rows) === JSON.stringify([
    '  ┌──────┬──────┬──────┐', '  │ 이름 │ 수량 │ 비고 │', '  ├──────┼──────┼──────┤', '  │ 사과 │    3 │ 신선 │', '  │ 배   │   12 │      │', '  └──────┴──────┴──────┘',
  ]), JSON.stringify(rows))
  check('markdown: the header and bold cells are bold', styled(table[1], 'B') === '이름|수량|비고' && styled(table[3], 'B') === '신선')
  const wide = md(['| a | b |', '|---|---|', `| ${'긴'.repeat(40)} | x |`].join('\n'), 30)
  check('markdown: a table wider than the screen is left as written', wide.some((l) => drawn(l).includes('| a | b |')) && !wide.some((l) => drawn(l).includes('┌')))
  check('markdown: pipes without a separator row are not a table', !md('a | b\nc | d').some((l) => drawn(l).includes('┌')))

  // Code: keywords, numbers, comments and strings by language; unknown languages plain; copy unchanged.
  const ts = md(['```ts', 'const n = 42 // 답', "if (ok) return 'yes'", '```'].join('\n'))
  check('markdown: TypeScript is highlighted: keyword, number, comment, string', styled(ts[1], 'KW') === 'const' && styled(ts[1], 'NU') === '42' && styled(ts[1], 'CM') === '// 답' && styled(ts[2], 'KW') === 'if|return' && styled(ts[2], 'ST') === "'yes'",
    JSON.stringify(ts.slice(1).map((l) => l.spans.filter((sp) => !sp.decor))))
  const py = md(['```python', 'def f(x):  # 주석', '    return "a#b"', '```'].join('\n'))
  check('markdown: Python comments start at #, but not inside a string', styled(py[1], 'KW') === 'def' && styled(py[1], 'CM') === '# 주석' && styled(py[2], 'ST') === '"a#b"' && styled(py[2], 'CM') === '')
  const sh = md(['```bash', 'echo $# a#b  # 끝', '```'].join('\n'))
  check('markdown: in a shell, # starts a comment only after a space', styled(sh[1], 'CM') === '# 끝', JSON.stringify(sh[1].spans))
  const unknown = md(['```', 'const x = 1', '```'].join('\n'))
  check('markdown: code without a known language is not highlighted', unknown[0].spans.filter((sp) => !sp.decor).every((sp) => sp.style === 'K'))
  check('markdown: highlighted code copies as written', extract(ts, { line: 1, col: 0 }, { line: 2, col: 99 }) === "const n = 42 // 답\nif (ok) return 'yes'", JSON.stringify(extract(ts, { line: 1, col: 0 }, { line: 2, col: 99 })))
}

// 4c. A light background, as the terminal says it: COLORFGBG at start, or its answer to OSC 11 (the background
// colour), which the input parser reads as an event of its own, whole or split, ended by BEL or ST.
{
  check('background: COLORFGBG with a light background colour is light, a dark one dark, none or default unknown', backgroundOf({ COLORFGBG: '0;15' }) === 'light' && backgroundOf({ COLORFGBG: '0;default;7' }) === 'light' && backgroundOf({ COLORFGBG: '15;0' }) === 'dark' && backgroundOf({ COLORFGBG: '7;default' }) === null && backgroundOf({}) === null, String([backgroundOf({ COLORFGBG: '0;15' }), backgroundOf({ COLORFGBG: '15;0' })]))
  const p = new InputParser()
  const bg = (events) => events.filter((e) => e.type === 'background').map((e) => e.background).join(',')
  check('background: OSC 11 white, ended by BEL, is light', bg(p.feed('\x1b]11;rgb:ffff/ffff/ffff\x07')) === 'light')
  check('background: a dark grey, ended by ST, is dark', bg(p.feed('\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\')) === 'dark')
  const first = p.feed('\x1b]11;rgb:fa')
  const rest = p.feed('fa/fafa/fafa\x07x')
  check('background: an answer split across reads is one event, and what follows is still typed', first.length === 0 && bg(rest) === 'light' && rest.some((e) => e.type === 'key' && e.ch === 'x'), JSON.stringify(rest))
  check('background: two-digit components too', bg(p.feed('\x1b]11;rgb:f0/f0/f0\x07')) === 'light')
  const unfinished = new InputParser()
  const none = [...unfinished.feed('\x1b]11;rgb:ff'), ...unfinished.flush()]
  check('background: an answer that never finishes is dropped at the timeout, not typed', none.length === 0, JSON.stringify(none))
  const lone = new InputParser()
  const altAlone = [...lone.feed('\x1b]'), ...lone.flush()]
  check('background: alt+] alone is alt+], not escape', altAlone.length === 1 && altAlone[0].type === 'key' && altAlone[0].alt && altAlone[0].ch === ']', JSON.stringify(altAlone))
  const altDigit = [...lone.feed('\x1b]1'), ...lone.flush()]
  check('background: alt+] then a digit is both, not an answer', altDigit.length === 2 && altDigit[0].alt && altDigit[0].ch === ']' && altDigit[1].ch === '1', JSON.stringify(altDigit))
  const early = new InputParser()
  const atDigit = [...early.feed('\x1b]1'), ...early.feed('1;rgb:ffff/ffff/ffff\x07')]
  check('background: an answer split right after its first digit is still one answer', atDigit.length === 1 && atDigit[0].type === 'background' && atDigit[0].background === 'light', JSON.stringify(atDigit))
  // rxvt's ctrl+home and ctrl+end, and shift.
  const rx = lone.feed('\x1b[7^\x1b[8^\x1b[7$')
  check('input: rxvt ctrl+home, ctrl+end, shift+home', rx.length === 3 && rx[0].name === 'home' && rx[0].ctrl && rx[1].name === 'end' && rx[1].ctrl && rx[2].name === 'home' && rx[2].shift, JSON.stringify(rx))
  const alt = p.feed('\x1b]a')
  check('background: alt+] followed by a key is still alt+]', alt.length === 2 && alt[0].type === 'key' && alt[0].alt && alt[0].ch === ']', JSON.stringify(alt))
  // The same palette again is no change: nothing is drawn again for it (a dark terminal answering dark).
  useBackground('dark'); const same = themeGeneration(); useBackground('dark')
  check('background: the same palette again changes nothing', themeGeneration() === same)
  useBackground('light')
  const lightText = theme.userBand.fg, lightBand = theme.userBand.bg
  useBackground('dark')
  check('background: a light palette has dark text on a light band, and dark comes back', lightText !== undefined && lightText[0] < 0x60 && lightBand[0] > 0xc0 && theme.userBand.fg[0] > 0xc0 && palette.band[0] < 0x60, JSON.stringify([lightText, lightBand, theme.userBand.fg]))
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
