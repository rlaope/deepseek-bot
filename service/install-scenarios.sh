#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Install the daily scenario run (run-scenarios.sh) as a launchd job.
#
#   ./install-scenarios.sh                       (every day at 09:30)
#   HOUR=6 MINUTE=0 ./install-scenarios.sh
#   ./install-scenarios.sh --status | --uninstall
#
# For whoever maintains a deployment: install.sh does not run this, because every scenario is a turn
# of a real model, paid for.
#
# The job starts node, and node starts run-scenarios.sh in this checkout. macOS gives a launchd job the
# privacy permissions of the program it starts, and a checkout under ~/Desktop, ~/Documents or
# ~/Downloads was closed to /bin/bash started that way: every run stopped at "Operation not permitted"
# before it began. The harness's node, started the same way, could read it, and so could the shell it
# started (both checked with a launchd job on the machine this was found on).
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
REPO="$(cd .. && pwd)"

LABEL="ai.deepbot.scenarios"
UID_N="$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
# A time not given keeps the one the installed job already has.
kept() { [ -f "$PLIST" ] || return 0; /usr/libexec/PlistBuddy -c "Print :StartCalendarInterval:$1" "$PLIST" 2>/dev/null || true; }
HOUR="${HOUR:-$(kept Hour)}"; HOUR="${HOUR:-9}"
MINUTE="${MINUTE:-$(kept Minute)}"; MINUTE="${MINUTE:-30}"
NODE="${DEEPBOT_NODE:-$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node}"
RUNTIME_DIR="$HOME/.dsh/service"
STATE_DIR="$HOME/.dsh/slack-state"
# What node runs: the checkout's run-scenarios.sh, from the checkout, its exit status the job's.
# A run that cannot start (the checkout moved, or closed to node) says why in the job's error log.
LAUNCH="const r = require('child_process').spawnSync('/bin/bash', [process.env.DEEPBOT_REPO + '/service/run-scenarios.sh'], { cwd: process.env.DEEPBOT_REPO, stdio: 'inherit' }); if (r.error || r.signal) console.error('run-scenarios: ' + (r.error ? 'could not start in ' + process.env.DEEPBOT_REPO + ': ' + r.error.message : 'ended by ' + r.signal)); process.exit(r.status === null ? 1 : r.status)"

# A time the job can fire at, refused before anything is written; 09 is nine, not an octal error.
check_time() {
  if [[ "$HOUR" =~ ^[0-9]{1,2}$ && "$MINUTE" =~ ^[0-9]{1,2}$ ]] && (( 10#$HOUR < 24 && 10#$MINUTE < 60 )); then
    HOUR=$((10#$HOUR)); MINUTE=$((10#$MINUTE))
    return 0
  fi
  echo "❌ HOUR must be 0-23 and MINUTE 0-59 (got '$HOUR' and '$MINUTE'); set both to choose the time"
  return 1
}

plist_xml() {
  cat <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>-e</string><string>$LAUNCH</string></array>
  <key>WorkingDirectory</key><string>$RUNTIME_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>DEEPBOT_REPO</key><string>$REPO</string>
    <key>DEEPBOT_NODE</key><string>$NODE</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>$HOUR</integer><key>Minute</key><integer>$MINUTE</integer></dict>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>$STATE_DIR/scenarios.out.log</string>
  <key>StandardErrorPath</key><string>$STATE_DIR/scenarios.err.log</string>
</dict>
</plist>
PLIST_EOF
}

# Sourced with DEEPBOT_INSTALL_SOURCED=1 (test/install.test.ts), it defines the above and stops here.
if [ "${DEEPBOT_INSTALL_SOURCED:-0}" = 1 ]; then return 0; fi

case "${1:-}" in
--status)
  echo "── scenario job: $LABEL"
  if launchctl print "gui/$UID_N/$LABEL" >/dev/null 2>&1; then
    launchctl print "gui/$UID_N/$LABEL" | grep -E "^\s+(state|runs|last exit code) " | sed 's/^/   /'
  else
    echo "   not registered"
  fi
  echo "── last report"
  [ -f "$STATE_DIR/scenario-report.txt" ] && grep -v '^        ' "$STATE_DIR/scenario-report.txt" | sed 's/^/   /' || echo "   (none yet)"
  exit 0
  ;;
--uninstall)
  launchctl bootout "gui/$UID_N/$LABEL" 2>/dev/null && echo "   stopped" || echo "   (not running)"
  [ -f "$PLIST" ] && rm -f "$PLIST" && echo "   removed $PLIST"
  exit 0
  ;;
esac

echo "=== installing the deepbot scenario run ==="
[ -x "$NODE" ] || { echo "❌ node not found: $NODE (set DEEPBOT_NODE)"; exit 1; }
check_time || exit 1
mkdir -p "$(dirname "$PLIST")" "$RUNTIME_DIR" "$STATE_DIR"
# Checked before it takes the installed plist's place: a bad one must not replace a working job. Made beside the
# runtime copies, on the same volume, so the move is one step and nothing extra sits among the launch agents.
NEW="$RUNTIME_DIR/$LABEL.plist.new"
plist_xml > "$NEW"
plutil -lint "$NEW" >/dev/null 2>&1 || { echo "❌ plist failed plutil -lint"; plutil -lint "$NEW"; rm -f "$NEW"; exit 1; }
chmod 644 "$NEW"
mv "$NEW" "$PLIST"
echo "✅ plist: $PLIST"
if launchctl print "gui/$UID_N/$LABEL" >/dev/null 2>&1; then launchctl bootout "gui/$UID_N/$LABEL" 2>/dev/null; sleep 1; fi
launchctl bootstrap "gui/$UID_N" "$PLIST" 2>&1 | sed 's/^/   /'
# The job loaded must be this one: an old definition under the same label (a shell on the checkout) can stay loaded
# when its bootout fails, and would pass a check that only asks whether the label is there.
launchctl print "gui/$UID_N/$LABEL" 2>/dev/null | grep -qF -- "$NODE" || { echo "❌ launchd did not take the new job — run this again"; exit 1; }
cat <<EOF

════════════════════════════════════════════════════════════
 scenario run installed — every day at $(printf '%02d:%02d' "$HOUR" "$MINUTE"), from $REPO.

   run now: launchctl kickstart gui/$UID_N/$LABEL
   status:  ./install-scenarios.sh --status
   report:  $STATE_DIR/scenario-report.txt
   remove:  ./install-scenarios.sh --uninstall
════════════════════════════════════════════════════════════
EOF
