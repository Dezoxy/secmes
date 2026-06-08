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

`cd.yml` is **release-on-tag**: pushing a semver tag (`v*.*.*`) builds **both** images (the `api` and the Caddy `ingress` that bakes the PWA) tagged with the version, pushes them to **GHCR**, then scans (Trivy), SBOMs (syft), and keyless-signs/attests (cosign). It then **rolls out** to the single VM via **`az vm run-command`** (Azure OIDC) — the VM pulls the signed images and runs DB **migrations before serving** (`infra/vm/deploy/deploy.sh`). The deploy is double-gated: `vars.ENABLE_DEPLOY` (master kill-switch) **and** the **`production` GitHub Environment**'s required-reviewer approval (a per-release human gate). The run-command payload is non-secret (exact-SHA config); every secret is fetched on the VM via the Managed Identity. See `docs/threat-models/vm-cd.md`.

**Secrets/vars to set before first run:** `X42C_API_TOKEN` (42Crunch), `vars.STAGING_URL` (DAST), and for CD: `AZURE_CLIENT_ID`/`AZURE_TENANT_ID`/`AZURE_SUBSCRIPTION_ID` (OIDC secrets) + `vars.AZURE_RESOURCE_GROUP`/`vars.AZURE_VM_NAME`/`vars.KEY_VAULT_NAME` and the build-time `vars.VITE_OIDC_*` (all from the Terraform outputs). GHCR push uses the built-in `GITHUB_TOKEN` (no extra secret). Third-party action versions are pinned but **verify them before the first run**.

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

- **Defender for Cloud** — **not yet wired** in `infra/vm/` (the AKS-era `enable_defender_cspm` toggle was removed with the legacy Terraform). Enable free CSPM in the Azure portal, or add it to the VM Terraform as a follow-up. (Defender for Containers was AKS-only — N/A for a single VM running Docker Compose.)

## External milestones (not tools — schedule before GA)

1. **Independent cryptography review** of the MLS integration. Highest-value spend; no scanner validates protocol correctness.
2. **Third-party pen test** + path to SOC 2 / ISO 27001 — enterprise buyers will require the report.

## Deliberately excluded (avoid redundancy/cost)

Snyk (covered by OSV+Trivy+Socket), SonarQube (Semgrep+CodeQL). **Kubescape/kube-bench/Polaris** dropped — Kubernetes was dropped, so the deploy is a single VM via Docker Compose, not K8s, and the AKS/Helm scaffolds were removed (recover from git history and re-add these scanners if K8s is ever re-opened). **Socket.dev** (malicious-package detection) is recommended but left as a TODO — add when you create the account.
