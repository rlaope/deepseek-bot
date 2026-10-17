/**
 * Where a page the agent opens may send a request: the addresses that are a cloud metadata service, the ones that are
 * private, and the proxy that holds a browser to that by the address a name resolves to — every hop, every window, every
 * socket, since Chromium sends them all through it.
 *
 * Run: node test/net-policy.test.ts
 */
import './dist-fresh.ts'   // fails loudly on a stale dist
import { createServer, request } from 'node:http'
import { connect } from 'node:net'
import { addressKind, createResolver, destinationRefusal, startPolicyProxy } from '../dist/netPolicy.js'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// What an address is.
for (const [address, kind] of [
  ['169.254.169.254', 'metadata'], ['169.254.10.10', 'metadata'], ['100.100.100.200', 'metadata'], ['fd00:ec2::254', 'metadata'],
  ['::ffff:169.254.169.254', 'metadata'], ['64:ff9b::a9fe:a9fe', 'metadata'],
  // Azure's WireServer and Oracle Cloud's, and IPv4 carried in IPv6 the old ways: compatible (::a.b.c.d) and 6to4.
  ['168.63.129.16', 'metadata'], ['192.0.0.192', 'metadata'], ['::169.254.169.254', 'metadata'], ['2002:a9fe:a9fe::1', 'metadata'],
  ['::127.0.0.1', 'private'], ['2002:a00:1::1', 'private'], ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'private'],
  ['2002:808:808::1', 'public'],
  ['127.0.0.1', 'private'], ['127.8.9.10', 'private'], ['10.1.2.3', 'private'], ['172.16.0.1', 'private'], ['172.31.255.255', 'private'],
  ['192.168.1.1', 'private'], ['100.64.0.1', 'private'], ['0.0.0.0', 'private'], ['::1', 'private'], ['::', 'private'],
  ['fe80::1', 'private'], ['fd12:3456::1', 'private'], ['::ffff:127.0.0.1', 'private'], ['::ffff:7f00:1', 'private'], ['64:ff9b::a00:1', 'private'],
  ['224.0.0.251', 'private'],
  ['8.8.8.8', 'public'], ['172.32.0.1', 'public'], ['100.128.0.1', 'public'], ['2606:4700:4700::1111', 'public'], ['64:ff9b::808:808', 'public'],
] as const) {
  check(`${address} is ${kind}`, addressKind(address) === kind, addressKind(address))
}

// Why a request is not made: a metadata name before it is resolved, any metadata address it resolves to, a private one
// unless the page asked for was private itself.
check('a metadata name is refused whatever it resolves to', /cloud metadata/.test(String(destinationRefusal('metadata.google.internal', ['8.8.8.8'], true))))
check('a name that resolves to a metadata address is refused', /169\.254\.169\.254, a cloud metadata service/.test(String(destinationRefusal('meta.example', ['93.184.216.34', '169.254.169.254'], true))))
check('a name that resolves to a private address is refused for a public page', /10\.0\.0\.5, a private address/.test(String(destinationRefusal('intranet.example', ['10.0.0.5'], false))))
check('a private address is allowed when the page asked for is private', destinationRefusal('intranet.example', ['10.0.0.5'], true) === null)
check('a public address is allowed', destinationRefusal('example.com', ['93.184.216.34'], false) === null)
check('a name that resolves to nothing is refused', /did not resolve/.test(String(destinationRefusal('nowhere.example', [], false))))

// A name is looked up once per run: the second ask gets the first answer, not a new lookup a rebinding server could
// answer differently.
const resolveOnce = createResolver()
const first = resolveOnce('localhost')
check('a name is looked up once and its answer kept', first === resolveOnce('localhost') && (await first).some((a) => a.address === '127.0.0.1' || a.address === '::1'), JSON.stringify(await first))

// The proxy, against a server on this machine.
const target = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`served ${req.url}`) })
await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve))
const targetPort = (target.address() as { port: number }).port

/** A GET through the proxy, as a browser sends one: the whole address on the request line. */
const viaProxy = (proxyPort: number, url: string) => new Promise<{ status: number; body: string }>((resolve) => {
  const req = request({ host: '127.0.0.1', port: proxyPort, path: url, headers: { host: new URL(url).host } }, (res) => {
    let body = ''
    res.on('data', (d) => { body += d })
    res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
  })
  req.on('error', (e) => resolve({ status: -1, body: String(e) }))
  req.end()
})
/** A CONNECT through the proxy; for an established tunnel, a GET sent down it. */
const tunnel = (proxyPort: number, to: string) => new Promise<string>((resolve) => {
  const socket = connect(proxyPort, '127.0.0.1', () => socket.write(`CONNECT ${to} HTTP/1.1\r\nHost: ${to}\r\n\r\n`))
  let got = ''
  let sent = false
  socket.on('data', (d) => {
    got += d
    if (!sent && got.includes('\r\n\r\n') && / 200 /.test(got.split('\r\n')[0])) { sent = true; socket.write('GET /tunnelled HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n') }
  })
  socket.on('close', () => resolve(got))
  socket.on('error', () => resolve(got))
  setTimeout(() => socket.destroy(), 3000)
})

const closed = await startPolicyProxy(false)
const loopback = await viaProxy(closed.port, `http://127.0.0.1:${targetPort}/a`)
check('a public page\'s proxy refuses a loopback address', loopback.status === 403 && !loopback.body.includes('served'), JSON.stringify(loopback))
const named = await viaProxy(closed.port, `http://localhost:${targetPort}/b`)
check('it refuses a name that resolves to one (the name is resolved, not read)', named.status === 403, JSON.stringify(named))
const meta = await tunnel(closed.port, '169.254.169.254:80')
check('it refuses a tunnel to a metadata service', /^HTTP\/1\.1 403/.test(meta), JSON.stringify(meta.slice(0, 60)))
check('what it refused is listed', closed.blocked.some((b) => b.startsWith(`blocked "http://127.0.0.1:${targetPort}/a": 127.0.0.1 is a private address`))
  && closed.blocked.some((b) => b.startsWith('blocked "169.254.169.254:80": 169.254.169.254 is a cloud metadata service')), JSON.stringify(closed.blocked))
await closed.close()

const open = await startPolicyProxy(true)
const served = await viaProxy(open.port, `http://127.0.0.1:${targetPort}/c?d=1`)
check('a private page\'s proxy reaches a private address, path and query intact', served.status === 200 && served.body === 'served /c?d=1', JSON.stringify(served))
const tunnelled = await tunnel(open.port, `127.0.0.1:${targetPort}`)
check('a tunnel to an allowed address carries the connection', /^HTTP\/1\.1 200/.test(tunnelled) && tunnelled.includes('served /tunnelled'), JSON.stringify(tunnelled.slice(0, 160)))
const stillMeta = await viaProxy(open.port, 'http://169.254.169.254/latest/meta-data/')
check('a metadata service is refused even then', stillMeta.status === 403, JSON.stringify(stillMeta))
check('nothing allowed is listed as blocked', open.blocked.length === 1, JSON.stringify(open.blocked))
await open.close()

// A refusal says it is one, so a client can tell it from a page's own 403; and each is told to whoever asked as it is
// made (the commands' proxy logs them).
const told: string[] = []
const telling = await startPolicyProxy(false, createResolver(), { onBlocked: (line) => told.push(line) })
const marked = await new Promise<string | undefined>((done) => {
  const req = request({ host: '127.0.0.1', port: telling.port, path: `http://127.0.0.1:${targetPort}/g`, headers: { host: `127.0.0.1:${targetPort}` } }, (res) => { res.resume(); done(res.headers['x-deepbot-refused'] as string | undefined) })
  req.on('error', () => done(undefined))
  req.end()
})
check('a refusal carries its mark', marked === '1', String(marked))
check('and is told as it is made', told.length === 1 && told[0].startsWith(`blocked "http://127.0.0.1:${targetPort}/g"`), JSON.stringify(told))
await telling.close()
target.close()

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
