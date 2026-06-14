# Threat model: encrypted attachments

> Status: **IMPLEMENTED** (shipped; reviewer-passed — see roadmap). Blocks Phase 4 (checkpoints 33–38). Object storage (Blob/MinIO) lives **outside** Postgres RLS, so the protections RLS gives every other table do not apply here — authz must be enforced explicitly at the API + storage layer.

## 1. Feature & data flow

```
client: random content-key -> encrypt image locally
client: ask API for a presigned upload URL  (server decides the object key)
client: PUT ciphertext blob to storage
client: send an E2EE message whose envelope contains {object_key, content-key wrapped for recipient}
recipient: ask API for a presigned download URL -> GET blob -> decrypt locally
```

The **content key never reaches the server in the clear** — it lives inside the MLS-encrypted message envelope only. The blob is ciphertext. The server only handles routing metadata (object key, size).

## 2. Assets & trust boundaries

- **Asset:** the encrypted image blob (large, sensitive even as ciphertext — its existence/size/timing is metadata) and its content key (inside the envelope).
- **Boundary:** tenant↔tenant and member↔non-member at the storage layer, which RLS does **not** cover.

## 3. Threats (STRIDE-lite)

1. **Cross-tenant / IDOR on the object key (Information disclosure — primary risk).**
   Today the client chooses the key and echoes `attachmentObjectKey` back (`packages/contracts/src/index.ts`). A client could request a presigned URL for **another tenant's** object key, or guess/enumerate keys.
   → **Mitigations:**
   - **Server generates the key**, never the client: `att/{tenant_id}/{conversation_id}/{uuid4}`. The client receives it in the presigned-upload response.
   - On **upload**: mint a presigned PUT only after verifying the caller is a member of `conversation_id` **and** the conversation's `tenant_id` matches the caller's token.
   - On **download**: mint a presigned GET only after verifying the caller is a member of the conversation that owns an `attachments` row referencing that key (look it up under RLS — `attachments` is a tenant table); validate the requested key matches the server-issued format and tenant prefix.
   - Reject any `attachmentObjectKey` that doesn't match the server-issued pattern for the caller's tenant. (Change the contract: the field is a server-issued opaque id, not a client free-string.)

2. **Tampering / content smuggling.** A client uploads a blob then references it from a message in a conversation it isn't in.
   → The `attachments` row is created server-side, tenant+membership-checked, and links message→object; downloads resolve through that row, not a raw key.

3. **Resource abuse (DoS / cost).** Unbounded blob size/count.
   → Enforce max size + allowed (encrypted) content-length at presign time; per-tenant quota; lifecycle/expiry rules; rate-limit presign requests.

4. **Stale/leaked presigned URLs (Info disclosure).** Presigned URLs are bearer tokens.
   → Short TTL (minutes); never logged (already a banned log pattern); scoped to a single object + verb.

5. **Public bucket misconfig.** → Private container, no public access, access only via short-lived presigned URLs (already in the plan; add a Checkov/infra check).

## 4. Invariant check

Upholds #1 (server never sees plaintext or the content key), #2 (no presigned URLs in logs), #3 (membership/tenant checks before any URL is minted), #6 (admins see metadata only). Tension: object storage is outside RLS — compensated by explicit server-side authz above.

## 5. Decision & mitigations

- **Contract change:** `attachmentObjectKey` becomes a server-issued opaque id; presigned URLs are issued only after membership+tenant verification on both upload and download.
- Key format `att/{tenant_id}/{conversation_id}/{uuid}`; `attachments` table (tenant-scoped, RLS) is the source of truth linking message→object.
- Size/type limits, per-tenant quota, expiry lifecycle, short presign TTL.
- **Tests:** cross-tenant presign request → denied; non-member of a conversation → denied; malformed/foreign key → denied; oversized → denied.

## 6. Residual risk

Metadata (that an attachment exists, its size, timing) is visible to the operator — inherent to a delivery service. Disclose in §14/§15 + the DPA. Accept for beta.
