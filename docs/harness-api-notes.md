# Harness API notes

What this plugin relies on, and how confident we are in each piece. Everything
here was established by reading the shipped `0.2.0-rc.2` distribution and by
running it, not from published documentation — the distribution ships no type
declarations, so contracts were recovered from the code and confirmed by
execution.

Legend: **verified** = exercised end to end here. **code-read** = established
from the shipped implementation, not exercised by this project. **uncertain** =
no way to confirm from the distribution.

---

## 1. Plugin bundle manifest

`package.json` fields the loader actually reads:

| Field | Meaning | Notes |
|---|---|---|
| `dsh.bundle.patch` | path (or ordered list) to this bundle's patch file | Being present is what makes the package a *bundle*. Without it the loader skips the package with `declares no dsh.bundle in its package.json`. |
| `dsh.client` | browser-half declaration | Not used here — this plugin has no UI half. If you do declare it, `exports` must expose `"./client"`. |
| `dsh.profile.bundles` | ordered bundle list for a profile | Used by `profile/package.json`. |

- `dsh.manifestVersion` is documented but **no reader validates it** — a scan of
  the distribution found zero packages declaring it. This repo omits it.
- Compatibility preflight only inspects `@deepseek-ai/dsh*` entries in
  `peerDependencies`. Do **not** declare them: a mismatch disables the row (or
  skips the whole bundle), and the shipped packages are resolved by the host
  installation anyway. This repo declares none.
- **code-read**: `exports` must expose `"."`; exposing `"./package.json"` lets the
  host read plugin metadata for display.

## 2. Patch grammar (`cordis.patch.yml`)

- A patch file is a **top-level array** of rows. A file with only comments fails
  to boot; use `[]` for "no patch".
- `- insert:` appends rows to the root (or into a group row's config when the
  group row is addressed by `id`). Rows inserted by an earlier layer can be
  overridden by an `id`-targeted row in a later layer.
- `- id: <row>` with fields patches that row. **`config` is replaced wholesale —
  there is no deep merge.** To change one field you must restate the whole config.
- A truthy `name` on an id-targeted row is an *assertion*, not a rename: if it
  does not match the existing row, the patch is skipped.
- `disabled:` accepts a boolean, `null`, or an expression. Expressions are
  re-evaluated on every activation decision.
- Layer order: bundle patches (in `dsh.profile.bundles` order) → the profile's own
  patch → `$DSH_HOME/cordis.patch.yml` → any `--patch` overlay.
- **code-read**: row-level `inject: [...]` merges into that row's fiber inject map
  and therefore controls activation order. This repo uses it so the adapter waits
  for `agents` / `sessions` / `sessionQuery`.

## 3. Driving a session in process — **verified**

The sequence below is what the shipped one-shot runner and the in-process
subagent driver both do, and what this plugin does (turn 1 and turn 2 confirmed
against a live gateway):

```
selection   = ctx.get('agentDefaultModel').currentSelection()
agentOptions= { provider: selection.provider, model: selection.model }

handle = existingSessionId
  ? await ctx.get('agents').resume({ resumeSessionId, agentOptions, setup })
  : await ctx.get('agents').create({ sessionId, meta: { cwd }, agentOptions, setup })

await handle.agent.whenIdle()
const firstSeq = handle.agent.session.seq
handle.agent.followup(userMessage)          // admission commit point
await handle.agent.whenIdle()
await ctx.get('sessions').flush(handle.agent.session)
const text = readLastAssistantText(handle.agent.session, firstSeq)
await handle.dispose()
```

Details that matter:

- **`setup` must pin the model selection.** Both shipped drivers call
  `installModelSelection(agentCtx, { current: selection, assembled: undefined })`
  inside `setup`. This plugin cannot import that helper (see §5) and passes only
  `agentOptions`. It works in the configuration tested here, but if you hit a
  "no model selected" class of failure, this is the first suspect.
- **A user message needs a stable `id`.** The shipped constructor is
  `deepFreeze(structuredClone({ ...input, id: brandString(randomUUID()) }))`, plus
  `role: 'user'`. Omit the `id` and the log fails validation on the next read
  with `session event at seq N lacks an identified message` — a failure that only
  appears on the *second* turn.
- **Resume is bound to the recorded working directory**, and the session must be
  adoptable (not a subagent or forked session, and not already live in the
  process). Resolve the cwd once and keep it stable.
- **Final text is not a return value.** Read it from the session log over the
  interval you own; the assistant text is the last non-empty assistant message in
  that interval, and the outcome is the `turn/end` reason
  (`{ kind: 'completed' | 'error' | … }`).
- **uncertain**: whether `create` / `resume` / `followup` / `whenIdle` are a
  *public* contract. Three first-party packages rely on them, but there are no
  type declarations in the distribution to confirm intent.

## 4. Services and credentials

- Services are resolved by name: `ctx.get('<name>')`. Names used here:
  `agents`, `sessions`, `agentDefaultModel`, `credentials`, `sessionQuery`,
  `sessionPersistence`, `fs`.
- `await ctx.credentials.resolve(ref) → { value, source } | undefined`. An empty
  value means "absent" everywhere. Layer precedence, highest first:
  `process.env` → `$DSH_HOME/.credentials.yaml` → `<cwd>/.env` → `$DSH_HOME/.env`.
  `$DSH_HOME` defaults to `~/.dsh`. A ref must match `[A-Za-z_][A-Za-z0-9_]*`.
- **verified**: the `.env` layer is what this repo documents, and `resolve` works
  for a plain string ref.

## 5. Why this plugin imports nothing

First-party plugins import helpers from `@deepseek-ai/dsh-*`. Those packages live
inside the application archive, and a *profile* has no `node_modules` of its own,
so a third-party bundle that imports the same specifiers has no guaranteed
resolution path. Everything this plugin needs is therefore inlined:

| Shipped helper | Inlined replacement |
|---|---|
| `createUserMessage(input)` | `deepFreeze(structuredClone({ ...input, role: 'user', id: randomUUID() }))` |
| `brandString(s)` | a plain string (the runtime brand is a tag) |
| `SessionSeq(n)` | a plain number |
| the runner's summary fold | the same walk over `session.eventAt(seq)` |

`installModelSelection` is three listeners on the agent's context (`system-prompt/assemble`,
`agent/request`, `agent/pre-step`, in `dsh-agent/lib/index.js`) that pin the selection and tell the
model when it changes mid-session. This plugin passes `agentOptions` (provider, model, reasoning
effort) on every `create` and `resume` instead: each turn starts a fresh agent instance, which takes
its route from those options, so a conversation's model can change between turns (`/model`) without
a new session. The `[model changed]` note to the model is what that leaves out.

If you are writing a plugin that *does* live inside a host installation, importing
the helpers directly is cleaner and strictly better.

## 6. Lifecycle

`ctx.effect(() => { start(); return () => stop() }, 'label')` ties a resource to
the plugin's lifetime: the returned function runs on unload. This plugin starts
the Socket Mode connection there and closes the socket on disposal.

## 7. Services the TUI reads — **code-read**, 2026-10-13

Read from the shipped `lib/*.js` of DeepSeek Harness `0.2.0-rc.2` (inside `app.asar`), for the
terminal UI (`tui/`). Paths are under `/dsh/node_modules/@deepseek-ai/`. None of this is a
published contract; each shape below is pinned by a fixture test so an upgrade that changes it
fails loudly. Items marked **runtime** still need a live run to confirm.

**Streaming text.** `ctx.on('agent/assistant-stream', ({ agent, frame }) => …)`
(`dsh-agent-loop/lib/index.js:1067`). The session id is `agent.id` (equal to
`agent.session.id`). Frames:

```ts
| { type: 'start'; attemptId; revision; turn; step }
| { type: 'chunk'; attemptId; revision; index /* dense from 0 */; time; chunk: StreamChunk }
| { type: 'end'; attemptId; revision; index;
    outcome: { kind: 'committed'; eventType: 'assistant/message' | 'assistant/attempt'; seq } | { kind: 'abandoned' } }
StreamChunk = text-delta { index; text } | reasoning-delta { index; text } | tool-call-delta
            | block-start | block-end | usage { usage } | finish { reason }
```

A failed attempt commits as `assistant/attempt` and is retried with a new `start` for the same
turn and step, so a renderer must drop the attempt's partial text when that happens.
**Verified live** (2026-10-13, a gateway on the worktree with `platform: 'local'`, model
`deepseek-v4.1-flash-ultrafast`): the adapter's `ctx.on('agent/assistant-stream')` receives a root
turn's frames — 39 text deltas, the first 702 ms after the message, the reply at 955 ms, and the
deltas joined equal the reply exactly (261 characters). The
event also fires for in-process subagents; `agent.session.header.origin === 'subagent'` tells
them apart. `dsh-headless/lib/index.js:144-189` is the shipped consumer.

**Usage and context.** `sessionProjections.snapshot(session).values`:
`tokenUsage = { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }`
(cumulative) and `contextPressure = { pressureTokens?, projectedTokens?, contextWindow? }`.
`sessionProjections.onChanged((session, key, value, seq) => …)` is the change feed.
**Verified live**: the OpenGateway route used here fills `contextWindow` — a two-turn terminal
conversation read 11,701 tokens and 1.2% of the context.

**Questions.** `ask_user_question` (dsh-tool-ask-user) reaches `ctx.userQuestions.ask()`, which
runs the waterfall `ctx.on('user-questions/request', (request, next) => …, { prepend: true })`:

```ts
request = { questions: { id; question; header?; options?: { label; description? }[]; multiSelect?;
                         detail?; intent?: { kind: 'plan-review'; approve } }[];
            agent?: Agent; signal?: AbortSignal; wait?: { callId; timed? } }
answer  = { answers: { id; selected: string[]; custom?: string }[] }
```

A listener answers by returning, declines with `return next()`, and cancels by throwing
`{ name: 'UserQuestionError', code: 'ASK_CANCELLED' }`. Listeners run in registration order;
the shipped Web answerer (`dsh-api-remotes`) is `disabled: true` in this deployment's profile,
so the adapter is the only answerer. The tool copies only `id, question, header, options,
multi_select` from the model's input — **a model cannot set `detail` or `intent`**; only
`exit_plan_mode` sets the `plan-review` intent. Default tool mode is `legacy`: no `wait`, so a
question is answered in the call or not at all.

**Subagents.** `ctx.subagents.listChildren(parentSessionId)` →
`{ id; createdAt; mode: 'one-shot' | 'continuable' | 'unknown'; label? }[]`; the label is the
model's short description, there is no separate name. On the child: `subagentTiming =
{ settledMs; active?: { since; through }; lastTurnCompleted? }` and `tokenUsage`. Running
versus idle: `ctx.agents.get(childId)?.status`. A child's creation appends `subagent/catalog`
to the parent. Read a transcript without adopting the session with
`ctx.sessionQuery.observeSession(id)` (a disposable lease with `events`).
`subagents.interruptByParent(childId, parentId, 'continuable')` needs only ids.
`subagents.prompt({ requestId, parentSessionId, childSessionId, mode: 'continuable', delivery:
'queue' | 'steer', content }, signal)` needs a **live parent agent** — and this adapter releases
the agent after every turn (`index.ts`, end of `runRegisteredTurn`), so a child can be messaged only
while its parent's turn is running. **runtime**: the adapter's `ctx` does receive
`agent/assistant-stream` (above), which suggests it is untagged; whether children's
`session/event` and `agent/status` reach it, and what happens to a continuable child when its
parent is released, still need a live subagent.

**Verified live** (2026-10-13, a real `subagent` call and two background `bash` jobs in a terminal
conversation): a catalog entry is `{ mode, label, id, createdAt }` (label: the model's short
description), `subagentTiming` is `{ settledMs, active: { since, through } }` while running, a job
view is `{ id, kind, label, owner, status, startedAt, output }`, and the panel follows them through
`agent/status`, projection changes and job events. A child's log records the harness's injections
as user-role messages (`agent-instructions`, `runtime-context`, `skill-catalog`, `time-context`
source kinds); only `user` is the task.

**A background job lives as long as its agent.** dsh-jobs disposes an owner's jobs when the owning
agent's context is disposed (`ensureOwnerCleanup` → `disposeOwned`). Observed, when this adapter
released the agent after every turn: a job still running when its turn ended disappeared from the
registry. The adapter now keeps an agent that owns a running job (how-it-works, Sessions). From the
harness source: `list(caller)` returns the caller's jobs and the unowned ones; an `{ owners: 'all' }`
subscription is unscoped and is delivered before `{ owners: 'scope' }` ones, which is where
dsh-tool-jobs wakes an idle owner (`followup`) with its notice for a settlement that was not awaited,
not killed by the model and not a teardown; `followup` on an idle agent starts its driver at once,
so `whenIdle()` called after that dispatch waits for the woken turn. When an agent is released the
terminal says "정리됨" instead of leaving the output looking live.

**Jobs.** `ctx.jobs.list(ownerSessionId)`, `get(id)`, `readAt(id, from)` →
`{ chunks: { at; text; channel?: 'stdout' | 'stderr' | 'log' }[]; next; lossy }` (does not move
the model's read cursor — never call `read()`), `kill(id)`, and
`jobs.events.subscribe({ owners: 'all' }, listener)` for `registered | progress | output |
settled | removed`. Job ids and output live only in the gateway process.

**Measured.** An empty scenario boots the `agent-test` profile in 0.55–1.07 s (three runs,
500 ms poll granularity). The gateway runs as a `gui/<uid>` launch agent, so a 0600 unix socket
in the user's home is reachable from the user's terminal; macOS limits a socket path to 104
bytes.
