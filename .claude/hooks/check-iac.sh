#!/usr/bin/env bash
# PostToolUse(Edit|Write) — auto-check Terraform formatting / Helm chart validity.
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
  *charts/*)
    if command -v helm >/dev/null 2>&1; then
      d="$(dirname "$f")"
      while [ "$d" != "/" ] && [ ! -f "$d/Chart.yaml" ]; do d="$(dirname "$d")"; done
      if [ -f "$d/Chart.yaml" ]; then
        helm lint "$d" >/dev/null 2>&1 || out="helm lint failed for chart $d — run 'helm lint $d'."
      fi
    fi
  ;;
  *) exit 0 ;;
esac

[ -z "$out" ] && exit 0
jq -nc --arg c "$out" '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$c}}'
exit 0
