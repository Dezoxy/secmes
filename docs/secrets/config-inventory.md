# Configuration inventory (non-secret)

Every **non-secret** configuration value the argus deployment depends on — GitHub
repo variables, GitHub Actions context, the AWS OIDC trust model, Terraform
variables, and on-box environment. The matching **secret** halves live in Azure
Key Vault and are catalogued in [`secrets-inventory.md`](secrets-inventory.md);
here they appear only as cross-references.

> Everything below is non-secret **by design** — bucket names, access-key *ids*
> (which ride in every presigned URL), public keys, region/endpoint pointers, and
> deploy flags. The line between this file and `secrets-inventory.md` is
> invariant #5: *the secret may not sit in env; its non-secret id/pointer may.*
>
> Scope: the AWS-EC2 experiment path (`cd-aws.yml` → SSM → `deploy.sh`).
> **`gh variable list -R Dezoxy/secmes` is the canonical source for the live
> values** — the values quoted here are current at writing and may drift.

## 0. Where config lives, and the chicken-and-egg rule

| Tier | What lives here | Why |
|---|---|---|
| **GitHub repo variables** | deploy gate, AWS pointers, B2/S3 *ids* + bucket names, age *public* key | Consumed by CI **before** the box/vault is reachable, or non-secret by nature |
| **GitHub Actions context** | registry, image tag, repo slug, cross-env knobs | Provided by the workflow run itself |
| **AWS (OIDC + Terraform)** | the deploy role, region, instance — **no stored credential** | CI assumes a role via OIDC → STS temporary creds |
| **On-box env (`deploy.sh`/compose)** | the same non-secret ids/buckets/flags, plus `*_FILE` *paths* | The box needs them to template units and address services |

**The chicken-and-egg rule:** the values that exist precisely *to reach* AWS and
*find* the vault cannot themselves live in the vault — `AWS_KEY_VAULT_NAME`,
`AWS_DEPLOY_ROLE_ARN`, `AWS_REGION`, `AWS_INSTANCE_ID`, and the `ENABLE_DEPLOY_AWS`
gate. (See the deploy discussion in [`secrets-inventory.md`](secrets-inventory.md) §0.)

## 1. Live GitHub repo variables

All non-secret by definition (repo *variables*, not *secrets*).

| Name | Current value | Purpose | Consumer | Why non-secret |
|---|---|---|---|---|
| `ENABLE_DEPLOY_AWS` | `true` | Master kill-switch for the AWS workflow | `if: vars.ENABLE_DEPLOY_AWS == 'true'` on both jobs | A gate GitHub evaluates before any AWS call |
| `AWS_DEPLOY_ROLE_ARN` | `arn:aws:iam::402372753682:role/argus-exp-github-deploy` | OIDC role the `deploy` job assumes | `configure-aws-credentials` | An ARN is a pointer; trust is the OIDC subject condition, not ARN secrecy |
| `AWS_REGION` | `eu-central-1` | Region for STS/EC2/SSM (EU residency) | deploy job + all `aws` calls | A region name |
| `AWS_INSTANCE_ID` | `i-0e5794424ededc492` | The one EC2 box to start + SSM | `aws ec2 start-instances` / `ssm send-command` | An instance id; IAM pins capability to it |
| `AWS_KEY_VAULT_NAME` | `argus-exp-kv-4ad322` | Which Key Vault the box reads | → `ARGUS_KEY_VAULT` → `deploy.sh` → fetch script | Chicken-and-egg: the pointer to *find* the vault can't live inside it |
| `GHCR_USER` | `Dezoxy` | Username for `docker login ghcr.io` on the box | `deploy.sh` | A username; the PAT is `argus-ghcr-token` in KV |
| `S3_ENDPOINT` | `https://s3.eu-central-003.backblazeb2.com` | B2 S3 endpoint for attachments | api container env | A public endpoint |
| `S3_REGION` | `eu-central-003` | B2 region | api container env | A region name |
| `S3_BUCKET` | `attachment-r8xq4m7z2p9n6k3v` | Attachment bucket (CSP-pinned) | `deploy.sh` CSP-1 guard + api/cleanup | A bucket name; rides in presigned URLs |
| `S3_ACCESS_KEY_ID` | `00360fff542dcd80000000003` | Attachment B2 key **id** | api env + cleanup unit | Access-key ids ride in presigned URLs. ↔ `argus-s3-secret-access-key` |
| `B2_APP_KEY_ID` | `00360fff542dcd80000000007` | db-backups B2 key **id** (separate key) | templated into `argus-db-backup.service` | Key id, not the secret. ↔ `argus-b2-app-key` |
| `B2_CORS_KEY_ID` | `00360fff542dcd80000000006` | CORS app-key **id** | `deploy.sh` step 6c (skip if empty) | Key id only. ↔ `argus-b2-cors-app-key` |
| `BACKUP_S3_BUCKET` | `db-q7m2z9x4v6n8p3k1` | Private db-backups bucket (WORM) | templated into `argus-db-backup.service` | A bucket name; keeps experiment dumps out of the prod backup bucket |
| `BACKUP_AGE_RECIPIENT` | `age1u3l07w20yf…drnse` | age **public** recipient for the nightly dump | templated into `argus-db-backup.service` | A **public** key — only the offline private half decrypts |
| `ENABLE_42CRUNCH` | `false` | Toggles the 42Crunch CI audit (not the AWS path) | CI audit job | A CI feature flag |

### DEPRECATED — delete (do not recreate)
`OIDC_AUDIENCE`, `OIDC_ISSUER`, `VITE_OIDC_CLIENT_ID`, `VITE_OIDC_ISSUER`,
`VITE_OIDC_REDIRECT_URI` — leftovers from the decommissioned Zitadel/OIDC login
(passkey pivot, PR #223). Confirmed dead: none appear in `cd-aws.yml`,
`compose.prod.yaml`, or `deploy.sh`, and nothing in app/build code reads them
(only the Playwright config references them, hardcoded). Auth is passkey-only now.
`docs/architecture/deploy.md` still mentions them in stale prose — clean that up
when convenient.

## 2. GitHub Actions context (set by the workflow run, not repo vars)

| Name | Source | Purpose |
|---|---|---|
| `REGISTRY` | literal `ghcr.io` | Container registry host |
| `IMAGE_TAG` | `github.ref_name` (the `aws-v*` tag) | Image tag = cosign identity ref |
| `GHCR_OWNER` / `GHCR_REGISTRY` | `github.repository_owner` → `ghcr.io/dezoxy` | GHCR namespace for pull |
| `GH_REPO` | `github.repository` (`Dezoxy/secmes`) | cosign signing identity |
| `secrets.GITHUB_TOKEN` | GitHub-provided | GHCR **push** auth in the `images` job (ephemeral, run-scoped) |
| `ARGUS_TOKEN_SOURCE` | literal `arc` | Selects Arc HIMDS as the on-box MI token source (vs Azure-VM IMDS) |
| `ARGUS_SKIP_GLITCHTIP` | literal `1` | Skip the GlitchTip tier on the lean box |
| `ARGUS_COSIGN_WORKFLOW` | literal `.github/workflows/cd-aws.yml` | Which workflow's OIDC identity signed the images — verified before run |

## 3. AWS / OIDC trust model — there are NO stored AWS credentials

GitHub Actions mints a short-lived OIDC token; AWS STS exchanges it for **temporary**
role credentials via `AssumeRoleWithWebIdentity`. Nothing long-lived is stored.

- **OIDC provider:** `token.actions.githubusercontent.com`, audience `sts.amazonaws.com`.
- **Deploy role** `argus-exp-github-deploy` trusts **only** the subject
  `repo:Dezoxy/secmes:environment:aws-experiment` — bound to the **GitHub
  Environment**, not a branch. The per-release required-reviewer gate on
  `aws-experiment` is therefore load-bearing; any other subject is rejected by STS.
- **Deploy-role permissions (least privilege):** `ssm:SendCommand` pinned to the one
  instance ARN **and** the `AWS-RunShellScript` doc; `ec2:StartInstances` pinned to
  the one instance; read-only status calls. **No** Stop/Terminate/resize, **no** KV
  access, **no** other host.
- **Instance role** `argus-exp-instance` (the box's own identity via IMDSv2):
  `AmazonSSMManagedInstanceCore` + read **only** the one Arc-onboarding SSM
  parameter + `kms:Decrypt` constrained to `kms:ViaService = ssm.<region>...`. The
  app secrets are **not** here — they live in Azure Key Vault, read via Arc.

## 4. Terraform variables (`infra/aws/terraform`) — non-secret defaults

| Variable | Default | Purpose |
|---|---|---|
| `aws_region` | `eu-central-1` | EC2/SSM region |
| `prefix` | `argus-exp` | Name prefix for all experiment resources |
| `instance_type` | `t3.medium` (`real.tfvars`: `c7i-flex.large`, free-tier) | EC2 size |
| `root_volume_gb` | `30` | gp3 root volume |
| `instance_ami` | `null` | Explicit AMI; null → auto Ubuntu 24.04 |
| `admin_cidr` | `null` | Optional break-glass SSH CIDR (rejects `0.0.0.0/0`) |
| `github_owner` / `github_repo` | `Dezoxy` / `secmes` | OIDC subject |
| `github_deploy_environment` | `aws-experiment` | OIDC subject env — **must match `environment:` in cd-aws.yml** |
| `create_github_oidc_provider` | `true` | Create vs reference the GH OIDC provider |
| `azure_location` | `germanywestcentral` | Azure region for the KV + Arc projection |
| `arc_machine_connected` | `false` | Two-phase apply flag (flip true after Arc shows Connected) |
| `seed_dummy_secrets` | `true` (example: `false`) | Seed dummy KV secrets for an end-to-end dry run |

> **Secret-adjacent, NOT non-secret config:** `azure_subscription_id`,
> `azure_admin_object_id`, `seed_admin_ip` are ids/IPs (treat as sensitive-ish);
> the Arc onboarding SP secret lives in Terraform **state** → use the encrypted,
> locked S3 backend (`backend.hcl`).

## 5. On-box environment & systemd templating

### 5a. Non-secret env `deploy.sh` consumes (exported by the SSM wrapper)
`ARGUS_KEY_VAULT`, `IMAGE_TAG`, `GHCR_REGISTRY`, `GHCR_USER`, `GH_REPO`,
`S3_BUCKET`, `S3_ACCESS_KEY_ID`, `B2_APP_KEY_ID`, `BACKUP_AGE_RECIPIENT`,
`BACKUP_S3_BUCKET`, `B2_CORS_KEY_ID`, `S3_ENDPOINT`, `S3_REGION`,
`ARGUS_TOKEN_SOURCE`, `ARGUS_SKIP_GLITCHTIP`, `ARGUS_COSIGN_WORKFLOW` (values per
§1–§2). Hardcoded literals in `deploy.sh`: `ATTACHMENT_BUCKET` (= `S3_BUCKET`,
CSP-1 invariant), `KV_API_VERSION=7.4`, the Arc HIMDS URL.

### 5b. Notable container env (`compose.prod.yaml`, `${VAR:-default}`)
- `FRONTEND_ORIGIN=https://4rgus.com`, `WEBAUTHN_RP_ID=4rgus.com`,
  `WEBAUTHN_RP_NAME=argus` — **not set as vars on the AWS path; they fall back to
  these compose defaults, which is correct because the box serves publicly at
  `4rgus.com`** (per the deploy runbook). If the experiment is ever served on a
  different hostname these must become `aws-experiment`-scoped vars wired through
  the SSM wrapper, or passkey login + CORS will reject the real origin.
- `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD` — empty (no-op) until Cloudflare Access
  is wired; both are public values when set.
- `S3_FORCE_PATH_STYLE=false`, `NODE_ENV=production`, `PORT=3000`,
  `SENTRY_RELEASE=${IMAGE_TAG}`, Grafana `GF_*` hardening literals.
- `*_FILE` env (`DATABASE_URL_FILE`, `SESSION_SIGNING_KEY_FILE`,
  `S3_SECRET_ACCESS_KEY_FILE`, `REDIS_URL_FILE`, `TUNNEL_TOKEN_FILE`,
  `POSTGRES_PASSWORD_FILE`, …) hold **paths under `/run/secrets/*`, not values** —
  the contents are the KV secrets.

### 5c. systemd placeholders `deploy.sh` templates (all non-secret)
`REPLACE_WITH_KEY_VAULT_NAME` ← `ARGUS_KEY_VAULT`; `REPLACE_WITH_B2_KEY_ID` ←
`B2_APP_KEY_ID`; `REPLACE_WITH_AGE_PUBLIC_KEY` ← `BACKUP_AGE_RECIPIENT`;
`REPLACE_WITH_BACKUP_BUCKET` ← `BACKUP_S3_BUCKET`; `REPLACE_WITH_ATTACHMENT_KEY_ID`
← `S3_ACCESS_KEY_ID`; `REPLACE_WITH_ATTACHMENT_BUCKET` ← `S3_BUCKET`. The matching
secrets arrive as `LoadCredential` files; the units carry only non-secret values.

## 6. id ↔ secret pairings

The non-secret id lives in GitHub; the secret half lives in Key Vault.

| Non-secret id (GitHub var) | Current value | Secret half (Key Vault) |
|---|---|---|
| `S3_ACCESS_KEY_ID` | `00360fff542dcd80000000003` | `argus-s3-secret-access-key` |
| `B2_APP_KEY_ID` | `00360fff542dcd80000000007` | `argus-b2-app-key` |
| `B2_CORS_KEY_ID` | `00360fff542dcd80000000006` | `argus-b2-cors-app-key` |
| `GHCR_USER` | `Dezoxy` | `argus-ghcr-token` (PAT) |
| `BACKUP_AGE_RECIPIENT` | `age1u3l07w…` (public key) | the age **private** key (offline, **not** in KV) |
| `AWS_KEY_VAULT_NAME` | `argus-exp-kv-4ad322` | (the vault's entire contents) |
