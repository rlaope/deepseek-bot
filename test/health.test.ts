/**
 * The health probe also reads the daily scenario report.
 *
 * service/run-scenarios.sh writes its report and nothing else, so a failing scenario stayed in a file
 * until somebody opened it. The probe runs every five minutes anyway and can already alert; it now
 * alerts once per report that has failures. Run in dry-run mode against scratch files: nothing is sent.
 *
 * Run: node test/health.test.ts
 */
import './dist-fresh.ts'   // fails loudly on a stale dist
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROBE = fileURLToPath(new URL('../dist/service/health-check.js', import.meta.url))
const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const dir = mkdtempSync(join(tmpdir(), 'deepbot-health-'))
const env = {
  ...process.env,
  DEEPBOT_HEALTH_FILE: join(dir, 'health.json'),
  DEEPBOT_HEALTH_STATE: join(dir, 'probe.json'),
  DEEPBOT_SCENARIO_REPORT: join(dir, 'scenario-report.txt'),
  // No scenario job here, until the checks for one put it there.
  DEEPBOT_SCENARIO_JOB: join(dir, 'ai.deepbot.scenarios.plist'),
  DEEPBOT_ALERT_TO: 'U_OPERATOR',
  SLACK_BOT_TOKEN: 'placeholder-for-dry-run',
}
writeFileSync(env.DEEPBOT_HEALTH_FILE, JSON.stringify({ connected: true, updatedAt: Date.now(), connectedAt: Date.now() }))
const probe = () => {
  try { return execFileSync(process.execPath, [PROBE, '--dry-run', '--no-rotate'], { encoding: 'utf8', env }) }
  catch (e) { return String(e.stdout ?? '') }
}
const report = (ran, failed, names = []) => writeFileSync(env.DEEPBOT_SCENARIO_REPORT, [
  `scenarios run ${ran}`, 'repo .', ...names.map((n) => `  FAIL  ${n} — 1/2 steps passed`), `  ${failed} scenario(s) failed`, '',
].join('\n'))

report('2026-10-13T00:00:00Z', 2, ['isolation', 'injection'])
let out = probe()
check('a report with failures raises an alert', /scenarios: dry-run: would alert U_OPERATOR/.test(out), out.trim().split('\n').slice(-2).join(' | '))
check('naming the scenarios that failed', /isolation, injection/.test(out), out.trim().split('\n').find((l) => /scenario/.test(l)) ?? '')
out = probe()
check('the same report alerts only once', !/scenarios: /.test(out), out.trim().split('\n').slice(-1)[0])
report('2026-10-14T00:00:00Z', 0)
out = probe()
check('a clean report raises nothing', !/scenarios: /.test(out))
report('2026-10-15T00:00:00Z', 1, ['recall'])
out = probe()
check('the next failing report alerts again', /scenarios: dry-run/.test(out) && /recall/.test(out))
check('the probe still reports health', /^healthy/m.test(out), out.trim().split('\n').slice(-1)[0])
const state = JSON.parse(readFileSync(env.DEEPBOT_HEALTH_STATE, 'utf8'))
check('which report was alerted is remembered', state.scenarioReportAlerted === '2026-10-15T00:00:00Z', JSON.stringify(state))


// The two alerts have their own rate limits. They shared one: an outage alert sent in the last half hour
// silenced the scenario alert, and a scenario alert — the scenarios fail when the gateway is down —
// silenced the outage alert that followed it in the same probe.
writeFileSync(env.DEEPBOT_HEALTH_STATE, JSON.stringify({ lastAlertAt: Date.now(), lastRestartAt: 0 }))
report('2026-10-16T00:00:00Z', 1, ['persona'])
out = probe()
check('an outage alert just sent does not silence a scenario alert', /scenarios: dry-run: would alert/.test(out), out.trim().split('\n').find((l) => /scenarios:/.test(l)) ?? '(no scenario line)')
writeFileSync(env.DEEPBOT_HEALTH_STATE, JSON.stringify({ lastAlertAt: 0, lastScenarioAlertAt: Date.now(), lastRestartAt: 0, scenarioReportAlerted: '2026-10-16T00:00:00Z' }))
writeFileSync(env.DEEPBOT_HEALTH_FILE, JSON.stringify({ connected: false, updatedAt: Date.now() - 3600_000, connectedAt: 0 }))
let down = ''
try { execFileSync(process.execPath, [PROBE, '--dry-run', '--no-rotate'], { encoding: 'utf8', env: { ...env, DEEPBOT_RECOVERY_WAIT_MS: '100' } }) }
catch (e) { down = String(e.stdout ?? '') }
check('nor does a scenario alert silence an outage alert', /^unhealthy/m.test(down) && /did NOT recover/.test(down) && /dry-run: would alert/.test(down.split('did NOT recover')[1] ?? ''),
  down.trim().split('\n').slice(-2).join(' | '))

// A report that stops coming. The job started a shell macOS kept out of the checkout, and for days the only sign
// was a line in scenarios.err.log. With the job installed, a report older than a day (or none) is said, once.
{
  writeFileSync(env.DEEPBOT_HEALTH_FILE, JSON.stringify({ connected: true, updatedAt: Date.now(), connectedAt: Date.now() }))
  writeFileSync(env.DEEPBOT_HEALTH_STATE, JSON.stringify({ lastAlertAt: 0, lastRestartAt: 0 }))
  const ago = (h) => new Date(Date.now() - h * 3600_000).toISOString().replace(/\.\d+Z$/, 'Z')
  const installed = (hoursAgo) => {
    writeFileSync(env.DEEPBOT_SCENARIO_JOB, '<plist/>\n')
    const at = new Date(Date.now() - hoursAgo * 3600_000)
    utimesSync(env.DEEPBOT_SCENARIO_JOB, at, at)
  }
  const line = (o) => o.trim().split('\n').find((l) => /scenarios:/.test(l)) ?? '(no scenario line)'
  const said = (o) => /scenarios: dry-run: would alert/.test(o) && /has not reported since/.test(o)
  // Nothing said, and for the right reason: the probe ran to its end.
  const quiet = (o) => !/scenarios: /.test(o) && /^healthy/m.test(o)
  const fresh = () => writeFileSync(env.DEEPBOT_HEALTH_STATE, JSON.stringify({ lastAlertAt: 0, lastRestartAt: 0 }))
  // Control: an old report and no job, as at the top of this file, said nothing.
  installed(24 * 5)
  report(ago(24 * 3), 0)
  out = probe()
  check('stale: a clean report three days old, the job installed long ago, is said', said(out), line(out))
  out = probe()
  check('stale: once', quiet(out), line(out))
  // Installed again, and still not starting: the new wait is said again when it runs out.
  installed(27)
  out = probe()
  check('stale: a job installed again that still does not report is said again', said(out), line(out))
  report(ago(2), 0)
  out = probe()
  check('stale: a report from today is not', quiet(out), line(out))
  // Installed again today, after the report went stale: the new job has not had its day yet.
  installed(1)
  report(ago(24 * 3), 0)
  fresh()
  out = probe()
  check('stale: not while the job itself is less than a day old', quiet(out), line(out))
  // A report time ahead of the clock, or one that cannot be read, says nothing about when the job last ran.
  installed(24 * 2)
  report(new Date(Date.now() + 5 * 86400_000).toISOString().replace(/\.\d+Z$/, 'Z'), 0)
  fresh()
  out = probe()
  check('stale: a report dated in the future does not hide a job two days silent, counted from the install', said(out) && /since it was installed/.test(out), line(out))
  installed(1)
  report('garbage', 0)
  fresh()
  out = probe()
  check('stale: an unreadable report time does not skip a new job\'s day', quiet(out), line(out))
  installed(24 * 2)
  rmSync(env.DEEPBOT_SCENARIO_REPORT)
  fresh()
  out = probe()
  check('stale: no report at all from a job two days old is said', said(out) && /since it was installed/.test(out), line(out))
}

rmSync(dir, { recursive: true, force: true })
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
