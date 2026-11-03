#!/usr/bin/env node
/**
 * dsh: the bot in a terminal.
 *
 *   dsh [--name <gateway>] [--socket <path>] [--tenant <name>] [--resume <conversation>]
 *   dsh gateway <command>  connect a messenger and run the service (service/gateway.ts)
 *   dsh <anything else>   handed to the DeepSeek Harness CLI, whose name this shares
 *
 * Connects to a running gateway whose deepbot row serves `platform: 'local'` (alone or in a list
 * with Slack). The conversation, its memory and its session live in that gateway; this process is
 * only the screen, so quitting loses nothing and `--resume` picks the conversation up again.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { constants } from 'node:os'
import { App } from './app.js'
import { Connection, discover, lookup, tooLarge } from './client.js'
import { bind, commandInfo, createCommands, harnessCli, parseArgs, resumeHint, route, usage, type Commands } from './cli.js'
import type { ClientFrame } from './protocol.js'
import { t } from './strings.js'
import { fileFinder, gitBranch } from './files.js'
import { appendHistory, historyFile, loadHistory } from './history.js'
import { processIO, restoreOnExit } from './render/terminal.js'
import { gateway, processIO as gatewayIO } from '../service/gateway.js'
import { update, processIO as updateIO } from '../service/update.js'

/** `dsh <harness arguments>`: run the harness CLI with them, and leave with its status. */
function forward(argv: string[]): never {
  const bin = process.env.DSH_BIN || harnessCli()
  if (!existsSync(bin)) { process.stderr.write(t().noHarness(bin)); process.exit(127) }
  // A DSH_BIN that is this command would call itself forever.
  if (realpathSync(bin) === realpathSync(process.argv[1])) { process.stderr.write(t().selfHarness); process.exit(127) }
  // A script entry (Windows' npm install, where the .cmd shim needs a shell) runs under this node, no shell.
  const run = /\.[cm]?js$/i.test(bin) ? spawnSync(process.execPath, [bin, ...argv], { stdio: 'inherit' }) : spawnSync(bin, argv, { stdio: 'inherit' })
  if (run.error) { process.stderr.write(`dsh: ${run.error.message}\n`); process.exit(127) }
  process.exit(run.signal ? 128 + (constants.signals[run.signal] ?? 0) : (run.status ?? 1))
}

/** This checkout's version, from its package.json two levels above the build (dist/tui/main.js); none if unreadable. */
function ownVersion(): string {
  try { return String(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version ?? '') } catch { return '' }
}

function main(): void {
  const argv = process.argv.slice(2)
  const where = route(argv)
  if (where === 'harness') forward(argv)
  if (where === 'update') process.exit(update(argv.slice(1), updateIO()))
  if (where === 'gateway') {
    gateway(argv.slice(1), gatewayIO()).then(
      (code) => process.exit(code),
      (e) => { process.stderr.write(`dsh gateway: ${(e as Error)?.message ?? e}\n`); process.exit(1) },
    )
    return
  }
  const parsed = parseArgs(argv)
  if ('error' in parsed) { process.stderr.write(`${parsed.error}\n\n${usage()}`); process.exit(2) }
  if (parsed.help) { process.stdout.write(usage()); return }
  if (!process.stdin.isTTY || !process.stdout.isTTY) { process.stderr.write(t().needsTty); process.exit(2) }

  let socketPath: string | (() => string | null) | undefined = parsed.socket
  if (socketPath === undefined) {
    const found = discover(parsed.name)
    if ('error' in found) { process.stderr.write(`dsh: ${found.error}\n`); process.exit(2) }
    socketPath = lookup(found.name, found.socket)
  }

  let connection: Connection | null = null
  let commands: Commands | null = null
  const findFiles = fileFinder()
  const history = historyFile(process.env)
  const app = new App({
    version: ownVersion(),
    intercept: (text) => commands?.intercept(text) ?? false,
    commands: commandInfo,
    files: (query) => findFiles(app.status.workspace, query),
    remember: (text) => appendHistory(history, text),
    stepEffort: () => commands?.stepEffort(),
    branchOf: gitBranch,
    // ctrl+z: stopped as a shell stops a job, and drawn again when it continues. No job control on Windows.
    suspend: process.platform === 'win32' ? undefined : (resumed) => { process.once('SIGCONT', resumed); process.kill(process.pid, 'SIGTSTP') },
    io: processIO(process.stdin, process.stdout),
    env: process.env,
    platform: process.platform,
    backend: {
      send(text, id) {
        const frame: ClientFrame = { type: 'message', text, ...(id !== undefined ? { id } : {}) }
        const sent = connection?.send(frame) === true
        if (!sent) app.notice(tooLarge(frame) ?? t().notSent, 'error')
        return sent
      },
      cancel() { connection?.send({ type: 'cancel' }) },
      withdraw(ids) { return connection?.send({ type: 'withdraw', ids }) === true },
      action(id) { if (!connection?.send({ type: 'action', id })) app.notice(t().notSent, 'error') },
      view(kind, id, owner) { connection?.send({ type: 'view', kind, ...(id !== undefined ? { id } : {}), ...(owner !== undefined ? { owner } : {}) }) },
      agentSend(id, text) { const frame: ClientFrame = { type: 'agent.send', id, text }; if (!connection?.send(frame)) app.notice(tooLarge(frame) ?? t().notSent, 'error') },
      agentInterrupt(id) { connection?.send({ type: 'agent.interrupt', id }) },
      jobKill(id, owner) { connection?.send({ type: 'job.kill', id, owner }) },
      answer(id, answers) { const frame: ClientFrame = { type: 'answer', id, answers }; if (!connection?.send(frame)) app.notice(tooLarge(frame) ?? t().answerNotSent, 'error') },
    },
    onExit(code) {
      connection?.close()
      const resume = connection?.conversation
      if (resume) process.stdout.write(resumeHint(resume))
      process.exit(code)
    },
  })
  connection = new Connection({
    socketPath,
    conversation: parsed.resume,
    tenant: parsed.tenant,
    onFrame: (frame) => bind(app, frame, commands ?? undefined),
    onRollback: (message) => commands?.rolledBack(message),
    onState: (state, detail) => {
      if (state === 'connecting') app.setStatus({ connected: false, link: detail === undefined ? t().connecting : `${t().connecting} · ${detail}` })
      else if (state === 'disconnected') app.setStatus({ connected: false, link: t().disconnected(detail) })
    },
  })
  commands = createCommands(app, connection, { resumeOnStart: parsed.resume !== undefined })
  app.editor.load(loadHistory(history))
  restoreOnExit(app.terminal)
  app.start()
  connection.start()
}

main()
