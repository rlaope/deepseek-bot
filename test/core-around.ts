/**
 * The plugin booted around a real platform transport, with an agent that records what it is handed.
 *
 * A transport suite proves what its parser lets through; the fake transport proves what the core does with a message.
 * Neither alone shows that a platform's event becomes a turn whose prompt carries what the person sent. This joins
 * them: the suite's own transport (its API stubbed) is the core's, and every user message the core gives the agent
 * is recorded.
 */
import './scratch-dsh-home.ts'   // the recall index must not land in the real ~/.dsh
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../dist/index.js'

/** `answer`: each turn completes and answers with it, as a model would; without it a turn ends with no answer. */
export function bootAround(transport: unknown, home: string, config: Record<string, unknown> = {}, fake: { answer?: string } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'deepbot-around-'))
  writeFileSync(join(stateDir, 'sessions.json'), JSON.stringify({ sessions: {}, seen: {}, standing: {}, history: {} }))
  const logs: string[] = []
  const followups: unknown[] = []
  const agent = (options) => {
    const events: unknown[] = []
    return {
      agent: {
        session: { header: { id: options?.sessionId ?? 's1' }, get seq() { return events.length }, eventAt: (i) => events[i] },
        followup: (message) => {
          followups.push(message)
          if (typeof fake.answer === 'string') {
            events.push({ type: 'turn/start' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: fake.answer }] } } },
              { type: 'turn/end', data: { reason: { kind: 'completed' } } })
          }
        },
        whenIdle: async () => {}, cancel: () => {},
      },
      dispose: async () => {},
    }
  }
  const stubs: Record<string, unknown> = {
    agents: { create: async (options) => agent(options), resume: async (options) => agent(options) },
    sessions: { flush: async () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake' }) },
    agentPresets: { resolve: async (id) => ({ id }), acquireScope: () => ({ key: {}, [Symbol.asyncDispose]: async () => {} }), mount: async () => {} },
    permissionPresets: { resolve: () => ({ sandbox: 'workspace-write', approval: 'ask' }), set: () => {}, defaultPreset: 'standard' },
    // Images reach the model through the harness's attachments service: here, a reference per picture.
    attachments: { saveImages: async (images) => images.map((image, i) => ({ id: `image-${i}`, mediaType: image.mediaType })) },
    fs: { resolve: async () => home, processPath: (path) => path },
  }
  const ctx = {
    get: (name) => stubs[name],
    effect: (fn) => fn(),
    on: () => () => {},
    logger: { info: (line) => logs.push(String(line)) },
  }
  apply(ctx, { targetChannels: ['*'], stateDir, transportFactory: () => transport, progressAfterMs: 50, ...config })
  /** The text of each user message the agent was handed. */
  const texts = () => followups.map((message: any) => (message?.content ?? []).map((block) => block?.text ?? '').join(''))
  /** The image blocks of each user message. */
  const images = () => followups.map((message: any) => (message?.content ?? []).filter((block) => block?.type === 'image'))
  return { logs, followups, texts, images, stateDir, done: () => rmSync(stateDir, { recursive: true, force: true }) }
}
