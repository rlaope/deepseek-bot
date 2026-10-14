/**
 * The command line and the frame-to-screen mapping of the terminal (`dsh`), apart from the entry point so
 * the tests can import them without starting a terminal.
 */
import type { App } from './app.js'
import { NAME, type ClientFrame, type ConversationItem, type ServerFrame } from './protocol.js'
import { interviewPrompt } from './interview.js'
import type { CommandInfo } from './complete.js'
import { stringWidth } from './render/width.js'
import { languageOf } from '../i18n.js'
import { setLanguage, t } from './strings.js'

export interface Args { name?: string; socket?: string; tenant?: string; resume?: string; help: boolean }

export function parseArgs(argv: string[]): Args | { error: string } {
  const args: Args = { help: false }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '-h' || flag === '--help') { args.help = true; continue }
    const value = argv[i + 1]
    const key = ({ '--name': 'name', '--socket': 'socket', '--tenant': 'tenant', '--resume': 'resume' } as const)[flag]
    if (key === undefined) return { error: t().unknownOption(flag) }
    if (value === undefined || value.startsWith('--')) return { error: t().needsValue(flag) }
    args[key] = value
    i++
  }
  return args
}

/** The usage text, in the terminal's language. */
export function usage(): string {
  return t().usage
}

/** The terminal's own flags; `dsh` with anything else is the harness CLI's command line. */
const OWN = new Set(['-h', '--help', '--name', '--socket', '--tenant', '--resume'])

/** Whether `dsh <argv>` opens the terminal or is handed to the DeepSeek Harness CLI, whose name it shares. */
export function route(argv: string[]): 'tui' | 'harness' {
  return argv.length === 0 || OWN.has(argv[0]) ? 'tui' : 'harness'
}

/** The harness CLI inside the app — the same default the gateway's launcher uses. */
export const HARNESS_CLI = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'

/** What is printed on the way out, so the conversation can be picked up again. */
export const resumeHint = (conversation: string): string => t().resumeHint(conversation)

/** Frames from the gateway, onto the screen. */
export function bind(app: App, frame: ServerFrame, commands?: Commands): void {
  switch (frame.type) {
    case 'sessions':
      commands?.listed(frame.items)
      return
    case 'history':
      app.history(frame.items)
      return
    case 'panel':
      app.setPanel(frame.agents, frame.jobs)
      app.setStatus({ tokens: frame.usage.tokens, contextPct: frame.usage.contextPct })
      return
    case 'question':
      app.ask(frame.id, frame.questions)
      return
    case 'question.close':
      app.closeQuestion(frame.id)
      return
    case 'view':
      if (frame.kind === 'agent') app.agentLines(frame.id, frame.lines)
      else app.jobOutput(frame.id, frame.text, frame.append, frame.status)
      return
    case 'ready':
      // The gateway's language wins over the environment's, so the terminal speaks as the bot does.
      if (frame.language !== undefined) setLanguage(languageOf(frame.language))
      commands?.ready()
      app.setBusy(frame.busy)
      app.setStatus({ connected: true, workspace: frame.workspace, session: frame.conversation, model: frame.model, preset: app.status.preset || 'ask' })
      if (frame.tenant !== null) app.notice(t().tenantTalking(frame.tenant), 'info')
      return
    case 'typing':
      if (frame.on) app.turnStarted()
      else app.turnEnded()
      return
    case 'post':
      app.message(frame.ts, frame.text, frame.replace, frame.answer)
      if (frame.buttons.length > 0) app.offer(frame.ts, frame.buttons)
      return
    case 'stream':
      if (frame.kind === 'text') app.delta(frame.text)
      else if (frame.kind === 'reset') app.resetAttempt()
      else if (frame.kind === 'thinking') app.thinking(frame.text)
      else if (frame.kind === 'tool.result') app.toolResult(frame.callId, frame.ok, frame.text)
      else if (frame.kind === 'tool') app.toolCall(frame)
      return
    case 'remove':
      app.unpost(frame.ts)
      return
    case 'error':
      app.notice(`gateway: ${frame.message}`, 'error')
      return
  }
}

/** The /commands the terminal handles itself. Anything else — "/Users/me/x" included — is sent as text. */
export const COMMANDS = ['new', 'sessions', 'resume', 'tenant', 'interview', 'usage', 'clear', 'help', 'quit', 'exit'] as const
export type CommandName = (typeof COMMANDS)[number]

export function parseCommand(text: string): { name: CommandName; args: string } | null {
  const m = /^\/([a-z]+)(?:\s+(.*))?$/s.exec(text.trim())
  if (m === null || !(COMMANDS as readonly string[]).includes(m[1])) return null
  return { name: m[1] as CommandName, args: (m[2] ?? '').trim() }
}

/** Which commands take an argument. */
const TAKES_ARGS: Record<CommandName, boolean> = { new: false, sessions: false, resume: true, tenant: true, interview: true, usage: false, clear: false, help: false, quit: false, exit: false }

/** What each command takes and does, in the terminal's language: the source of /help and of the completion list. */
export function commandInfo(): Array<CommandInfo & { name: CommandName }> {
  const words = t().commands
  return COMMANDS.map((name) => {
    const w: { usage?: string; hint: string } = words[name]
    return { name, ...(w.usage !== undefined ? { usage: w.usage } : {}), hint: w.hint, args: TAKES_ARGS[name] }
  })
}

const column = (text: string, width: number) => text + ' '.repeat(Math.max(1, width - stringWidth(text)))

/** /help: the commands, then the keys. */
export function help(): string {
  return [
    ...commandInfo().map((c) => `${column(`/${c.name}${c.usage ? ` ${c.usage}` : ''}`, 18)}${c.hint}`),
    '',
    ...t().helpKeys,
  ].join('\n')
}

function ago(ms: number, now: number): string {
  return t().ago(Math.max(0, Math.round((now - ms) / 1000)))
}

/** The /sessions list, numbered for /resume <n>. */
export function formatSessions(items: Array<{ conversation: string; lastAt: number; turns: number; tenant: string | null; title: string }>, now: number, current: string | null): string {
  if (items.length === 0) return t().noSessions
  return items.map((item, i) => {
    const mark = item.conversation === current ? '●' : ' '
    const where = item.tenant !== null ? ` · tenant ${item.tenant}` : ''
    const title = item.title === '' ? t().untitled : item.title
    return `${mark}${String(i + 1).padStart(2)}. ${title}\n     ${ago(item.lastAt, now)} · ${t().turns(item.turns)}${where} · ${item.conversation}`
  }).join('\n') + `\n${t().resumeHow}`
}

/** What the commands need of the connection. */
export interface ConversationLink {
  conversation: string | null
  tenant: string | undefined
  send(frame: ClientFrame): boolean
  switchTo(conversation: string | null, tenant?: string): void
}

export interface Commands {
  /** A typed line: true when it was a command (handled here, not sent). */
  intercept(text: string): boolean
  listed(items: ConversationItem[]): void
  ready(): void
  /** A switch was refused: the screen goes back to the conversation that is still current. */
  rolledBack(message: string): void
}

/**
 * The /commands. `resumeOnStart` asks for the conversation's history once the first ready arrives,
 * which is what --resume does.
 */
export function createCommands(app: App, link: ConversationLink, options: { now?: () => number; resumeOnStart?: boolean } = {}): Commands {
  const now = options.now ?? (() => Date.now())
  let listed: ConversationItem[] = []
  let wantHistory = options.resumeOnStart === true
  const offline = () => app.notice(t().notConnected, 'error')

  return {
    intercept(text) {
      const command = parseCommand(text)
      if (command === null) return false
      const { name, args } = command
      switch (name) {
        case 'new':
          app.clear()
          link.switchTo(null, link.tenant)
          app.notice(`${t().newConversation}${link.tenant !== undefined ? ` · tenant ${link.tenant}` : ''}`, 'info')
          break
        case 'tenant':
          // A conversation's workspace is fixed when it starts (a session resumes in the directory it
          // was created in), so changing tenant means a new conversation there.
          app.clear()
          link.switchTo(null, args === '' ? undefined : args)
          app.notice(args === '' ? `${t().newConversation} · ${t().defaultWorkspace}` : `${t().newConversation} · tenant ${args}`, 'info')
          break
        case 'sessions':
          if (!link.send({ type: 'sessions' })) offline()
          break
        case 'resume': {
          const n = Number(args)
          const item = Number.isInteger(n) && n >= 1 && n <= listed.length ? listed[n - 1] : listed.find((i) => i.conversation === args)
          const id = item?.conversation ?? args
          if (!NAME.test(id)) { app.notice(t().resumeUsage, 'error'); break }
          app.clear()
          // The listed conversation's own workspace; a bare id lets the gateway use the recorded one.
          link.switchTo(id, item?.tenant ?? undefined)
          // Asked for on ready: sent now it would reach the old conversation, and a refusal would show it twice.
          wantHistory = true
          break
        }
        case 'interview':
          if (args === '') { app.notice(t().interviewUsage, 'error'); break }
          app.startInterview(args)
          app.sendAs(`${t().interview}: ${args}`, interviewPrompt(args))
          break
        case 'usage':
          if (!link.send({ type: 'usage' })) offline()
          break
        case 'clear':
          app.clear()
          break
        case 'help':
          app.notice(help(), 'info')
          break
        case 'quit':
        case 'exit':
          app.stop(0)
          break
      }
      return true
    },
    listed(items) {
      listed = items
      app.notice(formatSessions(items, now(), link.conversation), 'info')
    },
    ready() {
      if (wantHistory && link.send({ type: 'history' })) wantHistory = false
    },
    rolledBack(message) {
      app.clear()
      app.notice(t().couldNotSwitch(message), 'error')
      wantHistory = !link.send({ type: 'history' })
    },
  }
}
