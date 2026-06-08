#!/usr/bin/env bash
set -euo pipefail

POLL_SECONDS=20
TIMEOUT_SECONDS=1800

usage() {
  cat <<'USAGE'
Usage: scripts/frontend-pr-gate.sh [--merge]

Runs the frontend verification and PR review gate for the current branch:
  1. pnpm frontend:verify
  2. gh pr checks <number> --watch
  3. comments @codex review
  4. waits for Codex to respond on the current head
  5. prints actionable Codex review thread ids/URLs and exits nonzero if any remain

--merge  Squash-merge only after CI is green and the latest Codex result has no actionable threads.
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

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

owner="$(gh repo view --json owner --jq '.owner.login')"
repo="$(gh repo view --json name --jq '.name')"
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

triggered_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo
echo "Requesting Codex review..."
gh pr comment "$pr_number" --body "@codex review"

# shellcheck disable=SC2016
codex_query='
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      headRefOid
      reviews(last: 20) {
        nodes {
          author { login }
          body
          submittedAt
          commit { oid }
        }
      }
      comments(last: 20) {
        nodes {
          author { login }
          body
          createdAt
          url
        }
      }
    }
  }
}
'

codex_seen() {
  local payload_file
  payload_file="$(mktemp)"
  gh api graphql \
    -f query="$codex_query" \
    -f owner="$owner" \
    -f repo="$repo" \
    -F number="$pr_number" >"$payload_file"

  python3 - "$head_oid" "$triggered_at" "$payload_file" <<'PY'
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone

CODEX_LOGIN = "chatgpt-codex-connector"

head_oid = sys.argv[1]
triggered_at = sys.argv[2]
payload_file = sys.argv[3]

def parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)

triggered = parse_time(triggered_at)
with open(payload_file, "r", encoding="utf-8") as fh:
    data = json.load(fh)

pr = data["data"]["repository"]["pullRequest"]

for review in pr["reviews"]["nodes"]:
    author = review.get("author", {}).get("login")
    commit = review.get("commit") or {}
    body = review.get("body") or ""
    if author != CODEX_LOGIN:
        continue
    if commit.get("oid") == head_oid or head_oid[:12] in body:
        print(f"Codex review detected at {review['submittedAt']}.")
        sys.exit(0)

for comment in pr["comments"]["nodes"]:
    author = comment.get("author", {}).get("login")
    body = comment.get("body") or ""
    if author != CODEX_LOGIN:
        continue
    if parse_time(comment["createdAt"]) < triggered:
        continue
    if body.startswith("Codex Review:") or "Didn't find any major issues" in body:
        print(f"Codex clean-result comment detected at {comment['createdAt']}: {comment['url']}")
        sys.exit(0)

sys.exit(1)
PY
  local status=$?
  rm -f "$payload_file"
  return "$status"
}

echo "Waiting for Codex to respond..."
deadline=$((SECONDS + TIMEOUT_SECONDS))
until codex_seen; do
  assert_head_unchanged
  if ((SECONDS >= deadline)); then
    echo "Timed out waiting for Codex review after ${TIMEOUT_SECONDS}s." >&2
    exit 1
  fi
  sleep "$POLL_SECONDS"
done
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
