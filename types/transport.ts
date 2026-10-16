/**
 * The transport seam.
 *
 * A platform supplies inbound events, outbound messages, history, attachments and
 * its own identity. Everything else — thread→session mapping, the turn loop, the
 * recall refresh, standing-context gating, watches, reminders, health — is core and
 * must not know which platform it is serving.
 *
 * This is a type rather than prose because the compiler is what enforces it across
 * transports. The Slack transport does not satisfy it yet: its functions still take
 * a token as the first argument, because the first extraction step was deliberately
 * mechanical. Reshaping it is the next step, and this file is the target.
 */

/**
 * A file the platform told us about. Deliberately neutral: how to fetch it is the
 * transport's business, and the fields every platform has are the ones here.
 */
export interface AttachmentRef {
  id?: string
  name?: string
  mimetype?: string
  size?: number
}

/** A conversation, in the transport's own terms. */
export interface Target {
  /** Where the message goes: a channel, chat, or guild id. */
  channel: string
  /**
   * The thread or reply chain. null on a platform without threads (a Telegram
   * chat), which makes the session per conversation rather than per thread.
   */
  threadTs: string | null
}

export interface InboundMessage {
  /** Stable identity for de-duplication across reconnects. */
  eventId: string
  target: Target
  /** The platform timestamp of this message. */
  ts: string
  text: string
  /** Who wrote it, in platform terms. */
  user: string
  /** True when the agent was addressed directly rather than observing chatter. */
  addressed: boolean
  files: AttachmentRef[]
  /** The platform's own payload, for a transport that needs to look deeper. */
  raw: unknown
  /** The id the sender gave the message (the terminal does), so it can take it back while it waits. */
  clientId?: string
}

/**
 * A button on a message. Platforms that can render one use it for decisions a person
 * makes in place — an approval, for instance — instead of asking for a reply.
 */
export interface ActionButton {
  /** Round-trips to `onAction`; the caller decides what it means. */
  id: string
  label: string
  style?: 'primary' | 'danger' | 'secondary'
}

/** A button press, as the transport reports it. */
export interface ActionEvent {
  id: string
  target: Target
  user: string
}

/** A rendered message the transport has already sent, so it can be replaced. */
export interface PostedMessage {
  channel: string
  ts: string
}

export interface AttachmentManifest {
  /** Prompt-ready text describing what was fetched, or '' when there was nothing. */
  text: string
  /**
   * Images the model can be shown, when the transport downloaded any. The core
   * admits these through the attachment service so a screenshot reaches the model
   * as a picture rather than as a filename.
   */
  images?: Array<{ name?: string; mediaType: string; bytes: Buffer }>
}

/**
 * Live progress of a turn, for a platform that can show it as it happens: text as the model
 * writes it, `reset` when the current model call failed and is being retried (drop what it
 * streamed), and `tool` for a tool call between two stretches of text.
 */
export type StreamFrame =
  | { kind: 'text'; text: string }
  | { kind: 'reset' }
  /** The model's reasoning, apart from the answer. */
  | { kind: 'thinking'; text: string }
  /**
   * A tool call: the tool's own title for it when it has one, and an edit as the part that changed —
   * the lines before and after it that both texts share are not sent; a side with no lines is null.
   * A change too long to send whole is cut at a line and marked (`oldCut`, `newCut`): a cut side
   * makes the other side's unmatched lines uncertain.
   */
  | { kind: 'tool'; name: string; callId?: string; title?: string; diff?: Array<{ path: string; old: string | null; new: string | null; oldCut?: boolean; newCut?: boolean }> }
  /** A call's result, by its call id: whether it failed, and its text (cut). */
  | { kind: 'tool.result'; callId: string; ok: boolean; text: string; lines?: number }

/** A message's progress, shown on the message itself: see `Transport.mark`. */
export type ProgressMark =
  | { kind: 'seen' }
  | { kind: 'working'; tenths: number }
  | { kind: 'done' }
  | { kind: 'failed' }
  | { kind: 'stopped' }

/** A question a turn asks the person (the ask_user_question tool, a plan review). */
export interface QuestionItem {
  id: string
  question: string
  header?: string
  options: Array<{ label: string; description?: string }>
  multiSelect: boolean
  /** The plan under review, for a `plan-review` question. */
  detail?: string
  intent?: { kind: string; approve?: string }
}

/** One answer per question: the labels picked, and/or the person's own words. */
export interface QuestionAnswer {
  id: string
  selected: string[]
  custom?: string
}

export interface TransportStatus {
  connected: boolean
  detail?: string
}

export interface Transport {
  /** Human-readable name and the platform's own id for this bot. */
  identity(): Promise<{ name: string; id: string; team?: string }>

  /** Start receiving. Resolves once the connection is up. */
  connect(handlers: {
    onMessage: (message: InboundMessage) => void
    onStatus: (status: TransportStatus) => void
    /** Button presses, on transports that have them. */
    onAction?: (action: ActionEvent) => void
  }): Promise<void>

  /** A link to a conversation, when the platform can build one. */
  permalinkFor?(target: Target, label?: string): string | null

  /**
   * Upload a file into the conversation, when the platform supports it. `bytes`, when given, are what
   * is sent — the caller read them from the file it checked — and `filePath` only names the file.
   */
  uploadFile?(target: Target, filePath: string, title?: string, bytes?: Uint8Array): Promise<boolean>

  /**
   * The platform's own working indicator, shown while a turn runs: Discord's and Telegram's "typing…",
   * Slack's thread status. The transport keeps it up until the returned function is called. When the
   * platform refuses it — a missing permission, a feature the workspace has off — the transport calls
   * `onUnavailable`, and the core posts its working message instead.
   */
  startTyping?(target: Target, onUnavailable?: () => void): () => void

  /**
   * A stop withdrew the conversation's waiting messages, these (by the ids their senders gave them; one
   * without gets one of its own). Called before their typing stops, so a platform that shows each
   * waiting message (the terminal) can take it back, and not count its end as a turn's.
   */
  withdrawn?(target: Target, ids: string[]): void

  /** True once the transport knows its indicator will be refused, so the core stops asking. */
  readonly typingUnavailable?: boolean

  /**
   * Progress on the person's own message, where the platform has reactions: taken, how far along (tenths, a
   * rough guess from the time a turn usually takes), and how it ended. Each call replaces the last mark.
   */
  mark?(target: Target, ts: string, state: ProgressMark): void

  /**
   * Delete a message the bot posted, where the platform allows it. With it, the answer arrives as a
   * new message and the working message is removed; without it, the answer edits the working message.
   */
  remove?(target: Target, ts: string): Promise<boolean>

  /**
   * Show a turn's progress live. The finished answer still arrives through `post`, marked
   * `answer: true`, and takes the place of what was streamed.
   */
  stream?(target: Target, frame: StreamFrame): void

  /**
   * Ask the person the turn's questions and wait. Resolves to their answers, null when they
   * dismissed them, or undefined when nobody is there to ask (the core then lets another
   * answerer have the question).
   */
  ask?(target: Target, questions: QuestionItem[], signal?: AbortSignal): Promise<QuestionAnswer[] | null | undefined>

  /** The conversation's turn is over: drop anything that was waiting on it (an unanswered question). */
  turnEnded?(target: Target): void

  /** Whether this transport can render buttons. */
  readonly supportsButtons: boolean

  /**
   * Send, or replace a message already sent (progress turning into the answer).
   * `buttons` is honoured by transports that can render them and ignored by those that
   * cannot — the caller asks, the transport decides.
   */
  post(target: Target, text: string, options?: { replace?: string | null; buttons?: ActionButton[]; answer?: boolean }): Promise<PostedMessage | null>

  /**
   * Messages newer than `sinceTs`, so the adapter can send a delta instead of the
   * whole thread every turn. Returns the newest timestamp it included.
   */
  fetchHistory(target: Target, options: { currentTs: string; sinceTs: string | null; limit: number; maxChars: number }): Promise<{ text: string; lastTs: string | null }>

  /** Download a message's files into the agent home and describe them. */
  fetchAttachments(message: InboundMessage, stamp: string): Promise<AttachmentManifest>

  /**
   * Stop receiving and release the connection.
   * @returns whether a connection was actually open, so callers can say so.
   */
  close(): Promise<boolean>
}
