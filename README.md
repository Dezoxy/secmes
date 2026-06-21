# argus — Secure Messaging Platform

Privacy-first, end-to-end-encrypted messaging platform delivered as an installable PWA.
The server is **crypto-blind**: it stores ciphertext + metadata only.

Architecture: [`docs/secure_messaging_platform_plan.md`](docs/secure_messaging_platform_plan.md). Phasing & checkpoint status: [`docs/planning/roadmap/README.md`](docs/planning/roadmap/README.md).

> **Deployment (2026-06):** the target is a **single Azure VM** (EU, `germanywestcentral`) running the
> stack via **Docker Compose** — self-hosted **Postgres + Redis** plus API + web + Caddy +
> cloudflared. Attachment blobs live on **Backblaze B2** (S3-compatible, EU `eu-central-003`), DB backups on
> a separate private EU B2 bucket, and secrets in **Azure Key Vault** fetched via the VM's **Managed
> Identity** (credential files, never env). Ingress is a **Cloudflare Tunnel** (no public ports on the VM);
> Cloudflare terminates TLS and runs the edge WAF/rate-limit. CD is **`az vm run-command`** from GitHub
> Actions via Azure OIDC. Kubernetes/AKS was dropped — recover from git history if it is ever revisited.
> Canonical: `AGENTS.md` → *Stack & conventions*.

## What works now

The platform is feature-complete for its v1 scope — the server stays crypto-blind throughout:

- **End-to-end-encrypted messaging** — 1:1 **and group** chat over MLS (RFC 9420); the server only ever stores and forwards ciphertext + routing metadata.
- **Multi-device** — verified device linking with proof-of-possession and enrollment fan-out.
- **Encrypted image attachments** — client-side AES-GCM, presigned upload/download to Backblaze B2, server-blind.
- **Installable PWA** — manifest + service worker, passkey login gate, live send/receive over WebSocket, sealed message-history persistence.
- **Key backup & recovery** — Argon2id-sealed, data-loss-safe restore, plus safety-number (fingerprint) verification against MITM.
- **Multi-tenant isolation** — PostgreSQL Row-Level Security (FORCE RLS) on every tenant-scoped table.
- **Admin & commercial** — metadata-only admin panel (no content path), GDPR export/erasure, per-tenant SSO, Stripe billing.

## Repo layout

```text
apps/
  api/                 # NestJS backend — HTTP + WebSocket, crypto-blind routing, identity, key directory, billing
  web/                 # React + Vite PWA — E2EE chat UI, passkey login, attachments, device linking/recovery, admin
packages/
  contracts/           # Shared TypeScript types + Zod schemas (client <-> server envelope)
  crypto/              # MLS (RFC 9420) wrapper — device keys, key backup (Argon2id), safety numbers
infra/
  azure/terraform/     # Azure VM, NSG (deny-inbound), Key Vault, Managed Identity — the production target
  aws/                 # Parallel AWS EC2 experiment (separate tag namespace + kill-switch; not production)
  stack/               # Cloud-agnostic VM runtime: deploy script, Key Vault secret-fetch, Caddy, observability, glitchtip
  backup/ cleanup/ notify/   # systemd workers — nightly DB backup, attachment expiry, failure alerts
.github/workflows/     # CI (build/test); security (Semgrep/Checkov/gitleaks/CodeQL/DAST/42Crunch); CD (gated)
compose.yaml           # dev stack (Postgres, Redis, MinIO, api)
compose.prod.yaml      # prod stack (+ web, Caddy, cloudflared, observability) — see docs/deploy.md
```

## Status: feature-complete, awaiting deploy arming

The application is built end-to-end (Phases 0–7 plus group chat and multi-device sync — see
[`docs/planning/roadmap/README.md`](docs/planning/roadmap/README.md)). What remains is **operational**, not feature work:

- the **one-time Azure arming** of the gated deploy pipeline — the Terraform, the prod Compose stack +
  ingress, the Key Vault secret delivery, and the full build/scan/sign → GHCR → `az vm run-command`
  rollout (migrate-before-serve) all exist as code, but **`vars.ENABLE_DEPLOY` is off, so merges do not
  deploy yet**; and
- the two external, paid GA gates — **G4 independent crypto review** and **G5 pen test**.

### Local dev

```bash
corepack enable
pnpm install
make up                          # backing services: Postgres, Redis, MinIO
make migrate && make seed        # apply the schema + seed the dev tenant
make api-dev                     # API on http://localhost:3000 (host)
pnpm --filter @argus/web dev     # the PWA on http://localhost:5173
pnpm test
```

Local passkey auth + demo-mode dev flow: [`docs/local-auth.md`](docs/local-auth.md) · [`docs/local-dev.md`](docs/local-dev.md).

### Provision (when you have an Azure subscription)

```bash
cd infra/azure/terraform
cp terraform.tfvars.example terraform.tfvars   # fill in subscription_id, prefix
terraform init
terraform plan
# terraform apply   # creates RG, VNet, NSG (deny inbound), the VM, Key Vault, Managed Identity
```

The VM runs the stack via Docker Compose; secrets are pulled from Key Vault by its Managed Identity as
credential files. Cloudflare (Tunnel + Access) is the only ingress — no inbound ports are opened on the
NSG. Deploys run through GitHub Actions → Azure OIDC → `az vm run-command` (no SSH, no open ports).

## License

Proprietary — © 2026 Dezoxy. All rights reserved. See [LICENSE](LICENSE).
Source-available for reference only; no use, copying, hosting, or redistribution without written permission.
