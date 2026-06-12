#!/usr/bin/env bash
# review-status.sh — aggregate verdict from BOTH PR reviewers: Codex (chatgpt-codex-connector)
# and the @claude GitHub reviewer. Every PR gets two equal reviews; neither outranks the other,
# and every finding from either must be resolved (see the await-reviews skill).
#
# Codex answers through five channels (all observed in this repo — PRs #140/#141/#154/#157):
#   1. 👍 reaction on the PR body                                  → reviewed, NO issues
#      (its documented no-findings signal; invisible to `gh pr view`)
#   2. Issue comment "Codex Review: Didn't find any major issues…" → clean verdict (when summoned)
#   3. PR review "💡 Codex Review" + inline P1/P2/P3 badge comments → findings
#   4. Issue comment "You have reached your Codex usage limits…"   → reviewer unavailable
#   5. Nothing — not triggered yet (auto-review skips some PRs; summon with "@codex review")
#
# Claude (.github/workflows/claude.yml) is summoned with a ping that requires a closing line
# `VERDICT: PASS` or `VERDICT: FINDINGS`; this script parses the LAST such token (a reply
# quoting the instruction line must not read as a verdict). Verdicts are only trusted from
# the exact logins claude[bot] / github-actions[bot] — the repo is public, so a "VERDICT:"
# line from any other account proves nothing. Claude edits one sticky comment in place
# (the "Claude Code is working…" placeholder is not a signal; the verdict arrives as an
# in-place edit), so its signals are ordered by updated_at, not created_at.
#
# Within one reviewer the newest signal wins (a clean re-review supersedes earlier findings).
# Across reviewers the verdicts are AGGREGATED as equals:
#   - any fresh findings           → FINDINGS (all of them must be fixed)
#   - both fresh-clean             → CLEAN
#   - Codex limited + Claude clean → CLEAN with degraded:true (record it on the PR)
# Staleness — has the reviewer seen the current head? — is NOT judged by the commit's
# committer date (that is when a commit was made, not when it was pushed; a force-push or
# late push of an older commit would read falsely fresh). Instead:
#   - formal Codex reviews carry the exact reviewed `commit_id` → stale iff it != head SHA;
#   - SHA-less signals (reaction / clean comment / Claude verdict) are compared against the
#     time GitHub first saw the head (earliest check-suite for the head SHA ≈ push time),
#     falling back to the committer date only if no check-suite exists.
# A usage-limit message is an availability fact, not a verdict, so it is never stale.
#
# Note: the Codex bot's login is `chatgpt-codex-connector[bot]` via REST but plain
# `chatgpt-codex-connector` via GraphQL. This script is REST-only and matches the exact
# [bot] login — don't hand-roll GraphQL queries against these filters.
#
# Usage: review-status.sh <pr-number> [--wait] [--timeout <minutes>]
# Exit:  0 = CLEAN (both verdicts in and clean; degraded:true if Claude-only under a Codex limit)
#        1 = FINDINGS (from either reviewer)   2 = NO_RESPONSE (a verdict still missing / timeout)
#        3 = STALE (verdicts exist, none fresh) 4 = USAGE_LIMIT (Codex limited, Claude not in yet)
#        5 = UNCLEAR (Claude replied without a parseable VERDICT line — read it)
# --wait keeps polling through NO_RESPONSE / STALE / USAGE_LIMIT (reviews in flight) and stops
# on CLEAN / FINDINGS / UNCLEAR or the timeout.

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

# One snapshot of both reviewers' signals, evaluated independently and aggregated.
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
    # Exact logins only (Codex post-merge P1 on #158): a prefix match would also trust a
    # hypothetical look-alike app. All calls here are REST, where the login is the [bot] form.
    def by_codex: map(select(.user.login == ($codex + "[bot]")));
    def by_claude_bot: map(select(.user.login == "claude[bot]" or .user.login == "github-actions[bot]"));
    # The LAST verdict token decides (Codex post-merge P2 on #158): a reply that quotes the
    # instruction line ("End with VERDICT: PASS or VERDICT: FINDINGS") must not read as PASS.
    def verdict_kind:
      ([match("VERDICT:\\s*(PASS|FINDINGS)"; "g")] | last) as $m |
      if $m == null then "claude-unclear"
      elif ($m.captures[0].string == "PASS") then "claude-pass"
      else "claude-findings" end;
    # Has this signal seen the current head? Formal reviews carry the exact reviewed SHA;
    # SHA-less signals (reaction / clean comment / Claude verdict) compare to push time.
    def fresh: select(
      if .kind == "codex-review" then .commit == $head_sha else .at >= $head_seen_at end);

    # ---- Codex, evaluated alone -------------------------------------------------------------
    ($reviews   | by_codex | map(select(.body | contains("Codex Review"))))                as $rv |
    # Substring match on purpose: the apostrophe in the Didn~t wording varies (ASCII vs
    # typographic) and regex unicode escapes are unreliable in jq — match the stable parts.
    ($comments  | by_codex | map(select(.body |
      (contains("Codex Review") and contains("find any major issues"))))) as $clean |
    ($comments  | by_codex | map(select(.body | contains("reached your Codex usage limits")))) as $limit |
    ($reactions | by_codex | map(select(.content == "+1")))                                as $thumbs |
    (   ($rv     | map({kind: "codex-review", at: .submitted_at, id: .id, url: .html_url,
                        commit: .commit_id}))
      + ($clean  | map({kind: "codex-clean-comment", at: .created_at, url: .html_url}))
      + ($thumbs | map({kind: "codex-thumbs-up-reaction", at: .created_at}))
      | sort_by(.at)
    ) as $codex_verdicts |
    ($limit | map({kind: "codex-usage-limit", at: .created_at, url: .html_url}) | sort_by(.at)) as $limits |
    ($codex_verdicts | map(fresh) | last) as $cxf |
    ( if $cxf != null then
        if $cxf.kind == "codex-review" then
          {state: "FINDINGS", via: $cxf.kind, at: $cxf.at, url: $cxf.url,
           findings: ($inline | by_codex
             | map(select(.pull_request_review_id == $cxf.id))
             | map({severity: ((.body | capture("!\\[(?<s>P[0-9]+) Badge") | .s) // "P?"),
                    path, line,
                    title: ((.body | capture("</sub></sub>\\s*(?<t>[^*\n]+)\\*\\*") | .t) // (.body | .[0:80]))}))}
        else {state: "CLEAN", via: $cxf.kind, at: $cxf.at} end
      elif ($limits | last) != null and (($codex_verdicts | last) == null
            or (($codex_verdicts | last).at < ($limits | last).at)) then
        {state: "USAGE_LIMIT", at: ($limits | last).at, url: ($limits | last).url}
      elif ($codex_verdicts | last) != null then
        {state: "STALE", verdict_from: ($codex_verdicts | last)}
      else {state: "NONE"} end
    ) as $codex_state |

    # ---- Claude, evaluated alone ------------------------------------------------------------
    (   ($comments | by_claude_bot
          # The in-progress sticky is not a signal yet — the verdict arrives as an in-place edit.
          | map(select(.body | test("^Claude Code is working") | not))
          | map({kind: (.body | verdict_kind), at: (.updated_at // .created_at), url: .html_url}))
      + ($reviews  | by_claude_bot | map(select(.body != ""))
          | map({kind: (.body | verdict_kind), at: .submitted_at, url: .html_url}))
      | sort_by(.at)
    ) as $claude_sigs |
    ($claude_sigs | map(fresh) | last) as $clf |
    ( if $clf != null then
        { state: (if $clf.kind == "claude-pass" then "CLEAN"
                  elif $clf.kind == "claude-findings" then "FINDINGS"
                  else "UNCLEAR" end),
          at: $clf.at, url: $clf.url }
      elif ($claude_sigs | last) != null then
        {state: "STALE", verdict_from: ($claude_sigs | last)}
      else {state: "NONE"} end
    ) as $claude_state |

    # ---- Aggregate as equals ----------------------------------------------------------------
    ( if $codex_state.state == "FINDINGS" or $claude_state.state == "FINDINGS" then
        {status: "FINDINGS"}
      elif $claude_state.state == "UNCLEAR" then
        {status: "UNCLEAR",
         action: "Claude replied without a VERDICT line — read the linked comment"}
      elif $codex_state.state == "CLEAN" and $claude_state.state == "CLEAN" then
        {status: "CLEAN", degraded: false}
      elif $codex_state.state == "USAGE_LIMIT" and $claude_state.state == "CLEAN" then
        {status: "CLEAN", degraded: true,
         note: "Codex over its usage limit — Claude verdict only; record this on the PR"}
      elif $codex_state.state == "USAGE_LIMIT" then
        {status: "USAGE_LIMIT",
         action: "Codex limited and no fresh Claude verdict — ensure the @claude ping is posted, then wait"}
      elif $codex_state.state == "STALE" or $claude_state.state == "STALE" then
        {status: "STALE",
         action: "a verdict predates the current head — re-request both reviews"}
      else
        {status: "NO_RESPONSE",
         action: "a required verdict is still missing — ensure both review requests are posted"}
      end
    ) + {codex: $codex_state, claude: $claude_state, head: $head_sha, head_seen_at: $head_seen_at}'
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
  # CLEAN / FINDINGS / UNCLEAR are terminal. NO_RESPONSE / STALE / USAGE_LIMIT mean a review
  # is missing or in flight — keep polling until the verdicts land or the timeout expires.
  while :; do
    status=$(jq -r .status <<<"$result")
    [[ "$status" == "NO_RESPONSE" || "$status" == "STALE" || "$status" == "USAGE_LIMIT" ]] || break
    ((SECONDS < deadline)) || {
      echo "wait: timed out after ${TIMEOUT_MIN}m (last status: $status)" >&2
      break
    }
    echo "waiting for review verdicts… (status: $status)" >&2
    sleep 30
    result=$(check)
  done
fi

echo "$result"
status_to_exit "$(jq -r .status <<<"$result")"
