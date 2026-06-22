# Secrets inventory

Every **secret** the argus deployment depends on: what it protects, who reads it
and when, how it is delivered, and what happens if it leaks or is lost.

> **This file lists secret NAMES and semantics only — never a secret value.**
> Non-secret companions (bucket names, access-key *ids*, ARNs, the age *public*
> key) are catalogued in [`config-inventory.md`](config-inventory.md). Gitleaks
> runs on every commit and enforces the no-values rule. The repo is public;
> knowing a secret's *name* grants nothing — the defence is Key Vault + the Arc
> managed identity + the vault firewall, not obscurity.
>
> Scope: the **AWS-EC2 experiment** deploy path (`infra/aws/`, `cd-aws.yml`).
> Source of truth: `infra/aws/terraform/keyvault.tf`,
> `infra/aws/scripts/populate-keyvault.sh`, `infra/stack/deploy/deploy.sh`,
> `infra/backup/README.md`, `docs/threat-models/db-backup.md`.

## 0. Where secrets live and how they reach the box

All runtime secrets live in **Azure Key Vault** `argus-exp-kv-4ad322` (vault name
pattern `${var.prefix}-kv-<sha1[:6]>`, experiment prefix `argus-exp`). The EC2 box
holds **no stored Azure credential**:

- At boot, `argus-secrets.service` (`infra/stack/secrets/fetch-keyvault-secrets.sh`)
  obtains a **short-lived Key Vault bearer token from the Azure Arc HIMDS** local
  endpoint (`http://localhost:40342/...`, challenge-token handshake) — the box's
  **Arc Managed Identity** (`ARGUS_TOKEN_SOURCE=arc`). It writes each secret to
  `/run/argus/secrets/` on **tmpfs** (`0444` files inside a `0700` dir).
- The stack consumes secrets as **mounted credential files** via `*_FILE` env vars
  (the value never appears in env — invariant #5), or via systemd `LoadCredential`
  for the host-side worker units.
- Three secrets are fetched **deploy-transiently** by `deploy.sh` (used, then
  shredded/logged-out — never persisted): `argus-migration-database-url`,
  `argus-ghcr-token`, `argus-b2-cors-app-key`.
- The KV firewall additionally binds data-plane access to the EC2 Elastic IP.

**No long-lived cloud credential exists anywhere on the box or in any env file.**

## 1. Signing keys (token + backup authenticity)

| Secret | Purpose | Consumer | Origin | Lifecycle |
|---|---|---|---|---|
| `argus-session-signing-key` | Ed25519 (PKCS8 PEM) key that signs Phase-1 session JWTs | API container at boot (`SESSION_SIGNING_KEY_FILE`), re-read on start | `populate.sh` generates (`openssl genpkey -algorithm Ed25519`); TF seeds a `REPLACE-` placeholder | **Rotatable** — rotating just invalidates live sessions (re-login) |
| `argus-backup-signing-key` | Ed25519 key that signs each nightly DB-backup manifest so restore can prove provenance | `argus-db-backup.service` (`LoadCredential` → `BACKUP_SIGN_KEY_FILE`) at the nightly run | `populate.sh` generates **set-once**; TF seeds `REPLACE-` placeholder | **SET-ONCE** — its public verifier is pinned in git (`infra/backup/backup-verify.pub`); `--rotate` SKIPS it. Rotation = coordinated keyring (keep the old public block until no live backup uses it) |

**Blast radius.** *Session key leaked* → attacker forges session tokens (full
account impersonation); rotate and all users re-auth. *Backup key leaked* → a
host-root attacker could forge a validly-signed backup; it does **not** decrypt
anything. Losing either private key is not a data-loss event (the age key is what
decrypts).

## 2. Database passwords & DSNs

| Secret | Purpose | Consumer | Origin | Lifecycle |
|---|---|---|---|---|
| `argus-postgres-owner-password` | Postgres superuser/owner (`argus`) password | Postgres container at **first init** (`POSTGRES_PASSWORD_FILE`) | `put_once` (32 alnum); TF generates | **SET-ONCE** — first-init only; rotating in KV breaks migration auth (DR-only) |
| `argus-migration-database-url` | Owner DSN used to run migrations before serving | `deploy.sh` fetches it deploy-transiently, stages 0400 on tmpfs, runs migrations, then `shred`s it | Derived in `populate.sh` from the set-once owner password | **SET-ONCE** (tracks the owner password) |
| `argus-database-url` | App DSN with the dedicated **`argus_app`** password — the non-bypass, RLS-bound runtime role | API at boot (`DATABASE_URL_FILE`); `deploy.sh` parses the password and `ALTER ROLE argus_app … PASSWORD` each deploy | `populate.sh` `put` (own 32-alnum password) | **Rotatable** — deploy re-applies the login |
| `argus-glitchtip-db-password` | GlitchTip's dedicated Postgres owner password | `glitchtip-db` at first init. **Fetch-mandatory** in KV even though the GlitchTip container is skipped on the lean box (`ARGUS_SKIP_GLITCHTIP=1`) | `put_once`; TF generates | **SET-ONCE** |
| `argus-backup-db-password` | (legacy) `argus_backup` login password | **VESTIGIAL** — worker now uses in-container local trust; `deploy.sh` sets the role `PASSWORD NULL` | `put`; TF generates | Inert (retirement is a tracked follow-up) |
| `argus-cleanup-db-password` | (legacy) `argus_cleanup` login password | **VESTIGIAL** — same as above | `put`; TF generates | Inert |

> `redis_url` and `glitchtip_database_url` are DSNs **derived on the box** by
> `deploy.sh`, not stored in KV.

## 3. Cache / realtime backplane

| Secret | Purpose | Consumer | Origin | Lifecycle |
|---|---|---|---|---|
| `argus-redis-password` | Redis `requirepass` (realtime presence/pub-sub AUTH) | `deploy.sh` derives `redis.conf` + `redis_url` from it; API via `REDIS_URL_FILE`; re-read each boot | `put` (32 alnum, URL-unreserved only); TF generates | **Rotatable** — deploy force-recreates redis + api to pick it up |

## 4. Object-storage keys (Backblaze B2)

| Secret | Purpose | Consumer | Origin | Lifecycle |
|---|---|---|---|---|
| `argus-s3-secret-access-key` | **attachment** bucket secret key (API presigns up/downloads; reused by attachment-cleanup) | API at boot (`S3_SECRET_ACCESS_KEY_FILE`); `argus-attachment-cleanup.service` (`LoadCredential`) | `put_external` (prompted); TF seeds `REPLACE-` placeholder | **Rotatable** (re-mint in B2 → KV → redeploy) |
| `argus-b2-app-key` | **db-backups** bucket app key — a *separate* key, re-minted **without delete** (WORM/Object-Lock) | `argus-db-backup.service` (`LoadCredential`, paired with `B2_APP_KEY_ID`) at the nightly run | `put_external` (prompted); TF seeds `REPLACE-` placeholder | **Rotatable** |
| `argus-b2-cors-app-key` | CORS-only key, bucket-restricted to the attachment bucket | `deploy.sh` step 6c fetches it deploy-transiently; only when `B2_CORS_KEY_ID` is set | `put_external` (prompted); TF seeds `REPLACE-` placeholder | **Rotatable** |

**Blast radius.** Attachment blobs are E2EE ciphertext — a leaked attachment key
exposes ciphertext only. The db-backups key has **no delete** capability, so a
leak can write shadow/forged versions but cannot scrub WORM-locked backups
(signing + Object-Lock defend restore).

## 5. Infra tokens (registry + ingress)

| Secret | Purpose | Consumer | Origin | Lifecycle |
|---|---|---|---|---|
| `argus-ghcr-token` | GitHub `read:packages` PAT — pulls the private signed images from GHCR | `deploy.sh` fetches it deploy-transiently → `docker login --password-stdin` → `docker logout` on exit | `put_external` (prompted); TF seeds `REPLACE-` placeholder | **Rotatable** |
| `argus-tunnel-token` | Cloudflare Tunnel token — the **only** ingress (no inbound ports) | `cloudflared` container (`TUNNEL_TOKEN_FILE`); `deploy.sh` force-recreates the tunnel on change | `put_external` (prompted); TF seeds `REPLACE-` placeholder | **Rotatable** |

**Blast radius.** A leaked tunnel token lets an attacker stand up the tunnel /
intercept ingress routing — high impact; rotate in Cloudflare immediately. A lost
tunnel token makes the site unreachable until re-supplied.

## 6. Observability

| Secret | Purpose | Consumer | Origin | Lifecycle |
|---|---|---|---|---|
| `argus-grafana-admin-password` | Grafana admin login | Grafana at **first init** (`GF_SECURITY_ADMIN_PASSWORD__FILE`) | `put_once` (24 alnum); TF generates | **SET-ONCE** — Grafana stores it in its own DB; rotating in KV has no effect on the live UI |
| `argus-glitchtip-secret-key` | GlitchTip Django `SECRET_KEY` (session signing) | GlitchTip via env each boot. **Fetch-mandatory** in KV — the container is skipped on the lean box but the boot fetch still requires the secret present | `put` (50 alnum); TF generates | **Rotatable** |

Both expose **metadata/metrics only — never message content** (invariant #6).

## 7. Backup-encryption (age) — the highest-stakes secret

| Secret | Purpose | Consumer | Origin | Lifecycle |
|---|---|---|---|---|
| `argus-backup-age-key` | the age **private** key (an `AGE-SECRET-KEY` line) — the **only** thing that decrypts nightly DB backups | **Restore only**, fetched from KV by a human operator on a trusted host; never written to the box's disk and never read by a service | Hand-generated once (`age-keygen`), uploaded to KV, local copy shredded. **Not** created by `populate.sh`, **not** seeded by `keyvault.tf` | **SET-ONCE** (operationally — it is the recipient of every backup already written) |

> ⚠️ **If LOST: every backup is permanently unreadable** — the single hardest-loss
> secret in the system. Mitigation: an **offline break-glass copy** in a password
> manager (the operator's job at generation time) + KV soft-delete / purge-protection.
> Its public half rides as the non-secret `BACKUP_AGE_RECIPIENT` (see
> [`config-inventory.md`](config-inventory.md)). **If LEAKED:** anyone can decrypt
> every backup → full metadata/PII exposure.
>
> 🔓 **Access caveat — this is not a hard boundary.** The nightly *write* path needs
> only the public recipient; the private key is never written to the box's disk and
> only the *restore* flow reads it. **But** the box's Arc managed identity holds
> **vault-wide** `Key Vault Secrets User` (`infra/aws/terraform/arc.tf`), so a
> compromised host can mint the MI token and fetch `argus-backup-age-key` *by name* —
> "not on the box" means not on disk, **not** beyond the box identity's reach. This
> weakens backup confidentiality against a **host compromise** (a B2-only compromise
> is still defended — that attacker has no MI token). Proper posture for real data:
> keep this key **offline only**, or in a **separate vault / principal the runtime
> identity cannot read** (or per-secret RBAC). The threat model
> (`docs/threat-models/db-backup.md`) frames "never on the backup host" as on-disk
> presence — it does not yet address identity-readability; tracked there.

## 8. Arming / optional secrets — seeded EMPTY until provisioned

The `OPTIONAL_SECRETS` set in `fetch-keyvault-secrets.sh`: if absent, a `0444` **empty**
file is seeded so the compose mount still resolves and the consumer runs **degraded**
(never fatal). Source of truth — do not invent entries here.

| Secret | Behaviour while empty |
|---|---|
| `argus-sentry-dsn` | GlitchTip/Sentry write-only ingest DSN (created in the GlitchTip UI after first deploy). API error-reporting is a no-op until set. |
| `argus-admin-bootstrap-hash` | Argon2id hash (JSON) for the emergency **breakglass** admin login (`pnpm --filter @argus/api generate-admin-hash`). Absent ⇒ `/auth/breakglass/login` returns 503; the rest of the API is unaffected. See `docs/threat-models/breakglass-admin.md`. |
| `argus-backup-db-password`, `argus-cleanup-db-password` | **Vestigial** (see §2) — kept in the OPTIONAL set so they can be deleted from KV without bricking boot (the worker roles are password-less). |

(Cloudflare Access uses non-secret env `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD` — no
secret introduced. Stripe / operator-API integrations, if ever added, are app-level and
**not** part of this deploy's Key Vault fetch set.)

## 9. Zitadel (full-stack only — NOT on the lean experiment box)

These appear in the broader stack secret model (`docs/architecture/deploy.md`,
`infra/stack/secrets/`) but are **not** in the AWS experiment's `keyvault.tf` seed
or `populate.sh`. Listed for completeness; provision by hand if the experiment
ever runs Zitadel: `argus-zitadel-masterkey` (**set-once, data-loss if lost**),
`argus-zitadel-db-password` (set-once), `argus-zitadel-admin-password`
(first-init only), `argus-zitadel-login-pat` (rotatable).

## 10. Operator reference

### Mandatory to boot (the stack won't reach healthy without these)
The boot fetch (`fetch-keyvault-secrets.sh`) reads its `SECRETS[]` set
**unconditionally** — a 404 on any of these fails the boot closed:
`argus-session-signing-key`, `argus-backup-signing-key`, `argus-database-url`,
`argus-postgres-owner-password`, `argus-redis-password`, `argus-tunnel-token`,
`argus-s3-secret-access-key`, `argus-b2-app-key`, `argus-grafana-admin-password`,
`argus-glitchtip-db-password`, `argus-glitchtip-secret-key`. Plus the
deploy-transient `argus-migration-database-url` and `argus-ghcr-token` (fetched by
`deploy.sh`, not the boot fetch, but still required to deploy).

> The three Grafana/GlitchTip secrets are **fetch-mandatory (must exist in KV)**
> even though `ARGUS_SKIP_GLITCHTIP=1` stops the GlitchTip *containers* on the lean
> box — `populate.sh` + Terraform provision them, so they are present (Grafana
> itself does run on the lean box).

### Optional / conditional
`argus-b2-cors-app-key` (only if `B2_CORS_KEY_ID` set); `argus-backup-age-key`
(restore only — never in the boot fetch — but catastrophic if lost); the arming
set (§8) and Zitadel set (§9).

### ⚠️ The set-once placeholder trap
Set-once secrets are burned at a component's **first init** (or pinned out-of-band)
and never reconciled — `populate.sh` SKIPS them even under `--rotate`. If a
set-once secret (`argus-session-signing-key`, `argus-backup-signing-key`, the
Postgres/GlitchTip owner passwords, the Grafana admin password) was seeded as a
`REPLACE-` placeholder **and a component already initialised against it**, you
**cannot promote it in place**. Recovery = **recreate the vault by bumping
`var.prefix`** (which changes the vault name) so a clean vault is seeded before any
component initialises. This is why the deploy runbook scans for `REPLACE-`
placeholders *before* tagging.

### No long-lived cloud creds
Azure access from the box is entirely via the **Arc Managed Identity** — an
ephemeral KV bearer token per fetch, no client secret, nothing long-lived stored.
AWS access from CI is via **GitHub OIDC → STS** (temporary role credentials), no
stored AWS keys. See [`config-inventory.md`](config-inventory.md) §3.
