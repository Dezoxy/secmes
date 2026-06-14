# infra/aws — parallel AWS experiment stack (Azure Key Vault retained for secrets)

An **experiment** that runs the argus compute on a single **AWS EC2** box (eu-central-1) while secrets stay in
**Azure Key Vault**, read via an **Azure Arc** managed identity (no static credential). It is parallel to the
live `infra/azure/` Azure stack and **touches neither** the production VM nor its Key Vault. No real user data.

See [`docs/threat-models/cross-cloud-secret-fetch.md`](../../../docs/threat-models/cross-cloud-secret-fetch.md)
for the security model + residual risks.

## Real deploy (promoting off the experiment)

The defaults run a **dummy-secret experiment**. For a REAL deploy (real secrets in Key Vault, encrypted remote
state, **no app/runtime secrets in Terraform state**), the helpers in `infra/aws/scripts/` +
`real.tfvars.example` automate it. (Note: `seed_dummy_secrets=false` keeps the Key Vault values out of state,
but the **Arc onboarding SP client secret** + resource ids still live in state — which is exactly why step 1's
encrypted/locked remote backend matters.) **Run every command below from the repo root** (paths are
repo-root-relative — matching the `terraform -chdir=infra/aws/terraform` form the helpers print).

1. **Remote state (once):** `infra/aws/scripts/bootstrap-tfstate.sh` → creates the encrypted/locked/versioned
   S3 backend and writes `infra/aws/terraform/backend.hcl`. Uncomment `backend "s3" {}` in `versions.tf`, then
   `terraform -chdir=infra/aws/terraform init -backend-config=backend.hcl -migrate-state`.
2. **Apply (phase 1):** `cp infra/aws/terraform/real.tfvars.example infra/aws/terraform/real.tfvars` and fill
   it (`seed_dummy_secrets = false` — TF seeds no app/runtime secrets), then
   `terraform -chdir=infra/aws/terraform apply -var-file=real.tfvars`. The box boots + onboards into Arc.
3. **Wait:** `az connectedmachine show -n argus-exp-ec2 -g argus-exp-rg --query status` → `Connected`.
4. **Apply (phase 2):** `terraform -chdir=infra/aws/terraform apply -var-file=real.tfvars -var arc_machine_connected=true`
   (grants the Arc identity Key Vault read).
5. **Populate the vault** with REAL secrets:
   `export ARGUS_S3_SECRET_ACCESS_KEY=… ARGUS_B2_APP_KEY=… ARGUS_TUNNEL_TOKEN=… ARGUS_GHCR_TOKEN=…` then
   `infra/aws/scripts/populate-keyvault.sh` (generates passwords + masterkey, derives the DSNs; idempotent — re-run safe).
   Your machine must reach the KV through its **default-deny firewall** — set `seed_admin_ip` in `real.tfvars`
   (your /32) or run the helper from a host that egresses via the EC2 EIP, else the writes get a 403.
6. **Wire GitHub:** `export S3_BUCKET=… S3_ACCESS_KEY_ID=… OIDC_ISSUER=… OIDC_AUDIENCE=… VITE_OIDC_ISSUER=…
   VITE_OIDC_CLIENT_ID=… VITE_OIDC_REDIRECT_URI=… [X42C_API_TOKEN=…]` then `infra/aws/scripts/setup-github-cicd.sh` (sets
   the cd-aws.yml vars from TF outputs + creates the gated Environment; leaves `ENABLE_DEPLOY_AWS=false`).
7. **Deploy:** `gh variable set ENABLE_DEPLOY_AWS true`, then `git tag aws-v0.1.0 && git push origin aws-v0.1.0`
   → approve in the `aws-experiment` Environment → SSM rolls out `deploy.sh` (migrate → provision runtime role
   logins → bring the stack up).
8. **Arm** the optional secrets after first boot (Stripe, operator key, Sentry DSN, Zitadel mgmt/login PATs)
   via `az keyvault secret set …` — see `infra/stack/secrets/README.md`.

> The `argus_app`/`argus_cleanup`/`argus_backup` DB roles get their LOGIN passwords set **automatically** by
> `deploy.sh` from the Key Vault values — no manual `ALTER ROLE`.

## What it creates

- **AWS:** VPC + public subnet, a no-inbound security group, one EC2 instance (`t3.medium`, IMDSv2-required,
  30 GiB encrypted gp3 root), an Elastic IP, the instance IAM role (SSM + read the one onboarding secret), the
  GitHub OIDC provider + a deploy role scoped to **this one instance**, and the Arc onboarding secret in SSM
  Parameter Store.
- **Azure:** a **separate experiment Key Vault** (RBAC, default-deny firewall + the EC2 EIP allow-listed),
  seeded with **DUMMY** secret values, and an Arc onboarding service principal (onboarding role only).

## Two-phase apply (the Arc managed identity doesn't exist until first boot)

```bash
cd infra/aws/terraform
terraform init

# Phase 1 — create infra; the box boots + onboards itself into Azure Arc.
terraform apply \
  -var azure_subscription_id=<sub> \
  -var azure_admin_object_id=<your-entra-object-id>   # so the apply principal can seed the dummy secrets

# Wait until the machine shows Connected:
#   az connectedmachine show -n argus-exp-ec2 -g argus-exp-rg --query status
# (or check Azure Portal → Azure Arc → Machines)

# Phase 2 — grant the now-existing Arc managed identity read access to the experiment Key Vault.
terraform apply -var azure_subscription_id=<sub> -var azure_admin_object_id=<...> -var arc_machine_connected=true
```

> Seeding the dummy secrets needs the apply principal to hold **Key Vault Secrets Officer** AND to reach the
> vault through its firewall. The firewall allows the EC2 EIP; add your own IP temporarily (or run the seed
> from a host that egresses via the EIP) if a seed write is denied. External credentials
> (`argus-ghcr-token`, `argus-s3-secret-access-key`, `argus-b2-app-key`, `argus-tunnel-token`) are seeded as
> PLACEHOLDERS — replace them with real values for a fully healthy stack.

## GitHub configuration (for `cd-aws.yml`)

Create a GitHub **Environment** named `aws-experiment` with required reviewers, then set repo **vars** from the
Terraform outputs:

| GitHub var | Source |
| --- | --- |
| `ENABLE_DEPLOY_AWS` | `true` to arm the experiment deploy (master kill-switch) |
| `AWS_DEPLOY_ROLE_ARN` | `terraform output github_deploy_role_arn` |
| `AWS_REGION` | `terraform output aws_region` |
| `AWS_INSTANCE_ID` | `terraform output instance_id` |
| `AWS_KEY_VAULT_NAME` | `terraform output key_vault_name` |
| `S3_*`, `OIDC_*`, `VITE_OIDC_*`, `GHCR_USER` | same non-secret config the live deploy uses |

Then push an **`aws-vX.Y.Z`** tag (the experiment's own tag namespace — distinct from the prod `vX.Y.Z` tags so a production release never triggers it) → `cd-aws.yml` builds/signs the images, pauses on the `aws-experiment` approval, then
**starts the instance** (if stopped), waits for SSM, and runs `deploy.sh` with `ARGUS_TOKEN_SOURCE=arc` +
`ARGUS_SKIP_GLITCHTIP=1`. CD never stops the box — **stop it by hand** to save cost
(`aws ec2 stop-instances --instance-ids <id>`); a stopped box is ~$0 compute.

## Cost

~$8.50/mo stopped-when-idle, ~$39/mo running 24/7 (`t3.medium` + 30 GiB gp3 + Elastic IP). Upgrade to `t3.large`
if 4 GiB is tight: set `-var instance_type=t3.large` and re-apply (a 2-min stop→resize→start, EIP preserved).

## State

Local `terraform.tfstate` (gitignored) — it holds the Arc onboarding SP id + the OIDC role arn. Migrate to an
encrypted S3 backend before any shared/CI use (see `versions.tf`).
