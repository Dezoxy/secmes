# VM Terraform — Slice 1 of the VM deploy pipeline

Provisions the single Azure VM the argus stack runs on, plus the Azure pieces around it. **This module is
build-only here — nobody applies it from CI.** You review and `terraform apply` it yourself.

> The legacy AKS Terraform in `infra/terraform/` is dormant (K8s dropped); this `infra/vm/` module is the
> active deploy.

## What it creates

- **Resource group + VNet/subnet** in `germanywestcentral` (EU).
- **Ubuntu 24.04 VM** (`Standard_B2ms`), system-assigned **Managed Identity**, OS disk + a separate **data
  disk** (Postgres + Docker volumes survive a rebuild). `cloud-init` installs Docker, age, AWS CLI v2,
  postgresql-client, and the Azure CLI.
- **NSG with no inbound** — the internet can't reach the VM. App ingress is the **Cloudflare Tunnel**
  (cloudflared dials out); deploys are the **Azure control plane** (`az vm run-command`). A public IP exists
  for **egress only**.
- **Key Vault** (RBAC, default-deny firewall allowing only the VM's egress IP + your optional admin IP). The
  VM identity gets **Key Vault Secrets User** (read-only).
- **GitHub OIDC**: an AAD app + federated credential so GitHub Actions logs in with **no stored secret**, and
  a **least-privilege custom role** that can *only* `run-command` on this VM.

## Prerequisites

- Azure subscription; you logged in as a user who can create resources **and AAD app registrations**
  (Application Administrator or Owner). `az login`.
- **Register host encryption once** (the VM sets `encryption_at_host_enabled = true`):
  `az feature register --namespace Microsoft.Compute --name EncryptionAtHost` (wait for `Registered`, then
  `az provider register -n Microsoft.Compute`). Or set `encryption_at_host_enabled = false` to skip it.
- The `domain` (`4rgus.com`) onboarded to **Cloudflare** (for the tunnel + Access) — not managed here.

## Apply (you, manually)

```bash
cd infra/vm/terraform
cp terraform.tfvars.example terraform.tfvars   # fill in subscription_id + admin_ssh_public_key (+ optional admin_*)
terraform init
terraform plan      # review
terraform apply     # ← only you run this; CI never applies
```

After apply, wire the outputs into GitHub Actions secrets/vars for the CD slice:
`AZURE_CLIENT_ID` = `github_deploy_client_id`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, and the
`resource_group` / `vm_name` for the run-command target. Then populate runtime secrets in the Key Vault
(`key_vault_name`).

## Secrets that go in Key Vault (later slices consume them)

DB passwords (owner, `argus_app`, `argus_cleanup`, `argus_backup`), B2 keys (attachment + backup buckets),
Redis password, Zitadel masterkey/admin, and the **cloudflared tunnel token**. The age backup **private**
key is intentionally NOT here — keep it offline/separate (restore-time only).

## Security model & must-before-prod

- **The deploy SP runs as root on the VM.** `az vm run-command` executes its script as root, so whoever can
  mint the GitHub OIDC token effectively owns the host (incl. the secrets the MI fetched into
  `/run/argus/secrets`). The token's **branch/environment binding is the real security boundary** — so:
- **Before prod, bind the OIDC credential to a protected GitHub Environment**, not the `main` branch ref.
  Set `github_deploy_subject = "repo:Dezoxy/secmes:environment:production"` and gate the CD job with
  `environment: production` + required reviewers. The default (`main` ref) is fine only for the beta.

## Notes / trade-offs

- **State is sensitive** — `terraform.tfstate` is gitignored. Migrate to an encrypted remote backend before
  any shared/CI use (stub in `versions.tf`).
- **Egress public IP** (vs NAT Gateway): cheaper, and inbound is denied — the NAT Gateway is the
  no-public-IP hardening upgrade.
- **Default egress is open**: tightening to service tags / Azure Firewall is an enterprise follow-up.
- **Key Vault purge protection is always on** (secure default; required by the CI scanners). To tear down
  during dev, `az keyvault recover` the soft-deleted vault or wait out the 7-day retention — don't weaken it.
