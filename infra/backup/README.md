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
   Then, only after **both** uploaded and cleared their size floors, a tiny `argus-ok-<UTC>.age` **success
   marker** — the run's commit point. Under WORM a failed run's partial dump can't be deleted, so the marker
   (absent on any failed run) is what makes a complete run **restore-eligible**; restore requires it.
3. Verifies each upload (PIPESTATUS + size floor). It does **not** prune: the backup bucket is **WORM** (B2
   Object Lock, Compliance mode — BKP-2), and the backup key has **no delete capability**, so old backups are
   reaped by a server-side **B2 lifecycle rule** (prefix `argus-`, ~35 days), not by this script. A
   partial/corrupt or orphaned object can't be deleted either — it is left in place (age-ciphertext, leaks
   nothing), reaped by the lifecycle rule and **skipped at restore** (no success marker + size floor +
   version/timestamp pairing).
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

### 3. Backup signing key (signed backups)

A second keypair gives the backups **authenticity**, not just confidentiality. `age` encrypts to a **public**
recipient, so anyone who can write to the bucket can produce a structurally-valid, decryptable dump — the
restore step can't tell a forgery from a real backup. To close that, the worker **signs** each object with an
Ed25519 private key the bucket-writer doesn't have, and restore **verifies** the signature before trusting (or
decrypting) a candidate.

- **Private signing key** — `argus-backup-signing-key` (Ed25519 PKCS8 PEM) in **Key Vault**, generated by
  `populate-keyvault.sh` (or the manual one-liner in `docs/threat-models/session-tokens.md §invariant-4` with
  this name). It is delivered to the worker as a **credential file** via systemd `LoadCredential` (same as the
  B2 secret) — it must be on the backup host to sign nightly, so unlike the age key it is *not* Key-Vault-only.
- **Public verify key** — committed, **non-secret**, at [`backup-verify.pub`](backup-verify.pub). After
  generating the private key, derive and commit the public half:
  ```bash
  az keyvault secret show --vault-name <vault> --name argus-backup-signing-key --query value -o tsv \
    | openssl pkey -pubout   # paste into infra/backup/backup-verify.pub, then commit
  ```
  Restore reads the verify key from the repo (tamper-evident in git), never from the bucket an attacker could
  write. Verification **fails closed** against the un-replaced placeholder (rejected by content with a legible
  "verify key not populated", not a generic parse error), and the restore host needs **OpenSSL ≥3.0** (the
  runbook preflights this — LibreSSL/1.1.1 can't verify Ed25519 `-rawin`).
- **Key rotation** — `backup-verify.pub` may hold **multiple** PEM blocks (current + previous): restore tries
  each, so a backup signed by either verifies during the rollover. The file is a keyring, not a single key. When
  rotation is complete and no live backup is still signed by the old key, **delete the retired block and
  commit** — leaving a compromised-then-rotated-out key in the file keeps its signatures acceptable forever.

> **Upgrade ordering (existing deployments):** `argus-backup-signing-key` is a **mandatory** fetched secret, so
> run `populate-keyvault.sh` (no `--rotate` — it skip-creates only the missing key) **before** pulling this
> change and redeploying. Otherwise the boot-time secret fetch 404s on the new key and fails closed.

> The worker **signs** at write time and **restore verifies** (signed backups, complete): each run uploads a
> signed manifest marker (`argus-ok-<stamp>.age` + `.age.sig`) binding both objects by SHA-256; the restore
> runbook below rejects any candidate whose signature doesn't verify under the pinned `backup-verify.pub`, or
> whose objects don't re-hash to the signed digests. The key reaches the unit via `LoadCredential=backup-sign-key`
> (`BACKUP_SIGN_KEY_FILE`). Signatures stop **forgery** by the bucket-writer; **rollback** to a genuine older
> backup still anchors on the `COMPROMISE_BEFORE` timestamp (signatures authenticate provenance, not freshness).
> Threat model: `docs/threat-models/db-backup.md`; the Ed25519-signing-outside-`packages/crypto` boundary follows
> the ratified precedent in `docs/threat-models/session-tokens.md §invariant-4`.

### 4. B2 bucket

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

# 1a. Backup-SIGNATURE verification setup. Run this from your argus checkout's infra/backup/ dir (or copy
#     backup-verify.pub next to where you run), so VERIFY_KEY reads the PINNED public key from the REPO — never
#     from the bucket an attacker could write. Requires OpenSSL >=3.0 on THIS host (LibreSSL/1.1.1 can't do
#     Ed25519 -rawin); the preflight below aborts legibly rather than fail-closing on every candidate.
VERIFY_KEY="${VERIFY_KEY:-backup-verify.pub}"
OPENSSL="${OPENSSL:-openssl}"   # override if your default openssl is LibreSSL: OPENSSL=/path/to/openssl@3/bin/openssl
[[ -s "$VERIFY_KEY" ]] || { echo "FATAL: verify key $VERIFY_KEY missing/empty — copy infra/backup/backup-verify.pub here"; exit 1; }
# Fail closed on the un-populated placeholder, BY CONTENT, so the operator sees a clear message (not a parse error).
if grep -q 'REPLACE_WITH_' "$VERIFY_KEY"; then
  echo "FATAL: $VERIFY_KEY is the un-replaced placeholder — populate the verify key (see §'Backup signing key') before restoring"; exit 1
fi
# Split the keyring into one file per PEM block: `openssl pkeyutl -verify -inkey <file>` reads only the FIRST
# block, so a concatenated current+previous keyring MUST be split and each block tried. (CRLF-tolerant.)
VK_DIR="$(mktemp -d)" || { echo "FATAL: mktemp failed"; exit 1; }
awk -v d="$VK_DIR" '
  { sub(/\r$/, "") }
  /-----BEGIN PUBLIC KEY-----/ { n++; f=d "/blk." n }
  f { print > f }
  /-----END PUBLIC KEY-----/   { if (f) close(f); f="" }
' "$VERIFY_KEY"
vk_blocks=$(find "$VK_DIR" -name 'blk.*' | wc -l | tr -d ' ')
[[ "$vk_blocks" =~ ^[0-9]+$ && "$vk_blocks" -ge 1 ]] || { echo "FATAL: $VERIFY_KEY has no usable PUBLIC KEY block"; rm -rf "$VK_DIR"; exit 1; }
# Preflight: this host's openssl must be able to VERIFY an Ed25519 -rawin signature, or every candidate would
# fail-closed and look identical to "no good backup exists". Sign+verify a probe with an ephemeral key.
_pf="$(mktemp -d)" || { echo "FATAL: mktemp failed"; rm -rf "$VK_DIR"; exit 1; }
if ! "$OPENSSL" genpkey -algorithm Ed25519 -out "$_pf/k" 2>/dev/null \
  || ! "$OPENSSL" pkey -in "$_pf/k" -pubout -out "$_pf/k.pub" 2>/dev/null \
  || ! printf 'argus-restore-verify-preflight' >"$_pf/m" \
  || ! "$OPENSSL" pkeyutl -sign -rawin -inkey "$_pf/k" -in "$_pf/m" -out "$_pf/s" 2>/dev/null \
  || [[ "$(wc -c <"$_pf/s" 2>/dev/null || echo 0)" -ne 64 ]] \
  || ! "$OPENSSL" pkeyutl -verify -rawin -pubin -inkey "$_pf/k.pub" -sigfile "$_pf/s" -in "$_pf/m" >/dev/null 2>&1; then
  rm -rf "$_pf" "$VK_DIR"
  echo "FATAL: openssl '$OPENSSL' cannot verify Ed25519 -rawin signatures (needs OpenSSL >=3.0; LibreSSL/1.1.1 lack it). Set OPENSSL=/path/to/openssl@3 or restore on a host with OpenSSL 3."; exit 1
fi
rm -rf "$_pf"
echo "verify key OK: ${vk_blocks} pinned key block(s), openssl Ed25519 -rawin preflight passed"

# 1b. Pick the newest VALID backup pair — VERSION-AWARE. This is the recovery path that ransomware resistance
#     depends on, so it must reach a good LOCKED version even when a newer one shadows it.
#     Why versions, not key names: Object Lock requires versioning and protects each VERSION, not the key name.
#     A compromised VM/B2 key still has writeFiles — it can upload junk as a NEW (current) version of every
#     argus-db-*/argus-globals-* key. The good backups survive as LOCKED non-current versions (un-deletable —
#     WORM holds), but a key-NAME lookup (`list-objects-v2` / `s3 cp` by name / `head-object` without
#     --version-id) returns only the attacker's CURRENT junk. So enumerate VERSIONS (`list-object-versions`)
#     and download by explicit --version-id, walking newest-first and accepting the first DB version whose run
#     is AUTHENTIC and complete: (a) clears the 1024-byte size floor, (b) has a SUCCESS MARKER argus-ok-<stamp>
#     whose .sig VERIFIES under the pinned keyring (backup-verify.pub) — existence is NO LONGER enough; the gate
#     is an Ed25519 signature the bucket-writer can't forge, over a manifest that pins BOTH objects by SHA-256,
#     (c) the db object's ciphertext re-hashes to the SIGNED digest AND decrypts (age STREAM auth rejects a
#     mid-stream-truncated upload) with a valid TOC, and (d) has a paired argus-globals-<stamp> VERSION whose
#     ciphertext re-hashes to the SIGNED globals digest AND decrypts. The walk skips past any
#     junk/shadow/failed/FORGED versions to the newest good signed pair.
#     CAVEAT: `pg_restore --list` checks STRUCTURE, not completeness; signature + marker exclude FAILED and
#     FORGED runs, but a pg_dump that exits 0 yet is logically short (rare) would still pass — the full restore
#     drill below (step 3 + sanity check) is the definitive data-completeness test.
#     Shadowing by junk versions makes the good pair OLDER, not wrong — staleness is the exposure, and
#     OnFailure surfaces a flapping backup (see "Denial of availability" in the threat model).
#     FRESHNESS CAVEAT (why COMPROMISE_BEFORE still matters AFTER signing): the signature authenticates
#     PROVENANCE ("our worker made this"), NOT FRESHNESS ("this is the latest"). A genuine OLD signed pair
#     verifies forever, so a writeFiles attacker can ROLLBACK by re-uploading a genuine pre-compromise pair as
#     the current version — every signature/digest check passes. The only anti-rollback anchor is the B2-set
#     upload time (`LastModified`), which the attacker cannot backdate. So in a SUSPECTED COMPROMISE, set
#     COMPROMISE_BEFORE to an ISO-8601 instant just before the window; the walk then ignores every version
#     uploaded at/after it and lands on the newest genuine pre-compromise locked pair. Signatures and this
#     timestamp anchor are ORTHOGONAL and BOTH required (monotonic anti-rollback is a tracked follow-up).
CUTOFF="${COMPROMISE_BEFORE:-}"   # unset = newest valid (normal restore); set during a compromise (any form GNU
                                  # `date -d` parses, e.g. 2026-06-10T00:00:00Z or +00:00 — both accepted)
rm -f backup.dump backup.dump.age globals.sql.age   # idempotent: clear any leftovers from a prior aborted run

# before_cutoff <LastModified> : 0 if no cutoff set, or if the version was uploaded STRICTLY BEFORE $CUTOFF.
# Compares as EPOCH SECONDS, never lexically: AWS renders LastModified as `...+00:00` while operators type `...Z`,
# and '+' < 'Z' lexically would wrongly include post-cutoff versions — fail-OPEN on the only freshness anchor.
# A timestamp that won't parse is treated as NOT-before (fail-closed: the version is skipped). Needs GNU date.
before_cutoff() {
  [[ -z "$CUTOFF" ]] && return 0
  local le ce
  le=$(date -d "$1" +%s 2>/dev/null) || return 1
  ce=$(date -d "$CUTOFF" +%s 2>/dev/null) || return 1
  [[ "$le" =~ ^[0-9]+$ && "$ce" =~ ^[0-9]+$ && "$le" -lt "$ce" ]]
}

# verify_sig <marker_cipher_file> <sig_file> : 0 + prints the verifying key's DER-SHA256 if the detached sig
# verifies over the marker CIPHERTEXT under ANY pinned keyring block; else non-zero. The Ed25519 sig is exactly
# 64 bytes — assert that BEFORE spending a verify (a 0-byte/short file must never be treated as "nothing to
# check"). openssl pkeyutl -verify reads only the first block of a multi-key file, so we loop the split blocks.
verify_sig() {
  local marker="$1" sig="$2" ssz blk der vksha
  ssz=$(wc -c <"$sig" 2>/dev/null | tr -d '[:space:]'); ssz="${ssz:-0}"   # tr: BSD wc pads with spaces
  [[ "$ssz" =~ ^[0-9]+$ && "$ssz" -eq 64 ]] || return 1
  for blk in "$VK_DIR"/blk.*; do
    [[ -f "$blk" ]] || continue
    "$OPENSSL" pkeyutl -verify -rawin -pubin -inkey "$blk" -sigfile "$sig" -in "$marker" >/dev/null 2>&1 || continue
    # This block verified — compute its DER (SubjectPublicKeyInfo) SHA-256 for the manifest key-id cross-check.
    # Stage to a file and check openssl's exit EXPLICITLY: piping openssl|sha256sum would hash an EMPTY stream
    # on failure and yield a valid-looking 64-hex digest.
    der="$VK_DIR/der"
    if "$OPENSSL" pkey -pubin -in "$blk" -pubout -outform DER -out "$der" 2>/dev/null; then
      vksha=$(sha256sum "$der" | cut -d' ' -f1); rm -f "$der"
      [[ "$vksha" =~ ^[0-9a-f]{64}$ ]] && { printf '%s' "$vksha"; return 0; }
    fi
    rm -f "$der"; return 1
  done
  return 1
}

# Echoes the version-id of the globals version whose CIPHERTEXT re-hashes to the SIGNED digest $2 (and decrypts),
# walking newest-first before $CUTOFF. Binding to the signed digest is strictly stronger than the old size floor:
# attacker junk shadowing the genuine globals fails the digest and the walk falls through to the locked good one.
pick_globals_version() {
  local gk="$1" want_sha="$2" ver lm gsha
  while read -r ver lm; do
    [[ -n "$ver" && "$ver" != "None" ]] || continue
    before_cutoff "$lm" || continue                            # freshness anchor: ignore at/after compromise
    aws s3api get-object --endpoint-url "$EP" --bucket "$BUCKET" --key "$gk" --version-id "$ver" \
      ./globals.sql.age >/dev/null 2>&1 || continue
    gsha=$(sha256sum globals.sql.age | cut -d' ' -f1)
    [[ "$gsha" == "$want_sha" ]] || { rm -f globals.sql.age; continue; }     # (d) bind to the SIGNED globals digest
    age -d -i age.key globals.sql.age >/dev/null 2>&1 || { rm -f globals.sql.age; continue; }
    echo "$ver"; return 0
  done < <(aws s3api list-object-versions --endpoint-url "$EP" --bucket "$BUCKET" --prefix "$gk" \
    --query "reverse(sort_by(Versions[?Key=='$gk'],&LastModified))[].[VersionId,LastModified]" --output text)
  return 1
}

# marker_verified <stamp> : find a marker version for <stamp> whose .sig VERIFIES under the pinned keyring, then
# decrypt the (now-TRUSTED) manifest and export its fields as M_* globals. Existence is NO LONGER the signal — a
# verifying Ed25519 signature is. Walks marker versions newest-first before $CUTOFF; returns 0 on the first that
# verifies + parses + passes the key-id/stamp cross-checks, else 1. Authenticity of the OBJECTS is then enforced
# by the caller re-hashing them against M_DB_SHA / M_GLOBALS_SHA.
M_STAMP=""; M_GLOBALS_KEY=""; M_DB_KEY=""; M_GLOBALS_SHA=""; M_DB_SHA=""; M_VERIFYKEY=""
marker_verified() {
  local st="$1" mk="argus-ok-${1}.age" sk="argus-ok-${1}.age.sig" ver lm sver slm vksha mani sigline
  local mc="$VK_DIR/marker.age" ms="$VK_DIR/marker.sig"   # transient verify state lives in the 0700 temp dir
  # ALL .sig versions for this stamp, newest-first. WORM keeps the genuine sig as an older version even if a
  # writeFiles attacker shadows it with a junk NEWER one, so we must try EACH against the marker — not just the
  # newest — or one junk .sig upload would brick recovery of an otherwise-genuine run (denial of recovery).
  local sigvers
  mapfile -t sigvers < <(aws s3api list-object-versions --endpoint-url "$EP" --bucket "$BUCKET" --prefix "$sk" \
    --query "reverse(sort_by(Versions[?Key=='$sk'],&LastModified))[].[VersionId,LastModified]" --output text 2>/dev/null)
  while read -r ver lm; do
    [[ -n "$ver" && "$ver" != "None" ]] || continue
    before_cutoff "$lm" || continue
    aws s3api get-object --endpoint-url "$EP" --bucket "$BUCKET" --key "$mk" --version-id "$ver" \
      "$mc" >/dev/null 2>&1 || continue
    # (a) try every .sig VERSION against THIS marker ciphertext until one verifies; vksha = DER-SHA256 of the
    # verifying block (for check e). The marker/sig version walks are decoupled and that's SAFE: a sig verifies
    # only over the exact marker bytes it signed, so a junk shadow sig (or a junk shadow marker) just fails and
    # the walk falls through to the older self-consistent locked pair — it never narrows the recovery search.
    vksha=""
    for sigline in "${sigvers[@]}"; do
      [[ -n "$sigline" ]] || continue
      read -r sver slm <<<"$sigline"
      [[ -n "$sver" && "$sver" != "None" ]] || continue
      before_cutoff "$slm" || continue
      aws s3api get-object --endpoint-url "$EP" --bucket "$BUCKET" --key "$sk" --version-id "$sver" \
        "$ms" >/dev/null 2>&1 || continue
      vksha=$(verify_sig "$mc" "$ms") && break
      vksha=""
    done
    [[ -n "$vksha" ]] || { echo "  skip marker $st@$ver (no .sig version verifies it under the pinned keyring)"; rm -f "$mc" "$ms"; continue; }
    # only NOW decrypt the trusted manifest
    mani=$(age -d -i age.key < "$mc" 2>/dev/null) || { echo "  skip marker $st@$ver (manifest decrypt failed)"; rm -f "$mc" "$ms"; continue; }
    rm -f "$mc" "$ms"
    [[ "$(printf '%s\n' "$mani" | head -1)" == "$(printf 'argus-backup-manifest\tv1')" ]] || { echo "  skip marker $st@$ver (bad manifest header/version)"; continue; }
    M_STAMP=$(printf '%s\n' "$mani" | awk -F'\t' '$1=="stamp"{print $2}')
    M_GLOBALS_KEY=$(printf '%s\n' "$mani" | awk -F'\t' '$1=="globals"{print $2}')
    M_GLOBALS_SHA=$(printf '%s\n' "$mani" | awk -F'\t' '$1=="globals"{print $3}'); M_GLOBALS_SHA=${M_GLOBALS_SHA#sha256:}
    M_DB_KEY=$(printf '%s\n' "$mani" | awk -F'\t' '$1=="db"{print $2}')
    M_DB_SHA=$(printf '%s\n' "$mani" | awk -F'\t' '$1=="db"{print $3}'); M_DB_SHA=${M_DB_SHA#sha256:}
    M_VERIFYKEY=$(printf '%s\n' "$mani" | awk -F'\t' '$1=="verifykey"{print $2}'); M_VERIFYKEY=${M_VERIFYKEY#sha256:}
    # (e) the key that verified must be the key the manifest names (advisory id corroborated, never gating alone)
    [[ "$vksha" == "$M_VERIFYKEY" ]] || { echo "  skip marker $st@$ver (verifying key $vksha != manifest verifykey $M_VERIFYKEY)"; continue; }
    # (b) the manifest's own stamp must equal the stamp we looked up
    [[ "$M_STAMP" == "$st" ]] || { echo "  skip marker $st@$ver (manifest stamp $M_STAMP != $st)"; continue; }
    # sanity-check digest shapes before the caller trusts them
    [[ "$M_DB_SHA" =~ ^[0-9a-f]{64}$ && "$M_GLOBALS_SHA" =~ ^[0-9a-f]{64}$ ]] || { echo "  skip marker $st@$ver (malformed manifest digest)"; continue; }
    return 0
  done < <(aws s3api list-object-versions --endpoint-url "$EP" --bucket "$BUCKET" --prefix "$mk" \
    --query "reverse(sort_by(Versions[?Key=='$mk'],&LastModified))[].[VersionId,LastModified]" --output text)
  return 1
}

DB_KEY=""; DB_VER=""; G_KEY=""; G_VER=""; STAMP=""
while read -r cand ver lm; do
  [[ -n "$cand" && -n "$ver" && "$ver" != "None" ]] || continue
  before_cutoff "$lm" || { echo "skip $cand@$ver (uploaded $lm at/after cutoff $CUTOFF)"; continue; }
  sz=$(aws s3api head-object --endpoint-url "$EP" --bucket "$BUCKET" --key "$cand" --version-id "$ver" \
    --query 'ContentLength' --output text 2>/dev/null || echo 0)
  [[ "$sz" =~ ^[0-9]+$ && "$sz" -ge 1024 ]] || { echo "skip $cand@$ver (too small: ${sz}B)"; continue; }
  st=${cand#argus-db-}; st=${st%.dump.age}                   # e.g. 20260608T023012Z
  # AUTHENTICITY GATE: a marker whose .sig verifies, decrypting the SIGNED manifest into M_* (keys + digests).
  marker_verified "$st" || { echo "skip $cand@$ver (no marker with a verifying signature)"; continue; }
  # (c) the signed manifest must name THIS db object — bind the version-walk SELECTION to the verified manifest.
  [[ "$M_DB_KEY" == "$cand" ]] || { echo "skip $cand@$ver (manifest db key $M_DB_KEY != selected $cand)"; continue; }
  [[ "$M_GLOBALS_KEY" == "argus-globals-${st}.sql.age" ]] || { echo "skip $cand@$ver (manifest globals key $M_GLOBALS_KEY unexpected)"; continue; }
  # download the db ciphertext ONCE; (d) re-hash that file and require it matches the SIGNED digest; decrypt the
  # SAME file (never re-fetch between hash and restore).
  aws s3api get-object --endpoint-url "$EP" --bucket "$BUCKET" --key "$cand" --version-id "$ver" \
    ./backup.dump.age >/dev/null 2>&1 || { echo "skip $cand@$ver (download failed)"; continue; }
  dbsha=$(sha256sum backup.dump.age | cut -d' ' -f1)
  [[ "$dbsha" == "$M_DB_SHA" ]] || { echo "skip $cand@$ver (db ciphertext digest $dbsha != signed $M_DB_SHA)"; rm -f backup.dump.age; continue; }
  if ! age -d -i age.key backup.dump.age >backup.dump 2>/dev/null || ! pg_restore --list backup.dump >/dev/null 2>&1; then
    echo "skip $cand@$ver (failed decrypt / pg_restore --list)"; rm -f backup.dump.age backup.dump; continue
  fi
  gver=$(pick_globals_version "$M_GLOBALS_KEY" "$M_GLOBALS_SHA") || { echo "skip $cand@$ver (no globals version matching the signed digest)"; rm -f backup.dump.age backup.dump globals.sql.age; continue; }
  DB_KEY="$cand"; DB_VER="$ver"; G_KEY="$M_GLOBALS_KEY"; G_VER="$gver"; STAMP="$st"
  echo "selected $DB_KEY@$DB_VER (roles: $G_KEY@$G_VER) — signature VERIFIED, both objects bound to the signed manifest"; break
done < <(aws s3api list-object-versions --endpoint-url "$EP" --bucket "$BUCKET" --prefix argus-db- \
  --query 'reverse(sort_by(Versions,&LastModified))[].[Key,VersionId,LastModified]' --output text)
[[ -n "$DB_KEY" ]] || { echo "FATAL: no backup pair with a VERIFYING signature found in $BUCKET (checked all versions${CUTOFF:+ before $CUTOFF}) — every candidate failed signature/digest verification, NOT mere absence"; rm -rf "$VK_DIR"; rm -f backup.dump backup.dump.age globals.sql.age; shred -u age.key 2>/dev/null; exit 1; }
# globals.sql.age + backup.dump.age are now the selected good versions; backup.dump is already decrypted.

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

# 5. Sanity-check, then cut over. Securely remove the key + plaintext dump, and the split-keyring temp dir.
shred -u age.key backup.dump
rm -rf "$VK_DIR"
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
