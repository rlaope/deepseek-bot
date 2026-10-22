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
*Read Message History*, *Attach Files* and *Add Reactions* permissions (the last for the progress marks; a
channel that denies it just goes without them). Give `dsh gateway setup` the bot token; at a
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

## MCP servers: tools from other programs

The harness connects to MCP servers itself, with its `@deepseek-ai/dsh-mcp-client` package; deepseek-bot
adds nothing of its own. A server is one row in the profile's `cordis.patch.yml`. The server's tools reach
the model as `mcp__<serverName>__<tool>`.

**One command does it.** Run it in your own terminal; the bot gives you the line filled in when you ask it to
connect one, and cannot run it itself (its sandbox does not write the profile or `~/.dsh/.env`):

```sh
dsh gateway mcp add notion --env NOTION_TOKEN -- npx -y @notionhq/notion-mcp-server   # asks for NOTION_TOKEN, not shown
dsh gateway mcp add web --url https://mcp.example.com/mcp --bearer MCP_TOKEN   # a hosted server
dsh gateway mcp list                                                          # what is connected, and each credential
dsh gateway mcp remove notion
```

It writes what the points below are about: the program by its absolute path and a PATH beside it, the
credential to `~/.dsh/.env` (asked for at a terminal, not shown, or read from the variable of its name in a
script; one already there is kept unless another is given, and the bot's own keys are never replaced from here), the row reading it with `!!js process.env.NAME`, and `askTools` asking for every
call of the server's tools (`--ask <tool>` for only the ones that act, `--no-ask` for none). Then it restarts
the gateway. A credential only in the app's store is explained, then asked for (without a terminal, refused with why): a
server reads the gateway's environment, which `~/.dsh/.env` fills and the store does not. `--env NAME=value` passes a setting that is not
a secret; a name, a value, a server argument or a URL that looks like a credential is refused as an argument. `remove` takes out only a row
`add` wrote, and every askTools entry for that server's tools (`mcp__<name>__…`, one written by hand included); the profile is then as it was (a profile ending in a newline, byte for byte). By hand, the row goes in an
`- insert:` list (the template's own has the office rows), at the same indent, and the gateway is restarted:

```yaml
- insert:
    # ... the rows already there ...
    - id: mcp-example
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: example                 # [A-Za-z0-9_-], up to 32; the tools' prefix
        transport: stdio                    # or streamable-http, with url: and headers:
        command: /absolute/path/to/server   # see PATH below
        args: ['--some-flag']
        env:
          PATH: /opt/homebrew/bin:/usr/bin:/bin
          SERVICE_TOKEN: !!js process.env.EXAMPLE_TOKEN ?? ''
```

`test/scenarios/mcp.json` carries a working row of this shape, for `test/fixtures/mcp-fixture.mjs`.

- **PATH.** Under launchd the gateway's PATH is `/usr/bin:/bin:/usr/sbin:/sbin`, so a bare `npx`, `uvx` or
  `node` is not found. Name the program by its absolute path (`/opt/homebrew/bin` on Apple silicon,
  `/usr/local/bin` on Intel, elsewhere for nvm or volta), and give the server a PATH in `env:` when it
  starts others (`npx` runs `node`). A first `npx -y` downloads the package within the 60 s the server
  has to start.
- **Credentials go in `~/.dsh/.env`, by name.** The harness reads that file into its environment at
  start, and `!!js process.env.NAME` hands one value to the server; `?? ''` keeps a missing one from
  breaking the row. A key the DeepSeek Harness app keeps in its own store (`~/.dsh/.credentials.yaml`) is
  not in that environment. Never put a credential in the agent home: the agent's commands read it.
- **A server is trusted code.** A stdio server is the gateway's child, not one of the agent's commands,
  so the sandbox runner does not confine it. It reads what the gateway reads: the bot's own credential
  files (`~/.dsh/.env`, the app's store), its sessions and their index, the profiles. It writes what your
  user may, and reaches the network freely. The harness passes it no variable from its own environment
  whose name holds KEY, TOKEN, SECRET or PASSWORD unless `env:` names it, but that keeps the values out of
  its environment, not out of its reach. Add only servers you would run yourself, with tokens of the
  narrowest scope that does the job.
- **A desktop-control server is that, with your screen.** One that sees the screen and moves the mouse
  or types in other apps needs macOS's Accessibility and Screen Recording permissions; given them, it acts
  with them outside the sandbox, for whoever can talk to the bot, in every conversation. deepseek-bot does
  not support one (`PLAN.md`, Decided against), and none has been tried with it. If you add one
  regardless, name its tools in `askTools`, so each call is asked for.
- **The adapter's gates do not apply to its tools, unless `askTools` names them.** The approval gate
  reads shell commands (`approvalPatterns`), the read scope the file tools, the fetch allowlist
  `web_fetch`; a server's tools pass all three. They are shared by every conversation, tenants included.
  What they return reaches the model unmarked: the warning for instruction-like text covers channel
  history and attachments only.
- **Ask before a tool that acts.** `askTools` in the deepbot row names tools that are asked for on every
  call, through the same approval as a destructive command: `askTools: ['mcp__google__send_gmail_message',
  'mcp__google__manage_*']`. An entry ending in `*` names every tool that starts with it. The question
  goes to the conversation the turn belongs to, a reminder's included, and shows every argument (mail
  bodies and recipients appear in that conversation), each cut at 200 characters with the cut said. A
  call whose arguments are too long to show whole, or whose turn belongs to no conversation, is refused.

`test/scenarios/mcp.json` is the check, in the daily scenario run: it adds the fixture's row to a copy of
the test profile, and a real model must answer with a code that only the fixture's tool gives.
`test/scenarios/mcp-ask.json` checks `askTools` the same way.

### Mail and calendar (Google)

Google's own MCP servers for Gmail and Calendar are in developer preview and expect the MCP client to run
an OAuth sign-in. The harness's client sends fixed headers, and a Google access token lasts an hour, so
those servers are out of reach for now. A local server that does the OAuth itself works with it:
[`workspace-mcp`](https://github.com/taylorwilsdon/google_workspace_mcp) (Python, run with `uvx`) is one.
Set up once, by you:

1. In a Google Cloud project, enable the Gmail and Google Calendar APIs and create an OAuth client of
   type *Desktop app*. Put its id and secret in `~/.dsh/.env` as `GOOGLE_OAUTH_CLIENT_ID` and
   `GOOGLE_OAUTH_CLIENT_SECRET`.
2. Add the row. `WORKSPACE_MCP_CREDENTIALS_DIR` keeps the tokens it saves under the harness home, which
   the agent's commands cannot read; by default it saves them in `~/.google_workspace_mcp/credentials`,
   which they can. `--read-only` in `args` leaves out every tool that acts.

   ```yaml
       - id: mcp-google
         name: '@deepseek-ai/dsh-mcp-client'
         config:
           serverName: google
           transport: stdio
           command: /opt/homebrew/bin/uvx
           args: ['workspace-mcp', '--tools', 'gmail', 'calendar']
           env:
             PATH: /opt/homebrew/bin:/usr/bin:/bin
             GOOGLE_OAUTH_CLIENT_ID: !!js process.env.GOOGLE_OAUTH_CLIENT_ID ?? ''
             GOOGLE_OAUTH_CLIENT_SECRET: !!js process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? ''
             WORKSPACE_MCP_CREDENTIALS_DIR: !!js dshHomePath('mcp/google')
   ```

3. Unless it is read-only, ask before what acts. `askTools: ['mcp__google__*']` asks before every call,
   reads included; the narrower list below covers the tools that act in the current release
   (`--tools gmail calendar`), but it names what exists today, and a tool a new release adds runs unasked.
   Pin the release you checked (`'workspace-mcp==<version>'` in `args`) if you use it:
   `askTools: ['mcp__google__send_*', 'mcp__google__draft_*', 'mcp__google__manage_*', 'mcp__google__modify_*', 'mcp__google__batch_modify_*', 'mcp__google__create_*']`.
4. Restart the gateway and ask the bot about your mail. The first call that needs Google answers with a
   sign-in link, and the server opens it in this Mac's browser; sign in once, as yourself.

Not yet run here: no OAuth client was available when this was written (`PLAN.md`).

## Files outside the agent's home

The agent writes only in its home. When it needs a file of yours outside it, a file tool's read
(`read`, `read_image`, `grep`, `glob`, the editor's view) is held and the conversation is asked, with
the approval buttons, naming where the read lands (a link is shown with its target);
`readOutside: deny` in the deepbot row refuses instead. Never asked about, by the file tools:
`~/.ssh`, `~/.aws`, `~/.gnupg`, the keychain files, `~/.config/gh`, `~/.config/gcloud`, `~/.azure`,
`~/.kube`, `~/.netrc`, `~/.git-credentials`, the registries' and tools' token files (`~/.npmrc`, `~/.pypirc`,
`~/.docker/config.json`, other agents' CLI logins and the rest of the runner's `credential_files`, see
[how it works](how-it-works.md)), the harness home, any `.env`, and a folder that holds
one of them (a search of your home or of `~/.config` is refused; name a narrower folder). The agent's
commands are refused the same places, and the harness home's own secrets (its `.env`, the app store,
sessions, profiles); a `.env` elsewhere is refused to the file tools, not to commands. Keychain items
are another matter: in an unlocked login keychain, `security` and git's osxkeychain helper still hand
them out to commands. With `~/.gnupg` refused, a `git commit` the agent makes fails if your git
config signs commits. Commands read other files outside without asking: to keep a directory from the
agent altogether, add it to `DEEPBOT_DENY_READ` (absolute paths, colon-separated) before installing
the services. To give it a file for good, put a copy in its home.

Nor is your desktop the agent's: its commands cannot script or start other apps (`osascript`,
`automator`, `shortcuts`, `open`), take the screen, or read or replace what you copied. Desktop control is
decided against for now (`PLAN.md`).

## The agent's network

The sandbox confines what the agent's commands read and write. Where they connect is `commandNetwork`, in
the deepbot row:

| Value | A command may connect to |
|---|---|
| `open` (the default) | anything this machine can reach, as before |
| `local` | public addresses, this machine and the local network (an intranet, a dev server), through the gateway's proxy; never a cloud metadata service |
| `public` | public addresses only, through the gateway's proxy |

Bounded, a command makes one connection, to the proxy: `curl`, `git` over https, `pip`, `npm` and node's
`fetch` are pointed at it, and what ignores a proxy (ssh and `git` over ssh, a raw socket, a UDP service,
a database client to a local server) reaches nothing, this machine's own services included. Names are
not looked up either (the proxy resolves what goes through it); a command cannot start or script another app
(`open`, `osascript`, `automator`, `shortcuts`), which would fetch outside the sandbox, in any mode. What
the proxy refuses is in the bot's log as `command network: blocked …`, at most twenty a minute. The browse
tool goes through the same proxy, under its rule: with `local`, any page it opens may reach the local
network. If the gateway stops, the agent's commands have no way out until it starts again. Restart the
gateway after changing the value.

What it does not bound: MCP servers and the harness's own tools (`web_fetch` has its own rule), which
are not the agent's commands; a program the agent compiles to send Apple Events itself; and anything
on this machine that finds the proxy's port, which takes no password (it gives no more reach than that
program already has). `public` bounds addresses, not what is sent to them: data can still leave in a
request to a public site. The sandbox runner finds the gateway's proxy by `DEEPBOT_HOME`; the bot logs
a warning when that is not its home.

## Sites that need a sign-in

The agent's browser (`dist/tools/browse.js`) keeps no sign-in of its own. For a site you want it to read as
you, sign in once in a window, in your own terminal, and keep the session in the agent's workspace:

```bash
# ~/.deepbot is an install's checkout; use your clone's path if you run from one.
node ~/.deepbot/node_modules/playwright-core/cli.js install chromium      # once: a browser with a window
node ~/.deepbot/dist/tools/browse.js --login 'https://intranet.example/' --state ~/dsh-agent/.browser/intranet.json
```

Sign in in the window, then close it (or press ctrl+c in the terminal): the session, its cookies and site
storage, is kept in that file with mode 600. The bot names the files in its workspace's `.browser/` to the
agent, which browses as that account by adding `--state <file>`. A run that went through writes the file
back, so renewed cookies are kept, and keeps the one before as `<file>.prev`; a run that failed leaves it
as it was, and one that ends signed out says so. A path that is a link, or in a directory that is one, is
refused: the agent can make links in its workspace, and `--login` writes as you. With tenant isolation, put
a tenant's session in that tenant's directory, under its own `.browser/`.

The file is the account: the agent's commands can read it, and whoever can talk to the bot in that
workspace can browse as you there. So can a page: the pages the agent reads are not yours, and one that tells
it to read the file and send it somewhere asks for nothing a command cannot do, which `commandNetwork` does not
stop while a public address may be reached (found by the final review). Keep one only for an account you would
hand the bot and whoever writes the pages it reads, with the narrowest access the account allows, and delete the
file (and its `.prev`) to sign it out. Some sites refuse sign-in in a browser driven by automation, or tie a
session to more than cookies; those stay out of reach.

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

## Installing without a terminal

The install line in the README asks its questions at the terminal, reading `/dev/tty`. Run by an agent
such as Claude Code, or by a script, there is none, and it asks nothing:

- **DeepSeek Harness.** When the app is missing it is downloaded only when told to:
  `curl … | DEEPBOT_INSTALL_HARNESS=1 bash` (the variable goes on `bash`, not on `curl`). It is DeepSeek's
  own build for this Mac, the one the app's updater names (on `download.deepseek.com`), checked against the
  feed's sha512 and size before it is placed in `/Applications`; a few hundred MB. Without the variable the
  run stops and says this, and nothing is downloaded; `DEEPBOT_INSTALL_HARNESS=0` never installs it. A
  `DSH_BIN` names a harness CLI kept elsewhere: then nothing is downloaded, and one that is not there is an
  error. At a terminal the same question is asked, Enter meaning yes, and the variable answers it.
- **The language** of the bot's own messages is the environment's (`LC_ALL`, `LC_MESSAGES`, `LANG`): `ko`,
  `zh`, else `en`.
- **The model route** is DeepSeek's own API. OpenGateway or a custom endpoint is chosen at a terminal, or
  added to the profile afterwards ([the model provider](#the-model-provider)).
- **The model's key** is not asked for. One the harness already has — in the app's store, or in `~/.dsh/.env`
  — is used as it is; a key only exported in the shell is left alone, since it may be another program's. To
  give one, write it to `~/.dsh/.env` (mode 600) before running the installer. `dsh gateway status` says
  where the model's key was found, or that it was not.
- **The services** are installed and started. One that fails to install fails the run, which says which.

```bash
mkdir -p ~/.dsh && touch ~/.dsh/.env && chmod 600 ~/.dsh/.env
grep -q '^DEEPSEEK_API_KEY=' ~/.dsh/.env || printf 'DEEPSEEK_API_KEY=%s\n' "$DEEPSEEK_API_KEY" >> ~/.dsh/.env
curl -fsSL https://raw.githubusercontent.com/rlaope/deepseek-bot/master/install.sh | DEEPBOT_INSTALL_HARNESS=1 bash
dsh gateway status
```

A messenger is connected the same way, from the environment:
[connecting a messenger](#connecting-a-messenger-dsh-gateway).

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
