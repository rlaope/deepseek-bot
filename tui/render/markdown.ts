/**
 * Just enough Markdown for a chat answer: code blocks (highlighted for the common languages),
 * headings, lists, quotes, rules, tables, and inline **bold**, *emphasis*, ***both***, ~~strike~~,
 * `code`, [links](url), \*escapes\* —
 * plus the Slack forms the core's own messages use (*bold*, :warning:), because those are written
 * for Slack and reach the terminal unchanged.
 *
 * Markers are not drawn, so a copy gives the text as read. Lines wrap by display width across
 * styles; a code line wraps where it overflows, never at its spaces. A link's text carries its
 * target, which the screen turns into a clickable OSC 8 hyperlink.
 */
import { expandTabs, fit, graphemes, graphemeWidth, stringWidth } from './width.js'
import type { Line, Span } from './text.js'

export interface MarkdownStyles {
  text: string
  bold: string
  italic: string
  boldItalic: string
  strike: string
  code: string
  heading: string
  quote: string
  codeBlock: string
  dim: string
  link: string
  keyword: string
  string: string
  comment: string
  number: string
}

const SHORTCODES: Record<string, string> = {
  warning: '⚠', white_check_mark: '✅', heavy_check_mark: '✔', x: '❌', hourglass: '⏳', hourglass_flowing_sand: '⏳',
  bulb: '💡', memo: '📝', rocket: '🚀', tada: '🎉', eyes: '👀', thumbsup: '👍', '+1': '👍', fire: '🔥', link: '🔗',
}

/**
 * A target the terminal may open: http(s) and mailto only, in printable ASCII, and not too long.
 * The URL is written inside an escape sequence, where a control character would end it and write
 * the rest raw — and that includes the C1 range (U+0080–9F), which some terminals read as ESC
 * sequences. A URL in another script is still shown, as text; it is only not made clickable.
 */
function safeUrl(url: string): string | undefined {
  return /^(https?:\/\/|mailto:)[\x21-\x7e]{1,2000}$/i.test(url) ? url : undefined
}

/**
 * A bare URL without what belongs to the sentence around it: a closing bracket it never opened, a
 * full stop. One pass over the token: a URL followed by a long run of brackets must not be
 * rescanned for each one.
 */
function bareUrl(token: string): string {
  let end = token.length
  let opens = 0
  let closes = 0
  for (let i = 0; i < end; i++) { if (token[i] === '(') opens++; else if (token[i] === ')') closes++ }
  for (;;) {
    const c = end > 0 ? token[end - 1] : ''
    if (c === ')' && closes > opens) { closes--; end-- }
    else if (c !== '' && '.,;:!?\'"'.includes(c)) end--
    else return token.slice(0, end)
  }
}

/**
 * Inline markup → styled pieces. Unknown or unbalanced markers stay as text. Markup nests inside
 * emphasis and a link's label (`**run `x`**`, `[**docs**](url)`): the inner piece takes its own style.
 */
export function inline(text: string, base: string, s: MarkdownStyles): Span[] {
  const out: Span[] = []
  const push = (t: string, style: string, link?: string) => { if (t !== '') out.push(link === undefined ? { text: t, style } : { text: t, style, link }) }
  // Emphasis only at word edges, as Markdown has it: snake_case_names and 2*3*4 stay as written. A
  // link's label and target are bounded, so a run of brackets cannot make each one scan to the end.
  // A link's target may hold one level of balanced brackets (…/wiki/Foo_(bar)). A bare URL is
  // printable ASCII (it ends where Korean begins), bounded, without the brackets around it, and it
  // stops before ")(http": the next bracketed URL is a URL of its own. A backslash before ASCII
  // punctuation shows that character as it is, as in CommonMark.
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|((?<![\w*])\*[^*\s][^*\n]*?\*(?![\w*]))|((?<![\w_])_[^_\s][^_\n]*?_(?![\w_]))|(\[[^\]\n]{1,200}\]\((?:[^()\s]|\([^()\s]{0,2100}\)){1,2100}\))|(:[a-z0-9_+]+:)|(https?:\/\/(?:(?!\)\(https?:\/\/)[\x21-\x3b\x3d\x3f-\x5a\x5c\x5e-\x7e]){1,2001})|(\\[!-\/:-@[-`{-~])|((?<![\w*])\*\*\*[^*\s][^*\n]*?\*\*\*(?![\w*]))|(~~[^~\s](?:[^~\n]*?[^~\s])?~~)/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const at = m.index
    // A bare URL ends before the punctuation that closes its sentence; the rest is read again as
    // text (it may hold the next URL).
    const token = m[7] !== undefined ? bareUrl(m[0]) : m[0]
    re.lastIndex = at + Math.max(1, token.length)
    if (m[6] !== undefined && SHORTCODES[token.slice(1, -1)] === undefined) continue
    push(text.slice(last, at), base)
    if (m[1]) push(token.slice(1, -1), s.code)
    else if (m[2]) out.push(...inline(token.slice(2, -2), s.bold, s))
    else if (m[3] || m[4]) out.push(...inline(token.slice(1, -1), m[3] ? s.bold : s.italic, s))
    else if (m[5]) {
      const label = token.slice(1, token.indexOf(']'))
      const url = token.slice(token.indexOf(']') + 2, -1)
      const target = safeUrl(url)
      for (const piece of inline(label, s.link, s)) out.push(target === undefined ? { text: piece.text, style: piece.style } : { ...piece, link: target })
      // Shown as well, for a terminal without hyperlinks and for a copy.
      if (url !== label) push(` (${url})`, s.dim)
    } else if (m[7]) {
      // Only a bare host may run straight into the sentence ("x.com에서"): with a path, what follows
      // in another script is as likely the rest of the path as a particle, and no link is better
      // than a link to the wrong page. The same for a match that filled the bound: it is a prefix.
      // Only closing punctuation of another script — 。 ” ） — ends a URL like a full stop; anything
      // else outside ASCII, a dash or a middle dot included, may be part of the path.
      const next = String.fromCodePoint(text.codePointAt(at + token.length) ?? 0x20)
      const continues = /[^\x00-\x7f]/.test(next) && !/[\p{Pe}\p{Pf}、。，．！？：；]/u.test(next)
      const cutShort = (continues && !/^https?:\/\/[^/?#]+\/?$/.test(token)) || m[0].length - m[0].indexOf('//') - 2 >= 2001
      push(token, cutShort ? base : s.link, cutShort ? undefined : safeUrl(token))
    }
    else if (m[8]) push(token.slice(1), base)
    else if (m[9]) out.push(...inline(token.slice(3, -3), s.boldItalic, s))
    else if (m[10]) out.push(...inline(token.slice(2, -2), s.strike, s))
    else push(SHORTCODES[token.slice(1, -1)], base)
    last = at + token.length
  }
  push(text.slice(last), base)
  return out
}

interface Cell { g: string; w: number; style: string; link?: string }

/**
 * Wrap styled text into lines no wider than `width`, preferring spaces (or anywhere, for code).
 * Each line after the first records the spaces its break removed, so a copy can restore them.
 */
function wrapSpans(spans: Span[], width: number, anywhere: boolean): Array<{ spans: Span[]; gap: string }> {
  const max = Math.max(1, width)
  const cells: Cell[] = []
  for (const span of spans) for (const g of graphemes(span.text)) cells.push({ g, w: graphemeWidth(g), style: span.style, link: span.link })
  const lines: Array<{ cells: Cell[]; gap: string }> = []
  let line: Cell[] = []
  let used = 0
  let gap = ''
  for (const cell of cells) {
    if (used + cell.w > max && line.length > 0) {
      let cut = line.length
      if (!anywhere) {
        if (cell.g === ' ') cut = line.length
        else { const space = line.map((c) => c.g).lastIndexOf(' '); if (space > 0) cut = space }
      }
      const kept = line.slice(0, cut)
      let rest = line.slice(cut)
      let removed = ''
      while (kept.length > 0 && kept[kept.length - 1].g === ' ' && !anywhere) removed = kept.pop()!.g + removed
      while (rest.length > 0 && rest[0].g === ' ' && !anywhere) { removed += rest[0].g; rest = rest.slice(1) }
      lines.push({ cells: kept, gap })
      gap = removed
      line = rest
      used = line.reduce((n, c) => n + c.w, 0)
    }
    if (line.length === 0 && cell.g === ' ' && lines.length > 0 && !anywhere) { gap += ' '; continue }
    line.push(cell)
    used += cell.w
  }
  lines.push({ cells: line, gap })
  return lines.map(({ cells: cs, gap: g }) => {
    const grouped: Span[] = []
    for (const c of cs) {
      const prev = grouped[grouped.length - 1]
      if (prev !== undefined && prev.style === c.style && prev.link === c.link) prev.text += c.g
      else grouped.push(c.link === undefined ? { text: c.g, style: c.style } : { text: c.g, style: c.style, link: c.link })
    }
    return { spans: grouped, gap: g }
  })
}

// ── Code highlighting ──────────────────────────────────────────────────────
// A line at a time and by token class only — keywords, strings, comments, numbers — which is what
// makes code readable at a glance. No grammar, no state across lines (a /* … */ block that spans
// lines is shown plain), and no dependency.

interface Language { keywords: Set<string>; comment: string | null; hashAfterSpace?: boolean; quotes: string; caseless?: boolean }

const words = (list: string) => new Set(list.split(/\s+/).filter(Boolean))
const LANGUAGES: Record<string, Language> = {
  js: { comment: '//', quotes: `'"\``, keywords: words(`const let var function return if else for while do switch case break continue new class extends
    import from export default async await try catch finally throw typeof instanceof in of this null undefined true false void yield
    interface type enum implements public private protected readonly static as`) },
  py: { comment: '#', quotes: `'"`, keywords: words(`def class return if elif else for while in not and or is import from as with try except finally
    raise pass break continue lambda yield None True False async await global nonlocal self`) },
  sh: { comment: '#', hashAfterSpace: true, quotes: `'"`, keywords: words(`if then else elif fi for while until do done case esac function in return
    export local readonly echo exit set unset source cd`) },
  go: { comment: '//', quotes: '"`\'', keywords: words(`func package import return if else for range switch case default break continue var const
    type struct interface map chan go defer select nil true false`) },
  rust: { comment: '//', quotes: '"', keywords: words(`fn let mut pub use mod struct enum impl trait for while loop if else match return self Self
    crate super as in where async await move ref true false None Some Ok Err const static`) },
  c: { comment: '//', quotes: `'"`, keywords: words(`int long short float double char void bool boolean class public private protected static final
    return if else for while do switch case break continue new this null true false try catch finally throw struct const unsigned
    package import fun val var let func`) },
  json: { comment: null, quotes: '"', keywords: words('true false null') },
  yaml: { comment: '#', hashAfterSpace: true, quotes: `'"`, keywords: words('true false null yes no on off') },
  sql: { comment: '--', quotes: `'`, caseless: true, keywords: words(`select from where insert into values update set delete create table drop alter
    join left right inner outer on group by order limit offset as and or not null is in like between distinct count having union`) },
}
const ALIASES: Record<string, string> = {
  js: 'js', javascript: 'js', jsx: 'js', ts: 'js', typescript: 'js', tsx: 'js', mjs: 'js', cjs: 'js',
  py: 'py', python: 'py', sh: 'sh', bash: 'sh', zsh: 'sh', shell: 'sh', console: 'sh',
  go: 'go', golang: 'go', rs: 'rust', rust: 'rust', json: 'json', jsonc: 'json', yaml: 'yaml', yml: 'yaml', sql: 'sql',
  c: 'c', h: 'c', cpp: 'c', 'c++': 'c', hpp: 'c', java: 'c', cs: 'c', csharp: 'c', kotlin: 'c', kt: 'c', swift: 'c',
}

/** One code line as styled pieces, by the fence's language; unknown languages stay plain. */
function highlight(line: string, lang: string, s: MarkdownStyles): Span[] {
  const language = LANGUAGES[ALIASES[lang.toLowerCase()] ?? '']
  if (language === undefined || line === '') return [{ text: line === '' ? ' ' : line, style: s.codeBlock }]
  const out: Span[] = []
  const push = (text: string, style: string) => {
    const prev = out[out.length - 1]
    if (prev !== undefined && prev.style === style) prev.text += text
    else out.push({ text, style })
  }
  let i = 0
  while (i < line.length) {
    const rest = line.slice(i)
    const c = line[i]
    const commentHere = language.comment !== null && rest.startsWith(language.comment)
      && (!language.hashAfterSpace || i === 0 || /\s/.test(line[i - 1]))
    if (commentHere) { push(rest, s.comment); break }
    if (language.quotes.includes(c)) {
      let j = i + 1
      while (j < line.length && line[j] !== c) j += line[j] === '\\' ? 2 : 1
      push(line.slice(i, Math.min(j + 1, line.length)), s.string)
      i = Math.min(j + 1, line.length)
      continue
    }
    const number = /^(0x[0-9a-fA-F]+|\d[\d_]*(\.\d+)?([eE][+-]?\d+)?)/.exec(rest)
    if (number !== null && (i === 0 || !/[\w$]/.test(line[i - 1]))) { push(number[0], s.number); i += number[0].length; continue }
    const word = /^[A-Za-z_$][\w$]*/.exec(rest)
    if (word !== null) {
      const known = language.keywords.has(language.caseless === true ? word[0].toLowerCase() : word[0])
      push(word[0], known ? s.keyword : s.codeBlock)
      i += word[0].length
      continue
    }
    push(c, s.codeBlock)
    i++
  }
  return out
}

// ── Tables ─────────────────────────────────────────────────────────────────

const isRow = (raw: string) => /^\s*\|.*\|\s*$/.test(raw) || (raw.includes('|') && !/^\s*$/.test(raw))
// By cells, not by one pattern over the line: nested optional spaces backtrack quadratically on a long blank run.
const isSeparator = (raw: string) => raw.includes('-') && cellsOf(raw).every((cell) => /^:?-+:?$/.test(cell))
/**
 * A cell's text split at its line breaks written as HTML (<br>), the one way a GFM cell holds two lines; not at
 * one inside a code span (`a<br>b`), which shows it as written.
 */
const splitBreaks = (text: string): string[] => {
  const parts: string[] = []
  let last = 0
  for (const m of text.matchAll(/`[^`\n]+`|<br\s*\/?>/gi)) {
    if (m[0][0] === '`') continue
    parts.push(text.slice(last, m.index))
    last = m.index + m[0].length
  }
  parts.push(text.slice(last))
  return parts
}
const cellsOf = (raw: string) => raw.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))

/** A column is not narrowed below this many cells, or below what it needs when that is less. */
const MIN_COLUMN = 8

/**
 * Column widths that fit in `room`: each as wide as it needs, the widest narrowed first and evenly.
 * Null when even columns narrowed to `MIN_COLUMN` do not fit.
 */
function fitColumns(natural: number[], room: number): number[] | null {
  if (natural.reduce((n, w) => n + Math.min(w, MIN_COLUMN), 0) > room) return null
  const widths = [...natural]
  let left = room
  const order = natural.map((_, c) => c).sort((a, b) => natural[a] - natural[b])
  order.forEach((c, k) => { widths[c] = Math.min(natural[c], Math.floor(left / (order.length - k))); left -= widths[c] })
  return widths
}

/**
 * A GFM table, drawn with borders and its columns aligned by display width. Wider than `room`, its
 * widest columns are narrowed and their cells wrap inside them, with a rule between rows so a
 * wrapped row reads as one. Null when even narrowed columns do not fit.
 */
function table(header: string[], aligns: Array<'left' | 'right' | 'center'>, body: string[][], room: number, s: MarkdownStyles): Span[][] | null {
  const columns = header.length
  // A cell is its lines: one, or more where it says <br>.
  const cell = (row: string[], c: number, base: string) => splitBreaks(row[c] ?? '').map((part) => inline(part.trim(), base, s))
  const rows = [header.map((_, c) => cell(header, c, s.bold)), ...body.map((row) => header.map((_, c) => cell(row, c, s.text)))]
  const widthOf = (spans: Span[]) => stringWidth(spans.map((sp) => sp.text).join(''))
  const widths = fitColumns(header.map((_, c) => Math.max(1, ...rows.flatMap((row) => row[c].map(widthOf)))), room - 1 - 3 * columns)
  if (widths === null) return null
  const border = (left: string, mid: string, right: string): Span[] => [{ text: `${left}${widths.map((w) => '─'.repeat(w + 2)).join(mid)}${right}`, style: s.dim }]
  const drawRow = (row: Span[][][]): Span[][] => {
    const pieces = row.map((parts, c) => parts.flatMap((spans) => wrapSpans(spans, widths[c], false).map((piece) => piece.spans)))
    return Array.from({ length: Math.max(...pieces.map((p) => p.length)) }, (_, k) => {
      const spans: Span[] = [{ text: '│ ', style: s.dim }]
      for (let c = 0; c < columns; c++) {
        const piece = pieces[c][k] ?? []
        const free = widths[c] - widthOf(piece)
        const before = aligns[c] === 'right' ? free : aligns[c] === 'center' ? Math.floor(free / 2) : 0
        if (before > 0) spans.push({ text: ' '.repeat(before), style: s.text })
        spans.push(...piece)
        if (free - before > 0) spans.push({ text: ' '.repeat(free - before), style: s.text })
        spans.push({ text: c < columns - 1 ? ' │ ' : ' │', style: s.dim })
      }
      return spans
    })
  }
  const [head, ...drawn] = rows.map(drawRow)
  const rule = border('├', '┼', '┤')
  const ruled = drawn.some((row) => row.length > 1)
  return [border('┌', '┬', '┐'), ...head, rule, ...drawn.flatMap((row, k) => (ruled && k > 0 ? [rule, ...row] : row)), border('└', '┴', '┘')]
}

/**
 * A table too narrow for its columns, as the chat platforms show one (`transports/tables.ts`): an item
 * per row, its first cell in bold, the rest after a dash and, with three columns or more, named by
 * their header.
 */
function tableAsList(cells: string[], rows: string[][], s: MarkdownStyles): Span[][] {
  // A list item is one line of text: a <br> in a cell is a space in it.
  const header = cells.map((cell) => splitBreaks(cell).join(' '))
  const body = rows.map((row) => row.map((cell) => splitBreaks(cell).join(' ')))
  const joined = (parts: Span[][], between: string) => parts.flatMap((part, k) => (k > 0 ? [{ text: between, style: s.dim }, ...part] : part))
  // As in the drawn table, cells past the header are not part of it.
  const filled = body.map((row) => row.slice(0, header.length)).filter((row) => row.some((cell) => cell !== ''))
  if (filled.length === 0) return header.some((cell) => cell !== '') ? [joined(header.filter((cell) => cell !== '').map((cell) => inline(cell, s.bold, s)), ' · ')] : []
  // A header names its cells as a label: its words without their markup, cut short, since every row repeats it.
  const labels = header.map((cell) => (header.length > 2 ? fit(inline(cell, s.dim, s).map((sp) => sp.text).join(''), 40) : ''))
  return filled.map((row) => {
    const named = row.slice(1).flatMap((cell, k) => {
      if (cell === '') return []
      const name = labels[k + 1] !== '' ? [{ text: `${labels[k + 1]}: `, style: s.dim }] : []
      return [[...name, ...inline(cell, s.text, s)]]
    })
    const lead = row[0] === '' ? [] : [inline(row[0], s.bold, s)]
    return lead.length > 0 && named.length > 0 ? [...lead[0], { text: ' — ', style: s.dim }, ...joined(named, ' · ')] : joined([...lead, ...named], ' · ')
  })
}

/** Tab stops in an answer, as CommonMark reads tabs. */
const TAB_STOP = 4

/** A fence open where a layout stops: its mark, how many of it, its language. */
type Fence = { mark: string; size: number; lang: string } | null

/**
 * Lines of Markdown laid out, from inside `fence` when one is open, before the blank ends are trimmed. Of `raws`
 * (tabs expanded), the first `complete` are whole; the rest is a streamed line still arriving. `cut` is how far the
 * layout stays as it is whatever comes after: how many raws, the lines they made, and the fence open there. A line
 * is such a place when nothing after it can change it or what is before it: a fence's line, or one that is no
 * table's row or rule (no pipe, not a run of dashes). A table is laid out with all of its rows, never cut.
 */
interface Piece { lines: Line[]; cut: { raws: number; lines: number; fence: Fence } }

function piece(raws: string[], complete: number, width: number, s: MarkdownStyles, prefix: Span, from: Fence): Piece {
  const lines: Line[] = []
  let cut = { raws: 0, lines: 0, fence: from }
  const lead = (extra: Span[] = []): Span[] => [{ ...prefix, decor: true }, ...extra.map((e) => ({ ...e, decor: true }))]
  const widthOfDecor = (decor: Span[]) => [prefix, ...decor].reduce((n, d) => n + stringWidth(d.text), 0)
  const emit = (spans: Span[], decor: Span[], anywhere = false, hang = decor) => {
    const room = Math.max(1, width - widthOfDecor(decor))
    wrapSpans(spans, room, anywhere).forEach((piece, i) => {
      lines.push({ spans: [...lead(i === 0 ? decor : hang), ...piece.spans], soft: i > 0, ...(i > 0 ? { gap: piece.gap } : {}) })
    })
  }
  // A list item's mark is drawn once; its wrapped lines hang under its text.
  const item = (spans: Span[], mark: string) => emit(spans, [{ text: mark, style: s.dim }], false, [{ text: ' '.repeat(stringWidth(mark)), style: s.dim }])
  // A fence as CommonMark has it: three or more backticks or tildes, then an info string whose first
  // word is the language (none with a backtick, after backticks). It is closed by a run of the same
  // mark at least as long, alone on its line, so a ```` fence can show a ``` one.
  let fence = from
  const keep = (i: number) => { if (i < complete) cut = { raws: i + 1, lines: lines.length, fence } }
  // A line that is no table's row or rule: nothing after it joins it in a table.
  const kept = (i: number, raw: string) => { if (!raw.includes('|') && !isSeparator(raw)) keep(i) }
  for (let i = 0; i < raws.length; i++) {
    const raw = raws[i]
    const run = /^\s*(`{3,}|~{3,})(.*)$/.exec(raw)
    if (run !== null && fence === null && !(run[1][0] === '`' && run[2].includes('`'))) {
      const lang = run[2].trim().split(/\s+/)[0]
      fence = { mark: run[1][0], size: run[1].length, lang }
      if (lang !== '') lines.push({ spans: lead([{ text: lang, style: s.dim }]), soft: false })
      keep(i)
      continue
    }
    if (run !== null && fence !== null && run[1][0] === fence.mark && run[1].length >= fence.size && run[2].trim() === '') { fence = null; keep(i); continue }
    if (fence !== null) { emit(highlight(raw, fence.lang, s), [{ text: '│ ', style: s.dim }], true); keep(i); continue }
    // A table needs a separator row with as many cells as its header (so "a | b" over a rule is not one).
    if (isRow(raw) && i + 1 < raws.length && isSeparator(raws[i + 1]) && cellsOf(raws[i + 1]).length === cellsOf(raw).length) {
      const header = cellsOf(raw)
      const aligns = cellsOf(raws[i + 1]).map((d) => (d.endsWith(':') ? (d.startsWith(':') ? 'center' : 'right') : 'left') as 'left' | 'right' | 'center')
      // A row is shaped like the header: it starts with a pipe if the header does. GFM would take any
      // line up to a blank one, but an answer often goes on with a sentence right under its table.
      const piped = raw.trim().startsWith('|')
      let end = i + 2
      while (end < raws.length && isRow(raws[end]) && raws[end].trim() !== '' && (!piped || raws[end].trim().startsWith('|'))) end++
      const body = raws.slice(i + 2, end).map(cellsOf)
      const drawn = table(header, aligns, body, Math.max(1, width - widthOfDecor([])), s)
      if (drawn !== null) for (const row of drawn) lines.push({ spans: [...lead(), ...row], soft: false })
      // Too narrow for its columns: a list, which still reads.
      else for (const row of tableAsList(header, body, s)) item(row, '• ')
      i = end - 1
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw)
    if (heading !== null) { emit(inline(heading[2], s.heading, s), []); kept(i, raw); continue }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) { lines.push({ spans: lead([{ text: '─'.repeat(Math.max(1, Math.min(width - 2, 40))), style: s.dim }]), soft: false }); kept(i, raw); continue }
    const quote = /^>\s?(.*)$/.exec(raw)
    if (quote !== null) { emit(inline(quote[1], s.quote, s), [{ text: '│ ', style: s.dim }]); kept(i, raw); continue }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(raw)
    if (bullet !== null) { item(inline(bullet[2], s.text, s), `${bullet[1]}• `); kept(i, raw); continue }
    const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(raw)
    if (numbered !== null) { item(inline(numbered[3], s.text, s), `${numbered[1]}${numbered[2]}. `); kept(i, raw); continue }
    if (raw.trim() === '') { lines.push({ spans: lead(), soft: false }); keep(i); continue }
    emit(inline(raw, s.text, s), [])
    kept(i, raw)
  }
  return { lines, cut }
}

/**
 * An answer never starts or ends with blank lines of its own (a line of just the prefix) — while a code block's
 * language, also all decoration, stays even when the answer opens with the block.
 */
function trimmed(lines: Line[]): Line[] {
  const blank = (line: Line) => line.spans.length === 1 && line.spans[0].decor === true
  let from = 0
  let to = lines.length
  while (to > 0 && blank(lines[to - 1])) to--
  while (from < to && blank(lines[from])) from++
  return from === 0 && to === lines.length ? lines : lines.slice(from, to)
}

/** Tabs to stops of 4 columns, CommonMark's, from the start of each line: a code block keeps its indentation, a
 * list its nesting, and tab-separated text its columns. */
const rawsOf = (text: string) => text.split('\n').map((raw) => expandTabs(raw, TAB_STOP))

/**
 * Lay out a Markdown answer under a prefix (e.g. two spaces), as transcript lines.
 */
export function markdown(text: string, width: number, s: MarkdownStyles, prefix: Span): Line[] {
  const raws = rawsOf(text)
  return trimmed(piece(raws, raws.length, width, s, prefix, null).lines)
}

/**
 * `markdown` for a text that grows at its end, a streamed answer: what was laid out up to the last place nothing
 * after it can change is kept (for this width, prefix and styles), and only the rest is laid out again, so a frame
 * costs the answer's last lines rather than all of them. The same lines as `markdown` of the whole text. A text that
 * is not the last one with more at its end (a retry, the committed reply) is laid out from its start. `work`, for a
 * test, hears how many lines each layout took.
 */
export function markdownStream(work?: (lines: number) => void): (text: string, width: number, s: MarkdownStyles, prefix: Span) => Line[] {
  let key = ''
  let done = ''
  let kept: Line[] = []
  let fence: Fence = null
  return (text, width, s, prefix) => {
    const now = `${width}\n${prefix.text}\n${prefix.style}\n${JSON.stringify(s)}`
    if (now !== key || !text.startsWith(done)) { key = now; done = ''; kept = []; fence = null }
    const rest = text.slice(done.length).split('\n')
    work?.(rest.length)
    const out = piece(rest.map((raw) => expandTabs(raw, TAB_STOP)), rest.length - 1, width, s, prefix, fence)
    if (out.cut.raws > 0) {
      for (let i = 0; i < out.cut.lines; i++) kept.push(out.lines[i])
      done += `${rest.slice(0, out.cut.raws).join('\n')}\n`
      fence = out.cut.fence
    }
    return trimmed([...kept, ...out.lines.slice(out.cut.lines)])
  }
}
