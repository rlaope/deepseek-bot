# Changelog

Notable changes, newest first. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
the caveat about version numbers is at the bottom.

## Unreleased

### Security

- **An answer could ping a whole channel.** Slack's text was sent with `&`, `<` and `>` as the model wrote them, so
  `<!channel>`, `<!here>`, `<!everyone>`, `<!subteam^…>` or `<@U…>` in an answer notified everyone it named; on
  Discord no send said which mentions to parse, so `@everyone`, `@here` and a role mention did the same; and a watch's
  alert carried its name (the agent writes it) and its output raw, where a ``` line also closed the alert's fence.
  Covered now:
  - Slack answers, their edits and approval requests: `&`, `<` and `>` are escaped (in code too, where Slack shows
    `&lt;` as `<`), keeping the links the conversion makes and a Slack link the model pastes (the thread's own link
    is handed to it so), each with its label escaped. Nothing the bot sends mentions anyone on purpose, so user
    mentions are escaped too.
  - Slack's streamed preview (`markdown_text`): a zero-width space follows every `<`, so no mention syntax is left in
    it, one split across frames included. It reads the same; the preview is taken away when the answer is posted.
  - Discord: every send and edit carries `allowed_mentions: { parse: [] }`; no reply reference is sent, so there is no
    replied user to name. Uploads carry no text.
  - Watch alerts: the name and the output are escaped, and no two backticks are left side by side in the output.
    The watch runner is a deployed copy: a deployment has it only after `watch/install-watch.sh` is run again.
  - Telegram has no mention of a whole chat, and its HTML was already escaped.

  Checked in the Slack, Discord and watch suites, each red before, against fakes only. Not seen live: that Slack shows
  the escapes as the characters in code and link labels and reads `&gt; ` at a line's start as a quote, whether
  Slack resolves mentions in `markdown_text` at all, and Discord's handling of `allowed_mentions` on an edit.

- **A command read `~/.npmrc`, and its npm token went to the model.** The sandbox refused `~/.ssh`, the cloud
  CLIs' and gh's tokens, netrc and git's credentials, but not the package registries' and other tools' token files.
  In a real-model QA the agent was asked to edit `~/.npmrc`; the write was refused, but it read the file first and
  said it had seen an `_authToken`. Commands and the file tools now refuse the token files of package registries,
  containers, databases, infrastructure tools and other agents' CLIs (`~/.npmrc`, `~/.pypirc`, `~/.docker/config.json`,
  `~/.cargo/credentials.toml`, `~/.pgpass`, `~/.vault-token`, Hugging Face's `token` and `stored_tokens`,
  `~/.codex/auth.json`, `~/.claude/.credentials.json` and more: the runner's `credential_files`, which the file tools'
  list is checked against). The rules are written whether or not a file exists yet: one a login made while a command
  ran was readable to it. npm and cargo were run with theirs refused and work as without the file; Hugging Face's
  library raised on its unreadable token in read-only commands, and is pointed at a name that is never there. A
  private registry's login is the agent's to set up in its home. Checked in the runner and core suites (every entry,
  the late file and Hugging Face each red before); found by a QA run and its security review.

- **LaunchServices was open to commands unless the network was bounded.** With `commandNetwork: open`, the
  default, a program the agent compiled could ask it to start an app outside the sandbox, and `lsappinfo` showed
  which apps the user had open and which was in front. It is closed in every mode now; node, python, git, curl, pip,
  npm and `security` were run with it closed and work as before. Checked by the runner suite: the front app was
  seen inside the runner before, not now. Found by the final review.

- **The editor's write outside the workspace was asked about as a read.** With `readOutside: ask`, a
  `str_replace_editor` create, str_replace or insert on a path outside asked "str_replace_editor outside the
  workspace", which a person could approve as a read. Its writes outside are refused now, never asked about.
  Checked in the core suite, red before. Found by the final review.

- **The browse tool took a proxy of the user's own for the commands', and ran no policy.** It read
  `https_proxy` on this machine as the commands' proxy, so with a local proxy client set in the gateway's
  environment it ran none of its own, and a public page could send the browser to a metadata service or into
  this machine. The runner now names the commands' proxy as `DEEPBOT_COMMAND_PROXY`, set by it alone and
  dropped when the caller brings one, and the tool reads only that. Checked in the browse suite with a stand-in
  for the user's proxy (it got the request before, nothing now) and the runner suite; found by the final review.

- **The commands' proxy kept what a browse run could keep, for the gateway's life.** A tunnel whose client
  went away by a reset kept its far end open, nothing closed an idle one, any number could be open, and a
  name's answer (a failure too) was kept until a restart, for any number of names. It now closes the far end
  with the client (and lets go of one that never connected), closes a tunnel idle for fifteen minutes, holds 256
  at most, a burst included, and keeps an answer for a minute
  (a failure for five seconds, a thousand names). The log tells a refusal without its query, which may hold a
  secret. Checked in the net-policy suite, each red before; found by the final review.

- **The agent's commands reached the user's desktop.** In every mode they read and replaced what the user had
  copied, often a password, and could take the screen (`screencapture`); unless `commandNetwork` bounded them,
  they scripted other apps (`osascript`, `automator`, `shortcuts`) and started them (`open`), and in every mode
  `osacompile` made an app that would. The screen and the apps only as far as macOS's own permissions let them.
  None of it runs now, in any mode: the runner refuses those tools and the pasteboard. Checked by the runner suite
  with the network open: each tool ran before and none does now, and a marker on a pasteboard nothing uses was
  read and replaced before and is neither now (four one-line mutants red). A program compiled to send Apple Events
  or take the screen itself is still not stopped; macOS's own permissions are what stand in its way.

- **The agent's commands read the user's SSH keys and stored tokens.** The sandbox runner refused the ssh-agent
  socket, but not the key files behind it: `cat ~/.ssh/id_ed25519` worked, and so did the cloud CLIs' tokens, the gh
  token, the keychain files, `~/.netrc` and git's stored credentials. The runner now refuses `~/.ssh`, `~/.aws`,
  `~/.gnupg`, the keychain files, `~/.config/gh`, `~/.config/gcloud`, `~/.azure`, `~/.kube`, `~/.netrc` and
  `~/.git-credentials`, and the file tools refuse the same. Keychain items reach commands through `security(1)` as
  before (documented). Checked by the runner suite with a home of its own: each
  was read before, none is now, and an ordinary file there still is. A tool that needs one of them fails; the agent's
  credentials are its own.

- **The editor tool could write the agent home's `.env`.** The file-tool gate that refuses it checked `write` and
  `edit` only, so `str_replace_editor`'s create, str_replace and insert passed; the launcher moved such a file aside
  only at the next start. They are refused now, by the same test of where the write lands. Checked in the core
  suite (three one-line mutants red); its view is left to the read scope.

- **The fetch gate never ran.** It matched a tool named `fetch`; the harness's tool is `web_fetch`. So
  `fetchAllowedHosts` bounded nothing, nor did the gate's scheme and metadata refusals; the metadata service was
  kept out by the harness itself, which refuses a non-public address (seen live; its handling of other schemes
  was not checked). The gate now matches `web_fetch`. A host is compared without the brackets a URL writes an
  IPv6 address in (so `[fd00:ec2::254]` is refused) and without trailing dots, and an allowlist entry in the same
  form; an entry that is not a host (a scheme, a port, a path, a user, a wildcard), or an allowlist that is not a list of
  names, is a config error. Its checks had called it
  `fetch` and passed while it never ran; they now use the harness's name. Checked live: a fetch of the metadata
  address is refused by the gate, with its reason. The docs said `web_fetch` reads a page served locally; the
  harness refuses a loopback address, and in a live run the scenario's agent read that page with `curl`. They
  also said the allowlist was the whole reachable web; it bounds `web_fetch`, not the agent's own commands.
- **The agent's commands could read most of the harness home.** The sandbox runner denied a list of
  names in `~/.dsh` — credentials, sessions, the recall index, profiles, the gateway's logs — and the
  harness keeps more there: its session index (every conversation's text, with its WAL), the
  adapter's state and log, reminders, a session cache, attachments, the terminal's input history,
  the watch list. Measured with the deployed runner: those were readable. The runner now denies the
  harness home as a whole and allows only its runtimes (`dsh-runtimes`, where the office skill's node
  is), and an agent home or workspace placed inside it.

### Changed

- **The README was long again, and asked readers to paste a block into an AI agent.** It is shorter now: the
  wordmark, a logo, the tagline and badges, then Install, What you get, `dsh`, Others and License. The block to paste
  into an agent is gone. The hero picture, the four `showcase-0*` panels and the three `dsh-*` stills were only used
  by the README and are removed. The logo is new: DeepSeek's whale in square `#4D6BFE` pixels with the word
  "bot" in the same pixels at the lower right, on a black rounded tile (`docs/assets/logo-pixel.svg`, crisp at any
  size, and a 512 px PNG). The whale is the path in `docs/deepseek-bot.svg`, sampled onto a 32-cell grid (a cell is
  filled when the path covers at least half of it).

- **The README read as text with a few stills.** It is image-led now, every terminal image drawn from real output:
  a pixel wordmark made from the terminal banner's block letters (`docs/assets/wordmark.png`), a hero picture (a
  generated pixel whale, not DeepSeek's logo), the real `dsh` welcome screen, four numbered scenes as SVG panels
  whose rows are copied from the recording's screens with their colours (`docs/assets/showcase-01…03`: a tool call,
  a note saved and recalled after `/new`, a delete asked and denied) and from a real run of
  `test/confined-runner.test.ts` (`showcase-04`, 212/212), two stills side by side and the session GIF. Slack,
  Discord and Telegram have a table of what is verified and no picture, since none has been captured. The stills
  replace `docs/dsh-tools.png`, `docs/dsh-recall.png` and `docs/dsh-approval.png`, which are removed. The recording
  is the OpenGateway route's, and the page says so; DeepSeek's own API stays the default.

- **The terminal laid out a whole streamed answer every frame, and a whole session on every resize.** A 2000-line
  answer cost about 16 ms a frame by its end (quadratic over the stream), and a resize of a 600-turn session
  (22,000 lines) about 250 ms. Now:
  - A streamed answer keeps what it laid out up to the last place nothing after it can change (a fence's line, or
    a line that is no table's row or rule: an opening fence or a table coming later changes only what follows), and
    lays out only the rest: about 0.2 ms a frame at the end of the same answer. Every frame lays out as the whole
    text does; a text that is not the last one with more at its end (a retry, the committed reply) starts over.
  - A new width or palette lays out the blocks in view and a screen around them, about 2–6 ms for the same session.
    The others keep an estimate of their lines from the width before until they come near the view. A reader
    scrolled up stays on the block and the part of it they were reading, and a selection on the lines it was made
    on, however far the estimates above them were off. Copying a selection and asking for every line lay out what
    they cover first.
  Checked by tests that count the work, not the time (lines laid out over a stream; blocks laid out on a resize),
  each failing with the caching removed, and by a stream compared frame by frame with a whole layout.

- **The README was long and its demo a single question.** It is a page now: the tagline, a demo of a real `dsh`
  session (`docs/dsh-demo.gif`: a tool call, a note saved and recalled after `/new`, a delete asked and denied), a
  quick start with a block to paste into an agent, four short scenes with a still each (`docs/dsh-tools.png`,
  `docs/dsh-recall.png`, `docs/dsh-approval.png`), what is verified, and links. The detail moved to the docs it
  already repeated; the two facts only the README had went to `docs/setup.md` (one messenger beside the terminal)
  and `docs/how-it-works.md` (`npm run persona`). The demo was recorded on the OpenGateway route, and says so.

- **The three history deltas each kept their own copy of the same tail.** Slack, Discord and Telegram each worked out
  the next pointer, kept the newest lines that fit with "(earlier messages not shown)" before them, and typed out the
  sentence about the bot's own lines, which had drifted ("in this conversation" on Slack, "here" on Discord).
  `transports/history.ts` now holds them (`pointerAfter`, `deltaLines`, `OWN_NOTE` built from `OWN_MARKER`,
  `LATER_NOT_SHOWN`); each transport keeps its own fetching and header. The one change a model sees: Discord's
  sentence is Slack's, "your own earlier messages in this conversation". `channelLookupMs` (Discord's channel lookup,
  5000) is in the defaults beside `markRetryMs`, documented in `docs/setup.md`, and a value that is not a whole number
  of milliseconds above 0 is refused at start; the transport took one as 5000 without a word. Checked against fake APIs
  only (`test/discord.test.ts` 18, `test/core.test.ts` 3g), each red before.
- **Slack's progress marks had their own copy of the algorithm Discord and Telegram share.** `slack.ts` kept a
  second implementation of what `marks.ts` does (the wanted mark added before the old ones come off, a burst merged
  into its newest mark, the end tried again after 1×, 5× and 15× `markRetryMs`, a restart's own marks read back and
  taken off, every mark stopped after a lasting refusal, said once), so a fix had to be made twice. Slack now hands
  `marks.ts` its calls (`reactions.add`, `reactions.remove`, `reactions.get`) and keeps only how Slack's answers are
  read. Two things Slack did that `marks.ts` could not say are now part of its interface, not a platform check: an
  `unreachable` answer (a message or channel gone, `message_not_found` and the like) lets the message go without
  taking ours off, where `gone` (too many reactions) still takes them off first; and the removes made while letting
  a message go are marked `clearing`, so Slack does not log their failures, as before. The refusal line names
  Slack's error as before. Behaviour is unchanged: the Slack, Discord and Telegram suites pass as they were, with
  seven Slack checks added for what they did not pin (the refusal and failure lines, no remove on a message gone
  after its eyes, the quiet removes on a full message, four tries of a failing end, the digit's clamp, a missing
  token), each passing on the code before and failing against a mutant of the code after.

- **`npm install` failed in the sandbox, and the agent told the person to `sudo chown` their `~/.npm`.** Package
  managers keep their caches in the user's home, which a command cannot write: npm failed with EPERM, uv and go
  stopped, pip turned its cache off, and pnpm put its store in the project. The runner now points them into a cache
  directory of the workspace's own (`/var/folders/…/C/deepbot-cache-<hash>`), closed to other workspaces and to
  read-only commands, and outside the project; pnpm before 11 and node-gyp's headers are not covered, since npm
  warns on every command about a variable it does not know. A scenario's fresh home left its runner directories
  behind (952 temp ones were found here); the scenario runner now removes them at exit, the cache one included. The
  agent is also told which sandbox its commands run in, and that a write it refuses is the sandbox, not the file's
  owner or mode: it says so instead of suggesting `sudo`, `chown` or `chmod`. Checked in the runner suite (npm and
  pnpm read the new paths, npm warns about nothing, another workspace cannot read or write them; red before) and the
  core suite (the identity names the sandbox under workspace-write and read-only, and none under danger-full-access;
  red before); seen in a real-model coding QA, where the agent blamed root-owned files that `~/.npm` did not have.

- **Desktop control is decided against for now.** The harness has no tool for it, and an MCP server for it would
  run outside the sandbox with the screen and the keyboard, for every conversation. `PLAN.md` records the
  decision, `docs/limitations.md` the gap, and `docs/setup.md` what adding such a server costs.

- **A drag copies anywhere on the terminal's screen, as in Claude Code.** Only the conversation could be
  selected: a drag in the input box moved the cursor, and one over the footer, a queued message or the
  status line did nothing. A drag in the box now selects the text typed there, scrolling the box past its
  top or bottom, and copies it with the line breaks typed (a paste chip as the text it stands for). A drag
  anywhere else that a press does nothing selects what the screen shows, row by row. Either is drawn
  inverted, one selection at a time, and `esc` clears it before it answers a choice or stops a turn.
- **`dsh gateway setup` is a guided setup, and the installer no longer does messengers.** Connecting
  Slack took a skipped installer prompt, a manifest to copy, three pages in the browser and a second
  command with flags. Now the installer asks only for the model's key (when the harness has none) and
  leaves a bot that talks in the terminal (`platform: ['local']`, every channel). `dsh gateway setup` at
  a terminal shows each messenger with where it stands, and is chosen with ↑↓ and Enter: it opens the
  browser where a token is made (Slack's create-from-manifest page, filled in; @BotFather; Discord's
  Developer Portal), checks each token as it is pasted (shown as `*`) and asks again when it is wrong,
  asks who may talk to it, and offers one restart at Done; a token already saved is offered again
  instead of asked for. Discord's step reads the
  application from the token: it warns while the Message Content intent is off, opens an invite link
  with the permissions the bot needs, and offers "only me" as the application's owner. Without a
  terminal `setup` asks nothing, as before: a platform, tokens from the environment, flags. The
  installer's channel, platform and messenger-token prompts and their helpers are gone.
- **One messenger at a time.** The composite transport sends every conversation the terminal does not
  claim to the first messenger, so a second one set up beside it was never answered. `setup` now
  replaces the messenger there (the guided setup asks first); the old one's tokens stay, its channel
  ids give way to every channel and its people to the ones given. `--yes`, which guarded a `*` that
  opened several messengers at once, is gone.
- **The terminal has a light palette.** On a light background its colours were the dark palette's: light
  text that was hard to read, a dark band behind what the person said. It now takes the terminal's
  background from `COLORFGBG`, or from the terminal's answer to an OSC 11 query sent at start, and draws
  dark text on a light band, with light red and green behind an edit's lines.
- **The terminal's lists and scrolling as Claude Code and pi have them.** Typing in `/model`'s or
  `/sessions`' list closed it and went to the input box; it now filters the list (every word typed, in a
  row's name or detail, any case), backspace on an empty filter closing it as before. A list longer than
  its window says where its highlight is, `Model (3/12)`, and the completion list's hint does too.
  `PgUp`/`PgDn` went nearly a whole screen and now go half; `ctrl+home`/`ctrl+end` go to the top and the
  bottom; scrolled up past a prompt, the prompt holds the top row on one line, dim; and a click on a tool's result
  unfolds or folds that one alone (`ctrl+o` still does them all).
- **The terminal's input box as Claude Code and pi have it.** An empty box said nothing, a box past its
  six rows hid the rest without a sign, a pasted log filled it, a new line took `alt+↵`, and a message
  queued behind a turn could only be taken back by stopping the turn. Now the empty box shows a dim
  placeholder; the rows it cannot show are counted in its border (`↑ 2 more`, `↓ 1 more`); a paste of
  more than ten lines is a chip, `[paste #1 +12 lines]`, sent as the text it stands for (in an answer to
  a question too), one thing to the cursor and to deleting; `\` before `↵` is a new line; and `↑` on an
  empty box takes back the messages waiting there, the hint saying so while any wait. The terminal gives
  each message an id; a `withdraw` frame names the ones it shows as queued, the gateway takes back those it
  has not started and tells every terminal on the conversation which (`withdrawn`) before their typing
  stops, and only then do they come back to the box. The running turn goes on, and a message still
  waiting for a slot that the terminal shows as running, or another terminal's, stays.
- **The terminal opens with DEEPSEEK BOT over a welcome box, and its footer says more.** The block
  letters, sized to the screen as before, and under them a box with `deepseek-bot` and its version, the
  model, the workspace and session, and where to start; a screen too narrow for the letters gets the box
  alone, one too narrow for a box the words alone, and a header row shows only in a subagent's or a
  shell's view. The context bar turns yellow past 70% and red
  past 90%; tokens read as sent `↑` and received `↓`, with the share the provider's cache served; and the
  hint line under the box ends with the workspace, its git branch when it is a repository, and the
  conversation. While the answer streams, the status line says `Working…`, not the last tool's name.
- **The terminal's status line, approvals and hints as Claude Code has them.** A running turn is one
  indicator, `✻ Thinking… (12s · esc to interrupt)`, in place of a label and a second spinner with the
  elapsed time; an approval shows the request's first line and its options numbered, answered with
  `↑↓`, a digit or a click and `↵`, `esc` answering no (it stopped the turn, and `↑` brought back the last
  message, which `↵` sent again); the hint line is `? for shortcuts`, and `?` on an empty box shows them.
  The approval's own message says these keys (it said `←→`, above the input box), and a digit typed into a
  question or a list opened over an approval stays theirs.
- **The terminal's transcript as Claude Code and pi draw it.** A call reads `● Name(what it was asked)`;
  its result sits under `⎿`, a read as `Read N lines`, a search as `Found N lines`, a list as
  `Found N files` (counted by the gateway before it cuts a long result), a shell's last five lines, anything
  else its first three, the last two with `… +N lines (ctrl+o to expand)`, a failure as
  `Error: …`; an edit says `Updated <path> with A additions and R removals`, its lines on green and red.
  Thinking folds to `∴ Thought for Ns` and opens with `ctrl+t`, apart from the tool output's `ctrl+o`. No
  rule between exchanges, no caret on streaming text, and a turn the person stops is marked `⎿ Interrupted`,
  once, in place of the gateway's "Stopped." (a timeout is still said).
- **The terminal uses its bottom as Claude Code does.** The input box, the status line and the hint
  line keep the last rows, and the conversation fills the rows over them from the top: a short one leaves
  the rows under it empty. `/model` and `/sessions` open a picker in the box's place (`↑↓`, a digit, `↵` or a click;
  `←→` sets the highlighted model's effort) instead of printing a list into the transcript, and a
  question's options and an approval take the box's place too while nothing is typed; typing or
  pasting brings the box back.
- **`shift+tab` steps the reasoning effort**, shown at the left of the status line where `▸▸ ask` used
  to be. That label was never sent by the gateway: it was a default the terminal drew. The model the
  conversation runs on is at the right of the status line. A click on the effort steps it too.
- **The mouse works where the keys do**: a click in the input box puts the cursor there, a click on a
  completion runs or inserts it as `↵` would, and the wheel over a picker or a completion list moves
  its highlight.

### Fixed

- **The terminal's panels on a short or narrow pane, a stray character after an emoji, and text drawn with its
  escapes.** Found filming the terminal and reviewing its render pass; each checked by a test that failed first.
  - A question longer than three lines was cut at the third with nothing saying so. It wraps whole now: three lines,
    the last ending in "…", and ctrl+o shows it all (and folds it again). While such a question is open ctrl+o is
    its own (the hint says so); the transcript's ctrl+o folds wait until it closes. An option row or the hint too wide for the
    pane ends in "…" instead of mid-word.
  - On a short pane a question's options and the hint went off the bottom (40×10: no hint; 40×7: no option, while
    the keys still picked one unseen). The panel now takes what is left after a row of transcript: its words give way
    first, then the options away from the highlight, which stays with the hint; the head says which option of how
    many is highlighted. An approval does the same: its title goes first (the request is the message above), then
    the options away from the highlight. A click picks the option under it in a shortened list.
  - On a narrow pane a picker's title took the row, and what was typed and "no match" were cut off. The title gives
    way now, then the query; "no match" stays.
  - After an approval message rewrapped, a ")" stayed at the right edge of two rows until the end (100×30). A
    character of several code points (⚠️, a flag, a ZWJ emoji) is drawn two columns wide by some terminals and one
    by others (xterm's, pyte's), and the frame diff wrote each changed run in one go: after a narrower one the rest
    of the run landed a column to the left and the run's old last cell stayed. Such a character is now drawn over
    blanked cells with the cursor put where the next cell is, however wide the terminal drew it.
  - A shell's output (the job view) was drawn as Markdown answers, one per read: tabs at stops of 4, a `#` line as a
    heading, a line that went on in the next read broken in two, and an escape sequence split between two reads left
    as "1m". It is one block now, laid out as tool output is (tabs at stops of 8, no Markdown): each whole line
    stripped and laid out once, the line still arriving joined with the next read before it is stripped. It keeps
    the last 200,000 characters, cut at a line's start under a line that says so (25 reads of 180,000 characters:
    7.7 s → 1.1 s, and its memory bounded). A first read the bridge cuts to its last 200,000 characters starts at
    its first whole line, so the cut cannot fall inside an escape sequence.
  - Escape sequences and tabs reached the screen raw on surfaces that did not strip them: a prompt (a subagent's
    task included), a diff's file name, a question's words, header and options, an approval's title and options, a
    picker's title and rows (a session's title), the panel's labels, the status line (the model, the running tool,
    the link), the welcome box, the interview's topic, the held and the queued prompts. They are stripped now and
    tabs expanded where those are laid out.
  - Markdown: `~~a ~~` closed the strike after the space; a strike closes only after a character that is not a space
    now. A `<br>` inside a code span in a table cell split the cell; it is split only outside code spans.
  - A tab in a diff row was counted from the `+ ` in front of it, so it stood two columns off; the line's own tabs
    are expanded first now.
  - SS2 and SS3 (ESC N, ESC O) left the character they shift on screen; it is removed with them.

- **The terminal's input box split characters, lost a message too large to send, and took a split arrow for Esc.**
  Found in a QA pass over the input path; each checked by a test that failed first.
  - A character of several code points (a ZWJ family 👨‍👩‍👧, a flag, a skin tone, ❤️ with VS16, a keycap, e and a
    combining accent) comes from the terminal one key per code point, and each was put in the box as a character of
    its own: the cursor stood columns off, Backspace took one code point, the arrows stepped inside. What is typed is
    now segmented with the character on either side, so it joins the one before it.
  - A message over the gateway's frame limit (`MAX_FRAME_BYTES`, 1 MB: three pastes at the cap can pass it) was sent; the
    gateway's reader dropped it, and the box was already empty. It is now refused before sending, by the bytes of the
    frame as written, with a notice that says so (not "not connected"), and stays in the box. So does a message
    to a subagent; an answer batch is refused the same way, open again at the question answered with the longest
    words of the person's own, those words in the box, its picks and the later answers kept; what was answered is
    shown once the batch has gone.
  - A lone ESC waited 30 ms for the rest of a sequence, so an arrow split over a slow link stopped the turn and typed
    `[A`. It waits 100 ms (`ESCAPE_MS`, vim's ttimeoutlen in its defaults). Within another 100 ms after an ESC (or
    the start of a sequence, `ESC [`) taken as Esc, what completes a sequence the parser knows is that key; anything
    else (`[link](x)`) is typed as written. Two Escs close together are two Escs: before, the second was typed into
    the box as an invisible ESC that Enter sent. No control character is put in the box.
  - A gateway that took the connection and never answered the hello left the terminal "connecting…" for good. After
    10 s it is a failed connect, retried with the backoff, and the status line says the gateway did not answer.
  - The wait before a reconnect read "reconnecting in 1000ms" and never changed; it counts down in seconds. A hello
    sent again after a refused switch has the same timeout.
  - The paste cap cut by UTF-16 units and could split a surrogate pair; it cuts where a character ends. One final
    newline of a paste is dropped, so it leaves no empty last line to send. A paste of more than 1,000 characters on
    however few lines is a chip (`[paste #1 150,000 chars]`), as one of more than ten lines is: a 150 KB line was a
    box of thousands of rows.
  - Words: alt+b and alt+f, alt+← and alt+→ (rxvt's `ESC ESC [ D` too, which typed an ESC and `[D`), ctrl+← and
    ctrl+→ move by word (alt+b and alt+f typed letters, ctrl+← moved one character); a chip is one word.
  - ctrl+z gives the terminal back and stops `dsh`'s process group as a shell stops a job (so `pnpm exec` or `npx`
    around it stops too); `fg` draws it again whole (not on Windows, which has no job control). Where dsh leads its
    own session (`tmux new-window dsh`, `ssh -t host dsh`) the stop is discarded; dsh then stays as it was and says
    it can't suspend there.
  - Enter on `/model` or `/tenant` in the completion list only put the command in, as if its argument were needed;
    both run without one, so Enter runs them. Tab still leaves a space for the argument.

  Checked in `test/tui-app.test.ts` 80 and `test/tui-client.test.ts` 5, against a fake terminal, the real local
  transport and a socket that never answers; and in tmux against a fake gateway (typed code points one at a time, an
  arrow split 60 ms apart while a turn ran, ctrl+z and `fg`, the reconnect countdown, a 1.1 MB message refused, a
  silent gateway). Not seen in Terminal.app, iTerm2, kitty or Windows Terminal (PLAN.md, Unverified).

- **The terminal drew what a model or a tool wrote wrongly in seven ways.** Found by a QA pass against a fake gateway:
  - Tabs were never drawn: a tab is a control character, 0 columns, and the screen skips those, so a tab-indented Go
    fence lost its indentation and `a\tb\tc` ran together. Tabs now go to the next tab stop from the start of their
    line when a block is laid out: every 4 columns in an answer (CommonMark's stop, which keeps a deep fence or a
    tab-indented list readable in a narrow pane), every 8 in a tool's output, a thinking block and a notice (a
    terminal's, which the output was written for). A copy gives the spaces, not the tab.
  - A fence with an info string (```` ```python title="x.py" ````, ```` ``` python ````) was not a fence, so its
    closing line opened one and the rest of the answer showed as code. Fences are now CommonMark's: three or more
    backticks or tildes (`~~~` too), any info string whose first word is the language (none with a backtick after
    backticks), closed by a run of the same mark at least as long with nothing after it, so a fence of four backticks
    shows one of three as its text.
  - An escape sequence in an answer, a tool's result, title or diff, a thinking block or a notice (a shell's colours,
    say) showed as `[31m`: its ESC was dropped as 0 columns and the rest drawn. Escape sequences (CSI, OSC and the
    other strings, an unfinished one at the end of a streamed answer) and the other C0 and C1 controls but tab and
    newline are now removed where that text enters its block; a CRLF is a newline. The terminal's own OSC 8 links
    are written by the screen, not carried in text, and are kept.
  - A flag (🇰🇷) and a keycap (1️⃣) counted one column and terminals draw two, so what followed was drawn over them.
    Both, and any emoji made so by VS16, are two columns now; a lone regional indicator stays one.
  - `***x***` showed a star on each side of bold text; it is bold and italic. A backslash before ASCII punctuation
    (`\*x\*`) shows the character; `~~x~~` is struck through (SGR 9) without its tildes; `<br>` in a table cell is
    a line break inside the cell (a space when the table is shown as a list).
  - A link to `…/Foo_(bar)` was cut at its first `)`: a target may now hold one level of balanced brackets. A label
    with brackets of its own (`[a (b)](url)`) took the label's bracket for the start of the target; it no longer does.
  - A line with a `|` right after a table was taken as one more row. A row now has the header's shape: it starts
    with a pipe when the header does. GFM would take any line up to a blank one; an answer often goes on with a
    sentence right under its table, so this one is stricter.

  Checked in `test/tui-render.test.ts` (section 13: 25 checks red before, with controls for the renderer's own link,
  a fence closed only by its own mark, a backslash before a letter and a table without outer pipes), and the QA
  pass's Markdown and ANSI scenarios laid out by the built blocks. Against fakes only: not yet looked at in a real
  terminal emulator.

- **An answer's markers were read one rewrite at a time, and a lost session or a mute broke them.** The reaction came
  off the answer, then the lost-session notice went before whatever was left, and only then was it matched. So after a
  session's log was gone, `[quiet]` was posted as "<notice>\n\n[quiet]" and nothing was muted; a reaction alone
  dropped the notice; in a thread nobody named it in, `[react:👍]` then `NO_REPLY` put no 👍, and `[react:💯]` (an
  emoji off the list) posted a bare 💯. The answer is now read once (`classifyAnswer`), in one order: `[quiet]`, alone
  or after a reaction line (quiet wins, the reaction dropped and logged); a reaction alone; nothing, in a turn it was
  not named in (its silence answer, or an emoji it cannot put); text. The notice goes only before text, and beside a
  reaction alone as a message of its own where it was named; a stopped background job's notice is now told after a
  reaction alone too. Precedence in `docs/how-it-works.md`.
- **A message that waited behind a `[quiet]` answer still ran.** The mute was checked only when a message arrived:
  under `replyMode: thread`, a message without a mention taken while the turn that answered `[quiet]` ran then had its
  own turn in the muted thread, and could post. A turn for a message without a mention, or one only the mode gives it,
  now checks the mute when it would start, and does not run (no model call, no status; the latter's mark ends
  stopped). Checking at the start rather than withdrawing waiting messages in the `[quiet]` branch covers a mute however
  it was set, with one rule. A mention that waited the same way ran but left the conversation muted, though naming
  the bot again unmutes it; it now unmutes when its turn starts, as it would have on arrival.
- **A quiet word left a streamed answer up.** Said while Slack streamed the running turn, it stopped the turn and took
  down the working message, but the streamed preview stayed until the stream went idle. It is reset with the turn.
- **A history rewrote what people wrote.** To show their brackets as parentheses, the whole text went through NFKC,
  which also changed ㅋㅋㅋ and ㅇㅇ into other jamo, m² into m2, ① into 1 and ™ into TM. Now a character is changed
  only when it, or its NFKC form, holds an opening or closing bracket other than round and curly (a wide ［ is still
  `(`); everything else is kept as written. No line of a person's can begin with the marker, as before.

  Each checked against the fake transport only (`test/core.test.ts` 3e2, 3e3, 3e4 and jobs, `test/history.test.ts`),
  red before.
- **A turn was handed what it had already been given, and what was not yet its own.** The history pointer stopped at
  the newest line before the message being answered, and the bot's own messages were not left out, so in a Slack
  thread (and a Discord channel) each turn was given the previous question and the bot's own answer again, quoted as
  other people's words. On Discord and Telegram the history also held messages newer than the one being answered: one
  that arrived while this turn waited was quoted here, then had its own turn, and the pointer passed whatever was said
  between the two. Discord's delta was read `after` the pointer, which gives the page right after it, so a channel
  that had moved on more than a page was read from its oldest; a Slack thread's one page was likewise the oldest 200
  after the pointer. A cut for length kept the oldest lines and dropped the ones right before the question, and left
  the pointer behind the question. Now, on every platform, history is what came after the pointer and before the
  message being answered, and the pointer passes the message being answered. The bot's own messages are left out of a
  delta (the session has them) and given to a new session (a thread under a watch's alert, a session whose log is
  gone, a pruned conversation; Telegram: none, its ring holds only what people sent), each beginning with the adapter's marker `[your earlier message]` rather than shown
  as someone else's. In a history, names and words people wrote have their square brackets (wide ones and other
  bracket forms too) shown as parentheses, so no person's line can begin with the marker, whatever letters it is spelt
  in; `defuse` marks the marker as quoted anywhere else (in any case or spacing), as it does the other three. A Slack thread is paged up to the question, reading on from halfway to it when a gap is long, in at most 6
  calls; Discord reads `before` it, its newest page. What a full page or a cut for length leaves out is the
  oldest, and the history says "(earlier messages not shown)". Telegram's ring is per topic already, and an album is
  remembered under its own id, so its caption is no longer the next turn's history. Checked against fake APIs only,
  turns through the real transports and the core (`test/slack.test.ts`, `test/discord.test.ts` 16-19,
  `test/telegram.test.ts` 23-25), each red before.
- **Threads, topics and group DMs went to the wrong place, or nowhere.**
  - Discord: a thread or forum post is a channel of its own, so a `targetChannels` entry naming its channel did not
    cover it, and the tenant map sent it to the default workspace. The transport now learns each thread's channel from
    the gateway (a guild's active threads as it comes up, then each thread made, changed or listed; a channel's
    category does not count) or, for a channel it has not heard of, asks once (5 s at most; only that channel's
    messages wait for it), and puts it on the message. The allowlist accepts a message by its channel or that parent.
    With tenant isolation the parent is recorded (only the thread's messages carry it) and the tenant map read through
    it each time, so a channel moved to another tenant takes its threads. A lookup that fails or times out gives no
    parent: the thread is ignored rather than one under another channel let in, and with tenant isolation a thread
    whose parent was never told is not served, since its turn would run in the default workspace.
  - Telegram forum topics: a topic's id is now the conversation's thread, so each topic is its own session and history,
    as a Slack thread is; the answer, the working message, the typing and uploads carry `message_thread_id` (they went
    to General). General, private chats and groups without topics are the chat as before. A conversation already
    going on in a topic was keyed by the chat; its next message starts a new session under the topic (`chat:topic`). A button pressed in a topic
    is that topic's. The topic's opening message, which every message in a topic replies to, no longer counts as a
    reply to the bot. Uploads used to send the conversation's thread as `reply_to_message_id`.
  - Telegram groups: an answer replies to its question (`reply_to_message_id`, with `allow_sending_without_reply`), on
    its first part only; a private chat's answer does not, as it follows the question anyway. `/cmd@thisbot` is
    addressed and its name stripped; `/cmd@otherbot` and a bare `/cmd` in a group are not (several bots may have one),
    unless it replies to the bot.
  - Slack group DMs: the manifest `dsh gateway setup` makes did not subscribe to `message.mpim` (nor ask for
    `mpim:history`), and the code took every group DM message as addressed, so in a group DM of several people each
    message would have been a turn. A group DM is a channel now: a mention is answered, other messages follow
    `replyMode` as in a channel. Its mention is taken from the message itself, and from its `app_mention` if Slack sends
    one too, once: before, both would have been a turn. An existing app needs `message.mpim` and `mpim:history` added
    and reinstalling.

  Checked in the Discord, Telegram, Slack, gateway and core suites, each red before, against fakes only. Not seen live:
  Discord's thread events and `GET /channels/{id}` for a forum post, Telegram's `message_thread_id` on each method in a
  real forum, and whether Slack sends `app_mention` in a group DM.

- **Slack cut a long answer anywhere.** Its own cutter sliced Slack's text every `chunkChars` characters: it left
  room for the "(i/n)" number but did not recount it when the parts reached ten, so at the default limit ten parts
  came out one over it (about 36 000 characters at 4000) and Slack refused them; and it cut a surrogate pair (an emoji
  shown as two broken halves), a `<url|label>` link or mention, an `&amp;` escape (shown as typed), and a ``` code
  block (the rest of the answer shown as code, or the code as text). Slack now uses `transports/parts.ts`, as Discord
  and Telegram do, and that cutter now ends a part, within the second half of its room, after a blank line, else a
  line end, else a space; never inside a surrogate pair, a `<…>` token, an `&…;` entity or a fence's line; and a cut
  inside a code block closes it at the end of the part and opens it again, with its language, at the start of the
  next (without its info string when that would take more than a quarter of the part, and not at all when the bare
  mark would: a reopen as long as a part left a character per part, each over the limit). This changes Discord and
  Telegram too: their parts used to end exactly where the room did, mid-word, and a
  code block across parts was shown as backticks on Telegram (each part is rendered on its own) and with a fence left
  open in one part and a stray one in the next on Discord; their parts now end at the same boundaries and each part's code opens and closes. An
  answer that fits one message is unchanged, and the Block Kit path (one part with buttons) and streaming are not
  touched. Checked in the Slack, Discord and Telegram suites, red before, against fake APIs only.
- **A message of files alone got nothing, on every platform.** A Discord upload without text, a Telegram photo
  without a caption and a file shared in a Slack DM were each dropped: the core returned on the empty text, and
  Slack's transport before it (a DM's `file_share` has empty text, and an app_mention with only a file has nothing
  left once the mention is taken out). Such a message is a turn now: the model gets the attachment list as for any
  message, and the person's message reads `(sent a file without text: <name>)`. A message with neither text nor
  files still opens nothing, and other Slack subtypes still do not come in. An unaddressed one in a thread the bot
  takes part in (`replyMode: thread`) is a quiet turn, as a message with words is. A Telegram album, which comes as one
  update per item with the caption on one of them, is one message: its text is the caption and its files every item's,
  gathered until no item has come for 1.2 s; until then its items are not confirmed to Telegram, so a restart
  meanwhile gets the album again whole. Taken one by one, it opened a turn per photo. What the chat says after an
  album waits behind it, so "which one is cheaper?" after three photos is answered after them and with them in the
  conversation; other chats do not wait. A message already handled is marked so at once, not on the half-second
  debounced save: a usage request or a stop sent again after a restart within it was answered twice. Checked in the Discord, Telegram
  and Slack suites through the core, red before; against fake platform APIs only.
- **`replyMode: thread` and `all` did nothing on Discord and Telegram.** Validation accepted them, but neither
  transport reads the mode, and the core's quiet path needs a thread, which a Discord channel or Telegram chat does
  not have: the bot answered a mention, a reply to it or a DM as with `mention`. The plugin now refuses to start with
  either on Discord or Telegram, saying the mode works on Slack only and to set `replyMode: mention`; and `dsh gateway
  setup discord` or `telegram` refuses, before writing anything, to switch a profile that has either, where the
  gateway would otherwise just not come up. Slack keeps both, with or without the terminal beside it. Checked in the
  core and gateway suites, red before. docs/setup.md and the profile templates say so.
  **Upgrading:** a Discord or Telegram deployment that set `replyMode: thread` or `all` will now refuse to start. Set
  `replyMode: mention` before updating; it behaved as `mention` there anyway.
- **On Discord and Telegram a slow turn's answer raised no notification.** A turn longer than `progressAfterMs` (8 s)
  puts up the working message, and its answer was an edit of that message: an edit notifies nobody, and the answer sat
  above anything said while the turn ran. Both transports can delete now (Discord's message DELETE, Telegram's
  `deleteMessage`), so, as on Slack, the answer is a new message and the working message is deleted after its last
  part. A refused delete (Telegram deletes only messages under 48 hours old) leaves the working message, said in the
  log; the answer goes out once either way. The same holds for every reply that takes the working message's place (a
  stop, a failure, a restart's notice); a stop already reported deletes it where it was edited into a second report,
  and a quiet turn that ends with one deletes it where it was left. An answer whose later part fails to post (an HTTP
  500 on its second of three) deletes the working message too, and the failure is reported once as a new message:
  edited in place before, the first part had taken the working message's place. Checked through the real transports
  against fake APIs, red before; not seen live.
- **Slack rewrote code.** Inside a code block or inline code, a `# comment` line came out bold, a `- ` line as
  a bullet, and `**`, Markdown links and the rest were converted like text. Code is set aside before the rules now and
  sent as written; a fence ends at a run of its own mark and length, so one showing a shorter fence holds it, and a
  `~~~` fence, which Slack does not show as code, is sent as a backtick one. Also `*italic*` came out as Slack's bold
  and `~~strike~~` was left as it was: they are `_italic_` and `~strike~` now, and `**bold**` is still `*bold*`; a
  star beside bold's pair (`*args, **kwargs`) opens no italics. A Markdown link whose URL holds a `|` is left as
  text, since Slack would show what follows the pipe as its label. Checked in the Slack suite, red before.
- **`dsh gateway` alone, its `--help` and a mistyped command printed the harness's stack trace.** Only `gateway`
  followed by one of its commands was taken from the harness CLI, which booted a profile named gateway that does not
  exist: `Error: dsh: profile "gateway" does not exist` and a Node stack, exit 1. Where the harness has no such profile
  they are now `dsh gateway`'s: alone or with `--help` it prints its commands (exit 0), a mistyped command is named
  (exit 2). A profile named gateway, where one exists, still boots as before. Checked in the gateway suite, red before.
- **`pnpm test:restart` failed every time, while restarts worked.** The second phase ran in a fresh home of its
  own, and the harness resumes a session only in the directory that made it, so the turn ended at once with an empty
  answer. `--dump` now records its home and `--seed` runs in it; checked by the edges suite (red before) and by
  `pnpm test:restart` against a real model, 3/3 steps. The daily scenario run does not include the pair, which is why
  it went unseen.
- **A thread whose session log was gone failed every turn.** A cleanup of the harness's sessions removed their logs,
  and the bot went on resuming each thread's session: the harness answered `session "…" not found`, and the person
  saw "The run failed" on every message in that thread. Now the same turn starts a new session with the whole thread
  and the standing block, says with its answer that the earlier record could not be found (a quiet turn says
  nothing), and remembers the new session; a stop said meanwhile still stops it. Only the harness's not-found for
  that session counts: any other failure is reported as before. Checked in the core suite, red before, with
  controls for another failure and a quiet turn; the harness's own error was seen by resuming a session id with no
  log in a real gateway. Found by review: the retry first ran as a second turn, which a stop could miss.

- **The daily run's browser-js read a leftover server.** Each scenario's page server was stopped by the pid its
  start reported, but the static server's start, `cd … && python3 … &` in a subshell, reported the shell that ran
  the list, with python its child (found by review; first taken for the python shim). Python outlived the browser
  scenario and held port 8899, and browser-js read its 404 instead of the page server's values (in a daily
  report; the model then started the right server elsewhere, and failed on another step). A server is now
  stopped by the port it holds, and a port something else holds fails the scenario that needs it, which leaves
  the holder alone. Checked in the install suite with the real script and a stand-in for the scenarios:
  browser-js read the 404 and a server was left on the port before, neither now (three one-line mutants red).

- **The terminal printed a wide table as its pipes and stars.** A table wider than the screen was left as
  written, so a model's usual comparison table (long sentences in its cells, `**bold**` in the first column)
  arrived as rows of `|` with the markers showing. Its widest columns are now narrowed and their cells wrap
  inside them, with a rule between rows when a row wraps; a screen too narrow even for that shows the table as
  a list, as Slack, Discord and Telegram do. Two more seen in the same answer: markup inside bold or a link's
  label (`` **Run `/model`** ``, `[**docs**](url)`) was drawn as written, and a list item that wrapped repeated its
  `•` or `2.` on every line; the first now nests, and a wrapped item hangs under its text.
- **A command could not make a temp file.** The sandbox runner meant to let a command write its temp directory,
  but named it `/var/folders`, and Seatbelt matches the resolved path, `/private/var/folders`: every temp file a
  command made in its `TMPDIR` was refused (Python's `tempfile`, Node's `os.tmpdir()`, a browser's profile). Seen
  live, an agent's first run of a headless browser failed on it. Each workspace now gets a directory of its own in
  the user's temp (`deepbot-cmd-<hash>`), made by the runner as a real directory of its own and never a link left
  at the name; `TMPDIR` points there and only that is opened, and another workspace's cannot be read. The user's temp itself stays closed: opening it
  would have let a command rewrite what unconfined processes keep there, `dsh update`'s installer among them (found
  by review). Where it is comes from `/usr/bin/getconf`, checked, never from `TMPDIR` or `PATH`. macOS's `mktemp`
  with no template still writes to the closed directory; `mktemp "$TMPDIR/…"` works.
- **The docs called the destructive-command gate an open gap.** They said the harness's approval request never
  reached the adapter, the gate was off in the profiles, and `approval-gate.json` was left failing as the record.
  The answerer is on the root scope and receives it, the gate is on, and the scenario passes: the answerer cannot
  reach a platform in a scenario, fails closed, and the file survives. The docs and the scenario's note say so now,
  and its step 3 no longer accepts any answer with "안 " or "못" in it.
- **A long answer on Telegram or Discord was refused.** It was cut at the platform's limit and then numbered
  `(1/2)`, so every part but the last was six or more characters over the limit (4096, 2000); the platform
  refused the first, and nothing of the answer arrived. Each part now leaves room for its number, recounted when
  the parts reach ten, and a cut never splits a surrogate pair (an emoji made of several code points, a flag or a
  family, can still fall across one). On Telegram every part that fits is also sent rendered: its length is measured as
  Telegram counts it, after the entities, where the HTML's tags and escapes had sent the full parts as plain
  Markdown; a rendering refused as too long is sent as written. On Discord, a long message's buttons are on its
  last part only.
- **A table in an answer arrived as its pipes.** Slack, Discord and Telegram draw no Markdown tables, so a
  table the model wrote showed as rows of `|` and a line of dashes. The three transports now send a table
  as a list before they format the rest (Telegram before it cuts a long answer into parts): a bullet a
  row, its first cell in bold and the rest after a dash, later cells named by their header when there are
  three columns or more. A table in a code block stays code, and one with a row of more cells than its
  header (a pipe left unescaped in code or a link) stays as written. Not as aligned columns in a code
  block: those fonts give Hangul no fixed width. Slack also ate the blank line before every list; it no
  longer does.
- **A mention was answered twice in `replyMode: all`, once its app gets the channel's messages.** Slack
  sends a mention as an `app_mention` and as a `message`; the second is now dropped in every mode. The
  Slack manifest `dsh gateway setup` makes now subscribes to `message.channels` and `message.groups`,
  which `thread` needs.
- **A long Slack thread's new lines were not in the history a turn was given.** Without `oldest`, a thread
  past `historyLimit` answered with its first page. The history is now read from the last message seen,
  and keeps a message shared with a file.
- **A Slack message with a file was dropped.** Slack marks it `file_share`, which was read as not a
  person's message: a DM with a file and words started no turn. It now does, as does a reply also sent
  to the channel (`thread_broadcast`).
- **The daily scenario run had stopped, and nothing said so.** Its launchd job, made by hand, started
  `/bin/bash` on `run-scenarios.sh` in a checkout under `~/Desktop`; macOS closes that folder to a shell
  launchd starts itself, so every run ended at "Operation not permitted" before it began, and the only
  sign was a line in `scenarios.err.log`. `service/install-scenarios.sh` now installs the job (it is not
  part of `install.sh`: every scenario is a paid turn of a real model). The job starts node, which starts
  the script in the checkout; on the machine this was found on, macOS let that node read it (elsewhere it
  may ask once), and a run that cannot start now says why in `scenarios.err.log`. The health probe now
  also alerts when the report is more than a day late, once per wait (installing again starts another).
  The tenant scenario counted an English "declined" as no refusal; it now counts it.
- **What the terminal drew before a light background was known stayed dark.** Blocks fixed their colours
  when they were made, so the welcome box and anything drawn before the terminal answered the OSC 11
  query (a resumed conversation's history, over a slow link) kept the dark palette on a light terminal.
  Blocks now take their colours when they are drawn, and the layout is made again when the palette
  changes.
- **/clear dropped the conversation's turn with the screen.** It reset the turn as if the conversation had
  changed: an approval waiting on screen disappeared (its keys typed into the box, and esc no longer
  stopped the turn), what waited behind the turn was lost to a later stop, an ↑ in flight came back to
  nothing, and text the gateway had given back while an approval, a subagent's view or a list held the
  box was thrown away. `/clear` is the same conversation: now only the screen goes, and the turn, what
  waits, the approval and what came back stay (a switch to another conversation still lets them go).
- **A grep for a pattern starting with `/` was refused as a read outside the workspace.** The read scope
  took any tool's absolute `pattern` for a path, but grep's is a regular expression (the harness gives it
  to ripgrep as `--regexp`), so `/api/v1` was refused. Now only glob's pattern is checked, and grep
  leaves the workspace only by its `path`, which is checked as before. On Windows, where `\bword\b`
  read as a path too, the `.env` check also walks paths as Windows does: `..` cancelled as text
  first, drive-relative paths, stream names (`.env::$DATA`), and 8.3 short names (`ENV~1`). There is
  still no sandbox there. With no `DSH_BIN`, `dsh` finds an npm-installed harness beside a `dsh.cmd` on
  PATH.
- **A stop in one terminal left another terminal's queued message hanging.** A stop withdraws every
  message waiting in the conversation, and the terminal that stopped put its own back in its box; a
  second terminal on the same conversation was not told. Its message stayed shown as queued, never to
  run, and the withdrawn message's end was read as a turn's (its timer restarted). The gateway now tells
  every terminal which waiting messages a stop withdrew (`withdrawn` with `stop`), before their typing
  stops: each takes its own back, a message it already showed as started but still waiting included, and
  counts those ends from the answer, which replaces the guess the terminal that stopped made at esc.
- **After a reminder, every message in that conversation failed.** The harness resumes a session for a
  reminder with an agent of its own and keeps it, holding the session, so the conversation's next turn
  was refused ("could not take the session after retries") until the gateway restarted. That turn now
  runs in the agent the harness keeps, with the identity section a turn's own agent gets.
- **A reminder ran on the model a conversation had before `/model` or shift+tab.** The harness routes its
  agent by the session's last request, which knows nothing of the adapter's choice. The adapter now adds
  an `agent/request` listener to each agent the harness makes on a conversation's session, so its
  requests go on the conversation's route as it is at each request. Scenario runs also start each
  conversation on the deployment's model: a choice an earlier run left in the state file made the next
  run's turns take it, and a check passed for that reason.
- **`/model` listed routes with no key.** Every model a registered provider advertises was listed, and a
  conversation moved to a route whose key is set nowhere the harness looks failed every turn. Such a
  route is now left out, read the way the harness's own Models page reads it, and one asked for by name
  is refused with the key it lacks. The DeepSeek account, which signs in, stays.
- **A custom endpoint's context window could be written as another number.** Shell arithmetic wraps at
  2^64, so the installer took `18446744073709551716` and wrote `contextWindow: 100`. A window is now a
  whole number from 1 to 999999999, and one outside that is refused with what was typed.
- **One rare Chinese word was recalled unprompted.** A Chinese word is matched by its overlapping
  pairs of characters, and all of them matched a passage that has it, so one word counted as the two
  distinctive words unprompted recall needs. A span of pairs the passage has side by side now counts
  once (a word said twice is still one, a common pair inside does not split it), a span with four
  rare pairs or more as two, and pairs matched apart still count apart. Known limit: one word of five
  characters or more (a place name) also counts as two; without word segmentation it cannot be told
  from a phrase.
- **In the terminal, a stop or the usage word waited behind the running turn.** The core answers them
  at once, without a turn; queued above the input, the usage word was shown as the next turn's message,
  and the next real message's turn started under it. The gateway now names those words in `ready`, the
  terminal says them at once, and a typed stop puts what waited back in the box, as esc does. (An
  approval's yes or no is answered with its buttons in the terminal.)
- **A model moved to another route was not told.** After `/model` (or a tenant's or the deployment's
  model changing), the model took the turns above for its own. The first turn on another route now
  opens with a `[model changed]` line naming both; an effort step is not a change of model.
- **The instruction root is kept where the agent works.** The harness reads `AGENTS.md` and
  `CLAUDE.md` from a session's directory up to the nearest `.git`. The `.deepbot-root` marker the
  setup and tenant code wrote was never read by it, so a tenant under a home with a `.git` got the
  home's files, and a home under a repository got that repository's. When a directory above has a
  `.git`, the adapter now keeps an empty one in the home and each tenant directory, on every turn (git
  passes over it); with none above it makes none. The sandbox runner refuses removing or moving the
  workspace's `.git`, and a tenant whose directory is not its own, or cannot be kept the root, is
  refused its turn.
- **A gateway serving only the terminal is connected once it has started.** Only a messenger set the
  health file's `connected`, so a terminal-only gateway read as down, and the health probe restarted
  it every five minutes. `install-service.sh` likewise looked for Slack's "Socket Mode connected" in
  the log; it now reads the health file.
- **A `/model` switch reached only the terminal that made it.** Every terminal on the conversation is
  told now; an effort step updates their status lines without a line in the transcript. Two steps sent
  together are taken one after the other.
- **A `dsh` newer than its gateway showed "unknown frame type …".** It now says the gateway is older
  and how to update it; a gateway refuses an unknown frame with its own code, `unknown-frame`.
- **`dsh gateway` sees a harness that was set up before it.** It read only `~/.dsh/.env`. A key
  entered in the DeepSeek Harness app sits in the app's store (`~/.dsh/.credentials.yaml`), which
  the harness reads first. So `status` called the model key missing on a working deployment, and
  `setup` asked again for a token the harness already had. A token written to `.env` under a name the
  store holds would never have been read. Now `status` says where each key is (the app, or `.env`;
  `--json` gives `store`, `dotenv` or `null`) and takes the model's key from the profile's
  `llm-pi-ai` route, else DeepSeek's own. `setup` uses the app's tokens as they are (the same token
  given again is fine), refuses a different one under a name the store holds, checks Slack's two
  tokens against the app-level token the harness will actually read, and never writes the store or
  prints a value from it.

### Added

- **How much the marks show is a setting, `marks`.** `progress` (the default) is what was there: 👀, a digit while it
  runs (✍ on Telegram), then how it ended. `simple` leaves out the digit and the ✍; `off` puts no mark at all. The
  salute for a quiet word shows under each, as it is the answer. Any other value is refused at start.
- **The model may react instead of replying, or as well.** Told so in its standing block, with the emoji its platform
  takes: an answer of exactly `[react:👍]` (backticks and a full stop let pass) puts 👍 on the person's message and
  posts nothing; on its own first line before text, it reacts once the text is out and posts it. The list is 👍 👎 ✅ ❌
  👀 🙏 🔥 🎉 😂 ❤️ 🤔 🫡, skin tones let pass (Slack by its names, `+1`, `heart`, …); Telegram's own list has no ✅,
  ❌ or 😂, and a token for one the platform cannot put, or one off the list, is posted as its text, or with none what
  it named, never as another reaction and never as the token. The marks never take
  the model's reaction off, even a 👀 or a ✅; on Telegram, one reaction per message, it takes the place of 👌 and a
  failure still replaces it. It is put under `marks: off` too, and on a turn for a thread message that did not
  mention the bot. A token not alone on its line, or not well formed, is text. Refused, it is logged, and nothing is
  posted instead. `marks:` left empty is the default.

  Checked in the core, failures, Slack, Discord and Telegram suites against the fake transport and mocked APIs; the
  core's checks were red before the change, the marks' ones shown red by removing their line. Not seen live: Slack's
  `+1`, `heart` and the rest, Discord's ❤️ and Telegram's ❤ on a real message, and a real model answering
  `[react:👍]` (no scenario).

- **It can be told to stay out of a conversation.** Under `replyMode: thread` or `all` there was no way to make it
  stop joining a thread short of changing the mode for everyone. Now a quiet word said to it as a whole message
  (`be quiet`, `shut up`, `stay out`; `조용히 해`, `빠져`, `그만 끼어들어`; `安静`, `别说话`), or the model's whole answer
  `[quiet]` (its standing block says it may), mutes the conversation until it is mentioned or replied to again. A
  quiet word stops what runs and withdraws what waits, as a stop word does; the only answer is a salute reaction on
  the message that asked (`saluting_face` on Slack, 🫡 on Discord and Telegram), with no text. While muted, a thread
  follow-up opens no turn, under `all` only a mention or a DM is taken (Slack's messages now say when they are
  addressed only by the mode), and a restart's lost-turn notice is not posted there; watches, reminders and
  background jobs still report. The mute is kept in the state file, survives a restart and is pruned with the
  conversation. In a DM, under `mention` and on Telegram and Discord, the next message names it and undoes the mute.
- **A message opening with someone else's mention is theirs.** Under `thread` and `all`, `@minsu 이거 봐줄래?` opened a
  turn the bot might answer; now Slack drops it before the core sees it. A mention of the bot after theirs still counts.
- **`[SILENT]` and `NO_REPLY` are silence answers too**, as `[no reply]` is in a thread the bot was not named in: the
  whole answer only, any case. The markers are read outside the answer's code: one only inside code is now text (a
  bare `NO_REPLY` in backticks used to be silence), and code elsewhere in the answer hides none.

  Checked in the core, failures, Slack, Discord, Telegram and i18n suites against the fake transport and mocked
  APIs, each new check red before the change or shown red by removing its line. Not seen live: Slack's
  `saluting_face`, Discord's and Telegram's 🫡 on a real message, and a real model answering `[quiet]`.

- **A background job outlives its turn, and what it found is posted when it finishes.** The adapter released the
  agent after every turn, and the harness's jobs service stops an agent's jobs with it: a command started in the
  background (`run_in_background`, or a foreground one moved there on its timeout) died as the answer went out, so
  "I'll tell you when it finishes" could not be kept. Now an agent that owns a running job is kept after its turn.
  When the job settles, the harness wakes it with its notice, as it does any idle owner; that turn's answer is posted
  to the conversation (as a reminder's is), and the agent is released after it. The conversation's next message runs
  in the kept agent (a resume would be refused: the agent holds the session). A job still running after
  `backgroundKeepMs` (30 minutes, counted from the first keeping, not restarted by later turns) is stopped and the
  conversation told; a woken turn still answering then, its job done, is let finish (up to `runTimeoutMs`). Past
  `maxKeptAgents` (4) kept at once, a turn's agent is released as before and the conversation told after the
  answer, if one went out. A stop stops a kept agent's woken turn and its job, during a turn or not; unloading
  releases them all; 0 in either setting keeps nothing. A job that settles as its turn ends, and one that settles as
  the next message is taken, still get their woken turn delivered; a kept agent's woken turn belongs to its
  conversation even when a turn past the backstop never mapped it. The identity section says so, only where agents
  are kept. Checked in the core suite with a fake jobs service that wakes its owner as dsh-tool-jobs does (each check
  red before, and each line under test removed in turn); `test/scenarios/background-job.json` is the real-model
  check, not yet run.

- **`dsh gateway mcp add`: an MCP server in one command, and the bot says which.** Connecting one meant
  editing the profile by hand: a row at the right indent, the program by its absolute path (launchd's PATH
  finds no `npx`), the credential in `~/.dsh/.env` and read with `!!js process.env.NAME` (the app's store is
  not in the gateway's environment), `askTools` in the deepbot row, and a restart. Asked to connect Notion,
  the bot could only say the operator edits the profile, or try something in its own home. Now
  `dsh gateway mcp add <server> --env NAME -- <command>` (or `--url … --bearer NAME`) writes all of it, asks
  for every call of the server's tools unless `--ask` narrows that, and restarts; `mcp list` shows the servers
  and whether each credential is set; `mcp remove` takes out one it added, leaving the profile as it was. A
  credential is asked for at the terminal, not shown, and never taken as an argument (a value, a server
  argument or a URL shaped like one is refused); one only in the app's store is explained; the bot's own keys
  are not replaced from here. A name the harness refuses in `~/.dsh/.env` (`PATH`, `DSH_*`), a name given
  twice, an `--ask` the adapter would refuse at start, and a value `~/.dsh/.env` cannot hold as it is are
  refused before anything is written: each of those stopped the gateway or reached the server changed (found
  by review). The bot is told the command, to fill it in, and to leave the credential's value to the operator.
  Checked in the gateway suite; the written row composed by the harness itself (`--dump-config`) on a copy of
  a live profile and removed back to the same bytes; and a real model reached a fixture server through the
  row's shape, its credential arriving only by the row's `!!js process.env` line (a control without it failed).

- **Discord and Telegram show a turn's progress on the person's message, as Slack does.** Only Slack had the marks;
  on the other two nothing on the message said it was taken or how it ended. Discord now reacts 👀, a keycap digit
  while the turn runs, then ✅, ❌ or ⏹️, each added before the last comes off; Telegram, which allows a bot one
  reaction from its own list, shows 👀, ✍ while it runs, then 👌, 😢 or 🫡. Discord's per-channel reaction limit
  is kept: a channel's calls go one at a time and wait out its headers, and a 429's `retry_after`; refused, the
  digits a turn went through stayed beside its end. After a restart the message is read, and only the bot's own marks come off. A channel that denies the
  reaction is said once and not asked again until a restart; one person who blocked the bot does not silence the
  channel; a refused token stops the marks; an end mark that failed is tried again after a pause. The invite link
  `dsh gateway setup discord` makes now asks for *Add Reactions*. Checked in the Discord and Telegram suites
  against fakes, the rate limit by a fake that refuses a call too soon after the last (red without either wait); not
  yet against the platforms (PLAN.md). Found by review: the rate limit, the per-person 403, a full message.

- **A file outside the agent's home can be read with the person's consent: `readOutside`.** A file tool's read
  outside the workspace was refused, and the agent could only ask for the file to be moved or pasted. With `ask`,
  the default, the read is held and the conversation asked, naming where it lands (a link with its target).
  Credentials, `DEEPBOT_DENY_READ`'s places, a folder holding one, and a link to any of them are refused, judged
  where they really are; so are a tenant's turn (its first one included, which also read with the shared home's
  roots before) and one with nobody to ask; `deny` refuses as before. The editor tool's reads are covered. Checked
  in the core suite (thirteen one-line mutants red), and live: a read of a file outside was asked for, and in a
  scenario, with no platform to answer, refused.
- **Recall: the conversation's model chooses the passages about the message.** Matched by words (and the
  words the model relates to the message), a past put in words the message shares none of was outranked by
  newer passages on the same subject that only shared surface words.
  - A message that points at the past now also has the model shown the channel's latest passages
    (`recallPickFrom`, 40), numbered, and asked which are about it. It answers in numbers, at most four,
    in parallel with the related words and under the same deadline. Its choice comes first in the block.
  - Only a first line of numbers counts, and the passage that shares the most words keeps its place.
  - A benchmark of facts, each among five newer near misses in the same words, a new daily scenario
    (`recall-near`): words alone answered 4 of 8 over two runs, with the choice 8 of 8 (one route, a small
    sample).
  - It costs a second model call for such a message, up to about 8,000 characters of passages at 40.
    `recallPickFrom: 0` turns it off; 200 is the most.
- **A scenario's expected answers were readable by the agent.** The runner wrote each scenario, with every
  step's expectation and seeded passages, to the user's temp, which the agent's commands read. In the first
  benchmark run the agent answered five of eight questions by grep. It now writes the copy under the harness
  home, which the commands cannot read, and removes it at exit; it never did.
- **The agent's commands' network can be bounded: `commandNetwork`.** The sandbox confined what commands read
  and write, not where they connect, so a command reached the local network and, on a cloud host, the metadata
  service.
  - With `public` (public addresses only) or `local` (those and this machine's network; never metadata), the
    gateway runs a proxy with the browse tool's rule.
  - The gateway writes where the proxy listens under the harness home. The sandbox runner reads that file,
    refuses every outbound connection but to the proxy's port, and points commands at the proxy (`http_proxy` and
    the rest, `NODE_USE_ENV_PROXY` for node) with nothing exempt. With every local port open, a live run under
    `public` fetched a local page around the proxy; the runner now opens that one port.
  - The browse tool's browser goes through it too, under its rule.
  - A file that names no proxy closes the network rather than opening it. The gateway writes it closed before
    its proxy listens and when it stops, never removes it while bounded, and a file whose gateway has gone names
    no port.
  - Bounded, names are not looked up (a lookup carries data out) and other apps are not started or scripted
    (they run outside the sandbox). Refusals are logged at most twenty a minute.
  - `open`, the default, changes nothing. Bounded, a command that ignores a proxy reaches nothing.
  - Checked: the runner suite (the rules, the environment, a direct connection refused with EPERM elsewhere and to
    another local service, a garbled or linked file), the core suite (each mode's proxy, its log, `open` removing a
    file left behind), the browse suite (the browser through the commands' proxy, its refusal said), and a new
    daily scenario, `command-network`.
- **A local or intranet page goes to the browse tool, said where the agent reads it.** `web_fetch` refuses
  this machine and the local network, and the agent tried it first and then fell back on whatever came to hand
  (`curl`, seen live). The standing block now says `web_fetch` opens public addresses only and that such a page
  opens with the browse tool. docs/how-it-works.md has the table of what `web_fetch`, the browse tool and the
  agent's commands may each reach.
- **The browser can browse as you, on a site you signed it in to.** `browse.js` kept nothing between runs, so a
  page behind a sign-in was out of reach.
  - `--login '<url>' --state <file>`, run by you in your own terminal, opens a window. You sign in, and when you
    close its last tab (or press ctrl+c) the session is kept in that file, mode 600. The session is the cookies
    and site storage.
  - `--state <file>` starts a run from that session. A run that went through writes it back, so renewed cookies
    are kept, and keeps the one before as `.prev`. A failed run leaves it as it was, and a run that ends signed
    out says so.
  - The file is written to a fresh file and renamed over its name. A path that is a link, or in a linked
    directory, is refused, because the agent can make links and `--login` writes as you. A file that is not a
    session is refused rather than written over.
  - The standing block names the session files in the conversation's workspace (`.browser/*.json`, plain names
    only).
  - The file is the account, and the agent's commands can read it. docs/setup.md and docs/limitations.md say so.
  - Checked: the browse suite keeps sessions without a browser (links, `.prev`, a file that is not a session).
    With a browser, it signs in on a local page, is still signed in on the next run, and is signed out without
    `--state`. It leaves the session alone after a failed run, says so after a sign-out, and ends a `--login` by
    closing its last tab. Thirteen one-line mutants are red. `--login` was also run by hand: a window, ctrl+c,
    and the session kept with mode 600.
  - A new daily scenario, `browser-session`. With a kept session seeded in the workspace, a real model found it in
    the standing block, ran `browse.js --state` with it, and read the account's name. The page shows that name only
    with the session's cookie. The control without the session read "Not signed in".
- **A tool can be asked for on every call: `askTools`.** An MCP server's tools passed every gate. The approval
  patterns read a shell command, so a server that sends mail or changes a calendar acted on the model's word
  alone. `askTools` in the deepbot row names such tools (an entry ending in `*` names those that start with it),
  and each call goes through the same approval as a destructive command, in the conversation the turn belongs
  to. The question shows every argument, short ones first, each cut at 200 characters with the cut said. A call
  whose arguments are too long to show whole, or whose turn belongs to no conversation, is refused. Empty by default.
  - **A first turn's destructive command ran unasked.** The gate found the conversation in the saved state,
    which a first turn reaches only when it ends; it now also finds a running turn by its origin, as the approval
    answerer already did.
  - **What an approval shows is inert.** `<` and `>` become `‹` `›` and an `@` before a word is broken, so a
    `<!channel>`, a `<url|label>` link or an `@everyone` that a call's arguments carry acts on no platform.
  - Checked in the core suite; five one-line mutants are red.
  - A new daily scenario, `mcp-ask`. The fixture's new `vault_store` writes a file under the harness home, which
    the agent's own commands cannot write. With `askTools` naming it, a real model's call was refused and the
    file never appeared. The control without `askTools` wrote it.
  - A scenario can now set the adapter's settings for its run (`config`), and `{RUN}` names the run in its paths.

  docs/setup.md also says how to add Google mail and calendar with a local server that signs in itself
  (`workspace-mcp`), keeping its tokens under the harness home. Not run here: no OAuth client was available.
- **MCP servers, documented and checked.** The harness composes MCP servers itself (`dsh-mcp-client`); nothing
  said how a deepseek-bot profile adds one, where its credentials go, or what such a server may do. docs/setup.md
  now says so:
  - a server is one row in the profile's `insert` list;
  - its command needs an absolute path, because launchd's PATH is `/usr/bin:/bin:/usr/sbin:/sbin`;
  - its credentials go in `~/.dsh/.env` and reach it by name with `!!js process.env.NAME`, never from the agent
    home;
  - it is trusted code: not under the sandbox runner, it can read the bot's own credential files. The harness
    keeps the gateway's keys and tokens out of its environment unless `env:` names one, not out of its reach;
  - none of the adapter's gates (approval, read scope, fetch allowlist) applies to its tools, which every
    conversation shares, and what they return is not marked as instruction-like text.

  The profile template has a commented example. A new scenario, `mcp`, runs in the daily set. A real model answers
  with a code that only the tool of `test/fixtures/mcp-fixture.mjs` gives. That fixture is a stdio server with no
  dependency. A scenario can now carry `profileRows`, which the runner adds to a copy of the test profile for that
  run, so `mcp` needs nothing added to a machine's profile.
  - Checked live: 1/1 with the fixture's row. The server's environment held the variable named under `env:` and
    PATH, and no key, token or `DSH_*` name of the gateway's.
  - The control without the row fails. Its agent found the fixture on disk and ran it by hand, so the scenario
    requires the tool call as well as the code.
- **The installer installs DeepSeek Harness when it is missing.** It stopped with "install the app" where the
  harness app was not found. It now offers to download the app from DeepSeek's own server — the build the app's
  updater names for this Mac's architecture (its feed, `nightly-mac.yml` for `mac-arm64` or `mac-x64`), checked
  against the feed's sha512 and size before it is placed in `/Applications` — and goes on with that CLI. Asked at
  a terminal, Enter meaning yes; without one — an agent, a script — nothing that large is downloaded on an
  assumption: the run stops and says to run it again as `curl … | DEEPBOT_INSTALL_HARNESS=1 bash`, which also
  answers the question at a terminal; `0` never installs it. A `DSH_BIN` given by hand that does not run, or an
  app that is there without its CLI, stops the install as before. The feed is read as the YAML it is (a value
  folded onto the next line or on the key's line), and only an https url, a 64-byte hash, a number and a version
  are accepted from it; an archive that is not the app with its CLI, or an app already there, is not placed.
  Checked by the suite against a feed and an archive of its own (the question driven in a pty: n, Enter, yes),
  and once for real: the current build (0.2.0-rc.2, 357 MB) downloaded, matched the feed, unpacked with its
  signature intact, and its CLI answered `--version` and booted the scenario profile for a real-model turn. README and docs/setup.md say how an agent runs the install without a terminal. Not
  verified: whether a harness placed this way and never opened as an app unpacks its runtime into
  `~/.dsh/dsh-runtimes` (the app's host process does that at its start, and the document skills' node is there).
- **A headless browser the agent runs.** `web_fetch` runs no JavaScript, so a page that draws itself came back
  empty, and nothing could be clicked or typed. `dist/tools/browse.js` opens a page in Chromium's headless shell,
  lets it settle, types and clicks in the order asked, and prints the title, the address and the visible text
  (`--screenshot` saves one). The adapter offers it in the standing block as a command with absolute paths when the
  checkout has it (`browse: false` offers nothing); the agent runs it with its shell, under the same sandbox as any
  command. It opens only http and https pages and downloads nothing. Every request the browser makes goes through a
  proxy inside the tool that resolves the name and checks the address it connects to: never a cloud metadata
  service, and a private address only from a page whose name resolves to private addresses alone. That holds for
  each hop of a redirect, a frame, a window the page opens and a socket, which an interception of the page's own
  requests missed; what was blocked is listed. The metadata list, which `web_fetch`'s gate shares, now also has
  Azure's WireServer and Oracle Cloud's address. A page that answers with an error status, or runs past 75 s, fails the run and still shows what
  it had. `playwright-core` (pinned) is the one runtime dependency, loaded only by this tool; the
  installer downloads the headless shell (about 90 MB), and without it the bot works and the tool says how to add
  it. A new scenario, `browser-js`, has a real model read a codename the page fetches after load and a deadline
  it fetches when a button is pressed, from a server that answers only a browser.
- **Recall finds a past said in other words.** Ranking was by the message's own words, so "되돌리기" never found
  a conversation that said "rollback". A message that points at the past, when this channel has anything to
  recall, now also asks the conversation's own model (its route, as its turn) for words related to it: synonyms,
  related terms, Korean and English. Reasoning is turned off where the model can turn it off, and the answer is
  then capped. Each line is matched whole; a number, a two-letter word, or a line many passages share is not used; and
  only the best related word counts, for half a word of the person's own. The turn waits for it, at most
  `recallExpandMs` (4 s); a failure or a timeout is logged and the turn goes on without it; 0 turns it off. A new
  scenario, `recall-paraphrase`, runs it against a real model daily; its control, with the call off, fails. Verified
  on an OpenGateway route only (reasoning off, answered in under a second); on DeepSeek's own API, the default, the
  call is unmeasured (it is sent with reasoning off).
- **Progress on the person's message, in Slack.** A turn showed only Slack's working status under the thread.
  The message that asked now carries it as a reaction: 👀 when taken, a digit while the turn runs (1 to 9: a
  guess at how far along it is, from the time a turn usually takes, changed only when the digit does), and
  ✅, ❌ or ⏹️ when it is answered, fails or times out, or is stopped (a message a stop withdrew too). None
  for a message that did not mention it in `replyMode: thread`. It needs the `reactions:write` scope (and
  `reactions:read`, to tidy a lost turn's mark after a restart), both now in the manifest `dsh gateway setup`
  makes; an existing app needs them added and reinstalled; without it the first refusal is logged and nothing more is asked
  until the gateway restarts. A reaction Slack refused to take off is tried again; the end mark is tried a
  few times; a digit holds while an approval waits; and a restart ends a lost turn's mark with a cross.
- **Slack streams the answer as it is written.** An answer arrived whole, after Slack's working status. The
  turn's text now streams into the thread as the model writes it (`chat.startStream` / `appendStream`, sent in
  batches of `streamFlushMs`), a tool step by its name only. The finished answer is posted as a new message,
  which notifies (an edit does not), and the streamed message is stopped and deleted, so the thread ends with
  one message in Slack's own formatting; a turn that streamed notifies twice. A failed attempt's stream is
  deleted; anything else said in the thread (an approval request, a stop's report) comes after all that was
  streamed; a refused stop is tried again; a stream nothing moved for `streamIdleMs` is stopped, and every open
  one when the gateway stops. Not for a message that did not mention it in `replyMode: thread`. Refused for
  good, it says so once and answers arrive whole as before, with the working message showing progress again.
- **`replyMode: thread`: in a thread the bot takes part in, no mention is needed.** In a Slack thread every
  message had to mention the bot. With `thread`, a mention starts it; then, for a day after its last
  mention or reply there, every message in the thread comes to it, told it did not mention it, and the
  model answers only when the message is meant for it, otherwise posting nothing ("[no reply]"). Nothing
  shows it was heard, and a failure, a timeout or a restart says nothing there. Several such messages in
  a row are one turn (not one with a file). Without a mention, stop, usage and approval words are not
  commands, except an approval's answer in the buttons' words (Allow/Deny, 허용/거부, 允许/拒绝) from the
  person it asks. `mention` stays the default; Slack only.
- **`dsh update`.** Updating meant finding the install line again. `dsh update` fetches the branch the
  source checkout is on and runs that commit's installer, which builds, keeps the agent home, the
  profile, every edited file and every key, and reinstalls the services. Nothing runs when the last
  finished install is already the latest; one that stopped part way is run again. With it, a rerun of
  the installer now keeps the agent home and profile the service was installed with (it used to put
  the service back on `~/dsh-agent` and `agent`), and a full clone used as the checkout stays full and
  only moves forward: local changes, another branch, or commits not on origin while origin has moved on
  stop the update instead of being reset away. An install from before this has a `dsh` that hands
  `update` to the harness: its first update is the install line once more, with
  `DEEPBOT_DIR=<its checkout>` when that is not `~/.deepbot` (else a second checkout is cloned there and
  the service moves to it). Where a harness profile
  named `update` exists, `dsh update` runs nothing and says to boot it with `dsh --profile update`.
- **A first step on Windows.** It builds, checkouts are LF everywhere (`.gitattributes`), and CI runs
  the suites that pass on `windows-latest`. The terminal's local transport listens on a named pipe,
  named anew at every start: that namespace is shared by every user of the machine, and a name worked
  out from the path could be taken first. So `dsh` looks its gateway up through the discovery file on
  every reconnect, on every platform; with none registered it dials the last path again, except on
  Windows. When all 16 terminal places are taken, a connection that has sent nothing gives way, so
  read-only opens of the pipe cannot keep the owner out. The installer, services, sandbox and the tool
  gate's link checks are not ported. The health probe's path to `rotate-logs.sh` no longer breaks on a
  path with spaces or non-ASCII characters (`fileURLToPath`).
- **The installer can set up another model provider.** DeepSeek's own API stays the default and needs
  nothing new: the installer's provider question defaults to it, and an existing install keeps its
  `DEEPSEEK_API_KEY` and route. As options it offers OpenGateway or a custom OpenAI-compatible
  endpoint, and for those writes the whole `llm-pi-ai` route and the default model row into the new
  profile (OpenGateway's as the running deployment has it: images,
  DeepSeek's thinking format, four efforts, `medium` by default). It asks for the route's key, offers
  `DEEPSEEK_API_KEY` for web search, and checks what a custom endpoint's answers put into the YAML. A
  rerun asks only for the key the existing route names. A key the harness already resolves — in the
  launch environment, in the DeepSeek Harness app's own store (`~/.dsh/.credentials.yaml`), or in
  `~/.dsh/.env` — is not asked for again, the platform tokens included; it used to look in `.env` only,
  so a harness user was asked for a key the app already had. The store is never written.
- **The agent knows what it is and which settings are its own.** Every session's setup adds a
  system-prompt section: it is deepseek-bot on DeepSeek Harness; this conversation's platform (or the
  terminal) and the language of its notices; what it may change in its home (persona files, notes,
  watches, skills in `.dsh/skills/`); and what only the operator can (model, provider, platforms,
  channels, language, keys, approvals, sandbox), which it points to instead of trying. It was told only
  that it is "a coding agent". The sandbox runner now also denies reading `~/.dsh/profiles`, which
  that section says the agent cannot read.
- **`/model` in the terminal.** It lists the models the registered providers advertise, numbered,
  with this conversation's marked and the reasoning efforts it takes; `/model <n>` or
  `/model <provider>/<model> [effort]` moves this conversation to another from its next turn (the same
  session), and `/model default` moves it back. Unlisted models and unsupported efforts are refused.
  The choice is kept per conversation; nothing else changes. The status line shows the effort.
- **`/exit` in the terminal**, the same as `/quit`.
- **`dsh gateway`: connecting a messenger, and running the service.** The installer set up one
  platform, once; adding another meant editing the profile by hand, and starting or stopping meant
  `launchctl`. `dsh gateway setup <slack|telegram|discord|local>` saves the tokens to `~/.dsh/.env`
  (mode 600), checks them with the platform (`auth.test` and `apps.connections.open`, `getMe`,
  `users/@me`; for Slack, that both tokens are from one app), adds the platform, channels and people
  to the profile's deepbot row without touching any other line, restarts the gateway and waits for
  it to connect. `remove`,
  `start`, `stop` (with the health probe, which would otherwise alert), `restart`, `status [--json]`
  and `manifest slack` (an app manifest) go with it. Every answer can come without a terminal — a
  token from the environment variable of its name, `--channels`, `--users` — so an agent can run it;
  a missing one is exit 2 with nothing written. `dsh gateway` alone still boots a harness profile
  named gateway: only `gateway` followed by one of these commands is taken.
- **`allowedUsers`: who may talk to it.** A Telegram private chat always reaches the bot and the
  installer answers in every Telegram chat, so anyone who found the bot could run turns in the
  agent's workspace; Discord direct messages likewise. The deepbot row now takes a list of user ids;
  someone not in it is ignored without a reply, their button presses too. Empty, the default, keeps
  the old behaviour. The terminal's user is always allowed, in the terminal's own channel. An id
  written unquoted, which YAML reads as a number, is a config error that says to quote it. The
  installer says so for Telegram and Discord, and `dsh gateway setup` asks.
- **English, Korean and Chinese.** A `language` setting in the deepbot row (`en` by default, `ko`,
  `zh`) sets what the bot itself says on every platform (approvals and their buttons, stops,
  failures, the working message, Slack's status, the usage report); `dsh`'s own interface is English,
  as Claude Code's and pi's are. Stop, usage, allow and
  deny are understood in all three whatever the setting, recall reads Chinese by pairs of
  characters, and the injection check knows Chinese shapes. The installer asks, offering the
  environment's language; an existing profile is told how to set it. An unknown value is a config
  error. The model's answers still follow the persona.

### Changed

- **The bot no longer loads the operator's own skills.** The harness also lists the skills in
  `~/.agents/skills`, where an operator's coding agents keep theirs; the launcher now gives the
  gateway an empty agents home of its own (`DSH_AGENTS_HOME=~/.dsh/deepbot/agents-home`). Takes effect
  when `install-service.sh` is run again. The agent template points skills at `.dsh/skills/`, the
  directory the harness reads, instead of `skills/`, which it never did, and names the terminal.
- **The deployment's reasoning effort reaches a turn.** `agent-default-model`'s `reasoningEffort` was
  read and dropped: only the provider and model were passed to the session. It is passed now, for the
  deployment's own model and only when that model declares the effort — the harness refuses a call
  with one it does not, so it is left out and logged instead. A conversation's `/model` choice carries
  its own; a tenant's model takes none.
- **The health file says when a platform fails to start, and when a Telegram poll recovers.** A
  startup failure was only in the log, so with another platform connected the file read healthy;
  it now carries the error as `lastError`, and the start that works after it clears it. A Telegram
  poll error stayed in `lastError` after polling worked again; the next poll that works clears it.
  The platforms share that field, so each clears only the error it wrote, never another's.
- **`docs/setup.md` asks for `im:history`.** The Slack steps subscribed to `message.im` for direct
  messages without the scope that event needs; the manifest and the steps now include it.
- **A service that fails to install fails the install.** On an account with no
  `~/Library/LaunchAgents`, all four installers failed to write their plist and `install.sh` still
  said "done" and exited 0. The installers make the directory; `install.sh` says which service failed,
  counts the gateway too (its failure was swallowed), and ends with an error when any did. Its output
  now holds back only lines that carry a credential (`token=`, a Slack token, a bearer header, an API
  key), not every line with the word "token", which had cut the web UI's sentence in half.
- **The terminal shows a turn's parts apart.** What the person said is on a band; answers start at
  a `●`; a tool call's `●` blinks while it runs and turns green or red with its result, and stops
  blinking when the turn ends without one; thinking is sky blue, its label swept by a light while it
  streams; a blank line separates a turn's steps (no rule between exchanges); the status line
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

- **`permissionPreset` is applied, and attaching sessions to their workspace is a setting.** Both
  calls sat after a `throw`, inside the branch for an agent that did not come back, since the emptied
  `index.ts` was restored (a0e847e): `permissionPreset` was a setting that did nothing, and no session
  was ever attached. The branch now closes after its `throw`. Attaching is `attachSessions`, off by
  default: it rewrites `~/.dsh/storages/workspace.json`, which the desktop app writes too (last write
  wins), and it only groups the bot's sessions in the desktop sidebar. An unknown `permissionPreset` is
  refused with its name whether or not an agent preset is named.
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
