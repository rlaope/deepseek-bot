/**
 * The three languages: how a setting or a locale is read, and that every catalog says everything.
 *
 * A key missing from one language would show as `undefined` on someone's screen, and a catalog
 * copied from another would pass for a translation; both are checked here, for the adapter's
 * words and the terminal's.
 *
 * Run: node test/i18n.test.ts
 */
import './dist-fresh.ts'
import { languageOf, LANGUAGES } from '../dist/i18n.js'
import { defaultWords, messages } from '../dist/messages.js'
import { t } from '../dist/tui/strings.js'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// 1. A setting or a locale, read as one of the three.
{
  const cases = {
    en: 'en', ko: 'ko', zh: 'zh', 'ko-KR': 'ko', 'ko_KR.UTF-8': 'ko', Korean: 'ko', 'zh_CN.UTF-8': 'zh', 'zh-Hant': 'zh',
    Chinese: 'zh', en_US: 'en', fr: 'en', kor: 'ko', koala: 'en', zhx: 'en', '': 'en',
  }
  const wrong = Object.entries(cases).filter(([input, want]) => languageOf(input) !== want).map(([input, want]) => `${input}→${languageOf(input)} (want ${want})`)
  check('languageOf reads settings and locales, and nothing that only starts like one', wrong.length === 0, wrong.join(', '))
  check('languageOf of nothing is English', languageOf(undefined) === 'en' && languageOf(3) === 'en')
}

/** Every leaf of a catalog, by path: a string, a list, or what a function returns for sample arguments. */
function leaves(value, path = ''): Map<string, string> {
  const out = new Map<string, string>()
  if (typeof value === 'string') out.set(path, value)
  else if (Array.isArray(value)) value.forEach((v, i) => leaves(v, `${path}[${i}]`).forEach((s, k) => out.set(k, s)))
  else if (typeof value === 'function') {
    // A number first, then words; a function that takes a list gets one that also reads as a word.
    const list = Object.assign(['x'], { toString: () => 'x' })
    let r
    try { r = value(...Array.from({ length: value.length }, (_, i) => (i === 0 ? 3 : 'x'))) } catch { r = value(...Array.from({ length: value.length }, () => list)) }
    out.set(path, typeof r === 'string' ? r : '')
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) leaves(v, path === '' ? k : `${path}.${k}`).forEach((s, key) => out.set(key, s))
  }
  return out
}

const HANGUL = /[가-힣]/u
const HAN = /[㐀-鿿]/u

function catalogChecks(label: string, of: (l: string) => unknown) {
  const en = leaves(of('en'))
  for (const lang of LANGUAGES) {
    const mine = leaves(of(lang))
    const missing = [...en.keys()].filter((k) => !mine.has(k))
    const extra = [...mine.keys()].filter((k) => !en.has(k))
    const empty = [...mine].filter(([, s]) => s.trim() === '').map(([k]) => k)
    check(`${label} ${lang}: every key, nothing extra, nothing empty`, missing.length + extra.length + empty.length === 0,
      [...missing.map((k) => `missing ${k}`), ...extra.map((k) => `extra ${k}`), ...empty.map((k) => `empty ${k}`)].slice(0, 6).join(', '))
  }
  const ko = leaves(of('ko')), zh = leaves(of('zh'))
  check(`${label} en: no Korean or Chinese in it`, [...en.values()].every((s) => !HANGUL.test(s) && !HAN.test(s)))
  check(`${label} zh: no Korean in it`, [...zh.values()].every((s) => !HANGUL.test(s)))
  // A translation differs from the English in most places; a copy would not.
  const same = (other: Map<string, string>) => [...other].filter(([k, s]) => s === en.get(k)).length / other.size
  check(`${label} ko: is a translation, not a copy`, same(ko) < 0.2 && [...ko.values()].filter((s) => HANGUL.test(s)).length > ko.size / 2, `${Math.round(same(ko) * 100)}% same as English`)
  check(`${label} zh: is a translation, not a copy`, same(zh) < 0.2 && [...zh.values()].filter((s) => HAN.test(s)).length > zh.size / 2, `${Math.round(same(zh) * 100)}% same as English`)
}

// 3. The adapter's words, and the terminal's.
catalogChecks('adapter', (l) => messages(l))

// 4. The terminal's own words are English, whatever the deployment's language: it is not the bot speaking.
{
  check('the terminal speaks English', t().connecting === 'connecting…' && t().hints.idle(false) === '? for shortcuts')
}

// 5. The words people type are understood in every language at once, English first.
{
  const cancel = defaultWords('cancel')
  check('stop words: English first, so esc in the terminal sends "stop"', cancel[0] === 'stop')
  check('stop words: Korean and Chinese too', cancel.includes('그만') && cancel.includes('停止'))
  check('approve and deny words in all three', defaultWords('approve').includes('allow') && defaultWords('approve').includes('허용') && defaultWords('approve').includes('允许')
    && defaultWords('deny').includes('deny') && defaultWords('deny').includes('거부') && defaultWords('deny').includes('拒绝'))
  const overlap = defaultWords('approve').filter((w) => defaultWords('deny').includes(w))
  check('no word both approves and denies', overlap.length === 0, overlap.join(', '))
  const quiet = defaultWords('quiet')
  check('quiet words in all three', quiet.includes('be quiet') && quiet.includes('조용히 해') && quiet.includes('安静'))
  const both = quiet.filter((w) => [...cancel, ...defaultWords('usage'), ...defaultWords('approve'), ...defaultWords('deny')].includes(w))
  check('no quiet word is also another command', both.length === 0, both.join(', '))
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
