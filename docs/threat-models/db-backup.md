# Threat model: nightly DB backup (encrypted logical dump → B2)

> Status: **DRAFT for ratification.** Roadmap **checkpoint 49** (VM deploy track). A nightly `pg_dump` of the
> whole database, **encrypted client-side** (age) and shipped to a **private EU B2 bucket**, with retention
> pruning. Standalone systemd unit on the VM. No app/API change.

## 1. Feature & data flow

```
systemd timer (daily 02:30 UTC)
  → backup-db.sh  (User=argus, hardened oneshot; as argus_backup: read-only, BYPASSRLS, all tenants)
      pg_dumpall --roles-only --no-role-passwords | age -r <PUBLIC key> | aws s3 cp -   → argus-globals-<UTC>.sql.age
      pg_dump --format=custom                      | age -r <PUBLIC key> | aws s3 cp -   → argus-db-<UTC>.dump.age
      → verify each (PIPESTATUS + size floor) → prune backups older than RETENTION_DAYS (one list, shared prefix)
```

Each run writes **two** encrypted objects: the cluster **roles** (definitions + memberships, **no password
hashes** — `--no-role-passwords`) and the **database**. A restore onto a fresh cluster needs the roles first,
because the schema's RLS policies + grants reference `argus_app`/`argus_cleanup`/`argus_backup`. The DB dump
contains message bodies (already MLS ciphertext — the server is crypto-blind) plus **cleartext metadata**
(emails, display names, conversation membership, audit log, public device keys) — GDPR-relevant PII. Both
objects are encrypted with **age to a public recipient key** before upload, so B2 only ever holds ciphertext;
the age **private** key is **not on the VM** — Key Vault only, used at restore. Role **passwords** are never
in the backup — they are re-applied from Key Vault at restore.

## 2. Assets & trust boundaries

- **Assets:** the backup dump (cleartext PII + ciphertext bodies); the `argus_backup` DB credential; the age
  **private** key (decrypts every backup); the B2 application key.
- **Boundaries:** VM ↔ B2 (a third-party cloud — must never see plaintext); VM ↔ Key Vault (Managed Identity);
  the backup role ↔ the rest of the DB (read-only, no write/DDL); operator-at-restore ↔ everyone else (only a
  holder of the age private key can read a backup).

## 3. Threats (STRIDE-lite)

- **Information disclosure — plaintext PII in a third-party cloud.** A dump sitting in B2 readable by B2 (or
  by anyone who gets the bucket) would leak every tenant's metadata. → **Client-side age encryption** before
  upload; B2 stores ciphertext only. Private key in Key Vault, never on the backup host (a host compromise
  cannot decrypt past backups). Bucket is **private** + SSE-B2 as a second layer.
- **Information disclosure — secrets in logs / argv / env.** → The DB connection carries **no secret at all**:
  it runs in-container over the local-trust socket (`docker compose exec`, see §7), so there is no DB password
  on the host and no libpq passfile. The one host-side secret — the B2 key — stays **file-backed**: an AWS
  credentials file in a service-private tmpfs work dir under the systemd `RuntimeDirectory` (0600 — no
  host-disk backing, unlike `PrivateTmp`'s `/tmp`), pointed at by `AWS_SHARED_CREDENTIALS_FILE`, so its VALUE
  is never in the process environment (`/proc/<pid>/environ`) or inherited by children, and never on argv/`ps`;
  the source secret is read from a `LoadCredential` file (tmpfs 0400), never in the unit at rest (invariant
  #5); the worker logs object keys / sizes / counts only.
- **Elevation / tampering — the backup role.** `argus_backup` can read every tenant's data (BYPASSRLS), which
  is the inherent power of a full backup. → Bounded to **read-only** (`pg_read_all_data`, no INSERT/UPDATE/
  DELETE/DDL grant), **NOLOGIN** until provisioned out-of-band, not a superuser — so a leaked backup
  credential can **read** but never **mutate/destroy** data, and the dump it could produce is itself
  encrypted to a key it does not hold.
- **Tampering / integrity — a corrupt or partial backup.** A mid-stream `pg_dump` failure would upload a
  truncated dump. → `PIPESTATUS` checks every pipeline stage; on any non-zero the partial object is deleted
  and the unit exits non-zero (visible failure). A post-upload `head-object` size floor **fails** (deletes
  the object + exits non-zero) on a verified-tiny dump, but only *warns and keeps* if the size can't be read,
  so a transient `head-object` error never false-fails a good backup. The **restore drill** is the real
  integrity test (documented, required by checkpoint 49).
- **Mismatched roles/DB pair.** The roles object and the DB object must come from the **same run**, or a
  restore could combine newer roles (after a role/grant-affecting migration) with an older DB. → Each run is
  **all-or-nothing**: if the DB dump fails after the roles object uploaded, that orphan roles object is
  deleted, so the latest complete pair is always consistent. The restore runbook also pairs **by shared
  timestamp** (pick the latest DB, fetch the roles object with the same stamp) as defence-in-depth.
- **Denial of availability — silent backup gap.** A backup that quietly stops is the classic DR trap. →
  `Persistent=true` reruns a missed nightly after downtime; the worker exits non-zero on failure, which now
  fires the `OnFailure=argus-notify-failure@` notifier (deployed by `deploy.sh` — see §7) to post a GlitchTip
  alert. Retention pruning keeps storage bounded so the timer never wedges on a full bucket.

## 4. Invariant check

- **#1 crypto-blind** — upheld: the worker never decrypts message content; bodies remain MLS ciphertext in
  the dump. It does read cleartext *metadata* — unavoidable for a DB backup — which is then encrypted at rest.
- **#2 never persist plaintext/secrets off-box** — upheld: both objects are encrypted **before** they leave
  the VM; B2 holds ciphertext only. No secret is logged; no plaintext dump is written to disk (streamed). The
  roles object uses `--no-role-passwords`, so even decrypted it contains **no credential material** — role
  passwords are re-applied from Key Vault at restore, never copied into a backup.
- **#3 RLS** — N/A for new tables (none). The backup role deliberately **bypasses** RLS to dump all tenants —
  scoped to read-only and justified in the migration; it does not weaken any tenant-facing path.
- **#4 no hand-rolled crypto** — upheld: encryption is **age** (a standard, audited tool), not a primitive we
  wrote. Asymmetric (X25519) so the host holds only the public key.
- **#5 secrets via Key Vault** — upheld: the B2 secret and the age private key live in Key Vault; the unit
  receives the B2 secret as a `LoadCredential` file. The workers' DB connection uses in-container local trust
  (no password), so no DB credential is delivered or stored for them at all. Only the age **public** key and
  the (non-secret) B2 access-key-**id** ride in env. (The `argus_backup`/`argus_cleanup` DB-password KV
  secrets are now vestigial — see §7.)
- **#6 no admin content path** — upheld: a backup is not an admin surface; nobody reads message *content* from
  it (bodies are ciphertext), and access requires the Key-Vault-held age private key.

## 5. Decision & mitigations

- Migration `0015_db_backup_role.sql`: `argus_backup` — NOLOGIN, NOSUPERUSER, **BYPASSRLS**, INHERIT, granted
  **`pg_read_all_data`** (read-only, covers future tables). `deploy.sh` step 5b grants it **LOGIN with no
  password** (it connects via in-container local trust).
- `infra/backup/backup-db.sh`: a roles dump + DB dump, each `docker compose exec -T postgres pg_dump… | age |
  aws s3 cp` (pg_dump runs in-container as `argus_backup` via local trust; no plaintext on disk), `PIPESTATUS`
  failure handling with partial-upload cleanup + atomic role/DB pairing, size verification, day-granular
  retention prune. The only host-side secret (the B2 key) stays file-backed (AWS credentials file, 0600
  tmpfs) — never exported into the environment.
- `argus-db-backup.{service,timer}`: hardened oneshot (`ProtectSystem=full` — relaxed from `strict` for the
  docker socket — empty `CapabilityBoundingSet`, `NoNewPrivileges`, the full `Protect*`/`Restrict*` set;
  `MemoryDenyWriteExecute` off for the AWS-CLI PyInstaller bundle), one `LoadCredential` (the B2 key), daily
  timer with `Persistent=true`. Runs as `User=argus` (already in the `docker` group — no new privilege).
- Gate: **`security-boundary-auditor`** (BYPASSRLS role least-privilege, no secret in logs, secret delivery)
  + **`infra-reviewer`** (systemd hardening, script robustness); shellcheck; live-DB check of the migration.

## 6. Residual risk

- **Logical, not point-in-time.** Up to ~24h of data can be lost between nightly dumps. Acceptable for the VM
  beta; **PITR** (continuous WAL archiving + base backups) is the enterprise upgrade and the real shape of
  checkpoint 49's "PITR" wording — a follow-up.
- **The age private key is a single point of failure.** Lose it and every backup is unreadable; leak it and
  every backup is readable. Mitigated by Key-Vault-only storage (never on the VM) + access logging; key
  rotation (re-encrypt or roll forward) is a follow-up.
- **`argus_backup` reads all tenant metadata.** Inherent to a full backup; bounded to read-only + a
  provisioned login + an encrypted-at-rest output. Per-tenant logical backups are not a goal for the beta.
- **No off-cloud copy.** Backups live in one B2 bucket/region. A second provider/region copy (3-2-1) is an
  enterprise follow-up; B2 object-lock for ransomware resistance is another.
- **Docker-group membership grants in-container DB access.** PG has no published port; the host workers
  reach it via `docker compose exec` over the container's local-trust socket (see §7). That means anything
  that can talk to the docker socket — i.e. members of the `docker` group, which `argus` already is — can
  `docker exec` into postgres and act as `argus_backup`/`argus_cleanup`/the owner without a password. But
  docker-group membership is *already* root-equivalent on this box (the daemon runs as root and will mount
  any host path, including `pgdata`), so this residual is **fully subsumed** by the pre-existing
  docker-group-as-root posture — the worker exercises standing privilege, it gains none. PG itself is never
  reachable off-box (no published port; `compose-guard` enforces zero ports). The enterprise shape (PG on a
  separate host / managed PG over `verify-full` TLS with a scoped credential) is the eventual hardening.

## 7. Deployment wiring & connectivity (BKP-1 remediation)

The original units were sound but **never actually deployed**: the CD tar omitted `infra/backup` +
`infra/cleanup`, `deploy.sh` enabled only `argus-secrets.service`, and the host units connected to
`127.0.0.1:5432` — but Postgres publishes **no host port** (the `compose-guard` CI job forbids any published
port, invariant #3), so even a manually-armed timer could never connect. This was finding **BKP-1 (P1)** in
the security-review campaign (`docs/reviews/06-infra-deploy.md`, which prescribes exactly an "in-Compose-
network DB path, not a published port"). Closed by:

- **Both CD tracks bundle the workers + the notifier** — `infra/backup` + `infra/cleanup` + `infra/notify`
  are added to the deploy tar in `cd.yml` and `cd-aws.yml` (the AWS experiment self-hosts the same compose
  Postgres — no RDS — so one fix covers both).
- **`deploy.sh` stages, wires, and arms them** (new step 5c, right after the runtime role logins exist):
  copies the scripts to `/opt/argus/{backup,cleanup,notify}`, installs the `.service`+`.timer` units **and
  the `argus-notify-failure@.service` template** (the `OnFailure=` target both workers reference — so a
  nightly failure raises a GlitchTip alert instead of vanishing), substitutes the `REPLACE_WITH_*`
  placeholders on the installed copies from **non-secret** deploy env. Each worker gets the B2 credential
  scoped to the bucket it touches (least-privilege; no reliance on the over-broad cross-bucket key — BKP-2):
  the **backup** worker → `B2_APP_KEY_ID` + the db-backups `argus-b2-app-key` secret; the **cleanup** worker →
  `S3_ACCESS_KEY_ID` + the attachment `argus-s3-secret-access-key` secret (the same key the api manages
  attachments with). The buckets are templated too (backup → `BACKUP_S3_BUCKET`; cleanup → the api's
  `S3_BUCKET`), and the **public** `BACKUP_AGE_RECIPIENT` is set on the backup worker. Then `enable --now` both
  timers.
- **In-network connectivity (no published port)** — the workers reach PG via `docker compose exec -T postgres
  pg_dump/psql …` over the container's local-trust socket, reusing the pattern `deploy.sh` already uses for
  role provisioning. `argus` is in the `docker` group (cloud-init), so this grants **no new privilege**. PG
  stays entirely on the internal Docker network; `compose.prod.yaml` publishes nothing and `compose-guard`
  passes unchanged. The DB connection authenticates as the least-privilege role via local trust — so the
  `backup-db-password`/`cleanup-db-password` Key Vault secrets are now **vestigial** (workers no longer read
  them; only `argus_app`, which connects over TCP, still has a password). Retiring those two KV secrets is a
  follow-up (a secret-rotation-class cleanup, not done here).
- **Fail-closed connectivity gate** — the deploy probes the *novel* blocker the finding flagged, via the
  **same** path the worker uses: `docker compose exec -T postgres psql -U argus_backup -d argus -c 'select 1'`,
  and **aborts the deploy** if it can't connect. It deliberately does **not** run a full encrypt+upload at
  deploy time — gating app rollout on a B2 round-trip would couple releases to backup-bucket IAM and a
  transient B2 outage. The full chain (`pg_dump` → age → B2 → retention prune) runs on the nightly timer;
  its failure is now surfaced by the `OnFailure=` notifier, so a broken backup can no longer ship — or run —
  silently. (The deploy probe runs as root; the sandboxed `argus`-user unit's docker access is exercised on
  the first nightly run, with `OnFailure` alerting if it regresses — the same VM-only-validation caveat the
  README already carries for the AWS-CLI dry-run.)
- **`MemoryDenyWriteExecute` dropped from the two AWS-CLI workers.** AWS CLI v2 is a PyInstaller bundle that
  maps memory W+X; MDWE would segfault it and silently break the backup. Removed from
  `argus-db-backup.service` + `argus-attachment-cleanup.service` (the README's documented fallback); the
  notifier keeps MDWE (bash/curl/openssl are MDWE-safe). The two workers also relax `ProtectSystem` from
  `strict` to `full` so the docker client can reach `/run/docker.sock`; all other hardening directives remain
  (empty `CapabilityBoundingSet`, `NoNewPrivileges`, the `Protect*`/`Restrict*` set), and the privileged work
  is the daemon's, not the unit's.
