@AGENTS.md

# Claude Code specifics

The canonical engineering contract is **AGENTS.md** (imported above) — shared with Codex and every other agent. This section adds only the Claude-Code-specific tooling.

- **Subagents** (`.claude/agents/`): route through the matching reviewer after non-trivial changes — `crypto-reviewer` (crypto/keys/envelope), `security-boundary-auditor` (server boundary, RLS, logging, authz), `infra-reviewer` (Terraform / Docker Compose / systemd). Use `security-architect` proactively *before* coding anything that touches architecture, roadmap order, E2EE/protocol design, key management, or trust boundaries — get its plan, then implement on the session model.
- **Skills** (`.claude/skills/`): `/db-migration`, `/feature-threat-model`, `/api-spec`. Plus built-ins `/security-review`, `/code-review`.
- **Hooks + permissions** (`.claude/settings.json`): destructive-bash guard + edit-time invariant checks. Open `/hooks` once (or restart) to activate after a fresh clone.

## Model & effort routing (token budget)

The session default is set in `.claude/settings.json`: `opusplan` (Sonnet for execution, Opus automatically in plan mode) at high effort. Escalation happens through delegation, never by raising the main-session model:

- **Plan-mode gate — the trigger is the upcoming file edit, not whether the task "feels big".** Reading and investigating are free-form, but the moment a task is headed for a code change (any roadmap item, bug fix, feature, or refactor that will end in a PR), enter plan mode (Opus under `opusplan`) **before the first Edit/Write** — scouting the fix site, checking conventions, and sizing the change belong *inside* plan mode, not before it. Present the plan in plain language a non-programmer product owner can judge — what will change, what could break, how it gets verified — and get approval before any file is modified. If you catch yourself preparing an implementation without an approved plan, stop and enter plan mode immediately. Only trivial mechanical edits the user explicitly dictated (a typo, a one-line config value) skip the gate.
- Heavy reasoning is pinned where it belongs: every reviewer subagent (`security-architect`, `crypto-reviewer`, `security-boundary-auditor`, `infra-reviewer`) and the `/feature-threat-model` skill run **Opus at max effort**. Delegate to them instead of suggesting a model switch.
- **Deep reviews are scheduled, not continuous.** At milestones (finished roadmap phase, pre-beta), suggest a one-off `/code-review ultra` plus a full-surface `security-architect` pass. Per-PR: one `/code-review` (medium effort) pass over the branch diff before opening the PR, plus the pinned reviewers + Codex. Never per-edit — the hooks and pre-commit gates cover that tier.
- Never use or suggest `ultracode`, a Fable main session, or a `[1m]` context model unless the user explicitly asks — these burn the usage window.
- Stay frugal in the main loop: don't scan the whole repo when a targeted search works; prefer subagents (fresh, small context) for broad exploration.
- After a merged PR or a finished roadmap slice, suggest `/compact`.

Keep all *rules* in AGENTS.md so Codex and Claude never drift. Only Claude-specific wiring belongs here.

## Post-coding auto-flow

Once local gates pass (`pnpm -r typecheck && pnpm -r test`), run the full PR flow **automatically — no pause, no confirmation needed**:

1. `/code-review` (medium effort) over the full branch diff → fix any must-fix findings → commit (Write tool for body file, `git commit -F`).
2. `git push -u origin <branch>`.
3. `gh pr create --body-file /tmp/pr-body.md` (Write tool for the body), then immediately post **both** review requests per the `/await-reviews` skill: `@codex review` plus the `@claude review …` ping with the `VERDICT:` contract.
4. **Watch CI**: `gh pr checks <pr> --watch` — if any job fails, immediately investigate (`gh run view … --log | grep -A20 Error`) and fix: new commit → push → wait for CI to re-run. Don't wait for the user to notice failures.
5. **Await both reviews**: `.claude/hooks/review-status.sh <pr> --wait` (blocks up to 15 min; aggregates Codex + Claude per the `/await-reviews` skill). If FINDINGS — from either reviewer — fix → push → re-request both → re-run.
6. **Only pause for `gh pr merge`** — that is the one outward, hard-to-reverse step the user drives explicitly.

Steps 4 and 5 run concurrently: start the CI watch, then in the same turn run the review status check with `--wait`. Fix CI failures as they appear.
