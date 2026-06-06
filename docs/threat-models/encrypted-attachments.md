# Threat model: encrypted image attachments

> Status: **DRAFT for ratification.** Roadmap **Phase 4 (checkpoints 33–37)** — send/receive images the server **cannot read**. The image is encrypted client-side under a fresh per-attachment **content key**; the server only brokers **presigned URLs** to a private blob container and stores **metadata + opaque ciphertext refs**. Server half (presigned-grant endpoints + `attachments` table + the `packages/crypto` content-key primitive) is buildable now against **Azurite**; the Azure-Blob prod credential + the picker/render UI land with Phase 0 / the client (#39).

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
  recipient --GET /attachments/:id/url--> API: authorizes from the ROW's conversation_id (member
          only, 404 otherwise) — NOT the client message ref; presigned GET -> {downloadUrl}
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
- **DoS — upload abuse / storage exhaustion.** Enforce **byte-size + (encrypted) type limits** at grant time and in the row; short upload-URL TTL; **expiry + cleanup** of unreferenced/expired blobs (roadmap 37). Per-caller quota is a follow-up.
- **Elevation / confused-deputy — read another conversation's image.** The send path stores **any** client-supplied `attachmentObjectKey` on a message, so authorizing a download from "a conversation that references this key" would let a same-tenant user echo another blob's key into a conversation they control and mint a URL for it (IDOR). **Mitigation:** the attachment is bound at upload to a **server-verified `conversation_id`** (the uploader's membership is checked at the grant), and downloads authorize from **that row's `conversation_id`** — never from a client message ref. Member-only, same membership-404 (no existence oracle); composite FKs pin the attachment's conversation + uploader to its tenant.

## 4. Invariant check

- **#1 crypto-blind** — **upheld**: server stores opaque AEAD ciphertext + metadata, brokers URLs, never decrypts. Plaintext and content key never reach it.
- **#2 no secret logging** — **load-bearing here**: presigned URLs are capabilities → minted and forgotten, never persisted/logged; content key never touches the server. Logs = object keys + IDs.
- **#3 RLS** — `attachments` is tenant-scoped: `tenant_id` + ENABLE/FORCE RLS + WITH CHECK + leading-`tenant_id` index + composite-FK tenant pinning, like the messaging tables.
- **#4 no hand-rolled crypto** — the content-key AEAD is a **vetted primitive in `packages/crypto`** (CSPRNG key/nonce; reuse the MLS lib's AEAD or the same `@noble` path used elsewhere). No primitives outside `packages/crypto`.
- **#5 secrets via Key Vault** — the storage-account credential that **mints** presigned URLs comes from Key Vault via Workload ID; never in pods/env/Helm values. (Locally: Azurite well-known dev key, never committed as a real secret.)
- **#6 no admin path to content** — admin/ops surfaces expose attachment **metadata** only (size, timing, refs); never the image, never a download URL.

**No invariant conflict** — encrypted-blob attachments *strengthen* the crypto-blind posture. Proceed.

## 5. Decision & mitigations

- Build the **server slice** behind a `BlobStore` abstraction (mirrors `RealtimeBus`): an **Azure-Blob** impl run against **Azurite** locally / Azure Blob in prod. Endpoints: `POST /attachments` (mint upload grant + create row, **own-caller**, Zod-validated, size-bounded) and `GET /attachments/:id/url` (member-only download grant). `messages.attachment_object_key` already carries the ref.
- Migration **`attachments`**: `tenant_id`, **`conversation_id`** (server-verified owning conversation — composite-FK to `conversations`, ON DELETE CASCADE; drives download authz), `object_key` (**globally unique** + a CHECK pinning it to the row's `tenant_id` prefix — the blob store is OUTSIDE Postgres RLS, so cross-tenant blob aliasing fails closed at the schema, not just by app convention), `byte_size`, `uploaded_by` (verified caller, NO-ACTION FK like `sender_user_id`), `created_at`, `expires_at` — **ciphertext refs only**, no content column, no plaintext content-type. **Download authz is from the row's `conversation_id`, never a client message ref.**
- Content-key primitive in `packages/crypto` (`encryptAttachment`/`decryptAttachment`): CSPRNG content key + AEAD over bytes; the key is exported for MLS-wrapping by the caller, never by the server.
- **Gates:** `crypto-reviewer` (content-key encryption) + `security-boundary-auditor` (presigned endpoints, RLS, **no-URL-logging**, download authz, no-IDOR) + `infra-reviewer` (private container, no public endpoint, least-priv SAS, EU region). Tests: RLS isolation, member-only download 404, **presigned URL never appears in logs/DB**, size-limit rejection, AEAD tamper-fail. `42Crunch` re-audit incl. attachment routes (roadmap 38).

## 6. Residual risk

- **Metadata to the operator** — attachment **count / size / timing** per conversation is visible (on top of message metadata). Disclosed in plan §14/§15 + DPA; size is intrinsic to object storage.
- **Storage provider sees ciphertext + access patterns** — accepted: the blob is opaque AEAD ciphertext in a private, EU-region container; the provider can't read it.
- **Presigned-URL TTL window** — a leaked URL is usable until expiry; mitigated by short TTL + single-object/verb scope. Acceptable for this phase.
- **Per-caller upload quota** not yet enforced (size cap + expiry only) — abuse quota rides with rate limiting (#46).
