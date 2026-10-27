/**
 * The command line and the frame-to-screen mapping of the terminal (`dsh`), apart from the entry point so
 * the tests can import them without starting a terminal.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, win32 } from 'node:path'
import type { App } from './app.js'
import { NAME, type ClientFrame, type ConversationItem, type ModelChoice, type ModelItem, type ServerFrame } from './protocol.js'
import { interviewPrompt } from './interview.js'
import type { CommandInfo } from './complete.js'
import type { PickerSpec } from './picker.js'
import { stringWidth } from './render/width.js'
import { t } from './strings.js'
import { GATEWAY_COMMANDS } from '../service/gateway.js'

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

/** The usage text. */
export function usage(): string {
  return t().usage
}

/** The terminal's own flags; `dsh` with anything else is the harness CLI's command line. */
const OWN = new Set(['-h', '--help', '--name', '--socket', '--tenant', '--resume'])

/**
 * Whether the harness has a profile of this name: it boots one only where `<home>/profiles/<name>/package.json`
 * is (the profiles it makes on first use are its templates, and gateway is none of them). The home is found as the
 * harness finds it: a blank `DSH_HOME` is unset, a leading `~` is the home directory, and the result is absolute.
 */
export function harnessProfile(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const configured = env.DSH_HOME !== undefined && env.DSH_HOME.trim() !== '' ? env.DSH_HOME : join(homedir(), '.dsh')
  const home = configured === '~' ? homedir() : configured.startsWith('~/') || configured.startsWith('~\\') ? join(homedir(), configured.slice(2)) : configured
  return existsSync(join(resolve(home), 'profiles', name, 'package.json'))
}

/**
 * Whether `dsh <argv>` opens the terminal, runs `dsh gateway <command>` or `dsh update`, or is handed to
 * the DeepSeek Harness CLI, whose name it shares. For the harness `dsh gateway` boots a profile named
 * gateway: where one exists, only `gateway` followed by one of its commands is taken here. Where none does,
 * the harness could only fail with its stack trace, so `dsh gateway` alone, its help and a mistyped command
 * are ours too. Likewise `update` only alone or with its help flag (a profile named update is still
 * `dsh --profile update`).
 */
export function route(argv: string[], hasProfile: (name: string) => boolean = harnessProfile): 'tui' | 'gateway' | 'update' | 'harness' {
  if (argv.length === 0 || OWN.has(argv[0])) return 'tui'
  if (argv[0] === 'update' && (argv.length === 1 || (argv.length === 2 && (argv[1] === '-h' || argv[1] === '--help')))) return 'update'
  if (argv[0] !== 'gateway') return 'harness'
  return GATEWAY_COMMANDS.has(argv[1]) || !hasProfile('gateway') ? 'gateway' : 'harness'
}

/** The harness CLI inside the app — the same default the gateway's launcher uses. */
export const HARNESS_CLI = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'

/**
 * Where the harness CLI is. On Windows there is no app: `npm i -g @deepseek-ai/dsh` puts a dsh.cmd shim
 * in npm's global directory, on PATH, that runs node_modules\@deepseek-ai\dsh\lib\bin.js beside it — so
 * that script is found the same way, wherever the global directory is (a runner's is not %APPDATA%\npm).
 * Only a shim with the harness beside it counts: this project's own dsh.cmd has none.
 */
export function harnessCli(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string {
  if (platform !== 'win32') return HARNESS_CLI
  const entry = (dir: string) => win32.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  // A relative PATH entry is wherever dsh was started, which is not npm's directory. An entry may be quoted
  // ("C:\Program Files\nodejs"), as cmd itself accepts.
  const found = (env.PATH ?? env.Path ?? '').split(';').map((dir) => dir.replace(/^"(.*)"$/, '$1'))
    .find((dir) => win32.isAbsolute(dir) && existsSync(win32.join(dir, 'dsh.cmd')) && existsSync(entry(dir)))
  return entry(found ?? win32.join(env.APPDATA ?? '', 'npm'))
}

/** What is printed on the way out, so the conversation can be picked up again. */
export const resumeHint = (conversation: string): string => t().resumeHint(conversation)

/** Frames from the gateway, onto the screen. */
export function bind(app: App, frame: ServerFrame, commands?: Commands): void {
  switch (frame.type) {
    case 'sessions':
      commands?.listed(frame.items)
      return
    case 'models':
      commands?.models(frame.items, frame.current)
      return
    case 'model':
      app.setStatus({ model: frame.current.model, effort: frame.current.effort })
      commands?.modelChanged()
      // A shift+tab shows in the status line; a line in the transcript for each would bury the conversation.
      if (frame.cause !== 'effort') app.notice(t().modelNow(`${frame.current.provider}/${frame.current.model}`, frame.current.effort), 'ok')
      else app.effortStepped(frame.current.effort)
      return
    case 'history':
      app.history(frame.items)
      return
    case 'panel':
      app.setPanel(frame.agents, frame.jobs)
      app.setStatus({ tokens: frame.usage.tokens, tokensIn: frame.usage.input ?? null, tokensOut: frame.usage.output ?? null, tokensCached: frame.usage.cached ?? null, contextPct: frame.usage.contextPct })
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
      commands?.ready()
      app.setBusy(frame.busy)
      app.setStatus({ connected: true, workspace: frame.workspace, session: frame.conversation, model: frame.model, effort: frame.effort ?? null })
      app.setAnsweredAtOnce(frame.stop ?? [], frame.instant ?? [])
      if (frame.tenant !== null) app.notice(t().tenantTalking(frame.tenant), 'info')
      return
    case 'typing':
      if (frame.on) app.turnStarted()
      else app.turnEnded()
      return
    case 'withdrawn':
      app.withdrawn(frame.ids, frame.asked ?? [], frame.stop === true)
      return
    case 'post':
      app.message(frame.ts, frame.text, frame.replace, frame.answer)
      if (frame.buttons.length > 0) app.offer(frame.ts, frame.buttons)
      return
    case 'stream':
      if (frame.kind === 'text') app.delta(frame.text)
      else if (frame.kind === 'reset') app.resetAttempt()
      else if (frame.kind === 'thinking') app.thinking(frame.text)
      else if (frame.kind === 'tool.result') app.toolResult(frame.callId, frame.ok, frame.text, frame.lines)
      else if (frame.kind === 'tool') app.toolCall(frame)
      return
    case 'remove':
      app.unpost(frame.ts)
      return
    case 'error': {
      // A gateway older than this terminal refuses a frame it does not know; say why, not its line.
      const unknown = frame.code === 'unknown-frame' || frame.code === 'bad-frame' ? /^unknown frame type (\S+)/.exec(frame.message) : null
      app.notice(unknown !== null ? t().gatewayOlder(unknown[1]) : `gateway: ${frame.message}`, 'error')
      return
    }
  }
}

/** The /commands the terminal handles itself. Anything else — "/Users/me/x" included — is sent as text. */
export const COMMANDS = ['new', 'sessions', 'resume', 'tenant', 'interview', 'usage', 'clear', 'help', 'quit', 'exit', 'model'] as const
export type CommandName = (typeof COMMANDS)[number]

export function parseCommand(text: string): { name: CommandName; args: string } | null {
  const m = /^\/([a-z]+)(?:\s+(.*))?$/s.exec(text.trim())
  if (m === null || !(COMMANDS as readonly string[]).includes(m[1])) return null
  return { name: m[1] as CommandName, args: (m[2] ?? '').trim() }
}

/** Which commands take an argument. */
const TAKES_ARGS: Record<CommandName, boolean> = { new: false, sessions: false, resume: true, tenant: true, interview: true, usage: false, clear: false, help: false, quit: false, exit: false, model: true }

/** What each command takes and does: the source of /help and of the completion list. */
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
  /** The models the gateway listed for /model, and what this conversation runs on. */
  models(items: ModelItem[], current: ModelChoice): void
  ready(): void
  /** A switch was refused: the screen goes back to the conversation that is still current. */
  rolledBack(message: string): void
  /** shift+tab: the conversation's next effort, which the gateway works out. */
  stepEffort(): void
  /** The conversation's model or effort changed: a model picker still open shows what was. */
  modelChanged(): void
}

/**
 * The /commands. `resumeOnStart` asks for the conversation's history once the first ready arrives,
 * which is what --resume does.
 */
export function createCommands(app: App, link: ConversationLink, options: { now?: () => number; resumeOnStart?: boolean } = {}): Commands {
  const now = options.now ?? (() => Date.now())
  let listed: ConversationItem[] = []
  let models: ModelItem[] = []
  /** The model picker this terminal opened last, so a change under it can close it. */
  let modelPicker: PickerSpec | null = null
  let wantHistory = options.resumeOnStart === true
  const offline = () => app.notice(t().notConnected, 'error')
  const send = (frame: ClientFrame) => { if (!link.send(frame)) offline() }

  function resume(id: string, tenant: string | undefined): void {
    if (!NAME.test(id)) { app.notice(t().resumeUsage, 'error'); return }
    app.clear()
    // The listed conversation's own workspace; a bare id lets the gateway use the recorded one.
    link.switchTo(id, tenant)
    // Asked for on ready: sent now it would reach the old conversation, and a refusal would show it twice.
    wantHistory = true
  }

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
          resume(item?.conversation ?? args, item?.tenant ?? undefined)
          break
        }
        case 'model': {
          // /model lists; /model <n|provider/model> [effort] switches this conversation; /model default goes back.
          if (args === '') { if (!link.send({ type: 'models' })) offline(); break }
          const [which, effort] = args.split(/\s+/, 2)
          if (which === 'default') { if (!link.send({ type: 'model', provider: null })) offline(); break }
          const n = Number(which)
          let choice: { provider: string; model: string } | null = null
          if (Number.isInteger(n)) {
            if (models.length === 0) { app.notice(t().modelListFirst, 'error'); break }
            const item = n >= 1 && n <= models.length ? models[n - 1] : undefined
            if (item === undefined) { app.notice(t().modelUsage, 'error'); break }
            choice = { provider: item.provider, model: item.id }
          } else {
            // provider/model: a model id may hold a slash of its own (deepseek/deepseek-v4.1-…), a provider does not.
            const slash = which.indexOf('/')
            if (slash <= 0 || slash === which.length - 1) { app.notice(t().modelUsage, 'error'); break }
            choice = { provider: which.slice(0, slash), model: which.slice(slash + 1) }
          }
          if (!link.send({ type: 'model', ...choice, effort: effort ?? null })) offline()
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
          app.clear(true)
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
      if (items.length === 0) { app.notice(t().noSessions, 'info'); return }
      app.openPicker({
        title: t().pickSession,
        rows: items.map((item) => ({
          label: item.title === '' ? t().untitled : item.title,
          detail: t().sessionDetail(ago(item.lastAt, now()), t().turns(item.turns), item.tenant, item.conversation),
          current: item.conversation === link.conversation,
        })),
        onPick: (i) => { const item = items[i]; if (item !== undefined) resume(item.conversation, item.tenant ?? undefined) },
      })
    },
    models(items, current) {
      models = items
      app.setStatus({ model: current.model, effort: current.effort })
      modelPicker = {
        title: t().pickModel,
        rows: [
          ...items.map((item) => {
            const on = item.provider === current.provider && item.id === current.model
            return {
              label: `${item.provider}/${item.id}`,
              ...(item.name !== item.id ? { detail: item.name } : {}),
              ...(on ? { current: true, efforts: current.efforts, effort: current.effort } : item.efforts !== undefined ? { efforts: item.efforts } : {}),
            }
          }),
          { label: t().modelDefault.label, detail: t().modelDefault.detail },
        ],
        onPick: (i, effort) => {
          const item = items[i]
          send(item === undefined ? { type: 'model', provider: null } : { type: 'model', provider: item.provider, model: item.id, effort })
        },
      }
      app.openPicker(modelPicker)
    },
    modelChanged() {
      // What it shows is no longer so; ↵ on it would send the old effort and undo the change.
      if (modelPicker !== null) app.closePicker(modelPicker)
    },
    stepEffort() {
      send({ type: 'effort', step: 1 })
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
