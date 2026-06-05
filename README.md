# secmes — Secure Messaging Platform

Privacy-first, end-to-end-encrypted messaging platform delivered as an installable PWA.
The server is **crypto-blind**: it stores ciphertext + metadata only.

Architecture: [`docs/secure_messaging_platform_plan.md`](docs/secure_messaging_platform_plan.md).

## Repo layout

```text
apps/
  api/                 # NestJS backend (Phase 0: health + version only)
packages/
  contracts/           # Shared TypeScript types + Zod schemas (client <-> server envelope)
infra/
  terraform/           # azurerm: RG, VNet, AKS, ACR, Log Analytics
  bootstrap/           # cluster add-ons (ingress-nginx, cert-manager, Argo CD)
charts/
  secmes/              # Helm chart for the app workloads
gitops/
  apps/                # Argo CD Application manifests
.github/workflows/     # CI (build/test) + CD (build image -> ACR -> bump tag)
```

## Status: Phase 0 — prove the pipeline

Goal: a "hello world" service deployed end-to-end (Terraform → AKS → Argo CD) **before** any app logic.

### Local dev

```bash
corepack enable
pnpm install
pnpm --filter @secmes/api dev        # http://localhost:3000/healthz
pnpm test
```

### Provision (when you have an Azure subscription)

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars   # fill in subscription_id, prefix
terraform init
terraform plan
# terraform apply   # creates RG, VNet, AKS (Free tier), ACR, Log Analytics
```

Then bootstrap cluster add-ons and Argo CD: see [`infra/bootstrap/README.md`](infra/bootstrap/README.md).

After cloning: set the Argo CD `repoURL` in `gitops/apps/secmes.yaml` and the CD secrets in GitHub before deploying.

## License

Proprietary — © 2026 Dezoxy. All rights reserved. See [LICENSE](LICENSE).
Source-available for reference only; no use, copying, hosting, or redistribution without written permission.
