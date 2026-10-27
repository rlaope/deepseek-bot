# How deepseek-bot works

Reference for people changing or operating it. The [README](../README.md) says what it does; this
says how, with the evidence for each claim. In the code, the plugin, its environment variables and
its services are named `deepbot`.

## Talking to it

| You say | It does |
|---|---|
| `@deepbot …` in a channel, or anything in a DM | answers in the thread, as the persona in `SOUL.md` |
| a follow-up while it is still working | waits, then answers it next — one turn at a time per thread |
| `stop` / `그만` / `停止` | stops the running turn and withdraws what was waiting |
| `usage` / `사용량` / `用量` | token totals for the thread, without starting a turn |
| `allow` / `deny` (`허용` / `거부`, `允许` / `拒绝`), or the buttons | answers its request to run something destructive |
| "what did we decide last time about …?" | recalls past threads **in this channel** and says what they imply |
| "tell me when … changes" | sets up a watch: a command it runs on a schedule, in a read-only sandbox |
| "make the report a docx" | writes the document and uploads it to the conversation |

While it works, the platform's own indicator shows — Slack's working status under the thread,
Discord's and Telegram's "typing…" — and the answer is a new message, so it notifies. On Slack a turn that runs
past a second or two also streams its text into the thread as it is written, which notifies once more; the
answer then comes as a new message and the streamed one is deleted. On Slack the message
that asked also carries a reaction: 👀 when taken, a digit while it runs (a guess from the time a turn
usually takes, held while an approval waits), then ✅, ❌ or ⏹️ (it needs `reactions:write`, and
`reactions:read` to tidy them after a restart). Discord shows the same marks, the digit as a keycap (1️⃣ to 9️⃣;
it needs *Add Reactions* in the channel). Telegram takes one reaction per message from its own short list, with no
digits and no check mark: 👀, then ✍ while it runs, then 👌, 😢 or 🫡. A message that did not mention the bot
gets no mark on any platform.

### Its language

`language` in the deepbot row — `en` (the default), `ko` or `zh` — sets what the bot itself says:
approval requests and their buttons, stop and failure notices, the working message and Slack's
status, the usage report. `dsh`'s own interface — hints, labels, pickers, the status line, what the
gateway answers it — is English whatever the setting, as Claude Code's and pi's are; the bot's notices
in it follow the setting. Any other value is a config error, not a quiet English. It does not set the language of the
answers: the model follows the persona in `SOUL.md` and the person it is talking to.

The words people type are understood in all three whatever it is set to — stop, usage, allow and
deny above — and a one-word message may end in `.`, `!`, `?`, `~`, `。`, `！` or `？`. Recall reads
Chinese, which has no spaces, by overlapping pairs of characters, and the check for text that tries
to give orders knows the three languages' shapes. The installer asks for the language, offering the
environment's. The catalog is `messages.ts`; `test/i18n.test.ts` fails when a language misses a key or
is a copy of another. The terminal's own words, `tui/strings.ts`, are English only.

## What it is

One bundle row in a gateway profile. `index.ts` (built to `dist/index.js`) registers the
adapter; `profile/` is the gateway composition it expects; `service/` wraps both so the thing
survives logout, reboot and a dropped socket.

- TypeScript, built with `tsc`. **The plugin imports nothing from `node_modules`**
  (`docs/harness-api-notes.md` §5 explains why); the one runtime dependency, `playwright-core`
  (pinned), is loaded only by the browse tool.
- MIT. Version 0.2.0.
- Built against DeepSeek Harness `0.2.0-rc.2`. That is a release candidate: session driving,
  message construction and the event fold are recovered from the shipped implementation and
  have no published contract. An upgrade can break this project; pin your version.
- `SPEC.md` is the specification (a draft, with its open decisions marked as such) and `PLAN.md`
  is the milestone record: what is done, what is next, and what is still unverified.

## What it does

Each line is traceable to code and to something that checks it.

| It | Where | Checked by |
|---|---|---|
| Serves Slack over **Socket Mode**: receive, reply in thread, chunk long answers, drop duplicate events, a Markdown table sent as a list (Slack, Discord and Telegram draw no tables) | `transports/slack.ts`, `transports/tables.ts` | `test/tables.test.ts`; `test/slack.test.ts` 115/115; `tools/qa-slack.ts` against a live workspace |
| Serves **Telegram** by long polling | `transports/telegram.ts` | `test/telegram.test.ts` 64/64 |
| Serves **Discord** (gateway websocket + REST), with buttons for approvals | `transports/discord.ts` | `test/discord.test.ts` 55/55 |
| Serves a **terminal** (`dsh`) over a local socket, beside Slack or alone: streamed answers, approval buttons, a turn's questions, its subagents and shells | `transports/local.ts`, `transports/composite.ts`, `tui/` | `test/local.test.ts` 206/206, `test/tui-*.test.ts`; `test/tui-live.ts` 11/11 against a model |
| Keeps a **durable session per thread**, resumed after a restart | `index.ts`, `<stateDir>/sessions.json` | `test/core.test.ts` 490/490; `test/scenarios/restart-1.json` + `restart-2.json` |
| Injects **persona and notes** (`SOUL.md`/`USER.md`/`MEMORY.md` from the adapter, `AGENTS.md` from `dsh-agent-instructions`), without re-sending them every turn | `index.ts` | `test/core.test.ts`; `test/scenarios/persona.json` 4/4 |
| **Recalls past conversations** — rank passages and have the conversation's model choose among the latest, then ask for what they imply | `recall/`, `recallContext.ts` | `test/recall.test.ts`; `test/recall-context.test.ts`; `test/scenarios/recall-near.json` |
| Reads the **thread it was mentioned in**, as a delta | `transports/slack.ts` | `test/history.test.ts` 9/9 |
| Sends an attached **image** to the model as an image | `transports/attachments.ts`, `index.ts` | `test/attachments.test.ts` 13/13; `vision.json` needs a model |
| Produces **documents** (docx, pptx, xlsx) | `profile/cordis.patch.yml` office rows | `test/scenarios/document.json` asserts the artifacts |
| Uses the tools of **MCP servers** the profile composes, through the harness's own MCP client | `profile/cordis.patch.yml`, `docs/setup.md` | `test/scenarios/mcp.json` against a real model |
| Asks the user to **approve** a destructive command, in the conversation — with buttons on every platform | `index.ts`, `transports/*.ts` | approval checks in `test/core.test.ts`; `approval-gate.json` runs the gate against a real model |
| Confines **reads**, for commands and for the file tools — other agents' homes, the harness home (credentials, sessions and their index, the adapter's state, attachments, reminders; all but its runtimes), the gateway's logs, the user's agent sockets | `service/confined-runner.sh`, `readScope` | `test/confined-runner.test.ts` 212/212; `test/edges.test.ts` 41/41 |
| Flags **instruction-like text** in fetched material | `injection.ts` | `test/injection.test.ts` 37/37 |
| **Uploads the documents a turn made** (pdf, docx, xlsx, pptx, csv changed during the turn, whose path the answer names, with one link and inside the home; on Slack it needs `files:write`) | `index.ts`, `transports/*.ts` | `test/core.test.ts` 490/490; `test/slack.test.ts` |
| Runs **one turn at a time per conversation**; a later message waits, and a stop withdraws what is waiting | `index.ts` | `test/failures.test.ts` 58/58 |
| Shows it is **working at once** with the platform's own indicator (Slack's thread status, typing elsewhere), or a progress message where that is refused | `progress.ts`, `index.ts` | `test/progress.test.ts` 29/29; `test/core.test.ts` |
| **Stops** a running turn on request, and on its own timeout | `index.ts` | `test/scenarios/interrupt.json` |
| Reports **token usage** without starting a turn | `usage.ts` | `test/usage.test.ts` 21/21 |
| Delivers **reminders** and **watches** — speaking first, but only when asked to; a watch the agent wrote runs read-only in the sandbox | `watch/`, schedule bundle | `test/watch.test.ts` 22/22; `test/delivery.test.ts` 9/9 |
| Publishes **health** so an external probe can restart a disconnected bot | `service/health-check.ts` | `PLAN.md` M3: injected unhealthy state → restart → recovered |
| Gives each conversation group its own **workspace** (tenants) | `index.ts` | tenant checks in `test/core.test.ts`; `test/scenarios/tenant.json` |
| Prunes its own bookkeeping so a long-running process does not grow forever | `index.ts` (`stateRetentionDays`) | `test/resources.test.ts` 8/8 |

## Does it work? How to read the claims

Three kinds of evidence appear in this repository, and they are not equivalent:

1. **Unit suites** (`pnpm test`) drive `apply()` against mocks — a fake context, fake transports,
   fake Slack/Discord/Telegram APIs. No harness install, no network, no account. They run in CI.
2. **Scenarios** (`test/run-scenario.ts`) boot a real profile and call a real model. They prove
   behaviour, and they need a model credential, so **CI does not run them**.
3. **Live checks** were made against a running deployment and are recorded here, in `PLAN.md`, or
   in a code comment with the measurement next to it.

The last full run of `pnpm test`, on 2026-10-27 (macOS, Node 26.7.0): **2,882 checks in 37 suites,
exit 0**, plus the `dist-fresh` build guard and a secret scan. Per-suite counts quoted elsewhere on this
page are from the 2026-10-27 run. CI runs the suites on Node 22 with
`pnpm run typecheck` in front of them.

| Area | State |
|---|---|
| Slack Socket Mode, threads, chunking, dedupe | verified unit + live |
| Telegram | implemented, with buttons, uploads and Markdown; unit 64/64; **live round trip not done** (needs a bot token) |
| Discord | implemented, with buttons and uploads; unit 55/55; **live round trip not done** (needs a bot token) |
| Durable sessions, resume across a restart | verified (scenario: two processes) |
| Cross-session recall, injected as a decision block | verified unit; `recall`, `recall-immediate` and `recall-decision` scenarios pass against a real model |
| Persona/notes budgets, note hygiene | verified unit |
| Images | implemented; the end-to-end scenario needs a model that accepts images |
| Documents | implemented; the scenario asserts the produced files |
| Approvals over chat | answerer and buttons verified unit; the destructive-command gate is **open end to end** (below) |
| Read confinement | implemented; a **policy** boundary, not a kernel one |
| Watches, reminders, health probe | verified unit; health restart verified against an injected failure |
| Streaming tokens into Slack | implemented: the turn's text streams into the thread (chat.startStream / appendStream), and the answer is posted new while the streamed message is deleted; unit-checked against a stubbed Web API, its calls shaped by a live probe; a refusal falls back to the answer arriving whole |
| Semantic recall | **by the conversation's model, over the latest passages** — a message that points at the past has the model choose, from the channel's latest passages (`recallPickFrom`, 40), the ones about it, and ranks the rest by words and the words the model relates to it; older passages are matched by words only. No vector index |
| Browser automation | implemented as a command the agent runs (`dist/tools/browse.js`): a page drawn by JavaScript, typing, clicking, a screenshot; checked against a real browser and a real model |
| Per-tenant *permission* preset | **not a setting** — removed; a tenant's `permission` imposes nothing (`test/core.test.ts` checks it) |

## How it works

### The transport seam

One core, one transport per platform. The core (`index.ts`) owns thread→session mapping, the turn
loop, the channel allowlist, prompt assembly, watches and reminders; a transport owns credentials,
the connection, event parsing, rendering, history and attachments. The interface is
`types/transport.ts`: `connect({ onMessage, onStatus, onAction })`, `post(target, text, { replace,
buttons })`, `fetchHistory`, `fetchAttachments`, `identity()`, optional `permalinkFor`,
`uploadFile`, `startTyping` and `remove`, and a `supportsButtons` flag the core reads rather than
assumes.

`platform: 'slack' | 'telegram' | 'discord' | 'local'` selects one, or a list of one messenger and
`'local'` (the terminal); anything else is a config error at load. `test/fake-transport.ts` supplies
another, which is how the core is tested with no platform account at all.

### Sessions

`channel:thread_ts` is the key; it maps to a session id persisted in `<stateDir>/sessions.json`.
A turn is `agents.resume(sessionId)` when there is one and `agents.create(...)` when there is not,
followed by `followup(...)`, `whenIdle()`, `sessions.flush()` as a durability barrier, then the
last assistant text is read out of the session log and posted. `reason.kind === 'completed'`
decides success; anything else is reported into the thread, so a failed turn never looks like a
silent one.

**An agent is released after its turn, unless it owns a background job.** A command the agent runs in the
background (`run_in_background`, or a foreground one moved there on its timeout) belongs to the live agent, and
the jobs service stops an agent's jobs when the agent is disposed. So an agent that still owns a running or
stopping job when its turn ends is kept, by session. When the job settles, dsh-tool-jobs wakes the idle agent with
its notice and the harness runs that turn itself; its answer is delivered like a reminder's (an assistant message
on a mapped session outside the adapter's running turns), and once the agent owns no live job and is idle again
it is released. The adapter's subscription (`jobs.events`, `{ owners: 'all' }`) is unscoped, so it hears a
settlement before dsh-tool-jobs' scoped one wakes the agent in the same dispatch: the wait for the agent starts
after that dispatch; it is bounded by `runTimeoutMs`. A job that settles while the turn's log is flushed wakes the
agent after the turn's last wait: an agent found running then is kept for that turn too. While kept, the agent
holds the session's writer, so the conversation's next message is not a resume: the turn runs in the kept agent,
which stays out of the running turns until its message goes, then waits for any woken turn running there (whose
answer is delivered as the agent's). A kept agent's woken turn belongs to its conversation even before the session
is mapped to it (a turn past the queue's backstop never is): its tools are gated, its approvals asked and its
answer posted there. A kept agent is released, which stops its job, `backgroundKeepMs` (30 minutes) after it was
first kept, whatever turns ran in it since (the conversation is told which job; a woken turn still answering, its
job done, is let finish), when a stop is said in the conversation, and when the plugin unloads. At most
`maxKeptAgents` (4) are kept; past that a turn's agent is released as before and the conversation told after the
answer. Either setting at 0, or no jobs service: nothing is kept and the identity section does not mention it.

Two facts that will bite: a session is composed with an **agent preset**, and without one the
agent has no tools at all — that failure was silent and looked like a memory bug for days. And
resume is bound to the recorded working directory, so moving the agent home orphans every old
thread.

### Who the agent is told it is

The harness's preset says only "You are a coding agent powered by the {{model}} model". Every session's
`setup` adds a section of the adapter's own to the system prompt (`deepbot:identity`, order 10: after
the preset's persona prefix, before plan and tool guidance, scoped to that agent): that it is
deepseek-bot on DeepSeek Harness, whether this conversation is on Slack, Telegram, Discord or in the
terminal, the language of the bot's own notices, what it may change itself (the persona files, its
notes, its watches, its skills under `.dsh/skills/`) and what only the operator can (the model and
provider, platforms and channels, the language, keys and tokens, approval rules, the sandbox) —
which it names and points to (`~/.dsh/profiles/<profile>/cordis.patch.yml`, `~/.dsh/.env`) rather
than trying. The name and voice stay the persona's (`SOUL.md`).

**Skills.** The harness lists skills from `<project root>/.dsh/skills` and `.agents/skills` (the
project root is the nearest `.git`, else the agent home), `~/.dsh/skills`, and `<agents home>/skills`.
The last is `~/.agents` by default — the operator's own coding agents' skills — so the launcher sets
`DSH_AGENTS_HOME` to an empty directory of the bot's own (`~/.dsh/deepbot/agents-home`). A skill the
agent writes goes in `.dsh/skills/<name>/SKILL.md` in its home; `skills/` was never read.

### Prompt assembly, and why the standing block is digest-gated

Prompt caching reuses a stable prefix, so anything that changes early in the prompt throws away
everything after it, and anything repeated every turn is paid for every turn. Two rules follow.

**Standing context goes in once.** `AGENTS.md` is injected by `dsh-agent-instructions`, which
appends it as one durable baseline and adds only deltas. Re-injecting it per turn duplicated it —
measured at 7,625 characters per turn on top of the harness's own 3,634.

`SOUL.md`, `USER.md` and `MEMORY.md` are **not** read by that loader, whatever a profile says: the
instance that runs is mounted inside the `standard` agent preset with the default candidates
(`AGENTS.md`, `CLAUDE.md`), and the top-level `agent-instructions` row a profile can patch is
disabled. This README used to say otherwise, and from 2026-10-10 to 2026-10-13 the live bot ran
without its persona — asked "how can I use you, <name>?", it wrote a message *to* <name> instead of
answering. The adapter now puts those three files at the top of its own standing block (below), so
they are sent once per conversation and again only when they change. `test/core.test.ts` checks
they reach the model and `AGENTS.md` does not go twice; `test/scenarios/persona.json` checks it
against a real model, with file tools forbidden so the model cannot read `SOUL.md` itself.

**Only the changing part is dynamic.** The adapter's own block — where this conversation is, which
directory is writable, which notes exist, whether the notes need tidying — is hashed (SHA-1, per
session) and sent only when its content changed. Thread history is a delta: only what has not been
delivered yet. The recall block is built per turn and never placed in the standing part, for the
same cache reason.

The adapter logs what it assembled, so this is inspectable rather than inferred:

```
context injection: standing block 217 chars; instruction files present: SOUL.md, AGENTS.md, USER.md, MEMORY.md
```

A home with none of those files logs a warning, because then the agent has no standing context at
all — which is otherwise silent. Three turns of one conversation, from a live run's log:

```
tokens: input 13416 (0% cache-read) uncached 13416 output 112
tokens: input 29458 (45% cache-read) uncached 16146 output 131
tokens: input 48031 (61% cache-read) uncached 18847 output 139
```

Each turn adds roughly 2.7K uncached tokens; the prefix before it is served from cache. The
numbers come from the harness's `tokenUsage` session projection, and are printed after every turn.
They are one run's record, not a benchmark.

### The recall index

The harness gives memory a real substrate: an append-only, event-sourced session log. This repo
wires up what it does not turn on by default, and adds the consumer the agent plane was missing.

- `dsh-base` ships session full-text search **off** (`path: ':memory:'`, `openAt: never`).
  `profile/cordis.patch.yml` opens it on a real file at startup. The agent plane still gets no
  tool and no injected context from *that* index — its consumers are the web UI and the
  `@session` reference source.
- Recall instead reads a plain-text index of past messages, `~/.dsh/recall/<home>/recall-index.jsonl`,
  built by `recall/deepbot-recall.ts` (CLI: `index`, `search`, `recent`, `show`, `sessions`). The
  host builds it and **only the adapter reads it**: it lives outside the agent's home, and the
  sandbox runner and the tools' read scope both deny it, so the agent receives past conversations
  only as the injected block — one channel at a time. It used to sit in the agent's home, where the
  agent could read every channel's history with its own tools.
- The index is refreshed after **every turn** (`autoIndex`, default on). Measured: the indexer
  costs about 0.4 s for 61 session logs, which is affordable; a ten-minute window made "what did
  we just discuss?" fail in exactly the situation it is asked. `recall/install-refresh.sh`
  installs a launchd job that rebuilds it on an interval anyway, as a backstop.
- **Recall stays in its channel.** Each row records the channel its session belonged to, read from
  the adapter's own `[this conversation]` block (never from what the user typed after the marker).
  The block injected into a turn ranks only rows from that turn's channel: a DM's passages surface
  only in that DM. A row the indexer could not place takes its channel from the adapter's session
  mapping when the session is still mapped, and is left out otherwise. Before this, one shared word was
  enough to put a DM into a public channel's answer. A turn with no conversation (a scenario) is not
  filtered.
- **Ranking weighs words by how rare they are** (IDF), strips Korean particles from the question, and
  leaves out the conversation being answered. A message that points at the past ("지난번…", "before")
  gets the best matches; one that does not gets them only when a passage shares at least two rare
  words with it — so "did anyone say 테스트-1234?" is answered, and an ordinary message is not
  interrupted. Lexical still, with one widening: a message that points at the past, when its channel has
  anything to recall, asks the conversation's own model (reasoning off where it can be, and then a short answer) for
  related words. Each line of the answer is matched whole, a common one or a number is dropped, and only the
  best match counts, for half a word of the person's own. The turn waits for it at most `recallExpandMs`
  (4 s); a failure or a timeout is logged and recall goes on by the message's words alone.
- **And the model chooses.** With the related words, in parallel and under the same deadline, the
  conversation's model is shown the channel's latest passages (`recallPickFrom`, 40; each cut at 200
  characters), numbered, and asked which are about what the message asks: numbers only, at most four.
  Only a first line of numbers counts, only numbers it was offered, and its choice comes first in the
  block, leaving the passage that shares the most words its place. Matched by words alone, a past put in
  words the message shares none of was outranked by passages on the same subject that only shared
  surface words: on four facts each said among five newer near misses in the same words
  (`test/scenarios/recall-near.json`), words alone answered 4 of 8 over two runs and with the choice 8 of
  8 (one route, a small sample). It costs a second model call for such a message, with up to 200
  characters a passage: up to about 8,000 characters at 40, a few thousand tokens. Older passages are
  still matched by words only. `recallPickFrom: 0` turns it off; 200 is the most.
  `test/recall.test.ts`, `test/recall-context.test.ts`, `test/core.test.ts`.

## Memory: the layers, and who writes what

| Layer | Where | Who writes it | When the agent sees it |
|---|---|---|---|
| Working | the current session log | the harness | always |
| Identity | `SOUL.md`, `AGENTS.md` | you (scaffolded by the installer) | every turn |
| Semantic | `USER.md`, `MEMORY.md`, `memory/<topic>.md` | the agent, under the rules in `agent/AGENTS.md`; you may edit them | every turn |
| Episodic | `~/.dsh/recall/<home>/recall-index.jsonl` | the host-side indexer; only the adapter reads it | when a message points at the past or closely matches |

All four files in the agent home are read at the start of **every** turn, in this order, with
these budgets:

| File | What it holds | Budget | Changes |
|---|---|---|---|
| `SOUL.md` | identity and voice | 6,000 chars | rarely |
| `AGENTS.md` | operating rules | 12,000 chars | when a rule is wrong |
| `USER.md` | durable facts about the user | 4,000 chars | as you learn them |
| `MEMORY.md` | durable facts about the work | 4,000 chars | as you learn them |

An over-budget file is **truncated silently**: the tail simply stops being part of the prompt,
with nothing logged. `tools/persona-check.ts` exists for that — it reports the exact overflow,
warns when the same fact is written into two files (it would be injected twice), warns about
undated lines, and refuses on a secret, which would otherwise be in every prompt and every
session log.

```bash
$EDITOR ~/dsh-agent/SOUL.md                             # make it yours
node ~/.deepbot/dist/tools/persona-check.js ~/dsh-agent # budgets, duplicated facts, secrets
```

Note hygiene is deliberately small: `notes.ts` counts characters and repeated lines and asks the
model to consolidate, because merging notes needs intent. Past `notesBudgetChars` (6,000) or on a
repeated line it adds the advice to the standing block — which is digest-gated, so the request is
sent once and then cached. The log line `notes: consolidation advice added (N chars)` is the
deterministic signal a scenario asserts on.

## Approvals over chat

A transport that can render buttons gets them — Discord posts an action row and the decision is
made in place — and one that cannot gets the instruction to reply `허용` / `거부` in the thread,
which is the same decision by a slower route. `supportsButtons` on the transport says which; the
core asks and the transport decides. Only the requester's answer counts by default
(`approvalRequireSameUser`), because a thread is shared. An unanswered request is cancelled after
`approvalTimeoutMs` (ten minutes), and a turn is cancelled by its own timeout regardless
(`runTimeoutMs`, fifteen minutes).

The answerer, the buttons, the timeout and the same-user rule are unit-verified in
`test/core.test.ts`. Two things are honestly less than that:

- **The shipped profile fails closed.** `defaultPreset: unattended` is
  `{ sandbox: workspace-write, approval: never }`: an escalation is refused rather than asked,
  because there is nobody to answer. To answer in chat you need both halves — a preset with
  `approval: ask`, **and** `- id: api-remotes` / `disabled: true`. `dsh-api-remotes` registers its
  `approval/request` forwarding listener per connected client stream; on a headless gateway that
  listener holds the request, the session records `approval/asked` and never `approval/decided`,
  the waterfall never reaches the adapter's answerer, and the turn waits for the timeout.
  Measured: with it composed the same scenario hung and was cancelled fifteen minutes later; with
  it disabled the request reached the answerer and the turn completed (`PLAN.md`).
  `pnpm test:profile` checks the pair, because getting one half right is a hang, not a mistake.
- **The destructive-command gate reaches its answerer.** The adapter also gates commands the sandbox
  permits inside the workspace (`approvalPatterns`, default `['rm ', 'rmdir ', 'sudo ', 'dd if=',
  'mkfs', 'shutdown', 'reboot', 'kill -9']`), because deleting the agent's own notes is legitimate
  and irreversible. The harness dispatches `approval/request` on the agent's own scope; the adapter's
  answerer is registered on the root scope, and receives it. `test/scenarios/approval-gate.json`
  shows it with a real model: the gate asks, the request reaches the answerer, which cannot reach a
  platform in a scenario, fails closed, and the request is refused at once; the file survives and the
  turn ends without waiting. Pressing a button in a real conversation is unit-verified only (`PLAN.md`).
- **A tool named in `askTools` is asked for on every call.** An MCP server's tools pass the patterns above,
  which read a shell command, and every other gate; a server that sends mail or changes a calendar acted on
  the model's word alone. `askTools` names such tools (`mcp__google__send_gmail_message`, or
  `mcp__google__manage_*` for every tool that starts so), and each call goes through the same approval,
  in the conversation the turn belongs to: found, for a conversation's first turn, by the turn's own origin
  (the destructive-command gate looked in the saved state alone, so a first turn's command ran unasked).
  The question shows every argument, the short ones first, each cut at 200 characters with the cut said;
  arguments too long to show whole, or a turn that belongs to no conversation, are refused, since nothing
  else confines such a tool. What an approval shows is made inert first: `<` and `>` become `‹` `›` and
  `@` before a word is broken, so a `<!channel>` or `@everyone` in a call's arguments pings nobody. Empty by
  default. `test/scenarios/mcp-ask.json` checks it with a real model: the fixture's
  `vault_store` writes a file only the server can write; with `askTools` naming it the call is refused and
  the file never appears, and without it (the control, run by hand) the file is written.

## Read confinement

The harness sandbox fences **writes**. Its macOS profile is allow-default with
`(deny file-write*)`, so a command an agent runs can read anything the user can — another
instance's home, a retired bot's token file. Measured: unwrapped, the agent read a canary from a
different agent's directory and answered with it.

Two surfaces, two mechanisms:

**Commands** run under `service/confined-runner.sh`, which replaces the sandbox runner. It
implements the harness's own policy arguments (workspace-write keeps the workspace and temp
writable; read-only denies all writes) and adds read denials for the other instances' homes, for
retired bot data, and for the user's credentials: `~/.ssh`, `~/.aws`, `~/.gnupg`, the keychain files,
`~/.config/gh`, `~/.config/gcloud`, `~/.azure`, `~/.kube`, `~/.netrc` and `~/.git-credentials` (the
ssh-agent socket alone was refused before, and the key files were one `cat` away), and the token files of
package registries, containers, databases, infrastructure tools and other agents' CLIs: `~/.npmrc`, `~/.pypirc`,
`~/.docker/config.json`, `~/.cargo/credentials.toml`, `~/.pgpass`, `~/.vault-token`, `~/.codex/auth.json`,
`~/.claude/.credentials.json` and the others in the runner's `credential_files` (a command read `~/.npmrc` in a QA
run, and its token went to the model). The rules are written whether or not a file is there yet, so one made by a
login while a command runs is refused too. npm and cargo run without theirs, as without the file, and Hugging
Face's library, which raises on a token it may not read, is pointed at a name that is never there; Vault and
Terraform were not run with theirs refused. A private registry's login is the agent's own to set up, in its home.
A copy beside one (`~/.npmrc.bak`) is not refused. A tool that needs
one of those fails: the agent's credentials are its own, in its home. Keychain items in an unlocked
login keychain still reach a command through `security` and git's osxkeychain helper, which talk to the
system's keychain service rather than read the files. Nor is the user's desktop the agent's: a command
cannot script or start another app (`osascript`, `automator`, `shortcuts`, `open`), compile a script into an
app that would (`osacompile`), take the screen (`screencapture`), or read or replace what the user copied,
often a password (the pasteboard service is closed). The clipboard and the screen were open to commands in
every mode before, and other apps unless the network was bounded. A copy of one of those tools is killed by
macOS; a program compiled to send Apple Events or take the screen itself is not stopped, though macOS's own
permissions for each app and for the screen still apply to it. LaunchServices is closed in every mode, so no
command can ask it to start an app, and which apps the user has open is not seen (found by the final review). Temp is `/tmp` and a directory of the workspace's own inside the user's temp
(`deepbot-cmd-<hash>`, made by the runner, never a link), where it points `TMPDIR`; the user's temp
itself stays closed, since unconfined processes keep scripts and sockets there. Another workspace's
temp directory cannot be read: a tenant's temp files are its own. macOS's `mktemp`
with no template writes to that closed directory: a command names `$TMPDIR` (`mktemp
"$TMPDIR/x.XXXXXX"`), as Node and Python do on their own.
Package managers' caches get a directory of the workspace's own in the user's cache directory
(`/var/folders/…/C/deepbot-cache-<hash>`, made and closed to other workspaces, and to read-only commands, as the
temp one is; not in temp, where macOS deletes files unused for days, which could leave a uv or go entry half
there): `npm_config_cache`, `pnpm_config_store_dir`, `PIP_CACHE_DIR`, `UV_CACHE_DIR`, `XDG_CACHE_HOME`,
`GOCACHE`, `GOMODCACHE`, `BUN_INSTALL_CACHE_DIR`, `YARN_CACHE_FOLDER`, `YARN_GLOBAL_FOLDER`, `COREPACK_HOME`,
replacing whatever was given: in the user's home a command cannot write them, and in the project they would land
in a commit. Not covered, because npm warns on every command about an `npm_config_*` it does not know: pnpm
before 11 (`npm_config_store_dir`) and node-gyp's headers (`npm_config_devdir`), so a native module with no
prebuilt binary still fails until `~/Library/Caches/node-gyp` has that Node's headers; nor Playwright's,
Puppeteer's, Cypress's or Electron's downloads. What a tool keeps under `XDG_CACHE_HOME` in the user's home
(Hugging Face models, for one) is not seen, and is fetched again. The directories are never pruned: clear one
with `rm -rf` (Go's module cache is read-only: `chmod -R u+w` it first). A watch, which runs read-only, reads
neither the temp nor the cache directories, its own home's included. The agent is told which sandbox its
commands run in, and that a write it refuses is the sandbox, not a file's owner.

```yaml
- id: sandbox
  config:
    runnerCommand: ['/absolute/path/to/service/confined-runner.sh']
    runnerFailureSignatures: ['confined-runner:']
```

Wrapping the *gateway* in such a profile does not work and is not what this does: macOS refuses
nested `sandbox-exec`, so the harness's sandbox probe finds no usable backend and refuses to run
commands at all. `service/write-read-profile.sh` is kept as reference for that approach and is
deliberately **not** installed. (`service/run-gateway.sh` will still use a profile if you put one
at `$DEEPBOT_READ_PROFILE`; nothing in this repository generates it.)

**File tools** are fenced at the harness's tool gate:

```yaml
- id: deepbot
  config:
    readScope: true                                        # default
    readScopeTools: [read, read_image, grep, glob, str_replace_editor]
    readScopeRoots: []                                     # default: workspace + temp + tooling
```

A read outside those roots is asked for (`readOutside: ask`, the default): the turn holds, and the
conversation gets an approval request naming where the read lands (a link with its target: a link the
agent made in its home to one of the user's files read as its own draft, found by review), answered
with the same buttons as a destructive command. It is refused, with a reason the model can act on
("ask the user to put the file there, or to paste its contents"), when it is a credential (the list
above, the harness home, a file named `.env…`), in a place `DEEPBOT_DENY_READ` names, or a folder
holding one (a search above `~/.config/gh` read its token), judged where it really is; when the turn is
a tenant's, its first turn included (its directory is its boundary); when no conversation can be
asked; and always with `readOutside: deny`. The editor's commands but view are writes, and one outside is
refused, never asked about as a read. The agent's commands read an ordinary file outside without asking, as before:
the runner refuses the places above, not the user's documents; `DEEPBOT_DENY_READ` adds places.
Writing outside the workspace is not possible either way: the agent writes in its home, and the
person copies. Symlinks are resolved when the path exists, so a link
inside the workspace that points outside it does not count as inside (`test/edges.test.ts` pins
that with a symlink to `/etc/hosts`), and with tenant isolation on, the readable roots follow the
**speaking conversation** rather than the shared home.

This is a **policy** boundary, not a kernel one: the tool list has to grow with the composition,
and a tool that reads files another way would not be covered. One OS user per instance remains the
stronger answer, and is not built.

## Images

A picture that arrives as an attachment reaches the model **as a picture**. The transport
downloads it into the agent home, the core admits it through the harness's attachment service
(`ctx.attachments.saveImages`), and the prompt carries
`[{ type: 'text' }, { type: 'image', attachment: ref }]`. The service validates and normalizes
before the message is accepted, and the route projection happens in the llm adapter — for
image-capable models only, so a text-only deployment degrades to a filename rather than failing.

**The model has to declare that it accepts images.** Without this the model is handed a text
descriptor instead:

```yaml
# your provider's model entry — note `input`, not `inputModalities`
- id: deepseek/deepseek-v4.1-flash-ultrafast
  input: [text, image]
```

`inputModalities` is accepted by the config schema and **ignored by the resolver**, which reads
`declaredInput(entry.input) ?? base?.input ?? request.defaultInput`. A wrongly named key fails
silently, which is how it was found.

`test/scenarios/vision.json` is the end-to-end check: a solid-colour PNG from `test/fixtures/` is
attached and the assertion is on the colour — a fact nothing in the prompt reveals, so the answer
can only come from seeing the image. It needs a model credential.

## Documents

The product ships documents to users, so the agent must be able to produce files, and out of the
box it could not: `dsh-skill-office` is a plain package that no shipped bundle mounts. The
profile inserts two rows — `skill-office` (registers `office-docx`, `office-pptx`, `office-xlsx`
and appends the absolute LibreOffice Kit paths) and `tool-workspace-dependencies` (tells the agent
where the bundled Python lives). The second is required for the first to be usable: the office
provider ships instructions only and does not install the authoring libraries.

`test/scenarios/document.json` asserts on the artifacts rather than the answer: ZIP magic, an
inner OOXML path, and the text inside the package. A model describing a document it never wrote
reads exactly like one that did.

## Opening a link

The agent has the harness's `web_fetch` tool, so a URL in the conversation is something it can
actually read, and it is expected to say where it read it. `web_fetch` opens public addresses only:
the harness refuses a loopback or private one. `test:scenario:browser` serves its page on
127.0.0.1 and asks for a fact that appears nowhere in the prompt: the answer carries both the fact
and its source. The standing block tells the agent that such a page opens with the browse tool.

What each way of reaching an address may reach:

| | a public address | this machine, the local network, carrier-NAT ranges (Tailscale's among them) | a cloud metadata service |
|---|---|---|---|
| `web_fetch` | yes | no: the harness refuses it | no: the fetch gate refuses it by name (`fetchPolicy`, on by default), and the harness refused it live as a non-public address |
| the browse tool | yes | only from a page that is itself there (every address its name resolves to is private) | never |
| the agent's commands (`curl`, a script), `commandNetwork: open` (the default) | yes | yes | yes |
| the agent's commands and the browse tool, `commandNetwork: local` | yes, through the gateway's proxy | yes, through it | no (but see Apple Events, below) |
| the agent's commands and the browse tool, `commandNetwork: public` | yes, through the gateway's proxy | no, this machine's own services included (but see Apple Events, below) | no (but see Apple Events, below) |

The browse tool's rule is the one a page needs: an intranet or dev-server page works, and a public
page cannot reach into this machine or its network; a name that resolves to any public address counts
as a public page. With `commandNetwork` bounded, the browse tool runs as a command like any other: its
browser goes through the commands' proxy, under that proxy's rule, and the tool runs none of its own (the
sandbox would not let the browser reach it). So with `public` no page reaches this machine or its
network, and with `local` any page may, as the agent's commands may. The runner names that proxy to the
tool as `DEEPBOT_COMMAND_PROXY`, set by it alone; a proxy of the user's own on this machine, named in
`https_proxy`, is not taken for it (taken, it left the browser with no policy: found by the final review).

**The agent's commands' network (`commandNetwork`).** The sandbox runner confines what commands read
and write; by default it leaves where they connect to the user's machine, so on a cloud host a command
could ask the metadata service for the host's credentials. With `public` or `local`, the gateway runs a
proxy of the browse tool's kind (`netPolicy.ts`: the address it connects to is the one it checked;
metadata never; private addresses only with `local`), logs what it refuses without a request's query
(`command network: blocked …`), and writes where it listens to
`~/.dsh/deepbot/command-network/<the agent home's real path, hashed>.json`, which the agent's commands
cannot read or write. The runner reads that file at every command: it adds Seatbelt rules that refuse
every outbound connection but one, to the proxy's port on this machine, and points the command at the
proxy in every spelling the common tools read (`http_proxy`, `HTTPS_PROXY`, `ALL_PROXY`, and
`NODE_USE_ENV_PROXY=1` for node), with nothing exempt: a request for this machine goes through the
proxy as well, which decides by its mode. Not every port here is open: with them open, a command
reached a local page around the proxy, seen live with `public`. `curl`, `git` over https, `pip`, `npm`
and node's `fetch` go through it; what ignores a proxy (ssh, a raw socket, UDP, a database client to a
local server) reaches nothing: Seatbelt refuses it at once (`EPERM`). It lives as long as the gateway,
so it keeps a name's answer for a minute (a failed lookup for five seconds, a thousand names at most),
closes a tunnel whose client is gone or that carries nothing for fifteen minutes, and holds at most 256 open
at once, refusing the next (found by the final review: kept for good, each grew in the gateway). Two other ways around it are shut
(found by review): the system resolver's socket, since a name looked up carries data out in its labels,
and other apps, which run outside the sandbox: LaunchServices is closed and `open`, `osascript`,
`automator`, `shortcuts` and the other tools above do not run, in any mode. A program compiled to send Apple
Events itself is not stopped. With `local`, a command reaches this machine's services through the proxy, the
harness's own web port among them, which answers nothing without its token (seen: 401), and the token is kept
under the harness home, which commands cannot read. A watch the agent wrote runs under the same runner, so
with the network bounded it goes through the gateway's proxy too, and has no way out while the gateway is
stopped.
The gateway writes the file closed (no port) before its proxy listens and again when it stops, and a
file whose gateway is no longer running names no port to the runner: a file that is not there leaves
commands open, so it is never removed while bounded, and a port a crashed gateway left may be another
program's by then. An `open` gateway removes a file left behind, unless another running gateway holds
it. The file is keyed by the agent home, so a tenant's commands are held with the home's; MCP servers
and the harness's own tools are not the agent's commands and are not held.
`test/confined-runner.test.ts` checks the rules, the environment (an exemption the caller set dropped),
a refused direct connection elsewhere and to another local service, a lookup and an app script refused,
a gone gateway's port not used, and a garbled or linked file;
`test/core.test.ts` checks that each mode's proxy refuses what it should, logs it (at most twenty a
minute), that stopping leaves the file closed, that `open` removes a file left behind but not another
running gateway's, and that a home the runner will not look in is said; `test/browse.test.ts` checks that the browser goes through the commands'
proxy and its refusal is said as the agent's network; `test/scenarios/command-network.json` has a real
model fetch a page on this machine with `curl` under `public` and never get it.

`web_fetch` is an HTTP fetch — no JavaScript runs, nothing is clicked — so a page that draws its
content with a script arrived empty. Search is composed separately (`dsh-web-search-deepseek`) and
needs `DEEPSEEK_API_KEY`.

**For such a page there is a headless browser: `dist/tools/browse.js`.** The adapter offers it in
the standing block as a command, with this process's node and the checkout's script by absolute path,
when the script and `playwright-core` are in the checkout (`browse: false` offers nothing). The agent
runs it with its shell:

```
'<node>' '<checkout>/dist/tools/browse.js' '<url>' [--type <selector> <text>]... [--click <selector>]... [--screenshot page.png]
```

It opens the page in Chromium's headless shell, lets it settle, does the steps in order, and prints
the title, the address the page ended at and its visible text (20 000 characters unless `--max`
says otherwise). A step that finds nothing fails the run and still shows the page. It runs under
the agent's sandbox like any other command, so the browser writes only where the agent's commands
may. On top of that it opens only `http` and `https` pages and downloads nothing, and the browser
sends every request through a proxy inside the tool (`netPolicy.ts`). The proxy resolves the name,
judges the address and connects to the address it judged, keeping the answer for the run (a name that
answers differently the second time reaches nothing new). A cloud metadata service is refused always;
a private address (this machine, the local network, a VPN's carrier-NAT range) only when every
address the page's name resolves to is private, so a dev server or an intranet page works and a public
page cannot reach into either (a name with one public address among private ones is a public page). Because the browser sends everything through it, this covers each hop of a redirect, a
frame, a window the page opens and a socket; intercepting the page's own requests saw the first request
of a redirect and none of a popup's. What it refused is listed under the page's text. A page that
answers with an error status fails the run, and the run's work stops at 75 s with what the page showed
by then printed. `test/net-policy.test.ts` checks the addresses and the proxy; `test/browse.test.ts`
checks the tool against a real browser where one is installed (a page drawn by a script, typing and
clicking, a redirect, a frame, a popup and a socket toward the metadata service, a request its server
never answers, a screenshot) and says so where one is not; `test:scenario:browser-js` has a real model read a codename the page fetches after load and a
deadline it fetches only when a button is pressed, from a server that answers only a browser
(`test/fixtures/page-server.mjs`): neither is in the page's source, and curl gets a refusal. After
each step it waits until nothing has been in flight for half a second, so a result that arrives by
request is read once it has come.

**A site that needs a sign-in** is reached through a session you keep for it. You sign in once, in a window,
with `browse.js --login '<url>' --state <workspace>/.browser/<name>.json`, run in your own terminal; the tool
keeps the session (its cookies and site storage) in that file, mode 600, when the last tab is closed or ctrl+c
is pressed (the window's browser is launched without Playwright's own signal handlers, which closed it before
the session was read; it is also read as it changes). The standing block names the files in the conversation's
workspace's `.browser/` (plain `.json` names only), and the agent adds `--state <file>` to browse as that
account. A run that went through writes the file back, so renewed cookies are kept, the one before as
`.prev`; a failed run leaves it alone, and a run that ends signed out says so. The file is written to a fresh
file and renamed over its name, and a path that is a link or in a linked directory is refused: the agent can
make links in its workspace, and `--login` writes as you (found by review: a link made a run overwrite the
file it pointed at). A file that is not a session is refused, not read as an empty one and written over. A
tenant's sessions are in its own directory, and only its own are named to it. `test/browse.test.ts` checks
the keeping without a browser (links, `.prev`, a file that is not a session), signs in on a local page, reads
it signed in on the next run and signed out without `--state`, leaves a session alone after a failed run, and
ends a `--login` by closing its last tab; `--login` was also run once with a window and ctrl+c. The file holds
the account's cookies and the agent's commands can read it: keep one only for an account you would let the
bot use.

**It breaks the rule of no runtime dependency, by decision.** `playwright-core` (pinned, about 13 MB)
is the one package the deployment resolves from `node_modules`, and only this tool loads it; the
plugin itself still imports nothing. The browser is Chromium's headless shell, about 90 MB in the
user's cache, which the installer downloads (`node node_modules/playwright-core/cli.js install
chromium-headless-shell`); without it the bot works and the tool says it has no browser and how to
add one.

**It runs with bounds, because "in the sandbox" needed its own policy.** The harness's `web_fetch`
tool runs in the harness rather than under the sandbox runner, so the tool gate bounds it (until
this was found the gate matched the name `fetch`, which the harness never sends, and bounded
nothing; the harness's own refusal of non-public addresses is what kept the metadata service out):

```yaml
- id: deepbot
  config:
    fetchPolicy: true            # default
    fetchAllowedHosts: []        # empty means any public host; e.g. [example.com]
```

Only `http` and `https` are fetchable; other schemes are refused with the scheme named. The
**cloud metadata service** is refused by name and by address as written (`169.254.169.254`,
`metadata.google.internal`, `fd00:ec2::254` in any spelling, `100.100.100.200`, and the IPv4
link-local range; trailing dots change nothing) — it answers with credentials rather than
content, and a reader that can reach it turns "summarize this page" into a way to hand out an
instance's keys. A name that resolves to it, or an IPv4-mapped spelling of it, is left to the
harness, which refuses every non-public address it resolves to. An allowlist, when set, is the
whole web `web_fetch` may open; its entries are compared as hosts are (an IPv6 entry in any
spelling, a trailing dot), and one that is not a host (a scheme, a port, a path, a wildcard), or a value that is not a list of names, is a
config error.
It bounds `web_fetch` only. The agent's own commands (`curl` from its shell) are bounded by
`commandNetwork` instead, when it is set (below, and docs/setup.md).

One boundary worth stating: the injection guard covers channel history, attachments and pages that
arrive as material. The `web_fetch` tool's own output goes straight into the model's context and is
**not** annotated.

## Progress on a turn

A message that is taken is acknowledged **at once** (`workingIndicator`, on by default), with the
platform's own indicator: Discord's and Telegram's "is typing…" (re-sent every 8 s and 4 s, since
each lapses), and on Slack the thread status — "<app> 앱이 작업 중" with a spinner under the thread —
through `agents.sessions.setStatus`, or `assistant.threads.setStatus` where the workspace refuses
the first. Both need only `chat:write`; which one a workspace accepts depends on its features. The
indicator ends before the answer is posted, so the answer is the only notification — except where the turn
streams (Slack, below), whose first text notifies as well.

When the platform refuses its indicator, the transport says so and the core posts its progress
message — `⏳ 아리 작업 중…`, the name from the persona's first heading — immediately instead. A
refusal that will not change (a scope, a feature) is remembered, so later turns fall back at once;
one that arrives after the turn is over posts nothing.

The progress message **is edited in place** as tools run, with tool names and elapsed time; on a
platform with typing it appears only once a turn has run for `progressAfterMs` (8 s). When the turn
ends it gives way to the answer, so a turn leaves one message rather than a stale "working on it"
plus an answer. On Slack the answer is posted as a **new message and the progress message is
deleted** (`chat.delete`, which `chat:write` covers): an edit raises no notification, so with the
progress message on every turn, every answer would have reached a phone as "작업 중". Where a
platform cannot delete, the answer edits the progress message instead. Slack streams the turn instead of
editing a progress message: text in batches (`streamFlushMs`, 1.5 s), a tool by its name only; another message
in the thread comes after all that was streamed; the answer is posted new at once, and the streamed message is
then stopped and deleted (the stop tried again when refused, over a minute; one never stopped is left, and said
in the log; kept if the answer did not go out); a thread's posts go in order; a stream nothing moved for
`streamIdleMs` (2 min) is stopped, and every open one when the gateway stops, after it stops taking messages. Refused for good
(`chat.startStream`), the progress message comes back. Edits are throttled
(`progressUpdateMs`, 2.5 s) because every edit is a rate-limited API call: the message says roughly
what is happening, not every step. Renders are serial per conversation and the answer waits for
them, so a second message in the same thread cannot post a second progress message that nothing
replaces (`test/core.test.ts`, with a post that takes 150 ms). A turn whose completion fails still
gives way to the failure, so nothing is left claiming to be working.

`progressAfterMs: 0` no longer silences Slack: to post nothing until the answer, set
`workingIndicator: false`. Slack's thread history now stops at the message being answered, so the
progress message, posted before the history is read, is not quoted back to the model.

Not verified on a live Discord or Telegram server: typing is checked against the mocked APIs in
`test/discord.test.ts` and `test/telegram.test.ts`, the same as the rest of those transports.

The rule worth knowing when changing this code lives in `progress.ts`, tested with no agent and no
platform: create once, edit after, never leave it behind. An orphaned "working on it" is worse than
no progress at all.

## Stopping a running turn

A turn can take minutes. Say `stop` or `cancel` (`그만`, `중단`, `취소`, `멈춰`, `停止`, `取消`…) on its own in the
thread and the turn is cancelled; the progress placeholder becomes the report, so there is no
second message. With nothing running, the answer is that there is nothing to stop, rather than a
turn started just to say so.

The same path serves the turn timeout. A timeout that only stops the *waiting* leaves the agent
running, writing to the session, and eventually delivering an answer nobody is waiting for — so a
timeout now cancels the work itself. The harness records a cancelled turn with no reason of its
own, so the adapter — the party that asked for the stop — supplies it, and the user is told which
happened: stopped on request, or stopped because it ran too long. `test/scenarios/interrupt.json`
asserts the interrupted turn ends as `cancelled`.

## The terminal (dsh)

A fullscreen terminal client for the same agent. It is a platform like Slack: a conversation in the
terminal gets the persona, the workspace's notes, recall, approvals and the turn queue, because it
goes through the same core. The conversation lives in the gateway; the terminal is only the screen,
so quitting loses nothing.

**Serve it.** A new install serves it already; `dsh gateway setup` turns it on or off. By hand: put `local` in
the deepbot row's `platform` — alone, or in a list — and allow its channel. `config` replaces the
whole row, so restate what you keep:

```yaml
- id: deepbot
  config:
    platform: ['slack', 'local']   # or 'local' for a terminal-only deployment (no Slack token needed)
    targetChannels: ['*']          # or your channel ids plus 'tui'
    # tuiName: work                # when several gateways serve terminals on one machine
```

The gateway listens on `<stateDir>/tui.sock` (owner-only, 0600; a path over 103 bytes falls back to a
short one beside the discovery files) and records it in `$DSH_HOME/run/deepbot-tui/<tuiName>.json`.
On Windows it listens on a named pipe, `\\.\pipe\deepbot-tui-<uuid>`, named anew at every start,
because every user of the machine shares that namespace; `dsh` looks it up in the discovery file on
every reconnect.
A terminal may open, message or stop only the subagents and jobs its own panel offered, and press
only its own conversation's buttons.

**Use it.** `dsh` (`install.sh` writes it to `~/.local/bin`, and a new profile it writes serves the terminal
alone until `dsh gateway setup` adds a messenger; from a clone, run `node dist/tui/main.js`) finds the running gateway;
`--name` picks one by `tuiName`, `--socket` names the path, `--tenant` talks in a tenant's workspace
(needs `tenantIsolation`; without it a new conversation goes where the configuration sends any other,
`tenantDefault` or the home), `--resume <id>` continues a conversation (the id is printed on exit).

**What it shows.** A conversation opens with DEEPSEEK BOT in block letters (one line from 95 columns, two
from 70) and a welcome box under them: `deepseek-bot` and its version, the model, the workspace and session,
and where to start (`/help`, `?`); a narrower screen gets the box alone, and one too narrow for the box the
words alone. No header row sits over the conversation; one
appears only in a subagent's or a shell's view, saying where the pane is looking. The status line's right
side is the context bar (yellow past 70%, red past 90%), the tokens sent `↑` and received `↓`, the share
of what was sent that the provider's cache served, and the model. Under the box, at the hint line's
right, are the workspace (with its git branch when it is a repository) and the conversation, as pi's
footer has them, in the conversation's own view. On a narrow line the status line's parts go whole from
the right, the model first. What the person said sits on a band across the pane; the answer starts at a white
`●`; a tool call's `●` blinks while it runs and turns green or red with its result (grey when the turn
ended without one); thinking is in sky blue, its label swept by a light while it streams, and folds to
one line when the answer starts. A blank line separates the steps of a turn; nothing rules one exchange
off from the next. While a turn runs the status line is one indicator, as Claude Code's: what is
happening, for how long, and how to stop it — `✻ Thinking… (12s · esc to interrupt)`, `Running bash…`,
`Working…` — under the same light; `esc to interrupt` is left out while esc does something else (answers
an approval no, closes a list). A message sent while a turn runs waits above the input, tagged queued,
and joins the transcript when its turn starts. `↑` on an empty box asks the gateway to take those back,
by the ids the terminal gave them: the ones it had not started come back into the box to edit once it says
so, and the turn goes on. A message the terminal shows as running stays (it may still be waiting for a
slot), and so does what another terminal on the conversation queued; every terminal is told which were
taken back. A stop (`esc`, or a stop word) takes back everything waiting in the conversation, and every
terminal on it is told which, before those messages' typing stops: each puts its own back in its box,
including one it already showed as started (sent while idle, or whose turn's start it had read) that was
still waiting for a slot. The empty box says what it is for (`Message deepseek-bot · / commands ·
@ files`); past its six rows it counts the ones it cannot show in its border (`↑ 2 more`, `↓ 1 more`), as
pi does. A paste of more than ten lines (CR or LF) is a chip, `[paste #1 +40 lines]`, until it is sent as
the text it stands for; the cursor goes over a chip whole, and backspace, delete and ctrl+w take it whole.
The hint line under the input box is `? for shortcuts`; `?` on an empty box shows the keys below in its
place, in as many columns as fit. An approval shows the request's first
line and its options numbered: `↑↓`, a digit or a click and `↵` answer it, `esc` answers no (with text
selected, esc clears the selection first). A question or a list opened over an approval has the keys
until it closes. Under `NO_COLOR` there is no band and nothing sweeps. On a light background the colours
are the light palette's (dark text, a light band, light red and green behind an edit): the terminal
says which by `COLORFGBG`, or by its answer to the OSC 11 query `dsh` sends at start (not every terminal
answers it; tmux may not pass it on, and one with no terminal attached does not answer); with neither,
the dark palette. What was drawn before the answer is drawn again in its colours.

| Keys | |
|---|---|
| `↵` / `alt+↵` or `\` then `↵` | send / new line |
| `↑` on an empty box while messages wait | take them back to edit (the turn goes on) |
| `shift+tab`, or a click on it | step this conversation's reasoning effort (shown at the left of the status line between turns; during one, the step is shown for a moment) |
| `esc` | stop the running turn (what was waiting behind it comes back to the input); on an approval, answer no; in a view, back to the conversation |
| `?` on an empty box | show the shortcuts (`esc` or any key closes them) |
| `ctrl+c` twice, `ctrl+d` | quit (the terminal is always restored) |
| wheel, `PgUp`/`PgDn` | scroll (the keys half a screen) |
| drag | select and copy: the conversation's text, the input box's while it has the focus (a paste chip as what was pasted), or, where a press does nothing else, what the screen shows, such as a queued message or the footer (pbcopy locally, OSC 52 over SSH); `esc` clears it |
| `ctrl+home` / `ctrl+end` | the top of the conversation / the bottom, following it again |
| `tab`, `↑↓`, `↵`, or a click | the agent panel: open a subagent or a shell |
| `ctrl+x` | in a subagent view, stop it; in a shell view, stop the job |
| `/` or `@`, then `↑↓` and `tab` | complete a command, or a file of the workspace (`↵` or a click runs a command that takes nothing) |
| a click in the input box | puts the cursor there |
| `ctrl+r` | search what was typed before (`ctrl+r` again: older; `↵` keeps it to edit; `esc` cancels) |
| `ctrl+o` | unfold or fold the tool results; a click on one unfolds or folds that one |
| `ctrl+t` | unfold or fold the thinking |

Commands: `/new`, `/sessions`, `/resume <n|id>`, `/tenant [name]`, `/interview <topic>`, `/model`,
`/usage`, `/clear`, `/help`, `/quit` (or `/exit`). Anything else that starts with `/` is sent as text. What is sent or run
is kept between runs in `$DSH_HOME/deepbot-tui/history.jsonl` (owner-only, the last 500).

What appears besides the conversation:

- **Answers stream** as the model writes them (from `agent/assistant-stream`), with Markdown drawn
  for a terminal: tables (a wide one wrapped inside narrowed columns, a list on a screen too narrow
  for that), code highlighted by token class for the common languages, and links you
  can click (OSC 8; only http(s) and mailto). The posted reply then takes the streamed text's place.
- **Tool calls** show as Claude Code draws them: `● Name(what it was asked)` (the title from the
  harness's tool registry), the result under `⎿` — a read as `Read N lines`, a search as `Found N lines`,
  a list as `Found N files`, a shell's last five lines, anything else its first three, those two with
  `… +N lines (ctrl+o to expand)`; a failure as `Error: …` in red. An edit says `Updated <path> with A
  additions and R removals`, its changed lines on green and red. No rule between exchanges, no caret on
  streaming text; a turn the person stops is marked `⎿ Interrupted`.
- **Thinking** is shown apart from the answer and folds once the answer starts to `∴ Thought for Ns`,
  opened with `ctrl+t` (apart from the tool output's `ctrl+o`, as pi has it), when the model streams its
  reasoning (`reasoning-delta`); the route this deployment uses sends none.
- **The input box keeps the bottom rows.** The conversation fills the rows over it from the top, a short one
  with the empty rows under it; once it is longer than its rows, its newest line is the lowest one it has. A choice — `/model`'s
  or `/sessions`' list, a question's options, an approval — takes the box's place while nothing is typed,
  as in Claude Code; a keystroke of text brings the box back, and so does "type your own…".
- **Approvals** and **a turn's questions** (`ask_user_question`, a plan review) open in the input box's
  place — arrows and Enter, Space on multi-select, or type (or paste) your own answer.
- **`/model` and `/sessions` open a picker** in the input box's place: `↑↓` or the wheel to move, a digit to
  jump, `↵` or a click to pick, `esc` to close. Typing filters it, as Claude Code's lists do: a row stays
  when every word typed is in its name or detail, in any case (after a letter, digits are typed too; a paste
  goes to the filter too). Backspace on an empty filter closes it, `/` with nothing typed closes it to start
  a command, and alt with a key closes it and types the key. A list longer than its window, or filtered,
  says where the highlight is (`Model (3/12)`), as the completion list does in its hint. `/resume <n>`
  still works typed.
- **Scrolling.** `PgUp`/`PgDn` go half a screen; `ctrl+home`/`ctrl+end` (rxvt's too) go to the top and to
  the bottom, which follows the conversation again. Scrolled up past a prompt, the prompt holds the top row
  on one line, dim, so the lines in view say what they answer; a click there does nothing to the line it
  covers. A click on a tool's result unfolds or folds that one in place, its head kept in view; the view then
  stays there (ctrl+end follows again), and what a fold adds is not counted as new lines.
- **The agent panel** lists the turn's subagents (running ones first, with their time and tokens)
  and background shells; a subagent's view shows its task, tools and answers.
- **`/model`** lists the models the registered providers advertise (the harness's `llm` service),
  with this conversation's marked; `←→` picks the highlighted model's reasoning effort among those it
  takes, and the last row goes back to the configured model. Picking one, `/model <n>` or
  `/model <provider>/<model> [effort]` puts this conversation on it from its next turn — the
  same session, resumed on the new route — and `/model default` gives it the deployment's back. Every
  terminal on the conversation is told, and so is the model: the first turn on another route opens with a
  `[model changed]` line naming both (the harness's own notice belongs to its model selection, which a
  plugin cannot install). `shift+tab` steps the effort of the model it is on, round, and
  keeps it as the conversation's own choice, as `/model` does. A
  model no provider lists, or an effort the model does not take, is refused. The choice is kept per
  conversation in the state file; Slack and the other conversations keep theirs. The list leaves out a
  route whose key is not set — the key its settings name (`apiKeyEnv`) is in none of the places the
  harness reads keys from — and one asked for by name is refused with that key's name; the harness's own
  Models page reads keys the same way. A key put in `~/.dsh/.env` counts once the gateway restarts (the
  harness reads that file at launch); one entered in the app counts at once. A route that names no key is
  listed as it is, and the DeepSeek account, which signs in, lists its models once signed in. A
  conversation already on a route whose key is gone (chosen before, or the key removed since) fails its
  turns until the key is set or another model is chosen. A reminder the harness delivers on its own
  schedule runs on the conversation's choice too, as it is when the reminder's request goes (see
  Reminders below; `test/scenarios/reminder-model.json`). The deployment's own
  reasoning effort (`agent-default-model`) now reaches a turn too; it was dropped before. The status
  line shows the effort at its left, in sky blue, and the model at its right.
- **`/interview <topic>`** runs a deep interview: one question per round, and a strip with the
  model's own estimate of how clear each dimension is. Below 20% ambiguity it writes `specs/<slug>.md`.
  The estimate is the model's judgement, not a measurement.

**Memory.** Notes (`SOUL.md`, `USER.md`, `MEMORY.md`) belong to the workspace, so the terminal and
Slack share them in the same home. Recall reads the index of the conversation's own workspace — the
home and each tenant under `<home>/tenants` get one, kept outside the workspace (a custom
`tenantRoot` is indexed only by an explicit `--cwd` run) — and within it stays in the channel the
conversation came from: terminal conversations are recorded as channel `tui`, so the terminal
recalls terminal conversations and each Slack channel its own. A conversation stays in the workspace
it started in: the tenant is recorded with it, survives a restart, and a terminal asking to move it
is refused.

**Limits, measured.** A background job outlives its turn for up to `backgroundKeepMs` (see Sessions), and
ends when its agent is released — the shell view says so when it happens. A subagent can be messaged
only while its parent's turn runs (whether a kept parent changes that is not checked). The
questions have no countdown: the deployment's ask tool runs without timed waits. Whether a given
terminal supports synchronized output, SGR mouse and OSC 52 is not checked; without them it still
works, with flicker or without mouse.

`pnpm test:tui-live` runs the terminal's path against a real gateway and model in an isolated
instance (it boots `agent-test` with a `--patch` overlay that serves only the socket).

## Watches, reminders, staying up

- **Reminders** use the schedule bundle: the agent creates one, the wall clock fires it, and the
  schedule takes a turn in the session by itself. The adapter does not drive that turn — it
  delivers assistant messages for session ids it is not currently driving, which is
  `test/delivery.test.ts` 9/9 and `test/scenarios/reminder.json`.
  The harness resumes the session with an agent of its own, routes it by the session's last request,
  and keeps that agent for as long as the gateway runs, holding the session. Two things follow, both
  handled by the adapter. That agent's requests go on the conversation's route as it is at each request
  (`/model`, shift+tab, a tenant's model), from an `agent/request` listener the adapter adds as the
  agent is created (or, for one made before the adapter loaded, as it starts) — outermost, as the
  harness's own model selection is among its listeners. And the conversation's next turn, refused the
  held session, runs in that agent instead of failing: it first waits for a turn of the harness's own
  running there (whose answer is delivered as the agent's, and which a stop does not cancel), gets the
  identity section a turn's own agent gets, keeps the route it started on through a `/model`, and does
  not dispose the agent. Before, every message after a reminder failed with "could not take the
  session". That agent's tools are the preset the harness composes from the session's record, which
  can differ from what the adapter would mount now (a preset changed since, or none configured); the
  tool gate and the sandbox apply either way. A reminder's turn gets no `[model changed: …]` notice of
  its own; the adapter's line on the conversation's next turn names the model of the turns before the
  switch. If the desktop app picked a model for such a session, that pick is overridden here, and the
  harness may add its notice naming it.
- **Watches** ("tell me when this changes") are `watch/watch.ts`, installed as a launchd job by
  `watch/install-watch.sh` (evaluated every 60 s by default). Watch definitions come from
  `~/.dsh/watches.json` and from `<agent home>/watches/*.json`, merged by id — the second location
  is how the agent authors its own. The first observation is a **baseline** and never alerts; a
  change alerts once; a change inside the rate-limit window is suppressed and the next alert says
  how many were suppressed. A broken watch config exits 2 rather than failing quietly.
  A watch the **agent** wrote runs inside `service/confined-runner.sh`, **read-only**: no writes at
  all, no credentials, and — stricter than the agent's own commands — no reads of any agent home,
  its own included, so it watches the outside world rather than the agent's files. It used to run
  as `/bin/sh -c` on the host, outside the sandbox and the approval gate. An agent file that reuses
  a host watch's id is confined too; without the runner such a watch does not run; only plain files
  under 64 KiB are read from the agent's watches directory (a FIFO there stopped every watch), and
  an id must be a plain name (`__proto__` skipped the baseline). Its output is still posted to
  Slack. `test/watch.test.ts` 22/22.
- **Health.** A process that is running but disconnected looks perfectly healthy from outside —
  that is how a 57-minute outage went unnoticed. The plugin publishes what it knows to
  `<stateDir>/health.json`, and `service/health-check.ts` diagnoses it (no file, not connected, or
  stale/wedged). On unhealthy it restarts the service, waits for recovery, and only then alerts, so
  a blip that heals itself stays quiet; alerts are rate-limited because an alert storm is its own
  outage. `service/install-health.sh` installs it as a 5-minute job, and `service/rotate-logs.sh`
  runs from that job — logs are truncated in place (the launchd captures keep an open descriptor,
  so renaming them would leave a file nothing can find).

`PLAN.md` records the verification: an injected unhealthy state
(`unhealthy — not connected (disconnected 1023s ago)`) → `restart requested` →
`recovered after restart`, plus one labelled test DM to prove the alert path.

## What it costs

Ask in the conversation — `사용량`, `비용`, `토큰`, `usage`, `얼마나 썼어` — and the bot answers
from durable totals without starting a turn:

```
이 대화: 7턴 · 입력 112,220 (캐시 61%) · 출력 3,441
전체 (4개 대화): 31턴 · 입력 480,113 (캐시 58%) · 출력 20,441
```

Tokens come from the harness's `tokenUsage` session projection, which reports **cumulative**
totals for a session. The tracker stores the last snapshot per session and adds only the growth,
so the running total survives a restart; a session whose totals go down — compaction, or a
different log — is treated as a new baseline rather than a negative delta. All of that is
`test/usage.test.ts` 21/21.

Money is deliberately absent. The harness exposes no price for a model, so a price table here
would be a number nobody could check: the summary reports tokens and says why.

## One workspace per tenant

By default every conversation shares the agent's home: one persona, one set of notes, one recall
index. For a deployment serving more than one customer that is the wrong default, so isolation is
one config away:

```yaml
- id: deepbot
  config:
    tenantIsolation: true
    tenantChannels:
      'C0123ABCD': acme        # channel → tenant
      'C0456EFGH': globex
    tenantRoot: <home>/tenants        # default
    tenantTemplateDir: ./agent        # its persona, copied on creation
    tenantPolicies:
      acme: { preset: standard, model: { provider: og, model: <id> }, persona: acme }
```

A tenant's directory is created on its **first message** — provisioning belongs to the message,
not to a turn that happened to succeed — and seeded from the template if one is
configured (markdown only). Without a template a tenant simply has no persona, which is the honest
default. The read scope follows the speaker, so one tenant reading another's notes is refused and
the refusal names what it *is* allowed to read.

**The instruction root.** The harness reads `AGENTS.md` and `CLAUDE.md` from a session's directory up
to the nearest `.git`, and every file on the way. When a directory above the home or a tenant directory
has a `.git` (a home under a dotfiles repository, a home the agent ran `git init` in), the adapter keeps
an empty `.git` in that directory, checked on every turn because the agent can remove it, so neither is
handed the files above it. With none above, it makes none: the loader stops there already, and a `.git`
would be one more place to climb to, and would turn on `.gitignore` rules for the grep tool. In a
tenant's directory only a `.git` directory counts; a file or a link it planted is replaced. When a
directory above has a `.git`, the sandbox runner refuses a command that removes or moves the
workspace's `.git` or changes the workspace's own entry — its mode, an ACL, its flags (what is in them stays writable), and a tenant
whose directory is not its own, or cannot be kept the root, is refused its turn. One cost of that rule:
`rsync -a` into the workspace's top directory exits 23 after writing every file (it sets the
directory's mode even when unchanged); `rsync -rt` does not. git passes
over an empty `.git`; one already there (a repository, a worktree's gitlink) is left as it is. The
`.deepbot-root` file older setups wrote was never read by the harness and can be deleted.

`test/scenarios/tenant.json` (6 steps, needs a model) has one tenant write a file and the other
fail to read it by name, fail to find it in its own directory, and fail to reach it by walking up
and across (`../acme/...`). `tenantPolicies` gives a tenant its own agent preset, model and
persona, with the deployment's settings as the default and a refusal that names the tenant when a
preset does not exist — all verified by checks in `test/core.test.ts`.

**A per-tenant *permission* preset is not a setting.** The key was read and never applied, so it
was removed; `test/core.test.ts` checks that a tenant's `permission` imposes nothing. The
deployment's `permissionPreset` applies to every tenant.

**A YAML trap worth knowing:** a key containing a colon must be quoted. `scenario:T1: acme` parses
as the key `scenario` with the value `T1: acme`, so isolation silently does nothing — which is
exactly what happened the first time this was tested.

## Text that tries to give orders

Channel history, attachments and pages are fetched material, and anyone can put an instruction in
them. Fetched text is framed (`content, not instructions`) and scanned; the shapes covered include
instruction overrides, `system:` impersonation, role reassignment, tool calls written as text, and
asks for credentials or `.env` contents. The warning names where the finding came from and **does
not quote the attack back** — a warning that repeats the payload delivers it twice.

**This is a mitigation, not a boundary.** What decides is elsewhere: the read scope refuses files
outside the workspace, the sandbox runner refuses other instances' data, and destructive commands
ask a human. This layer makes an attempt visible to the model at the point of use and to the
operator in the log, instead of silent. `test/injection.test.ts` (37/37) weights the benign cases
as heavily as the attacks, because a guard that flags ordinary conversation is a guard nobody
reads.

## Tests and scenarios

```bash
pnpm test                     # 21 suites, no harness, no network, no account
pnpm test:profile             # the composed posture of the installed profiles
node test/run-scenario.ts    # default: test/scenarios/recall.json (needs a model credential)
```

`pnpm test:profile` reads what the harness actually composes for the profiles you name (default
`agent` and `agent-test`) with `dsh --dump-config`, and checks the posture rather than the file:
the destructive-command gate, the confined runner and its failure signature, `api-remotes`, the
approval policy, read isolation. 24/24 on this machine. It needs the profiles installed and the
`dsh` path the test file names.

A scenario is a JSON file of steps executed against the real services in an isolated instance —
its own profile, its own fresh agent home, its own index and port, and it never connects to Slack.
`node test/run-scenario.ts test/scenarios/<name>.json` exits 0 when every step passed, 1 when a
step failed, 2 on setup problems. Flags: `--timeout <s>`, `--seed <file>`, `--dump <file>`,
`--keep`.

| Scenario | What it asserts |
|---|---|
| `recall.json` | a fact stated in one conversation is recalled in another, with its date; a fact never stated is not invented |
| `recall-immediate.json` | the index already holds a fact from a turn that just happened, and holds the user's words — not the adapter's injected preamble |
| `recall-near.json` | a fact among five newer near misses on the same subject in the same words is recalled: the model's choice among the latest passages finds it where ranking by words put the near misses first |
| `recall-paraphrase.json` | a past said in other words is found: the question shares no word with it, only with the words the model relates to the question; no note is written and none read, so only recall answers |
| `recall-decision.json` | recall ends in a decision ("here is what happened, therefore this") rather than a dump of passages |
| `restart-1.json` + `restart-2.json` | a second process resumes the first's session and still knows what was said (`pnpm test:restart`) |
| `notes-hygiene.json` | the consolidation advice reaches the prompt when `MEMORY.md` is over budget |
| `persona.json` | the model answers as the persona in `SOUL.md`, knowing a fact only that file holds, without opening it |
| `vision.json` | the model answers with a colour that only the attached image reveals |
| `browser.json` | a fact and its source URL come from a fetched page, not the prompt |
| `document.json` | a produced `.docx` / `.pptx` is a real ZIP with the expected OOXML parts and text |
| `injection.json` | an instruction in an attachment and in channel history never gets a canary file read out |
| `isolation.json` | another instance's home and a retired bot's data stay unreadable |
| `tenant.json` | one tenant cannot read another's file, by name or by path traversal |
| `approval.json` | a turn that needs an approval ends instead of hanging |
| `approval-gate.json` | the destructive-command gate: it asks, the request reaches the answerer, which fails closed with no platform to reach, and the file survives |
| `browser-session.json` | the agent browses as an account it was signed in to: the kept session in the workspace's `.browser/` is named in the standing block, and only a run with it sees the account's name |
| `command-network.json` | with `commandNetwork: public`, a command asked to fetch a page on this machine runs and never brings its content back |
| `mcp-ask.json` | a tool `askTools` names is asked for before it runs: the fixture's `vault_store` is refused, and the file only it can write never appears |
| `mcp.json` | a tool of an MCP server the profile composes reaches the model: the answer comes from `mcp__fixture__vault_lookup` of `test/fixtures/mcp-fixture.mjs`; the test profile needs the fixture's row (docs/setup.md, MCP servers) |
| `interrupt.json` | a running turn stopped mid-flight ends as `cancelled` |
| `reminder.json` | a reminder fires on the wall clock and wakes the agent by itself |
| `reminder-model.json` | a reminder runs on the effort chosen after it was made, and the conversation's next turn still runs |

Named shortcuts exist for the common ones (`pnpm test:doc`, `test:vision`, `test:isolation`,
`test:approval-gate`, `test:interrupt`, `test:immediate`, ...; the full list is in
`package.json`). `service/run-scenarios.sh` runs the set unattended, writes
`$DSH_HOME/slack-state/scenario-report.txt`, takes a lock so two runs cannot share state, starts the page
server of the browser, browser-js, browser-session and command-network scenarios on port 8899 and stops whatever holds that port after it (a port something else
holds fails that scenario and is left alone), and runs
`--quick` (interrupt and approval-gate) when asked. `service/install-scenarios.sh` makes it a daily
launchd job (09:30 unless `HOUR`/`MINUTE` say otherwise); `install.sh` does not, since every scenario is
a paid turn of a real model. The job starts node, which starts the script: macOS closes a checkout under
`~/Desktop`, `~/Documents` or `~/Downloads` to a shell that launchd starts itself, while node, once
allowed (macOS may ask), reads it. The health probe says so when the report is more than a day late, as
it does when one fails. `test/dist-fresh.ts` guards the scenario
runner too, so a scenario can never run a stale build.

## Changing the voice

The tone is a file, not a setting. `agent/SOUL.md` holds the identity and the default register and
`agent/AGENTS.md` holds the rules that apply on top of it; `init.sh` copies both into the agent
home from this repository, and after that they are yours to edit. The shipped copies are neutral
templates that tell the agent to answer in the language its users write in — one deployment sets a
plain 반말 register there, and that is a file edit, not a code change.

Two things worth knowing before editing them:

- The bot's **own** messages — approvals, stops, progress notes — sit in the conversation, and the
  model copies the voice around it: one polite string pulls replies toward that register no matter
  what the persona file says. Those strings live in `index.ts`, and the core suite reads that file
  and fails if an honorific ending comes back (`test/core.test.ts`, its last check).
- The persona files are read on every turn, so a rule added there takes effect immediately — but a
  *contradictory* rule does not win by being newer. It wins by being specific.

## What it is not

- **Not a coding agent.** It edits files and runs commands; it is not competing with your editor.
- **Not a chat toy.** Single-turn Q&A is a side effect; remembering across conversations is the
  point.
- **Not a vector search.** The conversation's model chooses among the channel's latest passages; older
  ones are matched by words, so a differently-worded question about an older one can miss, and the
  block says so where the model reads it.
- **A browser for one page at a time.** `browse.js` keeps no tabs between runs, and a sign-in only in a session file
  you made for it (`--login`, `--state`).
- **Not multi-tenant by default, and not voice or video.** One instance is one memory unless you
  turn tenant isolation on. Images are supported; audio, video and desktop control are not (`PLAN.md`, Decided against).
- **Not safe by construction, everywhere.** Read confinement is a policy boundary; the
  destructive-command gate does not resolve end to end yet; and the harness itself is a release
  candidate whose session API can change.

`docs/limitations.md` is the fuller list, including the design risks and the operational caveats
(non-public harness APIs, `installModelSelection`, one FTS index owner per path, TCC). Note that
parts of its "Not implemented" table predate 0.2.0 — Slack attachments, progress and cross-session
recall are built now, and the tests above are the current record. `docs/harness-api-notes.md` is
the other half: the harness contracts this plugin relies on, marked verified, code-read or
uncertain.

## Layout

```
install.sh                     the one-line installer and updater
init.sh                        scaffolds the agent home and the gateway profile (install.sh runs it)
index.ts                       the adapter: orchestration, policy gates, prompt assembly
safeWrite.ts                   unconfined writes into the agent's home that never follow a link
transports/                    the platform seam: slack.ts, telegram.ts, discord.ts, local.ts (the
                               terminal's socket), composite.ts (several at once), attachments.ts
tui/                           dsh: render/ (cells, diff, input, Markdown), the app, the panel,
                               questions, the interview, and bridge.ts (what the gateway reads for it)
recall/                        the host-side indexer (deepbot-recall.ts) + its refresh job
recallContext.ts               the block injected when a message points at the past
notes.ts                       when to ask the model to tidy up the notes
progress.ts                    the working message, where a platform's own indicator is refused
usage.ts                       token totals that survive a restart
injection.ts                   detecting instruction-like text in fetched material
watch/                         the watch runner and its installer
profile/                       the gateway profile: bundles, sandbox runner, approvals, the deepbot row
service/                       runner, launchd installers, health probe, log rotation
agent/                         SOUL.md / AGENTS.md / USER.md / MEMORY.md templates
tools/                         persona-check, the secret scanner, the live Slack QA runner
test/                          unit suites, scenarios, fixtures
docs/                          harness API notes, limitations, the logos
cordis.patch.yml               the bundle patch that inserts the adapter row
```

## Gotchas worth knowing before you debug for an hour

- `apps.connections.open` needs the **app-level** token (`xapp-`) and is **POST-only**. A bot
  token gives `not_allowed_token_type`; a GET gives `insecure_request`.
- A user message needs a stable `id`. Without it the persisted log fails validation on the next
  read (`lacks an identified message`) and resume breaks — which only shows up on the *second*
  turn.
- Session resume is bound to the recorded working directory. Change the gateway's cwd and old
  threads stop resuming; they look like amnesia, not like an error.
- A patch row's `config` **replaces the whole config** — there is no deep merge. Adding
  `approvalPatterns` without restating `targetChannels` has already kept this bot from booting.
- `launchd` does not inherit your shell's privacy permissions. A job whose script lives under
  `~/Documents` dies with `getcwd: Operation not permitted`, which is why the installers copy the
  wrappers under `$HOME`.
- The FTS index has **one owning process per path**. Do not point two gateways at the same index
  file.
- State is pruned by age (`stateRetentionDays`, 30): a conversation's session mapping, standing
  digest, history cursor and usage total are dropped after that, so a very old thread starts fresh.
- The harness ships no `.d.ts`; `types/dsh.ts` is hand-written from the shipped implementation and
  verified by running. Treat a harness upgrade as a change to re-check, starting from
  `docs/harness-api-notes.md`.
