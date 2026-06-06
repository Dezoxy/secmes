# Threat model: delivery receipts (sent / delivered / read)

> Status: **DRAFT for ratification.** Roadmap **checkpoint 31** — per-member, per-conversation **delivery/read high-water-marks** so a sender can see how far each recipient has received/read. This is **metadata**, not message content; the server stores it in clear. Server half (storage + REST); the live "read" update + the client's opt-in lands with the client app (#39).

## 1. Feature & data flow

```
recipient → POST /conversations/:id/receipts { status: delivered|read, throughMessageId }
            → server upserts the caller's watermark for that conversation (advances only forward)
sender    → GET /conversations/:id/receipts → per-member { deliveredThrough?, readThrough?, *At }
```

The server records only **watermarks** (a message id + its timestamp the user has delivered/read *through*) and **when**. It never sees message plaintext — receipts are about *delivery state*, not content. "sent" is implicit (the message row exists); "delivered"/"read" are recipient-asserted watermarks.

## 2. Assets & trust boundaries

- **Asset:** receipt **metadata** — who read/received which message, and when. Behavioral signal worth minimizing, but not E2EE content.
- **Boundaries:** tenant ↔ tenant (RLS); member ↔ non-member (only members of a conversation can post/read its receipts); user ↔ user (you can only post your *own* receipt; you can read others' watermarks within your conversation — that's the point of a receipt).

## 3. Threats (STRIDE-lite)

- **Spoofing — post a receipt as someone else.** The receipt's `user_id` is the **verified caller** (sub→user), never client input; you can only advance your own watermark.
- **Tampering / rollback.** Watermarks **only advance** (monotonic on `(created_at, id)` of the referenced message); a replayed/older `throughMessageId` can't move a watermark backward.
- **Information disclosure — read-receipt privacy.** A read receipt reveals reading behavior. The **server mechanism is neutral**: it stores a receipt only if the client sends one. Whether to send read receipts is a **client-controlled user setting** (privacy), mirroring Signal/WhatsApp — out of scope for the server, but the server must never *infer* a read receipt the client didn't send. Cross-tenant/cross-conversation leakage is barred by RLS + membership.
- **Elevation — receipt for a foreign conversation/message.** Member-gated (same 404 as messaging); `throughMessageId` must be a message **in that conversation** (composite check), so a receipt can't reference another conversation's message.

## 4. Invariant check

- **#1 crypto-blind** — upheld: receipts are delivery metadata (ids + timestamps), never content; nothing decrypted.
- **#2 no secret logging** — receipts carry no secrets; IDs/metadata only.
- **#3 RLS** — `conversation_receipts` is tenant-scoped with ENABLE+FORCE RLS + composite-FK tenant pinning (conversation + user), like the messaging tables.
- **#4/#5/#6** — N/A / upheld.

## 5. Decision & mitigations

- Migration `0010_conversation_receipts.sql`: `(tenant_id, conversation_id, user_id)` unique; denormalized `delivered_through_*` / `read_through_*` watermark columns (message id + its created_at + the receipt time) so monotonic advance is a single conditional upsert; composite FKs `(tenant_id, conversation_id)→conversations` and `(tenant_id, user_id)→users`. Grants: `select, insert, update` (advance in place; no delete).
- `POST /conversations/:id/receipts` (member-gated, own watermark only, monotonic) + `GET /conversations/:id/receipts` (member-gated, per-member watermarks).
- Gate: **`security-boundary-auditor`** review; live-DB tests (advance, monotonic no-rollback, member-only authz, cross-tenant, foreign-message rejection).

## 6. Residual risk

- **Metadata to the operator** — receipts add "who read what, when" to the metadata the operator can see (on top of membership + message timing). Disclosed in plan §14/§15 + the DPA. Read-receipt *sending* is client-opt-in; a privacy-max user disables them.
- **No realtime receipt push yet** — the sender sees read state on the next `GET`/reconnect; live receipt delivery over the WS gateway is a follow-up (rides the existing bus).
- **Watermark, not per-message** — "read through X" implies all ≤ X read; it can't express "read message 5 but not 3". Standard for chat; acceptable.
