# Audit/session retention prune worker (review finding F1/AR-1)

Standalone VM worker that enforces the **retention windows** the schema promises but never built: it deletes
**audit_events** older than **90 days** and **auth_sessions** expired more than **30 days** ago. Runs natively
on the VM via a **systemd timer** — no Node, no container, no secret, no network egress.

## What it does

1. Connects to Postgres as the least-privilege **`argus_prune`** role. That role's RLS policies (migration
   `0043_audit_prune_role.sql`) expose + allow `DELETE` on **only rows past their retention window** — across
   tenants, but never an in-window row and never any tenant's content. The window is **database-enforced**: a
   buggy predicate or a leaked `argus_prune` credential still cannot touch an in-window row.
2. Deletes each table in bounded batches (`delete … where id in (select id … limit N)`), looping until none
   remain. Naturally **idempotent** — a crash just leaves rows for the next run.
3. Logs **counts only** — `pruned_audit=N pruned_sessions=M`. Never a row id, never `metadata`/`actor_sub`/`ip`
   (invariant #2). `audit_events.metadata` holds pseudonymous lookup history; emitting a pruned id would leak
   the very thing the prune exists to bound.

> **Connection model (same as the backup/cleanup workers, BKP-1).** Postgres publishes **no host port**
> (invariant #3). The worker reaches the DB **in-container** via `docker compose exec -T postgres psql …` over
> the container's local-trust socket. So there is **no DB password** (the role needs only `LOGIN`), and
> `deploy.sh` auto-installs and arms the unit.

## No secrets, no egress (hardened stricter than the attachment worker)

This worker uses **no Key Vault secret, no credential file, and no network egress** — it only talks to the
docker socket. So its unit is hardened tighter than `argus-attachment-cleanup`:

- **no** `LoadCredential`, **no** AWS `HOME`/cache `RuntimeDirectory`;
- `RestrictAddressFamilies=AF_UNIX` only (the attachment worker also needs `AF_INET`/`AF_INET6` for B2);
- `MemoryDenyWriteExecute=true` (the attachment worker must omit it — AWS CLI v2 maps W+X memory; this worker
  runs no such binary).

## Prerequisite — provision the prune role login

Migration `0043` creates `argus_prune` as **NOLOGIN**. The worker connects **in-container over local trust**,
so it needs **LOGIN but no password**. `deploy.sh` step 5b does this automatically
(`ALTER ROLE argus_prune WITH LOGIN PASSWORD NULL;`). For a manual/dev run, as a superuser/owner:

```sql
-- NOT in a tracked migration:
ALTER ROLE argus_prune LOGIN;
```

## Install (on the VM)

> On the real deploy this is **automatic** — `deploy.sh` step 5c stages the script, installs the units + the
> notifier, and `enable --now`s the timer. The steps below are for a **manual/dev** run.

```bash
sudo install -d /opt/argus/audit-prune
sudo install -m 0755 prune-audit.sh /opt/argus/audit-prune/
sudo cp argus-audit-prune.{service,timer} /etc/systemd/system/
# The DB is reached in-container via `docker compose exec` (COMPOSE_FILE/COMPOSE_PROJECT_NAME, no PGHOST), so
# the user running the timer must be in the `docker` group (argus already is). psql runs inside the postgres
# container; there is nothing else to configure (no bucket, no key).
sudo systemctl daemon-reload
sudo systemctl enable --now argus-audit-prune.timer
# One-off run + logs:
sudo systemctl start argus-audit-prune.service
journalctl -u argus-audit-prune.service
```

## Deploy verification & tuning

- **Dry-run before enabling the timer:** `systemctl start argus-audit-prune`, then check
  `journalctl -u argus-audit-prune` — confirm it logs `done pruned_audit=… pruned_sessions=…` and that the
  `docker compose exec` path works under the unit's sandbox as `User=argus` (docker-group) on the VM.
- **Throughput ceiling:** one run prunes up to `PRUNE_BATCH × PRUNE_MAX_ROUNDS` (default 5000 × 200 = 1M) rows
  per table. With a daily timer the per-run backlog is tiny; raise the caps or tighten `OnCalendar` only if a
  large historical backlog must drain.
- **Off-box Postgres:** the worker reaches PG **in-container** via `docker compose exec` (local trust). If PG
  ever moves off-box, switch to a TCP client with `PGSSLMODE=verify-full` + a CA bundle + a scoped login
  credential — the local-trust shortcut only holds while PG is a co-located container with no published port.
- **Alerting:** on a DB-unreachable / query error the worker exits non-zero and fires
  `OnFailure=argus-notify-failure@` (installed by `deploy.sh` — posts a GlitchTip event). A prune that cannot
  reach the DB must never report success (the BKP-1 lesson).
- **Existing backups:** the prune bounds **forward** growth. Nightly backups taken before it shipped still
  hold unbounded audit history; they age out naturally under the 30-day B2 backup-bucket retention. There is
  no retroactive scrub of historical backups.
