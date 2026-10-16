#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
/**
 * deepbot health probe.
 *
 * Why this exists: the bot once sat disconnected for 57 minutes while the process
 * was alive and the web UI answered 401. Everything outside looked healthy. A
 * process check cannot see that; only the plugin knows whether it holds a Slack
 * connection, so the plugin publishes its state and this probe reads it.
 *
 * What "unhealthy" means, in order of what it catches:
 *   - no health file at all          → the plugin never started
 *   - connected !== true             → dropped and not retrying
 *   - updatedAt older than STALE_MS  → wedged: alive, not logging, not scheduled
 *
 * On unhealthy it restarts the service, waits for recovery, and only then alerts
 * — so a transient blip that heals itself produces no noise. Alerts are
 * rate-limited, because an alert storm is its own outage.
 *
 * Usage:  node dist/service/health-check.js [--status] [--dry-run]
 * Exit:   0 healthy, 1 unhealthy (restart and/or alert attempted), 2 setup error
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)

// Maintenance that belongs to the schedule rather than to a person: the launchd captures and
// the plugin's log have no cap (598 KB and 85 KB when the rotation was added), and nothing
// else empties them. Only on a scheduled run — a manual --status read should not rewrite logs.
if (!args.includes('--status') && !args.includes('--no-rotate')) {
  // Next to this script (the runtime copy that install-health.sh makes), or the repository's own, two
  // levels up from the build in dist/service/.
  const beside = fileURLToPath(new URL('./rotate-logs.sh', import.meta.url))
  const script = existsSync(beside) ? beside : fileURLToPath(new URL('../../service/rotate-logs.sh', import.meta.url))
  // The plugin's log, and the service logs that moved out of the agent's home — the gateway's own
  // stdout grows with every start and nothing else empties it.
  for (const dir of [null, join(homedir(), '.dsh', 'service', 'logs')]) {
    if (dir !== null && !existsSync(dir)) continue
    const out = spawnSync(script, dir === null ? [] : ['--dir', dir], { encoding: 'utf8' })
    for (const line of `${out.stdout ?? ''}`.split('\n')) if (line.trim() !== '') console.log(line)
    if (out.status !== 0) console.error(`rotate-logs exited ${out.status}: ${out.stderr ?? ''}`.trim())
  }
}
const statusOnly = args.includes('--status')
const dryRun = args.includes('--dry-run')

const HEALTH_FILE = process.env.DEEPBOT_HEALTH_FILE ?? join(homedir(), '.dsh', 'slack-state', 'health.json')
const STALE_MS = Number(process.env.DEEPBOT_STALE_MS ?? 5 * 60 * 1000)
const LABEL = process.env.DEEPBOT_SERVICE_LABEL ?? 'ai.deepbot.gateway'
const UID = process.getuid?.() ?? 501
const ALERT_TO = process.env.DEEPBOT_ALERT_TO ?? ''           // Slack user id or channel id
const ALERT_MIN_MS = Number(process.env.DEEPBOT_ALERT_MIN_MS ?? 30 * 60 * 1000)
const STATE_FILE = process.env.DEEPBOT_HEALTH_STATE ?? join(homedir(), '.dsh', 'slack-state', 'health-probe.json')
const CREDENTIALS = process.env.DSH_HOME ? join(process.env.DSH_HOME, '.env') : join(homedir(), '.dsh', '.env')
const RECOVERY_WAIT_MS = Number(process.env.DEEPBOT_RECOVERY_WAIT_MS ?? 45000)

function readHealth() {
  if (!existsSync(HEALTH_FILE)) return { missing: true }
  try { return JSON.parse(readFileSync(HEALTH_FILE, 'utf8')) }
  catch (e) { return { unreadable: String(e?.message ?? e) } }
}

function diagnose(health) {
  if (health.missing) return 'no health file — the plugin has never started'
  if (health.unreadable) return `health file unreadable: ${health.unreadable}`
  if (health.connected !== true) {
    const since = health.disconnectedAt ? `${Math.round((Date.now() - health.disconnectedAt) / 1000)}s ago` : 'unknown'
    return `not connected (disconnected ${since}, failures in a row: ${health.consecutiveFailures ?? '?'})${health.lastError ? `, last error: ${health.lastError}` : ''}`
  }
  const age = Date.now() - (health.updatedAt ?? 0)
  if (age > STALE_MS) return `connection claims to be up but the heartbeat is ${Math.round(age / 1000)}s stale`
  return null
}

function loadProbeState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch { return { lastAlertAt: 0, lastRestartAt: 0 } }
}
function saveProbeState(state) {
  try { mkdirSync(dirname(STATE_FILE), { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(state, null, 1)) }
  catch { /* best effort */ }
}

function restartService() {
  if (dryRun) return 'dry-run: would restart'
  try {
    execFileSync('launchctl', ['kickstart', '-k', `gui/${UID}/${LABEL}`], { stdio: 'pipe' })
    return 'restart requested'
  } catch (e) {
    return `restart failed: ${String(e?.message ?? e)}`
  }
}

function envToken() {
  try {
    const line = readFileSync(CREDENTIALS, 'utf8').split('\n').find((l) => l.startsWith('SLACK_BOT_TOKEN='))
    return line ? line.slice('SLACK_BOT_TOKEN='.length).trim().replace(/^["']|["']$/g, '') : ''
  } catch { return '' }
}

// Each kind of alert has its own rate limit (`slot`): a scenario alert — the scenarios fail when the
// gateway is down — must not silence the outage alert that follows it, nor the other way round.
async function alert(text, slot = 'lastAlertAt') {
  const state = loadProbeState()
  if (Date.now() - (state[slot] ?? 0) < ALERT_MIN_MS) return 'alert suppressed (rate limit)'
  if (!ALERT_TO) return 'no alert target configured (DEEPBOT_ALERT_TO)'
  const token = process.env.SLACK_BOT_TOKEN || envToken()
  if (!token) return 'no Slack token available for the alert'
  if (dryRun) return `dry-run: would alert ${ALERT_TO}`
  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel: ALERT_TO, text }),
    })
    const body = (await res.json()) as { ok?: boolean, error?: string }
    if (!body.ok) return `alert failed: ${body.error}`
    state[slot] = Date.now()
    saveProbeState(state)
    return 'alert sent'
  } catch (e) {
    return `alert threw: ${String(e?.message ?? e)}`
  }
}

async function waitForRecovery(ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000))
    if (diagnose(readHealth()) === null) return true
  }
  return false
}

// The daily scenario run (service/run-scenarios.sh) writes a report and nothing else, so a failure stayed
// in the file until somebody opened it. Alert once per report that has failures; a report whose alert
// was suppressed or failed is tried again on the next probe.
const SCENARIO_REPORT = process.env.DEEPBOT_SCENARIO_REPORT ?? join(homedir(), '.dsh', 'slack-state', 'scenario-report.txt')
async function checkScenarios() {
  const text = existsSync(SCENARIO_REPORT) ? readFileSync(SCENARIO_REPORT, 'utf8') : ''
  const ran = (text.match(/^scenarios run (\S+)/m) ?? [])[1]
  await checkStale(ran)
  const failed = Number((text.match(/^\s*(\d+) scenario\(s\) failed/m) ?? [])[1] ?? NaN)
  if (ran === undefined || !Number.isFinite(failed) || failed === 0) return
  if (loadProbeState().scenarioReportAlerted === ran) return
  const names = [...text.matchAll(/^\s*FAIL\s+(\S+)/gm)].map((m) => m[1])
  const message = `:warning: deepbot's scenario run at ${ran}: ${failed} failed (${names.join(', ') || 'see the report'}). The report is scenario-report.txt in the plugin's state directory.`
  const note = await alert(message, 'lastScenarioAlertAt')
  console.log(`  scenarios: ${note}${dryRun ? ` — ${message}` : ''}`)
  if (note === 'alert sent' || note.startsWith('dry-run')) {
    const state = loadProbeState(); state.scenarioReportAlerted = ran; saveProbeState(state)
  }
}

// A report that stops coming is a failure too. The job started a shell that macOS kept out of a checkout
// under ~/Desktop, and for days the only sign was a line in scenarios.err.log. With the job installed, no
// report for more than a day, counted from the later of the last report and the job's install, is said once
// per such wait: installing again starts another, so a job that still does not start is said again.
const SCENARIO_JOB = process.env.DEEPBOT_SCENARIO_JOB ?? join(homedir(), 'Library', 'LaunchAgents', 'ai.deepbot.scenarios.plist')
const REPORT_LATE_MS = 26 * 3600_000
async function checkStale(ran: string | undefined) {
  const job = statSync(SCENARIO_JOB, { throwIfNoEntry: false })
  if (job === undefined) return
  // A report time ahead of the clock, or one that cannot be read (NaN fails the comparison too), says nothing about
  // when the job last ran.
  const at = ran === undefined ? NaN : Date.parse(ran)
  const since = Math.max(at <= Date.now() + 3600_000 ? at : 0, job.mtimeMs)
  if (Date.now() - since < REPORT_LATE_MS) return
  const key = String(since)
  if (loadProbeState().scenarioStaleAlerted === key) return
  const message = `:warning: deepbot's scenario run has not reported since ${since === job.mtimeMs ? 'it was installed' : ran}: it may not be starting. Its errors go to scenarios.err.log in the plugin's state directory.`
  // The failure alert's slot: one may wait behind the other, and neither is lost, since a suppressed one is not recorded.
  const note = await alert(message, 'lastScenarioAlertAt')
  console.log(`  scenarios: ${note}${dryRun ? ` — ${message}` : ''}`)
  if (note === 'alert sent' || note.startsWith('dry-run')) {
    const state = loadProbeState(); state.scenarioStaleAlerted = key; saveProbeState(state)
  }
}
if (!statusOnly) await checkScenarios()

const health = readHealth()
const problem = diagnose(health)

if (statusOnly || problem === null) {
  const summary = problem === null
    ? `healthy — connected since ${health.connectedAt ? new Date(health.connectedAt).toISOString() : '?'}, accepted ${health.accepted ?? 0}, answered ${health.answered ?? 0}, heartbeat ${Math.round((Date.now() - (health.updatedAt ?? 0)) / 1000)}s old`
    : `unhealthy — ${problem}`
  console.log(summary)
  process.exit(problem === null ? 0 : 1)
}

console.log(`unhealthy — ${problem}`)
const restartResult = restartService()
console.log(`  ${restartResult}`)
const recovered = await waitForRecovery(RECOVERY_WAIT_MS)
console.log(recovered ? '  recovered after restart' : '  did NOT recover within the wait window')

if (recovered) {
  const state = loadProbeState(); state.lastRestartAt = Date.now(); saveProbeState(state)
  process.exit(1)                                  // it was down; a restart was needed
}

const note = await alert(`:rotating_light: deepbot is down and did not recover.\n> ${problem}\n> ${restartResult}`)
console.log(`  ${note}`)
process.exit(1)
