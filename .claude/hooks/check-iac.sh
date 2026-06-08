#!/usr/bin/env bash
# PostToolUse(Edit|Write) — auto-check Terraform formatting.
set -euo pipefail
input="$(cat)"
f="$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_response.filePath // empty' 2>/dev/null || true)"
[ -n "$f" ] || exit 0
out=""

case "$f" in
  *.tf|*.tfvars)
    if command -v terraform >/dev/null 2>&1; then
      d="$(dirname "$f")"
      terraform -chdir="$d" fmt -check >/dev/null 2>&1 || \
        out="terraform fmt would reformat $d — run 'terraform -chdir=$d fmt'."
    fi
  ;;
  *) exit 0 ;;
esac

[ -z "$out" ] && exit 0
jq -nc --arg c "$out" '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$c}}'
exit 0
