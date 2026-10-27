/**
 * `dsh gateway`: messenger setup and the service commands, run against a scratch home.
 *
 * Nothing here calls launchctl, plutil, a platform or a terminal: the command takes all of them as its
 * IO, and this suite gives it fakes that record what they were asked. The profile fixture is the
 * template the installer copies (profile/cordis.patch.yml), and a second one written the way a profile
 * edited by hand looks, so the YAML edits are checked on both.
 *
 * Run: node test/gateway.test.ts
 */
import './dist-fresh.ts'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { EventEmitter } from 'node:events'
import { gateway, mcpRows, mergeIds, parseIds, readProfile, slackManifest, storeRefs, terminalSession, keyReader, writeProfile, envSet, envValue, type GatewayIO, type RunResult } from '../dist/service/gateway.js'
import { harnessProfile, route, usage } from '../dist/tui/cli.js'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const TEMPLATE = readFileSync(new URL('../profile/cordis.patch.yml', import.meta.url), 'utf8')
/** A deepbot row the way a profile edited by hand has it: block lists, comments around them. */
const HAND = `# a profile edited by hand
- id: session-query-sqlite
  config:
    openAt: startup

# ── the deepbot row
- id: deepbot
  config:
    # Slack and the terminal
    platform: ['slack', 'local']
    targetChannels:
      - 'C0AAAAAAA'
      - tui
    replyMode: mention
    approvalPatterns: ['rm ', 'sudo ']

# ── after
- id: permission
  config:
    defaultPreset: unattended
`

const OK = { status: 0, stdout: '', stderr: '' }

/** A scratch home with a profile, a credential file, and fakes for everything outside. */
function scene({ profile = TEMPLATE, env = 'DEEPSEEK_API_KEY=sk-test\n', envMode = 0o600, installed = true, loaded = ['ai.deepbot.gateway', 'ai.deepbot.health'], vars = {}, answers = undefined, picks = undefined, fetchReply = undefined, connects = true, lastError = null, noPid = [], boots = true, failBootout = [], store = null }: {
  profile?: string; env?: string | null; envMode?: number; installed?: boolean; loaded?: string[]; vars?: Record<string, string>
  answers?: Array<string | null>
  /** A terminal's menu choices, in order: with these the setup is the guided one. */ picks?: Array<number | 'back' | 'quit'>
  fetchReply?: (url: string, init: any) => { ok: boolean; status: number; body: unknown }; connects?: boolean; lastError?: string | null
  /** Loaded, with no process: launchd between restarts. */ noPid?: string[]
  /** Whether a (re)started gateway gets as far as writing its health file. */ boots?: boolean
  failBootout?: string[]
  /** The DeepSeek Harness app's own credential store, ~/.dsh/.credentials.yaml. */ store?: string | null
} = {}) {
  const home = mkdtempSync(join(tmpdir(), 'deepbot-gateway-'))
  const dsh = join(home, '.dsh')
  mkdirSync(join(dsh, 'profiles', 'agent'), { recursive: true })
  mkdirSync(join(dsh, 'slack-state'), { recursive: true })
  const profilePath = join(dsh, 'profiles', 'agent', 'cordis.patch.yml')
  writeFileSync(profilePath, profile)
  const envPath = join(dsh, '.env')
  if (env !== null) { writeFileSync(envPath, env); chmodSync(envPath, envMode) }
  const storePath = join(dsh, '.credentials.yaml')
  if (store !== null) writeFileSync(storePath, store)
  const agents = join(home, 'Library', 'LaunchAgents')
  mkdirSync(agents, { recursive: true })
  if (installed) {
    writeFileSync(join(agents, 'ai.deepbot.gateway.plist'), '<plist/>')
    writeFileSync(join(agents, 'ai.deepbot.health.plist'), '<plist/>')
  }
  const healthPath = join(dsh, 'slack-state', 'health.json')
  let clock = 1_000_000
  const running = new Set(loaded)
  const pidless = new Set(noPid)
  const calls: string[][] = []
  const fetched: Array<{ url: string; init: any }> = []
  const asked: string[] = []
  const out: string[] = []
  const err: string[] = []
  /** The gateway coming up: it writes its health file, connected or not. */
  const boot = () => {
    pidless.delete('ai.deepbot.gateway')
    if (boots) writeFileSync(healthPath, JSON.stringify({ pid: 4242, startedAt: clock, connected: connects, connectedAt: connects ? clock : null, lastError, updatedAt: clock }))
  }
  const run = (cmd: string, args: string[]): RunResult => {
    calls.push([cmd.split('/').pop(), ...args])
    if (cmd.endsWith('plutil')) return { status: 1, stdout: '', stderr: 'no such key' }
    const [verb, target] = args
    const label = (target ?? '').split('/').pop()
    if (verb === 'print') return running.has(label) ? { status: 0, stdout: `gui/501/${label} = {\n\tstate = ${pidless.has(label) ? 'waiting' : 'running'}\n${pidless.has(label) ? '' : '\tpid = 4242\n'}\t\tstate = active\n}`, stderr: '' } : { status: 113, stdout: '', stderr: 'Could not find service' }
    if (verb === 'bootstrap') { const name = args[2].split('/').pop().replace(/\.plist$/, ''); running.add(name); if (name === 'ai.deepbot.gateway') boot(); return OK }
    if (verb === 'bootout') { if (failBootout.includes(label)) return { status: 5, stdout: '', stderr: 'Boot-out failed: 5: Input/output error' }; running.delete(label); return OK }
    if (verb === 'kickstart') { boot(); return OK }
    return OK
  }
  const queue = answers === undefined ? undefined : [...answers]
  const choices = picks === undefined ? undefined : [...picks]
  const menus: Array<{ title: string; options: Array<{ label: string; hint?: string }>; initial: number }> = []
  const opened: string[] = []
  const io: GatewayIO = {
    home, uid: 501,
    env: { ...vars },
    run,
    fetch: async (url, init) => {
      fetched.push({ url, init })
      const r = fetchReply?.(url, init) ?? { ok: true, status: 200, body: { ok: true, user: 'deepbot', team: 'acme', result: { username: 'deep_bot' }, id: '42', username: 'deepbot' } }
      return { ok: r.ok, status: r.status, json: async () => r.body }
    },
    ask: queue === undefined ? undefined : async (question) => { asked.push(question); return queue.length > 0 ? queue.shift() : '' },
    // The guided setup's menus: each records what it offered and answers the next pick (out of picks: quit).
    ...(choices === undefined ? {} : {
      choose: async (title: string, options: Array<{ label: string; hint?: string }>, initial: number) => { menus.push({ title, options, initial }); return choices.length > 0 ? choices.shift() : 'quit' },
      openUrl: (url: string) => { opened.push(url); return true },
    }),
    out: (t) => out.push(t), err: (t) => err.push(t),
    sleep: async (ms) => { clock += ms },
    now: () => clock,
    waitMs: 5000,
  }
  return {
    home, io, calls, fetched, asked, out, err, profilePath, envPath, healthPath, storePath, menus, opened,
    launchctl: () => calls.filter((c) => c[0] === 'launchctl' && c[1] !== 'print').map((c) => c.slice(1, 3).join(' ')),
    profile: () => readFileSync(profilePath, 'utf8'),
    env: () => readFileSync(envPath, 'utf8'),
    store: () => readFileSync(storePath, 'utf8'),
    text: () => [...out, ...err].join('\n'),
    done: () => rmSync(home, { recursive: true, force: true }),
  }
}

const SLACK = { SLACK_BOT_TOKEN: 'xoxb-1-2-abc', SLACK_APP_TOKEN: 'xapp-1-def' }

// 1. Routing: only `gateway <command>` is taken from the harness CLI.
check('route: gateway with one of its commands is the gateway CLI', route(['gateway', 'setup', 'slack']) === 'gateway' && route(['gateway', 'status']) === 'gateway' && route(['gateway', 'manifest', 'slack']) === 'gateway')
// `dsh gateway` alone, its help and a mistyped command printed the harness's stack trace ("profile \"gateway\" does not
// exist"): the harness has no such profile until someone makes one, so without it they are ours.
const noProfile = () => false
const gatewayProfile = (name: string) => name === 'gateway'
check('route: gateway alone, its help or a mistyped command is the gateway CLI when no profile is named gateway', route(['gateway'], noProfile) === 'gateway' && route(['gateway', '--help'], noProfile) === 'gateway' && route(['gateway', '-h'], noProfile) === 'gateway' && route(['gateway', 'statu'], noProfile) === 'gateway')
{
  // The profile is looked for where the harness looks: a `~` in DSH_HOME is the home directory, a blank one is unset.
  const dir = mkdtempSync(join(tmpdir(), 'deepbot-profile-'))
  mkdirSync(join(dir, 'h', 'profiles', 'gateway'), { recursive: true })
  writeFileSync(join(dir, 'h', 'profiles', 'gateway', 'package.json'), '{}')
  const homeVar = process.platform === 'win32' ? 'USERPROFILE' : 'HOME'
  const saved = process.env[homeVar]
  process.env[homeVar] = dir
  try {
    check('harnessProfile: DSH_HOME=~/h finds a profile under the home directory, as the harness does', harnessProfile('gateway', { DSH_HOME: '~/h' }) && !harnessProfile('agent', { DSH_HOME: '~/h' }))
    check('harnessProfile: an absolute DSH_HOME, and a blank one meaning ~/.dsh', harnessProfile('gateway', { DSH_HOME: join(dir, 'h') }) && !harnessProfile('gateway', { DSH_HOME: '  ' }))
  } finally {
    if (saved === undefined) delete process.env[homeVar]; else process.env[homeVar] = saved
    rmSync(dir, { recursive: true, force: true })
  }
}
check('route: with a harness profile named gateway, gateway alone or with anything else still boots it', route(['gateway'], gatewayProfile) === 'harness' && route(['gateway', 'web'], gatewayProfile) === 'harness' && route(['gateway', '--help'], gatewayProfile) === 'harness' && route(['gateway', 'status'], gatewayProfile) === 'gateway')
check('usage: the terminal\'s help names dsh gateway', usage().includes('dsh gateway <command>'))

// 2. Pure pieces.
check('ids: spaces or commas, duplicates dropped', JSON.stringify(parseIds(' C1, C2 C1 ', true)) === '["C1","C2"]')
check('ids: * alone where allowed, and not where it is not', JSON.stringify(parseIds('*', true)) === '["*"]' && parseIds('*', false) === null)
check('ids: anything but letters, digits, - and _ is refused', parseIds("C1 'x'", true) === null && parseIds('C#1', true) === null && parseIds('', true) === null)
check('ids: a negative Telegram chat id is an id', JSON.stringify(parseIds('-1001234', true)) === '["-1001234"]')
check('merge: added to a narrowed list, in order', JSON.stringify(mergeIds(['C1'], ['C2', 'C1'])) === '["C1","C2"]')
check('merge: a list that is * stays *; adding * makes it *', JSON.stringify(mergeIds(['*'], ['C2'])) === '["*"]' && JSON.stringify(mergeIds(['C1', 'tui'], ['*'])) === '["*"]')
check('env: a value is read, quotes and export allowed, empty is unset', envValue('export A="x"\nB=\n', 'A') === 'x' && envValue('B=\n', 'B') === undefined && envValue('AB=1\n', 'A') === undefined)
check('env: set replaces the first line, drops the duplicates, keeps the rest', envSet('A=1\nK=old\nB=2\nK=older\n', 'K', 'new') === 'A=1\nK=new\nB=2\n')
check('env: set appends to a file without a final newline', envSet('A=1', 'K', 'v') === 'A=1\nK=v\n' && envSet('', 'K', 'v') === 'K=v\n')

// 3. The profile: read and written in place, on the template and on a hand-edited row.
{
  const lists = readProfile(TEMPLATE)
  check('template: read', !('error' in lists) && lists.platform.join() === 'slack' && lists.targetChannels.join() === '*' && lists.allowedUsers.length === 0, JSON.stringify(lists))
  // Values a profile can hold: one messenger and the terminal (two messengers are a config error).
  const text = writeProfile(TEMPLATE, { platform: ['slack', 'local'] }) as string
  const changed = TEMPLATE.split('\n').map((line, i) => [line, text.split('\n')[i]]).filter(([a, b]) => a !== b)
  check('template: a second platform turns the scalar into a list, and only that line changes', changed.length === 1 && changed[0][1] === "    platform: ['slack', 'local']", JSON.stringify(changed))
  const users = writeProfile(TEMPLATE, { allowedUsers: ['U1'] }) as string
  const at = users.split('\n').indexOf("    allowedUsers: ['U1']")
  check('template: allowedUsers is put right after targetChannels', at > 0 && users.split('\n')[at - 1] === "    targetChannels: ['*']" && users.split('\n').length === TEMPLATE.split('\n').length + 1)
  check('template: and read back', (readProfile(users) as any).allowedUsers?.join() === 'U1')
}
{
  const lists = readProfile(HAND)
  check('hand-edited: a block list is read', !('error' in lists) && lists.targetChannels.join() === 'C0AAAAAAA,tui' && lists.platform.join() === 'slack,local', JSON.stringify(lists))
  const text = writeProfile(HAND, { platform: ['local', 'discord'], targetChannels: ['C0AAAAAAA', 'tui', 'C0BBBBBBB'] }) as string
  check('hand-edited: a flow list stays a flow list', text.includes("    platform: ['local', 'discord']"))
  check('hand-edited: a block list stays a block list, at its indent', text.includes("    targetChannels:\n      - 'C0AAAAAAA'\n      - 'tui'\n      - 'C0BBBBBBB'\n    replyMode: mention"), text)
  const [before, after] = [HAND.split('- id: deepbot')[0], HAND.split('    approvalPatterns')[1]]
  check('hand-edited: every line outside the lists is as it was', text.startsWith(before) && text.endsWith(after) && text.includes('    # Slack and the terminal\n'))
  check('hand-edited: an unchanged list is not rewritten', writeProfile(HAND, { platform: ['slack', 'local'] }) === HAND)
}
{
  const refused = (profile: string) => { const r = readProfile(profile); return 'error' in r ? r.error : '' }
  check('refused: no deepbot row', /no `- id: deepbot` row/.test(refused('- id: other\n  config: {}\n')))
  check('refused: two deepbot rows', /2 `- id: deepbot` rows/.test(refused(`${HAND}\n- id: deepbot\n  config:\n    platform: slack\n`)))
  check('refused: a comment inside a block list', /not an item/.test(refused(HAND.replace("      - tui\n", "      # the terminal\n      - tui\n"))))
  check('refused: a list that goes on after a comment line', /continues after/.test(refused(HAND.replace("      - tui\n", "    # the terminal\n      - tui\n"))))
  check('refused: a value that is not plain', /not a plain value/.test(refused(HAND.replace("['slack', 'local']", '{ a: 1 }'))))
  check('refused: no platform line', /no platform line/.test(refused(HAND.replace("    platform: ['slack', 'local']\n", ''))))
}

// 4. setup without a terminal: every answer from the environment and the flags.
{
  const s = scene({ vars: { SLACK_BOT_TOKEN: SLACK.SLACK_BOT_TOKEN } })
  const before = [s.env(), s.profile()]
  const code = await gateway(['setup', 'slack'], s.io)
  check('setup: a missing token is named, exit 2', code === 2 && s.err.join().includes('missing: SLACK_APP_TOKEN') && s.err.join().includes('SLACK_APP_TOKEN=… dsh gateway setup slack'), s.text())
  check('setup: and nothing is written, nothing asked of the platform', s.env() === before[0] && s.profile() === before[1] && s.fetched.length === 0 && s.launchctl().length === 0)
  s.done()
}
{
  const s = scene({ env: 'DEEPSEEK_API_KEY=sk-test\nSLACK_BOT_TOKEN=xoxb-old\nOTHER=1\nSLACK_BOT_TOKEN=xoxb-older\n', envMode: 0o644, vars: { ...SLACK } })
  const code = await gateway(['setup', 'slack'], s.io)
  check('setup: both tokens from the environment, checked, saved, restarted, connected', code === 0 && s.text().includes('connected (pid 4242)'), s.text())
  check('setup: .env has each key once, the other lines as they were', s.env() === `DEEPSEEK_API_KEY=sk-test\nSLACK_BOT_TOKEN=${SLACK.SLACK_BOT_TOKEN}\nOTHER=1\nSLACK_APP_TOKEN=${SLACK.SLACK_APP_TOKEN}\n`, JSON.stringify(s.env()))
  check('setup: .env is mode 600 though it was 644', (statSync(s.envPath).mode & 0o777) === 0o600, (statSync(s.envPath).mode & 0o777).toString(8))
  check('setup: the tokens were checked with Slack, each at its own method', s.fetched.map((f) => `${f.url} ${f.init.headers?.Authorization}`).join('|') === `https://slack.com/api/auth.test Bearer ${SLACK.SLACK_BOT_TOKEN}|https://slack.com/api/apps.connections.open Bearer ${SLACK.SLACK_APP_TOKEN}`, JSON.stringify(s.fetched.map((f) => f.url)))
  check('setup: who the bot is, said', s.out.includes('SLACK_BOT_TOKEN: works — @deepbot in acme'))
  check('setup: no token in what was printed', !s.text().includes(SLACK.SLACK_BOT_TOKEN) && !s.text().includes(SLACK.SLACK_APP_TOKEN))
  check('setup: the gateway was restarted with kickstart -k', s.launchctl().join() === 'kickstart -k', s.launchctl().join())
  check('setup: the profile already served slack, so it is unchanged', s.profile() === TEMPLATE)
  // Again, with the same tokens: nothing to do.
  s.calls.length = 0; s.out.length = 0
  const again = await gateway(['setup', 'slack', '--no-verify'], s.io)
  check('setup: run again with the same answers changes nothing and restarts nothing', again === 0 && s.out.includes('nothing changed') && s.launchctl().length === 0, s.text())
  s.done()
}
for (const [name, vars, why] of [
  ['a newline in a token', { ...SLACK, SLACK_BOT_TOKEN: 'xoxb-1\nEVIL=1' }, 'xoxb-…'],
  ['a space in a token', { ...SLACK, SLACK_APP_TOKEN: 'xapp-1 2' }, 'xapp-…'],
  ['the app token given as the bot token', { ...SLACK, SLACK_BOT_TOKEN: SLACK.SLACK_APP_TOKEN }, 'xoxb-…'],
] as const) {
  const s = scene({ vars })
  const before = [s.env(), s.profile()]
  const code = await gateway(['setup', 'slack'], s.io)
  check(`setup: ${name} is refused, exit 2, nothing written`, code === 2 && s.err.join().includes(why) && s.env() === before[0] && s.profile() === before[1] && s.fetched.length === 0, s.text())
  s.done()
}
{
  const s = scene({ vars: { ...SLACK }, fetchReply: (url) => (url.includes('auth.test') ? { ok: true, status: 200, body: { ok: false, error: 'invalid_auth' } } : { ok: true, status: 200, body: { ok: true } }) })
  const before = [s.env(), s.profile()]
  const code = await gateway(['setup', 'slack'], s.io)
  check('verify: a token Slack refuses is exit 2, with its reason, nothing written', code === 2 && s.err.join().includes('invalid_auth') && s.env() === before[0] && s.profile() === before[1], s.text())
  s.done()
}
{
  const s = scene({ vars: { ...SLACK }, fetchReply: () => { throw new Error('getaddrinfo ENOTFOUND') } })
  const code = await gateway(['setup', 'slack'], s.io)
  check('verify: an unreachable platform is exit 1 — it says nothing about the token — and names --no-verify', code === 1 && s.err.join().includes('could not reach slack.com') && s.err.join().includes('--no-verify'), s.text())
  s.done()
}
{
  const s = scene({ vars: { ...SLACK } })
  const code = await gateway(['setup', 'slack', '--no-verify'], s.io)
  check('verify: --no-verify asks nothing of the platform', code === 0 && s.fetched.length === 0, s.text())
  s.done()
}
{
  const token = '123456:AAbb_cc-dd'
  const s = scene({ vars: { TELEGRAM_BOT_TOKEN: token }, fetchReply: () => ({ ok: true, status: 200, body: { ok: true, result: { username: 'deep_bot' } } }) })
  const code = await gateway(['setup', 'telegram', '--users', '111 222'], s.io)
  check('telegram: checked with getMe at its token\'s URL', s.fetched.length === 1 && s.fetched[0].url === `https://api.telegram.org/bot${token}/getMe`, s.fetched[0]?.url)
  const lists = readProfile(s.profile()) as any
  check('telegram: replaces slack — one messenger at a time — with its people', code === 0 && lists.platform.join() === 'telegram' && lists.allowedUsers.join() === '111,222', s.text())
  s.done()
}
{
  const token = 'MTA.abc_d.ef-g'
  const s = scene({ vars: { DISCORD_BOT_TOKEN: token }, fetchReply: () => ({ ok: true, status: 200, body: { id: '42', username: 'deepbot' } }) })
  const code = await gateway(['setup', 'discord'], s.io)
  check('discord: checked at users/@me with a Bot header', code === 0 && s.fetched[0].url === 'https://discord.com/api/v10/users/@me' && s.fetched[0].init.headers.Authorization === `Bot ${token}`)
  check('discord: with nobody listed, it warns that anyone can run it', s.out.some((l) => l.includes('anyone who can message the bot on discord can run it')), s.text())
  s.done()
}
{
  const s = scene({ profile: HAND, vars: { ...SLACK } })
  const code = await gateway(['setup', 'slack', '--channels', 'C0BBBBBBB,C0AAAAAAA', '--no-verify'], s.io)
  const lists = readProfile(s.profile()) as any
  check('channels: added to a narrowed list, once each', code === 0 && lists.targetChannels.join() === 'C0AAAAAAA,tui,C0BBBBBBB', lists.targetChannels.join())
  s.done()
}
{
  const s = scene({ vars: { ...SLACK } })
  const code = await gateway(['setup', 'slack', '--channels', 'C0BBBBBBB', '--no-verify'], s.io)
  check('channels: a list that is * is left as it is', code === 0 && (readProfile(s.profile()) as any).targetChannels.join() === '*')
  s.done()
}
// One messenger at a time: the composite transport sends whatever the terminal does not claim to the first
// messenger, so a second one listed would never be answered. A new one replaces the old.
{
  const s = scene({ profile: HAND, env: `SLACK_BOT_TOKEN=${SLACK.SLACK_BOT_TOKEN}\n`, vars: { DISCORD_BOT_TOKEN: 'a.b.c' } })
  const code = await gateway(['setup', 'discord', '--no-verify', '--no-restart'], s.io)
  const lists = readProfile(s.profile()) as any
  check('one at a time: discord replaces slack, and the terminal stays', code === 0 && lists.platform.join() === 'local,discord', lists.platform.join())
  check('one at a time: the old messenger\'s channel ids go; it answers in every channel', lists.targetChannels.join() === '*' && s.out.some((l) => l.includes('the channel list was slack')), s.text())
  check('one at a time: it says so, and slack\'s token stays where it was', s.out.some((l) => l.includes('discord replaces slack')) && s.env().includes(`SLACK_BOT_TOKEN=${SLACK.SLACK_BOT_TOKEN}`))
  s.done()
  const t = scene({ profile: HAND, vars: { DISCORD_BOT_TOKEN: 'a.b.c' } })
  await gateway(['setup', 'discord', '--channels', 'D1', '--users', 'U9', '--no-verify', '--no-restart'], t.io)
  const given = readProfile(t.profile()) as any
  check('one at a time: on a switch, the channels and people given replace the old ones', given.targetChannels.join() === 'D1,tui' && given.allowedUsers.join() === 'U9', JSON.stringify(given))
  t.done()
}
{
  const s = scene({ vars: { DISCORD_BOT_TOKEN: 'a.b.c' } })
  const before = s.profile()
  const code = await gateway(['setup', 'discord', '--channels', 'C#1'], s.io)
  check('channels: an id that is not one is exit 2 before anything else', code === 2 && s.profile() === before && s.fetched.length === 0, s.text())
  s.done()
}
{
  const s = scene({ profile: HAND.replace('    replyMode: mention\n', "    allowedUsers: ['U0AAAAAAA']\n    replyMode: mention\n"), vars: { TELEGRAM_BOT_TOKEN: '1:a' } })
  await gateway(['setup', 'telegram', '--no-verify'], s.io)
  check('people: once the list has ids, a new platform\'s people are warned they are not answered', s.out.some((l) => l.includes('no one on telegram is answered until their id is in allowedUsers')), s.text())
  s.done()
}
{
  // Without the terminal, and without its channel: setup has to add both.
  const s = scene({ profile: HAND.replace("    platform: ['slack', 'local']", '    platform: slack').replace('      - tui\n', '') })
  const code = await gateway(['setup', 'local', '--no-restart'], s.io)
  const lists = readProfile(s.profile()) as any
  check('local: the terminal needs no token, and its channel is added to a narrowed list', code === 0 && lists.platform.join() === 'slack,local' && lists.targetChannels.join() === 'C0AAAAAAA,tui', s.text())
  check('local: --no-restart restarts nothing', s.launchctl().length === 0 && s.out.some((l) => l.includes('--no-restart')))
  s.done()
}
for (const [name, profile] of [['no deepbot row', '- id: other\n  config: {}\n'], ['a comment inside a block list', HAND.replace("      - tui\n", "      # x\n      - tui\n")]] as const) {
  const s = scene({ profile, vars: { DISCORD_BOT_TOKEN: 'a.b.c' } })
  const code = await gateway(['setup', 'discord', '--no-verify'], s.io)
  check(`setup: a profile with ${name} is exit 1, edited by hand, nothing written`, code === 1 && s.err.join().includes('Edit the deepbot row by hand') && s.profile() === profile && !s.env().includes('DISCORD'), s.text())
  s.done()
}
{
  const s = scene({ vars: { ...SLACK, DSH_HOME: '/elsewhere' } })
  const code = await gateway(['setup', 'slack'], s.io)
  check('setup: a DSH_HOME other than ~/.dsh is refused', code === 2 && s.err.join().includes('DSH_HOME'), s.text())
  s.done()
}
{
  const s = scene({ vars: { ...SLACK }, loaded: [] })
  const code = await gateway(['setup', 'slack', '--no-verify'], s.io)
  check('setup: with the gateway not running, nothing is started; it says how', code === 0 && s.launchctl().length === 0 && s.out.some((l) => l.includes('dsh gateway start')), s.text())
  s.done()
}
{
  const s = scene({ vars: { ...SLACK }, connects: false, lastError: 'invalid_auth' })
  const code = await gateway(['setup', 'slack', '--no-verify'], s.io)
  check('setup: a restart that does not connect is exit 1, with the last error', code === 1 && s.err.join().includes('last error: invalid_auth'), s.text())
  s.done()
}

// 5. setup without a terminal asks nothing: a platform has to be named. (At a terminal it is the guided setup, §14.)
{
  const s = scene()
  const code = await gateway(['setup'], s.io)
  check('setup: without a terminal, no platform is exit 2, and says a terminal gives the guided setup', code === 2 && s.err.join().includes('guided setup') && s.calls.length === 0, s.text())
  s.done()
}

// 6. remove.
{
  const s = scene({ profile: HAND, env: 'SLACK_BOT_TOKEN=xoxb-1\n' })
  const code = await gateway(['remove', 'slack'], s.io)
  check('remove: the platform leaves the list, its token stays', code === 0 && (readProfile(s.profile()) as any).platform.join() === 'local' && s.env() === 'SLACK_BOT_TOKEN=xoxb-1\n', s.text())
  check('remove: a profile left with the terminal only waits for the process, not a connection', s.text().includes('running (pid 4242)'), s.text())
  const last = await gateway(['remove', 'local'], s.io)
  check('remove: the only platform is refused', last === 1 && (readProfile(s.profile()) as any).platform.join() === 'local', s.text())
  s.done()
}

// 7. start, stop, restart.
{
  const s = scene()
  const code = await gateway(['stop'], s.io)
  check('stop: the probe first, then the gateway', code === 0 && s.launchctl().join('|') === 'bootout gui/501/ai.deepbot.health|bootout gui/501/ai.deepbot.gateway', s.launchctl().join('|'))
  s.calls.length = 0
  const started = await gateway(['start'], s.io)
  check('start: the gateway, then its probe, and it connects', started === 0 && s.launchctl().join('|').startsWith('bootstrap gui/501|bootstrap gui/501') && s.calls.filter((c) => c[1] === 'bootstrap').map((c) => c[3].split('/').pop()).join() === 'ai.deepbot.gateway.plist,ai.deepbot.health.plist' && s.text().includes('connected'), s.text())
  s.calls.length = 0
  const again = await gateway(['start'], s.io)
  check('start: already running says so and starts nothing', again === 0 && s.launchctl().length === 0 && s.out.some((l) => l.startsWith('already running (pid 4242)')))
  s.calls.length = 0
  const restarted = await gateway(['restart'], s.io)
  check('restart: kickstart -k, and it connects', restarted === 0 && s.launchctl().join() === 'kickstart -k', s.launchctl().join())
  s.done()
}
{
  const s = scene({ installed: false, loaded: [] })
  const code = await gateway(['start'], s.io)
  check('start: not installed is exit 1, and launchctl is not asked to do anything', code === 1 && s.launchctl().length === 0 && s.err.join().includes('install'), s.text())
  s.done()
}
{
  const s = scene({ loaded: [] })
  const code = await gateway(['stop'], s.io)
  check('stop: nothing running says so', code === 0 && s.out.includes('not running') && s.launchctl().length === 0)
  s.done()
}

// 8. status.
{
  const s = scene({ env: `DEEPSEEK_API_KEY=sk-secret\nSLACK_BOT_TOKEN=${SLACK.SLACK_BOT_TOKEN}\nSLACK_APP_TOKEN=${SLACK.SLACK_APP_TOKEN}\n` })
  writeFileSync(s.healthPath, JSON.stringify({ pid: 4242, startedAt: 999_000, connected: true, connectedAt: 999_000, lastError: null, updatedAt: 999_990 }))
  const code = await gateway(['status', '--json'], s.io)
  let parsed = null
  try { parsed = JSON.parse(s.out.join('\n')) } catch { /* checked below */ }
  check('status --json: parses, healthy, exit 0', code === 0 && parsed?.healthy === true && parsed.service.pid === 4242 && parsed.profile.platforms.join() === 'slack', s.text())
  check('status --json: tokens are reported by where they are, never shown', parsed?.credentials.SLACK_BOT_TOKEN === 'dotenv' && !s.text().includes('xoxb-') && !s.text().includes('sk-secret'), JSON.stringify(parsed?.credentials))
  s.out.length = 0
  writeFileSync(s.healthPath, JSON.stringify({ pid: 4242, startedAt: 1, connected: true, updatedAt: 1 }))
  const stale = await gateway(['status'], s.io)
  check('status: a stale heartbeat is exit 1 and says stale', stale === 1 && s.out.some((l) => l.includes('(stale)')), s.text())
  s.done()
}
{
  const s = scene({ env: null })
  const code = await gateway(['status'], s.io)
  check('status: a missing token is exit 1 and named', code === 1 && s.out.some((l) => l.includes('SLACK_BOT_TOKEN missing')), s.text())
  s.done()
}

// 8b. `dsh gateway` with no command, or its help, prints the usage and succeeds; a mistyped command is named.
{
  const s = scene()
  const bare = await gateway([], s.io)
  const bareOut = s.out.join('\n')
  s.out.length = 0
  const help = await gateway(['--help'], s.io)
  const helpOut = s.out.join('\n')
  const typo = await gateway(['statu'], s.io)
  check('usage: dsh gateway alone prints its commands, exit 0', bare === 0 && bareOut.includes('dsh gateway setup'), `${bare} ${s.text().slice(0, 120)}`)
  check('usage: dsh gateway --help prints its commands, exit 0', help === 0 && helpOut.includes('dsh gateway status'), `${help}`)
  check('usage: a mistyped command is named, exit 2', typo === 2 && s.err.some((l) => l.includes('unknown command statu')), `${typo} ${s.err.join(' ').slice(0, 120)}`)
  s.done()
}

// 9. The Slack manifest asks for what docs/setup.md asks for.
{
  const s = scene()
  const code = await gateway(['manifest', 'slack'], s.io)
  let m = null
  try { m = JSON.parse(s.out.join('\n')) } catch { /* checked below */ }
  const setup = readFileSync(new URL('../docs/setup.md', import.meta.url), 'utf8')
  const step = /3\. \*\*OAuth & Permissions\*\*([\s\S]*?)\n4\./.exec(setup)?.[1] ?? ''
  const documented = [...step.matchAll(/`([a-z_]+:[a-z_]+)`/g)].map((x) => x[1])
  const scopes = m?.oauth_config?.scopes?.bot ?? []
  check('manifest: JSON, Socket Mode on, interactivity on', code === 0 && m?.settings?.socket_mode_enabled === true && m.settings.interactivity.is_enabled === true)
  check('manifest: every bot scope docs/setup.md lists is in it', documented.length >= 8 && documented.every((x) => scopes.includes(x)), `documented: ${documented.join(' ')}`)
  check('manifest: the events the setup names', JSON.stringify(m?.settings?.event_subscriptions?.bot_events) === '["app_mention","message.im","message.channels","message.groups"]')
  check('manifest: the same as slackManifest()', JSON.stringify(m) === JSON.stringify(slackManifest()))
  s.done()
}

// 10. The terminal: one session for the whole guided setup — raw mode and one reader from the first question
// to the end, keys parsed out of what arrives however it is split, and keys typed between prompts dropped.
const fakeTerminal = () => {
  const input = new EventEmitter() as any
  const modes: boolean[] = []
  input.setRawMode = (on: boolean) => { modes.push(on) }
  input.resume = () => {}
  input.pause = () => {}
  const term = { input, modes, shown: '', interrupted: 0, send: (...chunks: string[]) => { for (const c of chunks) input.emit('data', Buffer.from(c)) } }
  const output = { write: (t: string) => { term.shown += t; return true } } as any
  return { input, modes, send: term.send, output, session: terminalSession(input, output, () => { term.interrupted++ }), get text() { return term.shown }, get interrupted() { return term.interrupted } }
}
{
  const t = fakeTerminal()
  const answer = t.session.ask('Token:', false)
  t.send('abx', '\x7f', '\x1b[A', 'c\r')
  check('prompt: typed, backspace, an arrow key ignored, Enter', await answer === 'abc' && t.text === 'Token: abx\b \bc\n', JSON.stringify(t.text))
  const secret = t.session.ask('Token:', true)
  t.send('xoxb-1-2\r')
  check('prompt: a secret shows a * per character, never the character', await secret === 'xoxb-1-2' && t.text.endsWith('Token: ********\n'), JSON.stringify(t.text.slice(-20)))
  const cancelled = t.session.ask('Token:', true)
  t.send('xo\x03')
  check('prompt: ctrl+c is null', await cancelled === null)
  const esc = t.session.ask('Id:', false)
  t.send('12\x1b')
  check('prompt: Esc is back (empty), after the wait that tells it from a key', await esc === '')
  check('session: raw mode is taken once, for every prompt', t.modes.join() === 'true', t.modes.join())
  // Typed while no prompt is open — an Enter while a token is checked — is dropped, not the next answer.
  t.send('x\r')
  const next = t.session.ask('Next:', false)
  t.send('y\r')
  check('session: keys typed between prompts are dropped', await next === 'y')
  t.send('\x03')
  check('session: Ctrl+C with no prompt open quits', t.interrupted === 1)
  t.session.close()
  check('session: closed, raw mode and the reader are given back', t.modes.join() === 'true,false' && t.input.listenerCount('data') === 0)
}
{
  const t = fakeTerminal()
  const word = t.session.ask('Name:', false)
  const euro = Buffer.from('€\r')
  t.input.emit('data', euro.subarray(0, 1)); t.input.emit('data', euro.subarray(1))
  check('prompt: a character split across two reads arrives whole', await word === '€')
  t.session.close()
}

// 11. Usage.
{
  const s = scene()
  check('usage: an unknown option is exit 2', await gateway(['status', '--channels', 'x'], s.io) === 2)
  check('usage: a stray argument is exit 2', await gateway(['stop', 'now'], s.io) === 2)
  check('usage: --help is exit 0', await gateway(['setup', '--help'], s.io) === 0 && s.out.join().includes('dsh gateway setup <slack|telegram|discord|local>'))
  s.done()
}

// 12. What the review found, each pinned — with a control where the fixture could pass by accident.
{
  const s = scene({ noPid: ['ai.deepbot.gateway'] })
  const st = await gateway(['status'], s.io)
  check('M1 status: a job loaded with no process says so, exit 1', st === 1 && s.out.some((l) => l.includes('loaded, not running')), s.text())
  s.calls.length = 0
  const code = await gateway(['start'], s.io)
  check('M1 start: a job loaded with no process is kickstarted, not called running', code === 0 && s.launchctl().join() === 'kickstart gui/501/ai.deepbot.gateway' && !s.out.some((l) => l.startsWith('already running')), s.text())
  s.done()
}
{
  // setup never leaves two messengers now; a profile edited by hand still can, and restart reads it.
  const two = TEMPLATE.replace('    platform: slack\n', "    platform: ['slack', 'telegram']\n")
  const s = scene({ profile: two, lastError: 'Conflict: terminated by other getUpdates request' })
  const code = await gateway(['restart'], s.io)
  check('M2: with two platforms, one connected and another failing after it is exit 1, with its error', code === 1 && s.err.join().includes('another reported an error: Conflict'), s.text())
  s.done()
  const t = scene({ profile: two })
  const ok = await gateway(['restart'], t.io)
  check('M2 control: with none failing it is exit 0, and says it cannot tell which connected', ok === 0 && t.out.some((l) => l.includes('does not say which')), t.text())
  t.done()
}
{
  const withUsers = (list: string) => HAND.replace('    replyMode: mention\n', `    allowedUsers: ${list}\n    replyMode: mention\n`)
  check('M3: an unquoted number in a list is refused, and says to quote it', /is a number to YAML: quote it, '123456789'/.test((readProfile(withUsers('[123456789]')) as any).error ?? ''), JSON.stringify(readProfile(withUsers('[123456789]'))))
  check('M3 control: the same id quoted is read', (readProfile(withUsers("['123456789']")) as any).allowedUsers?.join() === '123456789')
}
{
  const s = scene({ vars: { ...SLACK }, boots: false })
  writeFileSync(s.healthPath, JSON.stringify({ pid: 1, startedAt: 1, connected: true, updatedAt: 1 }))
  const code = await gateway(['setup', 'slack', '--no-verify'], s.io)
  check('M4: the last process\'s "connected" does not count after a restart that never comes up', code === 1 && s.err.join().includes('not connected within'), s.text())
  s.done()
}
{
  const token = '123456:AAbb_cc-dd'
  const s = scene({ vars: { TELEGRAM_BOT_TOKEN: token }, fetchReply: (url) => { throw new Error(`request to ${url} failed, reason: ${url}`) } })
  const code = await gateway(['setup', 'telegram'], s.io)
  check('L1: a fetch error naming the token\'s URL twice shows the token neither time', code === 1 && !s.text().includes(token) && s.err.join().includes('could not reach api.telegram.org'), s.text())
  s.done()
}
{
  const row = (lines: string) => HAND.replace("    targetChannels:\n      - 'C0AAAAAAA'\n      - tui\n", lines)
  const written = writeProfile(row(`    targetChannels: ["C1", "o'k"]\n`), { targetChannels: ['C1', "o'k", 'C2'] }) as string
  check('L2: a quote inside a value is doubled when written, and read back as it was', written.includes("    targetChannels: ['C1', 'o''k', 'C2']") && (readProfile(written) as any).targetChannels.join() === "C1,o'k,C2", written)
  check('L2: an alias, a tag or null is refused, not taken as a name', ['*anchor', '!tag', 'null', '~'].every((v) => /not a plain value/.test((readProfile(row(`    targetChannels: [${v}]\n`)) as any).error ?? '')))
  check('L2: items at two indents are refused', /different indents/.test((readProfile(row('    targetChannels:\n      - C1\n        - C2\n')) as any).error ?? ''))
  const rowLevel = HAND.replace('- id: deepbot\n  config:\n', '- id: deepbot\n  platform: discord\n  config:\n')
  check('L2: a key outside config: is not the setting', (readProfile(rowLevel) as any).platform?.join() === 'slack,local', JSON.stringify(readProfile(rowLevel)))
  const block = HAND.replace("    platform: ['slack', 'local']\n", '    notes: |\n      platform: discord\n')
  check('L2: a key inside a block of text is not the setting', /no platform line/.test((readProfile(block) as any).error ?? ''), JSON.stringify(readProfile(block)))
}
check('L3: a CRLF profile is refused by name', /line endings/.test((readProfile(HAND.replace(/\n/g, '\r\n')) as any).error ?? ''))
check('L4: in a CRLF .env the key is replaced, not added twice, and every line keeps CRLF', envSet('A=1\r\nK=old\r\nB=2\r\n', 'K', 'new') === 'A=1\r\nK=new\r\nB=2\r\n' && envValue('K=old\r\n', 'K') === 'old', JSON.stringify(envSet('A=1\r\nK=old\r\nB=2\r\n', 'K', 'new')))
check('L6: a Slack token typed where ids go is not an id', parseIds('xoxb-1-2-abc', false) === null && parseIds('U1 xapp-1-def', false) === null)
{
  const reply = (app: string) => (url: string) => (url.includes('auth.test') ? { ok: true, status: 200, body: { ok: true, user: 'bot', team: 'acme', bot_id: 'B1' } }
    : url.includes('bots.info') ? { ok: true, status: 200, body: { ok: true, bot: { app_id: app } } } : { ok: true, status: 200, body: { ok: true } })
  const tokens = { SLACK_BOT_TOKEN: 'xoxb-1-2-abc', SLACK_APP_TOKEN: 'xapp-1-A0M-2' }
  const s = scene({ vars: tokens, fetchReply: reply('A0X') })
  const before = s.env()
  const code = await gateway(['setup', 'slack'], s.io)
  check('L9: a bot token and an app-level token from two Slack apps are refused, exit 2, nothing written', code === 2 && s.err.join().includes('A0X') && s.err.join().includes('A0M') && s.env() === before, s.text())
  s.done()
  const t = scene({ vars: tokens, fetchReply: reply('A0M') })
  check('L9 control: from one app they are taken', await gateway(['setup', 'slack'], t.io) === 0, t.text())
  t.done()
}
{
  const s = scene({ env: 'SLACK_BOT_TOKEN=x\nSLACK_APP_TOKEN=y\n' })
  writeFileSync(s.healthPath, JSON.stringify({ pid: 999, startedAt: 999_000, connected: true, updatedAt: 999_990 }))
  const code = await gateway(['status'], s.io)
  check('L11: a health file from another pid than the running one is not healthy, and says so', code === 1 && s.out.some((l) => l.includes('from pid 999')), s.text())
  s.done()
}
{
  const s = scene({ failBootout: ['ai.deepbot.gateway'] })
  const code = await gateway(['stop'], s.io)
  check('L15: a gateway that will not stop gets its probe back', code === 1 && s.launchctl().join('|') === 'bootout gui/501/ai.deepbot.health|bootout gui/501/ai.deepbot.gateway|bootstrap gui/501', s.launchctl().join('|'))
  s.done()
}

// 13. A harness set up before deepseek-bot. The DeepSeek Harness app keeps the keys entered in it in its own
// store, ~/.dsh/.credentials.yaml — names under `refs:` — and the harness reads that before ~/.dsh/.env. Its
// keys are used as they are: not asked for, not reported missing, and the store is never written.
const STORE = `version: 1

refs:
  # entered in the app
  OG_API_KEY: stored-og-value
  SLACK_BOT_TOKEN: ${SLACK.SLACK_BOT_TOKEN}
records:
  client-connection/browser-session:
    kind: session
  DISCORD_BOT_TOKEN:
    kind: not-a-ref
`
check('store: the names under refs: are read, comments and records: are not', storeRefs(STORE).join() === 'OG_API_KEY,SLACK_BOT_TOKEN', storeRefs(STORE).join())
check('store: a key nested under a ref is not a ref of its own, and CRLF reads the same', storeRefs('refs:\r\n  A_KEY:\r\n    nested: x\r\n  B_KEY: y\r\n').join() === 'A_KEY,B_KEY', storeRefs('refs:\r\n  A_KEY:\r\n    nested: x\r\n  B_KEY: y\r\n').join())
check('store: no store, or no refs:, holds nothing', storeRefs('').length === 0 && storeRefs('version: 1\nrecords:\n  X_KEY: y\n').length === 0)
// A comment does not end a mapping in YAML, at any indent: the names after it are still refs.
check('store: a comment at column 0 inside refs: hides nothing after it', storeRefs('version: 1\nrefs:\n  A_KEY: x\n# note\n  B_KEY: y\nrecords:\n  C_KEY: z\n').join() === 'A_KEY,B_KEY', storeRefs('version: 1\nrefs:\n  A_KEY: x\n# note\n  B_KEY: y\nrecords:\n  C_KEY: z\n').join())
check('store: quoted keys, a space before the colon, and a flow mapping are names too', storeRefs('refs:\n  "A_KEY": x\n  \'B_KEY\': y\n  C_KEY : z\n').join() === 'A_KEY,B_KEY,C_KEY' && storeRefs('refs: {D_KEY: x, "E_KEY": y}\n').join() === 'D_KEY,E_KEY', `${storeRefs('refs:\n  "A_KEY": x\n  \'B_KEY\': y\n  C_KEY : z\n').join()} | ${storeRefs('refs: {D_KEY: x, "E_KEY": y}\n').join()}`)
{
  const s = scene({ store: STORE, vars: { SLACK_APP_TOKEN: SLACK.SLACK_APP_TOKEN } })
  const code = await gateway(['setup', 'slack'], s.io)
  check('store: a token the app already holds is not asked for, and is said to be kept there', code === 0 && s.out.some((l) => l.includes('SLACK_BOT_TOKEN') && l.includes('DeepSeek Harness')), s.text())
  check('store: only the missing token goes to ~/.dsh/.env', !s.env().includes('SLACK_BOT_TOKEN') && s.env().includes('SLACK_APP_TOKEN='), JSON.stringify(s.env()))
  check('store: and the store is not written', s.store() === STORE)
  s.done()
}
{
  const s = scene({ store: STORE, vars: { ...SLACK, SLACK_BOT_TOKEN: 'xoxb-9-9-other' } })
  const before = s.env()
  const code = await gateway(['setup', 'slack'], s.io)
  check('store: a different token given for a name the store holds is refused — the harness would read the store\'s — nothing written', code === 2 && s.err.join().includes('SLACK_BOT_TOKEN') && s.err.join().includes('DeepSeek Harness') && s.env() === before && s.store() === STORE, s.text())
  s.done()
}
{
  // An agent re-running setup with the token the app already holds is not a conflict.
  const s = scene({ store: STORE, vars: { ...SLACK } })
  const code = await gateway(['setup', 'slack'], s.io)
  check('store: the same token the store holds is taken as held, not refused, and not written to .env', code === 0 && !s.env().includes('SLACK_BOT_TOKEN') && s.out.some((l) => l.includes('SLACK_BOT_TOKEN') && l.includes('DeepSeek Harness')), s.text())
  check('store: and no value of the store is printed', !s.text().includes('stored-og-value') && !s.text().includes(SLACK.SLACK_BOT_TOKEN))
  s.done()
}
{
  // The store holds this app's app-level token; .env still has an old app's. The harness reads the store's.
  const reply = (url: string) => (url.includes('auth.test') ? { ok: true, status: 200, body: { ok: true, user: 'bot', team: 'acme', bot_id: 'B1' } }
    : url.includes('bots.info') ? { ok: true, status: 200, body: { ok: true, bot: { app_id: 'ANEW' } } } : { ok: true, status: 200, body: { ok: true } })
  const s = scene({ store: 'refs:\n  SLACK_APP_TOKEN: xapp-1-ANEW-2\n', env: 'SLACK_APP_TOKEN=xapp-1-AOLD-2\n', vars: { SLACK_BOT_TOKEN: 'xoxb-1-2-new' }, fetchReply: reply })
  const code = await gateway(['setup', 'slack'], s.io)
  check('store: the same-app check is not made against an app-level token the store shadows', code === 0 && !s.err.join().includes('both must come from one app'), s.text())
  s.done()
  // Control: it is the store's token that is compared, not skipped — one from another app is still caught.
  const t = scene({ store: 'refs:\n  SLACK_APP_TOKEN: xapp-1-AOT-2\n', vars: { SLACK_BOT_TOKEN: 'xoxb-1-2-new' }, fetchReply: reply })
  const other = await gateway(['setup', 'slack'], t.io)
  check('store: and the store\'s own app-level token, from another app, is caught', other === 2 && t.err.join().includes('both must come from one app') && t.err.join().includes('AOT') && !t.text().includes('xapp-1-AOT-2'), t.text())
  t.done()
}
{
  const s = scene({ store: STORE, env: `SLACK_APP_TOKEN=${SLACK.SLACK_APP_TOKEN}\n` })
  writeFileSync(s.healthPath, JSON.stringify({ pid: 4242, startedAt: 999_000, connected: true, connectedAt: 999_000, lastError: null, updatedAt: 999_990 }))
  const code = await gateway(['status', '--json'], s.io)
  let parsed = null
  try { parsed = JSON.parse(s.out.join('\n')) } catch { /* checked below */ }
  check('status: a token in the app\'s store is there, not missing; healthy', code === 0 && parsed?.credentials.SLACK_BOT_TOKEN === 'store' && parsed?.credentials.SLACK_APP_TOKEN === 'dotenv', JSON.stringify(parsed?.credentials))
  check('status: a name under records: is not a credential', parsed?.credentials.DISCORD_BOT_TOKEN === undefined)
  s.out.length = 0
  await gateway(['status'], s.io)
  check('status: the text says where each token is', s.out.some((l) => /SLACK_BOT_TOKEN set \(DeepSeek Harness app\)/.test(l) && /SLACK_APP_TOKEN set \(~\/\.dsh\/\.env\)/.test(l)), s.text())
  s.done()
}
{
  // The model's key: the one the profile's route names, else the default route's DEEPSEEK_API_KEY.
  const routed = `${TEMPLATE}\n- id: llm-pi-ai\n  config:\n    providers:\n      og:\n        apiKeyEnv: OG_API_KEY\n`
  const s = scene({ profile: routed, store: STORE })
  await gateway(['status', '--json'], s.io)
  let parsed = null
  try { parsed = JSON.parse(s.out.join('\n')) } catch { /* checked below */ }
  check('status: the model key is the one the profile\'s route names, found in the app\'s store', parsed?.credentials.OG_API_KEY === 'store' && !('DEEPSEEK_API_KEY' in (parsed?.credentials ?? {})), JSON.stringify(parsed?.credentials))
  s.done()
  const t = scene({ env: '' })
  await gateway(['status', '--json'], t.io)
  let plain = null
  try { plain = JSON.parse(t.out.join('\n')) } catch { /* checked below */ }
  check('status: with no route of its own, the model key is DeepSeek\'s, and absent is null, not an error', plain?.credentials.DEEPSEEK_API_KEY === null, JSON.stringify(plain?.credentials))
  t.out.length = 0
  await gateway(['status'], t.io)
  check('status: and the text says it is only DeepSeek\'s own API that needs it', t.out.some((l) => l.startsWith('model key') && l.includes('DeepSeek\'s own API')), t.text())
  t.done()
  // A key named by another plugin's row (web search) is not the model's.
  const searched = `${routed}\n- id: web-search-deepseek\n  config:\n    apiKeyEnv: SEARCH_KEY\n`
  const u = scene({ profile: searched, store: STORE })
  await gateway(['status', '--json'], u.io)
  let only = null
  try { only = JSON.parse(u.out.join('\n')) } catch { /* checked below */ }
  check('status: only the llm-pi-ai row\'s keys are the model\'s', only?.credentials.OG_API_KEY === 'store' && !('SEARCH_KEY' in (only?.credentials ?? {})), JSON.stringify(only?.credentials))
  u.done()
}

// 14. The guided setup at a terminal: a menu of the messengers, each step chosen with ↑↓ and Enter, the
// browser opened where a token is made, each token checked as it is pasted. The fakes answer the menus.
const MENU_DONE = 4                     // Slack, Telegram, Discord, Terminal, Done
const slackReply = (bad = 'never') => (url: string, init: any) => (url.includes('auth.test')
  ? (String(init?.headers?.Authorization).includes(bad) ? { ok: true, status: 200, body: { ok: false, error: 'invalid_auth' } } : { ok: true, status: 200, body: { ok: true, user: 'deepbot', team: 'acme', bot_id: 'B1' } })
  : url.includes('bots.info') ? { ok: true, status: 200, body: { ok: true, bot: { app_id: 'A0M' } } } : { ok: true, status: 200, body: { ok: true } })
{
  const s = scene({ picks: [MENU_DONE], answers: [] })
  const before = [s.env(), s.profile()]
  const code = await gateway(['setup'], s.io)
  const menu = s.menus[0]
  check('guided: the first screen lists each messenger with where it stands', menu?.options.map((o) => o.hint ?? '').join('|') === '⚠️  tokens missing|⬜ not set up|⬜ not set up|⬜ off|' && menu.options[4].label.includes('Done'), JSON.stringify(menu?.options))
  check('guided: with nothing set up the cursor starts on the first messenger', menu?.initial === 0, String(menu?.initial))
  check('guided: Done with nothing chosen changes nothing', code === 0 && s.env() === before[0] && s.profile() === before[1] && s.launchctl().length === 0, s.text())
  s.done()
}
{
  const s = scene({ picks: [0, 0, 0, MENU_DONE, 0], answers: [SLACK.SLACK_BOT_TOKEN, 'xapp-1-A0M-2'], fetchReply: slackReply() })
  const code = await gateway(['setup'], s.io)
  const url = s.opened[0] ?? ''
  let manifest = null
  try { manifest = JSON.parse(decodeURIComponent(url.split('manifest_json=')[1] ?? '')) } catch { /* checked below */ }
  check('guided Slack: the browser opens Slack\'s create-from-manifest page, filled in', url.startsWith('https://api.slack.com/apps?new_app=1&manifest_json=') && manifest?.settings?.socket_mode_enabled === true, url.slice(0, 80))
  check('guided Slack: both tokens are asked for, hidden, and saved', s.env().includes(`SLACK_BOT_TOKEN=${SLACK.SLACK_BOT_TOKEN}`) && s.env().includes('SLACK_APP_TOKEN=xapp-1-A0M-2') && s.asked.length === 2, JSON.stringify(s.asked))
  check('guided Slack: each token is checked as it is pasted, and who the bot is said', s.out.some((l) => l.includes('@deepbot in acme')) && s.out.some((l) => l.includes('Socket Mode is on')))
  check('guided Slack: Done goes to one restart, and it connects', code === 0 && s.launchctl().join() === 'kickstart -k' && s.text().includes('connected (pid 4242)'), s.text())
  check('guided Slack: it ends saying what to do in Slack', s.out.some((l) => l.includes('🎉')) && s.out.some((l) => l.includes('/invite @deepbot')), s.text())
  check('guided Slack: after a save the menu\'s cursor waits on Done', s.menus.filter((m) => m.title.includes('Which messenger?'))[1]?.initial === MENU_DONE)
  check('guided Slack: no token is printed', !s.text().includes(SLACK.SLACK_BOT_TOKEN) && !s.text().includes('xapp-1-A0M-2'))
  s.done()
}
{
  const s = scene({ picks: [0, 1, 0, MENU_DONE, 1], answers: ['xoxb-9-9-bad', SLACK.SLACK_BOT_TOKEN, 'xapp-1-A0M-2'], fetchReply: slackReply('bad') })
  const code = await gateway(['setup'], s.io)
  check('guided: a token the platform refuses is asked for again, not the end', code === 0 && s.asked.length === 3 && s.out.some((l) => l.includes('invalid_auth')) && s.env().includes(`SLACK_BOT_TOKEN=${SLACK.SLACK_BOT_TOKEN}`) && !s.env().includes('bad'), s.text())
  check('guided: Later restarts nothing', s.launchctl().length === 0)
  s.done()
}
{
  // The third ask gets Enter alone: back to the menu, then Done.
  const s = scene({ picks: [0, 0, MENU_DONE], answers: [SLACK.SLACK_BOT_TOKEN, 'xapp-1-AOT-2'], fetchReply: slackReply() })
  await gateway(['setup'], s.io)
  check('guided: an app-level token from another Slack app is refused and asked again', s.out.some((l) => l.includes('both must come from one app')) && s.asked.length === 3 && s.asked[2].includes('app-level') && !s.env().includes('AOT'), JSON.stringify(s.asked))
  s.done()
}
{
  const s = scene({ picks: [0, 'back', MENU_DONE], answers: [] })
  const before = s.env()
  const code = await gateway(['setup'], s.io)
  check('guided: Esc in a platform\'s steps goes back to the menu, nothing written', code === 0 && s.menus.filter((m) => m.title.includes('Which messenger?')).length === 2 && s.env() === before, s.text())
  s.done()
}
{
  const s = scene({ picks: [0, 0], answers: [null] })
  const before = [s.env(), s.profile()]
  const code = await gateway(['setup'], s.io)
  check('guided: Ctrl+C is exit 130, and what was not saved is not written', code === 130 && s.env() === before[0] && s.profile() === before[1] && s.out.some((l) => l.includes('quit')), s.text())
  s.done()
}
{
  const s = scene({ picks: [1, 0, 1, 0, MENU_DONE, 1], answers: ['123456:AAbb_cc-dd', '111'] })
  const code = await gateway(['setup'], s.io)
  const lists = readProfile(s.profile()) as any
  check('guided Telegram: token checked, "only me" asks the id, and lists it', code === 0 && lists.platform.includes('telegram') && lists.allowedUsers.join() === '111' && s.env().includes('TELEGRAM_BOT_TOKEN='), JSON.stringify(lists))
  check('guided Telegram: it ends saying whom to message', s.out.some((l) => l.includes('message @deep_bot')), s.text())
  s.done()
}
{
  let reads = 0
  const app = (url: string) => (url.includes('applications/@me')
    ? { ok: true, status: 200, body: { id: '777', name: 'deepbot', bot: { username: 'deepbot' }, flags: reads++ === 0 ? 0 : 1 << 18, owner: { id: '42', username: 'owner' } } }
    : { ok: true, status: 200, body: {} })
  const s = scene({ picks: [2, 0, 1, 0, 0, 0, MENU_DONE, 1], answers: ['MTA.abc_d.ef-g'], fetchReply: app })
  const code = await gateway(['setup'], s.io)
  const lists = readProfile(s.profile()) as any
  check('guided Discord: the Message Content intent is checked, and checked again once turned on', s.out.filter((l) => l.includes('Message Content Intent is off')).length === 1 && reads === 2, s.text())
  check('guided Discord: the invite link is made from the token, with the permissions it needs', s.opened.some((u) => u === 'https://discord.com/oauth2/authorize?client_id=777&scope=bot&permissions=274878008384'), JSON.stringify(s.opened))
  check('guided Discord: "only me" is the application\'s owner, with nothing to type', code === 0 && lists.allowedUsers.join() === '42' && s.asked.length === 1, JSON.stringify({ users: lists.allowedUsers, asked: s.asked }))
  s.done()
}
{
  const set = `DEEPSEEK_API_KEY=sk-test\nSLACK_BOT_TOKEN=${SLACK.SLACK_BOT_TOKEN}\nSLACK_APP_TOKEN=${SLACK.SLACK_APP_TOKEN}\n`
  const s = scene({ env: set, picks: [0, 0, MENU_DONE], answers: [] })
  const code = await gateway(['setup'], s.io)
  check('guided: a messenger already set up is marked so, and the cursor starts on Done', s.menus[0]?.options[0].hint === '✅ set up' && s.menus[0]?.initial === MENU_DONE, JSON.stringify(s.menus[0]))
  check('guided: choosing it offers keep; keeping changes nothing', code === 0 && s.menus[1]?.options[0].label.includes('Keep') && s.env() === set, s.text())
  s.done()
  const t = scene({ profile: HAND, env: set, picks: [0, 2, MENU_DONE, 1], answers: [] })
  await gateway(['setup'], t.io)
  check('guided: or removes it from the bot, its tokens staying', (readProfile(t.profile()) as any).platform.join() === 'local' && t.env() === set, t.text())
  t.done()
}
{
  const s = scene({ store: 'refs:\n  SLACK_BOT_TOKEN: stored-bot-value\n', picks: [0, 1, 0, MENU_DONE, 1], answers: ['xapp-1-A0M-2'], fetchReply: slackReply() })
  const code = await gateway(['setup'], s.io)
  check('guided: a token the DeepSeek Harness app holds is not asked for', code === 0 && s.asked.length === 1 && s.asked[0].includes('app-level') && !s.env().includes('SLACK_BOT_TOKEN') && !s.text().includes('stored-bot-value'), JSON.stringify(s.asked))
  s.done()
}
{
  const s = scene({ picks: [3, MENU_DONE, 1], answers: [] })
  const code = await gateway(['setup'], s.io)
  const lists = readProfile(s.profile()) as any
  check('guided: the terminal is turned on from the menu, every channel already letting it in', code === 0 && lists.platform.join() === 'slack,local' && lists.targetChannels.join() === '*', JSON.stringify(lists))
  s.done()
}
{
  const s = scene({ installed: false, loaded: [], picks: [3, MENU_DONE], answers: [] })
  const code = await gateway(['setup'], s.io)
  check('guided: saved with no service installed is exit 0, and says to install it', code === 0 && s.out.some((l) => l.includes('not installed')) && s.launchctl().length === 0, s.text())
  s.done()
}
{
  // The profile serves Slack: Telegram's first question is the switch, then its own steps.
  const s = scene({ picks: [0, 'quit'], answers: [] })
  const code = await gateway(['setup', 'telegram'], s.io)
  check('guided: setup <platform> at a terminal goes straight to that platform', s.menus.length === 2 && s.menus[0].title.includes('One messenger at a time') && s.menus[1].title.includes('@BotFather') && code === 130, JSON.stringify(s.menus.map((m) => m.title)))
  s.done()
}

{
  // Switching in the guided setup: asked first, Back keeps everything, and the old people do not carry over.
  const listed = TEMPLATE.replace("    targetChannels: ['*']\n", "    targetChannels: ['*']\n    allowedUsers: ['U0SLACK']\n")
  const s = scene({ profile: listed, picks: [1, 1, MENU_DONE], answers: [] })
  const before = s.profile()
  const back = await gateway(['setup'], s.io)
  check('guided switch: choosing another messenger asks first, and Back changes nothing', back === 0 && s.menus[1]?.title.includes('The bot is on Slack') && s.menus[1].options[0].label.includes('Switch to Telegram') && s.profile() === before, JSON.stringify(s.menus[1]))
  s.done()
  const t = scene({ profile: listed, picks: [1, 0, 1, 1, MENU_DONE, 1], answers: ['123456:AAbb_cc-dd'] })
  await gateway(['setup'], t.io)
  const who = t.menus.find((m) => m.title.includes('Who may talk to it?'))
  const lists = readProfile(t.profile()) as any
  check('guided switch: the old messenger\'s people are not the new one\'s — "anyone" is offered again', who?.options.some((o) => o.label.includes('Anyone')) === true, JSON.stringify(who?.options))
  check('guided switch: Telegram replaces Slack; anyone chosen clears the old ids', lists.platform.join() === 'telegram' && lists.allowedUsers.length === 0 && t.out.some((l) => l.includes('Slack switched off')), JSON.stringify(lists))
  t.done()
}

{
  // At a terminal, answers that came with the command are not dropped for menus: a flag, or a token in the
  // environment, means a script or an agent, and takes the path that reads them.
  const s = scene({ picks: [], answers: [], vars: { TELEGRAM_BOT_TOKEN: '1:a' } })
  const code = await gateway(['setup', 'telegram', '--users', '999', '--no-verify', '--no-restart'], s.io)
  const lists = readProfile(s.profile()) as any
  check('guided: at a terminal, flags and an env token take the flag path — none dropped', code === 0 && s.menus.length === 0 && lists.allowedUsers.join() === '999' && s.env().includes('TELEGRAM_BOT_TOKEN=1:a'), s.text())
  s.done()
}
{
  // A token already saved in ~/.dsh/.env is offered, not asked for again — a switch back, or a re-setup.
  const set = `SLACK_BOT_TOKEN=${SLACK.SLACK_BOT_TOKEN}\nSLACK_APP_TOKEN=xapp-1-A0M-2\n`
  const s = scene({ env: set, picks: [0, 1, 0, 0, 0, MENU_DONE], answers: [], fetchReply: slackReply() })
  const code = await gateway(['setup'], s.io)
  check('guided: saved tokens are offered, and used — nothing typed, nothing changed', code === 0 && s.asked.length === 0 && s.menus.filter((m) => m.options[0].label.includes('Use the saved one')).length === 2 && s.env() === set, JSON.stringify(s.asked))
  s.done()
  const t = scene({ env: 'SLACK_BOT_TOKEN=xoxb-saved-1\nSLACK_APP_TOKEN=xapp-1-A0M-2\n', picks: [0, 1, 0, 1, 0, 0, MENU_DONE, 1], answers: [SLACK.SLACK_BOT_TOKEN], fetchReply: slackReply('saved') })
  await gateway(['setup'], t.io)
  check('guided: a saved token the platform refuses is asked for again', t.out.some((l) => l.includes('the saved one: Slack refused it')) && t.asked.length === 1 && t.env().includes(`SLACK_BOT_TOKEN=${SLACK.SLACK_BOT_TOKEN}`), t.text())
  t.done()
}
{
  // People: with some listed, Keep keeps them, Only me replaces them (it used to add to them).
  const tg = TEMPLATE.replace('    platform: slack\n', "    platform: telegram\n").replace("    targetChannels: ['*']\n", "    targetChannels: ['*']\n    allowedUsers: ['111', '222']\n")
  const s = scene({ profile: tg, env: 'TELEGRAM_BOT_TOKEN=1:a\n', picks: [1, 1, 0, 2, MENU_DONE, 1], answers: ['333'] })
  await gateway(['setup'], s.io)
  const who = s.menus.find((m) => m.title.includes('Who may talk to it?'))
  check('guided people: with some listed, the choices are keep, add, only me, anyone', who?.options.map((o) => o.label.split(' ').slice(1).join(' ')).join('|') === 'Keep the 2 listed|Add people|Only me|Anyone who finds the bot', JSON.stringify(who?.options))
  check('guided people: Only me replaces the list', (readProfile(s.profile()) as any).allowedUsers.join() === '333', JSON.stringify(readProfile(s.profile())))
  s.done()
  const t = scene({ profile: tg, env: 'TELEGRAM_BOT_TOKEN=1:a\n', picks: [1, 1, 0, 0, MENU_DONE], answers: [] })
  const code = await gateway(['setup'], t.io)
  check('guided people: Keep keeps it, and nothing changes', code === 0 && t.profile() === tg && t.out.some((l) => l.includes('nothing changed')), t.text())
  t.done()
}
{
  // Not running: Start it now bootstraps the gateway and its probe, and waits for it.
  const s = scene({ loaded: [], picks: [3, MENU_DONE, 0], answers: [] })
  const code = await gateway(['setup'], s.io)
  check('guided: Start it now starts the gateway and its probe, and it connects', code === 0 && s.launchctl().filter((c) => c.startsWith('bootstrap')).length === 2 && s.text().includes('connected (pid 4242)'), s.text())
  s.done()
}
{
  // A team's Discord application: its owner is the team, a pseudo-user; "only me" is the team's owner.
  const app = (url: string) => (url.includes('applications/@me')
    ? { ok: true, status: 200, body: { id: '777', bot: { username: 'deepbot' }, flags: 1 << 18, owner: { id: '900', username: 'team900' }, team: { owner_user_id: '55', members: [{ user: { id: '55', username: 'lead' } }] } } }
    : { ok: true, status: 200, body: {} })
  const s = scene({ picks: [2, 0, 1, 1, 0, MENU_DONE, 1], answers: ['MTA.abc_d.ef-g'], fetchReply: app })
  await gateway(['setup'], s.io)
  const who = s.menus.find((m) => m.title.includes('Who may talk to it?'))
  check('guided Discord: for a team\'s app, "only me" is the team\'s owner, not the team', who?.options[0].hint === '@lead' && (readProfile(s.profile()) as any).allowedUsers.join() === '55', JSON.stringify({ hint: who?.options[0].hint, users: (readProfile(s.profile()) as any).allowedUsers }))
  s.done()
}

{
  // A token in the DeepSeek Harness app that the platform refuses is said so, with where to change it.
  const reply = (url: string) => (url.includes('auth.test') ? { ok: true, status: 200, body: { ok: false, error: 'token_revoked' } } : { ok: true, status: 200, body: { ok: true } })
  const s = scene({ store: 'refs:\n  SLACK_BOT_TOKEN: stored-bot-value\n', picks: [0, MENU_DONE], answers: [], fetchReply: reply })
  const before = s.profile()
  const code = await gateway(['setup'], s.io)
  check('guided: a token in the app the platform refuses is refused, with where to change it, nothing written', code === 0 && s.out.some((l) => l.includes('token_revoked') && l.includes('change it in the app')) && s.profile() === before && !s.text().includes('stored-bot-value'), s.text())
  s.done()
}
check('keys: a private-parameter sequence (SGR mouse) is one key, not Esc', (() => { const keys: string[] = []; keyReader((k) => keys.push(k))('\x1b[<0;10;5M'); return keys.length === 1 })())

// 15. The menu: ↑↓ and j/k move, Enter or a digit chooses, Esc goes back, Ctrl+C quits — keys parsed out of
// whatever arrives: an arrow split over two reads (ssh) is an arrow, not Esc; an arrow and Enter in one read are both.
{
  const menu = async (...chunks: string[]) => {
    const t = fakeTerminal()
    const answer = t.session.choose('   Pick:', [{ label: 'one' }, { label: 'two', hint: 'second' }, { label: 'three' }], 0)
    t.send(...chunks)
    const value = await answer
    t.session.close()
    return { value, shown: t.text }
  }
  const moved = await menu('\x1b[B', '\x1b[B', '\x1b[A', '\r')
  check('menu: down, down, up, Enter is the second line', moved.value === 1, String(moved.value))
  check('menu: the cursor line is marked, and what was chosen stays as one line', moved.shown.includes('❯') && moved.shown.includes('   Pick: \x1b[2m›\x1b[22m two\n'), JSON.stringify(moved.shown.slice(-80)))
  check('menu: lines are not wrapped while it is up, and wrapping is given back', moved.shown.startsWith('\x1b[?25l\x1b[?7l') && moved.shown.includes('\x1b[?7h'))
  check('menu: j and k move too, and wrap', (await menu('k', '\r')).value === 2 && (await menu('j', 'j', 'j', '\r')).value === 0)
  check('menu: a digit chooses its line', (await menu('3')).value === 2)
  check('menu: Esc goes back, Ctrl+C quits', (await menu('\x1b')).value === 'back' && (await menu('\x03')).value === 'quit')
  check('menu: an arrow split over two reads is an arrow, not Esc', (await menu('\x1b', '[B', '\r')).value === 1)
  check('menu: an arrow and Enter in one read are two keys', (await menu('\x1b[B\r')).value === 1)
}

// 16. MCP servers: a row of the harness's MCP client, its credential in ~/.dsh/.env, its tools asked for.
{
  /** A scratch directory with programs in it, for PATH. */
  const bin = mkdtempSync(join(tmpdir(), 'deepbot-bin-'))
  for (const name of ['npx', 'node']) { writeFileSync(join(bin, name), '#!/bin/sh\n'); chmodSync(join(bin, name), 0o755) }
  writeFileSync(join(bin, 'notes.txt'), 'not a program')
  const vars = { PATH: `/nowhere:${bin}` }
  const NOTION = ['mcp', 'add', 'notion', '--env', 'NOTION_TOKEN', '--', 'npx', '-y', '@notionhq/notion-mcp-server']

  check('route: gateway mcp is the gateway CLI', route(['gateway', 'mcp', 'add', 'x']) === 'gateway')

  // A local server, its credential from the environment.
  {
    const s = scene({ vars: { ...vars, NOTION_TOKEN: 'ntn_secret_1' } })
    const before = s.profile()
    const code = await gateway(NOTION, s.io)
    const text = s.profile()
    const block = text.slice(text.indexOf('\n# Added by'))
    check('mcp add: exit 0 and the gateway restarted', code === 0 && s.launchctl().some((c) => c.startsWith('kickstart')), s.text())
    check('mcp add: the profile before it is kept as it was, the askTools line aside',
      text.startsWith(before.replace(/\n*$/, '\n').replace("    targetChannels: ['*']\n", "    targetChannels: ['*']\n    askTools: ['mcp__notion__*']\n")), JSON.stringify(text.slice(0, 80)))
    check('mcp add: a row of the MCP client in an insert of its own, the program by its absolute path, its flags kept',
      block === [
        '',
        '# Added by `dsh gateway mcp add notion`; `dsh gateway mcp remove notion` takes it out.',
        '- insert:',
        '    - id: mcp-notion',
        "      name: '@deepseek-ai/dsh-mcp-client'",
        '      config:',
        "        serverName: 'notion'",
        '        transport: stdio',
        `        command: '${bin}/npx'`,
        "        args: ['-y', '@notionhq/notion-mcp-server']",
        '        env:',
        `          PATH: '${bin}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'`,
        `          NOTION_TOKEN: !!js "process.env.NOTION_TOKEN ?? ''"`,
        '',
      ].join('\n'), JSON.stringify(block))
    check('mcp add: the credential is in ~/.dsh/.env, 600, and nowhere in the profile or the output',
      envValue(s.env(), 'NOTION_TOKEN') === 'ntn_secret_1' && (statSync(s.envPath).mode & 0o777) === 0o600 && !text.includes('ntn_secret_1') && !s.text().includes('ntn_secret_1'), s.text())
    check('mcp add: every tool of the server is asked for, said so', (readProfile(text) as any).platform !== undefined && s.text().includes('asked for: mcp__notion__*'), s.text())
    const rows = mcpRows(text)
    check('mcp add: read back as ours, with what it reads', rows.length === 1 && rows[0].serverName === 'notion' && rows[0].ours && rows[0].reads.join() === 'NOTION_TOKEN', JSON.stringify(rows))

    // Listed, then removed: the profile is the one before, to the byte; the credential stays.
    s.out.length = 0
    check('mcp list: the server, what is asked for, and its credential set', await gateway(['mcp', 'list'], s.io) === 0
      && s.text().includes(`notion  stdio  ${bin}/npx`) && s.text().includes('asked for: mcp__notion__*') && s.text().includes('NOTION_TOKEN: set (~/.dsh/.env)'), s.text())
    check('mcp add: the same name again is refused, nothing written', await gateway(NOTION, s.io) === 2 && s.profile() === text && s.text().includes('already in profile agent'), s.text())
    const removed = await gateway(['mcp', 'remove', 'notion'], s.io)
    check('mcp remove: the profile is as it was before the add, to the byte', removed === 0 && s.profile() === before, JSON.stringify(s.profile().slice(-200)))
    check('mcp remove: its credential stays, and it says so', envValue(s.env(), 'NOTION_TOKEN') === 'ntn_secret_1' && s.text().includes('its credentials stay where they are: NOTION_TOKEN'), s.text())
    s.done()
  }

  // A credential the person has not given: refused without a terminal, asked for at one.
  {
    const s = scene({ vars })
    const [profile, env] = [s.profile(), s.env()]
    const code = await gateway(NOTION, s.io)
    check('mcp add: a missing credential, without a terminal, is refused and nothing is written', code === 2 && s.profile() === profile && s.env() === env && s.text().includes('NOTION_TOKEN=… dsh gateway mcp add notion'), s.text())
    s.done()
  }
  {
    const s = scene({ vars, answers: ['ntn_typed'] })
    const code = await gateway([...NOTION.slice(0, 5), '--no-restart', ...NOTION.slice(5)], s.io)
    check('mcp add: at a terminal it is asked for, not shown, and saved', code === 0 && s.asked.some((q) => q.includes('NOTION_TOKEN') && q.includes('not shown')) && envValue(s.env(), 'NOTION_TOKEN') === 'ntn_typed', s.text())
    check('mcp add: --no-restart does not restart', s.launchctl().length === 0 && s.text().includes('--no-restart'), JSON.stringify(s.launchctl()))
    s.done()
  }
  {
    // One already in ~/.dsh/.env is kept; one only in the app's store cannot reach a server, and is not copied.
    const s = scene({ vars, env: 'DEEPSEEK_API_KEY=sk-test\nNOTION_TOKEN=ntn_kept\n' })
    check('mcp add: a credential already in ~/.dsh/.env is kept as it is', await gateway(NOTION, s.io) === 0 && envValue(s.env(), 'NOTION_TOKEN') === 'ntn_kept' && s.text().includes('NOTION_TOKEN: already in ~/.dsh/.env, kept'), s.text())
    s.done()
    const t = scene({ vars, store: 'refs:\n  NOTION_TOKEN: ntn_in_app\n' })
    const [profile, env, store] = [t.profile(), t.env(), t.store()]
    const code = await gateway(NOTION, t.io)
    check('mcp add: one only in the app\'s store is refused with why, the store unchanged and its value never copied',
      code === 2 && t.profile() === profile && t.env() === env && t.store() === store && t.text().includes('DeepSeek Harness app holds a NOTION_TOKEN') && !t.text().includes('ntn_in_app'), t.text())
    t.done()
  }

  // What is refused before anything is written.
  for (const [label, argv, says] of [
    ['a credential as an argument', ['mcp', 'add', 'gh', '--env', 'GITHUB_TOKEN=ghp_abc', '--', 'npx', 'x'], 'never as an argument'],
    ['a token-shaped value under another name', ['mcp', 'add', 'sl', '--env', 'WORKSPACE=xoxb-1-2', '--', 'npx', 'x'], 'never as an argument'],
    ['a name the harness takes only from its launch environment', ['mcp', 'add', 'x', '--env', 'DSH_TOKEN', '--', 'npx'], 'refuses in ~/.dsh/.env'],
    ['a program not on PATH', ['mcp', 'add', 'x', '--', 'uvx', 'thing'], 'uvx: not found on PATH'],
    ['a file that is not a program', ['mcp', 'add', 'x', '--', `${bin}/notes.txt`], 'not found, or not a program'],
    ['neither a command nor a URL', ['mcp', 'add', 'x'], 'one of the two'],
    ['both a command and a URL', ['mcp', 'add', 'x', '--url', 'https://mcp.example/mcp', '--', 'npx'], 'one of the two'],
    ['a name that cannot prefix a tool', ['mcp', 'add', 'my server', '--', 'npx'], 'is not a server name'],
    ['--bearer for a local server', ['mcp', 'add', 'x', '--bearer', 'T', '--', 'npx'], '--bearer is for a hosted server'],
  ] as const) {
    const s = scene({ vars: { ...vars, DSH_TOKEN: 'x', T: 'y' } })
    const [profile, env] = [s.profile(), s.env()]
    const code = await gateway([...argv], s.io)
    check(`mcp add: ${label} is refused, nothing written`, code === 2 && s.profile() === profile && s.env() === env && s.text().includes(says) && !s.text().includes('ghp_abc'), s.text())
    s.done()
  }

  // More that is refused before anything is written: each one stopped the gateway, or put a credential in the open.
  const ghp = `ghp_${'a'.repeat(30)}`
  const ntn = `ntn_${'b'.repeat(30)}`
  for (const [label, argv, says, vars2] of [
    ['an --ask the adapter refuses at start', ['mcp', 'add', 'x', '--ask', 'write *', '--', 'npx'], 'a tool\'s name', {}],
    ['an empty --ask', ['mcp', 'add', 'x', '--ask', '', '--', 'npx'], 'a tool\'s name', {}],
    ['an --ask with a line break', ['mcp', 'add', 'x', '--ask', "a'\nb", '--', 'npx'], 'a tool\'s name', {}],
    ['--bearer with a value', ['mcp', 'add', 'w', '--url', 'https://mcp.example.com/mcp', '--bearer', `NOTION=${ntn}`], 'never as an argument', {}],
    ['a name given twice', ['mcp', 'add', 'x', '--env', 'FOO', '--env', 'FOO=1', '--', 'npx'], 'FOO is given twice', { FOO: 'v' }],
    ['a credential under a name not shaped like one', ['mcp', 'add', 'x', '--env', `GH=${ghp}`, '--', 'npx'], 'never as an argument', {}],
    ['a credential name with PAT in it', ['mcp', 'add', 'x', '--env', 'GITHUB_PAT=abc', '--', 'npx'], 'never as an argument', {}],
    ['a server argument after --token', ['mcp', 'add', 'x', '--', 'npx', 'server', '--token', 'abc'], 'argument 3', {}],
    ['a server argument shaped like a token', ['mcp', 'add', 'x', '--', 'npx', ntn], 'argument 1', {}],
    ['a URL with a key in it', ['mcp', 'add', 'w', '--url', 'https://mcp.example.com/mcp?api_key=k1'], 'the URL looks like a credential', {}],
    ['a URL with a password in it', ['mcp', 'add', 'w', '--url', 'https://u:p@mcp.example.com/mcp'], 'the URL looks like a credential', {}],
    ['a server name with __', ['mcp', 'add', 'a__b', '--', 'npx'], 'no __', {}],
    ['a credential with a line break', ['mcp', 'add', 'x', '--env', 'X_TOKEN', '--', 'npx'], 'line break', { X_TOKEN: 'a\nINJECTED=1' }],
    ['a placeholder for a credential', ['mcp', 'add', 'x', '--env', 'X_TOKEN', '--', 'npx'], 'is the placeholder', { X_TOKEN: '…' }],
    ['the model key replaced from here', ['mcp', 'add', 'x', '--env', 'DEEPSEEK_API_KEY', '--', 'npx'], 'the bot\'s own', { DEEPSEEK_API_KEY: 'sk-other' }],
    ['a server name ending in _', ['mcp', 'add', 'a_', '--', 'npx'], 'is not a server name', {}],
    ['--ask with --no-ask', ['mcp', 'add', 'x', '--ask', 'send', '--no-ask', '--', 'npx'], 'one or the other', {}],
    ['a server argument that is a URL with a password', ['mcp', 'add', 'pg', '--', 'npx', 'pg-server', 'postgresql://u:hunter2@db/x'], 'argument 2', {}],
  ] as const) {
    const s = scene({ vars: { ...vars, ...vars2 } })
    const [profile, env] = [s.profile(), s.env()]
    const code = await gateway([...argv], s.io)
    check(`mcp add: ${label} is refused, nothing written`, code === 2 && s.profile() === profile && s.env() === env && s.text().includes(says) && !s.text().includes(ghp) && !s.text().includes(ntn) && !s.text().includes('hunter2'), s.text())
    s.done()
  }
  // The control: flags and settings that only name a credential, or are about one, are not one.
  {
    const s = scene({ vars: { ...vars, X_TOKEN: 'tok' } })
    const code = await gateway(['mcp', 'add', 'svc', '--env', 'KEYBOARD_LAYOUT=us', '--env', 'X_TOKEN', '--no-restart', '--', 'npx', 'svc', '--auth-mode', 'none', '--oauth', 'false', '--api-key-env', 'X_TOKEN'], s.io)
    check('mcp add: --auth-mode none, --api-key-env NAME and KEYBOARD_LAYOUT are not credentials', code === 0 && s.profile().includes("args: ['svc', '--auth-mode', 'none', '--oauth', 'false', '--api-key-env', 'X_TOKEN']") && s.profile().includes("KEYBOARD_LAYOUT: 'us'"), s.text())
    s.done()
  }
  // Nor typed at a terminal: the bot's own key is never asked for here.
  {
    const s = scene({ vars, env: '', answers: ['sk-typed'] })
    const code = await gateway(['mcp', 'add', 'ds', '--env', 'DEEPSEEK_API_KEY', '--', 'npx'], s.io)
    check('mcp add: the bot\'s own key is not asked for at a terminal either', code === 2 && s.asked.length === 0 && s.env() === '' && s.text().includes('the bot\'s own'), s.text())
    s.done()
  }
  // A credential with a ' in it is kept as it is.
  {
    const s = scene({ vars: { ...vars, A_TOKEN: "it's", B_TOKEN: "it's #1" } })
    const code = await gateway(['mcp', 'add', 'q', '--env', 'A_TOKEN', '--env', 'B_TOKEN', '--no-restart', '--', 'npx'], s.io)
    check('mcp add: a credential with \' is written so .env reads it back the same', code === 0 && parseEnv(s.env()).A_TOKEN === "it's" && parseEnv(s.env()).B_TOKEN === "it's #1", s.env())
    s.done()
  }
  // Removing one server leaves the entries of another whose name starts with it.
  {
    const s = scene({ vars })
    await gateway(['mcp', 'add', 'a', '--no-restart', '--', 'npx'], s.io)
    await gateway(['mcp', 'add', 'a-b', '--no-restart', '--', 'npx'], s.io)
    await gateway(['mcp', 'remove', 'a', '--no-restart'], s.io)
    check('mcp remove: another server\'s askTools entries stay', s.profile().includes("askTools: ['mcp__a-b__*']"), s.profile().split('\n').find((l) => l.includes('askTools')))
    s.done()
  }

  // A credential with characters .env treats specially is written so the harness's own parser reads it back the same.
  {
    const s = scene({ vars: { ...vars, DB_PASSWORD: 'pa#ss word"x' } })
    const code = await gateway(['mcp', 'add', 'db', '--env', 'DB_PASSWORD', '--no-restart', '--', 'npx', 'db-server'], s.io)
    check('mcp add: a credential with # and spaces is read back the same by Node\'s .env parser', code === 0 && parseEnv(s.env()).DB_PASSWORD === 'pa#ss word"x' && parseEnv(s.env()).DEEPSEEK_API_KEY === 'sk-test', s.env())
    s.done()
  }
  // At a terminal, a credential only in the app's store is explained before it is asked for.
  {
    const s = scene({ vars, answers: ['ntn_typed'], store: 'refs:\n  NOTION_TOKEN: ntn_in_app\n' })
    await gateway([...NOTION.slice(0, 5), '--no-restart', ...NOTION.slice(5)], s.io)
    const said = s.out.findIndex((l) => l.includes('DeepSeek Harness app holds a NOTION_TOKEN'))
    check('mcp add: at a terminal, the app\'s copy is explained before the question', said !== -1 && s.asked.length === 1 && envValue(s.env(), 'NOTION_TOKEN') === 'ntn_typed' && !s.text().includes('ntn_in_app'), s.text())
    s.done()
  }
  // Remove takes out only its block: blank lines elsewhere (inside a block of text) stay as they were.
  {
    const spaced = TEMPLATE.replace("- id: deepbot\n", "- id: notes-text\n  config:\n    text: |\n      one\n\n\n      two\n\n- id: deepbot\n")
    const s = scene({ vars, profile: spaced })
    await gateway(['mcp', 'add', 'a', '--no-restart', '--', 'npx'], s.io)
    await gateway(['mcp', 'add', 'b', '--no-restart', '--', 'npx'], s.io)
    await gateway(['mcp', 'remove', 'a', '--no-restart'], s.io)
    await gateway(['mcp', 'remove', 'b', '--no-restart'], s.io)
    check('mcp remove: two added and removed out of order leave the profile as it was, blank lines in text included', s.profile() === spaced, JSON.stringify(s.profile().slice(-300)))
    s.done()
  }
  // list does not need the askTools line read.
  {
    const odd = TEMPLATE.replace("    targetChannels: ['*']\n", "    targetChannels: ['*']\n    askTools:\n      - mcp__mail__send   # mail\n")
    const s = scene({ vars, profile: odd.replace("    - id: skill-office\n", "    - id: mcp-mail\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: mail\n        transport: stdio\n        command: /usr/bin/true\n\n    - id: skill-office\n") })
    check('mcp list: an askTools line it cannot read shows as unknown, not a failure', await gateway(['mcp', 'list'], s.io) === 0 && s.text().includes('mail  stdio') && s.text().includes('asked for: ?'), s.text())
    s.done()
  }

  // A setting that is not a secret goes into the row; --ask narrows what is asked for; --no-ask asks nothing.
  {
    const s = scene({ vars })
    await gateway(['mcp', 'add', 'files', '--env', 'ROOT_DIR=/srv/docs', '--ask', 'write_*', '--ask', 'mcp__files__delete', '--no-restart', '--', 'node', '/opt/files-server.js'], s.io)
    check('mcp add: a setting goes into the row as written', s.profile().includes("          ROOT_DIR: '/srv/docs'") && s.profile().includes(`        command: '${bin}/node'`) && s.profile().includes("        args: ['/opt/files-server.js']"), s.profile().slice(-400))
    check('mcp add: --ask names only those tools, prefixed once', s.profile().includes("    askTools: ['mcp__files__write_*', 'mcp__files__delete']"), s.profile())
    s.done()
    const t = scene({ vars })
    const before = t.profile()
    await gateway(['mcp', 'add', 'files', '--no-ask', '--no-restart', '--', 'node'], t.io)
    check('mcp add: --no-ask leaves askTools alone, and says its tools run without a question', !t.profile().includes('askTools:') && t.profile().startsWith(before.replace(/\n*$/, '\n')) && t.text().includes('run without a question'), t.text())
    t.done()
  }

  // A hosted server: its URL, and a bearer credential as a header.
  {
    const s = scene({ vars: { MCP_TOKEN: 'tok_1' } })
    const code = await gateway(['mcp', 'add', 'web', '--url', 'https://mcp.example.com/mcp', '--bearer', 'MCP_TOKEN', '--no-restart'], s.io)
    check('mcp add: a hosted server is streamable-http with its URL and an Authorization header from the environment',
      code === 0 && s.profile().endsWith(["        transport: streamable-http", "        url: 'https://mcp.example.com/mcp'", '        headers:', `          Authorization: !!js "'Bearer ' + (process.env.MCP_TOKEN ?? '')"`, ''].join('\n')) && envValue(s.env(), 'MCP_TOKEN') === 'tok_1', s.profile().slice(-300))
    check('mcp add: and it says a browser sign-in is out of reach', s.text().includes('OAuth'), s.text())
    s.done()
  }

  // A row written by hand, inside the template's own insert: listed, not removed.
  {
    const hand = TEMPLATE.replace("    - id: skill-office\n", "    - id: mcp-github\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: github\n        transport: stdio\n        command: /opt/homebrew/bin/npx\n        env:\n          GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN ?? ''\n\n    - id: skill-office\n")
    const s = scene({ profile: hand })
    await gateway(['mcp', 'list'], s.io)
    check('mcp list: a row written by hand is listed as such, with its credential missing', s.text().includes('github  stdio  /opt/homebrew/bin/npx  (written by hand)') && s.text().includes('GITHUB_TOKEN: missing'), s.text())
    const code = await gateway(['mcp', 'remove', 'github'], s.io)
    check('mcp remove: one written by hand is not taken out', code === 1 && s.profile() === hand && s.text().includes('take it out by hand'), s.text())
    check('mcp add: nor added over', await gateway(['mcp', 'add', 'github', '--', 'npx'], s.io) === 2 && s.profile() === hand)
    s.done()
  }
  rmSync(bin, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
