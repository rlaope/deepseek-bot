/**
 * Markdown tables as lists. Slack, Discord and Telegram render no tables: an answer with one arrived as rows of
 * pipes and a line of dashes. The transports now turn a table into a list before they format the rest.
 *
 * Run: node test/tables.test.ts
 */
import './dist-fresh.ts'   // fails loudly on a stale dist
import { tablesAsLists } from '../dist/transports/tables.js'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// The answer that was seen in Slack: a two-column table between paragraphs.
const seen = [
  '여기서 한 번 더 갈라져:',
  '',
  '| 층 | 값 |',
  '|---|---|',
  '| 런타임 라벨 | `deepseek-bot` — DSH가 부르는 봇 종류 이름 |',
  '| 페르소나 | 아리 — SOUL.md에 정의된 정체성·말투 |',
  '| 플랫폼 표시명 | example-bot — Slack에서 보이는 이름 |',
  '',
  '그래서 지금 대화하는 건 DSH 위의 아리야.',
].join('\n')
const list = tablesAsLists(seen)
check('a two-column table: each row a bullet, its first cell in bold', list.includes('- **런타임 라벨** — `deepseek-bot` — DSH가 부르는 봇 종류 이름') && list.includes('- **플랫폼 표시명** — example-bot — Slack에서 보이는 이름'), list)
check('no pipes or dashes are left of it', !/\|/.test(list) && !/---/.test(list), list)
check('the text around it stays, blank lines too', list.startsWith('여기서 한 번 더 갈라져:\n\n- ') && list.endsWith('\n\n그래서 지금 대화하는 건 DSH 위의 아리야.'), JSON.stringify(list))

// Three columns or more: the later cells are named by their header.
const wide = tablesAsLists('| 모델 | 속도 | 가격 |\n|:---|:---:|---:|\n| flash | 빠름 | 낮음 |\n| pro | 보통 |  |')
check('three columns: the later cells named by their header (alignment marks read as a separator)', wide === '- **flash** — 속도: 빠름 · 가격: 낮음\n- **pro** — 속도: 보통', JSON.stringify(wide))

// Without the outer pipes, and with an escaped pipe in a cell.
const bare = tablesAsLists('key | value\n--- | ---\nor | a \\| b')
check('a table without outer pipes, an escaped pipe kept as a pipe', bare === '- **or** — a | b', JSON.stringify(bare))

// What is not a table stays as it is.
const prose = 'a | b means either\n---\nnext'
check('pipes in a sentence, then a rule, are not a table', tablesAsLists(prose) === prose, JSON.stringify(tablesAsLists(prose)))
const fenced = '```\n| a | b |\n|---|---|\n| 1 | 2 |\n```'
check('a table in a code block is left as code', tablesAsLists(fenced) === fenced, JSON.stringify(tablesAsLists(fenced)))
const after = tablesAsLists('```\nx\n```\n| a | b |\n|---|---|\n| 1 | 2 |')
check('and one after a code block is still a table', after === '```\nx\n```\n- **1** — 2', JSON.stringify(after))
const mismatched = '| a | b |\n|---|\n| 1 | 2 |'
check('a separator with another number of columns is not a table', tablesAsLists(mismatched) === mismatched, JSON.stringify(tablesAsLists(mismatched)))

// Cells the model left empty, or bolded itself.
const sparse = tablesAsLists('| | 값 |\n|---|---|\n| | 둘째만 |\n| **굵게** | x |')
check('an empty first cell leaves no empty bold; a bold one is not bolded twice', sparse === '- 둘째만\n- **굵게** — x', JSON.stringify(sparse))

const tight = tablesAsLists('| a | b |\n|---|---|\n| 1 | 2 |\n다음 줄은 표가 아니야')
check('a line without a pipe right after a table ends it', tight === '- **1** — 2\n다음 줄은 표가 아니야', JSON.stringify(tight))

const headed = tablesAsLists('| 이름 | 역할 |\n|---|---|\n\n끝')
check('a table with a header and no rows is one line of its header', headed === '- 이름 · 역할\n\n끝', JSON.stringify(headed))

// Found in review.
// A bold pair is taken off the first cell only when it wraps the whole cell: `**kwargs`, a glob and an operator keep theirs.
const stars = tablesAsLists('| 이름 | 뜻 |\n|---|---|\n| `**kwargs` | 키워드 인자 |\n| src/**/*.ts | 모든 ts |\n| ** | 거듭제곱 |')
check('stars inside the first cell are kept, and it is then not bolded (bold around them would break)', stars === '- `**kwargs` — 키워드 인자\n- src/**/*.ts — 모든 ts\n- ** — 거듭제곱', JSON.stringify(stars))
const twice = tablesAsLists('| 비교 | 결과 |\n|---|---|\n| **Pro** vs **Flash** | Pro가 느림 |\n| ***굵은 기울임*** | x |')
check('a first cell with bold spans of its own, or bold italics, is kept whole', twice === '- **Pro** vs **Flash** — Pro가 느림\n- ***굵은 기울임*** — x', JSON.stringify(twice))
// A pipe in a code span that does not add a cell still splits one: the backticks no longer pair up.
const narrow = '| 식 | 뜻 | 비고 |\n|---|---|---|\n| `a|b` | 파이프 |'
check('a cell with an odd number of backticks leaves the table as written', tablesAsLists(narrow) === narrow, JSON.stringify(tablesAsLists(narrow)))
const italic = tablesAsLists('| 모양 | 값 |\n|---|---|\n| *기울임* | 값 |\n| _밑줄_ | 둘 |')
check('a first cell already in italics is not bolded on top', italic === '- *기울임* — 값\n- _밑줄_ — 둘', JSON.stringify(italic))
// A pipe the model left unescaped in a code span or a link splits a row into more cells than the header: kept as written.
const split = '| 식 | 뜻 |\n|---|---|\n| `a || b` | a가 거짓이면 b |\n| docs | 문서 |'
check('a row with more cells than its header leaves the table as written', tablesAsLists(split) === split, JSON.stringify(tablesAsLists(split)))
// A line with one pipe over a rule is a paragraph and a rule, not a table of one column; an escaped pipe is not a pipe.
for (const text of ['마지막 줄 |\n---\n다음 문단', 'a \\| b 는 파이프\n---\n끝', 'x |\n-\ny']) {
  check(`not a table: ${JSON.stringify(text)}`, tablesAsLists(text) === text, JSON.stringify(tablesAsLists(text)))
}
// Two lines with pipes, the second not dashes; a header whose only pipe is escaped, over a one-column rule.
for (const text of ['a | b\nc | d\n끝', 'a \\| b 는 파이프\n|---|\n| 1 |']) {
  check(`not a table either: ${JSON.stringify(text)}`, tablesAsLists(text) === text, JSON.stringify(tablesAsLists(text)))
}
check('a one-column table with its pipes is still one', tablesAsLists('| 할 일 |\n|---|\n| 배포 |') === '- **배포**', JSON.stringify(tablesAsLists('| 할 일 |\n|---|\n| 배포 |')))
// Rows with nothing in them are no bullets.
const empty = tablesAsLists('| a | b | c |\n|---|---|---|\n| | | |\n| x | | |\n\n| | |\n|---|---|\n\n끝')
check('empty rows, and an empty header with no rows, leave nothing', empty === '- **x**\n\n\n끝', JSON.stringify(empty))
// Other code blocks: a ~~~ fence is code too.
const tilde = '~~~\n| a | b |\n|---|---|\n| 1 | 2 |\n~~~'
check('a table in a ~~~ block is left as code', tablesAsLists(tilde) === tilde, JSON.stringify(tablesAsLists(tilde)))
// A list item, a heading or a quote right after a table starts a new block.
const next = tablesAsLists('| a | b |\n|---|---|\n| 1 | 2 |\n- 다음 항목 | 파이프\n# 제목 | x')
check('a list item or a heading right after a table is not a row', next === '- **1** — 2\n- 다음 항목 | 파이프\n# 제목 | x', JSON.stringify(next))
// Linear on a long run of spaces (the separator was a backtracking regular expression).
const t0 = Date.now()
tablesAsLists('a | b\n|-' + ' '.repeat(50_000) + 'x')
check('a long run of spaces is quick', Date.now() - t0 < 100, `${Date.now() - t0} ms`)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
