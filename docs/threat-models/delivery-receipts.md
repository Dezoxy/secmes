# Threat model: delivery receipts (sent / delivered / read)

> Status: **DRAFT for ratification.** Roadmap **checkpoint 31** — per-member, per-conversation **delivery/read high-water-marks** so a sender can see how far each recipient has received/read. This is **metadata**, not message content; the server stores it in clear. Server half (storage + REST) landed in PR #55; **this revision adds the live receipt push over the WS gateway + the client wiring** (the receiver POSTs receipts; a new realtime `receipt` event flips the sender's ticks live; read-receipt sending is client-opt-in with reciprocal display).

## 1. Feature & data flow

```
recipient → POST /conversations/:id/receipts { status: delivered|read, throughMessageId }
            → server upserts the caller's watermark for that conversation (advances only forward)
sender    → GET /conversations/:id/receipts → per-member { deliveredThrough?, readThrough?, *At }
```

The server records only **watermarks** (a message id + its timestamp the user has delivered/read *through*) and **when**. It never sees message plaintext — receipts are about *delivery state*, not content. "sent" is implicit (the message row exists); "delivered"/"read" are recipient-asserted watermarks.

**Live push (this revision).** After the watermark upsert commits, the service emits a `ReceiptAdvancedEvent` on the realtime bus (in-process or the Redis backplane channel `argus:realtime:receipt-advanced`). The WS gateway fans a `receipt` frame out to the conversation **room** (`tenantId:conversationId`) — the same room-scoped path messages use. The frame is **metadata only**: `{ conversationId, userId, status, throughMessageId }`, where `userId` is the **internal** member id (matches `GET /receipts`). The sender's client folds the peer's watermark onto its own messages to flip ticks; the recipient's client gates **read** sends on a local privacy toggle and applies a **reciprocal display cap** (toggle off ⇒ don't send `read` AND don't render peers' `read`).

```
recipient client → POST …/receipts {status, throughMessageId}
  → service upserts watermark → emitReceiptAdvanced → bus (Redis channel) → gateway
  → 'receipt' frame to room tenantId:conversationId → sender client folds → tick flips live
```

## 2. Assets & trust boundaries

- **Asset:** receipt **metadata** — who read/received which message, and when. Behavioral signal worth minimizing, but not E2EE content.
- **Boundaries:** tenant ↔ tenant (RLS); member ↔ non-member (only members of a conversation can post/read its receipts); user ↔ user (you can only post your *own* receipt; you can read others' watermarks within your conversation — that's the point of a receipt).

## 3. Threats (STRIDE-lite)

- **Spoofing — post a receipt as someone else.** The receipt's `user_id` is the **verified caller** (sub→user), never client input; you can only advance your own watermark.
- **Tampering / rollback.** Watermarks **only advance** (monotonic on `(created_at, id)` of the referenced message); a replayed/older `throughMessageId` can't move a watermark backward.
- **Tampering — stale watermark across membership churn.** A receipt is **owned by its membership**: removing a member `ON DELETE CASCADE`-deletes their receipt (the composite FK targets `conversation_members`), so a removed-then-re-added member starts with a **clean** watermark instead of resurfacing a stale read/delivery position from a prior membership. Verified to fire for the non-superuser app role under FORCE RLS.
- **Information disclosure — read-receipt privacy.** A read receipt reveals reading behavior. The **server mechanism is neutral**: it stores a receipt only if the client sends one. Whether to send read receipts is a **client-controlled user setting** (privacy), mirroring Signal/WhatsApp — out of scope for the server, but the server must never *infer* a read receipt the client didn't send. Cross-tenant/cross-conversation leakage is barred by RLS + membership.
- **Elevation — receipt for a foreign conversation/message.** Member-gated (same 404 as messaging); `throughMessageId` must be a message **in that conversation** (composite check), so a receipt can't reference another conversation's message.
- **Information disclosure — live `receipt` fan-out scope.** The `receipt` frame goes only to sockets **subscribed to that conversation's room** (`tenantId:conversationId`), and a socket joins a room only after a `messaging.isMember` check — identical authz to message delivery. A receipt therefore never crosses a tenant or reaches a non-member. The actor's own sockets get the echo too; the client ignores a `receipt` whose `userId` is its own (only the *peer's* watermark moves a sender's ticks).
- **Tampering — poisoned event on the Redis backplane.** The receipt channel payload is `safeParse`d against `ReceiptAdvancedEventSchema` before fan-out (same defensive posture as the message/welcome channels); a malformed event is dropped, not delivered, and can't crash the gateway. Publish is best-effort (`enableOfflineQueue:false`, errors swallowed) — a dropped push only delays a tick flip; the watermark is durable and re-seeds via `GET /receipts` on the next subscribe.

## 4. Invariant check

- **#1 crypto-blind** — upheld: receipts are delivery metadata (ids + timestamps), never content; nothing decrypted. The live `receipt` event carries no ciphertext — only ids + a `delivered|read` status cross the bus/socket.
- **#2 no secret logging** — receipts carry no secrets; IDs/metadata only. The new event and WS frame are ids/status only (no tokens, no content).
- **#3 RLS** — `conversation_receipts` is tenant-scoped with ENABLE+FORCE RLS + a composite FK to `conversation_members` pinning tenant + conversation + user to a **real membership**, like the messaging tables.
- **#4/#5/#6** — N/A / upheld.

## 5. Decision & mitigations

- Migration `0010_conversation_receipts.sql`: `(tenant_id, conversation_id, user_id)` unique; denormalized `delivered_through_*` / `read_through_*` watermark columns (message id + its created_at + the receipt time) so monotonic advance is a single conditional upsert; a single composite FK `(tenant_id, conversation_id, user_id)→conversation_members` **ON DELETE CASCADE** ties each receipt to a live membership — stronger tenant-pinning than separate conversation/user FKs (it forces a real membership pair) and it cleans up watermarks on member removal (see §3 churn). Grants: `select, insert, update` (advance in place; no delete — cleanup cascades from the membership).
- `POST /conversations/:id/receipts` (member-gated, own watermark only, monotonic) + `GET /conversations/:id/receipts` (member-gated, per-member watermarks).
- **Live push:** `ReceiptAdvancedEvent` on the realtime bus (in-process + Redis channel `argus:realtime:receipt-advanced`, Zod-validated on decode); gateway `deliverReceipt` fans a `receipt` frame to the conversation room only; client folds the peer watermark → ticks, gates `read` on the privacy toggle, applies the reciprocal display cap, ignores its own echo.
- Gate: **`security-boundary-auditor`** review; live-DB tests (advance, monotonic no-rollback, member-only authz, cross-tenant, foreign-message rejection, **post-commit emit carries the internal user id + metadata only**); gateway tests (receipt fan-out is room-scoped, never reaches an unsubscribed socket or crosses a tenant); Redis cross-pod + malformed-payload tests; client unit tests (watermark fold upgrades-not-downgrades, reciprocal clamp, dedup).

## 6. Residual risk

- **Metadata to the operator** — receipts add "who read what, when" to the metadata the operator can see (on top of membership + message timing). Disclosed in plan §14/§15 + the DPA. Read-receipt *sending* is client-opt-in; a privacy-max user disables them.
- **Realtime receipt push now shipped** — the sender's ticks flip live via the `receipt` WS frame; if the best-effort push is dropped (Redis down, socket mid-reconnect) the watermark is still durable and re-seeds via `GET /receipts` on the next subscribe. ~~previously a follow-up~~.
- **Watermark, not per-message** — "read through X" implies all ≤ X read; it can't express "read message 5 but not 3". Standard for chat; acceptable.
