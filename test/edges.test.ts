/**
 * Input edges, driven through the core with the fake transport.
 *
 * The unit suites cover the paths that are meant to work; this covers the ones nobody meant.
 * Each check says what *should* happen, and a failure here is a finding rather than a
 * broken test — that is the point of the sweep. Nothing here touches a live workspace.
 *
 * Run: node test/edges.test.ts
 */
import './dist-fresh.ts'
import './scratch-dsh-home.ts'   // the recall index must not land in the real ~/.dsh
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../dist/index.js'
import { createFakeTransport, type FakeTransportOptions } from './fake-transport.ts'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function boot({ state = {}, config = {} }: { state?: Record<string, unknown>; config?: { fake?: FakeTransportOptions; [key: string]: unknown } } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'deepbot-edges-'))
  writeFileSync(join(stateDir, 'sessions.json'), JSON.stringify({ sessions: {}, seen: {}, standing: {}, history: {}, ...state }))
  const transport = createFakeTransport(config.fake ?? {})
  const logs = []
  const listeners = {}
  const stubs = {
    agents: { create: async () => { throw new Error('fake: no agents') }, resume: async () => { throw new Error('fake: no agents') } },
    sessions: { flush: async () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake' }) },
  }
  const ctx = { get: (n) => stubs[n], effect: (fn) => fn(), on: (n, h) => { (listeners[n] ??= []).push(h); return () => {} }, logger: { info: (l) => logs.push(String(l)) } }
  apply(ctx, { targetChannels: ['C_ALLOWED'], stateDir, transportFactory: () => transport, progressAfterMs: 50, ...config })
  return {
    transport, logs,
    /** Run the pre-execute gate the way the harness would. */
    gate: (exec) => {
      const handlers = listeners['tools/pre-execute'] ?? []
      if (handlers.length === 0) return 'no gate'
      let delegated = false
      const decision = handlers[0](exec, () => { delegated = true; return { kind: 'allow' } })
      return delegated ? 'delegated' : decision
    },
    read: () => JSON.parse(readFileSync(join(stateDir, 'sessions.json'), 'utf8')),
    done: () => rmSync(stateDir, { recursive: true, force: true }),
  }
}

// 1. Nothing to say means no turn.
{
  const t = boot()
  await sleep(60)
  t.transport.deliver(t.transport.message({ text: '' }))
  await sleep(200)
  check('an empty message starts no turn', t.transport.historyCalls.length === 0, `${t.transport.historyCalls.length}`)
  t.done()
}

// 2. Whitespace and zero-width characters are also nothing to say. A turn is an expensive
// way to answer " " — and a model asked about a blank message answers about nothing.
{
  const t = boot()
  await sleep(60)
  t.transport.deliver(t.transport.message({ text: '   ' }))
  await sleep(150)
  t.transport.deliver(t.transport.message({ text: '\u200b\u200b\u200b' }))
  await sleep(250)
  check('a whitespace-only message starts no turn', t.transport.historyCalls.length === 0, `${t.transport.historyCalls.length} turn(s)`)
  t.done()
}

// 3. A very large message is truncated, not refused and not passed whole.
{
  const t = boot({ config: { maxPromptChars: 4000 } })
  await sleep(60)
  t.transport.deliver(t.transport.message({ text: 'x'.repeat(100_000) }))
  await sleep(400)
  check('a 100 KB message still starts a turn', t.transport.historyCalls.length === 1, `${t.transport.historyCalls.length}`)
  check('and it is accepted rather than refused', t.logs.some((l) => /accepted channel=/.test(l)), 'the truncation itself is not observable from here — it happens where the prompt is built')
  t.done()
}

// 4. The same event twice is one message; two events with the same text are two.
{
  const t = boot()
  await sleep(60)
  const message = t.transport.message({ text: 'ping' })
  t.transport.deliver(message)
  await sleep(250)
  t.transport.deliver(message)                      // the same eventId
  await sleep(250)
  check('a duplicate event is ignored', t.transport.historyCalls.length === 1, `${t.transport.historyCalls.length} turn(s)`)
  t.transport.deliver(t.transport.message({ text: 'ping' }))   // a fresh event, same words
  await sleep(250)
  check('the same words in a new event are a new turn', t.transport.historyCalls.length === 2, `${t.transport.historyCalls.length}`)
  t.done()
}

// 5. Being addressed is what starts a turn, and unaddressed chatter must not.
{
  const t = boot()
  await sleep(60)
  t.transport.deliver(t.transport.message({ text: 'hello', addressed: false }))
  await sleep(250)
  check('an unaddressed message starts no turn', t.transport.historyCalls.length === 0, `${t.transport.historyCalls.length}`)
  t.done()
}

// 6. A message that is only an emoji is content, not whitespace.
{
  const t = boot()
  await sleep(60)
  t.transport.deliver(t.transport.message({ text: '👍🙂' }))
  await sleep(250)
  check('an emoji-only message is still a turn', t.transport.historyCalls.length === 1, `${t.transport.historyCalls.length}`)
  t.done()
}

// 7. Decision words survive ordinary punctuation, which is how people type them.
// Takes the route production takes: an approval has to exist for a decision to consume it,
// and the requester has to be the one answering.
{
  const stateDir = mkdtempSync(join(tmpdir(), 'deepbot-edges-'))
  writeFileSync(join(stateDir, 'sessions.json'), JSON.stringify({ sessions: { 'C_ALLOWED:t1': 'slack-abc' }, seen: {}, standing: {}, history: {} }))
  const transport = createFakeTransport()
  const logs = []
  const listeners = {}
  const stubs = {
    agents: { create: async () => { throw new Error('fake: no agents') }, resume: async () => { throw new Error('fake: no agents') } },
    sessions: { flush: async () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake' }) },
  }
  const ctx = { get: (n) => stubs[n], effect: (fn) => fn(), on: (n, h) => { (listeners[n] ??= []).push(h); return () => {} }, logger: { info: (l) => logs.push(String(l)) } }
  apply(ctx, { targetChannels: ['C_ALLOWED'], stateDir, transportFactory: () => transport, progressAfterMs: 50 })
  await sleep(80)

  transport.deliver(transport.message({ text: 'ping', user: 'U_OWNER' }))    // records the requester
  await sleep(250)
  const outcome = listeners['approval/request'][0]({ agent: { session: { header: { id: 'slack-abc' } } }, reason: 'edge case' })
  await sleep(150)
  const turnsBefore = transport.historyCalls.length
  transport.deliver(transport.message({ text: '허용!', user: 'U_OWNER' }))
  const settled = await Promise.race([outcome, sleep(300).then(() => 'pending')])
  check('허용! with punctuation is a decision, not a turn', settled === 'allowed-once', `outcome: ${settled}`)
  check('and it did not start a turn', transport.historyCalls.length === turnsBefore, `${transport.historyCalls.length - turnsBefore} new turn(s)`)
  rmSync(stateDir, { recursive: true, force: true })
}

// 8. A malformed message object does not throw out of the handler.
{
  const t = boot()
  await sleep(60)
  let threw = ''
  try {
    t.transport.deliver({ eventId: 'malformed-1', target: { channel: 'C_ALLOWED', threadTs: 't1' } } as any)
  } catch (e) { threw = String(e?.message ?? e) }
  await sleep(250)
  check('a message with no text does not throw', threw === '', threw)
  check('and nothing is attempted', t.transport.historyCalls.length === 0, `${t.transport.historyCalls.length}`)
  t.done()
}

// 9. A scenario file that is not JSON is reported, not crashed into.
{
  const dir = mkdtempSync(join(tmpdir(), 'deepbot-scenario-'))
  const broken = join(dir, 'broken.json')
  // Pinned, so this check never writes the user's home: a broken file made the runner create
  // ~/dsh-agent-test-<time> and exit before removing it, one more on every test run.
  const pinned = join(dir, 'home')
  // DSH_BIN is any file that exists, so the runner gets past its own checks to the file's (CI has no dsh, and
  // the check passed there on "dsh not found" alone). A file that parses to null is no scenario either.
  const runOn = (body) => {
    writeFileSync(broken, body)
    const run = spawnSync(process.execPath, ['test/run-scenario.ts', broken, '--timeout', '30'], { encoding: 'utf8', cwd: process.cwd(), env: { ...process.env, DEEPBOT_TEST_HOME: pinned, DSH_BIN: process.execPath } })
    return { status: run.status, said: `${run.stdout}${run.stderr}`, leftHome: existsSync(pinned) }
  }
  const notJson = runOn('{ this is not json')
  const nothing = runOn('null')
  rmSync(dir, { recursive: true, force: true })
  check('a broken scenario file exits non-zero', notJson.status !== 0 && nothing.status !== 0, `status ${notJson.status}, ${nothing.status}`)
  check('and makes no agent home before it has read the file', !notJson.leftHome && !nothing.leftHome)
  check('and says it could not read the scenario', /could not read the scenario: /.test(notJson.said) && /could not read the scenario: /.test(nothing.said), notJson.said.trim().split('\n').slice(-1)[0]?.slice(0, 100))
}

// 9b. A restart pair (`--dump`, then `--seed`) runs both phases in one home. The second made a fresh home, and the
// harness resumes a session only in the directory that made it: `pnpm test:restart` failed every time, with an empty
// answer, while restarts worked. DSH_BIN is any program, so neither phase reaches a gateway; what is checked is the home.
{
  const dir = mkdtempSync(join(tmpdir(), 'deepbot-restart-'))
  const scenario = join(dir, 'restart.json')
  writeFileSync(scenario, JSON.stringify({ steps: [] }))
  const dump = join(dir, 'sessions.json')
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, USERPROFILE: dir, DSH_HOME: join(dir, '.dsh'), DSH_BIN: process.execPath }
  delete env.DEEPBOT_TEST_HOME
  // What the plugin dumped stays beside the home: a session is here before the first phase, as the plugin's would be.
  writeFileSync(dump, JSON.stringify({ sessions: { thread: 'session-1' } }))
  const run = (flag: string) => spawnSync(process.execPath, ['test/run-scenario.ts', scenario, flag, dump, '--timeout', '5'], { encoding: 'utf8', cwd: process.cwd(), env })
  const first = run('--dump')
  let home = ''
  let keptSessions = false
  try { const d = JSON.parse(readFileSync(dump, 'utf8')); home = String(d.home ?? ''); keptSessions = d.sessions?.thread === 'session-1' } catch { /* checked below */ }
  const kept = home !== '' && existsSync(home)
  const second = run('--seed')
  const said = /^home +: (.*)$/m.exec(second.stdout)?.[1] ?? ''
  check('restart pair: the first phase records its home in the dump, and keeps it', kept, `${home} ${first.stdout.split('\n').find((l) => l.startsWith('home')) ?? ''}`)
  check('restart pair: the sessions in the dump are kept beside the home', keptSessions)
  check('restart pair: the second phase runs in that home', home !== '' && said.startsWith(home), said)
  check('restart pair: and removes it when done', home !== '' && !existsSync(home))
  rmSync(dir, { recursive: true, force: true })
}

// 10. A link inside the workspace that points outside it is not inside it.
// The read scope resolves the real path when the path exists, which is the whole defence
// against this: a name that looks local and reads a system file.
{
  const root = mkdtempSync(join(tmpdir(), 'deepbot-links-'))
  writeFileSync(join(root, 'notes.md'), 'local notes\n')
  let linked = ''
  // A system file that exists, so the link is not dangling: Windows keeps hosts under SystemRoot.
  const etc = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'drivers', 'etc') : '/etc'
  try {
    symlinkSync(join(etc, 'hosts'), join(root, 'escape'))
    symlinkSync(etc, join(root, 'etc-link'), 'dir')
  } catch (e) { linked = String(e?.message ?? e) }

  const t = boot({ config: { targetChannels: ['*'], readScopeRoots: [root] } })
  await sleep(80)
  const gate = (name, args) => t.gate ? t.gate({ name, arguments: args, agent: { session: { header: { id: 's' } } } }) : 'no gate'
  check('a local file is readable', gate('read', { file_path: join(root, 'notes.md') }) === 'delegated',
    JSON.stringify(gate('read', { file_path: join(root, 'notes.md') })))
  if (linked === '') {
    const absolute = gate('read', { file_path: join(root, 'escape') })
    check('a link to a system file is refused', absolute?.kind === 'deny', JSON.stringify(absolute))
    const relative = gate('read', { file_path: 'escape' })
    check('and a relative path through it is refused too', relative?.kind === 'deny', JSON.stringify(relative))
    const throughDir = gate('read', { file_path: join(root, 'etc-link', 'hosts') })
    check('a link to a directory does not let its contents through', throughDir?.kind === 'deny', JSON.stringify(throughDir))
    const listing = gate('glob', { pattern: '*.md', path: join(root, 'etc-link') })
    check('and neither does a glob rooted there', listing?.kind === 'deny', JSON.stringify(listing))
    // An absolute pattern is the way out of the workspace; on Windows it starts with a drive, not "/".
    const absolutePattern = gate('glob', { pattern: join(etc, '*') })
    check('an absolute glob pattern outside is refused', absolutePattern?.kind === 'deny', JSON.stringify(absolutePattern))
    // grep's pattern is a regular expression, not a path: \bword\b is rooted only to Windows' isAbsolute.
    const regex = gate('grep', { pattern: '\\bnotes\\b', path: root })
    check('a grep pattern is not taken for a path', regex === 'delegated', JSON.stringify(regex))
    // On every platform: a regex starting with "/" (an API route, a path in a log) was refused as a read outside.
    const slashed = gate('grep', { pattern: '/etc/hosts', path: root })
    check('a grep pattern that starts with "/" searches the workspace, and is not refused', slashed === 'delegated', JSON.stringify(slashed))
  } else {
    check('symlinks could be created for this check', false, linked)
  }
  rmSync(root, { recursive: true, force: true })
  t.done()
}

// 11. allowedUsers: only the people listed start a turn or press a button; the terminal always may.
// On Telegram a private chat always reaches the bot, so without this anyone who found it could run it.
{
  const t = boot({ config: { allowedUsers: ['U_OK'], targetChannels: ['C_ALLOWED', 'tui'] } })
  await sleep(60)
  t.transport.deliver(t.transport.message({ user: 'U_STRANGER', text: 'run something' }))
  await sleep(200)
  check('allowedUsers: someone not listed starts no turn', t.transport.historyCalls.length === 0, `${t.transport.historyCalls.length} turn(s)`)
  check('allowedUsers: and is told nothing', t.transport.posted.length === 0, JSON.stringify(t.transport.posted))
  check('allowedUsers: the refusal is logged', t.logs.some((l) => /U_STRANGER is not in allowedUsers/.test(l)))
  t.transport.deliver(t.transport.message({ user: 'U_OK' }))
  await sleep(200)
  check('allowedUsers: someone listed does start a turn', t.transport.historyCalls.length === 1, `${t.transport.historyCalls.length} turn(s)`)
  t.transport.deliver(t.transport.message({ user: 'local', target: { channel: 'tui', threadTs: 't2' } }))
  await sleep(200)
  check('allowedUsers: the terminal\'s user always may, in the terminal', t.transport.historyCalls.length === 2, `${t.transport.historyCalls.length} turn(s)`)
  // The name alone is not the terminal: 'local' in another channel is just an id that is not listed.
  t.transport.deliver(t.transport.message({ user: 'local', target: { channel: 'C_ALLOWED', threadTs: 't3' } }))
  await sleep(200)
  check('allowedUsers: the terminal\'s user name in another channel is not the terminal', t.transport.historyCalls.length === 2, `${t.transport.historyCalls.length} turn(s)`)
  // A button for no pending request: the listed person is told it was handled; a stranger is not answered at all.
  const before = t.transport.posted.length
  t.transport.press('approval:allow:C_ALLOWED:t9#deadbeef', 'U_STRANGER')
  await sleep(100)
  check('allowedUsers: a stranger\'s button press is ignored before anything is posted', t.transport.posted.length === before && t.logs.some((l) => /button ignored: U_STRANGER/.test(l)))
  t.transport.press('approval:allow:C_ALLOWED:t9#deadbeef', 'U_OK')
  await sleep(100)
  check('allowedUsers: the same press by someone listed reaches the approval code (control)', t.transport.posted.length === before + 1, JSON.stringify(t.transport.posted.slice(before)))
  t.done()
}
{
  const t = boot()
  await sleep(60)
  t.transport.deliver(t.transport.message({ user: 'U_STRANGER' }))
  await sleep(200)
  check('allowedUsers: unset, anyone in an allowed channel starts a turn, as before', t.transport.historyCalls.length === 1, `${t.transport.historyCalls.length} turn(s)`)
  t.done()
}
{
  let error = ''
  try { boot({ config: { allowedUsers: 'U_OK' } }) } catch (e) { error = String(e?.message ?? e) }
  check('allowedUsers: not a list is a config error', /allowedUsers: a list of user ids/.test(error), error)
  // A Telegram or Discord id written unquoted is a YAML number: the error says to quote it.
  let bare = ''
  try { boot({ config: { allowedUsers: [123456789] } }) } catch (e) { bare = String(e?.message ?? e) }
  check('allowedUsers: an unquoted numeric id is a config error that says to quote it', /quote each id/.test(bare), bare)
}

// 12. A platform that fails to start says so in the health file. It was only in the log, so with another
// platform connected `dsh gateway setup` read that one's "connected" as success.
// The platforms share lastError, so a start that works clears only the error a failed one wrote, and a
// platform's clear names the error it clears.
async function failingOnce(otherError: string | null) {
  const dir = mkdtempSync(join(tmpdir(), 'deepbot-health-'))
  const healthFile = join(dir, 'health.json')
  const base = createFakeTransport()
  let tries = 0
  let host = null
  let connected = false
  const flaky = { ...base, connect: async (h) => { if (tries++ === 0) throw new Error('getMe: 401 Unauthorized'); await base.connect(h); connected = true } }
  const t = boot({ config: { transportFactory: (given) => { host = given; return flaky }, healthFile } })
  const read = () => { try { return JSON.parse(readFileSync(healthFile, 'utf8')) } catch { return null } }
  // Waited for, with a deadline, not a fixed time: the first retry is 1 s out, and a loaded machine is slower.
  const until = async (done: () => boolean) => { for (const deadline = Date.now() + 8000; !done() && Date.now() < deadline;) await sleep(25) }
  await until(() => String(read()?.lastError ?? '').includes('401'))
  const failed = read()
  if (otherError !== null) host.onHealth({ lastError: otherError })      // another platform's, after it
  await until(() => connected)
  await sleep(50)                                                        // the clear follows the connect in start()
  return { failed, recovered: read(), host, read, done: () => { t.done(); rmSync(dir, { recursive: true, force: true }) } }
}
{
  const r = await failingOnce(null)
  check('a platform that fails to start puts its error in the health file', String(r.failed?.lastError ?? '').includes('401 Unauthorized') && r.failed?.connected === false, JSON.stringify(r.failed))
  check('and the start that works after it clears it', r.recovered?.lastError === null, JSON.stringify(r.recovered))
  r.host.onHealth({ lastError: 'slack socket closed' })
  r.host.onHealth({ lastError: null, ifLastError: 'network down' })
  check('a clear that names another error leaves this one', r.read()?.lastError === 'slack socket closed', JSON.stringify(r.read()))
  r.host.onHealth({ lastError: null, ifLastError: 'slack socket closed' })
  check('a clear that names this error clears it', r.read()?.lastError === null && !('ifLastError' in (r.read() ?? {})), JSON.stringify(r.read()))
  r.done()
}
{
  const r = await failingOnce('slack socket closed')
  check('a start that works leaves an error another platform wrote since', r.recovered?.lastError === 'slack socket closed', JSON.stringify(r.recovered))
  r.done()
}

// 13. A gateway that serves only the terminal is connected once its socket is up. No messenger is there to
// say so, and the health probe read "not connected" as down and restarted it every five minutes.
for (const [platform, expected] of [['local', true], ['slack', false]] as const) {
  const dir = mkdtempSync(join(tmpdir(), 'deepbot-health-'))
  const healthFile = join(dir, 'health.json')
  const t = boot({ config: { platform, healthFile } })
  let h = null
  for (const deadline = Date.now() + 5000; h?.connected !== true && Date.now() < deadline;) {
    await sleep(25)
    try { h = JSON.parse(readFileSync(healthFile, 'utf8')) } catch { /* not yet */ }
  }
  check(platform === 'local'
    ? 'health: a terminal-only gateway is connected once it has started'
    : 'health: with a messenger, connected waits for that platform to say so (control)', (h?.connected === true) === expected, JSON.stringify(h))
  t.done()
  rmSync(dir, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
