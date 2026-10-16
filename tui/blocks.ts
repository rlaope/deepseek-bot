/**
 * What the conversation is made of, as transcript blocks.
 *
 * Each block lays itself out for a width and carries a version, so the transcript re-wraps only
 * what changed. The answer being streamed is the one mutable block: deltas append to it, a failed
 * attempt is dropped from it, and the end replaces it with the committed text.
 */
import { banner, BANNER_WIDTHS } from './render/banner.js'
import { t } from './strings.js'
import { palette, sgr, theme, type ColorMode } from './render/style.js'
import { blink, currentFrame, shimmer } from './render/motion.js'
import { fit, stringWidth } from './render/width.js'
import { layout, type Line, type Span } from './render/text.js'
import { markdown, type MarkdownStyles } from './render/markdown.js'
import { lineDiff } from './render/linediff.js'
import { stripState } from './interview.js'

function markdownStyles(mode: ColorMode): MarkdownStyles {
  return {
    text: sgr(theme.assistant, mode), bold: sgr(theme.bold, mode), italic: sgr(theme.italic, mode), code: sgr(theme.code, mode),
    heading: sgr(theme.heading, mode), quote: sgr(theme.quote, mode), codeBlock: sgr(theme.codeBlock, mode), dim: sgr(theme.muted, mode), link: sgr(theme.link, mode),
    keyword: sgr(theme.codeKeyword, mode), string: sgr(theme.codeString, mode), comment: sgr(theme.codeComment, mode), number: sgr(theme.codeNumber, mode),
  }
}
import type { Block } from './render/transcript.js'

let counter = 0
const nextId = (kind: string) => `${kind}-${++counter}`

const pad = (text: string, style = ''): Span => ({ text, style, decor: true })

/** The display width of a line's spans. */
const widthOf = (line: Line) => line.spans.reduce((n, span) => n + stringWidth(span.text), 0)

/** A tool's name as a call is written: a lower-case name capitalised (bash → Bash), any other as it is. */
function callName(name: string): string {
  return /^[a-z]+$/.test(name) ? name[0].toUpperCase() + name.slice(1) : name
}

/** What the person said, on a band of its own across the pane, so a question never reads as part of an answer. */
export function userBlock(text: string, mode: ColorMode): Block {
  const banded = mode !== 'none'
  return {
    id: nextId('user'),
    version: 0,
    prompt: text,
    lines(width) {
      // Styles as the palette is now: a light terminal's answer draws this again.
      const mark = sgr(banded ? theme.userMark : theme.user, mode)
      const body = sgr(banded ? theme.userBand : theme.text, mode)
      const lines = layout(text, width, body, { first: pad('› ', mark), rest: pad('  ', body) })
      // The band runs to the edge; without colour there is no band, and no trailing spaces.
      if (banded) for (const line of lines) line.spans.push(pad(' '.repeat(Math.max(0, width - widthOf(line))), body))
      return [blank(), ...lines]
    },
  }
}

export interface AnswerBlock extends Block {
  version: number
  text: string
  streaming: boolean
  append(delta: string): void
  /** A failed attempt is retried from scratch: forget what it streamed. */
  reset(): void
  finish(text?: string): void
}

export function answerBlock(mode: ColorMode): AnswerBlock {
  const block: AnswerBlock = {
    id: nextId('answer'),
    version: 0,
    text: '',
    streaming: true,
    append(delta) { block.text += delta; block.version++ },
    reset() { block.text = ''; block.version++ },
    finish(text) { if (text !== undefined) block.text = text; block.streaming = false; block.version++ },
    lines(width) {
      // A deep interview's state blocks are for the gauges, not for reading.
      const shown = stripState(block.text)
      if (shown === '' && !block.streaming) return []
      const mark = sgr(theme.answerMark, mode)
      const lines = markdown(shown, width, markdownStyles(mode), pad('  '))
      if (lines.length === 0) lines.push({ spans: [pad('  ')], soft: false })
      // A dot where the answer starts, in the indent it would have had.
      const lead = lines[0].spans[0]
      if (lead?.decor === true && lead.text === '  ') lines[0].spans[0] = pad('● ', mark)
      return lines
    },
  }
  return block
}

export function toolBlock(name: string, detail: string, mode: ColorMode): Block {
  // As a call is written in the main transcript: Name(what it was asked).
  const text = detail === '' ? callName(name) : `${callName(name)}(${detail})`
  return { id: nextId('tool'), version: 0, lines: (width) => layout(text, width, sgr(theme.tool, mode), { first: pad('● ', sgr(theme.toolMark, mode)), rest: pad('  ') }) }
}

/** What folded blocks show: a few lines, or all of them — ctrl+o for tool steps, ctrl+t for thinking. */
export interface Detail { expanded: boolean }

const FOLDED = { thinking: 3, diff: 10, result: 3 }
/** A shell's output, folded: its last lines, where a failure or the result is. */
const SHELL_TAIL = 5

/** What a tool's result is, by the tool's name: a read, a search, a list of files, a shell, or anything else. */
function resultKind(tool: string): 'read' | 'search' | 'files' | 'shell' | 'other' {
  const name = tool.toLowerCase()
  if (/^(read|read_file|view|cat)$/.test(name)) return 'read'
  if (/^(grep|rg|ripgrep|search_files)$/.test(name)) return 'search'
  if (/^(glob|ls|list|find|list_files|list_directory)$/.test(name)) return 'files'
  if (/^(bash|shell|sh|exec|run|terminal)$/.test(name)) return 'shell'
  return 'other'
}
const UNFOLDED = { thinking: 400, diff: 200, result: 40 }

/** One line saying how many lines a fold hides: "… +N lines (ctrl+o to expand)"; `lead` when it opens the result. */
function moreLine(n: number, detail: Detail, style: string, lead = '     '): Line {
  return { spans: [pad(lead, style), { text: `… ${t().moreLines(n, detail.expanded)}`, style }], soft: false }
}

/** Lines past `limit` folded into one line after them. */
function fold(lines: Line[], limit: number, detail: Detail, style: string): Line[] {
  if (lines.length <= limit) return lines
  return [...lines.slice(0, limit), moreLine(lines.length - limit, detail, style)]
}

/** The last `limit` lines, the fold line before them: a shell's output ends where it matters. `lead` marks the
 * fold line when it opens the result (`  ⎿  `), as the first line it hides would have. */
function tail(lines: Line[], limit: number, detail: Detail, style: string, lead = '     '): Line[] {
  if (lines.length <= limit) return lines
  return [moreLine(lines.length - limit, detail, style, lead), ...lines.slice(-limit)]
}

export interface ThinkingBlock extends Block {
  text: string
  streaming: boolean
  append(text: string): void
  /** A failed attempt is retried from scratch: forget what it thought. */
  reset(): void
  /** The answer started (or the turn ended): fold to one line. */
  done(): void
}

/** The model's reasoning: its latest lines while it streams, "Thought for Ns" after, all of it on ctrl+t. */
export function thinkingBlock(detail: Detail, mode: ColorMode, now: () => number = Date.now): ThinkingBlock {
  let own = 0
  let began: number | null = null
  let ended: number | null = null
  const block: ThinkingBlock = {
    id: nextId('thinking'),
    // The layout depends on ctrl+t as much as on the text, and while it streams, on the frame.
    get version() { return `${own}:${detail.expanded ? 1 : 0}:${block.streaming ? currentFrame() : '-'}` },
    text: '',
    streaming: true,
    append(text) { if (began === null) began = now(); block.text += text; own++ },
    reset() { block.text = ''; began = null; own++ },
    done() { if (block.streaming) ended = now(); block.streaming = false; own++ },
    lines(width) {
      const text = block.text.trim()
      if (text === '') return []
      const head = sgr(theme.thinking, mode)
      const body = sgr(theme.thinkingBody, mode)
      const seconds = Math.max(1, Math.round(((ended ?? now()) - (began ?? now())) / 1000))
      const label = block.streaming
        ? shimmer(t().thinking, palette.sky, palette.glint, currentFrame(), mode)
        : [{ text: t().thought(seconds, detail.expanded), style: head }]
      const lines: Line[] = [{ spans: [pad(block.streaming ? '✻ ' : '∴ ', head), ...label], soft: false }]
      if (!detail.expanded && !block.streaming) return lines
      const all = layout(text, width, body, { first: pad('  '), rest: pad('  ') })
      return [...lines, ...(detail.expanded ? fold(all, UNFOLDED.thinking, detail, head) : all.slice(-FOLDED.thinking))]
    },
  }
  return block
}

export interface ToolStep {
  name: string
  callId?: string
  title?: string
  diff?: Array<{ path: string; old: string | null; new: string | null; oldCut?: boolean; newCut?: boolean }>
}

export interface ToolCallBlock extends Block {
  callId?: string
  name: string
  /** `lines`: how many it had before the gateway cut it, when it says. */
  result(ok: boolean, text: string, lines?: number): void
  /** The turn ended with no result for it: stop blinking. */
  settle(): void
}

/** A tool call: its name and title, an edit's changed lines, then its result under it. */
export function toolCallBlock(step: ToolStep, detail: Detail, mode: ColorMode): ToolCallBlock {
  // Only what changed: the lines around a change are in the file (and the core sends the changed
  // part alone). When a side was cut, the comparison was made against a text that stops early, and
  // proves little:
  //  - a line of the whole side with no partner may have its partner past the cut — so a removal is
  //    withheld when the new side was cut, and an addition when the old side was;
  //  - a line of the cut side may have been paired with the wrong blank line or brace, leaving a
  //    kept line between them looking changed — so of the cut side only a line whose text is
  //    nowhere on the whole side is shown. That one is certain.
  let uncompared = false
  let withheld = 0
  const linesOf = (text: string | null) => (text === null ? [] : text.split('\n'))
  // Each file's changed lines, under a line saying which file and how much came and went.
  const files = (step.diff ?? []).map((d) => {
    const ops = lineDiff(linesOf(d.old), linesOf(d.new))
    // Too long to compare line by line: said, never guessed at.
    if (ops === null) { uncompared = true; return { path: d.path, sure: [] as Array<{ op: string; text: string }> } }
    const changed = ops.filter((l) => l.op !== ' ')
    const wholeOld = d.newCut === true && d.oldCut !== true ? new Set(linesOf(d.old)) : null
    const wholeNew = d.oldCut === true && d.newCut !== true ? new Set(linesOf(d.new)) : null
    const sure = changed.filter((l) => (l.op === '-'
      ? d.newCut !== true && (wholeNew === null || !wholeNew.has(l.text))
      : d.oldCut !== true && (wholeOld === null || !wholeOld.has(l.text))))
    withheld += changed.length - sure.length
    return { path: d.path, sure }
  })
  const changes = files.flatMap((f) => f.sure)
  const cut = (step.diff ?? []).some((d) => d.oldCut === true || d.newCut === true)
  let own = 0
  let outcome: { ok: boolean; text: string; lines?: number } | null = null
  let settled = false
  const running = () => outcome === null && !settled
  const block: ToolCallBlock = {
    id: nextId('tool'),
    get version() { return `${own}:${detail.expanded ? 1 : 0}:${running() ? (blink(currentFrame()) ? 'on' : 'off') : '-'}` },
    callId: step.callId,
    name: step.name,
    result(ok, text, lines) { outcome = { ok, text, lines }; own++ },
    settle() { if (running()) { settled = true; own++ } },
    lines(width) {
      // Styles as the palette is now: a light terminal's answer draws this again.
      const marks = {
        on: sgr({ fg: palette.light, bold: true }, mode), off: sgr({ fg: palette.deep }, mode),
        ok: sgr(theme.ok, mode), failed: sgr(theme.danger, mode), settled: sgr(theme.muted, mode),
      }
      const name = sgr({ ...theme.text, bold: true }, mode)
      const style = sgr(theme.tool, mode)
      const removed = sgr(theme.danger, mode)
      const removedRow = sgr(theme.diffRemoved, mode)
      const addedRow = sgr(theme.diffAdded, mode)
      const title = (step.title ?? '').split('\n')[0]
      const mark = outcome !== null ? (outcome.ok ? marks.ok : marks.failed) : settled ? marks.settled : blink(currentFrame()) ? marks.on : marks.off
      // As Claude Code writes a call: the tool's name, then what it was asked in brackets.
      const shownName = callName(step.name)
      const asked = title === '' || title === step.name ? '' : `(${title})`
      const out = layout(`${shownName}${asked}`, width, style, { first: pad('● ', mark), rest: pad('  ') })
      // The tool's name in bold, what it was asked in the tool's own grey.
      const head = out[0]?.spans[1]
      if (head !== undefined && head.text.startsWith(shownName)) out[0].spans.splice(1, 1, { text: shownName, style: name }, { text: head.text.slice(shownName.length), style })
      const at = pad('  ⎿  ', style)
      const diff = files.flatMap((f) => {
        if (f.sure.length === 0) return []
        const plus = f.sure.filter((d) => d.op === '+').length
        // "Updated" once the edit answered that it did; until then, and when it failed, the file alone.
        const said = outcome?.ok === true ? t().updated(f.path, plus, f.sure.length - plus) : f.path
        const head = layout(said, width, style, { first: at, rest: pad('     ') })
        // The colour runs behind the whole row, as far as the text is wide; the padding is decor, so a copy
        // of the row does not carry it.
        const rows = f.sure.flatMap((d) => {
          const rowStyle = d.op === '-' ? removedRow : addedRow
          const laid = layout(`${d.op} ${d.text === '' ? ' ' : d.text}`, width, rowStyle, { first: pad('      '), rest: pad('      ') })
          for (const row of laid) { const used = widthOf(row); if (used < width) row.spans.push(pad(' '.repeat(width - used), rowStyle)) }
          return laid
        })
        return [...head, ...fold(rows, detail.expanded ? UNFOLDED.diff : FOLDED.diff, detail, style)]
      })
      out.push(...diff)
      const note = uncompared ? t().diffUncompared
        : !cut ? ''
          : changes.length > 0 ? (withheld > 0 ? t().diffWithheld(withheld) : t().diffHead)
            : withheld > 0 ? t().diffNoneCertain
              : t().diffNoDifference
      if (note !== '') out.push({ spans: [pad('    '), { text: note, style }], soft: false })
      if (outcome !== null) {
        const text = outcome.text.replace(/\s+$/, '')
        // The gateway's count, from before it cut a long result; a "no matches" answer is none.
        const kind = resultKind(step.name)
        const none = (kind === 'search' || kind === 'files') && /^(no (matches|files|results)( found)?|found 0\b)/i.test(text)
        const count = none ? 0 : outcome.lines ?? (text === '' ? 0 : text.split('\n').length)
        // What the result says: a line of its own for a read or a search unless asked to open it (ctrl+o); an
        // edit's diff says it already; else its lines, a shell's last ones.
        const summary = !outcome.ok || detail.expanded ? null
          : kind === 'read' ? t().readLines(count) : kind === 'search' ? t().foundLines(count) : kind === 'files' ? t().foundFiles(count) : null
        if (outcome.ok && changes.length > 0 && !detail.expanded) return out
        const shown = outcome.ok ? style : removed
        const limit = detail.expanded ? UNFOLDED.result : kind === 'shell' ? SHELL_TAIL : FOLDED.result
        if (kind === 'shell' && text.includes('\n') && summary === null) {
          // A shell: its last lines, where the result or the error is; one that failed under a line saying so.
          const lead = outcome.ok ? '  ⎿  ' : '     '
          const rows = layout(text, width, shown, { first: pad(lead, shown), rest: pad('     ') })
          if (!outcome.ok) out.push({ spans: [pad('  ⎿  ', shown), { text: t().failedWith(''), style: shown }], soft: false })
          out.push(...tail(rows, limit, detail, style, lead))
        } else {
          const body = summary ?? (outcome.ok ? (text === '' ? t().noOutput : text) : t().failedWith(text === '' ? t().noOutput : text))
          const rows = layout(body, width, shown, { first: pad('  ⎿  ', shown), rest: pad('     ') })
          out.push(...fold(rows, limit, detail, style))
        }
      }
      return out
    },
  }
  return block
}

/** A turn stopped by the person: under it, as Claude Code marks it. */
export function interruptedBlock(mode: ColorMode): Block {
  return {
    id: nextId('interrupted'),
    version: 0,
    lines: () => { const style = sgr(theme.danger, mode); return [{ spans: [pad('  ⎿  ', style), { text: t().interrupted, style }], soft: false }] },
  }
}

export type NoticeKind = 'info' | 'warn' | 'error' | 'ok'

export function noticeBlock(text: string, kind: NoticeKind, mode: ColorMode): Block {
  const mark = kind === 'error' ? '✕ ' : kind === 'warn' ? '⚠ ' : kind === 'ok' ? '✓ ' : '· '
  return {
    id: nextId('notice'),
    version: 0,
    lines: (width) => {
      const style = sgr(kind === 'error' ? theme.danger : kind === 'warn' ? theme.warn : kind === 'ok' ? theme.ok : theme.muted, mode)
      return layout(text, width, style, { first: pad(mark, style), rest: pad('  ') })
    },
  }
}

/**
 * What the welcome box says, and `room`: the rows the transcript has on this screen with nothing open over
 * the input box.
 */
export interface Welcome { version: string; model: string; workspace: string; session: string; room: number }

/**
 * The top of a conversation: DEEPSEEK BOT in block letters, and under it a box with the name and version, the
 * model, where it works, and the keys to start with. A screen too narrow or too short for the letters gets the
 * box alone, which names the project (a first screen whose letters scroll off its top is worse); one too
 * narrow for a box, the words alone.
 */
export function welcomeBlock(info: () => Welcome, mode: ColorMode): Block & { refresh(): void } {
  const block = {
    id: nextId('welcome'),
    version: 0,
    refresh() { block.version++ },
    lines(width: number): Line[] {
      const border = sgr(theme.border, mode)
      const i = info()
      const words: Array<{ text: string; style: string }> = [
        { text: `deepseek-bot${i.version !== '' ? ` v${i.version}` : ''}`, style: sgr(theme.brand, mode) },
        { text: i.model, style: sgr(theme.text, mode) },
        { text: [i.workspace, i.session !== '' ? `session ${i.session.slice(0, 8)}…` : ''].filter(Boolean).join(' · '), style: sgr(theme.muted, mode) },
        { text: '', style: '' },
        { text: t().welcomeKeys, style: sgr(theme.muted, mode) },
      ]
      // Too narrow for a box: the words alone.
      if (width < 22) return [blank(), ...words.filter((w) => w.text !== '').map((w) => ({ spans: [pad(' '), { text: fit(w.text, Math.max(1, width - 2)), style: w.style }], soft: false }))]
      // The letters where they fit across (indent 1 on both sides) and down: a blank row, the letters, a blank
      // row and the box (the words and two borders) within the transcript's rows.
      const art = width >= BANNER_WIDTHS.two + 2 ? banner(width, mode, 1) : []
      const letters = art.length > 0 && 1 + art.length + 1 + words.length + 2 <= i.room ? [...art, blank()] : []
      // Under one line of letters the box is as wide as they are.
      const box = Math.min(width - 2, letters.length > 0 && width >= BANNER_WIDTHS.one + 2 ? BANNER_WIDTHS.one : 84)
      const room = box - 4
      const content: Line[] = words.map((word) => {
        const said = fit(word.text, room)
        const spans = [pad(' '), pad('│ ', border)]
        if (said !== '') spans.push({ text: said, style: word.style })
        spans.push(pad(' '.repeat(Math.max(0, room - stringWidth(said)))), pad(' │', border))
        return { spans, soft: false }
      })
      return [
        blank(),
        ...letters,
        { spans: [pad(' '), pad(`╭${'─'.repeat(box - 2)}╮`, border)], soft: false },
        ...content,
        { spans: [pad(' '), pad(`╰${'─'.repeat(box - 2)}╯`, border)], soft: false },
      ]
    },
  }
  return block
}

export function spacerBlock(): Block {
  return { id: nextId('spacer'), version: 0, lines: () => [blank()] }
}

function blank(): Line {
  return { spans: [], soft: false }
}
