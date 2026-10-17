// The browser scenario's page server: one page, and two values only a browser gets. Run:
//   node test/fixtures/page-server.mjs [port]     (8899 by default, on 127.0.0.1)
// page-js.html fetches /codename after load and /deadline when its button is pressed. Both answer only a request a
// browser makes itself (it sends Sec-Fetch-Mode; curl and a plain fetch do not), and nothing else is served — this
// file least of all, since it spells the values out — so the scenario cannot be passed by reading source.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'

const PAGE = new URL('./page-js.html', import.meta.url)
const port = Number(process.argv[2] ?? 8899)
const values = {
  '/codename': ['ZEN', 'ITH'].join('') + '-' + (2003).toString(16),
  '/deadline': String(6 * 7),
}

createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname
  if (path in values) {
    const browser = typeof req.headers['sec-fetch-mode'] === 'string'
    res.writeHead(browser ? 200 : 403, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(browser ? values[path] : 'this is fetched by the page itself, in a browser')
    return
  }
  if (path !== '/page-js.html') { res.writeHead(404).end('not here'); return }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(await readFile(PAGE))
}).listen(port, '127.0.0.1')
