# AWS first-deploy runbook (experiment path)

Operational checklist for the **first** production rollout of argus to the AWS EC2
experiment box. This is the AWS path (`infra/aws/`, `cd-aws.yml`, the `aws-experiment`
GitHub Environment) — **not** the canonical single-Azure-VM path described in
[`docs/deploy.md`](../deploy.md), which stays the authoritative reference for topology,
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
# If any are missing, the idempotent populate script fills them (set the vault name explicitly —
# its terraform-output fallback is flaky from a laptop):
ARGUS_KEY_VAULT=argus-exp-kv-4ad322 ./infra/aws/scripts/populate-keyvault.sh # gitleaks:allow — vault NAME, not a secret

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
