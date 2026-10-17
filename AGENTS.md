# AGENTS.md — working in this repository

For an agent about to change deepseek-bot. Four principles, adapted from
[andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills) (MIT), each one
followed by what it cost to learn here. The words this project uses are defined in
[CONTEXT.md](CONTEXT.md).

## 1. Think before coding

Don't assume. Don't hide confusion. Surface tradeoffs.

- **State the assumption you are about to act on.** An anchor you have not read, a symbol you have
  not grepped, a behaviour you believe exists. Three rounds were spent editing a function whose name
  was guessed; `grep -n` found it in one command.
- **Do not build on a claim you have not checked.** Two features were "done" because the code
  typechecked, and neither ran: one block sat after a `throw`, another inside a branch that never
  executes. A typecheck does not catch dead code.
- **Check what a flag means on this platform.** On macOS `grep -Z` decompresses; it does not print
  NUL-separated names. A history rewrite ran to the end and changed no file because of it. And zsh
  does not split `$ARGS` into words: a sandbox probe "refused" every command because the `--` never
  arrived. Run shell probes under `bash`, with arrays.
- **Push back with the simpler option.** "No per-conversation serialization exists; collisions are
  absorbed by the adapter's retry" was found by reading rather than by assuming the design was wrong.
- **Say when something is unverified** — in the commit message, in `PLAN.md`, or as a `TODO` printed
  by the suite that would otherwise check it. Never leave it implied.

## 2. Simplicity first

Minimum that solves the problem. Nothing speculative.

- **No new runtime dependencies.** The plugin imports nothing from `node_modules`; adding one is a
  decision, not an implementation detail. Semantic recall was solved as lexical scoring for this
  reason, and the limitation is written down instead of hidden. The one decided exception is
  `playwright-core`, pinned, loaded only by `tools/browse.ts`, never by the plugin.
- **No knob that does not work.** A per-tenant `permission` key was read and never used, so it was
  removed rather than documented as supported. A half-working option is worse than a missing one.
  The installer refuses a `DSH_HOME` other than `~/.dsh` for the same reason: the services read
  `~/.dsh`, and half-supporting another home put tokens where nothing looked.
- **Prefer the smaller change.** A one-line ranking fix beat a new search subsystem; a directory per
  tenant beat a new storage layer.
- **Ask "is it the same thing?", not "does its name look the same?".** The gate that keeps the agent
  from writing its home's `.env` compared paths as text and was bypassed four times in a row: by
  case, by a symlink, by `..` through a linked directory, by the `/System/Volumes/Data` firmlink.
  Comparing the directory by device and inode ended it.

## 3. Surgical changes

Touch only what you must. Clean up only your own mess.

- **Replace whole lines, found by substring.** A partial replacement truncated a call and crashed a
  suite; a blanket `policy.permission` → `permissionName` replace rewrote a *declaration* and two
  commits left with a type error.
- **Do not improve adjacent code.** The scan rewrote an unrelated `permissionName` line, and adding
  the rotation call put an import above a shebang, breaking a job this deployment depends on.
- **Remove what your change orphans, and nothing else.** Dead code found earlier stays until asked.

## 4. Goal-driven execution

Define success criteria. Loop until verified.

- **Write the check before the fix.** The third-party-approval gap was *proved* by a failing test
  before any code changed; the state-growth defect was proved by seeding 400 stale conversations.
- **See it fail for the reason you claim.** A "red" run made by stashing a whole file failed because a
  getter was gone, not because of the defect; a mutant crashed before it reached the check. Remove
  only the line under test, and read why it failed.
- **Never pipe a suite into `head` in a gate.** `node test/x.ts | head -3` closes the pipe, node dies
  of EPIPE, and the exit status says 1 for a suite that passed. Four rounds went into chasing a
  "flaky guard" that was this. Run suites with output to a file and read the exit code.
- **Gate on both: `pnpm run typecheck` and `pnpm test`.** One commit reached `origin` with a type
  error because only the tests were checked. Assert the shape, edit, gate, and restore on failure —
  six mistakes were caught this way, and the only one that escaped was the one with a single gate.
- **A test that passes for the wrong reason is worse than a failing one.** Found here: a fixture
  whose winner was also the newest row, a stub that accepted any id so a refusal path was never
  entered, a scenario asserting a tool *choice* rather than the artifact, and a hard-link check that
  passed whether or not the rule it was written for existed. Make the fixture unable to satisfy the
  claim by accident, and add the control that shows the tool itself works.
- **Have someone else look, and look again after fixing.** A separate review pass found thirteen
  defects the author's own tests had passed; three verification passes after it found four more
  each, and only the fourth found none. The author's tests check what the author thought of.
- **Never run an installer from a test.** `install.sh` and the `install-*.sh` scripts clone, build
  and call `launchctl`. Their logic is tested by sourcing `install.sh` with
  `DEEPBOT_INSTALL_SOURCED=1`, which defines its functions and runs nothing.
- **Verify where it runs.** `node test/run-scenario.ts test/scenarios/<name>.json` against a real
  model (not in CI; `service/install-scenarios.sh` schedules `service/run-scenarios.sh` daily), then
  restart the live bot and read `node ~/.dsh/service/health-check.mjs --status`.
- **One heavy job at a time.** Suites, scenarios and review agents run one after another, never side
  by side: the machines this runs on are small, and a full disk once failed a gate with `ENOSPC`.

## Delivering a change

- **Through a pull request.** Work on a branch, open a pull request, merge it; `master` is not pushed
  to directly. History on `master` is never rewritten without the owner saying so.
- **The repository is public and names nobody.** No home paths, account names, workspace or channel
  ids, or people's names — in files, fixtures, commit messages or author fields. Scenarios write
  paths as `{HOME}`; `test/secrets.test.ts` scans the tree for token shapes. Before committing,
  `git config user.email` must be the repository's own identity, not a personal or company one.
- **A commit message says what was wrong, what changed, how it was checked, and what is still
  unverified.** No tool attribution lines.

## Facts worth knowing

- **Names.** The project is deepseek-bot. In code the plugin id is `deepbot`, its environment
  variables are `DEEPBOT_*`, its launchd jobs `ai.deepbot.*`, and an install's source checkout is
  `~/.deepbot`. Renaming those would break installed profiles and services.
- The harness ships **no `.d.ts`**; `types/dsh.ts` is hand-written from the READMEs and verified by
  running. DSH packages cannot be imported from this plugin — service calls only.
- Session logs are `session.v4.jsonl.zstd`, one zstd frame per write, split on `28 B5 2F FD`.
- Profiles live outside the repository (`~/.dsh/profiles/`); a `config:` block **replaces the whole
  config**, so a new `- id: deepbot` row must restate every setting it means to keep.
  `profile/cordis.patch.yml` is the template the installer copies.
- `test/profile.test.ts` checks the composed posture, because profile edits have silently changed
  it three times.
- **A deployment runs copies.** The launcher, the sandbox runner, the health probe and the watch
  runner are copied to `~/.dsh/service`, outside the agent home, so nothing the agent can write runs
  unconfined. An edit under `service/` or `watch/` reaches a deployment only when its
  `install-*.sh` is run again; those scripts keep the installed job's settings. The gateway itself
  loads `dist/` from the checkout it was installed from.
- **The suites are TypeScript that Node runs as it is**, by type stripping (Node 22.18 or newer, no
  flag). So: erasable syntax only (no `enum`, `namespace` or parameter properties), `import type` for
  a type, and `.ts` in a relative import. They import the build from `dist/`, not the sources, and
  `test/tsconfig.json` typechecks them. The health probe, the watch runner and `tools/` are compiled
  into `dist/`; the probe and the runner are deployed under their old names, `health-check.mjs` and
  `watch.mjs`, and their installers refuse without a build.
- **The recall index is not in the agent home.** `recallIndexPath` puts it under the harness home
  (`$DSH_HOME/recall/<home>-<hash>/`). The indexer writes it, only the adapter reads it, and the
  sandbox denies it to the agent's commands. Passages are injected per channel.
- **The agent home's `.env` is refused three ways** — the file-tool gate in `index.ts`, the sandbox
  runner, and the launcher, which moves one aside at start — because the harness reads `<cwd>/.env`
  before the deployment's own credentials.
- **The harness may be set up before deepseek-bot.** It resolves a credential from the process's
  environment, then the app store (`~/.dsh/.credentials.yaml`), then `<cwd>/.env`, then `~/.dsh/.env`.
  A setup step (the installer, `dsh gateway`) checks that chain before asking for a key, says where it
  found one (by name, never the value), uses a key the harness already has as it is, never writes the
  app store or a profile deepseek-bot did not create (in its own, only the deepbot row), and refuses a
  write the app store would shadow. DeepSeek's own API is the default model route; OpenGateway and
  other endpoints are options, never presented as required.
- **Seatbelt matches resolved paths.** A rule naming `/var/...` matches nothing; rules are emitted
  for the path as given and as resolved. The volume ignores case.
- **Slack's working status belongs to the thread**, not to a message. The transport counts the
  messages working in each thread and sends a thread's status calls one at a time.
- **The adapter's markers** — `[this conversation]`, `[speaker]`, `[user message]` — are read back by
  the recall indexer. Any quoted text that enters the prompt goes through `defuse` first.

## Map

| path | what |
|---|---|
| `index.ts` | the adapter: turn loop, queueing, policy gates, prompt assembly, approvals, uploads |
| `transports/` | Slack, Telegram, Discord, the terminal's local socket (`local.ts`), several at once (`composite.ts`) and attachments — the platform seam (`types/transport.ts`) |
| `tui/` | `dsh`, the terminal client: `render/` (cells, diff, input, Markdown), the app, the panel, questions, `protocol.ts` (the socket's frames), `bridge.ts` (what the gateway reads for it) |
| `progress.ts` | the working message, where a platform has no status of its own |
| `recallContext.ts` | ranking and injecting passages from the recall index; `recallIndexPath` |
| `recall/` | the indexer that builds the recall index from session logs, and its launchd job |
| `notes.ts`, `usage.ts`, `injection.ts` | note hygiene, token totals, flagging instruction-like text |
| `i18n.ts`, `messages.ts` | the `language` setting (en, ko, zh) and what the bot itself says in each; the terminal's own words, English only, are `tui/strings.ts` |
| `safeWrite.ts` | writes that never follow a link the agent left in its home |
| `netPolicy.ts` | where a request may go: metadata and private addresses, and the proxy the browse tool's browser uses |
| `service/` | launcher, sandbox runner, health probe, log rotation, scenario schedule, their installers |
| `watch/` | the watch runner and its installer |
| `install.sh`, `init.sh` | the one-line installer, and the scaffold of home and profile it calls |
| `profile/`, `cordis.patch.yml` | the gateway profile template, and the bundle's own patch |
| `agent/` | templates for a new agent home: `SOUL.md`, `AGENTS.md`, `USER.md`, `MEMORY.md` |
| `types/` | hand-written types for the harness and the platforms |
| `test/` | unit suites (`*.test.ts`), real-model scenarios (`scenarios/`), the fake transport |
| `tools/` | persona check, a live Slack QA script, the secret patterns, the headless browser the agent runs (`browse.ts`) |
| `docs/` | setup, how it works, limitations, harness API notes |
| `SPEC.md`, `PLAN.md`, `CHANGELOG.md` | what it is for; what is done, open and unverified; what changed |
