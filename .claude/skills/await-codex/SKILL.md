---
name: await-codex
description: Check or wait for the Codex (chatgpt-codex-connector) review verdict on a PR without missing any signal channel — formal reviews, comments, 👍 reactions, or usage-limit failures — and fall back to the @claude GitHub reviewer when Codex is out of usage. Use after opening a PR, before any merge, when babysitting a PR, or when asked whether Codex has responded.
---

# await-codex

Codex delivers its answer through five channels. Never conclude "no review yet" from `gh pr view` alone — it shows reviews and comments but **not reactions**, and a 👍 reaction on the PR body is Codex's documented no-findings verdict.

1. 👍 reaction on the PR body → reviewed, **no issues**
2. Issue comment "Codex Review: Didn't find any major issues…" → clean (posted when summoned via `@codex review`)
3. PR review "💡 Codex Review" + inline comments with P1/P2/P3 badges → findings
4. Issue comment "You have reached your Codex usage limits…" → **reviewer unavailable** — fall back to @claude (below)
5. Nothing → not triggered yet (auto-review skips some PRs)

The newest signal wins: a clean re-review supersedes earlier findings. A verdict older than the head commit covers stale code.

## Procedure

1. Run `scripts/codex-review-status.sh <pr> --wait --timeout 15` (omit `--wait` for a one-shot check). Exit codes: **0** CLEAN · **1** FINDINGS · **2** NO_RESPONSE · **3** STALE · **4** USAGE_LIMIT · **5** UNCLEAR.
2. **CLEAN** → proceed (merge still requires green CI per AGENTS.md).
3. **FINDINGS** → treat P1/P2 like CI failures: fix, push, request a re-review (`@codex please re-review — head is now <sha>`, or re-ping @claude if it was the fallback verdict), then run the script again with `--wait`.
4. **STALE** (verdict predates the current head commit) → request a re-review as in step 3 and wait again. Do not merge on a stale verdict — that gap has shipped unreviewed code before (PR #156).
5. **USAGE_LIMIT** → Codex is out of usage; ping the fallback reviewer (next section), then re-run the script with `--wait` — it understands Claude's verdicts too.
6. **UNCLEAR** → Claude replied without a `VERDICT:` line; read the linked comment and respond to it.
7. **NO_RESPONSE** after the timeout → post a single `@codex review` comment and wait once more. If still nothing, use the @claude fallback. If both reviewers fail, stop and tell the human; never merge silently without a review or a justification recorded on the PR.

## The @claude fallback

`.github/workflows/claude.yml` triggers when the **repo owner** comments `@claude` (comments posted via `gh` count). Post this — the `VERDICT:` contract is what makes the detector able to parse the answer:

```
@claude review this PR as the fallback reviewer — Codex is over its usage limit.
Apply the AGENTS.md review criteria (crypto / server boundary / infra) to the full diff at head <sha>.
Treat P1/P2 findings like CI failures and list them with file:line.
End your review with exactly one line: `VERDICT: PASS` or `VERDICT: FINDINGS`.
```

Then run `scripts/codex-review-status.sh <pr> --wait`. Verdicts are only trusted from bot logins (`claude*[bot]`, `github-actions[bot]`) — the repo is public, so a `VERDICT:` line from a human account proves nothing and is ignored by design.

## Pitfalls the script already handles — don't hand-roll queries

- Bot login is `chatgpt-codex-connector[bot]` via REST but `chatgpt-codex-connector` via GraphQL; a filter built for one misses the other.
- Reactions live at `issues/<pr>/reactions`, not in any review/comment endpoint.
- Inline findings are tied to their review via `pull_request_review_id`; counting all inline comments double-counts superseded rounds.
- A usage-limit message is an availability fact, not a verdict — it is reported as USAGE_LIMIT even when it predates the head commit, never as STALE.
