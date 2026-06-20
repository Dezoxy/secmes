#!/usr/bin/env bash
# argus — nightly logical DB backup worker (VM deploy track, roadmap checkpoint 49). Standalone; runs on
# the VM via a systemd timer (see argus-db-backup.{service,timer}). Each run ships TWO encrypted objects to a
# private EU Backblaze B2 bucket — the cluster ROLES (so a restore onto a fresh cluster has the roles its
# RLS policies/grants reference) and the database itself.
#
# The backup bucket is WORM (B2 Object Lock, Compliance mode — BKP-2): once written, an object cannot be
# deleted or overwritten by anyone (not this key, not the account owner) until its retention expires. So this
# script no longer prunes, and its key intentionally has NO delete capability. Retention/reaping is a
# server-side B2 LIFECYCLE RULE (account-owner-managed, which a compromised host key cannot disable), and a
# lifecycle delete defers to Object Lock — it can never remove a still-locked backup. A partial/corrupt or
# orphaned object is therefore left in place (it is age-ciphertext garbage, leaks nothing); the lifecycle rule
# reaps it after the window, and the restore runbook skips it (size floor + timestamp pairing). See
# infra/b2/README.md (operator runbook) and docs/threat-models/db-backup.md.
#
# Security model:
#   - Connects to Postgres as the least-privilege `argus_backup` role (migration 0015): READ-ONLY across all
#     tenants (pg_read_all_data + BYPASSRLS so FORCE-RLS tables dump fully), never able to write or DROP.
#   - The roles dump uses `--no-role-passwords`, so the backup carries role DEFINITIONS (attributes +
#     memberships) but NOT password hashes — passwords are re-applied from Key Vault at restore (invariant
#     #2/#5: no credential material in the backup). `--no-role-passwords` also avoids needing pg_authid, so a
#     non-superuser can produce it.
#   - CLIENT-SIDE ENCRYPTION: every object is encrypted with `age` to a PUBLIC recipient key BEFORE it leaves
#     the box, so B2 only ever stores ciphertext (the DB holds cleartext METADATA: emails, names, membership;
#     message bodies are already MLS ciphertext). The age PRIVATE key is NOT on the VM — it lives in Key Vault
#     and is fetched only at RESTORE time, so a compromised backup host cannot read past dumps.
#   - The DB is reached IN-CONTAINER via `docker compose exec -T postgres pg_dump …` over the container's
#     local socket (PG has NO published host port — invariant #3). The official image trusts local-socket
#     connections, so the worker assumes `argus_backup` with NO password; its read-only/BYPASSRLS scope
#     (above) bounds the connection regardless of auth method — so there is NO DB password on the host at all.
#   - The B2 secret key is read from a FILE delivered by systemd LoadCredential, populated from Azure Key
#     Vault via the VM's Managed Identity — never committed, never in env at rest (invariant #5): the script
#     writes an AWS credentials file in a private tmpfs dir (0600) and points `aws` at it by PATH — the secret
#     VALUE never enters the process environment (so not in /proc/<pid>/environ, not inherited) nor argv/`ps`.
#   - AUTHENTICITY: each run's success marker is a small signed MANIFEST carrying the SHA-256 of both encrypted
#     objects; it is signed with an Ed25519 key (`argus-backup-signing-key`, delivered as a LoadCredential file
#     like the B2 key). Signing the tiny manifest (not the multi-GB dumps) keeps the streaming/no-large-object-
#     in-RAM property while transitively binding both objects by digest. Restore (slice 3) verifies the
#     signature + the digests before decrypting, so a holder of the (delete-less) B2 key cannot substitute a
#     forged dump. The signing key never enters env/argv (`openssl … -inkey <file>`). Honest limit: the signing
#     key is on this host to sign nightly, so host-root can still forge — see docs/threat-models/db-backup.md
#     §invariant-4. Standard primitives only (Ed25519 + SHA-256 via openssl/coreutils) — no hand-rolled crypto.
#   - Logs object keys / sizes / counts / key fingerprints ONLY — never a secret, never a presigned URL, never plaintext.
#
# Requires: docker compose (reaches the postgres container; `argus` is in the docker group), age
# (https://age-encryption.org — asymmetric file encryption; the host holds only the public key), aws (AWS CLI
# v2, against the B2 S3 endpoint), openssl >= 3.0 (Ed25519 `pkeyutl -sign -rawin` — LibreSSL/1.1.1 lack it;
# preflighted at startup), sha256sum/cut (coreutils), GNU date. pg_dump/pg_dumpall run INSIDE the postgres
# container.
set -euo pipefail

# --- Non-secret config (provided by the systemd unit's Environment=). No PGHOST/PGPORT/PGPASSFILE: the DB is
#     reached in-container via `docker compose exec` (below), not over a host TCP port (invariant #3). ---
: "${PGUSER:?PGUSER required (argus_backup)}"
: "${PGDATABASE:?PGDATABASE required}"
: "${S3_ENDPOINT:?S3_ENDPOINT required}"
: "${S3_BUCKET:?S3_BUCKET required (the PRIVATE db-backup bucket)}"
: "${S3_ACCESS_KEY_ID:?S3_ACCESS_KEY_ID required}"
# The age recipient is a PUBLIC key (age1...). REQUIRED — refuse to run without it, so a dump can NEVER be
# uploaded in the clear by misconfiguration.
: "${AGE_RECIPIENT:?AGE_RECIPIENT required (age public key) — refusing to upload an unencrypted dump}"
# The Ed25519 PRIVATE signing key, delivered as a credential FILE (systemd LoadCredential). REQUIRED — refuse
# to run without it, exactly as we refuse to run unencrypted: an UNSIGNED backup is now a misconfiguration. The
# key VALUE is never read into a shell var or env; openssl reads it from this PATH at sign time (invariant #2/#5).
: "${BACKUP_SIGN_KEY_FILE:?BACKUP_SIGN_KEY_FILE required (Ed25519 private key file) — refusing to write an unsigned backup}"

export AWS_REGION="${S3_REGION:-eu-central-003}" # EU default (B2 ignores it for routing; the host carries it)

# Run a Postgres client INSIDE the running postgres container — PG has no published port (invariant #3), and
# the official image trusts local-socket connections, so `-U "$PGUSER"` (argus_backup) assumes the
# least-privilege role with NO password. `-T` keeps stdout a clean binary stream for the custom-format dump.
# COMPOSE_FILE + COMPOSE_PROJECT_NAME (set by the unit) attach to the deployed stack regardless of cwd. The
# in-container exit code propagates through `exec -T`, so the dump_upload PIPESTATUS checks still hold.
pgx() { docker compose exec -T postgres "$@"; }

# No RETENTION_DAYS knob: retention is enforced by the bucket (Object Lock default retention) and old objects
# are reaped by a B2 lifecycle rule, NOT by this script — the backup key has no delete capability (BKP-2).
BACKUP_PREFIX="${BACKUP_PREFIX:-argus}" # common root → both objects share it so the lifecycle rule (prefix
# argus-) covers both families with one rule

read_secret_file() {
  local f="$1"
  [[ -r "$f" ]] || {
    echo "backup: secret file not readable: $f" >&2
    exit 1
  }
  tr -d '\n' <"$f"
}

# --- Secrets stay FILE-BACKED end-to-end. We do NOT `export PGPASSWORD` / `AWS_SECRET_ACCESS_KEY`: an
#     exported secret is readable via /proc/<pid>/environ (root + same-UID) and is inherited by EVERY child,
#     including the ones that don't need it (`age`, `aws` don't need the DB password; `pg_dump` doesn't need
#     the B2 secret). Instead we materialise a libpq passfile + an AWS credentials file in a private tmpfs
#     work dir (0600) and point the CLIs at them by PATH — so no secret VALUE ever enters the environment
#     (invariant #5: secret delivered as a file, end-to-end). The source secrets arrive via systemd
#     LoadCredential (Key Vault). The work dir is removed on exit. ---
umask 077
# Put the secret files under the systemd RuntimeDirectory ($RUNTIME_DIRECTORY) — a service-private tmpfs with
# NO host-disk backing — rather than /tmp. (PrivateTmp=true isolates /tmp but its boolean form still backs
# onto the host /tmp, so a crash/power-loss could leave the materialised secrets on disk.) Fall back to
# TMPDIR/tmp for a local dry-run. mktemp makes the dir 0700; the trap removes it on exit.
secbase="${RUNTIME_DIRECTORY:-}"
secbase="${secbase%%:*}" # first path if systemd gave a colon-separated list
WORKDIR="$(mktemp -d "${secbase:-${TMPDIR:-/tmp}}/argus-db-backup.XXXXXXXX")"
trap 'rm -rf -- "$WORKDIR"' EXIT

# No libpq passfile: the DB connection runs in-container over the local-trust socket (see pgx() above), so no
# DB password is materialised on the host at all.

# AWS shared-credentials file. The access-key-id is NOT a secret; the secret key rides only in this 0600 file.
AWS_SHARED_CREDENTIALS_FILE="$WORKDIR/aws-credentials"
{
  printf '[default]\n'
  printf 'aws_access_key_id = %s\n' "$S3_ACCESS_KEY_ID"
  printf 'aws_secret_access_key = %s\n' \
    "$(read_secret_file "${S3_SECRET_ACCESS_KEY_FILE:?S3_SECRET_ACCESS_KEY_FILE required}")"
} >"$AWS_SHARED_CREDENTIALS_FILE"
chmod 600 "$AWS_SHARED_CREDENTIALS_FILE"
export AWS_SHARED_CREDENTIALS_FILE

log() { printf '[%s] backup: %s\n' "$(date -u +%FT%TZ)" "$*"; }

# --- Signing-key gate + key-id. Derive the PUBLIC-key fingerprint (SHA-256 of the DER SubjectPublicKeyInfo)
#     from the delivered PRIVATE key. Double duty: (1) FAIL-FAST validity check — a missing/empty/malformed key
#     aborts HERE, before any object uploads, so a bad key can never leave an orphaned unsigned pair; (2) the
#     manifest key-id, so restore's current-then-previous keyring (slice 3) can select the matching verify key
#     deterministically. DER (not PEM) so the fingerprint is encoding/whitespace-stable. We stage the public key
#     to a temp file and check openssl's exit explicitly — piping openssl straight into sha256sum would hash an
#     EMPTY stream on failure and yield a valid-looking 64-hex digest. The fingerprint is a PUBLIC-key hash —
#     safe to log (truncated). The PRIVATE key VALUE is never read into a variable. ---
_pub_der="$WORKDIR/verifykey.der"
if ! openssl pkey -in "$BACKUP_SIGN_KEY_FILE" -pubout -outform DER -out "$_pub_der" 2>/dev/null; then
  echo "backup: signing key not usable (BACKUP_SIGN_KEY_FILE=$BACKUP_SIGN_KEY_FILE) — refusing to write an unsigned backup" >&2
  exit 1
fi
verifykey_sha="$(sha256sum "$_pub_der" | cut -d' ' -f1)"
rm -f "$_pub_der"
if [[ ! "$verifykey_sha" =~ ^[0-9a-f]{64}$ ]]; then
  echo "backup: could not fingerprint the signing key — refusing to write an unsigned backup" >&2
  exit 1
fi
# Preflight the EXACT signing primitive used at the commit point: a `-rawin` (PureEdDSA) detached sign. This
# needs OpenSSL >= 3.0 — LibreSSL / OpenSSL 1.1.1 reject `-rawin` outright. The fingerprint gate above uses
# `openssl pkey`, which those builds DO support, so without this probe a version-skewed host would pass startup
# and then fail only at marker-sign time, nightly, with a cryptic pkeyutl usage dump. Fail fast + legibly here,
# before any upload — consistent with every other gate. An Ed25519 detached signature is exactly 64 bytes.
printf 'argus-backup-signing-preflight' >"$WORKDIR/probe.in"
if ! openssl pkeyutl -sign -rawin -inkey "$BACKUP_SIGN_KEY_FILE" -in "$WORKDIR/probe.in" -out "$WORKDIR/probe.sig" 2>/dev/null \
  || [[ "$(wc -c <"$WORKDIR/probe.sig" 2>/dev/null || echo 0)" -ne 64 ]]; then
  echo "backup: openssl cannot produce an Ed25519 -rawin signature (needs OpenSSL >=3.0; LibreSSL/1.1.1 lack -rawin) — refusing to write an unsigned backup" >&2
  rm -f "$WORKDIR/probe.in" "$WORKDIR/probe.sig"
  exit 1
fi
rm -f "$WORKDIR/probe.in" "$WORKDIR/probe.sig"
log "signing key loaded (verify-key id sha256:${verifykey_sha:0:16}…)"

# dump_upload <label> <key> <min_bytes> <digest_out> -- <generator cmd...>
# Streams `<cmd> | age | tee <fifo> | aws s3 cp -` (no plaintext/ciphertext of the dump on disk). The <fifo>
# feeds a backgrounded sha256sum that writes the ENCRYPTED object's hex SHA-256 to <digest_out>, captured in
# CONSTANT memory as the bytes stream — so the multi-GB dump is never held in RAM. That digest is what lets the
# signed success manifest bind this object by hash instead of signing the whole file. Verifies via PIPESTATUS,
# the captured digest, and a size floor. Returns non-zero on failure so the caller can abort. It does NOT delete
# a partial/too-small object: under Object Lock the key cannot delete, and a leftover is age-ciphertext that the
# lifecycle rule reaps and the restore runbook skips (size floor + timestamp pairing) — see the header.
dump_upload() {
  local label="$1" key="$2" floor="$3" digest_out="$4"
  shift 5 # drop label, key, floor, digest_out, and the literal "--" separator
  local uri="s3://${S3_BUCKET}/${key}"
  log "starting ${label} → ${uri}"

  # Digest capture via a FIFO + a REAL backgrounded job (not a `>(…)` process substitution): process subs are
  # not reflected in PIPESTATUS/pipefail and are not synchronised with the pipeline's exit, so reading the
  # digest right after the pipeline would race the still-running sha256sum. A FIFO-fed background job gives us a
  # PID to `wait` on and a genuine exit status.
  local digfifo
  digfifo="$(mktemp -u "$WORKDIR/dig.XXXXXX")"
  mkfifo "$digfifo"
  (sha256sum <"$digfifo" | cut -d' ' -f1 >"$digest_out") &
  local digpid=$!

  set +e
  "$@" | age -r "$AGE_RECIPIENT" | tee "$digfifo" \
    | aws s3 cp - "$uri" --endpoint-url "$S3_ENDPOINT" --only-show-errors
  local p=("${PIPESTATUS[@]}") # 0=gen 1=age 2=tee 3=aws
  wait "$digpid"
  local digstatus=$?
  set -e
  rm -f "$digfifo"

  if [[ "${p[0]}" -ne 0 || "${p[1]}" -ne 0 || "${p[2]}" -ne 0 || "${p[3]}" -ne 0 ]]; then
    # WORM bucket: we cannot delete a partial upload (no delete capability, and a finalized object is locked).
    # Leave it — it is age-ciphertext, reaped by the lifecycle rule and skipped at restore (size floor). The
    # non-zero return still aborts the run and fires the OnFailure alert.
    log "FAILED ${label} (gen=${p[0]} age=${p[1]} tee=${p[2]} aws=${p[3]}) — partial object ${key} left for the B2 lifecycle rule (WORM: not deletable here)"
    return 1
  fi

  # The encrypted object's SHA-256, captured as it streamed. A non-zero sha256sum or a missing/malformed digest
  # means we cannot bind this object into the signed manifest — refuse to proceed (fail-closed: no digest ⇒ no
  # signable pair ⇒ nothing restore-eligible). The digest is left in <digest_out> for the caller to read.
  local digest
  digest="$(cat "$digest_out" 2>/dev/null || true)"
  if [[ "$digstatus" -ne 0 || ! "$digest" =~ ^[0-9a-f]{64}$ ]]; then
    log "FAILED ${label} — could not capture a valid SHA-256 for ${key} (status=${digstatus}); refusing to sign an unbound object"
    return 1
  fi

  # head-object can emit a NON-numeric value ('None'/empty on a transient error); guard the arithmetic so a
  # bare `[[ "None" -lt N ]]` under `set -e` can't abort and mislabel a GOOD backup as failed.
  local size
  size="$(aws s3api head-object --endpoint-url "$S3_ENDPOINT" --bucket "$S3_BUCKET" --key "$key" \
    --query 'ContentLength' --output text 2>/dev/null || true)"
  if [[ "$size" =~ ^[0-9]+$ ]]; then
    if [[ "$size" -lt "$floor" ]]; then
      # Suspected-broken dump. WORM: cannot delete it here; the restore runbook applies the SAME size floor and
      # skips it (walks to the next-older good object), and the lifecycle rule reaps it after the window.
      log "FAILED ${label} object too small (${size} < ${floor} bytes) — suspected-broken dump ${key} left for the B2 lifecycle rule (WORM); restore skips it by the same size floor"
      return 1
    fi
    log "uploaded ${key} (${size} bytes, encrypted)"
  else
    log "WARNING uploaded ${key} but could not verify size (head-object returned '${size:-}') — kept"
  fi
}

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
globals_key="${BACKUP_PREFIX}-globals-${stamp}.sql.age"
db_key="${BACKUP_PREFIX}-db-${stamp}.dump.age"

# 1) Cluster ROLES first (tiny). Definitions + memberships, NO passwords. Without this a restore onto a fresh
#    cluster fails: the schema's role-scoped RLS policies + grants reference argus_app/argus_cleanup/etc.
dump_upload "roles (globals)" "$globals_key" 64 "$WORKDIR/globals.sha" -- \
  pgx pg_dumpall -U "$PGUSER" --database="$PGDATABASE" --no-password --roles-only --no-role-passwords || exit 1
globals_sha="$(cat "$WORKDIR/globals.sha")"

# 2) The database (custom format → compact, supports selective/parallel restore). A run is ALL-OR-NOTHING in
#    INTENT: if the DB dump fails after the roles object uploaded, that roles object is now orphaned. Under
#    WORM we cannot delete it (no delete capability, and it is locked), so we leave it and exit non-zero. The
#    orphan is HARMLESS at restore: the restore runbook pairs from the DB side — it picks the latest valid
#    `argus-db-*` and fetches the `argus-globals-*` with the SAME stamp — so an orphan globals with no matching
#    db is never selected. The lifecycle rule reaps it after the window.
if ! dump_upload "db dump" "$db_key" 1024 "$WORKDIR/db.sha" -- \
  pgx pg_dump -U "$PGUSER" --format=custom --no-password "$PGDATABASE"; then
  log "db dump failed — roles object ${globals_key} is now orphaned; left in place (WORM: not deletable). Harmless: restore pairs from the db side by stamp, so an unpaired globals is never selected. Reaped by the lifecycle rule."
  exit 1
fi
db_sha="$(cat "$WORKDIR/db.sha")"

# 3) SIGNED SUCCESS MARKER (manifest) — the run's commit point, written ONLY now that BOTH objects uploaded and
#    cleared their size floors. Why a marker matters under WORM: when pg_dump fails *after* emitting the
#    custom-format TOC + some data, the partial db object can be >1 KiB, age-valid, and pass `pg_restore --list`
#    despite being incomplete — and we can no longer delete it. Any failure above exits BEFORE this line, so a
#    failed run writes NO marker; restore requires a VERIFIED marker for a stamp before that stamp's db object is
#    eligible, so an incomplete run can never be selected over the previous good backup.
#
#    The marker is now a CONTENT-BEARING, SIGNED manifest (was: an existence-only token): a small versioned
#    record binding this run's stamp, BOTH object keys + their streamed SHA-256, and the verify-key id. Signing
#    this tiny record authenticates both large objects transitively (their bytes are pinned by digest) without
#    ever holding them in RAM. Restore (slice 3) verifies the signature AND re-hashes each object against these
#    digests, then decrypts — so it now reads marker CONTENT, not just its existence.
marker_key="${BACKUP_PREFIX}-ok-${stamp}.age"
sig_key="${marker_key}.sig"
manifest="$WORKDIR/manifest"
{
  printf 'argus-backup-manifest\tv1\n'
  printf 'stamp\t%s\n' "$stamp"
  printf 'globals\t%s\tsha256:%s\n' "$globals_key" "$globals_sha"
  printf 'db\t%s\tsha256:%s\n' "$db_key" "$db_sha"
  printf 'verifykey\tsha256:%s\n' "$verifykey_sha"
} >"$manifest"

# Encrypt the manifest to the marker ciphertext (tiny — safe to stage in the tmpfs WORKDIR; the bucket still
# only ever holds ciphertext).
marker_cipher="$WORKDIR/marker.age"
if ! age -r "$AGE_RECIPIENT" <"$manifest" >"$marker_cipher"; then
  log "FAILED encrypting manifest for ${stamp} — no marker written (pair NOT restore-eligible); exiting non-zero"
  exit 1
fi

# SIGN FIRST, upload second. Detached Ed25519 signature over the marker CIPHERTEXT (PureEdDSA, -rawin — sign the
# bytes, not a prehash), so restore verifies provenance BEFORE it needs the age key and before touching the big
# objects. openssl reads the PRIVATE key from the file PATH, so the key VALUE never enters env/argv (invariant
# #2/#5). A sign failure aborts BEFORE any marker exists — the pair stays complete-but-unmarked = not
# restore-eligible (the same fail-closed state the marker-upload path already relies on).
sig_file="$WORKDIR/marker.sig"
if ! openssl pkeyutl -sign -rawin -inkey "$BACKUP_SIGN_KEY_FILE" -in "$marker_cipher" -out "$sig_file" 2>/dev/null \
  || [[ ! -s "$sig_file" ]]; then
  log "FAILED signing manifest for ${stamp} — no marker written (pair NOT restore-eligible); exiting non-zero"
  exit 1
fi

# Upload the marker (the commit point) THEN its signature. MARKER-BEFORE-SIG: if the sig upload then fails,
# restore treats "marker present but no verifying sig" as fail-closed (reject) — exactly the threat being closed
# — so a missing sig degrades to not-restore-eligible, never to accept-unverified. Either failure exits
# non-zero to fire the alert; the next run writes a fresh signed pair.
if ! aws s3 cp "$marker_cipher" "s3://${S3_BUCKET}/${marker_key}" --endpoint-url "$S3_ENDPOINT" --only-show-errors; then
  log "FAILED success marker ${marker_key} — backup pair landed but is NOT restore-eligible until a later run; exiting non-zero"
  exit 1
fi
# The signature is NOT age-wrapped: it is a signature over already-encrypted bytes — it leaks nothing, and
# staying cleartext lets restore verify it before decrypting anything.
if ! aws s3 cp "$sig_file" "s3://${S3_BUCKET}/${sig_key}" --endpoint-url "$S3_ENDPOINT" --only-show-errors; then
  log "FAILED signature ${sig_key} — marker landed unsigned (NOT restore-eligible) until a later run; exiting non-zero"
  exit 1
fi

# Retention/reaping is NOT done here. The bucket is WORM (Object Lock) and the backup key has no delete
# capability (BKP-2), so old objects are removed by a server-side B2 LIFECYCLE RULE (prefix argus-, ~35d),
# which a compromised host key cannot disable and which defers to Object Lock (it can never remove a
# still-locked backup). See infra/b2/README.md for the rule + the operator runbook.
log "done globals=${globals_key} db=${db_key} marker=${marker_key} sig=${sig_key} (signed; retention: B2 Object Lock + lifecycle rule, not script prune)"
