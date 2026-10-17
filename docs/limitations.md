# Limitations

Written to be read by whoever inherits this repo, including future me. Nothing
here is hypothetical — each item is either observed behaviour or an explicit
decision with a cost.

## Not implemented

| Missing | Consequence | Where to fix |
|---|---|---|
| Queue position | A message waiting behind `maxConcurrency` shows the working indicator at once, but not its place in line | Report the position after N seconds of waiting |
| Fact extraction for `memory/` | Notes are kept by the agent following `AGENTS.md`, and the adapter asks for a tidy-up when `MEMORY.md` grows or repeats; nothing extracts facts after a conversation on its own | A curator pass on a schedule over recent sessions |
| A custom `DSH_HOME` | The services, the sandbox runner and the health probe read `~/.dsh`; the installer refuses another harness home rather than half-support it | Pass `DSH_HOME` through every plist and read it everywhere |
| Semantic recall | Recall is lexical: words in common, weighted by how rare they are, Korean particles stripped. A message that points at the past also ranks by words the conversation's model relates to it, which costs a model call and up to `recallExpandMs` (4 s) of the turn's time; a paraphrase the model relates no rare word to may still miss. Trigger words match inside other words (`전에` in "배포 전에", `again` in "against"), so some messages ask for no reason | Embed and index externally; a new runtime dependency is a decision, not a detail. `recallExpandMs: 0` turns the call off |

## Verified partially, or not at all

- **Recall is the adapter's, not the agent's.** `recall/deepbot-recall.ts` indexes past sessions into
  `$DSH_HOME/recall/<home>/recall-index.jsonl` on a schedule; the adapter ranks passages from the same
  channel and injects them before a turn. Sandboxed commands cannot read the index. The harness's own
  FTS index held 0 rows when this was built and is not used.
- **Duplicate-event suppression.** The rule is implemented and the code path was
  exercised, but no real Slack redelivery was observed, so the end-to-end path is
  untested.
- **Reconnect behaviour.** Backoff and `disconnect` handling are implemented from
  the Socket Mode protocol; no live network interruption was induced.
- **Attachment/thread edge cases.** Only plain threaded text has been exercised.

- **Reads are confined by policy, on two surfaces.** Commands through the sandbox runner,
  file tools through a `tools/pre-execute` read scope. It is a policy boundary rather than
  a kernel one: the tool list has to grow with the composition, and a new tool that reads
  files another way would not be covered. A separate OS user per instance remains the
  stronger answer, and is not built.


## Design risks

- **Non-public harness APIs.** Session driving, message construction, and the
  event fold are recovered from the shipped implementation. There are no type
  declarations to confirm they are public contract. A harness upgrade can break
  this plugin without a deprecation notice. Pin your harness version, and treat
  `docs/harness-api-notes.md` as the list of things to re-check on upgrade.
- **`installModelSelection` is not called.** The shipped runners pin the model
  selection inside `setup`; this plugin passes `agentOptions` only, because the
  helper is not importable from a profile-installed bundle. It works in the
  configuration tested, but this is the most likely source of a subtle
  model-selection failure.
- **The harness is a release candidate** (`0.2.0-rc.2` at the time of writing).
  Bundles, patch grammar, and service names can change.
- **An MCP server is outside every gate.** A server added to the profile runs as the
  gateway's child: not under the sandbox runner, able to read the bot's credential
  files. Its tools pass the approval gate (unless `askTools` names them), the read
  scope and the fetch allowlist, are shared by every conversation (tenants included),
  and what they return is not marked as instruction-like text. Add only servers you
  trust (docs/setup.md).
- **One FTS index owner per path.** Running two gateways against the same index
  file is a documented constraint of that component, not something this plugin
  guards against.
- **One Socket Mode connection per Slack app.** Two clients on one app token make
  Slack split events across them and both sides start dropping messages. Never
  run a migration in parallel on the same app unless you intend the cutover.

## Operational caveats

- **`launchd` cannot read `~/Documents`** (macOS TCC). A job whose wrapper lives
  there dies with `getcwd: Operation not permitted`. `service/install-service.sh`
  copies the wrapper under `$HOME` for exactly this reason — do not "simplify" it
  away.
- **Session resume is bound to the working directory.** Moving the agent home
  orphans every existing thread's session. Threads keep accepting messages, but
  each one starts fresh, which looks like amnesia rather than an error.
- **`targetChannels: ['*']` answers in every channel the bot has joined.** The
  plugin refuses to start with an empty list, but `'*'` is a deliberate act: an
  invited bot plus `'*'` plus `replyMode: all` will answer every human message in
  those channels.
- **Token handling.** Credentials are read through the harness credential service;
  they are never written into plugin state. The plugin redacts `xox…`/`xapp…`
  patterns from its own log lines, but the log is still a plain file under
  `$DSH_HOME/slack-state/`. Treat it as sensitive.
- **Session logs are the memory substrate.** Deleting a session log deletes the
  memory of that conversation; the FTS index is derived and will simply follow.

## Verifying recall

```bash
INDEX=$(ls -d "$DSH_HOME"/recall/*/ | head -1)recall-index.jsonl
wc -l "$INDEX"                              # rows: grows as conversations are indexed
grep -c 'some phrase you said' "$INDEX"     # the phrase reached the index
node test/run-scenario.ts test/scenarios/recall-immediate.json
```

If the row count stays flat after conversations, the refresh job is not running:
`launchctl print gui/$(id -u)/ai.deepbot.recall-index`.

- **A browser, signed in only where you signed it in.** `web_fetch` runs no JavaScript; for such a page
  the agent runs `dist/tools/browse.js`, a headless browser that types, clicks and screenshots one page per
  run. A site that needs a sign-in is reached only through a session you keep for it (`--login`, then
  `--state`; docs/setup.md), and a site that refuses sign-in in a browser driven by automation stays out of
  reach. The session file holds the account's cookies, and the agent's commands can read it: whoever can
  talk to the bot in that workspace can browse as you there. It needs Chromium's headless shell installed
  (the installer does it), and `--login` a browser with a window. It prints the page's own
  text, not that of frames inside it. Text given to `--type` is on the command line, where the process
  list and the session log show it: not for a password. Its proxy carries what the browser sends over
  TCP; WebRTC's UDP does not go through it. `web_fetch` is bounded by the tool
  gate (scheme, metadata service, optional allowlist) and opens public addresses only; the agent's own
  commands (`curl`) are not bounded by that gate (`PLAN.md`, Open). Its output is not run through the
  injection guard — that covers channel history, attachments and material arriving in a
  prompt, not a tool result.
