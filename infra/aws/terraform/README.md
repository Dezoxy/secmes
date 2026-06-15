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

> **Start fresh — don't promote a dummy-seeded vault in place.** A real deploy applies with
> `seed_dummy_secrets = false` from the **first** apply, into freshly-bootstrapped remote state — so no
> `azurerm_key_vault_secret.seed` resources ever exist and `populate-keyvault.sh` writes clean names. If you
> instead `-migrate-state` a local state that already seeded the dummy experiment, phase-1 apply **destroys**
> those seeds and the vault (purge-protection is on) **soft-deletes** the names; Azure then refuses to
> recreate a soft-deleted name (409 Conflict), so the populate step fails. To promote anyway, bump
> `var.prefix` for a brand-new vault — that's the only clean path. (Recovering the soft-deleted names does
> **not** help: they return as the dummy seed values, and `populate-keyvault.sh` won't replace them — `put`
> skips existing names without `--rotate`, and the six **set-once** secrets are skipped by `put_once` *even
> with* `--rotate` — so they'd stay dummy. A fresh vault sidesteps all of it.)

Every step has a `make -C infra/aws <target>` (run `make -C infra/aws help` to list them).

1. **Remote state (once):** `make -C infra/aws bootstrap` → creates the encrypted/locked/versioned S3 backend
   and writes `infra/aws/terraform/backend.hcl`. The `backend "s3" {}` block is already enabled in `versions.tf`
   (the default for this deploy), so just initialize against it:
   `terraform -chdir=infra/aws/terraform init -backend-config=backend.hcl`. (Migrating pre-existing local state?
   add `-migrate-state`.)
2. **Apply (phase 1):** `cp infra/aws/terraform/real.tfvars.example infra/aws/terraform/real.tfvars` and fill
   it (`seed_dummy_secrets = false` — TF seeds no app/runtime secrets), then `make -C infra/aws apply-1`
   (`terraform apply` — you confirm `yes`). The box boots + onboards into Arc.
3. **Wait:** `make -C infra/aws wait-arc` — polls `az connectedmachine … status` until `Connected` (pass
   `PREFIX=…` if you changed `var.prefix`).
4. **Apply (phase 2):** `make -C infra/aws apply-2` (grants the Arc identity Key Vault read).
5. **Populate the vault** with REAL secrets: `infra/aws/scripts/populate-keyvault.sh`. It generates the
   passwords + masterkey and derives the DSNs, then **prompts you (hidden input) for the four external creds**
   it can't generate — never written to a file or shell history (invariant #5):
   - B2 **attachments**-bucket secret access key — Backblaze → Application Keys (its *keyID* is non-secret and
     goes in step 6 as `S3_ACCESS_KEY_ID`; this is the *applicationKey* secret);
   - B2 **db-backups** app key (a separate key);
   - **Cloudflare Tunnel** token — Cloudflare Zero Trust → Networks → Tunnels;
   - **GHCR** token — a GitHub PAT with `read:packages`.

   (Pre-set any as an env var, e.g. `ARGUS_TUNNEL_TOKEN=…`, for an unattended run; idempotent — re-run safe.)
   Your machine must reach the KV through its **default-deny firewall** — set `seed_admin_ip` in `real.tfvars`
   (your /32) or run the helper from a host that egresses via the EC2 EIP, else the writes get a 403.
6. **Wire GitHub:** `infra/aws/scripts/setup-github-cicd.sh`. It pulls the AWS values from `terraform output`
   and **prompts for the non-secret config** (S3 bucket + key id, the OIDC / VITE_OIDC values) plus the optional
   42Crunch token (hidden), then sets the cd-aws.yml vars + creates the gated Environment (leaves
   `ENABLE_DEPLOY_AWS=false`). Pre-set any value as an env var to skip its prompt. The Zitadel SPA
   `VITE_OIDC_CLIENT_ID` only exists once Zitadel is up — set a placeholder, configure Zitadel, then re-run.

   > **Shortcut for steps 5–6:** `make -C infra/aws secrets` runs both helpers in order (Key Vault → GitHub)
   > and stops if the first fails. Individual targets: `make -C infra/aws populate-kv` / `wire-github`.

7. **Deploy:** `gh variable set ENABLE_DEPLOY_AWS --body true`, then `git tag aws-v0.1.0 && git push origin aws-v0.1.0`
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
terraform init -backend-config=backend.hcl   # S3 backend is the default — run `make -C infra/aws bootstrap` first

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

Remote **S3 backend** is the default (`backend "s3" {}` in `versions.tf`) — encrypted, locked (DynamoDB), and
versioned. It holds the Arc onboarding SP id + the KV id + the OIDC role arn (no app/runtime secrets when
`seed_dummy_secrets = false`), so it must never be local or committed. One-time bootstrap:
`make -C infra/aws bootstrap` (creates the bucket + lock table + writes `backend.hcl`), then
`terraform init -backend-config=backend.hcl`. `backend.hcl` is gitignored (machine-specific). Only for a
throwaway local-state experiment: comment the backend block out and re-`init`.
