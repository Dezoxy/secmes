#!/usr/bin/env bash
set -euo pipefail

TIMEOUT_SECONDS=1800

usage() {
  cat <<'USAGE'
Usage: scripts/frontend-pr-gate.sh [--merge]

Runs the frontend verification and PR review gate for the current branch:
  1. pnpm frontend:verify
  2. gh pr checks <number> --watch
  3. requests BOTH reviews (Codex + the Claude reviewer)
  4. waits for both verdicts via .claude/hooks/review-status.sh
  5. prints actionable Codex review thread ids/URLs and exits nonzero if any remain

--merge  Squash-merge only after CI is green and both review verdicts are clean.
USAGE
}

merge_after_clean=false
while (($#)); do
  case "$1" in
    --merge)
      merge_after_clean=true
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 127
  fi
}

require_command gh
require_command pnpm
require_command python3
require_command jq

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

pr_number="$(gh pr view --json number --jq '.number')"
pr_url="$(gh pr view --json url --jq '.url')"
head_oid="$(gh pr view --json headRefOid --jq '.headRefOid')"
head_short="${head_oid:0:12}"

echo "Frontend PR gate for PR #${pr_number}: ${pr_url}"
echo "Head commit: ${head_short}"

current_head_oid() {
  gh pr view "$pr_number" --json headRefOid --jq '.headRefOid'
}

assert_head_unchanged() {
  local current_head
  current_head="$(current_head_oid)"
  if [[ "$current_head" != "$head_oid" ]]; then
    echo "PR head changed from ${head_oid:0:12} to ${current_head:0:12}; rerun the gate for the new head." >&2
    exit 1
  fi
}

echo
echo "Running frontend verification..."
pnpm frontend:verify

echo
echo "Waiting for CI checks..."
gh pr checks "$pr_number" --watch
assert_head_unchanged

not_green_count() {
  gh pr checks "$pr_number" --json bucket,name --jq \
    '[.[] | select(.bucket != "pass" and .bucket != "skipping")] | length'
}

if [[ "$(not_green_count)" != "0" ]]; then
  echo "CI is not fully green; refusing to continue." >&2
  gh pr checks "$pr_number"
  exit 1
fi

echo
echo "Requesting both reviews (Codex + Claude)..."
gh pr comment "$pr_number" --body "@codex review"
gh pr comment "$pr_number" --body "@claude review this PR.
Apply the AGENTS.md review criteria (crypto / server boundary / infra) to the full diff at head ${head_short}.
Treat P1/P2 findings like CI failures and list them with file:line.
In your reply, never write the two bot mention strings verbatim (say \"codex-bot\" / \"claude-bot\" instead).
End your review with exactly one line: \`VERDICT: PASS\` or \`VERDICT: FINDINGS\`."

# Both reviewers gate the merge as equals — .claude/hooks/review-status.sh aggregates every
# signal channel for both and exits 0 only when both verdicts are in and clean (or Claude-only
# under a Codex usage limit, flagged degraded:true). Don't hand-roll review detection here.
echo "Waiting for both review verdicts..."
if ! review_status="$(.claude/hooks/review-status.sh "$pr_number" --wait --timeout $((TIMEOUT_SECONDS / 60)))"; then
  printf '%s\n' "$review_status"
  echo "Review gate is not clean; refusing to continue." >&2
  exit 1
fi
printf '%s\n' "$review_status"
# AGENTS.md: a Claude-only pass under a Codex usage limit must be recorded on the PR.
if [[ "$(jq -r '.degraded // false' <<<"$review_status")" == "true" ]]; then
  echo "Recording the degraded (Claude-only) review gate on the PR..."
  gh pr comment "$pr_number" --body "Review gate note: Codex was over its usage limit for this head, so the gate passed on the Claude reviewer's PASS alone (degraded mode per AGENTS.md — recorded here)."
fi
assert_head_unchanged

echo
echo "Checking unresolved actionable Codex review threads..."
if ! python3 scripts/fetch-pr-review-threads.py "$pr_number" --codex-only --actionable-only --exit-code; then
  echo
  echo "Actionable Codex findings remain. Reply/fix using the thread ids and URLs above." >&2
  exit 1
fi

echo
echo "Frontend PR gate passed for PR #${pr_number}."

if "$merge_after_clean"; then
  assert_head_unchanged
  if [[ "$(not_green_count)" != "0" ]]; then
    echo "--merge requested, but CI is no longer fully green." >&2
    exit 1
  fi
  echo "Merging PR #${pr_number}..."
  gh pr merge "$pr_number" --squash
fi
