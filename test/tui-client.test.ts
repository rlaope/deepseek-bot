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
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DSH_HOME = mkdtempSync(join(tmpdir(), 'deepbot-dshhome-'))
process.env.DSH_HOME = DSH_HOME

// Where the running gateway for a state directory listens: <stateDir>/tui.sock, or on Windows the
// pipe the discovery file names, since its name is new at every start.
const listenPath = (stateDir) => process.platform === 'win32'
  ? JSON.parse(readFileSync(join(DSH_HOME, 'run', 'deepbot-tui', 'default.json'), 'utf8')).socket
  : join(stateDir, 'tui.sock')

const { App } = await import('../dist/tui/app.js')
const { Connection, discover, lookup } = await import('../dist/tui/client.js')
const { bind, createCommands, harnessCli, parseArgs, resumeHint, route, usage } = await import('../dist/tui/cli.js')
const USAGE = usage()
const { createLocalTransport } = await import('../dist/transports/local.js')
const { t: words } = await import('../dist/tui/strings.js')
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
  // `dsh update` is ours alone or with its help; with anything else it is a profile named update and its app's arguments.
  check('route: dsh update, alone or with --help, is the update', route(['update']) === 'update' && route(['update', '--help']) === 'update' && route(['update', '-h']) === 'update')
  check('route: update with anything else, or --profile update, is the harness CLI\'s', route(['update', 'run the tests']) === 'harness' && route(['update', '--help', 'x']) === 'harness' && route(['--profile', 'update']) === 'harness')
  check('usage: names dsh update', /\n  dsh update +\S/.test(USAGE))
  check('usage: the command is dsh', USAGE.includes('\n  dsh [--name <gateway>]') && !USAGE.includes('deepbot-tui'), USAGE.split('\n')[2])
  check('exit: the resume hint names dsh', resumeHint('c-1') === 'to continue this conversation: dsh --resume c-1\n', JSON.stringify(resumeHint('c-1')))

  // /exit is /quit by another name: both leave with status 0.
  const stops = []
  const fakeApp = { stop: (code) => stops.push(code), notice: () => {}, clear: () => {} }
  const quit = createCommands(fakeApp, { conversation: null, tenant: undefined, switchTo: () => {}, send: () => true })
  check('/exit: leaves like /quit', quit.intercept('/exit') === true && quit.intercept('/quit') === true && JSON.stringify(stops) === '[0,0]', JSON.stringify(stops))

  // /model: a picker above the input box, then switches by it, by number or by provider/model, with an
  // effort; default goes back. The list used to be printed into the transcript, at the top of a short one.
  const sent = []
  const notices = []
  const statusSeen = []
  const pickers = []
  const closed = []
  const switched = []
  const stepped = []
  const cleared = []
  const modelApp = { stop: () => {}, notice: (text, kind) => notices.push([kind, text]), clear: (...a) => cleared.push(a), setStatus: (s) => statusSeen.push(s), status: {}, openPicker: (spec) => pickers.push(spec), closePicker: (spec) => closed.push(spec), effortStepped: (e) => stepped.push(e) }
  const link = { conversation: 'c-1', tenant: undefined, switchTo: (c, tenant) => switched.push([c, tenant]), send: (f) => { sent.push(f); return true } }
  const cmds = createCommands(modelApp, link)
  cmds.intercept('/model 1')
  check('/model <n> before a list: says to list first, sends nothing', sent.length === 0 && notices.some(([k, s]) => k === 'error' && s === 'list the models first: /model'), JSON.stringify(notices))
  cmds.intercept('/model')
  check('/model: asks the gateway for the models', JSON.stringify(sent) === JSON.stringify([{ type: 'models' }]), JSON.stringify(sent))
  const items = [{ provider: 'deepseek-official', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', efforts: ['low', 'high'] }, { provider: 'og', id: 'deepseek/deepseek-v4.1-flash-ultrafast', name: 'Ultrafast' }]
  const current = { provider: 'og', model: 'deepseek/deepseek-v4.1-flash-ultrafast', effort: 'medium', efforts: ['off', 'low', 'medium', 'high'] }
  const noticesBefore = notices.length
  bind(modelApp, { type: 'models', current, items }, cmds)
  const picker = pickers.at(-1)
  const rows = picker?.rows ?? []
  check('/model: the list opens a picker, not a notice in the transcript', picker !== undefined && notices.length === noticesBefore, JSON.stringify(notices.slice(noticesBefore)))
  check('/model: a row per model, provider/model with its name, the current one marked with its effort and efforts',
    rows[0]?.label === 'deepseek-official/deepseek-v4-flash' && rows[0].detail === 'DeepSeek V4 Flash' && rows[0].current !== true && JSON.stringify(rows[0].efforts) === '["low","high"]'
      && rows[1]?.label === 'og/deepseek/deepseek-v4.1-flash-ultrafast' && rows[1].current === true && rows[1].effort === 'medium' && rows[1].efforts.join() === 'off,low,medium,high', JSON.stringify(rows))
  check('/model: and a last row that goes back to the configured model', rows.length === 3 && rows[2].current !== true, JSON.stringify(rows[2]))
  check('/model: the list also brings the status up to date', statusSeen.at(-1)?.model === current.model && statusSeen.at(-1)?.effort === 'medium')
  picker.onPick(0, 'high')
  picker.onPick(1, null)
  picker.onPick(2, null)
  check('/model: picking a row sends it, with the effort chosen in the picker; the last row goes back', JSON.stringify(sent.slice(1)) === JSON.stringify([
    { type: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash', effort: 'high' },
    { type: 'model', provider: 'og', model: 'deepseek/deepseek-v4.1-flash-ultrafast', effort: null },
    { type: 'model', provider: null },
  ]), JSON.stringify(sent.slice(1)))
  const typed = sent.length
  cmds.intercept('/model 1')
  cmds.intercept('/model og/deepseek/deepseek-v4.1-flash-ultrafast high')
  cmds.intercept('/model default')
  check('/model: typed, by number, by provider/model with a slash in the model, with an effort, and default', JSON.stringify(sent.slice(typed)) === JSON.stringify([
    { type: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash', effort: null },
    { type: 'model', provider: 'og', model: 'deepseek/deepseek-v4.1-flash-ultrafast', effort: 'high' },
    { type: 'model', provider: null },
  ]), JSON.stringify(sent.slice(typed)))
  const before = sent.length
  cmds.intercept('/model nonsense')
  check('/model: something that is neither is refused, not sent', sent.length === before && notices.at(-1)?.[0] === 'error')
  bind(modelApp, { type: 'model', current: { ...current, effort: 'high' } }, cmds)
  check('/model: the gateway\'s answer is said, and the status shows the effort', notices.at(-1)?.[0] === 'ok' && notices.at(-1)?.[1].includes('effort high') && statusSeen.at(-1)?.effort === 'high', JSON.stringify(notices.at(-1)))
  const quiet = notices.length
  bind(modelApp, { type: 'model', current: { ...current, effort: 'low' }, cause: 'effort' }, cmds)
  check('effort: a step shows in the status line only, not as a line in the transcript', notices.length === quiet && statusSeen.at(-1)?.effort === 'low', JSON.stringify(notices.slice(quiet)))
  check('effort: and the app is told it was a step (said while a turn runs), a /model answer not', JSON.stringify(stepped) === '["low"]', JSON.stringify(stepped))
  // What a stop or a withdraw took back reaches the app with what was asked and whether it was a stop's.
  const told = []
  bind({ withdrawn: (...a) => told.push(a) }, { type: 'withdrawn', ids: ['b-1'], asked: [], stop: true })
  bind({ withdrawn: (...a) => told.push(a) }, { type: 'withdrawn', ids: ['a-2'], asked: ['a-2'] })
  check('withdrawn: the app is told the ids, what was asked, and a stop\'s from a withdraw\'s', JSON.stringify(told) === JSON.stringify([[['b-1'], [], true], [['a-2'], ['a-2'], false]]), JSON.stringify(told))
  // /clear is the same conversation (what the gateway gave back stays); /new is another.
  cleared.length = 0
  cmds.intercept('/clear')
  cmds.intercept('/new')
  cmds.intercept('/resume tui-another')
  cmds.intercept('/tenant acme')
  check('/clear: clears the screen of this conversation; /new, /resume and /tenant of another', JSON.stringify(cleared) === JSON.stringify([[true], [], [], []]), JSON.stringify(cleared))
  cmds.stepEffort()
  check('effort: shift+tab asks the gateway for the next effort', JSON.stringify(sent.at(-1)) === JSON.stringify({ type: 'effort', step: 1 }), JSON.stringify(sent.at(-1)))
  // A model picker open when the model or effort changes under it (another terminal, a click on the
  // status line) would send what it showed, and undo the change: it closes instead.
  bind(modelApp, { type: 'models', current, items }, cmds)
  const stale = pickers.at(-1)
  bind(modelApp, { type: 'model', current: { ...current, effort: 'high' }, cause: 'effort' }, cmds)
  check('/model: a change under an open model picker closes it', closed.includes(stale), String(closed.length))

  // /sessions: a picker too; picking one resumes it in its own tenant.
  cmds.intercept('/sessions')
  check('/sessions: asks the gateway for the list', JSON.stringify(sent.at(-1)) === JSON.stringify({ type: 'sessions' }))
  const now = Date.now()
  bind(modelApp, { type: 'sessions', items: [
    { conversation: 'c-1', sessionId: 's1', lastAt: now - 5000, turns: 3, tenant: null, title: 'first' },
    { conversation: 'c-2', sessionId: 's2', lastAt: now - 120000, turns: 1, tenant: 'acme', title: '' },
  ] }, cmds)
  const sessions = pickers.at(-1)
  check('/sessions: a row per conversation, titled, with when, turns and tenant, this one marked', sessions !== picker && sessions.rows.length === 2 && sessions.rows[0].label === 'first' && sessions.rows[0].current === true
    && sessions.rows[1].label === '(untitled)' && /2m ago · 1 turn · tenant acme · c-2/.test(sessions.rows[1].detail), JSON.stringify(sessions?.rows))
  sessions.onPick(1, null)
  check('/sessions: picking one resumes it in its tenant', JSON.stringify(switched.at(-1)) === JSON.stringify(['c-2', 'acme']), JSON.stringify(switched))
  const listedNone = notices.length
  bind(modelApp, { type: 'sessions', items: [] }, cmds)
  check('/sessions: none says so rather than opening an empty picker', notices.length === listedNone + 1 && pickers.at(-1) === sessions)

  // A gateway older than this terminal does not know a frame it sends: say that, in the terminal's words.
  bind(modelApp, { type: 'error', code: 'bad-frame', message: 'unknown frame type effort' }, cmds)
  check('protocol: an old gateway\'s "unknown frame type" is explained', /older/.test(notices.at(-1)?.[1] ?? '') && /effort/.test(notices.at(-1)?.[1] ?? ''), JSON.stringify(notices.at(-1)))
  bind(modelApp, { type: 'error', code: 'unknown-frame', message: 'unknown frame type models' }, cmds)
  check('protocol: and so is a new one\'s, by its code', /older/.test(notices.at(-1)?.[1] ?? '') && /models/.test(notices.at(-1)?.[1] ?? ''), JSON.stringify(notices.at(-1)))

  // End to end: the arguments reach the harness CLI unchanged, and its exit status comes back.
  const bin = mkdtempSync(join(tmpdir(), 'deepbot-dshbin-'))
  const seen = join(bin, 'seen')
  // Windows cannot exec a #!/bin/sh script; there the harness is npm's bin.js, run under node.
  const fake = join(bin, process.platform === 'win32' ? 'dsh.js' : 'dsh')
  writeFileSync(fake, process.platform === 'win32'
    ? `require('node:fs').writeFileSync(${JSON.stringify(seen)}, process.argv.slice(2).map((a) => a + '\\n').join(''))\nprocess.exit(3)\n`
    : `#!/bin/sh\nprintf '%s\\n' "$@" > '${seen}'\nexit 3\n`)
  chmodSync(fake, 0o755)
  const main = fileURLToPath(new URL('../dist/tui/main.js', import.meta.url))
  // An argument a shell would split or act on: it must arrive as one, untouched.
  const forwarded = spawnSync(process.execPath, [main, '--profile', 'agent', '--port', '19500', 'x & "y"'], { encoding: 'utf8', env: { ...process.env, DSH_BIN: fake } })
  let got = ''
  try { got = readFileSync(seen, 'utf8') } catch { /* not run */ }
  check('forward: the harness CLI gets the arguments as they were given', got === '--profile\nagent\n--port\n19500\nx & "y"\n', JSON.stringify(got))
  check('forward: and its exit status is dsh\'s', forwarded.status === 3, `status ${forwarded.status} ${forwarded.stderr.trim()}`)
  const missing = spawnSync(process.execPath, [main, 'gateway'], { encoding: 'utf8', env: { ...process.env, DSH_BIN: join(bin, 'nothing-here') } })
  check('forward: a harness CLI that is not there is said, with how to point at it', missing.status === 127 && missing.stderr.includes('DSH_BIN'), `status ${missing.status} ${missing.stderr.trim()}`)
  check('forward: elsewhere the default is the app\'s CLI', harnessCli({ PATH: bin }, 'darwin') === '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh')
  // With no DSH_BIN, Windows runs npm's harness found beside a dsh.cmd on PATH, wherever npm's global
  // directory is — and not this project's own dsh.cmd, earlier on PATH, which has no harness beside it.
  if (process.platform === 'win32') {
    const npmDir = join(bin, 'npm-global'), own = join(bin, 'own')
    const entry = join(npmDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    mkdirSync(dirname(entry), { recursive: true })
    mkdirSync(own)
    writeFileSync(entry, readFileSync(fake))
    writeFileSync(join(npmDir, 'dsh.cmd'), '@rem npm shim\r\n')
    writeFileSync(join(own, 'dsh.cmd'), '@rem this project\'s shim\r\n')
    rmSync(seen, { force: true })
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(path|dsh_bin)$/i.test(k)))
    env.PATH = `${own};${npmDir};${process.env.PATH ?? ''}`
    const found = spawnSync(process.execPath, [main, '--version'], { encoding: 'utf8', env })
    let ran = ''
    try { ran = readFileSync(seen, 'utf8') } catch { /* not run */ }
    check('forward: with no DSH_BIN, Windows runs the harness beside a dsh.cmd on PATH', ran === '--version\n' && found.status === 3, `${JSON.stringify(ran)} status ${found.status} ${found.stderr.trim()}`)
    // The same layout reached by a relative PATH entry is only where dsh was started from: not taken.
    const cwd = process.cwd()
    process.chdir(bin)
    try {
      const relative = harnessCli({ PATH: 'npm-global', APPDATA: 'C:\\appdata' }, 'win32')
      check('forward: a relative PATH entry is not searched', relative === 'C:\\appdata\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js', relative)
    } finally { process.chdir(cwd) }
  }
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
    // As tui/main.ts does: looked up through discovery on every attempt.
    socketPath: lookup('default', listenPath(stateDir)),
    onFrame: (f) => bind(app, f),
    onState: (state, detail) => {
      if (state === 'connecting') app.setStatus({ connected: false, link: '연결 중…' })
      else if (state === 'disconnected') app.setStatus({ connected: false, link: `연결 끊김 · ${detail ?? '재연결 중'}` })
    },
  })
  app.start()
  connection.start()
  check('connect: the screen shows the gateway as connected', await until(() => app.status.connected && !term.screen.text().includes('○')))
  const conversation = connection.conversation
  check('connect: the gateway assigned a conversation, shown in the welcome box', typeof conversation === 'string' && term.screen.text().includes(conversation.slice(0, 8)))
  bind(app, { type: 'panel', agents: [], jobs: [], usage: { tokens: 8100, contextPct: 23.4, input: 8000, output: 100, cached: 2000 } })
  bind(app, { type: 'ready', version: 1, conversation, workspace: '/home/agent', tenant: null, model: 'deepseek-v4.1' })
  bind(app, { type: 'ready', version: 1, language: 'zh', conversation, workspace: '/home/agent', tenant: null, model: 'deepseek-v4.1' })
  check('language: a gateway that names another language (an older one) leaves the terminal in English', words().hints.idle(false) === '? for shortcuts' && await until(() => term.screen.text().includes('? for shortcuts')) && !term.screen.text().includes('发送'))
  await until(() => term.screen.text().includes('↑8.0k'))
  check('usage: the conversation\'s tokens, sent and received, the cache\'s share and its context fill the status line', /ctx ▰▰▱▱▱▱▱▱ 23% · ↑8\.0k ↓100 · cache 25%/.test(term.screen.text()), term.screen.text().split('\n').find((l) => l.includes('ctx')))
  check('model: the gateway\'s model and workspace are named in the welcome box', term.screen.text().includes('deepseek-v4.1') && term.screen.text().includes('/home/agent'))

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

// 3b. A terminal that found its gateway through discovery looks it up again on every reconnect (on
// Windows the pipe is named anew at every start). With none registered, Windows dials nothing, since
// an old pipe name may be someone else's by then; elsewhere the last path is dialed again, as before.
// Both rules run here whatever the platform: lookup takes the platform as an argument.
for (const platform of ['win32', 'darwin']) {
  const first = mkdtempSync(join(tmpdir(), 'deepbot-move-a-'))
  const second = mkdtempSync(join(tmpdir(), 'deepbot-move-b-'))
  const gateway = async (stateDir) => {
    const local = createLocalTransport({ cfg: {}, stateDir, log: () => {}, sessionCwd: async () => '/home/agent' })
    await local.connect({ onMessage: () => {}, onStatus: () => {} })
    return local
  }
  let local = await gateway(first)
  const dialed = []
  const connection = new Connection({
    socketPath: lookup('default', listenPath(first), platform),
    dial: (path) => { dialed.push(path); return connect(path) },
    onFrame: () => {},
    onState: () => {},
  })
  connection.start()
  check(`lookup (${platform}): connects to the gateway discovery names`, await until(() => connection.connected) && dialed[0] === listenPath(first))
  await local.close()
  await until(() => !connection.connected)
  await sleep(600)
  if (platform === 'win32') check('lookup (win32): with no live gateway registered, no old name is dialed', dialed.length === 1, JSON.stringify(dialed))
  else check(`lookup (${platform}): with no live gateway registered, the last path is dialed again`, dialed.length > 1 && dialed.every((p) => p === dialed[0]), JSON.stringify(dialed))
  local = await gateway(second)
  check(`lookup (${platform}): a gateway back somewhere else is found and reconnected to`, await until(() => connection.connected, 6000) && dialed.at(-1) === listenPath(second) && dialed.at(-1) !== dialed[0], JSON.stringify(dialed))
  connection.close()
  await local.close()
  rmSync(first, { recursive: true, force: true })
  rmSync(second, { recursive: true, force: true })
}
{
  // A discovery directory that cannot be read is no gateway, not a crash inside the retry timer.
  const home = mkdtempSync(join(tmpdir(), 'deepbot-unreadable-'))
  mkdirSync(join(home, 'run'))
  writeFileSync(join(home, 'run', 'deepbot-tui'), 'a file where the directory should be')
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = home
  let win = 'threw', other = 'threw'
  try { win = lookup('default', '/last.sock', 'win32')(); other = lookup('default', '/last.sock', 'darwin')() } catch { /* the defect */ }
  process.env.DSH_HOME = saved
  check('lookup: an unreadable discovery directory is no live gateway', win === null && other === '/last.sock', `${win} ${other}`)
  rmSync(home, { recursive: true, force: true })

  // A path given as it is (--socket) is dialed as given.
  const dir = mkdtempSync(join(tmpdir(), 'deepbot-fixed-'))
  const path = join(dir, 'nothing.sock')
  const states = [], dials = []
  const fixed = new Connection({ socketPath: path, dial: (p) => { dials.push(p); return connect(p) }, onFrame: () => {}, onState: (s) => states.push(s), setTimer: () => 0, clearTimer: () => {} })
  fixed.start()
  check('lookup: a path given as it is is dialed as given, and its failure retried', await until(() => states.includes('disconnected')) && dials[0] === path, JSON.stringify(dials))
  fixed.close()
  rmSync(dir, { recursive: true, force: true })
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
  connection = new Connection({ socketPath: listenPath(stateDir), onFrame: (f) => bind(app, f, commands), onState: () => {}, onRollback: (m) => commands.rolledBack(m) })
  commands = createCommands(app, connection)
  app.start()
  connection.start()
  await until(() => app.status.connected)
  const first = connection.conversation

  term.type('/sessions\r')
  check('/sessions: the list is shown, numbered, with titles', await until(() => /1\. 오늘 날씨 어때/.test(term.screen.text()) && /2\. 배포 일정 정리해줘/.test(term.screen.text())))
  check('/sessions: the command itself is not echoed as a message', !term.screen.text().includes('› /sessions'))
  const listRow = term.screen.find('2. 배포 일정 정리해줘')?.row ?? -1
  const hintRow = term.screen.text().split('\n').findIndex((l) => l.includes('↑↓ pick'))
  check('/sessions: the list is at the bottom in the input box\'s place, right above the hint line', listRow >= 0 && !term.screen.text().includes('│ ›') && hintRow > listRow && hintRow - listRow <= 4, `list row ${listRow}, hint row ${hintRow}`)
  term.type('\x1b[B\r')
  check('/sessions: ↓ then ↵ resumes the second one', await until(() => connection.conversation === 'conv-a' && app.status.session === 'conv-a'))
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
