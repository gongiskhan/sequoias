#!/bin/bash
# Sequoias Stop hook: nudge the agent to update HISTORY.md if substantive work
# happened this turn but the doc wasn't touched. Non-blocking by default.
#
# Hook stdin contains a JSON payload from Claude Code; we don't parse it — we
# only need the filesystem signal of "did HISTORY.md change recently?".
#
# Output strategy:
#   - stderr: short reminder visible to the user (transcript shows it).
#   - stdout: JSON with `additionalContext` so the next turn sees the reminder
#     surfaced into the agent's context, in case the user keeps the session
#     going. Empty stdout if HISTORY.md was already touched recently.

set -e
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
HISTORY="$PROJECT_DIR/HISTORY.md"
STATE_DIR="$PROJECT_DIR/.claude/.state"
mkdir -p "$STATE_DIR"
LAST_TURN_MARKER="$STATE_DIR/last-stop"

# How recently does HISTORY.md need to have been modified to count as "fresh"?
FRESH_WINDOW_SECS=900   # 15 minutes

now_epoch=$(date +%s)

if [ -f "$HISTORY" ]; then
  hist_mtime=$(stat -f %m "$HISTORY")
else
  hist_mtime=0
fi

age=$(( now_epoch - hist_mtime ))

# Always update the stop-marker for audit.
echo "$now_epoch" > "$LAST_TURN_MARKER"

if [ "$age" -le "$FRESH_WINDOW_SECS" ]; then
  # Recent update — silent.
  exit 0
fi

# Stale or missing. Emit a non-blocking reminder.
echo "[sequoias] HISTORY.md not updated in $((age / 60))m — consider appending what changed this turn before stopping." 1>&2

# Inject context for the next turn (if the session continues). Claude Code
# reads JSON on stdout from Stop hooks; `additionalContext` becomes part of
# the next turn's context. Keep it short and actionable.
cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "Stop",
    "additionalContext": "HISTORY.md at $HISTORY has not been touched in ${age}s. If anything substantive happened this turn (decisions, redirects, incidents, design rationale), append to the relevant section before stopping. Follow the discipline in HISTORY.md section 5: lead with the rule/fact, then Why, then How to apply. Code-only fixes don't need an entry."
  }
}
EOF
