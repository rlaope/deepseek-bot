<p align="center">
  <img src="docs/deepseek-bot.svg" width="720" alt="deepseek-bot: the DeepSeek whale with Bot stamped across its lower corner, beside the deepseek wordmark">
</p>

<h1 align="center">deepseek-bot</h1>

<p align="center">
  <strong>An always-on AI teammate for Slack, Discord and Telegram, built on DeepSeek Harness.</strong><br>
  It remembers your threads, reads what you send it, drafts documents,<br>
  and asks before it deletes anything.
</p>

<p align="center">
  <a href="https://github.com/rlaope/deepseek-bot/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/rlaope/deepseek-bot/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="license: MIT" src="https://img.shields.io/badge/license-MIT-4D6BFE">
  <img alt="node 22+" src="https://img.shields.io/badge/node-22%2B-4D6BFE">
</p>

<p align="center">
  <img src="docs/banner.svg" width="720" alt="DEEPSEEK BOT">
</p>

> **Sponsors**
> These are our sponsors. They help keep deepseek-bot going as a personal side project.
> | [<img alt="OpenGateway" src="docs/opengateway-logo.svg" width="156px" />](https://opengateway.ai/) | **[OpenGateway](https://opengateway.ai/)** sponsors deepseek-bot. An OpenAI-compatible gateway that puts many model providers behind one API. Thank you for backing open source. |
> | :-----| :----- |

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/rlaope/deepseek-bot/master/install.sh | bash
dsh                    # talk to it in the terminal
dsh gateway setup      # connect Slack, Telegram or Discord: ↑↓ and Enter
```

The first line installs it, and running it again updates. It needs macOS with Node.js 22+, the
DeepSeek Harness app and a DeepSeek API key — none asked for if the harness already has one. When the
app is missing, the installer offers to download it from DeepSeek's own server (a few hundred MB, into
`/Applications`), checked against the build's published hash. DeepSeek's own API is the default and
needs nothing else; OpenGateway or another OpenAI-compatible endpoint is an option the installer offers.
The bot starts with the terminal, `dsh`.

`dsh gateway setup` connects a messenger: pick one with ↑↓ and Enter, and it opens the page where each
token is made, checks each token as you paste it, and offers to restart the bot. Without a terminal it takes the
tokens from the environment instead, so an agent can do it for you ([docs/setup.md](docs/setup.md));
`dsh gateway status` says whether it is up.

### Update

```bash
dsh update
```

### From an agent, or a script

Without a terminal the installer asks nothing: the language comes from `LANG`, the model route is
DeepSeek's own, a key is used where the harness already has it (its app, `~/.dsh/.env`), and the
DeepSeek Harness app is downloaded only when told to:

```bash
curl -fsSL https://raw.githubusercontent.com/rlaope/deepseek-bot/master/install.sh | DEEPBOT_INSTALL_HARNESS=1 bash
```

Where to put the key first, and what each stop means: [installing without a
terminal](docs/setup.md#installing-without-a-terminal).

<img src="docs/opengateway-logo.svg" height="16" alt="OpenGateway"> **Optional: faster on [OpenGateway](https://opengateway.ai).** It serves `deepseek/deepseek-v4.1-flash-ultrafast`
on an OpenAI-compatible endpoint (`https://apis.opengateway.ai/v1`), which it lists at 12× the speed and
1/30 the price of a Fable-class model. This bot is developed against it; the model route in
[profile/cordis.patch.yml](profile/cordis.patch.yml) shows where the endpoint and the model go.

## What it does

<p align="center">
  <img src="docs/demo.gif" width="720" alt="dsh: a question to deepseek-v4.1-flash-ultrafast in the terminal, answered in about a second">
</p>

**It lives where your team already talks.** Mention it in a Slack channel, a Discord server or a
Telegram group, or message it directly. Nobody has to open another tool to ask it something.

**It has a terminal too.** `dsh` opens the same agent fullscreen in a terminal, beside
Slack or on its own: answers stream in, tool calls show their diffs and results, and approvals and
questions are answered in place. See [the terminal](docs/how-it-works.md#the-terminal-dsh).

**You can see it working.** The moment it takes a message the platform's own indicator shows:
Slack's working status under the thread, "typing…" on Discord and Telegram. The answer is the only
notification you get.

**It remembers.** Every thread is a conversation that survives restarts. Ask what was decided last
week and it finds the passage and says what it implies, drawing only on the channel you are in, so
a private conversation never surfaces in a public one.

**It has a character you write.** Who it is, how it speaks and what it knows about you and your work
are plain Markdown files in its home. Edit them and it changes; it keeps its own notes there as it
learns.

**It does the work, not just the talking.** Ask for a report and it writes the docx, xlsx or pptx
and uploads it into the conversation. Send it a link and it reads the page; send an image and, with
a model that accepts images, it looks at it.

**It asks before anything destructive.** A command that deletes or overwrites stops and waits for
the person who asked: press the button, or type `allow` or `deny`.

**It works in a room of its own.** Its commands run in a sandbox that can write only its own
workspace, and cannot read the deployment's tokens, other agents' files or the stored
conversations, nor reach your SSH agent or password manager. Text in a thread or an attachment that
tries to give it orders is flagged before the model sees it.

**It speaks first only when asked to.** "Tell me when this changes" becomes a watch that checks on a
schedule; "remind me on Friday" becomes a reminder.

**It stays up.** It runs as a supervised service: it reconnects on its own, is restarted when a
probe finds it unhealthy, can alert you when it does not recover, and tells a conversation when a
restart cut its turn short.

**It is small enough to read.** TypeScript with zero runtime dependencies, covered by unit suites
and by scenarios run against a real model.

## Talking to it

- Mention it in a channel, or send it a direct message. It answers in the thread.
- A follow-up sent while it is working waits its turn.
- `stop` ends the turn that is running.
- `usage` shows the thread's token totals.
- `allow` or `deny`, or the buttons, answers a request for approval.

## Good to know

- macOS only: the services are launchd jobs and the sandbox is Seatbelt. On Windows it builds, the
  terminal's local transport listens on a named pipe, `dsh` forwards to the harness CLI named by
  `DSH_BIN` or else to npm's, found beside its `dsh.cmd` on PATH, and the suites in CI's Windows job
  pass; the installer, services, sandbox and watches are not ported there. The gateway can be run by
  hand with the terminal only, and refuses every command for want of a sandbox
  ([Windows, by hand](docs/setup.md#windows-by-hand-the-terminal-only)). With no sandbox the tool
  gate is no boundary on Windows: it checks file tools, and only the sandbox holds commands off. Its `.env`
  check follows Windows' own walk there (`..` cancelled before links, drive-relative paths, NTFS
  streams, 8.3 short names), checked against real writes on NTFS.
  Another user can open the pipe read-only: that gets nothing, and gives way to a terminal when the
  places are full.
- Recall matches words, not meaning. A paraphrase that shares no distinctive word can miss.
- Reading a link is a plain fetch: a page that renders in the browser comes back empty.
- Slack is used live. Discord and Telegram are tested against mocked APIs, not yet a live server.
- On Telegram and Discord anyone who finds the bot can message it. List who may:
  `dsh gateway setup telegram --users <your id>` ([who may talk to it](docs/setup.md#connecting-a-messenger-dsh-gateway)).
- Its built-in notices and button labels are in Korean; what it says otherwise follows its persona.
- DeepSeek Harness is a release candidate, and this project leans on its internals. Pin your version.

## More

- [Setup and operations](docs/setup.md): connecting a messenger (`dsh gateway`), creating the bot on
  each platform, running the services
- [How it works](docs/how-it-works.md): the design, and the evidence behind each claim
- [Limitations](docs/limitations.md) · [Changelog](CHANGELOG.md) · [Plan](PLAN.md)
- For contributors and agents: [working rules](AGENTS.md) · [vocabulary](CONTEXT.md)

## License

[MIT](LICENSE). deepseek-bot is an independent project, not affiliated with or endorsed by DeepSeek.
The whale and the wordmark are the DeepSeek logo's; the DeepSeek name and logo belong to their owner.
