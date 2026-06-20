# Nightly DB backup worker (checkpoint 49)

Standalone VM worker that takes a **nightly logical backup** of the whole Postgres database, **encrypts it
client-side**, and ships it to a **private EU Backblaze B2 bucket**. The bucket is **WORM** (B2 Object Lock —
BKP-2): backups are immutable, the worker's key can't delete, and old backups are reaped by a server-side B2
lifecycle rule, not by the worker. Runs natively on the VM via a **systemd timer** — no Node, no container.

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
3. Verifies each upload (PIPESTATUS + size floor). It does **not** prune: the backup bucket is **WORM** (B2
   Object Lock, Compliance mode — BKP-2), and the backup key has **no delete capability**, so old backups are
   reaped by a server-side **B2 lifecycle rule** (prefix `argus-`, ~35 days), not by this script. A
   partial/corrupt or orphaned object can't be deleted either — it is left in place (age-ciphertext, leaks
   nothing), reaped by the lifecycle rule and **skipped at restore** (size floor + timestamp pairing).
4. Logs object keys / sizes / counts only — never a secret.

## Why client-side encryption (not just B2 SSE)

The DB holds **cleartext metadata** — emails, display names, conversation membership, audit logs (message
*bodies* are already MLS ciphertext; the server is crypto-blind). A dump is therefore GDPR-relevant PII. We
encrypt it with **`age` to a public recipient key** so B2 only ever stores ciphertext (invariant #2). The age
**private** key is **not on the VM** — it lives in Key Vault and is fetched only at restore time, so a
compromised backup host can read neither the live secrets nor any past backup it wrote.

> **Connection model (BKP-1 remediation, 2026-06).** Postgres publishes **no host port** (invariant #3;
> `compose-guard` enforces it). The worker therefore reaches the DB **in-container** via
> `docker compose exec -T postgres pg_dump …` over the container's local-trust socket — **not** a host TCP
> port + libpq passfile. Consequences reflected below: there is **no DB password** on the host (`argus_backup`
> connects via local trust, so it needs only `LOGIN`, no password); `deploy.sh` **auto-stages, installs, and
> arms** the units (the manual steps below are for a dev/manual run); and `MemoryDenyWriteExecute` is dropped
> from this unit (AWS CLI v2 PyInstaller). See `docs/threat-models/db-backup.md` §7 for the rationale.

## Secrets (invariant #5)

The **B2 application key** is **never** in the unit/env at rest. It is delivered as a credential **file** via
systemd `LoadCredential=`, populated from **Azure Key Vault** by the VM's **Managed Identity** at boot. The
worker reads it from `$CREDENTIALS_DIRECTORY` and keeps it **file-backed**: it writes an AWS credentials file
in a service-private tmpfs work dir under the systemd `RuntimeDirectory` (0600 — no host-disk backing, unlike
`PrivateTmp`'s `/tmp`) and points `aws` at it by path (`AWS_SHARED_CREDENTIALS_FILE`), so the secret **value**
is never exported into the process environment (hence not in `/proc/<pid>/environ`, not inherited by children)
nor on argv/`ps`. The work dir is removed on exit. There is **no DB password** on the host (the DB connection
is in-container local-trust — see the callout above). The age **public** key is not a secret and rides in the
unit's `Environment=`.

## Prerequisites

### 1. Provision the backup role login

Migration `0015` creates `argus_backup` as **NOLOGIN** (no password in source). The worker connects
**in-container over local trust**, so it needs **LOGIN but no password**. `deploy.sh` step 5b does this
automatically (`ALTER ROLE argus_backup WITH LOGIN;`). For a manual/dev run, as a superuser/owner:

```sql
-- NOT in a tracked migration:
ALTER ROLE argus_backup LOGIN;
```

The role is read-only + BYPASSRLS — see the migration header for why that is necessary and acceptable.

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
second layer **and B2 Object Lock (WORM) enabled** — see the operator runbook in
[`infra/b2/README.md`](../b2/README.md). Under Object Lock the script no longer prunes; a **B2 lifecycle
rule** (prefix `argus-`, ~35 days) is now the **primary** reaper (it defers to Object Lock, so it can never
remove a still-locked backup), and the backup key is re-minted **without delete capability**.

## Install (on the VM)

> On the real deploy this is **automatic** — `deploy.sh` step 5c stages these scripts, installs the units +
> the notifier, substitutes `S3_ACCESS_KEY_ID`/`AGE_RECIPIENT`, `enable --now`s the timer, and runs a
> connectivity probe. The steps below are for a **manual/dev** run.

```bash
# Failure notifier (shared with the cleanup worker — install once for both)
sudo install -d /opt/argus/notify
sudo install -m 0755 ../notify/notify-failure.sh /opt/argus/notify/
sudo cp ../notify/argus-notify-failure@.service /etc/systemd/system/

# Backup worker
sudo install -d /opt/argus/backup
sudo install -m 0755 backup-db.sh /opt/argus/backup/
sudo cp argus-db-backup.{service,timer} /etc/systemd/system/
# Edit argus-db-backup.service: set S3_BUCKET, S3_ACCESS_KEY_ID (the key-id of the db-backups `argus-b2-app-key`
# — a SEPARATE key from the attachment key, re-minted WITHOUT delete capability; deploy.sh fills this from the
# B2_APP_KEY_ID var) and AGE_RECIPIENT. (No RETENTION_DAYS — retention is the bucket's Object Lock + a B2
# lifecycle rule; see infra/b2/README.md.) The DB is
# reached in-container via `docker compose exec` (COMPOSE_FILE/COMPOSE_PROJECT_NAME, no PGHOST), so the
# user running the timer must be in the `docker` group (argus already is). Ensure `age` and AWS CLI v2 are
# installed on the host; `pg_dump` runs inside the postgres container.
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
`argus_app`/`argus_cleanup`/`argus_backup`), then restore the DB, then re-apply role logins (argus_app's
password from Key Vault; argus_backup/argus_cleanup LOGIN-only — they use in-container local trust).

On a trusted host (NOT the backup VM — it must NOT hold the age private key):

```bash
EP=https://s3.eu-central-003.backblazeb2.com ; BUCKET=db-q7m2z9x4v6n8p3k1

# 1. Fetch the age private key from Key Vault (mode 0400).
az keyvault secret show --vault-name <vault> --name argus-backup-age-key --query value -o tsv > age.key
chmod 0400 age.key

# 1b. Pick the newest VALID backup pair — do NOT blindly take the newest argus-db-*.
#     WORM (Object Lock) means a truncated/corrupt or orphaned object can no longer be deleted by the nightly
#     script (its key has no delete capability), so a bad object can LINGER in the bucket until the lifecycle
#     rule reaps it. The blind `sort_by(...)[-1]` would pick that bad object. Instead walk newest-first and
#     accept the first DB object that (a) clears the 1024-byte size floor (same floor the worker enforces),
#     (b) has its PAIRED argus-globals-* (same stamp, ≥64 B), and (c) decrypts (age STREAM auth rejects a
#     mid-stream-truncated upload) with a valid TOC. Each good run writes both objects with one stamp, so an
#     orphan globals (no matching db) is simply never selected.
#     CAVEAT: `pg_restore --list` checks STRUCTURE, not completeness — a dump truncated *after* the TOC but
#     still age-valid would pass here yet restore with missing trailing rows. This walk only cheaply rejects
#     grossly-broken objects; the data-completeness test is the full restore drill below (step 3 + sanity
#     check). If OnFailure has been firing for N nights, the newest VALID pair this walk lands on is N days
#     stale — that staleness, not a wrong restore, is the real exposure (see "Denial of availability" in the
#     threat model).
rm -f backup.dump backup.dump.age globals.sql.age   # idempotent: clear any leftovers from a prior aborted run
DB_KEY=""; STAMP=""
while read -r cand; do
  [[ -n "$cand" ]] || continue
  sz=$(aws s3api head-object --endpoint-url "$EP" --bucket "$BUCKET" --key "$cand" \
    --query 'ContentLength' --output text 2>/dev/null || echo 0)
  [[ "$sz" =~ ^[0-9]+$ && "$sz" -ge 1024 ]] || { echo "skip $cand (too small: ${sz}B)"; continue; }
  st=${cand#argus-db-}; st=${st%.dump.age}                   # e.g. 20260608T023012Z
  gk="argus-globals-${st}.sql.age"
  gsz=$(aws s3api head-object --endpoint-url "$EP" --bucket "$BUCKET" --key "$gk" \
    --query 'ContentLength' --output text 2>/dev/null || echo 0)
  [[ "$gsz" =~ ^[0-9]+$ && "$gsz" -ge 64 ]] || { echo "skip $cand (no paired roles object $gk)"; continue; }
  # Decrypt + a structural smoke test. pg_restore --list reads the archive's TOC only — it never touches a DB.
  aws s3 cp "s3://$BUCKET/$cand" ./backup.dump.age --endpoint-url "$EP" --only-show-errors
  if ! age -d -i age.key backup.dump.age >backup.dump 2>/dev/null || ! pg_restore --list backup.dump >/dev/null 2>&1; then
    echo "skip $cand (failed decrypt / pg_restore --list)"; rm -f backup.dump.age backup.dump; continue
  fi
  aws s3 cp "s3://$BUCKET/$gk" ./globals.sql.age --endpoint-url "$EP" --only-show-errors
  DB_KEY="$cand"; STAMP="$st"; echo "selected $DB_KEY (roles: $gk)"; break
done < <(aws s3api list-objects-v2 --endpoint-url "$EP" --bucket "$BUCKET" --prefix argus-db- \
  --query 'reverse(sort_by(Contents,&LastModified))[].Key' --output text | tr '\t' '\n')
[[ -n "$DB_KEY" ]] || { echo "FATAL: no valid backup pair found in $BUCKET"; exit 1; }
# globals.sql.age + backup.dump.age are now the selected pair; backup.dump is already decrypted from step 1b.

# 2. Roles FIRST (no passwords — re-applied from Key Vault in step 4). Connect to the maintenance DB.
#    NOTE (found by the restore drill): no `-v ON_ERROR_STOP=1` here, on purpose — two globals lines can
#    error without aborting the restore:
#      - `CREATE ROLE <bootstrap-superuser>` → "role already exists" if the fresh cluster reuses the source
#        superuser name (e.g. argus). Harmless.
#      - `GRANT pg_read_all_data TO argus_backup ... GRANTED BY <src-superuser>` → FAILS on PG16 when the
#        fresh cluster's superuser differs from the original (the grantor needs ADMIN option on the predefined
#        role). When it fails, argus_backup keeps BYPASSRLS but LOSES pg_read_all_data, so the NEXT backup
#        can't read the tables. Step 4 re-grants it explicitly, recovering this regardless of superuser name.
age -d -i age.key globals.sql.age | psql -d postgres

# 3. Restore the DB into a FRESH database — faithfully (keep owners/grants/policies; the roles now exist).
age -d -i age.key backup.dump.age > backup.dump
createdb argus_restore
pg_restore --dbname argus_restore backup.dump   # NOT --no-owner/--no-privileges — roles exist, so keep them

# 4. Re-apply role logins (the backup deliberately omits passwords), AND re-grant argus_backup's full-read
#    membership (the globals GRANT can fail across superusers — see step 2). Run as the restore superuser;
#    `grant` is idempotent if already a member. Only argus_app needs a PASSWORD (it connects over TCP); the
#    backup/cleanup workers connect in-container over local trust, so LOGIN with no password suffices:
#    ALTER ROLE argus_app     LOGIN PASSWORD '<from-key-vault>';
#    ALTER ROLE argus_cleanup LOGIN;   -- in-container local-trust: no password
#    ALTER ROLE argus_backup  LOGIN;   -- in-container local-trust: no password
#    GRANT pg_read_all_data TO argus_backup;   -- restores full-DB read for the next backup (BYPASSRLS survives)
#    -- verify: `\du argus_backup` must show BOTH "Bypass RLS" and membership of pg_read_all_data

# 5. Sanity-check, then cut over. Securely remove the key + plaintext dump.
shred -u age.key backup.dump
```

> **Migration ordering on restore/deploy:** a restored DB is at the schema of its dump. Run
> `pnpm --filter @argus/api db:migrate` (owner connection) before serving traffic if the running image needs
> a newer migration (e.g. `0009`'s `secmes_app → argus_app` rename, or tenant requests fail at `SET LOCAL
> ROLE`). Same ordering caveat the deploy pipeline carries.

## Deploy verification & tuning

- **Dry-run is a hard gate before trusting the timer:** `systemctl start argus-db-backup`, then check
  `journalctl -u argus-db-backup`. `MemoryDenyWriteExecute` is already **dropped** from this unit — AWS CLI v2
  is a PyInstaller bundle that maps memory W+X and segfaults under MDWE; the deploy's connectivity probe
  doesn't exercise the CLI, so the first real dry-run on the VM is where an AWS-CLI/sandbox issue would
  surface (caught by `OnFailure=` thereafter). Confirm the dry-run completes a **real** multipart upload (a
  full dump), not just a connection — and that the `docker compose exec` path works under the unit's sandbox
  as `User=argus` (docker-group).
- **Do a real restore drill** (above) on day one and on a schedule — checkpoint 49 is "backups **+ a tested
  restore**", not just backups. _Drilled 2026-06-14 against PG16 (dump → fresh-cluster restore): data, schema,
  all RLS policies and per-role grants restore correctly and RLS enforces under a real `argus_app` login. The
  drill surfaced the `pg_read_all_data` / `GRANTED BY` gap now handled in steps 2 and 4 — re-run the drill
  against the actual prod backup objects before GA._
- **Off-box Postgres:** the worker reaches PG **in-container** via `docker compose exec` (local trust). If PG
  ever moves off-box (managed/remote), this worker must switch to a TCP client with `PGSSLMODE=verify-full` +
  a CA bundle + a scoped login credential — the local-trust shortcut only holds while PG is a co-located
  container with no published port.
- **Alerting:** `OnFailure=argus-notify-failure@%p.service` is wired in the unit. When the backup fails,
  systemd starts `argus-notify-failure@argus-db-backup.service`, which posts a `fatal`-level Sentry event to
  GlitchTip (if `sentry_dsn` is provisioned) or logs to the journal only (graceful no-op until armed). Install
  the notifier once alongside the backup worker (see Install below).
