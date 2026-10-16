/**
 * Hand-written declarations for the DeepSeek Harness services this plugin uses.
 *
 * The distribution ships no `.d.ts` files — the only type sources are JSDoc inside
 * `lib/types/*.js`, the package READMEs, and the runtime itself. Without these,
 * `ctx.get('agents')` is `any` and every call on it is unchecked: a wrong method name, a
 * wrong arity, or a wrong assumption about sync versus async all compile.
 *
 * They were written from the shipped documentation and from what this repository learned
 * by running against the real services (see docs/harness-api-notes.md and the notes beside
 * each call). Writing them from the documentation rather than from the call sites is the
 * point: the compiler then reports where this plugin disagrees with what the harness says,
 * which is how the transport interface found three mismatches, one of them a real bug.
 *
 * Scope: only what is used, declared loosely enough to be honest about the rest.
 */

/** Opaque to this plugin: passed back to the service that made it. */
export type Opaque = unknown

export interface SessionHeader {
  id: string
  cwd?: string
  [key: string]: unknown
}

/** One durable log event, read by sequence. */
export interface SessionEvent {
  type: string
  data?: Record<string, any>
}

export interface Session {
  header: SessionHeader
  seq: number
  eventAt(seq: number): SessionEvent | undefined
}

export interface Agent {
  session: Session
  /** Queue an ordinary next-turn prompt and wake the driver. */
  followup(message: Opaque): void
  /** Submit steering input to a running turn, when the composition supports it. */
  steer?(message: Opaque): void
  /** Inject model-facing context without making it a user message. */
  inject?(message: Opaque): void
  /**
   * Abort the in-flight turn. Clears the inbox by default; `keepInbox` keeps queued work.
   * Documented as `cancel()` on the Agent, and used here with a cause string.
   */
  cancel?(cause?: string | { kind: string }, options?: { keepInbox?: boolean }): void
  /** Resolves when the agent has nothing left to do. */
  whenIdle(): Promise<void>
  /** The agent's id, which is its session's. */
  id?: string
  /**
   * The agent's own Cordis context, when the composition exposes one: its listeners go with the agent (an
   * `agent/request` waterfall, run outermost first, `prepend` first of all), and its system prompt's sections.
   */
  ctx?: {
    on?(name: 'agent/request', listener: (payload: unknown, next: () => Promise<Record<string, unknown>>) => Promise<Record<string, unknown>>, options?: { prepend?: boolean }): unknown
    systemPrompt?: { section?(section: { name: string; order: number; interpolate: boolean; text: string }): unknown }
  }
}

export interface AgentHandle {
  agent: Agent
  dispose?(): Promise<void> | void
}

export interface AgentsService {
  create(options: {
    sessionId?: string
    meta?: Record<string, unknown>
    agentOptions?: unknown
    setup?: (ctx: unknown) => Promise<void> | void
  }): Promise<AgentHandle>
  resume(options: {
    resumeSessionId: string
    agentOptions?: unknown
    setup?: (ctx: unknown) => Promise<void> | void
  }): Promise<AgentHandle>
  /** The live agent on a session, whoever made it. */
  get?(id: string): Agent | undefined
  /** Every live agent. */
  list?(): Agent[]
}

export interface SessionsService {
  /** Commit buffered session events to the durable log. */
  flush(session: Session): Promise<void>
}

export interface AgentPresetsService {
  /** Throws `agent-preset/not-found` for an unknown id; no argument means the default. */
  resolve(id?: string): Promise<{ id: string; [key: string]: unknown }>
  /**
   * Retain a preset scope for a session's lifetime. The returned value is an
   * `AsyncDisposable` and has NO `dispose()` method — this plugin assumed one once.
   */
  acquireScope(id?: string): { key: unknown } & AsyncDisposable
  /** Mount the preset's plugins into an agent's context; this is what gives it tools. */
  mount(ctx: unknown, id?: string): Promise<void>
}

export interface PermissionPresetSpec {
  sandbox: string
  approval: string
  name?: string
  description?: string
}

export interface PermissionPresetsService {
  /** Synchronous, and throws for an unknown name. */
  resolve(name: string): PermissionPresetSpec
  /** Synchronous durable write of both knobs for one session. */
  set(session: Session, name: string): void
  readonly defaultPreset: string
}

export interface CredentialsService {
  /**
   * Resolves a reference to a secret. The result is a wrapper, not a bare string — the
   * first version of this declaration said `Promise<string>` and the compiler pointed at
   * `r?.value` in the caller, which was right and the declaration was wrong.
   */
  resolve(ref: string): Promise<{ value: string } | undefined>
  /** Whether a reference is set, and where from — never the value. An empty value counts as not set. */
  describe?(ref: string): Promise<{ configured: boolean; source?: string; writable: boolean }>
}

export interface WorkspaceEntity {
  path?: string
  /** Compares the realpath of the session header's cwd against the workspace path. */
  attachSession(sessionId: string): Promise<void>
}

export interface WorkspaceRegistryService {
  create(path: string, title?: string): Promise<WorkspaceEntity | undefined>
}

export interface SessionProjectionsService {
  /** `values` holds the registered client-visible units, e.g. `tokenUsage`. */
  snapshot(session: Session, keys?: unknown): { asOfSeq?: number; values: Record<string, any> }
}

/** The attachment seam: images are admitted here before a prompt carries them. */
export interface AttachmentsService {
  saveImages(inputs: Array<{ data: Uint8Array; mediaType: string; name?: string }>): Promise<unknown[]>
}

/**
 * The model default for new sessions. Only the fields this plugin reads are declared —
 * it never sets a default, it reports what the deployment chose.
 */
export interface AgentDefaultModelService {
  /** Read the current default selection; detached, and the same one create and resume use. */
  currentSelection(): { provider?: string; model?: string; reasoningEffort?: string }
}

/**
 * The model-call service (`@deepseek-ai/dsh-llm`, registered as `llm`): only what /model reads.
 * Verified against 0.2.0-rc.2's lib/index.js; not in the plugin's `inject`, so a deployment without
 * it still activates and /model says it cannot list models.
 */
export interface LlmService {
  /** Provider routes with a registered adapter, in registration order. */
  listProviders(): Array<{ id?: string; provider?: string; [key: string]: unknown }>
  /** The models an adapter advertises; may be empty for an adapter with no catalog. */
  listModels(provider: string): Promise<Array<{ provider: string; id: string; name: string; description?: string }>>
  /** One exact model's metadata, with the reasoning efforts it takes when it has any. */
  resolveModelInfo(provider: string, model: string): Promise<{ reasoning?: { efforts: Array<{ id: string; name: string }>; defaultEffort?: string } }>
  /**
   * One model call, as raw chunks: `text-delta` chunks carry its text, `finish` ends it — with `reason.kind` 'error'
   * and its failure when the call failed, which is not thrown (verified against the bundled dsh-llm's `stream(options)`
   * and `adapterFailureChunk`). `reasoningEffort` and `maxTokens` are the call's controls. `signal` aborts it.
   */
  stream?(options: { provider: string; model: string; messages: unknown[]; reasoningEffort?: string; maxTokens?: number; signal?: AbortSignal }): AsyncIterable<{ type?: string; text?: string; reason?: { kind?: string; failure?: { code?: string; message?: string } } }>
  /** Every provider a configuration can address, with where its settings sit: `settingsPath` inside namespace `settingsNs`. */
  listConfigurableProviders?(): Array<{ provider: string; displayName: string; settingsNs: string; settingsPath: string[] }>
}

/** The settings service, read only: each namespace's resolved configuration, secrets redacted. */
export interface SettingsService {
  describe(options: { redactSecrets: boolean }): Array<{ ns: string; value: unknown }>
}

/** Query surface over the durable session log; used loosely for reporting. */
export interface SessionQueryService {
  [key: string]: any
}

/** The filesystem seam, used only to discover the session directory. */
export interface FileSystemService {
  [key: string]: any
}
