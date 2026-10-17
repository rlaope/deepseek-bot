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
import { spawn } from 'node:child_process'
import { createServer, request } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { opensPrivate, parseArgs, refusal, shape } from '../dist/tools/browse.js'
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
  const server = createServer((req, res) => {
    if (req.url === '/slow') { setTimeout(() => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('arrived-3e8') }, 400); return }
    if (req.url === '/to-metadata') { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/redirected' }).end(); return }
    if (req.url === '/hop') { res.writeHead(302, { location: '/js' }).end(); return }
    if (req.url === '/hold') return
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
