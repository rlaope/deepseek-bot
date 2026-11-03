/**
 * Slack transport — Web API calls, name resolution, history deltas, attachment
 * download, and message rendering.
 *
 * Extracted from the adapter so the core stops speaking Slack payloads and a
 * second platform becomes a transport rather than a copy of this logic. This
 * first step is mechanical and changes no signature: a live gateway depends on
 * this code, and a rewrite that also changes behaviour cannot be verified by
 * passing tests alone. Shaping these into the transport interface, and moving the
 * Socket Mode connection, come next.
 *
 * The factory takes the adapter's small host surface — config, logger, and the
 * one async value it needs, the session directory. Everything else is Slack's.
 */
import { languageOf } from '../i18n.js'
import { messages } from '../messages.js'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import type {
  SlackAuthTestResponse, SlackConnectionResponse, SlackEnvelope, SlackEvent, SlackFile,
  SlackHistoryResponse, SlackMember, SlackMembersResponse, SlackMessage,
  SlackPostResponse, SlackResponse, SlackUserInfoResponse,
} from '../types/slack.js'
import type { AttachmentManifest, InboundMessage, PostedMessage, StreamFrame, Target, Transport, ActionButton, ActionEvent } from '../types/transport.js'
import { writeAttachments, type AttachmentSource } from './attachments.js'
import { tablesAsLists } from './tables.js'
import { numberedParts } from './parts.js'
import { reactionMarks, type MarkOutcome } from './marks.js'
import { EARLIER_NOT_SHOWN, OWN_EARLIER, newestThatFit } from './history.js'

export function createSlackApi({ cfg, log, sessionCwd }) {
  // ── Slack Web API (built-in fetch) ────────────────────────────────────────
  async function slackPost<T extends SlackResponse = SlackResponse>(token: string, method: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body ?? {}),
    })
    return (await res.json()) as T
  }
  async function slackGet<T extends SlackResponse = SlackResponse>(token: string, method: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`https://slack.com/api/${method}`)
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    return (await res.json()) as T
  }

  /**
   * id -> display name, so a transcript reads like a conversation.
   *
   * Workspaces are paginated and exceeded the first page here: a transcript came
   * back naming one participant and leaving another as a raw id. So this follows
   * the cursor, and falls back to users.info for anything still unknown — an id
   * past the page limit, a guest, or someone who joined after startup.
   */
  const nameCache = new Map()
  const MAX_NAME_PAGES = 10
  /** A thread's pages read for one history, 200 each. */
  const MAX_REPLY_PAGES = 5
  function rememberMember(member) {
    const name = member?.profile?.display_name || member?.real_name || member?.name || member?.id
    if (member?.id && name) nameCache.set(member.id, name)
  }
  async function loadNames(botToken) {
    if (nameCache.size > 0) return
    let cursor
    for (let page = 0; page < MAX_NAME_PAGES; page++) {
      const r = await slackGet<SlackMembersResponse>(botToken, 'users.list', { limit: '200', ...(cursor ? { cursor } : {}) })
      if (!r.ok) { log(`users.list failed (${r.error}) — history will show raw ids`); return }
      for (const member of r.members ?? []) rememberMember(member)
      cursor = r.response_metadata?.next_cursor
      if (!cursor) break
    }
    log(`resolved ${nameCache.size} member name(s)`)
  }
  /** Resolve ids the list did not cover, bounded so one odd message cannot fan out. */
  async function resolveMissingNames(botToken, ids) {
    let lookups = 0
    for (const id of ids) {
      if (nameCache.has(id) || lookups >= 20) continue
      lookups++
      try {
        const r = await slackGet<SlackUserInfoResponse>(botToken, 'users.info', { user: id })
        if (r.ok) rememberMember(r.user)
      } catch { /* leave the raw id in place */ }
    }
    return lookups
  }
  function humanize(text) {
    return String(text ?? '')
      .replace(/<@([A-Z0-9]+)>/g, (_, id) => `@${nameCache.get(id) ?? id}`)
      .replace(/<#([A-Z0-9]+)\|([^>]*)>/g, (_, _id, name) => `#${name}`)
      .replace(/<([^>|]+)\|([^>]*)>/g, (_, _url, label) => label)
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  }

  /**
   * The conversation the message arrived in, as text.
   *
   * In a thread: every reply of that thread, minus the message being answered.
   * Otherwise: recent channel history. Either way it is fetched, bounded, and
   * presented as content — never as instructions — so a message written in the
   * channel cannot tell the agent what to do.
   *
   * Only what came after the pointer and before the message being answered; what came after it is for later turns,
   * and the bot's own working message is posted before the history is read. `selfId` is the bot's own user: in a
   * session that has been going (a pointer), what it said is there already, as its answers, and is left out; sent
   * again the model read it as someone else's. A new session (no pointer: a thread under a watch's alert, a session
   * whose log is gone, a conversation pruned) has none of it, so it is given, marked as the bot's own. The pointer
   * returned is the message being answered, which the turn itself delivers.
   */
  async function fetchHistoryText(botToken, channel, threadTs, currentTs, sinceTs = null, selfId: string | null = null) {
    if (!cfg.fetchHistory) return { text: '', lastTs: null }
    await loadNames(botToken)
    const limit = Math.max(1, Math.min(200, Number(cfg.historyLimit)))
    // A ts Slack takes as `latest`; the history probe's stand-in is none.
    const latest = /^\d+(\.\d+)?$/.test(String(currentTs)) ? { latest: String(currentTs) } : {}
    const failed = (r: SlackHistoryResponse) => {
      log(`history fetch failed (${r.error}) — answering without it`)
      const hint = r.error === 'missing_scope' || r.error === 'not_in_channel'
        ? '\n[the conversation above could not be read: the app lacks history scope for this channel]'
        : ''
      return { text: hint, lastTs: null }
    }
    const messages: SlackMessage[] = []
    // Older messages after the pointer than were read (a channel's page), or newer ones (a thread past its page bound).
    let olderUnread = false
    let newerUnread = false
    if (threadTs) {
      // A thread is read oldest first, up to the message being answered: one page of a long gap since the pointer
      // was its oldest 200, and the rest, the lines right before the question, never arrived. Paged, bounded.
      let cursor: string | undefined
      for (let page = 0; ; page++) {
        const r = await slackGet<SlackHistoryResponse>(botToken, 'conversations.replies', { channel, ts: threadTs, limit: '200', ...latest, ...(sinceTs ? { oldest: sinceTs } : {}), ...(cursor ? { cursor } : {}) })
        if (!r.ok) return failed(r)
        messages.push(...(r.messages ?? []))
        cursor = r.has_more === true ? r.response_metadata?.next_cursor || undefined : undefined
        if (cursor === undefined) break
        if (page + 1 >= MAX_REPLY_PAGES) {
          newerUnread = true
          log(`history: thread ${threadTs} has more than ${MAX_REPLY_PAGES * 200} messages since the last turn — the newest are not read`)
          break
        }
      }
    } else {
      // Newest first, up to the message being answered; put in reading order.
      const r = await slackGet<SlackHistoryResponse>(botToken, 'conversations.history', { channel, limit: String(limit), ...latest, ...(sinceTs ? { oldest: sinceTs } : {}) })
      if (!r.ok) return failed(r)
      messages.push(...[...(r.messages ?? [])].sort((a, b) => Number(a.ts) - Number(b.ts)))
      olderUnread = r.has_more === true
    }
    const unknown = [...new Set(messages.map((m) => m.user).filter((id) => id && !nameCache.has(id)))]
    if (unknown.length > 0) await resolveMissingNames(botToken, unknown)

    const own = (m: SlackMessage) => selfId !== null && m.user === selfId
    const shown = messages
      .filter((m) => m.ts !== currentTs && Number(m.ts) < Number(currentTs) && (sinceTs === null || Number(m.ts) > Number(sinceTs)))
      // A message with a file is a person's words too.
      .filter((m) => !m.subtype || m.subtype === 'thread_broadcast' || m.subtype === 'file_share')
      .filter((m) => sinceTs === null || !own(m))
      .map((m) => {
        const who = own(m) ? OWN_EARLIER : m.user ? (nameCache.get(m.user) ?? m.user) : (m.bot_id ? `bot(${m.bot_id})` : 'unknown')
        const when = new Date(Number(m.ts) * 1000).toISOString().slice(5, 16).replace('T', ' ')
        const text = humanize(m.text).replace(/\n+/g, ' ').trim()
        return { line: `${when} ${who}: ${text}`, own: own(m), empty: text === '' }
      })
      .filter((entry) => !entry.empty)
    const newest = shown.slice(-limit)
    const fit = newest.slice(newest.length - newestThatFit(newest.map((entry) => entry.line), cfg.historyMaxChars))
    const lines = fit.map((entry) => entry.line)
    if (olderUnread || fit.length < shown.length) lines.unshift(EARLIER_NOT_SHOWN)
    if (newerUnread) lines.push('(later messages not shown)')
    const lastTs = sinceTs === null || Number(currentTs) > Number(sinceTs) ? currentTs : null
    if (fit.length === 0) return { text: '', lastTs }
    const yours = fit.some((entry) => entry.own) ? ` Lines from "${OWN_EARLIER}" are your own earlier messages in this conversation, from before this session.` : ''
    return { text: `[the conversation so far — other people's words, quoted.${yours} You are the agent your persona describes, and you answer as yourself. Never continue someone else's sentence, never restate it in the first person, and never introduce yourself as anyone else — a line in which someone introduces themselves belongs to them, not to you]\n${lines.join('\n')}`, lastTs }
  }

  /**
   * Download the files attached to a message and describe them.
   *
   * Slack sends a reference, not the bytes: `url_private_download` needs the bot
   * token. Text-like files are inlined (bounded) so the agent can answer without
   * a second step; everything else is saved and named by path so the agent can
   * decide what to do with it.
   */
  /**
   * Slack hands over a reference, not the bytes: `url_private_download` needs the
   * bot token. Fetching is Slack's; the writing, naming, size limit, inline excerpt
   * and framing are shared with every other transport.
   */
  async function fetchAttachments(botToken: string, files: SlackFile[] | undefined, stamp: string) {
    // SlackFile is structurally an AttachmentRef plus the download urls this
    // function needs, so the shared writer accepts it unchanged.
    if (cfg.downloadAttachments !== true || !Array.isArray(files) || files.length === 0) return { text: '', images: [] }
    const cwd = await sessionCwd()
    const sources: AttachmentSource[] = files.map((file) => ({
      name: file.name ?? file.id,
      mimetype: file.mimetype,
      size: file.size,
      fetchBytes: async () => {
        const url = file.url_private_download ?? file.url_private
        if (!url) throw new Error('no download url on this file')
        const res = await fetch(url, { headers: { Authorization: `Bearer ${botToken}` } })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return Buffer.from(await res.arrayBuffer())
      },
    }))
    return writeAttachments(sources, {
      cwd,
      dir: cfg.attachmentsDir ?? join(cwd, 'attachments'),
      stamp,
      maxBytes: cfg.maxAttachmentBytes,
      inlineChars: cfg.attachmentTextChars,
    })
  }

  /**
   * DSH emits standard Markdown; Slack uses its own dialect, which has no tables.
   *
   * What the model writes is text: `&`, `<` and `>` are escaped, so `<!channel>`, `<!here>`, `<!subteam^…>` or
   * `<@U…>` in an answer is shown, not sent as a ping (nothing here mentions anyone on purpose). Escaped inside code
   * too, where Slack shows `&lt;` as `<`. Code is set aside before the rules and restored after, so a `# comment` or
   * a `- ` line in it is not made bold or a bullet. A fence ends at a run of its own mark and length, so one that
   * shows a shorter fence holds it; a tilde fence, which Slack does not show as code, is sent as a backtick one.
   * Links are set aside as well, their label escaped: a Markdown one as `<url|label>`, and one already in Slack's
   * form (the thread's own link is handed to the model so) as it is.
   */
  function toSlackMarkdown(md) {
    const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const kept: string[] = []
    const keep = (text: string) => `\u0000${kept.push(text) - 1}\u0000`
    // The placeholders are NUL-delimited, so a NUL in the text itself is dropped first.
    const text = escape(tablesAsLists(String(md ?? '')).replace(/\u0000/g, '')
      // A backtick fence's info holds no backtick (as in CommonMark): a one-line ```npm install``` is not a fence.
      .replace(/^[ \t]*(`{3,}(?![^\n]*`)|~{3,})([^\n]*)\n([\s\S]*?\n)?[ \t]*\1[ \t]*$/gm, (code: string, fence: string, info: string, body = '') =>
        keep(escape(fence[0] === '~' && !body.includes('```') ? `\`\`\`${info}\n${body}\`\`\`` : code)))
      .replace(/`[^`\n]+`/g, (code: string) => keep(escape(code)))
      // A bare URL is linked by Slack itself, so it is left alone. A local path cannot be made clickable here —
      // that needs an upload, which is a separate job.
      // No pipe in the URL: Slack would end the URL there and show the rest as the label.
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s<>|]+)\)/g, (_, label: string, url: string) => keep(`<${url}|${escape(label)}>`))
      .replace(/<(https?:\/\/[^\s<>|]+)(?:\|([^<>\n]*))?>/g, (_, url: string, label?: string) =>
        keep(label === undefined ? `<${url}>` : `<${url}|${escape(label)}>`)))
      // Italics before bold, which would otherwise come out as italics: a mark followed by a non-space opens and one
      // after a non-space closes, so a list marker ("* item") or a product ("2 * 3") is not emphasis; neither side is
      // another star, so a star beside bold's pair (`*args, **kwargs`, `*Use **this** one*`) is not cut into italics.
      .replace(/(^|[^*\w])\*(?=[^*\s])([^*\n]*?[^*\s])\*(?!\*)/g, '$1_$2_')
      .replace(/\*\*(.+?)\*\*/g, '*$1*')
      .replace(/~~(.+?)~~/g, '~$1~')
      .replace(/^#{1,6}\s+(.*)$/gm, '*$1*')
      // Within a line: \s crossed line ends and ate the blank line before every list.
      .replace(/^[ \t]*[-*][ \t]+/gm, '• ')
    // A link's label can hold code set aside before it, so what is restored is restored in turn.
    const restore = (s: string): string => s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => restore(kept[Number(i)]))
    return restore(text)
  }

  async function say(botToken, channel, threadTs, text, replaceTs = null) {
    const chunks = []
    for (let i = 0; i < text.length; i += cfg.chunkChars) chunks.push(text.slice(i, i + cfg.chunkChars))
    if (chunks.length === 0) chunks.push('(empty response)')
    let replace = replaceTs
    for (const [i, chunk] of chunks.entries()) {
      const body = chunks.length > 1 ? `(${i + 1}/${chunks.length})\n${chunk}` : chunk
      // The first chunk replaces the progress placeholder, so a slow turn leaves
      // one message that changes rather than a placeholder plus an answer.
      const r = replace !== null
        ? await slackPost<SlackPostResponse>(botToken, 'chat.update', { channel, ts: replace, text: body })
        : await slackPost<SlackPostResponse>(botToken, 'chat.postMessage', { channel, thread_ts: threadTs, text: body })
      replace = null
      if (!r.ok) log(`${chunks.length > 1 ? 'reply' : 'reply'} post failed: ${r.error} — check the chat:write scope and channel membership`)
    }
  }
  return { slackPost, slackGet, fetchHistoryText, fetchAttachments, say, toSlackMarkdown, humanize }
}

// ── Transport ───────────────────────────────────────────────────────────────
//
// Everything above is Slack's API surface. What follows is the part that satisfies
// the Transport interface: credentials, identity, the Socket Mode connection with
// its reconnect loop and watchdog, event parsing, and rendering. The core keeps
// mapping, the turn loop, policy (which channels may be answered), watches and
// reminders — none of which needs to know it is talking to Slack.

export interface SlackTransportHost {
  cfg: Record<string, any>
  log: (...parts: unknown[]) => void
  sessionCwd: () => Promise<string>
  /** Reads a credential by reference; the adapter never sees a raw secret until here. */
  credential: (ref: string) => Promise<string | null>
  /** Merge into the health snapshot. Increments are reported as absolutes by the transport. */
  onHealth: (patch: Record<string, unknown>) => void
  /** Injectable for tests: the websocket constructor. */
  WebSocketImpl?: typeof WebSocket
}

/** Direct messages: Slack channel ids starting with D (im) or U (legacy). */
function isDirectChannel(channel: unknown): boolean {
  return typeof channel === 'string' && (channel.startsWith('D') || channel.startsWith('U'))
}

/**
 * What a transport must satisfy, plus the three lifecycle calls the adapter itself
 * needs. Declaring it is the difference between a seam and a comment: without this
 * annotation the compiler never checked that a transport matches the interface, and
 * one wrapper was quietly returning an object where the interface promised a string.
 */
export interface SlackTransport extends Transport {
  authenticate(): Promise<void>
  ready(): boolean
  hasSocket(): boolean
  /** Diagnostic only: raw channel history, used by the attachment probe. */
  historyRaw(channel: string, limit?: number): Promise<SlackHistoryResponse>
  /** Diagnostic only: threads whose working-status bookkeeping is still held. */
  readonly statusThreads: number
  /** Diagnostic only: messages whose progress marks are still held. */
  readonly markedMessages: number
}

export function createSlackTransport(host: SlackTransportHost): SlackTransport {
  // What Slack shows under a thread while a turn runs, in the deployment's language.
  const workingText = messages(languageOf(host.cfg.language)).working
  const { cfg, log, credential, onHealth } = host
  const WebSocketImpl = host.WebSocketImpl ?? WebSocket

  // Credentials and identity are resolved on connect, not at construction: a
  // scenario run has no Slack client and must not try to authenticate.
  let botToken: string | null = null
  let appToken: string | null = null
  let botUserId: string | null = null
  let ws: WebSocket | null = null

  let stopped = false
  let connected = false
  let backoff = 1000
  let attempts = 0
  let failures = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let watchdogTimer: ReturnType<typeof setInterval> | null = null

  const api = createSlackApi({ cfg, log, sessionCwd: host.sessionCwd })

  /**
   * Resolve the credentials. Explicit, never lazy: a scenario or self-test run has
   * no Slack client and must not reach for real tokens, or a test would post into a
   * live channel. The old code got this right by resolving only inside the real
   * connect path; that property is kept and named.
   */
  async function authenticate(): Promise<void> {
    botToken = await credential(cfg.botTokenRef)
    appToken = await credential(cfg.appTokenRef)
    // Say which reference was looked up, and say when there is no reference at all: a
    // misconfigured deployment was told "credential undefined not found", which names nothing.
    if (!botToken) throw new Error(cfg.botTokenRef ? `deepbot: credential ${cfg.botTokenRef} not found` : 'deepbot: no botTokenRef is configured')
    if (!appToken) throw new Error(cfg.appTokenRef ? `deepbot: credential ${cfg.appTokenRef} not found` : 'deepbot: no appTokenRef is configured')
  }

  /** Whether a Slack client exists in this run at all; the delivery watcher asks. */
  // Truthiness, not `!== null`: a credential service that resolves to `undefined` left the
  // token as undefined, and `undefined !== null` is true — so `ready()` reported a transport
  // that would have sent `Bearer undefined`. Found by the failure-injection sweep.
  function ready(): boolean {
    return typeof botToken === 'string' && botToken !== '' && typeof appToken === 'string' && appToken !== ''
  }

  function requireToken(): string {
    if (typeof botToken !== 'string' || botToken === '') throw new Error('slack transport is not authenticated')
    return botToken
  }

  async function identity() {
    if (!ready()) await authenticate()
    const me = await api.slackGet<SlackAuthTestResponse>(botToken as string, 'auth.test')
    if (!me.ok) throw new Error(`deepbot: auth.test failed (${me.error}) — check the bot token`)
    botUserId = me.user_id ?? null
    workspaceUrl = typeof (me as { url?: string }).url === 'string' ? String((me as { url?: string }).url) : null
    teamId = me.team_id ?? null
    return { name: me.user ?? 'unknown', id: me.user_id ?? '', team: me.team }
  }

  /**
   * Mentions taken, by channel and ts. A group DM's mention comes as its message event (Slack does not say whether an
   * app_mention comes too), so the two are one turn: the first is taken and the other dropped. Bounded: the pair
   * arrives together.
   */
  const mentionsTaken = new Set<string>()
  function firstMention(channel: string, ts: string): boolean {
    const key = `${channel}:${ts}`
    if (mentionsTaken.has(key)) return false
    mentionsTaken.add(key)
    if (mentionsTaken.size > 500) mentionsTaken.delete(mentionsTaken.values().next().value as string)
    return true
  }

  /**
   * Turn one platform event into something the core can use, or null when it is
   * not for this agent.
   *
   * Everything platform-shaped lives here: what counts as being addressed (a
   * mention, or any message in a DM), the bot's own messages, edits, and the
   * mention syntax that has to be stripped before the text is a prompt.
   */
  function parseEvent(event: SlackEvent, eventId: string): InboundMessage | null {
    // A message with a file, or one also sent to the channel, is still a person's message; other subtypes are not.
    const shared = event.subtype === 'file_share' || event.subtype === 'thread_broadcast'
    if (event.bot_id || (event.subtype && !shared) || (event as { edited?: unknown }).edited) return null
    if (!event.user || event.user === botUserId) return null
    if (!event.channel || !event.ts) return null
    // Files are a message without words too: a file_share in a DM has empty text, and an app_mention only the mention.
    const files = event.files ?? []
    if (!event.text?.trim() && files.length === 0) return null
    const isMention = event.type === 'app_mention'
    // A group DM is several people, so it is a channel here: taken as a DM, every message in it was a turn.
    const isDm = isDirectChannel(event.channel) || event.channel_type === 'im'
    const groupMention = event.channel_type === 'mpim' && !isMention && botUserId !== null && (event.text ?? '').includes(`<@${botUserId}>`)
    if ((isMention || groupMention) && !firstMention(event.channel, event.ts)) return null
    if (!isDm && !isMention && !groupMention) {
      if (cfg.replyMode === 'mention') return null
      // One that mentions the bot comes again as its app_mention, which is the turn: taking both answered it twice.
      if (botUserId !== null && (event.text ?? '').includes(`<@${botUserId}>`)) return null
      // 'thread': a message in a thread comes in unaddressed, and the core takes it only in a thread the bot takes
      // part in; one at the top of a channel needs a mention.
      if (cfg.replyMode === 'thread' && (typeof event.thread_ts !== 'string' || event.thread_ts === event.ts)) return null
      // One that opens with another person's mention (the bot's came as its app_mention) is said to them: not one for the
      // bot to join, nor one the mode gives it.
      if (/^\s*<@[A-Z0-9]+(?:\|[^>]*)?>/i.test(event.text ?? '')) return null
    }
    const text = botUserId === null
      ? event.text ?? ''
      : (event.text ?? '').replace(new RegExp(`<@${botUserId}>`, 'g'), '').trim()
    if (!text && files.length === 0) return null
    return {
      eventId,
      target: { channel: event.channel, threadTs: event.thread_ts ?? event.ts },
      ts: event.ts,
      text,
      user: event.user,
      addressed: isDm || isMention || groupMention || cfg.replyMode === 'all',
      ...(!isDm && !isMention && !groupMention && cfg.replyMode === 'all' ? { byMode: true } : {}),
      files,
      raw: event,
    }
  }

  async function openConnection() {
    // Two traps here, both hit in practice:
    //   1) this endpoint requires the *app-level* token (xapp-), not the bot
    //      token — a bot token yields `not_allowed_token_type`.
    //   2) it is POST-only — a GET yields `insecure_request`.
    if (appToken === null) throw new Error('slack transport is not authenticated')
    const r = await api.slackPost<SlackConnectionResponse>(appToken, 'apps.connections.open', {})
    if (!r.ok) throw new Error(`apps.connections.open failed: ${r.error}`)
    return r.url
  }

  /** Retry forever with capped backoff; a successful open resets it. */
  function scheduleReconnect(delay = backoff) {
    // No Slack client in this mode (scenario / selfTest): there is nothing to
    // reconnect, and trying would spam the log with auth failures against a real
    // app token. This happened while running the test harness.
    if (appToken === null || botToken === null) return
    if (stopped || reconnectTimer !== null) return
    log(`reconnect scheduled in ${delay}ms`)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (stopped) return
      connectInternal().catch((e) => {
        failures++
        attempts++
        onHealth({ connectAttempts: attempts, consecutiveFailures: failures, lastError: String(e?.message ?? e) })
        log(`reconnect failed (${failures} in a row): ${String(e?.message ?? e)} — still trying`)
        backoff = Math.min(backoff * 2, 60000)
        scheduleReconnect()
      })
    }, delay)
    backoff = Math.min(backoff * 2, 60000)
  }

  /** The socket can also die without a close event; re-arm if nothing is pending. */
  function startWatchdog() {
    if (appToken === null) return          // see scheduleReconnect
    if (watchdogTimer !== null) return
    watchdogTimer = setInterval(() => {
      if (stopped) return
      if (!connected && reconnectTimer === null) {
        log('watchdog: not connected and nothing scheduled — re-arming')
        scheduleReconnect(0)
      }
    }, 60000)
  }

  let onMessage: ((message: InboundMessage) => void) | null = null
  let onAction: ((action: ActionEvent) => void) | null = null
  // From auth.test, so a thread reference can be a real link rather than plain text.
  let workspaceUrl: string | null = null
  // From auth.test too: a stream into a channel names the team of the person it is for.
  let teamId: string | null = null

  async function connectInternal(): Promise<void> {
    if (stopped) return
    const url = await openConnection()
    const socket = new WebSocketImpl(url as string)
    ws = socket

    socket.addEventListener('open', () => {
      connected = true
      backoff = 1000
      failures = 0
      if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null }
      onHealth({ connected: true, connectedAt: Date.now(), disconnectedAt: null, consecutiveFailures: 0, lastError: null })
      log('Socket Mode connected')
    })

    socket.addEventListener('message', (msg: MessageEvent) => {
      let env: SlackEnvelope
      try { env = JSON.parse(String(msg.data)) } catch { return }
      // Every envelope must be acknowledged within 3 seconds.
      if (env.envelope_id) {
        try { socket.send(JSON.stringify({ envelope_id: env.envelope_id })) } catch { /* reconnecting */ }
      }
      if (env.type === 'hello') { log('hello received'); return }
      if (env.type === 'disconnect') {
        log(`disconnect received (reason=${(env as { reason?: string }).reason ?? '-'}) — reconnecting`)
        try { socket.close() } catch { /* ignore */ }
        return
      }
      // A button press: block actions, acknowledged above like every envelope.
      if (env.type === 'interactive' && (env as { payload?: { type?: string } }).payload?.type === 'block_actions') {
        const payload = (env as { payload: Record<string, any> }).payload
        for (const action of payload.actions ?? []) {
          const id = String(action.action_id ?? action.value ?? '')
          const channel = String(payload.channel?.id ?? payload.container?.channel_id ?? '')
          const threadTs = payload.message?.thread_ts ?? payload.container?.thread_ts ?? payload.message?.ts ?? null
          if (id !== '' && channel !== '' && onAction) onAction({ id, target: { channel, threadTs }, user: String(payload.user?.id ?? '') })
        }
        return
      }
      if (env.type === 'events_api' && env.payload?.event) {
        const message = parseEvent(env.payload.event, env.payload.event_id ?? '')
        if (message !== null) {
          attempts++
          onHealth({ connectAttempts: attempts })
          if (onMessage) onMessage(message)
        }
      }
    })

    socket.addEventListener('close', () => {
      if (stopped) return
      connected = false
      onHealth({ connected: false, disconnectedAt: Date.now() })
      log('connection closed')
      scheduleReconnect()
    })

    socket.addEventListener('error', (e: Event) => {
      connected = false
      const detail = String((e as { message?: string }).message ?? '') || 'WebSocket error'
      onHealth({ connected: false, lastError: detail })
      log('WebSocket error', detail)
    })
  }


  /**
   * Send, or replace a progress placeholder with the first chunk of the answer.
   * Markdown in, Slack dialect out: rendering belongs to the transport.
   */
  /**
   * Buttons as Block Kit: the text as a section and the buttons as an actions block. The text stays in
   * `text` as well, which is what a notification and a screen reader use. Only for a body that fits a
   * section; a longer one goes without, and the person answers by typing.
   */
  function blocksFor(body: string, buttons: ActionButton[]): Record<string, unknown> {
    if (buttons.length === 0 || body.length > 2900) return {}
    return {
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: body } },
        { type: 'actions', elements: buttons.slice(0, 5).map((button) => ({
          type: 'button',
          text: { type: 'plain_text', text: button.label.slice(0, 75) },
          action_id: button.id.slice(0, 255),
          value: button.id.slice(0, 2000),
          ...(button.style === 'primary' || button.style === 'danger' ? { style: button.style } : {}),
        })) },
      ],
    }
  }

  async function postChunked(target: Target, markdown: string, replaceTs: string | null, buttons: ActionButton[] = []): Promise<PostedMessage | null> {
    const text = api.toSlackMarkdown(markdown)
    // A configuration without a usable chunk size used to slice at NaN and send an *empty*
    // body, which Slack answers with `no_text` — a missing setting became a silent, total
    // failure of every reply. Fall back to the documented limit instead.
    const chunkChars = Number(cfg.chunkChars) > 0 ? Math.floor(Number(cfg.chunkChars)) : 4000
    // Cut from Slack's text, not the Markdown: what is counted, and what must not be split (a `<url|label>`
    // link, an `&amp;` escape, a code fence), is what Slack is sent. Each part carries its number.
    const chunks = numberedParts(text, chunkChars)
    let first: PostedMessage | null = null
    let replace = replaceTs
    for (const [i, body] of chunks.entries()) {
      const ts = replace
      // The buttons go with the last part, where the question ends.
      const extra = i === chunks.length - 1 ? blocksFor(body, buttons) : {}
      const postNew = () => api.slackPost<SlackPostResponse>(requireToken(), 'chat.postMessage', {
        channel: target.channel,
        // `thread_ts: ''` is not "no thread": Slack rejects the whole call with `no_text`, so
        // a channel-level post (no thread) could never be sent. Omit the field instead.
        ...(typeof target.threadTs === 'string' && target.threadTs !== '' ? { thread_ts: target.threadTs } : {}),
        text: body,
        ...extra,
      })
      let sent: SlackPostResponse
      if (ts !== null && first === null) {
        sent = await api.slackPost<SlackPostResponse>(requireToken(), 'chat.update', { channel: target.channel, ts, text: body, ...extra })
        if (!sent.ok) {
          // The message to replace is gone (or never existed). Losing the answer to a failed
          // edit is worse than answering in a new message, which is what the other transports
          // do for the same reason.
          log(`update failed: ${sent.error} — posting a new message instead`)
          sent = await postNew()
        }
      } else {
        sent = await postNew()
      }
      replace = null
      if (!sent.ok) {
        log(`reply post failed: ${sent.error} — check the chat:write scope and channel membership`)
        // Reporting a message that was never created is worse than reporting nothing: the
        // caller would edit a ts that does not exist and believe the answer arrived. The
        // failure of a later chunk cannot be undone, but the first one can be told.
        if (i === 0) return null
        continue
      }
      if (i === 0) first = { channel: target.channel, ts: sent.ts ?? '' }
    }
    return first
  }

  /**
   * Upload a file and attach it to the conversation.
   *
   * This is what makes a document clickable: a local path cannot be linked from Slack — there is
   * nothing to link to on the reader's machine — so the file has to travel. The API is three calls:
   * ask for an upload URL, send the bytes to it, then complete the upload against the channel.
   */
  async function uploadFile(target: Target, filePath: string, title?: string, given?: Uint8Array): Promise<boolean> {
    try {
      const bytes = given !== undefined ? Buffer.from(given) : readFileSync(filePath)
      const name = basename(filePath)
      const started = await api.slackPost<{ ok: boolean; upload_url?: string; file_id?: string; error?: string }>(
        requireToken(), 'files.getUploadURLExternal', { filename: name, length: bytes.length })
      if (started.ok !== true || started.upload_url === undefined || started.file_id === undefined) {
        log(`upload failed at getUploadURLExternal: ${started.error ?? 'no url'}`)
        return false
      }
      const put = await fetch(started.upload_url, { method: 'POST', body: bytes })
      if (put.ok !== true && put.status !== 200) {
        log(`upload failed sending bytes: HTTP ${put.status}`)
        return false
      }
      const done = await api.slackPost<{ ok: boolean; error?: string }>(requireToken(), 'files.completeUploadExternal', {
        files: [{ id: started.file_id, title: title ?? name }],
        channel_id: target.channel,
        ...(typeof target.threadTs === 'string' && target.threadTs !== '' ? { thread_ts: target.threadTs } : {}),
      })
      if (done.ok !== true) { log(`upload failed at completeUploadExternal: ${done.error ?? 'unknown'}`); return false }
      log(`uploaded ${name} (${bytes.length} bytes) to ${target.channel}`)
      return true
    } catch (e) {
      log(`upload failed: ${String((e as Error)?.message ?? e)}`)
      return false
    }
  }

  /**
   * Slack's own working status under the thread — "<app> 앱이 작업 중" with a spinner — instead of a
   * message of ours: a message raised a notification of its own, so every turn notified twice.
   *
   * agents.sessions.setStatus (processing → active) is Slack's current method and covers channel
   * threads; assistant.threads.setStatus (a line of text, cleared by our reply or after two minutes)
   * is the older one. Which a workspace accepts depends on its features and the app's scopes, which
   * this code cannot see, so it asks in that order and remembers a refusal that will not change. When
   * both refuse, `onUnavailable` hands the turn back to the core's working message.
   */
  const LASTING_REFUSALS = new Set(['missing_scope', 'feature_disabled', 'not_allowed_token_type', 'unknown_method',
    'method_deprecated', 'deprecated_endpoint', 'no_permission', 'access_denied', 'not_authed', 'invalid_auth'])
  let sessionsStatus: boolean | null = null
  let assistantStatus: boolean | null = null
  const ASSISTANT_REFRESH_MS = 100_000   // the assistant status lapses after two minutes without a message
  const REASSERT_MS = 1500              // after one message's end, the status is set again for another still working

  // How many messages are working in each thread. The status is the thread's, not a message's: with one
  // message waiting behind another, the first one's end cleared it and the second ran with nothing shown.
  const working = new Map<string, number>()
  // Every kind of status each thread shows, whoever set it: the last to stop clears them all. One kind
  // remembered per thread cleared only that one when two messages had shown different kinds.
  const threadShows = new Map<string, Set<'sessions' | 'assistant'>>()
  const showing = (where: string, kind: 'sessions' | 'assistant') => {
    const kinds = threadShows.get(where) ?? new Set<'sessions' | 'assistant'>()
    kinds.add(kind)
    threadShows.set(where, kinds)
  }
  // One status call at a time per thread, in order: a clear sent while a re-set was still on its way
  // could reach Slack first and leave "processing" behind.
  const threadCalls = new Map<string, Promise<unknown>>()

  function startTyping(target: Target, onUnavailable?: () => void): () => void {
    const thread = typeof target.threadTs === 'string' && target.threadTs !== '' ? target.threadTs : null
    if (thread === null || (sessionsStatus === false && assistantStatus === false)) {
      onUnavailable?.()
      return () => {}
    }
    const where = `${target.channel}:${thread}`
    working.set(where, (working.get(where) ?? 0) + 1)
    const set = (method: string, status: string) => {
      const call = (threadCalls.get(where) ?? Promise.resolve()).then(() =>
        api.slackPost<{ ok: boolean; error?: string }>(requireToken(), method, { channel_id: target.channel, thread_ts: thread, status }))
      const settled = call.catch(() => {})
      threadCalls.set(where, settled)
      // Forgotten once idle with nobody working here, so the map does not keep a chain per thread.
      void settled.then(() => { if (threadCalls.get(where) === settled && !working.has(where)) threadCalls.delete(where) })
      return call
    }
    let over = false
    let shown: 'sessions' | 'assistant' | null = null
    let refresh: ReturnType<typeof setInterval> | null = null
    const clear = () => {
      const kinds = threadShows.get(where) ?? new Set<'sessions' | 'assistant'>()
      if (shown !== null) kinds.add(shown)
      threadShows.delete(where)
      if (kinds.has('sessions')) void set('agents.sessions.setStatus', 'active').catch(() => {})
      if (kinds.has('assistant')) void set('assistant.threads.setStatus', '').catch(() => {})
    }
    const attempt = async (method: string, status: string, known: boolean | null): Promise<boolean | null> => {
      if (known === false) return false
      const r = await set(method, status).catch((e) => ({ ok: false, error: String((e as Error)?.message ?? e) }))
      if (r.ok === true) return true
      log(`working status: ${method} refused (${r.error ?? 'unknown'})`)
      return LASTING_REFUSALS.has(String(r.error)) ? false : null
    }
    void (async () => {
      const sessions = await attempt('agents.sessions.setStatus', 'processing', sessionsStatus)
      if (sessions === true) {
        sessionsStatus = true
        shown = 'sessions'
        showing(where, 'sessions')
      } else {
        if (sessions === false) sessionsStatus = false
        const assistant = await attempt('assistant.threads.setStatus', workingText, assistantStatus)
        if (assistant === true) {
          assistantStatus = true
          shown = 'assistant'
          showing(where, 'assistant')
          refresh = setInterval(() => { void set('assistant.threads.setStatus', workingText).catch(() => {}) }, ASSISTANT_REFRESH_MS)
        } else {
          if (assistant === false) assistantStatus = false
          if (!over) onUnavailable?.()
          return
        }
      }
      // The turn may have ended while the status was being set.
      if (over) { if (refresh !== null) clearInterval(refresh); if (!working.has(where)) clear() }
    })()
    return () => {
      if (over) return
      over = true
      if (refresh !== null) clearInterval(refresh)
      const left = (working.get(where) ?? 1) - 1
      if (left > 0) {
        working.set(where, left)
        // Another message here is still working. A reply clears the assistant status on Slack's side, so
        // it is set again once this one's reply has gone out.
        const again = shown
        if (again !== null) {
          setTimeout(() => {
            if (!working.has(where)) return
            showing(where, again)
            if (again === 'sessions') void set('agents.sessions.setStatus', 'processing').catch(() => {})
            else void set('assistant.threads.setStatus', workingText).catch(() => {})
          }, REASSERT_MS).unref?.()
        }
        return
      }
      working.delete(where)
      clear()
      // Forget the thread's call chain once it is idle, also when clear() had nothing to send and so
      // queued nothing that would forget it.
      const tail = threadCalls.get(where)
      void tail?.then(() => { if (threadCalls.get(where) === tail && !working.has(where)) threadCalls.delete(where) })
    }
  }

  /**
   * Delete one of the bot's own messages. The working message is removed rather than edited into the
   * answer: Slack raises no notification for an edit, so every answer would have reached a phone as
   * "⏳ 아리 작업 중…". chat.delete needs only chat:write for a message the bot posted.
   */
  async function remove(target: Target, ts: string): Promise<boolean> {
    try {
      const r = await api.slackPost<{ ok: boolean; error?: string }>(requireToken(), 'chat.delete', { channel: target.channel, ts })
      if (r.ok === true) return true
      log(`delete failed: ${r.error ?? 'unknown'} (ts=${ts})`)
      return false
    } catch (e) {
      log(`delete failed: ${String((e as Error)?.message ?? e)} (ts=${ts})`)
      return false
    }
  }

  /**
   * Progress on the person's message as its reactions (`marks.ts`): eyes when taken, a digit (1 to 9, tenths of a
   * guess) while it runs, a check, a cross or a stop sign at the end, a salute when told to be quiet. reactions:write is the app's to have: refused for
   * it, the refusal is said once and nothing more is asked until the gateway restarts. A message too full for one more
   * reaction has ours taken off, freeing a slot; one that is gone is let go.
   */
  const GONE = new Set(['message_not_found', 'channel_not_found', 'thread_locked', 'is_archived', 'not_in_channel'])
  const FULL = new Set(['too_many_reactions', 'too_many_emoji'])
  // A call that throws (the network, a page of HTML) is a failure like a refusal, retried the same way.
  const settled = <T,>(call: Promise<T>) => call.catch((e) => ({ ok: false, error: String((e as Error)?.message ?? e) }) as unknown as T)
  let refusedFor = ''
  // Not async: a missing token throws here, out of the marks, which say why.
  const reaction = (method: string, channel: string, ts: string, name: string) =>
    settled(api.slackPost<{ ok: boolean; error?: string }>(requireToken(), method, { channel, timestamp: ts, name }))
  const mark = reactionMarks({
    names: { seen: 'eyes', working: ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'], done: 'white_check_mark', failed: 'x', stopped: 'black_square_for_stop', quiet: 'saluting_face' },
    add: (channel, ts, name) => reaction('reactions.add', channel, ts, name).then((r): MarkOutcome => {
      if (r.ok || r.error === 'already_reacted') return 'ok'
      // The first refusal is the one said.
      if (LASTING_REFUSALS.has(String(r.error))) { refusedFor ||= String(r.error); return 'refused' }
      if (FULL.has(String(r.error))) return 'gone'
      if (GONE.has(String(r.error))) return 'unreachable'
      log(`progress marks: reactions.add failed (${r.error})`)
      return 'failed'
    }),
    remove: (channel, ts, name, clearing) => reaction('reactions.remove', channel, ts, name).then((r): MarkOutcome => {
      if (r.ok || r.error === 'no_reaction') return 'ok'
      if (!clearing) log(`progress marks: reactions.remove failed (${r.error})`)
      return 'failed'
    }),
    held: (channel, ts) => settled(api.slackGet<{ ok: boolean; error?: string; message?: { reactions?: Array<{ name: string; users?: string[] }> } }>(requireToken(), 'reactions.get', { channel, timestamp: ts })).then((r) => {
      if (r.ok) return (r.message?.reactions ?? []).filter((x) => botUserId !== null && (x.users ?? []).includes(botUserId)).map((x) => x.name)
      // Not read (reactions:read missing, say): every mark a lost turn can have left is taken off ("no_reaction" is fine).
      log(`progress marks: reactions.get failed (${r.error}) — taking off every mark a turn can leave`)
      return null
    }),
    log,
    get refusal() { return `reactions.add refused (${refusedFor}) — the app needs reactions:write` },
    retryMs: Number(cfg.markRetryMs) > 0 ? Number(cfg.markRetryMs) : 3000,
  })

  /**
   * A turn's text, streamed into its thread as it is written (chat.startStream, appendStream, stopStream), so it shows
   * at once. The answer then comes as a new message, which notifies (an edit does not), and the streamed message is
   * taken away. Learned against Slack itself: in a channel a stream names the person it is for and their team (the
   * core hands over the turn's origin, which names who asked); a message that is streaming can be neither edited nor
   * deleted, so it is stopped first, and the stop is tried again when refused. Text goes in batches (`streamFlushMs`),
   * a tool step by its name only (a command line or a path is not the thread's to see); anything else said in the
   * thread (an approval request, a stop's report) comes after all that was streamed; a stream nothing has moved for
   * `streamIdleMs` is stopped, and so is every open one when the transport closes. Refused for good, it says so once,
   * and answers arrive whole as before until the gateway restarts.
   */
  const flushMs = Number(cfg.streamFlushMs) > 0 ? Number(cfg.streamFlushMs) : 1500
  const idleMs = Number(cfg.streamIdleMs) > 0 ? Number(cfg.streamIdleMs) : 120_000
  const stopRetryMs = Number(cfg.streamRetryMs) > 0 ? Number(cfg.streamRetryMs) : 2000
  const APPEND_LIMIT = 12_000
  const STOP_PAUSES = [1, 5, 15]
  let streamRefused = false
  type Streaming = {
    target: Target; user: string; ts: string | null; pending: string; chain: Promise<void>
    timer: ReturnType<typeof setTimeout> | null; idle: ReturnType<typeof setTimeout> | null; stopped: boolean; dead: boolean
  }
  const streams = new Map<string, Streaming>()
  // Streams being ended now (by a post, idle, a reset), for close() to wait for; and each thread's posts in order, so
  // one that comes while another is ending the thread's stream comes after it.
  const ending = new Set<Promise<void>>()
  const posting = new Map<string, Promise<unknown>>()
  /** Where to cut `text` at most `limit` long: never between the two halves of a character outside the BMP. */
  const cutAt = (text: string, limit: number) => {
    const end = Math.min(text.length, limit)
    const last = text.charCodeAt(end - 1)
    return end < text.length && last >= 0xd800 && last <= 0xdbff ? end - 1 : end
  }
  function stream(target: Target, frame: StreamFrame): void {
    if (stopped || streamRefused || teamId === null || typeof target.threadTs !== 'string' || target.threadTs === '') return
    const key = `${target.channel}:${target.threadTs}`
    const held = streams.get(key)
    if (frame.kind === 'reset') {
      if (held !== undefined) { streams.delete(key); void end(held, { flush: false, remove: true }) }
      return
    }
    const text = frame.kind === 'text' ? frame.text : frame.kind === 'tool' ? `\n\n\`▸ ${frame.name.replace(/`/g, '')}\`\n\n` : ''
    // Reasoning, a tool's result: no text for the thread, but the turn is moving, so the stream is not idle.
    if (text === '') { if (held !== undefined) keepOpen(key, held); return }
    const user = (target as { user?: unknown }).user
    if (held === undefined && (typeof user !== 'string' || user === '')) return
    const s = held ?? { target: { channel: target.channel, threadTs: target.threadTs }, user: user as string, ts: null, pending: '', chain: Promise.resolve(), timer: null, idle: null, stopped: false, dead: false }
    streams.set(key, s)
    // The preview pings nobody: it goes as `markdown_text`, not through toSlackMarkdown, and whether Slack resolves
    // `<!channel>` there is not known. A zero-width space after every `<`, not only one before `!`, `@` or `#`: a
    // mention can arrive split across frames, and a batch can end between its `<` and the rest.
    s.pending += text.replace(/</g, '<\u200b')
    if (s.timer === null) s.timer = setTimeout(() => { s.timer = null; flush(s) }, flushMs)
    keepOpen(key, s)
  }
  function keepOpen(key: string, s: Streaming): void {
    if (s.idle !== null) clearTimeout(s.idle)
    s.idle = setTimeout(() => { if (streams.get(key) === s) { streams.delete(key); void end(s, { flush: true, remove: false }) } }, idleMs)
    s.idle.unref?.()
  }
  function flush(s: Streaming): void {
    const { channel, threadTs } = s.target
    s.chain = s.chain.then(async () => {
      while (!s.stopped && !s.dead && s.pending !== '') {
        const text = s.pending.slice(0, cutAt(s.pending, APPEND_LIMIT))
        s.pending = s.pending.slice(text.length)
        if (s.ts === null) {
          const r = await settled(api.slackPost<SlackPostResponse>(requireToken(), 'chat.startStream', { channel, thread_ts: threadTs, recipient_user_id: s.user, recipient_team_id: teamId, markdown_text: text }))
          if (!r.ok) {
            s.dead = true
            if (LASTING_REFUSALS.has(String(r.error))) {
              if (!streamRefused) log(`stream: chat.startStream refused (${r.error}) — answers arrive whole until the gateway restarts`)
              streamRefused = true
            } else log(`stream: chat.startStream failed (${r.error})`)
            return
          }
          s.ts = r.ts ?? null
        } else {
          const r = await settled(api.slackPost<SlackPostResponse>(requireToken(), 'chat.appendStream', { channel, ts: s.ts, markdown_text: text }))
          if (!r.ok) {
            log(`stream: chat.appendStream failed (${r.error})`)
            if (r.error === 'message_not_in_streaming_state' || r.error === 'stopped_by_user') { s.dead = true; return }
            // Not lost: it goes with the next batch.
            s.pending = text + s.pending
            return
          }
        }
      }
    }).catch((e) => log(`stream: ${String((e as Error)?.message ?? e)}`))
  }
  /** End a stream, remembered until it is done so close() can wait for it. */
  function end(s: Streaming, how: { flush: boolean; remove: boolean }): Promise<void> {
    const done = endStream(s, how)
    ending.add(done)
    void done.finally(() => ending.delete(done))
    return done
  }
  /** Stop a stream (after sending what is still pending, when asked), and delete its message when asked. */
  async function endStream(s: Streaming, how: { flush: boolean; remove: boolean }): Promise<void> {
    for (const timer of [s.timer, s.idle]) if (timer !== null) clearTimeout(timer)
    s.timer = null; s.idle = null
    if (how.flush) flush(s)
    const { channel } = s.target
    s.chain = s.chain.then(async () => {
      if (s.ts === null) return
      // Stopped by the person in Slack, it is no longer streaming; otherwise it is stopped, tried again when refused —
      // spread over a minute, since three tries in one rate window would all be refused together.
      if (!s.stopped && !s.dead) {
        for (let tries = 0; ; tries++) {
          const r = await settled(api.slackPost<SlackPostResponse>(requireToken(), 'chat.stopStream', { channel, ts: s.ts }))
          if (r.ok || r.error === 'message_not_in_streaming_state') break
          if (tries >= STOP_PAUSES.length) { log(`stream: chat.stopStream failed (${r.error}) — its message is left`); return }
          await new Promise((resolve) => setTimeout(resolve, stopRetryMs * STOP_PAUSES[tries]).unref?.())
        }
        s.stopped = true
      }
      if (how.remove) {
        const d = await settled(api.slackPost<SlackPostResponse>(requireToken(), 'chat.delete', { channel, ts: s.ts }))
        if (!d.ok) log(`stream: the streamed message could not be deleted (${d.error})`)
      }
    }).catch((e) => log(`stream: ${String((e as Error)?.message ?? e)}`))
    await s.chain
  }

  /**
   * A permalink for a conversation.
   *
   * Slack renders its own `<#C…>` mention, but someone who writes "#random" gets plain text, and a
   * model citing a thread has no way to know its URL. The workspace host comes from auth.test and the
   * channel and timestamp are already known, so the link can be built rather than guessed.
   */
  function permalinkFor(target: Target, label?: string): string | null {
    if (workspaceUrl === null || !target.channel) return null
    const ts = typeof target.threadTs === 'string' && target.threadTs !== '' ? target.threadTs : null
    if (ts === null) return null
    return `<${workspaceUrl.replace(/\/$/, '')}/archives/${target.channel}/p${ts.replace('.', '')}|${label ?? 'this thread'}>`
  }

  return {
    identity,
    authenticate,
    ready,
    permalinkFor,
    uploadFile,
    remove,
    startTyping,
    mark,
    /** Diagnostic only: messages whose marks are still held. */
    get markedMessages() { return mark.messages },
    stream,
    // Without the team (auth.test gave none) nothing can be streamed: the core shows progress another way.
    get streamUnavailable() { return streamRefused || teamId === null },
    get typingUnavailable() { return sessionsStatus === false && assistantStatus === false },
    get statusThreads() { return new Set([...working.keys(), ...threadShows.keys(), ...threadCalls.keys()]).size },
    // Block actions over Socket Mode; the app needs Interactivity turned on. Without it a press does
    // nothing, and the request's text says the person can type the answer instead.
    supportsButtons: true,

    async connect(handlers: { onMessage: (message: InboundMessage) => void; onStatus?: unknown; onAction?: (action: ActionEvent) => void }) {
      onMessage = handlers.onMessage
      onAction = handlers.onAction ?? null
      await authenticate()
      await connectInternal()
      startWatchdog()
    },

    /** Slack-side rendering: the core hands over Markdown, the transport makes it Slack. */
    async post(target: Target, text: string, options?: { replace?: string | null; buttons?: ActionButton[]; answer?: boolean }): Promise<PostedMessage | null> {
      requireToken()
      // A stream in this thread is taken at once: the turn's answer is posted as a new message, which notifies, and the
      // stream is then stopped and its message taken away (kept if the answer did not go out); anything else (an
      // approval request, a stop's report) comes after all that was streamed. A thread's posts go in order.
      const key = `${target.channel}:${target.threadTs}`
      const before = posting.get(key)
      const held = streams.get(key)
      if (held !== undefined) streams.delete(key)
      const send = () => postChunked(target, text, options?.replace ?? null, options?.buttons ?? [])
      const mine = (async () => {
        if (before !== undefined) await before
        if (held === undefined) return send()
        if (options?.answer === true) {
          // Ended whatever the post does, a throw included: a stream nothing tracks would stream on.
          let sent: PostedMessage | null = null
          try { sent = await send() } finally { void end(held, { flush: false, remove: sent !== null }) }
          return sent
        }
        // What is pending goes out first, so the post comes after it; the stop, tried again over a minute when refused,
        // does not hold the post (an approval request waits for nobody).
        flush(held)
        await held.chain
        void end(held, { flush: false, remove: false })
        return send()
      })()
      const done = mine.then(() => undefined, () => undefined)
      posting.set(key, done)
      void done.then(() => { if (posting.get(key) === done) posting.delete(key) })
      return mine
    },

    async fetchHistory(target: Target, options: { currentTs: string; sinceTs: string | null; limit: number; maxChars: number }) {
      const previous = { historyLimit: cfg.historyLimit, historyMaxChars: cfg.historyMaxChars }
      cfg.historyLimit = options.limit
      cfg.historyMaxChars = options.maxChars
      try {
        return await api.fetchHistoryText(requireToken(), target.channel, target.threadTs, options.currentTs, options.sinceTs, botUserId)
      } finally {
        cfg.historyLimit = previous.historyLimit
        cfg.historyMaxChars = previous.historyMaxChars
      }
    },

    async fetchAttachments(message: InboundMessage, stamp: string) {
      return api.fetchAttachments(requireToken(), message.files as SlackFile[], stamp)
    },

    /** Diagnostic only: raw history for the attachment probe. Not part of the interface. */
    historyRaw(channel: string, limit = 50) {
      return api.slackGet<SlackHistoryResponse>(requireToken(), 'conversations.history', { channel, limit: String(limit) })
    },

    /** Whether a socket is open right now, without closing it. */
    hasSocket(): boolean { return ws !== null },

    /** @returns whether a socket was actually open, so the caller can say so. */
    async close(): Promise<boolean> {
      stopped = true
      if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null }
      if (watchdogTimer !== null) { clearInterval(watchdogTimer); watchdogTimer = null }
      const hadSocket = ws !== null
      try { ws?.close() } catch { /* ignore */ }
      ws = null
      connected = false
      // Then, with nothing more taken in, no stream is left streaming in a thread: each open one is stopped (one not
      // yet started is not started now), and those being ended are waited for — briefly, and at best.
      const open = [...streams.entries()]
      streams.clear()
      const all = [...open.map(([, s]) => end(s, { flush: s.ts !== null, remove: false })), ...ending]
      await Promise.race([Promise.all(all), new Promise((resolve) => setTimeout(resolve, 3000).unref?.())])
      return hadSocket
    },
  }
}
