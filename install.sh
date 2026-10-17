#!/usr/bin/env bash
# deepbot — install or update, in one line (macOS):
#
#   curl -fsSL https://raw.githubusercontent.com/rlaope/deepseek-bot/master/install.sh | bash
#
# Fetches deepbot into ~/.deepbot, builds it, creates the agent's home and the gateway profile, asks for
# the model's key when the harness has none, and installs the services that keep it running. When the
# DeepSeek Harness app itself is missing it offers to download it, from DeepSeek's own server. The bot
# starts with the terminal, dsh; a messenger is connected afterwards with `dsh gateway setup`, which is
# not part of this. Run it again to update (`dsh update` does): every file you have edited is kept, and no
# key is asked twice.
#
# Optional environment:
#   DEEPBOT_DIR      where the source lives               (default ~/.deepbot)
#   DEEPBOT_HOME     the agent's home                     (default: the installed service's, else ~/dsh-agent)
#   DEEPBOT_PROFILE  the gateway profile                  (default: the installed service's, else agent)
#   DEEPBOT_REPO     the git repository to install from   (default this project on GitHub)
#   DEEPBOT_REF      branch or tag                        (default master)
#   DSH_BIN          the dsh CLI                          (default: inside DeepSeek Harness.app)
#   DEEPBOT_SKIP_SERVICES=1   build and configure only; install no launchd jobs
#   DEEPBOT_INSTALL_HARNESS   1: install the DeepSeek Harness app when it is missing, asking nothing; 0: never
set -euo pipefail

# Helpers at the top level, so a test can source this file (DEEPBOT_INSTALL_SOURCED=1) and call them.

# The language a new profile starts in: the environment's, read in the POSIX order (LC_ALL, LC_MESSAGES,
# LANG), the first one set deciding. English when it names none of the three.
env_language() {
  local v
  for v in "${LC_ALL:-}" "${LC_MESSAGES:-}" "${LANG:-}"; do
    case "$v" in ''|C|POSIX) continue ;; esac
    v="$(printf '%s' "$v" | tr '[:upper:]' '[:lower:]')"
    case "$v" in
      ko|ko[_.@-]*|kor|kor[_.@-]*|korean|korean[_.@-]*) echo ko ;;
      zh|zh[_.@-]*|chi|chi[_.@-]*|zho|zho[_.@-]*|chinese|chinese[_.@-]*) echo zh ;;
      *) echo en ;;
    esac
    return 0
  done
  echo en
}

# ── The model provider ──────────────────────────────────────────────────────
# DeepSeek's own API is dsh-base's default route and needs no rows. OpenGateway and any other
# OpenAI-compatible endpoint go through llm-pi-ai, whose route has to be written out in full: a
# profile row's `config` replaces the bundle's, and the image input is read from `input` only.

# A window of at most nine digits after any leading zeros: shell arithmetic wraps at 2^64, and a longer
# number was written into the profile as another one (18446744073709551716 as 100).
valid_window() { [[ $1 =~ ^0*[1-9][0-9]{0,8}$ ]]; }

# A custom endpoint's answers go into the profile's YAML: nothing that could leave a quoted value, or
# start a new key, gets through.
valid_endpoint() {   # valid_endpoint <baseURL> <model> <keyRef> <contextWindow>
  local url_re='^https://[A-Za-z0-9._~:/?#@!$&()*+,;=%-]+$' model_re='^[A-Za-z0-9._:/@+-]+$' ref_re='^[A-Z][A-Z0-9_]*_KEY$'
  # Plain http only to this machine: anywhere else the key would cross the network in clear text.
  local here_re='^http://(localhost|127\.0\.0\.1)(:[0-9]+)?(/[A-Za-z0-9._~:/?#@!$&()*+,;=%-]*)?$'
  { [[ $1 =~ $url_re ]] || [[ $1 =~ $here_re ]]; } && [[ $2 =~ $model_re ]] && [[ $3 =~ $ref_re ]] && valid_window "$4" || return 1
  # A key of its own: one the deployment reads for something else would be sent to this endpoint.
  case "$3" in DEEPSEEK_API_KEY|OG_API_KEY|SLACK_*|TELEGRAM_*|DISCORD_*) return 1 ;; esac
}

route_rows() {   # route_rows <id> <displayName> <keyRef> <baseURL> <model> <window> <images yes|no> [deepseek]
  local input='[text]'; [ "$7" = yes ] && input='[text, image]'
  printf '\n# ── Model route (written by install.sh) ─────────────────────────────────────\n'
  printf -- "- id: llm-pi-ai\n  config:\n    providers:\n      %s:\n        displayName: %s\n        apiKeyEnv: %s\n        api: openai-completions\n        baseURL: '%s'\n" "$1" "$2" "$3" "$4"
  # A DeepSeek model behind the endpoint: its thinking comes in DeepSeek's format, with these efforts.
  [ "${8:-}" = deepseek ] && printf '        compat:\n          thinkingFormat: deepseek\n'
  printf "        models:\n          - id: '%s'\n            name: '%s'\n            contextWindow: %s\n            input: %s\n" "$5" "$5" "$((10#$6))" "$input"
  [ "${8:-}" = deepseek ] && printf '            reasoningEfforts:\n              off:\n              low: low\n              medium: medium\n              high: high\n'
  printf "\n- id: agent-default-model\n  config:\n    provider: %s\n    model: '%s'\n" "$1" "$5"
  [ "${8:-}" = deepseek ] && printf '    reasoningEffort: medium\n'
  return 0
}

provider_rows() {   # provider_rows deepseek | opengateway | custom <keyRef> <baseURL> <model> <window> <images>
  case "$1" in
    deepseek) return 0 ;;
    opengateway) route_rows og OpenGateway OG_API_KEY https://apis.opengateway.ai/v1 deepseek/deepseek-v4.1-flash-ultrafast 1000000 yes deepseek ;;
    custom) route_rows custom 'Custom endpoint' "$2" "$3" "$4" "$5" "$6" ;;
    *) return 1 ;;
  esac
}

# Prompts read the terminal ($TTY, found by main), not stdin: under `curl … | bash` stdin is this script.
# With no terminal, every question takes its default and every secret is left empty.
ask() {         # ask <var> <question> [default]
  local answer=''
  if [ -n "${TTY:-}" ]; then printf '    %s%s%s ' "${bold:-}" "$2${3:+ [$3]}" "${off:-}" >"$TTY"; IFS= read -r answer <"$TTY" || true; fi
  printf -v "$1" '%s' "${answer:-${3:-}}"
}
ask_secret() {  # ask_secret <var> <question> — never echoed
  local answer=''
  if [ -n "${TTY:-}" ]; then printf '    %s%s%s ' "${bold:-}" "$2" "${off:-}" >"$TTY"; IFS= read -rs answer <"$TTY" || true; printf '\n' >"$TTY"; fi
  printf -v "$1" '%s' "$answer"
}

usable_key_name() { [[ $1 =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; }   # what can be a line of ~/.dsh/.env

# ── Credentials ─────────────────────────────────────────────────────────────
# The harness resolves a key from the launch environment, then its own store (~/.dsh/.credentials.yaml,
# where the DeepSeek Harness app saves keys, under `refs`), then <cwd>/.env, then ~/.dsh/.env. A key a
# harness user already has is theirs: it is used where it is, never asked for again, and the app's store
# is never written. (<cwd> is the agent home for the gateway, whose launcher sets any .env there aside.)

key_source() {   # key_source <NAME>: env, store or dotenv — where it is set — or nothing. Names only.
  local name="$1" home="${DSH_HOME:-$HOME/.dsh}"
  if [ -n "${!name:-}" ]; then echo env; return 0; fi
  # YAML, read as YAML: a blank line or a comment neither ends refs nor holds a key, at any indent; a
  # key may be quoted or have a space before its colon; refs may be a flow mapping on one line.
  if [ -f "$home/.credentials.yaml" ] && awk -v k="$name" '
      function iskey(s) { return s ~ ("^[\"\047]?" k "[\"\047]?[[:space:]]*:") }
      /^refs:[[:space:]]*\{/ { s = $0; sub(/^refs:[[:space:]]*\{/, "", s); n = split(s, parts, ","); for (i = 1; i <= n; i++) { p = parts[i]; sub(/^[[:space:]]+/, "", p); if (iskey(p)) found = 1 }; next }
      /^refs:[[:space:]]*(#.*)?$/ { inrefs = 1; next }
      /^[[:space:]]*(#.*)?$/      { next }
      /^[^[:space:]]/             { inrefs = 0 }
      inrefs { s = $0; sub(/^[[:space:]]+/, "", s); if (iskey(s)) found = 1 }
      END { exit !found }' "$home/.credentials.yaml" 2>/dev/null; then echo store; return 0; fi
  if grep -q "^$name=" "$home/.env" 2>/dev/null; then echo dotenv; return 0; fi
  return 0
}

has_key() { [ -n "$(key_source "$1")" ]; }

put_key() {     # put_key <name> <question>: asked only when the harness cannot already resolve it
  local value='' home="${DSH_HOME:-$HOME/.dsh}"
  case "$(key_source "$1")" in
    store) note "$1 is in DeepSeek Harness's own store (~/.dsh/.credentials.yaml) — used as it is"; return 0 ;;
    dotenv) note "$1 already set"; return 0 ;;
    env)
      # The gateway runs under launchd, which does not see this shell, so the value would have to be saved.
      # It may have been exported for something else (another app's token, an OpenAI key): only on a yes.
      local use=''
      ask use "$1 is set in this shell — save that value for the gateway (y/N)?" n
      case "$use" in
        y|Y|yes) printf '%s=%s\n' "$1" "${!1}" >>"$home/.env"; note "$1 taken from this shell's environment into $home/.env, for the gateway"; return 0 ;;
      esac
      note "$1 in this shell left alone" ;;
  esac
  ask_secret value "$2"
  if [ -n "$value" ]; then printf '%s=%s\n' "$1" "$value" >>"$home/.env"; note "$1 saved"; else note "$1 skipped — add it to $home/.env later"; fi
}

provider_key() {   # provider_key <provider> [keyRef]: the credential the provider's route reads
  case "$1" in opengateway) echo OG_API_KEY ;; custom) echo "$2" ;; *) echo DEEPSEEK_API_KEY ;; esac
}

# The credential an existing profile's default model reads, for a rerun: the provider agent-default-model
# names, then that route's apiKeyEnv under llm-pi-ai — whatever the comments, the indent or the other
# routes. DeepSeek's when the profile names no route of its own.
profile_key() {
  local found
  found="$(awk '
    function bare(s) { sub(/[[:space:]]*#.*$/, "", s); gsub(/^[[:space:]]+|[[:space:]]+$/, "", s); gsub(/^["\047]|["\047]$/, "", s); return s }
    function indent(s) { match(s, /^[[:space:]]*/); return RLENGTH }
    function row(s, name) { return s ~ ("^- id:[[:space:]]*[\"\047]?" name "[\"\047]?[[:space:]]*(#.*)?$") }
    /^[[:space:]]*(#.*)?$/ { next }
    FNR == NR {
      # Every top-level "- " starts another row. The last default-model row is the model (a config block
      # replaces the whole config), and only its own provider counts, not one nested deeper.
      if ($0 ~ /^- /) { dm = row($0, "agent-default-model"); cfg = -1; if (dm) { want = ""; taken = 0 } }
      else if (dm && cfg < 0 && $0 ~ /^[[:space:]]+config:[[:space:]]*(#.*)?$/) cfg = indent($0)
      else if (dm && cfg >= 0 && !taken && indent($0) == cfg + 2 && $0 ~ /^[[:space:]]+provider:/) { v = $0; sub(/^[[:space:]]+provider:/, "", v); want = bare(v); taken = 1 }
      next
    }
    # The last llm-pi-ai row'"'"'s routes, likewise.
    /^- / { pi = row($0, "llm-pi-ai"); prov = -1; route = ""; if (pi) key = ""; next }
    pi && /^[[:space:]]+providers:[[:space:]]*(#.*)?$/ { prov = indent($0); next }
    # A line at the routes'"'"' indent names the next route, or, if it is not a plain key, ends the one before.
    pi && prov >= 0 && indent($0) == prov + 2 {
      if ($0 ~ /^[[:space:]]+["\047]?[A-Za-z0-9_.-]+["\047]?:[[:space:]]*(#.*)?$/) { r = $0; sub(/:[[:space:]]*(#.*)?$/, "", r); route = bare(r) } else route = ""
      child = -1
      next
    }
    # The route'"'"'s own key: at the indent of its first line, not one nested deeper (a model entry'"'"'s).
    pi && route != "" && indent($0) > prov + 2 && child < 0 { child = indent($0) }
    pi && route != "" && route == want && indent($0) == child && $0 ~ /^[[:space:]]+apiKeyEnv:/ { v = $0; sub(/^[[:space:]]+apiKeyEnv:/, "", v); key = bare(v); next }
    END { print key }
  ' "$1" "$1" 2>/dev/null || true)"
  printf '%s\n' "${found:-DEEPSEEK_API_KEY}"
}

# Install the checkout's dependencies and build it. pnpm when it is there, from the lockfile the checkout
# pins (npm does not read it); npm otherwise, without writing a package-lock.json of its own. Neither runs
# install scripts: the checkout's own prepare would build it a second time. pnpm writes its errors, and its
# prompts, to stdout: its output is kept and shown when it fails (it is told not to ask before removing a
# node_modules from another pnpm), and npm is tried after it.
build_checkout() {   # build_checkout <checkout>
  local log
  log="$(mktemp)"
  if command -v pnpm >/dev/null; then
    if (cd "$1" && pnpm install --frozen-lockfile --ignore-scripts --config.confirmModulesPurge=false) >"$log" 2>&1; then
      (cd "$1" && npm run --silent build) >"$log" 2>&1 || { sed 's/^/      /' "$log" | tail -n 30 >&2; rm -f "$log"; die "the build failed (its output above)"; }
      rm -f "$log"
      return 0
    fi
    note "pnpm could not install; trying npm. pnpm said:"
    tail -n 20 "$log" | sed 's/^/      /'
  fi
  if ! (cd "$1" && npm install --no-package-lock --ignore-scripts --no-audit --no-fund --loglevel=error) >"$log" 2>&1; then
    sed 's/^/      /' "$log" | tail -n 30 >&2; rm -f "$log"; die "npm could not install the dependencies (its output above)"
  fi
  (cd "$1" && npm run --silent build) >"$log" 2>&1 || { sed 's/^/      /' "$log" | tail -n 30 >&2; rm -f "$log"; die "the build failed (its output above)"; }
  rm -f "$log"
}

set_profile_language() {   # set_profile_language <patch> <en|ko|zh>
  sed -i '' -e "s/^    language: en$/    language: $2/" "$1"
}

# The first line after the shebang marks a launcher this installer wrote, so a rerun knows it may
# replace it, and harness_cli knows not to take it for the harness.
LAUNCHER_MARK='# deepseek-bot terminal launcher'

# `dsh` in ~/.local/bin, running the checkout's build. A dsh already there that is not ours — the
# harness CLI, say — is left as it was.
install_terminal() {   # install_terminal <checkout>
  local launcher="$HOME/.local/bin/dsh"
  if [ -e "$launcher" ] && ! grep -q "^$LAUNCHER_MARK" "$launcher" 2>/dev/null; then
    printf '%s is not this project'"'"'s; run the terminal as: node %s/dist/tui/main.js\n' "$launcher" "$1"
    return 1
  fi
  mkdir -p "$HOME/.local/bin"
  printf '#!/bin/sh\n%s (install.sh writes it; a rerun replaces it)\nexec node "%s/dist/tui/main.js" "$@"\n' "$LAUNCHER_MARK" "$1" >"$launcher"
  chmod +x "$launcher"
  printf '%s\n' "$launcher"
}

# The harness CLI: a dsh on the PATH unless it is this project's terminal, else the one in the app.
harness_cli() {
  local found
  found="$(command -v dsh 2>/dev/null || true)"
  if [ -n "$found" ] && ! grep -q -e "^$LAUNCHER_MARK" -e 'dsh: the bot in a terminal' "$found" 2>/dev/null; then
    printf '%s\n' "$found"
  else
    printf '%s\n' "$HARNESS_APP/Contents/Resources/runtime/cli/bin/dsh"
  fi
}

# ── DeepSeek Harness ────────────────────────────────────────────────────────
# The harness is the DeepSeek Harness app, and its CLI is inside it: the launcher, the services and the
# terminal all look for it there. When the app is missing, this installer offers to put it there from
# DeepSeek's own download server. The app's updater reads a feed per architecture (its app-update.yml:
# channel nightly, so the file is nightly-mac.yml) that names the current build, its sha512 and its size,
# and the zip it names holds the app at its top.
HARNESS_APP='/Applications/DeepSeek Harness.app'
HARNESS_FEEDS='https://download.deepseek.com/dsh-desk/feeds'

# The feed for this Mac. uname under Rosetta says x86_64 on an arm64 Mac; the hardware is asked first.
harness_feed() {   # harness_feed [machine]
  local machine="${1:-$(uname -m)}"
  [ -n "${1:-}" ] || [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" != 1 ] || machine=arm64
  case "$machine" in
    arm64) printf '%s/mac-arm64/nightly-mac.yml\n' "$HARNESS_FEEDS" ;;
    x86_64) printf '%s/mac-x64/nightly-mac.yml\n' "$HARNESS_FEEDS" ;;
    *) warn "no DeepSeek Harness build for $machine"; return 1 ;;
  esac
}

# What the feed names, as "<url> <sha512> <size> <version>" on one line. The feed is electron-builder's
# YAML: a long value is a folded scalar (`>-`) on the line after its key, a short one is on the key's line;
# `path` and the top-level `sha512` are the first file's. Each is checked for shape before it is trusted —
# the url https (or a local file), the hash 64 bytes in base64, the size a number — so nothing a feed says
# reaches a command line unchecked.
harness_release() {   # harness_release <feed url>
  local yml line url sum size version
  yml="$(curl -fsSL --max-time 60 "$1")" || { warn "could not read the DeepSeek Harness feed at $1"; return 1; }
  line="$(printf '%s\n' "$yml" | awk '
    function val(v) { gsub(/^[[:space:]]+|[[:space:]]+$/, "", v); return v }
    want != "" { if ($0 ~ /^[[:space:]]*$/) next; got[want] = val($0); want = ""; next }
    /^(path|sha512|version):/ { k = $1; sub(/:$/, "", k); v = $0; sub(/^[a-z0-9]+:[[:space:]]*/, "", v); v = val(v); if (v ~ /^[>|]-?$/) want = k; else if (!(k in got)) got[k] = v; next }
    /^[[:space:]]*size:[[:space:]]*[0-9]+[[:space:]]*$/ { if (!("size" in got)) { v = $0; sub(/^[[:space:]]*size:[[:space:]]*/, "", v); got["size"] = val(v) } }
    END { printf "%s %s %s %s\n", got["path"], got["sha512"], got["size"], got["version"] }')"
  read -r url sum size version <<<"$line"
  { [[ $url =~ ^(https|file)://[^[:space:]]+$ ]] && [[ $sum =~ ^[A-Za-z0-9+/]{86}==$ ]] && [[ $size =~ ^[0-9]+$ ]] && [ -n "$version" ]; } \
    || { warn "the DeepSeek Harness feed at $1 does not name a build the way this installer reads it (an https url, a sha512, a size and a version)"; return 1; }
  printf '%s %s %s %s\n' "$url" "$sum" "$size" "$version"
}

# Download the build and place the app. Nothing lands in <applications> unless the bytes are the ones the
# feed describes: the size and the sha512 both have to match. The zip is opened with ditto, which keeps
# the bundle as it was signed, and only an archive that holds the app, with its CLI, is placed; one that is
# there already is not replaced.
install_harness() {   # install_harness <url> <sha512> <size> <version> <applications dir>
  local tmp zip host status=0 app="$5/$(basename "$HARNESS_APP")"
  [ -d "$5" ] && [ -w "$5" ] || { warn "$5 is not writable by you; put the app there yourself, then run this again"; return 1; }
  host="${1#*://}"; host="${host%%/*}"; [ -n "$host" ] || host="$1"
  tmp="$(mktemp -d)"; zip="$tmp/$(basename "$HARNESS_APP" .app).zip"
  note "downloading DeepSeek Harness $4 ($(( $3 / 1048576 )) MB) from $host"
  if [ -t 2 ]; then curl -fL --retry 3 --connect-timeout 30 --speed-limit 1024 --speed-time 60 --progress-bar -o "$zip" "$1" || status=$?
  else curl -fsSL --retry 3 --connect-timeout 30 --speed-limit 1024 --speed-time 60 -o "$zip" "$1" || status=$?; fi
  [ "$status" -eq 0 ] || { rm -rf "$tmp"; warn "the download failed (curl exit $status); nothing was installed"; return 1; }
  if [ "$(stat -f %z "$zip")" != "$3" ] || [ "$(openssl dgst -sha512 -binary "$zip" | base64 | tr -d '\n')" != "$2" ]; then
    rm -rf "$tmp"; warn "the download is not the build the feed describes (its size or sha512 differs); nothing was installed"; return 1
  fi
  note "checked against the feed's sha512"
  ditto -x -k "$zip" "$tmp/app" 2>/dev/null || { rm -rf "$tmp"; warn "the archive could not be opened; nothing was installed"; return 1; }
  [ -x "$tmp/app/$(basename "$HARNESS_APP")/Contents/Resources/runtime/cli/bin/dsh" ] \
    || { rm -rf "$tmp"; warn "the archive does not hold $(basename "$HARNESS_APP") with its CLI; nothing was installed"; return 1; }
  [ ! -e "$app" ] || { rm -rf "$tmp"; warn "$app exists already; nothing was replaced"; return 1; }
  mv "$tmp/app/$(basename "$HARNESS_APP")" "$5/" || { rm -rf "$tmp"; warn "could not move the app into $5; nothing was installed"; return 1; }
  rm -rf "$tmp"
}

# The harness is missing: install it, or say why not. DEEPBOT_INSTALL_HARNESS decides without a question
# (1 installs, 0 never does); otherwise it is asked at a terminal, Enter meaning yes. Without a terminal —
# an agent, a script — nothing this large is downloaded on an assumption: the run stops and says what to set.
ensure_harness() {   # ensure_harness <feed url> <applications dir>
  # Not `answer`: ask's own local of that name would take the assignment, and the question's reply be lost.
  local release url sum size version yes_no host
  case "${DEEPBOT_INSTALL_HARNESS:-}" in
    1|'') ;;
    0) warn "DeepSeek Harness is not installed, and DEEPBOT_INSTALL_HARNESS=0 says not to install it. Install the app, or set DSH_BIN to its CLI, then run this again."; return 1 ;;
    *) warn "DEEPBOT_INSTALL_HARNESS=$DEEPBOT_INSTALL_HARNESS: 1 installs the DeepSeek Harness app when it is missing, 0 never does."; return 1 ;;
  esac
  if [ -z "${DEEPBOT_INSTALL_HARNESS:-}" ] && [ -z "${TTY:-}" ]; then
    warn "DeepSeek Harness is not installed. This installer downloads it (DeepSeek's own build, a few hundred MB, into $2) when told to:"
    warn "  curl -fsSL https://raw.githubusercontent.com/rlaope/deepseek-bot/master/install.sh | DEEPBOT_INSTALL_HARNESS=1 bash"
    warn "Or install the app yourself, or set DSH_BIN to its CLI, then run this again."
    return 1
  fi
  release="$(harness_release "$1")" || return 1
  read -r url sum size version <<<"$release"
  if [ -z "${DEEPBOT_INSTALL_HARNESS:-}" ]; then
    host="${url#*://}"; host="${host%%/*}"; [ -n "$host" ] || host="$url"
    ask yes_no "DeepSeek Harness is not installed. Download $version ($(( size / 1048576 )) MB, from $host) into $2 (Y/n)?" y
    case "$yes_no" in
      y|Y|yes) ;;
      *) warn "not installed. Install the DeepSeek Harness app, or set DSH_BIN to its CLI, then run this again."; return 1 ;;
    esac
  fi
  install_harness "$url" "$sum" "$size" "$version" "$2"
}

# The services, the runner and the health probe read the harness's home at ~/.dsh. A DSH_HOME elsewhere
# would put the tokens and the profile where nothing running looks.
check_dsh_home() {
  [ -z "${DSH_HOME:-}" ] || [ "${DSH_HOME%/}" = "$HOME/.dsh" ] || {
    printf 'error: DSH_HOME=%s is not supported by this installer; the services read %s\n' "$DSH_HOME" "$HOME/.dsh" >&2
    return 1
  }
}

# A setting from the environment, else the one the installed gateway service runs with, else the default.
# An update that put the service back on the defaults would scaffold a second agent home and profile.
setting() {   # setting <DEEPBOT_HOME|DEEPBOT_PROFILE> <default>
  local given="${!1:-}" plist="$HOME/Library/LaunchAgents/ai.deepbot.gateway.plist"
  if [ -z "$given" ] && [ -f "$plist" ]; then
    given="$(/usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:$1" "$plist" 2>/dev/null || true)"
  fi
  printf '%s\n' "${given:-$2}"
}

# Bring a checkout to the ref's tip. One this installer cloned is shallow and is reset to it, as it always
# was. A full clone is someone's working copy: it stays full and only moves forward, and local changes,
# another branch, or commits not on the ref stop the update instead of being reset away.
fetch_checkout() {   # fetch_checkout <dir> <ref>
  [ -z "$(git -C "$1" status --porcelain --untracked-files=no)" ] \
    || die "$1 has local changes: commit or stash them, then update again."
  if [ "$(git -C "$1" rev-parse --is-shallow-repository)" = true ]; then
    git -C "$1" fetch --quiet --depth 1 origin "$2"
    git -C "$1" checkout --quiet -B "$2" FETCH_HEAD
    return 0
  fi
  local branch
  branch="$(git -C "$1" symbolic-ref --quiet --short HEAD || true)"
  [ "$branch" = "$2" ] || die "$1 is on ${branch:-no branch}, not $2: check out $2 (or set DEEPBOT_REF), then update again."
  git -C "$1" fetch --quiet origin "$2"
  git -C "$1" merge --quiet --ff-only FETCH_HEAD 2>/dev/null \
    || die "$1 has commits that are not on origin's $2: update it by hand."
}

# The commit an install last finished at, so `dsh update` can tell an install that is current from one
# whose last update stopped part way.
record_install() {   # record_install <dir>
  mkdir -p "$DSH_HOME/service"
  git -C "$1" rev-parse HEAD >"$DSH_HOME/service/deepbot.commit"
}

step() { printf '%s==>%s %s\n' "${blue:-}" "${off:-}" "$*"; }
note() { printf '    %s%s%s\n' "${dim:-}" "$*" "${off:-}"; }
warn() { printf '    %s\n' "$*" >&2; }   # why a step did not do something, before its caller stops
die()  { printf '%serror:%s %s\n' "${red:-}" "${off:-}" "$*" >&2; exit 1; }

# A line that may carry a credential: the web UI's ?token=, a Slack token, a bearer header, an API key.
# Only those are held back — a sentence that merely says "token" is not one, and used to be cut in half.
without_secrets() { grep -v -i -E 'token=|token:|xox[a-z]-|xapp-|bearer |sk-[a-z0-9]' || true; }

SERVICES_FAILED=0
service_install() {   # service_install <what> <installer> [show]: one service; a failure is said and counted
  local status=0
  if [ "${3:-}" = show ]; then
    "$2" 2>&1 | without_secrets | sed 's/^/    /' || status=${PIPESTATUS[0]}
  else
    "$2" >/dev/null 2>&1 || status=$?
  fi
  if [ "$status" -eq 0 ]; then note "$1 installed"
  else note "$1: $(basename "$2") failed — run it by hand to see why"; SERVICES_FAILED=$((SERVICES_FAILED + 1)); fi
}

services_done() {     # the end of the services step: a failed one fails the install
  [ "$SERVICES_FAILED" -eq 0 ] && return 0
  step "done, but $SERVICES_FAILED service(s) did not install"
  note "the bot is not running as a service until they do; rerun the line above after fixing what they said"
  return 1
}

main() {

DEEPBOT_DIR="${DEEPBOT_DIR:-$HOME/.deepbot}"
DEEPBOT_HOME="$(setting DEEPBOT_HOME "$HOME/dsh-agent")"
DEEPBOT_PROFILE="$(setting DEEPBOT_PROFILE agent)"
DEEPBOT_REPO="${DEEPBOT_REPO:-https://github.com/rlaope/deepseek-bot.git}"
DEEPBOT_REF="${DEEPBOT_REF:-master}"
check_dsh_home || exit 1
DSH_HOME="$HOME/.dsh"
DSH_BIN_GIVEN="${DSH_BIN:-}"
DSH_BIN="${DSH_BIN:-$(harness_cli)}"
export DSH_HOME DSH_BIN DEEPBOT_HOME DEEPBOT_PROFILE

blue=$'\033[38;5;33m'; dim=$'\033[2m'; bold=$'\033[1m'; red=$'\033[31m'; off=$'\033[0m'
[ -t 1 ] || { blue=''; dim=''; bold=''; red=''; off=''; }

cat <<BANNER
${blue}
        ▄▄████▄▄            ▄▄
      ▄██████████▄▄▄     ▄▄██
     ████▀ ▀████████████████▀     ${bold}deepbot${off}${blue}
     ████▄▄▄█████████████▀▀      ${off}${dim}an always-on agent on DeepSeek Harness${off}${blue}
      ▀████████████▀▀▀
         ▀▀▀▀▀▀
${off}
BANNER

# Prompts read the terminal, not stdin: under `curl … | bash` stdin is this script.
TTY=''
if [ -r /dev/tty ] && [ -w /dev/tty ] && (exec </dev/tty) 2>/dev/null; then TTY=/dev/tty; fi

step "checking what this needs"
[ "$(uname -s)" = "Darwin" ] || die "macOS only: the services are launchd jobs and the sandbox runner is Seatbelt."
command -v git >/dev/null || die "git is not installed (xcode-select --install)."
command -v node >/dev/null || die "Node.js 22 or newer is needed (brew install node)."
command -v npm >/dev/null || die "npm is needed (it ships with Node.js)."
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 22 ] || die "Node.js 22 or newer is needed; this is $(node -v)."
note "node $(node -v) · git"

step "DeepSeek Harness"
if [ -x "$DSH_BIN" ]; then
  note "dsh at $DSH_BIN"
else
  # Only the app's own place is filled: a DSH_BIN someone gave names where they keep the harness, and an
  # app that is there without its CLI is theirs to repair.
  [ -z "$DSH_BIN_GIVEN" ] || die "DeepSeek Harness was not found at DSH_BIN=$DSH_BIN."
  [ ! -e "$HARNESS_APP" ] || die "$HARNESS_APP is there, but has no CLI at $DSH_BIN; reinstall the app."
  feed="$(harness_feed)" || die "install the DeepSeek Harness app yourself and set DSH_BIN to its CLI."
  ensure_harness "$feed" "$(dirname "$HARNESS_APP")" || exit 1
  [ -x "$DSH_BIN" ] || die "the app was placed, but its CLI is not at $DSH_BIN."
  harness_version="$("$DSH_BIN" --version 2>/dev/null)" || die "the installed harness CLI does not run: $DSH_BIN --version failed."
  note "installed $HARNESS_APP · dsh $harness_version"
fi

step "fetching deepbot into $DEEPBOT_DIR"
# .git is a file in a linked worktree.
if [ -e "$DEEPBOT_DIR/.git" ]; then
  fetch_checkout "$DEEPBOT_DIR" "$DEEPBOT_REF"
  note "updated to $(git -C "$DEEPBOT_DIR" rev-parse --short HEAD)"
elif [ -e "$DEEPBOT_DIR" ]; then
  die "$DEEPBOT_DIR exists and is not a git checkout; move it aside or set DEEPBOT_DIR."
else
  git clone --quiet --depth 1 --branch "$DEEPBOT_REF" "$DEEPBOT_REPO" "$DEEPBOT_DIR"
  note "cloned $(git -C "$DEEPBOT_DIR" rev-parse --short HEAD)"
fi

step "building"
build_checkout "$DEEPBOT_DIR"
[ -f "$DEEPBOT_DIR/dist/index.js" ] || die "the build produced no dist/index.js"
note "dist/ ready"

step "agent home and gateway profile"
profile_dir="$DSH_HOME/profiles/$DEEPBOT_PROFILE"
new_profile=0; [ -e "$profile_dir" ] || new_profile=1
# Asked, and checked, before init.sh writes the profile: a refused answer used to leave a profile behind
# that a rerun then kept as it was. No messenger is asked about: those are `dsh gateway setup`'s.
if [ "$new_profile" -eq 1 ]; then
  ask language "language of the bot's own messages (en / ko / zh)?" "$(env_language)"
  case "$language" in en|ko|zh) ;; *) die "unknown language: $language (en, ko or zh)" ;; esac
  ask provider "model provider: deepseek (DeepSeek's own API, the default), or opengateway / custom?" deepseek
  case "$provider" in
    deepseek|opengateway) ;;
    custom)
      ask base_url "the endpoint's base URL (OpenAI-compatible, https://…/v1)?"
      ask model_id "the model id it serves?"
      ask key_ref "the name to keep its API key under?" CUSTOM_API_KEY
      ask window "the model's context window, in tokens?" 128000
      ask images "does the model read images (yes / no)?" no
      valid_window "$window" || die "context window: a whole number of tokens from 1 to 999999999 (got: $window)"
      valid_endpoint "$base_url" "$model_id" "$key_ref" "$window" \
        || die "the endpoint, model id or key name has a character a profile cannot hold"
      case "$images" in yes|no) ;; *) die "images: yes or no (got: $images)" ;; esac ;;
    *) die "unknown provider: $provider (deepseek, opengateway or custom)" ;;
  esac
fi
DEEPBOT_INSTALLER=1 DSH_BIN="$DSH_BIN" "$DEEPBOT_DIR/init.sh" --home "$DEEPBOT_HOME" --profile "$DEEPBOT_PROFILE" | sed 's/^/    /'

step "the model's key"
note "a key the harness already has (its store, ~/.dsh/.env, or this shell) is used as it is; a new one goes to $DSH_HOME/.env (mode 600)"
mkdir -p "$DSH_HOME"; touch "$DSH_HOME/.env"; chmod 600 "$DSH_HOME/.env"
# The model's key: the provider chosen now, or the one an existing profile's route reads.
if [ "$new_profile" -eq 1 ]; then model_key="$(provider_key "$provider" "${key_ref:-}")"; else model_key="$(profile_key "$profile_dir/cordis.patch.yml")"; fi
# A route may name its key in a way no .env line can hold (a !!js expression): that one is the operator's.
if ! usable_key_name "$model_key"; then
  note "the model route reads its key as '$model_key', which this installer does not set — the route's own business"
else case "$model_key" in
  DEEPSEEK_API_KEY) put_key DEEPSEEK_API_KEY "DeepSeek API key:" ;;
  OG_API_KEY) put_key OG_API_KEY "OpenGateway API key:" ;;
  *) put_key "$model_key" "API key for the model endpoint ($model_key):" ;;
esac; fi
# web_search goes through DeepSeek's API whatever answers the chat (dsh-base's web-search-deepseek row).
if [ "$model_key" != DEEPSEEK_API_KEY ] && ! has_key DEEPSEEK_API_KEY; then
  if [ "$new_profile" -eq 1 ]; then put_key DEEPSEEK_API_KEY "DeepSeek API key, for web search (enter to skip):"
  else note "web search uses DeepSeek's API: add DEEPSEEK_API_KEY to $DSH_HOME/.env to turn it on"; fi
fi

if [ "$new_profile" -eq 1 ]; then
  patch="$profile_dir/cordis.patch.yml"
  # The terminal only, answering everywhere: `dsh gateway setup` adds a messenger, and '*' already lets it in.
  sed -i '' -e "s/^    platform: slack$/    platform: ['local']/" "$patch"
  set_profile_language "$patch" "$language"
  provider_rows "$provider" "${key_ref:-}" "${base_url:-}" "${model_id:-}" "${window:-}" "${images:-}" >>"$patch"
  note "profile: the terminal, language $language, model provider $provider"
else
  note "profile $DEEPBOT_PROFILE already existed — its settings are kept"
  grep -q "^    platform: .*'local'" "$profile_dir/cordis.patch.yml" 2>/dev/null \
    || note "to use dsh, add the terminal to the profile: dsh gateway setup local"
  grep -q "^    language: " "$profile_dir/cordis.patch.yml" 2>/dev/null \
    || note "the bot speaks English; for Korean or Chinese add language: ko or zh to the deepbot row"
fi

step "the terminal"
# How to update, at the end: dsh update where dsh is this project's, the install line again where it is not.
update_with='the same curl line again'
if launcher="$(install_terminal "$DEEPBOT_DIR")"; then
  note "dsh: $launcher"
  case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) note "add ~/.local/bin to your PATH to run it as dsh" ;; esac
  # dsh is this launcher only when it is the first dsh on the PATH.
  [ "$(command -v dsh 2>/dev/null || true)" = "$launcher" ] && update_with="${bold}dsh update${off}"
else
  note "$launcher"
fi

if [ "${DEEPBOT_SKIP_SERVICES:-0}" = "1" ]; then
  step "services skipped (DEEPBOT_SKIP_SERVICES=1)"
  note "start it by hand: \"$DSH_BIN\" --profile $DEEPBOT_PROFILE --no-open"
  record_install "$DEEPBOT_DIR"
  return 0
fi

step "services"
export DEEPBOT_REPO="$DEEPBOT_DIR" DEEPBOT_NODE="$(command -v node)"
service_install "gateway service" "$DEEPBOT_DIR/service/install-service.sh" show
service_install "health probe" "$DEEPBOT_DIR/service/install-health.sh"
service_install "watch runner" "$DEEPBOT_DIR/watch/install-watch.sh"
service_install "recall index job" "$DEEPBOT_DIR/recall/install-refresh.sh"
services_done || return 1
record_install "$DEEPBOT_DIR"

step "done"
node "$DSH_HOME/service/health-check.mjs" --status 2>/dev/null | sed 's/^/    /' || true
cat <<NEXT

    Talk to it here: ${bold}dsh${off}
    Connect Slack, Telegram or Discord: ${bold}dsh gateway setup${off}
    Your agent's persona is ${bold}$DEEPBOT_HOME/SOUL.md${off} — edit it, it is yours.
    Update later: $update_with
NEXT
}

# The last line, so a download cut short defines functions and runs nothing.
[ "${DEEPBOT_INSTALL_SOURCED:-0}" = 1 ] || main "$@"
