# Threat Model: Friendship-Gated Messaging

**Date**: 2026-06-23  
**Feature**: Block establishing or messaging a DM when the two parties are not (or no longer) mutual friends.  
**Status**: Implemented (PR #345). Gate sits at the DM peer-ADD sites + message send — see §1.

---

## 1. Feature & Data Flow

**What it does.** Without the gate, `createConversation`, `deliverWelcome`, `postCommit`, and `sendMessage` enforce only *tenant membership* and *conversation membership*. After unfriending, both ex-friends still hold their `conversation_members` row, so the API would accept their sends and re-adds.

**The gate sits where the peer actually enters the DM, not at conversation creation.** The real client creates a DM as a SOLO conversation (it passes its *own* id) and adds the peer in a later call, so a friendship check at `createConversation` would only ever see the creator's own id (a self-pair). The guard therefore fires at the peer-ADD sites and on send:

```
1. POST /conversations            { memberUserIds: [SELF], isDirect: true }
     requireUser → INSERT solo conversation (creator only)        — solo create (memberUserIds=[SELF]) is ungated;
                                                                    a direct create that names a real peer IS gated

2. Peer is added to the DM — friendship is checked HERE, against the EXPLICIT added id:
   single-device:  POST /conversations/:id/welcomes  { recipientUserId: peer, ... }
       requireUser → requireMembership → requireDirectFriendshipForAdd(sender, peer) → INSERT member + welcome
   multi-device:   POST /conversations/:id/commits   { addedUserIds: [peer], ... }
       requireUser → requireMembership → requireDirectFriendshipForAdd(sender, eachAdded) → INSERT commit + members

3. POST /conversations/:id/messages
     requireUser → requireMembership → requireDirectFriendship(sender) → INSERT message (ciphertext only)
       — derives the single peer from conversation_members; PRIMARY gate for unfriending an EXISTING DM (no add happens then)
```

Guards in `messaging/membership.ts` (one base check, two wrappers):
- `requireFriendship(tx, a, b)` — throws 403 unless an `accepted` row exists for the canonical pair. RLS-tenant-scoped (no explicit `tenant_id` predicate); must run inside `withTenant`.
- `requireDirectFriendshipForAdd(tx, conv, caller, addedIds)` — used at the add sites. Gates the DM peer that will exist AFTER the operation, computed from the union of current members and the added ids — so it covers the bootstrap add (peer not a member yet) AND an established DM whose commit adds nobody (the existing peer is re-checked, so an unfriended peer can't keep committing). No-op for groups/legacy. **Fails closed (500)** if the resulting member set would exceed two (an invariant breach, never a 403 oracle); otherwise requires friendship with each non-caller member.
- `requireDirectFriendship(tx, conv, caller)` — **peer-derived** from `conversation_members`, used at send; fails closed (500) on a DM that doesn't have exactly one peer.
- `createConversation` also calls `requireFriendship` directly when a direct create names a real (non-self) peer in the body — closing the path where a modified client inserts the peer as a member at creation rather than via an add site.

**Sensitive data on this path.** None new: the checks read `friendships.status` and `conversation_members.user_id` (metadata) plus the request-body added id. No plaintext, no keys. The server stays crypto-blind — it decides only *whether* to store the ciphertext/welcome blob, never *what* is in it.

**Scope.** Group conversations (`isDirect=false`) are **not** gated at any site — you can be in a group with non-friends. Friendship is a 1:1 social-graph concept; groups are access-controlled by the group creator.

The gate keys off the **client-declared** `isDirect` flag (the server deliberately does not infer it from membership — see `messaging.schemas.ts`, "groups start as solo rows"). A hostile client can therefore set `isDirect:false` with a single peer to create a 2-person *group* that is never friendship-gated — an ungated 1:1 channel by mislabelling. Accepted limitation (see §6, "isDirect is client-declared").

---

## 2. Assets & Trust Boundaries

| Asset | Where it lives | Who may access |
|---|---|---|
| Friendship status (`friendships.status`) | DB, RLS-scoped to tenant | Tenant users (own rows only via RLS) |
| Conversation membership (`conversation_members`) | DB, RLS-scoped | Conversation members |
| Message ciphertext | DB, RLS-scoped | Conversation members |

**Boundaries crossed by this feature:**

- **Client → API**: caller asserts "I want to send a message / create a DM". Server now validates social-graph precondition before writing.
- **API → DB**: a small number of extra indexed SELECTs per guarded call — at send, one for `isDirect` + peer and one for `friendships`; at an add, one for `isDirect`, one bounded member-count, and one for `friendships`. All run inside the existing `withTenant` transaction (RLS already active). Overhead is a few index lookups per call.

---

## 3. Threats (STRIDE-lite)

### Spoofing
- **Threat**: Attacker forges a `userId` to pass the friendship check as someone else's accepted friend.
- **Mitigation**: `requireUser()` resolves the caller from the *verified JWT sub*, never from a client-supplied id. The peer id comes from `conversation_members` (DB), not from the request body.

### Tampering
- **Threat**: Attacker races an unfriend and a message-send to slip a message through after the friendship row is deleted.
- **Mitigation**: The friendship check runs *inside the same `withTenant` transaction* as the `INSERT messages`. If the friendship row disappears before the check, the transaction sees that and throws 403. Postgres serializable isolation is not required; the check-then-insert is within a single snapshot and the DELETE in `unfriend()` is a hard delete, so there is no soft-delete window.
- **Residual**: Under `READ COMMITTED` (Postgres default), a concurrent `unfriend()` commit between the check SELECT and the INSERT is technically possible. The window is microseconds; the attacker must already hold an active session. Acceptable — the invariant we care about (no messages after unfriend under normal use) holds.

### Information Disclosure
- **Threat**: Attacker discovers a conversation id for an unrelated pair, then probes whether they are friends by observing the error code.
- **Mitigation**: The existing `requireMembership()` returns 404 for non-members (no conversation oracle). The friendship gate is reached *only after* membership is confirmed, so a 403 reveals: (a) the conversation exists, and (b) the caller is a member. The caller already knows both. No new enumeration surface.
- **Threat**: Error message reveals the peer's user id.
- **Mitigation**: The 403 body contains only the string `"friendship required"`. No user ids, no conversation structure.

### Repudiation
- **Scope**: The server cannot cryptographically bind a message to its author — doing so would require inspecting or signing content, violating the crypto-blind invariant. Repudiation of message authorship is a client-layer concern handled by MLS sender keys (each message is signed by the sender's MLS leaf key, verifiable by conversation members). This server-side guard decides only *whether* to store the ciphertext blob; it makes no authorship claim. Out of scope for this feature.

### Elevation of Privilege
- **Threat**: A revoked/soft-deleted user still holding an unexpired token sends a message.
- **Mitigation**: `requireUser()` (already in place) rejects inactive users before the friendship check is reached. No change needed.

### Denial of Service
- **Threat**: The two extra SELECT queries per send degrade throughput.
- **Mitigation**: Both queries hit indexed columns (`friendships` is indexed on canonical pair; `conversation_members` is indexed on `(conversation_id, user_id)`). The overhead is two index lookups per message, which is negligible. No rate-limit change required.

---

## 4. Invariant Check

| Invariant | Status |
|---|---|
| **1. Server crypto-blind** | ✅ Check reads only metadata (`status`, `user_id`). No content inspected. |
| **2. No secret logging** | ✅ The 403 message is a static string. No user ids, tokens, or keys logged. |
| **3. RLS on every tenant table** | ✅ The friendship check runs inside `withTenant()` — the RLS session var is already set. `friendships` has a `tenant_id` RLS policy. |
| **4. No hand-rolled crypto** | ✅ No crypto involved. |
| **5. Secrets via Key Vault** | ✅ No secrets involved. |
| **6. No admin path to content** | ✅ No content surfaces. |

No invariant tension.

---

## 5. Decision & Mitigations

**Decision**: a base guard `requireFriendship(tx, userA, userB)` in `messaging/membership.ts`, wrapped by call-site helpers, gated at the points where the peer crosses into the DM plus on send. The solo-create path the real client uses is ungated at creation (it only names the creator's own id); the gate fires where the actual peer appears:

1. `WelcomeService.deliverWelcome()` — `requireDirectFriendshipForAdd(sender, [recipientUserId])` after `requireMembership`, before the member insert (single-device DM peer-add).
2. `MessageDeliveryService.postCommit()` — `requireDirectFriendshipForAdd(sender, addedUserIds)` before the commit insert; gates the resulting DM peer (existing ∪ added), so an established DM is re-checked even when the commit adds nobody.
3. `MessageDeliveryService.sendMessage()` — `requireDirectFriendship(sender)` after the idempotent-retry fast path; derives the single peer from membership. Primary gate for unfriending an existing DM.
4. `ConversationService.createConversation()` — `requireFriendship(creator, peer)` only when a direct create names a real non-self peer (`memberUserIds[0] !== creator`); the solo-create case is ungated (gated downstream at the add site). Kept the `isDirect ⇒ exactly-one-member` structural check.

**Must-fix mitigations (all in place):**

- M1: every guard runs in the SAME `withTenant` `Tx` as the write it protects (no separate connection); add-site gates run BEFORE the insert, so a rejected add writes no row.
- M2: 403 body is the static string `"friendship required"` — no user/conversation ids.
- M3: groups (`isDirect=false`) and legacy (`isDirect IS NULL`) are NOT gated at any site.
- M4: controller specs pin the 403 posture for `createConversation` (direct-peer create), `deliverWelcome`, `postCommit`, and `sendMessage`.
- M5: **add-site gates evaluate the live friendship on every call (no idempotent bypass)** — a stale retry re-adding a peer after an unfriend gets 403. Only the *send* path bypasses the gate, and only for an already-durable message retry (returning the stored row's ACK).
- M6: a DM is capped at two members — an add that would grow it past two fails closed (500), never a 403.
- M7: the `postCommit`/`deliverWelcome` gate checks the resulting peer set (current members ∪ added), so an established DM still gates its existing peer when a commit adds nobody — the commit endpoint is not a post-unfriend DM write path.

**Subagent reviews:**

- `security-architect`: gate-placement design (this relocation).
- `security-boundary-auditor`: server boundary change across the four sites.

---

## 6. Residual Risk

- **RC isolation window** (see §3 Tampering): a concurrent unfriend + send in the same millisecond can slip through under `READ COMMITTED`. Acceptable for v1; a `SELECT FOR UPDATE` on the friendship row would close it but adds lock contention on every DM send — not worth it at this stage.
- **Group conversations ungated**: a group member could add a non-friend. This is intentional and not a regression — groups were never friendship-gated.
- **Legacy conversations** (`isDirect IS NULL`): treated as non-DM (no gate). These pre-date migration 0041 and are either group conversations or will be cleaned up in a later migration.
- **`isDirect` is client-declared** (see §1 Scope): the gate's enforcement is bound to a flag the client sets at creation, so a hostile client can mislabel a 2-person DM as a group (`isDirect:false`) and bypass the friendship check entirely. **Accepted for v1** because: (a) groups are intentionally ungated, so a "group of two" is within the documented model; (b) the peer is still added via an MLS welcome the recipient's device must process — there is no silent insertion into a stranger's client; (c) the robust fix is to derive DM-ness from membership *shape* at send time (treat any 2-distinct-member conversation as a DM regardless of the flag), which conflicts with the documented reason the server refuses to infer `isDirect` (groups start as solo rows, so count-at-creation is ambiguous). The shape-based rule, applied at *send* time rather than creation, is the planned hardening if unsolicited 2-person groups become an abuse vector. Until then the anti-harassment value rests on the client surfacing unsolicited conversations distinctly, not on the server gate.
- **Weak 400-vs-403 distinction at `deliverWelcome`**: the friendship gate (403) runs before the member-insert FK check (400 for a non-tenant recipient), so the two responses distinguish "real same-tenant user but not your friend" from "not a user in your tenant" — a weak tenant-existence oracle. Accepted under the single-tenant `DEFAULT_TENANT_ID` model (tenant membership is already discoverable via the argus-id directory). For a future multi-tenant deployment, run a same-`400` existence pre-check before the friendship gate to flatten it.
- **No idempotent bypass at the add sites**: a stale client that retries `deliverWelcome`/`postCommit` to re-add a peer *after* an unfriend gets 403 (the gate re-evaluates the live friendship every call). The peer's pre-existing `conversation_members` row from the original (pre-unfriend) add is **not** removed by this 403 — membership is torn down separately by an MLS-remove commit (`removedUserIds`). So a brief window exists where an ex-friend's member row persists but every send is already blocked by the send-time gate. Acceptable: no message content flows, and the row is reconciled on the next membership commit.
