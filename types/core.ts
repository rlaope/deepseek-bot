/**
 * Shapes the core passes around.
 *
 * These were previously inferred, which meant a caller reading `.sessionId` off a
 * turn result compiled as long as nothing else forced a check — and the two bugs
 * TypeScript found on the first run were exactly this class: a function returning
 * `string` on one path and an object on another, and a property that was written
 * but never declared.
 */

/** Why a turn ended. `kind` is 'completed' for a normal finish. */
export interface TurnReason {
  kind: string
  [key: string]: unknown
}

/** What one turn produced, read back out of the session log. */
export interface TurnSummary {
  text: string
  reason: TurnReason | null
  toolsUsed: string[]
}

/** The same, plus the session it happened in. */
export interface TurnOutcome extends TurnSummary {
  sessionId: string
  /** A stop for this turn was already reported to the conversation, so the turn says nothing more. */
  reported?: boolean
  /** The conversation's session log was gone, and the turn ran in a new session. */
  sessionLost?: boolean
  /** The turn's agent owned a background job and could not be kept (maxKeptAgents, or past backgroundKeepMs): released,
   * the job stopped with it. What to tell the conversation, after the answer. */
  jobsStopped?: string
}

/** Where a message came from: the transport's idea of a conversation. */
export interface Origin {
  channel: string
  /** null on platforms without threads: the session is per conversation. */
  threadTs: string | null
  /** Who wrote the message, in platform terms, when a person did. */
  user?: string
  /** The message did not mention the bot (replyMode 'thread'): the turn may answer "[no reply]" and post nothing. */
  quiet?: boolean
}
