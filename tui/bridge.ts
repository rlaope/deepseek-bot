/**
 * What the terminal shows besides the conversation, read from the harness: a turn's subagents,
 * its background jobs, and a child's transcript — and the two things a person may do to them,
 * message a child and stop it.
 *
 * Runs in the gateway (the local transport owns it), never in the terminal. Everything here is
 * read from DSH services; nothing is stored. The shapes are the 0.2.0-rc.2 ones recorded in
 * docs/harness-api-notes.md §7, read defensively: a field that is missing makes a row less
 * informative, never an exception.
 */
import { randomUUID } from 'node:crypto'
import { t } from './strings.js'

export interface AgentItem {
  id: string
  label: string
  mode: string
  status: 'running' | 'idle' | 'done'
  /** When the running turn started (epoch ms), so the terminal can count the seconds itself. */
  since: number | null
  settledMs: number
  tokens: number
}

export interface JobItem {
  id: string
  owner: string
  kind: string
  label: string
  status: string
  startedAt: number
  progress: string
}

/** What the conversation's own session has cost so far, and how full its context is. */
export interface Usage {
  tokens: number
  /** Sent (input, cached or not) and received (output), when the harness counts them apart. */
  input?: number
  output?: number
  /** Of the input, what the provider's cache served. */
  cached?: number
  /** Percent of the model's context window in use, or null when the harness does not say. */
  contextPct: number | null
}

export interface ViewLine {
  role: 'user' | 'assistant' | 'tool'
  text: string
}

export interface Services {
  get(name: string): any
  on(name: string, listener: (...args: any[]) => unknown): (() => void) | undefined
}

const MAX_CHILDREN = 20
/** Kept under the protocol's frame limit: a line of a transcript, and a job's output per read. */
const MAX_LINE_CHARS = 8000
const MAX_OUTPUT_CHARS = 200_000

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('')
}

/**
 * The harness records its own injections — instructions, runtime context, the skill catalog, the
 * time — as user-role messages, told apart only by their source kind (seen in a real child log:
 * the task is `user`, the rest are `agent-instructions`, `runtime-context`, `skill-catalog`,
 * `time-context`). A view shows what was said, so only `user` and `model` speak; a message with no
 * source at all is kept, as the recall indexer keeps it.
 */
function spokenBy(event: any, kind: 'user' | 'model'): boolean {
  const source = event?.data?.message?.source?.kind ?? event?.data?.source?.kind ?? null
  return source === null || source === kind
}

function tokensOf(usage: any): number {
  if (usage === null || typeof usage !== 'object') return 0
  return ['uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens']
    .reduce((sum, k) => sum + (Number.isFinite(usage[k]) ? Number(usage[k]) : 0), 0)
}

/** Sent and received apart: the input however it was cached, and the output. Nothing when there is no usage. */
function splitOf(usage: any): { input?: number; output?: number; cached?: number } {
  if (usage === null || typeof usage !== 'object') return {}
  const n = (k: string) => (Number.isFinite(usage[k]) ? Number(usage[k]) : 0)
  return { input: n('uncachedInputTokens') + n('cacheReadTokens') + n('cacheWriteTokens'), output: n('outputTokens'), cached: n('cacheReadTokens') }
}

export function createBridge(services: Services, log: (...parts: unknown[]) => void) {
  const words = t().gateway
  const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max)}… ${words.charsLeftOut(text.length - max)}`)
  const seen = new Set<string>()
  /** The first time a shape is met, it goes to the log — the contract is not published. */
  const firstSight = (what: string, value: unknown) => {
    if (seen.has(what)) return
    seen.add(what)
    try { log(`bridge: first ${what}: ${JSON.stringify(value).slice(0, 400)}`) } catch { /* unserialisable */ }
  }

  /** A child's projections: from its live session when it is resident, otherwise from a read-only lease. */
  async function projectionsOf(id: string): Promise<Record<string, any>> {
    const live = services.get('agents')?.get?.(id)
    const projections = services.get('sessionProjections')
    if (live?.session !== undefined && typeof projections?.snapshot === 'function') {
      try { return projections.snapshot(live.session)?.values ?? {} } catch { /* fall through to a lease */ }
    }
    const query = services.get('sessionQuery')
    if (typeof query?.observeSession !== 'function') return {}
    let lease
    try {
      lease = await query.observeSession(id, { projectionMode: 'all' })
      return lease?.projections?.values ?? {}
    } catch {
      return {}
    } finally {
      try { lease?.[Symbol.dispose]?.() } catch { /* already released */ }
    }
  }

  async function agents(root: string): Promise<AgentItem[]> {
    const subagents = services.get('subagents')
    if (typeof subagents?.listChildren !== 'function') return []
    let children: any[]
    try { children = await subagents.listChildren(root) } catch { return [] }
    if (!Array.isArray(children)) return []
    if (children.length > 0) firstSight('subagent catalog entry', children[0])
    const items: AgentItem[] = []
    for (const child of children.slice(-MAX_CHILDREN)) {
      if (typeof child?.id !== 'string') continue
      const values = await projectionsOf(child.id)
      const timing = values.subagentTiming ?? {}
      if (values.subagentTiming !== undefined) firstSight('subagentTiming', values.subagentTiming)
      const resident = services.get('agents')?.get?.(child.id)
      const running = resident?.status === 'running' || timing.active !== undefined
      items.push({
        id: child.id,
        label: typeof child.label === 'string' && child.label !== '' ? child.label : child.id.slice(0, 12),
        mode: typeof child.mode === 'string' ? child.mode : 'unknown',
        status: running ? 'running' : timing.lastTurnCompleted === true ? 'done' : 'idle',
        since: running && Number.isFinite(timing.active?.since) ? Number(timing.active.since) : null,
        settledMs: Number.isFinite(timing.settledMs) ? Number(timing.settledMs) : 0,
        tokens: tokensOf(values.tokenUsage),
      })
    }
    return items
  }

  /** Jobs owned by the root or any of its children. */
  function jobs(root: string, childIds: string[]): JobItem[] {
    const service = services.get('jobs')
    if (typeof service?.list !== 'function') return []
    const out: JobItem[] = []
    const ids = new Set<string>()
    for (const owner of [root, ...childIds]) {
      let views: any[]
      try { views = service.list(owner) } catch { continue }
      for (const job of Array.isArray(views) ? views : []) {
        if (typeof job?.id !== 'string' || ids.has(job.id) || (job.owner !== undefined && job.owner !== owner)) continue
        ids.add(job.id)
        firstSight('job view', job)
        out.push({
          id: job.id, owner, kind: String(job.kind ?? ''), label: String(job.label ?? ''),
          status: String(job.status ?? 'unknown'), startedAt: Number(job.startedAt ?? 0), progress: String(job.progress ?? ''),
        })
      }
    }
    return out
  }

  return {
    async panel(root: string): Promise<{ agents: AgentItem[]; jobs: JobItem[]; usage: Usage }> {
      const list = await agents(root)
      const values = await projectionsOf(root)
      const pressure = values.contextPressure ?? {}
      const window = Number(pressure.contextWindow)
      const used = Number(pressure.pressureTokens)
      return {
        agents: list,
        jobs: jobs(root, list.map((a) => a.id)),
        usage: {
          tokens: tokensOf(values.tokenUsage),
          ...splitOf(values.tokenUsage),
          contextPct: Number.isFinite(window) && window > 0 && Number.isFinite(used) ? Math.round((used / window) * 1000) / 10 : null,
        },
      }
    },

    /** A child's conversation, read-only: the task it was given, what it said, the tools it used. */
    async transcript(id: string, limit = 60): Promise<ViewLine[]> {
      const query = services.get('sessionQuery')
      if (typeof query?.observeSession !== 'function') return []
      let lease
      try {
        lease = await query.observeSession(id, { projectionMode: 'none' })
        const lines: ViewLine[] = []
        for (const event of lease?.events ?? []) {
          if (event?.type === 'user/message' && spokenBy(event, 'user')) {
            const text = textOf(event.data?.content ?? event.data?.message?.content)
            if (text !== '') lines.push({ role: 'user', text: clip(text, MAX_LINE_CHARS) })
          } else if (event?.type === 'assistant/message' && spokenBy(event, 'model')) {
            const text = textOf(event.data?.message?.content ?? event.data?.content)
            if (text !== '') lines.push({ role: 'assistant', text: clip(text, MAX_LINE_CHARS) })
          } else if (event?.type === 'tool/call') {
            const name = event.data?.name ?? event.data?.toolName ?? event.data?.call?.name
            if (typeof name === 'string') lines.push({ role: 'tool', text: name })
          }
        }
        // Bytes, not characters, are what the frame limit counts (Korean is three per character):
        // keep the newest lines that fit well under it.
        const kept = lines.slice(-limit)
        while (kept.length > 1 && Buffer.byteLength(JSON.stringify(kept)) > 800_000) kept.shift()
        return kept
      } catch {
        return []
      } finally {
        try { lease?.[Symbol.dispose]?.() } catch { /* already released */ }
      }
    },

    /**
     * Message a continuable child. The harness requires its parent agent to be live, and this
     * adapter releases the agent after every turn — so it works while the parent's turn runs.
     * Returns an error to show, or null.
     */
    async send(root: string, child: string, text: string): Promise<string | null> {
      const subagents = services.get('subagents')
      if (typeof subagents?.prompt !== 'function') return words.noSubagentMessaging
      const running = services.get('agents')?.get?.(child)?.status === 'running'
      try {
        await subagents.prompt({
          requestId: randomUUID(), parentSessionId: root, childSessionId: child, mode: 'continuable',
          delivery: running ? 'steer' : 'queue', content: [{ type: 'text', text }],
        }, AbortSignal.timeout(15000))
        return null
      } catch (e) {
        const code = String((e as { code?: string })?.code ?? '')
        if (code.includes('parent-unavailable')) return words.parentNotRunning
        if (code.includes('not-resumable') || code.includes('unauthorized')) return words.notResumable
        return words.notSent(String((e as Error)?.message ?? e).slice(0, 160))
      }
    },

    /** Stop a running child. Needs only the ids; a child that is not running is left alone. */
    async interrupt(root: string, child: string): Promise<boolean> {
      const subagents = services.get('subagents')
      try {
        if (typeof subagents?.interruptByParent === 'function') { await subagents.interruptByParent(child, root, 'continuable'); return true }
      } catch (e) { log(`bridge: interrupt failed: ${String((e as Error)?.message ?? e)}`) }
      return false
    },

    /** New output of a job since `from`, without moving the model's own read cursor. */
    jobOutput(owner: string, id: string, from: number): { text: string; next: number; status: string } | null {
      const service = services.get('jobs')
      if (typeof service?.readAt !== 'function') return null
      try {
        const read = service.readAt(id, from, owner)
        const job = service.get?.(id, owner)
        const all = (read?.chunks ?? []).map((c: { text?: string }) => String(c?.text ?? '')).join('')
        // The newest output is what a person watching wants; a huge first read keeps its tail, from its first
        // whole line: the cut may fall inside an escape sequence, whose rest would show as text.
        let tail = all.slice(-MAX_OUTPUT_CHARS)
        if (tail.length < all.length && tail.includes('\n')) tail = tail.slice(tail.indexOf('\n') + 1)
        const text = tail.length === all.length ? all : `… ${words.charsLeftOut(all.length - tail.length)}\n${tail}`
        return { text, next: Number(read?.next ?? from), status: String(job?.status ?? 'unknown') }
      } catch {
        return null
      }
    },

    killJob(owner: string, id: string): boolean {
      try { return services.get('jobs')?.kill?.(id, owner, 'stopped from the terminal') !== undefined } catch { return false }
    },

    /**
     * Call `changed` whenever a turn's agents or jobs may have changed: a child created, a child
     * starting or stopping, its usage or timing moving, a job registered, progressing or settling.
     * The caller debounces; this only says "look again".
     */
    watch(changed: () => void): () => void {
      const offs: Array<() => void> = []
      const on = (name: string, fn: (...args: any[]) => unknown) => { const off = services.on(name, fn); if (typeof off === 'function') offs.push(off) }
      on('session/event', (_session: unknown, event: { type?: string }) => { if (event?.type === 'subagent/catalog') changed() })
      on('agent/status', () => changed())
      const projections = services.get('sessionProjections')
      if (typeof projections?.onChanged === 'function') {
        try {
          const off = projections.onChanged((_s: unknown, key: string) => { if (key === 'subagentTiming' || key === 'tokenUsage' || key === 'subagentCatalog') changed() })
          if (typeof off === 'function') offs.push(off)
        } catch { /* no feed: the heartbeat still refreshes */ }
      }
      const events = services.get('jobs')?.events
      if (typeof events?.subscribe === 'function') {
        try {
          const off = events.subscribe({ owners: 'all' }, (e: { type?: string }) => { if (e?.type !== 'output') changed() })
          if (typeof off === 'function') offs.push(off)
        } catch { /* no job events */ }
      }
      return () => { for (const off of offs.splice(0)) { try { off() } catch { /* already gone */ } } }
    },
  }
}
