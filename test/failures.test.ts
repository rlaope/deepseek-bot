/**
 * Failure injection: what the conversation sees when things break.
 *
 * The other suites check that the working paths work. This checks the failing ones, because
 * silence is the failure mode that costs the most: a person asks something, nothing comes
 * back, and they cannot tell whether the bot is thinking, broken, or gone.
 *
 * The fake agent is off by default (`create` throws). Here it can also **hang** — a create
 * that never resolves holds a turn open, which is the only way to exercise cancellation and
 * queueing without a real model.
 *
 * Run: node test/failures.test.ts
 */
import './dist-fresh.ts'
import './scratch-dsh-home.ts'   // the recall index must not land in the real ~/.dsh
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../dist/index.js'
import { createFakeTransport, type FakeTransportOptions } from './fake-transport.ts'
import { createSlackTransport } from '../dist/transports/slack.js'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** `agents.create` behaviour: 'throw' (default), 'hang', or 'slow' (see below). */
function boot({ state = {}, config = {}, agent = 'throw' }: {
  state?: Record<string, unknown>
  config?: { fake?: FakeTransportOptions; resolveDelayMs?: number; [key: string]: unknown }
  agent?: 'throw' | 'hang' | 'slow'
} = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'deepbot-fail-'))
  writeFileSync(join(stateDir, 'sessions.json'), JSON.stringify({ sessions: {}, seen: {}, standing: {}, history: {}, ...state }))
  const transport = createFakeTransport(config.fake ?? {})
  const logs = []
  const listeners = {}
  const created = []
  // 'slow': the create takes 100 ms, and the agent runs until it is cancelled. The delay is what puts
  // the turn's own timeout behind the job's, which is the order that let a timed-out turn release the
  // conversation while its agent still ran.
  const events = []
  let agentsMade = 0
  // Holds the preset step open, so a stop can arrive before the agent is even asked for.
  const resolveDelayMs = Number(config.resolveDelayMs ?? 0)
  async function slowAgent(options) {
    const n = ++agentsMade
    await sleep(100)
    events.push({ at: Date.now(), kind: 'created', n })
    let stop
    const stopped = new Promise((resolve) => { stop = resolve })
    return {
      agent: {
        session: { header: { id: options?.sessionId ?? `s${n}` }, seq: 0, eventAt: () => undefined },
        followup: () => {}, whenIdle: () => stopped,
        cancel: (reason) => { events.push({ at: Date.now(), kind: 'cancelled', n, reason }); stop() },
      },
      dispose: async () => { events.push({ at: Date.now(), kind: 'disposed', n }) },
    }
  }
  const stubs = {
    agents: {
      create: async (options) => {
        created.push(options)
        if (agent === 'hang') return await new Promise(() => {})       // never resolves
        if (agent === 'slow') return slowAgent(options)
        throw new Error('fake: agents.create is not implemented')
      },
      // A second turn in the conversation resumes the first one's session.
      resume: async (options) => { if (agent === 'slow') return slowAgent(options); throw new Error('fake: no agents') },
    },
    sessions: { flush: async () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake' }) },
    // Without this the turn fails before it reaches agents.create, so cancellation and
    // queueing were never exercised — the sweep was testing the missing service instead.
    agentPresets: {
      resolve: async () => { if (resolveDelayMs > 0) await sleep(resolveDelayMs); return { id: 'standard' } },
      acquireScope: () => ({ key: {}, [Symbol.asyncDispose]: async () => {} }),
      mount: async () => {},
    },
  }
  const ctx = { get: (n) => stubs[n], effect: (fn) => fn(), on: (n, h) => { (listeners[n] ??= []).push(h); return () => {} }, logger: { info: (l) => logs.push(String(l)) } }
  apply(ctx, { targetChannels: ['C_ALLOWED'], language: 'ko', stateDir, transportFactory: () => transport, progressAfterMs: 50, ...config })
  return {
    transport, logs, created, events,
    /** A session event, as the harness fires one: a tool call during a turn, say. */
    fire: (sessionId, event) => { for (const fn of listeners['session/event'] ?? []) fn({ header: { id: sessionId } }, event) },
    /** An approval request for a session, as the harness raises one. */
    ask: (sessionId) => listeners['approval/request'][0]({ agent: { session: { header: { id: sessionId } } }, reason: 'rm -rf build' }),
    read: () => JSON.parse(readFileSync(join(stateDir, 'sessions.json'), 'utf8')),
    done: () => rmSync(stateDir, { recursive: true, force: true }),
  }
}

// 1. A failed turn tells the conversation. Silence would look like being ignored.
{
  const t = boot()
  await sleep(60)
  t.transport.deliver(t.transport.message({ text: 'do something' }))
  await sleep(400)
  const posted = t.transport.posted.map((p) => p.text).join('\n')
  check('a failed turn posts something to the conversation', posted !== '', JSON.stringify(posted.slice(0, 80)))
  check('and it says it failed', /실패|failed|error|Error/.test(posted), posted.slice(0, 90))
  check('the reason is in the log', t.logs.some((l) => /turn failed/.test(l)), t.logs.filter((l) => /failed/.test(l)).join(' | ').slice(0, 120))
  t.done()
}

// 2. Two messages in one conversation are both answered, not dropped.
{
  const t = boot()
  await sleep(60)
  t.transport.deliver(t.transport.message({ text: 'first' }))
  await sleep(40)
  t.transport.deliver(t.transport.message({ text: 'second' }))
  await sleep(600)
  check('both messages reach an agent', t.created.length === 2, `${t.created.length} create(s)`)
  check('and both are answered', t.transport.posted.filter((p) => /실패|failed/.test(p.text)).length >= 2,
    `${t.transport.posted.length} post(s)`)
  t.done()
}

// 3. While a turn is open, another message in the same conversation waits for it.
//
// This used to assert the opposite on purpose: no per-conversation serialization, two turns
// colliding on one session, the adopt path absorbing it by retrying on "active write handle".
// In practice the second turn waited out three retries and answered "Execution failed", and in a
// new thread it created a second session and the mapping kept whichever finished last. Now the
// second message queues behind the first and runs when it ends; other conversations are not held.
{
  const t = boot({ agent: 'hang', config: { runTimeoutMs: 500 } })
  await sleep(60)
  t.transport.deliver(t.transport.message({ text: 'slow one' }))
  await sleep(150)
  t.transport.deliver(t.transport.message({ text: 'while you are busy' }))
  await sleep(150)
  check('a second message waits while the first turn is open', t.created.length === 1, `${t.created.length} create(s)`)
  await sleep(1100)
  check('and runs once the first turn has ended', t.created.length === 2, `${t.created.length} create(s)`)
  check('nothing says it was ignored', !t.logs.some((l) => /ignored|dropped|refused the message/i.test(l)),
    t.logs.filter((l) => /accepted|ignored|dropped/.test(l)).join(' | ').slice(0, 120))
  t.done()
}

// 3b. A stop withdraws what is waiting as well as what is running. Without it the bot said it had
// stopped and then started on the next message in the queue.
{
  const t = boot({ agent: 'hang', config: { runTimeoutMs: 500 } })
  await sleep(60)
  t.transport.deliver(t.transport.message({ text: 'slow one' }))
  await sleep(150)
  t.transport.deliver(t.transport.message({ text: 'queued behind it' }))
  await sleep(50)
  t.transport.deliver(t.transport.message({ text: '그만' }))
  await sleep(1200)
  check('a waiting message is withdrawn by a stop, not run afterwards', t.created.length === 1, `${t.created.length} create(s)`)
  t.done()
}

// 3c. A stop for a message that has not started says it stopped it — not "nothing is running" while
// "작업 중" is on screen — and the report takes the working message's place.
{
  // The other conversation holds the only slot until its backstop (400 ms + 400 ms grace) lets go;
  // the checks run after that, so a withdrawn message that still ran would be counted. Checked at
  // 300 ms, as first written, nothing could have run yet either way.
  const t = boot({ agent: 'hang', config: { maxConcurrency: 1, runTimeoutMs: 400, targetChannels: ['*'] } })
  await sleep(60)
  t.transport.deliver(t.transport.message({ text: 'elsewhere', target: { channel: 'C_OTHER', threadTs: 't0' } }))
  await sleep(150)
  t.transport.deliver(t.transport.message({ text: 'waits for a slot' }))
  await sleep(150)
  t.transport.deliver(t.transport.message({ text: '그만' }))
  await sleep(1400)
  const posts = t.transport.posted.map((p, i) => ({ ...p, ts: `ts-${i + 1}` }))
  const inThread = posts.filter((p) => p.target.channel === 'C_ALLOWED')
  const working = inThread.find((p) => p.replace === null && /작업 중/.test(p.text))
  const report = inThread[inThread.length - 1]
  check('the stop says it withdrew the waiting message', /중단/.test(report?.text ?? '') && !/없어/.test(report?.text ?? ''), report?.text)
  check('in place of the working message', working !== undefined && report?.replace === working.ts, JSON.stringify(inThread).slice(0, 160))
  check('and the waiting message never starts', t.created.length === 1, `${t.created.length} create(s)`)
  t.done()
}

// 3d. A turn that times out is stopped before the conversation's next message starts. The job's own
// timeout fired first (it starts before the agent exists, the turn's after), so the next turn began
// while the old agent still ran, and the old turn's timer — looking up the conversation's key —
// cancelled the new turn instead of its own.
{
  const t = boot({ agent: 'slow', config: { runTimeoutMs: 300 } })
  await sleep(60)
  t.transport.deliver(t.transport.message({ text: 'runs past its timeout' }))
  await sleep(20)
  t.transport.deliver(t.transport.message({ text: 'next' }))
  await sleep(1300)
  const firstCancel = t.events.find((e) => e.kind === 'cancelled' && e.n === 1)
  const secondCreate = t.events.find((e) => e.kind === 'created' && e.n === 2)
  check('the timed-out turn\'s own agent is cancelled', firstCancel !== undefined, JSON.stringify(t.events))
  check('and the next message starts only after that', firstCancel !== undefined && secondCreate !== undefined && secondCreate.at >= firstCancel.at,
    JSON.stringify(t.events.map((e) => `${e.kind}${e.n}`)))
  t.done()
}

// 3e. A stop ends the typing of the messages it withdraws at once — not when they would have reached
// a slot, which behind another conversation's turn could be minutes of "typing…" under "중단했어".
{
  const t = boot({ agent: 'hang', config: { maxConcurrency: 1, runTimeoutMs: 60000, targetChannels: ['*'], fake: { typing: true } } })
  await sleep(60)
  t.transport.deliver(t.transport.message({ text: 'elsewhere', target: { channel: 'C_OTHER', threadTs: 't0' } }))
  await sleep(100)
  t.transport.deliver(t.transport.message({ text: 'waits for a slot' }))
  await sleep(100)
  t.transport.deliver(t.transport.message({ text: '그만' }))
  await sleep(100)
  const typing = t.transport.typing.find((entry) => entry.target.channel === 'C_ALLOWED')
  check('the withdrawn message stops typing at once', typing?.stopped === true, JSON.stringify(t.transport.typing))
  t.done()
}

// 3f. A stop while the agent is being created releases that agent. The early return sat before the
// try/finally, so the handle was never disposed, and the queue starts the next turn at once.
{
  const t = boot({ agent: 'slow', config: { runTimeoutMs: 5000 } })
  await sleep(60)
  t.transport.deliver(t.transport.message({ text: 'stopped while it is created' }))
  await sleep(50)
  t.transport.deliver(t.transport.message({ text: '그만' }))
  await sleep(400)
  check('a turn stopped during its create disposes the agent', t.events.some((e) => e.kind === 'disposed' && e.n === 1),
    JSON.stringify(t.events.map((e) => `${e.kind}${e.n}`)))
  t.done()
}

// 3g. A stop during the preset step reaches the turn. Registered after those awaits, the turn looked
// idle there: the stop answered "nothing is running" and the turn went ahead.
{
  const t = boot({ agent: 'slow', config: { runTimeoutMs: 5000, resolveDelayMs: 200 } })
  await sleep(60)
  t.transport.deliver(t.transport.message({ text: 'slow to prepare' }))
  await sleep(50)
  t.transport.deliver(t.transport.message({ text: '그만' }))
  await sleep(500)
  const said = t.transport.posted.map((p) => p.text)
  check('the stop finds the turn', !said.some((text) => /없어/.test(text)), JSON.stringify(said))
  check('and the turn creates no agent', t.created.length === 0, `${t.created.length} create(s)`)
  // Nor maps one: the id was never created, and a mapping made every later message in this thread
  // resume a session that does not exist.
  await sleep(100)
  check('and the conversation is not mapped to a session that was never made', t.read().sessions?.['C_ALLOWED:t1'] === undefined,
    String(t.read().sessions?.['C_ALLOWED:t1']))
  t.done()
}

// 3h. A stop while the agent is being created is reported once. It said "중단했어 — 시작 중이던 작업을
// 멈췄어" at once, and "중단했어." again when the turn came back.
{
  const t = boot({ agent: 'slow', config: { runTimeoutMs: 5000 } })
  await sleep(60)
  t.transport.deliver(t.transport.message({ text: 'stopped while it is created' }))
  await sleep(50)
  t.transport.deliver(t.transport.message({ text: '그만' }))
  await sleep(500)
  const reports = t.transport.posted.filter((p) => /중단/.test(p.text))
  check('a stop during preparation is reported once', reports.length === 1, JSON.stringify(t.transport.posted.map((p) => p.text.slice(0, 30))))
  check('in place of the working message', reports[0]?.replace !== null && reports[0]?.replace !== undefined, JSON.stringify(reports[0]))
  t.done()
}

// 3i. A turn in flight is written down, so a restart can say what it lost. Before, a restart dropped
// the turn without a word and left "작업 중" on screen.
{
  const t = boot({ agent: 'hang', config: { runTimeoutMs: 60000 } })
  await sleep(60)
  t.transport.deliver(t.transport.message({ text: 'long one' }))
  await sleep(300)
  const record = t.read().inflight?.['C_ALLOWED:t1']
  check('a turn in flight is recorded in the state file', record?.channel === 'C_ALLOWED' && record?.threadTs === 't1', JSON.stringify(t.read().inflight))
  check('with its working message', typeof record?.placeholder === 'string', JSON.stringify(record))
  t.done()
}
{
  const t = boot({ state: { inflight: { 'C_ALLOWED:t1': { channel: 'C_ALLOWED', threadTs: 't1', placeholder: 'ts-old', since: Date.now() - 5000 } } } })
  await sleep(300)
  const notice = t.transport.posted.find((p) => /끊겼어/.test(p.text))
  check('after a restart the conversation is told its turn was lost', notice !== undefined, JSON.stringify(t.transport.posted.map((p) => p.text.slice(0, 30))))
  check('in place of the working message that was left behind', notice?.replace === 'ts-old', JSON.stringify(notice))
  // Both places a record can be: this process's turns, and the previous process's set aside at load.
  check('and the record is cleared', Object.keys(t.read().inflight ?? {}).length === 0 && Object.keys(t.read().restartLost ?? {}).length === 0,
    JSON.stringify({ inflight: t.read().inflight, restartLost: t.read().restartLost }))
  t.done()
}
// A message that arrives while the notices are still going out is a new turn, and is tracked as one.
// Records were cleared one at a time between awaits: a new turn in a conversation not yet reached found
// the old record, skipped writing its own, and then lost the old one to the loop — untracked.
{
  const since = Date.now() - 5000
  const t = boot({ agent: 'hang', config: { runTimeoutMs: 60000, fake: { postDelayMs: 400 } }, state: { inflight: {
    'C_ALLOWED:t0': { channel: 'C_ALLOWED', threadTs: 't0', placeholder: 'ts-a', since },
    'C_ALLOWED:t1': { channel: 'C_ALLOWED', threadTs: 't1', placeholder: 'ts-b', since },
  } } })
  await sleep(60)
  t.transport.deliver(t.transport.message({ text: 'new one' }))
  await sleep(1500)
  const record = t.read().inflight?.['C_ALLOWED:t1']
  check('a turn begun during recovery is tracked', record !== undefined && Number(record.since) > since, JSON.stringify(t.read().inflight))
  check('and both lost turns were still reported', t.transport.posted.filter((p) => /끊겼어/.test(p.text)).length === 2)
  t.done()
}
// A record stays until its own notice is out: cleared all at once before the first notice, a restart
// during the notices lost every one not yet sent. (Found by the verification pass.)
{
  const since = Date.now() - 5000
  const t = boot({ config: { fake: { postDelayMs: 400 } }, state: { inflight: {
    'C_ALLOWED:t0': { channel: 'C_ALLOWED', threadTs: 't0', placeholder: 'ts-a', since },
    'C_ALLOWED:t1': { channel: 'C_ALLOWED', threadTs: 't1', placeholder: 'ts-b', since },
  } } })
  await sleep(200)
  // On disk for the next process to report: the next load reads it from either map (the previous
  // process's records are set aside as restartLost, and the file keeps the old form until a save).
  const onDisk = () => t.read().restartLost?.['C_ALLOWED:t1'] ?? t.read().inflight?.['C_ALLOWED:t1']
  check('a record not yet notified is still on disk', onDisk() !== undefined, JSON.stringify(t.read()))
  await sleep(1200)
  check('and gone once its notice is out', Object.keys(t.read().inflight ?? {}).length === 0 && Object.keys(t.read().restartLost ?? {}).length === 0,
    JSON.stringify({ inflight: t.read().inflight, restartLost: t.read().restartLost }))
  t.done()
}

// 4. Stopping a turn that is open actually stops it, and says so.
{
  const t = boot({ agent: 'hang' })
  await sleep(60)
  t.transport.deliver(t.transport.message({ text: 'slow one' }))
  await sleep(300)
  t.transport.deliver(t.transport.message({ text: '그만' }))
  await sleep(300)
  check('a stop request is acknowledged', t.transport.posted.some((p) => /중단|멈|취소|stop/i.test(p.text)),
    JSON.stringify(t.transport.posted.map((p) => p.text.slice(0, 24))))
  t.done()
}

// 5. Stopping when nothing runs says so instead of being silent.
{
  const t = boot()
  await sleep(60)
  t.transport.deliver(t.transport.message({ text: '그만' }))
  await sleep(300)
  check('stopping nothing is answered', t.transport.posted.length > 0, JSON.stringify(t.transport.posted.map((p) => p.text.slice(0, 30))))
  check('and it starts no turn', t.created.length === 0, `${t.created.length} create(s)`)
  t.done()
}

// 6. A credential that is not there is named, not silently empty.
{
  const logs = []
  const t = createSlackTransport({
    cfg: { platform: 'slack', stateDir: '.', targetChannels: ['*'], botTokenRef: 'SLACK_BOT_TOKEN_MISSING', appTokenRef: 'SLACK_APP_TOKEN_MISSING' },
    log: (...p) => logs.push(p.join(' ')),
    sessionCwd: async () => process.cwd(),
    credential: async () => undefined,
    onHealth: () => {},
  })
  let message = ''
  try { await t.authenticate() } catch (e) { message = String(e?.message ?? e) }
  check('a missing credential is an error, not an empty token', message !== '', message)
  check('and the error names the reference', /SLACK_BOT_TOKEN_MISSING/.test(message), message)
  check('the transport is not ready', t.ready() === false)
}

// replyMode 'thread', with turns that take time: what is heard without a mention, and how it stays quiet.
{
  const quietRuns = (t) => t.logs.filter((l) => /kept quiet/.test(l)).length
  // (a) Heard during the bot's first turn in a thread, before the thread has a session; a run of such messages is
  // one turn (the earlier gives way, and comes to the later one as history); and quiet, they post nothing.
  const a = boot({ agent: 'slow', config: { replyMode: 'thread', runTimeoutMs: 400, fake: { typing: true } } })
  await sleep(60)
  a.transport.deliver(a.transport.message({ text: 'CI 실패 좀 봐줘', user: 'U_ASKER' }))
  await sleep(150)
  a.transport.deliver(a.transport.message({ addressed: false, text: 'lint job도 같이 봐줘', user: 'U_OTHER' }))
  a.transport.deliver(a.transport.message({ addressed: false, text: '아 그리고 테스트도', user: 'U_OTHER' }))
  await sleep(2000)
  const accepted = a.logs.filter((l) => /accepted channel=/.test(l)).length
  check('thread: heard while its first turn there still runs', accepted === 3, `${accepted} accepted`)
  check('thread: two in a row are one turn, the earlier giving way', a.logs.filter((l) => /gave way/.test(l)).length === 1 && quietRuns(a) === 1, a.logs.filter((l) => /gave way|kept quiet/.test(l)).join(' | '))
  check('thread: the turn that timed out for a mention says so; the quiet one does not', a.transport.posted.filter((p) => p.text === '시간이 초과돼서 멈췄어.').length === 1, JSON.stringify(a.transport.posted.map((p) => p.text)))
  a.done()
  // (b) A quiet turn that runs long shows nothing: no status, no working message after progressAfterMs.
  const b = boot({ agent: 'slow', state: { sessions: { 'C_ALLOWED:t1': 's1' }, touched: { 'C_ALLOWED:t1': Date.now() } }, config: { replyMode: 'thread', fake: { typing: true } } })
  await sleep(60)
  b.transport.deliver(b.transport.message({ addressed: false }))
  await sleep(400)
  check('thread: a long quiet turn shows nothing while it runs', b.transport.posted.length === 0 && b.transport.typing.length === 0, `${JSON.stringify(b.transport.posted.map((p) => p.text))} ${b.transport.typing.length} status(es)`)
  // A tool it runs meanwhile does not put up the working message either.
  b.fire('s1', { type: 'tool/call', data: { name: 'bash' } })
  await sleep(150)
  check('thread: nor does a tool it runs', b.transport.posted.length === 0, JSON.stringify(b.transport.posted.map((p) => p.text)))
  const marked = b.read().inflight?.['C_ALLOWED:t1']?.quiet === true
  b.transport.deliver(b.transport.message({ text: '이것도 봐줘' }))
  await sleep(150)
  const record = b.read().inflight?.['C_ALLOWED:t1']
  check('thread: its in-flight record is marked quiet, and a mention after it unmarks it', marked && record !== undefined && record.quiet === undefined, JSON.stringify(record))
  b.done()
  // (c) "그만" without a mention is not a stop, from anyone: said to a person, it stopped a turn nobody saw and
  // withdrew everyone's waiting messages. Not the requester's either, during their turn or a quiet one after it.
  const c = boot({ agent: 'slow', config: { replyMode: 'thread', runTimeoutMs: 600, fake: { typing: true } } })
  await sleep(60)
  c.transport.deliver(c.transport.message({ text: '배포 로그 봐줘', user: 'U_ASKER' }))
  await sleep(200)
  c.transport.deliver(c.transport.message({ addressed: false, text: '그만', user: 'U_ASKER' }))
  await sleep(900)
  c.transport.deliver(c.transport.message({ addressed: false, text: '회의 어떻게 됐어?', user: 'U_OTHER' }))
  await sleep(200)
  c.transport.deliver(c.transport.message({ addressed: false, text: '그만', user: 'U_ASKER' }))
  await sleep(300)
  check('thread: "그만" without a mention stops nothing, the requester\'s neither', !c.logs.some((l) => /cancel requested/.test(l)) && !c.transport.posted.some((p) => p.text === '중단했어.'), c.logs.filter((l) => /cancel requested|accepted/.test(l)).join(' | '))
  c.done()
  // (c2) An approval a quiet turn raises is its author's: they may answer it without a mention, in the buttons' words.
  const c2 = boot({ agent: 'slow', state: { sessions: { 'C_ALLOWED:t1': 's1' }, touched: { 'C_ALLOWED:t1': Date.now() } }, config: { replyMode: 'thread', fake: { typing: true } } })
  await sleep(60)
  c2.transport.deliver(c2.transport.message({ addressed: false, text: '빌드 폴더 날려도 될 듯', user: 'U_OTHER' }))
  await sleep(300)
  const raised = c2.ask('s1')
  await sleep(100)
  c2.transport.deliver(c2.transport.message({ addressed: false, text: '허용', user: 'U_OTHER' }))
  const outcome = await Promise.race([raised, sleep(500).then(() => 'pending')])
  check('thread: a quiet turn\'s approval is its author\'s to answer', outcome === 'allowed-once', String(outcome))
  c2.done()
  // (c3) A message with a file does not give way: its file would not be fetched for the later turn.
  const c3 = boot({ agent: 'slow', config: { replyMode: 'thread', runTimeoutMs: 300, fake: { typing: true } } })
  await sleep(60)
  c3.transport.deliver(c3.transport.message({ text: '로그 볼래?', user: 'U_ASKER' }))
  await sleep(150)
  c3.transport.deliver(c3.transport.message({ addressed: false, text: '이 로그 봐줘', files: [{ name: 'a.log' }] }))
  c3.transport.deliver(c3.transport.message({ addressed: false, text: '에러는 맨 아래야' }))
  await sleep(1800)
  check('thread: a message with a file does not give way to the next', !c3.logs.some((l) => /gave way/.test(l)) && c3.logs.filter((l) => /kept quiet/.test(l)).length === 2, c3.logs.filter((l) => /gave way|kept quiet/.test(l)).join(' | '))
  c3.done()
  // (c4) A working message a waiting message put up is that message's: a quiet turn ending before it leaves it be.
  const c4 = boot({ agent: 'slow', state: { sessions: { 'C_ALLOWED:t1': 's1' }, touched: { 'C_ALLOWED:t1': Date.now() } }, config: { replyMode: 'thread', runTimeoutMs: 300, fake: { remove: true } } })
  await sleep(60)
  c4.transport.deliver(c4.transport.message({ addressed: false, text: '음' }))
  await sleep(150)
  c4.transport.deliver(c4.transport.message({ text: '이거 봐줘', user: 'U_ASKER' }))
  await sleep(1800)
  const working = c4.transport.posted.findIndex((p) => /작업 중/.test(p.text))
  const workingTs = `ts-${working + 1}`
  const settled = c4.transport.posted.some((p) => p.replace === workingTs) || c4.transport.removed.some((r) => r.ts === workingTs)
  check('thread: the waiting message\'s working message is answered in place, not left behind', working !== -1 && settled && c4.transport.posted.some((p) => p.text === '시간이 초과돼서 멈췄어.'), `${JSON.stringify(c4.transport.posted.map((p) => [p.text.slice(0, 12), p.replace]))} removed ${JSON.stringify(c4.transport.removed)}`)
  c4.done()
  // (c5) A stop said with a mention, while a quiet turn runs, withdraws a message waiting with its working message up:
  // that working message is the quiet turn's to settle, and the stop's report takes its place.
  const c5 = boot({ agent: 'slow', state: { sessions: { 'C_ALLOWED:t1': 's1' }, touched: { 'C_ALLOWED:t1': Date.now() } }, config: { replyMode: 'thread', fake: { remove: true } } })
  await sleep(60)
  c5.transport.deliver(c5.transport.message({ addressed: false, text: '음' }))
  await sleep(150)
  c5.transport.deliver(c5.transport.message({ text: '이거 봐줘', user: 'U_ASKER' }))
  await sleep(150)
  c5.transport.deliver(c5.transport.message({ text: '그만', user: 'U_OTHER' }))
  await sleep(500)
  const up = c5.transport.posted.findIndex((p) => /작업 중/.test(p.text))
  const upTs = `ts-${up + 1}`
  const gone = c5.transport.posted.some((p) => p.replace === upTs) || c5.transport.removed.some((r) => r.ts === upTs)
  check('thread: a working message whose message a stop withdrew does not stay up', up !== -1 && gone, `${JSON.stringify(c5.transport.posted.map((p) => [p.text.slice(0, 12), p.replace]))} removed ${JSON.stringify(c5.transport.removed)}`)
  c5.done()
  // (f) Once only messages that did not mention it remain, the in-flight record says so: a restart then says nothing.
  // The turn for the mention times out at about 0.65 s, the quiet one after it at about 1.25 s: looked at between.
  const f = boot({ agent: 'slow', config: { replyMode: 'thread', runTimeoutMs: 500, fake: { typing: true } } })
  await sleep(60)
  f.transport.deliver(f.transport.message({ text: '봐줘', user: 'U_ASKER' }))
  await sleep(150)
  f.transport.deliver(f.transport.message({ addressed: false, text: '나도 궁금' }))
  await sleep(750)
  const runningQuiet = f.logs.some((l) => /turn cancelled cause=timed out/.test(l)) && !f.logs.some((l) => /kept quiet/.test(l))
  check('thread: with only a quiet turn left, the in-flight record is marked quiet', runningQuiet && f.read().inflight?.['C_ALLOWED:t1']?.quiet === true, `${runningQuiet} ${JSON.stringify(f.read().inflight)}`)
  f.done()
  // (e) A stop said to it with a mention ends a quiet turn, and is answered.
  const e = boot({ agent: 'slow', state: { sessions: { 'C_ALLOWED:t1': 's1' }, touched: { 'C_ALLOWED:t1': Date.now() } }, config: { replyMode: 'thread', fake: { typing: true } } })
  await sleep(60)
  e.transport.deliver(e.transport.message({ addressed: false }))
  await sleep(300)
  e.transport.deliver(e.transport.message({ text: '그만' }))
  await sleep(400)
  check('thread: a stop with a mention ends a quiet turn, and says so', e.transport.posted.some((p) => p.text === '중단했어.'), JSON.stringify(e.transport.posted.map((p) => p.text)))
  e.done()
  // (d) A restart that cut off only quiet turns says nothing; one with a mention in it still says it was lost.
  const since = Date.now() - 5000
  const d = boot({ state: { inflight: {
    'C_ALLOWED:t0': { channel: 'C_ALLOWED', threadTs: 't0', since, quiet: true },
    'C_ALLOWED:t1': { channel: 'C_ALLOWED', threadTs: 't1', since },
  } } })
  await sleep(500)
  const notices = d.transport.posted.filter((p) => /끊겼어/.test(p.text))
  check('thread: a restart says nothing where only quiet turns were cut off', notices.length === 1 && notices[0].target.threadTs === 't1', JSON.stringify(d.transport.posted.map((p) => [p.target.threadTs, p.text])))
  d.done()
}

// Progress marks through a turn that takes time: a digit while it runs, a cross when it times out, a stop sign when
// a person stops it, and a stop sign on a message a stop withdrew before it ran.
{
  const kinds = (t, ts) => t.transport.marks.filter((m) => m.ts === ts).map((m) => m.state.kind === 'working' ? `w${m.state.tenths}` : m.state.kind)
  const a = boot({ agent: 'slow', config: { markEveryMs: 20, runTimeoutMs: 400, fake: { marks: true, typing: true } } })
  await sleep(60)
  a.transport.deliver(a.transport.message({ ts: '2000.1' }))
  await sleep(900)
  const run = kinds(a, '2000.1')
  check('marks: taken, a digit while it runs (no repeats), a cross when it times out', run[0] === 'seen' && run.includes('w1') && run.at(-1) === 'failed' && run.every((k, i) => i === 0 || k !== run[i - 1]) && a.transport.lateMarks.length === 0, JSON.stringify({ run, late: a.transport.lateMarks }))
  a.done()
  // The in-flight record names the marked messages until their marks end: with one turn over and the next running,
  // only the next.
  const r = boot({ agent: 'slow', config: { markEveryMs: 20, runTimeoutMs: 400, fake: { marks: true, typing: true } } })
  await sleep(60)
  r.transport.deliver(r.transport.message({ ts: '2000.5', text: '하나' }))
  await sleep(100)
  r.transport.deliver(r.transport.message({ ts: '2000.6', text: '둘' }))
  // Read the moment the first one's mark ends (it times out), while the second runs: not after a fixed wait, which a
  // loaded machine can overshoot.
  let record = null
  for (let i = 0; i < 200 && record === null; i++) {
    await sleep(10)
    if (r.transport.marks.some((m) => m.ts === '2000.5' && m.state.kind === 'failed')) record = r.read().inflight?.['C_ALLOWED:t1'] ?? {}
  }
  check('marks: the in-flight record names the messages whose marks have not ended', JSON.stringify(record?.marked) === '["2000.6"]', JSON.stringify(record))
  r.done()
  const b = boot({ agent: 'slow', config: { markEveryMs: 20, fake: { marks: true, typing: true } } })
  await sleep(60)
  b.transport.deliver(b.transport.message({ ts: '2000.2', text: '첫째' }))
  await sleep(200)
  b.transport.deliver(b.transport.message({ ts: '2000.3', text: '둘째' }))
  await sleep(50)
  b.transport.deliver(b.transport.message({ ts: '2000.4', text: '그만' }))
  await sleep(500)
  check('marks: a person\'s stop ends the running one stopped', kinds(b, '2000.2').at(-1) === 'stopped', JSON.stringify(kinds(b, '2000.2')))
  check('marks: and the one it withdrew before it ran, stopped too', JSON.stringify(kinds(b, '2000.3')) === '["seen","stopped"]', JSON.stringify(kinds(b, '2000.3')))
  check('marks: the stop request itself gets none, and nothing comes after an end', kinds(b, '2000.4').length === 0 && b.transport.lateMarks.length === 0, JSON.stringify({ stop: kinds(b, '2000.4'), late: b.transport.lateMarks }))
  b.done()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
