/**
 * The agent panel's rules and the bridge that feeds it, against stand-in DSH services.
 *
 * The services are shaped as docs/harness-api-notes.md §7 records them (read from the shipped
 * code, not a published contract): `subagents.listChildren`, `agents.get(id).status`, the
 * `subagentTiming` and `tokenUsage` projections, `sessionQuery.observeSession`, `jobs`. The bridge
 * must turn them into rows, and must not throw when a field is missing or a service is absent —
 * a panel that crashes the transport would take the conversation with it.
 *
 * Run: node test/tui-panel.test.ts
 */
import './dist-fresh.ts'   // fails loudly on a stale dist

import { panelRows, panelWindow, rowStatus, panelCounts, formatElapsed } from '../dist/tui/panel.js'
import { createBridge } from '../dist/tui/bridge.js'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const agent = (id, status, extra = {}) => ({ id, label: id, mode: 'continuable', status, since: null, settledMs: 0, tokens: 0, ...extra })
const job = (id, status) => ({ id, owner: 'root', kind: 'bash', label: `run ${id}`, status, startedAt: 1000, progress: '' })
const kinds = (rows) => rows.map((r) => r.kind === 'agent' ? r.agent.id : r.kind === 'job' ? r.job.id : r.kind === 'idle' ? `idle:${r.count}` : r.kind === 'more' ? `more:${r.count}` : 'main').join(' ')

// 1. Rows.
{
  check('rows: nothing to show, no panel', panelRows([], [], false).length === 0)
  const rows = panelRows([agent('a', 'idle'), agent('b', 'running'), agent('c', 'done')], [job('bash-1', 'completed'), job('bash-2', 'running')], false)
  check('rows: main, running agents first, the rest, then jobs with running ones first', kinds(rows) === 'main b a c bash-2 bash-1', kinds(rows))
  const many = panelRows([agent('r', 'running'), ...['i1', 'i2', 'i3', 'i4', 'i5'].map((id) => agent(id, 'idle'))], [], false)
  check('rows: more than three idle agents fold into one row', kinds(many) === 'main r idle:5', kinds(many))
  check('rows: and unfold when asked', kinds(panelRows([agent('r', 'running'), ...['i1', 'i2', 'i3', 'i4'].map((id) => agent(id, 'idle'))], [], true)) === 'main r i1 i2 i3 i4')
  const long = panelRows(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id) => agent(id, 'running')), [], false)
  const top = panelWindow(long, 0, 6)
  check('window: at most six rows, the last says how many more', top.rows.length === 6 && kinds(top.rows) === 'main a b c d more:4', kinds(top.rows))
  const bottom = panelWindow(long, 8, 6)
  check('window: follows the selected row', kinds(bottom.rows).startsWith('d e f g h') && bottom.first === 4, `${kinds(bottom.rows)} first=${bottom.first}`)
}

// 2. Row text.
{
  const now = 100_000
  check('status: a running agent counts its own seconds, with tokens', rowStatus({ kind: 'agent', agent: agent('a', 'running', { since: now - 12_000, settledMs: 3_000, tokens: 8_100 }) }, now) === '15s · ↓ 8.1k tokens')
  check('status: an idle agent says so', rowStatus({ kind: 'agent', agent: agent('a', 'idle') }, now) === 'idle')
  check('status: a running job counts from its start', rowStatus({ kind: 'job', job: job('bash-1', 'running') }, 31_000) === 'running · 30s')
  check('elapsed: hours, minutes and seconds like the screenshot', formatElapsed(8_138_000) === '2h 15m 38s')
  check('counts: shells are running jobs, agents are all of them', JSON.stringify(panelCounts([agent('a', 'idle'), agent('b', 'running')], [job('j1', 'running'), job('j2', 'completed')])) === '{"shells":1,"agents":2}')
}

// 3. The bridge over stand-in services.
function services(overrides = {}) {
  // Listeners per event name, and the one projection and job subscriber each.
  const listeners: Record<string, any> = {}
  const calls = []
  const live = { 'child-1': { status: 'running', session: { id: 'child-1' } } }
  const base = {
    subagents: {
      listChildren: async (root) => { calls.push(['listChildren', root]); return [
        { id: 'child-1', createdAt: 1, mode: 'continuable', label: 'research links' },
        { id: 'child-2', createdAt: 2, mode: 'one-shot', label: 'draft summary' },
        { createdAt: 3, mode: 'one-shot' },   // malformed: no id
      ] },
      prompt: async (request, signal) => { calls.push(['prompt', request, signal instanceof AbortSignal]); return { messageId: 'm1' } },
      interruptByParent: async (child, parent, mode) => { calls.push(['interrupt', child, parent, mode]); return { accepted: true } },
    },
    agents: { get: (id) => live[id] },
    sessionProjections: {
      snapshot: (session) => session.id === 'child-1'
        ? { values: { subagentTiming: { settledMs: 2000, active: { since: 5000, through: 6000 } }, tokenUsage: { uncachedInputTokens: 1000, outputTokens: 200, cacheReadTokens: 3000, cacheWriteTokens: 0 } } }
        : { values: {} },
      onChanged: (fn) => { listeners.projections = fn; return () => { listeners.projections = null } },
    },
    sessionQuery: {
      observeSession: async (id, options) => {
        calls.push(['observe', id, options?.projectionMode])
        return {
          projections: { values: id === 'child-2' ? { subagentTiming: { settledMs: 9000, lastTurnCompleted: true }, tokenUsage: { outputTokens: 50 } }
            : id === 'root' ? { tokenUsage: { uncachedInputTokens: 6000, cacheReadTokens: 2000, outputTokens: 100 }, contextPressure: { pressureTokens: 25_000, contextWindow: 100_000 } } : {} },
          events: [
            { type: 'session' },
            { type: 'user/message', data: { content: [{ type: 'text', text: '링크 3개를 요약해' }], source: { kind: 'user' } } },
            // The harness's own injections, as a real child log records them: user role, other kinds.
            { type: 'user/message', data: { content: [{ type: 'text', text: '<system-reminder> skills…' }], source: { kind: 'skill-catalog' } } },
            { type: 'user/message', data: { content: [{ type: 'text', text: 'Time sampled while preparing turn 1' }], source: { kind: 'time-context' } } },
            { type: 'tool/call', data: { name: 'web_fetch' } },
            { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '요약: …' }, { type: 'image' }] } } },
          ],
          [Symbol.dispose]: () => calls.push(['dispose', id]),
        }
      },
    },
    jobs: {
      list: (owner) => owner === 'root'
        ? [{ id: 'bash-1', kind: 'bash', label: 'npm test', owner: 'root', status: 'running', startedAt: 10, output: {} }, { id: 'bash-0', kind: 'bash', label: 'unowned', status: 'completed', startedAt: 1, output: {} }]
        : [{ id: 'bash-0', kind: 'bash', label: 'unowned', status: 'completed', startedAt: 1, output: {} }],
      readAt: (id, from) => ({ chunks: from === 0 ? [{ at: 0, text: 'line 1\n', channel: 'stdout' }, { at: 7, text: 'line 2\n', channel: 'stderr' }] : [], next: 14, lossy: false }),
      get: () => ({ status: 'running' }),
      kill: (id, owner) => { calls.push(['kill', id, owner]); return 'requested' },
      events: { subscribe: (filter, fn) => { listeners.jobs = fn; listeners.jobFilter = filter; return () => { listeners.jobs = null } } },
    },
    ...overrides,
  }
  return {
    calls, listeners,
    get: (name) => base[name],
    on: (name, fn) => { (listeners[name] ??= []).push(fn); return () => { listeners[name] = listeners[name].filter((f) => f !== fn) } },
  }
}

{
  const svc = services()
  const logs = []
  const bridge = createBridge(svc, (...p) => logs.push(p.join(' ')))
  const panel = await bridge.panel('root')
  const [one, two] = panel.agents
  check('bridge: one row per child with an id; a malformed entry is skipped', panel.agents.length === 2)
  check('bridge: a resident running child is running, with its start and tokens', one.status === 'running' && one.since === 5000 && one.settledMs === 2000 && one.tokens === 4200 && one.label === 'research links', JSON.stringify(one))
  check('bridge: a non-resident child is read through a read-only lease, and the lease is released', two.status === 'done' && two.tokens === 50 && svc.calls.some((c) => c[0] === 'observe' && c[1] === 'child-2' && c[2] === 'all') && svc.calls.some((c) => c[0] === 'dispose' && c[1] === 'child-2'))
  check('bridge: jobs of the root and its children, each once', panel.jobs.map((j) => j.id).join(',') === 'bash-1,bash-0', panel.jobs.map((j) => j.id).join(','))
  check('bridge: the conversation\'s own usage and context, from its root session', panel.usage.tokens === 8100 && panel.usage.contextPct === 25, JSON.stringify(panel.usage))
  check('bridge: and its tokens apart, sent and received', panel.usage.input === 8000 && panel.usage.output === 100, JSON.stringify(panel.usage))
  check('bridge: and how much of what was sent the cache served', panel.usage.cached === 2000, JSON.stringify(panel.usage))
  check('bridge: the first sight of each shape is logged once', logs.filter((l) => l.includes('first subagent catalog entry')).length === 1)

  const lines = await bridge.transcript('child-1')
  check('bridge: a child transcript is its task, its tool calls and its answers — not the harness\'s injections', JSON.stringify(lines) === JSON.stringify([{ role: 'user', text: '링크 3개를 요약해' }, { role: 'tool', text: 'web_fetch' }, { role: 'assistant', text: '요약: …' }]), JSON.stringify(lines))

  check('bridge: a message to a running child steers it, with a timeout', (await bridge.send('root', 'child-1', '더 짧게')) === null && svc.calls.find((c) => c[0] === 'prompt')?.[1]?.delivery === 'steer' && svc.calls.find((c) => c[0] === 'prompt')?.[2] === true)
  await bridge.interrupt('root', 'child-1')
  check('bridge: interrupt names the child, its parent and the mode', JSON.stringify(svc.calls.find((c) => c[0] === 'interrupt')) === JSON.stringify(['interrupt', 'child-1', 'root', 'continuable']))
  const out = bridge.jobOutput('root', 'bash-1', 0)
  check('bridge: job output joins its chunks and returns the next offset', out?.text === 'line 1\nline 2\n' && out?.next === 14 && out?.status === 'running')
  check('bridge: kill passes the owner', bridge.killJob('root', 'bash-1') === true && JSON.stringify(svc.calls.find((c) => c[0] === 'kill')) === JSON.stringify(['kill', 'bash-1', 'root']))

  let changes = 0
  const stop = bridge.watch(() => { changes++ })
  svc.listeners['session/event'][0]({}, { type: 'subagent/catalog' })
  svc.listeners['session/event'][0]({}, { type: 'assistant/message' })
  svc.listeners['agent/status'][0]({ agent: {}, status: 'idle' })
  svc.listeners.projections({}, 'tokenUsage')
  svc.listeners.projections({}, 'somethingElse')
  svc.listeners.jobs({ type: 'settled' })
  svc.listeners.jobs({ type: 'output' })
  check('watch: catalog, status, usage/timing and job lifecycle say "look again"; other events and job output do not', changes === 4, `${changes} changes`)
  check('watch: jobs are watched across all owners', svc.listeners.jobFilter?.owners === 'all')
  stop()
  check('watch: stopping removes every listener', (svc.listeners['session/event'] ?? []).length === 0 && svc.listeners.jobs === null && svc.listeners.projections === null)
}

{
  // A transcript of long Korean lines stays under the frame limit, which counts bytes.
  const long = '가'.repeat(8000)
  const events = Array.from({ length: 60 }, () => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: long }], source: { kind: 'model' } } } }))
  const bridge = createBridge({ get: (n) => (n === 'sessionQuery' ? { observeSession: async () => ({ events, [Symbol.dispose]: () => {} }) } : undefined), on: () => undefined }, () => {})
  const lines = await bridge.transcript('kid')
  check('bridge: a transcript is cut to fit the frame by bytes, newest kept', lines.length > 0 && lines.length < 60 && Buffer.byteLength(JSON.stringify(lines)) <= 800_000, `${lines.length} lines, ${Buffer.byteLength(JSON.stringify(lines))} bytes`)
}

{
  // A parent that is not live: the error a person can act on, not a stack.
  const svc = services({ subagents: { prompt: async () => { const e: Error & { code?: string } = new Error('no parent'); e.code = 'subagent/parent-unavailable'; throw e } } })
  const bridge = createBridge(svc, () => {})
  const error = await bridge.send('root', 'child-1', 'hi')
  check('bridge: a message while the parent turn is over explains why it cannot be sent', /has no turn running/.test(error ?? ''), error)
}

{
  // A deployment without these services: an empty panel, never a throw.
  const bridge = createBridge({ get: () => undefined, on: () => undefined }, () => {})
  const panel = await bridge.panel('root')
  check('bridge: no services, no rows and no exception', panel.agents.length === 0 && panel.jobs.length === 0)
  check('bridge: and no usage figures it cannot know', panel.usage.tokens === 0 && panel.usage.contextPct === null)
  check('bridge: and the views say nothing rather than throw', (await bridge.transcript('x')).length === 0 && bridge.jobOutput('r', 'x', 0) === null)
  check('bridge: watch with nothing to watch is harmless', typeof bridge.watch(() => {}) === 'function')
}

{
  // A huge first read keeps its tail; a cut that falls inside an escape sequence must not leave its rest as text.
  const big = `${'x'.repeat(250_000)}\x1b[31m${'y'.repeat(199_985)}\nlast line\n`
  const jobs = { readAt: () => ({ chunks: [{ at: 0, text: big }], next: big.length }), get: () => ({ status: 'running' }) }
  const bridge = createBridge({ get: (n) => (n === 'jobs' ? jobs : undefined), on: () => undefined }, () => {})
  const out = bridge.jobOutput('r', 'j', 0)
  const rest = out?.text.split('\n').slice(1).join('\n') ?? ''
  check('bridge: a cut tail starts on a line of its own, never inside an escape', out !== null && out.text.startsWith('… ') && !/^\[?31m/.test(rest) && rest.endsWith('last line\n'), JSON.stringify(rest.slice(0, 20)))
}

// In English, whatever the deployment's language: a subagent's state, a shell's run, the tokens.
{
  const now = Date.now()
  const idle = rowStatus({ kind: 'agent', agent: { id: 'a', label: 'a', status: 'idle', since: null, settledMs: 0, tokens: 1200, mode: 'continuable' } }, now)
  const job = rowStatus({ kind: 'job', job: { id: 'j', owner: 'o', label: 'j', status: 'running', startedAt: now - 5_000 } }, now)
  check('language: the panel speaks English', /^idle · ↓/.test(idle) && /tokens?$/.test(idle) && /^running · /.test(job), `${idle} | ${job}`)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
