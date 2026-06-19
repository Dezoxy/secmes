# Attachment cleanup worker (checkpoint 37)

Standalone VM worker that reaps **expired** encrypted attachment blobs (Backblaze B2) + their metadata rows
after the 7-day retention window. Runs natively on the VM via a **systemd timer** — no Node, no container.

## What it does

1. Connects to Postgres as the least-privilege **`argus_cleanup`** role. That role's RLS policy (migration
   `0013_attachments_cleanup.sql`) exposes **only rows whose `expires_at` has lapsed** — across tenants, but
   never a live row and never any other tenant data.
2. For each expired row: deletes the **B2 object first** (idempotent), then the **DB row**. A crash leaves
   the row for the next run (no orphan blobs, no orphan rows either way).
3. Logs IDs / object-keys / counts only — never a secret.

> **Connection model (BKP-1 remediation, 2026-06).** Postgres publishes **no host port** (invariant #3). The
> worker reaches the DB **in-container** via `docker compose exec -T postgres psql …` over the container's
> local-trust socket — not a host TCP port. So there is **no DB password** (the role needs only `LOGIN`),
> `deploy.sh` **auto-installs and arms** the unit, and `MemoryDenyWriteExecute` is dropped (AWS CLI v2). See
> `docs/threat-models/db-backup.md` §7.

## Secrets (invariant #5)

The **B2 application key** is **never** in the unit/env at rest. It is delivered as a credential **file** via
systemd `LoadCredential=`, populated from **Azure Key Vault** by the VM's **Managed Identity** at boot. The
worker reads it from `$CREDENTIALS_DIRECTORY`. There is **no DB password** on the host: the DB connection runs
in-container over the local-trust socket (see the callout above).

## Prerequisite — provision the cleanup role login

Migration `0013` creates `argus_cleanup` as **NOLOGIN**. The worker connects **in-container over local
trust**, so it needs **LOGIN but no password**. `deploy.sh` step 5b does this automatically
(`ALTER ROLE argus_cleanup WITH LOGIN;`). For a manual/dev run, as a superuser/owner:

```sql
-- NOT in a tracked migration:
ALTER ROLE argus_cleanup LOGIN;
```

## Install (on the VM)

> On the real deploy this is **automatic** — `deploy.sh` step 5c stages the script, installs the units + the
> notifier, substitutes `S3_ACCESS_KEY_ID`, and `enable --now`s the timer. The steps below are for a
> **manual/dev** run.

```bash
sudo install -d /opt/argus/cleanup
sudo install -m 0755 cleanup-attachments.sh /opt/argus/cleanup/
sudo cp argus-attachment-cleanup.{service,timer} /etc/systemd/system/
# Edit the .service: set S3_BUCKET + S3_ACCESS_KEY_ID. The DB is reached in-container via `docker compose
# exec` (COMPOSE_FILE/COMPOSE_PROJECT_NAME, no PGHOST), so the user running the timer must be in the `docker`
# group (argus already is). `psql` runs inside the postgres container; AWS CLI v2 runs on the host.
sudo systemctl daemon-reload
sudo systemctl enable --now argus-attachment-cleanup.timer
# One-off run + logs:
sudo systemctl start argus-attachment-cleanup.service
journalctl -u argus-attachment-cleanup.service
```

## Belt-and-suspenders

A B2 bucket **lifecycle rule** (auto-hide at 14 days, delete hidden after 1 day) backs this worker so any
blob whose DB row vanished is still reclaimed. See `docs/threat-models/encrypted-attachments.md` §5.

## Prod prerequisite — B2 CORS

Unrelated to this worker but required for prod uploads/downloads: the bucket needs a CORS rule allowing the
web app origin(s) + `s3_put`/`s3_get` + the `content-type` header (see the threat model §5(f)).

## Deploy verification & tuning

- **Dry-run before enabling the timer:** `systemctl start argus-attachment-cleanup`, then check
  `journalctl -u argus-attachment-cleanup`. `MemoryDenyWriteExecute` is already **dropped** from this unit
  (AWS CLI v2 is a PyInstaller bundle that needs W^X memory). Confirm the `docker compose exec` path works
  under the unit's sandbox as `User=argus` (docker-group) on the VM — that's the one part not exercisable
  off-box.
- **Throughput ceiling:** one run reaps up to `CLEANUP_BATCH × CLEANUP_MAX_ROUNDS` (default 1000 × 50 =
  50k) rows. With a daily timer + 7-day retention that is ample; under heavy load tighten `OnCalendar` or
  raise the caps.
- **Off-box Postgres:** the worker reaches PG **in-container** via `docker compose exec` (local trust). If PG
  ever moves off-box, switch to a TCP client with `PGSSLMODE=verify-full` + a CA bundle + a scoped login
  credential — the local-trust shortcut only holds while PG is a co-located container with no published port.
- **Alerting:** the worker logs `done reaped=N failed=M` and, on a non-zero exit, fires
  `OnFailure=argus-notify-failure@` (installed by `deploy.sh` — posts a GlitchTip event). The 14-day B2
  lifecycle rule remains a backstop, not primary cleanup.
