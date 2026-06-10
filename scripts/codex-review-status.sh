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
# line from a human account proves nothing. Claude edits one sticky comment in place
# (progress → final verdict), so its signals are ordered by updated_at, not created_at.
#
# Within one reviewer the newest signal wins (a clean re-review supersedes earlier findings),
# but between reviewers there is a hierarchy: a fresh Codex verdict (primary) outranks the
# @claude fallback — a fallback PASS never overrides fresh Codex findings on the same head.
# Staleness — has the reviewer seen the current head? — is NOT judged by the commit's
# committer date (that is when
# a commit was made, not when it was pushed; a force-push or late push of an older commit would
# read falsely fresh). Instead:
#   - formal Codex reviews carry the exact reviewed `commit_id` → stale iff it != head SHA;
#   - SHA-less signals (reaction / clean comment / Claude verdict) are compared against the
#     time GitHub first saw the head (earliest check-suite for the head SHA ≈ push time),
#     falling back to the committer date only if no check-suite exists.
# A usage-limit message is an availability fact, not a verdict, so it is never stale.
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

# Paginated GET that always yields ONE flat JSON array (gh --slurp emits an array of pages;
# gh refuses --slurp together with --jq, so the flatten happens in a separate jq).
fetch_all() {
  gh api --paginate --slurp "$1" | jq 'add // []'
}

# One snapshot of every reviewer signal, classified.
check() {
  local head_sha head_seen_at reviews inline comments reactions
  head_sha=$(gh api "repos/$REPO/pulls/$PR" --jq '.head.sha')
  # When did GitHub first see this head? Earliest check-suite ≈ push time; committer-date fallback.
  head_seen_at=$(gh api "repos/$REPO/commits/$head_sha/check-suites" \
    --jq '[.check_suites[].created_at] | min // empty' 2>/dev/null || true)
  [[ -n "$head_seen_at" ]] || head_seen_at=$(gh api "repos/$REPO/commits/$head_sha" --jq '.commit.committer.date')
  reviews=$(fetch_all "repos/$REPO/pulls/$PR/reviews?per_page=100")
  inline=$(fetch_all "repos/$REPO/pulls/$PR/comments?per_page=100")
  comments=$(fetch_all "repos/$REPO/issues/$PR/comments?per_page=100")
  reactions=$(fetch_all "repos/$REPO/issues/$PR/reactions?per_page=100")

  jq -n \
    --arg codex "$CODEX" --arg head_sha "$head_sha" --arg head_seen_at "$head_seen_at" \
    --argjson reviews "$reviews" --argjson inline "$inline" \
    --argjson comments "$comments" --argjson reactions "$reactions" '
    def by_codex: map(select(.user.login | startswith($codex)));
    # Trusted fallback-reviewer logins only: GitHub Apps carry an unfakeable [bot] suffix.
    def by_claude_bot: map(select(.user.login as $l |
      ($l == "github-actions[bot]") or (($l | startswith("claude")) and ($l | endswith("[bot]")))));
    def verdict_kind: if test("VERDICT:\\s*PASS") then "claude-pass"
      elif test("VERDICT:\\s*FINDINGS") then "claude-findings"
      else "claude-unclear" end;
    # Has this signal seen the current head? Formal reviews carry the exact reviewed SHA;
    # SHA-less signals (reaction / clean comment / Claude verdict) compare to push time.
    def fresh: select(
      if .kind == "codex-review" then .commit == $head_sha else .at >= $head_seen_at end);

    ($reviews   | by_codex | map(select(.body | contains("Codex Review"))))                as $rv |
    ($comments  | by_codex | map(select(.body | test("Didn[\\u0027\\u2019]t find any major issues")))) as $clean |
    ($comments  | by_codex | map(select(.body | contains("reached your Codex usage limits")))) as $limit |
    ($reactions | by_codex | map(select(.content == "+1")))                                as $thumbs |
    (   ($rv     | map({kind: "codex-review", at: .submitted_at, id: .id, url: .html_url,
                        commit: .commit_id}))
      + ($clean  | map({kind: "codex-clean-comment", at: .created_at, url: .html_url}))
      + ($thumbs | map({kind: "codex-thumbs-up-reaction", at: .created_at}))
      | sort_by(.at)
    ) as $codex_verdicts |
    ($limit | map({kind: "codex-usage-limit", at: .created_at, url: .html_url}) | sort_by(.at)) as $limits |
    (   ($comments | by_claude_bot
          | map({kind: (.body | verdict_kind), at: (.updated_at // .created_at), url: .html_url}))
      + ($reviews  | by_claude_bot | map(select(.body != ""))
          | map({kind: (.body | verdict_kind), at: .submitted_at, url: .html_url}))
      | sort_by(.at)
    ) as $claude |
    # Reviewer hierarchy: a fresh verdict from Codex (primary) outranks everything; the @claude
    # fallback only decides when Codex has no fresh verdict; then availability, staleness, silence.
    ($codex_verdicts | map(fresh) | last) as $cx |
    ($claude        | map(fresh) | last) as $cl |
    ($codex_verdicts + $limits + $claude | sort_by(.at) | last) as $latest_any |
    if $cx != null then
      if $cx.kind == "codex-review" then
        {status: "FINDINGS", via: $cx.kind, at: $cx.at, url: $cx.url, head: $head_sha,
         findings: ($inline | by_codex
           | map(select(.pull_request_review_id == $cx.id))
           | map({severity: ((.body | capture("!\\[(?<s>P[0-9]+) Badge") | .s) // "P?"),
                  path, line,
                  title: ((.body | capture("</sub></sub>\\s*(?<t>[^*\n]+)\\*\\*") | .t) // (.body | .[0:80]))}))}
      else
        {status: "CLEAN", via: $cx.kind, at: $cx.at, head: $head_sha}
      end
    elif $cl != null then
      if $cl.kind == "claude-pass" then
        {status: "CLEAN", via: $cl.kind, at: $cl.at, head: $head_sha}
      elif $cl.kind == "claude-findings" then
        {status: "FINDINGS", via: $cl.kind, at: $cl.at, url: $cl.url, head: $head_sha,
         findings: [], note: "findings are in the linked Claude review comment"}
      else
        {status: "UNCLEAR", via: $cl.kind, at: $cl.at, url: $cl.url, head: $head_sha,
         action: "Claude replied without a VERDICT line — read the linked comment"}
      end
    elif ($limits | last) != null and (($codex_verdicts | last) == null
          or (($codex_verdicts | last).at < ($limits | last).at)) then
      {status: "USAGE_LIMIT", at: ($limits | last).at, url: ($limits | last).url, head: $head_sha,
       action: "Codex is over its usage limit — ping the @claude fallback reviewer (await-codex skill)"}
    elif $latest_any != null then
      {status: "STALE", verdict_from: $latest_any, head: $head_sha, head_seen_at: $head_seen_at}
    else
      {status: "NO_RESPONSE", head: $head_sha}
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
