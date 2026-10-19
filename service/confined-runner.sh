#!/bin/bash
# A sandbox runner that also confines READS.
#
# Why this exists: the harness sandbox fences writes only. On macOS its Seatbelt
# profile is allow-default with (deny file-write*), so an agent can read anything the
# user can — another instance's home, a retired bot's token file. Measured: unwrapped,
# the agent read a canary from a different agent's directory and answered with it.
#
# The obvious fix — wrapping the whole gateway in a read-denying profile — does not
# work: macOS refuses nested sandbox-exec (`sandbox_apply: Operation not permitted`),
# so the harness's own sandbox probe finds no usable backend, refuses to run bash at
# all, and the agent asks to escalate into a request with no answerer. Verified, then
# reverted. That is why this replaces the runner instead of wrapping the process.
#
# The contract, from dsh-sandbox-local's confine():
#
#   <runner argv...> <bwrapProfileArgs(policy)...> -- <command...>
#
# with the policy expressed as bwrap-shaped arguments. Only two shapes matter here,
# because danger-full-access never reaches the runner:
#
#   --ro-bind / / ... --die-with-parent                        => read-only
#   --ro-bind / / ... --die-with-parent --tmpfs /tmp --bind R R => workspace-write
#
# Usage:  confined-runner.sh [--print-profile] <profile args...> -- <command...>
set -uo pipefail

HOME_DIR="${DEEPBOT_HOME:-$HOME/dsh-agent}"

mode="read-only"
workspace_root=""
command=()
seen_separator=0
print_only=0
args=("$@")
if [ "${#args[@]}" -gt 0 ] && [ "${args[0]}" = "--print-profile" ]; then
  print_only=1
  args=("${args[@]:1}")
fi

i=0
while [ $i -lt ${#args[@]} ]; do
  arg="${args[$i]}"
  case "$arg" in
    --) seen_separator=1; i=$((i+1)); command=("${args[@]:$i}"); break ;;
    --bind) workspace_root="${args[$((i+2))]:-}"; mode="workspace-write"; i=$((i+3)) ;;
    --ro-bind|--dev|--tmpfs|--proc) i=$((i+2)) ;;
    --unshare-pid|--die-with-parent) i=$((i+1)) ;;
    *) i=$((i+1)) ;;
  esac
done

if [ "$seen_separator" -eq 0 ] && [ "$print_only" -eq 0 ]; then
  echo "confined-runner: no -- separator; refusing to guess what to run" >&2
  exit 64
fi

# Seatbelt matches resolved paths: a workspace under a symlinked directory (/var -> /private/var) is
# written to by its resolved name, and a rule naming it only as given matched nothing — every write
# there was refused, and the .env rule below guarded nothing. Both names get every workspace rule.
workspace_names=()
if [ -n "$workspace_root" ]; then
  workspace_names=("$workspace_root")
  # The name in the case it has on disk: entries below are resolved the same way, and compared with it.
  workspace_real="$(/bin/realpath "$workspace_root" 2>/dev/null || true)"
  if [ -n "$workspace_real" ] && [ "$workspace_real" != "$workspace_root" ]; then workspace_names+=("$workspace_real"); fi
fi

# The command's own temp directory. A command could make no temp file in its TMPDIR (the user's /var/folders/…/T/):
# the rule named /var/folders, and Seatbelt matches the resolved /private/var/folders. Opening the user's temp itself
# would let a command rewrite what unconfined processes keep there — an update's installer, other programs' sockets
# and wrappers (found by review). So each workspace gets a directory of its own inside it, TMPDIR points there, and
# only that is opened. Where it is comes from the system (getconf, by absolute path, its answer checked), never from
# TMPDIR or PATH, which whoever starts a command could set.
cmd_temp=""
cmd_temp_real=""
user_temp=""
user_temp_real=""
if [ "$mode" = "workspace-write" ] && [ -n "$workspace_root" ]; then
  user_temp="$(/usr/bin/getconf DARWIN_USER_TEMP_DIR 2>/dev/null || true)"
  user_temp="${user_temp%/}"
  if [[ $user_temp =~ ^(/private)?/var/folders/[^/]+/[^/]+/T$ ]] && [ -d "$user_temp" ] && [ ! -L "$user_temp" ]; then
    user_temp_real="$(cd "$user_temp" 2>/dev/null && pwd -P || true)"
    hash="$(printf '%s' "${workspace_real:-$workspace_root}" | /usr/bin/shasum -a 256 2>/dev/null | /usr/bin/cut -c1-16)"
    # Without a hash every workspace would share one directory: none, then.
    if [[ $hash =~ ^[0-9a-f]{16}$ ]]; then
      cmd_temp="$user_temp/deepbot-cmd-$hash"
      if [ -n "$user_temp_real" ]; then cmd_temp_real="$user_temp_real/deepbot-cmd-$hash"; fi
    fi
  else
    user_temp=""
  fi
fi

# The commands' network (the deepbot row's commandNetwork). The gateway, when it runs a proxy for this agent home,
# writes where it listens to $DSH_HOME/deepbot/command-network/<the home's real path, hashed>.json. A file there holds
# commands to one connection: the proxy's port on this machine, named in it (a plain file, not a link). Not every port
# on this machine: with those open, a command reached the local services directly, around the proxy (seen live). A
# file that names no port, or a proxy that has gone, leaves them no way out: closed, not open. No file, no change.
# Keyed by the agent home, not the workspace, so a tenant's commands are held with the home's.
net_file=""
net_port=""
home_real="$(/bin/realpath "$HOME_DIR" 2>/dev/null || true)"
if [ -n "$home_real" ]; then
  net_key="$(printf '%s' "$home_real" | /usr/bin/shasum -a 256 2>/dev/null | /usr/bin/cut -c1-16)"
  if [[ $net_key =~ ^[0-9a-f]{16}$ ]]; then
    candidate="${DSH_HOME:-$HOME/.dsh}/deepbot/command-network/$net_key.json"
    if [ -e "$candidate" ] || [ -L "$candidate" ]; then
      net_file="$candidate"
      if [ -f "$candidate" ] && [ ! -L "$candidate" ]; then
        net_port="$(/usr/bin/sed -n 's/.*"port":\([0-9][0-9]*\).*/\1/p' "$candidate" 2>/dev/null)"
        if ! [[ $net_port =~ ^[0-9]{1,5}$ ]] || [ "$net_port" -lt 1 ] || [ "$net_port" -gt 65535 ]; then net_port=""; fi
        # Its gateway still running: after a crash the port may be another program's by now.
        net_pid="$(/usr/bin/sed -n 's/.*"pid":\([0-9][0-9]*\).*/\1/p' "$candidate" 2>/dev/null)"
        if ! [[ $net_pid =~ ^[0-9]{1,10}$ ]] || ! /bin/ps -p "$net_pid" >/dev/null 2>&1; then net_port=""; fi
      fi
    fi
  fi
fi

# The writable set mirrors the harness's own intent: the workspace, temp, and the
# null sink. Reads are allowed everywhere except other instances' data.
profile() {
  echo '(version 1)'
  echo '(allow default)'
  if [ "$mode" = "workspace-write" ]; then
    echo '(deny file-write*)'
    for name in ${workspace_names[@]+"${workspace_names[@]}"}; do
      printf '(allow file-write* (subpath %s))\n' "$(sbpl "$name")"
    done
    # Temp: /tmp, and the command's own temp directory (cmd_temp, below), by both names. The first name is inert on
    # current macOS, where only resolved paths match; it is kept as every rule here is.
    printf '(allow file-write* (subpath "/tmp") (subpath "/private/tmp"))\n'
    if [ -n "$cmd_temp" ]; then
      printf '(allow file-write* (subpath %s))\n' "$(sbpl "$cmd_temp")"
      if [ -n "$cmd_temp_real" ] && [ "$cmd_temp_real" != "$cmd_temp" ]; then printf '(allow file-write* (subpath %s))\n' "$(sbpl "$cmd_temp_real")"; fi
    fi
    printf '(allow file-write* (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/dtracehelper"))\n'
    # Except the workspace's .env: the harness's credential chain reads <cwd>/.env before the
    # deployment's own, and the gateway runs in this workspace — a .env here would replace the tokens.
    for name in ${workspace_names[@]+"${workspace_names[@]}"}; do
      # #"…" is a raw literal: a " would end it and no backslash escapes one, so a quote in the name
      # matches as any one character there (the rule can only deny a little more).
      escaped="$(printf '%s' "$name" | sed 's/[][\.*^$+?(){}|]/\\&/g; s/"/./g')"
      printf '(deny file-write* (regex #"^%s/\\.env(\\..*)?$"))\n' "$escaped"
    done
    # And its .git, when a directory above has one and the adapter keeps one here as the instruction root:
    # removed or moved aside, the harness's loader, which looks again on every step, would climb past the
    # workspace to the instructions above. What is in it stays writable (git init works). The workspace's
    # own entry keeps its mode, ACL, flags and attributes too, since an unreadable directory makes skill
    # discovery climb; the files in it are still written. With nothing above, its .git is no marker, and a
    # repository there can remove its own. Judged on either name (the loader climbs the one it was given,
    # Seatbelt matches the resolved one), and written on both.
    needs_root=0
    for name in ${workspace_names[@]+"${workspace_names[@]}"}; do
      if [ -d "$name/.git" ] && [ ! -L "$name/.git" ] && root_above "$name"; then needs_root=1; fi
    done
    if [ "$needs_root" -eq 1 ]; then
      for name in ${workspace_names[@]+"${workspace_names[@]}"}; do
        printf '(deny file-write* (literal %s))\n' "$(sbpl "$name/.git")"
        # Its mode, flags, extended attributes and ACL, each named: a blanket deny took its times as well,
        # which tar -C and rsync -a set (they reported a failure after writing every file). Moving it aside
        # needs its parent, which is not writable.
        for op in file-write-mode file-write-flags file-write-xattr file-write-acl; do
          printf '(deny %s (literal %s))\n' "$op" "$(sbpl "$name")"
        done
      done
    fi
  else
    echo '(deny file-write*)'
    printf '(allow file-write* (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/dtracehelper"))\n'
  fi
  # Reads: everything the harness already allows, minus other instances' data.
  # DEEPBOT_DENY_READ adds a deployment's own (colon-separated) — a retired bot's data, say.
  echo ";; read confinement: other agent homes, and DEEPBOT_DENY_READ"
  extra=()
  IFS=':' read -r -a extra <<< "${DEEPBOT_DENY_READ:-}"
  ws_resolved="${workspace_real:-$workspace_root}"
  deny_entries=()
  for candidate in "$HOME"/dsh-agent* ${extra[@]+"${extra[@]}"}; do
    # "dir/" is dir: with the slash it never counted as holding the workspace inside it.
    while [ "${#candidate}" -gt 1 ] && [ "${candidate%/}" != "$candidate" ]; do candidate="${candidate%/}"; done
    [ -n "$candidate" ] && [ -e "$candidate" ] || continue
    # Its resolved name, the one Seatbelt matches: an entry under a link (/var → /private/var), or a link
    # to a file, denied nothing by the name given. None when it cannot be resolved; an empty subpath
    # made sandbox-exec refuse every command.
    resolved="$(/bin/realpath "$candidate" 2>/dev/null || true)"
    # The workspace is not another home, by either of its names.
    if [ "$candidate" = "$workspace_root" ] || { [ -n "$resolved" ] && [ "$resolved" = "$ws_resolved" ]; }; then continue; fi
    printf '(deny file-read* (subpath %s))\n' "$(sbpl "$candidate")"
    deny_entries+=("$candidate")
    if [ -n "$resolved" ] && [ "$resolved" != "$candidate" ]; then
      printf '(deny file-read* (subpath %s))\n' "$(sbpl "$resolved")"
      deny_entries+=("$resolved")
    fi
  done
  # The workspace is the command's own, even inside a denied entry: a tenant's directory is under the
  # home the dsh-agent* glob denies, and its commands could write their files and not read them.
  for name in ${workspace_names[@]+"${workspace_names[@]}"}; do
    printf '(allow file-read* (subpath %s))\n' "$(sbpl "$name")"
  done
  # Reads: the harness home as a whole. What it keeps there is every conversation's — its session index
  # (with the WAL that holds the newest), the adapter's state and log, reminders, a session cache,
  # attachments, the terminal's input history — and it adds more as it grows: a list of names to deny
  # was a step behind it, and these were readable. Its runtimes stay readable (the office skill runs its
  # node from there), and so does an agent home or a workspace someone put inside it (not the harness
  # home itself). After the workspace's allow, so a workspace that contains the harness home does not
  # open it; the denies after this block hold inside whatever is allowed here.
  echo ";; read confinement: the harness home"
  for dir in "$HOME/.dsh" ${DSH_HOME:+"$DSH_HOME"}; do
    [ -d "$dir" ] || continue
    names=("$dir")
    real="$(cd "$dir" && pwd -P)"
    if [ "$real" != "$dir" ]; then names+=("$real"); fi
    for name in "${names[@]}"; do
      printf '(deny file-read* (subpath %s))\n' "$(sbpl "$name")"
      printf '(allow file-read* (subpath %s))\n' "$(sbpl "$name/dsh-runtimes")"
      # Its own entry stays visible (not its contents): node lstat-s every directory of a script's path,
      # and a harness home that is a link must still be followed to reach the runtimes.
      printf '(allow file-read-metadata (literal %s))\n' "$(sbpl "$name")"
    done
    for own in "$HOME_DIR" ${workspace_names[@]+"${workspace_names[@]}"}; do
      for name in "${names[@]}"; do
        # The home's own name, and its resolved one, inside either name of the harness home.
        own_real="$(cd "$own" 2>/dev/null && pwd -P || printf '%s' "$own")"
        case "$own/" in "$name"/?*) printf '(allow file-read* (subpath %s))\n' "$(sbpl "$own")" ;; esac
        case "$own_real/" in "$name"/?*) printf '(allow file-read* (subpath %s))\n' "$(sbpl "$own_real")" ;; esac
      done
    done
  done
  # The entries above again, after the allows, except one the workspace is inside: an entry within the
  # workspace, or within the harness home's runtimes, stays denied.
  for entry in ${deny_entries[@]+"${deny_entries[@]}"}; do
    holds_workspace=0
    for name in ${workspace_names[@]+"${workspace_names[@]}"}; do
      case "$name/" in "$entry"/*) holds_workspace=1 ;; esac
    done
    if [ "$holds_workspace" -eq 0 ]; then printf '(deny file-read* (subpath %s))\n' "$(sbpl "$entry")"; fi
  done
  # Reads: the deployment's credentials. No command needs them, and a command's output reaches
  # Slack — as a reply or a watch alert — where nothing redacts a token. Measured before this: a
  # `cat ~/.dsh/.env` inside this runner printed the bot token.
  echo ";; read confinement: credentials"
  for dir in "$HOME/.dsh" ${DSH_HOME:+"$DSH_HOME"}; do
    for candidate in "$dir"/.env "$dir"/.credentials.yaml*; do
      [ -e "$candidate" ] || continue
      printf '(deny file-read* (literal %s))\n' "$(sbpl "$candidate")"
      # Seatbelt matches the resolved path: under a symlinked directory (/var → /private/var) the
      # rule above alone denied nothing, which the runner test caught.
      # An `if`, not `[ … ] && printf`: as the loop's last command a false test made profile() fail,
      # and the runner refused every command with exit 70 — on a home without symlinks, i.e. live.
      resolved="$(cd "$(dirname "$candidate")" && pwd -P)/$(basename "$candidate")"
      if [ "$resolved" != "$candidate" ]; then
        printf '(deny file-read* (literal %s))\n' "$(sbpl "$resolved")"
      fi
    done
  done
  # The gateway's logs: their first lines carry the web UI's auth token, and that opens the
  # harness's HTTP API — outside this sandbox — to whoever reads it. install-service.sh writes them
  # here, outside the agent's home, where they used to be readable and writable by the agent.
  # The session store: every profile's conversations, this agent's and everybody else's. The agent
  # reads its own past through the recall index in its home, never through these files.
  # The recall index too: every channel's history, which the adapter hands out one channel at a time.
  # Under DSH_HOME as well, when the harness's home is elsewhere, as the credentials above are.
  # The gateway profiles: the operator's settings (model, provider, platforms, approvals), which the agent
  # is told it can neither read nor change — and where a key written inline would otherwise be one cat away.
  for denied in "$HOME/.dsh/service/logs" "$HOME/.dsh/sessions" "$HOME/.dsh/recall" "$HOME/.dsh/profiles" ${DSH_HOME:+"$DSH_HOME/sessions" "$DSH_HOME/recall" "$DSH_HOME/profiles"}; do
    [ -d "$denied" ] || continue
    printf '(deny file-read* (subpath %s))\n' "$(sbpl "$denied")"
    resolved="$(cd "$denied" && pwd -P)"
    if [ "$resolved" != "$denied" ]; then
      printf '(deny file-read* (subpath %s))\n' "$(sbpl "$resolved")"
    fi
  done
  # The user's credentials, which are not the agent's: SSH keys (the agent socket alone was refused, and the key files
  # were one cat away), the cloud CLIs' and gh's tokens, the keychains, netrc and git's stored credentials. A tool that
  # needs one fails; the agent gets a token of its own, in its home, if it needs one. The file tools are held to the
  # same list (credentialPath in index.ts).
  for denied in "$HOME/.ssh" "$HOME/.aws" "$HOME/.gnupg" "$HOME/Library/Keychains" "$HOME/.config/gh" "$HOME/.config/gcloud" "$HOME/.azure" "$HOME/.kube" "$HOME/.netrc" "$HOME/.git-credentials"; do
    [ -e "$denied" ] || [ -L "$denied" ] || continue
    printf '(deny file-read* (subpath %s))\n' "$(sbpl "$denied")"
    resolved="$(/bin/realpath "$denied" 2>/dev/null || true)"
    if [ -n "$resolved" ] && [ "$resolved" != "$denied" ]; then printf '(deny file-read* (subpath %s))\n' "$(sbpl "$resolved")"; fi
  done
  # Other workspaces' temp directories: a tenant's temp files are its own, as its directory is. Its own stays readable.
  if [ -n "$user_temp" ]; then
    for root in "$user_temp" ${user_temp_real:+"$user_temp_real"}; do
      printf '(deny file-read* (regex #"^%s/deepbot-cmd-"))\n' "$(printf '%s' "$root" | sed 's/[][\\.*^$+?(){}|"]/\\&/g')"
    done
    for own in ${cmd_temp:+"$cmd_temp"} ${cmd_temp_real:+"$cmd_temp_real"}; do
      printf '(allow file-read* (subpath %s))\n' "$(sbpl "$own")"
    done
  fi
  # Unix sockets: no agent of the user's — ssh-agent (measured: `ssh-add -l` inside this runner listed
  # the keys), 1Password's, gpg-agent's, docker's. Name resolution goes through mDNSResponder's socket,
  # without which nothing resolves a host, and a workspace may run a local server it talks to.
  echo '(deny network-outbound (remote unix-socket))'
  # Bounded, not the system's resolver either: a name looked up carries data out in its labels (found by review). The
  # proxy resolves what goes through it.
  if [ -z "$net_file" ]; then echo '(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))'; fi
  for name in ${workspace_names[@]+"${workspace_names[@]}"}; do
    printf '(allow network-outbound (remote unix-socket (subpath %s)))\n' "$(sbpl "$name")"
  done
  # The user's desktop is not the agent's: no app is scripted or started for it, which would also run outside this
  # sandbox, nor made to script one (osacompile); the screen is not taken; what the user copied (a password, often) is
  # neither read nor replaced. A copy of one of these tools is killed by macOS, but a program compiled to send Apple
  # Events or take the screen itself is not stopped.
  echo '(deny process-exec (literal "/usr/bin/osascript") (literal "/usr/bin/osacompile") (literal "/usr/bin/automator") (literal "/usr/bin/shortcuts") (literal "/usr/bin/open") (literal "/usr/sbin/screencapture"))'
  echo '(deny mach-lookup (global-name-regex #"^com\.apple\.pasteboard\."))'
  # The commands' network, bounded: the gateway's proxy only. Nor an app LaunchServices starts for them (found by
  # review), which runs outside this sandbox: LaunchServices is closed.
  if [ -n "$net_file" ]; then
    echo '(deny network-outbound (remote ip))'
    if [ -n "$net_port" ]; then printf '(allow network-outbound (remote ip "localhost:%s"))\n' "$net_port"; fi
    echo '(deny mach-lookup (global-name-regex #"^com\.apple\.coreservices\.launchservicesd") (global-name-regex #"^com\.apple\.lsd\."))'
  fi
}

sbpl() { printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"; }

# Whether a directory above $1 (an absolute path) has a .git: the harness's loader would climb to it.
root_above() {
  local at up
  case "$1" in /*) ;; *) return 1 ;; esac
  at="$(dirname "$1")"
  while :; do
    if [ -e "$at/.git" ]; then return 0; fi
    up="$(dirname "$at")"
    if [ "$up" = "$at" ]; then return 1; fi
    at="$up"
  done
}

if [ "$print_only" -eq 1 ]; then
  profile
  exit 0
fi

if [ ! -x /usr/bin/sandbox-exec ]; then
  echo "confined-runner: sandbox-exec is unavailable; refusing to run unconfined" >&2
  exit 70
fi

# The profile goes inline. It used to be a file in TMPDIR — which confined commands may write —
# read back by path, so one running command could rewrite the profile another invocation was
# about to apply. Inline there is nothing to rewrite, and no temp-name collisions to get wrong.
# The command's temp directory is made here, unconfined, as a directory of ours: not a link left at its name (no
# confined command can write the user's temp, but another process of the same user could). Without one, TMPDIR is
# left as it was and temp files there are refused, as before.
if [ -n "$cmd_temp" ]; then
  /bin/mkdir -p -m 700 "$cmd_temp" 2>/dev/null || true
  if [ -d "$cmd_temp" ] && [ ! -L "$cmd_temp" ] && [ -O "$cmd_temp" ]; then
    export TMPDIR="$cmd_temp/"
  else
    cmd_temp=""
  fi
fi
# Pointed at the proxy, in every spelling the common tools read; node reads them only when told to. Nothing is exempt
# (no NO_PROXY): a request for this machine goes through the proxy too, which decides by its mode. Without a port,
# whatever proxy was set is dropped: there is none to reach.
if [ -n "$net_file" ]; then
  unset NO_PROXY no_proxy
  if [ -n "$net_port" ]; then
    net_proxy="http://127.0.0.1:$net_port"
    export http_proxy="$net_proxy" https_proxy="$net_proxy" HTTP_PROXY="$net_proxy" HTTPS_PROXY="$net_proxy" ALL_PROXY="$net_proxy" all_proxy="$net_proxy"
    export NODE_USE_ENV_PROXY=1
  else
    unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy
  fi
fi
sb_profile="$(profile)" || exit 70
exec /usr/bin/sandbox-exec -p "$sb_profile" "${command[@]}"
