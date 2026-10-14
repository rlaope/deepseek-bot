# Changelog

Notable changes, newest first. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
the caveat about version numbers is at the bottom.

## Unreleased

### Added

- **`/exit` in the terminal**, the same as `/quit`.
- **English, Korean and Chinese.** A `language` setting in the deepbot row (`en` by default, `ko`,
  `zh`) sets what the bot itself says on every platform (approvals and their buttons, stops,
  failures, the working message, Slack's status, the usage report) and everything `dsh` draws; `dsh`
  starts in its environment's language and takes the gateway's once connected. Stop, usage, allow and
  deny are understood in all three whatever the setting, recall reads Chinese by pairs of
  characters, and the injection check knows Chinese shapes. The installer asks, offering the
  environment's language; an existing profile is told how to set it. An unknown value is a config
  error. The model's answers still follow the persona.

### Changed

- **The terminal shows a turn's parts apart.** What the person said is on a band; answers start at
  a `●`; a tool call's `●` blinks while it runs and turns green or red with its result, and stops
  blinking when the turn ends without one; thinking is sky blue, its label swept by a light while it
  streams; a blank line separates a turn's steps and a rule separates exchanges; the status line
  names what is happening (thinking, the running tool, working). A message sent during a turn waits
  above the input, tagged queued, until its turn starts, and `esc` gives what waited back to the
  input, since the gateway withdraws it.
- **The bot's own words default to English.** They were Korean. A Korean deployment keeps them by
  setting `language: ko`; the Korean wording is unchanged.
- **The terminal speaks English.** Its status line, hints, notices, `/help`, usage and exit line were
  Korean in a project whose README and docs are English. The `/interview` instructions to the model
  are English too and ask it to question in the topic's language. The adapter's own messages on the
  platforms (approvals, the working message) are unchanged. When no gateway is running, the terminal
  now says to start one rather than only to add `'local'`, which a new install already has.
  `docs/demo.gif` is recorded again, in English.
- **The terminal is `dsh`.** The command was `deepbot-tui`. It shares its name with the DeepSeek
  Harness CLI, so given anything but its own flags (`--name`, `--socket`, `--tenant`, `--resume`,
  `--help`) it runs that CLI (`DSH_BIN`, or the one inside the app) with them and exits with its status.
  The banner reads DEEPSEEK BOT, and the header shows a workspace under the home directory as `~`. The
  discovery and history paths under `$DSH_HOME` keep their `deepbot-tui` names. `docs/demo.gif` is a
  recording of it.
- **`install.sh` sets up the terminal.** It writes `~/.local/bin/dsh` (leaving a `dsh` that is not its own
  alone), a new profile serves the terminal beside the platform (`platform: ['slack', 'local']`, and
  `tui` added to a list of channels), and it no longer takes its own `dsh` on the `PATH` for the
  harness CLI. A rerun keeps an existing profile and says how to add the terminal to it.
- **The suites, the tools and the runtime scripts are TypeScript.** The suites run as `.ts` under
  Node's type stripping (Node 22.18 or newer, no flag) and `pnpm run typecheck` checks them with
  `test/tsconfig.json`. The health probe, the watch runner and `tools/` are compiled into `dist/`;
  `install-health.sh` and `install-watch.sh` copy the build under the deployed names
  (`health-check.mjs`, `watch.mjs`) and refuse without one. `pnpm persona` and `pnpm qa:slack` run
  from `dist/tools/`.

### Added

- **Install in one line**: `curl -fsSL …/install.sh | bash` fetches, builds, scaffolds the home and
  the profile, asks for the tokens on the terminal and installs the services; running it again
  updates. The profile template carries the sandbox runner, headless approvals and the deepbot row.
- **The platform's own working indicator**: Slack's thread status ("앱이 작업 중"), typing on
  Discord and Telegram; a working message only where that is refused.
- **Approval buttons on every platform**: Block Kit on Slack (needs Interactivity on), an inline
  keyboard on Telegram, components on Discord. Typing 허용 / 거부 still works.
- **Documents a turn made are uploaded** on Slack, Discord and Telegram.
- **Telegram renders Markdown**: bold, code, links and headings as HTML, plain text when refused.
- **Recall without a trigger word**: two rare words in common with a past conversation of the same
  channel are enough, ranked by how rare each word is, with Korean particles stripped.
- **A restart tells the conversation** its turn was lost and asks to be told again.
- **The health probe alerts** once per daily scenario report that has failures.
- **Usage reporting.** Ask `사용량` / `토큰` / `usage` in a conversation and the bot answers
  from durable totals — turns, input tokens and the cache-read share — without starting a
  turn. Tokens only: the harness exposes no price, and the summary says so rather than
  inventing one.

- **Prompt-injection detection.** Fetched material is scanned for instruction-like text and
  annotated at the point of use, and the finding is logged. A mitigation, not a boundary —
  the read scope, the sandbox and the approval gate are what decide.
- Scenario steps can carry `history` and `attachText`, so an injection can arrive through
  the same channel a platform would deliver it through.

- **Link reading, verified and bounded.** The harness's `fetch` tool opens a URL from the
  conversation; a scenario against a locally served page proves the fact and the citation
  both come from the page and not the prompt. The tool gate bounds it: http(s) only, the
  cloud metadata service refused, and an optional host allowlist. Not a browser: no
  JavaScript, no clicking.
- **Per-tenant workspaces.** `tenantIsolation` gives each conversation group its own
  directory — persona, notes, attachments and recall index — and the read scope follows the
  speaker, so one tenant cannot read another's files.

### Fixed

- **The persona reaches the model again**: `SOUL.md`, `USER.md` and `MEMORY.md` are sent by the
  adapter (the harness's loader reads only `AGENTS.md`), with the speaker named.
- **One turn at a time per conversation**; a stop withdraws what is waiting, and is reported once.
- **Failures are reported in the bot's voice** (Korean, 반말) without host paths; the last
  honorific messages were found by a widened check.
- **Slack's working status stays** while another message in the same thread is still working.
- **The scenario alert and the outage alert have their own rate limits**; one no longer silences the
  other.
- **A turn begun while restart notices go out is tracked**, and a restart during the notices loses
  none: each record stays until its own notice is out.
- **Recall works for a home reached through a symlink**: the indexer names the home by its resolved
  path, as the adapter does.
- **A refused upload is told to the conversation** (Discord's 10 MiB limit, a Slack app without
  `files:write`).
- **Two homes never share a recall index.** The index directory gains a hash of the home's path; the
  next refresh rebuilds it there, and the old directory can be removed by hand.
- **The installer** reads the platform back on a rerun, validates channel ids before writing the
  profile, runs nothing when the download is cut short, and refuses a `DSH_HOME` other than `~/.dsh`;
  reinstalling a service keeps its settings (alert target, deny list).
- **Telegram's renderer** is not fooled by a NUL in the text or a list marker.
- A debounced state write could be lost when the plugin unloaded. Found by checking a
  five-step scenario for its usage totals and finding one turn instead of two: the pending
  timer never fired. The state is flushed on unload now.

### Security

- **Recall stays in its channel**, and only the adapter reads the index: it lives under the harness
  home, which sandboxed commands cannot read.
- **Confinement**: watches the agent writes run read-only in the sandbox; commands cannot read the
  deployment's credentials (a hard link is no way around it), the session store or the gateway's
  logs, nor reach any agent socket of the user's (ssh-agent, 1Password, gpg-agent); the launcher and
  its logs live outside the agent's home; unconfined writes never follow a link.
- **The home's `.env` cannot replace the deployment's tokens**: the agent may not write one, and the
  launcher moves one aside before the gateway starts.
- **An upload sends the bytes of the file that was checked**, read from one descriptor without
  following a link.
- **A conversation block forged in a standing file** (persona, notes), history, an attachment or a
  recalled passage no longer moves a session into another channel's recall: the adapter's markers are
  marked as quoted there, and its session mapping outranks a channel read from text.
- **An approval button answers only the request it was posted with**; an older button cannot approve
  a newer request.
- **The home's `.env` is refused to the file tools** in any case (`.ENV`) and through any link.
- **The sandbox names the workspace by its resolved path too**, and a `DSH_HOME`'s session store and
  recall index are unreadable like `~/.dsh`'s.
- **Nothing machine-specific in the repository**: paths, ids and names moved to the deployment's
  profile and environment (`DEEPBOT_DENY_READ`, scenario `{HOME}` placeholders).

## 0.2.0 — 2026-10-10

M6 and M7 from [PLAN.md](PLAN.md), plus the release work: TypeScript, three transports,
confined reads, images, interruptible turns, and approvals over chat.

### Added

- **Transports.** Slack behind a seam (`transports/slack.ts`), then Telegram (long polling)
  and Discord (gateway websocket + REST). One core, one transport per platform; the core is
  driven in tests by `test/fake-transport.mjs` with no platform account at all.
- **Vision.** An attached image reaches the model as a picture, admitted through the
  harness's attachment service. Verified by a scenario that asks for the colour of a
  solid-colour fixture — a fact nothing in the prompt reveals.
- **Interrupt.** `그만` / `중단` / `취소` / `stop` cancels a running turn, and the same path
  serves the turn timeout, which until then stopped only the waiting.
- **Progress.** One message per conversation, edited in place with tool names and elapsed
  time, replaced by the answer.
- **Approvals over chat.** A request is posted into the conversation and `허용` / `거부`
  settles it. A transport that can render buttons gets them (`supportsButtons`): Discord
  posts an action row and the decision is made in place, with the interaction acknowledged
  before the decision is handed over. Destructive commands inside the workspace — where the
  sandbox permits deletion — ask first.
- **Read confinement.** Commands run under `service/confined-runner.sh`; the file tools are
  fenced by a `tools/pre-execute` read scope over `read`, `read_image`, `grep` and `glob`.
- **TypeScript.** Build toolchain and CI typecheck, hand-written declarations for the DSH
  services this plugin uses (`types/dsh.ts`), and the transport seam as a type.
- `init.sh` for a one-command persona and profile setup, `tools/persona-check.mjs` for
  checking the injected files before they are silently truncated, `npm run persona`.

### Fixed

- A turn that needs an approval no longer waits forever for an answerer that does not exist.
- Standing context is injected once instead of every turn: the persona files are delegated
  to `dsh-agent-instructions`, which appends them as one durable baseline and is written so
  new content does not invalidate the prompt cache.
- The recall index is refreshed after every turn rather than by a ten-minute timer, and no
  longer indexes the adapter's own injected preamble.
- Reconnection retries forever instead of once, with a watchdog: a single retry that failed
  left the bot alive and silent for 57 minutes.
- The document scenario asserts the document's text rather than its byte size. The size
  floor rejected a valid 1 KB docx that a run had built by hand.
- Defects found by running rather than reading: a missing `readdirSync` import that made the
  note index fail silently, a `fetchHistoryConfig` path returning two different types, a
  `mktemp` template BSD could not expand, a stale `dist` being tested, and a profile edit
  that deleted the sandbox row and switched read confinement off for two rounds without
  saying so.

### Security

- An agent's commands cannot read another instance's home or a retired bot's data.
- The file tools refuse reads outside the workspace, temp and read-only tooling.
- A repository-wide secret scan and a persona check run in CI; both fail the build.

### Known limitations

- The read scope is a policy boundary, not a kernel one: the tool list has to grow with the
  composition. One OS user per instance remains the stronger answer, and is not built.
- Images require the model route to declare `input: [text, image]`; text-only deployments
  degrade to a filename.
- One instance is one memory. Multi-tenancy is not built.
- No voice, video, or browser automation.

## 0.1.0 — 2026-10-06

The starting point: a Slack Socket Mode adapter as a DSH bundle plugin with a gateway
profile and a durable thread→session mapping. M0–M5 — presence, a scenario harness, working
memory, health, autonomy and distribution — were built on top of it during the same week,
before this file existed; [PLAN.md](PLAN.md) is the record of those milestones.

## Versioning

These numbers describe this plugin's own surface. Its dependency is DeepSeek Harness
`0.2.0-rc.2`, and a release candidate can change underneath it: the distribution ships no
`.d.ts`, so `types/dsh.ts` is read from the shipped JSDoc and verified by running the real
services. Expect 0.x while the harness is pre-release.
