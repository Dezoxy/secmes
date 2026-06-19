# Threat model: metadata exposure (what the crypto-blind server can infer)

> Status: **DRAFT for ratification.** Consolidates the metadata-disclosure residual that the other notes
> (`messaging-schema.md`, `realtime-delivery.md`, `delivery-receipts.md`, `pseudonymous-identity.md`,
> `mls-integration.md`) each reference but none owned. Crypto-blind ≠ metadata-blind: this is the single page
> that states, end-to-end, what the operator and a DB/infra compromise can learn even though message content
> is opaque MLS ciphertext. Required before any external privacy claim (sales security page, DPA, GA gate).

## 1. Feature & data flow

argus is end-to-end encrypted: message bodies, attachments, and group secrets are MLS ciphertext the server
can never read (invariant #1). But to **route and deliver** messages the server necessarily stores and
processes cleartext **routing metadata**. Tracing a message: a client encrypts, then POSTs a `CipherEnvelope`
(`packages/contracts`) carrying `conversationId`, `epoch`, and opaque ciphertext; the API writes a `messages`
row (`sender_user_id`, `conversation_id`, `epoch`, `created_at`, `attachment_object_key`) and fans it out over
the WebSocket gateway to the conversation's members. None of that exposes content — but the **shape** of
communication is visible to the server.

What the crypto-blind server (and therefore an operator, or a DB/infra compromise) can infer:

- **Social graph (in-conversation)** — `conversation_members` maps which users share which conversations, per
  tenant.
- **Pre-conversation social graph + direction** — `friendships` records who is connected to whom *before* any
  conversation exists, and `friendships.requested_by` reveals which side initiated (`schema.ts:282-292`).
- **Conversation kind** — `conversations.is_direct` (`schema.ts:76`) classifies each conversation as 1:1 vs
  group, sharpening social-graph inference.
- **Who-talks-to-whom and when** — `messages.sender_user_id` + `conversation_id` + `created_at`.
- **Read-receipt timing** — `conversation_receipts.delivered_at` / `read_at` + high-water message ids
  (`schema.ts:105-118`): second-precise "who read what, when," per member.
- **Volume & rough message size** — row counts and ciphertext length (no padding; see §6).
- **Device topology** — `devices` / `device_enrollments`: how many devices a user has and when they linked.
- **Presence / online activity** — live WebSocket connection state and subscription set.
- **Attachment existence, size, and timing** — blob object keys + B2 object sizes (content encrypted).
- **Lookup / discovery history** — `audit_events.metadata` records the argus-id each user probed via
  `users.lookup` and `friends.request_created` (`schema.ts:237-246`; `users.controller.ts:71-73`,
  `friends.controller.ts:142-144`). This is a durable record of *who searched for whom*, retained in the live DB
  and in every backup. ⚠️ The promised 90-day prune for `audit_events` is **not yet implemented**, so this
  history currently accumulates unbounded — tracked as a Must-fix in `docs/reviews/04-metadata-privacy.md`
  (F1/AR-1).
- **Pseudonymous identity** — display handle + email hint on invite; the IdP real-name is deliberately dropped
  (`pseudonymous-identity.md`).

## 2. Assets & trust boundaries

Asset: the **communication-pattern metadata** above (a privacy asset even though it is not content). Boundaries:
client↔server (the server is trusted to route, never to read), tenant↔tenant (RLS), and user↔operator (the
operator console is metadata-only by design, `operator.md` / invariant #6). The threat actor of interest here
is whoever can see server-side state: the operator, a subpoena, or an attacker who reaches the DB / logs.

## 3. Threats (STRIDE-lite)

- **Information disclosure (primary):** the metadata graph reveals relationships, timing, frequency, and
  device/presence patterns. Traffic-analysis of ciphertext sizes can fingerprint message types. This is
  **inherent to any delivery layer** that is not a mixnet — it is a disclosure we accept, not a bug, but it
  must be stated and bounded.
- **Tampering / Spoofing:** out of scope here (covered by `messaging-schema.md`, auth, and MLS).
- **Elevation of privilege:** cross-tenant metadata reads — mitigated by RLS (`rls-tenant-isolation.md`); the
  operator console is the only cross-tenant surface and exposes plan/SSO metadata only, never the message graph.

## 4. Invariant check

- **#1 crypto-blind:** holds — content stays ciphertext; this note is precisely about the metadata that
  remains *outside* content.
- **#2 no secret/content logging:** logs are IDs/metadata only — which is itself part of the exposure surface
  this note records (IDs reveal the graph to anyone with log access). No content, keys, or tokens are logged.
- **#3 RLS:** bounds metadata blast radius to one tenant.
- **#6 no admin content access:** the operator sees metadata only — consistent with, and bounded by, this note.
- **#4/#5:** not in tension.

## 5. Decision & mitigations

Ship with the metadata trade made **explicit and honest** (same trade Signal makes, minus sealed-sender):

- Conversations carry **no title/name** column; conversation IDs are **opaque** (no semantic leak).
- The IdP real name is dropped at the boundary (`pseudonymous-identity.md`); only a handle + optional email
  hint persist.
- Logs are **IDs/metadata only**, never content (invariant #2).
- RLS confines every metadata read to one tenant.
- Sales/DPA copy must state plainly: *"We cannot read your messages. We can see who is in a conversation and
  when messages flow — the same delivery metadata every non-mixnet messenger has."* Do not claim metadata
  privacy the architecture does not provide.

## 6. Residual risk

Accepted for the VM beta:

- **No message padding** → ciphertext length leaks approximate plaintext size. Padding is a future hardening.
- **No sealed-sender** → the server sees `sender_user_id` on every message (Signal hides this; argus does not yet).
- **Social graph + timing remain visible** to the operator and to anyone who compromises the DB or logs. This
  is the irreducible cost of a hosted delivery layer; closing it would require a mixnet / metadata-private
  transport, out of scope for the product. Documented here so it is a conscious, sellable position rather than
  a surprise in a buyer security review or pen test.
