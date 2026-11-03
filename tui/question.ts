/**
 * Answering a turn's questions, one at a time: the state behind the question panel.
 *
 * Pure, so its rules are tested without a screen. A single-select question is answered by Enter
 * on an option; a multi-select one by Space to toggle, then Enter. "type your own…" takes the person's
 * own words (replacing the choice on single-select, adding to it on multi-select — the harness's
 * rule). Esc skips a question, which the harness accepts as `{ id, selected: [] }`.
 */
import type { QuestionAnswer, QuestionItem } from '../types/transport.js'
import { t } from './strings.js'

export interface QuestionRow {
  kind: 'option' | 'custom'
  label: string
  description?: string
  checked: boolean
}

export class QuestionFlow {
  readonly id: string
  readonly items: QuestionItem[]
  index = 0
  cursor = 0
  /** Typing the person's own answer for the current question. */
  typing = false
  private picked = new Set<number>()
  readonly answers: QuestionAnswer[] = []
  /** The box's text each answer of the person's own words was typed as (chips in it), by answer. */
  private raws: Array<string | undefined> = []
  /** Answers after a reopened one, put back once it is answered again. */
  private kept: { answers: QuestionAnswer[]; raws: Array<string | undefined> } | null = null

  constructor(id: string, items: QuestionItem[]) {
    this.id = id
    this.items = items
    this.cursor = this.approveIndex()
  }

  get current(): QuestionItem | undefined {
    return this.items[this.index]
  }

  get done(): boolean {
    return this.index >= this.items.length
  }

  /** A plan review's affirmative option is where the cursor starts. */
  private approveIndex(): number {
    const q = this.current
    const at = q?.intent?.approve === undefined ? -1 : q.options.findIndex((o) => o.label === q.intent!.approve)
    return Math.max(0, at)
  }

  rows(): QuestionRow[] {
    const q = this.current
    if (q === undefined) return []
    return [
      ...q.options.map((o, i) => ({ kind: 'option' as const, label: o.label, ...(o.description ? { description: o.description } : {}), checked: this.picked.has(i) })),
      { kind: 'custom' as const, label: t().typeOwn, checked: false },
    ]
  }

  move(delta: number): void {
    const n = this.rows().length
    if (n > 0) this.cursor = (this.cursor + delta + n) % n
  }

  /** Space: toggle an option of a multi-select question. */
  toggle(): void {
    const q = this.current
    if (q === undefined || !q.multiSelect || this.cursor >= q.options.length) return
    if (this.picked.has(this.cursor)) this.picked.delete(this.cursor)
    else this.picked.add(this.cursor)
  }

  /**
   * Enter. On an option it answers (single) or confirms what is ticked (multi; the option under the
   * cursor when nothing is). On "type your own…" it switches to typing.
   */
  choose(): 'answered' | 'typing' {
    const q = this.current
    if (q === undefined) return 'answered'
    if (this.cursor >= q.options.length) { this.typing = true; return 'typing' }
    const selected = q.multiSelect && this.picked.size > 0
      ? [...this.picked].sort((a, b) => a - b).map((i) => q.options[i].label)
      : [q.options[this.cursor].label]
    this.record({ id: q.id, selected })
    return 'answered'
  }

  /** The person's own words for the current question; `raw`, the box's text they were typed as. */
  submitCustom(text: string, raw?: string): void {
    const q = this.current
    if (q === undefined) return
    const selected = q.multiSelect ? [...this.picked].sort((a, b) => a - b).map((i) => q.options[i].label) : []
    this.record({ id: q.id, selected, ...(text.trim() !== '' ? { custom: text.trim() } : {}) }, raw)
  }

  /**
   * The batch was refused for its size: the question answered with the longest words of the person's own (or the
   * last) is the current one again, its picks as they were; the answers after it are kept, and put back when it is
   * answered again. Returns the box's text it was answered with, or its words.
   */
  reopen(): string | undefined {
    let at = this.answers.length - 1
    let longest = -1
    this.answers.forEach((a, i) => { if ((a.custom?.length ?? -1) > longest) { longest = a.custom!.length; at = i } })
    const answer = this.answers[at]
    if (answer === undefined) return undefined
    const raw = this.raws[at] ?? answer.custom
    this.kept = { answers: this.answers.slice(at + 1), raws: this.raws.slice(at + 1) }
    this.answers.splice(at)
    this.raws.splice(at)
    this.index = at
    const q = this.current!
    this.picked = new Set(answer.selected.map((label) => q.options.findIndex((o) => o.label === label)).filter((i) => i >= 0))
    this.typing = false
    this.cursor = this.approveIndex()
    return raw
  }

  /** Esc: leave this question unanswered. */
  skip(): void {
    const q = this.current
    if (q !== undefined) this.record({ id: q.id, selected: [] })
  }

  /** What the person answered to question `i`, in words, for the transcript. */
  describe(answer: QuestionAnswer): string {
    const parts = [...answer.selected]
    if (answer.custom !== undefined) parts.push(`"${answer.custom}"`)
    return parts.length === 0 ? t().skipped : parts.join(', ')
  }

  private record(answer: QuestionAnswer, raw?: string): void {
    this.answers.push(answer)
    this.raws.push(raw)
    this.index++
    if (this.kept !== null) {
      this.answers.push(...this.kept.answers)
      this.raws.push(...this.kept.raws)
      this.index += this.kept.answers.length
      this.kept = null
    }
    this.picked = new Set()
    this.typing = false
    this.cursor = this.approveIndex()
  }
}
