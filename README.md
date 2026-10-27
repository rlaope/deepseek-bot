<p align="center">
  <img src="docs/deepseek-bot.svg" width="720" alt="deepseek-bot: the DeepSeek whale with Bot stamped across its lower corner, beside the deepseek wordmark">
</p>

<h1 align="center">deepseek-bot</h1>

<p align="center">
  <strong>The agentic memory &amp; gateway for DeepSeek Harness.</strong><br>
  One always-on agent that remembers across conversations,<br>
  and answers in Slack, Discord, Telegram and the terminal.
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

DeepSeek Harness runs an agent for one session at a time. deepseek-bot is a plugin for it that adds
the two things a long-running agent needs:

- **Memory.** Every conversation is a durable session that survives restarts. A persona, notes the
  agent keeps for itself, and a recall index over past conversations are brought into each turn, so
  it can say what was decided last week, with the date, or say plainly that it does not know.
- **A gateway.** One agent, reachable where people already talk: Slack, Discord, Telegram, and a
  fullscreen terminal (`dsh`). It runs as a supervised macOS service, its commands run in a sandbox,
  and anything destructive waits for a yes in the conversation.

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
token is made, checks each token as you paste it, and offers to restart the bot. `dsh gateway status`
says whether it is up. `dsh update` updates.

<details>
<summary>From an agent, or a script</summary>

Without a terminal the installer asks nothing: the language comes from `LANG`, the model route is
DeepSeek's own, a key is used where the harness already has it (its app, `~/.dsh/.env`), and the
DeepSeek Harness app is downloaded only when told to:

```bash
curl -fsSL https://raw.githubusercontent.com/rlaope/deepseek-bot/master/install.sh | DEEPBOT_INSTALL_HARNESS=1 bash
```

`dsh gateway setup <slack|telegram|discord>` then reads the platform's tokens from the environment.
Where to put the key first, and what each stop means: [installing without a
terminal](docs/setup.md#installing-without-a-terminal).

</details>

<img src="docs/opengateway-logo.svg" height="16" alt="OpenGateway"> **Optional: faster on [OpenGateway](https://opengateway.ai).** It serves `deepseek/deepseek-v4.1-flash-ultrafast`
on an OpenAI-compatible endpoint (`https://apis.opengateway.ai/v1`), which it lists at 12× the speed and
1/30 the price of a Fable-class model. This bot is developed against it; the model route in
[profile/cordis.patch.yml](profile/cordis.patch.yml) shows where the endpoint and the model go.

<p align="center">
  <img src="docs/demo.gif" width="720" alt="dsh: a question to deepseek-v4.1-flash-ultrafast in the terminal, answered in about a second">
</p>

## Memory

Four layers, each with one owner. The agent reads all of them; it can write only the ones in its home.

| Layer | What it holds | Where | Written by |
|---|---|---|---|
| Working | this conversation | the harness's session log, one per thread or chat | the harness |
| Identity | who the agent is, how it speaks, its rules | `SOUL.md`, `AGENTS.md` in the agent home | you |
| Semantic | durable facts about you and the work, dated | `USER.md`, `MEMORY.md`, `memory/*.md` | the agent (you may edit) |
| Episodic | what was said in earlier conversations | a recall index under `~/.dsh/recall/`, outside the agent home | a host-side indexer |

- **Recall is scoped to the channel.** Passages come only from the conversation's own channel, so a
  private conversation never surfaces in a public one. The agent cannot search the index itself; the
  adapter injects passages before the turn, marked as content, not instructions.
- **Recall matches words, and the model picks among the latest.** Passages are ranked by the rare
  words they share with the message; for a message that points at the past, the conversation's model
  also chooses among the channel's latest 40 passages, which finds a past said in other words. There is
  no vector index: an older passage put in other words can still be missed.
- **Not found is an answer.** Asked about something never said, it says so rather than guessing.
- **The persona is plain Markdown.** Edit `SOUL.md` and it changes. `npm run persona` checks the files
  against their budgets, and flags duplicated facts, undated lines and secrets.

How each layer reaches the prompt, and why: [docs/how-it-works.md](docs/how-it-works.md#memory-the-layers-and-who-writes-what).

## Gateway

| Platform | How | State |
|---|---|---|
| Slack | Socket Mode; threads, streaming, approval buttons, uploads | used live |
| Terminal (`dsh`) | a local socket; streamed answers, tool calls with their diffs, approvals and questions in place | used live |
| Discord | gateway websocket and REST; buttons, uploads | tested against a mocked API, not a live server |
| Telegram | long polling; buttons, uploads, Markdown | tested against a mocked API, not a live bot |

One messenger at a time beside the terminal: every conversation the terminal does not claim goes to the
first messenger listed, so a second would never be answered, and `dsh gateway setup` replaces rather
than adds. While a turn runs, the platform's own indicator shows: Slack's working status under the
thread, "typing…" on Discord and Telegram.

**Talking to it.** Mention it in a channel or message it directly; it answers in the thread. A
follow-up sent while it works waits its turn. `stop` ends the running turn, `usage` shows the thread's
token totals, and `allow` or `deny` (or the buttons) answers a request for approval. The words are
understood in English, Korean and Chinese; the bot's own notices follow the `language` setting
(`en` by default, `ko`, `zh`).

**What it can do in a turn.** Write a docx, xlsx or pptx and upload it into the conversation; read a
link, with a headless browser for a page that draws itself; look at an image, with a model that
accepts one; use the tools of an MCP server you add (`dsh gateway mcp add`); run a command in the
background and post what it found when it finishes. It speaks first only when asked to: "tell me
when this changes" becomes a watch, "remind me on Friday" a reminder.

**Containment.** Its commands run under a Seatbelt sandbox that writes only its own workspace and
cannot read the deployment's tokens, other agents' files, the stored conversations or your
credential files. A command that deletes or overwrites waits for the person who asked. Text in a
thread or an attachment that tries to give it orders is flagged before the model sees it. On
Telegram and Discord anyone who finds the bot can message it: list who may with
`dsh gateway setup telegram --users <your id>`.

**Staying up.** It runs as launchd jobs: it reconnects on its own, a probe restarts it when it is
not connected and can alert you when it does not recover, and a conversation is told when a restart
cut its turn short.

## How well it works

Three kinds of evidence, not equivalent:

| Evidence | What it covers | Where it runs |
|---|---|---|
| Unit suites (`pnpm test`) | the adapter, every transport, the sandbox runner, the installer and `dsh gateway`, against fakes | CI, on every change |
| Scenarios (`test/scenarios/*.json`) | recall across conversations, approvals, read isolation, tenants, injection, the browser, MCP, background jobs — against a real model, in a throwaway home | by hand, or daily once `service/install-scenarios.sh` schedules them; not in CI |
| Live use | Slack and the terminal | the developer's own deployment |

What is not verified is listed, item by item, in [PLAN.md](PLAN.md#unverified). The short version:

- macOS only. On Windows it builds, its suites pass and the terminal can be run by hand, but the
  installer, services, sandbox and watches are not ported, so every command is refused
  ([Windows, by hand](docs/setup.md#windows-by-hand-the-terminal-only)).
- Discord and Telegram have not had a live round trip.
- The sandbox is a policy boundary, not a separate OS user. An MCP server runs outside it, with the
  gateway's rights: add only servers you trust.
- DeepSeek Harness is a release candidate, and this project leans on its internals (session driving,
  message construction). Pin your version.

## Built small

TypeScript. The plugin imports nothing from `node_modules`; the one runtime dependency,
`playwright-core` (pinned), is loaded only by the browse tool. Recall needs no vector store and no
database: the index is a JSONL file.

## More

- [Setup and operations](docs/setup.md): connecting a messenger, creating the bot on each platform,
  the model provider, MCP servers, the agent's network, running the services
- [How it works](docs/how-it-works.md): the design, and the evidence behind each claim
- [Limitations](docs/limitations.md) · [Specification](SPEC.md) · [Plan](PLAN.md) · [Changelog](CHANGELOG.md)
- For contributors and agents: [working rules](AGENTS.md) · [vocabulary](CONTEXT.md)

## License

[MIT](LICENSE). deepseek-bot is an independent project, not affiliated with or endorsed by DeepSeek.
The whale and the wordmark are the DeepSeek logo's; the DeepSeek name and logo belong to their owner.
