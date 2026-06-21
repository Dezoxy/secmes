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
| **Migration failed** (deploy aborted at step 5) | The failed file rolled back, but **earlier files in the same batch already committed** — so "unchanged" only if it was the lone/first pending file | **A** — check what applied, fix, redeploy (→ B/C if an applied file is incompatible) | None (if applied files are backward-compatible) |
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

## Recovery A — failed migration (schema intact, or only backward-compatible files applied)

The deploy aborted with `FATAL: migrations failed — NOT serving the new image`. The **failing** migration's
transaction rolled back — but a deploy applies **all pending** files, each in its own transaction, so any
**earlier** files in the batch already committed. Check what actually landed before assuming the old image is
safe to restart.

1. **See what actually applied.** Get the authoritative list from the DB (the source of truth, however many
   files committed): `docker compose -f <compose> exec -T postgres psql -U argus -d argus -c "select version
   from schema_migrations order by version;"`. Cross-check the deploy log for the error and the in-flight
   file: `gh run view <run-id> --log | grep -E '\+ .*applied|migration failed'` — this filters **every**
   applied line plus the Postgres error (message only, never the DSN); don't use a fixed `-B`/`-A` window,
   which truncates a large batch. The **failing** file is the next one in filename order after the last
   recorded migration (the runner doesn't echo the in-flight name before it errors).
2. **Restore service — if it's safe.** The deploy stopped the old API (step 4b) and exited without restarting
   it, so `/api` is **down**.
   - If **nothing** applied (the failing file was the only/first pending one), the schema is unchanged →
     restart the previous image: `docker compose -f <compose> start api` on the box.
   - If **earlier files in the batch committed**, the schema is *partially advanced*. Restart the old image
     **only if every applied file is backward-compatible** (purely additive). If any applied file is
     destructive/incompatible, the old image is unsafe against the partial schema → go to **path B or C**
     instead of restarting.
3. Fix the failing migration **in a new branch**. If it was never applied anywhere, correcting the same
   `0044_*.sql` is fine; if any environment already applied it, ship a **new** `0045_*.sql` that corrects
   forward (never edit an already-applied migration).
4. Re-deploy. `db:migrate` is idempotent — it skips the already-committed files and applies the rest.

No restore, no data loss (when the applied files are backward-compatible).

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

1. **Quiesce every DB writer — not just the API.** Stopping `api` alone isn't enough: the VM's systemd
   timers (attachment-cleanup, audit-prune, and the nightly backup) connect to `argus` and issue DELETEs or
   hold connections — one firing mid-restore can break the `ALTER DATABASE … RENAME` (active connection) or
   mutate the restored DB before the corrected rollout. Stop the API (a redeploy already did, at step 4b)
   **and** the timers, then confirm none is mid-run:
   ```bash
   docker compose -f <compose> stop api      # if a redeploy hasn't already
   sudo systemctl stop argus-db-backup.timer argus-attachment-cleanup.timer argus-audit-prune.timer
   systemctl is-active argus-db-backup.service argus-attachment-cleanup.service argus-audit-prune.service
   ```
   Re-arm the timers only **after** the corrected deploy is healthy (end of step 5).
2. **Select, verify, and decrypt the pre-migration pair on a TRUSTED HOST — not the VM.** The age private
   key must never touch the production box (a compromised VM must not be able to read backups). On your
   workstation run **only the selection + verification + decryption part** of the Restore runbook in
   [`infra/backup/README.md`](../../../infra/backup/README.md) — its **step 1** (set `EP`/`BUCKET`, check the
   pinned verify key, fetch the age key from Key Vault, then walk newest-first to the pair whose **Ed25519
   signature verifies** and whose objects re-hash to the signed manifest). **Set `COMPROMISE_BEFORE` to an
   instant just before the bad migration/deploy** — otherwise the walk takes the *newest* valid pair, and if
   the nightly timer (or an operator checkpoint) ran *after* the bad migration that pair already contains the
   bad schema, so you'd restore the very state you're rolling back. (Leaving it unset is safe only if you're
   certain no backup ran after the bad migration; the same anchor is the compromise-rollback control. If you
   took the pre-migration checkpoint above, confirm the selected stamp matches it.) Step 1 leaves `backup.dump`
   (decrypted) and `globals.sql.age` (still encrypted) on the workstation; **do NOT run the runbook's
   steps 2–5 here** — those load into the *workstation's* cluster and then shred the key + dump. Instead, write
   the globals to a file and drop the key before transferring plaintext:
   ```bash
   age -d -i age.key globals.sql.age > globals.sql   # the runbook normally pipes this straight into psql
   shred -u age.key                                  # age key no longer needed off-box; remove it now
   ```
3. **Move the decrypted dump to the VM (via SSM, not SSH) and restore it into the production cluster.** The
   box has **no inbound SSH** (SSM-only; `admin_cidr = null` in `infra/aws/terraform/network.tf`, and the
   deploy doc operates the box "no SSH"), so don't `scp` over the public network, and **do NOT stage the
   decrypted dump in S3/object storage** — cleartext PII at rest off-box defeats the
   encrypt-before-it-leaves-the-box model the backups exist to uphold. Instead tunnel through **SSM Session
   Manager** to the box's local sshd (the SG stays SSH-closed; the tunnel reaches `localhost:22` on the
   instance) and `scp` through it — the plaintext exists only in transit and on the two hosts:
   ```bash
   # The SG opens NO inbound SSH; sshd runs on the Ubuntu AMI but has NO authorized keys (no key_name /
   # ssh_authorized_keys in infra/aws/terraform), so push a SHORT-LIVED key via EC2 Instance Connect, then
   # tunnel + scp inside its ~60s window:
   ssh-keygen -t ed25519 -N '' -f /tmp/restore_key
   aws ec2-instance-connect send-ssh-public-key --instance-id <id> --availability-zone <az> \
     --instance-os-user ubuntu --ssh-public-key file:///tmp/restore_key.pub
   aws ssm start-session --target <id> --document-name AWS-StartPortForwardingSession \
     --parameters '{"portNumber":["22"],"localPortNumber":["2222"]}' &
   scp -P 2222 -i /tmp/restore_key globals.sql backup.dump ubuntu@localhost:/var/tmp/
   shred -u /tmp/restore_key /tmp/restore_key.pub
   ```
   (Verify the os-user / AZ / AMI specifics against the running instance; the fully-verified transfer belongs
   in the canonical in-place restore cutover in `infra/backup/README.md`. Never stage the decrypted dump in
   S3.) The files are plaintext
   metadata — the same sensitivity as the live DB already on that box — and the **age private key stays on the
   trusted host**. On the VM, load roles then `pg_restore` into a **fresh `argus_restore`** in the production
   Postgres over the local socket as the **owner** (`-U argus`, the role `deploy.sh` uses; PG has no published
   port — invariant #3):
   ```bash
   docker compose -f <compose> exec -T postgres psql -U argus -d postgres < /var/tmp/globals.sql   # roles first
   docker compose -f <compose> exec -T postgres createdb -U argus argus_restore
   docker compose -f <compose> exec -T postgres pg_restore -U argus -d argus_restore < /var/tmp/backup.dump
   docker compose -f <compose> exec -T postgres psql -U argus -d argus_restore \
     -c "select version from schema_migrations order by version desc limit 5;"   # the bad migration must NOT be listed
   ```
   **Role-drift caveat:** Postgres roles are **cluster-global** — the database rename below does *not* reset
   them, and the `--roles-only` dump is additive (`CREATE`/`ALTER`/`GRANT`, not a cleanup script that emits
   `DROP`s). So if the bad migration changed cluster-global role state (a new membership or attribute — e.g. an
   elevated `GRANT … TO argus_app`), an in-place restore does **not** undo it. If the bad migration touched
   roles/grants, either restore into a **fresh cluster/volume** (roles start empty) or explicitly **reconcile
   the affected roles** (revoke the drift) before cutover — don't assume the rename cleaned it.
4. **Cut the restored DB into place.** The stack connects to the `argus` database (the Key Vault DSNs end
   `…:5432/argus`); if you skip this, `deploy.sh` runs `db:migrate` against the still-bad `argus` and the
   restored snapshot is never used. With every writer stopped (step 1) and no connections to either DB, rename
   the bad one aside and promote the restore (owner over the postgres socket):
   ```sql
   ALTER DATABASE argus         RENAME TO argus_bad_<stamp>;   -- keep the bad DB for forensics; drop it later
   ALTER DATABASE argus_restore RENAME TO argus;
   ```
   (Both renames need **zero** active connections to either database.) Then re-apply role logins per
   `infra/backup/README.md` step 4 (argus_app's password from Key Vault; argus_backup/argus_cleanup
   LOGIN-only) and **securely delete the plaintext dumps on BOTH ends** — on the VM
   (`shred -u /var/tmp/globals.sql /var/tmp/backup.dump`) and on the trusted host (`shred -u globals.sql
   backup.dump` where you created them; the age key was already shredded in step 2). They hold the same
   cleartext PII as the live DB, so don't leave them behind.
5. **Roll forward with the fix.** The restored cluster's `schema_migrations` does **not** contain the bad
   migration, so the forward-only runner **will re-apply that exact file** on the next deploy — a new
   `0045_*.sql` won't save you, because `0044` runs first. You must therefore **correct the bad migration
   file itself** (`0044_*.sql`) so it's safe when it re-runs, then deploy the corrected image; its migrate
   step brings the restored DB to the fixed head before serving. (Single-VM caveat: editing an already-shipped
   migration is normally forbidden because other clusters may have applied it — but here there is **one**
   cluster and it no longer has `0044` recorded, so correcting the file is the right move. In a multi-cluster
   world you'd instead deploy an image whose migration set is corrected for every cluster.) Once the
   corrected deploy is healthy, **re-arm the timers stopped in step 1**:
   `sudo systemctl start argus-db-backup.timer argus-attachment-cleanup.timer argus-audit-prune.timer`.

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
| Deploy aborted: `migrations failed — NOT serving` | A | Check what applied; restart old image only if applied files are backward-compatible, then fix + redeploy |
| New image misbehaves; migration was additive | B | Redeploy the previous `aws-v*` tag |
| New image broke; schema change is destructive/incompatible | C | Restore per `infra/backup/README.md`, then redeploy a corrected image |
| About to run a destructive migration | — | `sudo systemctl start argus-db-backup.service` first (fresh restore point) |
