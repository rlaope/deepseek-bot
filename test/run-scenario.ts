#!/usr/bin/env node
/**
 * Run a scenario against the real agent services, in an isolated instance.
 *
 * Why this exists: verifying memory by hand means a human typing in Slack, a
 * symptom appearing, a patch, and another hand test. That loop is what this
 * replaces. A scenario is a JSON file of steps; the plugin's scenario mode runs
 * them and writes a result file, and this script turns that into an exit code.
 *
 * Isolation, so it is safe to run while the live instance is serving:
 *   - its own profile      (DEEPBOT_TEST_PROFILE, default agent-test)
 *   - its own agent home   (DEEPBOT_TEST_HOME,    default ~/dsh-agent-test)
 *   - its own FTS index    (the test profile points at a different path)
 *   - its own port
 *   - and it never connects to Slack: scenario mode returns before that.
 *
 * Usage:
 *   node test/run-scenario.ts [scenario.json] [--keep] [--timeout 300]
 *
 * Exits 0 when every step passed, 1 when a step failed, 2 on setup problems.
 */

import './dist-fresh.ts'   // a scenario must not run a stale build

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, tmpdir } from 'node:os'
import { recallIndexPath } from '../dist/recallContext.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')

const args = process.argv.slice(2)
// Options that consume the next argument must be skipped when looking for the
// positional scenario path — otherwise `--timeout 240` reads as a scenario.
let scenarioArg
let timeoutS = 300
let seedFile
let dumpFile
for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === '--timeout') { timeoutS = Number(args[++i]); continue }
  if (arg === '--seed') { seedFile = resolve(args[++i]); continue }
  if (arg === '--dump') { dumpFile = resolve(args[++i]); continue }
  if (arg.startsWith('--')) continue
  if (scenarioArg === undefined) scenarioArg = arg
}
const scenario = resolve(scenarioArg ?? join(HERE, 'scenarios', 'recall.json'))
const keep = args.includes('--keep')

const DSH_BIN = process.env.DSH_BIN ?? '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
const PROFILE = process.env.DEEPBOT_TEST_PROFILE ?? 'agent-test'
// A UNIQUE home per run, deliberately.
//
// The session store is bucketed by working directory, so reusing one home makes
// a second run inherit the first run's sessions and memory notes — and a recall
// assertion can then pass on stale state without this run proving anything. It
// looked green for exactly that reason once. A fresh home per run means the only
// thing recall can find is what this run wrote.
const TEST_HOME = process.env.DEEPBOT_TEST_HOME ?? join(homedir(), `dsh-agent-test-${Date.now().toString(36)}`)
const PORT = process.env.DEEPBOT_TEST_PORT ?? '19599'
const LIVE_HOME = process.env.DEEPBOT_LIVE_HOME ?? join(homedir(), 'dsh-agent')
// The result path is pinned outside the (fresh, disposable) agent home, because
// the plugin cannot predict a home that changes every run.
const RESULT = process.env.DEEPBOT_SCENARIO_RESULT ?? join(tmpdir(), `deepbot-scenario-${process.pid}.json`)

function fail(message: string): never {
  console.error(`setup error: ${message}`)
  process.exit(2)
}

if (!existsSync(scenario)) fail(`scenario not found: ${scenario}`)
if (!existsSync(DSH_BIN)) fail(`dsh not found: ${DSH_BIN} (set DSH_BIN)`)
// Read before anything is made: a file that is not JSON used to fail after the home existed, and left
// one ~/dsh-agent-test-<time> behind on every test run.
let spec: { seed?: Record<string, unknown> }
try { spec = JSON.parse(readFileSync(scenario, 'utf8')) } catch (e) { fail(`could not read the scenario: ${String((e as Error)?.message ?? e)}`) }
if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) fail('could not read the scenario: it is not a JSON object')

console.log(`scenario : ${scenario}`)
console.log(`profile  : ${PROFILE}`)
console.log(`home     : ${TEST_HOME}${process.env.DEEPBOT_TEST_HOME ? ' (pinned)' : ' (fresh)'}`)
console.log(`port     : ${PORT}`)
console.log()

// A test home mirrors the live one where it matters — the instruction file is
// what tells the agent that a recall index exists at all.
mkdirSync(TEST_HOME, { recursive: true })
// A run with commandNetwork bounded leaves the gateway's file for this home, closed, as a stop does: the home goes at
// exit, and the file with it. Keyed as the gateway keys it, by the real path, read now while the home is there.
const NETWORK_FILE = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'deepbot', 'command-network', `${createHash('sha256').update(realpathSync(TEST_HOME)).digest('hex').slice(0, 16)}.json`)

// A scenario may need a file to exist before the plugin boots — a large MEMORY.md, for instance,
// which a fresh home never has. Without this the note-hygiene path could not be exercised at all,
// because there was nothing for it to complain about.
try {
  for (const [name, body] of Object.entries(spec.seed ?? {})) {
    const target = join(TEST_HOME, name)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, String(body))
    console.log(`seed    : ${name} (${String(body).length} chars)`)
  }
} catch (e) {
  fail(`could not read the scenario's seed: ${String(e?.message ?? e)}`)
}

for (const file of ['AGENTS.md', 'CLAUDE.md']) {
  const from = join(LIVE_HOME, file)
  if (existsSync(from)) cpSync(from, join(TEST_HOME, file))
}
mkdirSync(join(TEST_HOME, 'memory'), { recursive: true })
rmSync(RESULT, { force: true })

// Paths in a scenario are written as {HOME} and {LIVE_HOME} — and {REPO} (this checkout) and {NODE} (this node) —
// so the files name no particular machine; the plugin is handed a copy with them filled in. {RUN} names this run.
const resolvedScenario = join(tmpdir(), `deepbot-scenario-${process.pid}-${basename(scenario)}`)
// {RECALL_INDEX}: the test home's recall index, which lives under the harness home, not in the agent's.
const RECALL_INDEX = recallIndexPath(TEST_HOME)
const resolvedText = readFileSync(scenario, 'utf8').replaceAll('{RECALL_INDEX}', RECALL_INDEX).replaceAll('{LIVE_HOME}', LIVE_HOME).replaceAll('{HOME}', homedir())
  .replaceAll('{REPO}', REPO).replaceAll('{NODE}', process.execPath).replaceAll('{RUN}', basename(TEST_HOME))
writeFileSync(resolvedScenario, resolvedText)

// Rows a scenario needs that the test profile has not (an MCP server): the run uses a copy of the profile with them
// added at the end, removed at exit. Left to each machine's profile, the scenario failed wherever nobody had added them,
// and its report could not tell a missing row from a broken feature.
const profileRows = JSON.parse(resolvedText).profileRows
const PROFILES = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles')
const RUN_PROFILE = Array.isArray(profileRows) ? `${PROFILE}-scenario-${process.pid}` : PROFILE
if (RUN_PROFILE !== PROFILE) {
  if (!existsSync(join(PROFILES, PROFILE, 'cordis.patch.yml'))) fail(`profile ${PROFILE} not found under ${PROFILES}`)
  // Removed however this process ends from here on, a failure in the setup below included.
  process.on('exit', () => rmSync(join(PROFILES, RUN_PROFILE), { recursive: true, force: true }))
  // As links: the profile's node_modules names the plugin by a relative link, which a copy at the same depth keeps.
  cpSync(join(PROFILES, PROFILE), join(PROFILES, RUN_PROFILE), { recursive: true, verbatimSymlinks: true })
  appendFileSync(join(PROFILES, RUN_PROFILE, 'cordis.patch.yml'), `\n# Added for ${basename(scenario)}, removed at exit.\n${profileRows.join('\n')}\n`)
  console.log(`rows     : ${profileRows.length} added to a copy of ${PROFILE}`)
}

// Files a scenario needs outside the agent's home — a canary it must not be able to read — made here and
// removed at exit. A canary that did not exist made an exfiltration check pass without proving anything.
const outsideFiles = Object.entries(JSON.parse(resolvedText).outside ?? {})
for (const [path, body] of outsideFiles) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, String(body))
  console.log(`outside : ${path}`)
}
// The harness's agents home, empty, as the launcher gives it one: the operator's own agent skills
// (~/.agents/skills) are not the bot's. Under the harness home, as live (~/.dsh/deepbot/agents-home): it
// sat inside the agent home, and a temp directory would do no better — the agent's commands write both,
// and a definition left there is loaded as one of the harness's agents.
mkdirSync(join(homedir(), '.dsh', 'deepbot'), { recursive: true })
const AGENTS_HOME = mkdtempSync(join(homedir(), '.dsh', 'deepbot', 'agents-home-test-'))

process.on('exit', () => {
  rmSync(AGENTS_HOME, { recursive: true, force: true })
  if (!keep) rmSync(NETWORK_FILE, { force: true })
  // The index outlives the fresh home otherwise, one directory per run under ~/.dsh/recall.
  if (!keep) rmSync(dirname(RECALL_INDEX), { recursive: true, force: true })
  for (const [path] of outsideFiles) rmSync(path, { force: true })
  for (const dir of new Set(outsideFiles.map(([path]) => dirname(path)))) {
    try { rmSync(dir, { recursive: false }) } catch { /* not empty, or gone */ }
  }
})

const child = spawn(DSH_BIN, ['--profile', RUN_PROFILE, '--port', PORT, '--no-open'], {
  cwd: TEST_HOME,
  env: {
    ...process.env,
    DEEPBOT_SELF_TEST_SCRIPT: resolvedScenario,
    DSH_AGENTS_HOME: AGENTS_HOME,
    DEEPBOT_RECALL_SCRIPT: join(REPO, 'dist', 'recall', 'deepbot-recall.js'),
    DEEPBOT_SCENARIO_RESULT: RESULT,
    DEEPBOT_HOME: TEST_HOME,
    ...(seedFile !== undefined ? { DEEPBOT_SESSION_SEED: seedFile } : {}),
    ...(dumpFile !== undefined ? { DEEPBOT_SESSION_DUMP: dumpFile } : {}),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let childOutput = ''
child.stdout.on('data', (d) => { childOutput += d })
child.stderr.on('data', (d) => { childOutput += d })

let finished = false
const started = Date.now()
const deadline = started + timeoutS * 1000

function stop(signal: NodeJS.Signals = 'SIGTERM') {
  try { child.kill(signal) } catch { /* already gone */ }
}

// Stopped with ctrl+c or a kill: the gateway goes too (a kill reaches this process alone), the test home is
// removed as at the end, and 'exit' — which a signal skips — removes the rest.
function leave(code: number): never {
  stop()
  if (!keep && dumpFile === undefined) rmSync(TEST_HOME, { recursive: true, force: true })
  process.exit(code)
}
process.on('SIGINT', () => leave(130))
process.on('SIGTERM', () => leave(143))

// Poll for the result file; the plugin writes it when the scenario completes.
while (Date.now() < deadline) {
  if (existsSync(RESULT)) { finished = true; break }
  if (child.exitCode !== null) break
  await new Promise((r) => setTimeout(r, 500))
}

stop()
await new Promise((r) => setTimeout(r, 1500))
if (child.exitCode === null) { stop('SIGKILL'); await new Promise((r) => setTimeout(r, 500)) }

if (!finished) {
  console.error(`scenario did not finish within ${timeoutS}s`)
  console.error('--- gateway output ---')
  console.error(childOutput.split('\n').slice(-40).join('\n'))
  const pinned = Boolean(process.env.DEEPBOT_TEST_HOME)
if (!keep && dumpFile === undefined) rmSync(TEST_HOME, { recursive: true, force: true })
  process.exit(1)
}

const result = JSON.parse(readFileSync(RESULT, 'utf8'))

// Surface loader warnings. A row that fails to activate is logged once at boot
// and then behaves like a feature that was never configured — which is how the
// office skill sat inactive while documents appeared to work. Fail loudly here.
const loaderIssues = childOutput
  .split('\n')
  .filter((l) => /did not activate|Error:|not allowed|WARNING/.test(l))
  .filter((l) => !/DeprecationWarning|trace-deprecation|task_name_for_pid/.test(l))
if (loaderIssues.length > 0) {
  console.log('--- loader warnings ---')
  for (const line of loaderIssues.slice(0, 10)) console.log(`  ${line.trim().slice(0, 160)}`)
  console.log()
}

console.log('--- steps ---')
for (const step of result.steps) {
  const label = step.kind === 'rebuildIndex' ? 'rebuildIndex' : `${step.session}: ${JSON.stringify(step.say ?? '').slice(0, 60)}`
  console.log(`  ${step.ok ? 'PASS' : 'FAIL'}  step ${step.step}  ${label}`)
  if (step.kind === 'turn') console.log(`        answer: ${JSON.stringify((step.text ?? '').slice(0, 200))}`)
  if (!step.ok) console.log(`        ${step.error ?? (step.failedChecks ?? []).map((c) => `failed: ${c.what}`).join(', ')}`)
}
console.log()
console.log(`${result.total - result.failed}/${result.total} steps passed  (cwd ${result.cwd})`)

// Always clean the unique home unless asked to keep it: it exists only for this
// run, and leaving it would pollute the next run's session bucket.
if (!keep) rmSync(TEST_HOME, { recursive: true, force: true })
else console.log(`kept test home for inspection: ${TEST_HOME}`)

process.exit(result.failed === 0 ? 0 : 1)
