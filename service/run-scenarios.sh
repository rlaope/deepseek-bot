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
  LIST="approval approval-gate isolation interrupt recall-immediate recall-paraphrase tenant injection browser browser-js mcp mcp-ask"
fi

: > "$REPORT"
{
  echo "scenarios run $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "repo $REPO"
} >> "$REPORT"

failed=0
for name in $LIST; do
  file="test/scenarios/$name.json"
  [ -f "$file" ] || { echo "  $name: no such scenario" | tee -a "$REPORT"; failed=$((failed + 1)); continue; }
  # A local page for the browser scenario, started and stopped per run so a leftover server
  # cannot make a later run pass for the wrong reason.
  if [ "$name" = "browser" ]; then
    (cd test/fixtures && python3 -m http.server 8899 --bind 127.0.0.1 >/dev/null 2>&1 & echo $! > /tmp/deepbot-qa-server.pid)
    sleep 2
  fi
  # The script-drawn page's server answers its values only to a browser.
  if [ "$name" = "browser-js" ]; then
    ("$NODE" test/fixtures/page-server.mjs 8899 >/dev/null 2>&1 & echo $! > /tmp/deepbot-qa-server.pid)
    sleep 2
  fi
  out=$("$NODE" test/run-scenario.ts "$file" --timeout "$TIMEOUT" 2>&1)
  status=$?
  if { [ "$name" = "browser" ] || [ "$name" = "browser-js" ]; } && [ -f /tmp/deepbot-qa-server.pid ]; then
    kill "$(cat /tmp/deepbot-qa-server.pid)" 2>/dev/null
    rm -f /tmp/deepbot-qa-server.pid
  fi
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
