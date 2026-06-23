# Threat Model: Friendship-Gated Messaging

**Date**: 2026-06-23  
**Feature**: Block DM creation and DM message-send when the two parties are no longer mutual friends.  
**Status**: Pre-implementation — required before any code change.

---

## 1. Feature & Data Flow

**What it does.** Today `createConversation(isDirect=true)` and `sendMessage()` enforce only *tenant membership* and *conversation membership*. After unfriending, both ex-friends still hold their `conversation_members` row, so the API accepts their sends.

The fix adds a server-side friendship guard at two points:

```
POST /conversations  (isDirect=true)
  requireUser  →  requireFriendship(tx, caller, peer)  →  INSERT conversation + members

POST /conversations/:id/messages
  requireUser  →  requireMembership
    → resolveDmPeer(tx, conversationId, sender)   -- looks up isDirect + peer from conversation_members
    → requireFriendship(tx, sender, peer)          -- shared guard: checks friendships table
    → INSERT message (ciphertext only)
```

`requireFriendship(tx, userA, userB)` is the single shared guard in `messaging/membership.ts`. The DM peer-resolution + gate is wrapped in `requireDirectFriendship(tx, conversationId, callerUserId)` (same module), called by `sendMessage()` and `postCommit()`. It no-ops for non-DM conversations and **fails closed** (500) if a DM has anything other than exactly one peer besides the caller — so an `isDirect` row that somehow accumulated extra members can never gate against an arbitrary member and let the write through. (`createConversation()` calls `requireFriendship` directly, since at creation time the peer is the single id in the request body, not yet a DB membership row.)

**Sensitive data on this path.** None new: the check reads `friendships.status` (metadata) and `conversation_members.user_id` (metadata). No plaintext, no keys. The server remains crypto-blind; it only decides *whether* to store the ciphertext, never *what* is in it.

**Scope.** Group conversations (`isDirect=false`) are **not** gated — you can be in a group with users you have not added as friends. Friendship is a 1:1 social graph concept; groups are access-controlled by the group creator.

The gate keys off the **client-declared** `isDirect` flag (the server deliberately does not infer it from membership — see `messaging.schemas.ts`, "groups start as solo rows"). A hostile client can therefore set `isDirect:false` with a single peer to create a 2-person *group* that is never friendship-gated — an ungated 1:1 channel by mislabelling. This is an accepted limitation (see §6, "isDirect is client-declared").

---

## 2. Assets & Trust Boundaries

| Asset | Where it lives | Who may access |
|---|---|---|
| Friendship status (`friendships.status`) | DB, RLS-scoped to tenant | Tenant users (own rows only via RLS) |
| Conversation membership (`conversation_members`) | DB, RLS-scoped | Conversation members |
| Message ciphertext | DB, RLS-scoped | Conversation members |

**Boundaries crossed by this feature:**

- **Client → API**: caller asserts "I want to send a message / create a DM". Server now validates social-graph precondition before writing.
- **API → DB**: two extra SELECT queries per guarded call (one to get `isDirect` + peer, one to check `friendships`). Both run inside the existing `withTenant` transaction (RLS already active).

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

**Decision**: Add `requireFriendship(tx, userA, userB)` as a new guard function in `messaging/membership.ts` (alongside the existing `requireUser` / `requireMembership`). Call it:

1. In `ConversationService.createConversation()` when `isDirect=true`, after `requireUser`, before the INSERT.
2. In `MessageDeliveryService.sendMessage()`, after `requireMembership`, for DM conversations: look up `isDirect` + peer id from `conversation_members`, then call `requireFriendship`.

**Must-fix mitigations before merge:**

- M1: `requireFriendship` runs in the same `Tx` as the guarded write (no separate DB connection).
- M2: 403 body is a static string — no user ids or conversation structure in the error.
- M3: Group conversations (`isDirect=false`) and null-`isDirect` (legacy pre-migration rows) are explicitly NOT gated.
- M4: Controller spec must pin the new 403 path for `POST /conversations` (isDirect+non-friends) and `POST /conversations/:id/messages` (DM+unfriended).

**Subagent reviews triggered:**

- `security-boundary-auditor`: server boundary change (new authz check on two endpoints).

---

## 6. Residual Risk

- **RC isolation window** (see §3 Tampering): a concurrent unfriend + send in the same millisecond can slip through under `READ COMMITTED`. Acceptable for v1; a `SELECT FOR UPDATE` on the friendship row would close it but adds lock contention on every DM send — not worth it at this stage.
- **Group conversations ungated**: a group member could add a non-friend. This is intentional and not a regression — groups were never friendship-gated.
- **Legacy conversations** (`isDirect IS NULL`): treated as non-DM (no gate). These pre-date migration 0041 and are either group conversations or will be cleaned up in a later migration.
- **`isDirect` is client-declared** (see §1 Scope): the gate's enforcement is bound to a flag the client sets at creation, so a hostile client can mislabel a 2-person DM as a group (`isDirect:false`) and bypass the friendship check entirely. **Accepted for v1** because: (a) groups are intentionally ungated, so a "group of two" is within the documented model; (b) the peer is still added via an MLS welcome the recipient's device must process — there is no silent insertion into a stranger's client; (c) the robust fix is to derive DM-ness from membership *shape* at send time (treat any 2-distinct-member conversation as a DM regardless of the flag), which conflicts with the documented reason the server refuses to infer `isDirect` (groups start as solo rows, so count-at-creation is ambiguous). The shape-based rule, applied at *send* time rather than creation, is the planned hardening if unsolicited 2-person groups become an abuse vector. Until then the anti-harassment value rests on the client surfacing unsolicited conversations distinctly, not on the server gate.
