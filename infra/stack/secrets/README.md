# Key Vault → credential files (Slice 3)

The boot-time step that turns Azure Key Vault secrets into on-VM **credential files**, using the VM's
**Managed Identity** — no static credentials, nothing committed. This is the "separate fetch step" the
backup/cleanup units already reference. Threat model: [`docs/threat-models/vm-secrets.md`](../../../docs/threat-models/vm-secrets.md).

> **Status: build-only.** This provides the script + unit + wiring. Installing/enabling it on the VM (with the
> real Key Vault name templated in) is the Slice-4 deploy (`az vm run-command`). Nothing here is deployed.

## How it works

```
boot ─▶ argus-secrets.service ─▶ fetch-keyvault-secrets.sh
          IMDS (Managed Identity) → token → Key Vault REST → /run/argus/secrets/<file>  (tmpfs, 0444 root, in a 0700 dir)
```

`fetch-keyvault-secrets.sh` gets a Managed-Identity token from IMDS (`169.254.169.254`), reads each secret
from `https://<vault>.vault.azure.net`, and writes it atomically to `/run/argus/secrets/` (tmpfs, `0444`
root inside a `0700` root dir — `0444` so the non-root container users can read the bind-mounted Compose
secrets; the `0700` dir is the confinement boundary). It logs secret **names + status only**, never values,
and **fails closed** (any error exits non-zero;
consumers `Requires=` this unit, so they don't start on a missing secret).

## Secrets it delivers

| Key Vault secret name           | Local file (`/run/argus/secrets/`) | Consumer                                            |
| ------------------------------- | ---------------------------------- | --------------------------------------------------- |
| `argus-postgres-owner-password` | `postgres_password`                | `postgres` (`POSTGRES_PASSWORD_FILE`) — owner/init  |
| `argus-database-url`            | `database_url`                     | `api` (`DATABASE_URL_FILE`) — **`argus_app` DSN**   |
| `argus-s3-secret-access-key`    | `s3_secret_access_key`             | `api` (`S3_SECRET_ACCESS_KEY_FILE`) — B2 attachments|
| `argus-redis-password`          | `redis_password`                   | `redis` (`requirepass` via the deploy-generated `redis.conf`; healthcheck reads this file) + `api` (`REDIS_URL_FILE`, deploy-generated `redis_url`) — never in env; must be URL-safe (e.g. `openssl rand -hex 32`) |
| `argus-tunnel-token`            | `tunnel_token`                     | `cloudflared` (`TUNNEL_TOKEN_FILE` — file-secret mount, not env) |
| `argus-session-signing-key`     | `session_signing_key`              | `api` (`SESSION_SIGNING_KEY_FILE`) — Ed25519 PEM signing passkey session JWTs (**mandatory**) |
| `argus-backup-signing-key`      | `backup-signing-key`               | `argus-db-backup` (`LoadCredential`) — Ed25519 PEM signing nightly backup objects (**mandatory**) |
| `argus-grafana-admin-password`  | `grafana_admin_password`           | `grafana` (`GF_SECURITY_ADMIN_PASSWORD__FILE`) — observability dashboards admin login |
| `argus-backup-db-password`      | `backup-db-password`               | `argus-db-backup` (`LoadCredential`) — `argus_backup` role |
| `argus-cleanup-db-password`     | `cleanup-db-password`              | `argus-attachment-cleanup` (`LoadCredential`) — `argus_cleanup` role |
| `argus-b2-app-key`              | `b2-app-key`                       | `argus-db-backup` + `argus-attachment-cleanup` (`LoadCredential`) |

> `database_url` MUST be the non-bypass **`argus_app`** DSN (`postgres://argus_app:<pw>@postgres:5432/argus`),
> never the `argus` owner — least privilege so RLS/grants bind even off the `SET LOCAL ROLE` path. The owner
> password (`argus-postgres-owner-password`) is for init + migrations only.
>
> `argus-session-signing-key` is the Ed25519 PKCS8 PEM key the API uses to sign passkey session JWTs. It is
> **mandatory** — the fetch fails closed if it's absent, and the API will not boot without it. Generate it
> ONCE: `openssl genpkey -algorithm ed25519 | openssl pkcs8 -topk8 -nocrypt -outform PEM`.
>
> `argus-backup-signing-key` is a separate Ed25519 PKCS8 PEM key the nightly DB-backup worker uses to **sign**
> each backup object so restore can verify provenance (signed backups — BKP-2 follow-up). It is **mandatory**
> for the same fail-closed reason. After creating it, derive and commit its **public** half to
> `infra/backup/backup-verify.pub` (restore reads the verify key from git, not the bucket). See
> [`infra/backup/README.md`](../../backup/README.md) §"Backup signing key".

### Deploy-time secrets (fetched by `deploy.sh`, NOT delivered to the running stack)

The CD rollout (`infra/stack/deploy/deploy.sh`, Slice 4) fetches two extra secrets via the Managed Identity,
uses them, and drops them — they are **never** written to `/run/argus/secrets` (least privilege: the running
stack never holds a GitHub token or the DB owner DSN):

| Key Vault secret name          | Used for                                                              |
| ------------------------------ | -------------------------------------------------------------------- |
| `argus-ghcr-token`             | `docker login ghcr.io` to pull the signed images (`packages:read`)   |
| `argus-migration-database-url` | the **owner** DSN for migrate-before-serve (`MIGRATION_DATABASE_URL_FILE`) — file-mounted, then `shred`-ed |

## Populate the vault (one-time, by you)

The VM's Managed Identity has **Key Vault Secrets User** (read-only) from `infra/azure/terraform`. You set the
values out-of-band — they never touch the repo:

```bash
KV="$(terraform -chdir=infra/azure/terraform output -raw key_vault_name)"
az keyvault secret set --vault-name "$KV" --name argus-postgres-owner-password --value '<owner-pw>'
az keyvault secret set --vault-name "$KV" --name argus-database-url           --value 'postgres://argus_app:<pw>@postgres:5432/argus'
az keyvault secret set --vault-name "$KV" --name argus-s3-secret-access-key   --value '<b2-attachment-key-secret>'
# Redis AUTH — URL-safe (it rides in the deploy-generated redis_url `redis://:<pw>@redis:6379` + a redis.conf requirepass line).
az keyvault secret set --vault-name "$KV" --name argus-redis-password        --value "$(openssl rand -hex 32)"
az keyvault secret set --vault-name "$KV" --name argus-tunnel-token           --value '<cloudflare-tunnel-token>'
# MANDATORY Ed25519 signing keys — session (passkey JWTs; the API won't boot without it) and backup (signs
# nightly dumps; the boot-time fetch fails closed without it). Generate each to a 0600 temp file and set via
# --file so the PEM private key NEVER appears on argv (/proc/<pid>/cmdline) — matching populate-keyvault.sh
# (invariant #2/#5). The `--value "$(…)"` form would leak the key while `az` runs.
umask 077
for s in argus-session-signing-key argus-backup-signing-key; do
  f="$(mktemp)"; openssl genpkey -algorithm ed25519 | openssl pkcs8 -topk8 -nocrypt -outform PEM >"$f"
  az keyvault secret set --vault-name "$KV" --name "$s" --file "$f" --encoding utf-8
  shred -u "$f" 2>/dev/null || rm -P "$f" 2>/dev/null || rm -f "$f"   # portable secure delete
done
# Then commit argus-backup-signing-key's PUBLIC half to infra/backup/backup-verify.pub:
#   az keyvault secret show --vault-name "$KV" --name argus-backup-signing-key --query value -o tsv | openssl pkey -pubout
az keyvault secret set --vault-name "$KV" --name argus-grafana-admin-password --value '<grafana-admin-pw>'   # observability #47
az keyvault secret set --vault-name "$KV" --name argus-backup-db-password     --value '<argus_backup-role-pw>'
az keyvault secret set --vault-name "$KV" --name argus-cleanup-db-password    --value '<argus_cleanup-role-pw>'
az keyvault secret set --vault-name "$KV" --name argus-b2-app-key             --value '<b2-key-secret>'

# Deploy-time only (consumed by deploy.sh, never delivered to the running stack):
az keyvault secret set --vault-name "$KV" --name argus-ghcr-token            --value '<github-PAT-with-packages:read>'
az keyvault secret set --vault-name "$KV" --name argus-migration-database-url --value 'postgres://argus:<owner-pw>@postgres:5432/argus'
```

Set values **without a trailing newline** (the fetch strips one defensively, but `az ... --value` is exact).

## Install + enable (Slice-4 deploy does this)

```bash
install -d /opt/argus/secrets
install -m 0755 infra/stack/secrets/fetch-keyvault-secrets.sh /opt/argus/secrets/
install -m 0644 infra/stack/secrets/argus-secrets.service /etc/systemd/system/
# Template the real vault name into the unit (the deploy reads the TF output):
sed -i "s/REPLACE_WITH_KEY_VAULT_NAME/$KV/" /etc/systemd/system/argus-secrets.service
systemctl daemon-reload
systemctl enable --now argus-secrets.service
```

Then the stack + worker units order after it:

```ini
[Unit]
Requires=argus-secrets.service
After=argus-secrets.service
```

and the Compose stack runs with the secrets dir pointed at the delivered files (the tunnel token is one of
those files — cloudflared reads it via `TUNNEL_TOKEN_FILE`, so no token is exported into the process env):

```bash
export ARGUS_SECRETS_DIR=/run/argus/secrets
docker compose -f /opt/argus/compose.prod.yaml up -d
```

## Verify / rotate

```bash
systemctl restart argus-secrets          # re-fetch on demand — RESTART, not start: the oneshot is
                                         # RemainAfterExit=yes, so `start` is a no-op once it's active
journalctl -u argus-secrets --no-pager   # names + status only — never a value
ls -l /run/argus/secrets                 # 0444 root:root files in a 0700 root dir, on tmpfs
```

Rotation: update the value in Key Vault, `systemctl restart argus-secrets` (re-runs the fetch, atomic
overwrite), then restart the consuming service. Automated rotate-on-change is a later enhancement.
