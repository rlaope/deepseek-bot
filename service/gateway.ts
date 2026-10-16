/**
 * `dsh gateway`: connect the bot to a messenger, and run the gateway service — for a person at a
 * terminal, or for an agent that has none.
 *
 *   dsh gateway setup [slack|telegram|discord|local]   at a terminal: the guided setup
 *   dsh gateway setup <platform> [--channels <ids|*>] [--users <ids>] [--profile <name>] [--no-verify] [--no-restart]
 *   dsh gateway remove <platform> [--profile <name>] [--no-restart]
 *   dsh gateway start | stop | restart
 *   dsh gateway status [--json] [--profile <name>]
 *   dsh gateway manifest slack
 *
 * At a terminal `setup` is a guided setup: menus chosen with ↑↓ and Enter, the browser opened where a
 * token is made, each token checked as it is pasted. Without a terminal — an agent, a script — every
 * answer comes another way: a token from the environment variable of its own name, the channels from
 * --channels, the people from --users; a missing answer is an error that names it, and nothing is
 * written. A token is never taken as an argument: arguments show in `ps` and in shell history.
 *
 * What it writes: tokens to ~/.dsh/.env (mode 600), and the platform, channel and people lines of the
 * profile's deepbot row. Nothing else in either file changes. The bot's own agent cannot set up or
 * remove a platform: its commands may not write those files, and that is intended. Its sandbox confines
 * writes only, though, so start, stop and restart — calls to launchd — are not kept from it.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import { dirname, join, resolve } from 'node:path'
import { stringWidth } from '../tui/render/width.js'

export const GATEWAY_COMMANDS = new Set(['setup', 'remove', 'start', 'stop', 'restart', 'status', 'manifest'])
const GATEWAY_LABEL = 'ai.deepbot.gateway'
const HEALTH_LABEL = 'ai.deepbot.health'
const LAUNCHCTL = '/bin/launchctl'
const PLUTIL = '/usr/bin/plutil'
const DOCS = 'https://github.com/rlaope/deepseek-bot/blob/master/docs/setup.md'
/** The probe calls a heartbeat older than this stale; status uses the same line. */
const STALE_MS = 5 * 60 * 1000

export interface RunResult { status: number | null; stdout: string; stderr: string }
export interface FetchResponse { ok: boolean; status: number; json(): Promise<any> }
export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal }) => Promise<FetchResponse>

/** Everything that reaches outside this module, so a suite can run it with no launchctl, network or terminal. */
export interface GatewayIO {
  home: string
  env: Record<string, string | undefined>
  uid: number
  run: (cmd: string, args: string[]) => RunResult
  fetch: Fetch
  /** A question at the terminal, null when cancelled. Absent without a terminal: every answer must come another way. */
  ask?: (question: string, secret: boolean) => Promise<string | null>
  /** A menu at the terminal: the index chosen, 'back' (Esc) or 'quit' (Ctrl+C). Absent without a terminal. */
  choose?: (title: string, options: Choice[], initial: number) => Promise<number | 'back' | 'quit'>
  /** Open a link in the browser; false when it could not be. */
  openUrl?: (url: string) => boolean
  out: (text: string) => void
  err: (text: string) => void
  sleep: (ms: number) => Promise<void>
  now: () => number
  /** How long a (re)start may take to connect. */
  waitMs?: number
}

// ── Platforms ─────────────────────────────────────────────────────────────────

type Platform = 'slack' | 'telegram' | 'discord' | 'local'
interface TokenSpec { key: string; label: string; shape: RegExp; expect: string }
interface PlatformSpec { tokens: TokenSpec[]; guide: string[]; whoami: string }

const PLATFORMS: Record<Platform, PlatformSpec> = {
  slack: {
    tokens: [
      { key: 'SLACK_BOT_TOKEN', label: 'Slack bot token', shape: /^xoxb-[A-Za-z0-9-]+$/, expect: 'xoxb-…' },
      { key: 'SLACK_APP_TOKEN', label: 'Slack app-level token', shape: /^xapp-[A-Za-z0-9-]+$/, expect: 'xapp-…' },
    ],
    guide: [
      'Slack: create the app from a manifest — `dsh gateway manifest slack`, then https://api.slack.com/apps → Create New App → From a manifest.',
      'Then Basic Information → App-Level Tokens → generate one with connections:write (xapp-…), and Install App → the bot token (xoxb-…).',
      `Without the manifest: ${DOCS}#slack`,
    ],
    whoami: 'a member id (U…): your profile → ⋮ → Copy member ID',
  },
  telegram: {
    tokens: [{ key: 'TELEGRAM_BOT_TOKEN', label: 'Telegram bot token', shape: /^\d+:[A-Za-z0-9_-]+$/, expect: '123456:AA…, from @BotFather' }],
    guide: [
      'Telegram: @BotFather → /newbot gives the token. In groups, turn privacy mode off (/setprivacy) for it to see messages.',
      `${DOCS}#telegram`,
    ],
    whoami: 'a numeric user id: @userinfobot replies with yours',
  },
  discord: {
    tokens: [{ key: 'DISCORD_BOT_TOKEN', label: 'Discord bot token', shape: /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, expect: 'three parts separated by dots' }],
    guide: [
      'Discord: an application at https://discord.com/developers/applications → Bot → Reset Token; turn on the Message Content intent.',
      `${DOCS}#discord`,
    ],
    whoami: 'a numeric user id: Developer Mode on, then right-click your name → Copy User ID',
  },
  local: { tokens: [], guide: ['The terminal, dsh: no token.'], whoami: '' },
}
const isPlatform = (name: string | undefined): name is Platform => name !== undefined && Object.hasOwn(PLATFORMS, name)

/** The bot scopes docs/setup.md lists, and im:history, which DMs (`message.im`) need. */
const SLACK_BOT_SCOPES = ['app_mentions:read', 'chat:write', 'channels:read', 'channels:history', 'groups:history', 'im:history', 'users:read', 'files:read', 'files:write']

/** A Slack app manifest with what docs/setup.md asks for: Socket Mode, the scopes, the events, interactivity. */
export function slackManifest(): Record<string, unknown> {
  return {
    display_information: { name: 'deepseek-bot', description: 'An always-on agent on DeepSeek Harness' },
    features: {
      app_home: { messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: 'deepseek-bot', always_online: true },
    },
    oauth_config: { scopes: { bot: SLACK_BOT_SCOPES } },
    settings: {
      // The channel events let replyMode 'thread' hear a thread's messages without a mention; with 'mention' they are dropped.
      event_subscriptions: { bot_events: ['app_mention', 'message.im', 'message.channels', 'message.groups'] },
      interactivity: { is_enabled: true },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  }
}

// ── Ids ───────────────────────────────────────────────────────────────────────

const ID = /^[A-Za-z0-9_-]+$/
/** A Slack token passes for an id by its characters; one pasted at the wrong prompt would land in the profile. */
const TOKEN_SHAPED = /^(xox[a-z]|xapp)-/i

/** Ids from what was typed: separated by spaces or commas, or `*` alone where that is allowed. Null when one is not an id. */
export function parseIds(input: string, star: boolean): string[] | null {
  const text = input.trim()
  if (star && text === '*') return ['*']
  const ids = text.split(/[\s,]+/).filter(Boolean)
  return ids.length > 0 && ids.every((id) => ID.test(id) && !TOKEN_SHAPED.test(id)) ? [...new Set(ids)] : null
}

/** Ids added to a list. A list that already holds `*` stays as it is; adding `*` makes it `*`. */
export function mergeIds(current: string[], given: string[]): string[] {
  if (current.includes('*')) return current
  if (given.includes('*')) return ['*']
  return [...current, ...given.filter((id) => !current.includes(id))]
}

// ── The credential file ───────────────────────────────────────────────────────

// A line ending in \r (a file saved with CRLF) is still the key's line: missed, it was appended twice.
const envLine = (key: string) => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=(.*?)\\r?$`)

/** A key's value in a .env text, the last line winning; undefined when absent or empty. */
export function envValue(text: string, key: string): string | undefined {
  let value: string | undefined
  for (const line of text.split('\n')) {
    const m = envLine(key).exec(line)
    if (m) value = m[1].trim().replace(/^(['"])(.*)\1$/, '$2')
  }
  return value === '' ? undefined : value
}

/**
 * The text with the key set: its first line replaced, any other line for it removed, or a line appended.
 * A file saved with CRLF keeps CRLF on every line.
 */
export function envSet(text: string, key: string, value: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text === '' ? [] : text.replace(/\r?\n$/, '').split(/\r?\n/)
  const out: string[] = []
  let placed = false
  for (const line of lines) {
    if (!envLine(key).test(line)) { out.push(line); continue }
    if (!placed) { out.push(`${key}=${value}`); placed = true }
  }
  if (!placed) out.push(`${key}=${value}`)
  return `${out.join(eol)}${eol}`
}

/**
 * The entries the DeepSeek Harness app holds in its own store, ~/.dsh/.credentials.yaml: the keys directly
 * under `refs:`. Under `records:` are other things (a browser session), not credentials. The values are the
 * secrets themselves (the file is 0600): they are compared in memory where a check needs it, and never
 * printed, logged or copied anywhere.
 *
 * The harness resolves a credential from the process's environment, then this store, then <cwd>/.env, then
 * ~/.dsh/.env (docs/harness-api-notes.md §4). The gateway's environment is launchd's, which carries none,
 * and the launcher moves the agent home's .env aside, so for a running gateway it is the store, then
 * ~/.dsh/.env.
 */
function storeEntries(text: string): Map<string, string> {
  const entries = new Map<string, string>()
  const entry = /^\s*(?:"([A-Za-z_][A-Za-z0-9_]*)"|'([A-Za-z_][A-Za-z0-9_]*)'|([A-Za-z_][A-Za-z0-9_]*))\s*:(.*)$/
  const add = (part: string) => {
    const m = entry.exec(part)
    if (m === null) return
    const raw = m[4].replace(/\s+#.*$/, '').trim()
    entries.set(m[1] ?? m[2] ?? m[3], /^(['"])(.*)\1$/.exec(raw)?.[2] ?? raw)
  }
  let inRefs = false
  let indent: string | null = null
  for (const line of text.split(/\r?\n/)) {
    // A blank line or a comment does not end a mapping in YAML, at any indent.
    if (line.trim() === '' || /^\s*#/.test(line)) continue
    if (/^\S/.test(line)) {
      const flow = /^refs:\s*\{(.*)\}\s*(#.*)?$/.exec(line)
      if (flow !== null) for (const part of flow[1].split(',')) add(part)
      inRefs = flow === null && /^refs:\s*(#.*)?$/.test(line)
      indent = null
      continue
    }
    if (!inRefs) continue
    const own = /^\s*/.exec(line)[0]
    indent ??= own
    if (own === indent) add(line)
  }
  return entries
}

/** The credential names the DeepSeek Harness app holds (see storeEntries). */
export function storeRefs(text: string): string[] {
  return [...storeEntries(text).keys()]
}

/** Where a running gateway would find a credential: the app's store first, then ~/.dsh/.env; null when neither has it. */
type Where = 'store' | 'dotenv' | null
const whereIs = (key: string, held: string[], envText: string): Where =>
  held.includes(key) ? 'store' : envValue(envText, key) !== undefined ? 'dotenv' : null

/**
 * The credentials the profile's model routes read: the `apiKeyEnv` lines of its `llm-pi-ai` row. Another
 * plugin's row (web search) names keys that are not the model's. None means dsh-base's default route,
 * DeepSeek's own API. A route chosen in the app rather than in this profile is not seen here.
 */
function routeKeys(profileText: string): string[] {
  const lines = profileText.split('\n')
  const names: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const head = /^(\s*)- id: ['"]?llm-pi-ai['"]?\s*(#.*)?$/.exec(lines[i])
    if (head === null) continue
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]
      if (line.trim() === '' || /^\s*#/.test(line)) continue
      if (/^\s*/.exec(line)[0].length <= head[1].length) break
      const key = /^\s+apiKeyEnv:\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\s*(#.*)?$/.exec(line)
      if (key !== null) names.push(key[1])
    }
  }
  return [...new Set(names)]
}

// With strictNullChecks off, `x !== null && 'error' in x` does not narrow; a guard does.
const failed = (x: unknown): x is { error: string } => typeof x === 'object' && x !== null && 'error' in x

// ── The profile's deepbot row ─────────────────────────────────────────────────

type ListKey = 'platform' | 'targetChannels' | 'allowedUsers'
interface ListField { values: string[]; style: 'scalar' | 'flow' | 'block'; line: number; end: number; indent: string; itemIndent: string; comment: string }
export interface DeepbotLists { platform: string[]; targetChannels: string[]; allowedUsers: string[] }

const SCALAR = /^(?:'((?:[^']|'')*)'|"([^"\\]*)"|([^\s'"[\],#{}]+))$/
/**
 * A value as YAML reads it, or why it is not one this edits: an unquoted number (YAML reads a number,
 * and a long id loses digits), an alias, a tag, a block scalar, or null.
 */
function scalar(text: string): string | { error: string } {
  const m = SCALAR.exec(text.trim())
  if (m === null) return { error: `\`${text.trim()}\` is not a plain value` }
  if (m[1] !== undefined) return m[1].replace(/''/g, "'")
  if (m[2] !== undefined) return m[2]
  const plain = m[3]
  if (/^[-+]?(\d[\d_]*(\.\d*)?|\.\d+|0x[\da-f]+|0o[0-7]+)(e[-+]?\d+)?$/i.test(plain)) return { error: `\`${plain}\` is a number to YAML: quote it, '${plain}' — a long id loses digits otherwise` }
  if (/^[*&!|>%@`]/.test(plain) || /^(~|null|true|false)$/i.test(plain)) return { error: `\`${plain}\` is not a plain value` }
  return plain
}

/** The `- id: deepbot` row as [start, end) lines: it runs to the next top-level row or key. */
function deepbotRow(lines: string[]): { start: number; end: number } | { error: string } {
  const starts = lines.flatMap((line, i) => (/^- id: ['"]?deepbot['"]?\s*(#.*)?$/.test(line) ? [i] : []))
  if (starts.length === 0) return { error: 'it has no `- id: deepbot` row' }
  if (starts.length > 1) return { error: `it has ${starts.length} \`- id: deepbot\` rows` }
  let end = starts[0] + 1
  while (end < lines.length && !/^[^\s#]/.test(lines[end])) end++
  return { start: starts[0], end }
}

const indentOf = (line: string) => /^\s*/.exec(line)[0]
const blankOrComment = (line: string) => line.trim() === '' || /^\s*#/.test(line)

/**
 * The indent of the keys under the row's `config:` — the first line below it that is not blank or a
 * comment. A key at any other indent is not the setting: it is in a block of text, or outside config.
 */
function configIndent(lines: string[], row: { start: number; end: number }): string | { error: string } {
  const at = lines.findIndex((line, i) => i > row.start && i < row.end && /^\s+config:\s*(#.*)?$/.test(line))
  if (at === -1) return { error: 'the deepbot row has no `config:` block' }
  for (let i = at + 1; i < row.end; i++) {
    if (blankOrComment(lines[i])) continue
    const indent = indentOf(lines[i])
    return indent.length > indentOf(lines[at]).length ? indent : { error: 'the deepbot row\'s `config:` block is empty' }
  }
  return { error: 'the deepbot row\'s `config:` block is empty' }
}

/** A list key in the row's config, in any of the three ways YAML writes one; null when absent. */
function readList(lines: string[], row: { start: number; end: number }, key: ListKey): ListField | null | { error: string } {
  const keys = configIndent(lines, row)
  if (failed(keys)) return keys
  const head = new RegExp(`^(${keys})${key}:(.*)$`)
  let at = -1
  for (let i = row.start + 1; i < row.end; i++) {
    if (!head.test(lines[i])) continue
    if (at !== -1) return { error: `${key} appears twice in the deepbot row` }
    at = i
  }
  if (at === -1) return null
  const [, indent, rest] = head.exec(lines[at])
  const [, body, comment = ''] = /^(.*?)(\s+#.*)?$/.exec(rest)
  const value = body.trim()
  const where = `line ${at + 1} (${key})`

  if (value === '') {
    // A block list: the items below, each `- value` at one indent. Anything else inside it is refused rather than guessed at.
    let end = at + 1
    const values: string[] = []
    let itemIndent: string | null = null
    while (end < row.end) {
      const line = lines[end]
      if (line.trim() === '') break
      const deeper = indentOf(line).length > indent.length
      const item = /^(\s*)-\s+(.*?)\s*$/.exec(line)
      if (item !== null && item[1].length >= indent.length) {
        if (itemIndent !== null && item[1] !== itemIndent) return { error: `${where}: items at different indents` }
        const v = scalar(item[2])
        if (failed(v)) return { error: `${where}: ${v.error}` }
        itemIndent = item[1]
        values.push(v)
        end++
        continue
      }
      if (deeper) return { error: `${where}: a line inside the list that is not an item` }
      break
    }
    // An item after a comment would still belong to the list in YAML.
    for (let i = end; i < row.end && blankOrComment(lines[i]); i++) {
      const next = lines[i + 1]
      if (next !== undefined && /^\s*-\s/.test(next) && indentOf(next).length >= indent.length && i + 1 < row.end) {
        return { error: `${where}: the list continues after a comment or a blank line` }
      }
    }
    if (values.length === 0) return { error: `${where}: no value` }
    return { values, style: 'block', line: at, end, indent, itemIndent, comment }
  }
  if (value.startsWith('[')) {
    if (!value.endsWith(']')) return { error: `${where}: a list that does not close on its line` }
    const inner = value.slice(1, -1).trim()
    const values = inner === '' ? [] : inner.split(',').map(scalar)
    const bad = values.find(failed)
    if (bad !== undefined) return { error: `${where}: ${bad.error}` }
    return { values: values as string[], style: 'flow', line: at, end: at + 1, indent, itemIndent: `${indent}  `, comment }
  }
  const single = scalar(value)
  if (failed(single)) return { error: `${where}: ${single.error}` }
  return { values: [single], style: 'scalar', line: at, end: at + 1, indent, itemIndent: `${indent}  `, comment }
}

const quoted = (v: string) => `'${v.replace(/'/g, "''")}'`

function rewrite(field: ListField, key: ListKey, values: string[]): string[] {
  if (field.style === 'block' && values.length > 0) {
    return [`${field.indent}${key}:${field.comment}`, ...values.map((v) => `${field.itemIndent}- ${quoted(v)}`)]
  }
  if (field.style === 'scalar' && values.length === 1) return [`${field.indent}${key}: ${quoted(values[0])}${field.comment}`]
  return [`${field.indent}${key}: [${values.map(quoted).join(', ')}]${field.comment}`]
}

/** The three lists of the deepbot row, or why they cannot be read. An absent allowedUsers is empty. */
export function readProfile(text: string): DeepbotLists | { error: string } {
  // Refused by name: either one used to read as "no deepbot row" or "no platform line".
  if (text.includes('\r')) return { error: 'it has Windows line endings (CRLF); save it with LF' }
  if (text.startsWith('\ufeff')) return { error: 'it starts with a byte-order mark; save it without one' }
  const lines = text.split('\n')
  const row = deepbotRow(lines)
  if ('error' in row) return row
  const lists: Partial<DeepbotLists> = {}
  for (const key of ['platform', 'targetChannels', 'allowedUsers'] as const) {
    const field = readList(lines, row, key)
    if (failed(field)) return field
    if (field === null && key !== 'allowedUsers') return { error: `the deepbot row has no ${key} line` }
    lists[key] = field === null ? [] : field.values
  }
  return lists as DeepbotLists
}

/**
 * The profile text with the lists changed, every other line as it was. A list keeps the way it was
 * written; allowedUsers, when absent, is put right after targetChannels.
 */
export function writeProfile(text: string, next: Partial<DeepbotLists>): string | { error: string } {
  const readable = readProfile(text)
  if (failed(readable)) return readable
  let lines = text.split('\n')
  for (const key of ['platform', 'targetChannels', 'allowedUsers'] as const) {
    const values = next[key]
    if (values === undefined) continue
    const row = deepbotRow(lines)
    if ('error' in row) return row
    const field = readList(lines, row, key)
    if (failed(field)) return field
    if (field !== null) {
      if (field.values.join('\n') === values.join('\n')) continue
      lines = [...lines.slice(0, field.line), ...rewrite(field, key, values), ...lines.slice(field.end)]
      continue
    }
    if (values.length === 0) continue
    const anchor = readList(lines, row, 'targetChannels')
    if (anchor === null || failed(anchor)) return { error: `the deepbot row has no targetChannels line to put ${key} after` }
    lines = [...lines.slice(0, anchor.end), `${anchor.indent}${key}: [${values.map(quoted).join(', ')}]`, ...lines.slice(anchor.end)]
  }
  return lines.join('\n')
}

// ── Files ─────────────────────────────────────────────────────────────────────

/**
 * Write through a link to the file it names, by a rename. The mode is the file's own, or `mode` for a new
 * one — or `mode` always where `exact` (the credential file is 600 whatever it was).
 */
function writeFile(path: string, text: string, mode: number, exact = false): void {
  const target = existsSync(path) ? realpathSync(path) : path
  const final = !exact && existsSync(target) ? statSync(target).mode & 0o777 : mode
  const temp = join(dirname(target), `.${process.pid}.${Date.now()}.tmp`)
  // It holds the tokens until the rename: a failure on the way must not leave it beside them.
  try {
    writeFileSync(temp, text, { mode: 0o600 })
    chmodSync(temp, final)
    renameSync(temp, target)
  } catch (e) {
    rmSync(temp, { force: true })
    throw e
  }
}

const readText = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '')

function paths(io: GatewayIO) {
  const dsh = join(io.home, '.dsh')
  const agents = join(io.home, 'Library', 'LaunchAgents')
  return {
    dsh,
    env: join(dsh, '.env'),
    store: join(dsh, '.credentials.yaml'),
    health: join(dsh, 'slack-state', 'health.json'),
    log: join(dsh, 'slack-state', 'deepbot.log'),
    plist: join(agents, `${GATEWAY_LABEL}.plist`),
    healthPlist: join(agents, `${HEALTH_LABEL}.plist`),
  }
}
type Paths = ReturnType<typeof paths>

const tilde = (io: GatewayIO, path: string) => (path.startsWith(`${io.home}/`) ? `~${path.slice(io.home.length)}` : path)

// ── The service ───────────────────────────────────────────────────────────────

function service(io: GatewayIO, label: string): { loaded: boolean; pid: number | null } {
  const r = io.run(LAUNCHCTL, ['print', `gui/${io.uid}/${label}`])
  if (r.status !== 0) return { loaded: false, pid: null }
  // The job's own lines are indented by one tab; its endpoints' "state = active" sit deeper.
  const pid = /^\tpid = (\d+)$/m.exec(r.stdout)
  return { loaded: true, pid: pid === null ? null : Number(pid[1]) }
}

function launchctl(io: GatewayIO, args: string[]): boolean {
  const r = io.run(LAUNCHCTL, args)
  if (r.status === 0) return true
  io.err(`launchctl ${args[0]} failed: ${(r.stderr || r.stdout).trim() || `exit ${r.status}`}`)
  return false
}

interface Health { pid?: number; startedAt?: number; connected?: boolean; connectedAt?: number | null; lastError?: string | null; updatedAt?: number }
function readHealth(p: Paths): Health | null {
  try { return JSON.parse(readFileSync(p.health, 'utf8')) } catch { return null }
}

/** How long to watch, once a platform has connected, for another one failing after it. */
const SETTLE_MS = 5000

/**
 * Wait for a process started at or after `since` to say it is up: connected, where it serves a
 * messenger. With several, the health file has one flag for all of them and the first to connect sets
 * it, so this watches a little longer for a platform failing after it, and says what it cannot tell.
 */
async function reportConnection(io: GatewayIO, p: Paths, since: number, messengers: number): Promise<number> {
  const waitMs = io.waitMs ?? 60000
  const deadline = io.now() + waitMs
  const fresh = (h: Health | null) => h !== null && (h.startedAt ?? 0) >= since
  let health = readHealth(p)
  while (!(fresh(health) && (messengers === 0 || health.connected === true))) {
    if (io.now() >= deadline) {
      const last = fresh(health) && health.lastError ? ` — last error: ${health.lastError}` : ''
      io.err(`not connected within ${Math.round(waitMs / 1000)}s${last}. It may still be starting: dsh gateway status, and the log at ${tilde(io, p.log)}`)
      return 1
    }
    await io.sleep(1000)
    health = readHealth(p)
  }
  if (messengers === 0) { io.out(`running (pid ${health.pid ?? '?'})`); return 0 }
  if (messengers === 1) { io.out(`connected (pid ${health.pid ?? '?'})`); return 0 }
  await io.sleep(SETTLE_MS)
  const later = readHealth(p)
  if (fresh(later) && later.lastError) {
    io.err(`a platform connected, and another reported an error: ${later.lastError}. The log: ${tilde(io, p.log)}`)
    return 1
  }
  io.out(`connected (pid ${health.pid ?? '?'}) — a platform did; with ${messengers} the health file does not say which, so message the one you set up`)
  return 0
}

async function restartGateway(io: GatewayIO, p: Paths, messengers: number): Promise<number> {
  io.out('restarting the gateway (a turn running now is cut off, and its conversation is told so)')
  const since = io.now()
  if (!launchctl(io, ['kickstart', '-k', `gui/${io.uid}/${GATEWAY_LABEL}`])) return 1
  return reportConnection(io, p, since, messengers)
}

async function start(io: GatewayIO, p: Paths, messengers: number): Promise<number> {
  if (!existsSync(p.plist)) {
    io.err('the gateway service is not installed: run install.sh, or service/install-service.sh in the source checkout')
    return 1
  }
  const gateway = service(io, GATEWAY_LABEL)
  const since = io.now()
  if (!gateway.loaded) {
    if (!launchctl(io, ['bootstrap', `gui/${io.uid}`, p.plist])) return 1
  } else if (gateway.pid === null) {
    // Loaded with no process: launchd is between restarts of one that keeps exiting. Start it now and see.
    if (!launchctl(io, ['kickstart', `gui/${io.uid}/${GATEWAY_LABEL}`])) return 1
  }
  // The probe was stopped with it; without it nothing restarts a gateway that drops.
  if (existsSync(p.healthPlist) && !service(io, HEALTH_LABEL).loaded && !launchctl(io, ['bootstrap', `gui/${io.uid}`, p.healthPlist])) return 1
  if (gateway.loaded && gateway.pid !== null) { io.out(`already running (pid ${gateway.pid})`); return 0 }
  return reportConnection(io, p, since, messengers)
}

function stop(io: GatewayIO, p: Paths): number {
  const gateway = service(io, GATEWAY_LABEL)
  const probe = service(io, HEALTH_LABEL)
  if (!gateway.loaded && !probe.loaded) { io.out('not running'); return 0 }
  // The probe first: left running, it would try to restart the gateway, fail, and alert that it is down.
  if (probe.loaded && !launchctl(io, ['bootout', `gui/${io.uid}/${HEALTH_LABEL}`])) return 1
  if (gateway.loaded && !launchctl(io, ['bootout', `gui/${io.uid}/${GATEWAY_LABEL}`])) {
    // The gateway is still up: put its probe back, or nothing restarts it when it drops.
    if (probe.loaded && existsSync(p.healthPlist)) launchctl(io, ['bootstrap', `gui/${io.uid}`, p.healthPlist])
    return 1
  }
  io.out('stopped, with its health probe. Both start again at login, or with: dsh gateway start')
  return 0
}

// ── Tokens with the platform ──────────────────────────────────────────────────

type Verified = { ok: true; who: string; name?: string; app?: string } | { ok: false; reason: string; unreachable?: boolean }

/** The Slack app an app-level token belongs to: the part after `xapp-1-`, up to the next dash. */
const appOfAppToken = (token: string | undefined) => /^xapp-\d+-([A-Z0-9]+)-/.exec(token ?? '')?.[1]

/** Ask the platform who the token belongs to — and, for a Slack bot token, which app it is from. */
async function verifyToken(fetch: Fetch, key: string, token: string): Promise<Verified> {
  const call = async (url: string, init: { method?: string; headers?: Record<string, string> }) => {
    try {
      const r = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) })
      let body: any = null
      try { body = await r.json() } catch { /* not JSON */ }
      return { status: r.status, ok: r.ok, body }
    } catch (e) {
      return { error: `could not reach ${new URL(url).host} (${String((e as Error)?.message ?? e)})` }
    }
  }
  const unreachable = (reason: string): Verified => ({ ok: false, reason, unreachable: true })
  const bearer = { Authorization: `Bearer ${token}` }
  if (key === 'SLACK_BOT_TOKEN') {
    const r = await call('https://slack.com/api/auth.test', { method: 'POST', headers: bearer })
    if ('error' in r) return unreachable(r.error)
    if (r.body?.ok !== true) return { ok: false, reason: `Slack refused it (${r.body?.error ?? `HTTP ${r.status}`})` }
    // Which app the bot is, to hold against the app-level token's; unknown when this is refused (users:read).
    const bot = r.body.bot_id ? await call(`https://slack.com/api/bots.info?bot=${encodeURIComponent(r.body.bot_id)}`, { method: 'GET', headers: bearer }) : null
    const app = bot !== null && !('error' in bot) && bot.body?.ok === true ? bot.body.bot?.app_id : undefined
    return { ok: true, who: `@${r.body.user} in ${r.body.team}`, name: r.body.user, ...(app ? { app } : {}) }
  }
  if (key === 'SLACK_APP_TOKEN') {
    // Asks for a Socket Mode URL and does not open it, so a running gateway's connection is untouched.
    const r = await call('https://slack.com/api/apps.connections.open', { method: 'POST', headers: bearer })
    if ('error' in r) return unreachable(r.error)
    return r.body?.ok === true ? { ok: true, who: 'Socket Mode is on' } : { ok: false, reason: `Slack refused it (${r.body?.error ?? `HTTP ${r.status}`})` }
  }
  if (key === 'TELEGRAM_BOT_TOKEN') {
    const r = await call(`https://api.telegram.org/bot${token}/getMe`, { method: 'GET' })
    if ('error' in r) return unreachable(r.error.split(token).join('…'))
    return r.body?.ok === true ? { ok: true, who: `@${r.body.result?.username}`, name: r.body.result?.username } : { ok: false, reason: `Telegram refused it (${r.body?.description ?? `HTTP ${r.status}`})` }
  }
  if (key === 'DISCORD_BOT_TOKEN') {
    const r = await call('https://discord.com/api/v10/users/@me', { method: 'GET', headers: { Authorization: `Bot ${token}` } })
    if ('error' in r) return unreachable(r.error)
    return r.ok && r.body?.id ? { ok: true, who: `${r.body.username} (${r.body.id})`, name: r.body.username } : { ok: false, reason: `Discord refused it (${r.body?.message ?? `HTTP ${r.status}`})` }
  }
  return { ok: false, reason: `no check for ${key}` }
}

/** Discord's application behind a bot token: its id (for the invite link), its intents, and who owns it. */
type DiscordApp = { ok: true; who: string; name: string; id: string; flags: number; owner: { id: string; username: string } | null } | { ok: false; reason: string; unreachable?: boolean }
async function discordApp(fetch: Fetch, token: string): Promise<DiscordApp> {
  try {
    const r = await fetch('https://discord.com/api/v10/applications/@me', { method: 'GET', headers: { Authorization: `Bot ${token}` }, signal: AbortSignal.timeout(10000) })
    let body: any = null
    try { body = await r.json() } catch { /* not JSON */ }
    if (!r.ok || !body?.id) return { ok: false, reason: `Discord refused it (${body?.message ?? `HTTP ${r.status}`})` }
    // An id goes into a link the person opens: digits, or nothing is believed of the answer.
    if (!/^\d+$/.test(String(body.id))) return { ok: false, reason: 'Discord answered with no application id' }
    const name = String(body.bot?.username ?? body.name ?? 'the bot')
    // A team's application has the team as its owner, a pseudo-user no one can be: the person is the team's owner.
    const person = body.team?.owner_user_id
      ? { id: String(body.team.owner_user_id), username: String(body.team.members?.find((m: any) => String(m?.user?.id) === String(body.team.owner_user_id))?.user?.username ?? 'the team owner') }
      : body.owner?.id ? { id: String(body.owner.id), username: String(body.owner.username ?? body.owner.id) } : null
    const owner = person !== null && /^\d+$/.test(person.id) ? person : null
    return { ok: true, who: `the bot "${name}"`, name, id: String(body.id), flags: Number(body.flags ?? 0), owner }
  } catch (e) {
    return { ok: false, reason: `could not reach discord.com (${String((e as Error)?.message ?? e)})`, unreachable: true }
  }
}

// ── Arguments ─────────────────────────────────────────────────────────────────

interface Options { positional: string[]; profile?: string; channels?: string; users?: string; verify: boolean; restart: boolean; json: boolean; help: boolean }

const ALLOWED: Record<string, string[]> = {
  setup: ['--profile', '--channels', '--users', '--no-verify', '--no-restart'],
  remove: ['--profile', '--no-restart'],
  start: [], stop: [], restart: [],
  status: ['--profile', '--json'],
  manifest: [],
}

function parseOptions(command: string, argv: string[]): Options | { error: string } {
  const o: Options = { positional: [], verify: true, restart: true, json: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-h' || a === '--help') { o.help = true; continue }
    if (!a.startsWith('-')) { o.positional.push(a); continue }
    if (!ALLOWED[command].includes(a)) return { error: `${command}: unknown option ${a}` }
    if (a === '--no-verify') o.verify = false
    else if (a === '--no-restart') o.restart = false
    else if (a === '--json') o.json = true
    else {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) return { error: `${a} needs a value` }
      o[a.slice(2) as 'profile' | 'channels' | 'users'] = value
      i++
    }
  }
  return o
}

const GATEWAY_USAGE = `dsh gateway — connect the bot to a messenger, and run its service

  dsh gateway setup                 at a terminal: pick a messenger with ↑↓ and Enter, and follow along
  dsh gateway setup <slack|telegram|discord|local> [--channels <ids|*>] [--users <ids>] [--profile <name>] [--no-verify] [--no-restart]
  dsh gateway remove <slack|telegram|discord|local> [--profile <name>] [--no-restart]
  dsh gateway start | stop | restart
  dsh gateway status [--json] [--profile <name>]
  dsh gateway manifest slack

  setup       at a terminal, a guided setup: the browser opens where each token is made, each token is
              checked as it is pasted, and a restart is offered at the end. Without a terminal (an
              agent, a script) it saves the platform's tokens to ~/.dsh/.env, checks them, adds the
              platform to the profile and restarts the gateway. A token is read from the environment
              variable of its name (SLACK_BOT_TOKEN and SLACK_APP_TOKEN, TELEGRAM_BOT_TOKEN,
              DISCORD_BOT_TOKEN) — never taken as an argument. One the DeepSeek Harness app already
              holds (~/.dsh/.credentials.yaml) is used as it is; change that one in the app.
              A flag, or a platform's token in the environment, means a script: the guided setup is
              skipped even at a terminal. One messenger at a time, beside the terminal: a new one
              replaces the one there (its tokens stay where they are).
  --channels  channel ids to answer in, added to the list; * for every channel the bot is in
  --users     user ids that may talk to it, added to allowedUsers; with none listed anyone who can
              reach the bot may
  --no-verify do not ask the platform whether the tokens work
  remove      takes the platform out of the profile; its tokens stay where they are
  stop        stops the gateway and its health probe, until the next login or start
  status      exit 0 when the gateway runs, is connected and has its tokens; --json for a program
  manifest    a Slack app manifest: api.slack.com/apps → Create New App → From a manifest

  Exit: 0 done; 1 failed, not connected, or a platform that could not be reached; 2 a missing or
  invalid answer (nothing written); 130 cancelled.
`

// ── Commands ──────────────────────────────────────────────────────────────────

function profileName(io: GatewayIO, p: Paths, given: string | undefined): string {
  if (given !== undefined) return given
  if (io.env.DEEPBOT_PROFILE) return io.env.DEEPBOT_PROFILE
  if (existsSync(p.plist)) {
    const r = io.run(PLUTIL, ['-extract', 'EnvironmentVariables.DEEPBOT_PROFILE', 'raw', '-o', '-', p.plist])
    if (r.status === 0 && r.stdout.trim() !== '') return r.stdout.trim()
  }
  return 'agent'
}

interface Loaded { name: string; path: string; text: string; lists: DeepbotLists }
function loadProfile(io: GatewayIO, p: Paths, given: string | undefined): Loaded | { error: string; code: number } {
  const name = profileName(io, p, given)
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(name)) return { error: `not a profile name: ${name}`, code: 2 }
  const path = join(p.dsh, 'profiles', name, 'cordis.patch.yml')
  if (!existsSync(path)) return { error: `no profile at ${tilde(io, path)}: install deepseek-bot first (install.sh), or name one with --profile`, code: 1 }
  const text = readFileSync(path, 'utf8')
  const lists = readProfile(text)
  if ('error' in lists) return { error: `${tilde(io, path)}: ${lists.error}. Edit the deepbot row by hand.`, code: 1 }
  return { name, path, text, lists }
}

const messengersOf = (platforms: string[]) => platforms.filter((name) => name !== 'local')
const describeChannels = (ids: string[]) => (ids.includes('*') ? '* (every channel the bot is in)' : ids.join(', '))
const describeUsers = (ids: string[]) => (ids.length === 0 ? 'anyone who can reach the bot' : ids.join(', '))

async function setup(io: GatewayIO, p: Paths, o: Options): Promise<number> {
  const named = o.positional[0]
  if (named !== undefined && !isPlatform(named)) { io.err(`setup: ${named} is not one of slack, telegram, discord or local\n\n${GATEWAY_USAGE}`); return 2 }
  const platform = named as Platform | undefined
  // At a terminal it is the guided setup: a menu, the browser, each token checked as it is pasted — unless
  // the answers came with it. A flag, or a token in the environment, means a script or an agent at a
  // terminal: those take the path below, where nothing they said is dropped.
  const given = o.channels !== undefined || o.users !== undefined || !o.verify || !o.restart
    || (platform !== undefined && PLATFORMS[platform].tokens.some((t) => io.env[t.key]))
  if (io.choose !== undefined && io.ask !== undefined && !given) return wizard(io, p, o, platform)
  // Without one — an agent, a script — every answer comes from the environment and the flags, and nothing is asked.
  if (platform === undefined) { io.err(`setup: which platform? slack, telegram, discord or local — or run it at a terminal for the guided setup\n\n${GATEWAY_USAGE}`); return 2 }
  const spec = PLATFORMS[platform]
  const channels = o.channels === undefined ? undefined : parseIds(o.channels, true)
  if (channels === null) { io.err(`--channels: ids are letters, digits, - and _, separated by spaces or commas, or * alone (got: ${o.channels})`); return 2 }
  const users = o.users === undefined ? undefined : parseIds(o.users, false)
  if (users === null) { io.err(`--users: ids are letters, digits, - and _, separated by spaces or commas (got: ${o.users})`); return 2 }
  const profile = loadProfile(io, p, o.profile)
  if ('error' in profile) { io.err(profile.error); return profile.code }
  const { lists } = profile

  for (const line of spec.guide) io.out(line)

  // Tokens: every answer is gathered and checked before anything is written.
  const envText = readText(p.env)
  const store = storeEntries(readText(p.store))
  const tokens: TokenAnswer[] = []
  const missing: string[] = []
  for (const t of spec.tokens) {
    const given = io.env[t.key]?.trim()
    // A harness set up before this: a token the app already holds is used as it is. Another one cannot be put
    // in its place from here — the harness reads the app's store before ~/.dsh/.env, and this never writes it.
    // The same token given again is not a conflict (an agent re-running setup); it is compared in memory only.
    if (store.has(t.key)) {
      if (given && given !== store.get(t.key)) {
        io.err(`${t.key} is held by the DeepSeek Harness app (${tilde(io, p.store)}), which the harness reads before ${tilde(io, p.env)}: one written here would never be read. Change it in the app. Nothing was written.`)
        return 2
      }
      io.out(`${t.key}: held by the DeepSeek Harness app${given ? ' (the same token)' : ''}, used as it is`)
      continue
    }
    if (!given) {
      if (envValue(envText, t.key) !== undefined) io.out(`${t.key}: already set, kept`)
      else missing.push(t.key)
      continue
    }
    if (!t.shape.test(given)) { io.err(`${t.key} does not look like a ${t.label} (expected ${t.expect}); nothing was written`); return 2 }
    tokens.push({ key: t.key, value: given, from: 'from the environment' })
  }
  if (missing.length > 0) {
    io.err(`missing: ${missing.join(', ')}. Give ${missing.length > 1 ? 'them as environment variables' : 'it as an environment variable'} — ${missing.map((k) => `${k}=…`).join(' ')} dsh gateway setup ${platform}${io.ask === undefined ? ' — or run dsh gateway setup at a terminal' : ' — or run dsh gateway setup with no flags, for the guided setup'}. Nothing was written.`)
    return 2
  }
  if (o.verify) {
    let botApp: string | undefined
    for (const t of tokens) {
      const r = await verifyToken(io.fetch, t.key, t.value)
      // Refused is a wrong answer (2); unreachable says nothing about the token (1).
      if (r.ok === false) { io.err(`${t.key}: ${r.reason}. Nothing was written (--no-verify skips this check).`); return r.unreachable ? 1 : 2 }
      io.out(`${t.key}: works — ${r.who}`)
      if (t.key === 'SLACK_BOT_TOKEN') botApp = r.app
    }
    // Two tokens from two apps both work, and the bot then listens as one app and posts as another. Held
    // against the app-level token the harness will read: the app's store before anything in ~/.dsh/.env.
    const appToken = store.has('SLACK_APP_TOKEN') ? store.get('SLACK_APP_TOKEN') : (tokens.find((t) => t.key === 'SLACK_APP_TOKEN')?.value ?? envValue(envText, 'SLACK_APP_TOKEN'))
    const appApp = appOfAppToken(appToken)
    if (botApp !== undefined && appApp !== undefined && botApp !== appApp) {
      io.err(`the bot token is from Slack app ${botApp} and the app-level token from ${appApp}: both must come from one app. Nothing was written.`)
      return 2
    }
  }

  const written = commitPlatform(p, profile, platform, tokens, channels, users)
  if (failed(written)) { io.err(`${tilde(io, profile.path)}: ${written.error}. Nothing was written.`); return 1 }
  const { next } = written
  for (const t of tokens) io.out(`${t.key}: saved to ${tilde(io, p.env)} (${t.from})`)
  io.out(`profile ${profile.name}: platform ${next.platform.join(', ')}`)
  io.out(`  channels: ${describeChannels(next.targetChannels)}`)
  io.out(`  people:   ${describeUsers(next.allowedUsers)}`)
  if (written.replaced.length > 0) io.out(`  note: ${platform} replaces ${written.replaced.join(', ')} — one messenger at a time; its tokens stay where they are`)
  if (written.channelsReset) io.out(`  note: the channel list was ${written.replaced.join(', ')}'s; it now answers in every ${platform} channel it is in (--channels narrows it)`)
  else if (platform !== 'local' && channels === undefined && !next.targetChannels.includes('*')) io.out(`  note: it answers only in the channels listed; add this platform's with --channels`)
  if (platform !== 'local' && users === undefined) {
    io.out(next.allowedUsers.length === 0
      ? `  note: anyone who can message the bot on ${platform} can run it; --users limits who (${spec.whoami})`
      : `  note: no one on ${platform} is answered until their id is in allowedUsers: --users (${spec.whoami})`)
  }

  if (!written.changed) { io.out('nothing changed'); return 0 }
  return applyChange(io, p, o, next.platform)
}

interface TokenAnswer { key: string; value: string; from: string }

/**
 * Write a platform's tokens to ~/.dsh/.env and its lists to the deepbot row. Nothing is restarted here.
 *
 * One messenger at a time, beside the terminal: the composite transport sends every conversation the
 * terminal does not claim to the first messenger, so a second one listed would never be answered. A new
 * messenger replaces the one there; the old one's channel ids mean nothing to it, so a narrowed channel
 * list starts again at every channel, and its people are replaced by the ones given (kept when none are,
 * which answers nobody new: closed, not open).
 */
function commitPlatform(p: Paths, profile: Loaded, platform: Platform, tokens: TokenAnswer[], channels: string[] | undefined, users: string[] | undefined, replaceUsers = false): { error: string } | { next: DeepbotLists; changed: boolean; replaced: string[]; channelsReset: boolean } {
  const { lists } = profile
  const replaced = platform === 'local' ? [] : messengersOf(lists.platform).filter((name) => name !== platform)
  const kept = lists.platform.filter((name) => !replaced.includes(name))
  const terminal = kept.includes('local') || platform === 'local'
  const switched = replaced.length > 0
  const channelsReset = switched && channels === undefined && !lists.targetChannels.includes('*')
  const next: DeepbotLists = {
    platform: kept.includes(platform) ? kept : [...kept, platform],
    targetChannels: switched
      ? (channels === undefined || channels.includes('*') ? ['*'] : [...channels, ...(terminal ? ['tui'] : [])])
      : mergeIds(lists.targetChannels, platform === 'local' ? [...(channels ?? []), 'tui'] : (channels ?? [])),
    allowedUsers: users === undefined ? lists.allowedUsers : switched || replaceUsers ? users : mergeIds(lists.allowedUsers, users),
  }
  const text = writeProfile(profile.text, next)
  if (typeof text !== 'string') return text
  const envText = readText(p.env)
  let env = envText
  for (const t of tokens) env = envSet(env, t.key, t.value)
  if (env !== envText) writeFile(p.env, env, 0o600, true)
  if (text !== profile.text) writeFile(profile.path, text, 0o644)
  return { next, changed: env !== envText || text !== profile.text, replaced, channelsReset }
}

async function applyChange(io: GatewayIO, p: Paths, o: Options, platforms: string[]): Promise<number> {
  if (!o.restart) { io.out('not restarted (--no-restart): it takes effect at the next start — dsh gateway restart'); return 0 }
  if (!service(io, GATEWAY_LABEL).loaded) { io.out('the gateway is not running; it takes effect when it starts — dsh gateway start'); return 0 }
  return restartGateway(io, p, messengersOf(platforms).length)
}

async function remove(io: GatewayIO, p: Paths, o: Options): Promise<number> {
  const platform = o.positional[0]
  if (!isPlatform(platform)) { io.err('remove: which platform? slack, telegram, discord or local'); return 2 }
  const profile = loadProfile(io, p, o.profile)
  if ('error' in profile) { io.err(profile.error); return profile.code }
  const { platform: current } = profile.lists
  if (!current.includes(platform)) { io.out(`${platform} is not in profile ${profile.name}; nothing changed`); return 0 }
  const rest = current.filter((name) => name !== platform)
  if (rest.length === 0) { io.err(`${platform} is the only platform in profile ${profile.name}; the gateway needs one. Set up another first.`); return 1 }
  const text = writeProfile(profile.text, { platform: rest })
  if (typeof text !== 'string') { io.err(`${tilde(io, profile.path)}: ${text.error}. Nothing was written.`); return 1 }
  writeFile(profile.path, text, 0o644)
  io.out(`profile ${profile.name}: platform ${rest.join(', ')}`)
  if (tokenKeys(platform).length > 0) io.out(`  its tokens stay where they are: ${tokenKeys(platform).join(', ')}`)
  return applyChange(io, p, o, rest)
}
const tokenKeys = (platform: Platform) => PLATFORMS[platform].tokens.map((t) => t.key)

interface Status {
  service: { installed: boolean; running: boolean; pid: number | null }
  profile: { name: string; path: string; platforms: string[]; channels: string[]; allowedUsers: string[] } | { error: string }
  /** Where a running gateway finds each credential: the app's store, ~/.dsh/.env, or nowhere (null). */
  credentials: Record<string, Where>
  health: { connected: boolean; connectedAt: number | null; lastError: string | null; heartbeatAgeMs: number | null } | null
  healthy: boolean
}

function status(io: GatewayIO, p: Paths, o: Options): number {
  const gateway = service(io, GATEWAY_LABEL)
  const loaded = loadProfile(io, p, o.profile)
  const envText = readText(p.env)
  const held = storeRefs(readText(p.store))
  const credentials: Record<string, Where> = {}
  const platforms = 'error' in loaded ? [] : loaded.lists.platform
  const platformKeys = platforms.filter(isPlatform).flatMap(tokenKeys)
  for (const key of platformKeys) credentials[key] = whereIs(key, held, envText)
  const needed = platformKeys.every((key) => credentials[key] !== null)
  // The model's key — reported, not required: the harness may reach its model another way (a subscription is unverified here).
  const routed = routeKeys('error' in loaded ? '' : loaded.text)
  const modelKeys = routed.length > 0 ? routed : ['DEEPSEEK_API_KEY']
  for (const key of modelKeys) credentials[key] = whereIs(key, held, envText)
  const h = readHealth(p)
  const age = h?.updatedAt === undefined ? null : io.now() - h.updatedAt
  const connected = messengersOf(platforms).length === 0 || h?.connected === true
  const s: Status = {
    service: { installed: existsSync(p.plist), running: gateway.loaded && gateway.pid !== null, pid: gateway.pid },
    profile: 'error' in loaded ? { error: loaded.error } : { name: loaded.name, path: loaded.path, platforms, channels: loaded.lists.targetChannels, allowedUsers: loaded.lists.allowedUsers },
    credentials,
    health: h === null ? null : { connected: h.connected === true, connectedAt: h.connectedAt ?? null, lastError: h.lastError ?? null, heartbeatAgeMs: age },
    healthy: false,
  }
  // The health file must be the running process's: a gateway that never started its plugin leaves the last one's.
  s.healthy = s.service.running && h?.pid === gateway.pid && !('error' in s.profile) && needed && connected && age !== null && age < STALE_MS
  if (o.json) { io.out(JSON.stringify(s, null, 2)); return s.healthy ? 0 : 1 }

  io.out(`service    ${s.service.running ? `running (pid ${s.service.pid})`
    : gateway.loaded ? 'loaded, not running — launchd restarts it; if it keeps exiting, see the log and dsh gateway restart'
    : s.service.installed ? 'stopped — dsh gateway start' : 'not installed — install.sh'}`)
  if ('error' in s.profile) io.out(`profile    ${s.profile.error}`)
  else {
    io.out(`profile    ${s.profile.name} (${tilde(io, s.profile.path)})`)
    io.out(`platforms  ${s.profile.platforms.join(', ')}`)
    io.out(`channels   ${describeChannels(s.profile.channels)}`)
    io.out(`people     ${describeUsers(s.profile.allowedUsers)}`)
  }
  const found = (where: Where) => (where === 'store' ? 'set (DeepSeek Harness app)' : where === 'dotenv' ? `set (${tilde(io, p.env)})` : 'missing')
  io.out(`tokens     ${'error' in loaded ? 'unknown — the profile could not be read' : platformKeys.map((k) => `${k} ${found(credentials[k])}`).join(', ') || 'none needed'}`)
  if (h !== null && s.service.running && h.pid !== gateway.pid) io.out(`           the health file is from pid ${h.pid ?? '?'}, not the running ${gateway.pid}: its plugin has not started`)
  io.out(`model key  ${modelKeys.map((k) => `${k} ${credentials[k] === null ? `not in the DeepSeek Harness app or ${tilde(io, p.env)}` : found(credentials[k])}`).join(', ')}${routed.length === 0 ? ' — DeepSeek\'s own API, the default route; a route in the profile names its own key' : ''}`)
  if (h === null) io.out('health     no health file yet — the gateway has not started')
  else {
    const since = h.connectedAt ? ` since ${new Date(h.connectedAt).toISOString()}` : ''
    const beat = age === null ? '' : `, heartbeat ${Math.round(age / 1000)}s ago${age >= STALE_MS ? ' (stale)' : ''}`
    io.out(`health     ${h.connected === true ? `connected${since}` : 'not connected'}${beat}${h.lastError ? ` — last error: ${h.lastError}` : ''}`)
  }
  return s.healthy ? 0 : 1
}

/** `dsh gateway <argv>`: the exit status. */
export async function gateway(argv: string[], io: GatewayIO): Promise<number> {
  const [command, ...rest] = argv
  if (!GATEWAY_COMMANDS.has(command)) { io.err(GATEWAY_USAGE); return 2 }
  const o = parseOptions(command, rest)
  if ('error' in o) { io.err(`${o.error}\n\n${GATEWAY_USAGE}`); return 2 }
  if (o.help) { io.out(GATEWAY_USAGE); return 0 }
  if (command === 'manifest') {
    if (o.positional.length !== 1 || o.positional[0] !== 'slack') { io.err('manifest: only slack has one (dsh gateway manifest slack)'); return 2 }
    io.out(JSON.stringify(slackManifest(), null, 2))
    return 0
  }
  if (o.positional.length > (command === 'setup' || command === 'remove' ? 1 : 0)) { io.err(`${command}: unexpected ${o.positional.join(' ')}\n\n${GATEWAY_USAGE}`); return 2 }
  // The services, the probe and the runner read ~/.dsh; tokens and profiles anywhere else would not be read.
  if (io.env.DSH_HOME && resolve(io.env.DSH_HOME) !== join(io.home, '.dsh')) {
    io.err(`DSH_HOME=${io.env.DSH_HOME} is not supported: the services read ${join(io.home, '.dsh')}`)
    return 2
  }
  const p = paths(io)
  switch (command) {
    case 'setup': return setup(io, p, o)
    case 'remove': return remove(io, p, o)
    case 'status': return status(io, p, o)
    case 'stop': return stop(io, p)
  }
  // start and restart wait for a connection only where a messenger is served; an unreadable profile counts as one.
  const loaded = loadProfile(io, p, undefined)
  const messengers = 'error' in loaded ? 1 : messengersOf(loaded.lists.platform).length
  if (command === 'restart' && service(io, GATEWAY_LABEL).loaded) return restartGateway(io, p, messengers)
  return start(io, p, messengers)
}

// ── The guided setup ──────────────────────────────────────────────────────────
//
// `dsh gateway setup` at a terminal: a menu of the messengers with where each one stands, then each step
// chosen with ↑↓ and Enter. The browser opens where a token is made, each token is checked as it is pasted
// and asked again when it is wrong, and one restart is offered at the end. Without a terminal the
// same setup takes its answers from the environment and the flags (above).

/** A line of a menu: what it says, and a dimmer note beside it. */
export interface Choice { label: string; hint?: string }

/** Ctrl+C anywhere in the guided setup: what was saved stays saved, and nothing more happens. */
class Quit extends Error {}

const ink = {
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
  ok: (s: string) => `\x1b[32m✓\x1b[39m ${s}`,
  warn: (s: string) => `\x1b[33m⚠\x1b[39m ${s}`,
  fail: (s: string) => `\x1b[31m✗\x1b[39m ${s}`,
}

const TITLE: Record<Platform, string> = { slack: '💬 Slack', telegram: '✈️  Telegram', discord: '🎮 Discord', local: '🖥️  Terminal (dsh)' }
const ORDER: Platform[] = ['slack', 'telegram', 'discord', 'local']
const STATE_HINT = { 'set up': '✅ set up', 'tokens missing': '⚠️  tokens missing', 'not set up': '⬜ not set up' }
/** View channels, send messages, attach files, read message history, send messages in threads. */
const DISCORD_PERMISSIONS = 1024 + 2048 + 32768 + 65536 + 2 ** 38
/** GATEWAY_MESSAGE_CONTENT and its _LIMITED form, in an application's flags. */
const DISCORD_MESSAGE_CONTENT = (1 << 18) | (1 << 19)

type Guided = { saved: boolean; tips: string[] }
const BACK: Guided = { saved: false, tips: [] }

const say = (io: GatewayIO, text: string) => io.out(`   ${text}`)
const plain = (platform: Platform) => TITLE[platform].replace(/^\S+\s+/, '')

async function pick(io: GatewayIO, title: string, options: Choice[], initial = 0): Promise<number | 'back'> {
  const r = await io.choose(title, options, initial)
  if (r === 'quit') throw new Quit()
  return r
}

async function line(io: GatewayIO, question: string, secret = false): Promise<string> {
  const r = await io.ask(question, secret)
  if (r === null) throw new Quit()
  return r.trim()
}

function heading(io: GatewayIO, platform: Platform, step: string): void {
  io.out('')
  io.out(`${ink.bold(`◆ ${TITLE[platform]}`)}  ${ink.dim(step)}`)
}

/** Open a link, or say where it is when no browser could be opened. */
function browse(io: GatewayIO, url: string, opened: string): void {
  if (io.openUrl?.(url)) say(io, ink.ok(opened))
  else { say(io, ink.warn('no browser could be opened — open this link:')); say(io, url) }
}

function tokenSpec(platform: Platform, key: string): TokenSpec {
  return PLATFORMS[platform].tokens.find((t) => t.key === key)
}

/**
 * A token, asked until one works: its shape, then the platform. Three wrong ones go back to the menu, and so
 * do Enter or Esc alone. A platform that cannot be reached is not a wrong token: try again, or save it unchecked.
 */
async function askToken<T extends { ok: true; who: string }>(io: GatewayIO, t: TokenSpec, check: (value: string) => Promise<T | { ok: false; reason: string; unreachable?: boolean }>): Promise<{ value: string; result: T | null } | null> {
  for (let wrong = 0; wrong < 3;) {
    const value = await line(io, `   🔑 ${t.label} (${t.expect}):`, true)
    if (value === '') return null
    if (!t.shape.test(value)) { say(io, ink.fail(`that is not a ${t.label} (${t.expect}) — paste it again, or Enter to go back`)); wrong++; continue }
    const r = await check(value)
    if (r.ok === true) { say(io, ink.ok(r.who)); return { value, result: r } }
    if (r.unreachable) {
      say(io, ink.warn(r.reason))
      const c = await pick(io, '   It could not be checked:', [{ label: '🔁 Try again' }, { label: '💾 Save it unchecked' }])
      if (c === 'back') return null
      if (c === 1) return { value, result: null }
      continue
    }
    say(io, ink.fail(`${r.reason} — paste it again, or Enter to go back`))
    wrong++
  }
  say(io, ink.warn('three tokens refused — back to the menu'))
  return null
}

type Obtained<T> = { value: string; result: T | null; held: 'store' | 'dotenv' | null }

/**
 * A platform's token: the one the DeepSeek Harness app holds, used as it is; the one saved in ~/.dsh/.env,
 * if the person keeps it; else a new one, asked for after `intro` (the step that makes one). A held or
 * saved token is still checked, in memory, for who the bot is; a saved one the platform refuses is asked
 * again. Null when the person went back.
 */
async function obtain<T extends { ok: true; who: string }>(io: GatewayIO, p: Paths, platform: Platform, key: string, check: (value: string) => Promise<T | { ok: false; reason: string; unreachable?: boolean }>, intro: () => Promise<boolean>): Promise<Obtained<T> | null> {
  const t = tokenSpec(platform, key)
  const stored = storeEntries(readText(p.store)).get(key)
  if (stored !== undefined) {
    const r = await check(stored)
    // It cannot be replaced from here; a refused one would only show at the restart, as "not connected".
    if (r.ok === false && !r.unreachable) { say(io, ink.fail(`the ${t.label} in the DeepSeek Harness app: ${r.reason} — change it in the app`)); return null }
    say(io, ink.ok(`the ${t.label} is in the DeepSeek Harness app — used as it is${r.ok === true ? `: ${r.who}` : ''}`))
    return { value: stored, result: r.ok === true ? r : null, held: 'store' }
  }
  const saved = envValue(readText(p.env), key)
  if (saved !== undefined) {
    const c = await pick(io, `   The ${t.label}:`, [{ label: '✅ Use the saved one', hint: tilde(io, p.env) }, { label: '🔑 Paste a new one' }])
    if (c === 'back') return null
    if (c === 0) {
      const r = await check(saved)
      if (r.ok === true) { say(io, ink.ok(r.who)); return { value: saved, result: r, held: 'dotenv' } }
      if (r.unreachable) { say(io, ink.warn(`${r.reason} — used unchecked`)); return { value: saved, result: null, held: 'dotenv' } }
      say(io, ink.fail(`the saved one: ${r.reason} — paste a new one`))
    }
  }
  if (!(await intro())) return null
  const got = await askToken(io, t, check)
  return got === null ? null : { ...got, held: null }
}

/** What was answered for who may talk to it: ids that replace the list or are added to it, or undefined to keep it. */
type People = { ids: string[]; replace: boolean } | undefined

async function whoMayTalk(io: GatewayIO, profile: Loaded, platform: Platform, owner?: { id: string; username: string } | null): Promise<People | 'back'> {
  // On a switch the people listed were the old messenger's: their ids mean nothing here, so start afresh.
  const listed = messengersBesides(profile, platform).length > 0 ? [] : profile.lists.allowedUsers
  const askIds = async (question: string): Promise<string[] | null> => {
    for (;;) {
      const answer = await line(io, question)
      if (answer === '') return null
      const ids = parseIds(answer, false)
      if (ids !== null) return ids
      say(io, ink.fail('ids are letters, digits, - and _, with spaces between them'))
    }
  }
  const anyone = platform === 'slack' ? '👥 Everyone in the workspace' : '👥 Anyone who finds the bot'
  const anyoneHint = platform === 'slack' ? undefined : `⚠️  anyone on ${plain(platform)} could run it`
  for (;;) {
    const options: Array<Choice & { kind: 'keep' | 'add' | 'me' | 'anyone' | 'some' }> = []
    if (listed.length > 0) {
      options.push({ kind: 'keep', label: `✅ Keep the ${listed.length} listed` }, { kind: 'add', label: '➕ Add people', hint: 'their user ids' })
      if (platform !== 'slack') options.push({ kind: 'me', label: '🙋 Only me', hint: owner ? `@${owner.username}, instead of the list` : 'instead of the list' })
      options.push({ kind: 'anyone', label: anyone, hint: anyoneHint })
    } else {
      if (platform !== 'slack') options.push({ kind: 'me', label: '🙋 Only me', hint: owner ? `@${owner.username}` : 'recommended' })
      options.push({ kind: 'anyone', label: anyone, hint: anyoneHint }, { kind: 'some', label: '✍️  Certain people', hint: 'their user ids' })
    }
    const c = await pick(io, '   Who may talk to it?', options)
    if (c === 'back') return 'back'
    const kind = options[c].kind
    if (kind === 'keep') return undefined
    if (kind === 'anyone') return { ids: [], replace: true }
    if (kind === 'me' && owner) return { ids: [owner.id], replace: true }
    say(io, ink.dim(`${PLATFORMS[platform].whoami}`))
    const ids = await askIds(kind === 'me' ? '   🙋 Your user id:' : '   ✍️  User ids, spaces between:')
    if (ids !== null) return { ids, replace: kind !== 'add' }
  }
}

/** The messengers a profile serves other than this one: the one a switch to it would replace. */
const messengersBesides = (profile: Loaded, platform: Platform) => (platform === 'local' ? [] : messengersOf(profile.lists.platform).filter((name) => name !== platform))

function save(io: GatewayIO, p: Paths, profile: Loaded, platform: Platform, tokens: TokenAnswer[], people: People, tips: string[]): Guided {
  const written = commitPlatform(p, profile, platform, tokens, undefined, people?.ids, people?.replace === true)
  if (failed(written)) { say(io, ink.fail(`${tilde(io, profile.path)}: ${written.error} — nothing was written; edit the deepbot row by hand`)); return BACK }
  say(io, written.changed ? ink.ok(`${plain(platform)} saved${tokens.length > 0 ? ` — its tokens in ${tilde(io, p.env)}` : ''}`) : ink.dim(`${plain(platform)}: nothing to change`))
  for (const old of written.replaced) say(io, ink.ok(`${plain(old as Platform)} switched off — its tokens stay where they are`))
  if (written.channelsReset) say(io, ink.ok(`it answers in every ${plain(platform)} channel it is in — the channel list was ${written.replaced.map((n) => plain(n as Platform)).join(', ')}'s`))
  if (people === undefined && written.next.allowedUsers.length > 0 && platform !== 'local' && written.replaced.length > 0) say(io, ink.warn(`no one on ${plain(platform)} is answered until their id is listed`))
  return { saved: written.changed, tips }
}

function removeGuided(io: GatewayIO, profile: Loaded, platform: Platform): Guided {
  const rest = profile.lists.platform.filter((name) => name !== platform)
  if (rest.length === 0) { say(io, ink.fail('it is the only platform the bot has — set up another first')); return BACK }
  const text = writeProfile(profile.text, { platform: rest })
  if (typeof text !== 'string') { say(io, ink.fail(`${text.error} — nothing was written`)); return BACK }
  writeFile(profile.path, text, 0o644)
  say(io, ink.ok(`${plain(platform)} removed — its tokens stay where they are`))
  return { saved: true, tips: [] }
}

/** The token to write: a new one only — a held or saved one stays where it is. */
const newTokens = (got: { value: string; held: string | null }, key: string): TokenAnswer[] => (got.held === null ? [{ key, value: got.value, from: 'entered' }] : [])

async function guideSlack(io: GatewayIO, p: Paths, profile: Loaded): Promise<Guided> {
  let made = false
  // The app is made once, before the first token that is not already there.
  const create = async (): Promise<boolean> => {
    if (made) return true
    made = true
    const c = await pick(io, '   The Slack app:', [{ label: '🌐 Create it in the browser', hint: 'everything filled in' }, { label: '⏭  I already have one' }])
    if (c === 'back') return false
    if (c === 0) browse(io, `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(slackManifest()))}`, 'opened — pick your workspace, then Next → Create')
    return true
  }
  heading(io, 'slack', '1/2  the bot token')
  const bot = await obtain(io, p, 'slack', 'SLACK_BOT_TOKEN', (v) => verifyToken(io.fetch, 'SLACK_BOT_TOKEN', v), async () => {
    if (!(await create())) return false
    say(io, ink.dim('Install App → Install to Workspace → Allow, then copy the Bot User OAuth Token'))
    return true
  })
  if (bot === null) return BACK
  const botApp = bot.result?.app
  heading(io, 'slack', '2/2  the app-level token')
  const app = await obtain(io, p, 'slack', 'SLACK_APP_TOKEN', async (v) => {
    const r = await verifyToken(io.fetch, 'SLACK_APP_TOKEN', v)
    const id = appOfAppToken(v)
    if (r.ok === true && botApp !== undefined && id !== undefined && id !== botApp) return { ok: false as const, reason: `this token is from Slack app ${id} and the bot token from ${botApp}: both must come from one app` }
    return r
  }, async () => {
    if (!(await create())) return false
    say(io, ink.dim('Basic Information → App-Level Tokens → Generate Token and Scopes → add connections:write → Generate'))
    return true
  })
  if (app === null) return BACK
  const people = await whoMayTalk(io, profile, 'slack')
  if (people === 'back') return BACK
  const name = bot.result?.name ?? 'deepseek-bot'
  return save(io, p, profile, 'slack', [...newTokens(bot, 'SLACK_BOT_TOKEN'), ...newTokens(app, 'SLACK_APP_TOKEN')], people, [`💬 In Slack: /invite @${name} into a channel and mention it — or message it directly`])
}

async function guideTelegram(io: GatewayIO, p: Paths, profile: Loaded): Promise<Guided> {
  heading(io, 'telegram', '1/2  the bot')
  const bot = await obtain(io, p, 'telegram', 'TELEGRAM_BOT_TOKEN', (v) => verifyToken(io.fetch, 'TELEGRAM_BOT_TOKEN', v), async () => {
    say(io, ink.dim('In Telegram: @BotFather → /newbot → pick a name, and it replies with the token'))
    const c = await pick(io, '   @BotFather:', [{ label: '🌐 Open @BotFather' }, { label: '⏭  I have the token' }])
    if (c === 'back') return false
    if (c === 0) browse(io, 'https://t.me/BotFather', 'opened @BotFather')
    return true
  })
  if (bot === null) return BACK
  heading(io, 'telegram', '2/2  who may talk to it')
  const people = await whoMayTalk(io, profile, 'telegram')
  if (people === 'back') return BACK
  const name = bot.result?.name ? `@${bot.result.name}` : 'your bot'
  return save(io, p, profile, 'telegram', newTokens(bot, 'TELEGRAM_BOT_TOKEN'), people, [`✈️  In Telegram: message ${name}`])
}

async function guideDiscord(io: GatewayIO, p: Paths, profile: Loaded): Promise<Guided> {
  heading(io, 'discord', '1/3  the bot')
  const bot = await obtain(io, p, 'discord', 'DISCORD_BOT_TOKEN', (v) => discordApp(io.fetch, v), async () => {
    say(io, ink.dim('New Application → Bot → Reset Token and copy it; on the same page turn on Message Content Intent'))
    const c = await pick(io, '   The Discord app:', [{ label: '🌐 Open the Developer Portal' }, { label: '⏭  I have the token' }])
    if (c === 'back') return false
    if (c === 0) browse(io, 'https://discord.com/developers/applications', 'opened the Developer Portal')
    return true
  })
  if (bot === null) return BACK
  let app = bot.result
  // Without the Message Content intent Discord hands the bot every message with its text taken out.
  while (app !== null && (app.flags & DISCORD_MESSAGE_CONTENT) === 0) {
    say(io, ink.warn('Message Content Intent is off — Discord would hand the bot every message with its text removed'))
    say(io, ink.dim(`turn it on: https://discord.com/developers/applications/${app.id}/bot`))
    const c = await pick(io, '   Then:', [{ label: '🔁 It is on — check again' }, { label: '⏭  Go on without it' }])
    if (c !== 0) break
    const again = await discordApp(io.fetch, bot.value)
    if (again.ok === true) app = again
  }
  heading(io, 'discord', '2/3  invite it to a server')
  if (app === null) say(io, ink.warn('the application could not be read, so there is no invite link — make one under OAuth2 → URL Generator'))
  else {
    const url = `https://discord.com/oauth2/authorize?client_id=${app.id}&scope=bot&permissions=${DISCORD_PERMISSIONS}`
    const c = await pick(io, '   📨 The invite link:', [{ label: '🌐 Open it', hint: 'pick a server, then Authorize' }, { label: '⏭  Later' }])
    if (c === 0) browse(io, url, 'opened — pick a server, then Authorize')
    else say(io, url)
  }
  heading(io, 'discord', '3/3  who may talk to it')
  const people = await whoMayTalk(io, profile, 'discord', app?.owner)
  if (people === 'back') return BACK
  return save(io, p, profile, 'discord', newTokens(bot, 'DISCORD_BOT_TOKEN'), people, [`🎮 In Discord: mention @${app?.name ?? 'the bot'} in a channel it can see, or message it`])
}

async function guide(io: GatewayIO, p: Paths, profile: Loaded, platform: Platform): Promise<Guided> {
  if (platform === 'local') {
    if (!profile.lists.platform.includes('local')) return save(io, p, profile, 'local', [], undefined, ['🖥️  In a terminal: dsh'])
    const c = await pick(io, '   🖥️  The terminal (dsh) is on:', [{ label: '✅ Keep it on' }, { label: '🗑️  Turn it off' }])
    return c === 1 ? removeGuided(io, profile, 'local') : BACK
  }
  // One messenger at a time: another one there is replaced, once the person says so.
  const others = messengersBesides(profile, platform)
  if (others.length > 0) {
    const from = others.map((name) => plain(name as Platform)).join(', ')
    const c = await pick(io, `   The bot is on ${from}. One messenger at a time:`, [{ label: `🔀 Switch to ${plain(platform)}`, hint: `${from} stops answering; its tokens stay` }, { label: '↩️  Back' }])
    if (c !== 0) return BACK
  }
  if (stateOf(p, profile, platform) === 'set up') {
    const c = await pick(io, `   ${plain(platform)} is set up:`, [{ label: '✅ Keep it' }, { label: '🔁 Set it up again' }, { label: '🗑️  Remove it from the bot', hint: 'its tokens stay' }])
    if (c === 'back') return BACK
    // Keeping it after choosing to switch still switches: the other messenger goes.
    if (c === 0) return others.length > 0 ? save(io, p, profile, platform, [], undefined, []) : BACK
    if (c === 2) return removeGuided(io, profile, platform)
  }
  if (platform === 'slack') return guideSlack(io, p, profile)
  if (platform === 'telegram') return guideTelegram(io, p, profile)
  return guideDiscord(io, p, profile)
}

function stateOf(p: Paths, profile: Loaded, platform: Platform): keyof typeof STATE_HINT {
  if (!profile.lists.platform.includes(platform)) return 'not set up'
  const held = storeRefs(readText(p.store))
  const envText = readText(p.env)
  return tokenKeys(platform).every((key) => whereIs(key, held, envText) !== null) ? 'set up' : 'tokens missing'
}

async function wizard(io: GatewayIO, p: Paths, o: Options, only: Platform | undefined): Promise<number> {
  try {
    return await guided(io, p, o, only)
  } catch (e) {
    if (!(e instanceof Quit)) throw e
    io.out('')
    io.out(ink.dim('quit — what was saved stays saved'))
    return 130
  }
}

async function guided(io: GatewayIO, p: Paths, o: Options, only: Platform | undefined): Promise<number> {
  io.out('')
  io.out(ink.bold('🐋 deepseek-bot · messenger setup'))
  io.out(ink.dim('   ↑↓ move · Enter choose · Esc back · Ctrl+C quit'))
  const gateway = service(io, GATEWAY_LABEL)
  const health = readHealth(p)
  say(io, gateway.loaded && gateway.pid !== null ? ink.ok(`gateway running (pid ${gateway.pid})${health?.connected === true ? ' · connected' : ''}`)
    : existsSync(p.plist) ? ink.warn('gateway installed, not running') : ink.warn('gateway service not installed — install.sh sets it up'))
  let saved = false
  const tips: string[] = []
  for (let first = true; ; first = false) {
    const profile = loadProfile(io, p, o.profile)
    if ('error' in profile) { io.err(profile.error); return profile.code }
    let platform: Platform
    if (only !== undefined) {
      if (!first) break
      platform = only
    } else {
      const rows: Choice[] = ORDER.map((name) => ({
        label: TITLE[name],
        hint: name === 'local' ? (profile.lists.platform.includes('local') ? '✅ on' : '⬜ off') : STATE_HINT[stateOf(p, profile, name)],
      }))
      rows.push({ label: '✔  Done' })
      // Nothing set up yet: start on the first messenger. Otherwise on Done, so Enter leaves.
      const anySet = ORDER.some((name) => name !== 'local' && stateOf(p, profile, name) === 'set up')
      io.out('')
      const r = await pick(io, ink.bold('◆ Which messenger?'), rows, saved || anySet ? rows.length - 1 : 0)
      if (r === 'back' || r === rows.length - 1) break
      platform = ORDER[r]
    }
    const outcome = await guide(io, p, profile, platform)
    if (outcome.saved) { saved = true; tips.push(...outcome.tips) }
  }
  if (!saved) { say(io, ink.dim('nothing changed')); return 0 }
  return applyGuided(io, p, o, tips)
}

async function applyGuided(io: GatewayIO, p: Paths, o: Options, tips: string[]): Promise<number> {
  const profile = loadProfile(io, p, o.profile)
  const messengers = 'error' in profile ? 1 : messengersOf(profile.lists.platform).length
  io.out('')
  io.out(ink.bold('◆ Apply'))
  let code = 0
  if (!existsSync(p.plist)) {
    // Saved all the same: it is read when the service is installed and starts.
    say(io, ink.warn('the gateway service is not installed: run install.sh, then dsh gateway start'))
  } else {
    const loaded = service(io, GATEWAY_LABEL).loaded
    const r = await pick(io, '   The gateway reads this when it starts:', loaded
      ? [{ label: '🔄 Restart it now' }, { label: '⏭  Later', hint: 'dsh gateway restart' }]
      : [{ label: '▶️  Start it now' }, { label: '⏭  Later', hint: 'dsh gateway start' }])
    if (r === 0) code = loaded ? await restartGateway(io, p, messengers) : await start(io, p, messengers)
  }
  if (code === 0) {
    io.out('')
    io.out(`🎉 ${ink.bold('Done.')}`)
    for (const tip of tips) say(io, tip)
  }
  return code
}

// ── The process's own IO ──────────────────────────────────────────────────────

/**
 * Keys, one at a time, out of what a terminal sends: an escape sequence whole even when it arrives over
 * two reads (ssh, a loaded machine), several keys apart when they arrive in one, a character whole when
 * its bytes are split. A lone Esc is told from the start of a sequence by waiting 50 ms for the rest.
 */
export function keyReader(onKey: (key: string) => void): (chunk: Buffer | string) => void {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = () => { timer = null; const key = pending; pending = ''; if (key !== '') onKey(key) }
  const drain = () => {
    while (pending !== '') {
      if (pending[0] === '\x1b') {
        const seq = /^\x1b[[O][0-9;?<>=]*[\x40-\x7e]/.exec(pending)
        if (seq !== null) { pending = pending.slice(seq[0].length); onKey(seq[0]); continue }
        if (/^\x1b([[O][0-9;?<>=]*)?$/.test(pending)) { timer = setTimeout(flush, 50); return }
        pending = pending.slice(1)
        onKey('\x1b')
        continue
      }
      const ch = String.fromCodePoint(pending.codePointAt(0))
      pending = pending.slice(ch.length)
      onKey(ch)
    }
  }
  return (chunk) => {
    if (timer !== null) { clearTimeout(timer); timer = null }
    pending += typeof chunk === 'string' ? chunk : decoder.write(chunk)
    drain()
  }
}

/**
 * The terminal for the whole guided setup: raw mode and one reader from the first question to the end.
 * Each prompt took raw mode on and off before, and what was typed between two of them — an Enter while
 * a token was checked — was echoed, buffered and handed to the next one as its answer. Now a key with no
 * prompt open is dropped, and Ctrl+C then quits.
 *
 *   choose: ↑↓ (or j/k) move, Enter or Space chooses, a digit chooses its line, Esc ← or q goes back,
 *           Ctrl+C quits. Cleared when done, leaving one line that says what was chosen.
 *   ask:    a line; a secret shows a * per character. Esc is '' (back), Ctrl+C or Ctrl+D is null.
 */
export function terminalSession(input: NodeJS.ReadStream, output: NodeJS.WriteStream, onInterrupt?: () => void) {
  let handler: ((key: string) => void) | null = null
  let started = false
  const read = keyReader((key) => {
    if (handler !== null) handler(key)
    else if (key === '\x03') onInterrupt?.()
  })
  const start = () => {
    if (started) return
    started = true
    input.setRawMode(true)
    input.resume()
    input.on('data', read)
  }
  const close = () => {
    if (!started) return
    started = false
    handler = null
    input.off('data', read)
    input.setRawMode(false)
    input.pause()
    output.write('\x1b[?25h\x1b[?7h')
  }

  const choose = (title: string, options: Choice[], initial: number) => new Promise<number | 'back' | 'quit'>((done) => {
    let at = Math.min(Math.max(initial, 0), options.length - 1)
    let drawn = 0
    // The hints in one column, whatever the labels' widths (an emoji takes two cells).
    const column = Math.max(...options.map((o) => stringWidth(o.label)))
    const draw = () => {
      if (drawn > 0) output.write(`\x1b[${drawn}F`)
      const rows = [title, ...options.map((o, i) => {
        const padded = o.hint ? o.label + ' '.repeat(column - stringWidth(o.label)) : o.label
        const label = i === at ? `\x1b[36m❯\x1b[39m \x1b[1m${padded}\x1b[22m` : `  ${padded}`
        return `   ${label}${o.hint ? `  \x1b[2m${o.hint}\x1b[22m` : ''}`
      })]
      output.write(`${rows.map((row) => `\x1b[2K${row}`).join('\n')}\n`)
      drawn = rows.length
    }
    const finish = (value: number | 'back' | 'quit') => {
      handler = null
      output.write(`\x1b[${drawn}F\x1b[J`)
      if (typeof value === 'number') output.write(`${title} \x1b[2m›\x1b[22m ${options[value].label}\n`)
      output.write('\x1b[?25h\x1b[?7h')
      done(value)
    }
    handler = (key) => {
      if (key === '\x1b[A' || key === '\x1bOA' || key === 'k') at = (at + options.length - 1) % options.length
      else if (key === '\x1b[B' || key === '\x1bOB' || key === 'j') at = (at + 1) % options.length
      else if (key === '\r' || key === '\n' || key === ' ') return finish(at)
      else if (/^[1-9]$/.test(key) && Number(key) <= options.length) return finish(Number(key) - 1)
      else if (key === '\x1b' || key === '\x1b[D' || key === '\x1bOD' || key === 'q') return finish('back')
      else if (key === '\x03') return finish('quit')
      else return
      draw()
    }
    // The cursor hidden, and lines not wrapped: a wrapped row would throw the redraw's count off.
    output.write('\x1b[?25l\x1b[?7l')
    draw()
    start()
  })

  const ask = (question: string, secret: boolean) => new Promise<string | null>((done) => {
    output.write(`${question} `)
    let answer = ''
    const finish = (value: string | null) => {
      handler = null
      output.write('\n')
      done(value)
    }
    handler = (key) => {
      if (key === '\r' || key === '\n') return finish(answer)
      if (key === '\x03' || key === '\x04') return finish(null)
      if (key === '\x1b') return finish('')
      if (key === '\x7f' || key === '\b') {
        if (answer !== '') { answer = Array.from(answer).slice(0, -1).join(''); output.write('\b \b') }
        return
      }
      if (key.startsWith('\x1b') || key < ' ') return
      answer += key
      output.write(secret ? '*' : key)
    }
    start()
  })

  return { ask, choose, close }
}

export function processIO(): GatewayIO {
  const tty = process.stdin.isTTY === true && process.stdout.isTTY === true
  const quit = () => {
    terminal?.close()
    process.stdout.write('\n\x1b[2mquit — what was saved stays saved\x1b[22m\n')
    process.exit(130)
  }
  const terminal = tty ? terminalSession(process.stdin, process.stdout, quit) : null
  // However the process ends, the terminal is given back as it was — killed too.
  if (terminal !== null) {
    process.once('exit', terminal.close)
    for (const signal of ['SIGTERM', 'SIGHUP'] as const) process.once(signal, () => { terminal.close(); process.exit(128 + (signal === 'SIGTERM' ? 15 : 1)) })
  }
  return {
    home: homedir(),
    env: process.env,
    uid: process.getuid(),
    run: (cmd, args) => {
      const r = spawnSync(cmd, args, { encoding: 'utf8' })
      return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr || (r.error?.message ?? '') }
    },
    fetch: (url, init) => fetch(url, init),
    ask: terminal?.ask,
    choose: terminal?.choose,
    openUrl: (url) => process.platform === 'darwin' && spawnSync('/usr/bin/open', [url], { stdio: 'ignore' }).status === 0,
    out: (text) => { process.stdout.write(`${text}\n`) },
    err: (text) => { process.stderr.write(`${text}\n`) },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  }
}
