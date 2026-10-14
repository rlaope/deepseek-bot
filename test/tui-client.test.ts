/**
 * The terminal's end: finding the gateway, the round trip over a real socket, and surviving a
 * gateway restart.
 *
 * The screen is a fake terminal replayed through the VT emulator; the gateway side is the real
 * local transport with a stand-in for the core that answers every message. So the path a user's
 * Enter takes — App → Connection → socket → transport → "core" → transport → socket → App — is
 * the code that ships, end to end.
 *
 * Run: node test/tui-client.test.ts
 */
import './dist-fresh.ts'   // fails loudly on a stale dist

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DSH_HOME = mkdtempSync(join(tmpdir(), 'deepbot-dshhome-'))
process.env.DSH_HOME = DSH_HOME

const { App } = await import('../dist/tui/app.js')
const { Connection, discover } = await import('../dist/tui/client.js')
const { bind, createCommands, parseArgs, resumeHint, route, usage } = await import('../dist/tui/cli.js')
const USAGE = usage()
const { createLocalTransport } = await import('../dist/transports/local.js')
const { setLanguage, t: words } = await import('../dist/tui/strings.js')
const { fakeTerminal } = await import('./tui-fakes.ts')

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(predicate, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (predicate()) return true; await sleep(15) }
  return false
}

// 1. Arguments.
{
  const a = parseArgs(['--name', 'work', '--tenant', 'acme', '--resume', 'c-1'])
  check('args: name, tenant and resume', a.name === 'work' && a.tenant === 'acme' && a.resume === 'c-1' && a.help === false)
  check('args: a flag without its value is an error', 'error' in parseArgs(['--name']) && 'error' in parseArgs(['--name', '--tenant', 'x']))
  check('usage: names the project, deepseek-bot', USAGE.split('\n')[0].includes('talk to deepseek-bot'), USAGE.split('\n')[0])
  check('args: an unknown flag is an error, not ignored', 'error' in parseArgs(['--verbose']))
  check('args: --help', parseArgs(['--help']).help === true)

  // `dsh` opens the terminal; anything that is not one of its own flags is the harness CLI's.
  check('route: no arguments, or only the terminal\'s flags, open the terminal', route([]) === 'tui' && route(['--resume', 'c-1']) === 'tui' && route(['--name', 'work']) === 'tui' && route(['-h']) === 'tui' && route(['--help']) === 'tui')
  check('route: anything else goes to the harness CLI', route(['--profile', 'agent']) === 'harness' && route(['gateway']) === 'harness' && route(['--version']) === 'harness')
  check('usage: the command is dsh', USAGE.includes('\n  dsh [--name <gateway>]') && !USAGE.includes('deepbot-tui'), USAGE.split('\n')[2])
  check('exit: the resume hint names dsh', resumeHint('c-1') === 'to continue this conversation: dsh --resume c-1\n', JSON.stringify(resumeHint('c-1')))

  // /exit is /quit by another name: both leave with status 0.
  const stops = []
  const fakeApp = { stop: (code) => stops.push(code), notice: () => {}, clear: () => {} }
  const quit = createCommands(fakeApp, { conversation: null, tenant: undefined, switchTo: () => {}, send: () => true })
  check('/exit: leaves like /quit', quit.intercept('/exit') === true && quit.intercept('/quit') === true && JSON.stringify(stops) === '[0,0]', JSON.stringify(stops))

  // End to end: the arguments reach the harness CLI unchanged, and its exit status comes back.
  const bin = mkdtempSync(join(tmpdir(), 'deepbot-dshbin-'))
  const fake = join(bin, 'dsh'), seen = join(bin, 'seen')
  writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > '${seen}'\nexit 3\n`)
  chmodSync(fake, 0o755)
  const main = new URL('../dist/tui/main.js', import.meta.url).pathname
  const forwarded = spawnSync(process.execPath, [main, '--profile', 'agent', '--port', '19500'], { encoding: 'utf8', env: { ...process.env, DSH_BIN: fake } })
  let got = ''
  try { got = readFileSync(seen, 'utf8') } catch { /* not run */ }
  check('forward: the harness CLI gets the arguments as they were given', got === '--profile\nagent\n--port\n19500\n', JSON.stringify(got))
  check('forward: and its exit status is dsh\'s', forwarded.status === 3, `status ${forwarded.status} ${forwarded.stderr.trim()}`)
  const missing = spawnSync(process.execPath, [main, 'gateway'], { encoding: 'utf8', env: { ...process.env, DSH_BIN: join(bin, 'nothing-here') } })
  check('forward: a harness CLI that is not there is said, with how to point at it', missing.status === 127 && missing.stderr.includes('DSH_BIN'), `status ${missing.status} ${missing.stderr.trim()}`)
  rmSync(bin, { recursive: true, force: true })
}

// 2. Discovery.
{
  const home = mkdtempSync(join(tmpdir(), 'deepbot-disc-'))
  const env = { DSH_HOME: home }
  check('discover: nothing running says so, and how to fix it', 'error' in discover(undefined, env) && /platform/.test(discover(undefined, env).error))
  const run = join(home, 'run', 'deepbot-tui')
  mkdirSync(run, { recursive: true })
  const sock = join(home, 'a.sock'); writeFileSync(sock, '')
  writeFileSync(join(run, 'work.json'), JSON.stringify({ socket: sock, pid: process.pid, name: 'work' }))
  check('discover: the only live gateway is used when no name is given', discover(undefined, env).socket === sock)
  check('discover: by name', discover('work', env).socket === sock)
  check('discover: an unknown name is an error listing what exists', /work/.test(discover('nope', env).error ?? ''))
  writeFileSync(join(run, 'dead.json'), JSON.stringify({ socket: sock, pid: 2 ** 22 + 12345, name: 'dead' }))
  check('discover: a gateway whose process is gone is ignored', discover(undefined, env).socket === sock)
  const sock2 = join(home, 'b.sock'); writeFileSync(sock2, '')
  writeFileSync(join(run, 'other.json'), JSON.stringify({ socket: sock2, pid: process.pid, name: 'other' }))
  check('discover: two live gateways and no default asks for a name', /--name/.test(discover(undefined, env).error ?? ''))
  writeFileSync(join(run, 'default.json'), JSON.stringify({ socket: sock2, pid: process.pid, name: 'default' }))
  check('discover: "default" wins when present', discover(undefined, env).socket === sock2)
  rmSync(home, { recursive: true, force: true })
}

// 3. The round trip, and a gateway restart.
{
  const stateDir = mkdtempSync(join(tmpdir(), 'deepbot-client-'))
  const host = { cfg: { cancelWords: ['그만'] }, stateDir, log: () => {}, sessionCwd: async () => '/home/agent' }
  const received = []
  /** A gateway: the real local transport, with a stand-in core that answers after "thinking". */
  async function gateway() {
    const local = createLocalTransport(host)
    await local.connect({
      onMessage: async (m) => {
        received.push(m)
        if (m.text === '그만') return
        const stop = local.startTyping(m.target)
        // Streamed in pieces, then the reply marked as the answer, as the core does.
        for (const piece of ['답: ', ...m.text]) { local.stream(m.target, { kind: 'text', text: piece }); await sleep(5) }
        await local.post(m.target, `답: ${m.text}`, { answer: true })
        stop()
      },
      onStatus: () => {},
    })
    return local
  }
  let local = await gateway()

  const term = fakeTerminal(80, 24)
  let connection = null
  const app = new App({
    io: term.io, env: { COLORTERM: 'truecolor' }, platform: 'darwin',
    backend: {
      send(text) { if (!connection.send({ type: 'message', text })) app.notice('gateway에 연결되어 있지 않아 보내지 못함', 'error') },
      cancel() { connection.send({ type: 'cancel' }) },
      action(id) { connection.send({ type: 'action', id }) },
    },
    copy: () => 'pbcopy',
    onExit: () => {},
  })
  connection = new Connection({
    socketPath: join(stateDir, 'tui.sock'),
    onFrame: (f) => bind(app, f),
    onState: (state, detail) => {
      if (state === 'connecting') app.setStatus({ connected: false, link: '연결 중…' })
      else if (state === 'disconnected') app.setStatus({ connected: false, link: `연결 끊김 · ${detail ?? '재연결 중'}` })
    },
  })
  app.start()
  connection.start()
  check('connect: the screen shows the gateway as connected', await until(() => app.status.connected && term.screen.text().includes('▸▸ ask')))
  const conversation = connection.conversation
  check('connect: the gateway assigned a conversation, shown in the header', typeof conversation === 'string' && term.screen.text().includes(conversation.slice(0, 12)))
  bind(app, { type: 'panel', agents: [], jobs: [], usage: { tokens: 8100, contextPct: 23.4 } })
  bind(app, { type: 'ready', version: 1, conversation, workspace: '/home/agent', tenant: null, model: 'deepseek-v4.1' })
  bind(app, { type: 'ready', version: 1, language: 'zh', conversation, workspace: '/home/agent', tenant: null, model: 'deepseek-v4.1' })
  check('language: the gateway\'s language is the terminal\'s once ready', words().hints.idle(false).startsWith('↵ 发送') && await until(() => term.screen.text().includes('↵ 发送')))
  bind(app, { type: 'ready', version: 1, language: 'en', conversation, workspace: '/home/agent', tenant: null, model: 'deepseek-v4.1' })
  check('language: and back, when it says so', await until(() => term.screen.text().includes('↵ send')))
  setLanguage('en')
  await until(() => term.screen.text().includes('8.1k tok'))
  check('usage: the conversation\'s tokens and context fill the status line', /ctx ▰▰▱▱▱▱▱▱ 23% · 8\.1k tok/.test(term.screen.text()), term.screen.text().split('\n').find((l) => l.includes('▸▸')))
  check('model: the gateway\'s model is named in the info line', term.screen.text().includes('deepseek-v4.1 · /home/agent'))

  term.type('배포 일정\r')
  check('round trip: the message reached the gateway as this conversation', await until(() => received.length === 1) && received[0].target.threadTs === conversation && received[0].text === '배포 일정')
  check('round trip: typing shows the turn running', await until(() => app.status.running))
  check('round trip: the answer appears on the screen', await until(() => term.screen.text().includes('답: 배포 일정')))
  check('round trip: and the turn ends', await until(() => !app.status.running))
  check('round trip: streamed then answered, the text is on screen once', term.screen.text().split('답: 배포 일정').length - 1 === 1)

  // The gateway goes away and comes back (a deploy, launchd restarting it).
  await local.close()
  check('restart: the screen says the connection dropped', await until(() => !app.status.connected && term.screen.text().includes('연결 끊김')))
  term.type('끊긴 사이\r')
  check('restart: a message sent while disconnected is refused out loud, not queued', await until(() => term.screen.text().includes('보내지 못함')) && received.length === 1)
  local = await gateway()
  check('restart: the terminal reconnects on its own', await until(() => app.status.connected, 6000))
  check('restart: and asks for the same conversation', connection.conversation === conversation)
  term.type('다시 연결됨\r')
  check('restart: the conversation continues', await until(() => term.screen.text().includes('답: 다시 연결됨')) && received[received.length - 1].target.threadTs === conversation)

  term.type('\x1b')
  await sleep(80)
  check('escape: with nothing running, sends no cancel', !received.some((m) => m.text === '그만'))
  app.turnStarted()
  term.type('\x1b')
  check('escape: while running, the cancel reaches the gateway as the cancel word', await until(() => received.some((m) => m.text === '그만')))

  connection.close()
  app.stop(0)
  await local.close()
  rmSync(stateDir, { recursive: true, force: true })
}

// 4. Commands: handled by the terminal, never echoed or sent as a message.
{
  const stateDir = mkdtempSync(join(tmpdir(), 'deepbot-cmd-'))
  const received = []
  const historyCalls = []
  const listings = [
    { conversation: 'conv-b', sessionId: 'tui-b', lastAt: Date.now() - 60_000, turns: 2, tenant: null, title: '오늘 날씨 어때' },
    { conversation: 'conv-a', sessionId: 'tui-a', lastAt: Date.now() - 3600_000, turns: 5, tenant: null, title: '배포 일정 정리해줘' },
    { conversation: 'conv-c', sessionId: 'tui-c', lastAt: Date.now() - 7200_000, turns: 1, tenant: 'acme', title: '다른 팀 대화' },
  ]
  const host = {
    cfg: { cancelWords: ['그만'], usageWords: ['사용량'] }, stateDir, log: () => {}, sessionCwd: async () => '/home/agent',
    listConversations: async () => listings,
    conversationHistory: async (_channel, conversation) => { historyCalls.push(conversation); return conversation === 'conv-a' ? [{ role: 'user', text: '배포 일정 정리해줘' }, { role: 'assistant', text: 'staging 먼저.' }] : [] },
  }
  const local = createLocalTransport(host)
  await local.connect({ onMessage: (m) => received.push(m), onStatus: () => {} })
  const term = fakeTerminal(90, 34)
  let connection = null
  let commands = null
  const app = new App({
    io: term.io, env: { COLORTERM: 'truecolor' }, platform: 'darwin', copy: () => 'pbcopy', onExit: () => {},
    intercept: (text) => commands.intercept(text),
    backend: { send: (text) => connection.send({ type: 'message', text }), cancel: () => {}, action: () => {} },
  })
  connection = new Connection({ socketPath: join(stateDir, 'tui.sock'), onFrame: (f) => bind(app, f, commands), onState: () => {}, onRollback: (m) => commands.rolledBack(m) })
  commands = createCommands(app, connection)
  app.start()
  connection.start()
  await until(() => app.status.connected)
  const first = connection.conversation

  term.type('/sessions\r')
  check('/sessions: the list is shown, numbered, with titles', await until(() => /1\. 오늘 날씨 어때/.test(term.screen.text()) && /2\. 배포 일정 정리해줘/.test(term.screen.text())))
  check('/sessions: the command itself is not echoed as a message', !term.screen.text().includes('› /sessions'))
  term.type('/resume 2\r')
  check('/resume <n>: switches to that conversation', await until(() => connection.conversation === 'conv-a' && app.status.session === 'conv-a'))
  check('/resume: the earlier messages are shown', await until(() => term.screen.text().includes('earlier in this conversation') && term.screen.text().includes('staging 먼저.')))
  check('/resume: asked for once, after the gateway confirmed the conversation', JSON.stringify(historyCalls) === JSON.stringify(['conv-a']), JSON.stringify(historyCalls))
  term.type('이어서 질문\r')
  check('/resume: what is typed next belongs to that conversation', await until(() => received.some((m) => m.text === '이어서 질문' && m.target.threadTs === 'conv-a')))
  term.type('/new\r')
  check('/new: a fresh conversation, not the first one or the resumed one', await until(() => typeof connection.conversation === 'string' && connection.conversation !== 'conv-a' && connection.conversation !== first))
  check('/new: the screen starts over', !term.screen.text().includes('staging 먼저.'))
  const beforeTenant = connection.conversation
  term.type('/tenant acme\r')
  check('/tenant: refused here, because tenant isolation is off — and said so', await until(() => term.screen.text().includes('tenant isolation')))
  check('/tenant: refused, the terminal keeps the conversation the gateway still has', await until(() => term.screen.text().includes('could not switch')) && connection.conversation === beforeTenant && connection.tenant === undefined)
  term.type('거부 뒤 메시지\r')
  check('/tenant: and the next message goes to that same conversation', await until(() => received.some((m) => m.text === '거부 뒤 메시지' && m.target.threadTs === beforeTenant)))
  // A refused /resume (that conversation is in a tenant, and this gateway has none): the conversation
  // it stays in is shown once — not first as if it were the resumed one, then again on the refusal.
  term.type('/sessions\r')
  await until(() => /3\. 다른 팀 대화/.test(term.screen.text()))
  const callsBefore = historyCalls.length
  term.type('/resume 3\r')
  await until(() => historyCalls.length > callsBefore)
  await sleep(150)
  const refusedCalls = historyCalls.slice(callsBefore)
  check('/resume refused: the conversation it stays in is asked for once', JSON.stringify(refusedCalls) === JSON.stringify([beforeTenant]) && connection.conversation === beforeTenant, JSON.stringify(refusedCalls))
  const before = received.length
  term.type('/usage\r')
  check('/usage: sent as the usage word the core answers', await until(() => received.length === before + 1 && received[received.length - 1].text === '사용량'))
  term.type('/Users/me/notes.txt 열어줘\r')
  check('a path is not a command: it is sent as text', await until(() => received.some((m) => m.text === '/Users/me/notes.txt 열어줘')))
  term.type('/help\r')
  check('/help: lists the commands', await until(() => term.screen.text().includes('/resume <n|id>')))

  connection.close()
  app.stop(0)
  await local.close()
  rmSync(stateDir, { recursive: true, force: true })
}

rmSync(DSH_HOME, { recursive: true, force: true })
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
