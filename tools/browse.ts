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
 *        [--wait <ms>] [--screenshot <file.png>] [--max <chars>] [--state <file.json>]
 *        node dist/tools/browse.js --login <url> --state <file.json>
 *        node dist/tools/browse.js --check
 * --state keeps a signed-in session (its cookies and site storage) in a file: read before the steps,
 * written back after them, readable by the user alone. --login opens a window for a person to sign
 * in, for as long as they need, and keeps the session in that file when they close it; it is run by
 * the person, in their own terminal, not by the agent.
 * The steps (--click, --type) run in the order given. A selector is Playwright's: CSS, or
 * text=Sign in, or role=button[name="Next"]. Text given to --type is in the command line, where
 * the process list and the session log show it: not for a password.
 * Exit: 0 read, 2 usage, 3 no browser, 4 the page could not be opened, answered with an error, or a step failed.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Browser, BrowserContext } from 'playwright-core'
import { addressKind, createResolver, isMetadataHost, REFUSED_HEADER, requestHost, startPolicyProxy, type Resolved } from '../netPolicy.js'

export type Step = { kind: 'click'; selector: string } | { kind: 'type'; selector: string; text: string }
export type Request = { url: string; steps: Step[]; waitMs: number; screenshot: string | null; max: number; state: string | null; login: boolean }

export const USAGE = [
  'usage: browse <url> [--click <selector>]... [--type <selector> <text>]... [--wait <ms>] [--screenshot <file.png>] [--max <chars>] [--state <file.json>]',
  '       browse --login <url> --state <file.json>     (a person signs in, in a window)',
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
  let state: string | null = null
  let login = false
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
      else if (arg === '--state') state = value()
      else if (arg === '--login') login = true
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
  if (login && state === null) return { error: '--login needs --state <file.json>, where the session is kept' }
  if (login && steps.length > 0) return { error: '--login takes no steps: the person does them, in the window' }
  return { url, steps, waitMs, screenshot, max, state, login }
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
 * Why `file` cannot hold a session, or null. Never through a link: the agent can leave one at the file's name, or make
 * its directory one, and --login writes as the person, outside the sandbox. Found by review: a link at the name made a
 * run overwrite the file it pointed at.
 */
function sessionPathProblem(file: string): string | null {
  for (const path of [dirname(file), file]) {
    try { if (lstatSync(path).isSymbolicLink()) return `${path} is a link, and a session is not read or written through one` } catch { /* not there yet */ }
  }
  // A plain file or nothing: reading a pipe left at the name waits for a writer that never comes.
  try { if (!lstatSync(file).isFile()) return `${file} is not a plain file` } catch { /* not there yet */ }
  return null
}

/** The session kept in `file`; null when there is none yet; or what is wrong with it. */
export function loadSession(file: string): { session: { cookies: unknown[] } } | { error: string } | null {
  const problem = sessionPathProblem(file)
  if (problem !== null) return { error: problem }
  if (!existsSync(file)) return null
  let parsed: unknown
  try { parsed = JSON.parse(readFileSync(file, 'utf8')) } catch { parsed = undefined }
  // Anything else is not taken: read as an empty session, and written back over, it was lost.
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as { cookies?: unknown }).cookies)) {
    return { error: `${file} is not a kept session: delete it, and sign in again with --login` }
  }
  return { session: parsed as { cookies: unknown[] } }
}

/**
 * Keep a session in `file`, mode 600 (the agent's commands can read it, as they read anything in its workspace).
 * Written to a fresh file beside it and renamed over it: never through a link, never half-written. The one it replaces
 * is kept as <file>.prev.
 */
export function keepSession(file: string, session: unknown): void {
  const dir = dirname(file)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const problem = sessionPathProblem(file)
  if (problem !== null) throw new Error(problem)
  const temp = join(dir, `.${basename(file)}.${process.pid}.${Date.now().toString(36)}.tmp`)
  writeFileSync(temp, JSON.stringify(session), { mode: 0o600, flag: 'wx' })
  try {
    if (existsSync(file)) renameSync(file, `${file}.prev`)
    renameSync(temp, file)
  } catch (e) {
    rmSync(temp, { force: true })
    throw e
  }
}

/**
 * The agent's commands' proxy (commandNetwork), which the sandbox runner names in the environment when it holds
 * commands to it: the one connection a command may make. The browser then goes through it, under its rule, and this
 * tool runs no proxy of its own, which the sandbox would not let the browser reach. Only one on this machine is taken.
 */
export function commandProxyFrom(env: Record<string, string | undefined>): { host: string; port: number } | null {
  const value = env.https_proxy ?? env.HTTPS_PROXY ?? env.http_proxy ?? env.HTTP_PROXY
  if (!value) return null
  try {
    const url = new URL(value)
    const host = url.hostname.replace(/^\[(.*)\]$/, '$1')
    if (url.protocol !== 'http:' || url.port === '' || !['127.0.0.1', 'localhost', '::1'].includes(host)) return null
    return { host: host === 'localhost' ? '127.0.0.1' : host, port: Number(url.port) }
  } catch {
    return null
  }
}

/** The session a load found, or null. */
const sessionOf = (loaded: ReturnType<typeof loadSession>) => loaded !== null && 'session' in loaded ? loaded.session : null

/** A context that starts from a kept session, when there is one. */
function openContext(browser: Browser, session: { cookies: unknown[] } | null): Promise<BrowserContext> {
  return browser.newContext({ acceptDownloads: false, serviceWorkers: 'block', ...(session !== null ? { storageState: session as never } : {}) })
}

/**
 * --login: a window for the person to sign in, open as long as they need. It ends when the last tab is closed, the
 * browser quits, or ctrl+c (the browser is launched without Playwright's own signal handlers, which closed it before the
 * session was read). The session is read as it changes and every two seconds, since a browser that quit outright has
 * none left to read, and kept in `state`. Exported so the suite can end it by closing the tab itself.
 */
export async function signIn(browser: Browser, url: string, state: string): Promise<number> {
  const loaded = loadSession(state)
  if (loaded !== null && 'error' in loaded) { console.error(`browse: ${loaded.error}`); return 4 }
  const context = await openContext(browser, sessionOf(loaded))
  let last: unknown = null
  let reading: ReturnType<typeof setTimeout> | undefined
  const read = () => context.storageState().then((s) => { last = s }, () => {})
  const soon = () => { clearTimeout(reading); reading = setTimeout(() => { void read() }, 300) }
  context.on('response', soon)
  const tick = setInterval(() => { void read() }, 2_000)
  let finish: () => void = () => {}
  const ended = new Promise<void>((done) => { finish = done })
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
  for (const signal of signals) process.on(signal, finish)
  context.on('page', (page) => page.on('close', () => { if (context.pages().length === 0) finish() }))
  browser.on('disconnected', finish)
  const page = await context.newPage()
  await page.goto(url, { timeout: 30_000 }).catch((e) => console.error(`browse: ${firstLine(e)}`))
  await read()
  console.log(`Sign in in the window that opened, then close it (or press ctrl+c here). The session is kept in ${state}.`)
  await ended
  clearInterval(tick)
  clearTimeout(reading)
  for (const signal of signals) process.off(signal, finish)
  const session = await context.storageState().catch(() => last)
  if (session === null) {
    console.error('browse: the session could not be read; nothing was kept')
    return 4
  }
  try {
    keepSession(state, session)
  } catch (e) {
    console.error(`browse: the session could not be kept (${firstLine(e)})`)
    return 4
  }
  console.log(`browse: the session is kept in ${state}`)
  return 0
}

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
  const launch = async (proxyServer: string | null, windowed = false) => {
    try {
      return await chromium.launch({
        headless: !windowed, timeout: 20_000,
        // A window's run ends on the person's signals, handled in signIn; Playwright's own closed the browser first.
        ...(windowed ? { handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false } : {}),
        ...(proxyServer === null ? {} : { proxy: { server: proxyServer } }),
      })
    } catch (e) {
      const cli = fileURLToPath(new URL('../../node_modules/playwright-core/cli.js', import.meta.url))
      console.error(windowed
        ? `browse: no browser with a window (${firstLine(e)}). Add one with: node '${cli}' install chromium`
        : `browse: no browser to run (${firstLine(e)}). The installer puts one in place; by hand: node '${cli}' install chromium-headless-shell`)
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
  // A kept session that cannot be used is said before anything opens: for --login, before the person signs in to a
  // window whose session would then be lost.
  const loaded = request.state !== null ? loadSession(request.state) : null
  if (loaded !== null && 'error' in loaded) {
    console.error(`browse: ${loaded.error}`)
    return 4
  }
  if (request.login && request.state !== null) {
    try {
      mkdirSync(dirname(request.state), { recursive: true, mode: 0o700 })
      const problem = sessionPathProblem(request.state)
      if (problem !== null) throw new Error(problem)
    } catch (e) {
      console.error(`browse: the session could not be kept there (${firstLine(e)})`)
      return 4
    }
  }
  // With the commands' network bounded, the browser goes through the commands' proxy; otherwise through one of this
  // tool's own. Resolved once: that proxy keeps the answer for the run, so the page is fetched from the address judged.
  const commands = commandProxyFrom(process.env)
  let proxy: Awaited<ReturnType<typeof startPolicyProxy>> | null = null
  if (commands === null) {
    const resolve = createResolver()
    proxy = await startPolicyProxy(opensPrivate(await resolve(requestHost(new URL(request.url).hostname))), resolve)
  }
  const proxyServer = commands !== null ? `http://${commands.host}:${commands.port}` : `http://127.0.0.1:${proxy?.port}`
  // Signing in takes the person as long as it takes: no deadline.
  if (request.login) clearTimeout(hardStop)
  const browser = await launch(proxyServer, request.login)
  if (browser === null) { await proxy?.close(); return 3 }
  try {
    if (request.login && request.state !== null) {
      const code = await signIn(browser, request.url, request.state)
      if (proxy !== null && proxy.blocked.length > 0) console.error(`browse: blocked during sign-in:\n${proxy.blocked.slice(0, BLOCKED_SHOWN).join('\n')}`)
      return code
    }
    const context = await openContext(browser, sessionOf(loaded))
    const page = await context.newPage()
    // The status the page's own document came with; the last one, after any redirect.
    let status = 0
    // Whether that document was the commands' proxy refusing it, rather than the site answering 403.
    let refusedByCommands = false
    page.on('response', (response) => {
      try {
        if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
          status = response.status()
          refusedByCommands = commands !== null && response.headers()[REFUSED_HEADER] === '1'
        }
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
    if (failed === null && page.url().startsWith('chrome-error:')) failed = commands === null ? 'the page could not be opened' : 'the page could not be opened (the agent\'s network, commandNetwork, may have refused it)'
    if (failed === null && refusedByCommands) failed = 'refused by the agent\'s network (commandNetwork)'
    if (failed === null && status >= 400) failed = `the page answered ${status}`
    if (failed !== null) console.error(`browse: ${failed}`)
    const all = proxy?.blocked ?? []
    const blocked = all.length <= BLOCKED_SHOWN ? all : [...all.slice(0, BLOCKED_SHOWN), `… and ${all.length - BLOCKED_SHOWN} more blocked`]
    console.log(shape(title, page.url(), text, request.max) + (blocked.length > 0 ? `\n\n${blocked.join('\n')}` : ''))
    if (request.screenshot !== null) {
      await page.screenshot({ path: request.screenshot, timeout: 5_000 }).then(
        () => console.log(`\nscreenshot: ${request.screenshot}`),
        (e) => console.error(`browse: no screenshot (${firstLine(e)})`),
      )
    }
    // The session as a run that went through left it: a site that renews its cookies keeps the account signed in. A
    // failed run leaves the kept one as it was; one that ended signed out is said, with the one before it kept.
    if (request.state !== null && failed === null) {
      const before = sessionOf(loaded)?.cookies.length ?? 0
      const kept = await context.storageState().then((s) => { keepSession(request.state as string, s); return s.cookies.length }, (e) => firstLine(e))
      if (typeof kept === 'string') {
        console.error(`browse: the session could not be kept (${kept})`)
        failed = 'the session could not be kept'
      } else if (kept === 0 && before > 0) {
        console.error(`browse: the account looks signed out now (no cookies left); the session before this run is in ${request.state}.prev`)
      }
    }
    return failed === null ? 0 : 4
  } finally {
    await browser.close().catch(() => {})
    await proxy?.close()
  }
}

// Run only as a command: the suites import the functions above. Node names the main module by its real path.
const invoked = process.argv[1] !== undefined ? (() => { try { return pathToFileURL(realpathSync(process.argv[1])).href } catch { return '' } })() : ''
if (invoked === import.meta.url) {
  // Anything unforeseen is a failure in the documented set, not a stack trace and node's own status.
  process.exitCode = await main(process.argv.slice(2)).catch((e) => { console.error(`browse: ${firstLine(e)}`); return 4 })
}
