/**
 * Raw terminal input → events.
 *
 * In raw mode the terminal sends bytes, not keys: an arrow is `ESC [ A`, a click is
 * `ESC [ < 0 ; 12 ; 5 M`, a paste arrives between `ESC [ 200 ~` and `ESC [ 201 ~`, and a lone
 * `ESC` is either the escape key or the start of one of those — which can only be told apart by
 * waiting a moment. The parser is a pure function of its input plus that one timer, so it is
 * tested by feeding it strings.
 */

export interface KeyEvent {
  type: 'key'
  /** 'char' for printable input (see `ch`), otherwise the key's name. */
  name: string
  ch?: string
  ctrl: boolean
  alt: boolean
  shift: boolean
}

export interface PasteEvent { type: 'paste'; text: string }

export interface MouseEvent {
  type: 'mouse'
  action: 'down' | 'up' | 'drag' | 'move' | 'wheel'
  /** 0 left, 1 middle, 2 right; for wheel, -1 up and 1 down. */
  button: number
  /** Zero-based cell coordinates. */
  x: number
  y: number
  shift: boolean
  alt: boolean
  ctrl: boolean
}

/** The terminal's answer to OSC 11 (what its background colour is), read as light or dark. */
export interface BackgroundEvent { type: 'background'; background: 'light' | 'dark' }

export type InputEvent = KeyEvent | PasteEvent | MouseEvent | BackgroundEvent

/** Asks the terminal for its background colour; one that knows answers with OSC 11. */
export const QUERY_BACKGROUND = '\x1b]11;?\x07'

/** An OSC 11 answer's colour, `rgb:RRRR/GGGG/BBBB` (1 to 4 hex digits each), as light or dark by its luminance. */
function backgroundFrom(payload: string): 'light' | 'dark' | null {
  const m = /^11;rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i.exec(payload)
  if (m === null) return null
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h, 16) / (16 ** h.length - 1))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5 ? 'light' : 'dark'
}

const key = (name: string, mods: Partial<KeyEvent> = {}): KeyEvent =>
  ({ type: 'key', name, ctrl: false, alt: false, shift: false, ...mods })

const CSI_TILDE: Record<string, string> = {
  '1': 'home', '2': 'insert', '3': 'delete', '4': 'end', '5': 'pageup', '6': 'pagedown', '7': 'home', '8': 'end',
}
const CSI_LETTER: Record<string, string> = {
  A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end', Z: 'tab',
}

/** xterm modifier parameter: 1 + (shift 1, alt 2, ctrl 4). */
function mods(param: string | undefined): Pick<KeyEvent, 'ctrl' | 'alt' | 'shift'> {
  const m = Math.max(0, Number(param ?? '1') - 1)
  return { shift: (m & 1) !== 0, alt: (m & 2) !== 0, ctrl: (m & 4) !== 0 }
}

const PASTE_BEGIN = '\x1b[200~'
const PASTE_END = '\x1b[201~'

export class InputParser {
  private buffer = ''
  private pasting: string | null = null

  /**
   * Feed decoded input; returns the events it completes. A trailing lone ESC (or an unfinished
   * sequence) stays buffered until more input arrives or `flush()` is called.
   */
  feed(chunk: string): InputEvent[] {
    this.buffer += chunk
    const events: InputEvent[] = []
    while (this.buffer.length > 0) {
      if (this.pasting !== null) {
        const end = this.buffer.indexOf(PASTE_END)
        if (end === -1) {
          // Keep a tail that could be the start of the end marker split across chunks.
          let keep = Math.min(PASTE_END.length - 1, this.buffer.length)
          while (keep > 0 && !PASTE_END.startsWith(this.buffer.slice(-keep))) keep--
          this.pasting += this.buffer.slice(0, this.buffer.length - keep)
          this.buffer = this.buffer.slice(this.buffer.length - keep)
          break
        }
        events.push({ type: 'paste', text: this.pasting + this.buffer.slice(0, end) })
        this.pasting = null
        this.buffer = this.buffer.slice(end + PASTE_END.length)
        continue
      }
      const consumed = this.one(events)
      if (consumed === 0) break   // incomplete: wait for more
      this.buffer = this.buffer.slice(consumed)
    }
    return events
  }

  /** The timer fired: whatever is buffered is complete as it stands. */
  flush(): InputEvent[] {
    const events: InputEvent[] = []
    if (this.buffer === '\x1b') events.push(key('escape'))
    // A terminal's answer that never finished is dropped, not typed.
    else if (/^\x1b\]\d+;/.test(this.buffer)) { this.buffer = ''; return events }
    // ESC ] and digits that never became one: alt+], and the digits typed.
    else if (this.buffer.startsWith('\x1b]')) {
      const rest = this.buffer.slice(2)
      this.buffer = ''
      events.push(key('char', { ch: ']', alt: true }), ...this.feed(rest))
      return events
    }
    else if (this.buffer.startsWith('\x1b')) {
      // An unfinished sequence that will never finish: treat ESC as a key and re-feed the rest.
      const rest = this.buffer.slice(1)
      this.buffer = ''
      events.push(key('escape'), ...this.feed(rest))
      return events
    }
    this.buffer = ''
    return events
  }

  /** Whether a lone ESC or a partial sequence is waiting for `flush()`. */
  get pending(): boolean {
    return this.buffer.length > 0 && this.pasting === null
  }

  /**
   * The wait is over and what waits is an ESC alone or the start of a CSI or SS3 sequence: the escape key, and what
   * followed the ESC handed back, for the caller to complete with what comes next or to type. Null for anything else
   * (which `flush()` takes).
   */
  escapeHeld(): { event: KeyEvent; rest: string } | null {
    const m = /^\x1b(\[[\d;<]*|O)?$/.exec(this.buffer)
    if (m === null || this.pasting !== null) return null
    this.buffer = ''
    return { event: key('escape'), rest: m[1] ?? '' }
  }

  private one(events: InputEvent[]): number {
    const b = this.buffer
    const c = b[0]
    if (c !== '\x1b') {
      events.push(this.plain(b.codePointAt(0)!))
      return String.fromCodePoint(b.codePointAt(0)!).length
    }
    if (b.length === 1) return 0
    // Two Escs, or an ESC before a sequence not here yet: wait (flush makes the first one Esc and goes on).
    if (b === '\x1b\x1b') return 0
    if (b.startsWith(PASTE_BEGIN)) { this.pasting = ''; return PASTE_BEGIN.length }

    if (b[1] === '[') {
      // SGR mouse: ESC [ < b ; x ; y (M|m)
      if (b[2] === '<') {
        const m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(b)
        if (m === null) return /^\x1b\[<[\d;]*$/.test(b) ? 0 : this.junk(b)
        events.push(this.mouse(Number(m[1]), Number(m[2]) - 1, Number(m[3]) - 1, m[4] === 'm'))
        return m[0].length
      }
      // rxvt ends home, end and the like with ^ (ctrl), $ (shift) or @ (both) where xterm has ~ and a modifier.
      const m = /^\x1b\[([\d;]*)([A-Za-z~^$@])/.exec(b)
      if (m === null) return /^\x1b\[[\d;]*$/.test(b) ? 0 : this.junk(b)
      const [, params, final] = m
      const parts = params.split(';')
      if (final === '~' || final === '^' || final === '$' || final === '@') {
        const name = CSI_TILDE[parts[0]]
        const rxvt = { ctrl: final === '^' || final === '@', alt: false, shift: final === '$' || final === '@' }
        if (name !== undefined) events.push(key(name, final === '~' ? mods(parts[1]) : rxvt))
      } else if (final === 'u') {
        // CSI u (kitty / fixterms): codepoint ; modifiers
        const cp = Number(parts[0])
        const m2 = mods(parts[1])
        if (cp === 13) events.push(key('enter', m2))
        else if (cp === 27) events.push(key('escape', m2))
        else if (cp === 9) events.push(key('tab', m2))
        else if (cp === 127) events.push(key('backspace', m2))
        else if (cp >= 32) events.push(key('char', { ...m2, ch: String.fromCodePoint(cp) }))
      } else if (final === 'Z') {
        events.push(key('tab', { shift: true }))
      } else if (CSI_LETTER[final] !== undefined) {
        events.push(key(CSI_LETTER[final], mods(parts[1])))
      }
      return m[0].length
    }
    if (b[1] === ']') {
      // An operating system command, as the answer to QUERY_BACKGROUND: ESC ] digits ; … ended by BEL or ST.
      // ESC ] and digits so far may be one, or alt+] and digits typed: wait (flush says which); ESC ] and
      // anything else is alt+].
      if (/^\x1b\]\d*$/.test(b)) return 0
      if (/^\x1b\]\d+;/.test(b)) {
        const bel = b.indexOf('\x07')
        const st = b.indexOf('\x1b\\', 2)
        const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st)
        if (end === -1) return 0
        const background = backgroundFrom(b.slice(2, end))
        if (background !== null) events.push({ type: 'background', background })
        return end + (end === bel ? 1 : 2)
      }
    }
    // ESC before a key's own sequence, as rxvt sends alt+arrows (ESC ESC [ D): that key, with alt.
    if (b[1] === '\x1b' && (b[2] === '[' || b[2] === 'O')) {
      const inner: InputEvent[] = []
      this.buffer = b.slice(1)
      const n = this.one(inner)
      this.buffer = b
      if (n === 0) return 0
      for (const e of inner) if (e.type === 'key' || e.type === 'mouse') e.alt = true
      events.push(...inner)
      return 1 + n
    }
    if (b[1] === 'O') {
      if (b.length < 3) return 0
      const name = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end' }[b[2]]
      if (name !== undefined) events.push(key(name))
      return 3
    }
    // ESC followed by a plain key: Alt+key.
    const cp = b.codePointAt(1)!
    const inner = this.plain(cp)
    if (inner.type === 'key') { inner.alt = true; events.push(inner) }
    return 1 + String.fromCodePoint(cp).length
  }

  /** An escape sequence we cannot parse: drop ESC and the introducer, keep going. */
  private junk(b: string): number {
    return Math.min(2, b.length)
  }

  private plain(cp: number): KeyEvent {
    if (cp === 13 || cp === 10) return key('enter')
    if (cp === 9) return key('tab')
    if (cp === 127 || cp === 8) return key('backspace')
    if (cp === 0) return key('char', { ch: ' ', ctrl: true })
    if (cp < 27) return key('char', { ch: String.fromCharCode(cp + 96), ctrl: true })
    return key('char', { ch: String.fromCodePoint(cp) })
  }

  private mouse(code: number, x: number, y: number, release: boolean): MouseEvent {
    const base = { type: 'mouse' as const, x, y, shift: (code & 4) !== 0, alt: (code & 8) !== 0, ctrl: (code & 16) !== 0 }
    if ((code & 64) !== 0) return { ...base, action: 'wheel', button: (code & 1) === 0 ? -1 : 1 }
    const button = code & 3
    if ((code & 32) !== 0) return { ...base, action: button === 3 ? 'move' : 'drag', button }
    return { ...base, action: release ? 'up' : 'down', button }
  }
}
