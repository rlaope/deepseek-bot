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

- **A check-then-write window in `writeInside`.** It checks a directory's real path, then writes by
  path; Node has no `openat` to write relative to a checked directory descriptor. Exploiting it needs
  a process inside the agent's sandbox racing the check. Uploads no longer share the window: the
  bytes are read from the descriptor that was checked.
- **The live round trip on Discord and Telegram**: typing, uploads, buttons and Telegram's rendering
  are tested against mocked APIs only (see Unverified).
- **A background job ends with its turn.** The adapter releases the agent after every turn and
  dsh-jobs disposes an agent's jobs with it, so "I'll tell you when it finishes" cannot be kept — on
  any platform. A continuable subagent can be messaged only while its parent's turn runs, for the
  same reason. Keeping an agent while it owns work is a lifecycle change, not made.
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

- **Permalinks on Discord and Telegram.** On Slack a link points at a thread inside a channel; on
  Discord and Telegram the conversation *is* the channel or chat, Discord's `<#channel>` mention is
  already a link, and a private Telegram chat has none. A link to where the person already is would
  be a knob that does nothing.

## Unverified

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
