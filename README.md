# argus — Secure Messaging Platform

Privacy-first, end-to-end-encrypted messaging platform delivered as an installable PWA.
The server is **crypto-blind**: it stores ciphertext + metadata only.

Architecture: [`docs/secure_messaging_platform_plan.md`](docs/secure_messaging_platform_plan.md).

> **Deployment (2026-06):** the target is a **single Azure VM** (EU, `germanywestcentral`) running the
> stack via **Docker Compose** — self-hosted **Postgres + Redis + Zitadel** plus API + web + Caddy +
> cloudflared. Attachment blobs live on **Backblaze B2** (S3-compatible, EU `eu-central-003`), DB backups on
> a separate private EU B2 bucket, and secrets in **Azure Key Vault** fetched via the VM's **Managed
> Identity** (credential files, never env). Ingress is a **Cloudflare Tunnel** (no public ports on the VM);
> Cloudflare terminates TLS and runs the edge WAF/rate-limit. CD is **`az vm run-command`** from GitHub
> Actions via Azure OIDC. Kubernetes/AKS was dropped — recover from git history if it is ever revisited.
> Canonical: `AGENTS.md` → *Stack & conventions*.

## Repo layout

```text
apps/
  api/                 # NestJS backend (Phase 0: health + version only)
packages/
  contracts/           # Shared TypeScript types + Zod schemas (client <-> server envelope)
infra/
  vm/                  # Terraform (the Azure VM, NSG deny-inbound, Key Vault, Managed Identity) + caddy/ (ingress image)
.github/workflows/     # CI (build/test); CD (gated: build/scan/sign the image — VM rollout is WIP)
compose.yaml           # dev stack (Postgres, Redis, MinIO, Zitadel, api)
compose.prod.yaml      # prod stack (Postgres, Redis, api, Caddy single-origin router, cloudflared) — see docs/deploy.md
```

## Status: Phase 0 — stand up the VM

Goal: the VM provisioned and the stack reachable through the Cloudflare Tunnel, with CD via
`az vm run-command`, **before** the bulk of the app logic. (Today: the Terraform + the gated
build/scan/sign pipeline exist; the VM rollout step is still being built — merges do **not** deploy yet.)

### Local dev

```bash
corepack enable
pnpm install
pnpm --filter @argus/api dev        # http://localhost:3000/healthz
pnpm test
```

### Provision (when you have an Azure subscription)

```bash
cd infra/vm/terraform
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
