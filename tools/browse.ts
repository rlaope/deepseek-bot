#!/usr/bin/env node
/**
 * Open a page in a headless browser and print what a person would read on it.
 *
 * web_fetch takes a page's HTML as it arrives, so a page that draws its content with JavaScript
 * came back empty, and nothing could be clicked or typed. This runs the page in Chromium (through
 * playwright-core, the one runtime dependency, used by this tool and nothing else), lets it settle,
 * does what it is asked in order, and prints the page's title, its address and its visible text.
 *
 * The agent runs it with its shell, so it runs under the same sandbox as any other command: the
 * browser reads and writes what the agent's commands may, and no more. On top of that it opens only
 * http and https pages, sends every request the browser makes through netPolicy's proxy (a cloud
 * metadata service never; a private address only from a page that is on one itself), and downloads
 * nothing.
 *
 * Usage: node dist/tools/browse.js <url> [--click <selector>]... [--type <selector> <text>]...
 *        [--wait <ms>] [--screenshot <file.png>] [--max <chars>]
 *        node dist/tools/browse.js --check
 * The steps (--click, --type) run in the order given. A selector is Playwright's: CSS, or
 * text=Sign in, or role=button[name="Next"]. Text given to --type is in the command line, where
 * the process list and the session log show it: not for a password.
 * Exit: 0 read, 2 usage, 3 no browser, 4 the page could not be opened, answered with an error, or a step failed.
 */
import { realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { addressKind, createResolver, isMetadataHost, requestHost, startPolicyProxy, type Resolved } from '../netPolicy.js'

export type Step = { kind: 'click'; selector: string } | { kind: 'type'; selector: string; text: string }
export type Request = { url: string; steps: Step[]; waitMs: number; screenshot: string | null; max: number }

export const USAGE = [
  'usage: browse <url> [--click <selector>]... [--type <selector> <text>]... [--wait <ms>] [--screenshot <file.png>] [--max <chars>]',
  '       browse --check',
  'Opens the page in a headless browser, does the steps in order, and prints its title, address and visible text.',
  'A selector is CSS, or text=Sign in, or role=button[name="Next"].',
].join('\n')

const DEFAULT_MAX = 20_000
const LONGEST_WAIT = 30_000
/** All the work on the page; what it shows by then is printed. */
const BUDGET = 75_000
/** The process ends by then, whatever it is waiting for. */
const HARD_STOP = 90_000
/** The blocked requests printed; a page that keeps trying would bury its own text. */
const BLOCKED_SHOWN = 20

/** The request the arguments make, or what is wrong with them. */
export function parseArgs(argv: readonly string[]): Request | { error: string } {
  let url: string | null = null
  const steps: Step[] = []
  let waitMs = 0
  let screenshot: string | null = null
  let max = DEFAULT_MAX
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => {
      const next = argv[i + 1]
      if (next === undefined) throw new Error(`${arg} needs a value`)
      i++
      return next
    }
    try {
      if (arg === '--click') steps.push({ kind: 'click', selector: value() })
      // Two values, not one joined by "=": a selector has its own (input[name=q]), and so may the text.
      else if (arg === '--type') steps.push({ kind: 'type', selector: value(), text: value() })
      else if (arg === '--wait') {
        const ms = Number(value())
        if (!Number.isFinite(ms) || ms < 0) return { error: '--wait takes milliseconds' }
        waitMs = Math.min(ms, LONGEST_WAIT)
      } else if (arg === '--screenshot') screenshot = value()
      else if (arg === '--max') {
        const n = Number(value())
        if (!Number.isInteger(n) || n <= 0) return { error: '--max takes a number of characters' }
        max = n
      } else if (arg.startsWith('--')) return { error: `unknown option ${arg}` }
      else if (url === null) url = arg
      else return { error: `one address at a time; ${JSON.stringify(arg)} is a second` }
    } catch (e) {
      return { error: String((e as Error).message) }
    }
  }
  if (url === null) return { error: 'no address given' }
  return { url, steps, waitMs, screenshot, max }
}

/**
 * Why the page asked for is not opened, or null: it must be http or https, and not a cloud metadata service by name.
 * What it loads afterwards is the proxy's to check, by address.
 */
export function refusal(address: string): string | null {
  let parsed: URL
  try { parsed = new URL(address) } catch { return `${JSON.stringify(address.slice(0, 120))} is not an address` }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return `only http and https pages are opened, not ${parsed.protocol}`
  const host = requestHost(parsed.hostname)
  if (isMetadataHost(host)) return `${host} is a cloud metadata service, which answers with credentials`
  return null
}

/** What is printed: the title, the address the page ended at, and its text, cut at `max` with the cut said. */
export function shape(title: string, address: string, text: string, max: number): string {
  const tidy = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  const kept = tidy.length > max ? tidy.slice(0, max) : tidy
  const cut = tidy.length > max ? `\n\n[… ${tidy.length - max} more characters; --max to see more]` : ''
  return [`title: ${title}`, `url: ${address}`, '', kept === '' ? '(the page shows no text)' : kept + cut].join('\n')
}

const firstLine = (e: unknown) => String((e as Error)?.message ?? e).split('\n')[0]

/**
 * Whether the page asked for is on this machine or its network: every address its name resolved to is private. Then
 * what it loads may be there too (a dev server, an intranet page). A public page's may not, and a name with a public
 * address among private ones is a public page: the page may come from that one, which its owner chose.
 */
export const opensPrivate = (addresses: readonly Resolved[]) => addresses.length > 0 && addresses.every((a) => addressKind(a.address) === 'private')

async function main(argv: readonly string[]): Promise<number> {
  const started = Date.now()
  // Whatever happens, the process ends: a browser that never starts or closes must not hold the agent's command.
  const hardStop = setTimeout(() => { console.error(`browse: gave up after ${HARD_STOP / 1000} s`); process.exit(4) }, HARD_STOP)
  hardStop.unref()
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    console.log(USAGE)
    return argv.length === 0 ? 2 : 0
  }
  let chromium: typeof import('playwright-core').chromium
  try {
    ({ chromium } = await import('playwright-core'))
  } catch {
    console.error('browse: playwright-core is not installed in this checkout (pnpm install).')
    return 3
  }
  const launch = async (proxyPort: number | null) => {
    try {
      return await chromium.launch({ headless: true, timeout: 20_000, ...(proxyPort === null ? {} : { proxy: { server: `http://127.0.0.1:${proxyPort}` } }) })
    } catch (e) {
      const cli = fileURLToPath(new URL('../../node_modules/playwright-core/cli.js', import.meta.url))
      console.error(`browse: no browser to run (${firstLine(e)}). The installer puts one in place; by hand: node '${cli}' install chromium-headless-shell`)
      return null
    }
  }
  if (argv[0] === '--check') {
    const browser = await launch(null)
    if (browser === null) return 3
    await browser.close()
    console.log('browse: ready')
    return 0
  }
  const request = parseArgs(argv)
  if ('error' in request) {
    console.error(`browse: ${request.error}\n${USAGE}`)
    return 2
  }
  const refused = refusal(request.url)
  if (refused !== null) {
    console.error(`browse: refused — ${refused}`)
    return 4
  }
  // Resolved once: the proxy keeps the answer for the run, so the page is fetched from the address that was judged.
  const resolve = createResolver()
  const pageAddresses = await resolve(requestHost(new URL(request.url).hostname))
  const proxy = await startPolicyProxy(opensPrivate(pageAddresses), resolve)
  const browser = await launch(proxy.port)
  if (browser === null) { await proxy.close(); return 3 }
  try {
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block' })
    const page = await context.newPage()
    // The status the page's own document came with; the last one, after any redirect.
    let status = 0
    page.on('response', (response) => {
      try {
        if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) status = response.status()
      } catch { /* a response with no frame */ }
    })
    // Settled: nothing in flight for half a second. Playwright's networkidle is reached once and then answers at
    // once, so a click whose result comes from a request was read before the result came.
    let inflight = 0
    let lastChange = Date.now()
    page.on('request', () => { inflight++; lastChange = Date.now() })
    const finished = () => { inflight = Math.max(0, inflight - 1); lastChange = Date.now() }
    page.on('requestfinished', finished)
    page.on('requestfailed', finished)
    // Quiet counted from the step: a click may start its request a moment later (a debounce, a timer).
    const settle = async () => {
      const from = Date.now()
      lastChange = from
      while (Date.now() - from < 10_000 && (inflight > 0 || Date.now() - lastChange < 500)) await page.waitForTimeout(100)
    }
    const work = (async (): Promise<string | null> => {
      await page.goto(request.url, { waitUntil: 'load', timeout: 30_000 })
      await settle()
      for (const step of request.steps) {
        if (step.kind === 'click') await page.click(step.selector, { timeout: 10_000 })
        else await page.fill(step.selector, step.text, { timeout: 10_000 })
        await settle()
      }
      if (request.waitMs > 0) await page.waitForTimeout(request.waitMs)
      return null
    })().catch(firstLine)
    // The budget runs out before the hard stop, so what the page shows by then is still printed.
    const late = new Promise<string>((done) => {
      setTimeout(() => done(`gave up after ${BUDGET / 1000} s; below is what the page showed by then`), Math.max(0, BUDGET - (Date.now() - started))).unref()
    })
    let failed = await Promise.race([work, late])
    // Read twice: a click that navigates leaves the first read with no document to read.
    let text = ''
    for (let attempt = 0; attempt < 2; attempt++) {
      const read = await page.innerText('body', { timeout: 5_000 }).then((t) => ({ t }), (e) => ({ e: firstLine(e) }))
      if ('t' in read) { text = read.t; break }
      if (attempt === 1) failed ??= `the page could not be read (${read.e})`
      else await page.waitForLoadState('load', { timeout: 5_000 }).catch(() => {})
    }
    const title = await page.title().catch(() => '')
    if (failed === null && page.url().startsWith('chrome-error:')) failed = 'the page could not be opened'
    if (failed === null && status >= 400) failed = `the page answered ${status}`
    if (failed !== null) console.error(`browse: ${failed}`)
    const blocked = proxy.blocked.length <= BLOCKED_SHOWN ? proxy.blocked
      : [...proxy.blocked.slice(0, BLOCKED_SHOWN), `… and ${proxy.blocked.length - BLOCKED_SHOWN} more blocked`]
    console.log(shape(title, page.url(), text, request.max) + (blocked.length > 0 ? `\n\n${blocked.join('\n')}` : ''))
    if (request.screenshot !== null) {
      await page.screenshot({ path: request.screenshot, timeout: 5_000 }).then(
        () => console.log(`\nscreenshot: ${request.screenshot}`),
        (e) => console.error(`browse: no screenshot (${firstLine(e)})`),
      )
    }
    return failed === null ? 0 : 4
  } finally {
    await browser.close().catch(() => {})
    await proxy.close()
  }
}

// Run only as a command: the suites import the functions above. Node names the main module by its real path.
const invoked = process.argv[1] !== undefined ? (() => { try { return pathToFileURL(realpathSync(process.argv[1])).href } catch { return '' } })() : ''
if (invoked === import.meta.url) {
  // Anything unforeseen is a failure in the documented set, not a stack trace and node's own status.
  process.exitCode = await main(process.argv.slice(2)).catch((e) => { console.error(`browse: ${firstLine(e)}`); return 4 })
}
