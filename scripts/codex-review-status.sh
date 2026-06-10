#!/usr/bin/env bash
# codex-review-status.sh — never miss a review signal from Codex (chatgpt-codex-connector)
# or the @claude fallback reviewer on a PR.
#
# Codex answers through five channels (all observed in this repo — PRs #140/#141/#154/#157):
#   1. 👍 reaction on the PR body                                  → reviewed, NO issues
#      (its documented no-findings signal; invisible to `gh pr view`)
#   2. Issue comment "Codex Review: Didn't find any major issues…" → clean verdict (when summoned)
#   3. PR review "💡 Codex Review" + inline P1/P2/P3 badge comments → findings
#   4. Issue comment "You have reached your Codex usage limits…"   → reviewer unavailable
#   5. Nothing — not triggered yet (auto-review skips some PRs; summon with "@codex review")
#
# When Codex is over its usage limit, the fallback is the @claude reviewer (.github/workflows/
# claude.yml). The ping (see the await-codex skill) instructs it to end with a single line
# `VERDICT: PASS` or `VERDICT: FINDINGS`; this script parses that. Verdicts are only trusted
# from bot logins (claude*[bot] / github-actions[bot]) — the repo is public, so a "VERDICT:"
# line from a human account proves nothing.
#
# The newest signal wins (a clean re-review supersedes earlier findings). A verdict older
# than the PR's head commit is STALE — the reviewer hasn't seen the latest push. A usage-limit
# message is an availability fact, not a verdict, so it is never reported as stale.
#
# Note: the Codex bot's login is `chatgpt-codex-connector[bot]` via REST but
# `chatgpt-codex-connector` via GraphQL — the prefix match below covers both, but don't
# hand-roll GraphQL queries for this.
#
# Usage: codex-review-status.sh <pr-number> [--wait] [--timeout <minutes>]
# Exit:  0 = CLEAN          1 = FINDINGS   2 = NO_RESPONSE (or wait timed out)
#        3 = STALE          4 = USAGE_LIMIT (ping @claude per the await-codex skill)
#        5 = UNCLEAR (Claude replied without a parseable VERDICT line — read it)

set -euo pipefail

PR="${1:-}"
[[ "$PR" =~ ^[0-9]+$ ]] || {
  echo "usage: $0 <pr-number> [--wait] [--timeout <minutes>]" >&2
  exit 64
}
shift

WAIT=0
TIMEOUT_MIN=15
while [[ $# -gt 0 ]]; do
  case "$1" in
    --wait) WAIT=1 ;;
    --timeout)
      TIMEOUT_MIN="$2"
      shift
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 64
      ;;
  esac
  shift
done

REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
CODEX='chatgpt-codex-connector'

# One snapshot of every reviewer signal, classified. per_page=100 covers any realistic PR here;
# ISO-8601 UTC timestamps compare correctly as strings.
check() {
  local head_sha head_at reviews inline comments reactions
  head_sha=$(gh api "repos/$REPO/pulls/$PR" --jq '.head.sha')
  head_at=$(gh api "repos/$REPO/commits/$head_sha" --jq '.commit.committer.date')
  reviews=$(gh api "repos/$REPO/pulls/$PR/reviews?per_page=100")
  inline=$(gh api "repos/$REPO/pulls/$PR/comments?per_page=100")
  comments=$(gh api "repos/$REPO/issues/$PR/comments?per_page=100")
  reactions=$(gh api "repos/$REPO/issues/$PR/reactions?per_page=100")

  jq -n \
    --arg codex "$CODEX" --arg head_sha "$head_sha" --arg head_at "$head_at" \
    --argjson reviews "$reviews" --argjson inline "$inline" \
    --argjson comments "$comments" --argjson reactions "$reactions" '
    def by_codex: map(select(.user.login | startswith($codex)));
    # Trusted fallback-reviewer logins only: GitHub Apps carry an unfakeable [bot] suffix.
    def by_claude_bot: map(select(.user.login as $l |
      ($l == "github-actions[bot]") or (($l | startswith("claude")) and ($l | endswith("[bot]")))));
    def verdict_kind: if test("VERDICT:\\s*PASS") then "claude-pass"
      elif test("VERDICT:\\s*FINDINGS") then "claude-findings"
      else "claude-unclear" end;

    ($reviews   | by_codex | map(select(.body | contains("Codex Review"))))                as $rv |
    ($comments  | by_codex | map(select(.body | test("Didn.t find any major issues"))))    as $clean |
    ($comments  | by_codex | map(select(.body | contains("reached your Codex usage limits")))) as $limit |
    ($reactions | by_codex | map(select(.content == "+1")))                                as $thumbs |
    (   ($comments | by_claude_bot | map({kind: (.body | verdict_kind), at: .created_at, url: .html_url}))
      + ($reviews  | by_claude_bot | map(select(.body != "")
          | {kind: (.body | verdict_kind), at: .submitted_at, url: .html_url}))
    ) as $claude |
    (   ($rv     | map({kind: "codex-review", at: .submitted_at, id: .id, url: .html_url}))
      + ($clean  | map({kind: "codex-clean-comment", at: .created_at, url: .html_url}))
      + ($limit  | map({kind: "codex-usage-limit", at: .created_at, url: .html_url}))
      + ($thumbs | map({kind: "codex-thumbs-up-reaction", at: .created_at}))
      + $claude
      | sort_by(.at) | last
    ) as $latest |
    if $latest == null then
      {status: "NO_RESPONSE", head: $head_sha}
    elif $latest.kind == "codex-usage-limit" then
      {status: "USAGE_LIMIT", at: $latest.at, url: $latest.url, head: $head_sha,
       action: "Codex is over its usage limit — ping the @claude fallback reviewer (await-codex skill)"}
    elif $latest.at < $head_at then
      {status: "STALE", verdict_from: $latest, head: $head_sha, head_committed_at: $head_at}
    elif $latest.kind == "codex-review" then
      {status: "FINDINGS", via: $latest.kind, at: $latest.at, url: $latest.url, head: $head_sha,
       findings: ($inline | by_codex
         | map(select(.pull_request_review_id == $latest.id))
         | map({severity: ((.body | capture("!\\[(?<s>P[0-9]+) Badge") | .s) // "P?"),
                path, line,
                title: ((.body | capture("</sub></sub>\\s*(?<t>[^*\n]+)\\*\\*") | .t) // (.body | .[0:80]))}))}
    elif $latest.kind == "claude-findings" then
      {status: "FINDINGS", via: $latest.kind, at: $latest.at, url: $latest.url, head: $head_sha,
       findings: [], note: "findings are in the linked Claude review comment"}
    elif $latest.kind == "claude-unclear" then
      {status: "UNCLEAR", via: $latest.kind, at: $latest.at, url: $latest.url, head: $head_sha,
       action: "Claude replied without a VERDICT line — read the linked comment"}
    else
      {status: "CLEAN", via: $latest.kind, at: $latest.at, head: $head_sha}
    end'
}

status_to_exit() {
  case "$1" in
    CLEAN) return 0 ;;
    FINDINGS) return 1 ;;
    STALE) return 3 ;;
    USAGE_LIMIT) return 4 ;;
    UNCLEAR) return 5 ;;
    *) return 2 ;;
  esac
}

result=$(check)
if [[ "$WAIT" == 1 ]]; then
  deadline=$((SECONDS + TIMEOUT_MIN * 60))
  # CLEAN / FINDINGS / USAGE_LIMIT / UNCLEAR are terminal; NO_RESPONSE / STALE mean a reviewer
  # is (re-)thinking — keep polling.
  while :; do
    status=$(jq -r .status <<<"$result")
    [[ "$status" == "NO_RESPONSE" || "$status" == "STALE" ]] || break
    ((SECONDS < deadline)) || {
      echo "wait: timed out after ${TIMEOUT_MIN}m (last status: $status)" >&2
      break
    }
    echo "waiting for a review verdict… (status: $status)" >&2
    sleep 30
    result=$(check)
  done
fi

echo "$result"
status_to_exit "$(jq -r .status <<<"$result")"
