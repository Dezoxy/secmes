# Message-retention TTL prune worker (Track 4 slice 4 — the v1 deletion)

Standalone VM worker that enforces the **message retention ceiling**: it deletes **messages** older than
**90 days**. This is the only deletion Track 4 ships in v1 — a flat TTL, no per-device delivery gate. Runs
natively on the VM via a **systemd timer** — no Node, no container, no secret, no network egress. It is a
single-table clone of [`infra/audit-prune/`](../audit-prune/) (the proven `argus_prune` pattern).

## What it does

1. Connects to Postgres as the least-privilege **`argus_msg_prune`** role. That role's RLS policies (migration
   [`0044_messages_prune_role.sql`](../../apps/api/src/db/migrations/0044_messages_prune_role.sql)) expose +
   allow `DELETE` on **only messages past the 90-day ceiling** — across tenants, but never an in-window (live)
   row, and through a **column-scoped grant that excludes `ciphertext`**. The window is **database-enforced**:
   a buggy predicate or a leaked `argus_msg_prune` credential still cannot touch an in-window row, and cannot
   read message content (invariant #1, the crypto-blind server). The #262 OR-combine bypass is closed by
   `0044` (the `messages_tenant_isolation` re-scope `TO argus_app`).
2. Deletes in bounded batches (`delete … where id in (select id … limit N)`), looping until none remain.
   Naturally **idempotent** — a crash just leaves rows for the next run.
3. Logs **counts only** — `pruned_messages=N`. Never a row id (invariant #2, threat-model §7 cond 5).
   `messages` rows are ciphertext-bearing; emitting a pruned id would leak conversation/tenant metadata about
   the very content the prune exists to discard.

> **Connection model (same as the audit-prune / backup / cleanup workers).** Postgres publishes **no host
> port** (invariant #3). The worker reaches the DB **in-container** via `docker compose exec -T postgres psql
> …` over the container's local-trust socket. So there is **no DB password** (the role needs only `LOGIN`),
> and `deploy.sh` auto-installs and arms the unit.

## The 90-day ceiling is one reviewed constant

The window literal (`'90 days'`) lives in **two places that must agree**: the `0044` RLS policy predicate (the
DB-enforced floor) and this worker's `prune_table` call. Changing the ceiling is a migration that re-issues
the policy alongside the worker literal — **not** an independent runtime knob. Even if they ever drifted, the
RLS `DELETE` policy is the hard floor: the worker can never delete a row newer than the policy allows.

## No secrets, no egress (hardened stricter than the attachment worker)

This worker uses **no Key Vault secret, no credential file, and no network egress** — it only talks to the
docker socket. So its unit is hardened tighter than `argus-attachment-cleanup`:

- **no** `LoadCredential`, **no** AWS `HOME`/cache `RuntimeDirectory`;
- `RestrictAddressFamilies=AF_UNIX AF_NETLINK` only (the attachment worker also needs `AF_INET`/`AF_INET6`);
- `MemoryDenyWriteExecute=true` (the attachment worker must omit it — AWS CLI v2 maps W+X memory; this worker
  runs no such binary).

## Prerequisite — provision the prune role login

Migration `0044` creates `argus_msg_prune` as **NOLOGIN**. The worker connects **in-container over local
trust**, so it needs **LOGIN but no password**. `deploy.sh` step 5b does this automatically
(`ALTER ROLE argus_msg_prune WITH LOGIN PASSWORD NULL;`), and step 5c probes connectivity so a role that
cannot connect **fails the deploy** rather than silently never running (threat-model §7 cond 2). For a
manual/dev run, as a superuser/owner:

```sql
-- NOT in a tracked migration:
ALTER ROLE argus_msg_prune LOGIN;
```

## Install (on the VM)

> On the real deploy this is **automatic** — `deploy.sh` step 5c stages the script, installs the units + the
> notifier, and `enable --now`s the timer. The steps below are for a **manual/dev** run.

```bash
sudo install -d /opt/argus/retention
sudo install -m 0755 prune-messages.sh /opt/argus/retention/
sudo cp argus-message-retention.{service,timer} /etc/systemd/system/
# The DB is reached in-container via `docker compose exec` (COMPOSE_FILE/COMPOSE_PROJECT_NAME, no PGHOST), so
# the user running the timer must be in the `docker` group (argus already is). psql runs inside the postgres
# container; there is nothing else to configure (no bucket, no key).
sudo systemctl daemon-reload
sudo systemctl enable --now argus-message-retention.timer
# One-off run + logs:
sudo systemctl start argus-message-retention.service
journalctl -u argus-message-retention.service
```

## Deploy verification & tuning

- **Dry-run before enabling the timer:** `systemctl start argus-message-retention`, then check
  `journalctl -u argus-message-retention` — confirm it logs `done pruned_messages=…` and that the
  `docker compose exec` path works under the unit's sandbox as `User=argus` (docker-group) on the VM.
- **Throughput ceiling:** one run prunes up to `PRUNE_BATCH × PRUNE_MAX_ROUNDS` (default 5000 × 200 = 1M)
  rows. With a daily timer the per-run backlog is tiny; raise the caps or tighten `OnCalendar` only if a large
  historical backlog must drain.
- **Off-box Postgres:** the worker reaches PG **in-container** via `docker compose exec` (local trust). If PG
  ever moves off-box, switch to a TCP client with `PGSSLMODE=verify-full` + a CA bundle + a scoped login
  credential — the local-trust shortcut only holds while PG is a co-located container with no published port.
- **Alerting:** on a DB-unreachable / query error the worker exits non-zero and fires
  `OnFailure=argus-notify-failure@` (installed by `deploy.sh` — posts a GlitchTip event). A prune that cannot
  reach the DB must never report success (the BKP-1 lesson).
- **Backups:** the prune bounds **forward** growth. Nightly DB backups taken before a row is reaped still hold
  it; they age out naturally under the B2 backup-bucket retention. There is no retroactive scrub of backups.

## What this worker does NOT touch

- **`conversation_commits`** — deferred to slice 5 (gated on a client missing-commit / sync-lost recovery
  signal that does not exist yet). Pruning the per-conversation max-epoch commit could let a stale/retried
  commit fork MLS history, so its delete needs a DB-enforced never-current-epoch policy + a contiguity check
  the worker does not have. **No `DELETE` grant on `conversation_commits` exists.**
- **`conversation_welcomes`** — every remaining row is an unconsumed Welcome a device still needs to join;
  excluded from this track entirely.
- **Message content** — the column-scoped grant is `(id, created_at)` only; the worker never reads
  `ciphertext`.
