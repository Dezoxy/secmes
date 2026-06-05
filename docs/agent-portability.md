# Agent Portability — Codex, Claude Code, and others

secmes is agent-neutral. The **rules** live in one file (`AGENTS.md`); the **hard guarantees** live in git hooks + CI, which run no matter which agent (or human) writes the code.

## One source of truth

```
AGENTS.md                  <- canonical rules (read natively by Codex, Cursor, Gemini CLI, …)
  └─ CLAUDE.md             <- `@AGENTS.md` import + Claude-only wiring (subagents, skills, hooks)
```

Edit rules in **AGENTS.md only**. Never copy rules into CLAUDE.md — it imports them.

## What's portable vs. tool-specific

| Capability | Claude Code | Codex | Portable? |
|---|---|---|---|
| Rules / contract | CLAUDE.md → AGENTS.md | AGENTS.md | ✅ same file |
| Review checklists | subagents (`.claude/agents/`) | "Review criteria" section in AGENTS.md | ✅ as guidance |
| Procedures (RLS migration, threat model, api-spec) | skills (`.claude/skills/`) | prompts (`.codex/prompts/`) | ✅ mirrored |
| Destructive-command boundary | PreToolUse hooks + permissions (`.claude/settings.json`) | `approval_policy` + `sandbox_mode` (`~/.codex/config.toml`) | ⚠️ different mechanism, same outcome |
| **Hard enforcement** | — | — | ✅ **lefthook + CI, identical for both** |

The bottom row is the point: secrets scanning, lint, Semgrep, typecheck, tests (pre-commit/pre-push via lefthook) and the full CI security suite gate **every** commit regardless of agent. That's the real guarantee — the per-agent guardrails just catch issues earlier.

## Set up Codex

```bash
# 1. AGENTS.md is already read automatically from the repo root — nothing to do.

# 2. Recommended global config (approval + sandbox = the boundary):
cp .codex/config.toml.example ~/.codex/config.toml   # then merge with any existing config

# 3. (Optional) expose the procedures as /db-migration, /feature-threat-model, /api-spec:
ln -s "$PWD/.codex/prompts/"*.md ~/.codex/prompts/
```

Key Codex settings (in `~/.codex/config.toml`): `approval_policy = "on-request"` and `sandbox_mode = "workspace-write"` with `network_access = false` — together these require human approval before the destructive/networked commands that `AGENTS.md` lists, mirroring Claude Code's deny/ask hooks.

## Set up Claude Code

CLAUDE.md, `.claude/agents`, `.claude/skills`, and `.claude/settings.json` are committed. After a fresh clone, open `/hooks` once (or restart) so the mid-session-added hooks activate.

## Both tools, always

```bash
pnpm install      # Node deps (isolated in node_modules)
make tools        # Python scanners (isolated in .venv)
pnpm prepare      # installs lefthook git hooks (needs a git repo)
```
