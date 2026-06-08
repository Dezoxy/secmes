@AGENTS.md

# Claude Code specifics

The canonical engineering contract is **AGENTS.md** (imported above) — shared with Codex and every other agent. This section adds only the Claude-Code-specific tooling.

- **Subagents** (`.claude/agents/`): route through the matching reviewer after non-trivial changes — `crypto-reviewer` (crypto/keys/envelope), `security-boundary-auditor` (server boundary, RLS, logging, authz), `infra-reviewer` (Terraform / Docker Compose / systemd).
- **Skills** (`.claude/skills/`): `/db-migration`, `/feature-threat-model`, `/api-spec`. Plus built-ins `/security-review`, `/code-review`.
- **Hooks + permissions** (`.claude/settings.json`): destructive-bash guard + edit-time invariant checks. Open `/hooks` once (or restart) to activate after a fresh clone.

Keep all *rules* in AGENTS.md so Codex and Claude never drift. Only Claude-specific wiring belongs here.
