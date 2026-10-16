/**
 * The screen and what the user does on it.
 *
 * The app knows nothing about sockets or the harness: a backend receives what the user sends,
 * and the backend calls the methods below as the conversation happens. That split is what lets
 * every interaction here — typing, Enter, a drag that copies, the wheel, Esc, a double Ctrl+C —
 * be tested against a fake terminal and a fake backend.
 *
 * Layout, top to bottom: the transcript (under a header only in a subagent's or a shell's view), a
 * divider, the status line, the input box, and a hint line. Nothing frames the whole screen. The input
 * box keeps the last rows; the transcript fills the rows over it from the top, a short one with the empty
 * rows under it, and once it is longer than they are it follows its newest line. A choice (a picker, a
 * question's options, an approval) takes the box's place while nothing is typed; the completion list
 * opens just above the box.
 */
import { answerBlock, interruptedBlock, welcomeBlock, noticeBlock, spacerBlock, thinkingBlock, toolBlock, toolCallBlock, userBlock, type AnswerBlock, type Detail, type NoticeKind, type ThinkingBlock, type ToolCallBlock, type ToolStep } from './blocks.js'
import { complete, type CommandInfo, type Completion } from './complete.js'
import type { AgentItem, JobItem, ViewLine } from './bridge.js'
import { formatTokens, panelCounts, panelRows, panelWindow, rowStatus, type PanelRow } from './panel.js'
import { AMBIGUITY_TARGET, readState, type InterviewState } from './interview.js'
import { QuestionFlow } from './question.js'
import { Picker, type PickerSpec } from './picker.js'
import { t } from './strings.js'
import { wrapPlain } from './render/text.js'
import type { QuestionAnswer, QuestionItem } from '../types/transport.js'
import { copy as systemCopy, type CopyMethod } from './render/clipboard.js'
import { Editor } from './render/editor.js'
import { QUERY_BACKGROUND, type InputEvent, type KeyEvent, type MouseEvent } from './render/input.js'
import type { Screen } from './render/screen.js'
import { backgroundOf, detectColorMode, palette, sgr, theme, useBackground, type ColorMode } from './render/style.js'
import { currentFrame, setFrame, shimmer } from './render/motion.js'
import { Terminal, type TerminalIO } from './render/terminal.js'
import { Transcript, type Block } from './render/transcript.js'
import { fit, graphemes, stringWidth } from './render/width.js'

export interface Backend {
  /** A message, with the id this terminal gave it (so ↑ can take it back while it waits); false when it was not sent. */
  send(text: string, id?: string): boolean | void
  cancel(): void
  /** Ask the gateway to take back the messages waiting here, by their ids; false when it could not be asked.
   * The gateway answers with `withdrawn`, the turn going on. */
  withdraw?(ids: string[]): boolean
  /** A choice the bot offered (an approval button) was picked. */
  action(id: string): void
  /** Look at a subagent or a job (or back at the conversation); the gateway keeps it fresh. */
  view?(kind: 'main' | 'agent' | 'job', id?: string, owner?: string): void
  agentSend?(id: string, text: string): void
  agentInterrupt?(id: string): void
  jobKill?(id: string, owner: string): void
  /** The person's answers to a turn's questions, or null when they dismissed them. */
  answer?(id: string, answers: QuestionAnswer[] | null): void
}

export type View =
  | { kind: 'main' }
  | { kind: 'agent'; id: string; label: string; mode: string }
  | { kind: 'job'; id: string; owner: string; label: string }

export interface Choice {
  /** The message that offered it, so withdrawing the message withdraws the choice. */
  ts: string
  options: Array<{ id: string; label: string; style?: string }>
  index: number
}

export interface AppStatus {
  connected: boolean
  /** What the status line says while not connected. */
  link: string
  workspace: string
  session: string
  model: string
  /** The model's reasoning effort for this conversation, when it has one; shift+tab steps it. */
  effort: string | null
  running: boolean
  startedAt: number
  tokens: number
  /** Tokens sent and received, when the gateway says them apart; the total otherwise. */
  tokensIn: number | null
  tokensOut: number | null
  /** Of the tokens sent, what the provider's cache served, when the harness says. */
  tokensCached: number | null
  contextPct: number | null
}

export interface Clock {
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
}

export interface AppOptions {
  io: TerminalIO
  env: Record<string, string | undefined>
  platform: string
  backend: Backend
  onExit(code: number): void
  clock?: Clock
  copy?: (text: string) => CopyMethod
  /** This client's version, for the welcome box. */
  version?: string
  /** A typed line the app should not send (a /command): return true when it was handled. */
  intercept?: (text: string) => boolean
  /** The /commands to complete, with what they take. */
  commands?: readonly CommandInfo[] | (() => readonly CommandInfo[])
  /** The workspace's files matching a query, for @ completion. */
  files?: (query: string) => string[]
  /** Keep a sent line for the next run's history. */
  remember?: (text: string) => void
  /** shift+tab, or a click on the effort: the conversation's next effort. */
  stepEffort?: () => void
  /** The git branch of a directory, for the footer; null when it is not a repository's work tree. */
  branchOf?: (dir: string) => string | null
}

const EDITOR_MAX_ROWS = 6
/** The rows under the transcript with nothing open: the divider, the status line, a one-line box and the hint. */
const PLAIN_BOTTOM_ROWS = 6
/** A paste of more lines than this is a chip in the box until it is sent. */
const PASTE_CHIP_LINES = 10
const TOAST_MS = 1500
/** A paste larger than this is cut: the core keeps a few thousand characters of a message anyway. */
const MAX_PASTE_CHARS = 200_000
const PANEL_MAX_ROWS = 6
const COMPLETION_MAX_ROWS = 6
const PICKER_MAX_ROWS = 8

/** A choice's "no": the option drawn as dangerous, or one whose id says deny. -1 when it has none. */
function noOption(c: Choice): number {
  return c.options.findIndex((o) => o.style === 'danger' || /(^|:)deny(:|$)/.test(o.id))
}

export class App {
  readonly mode: ColorMode
  readonly transcript = new Transcript()
  readonly editor = new Editor()
  /** How many paste chips are kept: those in the box or in what was sent. */
  get pasteChips(): number {
    return this.pastes.size
  }
  readonly terminal: Terminal
  readonly status: AppStatus = {
    connected: false, link: t().connecting, workspace: '', session: '', model: '', effort: null,
    running: false, startedAt: 0, tokens: 0, tokensIn: null, tokensOut: null, tokensCached: null, contextPct: null,
  }
  private readonly o: AppOptions
  private readonly clock: Clock
  private readonly banner
  /** The screen's rows the welcome block was laid out for: whether its letters fit depends on them. */
  private welcomeRows = 0
  private answer: AnswerBlock | null = null
  private readonly posted = new Map<string, AnswerBlock>()
  /** The last answer block this turn streamed into: where the turn's reply belongs. */
  private turnBlock: AnswerBlock | null = null
  /** An open choice (an approval), in the input box's place while nothing is typed. */
  choice: Choice | null = null
  /** The turn's subagents and background jobs, as the gateway last reported them. */
  private panel: { agents: AgentItem[]; jobs: JobItem[] } = { agents: [], jobs: [] }
  private showIdle = false
  private panelIndex = 0
  private panelTimer: unknown = null
  /** Where keys go: the input box, or the agent panel. */
  focus: 'editor' | 'panel' = 'editor'
  /** What the transcript pane shows: the conversation, or one subagent or job. */
  view: View = { kind: 'main' }
  /** The lines of the subagent or job being looked at. */
  private readonly side = new Transcript()
  /** Questions the turn is waiting on, answered in the input box's place. */
  question: QuestionFlow | null = null
  /** A list a /command opened (/model, /sessions), in the input box's place until a row is picked or it closes. */
  picker: Picker | null = null
  /** A deep interview in progress: its topic and the model's latest report on it. */
  interview: { topic: string; state: InterviewState | null } | null = null
  /** What tool blocks show, folded or all of it; ctrl+o toggles it. */
  readonly detail: Detail = { expanded: false }
  /** Bumped by ctrl+o: a block's own fold counts only if it was set since. */
  private foldGeneration = 0
  /** Each tool block's own fold, turned over by a click on it. */
  private readonly folds = new WeakMap<Block, () => void>()
  /** The same for thinking, apart, as pi has it: ctrl+t. */
  readonly thinkingDetail: Detail = { expanded: false }
  /** The reasoning streaming now, until the answer starts. */
  private thought: ThinkingBlock | null = null
  /** The reasoning of the model call still under way, folded: a retry of that call drops it. */
  private attemptThought: ThinkingBlock | null = null
  /** Tool calls waiting for their result, by call id. */
  private readonly calls = new Map<string, ToolCallBlock>()
  /** The tool running now, for the status line. */
  private runningTool: string | null = null
  /** Turns a stop or a withdraw took back while they waited: their ends are not the start of a next turn. */
  private withdrawing = 0
  /** Whether this turn was marked stopped already. */
  private interrupted = false
  /** Long pastes in the box, by the chip that stands for each. */
  private readonly pastes = new Map<string, string>()
  private pasteCount = 0
  /** Chips that went out in a message: ↑ through what was sent brings them back, so they are kept. */
  private readonly sentChips = new Set<string>()
  /** Messages of this terminal shown as started, lately: the gateway may still have had one waiting. */
  private readonly started = new Map<string, { text: string; blocks: string[] }>()
  /** Text the gateway gave back while the box was not the message box (a question, a search, a view). */
  private takenBack: string[] = []
  /** The ids this terminal asked for back, until the gateway's answer to that ask comes. */
  private asking: string[] | null = null
  /** The message of this terminal shown as the running turn's, and the Interrupted mark esc put under that turn. */
  private turnMessage: string | null = null
  private mark: string | null = null
  /** The keys on show (? on an empty box), in the input box's place. */
  private shortcuts = false
  /** Messages sent while a turn runs: shown above the input until their turn starts. */
  private pending: Array<{ text: string; id: string }> = []
  /** For the ids of the messages this terminal sends: unique among the terminals on a conversation. */
  private readonly idTag = Math.random().toString(36).slice(2, 10)
  private sentCount = 0
  /** Words the core answers at once, without a turn: the stop words, and the others (the usage word). */
  private stopWords: string[] = []
  private instantWords: string[] = []
  /** The transcript ends in a blank line: the next step needs none of its own. */
  private gapped = true
  /** Candidates for what is being typed (/commands, @files), and the one picked. */
  completion: (Completion & { index: number; text: string }) | null = null
  /** The text Esc closed the list at: it stays closed until the text changes. */
  private dismissed: string | null = null
  /** A Ctrl+R search: what is typed, how many older matches to skip, and the text it replaced. */
  private search: { query: string; skip: number; original: string; found: boolean } | null = null
  private toast: { text: string; until: number } | null = null
  /** The workspace's git branch, for the footer. */
  private branch: string | null = null
  private quitArmed = 0
  private spinTimer: unknown = null
  /** Turns the conversation has running or waiting: each sends typing on, then off. */
  private busy = 0
  private dragging = false
  /** The row of the drag's last report: the top row scrolls only when the drag comes into it. */
  private dragRow = -1
  /** The input box's first visible row: kept until the cursor leaves the rows shown. */
  private editorScroll = 0
  /** Rows of the last frame, for mapping mouse coordinates. */
  private geometry = {
    transcriptTop: 1, transcriptHeight: 0, dividerRow: 0, editorTop: 0, choiceRow: -1, choiceSpans: [] as Array<{ from: number; to: number }>,
    panelTop: -1, panelFirst: 0, panelShown: 0, questionTop: -1, questionRowsAt: -1,
    /** What each picker line is: a row's index, -2 its effort, -1 anything else. */
    pickerTop: -1, pickerMap: [] as number[],
    completionTop: -1, completionFirst: 0, completionShown: 0,
    /** The row the held prompt covers, or -1. */
    heldRow: -1,
    editorRows: 0, editorFirst: 0, statusRow: -1, effortSpan: null as { from: number; to: number } | null,
  }

  constructor(options: AppOptions) {
    this.o = options
    this.mode = detectColorMode(options.env)
    // The palette is the module's: each app sets it, from COLORFGBG at first and the terminal's own answer after.
    useBackground(backgroundOf(options.env) ?? 'dark')
    this.clock = options.clock ?? {
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    }
    this.terminal = new Terminal({
      io: options.io,
      render: (screen) => this.render(screen),
      onEvent: (event) => this.onEvent(event),
      ...(options.clock ? { now: options.clock.now, setTimer: options.clock.setTimer, clearTimer: options.clock.clearTimer } : {}),
    })
    this.banner = welcomeBlock(() => ({ version: this.o.version ?? '', model: this.status.model, workspace: this.shownWorkspace(), session: this.status.session ?? '', room: this.welcomeRows - PLAIN_BOTTOM_ROWS }), this.mode)
    this.transcript.push(this.banner)
    // A paste chip is one thing to the cursor and to deleting.
    this.editor.atoms = () => [...this.pastes.keys()]
  }

  start(): void {
    this.terminal.start()
    // Ask the terminal what its background is; one that knows answers, and a light one gets the light palette.
    if (this.mode !== 'none') this.o.io.write(QUERY_BACKGROUND)
  }

  stop(code = 0): void {
    this.stopSpinner()
    if (this.panelTimer !== null) { this.clock.clearTimer(this.panelTimer); this.panelTimer = null }
    this.terminal.restore()
    this.o.onExit(code)
  }

  // ── Called by the backend ───────────────────────────────────────────────

  setStatus(patch: Partial<AppStatus>): void {
    Object.assign(this.status, patch)
    // Read when the workspace is named: the footer says the branch the agent's work tree is on.
    if ('workspace' in patch) this.branch = this.status.workspace === '' ? null : this.o.branchOf?.(this.status.workspace) ?? null
    if ('workspace' in patch || 'session' in patch || 'model' in patch) { this.banner.refresh(); this.transcript.touch() }
    this.terminal.requestRender()
  }

  turnStarted(): void {
    // A message queued behind a running turn also says "typing": count them, so the first turn's
    // end does not hide the second.
    if (this.busy++ === 0) {
      this.turnBlock = null
      this.interrupted = false
      this.mark = null
      this.status.running = true
      this.status.startedAt = this.clock.now()
      this.startSpinner()
    }
    this.terminal.requestRender()
  }

  /** An effort step (shift+tab) the gateway took: while a turn runs the effort is not on the status line, so it says itself. */
  effortStepped(effort: string | null): void {
    if (this.status.running && effort !== null && effort !== '') this.showToast(t().effortNext(effort))
  }

  /**
   * What the gateway says when this terminal (re)connects: how many turns are running or waiting
   * here, each of which will still send its typing-off.
   */
  setBusy(count: number): void {
    // A frame without the count (or a bad one) says nothing runs, never NaN turns. Turns a stop withdrew
    // before the link dropped are in the count or gone: none is still to be told apart.
    this.withdrawing = 0
    const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0
    if (n === 0) { if (this.busy > 0) { this.busy = 1; this.turnEnded() } return }
    if (this.busy === 0) this.turnStarted()
    this.busy = n
  }

  /** Streamed answer text. The block is created on the first delta. */
  delta(text: string): void {
    this.closeThinking()
    // The answer is being written: whatever tool ran before has done its part.
    this.runningTool = null
    if (this.answer === null) { this.answer = answerBlock(this.mode); this.step(this.answer); this.turnBlock = this.answer }
    this.answer.append(text)
    this.noteInterview(this.answer.text)
    this.transcript.touch()
    this.terminal.requestRender()
  }

  /** The current attempt failed and is being retried: drop what it streamed, thinking included. */
  resetAttempt(): void {
    if (this.answer === null && this.thought === null && this.attemptThought === null) return
    this.answer?.reset()
    this.thought?.reset()
    this.attemptThought?.reset()
    this.attemptThought = null
    this.transcript.touch()
    this.terminal.requestRender()
  }

  /** Streamed reasoning, shown apart from the answer. */
  thinking(text: string): void {
    if (this.thought === null) {
      this.closeAnswer()
      this.thought = thinkingBlock(this.thinkingDetail, this.mode, () => this.clock.now())
      this.step(this.thought)
    }
    this.thought.append(text)
    this.transcript.touch()
    this.terminal.requestRender()
  }

  private closeThinking(): void {
    if (this.thought === null) return
    this.thought.done()
    this.attemptThought = this.thought
    this.thought = null
    this.transcript.touch()
  }

  /** A tool call: its card, which its result (by call id) is added to later. */
  toolCall(step: ToolStep): void {
    this.closeThinking()
    // A tool call means the model call that asked for it went through: its thinking stays.
    this.attemptThought = null
    this.closeAnswer()
    // Its own fold, which a click turns over; ctrl+o sets every block's again.
    const own = { expanded: false, at: -1 }
    const app = this
    const detail: Detail = {
      get expanded() { return own.at === app.foldGeneration ? own.expanded : app.detail.expanded },
    }
    const block = toolCallBlock(step, detail, this.mode)
    this.folds.set(block, () => { own.expanded = !detail.expanded; own.at = app.foldGeneration })
    this.runningTool = step.name
    this.step(block)
    if (step.callId !== undefined) {
      this.calls.set(step.callId, block)
      // A result that never comes (a cancelled turn) must not keep its call forever.
      if (this.calls.size > 200) this.calls.delete(this.calls.keys().next().value!)
    }
    this.terminal.requestRender()
  }

  toolResult(callId: string, ok: boolean, text: string, lines?: number): void {
    const block = this.calls.get(callId)
    if (block === undefined) return
    this.calls.delete(callId)
    if (this.calls.size === 0) this.runningTool = null
    block.result(ok, text, lines)
    this.transcript.touch()
    this.terminal.requestRender()
  }

  /** The turn's final text. Replaces the streamed text when there was any. */
  final(text: string): void {
    if (this.answer !== null) this.answer.finish(text)
    else if (text !== '') { const block = answerBlock(this.mode); block.finish(text); this.step(block) }
    this.answer = null
    this.transcript.touch()
    this.terminal.requestRender()
  }

  turnEnded(): void {
    this.closeThinking()
    this.attemptThought = null
    this.closeAnswer()
    this.choice = null   // whatever it asked belonged to the turn
    // A call with no result by now never gets one: it stops blinking.
    for (const call of this.calls.values()) call.settle()
    this.calls.clear()
    this.runningTool = null
    this.busy = Math.max(0, this.busy - 1)
    if (this.busy === 0) {
      this.status.running = false
      this.stopSpinner()
      // Nothing runs: what is still shown above the input goes into the transcript, as started. One may still be
      // waiting for its typing to begin (the turn that runs it), and a stop name it; the first is that turn's.
      const moved = this.pending.splice(0)
      for (const waiting of moved) this.startedHere(waiting.id, waiting.text)
      if (moved.length > 0) this.turnMessage = moved[0].id
      this.withdrawing = 0
    } else if (this.withdrawing > 0) {
      // A waiting turn a stop or a withdraw took back ended: the turn running is still the same one.
      this.withdrawing--
    } else {
      // The next turn starts now (this terminal's waiting message, or one another terminal sent): its time and
      // its stop mark are its own, apart from the one that ended.
      this.interrupted = false
      this.mark = null
      this.status.startedAt = this.clock.now()
      const next = this.pending.shift()
      this.turnMessage = next?.id ?? null
      if (next !== undefined) this.startedHere(next.id, next.text)
    }
    this.transcript.touch()
    this.terminal.requestRender()
  }

  notice(text: string, kind: NoticeKind = 'info'): void {
    this.transcript.push(noticeBlock(text, kind, this.mode))
    this.gapped = false
    this.terminal.requestRender()
  }

  /**
   * A message the bot posted, by id. An edit (`replace`) rewrites it in place. The turn's reply
   * (`answer`) takes the place of the text this turn streamed, so it is never shown twice — and
   * nothing else may: an approval request mid-turn is a message of its own.
   */
  message(ts: string, text: string, replace: string | null, answer = false): void {
    this.noteInterview(text)
    const known = this.posted.get(replace ?? ts)
    const streamed = this.answer ?? this.turnBlock
    if (known !== undefined) {
      known.finish(text)
    } else if (answer && streamed !== null) {
      streamed.finish(text)
      this.remember(ts, streamed)
      this.answer = null
      this.turnBlock = null
    } else {
      const block = answerBlock(this.mode)
      block.finish(text)
      this.remember(ts, block)
      this.step(block)
    }
    this.transcript.touch()
    this.terminal.requestRender()
  }

  /** Begin a deep interview: the strip above the pane follows the model's reports from here. */
  startInterview(topic: string): void {
    this.interview = { topic, state: null }
    this.terminal.requestRender(true)
  }

  /** Send a message shown as `display` (a command's short form) rather than as its full text. */
  sendAs(display: string, text: string): void {
    const id = this.messageId()
    if (this.o.backend.send(text, id) === false) return
    this.said(display, id)
  }

  private messageId(): string {
    return `${this.idTag}-${++this.sentCount}`
  }

  /**
   * The gateway withdrew these waiting messages (sent to every terminal on the conversation, before their
   * typing stops): each one's end is not a next turn's start, and those this terminal sent go back to the box.
   */
  withdrawn(ids: string[], asked: string[] = [], stop = false): void {
    // A stop's answer is the exact count of what is still to end: every earlier answer's ends came right
    // behind it. It replaces the guess the terminal that stopped made at esc; elsewhere it adds to nothing.
    this.withdrawing = stop ? ids.length : this.withdrawing + ids.length
    // One shown as started (its typing-off was read before this answer, or it was sent while idle) was still
    // waiting there: it leaves the transcript, with the Interrupted mark esc put under it. Then the ones still
    // queued here.
    const back: string[] = []
    for (const id of ids) {
      const shown = this.started.get(id)
      if (shown === undefined) continue
      this.started.delete(id)
      for (const block of shown.blocks) this.transcript.remove(block)
      // The mark goes too only when nothing else ran: a stop that also stopped a running turn keeps it.
      if (id === this.turnMessage && this.mark !== null && this.busy === ids.length) { this.transcript.remove(this.mark); this.mark = null }
      back.push(shown.text)
    }
    const mine = this.pending.filter((p) => ids.includes(p.id))
    this.pending = this.pending.filter((p) => !ids.includes(p.id))
    back.push(...mine.map((p) => p.text))
    // The answer to this terminal's own ask (another terminal's may come first): nothing back says so, unless
    // another answer (a stop's) already gave those back.
    const ownAnswer = this.asking !== null && asked.some((id) => this.asking!.includes(id))
    if (this.asking !== null) this.asking = this.asking.filter((id) => !ids.includes(id))
    if (ownAnswer) {
      if (back.length === 0 && this.asking!.length > 0) this.showToast(t().nothingTakenBack)
      this.asking = null
    } else if (this.asking !== null && this.asking.length === 0) this.asking = null
    this.takenBack.push(...back)
    this.restoreTakenBack()
    this.terminal.requestRender(true)
  }

  /** Text the gateway gave back goes to the box once it is the message box again. */
  private restoreTakenBack(): void {
    if (this.takenBack.length === 0 || this.view.kind !== 'main' || this.question !== null || this.search !== null || this.picker !== null || this.choice !== null) return
    this.backToBox(this.takenBack.splice(0))
  }

  /** Messages back in the box, after what is typed there. */
  private backToBox(texts: string[]): void {
    const back = texts.join('\n')
    this.editor.set(this.editor.text === '' ? back : `${this.editor.text}\n${back}`)
  }

  /**
   * What the person said, into the transcript — or, while a turn runs, above the input: the gateway
   * answers it after the running turn, and it joins the transcript when its turn starts.
   */
  private said(text: string, id: string): void {
    if (this.status.running) {
      const atOnce = this.answeredAtOnce(text)
      if (atOnce === null) { this.pending.push({ text, id }); this.terminal.requestRender(true); return }
      // A stop withdraws what waits, in the gateway: it comes back to the box, as with esc.
      if (atOnce === 'stop') this.withdrawing = Math.max(0, this.busy - 1)
      if (atOnce === 'stop' && this.pending.length > 0) this.backToBox(this.pending.splice(0).map((p) => p.text))
      this.shown(text)
      if (atOnce === 'stop') this.markInterrupted()
      return
    }
    // Shown at once, as the turn it starts; the gateway may still have it waiting for a slot. A word answered at
    // once (a stop, usage) starts no turn.
    if (this.answeredAtOnce(text) !== null) { this.shown(text); return }
    this.startedHere(id, text)
    this.turnMessage = id
  }

  /** A message of this terminal shown as started, kept a while: a stop or an ↑ may name it still waiting. */
  private startedHere(id: string, text: string): void {
    this.started.set(id, { text, blocks: this.shown(text) })
    if (this.started.size > 8) this.started.delete(this.started.keys().next().value!)
  }

  /** What the gateway says it answers at once, without a turn. */
  setAnsweredAtOnce(stop: string[], instant: string[]): void {
    this.stopWords = stop.map((w) => w.toLowerCase())
    this.instantWords = instant.map((w) => w.toLowerCase())
  }

  /**
   * A word the core answers at once, matched as the core matches it: the whole message, any case, trailing
   * punctuation aside. Queued, it waited above the input as the next turn's message.
   */
  private answeredAtOnce(text: string): 'stop' | 'instant' | null {
    const said = text.trim().toLowerCase().replace(/[.!?~,\s。！？，～、]+$/u, '')
    if (said === '') return null
    return this.stopWords.includes(said) ? 'stop' : this.instantWords.includes(said) ? 'instant' : null
  }

  private shown(text: string): string[] {
    const said = userBlock(text, this.mode)
    const gap = spacerBlock()   // one blank line between a question and what answers it
    this.transcript.push(said)
    this.transcript.push(gap)
    this.gapped = true
    this.transcript.toBottom()
    return [said.id, gap.id]
  }

  /** A turn's step — thinking, a tool call, the answer — with one blank line before it. */
  private step(block: Block): void {
    if (!this.gapped) this.transcript.push(spacerBlock())
    this.transcript.push(block)
    this.gapped = false
  }

  private noteInterview(text: string): void {
    if (this.interview === null) return
    const state = readState(text)
    if (state !== null) this.interview.state = state
  }

  /** The turn asks the person something: open the question panel (a plan review shows the plan first). */
  ask(id: string, items: QuestionItem[]): void {
    for (const item of items) {
      if (item.intent?.kind === 'plan-review' && typeof item.detail === 'string') {
        this.transcript.push(noticeBlock(t().planReviewRequested, 'warn', this.mode))
        const plan = answerBlock(this.mode)
        plan.finish(item.detail)
        this.transcript.push(plan)
      }
    }
    // The keys now belong to the question: a history search gives back what was typed (its match
    // must never be sent as the answer), and a completion list closes.
    if (this.search !== null) { this.editor.set(this.search.original); this.search = null }
    this.completion = null
    this.picker = null   // the turn's question comes first; the /command can be run again
    this.shortcuts = false
    this.question = new QuestionFlow(id, items)
    this.transcript.toBottom()
    this.terminal.requestRender(true)
  }

  /** The question went away without us (the turn stopped, or it was answered elsewhere). */
  closeQuestion(id: string): void {
    if (this.question?.id !== id) return
    this.question = null
    // The keys are the input box's again: a command still typed there gets its list back.
    this.refreshCompletion()
    this.notice(t().questionClosed, 'info')
  }

  /** A /command's list, in the input box's place: the keys are its until a row is picked or it closes. */
  openPicker(spec: PickerSpec): void {
    if (this.question !== null) return
    if (this.search !== null) { this.editor.set(this.search.original); this.search = null }
    this.completion = null
    this.focus = 'editor'
    this.shortcuts = false
    this.picker = new Picker(spec)
    this.terminal.requestRender(true)
  }

  /** Close the picker; with a spec, only when it is the one open. */
  closePicker(spec?: PickerSpec): void {
    if (this.picker === null || (spec !== undefined && this.picker.spec !== spec)) return
    this.picker = null
    this.refreshCompletion()
    this.terminal.requestRender(true)
  }

  /** Closed first, so what the pick does (another picker, another conversation) starts from a clear box. */
  private choosePicker(): void {
    const p = this.picker
    // Nothing matches what was typed: nothing to pick, and the list stays for the filter to change.
    if (p === null || p.position === 0) return
    this.closePicker()
    p.pick()
  }

  /** After each answer: record it, and send the batch when the last one is in. */
  private answered(): void {
    const q = this.question
    if (q === null) return
    const item = q.items[q.answers.length - 1]
    const answer = q.answers[q.answers.length - 1]
    if (item !== undefined && answer !== undefined) this.notice(`? ${item.question} → ${q.describe(answer)}`, 'info')
    if (q.done) {
      this.question = null
      this.o.backend.answer?.(q.id, q.answers)
      this.refreshCompletion()
    }
    this.terminal.requestRender(true)
  }

  /**
   * A fresh screen, the welcome box and nothing else: for another conversation, or (`sameConversation`, /clear)
   * for this one, whose turn goes on: what runs and waits, an approval, what the gateway gave back to the box.
   * A switch the gateway refused (cli.ts rolledBack) had already cleared for another conversation.
   */
  clear(sameConversation = false): void {
    // What was being drawn goes with the screen: the next words start blocks of their own.
    this.thought = null
    this.attemptThought = null
    this.closeAnswer()
    this.turnBlock = null
    this.mark = null
    this.picker = null
    this.gapped = true
    // (/clear keeps `posted`: an edit of a message posted before it lands on a block no longer on screen. The
    // terminal's messages are not edited today: it has its own typing sign, so no working message is posted.)
    // Another conversation: whatever was running belongs to the old one, and so does what it gave back.
    if (!sameConversation) {
      this.interview = null
      this.calls.clear()
      this.takenBack = []
      this.asking = null
      this.started.clear()
      this.turnMessage = null
      this.busy = 0
      this.status.running = false
      this.stopSpinner()
      this.question = null
      this.posted.clear()
      // Nothing of the old conversation's turn: what waited behind it, its running tool.
      this.pending = []
      this.runningTool = null
      this.choice = null
    }
    this.transcript.clear()
    this.transcript.push(this.banner)
    this.terminal.requestRender(true)
  }

  /** Earlier messages of a resumed conversation, as they were said. */
  history(items: Array<{ role: 'user' | 'assistant'; text: string }>): void {
    if (items.length === 0) return
    this.notice(t().earlier(items.length), 'info')
    for (const item of items) {
      if (item.role === 'user') this.shown(item.text)
      else { const block = answerBlock(this.mode); block.finish(item.text); this.transcript.push(block) }
    }
    this.notice(t().continuedHere, 'info')
    this.terminal.requestRender()
  }

  /** Buttons on a message: shown as a choice in the input box's place until picked or withdrawn. */
  offer(ts: string, options: Choice['options']): void {
    this.choice = options.length === 0 ? null : { ts, options, index: 0 }
    // Its keys are the input's: the panel gives them back, and the shortcuts close.
    if (this.choice !== null) { this.focus = 'editor'; this.shortcuts = false }
    this.terminal.requestRender(true)
  }

  /** The bot withdrew a message — a working message the answer took the place of. */
  unpost(ts: string): void {
    if (this.choice?.ts === ts) this.choice = null
    const block = this.posted.get(ts)
    if (block === undefined) return
    this.posted.delete(ts)
    this.transcript.remove(block.id)
    this.terminal.requestRender()
  }

  /** Only recent messages are ever edited; older ids are forgotten so the map stays small. */
  private remember(ts: string, block: AnswerBlock): void {
    this.posted.set(ts, block)
    if (this.posted.size > 200) this.posted.delete(this.posted.keys().next().value as string)
  }

  // ── The agent panel and the views ───────────────────────────────────────

  /** The transcript on screen: the conversation, or the subagent or job being looked at. */
  private get pane(): Transcript {
    return this.view.kind === 'main' ? this.transcript : this.side
  }

  private rows(): PanelRow[] {
    return panelRows(this.panel.agents, this.panel.jobs, this.showIdle)
  }

  /** The gateway's latest picture of the turn's subagents and jobs. */
  setPanel(agents: AgentItem[], jobs: JobItem[]): void {
    this.panel = { agents, jobs }
    const rows = this.rows()
    if (rows.length === 0 && this.focus === 'panel') this.focus = 'editor'
    this.panelIndex = Math.max(0, Math.min(this.panelIndex, rows.length - 1))
    // Elapsed times move by themselves while anything runs.
    const busy = agents.some((a) => a.status === 'running') || jobs.some((j) => j.status === 'running')
    if (busy && this.panelTimer === null) {
      const tick = () => { this.panelTimer = null; if (this.rows().length === 0) return; this.terminal.requestRender(); this.panelTimer = this.clock.setTimer(tick, 1000) }
      this.panelTimer = this.clock.setTimer(tick, 1000)
    } else if (!busy && this.panelTimer !== null) {
      this.clock.clearTimer(this.panelTimer); this.panelTimer = null
    }
    this.terminal.requestRender()
  }

  /** A subagent's conversation, refreshed by the gateway while it is looked at. */
  agentLines(id: string, lines: ViewLine[]): void {
    if (this.view.kind !== 'agent' || this.view.id !== id) return
    this.side.clear()
    this.side.push(noticeBlock(`subagent · ${this.view.label} · ${this.view.mode}`, 'info', this.mode))
    for (const line of lines) {
      if (line.role === 'user') { this.side.push(userBlock(line.text, this.mode)); this.side.push(spacerBlock()) }
      else if (line.role === 'tool') this.side.push(toolBlock(line.text, '', this.mode))
      else { const block = answerBlock(this.mode); block.finish(line.text); this.side.push(block) }
    }
    this.terminal.requestRender()
  }

  /** A job's output: the first read, then what was added. */
  jobOutput(id: string, text: string, append: boolean, status: string): void {
    if (this.view.kind !== 'job' || this.view.id !== id) return
    if (!append) { this.side.clear(); this.side.push(noticeBlock(`shell · ${this.view.id} · ${this.view.label}`, 'info', this.mode)) }
    if (text !== '') { const block = answerBlock(this.mode); block.finish(text.replace(/\n$/, '')); this.side.push(block) }
    if (status === 'removed') this.side.push(noticeBlock(t().jobRemoved, 'warn', this.mode))
    else if (status !== 'running' && status !== 'stopping') this.side.push(noticeBlock(t().jobEnded(status), status === 'completed' ? 'ok' : 'warn', this.mode))
    this.terminal.requestRender()
  }

  private open(row: PanelRow): void {
    if (row.kind === 'main') { this.backToMain(); return }
    if (row.kind === 'idle') { this.showIdle = true; this.terminal.requestRender(true); return }
    if (row.kind === 'more') { this.panelIndex = Math.min(this.rows().length - 1, this.panelIndex + 1); this.terminal.requestRender(true); return }
    this.side.clear()
    if (row.kind === 'agent') {
      this.view = { kind: 'agent', id: row.agent.id, label: row.agent.label, mode: row.agent.mode }
      this.side.push(noticeBlock(`subagent · ${row.agent.label} · ${t().loading}`, 'info', this.mode))
      this.o.backend.view?.('agent', row.agent.id)
    } else {
      this.view = { kind: 'job', id: row.job.id, owner: row.job.owner, label: row.job.label }
      this.side.push(noticeBlock(`shell · ${row.job.id} · ${t().loading}`, 'info', this.mode))
      this.o.backend.view?.('job', row.job.id, row.job.owner)
    }
    this.focus = 'editor'
    this.terminal.requestRender(true)
  }

  private backToMain(): void {
    if (this.view.kind !== 'main') { this.view = { kind: 'main' }; this.o.backend.view?.('main') }
    this.side.clear()
    this.focus = 'editor'
    this.terminal.requestRender(true)
  }

  // ── Input ───────────────────────────────────────────────────────────────

  private onEvent(event: InputEvent): void {
    if (event.type === 'background') {
      useBackground(event.background)
      this.terminal.invalidate()
      this.terminal.requestRender(true)
      return
    }
    if (event.type === 'paste') {
      this.clearSelection()
      // A terminal may send a pasted line break as CR: one kind of break, before anything is counted or kept.
      const cut = event.text.length > MAX_PASTE_CHARS
      const text = (cut ? event.text.slice(0, MAX_PASTE_CHARS) : event.text).replace(/\r\n?/g, '\n')
      if (cut) this.showToast(t().pasteCut(MAX_PASTE_CHARS.toLocaleString('en-US')))
      // Over a list with nothing typed, a paste is typed into its filter, as keys are.
      if (this.picker !== null && this.question === null && this.editor.text === '') { this.picker.type(text.replace(/\s+/g, ' ')); this.terminal.requestRender(true); return }
      this.search = null
      this.shortcuts = false
      // Pasted into an open question, as typed into it: the person's own words.
      if (this.question !== null && !this.question.typing) { this.question.cursor = this.question.rows().length - 1; this.question.typing = true }
      // A long paste is a chip in the box, as pi shows it, and the text again when it is sent.
      // A final newline ends the last line; it is not another.
      const lines = text.replace(/\n$/, '').split('\n').length
      if (lines > PASTE_CHIP_LINES) {
        const chip = t().pasteChip(++this.pasteCount, lines)
        this.pastes.set(chip, text)
        this.editor.insert(chip)
      } else this.editor.insert(text)
      this.refreshCompletion()
      this.terminal.requestRender(true)
      return
    }
    if (event.type === 'mouse') { this.onMouse(event); return }
    this.onKey(event)
  }

  private onKey(key: KeyEvent): void {
    const width = this.editorWidth()
    if (!(key.ctrl && key.name === 'char' && key.ch === 'c')) this.quitArmed = 0
    if (key.name !== 'escape') this.clearSelection()
    // A question or a picker over a choice has the keys: what falls through from it is text, never the choice's answer.
    const overChoice = this.question !== null || this.picker !== null

    // The shortcuts, opened with ? on an empty box: esc or ? closes them; any other key closes them and does its own thing.
    if (this.shortcuts) {
      this.shortcuts = false
      this.terminal.requestRender(true)
      if (key.name === 'escape' || (key.name === 'char' && key.ch === '?' && !key.ctrl && !key.alt)) return
    } else if (key.name === 'char' && key.ch === '?' && !key.ctrl && !key.alt && this.editor.text === '' && this.view.kind === 'main' && this.focus === 'editor'
      && this.question === null && this.picker === null && this.choice === null && this.search === null && this.completion === null) {
      this.shortcuts = true
      this.terminal.requestRender(true)
      return
    }
    if (this.question !== null && this.onQuestionKey(key)) return
    if (this.picker !== null && this.onPickerKey(key)) return
    if (this.focus === 'panel' && this.onPanelKey(key)) return
    if (this.search !== null && this.onSearchKey(key)) return
    // A list is for the text it was made from: anything that changed the box since (Ctrl+C, a
    // command that set it) leaves it stale, and Tab or Enter must not act on a stale one.
    if (this.completion !== null && this.completion.text !== this.editor.text) this.refreshCompletion()
    if (key.ctrl && key.name === 'char' && key.ch === 'r' && this.view.kind === 'main' && this.question === null && this.picker === null) { this.startSearch(); return }
    if (this.completion !== null && this.onCompletionKey(key)) return
    if (key.ctrl && key.name === 'char') {
      switch (key.ch) {
        case 'c': return this.ctrlC()
        case 'x':
          if (this.view.kind === 'agent') { this.o.backend.agentInterrupt?.(this.view.id); this.showToast(t().askedToStop(this.view.label)) }
          else if (this.view.kind === 'job') { this.o.backend.jobKill?.(this.view.id, this.view.owner); this.showToast(t().askedToEnd(this.view.id)) }
          return
        case 'd': if (this.editor.text === '') { this.stop(0); return } break
        case 'a': this.editor.home(); break
        case 'e': this.editor.end(); break
        case 'u': this.editor.killLine(); break
        case 'k': this.editor.killToEnd(); break
        case 'w': this.editor.killWord(); break
        case 'l': this.terminal.invalidate(); break
        case 'j': this.editor.insert('\n'); break
        case 'o': this.transcript.refold(this.o.io.columns(), () => { this.detail.expanded = !this.detail.expanded; this.foldGeneration++ }); break
        case 't': this.transcript.refold(this.o.io.columns(), () => { this.thinkingDetail.expanded = !this.thinkingDetail.expanded }); break
        default: return
      }
      this.refreshCompletion()
      this.terminal.requestRender(true)
      return
    }
    // With an open choice and nothing typed, the arrows, a digit and Enter answer it, and esc answers no — once
    // there is no selection for esc to clear.
    if (this.choice !== null && this.editor.text === '' && !overChoice && !key.alt && !key.ctrl) {
      const c = this.choice
      const digit = key.name === 'char' && /^[1-9]$/.test(key.ch ?? '') ? Number(key.ch) - 1 : -1
      const no = noOption(c)
      if (digit >= 0 && digit < c.options.length) { this.pick(digit); this.terminal.requestRender(true); return }
      if (key.name === 'escape' && no !== -1 && this.pane.selection === null) { this.pick(no); this.terminal.requestRender(true); return }
      if (['left', 'right', 'up', 'down', 'tab', 'enter'].includes(key.name)) {
        if (key.name === 'enter') this.pick(c.index)
        else c.index = (c.index + (key.name === 'left' || key.name === 'up' || (key.name === 'tab' && key.shift) ? c.options.length - 1 : 1)) % c.options.length
        this.terminal.requestRender(true)
        return
      }
    }
    switch (key.name) {
      case 'enter':
        if (key.alt || key.shift) this.editor.insert('\n')
        // A backslash before Enter is a new line, as in Claude Code.
        else if (this.editor.before === '\\') { this.editor.backspace(); this.editor.insert('\n') }
        else this.submit()
        break
      case 'escape':
        if (this.pane.selection !== null) this.clearSelection()
        else if (this.view.kind !== 'main') this.backToMain()
        else if (this.status.running) this.cancel()
        break
      case 'backspace': if (key.alt || key.ctrl) this.editor.killWord(); else this.editor.backspace(); break
      case 'delete': this.editor.del(); break
      case 'left': this.editor.left(); break
      case 'right': this.editor.right(); break
      // With ctrl, the transcript's top and bottom (the bottom follows again); without, the text's.
      case 'home': if (key.ctrl) this.pane.toTop(); else this.editor.home(); break
      case 'end': if (key.ctrl) this.pane.toBottom(); else this.editor.end(); break
      case 'up':
        // The messages waiting here come back to an empty box once the gateway has withdrawn them (withdrawn);
        // the turn goes on. Not while a question, a list or a choice has the keys.
        if (this.editor.text === '' && this.pending.length > 0 && this.view.kind === 'main' && this.question === null && this.picker === null && this.choice === null) {
          if (this.o.backend.withdraw?.(this.pending.map((p) => p.id)) !== true) this.notice(t().notSent, 'error')
          else this.asking = this.pending.map((p) => p.id)
          break
        }
        this.editor.up(width)
        break
      case 'down': this.editor.down(width); break
      // Half a screen, as Claude Code's fullscreen goes: what was at the edge stays in view.
      case 'pageup': this.pane.scroll(-Math.max(1, Math.floor(this.geometry.transcriptHeight / 2))); break
      case 'pagedown': this.pane.scroll(Math.max(1, Math.floor(this.geometry.transcriptHeight / 2))); break
      case 'tab':
        // shift+tab steps the effort, as it cycles the mode in Claude Code; tab goes to the panel.
        if (key.shift) { this.o.stepEffort?.(); break }
        if (this.rows().length > 0) this.focus = 'panel'
        break
      case 'char': this.editor.insert(key.ch ?? ''); break
      default: return
    }
    this.refreshCompletion()
    // Typing is drawn on the keystroke, not on the next frame tick.
    this.terminal.requestRender(true)
  }

  // ── Completion and history search ──────────────────────────────────────

  /** Look again at what is typed: a /command or an @file being written gets its candidates. */
  private refreshCompletion(): void {
    if (this.dismissed !== null && this.dismissed !== this.editor.text) this.dismissed = null
    // Not for an earlier entry being walked through: its list would take the arrows that walk on.
    const usable = this.view.kind === 'main' && this.question === null && this.picker === null && this.search === null && this.dismissed === null && !this.editor.browsingHistory
    const found = usable ? complete(this.editor.text, this.editor.cursor, typeof this.o.commands === 'function' ? this.o.commands() : this.o.commands ?? [], this.o.files) : null
    if (found === null) { this.completion = null; return }
    const same = this.completion !== null && this.completion.items.map((i) => i.label).join('\n') === found.items.map((i) => i.label).join('\n')
    this.completion = { ...found, index: same ? this.completion!.index : 0, text: this.editor.text }
  }

  /** Keys while the list is open. Returns false for keys the input box should get instead. */
  private onCompletionKey(key: KeyEvent): boolean {
    const c = this.completion!
    switch (key.name) {
      case 'up': c.index = (c.index + c.items.length - 1) % c.items.length; break
      case 'down': c.index = (c.index + 1) % c.items.length; break
      case 'tab':
        if (key.shift) return false   // the effort's, not the list's
        this.acceptCompletion(false)
        return true
      case 'enter':
        if (key.alt || key.shift) return false
        this.acceptCompletion(true)
        return true
      case 'escape': this.dismissed = this.editor.text; this.completion = null; break
      default: return false
    }
    this.terminal.requestRender(true)
    return true
  }

  /** Put the picked candidate in; Enter on a command that takes nothing runs it. */
  private acceptCompletion(enter: boolean): void {
    const c = this.completion!
    const item = c.items[c.index]
    this.completion = null
    if (enter && item.run) {
      this.editor.set(item.insert.trimEnd())
      this.submit()
    } else this.editor.replace(c.from, c.to, item.insert)
    this.refreshCompletion()
    this.terminal.requestRender(true)
  }

  private startSearch(): void {
    this.completion = null
    this.search = { query: '', skip: 0, original: this.editor.text, found: false }
    this.showSearchMatch()
  }

  /** The newest entry with the query in it (skipping as many older ones as Ctrl+R asked), shown in the box. */
  private showSearchMatch(): void {
    const s = this.search!
    const query = s.query.toLowerCase()
    const matches: string[] = []
    const past = this.editor.past
    for (let i = past.length - 1; i >= 0; i--) {
      if (past[i].toLowerCase().includes(query) && !matches.includes(past[i])) matches.push(past[i])
    }
    s.found = matches.length > 0
    s.skip = Math.min(s.skip, Math.max(0, matches.length - 1))
    this.editor.set(s.found ? matches[s.skip] : s.original)
    this.terminal.requestRender(true)
  }

  /** Keys while searching. Returns false for keys that end the search and then do what they do. */
  private onSearchKey(key: KeyEvent): boolean {
    const s = this.search!
    if (key.ctrl && key.name === 'char' && key.ch === 'r') { s.skip++; this.showSearchMatch(); return true }
    const cancel = key.name === 'escape' || (key.ctrl && key.name === 'char' && (key.ch === 'g' || key.ch === 'c'))
    if (cancel) { this.editor.set(s.original); this.search = null; this.terminal.requestRender(true); return true }
    if (key.name === 'enter' && !key.alt && !key.shift) { this.search = null; this.terminal.requestRender(true); return true }
    if (key.name === 'backspace') { s.query = graphemes(s.query).slice(0, -1).join(''); s.skip = 0; this.showSearchMatch(); return true }
    if (key.name === 'char' && !key.ctrl && !key.alt) { s.query += key.ch ?? ''; s.skip = 0; this.showSearchMatch(); return true }
    // Anything else keeps the match in the box and is handled as usual.
    this.search = null
    return false
  }

  /** Keys while a question is open. Returns false for keys the input box should get instead. */
  private onQuestionKey(key: KeyEvent): boolean {
    const q = this.question!
    if (q.typing) {
      // A backslash before Enter is a new line here too.
      if (key.name === 'enter' && !key.alt && !key.shift && this.editor.before === '\\') { this.editor.backspace(); this.editor.insert('\n'); this.terminal.requestRender(true); return true }
      if (key.name === 'enter' && !key.alt && !key.shift) { q.submitCustom(this.unchipped(this.sentFromBox())); this.answered(); return true }
      if (key.name === 'escape') { q.typing = false; this.terminal.requestRender(true); return true }
      return false
    }
    if (key.ctrl) return false
    switch (key.name) {
      case 'up': q.move(-1); break
      case 'down': case 'tab': q.move(1); break
      case 'enter': if (q.choose() === 'answered') { this.answered(); return true } break
      case 'escape': q.skip(); this.answered(); return true
      case 'char':
        if (key.ch === ' ') { q.toggle(); break }
        // Typing answers in the person's own words.
        q.cursor = q.rows().length - 1
        q.typing = true
        return false
      default: return false
    }
    this.terminal.requestRender(true)
    return true
  }

  /** Keys while a picker is open. Returns false for keys the input box should get instead. */
  private onPickerKey(key: KeyEvent): boolean {
    const p = this.picker!
    // Opened over text being typed (it opens when the gateway answers): every key but esc is the text's,
    // until the box is empty again.
    if (this.editor.text !== '') {
      if (key.name === 'escape' && !key.ctrl) { this.closePicker(); return true }
      return false
    }
    if (key.ctrl) {
      if (key.name === 'char' && key.ch === 'c') { this.closePicker(); return true }
      return false
    }
    switch (key.name) {
      case 'up': p.move(-1); break
      case 'down': p.move(1); break
      case 'tab': p.move(key.shift ? -1 : 1); break
      case 'left': p.stepEffort(-1); break
      case 'right': p.stepEffort(1); break
      case 'enter':
        if (!key.alt && !key.shift) this.choosePicker()
        return true
      case 'escape': this.closePicker(); return true
      case 'char':
        // alt+key closes it and goes to the box, as typing did before the list filtered.
        if (key.alt) { this.closePicker(); return false }
        // A / with nothing typed is a command: the list closes and the key is the box's, as it was.
        if (key.ch === '/' && p.query === '') { this.closePicker(); return false }
        // A digit with nothing typed jumps to its row; anything else is typed into the filter.
        if (/^[1-9]$/.test(key.ch ?? '') && p.jump(Number(key.ch))) break
        p.type(key.ch ?? '')
        break
      case 'backspace': case 'delete':
        if (p.erase()) break
        // Nothing typed to take back: the list closes, as it did.
        this.closePicker()
        return false
      default: return false
    }
    this.terminal.requestRender(true)
    return true
  }

  /** Keys while the panel has focus. Returns false for keys the input box should get instead. */
  private onPanelKey(key: KeyEvent): boolean {
    const rows = this.rows()
    if (key.name === 'up' || key.name === 'down') {
      this.panelIndex = Math.max(0, Math.min(rows.length - 1, this.panelIndex + (key.name === 'up' ? -1 : 1)))
    } else if (key.name === 'enter') {
      const row = rows[this.panelIndex]
      if (row !== undefined) this.open(row)
    } else if (key.name === 'escape' || key.name === 'tab') {
      this.focus = 'editor'
    } else {
      // Typing goes back to the input box, with the key.
      this.focus = 'editor'
      return false
    }
    this.terminal.requestRender(true)
    return true
  }

  /** The text with each paste chip in it the text it stands for. Kept for the run: ↑ can bring a chip back. */
  private unchipped(text: string): string {
    for (const [chip, pasted] of this.pastes) text = text.split(chip).join(pasted)
    return text
  }

  private submit(): void {
    const raw = this.editor.text
    const text = this.unchipped(raw)
    if (text.trim() === '') return
    this.sentFromBox()
    // Kept for the next run only where it went somewhere: a command run, a message sent.
    if (this.o.intercept?.(text.trim()) === true) { this.o.remember?.(text); return }
    if (this.view.kind === 'agent') {
      if (this.view.mode !== 'continuable') { this.showToast(t().oneShot); return }
      this.o.remember?.(text)
      this.o.backend.agentSend?.(this.view.id, text)
      this.showToast(t().sentTo(this.view.label))
      return
    }
    if (this.view.kind === 'job') { this.showToast(t().shellNoInput); return }
    const id = this.messageId()
    // Not sent (no link): it stays in the box, never shown as asked or queued, nor kept as sent.
    if (this.o.backend.send(text, id) === false) { this.editor.set(raw); return }
    this.o.remember?.(text)
    this.said(text, id)
  }

  /**
   * The box's text, as it leaves (a message, an answer, a command, a subagent's message): into history,
   * and its chips kept for ↑ to bring back; chips in neither the box nor anything that left are let go.
   */
  private sentFromBox(): string {
    const raw = this.editor.submit()
    for (const chip of this.pastes.keys()) if (raw.includes(chip)) this.sentChips.add(chip)
    for (const chip of [...this.pastes.keys()]) if (!this.sentChips.has(chip)) this.pastes.delete(chip)
    return raw
  }

  /** Stop the turn. The gateway withdraws the messages waiting behind it, so they come back to the input. */
  private cancel(): void {
    this.markInterrupted()
    this.withdrawing = Math.max(0, this.busy - 1)
    this.o.backend.cancel()
    if (this.pending.length === 0) return
    this.backToBox(this.pending.splice(0).map((p) => p.text))
    this.terminal.requestRender(true)
  }

  /** A turn the person stopped, marked where it stopped: once a turn, however it was stopped. */
  private markInterrupted(): void {
    if (!this.status.running || this.interrupted) return
    this.interrupted = true
    const block = interruptedBlock(this.mode)
    this.mark = block.id
    this.transcript.push(block)
    this.transcript.toBottom()
  }

  private pick(index: number): void {
    const option = this.choice?.options[index]
    if (option === undefined) return
    this.choice = null
    this.o.backend.action(option.id)
  }

  private ctrlC(): void {
    if (this.editor.text !== '') { this.editor.set(''); this.quitArmed = 0; this.refreshCompletion(); this.terminal.requestRender(true); return }
    if (this.status.running) { this.cancel(); return }
    const now = this.clock.now()
    if (this.quitArmed !== 0 && now - this.quitArmed < TOAST_MS) { this.stop(0); return }
    this.quitArmed = now
    this.showToast(t().ctrlCAgain)
  }

  private onMouse(m: MouseEvent): void {
    const { transcriptTop, transcriptHeight, dividerRow } = this.geometry
    const inTranscript = m.y >= transcriptTop && m.y < transcriptTop + transcriptHeight
    const pane = this.pane
    const g = this.geometry
    const pickerLine = this.picker !== null && g.pickerTop >= 0 ? g.pickerMap[m.y - g.pickerTop] : undefined
    const completionAt = this.completion !== null && g.completionTop >= 0 && m.y >= g.completionTop && m.y < g.completionTop + g.completionShown ? g.completionFirst + (m.y - g.completionTop) : -1
    if (m.action === 'wheel') {
      // Over a list, the wheel moves its highlight; anywhere else it scrolls what is shown.
      if (pickerLine !== undefined) this.picker!.move(m.button)
      else if (completionAt !== -1) { const c = this.completion!; c.index = (c.index + m.button + c.items.length) % c.items.length }
      else { pane.scroll(m.button * 3); this.terminal.requestRender(); return }
      this.terminal.requestRender(true)
      return
    }
    if (m.button !== 0) return
    if (m.action === 'down') {
      if (m.y === dividerRow && pane.unseen > 0) { pane.toBottom(); this.terminal.requestRender(true); return }
      if (pickerLine !== undefined) {
        // A row is picked as with ↵; its effort line steps the effort as → does.
        if (pickerLine >= 0) { this.picker!.cursor = pickerLine; this.choosePicker() }
        else if (pickerLine === -2) { this.picker!.stepEffort(1); this.terminal.requestRender(true) }
        return
      }
      if (completionAt !== -1) { this.completion!.index = completionAt; this.acceptCompletion(true); return }
      if (m.y === g.statusRow && g.effortSpan !== null && m.x >= g.effortSpan.from && m.x < g.effortSpan.to) { this.o.stepEffort?.(); return }
      if (m.y > g.editorTop && m.y <= g.editorTop + g.editorRows && this.focus === 'editor') {
        // A click in the input box puts the cursor there.
        this.editor.place(this.editorWidth(), g.editorFirst + (m.y - g.editorTop - 1), Math.max(0, m.x - 4))
        this.refreshCompletion()
        this.terminal.requestRender(true)
        return
      }
      const { questionRowsAt } = this.geometry
      if (this.question !== null && questionRowsAt >= 0 && m.y >= questionRowsAt && m.y < questionRowsAt + this.question.rows().length) {
        const q = this.question
        q.cursor = m.y - questionRowsAt
        const row = q.rows()[q.cursor]
        if (row.kind === 'custom') q.typing = true
        else if (q.current?.multiSelect) q.toggle()
        else if (q.choose() === 'answered') this.answered()
        this.terminal.requestRender(true)
        return
      }
      const { panelTop, panelFirst, panelShown } = this.geometry
      if (panelTop >= 0 && m.y >= panelTop && m.y < panelTop + panelShown) {
        const rows = this.rows()
        const shownRows = panelWindow(rows, this.panelIndex, PANEL_MAX_ROWS).rows
        const row = shownRows[m.y - panelTop]
        if (row !== undefined) {
          if (row.kind !== 'more') this.panelIndex = panelFirst + (m.y - panelTop)
          this.open(row)
        }
        return
      }
      if (this.geometry.choiceRow >= 0 && m.y >= this.geometry.choiceRow && m.y < this.geometry.choiceRow + this.geometry.choiceSpans.length) {
        const span = this.geometry.choiceSpans[m.y - this.geometry.choiceRow]
        if (m.x >= span.from && m.x < span.to) { this.pick(m.y - this.geometry.choiceRow); this.terminal.requestRender(true) }
        return
      }
      // The held prompt's row covers a line: a press there is not a press on that line.
      if (m.y === g.heldRow) return
      if (!inTranscript) { this.clearSelection(); return }
      const line = pane.lineAt(m.y - transcriptTop) ?? Math.max(0, pane.size - 1)
      pane.beginSelection({ line, col: m.x })
      this.dragging = true
      this.dragRow = m.y
      this.terminal.requestRender(true)
      return
    }
    if (m.action === 'drag' && this.dragging) {
      // Dragging past the edge scrolls, so a selection can be longer than the screen.
      // Past the top: above the pane, or, when nothing is above it (the main view has no header), into its
      // first row from below. Along that row the drag selects, as anywhere.
      if (m.y < transcriptTop || (m.y === 0 && transcriptTop === 0 && this.dragRow > 0)) pane.scroll(-1)
      else if (m.y >= transcriptTop + transcriptHeight) pane.scroll(1)
      this.dragRow = m.y
      const row = Math.max(0, Math.min(transcriptHeight - 1, m.y - transcriptTop))
      const line = pane.lineAt(row) ?? Math.max(0, pane.size - 1)
      pane.extendSelection({ line, col: m.x })
      this.terminal.requestRender(true)
      return
    }
    if (m.action === 'up' && this.dragging) {
      this.dragging = false
      const text = pane.selectedText()
      if (text === '') {
        // A click, not a drag: on a tool's block it folds or unfolds that block alone.
        const at = pane.selection?.anchor.line
        this.clearSelection()
        const block = at === undefined ? null : pane.blockAt(at)
        const turn = block === null ? undefined : this.folds.get(block)
        // Turned over in place: its head stays on its row, and a long result unfolds below it.
        if (turn !== undefined) { pane.keepInPlace(block!, this.o.io.columns(), turn); this.terminal.requestRender(true) }
        return
      }
      const method = (this.o.copy ?? ((t: string) => systemCopy(t, { env: this.o.env, platform: this.o.platform, write: (d) => this.o.io.write(d) })))(text)
      this.showToast(t().copied([...text].length, method === 'osc52'))
    }
  }

  private clearSelection(): void {
    if (this.pane.selection === null) return
    this.pane.selection = null
    this.dragging = false
    this.terminal.requestRender()
  }

  // ── Drawing ─────────────────────────────────────────────────────────────

  private editorWidth(): number {
    return Math.max(4, this.o.io.columns() - 6)
  }

  private render(screen: Screen): void {
    const { cols, rows } = screen
    // A screen of another height may fit the welcome letters where this one did not, or the other way round.
    // Letters coming or going are not lines that arrived, and a view scrolled up stays on what it showed.
    if (rows !== this.welcomeRows) {
      this.welcomeRows = rows
      const before = this.transcript.layout(cols).length
      this.transcript.refold(cols, () => this.banner.refresh())
      if (!this.transcript.follow) this.transcript.top = Math.max(0, this.transcript.top + this.transcript.layout(cols).length - before)
    }
    // Whatever closed the question or the search, text the gateway gave back meanwhile comes to the box now.
    this.restoreTakenBack()
    setFrame(Math.floor(this.clock.now() / 80))
    const s = (style) => sgr(style, this.mode)
    const editor = this.editor.layout(this.editorWidth())
    const editorRows = Math.min(EDITOR_MAX_ROWS, editor.rows.length)
    // An approval as Claude Code asks one: the request's first line, then its options numbered, one a row.
    const choiceRows = this.choice === null || this.question !== null ? 0 : 1 + this.choice.options.length
    const questionLines = this.question === null ? [] : this.questionLines(cols)
    const stripRows = this.interview !== null && this.view.kind === 'main' ? 3 : 0
    const allRows = this.rows()
    const panel = panelWindow(allRows, this.panelIndex, PANEL_MAX_ROWS)
    const panelShown = panel.rows.length
    const completion = this.completionLines(cols)
    const completionLines = completion.lines
    // Messages waiting behind the running turn, above the divider: three at most, then a count.
    const waiting = this.view.kind === 'main' ? this.pending.map((p) => p.text) : []
    const pendingRows = Math.min(waiting.length, 3) + (waiting.length > 3 ? 1 : 0)
    // The shortcuts open only with nothing else in the box's place: what is left after a row of transcript, the
    // waiting messages, the divider, the status line, the panel and the hint.
    // A header row only where the pane looks elsewhere (a subagent, a shell): the main conversation has its
    // welcome box, as Claude Code and pi have no header over theirs.
    const headerRows = this.view.kind === 'main' ? 0 : 1
    const shortcutLines = this.shortcuts ? this.shortcutLines(cols, rows - (headerRows + stripRows) - 1 - (pendingRows + 1 + 1 + panelShown + 1)) : []
    // A choice on screen (a picker, a question's options, an approval) takes the input box's place while
    // nothing is typed, as in Claude Code: one keystroke of text brings the box back.
    const boxHidden = this.editor.text === '' && this.search === null
      && ((this.picker !== null && this.question === null) || (this.question !== null && !this.question.typing) || (this.choice !== null && this.question === null) || this.shortcuts)
    const boxRows = boxHidden ? 0 : editorRows + 2
    const fixed = pendingRows + 1 /* divider */ + 1 /* status */ + panelShown + choiceRows + questionLines.length + completionLines.length + shortcutLines.length + boxRows + 1 /* hint */
    // The picker gets what is left after a row of transcript: on a small screen it shrinks; the hint line stays.
    const pickerLines = this.question === null && this.picker !== null ? this.pickerLines(cols, rows - (headerRows + stripRows) - 1 - fixed) : []
    const bottom = fixed + pickerLines.length
    // Every row left is the transcript's. One shorter than that is drawn from the top, as a page reads, and the
    // rows under it stay empty: the input box keeps the bottom rows either way.
    const area = Math.max(1, rows - (headerRows + stripRows) - bottom)
    const transcriptHeight = Math.max(1, Math.min(area, this.pane.layout(cols).length))
    const transcriptTop = headerRows + stripRows
    if (stripRows > 0) this.drawInterview(screen, headerRows, cols)
    const pendingTop = headerRows + stripRows + area
    const dividerRow = pendingTop + pendingRows
    const statusRow = dividerRow + 1
    const panelTop = panelShown === 0 ? -1 : statusRow + 1
    const choiceRow = choiceRows === 0 ? -1 : statusRow + 1 + panelShown
    const questionTop = questionLines.length === 0 ? -1 : statusRow + 1 + panelShown + choiceRows
    const pickerTop = pickerLines.length === 0 ? -1 : statusRow + 1 + panelShown + choiceRows + questionLines.length
    const completionTop = statusRow + 1 + panelShown + choiceRows + questionLines.length + pickerLines.length
    const shortcutsTop = completionTop + completionLines.length
    const editorTop = shortcutsTop + shortcutLines.length
    shortcutLines.forEach((line, i) => screen.put(1, shortcutsTop + i, line.text, line.style))
    pickerLines.forEach((line, i) => screen.put(1, pickerTop + i, line.text, line.style))
    completionLines.forEach((line, i) => {
      const x = screen.put(1, completionTop + i, line.label, line.selected ? s({ ...theme.accent, bold: true }) : s(theme.text))
      if (line.hint !== '') screen.put(x + 2, completionTop + i, line.hint, s(theme.muted))
    })
    let questionRowsAt = -1
    questionLines.forEach((line, i) => {
      if (line.optionRow && questionRowsAt === -1) questionRowsAt = questionTop + i
      screen.put(1, questionTop + i, line.text, line.style)
    })
    const choiceSpans: Array<{ from: number; to: number }> = []
    if (choiceRows > 0 && this.choice !== null) {
      // The message's first line with words, without the warning sign the adapter's own request starts with.
      const title = (this.posted.get(this.choice.ts)?.text ?? '').split('\n').map((line) => line.trim().replace(/^⚠\uFE0F?\s*/u, '')).find((line) => line !== '') ?? t().choiceTitle
      const x = screen.put(1, choiceRow, '⚠ ', s(theme.warn))
      screen.put(x, choiceRow, fit(title, cols - 1 - x), s({ ...theme.text, bold: true }), cols - 1)
      this.choice.options.forEach((option, i) => {
        const selected = i === this.choice!.index
        const style = selected ? s({ ...(option.style === 'danger' ? theme.danger : theme.accent), bold: true }) : s(theme.muted)
        const to = screen.put(1, choiceRow + 1 + i, `${selected ? '❯' : ' '} ${i + 1}. ${option.label}`, style)
        choiceSpans.push({ from: 1, to })
      })
    }
    // A click on a row shown must not scroll the box: the rows stay until the cursor leaves them.
    let editorFirst = Math.min(this.editorScroll, Math.max(0, editor.rows.length - editorRows))
    if (editor.cursor.y < editorFirst) editorFirst = editor.cursor.y
    else if (editor.cursor.y >= editorFirst + editorRows) editorFirst = editor.cursor.y - editorRows + 1
    this.editorScroll = editorFirst
    this.geometry = {
      transcriptTop, transcriptHeight, dividerRow, editorTop, choiceRow: choiceRow === -1 ? -1 : choiceRow + 1, choiceSpans, panelTop, panelFirst: panel.first, panelShown, questionTop, questionRowsAt,
      pickerTop, pickerMap: pickerLines.map((line) => line.row),
      completionTop: completionLines.length === 0 ? -1 : completionTop, completionFirst: completion.first, completionShown: completionLines.length,
      editorRows: boxHidden ? 0 : editorRows, editorFirst, statusRow, effortSpan: null, heldRow: -1,
    }
    if (panelTop >= 0) this.drawPanel(screen, panelTop, panel.rows, panel.first)

    // Header, in a side view only: where the pane is looking.
    if (this.view.kind !== 'main') {
      let hx = screen.put(1, 0, 'deepseek-bot', s(theme.brand))
      hx = screen.put(hx, 0, ` · main › ${this.view.kind === 'agent' ? this.view.label : this.view.id}`, s(theme.accent))
      const right = [this.status.session && `${this.status.session.slice(0, 12)}…`, this.shownWorkspace()].filter(Boolean).join(' · ')
      if (right !== '') screen.put(Math.max(hx + 2, cols - 1 - stringWidth(right)), 0, right, s(theme.muted))
    }

    // The pane, with the selection drawn inverted.
    const pane = this.pane
    const visible = pane.visible(cols, transcriptHeight)
    const held = transcriptHeight > 2 ? pane.promptAbove() : null
    visible.forEach((line, r) => {
      const y = transcriptTop + r
      let x = 0
      for (const span of line.spans) x = screen.put(x, y, span.text, span.style, cols, span.link)
      if (pane.selection !== null) {
        const index = pane.top + r
        for (let c = 0; c < cols; c++) {
          if (!pane.isSelected(index, c)) continue
          const i = y * cols + c
          const cell = screen.cells[i]
          screen.cells[i] = { ...cell, style: cell.style === '' ? '\x1b[0;7m' : `${cell.style}\x1b[7m` }
        }
      }
    })

    // Scrolled up past a prompt: it holds the top line, dim, so what is in view says what it answers.
    this.geometry.heldRow = held !== null ? transcriptTop : -1
    if (held !== null) {
      screen.put(0, transcriptTop, ' '.repeat(cols), '')
      screen.put(0, transcriptTop, fit(`› ${held.replace(/\s+/g, ' ').trim()}`, cols - 1), s(theme.dim))
    }

    // What waits behind the running turn, over the divider (as Claude Code queues it), each on the band it will
    // have in the transcript.
    if (pendingRows > 0) {
      const banded = this.mode !== 'none'
      const body = s(banded ? theme.userBand : theme.muted)
      const tag = ` ${t().queued} `
      waiting.slice(0, 3).forEach((text, i) => {
        const y = pendingTop + i
        if (banded) screen.put(0, y, ' '.repeat(cols), body)
        const x = screen.put(0, y, '› ', s(banded ? theme.userMark : theme.user))
        screen.put(x, y, text.replace(/\s+/g, ' '), body, Math.max(x, cols - stringWidth(tag) - 1))
        screen.put(cols - stringWidth(tag) - 1, y, tag, s(banded ? { ...theme.userBand, fg: palette.muted, italic: true } : theme.muted))
      })
      if (waiting.length > 3) screen.put(2, pendingTop + 3, t().queuedCount(waiting.length), s(theme.muted))
    }

    // Divider, with the "new lines below" marker when scrolled away.
    screen.put(0, dividerRow, '─'.repeat(cols), s(theme.border))
    if (pane.unseen > 0) {
      const tag = t().newLines(pane.unseen)
      screen.put(Math.max(0, cols - stringWidth(tag) - 2), dividerRow, tag, s(theme.accent))
    }

    // Status line.
    this.drawStatus(screen, statusRow)

    // Input box, unless a choice has its place.
    if (boxHidden) screen.cursor = null
    else {
      const inner = cols - 4
      screen.put(0, editorTop, `╭${'─'.repeat(Math.max(0, cols - 2))}╮`, s(theme.border))
      const first = editorFirst
      // The rows the box cannot show, counted in its border, as pi does.
      const above = first, below = Math.max(0, editor.rows.length - first - editorRows)
      // Only where the count leaves the border's corners.
      if (above > 0) { const tag = ` ${t().moreAbove(above)} `; if (cols >= stringWidth(tag) + 6) screen.put(cols - 2 - stringWidth(tag), editorTop, tag, s(theme.muted)) }
      for (let r = 0; r < editorRows; r++) {
        const y = editorTop + 1 + r
        screen.put(0, y, '│', s(theme.border))
        screen.put(cols - 1, y, '│', s(theme.border))
        if (first + r === 0) screen.put(2, y, '› ', s(theme.accent))
        screen.put(4, y, editor.rows[first + r] ?? '', '', 2 + inner)
      }
      screen.put(0, editorTop + 1 + editorRows, `╰${'─'.repeat(Math.max(0, cols - 2))}╯`, s(theme.border))
      if (below > 0) { const tag = ` ${t().moreBelow(below)} `; if (cols >= stringWidth(tag) + 6) screen.put(cols - 2 - stringWidth(tag), editorTop + 1 + editorRows, tag, s(theme.muted)) }
      // A placeholder in the empty box, when it is for a message: not a search's, not a question's answer.
      if (this.editor.text === '' && this.focus === 'editor' && this.view.kind === 'main' && this.search === null && this.question === null) screen.put(4, editorTop + 1, t().placeholder, s(theme.dim), 2 + inner)
      screen.cursor = this.focus === 'editor' ? { x: 4 + editor.cursor.x, y: editorTop + 1 + (editor.cursor.y - first) } : null
    }

    // Hint line: what the keys do here.
    const search = this.search
    const hint = search !== null ? t().hints.search(search.query, search.found)
      // A list longer than its rows says where the highlight is.
      : this.completion !== null ? t().hints.completion(this.completion.items.length > COMPLETION_MAX_ROWS ? this.completion.index + 1 : 0, this.completion.items.length)
      : this.shortcuts ? t().hints.shortcuts
      : this.picker !== null && this.question === null && this.editor.text === '' ? t().hints.picker(this.picker.hasEfforts)
      : this.choice !== null && this.question === null && this.editor.text === '' ? t().hints.choice(this.choice.options.length, noOption(this.choice) !== -1)
      : this.question?.typing ? t().hints.typing
      : this.question !== null ? t().hints.question(this.question.current?.multiSelect === true)
      : this.focus === 'panel' ? t().hints.panel
      : this.view.kind === 'agent' ? t().hints.agent(this.view.label)
        : this.view.kind === 'job' ? t().hints.job
          : this.status.running && this.pending.length > 0 && this.editor.text === '' ? t().hints.queued
          : this.status.running ? t().hints.running
            : t().hints.idle(allRows.length > 0)
    screen.put(1, editorTop + boxRows, hint, s(theme.dim))
    // At its right, as pi's footer has it: where the agent works (and on which branch), and the conversation.
    // Only in the conversation's own view: a subagent's or a shell's has a header that says where it looks.
    if (this.status.workspace !== '' && this.view.kind === 'main') {
      const where = `${this.shownWorkspace()}${this.branch !== null ? ` (${this.branch})` : ''}${this.status.session ? ` · ${this.status.session.slice(0, 8)}…` : ''}`
      const x = cols - 1 - stringWidth(where)
      if (x >= 1 + stringWidth(hint) + 2) screen.put(x, editorTop + boxRows, where, s(theme.muted))
    }
  }

  /**
   * The keys, as `/help` lists them: what ? shows in the input box's place. In as many columns as fit, each as
   * wide as its own widest key, and in at most `room` rows, the last saying how many did not fit.
   */
  private shortcutLines(cols: number, room: number): Array<{ text: string; style: string }> {
    const usable = Math.max(1, cols - 2)
    const items = t().helpKeys.flatMap((line) => line.split(' · ')).map((item) => fit(item.trim(), usable)).filter((item) => item !== '')
    const GAP = 3
    const widthsFor = (n: number) => Array.from({ length: n }, (_, j) => Math.max(0, ...items.filter((_, i) => i % n === j).map((item) => stringWidth(item))))
    let perRow = 1
    for (let n = items.length; n > 1; n--) {
      if (widthsFor(n).reduce((sum, w) => sum + w, 0) + GAP * (n - 1) <= usable) { perRow = n; break }
    }
    const widths = widthsFor(perRow)
    const rows: string[] = []
    for (let i = 0; i < items.length; i += perRow) {
      rows.push(items.slice(i, i + perRow).map((item, j) => item + ' '.repeat(Math.max(0, widths[j] - stringWidth(item) + GAP))).join('').trimEnd())
    }
    // The title, the rows that fit, and a last row for the rest; with room for one line, the title alone.
    if (room < 1) return []
    if (room === 1) return [{ text: t().shortcutsTitle, style: sgr({ ...theme.text, bold: true }, this.mode) }]
    const fits = room - 1
    const shown = rows.length <= fits ? rows : rows.slice(0, Math.max(0, fits - 1))
    const lines = [{ text: t().shortcutsTitle, style: sgr({ ...theme.text, bold: true }, this.mode) }, ...shown.map((text) => ({ text, style: sgr(theme.muted, this.mode) }))]
    if (shown.length < rows.length) lines.push({ text: fit(t().moreKeys(items.length - shown.length * perRow), usable), style: sgr(theme.dim, this.mode) })
    return lines
  }

  /** The completion list, a window of rows around the picked candidate. */
  private completionLines(cols: number): { lines: Array<{ label: string; hint: string; selected: boolean }>; first: number } {
    const c = this.completion
    if (c === null) return { lines: [], first: 0 }
    const first = Math.max(0, Math.min(c.index - COMPLETION_MAX_ROWS + 1, c.items.length - COMPLETION_MAX_ROWS))
    const shown = c.items.slice(first, first + COMPLETION_MAX_ROWS)
    const labelWidth = Math.min(Math.max(...shown.map((i) => stringWidth(i.label))), Math.floor(cols / 2))
    return {
      first,
      lines: shown.map((item, k) => ({
        label: `${first + k === c.index ? '❯' : ' '} ${item.label}${' '.repeat(Math.max(0, labelWidth - stringWidth(item.label)))}`,
        hint: item.hint,
        selected: first + k === c.index,
      })),
    }
  }

  /** The picker: its title, a window of numbered rows, and the highlighted row's effort when it has one. */
  private pickerLines(cols: number, room: number): Array<{ text: string; style: string; row: number }> {
    const p = this.picker
    if (p === null) return []
    const s = (style) => sgr(style, this.mode)
    // Within the room left. The title and the effort line come off it first, and go when the rows
    // would not fit with them.
    let title = 1
    let effortLine = p.hasEffortLine ? 1 : 0
    // With nothing matching there are no rows, and the title is what says so.
    if (room - title - effortLine < 1 && p.shown.length > 0) title = 0
    if (room - title - effortLine < 1) effortLine = 0
    const win = p.window(Math.max(1, Math.min(PICKER_MAX_ROWS, room - title - effortLine)))
    // The title says where the highlight is when the list is longer than its window or filtered, and what was typed.
    const where = p.query !== '' || win.above + win.below > 0 ? (p.shown.length === 0 ? '' : ` (${p.position}/${p.shown.length})`) : ''
    const typed = p.query === '' ? '' : ` · "${p.query}"${p.shown.length === 0 ? ` · ${t().noMatch}` : ''}`
    const out: Array<{ text: string; style: string; row: number }> = title === 1 ? [{ text: fit(`${p.spec.title}${where}${typed}`, Math.max(1, cols - 2)), style: s({ ...theme.accent, bold: true }), row: -1 }] : []
    const indices = p.shown.slice(win.first, win.first + win.count)
    const shown = indices.map((i) => p.rows[i])
    const labelWidth = Math.min(Math.max(0, ...shown.map((r) => stringWidth(r.label))), Math.floor(cols / 2))
    const numberWidth = String(p.rows.length).length
    if (win.above > 0) out.push({ text: `  ↑ ${win.above}`, style: s(theme.muted), row: -1 })
    shown.forEach((row, k) => {
      const i = indices[k]
      const at = i === p.cursor
      const label = `${row.label}${' '.repeat(Math.max(0, labelWidth - stringWidth(row.label)))}`
      const text = `${at ? '❯' : ' '} ${String(i + 1).padStart(numberWidth)}. ${label}${row.detail ? `  ${row.detail}` : ''}${row.current ? '  ✓' : ''}`
      out.push({ text, style: at ? s({ ...theme.accent, bold: true }) : s(theme.text), row: i })
    })
    if (win.below > 0) out.push({ text: `  ↓ ${win.below}`, style: s(theme.muted), row: -1 })
    const current = p.position > 0 ? p.rows[p.cursor] : undefined
    if (effortLine === 1 && current?.efforts !== undefined) {
      const text = current.efforts.length === 0 ? `  ${t().noEffort}`
        : `  effort ◂ ${p.effortAt(p.cursor) ?? t().effortDefault} ▸  ${current.efforts.join(' · ')}`
      out.push({ text, style: s(theme.thinking), row: current.efforts.length === 0 ? -1 : -2 })
    }
    return out
  }

  /** The question panel: what is asked, then one row per option and "type your own…". */
  private questionLines(cols: number): Array<{ text: string; style: string; optionRow: boolean }> {
    const q = this.question
    const current = q?.current
    if (q === null || current === undefined) return []
    const s = (style) => sgr(style, this.mode)
    const out: Array<{ text: string; style: string; optionRow: boolean }> = []
    const where = q.items.length > 1 ? ` (${q.index + 1}/${q.items.length})` : ''
    const kind = current.intent?.kind === 'plan-review' ? t().planReview : current.header ?? t().question
    out.push({ text: `? ${kind}${where}`, style: s({ ...theme.warn, bold: true }), optionRow: false })
    for (const line of wrapPlain(current.question, Math.max(10, cols - 6)).slice(0, 3)) out.push({ text: `  ${line}`, style: s(theme.text), optionRow: false })
    q.rows().forEach((row, i) => {
      const at = i === q.cursor
      const box = current.multiSelect && row.kind === 'option' ? (row.checked ? '[x] ' : '[ ] ') : ''
      const desc = row.description ? ` — ${row.description}` : ''
      const text = `${at ? '❯' : ' '} ${box}${row.label}${desc}`
      out.push({ text, style: at ? s({ ...theme.accent, bold: true }) : row.kind === 'custom' ? s(theme.muted) : s(theme.text), optionRow: true })
    })
    return out
  }

  /** The deep interview's strip: round, each dimension's clarity, the ambiguity left. */
  private drawInterview(screen: Screen, y: number, cols: number): void {
    const s = (style) => sgr(style, this.mode)
    const iv = this.interview!
    const st = iv.state
    let x = screen.put(1, y, `${t().interview} · ${iv.topic}`, s({ ...theme.accent, bold: true }))
    if (st !== null && st.round > 0) x = screen.put(x, y, ` · round ${st.round}`, s(theme.muted))
    const right = st === null ? t().interviewPreparing
      : st.done ? `${t().interviewDone}${st.spec ? ` · spec: ${st.spec}` : ''}`
        : t().interviewAmbiguity(st.ambiguity, AMBIGUITY_TARGET)
    screen.put(Math.max(x + 2, cols - 1 - stringWidth(right)), y, right, st?.done ? s(theme.ok) : s(theme.muted))
    let gx = 1
    for (const [name, value] of Object.entries(st?.scores ?? {})) {
      const filled = Math.round(value / 10)
      const piece = `${name} ${'▰'.repeat(filled)}${'▱'.repeat(10 - filled)} ${value}%   `
      if (gx + stringWidth(piece) > cols - 1) break
      gx = screen.put(gx, y + 1, piece, value >= 80 ? s(theme.ok) : value >= 50 ? s(theme.accent) : s(theme.warn))
    }
    screen.put(1, y + 2, t().interviewEstimate, s(theme.dim))
  }

  private drawPanel(screen: Screen, top: number, rows: PanelRow[], first: number): void {
    const s = (style) => sgr(style, this.mode)
    const now = this.clock.now()
    const labelWidth = Math.max(12, Math.min(32, Math.floor(screen.cols * 0.35)))
    rows.forEach((row, i) => {
      const y = top + i
      const index = first + i
      const focused = this.focus === 'panel' && index === this.panelIndex && row.kind !== 'more'
      const current = (row.kind === 'main' && this.view.kind === 'main')
        || (row.kind === 'agent' && this.view.kind === 'agent' && this.view.id === row.agent.id)
        || (row.kind === 'job' && this.view.kind === 'job' && this.view.id === row.job.id)
      const lead = focused ? '❯ ' : row.kind === 'more' ? '' : current ? '● ' : row.kind === 'job' ? '◆ ' : '○ '
      const label = row.kind === 'main' ? 'main'
        : row.kind === 'agent' ? row.agent.label
          : row.kind === 'job' ? `${row.job.id}  ${row.job.label}`
            : row.kind === 'idle' ? `${row.count} idle agents`
              : `↓ ${row.count} more`
      const labelStyle = focused ? s({ ...theme.accent, bold: true }) : current ? s({ bold: true }) : row.kind === 'agent' && row.agent.status === 'running' ? s(theme.text) : s(theme.muted)
      let x = screen.put(1, y, lead, focused ? s(theme.accent) : s(theme.muted))
      x = screen.put(x, y, label, labelStyle, Math.min(screen.cols - 2, 3 + labelWidth))
      const status = rowStatus(row, now)
      if (status !== '') screen.put(Math.max(x + 2, screen.cols - 1 - stringWidth(status)), y, status, row.kind === 'agent' && row.agent.status === 'running' ? s(theme.accent) : s(theme.muted))
    })
  }

  private drawStatus(screen: Screen, y: number): void {
    const s = (style) => sgr(style, this.mode)
    const now = this.clock.now()
    if (this.toast !== null && now >= this.toast.until) this.toast = null
    let x = 1
    // Between parts, once something is on the line.
    const sep = (text: string) => `${x > 1 ? ' · ' : ''}${text}`
    if (!this.status.connected) {
      x = screen.put(x, y, `○ ${this.status.link}`, s(theme.warn))
    } else {
      // The effort, where Claude Code shows its mode, with the key that steps it; while a turn runs the line
      // is the turn's.
      if (!this.status.running && this.status.effort !== null && this.status.effort !== '') {
        const from = x
        x = screen.put(x, y, `▸▸ ${t().effortLabel(this.status.effort)}`, s(theme.thinking))
        this.geometry.effortSpan = { from, to: x }
        x = screen.put(x, y, ' (shift+tab)', s(theme.dim))
      }
      if (this.status.running) {
        // One indicator, as Claude Code has it: what it is doing, for how long, how to stop it. Thinking in
        // the sky blue it has in the transcript; anything else in the brand's light blue.
        const thinking = this.thought !== null && this.thought.streaming
        const label = thinking ? t().thinking : this.runningTool !== null ? t().runningTool(this.runningTool) : t().working
        x = screen.put(x, y, '✻ ', s(thinking ? theme.thinking : theme.accent))
        for (const span of shimmer(label, thinking ? palette.sky : palette.light, palette.glint, currentFrame(), this.mode)) x = screen.put(x, y, span.text, span.style)
        x = screen.put(x, y, t().runningFor(Math.floor((now - this.status.startedAt) / 1000), this.escStops()), s(theme.dim))
      }
      if (this.pending.length > 0) x = screen.put(x, y, sep(t().queuedCount(this.pending.length)), s(theme.muted))
      const counts = panelCounts(this.panel.agents, this.panel.jobs)
      if (counts.shells > 0) x = screen.put(x, y, sep(t().shells(counts.shells)), s(theme.muted))
      if (counts.agents > 0) x = screen.put(x, y, sep(t().agents(counts.agents)), s(theme.muted))
    }
    if (this.toast !== null) x = screen.put(x, y, `  ${this.toast.text}`, s(theme.ok))

    const parts: string[] = []
    if (this.status.contextPct !== null) {
      const filled = Math.round(Math.max(0, Math.min(100, this.status.contextPct)) / 12.5)
      parts.push(`ctx ${'▰'.repeat(filled)}${'▱'.repeat(8 - filled)} ${Math.round(this.status.contextPct)}%`)
    }
    // Sent ↑ and received ↓, as pi shows them, when the gateway says them apart (and something was), with the
    // share the cache served; otherwise the total.
    const { tokensIn, tokensOut, tokensCached } = this.status
    if (tokensIn !== null && tokensOut !== null && tokensIn + tokensOut > 0) {
      parts.push(`↑${formatTokens(tokensIn)} ↓${formatTokens(tokensOut)}`)
      if (tokensCached !== null && tokensIn > 0) parts.push(t().cacheShare(Math.round((tokensCached / tokensIn) * 100)))
    } else if (this.status.tokens > 0) parts.push(`${formatTokens(this.status.tokens)} tok`)
    // The model last, at the edge: what /model changed, next to where it was asked. On a narrow line the
    // parts go whole from the right, the model first: never half a figure.
    const all = [...parts, ...(this.status.connected && this.status.model !== '' ? [this.status.model] : [])]
    let right = ''
    for (let n = all.length; n > 0; n--) {
      const text = all.slice(0, n).join(' · ')
      if (x + 2 + stringWidth(text) <= screen.cols - 1) { right = text; break }
    }
    if (right === '') return
    const at = Math.max(x + 2, screen.cols - 1 - stringWidth(right))
    screen.put(at, y, right, s(theme.status))
    // The context bar in yellow past 70% and red past 90%, as pi colours it: the turns left are few.
    const pct = this.status.contextPct
    if (pct !== null && pct > 70 && right.startsWith('ctx ')) screen.put(at, y, parts[0], s(pct > 90 ? theme.danger : theme.warn))
  }

  /** The workspace as shown: under the home directory as ~, so a screen, or a recording of one, does not
   * carry the account's path. The status keeps the real path; file completion reads it. */
  private shownWorkspace(): string {
    const home = (this.o.env.HOME ?? '').replace(/\/+$/, '')
    const w = this.status.workspace
    return home !== '' && (w === home || w.startsWith(`${home}/`)) ? `~${w.slice(home.length)}` : w
  }

  /** Whether esc, now, stops the running turn: not while something on screen takes it (a choice with a "no", a list, the shortcuts, a view). */
  private escStops(): boolean {
    return this.view.kind === 'main' && this.focus === 'editor' && this.pane.selection === null && !this.shortcuts && this.question === null && this.picker === null && this.search === null && this.completion === null
      && !(this.choice !== null && this.editor.text === '' && noOption(this.choice) !== -1)
  }

  private showToast(text: string): void {
    this.toast = { text, until: this.clock.now() + TOAST_MS }
    this.terminal.requestRender(true)
    this.clock.setTimer(() => this.terminal.requestRender(), TOAST_MS + 10)
  }

  private closeAnswer(): void {
    if (this.answer === null) return
    this.answer.finish()
    this.answer = null
    this.transcript.touch()
  }

  private startSpinner(): void {
    if (this.spinTimer !== null) return
    const tick = () => {
      this.spinTimer = null
      if (!this.status.running) return
      this.transcript.touch()   // a running tool's dot and the thinking label move with the frame
      this.terminal.requestRender()
      this.spinTimer = this.clock.setTimer(tick, 80)
    }
    this.spinTimer = this.clock.setTimer(tick, 80)
  }

  private stopSpinner(): void {
    if (this.spinTimer !== null) { this.clock.clearTimer(this.spinTimer); this.spinTimer = null }
  }
}
