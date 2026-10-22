# deepseek-bot — plan

Companion to [SPEC.md](SPEC.md). Milestones are ordered by dependency, not by enthusiasm: nothing
is built before the thing it stands on. The detailed history of each milestone is in the git log.

## Working rules

1. **Definition before code.** Each milestone states its acceptance criteria first. A change that
   does not serve a criterion does not ship.
2. **Automate the verification before doing the work.** A fix for something observed failing comes
   with a test that failed first.
3. **Two gates, always:** `pnpm run typecheck` and `pnpm test`. A real-model scenario
   (`node test/run-scenario.ts test/scenarios/<name>.json`) for anything the model has to do.
4. **Say what is unverified** — in the commit, in this file, in the README — in the same change
   that makes the claim.
5. **The live instance stays up.** Changes reach it by reinstalling or restarting a supervised
   service, and every change leaves it working.
6. **Nothing machine-specific in the repository.** Paths, ids, names and credentials belong to a
   deployment's profile and environment, not to the code, the tests or the docs.
7. **Changes reach `master` through a pull request**, after a review pass by someone other than the
   author. The working rules are in `AGENTS.md`, the vocabulary in `CONTEXT.md`.

## Done

| Milestone | What it gave |
|---|---|
| M0 Presence | Slack Socket Mode adapter, durable session per thread, supervised service, reconnect forever |
| M1 Test harness | scenario runner against a real model in a separate profile and home |
| M2 Memory | persona and notes in the prompt, a recall index over past sessions, notes hygiene |
| M3 Never silently dead | health file, external probe, alerts, log rotation |
| M4 Autonomy | reminders through the schedule bundle, watches ("tell me when this changes") |
| M5 Distribution | one-command install, profile template, CI |
| M6 Transports | one core, Slack / Telegram / Discord, a fake transport for the core's tests, approvals over chat |
| M7 Agent gaps | attachments and vision, read confinement, per-tenant policy, fetch policy, usage totals |
| M8 Terminal | `dsh` (was `deepbot-tui`): a local socket transport served beside Slack or alone, streaming, approval buttons, a turn's questions and plan reviews, the agent panel (subagents, shells), sessions to resume, a deep interview; recall indexed per workspace; first-turn approvals no longer fail closed; tool calls with their title, diff and result, thinking, tables, highlighted code and links; completion of commands and files, history search and history kept between runs |
| Round 66 | persona restored to the prompt; the platform's own working indicator; one turn at a time per conversation; recall scoped to its channel; documents uploaded; watches and commands confined (credentials, session store, ssh-agent, the launcher and its logs out of the agent's home; no writes through links) |
| Round 67 | one-line install; the home's `.env` refused; recall read only by the adapter, ranked by rare words and offered without a trigger word; failures in the bot's voice without host paths, a stop reported once; a restart tells the conversation its turn was lost; the probe alerts on failed scenarios; no agent socket of the user's reachable from the sandbox, hard links pinned by a test; uploads send the checked bytes; approval buttons and uploads on every platform; Markdown rendered on Telegram; review fixes — forged conversation blocks defused, approval buttons tied to their request, the .env gate by case and link, per-thread Slack status, separate alert limits, restart recovery race, one index per home, installer validation and kept service settings |

## Open

- **Workspace temp directories are never removed.** Each workspace (a tenant, a scenario's) leaves a
  `deepbot-cmd-<hash>` directory in the user's temp; macOS clears it only after days unused. Pruning old ones could
  join the log rotation job.
- **The agent's own commands reach the network unbounded by default.** `commandNetwork: public` or `local` bounds
  them (docs/setup.md, The agent's network); the default stays `open`, because a bounded command that ignores a
  proxy (ssh, `git` over ssh, a raw socket) reaches nothing, which an existing deployment would see as breakage.
  `fetchAllowedHosts` still bounds `web_fetch` only.
- **A check-then-write window in `writeInside`.** It checks a directory's real path, then writes by
  path; Node has no `openat` to write relative to a checked directory descriptor. Exploiting it needs
  a process inside the agent's sandbox racing the check. Uploads no longer share the window: the
  bytes are read from the descriptor that was checked.
- **The live round trip on Discord and Telegram**: typing, uploads, buttons and Telegram's rendering
  are tested against mocked APIs only (see Unverified).
- **Slack's own part cutter** (`postChunked`) keeps its number's room but does not recount it when the parts
  reach ten (about 36 000 characters at 4000), and can cut a surrogate pair. `transports/parts.ts` does both;
  Slack can use it.
- **A background job outlives its turn, within limits.** An agent that owns a running job is kept after
  its turn (up to `backgroundKeepMs`, at most `maxKeptAgents`), the harness's wake turn answers when the job
  settles, and the agent is released after it. Still not: a restart loses running jobs and says nothing of
  them (they are in-process, and no in-flight record is kept for one); the woken turn has no working status, no
  progress message and no in-flight record; a stop word with no turn running does not stop a kept agent's
  job (`job_kill` or the terminal's panel does). A continuable subagent can be messaged only while its
  parent's turn runs; whether a kept parent changes that is not checked. Checked with fakes only; the
  real wake path needs a scenario against a real model.
- **Several messengers at once.** The composite transport answers whatever the terminal does not claim
  through its first messenger, so `dsh gateway setup` keeps one at a time. Serving two needs each
  conversation routed to the platform it came from, including the messages the bot sends first
  (watches, reminders, restart notices).
- **`dsh gateway`, what other bots' gateways have and this does not yet:** a restart that waits for running
  turns instead of cutting them (they are reported as lost); health per platform — `connected` in the
  health file is one flag for every platform, so `status` cannot say which one is down, and
  `lastError` one field: a clear names the error it clears, so two platforms failing with the same
  text (`fetch failed`) can clear each other's until the next attempt writes it again; pairing a new
  person by a code in a direct message instead of listing ids; and a home channel for notices.

Decided against:

- **Desktop control** (seeing the screen; the mouse and keys in other apps), decided 2026-10-19. The harness ships
  no tool for it. The way to add one, an MCP server, runs as the gateway's child outside the sandbox, with
  whatever Accessibility and Screen Recording macOS has been given, for everyone who can talk to the bot. A page
  is reached with the browse tool, and an app with a command line or an MCP server of its own through that. The
  agent's commands cannot reach the desktop either: the runner refuses `osascript`, `osacompile`, `automator`,
  `shortcuts`, `open` and `screencapture`, and the pasteboard. A program compiled to send Apple Events or take the
  screen itself is not stopped (docs/how-it-works.md, Read confinement).
- **Permalinks on Discord and Telegram.** On Slack a link points at a thread inside a channel; on
  Discord and Telegram the conversation *is* the channel or chat, Discord's `<#channel>` mention is
  already a link, and a private Telegram chat has none. A link to where the person already is would
  be a knob that does nothing.

## Unverified

- A read outside the workspace answered with a real button: live, only the refusal path ran (a scenario has no
  platform). Keychain items through securityd: reachable by commands, not closed (refusing the keychain service
  may break TLS and git over https; not measured). The commands' new credential refusals were checked with a home of the suite's own; a deployment whose
  agent used the owner's ssh key or gh token will find that tool failing.

- Recall's choice by the model over a large channel: measured on 24 passages. With hundreds, the latest 40 are
  offered and older ones are matched by words; whether 40 is the right number, and the choice's quality over
  passages cut at 200 characters, are not measured. Measured only on the test profile's route (OpenGateway,
  reasoning off). That the choosing request (a direct model call) reaches no session log the indexer reads is
  by reading the plugin, not the harness.

- Google mail and calendar through `workspace-mcp` (docs/setup.md): written from its code and README, not run. It
  needs the owner's Google OAuth client, which was not available. Also unchecked: the first sign-in from a gateway
  under launchd (the server opens the browser itself), and the tool names `askTools` should list for it. An
  `askTools` approval answered with a real button: the scenario covers the refusal path only, as `approval-gate`
  does. Also unrun: an `askTools` question in a reminder's turn (it goes to the conversation, where nobody may be
  watching, and times out), and a named tool called from a `run_code` program (the harness gates its sub-calls the
  same way, by reading; parallel ones would meet the one-pending-approval rule and the second be refused).

- MCP servers beyond the fixture: no real server (GitHub, mail, calendar) was composed live, and an HTTP
  (`streamable-http`) server was not tried. A stdio server's reads are confined by the gateway's read isolation by
  construction (it is the gateway's child); that was not probed. That a server failing to start leaves the bot
  running without its tools is the harness's documented behaviour, not seen here. A credential handed over from
  `~/.dsh/.env` by `!!js process.env.NAME` was not seen live either: the live check's value came from the launching
  shell (the harness's code reads that file into its environment at start, a name already set winning).
- A DeepSeek Harness the installer placed, never opened as an app: the CLI runs (`--version`, a profile booted
  from the unpacked bundle), but the runtime under `~/.dsh/dsh-runtimes` is unpacked by the app's host process
  at its start, and whether the document skills (their node is there) work before the app has been opened once
  is not known.
- The browse tool on Linux and Windows: checked on macOS only, under the Seatbelt runner. Not yet used from Slack by
  a person. A kept session (`--state`) against a real site: checked with a local page that sets a cookie; sites
  that bind a session to more than cookies and site storage (IndexedDB, a device check), or refuse sign-in in a
  browser driven by automation, were not tried. `--login` was run by hand with ctrl+c; closing its window ends it
  by the page's close event, not exercised. A public page kept from a
  private address is checked at the proxy and in the decision, not with a live public page (the suite has none).
- The fetch gate against the harness's tool name: a manual probe (a fetch of the metadata address, refused with the
  gate's reason) is all that ties the gate to `web_fetch`; no daily scenario does, because the harness refuses that
  address too. The allowlist was not exercised live: a scenario would need its own profile with an allowlist.
- Long answers on Telegram and Discord against the platforms themselves: the parts are checked against fakes that
  enforce the limits as documented (Telegram's 4096 counted after the entities, Discord's 2000); no multi-part
  answer was sent live. A part dense with Markdown now carries up to four times the entities it did; whether
  Telegram limits the entities in one message, and with what error, is not known.
- Progress marks against Slack itself: the live app lacked `reactions:write` when they were written, so
  `reactions.add`, `reactions.remove` and `reactions.get` are checked against a stubbed Web API only, and the
  rate limits (Tier 3 add, Tier 2 remove) by Slack's documentation, not by load.
- `dsh gateway mcp add` end to end on a real gateway: the row it writes composes (`--dump-config`), and the
  row shape it writes reached a real model in the MCP scenario; a credential written to `~/.dsh/.env`
  reaching the server through `!!js process.env.NAME` is read from the harness's source (dsh-app-boot loads
  that file into the environment at start), not run. Neither the Notion server nor a hosted one was tried.
- Progress marks on Discord and Telegram against the platforms themselves: checked against fakes only. Whether
  Discord takes the keycap digits and ⏹️ in the form sent (with U+FE0F), and the exact errors Telegram gives for a
  chat that limits its reactions, are taken from the documentation, not seen.
- Recall's related words on DeepSeek's own API, the default route: sent with reasoning off and a capped answer,
  as the harness's DeepSeek adapter takes them (read from its source), but neither its latency nor its answer was
  measured; the scenario ran on an OpenGateway route. A model that cannot turn reasoning off is sent its least
  effort, uncapped, and may spend the 4 s thinking.
- Slack streaming end to end with a real turn: the API's behaviour (recipient required in a channel, no edit or
  delete while streaming, chat.update after stopStream) was probed live in a lab channel; the transport is checked
  against a stubbed Web API. Not yet watched: a long answer past one append's 12 000 characters, the Tier 4 limit
  on appendStream with several threads streaming, how the stream renders the model's Markdown mid-way, what Slack
  notifies for a streamed message, a stream in a DM, and the recipient team for a person from another workspace
  (Slack Connect, Enterprise Grid: the team is auth.test's). Probed: chat.delete after chat.stopStream works, and a chat.postMessage into the thread while the bot's stream there is open is accepted and lands after it. Not
  known: whether the stops close() sends go out before the process exits (the unload does not wait for it), and
  what Slack does with a stream left open by a crash.
- `replyMode: thread` against a real model: that DeepSeek answers exactly `[no reply]` to chatter in a thread and
  answers what is meant for it. The suites drive a fake agent; the scenario runner has no conversation to put a
  message without a mention in. Watch `kept quiet` against `answered` in the gateway log on a deployment that uses it.

- The guided `dsh gateway setup` in a real terminal: its menus and the token prompt were driven in a
  pty (macOS Terminal-style escape sequences) and by the suite's fakes; not yet in other emulators,
  nor end to end against Slack, Telegram and Discord. The browser is opened with macOS's `open`;
  elsewhere the link is printed. Discord's `GET /applications/@me` fields used (`bot.username`,
  `flags`, `owner`) are from Discord's API reference, not observed.
- How a DeepSeek Harness subscription signs in, as against a key entered in the app: `dsh gateway status`
  reports the model's key from the app store or `~/.dsh/.env` and does not count it toward healthy,
  so a subscription that needs no key reads "not in the DeepSeek Harness app or ~/.dsh/.env" there.
- `dsh gateway` against the real services: the suite runs it with fakes for launchctl, plutil and
  the platforms. Not yet run for real: `setup` writing a live profile and restarting a live gateway,
  `stop` and `start` on the installed jobs, and the token checks against Slack, Telegram and Discord
  — the Slack same-app check reads `bots.info`, whose answer shape is from Slack's method reference
  and is skipped when refused. `status` was run read-only on a live deployment.
- The Slack app manifest (`dsh gateway manifest slack`): not yet used to create an app; its scopes
  are the ones `docs/setup.md` lists, which a test pins.
- `allowedUsers` on a live platform: the user ids it compares are the ones each transport reports
  (Slack `event.user`, Telegram `from.id`, Discord `author.id`), checked through the fake transport.
- Discord and Telegram typing, uploads and approval buttons, and Telegram's HTML rendering: mocked
  APIs only, no live server or bot.
- Slack approval buttons in a real workspace: they need Interactivity turned on in the app's
  settings; without it a press does nothing and the person types the answer, which the request offers.
- Slack's working status in a live workspace: no turn has run on this code there yet. Which method a
  workspace accepts is logged on each refusal ("working status: … refused").
- Whether a Slack app has `files:write` for uploads; a refusal is logged and told to the conversation.
- Which terminals support synchronized output, SGR mouse and OSC 52 for `dsh`; checked in
  tmux only. Without them it flickers or loses the mouse, and keeps working.
- The terminal's thinking block: the model route used here streams no `reasoning-delta`, so it is
  pinned against fakes only. (Tool calls, their results and an edit's diff card are verified live.)
- Clicking a link in the terminal: the OSC 8 bytes are checked, a click is not — the terminal has
  mouse tracking on, where most emulators want a modifier (cmd or shift) with the click.
- With several platforms, the "already reported" stop removing a working message put up after the
  report (`index.ts`, routed through `via()`): no test reaches that branch — the immediate working
  message is replaced by the report, and the slow-turn one is not put up after it.
