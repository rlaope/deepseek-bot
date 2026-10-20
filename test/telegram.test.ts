/**
 * The Telegram transport, against a mocked Bot API.
 *
 * This is the second transport, and its job is to prove the seam holds: the core
 * did not change to accommodate it beyond reading `threadTs: null` as "one session
 * per conversation". The platform facts being tested are the ones that would
 * otherwise be discovered in a live chat: what counts as being addressed, that
 * mentions must be stripped, that edits can be refused, and that Telegram has no
 * history endpoint.
 *
 * Run: node test/telegram.test.ts
 */
import './dist-fresh.ts'   // fails loudly on a stale dist

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTelegramTransport, toTelegramHtml } from '../dist/transports/telegram.js'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A Bot API that answers from a queue and records what it was asked. */
function fakeApi(options: { updates?: unknown[]; rejectHtml?: boolean; tooLong?: boolean; editFails?: boolean } = {}) {
  const calls = []
  const updates = [...(options.updates ?? [])]
  const fetchImpl = async (url, init) => {
    const method = String(url).split('/').pop()
    calls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : null })
    const json = (value, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => value, arrayBuffer: async () => new ArrayBuffer(0) })
    if (method === 'getMe') return json({ ok: true, result: { id: 42, username: 'deepbot_test', first_name: 'Deep', is_bot: true } })
    if (method === 'getUpdates') {
      if (updates.length > 0) return json({ ok: true, result: [updates.shift()] })
      // Behave like a long poll instead of spinning: the real call waits.
      await sleep(120)
      return json({ ok: true, result: [] })
    }
    if (method === 'getFile') return json({ ok: true, result: { file_id: 'F1', file_path: 'documents/notes.txt', file_size: 12 } })
    if (method === 'sendMessage') {
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      if (options.rejectHtml && body.parse_mode === 'HTML') return json({ ok: false, error_code: 400, description: "Bad Request: can't parse entities" }, false)
      if (options.tooLong && body.parse_mode === 'HTML') return json({ ok: false, error_code: 400, description: 'Bad Request: message is too long' }, false)
      // As Telegram: 4096 characters, counted after the entities are parsed.
      const counted = body.parse_mode === 'HTML' ? String(body.text).replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|quot);/g, '&').length : String(body.text).length
      if (counted > 4096) return json({ ok: false, error_code: 400, description: 'Bad Request: message is too long' }, false)
      return json({ ok: true, result: { message_id: 100 + calls.length, chat: { id: 7 } } })
    }
    if (method === 'editMessageText') {
      if (options.editFails) return json({ ok: false, error_code: 400, description: 'message is too old to edit' }, false)
      return json({ ok: true, result: { message_id: 99, chat: { id: 7 } } })
    }
    if (String(url).includes('/file/bot')) {
      const bytes = Buffer.from('notes: hello')
      return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }
    }
    return json({ ok: true, result: {} })
  }
  return { calls, fetchImpl }
}

function transportFor(api, cwd, extra = {}) {
  const logs = []
  const transport = createTelegramTransport({
    cfg: {
      telegramTokenRef: 'TELEGRAM_BOT_TOKEN', downloadAttachments: true,
      maxAttachmentBytes: 1024 * 1024, attachmentTextChars: 500,
      ...extra,
    },
    log: (...parts) => logs.push(parts.join(' ')),
    sessionCwd: async () => cwd,
    credential: async () => 'telegram-token',
    onHealth: () => {},
    fetchImpl: api.fetchImpl,
  })
  transport.logs = logs
  return transport
}

function privateMessage(overrides = {}) {
  return { update_id: 1, message: { message_id: 10, from: { id: 5, username: 'alice' }, chat: { id: 7, type: 'private' }, text: 'hello', ...overrides } }
}
function groupMessage(overrides = {}) {
  return { update_id: 2, message: { message_id: 11, from: { id: 5, username: 'alice' }, chat: { id: 8, type: 'supergroup' }, text: 'hello all', ...overrides } }
}

// 1. Identity
{
  const api = fakeApi()
  const t = transportFor(api, mkdtempSync(join(tmpdir(), 'tg-')))
  const me = await t.identity()
  check('identity reports the bot username', me.name === 'deepbot_test' && me.id === '42', JSON.stringify(me))
}

// 2. A private chat is always addressed, and has no threads.
{
  const api = fakeApi({ updates: [privateMessage()] })
  const t = transportFor(api, mkdtempSync(join(tmpdir(), 'tg-')))
  const received = []
  await t.connect({ onMessage: (m) => received.push(m) })
  await sleep(250)
  await t.close()
  check('a private message is delivered', received.length === 1, `${received.length} message(s)`)
  check('a private message counts as addressed', received[0]?.addressed === true)
  check('a threadless platform reports no thread', received[0]?.target?.threadTs === null)
  check('the chat id is the conversation', received[0]?.target?.channel === '7')
}

// 3. In a group, chatter without a mention is not for the bot.
{
  const api = fakeApi({ updates: [groupMessage()] })
  const t = transportFor(api, mkdtempSync(join(tmpdir(), 'tg-')))
  const received = []
  await t.connect({ onMessage: (m) => received.push(m) })
  await sleep(250)
  await t.close()
  check('group chatter is not addressed', received.length === 1 && received[0].addressed === false)
}

// 4. A mention is addressed, and is stripped from the text.
{
  const text = '@deepbot_test summarize this'
  const api = fakeApi({ updates: [groupMessage({ text, entities: [{ type: 'mention', offset: 0, length: 13 }] })] })
  const t = transportFor(api, mkdtempSync(join(tmpdir(), 'tg-')))
  const received = []
  await t.connect({ onMessage: (m) => received.push(m) })
  await sleep(250)
  await t.close()
  check('a mention is addressed', received[0]?.addressed === true)
  check('the mention is stripped from the prompt', received[0]?.text === 'summarize this', JSON.stringify(received[0]?.text))
}

// 5. Replying to the bot is addressed, and an unresolvable mention is not.
{
  const reply = groupMessage({ text: 'and this?', reply_to_message: { message_id: 9, from: { id: 42, is_bot: true }, chat: { id: 8, type: 'supergroup' } } })
  const api = fakeApi({ updates: [reply] })
  const t = transportFor(api, mkdtempSync(join(tmpdir(), 'tg-')))
  const received = []
  await t.connect({ onMessage: (m) => received.push(m) })
  await sleep(250)
  await t.close()
  check('a reply to the bot is addressed', received[0]?.addressed === true)

  const other = groupMessage({ text: '@someoneelse look', entities: [{ type: 'mention', offset: 0, length: 13 }] })
  const api2 = fakeApi({ updates: [other] })
  const t2 = transportFor(api2, mkdtempSync(join(tmpdir(), 'tg-')))
  const got2 = []
  await t2.connect({ onMessage: (m) => got2.push(m) })
  await sleep(250)
  await t2.close()
  check('a mention of someone else is not addressed', got2[0]?.addressed === false)
}

// 6. Posting, and replacing a progress placeholder.
{
  const api = fakeApi()
  const t = transportFor(api, mkdtempSync(join(tmpdir(), 'tg-')))
  await t.identity()
  const sent = await t.post({ channel: '7', threadTs: null }, 'the answer')
  check('post sends a message and returns its id', sent?.ts !== undefined && sent?.channel === '7', JSON.stringify(sent))
  await t.post({ channel: '7', threadTs: null }, 'replaced', { replace: '55' })
  check('a replace edits instead of sending', api.calls.some((c) => c.method === 'editMessageText' && c.body?.message_id === 55))
  check('the edit carries the new text', api.calls.find((c) => c.method === 'editMessageText')?.body?.text === 'replaced')
  // A long answer is cut into parts after its tables become lists: cut first, a table across the cut kept its pipes.
  const long = `${'가'.repeat(4056)}\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |\n| 7 | 8 |`
  await t.post({ channel: '7', threadTs: null }, long)
  const parts = api.calls.filter((c) => c.method === 'sendMessage').slice(-2).map((c) => String(c.body?.text ?? ''))
  check('a long answer\'s table is a list in every part', parts.length === 2 && parts.every((p) => !p.includes('|')) && parts.join('').includes('<b>7</b> — 8'), JSON.stringify(parts.map((p) => p.slice(-60))))
  // Every part fits a message with its number, and no character is cut in half: a part one over the limit is refused.
  const before = api.calls.length
  const huge = 'x'.repeat(4089) + '😀' + 'y'.repeat(4200)   // the emoji across where the first part ends
  await t.post({ channel: '7', threadTs: null }, huge)
  const hugeParts = api.calls.slice(before).filter((c) => c.method === 'sendMessage').map((c) => String(c.body?.text ?? ''))
  const bare = hugeParts.map((p) => p.replace(/^\(\d+\/\d+\)\n/, ''))
  check('every part of a long answer fits, its number included', hugeParts.length === 3 && hugeParts.every((p) => p.length <= 4096) && hugeParts.every((p, i) => p.startsWith(`(${i + 1}/3)\n`)), JSON.stringify(hugeParts.map((p) => p.length)))
  check('the parts are the whole answer, no character cut in half', bare.join('') === huge && bare[0].length === 4089 && bare.every((p) => !/[\ud800-\udbff]$/.test(p)), JSON.stringify(bare.map((p) => p.length)))
  // At the limit, one message, unnumbered; one over, two.
  const atLimit = api.calls.length
  await t.post({ channel: '7', threadTs: null }, 'w'.repeat(4096))
  await t.post({ channel: '7', threadTs: null }, 'v'.repeat(4097))
  const edge = api.calls.slice(atLimit).filter((c) => c.method === 'sendMessage').map((c) => String(c.body?.text ?? ''))
  check('an answer at the limit is one message; one over is two', JSON.stringify(edge.map((p) => p.length)) === JSON.stringify([4096, 4096, 13]) && !edge[0].startsWith('('), JSON.stringify(edge.map((p) => p.length)))
  // Every part of a long answer is rendered: Telegram counts the text after the entities, not the tags.
  const atMarked = api.calls.length
  // Escapes outnumber the markup on each line, so a count that kept "&amp;" would put every part over.
  await t.post({ channel: '7', threadTs: null }, '**굵게** `code` & & & & 끝\n'.repeat(700))
  const marked = api.calls.slice(atMarked).filter((c) => c.method === 'sendMessage')
  check('every part of a long answer is sent rendered, not as its Markdown', marked.length >= 3 && marked.every((c) => c.body?.parse_mode === 'HTML'), JSON.stringify(marked.map((c) => [c.body?.parse_mode ?? 'plain', String(c.body?.text ?? '').length])))
  // An empty answer is still a message: Telegram refuses an empty text.
  const atEmpty = api.calls.length
  await t.post({ channel: '7', threadTs: null }, '')
  const emptyText = api.calls.slice(atEmpty).find((c) => c.method === 'sendMessage')?.body?.text
  check('an empty answer is sent as a word, not as nothing', emptyText === '(empty response)', JSON.stringify(emptyText))
  // Nine parts by the limit, ten once each leaves room for its number: "(10/10)" is wider than "(9/9)", and still fits.
  const at10 = api.calls.length
  await t.post({ channel: '7', threadTs: null }, 'z'.repeat(9 * 4090 + 1))
  const tenParts = api.calls.slice(at10).filter((c) => c.method === 'sendMessage').map((c) => String(c.body?.text ?? ''))
  check('a wider number when the parts reach ten still fits', tenParts.length === 10 && tenParts.every((p) => p.length <= 4096) && tenParts[9].startsWith('(10/10)\n'), JSON.stringify(tenParts.map((p) => p.length)))
}

// 7. If the edit is refused, the answer is still delivered.
{
  const api = fakeApi({ editFails: true })
  const t = transportFor(api, mkdtempSync(join(tmpdir(), 'tg-')))
  await t.identity()
  await t.post({ channel: '7', threadTs: null }, 'the answer', { replace: '55' })
  check('a refused edit falls back to a new message', api.calls.filter((c) => c.method === 'sendMessage').length === 1)
}

// 8. Attachments: two-step lookup, then the bytes.
{
  const cwd = mkdtempSync(join(tmpdir(), 'tg-home-'))
  const api = fakeApi()
  const t = transportFor(api, cwd)
  await t.identity()
  const manifest = await t.fetchAttachments({
    eventId: 'e', target: { channel: '7', threadTs: null }, ts: '10', text: '', user: '5', addressed: true,
    files: [{ id: 'F1', name: 'notes.txt', mimetype: 'text/plain', size: 12 }], raw: {},
  }, '10')
  check('the file was fetched through getFile', api.calls.some((c) => c.method === 'getFile'))
  check('the attachment is written', existsSync(join(cwd, 'attachments', '10-notes.txt')), readFileSync(join(cwd, 'attachments', '10-notes.txt'), 'utf8'))
  check('text content is inlined in the manifest', /notes: hello/.test(manifest.text))
  rmSync(cwd, { recursive: true, force: true })
}

// 9. History comes from what the transport has seen, as a delta.
{
  const api = fakeApi({ updates: [privateMessage({ text: 'first thing' }), privateMessage({ message_id: 11, text: 'second thing', update_id: 3 })] })
  const t = transportFor(api, mkdtempSync(join(tmpdir(), 'tg-')))
  const received = []
  await t.connect({ onMessage: (m) => received.push(m) })
  await sleep(300)
  const all = await t.fetchHistory({ channel: '7', threadTs: null }, { currentTs: '11', sinceTs: null, limit: 20, maxChars: 1000 })
  const delta = await t.fetchHistory({ channel: '7', threadTs: null }, { currentTs: '11', sinceTs: '10', limit: 20, maxChars: 1000 })
  await t.close()
  check('the conversation so far is available', /first thing/.test(all.text), JSON.stringify(all.text.slice(0, 60)))
  check('the question itself is excluded', !/second thing/.test(all.text))
  check('a delta returns only what is new', delta.text === '' && delta.lastTs === null, JSON.stringify(delta))
}

// 10. Closing stops the poll loop.
{
  const api = fakeApi()
  const t = transportFor(api, mkdtempSync(join(tmpdir(), 'tg-')))
  await t.connect({ onMessage: () => {} })
  const was = await t.close()
  await sleep(200)
  const after = api.calls.filter((c) => c.method === 'getUpdates').length
  await sleep(200)
  check('closing reports that polling was running', was === true)
  check('hasSocket reports no polling afterwards', t.hasSocket() === false)
  check('the loop stops asking for updates', api.calls.filter((c) => c.method === 'getUpdates').length === after, `${after} → ${api.calls.filter((c) => c.method === 'getUpdates').length}`)
}

// 11. A poll failure is reported and retried, not fatal.
{
  let attempts = 0
  const api = fakeApi()
  const flaky = async (url, init) => {
    if (String(url).includes('getUpdates') && attempts++ === 0) throw new Error('network down')
    return api.fetchImpl(url, init)
  }
  const t = transportFor({ calls: api.calls, fetchImpl: flaky }, mkdtempSync(join(tmpdir(), 'tg-')))
  await t.connect({ onMessage: () => {} })
  await sleep(200)
  await t.close()
  check('a poll failure is logged as retried', t.logs.some((l) => /telegram poll failed.*retrying in \d+ms/.test(l)), t.logs.find((l) => /poll failed/.test(l)) ?? 'no line')
  check('the loop keeps running after a failure', attempts >= 1 && t.hasSocket() === false)
}

// 11b. The error a failed poll reported is cleared by the next poll that works: left in the health file,
// it read as a platform still failing, and failed `dsh gateway setup` on a blip that had passed.
{
  let attempts = 0
  const api = fakeApi()
  const flaky = async (url, init) => {
    if (String(url).includes('getUpdates') && attempts++ === 0) throw new Error('network down')
    return api.fetchImpl(url, init)
  }
  const health = []
  const t = createTelegramTransport({
    cfg: { telegramTokenRef: 'TELEGRAM_BOT_TOKEN' },
    log: () => {},
    sessionCwd: async () => mkdtempSync(join(tmpdir(), 'tg-')),
    credential: async () => 'telegram-token',
    onHealth: (patch) => health.push(patch),
    fetchImpl: flaky,
  })
  await t.connect({ onMessage: () => {} })
  const failedAt = () => health.findIndex((p) => p.lastError === 'network down')
  const clearedAt = () => health.findIndex((p, i) => i > failedAt() && 'lastError' in p && p.lastError === null)
  // The first retry waits 2 s; wait for the clear rather than a fixed time, with a deadline.
  for (const deadline = Date.now() + 8000; Date.now() < deadline && !(failedAt() !== -1 && clearedAt() > failedAt());) await sleep(50)
  await t.close()
  check('a poll that works after a failure clears the error it reported', failedAt() !== -1 && clearedAt() > failedAt(), JSON.stringify(health))
  check('and names it, so another platform\'s error is left alone', health[clearedAt()]?.ifLastError === 'network down', JSON.stringify(health[clearedAt()]))
}

// 12. Typing is a chat action. It lapses after five seconds, so it is repeated until stopped.
{
  const api = fakeApi()
  const t = transportFor(api, mkdtempSync(join(tmpdir(), 'tg-')), { typingIntervalMs: 40 })
  await t.identity()
  const actions = () => api.calls.filter((c) => c.method === 'sendChatAction')
  const stop = t.startTyping({ channel: '7', threadTs: '10' })
  await sleep(110)
  stop()
  const sent = actions().length
  await sleep(120)
  check('typing is sent as a chat action', actions()[0]?.body?.chat_id === '7' && actions()[0]?.body?.action === 'typing',
    JSON.stringify(actions()[0]?.body))
  check('and repeated while the turn runs', sent >= 2, `${sent} call(s)`)
  check('it stops when the turn is over', actions().length === sent, `${sent} → ${actions().length}`)
}

// 13. Uploads: a document the turn made reaches the chat with sendDocument, as a reply where the
// conversation is one.
{
  const api = fakeApi()
  const requests = []
  const fetchImpl = async (url, init: RequestInit = {}) => {
    if (init?.body instanceof FormData) {
      const file = init.body.get('document') as File | null
      requests.push({ method: String(url).split('/').pop(), chat: init.body.get('chat_id'), reply: init.body.get('reply_to_message_id'), name: file?.name, bytes: file ? Buffer.from(await file.arrayBuffer()).toString('utf8') : null })
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 500 } }) }
    }
    return api.fetchImpl(url, init)
  }
  const t = transportFor({ ...api, fetchImpl }, mkdtempSync(join(tmpdir(), 'tg-')))
  await t.identity()
  const ok = await t.uploadFile({ channel: '7', threadTs: '10' }, '/somewhere/report.pdf', undefined, Buffer.from('pdf bytes'))
  check('a document is sent with sendDocument', ok === true && requests[0]?.method === 'sendDocument' && requests[0]?.chat === '7', JSON.stringify(requests[0]))
  check('as a reply in the conversation', requests[0]?.reply === '10')
  check('with its own name and the bytes given', requests[0]?.name === 'report.pdf' && requests[0]?.bytes === 'pdf bytes')
}

// 14. Markdown is rendered: Telegram showed the model's **bold**, `code` and [links](…) as raw marks.
// HTML parse mode, with the text escaped first so nothing in it becomes a tag; a message Telegram will
// not parse is sent again as plain text rather than lost.
{
  const api = fakeApi()
  const t = transportFor(api, mkdtempSync(join(tmpdir(), 'tg-')))
  await t.identity()
  await t.post({ channel: '7', threadTs: null }, '**굵게** `코드` [링크](https://example.com/a?b=1&c=2) <tag> & \n```\nx < y\n```')
  const sent = api.calls.find((c) => c.method === 'sendMessage')?.body
  check('it is sent in HTML parse mode', sent?.parse_mode === 'HTML', JSON.stringify(sent))
  check('bold, code and links become tags', /<b>굵게<\/b>/.test(sent?.text) && /<code>코드<\/code>/.test(sent?.text)
    && sent?.text.includes('<a href="https://example.com/a?b=1&amp;c=2">링크</a>'), sent?.text)
  check('and the text\'s own angle brackets are escaped', sent?.text.includes('&lt;tag&gt; &amp;'), sent?.text)
  check('a fenced block becomes pre, escaped inside', /<pre>x &lt; y<\/pre>/.test(sent?.text), sent?.text)

  const api2 = fakeApi({ rejectHtml: true })
  const t2 = transportFor(api2, mkdtempSync(join(tmpdir(), 'tg-')))
  await t2.identity()
  const posted = await t2.post({ channel: '7', threadTs: null }, '**굵게**')
  const attempts = api2.calls.filter((c) => c.method === 'sendMessage')
  check('a message Telegram will not parse is sent again as plain text', posted !== null && attempts.length === 2 && attempts[1].body.parse_mode === undefined
    && attempts[1].body.text === '**굵게**', JSON.stringify(attempts.map((a) => a.body)))
  // Rendered and refused as too long (the count is Telegram's): the text as written fits, and is sent.
  const api3 = fakeApi({ tooLong: true })
  const t3 = transportFor(api3, mkdtempSync(join(tmpdir(), 'tg-')))
  await t3.identity()
  const fitted = await t3.post({ channel: '7', threadTs: null }, '**굵게**').catch(() => null)
  const tries = api3.calls.filter((c) => c.method === 'sendMessage')
  check('a rendering refused as too long is sent again as plain text', fitted !== null && tries.length === 2 && tries[1].body.parse_mode === undefined, JSON.stringify(tries.map((a) => a.body)))
}

// 15. Approval buttons: an inline keyboard, and the press as a callback query. They existed only on
// Discord; a Telegram user had to type 허용.
{
  const api = fakeApi()
  const t = transportFor(api, mkdtempSync(join(tmpdir(), 'tg-')))
  await t.identity()
  check('the transport says it can render buttons', t.supportsButtons === true)
  await t.post({ channel: '7', threadTs: null }, '⚠️ 권한이 필요해', {
    buttons: [{ id: 'approval:allow:7', label: '허용', style: 'primary' }, { id: 'approval:deny:7', label: '거부', style: 'danger' }],
  })
  const keyboard = api.calls.find((c) => c.method === 'sendMessage')?.body?.reply_markup?.inline_keyboard
  check('the message carries an inline keyboard', keyboard?.[0]?.length === 2 && keyboard[0][0].callback_data === 'approval:allow:7' && keyboard[0][1].text === '거부',
    JSON.stringify(keyboard))

  const pressed = []
  const api2 = fakeApi({ updates: [{ update_id: 9, callback_query: { id: 'Q1', from: { id: 5 }, data: 'approval:deny:7', message: { message_id: 40, chat: { id: 7, type: 'private' } } } }] })
  const t2 = transportFor(api2, mkdtempSync(join(tmpdir(), 'tg-')))
  await t2.connect({ onMessage: () => {}, onAction: (action) => pressed.push(action) })
  await sleep(200)
  await t2.close()
  check('a press reaches the core', pressed.length === 1 && pressed[0].id === 'approval:deny:7' && pressed[0].target.channel === '7' && pressed[0].user === '5',
    JSON.stringify(pressed))
  check('and is answered, so the button stops spinning', api2.calls.some((c) => c.method === 'answerCallbackQuery' && c.body?.callback_query_id === 'Q1'))
  check('callback queries are asked for', JSON.stringify(api2.calls.find((c) => c.method === 'getUpdates')?.body?.allowed_updates ?? []).includes('callback_query'))
}

// 16. Text the renderer did not write itself. Its placeholders for set-aside code were NUL-delimited
// numbers, so a message already holding one duplicated another part or printed "undefined"; and a list
// marker opened italics: "* item *one*" came out as "<i> item </i>one*".
{
  // Telegram shows no tables either.
  const tableHtml = toTelegramHtml('| 층 | 값 |\n|---|---|\n| 페르소나 | 아리 & co |')
  check('a table arrives as a list, escaped', tableHtml === '- <b>페르소나</b> — 아리 &amp; co', JSON.stringify(tableHtml))
  const dup = toTelegramHtml('`a` and \u00000\u0000')
  check('a placeholder-shaped text cannot copy another part', (dup.match(/<code>a<\/code>/g) ?? []).length === 1, JSON.stringify(dup))
  check('nor print undefined', !toTelegramHtml('x \u00007\u0000 y').includes('undefined'))
  check('a list marker does not open italics', toTelegramHtml('* item *one*') === '* item <i>one</i>', toTelegramHtml('* item *one*'))
  check('italics still need a closing mark', toTelegramHtml('2 * 3 = 6') === '2 * 3 = 6', toTelegramHtml('2 * 3 = 6'))
}

// Progress marks: one reaction on the person's message, replaced as the turn goes, from Telegram's own list.
{
  const reacting = (answer: (emoji: string, n: number) => { ok: boolean; description?: string }) => {
    const base = fakeApi()
    const sets = []
    const idTypes = []
    const fetchImpl = async (url, init) => {
      if (String(url).endsWith('/setMessageReaction')) {
        const body = JSON.parse(String(init.body))
        sets.push(`${body.reaction[0].emoji}@${body.chat_id}/${body.message_id}`)
        idTypes.push(typeof body.message_id)
        const r = answer(body.reaction[0].emoji, sets.length)
        return { ok: r.ok, status: r.ok ? 200 : 400, json: async () => (r.ok ? { ok: true, result: true } : { ok: false, error_code: 400, description: r.description }) }
      }
      return base.fetchImpl(url, init)
    }
    return { calls: base.calls, sets, idTypes, fetchImpl }
  }
  const at = { channel: '7', threadTs: null }
  const pause = () => sleep(30)

  const a = reacting(() => ({ ok: true }))
  const t = transportFor(a, mkdtempSync(join(tmpdir(), 'tg-')), { markRetryMs: 5 })
  await t.identity()
  t.mark(at, '10', { kind: 'seen' }); await pause()
  t.mark(at, '10', { kind: 'working', tenths: 2 }); await pause()
  t.mark(at, '10', { kind: 'working', tenths: 6 }); await pause()
  t.mark(at, '10', { kind: 'done' }); await pause()
  check('marks: eyes, writing once while it runs, then OK, each replacing the last', JSON.stringify(a.sets) === JSON.stringify(['👀@7/10', '✍@7/10', '👌@7/10']), JSON.stringify(a.sets))
  check('marks: the message id is sent as a number', a.idTypes.length === 3 && a.idTypes.every((x) => x === 'number'), JSON.stringify(a.idTypes))

  for (const [kind, emoji] of [['failed', '😢'], ['stopped', '🫡']] as const) {
    const b = reacting(() => ({ ok: true }))
    const tb = transportFor(b, mkdtempSync(join(tmpdir(), 'tg-')), { markRetryMs: 5 })
    await tb.identity()
    tb.mark(at, '11', { kind }); await pause()
    check(`marks: ${kind} is ${emoji}, with nothing to take off first`, JSON.stringify(b.sets) === JSON.stringify([`${emoji}@7/11`]), JSON.stringify(b.sets))
  }

  // A chat that limits its reactions lets that message go, quietly; another message is still marked.
  const c = reacting((emoji) => (emoji === '👀' ? { ok: false, description: 'Bad Request: REACTION_INVALID' } : { ok: true }))
  const tc = transportFor(c, mkdtempSync(join(tmpdir(), 'tg-')), { markRetryMs: 5 })
  await tc.identity()
  tc.mark(at, '12', { kind: 'seen' }); await pause()
  tc.mark(at, '12', { kind: 'working', tenths: 3 }); await pause()
  tc.mark(at, '12', { kind: 'done' }); await pause()
  tc.mark(at, '13', { kind: 'done' }); await pause()
  check('marks: a reaction the chat does not take lets that message go', JSON.stringify(c.sets) === JSON.stringify(['👀@7/12', '👌@7/13']), JSON.stringify(c.sets))

  // A retried call that had landed the first time is not a reason to let the message go.
  const nm = reacting((emoji) => (emoji === '✍' ? { ok: false, description: 'Bad Request: REACTION_NOT_MODIFIED' } : { ok: true }))
  const tnm = transportFor(nm, mkdtempSync(join(tmpdir(), 'tg-')), { markRetryMs: 5 })
  await tnm.identity()
  tnm.mark(at, '17', { kind: 'seen' }); await pause()
  tnm.mark(at, '17', { kind: 'working', tenths: 2 }); await pause()
  tnm.mark(at, '17', { kind: 'done' }); await pause()
  check('marks: a reaction already there (not modified) keeps the message marked', JSON.stringify(nm.sets) === JSON.stringify(['👀@7/17', '✍@7/17', '👌@7/17']), JSON.stringify(nm.sets))

  // A refused token stops every mark until a restart, said once.
  const d = reacting(() => ({ ok: false, description: 'Unauthorized' }))
  const td = transportFor(d, mkdtempSync(join(tmpdir(), 'tg-')), { markRetryMs: 5 })
  await td.identity()
  td.mark(at, '14', { kind: 'seen' }); await pause()
  td.mark(at, '15', { kind: 'seen' }); await pause()
  check('marks: a refused token stops every mark, said once', d.sets.length === 1 && td.logs.filter((l) => /no more marks/.test(l)).length === 1, JSON.stringify([d.sets, td.logs]))

  // The end, rate limited, is tried again after a pause.
  const e = reacting((emoji, n) => (n === 2 ? { ok: false, description: 'Too Many Requests: retry after 1' } : { ok: true }))
  const te = transportFor(e, mkdtempSync(join(tmpdir(), 'tg-')), { markRetryMs: 5 })
  await te.identity()
  te.mark(at, '16', { kind: 'seen' }); await pause()
  te.mark(at, '16', { kind: 'done' }); await sleep(80)
  check('marks: an end that was rate limited is tried again', JSON.stringify(e.sets) === JSON.stringify(['👀@7/16', '👌@7/16', '👌@7/16']), JSON.stringify(e.sets))
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
