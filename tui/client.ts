/**
 * The terminal's end of the socket: find the gateway, connect, say hello, and keep reconnecting.
 *
 * A gateway restart (a deploy, launchd bringing it back) must not end the terminal session, so
 * a dropped connection is retried with backoff and the same conversation is asked for again —
 * which is also how replies that arrived meanwhile are collected. While disconnected nothing is
 * queued behind the user's back: a send is refused and the screen says so.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { connect as dial, type Socket } from 'node:net'
import { join } from 'node:path'
import { discoveryDir, encode, FrameReader, MAX_FRAME_BYTES, PROTOCOL_VERSION, type ClientFrame, type ServerFrame } from './protocol.js'
import { t } from './strings.js'

export type ConnectionState = 'connecting' | 'connected' | 'disconnected'

export interface ConnectionOptions {
  /**
   * Where the gateway listens, or how to look it up: a function is asked again on every attempt,
   * and its null (no live gateway) is an attempt that failed, retried as a dropped one is.
   */
  socketPath: string | (() => string | null)
  conversation?: string
  tenant?: string
  onFrame(frame: ServerFrame): void
  onState(state: ConnectionState, detail?: string): void
  /** A switch to another conversation was refused; the previous one is still the conversation. */
  onRollback?(message: string): void
  /** Injectable for tests. */
  dial?: (path: string) => Socket
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

const BACKOFF_MS = [250, 500, 1000, 2000, 5000]
/**
 * How long a connected gateway has to answer the hello. It answers a local socket in milliseconds; one that took
 * the connection and says nothing (hung, or something else listening there) is a failed connect, retried.
 */
const HELLO_MS = 10_000

/**
 * Why a frame cannot be sent whole, or null when it can: the gateway's reader drops a line over
 * MAX_FRAME_BYTES, and with it the text, so it is refused here, with the text still in the box.
 */
export function tooLarge(frame: ClientFrame): string | null {
  const bytes = Buffer.byteLength(encode(frame))
  if (bytes <= MAX_FRAME_BYTES) return null
  const mb = (n: number) => (n / (1024 * 1024)).toFixed(n % (1024 * 1024) === 0 ? 0 : 1)
  return t().tooLarge(mb(bytes), mb(MAX_FRAME_BYTES))
}

export class Connection {
  private socket: Socket | null = null
  private ready = false
  private closed = false
  private attempt = 0
  private timer: unknown = null
  private helloTimer: unknown = null
  /** Why the last attempt failed, when the screen should say: shown with the wait and the next "connecting". */
  private failed: string | undefined
  /** The conversation the gateway confirmed; asked for again on every reconnect. */
  conversation: string | null
  /** The tenant workspace this terminal talks in, or undefined for the home. */
  tenant: string | undefined
  /**
   * A switch asked for and not yet confirmed. It becomes the conversation on `ready`; a refused
   * hello drops it, so the terminal and the gateway never disagree about where a message goes.
   */
  private pending: { conversation: string | null; tenant: string | undefined } | null = null
  private readonly o: ConnectionOptions

  constructor(options: ConnectionOptions) {
    this.o = options
    this.conversation = options.conversation ?? null
    this.tenant = options.tenant
  }

  get connected(): boolean {
    return this.ready
  }

  start(): void {
    this.closed = false
    this.open()
  }

  /** Send a frame; false when there is no connection to send it on, or it is too large to be read (`tooLarge`). */
  send(frame: ClientFrame): boolean {
    const line = encode(frame)
    if (!this.ready || this.socket === null || Buffer.byteLength(line) > MAX_FRAME_BYTES) return false
    this.socket.write(line)
    return true
  }

  /**
   * Talk in another conversation on the same socket: a new one (null) or one to resume. The
   * choice is remembered, so a reconnect asks for it again.
   */
  switchTo(conversation: string | null, tenant?: string): void {
    this.pending = { conversation, tenant }
    // Not connected: the next hello asks for it, and its answer confirms or refuses it.
    if (!this.ready || this.socket === null) return
    this.socket.write(encode(this.hello()))
  }

  close(): void {
    this.closed = true
    if (this.timer !== null) (this.o.clearTimer ?? clearTimeout)(this.timer as ReturnType<typeof setTimeout>)
    this.timer = null
    this.stopHelloTimer()
    this.socket?.destroy()
    this.socket = null
    this.ready = false
  }

  private hello(): ClientFrame {
    const want = this.pending ?? { conversation: this.conversation, tenant: this.tenant }
    const hello: Extract<ClientFrame, { type: 'hello' }> = { type: 'hello', version: PROTOCOL_VERSION }
    if (want.conversation !== null) hello.conversation = want.conversation
    if (want.tenant !== undefined) hello.tenant = want.tenant
    return hello
  }

  private open(): void {
    if (this.closed) return
    this.o.onState('connecting', this.failed)
    // Said once more, with this try; it fails, if it does, for a reason of its own.
    this.failed = undefined
    const path = typeof this.o.socketPath === 'function' ? this.o.socketPath() : this.o.socketPath
    if (path === null) { this.retry(); return }
    const socket = (this.o.dial ?? dial)(path)
    this.socket = socket
    const reader = new FrameReader()
    socket.setEncoding('utf8')
    // Each hello before ready (the first, and one sent again after a refused switch) has HELLO_MS for an answer.
    const sayHello = () => {
      socket.write(encode(this.hello()))
      this.stopHelloTimer()
      this.helloTimer = (this.o.setTimer ?? setTimeout)(() => {
        this.helloTimer = null
        this.failed = t().noAnswer(HELLO_MS / 1000)
        socket.destroy()
      }, HELLO_MS)
    }
    socket.on('connect', sayHello)
    socket.on('data', (chunk: string) => {
      // The gateway is answering.
      this.stopHelloTimer()
      for (const r of reader.push(chunk)) {
        // A line it could not read (too large, not JSON) is said, not dropped in silence.
        if (r.frame === undefined) { this.o.onFrame({ type: 'error', code: 'unreadable', message: t().unreadable(r.error) }); continue }
        const frame = r.frame as unknown as ServerFrame
        if (frame.type === 'ready') {
          this.ready = true
          this.attempt = 0
          this.conversation = frame.conversation
          // The gateway's word on the workspace wins: a resumed conversation keeps its own tenant.
          this.tenant = frame.tenant ?? undefined
          this.pending = null
          this.o.onState('connected')
        } else if (frame.type === 'error' && frame.hello === true) {
          if (this.pending !== null) {
            this.pending = null
            this.o.onRollback?.(frame.message)
            // Before any ready this connection has no conversation yet: ask for the one it had.
            if (!this.ready) sayHello()
          } else if (!this.ready) {
            this.o.onState('disconnected', t().refused(frame.message))
          }
        }
        this.o.onFrame(frame)
      }
    })
    socket.on('error', () => { /* reported by close */ })
    socket.on('close', () => {
      if (this.socket !== socket) return
      this.stopHelloTimer()
      this.socket = null
      this.ready = false
      if (this.closed) return
      this.retry()
    })
  }

  private stopHelloTimer(): void {
    if (this.helloTimer !== null) (this.o.clearTimer ?? clearTimeout)(this.helloTimer as ReturnType<typeof setTimeout>)
    this.helloTimer = null
  }

  /** Wait the backoff, then try again; the screen counts the wait down in seconds, after why the last try failed. */
  private retry(): void {
    const why = this.failed
    const now = this.o.now ?? Date.now
    const due = now() + BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]
    this.attempt++
    const tick = () => {
      if (this.closed) return
      const left = due - now()
      if (left <= 0) { this.timer = null; this.open(); return }
      const seconds = Math.ceil(left / 1000)
      this.o.onState('disconnected', why === undefined ? t().reconnectingIn(seconds) : `${why} · ${t().reconnectingIn(seconds)}`)
      // On to where the shown second changes, or to the try.
      this.timer = (this.o.setTimer ?? setTimeout)(tick, left - (seconds - 1) * 1000)
    }
    tick()
  }
}

export interface Discovery {
  socket: string
  name: string
  pid: number
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

/**
 * Which gateway to talk to: the one registered under `name`, or — when no name was asked for and
 * there is exactly one live gateway — that one. Returns an error message instead of guessing.
 */
export function discover(name: string | undefined, env: Record<string, string | undefined> = process.env): Discovery | { error: string } {
  const dir = discoveryDir(env)
  const read = (file: string): Discovery | null => {
    try {
      const d = JSON.parse(readFileSync(join(dir, file), 'utf8'))
      return typeof d?.socket === 'string' && typeof d?.pid === 'number' && alive(d.pid) && existsSync(d.socket)
        ? { socket: d.socket, name: String(d.name ?? file.replace(/\.json$/, '')), pid: d.pid }
        : null
    } catch { return null }
  }
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : []
  const live = files.map(read).filter((d): d is Discovery => d !== null)
  if (name !== undefined) {
    const hit = live.find((d) => d.name === name)
    return hit ?? { error: t().noGatewayNamed(name, live.map((d) => d.name)) }
  }
  const named = live.find((d) => d.name === 'default')
  if (named !== undefined) return named
  if (live.length === 1) return live[0]
  if (live.length === 0) return { error: t().noGateway(dir) }
  return { error: t().severalGateways(live.map((d) => d.name)) }
}

/**
 * How a terminal that found its gateway through discovery reaches it on every attempt: looked up
 * again by name, since a restarted gateway may listen somewhere else (on Windows its pipe is named
 * anew). With no live gateway registered, the last path is dialed again as before, except on
 * Windows: another user may hold that pipe name by then, so nothing is dialed.
 */
export function lookup(name: string, last: string, platform: string = process.platform): () => string | null {
  let known = last
  return () => {
    let found: Discovery | { error: string }
    try { found = discover(name) } catch (e) { found = { error: String((e as Error)?.message ?? e) } }
    if (!('error' in found)) return (known = found.socket)
    return platform === 'win32' ? null : known
  }
}
