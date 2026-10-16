/**
 * The block injected when a message points at the past.
 *
 * The claim is that passages come back ranked and that the block asks for the *implication* rather
 * than handing over material — the user's objection to recall as a dump. Ranking is lexical: the
 * test does not claim synonyms, and one check asserts the block is honest about that.
 *
 * Run: node test/recall-context.test.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { createRecallContext, recallIndexPath } from '../dist/recallContext.js'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const dir = mkdtempSync(join(tmpdir(), 'deepbot-recallctx-'))
const indexPath = join(dir, 'recall-index.jsonl')
const rows = [
  { ts: 1_700_000_000, role: 'user', sessionId: 'a', text: '배포 롤백 화요일' },
  { ts: 1_700_100_000, role: 'assistant', sessionId: 'a', text: '배포 롤백 수요일' },
  { ts: 1_700_200_000, role: 'user', sessionId: 'b', text: '점심은 김치찌개' },
]
writeFileSync(indexPath, [...rows.map((r) => JSON.stringify(r)), '{ not json'].join('\n'))
const ctx = createRecallContext({ indexPath })

// 1. Only when the message points at the past.
check('a message about the past triggers it', ctx.triggered('지난주에 배포 어떻게 하기로 했지?') === true)
check('an ordinary message does not', ctx.triggered('이거 요약해줘') === false)
check('an untriggered block is empty', ctx.block('이거 요약해줘') === '')

// 2. Ranked by shared words, and the irrelevant row is absent.
{
  const block = ctx.block('지난주에 배포 롤백 어떻게 하기로 했지?')
  check('the block is produced', block !== '', block.slice(0, 60))
  check('both relevant passages are shown', (block.match(/^- /gm) ?? []).length === 2, String((block.match(/^- /gm) ?? []).length))
  check('the irrelevant passage is not', !block.includes('김치찌개'))
  check('the newest of the equally-scored passages leads', block.indexOf('수요일') < block.indexOf('화요일'),
    block.split('\n').filter((l) => l.startsWith('- ')).join(' | ').slice(0, 90))
}

// 3. It asks for a step, and it is honest about being lexical.
{
  const block = ctx.block('지난주에 배포 어떻게 하기로 했지?')
  check('the block asks for the next step', /decide the next step/i.test(block) && /Do not summarise/i.test(block), block.split('\n').slice(-1)[0]?.slice(0, 80))
  check('and says it is lexical, not semantic', /not a semantic search/i.test(block))
  check('an unreadable index line does not lose the rest', block.includes('배포'))
}

// 4. A missing index, and a broken file, both cost nothing.
{
  const missing = createRecallContext({ indexPath: join(dir, 'nope.jsonl') })
  check('a missing index yields no block', missing.block('지난주 배포') === '')
  writeFileSync(join(dir, 'broken.jsonl'), '\u0000not json at all')
  const broken = createRecallContext({ indexPath: join(dir, 'broken.jsonl') })
  check('an unparseable index yields no block, not a throw', broken.block('지난주 배포') === '')
}

// 5. Only the conversation's own channel. Ranking used every row of the shared home, so a word in
// common was enough to put a DM into a public channel's answer. A row with no channel is left out
// when the turn has one; a turn with none (a scenario) still sees everything.
{
  const scoped = join(dir, 'scoped.jsonl')
  writeFileSync(scoped, [
    { ts: 1, role: 'user', sessionId: 'p', channel: 'C_PUBLIC', text: '지난번 배포 롤백 public-7a1' },
    { ts: 2, role: 'user', sessionId: 'd', channel: 'D_PRIVATE', text: '지난번 배포 롤백 private-3f9' },
    { ts: 3, role: 'user', sessionId: 'u', text: '지난번 배포 롤백 unknown-5c2' },
  ].map((r) => JSON.stringify(r)).join('\n'))
  const inPublic = createRecallContext({ indexPath: scoped, channel: 'C_PUBLIC' }).block('지난번 배포 롤백 어떻게 했지')
  check('a passage from this channel is shown', inPublic.includes('public-7a1'), inPublic.slice(0, 60))
  check('a passage from a DM is not', !inPublic.includes('private-3f9'))
  check('nor one whose channel is unknown', !inPublic.includes('unknown-5c2'))
  const inDm = createRecallContext({ indexPath: scoped, channel: 'D_PRIVATE' }).block('지난번 배포 롤백 어떻게 했지')
  check('the DM sees its own and not the channel\'s', inDm.includes('private-3f9') && !inDm.includes('public-7a1'))
  // A row the indexer could not place, from a session the adapter still maps to a conversation:
  // the mapping supplies the channel.
  const mapped = createRecallContext({ indexPath: scoped, channel: 'C_PUBLIC', sessionChannel: (id) => (id === 'u' ? 'C_PUBLIC' : null) })
    .block('지난번 배포 롤백 어떻게 했지')
  check('a mapped session supplies a missing channel', mapped.includes('unknown-5c2') && !mapped.includes('private-3f9'))
  // The adapter's mapping outranks the channel a row carries: the row's comes from text the agent can
  // influence (a forged block in a standing file), the mapping from the adapter alone. A DM session
  // whose rows claim the public channel stays out of it.
  const forged = createRecallContext({ indexPath: scoped, channel: 'D_PRIVATE', sessionChannel: (id) => (id === 'p' ? 'D_PRIVATE' : id === 'd' ? 'D_OTHER' : null) })
    .block('지난번 배포 롤백 어떻게 했지')
  check('the mapping outranks the channel a row claims', forged.includes('public-7a1') && !forged.includes('private-3f9'), forged.slice(0, 80))
  const anywhere = createRecallContext({ indexPath: scoped }).block('지난번 배포 롤백 어떻게 했지')
  check('without a channel nothing is filtered', ['public-7a1', 'private-3f9', 'unknown-5c2'].every((m) => anywhere.includes(m)))
}

// 6. Ranking that knows which words matter, and recall without a trigger word when the match is strong.
// It used to need a word like "지난번", so "did anyone say 테스트-1234?" found nothing; and every shared
// word counted the same, so two common words outranked one rare one.
{
  const ranked = join(dir, 'ranked.jsonl')
  const filler = Array.from({ length: 40 }, (_, i) => ({ ts: i + 1, role: 'user', sessionId: `f${i}`, text: `오늘 배포 회의 ${i}번째 메모` }))
  writeFileSync(ranked, [
    ...filler,
    { ts: 100, role: 'user', sessionId: 'rare', text: '테스트-1234 라고 적어둔 거 확인용' },
    { ts: 101, role: 'user', sessionId: 'common', text: '오늘 배포 회의는 짧게' },
    { ts: 102, role: 'user', sessionId: 'rollback', text: '롤백 창은 15분으로 정했어' },
    { ts: 103, role: 'user', sessionId: 'current', text: '테스트-1234 다시 말해볼게' },
  ].map((r) => JSON.stringify(r)).join('\n'))
  const ctx2 = createRecallContext({ indexPath: ranked, sessionId: 'current' })
  const strong = ctx2.block('누군가 테스트-1234 라고 말한 적 있어?')
  check('a strong match is recalled without a trigger word', strong.includes('테스트-1234 라고 적어둔'), strong.slice(0, 80) || '(empty)')
  check('the conversation being answered is not recalled to itself', !strong.includes('다시 말해볼게'))
  check('common words alone do not interrupt an ordinary message', ctx2.block('오늘 배포 회의 어떻게 돼?') === '')
  const weighted = ctx2.block('지난번에 오늘 배포 회의랑 테스트-1234 얘기')
  check('a rare word outranks common ones', weighted.indexOf('테스트-1234 라고') >= 0
    && (weighted.indexOf('오늘 배포 회의는') < 0 || weighted.indexOf('테스트-1234 라고') < weighted.indexOf('오늘 배포 회의는')), weighted.split('\n').slice(3, 5).join(' | '))
  check('a particle on the question does not hide the passage', ctx2.block('지난번 롤백을 어떻게 했지').includes('롤백 창은'))
}

// 7. The index lives outside the agent's home, where its tools and commands cannot read it.
{
  const path = recallIndexPath('/Users/someone/dsh-agent', '/Users/someone/.dsh')
  // join, so the expected prefix uses the platform's separator as the path does.
  check('the index path is under the harness home, not the agent home', path.startsWith(join('/Users/someone/.dsh', 'recall') + sep) && !path.startsWith(join('/Users/someone/dsh-agent')), path)
  check('and two homes get two indexes', recallIndexPath('/a/home-1', '/d') !== recallIndexPath('/a/home-2', '/d'))
  // Even homes whose names read alike once flattened: /a/b-c and /a/b/c both became "a-b-c", and so did
  // "dsh agent" and "dsh-agent" — one index for two homes, each recalling the other's conversations.
  check('homes that flatten alike still get two indexes', recallIndexPath('/a/b-c', '/d') !== recallIndexPath('/a/b/c', '/d')
    && recallIndexPath('/h/dsh agent', '/d') !== recallIndexPath('/h/dsh-agent', '/d'), recallIndexPath('/a/b-c', '/d'))
  check('and the same home always gets the same one', recallIndexPath('/a/b-c', '/d') === recallIndexPath('/a/b-c/', '/d'))
}

// Chinese, written without spaces: matched by overlapping pairs of characters.
{
  const zhPath = join(dir, 'recall-zh.jsonl')
  writeFileSync(zhPath, [
    { ts: 1_700_000_000, role: 'user', sessionId: 'z1', text: '回滚窗口定为十五分钟' },
    { ts: 1_700_100_000, role: 'user', sessionId: 'z2', text: '午饭吃饺子' },
  ].map((r) => JSON.stringify(r)).join('\n'))
  const zh = createRecallContext({ indexPath: zhPath })
  check('zh: "上次" points at the past', zh.triggered('上次回滚窗口是怎么定的？') === true)
  const block = zh.block('上次回滚窗口是怎么定的？')
  check('zh: the passage that shares the subject is found', block.includes('回滚窗口定为十五分钟'), block.slice(0, 60))
  check('zh: and the unrelated one is not', !block.includes('饺子'))
}

// One Chinese word is one word. Its overlapping pairs all matched a passage that has it, so a single rare
// word counted as several and was recalled unprompted, where one rare English or Korean word is not. Pairs
// matched apart (two words of the passage) still count apart; a word said twice is still one; a common pair
// inside a word does not split it; and a long phrase matched as it stands is more than one word.
{
  const zhPath = join(dir, 'recall-zh-one.jsonl')
  const filler = Array.from({ length: 60 }, (_, i) => ({ ts: 1_600_000_000 + i, role: 'user', sessionId: `f${i}`,
    text: i < 6 ? `这个工具可用，第${i}次` : i < 12 ? `开会的时候要注意时间，第${i}次` : `今天的天气很好，第${i}次` }))
  writeFileSync(zhPath, [
    { ts: 1_700_000_000, role: 'user', sessionId: 'z1', text: '回滚窗口定为十五分钟，审批人是张伟' },
    { ts: 1_700_000_100, role: 'user', sessionId: 'z2', text: '高可用性要做到三个九' },
    { ts: 1_700_000_200, role: 'user', sessionId: 'z3', text: '回滚的时候要注意通知值班' },
    ...filler,
  ].map((r) => JSON.stringify(r)).join('\n'))
  const zh = createRecallContext({ indexPath: zhPath })
  const unprompted = (prompt) => zh.triggered(prompt) === false && zh.block(prompt) !== ''
  // (The last: one rare word, then a common phrase the passage also has; its length is not two words.)
  for (const prompt of ['回滚窗口', '回滚？回滚', '回滚窗口，窗口', '高可用性', '回滚的时候要注意什么']) {
    check(`zh: "${prompt}" is one word: not recalled unprompted`, zh.triggered(prompt) === false && zh.block(prompt) === '', zh.block(prompt).slice(0, 60))
  }
  check('zh: two rare words matched apart are recalled unprompted', unprompted('张伟和回滚') && zh.block('张伟和回滚').includes('审批人是张伟'))
  check('zh: a long phrase matched as it stands is, too', unprompted('审批人是张伟') && zh.block('审批人是张伟').includes('审批人是张伟'))
}

rmSync(dir, { recursive: true, force: true })
// Related words the model suggested widen the search: a past said in other words is found. The person's own words
// still decide the order: a row with one of them ranks above a row with only a related word.
{
  const paraDir = mkdtempSync(join(tmpdir(), 'deepbot-recallpara-'))
  const paraPath = join(paraDir, 'recall-index.jsonl')
  writeFileSync(paraPath, [
    { ts: 1, role: 'assistant', sessionId: 'p', text: 'production rollback 절차: 이전 이미지로 되돌림' },
    { ts: 2, role: 'user', sessionId: 'q', text: '점심 메뉴 정하자' },
  ].map((r) => JSON.stringify(r)).join('\n'))
  const para = createRecallContext({ indexPath: paraPath })
  const asked = '지난번 배포 되감기 어떻게 했지?'
  check('related: by its own words alone, a question in other words finds nothing', para.block(asked) === '', para.block(asked).slice(0, 60))
  const widened = para.block(asked, ['rollback', '롤백', 'revert'])
  check('related: with the words the model related to it, the passage is found', /rollback 절차/.test(widened) && !/점심/.test(widened), widened.slice(0, 120))
  check('related: the block says how it matched', /related/i.test(widened), widened.split('\n').slice(0, 3).join(' | '))
  // One word each, equally rare: counted the same, the newer would come first; the person's own word comes first.
  writeFileSync(paraPath, [
    { ts: 2, role: 'user', sessionId: 'r', text: 'rollback 해봤어' },
    { ts: 1, role: 'user', sessionId: 's', text: '되감기 규칙' },
  ].map((r) => JSON.stringify(r)).join('\n'))
  const order = createRecallContext({ indexPath: paraPath }).block(asked, ['rollback'])
  check('related: the person\'s own words rank above a related word', order.indexOf('되감기 규칙') !== -1 && order.indexOf('rollback 해봤어') !== -1 && order.indexOf('되감기 규칙') < order.indexOf('rollback 해봤어'), order)
  // Three related words in one passage still do not outweigh one of the person's own: only the best of them counts.
  writeFileSync(paraPath, [
    { ts: 2, role: 'user', sessionId: 'r', text: 'rollback revert 롤백 다 해봤어' },
    { ts: 1, role: 'user', sessionId: 's', text: '되감기 규칙' },
  ].map((r) => JSON.stringify(r)).join('\n'))
  const many = createRecallContext({ indexPath: paraPath }).block(asked, ['rollback', 'revert', '롤백'])
  check('related: many related words do not outweigh one of the person\'s own', many.indexOf('되감기 규칙') !== -1 && many.indexOf('다 해봤어') !== -1 && many.indexOf('되감기 규칙') < many.indexOf('다 해봤어'), many)
  // The model's phrases are matched whole: their "the" and "back" bring in nothing, and neither does a number.
  writeFileSync(paraPath, [
    { ts: 1, role: 'user', sessionId: 'r', text: 'lunch at the cafe on friday' },
    { ts: 2, role: 'user', sessionId: 's', text: 'the printer on floor 3 is broken, back on monday' },
    { ts: 3, role: 'user', sessionId: 't', text: '2026-10-11 점심 메뉴 12시 정하자' },
  ].map((r) => JSON.stringify(r)).join('\n'))
  const junk = createRecallContext({ indexPath: paraPath }).block('지난번 되돌리기 작업 뭐였지', ['roll back the release', 'undo the deploy', '롤백', 'revert', '11', '2026', 'on'])
  check('related: words of a phrase, and numbers, bring in nothing', junk === '', junk)
  writeFileSync(paraPath, [
    { ts: 1, role: 'user', sessionId: 'r', text: 'lunch at the cafe on friday' },
    { ts: 2, role: 'user', sessionId: 's', text: 'We did the Release  Roll-back, twice.' },
  ].map((r) => JSON.stringify(r)).join('\n'))
  const phrase = createRecallContext({ indexPath: paraPath }).block('지난번 되돌리기 작업 뭐였지', ['release roll back'])
  // A sentence the model wrote instead of a term is not used: it is the question rephrased, not a word for its subject.
  const sentence = createRecallContext({ indexPath: paraPath }).block('지난번 되돌리기 작업 뭐였지', ['we did the release roll back twice'])
  check('related: a phrase is found where it is said, whatever its case, spacing and punctuation', /Release Roll-back/.test(phrase) && !/lunch/.test(phrase), phrase)
  check('related: a sentence is not a term, and finds nothing', sentence === '', sentence)
  // A Chinese term is one term however many characters it has; one character is inside every word that has it.
  writeFileSync(paraPath, [
    { ts: 1, role: 'user', sessionId: 'r', text: '上周做了数据库回滚' },
    { ts: 2, role: 'user', sessionId: 's', text: '점심 메뉴 정하자' },
  ].map((r) => JSON.stringify(r)).join('\n'))
  const zh = createRecallContext({ indexPath: paraPath }).block('지난번 되돌리기 작업 뭐였지', ['数据库回滚', '점'])
  check('related: a long Chinese term is a term; one character brings in nothing', /数据库回滚/.test(zh) && !/점심/.test(zh), zh)
  // A related word many passages share would bring in all of them: only a rare one widens the search.
  writeFileSync(paraPath, Array.from({ length: 60 }, (_, i) => ({ ts: i, role: 'user', sessionId: `c${i}`, text: i % 6 === 0 ? `deploy 일정 ${i}` : `잡담 ${i}` })).map((r) => JSON.stringify(r)).join('\n'))
  const common = createRecallContext({ indexPath: paraPath }).block('지난번 되돌리기 작업 뭐였지', ['deploy'])
  check('related: a related word many passages share brings in none of them', common === '', common.slice(0, 80))
  // Related words that matched nothing: the block does not say it matched by them.
  writeFileSync(paraPath, JSON.stringify({ ts: 1, role: 'user', sessionId: 's', text: '되감기 규칙' }))
  const own = createRecallContext({ indexPath: paraPath }).block(asked, ['rollback'])
  check('related: the block says "related" only when a related word matched', /되감기 규칙/.test(own) && !/related/i.test(own), own.split('\n').slice(0, 3).join(' | '))
  // Nothing to recall: the model need not be asked.
  check('related: rows to recall are seen before asking', createRecallContext({ indexPath: paraPath }).hasRows() === true)
  check('related: none in this channel, none to ask about', createRecallContext({ indexPath: paraPath, channel: 'C_OTHER' }).hasRows() === false)
  check('related: no index, none to ask about', createRecallContext({ indexPath: join(paraDir, 'missing.jsonl') }).hasRows() === false)
  rmSync(paraDir, { recursive: true, force: true })
}

const failed = results.filter((x) => !x.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
