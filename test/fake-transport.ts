/**
 * A transport that talks to nothing.
 *
 * This is the point of the transport seam: the core — thread→session mapping, the
 * channel allowlist, de-duplication, the history delta, progress replacement, the
 * failure paths — can be exercised in CI with no platform account and no network.
 * The Slack transport is exercised the same way by the reconnect and delivery
 * suites, which mock fetch and the websocket.
 *
 * Every interaction is recorded so a test can assert on what the core asked for
 * rather than on what a platform happened to reply.
 */
import type { ActionButton, AttachmentManifest, InboundMessage, ProgressMark, StreamFrame, Target, Transport } from '../types/transport.ts'

/** What a suite can ask of the fake; each is off unless given. */
export interface FakeTransportOptions {
  supportsButtons?: boolean
  typing?: boolean
  typingRefusedAfterMs?: number
  upload?: boolean | 'fail'
  remove?: boolean
  /** Reactions on the person's message, as Slack has them: every mark is recorded. */
  marks?: boolean
  /** The platform refuses the turn's answer (`answer: true`): its post returns null. */
  refuseAnswer?: boolean
  /** Streaming as Slack has it: every frame is recorded. `'refused'`: the platform refused it for good. */
  stream?: boolean | 'refused'
  postDelayMs?: number
  history?: { text: string; lastTs: string | null }
  attachments?: AttachmentManifest
}

/** The Transport interface, what the fake recorded, and the parts a suite replaces. */
export interface FakeTransport extends Transport {
  posted: Array<{ target: Target; text: string; replace: string | null; buttons: ActionButton[] | null }>
  historyCalls: Array<{ target: Target; currentTs: string; sinceTs: string | null; limit: number; maxChars: number }>
  attachmentCalls: Array<{ message: InboundMessage; stamp: string }>
  typing: Array<{ target: Target; stopped: boolean }>
  removed: Array<{ target: Target; ts: string }>
  marks: Array<{ target: Target; ts: string; state: ProgressMark }>
  /** Marks that came for a message after its end mark: none should. */
  lateMarks: Array<{ ts: string; state: ProgressMark }>
  frames: Array<{ target: Target; frame: StreamFrame }>
  uploads: Array<{ target: Target; filePath: string; title?: string; bytes: string | null }>
  readonly closed: number
  deliver(message: InboundMessage): void
  message(overrides?: Partial<InboundMessage>): InboundMessage
  press(id: string, user?: string): void
  claims?(target: Target): boolean
  hasSocket(): boolean
  authenticate(): Promise<void>
  ready(): boolean
}

export function createFakeTransport(options: FakeTransportOptions = {}): FakeTransport {
  const posted: FakeTransport['posted'] = []
  const historyCalls: FakeTransport['historyCalls'] = []
  const attachmentCalls: FakeTransport['attachmentCalls'] = []
  const typing: FakeTransport['typing'] = []
  const removed: FakeTransport['removed'] = []
  const marks: FakeTransport['marks'] = []
  const lateMarks: FakeTransport['lateMarks'] = []
  const frames: FakeTransport['frames'] = []
  const uploads: FakeTransport['uploads'] = []
  let onMessage = null
  let onAction = null
  let closed = 0
  let socket = true

  return {
    // The platform's link for a conversation; the plugin asks when it knows the origin.
    permalinkFor: (target, label) => (target?.threadTs
      ? `<https://ws.example/archives/${target.channel}/p${String(target.threadTs).replace('.', '')}|${label ?? 'this thread'}>`
      : null),
    // ── recorded interactions ───────────────────────────────────────────────
    posted,
    historyCalls,
    attachmentCalls,
    typing,
    removed,
    marks,
    lateMarks,
    frames,
    uploads,
    get closed() { return closed },
    /** Push an inbound message as if the platform had delivered it. */
    deliver(message) {
      if (onMessage === null) throw new Error('fake transport is not connected')
      onMessage(message)
    },
    /** A platform-shaped message, with the boring fields filled in. */
    message(overrides = {}) {
      return {
        eventId: `evt-${posted.length}-${historyCalls.length}-${Math.random().toString(36).slice(2, 8)}`,
        target: { channel: 'C_ALLOWED', threadTs: 't1' },
        ts: '1000.1',
        text: 'hello',
        user: 'U_USER',
        addressed: true,
        files: [],
        raw: {},
        ...overrides,
      }
    },

    // ── the Transport interface ─────────────────────────────────────────────
    async identity() { return { name: 'fakebot', id: 'U_FAKE', team: 'T_FAKE' } },
    async connect(handlers) { onMessage = handlers.onMessage; onAction = handlers.onAction ?? null },
    supportsButtons: options.supportsButtons ?? false,
    // Native typing, only when asked for: the default fake is a platform without it, like Slack.
    ...(options.typing === true ? {
      startTyping(target, onUnavailable) {
        const entry = { target, stopped: false }
        typing.push(entry)
        // typingRefusedAfterMs: the platform refuses the indicator, and says so that much later — at once
        // for 0, as a transport does when it already knows (Slack remembers a lasting refusal).
        if (options.typingRefusedAfterMs === 0) onUnavailable?.()
        else if (Number.isFinite(options.typingRefusedAfterMs)) setTimeout(() => onUnavailable?.(), options.typingRefusedAfterMs)
        return () => { entry.stopped = true }
      },
    } : {}),
    // Uploading a file into the conversation, only when asked for, like Slack's files API.
    ...(options.upload === true || options.upload === 'fail' ? {
      async uploadFile(target, filePath, title, bytes) { uploads.push({ target, filePath, title, bytes: bytes === undefined ? null : Buffer.from(bytes).toString('utf8') }); return options.upload === true },
    } : {}),
    ...(options.marks === true ? {
      mark(target, ts, state) {
        if (marks.some((m) => m.ts === ts && !['seen', 'working'].includes(m.state.kind))) lateMarks.push({ ts, state })
        marks.push({ target, ts, state })
      },
    } : {}),
    ...(options.stream !== undefined && options.stream !== false ? {
      stream(target, frame) { frames.push({ target, frame }) },
      streamUnavailable: options.stream === 'refused',
    } : {}),
    // Deleting a message, only when asked for, like Slack's chat.delete.
    ...(options.remove === true ? {
      async remove(target, ts) { removed.push({ target, ts }); return true },
    } : {}),
    /** Press a button, as a platform would. */
    press(id, user = 'U_USER') {
      if (onAction === null) throw new Error('fake transport received no onAction handler')
      onAction({ id, target: { channel: 'C_ALLOWED', threadTs: 't1' }, user })
    },
    async post(target, text, opts = {}) {
      if (options.refuseAnswer === true && opts.answer === true) return null
      posted.push({ target, text, replace: opts.replace ?? null, buttons: opts.buttons ?? null })
      const ts = `ts-${posted.length}`
      // A real post takes time, and the races between a working message and its answer only exist
      // while one is in flight. Recorded first, so the order of requests is still the order of calls.
      if (Number(options.postDelayMs) > 0) await new Promise((r) => setTimeout(r, Number(options.postDelayMs)))
      return { channel: target.channel, ts }
    },
    async fetchHistory(target, opts) {
      historyCalls.push({ target, ...opts })
      return options.history ?? { text: '', lastTs: null }
    },
    async fetchAttachments(message, stamp) {
      attachmentCalls.push({ message, stamp })
      return options.attachments ?? { text: '' }
    },
    async close() { closed++; socket = false; return true },
    hasSocket() { return socket },
    async authenticate() {},
    ready() { return true },
  }
}
