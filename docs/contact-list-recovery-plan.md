# Implementation plan: contact list survives a PWA reinstall — via a server-backed Friends list

> **Status:** REVISED 2026-06-18 for the **friends-list pivot** (security-architect ratified, third pass).
> This supersedes the original "recover the roster into the conversation list" approach. The conversation
> list is now **ephemeral** (empty after reinstall); a **server-backed Friends list** is the durable contact
> source. The reinstall mechanics, the crypto reasoning, and the tap-to-resume identity-change spine carry
> over unchanged.
> **This doc is the implementation roadmap.** The companion *threat-model note* lives at
> `docs/threat-models/contact-list-recovery.md` (authored task #20, merged #234) and gets a friends-graph
> section added (see *Residual risks*).
> **Tracker / status:** task #20 (threat-model note) merged #234 · task #21 (roster recovery) merged #235 —
> **its user-facing placeholders are now reverted, see Slice B** · task #22 (verified-state spine) in flight
> as **PR #236 — keep as-is, see Slice A** · task #23 (tap-to-resume) folds into Slices E/F. New friends-graph
> slices (table, API, UI wiring) are new tracker items. Sits **behind** the first AWS deploy — net-new, does
> not block shipping.

## Owner ask (updated)

"If I uninstall the PWA I lose chat history — correct and intended. After a reinstall the **conversation list
should be empty** (history is gone). My **contacts** come back in a separate **Friends list** — the friends
I've **accepted** and the friend **requests** (incoming + outgoing) that are still open. Tapping a friend lets
me start chatting again right away. This is nicer and easier to understand than greyed-out placeholder
conversations."

## What changed from the original plan (the pivot, in one place)

| | Original (roster recovery) | Revised (friends list) |
|---|---|---|
| Contact source after reinstall | read `conversation_members` → **placeholders in the conversation list** | a **server-backed Friends list** (accepted friendships) |
| Conversation list after reinstall | repopulated with read-only placeholders | **empty** — conversations reappear only as history flows |
| New server state | none (reused routing graph) | **one `friendships` table** (accepted-only; pending is ephemeral) |
| Friend requests | n/a | first-class, server-delivered, **not** persisted as a rejection ledger |
| Tap-to-resume | tap a placeholder | tap an accepted friend — **same crypto path** |
| Verified-state spine (PR3/#236) | required | **unchanged, still required** |

**Why the pivot is sound:** the original Option-A premise — "the server already stores the social graph
(`conversation_members`) to route messages, so reading it back exposes nothing new" — only holds for
*consummated* relationships (people already in a conversation). A Friends list needs a contact to be durable
**before** any conversation exists, which the routing graph cannot express. That requires a small amount of
genuinely new server state. The security-architect's call (below) keeps that delta to the **same class** of
metadata the server already holds ("these two users are connected") and refuses the larger surface Codex's
first sketch implied (a persisted `pending|accepted|declined|cancelled` ledger that would record *rejected*
and *unrequited* intent — a thing the architecture has so far never let the server see).

## TL;DR

Three parts:

1. **Friends graph (the new durable contact source).** A single tenant-scoped `friendships` table stores
   **only accepted friendships**. Friend **requests are ephemeral**: a request is a short-lived `pending` row
   (TTL'd) or a delivered event; **decline/cancel is a hard DELETE**, never a retained "rejected" record. The
   server therefore learns the same *kind* of fact it already knows from `conversation_members` ("A and B are
   connected"), just decoupled from a conversation existing — and never becomes a who-asked-whom-and-got-turned
   -down ledger.
2. **Conversation list is ephemeral.** After reinstall it is **empty**; conversations reappear only as live
   messages flow. The original roster-into-conversation-list placeholders (task #21 / #235) are **reverted**
   (the server-side `is_direct` column and reads are **kept** — the friends graph reuses them).
3. **Tap-to-resume + identity-change signal (unchanged crux).** Tapping an accepted friend starts a **fresh
   1:1** (new messages only). Because a reinstall presents a *new* cryptographic identity, the peer is
   **warned "this contact's security code changed — verify again"** (Signal's safety-number-change pattern)
   rather than silently re-trusted. This is the security spine in flight as **PR #236** and it is **unaffected
   by the pivot** — it fires on the incoming Welcome regardless of how the user reached the resume.

We still **reject** any encrypted-roster blob — it would re-create the `key_backups` recoverable-secret
surface that task #16 removed (#233).

## Why it works (ground truth, cited)

- **Client storage:** one IndexedDB DB `argus-keystore` ([keystore.ts](apps/web/src/lib/keystore.ts)) — `device`
  (MLS identity), `group-state` (the only local record of "I'm in conversation X"), `message-log` (history).
  Uninstall wipes all of it. **The conversation list is therefore correctly empty after reinstall** — that is
  the new product behaviour, not a bug to paper over.
- **Reinstall = new MLS identity, unlock key returns.** Passkey survives (OS authenticator); PRF unlock key is
  deterministic ([prf.ts:26](apps/web/src/lib/prf.ts)); but MLS device keys are random and only *sealed* under
  it, and the sealed blob was wiped → `getOrCreateDevice` ([keystore.ts:214](apps/web/src/lib/keystore.ts))
  mints a brand-new identity. History unrecoverable by design.
- **Server already has the *conversation* graph (reused for `is_direct`, not for the contact list anymore):**
  `conversation_members` ([0007_messaging.sql](apps/api/src/db/migrations/0007_messaging.sql), FORCE RLS). The
  `is_direct` column added in #235 and `GET /devices/me/conversations`
  ([devices.controller.ts:281](apps/api/src/devices/devices.controller.ts)) are **kept** — the friends graph
  needs to distinguish direct from group conversations when a tapped friend resolves to a 1:1.
- **Resume is already-built crypto.** `ConversationManager.prepare(peerUserId)` → `confirm()`
  ([conversations.ts:152,189](apps/web/src/lib/conversations.ts)) creates a fresh 1:1 group, with a built-in
  safety-number gate before `confirm()`. The reinstalled device has a fresh identity + KeyPackage pool — all it
  needs.
- **Safety numbers exist + the spine is being built:** `safetyNumber()`
  ([packages/crypto/src/index.ts:203](packages/crypto/src/index.ts)), the `VerifySecurity` OOB panel
  ([VerifySecurity.tsx](apps/web/src/features/chat/VerifySecurity.tsx)), and
  [fingerprint-verification.md](docs/threat-models/fingerprint-verification.md). PR #236 moves verified-state
  from ephemeral `useState` to a sealed per-`peerUserId` record and wires the live "security code changed"
  signal.
- **argus-id discovery already exists, hardened.** `UserService.lookupByArgusId`
  ([user.service.ts](apps/api/src/users/user.service.ts)) + `users.controller.ts` do exact-match-only lookup,
  uniform 404 (no oracle), bearer-auth, a 10/min rate limit, and argus-id log-injection sanitization. The
  friends backend **reuses this verbatim** — see *argus-id discovery hardening*. Threat-modeled in
  [discovery-by-argus-id.md](docs/threat-models/discovery-by-argus-id.md).

## The friends data model (the core new design)

**One table, `friendships`, holding only the mutual/accepted state. Pending requests are bounded; declines and
cancels delete.** Built via `/db-migration`.

```
friendships
  id             uuid primary key default gen_random_uuid()
  tenant_id      uuid not null
  user_low_id    uuid not null      -- canonical ordering: least(a, b)
  user_high_id   uuid not null      -- greatest(a, b) → ONE row per pair; both directions collapse
  status         text not null      -- 'pending' | 'accepted'  (NO 'declined'/'cancelled' — those DELETE)
  requested_by   uuid               -- who opened a pending request; NULLED on accept (intent is transient)
  expires_at     timestamptz        -- pending TTL; NULL once accepted
  created_at     timestamptz not null default now()
  resolved_at    timestamptz        -- set on accept

  unique (tenant_id, user_low_id, user_high_id)                 -- one canonical friendship per pair
  foreign key (tenant_id, user_low_id)  references users(tenant_id, id) on delete cascade
  foreign key (tenant_id, user_high_id) references users(tenant_id, id) on delete cascade
  index (tenant_id, user_low_id)
  index (tenant_id, user_high_id)
  -- RLS: ENABLE + FORCE; tenant policy USING (tenant_id = current_setting('app.tenant_id')::uuid)
  -- PLUS the app-layer predicate below (RLS scopes to tenant, NOT to the pair).
```

The non-obvious calls:

- **Canonical `(user_low_id, user_high_id)` ordering** (sort the two userIds, lowest first) gives the
  "one friendship per pair, both directions collapse" integrity rule **for free** via a single unique index —
  no application dedup, no bidirectional-duplicate bug. (We don't do this for `conversation_members` because
  membership is N-party; a friendship is strictly a pair, so we exploit the symmetry.)
- **Store accepted only; pending is transient.** `status` is just `pending`/`accepted`. **Decline and cancel
  are hard `DELETE`s**, not status transitions — the server keeps **no** record that A asked B and B said no.
  A `pending` row carries `expires_at`; a background sweep `DELETE`s `status='pending' AND expires_at < now()`
  (reuse the TTL-sweep pattern from the auth-session cleanup migration). `requested_by` carries the direction
  while pending (so the UI can show incoming vs outgoing) and is **nulled on accept** — once two people are
  friends, "who asked first" is intent the server no longer needs.
- **Do NOT hash/blind the stored userIds.** They are FKs to `users` and must drive the `GET /friends` join that
  returns `displayName`/`avatarSeed`. Hashing breaks the join and the composite-FK pinning and buys nothing — a
  compromise that can read `friendships` can read `users` too. The real lookup-privacy control is
  exact-match-only argus-id discovery (below), not hashing the rows.
- **App-layer authz predicate (the real isolation).** In the single-tenant `DEFAULT_TENANT_ID` design, tenant
  RLS gives almost no isolation *between users*. So every read/mutation must additionally enforce **the caller
  is `user_low_id` or `user_high_id`** (and accept/decline is **recipient-only**, cancel is **requester-only**).
  This is the same lesson as `conversation_members` ("intra-tenant membership authz is the app layer's job",
  [0007_messaging.sql](apps/api/src/db/migrations/0007_messaging.sql)). **`security-boundary-auditor` must
  assert this — it is the IDOR gate.**

**Deferred hardening (record, don't build):** the strongest design delivers a request as a realtime/push event
and persists **nothing** until accept (no `pending` row at all). That needs offline-delivery semantics
(recipient offline when the request is sent) — more than the beta needs. The TTL'd-`pending` model above is the
shipped compromise; the deliver-only model is the future hardening (see R-friends-2).

## MVP API contract (friends backend)

All routes bearer-auth, OpenAPI-annotated, Zod-validated via **additive** `@argus/contracts` schemas (no change
to existing exported schemas → zero migration pain for current clients). Reuse `UserService.lookupByArgusId` —
**do not fork the lookup**.

- `POST /friends/requests` `{ argusId }`
  - Exact-match argus-id lookup only (existing discovery model).
  - **Uniform `202 Accepted`, opaque body, for *every* well-formed argus-id** regardless of outcome
    (not-found / inactive / self / already-friends / already-pending). The recipient's inbox is the only place a
    real request surfaces. This collapses the create path's enumeration oracle into the same non-oracle the
    lookup already is.
  - Integrity: reject self (silently, uniform response); one canonical pair row (unique index); a re-request
    where one already exists is a no-op.
- `GET /friends`
  - Accepted friends for the caller: `userId`, `argusId`, `displayName`, `avatarSeed`, `since`.
  - **This is the contact-list recovery source.**
- `GET /friends/requests?box=incoming|outgoing`
  - Open `pending` rows for the requested mailbox only (direction from `requested_by`).
- `POST /friends/requests/:id/accept` — **recipient-only**; flips `pending`→`accepted`, sets `resolved_at`,
  nulls `requested_by` + `expires_at`.
- `POST /friends/requests/:id/decline` — **recipient-only**; **hard DELETE**.
- `DELETE /friends/requests/:id` (cancel) / `DELETE /friends/:userId` (unfriend) — **requester/member-only**;
  **hard DELETE**.

## argus-id discovery hardening (mostly already built)

Reuse the existing controls verbatim (verified present): exact-match only (no `LIKE`/prefix/fuzzy), uniform 404
(missing == inactive == bad-format, no oracle), bearer-auth, `@Throttle(perMinute(SENSITIVE_LIMITS.lookupUser))`
= 10/min, and the argus-id **log-injection sanitization** (regex-validate before logging verbatim, else
`<invalid-format>`) — copy that pattern for any argus-id the friends module audits.

**The one genuinely new control:** `POST /friends/requests` is a *state-changing* argus-id probe → a second
enumeration oracle if careless. Two must-haves:
1. **Uniform create response** (the `202` above) so success/failure are indistinguishable.
2. **Its own, tighter rate limit:** add `SENSITIVE_LIMITS.sendFriendRequest` ≈ **10/hour** (`perHour()` exists),
   distinct from `lookupUser` so a normal friend-add burst doesn't exhaust the read budget and vice versa.
   Accept/decline/list reuse `perMinute` caps in the 20–30 range like the enrollment endpoints.

## Mechanism decisions (the non-obvious calls)

- **Resume = fresh group, NOT re-add to the old group.** The user's old device is gone, so the client can't
  re-add itself to the old MLS group (no current member to issue the Commit). Multi-device enrollment requires a
  *surviving* device → does not apply to reinstall. Resume reuses the normal "start a 1:1" path: new MLS group,
  **new conversationId**.
- **Tap a friend → find-or-create the 1:1.** Tapping an accepted friend routes through the existing
  `findConversationWith(peerUserId)` ([ChatScreen.tsx:284](apps/web/src/features/chat/ChatScreen.tsx)) → if no
  live 1:1, `ConversationManager.prepare()` → `VerifySecurity` gate → `confirm()`. **Same crypto path the
  original PR4 specified**, now sourced from the friends list instead of a placeholder. The dead-thread residual
  (peer keeps a stale 1:1 until they also resume) is bounded, 1:1 only, accepted.
- **Identity-change handling (the crux — PR #236, unchanged).** Persist verified safety numbers keyed by
  **peer `userId`**, covering **every currently-present peer device** (primary + secondaries) as a **set** of
  per-device numbers, **not** a single number (a single number would let a *replaced secondary* slip through).
  Store it **sealed under the PRF session key in `argus-keystore`** — never plain `localStorage`, **never sent
  to the server**. On the peer's side, when a resumed conversation's set of present peer-device numbers differs
  from the stored set → don't auto-trust; gate it and surface "{contact}'s security code changed (they may have
  reinstalled) — verify before sending." Computed entirely client-side from public keys.

## The trade-off, in one paragraph (for the owner)

Reinstalling still loses your message history and empties your conversation list — that is the deliberate
guarantee. What comes back is your **Friends list**: the people you've accepted, plus any open requests. To make
that survive a reinstall the server has to remember **one new thing** — that two people are friends — which is
the same *kind* of fact it already keeps to route your messages (who shares a conversation), just allowed to
exist before you've started chatting. Crucially, the server does **not** keep a record of requests you *declined*
or *cancelled* — a decline simply deletes the request, so there is never a "who turned down whom" history. And
because a reinstall makes a brand-new cryptographic "you," the person you re-message sees a one-time "this
contact's security code changed — verify again" prompt (exactly like Signal) — the safety check that stops an
imposter from pretending to be you.

## Scope

**In:** a server-backed Friends list (accepted friendships, durable across reinstall); friend requests
(send by argus-id, incoming/outgoing inbox, accept/decline/cancel) with declines/cancels deleting; the
conversation list left **empty** after reinstall (revert the #235 placeholders, keep the `is_direct` plumbing);
tap a friend → fresh 1:1 (new messages only); peer warned on identity change and re-verifies (PR #236).

**Out / deferred:** restoring message history (impossible by design); re-adding the new device to the *old* MLS
group; deliver-only friend requests with zero pending-row persistence (future hardening, R-friends-2);
cryptographic "proof it's the same human" beyond OOB safety-number re-verify (deferred sealed identity
transfer, multi-device-enrollment.md §5.4); group (N-party) safety numbers; any encrypted-roster blob /
server-stored recoverable secret (rejected — contradicts #16); the original PR5 `GET /conversations`
convenience endpoint (**moot** — the friends list, not conversation-member reads, is now the contact source).

## Invariants — all hold (one new gate)

- **#1 crypto-blind** — `friendships` is metadata only (no keys, no content); the friend-request → conversation
  start still funnels through `ConversationManager.prepare()` → `VerifySecurity` → `confirm()`, so the server
  gains no content path. The `userId`-attribution caveat is unchanged from the existing threat-model note.
- **#2 no secret/content logging** — friend-request audits log `requesterUserId`, `recipientUserId`, request id,
  status transition, and a **format-validated** argus-id only (copy `users.controller.ts` sanitization). No
  `displayName` in audit.
- **#3 RLS — THE GATE.** `friendships` is a **new tenant-scoped table** → mandatory `tenant_id` + `ENABLE` +
  **`FORCE`** RLS + composite FKs pinning `(tenant_id, user_*_id)` to `users(tenant_id, id)` + leading-`tenant_id`
  indexes + the **caller-is-a-member app-layer predicate** (tenant RLS alone is not enough in the single-tenant
  design). "A new table without RLS is a block." Routed through `/db-migration` + `security-boundary-auditor`.
- **#4 no hand-rolled crypto** — friends backend is pure metadata CRUD (zero crypto); PR #236's safety-number
  variant reuses `@argus/crypto`.
- **#5 Key Vault untouched** — no new secret.
- **#6 no admin path to content** — `friendships` is metadata, so it stays consistent with #6, **but** admin/ops
  surfaces **must not query `friendships`** (it widens the admin-visible social graph to pre-conversation
  friendships). Record explicitly; if a future ops need arises, threat-model it separately (R-friends-6).

## Residual risks (add to `docs/threat-models/contact-list-recovery.md`; cross-link metadata-exposure.md)

- **R-friends-1 (pre-conversation social graph):** `friendships` lets a DB-compromise/subpoena see "A and B are
  friends" with zero messages. Mitigated by storing **accepted-only** (no rejection/intent ledger) + bounding
  pending to open-request lifetime. Same *class* as `conversation_members`; accepted + documented.
- **R-friends-2 (open-request intent):** while `pending`, the server sees "A wants to reach B" and the direction.
  Bounded by TTL expiry + decline-as-DELETE; `requested_by` nulled on accept. Residual: the open window. Closing
  it fully needs the deferred deliver-only model.
- **R-friends-3 (request-create enumeration oracle):** `POST /friends/requests` is a state-changing argus-id
  probe. Mitigated by the uniform `202` + the dedicated `sendFriendRequest` per-hour limit. Residual: an attacker
  can still confirm existence by *completing* a friendship if the target accepts — but that needs target consent,
  so it's not a silent oracle.
- **R-friends-4 (friendship injection — the friends-list analogue of T-resume-4):** a malicious server inserts a
  `friendships` row, making a stranger appear as an accepted friend. **Mitigated by the safety-number gate being
  the only path to a conversation** — an injected friend is inert until the user taps and completes the OOB
  `VerifySecurity` check. Same mitigation/residual as the existing T-resume-4.
- **R-friends-5 (IDOR on request actions):** accept/decline/cancel take a request `:id`; without the
  recipient-only/requester-only predicate, A could accept a request not addressed to them. Mitigated by the
  app-layer authz predicate (#3) — `security-boundary-auditor` must assert it.
- **R-friends-6 (admin social-graph widening):** admin/ops must not query `friendships`; threat-model separately
  if ever needed. Keeps #6's metadata-only admin surface from quietly absorbing the pre-conversation graph.
group; cryptographic "proof it's the same human" beyond OOB safety-number re-verify (deferred "sealed identity
transfer", multi-device-enrollment.md §5.4); group (N-party) safety numbers; any encrypted-roster blob /
server-stored recoverable secret (rejected — contradicts #16).

## Friend requests backend — planned contact source

The current UI can mock "send friend request" locally, but the backend source of truth is not implemented yet.
When this lands, accepted contacts should become the long-term contact-list source; existing 1:1 direct
conversations remain the compatibility fallback until enough clients have migrated.

### Data model

Add a tenant-scoped `contact_requests` table via `/db-migration`:

- `id uuid primary key default gen_random_uuid()`
- `tenant_id uuid not null`
- `requester_user_id uuid not null`
- `recipient_user_id uuid not null`
- `status text not null` with values `pending`, `accepted`, `declined`, `cancelled`
- `created_at timestamptz not null default now()`
- `resolved_at timestamptz`

RLS requirements:

- `tenant_id` is mandatory and FORCE RLS is mandatory.
- A caller may read rows where they are requester or recipient.
- A caller may create only rows where `requester_user_id` is their verified user id.
- Only the recipient may accept or decline a pending request.
- Composite foreign keys must pin `(tenant_id, requester_user_id)` and `(tenant_id, recipient_user_id)` to
  `users(tenant_id, id)` so cross-tenant links fail at the DB boundary.

Integrity requirements:

- Reject self-requests.
- Reject duplicate pending requests in either direction.
- Reject duplicate accepted friendships in either direction.
- Keep one canonical accepted friendship per pair. The implementation may either reuse the accepted request row
  or add a separate `contacts` table, but the API contract below must not expose duplicate friends.

### MVP API contract

- `POST /contacts/requests` with `{ "argusId": string }`
  - Exact-match lookup only, using the existing argus-id discovery model.
  - Returns the created outgoing pending request.
  - Uniform user-facing failure for not found, inactive, self, duplicate pending, and already accepted where
    practical; do not create a new enumeration oracle.
- `GET /contacts`
  - Returns accepted friends for the caller: `userId`, `argusId`, `displayName`, `avatarSeed`, `acceptedAt`.
  - This becomes the preferred contact-list recovery source.
- `GET /contacts/requests?box=incoming|outgoing`
  - Returns pending requests for the requested mailbox only.
- `POST /contacts/requests/:id/accept`
  - Recipient-only. Transitions pending to accepted and sets `resolved_at`.
- `POST /contacts/requests/:id/decline`
  - Recipient-only. Transitions pending to declined and sets `resolved_at`.

### Security rules

- No fuzzy search, prefix search, browsable directory, or global member list.
- No message plaintext, ciphertext, keys, tokens, emails, full Authorization headers, or presigned URLs in
  request/response/audit metadata.
- Audit only metadata-safe events: requester id, recipient id, request id, status transition, and
  well-formed target argus-id when needed. Never log free-form raw search text if it fails argus-id format.
- Rate-limit request creation and argus-id lookup reuse to prevent scanning and spam.
- Do not auto-create a conversation on accept. Starting chat still goes through the existing safety-number-gated
  `ConversationManager.prepare()` -> `VerifySecurity` -> `confirm()` flow.

## Invariants — all hold

#1 crypto-blind (reuses opaque commit/welcome/ciphertext; identity-change signal is client-side, metadata-only,
never sent; friend requests carry contact metadata only) · #2 no secret/content logging (trust state
client-local, never logged; request audits stay metadata-only) · #3 RLS (existing roster reads are
member/owner-scoped; the future `contact_requests` table must be tenant-scoped + FORCE RLS) · #4 no
hand-rolled crypto (reuses `@argus/crypto` `safetyNumber` + `ConversationManager`) · #5 Key Vault untouched ·
#6 no admin path.

---

## PR sequence (revised)

Each slice independently shippable. Per-PR process for **every** PR: `/code-review` (medium) over the branch
diff → fix findings → commit → push → `gh pr create` → request **both** reviews (`@codex review` +
`@claude … VERDICT:`) → gate with `.claude/hooks/review-status.sh <pr> --wait`.

**Dependency order:** A (done) → B and C (parallel) → D (needs C) → E (needs D) → F (needs E + A).

### Slice A — verified-state spine + identity-change signal (task #22) — **IN FLIGHT as PR #236** — crypto

**Keep exactly as-is and finish.** PR #236 touches only client + crypto (`ChatScreen.tsx`, `VerifySecurity.tsx`,
`useConversationBackfill.ts`, `useLiveConversations.ts`, `join.ts`, `keystore.ts`,
`packages/crypto/src/index.ts`, specs) and changes **zero server files and zero migrations** — the pivot is a
server/data-model change, so it does not collide. PR #236's value survives the pivot completely: resume still
mints a fresh MLS group, so the peer still receives a Welcome from a new identity and still needs the reset —
whether the user reached resume via a placeholder (old) or a friend tap (new) is irrelevant; it fires on the
incoming Welcome. **Before merge, grep the branch for `recoveredFromServer` / `buildRosterPlaceholders`** to be
sure no assertion depends on roster placeholders (it operates on live conversations, so it shouldn't).
- Gates: **`crypto-reviewer` REQUIRED** + `security-boundary-auditor` (confirm nothing leaves the client). Unit
  tests (key-change resets verified; same-key keeps it); E2E (simulated peer identity change → warning, send
  gated).

### Slice B — revert the conversation-list placeholders; keep `is_direct` + reads — **no crypto**

Smallest, lowest risk; unblocks the friends list from competing with placeholders as a contact source.
- **Remove** `useRosterRecovery`, `buildRosterPlaceholders`, `filterNewPlaceholders`
  ([useConversationBackfill.ts](apps/web/src/features/chat/useConversationBackfill.ts)) and their call sites in
  `ChatScreen`/`useChatState`; remove the `recoveredFromServer` field on `Conversation` and its read-only
  rendering.
- **Keep** `0041_conversations_is_direct.sql`, the creation-time write, and `GET /devices/me/conversations`
  returning `isDirect` — the friends list needs `is_direct`, and that endpoint also has the **enrollment fan-out
  consumer** (`SENSITIVE_LIMITS.enrollmentConversationList`) plus a `conversationIds` backward-compat shim for
  stale PWA bundles. **Revert only the placeholder client code, not the endpoint or its shim.**
- Update Playwright E2E: the #235 test asserts "roster appears, history empty, composer disabled" — **invert it**
  to assert the conversation list is **empty** after a fresh-keystore + valid-session reinstall. Grep
  `apps/web/e2e/` for the placeholder labels before pushing.
- Gates: `/code-review` (medium). **No `crypto-reviewer`, no `security-boundary-auditor`** (removing a read-only
  client feature, no server/authz change — state in the PR body); typecheck + unit + E2E.

### Slice C — `friendships` table + RLS — **DB-only, no API yet** — *the invariant gate*

Isolate the schema change so the RLS review is clean and focused.
- `/db-migration`: `friendships` per *The friends data model* (canonical `user_low/high_id`, `status`, nullable
  `requested_by`, `expires_at`, `resolved_at`), `tenant_id` + FORCE RLS + composite FKs + leading-`tenant_id`
  indexes + unique `(tenant_id, user_low_id, user_high_id)`.
- Drizzle schema entry in `apps/api/src/db/schema.ts`.
- Pending-expiry sweep: scheduled `DELETE WHERE status='pending' AND expires_at < now()` (reuse the auth-session
  TTL-sweep pattern).
- Gates: **`security-boundary-auditor` REQUIRED** (the new-table-needs-RLS block — must confirm FORCE RLS **and**
  the caller-is-a-member app predicate, not just tenant RLS); `/db-migration`; **threat-model note updated with
  the R-friends risks before this lands**.

### Slice D — friends API + `@argus/contracts` — **server, no crypto**

- Endpoints per *MVP API contract* — reuse `UserService.lookupByArgusId`, **do not fork it**; uniform `202` on
  create; add `SENSITIVE_LIMITS.sendFriendRequest` (≈10/hr); recipient-only accept/decline, requester-only
  cancel (no IDOR); copy the argus-id audit-sanitization pattern.
- `@argus/contracts`: **additive** Zod schemas mirroring the existing `UserLookupResultSchema` /
  `ConversationMemberSchema` pattern — no change to existing schemas.
- OpenAPI annotations on every route, regenerate `apps/api/openapi.json`, **42Crunch audit target 90+ (fix all
  incl. LOW)**.
- Gates: **`security-boundary-auditor` REQUIRED** (authz on every path — no IDOR on `:id`; recipient/requester
  predicates; uniform create response; audit sanitization); `/api-spec`. **No `crypto-reviewer`** (state in the
  PR body — pure metadata CRUD).

### Slice E — wire the friends-list UI to the backend — **client, no crypto**

The friends panel UI already exists as a mock ([ConversationList.tsx](apps/web/src/features/chat/ConversationList.tsx)):
`acceptedFriendsFromConversations` (derives from conversations), `pendingFriendRequests` (`useState`),
`handleMockFriendRequest`. Replace the mock with real data:
- `acceptedFriendsFromConversations` → `GET /friends`; `pendingFriendRequests` → `GET /friends/requests`;
  `handleMockFriendRequest` → `POST /friends/requests`; add accept/decline/cancel actions.
- Tapping an accepted friend → existing `findConversationWith(peerUserId)` find-or-create-1:1 path (still routes
  through the safety-number gate). **No change to resume crypto** — same entry point the original PR4 wired.
- API client wrappers in `apps/web/src/lib/api.ts` (follow the existing `lookupByArgusId` /
  `getConversationMembers` wrappers).
- Gates: `/code-review`; Playwright E2E (send request → recipient sees incoming → accept → both see the friend →
  tap → conversation starts under the safety-number gate). **No `crypto-reviewer`.**

### Slice F — tap-a-friend → resume, formalized (task #23) — crypto

Mostly subsumed by Slice E's tap wiring; keep a dedicated slice for the **resume-specific mechanics** the
original PR4 spec called out: after `confirm()` succeeds, the **replace-in-place** state mutation (remove any
dead placeholder/sibling row + insert the new live conversation in one update; a failed/cancelled `confirm()`
leaves state intact), and the dead-thread-non-sendable polish (T-resume-3). If Slice E's plain "tap → start 1:1"
already covers a reinstalled peer (it does — `ConversationManager.prepare` handles it), this slice shrinks to
that polish.
- Gates: **`crypto-reviewer` REQUIRED** (drives MLS group creation + Welcome) + `security-boundary-auditor`.
  E2E: reinstall → tap friend → verify safety number → send → peer receives under the new group; one
  conversation per contact.

## DB / schema

**One new table (Slice C): `friendships`** — tenant-scoped, FORCE RLS, canonical-pair unique index, composite
FKs to `users`, app-layer caller-is-a-member predicate, pending TTL sweep. **One column kept from #235:**
`conversations.is_direct` (the friends graph reuses it to resolve a tapped friend to a 1:1). Everything else
needs **no** schema change: verified-state is client-local and never sent; the resume path reuses
`ConversationManager` unchanged.

## How to start (new session)

1. **Finish Slice A (PR #236)** on its current scope — keep as-is; grep the branch for `recoveredFromServer` /
   `buildRosterPlaceholders` before merge.
2. **Slice B** (revert placeholders) and **Slice C** (`friendships` table + RLS) can proceed in parallel; C
   needs the threat-model note updated with the R-friends risks **before** it lands.
3. Then **D** (API + contracts) → **E** (UI wiring) → **F** (resume polish). Branch each off `main`; one PR per
   slice; both reviews + the matching domain reviewer per the gates above.
