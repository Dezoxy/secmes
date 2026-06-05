#!/usr/bin/env bash
# PostToolUse(Edit|Write) — remind to refresh the OpenAPI spec + 42Crunch audit when API surface changes.
set -euo pipefail
input="$(cat)"
f="$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_response.filePath // empty' 2>/dev/null || true)"
case "$f" in
  *apps/api/*.controller.ts|*apps/api/*controller*.ts)
    jq -nc '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:"API surface changed: refresh the OpenAPI spec and re-run the 42Crunch audit via the /api-spec skill, and confirm the endpoint declares auth + typed schemas."}}'
  ;;
  *) exit 0 ;;
esac
