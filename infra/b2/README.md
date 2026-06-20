# Backblaze B2 bucket config (CORS)

Source-of-truth for the **CORS** configuration of the two private EU Backblaze B2 buckets. The buckets
themselves are created by hand in the B2 console (there is no Terraform provider for B2 in this repo); this
directory exists so the **CORS rules don't live only in the console** where they silently drift.
[`attachment-bucket-cors.json`](attachment-bucket-cors.json) is **applied automatically on every deploy** —
`deploy.sh` reconciles the live attachment bucket's CORS to this file (see
[_How it's applied_](#how-its-applied--converge-on-deploy) below), so a console edit is undone on the next
deploy. Edit the JSON, merge, deploy — that's the workflow.

## The two buckets get opposite treatment

CORS is a **browser-only** mechanism — it only gates requests made by JavaScript running on one origin against
a different origin. Server-to-server calls ignore it. The two buckets sit on opposite sides of that line:

| Bucket (prefix)            | Who talks to it                                                                 | CORS            |
| -------------------------- | ------------------------------------------------------------------------------- | --------------- |
| `attachment-…` (`r8xq4m…`) | **The PWA, in the browser** — direct presigned `PUT`/`GET` of E2EE blobs        | **Tight rule**  |
| `db-…` (`q7m2z9…`)         | **The VM only** — `aws s3 cp` from `infra/backup/backup-db.sh` (server-side)    | **None**        |

The DB-backup bucket must stay on the console's **"Do not share any files with any origin"** — no browser ever
touches it, so any CORS rule there is pure attack surface.

## Attachment bucket — the rule

[`attachment-bucket-cors.json`](attachment-bucket-cors.json) is the canonical rule. Field by field:

- **`allowedOrigins: ["https://4rgus.com"]`** — the PWA's browser origin, i.e. `FRONTEND_ORIGIN`
  (`compose.prod.yaml`, default `https://4rgus.com`). **Never `*`** and never the server's address: the EC2/VM
  box sits behind the Cloudflare Tunnel and never appears in a browser address bar. Blobs are AES-GCM
  ciphertext so a wildcard couldn't leak plaintext, but a presigned URL *is* a bearer capability — a tight
  origin is the defense-in-depth that limits the blast radius of a leaked URL or XSS. Add a second entry only
  if you serve a staging origin or `https://www.4rgus.com`.
- **`allowedOperations: ["s3_put", "s3_get"]`** — exactly the two presigned flows minted by
  `apps/api/src/messaging/attachments.controller.ts`. No `s3_delete` (deletion is server-side / lifecycle —
  see `infra/cleanup/`), no `s3_post` (no multipart: `MAX_ATTACHMENT_BYTES` is 10 MB, a single `PUT`). Add
  `s3_head` only if the client starts probing object existence; it does not today.
- **`allowedHeaders: ["content-type"]`** — with presigned URLs the auth rides in the query string
  (`X-Amz-Signature`), so `Authorization` is **not** allowed. `content-type` covers the upload preflight.
- **`exposeHeaders: ["etag"]`** — lets the client read the upload response. Optional (integrity is the GCM
  tag, not the ETag) but harmless. **Lowercase on purpose:** B2 canonicalizes CORS header names to lowercase
  on storage, so keep `allowedHeaders`/`exposeHeaders` lowercase here — that's the form the live bucket
  reports back, and convergence compares against it (`deploy.sh` also lowercases both sides defensively).
- **`maxAgeSeconds: 3600`** — caches the preflight for an hour; no `OPTIONS` round-trip per attachment.

### This is one of two halves

The browser→B2 leg only works if **both** agree:

1. **Our edge lets the browser reach B2** — the CSP `connect-src` in `infra/stack/caddy/Caddyfile` already
   whitelists `https://s3.eu-central-003.backblazeb2.com` and `https://*.s3.eu-central-003.backblazeb2.com`
   (the bucket is virtual-host style, `S3_FORCE_PATH_STYLE=false`).
2. **B2 lets our origin read the response** — this CORS rule, allowing `https://4rgus.com`.

If you change the deployment domain, update **both** (`FRONTEND_ORIGIN`, the Caddyfile CSP, and this rule).

## How it's applied — converge-on-deploy

`deploy.sh` (step 6c, run on the VM via the cloud control plane after the stack is healthy) reconciles the
live attachment bucket's CORS to this JSON every deploy: it reads the current rule over B2's **native** API,
and writes only on drift, then re-verifies. Idempotent and self-healing — a manual console change is reverted
on the next deploy. A convergence failure **fails the deploy** (after the app is already healthy, so it never
blocks a good rollout). Threat model: [`docs/threat-models/b2-cors-convergence.md`](../../docs/threat-models/b2-cors-convergence.md).

### The CORS app key (you must provision it once)

CORS is a bucket-config operation; the runtime attachment/backup keys are file-scoped and deliberately cannot
do it. Mint **one dedicated B2 application key**, restricted to this bucket. B2 has **no granular CORS
capability** — `writeBuckets` is the coarsest write needed and `listBuckets` reads it back — so the **bucket
restriction is the security control** that keeps the key away from the `db-…` backup bucket (cleartext
metadata) and every file. Native B2 auth needs both halves: `keyId:applicationKey` (the keyId is non-secret).

```bash
# 1. Mint the key (from your workstation; the box has no b2 CLI). Prints "<keyId> <applicationKey>".
b2 key create --bucket attachment-r8xq4m7z2p9n6k3v argus-cors-key listBuckets,writeBuckets

# 2. Store the applicationKey SECRET in Key Vault (via --file, never argv; see populate-keyvault.sh).
umask 077; printf '%s' '<applicationKey>' >/tmp/corskey
az keyvault secret set --vault-name <vault> --name argus-b2-cors-app-key --file /tmp/corskey --encoding utf-8
rm -P /tmp/corskey   # macOS has no `shred`; -P overwrites before unlinking

# 3. Set the keyId (NON-secret) as the repo variable that switches convergence on.
gh variable set B2_CORS_KEY_ID --repo <owner/repo> --body '<keyId>'
```

`deploy.sh` asserts the authorized bucket name matches `attachment-r8xq4m7z2p9n6k3v` and fails closed otherwise.
Until `B2_CORS_KEY_ID` is set it **skips** CORS convergence with a log line (opt-in, non-breaking) — apply
manually in the meantime via the break-glass path below.

## Applying the rule manually (break-glass)

For a one-off apply outside a deploy — **run from your workstation**, not the VM (the box has no `b2` CLI;
that's why on-deploy convergence uses curl). Authorize the B2 CLI with the bucket-scoped key (never the master
key), then push the rule. CLI syntax differs by major version:

```bash
# B2 CLI v4+
b2 bucket update attachment-r8xq4m7z2p9n6k3v --cors-rules "$(cat attachment-bucket-cors.json)"

# B2 CLI v3
b2 update-bucket --corsRules "$(cat attachment-bucket-cors.json)" attachment-r8xq4m7z2p9n6k3v allPrivate
```

Changes take effect in ~1 minute. **GUI fallback** (looser — allows *all* operations for the origin): in the
bucket's *CORS Rules* dialog choose *"Share everything in this bucket with this one origin"* and enter
`https://4rgus.com`. Acceptable because the bucket is private and the server only ever mints get/put presigned
URLs, but prefer the CLI rule above.

## Verify by hand

1. With CORS **off** (or wrong origin), sending an image in the PWA fails — the browser console shows a CORS
   error on the `PUT` to `…backblazeb2.com`, and the attachment never uploads.
2. Apply the rule, wait ~1 min, retry: the image uploads and renders for the recipient.
3. Confirm the current rule from the CLI:
   ```bash
   b2 bucket get attachment-r8xq4m7z2p9n6k3v        # v4+   (v3: b2 get-bucket attachment-r8xq4m7z2p9n6k3v)
   ```
   `allowedOrigins` should be exactly `["https://4rgus.com"]` and `allowedOperations` `["s3_put","s3_get"]`.

## DB-backup bucket: Object Lock (WORM) — operator runbook (BKP-2)

Unrelated to CORS but adjacent. The `db-…` backup bucket holds our last line of defence. Until BKP-2 it had
**Object Lock disabled** and `backup-db.sh` held a key that could `delete-object` — so a compromised VM
credential could **wipe every backup** (the ransomware "delete the backups, then encrypt the data" play).
BKP-2 closes that: the bucket becomes **WORM** (write once, read many) and the backup key is re-minted
**without delete capability**, so a stolen key can no longer scrub backups.

The repo half (script + restore-runbook + threat-model changes) ships in the PR. **The steps below are the
console/CLI half — you run them by hand**, because there is no Terraform provider for B2 in this repo (same as
the CORS key above). Run them from your workstation (the VM has no `b2` CLI).

> **Verify every B2-behaviour claim in the current B2 console/docs before acting** — B2's S3-compatible Object
> Lock has evolved and the console wording lags the API. The four load-bearing facts this runbook relies on,
> each confirmed against B2 docs at time of writing: (1) Object Lock **can** be enabled on an **existing**
> bucket — no new bucket/migration needed; (2) **Compliance** mode default retention is settable from the web
> UI (governance default needs an API call); (3) in compliance mode **no one** — not a `bypassGovernance` key,
> not the account owner, not Backblaze support — can delete or shorten a lock before it expires; (4) a
> **lifecycle rule defers to Object Lock** — it can never delete a still-locked object, so it can't become a
> back-door deletion path.

### The knobs (decided in the BKP-2 threat model — `docs/threat-models/db-backup.md`)

| Knob | Value |
| --- | --- |
| Object Lock mode | **Compliance** |
| Default retention | **35 days** (a few days over the ~30-day logical window; kept small so a mis-type can't lock years of un-deletable storage) |
| Lifecycle: delete | prefix `argus-`, ~**35 days** (hide at 35d, delete 1d after hiding) |
| Lifecycle: abort stuck multipart | **1 day** (un-finalized multipart parts are NOT lock-protected and bill until aborted) |
| Re-minted backup key caps | `listBuckets, listFiles, readFiles, writeFiles` — **no** `deleteFiles`, **no** `bypassGovernance`, **no** `writeFileRetentions`/`*BucketRetentions` |

### 1. Enable Object Lock + compliance default retention (web console)

On the existing backup bucket `db-q7m2z9x4v6n8p3k1` (Bucket Settings → Object Lock):

- **Enable Object Lock** (this turns on file versioning too; it cannot be disabled later — that's the point).
- Set a **default retention**: mode **Compliance**, period **35 days**. New uploads then inherit the lock
  automatically — `backup-db.sh` does **not** send per-object lock headers.
- Existing pre-lock objects are **not** retroactively locked (only uploads after this inherit the default).
  That's fine: old objects age out under the lifecycle rule below; new nightly backups are WORM.

### 2. Lifecycle rules (web console → Lifecycle Settings)

Two rules on the same bucket:

- **Reap old backups:** file-name prefix `argus-`, "hide" after **35 days**, then delete **1 day** after
  hiding (B2's hide-then-delete; ≈36 days effective). Because delete-age ≥ lock retention, the rule only ever
  acts at/after unlock — and per fact (4) it can't touch a still-locked object even if it tried.
- **Abort incomplete multipart uploads** after **1 day** (S3 `AbortIncompleteMultipartUpload` / B2's
  cancel-unfinished). Without this a flapping uploader leaks un-reaped, un-lockable multipart parts.

### 3. Re-mint the backup key WITHOUT delete (workstation)

Mirror the CORS-key pattern above — bucket-scoped key, secret to Key Vault via `--file`, key-id (non-secret)
to the deploy variable. **Crucially: no `deleteFiles`.**

```bash
# 1. Mint the db-backups key, scoped to the backup bucket, WRITE/LIST/READ only (no delete, no bypass).
b2 key create --bucket db-q7m2z9x4v6n8p3k1 argus-b2-backup-key listBuckets,listFiles,readFiles,writeFiles
#    Prints "<keyId> <applicationKey>".

# 2. Store the applicationKey SECRET in Key Vault — overwrite the existing argus-b2-app-key secret
#    (the name backup-db.sh's LoadCredential already points at). --file, never argv (mirrors the CORS step).
umask 077; printf '%s' '<applicationKey>' >/tmp/b2backupkey
az keyvault secret set --vault-name <vault> --name argus-b2-app-key --file /tmp/b2backupkey --encoding utf-8
rm -P /tmp/b2backupkey   # macOS has no `shred`; -P overwrites before unlinking

# 3. Set the key-id (NON-secret) as the deploy variable that templates the backup unit.
gh variable set B2_APP_KEY_ID --repo <owner/repo> --body '<keyId>'
```

The bucket name is unchanged, so `BACKUP_S3_BUCKET` needs no update.

### 4. Cut over

Re-deploy so `deploy.sh` re-templates the unit with the new key-id (the secret is fetched from Key Vault on the
VM). Then trigger one nightly run and confirm it writes **two** objects to the bucket:

```bash
sudo systemctl start argus-db-backup.service && journalctl -u argus-db-backup.service -n 30
# Expect: "uploaded argus-globals-…" + "uploaded argus-db-…" and a final
#         "done … (retention: B2 Object Lock + lifecycle rule, not script prune)".
```

### 5. Restore drill (mandatory before trusting it)

Run the updated restore runbook in [`../backup/README.md`](../backup/README.md) against the real bucket and
confirm the newest-first / size-floor / paired-globals selection picks a good pair and the DB restores. An
untested backup is not a backup.

### 6. Verify by hand — the lock actually bites

```bash
# Pick any freshly-written (post-lock) object, then try to delete it with the re-minted key.
KEY=$(aws s3api list-objects-v2 --endpoint-url https://s3.eu-central-003.backblazeb2.com \
  --bucket db-q7m2z9x4v6n8p3k1 --prefix argus-db- \
  --query 'reverse(sort_by(Contents,&LastModified))[0].Key' --output text)
aws s3api delete-object --endpoint-url https://s3.eu-central-003.backblazeb2.com \
  --bucket db-q7m2z9x4v6n8p3k1 --key "$KEY"
# EXPECT: AccessDenied (the key has no deleteFiles). Even a delete-capable key must fail with
# the object still inside its 35-day Compliance retention. If the delete SUCCEEDS, Object Lock is not in
# effect — stop and recheck steps 1–2 before relying on the backups.
```
