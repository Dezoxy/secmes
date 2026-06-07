# Threat model: encrypted image attachments

> Status: **Server slice (A2) BUILT.** Roadmap **Phase 4 (checkpoints 33–37)** — send/receive images the server **cannot read**. The image is encrypted client-side under a fresh per-attachment **content key**; the server only brokers **presigned URLs** to a private bucket and stores **metadata + opaque ciphertext refs**. Done: the `attachments` table (#57), the `packages/crypto` content-key primitive (A1), and the presigned-grant endpoints + `BlobStore` (A2). The blob store is **Azure Blob Storage** (the settled cloud) behind a `BlobStore` abstraction — **Azurite** locally, the managed Azure Blob account in prod. Presigned URLs are **SAS**: an account-key SAS against Azurite locally, a **user-delegation SAS** signed via **Entra Workload Identity** in prod (no account key in the pod). The picker/render UI lands with the client (A3).

## 1. Feature & data flow

```
upload:
  client: image --(AEAD, random CONTENT KEY, CSPRNG)--> ciphertext blob
  client --POST /attachments {conversationId, byteSize}--> API: VERIFIES caller is a member of
          conversationId; mints a short-TTL, single-object presigned PUT to a PRIVATE container
          (cred from Key Vault) -> {objectKey, uploadUrl}; records the attachments row BOUND to
          conversationId (METADATA ONLY); NEVER persists/logs uploadUrl
  client --PUT ciphertext--> blob storage        (DIRECT; the API never sees the bytes)
  client: wraps CONTENT KEY for recipients via MLS, sends a message referencing objectKey
download:
  recipient: unwrap CONTENT KEY via MLS
  recipient --POST /attachments/download-url {objectKey}--> API: looks up the row by objectKey,
          authorizes from the ROW's conversation_id (member only, 404 otherwise) — NOT the client
          message ref; presigned GET -> {url}
  recipient --GET ciphertext--> blob storage; decrypt with CONTENT KEY; render
```

The server is **never in the data path** and **never holds the content key** — it brokers time-limited, single-object URLs and stores an opaque AEAD blob it cannot decrypt. The content key travels **only inside the E2EE message envelope** (treated exactly like message content).

## 2. Assets & trust boundaries

- **Assets:** image **plaintext** (client-only); per-attachment **content key** (client-only, lives only in the MLS envelope); **blob ciphertext** (storage holds, unreadable); **attachment metadata** (server sees object key + byte size + timing + uploader).
- **Boundaries:** client ↔ blob-storage (time-limited presigned URL scoped to **one** object); client ↔ API (presigned grants + refs); tenant ↔ tenant (RLS + per-tenant object-key prefix); member ↔ non-member (download authz); user ↔ admin (metadata only).

## 3. Threats (STRIDE-lite)

- **Spoofing — grab someone else's upload/download slot.** The grant's `objectKey` is server-chosen and tenant-prefixed; the uploader/downloader is the **verified caller**; the presigned URL is scoped to a single object + verb + short TTL — it can't be repurposed to enumerate or overwrite other objects.
- **Tampering — swap/corrupt a blob.** The content-key **AEAD tag** fails closed on any modification; a recipient decrypting a tampered blob gets an auth-failure, not garbage. Upload grants are write-only to a fresh key (no overwrite of an existing object).
- **Information disclosure — the big one.** (a) Server/operator must never see plaintext or the content key — upheld by client-side encryption + key-in-envelope. (b) **Presigned URLs are secrets** (they embed a capability) → **never logged or persisted** (invariant #2); logs carry `objectKey`/IDs only. (c) Private container, **no public/anonymous access**. (d) RLS + membership stop cross-tenant / non-member reads. (e) Metadata leakage (size/type) minimized: store **no plaintext content-type**; size is unavoidable metadata.
- **DoS — upload abuse / storage exhaustion.** Enforce **byte-size + (encrypted) type limits** at grant time and in the row; short upload-URL TTL; **expiry + cleanup** of unreferenced/expired blobs (roadmap 37). The upload grant is **atomic** — the metadata row insert and the presign share one tx, so a failed/​unconfigured presign rolls back the row and leaves **no orphan metadata**. Per-caller quota is a follow-up.
- **Elevation / confused-deputy — read another conversation's image.** The send path stores **any** client-supplied `attachmentObjectKey` on a message, so authorizing a download from "a conversation that references this key" would let a same-tenant user echo another blob's key into a conversation they control and mint a URL for it (IDOR). **Mitigation:** the attachment is bound at upload to a **server-verified `conversation_id`** (the uploader's membership is checked at the grant), and downloads authorize from **that row's `conversation_id`** — never from a client message ref. Member-only, same membership-404 (no existence oracle); composite FKs pin the attachment's conversation + uploader to its tenant.

## 4. Invariant check

- **#1 crypto-blind** — **upheld**: server stores opaque AEAD ciphertext + metadata, brokers URLs, never decrypts. Plaintext and content key never reach it.
- **#2 no secret logging** — **load-bearing here**: presigned URLs are capabilities → minted and forgotten, never persisted/logged; content key never touches the server. Logs = object keys + IDs.
- **#3 RLS** — `attachments` is tenant-scoped: `tenant_id` + ENABLE/FORCE RLS + WITH CHECK + leading-`tenant_id` index + composite-FK tenant pinning, like the messaging tables.
- **#4 no hand-rolled crypto** — the content-key AEAD is a **vetted primitive in `packages/crypto`** (CSPRNG key/nonce; reuse the MLS lib's AEAD or the same `@noble` path used elsewhere). No primitives outside `packages/crypto`.
- **#5 secrets via Workload Identity** — the SAS that authorizes upload/download is signed prod-side by a **user-delegation key fetched via Entra Workload Identity** (`DefaultAzureCredential`); **no account key ever lives in the pod, Key Vault, or Helm values**. (Locally: Azurite's **public well-known dev key** signs an account-key SAS — a fixed, documented constant, not a real secret; injected via `make api-dev`'s `BLOB_*` env and gitleaks-allowlisted.)
- **#6 no admin path to content** — admin/ops surfaces expose attachment **metadata** only (size, timing, refs); never the image, never a download URL.

**No invariant conflict** — encrypted-blob attachments *strengthen* the crypto-blind posture. Proceed.

## 5. Decision & mitigations

- **BUILT (A2):** the **server slice** behind a `BlobStore` abstraction (mirrors `RealtimeBus`): an **`AzureBlobStore`** (`@azure/storage-blob`) run against **Azurite** locally / the managed **Azure Blob** account in prod, plus a fail-closed `UnconfiguredBlobStore` selected by a `useFactory` when no blob config is present. Presigning = **SAS**: an account-key SAS against Azurite (the public dev key), a **user-delegation SAS via Workload Identity** in prod (no account key in the pod). Endpoints: `POST /attachments` (mint upload grant + create row, **member-only**, Zod-validated, **10 MiB** `byteSize` cap) and `POST /attachments/download-url` (member-only download grant, takes the opaque `objectKey` — never a URL; **hard-enforces the 10 MiB cap on the blob's ACTUAL size** — refuses to serve an oversized blob with 413). Both presigns run **outside** the RLS tx; TTL 300 s, single object + verb. Membership authz (`requireUser` → verified tenant user; `requireMembership` → same-404) is extracted to a shared `messaging/membership.ts` so the attachment paths and the message paths share **one** authz impl (no IDOR drift). `messages.attachment_object_key` already carries the ref.
- Migration **`attachments`**: `tenant_id`, **`conversation_id`** (server-verified owning conversation — composite-FK to `conversations`, ON DELETE CASCADE; drives download authz), `object_key` (**globally unique** + a CHECK pinning it to the row's `tenant_id` prefix — the blob store is OUTSIDE Postgres RLS, so cross-tenant blob aliasing fails closed at the schema, not just by app convention), `byte_size`, `uploaded_by` (verified caller, NO-ACTION FK like `sender_user_id`), `created_at`, `expires_at` — **ciphertext refs only**, no content column, no plaintext content-type. **Download authz is from the row's `conversation_id`, never a client message ref.**
- Content-key primitive in `packages/crypto` (`encryptAttachment`/`decryptAttachment`): CSPRNG content key + AEAD over bytes; the key is exported for MLS-wrapping by the caller, never by the server.
- **Prod-wiring hand-off (deferred, NOT in the A2 code slice — `infra-reviewer` P2):** the storage account + container land with Terraform later; that PR MUST (a) create the **container** in an **EU-region** storage account, (b) keep **public/anonymous access disabled** (the default — no anonymous blob/container access), (c) grant the pod's **Workload Identity** the least-privilege **Storage Blob Data Contributor** role scoped to *that container* (read/write blobs only — not account/container management; the container is provisioned by Terraform, never created by the app in prod), (d) grant the **Storage Blob Delegator** permission so the pod can mint user-delegation keys, and (e) require **HTTPS-only** on the account + a private endpoint. No account key in Key Vault or the pod at all — the SAS is signed with a short-lived user-delegation key. The blob store's security posture is only *real* once these exist.
- **Gates:** `crypto-reviewer` (content-key encryption, A1) + `security-boundary-auditor` (presigned endpoints, RLS, **no-URL-logging**, download authz, no-IDOR) + `infra-reviewer` (private container, no public/anonymous access, least-priv Workload-Identity role, EU region, HTTPS-only). Tests built: A1 — AEAD tamper-fail + size-limit reject (`packages/crypto`); A2 — live-DB membership grants (member upload writes a tenant-prefixed row; non-member/other-tenant/unknown-key all 404; download authz from the row's conversation, no IDOR) + schema bounds (oversize/extra-key/non-UUID/URL rejected). `42Crunch` re-audit incl. attachment routes (roadmap 38).

## 6. Residual risk

- **Metadata to the operator** — attachment **count / size / timing** per conversation is visible (on top of message metadata). Disclosed in plan §14/§15 + DPA; size is intrinsic to object storage.
- **Storage provider sees ciphertext + access patterns** — accepted: the blob is opaque AEAD ciphertext in a private, EU-region container; the provider can't read it.
- **Presigned-URL TTL window** — a leaked URL is usable until expiry; mitigated by short TTL + single-object/verb scope. Acceptable for this phase.
- **Declared vs. actual upload size** — a block-blob SAS PUT does not bind `Content-Length`, so a member could PUT more than the declared `byteSize`. **Mitigated:** the download grant checks the blob's **actual** size (`getProperties`, metadata only) and **refuses to serve anything over the 10 MiB cap (413)** — an oversized upload is therefore **never downloadable**. The remaining residual is only the one-time storage cost of the rejected PUT until the lifecycle worker (roadmap 37) reclaims it — bounded (own-tenant, private container, rate-limited #46).
- **Per-caller upload quota** not yet enforced (size cap + expiry only) — abuse quota rides with rate limiting (#46).
