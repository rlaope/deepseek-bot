#!/bin/bash
# Run the agent-behaviour scenarios on a schedule.
#
# The unit suites run in CI, but the scenarios need a real model, so they were only ever run
# by hand — which means a behaviour regression is caught only while somebody remembers to
# look. This runs them unattended, leaves a report, and exits non-zero if any fail.
#
# Nothing here posts to Slack: a scenario drives the plugin directly and never connects a
# transport. The live bot is untouched while this runs, except that it shares the machine.
#
# Usage: run-scenarios.sh [--quick] [--timeout <seconds>]
set -uo pipefail

# The repository this script lives in, unless told otherwise.
REPO="${DEEPBOT_REPO:-$(cd "$(dirname "$0")/.." && pwd)}"
NODE="${DEEPBOT_NODE:-$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node}"
STATE_DIR="${DEEPBOT_STATE_DIR:-$HOME/.dsh/slack-state}"
REPORT="$STATE_DIR/scenario-report.txt"
TIMEOUT=420
QUICK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --quick) QUICK=1; shift ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    *) echo "run-scenarios: unknown argument $1" >&2; exit 64 ;;
  esac
done

# One run at a time. Two concurrent runs share the profile's state file and the fixture
# server's port, and the second one's failures would be blamed on the code. Found by
# triggering the job while a manual run was still going.
LOCK="$STATE_DIR/scenarios.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  owner=$(cat "$LOCK/pid" 2>/dev/null || echo '?')
  if [ "$owner" != '?' ] && kill -0 "$owner" 2>/dev/null; then
    echo "run-scenarios: another run is in progress (pid $owner) — exiting"
    exit 75
  fi
  echo "run-scenarios: clearing a stale lock from pid $owner"
  rm -rf "$LOCK"
  mkdir "$LOCK" 2>/dev/null || exit 75
fi
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT INT TERM

cd "$REPO" || exit 1
[ -x "$NODE" ] || { echo "run-scenarios: no node at $NODE" >&2; exit 1; }
# test/run-scenario.ts runs as TypeScript, which Node does without a flag from 22.18.
"$NODE" -e 'process.exit(process.features.typescript ? 0 : 1)' 2>/dev/null \
  || { echo "run-scenarios: $NODE cannot run test/run-scenario.ts — it needs Node 22.18 or newer (set DEEPBOT_NODE)" >&2; exit 1; }
[ -f dist/index.js ] || { echo "run-scenarios: dist is missing — build first" >&2; exit 1; }

if [ "$QUICK" = 1 ]; then
  LIST="interrupt approval-gate"
else
  LIST="approval approval-gate isolation interrupt recall-immediate recall-paraphrase recall-near tenant injection browser browser-js browser-session command-network mcp mcp-ask"
fi

: > "$REPORT"
{
  echo "scenarios run $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "repo $REPO"
} >> "$REPORT"

# The fixture servers' port. A server is stopped by the port it holds, not by the pid its start reported: the
# static server's start, `cd … && python3 … &` in a subshell, reported the pid of the shell that ran the list, with
# python its child, so killing that pid left python holding the port, and browser-js read its 404 instead of the
# page server's values (found in a daily report).
FIXTURE_PORT=8899
uses_fixture() { case "$1" in browser|browser-js|browser-session|command-network) return 0 ;; esac; return 1; }
fixture_holders() { /usr/sbin/lsof -t -nP -iTCP:"$FIXTURE_PORT" -sTCP:LISTEN 2>/dev/null | tr '\n' ' '; }
stop_fixture() {
  for pid in $(fixture_holders); do kill "$pid" 2>/dev/null; done
  for _ in 1 2 3 4 5; do [ -z "$(fixture_holders)" ] && return; sleep 1; done
}

failed=0
for name in $LIST; do
  file="test/scenarios/$name.json"
  [ -f "$file" ] || { echo "  $name: no such scenario" | tee -a "$REPORT"; failed=$((failed + 1)); continue; }
  # A port something else holds would answer in its place: the scenario fails, and what holds it is left alone.
  if uses_fixture "$name"; then
    holders=$(fixture_holders)
    if [ -n "$holders" ]; then
      echo "  FAIL  $name — port $FIXTURE_PORT is in use (pid ${holders% }), so its page server was not started" | tee -a "$REPORT"
      failed=$((failed + 1))
      continue
    fi
  fi
  # A local page for the browser scenario, started and stopped per run so a leftover server
  # cannot make a later run pass for the wrong reason.
  if [ "$name" = "browser" ] || [ "$name" = "command-network" ]; then
    (cd test/fixtures && python3 -m http.server "$FIXTURE_PORT" --bind 127.0.0.1 >/dev/null 2>&1 &)
    sleep 2
  fi
  # The script-drawn page's server answers its values only to a browser.
  if [ "$name" = "browser-js" ] || [ "$name" = "browser-session" ]; then
    ("$NODE" test/fixtures/page-server.mjs "$FIXTURE_PORT" >/dev/null 2>&1 &)
    sleep 2
  fi
  out=$("$NODE" test/run-scenario.ts "$file" --timeout "$TIMEOUT" 2>&1)
  status=$?
  if uses_fixture "$name"; then stop_fixture; fi
  last=$(echo "$out" | tail -1)
  if [ $status -eq 0 ]; then
    echo "  PASS  $name — $last" | tee -a "$REPORT"
  else
    echo "  FAIL  $name — $last" | tee -a "$REPORT"
    echo "$out" | tail -25 | sed 's/^/        /' >> "$REPORT"
    failed=$((failed + 1))
  fi
done

echo "  $failed scenario(s) failed" | tee -a "$REPORT"
exit $(( failed > 0 ? 1 : 0 ))
