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
2. Writes **two** encrypted objects, each streamed `… | age -r <public key> | aws s3 cp -` (encrypted before
   it leaves the box — no plaintext on disk or in B2):
   - `argus-globals-<UTC>.sql.age` — `pg_dumpall --roles-only --no-role-passwords`: the cluster **roles**
     (definitions + memberships, **no password hashes**), so a restore onto a fresh cluster has the roles the
     schema's RLS policies/grants reference.
   - `argus-db-<UTC>.dump.age` — `pg_dump --format=custom`: the database (compact, selective/parallel restore).
3. Verifies each upload (PIPESTATUS + size floor), then **prunes** any backup older than `RETENTION_DAYS`
   (default 30) — one list under the shared `argus-` prefix covers both families.
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
Identity** at boot. The worker reads them from `$CREDENTIALS_DIRECTORY` and keeps them **file-backed
end-to-end**: it writes a libpq passfile + an AWS credentials file in a service-private tmpfs work dir under
the systemd `RuntimeDirectory` (0600 — no host-disk backing, unlike `PrivateTmp`'s `/tmp`) and
points the CLIs at them by path (`PGPASSFILE` / `AWS_SHARED_CREDENTIALS_FILE`), so the secret **values** are
never exported into the process environment (hence not in `/proc/<pid>/environ`, not inherited by children)
nor on argv/`ps`. The work dir is removed on exit. The age **public** key is not a secret and rides in the
unit's `Environment=`.

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
# Failure notifier (shared with the cleanup worker — install once for both)
sudo install -d /opt/argus/notify
sudo install -m 0755 ../notify/notify-failure.sh /opt/argus/notify/
sudo cp ../notify/argus-notify-failure@.service /etc/systemd/system/

# Backup worker
sudo install -d /opt/argus/backup
sudo install -m 0755 backup-db.sh /opt/argus/backup/
sudo cp argus-db-backup.{service,timer} /etc/systemd/system/
# Edit argus-db-backup.service: set PGHOST/.../S3_BUCKET, S3_ACCESS_KEY_ID, AGE_RECIPIENT, RETENTION_DAYS,
# and the LoadCredential source paths. Ensure `age`, `pg_dump` (postgresql-client), and AWS CLI v2 are installed.
sudo systemctl daemon-reload
sudo systemctl enable --now argus-db-backup.timer
# One-off run + logs:
sudo systemctl start argus-db-backup.service
journalctl -u argus-db-backup.service
```

## Restore runbook (test this — an untested backup is not a backup)

Each nightly run writes **two** encrypted objects: `argus-globals-<ts>.sql.age` (cluster ROLES — definitions
+ memberships, **no passwords**) and `argus-db-<ts>.dump.age` (the database, custom format). A restore onto a
**fresh cluster** must recreate the roles **first** (the schema's RLS policies + grants reference
`argus_app`/`argus_cleanup`/`argus_backup`), then restore the DB, then re-apply role passwords from Key Vault.

On a trusted host (NOT the backup VM — it must NOT hold the age private key):

```bash
EP=https://s3.eu-central-003.backblazeb2.com ; BUCKET=db-q7m2z9x4v6n8p3k1

# 1. Fetch the age private key from Key Vault (mode 0400). Then pick the latest DB object and its PAIRED
#    roles object BY SHARED TIMESTAMP — never mix a newer roles dump with an older DB (each run writes both
#    objects with the same stamp; a failed run leaves neither).
az keyvault secret show --vault-name <vault> --name argus-backup-age-key --query value -o tsv > age.key
chmod 0400 age.key
DB_KEY=$(aws s3api list-objects-v2 --endpoint-url "$EP" --bucket "$BUCKET" --prefix argus-db- \
  --query 'sort_by(Contents,&LastModified)[-1].Key' --output text)
STAMP=${DB_KEY#argus-db-}; STAMP=${STAMP%.dump.age}          # e.g. 20260608T023012Z
GLOBALS_KEY="argus-globals-${STAMP}.sql.age"
aws s3 cp "s3://$BUCKET/$GLOBALS_KEY" ./globals.sql.age --endpoint-url "$EP"
aws s3 cp "s3://$BUCKET/$DB_KEY"      ./backup.dump.age --endpoint-url "$EP"

# 2. Roles FIRST (no passwords — re-applied from Key Vault in step 4). Connect to the maintenance DB.
age -d -i age.key globals.sql.age | psql -d postgres

# 3. Restore the DB into a FRESH database — faithfully (keep owners/grants/policies; the roles now exist).
age -d -i age.key backup.dump.age > backup.dump
createdb argus_restore
pg_restore --dbname argus_restore backup.dump   # NOT --no-owner/--no-privileges — roles exist, so keep them

# 4. Re-apply role login passwords from Key Vault (the backup deliberately omits them), e.g.:
#    ALTER ROLE argus_app   LOGIN PASSWORD '<from-key-vault>';
#    ALTER ROLE argus_cleanup LOGIN PASSWORD '<from-key-vault>';
#    ALTER ROLE argus_backup  LOGIN PASSWORD '<from-key-vault>';

# 5. Sanity-check, then cut over. Securely remove the key + plaintext dump.
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
- **Alerting:** `OnFailure=argus-notify-failure@%p.service` is wired in the unit. When the backup fails,
  systemd starts `argus-notify-failure@argus-db-backup.service`, which posts a `fatal`-level Sentry event to
  GlitchTip (if `sentry_dsn` is provisioned) or logs to the journal only (graceful no-op until armed). Install
  the notifier once alongside the backup worker (see Install below).
