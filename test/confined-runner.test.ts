/**
 * The sandbox runner's profile generator.
 *
 * This is the security-critical part of read confinement, and it is testable without
 * running anything under it: the runner can print the profile it would apply, given
 * the policy arguments the harness passes. Checking the text is how the two ways this
 * can go wrong stay caught — allowing writes outside the workspace, or letting an
 * agent read another instance's data.
 *
 * Run: node test/confined-runner.test.ts
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { createHash } from 'node:crypto'

// The runner this checks is macOS-specific: it implements the bwrap-shaped policy with
// Seatbelt, and there is nothing to assert on Linux. Say so and stop, rather than failing CI
// for a platform the deployment does not run on — it was the last red step on every push.
if (process.platform !== 'darwin') {
  console.log('  skipped: the confined runner is macOS-specific (Seatbelt); a Linux host would use a container profile')
  process.exit(0)
}
import { fileURLToPath } from 'node:url'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const RUNNER = fileURLToPath(new URL('../service/confined-runner.sh', import.meta.url))
const HOME = process.env.HOME ?? ''

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** The policy arguments dsh-sandbox-local appends, as measured from its confine(). */
function profile(args) {
  return execFileSync(RUNNER, ['--print-profile', ...args], { encoding: 'utf8' })
}
const READ_ONLY = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']
const WORKSPACE_WRITE = [...READ_ONLY, '--tmpfs', '/tmp', '--bind', `${HOME}/dsh-agent`, `${HOME}/dsh-agent`]

const ws = profile([...WORKSPACE_WRITE, '--', 'true'])
const ro = profile([...READ_ONLY, '--', 'true'])

check('the profile is a valid Seatbelt version line', ws.startsWith('(version 1)'))
check('writes are denied by default', /\(deny file-write\*\)/.test(ws))
check('workspace-write allows the workspace root', ws.includes(`(allow file-write* (subpath "${HOME}/dsh-agent"))`))
check('workspace-write allows temp', /\(allow file-write\* \(subpath "\/tmp"\)/.test(ws))
check('read-only does not allow the workspace', !/allow file-write\* \(subpath/.test(ro.split('read confinement')[0]), 'no write grant before the read rules')
check('read-only still allows the null sink', /\(allow file-write\* \(literal "\/dev\/null"\)/.test(ro))
check('other agent homes are denied reads', /\(deny file-read\* \(subpath "[^"]*dsh-agent-test[^"]*"\)\)/.test(ws) || /deny file-read\*/.test(ws), ws.split('\n').filter((l) => l.includes('file-read')).join(' | '))
check("the instance's own root is not denied a read", !/\(deny file-read\* \(subpath "\$\{?HOME/.test(ws) && !ws.includes(`(deny file-read* (subpath "${HOME}/dsh-agent"))`))
{
  // A deployment's own extra paths — a retired bot's data on the machine this was written on.
  const extraDir = mkdtempSync(join(tmpdir(), 'retired-bot-'))
  const withExtra = execFileSync(RUNNER, ['--print-profile', ...WORKSPACE_WRITE, '--', 'true'], { encoding: 'utf8', env: { ...process.env, DEEPBOT_DENY_READ: `/nonexistent:${extraDir}` } })
  check('DEEPBOT_DENY_READ adds its paths to the denied reads', withExtra.includes(`(deny file-read* (subpath "${extraDir}"))`) && !withExtra.includes('/nonexistent'))
  rmSync(extraDir, { recursive: true, force: true })
}
check('a missing separator is refused rather than guessed', (() => {
  try { execFileSync(RUNNER, READ_ONLY, { encoding: 'utf8', stdio: 'pipe' }); return false }
  catch (e) { return e.status === 64 }
})(), 'exit 64')

// The deployment's credentials. Nothing a command does needs them, and a command's output reaches
// Slack — as a reply, or as a watch alert — where nothing redacts a token (the log does, the reply
// does not). Checked by behaviour, not only by profile text: a fake home with a fake .env, and a
// `cat` inside the runner that must fail without printing it.
//
// Twice: under the temp directory as named (a symlink, /var → /private/var) and resolved. The first
// version passed only the symlinked case — on a resolved path, as live, a shell `[ … ] && printf`
// made the profile fail and the runner refused every command. "Readable" below is what catches that.
for (const resolved of [false, true]) {
  const made = mkdtempSync(join(tmpdir(), 'runner-home-'))
  const fakeHome = resolved ? realpathSync(made) : made
  mkdirSync(join(fakeHome, '.dsh'), { recursive: true })
  writeFileSync(join(fakeHome, '.dsh', '.env'), 'SLACK_BOT_TOKEN=canary-env-5d1\n')
  writeFileSync(join(fakeHome, '.dsh', '.credentials.yaml'), 'refs: { x: canary-cred-9b7 }\n')
  writeFileSync(join(fakeHome, '.dsh', '.credentials.yaml.bak-20261008'), 'canary-bak-3c4\n')
  writeFileSync(join(fakeHome, 'outside.txt'), 'readable-2e8\n')
  // The gateway's own log: its first lines carry the web UI's auth token, which opens the harness's
  // HTTP API — outside this sandbox — to whoever reads it.
  mkdirSync(join(fakeHome, '.dsh', 'service', 'logs'), { recursive: true })
  // Every profile's session logs, the agent's own and everybody else's.
  mkdirSync(join(fakeHome, '.dsh', 'sessions', 'bucket', 's1'), { recursive: true })
  // The recall index: every channel's history, handed out by the adapter one channel at a time.
  mkdirSync(join(fakeHome, '.dsh', 'recall', 'home'), { recursive: true })
  writeFileSync(join(fakeHome, '.dsh', 'recall', 'home', 'recall-index.jsonl'), 'canary-recall-77b\n')
  writeFileSync(join(fakeHome, '.dsh', 'sessions', 'bucket', 's1', 'session.v4.jsonl.zstd'), 'canary-session-a41\n')
  writeFileSync(join(fakeHome, '.dsh', 'service', 'logs', 'gateway.out.log'), 'token=canary-ui-6d2\n')
  // The gateway profiles: the operator's settings, which the agent is told it can neither read nor change.
  mkdirSync(join(fakeHome, '.dsh', 'profiles', 'agent'), { recursive: true })
  writeFileSync(join(fakeHome, '.dsh', 'profiles', 'agent', 'cordis.patch.yml'), 'canary-profile-8e1\n')
  // And everything else the harness keeps there, and whatever it adds next: its session index (every
  // conversation's text, with the WAL that holds the newest), the adapter's state and log, the harness's
  // storages (reminders, a session cache), attachments, the terminal's input history, the watch list.
  // These were readable: the runner denied a list of names, and the list was a step behind the harness.
  const privateFiles = {
    'agent-session-index.db': 'canary-index-1a2', 'agent-session-index.db-wal': 'canary-wal-2b3', 'agent-session-index.db-shm': 'canary-shm-3c4',
    'slack-state/sessions.json': 'canary-state-4d5', 'slack-state/deepbot.log': 'canary-log-5e6',
    'storages/workspace.json': 'canary-ws-6f7', 'storages/schedule.json': 'canary-sched-7a8', 'storages/session_projcache/p': 'canary-proj-8b9',
    'attachments/v1/a.png': 'canary-attach-9c0', 'deepbot-tui/history.jsonl': 'canary-hist-0d1', 'watches.json': 'canary-watch-1e2',
    'added-later.db': 'canary-later-2f3',
  }
  for (const [file, canary] of Object.entries(privateFiles)) {
    mkdirSync(dirname(join(fakeHome, '.dsh', file)), { recursive: true })
    writeFileSync(join(fakeHome, '.dsh', file), `${canary}\n`)
  }
  // The harness's runtimes stay readable: the office skill runs its node from there.
  mkdirSync(join(fakeHome, '.dsh', 'dsh-runtimes', 'rt', 'bin'), { recursive: true })
  writeFileSync(join(fakeHome, '.dsh', 'dsh-runtimes', 'rt', 'bin', 'tool'), 'runtime-3a4\n')
  const env = { ...process.env, HOME: fakeHome }
  const text = execFileSync(RUNNER, ['--print-profile', ...READ_ONLY, '--', 'true'], { encoding: 'utf8', env })
  const as = resolved ? ' (resolved home)' : ' (home under a symlink)'
  check('the profile denies the credential files' + as, text.includes(`(deny file-read* (literal "${fakeHome}/.dsh/.env"))`)
    && text.includes(`(deny file-read* (literal "${fakeHome}/.dsh/.credentials.yaml"))`), text.split('\n').filter((l) => l.includes('.dsh')).join(' | '))
  const read = (file) => {
    try { return execFileSync(RUNNER, [...READ_ONLY, '--', '/bin/cat', join(fakeHome, '.dsh', file)], { encoding: 'utf8', env, stdio: 'pipe' }) }
    catch (e) { return `exit ${e.status}: ${String(e.stdout ?? '')}` }
  }
  check('a command cannot read .env' + as, !read('.env').includes('canary-env-5d1'))
  check('nor .credentials.yaml' + as, !read('.credentials.yaml').includes('canary-cred-9b7'))
  check('nor a backup of it' + as, !read('.credentials.yaml.bak-20261008').includes('canary-bak-3c4'))
  check('nor the gateway\'s log, which carries the web UI token' + as, !read(join('service', 'logs', 'gateway.out.log')).includes('canary-ui-6d2'))
  check('nor the recall index' + as, !read(join('recall', 'home', 'recall-index.jsonl')).includes('canary-recall-77b'))
  check('nor the session store' + as, !read(join('sessions', 'bucket', 's1', 'session.v4.jsonl.zstd')).includes('canary-session-a41'))
  check('nor a gateway profile' + as, !read(join('profiles', 'agent', 'cordis.patch.yml')).includes('canary-profile-8e1'))
  for (const [file, canary] of Object.entries(privateFiles)) check(`nor ${file}` + as, !read(file).includes(canary), read(file).slice(0, 40))
  check('the harness runtimes stay readable' + as, read(join('dsh-runtimes', 'rt', 'bin', 'tool')).includes('runtime-3a4'), read(join('dsh-runtimes', 'rt', 'bin', 'tool')).slice(0, 40))
  // A hard link is another path to the same file, which a path rule would not cover. It cannot be made
  // from the workspace — not because the credentials are denied, but because Seatbelt refuses a link
  // whose source is outside the writable paths at all: a readable file outside is refused the same way
  // (the control below). So the protection does not rest on the read deny, and this says so.
  const ws = join(fakeHome, 'ws')
  mkdirSync(ws, { recursive: true })
  const link = (from, to) => {
    try { execFileSync(RUNNER, ['--ro-bind', '/', '/', '--die-with-parent', '--tmpfs', '/tmp', '--bind', ws, ws, '--', '/bin/ln', from, to], { env, stdio: 'pipe' }) }
    catch { /* refused */ }
    return existsSync(to)
  }
  check('a hard link to the credentials cannot be made' + as, !link(join(fakeHome, '.dsh', '.env'), join(ws, 'copy')))
  check('nor to any file outside the writable paths — the reason it holds' + as, !link(join(fakeHome, 'outside.txt'), join(ws, 'other')))
  writeFileSync(join(ws, 'mine.txt'), 'x')
  check('while one inside them can be, so ln itself works' + as, link(join(ws, 'mine.txt'), join(ws, 'mine-link')))
  // The workspace is written by its resolved name: under a symlinked directory every write used to be
  // refused, and the .env rule matched nothing. Both rules hold for both names now.
  const write = (name) => {
    try { execFileSync(RUNNER, ['--ro-bind', '/', '/', '--die-with-parent', '--tmpfs', '/tmp', '--bind', ws, ws, '--', '/bin/sh', '-c', `echo x > '${join(ws, name)}'`], { env, stdio: 'pipe' }) }
    catch { /* refused */ }
    return existsSync(join(ws, name))
  }
  check('the workspace is writable' + as, write('notes.md'))
  check('except its .env' + as, !write('.env') && !write('.env.local'))
  // A harness home somewhere else (DSH_HOME): its session store and recall index are as private.
  const alt = join(fakeHome, 'alt-dsh')
  mkdirSync(join(alt, 'recall', 'home'), { recursive: true })
  mkdirSync(join(alt, 'sessions', 'b'), { recursive: true })
  writeFileSync(join(alt, 'recall', 'home', 'recall-index.jsonl'), 'canary-alt-recall-5e0\n')
  writeFileSync(join(alt, 'sessions', 'b', 's.zstd'), 'canary-alt-session-6f1\n')
  writeFileSync(join(alt, 'agent-session-index.db'), 'canary-alt-index-7a2\n')
  const readAlt = (file) => {
    try { return execFileSync(RUNNER, [...READ_ONLY, '--', '/bin/cat', join(alt, file)], { encoding: 'utf8', env: { ...env, DSH_HOME: alt }, stdio: 'pipe' }) }
    catch (e) { return `exit ${e.status}` }
  }
  check('nor a DSH_HOME\'s recall index' + as, !readAlt(join('recall', 'home', 'recall-index.jsonl')).includes('canary-alt-recall-5e0'))
  check('nor its session store' + as, !readAlt(join('sessions', 'b', 's.zstd')).includes('canary-alt-session-6f1'))
  check('nor anything else in it' + as, !readAlt('agent-session-index.db').includes('canary-alt-index-7a2'))
  // The control: the runner itself works, and what is outside the harness home is readable.
  const outside = (() => { try { return execFileSync(RUNNER, [...READ_ONLY, '--', '/bin/cat', join(fakeHome, 'outside.txt')], { encoding: 'utf8', env, stdio: 'pipe' }) } catch (e) { return `exit ${e.status}` } })()
  check('a file outside the harness home stays readable' + as, outside.includes('readable-2e8'), outside.slice(0, 40))
  // An agent home someone put inside the harness home is its own, and stays usable.
  const inner = join(fakeHome, '.dsh', 'inner-home')
  mkdirSync(inner, { recursive: true })
  writeFileSync(join(inner, 'note.md'), 'inner-4b5\n')
  const innerRead = (() => { try { return execFileSync(RUNNER, ['--ro-bind', '/', '/', '--die-with-parent', '--bind', inner, inner, '--', '/bin/cat', join(inner, 'note.md')], { encoding: 'utf8', env, stdio: 'pipe' }) } catch (e) { return `exit ${e.status}` } })()
  check('a workspace inside the harness home stays readable' + as, innerRead.includes('inner-4b5'), innerRead.slice(0, 40))
  // Review of the deny. node resolves a script's path by lstat-ing every directory on the way, the harness
  // home among them: a script in the runtimes failed with EPERM while cat of the same file passed.
  writeFileSync(join(fakeHome, '.dsh', 'dsh-runtimes', 'rt', 'run.js'), "console.log('ran-5c6')\n")
  const ran = (() => { try { return execFileSync(RUNNER, [...READ_ONLY, '--', process.execPath, join(fakeHome, '.dsh', 'dsh-runtimes', 'rt', 'run.js')], { encoding: 'utf8', env, stdio: 'pipe' }) } catch (e) { return `exit ${e.status}: ${String(e.stderr ?? '').slice(0, 80)}` } })()
  check('node runs a script from the runtimes' + as, ran.includes('ran-5c6'), ran.slice(0, 100))
  // An agent home set to the harness home itself is not an allow for all of it.
  const whole = (() => { try { return execFileSync(RUNNER, [...READ_ONLY, '--', '/bin/cat', join(fakeHome, '.dsh', 'agent-session-index.db')], { encoding: 'utf8', env: { ...env, DEEPBOT_HOME: join(fakeHome, '.dsh') }, stdio: 'pipe' }) } catch (e) { return `exit ${e.status}` } })()
  check('an agent home set to the harness home itself opens none of it' + as, !whole.includes('canary-index-1a2'), whole.slice(0, 40))
  // DEEPBOT_DENY_READ holds inside what the harness-home block allows.
  writeFileSync(join(fakeHome, '.dsh', 'dsh-runtimes', 'rt', 'secret'), 'canary-deny-6d7\n')
  const extra = (() => { try { return execFileSync(RUNNER, [...READ_ONLY, '--', '/bin/cat', join(fakeHome, '.dsh', 'dsh-runtimes', 'rt', 'secret')], { encoding: 'utf8', env: { ...env, DEEPBOT_DENY_READ: join(fakeHome, '.dsh', 'dsh-runtimes', 'rt', 'secret') }, stdio: 'pipe' }) } catch (e) { return `exit ${e.status}` } })()
  check('DEEPBOT_DENY_READ still holds inside the runtimes' + as, !extra.includes('canary-deny-6d7'), extra.slice(0, 40))
  // With DSH_HOME set the runner still runs commands: a refusal of everything would pass the denies above.
  mkdirSync(join(alt, 'dsh-runtimes', 'rt'), { recursive: true })
  writeFileSync(join(alt, 'dsh-runtimes', 'rt', 'tool'), 'alt-runtime-8e9\n')
  check('with DSH_HOME set, its runtimes stay readable' + as, readAlt(join('dsh-runtimes', 'rt', 'tool')).includes('alt-runtime-8e9'), readAlt(join('dsh-runtimes', 'rt', 'tool')).slice(0, 40))
  rmSync(made, { recursive: true, force: true })
}

// Second review. An entry the runner cannot resolve (no search permission: a retired home made chmod 000)
// wrote an empty subpath, which sandbox-exec refuses, and every command failed. A workspace given by a
// link's name was denied as "another home" by its real name. A DEEPBOT_DENY_READ entry that is a link to a
// file left the file readable.
{
  const fakeHome = realpathSync(mkdtempSync(join(tmpdir(), 'runner-names-')))
  const env = { ...process.env, HOME: fakeHome }
  const ws = join(fakeHome, 'dsh-agent-ws')
  mkdirSync(ws, { recursive: true })
  writeFileSync(join(ws, 'note.md'), 'ws-note-1b2\n')
  const closed = join(fakeHome, 'dsh-agent-retired')
  mkdirSync(closed)
  chmodSync(closed, 0o000)
  const inWs = (cmd, extraEnv = {}, root = ws) => { try { return execFileSync(RUNNER, ['--ro-bind', '/', '/', '--die-with-parent', '--bind', root, root, '--', ...cmd], { encoding: 'utf8', env: { ...env, ...extraEnv }, stdio: 'pipe' }) } catch (e) { return `exit ${e.status}: ${String(e.stderr ?? '').slice(0, 80)}` } }
  check('an agent home it cannot search does not stop every command', inWs(['/bin/echo', 'ran-2c3']).includes('ran-2c3'), inWs(['/bin/echo', 'ran-2c3']).slice(0, 100))
  check('nor does such a DEEPBOT_DENY_READ entry', inWs(['/bin/echo', 'ran-3d4'], { DEEPBOT_DENY_READ: closed }).includes('ran-3d4'))
  chmodSync(closed, 0o755)
  const link = join(fakeHome, 'ws-link')
  symlinkSync(ws, link)
  check('a workspace given by a link\'s name is not denied by its real name', inWs(['/bin/cat', join(link, 'note.md')], {}, link).includes('ws-note-1b2'), inWs(['/bin/cat', join(link, 'note.md')], {}, link).slice(0, 100))
  writeFileSync(join(fakeHome, 'secret.txt'), 'canary-linked-file-4e5\n')
  symlinkSync(join(fakeHome, 'secret.txt'), join(fakeHome, 'secret-link'))
  check('a DEEPBOT_DENY_READ link to a file denies the file', !inWs(['/bin/cat', join(fakeHome, 'secret.txt')], { DEEPBOT_DENY_READ: join(fakeHome, 'secret-link') }).includes('canary-linked-file-4e5'))
  rmSync(fakeHome, { recursive: true, force: true })
}

// Third review. A tenant's workspace sits inside the home (<home>/tenants/<t>), which the dsh-agent* glob
// denies: its own commands could write their files and not read them. A DEEPBOT_DENY_READ entry inside the
// workspace still holds. The workspace is matched in the case it has on disk, and a name with a quote in
// it no longer breaks the .env rule's regex.
{
  const fakeHome = realpathSync(mkdtempSync(join(tmpdir(), 'runner-tenant-')))
  const env = { ...process.env, HOME: fakeHome }
  const home = join(fakeHome, 'dsh-agent')
  const tenant = join(home, 'tenants', 'acme')
  mkdirSync(join(tenant, 'private'), { recursive: true })
  writeFileSync(join(home, 'SOUL.md'), 'canary-home-5f6\n')
  writeFileSync(join(tenant, 'note.md'), 'tenant-note-6a7\n')
  writeFileSync(join(tenant, 'private', 'x'), 'canary-inner-7b8\n')
  const inWs = (root, cmd, extraEnv = {}) => { try { return execFileSync(RUNNER, ['--ro-bind', '/', '/', '--die-with-parent', '--bind', root, root, '--', ...cmd], { encoding: 'utf8', env: { ...env, ...extraEnv }, stdio: 'pipe' }) } catch (e) { return `exit ${e.status}: ${String(e.stderr ?? '').slice(0, 80)}` } }
  check('a tenant workspace inside the home reads its own files', inWs(tenant, ['/bin/cat', join(tenant, 'note.md')]).includes('tenant-note-6a7'), inWs(tenant, ['/bin/cat', join(tenant, 'note.md')]).slice(0, 100))
  check('and still not the home around it', !inWs(tenant, ['/bin/cat', join(home, 'SOUL.md')]).includes('canary-home-5f6'))
  // An entry written with a trailing slash is the same directory: it did not count as holding the workspace.
  check('a DEEPBOT_DENY_READ entry with a trailing / around the workspace leaves it readable', inWs(tenant, ['/bin/cat', join(tenant, 'note.md')], { DEEPBOT_DENY_READ: `${home}/` }).includes('tenant-note-6a7'))
  check('a DEEPBOT_DENY_READ entry inside the workspace still holds', !inWs(tenant, ['/bin/cat', join(tenant, 'private', 'x')], { DEEPBOT_DENY_READ: join(tenant, 'private') }).includes('canary-inner-7b8'))
  const upper = join(fakeHome, 'DSH-AGENT')
  check('a workspace given in another case is still its own (the volume ignores case)', inWs(upper, ['/bin/cat', join(upper, 'SOUL.md')]).includes('canary-home-5f6'), inWs(upper, ['/bin/cat', join(upper, 'SOUL.md')]).slice(0, 100))
  // A workspace that contains the harness home does not open it.
  mkdirSync(join(fakeHome, '.dsh'), { recursive: true })
  writeFileSync(join(fakeHome, '.dsh', 'agent-session-index.db'), 'canary-wide-9d0\n')
  check('a workspace that contains the harness home does not open it', !inWs(fakeHome, ['/bin/cat', join(fakeHome, '.dsh', 'agent-session-index.db')]).includes('canary-wide-9d0'))
  const quoted = join(fakeHome, 'ws "q"')
  mkdirSync(quoted)
  check('a workspace whose name has a quote in it still runs commands', inWs(quoted, ['/bin/echo', 'ran-8c9']).includes('ran-8c9'), inWs(quoted, ['/bin/echo', 'ran-8c9']).slice(0, 100))
  rmSync(fakeHome, { recursive: true, force: true })
}

// The workspace's .git, when the adapter keeps one as the instruction root: a command could remove it, and
// the harness's loader, which looks for it again on every step, would climb to the home's instructions.
{
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'runner-root-')))
  // A .git above the workspaces: the case where the adapter keeps one in the workspace as the root.
  mkdirSync(join(base, '.git'))
  const env = { ...process.env, HOME: base }
  const inWs = (ws, cmd) => { try { execFileSync(RUNNER, ['--ro-bind', '/', '/', '--die-with-parent', '--bind', ws, ws, '--', '/bin/sh', '-c', cmd], { env, stdio: 'pipe' }); return true } catch { return false } }
  const marked = join(base, 'marked')
  mkdirSync(join(marked, '.git'), { recursive: true })
  inWs(marked, `rmdir '${join(marked, '.git')}'`)
  check('a command cannot remove the workspace\'s .git', existsSync(join(marked, '.git')))
  inWs(marked, `mv '${join(marked, '.git')}' '${join(marked, 'moved')}'`)
  check('nor move it aside', existsSync(join(marked, '.git')) && !existsSync(join(marked, 'moved')))
  check('while what is in it can be written (git init works there)', inWs(marked, `echo ref > '${join(marked, '.git', 'HEAD')}'`) && existsSync(join(marked, '.git', 'HEAD')))
  const plain = join(base, 'plain')
  mkdirSync(plain)
  check('a workspace with no .git can make one', inWs(plain, `mkdir '${join(plain, '.git')}'`) && existsSync(join(plain, '.git')))
  check('nor can it make its own directory unreadable to the adapter', !inWs(marked, `chmod 000 '${marked}'`) || (() => { const ok = (statSync(marked).mode & 0o777) !== 0; chmodSync(marked, 0o755); return ok })())
  // An ACL does it as well as a mode, and the harness's skill discovery takes an unreadable .git for none.
  const acl = inWs(marked, `chmod +a "everyone deny search,list" '${marked}'`)
  if (acl) execFileSync('/bin/chmod', ['-N', marked])
  check('nor give it an ACL that denies reading it', !acl)
  check('while files in it are still written', inWs(marked, `echo x > '${join(marked, 'note.md')}'`) && existsSync(join(marked, 'note.md')))
  // Its time is not its readability: tar -C and rsync -a set it, and reported a failure after writing every file.
  check('and its time can be set (tar -C, rsync -a)', inWs(marked, `touch '${marked}'`))
  // Given by a link that sits under the .git, its target elsewhere: the loader climbs the name it was given,
  // and Seatbelt matches the target, so the rule goes on both names.
  const target = realpathSync(mkdtempSync(join(tmpdir(), 'runner-target-')))
  mkdirSync(join(target, '.git'))
  const linked = join(base, 'ws-link')
  symlinkSync(target, linked)
  inWs(linked, `rmdir '${join(linked, '.git')}'`)
  check('a workspace given by a link under the .git keeps its own', existsSync(join(target, '.git')))
  rmSync(target, { recursive: true, force: true })
  // A workspace given as a relative name: the walk up from it never reached "/" and every command hung.
  // (From a directory with no .git: from one with a .git, the walk stopped there at once.)
  const bare = realpathSync(mkdtempSync(join(tmpdir(), 'runner-bare-')))
  mkdirSync(join(bare, 'w2', '.git'), { recursive: true })
  const relative = (() => { try { return execFileSync(RUNNER, ['--ro-bind', '/', '/', '--bind', 'w2', 'w2', '--', '/bin/echo', 'relative-3e4'], { encoding: 'utf8', env, cwd: bare, stdio: 'pipe', timeout: 10000 }) } catch (e) { return `failed: ${e.code ?? e.status}` } })()
  rmSync(bare, { recursive: true, force: true })
  check('a workspace given by a relative name does not hang the runner', relative.includes('relative-3e4'), relative.slice(0, 60))
  rmSync(base, { recursive: true, force: true })
  // With no .git above, the workspace's own .git is not a marker: a home that is a repository can remove it.
  const solo = realpathSync(mkdtempSync(join(tmpdir(), 'runner-solo-')))
  mkdirSync(join(solo, '.git', 'objects'), { recursive: true })
  check('with no .git above, a repository workspace can remove its .git', inWs(solo, `rm -rf '${join(solo, '.git')}'`) && !existsSync(join(solo, '.git')))
  rmSync(solo, { recursive: true, force: true })
}

// A harness home that is itself a link (~/.dsh -> elsewhere). The deny on the link's name blocked reading
// the link, so every path through it failed — the office skill's node, named through ~/.dsh, could not start.
{
  const fakeHome = realpathSync(mkdtempSync(join(tmpdir(), 'runner-linked-')))
  mkdirSync(join(fakeHome, 'dsh-real', 'dsh-runtimes', 'rt'), { recursive: true })
  symlinkSync(join(fakeHome, 'dsh-real'), join(fakeHome, '.dsh'))
  writeFileSync(join(fakeHome, 'dsh-real', 'agent-session-index.db'), 'canary-linked-index-9f0\n')
  writeFileSync(join(fakeHome, 'dsh-real', 'dsh-runtimes', 'rt', 'run.js'), "console.log('linked-ran-0a1')\n")
  const env = { ...process.env, HOME: fakeHome }
  const run = (cmd) => { try { return execFileSync(RUNNER, [...READ_ONLY, '--', ...cmd], { encoding: 'utf8', env, stdio: 'pipe' }) } catch (e) { return `exit ${e.status}: ${String(e.stderr ?? '').slice(0, 80)}` } }
  check('a linked harness home: node runs a script from its runtimes by the link\'s name', run([process.execPath, join(fakeHome, '.dsh', 'dsh-runtimes', 'rt', 'run.js')]).includes('linked-ran-0a1'), run([process.execPath, join(fakeHome, '.dsh', 'dsh-runtimes', 'rt', 'run.js')]).slice(0, 100))
  check('a linked harness home: its index is denied by either name', !run(['/bin/cat', join(fakeHome, '.dsh', 'agent-session-index.db')]).includes('canary-linked') && !run(['/bin/cat', join(fakeHome, 'dsh-real', 'agent-session-index.db')]).includes('canary-linked'))
  rmSync(fakeHome, { recursive: true, force: true })
}

// The profile reaches sandbox-exec inline. It used to be written to a file in TMPDIR — a directory
// confined commands may write — and read back by path, so one running command could rewrite the
// profile another invocation was about to apply. A command inside the runner lists TMPDIR: the
// file used to be there for exactly as long as the command ran.
{
  const tmp = mkdtempSync(join(tmpdir(), 'runner-tmp-'))
  const listed = execFileSync(RUNNER, [...READ_ONLY, '--', '/bin/ls', '-a', tmp], { encoding: 'utf8', env: { ...process.env, TMPDIR: tmp } })
  check('no profile file exists while a command runs', !/deepbot-confine/.test(listed), listed.replace(/\n/g, ' ').trim())
  rmSync(tmp, { recursive: true, force: true })
}

// The user's ssh-agent. launchd hands its socket to the gateway, and a confined command could use
// every key in it — measured on this machine: `ssh-add -l` inside the runner listed the keys. Only
// checked where an agent with keys is reachable from outside the runner.
{
  const profileText = profile([...READ_ONLY, '--', 'true'])
  // Every agent socket, not only launchd's: 1Password's, gpg-agent's, docker's. DNS resolution goes
  // through mDNSResponder's socket, so that one stays open — without it nothing resolves a host.
  check('the profile refuses unix-socket connections', /\(deny network-outbound \(remote unix-socket\)\)/.test(profileText), profileText.split('\n').filter((l) => /unix-socket/.test(l)).join(' | '))
  check('except the resolver\'s, so names still resolve', /allow network-outbound \(remote unix-socket \(path-literal "\/private\/var\/run\/mDNSResponder"\)\)/.test(profileText))
  let outside = false
  try { execFileSync('/usr/bin/ssh-add', ['-l'], { stdio: 'pipe' }); outside = true } catch { /* no agent, or no keys */ }
  if (outside) {
    let inside = true
    try { execFileSync(RUNNER, [...READ_ONLY, '--', '/usr/bin/ssh-add', '-l'], { stdio: 'pipe' }) } catch { inside = false }
    check('a command inside the runner cannot reach the ssh-agent', !inside)
  }
}

// The workspace's own .env cannot be written: the harness's credential chain reads <cwd>/.env before
// the deployment's, and the gateway's cwd is this workspace.
{
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'runner-ws-')))
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--die-with-parent', '--tmpfs', '/tmp', '--bind', ws, ws]
  const run = (cmd) => { try { execFileSync(RUNNER, [...args, '--', '/bin/sh', '-c', cmd], { stdio: 'pipe' }); return true } catch { return false } }
  run(`touch ${ws}/.env`)
  run(`echo X=1 > ${ws}/.env.local`)
  run(`touch ${ws}/notes.md`)
  check('a command cannot create the workspace .env', !existsSync(join(ws, '.env')))
  check('nor a .env variant', !existsSync(join(ws, '.env.local')))
  check('and can still write anything else there', existsSync(join(ws, 'notes.md')))
  rmSync(ws, { recursive: true, force: true })
}

// The command's own temp directory. The rule named /var/folders, which Seatbelt never matches (it matches
// /private/var/folders), so a command could make no temp file in its TMPDIR: a browser's profile, mktemp, Python's
// tempfile. Opening the user's temp itself let a command rewrite what unconfined processes keep there (an update's
// installer, other programs' sockets), so each workspace gets a directory of its own inside it and TMPDIR points there.
{
  const userTemp = execFileSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).trim().replace(/\/$/, '')
  const userCache = execFileSync('/usr/bin/getconf', ['DARWIN_USER_CACHE_DIR'], { encoding: 'utf8' }).trim().replace(/\/$/, '')
  const ws = mkdtempSync(join(realpathSync(tmpdir()), 'ws-tmp-'))
  const ws2 = mkdtempSync(join(realpathSync(tmpdir()), 'ws-tmp2-'))
  // A path's real name, or the path itself when there is nothing there: a check must fail, not stop the suite.
  const real = (path) => { try { return realpathSync(path) } catch { return path } }
  const own = (workspace) => join(userTemp, `deepbot-cmd-${createHash('sha256').update(realpathSync(workspace)).digest('hex').slice(0, 16)}`)
  // Run `script` under the runner for `workspace`; what it prints, or null when it failed.
  const inside = (workspace, script, env = {}) => {
    try {
      return execFileSync(RUNNER, ['--ro-bind', '/', '/', '--die-with-parent', '--tmpfs', '/tmp', '--bind', workspace, workspace, '--', '/bin/sh', '-c', script], { encoding: 'utf8', env: { ...process.env, ...env }, stdio: 'pipe' }).trim()
    } catch { return null }
  }
  // As programs make one: in $TMPDIR (Node's os.tmpdir(), Python's tempfile, `mktemp "$TMPDIR…"`). macOS's mktemp with
  // no template goes to the system's temp directory instead, which stays closed.
  const made = inside(ws, 'f=$(mktemp "${TMPDIR}probe.XXXXXX") && echo "$f" && rm -f "$f"')
  check('a command makes a temp file where its TMPDIR points', made !== null && made !== '', String(made).replace(/\/var\/folders\/[^/]+\/[^/]+/, '/var/folders/…'))
  const byNode = inside(ws, `'${process.execPath}' -e "const fs=require('fs'),os=require('os');const d=fs.mkdtempSync(os.tmpdir()+'/n-');console.log(d);fs.rmSync(d,{recursive:true})"`)
  check('so does Node, through os.tmpdir() (a browser\'s profile is made this way)', byNode !== null && byNode.startsWith(own(ws)), String(byNode).replace(/\/var\/folders\/[^/]+\/[^/]+/, '/var/folders/…'))
  check('and that is its workspace\'s own directory in the user\'s temp', made !== null && real(dirname(made)) === real(own(ws)), String(made).replace(/\/var\/folders\/[^/]+\/[^/]+/, '/var/folders/…'))
  check('the user\'s temp itself stays closed (an update\'s installer, other programs\' sockets)', inside(ws, `mktemp '${userTemp}/runner-probe.XXXXXX'`) === null)
  check('and so do their caches', inside(ws, `mktemp '${userCache}/runner-probe.XXXXXX'`) === null)
  const other = inside(ws2, 'echo "$TMPDIR"')
  check('another workspace gets another directory', other !== null && real(other) === real(own(ws2)) && own(ws2) !== own(ws), String(other).replace(/\/var\/folders\/[^/]+\/[^/]+/, '/var/folders/…'))
  // One workspace's temp files are its own: another workspace (a tenant) cannot read them; it can read its own.
  const kept = inside(ws, 'f=$(mktemp "${TMPDIR}kept.XXXXXX") && echo secret-7d2 > "$f" && echo "$f"')
  check('a workspace reads its own temp files', kept !== null && inside(ws, `cat '${kept}'`) === 'secret-7d2')
  check('another workspace cannot read them', kept !== null && inside(ws2, `cat '${kept}'`) === null)
  // TMPDIR is whoever started the command's to set: pointed elsewhere, it opens nothing and is replaced.
  const elsewhere = mkdtempSync(join(HOME, '.runner-tmp-'))
  check('a TMPDIR given to the runner is replaced, and opens nothing', inside(ws, 'echo "$TMPDIR"', { TMPDIR: elsewhere }) !== null
    && real(String(inside(ws, 'echo "$TMPDIR"', { TMPDIR: elsewhere }))) === real(own(ws))
    && inside(ws, `mktemp '${elsewhere}/runner-probe.XXXXXX'`, { TMPDIR: elsewhere }) === null)
  // A link left at the directory's name is not taken for it: TMPDIR is not pointed through it.
  const ws3 = mkdtempSync(join(realpathSync(tmpdir()), 'ws-tmp3-'))
  rmSync(own(ws3), { recursive: true, force: true })
  symlinkSync(elsewhere, own(ws3))
  check('a link left at its name is not used', inside(ws3, `mktemp '${elsewhere}/runner-probe.XXXXXX'`) === null && !String(inside(ws3, 'echo "$TMPDIR"')).startsWith(own(ws3)))
  rmSync(own(ws3), { force: true })
  for (const dir of [ws, ws2, ws3, elsewhere, own(ws), own(ws2)]) rmSync(dir, { recursive: true, force: true })
}

// The agent's commands' network (commandNetwork). With the gateway's proxy written for this home, a command connects out
// only through it: Seatbelt holds outbound connections to this machine, and the proxy's address is in the command's
// environment. Without the file nothing changes; a file that names no port shuts the network rather than opening it.
{
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  const agentHome = mkdtempSync(join(tmpdir(), 'agent-home-'))
  const key = createHash('sha256').update(realpathSync(agentHome)).digest('hex').slice(0, 16)
  const file = join(dshHome, 'deepbot', 'command-network', `${key}.json`)
  const env = { ...process.env, DSH_HOME: dshHome, DEEPBOT_HOME: agentHome }
  const policy = [...READ_ONLY, '--tmpfs', '/tmp', '--bind', agentHome, agentHome]
  const printed = () => execFileSync(RUNNER, ['--print-profile', ...policy, '--', 'true'], { encoding: 'utf8', env })
  check('network: without the gateway\'s proxy, commands connect as before', !/network-outbound \(remote ip/.test(printed()))
  // That name, brought by whoever started the command, is dropped: unbounded, there is no commands' proxy to name.
  const brought = execFileSync(RUNNER, [...policy, '--', '/usr/bin/env'], { encoding: 'utf8', env: { ...env, DEEPBOT_COMMAND_PROXY: 'http://127.0.0.1:7890' } })
  check('network: a commands\' proxy named by the caller is not passed on', !/^DEEPBOT_COMMAND_PROXY=/m.test(brought))
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ port: 18999, mode: 'public', pid: process.pid }))
  const bounded = printed()
  check('network: with it, outbound connections are held to the proxy\'s port, not every port here', bounded.includes('(deny network-outbound (remote ip))') && bounded.includes('(allow network-outbound (remote ip "localhost:18999"))') && !bounded.includes('localhost:*'), bounded.split('\n').filter((l) => l.includes('network')).join(' | '))
  const seen = execFileSync(RUNNER, [...policy, '--', '/usr/bin/env'], { encoding: 'utf8', env })
  check('network: the browse tool is told it is the commands\' proxy, by the name only this runner sets', /^DEEPBOT_COMMAND_PROXY=http:\/\/127\.0\.0\.1:18999$/m.test(seen), seen.split('\n').filter((l) => /DEEPBOT_COMMAND/.test(l)).join(' | '))
  check('network: and the command is told the proxy, with nothing exempt from it', /^https_proxy=http:\/\/127\.0\.0\.1:18999$/m.test(seen) && /^HTTPS_PROXY=http:\/\/127\.0\.0\.1:18999$/m.test(seen) && /^http_proxy=http:\/\/127\.0\.0\.1:18999$/m.test(seen) && /^NODE_USE_ENV_PROXY=1$/m.test(seen) && !/^no_proxy=/im.test(seen), seen.split('\n').filter((l) => /proxy/i.test(l)).join(' | '))
  // A direct connection elsewhere is refused by the sandbox at once, not left to time out; and so is one to a service on
  // this machine other than the proxy (seen live: with every port here open, curl reached a local page around it).
  const connectTo = (host: string, port: number) => spawnSync(RUNNER, [...policy, '--', process.execPath, '-e', `require('net').connect(${port}, '${host}').on('error', (e) => { console.log(e.code); process.exit(0) }).on('connect', () => { console.log('connected'); process.exit(0) })`], { encoding: 'utf8', timeout: 15_000, env: { ...env, NO_PROXY: 'localhost' } })
  const direct = connectTo('192.0.2.1', 80)
  check('network: a direct connection elsewhere is refused', /EPERM|EACCES/.test(direct.stdout), `${direct.stdout}${direct.stderr}`.trim().slice(0, 160))
  const localService = createServer((socket) => socket.end())
  await new Promise<void>((done) => localService.listen(0, '127.0.0.1', done))
  const around = connectTo('127.0.0.1', (localService.address() as { port: number }).port)
  check('network: a service on this machine other than the proxy is refused too', /EPERM|EACCES/.test(around.stdout), `${around.stdout}${around.stderr}`.trim().slice(0, 160))
  localService.close()
  const exempt = execFileSync(RUNNER, [...policy, '--', '/usr/bin/env'], { encoding: 'utf8', env: { ...env, NO_PROXY: 'localhost', no_proxy: '*' } })
  check('network: an exemption from the proxy the caller set is dropped', !/^no_proxy=/im.test(exempt), exempt.split('\n').filter((l) => /no_proxy/i.test(l)).join(' | '))
  // Around the proxy by other means (found by review): a name lookup carries data out through the system's resolver;
  // another app, started or scripted, fetches outside the sandbox. Bounded, the resolver's socket is not open, nor
  // LaunchServices, and the tools that drive other apps do not run.
  check('network: names are not looked up around the proxy', !bounded.includes('mDNSResponder') && /mDNSResponder/.test(execFileSync(RUNNER, ['--print-profile', ...policy, '--', 'true'], { encoding: 'utf8', env: { ...process.env, DEEPBOT_HOME: agentHome, DSH_HOME: join(dshHome, 'none') } })))
  const lookup = spawnSync(RUNNER, [...policy, '--', process.execPath, '-e', "require('dns').lookup('example.com', (e) => console.log(e ? e.code : 'resolved'))"], { encoding: 'utf8', env, timeout: 15_000 })
  check('network: a lookup fails', /ENOTFOUND|EAI_|ESERVFAIL/.test(lookup.stdout), `${lookup.stdout}${lookup.stderr}`.trim().slice(0, 120))
  const scripted = spawnSync(RUNNER, [...policy, '--', '/usr/bin/osascript', '-e', 'return 1'], { encoding: 'utf8', env, timeout: 15_000 })
  check('network: an app is not scripted', scripted.status !== 0 && !/^1$/m.test(scripted.stdout), `${scripted.status} ${scripted.stderr.trim().slice(0, 100)}`)
  check('network: nor started, and LaunchServices is closed', /^\(deny process-exec .*\(literal "\/usr\/bin\/open"\)/m.test(bounded) && /launchservicesd/.test(bounded), bounded.split('\n').filter((l) => /process-exec|launchservices/.test(l)).join(' | '))
  // A file whose gateway has gone (its pid not running): the port may be someone else's by now.
  writeFileSync(file, JSON.stringify({ port: 18999, mode: 'public', pid: 999_999_9 }))
  const orphan = execFileSync(RUNNER, [...policy, '--', '/usr/bin/env'], { encoding: 'utf8', env })
  check('network: a gateway that has gone leaves no port to connect to', !printed().includes('localhost:18999') && !/^https_proxy=/m.test(orphan))
  // A port out of range is no port: the number is checked, not only found.
  writeFileSync(file, JSON.stringify({ port: 99999, mode: 'public' }))
  const garbled = printed()
  const garbledEnv = execFileSync(RUNNER, [...policy, '--', '/usr/bin/env'], { encoding: 'utf8', env })
  check('network: a file that names no port leaves commands no connection, and no proxy', garbled.includes('(deny network-outbound (remote ip))') && !/^https_proxy=/m.test(garbledEnv))
  rmSync(file)
  // A link to a file that names a port: followed, it would point commands wherever the link's target says.
  writeFileSync(join(dshHome, 'elsewhere.json'), JSON.stringify({ port: 18998, mode: 'open' }))
  symlinkSync(join(dshHome, 'elsewhere.json'), file)
  check('network: a link at its name is not read', printed().includes('(deny network-outbound (remote ip))') && !/^https_proxy=/m.test(execFileSync(RUNNER, [...policy, '--', '/usr/bin/env'], { encoding: 'utf8', env })))
  for (const dir of [dshHome, agentHome]) rmSync(dir, { recursive: true, force: true })
}

// The user's desktop is not the agent's (decided against: PLAN.md). Its commands scripted other apps (osascript,
// automator, shortcuts), started them (open) and could take the screen (screencapture) unless the network was bounded,
// and read and replaced what the user had copied, often a password, in every mode. None of it runs now, in any mode.
{
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  const agentHome = mkdtempSync(join(tmpdir(), 'agent-home-'))
  const env = { ...process.env, DSH_HOME: dshHome, DEEPBOT_HOME: agentHome }
  const policy = [...READ_ONLY, '--tmpfs', '/tmp', '--bind', agentHome, agentHome]
  const text = execFileSync(RUNNER, ['--print-profile', ...policy, '--', 'true'], { encoding: 'utf8', env })
  check('desktop: the network is not bounded here, so nothing below is the bound\'s doing', !/network-outbound \(remote ip/.test(text))
  // Where no pasteboard can be reached (no login session) the behaviour below cannot be seen, so the rule is read too.
  check('desktop: the pasteboard service is closed', text.includes('(deny mach-lookup (global-name-regex #"^com\\.apple\\.pasteboard\\."))'))
  const run = (argv: string[], input = '') => spawnSync(RUNNER, [...policy, '--', ...argv], { encoding: 'utf8', env, input, timeout: 15_000 })
  // Each with arguments that only print its usage, should the refusal be missing: nothing is scripted, started or taken.
  // osacompile would make an app that scripts others (found by review): here it compiles a script into the home.
  for (const argv of [['/usr/bin/osascript', '-e', 'return 1'], ['/usr/bin/osacompile', '-o', join(agentHome, 'probe.scpt'), '-e', 'return 1'], ['/usr/bin/automator'], ['/usr/bin/shortcuts'], ['/usr/bin/open'], ['/usr/sbin/screencapture', '-h']]) {
    const tool = run(argv)
    check(`desktop: ${argv[0]} does not run`, tool.status !== 0 && /not permitted/i.test(tool.stderr), `${tool.status} ${tool.stderr.trim().slice(0, 100)}`)
  }
  // LaunchServices is closed in every mode too, not only with the network bounded (found by the final review): open, a
  // program the agent compiled could start an app outside the sandbox, and lsappinfo showed which apps the user had
  // open and which was in front.
  check('desktop: LaunchServices is closed with the network open', /\(deny mach-lookup \(global-name-regex #"\^com\\\.apple\\\.coreservices\\\.launchservicesd"\)/.test(text), text.split('\n').filter((l) => /launchservices/.test(l)).join(' | ') || '(no rule)')
  const front = spawnSync('/usr/bin/lsappinfo', ['front'], { encoding: 'utf8' }).stdout.trim()
  if (/^ASN:/.test(front)) {
    const seen = run(['/usr/bin/lsappinfo', 'front'])
    check('desktop: which app is in front is not seen', !/ASN:/.test(seen.stdout), seen.stdout.trim().slice(0, 60))
  } else console.log('  TODO  desktop: no front app here (no login session); the LaunchServices check did not run')
  // The ruler pasteboard, which nothing uses, rather than the user's clipboard: the same service holds both.
  const marker = `deepbot-${process.pid}-${Date.now()}`
  const shown = () => spawnSync('/usr/bin/pbpaste', ['-pboard', 'ruler'], { encoding: 'utf8' }).stdout
  const put = spawnSync('/usr/bin/pbcopy', ['-pboard', 'ruler'], { input: marker })
  if (put.status === 0 && shown() === marker) {
    const read = run(['/usr/bin/pbpaste', '-pboard', 'ruler'])
    check('desktop: what the user copied is not read', !read.stdout.includes(marker), read.stdout.slice(0, 60))
    run(['/usr/bin/pbcopy', '-pboard', 'ruler'], 'from the agent')
    check('desktop: nor replaced', shown() === marker)
    spawnSync('/usr/bin/pbcopy', ['-pboard', 'ruler'], { input: '' })
  } else console.log('  TODO  desktop: no pasteboard here (no login session); the clipboard checks did not run')
  for (const dir of [dshHome, agentHome]) rmSync(dir, { recursive: true, force: true })
}

// The user's credentials are not the agent's: its commands read ~/.ssh's private keys, the cloud CLIs' tokens and the
// gh token, though the ssh-agent socket was already refused. A home of its own, so nothing real is touched.
{
  const fakeHome = realpathSync(mkdtempSync(join(tmpdir(), 'user-home-')))
  const agentHome = join(fakeHome, 'dsh-agent')
  mkdirSync(agentHome)
  const places = ['.ssh/id_ed25519', '.aws/credentials', '.gnupg/private-keys-v1.d/k.key', 'Library/Keychains/login.keychain-db', '.config/gh/hosts.yml', '.config/gcloud/credentials.db', '.azure/msal_token_cache.json', '.kube/config', '.netrc', '.git-credentials']
  for (const place of places) {
    mkdirSync(dirname(join(fakeHome, place)), { recursive: true })
    writeFileSync(join(fakeHome, place), 'secret-9f1')
  }
  writeFileSync(join(fakeHome, 'notes.txt'), 'ordinary-3c7')
  const env = { ...process.env, HOME: fakeHome, DEEPBOT_HOME: agentHome }
  const policy = [...READ_ONLY, '--tmpfs', '/tmp', '--bind', agentHome, agentHome]
  for (const place of places) {
    const read = spawnSync(RUNNER, [...policy, '--', '/bin/cat', join(fakeHome, place)], { encoding: 'utf8', env, timeout: 15_000 })
    check(`credentials: ~/${place} is not read`, !read.stdout.includes('secret-9f1'), `${read.status} ${read.stderr.trim().slice(0, 100)}`)
  }
  const ordinary = spawnSync(RUNNER, [...policy, '--', '/bin/cat', join(fakeHome, 'notes.txt')], { encoding: 'utf8', env, timeout: 15_000 })
  check('credentials: an ordinary file in the user\'s home is still read', ordinary.stdout.includes('ordinary-3c7'), `${ordinary.status} ${ordinary.stderr.trim().slice(0, 100)}`)
  rmSync(fakeHome, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
