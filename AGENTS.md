# AGENTS.md — secmes engineering contract

Canonical instructions for **any** AI coding agent working in this repo (Codex, Claude Code, Cursor, Gemini CLI, …). Tool-specific wiring is at the bottom; the rules here apply to all.

Privacy-first, **end-to-end-encrypted** messaging platform. Multi-tenant SaaS, installable PWA.
Architecture: `docs/secure_messaging_platform_plan.md`. Security toolchain: `docs/security_toolchain.md`.

## Languages

- **All application code is TypeScript** (strict, ESM): React + Vite PWA, NestJS API, WebSocket gateway, workers, and the shared `@secmes/contracts` (Zod) package.
- **Crypto**: a TypeScript wrapper over an MLS (WASM) library in `packages/crypto`. You do not write raw crypto.
- **Data**: SQL (PostgreSQL). **Infra/glue**: Terraform (HCL), Helm/K8s/CI (YAML), Bash, Dockerfile, Make.

## Non-negotiable security invariants

Hard rules. A change that violates one is wrong even if it "works".

1. **The server is crypto-blind.** It stores and forwards ciphertext only. Never decrypt, inspect, or derive meaning from message content on the server.
2. **Never log or persist** plaintext content, private/session/message keys, passphrases, auth tokens, full `Authorization` headers, or presigned URLs. Logs carry IDs and metadata only.
3. **Every tenant-scoped table has `tenant_id` + an enforced RLS policy.** No cross-tenant reads. A new table without RLS is a block.
4. **No hand-rolled crypto.** All cryptography goes through the MLS library in `packages/crypto`. Primitives must not appear elsewhere.
5. **Secrets come from Key Vault via Workload ID.** Never commit secrets; never put long-lived cloud creds in pods, env files, or Helm values.
6. **No admin path to content.** Admin/ops surfaces expose metadata only — never message text or images.

## Stack & conventions

- TypeScript strict, ESM. Monorepo via pnpm workspaces (`apps/*`, `packages/*`).
- Backend **NestJS** (`apps/api`); realtime WebSocket gateway; **PostgreSQL** + RLS; DB layer SQL-first (Drizzle/Kysely, not Prisma) so the tenant session var is set per transaction.
- Shared client↔server types + **Zod** schemas live in `@secmes/contracts`. Validate at every boundary.
- Frontend **React + Vite** PWA. Cloud: **Azure AKS** (EU), Key Vault, Blob, ACR, Entra Workload ID. IaC Terraform; deploy Helm + Argo CD.

## Definition of done

- `pnpm -r typecheck && pnpm -r test && pnpm lint && pnpm format:check` pass.
- New API endpoints: in the OpenAPI spec with auth + typed schemas (refresh the spec, run the 42Crunch audit).
- New tables: `tenant_id` + RLS policy.
- Security-relevant change: a short threat-model note under `docs/threat-models/`.
- No secrets; no banned log patterns.

## Never do

- Weaken or bypass crypto, RLS, or auth "to make it work".
- Add a dependency without a one-line justification.
- Run `terraform apply`, `terraform destroy`, `kubectl delete/apply`, `helm upgrade`, `docker push`, or `git push --force` without explicit human confirmation.
- Print secret files (`.env`, `*.tfvars`, kubeconfig, keys).
- Drive-by refactors. Keep diffs tight.

## Review criteria (apply the matching set after non-trivial changes)

**Crypto** (`packages/crypto`, keys, envelope): no hand-rolled crypto; server stays crypto-blind; keys never logged/transmitted in clear; key backup uses Argon2id + unique salt; CSPRNG only (no `Math.random`).

**Server boundary** (`apps/api`, queries, endpoints): no plaintext on the server; `tenant_id` + RLS on every tenant table; tenant context not set from unverified client input; no secrets/tokens/content in logs; authz on every path (no IDOR); Zod-validated I/O; every route documented in the spec.

**Infra** (`infra/`, `charts/`, workflows, Dockerfiles): no secrets in code; pods non-root + read-only FS + dropped caps + limits; data services private (no public endpoints); least-privilege roles + Workload ID; CI uses OIDC and never interpolates untrusted event input into `run:`; EU region pinned.

## Procedures

- **New DB table** → `tenant_id` + RLS policy + leading-`tenant_id` index. Content columns store ciphertext only.
- **Security-relevant feature** → write the threat-model note *before* coding; verify against the 6 invariants.
- **New/changed endpoint** → annotate with OpenAPI/Swagger (auth + tight typed schema), regenerate `apps/api/openapi.json`, run the 42Crunch audit.

## Enforcement is tool-agnostic

Whatever agent you are, these gates run on commit/push regardless — do not bypass them:

- **pre-commit** (lefthook): gitleaks, ESLint, Prettier, Semgrep (`.semgrep/`).
- **pre-push**: typecheck, tests.
- **CI**: Semgrep, OSV, Trivy, Checkov, Kubescape, gitleaks, 42Crunch audit, CodeQL; nightly DAST.

## Per-tool wiring

- **Codex**: reads this file natively (merges `~/.codex/AGENTS.md` + repo `AGENTS.md`). Recommended `~/.codex/config.toml` and prompt files are in `.codex/` — see `docs/agent-portability.md`. Codex enforces the destructive-command boundary via its **sandbox + approval policy**, not per-command hooks.
- **Claude Code**: `CLAUDE.md` imports this file and adds subagents (`.claude/agents/`), skills (`.claude/skills/`), and hooks/permissions (`.claude/settings.json`).
