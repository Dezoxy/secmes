# Threat model: B2 attachment-bucket CORS convergence on deploy

> One page. Written before code. Ratified by the human before Phase work starts.

## 1. Feature & data flow

`deploy.sh` (run as root on the VM via the cloud control plane — `az vm run-command` / SSM
send-command, no SSH) reconciles the live Backblaze B2 **attachment** bucket's CORS rules to the
checked-in source of truth `infra/b2/attachment-bucket-cors.json` on every deploy. It runs
**after** the stack is healthy, reads the current CORS over B2's **native** API, and writes only
on drift (idempotent), then re-verifies.

CORS is a browser-only setting that governs whether the PWA (origin `https://4rgus.com`) may
make cross-origin presigned `PUT`/`GET` to the attachment bucket. It carries **no message
content** — the server stays crypto-blind; attachment bytes are AES-GCM ciphertext encrypted
client-side, and the CORS rule is public metadata (origin + allowed methods). No plaintext, no
message keys, no user data flow through this path.

Auth flow (this is why a new credential exists): B2's native API authenticates with
`keyId:applicationKey`. The **keyId** (`B2_CORS_KEY_ID`) is non-secret and rides in env exactly
like the existing `S3_ACCESS_KEY_ID`; the **applicationKey** is the new Key Vault secret
`argus-b2-cors-app-key`, fetched via Managed Identity at deploy time and held in memory only.

## 2. Assets & trust boundaries

- **`argus-b2-cors-app-key`** (new) — a B2 application key able to read/write the attachment
  bucket's CORS. Trust boundary: GitHub Actions (OIDC, no stored cloud creds) → cloud control
  plane → root on the VM → Key Vault via Managed Identity. The key is materialized **only** on
  the VM during the deploy window, never on a runner.
- **The attachment bucket's CORS state** — integrity asset (a wrong/empty rule breaks browser
  upload; it cannot leak ciphertext).
- **The db-backup bucket** (`db-q7m2z9x4v6n8p3k1`) — holds cleartext metadata (emails, names,
  membership). It is **out of reach** of this key by construction (see §3/§4).

## 3. Threats (STRIDE-lite)

- **Spoofing:** the key authenticates to B2 over TLS with `keyId:key`; the keyId is non-secret,
  the key is KV-only. No client input sets the credential.
- **Tampering:** an attacker with deploy-window root on the VM could rewrite the attachment
  bucket's CORS (e.g. to an attacker origin). Blast radius is bounded — blobs are E2EE, presigned
  URLs are short-lived bearer caps, and such an attacker already holds the runtime presigning key.
  No **new** confidentiality reach is granted.
- **Information disclosure:** the `b2_authorize_account` response contains a live
  `authorizationToken`; the applicationKey is secret. Both are passed via `curl --config -`
  (stdin, never argv → not in `/proc/<pid>/cmdline`), never logged, and blanked from the shell
  immediately after use. Read-back logging is field-scoped (`corsRules` only), never the full
  response. **Note:** SSM/run-command stdout is surfaced into the CI log *outside* the on-box
  log scrubber, so the "no secret in stdout" discipline in `deploy.sh` is the actual control.
- **Elevation of privilege:** the key is **bucket-restricted** to the attachment bucket and
  carries **only** `listBuckets, readBucketCors, writeBucketCors` — no file capabilities and no
  reach to any other bucket. `deploy.sh` additionally asserts at runtime that the authorized
  bucket name equals the attachment bucket and fails closed otherwise, so a mis-scoped key (e.g.
  account-wide, or pointed at the db-backup bucket) can never be used to write CORS anywhere.

## 4. Invariant check

- **#1 crypto-blind / #6 no admin path to content:** unaffected — CORS is public metadata; the
  bucket restriction keeps this key away from the db-backup bucket's cleartext metadata.
- **#2 never log secrets:** upheld — applicationKey + authorizationToken via stdin, never logged,
  blanked after use; read-back is field-scoped.
- **#5 secrets from Key Vault via Managed Identity, never env:** upheld — the secret is a KV
  value fetched on the VM and held in memory (never written to `/run/argus/secrets`, never env).
  The non-secret keyId rides env, matching the established `S3_ACCESS_KEY_ID` split.
- **#3 RLS / #4 no hand-rolled crypto:** N/A (no DB table, no crypto).

Tension: converge-on-deploy means a write-capable key is present on the box each deploy (vs a
rarely-exercised manual key). Accepted because the bucket restriction + capability minimization
bound it to one bucket's CORS, the key is deploy-transient, and the box is already root + holds
higher-value transient secrets (owner DSN, GHCR token) during the same window.

## 5. Decision & mitigations

Converge-on-deploy with a dedicated, bucket-restricted, CORS-only key. Mitigations: stdin-not-argv
credential handling, in-memory-only (not in the persistent secret set), field-scoped read-back,
runtime bucket-name assertion, **fail-closed after the health gates** (a CORS failure turns the
deploy red without blocking an already-healthy rollout), and **opt-in activation** keyed on
`B2_CORS_KEY_ID` being set (unset ⇒ skip with a log — a config gate, never a silent apply
failure). Gated by: `infra-reviewer` (least privilege, secret-as-file, EU, both CD paths in
parity) and `security-boundary-auditor` (no secret in logs/argv, invariant #2); pre-commit
gitleaks/semgrep + CI checkov.

## 6. Residual risk

A deploy-window root compromise can rewrite the attachment bucket's CORS — bounded to that one
bucket, no confidentiality impact (E2EE), no greater reach than the runtime key already grants.
If B2 normalizes returned CORS fields differently from the source JSON, the convergence may
re-write every deploy (still correct, just noisy) — acceptable. The db-backup bucket's
CORS-absence is **not** enforced here (would require a second privileged key); it stays on
"share with no origin" in the console, and its higher-value Object Lock gap is tracked separately.
