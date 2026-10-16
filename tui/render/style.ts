/**
 * Colour and text attributes for the terminal in front of us.
 *
 * Three modes: 24-bit when the terminal says it has it (`COLORTERM`), the 256-colour cube
 * otherwise, and nothing at all under `NO_COLOR`. A style is reduced to its SGR string when a block
 * is laid out (again when the palette changes), and that string doubles as the cell's style key, so
 * the diff compares styles as strings.
 */

export type ColorMode = 'truecolor' | '256' | 'none'

export type Rgb = readonly [number, number, number]

export interface Style {
  fg?: Rgb
  bg?: Rgb
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  inverse?: boolean
}

export function detectColorMode(env: Record<string, string | undefined>): ColorMode {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 'none'
  if (/^(truecolor|24bit)$/i.test(env.COLORTERM ?? '')) return 'truecolor'
  return '256'
}

/** Nearest entry in the xterm 6×6×6 cube or the grey ramp. */
export function rgbTo256([r, g, b]: Rgb): number {
  const level = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.floor((v - 35) / 40)))
  const steps = [0, 95, 135, 175, 215, 255]
  const [lr, lg, lb] = [level(r), level(g), level(b)]
  const cube = 16 + 36 * lr + 6 * lg + lb
  const cubeDist = (steps[lr] - r) ** 2 + (steps[lg] - g) ** 2 + (steps[lb] - b) ** 2
  const grey = Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10)))
  const greyValue = 8 + grey * 10
  const greyDist = (greyValue - r) ** 2 + (greyValue - g) ** 2 + (greyValue - b) ** 2
  return greyDist < cubeDist ? 232 + grey : cube
}

/**
 * The SGR sequence for a style, always starting from a reset so a cell never inherits
 * attributes from whatever was drawn before it. `''` means "default", which is the key the
 * screen's empty cells carry.
 */
export function sgr(style: Style | undefined, mode: ColorMode): string {
  if (style === undefined) return ''
  const codes: string[] = []
  if (style.bold) codes.push('1')
  if (style.dim) codes.push('2')
  if (style.italic) codes.push('3')
  if (style.underline) codes.push('4')
  if (style.inverse) codes.push('7')
  if (mode !== 'none') {
    if (style.fg) codes.push(mode === 'truecolor' ? `38;2;${style.fg.join(';')}` : `38;5;${rgbTo256(style.fg)}`)
    if (style.bg) codes.push(mode === 'truecolor' ? `48;2;${style.bg.join(';')}` : `48;5;${rgbTo256(style.bg)}`)
  }
  return codes.length === 0 ? '' : `\x1b[0;${codes.join(';')}m`
}

/** Linear blend from `a` to `b`, `t` in [0, 1]. */
export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const k = Math.max(0, Math.min(1, t))
  return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * k)) as unknown as Rgb
}

/** The palette of docs/logo.svg, for a dark background. */
const DARK = {
  primary: [0x2e, 0x7b, 0xff] as Rgb,
  deep: [0x0b, 0x3f, 0xa8] as Rgb,
  accent: [0x1e, 0x6f, 0xff] as Rgb,
  light: [0x5b, 0x9b, 0xff] as Rgb,
  muted: [0x8a, 0x93, 0xa6] as Rgb,
  text: [0xe6, 0xe9, 0xef] as Rgb,
  warn: [0xf2, 0xb0, 0x3d] as Rgb,
  danger: [0xf0, 0x5a, 0x5a] as Rgb,
  ok: [0x4c, 0xc3, 0x8a] as Rgb,
  /** Thinking and reasoning: a sky blue apart from the brand's, so the model's reasoning never reads as its answer. */
  sky: [0x7d, 0xd3, 0xfc] as Rgb,
  skyDim: [0x5b, 0xa4, 0xc8] as Rgb,
  /** The light that sweeps across a label while the bot works. */
  glint: [0xff, 0xff, 0xff] as Rgb,
  /** The band behind what the person said. */
  band: [0x26, 0x2c, 0x38] as Rgb,
  /** Behind an edit's added and removed lines. Cube colours (22 and 52 in 256 colours), so green and red
   * survive a terminal without true colour. */
  added: [0, 95, 0] as Rgb,
  removed: [95, 0, 0] as Rgb,
}

/** The same roles on a light background: darker colours for text and marks, light ones behind. */
const LIGHT: typeof DARK = {
  primary: [0x1a, 0x5f, 0xd6],
  deep: [0x0b, 0x3f, 0xa8],
  accent: [0x1a, 0x5f, 0xd6],
  light: [0x2a, 0x6c, 0xd8],
  muted: [0x5f, 0x66, 0x73],
  text: [0x1f, 0x23, 0x28],
  warn: [0xa3, 0x5f, 0x00],
  danger: [0xc4, 0x2b, 0x2b],
  ok: [0x1a, 0x7f, 0x4b],
  sky: [0x02, 0x6a, 0xa7],
  skyDim: [0x3b, 0x6e, 0x8f],
  glint: [0x0b, 0x3f, 0xa8],
  band: [0xe9, 0xee, 0xf5],
  added: [0xd2, 0xf4, 0xd8],
  removed: [0xfb, 0xd9, 0xd9],
}

/** The colours in use: the dark palette unless the terminal's background is light (useBackground). */
export const palette = { ...DARK }

function themeOf(palette: typeof DARK) {
  return {
    text: {} as Style,
    muted: { fg: palette.muted } as Style,
    dim: { dim: true } as Style,
    user: { fg: palette.light, bold: true } as Style,
    userBand: { fg: palette.text, bg: palette.band } as Style,
    userMark: { fg: palette.light, bg: palette.band, bold: true } as Style,
    answerMark: { fg: palette.text } as Style,
    thinking: { fg: palette.sky } as Style,
    thinkingBody: { fg: palette.skyDim, italic: true } as Style,
    assistant: {} as Style,
    tool: { fg: palette.muted } as Style,
    toolMark: { fg: palette.primary } as Style,
    brand: { fg: palette.primary, bold: true } as Style,
    border: { fg: palette.deep } as Style,
    status: { fg: palette.muted } as Style,
    accent: { fg: palette.primary } as Style,
    warn: { fg: palette.warn } as Style,
    danger: { fg: palette.danger } as Style,
    // An edit's lines, the colour behind the text as Claude Code and pi draw them.
    diffAdded: { fg: palette.text, bg: palette.added } as Style,
    diffRemoved: { fg: palette.text, bg: palette.removed } as Style,
    ok: { fg: palette.ok } as Style,
    selected: { inverse: true } as Style,
    bold: { bold: true } as Style,
    italic: { italic: true } as Style,
    code: { fg: palette.light } as Style,
    heading: { fg: palette.primary, bold: true } as Style,
    quote: { fg: palette.muted, italic: true } as Style,
    codeBlock: { fg: palette.text } as Style,
    link: { fg: palette.light, underline: true } as Style,
    codeKeyword: { fg: palette.primary, bold: true } as Style,
    codeString: { fg: palette.ok } as Style,
    codeComment: { fg: palette.muted, italic: true } as Style,
    codeNumber: { fg: palette.warn } as Style,
  }
}

/** Named styles the views use, so a view never spells a colour. */
export const theme = themeOf(palette)

/**
 * The terminal's background as COLORFGBG says it (`fg;bg` or `fg;default;bg`, as rxvt and others set
 * it): light for colour 7 or 9–15, dark for 0–6 or 8, unknown otherwise.
 */
export function backgroundOf(env: Record<string, string | undefined>): 'light' | 'dark' | null {
  const fields = (env.COLORFGBG ?? '').split(';')
  if (fields.length < 2) return null
  const bg = Number(fields[fields.length - 1])
  if (!Number.isInteger(bg) || fields[fields.length - 1].trim() === '') return null
  return bg === 7 || (bg >= 9 && bg <= 15) ? 'light' : bg >= 0 && bg <= 8 ? 'dark' : null
}

let generation = 0
/** Bumped when the palette changes: a layout made before it is drawn again. */
export function themeGeneration(): number {
  return generation
}

let current: 'light' | 'dark' = 'dark'
/** Light or dark colours from now on; what is on screen is drawn again in them, when they changed. */
export function useBackground(kind: 'light' | 'dark'): void {
  if (kind === current) return
  current = kind
  Object.assign(palette, kind === 'light' ? LIGHT : DARK)
  Object.assign(theme, themeOf(palette))
  generation++
}
