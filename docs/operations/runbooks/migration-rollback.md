# Migration rollback runbook

What to do when a database migration breaks production. The schema migrations are **forward-only** —
there are no `down` scripts — so recovery is **restore-based and human-driven**, never an automatic
reverse migration. This runbook picks the cheapest safe recovery for the situation and spells out the
data-loss trade-off of each.

> Status (2026-06-21): written as part of Track 3 ops hardening. The recovery paths below reuse the
> already-shipped signed+encrypted backup/restore machinery — this runbook adds **no code**, only the
> procedure. Rehearse it (last section) before you need it for real.

## The migration model (and why there is no "down")

`apps/api/src/db/migrate.ts` is a minimal forward-only runner:

- It applies every `*.sql` in `apps/api/src/db/migrations/` (currently 44 files, head `0043`) **not yet
  recorded** in the `schema_migrations` table, in filename order, serialized by `pg_advisory_lock(4927)` so
  two concurrent deploys can't race. (Migrations are keyed by **filename**, so a restore that re-runs
  `db:migrate` re-applies any file not in `schema_migrations` — see recovery path C.)
- **Each migration runs in its own transaction** (`sql.begin` → `tx.unsafe(ddl)` → `insert into
  schema_migrations`). PostgreSQL DDL is transactional, so a migration that **errors rolls itself back**
  and is **not** recorded — the schema is left exactly as it was.
- On deploy, migrations run as the **owner** (file-mounted DSN) **before the new API serves**
  (`infra/stack/deploy/deploy.sh` step 5), after the old API is stopped (step 4b).

There are deliberately **no down-migrations** and no reversible-migration framework: migrations land ~once
per slice, and a tested restore is simpler and already exists. A "rollback" therefore means **restore a
good database state, then roll forward with a fix** — not run a reverse script.

## Which recovery path? (decide first)

| Situation | What happened to the schema | Recovery | Data loss |
| --- | --- | --- | --- |
| **Migration failed** (deploy aborted at step 5) | Unchanged — the failed migration's transaction rolled back | **A** — fix the migration, redeploy | None |
| **Migration succeeded, app breaks, change was backward-compatible** (additive: new nullable column/table/index) | Changed, but the previous image still works against it | **B** — roll the app image back, then fix forward | None |
| **Migration succeeded, app breaks, change was NOT backward-compatible** (dropped/renamed/retyped a column, tightened a constraint) | Changed in a way the old image can't use | **C** — restore from backup, then redeploy a corrected image | **Back to the last snapshot** |

Prefer A, then B, then C. Only C loses data — reach for it only when the schema change can't be tolerated
by any deployed image.

## Before a risky migration: take a checkpoint

The nightly backup is at most ~24h old, so a plain restore (path C) can lose up to a day of writes. Before
a migration you consider risky (anything destructive — `DROP`/`ALTER ... TYPE`/`NOT NULL` on existing
data), take a **fresh restore point first** by running the existing backup worker once, on the VM:

```bash
sudo systemctl start argus-db-backup.service      # one-shot; the nightly timer stays armed
journalctl -u argus-db-backup.service -n 30        # expect: "uploaded argus-globals-…", "uploaded argus-db-…", then "done … marker=argus-ok-…"
```

This reuses the blessed path — an off-host, WORM (B2 Object Lock), **age-encrypted and Ed25519-signed**
pair — so it adds **no new code and writes no cleartext to disk**. Confirm the **success marker** line
before migrating; without it the run isn't restore-eligible. (Same one-shot run documented in the backup
worker's [`infra/backup/README.md`](../../../infra/backup/README.md) *Install* section. On a **first** deploy
there is nothing to check-point — the database and the `argus_backup` role don't exist yet.)

## Recovery A — failed migration (schema intact)

The deploy aborted with `FATAL: migrations failed — NOT serving the new image`. Because the migration's
transaction rolled back, the schema still matches the previous release and the old API can be brought back.

1. **Restore service first.** The deploy stopped the old API before migrating (step 4b) and exited on the
   failure **without restarting it**, so `/api` is currently **down**. The previous container still holds the
   old image and the schema is intact, so bring it straight back: `docker compose -f <compose> start api` on
   the box. The site is up again — now you can fix forward without time pressure.
2. Read the failure: `gh run view <run-id> --log | grep -B5 -A20 "migration failed"` (or the SSM command
   output) — it prints the migrations applied so far (`+  00NN_… applied`) and the Postgres error message
   (message only, never the DSN). The failing file is the **next** one in filename order after the last
   `applied` line (the runner doesn't echo the in-flight filename before it errors).
3. Fix the migration **in a new branch** and merge it. If the file was never applied anywhere, correcting
   the same `0044_*.sql` is fine; if any environment already applied it, ship a **new** `0045_*.sql` that
   corrects forward (never edit an already-applied migration).
4. Re-deploy. `db:migrate` is idempotent — it skips the already-applied files and applies the fix.

No restore, no data loss.

## Recovery B — roll the app image back (no data loss)

The migration applied and is backward-compatible (purely additive), but the new image is misbehaving.
Re-point production at the previous known-good image; it runs fine against the additive schema.

1. Identify the last good release tag (`git tag --list 'aws-v*' | sort -V | tail`).
2. Re-deploy that tag. The migrate step is a no-op (those migrations are already recorded), and the older
   image serves against the additive columns it simply doesn't use.
3. Fix the new image forward and re-release when ready.

No restore, no data loss. If the old image **errors** against the new schema, the change wasn't actually
backward-compatible — go to path C.

## Recovery C — restore from backup (data loss to the last snapshot)

The schema change is incompatible with every deployed image. Restore the most recent **good** backup taken
**before** the bad migration, then roll forward with a corrected image.

> **Honest semantics.** These are **nightly logical snapshots, not point-in-time recovery.** Restoring
> means **every write since that snapshot is lost** (messages relayed, friend requests, profile edits). The
> pre-migration checkpoint above is what keeps that window to minutes instead of hours; if you didn't take
> one, the most recent backup is last night's. Continuous PITR (WAL archiving) is the enterprise-grade
> upgrade, noted in `docs/threat-models/db-backup.md`.

1. **Stop the API** so nothing writes to the doomed schema (a redeploy already stops the old API at step
   4b; otherwise `docker compose -f <compose> stop api` on the box).
2. **Restore the pre-migration pair** by following the **Restore runbook in
   [`infra/backup/README.md`](../../../infra/backup/README.md)** verbatim — do not improvise. It fetches
   the age private key from Key Vault, **verifies the Ed25519 signature** and re-hashes both objects against
   the signed manifest, then restores **roles first, then the database** into a fresh `argus_restore`
   database. **Set `COMPROMISE_BEFORE` to an instant just before the bad migration/deploy** (e.g. the
   deploy's start time). Otherwise the picker takes the *newest* valid pair — and if the nightly timer (or an
   operator checkpoint) ran *after* the bad migration, that pair already contains the bad schema, so you'd
   restore the very state you're rolling back. (Leaving it unset is safe only if you're certain no backup ran
   after the bad migration. The same anchor is the compromise-rollback control in `infra/backup/README.md`;
   here it selects the pre-migration snapshot.) If you took the pre-migration checkpoint above, that stamp is
   the target — confirm the selected pair's stamp matches it.
3. **Confirm the restored schema is at the pre-bad-migration version:** `select version from
   schema_migrations order by version desc limit 5;` — the bad migration must **not** be listed.
4. **Roll forward with the fix.** The bad migration must be **corrected in source before you re-run
   `db:migrate`**, or the runner will simply re-apply the same broken file. Either land a corrected
   replacement (if it was never applied beyond this cluster) or, preferably, a **new** forward migration
   that does the right thing. Then deploy the corrected image; its migrate step brings the restored DB up to
   the fixed head before serving (the same ordering note at the end of the restore runbook).

## Why no automatic down-migrations, and no auto-checkpoint in `deploy.sh`

Both are deliberate, recorded here so a future change doesn't "helpfully" add them:

- **No reverse migrations.** An automatic `down` that drops a column or table is itself a destructive
  operation run unattended — exactly the failure mode this runbook exists to recover from. Recovery stays
  restore-based and human-driven (the doc that scopes this track says the same).
- **No automatic pre-migration backup wired into `deploy.sh`.** Three reasons: (1) the deploy intentionally
  does **not** couple app rollout to a Backblaze round-trip — it gates only on DB reachability
  (`deploy.sh` ~lines 466-487) so a transient B2 outage can't block a release; (2) `argus_backup` and its
  login are **created by the migrations + provisioned at step 5b/5c, after** the migrate step, so a
  pre-*first*-migrate auto-backup is impossible; (3) it's an arming-time change that can only be exercised
  on a real VM. The **operator checkpoint** above gives the same fresh restore point on demand, without
  putting B2 on the deploy's critical path. Auto-wiring it (best-effort, redeploy-only) remains a possible
  future follow-up.

## Rehearse it (dry-run drill — do this before you trust it)

Prove the round-trip on a disposable local database, mirroring the failure → restore → roll-forward loop.
Uses the local stack (`make up` → docker Postgres on `:5432`, DSN
`postgres://argus:argus_local_dev@localhost:5432/argus`).

1. `make up && make migrate` — bring the schema to head (`0043`).
2. Snapshot the "good" state: `pg_dump "$DSN" -Fc -f /tmp/pre.dump` (the drill stand-in for the signed B2
   pair — the real recovery uses `infra/backup/README.md`).
3. Simulate a bad migration: apply a destructive statement by hand, e.g.
   `psql "$DSN" -c 'alter table messages drop column ciphertext;'` (an obviously app-breaking change).
4. Recover (path C in miniature): `dropdb`/`createdb` a fresh DB and `pg_restore` `/tmp/pre.dump` into it,
   re-point `$DSN`, then confirm `messages.ciphertext` is back and `schema_migrations` is at `0043`. (The
   drill skips restoring roles — Postgres roles are cluster-global and survive the local `dropdb`/`createdb`;
   a **production** fresh-cluster restore must recreate the roles first, per `infra/backup/README.md` step 2.)
5. Roll forward: re-run `make migrate` — it's a no-op (all files recorded), proving the runner is idempotent
   after a restore.

Record the wall-clock time; that's your real RTO for path C.

## Quick reference

| Symptom | Path | One-liner |
| --- | --- | --- |
| Deploy aborted: `migrations failed — NOT serving` | A | Fix the migration, redeploy (schema untouched) |
| New image misbehaves; migration was additive | B | Redeploy the previous `aws-v*` tag |
| New image broke; schema change is destructive/incompatible | C | Restore per `infra/backup/README.md`, then redeploy a corrected image |
| About to run a destructive migration | — | `sudo systemctl start argus-db-backup.service` first (fresh restore point) |
