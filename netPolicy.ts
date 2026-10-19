/**
 * Where a request the agent causes may go. web_fetch's gate reads the names (the harness itself refuses the private
 * ones); the browse tool runs its browser through the proxy below, which checks the address a name resolves to.
 *
 * A browser sends every request through its proxy: each hop of a redirect, a frame's, a window's the page opens, a
 * socket's (as a tunnel). Intercepting the page's requests instead saw the first request of a redirect and none of a
 * popup's, and a 302 to the metadata service went out unchecked.
 */
import { lookup } from 'node:dns/promises'
import { Agent, createServer, request as httpRequest } from 'node:http'
import { BlockList, connect, isIP, type Socket } from 'node:net'

/**
 * Addresses that answer with credentials rather than content. A fetch tool that can reach
 * them turns "summarize this page" into a way to hand out an instance's keys.
 */
const METADATA_HOSTS = new Set([
  '169.254.169.254',            // AWS, Azure, GCP, DigitalOcean
  'metadata.google.internal',
  'fd00:ec2::254',
  '100.100.100.200',            // Alibaba Cloud
  '168.63.129.16',              // Azure's WireServer (extension settings)
  '192.0.0.192',                // Oracle Cloud
  'metadata',
])
export const isMetadataHost = (host: string) => METADATA_HOSTS.has(host) || host.startsWith('169.254.')

/**
 * A URL's host as it is compared: an IPv6 address without the brackets a URL writes it in (compared as written,
 * fd00:ec2::254 matched nothing), no trailing dots. The URL has already made it lower case and short.
 */
export const requestHost = (hostname: string) => hostname.replace(/^\[(.*)\]$/, '$1').replace(/\.+$/, '')

const metadata = new BlockList()
metadata.addSubnet('169.254.0.0', 16)
metadata.addAddress('100.100.100.200')
metadata.addAddress('168.63.129.16')
metadata.addAddress('192.0.0.192')
metadata.addAddress('fd00:ec2::254', 'ipv6')

// Not on the public internet: this machine, the local networks, carrier NAT (a VPN's addresses among them), the
// unspecified address (which reaches this machine), multicast and the reserved block.
const nonPublic = new BlockList()
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) {
  nonPublic.addSubnet(net, bits)
}
// Teredo (2001::/32) carries its IPv4 address scrambled; it is not read, only refused.
for (const [net, bits] of [['::', 128], ['::1', 128], ['2001::', 32], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]] as const) {
  nonPublic.addSubnet(net, bits, 'ipv6')
}

/** An IPv6 address's eight groups, a trailing dotted quad included. Only for what isIP calls IPv6. */
function groups(address: string): number[] | null {
  let a = address.toLowerCase().replace(/%.*$/, '')
  const quad = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a)
  if (quad !== null) {
    const [b0, b1, b2, b3] = quad.slice(1).map(Number)
    a = a.slice(0, quad.index) + ((b0 << 8) | b1).toString(16) + ':' + ((b2 << 8) | b3).toString(16)
  }
  const [head, tail] = a.split('::')
  const front = head === '' ? [] : head.split(':')
  const back = tail === undefined ? null : tail === '' ? [] : tail.split(':')
  const all = back === null ? front : [...front, ...Array(8 - front.length - back.length).fill('0'), ...back]
  return all.length === 8 ? all.map((g) => parseInt(g, 16)) : null
}

/**
 * The IPv4 address an IPv6 one carries, or null: NAT64 (64:ff9b::/96) and the old compatible form (::a.b.c.d, with
 * :: and ::1 among them) in the last 32 bits, 6to4 (2002::/16) in the 32 after the prefix. A mapped one
 * (::ffff:a.b.c.d) needs nothing: BlockList checks it against the IPv4 rules itself.
 */
function carriedIPv4(address: string): string | null {
  const g = groups(address)
  if (g === null) return null
  const quad = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.')
  const translated = g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)
  const compatible = g.slice(0, 6).every((x) => x === 0)
  if (translated || compatible) return quad(g[6], g[7])
  if (g[0] === 0x2002) return quad(g[1], g[2])
  return null
}

/** What an IP address is: a cloud metadata service, an address off the public internet, or a public one. */
export function addressKind(address: string): 'metadata' | 'private' | 'public' {
  const family = isIP(address)
  if (family === 6) {
    const carried = carriedIPv4(address)
    if (carried !== null) return addressKind(carried)
  }
  const type = family === 6 ? 'ipv6' : 'ipv4'
  if (metadata.check(address, type)) return 'metadata'
  if (nonPublic.check(address, type)) return 'private'
  return 'public'
}

/**
 * Why a request to `host`, which resolved to `addresses`, is not made, or null. A metadata service never; a private
 * address only when the page asked for was on one itself (a dev server, an intranet page): a public page has no
 * business with this machine or its network, and does not get to choose to.
 */
export function destinationRefusal(host: string, addresses: readonly string[], allowPrivate: boolean): string | null {
  if (isMetadataHost(host)) return `${host} is a cloud metadata service, which answers with credentials`
  if (addresses.length === 0) return `${host} did not resolve`
  for (const address of addresses) {
    const kind = addressKind(address)
    if (kind === 'public' || (kind === 'private' && allowPrivate)) continue
    const what = kind === 'metadata' ? 'a cloud metadata service, which answers with credentials' : 'a private address (this machine or its network), which is not reached from here'
    return address === host ? `${address} is ${what}` : `${host} is ${address}, ${what}`
  }
  return null
}

export type Resolved = { address: string; family: number }
export type ResolverOptions = {
  /** How long an answer is kept, and a failure (an empty answer). */
  ttlMs?: number
  failMs?: number
  /** How many names are kept; the oldest goes first. */
  max?: number
  lookup?: (host: string) => Promise<Resolved[]>
}
/**
 * A name's addresses, kept for a minute (a failure for seconds, and so many names at once): the commands' proxy lives as
 * long as the gateway, and kept for good, a name that moved was reached at its old address and one that failed once
 * failed until a restart (found by the final review). A request goes to the address that was checked, so a name that
 * answers differently later (DNS rebinding) is checked again and reaches nothing the policy refuses.
 */
export function createResolver(options: ResolverOptions = {}): (host: string) => Promise<Resolved[]> {
  const { ttlMs = 60_000, failMs = 5_000, max = 1_000 } = options
  const find = options.lookup ?? ((host: string) => lookup(host, { all: true }))
  const known = new Map<string, { until: number; answer: Promise<Resolved[]> }>()
  return (host) => {
    if (isIP(host) !== 0) return Promise.resolve([{ address: host, family: isIP(host) }])
    const kept = known.get(host)
    if (kept !== undefined && performance.now() < kept.until) return kept.answer
    known.delete(host)
    if (known.size >= max) known.delete(known.keys().next().value!)
    const entry = { until: Number.POSITIVE_INFINITY, answer: find(host).catch(() => [] as Resolved[]) }
    entry.answer.then((found) => { entry.until = performance.now() + (found.length > 0 ? ttlMs : failMs) })
    known.set(host, entry)
    return entry.answer
  }
}

export type PolicyProxy = { port: number; blocked: string[]; open: () => number; close: () => Promise<void> }

export type PolicyProxyOptions = {
  /** Told each refusal as it is made, without a request's query: a long-lived proxy (the commands') logs them. */
  onBlocked?: (line: string) => void
  /** A tunnel with no traffic for this long is closed, both ends. */
  idleMs?: number
  /** How many tunnels may be open at once; one more is refused. */
  maxTunnels?: number
}

/** The header this proxy's refusal carries, so a client can tell it from a page's own 403. */
export const REFUSED_HEADER = 'x-deepbot-refused'
/** What `blocked` keeps: a page or a command that keeps trying would otherwise grow it without end. */
const BLOCKED_KEPT = 1000

/**
 * An HTTP proxy on 127.0.0.1 that makes a request only to an address destinationRefusal passes, and connects to the
 * address it checked. What it refused is listed in `blocked`.
 */
export async function startPolicyProxy(allowPrivate: boolean, resolve = createResolver(), options: PolicyProxyOptions = {}): Promise<PolicyProxy> {
  const blocked: string[] = []
  const { idleMs = 900_000, maxTunnels = 256 } = options
  const refuse = (label: string, why: string) => {
    if (blocked.length < BLOCKED_KEPT) blocked.push(`blocked ${JSON.stringify(label.slice(0, 100))}: ${why}`)
    options.onBlocked?.(`blocked ${JSON.stringify(label.replace(/[?#].*$/, '').slice(0, 100))}: ${why}`)
  }
  let tunnels = 0
  // Everything it holds open, so that closing it lets the process end: a request the page left waiting on its server
  // kept the tool running for as long as the server held it.
  const sockets = new Set<Socket>()
  const agent = new Agent({ keepAlive: true })
  const admit = async (label: string, host: string): Promise<Resolved | null> => {
    const addresses = isMetadataHost(host) ? [] : await resolve(host)
    const why = destinationRefusal(host, addresses.map((a) => a.address), allowPrivate)
    if (why === null) return addresses[0]
    refuse(label, why)
    return null
  }
  const server = createServer(async (req, res) => {
    let url: URL
    try { url = new URL(req.url ?? '') } catch { res.writeHead(400).end(); return }
    if (url.protocol !== 'http:') { res.writeHead(400).end(); return }
    const to = await admit(url.href, requestHost(url.hostname))
    if (to === null) { res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', [REFUSED_HEADER]: '1' }).end('refused by the network policy'); return }
    if (req.socket.destroyed) return   // gone during the lookup: nothing to fetch for
    const headers = { ...req.headers }
    delete headers['proxy-connection']
    delete headers['proxy-authorization']
    const outbound = httpRequest({ agent, host: to.address, family: to.family, port: Number(url.port || 80), method: req.method, path: url.pathname + url.search, headers, setHost: false }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.statusMessage, up.rawHeaders)
      up.pipe(res)
    })
    outbound.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
    // The page gave up on it (an aborted fetch, a closed frame): so does the proxy.
    res.on('close', () => { if (!res.writableFinished) outbound.destroy() })
    req.pipe(outbound)
  })
  // HTTPS and sockets arrive as tunnels: CONNECT host:port.
  server.on('connect', async (req, socket: Socket, head: Buffer) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => socket.destroy())
    const target = /^(.+):(\d+)$/.exec(req.url ?? '')
    if (target === null) { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return }
    const label = `${target[1]}:${target[2]}`
    if (tunnels >= maxTunnels) { refuse(label, `too many connections open at once (${maxTunnels})`); socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n'); return }
    // Its place is taken now, before the lookup, and given back when its client goes, whichever way: checked before the
    // wait and counted after it, a burst all got through (found by review). One that carries nothing for idleMs is closed.
    tunnels++
    socket.once('close', () => { tunnels-- })
    socket.setTimeout(idleMs, () => socket.destroy())
    const to = await admit(label, requestHost(target[1].toLowerCase()))
    if (to === null) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return }
    if (socket.destroyed) return
    const join = (other: Socket, rest: Buffer) => {
      sockets.add(other)
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (rest.length > 0) socket.write(rest)
      if (head.length > 0) other.write(head)
      other.pipe(socket)
      socket.pipe(other)
      other.on('close', () => { sockets.delete(other); socket.destroy() })
      other.on('error', () => socket.destroy())
    }
    const direct = connect({ host: to.address, port: Number(target[2]), family: to.family }, () => join(direct, Buffer.alloc(0)))
    sockets.add(direct)
    direct.on('error', () => socket.destroy())
    // A client gone, by a reset, an error or the idle time rather than an end the pipe would pass on, takes the far end
    // with it (what a tunnel carries passes through both, so the client's idle time is the tunnel's), and a far end that
    // never connected is let go. Left open, each held a socket for good.
    direct.on('close', () => sockets.delete(direct))
    socket.on('close', () => direct.destroy())
  })
  server.on('clientError', (_e, socket) => socket.destroy())
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return {
    port: (server.address() as { port: number }).port,
    blocked,
    /** How many sockets it holds open: both ends of each tunnel, and a tunnel's while it connects. */
    open: () => sockets.size,
    close: () => new Promise<void>((done) => {
      for (const s of sockets) s.destroy()
      agent.destroy()
      server.closeAllConnections()
      server.close(() => done())
    }),
  }
}
