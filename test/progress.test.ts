/**
 * The progress message rules, with no agent and no platform.
 *
 * The point of the message is that a long turn looks alive. The rules that make it
 * work are small and easy to get wrong: post once, edit after that, do not edit
 * faster than the throttle, and never leave the message behind — an orphaned
 * "working on it" is worse than no progress at all.
 *
 * Run: node test/progress.test.ts
 */
import './dist-fresh.ts'   // fails loudly on a stale dist

import { createProgressTracker, tenthsOf, typicalTurns } from '../dist/progress.js'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const target = { channel: 'C1', threadTs: 't1' }

function tracker(options = {}) {
  const posted = []
  let clock = 1000
  const t = createProgressTracker({
    async post(target, text, opts: { replace?: string | null } = {}) {
      posted.push({ target, text, replace: opts.replace ?? null })
      return { ts: `ts-${posted.length}` }
    },
    throttleMs: 2500,
    label: 'working',
    now: () => clock,
    ...options,
  })
  return { t, posted, tick: (ms) => { clock += ms } }
}

// 1. The first activity posts; nothing else does until the throttle window passes.
{
  const { t, posted, tick } = tracker()
  await t.note('k', target, 'bash')
  check('the first activity posts a message', posted.length === 1, JSON.stringify(posted[0]?.text))
  check('the message names the tool', /bash/.test(posted[0].text))
  await t.note('k', target, 'grep')
  check('a second update inside the window is skipped', posted.length === 1, `${posted.length} post(s)`)
  tick(3000)
  await t.note('k', target, 'read')
  check('an update after the window edits the same message', posted.length === 2 && posted[1].replace === 'ts-1', JSON.stringify(posted[1]))
  check('the edit counts the tools', /3 tools \(read\)/.test(posted[1].text), posted[1].text)
}

// 2. force ignores the throttle, which is how a slow turn first appears.
{
  const { t, posted } = tracker()
  await t.force('k', target)
  check('force posts without any activity', posted.length === 1)
  await t.force('k', target)
  check('force edits immediately', posted.length === 2 && posted[1].replace === 'ts-1')
  check('the label alone is enough when nothing has happened yet', posted[0].text === 'working', posted[0].text)
}

// 3. take returns what to replace and stops tracking.
{
  const { t, posted } = tracker()
  await t.note('k', target, 'bash')
  const taken = t.take('k')
  check('take returns the message id', taken?.ts === 'ts-1', JSON.stringify(taken))
  check('take returns the target', taken?.target?.channel === 'C1')
  check('take stops tracking', t.size() === 0)
  check('take on an unknown conversation is null', t.take('other') === null)
  check('nothing was posted twice', posted.length === 1)
}

// 4. A conversation that produced no message is forgotten without one.
{
  const { t, posted } = tracker()
  t.forget('k')
  check('forgetting an unknown conversation is harmless', posted.length === 0 && t.size() === 0)
}

// 5. Conversations are independent.
{
  const { t, posted } = tracker()
  await t.note('a', { channel: 'CA', threadTs: null }, 'bash')
  await t.note('b', { channel: 'CB', threadTs: null }, 'grep')
  check('two conversations get two messages', posted.length === 2 && posted[0].target.channel === 'CA' && posted[1].target.channel === 'CB')
  check('each keeps its own id', t.take('a')?.ts === 'ts-1' && t.take('b')?.ts === 'ts-2')
}

// 6. A failed post leaves no message id, so nothing tries to edit a ghost.
{
  const posted = []
  const t = createProgressTracker({
    async post(target, text, opts: { replace?: string | null } = {}) { posted.push({ text, replace: opts.replace ?? null }); return null },
    throttleMs: 0, label: 'working', now: () => 1000,
  })
  await t.note('k', target, 'bash')
  await t.note('k', target, 'grep')
  check('a post that returned nothing is retried as a post', posted.length === 2 && posted[1].replace === null, JSON.stringify(posted))
  check('and take reports no message', t.take('k')?.ts === null)
}

// 7. Renders are serial. A second render while the first post is still in flight edits that message
// instead of posting another — two posts meant one of them was never replaced. settle() waits for all.
{
  const posted = []
  const t = createProgressTracker({
    async post(target, text, opts: { replace?: string | null } = {}) {
      posted.push({ text, replace: opts.replace ?? null })
      const ts = `ts-${posted.length}`
      await new Promise((r) => setTimeout(r, 30))
      return { ts }
    },
    throttleMs: 0, label: 'working', now: () => 1000,
  })
  void t.force('k', target)
  void t.force('k', target)
  await t.settle('k')
  check('a render during an in-flight post edits rather than posts', posted.length === 2 && posted[1].replace === 'ts-1', JSON.stringify(posted))
  check('settle waits for every render', t.take('k')?.ts === 'ts-1')
  check('settle on an unknown conversation resolves', await t.settle('none').then(() => true))
}

// 8. The label can be computed, so it can name who is working once that is known.
{
  let name = ''
  const { t, posted } = tracker({ label: () => `⏳ ${name} 작업 중…` })
  name = '아리'
  await t.force('k', target)
  check('a computed label is read when the message is rendered', posted[0]?.text === '⏳ 아리 작업 중…', posted[0]?.text)
}

// The reaction on a person's message while their turn runs: a rough share of a typical turn, in tenths, 1 to 9.
// Never 0 (it is moving) and never 10 (that is the check mark), and it slows as it goes, as a guess should.
{
  const t = 30_000
  check('tenths: at once, 1', tenthsOf(0, t) === 1, String(tenthsOf(0, t)))
  check('tenths: a typical turn\'s length, 6', tenthsOf(t, t) === 6, String(tenthsOf(t, t)))
  check('tenths: twice that, 8', tenthsOf(2 * t, t) === 8, String(tenthsOf(2 * t, t)))
  check('tenths: never past 9', tenthsOf(100 * t, t) === 9, String(tenthsOf(100 * t, t)))
  const typical = typicalTurns()
  check('typical: 30 s until any turn is timed', typical.ms() === 30_000, String(typical.ms()))
  for (const ms of [10_000, 20_000, 30_000, 40_000, 1_000_000]) typical.record(ms)
  check('typical: the median of what was timed, so one long turn does not stretch it', typical.ms() === 30_000, String(typical.ms()))
  const recent = typicalTurns()
  for (let i = 0; i < 30; i++) recent.record(100)
  for (let i = 0; i < 20; i++) recent.record(5_000)
  check('typical: the last twenty only', recent.ms() === 5_000, String(recent.ms()))
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
