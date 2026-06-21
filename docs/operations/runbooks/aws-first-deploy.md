# AWS first-deploy runbook (experiment path)

Operational checklist for the **first** production rollout of argus to the AWS EC2
experiment box. This is the AWS path (`infra/aws/`, `cd-aws.yml`, the `aws-experiment`
GitHub Environment) — **not** the canonical single-Azure-VM path described in
[`docs/architecture/deploy.md`](../../architecture/deploy.md), which stays the authoritative reference for topology,
the stack, secrets delivery, and observability. Read that for the "how it works"; this
doc is the "what to do, in order, the first time."

> Status at time of writing (2026-06-20): infra + secrets layer provisioned; **never deployed**
> (zero `aws-v*` tags, zero `cd-aws` runs). Auth is **passkey-only** — Zitadel/OIDC was
> decommissioned (PR #223), so there is no IdP to stand up and no post-deploy client-id rewire.

## Architecture (as deployed today)

- **Compute:** one AWS EC2 box (`eu-central-1`), rolled out via **SSM send-command** (no SSH),
  **GitHub OIDC → AWS IAM** (no stored AWS creds).
- **Secrets:** **Azure Key Vault**, read on the box via an **Azure Arc** managed identity
  (`ARGUS_TOKEN_SOURCE=arc`, HIMDS challenge-token). Azure is *only* Key Vault.
- **Ingress:** **Cloudflare Tunnel** (`4rgus-tunnel`, no public ports) → `caddy:8080`, host-routed.
  The app is served **publicly** at `4rgus.com`; Cloudflare Access gates only `/admin` (breakglass).
- **Auth:** passkey/WebAuthn; the API mints/verifies its own Ed25519 session tokens (no external IdP).
  `WEBAUTHN_RP_ID` / `FRONTEND_ORIGIN` default to `4rgus.com` in `compose.prod.yaml` — no action.
- **Data:** self-hosted Postgres + Redis; attachments on Backblaze B2; nightly encrypted+signed
  DB backups to a separate private B2 bucket. GlitchTip skipped on the lean box (`ARGUS_SKIP_GLITCHTIP=1`).

## Deploy trigger (how it runs)

1. Push a tag matching **`aws-v*.*.*`** → `.github/workflows/cd-aws.yml`.
2. **`images` job** (gated only by `vars.ENABLE_DEPLOY_AWS=true`): builds + Trivy-scans + SBOMs +
   **cosign keyless-signs** `argus-api` and `argus-ingress` to GHCR.
3. **`deploy` job**: pauses at the **`aws-experiment`** Environment (required reviewer = you,
   1-min wait timer). On approval: GitHub OIDC → AWS IAM, bundles the exact-SHA infra files,
   SSM-runs `infra/stack/deploy/deploy.sh` on the box.
4. `deploy.sh` (root, on the box): fetch KV secrets via Arc → cosign-**verify** images →
   start Postgres/Redis → run migrations (owner DSN) → provision role logins → arm backup/
   cleanup/audit-prune timers → bring up the full stack → health-gate every service.

`deploy.sh` is **fail-closed**: a missing mandatory KV secret or an unset required var aborts the
whole rollout before the app starts.

## Release safety controls (Terraform state + approval gate)

Two standing controls protect **every** release on this AWS path (Track 3 ops-hardening — both already
active here; this section is the reference + how-to-verify, plus the deferred Azure twin).

**1. Remote, locked Terraform state.** `infra/aws/terraform/versions.tf` uses `backend "s3" {}` — the
**default** for the real AWS deploy: encrypted, versioned, DynamoDB-locked S3 state that survives laptop
loss and blocks a concurrent `apply`. One-time bootstrap (already done if `backend.hcl` exists):
`make -C infra/aws bootstrap` creates the bucket + lock table and writes `backend.hcl`, then
`terraform -chdir=infra/aws/terraform init -backend-config=backend.hcl` (see
[`infra/aws/terraform/README.md`](../../../infra/aws/terraform/README.md)).

- **Verify:** `terraform -chdir=infra/aws/terraform state list` reads from S3; a fresh clone with no local
  `.terraform/` can `init -backend-config=backend.hcl` and `plan` with **no diff**.
- **Why it matters:** with local/stale state plus a live box, `terraform apply` can try to **re-create the
  running host**. Remote + locked state removes that single point of failure.

**2. Per-release human approval.** The `deploy` job in `cd-aws.yml` is gated twice — the
`vars.ENABLE_DEPLOY_AWS` master kill-switch **and** `environment: aws-experiment` (line 126). The
`aws-experiment` GitHub Environment carries **required reviewers** (✅ in the pre-flight above), so each
`aws-v*` tag **pauses for your approval before the root SSM command runs**. The IAM deploy role's OIDC trust
is bound to that exact environment subject —
`repo:OWNER/REPO:environment:aws-experiment` (`infra/aws/terraform/iam.tf:102`,
`var.github_deploy_environment`) — so **only a job running in the `aws-experiment` environment can assume the
deploy role**, and entering that environment requires reviewer approval. The binding is to the environment +
its approval gate, **not** to a branch/tag — any workflow that runs in `aws-experiment` mints the same
subject — so keep the environment's protection rules (including any branch/tag restrictions) in place.

- **Verify:** push a throwaway `aws-v*` tag (with `ENABLE_DEPLOY_AWS=true`) → the run builds images, then
  the `deploy` job sits in **"Waiting"** on `aws-experiment` until you approve; an unapproved run never
  reaches `aws ssm send-command`.

> **Azure twin (deferred — not the live deploy path).** The single-Azure-VM path
> (`infra/azure/terraform`, `cd.yml`) mirrors both controls but is **not armed**:
> `infra/azure/terraform/versions.tf:15-23` still has the `backend "azurerm"` block **commented** (local
> state), and `cd.yml`'s `environment: prod` (line 130) + `var.github_deploy_subject` still need the same
> required-reviewer config. Activate both only when/if the Azure VM is armed: create the tfstate RG
> `argus-tfstate` / storage account `argustfstate` / container `tfstate` out-of-band, uncomment the block,
> `terraform init -migrate-state`; and set required reviewers on the `prod` environment with the OIDC subject
> bound to `repo:OWNER/REPO:environment:prod`.

---

## Pre-flight checklist

### ✅ Already done (verify, don't redo)
- `ENABLE_DEPLOY_AWS = true`; AWS role/region/instance/KV-name vars set; S3 (attachment) vars set.
- `aws-experiment` env exists with required reviewer + wait timer.
- Fresh-deploy infra bugs fixed (PR #208 — ASCII SG description + Arc RP registration).
- Cloudflare tunnel ingress + `/admin` Access gate applied (`cloudflare-terraform/4rgus.tf`).
- Arc machine `argus-exp-ec2` onboarded with KV Secrets User.

### 🔴 Blockers — must be green before tagging

**1. Three missing GitHub repo vars.** `cd-aws.yml` passes these to the box; `deploy.sh` FATALs at
the backup-arming step without them. Set:

```bash
gh variable set BACKUP_S3_BUCKET     -R Dezoxy/secmes --body "db-q7m2z9x4v6n8p3k1"   # private db-backups bucket (known)
gh variable set B2_APP_KEY_ID        -R Dezoxy/secmes --body "<db-backups key-id>"    # from B2 console; pairs with KV argus-b2-app-key
gh variable set BACKUP_AGE_RECIPIENT -R Dezoxy/secmes --body "age1<...>"              # age PUBLIC key; its matching PRIVATE key MUST be in KV (blocker 2) or backups are unrecoverable
```

**2. Verify the mandatory KV secrets that post-date the original populate run** (likely absent):
`argus-session-signing-key` (passkey session JWT — without it the API won't boot),
`argus-backup-signing-key` (signed backups), and **`argus-backup-age-key`** — the age **PRIVATE**
key matching the `BACKUP_AGE_RECIPIENT` public key from blocker 1. Also confirm `argus-b2-app-key`
(db-backups) and `argus-ghcr-token` (now mandatory — the GHCR images are private, so the box needs a
`read:packages` PAT to pull them).

> ⚠️ **Data-loss blocker — the age keypair.** `populate-keyvault.sh` does **not** create the age key.
> If backups are armed with a `BACKUP_AGE_RECIPIENT` whose matching private key was never stored as
> `argus-backup-age-key`, every nightly backup is encrypted to a key you cannot decrypt — permanently
> unrecoverable. Generate the pair **once** (`age-keygen -o age.key` → the `age1…` line is the public
> recipient), set that public key as `BACKUP_AGE_RECIPIENT`, store the private key as KV
> `argus-backup-age-key`, and confirm the two halves are the same keypair **before tagging**. The
> restore runbook (`infra/backup/README.md`) fetches `argus-backup-age-key` to decrypt.

The vault firewall (`Deny` default) only allows the EC2 EIP and one old IP, so to inspect/populate
you must allow your current IP first:

```bash
MYIP=$(curl -s https://api.ipify.org)
az keyvault network-rule add --name argus-exp-kv-4ad322 --ip-address "$MYIP"

az keyvault secret list --vault-name argus-exp-kv-4ad322 \
  --query "[?contains(name,'signing') || name=='argus-b2-app-key' || name=='argus-backup-age-key' || name=='argus-ghcr-token'].name" -o tsv

# populate.sh GENERATES the signing keys and PROMPTS for the external creds (argus-b2-app-key,
# argus-ghcr-token). Set the vault name explicitly — its terraform-output fallback is flaky from a laptop:
ARGUS_KEY_VAULT=argus-exp-kv-4ad322 ./infra/aws/scripts/populate-keyvault.sh # gitleaks:allow — vault NAME, not a secret

# The list above checks NAMES only. Terraform SEEDS external secrets with "REPLACE-…" placeholders, and
# populate.sh skips an existing name without --rotate — so a placeholder (e.g. the GHCR token) looks "present"
# but breaks `docker login` for the now-private images. Find any placeholder/empty external cred by VALUE:
for s in argus-ghcr-token argus-b2-app-key argus-s3-secret-access-key argus-tunnel-token \
         argus-session-signing-key argus-backup-signing-key; do
  v=$(az keyvault secret show --vault-name argus-exp-kv-4ad322 --name "$s" --query value -o tsv --only-show-errors 2>/dev/null)
  case "$v" in REPLACE*|"") echo "  placeholder/empty: $s — must be replaced before tagging";; esac
done
# Re-enter any placeholder external cred (incl. the GHCR read:packages PAT) the SAFE way — populate --rotate
# re-prompts (read -rsp) and writes via a 0600 temp file + --file, never on argv or in shell history. On a
# FIRST deploy nothing is running yet so --rotate is harmless; post-deploy it needs a redeploy to take effect.
ARGUS_KEY_VAULT=argus-exp-kv-4ad322 ./infra/aws/scripts/populate-keyvault.sh --rotate # gitleaks:allow — vault NAME, not a secret

# CAUTION — set-once signing keys: argus-backup-signing-key is SET-ONCE; populate SKIPS it even under --rotate
# (rotating it would orphan the git-pinned verifier infra/backup/backup-verify.pub). If the scan flagged it as a
# "REPLACE-…" placeholder, argus-secrets.service still succeeds (value is non-empty) but the nightly backup
# preflight rejects the unusable key → NO signed backups. A dummy-seeded set-once secret can't be promoted in
# place: provision it together with its matching backup-verify.pub per the signed-backups setup (infra/backup/),
# or recreate the vault (bump var.prefix). Same applies to a placeholder argus-session-signing-key (API won't boot).

# The age key is NOT created by populate.sh — set it explicitly from the keypair generated in blocker 1,
# or restore is impossible. (age.key holds the AGE-SECRET-KEY line; restore writes it back and runs `age -i`.)
# `-o none --only-show-errors`: `az keyvault secret set` echoes the secret VALUE by default (Azure CLI
# #20858), which would print the age private key to your terminal scrollback / run logs — suppress it.
# First confirm the local private key's PUBLIC half equals the recipient backups are encrypted to — a mismatched
# pair means backups go to a key whose private half you never stored (unrecoverable). Then upload and VERIFY
# before deleting the local copy: the shred is gated on the keypair matching AND the upload succeeding AND a
# read-back showing a usable age key, so a wrong/failed upload can't leave you with only an unusable key.
# `-o none`/grep-over-pipe keep the key off the terminal; keep an offline password-manager copy as a break-glass.
pub_local=$(age-keygen -y age.key)                                                      # derive public key from the private key
recipient=$(gh api repos/Dezoxy/secmes/actions/variables/BACKUP_AGE_RECIPIENT --jq .value 2>/dev/null)
if [ -n "$pub_local" ] && [ "$pub_local" = "$recipient" ] \
   && az keyvault secret set --vault-name argus-exp-kv-4ad322 --name argus-backup-age-key --file age.key --only-show-errors -o none \
   && az keyvault secret show --vault-name argus-exp-kv-4ad322 --name argus-backup-age-key \
        --query value -o tsv --only-show-errors | grep -q 'AGE-SECRET-KEY'; then
  shred -u age.key 2>/dev/null || rm -P age.key   # keypair matches + uploaded + read back OK → remove local copy
else
  echo "FATAL: age keypair mismatch or upload/verify failed — KEEP age.key; do NOT tag until BACKUP_AGE_RECIPIENT == age-keygen -y age.key"
fi

az keyvault network-rule remove --name argus-exp-kv-4ad322 --ip-address "$MYIP"   # re-tighten when done
```

> `populate-keyvault.sh` rotation model: set-once secrets (Postgres/Grafana/GlitchTip passwords,
> etc.) are first-init-only; only argus_app/redis-style secrets reconcile on `--rotate`. The clean
> way to promote a dummy-seeded vault is a fresh vault (bump `var.prefix`).

### 🟡 Non-blockers (do, but they don't gate the first deploy)
- **Delete the 5 dead OIDC vars** — `OIDC_ISSUER`, `OIDC_AUDIENCE`, `VITE_OIDC_ISSUER`,
  `VITE_OIDC_CLIENT_ID`, `VITE_OIDC_REDIRECT_URI`. Nothing reads them since the passkey pivot.
- **`infra/backup/backup-verify.pub`** is still the `REPLACE_WITH_` placeholder → nightly backups
  *write & sign* fine, but *restore* fails closed until the real public half is committed. Fix
  before relying on restore (see `infra/backup/README.md`).
- **B2 Object Lock console step (BKP-2)** still pending → backups aren't WORM-immutable yet
  (see `infra/b2/README.md`).

---

## Go-live sequence

```bash
# 0. blockers 1–2 above are green
git checkout main && git pull

# 1. tag + push — images build immediately; the deploy job waits for your approval
git tag aws-v0.1.0 && git push origin aws-v0.1.0

# 2. approve the run in the aws-experiment environment (GitHub UI), then watch
gh run watch -R Dezoxy/secmes \
  "$(gh run list -R Dezoxy/secmes --workflow cd-aws.yml -L1 --json databaseId -q '.[0].databaseId')"
```

If the SSM step fails, the cause is in the command output. Most likely, in order: a missing KV
secret (404 fail-closed), Arc HIMDS unreachable, or one of the three vars still empty.

## Post-deploy smoke test
1. Load `https://4rgus.com` → register a passkey → sign in.
2. Confirm Cloudflare Access gates the **whole** admin surface, not just the page: `https://4rgus.com/admin`
   prompts Access **and** the admin API paths `/api/auth/breakglass/*` and `/api/admin/*` are covered (the
   prod Caddyfile rejects those without a `Cf-Access-Jwt-Assertion` header). Best check: complete a real
   breakglass login through Access end-to-end, not just the page load.
3. Confirm `https://grafana.4rgus.com` loads (admin password = KV `argus-grafana-admin-password`).
4. On the box: `docker compose -f /opt/argus/compose.prod.yaml ps` — every service healthy/running.

## First-deploy failure points (quick reference)

| Symptom (SSM stderr) | Cause | Fix |
|---|---|---|
| `… required` (BACKUP_AGE_RECIPIENT / B2_APP_KEY_ID / BACKUP_S3_BUCKET) | var unset | set the three GitHub vars |
| `'argus-session-signing-key' is missing or empty` | mandatory KV secret not provisioned | run `populate-keyvault.sh` |
| `Arc HIMDS unreachable` | Arc agent disconnected | `az connectedmachine show -n argus-exp-ec2 -g argus-exp-rg --query status` → Connected |
| KV fetch `403 Forbidden` | Arc identity lacks KV read | re-apply Terraform phase 2 (KV role grant) |
| `cosign verify` fails | tag overwritten / identity mismatch | don't reuse tags; tag a fresh `aws-v0.1.1` |
| Postgres/API healthcheck timeout | cold first boot | re-run the deploy (idempotent); widen healthcheck window if persistent |
| `S3_BUCKET … != ATTACHMENT_BUCKET` | var ≠ Caddyfile CSP pin | keep `S3_BUCKET=attachment-r8xq4m7z2p9n6k3v` |

## Operational notes
- AWS creds resolve via a `login`-type broker the Terraform/CLI AWS provider can't see — prefix
  AWS-touching commands with `eval "$(aws configure export-credentials --format env)"`.
- Cloudflare WARP (local resolver `127.0.2.2`) can DNS-sinkhole `s3.eu-central-1.amazonaws.com`
  and `vault.azure.net`; they're allow-listed in the cloudflare-terraform lists module.
- The account is on the AWS Free plan ($200 credits, expires 2026-12-11) → `instance_type` is
  `c7i-flex.large` (free-tier-eligible) in `real.tfvars`, not `t3.medium`.
- Still on AWS **root** creds — migrate to IAM/SSO and delete root keys before going beyond the experiment.
