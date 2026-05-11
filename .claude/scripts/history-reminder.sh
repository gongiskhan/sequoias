#!/bin/bash
# Sequoias Stop hook: nudge the agent to update HISTORY.md if substantive work
# happened this turn but the doc wasn't touched. Non-blocking by default.
#
# Hook stdin contains a JSON payload from Claude Code; we don't parse it — we
# only need the filesystem signal of "did HISTORY.md change recently?".
#
# Output strategy:
#   - stderr: short reminder visible to the user (transcript shows it).
#   - stdout: JSON with `systemMessage` so the reminder surfaces in the UI.
#     Stop hooks may NOT use `hookSpecificOutput.additionalContext` — that
#     field is reserved for PreToolUse / UserPromptSubmit / PostToolUse /
#     PostToolBatch. Top-level `systemMessage` is the valid Stop-hook field
#     for a non-blocking notice. Empty stdout if HISTORY.md was already
#     touched recently.

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

# Surface the same reminder to the UI via the schema-valid Stop-hook field.
# JSON-escape the message body to keep the output safe even if HISTORY paths
# contain quotes / backslashes.
msg="HISTORY.md at $HISTORY has not been touched in ${age}s. If anything substantive happened this turn (decisions, redirects, incidents, design rationale), append to the relevant section before stopping. Follow the discipline in HISTORY.md section 5: lead with the rule/fact, then Why, then How to apply. Code-only fixes don't need an entry."
escaped=$(printf '%s' "$msg" | python3 -c 'import json, sys; print(json.dumps(sys.stdin.read()))')
printf '{"systemMessage": %s}\n' "$escaped"
