# Nightly DB backup worker (checkpoint 49)

Standalone VM worker that takes a **nightly logical backup** of the whole Postgres database, **encrypts it
client-side**, and ships it to a **private EU Backblaze B2 bucket** — then prunes backups past the retention
window. Runs natively on the VM via a **systemd timer** — no Node, no container.

> Scope: this is a **logical** backup (`pg_dump`, daily granularity) — what the VM beta needs. Continuous
> **PITR** (WAL archiving + base backups, restore to any second) is the enterprise-grade upgrade; noted in
> the threat model.

## What it does

1. Connects to Postgres as the least-privilege **`argus_backup`** role (migration `0015_db_backup_role.sql`):
   read-only across all tenants (`pg_read_all_data` + `BYPASSRLS`, so the FORCE-RLS tenant tables dump in
   full), never able to write or DROP.
2. Streams `pg_dump --format=custom | age -r <public key> | aws s3 cp -` — the dump is **encrypted before it
   leaves the box**, so no plaintext ever touches disk or B2. The object key is `argus-db-<UTC>.dump.age`.
3. Verifies the upload, then **prunes** any backup older than `RETENTION_DAYS` (default 30).
4. Logs object keys / sizes / counts only — never a secret.

## Why client-side encryption (not just B2 SSE)

The DB holds **cleartext metadata** — emails, display names, conversation membership, audit logs (message
*bodies* are already MLS ciphertext; the server is crypto-blind). A dump is therefore GDPR-relevant PII. We
encrypt it with **`age` to a public recipient key** so B2 only ever stores ciphertext (invariant #2). The age
**private** key is **not on the VM** — it lives in Key Vault and is fetched only at restore time, so a
compromised backup host can read neither the live secrets nor any past backup it wrote.

## Secrets (invariant #5)

The DB password and the B2 application key are **never** in the unit/env at rest. They are delivered as
credential **files** via systemd `LoadCredential=`, populated from **Azure Key Vault** by the VM's **Managed
Identity** at boot. The worker reads them from `$CREDENTIALS_DIRECTORY`. The DB connection uses libpq `PG*`
env vars (no connstring on argv), so the password never appears in `ps`. The age **public** key is not a
secret and rides in the unit's `Environment=`.

## Prerequisites

### 1. Provision the backup role login

Migration `0015` creates `argus_backup` as **NOLOGIN** (no password in source). Grant it LOGIN + a password
out-of-band — the password lives in Key Vault and is delivered to the unit via `LoadCredential`. Run once as
a superuser/owner:

```sql
-- NOT in a tracked migration (the password is environment-specific):
ALTER ROLE argus_backup LOGIN PASSWORD '<from-key-vault>';
```

This mirrors how `argus_app` / `argus_cleanup` are provisioned (NOLOGIN in the migration; LOGIN + a Key Vault
password at deploy). The role is read-only + BYPASSRLS — see the migration header for why that is necessary
and acceptable.

### 2. Generate the age keypair (once)

```bash
age-keygen -o argus-backup-age.key      # prints "Public key: age1..." to stderr
```

- Put the **public** key (`age1...`) in the unit's `AGE_RECIPIENT=`.
- Store the **private** key (the `AGE-SECRET-KEY-1...` line in the file) in **Key Vault** — it is the only
  thing that can decrypt the backups. **If it is lost, every backup is permanently unreadable.** Do NOT keep
  it on the backup VM. Securely delete the local file after uploading it to Key Vault.

### 3. B2 bucket

A **private** bucket (e.g. `db-q7m2z9x4v6n8p3k1`), separate from the attachment bucket, with SSE-B2 on as a
second layer. A **lifecycle rule** matching `RETENTION_DAYS` is a good backstop in case the script's prune is
ever skipped (defence-in-depth, like the attachment bucket).

## Install (on the VM)

```bash
sudo install -d /opt/argus/backup
sudo install -m 0755 backup-db.sh /opt/argus/backup/
sudo cp argus-db-backup.{service,timer} /etc/systemd/system/
# Edit the .service: set PGHOST/.../S3_BUCKET, S3_ACCESS_KEY_ID, AGE_RECIPIENT, RETENTION_DAYS, and the
# LoadCredential source paths. Ensure `age`, `pg_dump` (postgresql-client), and AWS CLI v2 are installed.
sudo systemctl daemon-reload
sudo systemctl enable --now argus-db-backup.timer
# One-off run + logs:
sudo systemctl start argus-db-backup.service
journalctl -u argus-db-backup.service
```

## Restore runbook (test this — an untested backup is not a backup)

On a trusted host (NOT the backup VM — it must NOT hold the age private key):

```bash
# 1. Fetch the age private key from Key Vault into a temp file (mode 0400), and the latest backup from B2.
az keyvault secret show --vault-name <vault> --name argus-backup-age-key --query value -o tsv > age.key
chmod 0400 age.key
LATEST=$(aws s3api list-objects-v2 --endpoint-url https://s3.eu-central-003.backblazeb2.com \
  --bucket db-q7m2z9x4v6n8p3k1 --prefix argus-db --query 'sort_by(Contents,&LastModified)[-1].Key' --output text)
aws s3 cp "s3://db-q7m2z9x4v6n8p3k1/${LATEST}" ./backup.dump.age \
  --endpoint-url https://s3.eu-central-003.backblazeb2.com

# 2. Decrypt → restore into a FRESH database (verify before pointing prod at it).
age -d -i age.key backup.dump.age > backup.dump
createdb argus_restore
pg_restore --no-owner --no-privileges --dbname argus_restore backup.dump

# 3. Sanity-check, then cut over. Securely remove age.key + the plaintext dump afterwards.
shred -u age.key backup.dump
```

> **Migration ordering on restore/deploy:** a restored DB is at the schema of its dump. Run
> `pnpm --filter @argus/api db:migrate` (owner connection) before serving traffic if the running image needs
> a newer migration (e.g. `0009`'s `secmes_app → argus_app` rename, or tenant requests fail at `SET LOCAL
> ROLE`). Same ordering caveat the deploy pipeline carries.

## Deploy verification & tuning

- **Dry-run is a hard gate before trusting the timer:** `systemctl start argus-db-backup`, then check
  `journalctl -u argus-db-backup`. **AWS CLI v2 is a PyInstaller bundle that can segfault under
  `MemoryDenyWriteExecute=true`** on some glibc builds — this can't be validated off the VM. If the dry-run
  segfaults, drop `MemoryDenyWriteExecute=true` from the unit (the one knob known to bite the CLI). Confirm
  the dry-run completes a **real** multipart upload (a full dump), not just a connection.
- **Do a real restore drill** (above) on day one and on a schedule — checkpoint 49 is "backups **+ a tested
  restore**", not just backups.
- **Remote Postgres:** loopback uses `PGSSLMODE=prefer`. If `PGHOST` ever points off-box, set
  `PGSSLMODE=verify-full` + a CA bundle so the connection can't silently fall back to plaintext.
- **Alerting is NOT yet wired (follow-up):** the worker exits non-zero on a failed/too-small dump, but no
  `OnFailure=` consumes that yet. Add an `OnFailure=argus-alert@%n.service` (journal-to-webhook oneshot) or a
  journal scrape before this is trusted in prod — a silent backup gap is the classic DR trap, and
  `Persistent=true` will otherwise run nightly into a wall forever.
