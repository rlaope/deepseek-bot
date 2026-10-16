# Setup and operations

Creating the chat app for each platform, and running the services once deepseek-bot is installed.
The install itself is one line, in the [README](../README.md).

## Connecting a messenger: `dsh gateway`

The installer does not ask about messengers: the bot starts with the terminal, `dsh`. Connecting
Slack, Telegram or Discord — now or later — is one command. One messenger at a time, beside the
terminal; choosing another switches to it:

```bash
dsh gateway setup
```

```
 🐋 deepseek-bot · messenger setup
    ↑↓ move · Enter choose · Esc back · Ctrl+C quit

 ◆ Which messenger?
    ❯ 💬 Slack            ⬜ not set up
      ✈️  Telegram        ⬜ not set up
      🎮 Discord          ⬜ not set up
      🖥️  Terminal (dsh)  ✅ on
      ✔  Done
```

Pick one with ↑↓ (or j/k) and Enter; Esc goes back, Ctrl+C quits and keeps what was saved. Each
messenger is a few steps, and the browser opens where a token is made:

- **Slack** — the app is created from a filled-in manifest (pick the workspace, Next, Create); then
  the bot token from Install App and the app-level token from Basic Information.
- **Telegram** — @BotFather makes the bot and its token; then who may talk to it, by user id.
- **Discord** — the Developer Portal makes the bot; the setup checks the Message Content intent,
  opens an invite link made from the token, and offers "only me" as the application's owner.

Each token is checked with the platform as it is pasted (it shows as `*`), and asked again when it is
wrong. A messenger already set up offers to keep it, set it up again or remove it; another one asks
before switching, and the old one's tokens stay where they are. A token already saved is offered
again instead of asked for. At Done it offers one restart (now, or later) and waits for it.
`dsh gateway setup slack` goes straight to one messenger.

`setup` saves the tokens to `~/.dsh/.env` (mode 600) and puts the platform in the profile's deepbot
row — nothing else in the file changes. A switch also replaces the old messenger's channel ids
(with every channel) and its people (with the ones given).

**Without a terminal** — an agent such as Claude Code, a script — nothing is asked, and the same holds
at a terminal when a flag or the platform's token in the environment is given: name the platform,
and a token comes from the environment variable of its own name (`SLACK_BOT_TOKEN` and
`SLACK_APP_TOKEN`, `TELEGRAM_BOT_TOKEN`, `DISCORD_BOT_TOKEN`), the channels from `--channels`, the
people from `--users`. A missing answer is exit 2 and nothing is written. A token is never an argument:
arguments show in `ps` and in shell history.

A harness set up before deepseek-bot keeps what it has. A key entered in the DeepSeek Harness app
lives in its store, `~/.dsh/.credentials.yaml`, which the harness reads before `~/.dsh/.env`. `setup`
uses a token the app already holds as it is and does not ask for it; the same token given again is
fine. It refuses a different one for that name, since a copy written to `~/.dsh/.env` would never be
read: change it in the app. `setup` never writes the app's store, and never prints a value from it.
`status` says where each token and the model's key were found: the app, or `~/.dsh/.env`. The
model's key is the one the profile's `llm-pi-ai` route names, or `DEEPSEEK_API_KEY` for DeepSeek's
own API, the default.

```bash
TELEGRAM_BOT_TOKEN=… dsh gateway setup telegram --users 123456789
```

| Command | What it does |
|---|---|
| `setup <platform>` | tokens, the platform in the profile, `--channels`, `--users`; `--no-verify`, `--no-restart`. A different messenger replaces the one there |
| `remove <platform>` | takes it out of the profile; its tokens stay where they are |
| `start` / `stop` / `restart` | the gateway's launchd job. `stop` stops the health probe too, which would otherwise alert that the gateway is down; both come back at login or with `start` |
| `status [--json]` | exit 0 when the gateway runs, is connected and has its tokens. Token values are never shown |
| `manifest slack` | the Slack app manifest: Socket Mode, the scopes and events below, interactivity |

`platform` is `slack`, `telegram`, `discord` or `local` (the terminal). Exit status: 0 done; 1 failed,
not connected, or a platform that could not be reached; 2 a missing or invalid answer, with nothing
written; 130 cancelled. The bot itself cannot set up or remove a platform: its commands run in a
sandbox that cannot write `~/.dsh`. That sandbox confines writes only, so `start`, `stop` and
`restart` — calls to launchd, as `launchctl` itself is — are not kept from it.

**Who may talk to it.** `allowedUsers` in the deepbot row lists user ids; `--users` adds to it (on a
switch to another messenger it replaces it).
Empty — the default — means anyone who can reach the bot in an allowed channel. On Telegram and
Discord a direct message always reaches it, so there that is anyone who finds it: list yourself. The
terminal's user is always allowed. Someone not listed starts no turn and gets no reply, and their
approval button presses are ignored too. What they wrote can still reach the model as part of a
thread or channel's history, when a listed person asks in that thread or channel. Write ids quoted
(`'123456789'`): unquoted, YAML reads a number, and a long Discord id loses digits on the way.

## Platform setup

`dsh gateway setup` walks through these; they are here for doing it by hand, or for an agent.

### Slack

The quickest way is the manifest `dsh gateway setup` opens, or prints with `dsh gateway manifest slack`:
<https://api.slack.com/apps> → Create New App → From a manifest. It sets steps 2 to 4 except the
app-level token; generate that under Basic Information → App-Level Tokens. By hand:

1. Create an app at <https://api.slack.com/apps>.
2. **Socket Mode** → on → generate an app-level token with `connections:write` (`xapp-…`). No public
   URL is needed.
3. **OAuth & Permissions** → bot scopes: `app_mentions:read`, `chat:write`, `channels:read`,
   `channels:history` (plus `groups:history` for private channels and `im:history` for DMs),
   `users:read`, `files:read` (attachments), `files:write` (document uploads), and `reactions:write` and
   `reactions:read` (the progress marks on the person's message: 👀 when taken, a digit while it runs, ✅, ❌
   or ⏹️ at the end; without the first the bot goes on without them, asking again only after a restart; the
   second lets a restart take off only the marks it left).
4. **Event Subscriptions** → subscribe to `app_mention` (and `message.im` for DMs; `message.channels` and
   `message.groups` for `replyMode: thread`, below).
   **Interactivity & Shortcuts** → on (no request URL is needed in Socket Mode), for the approval
   buttons; without it a press does nothing and the person types allow / deny (or 허용 / 거부, 允许 / 拒绝) instead.
5. Install it to the workspace and copy the bot token (`xoxb-…`). Give both tokens to
   `dsh gateway setup`. A member id for `--users` is under a profile → ⋮ → Copy member ID.
6. `/invite` the bot into every channel it should serve. **A bot cannot see a channel it has not
   been invited to** — the most common silent failure.

The working status ("Working…", in the deployment's `language`) uses `agents.sessions.setStatus`, or
`assistant.threads.setStatus` where the workspace has not turned agent sessions on; both need only
`chat:write` (Slack's method reference, checked 2026-10-13; the second also accepts `assistant:write`
for now). If both are refused, a `⏳ … is working…` message stands in and the reply replaces it. Not yet
observed in a live workspace: no turn has run on this code there.

> One Socket Mode connection per app. A second one makes Slack split events across them and both
> start dropping messages: stop any other process using the same app first.

### Telegram

Create a bot with [@BotFather](https://t.me/BotFather) and give `dsh gateway setup` its token. In
groups, mention the bot or reply to it; for it to see group
messages at all, turn off privacy mode in BotFather (`/setprivacy`). Anyone on Telegram who finds the
bot can message it: list who may with `--users` — your numeric id is what
[@userinfobot](https://t.me/userinfobot) replies.

### Discord

Create an application at <https://discord.com/developers/applications>, add a bot, turn on the
**Message Content** privileged intent, and invite it with the `bot` scope and the *Send Messages*,
*Read Message History* and *Attach Files* permissions. Give `dsh gateway setup` the bot token; at a
terminal it checks the intent and makes the invite link for you. For `--users`: Developer Mode on, then
right-click a name → Copy User ID.

## The model provider

DeepSeek's own API is the default: press enter at the installer's provider question, give your
`DEEPSEEK_API_KEY`, and the profile uses dsh-base's `deepseek-official` route as it always has. An
existing DeepSeek install keeps working unchanged. OpenGateway and a custom endpoint are options:

| Answer | What the profile gets | Key it asks for |
|---|---|---|
| `deepseek` (default) | nothing: dsh-base's default route, `deepseek-official` | `DEEPSEEK_API_KEY` |
| `opengateway` (optional) | an `llm-pi-ai` route `og` at `https://apis.opengateway.ai/v1` for `deepseek/deepseek-v4.1-flash-ultrafast` (images, DeepSeek's thinking format, efforts off/low/medium/high), and the default model row with effort `medium` | `OG_API_KEY` |
| `custom` (optional) | an `llm-pi-ai` route `custom` for one OpenAI-compatible endpoint: it asks the base URL, the model id, the key's name, the context window and whether the model reads images | the name you gave |

Web search goes through DeepSeek's API whatever answers the chat (dsh-base's `web-search-deepseek`
row), so with another provider the installer also offers `DEEPSEEK_API_KEY`, which you may skip; the
`web_search` tool then fails when called.

A key the harness can already resolve is not asked for. The installer looks, by name only, where the
harness looks: the launch environment, the DeepSeek Harness app's own store (`~/.dsh/.credentials.yaml`,
where the app saves keys), then `~/.dsh/.env`. A key in the store is used as it is and the store is
never written; one only in your shell is copied to `~/.dsh/.env`, because the gateway runs under
launchd without your shell's environment; a new one goes to `~/.dsh/.env`. A rerun keeps the profile and
asks only for a key its route names that none of those has. To change the route later, edit the
`llm-pi-ai` and `agent-default-model` rows of the profile, and restart the gateway; `/model` in `dsh`
switches one conversation between the models the routes list.

## Running it

The installer leaves four launchd jobs; each script also takes `--status` and `--uninstall`.

```bash
dsh gateway status                                # the gateway, its platforms, tokens and connection
dsh gateway restart                               # after editing the profile by hand
~/.deepbot/service/install-service.sh --status    # the gateway: state, port, recent plugin log
node ~/.dsh/service/health-check.mjs --status     # what the bot itself reports
~/.deepbot/service/install-health.sh --uninstall  # remove the health probe (likewise the others)
```

| Job | Script | What it does |
|---|---|---|
| gateway | `service/install-service.sh` | runs the harness with this profile; restarts on exit |
| health | `service/install-health.sh` | probes every 5 minutes, restarts a disconnected bot, rotates logs |
| watch | `watch/install-watch.sh` | evaluates due watches every minute |
| recall index | `recall/install-refresh.sh` | rebuilds the recall index every 10 minutes (it is also rebuilt after every turn) |

Runtime copies (the launcher, the sandbox runner, the probe) live in `~/.dsh/service`, outside the
agent's home, and their logs in `~/.dsh/service/logs`: nothing the agent can write is ever run
unconfined. To change where a deployment's own private data is protected from the agent's commands,
set `DEEPBOT_DENY_READ` (colon-separated paths) before installing the services.

`targetChannels` in the profile's `cordis.patch.yml` accepts channel ids or `'*'` for every channel
the bot was invited to; **the plugin refuses to start with an empty list**. `replyMode: mention`
answers @-mentions in channels (DMs always); `'all'` answers every human message in them. `thread`
(Slack only; elsewhere it is `mention`) takes a mention to start, and then every message in a thread the
bot takes part in, mention or not, for a day after it was last mentioned or spoke there. Told the message
did not mention it, the model answers only when it is meant for it and otherwise posts nothing, with no
working status shown; a failure or a timeout says nothing either. Several such messages in a row are one
turn. Words such as `stop`, `usage` or `yes` are commands only with a mention; an approval may be answered
without one by the person it asks, in the buttons' words (Allow/Deny, 허용/거부, 允许/拒绝). Each such
message is a model turn, and the thread's chatter enters the session, so the channel's recall can find it.
It needs the `message.channels` and `message.groups` events (the app `dsh gateway setup` makes has them); a
thread under the bot's own post (a watch's report) needs a mention to start, like any other.
`allowedUsers` narrows who, as above.

## Windows, by hand (the terminal only)

There is no installer and there are no services on Windows yet, and no sandbox the profile can use
([#41](https://github.com/rlaope/deepseek-bot/issues/41)). The gateway can still be run by hand, in
PowerShell, with the terminal as its only platform. Checked on Windows 11 with Node 24 and
`@deepseek-ai/dsh` 0.2.0-rc.2 from npm; 0.1.0-rc.6 is too old (a turn fails with
`session.eventAt is not a function`).

```powershell
npm i -g @deepseek-ai/dsh@0.2.0-rc.2
git clone https://github.com/rlaope/deepseek-bot; cd deepseek-bot; pnpm install; pnpm run build
$repo = (Get-Location).Path
$env:DSH_HOME = "$HOME\.dsh"                     # or a separate directory, to try it apart from another setup
$agent = "$HOME\dsh-agent"                       # the agent's home: its persona, memory and files
New-Item -ItemType Directory -Force "$agent\memory", "$agent\state", "$env:DSH_HOME\profiles" | Out-Null
Copy-Item "$repo\agent\*.md" $agent
Copy-Item -Recurse "$repo\profile" "$env:DSH_HOME\profiles\agent"
# The terminal only. WriteAllText leaves out the BOM that PowerShell 5.1's Set-Content would add.
$p = "$env:DSH_HOME\profiles\agent\cordis.patch.yml"
[IO.File]::WriteAllText($p, ([IO.File]::ReadAllText($p) -replace '(?m)^    platform: slack$', "    platform: ['local']"))
dsh plugin --profile agent add $repo
Set-Location $agent; dsh --profile agent --host 127.0.0.1 --port 19500
```

Give it the model's key in the web UI the last line opens (Settings → Models). Then, in another
PowerShell window, with the same `DSH_HOME`:

```powershell
node <repo>\dist\tui\main.js
```

What to expect there:

- **Commands are refused.** The profile names `service/confined-runner.sh` as the sandbox runner,
  which does not exist on Windows, and the harness refuses to run a command unconfined rather than
  run it: `no sandbox backend is usable on this host; refusing to run the command unconfined`.
  Reading, writing and editing files in the agent's home work; a file-tool read outside it is
  refused.
- No watches or health probe run, and nothing restarts the gateway if it exits.
