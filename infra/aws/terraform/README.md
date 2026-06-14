# infra/aws — parallel AWS experiment stack (Azure Key Vault retained for secrets)

An **experiment** that runs the argus compute on a single **AWS EC2** box (eu-central-1) while secrets stay in
**Azure Key Vault**, read via an **Azure Arc** managed identity (no static credential). It is parallel to the
live `infra/azure/` Azure stack and **touches neither** the production VM nor its Key Vault. No real user data.

See [`docs/threat-models/cross-cloud-secret-fetch.md`](../../../docs/threat-models/cross-cloud-secret-fetch.md)
for the security model + residual risks.

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

Then push a `vX.Y.Z` tag → `cd-aws.yml` builds/signs the images, pauses on the `aws-experiment` approval, then
**starts the instance** (if stopped), waits for SSM, and runs `deploy.sh` with `ARGUS_TOKEN_SOURCE=arc` +
`ARGUS_SKIP_GLITCHTIP=1`. CD never stops the box — **stop it by hand** to save cost
(`aws ec2 stop-instances --instance-ids <id>`); a stopped box is ~$0 compute.

## Cost

~$8.50/mo stopped-when-idle, ~$39/mo running 24/7 (`t3.medium` + 30 GiB gp3 + Elastic IP). Upgrade to `t3.large`
if 4 GiB is tight: set `-var instance_type=t3.large` and re-apply (a 2-min stop→resize→start, EIP preserved).

## State

Local `terraform.tfstate` (gitignored) — it holds the Arc onboarding SP id + the OIDC role arn. Migrate to an
encrypted S3 backend before any shared/CI use (see `versions.tf`).
