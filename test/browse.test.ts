/**
 * The browse tool: a page that draws itself with JavaScript, clicks and typing, and what it refuses to open.
 * web_fetch takes a page's HTML as it arrives, so such a page came back empty and nothing could be clicked.
 *
 * The argument parsing, the refusals and the output's shape are checked everywhere. The browser itself runs only
 * where one is installed (`node node_modules/playwright-core/cli.js install chromium-headless-shell`); elsewhere
 * the suite says the live checks did not run.
 *
 * Run: node test/browse.test.ts
 */
import './dist-fresh.ts'   // fails loudly on a stale dist
import { execFileSync, spawn } from 'node:child_process'
import { createServer, request } from 'node:http'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { keepSession, loadSession, opensPrivate, parseArgs, refusal, shape, signIn } from '../dist/tools/browse.js'
import { startPolicyProxy } from '../dist/netPolicy.js'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// The arguments: an address, and the steps in the order given.
const asked = parseArgs(['https://example.com/a', '--type', '#q', '두 단어', '--click', 'text=Go', '--wait', '500', '--max', '100'])
check('the address and the steps, in order', !('error' in asked) && asked.url === 'https://example.com/a'
  && JSON.stringify(asked.steps) === JSON.stringify([{ kind: 'type', selector: '#q', text: '두 단어' }, { kind: 'click', selector: 'text=Go' }])
  && asked.waitMs === 500 && asked.max === 100, JSON.stringify(asked))
// A selector with its own "=", and text with one: neither is split.
const typedEquals = parseArgs(['https://e.x', '--type', 'input[name=q]', 'a=b'])
check('a selector and a text with "=" in them are kept whole', !('error' in typedEquals)
  && JSON.stringify(typedEquals.steps) === JSON.stringify([{ kind: 'type', selector: 'input[name=q]', text: 'a=b' }]), JSON.stringify(typedEquals))
// A signed-in session: kept in a file given with --state, read before the steps and written after. --login opens a
// window for the person to sign in, and needs the file it is kept in.
const withState = parseArgs(['https://e.x/inbox', '--state', '/tmp/x/mail.json'])
check('--state names the file a session is kept in', !('error' in withState) && withState.state === '/tmp/x/mail.json' && withState.login === false, JSON.stringify(withState))
const loginNoState = parseArgs(['--login', 'https://e.x/'])
check('--login without --state is refused: the session would go nowhere', 'error' in loginNoState && /--login needs --state/.test(loginNoState.error), JSON.stringify(loginNoState))
const loginSteps = parseArgs(['--login', 'https://e.x/', '--state', '/tmp/s.json', '--click', '#go'])
check('--login takes no steps: the person does them', 'error' in loginSteps && /--login takes no steps/.test(loginSteps.error), JSON.stringify(loginSteps))
check('a long wait is held to 30 s', !('error' in parseArgs(['https://e.x', '--wait', '600000'])) && (parseArgs(['https://e.x', '--wait', '600000']) as { waitMs: number }).waitMs === 30_000)
for (const [args, why] of [
  [[], 'no address'], [['--click'], 'needs a value'], [['https://e.x', '--type', '#q'], 'needs a value'],
  [['https://e.x', '--max', '0'], '--max'], [['https://e.x', '--bogus'], 'unknown option'], [['https://a.x', 'https://b.x'], 'one address'],
] as const) {
  const parsed = parseArgs(args)
  check(`refused arguments: ${JSON.stringify(args)}`, 'error' in parsed && parsed.error.includes(why), JSON.stringify(parsed))
}

// What page is not opened: one that is not http or https, and a cloud metadata service by name. What the page loads
// afterwards is checked by address, by the proxy (test/net-policy.test.ts), and live below.
check('an https page is opened', refusal('https://example.com/x') === null)
check('a loopback page is opened (a self-hosted page is legitimate)', refusal('http://127.0.0.1:8899/page.html') === null)
check('a file page is refused', /only http and https/.test(String(refusal('file:///etc/passwd'))))
check('a javascript: page is refused', refusal('javascript:alert(1)') !== null)
check('something that is not an address is refused', /is not an address/.test(String(refusal('not a url'))))
for (const address of ['http://169.254.169.254/latest/meta-data/', 'http://metadata.google.internal./', 'http://[FD00:EC2:0::254]/', 'http://100.100.100.200/', 'http://169.254.10.10/']) {
  check(`a metadata service is refused: ${address}`, /metadata/.test(String(refusal(address))))
}

// Whether what the page loads may be private: only when the page itself is.
const at = (...addresses: string[]) => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
check('a page on this machine may load from private addresses', opensPrivate(at('127.0.0.1')) && opensPrivate(at('::1')) && opensPrivate(at('10.0.0.5')))
check('a public page may not', !opensPrivate(at('93.184.216.34')) && !opensPrivate(at('2606:4700:4700::1111')) && !opensPrivate(at()))
check('a metadata address does not count as private', !opensPrivate(at('169.254.169.254')))
// A name with a public address and a private one is a public page: it is fetched from the first, which its owner
// chose, and that page must not reach this machine.
check('a name with a public address among private ones is a public page', !opensPrivate(at('93.184.216.34', '10.0.0.5')) && !opensPrivate(at('127.0.0.1', '93.184.216.34')))
{
  const inside = createServer((_req, res) => { res.end('SECRET-INTERNAL') })
  await new Promise<void>((resolve) => inside.listen(0, '127.0.0.1', resolve))
  const port = (inside.address() as { port: number }).port
  const mixed = at('93.184.216.34', '127.0.0.1')
  const proxy = await startPolicyProxy(opensPrivate(mixed), async (host) => host === 'mixed.example' ? mixed : at(host))
  const got = await new Promise<string>((resolve) => {
    const req = request({ host: '127.0.0.1', port: proxy.port, path: `http://127.0.0.1:${port}/`, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      let body = ''
      res.on('data', (d) => { body += d })
      res.on('end', () => resolve(`${res.statusCode} ${body}`))
    })
    req.on('error', (e) => resolve(String(e)))
    req.end()
  })
  check('so its page cannot reach this machine through the proxy', got.startsWith('403') && !got.includes('SECRET'), got)
  await proxy.close()
  inside.close()
}

// Keeping a session, without a browser. Never through a link: the agent can leave one at the file's name, or make its
// directory one, and --login writes as the person, outside the sandbox (found by review: a link at the name made a run
// overwrite the file it pointed at). Written whole, mode 600, the one before kept as .prev.
{
  const dir = mkdtempSync(join(tmpdir(), 'browse-keep-'))
  const file = join(dir, '.browser', 'site.json')
  keepSession(file, { cookies: [{ name: 'a' }], origins: [] })
  keepSession(file, { cookies: [{ name: 'b' }], origins: [] })
  // Mode bits are POSIX: Windows reports 666 for any file it can write.
  check('keepSession: written mode 600, the one before kept as .prev', (process.platform === 'win32' || (statSync(file).mode & 0o777) === 0o600) && readFileSync(file, 'utf8').includes('"b"') && existsSync(`${file}.prev`) && readFileSync(`${file}.prev`, 'utf8').includes('"a"'), (statSync(file).mode & 0o777).toString(8))
  const victim = join(dir, 'victim.txt')
  writeFileSync(victim, 'untouched')
  const linked = join(dir, '.browser', 'linked.json')
  symlinkSync(victim, linked)
  let throughName = ''
  try { keepSession(linked, { cookies: [], origins: [] }) } catch (e) { throughName = String((e as Error).message) }
  check('keepSession: a link at the name is refused, and what it points at is untouched', /is a link/.test(throughName) && readFileSync(victim, 'utf8') === 'untouched' && lstatSync(linked).isSymbolicLink(), throughName)
  const elsewhere = mkdtempSync(join(tmpdir(), 'browse-elsewhere-'))
  symlinkSync(elsewhere, join(dir, 'linkdir'))
  let throughDir = ''
  try { keepSession(join(dir, 'linkdir', 'site.json'), { cookies: [], origins: [] }) } catch (e) { throughDir = String((e as Error).message) }
  check('keepSession: a directory that is a link is refused', /is a link/.test(throughDir) && !existsSync(join(elsewhere, 'site.json')), throughDir)
  check('loadSession: none yet is null', loadSession(join(dir, '.browser', 'new.json')) === null)
  const kept = loadSession(file)
  check('loadSession: a kept session is read', kept !== null && 'session' in kept && kept.session.cookies.length === 1, JSON.stringify(kept))
  check('loadSession: a link is refused', JSON.stringify(loadSession(linked)).includes('is a link'))
  // A pipe at the name: read, it waited for a writer for ever and held the agent's command (or the person's terminal).
  if (process.platform !== 'win32') {
    const pipe = join(dir, '.browser', 'pipe.json')
    execFileSync('mkfifo', [pipe])
    check('loadSession: something that is not a plain file is refused, not read', JSON.stringify(loadSession(pipe)).includes('is not a plain file'))
  }
  for (const [name, body] of [['empty.json', '{}'], ['list.json', '[]'], ['broken.json', 'not json']]) {
    const bad = join(dir, '.browser', name)
    writeFileSync(bad, body)
    const loaded = loadSession(bad)
    check(`loadSession: ${body} is not a kept session, and the message says what to do`, loaded !== null && 'error' in loaded && /not a kept session: delete it, and sign in again with --login/.test(loaded.error), JSON.stringify(loaded))
  }
  rmSync(elsewhere, { recursive: true, force: true })
  rmSync(dir, { recursive: true, force: true })
}

// The output: title, address, the text tidied, and a cut that says so.
const printed = shape('Title', 'https://e.x/', 'one  \n\n\n\ntwo', 100)
check('the text is tidied under its title and address', printed === 'title: Title\nurl: https://e.x/\n\none\n\ntwo', JSON.stringify(printed))
const cut = shape('T', 'u', 'x'.repeat(50), 10)
check('a long text is cut, and the cut says by how much', cut.endsWith('x'.repeat(10) + '\n\n[… 40 more characters; --max to see more]'), cut.slice(-60))
check('a page with no text says so', shape('T', 'u', '  \n ', 10).endsWith('(the page shows no text)'))

// The browser itself, where there is one.
const tool = fileURLToPath(new URL('../dist/tools/browse.js', import.meta.url))
const run = (args: string[]) => new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
  const child = spawn(process.execPath, [tool, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { err += d })
  child.on('close', (code) => resolve({ code, out, err }))
})
const ready = await run(['--check'])
if (ready.code !== 0) {
  console.log(`  TODO  no browser here (${ready.err.trim().split('\n')[0].slice(0, 120)}): the live checks did not run`)
} else {
  const pages: Record<string, string> = {
    // The text arrives after load, from a request the page makes: an HTTP fetch of this page has none of it.
    '/js': '<!doctype html><title>Drawn</title><body><p id="out">loading</p><script>fetch("/data").then((r) => r.text()).then((t) => { document.getElementById("out").textContent = t })</script></body>',
    '/data': '배포 코드명 NEBULA-41c7',
    '/form': '<!doctype html><title>Form</title><body><input id="q"><button onclick="document.getElementById(\'r\').textContent = \'you typed \' + document.getElementById(\'q\').value">Go</button><p id="r"></p></body>',
    // A click whose result comes from a request: read before the request answers, the page still shows nothing.
    '/later': '<!doctype html><title>Later</title><body><button onclick="setTimeout(() => fetch(\'/slow\').then((r) => r.text()).then((t) => { document.getElementById(\'r\').textContent = t }), 150)">Show</button><p id="r"></p></body>',
    '/away': '<!doctype html><title>Away</title><body><a id="go" href="http://169.254.169.254/latest/meta-data/">credentials</a></body>',
    // Ways a page reaches an address without asking for it by name: a redirect (of the page, of a frame), a window it
    // opens, a socket.
    '/framed': '<!doctype html><title>Framed</title><body><p>the frame is below</p><iframe src="/to-metadata"></iframe></body>',
    '/popup': '<!doctype html><title>Popup</title><body><button onclick="window.open(\'http://169.254.169.254/latest/meta-data/popup\')">Open</button></body>',
    '/socket': '<!doctype html><title>Socket</title><body><p>a socket was opened</p><script>new WebSocket("ws://169.254.169.254/socket")</script></body>',
    // A request its server never answers (a long poll): the tool reads the page and ends, not when the server lets go.
    '/held': '<!doctype html><title>Held</title><body><p>still polling</p><script>fetch("/hold")</script></body>',
  }
  const sid = `sess-${Math.random().toString(36).slice(2, 10)}`
  const server = createServer((req, res) => {
    if (req.url === '/slow') { setTimeout(() => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('arrived-3e8') }, 400); return }
    if (req.url === '/to-metadata') { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/redirected' }).end(); return }
    if (req.url === '/hop') { res.writeHead(302, { location: '/js' }).end(); return }
    if (req.url === '/hold') return
    // A site that remembers who signed in by a cookie, as one does.
    if (req.url === '/set') { res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': `sid=${sid}; HttpOnly; Path=/` }).end('<title>In</title><p>signed in</p>'); return }
    // A page that fails and changes the session on the way: a failed run must not keep what it did.
    if (req.url === '/broken') { res.writeHead(500, { 'content-type': 'text/html', 'set-cookie': 'sid=changed-by-error; Path=/' }).end('<title>Error</title><p>server error</p>'); return }
    if (req.url === '/logout') { res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'sid=; Max-Age=0; Path=/' }).end('<title>Out</title><p>signed out</p>'); return }
    if (req.url === '/whoami') { res.writeHead(200, { 'content-type': 'text/html' }).end(`<title>Who</title><p>session: ${/sid=([\w-]+)/.exec(req.headers.cookie ?? '')?.[1] ?? 'none'}</p>`); return }
    const body = pages[req.url ?? ''] ?? null
    res.writeHead(body === null ? 404 : 200, { 'content-type': req.url === '/data' ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8' })
    res.end(body ?? 'not here')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const drawn = await run([`${base}/js`])
  check('a page drawn by JavaScript is read as it shows', drawn.code === 0 && drawn.out.includes('NEBULA-41c7') && drawn.out.includes('title: Drawn'), drawn.out.slice(0, 160) + drawn.err.slice(0, 160))
  const typed = await run([`${base}/form`, '--type', '#q', 'hello', '--click', 'text=Go'])
  check('it types and clicks, in order, and reads the result', typed.code === 0 && typed.out.includes('you typed hello'), typed.out.slice(0, 160) + typed.err.slice(0, 160))
  const later = await run([`${base}/later`, '--click', 'text=Show'])
  check('a click whose result comes from a request is read once it has come', later.code === 0 && later.out.includes('arrived-3e8'), later.out.slice(0, 160))
  const missing = await run([`${base}/form`, '--click', '#nothing'])
  check('a step that finds nothing fails, and still shows the page', missing.code === 4 && missing.out.includes('title: Form') && /browse: /.test(missing.err), `${missing.code} ${missing.err.slice(0, 120)}`)
  // Leaving for the metadata service is stopped by the tool, not by the network, and said; the page it ends on is the
  // browser's error page, so the run fails.
  const away = await run([`${base}/away`, '--click', '#go'])
  check('a click that leads to a metadata service is blocked by the tool, and said', away.code === 4 && /blocked "http:\/\/169\.254\.169\.254\/latest\/meta-data\/": 169\.254\.169\.254 is a cloud metadata service/.test(away.out) && /answered 403/.test(away.err), (away.out + away.err).slice(0, 300))
  // Each hop of a redirect is checked: Chromium follows one itself, and an interception that saw the first request
  // never saw the second.
  const redirected = await run([`${base}/to-metadata`])
  check('a page that redirects to a metadata service is blocked, and said', redirected.code === 4 && /blocked "http:\/\/169\.254\.169\.254\/latest\/meta-data\/redirected"/.test(redirected.out), (redirected.out + redirected.err).slice(0, 300))
  const framed = await run([`${base}/framed`])
  check('a frame that redirects to a metadata service is blocked, and the page is still read', framed.code === 0 && framed.out.includes('the frame is below') && /blocked "http:\/\/169\.254\.169\.254\/latest\/meta-data\/redirected"/.test(framed.out), (framed.out + framed.err).slice(0, 300))
  const hop = await run([`${base}/hop`])
  check('a redirect to an allowed address is followed', hop.code === 0 && hop.out.includes('NEBULA-41c7'), (hop.out + hop.err).slice(0, 200))
  const popup = await run([`${base}/popup`, '--click', 'text=Open'])
  check('a window the page opens is held to the same rule', /blocked "http:\/\/169\.254\.169\.254\/latest\/meta-data\/popup"/.test(popup.out), (popup.out + popup.err).slice(0, 300))
  const socket = await run([`${base}/socket`])
  check('a socket the page opens is held to the same rule', socket.out.includes('a socket was opened') && /blocked "169\.254\.169\.254:80"/.test(socket.out), (socket.out + socket.err).slice(0, 300))
  const heldFrom = Date.now()
  const held = await run([`${base}/held`])
  const heldFor = Date.now() - heldFrom
  check('a page that leaves a request waiting is read, and the tool ends', held.code === 0 && held.out.includes('still polling') && heldFor < 30_000, `${held.code} after ${heldFor} ms`)
  // A session kept between runs: the first signs in and writes the file (only the user may read it); the second reads
  // it and is still signed in. The control, without --state, is not.
  const sessions = mkdtempSync(join(tmpdir(), 'browse-state-'))
  const stateFile = join(sessions, '.browser', 'site.json')
  const firstRun = await run([`${base}/set`, '--state', stateFile])
  const kept = existsSync(stateFile) ? readFileSync(stateFile, 'utf8') : ''
  check('--state: the session is written after the run, for the user alone', firstRun.code === 0 && kept.includes(sid) && (process.platform === 'win32' || (statSync(stateFile).mode & 0o777) === 0o600), `${firstRun.code} ${existsSync(stateFile) ? (statSync(stateFile).mode & 0o777).toString(8) : 'no file'} ${firstRun.err.slice(0, 120)}`)
  // A file left readable by others is made the user's alone again when it is written.
  if (existsSync(stateFile)) chmodSync(stateFile, 0o644)
  const again = await run([`${base}/whoami`, '--state', stateFile])
  check('--state: the next run is still signed in', again.code === 0 && again.out.includes(`session: ${sid}`), again.out.slice(0, 200))
  check('--state: a file others could read is the user\'s alone again', existsSync(stateFile) && (process.platform === 'win32' || (statSync(stateFile).mode & 0o777) === 0o600), existsSync(stateFile) ? (statSync(stateFile).mode & 0o777).toString(8) : 'no file')
  const anonymous = await run([`${base}/whoami`])
  check('without --state a run is signed out', anonymous.code === 0 && anonymous.out.includes('session: none'), anonymous.out.slice(0, 200))
  // A run that failed leaves the kept session as it was: an error page is no reason to replace a good one.
  const beforeFailed = readFileSync(stateFile, 'utf8')
  const failedRun = await run([`${base}/broken`, '--state', stateFile])
  check('--state: a failed run leaves the kept session as it was', failedRun.code === 4 && readFileSync(stateFile, 'utf8') === beforeFailed, `${failedRun.code}`)
  // One that ends signed out is said, with the session before it kept.
  const out = await run([`${base}/logout`, '--state', stateFile])
  check('--state: a run that ends signed out says so, and the session before it is in .prev', out.code === 0 && /looks signed out/.test(out.err) && !readFileSync(stateFile, 'utf8').includes(sid) && existsSync(`${stateFile}.prev`) && readFileSync(`${stateFile}.prev`, 'utf8').includes(sid), out.err.slice(0, 200))
  const corrupt = join(sessions, '.browser', 'corrupt.json')
  writeFileSync(corrupt, '{}')
  const refusedRun = await run([`${base}/whoami`, '--state', corrupt])
  check('--state: a file that is not a kept session is refused before anything opens, and left as it was', refusedRun.code === 4 && /not a kept session/.test(refusedRun.err) && readFileSync(corrupt, 'utf8') === '{}', `${refusedRun.code} ${refusedRun.err.slice(0, 160)}`)
  // --login's end without a window: the person closing the last tab ends it, and the session it had is kept.
  const { chromium } = await import('playwright-core')
  const loginBrowser = await chromium.launch({ headless: true })
  const loginFile = join(sessions, '.browser', 'login.json')
  const ending = signIn(loginBrowser, `${base}/set`, loginFile)
  for (let i = 0; i < 50 && !loginBrowser.contexts().some((c) => c.pages().some((p) => p.url().endsWith('/set'))); i++) await new Promise((r) => setTimeout(r, 100))
  await new Promise((r) => setTimeout(r, 300))
  for (const context of loginBrowser.contexts()) for (const page of context.pages()) await page.close()
  const loginCode = await ending
  check('--login: closing the last tab keeps the session it had', loginCode === 0 && existsSync(loginFile) && readFileSync(loginFile, 'utf8').includes(sid), `${loginCode}`)
  await loginBrowser.close()
  rmSync(sessions, { recursive: true, force: true })
  const gone = await run([`${base}/nothing-here`])
  check('a page that answers with an error status fails, and still shows what it said', gone.code === 4 && gone.out.includes('not here') && /answered 404/.test(gone.err), `${gone.code} ${gone.err.slice(0, 120)}`)
  const file = await run(['file:///etc/hosts'])
  check('a file page is refused before a browser starts', file.code === 4 && /only http and https/.test(file.err), file.err.slice(0, 120))
  const shots = mkdtempSync(join(tmpdir(), 'browse-'))
  const shot = await run([`${base}/js`, '--screenshot', join(shots, 'page.png')])
  const png = existsSync(join(shots, 'page.png')) ? readFileSync(join(shots, 'page.png')) : Buffer.alloc(0)
  check('a screenshot is saved where asked', shot.code === 0 && png.subarray(1, 4).toString() === 'PNG', `${png.length} bytes`)
  rmSync(shots, { recursive: true, force: true })
  server.closeAllConnections()
  server.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
