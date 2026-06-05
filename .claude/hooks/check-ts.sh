#!/usr/bin/env bash
# PostToolUse(Edit|Write) — static check on TypeScript for argus security invariants.
# Advisory: injects findings back to the model; does not block.
set -euo pipefail
input="$(cat)"
f="$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_response.filePath // empty' 2>/dev/null || true)"
case "$f" in *.ts) ;; *) exit 0 ;; esac
case "$f" in *.spec.ts|*.test.ts) exit 0 ;; esac
[ -f "$f" ] || exit 0

findings=""
if grep -nEi '(console\.(log|info|warn|error|debug)|logger\.(log|info|warn|error|debug|verbose))[[:space:]]*\(.*(plaintext|ciphertext|private[_ ]?key|passphrase|password|secret|bearer|authorization|token)' "$f" >/dev/null 2>&1; then
  findings="${findings}- Possible logging of sensitive data (plaintext/keys/tokens). Logs carry IDs/metadata only.\n"
fi
if grep -nE 'Math\.random[[:space:]]*\(' "$f" >/dev/null 2>&1; then
  findings="${findings}- Math.random() is not a CSPRNG — never use it for anything security-relevant.\n"
fi
case "$f" in
  *packages/crypto/*) ;;
  *)
    if grep -nEi '(crypto\.subtle|createcipher|createhmac|createhash|\bnacl\b|libsodium|tweetnacl|pbkdf2|scrypt)' "$f" >/dev/null 2>&1; then
      findings="${findings}- Crypto primitive used outside packages/crypto. All crypto must go through the MLS wrapper.\n"
    fi
  ;;
esac

[ -z "$findings" ] && exit 0
msg="argus invariant check on ${f}:\n${findings}Route this through the crypto-reviewer / security-boundary-auditor before committing."
jq -nc --arg c "$(printf '%b' "$msg")" \
  '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$c}}'
exit 0
