---
name: await-reviews
description: Request and wait for BOTH PR reviews — Codex (chatgpt-codex-connector) and the @claude GitHub reviewer — without missing any signal channel (formal reviews, comments, 👍 reactions, usage-limit failures). Use right after opening a PR, before any merge, when babysitting a PR, or when asked whether the reviews are in.
---

# await-reviews

Every PR gets **two equal reviews**: Codex and Claude. Neither outranks the other — every finding from either reviewer must be resolved before merge. The detector is `.claude/hooks/review-status.sh`; never conclude "no review yet" from `gh pr view` alone — it shows reviews and comments but **not reactions**, and a 👍 reaction on the PR body is Codex's documented no-findings verdict.

Codex signals: 👍 reaction on the PR body (clean) · "Codex Review: Didn't find any major issues…" comment (clean) · "💡 Codex Review" with inline P1/P2/P3 badges (findings) · "You have reached your Codex usage limits…" (unavailable) · silence.
Claude signals: one sticky comment ending in `VERDICT: PASS` or `VERDICT: FINDINGS` (the contract our ping demands) · a reply without that line (unclear — read it) · silence.

Within one reviewer the newest signal wins (a clean re-review supersedes earlier findings). A verdict that predates the current head covers stale code; formal Codex reviews are matched by their exact reviewed SHA.

## Procedure

1. **Right after `gh pr create`, post BOTH requests** (two separate comments):
   - `@codex review`
   - The Claude ping — the `VERDICT:` contract is what makes the detector able to parse the answer:

     ```
     @claude review this PR.
     Apply the AGENTS.md review criteria (crypto / server boundary / infra) to the full diff at head <sha>.
     Treat P1/P2 findings like CI failures and list them with file:line.
     In your reply, never write the two bot mention strings verbatim (say "codex-bot" / "claude-bot" instead) — the literal strings summon the bots and can cause review cross-fire.
     End your review with exactly one line: `VERDICT: PASS` or `VERDICT: FINDINGS`.
     ```

2. Run `.claude/hooks/review-status.sh <pr> --wait --timeout 15` (omit `--wait` for a one-shot check). Exit codes: **0** CLEAN · **1** FINDINGS · **2** NO_RESPONSE · **3** STALE · **4** USAGE_LIMIT · **5** UNCLEAR. The JSON reports each reviewer separately (`.codex`, `.claude`) plus the aggregate `.status`; `--wait` keeps polling through missing/stale/limited states and stops only on CLEAN, FINDINGS, or UNCLEAR.
3. **CLEAN** → proceed (merge still requires green CI per AGENTS.md). If `degraded: true` (Codex was over its usage limit, so the verdict is Claude-only), record that in a PR comment before merging.
4. **FINDINGS** → fix everything from **both** reviewers (`.codex.findings` plus the linked Claude comment), push, then re-request **both**: `@codex please re-review — head is now <sha>` and a fresh Claude ping with the new head. Run the script again with `--wait`. Do not merge on a stale verdict — that gap has shipped unreviewed code before (PR #156).
5. **UNCLEAR** → Claude replied without a `VERDICT:` line; read the linked comment and respond to it.
6. **USAGE_LIMIT** persisting or **NO_RESPONSE** after the timeout → confirm both request comments were actually posted (post the missing one), wait once more; if a reviewer still doesn't answer, stop and tell the human — never merge with an unaddressed reviewer unless it's the recorded Codex-limit degradation.

## Pitfalls — learned the hard way

- **Any comment containing the string `@claude` triggers `claude.yml`** — even "addressed @claude's P3". When referring to the reviewer without summoning it, write "the Claude reviewer". Each accidental trigger burns a Claude review run.
- Claude posts a sticky "Claude Code is working…" comment immediately and edits it in place into the final verdict. The script ignores the placeholder and orders Claude signals by `updated_at`.
- `claude.yml` triggers only when the **repo owner** comments (comments posted via `gh` count).

## Pitfalls the script already handles — don't hand-roll queries

- Bot login is `chatgpt-codex-connector[bot]` via REST but `chatgpt-codex-connector` via GraphQL; a filter built for one misses the other.
- Reactions live at `issues/<pr>/reactions`, not in any review/comment endpoint.
- Inline findings are tied to their review via `pull_request_review_id`; counting all inline comments double-counts superseded rounds.
- A usage-limit message is an availability fact, not a verdict — it is never reported as STALE.
- `VERDICT:` lines are only trusted from `[bot]` logins — a human account posting "VERDICT: PASS" on this public repo is ignored by design.
