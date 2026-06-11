@AGENTS.md

# Claude Code specifics

The canonical engineering contract is **AGENTS.md** (imported above) — shared with Codex and every other agent. This section adds only the Claude-Code-specific tooling.

- **Subagents** (`.claude/agents/`): route through the matching reviewer after non-trivial changes — `crypto-reviewer` (crypto/keys/envelope), `security-boundary-auditor` (server boundary, RLS, logging, authz), `infra-reviewer` (Terraform / Docker Compose / systemd). Use `security-architect` proactively *before* coding anything that touches architecture, roadmap order, E2EE/protocol design, key management, or trust boundaries — get its plan, then implement on the session model.
- **Skills** (`.claude/skills/`): `/db-migration`, `/feature-threat-model`, `/api-spec`. Plus built-ins `/security-review`, `/code-review`.
- **Hooks + permissions** (`.claude/settings.json`): destructive-bash guard + edit-time invariant checks. Open `/hooks` once (or restart) to activate after a fresh clone.

## Model & effort routing (token budget)

The session default is set in `.claude/settings.json`: `opusplan` (Sonnet for execution, Opus automatically in plan mode) at high effort. Escalation happens through delegation, never by raising the main-session model:

- **Plan mode first for non-trivial work.** Enter plan mode (Opus under `opusplan`), present the plan in plain language a non-programmer product owner can judge — what will change, what could break, how it gets verified — and get approval before writing code. The owner steers at the plan stage, not the diff stage.
- Heavy reasoning is pinned where it belongs: `security-architect` and `crypto-reviewer` run Fable high, the other reviewers Opus high, `/feature-threat-model` runs Fable for its turn. Delegate to them instead of suggesting a model switch.
- **Deep reviews are scheduled, not continuous.** At milestones (finished roadmap phase, pre-beta), suggest a one-off `/code-review ultra` plus a full-surface `security-architect` pass. Per-PR: one `/code-review` (medium effort) pass over the branch diff before opening the PR, plus the pinned reviewers + Codex. Never per-edit — the hooks and pre-commit gates cover that tier.
- Never use or suggest `ultracode`, a Fable main session, or a `[1m]` context model unless the user explicitly asks — these burn the usage window.
- Stay frugal in the main loop: don't scan the whole repo when a targeted search works; prefer subagents (fresh, small context) for broad exploration.
- After a merged PR or a finished roadmap slice, suggest `/compact`.

Keep all *rules* in AGENTS.md so Codex and Claude never drift. Only Claude-specific wiring belongs here.

## Post-coding auto-flow

Once local gates pass (`pnpm -r typecheck && pnpm -r test`), run the full PR flow **automatically — no pause, no confirmation needed**:

1. `/code-review` (medium effort) over the full branch diff → fix any must-fix findings → commit (Write tool for body file, `git commit -F`).
2. `git push -u origin <branch>`.
3. `gh pr create --body-file /tmp/pr-body.md` (Write tool for the body).
4. **Watch CI**: `gh pr checks <pr> --watch` — if any job fails, immediately investigate (`gh run view … --log | grep -A20 Error`) and fix: new commit → push → wait for CI to re-run. Don't wait for the user to notice failures.
5. **Await review**: `./scripts/codex-review-status.sh <pr> --wait` (blocks up to 15 min; handles the @claude fallback per the `/await-codex` skill). If exit 4 (USAGE_LIMIT), post the `@claude` fallback comment then re-run with `--wait`. If FINDINGS, fix → push → re-run.
6. **Only pause for `gh pr merge`** — that is the one outward, hard-to-reverse step the user drives explicitly.

Steps 4 and 5 run concurrently: start the CI watch, then in the same turn run the review status check with `--wait`. Fix CI failures as they appear.
