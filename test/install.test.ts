/**
 * The one-line installer, in the parts that can be checked without installing anything.
 *
 * install.sh runs from `curl … | bash`: a download cut short must run nothing, and what a person types
 * at its prompts goes into a YAML profile through sed. Its helpers are top-level functions, and with
 * DEEPBOT_INSTALL_SOURCED=1 sourcing it defines them and does nothing else, so they are called here
 * directly. The rest — clone, build, launchd — is not run by this suite.
 *
 * Run: node test/install.test.ts
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const INSTALL = fileURLToPath(new URL('../install.sh', import.meta.url))
const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const dir = mkdtempSync(join(tmpdir(), 'deepbot-install-'))
// Files in the working directory, so an unquoted * would expand to them.
writeFileSync(join(dir, 'a-file'), '')
writeFileSync(join(dir, 'b-file'), '')
/** Source the installer and run one shell line with its helpers; returns { out, code }. */
function withHelpers(line, env = {}) {
  try {
    const out = execFileSync('/bin/bash', ['-c', `DEEPBOT_INSTALL_SOURCED=1 source "$1"; ${line}`, 'bash', INSTALL], {
      encoding: 'utf8', cwd: dir, env: { ...process.env, HOME: dir, ...env }, stdio: 'pipe',
    })
    return { out: out.trim(), code: 0 }
  } catch (e) {
    return { out: String(e.stdout ?? '').trim(), code: e.status ?? 1 }
  }
}

check('the script parses', (() => { try { execFileSync('/bin/bash', ['-n', INSTALL]); return true } catch { return false } })())
const lines = readFileSync(INSTALL, 'utf8').trimEnd().split('\n')
check('its last line is what starts it, so a download cut short runs nothing', /^\[ "\$\{DEEPBOT_INSTALL_SOURCED:-0\}" = 1 \] \|\| main "\$@"$/.test(lines.at(-1)), lines.at(-1))
const sourced = withHelpers('true')
check('sourced, it does nothing', sourced.code === 0 && sourced.out === '', JSON.stringify(sourced.out.slice(0, 60)))

// The installer is not the messenger setup: no platform, channel or messenger token is asked for, a new
// profile serves the terminal alone, and the end says how to connect one (`dsh gateway setup`, its own suite).
const installer = readFileSync(INSTALL, 'utf8')
check('messengers: no platform, channel or messenger token is asked for', !/ask (platform|channels) /.test(installer) && !/put_key (SLACK|TELEGRAM|DISCORD)_/.test(installer), (installer.match(/ask (platform|channels) .*|put_key (SLACK|TELEGRAM|DISCORD)_.*/) ?? [''])[0])
const fresh = join(dir, 'fresh.yml')
writeFileSync(fresh, readFileSync(new URL('../profile/cordis.patch.yml', import.meta.url), 'utf8'))
execFileSync('/bin/bash', ['-c', `${(installer.match(/^\s*sed -i '' -e "s\/\^    platform: slack\$\/.*$/m) ?? ['false'])[0].replace('"$patch"', '"$1"')}`, 'bash', fresh])
check('messengers: a new profile serves the terminal alone, answering in every channel', /^    platform: \['local'\]$/m.test(readFileSync(fresh, 'utf8')) && /^    targetChannels: \['\*'\]$/m.test(readFileSync(fresh, 'utf8')), (readFileSync(fresh, 'utf8').match(/^    (platform|targetChannels): .*$/gm) ?? []).join(' | '))
check('messengers: the end says to connect one with dsh gateway setup', /Connect Slack, Telegram or Discord: .*dsh gateway setup/.test(installer))

// The language a new profile starts in: the environment's, by the POSIX order, English otherwise.
const lang = (env) => withHelpers('env_language', { LC_ALL: '', LC_MESSAGES: '', LANG: '', ...env }).out
check('language: LANG ko_KR is Korean', lang({ LANG: 'ko_KR.UTF-8' }) === 'ko', lang({ LANG: 'ko_KR.UTF-8' }))
check('language: LC_ALL zh_CN wins over LANG', lang({ LC_ALL: 'zh_CN.UTF-8', LANG: 'ko_KR.UTF-8' }) === 'zh', lang({ LC_ALL: 'zh_CN.UTF-8', LANG: 'ko_KR.UTF-8' }))
check('language: C is skipped, not English', lang({ LC_ALL: 'C', LANG: 'zh_TW.UTF-8' }) === 'zh')
check('language: en_US, an unknown one, and none are English', lang({ LANG: 'en_US.UTF-8' }) === 'en' && lang({ LANG: 'fr_FR.UTF-8' }) === 'en' && lang({}) === 'en' && lang({ LANG: 'kok_IN' }) === 'en')
const template = readFileSync(new URL('../profile/cordis.patch.yml', import.meta.url), 'utf8')
check('language: the template names it, for the installer to fill', /^    language: en$/m.test(template))
writeFileSync(join(dir, 'lang.yml'), template)
check('language: the installer writes the chosen one into the profile', withHelpers(`set_profile_language "${join(dir, 'lang.yml')}" zh`).code === 0
  && /^    language: zh$/m.test(readFileSync(join(dir, 'lang.yml'), 'utf8')) && !/^    language: en$/m.test(readFileSync(join(dir, 'lang.yml'), 'utf8')))
const launcher = join(dir, '.local', 'bin', 'dsh')
const installed = withHelpers('install_terminal /opt/checkout')
check('dsh is written to ~/.local/bin and runs the checkout\'s build', installed.code === 0 && existsSync(launcher) && readFileSync(launcher, 'utf8').includes('exec node "/opt/checkout/dist/tui/main.js" "$@"') && (statSync(launcher).mode & 0o111) !== 0, installed.out)
check('a rerun replaces its own launcher', withHelpers('install_terminal /opt/other').code === 0 && readFileSync(launcher, 'utf8').includes('/opt/other/dist/tui/main.js'))
// The harness CLI is found on the PATH as dsh too; this project's launcher there must not be taken for it.
check('the harness CLI is not this project\'s dsh', withHelpers('harness_cli', { PATH: `${join(dir, '.local', 'bin')}:/usr/bin:/bin` }).out === '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh', withHelpers('harness_cli', { PATH: `${join(dir, '.local', 'bin')}:/usr/bin:/bin` }).out)
writeFileSync(launcher, '#!/bin/sh\necho the harness\n')
check('a dsh on the PATH that is not ours is the harness CLI', withHelpers('harness_cli', { PATH: `${join(dir, '.local', 'bin')}:/usr/bin:/bin` }).out === launcher)
const kept = withHelpers('install_terminal /opt/checkout')
check('a dsh that is not ours is left as it was, and said', kept.code !== 0 && readFileSync(launcher, 'utf8') === '#!/bin/sh\necho the harness\n' && kept.out.includes('not'), kept.out)
rmSync(join(dir, '.local'), { recursive: true, force: true })

// The services read ~/.dsh; a harness home elsewhere would leave the tokens where nothing looks.
mkdirSync(join(dir, '.dsh'), { recursive: true })
check('the default harness home is accepted', withHelpers('check_dsh_home').code === 0)
check('so is DSH_HOME naming it', withHelpers('check_dsh_home', { DSH_HOME: join(dir, '.dsh') }).code === 0)
check('a DSH_HOME elsewhere is refused before anything is written', withHelpers('check_dsh_home', { DSH_HOME: join(dir, 'elsewhere') }).code !== 0)

// The health probe and the watch runner are compiled. Their installers copy the build under the names the
// plists, install.sh and the docs run, and refuse while there is no build: a copy of nothing, or of a
// stale file, is a probe that does not match the checkout. Each installer is sourced from a copy of the
// repository's layout, so "no build" is real and the copy lands in scratch directories.
const script = readFileSync(INSTALL, 'utf8')
const build = script.indexOf('build_checkout "$DEEPBOT_DIR"')
// The build, with stand-ins for pnpm and npm. npm does not read pnpm-lock.yaml and wrote a package-lock.json
// into the checkout; pnpm writes its errors and its prompts to stdout, which the installer threw away, so a
// failed install ended in nothing; and the checkout's prepare script built it a second time.
{
  const bin = join(dir, 'fake-pm')
  const checkout = join(dir, 'fake-checkout')
  const calls = join(dir, 'pm-calls')
  const build = (pnpm: string | null, npm: string) => {
    rmSync(bin, { recursive: true, force: true }); mkdirSync(bin, { recursive: true })
    rmSync(calls, { force: true }); rmSync(join(checkout, 'dist'), { recursive: true, force: true }); mkdirSync(checkout, { recursive: true })
    const stub = (name, body) => { writeFileSync(join(bin, name), `#!/bin/bash\necho "${name} $*" >> '${calls}'\n${body}\n`); chmodSync(join(bin, name), 0o755) }
    if (pnpm !== null) stub('pnpm', pnpm)
    stub('npm', `if [ "$1" = run ]; then mkdir -p dist && touch dist/index.js; exit 0; fi\n${npm}`)
    const r = withHelpers(`build_checkout '${checkout}' 2>&1`, { PATH: `${bin}:/usr/bin:/bin` })
    return { ...r, calls: existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [] }
  }
  const pnpmWorks = build('exit 0', 'exit 0')
  check('build: with pnpm, it installs from the lockfile, runs no install scripts, asks nothing, and builds once',
    pnpmWorks.code === 0 && JSON.stringify(pnpmWorks.calls) === JSON.stringify(['pnpm install --frozen-lockfile --ignore-scripts --config.confirmModulesPurge=false', 'npm run --silent build']), JSON.stringify(pnpmWorks.calls))
  const stale = build('echo " ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with frozen-lockfile"; exit 1', 'exit 0')
  check('build: a pnpm that fails is shown, on stdout as pnpm writes it, and npm is tried',
    stale.code === 0 && stale.out.includes('ERR_PNPM_OUTDATED_LOCKFILE') && stale.calls[1]?.startsWith('npm install --no-package-lock --ignore-scripts'), stale.out)
  const npmOnly = build(null, 'exit 0')
  check('build: without pnpm, npm installs with no package-lock.json and no install scripts, then builds once',
    npmOnly.code === 0 && npmOnly.calls.length === 2 && npmOnly.calls[0].startsWith('npm install --no-package-lock --ignore-scripts') && npmOnly.calls[1] === 'npm run --silent build', JSON.stringify(npmOnly.calls))
  const broken = build(null, 'echo "npm ERR! boom-4f5"; exit 1')
  check('build: an npm that fails stops the install, and says what npm said', broken.code !== 0 && broken.out.includes('npm ERR! boom-4f5') && !broken.calls.includes('npm run --silent build'), broken.out)
}
// The browse tool's browser, after the build: installed with the checkout's playwright-core; a failure is said and
// the install goes on (the bot works without a browser); a checkout without playwright-core asks for nothing.
{
  const checkout = join(dir, 'browser-checkout')
  const calls = join(dir, 'browser-calls')
  const browser = (cli: string | null, env: Record<string, string> = { DEEPBOT_NODE: process.execPath }) => {
    rmSync(checkout, { recursive: true, force: true }); rmSync(calls, { force: true })
    mkdirSync(join(checkout, 'node_modules', 'playwright-core'), { recursive: true })
    if (cli !== null) writeFileSync(join(checkout, 'node_modules', 'playwright-core', 'cli.js'), `require('fs').appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(' ') + '\\n'); ${cli}`)
    const r = withHelpers(`install_browser '${checkout}'; echo "rc=$?"`, env)
    return { ...r, calls: existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [] }
  }
  const ready = browser('process.exit(0)')
  check('browser: the headless shell is installed with the checkout\'s playwright-core', ready.out.includes('rc=0') && JSON.stringify(ready.calls) === JSON.stringify(['install chromium-headless-shell']) && /ready/.test(ready.out), ready.out)
  const failed = browser('console.log("download failed: net-7c1"); process.exit(1)')
  check('browser: a failed download is said, with how to retry, and the install goes on', failed.out.includes('rc=0') && failed.out.includes('net-7c1') && /to add it later/.test(failed.out), failed.out)
  // No node anywhere: said as that, not as an installer that said nothing.
  const noNode = browser('process.exit(0)', { DEEPBOT_NODE: '', PATH: '/usr/bin:/bin' })
  check('browser: with no node it says so, and the install goes on', noNode.out.includes('rc=0') && noNode.calls.length === 0 && /no node to install one with/.test(noNode.out) && !/installer said/.test(noNode.out), noNode.out)
  const none = browser(null)
  check('browser: without playwright-core nothing is asked for', none.out.includes('rc=0') && none.calls.length === 0 && /no playwright-core/.test(none.out), none.out)
  check('browser: it comes after the build', script.indexOf('install_browser "$DEEPBOT_DIR"') > script.indexOf('build_checkout "$DEEPBOT_DIR"'))
}
// init.sh built again what install.sh had just built. A dry run of a copy of it, so nothing is written.
{
  const copy = join(dir, 'init-copy')
  mkdirSync(join(copy, 'repo'), { recursive: true })
  copyFileSync(join(dirname(INSTALL), 'init.sh'), join(copy, 'repo', 'init.sh'))
  const dry = (installer: boolean, built: boolean) => {
    rmSync(join(copy, 'repo', 'dist'), { recursive: true, force: true })
    if (built) { mkdirSync(join(copy, 'repo', 'dist'), { recursive: true }); writeFileSync(join(copy, 'repo', 'dist', 'index.js'), '') }
    try {
      return execFileSync('/bin/bash', [join(copy, 'repo', 'init.sh'), '--dry-run', '--home', join(copy, 'home', 'agent'), '--profile', 'probe'],
        { encoding: 'utf8', env: { ...process.env, HOME: join(copy, 'home'), DSH_HOME: join(copy, 'home', '.dsh'), ...(installer ? { DEEPBOT_INSTALLER: '1' } : {}) }, stdio: 'pipe' })
    } catch (e) { return String(e.stdout ?? '') }
  }
  check('init.sh: called by the installer after its build, it does not build again', dry(true, true).includes('built   dist/ (by the installer)'))
  // It reached its build step and took the build branch (a crash would print neither line).
  const builds = (out: string) => !out.includes('(by the installer)') && /install dev dependencies|would run/.test(out)
  check('init.sh: with no build yet, or run on its own, it builds', builds(dry(true, false)) && builds(dry(false, true)))
  check('install.sh calls it as the installer', /DEEPBOT_INSTALLER=1 [^\n]*init\.sh/.test(script))
}
check('install.sh builds before the installers copy from the build',
  build !== -1 && build < script.indexOf('/service/install-health.sh"') && build < script.indexOf('/watch/install-watch.sh"'))
const repo = join(dir, 'repo')
for (const file of ['service/install-health.sh', 'service/rotate-logs.sh', 'service/confined-runner.sh', 'watch/install-watch.sh']) {
  mkdirSync(dirname(join(repo, file)), { recursive: true })
  copyFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), join(repo, file))
}
for (const [installer, built, copy, source] of [
  ['service/install-health.sh', 'dist/service/health-check.js', 'health-check.mjs', 'service/health-check.ts'],
  ['watch/install-watch.sh', 'dist/watch/watch.js', 'watch.mjs', 'watch/watch.ts'],
]) {
  // Sourced, an installer must stop before its first launchctl; one that would not is never sourced here.
  const text = readFileSync(join(repo, installer), 'utf8')
  const guard = text.search(/^if \[ "\$\{DEEPBOT_INSTALL_SOURCED:-0\}" = 1 \]; then return 0; fi$/m)
  check(`${installer}: sourced, it stops before installing anything`, guard !== -1 && guard < text.indexOf('launchctl '))
  if (guard === -1 || guard > text.indexOf('launchctl ')) continue
  const runtime = join(dir, `runtime-${copy}`)
  const copyStep = () => {
    try {
      const out = execFileSync('/bin/bash', ['-c', 'DEEPBOT_INSTALL_SOURCED=1 source "$1" && copy_runtime', 'bash', join(repo, installer)], {
        encoding: 'utf8', cwd: dir, stdio: 'pipe',
        env: { ...process.env, HOME: dir, DEEPBOT_RUNTIME_DIR: runtime, DEEPBOT_HOME: join(dir, 'agent') },
      })
      return { out: out.trim(), code: 0 }
    } catch (e) {
      return { out: String(e.stdout ?? '').trim(), code: e.status ?? 1 }
    }
  }
  const missing = copyStep()
  check(`${installer}: without a build it refuses and says to build`, missing.code !== 0 && missing.out.includes('build first: pnpm run build'), missing.out)
  check(`${installer}: and writes nothing`, !existsSync(runtime))
  // The source, older than the build that is about to be written.
  writeFileSync(join(repo, source), `// ${source}\n`)
  utimesSync(join(repo, source), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
  mkdirSync(dirname(join(repo, built)), { recursive: true })
  writeFileSync(join(repo, built), `// compiled ${built}\n`)
  const copied = copyStep()
  check(`${installer}: it copies ${built} to ${copy}`, copied.code === 0 && existsSync(join(runtime, copy)) && readFileSync(join(runtime, copy), 'utf8') === `// compiled ${built}\n`, copied.out.split('\n')[0])
  // An edit to the source after the last build: the copy would deploy what the source no longer says.
  writeFileSync(join(repo, source), `// ${source}, edited\n`)
  utimesSync(join(repo, source), new Date(Date.now() + 60_000), new Date(Date.now() + 60_000))
  writeFileSync(join(runtime, copy), 'the copy already deployed\n')
  const stale = copyStep()
  check(`${installer}: a build older than ${source} is refused, and the deployed copy is left as it was`, stale.code !== 0 && stale.out.includes('older than') && stale.out.includes('pnpm run build') && readFileSync(join(runtime, copy), 'utf8') === 'the copy already deployed\n', stale.out)
}

// The services. A fresh account may have no ~/Library/LaunchAgents: every installer used to write its plist
// into it unmade, fail, and leave install.sh to say "done".
for (const installer of ['service/install-service.sh', 'service/install-health.sh', 'watch/install-watch.sh', 'recall/install-refresh.sh']) {
  const text = readFileSync(new URL(`../${installer}`, import.meta.url), 'utf8')
  const made = text.indexOf('mkdir -p "$(dirname "$PLIST")"')
  const written = text.indexOf('cat > "$PLIST"')
  check(`${installer}: makes the LaunchAgents directory before writing the plist`, made !== -1 && written !== -1 && made < written)
}
{
  const bin = join(dir, 'fake-installers')
  mkdirSync(bin, { recursive: true })
  const script = (name, body) => { writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`); chmodSync(join(bin, name), 0o755); return join(bin, name) }
  const failing = script('fails.sh', `echo "plist written"\necho "web UI token=abc123secret"\necho " The web UI is at http://127.0.0.1:19500 — its auth token is printed"\nexit 3`)
  const passing = script('passes.sh', 'echo fine')
  const run = (line) => withHelpers(`SERVICES_FAILED=0; ${line}; echo "failed=$SERVICES_FAILED"`)
  const shown = run(`service_install "gateway service" "${failing}" show`)
  check('services: a failing installer is said to have failed, and counted', shown.out.includes('gateway service: fails.sh failed') && shown.out.endsWith('failed=1'), shown.out)
  check('services: its output is shown, the line with a credential in it is not', shown.out.includes('plist written') && !shown.out.includes('abc123secret'), shown.out)
  check('services: a line that only mentions a token is kept, so the sentence is whole', shown.out.includes('its auth token is printed'), shown.out)
  const quiet = run(`service_install "watch runner" "${passing}"`)
  check('services: one that works is said to be installed, and not counted', quiet.out.includes('watch runner installed') && quiet.out.endsWith('failed=0') && !quiet.out.includes('fine'), quiet.out)
  const summary = withHelpers('SERVICES_FAILED=2; services_done')
  check('services: with any of them failed, the install ends in failure and says how many', summary.code !== 0 && summary.out.includes('2 service'), summary.out)
  check('services: with none failed, it ends well', withHelpers('SERVICES_FAILED=0; services_done').code === 0)
  check('services: install.sh stops at a failed service instead of saying done', /services_done \|\| return 1\nrecord_install "\$DEEPBOT_DIR"\n\nstep "done"/.test(readFileSync(INSTALL, 'utf8')))
}

// The model provider of a new profile: DeepSeek's own needs no rows (dsh-base's default); OpenGateway and a
// custom OpenAI-compatible endpoint get a complete llm-pi-ai route and the default model row.
{
  const og = withHelpers('provider_rows opengateway')
  check('provider: OpenGateway gets its route, with the key ref, the endpoint, the deepseek thinking format', og.code === 0
    && /^- id: llm-pi-ai$/m.test(og.out) && /^ {6}og:$/m.test(og.out) && /^ {8}apiKeyEnv: OG_API_KEY$/m.test(og.out)
    && /^ {8}api: openai-completions$/m.test(og.out) && /^ {8}baseURL: 'https:\/\/apis\.opengateway\.ai\/v1'$/m.test(og.out) && /^ {10}thinkingFormat: deepseek$/m.test(og.out), og.out)
  check('provider: its model takes images and the four efforts, and is the default with effort medium',
    /^ {10}- id: 'deepseek\/deepseek-v4\.1-flash-ultrafast'$/m.test(og.out) && /^ {12}input: \[text, image\]$/m.test(og.out)
    && /^ {12}reasoningEfforts:\n {14}off:\n {14}low: low\n {14}medium: medium\n {14}high: high$/m.test(og.out)
    && /^- id: agent-default-model\n {2}config:\n {4}provider: og\n {4}model: 'deepseek\/deepseek-v4\.1-flash-ultrafast'\n {4}reasoningEffort: medium$/m.test(og.out), og.out)
  const custom = withHelpers(`provider_rows custom MY_KEY 'https://llm.example.com/v1' 'vendor/model-x' 200000 no`)
  check('provider: a custom endpoint gets its own route, text only when it takes no images, and no efforts it did not declare', custom.code === 0
    && /^ {6}custom:$/m.test(custom.out) && /^ {8}apiKeyEnv: MY_KEY$/m.test(custom.out) && /^ {8}baseURL: 'https:\/\/llm\.example\.com\/v1'$/m.test(custom.out)
    && /^ {12}contextWindow: 200000$/m.test(custom.out) && /^ {12}input: \[text\]$/m.test(custom.out) && !/reasoningEfforts|thinkingFormat|reasoningEffort/.test(custom.out), custom.out)
  check('provider: DeepSeek\'s own API is the answer when none is given, so an existing setup stays as it is',
    /^ {2}ask provider "[^"]*" deepseek$/m.test(readFileSync(INSTALL, 'utf8')) && withHelpers('provider_key deepseek').out === 'DEEPSEEK_API_KEY')
  const ds = withHelpers('provider_rows deepseek')
  check('provider: DeepSeek\'s own route writes nothing', ds.code === 0 && ds.out === '', JSON.stringify(ds))
  const bad = (args) => withHelpers(`valid_endpoint ${args}`).code !== 0
  check('provider: what goes into the YAML is checked — a URL with a quote, a model with a space, a bad key name, a window that is not a number',
    bad(`"https://x.example/v1'; rm" model ACME_API_KEY 1000`) && bad(`https://x.example/v1 'bad model' ACME_API_KEY 1000`) && bad(`https://x.example/v1 model 1KEY 1000`)
    && bad(`https://x.example/v1 model ACME_API_KEY lots`) && bad(`ftp://x.example model ACME_API_KEY 1000`)
    && withHelpers(`valid_endpoint https://llm.example.com/v1 vendor/model-x:free MY_KEY 128000`).code === 0)
  check('provider: a custom key name is one of its own — not a name the deployment uses, not a YAML word, and ends in _KEY',
    bad(`https://x.example/v1 model SLACK_BOT_TOKEN 1000`) && bad(`https://x.example/v1 model DEEPSEEK_API_KEY 1000`) && bad(`https://x.example/v1 model OG_API_KEY 1000`)
    && bad(`https://x.example/v1 model null 1000`) && bad(`https://x.example/v1 model PATH 1000`) && withHelpers('valid_endpoint https://x.example/v1 model ACME_API_KEY 1000').code === 0)
  check('provider: plain http only to this machine — a key would cross the network in clear text',
    bad(`http://llm.example.com/v1 model ACME_API_KEY 1000`) && withHelpers('valid_endpoint http://localhost:8080/v1 model ACME_API_KEY 1000').code === 0 && withHelpers('valid_endpoint http://127.0.0.1:8080/v1 model ACME_API_KEY 1000').code === 0)
  check('provider: the context window is written as a number, leading zeros dropped', /^ {12}contextWindow: 128000$/m.test(withHelpers(`provider_rows custom ACME_API_KEY 'https://x.example/v1' m 0128000 no`).out))
  // Shell arithmetic wraps at 2^64: 18446744073709551716 was taken and written as 100, a 20-digit window as another
  // number. A window is refused past nine digits, below any value that could wrap; leading zeros still count as none.
  check('provider: a context window too large for shell arithmetic is refused, not written as another number',
    bad(`https://x.example/v1 model ACME_API_KEY 18446744073709551716`) && bad(`https://x.example/v1 model ACME_API_KEY 99999999999999999999`)
    && bad(`https://x.example/v1 model ACME_API_KEY 1000000000`) && bad(`https://x.example/v1 model ACME_API_KEY 0`)
    && withHelpers('valid_endpoint https://x.example/v1 model ACME_API_KEY 999999999').code === 0
    && withHelpers('valid_endpoint https://x.example/v1 model ACME_API_KEY 000000000000128000').code === 0
    && /^ {6}valid_window "\$window" \|\| die "context window: [^"]*\(got: \$window\)"$/m.test(readFileSync(INSTALL, 'utf8')))
  // A rerun reads the key of the route the default model names, whatever the comments, the indent, or other routes.
  writeFileSync(join(dir, 'two-routes.yml'), `- id: llm-pi-ai\n  config:\n    providers:\n      speech:\n        apiKeyEnv: OPENAI_API_KEY\n      og:\n          apiKeyEnv: OG_API_KEY   # the gateway\n\n- id: agent-default-model\n  config:\n    provider: og\n    model: x\n`)
  check('provider: a route key that is not a variable name is not asked for or written', withHelpers('usable_key_name "!!js process.env.X"').code !== 0 && withHelpers('usable_key_name OG_API_KEY').code === 0)
  check('provider: a rerun reads the key of the default model\'s route, past comments, indents and other routes', withHelpers(`profile_key "${join(dir, 'two-routes.yml')}"`).out === 'OG_API_KEY', withHelpers(`profile_key "${join(dir, 'two-routes.yml')}"`).out)
  // A route key written in quotes, and a row right after the default model that is not an `- id:` row (an
  // `- insert:` with a provider of its own): both used to fall back to DEEPSEEK_API_KEY or another route's key.
  writeFileSync(join(dir, 'quoted.yml'), `- id: llm-pi-ai\n  config:\n    providers:\n      'og':\n        apiKeyEnv: OG_API_KEY\n- id: agent-default-model\n  config:\n    provider: "og"\n`)
  check('provider: a quoted route key and a quoted provider are read', withHelpers(`profile_key "${join(dir, 'quoted.yml')}"`).out === 'OG_API_KEY', withHelpers(`profile_key "${join(dir, 'quoted.yml')}"`).out)
  // Only `- id:` reset the route search: a `- name:` row with routes of its own between them gave its key.
  // (llm-pi-ai's own og route names no key here, so the first key found cannot be its own by accident.)
  writeFileSync(join(dir, 'name-between.yml'), `- id: llm-pi-ai\n  config:\n    providers:\n      og:\n        baseUrl: x\n- name: tts\n  config:\n    providers:\n      og:\n        apiKeyEnv: TTS_KEY\n- id: agent-default-model\n  config:\n    provider: og\n`)
  check('provider: routes in a row that is not llm-pi-ai are not its routes', withHelpers(`profile_key "${join(dir, 'name-between.yml')}"`).out === 'DEEPSEEK_API_KEY', withHelpers(`profile_key "${join(dir, 'name-between.yml')}"`).out)
  // A route with no key followed by one written with an anchor: the anchored one's key was taken for it.
  writeFileSync(join(dir, 'anchor.yml'), `- id: llm-pi-ai\n  config:\n    providers:\n      og:\n        baseUrl: x\n      og2: &o2\n        apiKeyEnv: OG2_KEY\n- id: agent-default-model\n  config:\n    provider: og\n`)
  check('provider: another route\'s key is not taken for a route with none', withHelpers(`profile_key "${join(dir, 'anchor.yml')}"`).out === 'DEEPSEEK_API_KEY', withHelpers(`profile_key "${join(dir, 'anchor.yml')}"`).out)
  // A provider nested deeper in the default model's config was taken for the model's own.
  writeFileSync(join(dir, 'nested.yml'), `- id: llm-pi-ai\n  config:\n    providers:\n      og:\n        apiKeyEnv: OG_API_KEY\n      og2:\n        apiKeyEnv: OG2_KEY\n- id: agent-default-model\n  config:\n    provider: og\n    fallback:\n      provider: og2\n`)
  check('provider: a provider nested in the default model\'s config is not the model\'s', withHelpers(`profile_key "${join(dir, 'nested.yml')}"`).out === 'OG_API_KEY', withHelpers(`profile_key "${join(dir, 'nested.yml')}"`).out)
  // The harness keeps the last row of an id (a config block replaces the whole config): the last default model,
  // and the last llm-pi-ai's routes.
  writeFileSync(join(dir, 'two-rows.yml'), `- id: llm-pi-ai\n  config:\n    providers:\n      og:\n        apiKeyEnv: OG_API_KEY\n      custom:\n        apiKeyEnv: CUSTOM_API_KEY\n- id: agent-default-model\n  config:\n    provider: og\n- id: agent-default-model\n  config:\n    provider: custom\n`)
  check('provider: of two default-model rows, the last is the model', withHelpers(`profile_key "${join(dir, 'two-rows.yml')}"`).out === 'CUSTOM_API_KEY', withHelpers(`profile_key "${join(dir, 'two-rows.yml')}"`).out)
  writeFileSync(join(dir, 'two-routes-rows.yml'), `- id: llm-pi-ai\n  config:\n    providers:\n      og:\n        apiKeyEnv: OG_API_KEY\n- id: llm-pi-ai\n  config:\n    providers:\n      og:\n        apiKeyEnv: OG_NEW_KEY\n- id: agent-default-model\n  config:\n    provider: og\n`)
  check('provider: of two llm-pi-ai rows, the last one\'s routes count', withHelpers(`profile_key "${join(dir, 'two-routes-rows.yml')}"`).out === 'OG_NEW_KEY', withHelpers(`profile_key "${join(dir, 'two-routes-rows.yml')}"`).out)
  // And a route the last row no longer has is gone, not kept from the row before.
  writeFileSync(join(dir, 'route-gone.yml'), `- id: llm-pi-ai\n  config:\n    providers:\n      og:\n        apiKeyEnv: OG_API_KEY\n- id: llm-pi-ai\n  config:\n    providers:\n      other:\n        apiKeyEnv: OTHER_KEY\n- id: agent-default-model\n  config:\n    provider: og\n`)
  check('provider: a route the last llm-pi-ai row dropped is not read from the row before', withHelpers(`profile_key "${join(dir, 'route-gone.yml')}"`).out === 'DEEPSEEK_API_KEY', withHelpers(`profile_key "${join(dir, 'route-gone.yml')}"`).out)
  // Only the route's own key: one deeper (a model entry's) is not it.
  writeFileSync(join(dir, 'inner-key.yml'), `- id: llm-pi-ai\n  config:\n    providers:\n      og:\n        apiKeyEnv: OG_API_KEY\n        models:\n          - id: m\n            apiKeyEnv: INNER_KEY\n- id: agent-default-model\n  config:\n    provider: og\n`)
  check('provider: a key nested under the route is not the route\'s', withHelpers(`profile_key "${join(dir, 'inner-key.yml')}"`).out === 'OG_API_KEY', withHelpers(`profile_key "${join(dir, 'inner-key.yml')}"`).out)
  writeFileSync(join(dir, 'quoted-id.yml'), `- id: 'llm-pi-ai'\n  config:\n    providers:\n      og:\n        apiKeyEnv: OG_API_KEY\n- id: "agent-default-model"\n  config:\n    provider: og\n`)
  check('provider: quoted ids are read', withHelpers(`profile_key "${join(dir, 'quoted-id.yml')}"`).out === 'OG_API_KEY', withHelpers(`profile_key "${join(dir, 'quoted-id.yml')}"`).out)
  writeFileSync(join(dir, 'insert-after.yml'), `- id: llm-pi-ai\n  config:\n    providers:\n      og:\n        apiKeyEnv: OG_API_KEY\n      speech:\n        apiKeyEnv: OPENAI_API_KEY\n- id: agent-default-model\n  config:\n    provider: og\n- insert:\n    - id: tts\n      config:\n        provider: speech\n`)
  check('provider: a provider in a row after the default model is not taken for its own', withHelpers(`profile_key "${join(dir, 'insert-after.yml')}"`).out === 'OG_API_KEY', withHelpers(`profile_key "${join(dir, 'insert-after.yml')}"`).out)
  writeFileSync(join(dir, 'with-og.yml'), `- id: deepbot\n  config:\n    platform: slack\n${og.out}\n`)
  check('provider: a rerun reads back the key the profile names, and DeepSeek\'s when it names none',
    withHelpers(`profile_key "${join(dir, 'with-og.yml')}"`).out === 'OG_API_KEY' && withHelpers(`profile_key "${join(dir, 'missing.yml')}"`).out === 'DEEPSEEK_API_KEY')
  // Where the harness is installed, the rows must compose: the template plus them, through dsh itself.
  const DSH = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
  if (existsSync(DSH)) {
    const home = join(dir, 'dsh-home'), prof = join(home, 'profiles', 'composed')
    mkdirSync(prof, { recursive: true })
    for (const f of ['package.json', 'cordis.patch.yml']) copyFileSync(new URL(`../profile/${f}`, import.meta.url), join(prof, f))
    writeFileSync(join(prof, 'cordis.patch.yml'), readFileSync(join(prof, 'cordis.patch.yml'), 'utf8') + og.out + '\n')
    let dump = ''
    try { dump = execFileSync(DSH, ['--profile', 'composed', '--dump-config'], { encoding: 'utf8', env: { ...process.env, DSH_HOME: home }, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }) } catch (e) { dump = `__ERROR__ ${String(e.stderr ?? e.message).slice(0, 300)}` }
    // dsh composes without mounting, so this proves the YAML parses and the rows land, not that the values are valid:
    // that is the live profile, which runs on the same route.
    check('provider: the template with the OpenGateway rows parses and composes, and the default model is og', !dump.startsWith('__ERROR__') && !/ValidationError/.test(dump)
      && /provider: og/.test(dump) && /apis\.opengateway\.ai/.test(dump), dump.slice(0, 200))
  } else {
    console.log('  TODO  provider: composing the rows with dsh needs DeepSeek Harness installed; not run here')
  }
}

// Keys the harness already resolves are used, not asked for again: its order is the launch environment, the
// app's own store (~/.dsh/.credentials.yaml, under `refs`), then ~/.dsh/.env. Names only — no value is read out.
{
  const dsh = join(dir, 'chain', '.dsh')
  mkdirSync(dsh, { recursive: true })
  writeFileSync(join(dsh, '.credentials.yaml'), 'version: 1\n\nrefs:\n  OG_API_KEY: og-stored-value\n\nrecords:\n  llm-pi-ai/x:\n    kind: grant\n    payload:\n      SLACK_BOT_TOKEN: not-a-ref\n')
  writeFileSync(join(dsh, '.env'), 'DEEPSEEK_API_KEY=dk-dotenv-value\n')
  // The suite's own shell may export these: each lookup starts with them unset, unless a check sets one.
  const clean = { DEEPSEEK_API_KEY: '', OG_API_KEY: '', SLACK_BOT_TOKEN: '', SLACK_APP_TOKEN: '', TELEGRAM_BOT_TOKEN: '', CUSTOM_API_KEY: '' }
  const src = (name, env = {}) => withHelpers(`DSH_HOME="${dsh}"; key_source ${name}`, { DSH_HOME: dsh, ...clean, ...env }).out
  check('credentials: a key in the app\'s store is found there', src('OG_API_KEY') === 'store', src('OG_API_KEY'))
  check('credentials: one only under a record, not a ref, is not taken for a key', src('SLACK_BOT_TOKEN') === '', src('SLACK_BOT_TOKEN'))
  check('credentials: one in ~/.dsh/.env is found there', src('DEEPSEEK_API_KEY') === 'dotenv')
  check('credentials: the launch environment comes first', src('OG_API_KEY', { OG_API_KEY: 'from-env' }) === 'env')
  check('credentials: one set nowhere is not found', src('TELEGRAM_BOT_TOKEN') === '')
  // The store is YAML: a comment does not end refs at any indent; a key may be quoted or spaced; refs may be a flow mapping.
  const shapes = [
    ['refs:\n  A_KEY: x\n# a note\n  B_KEY: y\n', 'B_KEY'],
    ['refs:\n\n  "Q_KEY": x\n', 'Q_KEY'],
    ["refs:\n  'S_KEY' : x\n", 'S_KEY'],
    ['refs: { F_KEY: x, G_KEY: y }\n', 'G_KEY'],
  ]
  const wrong = shapes.filter(([yaml, name]) => {
    writeFileSync(join(dsh, '.credentials.yaml'), `version: 1\n${yaml}records: {}\n`)
    return src(name) !== 'store'
  }).map(([, name]) => name)
  writeFileSync(join(dsh, '.credentials.yaml'), 'version: 1\nrefs: { F_KEY: x }\nrecords:\n  r:\n    G_KEY: not-a-ref\n')
  check('credentials: the store is read as YAML — past comments, quoted and spaced keys, a flow mapping; still not records', wrong.length === 0 && src('G_KEY') === '', wrong.join(', ') || src('G_KEY'))
  writeFileSync(join(dsh, '.credentials.yaml'), 'version: 1\n\nrefs:\n  OG_API_KEY: og-stored-value\n\nrecords:\n  llm-pi-ai/x:\n    kind: grant\n    payload:\n      SLACK_BOT_TOKEN: not-a-ref\n')
  const stored = withHelpers(`DSH_HOME="${dsh}"; put_key OG_API_KEY "OpenGateway API key:"`, { DSH_HOME: dsh, ...clean })
  check('credentials: put_key does not ask for a key the store has, says where it is, and writes nothing', stored.code === 0 && /OG_API_KEY/.test(stored.out) && /credentials\.yaml/.test(stored.out)
    && !readFileSync(join(dsh, '.env'), 'utf8').includes('OG_API_KEY') && !stored.out.includes('og-stored-value'), stored.out)
  // A key only in this shell may have been exported for something else (an OpenAI key, another app's token):
  // it is used only when the person says so, and with no terminal to ask, it is not.
  const fromEnv = withHelpers(`DSH_HOME="${dsh}"; put_key CUSTOM_API_KEY "key:"`, { DSH_HOME: dsh, ...clean, CUSTOM_API_KEY: 'from-the-shell' })
  check('credentials: one only in this shell is not copied without a yes, nor echoed',
    fromEnv.code === 0 && !readFileSync(join(dsh, '.env'), 'utf8').includes('from-the-shell') && !fromEnv.out.includes('from-the-shell') && /CUSTOM_API_KEY/.test(fromEnv.out), fromEnv.out)
  check('credentials: nothing is written to the app\'s store', readFileSync(join(dsh, '.credentials.yaml'), 'utf8') === 'version: 1\n\nrefs:\n  OG_API_KEY: og-stored-value\n\nrecords:\n  llm-pi-ai/x:\n    kind: grant\n    payload:\n      SLACK_BOT_TOKEN: not-a-ref\n')
}

// An update (a rerun, or `dsh update`): the checkout moves to the ref's tip without losing anyone's work, the
// service keeps the agent home and profile it was installed with, and a finished install is recorded.
{
  const root = mkdtempSync(join(tmpdir(), 'deepbot-fetch-'))
  writeFileSync(join(root, 'gitconfig'), '')
  const gitEnv = {
    GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
  }
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, ...gitEnv } }).trim()
  const commit = (cwd, file, text) => { writeFileSync(join(cwd, file), text); git(cwd, 'add', file); git(cwd, 'commit', '-q', '-m', file) }
  /** fetch_checkout on a checkout; stderr is where die speaks. */
  const fetchIn = (checkout, ref = 'master') => {
    const r = spawnSync('/bin/bash', ['-c', 'DEEPBOT_INSTALL_SOURCED=1 source "$1"; fetch_checkout "$2" "$3"', 'bash', INSTALL, checkout, ref], { encoding: 'utf8', env: { ...process.env, ...gitEnv } })
    return { code: r.status, err: r.stderr }
  }
  const origin = join(root, 'origin.git'), work = join(root, 'work')
  git(root, 'init', '-q', '--bare', '-b', 'master', origin)
  git(root, 'init', '-q', '-b', 'master', work)
  commit(work, 'a', '1\n')
  git(work, 'push', '-q', origin, 'master')
  const full = join(root, 'full'), shallow = join(root, 'shallow')
  git(root, 'clone', '-q', origin, full)
  git(root, 'clone', '-q', '--depth', '1', `file://${origin}`, shallow)
  commit(work, 'b', '2\n')
  git(work, 'push', '-q', origin, 'master')
  const tip = git(work, 'rev-parse', 'HEAD')

  const moved = fetchIn(full)
  check('fetch: a full clone moves forward to the tip', moved.code === 0 && git(full, 'rev-parse', 'HEAD') === tip, moved.err)
  check('fetch: and stays a full clone (no --depth 1 on someone\'s working copy)', git(full, 'rev-parse', '--is-shallow-repository') === 'false')
  const fromShallow = fetchIn(shallow)
  check('fetch: the installer\'s shallow clone is brought to the tip and stays shallow', fromShallow.code === 0 && git(shallow, 'rev-parse', 'HEAD') === tip && git(shallow, 'rev-parse', '--is-shallow-repository') === 'true', fromShallow.err)

  commit(work, 'c', '3\n')
  git(work, 'push', '-q', origin, 'master')
  writeFileSync(join(full, 'a'), 'edited\n')
  const dirty = fetchIn(full)
  check('fetch: local changes stop it, and are left as they were', dirty.code !== 0 && /local changes/.test(dirty.err) && readFileSync(join(full, 'a'), 'utf8') === 'edited\n' && git(full, 'rev-parse', 'HEAD') === tip, dirty.err.trim())
  git(full, 'checkout', '-q', '--', 'a')
  git(full, 'checkout', '-q', '-b', 'feature')
  const elsewhere = fetchIn(full)
  check('fetch: a checkout on another branch is not switched', elsewhere.code !== 0 && /on feature, not master/.test(elsewhere.err) && git(full, 'symbolic-ref', '--short', 'HEAD') === 'feature', elsewhere.err.trim())
  git(full, 'checkout', '-q', 'master')
  commit(full, 'local', 'mine\n')
  const mine = git(full, 'rev-parse', 'HEAD')
  const diverged = fetchIn(full)
  check('fetch: commits not on origin stop it, and are kept', diverged.code !== 0 && /not on origin/.test(diverged.err) && git(full, 'rev-parse', 'HEAD') === mine, diverged.err.trim())

  // The settings a rerun installs with: the environment's, else the installed service's, else the default.
  const home = join(root, 'home')
  const setting = (key, env = {}) => withHelpers(`setting ${key} fallback`, { HOME: home, DEEPBOT_HOME: '', DEEPBOT_PROFILE: '', ...env }).out
  check('setting: with no service installed, the default', setting('DEEPBOT_PROFILE') === 'fallback')
  mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true })
  writeFileSync(join(home, 'Library', 'LaunchAgents', 'ai.deepbot.gateway.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>EnvironmentVariables</key><dict>
<key>DEEPBOT_PROFILE</key><string>work</string><key>DEEPBOT_HOME</key><string>/elsewhere/agent</string>
</dict></dict></plist>
`)
  check('setting: a rerun keeps the installed service\'s profile and agent home', setting('DEEPBOT_PROFILE') === 'work' && setting('DEEPBOT_HOME') === '/elsewhere/agent', `${setting('DEEPBOT_PROFILE')} ${setting('DEEPBOT_HOME')}`)
  check('setting: one given in the environment wins', setting('DEEPBOT_PROFILE', { DEEPBOT_PROFILE: 'given' }) === 'given')
  check('setting: main takes both from it', /^DEEPBOT_HOME="\$\(setting DEEPBOT_HOME "\$HOME\/dsh-agent"\)"$/m.test(installer) && /^DEEPBOT_PROFILE="\$\(setting DEEPBOT_PROFILE agent\)"$/m.test(installer))

  // The record of a finished install: written after the services are in, and only then.
  const dshHome = join(root, 'dsh')
  withHelpers(`DSH_HOME="${dshHome}"; record_install "${full}"`, gitEnv)
  check('record: the commit an install finished at is written', readFileSync(join(dshHome, 'service', 'deepbot.commit'), 'utf8').trim() === mine)
  const afterServices = installer.indexOf('services_done || return 1\nrecord_install "$DEEPBOT_DIR"')
  check('record: only after every service is in, and when they are skipped', afterServices !== -1 && /record_install "\$DEEPBOT_DIR"\n  return 0\nfi/.test(installer))
  check('the end says how to update: dsh update where dsh is this project\'s on the PATH, the install line where not',
    /^    Update later: \$update_with$/m.test(installer) && /^update_with='the same curl line again'$/m.test(installer)
    && /^  \[ "\$\(command -v dsh 2>\/dev\/null \|\| true\)" = "\$launcher" \] && update_with="\$\{bold\}dsh update\$\{off\}"$/m.test(installer))
  check('a linked worktree, whose .git is a file, is a checkout to update', /^if \[ -e "\$DEEPBOT_DIR\/\.git" \]; then$/m.test(installer))
  rmSync(root, { recursive: true, force: true })
}

// The daily scenario run. Its job started /bin/bash on run-scenarios.sh in a checkout under ~/Desktop, and macOS
// closed the checkout to it ("Operation not permitted"): no run happened for days, and nothing said so but a log.
// The job now starts node, which starts the script; the job's own directory is outside the checkout.
{
  const installer = fileURLToPath(new URL('../service/install-scenarios.sh', import.meta.url))
  const text = readFileSync(installer, 'utf8')
  const guard = text.search(/^if \[ "\$\{DEEPBOT_INSTALL_SOURCED:-0\}" = 1 \]; then return 0; fi$/m)
  check('scenarios: sourced, it stops before installing anything', guard !== -1 && guard < text.indexOf('launchctl '))
  check('scenarios: install.sh does not run it (every scenario is a real model\'s turn)', !readFileSync(new URL('../install.sh', import.meta.url), 'utf8').includes('install-scenarios'))
}
// Sourced only when it would stop before launchctl: a test never installs anything.
if (/^if \[ "\$\{DEEPBOT_INSTALL_SOURCED:-0\}" = 1 \]; then return 0; fi$/m.test(readFileSync(new URL('../service/install-scenarios.sh', import.meta.url), 'utf8'))) {
  const installer = fileURLToPath(new URL('../service/install-scenarios.sh', import.meta.url))
  const text = readFileSync(installer, 'utf8')
  const home = join(dir, 'scenarios-home')
  mkdirSync(join(home, 'Library/LaunchAgents'), { recursive: true })
  const plist = (env = {}) => execFileSync('/bin/bash', ['-c', 'DEEPBOT_INSTALL_SOURCED=1 source "$1" && plist_xml', 'bash', installer], {
    encoding: 'utf8', env: { ...process.env, HOME: home, DEEPBOT_NODE: '/opt/node/bin/node', HOUR: '', MINUTE: '', ...env },
  })
  const field = (xml, key) => (new RegExp(`<key>${key}</key>\\s*<(?:string|integer)>([^<]*)<`).exec(xml) ?? [])[1]
  const args = (xml) => [...(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml)?.[1] ?? '').matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1])
  const xml = plist()
  const repoDir = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
  check('scenarios: the job starts node, not a shell', args(xml)[0] === '/opt/node/bin/node' && args(xml)[1] === '-e', JSON.stringify(args(xml).slice(0, 2)))
  check('scenarios: the job\'s own directory is outside the checkout', field(xml, 'WorkingDirectory') === join(home, '.dsh/service'), field(xml, 'WorkingDirectory'))
  check('scenarios: it names the checkout, and every day at 09:30 unless told', field(xml, 'DEEPBOT_REPO') === repoDir && field(xml, 'Hour') === '9' && field(xml, 'Minute') === '30', `${field(xml, 'DEEPBOT_REPO')} ${field(xml, 'Hour')}:${field(xml, 'Minute')}`)
  writeFileSync(join(home, 'Library/LaunchAgents/ai.deepbot.scenarios.plist'), plist({ HOUR: '6', MINUTE: '5' }))
  const again = plist()
  check('scenarios: run again with nothing set, it keeps the installed schedule', field(again, 'Hour') === '6' && field(again, 'Minute') === '5', `${field(again, 'Hour')}:${field(again, 'Minute')}`)
  check('scenarios: the plist is valid', spawnSync('plutil', ['-lint', join(home, 'Library/LaunchAgents/ai.deepbot.scenarios.plist')]).status === 0)
  // What node runs: the checkout's run-scenarios.sh, from the checkout, with its exit status the job's.
  const fake = join(dir, 'scenarios-repo')
  mkdirSync(join(fake, 'service'), { recursive: true })
  writeFileSync(join(fake, 'service/run-scenarios.sh'), 'pwd > "$OUT"\nexit 3\n')
  const out = join(dir, 'scenarios-cwd.txt')
  const run = spawnSync(process.execPath, ['-e', args(xml)[2]], { env: { ...process.env, DEEPBOT_REPO: fake, OUT: out }, cwd: dir })
  // A checkout that is not there (moved, or closed to node): the job fails, and says why in its error log.
  const gone = spawnSync(process.execPath, ['-e', args(xml)[2]], { env: { ...process.env, DEEPBOT_REPO: join(dir, 'no-such-checkout') }, cwd: dir, encoding: 'utf8' })
  check('scenarios: a run that cannot start fails and says so on stderr', gone.status !== 0 && /could not start in .*no-such-checkout/.test(gone.stderr), `status ${gone.status}, stderr ${JSON.stringify(gone.stderr)}`)
  // A time the job cannot fire at is refused before anything is written; a leading zero is a number.
  const time = (h, m) => spawnSync('/bin/bash', ['-c', 'DEEPBOT_INSTALL_SOURCED=1 source "$1" && check_time && echo "$HOUR:$MINUTE"', 'bash', installer], { encoding: 'utf8', env: { ...process.env, HOME: home, HOUR: h, MINUTE: m } })
  const bad = [['24', '0'], ['9am', '0'], ['9', '60']].map(([h, m]) => time(h, m))
  check('scenarios: an hour or minute the job cannot fire at is refused', bad.every((r) => r.status !== 0 && /HOUR must be/.test(r.stdout)), bad.map((r) => `${r.status} ${r.stdout.trim()}`).join(' | '))
  check('scenarios: 09:08 is nine and eight', time('09', '08').stdout.trim() === '9:8', JSON.stringify(time('09', '08').stdout))
  const order = ['check_time || exit 1', 'plist_xml > "$NEW"', 'plutil -lint "$NEW"', 'mv "$NEW" "$PLIST"'].map((step) => text.indexOf(step))
  check('scenarios: the time is checked, then the new plist, before it takes the installed one\'s place', order.every((i, n) => i !== -1 && (n === 0 || i > order[n - 1])), JSON.stringify(order))
  check('scenarios: node runs the checkout\'s script there, and its status is the job\'s', run.status === 3 && existsSync(out) && readFileSync(out, 'utf8').trim().endsWith('/scenarios-repo'), `status ${run.status}, cwd ${existsSync(out) ? readFileSync(out, 'utf8').trim() : '(none)'}`)
}

// The DeepSeek Harness app, when it is missing: offered from DeepSeek's own feed, for this Mac, and placed only
// when the bytes are the feed's; without a terminal nothing that large is downloaded on an assumption. Checked
// against a feed and an archive of this suite's own, through file:// URLs, so nothing here reaches the network;
// the question is driven in a pty by expect, which macOS ships.
if (process.platform === 'darwin') {
  const feedOf = (m: string) => withHelpers(`harness_feed ${m} 2>&1`)
  check('harness: the feed is the arm64 build\'s on an arm64 Mac, the x64 build\'s on an Intel one, none for another',
    feedOf('arm64').out === 'https://download.deepseek.com/dsh-desk/feeds/mac-arm64/nightly-mac.yml' && feedOf('x86_64').out === 'https://download.deepseek.com/dsh-desk/feeds/mac-x64/nightly-mac.yml' && feedOf('i386').code !== 0 && /no DeepSeek Harness build for i386/.test(feedOf('i386').out), `${feedOf('arm64').out} | ${feedOf('i386').out}`)
  check('harness: with no machine named, it is this Mac\'s', /^https:\/\/download\.deepseek\.com\/dsh-desk\/feeds\/mac-(arm64|x64)\/nightly-mac\.yml$/.test(withHelpers('harness_feed').out), withHelpers('harness_feed').out)
  // The feed the installed app updates from, where there is one: the installer's must be the same server and channel.
  const updateYml = '/Applications/DeepSeek Harness.app/Contents/Resources/app-update.yml'
  if (existsSync(updateYml)) {
    const yml = readFileSync(updateYml, 'utf8')
    const url = (yml.match(/^url: (\S+)/m) ?? [])[1] ?? ''
    const channel = (yml.match(/^channel: (\S+)/m) ?? [])[1] ?? ''
    check('harness: the feed is the one the installed app updates from (its app-update.yml)', url.startsWith('https://download.deepseek.com/dsh-desk/feeds/mac-') && feedOf(url.includes('mac-arm64') ? 'arm64' : 'x86_64').out === `${url}${channel}-mac.yml`, `${url} ${channel}`)
  } else console.log('  TODO  harness: no DeepSeek Harness app here to compare the feed with')

  // An app of this suite's own, zipped as electron-builder zips the real one: the bundle at the archive's top.
  const stage = join(dir, 'harness-stage')
  const cli = join(stage, 'DeepSeek Harness.app', 'Contents', 'Resources', 'runtime', 'cli', 'bin', 'dsh')
  mkdirSync(dirname(cli), { recursive: true })
  writeFileSync(cli, '#!/bin/sh\necho 9.9.9-test\n'); chmodSync(cli, 0o755)
  const zip = join(dir, 'harness.zip')
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', join(stage, 'DeepSeek Harness.app'), zip])
  const sha512 = (file: string) => execFileSync('/bin/bash', ['-c', 'openssl dgst -sha512 -binary "$1" | base64 | tr -d "\\n"', 'bash', file], { encoding: 'utf8' }).trim()
  const sum = sha512(zip), size = statSync(zip).size
  // A feed laid out as electron-builder writes the real one: the file's url, sha512 and size under `files`, then
  // `path` and `sha512` again at the top level; a long value folded onto the line after its key, or not.
  const feedFile = (name: string, f: { url: string, sum: string, size: number, folded?: boolean }) => {
    const v = (key: string, value: string, indent: string) => f.folded ? `${key}: >-\n${indent}  ${value}` : `${key}: ${value}`
    writeFileSync(join(dir, name), `version: 9.9.9-test\nfiles:\n  - ${v('url', f.url, '    ')}\n    ${v('sha512', f.sum, '    ')}\n    size: ${f.size}\n${v('path', f.url, '')}\n${v('sha512', f.sum, '')}\nreleaseDate: '2026-01-01T00:00:00.000Z'\n`)
    return `file://${join(dir, name)}`
  }
  const good = { url: `file://${zip}`, sum, size }
  const feed = feedFile('feed.yml', { ...good, folded: true })
  const inline = feedFile('inline.yml', good)
  const release = (url: string) => withHelpers(`harness_release '${url}' 2>&1`)
  check('harness: the feed is read — url, sha512, size and version — folded onto the next line or on the key\'s line', release(feed).out === `file://${zip} ${sum} ${size} 9.9.9-test` && release(inline).out === release(feed).out, release(feed).out)
  const http = feedFile('http.yml', { ...good, url: 'http://x.invalid/h.zip' })
  const noHash = feedFile('no-hash.yml', { ...good, sum: 'not-a-hash' })
  const unreadable = `file://${join(dir, 'no-such-feed.yml')}`
  check('harness: a feed with an http url, a hash that is not one, or none at all is refused', release(http).code !== 0 && release(noHash).code !== 0 && release(unreadable).code !== 0 && /could not read/.test(release(unreadable).out) && /does not name a build/.test(release(http).out), `${release(http).out} | ${release(noHash).out}`)

  const apps = join(dir, 'Applications'); mkdirSync(apps)
  const placedCli = join(apps, 'DeepSeek Harness.app', 'Contents', 'Resources', 'runtime', 'cli', 'bin', 'dsh')
  const placed = () => existsSync(placedCli)
  const runsPlaced = () => placed() && execFileSync(placedCli, { encoding: 'utf8' }).trim() === '9.9.9-test'
  const ensure = (env: Record<string, string>, url = feed) => withHelpers(`ensure_harness '${url}' '${apps}' 2>&1`, { TTY: '', DEEPBOT_INSTALL_HARNESS: '', ...env })
  const noTerminal = ensure({})
  check('harness: without a terminal and nothing set, nothing is downloaded, and it says to run with DEEPBOT_INSTALL_HARNESS=1', noTerminal.code !== 0 && !placed() && noTerminal.out.includes('| DEEPBOT_INSTALL_HARNESS=1 bash') && noTerminal.out.includes('DSH_BIN'), noTerminal.out)
  const never = ensure({ DEEPBOT_INSTALL_HARNESS: '0' })
  check('harness: DEEPBOT_INSTALL_HARNESS=0 never installs it, and says so', never.code !== 0 && !placed() && /DEEPBOT_INSTALL_HARNESS=0/.test(never.out), never.out)
  const odd = ensure({ DEEPBOT_INSTALL_HARNESS: 'maybe' })
  check('harness: another value is refused, with what the two mean', odd.code !== 0 && !placed() && /1 installs .* 0 never/.test(odd.out), odd.out)
  const told = ensure({ DEEPBOT_INSTALL_HARNESS: '1' })
  check('harness: DEEPBOT_INSTALL_HARNESS=1 downloads, checks and places the app, whose CLI runs', told.code === 0 && runsPlaced() && told.out.includes("checked against the feed's sha512"), told.out)
  const again = ensure({ DEEPBOT_INSTALL_HARNESS: '1' })
  check('harness: an app already there is not replaced', again.code !== 0 && /exists already/.test(again.out) && runsPlaced(), again.out)
  rmSync(join(apps, 'DeepSeek Harness.app'), { recursive: true, force: true })
  // A feed that reads well, whose archive is not what it says: the download happens, and the check refuses it.
  const wrongSum = ensure({ DEEPBOT_INSTALL_HARNESS: '1' }, feedFile('tampered.yml', { ...good, sum: `${'A'.repeat(86)}==` }))
  const wrongSize = ensure({ DEEPBOT_INSTALL_HARNESS: '1' }, feedFile('size.yml', { ...good, size: size + 1 }))
  const notTheBuild = (r: { out: string, code: number }) => r.code !== 0 && /downloading/.test(r.out) && /not the build the feed describes/.test(r.out)
  check('harness: a download whose sha512 or size is not the feed\'s is not placed', notTheBuild(wrongSum) && notTheBuild(wrongSize) && !placed(), `${wrongSum.out} | ${wrongSize.out}`)
  // An archive that is not the app at its top (zipped without the bundle as parent: Contents/ is the top).
  const other = join(dir, 'other.zip')
  execFileSync('/usr/bin/ditto', ['-c', '-k', join(stage, 'DeepSeek Harness.app'), other])
  const notApp = ensure({ DEEPBOT_INSTALL_HARNESS: '1' }, feedFile('other.yml', { url: `file://${other}`, sum: sha512(other), size: statSync(other).size }))
  check('harness: an archive that does not hold the app with its CLI is not placed', notApp.code !== 0 && /checked against/.test(notApp.out) && /does not hold/.test(notApp.out) && !placed(), notApp.out)
  const unwritable = join(dir, 'Applications-ro'); mkdirSync(unwritable); chmodSync(unwritable, 0o555)
  const readOnly = withHelpers(`ensure_harness '${feed}' '${unwritable}' 2>&1`, { TTY: '', DEEPBOT_INSTALL_HARNESS: '1' })
  check('harness: a place it cannot write is said, before anything is downloaded', readOnly.code !== 0 && /not writable/.test(readOnly.out) && !/downloading/.test(readOnly.out), readOnly.out)
  chmodSync(unwritable, 0o755)

  // At a terminal: asked, Enter is yes, n is no. Driven in a pty, since the question reads /dev/tty.
  if (existsSync('/usr/bin/expect')) {
    const atTerminal = (reply: string) => {
      rmSync(join(apps, 'DeepSeek Harness.app'), { recursive: true, force: true })
      // set +e: sourced, the installer's own set -e would end the shell at a refusal, before the status is printed.
      writeFileSync(join(dir, 'ask.exp'), `set timeout 60\nspawn /bin/bash -c "DEEPBOT_INSTALL_SOURCED=1 source '${INSTALL}'; set +e; TTY=/dev/tty DEEPBOT_INSTALL_HARNESS= ensure_harness '${feed}' '${apps}'; echo EXIT=\\$?"\nexpect "(Y/n)?"\nsend "${reply}\\r"\nexpect eof\n`)
      const r = spawnSync('/usr/bin/expect', [join(dir, 'ask.exp')], { encoding: 'utf8', cwd: dir, env: { ...process.env, HOME: dir } })
      return (r.stdout ?? '') + (r.stderr ?? '')
    }
    const no = atTerminal('n')
    check('harness: at a terminal it asks, and n installs nothing and says what to do instead', /EXIT=1/.test(no) && !placed() && /\(Y\/n\)\? \[y\]/.test(no) && /set DSH_BIN/.test(no), no.slice(-240))
    const enter = atTerminal('')
    check('harness: Enter takes the default, yes, and the app is placed', /EXIT=0/.test(enter) && runsPlaced(), enter.slice(-240))
    const yes = atTerminal('yes')
    check('harness: so does yes', /EXIT=0/.test(yes) && runsPlaced(), yes.slice(-240))
  } else console.log('  TODO  harness: no /usr/bin/expect to drive the question in a pty')

  // In the installer: the step fills the app's own place only, and the CLI it then uses is checked to run.
  check('harness: install.sh installs only when no DSH_BIN was given and the app is not there, and then runs the CLI it placed',
    /\[ -z "\$DSH_BIN_GIVEN" \] \|\| die /.test(installer) && /\[ ! -e "\$HARNESS_APP" \] \|\| die /.test(installer) && /ensure_harness "\$feed" "\$\(dirname "\$HARNESS_APP"\)" \|\| exit 1/.test(installer) && /"\$DSH_BIN" --version/.test(installer))
}

rmSync(dir, { recursive: true, force: true })
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
