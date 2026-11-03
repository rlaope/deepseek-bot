/**
 * The terminal's lifecycle: enter fullscreen, read input, draw frames, and always put the
 * terminal back.
 *
 * "Always" is the part that matters. A TUI that dies in raw mode with mouse tracking on leaves
 * the user's shell unusable — keys echo nothing and every click prints escape codes. So there is
 * exactly one restore path, it is idempotent, and every way out (quit, Ctrl+C, a signal, an
 * uncaught exception, the socket closing) goes through it.
 *
 * Input and output are injected so the whole thing runs against a fake terminal in tests.
 */
import { InputParser, type InputEvent } from './input.js'
import { diff, Screen } from './screen.js'

export const ENTER = '\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[?1002h\x1b[?1006h'
export const RESTORE = '\x1b[?1006l\x1b[?1002l\x1b[?2004l\x1b[0m\x1b[?25h\x1b[?1049l'

/**
 * How long a lone ESC waits for the rest of a sequence. At 30 ms an arrow split over a slow link (ssh, a loaded
 * machine) read as Esc, which stops the turn, and "[A" typed. 100 ms is vim's ttimeoutlen in its defaults, and
 * not a wait anyone feels on a key that stops something.
 */
export const ESCAPE_MS = 100

/** One sequence the parser reads as a key or a click, after its ESC: CSI with a final it maps, an SGR mouse report, SS3. */
const KEY_BODY = String.raw`(?:\[[\d;]*[ABCDHFZ~^$@u]|\[<\d+;\d+;\d+[Mm]|O[ABCDHF])`
/** Text that is nothing but such sequences, each with its ESC. */
const ONLY_KEYS = new RegExp(String.raw`^\x1b${KEY_BODY}(?:\x1b${KEY_BODY})*$`)

export interface TerminalIO {
  write(data: string): void
  columns(): number
  rows(): number
  setRawMode?(on: boolean): void
  onInput(listener: (chunk: string) => void): () => void
  onResize(listener: () => void): () => void
}

export interface TerminalOptions {
  io: TerminalIO
  /** Draw the whole frame. Called at most once per frame interval. */
  render(screen: Screen): void
  onEvent(event: InputEvent): void
  /** How long a lone ESC waits to see whether a sequence follows. */
  escapeMs?: number
  /** Minimum time between scheduled frames (streaming); urgent frames ignore it. */
  frameMs?: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export class Terminal {
  private readonly o: Required<Omit<TerminalOptions, 'io' | 'render' | 'onEvent'>> & TerminalOptions
  private readonly parser = new InputParser()
  private prev: Screen | null = null
  private active = false
  private escTimer: unknown = null
  /**
   * After the wait took an ESC as Esc: what followed it (the start of a sequence, or nothing), and until when what
   * comes next can still complete a sequence with it.
   */
  private late: { rest: string; until: number } | null = null
  private frameTimer: unknown = null
  private lastFrame = -Infinity
  private unsubscribe: Array<() => void> = []
  /** Frames drawn and bytes written, for the performance checks. */
  readonly stats = { frames: 0, bytes: 0, fullRepaints: 0 }

  constructor(options: TerminalOptions) {
    this.o = {
      escapeMs: ESCAPE_MS,
      frameMs: 16,
      now: () => performance.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      ...options,
    }
  }

  get isActive(): boolean {
    return this.active
  }

  start(): void {
    if (this.active) return
    this.active = true
    this.o.io.setRawMode?.(true)
    this.o.io.write(ENTER)
    this.unsubscribe.push(this.o.io.onInput((chunk) => this.input(chunk)))
    this.unsubscribe.push(this.o.io.onResize(() => { this.prev = null; this.renderNow() }))
    this.renderNow()
  }

  /** Put the terminal back. Safe to call any number of times, from any exit path. */
  restore(): void {
    if (!this.active) return
    this.active = false
    for (const off of this.unsubscribe.splice(0)) { try { off() } catch { /* already gone */ } }
    if (this.escTimer !== null) this.o.clearTimer(this.escTimer)
    if (this.frameTimer !== null) this.o.clearTimer(this.frameTimer)
    this.escTimer = this.frameTimer = null
    try { this.o.io.write(RESTORE) } finally { this.o.io.setRawMode?.(false) }
  }

  /**
   * Ask for a frame. `urgent` draws now — typing must appear on the keystroke, not a frame later.
   * Otherwise frames are coalesced to one per `frameMs`, which is what keeps a fast stream cheap.
   */
  requestRender(urgent = false): void {
    if (!this.active) return
    if (urgent) { this.renderNow(); return }
    if (this.frameTimer !== null) return
    const wait = Math.max(0, this.o.frameMs - (this.o.now() - this.lastFrame))
    this.frameTimer = this.o.setTimer(() => { this.frameTimer = null; this.renderNow() }, wait)
  }

  /** Forget the previous frame so the next one repaints everything (e.g. after a suspend). */
  invalidate(): void {
    this.prev = null
  }

  private renderNow(): void {
    if (!this.active) return
    if (this.frameTimer !== null) { this.o.clearTimer(this.frameTimer); this.frameTimer = null }
    const screen = new Screen(this.o.io.columns(), this.o.io.rows())
    this.o.render(screen)
    if (this.prev === null || this.prev.cols !== screen.cols || this.prev.rows !== screen.rows) this.stats.fullRepaints++
    const bytes = diff(this.prev, screen)
    this.o.io.write(bytes)
    this.stats.frames++
    this.stats.bytes += bytes.length
    this.prev = screen
    this.lastFrame = this.o.now()
  }

  private input(chunk: string): void {
    if (this.escTimer !== null) { this.o.clearTimer(this.escTimer); this.escTimer = null }
    const late = this.late
    this.late = null
    if (late !== null) {
      // Later still than the wait: its Esc has gone, but the rest of a sequence right behind it is that key, not
      // "[A" typed into the box. Only whole sequences the parser knows: "[link](x)" is text.
      const whole = `\x1b${late.rest}${chunk}`
      chunk = this.o.now() < late.until && ONLY_KEYS.test(whole) ? whole : late.rest + chunk
    }
    this.feed(chunk)
  }

  private feed(chunk: string): void {
    for (const event of this.parser.feed(chunk)) this.o.onEvent(event)
    this.arm()
  }

  /** While a lone ESC or a partial sequence waits, the timer that says it is complete as it stands. */
  private arm(): void {
    if (!this.parser.pending) return
    this.escTimer = this.o.setTimer(() => {
      this.escTimer = null
      const held = this.parser.escapeHeld()
      if (held === null) {
        for (const event of this.parser.flush()) this.o.onEvent(event)
        // Two Escs: the second waits in its turn.
        this.arm()
        return
      }
      this.o.onEvent(held.event)
      this.late = { rest: held.rest, until: this.o.now() + this.o.escapeMs }
      // What followed the ESC, when nothing completes it in time, was typed.
      if (held.rest !== '') {
        this.escTimer = this.o.setTimer(() => {
          this.escTimer = null
          const typed = this.late
          this.late = null
          if (typed !== null) this.feed(typed.rest)
        }, this.o.escapeMs)
      }
    }, this.o.escapeMs)
  }
}

/** The real terminal: process stdin/stdout. */
export function processIO(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream): TerminalIO {
  return {
    write: (data) => { stdout.write(data) },
    columns: () => stdout.columns ?? 80,
    rows: () => stdout.rows ?? 24,
    setRawMode: (on) => { if (stdin.isTTY) stdin.setRawMode(on) },
    onInput(listener) {
      stdin.setEncoding('utf8')
      const handler = (chunk: string) => listener(chunk)
      stdin.on('data', handler)
      stdin.resume()
      return () => { stdin.off('data', handler); stdin.pause() }
    },
    onResize(listener) {
      stdout.on('resize', listener)
      return () => { stdout.off('resize', listener) }
    },
  }
}

/**
 * Route every way the process can end through `restore`. Returns a function that removes the
 * hooks (for tests and for a clean quit).
 */
export function restoreOnExit(terminal: Terminal, proc: NodeJS.Process = process): () => void {
  const onSignal = (signal: NodeJS.Signals) => { terminal.restore(); proc.exit(signal === 'SIGINT' ? 130 : 143) }
  const onCrash = (error: unknown) => {
    terminal.restore()
    proc.stderr.write(`dsh: ${String((error as Error)?.stack ?? error)}\n`)
    proc.exit(1)
  }
  const onExit = () => terminal.restore()
  proc.on('SIGINT', onSignal)
  proc.on('SIGTERM', onSignal)
  proc.on('SIGHUP', onSignal)
  proc.on('uncaughtException', onCrash)
  proc.on('unhandledRejection', onCrash)
  proc.on('exit', onExit)
  return () => {
    proc.off('SIGINT', onSignal)
    proc.off('SIGTERM', onSignal)
    proc.off('SIGHUP', onSignal)
    proc.off('uncaughtException', onCrash)
    proc.off('unhandledRejection', onCrash)
    proc.off('exit', onExit)
  }
}
