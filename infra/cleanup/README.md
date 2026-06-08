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

## Secrets (invariant #5)

The DB password and the B2 application key are **never** in the unit/env at rest. They are delivered as
credential **files** via systemd `LoadCredential=`, populated from **Azure Key Vault** by the VM's
**Managed Identity** at boot. The worker reads them from `$CREDENTIALS_DIRECTORY`. The DB connection uses
libpq `PG*` env vars (no connstring on argv), so the password never appears in `ps`.

## Prerequisite — provision the cleanup role login

Migration `0013` creates `argus_cleanup` as **NOLOGIN** (its privileges are migration-controlled, and the
RLS tests assume the role via `SET ROLE`). The systemd unit connects directly as `PGUSER=argus_cleanup`, so
**before the worker can run** you must grant the role LOGIN + a password out-of-band — the password lives in
Key Vault and is delivered to the unit via `LoadCredential` (see below). Run once as a superuser/owner:

```sql
-- NOT in a tracked migration (the password is environment-specific):
ALTER ROLE argus_cleanup LOGIN PASSWORD '<from-key-vault>';
```

This mirrors how `argus_app` is provisioned (NOLOGIN in the migration; LOGIN + a Key Vault password at deploy).

## Install (on the VM)

```bash
sudo install -d /opt/argus/cleanup
sudo install -m 0755 cleanup-attachments.sh /opt/argus/cleanup/
sudo cp argus-attachment-cleanup.{service,timer} /etc/systemd/system/
# Edit the .service: set PGHOST/.../S3_BUCKET + S3_ACCESS_KEY_ID, and the LoadCredential source paths.
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
  `journalctl -u argus-attachment-cleanup`. Confirm your **AWS CLI v2** build runs under the unit's
  hardening (especially `MemoryDenyWriteExecute=true`); relax that one knob if the CLI needs W^X memory.
- **Throughput ceiling:** one run reaps up to `CLEANUP_BATCH × CLEANUP_MAX_ROUNDS` (default 1000 × 50 =
  50k) rows. With a daily timer + 7-day retention that is ample; under heavy load tighten `OnCalendar` or
  raise the caps.
- **Remote Postgres:** loopback uses `PGSSLMODE=prefer`. If `PGHOST` ever points off-box, set
  `PGSSLMODE=verify-full` + a CA bundle so the connection can't silently fall back to plaintext.
- **Alerting (follow-up):** the worker logs `done reaped=N failed=M`. Wire an `OnFailure=` unit or a journal
  scrape so a persistently failing reap (B2 outage / expired key) pages someone — the 14-day B2 lifecycle
  rule is only a backstop, not primary cleanup.
