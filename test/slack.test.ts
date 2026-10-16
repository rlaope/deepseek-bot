/**
 * The Slack transport's outbound payloads, pinned against a stubbed Web API.
 *
 * Found live, not here: a channel-level post could never be sent, because the transport
 * always included `thread_ts` — as an empty string when a target has no thread — and Slack
 * rejects that with `no_text`. The failure was logged and then reported as success with an
 * empty `ts`, so a caller would edit a message that did not exist and believe it had
 * answered. `tools/qa-slack.ts` caught it against the real workspace; this keeps it caught.
 *
 * No network: `globalThis.fetch` is stubbed and every request is inspected.
 *
 * Run: node test/slack.test.ts
 */
import './dist-fresh.ts'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSlackTransport } from '../dist/transports/slack.js'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** How the stub answers: per method, a delay, a forced error, or failure with `error`. */
interface StubOptions {
  delayMs?: Record<string, number>
  errors?: Record<string, string>
  fail?: string[]
  error?: string
}

/** Stub the Web API: record requests, answer with the shapes Slack answers with. */
function stubSlack(options: StubOptions = {}) {
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url, init = {}) => {
    const method = String(url).split('/api/')[1] ?? ''
    // The upload URL takes raw bytes, so the body is not always JSON — parsing it unconditionally
    // threw inside this stub and the transport reported failure.
    const raw = init.body === undefined ? '' : String(init.body)
    const body = raw.startsWith('{') ? JSON.parse(raw) : {}
    // When each call started and answered, so a test can see two in flight at once.
    const entry = { method, body, start: Date.now(), end: null }
    calls.push(entry)
    if (Number(options.delayMs?.[method]) > 0) await new Promise((r) => setTimeout(r, Number(options.delayMs[method])))
    entry.end = Date.now()
    // auth.test carries the workspace URL, which is where a permalink comes from.
    if (method === 'auth.test') {
      const auth = { ok: true, user: 'bot', user_id: 'U1', team: 'T1', team_id: 'T1ID', url: 'https://example.slack.com/' }
      return { ok: true, status: 200, json: async () => auth, text: async () => JSON.stringify(auth) }
    }
    const forced = options.errors?.[method]
    const ok = forced === undefined && options.fail?.includes(method) !== true
    // The file APIs answer with their own shapes; the chain below is for chat calls.
    if (ok && method === 'files.getUploadURLExternal') {
      return { ok: true, status: 200, json: async () => ({ ok: true, upload_url: 'https://upload.example/u/1', file_id: 'F1' }), text: async () => '' }
    }
    if (ok && method === 'files.completeUploadExternal') {
      return { ok: true, status: 200, json: async () => ({ ok: true, files: [{ id: 'F1' }] }), text: async () => '' }
    }
    const json = ok
      // chat.update answers with the same ts it updated; chat.postMessage with a new one.
      ? { ok: true, ts: method === 'chat.update' ? body.ts : `ts-${calls.length}`, channel: body.channel ?? 'C1' }
      : { ok: false, error: forced ?? options.error ?? 'no_text' }
    return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) }
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = realFetch } }
}

function transportFor(api) {
  const logs = []
  const t = createSlackTransport({
    cfg: { platform: 'slack', stateDir: '.', targetChannels: ['*'], slackTokenRef: 'SLACK_BOT_TOKEN', chunkChars: 4000 },
    log: (...parts) => logs.push(parts.join(' ')),
    sessionCwd: async () => process.cwd(),
    credential: async () => 'xoxb-fake',
    onHealth: () => {},
  })
  t.logs = logs
  t.api = api
  return t
}

// 1. A channel-level post must not carry an empty thread_ts.
{
  const api = stubSlack()
  const t = transportFor(api)
  await t.authenticate()
  const sent = await t.post({ channel: 'C1', threadTs: null }, 'hello')
  api.restore()
  const post = api.calls.find((c) => c.method === 'chat.postMessage')
  check('a channel post goes to chat.postMessage', post !== undefined, JSON.stringify(api.calls.map((c) => c.method)))
  check('and carries the text', post?.body?.text === 'hello', JSON.stringify(post?.body))
  check('and does NOT carry an empty thread_ts', !('thread_ts' in (post?.body ?? {})), JSON.stringify(post?.body))
  check('it returns the message id Slack gave', sent?.ts === 'ts-1', JSON.stringify(sent))
}

// 2. A threaded post still threads.
{
  const api = stubSlack()
  const t = transportFor(api)
  await t.authenticate()
  await t.post({ channel: 'C1', threadTs: '111.222' }, 'in thread')
  api.restore()
  const post = api.calls.find((c) => c.method === 'chat.postMessage')
  check('a threaded post keeps thread_ts', post?.body?.thread_ts === '111.222', JSON.stringify(post?.body))
}

// 3. A refused post is reported as nothing, not as an empty message.
{
  const api = stubSlack({ fail: ['chat.postMessage'] })
  const t = transportFor(api)
  await t.authenticate()
  const sent = await t.post({ channel: 'C1', threadTs: null }, 'hello')
  api.restore()
  check('a refused post returns null', sent === null, JSON.stringify(sent))
  check('and says why in the log', t.logs.some((l) => /reply post failed: no_text/.test(l)), t.logs.join(' | ').slice(0, 120))
}

// 4. Long text is chunked, numbered, and the first id is returned.
{
  const api = stubSlack()
  const t = transportFor(api)
  await t.authenticate()
  const sent = await t.post({ channel: 'C1', threadTs: null }, 'x'.repeat(9000))
  api.restore()
  const posts = api.calls.filter((c) => c.method === 'chat.postMessage')
  check('9000 characters become three posts', posts.length === 3, String(posts.length))
  check('each is within the limit', posts.every((c) => c.body.text.length <= 4000), posts.map((c) => c.body.text.length).join(', '))
  check('each is numbered', posts.every((c, i) => c.body.text.startsWith(`(${i + 1}/3)`)), posts[0]?.body?.text.slice(0, 8))
  check('the first id is returned, not the last', sent?.ts === 'ts-1', JSON.stringify(sent))
}

// 5. Replacing uses chat.update and keeps the id.
{
  const api = stubSlack()
  const t = transportFor(api)
  await t.authenticate()
  const sent = await t.post({ channel: 'C1', threadTs: null }, 'the answer', { replace: 'ts-original' })
  api.restore()
  const update = api.calls.find((c) => c.method === 'chat.update')
  check('a replace calls chat.update', update !== undefined, JSON.stringify(api.calls.map((c) => c.method)))
  check('against the given ts', update?.body?.ts === 'ts-original', JSON.stringify(update?.body))
  check('and does not post a second message', !api.calls.some((c) => c.method === 'chat.postMessage'))
  check('the returned id is the replaced one', sent?.ts === 'ts-original', JSON.stringify(sent))
}

// 6. A refused replace falls back to a new message rather than losing the answer.
{
  const api = stubSlack({ fail: ['chat.update'] })
  const t = transportFor(api)
  await t.authenticate()
  const sent = await t.post({ channel: 'C1', threadTs: null }, 'the answer', { replace: 'gone' })
  api.restore()
  check('a failed replace posts a new message', api.calls.some((c) => c.method === 'chat.postMessage'), JSON.stringify(api.calls.map((c) => c.method)))
  check('and the answer is still reported as sent', sent?.ts !== undefined && sent?.ts !== '', JSON.stringify(sent))
}

// 6b. Removing a message uses chat.delete. The working message is removed rather than edited into the
// answer, because an edit raises no notification and every answer would have arrived as "작업 중".
{
  const api = stubSlack()
  const t = transportFor(api)
  await t.authenticate()
  const removed = await t.remove({ channel: 'C1', threadTs: 't1' }, 'ts-working')
  const del = api.calls.find((c) => c.method === 'chat.delete')
  check('remove calls chat.delete on that message', del?.body?.channel === 'C1' && del?.body?.ts === 'ts-working', JSON.stringify(del?.body))
  check('and reports success', removed === true)
  api.restore()

  const refused = stubSlack({ fail: ['chat.delete'], error: 'message_not_found' })
  const t2 = transportFor(refused)
  await t2.authenticate()
  const result = await t2.remove({ channel: 'C1', threadTs: 't1' }, 'gone')
  refused.restore()
  check('a refused delete is reported as false and logged', result === false && t2.logs.some((l) => /delete failed.*message_not_found/.test(l)),
    t2.logs.join(' | ').slice(0, 90))
}

// 6c. The working status: Slack's own "<app> 앱이 작업 중" under the thread, not a message of ours.
// agents.sessions.setStatus first, assistant.threads.setStatus when the workspace refuses it, and the
// core's working message when both do. A refusal that will not change (a scope, a feature) is
// remembered; one that depends on the conversation is not.
{
  const settle = () => new Promise((r) => setTimeout(r, 30))
  const calls = (api, method) => api.calls.filter((c) => c.method === method).map((c) => c.body)

  const api = stubSlack()
  const t = transportFor(api)
  await t.authenticate()
  let unavailable = 0
  const stop = t.startTyping({ channel: 'C1', threadTs: 't1' }, () => { unavailable++ })
  await settle()
  stop()
  await settle()
  const sessions = calls(api, 'agents.sessions.setStatus')
  check('the session status goes to processing for the thread', sessions[0]?.channel_id === 'C1' && sessions[0]?.thread_ts === 't1' && sessions[0]?.status === 'processing',
    JSON.stringify(sessions[0]))
  check('and back to active when the turn is over', sessions[1]?.status === 'active', JSON.stringify(sessions[1]))
  check('no fallback was asked for', unavailable === 0)
  api.restore()

  const api2 = stubSlack({ errors: { 'agents.sessions.setStatus': 'feature_disabled' } })
  const t2 = transportFor(api2)
  await t2.authenticate()
  const stop2 = t2.startTyping({ channel: 'C1', threadTs: 't1' }, () => {})
  await settle()
  stop2()
  await settle()
  const assistant = calls(api2, 'assistant.threads.setStatus')
  check('a workspace without agent sessions gets the assistant status', assistant[0]?.status === 'Working…' && assistant[0]?.thread_ts === 't1', JSON.stringify(assistant[0]))
  check('which is cleared when the turn is over', assistant[1]?.status === '', JSON.stringify(assistant[1]))
  api2.restore()

  const api3 = stubSlack({ errors: { 'agents.sessions.setStatus': 'missing_scope', 'assistant.threads.setStatus': 'missing_scope' } })
  const t3 = transportFor(api3)
  await t3.authenticate()
  let fell = 0
  t3.startTyping({ channel: 'C1', threadTs: 't1' }, () => { fell++ })
  await settle()
  check('when both are refused the core is told to show its own message', fell === 1)
  check('and the transport remembers a refusal that will not change', t3.typingUnavailable === true)
  const before = api3.calls.length
  t3.startTyping({ channel: 'C1', threadTs: 't2' }, () => { fell++ })
  check('so the next turn asks Slack nothing and falls back at once', fell === 2 && api3.calls.length === before)
  api3.restore()

  const api4 = stubSlack({ errors: { 'agents.sessions.setStatus': 'method_not_supported_for_channel_type', 'assistant.threads.setStatus': 'method_not_supported_for_channel_type' } })
  const t4 = transportFor(api4)
  await t4.authenticate()
  let fell4 = 0
  t4.startTyping({ channel: 'C1', threadTs: 't1' }, () => { fell4++ })
  await settle()
  check('a refusal for this kind of conversation falls back but is not remembered', fell4 === 1 && t4.typingUnavailable !== true)
  api4.restore()

  // The status belongs to the thread, not to a message: with M2 waiting behind M1 in one thread, M1's
  // end set it back to active and M2 ran with nothing shown. It is cleared by the last one to stop,
  // and set again after an earlier one stops — a reply clears the assistant status on Slack's side.
  for (const [label, errors, method, cleared] of [
    ['session status', {}, 'agents.sessions.setStatus', 'active'],
    ['assistant status', { 'agents.sessions.setStatus': 'feature_disabled' }, 'assistant.threads.setStatus', ''],
  ] as Array<[string, Record<string, string>, string, string]>) {
    const api5 = stubSlack({ errors })
    const t5 = transportFor(api5)
    await t5.authenticate()
    const stopFirst = t5.startTyping({ channel: 'C1', threadTs: 't1' }, () => {})
    const stopSecond = t5.startTyping({ channel: 'C1', threadTs: 't1' }, () => {})
    await settle()
    stopFirst()
    await settle()
    check(`${label}: the first to stop does not clear it while another is working`, !calls(api5, method).some((b) => b.status === cleared),
      JSON.stringify(calls(api5, method).map((b) => b.status)))
    const setBefore = calls(api5, method).filter((b) => b.status !== cleared).length
    await new Promise((r) => setTimeout(r, 1700))
    check(`${label}: and it is set again for the one still working`, calls(api5, method).filter((b) => b.status !== cleared).length > setBefore)
    stopSecond()
    await settle()
    check(`${label}: the last to stop clears it`, calls(api5, method).at(-1)?.status === cleared, JSON.stringify(calls(api5, method).at(-1)))
    api5.restore()
  }

  // The last to stop clears what the thread shows, not only what it set itself. M1 shows the status; M2's
  // own attempts are refused for the moment (rate limited) and it falls back to a message; M1 stops, and
  // its re-set shows the status again; M2 stops last — and left "processing" for good. (Found by the
  // verification pass.)
  const opts = { errors: {} }
  const api6 = stubSlack(opts)
  const t6 = transportFor(api6)
  await t6.authenticate()
  const stopM1 = t6.startTyping({ channel: 'C1', threadTs: 't1' }, () => {})
  await settle()
  opts.errors = { 'agents.sessions.setStatus': 'ratelimited', 'assistant.threads.setStatus': 'ratelimited' }
  let fellBack = 0
  const stopM2 = t6.startTyping({ channel: 'C1', threadTs: 't1' }, () => { fellBack++ })
  await settle()
  opts.errors = {}
  stopM1()
  await new Promise((r) => setTimeout(r, 1700))
  stopM2()
  await settle()
  const statuses = calls(api6, 'agents.sessions.setStatus').map((b) => b.status)
  check('the last to stop clears a status another one set', fellBack === 1 && statuses.at(-1) === 'active', JSON.stringify(statuses))
  api6.restore()

  // Both kinds at once: M1 shows the session status; M2's is refused for the moment and it shows the
  // assistant status instead. Whoever stops last clears both — one remembered kind cleared only one, and
  // the thread kept "processing". (Second verification pass.)
  const opts7 = { errors: {} }
  const api7 = stubSlack(opts7)
  const t7 = transportFor(api7)
  await t7.authenticate()
  const stopA = t7.startTyping({ channel: 'C1', threadTs: 't1' }, () => {})
  await settle()
  opts7.errors = { 'agents.sessions.setStatus': 'ratelimited' }
  const stopB = t7.startTyping({ channel: 'C1', threadTs: 't1' }, () => {})
  await settle()
  opts7.errors = {}
  stopB()
  await new Promise((r) => setTimeout(r, 1700))
  stopA()
  await settle()
  const sessions7 = calls(api7, 'agents.sessions.setStatus').map((b) => b.status)
  const assistant7 = calls(api7, 'assistant.threads.setStatus').map((b) => b.status)
  check('both kinds a thread showed are cleared', sessions7.at(-1) === 'active' && assistant7.at(-1) === '', `${JSON.stringify(sessions7)} ${JSON.stringify(assistant7)}`)
  api7.restore()

  // One call at a time per thread: a clear sent while a re-set was still on its way could reach Slack
  // first and leave "processing" behind. (Second verification pass.)
  const api8 = stubSlack({ delayMs: { 'agents.sessions.setStatus': 300 } })
  const t8 = transportFor(api8)
  await t8.authenticate()
  const stopC = t8.startTyping({ channel: 'C1', threadTs: 't1' }, () => {})
  const stopD = t8.startTyping({ channel: 'C1', threadTs: 't1' }, () => {})
  await new Promise((r) => setTimeout(r, 700))
  stopC()
  await new Promise((r) => setTimeout(r, 1600))     // the re-set is on its way
  stopD()
  await new Promise((r) => setTimeout(r, 900))
  const all8 = api8.calls.filter((c) => c.method === 'agents.sessions.setStatus')
  const overlapping = all8.filter((a) => all8.some((b) => b !== a && b.start <= a.start && b.end !== null && a.start < b.end))
  check('a thread\'s status calls never overlap', overlapping.length === 0, JSON.stringify(all8.map((c) => [c.body.status, c.start - all8[0].start, c.end - all8[0].start])))
  check('and the last one clears it', all8.at(-1)?.body?.status === 'active', JSON.stringify(all8.map((c) => c.body.status)))
  api8.restore()

  // Nothing is kept for a thread once its messages are done — also where both kinds were refused for
  // the moment and the stop had nothing to clear: its call chain stayed, one per such thread, for the
  // life of the process. (Third verification pass.)
  const opts9: StubOptions = { errors: { 'agents.sessions.setStatus': 'ratelimited', 'assistant.threads.setStatus': 'ratelimited' } }
  const api9 = stubSlack(opts9)
  const t9 = transportFor(api9)
  await t9.authenticate()
  for (const thread of ['t1', 't2', 't3']) {
    const stop = t9.startTyping({ channel: 'C1', threadTs: thread }, () => {})
    await settle()
    stop()
  }
  opts9.errors = {}
  const okStop = t9.startTyping({ channel: 'C1', threadTs: 't4' }, () => {})
  await settle()
  okStop()
  await settle()
  check('no thread\'s status bookkeeping outlives its messages', t9.statusThreads === 0, String(t9.statusThreads))
  api9.restore()
}

// 6d. Upload bytes the caller already read are sent as they are; the path is only the file's name.
{
  const api = stubSlack()
  const t = transportFor(api)
  await t.authenticate()
  const realFetch = globalThis.fetch
  let sent = null
  globalThis.fetch = (async (url, init = {}) => {
    if (String(url).startsWith('https://upload.example/')) { sent = Buffer.from(init.body as Uint8Array).toString('utf8'); return { ok: true, status: 200 } }
    return realFetch(url, init)
  }) as typeof fetch
  const ok = await t.uploadFile({ channel: 'C1', threadTs: 't1' }, '/nonexistent/dir/report.docx', undefined, Buffer.from('handed over'))
  globalThis.fetch = realFetch
  api.restore()
  check('given bytes are uploaded without reading the path', ok === true && sent === 'handed over', JSON.stringify(sent))
  check('under the file\'s own name', api.calls.find((c) => c.method === 'files.getUploadURLExternal')?.body?.filename === 'report.docx')
}

// 6e. Approval buttons on Slack: a decision made in place, as on Discord. They used to exist only there;
// a Slack user had to type 허용. Block Kit carries them, the text stays for notifications, and the press
// comes back over Socket Mode as an interactive envelope.
{
  const api = stubSlack()
  const t = transportFor(api)
  await t.authenticate()
  check('the transport says it can render buttons', t.supportsButtons === true)
  await t.post({ channel: 'C1', threadTs: 't1' }, '⚠️ 권한이 필요해', {
    buttons: [{ id: 'approval:allow:C1:t1', label: '허용', style: 'primary' }, { id: 'approval:deny:C1:t1', label: '거부', style: 'danger' }],
  })
  api.restore()
  const body = api.calls.find((c) => c.method === 'chat.postMessage')?.body
  const actions = (body?.blocks ?? []).find((b) => b.type === 'actions')
  check('the message carries an actions block', actions?.elements?.length === 2, JSON.stringify(body?.blocks)?.slice(0, 120))
  check('each button carries its id and style', actions?.elements?.[0]?.action_id === 'approval:allow:C1:t1' && actions?.elements?.[0]?.style === 'primary'
    && actions?.elements?.[1]?.style === 'danger', JSON.stringify(actions?.elements))
  check('and the text is still there for the notification', body?.text?.includes('권한이 필요해'))

  // The press, as Socket Mode delivers it.
  const sockets = []
  class FakeSocket {
    handlers: Record<string, Array<(data: unknown) => void>>
    sent: unknown[]
    constructor() { this.handlers = {}; this.sent = []; sockets.push(this) }
    addEventListener(type, fn) { (this.handlers[type] ??= []).push(fn) }
    send(payload) { this.sent.push(JSON.parse(payload)) }
    close() {}
    emit(type, data) { for (const fn of this.handlers[type] ?? []) fn(data) }
  }
  const api2 = stubSlack()
  const pressed = []
  const t2 = createSlackTransport({
    cfg: { platform: 'slack', stateDir: '.', targetChannels: ['*'], chunkChars: 4000 },
    log: () => {}, sessionCwd: async () => process.cwd(), credential: async () => 'token-for-test', onHealth: () => {},
    WebSocketImpl: FakeSocket,
  })
  await t2.connect({ onMessage: () => {}, onAction: (action) => pressed.push(action) })
  sockets[0].emit('message', { data: JSON.stringify({
    envelope_id: 'E1', type: 'interactive',
    payload: { type: 'block_actions', user: { id: 'U9' }, channel: { id: 'C1' }, message: { ts: '2.2', thread_ts: 't1' },
      actions: [{ action_id: 'approval:allow:C1:t1', value: 'approval:allow:C1:t1' }] },
  }) })
  await t2.close()
  api2.restore()
  check('a press reaches the core', pressed.length === 1 && pressed[0].id === 'approval:allow:C1:t1', JSON.stringify(pressed))
  check('with the thread and the person who pressed', pressed[0]?.target?.channel === 'C1' && pressed[0]?.target?.threadTs === 't1' && pressed[0]?.user === 'U9')
  check('and the envelope is acknowledged', sockets[0].sent.some((m) => m.envelope_id === 'E1'))
}

// 7. A transport built without a chunk size still sends the text.
// Found live: the QA harness passed a partial config, chunkChars was undefined, the slice
// went to NaN, and every reply was an empty body — which Slack answers with `no_text`. The
// failure was total and silent, and the cause was a missing setting.
{
  const api = stubSlack()
  const logs = []
  const bare = createSlackTransport({
    cfg: { platform: 'slack', stateDir: '.', targetChannels: ['*'], slackTokenRef: 'SLACK_BOT_TOKEN' },
    log: (...parts) => logs.push(parts.join(' ')),
    sessionCwd: async () => process.cwd(),
    credential: async () => 'xoxb-fake',
    onHealth: () => {},
  })
  await bare.authenticate()
  const sent = await bare.post({ channel: 'C1', threadTs: null }, 'hello without a configured chunk size')
  api.restore()
  const post = api.calls.find((c) => c.method === 'chat.postMessage')
  check('a missing chunk size does not empty the body', post?.body?.text === 'hello without a configured chunk size', JSON.stringify(post?.body?.text).slice(0, 60))
  check('and the message is reported as sent', sent?.ts !== undefined, JSON.stringify(sent))
}

// 8. Reply text carries clickable links, which is what a person can actually use.
{
  const api = stubSlack()
  const t = transportFor(api)
  await t.authenticate()
  await t.post({ channel: 'C1', threadTs: null }, 'see [the docs](https://example.com/a) and **this**')
  api.restore()
  const body = api.calls.find((c) => c.method === 'chat.postMessage')?.body?.text ?? ''
  check('a markdown link becomes a Slack link', body.includes('<https://example.com/a|the docs>'), body.slice(0, 90))
  check('and the markdown form is gone', !body.includes('](https://example.com/a)'))
  check('bold still converts', body.includes('*this*'))
  // Slack shows no tables: one arrives as a list, in Slack's own bullets and bold.
  const apiT = stubSlack()
  const tT = transportFor(apiT)
  await tT.authenticate()
  await tT.post({ channel: 'C1', threadTs: null }, '| 층 | 값 |\n|---|---|\n| 페르소나 | 아리 |')
  apiT.restore()
  const table = apiT.calls.find((c) => c.method === 'chat.postMessage')?.body?.text ?? ''
  check('a table arrives as a list', table === '• *페르소나* — 아리', JSON.stringify(table))
  // A list keeps the blank line before it: the bullet rule matched across line ends and ate it.
  const apiL = stubSlack()
  const tL = transportFor(apiL)
  await tL.authenticate()
  await tL.post({ channel: 'C1', threadTs: null }, '소개:\n\n- 하나\n- 둘')
  apiL.restore()
  const listed = apiL.calls.find((c) => c.method === 'chat.postMessage')?.body?.text ?? ''
  check('a list keeps the blank line before it', listed === '소개:\n\n• 하나\n• 둘', JSON.stringify(listed))

  const api2 = stubSlack()
  const t2 = transportFor(api2)
  await t2.authenticate()
  await t2.post({ channel: 'C1', threadTs: null }, 'bare https://example.com/b and a path /Users/x/note.docx')
  api2.restore()
  const body2 = api2.calls.find((c) => c.method === 'chat.postMessage')?.body?.text ?? ''
  check('a bare URL is left for Slack to link', body2.includes('https://example.com/b') && !body2.includes('<https://example.com/b'), body2.slice(0, 70))
  check('a local path is left as text, because it cannot be a link', body2.includes('/Users/x/note.docx'), body2.slice(-40))
}

// 9. A document is uploaded rather than named: a local path cannot be clicked, so the file travels.
{
  const api = stubSlack()
  const t = transportFor(api)
  await t.authenticate()
  const dir = mkdtempSync(join(tmpdir(), 'deepbot-upload-'))
  const file = join(dir, 'report.docx')
  const bytes = 'pretend docx bytes'
  writeFileSync(file, bytes)
  const ok = await t.uploadFile({ channel: 'C1', threadTs: '111.222' }, file, 'the report')
  const names = api.calls.map((c) => c.method)
  const started = api.calls.find((c) => c.method === 'files.getUploadURLExternal')
  const done = api.calls.find((c) => c.method === 'files.completeUploadExternal')
  api.restore()
  check('uploading asks for a URL first', names.includes('files.getUploadURLExternal'), names.join(', '))
  check('and names the file and its size', started?.body?.filename === 'report.docx' && started?.body?.length === bytes.length, JSON.stringify(started?.body))
  check('the bytes go to the URL it was given', names.filter((x) => x === '').length === 1, names.join(', '))
  check('and it is completed into the thread', done?.body?.channel_id === 'C1' && done?.body?.thread_ts === '111.222', JSON.stringify(done?.body))
  check('with the title asked for', done?.body?.files?.[0]?.title === 'the report', JSON.stringify(done?.body?.files))
  check('and reports success', ok === true, String(ok))
  rmSync(dir, { recursive: true, force: true })
}

// 9. A conversation reference can be a link, not a description.
{
  const api = stubSlack()
  const t = transportFor(api)
  await t.authenticate()
  await t.identity()
  const link = t.permalinkFor({ channel: 'C1', threadTs: '111.222' }, 'this thread')
  const bare = t.permalinkFor({ channel: 'C1', threadTs: null })
  api.restore()
  check('a thread gets a permalink', link === '<https://example.slack.com/archives/C1/p111222|this thread>', String(link))
  check('and the label is what was asked for', /\|this thread>$/.test(String(link)), String(link))
  check('a channel without a thread has no permalink', bare === null, String(bare))
}

// replyMode 'thread': a message in a thread comes in without a mention, marked not addressed (the core knows which
// threads the bot takes part in); one at the top of a channel does not; one that mentions the bot comes as its
// app_mention, so its message event is dropped and the turn is not taken twice.
{
  const api = stubSlack()
  const received: Record<string, Array<{ ts: string; addressed: boolean; target: { threadTs: string | null } }>> = {}
  for (const mode of ['thread', 'mention', 'all']) {
    const sockets = []
    class EventSocket {
      handlers: Record<string, Array<(data: unknown) => void>>
      sent: unknown[]
      constructor() { this.handlers = {}; this.sent = []; sockets.push(this) }
      addEventListener(type, fn) { (this.handlers[type] ??= []).push(fn) }
      send(payload) { this.sent.push(JSON.parse(payload)) }
      close() {}
      emit(type, data) { for (const fn of this.handlers[type] ?? []) fn(data) }
    }
    const got = []
    const t = createSlackTransport({
      cfg: { platform: 'slack', stateDir: '.', targetChannels: ['*'], chunkChars: 4000, replyMode: mode },
      log: () => {}, sessionCwd: async () => process.cwd(), credential: async () => 'token-for-test', onHealth: () => {},
      WebSocketImpl: EventSocket,
    })
    await t.connect({ onMessage: (m) => got.push(m) })
    await t.identity()   // as the core does at start: the bot's own id, which a mention is told by
    const send = (id, event) => sockets[0].emit('message', { data: JSON.stringify({ envelope_id: id, type: 'events_api', payload: { event_id: id, event } }) })
    send('Ev1', { type: 'message', channel: 'C1', channel_type: 'channel', user: 'U7', ts: '5.1', thread_ts: '5.0', text: '내일 같이 보자' })
    send('Ev2', { type: 'message', channel: 'C1', channel_type: 'channel', user: 'U7', ts: '6.0', text: 'top of the channel' })
    send('Ev3', { type: 'message', channel: 'C1', channel_type: 'channel', user: 'U7', ts: '5.2', thread_ts: '5.0', text: '<@U1> 봐줘' })
    send('Ev4', { type: 'app_mention', channel: 'C1', user: 'U7', ts: '5.2', thread_ts: '5.0', text: '<@U1> 봐줘' })
    // The bot's own reply, another bot's, an edit; a file shared with words, a reply also sent to the channel.
    send('Ev5', { type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', ts: '5.3', thread_ts: '5.0', text: '내가 한 말' })
    send('Ev6', { type: 'message', channel: 'C1', channel_type: 'channel', bot_id: 'B9', user: 'U8', ts: '5.4', thread_ts: '5.0', text: '다른 봇' })
    send('Ev7', { type: 'message', subtype: 'message_changed', channel: 'C1', channel_type: 'channel', user: 'U7', ts: '5.5', thread_ts: '5.0', text: '고침' })
    send('Ev8', { type: 'message', subtype: 'file_share', channel: 'C1', channel_type: 'channel', user: 'U7', ts: '5.6', thread_ts: '5.0', text: '이 로그 봐줘', files: [] })
    send('Ev9', { type: 'message', subtype: 'thread_broadcast', channel: 'C1', channel_type: 'channel', user: 'U7', ts: '5.7', thread_ts: '5.0', text: '채널에도 보냄' })
    // In a DM, a file shared with words: a turn in every mode (it was dropped, the subtype read as not a person's).
    send('Ev10', { type: 'message', subtype: 'file_share', channel: 'D1', channel_type: 'im', user: 'U7', ts: '7.1', text: '이 파일 봐줘', files: [] })
    await t.close()
    received[mode] = got
  }
  api.restore()
  const thread = received.thread ?? []
  check('thread: a message in a thread comes in without a mention, not addressed', thread.some((m) => m.ts === '5.1' && m.addressed === false && m.target.threadTs === '5.0'), JSON.stringify(thread.map((m) => [m.ts, m.addressed])))
  check('thread: one at the top of a channel does not', !thread.some((m) => m.ts === '6.0'))
  check('thread: a mention comes once, as its app_mention, addressed', thread.filter((m) => m.ts === '5.2').length === 1 && thread.find((m) => m.ts === '5.2')?.addressed === true, JSON.stringify(thread.map((m) => [m.ts, m.addressed])))
  check('thread: its own reply, another bot\'s and an edit do not come in', !thread.some((m) => ['5.3', '5.4', '5.5'].includes(m.ts)), JSON.stringify(thread.map((m) => m.ts)))
  check('thread: a file shared with words, or a reply also sent to the channel, does', thread.some((m) => m.ts === '5.6' && m.addressed === false) && thread.some((m) => m.ts === '5.7'), JSON.stringify(thread.map((m) => m.ts)))
  check('every mode: a file shared with words in a DM comes in, addressed', ['thread', 'mention', 'all'].every((mode) => (received[mode] ?? []).some((m) => m.ts === '7.1' && m.addressed === true)), JSON.stringify(Object.fromEntries(Object.entries(received).map(([k, v]) => [k, v.map((m) => m.ts)]))))
  const all = received.all ?? []
  check('all: a mention comes once too (the manifest now sends the channel\'s messages as well)', all.filter((m) => m.ts === '5.2').length === 1 && all.some((m) => m.ts === '5.1' && m.addressed === true), JSON.stringify(all.map((m) => [m.ts, m.addressed])))
  check('mention: a message in a thread without a mention does not come in', !(received.mention ?? []).some((m) => m.ts === '5.1') && (received.mention ?? []).some((m) => m.ts === '5.2'), JSON.stringify((received.mention ?? []).map((m) => m.ts)))
}

// A long thread's history from what was seen last: without `oldest`, conversations.replies gave its oldest page, and
// in a thread past the limit the new lines never arrived.
{
  const api = stubSlack()
  const t = createSlackTransport({
    cfg: { platform: 'slack', stateDir: '.', targetChannels: ['*'], chunkChars: 4000, fetchHistory: true, historyLimit: 20 },
    log: () => {}, sessionCwd: async () => process.cwd(), credential: async () => 'xoxb-fake', onHealth: () => {},
  })
  await t.authenticate()
  await t.fetchHistory({ channel: 'C1', threadTs: '5.0' }, { currentTs: '5.9', sinceTs: '5.3', limit: 20, maxChars: 4000 })
  await t.fetchHistory({ channel: 'C1', threadTs: '5.0' }, { currentTs: '5.9', sinceTs: null, limit: 20, maxChars: 4000 })
  api.restore()
  const replies = api.calls.filter((c) => c.method.startsWith('conversations.replies')).map((c) => c.method)
  check('history: a thread is read from the last message seen, and whole the first time', replies.length === 2 && /[?&]oldest=5\.3(&|$)/.test(replies[0]) && !/oldest=/.test(replies[1]), JSON.stringify(replies))
}

// The history keeps a message shared with a file: it is a person's words too.
{
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url) => {
    const u = String(url)
    const body = u.includes('conversations.replies')
      ? { ok: true, messages: [{ ts: '5.1', user: 'U7', subtype: 'file_share', text: '이 로그 봐줘', files: [] }, { ts: '5.2', user: 'U7', subtype: 'channel_join', text: 'joined' }] }
      : { ok: true, members: [], response_metadata: { next_cursor: '' } }
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
  }) as typeof fetch
  const t = createSlackTransport({
    cfg: { platform: 'slack', stateDir: '.', targetChannels: ['*'], chunkChars: 4000, fetchHistory: true, historyLimit: 20 },
    log: () => {}, sessionCwd: async () => process.cwd(), credential: async () => 'xoxb-fake', onHealth: () => {},
  })
  await t.authenticate()
  const h = await t.fetchHistory({ channel: 'C1', threadTs: '5.0' }, { currentTs: '5.9', sinceTs: null, limit: 20, maxChars: 4000 })
  globalThis.fetch = realFetch
  check('history: a message shared with a file is kept; a join is not', h.text.includes('이 로그 봐줘') && !h.text.includes('joined'), JSON.stringify(h.text))
}

// A long thread: of what is new since the pointer, the newest `historyLimit` lines, not its oldest page.
{
  const realFetch = globalThis.fetch
  const asked = []
  globalThis.fetch = (async (url) => {
    const u = String(url)
    if (u.includes('conversations.replies')) asked.push(u)
    const body = u.includes('conversations.replies')
      ? { ok: true, messages: Array.from({ length: 30 }, (_, i) => ({ ts: `6.${String(i + 1).padStart(2, '0')}`, user: 'U7', text: `line ${i + 1}` })) }
      : { ok: true, members: [], response_metadata: { next_cursor: '' } }
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
  }) as typeof fetch
  const t = createSlackTransport({
    cfg: { platform: 'slack', stateDir: '.', targetChannels: ['*'], chunkChars: 4000, fetchHistory: true, historyLimit: 5, historyMaxChars: 4000 },
    log: () => {}, sessionCwd: async () => process.cwd(), credential: async () => 'xoxb-fake', onHealth: () => {},
  })
  await t.authenticate()
  const h = await t.fetchHistory({ channel: 'C1', threadTs: '6.00' }, { currentTs: '6.31', sinceTs: '6.00', limit: 5, maxChars: 4000 })
  globalThis.fetch = realFetch
  const shown = [...h.text.matchAll(/line (\d+)/g)].map((m) => Number(m[1]))
  check('history: a long thread gives its newest lines', JSON.stringify(shown) === '[26,27,28,29,30]' && h.lastTs === '6.30' && /[?&]limit=200(&|$)/.test(asked[0] ?? ''), `${JSON.stringify(shown)} last ${h.lastTs} ${asked[0]}`)
}

// Progress on the person's message, as reactions: eyes when taken, a digit while it runs, a check or a cross at the
// end. One reaction at a time: the next is added before the last is taken off.
{
  const api = stubSlack()
  const t = transportFor(api)
  await t.authenticate()
  const at = { channel: 'C1', threadTs: '5.0' }
  const pause = () => new Promise((r) => setTimeout(r, 15))
  t.mark(at, '5.1', { kind: 'seen' }); await pause()
  t.mark(at, '5.1', { kind: 'working', tenths: 3 }); await pause()
  t.mark(at, '5.1', { kind: 'working', tenths: 3 }); await pause()
  t.mark(at, '5.1', { kind: 'done' })
  await new Promise((r) => setTimeout(r, 50))
  api.restore()
  const calls = api.calls.filter((c) => c.method.startsWith('reactions.')).map((c) => `${c.method.split('.')[1]} ${c.body?.name}@${c.body?.timestamp}`)
  check('marks: eyes, then three, then a check, each swapped in, none repeated', JSON.stringify(calls) === JSON.stringify(['add eyes@5.1', 'add three@5.1', 'remove eyes@5.1', 'add white_check_mark@5.1', 'remove three@5.1']), JSON.stringify(calls))
  for (const [state, name] of [[{ kind: 'failed' }, 'x'], [{ kind: 'stopped' }, 'black_square_for_stop']] as const) {
    const a2 = stubSlack()
    const t2 = transportFor(a2)
    await t2.authenticate()
    t2.mark(at, '5.2', state)
    await new Promise((r) => setTimeout(r, 30))
    a2.restore()
    check(`marks: ${state.kind} is ${name}`, a2.calls.some((c) => c.method === 'reactions.add' && c.body?.name === name))
  }
  // An app without reactions:write is told once; after that nothing is asked.
  const a3 = stubSlack({ errors: { 'reactions.add': 'missing_scope' } })
  const t3 = transportFor(a3)
  await t3.authenticate()
  t3.mark(at, '5.3', { kind: 'seen' })
  await new Promise((r) => setTimeout(r, 30))
  t3.mark(at, '5.4', { kind: 'seen' })
  t3.mark(at, '5.4', { kind: 'done' })
  await new Promise((r) => setTimeout(r, 30))
  a3.restore()
  check('marks: refused for lack of a scope, it stops asking', a3.calls.filter((c) => c.method.startsWith('reactions.')).length === 1 && t3.logs.some((l) => /reactions:write/.test(l)), JSON.stringify(t3.logs.filter((l) => /reaction/.test(l))))
  // Already there (a retry, a second process): not a failure, and the swap goes on.
  const a4 = stubSlack({ errors: { 'reactions.add': 'already_reacted' } })
  const t4 = transportFor(a4)
  await t4.authenticate()
  t4.mark(at, '5.5', { kind: 'seen' })
  await new Promise((r) => setTimeout(r, 15))
  t4.mark(at, '5.5', { kind: 'done' })
  await new Promise((r) => setTimeout(r, 30))
  a4.restore()
  check('marks: a reaction already there counts as added', a4.calls.some((c) => c.method === 'reactions.remove' && c.body?.name === 'eyes'), JSON.stringify(a4.calls.map((c) => c.method)))
}

// Marks that come faster than Slack is asked are merged: only the newest is sent.
{
  const api = stubSlack()
  const t = transportFor(api)
  await t.authenticate()
  const at = { channel: 'C1', threadTs: '5.0' }
  t.mark(at, '5.9', { kind: 'seen' })
  t.mark(at, '5.9', { kind: 'working', tenths: 2 })
  t.mark(at, '5.9', { kind: 'working', tenths: 4 })
  await new Promise((r) => setTimeout(r, 40))
  api.restore()
  const asked = api.calls.filter((c) => c.method.startsWith('reactions.')).map((c) => `${c.method.split('.')[1]} ${c.body?.name}`)
  check('marks: a burst sends the first and the newest, not each between', !asked.includes('add two') && asked.includes('add four'), JSON.stringify(asked))
}

// Found in review: what is on the message is what Slack holds, not what was asked. A remove that failed is tried
// again; an end mark that failed is tried again; a refusal is said once; a message gone is let go; and the first
// mark a process makes on a message that is not "taken" (after a restart) first reads what the bot left there.
{
  const scripted = (answer) => {
    const calls = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (url, init = {}) => {
      const method = String(url).split('/api/')[1]?.split('?')[0] ?? ''
      const raw = init.body === undefined ? '' : String(init.body)
      const body = raw.startsWith('{') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(String(url).split('?')[1] ?? ''))
      calls.push({ method, body })
      const json = method === 'auth.test' ? { ok: true, user: 'bot', user_id: 'U1', team: 'T1', url: 'https://example.slack.com/' } : answer(method, body, calls.filter((c) => c.method === method).length)   // may throw: a rejected fetch
      return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) }
    }) as typeof fetch
    return { calls, restore: () => { globalThis.fetch = realFetch } }
  }
  const markedTransport = () => {
    const logs = []
    const t = createSlackTransport({
      cfg: { platform: 'slack', stateDir: '.', targetChannels: ['*'], chunkChars: 4000, markRetryMs: 5 },
      log: (...parts) => logs.push(parts.join(' ')), sessionCwd: async () => process.cwd(), credential: async () => 'xoxb-fake', onHealth: () => {},
    })
    t.logs = logs
    return t
  }
  const at = { channel: 'C1', threadTs: '5.0' }
  const reactions = (api) => api.calls.filter((c) => c.method.startsWith('reactions.')).map((c) => `${c.method.split('.')[1]} ${c.body?.name ?? ''}`.trim())
  // A remove refused once (rate limited): the next mark takes the stale one off too.
  const a = scripted((m, b, n) => m === 'reactions.remove' && n === 1 ? { ok: false, error: 'ratelimited' } : { ok: true })
  const ta = markedTransport()
  await ta.authenticate(); await ta.identity()
  ta.mark(at, '6.1', { kind: 'seen' })
  await new Promise((r) => setTimeout(r, 15))
  ta.mark(at, '6.1', { kind: 'working', tenths: 2 })
  await new Promise((r) => setTimeout(r, 30))
  ta.mark(at, '6.1', { kind: 'done' })
  await new Promise((r) => setTimeout(r, 60))
  a.restore()
  const ra = reactions(a)
  check('marks: a remove refused is tried again, and the end leaves only its own mark', ra.filter((x) => x === 'remove eyes').length === 2 && ra.includes('remove two') && ra.at(-1)?.startsWith('remove') && ta.logs.some((l) => /reactions.remove failed/.test(l)), JSON.stringify(ra))
  // The end mark's add refused once: tried again.
  const b = scripted((m, body, n) => m === 'reactions.add' && body.name === 'white_check_mark' && n === 2 ? { ok: false, error: 'internal_error' } : { ok: true })
  const tb = markedTransport()
  await tb.authenticate(); await tb.identity()
  tb.mark(at, '6.2', { kind: 'seen' })
  await new Promise((r) => setTimeout(r, 15))
  tb.mark(at, '6.2', { kind: 'done' })
  await new Promise((r) => setTimeout(r, 80))
  b.restore()
  check('marks: an end mark that failed is tried again', reactions(b).filter((x) => x === 'add white_check_mark').length === 2 && reactions(b).includes('remove eyes'), JSON.stringify(reactions(b)))
  // Two refusals in flight at once: said once.
  const c = scripted((m) => m === 'reactions.add' ? { ok: false, error: 'missing_scope' } : { ok: true })
  const tc = markedTransport()
  await tc.authenticate(); await tc.identity()
  tc.mark(at, '6.3', { kind: 'seen' })
  tc.mark(at, '6.4', { kind: 'seen' })
  await new Promise((r) => setTimeout(r, 40))
  c.restore()
  check('marks: two refusals at once are said once', tc.logs.filter((l) => /reactions:write/.test(l)).length === 1, JSON.stringify(tc.logs.filter((l) => /reaction/.test(l))))
  // The person deleted the message: let go, not asked again for each digit.
  const d = scripted((m) => m === 'reactions.add' ? { ok: false, error: 'message_not_found' } : { ok: true })
  const td = markedTransport()
  await td.authenticate(); await td.identity()
  td.mark(at, '6.5', { kind: 'seen' })
  await new Promise((r) => setTimeout(r, 20))
  td.mark(at, '6.5', { kind: 'working', tenths: 3 })
  td.mark(at, '6.5', { kind: 'done' })
  await new Promise((r) => setTimeout(r, 40))
  d.restore()
  check('marks: a message that is gone is let go, and forgotten when its turn ends', reactions(d).length === 1 && td.markedMessages === 0, `${JSON.stringify(reactions(d))} held ${td.markedMessages}`)
  // After a restart: the first mark is an end, so what the bot left is read first and taken off; a person's own stays.
  const e = scripted((m) => m === 'reactions.get' ? { ok: true, message: { reactions: [{ name: 'four', users: ['U1'] }, { name: 'eyes', users: ['U9'] }, { name: 'tada', users: ['U1', 'U9'] }] } } : { ok: true })
  const te = markedTransport()
  await te.authenticate(); await te.identity()
  te.mark(at, '6.6', { kind: 'failed' })
  await new Promise((r) => setTimeout(r, 40))
  e.restore()
  check('marks: after a restart, its own digit is taken off, a person\'s reaction is not', JSON.stringify(reactions(e)) === JSON.stringify(['get', 'add x', 'remove four']), JSON.stringify(reactions(e)))
  // Not allowed to read them (no reactions:read): every mark of ours is taken off, whichever is there.
  const g = scripted((m) => m === 'reactions.get' ? { ok: false, error: 'missing_scope' } : m === 'reactions.remove' ? { ok: false, error: 'no_reaction' } : { ok: true })
  const tg = markedTransport()
  await tg.authenticate(); await tg.identity()
  tg.mark(at, '6.7', { kind: 'failed' })
  await new Promise((r) => setTimeout(r, 60))
  g.restore()
  const removed = reactions(g).filter((x) => x.startsWith('remove')).map((x) => x.slice(7))
  check('marks: after a restart without reactions:read, the cross goes on and eyes and every digit come off', reactions(g)[1] === 'add x' && removed.length === 10 && ['eyes', 'one', 'four', 'nine'].every((n) => removed.includes(n)) && !removed.includes('x') && tg.logs.some((l) => /reactions.get failed/.test(l)), JSON.stringify(reactions(g)))
  // A call that throws (the network) is a failure like a refusal: the end mark is tried again.
  let thrown = 0
  const h = scripted((m, body) => {
    if (m === 'reactions.add' && body.name === 'white_check_mark' && thrown === 0) { thrown++; throw new Error('ECONNRESET') }
    return { ok: true }
  })
  const th = markedTransport()
  await th.authenticate(); await th.identity()
  th.mark(at, '6.8', { kind: 'seen' })
  await new Promise((r) => setTimeout(r, 15))
  th.mark(at, '6.8', { kind: 'done' })
  await new Promise((r) => setTimeout(r, 80))
  h.restore()
  check('marks: an end mark whose call threw is tried again', reactions(h).filter((x) => x === 'add white_check_mark').length === 2 && reactions(h).includes('remove eyes'), JSON.stringify(reactions(h)))
  // Too many reactions on the message: ours come off, freeing a slot, before it is let go.
  const k = scripted((m, body) => m === 'reactions.add' && body.name === 'two' ? { ok: false, error: 'too_many_reactions' } : { ok: true })
  const tk = markedTransport()
  await tk.authenticate(); await tk.identity()
  tk.mark(at, '6.9', { kind: 'seen' })
  await new Promise((r) => setTimeout(r, 15))
  tk.mark(at, '6.9', { kind: 'working', tenths: 2 })
  await new Promise((r) => setTimeout(r, 30))
  k.restore()
  check('marks: too many reactions, ours come off before it is let go', JSON.stringify(reactions(k)) === JSON.stringify(['add eyes', 'add two', 'remove eyes']), JSON.stringify(reactions(k)))
}

// Streaming a turn's text into its thread, as Slack's chat.startStream / appendStream / stopStream have it. Learned
// live: a channel needs the recipient (the person who asked, and the team); a message is neither edited nor deleted
// while it streams, so it is stopped first. The answer is posted new (an edit raises no notification), and the
// streamed message goes. The core's posts carry no `user`: only the turn's origin, which streams, does.
{
  const streamer = (api, extra = {}) => {
    const logs = []
    const t = createSlackTransport({
      cfg: { platform: 'slack', stateDir: '.', targetChannels: ['*'], chunkChars: 4000, streamFlushMs: 5, streamIdleMs: 60_000, streamRetryMs: 5, ...extra },
      log: (...parts) => logs.push(parts.join(' ')), sessionCwd: async () => process.cwd(), credential: async () => 'xoxb-fake', onHealth: () => {},
    })
    t.logs = logs
    return t
  }
  // A stub whose answers can change with the call: for a refusal that comes once, or a call that throws.
  const scripted = (answer) => {
    const calls = []
    const realFetch = globalThis.fetch
    let n = 0
    globalThis.fetch = (async (url, init = {}) => {
      const method = String(url).split('/api/')[1]?.split('?')[0] ?? ''
      const raw = init.body === undefined ? '' : String(init.body)
      const body = raw.startsWith('{') ? JSON.parse(raw) : {}
      calls.push({ method, body })
      const json = method === 'auth.test' ? { ok: true, user: 'bot', user_id: 'U1', team: 'T1', team_id: 'T1ID' } : (answer(method, body, calls.filter((c) => c.method === method).length) ?? { ok: true, ts: `ts-${++n}` })
      return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) }
    }) as typeof fetch
    return { calls, restore: () => { globalThis.fetch = realFetch } }
  }
  const pause = (ms = 30) => new Promise((r) => setTimeout(r, ms))
  const chat = (api) => api.calls.filter((c) => /^chat\./.test(c.method)).map((c) => c.method.slice(5))
  const at = { channel: 'C1', threadTs: '5.0', user: 'U7' }
  const thread = { channel: 'C1', threadTs: '5.0' }   // what the core posts to: no user
  // The answer is posted new, and the streamed message goes.
  const a = stubSlack()
  const ta = streamer(a)
  await ta.authenticate(); await ta.identity()
  ta.stream(at, { kind: 'text', text: '안녕' }); ta.stream(at, { kind: 'text', text: '하세요' })
  await pause()
  ta.stream(at, { kind: 'tool', name: 'bash', title: 'curl -H "Authorization: x" https://example.com/?q=1' })
  ta.stream(at, { kind: 'text', text: ' 끝' })
  await pause()
  await ta.post(thread, '최종 **답**', { answer: true })
  await pause()
  a.restore()
  const started = a.calls.find((c) => c.method === 'chat.startStream')
  const appended = a.calls.filter((c) => c.method === 'chat.appendStream').map((c) => c.body?.markdown_text).join('')
  const answered = a.calls.find((c) => c.method === 'chat.postMessage')
  check('stream: started in the thread, for the person who asked and their team', started?.body?.channel === 'C1' && started?.body?.thread_ts === '5.0' && started?.body?.recipient_user_id === 'U7' && started?.body?.recipient_team_id === 'T1ID' && started?.body?.markdown_text === '안녕하세요', JSON.stringify(started?.body))
  check('stream: a tool step shows by its name only, never its command', appended.includes('`▸ bash`') && !/curl|Authorization|example/.test(appended) && appended.endsWith(' 끝'), JSON.stringify(appended))
  check('stream: the answer posted new at once (it notifies), then the stream stopped and deleted', JSON.stringify(chat(a)) === JSON.stringify(['startStream', 'appendStream', 'postMessage', 'stopStream', 'delete']) && answered?.body?.text === '최종 *답*' && answered?.body?.thread_ts === '5.0', JSON.stringify(chat(a)))
  // A failed attempt: what it streamed is not the answer, so it goes, and the next attempt streams anew.
  const b = stubSlack()
  const tb = streamer(b)
  await tb.authenticate(); await tb.identity()
  tb.stream(at, { kind: 'text', text: '잘못된 시도' }); await pause()
  tb.stream(at, { kind: 'reset' }); await pause()
  tb.stream(at, { kind: 'text', text: '다시' }); await pause()
  b.restore()
  check('stream: a reset stops and deletes what was streamed; the retry starts a new one', JSON.stringify(chat(b)) === JSON.stringify(['startStream', 'stopStream', 'delete', 'startStream']), JSON.stringify(chat(b)))
  // Something else said in the thread (an approval request, posted as the core posts: no user): what is streamed,
  // pending text included, comes first; the text after it streams in a new message.
  const c = stubSlack()
  const tc = streamer(c, { streamFlushMs: 10_000 })
  await tc.authenticate(); await tc.identity()
  tc.stream(at, { kind: 'text', text: '지울게' })
  await tc.post(thread, '권한이 필요해')
  await pause()
  c.restore()
  check('stream: another message in the thread comes after what was streamed, pending text too; the stream is stopped, kept', chat(c)[0] === 'startStream' && chat(c).includes('postMessage') && chat(c).includes('stopStream') && !chat(c).includes('delete') && c.calls.find((x) => x.method === 'chat.startStream')?.body?.markdown_text === '지울게', JSON.stringify(chat(c)))
  // That post does not wait for a stop Slack keeps refusing: an approval request waits for nobody.
  const c2 = scripted((m) => m === 'chat.stopStream' ? { ok: false, error: 'ratelimited' } : undefined)
  const tc2 = streamer(c2, { streamRetryMs: 10_000 })
  await tc2.authenticate(); await tc2.identity()
  tc2.stream(at, { kind: 'text', text: '하나' }); await pause()
  const raced = await Promise.race([tc2.post(thread, '권한이 필요해').then(() => 'posted'), pause(1000).then(() => 'waited')])
  c2.restore()
  check('stream: another message does not wait for a refused stop to be tried again', raced === 'posted' && chat(c2).includes('postMessage'), `${raced} ${JSON.stringify(chat(c2))}`)
  // The answer's post throws (the network, a page that is not JSON): the stream is still ended, and kept.
  const c3 = scripted((m) => { if (m === 'chat.postMessage') throw new Error('socket hang up') })
  const tc3 = streamer(c3)
  await tc3.authenticate(); await tc3.identity()
  tc3.stream(at, { kind: 'text', text: '거의 다' }); await pause()
  const threw = await tc3.post(thread, '답', { answer: true }).then(() => false, () => true)
  await pause()
  c3.restore()
  check('stream: an answer whose post throws still ends the stream, and keeps its text', JSON.stringify(chat(c3).filter((x) => x !== 'postMessage')) === JSON.stringify(['startStream', 'stopStream']), JSON.stringify({ threw, chat: chat(c3) }))
  // Refused for good: said once, and the answers arrive whole, as before.
  const d = stubSlack({ errors: { 'chat.startStream': 'missing_scope' } })
  const td = streamer(d)
  await td.authenticate(); await td.identity()
  td.stream(at, { kind: 'text', text: '하나' }); await pause()
  td.stream(at, { kind: 'text', text: '둘' }); await pause()
  await td.post(thread, '답', { answer: true })
  d.restore()
  check('stream: refused for good, it stops asking, and the answer is posted whole', JSON.stringify(chat(d)) === JSON.stringify(['startStream', 'postMessage']) && td.streamUnavailable === true && td.logs.filter((l) => /stream/.test(l)).length === 1, JSON.stringify({ chat: chat(d), logs: td.logs }))
  // A stop refused once (rate limited) is tried again; the message can then go.
  const e = scripted((m, body, n) => m === 'chat.stopStream' && n === 1 ? { ok: false, error: 'ratelimited' } : undefined)
  const te = streamer(e)
  await te.authenticate(); await te.identity()
  te.stream(at, { kind: 'text', text: '하나' }); await pause()
  await te.post(thread, '답', { answer: true })
  await pause(60)
  e.restore()
  check('stream: a stop refused once is tried again, then the message goes', JSON.stringify(chat(e)) === JSON.stringify(['startStream', 'postMessage', 'stopStream', 'stopStream', 'delete']), JSON.stringify(chat(e)))
  // Refused every time: it cannot be deleted while it streams, so it is left and said; the answer is still posted.
  const f = scripted((m) => m === 'chat.stopStream' ? { ok: false, error: 'internal_error' } : undefined)
  const tf = streamer(f)
  await tf.authenticate(); await tf.identity()
  tf.stream(at, { kind: 'text', text: '하나' }); await pause()
  await tf.post(thread, '답', { answer: true })
  await pause(250)
  f.restore()
  check('stream: a stop never accepted is tried four times over a while, the message left and said; the answer came first', JSON.stringify(chat(f)) === JSON.stringify(['startStream', 'postMessage', 'stopStream', 'stopStream', 'stopStream', 'stopStream']) && tf.logs.some((l) => /stopStream failed/.test(l)), JSON.stringify({ chat: chat(f), logs: tf.logs }))
  // Already not streaming (the person stopped it): that is a stop, and the message can go.
  const f2 = scripted((m) => m === 'chat.stopStream' ? { ok: false, error: 'message_not_in_streaming_state' } : undefined)
  const tf2 = streamer(f2)
  await tf2.authenticate(); await tf2.identity()
  tf2.stream(at, { kind: 'text', text: '하나' }); await pause()
  await tf2.post(thread, '답', { answer: true })
  await pause()
  f2.restore()
  check('stream: one no longer streaming counts as stopped', JSON.stringify(chat(f2)) === JSON.stringify(['startStream', 'postMessage', 'stopStream', 'delete']), JSON.stringify(chat(f2)))
  // Stopped by the person in Slack (an append said so): not stopped again, just deleted for the answer.
  const f3 = scripted((m) => m === 'chat.appendStream' ? { ok: false, error: 'stopped_by_user' } : undefined)
  const tf3 = streamer(f3)
  await tf3.authenticate(); await tf3.identity()
  tf3.stream(at, { kind: 'text', text: '하나' }); await pause()
  tf3.stream(at, { kind: 'text', text: '둘' }); await pause()
  await tf3.post(thread, '답', { answer: true })
  await pause()
  f3.restore()
  check('stream: stopped by the person, it is not stopped again', JSON.stringify(chat(f3)) === JSON.stringify(['startStream', 'appendStream', 'postMessage', 'delete']), JSON.stringify(chat(f3)))
  // No team from auth.test: nothing can be streamed, so the core is told to show progress another way.
  const realFetch4 = globalThis.fetch
  const tf4 = createSlackTransport({
    cfg: { platform: 'slack', stateDir: '.', targetChannels: ['*'], chunkChars: 4000 },
    log: () => {}, sessionCwd: async () => process.cwd(), credential: async () => 'xoxb-fake', onHealth: () => {},
  })
  globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ ok: true, user: 'bot', user_id: 'U1', team: 'T1' }), text: async () => '' })) as unknown as typeof fetch
  await tf4.authenticate(); await tf4.identity()
  globalThis.fetch = realFetch4
  check('stream: without a team it is unavailable, and says so to the core', tf4.streamUnavailable === true)
  // Reasoning and a tool's result keep the stream open; with nothing at all it is stopped once idle.
  const g = stubSlack()
  const tg = streamer(g, { streamIdleMs: 50 })
  await tg.authenticate(); await tg.identity()
  tg.stream(at, { kind: 'text', text: '생각 중' })
  for (let i = 0; i < 6; i++) { await pause(20); tg.stream(at, { kind: 'thinking', text: '...' }) }
  const whileThinking = chat(g).includes('stopStream')
  await pause(120)
  g.restore()
  check('stream: reasoning keeps it open; idle, it is stopped', !whileThinking && JSON.stringify(chat(g)) === JSON.stringify(['startStream', 'stopStream']), JSON.stringify({ whileThinking, chat: chat(g) }))
  // An append refused for a passing reason: its text is not lost, it goes with the next batch.
  const h = scripted((m, body, n) => m === 'chat.appendStream' && n === 1 ? { ok: false, error: 'ratelimited' } : undefined)
  const th = streamer(h)
  await th.authenticate(); await th.identity()
  th.stream(at, { kind: 'text', text: '하나' }); await pause()
  th.stream(at, { kind: 'text', text: '둘' }); await pause()
  th.stream(at, { kind: 'text', text: '셋' }); await pause()
  h.restore()
  const sentText = h.calls.filter((x) => /Stream$/.test(x.method) && x.method !== 'chat.stopStream').map((x) => x.body?.markdown_text)
  check('stream: an append refused once loses nothing: its text goes again with the next', JSON.stringify(sentText) === JSON.stringify(['하나', '둘', '둘셋']), JSON.stringify(sentText))
  // More than one call takes: sent in parts, never splitting a character outside the BMP.
  const k = stubSlack()
  const tk = streamer(k)
  await tk.authenticate(); await tk.identity()
  tk.stream(at, { kind: 'text', text: 'x'.repeat(11_999) + '😀' + 'y'.repeat(1_000) }); await pause()
  k.restore()
  const parts = k.calls.filter((x) => /Stream$/.test(x.method)).map((x) => String(x.body?.markdown_text ?? ''))
  check('stream: a long stretch is sent in parts a call can take, whole characters each', parts.length === 2 && parts[0].length === 11_999 && parts[1].startsWith('😀'), JSON.stringify(parts.map((x) => x.length)))
  // The person stopped the stream in Slack: nothing more is appended to it.
  const m = stubSlack({ errors: { 'chat.appendStream': 'stopped_by_user' } })
  const tm = streamer(m)
  await tm.authenticate(); await tm.identity()
  tm.stream(at, { kind: 'text', text: '하나' }); await pause()
  tm.stream(at, { kind: 'text', text: '둘' }); await pause()
  tm.stream(at, { kind: 'text', text: '셋' }); await pause()
  m.restore()
  check('stream: stopped by the person, nothing more is appended', chat(m).filter((x) => x === 'appendStream').length === 1, JSON.stringify(chat(m)))
  // The transport closing (a restart) stops every stream still open.
  const n = stubSlack()
  const tn = streamer(n)
  await tn.authenticate(); await tn.identity()
  tn.stream(at, { kind: 'text', text: '하던 중' }); await pause()
  await tn.close()
  n.restore()
  check('stream: closing the transport stops the streams still open', JSON.stringify(chat(n)) === JSON.stringify(['startStream', 'stopStream']), JSON.stringify(chat(n)))
  // The answer did not go out: what was streamed is all the person has, so it stays.
  const r = scripted((m) => m === 'chat.postMessage' ? { ok: false, error: 'msg_too_long' } : undefined)
  const tr = streamer(r)
  await tr.authenticate(); await tr.identity()
  tr.stream(at, { kind: 'text', text: '거의 다' }); await pause()
  await tr.post(thread, '답', { answer: true })
  await pause()
  r.restore()
  check('stream: an answer that did not go out leaves the streamed text', chat(r).includes('stopStream') && !chat(r).includes('delete'), JSON.stringify(chat(r)))
  // A delete refused after the stop: said.
  const u = scripted((m) => m === 'chat.delete' ? { ok: false, error: 'cant_delete_message' } : undefined)
  const tu = streamer(u)
  await tu.authenticate(); await tu.identity()
  tu.stream(at, { kind: 'text', text: '하나' }); await pause()
  await tu.post(thread, '답', { answer: true })
  await pause()
  u.restore()
  check('stream: a delete refused after the stop is said', tu.logs.some((l) => /could not be deleted/.test(l)), JSON.stringify(tu.logs))
  // Two posts at once: the second waits until the first has ended the stream, and comes after it.
  const v = stubSlack()
  const tv = streamer(v)
  await tv.authenticate(); await tv.identity()
  tv.stream(at, { kind: 'text', text: '하나' }); await pause()
  await Promise.all([tv.post(thread, '사용량 보고'), tv.post(thread, '답', { answer: true })])
  await pause()
  v.restore()
  const posts = v.calls.filter((x) => x.method === 'chat.postMessage').map((x) => x.body?.text)
  check('stream: two posts at once keep their order, after the stream', chat(v)[0] === 'startStream' && chat(v).filter((x) => x === 'stopStream').length === 1 && JSON.stringify(posts) === JSON.stringify(['사용량 보고', '답']), JSON.stringify({ chat: chat(v), posts }))
  // Closing: a stream not yet started is not started now, and frames after it are dropped.
  const w = stubSlack()
  const tw = streamer(w, { streamFlushMs: 10_000 })
  await tw.authenticate(); await tw.identity()
  tw.stream(at, { kind: 'text', text: '아직 안 보냄' })
  await tw.close()
  const tw2 = streamer(w)
  await tw2.authenticate(); await tw2.identity()
  await tw2.close()
  tw2.stream(at, { kind: 'text', text: '닫힌 뒤' })
  await pause()
  w.restore()
  check('stream: closing starts no stream, and takes no frame after it', chat(w).length === 0, JSON.stringify(chat(w)))
  // Nowhere to stream: no thread, or nobody to stream to.
  const q = stubSlack()
  const tq = streamer(q)
  await tq.authenticate(); await tq.identity()
  tq.stream({ channel: 'C1', threadTs: null, user: 'U7' }, { kind: 'text', text: 'x' })
  tq.stream({ channel: 'C1', threadTs: '5.0' }, { kind: 'text', text: 'x' })
  tq.stream({ channel: 'C1', threadTs: '5.0', user: '' }, { kind: 'text', text: 'x' })
  await pause()
  q.restore()
  check('stream: none without a thread or a person to stream to', chat(q).length === 0, JSON.stringify(chat(q)))
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
