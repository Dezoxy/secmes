#!/usr/bin/env bash
# PreToolUse(Bash) guard for argus. Emits a permission decision for dangerous commands.
# deny  = hard block (destructive / secret exposure)
# ask   = require explicit user confirmation (mutating infra/deploy/push)
set -euo pipefail
input="$(cat)"
cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null || true)"
[ -z "$cmd" ] && exit 0

decide() { # $1=decision $2=reason
  jq -nc --arg d "$1" --arg r "$2" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:$d,permissionDecisionReason:$r}}'
  exit 0
}

shopt -s nocasematch

# ---- hard denies ----
[[ "$cmd" =~ rm[[:space:]]+-[a-z]*r[a-z]*f?[[:space:]]+(/|~|\$HOME|\.\.($|/)) ]] && \
  decide deny "Recursive force-delete of a sensitive path. Run it yourself if truly intended."
[[ "$cmd" =~ terraform[[:space:]].*destroy ]] && \
  decide deny "terraform destroy is destructive — run manually after confirming workspace/target."
[[ "$cmd" =~ git[[:space:]]+push[[:space:]].*(--force([[:space:]]|=|$)|-f([[:space:]]|$)) ]] && \
  decide deny "Force-push can rewrite shared history. Run manually with --force-with-lease if you must."
[[ "$cmd" =~ (cat|less|bat|more|head|tail|echo|printf|xxd|base64|strings)[[:space:]].*(\.env($|[^.a-zA-Z])|\.tfvars($|[^.])|\.pem($|[^a-zA-Z])|id_rsa|id_ed25519|kubeconfig|\.kube/config) ]] && \
  decide deny "That would print secret material to the transcript (.env/tfvars/keys/kubeconfig)."
[[ "$cmd" =~ az[[:space:]].*(group|keyvault|postgres|vm)[[:space:]].*delete ]] && \
  decide deny "Azure resource delete is destructive — run manually after confirming subscription/resource."

# ---- confirmations ----
[[ "$cmd" =~ terraform[[:space:]].*apply ]] && \
  decide ask "terraform apply mutates cloud infra — confirm plan/workspace first."
[[ "$cmd" =~ az[[:space:]]+vm[[:space:]]+run-command ]] && \
  decide ask "az vm run-command runs a script as root on the VM (the deploy path) — confirm target VM."
[[ "$cmd" =~ docker[[:space:]].*push ]] && \
  decide ask "Pushing an image to a registry — confirm tag/registry."
# NOTE: plain `git push` is intentionally NOT gated here — force-push is denied above + in settings.json,
# which is the only push that AGENTS.md requires confirming. Normal pushes run without a prompt.

exit 0
