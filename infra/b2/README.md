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
- **`exposeHeaders: ["ETag"]`** — lets the client read the upload response. Optional (integrity is the GCM
  tag, not the ETag) but harmless.
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
do it. Mint **one dedicated B2 application key** for it:

- **Capabilities:** `listBuckets`, `readBucketCors`, `writeBucketCors` — **not** the coarse `writeBuckets`,
  and **no** file capabilities. (If your B2 account only exposes `writeBuckets`, the bucket restriction below
  becomes the load-bearing control.)
- **Bucket restriction:** restricted to **`attachment-r8xq4m7z2p9n6k3v` only**. This is what guarantees the
  key can never touch the `db-…` backup bucket (cleartext metadata) or any file. `deploy.sh` asserts the
  authorized bucket name matches and fails closed otherwise.

Then wire it up (native B2 auth needs `keyId:applicationKey`):

- Store the **applicationKey secret** in Key Vault as `argus-b2-cors-app-key` (via `populate-keyvault.sh`).
- Set the **keyId** (non-secret) as the GitHub repo variable `B2_CORS_KEY_ID` (via `setup-github-cicd.sh`, or
  `gh variable set B2_CORS_KEY_ID --body <keyId>`).

Until `B2_CORS_KEY_ID` is set, `deploy.sh` **skips** CORS convergence with a log line (opt-in, non-breaking) —
apply manually in the meantime via the break-glass path below.

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

## TODO — DB-backup bucket Object Lock

Unrelated to CORS but adjacent: the `db-…` bucket currently has **Object Lock disabled**. Enabling Object Lock
(WORM) makes backups immune to a compromised VM credential deleting/overwriting them — `backup-db.sh` holds a
key that can already `delete-object`. Track separately; it is a recovery-posture gap, not a CORS one.
