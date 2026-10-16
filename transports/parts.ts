/**
 * An answer cut into the messages a platform takes, each numbered `(i/n)` when there is more than one. The number
 * counts toward the platform's limit, so a part leaves room for it (a part one over the limit is refused, and the
 * answer with it); and a cut never falls between the two halves of a surrogate pair (an emoji made of several code
 * points, a flag or a family, can still fall across one). The limit must leave room for the number and some text:
 * a few dozen characters at least; the platforms' are thousands.
 */
export function numberedParts(text: string, limit: number): string[] {
  if (text.length === 0) return ['(empty response)']
  if (text.length <= limit) return [text]
  // The number's width depends on how many parts there are, which depends on the room the number leaves.
  let count = Math.ceil(text.length / limit)
  for (;;) {
    const room = Math.max(2, limit - `(${count}/${count})\n`.length)
    const parts: string[] = []
    for (let i = 0; i < text.length;) {
      let end = Math.min(text.length, i + room)
      const last = text.charCodeAt(end - 1)
      if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1
      parts.push(text.slice(i, end))
      i = end
    }
    if (String(parts.length).length <= String(count).length) return parts.map((part, i) => `(${i + 1}/${parts.length})\n${part}`)
    count = parts.length
  }
}
