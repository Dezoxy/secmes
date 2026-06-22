# argus — documentation

Map of the `docs/` tree. Start here.

## Architecture & reference — [`architecture/`](architecture/)

The canonical "how the system is built" docs.

- [`secure_messaging_platform_plan.md`](architecture/secure_messaging_platform_plan.md) — the v2 architecture plan (PWA + NestJS + Postgres + MLS; single Azure VM via Docker Compose).
- [`security_toolchain.md`](architecture/security_toolchain.md) — CI gates + local pre-commit + AI-agent guardrails.
- [`deploy.md`](architecture/deploy.md) — production topology (Cloudflare Tunnel → Caddy → api/ws; Key Vault secrets; migrate-before-serve CD).
- [`mls-library-selection.md`](architecture/mls-library-selection.md) — the `ts-mls` crypto-library decision + spike result.
- [`agent-pipeline.md`](architecture/agent-pipeline.md) · [`agent-portability.md`](architecture/agent-portability.md) — how AI coding agents work this repo.

## Planning & roadmap — [`planning/`](planning/)

What's built, what's left, and the plans for each effort. The canonical phasing lives in
[`planning/roadmap/`](planning/roadmap/) (split per phase, with a progress table and a remaining-work
rollup). See [`planning/README.md`](planning/README.md) for the full plan index, and
[`planning/improvements/`](planning/improvements/) for codebase-health follow-up tracks.

## Operations — [`operations/`](operations/)

Running it, locally and in prod.

- [`local-dev.md`](operations/local-dev.md) — the Docker Compose local stack (`make up` / `make migrate` / `make api-dev`).
- [`local-auth.md`](operations/local-auth.md) — passkey-only login + demo-mode dev flow.
- [`runbooks/`](operations/runbooks/) — operational checklists (e.g. first deploy).

## Security & privacy

- [`threat-models/`](threat-models/) — per-feature security design notes (one per feature; template-driven). Ratify the note before the code.
- [`reviews/`](reviews/) — the security-review campaign (capstone attestation + per-slice evidence) and audit artifacts (e.g. the Lighthouse pass).
- [`gdpr/`](gdpr/) — GDPR Article 30 records + data-residency statement.

## Archive — [`archive/`](archive/)

Superseded / historical docs, kept for the record. Do not follow these for current process.
