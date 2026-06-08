# argus — Security Toolchain & Agent Guardrails

How we keep a privacy-first E2EE platform honest. Three enforcement layers + the AI-agent config.
Principle: **OSS self-hosted by default** (nothing leaves our tenancy); external SaaS only where it clearly wins. Scanners see code/specs/deps — never customer message content (E2EE ciphertext regardless).

## Layer 1 — CI gate (GitHub Actions)

| Workflow | Tools | Blocks on |
|---|---|---|
| `ci.yml` | ESLint, Prettier, typecheck, tests, build, OpenAPI emit | lint/type/test failure |
| `security.yml` | Semgrep (custom + auto), OSV-Scanner, gitleaks, Checkov, **42Crunch Audit** | HIGH/CRITICAL findings, secrets, API score < 75 |
| `codeql.yml` | CodeQL (security-extended) | new code-scanning alerts |
| `dast.yml` (nightly) | OWASP ZAP baseline, **42Crunch Conformance Scan** | against staging |
| `cd.yml` | **Trivy image scan**, **syft SBOM**, **cosign** keyless sign + attest | HIGH/CRITICAL in the image |

`cd.yml` (gated behind `vars.ENABLE_DEPLOY`) builds the app image, pushes it to **ACR**, then scans (Trivy), generates an SBOM (syft), and signs/attests (cosign). It does **not** roll out — the VM rollout (image pull + `az vm run-command`) lands with the VM deploy track, which will also move the registry to GHCR.

**Secrets/vars to set before first run:** `X42C_API_TOKEN` (42Crunch), `vars.STAGING_URL` (DAST), `vars.ACR_LOGIN_SERVER` + `AZURE_*` (CD OIDC). Third-party action versions are pinned but **verify them before the first run**.

**Dependency updates:** `.github/dependabot.yml` — weekly grouped PRs for npm (pnpm workspace), GitHub Actions, Terraform, and the Docker base image. This is what keeps the pinned action versions current over time. Enable **Dependabot alerts + security updates** in repo Settings → Security (UI toggle, not the config file). Note: Dependabot PRs run without repo secrets, so the 42Crunch audit job will skip/fail on them unless `X42C_API_TOKEN` is also added under Settings → Secrets → **Dependabot**.

## Layer 2 — Local pre-commit (`lefthook.yml`)

`pnpm prepare` installs it. Pre-commit: gitleaks, ESLint, Prettier, Semgrep on staged files. Pre-push: typecheck + tests. Stops issues before they reach CI.

## Layer 3 — AI agent guardrails (`.claude/`)

- **`CLAUDE.md`** — the six security invariants + conventions, loaded every session.
- **Subagents** (`.claude/agents/`): `crypto-reviewer`, `security-boundary-auditor`, `infra-reviewer` — adversarial reviewers routed by what changed.
- **Skills** (`.claude/skills/`): `db-migration` (forces tenant_id + RLS), `feature-threat-model` (threat model before code), `api-spec` (OpenAPI + 42Crunch). Plus built-ins `/security-review`, `/code-review`.
- **Hooks + permissions** (`.claude/settings.json`):
  - PreToolUse(Bash) **deny** destructive ops (terraform destroy, force-push, rm -rf, secret printing); **ask** on apply/`az vm run-command`/push.
  - PostToolUse(Edit/Write) — banned-pattern check on `*.ts`, `terraform fmt` on infra edits, OpenAPI-refresh reminder on controller edits.

> Hooks added mid-session need `/hooks` (open once) or a restart to activate, because the settings watcher only tracks `.claude/` if a settings file existed at startup.

## Custom Semgrep rules (`.semgrep/argus.yml`)

Enforce the invariants generic scanners miss: no `Math.random()` for security, no crypto primitives outside `packages/crypto`, no logging of secrets/keys/tokens, no SQL string interpolation, no hardcoded secrets.

## 42Crunch flow

1. NestJS `@nestjs/swagger` → `pnpm --filter @argus/api openapi` emits `apps/api/openapi.json`.
2. CI runs **42Crunch Audit** (static, Security Quality Gate ≥ 75).
3. Nightly **42Crunch Scan** (dynamic conformance) against staging.
4. One-time token/binary setup via the `42crunch-setup` skill.

## Cloud + runtime (Azure)

- **Defender for Cloud** — `enable_defender_cspm` (free CSPM), default-off in the VM Terraform (`infra/vm/`). (Defender for Containers was AKS-only — N/A now that the deploy is a single VM running Docker Compose.)

## External milestones (not tools — schedule before GA)

1. **Independent cryptography review** of the MLS integration. Highest-value spend; no scanner validates protocol correctness.
2. **Third-party pen test** + path to SOC 2 / ISO 27001 — enterprise buyers will require the report.

## Deliberately excluded (avoid redundancy/cost)

Snyk (covered by OSV+Trivy+Socket), SonarQube (Semgrep+CodeQL). **Kubescape/kube-bench/Polaris** dropped — Kubernetes was dropped, so the deploy is a single VM via Docker Compose, not K8s, and the AKS/Helm scaffolds were removed (recover from git history and re-add these scanners if K8s is ever re-opened). **Socket.dev** (malicious-package detection) is recommended but left as a TODO — add when you create the account.
