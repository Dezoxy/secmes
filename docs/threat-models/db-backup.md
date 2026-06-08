# Threat model: nightly DB backup (encrypted logical dump → B2)

> Status: **DRAFT for ratification.** Roadmap **checkpoint 49** (VM deploy track). A nightly `pg_dump` of the
> whole database, **encrypted client-side** (age) and shipped to a **private EU B2 bucket**, with retention
> pruning. Standalone systemd unit on the VM. No app/API change.

## 1. Feature & data flow

```
systemd timer (daily 02:30 UTC)
  → backup-db.sh  (User=argus, hardened oneshot)
      pg_dump --format=custom   (as argus_backup: read-only, BYPASSRLS, all tenants)
        | age -r <PUBLIC key>    (encrypt BEFORE leaving the box)
        | aws s3 cp -            (→ private B2 bucket, key argus-db-<UTC>.dump.age)
      → verify head-object size → prune backups older than RETENTION_DAYS
```

The dump contains the **whole DB**: message bodies (already MLS ciphertext — the server is crypto-blind) plus
**cleartext metadata** (emails, display names, conversation membership, audit log, public device keys). The
metadata is GDPR-relevant PII. It is encrypted with **age to a public recipient key** before upload, so B2
only ever holds ciphertext. The age **private** key is **not on the VM** — Key Vault only, used at restore.

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
- **Information disclosure — secrets in logs / argv / env.** → libpq `PG*` env (no connstring on argv, so no
  password in `ps`); secrets read from `LoadCredential` files (tmpfs 0400), never in the unit at rest
  (invariant #5); the worker logs object keys / sizes / counts only.
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
- **Denial of availability — silent backup gap.** A backup that quietly stops is the classic DR trap. →
  `Persistent=true` reruns a missed nightly after downtime; the worker exits non-zero on failure for an
  `OnFailure=`/journal alert (flagged as the follow-up). Retention pruning keeps storage bounded so the timer
  never wedges on a full bucket.

## 4. Invariant check

- **#1 crypto-blind** — upheld: the worker never decrypts message content; bodies remain MLS ciphertext in
  the dump. It does read cleartext *metadata* — unavoidable for a DB backup — which is then encrypted at rest.
- **#2 never persist plaintext/secrets off-box** — upheld: the dump is encrypted **before** it leaves the VM;
  B2 holds ciphertext only. No secret is logged; no plaintext dump is written to disk (streamed).
- **#3 RLS** — N/A for new tables (none). The backup role deliberately **bypasses** RLS to dump all tenants —
  scoped to read-only and justified in the migration; it does not weaken any tenant-facing path.
- **#4 no hand-rolled crypto** — upheld: encryption is **age** (a standard, audited tool), not a primitive we
  wrote. Asymmetric (X25519) so the host holds only the public key.
- **#5 secrets via Key Vault** — upheld: DB password, B2 secret, and the age private key all live in Key
  Vault; the unit receives the two runtime secrets as `LoadCredential` files. Only the age **public** key and
  the (non-secret) B2 access-key-**id** ride in env.
- **#6 no admin content path** — upheld: a backup is not an admin surface; nobody reads message *content* from
  it (bodies are ciphertext), and access requires the Key-Vault-held age private key.

## 5. Decision & mitigations

- Migration `0015_db_backup_role.sql`: `argus_backup` — NOLOGIN, NOSUPERUSER, **BYPASSRLS**, INHERIT, granted
  **`pg_read_all_data`** (read-only, covers future tables). LOGIN + password provisioned out-of-band from Key
  Vault (README).
- `infra/backup/backup-db.sh`: streamed `pg_dump | age | aws s3 cp` (no plaintext on disk), `PIPESTATUS`
  failure handling with partial-upload cleanup, size verification, day-granular retention prune. Secrets from
  credential files; libpq `PG*` env.
- `argus-db-backup.{service,timer}`: hardened oneshot (`ProtectSystem=strict`, `MemoryDenyWriteExecute`,
  empty `CapabilityBoundingSet`, …), `LoadCredential` for the two secrets, daily timer with `Persistent=true`.
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
