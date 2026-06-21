# AGENTS.md — argus engineering contract

Canonical instructions for **any** AI coding agent working in this repo (Codex, Claude Code, Cursor, Gemini CLI, …). Tool-specific wiring is at the bottom; the rules here apply to all.

Privacy-first, **end-to-end-encrypted** messaging platform. Multi-tenant SaaS, installable PWA.
Architecture: `docs/architecture/secure_messaging_platform_plan.md`. Security toolchain: `docs/architecture/security_toolchain.md`.

## Languages

- **All application code is TypeScript** (strict, ESM): React + Vite PWA, NestJS API, WebSocket gateway, workers, and the shared `@argus/contracts` (Zod) package.
- **Crypto**: a TypeScript wrapper over an MLS (WASM) library in `packages/crypto`. You do not write raw crypto.
- **Data**: SQL (PostgreSQL). **Infra/glue**: Terraform (HCL), Docker Compose / CI (YAML), Bash, Dockerfile, Make. (Kubernetes was dropped; deploy is a single VM via Docker Compose — see Stack & conventions.)

## Non-negotiable security invariants

Hard rules. A change that violates one is wrong even if it "works".

1. **The server is crypto-blind.** It stores and forwards ciphertext only. Never decrypt, inspect, or derive meaning from message content on the server.
2. **Never log or persist** plaintext content, private/session/message keys, passphrases, auth tokens, full `Authorization` headers, or presigned URLs. Logs carry IDs and metadata only.
3. **Every tenant-scoped table has `tenant_id` + an enforced RLS policy.** No cross-tenant reads. A new table without RLS is a block.
4. **No hand-rolled crypto.** All cryptography goes through the MLS library in `packages/crypto`. Primitives must not appear elsewhere.
5. **Secrets come from Key Vault via Managed Identity.** Never commit secrets; never put long-lived cloud creds in env files — deliver them as runtime-fetched values or mounted credential **files** (e.g. systemd `LoadCredential`, populated from Key Vault by the VM's Managed Identity). A non-secret config value (e.g. an S3 access-key-**id**, which rides in every presigned URL) may use env; the matching secret may not.
6. **No admin path to content.** Admin/ops surfaces expose metadata only — never message text or images.

## Stack & conventions

- TypeScript strict, ESM. Monorepo via pnpm workspaces (`apps/*`, `packages/*`).
- Backend **NestJS** (`apps/api`); realtime WebSocket gateway; **PostgreSQL** + RLS; DB layer SQL-first (Drizzle/Kysely, not Prisma) so the tenant session var is set per transaction.
- Shared client↔server types + **Zod** schemas live in `@argus/contracts`. Validate at every boundary.
- Frontend **React + Vite** PWA. Deploy: a **single Azure VM** (EU) running the stack via **Docker Compose** — **self-hosted Postgres + Redis + Zitadel**; attachment blobs on **Backblaze B2** (S3-compatible, EU `eu-central-003`); DB backups to a separate private EU B2 bucket. Ingress via **Cloudflare Tunnel** (no public ports); CD via **`az vm run-command`** (Azure control plane, GitHub OIDC). Secrets in **Azure Key Vault**, fetched on the VM via **Managed Identity** (delivered as credential files, never env). IaC Terraform is split by concern: Azure provisioning in `infra/azure/terraform/`, the cloud-agnostic runtime the VM runs (deploy script, secret-fetch, Caddy, observability, glitchtip) in `infra/stack/`, and a parallel AWS experiment in `infra/aws/`. (Kubernetes/AKS was dropped — the old AKS/Helm/Argo CD scaffolds were removed; recover from git history if K8s is ever revisited.)

## Definition of done

- `pnpm -r typecheck && pnpm -r test && pnpm lint && pnpm format:check` pass.
- User-visible web change: Playwright E2E suite passes (`pnpm --filter @argus/web test:e2e`); new user-facing flows get an E2E test; **removed or renamed UI interactions must have their E2E assertions updated in the same commit** — grep `apps/web/e2e/` for the changed label/text/role before pushing. The `e2e` CI job gates merges on this.
- New API endpoints: in the OpenAPI spec with auth + typed schemas (refresh the spec, run the 42Crunch audit).
- New/changed controller: a controller spec asserting the route's auth posture (`@Public` vs guarded) and status/error contract via the metadata-reflection helper (`apps/api/src/common/testing/route-meta.ts`), plus any handler-owned behaviour (uniform-202 / 404-no-oracle / metadata-only / audit-field sanitisation). Services are faked — no DB.
- New tables: `tenant_id` + RLS policy.
- Security-relevant change: a short threat-model note under `docs/threat-models/`.
- No secrets; no banned log patterns.

## Pull request flow

- Every change lands via a PR; `main` is protected.
- **Self-review the full branch diff before opening the PR**: run one code-review pass over everything the branch changes (Claude Code: `/code-review` at medium effort; other agents: their equivalent review prompt) and fix the findings first. One pass per PR, not per edit — the domain reviewers (crypto / boundary / infra) still run after non-trivial changes in their areas, and the edit-time hooks and pre-commit gates cover the mechanical tier.
- **Every PR description is written for a non-programmer product owner**: a plain-language "what changed and why" plus a **"How to verify by hand"** section with concrete steps (what to click/run, what you should see). The owner reviews behavior, not diffs — this section is how. A PR whose effect can't be explained in product terms is a smell.
- **Every PR gets two equal reviews — Codex (`chatgpt-codex-connector`) and the `@claude` reviewer (`.github/workflows/claude.yml`) — and never merges on green CI alone.** Request both right after opening the PR: comment `@codex review`, and ping `@claude review this PR …` instructing it to apply the AGENTS.md review criteria and end with one line `VERDICT: PASS` or `VERDICT: FINDINGS`. Resolve **every finding from either reviewer** (treat P1/P2 like CI failures), or reply on the PR with an explicit, recorded justification. After any push, re-request both.
- **Check the aggregate verdict with `.claude/hooks/review-status.sh <pr> [--wait]`** — Codex may answer only with a 👍 reaction on the PR body (its no-findings signal), which reviews/comments queries and `gh pr view` do not show; the script reads every channel for both reviewers and reports them separately plus an aggregate. Exit codes: 0 clean (both verdicts in; `degraded: true` if Claude-only under a Codex usage limit — record that on the PR), 1 findings (from either), 2 a verdict still missing, 3 stale (a verdict predates the head commit — re-request, don't merge on it), 4 Codex over its usage limit with no Claude verdict yet, 5 unparseable Claude reply.
- If a reviewer stays silent after a re-request, a human decides; never merge unreviewed.
- Merge only when **both** hold: CI green (ci · security · codeql) **and** both reviews are addressed.

## Never do

- Weaken or bypass crypto, RLS, or auth "to make it work".
- Add a dependency without a one-line justification.
- Run `terraform apply`, `terraform destroy`, `az vm run-command`, `docker push`, or `git push --force` without explicit human confirmation.
- Print secret files (`.env`, `*.tfvars`, keys).
- Drive-by refactors. Keep diffs tight.

## Review criteria (apply the matching set after non-trivial changes)

**Crypto** (`packages/crypto`, keys, envelope): no hand-rolled crypto; server stays crypto-blind; keys never logged/transmitted in clear; key backup uses Argon2id + unique salt; CSPRNG only (no `Math.random`).

**Server boundary** (`apps/api`, queries, endpoints): no plaintext on the server; `tenant_id` + RLS on every tenant table; tenant context not set from unverified client input; no secrets/tokens/content in logs; authz on every path (no IDOR); Zod-validated I/O; every route documented in the spec; every controller has a spec pinning its guard + status contract.

**Infra** (`infra/`, workflows, Dockerfiles, `compose.yaml`): no secrets in code; containers non-root + read-only FS + dropped caps + limits; data services private (no public endpoints); least-privilege roles + **Managed Identity** (VM); secrets delivered from **Key Vault** as files, never in env; CI uses OIDC and never interpolates untrusted event input into `run:`; EU region pinned.

## Procedures

- **New DB table** → `tenant_id` + RLS policy + leading-`tenant_id` index. Content columns store ciphertext only.
- **Security-relevant feature** → write the threat-model note *before* coding; verify against the 6 invariants.
- **New/changed endpoint** → annotate with OpenAPI/Swagger (auth + tight typed schema), regenerate `apps/api/openapi.json`, run the 42Crunch audit. Add/extend the controller spec (two tiers: contract via `reflectRouteMeta`, behaviour via direct instantiation with faked services) so the route's `@Public`/guard posture and status contract are pinned.

## Enforcement is tool-agnostic

Whatever agent you are, these gates run on commit/push regardless — do not bypass them:

- **pre-commit** (lefthook): gitleaks, ESLint, Prettier, Semgrep (`.semgrep/`).
- **pre-push**: typecheck, tests.
- **CI**: Semgrep, OSV, Trivy, Checkov, gitleaks, 42Crunch audit, CodeQL; nightly DAST. (Kubescape dropped with K8s — deploy is a single VM via Docker Compose.)

## Per-tool wiring

- **Codex**: reads this file natively (merges `~/.codex/AGENTS.md` + repo `AGENTS.md`). Recommended `~/.codex/config.toml` and prompt files are in `.codex/` — see `docs/architecture/agent-portability.md`. Codex enforces the destructive-command boundary via its **sandbox + approval policy**, not per-command hooks.
- **Claude Code**: `CLAUDE.md` imports this file and adds subagents (`.claude/agents/`), skills (`.claude/skills/`), and hooks/permissions (`.claude/settings.json`).
