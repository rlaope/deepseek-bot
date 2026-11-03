# CONTEXT.md — the words this project uses

One meaning per word. Where a word has been used two ways, the entry says which one is meant here
and what to call the other. The rules for changing the code are in [AGENTS.md](AGENTS.md).

## The pieces

- **deepseek-bot** — this project. In code its plugin id is **`deepbot`** (also `DEEPBOT_*`
  variables and `ai.deepbot.*` launchd jobs); the two names mean the same thing.
- **harness** — DeepSeek Harness, the runtime this is a plugin for. Its CLI is `dsh`. Many use it
  without deepseek-bot, some on a subscription, and set it up themselves first: its model keys, its
  own profiles and its app's credential store are theirs. deepseek-bot is added on top of that.
- **gateway** — the long-running harness process that loads the plugin and serves conversations.
- **profile** — the harness configuration a gateway runs with: which plugins, which sandbox, which
  approval policy. It lives under the harness home, not in this repository.
- **adapter** — the plugin itself (`index.ts`): everything between a platform message and a turn.
- **transport** — the part that speaks one platform's API (Slack, Telegram, Discord) or serves the
  terminal over a local socket. The adapter talks to a transport only through `types/transport.ts`.
- **platform** — Slack, Telegram, Discord or the terminal. Not "channel", which is a place inside one.
- **terminal** — `dsh`, a fullscreen client that talks to the gateway over a local socket. It
  is only the screen: the conversation, its session and its memory stay in the gateway.
  `dsh` shares its name with the harness CLI: given anything but its own flags, it runs that CLI.

## Places on disk

Never say just "home".

- **agent home** — the directory the agent works in and may write (`DEEPBOT_HOME`, by default
  `~/dsh-agent`). It holds the persona files and the notes. Also the sandbox's **workspace**.
- **harness home** — the harness's own directory (`~/.dsh`): profiles, credentials, the session
  store, the recall index, the deployed service copies. The agent's commands cannot read it, except
  the runtimes the harness ships there (`dsh-runtimes`).
- **app store** — `~/.dsh/.credentials.yaml`, where the DeepSeek Harness app keeps the keys entered
  in it: the names under `refs:`. The harness reads it before `~/.dsh/.env`. deepseek-bot reads its
  names and never writes it. Not `~/.dsh/.env`, which is where deepseek-bot's own setup writes.
- **source checkout** — where the code is (`~/.deepbot` for an install, or a clone).
- **tenant directory** — with tenant isolation on, a conversation group's own directory under the
  agent home, used in place of the agent home for that group.

## A conversation

- **target** — where a message goes: a channel and, on Slack, a thread (in a Telegram forum, a topic).
- **conversation** — one target's exchange over time: a Slack thread, a Telegram chat or forum
  topic, a Discord channel or thread (a channel of its own, whose **parent** is the channel it is in). Its **conversation key** is `<channel>` or `<channel>:<thread>`.
- **session** — the harness's durable log of one conversation. The adapter keeps the mapping from
  conversation key to session id; that mapping is the authority on which channel a session is in.
- **turn** — one message taken, worked on and answered. One turn runs at a time per conversation;
  later messages **wait**.
- **in-flight record** — the note, kept on disk, that a turn is running, so a restart can tell the
  conversation its turn was lost. What a process finds at start it sets aside (`restartLost`), so it
  reports the previous process's turns and never its own.

## What the model is given

- **persona files** — `SOUL.md` (who the agent is), `USER.md` (who it works for), `MEMORY.md` (what
  it knows about the work), in the agent home. The adapter sends them. `AGENTS.md` in the agent
  home is the agent's operating rules, sent by the harness; it is not this repository's `AGENTS.md`.
- **notes** — files under `memory/` in the agent home that the agent writes for itself.
- **standing block** — the part of the prompt that does not change between turns (persona, notes
  list, where the conversation is). Sent once per conversation and again only when it changes.
- **markers** — the adapter's own labels in the prompt: `[this conversation]`, `[speaker]`,
  `[user message]`. The recall indexer reads them back, so quoted text is **defused** — its
  markers marked as quoted — before it enters a prompt.
- **recall** — bringing passages of earlier conversations into a turn. The **recall index** is built
  from session logs by the **indexer**, read only by the adapter, and scoped to the channel.
  Not "memory", which here means the notes and persona files.

## Showing work, asking, delivering

- **language** — the deployment's `language` setting (`en`, `ko`, `zh`): the words the bot itself
  says. Not the language of the model's answers, which follows the persona and the person, and not the
  terminal's own interface (its hints, labels, pickers, status), which is English.
- **working status** — the platform's own sign that the bot is busy: Slack's status under a thread,
  "typing" elsewhere. The **working message** is the bot's own placeholder message, used only where
  the status is refused.
- **approval** — the person's yes or no to a command the harness holds as destructive. An
  **approval request** is the message asking; its buttons belong to that one request.
- **upload** — sending a document the turn made into the conversation as a file.
- **watch** — a command the agent set up to run on a schedule and report when its output changes.
  A **reminder** is a message at a time; it goes through the harness's scheduler, not the watch
  runner.

## Keeping it contained

- **sandbox**, **runner** — `service/confined-runner.sh`, which runs the agent's commands under
  Seatbelt: **read-only** or **workspace-write**.
- **tool gate** — the adapter's check on a file-tool call before it runs (the read scope, the
  `.env` refusal). Not "the gates".
- **the gates** — `pnpm run typecheck` and `pnpm test`, both, before a commit.
- **read scope** — the directories the file tools may read.

## Checking it

- **suite** — a unit test file, `test/<name>.test.ts`, that Node runs as TypeScript, without a model.
- **scenario** — a scripted conversation run against a real model in a throwaway agent home
  (`test/scenarios/*.json`).
- **health file**, **probe** — what the gateway writes about itself, and the job that reads it,
  restarts a bot that is not connected, and alerts.
