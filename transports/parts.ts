/**
 * An answer cut into the messages a platform takes, each numbered `(i/n)` when there is more than one. The number
 * counts toward the platform's limit, so a part leaves room for it (a part one over the limit is refused, and the
 * answer with it). The limit must leave room for the number and some text: a few dozen characters at least; the
 * platforms' are thousands.
 *
 * Where a part ends: within the second half of its room, after a blank line, else after a line end, else after a
 * space, else where the room ends. Never between the two halves of a surrogate pair (an emoji made of several code
 * points, a flag or a family, can still fall across one), inside a `<…>` token (a Slack link or mention, a Discord
 * one), inside an `&…;` entity (Slack's text is escaped so), on a ``` fence's own line, right after the line that
 * opens one or right before the line that closes one. A cut inside a code block closes it at the end of the part and
 * opens it again, with its info string, at the start of the next, so each part is shown as code where the answer was
 * code and as text where it was text. Without those added fences, the parts are the answer, whole and in order.
 */
export function numberedParts(text: string, limit: number): string[] {
  if (text.length === 0) return ['(empty response)']
  if (text.length <= limit) return [text]
  const shape = shapeOf(text)
  // The number's width depends on how many parts there are, which depends on the room the number leaves.
  let count = Math.ceil(text.length / limit)
  for (;;) {
    const room = Math.max(2, limit - `(${count}/${count})\n`.length)
    const parts: string[] = []
    for (let i = 0; i < text.length;) {
      const open = shape.fenceAt(i)
      const reopen = open === null ? '' : `${open.mark}${open.info}\n`
      const max = Math.max(i + 1, i + room - reopen.length)
      let end = cutBefore(text, shape.blocked, i, max)
      let close = ''
      const crossing = end < text.length ? shape.fenceAt(end) : null
      if (crossing !== null) {
        // Room for the closing mark, and for its line end when the part does not end on one.
        end = cutBefore(text, shape.blocked, i, Math.max(i + 1, max - crossing.mark.length - 1))
        const inside = end < text.length ? shape.fenceAt(end) : null
        if (inside !== null) close = `${text[end - 1] === '\n' ? '' : '\n'}${inside.mark}`
      }
      parts.push(`${reopen}${text.slice(i, end)}${close}`)
      i = end
    }
    if (String(parts.length).length <= String(count).length) return parts.map((part, i) => `(${i + 1}/${parts.length})\n${part}`)
    count = parts.length
  }
}

interface Fence { mark: string; info: string }

/** Where a cut may not fall, and which code block is open at a position. Read once per answer. */
function shapeOf(text: string): { blocked: Uint8Array; fenceAt: (at: number) => Fence | null } {
  // blocked[p]: a cut at p, between text[p - 1] and text[p], would split something.
  const blocked = new Uint8Array(text.length + 1)
  const block = (from: number, to: number) => { for (let p = Math.max(1, from + 1); p < Math.min(to, text.length); p++) blocked[p] = 1 }
  for (const m of text.matchAll(/<[^\s<>][^<>\n]*>/g)) block(m.index, m.index + m[0].length)
  for (const m of text.matchAll(/&(?:#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});/gi)) block(m.index, m.index + m[0].length)
  // Code blocks by their fence lines: a run of three or more backticks and an info string without a backtick opens
  // one, and the next line that is a run at least as long, alone, closes it.
  const changes: { at: number; fence: Fence | null }[] = []
  let open: Fence | null = null
  for (const m of text.matchAll(/^[ \t]*(`{3,})([^\n]*)$/gm)) {
    const lineEnd = m.index + m[0].length
    const [, mark, rest] = m
    if (open === null && !rest.includes('`')) {
      open = { mark, info: rest }
      block(m.index, lineEnd + 2)
      changes.push({ at: lineEnd, fence: open })
    } else if (open !== null && mark.length >= open.mark.length && rest.trim() === '') {
      open = null
      block(m.index - 1, lineEnd)
      changes.push({ at: lineEnd, fence: null })
    }
  }
  const fenceAt = (at: number): Fence | null => {
    let fence: Fence | null = null
    for (const change of changes) {
      if (change.at > at) break
      fence = change.fence
    }
    return fence
  }
  return { blocked, fenceAt }
}

/** The end of a part that starts at `start` and may run to `max`, by the order of preference above. */
function cutBefore(text: string, blocked: Uint8Array, start: number, max: number): number {
  if (max >= text.length) return text.length
  const free = (p: number) => blocked[p] === 0 && !isHighSurrogate(text.charCodeAt(p - 1))
  const floor = start + Math.max(1, Math.floor((max - start) / 2))
  for (const after of ['\n\n', '\n', ' ']) {
    for (let k = text.lastIndexOf(after, max - after.length); k >= 0 && k + after.length >= floor; k = text.lastIndexOf(after, k - 1)) {
      if (free(k + after.length)) return k + after.length
    }
  }
  for (let p = max; p > start; p--) if (free(p)) return p
  // Nothing in the room can be cut cleanly (a token longer than a part): where the room ends, a whole character.
  return isHighSurrogate(text.charCodeAt(max - 1)) && max - 1 > start ? max - 1 : max
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}
