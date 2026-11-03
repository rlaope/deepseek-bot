/**
 * Display width, in terminal columns.
 *
 * Every layout decision in the TUI — wrapping, the cursor, a click's column, which characters a
 * drag selected — depends on how many columns a string takes, and JavaScript's `length` answers a
 * different question. Hangul is the case that matters most here: the bot speaks Korean, each
 * syllable is two columns, and a renderer that counts it as one puts the cursor in the wrong place
 * on the first line it wraps.
 *
 * Graphemes come from `Intl.Segmenter`, which Node ships; the wide ranges are the East Asian
 * Wide/Fullwidth blocks that occur in practice. A table, not a dependency.
 */

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** User-perceived characters: a syllable, an emoji with its modifiers, a base with its marks. */
export function graphemes(text: string): string[] {
  const out: string[] = []
  for (const { segment } of segmenter.segment(text)) out.push(segment)
  return out
}

// Inclusive [start, end] code point ranges rendered two columns wide.
const WIDE: Array<[number, number]> = [
  [0x1100, 0x115f],   // Hangul Jamo, leading consonants
  [0x231a, 0x231b], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f],
  [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be],
  [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd],
  [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c],
  [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e],   // CJK radicals, punctuation
  [0x3041, 0x33ff],   // Kana, Hangul compatibility Jamo, CJK symbols
  [0x3400, 0x4dbf],   // CJK extension A
  [0x4e00, 0x9fff],   // CJK unified ideographs
  [0xa000, 0xa4cf],   // Yi
  [0xa960, 0xa97f],   // Hangul Jamo extended A
  [0xac00, 0xd7a3],   // Hangul syllables
  [0xf900, 0xfaff],   // CJK compatibility ideographs
  [0xfe10, 0xfe19], [0xfe30, 0xfe6f],
  [0xff00, 0xff60], [0xffe0, 0xffe6],   // fullwidth forms
  [0x16fe0, 0x16fe4], [0x17000, 0x18cff], [0x1b000, 0x1b2ff],
  [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a],
  [0x1f200, 0x1f251], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f7e0, 0x1f7eb],
  [0x1f90c, 0x1f9ff], [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd], [0x30000, 0x3fffd],
]

function isWide(cp: number): boolean {
  let lo = 0
  let hi = WIDE.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const [start, end] = WIDE[mid]
    if (cp < start) hi = mid - 1
    else if (cp > end) lo = mid + 1
    else return true
  }
  return false
}

const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}​-‏︀-️]+$/u

/** Columns one grapheme occupies: 0 for controls and lone marks, 2 for wide, 1 otherwise. */
export function graphemeWidth(grapheme: string): 0 | 1 | 2 {
  const cp = grapheme.codePointAt(0)
  if (cp === undefined) return 0
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0
  if (ZERO_WIDTH.test(grapheme)) return 0
  if (isWide(cp)) return 2
  // A flag is a pair of regional indicators, and the terminals in use draw it wide; one alone is a letter.
  if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return grapheme.length > 2 ? 2 : 1
  // A keycap (1️⃣, #️⃣) is drawn wide, with or without its VS16.
  if (grapheme.includes('\u20e3')) return 2
  // A text-presentation symbol made an emoji by VS16 (❤️, ☀️) is drawn wide by the terminals in use.
  if (grapheme.includes('️') && (/\p{Extended_Pictographic}/u.test(grapheme) || /\p{Emoji}/u.test(String.fromCodePoint(cp)))) return 2
  return 1
}

/**
 * Tabs as spaces to the next multiple of `stop`, counted in columns from the start of each line. A tab
 * is a control character, 0 columns to the screen, so a tab left in the text is never drawn at all.
 */
export function expandTabs(text: string, stop: number): string {
  if (!text.includes('\t')) return text
  let out = ''
  let col = 0
  for (const g of graphemes(text)) {
    if (g === '\t') { const n = stop - (col % stop); out += ' '.repeat(n); col += n }
    else if (g === '\n') { out += g; col = 0 }
    else { out += g; col += graphemeWidth(g) }
  }
  return out
}

// Escape sequences, as a terminal reads them: CSI (ESC [ or C1 0x9b) up to its final byte; a string (OSC,
// DCS, SOS, PM, APC) up to BEL or ST — or the line's end, so one left open hides no more than its line;
// any other ESC with what it takes. An unfinished one at the end (a streamed answer cut mid-sequence) too.
const ESCAPES = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]?|(?:\x1b[\]PX^_]|[\x90\x98\x9d-\x9f])[^\x07\x1b\x9c\n]*(?:\x07|\x1b\\|\x9c)?|\x1b[ -/]*[0-~]?/g
// The C0 and C1 controls left once those are gone, but for tab and newline.
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g

/**
 * Text a model or a tool wrote, without what a terminal would read as a command: escape sequences (a
 * tool's colours, a cursor move, a hyperlink of its own) and other control characters. Drawn as they
 * are, their ESC is dropped as 0 columns and the rest shows as "[31m". A CRLF is a newline.
 */
export function stripControls(text: string): string {
  if (!/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(text)) return text
  return text.replace(/\r\n/g, '\n').replace(ESCAPES, '').replace(CONTROLS, '')
}

export function stringWidth(text: string): number {
  // ASCII fast path: the common case for code and English.
  if (/^[\x20-\x7e]*$/.test(text)) return text.length
  let width = 0
  for (const g of graphemes(text)) width += graphemeWidth(g)
  return width
}

/** The text in at most `columns` cells: cut with an ellipsis when it is wider. */
export function fit(text: string, columns: number): string {
  if (stringWidth(text) <= columns) return text
  if (columns <= 0) return ''
  let out = ''
  let used = 0
  for (const g of graphemes(text)) {
    const w = graphemeWidth(g)
    if (used + w > columns - 1) break
    out += g
    used += w
  }
  return `${out}…`
}
