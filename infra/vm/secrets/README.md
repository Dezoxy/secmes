# Key Vault → credential files (Slice 3)

The boot-time step that turns Azure Key Vault secrets into on-VM **credential files**, using the VM's
**Managed Identity** — no static credentials, nothing committed. This is the "separate fetch step" the
backup/cleanup units already reference. Threat model: [`docs/threat-models/vm-secrets.md`](../../../docs/threat-models/vm-secrets.md).

> **Status: build-only.** This provides the script + unit + wiring. Installing/enabling it on the VM (with the
> real Key Vault name templated in) is the Slice-4 deploy (`az vm run-command`). Nothing here is deployed.

## How it works

```
boot ─▶ argus-secrets.service ─▶ fetch-keyvault-secrets.sh
          IMDS (Managed Identity) → token → Key Vault REST → /run/argus/secrets/<file>  (tmpfs, 0400 root)
```

`fetch-keyvault-secrets.sh` gets a Managed-Identity token from IMDS (`169.254.169.254`), reads each secret
from `https://<vault>.vault.azure.net`, and writes it atomically to `/run/argus/secrets/` (tmpfs, `0400`
root). It logs secret **names + status only**, never values, and **fails closed** (any error exits non-zero;
consumers `Requires=` this unit, so they don't start on a missing secret).

## Secrets it delivers

| Key Vault secret name           | Local file (`/run/argus/secrets/`) | Consumer                                            |
| ------------------------------- | ---------------------------------- | --------------------------------------------------- |
| `argus-postgres-owner-password` | `postgres_password`                | `postgres` (`POSTGRES_PASSWORD_FILE`) — owner/init  |
| `argus-database-url`            | `database_url`                     | `api` (`DATABASE_URL_FILE`) — **`argus_app` DSN**   |
| `argus-s3-secret-access-key`    | `s3_secret_access_key`             | `api` (`S3_SECRET_ACCESS_KEY_FILE`) — B2 attachments|
| `argus-tunnel-token`            | `tunnel_token`                     | `cloudflared` (`TUNNEL_TOKEN`, runtime value)       |
| `argus-backup-db-password`      | `backup-db-password`               | `argus-db-backup` (`LoadCredential`) — `argus_backup` role |
| `argus-cleanup-db-password`     | `cleanup-db-password`              | `argus-attachment-cleanup` (`LoadCredential`) — `argus_cleanup` role |
| `argus-b2-app-key`              | `b2-app-key`                       | `argus-db-backup` + `argus-attachment-cleanup` (`LoadCredential`) |

> `database_url` MUST be the non-bypass **`argus_app`** DSN (`postgres://argus_app:<pw>@postgres:5432/argus`),
> never the `argus` owner — least privilege so RLS/grants bind even off the `SET LOCAL ROLE` path. The owner
> password (`argus-postgres-owner-password`) is for init + migrations only.

### Deploy-time secrets (fetched by `deploy.sh`, NOT delivered to the running stack)

The CD rollout (`infra/vm/deploy/deploy.sh`, Slice 4) fetches two extra secrets via the Managed Identity,
uses them, and drops them — they are **never** written to `/run/argus/secrets` (least privilege: the running
stack never holds a GitHub token or the DB owner DSN):

| Key Vault secret name          | Used for                                                              |
| ------------------------------ | -------------------------------------------------------------------- |
| `argus-ghcr-token`             | `docker login ghcr.io` to pull the signed images (`packages:read`)   |
| `argus-migration-database-url` | the **owner** DSN for migrate-before-serve (`MIGRATION_DATABASE_URL_FILE`) — file-mounted, then `shred`-ed |

## Populate the vault (one-time, by you)

The VM's Managed Identity has **Key Vault Secrets User** (read-only) from `infra/vm/terraform`. You set the
values out-of-band — they never touch the repo:

```bash
KV="$(terraform -chdir=infra/vm/terraform output -raw key_vault_name)"
az keyvault secret set --vault-name "$KV" --name argus-postgres-owner-password --value '<owner-pw>'
az keyvault secret set --vault-name "$KV" --name argus-database-url           --value 'postgres://argus_app:<pw>@postgres:5432/argus'
az keyvault secret set --vault-name "$KV" --name argus-s3-secret-access-key   --value '<b2-attachment-key-secret>'
az keyvault secret set --vault-name "$KV" --name argus-tunnel-token           --value '<cloudflare-tunnel-token>'
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
install -m 0755 infra/vm/secrets/fetch-keyvault-secrets.sh /opt/argus/secrets/
install -m 0644 infra/vm/secrets/argus-secrets.service /etc/systemd/system/
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

and the Compose stack runs with the secrets dir + tunnel token pointed at the delivered files:

```bash
export ARGUS_SECRETS_DIR=/run/argus/secrets
export TUNNEL_TOKEN="$(cat /run/argus/secrets/tunnel_token)"
docker compose -f /opt/argus/compose.prod.yaml up -d
```

## Verify / rotate

```bash
systemctl restart argus-secrets          # re-fetch on demand — RESTART, not start: the oneshot is
                                         # RemainAfterExit=yes, so `start` is a no-op once it's active
journalctl -u argus-secrets --no-pager   # names + status only — never a value
ls -l /run/argus/secrets                 # 0400 root:root, on tmpfs
```

Rotation: update the value in Key Vault, `systemctl restart argus-secrets` (re-runs the fetch, atomic
overwrite), then restart the consuming service. Automated rotate-on-change is a later enhancement.
