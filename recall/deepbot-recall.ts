#!/usr/bin/env node
/**
 * deepbot-recall — build a greppable index of past sessions.
 *
 * Why an indexer instead of a tool plugin:
 *   The agent runs confined to its home directory, so it cannot read the session
 *   store itself, and the harness ships no model-facing session-search tool. This
 *   script runs on the HOST side (launchd or a shell), reads the compressed
 *   session logs, and writes a plain-text JSONL index *inside the agent's
 *   workspace*. The agent then recalls with the file tools it already has.
 *
 * Storage layout it reads:
 *   $DSH_HOME/sessions/<cwd-bucket>/<session-id>/session.v4.jsonl.zstd
 *
 * The log is zstd with one frame appended per write. `zstdDecompressSync` only
 * decodes the FIRST frame, so frames are split on the zstd magic number and
 * decoded one at a time. (Verified: a 31-event session decodes to 1 event with
 * the naive call and to all 31 events with the split.)
 *
 * Usage:
 *   node dist/recall/deepbot-recall.js index [--out FILE] [--quiet]
 *   node dist/recall/deepbot-recall.js search <query> [--limit N] [--index FILE]
 *   node dist/recall/deepbot-recall.js recent [--limit N] [--index FILE]
 *   node dist/recall/deepbot-recall.js show <sessionId> [--limit N] [--index FILE]
 *
 * Zero dependencies. Node 22+ (needs node:zlib zstd support).
 */

import { readFileSync, mkdirSync, existsSync, readdirSync, statSync, lstatSync, realpathSync, rmSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { writeInside } from '../safeWrite.js'
import { recallIndexPath } from '../recallContext.js'
import { join, dirname, basename, resolve, sep } from 'node:path'
import { homedir } from 'node:os'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')

/**
 * Where the agent lives. `DEEPBOT_HOME` wins so the launchd refresh job and the
 * agent's own shell agree with the gateway's configuration. The middle case
 * covers the common single-agent layout with no environment at all.
 */
/** One directory under two names — one of them through a symlink — is still one directory. */
function sameDirectory(a, b) {
  if (a === b) return true
  if (typeof a !== 'string' || typeof b !== 'string') return false
  try { return realpathSync(a) === realpathSync(b) } catch { return false }
}

function resolveAgentHome() {
  if (process.env.DEEPBOT_HOME) return process.env.DEEPBOT_HOME
  const conventional = join(homedir(), 'dsh-agent')
  if (existsSync(conventional)) return conventional
  return join(homedir(), '.deepbot')
}
// By its resolved path: the adapter names the home by its process's cwd, which is resolved, and the
// harness records that path in each session. Taken as given, a home under a symlink got another index
// than the adapter reads, and every session was skipped as another working directory.
const AGENT_HOME = (() => { const home = resolveAgentHome(); try { return realpathSync(home) } catch { return home } })()
/** The home as it was named, which an --out may still use. */
const GIVEN_HOME = resolve(resolveAgentHome())

const argv = process.argv.slice(2)
const command = argv[0] ?? 'index'
function flag(name, fallback = undefined) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}

/** Decode every zstd frame in a buffer and concatenate the plaintext. */
function decompressAllFrames(buf) {
  const starts = []
  for (let i = 0; i <= buf.length - 4; i++) {
    if (buf.compare(ZSTD_MAGIC, 0, 4, i, i + 4) === 0) starts.push(i)
  }
  if (starts.length === 0) return ''
  let out = ''
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i]
    const to = i + 1 < starts.length ? starts[i + 1] : buf.length
    try {
      out += zstdDecompressSync(buf.subarray(from, to)).toString('utf8')
    } catch {
      // A partially written trailing frame is expected while a session is live.
    }
  }
  return out
}

/** Pull text blocks out of whichever shape this event carries. */
function textOf(event) {
  const candidates = [
    event?.data?.message?.content,
    event?.data?.content,
    ...(Array.isArray(event?.data?.inserted) ? event.data.inserted.map((m) => m?.content) : []),
  ]
  for (const content of candidates) {
    if (!Array.isArray(content)) continue
    const text = content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
      .trim()
    if (text !== '') return text
  }
  return ''
}

function roleOf(event) {
  if (event.type === 'user/message') return 'user'
  if (event.type === 'assistant/message') return 'assistant'
  return null
}

/**
 * The harness records system injections as user-role messages, so filtering by
 * role alone is not enough: measured on a real store, 33% of "user" messages
 * were injections (time-context, runtime-context, skill-catalog, user-approval,
 * agent-message, subagent-settled). Indexing them pollutes recall — a search for
 * "runtime" matches harness boilerplate instead of anything a person said.
 *
 * `source.kind` separates them cleanly: 'user' is human speech, 'model' is model
 * output. Anything else is protocol traffic. An absent kind is kept, so an
 * unknown shape is never silently dropped.
 */
function sourceKindOf(event) {
  return event?.data?.message?.source?.kind ?? event?.data?.source?.kind ?? event?.data?.kind ?? null
}
const HUMAN_KINDS = new Set(['user'])
const MODEL_KINDS = new Set(['model'])

/**
 * Harness-injected text, recognised by shape.
 *
 * `source.kind` is the clean discriminator when it is present, but it is not
 * always: measured on this store, time-context, runtime-context and the skill
 * catalog arrive as `{ type: 'user/message', data: { content: [...] } }` with no
 * `source` at all. A structural filter alone therefore lets harness boilerplate
 * into the index, and a search for "runtime" then matches the harness talking
 * about itself rather than anything a person said.
 *
 * These prefixes are only ever produced by the harness, never by a human.
 */
const BOILERPLATE_PREFIXES = [
  'Time sampled while preparing',
  'Current runtime context.',
  'The approval policy changed',
  'You are a delegated subagent',
  '<system-reminder>',
  'Background subagent ',
]
/**
 * Strip this adapter's own injected preamble from a user message.
 *
 * The prompt carries instructions, channel history and file-scope notes ahead of
 * the actual question, and the harness records the whole thing as one user
 * message. Indexing that means every turn re-indexes the full instruction text
 * and the channel transcript, so a search matches harness boilerplate and the
 * same conversation appears many times. Measured: a search for a phrase the user
 * had genuinely said returned matches "from the instruction block injected into
 * this turn" and nothing that looked like speech.
 *
 * The adapter ends its preamble with this marker, so the marker is the boundary.
 */
const USER_MESSAGE_MARKER = '[user message]'
function stripInjectedPreamble(text) {
  const at = text.lastIndexOf(USER_MESSAGE_MARKER)
  return at >= 0 ? text.slice(at + USER_MESSAGE_MARKER.length).trim() : text
}

function isBoilerplate(text) {
  return BOILERPLATE_PREFIXES.some((prefix) => text.startsWith(prefix))
}

/** Find every session log under the store. */
function findSessionLogs(root) {
  const found = []
  if (!existsSync(root)) return found
  for (const bucket of readdirSync(root)) {
    const bucketPath = join(root, bucket)
    let entries
    try { if (!statSync(bucketPath).isDirectory()) continue; entries = readdirSync(bucketPath) } catch { continue }
    for (const entry of entries) {
      const file = join(bucketPath, entry, 'session.v4.jsonl.zstd')
      if (existsSync(file)) found.push({ file, sessionId: entry })
    }
  }
  return found
}

function readSession(file, sessionId, includeInjected) {
  const raw = decompressAllFrames(readFileSync(file))
  const lines = raw.split('\n').filter((l) => l.trim() !== '')
  const records = []
  let skippedInjected = 0
  let header = { id: sessionId, createdAt: undefined, cwd: undefined }
  // Which conversation this session belongs to, so recall can stay inside it: the adapter's
  // "[this conversation]" block names the channel. Read only from the session's first user message,
  // before its first marker — the adapter's preamble. Anything after a marker, and any later message,
  // can carry text the user typed, including a block and a marker of their own (found by review).
  let channel = null
  let placed = false
  for (const line of lines) {
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.type === 'session') {
      header = { id: event.id ?? sessionId, createdAt: event.createdAt, cwd: event.cwd }
      continue
    }
    const role = roleOf(event)
    if (role === null) continue
    const kind = sourceKindOf(event)
    if (!includeInjected && kind !== null) {
      const wanted = role === 'user' ? HUMAN_KINDS : MODEL_KINDS
      if (!wanted.has(kind)) { skippedInjected++; continue }
    }
    let text = textOf(event)
    if (role === 'user' && !placed) {
      placed = true
      const at = text.indexOf(USER_MESSAGE_MARKER)
      // The adapter's exact shape: its own line, then "channel=… thread=…". Quoted material — history is
      // one line per message, attachments are indented — cannot produce it.
      const named = at >= 0 ? /(?:^|\n)\[this conversation\]\nchannel=(\S+) thread=/.exec(text.slice(0, at)) : null
      if (named !== null) channel = named[1]
    }
    if (role === 'user') text = stripInjectedPreamble(text)
    if (text === '') continue
    // A turn that kept quiet (replyMode 'thread') answered with the marker, which the adapter posts nothing for: nothing
    // was said, so nothing is recalled. The adapter's NO_REPLY, repeated: this job imports nothing from the plugin.
    if (role === 'assistant' && /^[\s\p{P}\p{S}]*(\[no[\s_-]?reply\]|no[\s_-]?reply[\s\p{P}\p{S}]*$)|(^|\n)[ \t]*\[no[\s_-]?reply\][\s\p{P}\p{S}]*$/iu.test(text)) continue
    // Second gate for the shapes that carry no `source` at all.
    if (!includeInjected && isBoilerplate(text)) { skippedInjected++; continue }
    records.push({
      sessionId: header.id ?? sessionId,
      ts: event.time ?? header.createdAt ?? null,
      seq: event.seq ?? null,
      role,
      ...(kind !== null ? { sourceKind: kind } : {}),
      text,
    })
  }
  if (channel !== null) for (const record of records) record.channel = channel
  return { header, records, skippedInjected }
}

/**
 * The session logs of the workspaces being indexed, parsed once: one run indexes several from it.
 * The store is shared by every profile and directory, so a session from anywhere else is dropped as
 * soon as it is read — keeping it would hold the whole store in memory. `cwds` null keeps every one
 * (--all-cwds).
 */
function parseLogs(quiet, cwds) {
  // --include-injected indexes harness protocol traffic too (debugging only).
  const includeInjected = argv.includes('--include-injected')
  const out = []
  let elsewhere = 0
  // By real path, as buildIndex compares: one directory spelled two ways (a link, /var and /private/var)
  // is one workspace. Cached, since many sessions share a directory.
  const realOf = new Map()
  const real = (p) => {
    if (typeof p !== 'string') return p
    if (!realOf.has(p)) { try { realOf.set(p, realpathSync(p)) } catch { realOf.set(p, p) } }
    return realOf.get(p)
  }
  const wanted = cwds === null ? null : new Set([...cwds].map(real))
  for (const { file, sessionId } of findSessionLogs(join(DSH_HOME, 'sessions'))) {
    let parsed
    try { parsed = readSession(file, sessionId, includeInjected) } catch (e) {
      if (!quiet) console.error(`  skip ${sessionId}: ${String(e.message ?? e)}`)
      continue
    }
    if (wanted === null || wanted.has(real(parsed.header.cwd))) out.push({ sessionId, parsed })
    else elsewhere++
  }
  // Dropped sessions still count as "skipped, different working directory" in each index's report.
  return { logs: out, elsewhere }
}

/**
 * Tenant workspaces under the home (`<home>/tenants/<name>`, the adapter's default tenantRoot).
 * Each keeps its own recall, as it keeps its own notes. A deployment with a custom tenantRoot
 * indexes those with explicit --cwd/--out runs.
 */
function tenantWorkspaces(home) {
  const root = join(home, 'tenants')
  if (!existsSync(root)) return []
  // lstat: a link the agent left among the tenants is not a tenant, and is never written through.
  return readdirSync(root).map((name) => join(root, name)).filter((dir) => { try { return lstatSync(dir).isDirectory() } catch { return false } })
}

function buildIndex(outFile, quiet, wantedCwd, { logs, elsewhere }) {
  // Privacy default: only the agent's own sessions. The store is shared by every
  // profile and working directory, so indexing everything would let the bot
  // recall unrelated contexts (other profiles' sessions, build/planning runs).
  // Pass --all-cwds to index the entire store deliberately.
  const includeAllCwds = argv.includes('--all-cwds')
  const all = []
  const perSession = []
  let skippedOtherCwd = elsewhere
  let injected = 0
  for (const { sessionId, parsed } of logs) {
    if (!includeAllCwds && !sameDirectory(parsed.header.cwd, wantedCwd)) { skippedOtherCwd++; continue }
    injected += parsed.skippedInjected ?? 0
    if (parsed.records.length === 0) continue
    all.push(...parsed.records)
    perSession.push({
      sessionId: parsed.header.id ?? sessionId,
      cwd: parsed.header.cwd,
      startedAt: parsed.header.createdAt,
      messages: parsed.records.length,
    })
  }
  all.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0) || (a.seq ?? 0) - (b.seq ?? 0))
  // This runs unconfined and writes into the agent's home, which the agent can prepare: never through
  // a link it left there. An explicit --out elsewhere is the operator's choice and is held to its own
  // directory instead.
  // An --out inside the home is held to it, so a link the agent planted there is not followed: named
  // through the home's link it is renamed onto the resolved home, and one that only resolves into the
  // home by some other name is refused.
  outFile = resolve(outFile)
  if (GIVEN_HOME !== AGENT_HOME && (outFile + sep).startsWith(GIVEN_HOME + sep)) outFile = AGENT_HOME + outFile.slice(GIVEN_HOME.length)
  const inHome = (outFile + sep).startsWith(AGENT_HOME + sep)
  if (!inHome) {
    // Every ancestor, not only the parent — the parent's real path follows the very link to guard
    // against — and by device and inode: other letters, or the /System/Volumes/Data firmlink, are the
    // home all the same, and no realpath spells them back.
    const identity = (dir) => { try { const s = statSync(dir); return `${s.dev}:${s.ino}` } catch { return null } }
    const home = identity(AGENT_HOME)
    for (let dir = dirname(outFile); ; dir = dirname(dir)) {
      if (home !== null && identity(dir) === home) throw new Error(`--out ${outFile} is in the agent home under another name; name it as ${AGENT_HOME}/…`)
      if (dir === dirname(dir)) break
    }
  }
  const root = inHome ? AGENT_HOME : dirname(outFile)
  mkdirSync(root, { recursive: true })
  writeInside(root, outFile, all.map((r) => JSON.stringify(r)).join('\n') + (all.length ? '\n' : ''))
  writeInside(
    root,
    outFile.replace(/\.jsonl$/, '.sessions.json'),
    JSON.stringify({
      generatedAt: Date.now(),
      scope: includeAllCwds ? 'all working directories' : wantedCwd,
      skippedOtherCwd,
      skippedInjected: injected,
      sessions: perSession.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0)),
    }, null, 1),
  )
  removeOldIndex()
  if (!quiet) {
    console.log(`indexed ${all.length} messages from ${perSession.length} session(s) -> ${outFile}`)
    if (skippedOtherCwd > 0) {
      console.log(`  ${skippedOtherCwd} session(s) skipped (different working directory; use --all-cwds to include)`)
    }
    if (injected > 0) {
      console.log(`  ${injected} injected protocol message(s) skipped (use --include-injected to keep)`)
    }
  }
  return { messages: all.length, sessions: perSession.length }
}

/**
 * The index used to be written into the agent's home, where the agent could read all of it. Remove
 * what is left there — the file or a link in its place, never through a directory that resolves
 * outside the home, since this runs unconfined.
 */
function removeOldIndex() {
  for (const name of ['recall-index.jsonl', 'recall-index.sessions.json']) {
    const old = join(AGENT_HOME, 'memory', name)
    try {
      lstatSync(old)
      const dir = realpathSync(dirname(old))
      const home = realpathSync(AGENT_HOME)
      if (dir === home || dir.startsWith(home + sep)) rmSync(old, { force: true })
    } catch { /* not there */ }
  }
}

function loadIndex(indexFile) {
  if (!existsSync(indexFile)) {
    console.error(`no index at ${indexFile} — run: node dist/recall/deepbot-recall.js index`)
    process.exit(2)
  }
  return readFileSync(indexFile, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => { try { return JSON.parse(l) } catch { return null } })
    .filter(Boolean)
}

function fmtTime(ms) {
  if (!ms) return '?'
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function snippet(text, query, width = 160) {
  const flat = text.replace(/\s+/g, ' ')
  if (!query) return flat.slice(0, width)
  const at = flat.toLowerCase().indexOf(query.toLowerCase())
  if (at < 0) return flat.slice(0, width)
  const from = Math.max(0, at - 60)
  return (from > 0 ? '…' : '') + flat.slice(from, from + width)
}

// Outside the agent's home: there the agent could read every channel's history with its own tools.
const INDEX_DEFAULT = recallIndexPath(AGENT_HOME, DSH_HOME)

switch (command) {
  case 'index': {
    const quiet = argv.includes('--quiet')
    // A plain run indexes every workspace, so a tenant's conversations are recalled inside it and
    // nowhere else. An explicit --out/--cwd (or --all-cwds) means exactly that one index.
    const everyWorkspace = flag('out') === undefined && flag('cwd') === undefined && !argv.includes('--all-cwds')
    const tenants = everyWorkspace ? tenantWorkspaces(AGENT_HOME) : []
    const cwds = argv.includes('--all-cwds') ? null : new Set([flag('cwd', AGENT_HOME), ...tenants])
    const logs = parseLogs(quiet, cwds)
    buildIndex(flag('out', INDEX_DEFAULT), quiet, flag('cwd', AGENT_HOME), logs)
    if (everyWorkspace) {
      for (const workspace of tenants) {
        // One tenant that cannot be written does not stop the others.
        // Outside the workspace, like the home's: the agent must not read the history with its tools.
        try { buildIndex(recallIndexPath(workspace, DSH_HOME), quiet, workspace, logs) }
        catch (e) { console.error(`  skip ${workspace}: ${String((e as Error)?.message ?? e)}`) }
      }
    }
    break
  }

  case 'search': {
    const query = argv[1]
    if (!query) { console.error('usage: node dist/recall/deepbot-recall.js search <query>'); process.exit(2) }
    const limit = Number(flag('limit', 20))
    // Rank by how many query words a passage contains, not by substring order: a passage that
    // shares the words is more likely to be what was meant, and the index order is just time.
    // Lexical, not semantic — it does not find synonyms, and the README says so.
    const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1)
    const hits = loadIndex(flag('index', INDEX_DEFAULT))
      .map((r) => {
        const text = r.text.toLowerCase()
        const score = words.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0)
        return { r, score }
      })
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score || b.r.ts - a.r.ts)
      .map((h) => h.r)
    console.log(`${hits.length} match(es) for ${JSON.stringify(query)}`)
    for (const r of hits.slice(0, limit)) {
      console.log(`  [${fmtTime(r.ts)}] ${r.role} (${r.sessionId})`)
      console.log(`    ${snippet(r.text, query)}`)
    }
    break
  }

  case 'recent': {
    const limit = Number(flag('limit', 20))
    const all = loadIndex(flag('index', INDEX_DEFAULT))
    for (const r of all.slice(-limit)) {
      console.log(`[${fmtTime(r.ts)}] ${r.role} (${r.sessionId}) ${snippet(r.text, null, 120)}`)
    }
    break
  }

  case 'show': {
    const sessionId = argv[1]
    if (!sessionId) { console.error('usage: node dist/recall/deepbot-recall.js show <sessionId>'); process.exit(2) }
    const limit = Number(flag('limit', 50))
    const rows = loadIndex(flag('index', INDEX_DEFAULT)).filter((r) => r.sessionId === sessionId).slice(-limit)
    console.log(`${rows.length} message(s) in ${sessionId}`)
    for (const r of rows) console.log(`  [${fmtTime(r.ts)}] ${r.role}: ${r.text.replace(/\s+/g, ' ').slice(0, 300)}`)
    break
  }

  case 'sessions': {
    const meta = flag('index', INDEX_DEFAULT).replace(/\.jsonl$/, '.sessions.json')
    if (!existsSync(meta)) { console.error(`no session metadata at ${meta} — run index first`); process.exit(2) }
    const d = JSON.parse(readFileSync(meta, 'utf8'))
    console.log(`${d.sessions.length} session(s), generated ${fmtTime(d.generatedAt)}`)
    for (const s of d.sessions) console.log(`  ${fmtTime(s.startedAt)}  ${String(s.messages).padStart(4)} msgs  ${s.sessionId}`)
    break
  }

  default:
    console.error(`unknown command: ${command}\ncommands: index | search | recent | show | sessions`)
    process.exit(2)
}

// A module rather than a global script, so its declarations stay local to this file.
export {}
