# Threat model — Group membership (B1 MLS group chat)

**Feature:** Multi-party MLS groups (3–32 members) with commit fan-out.
**Invariants in scope:** #1 (crypto-blind server), #2 (no plaintext logged), #3 (tenant RLS).
**Date:** 2026-06-12

---

## Trust model

The server is crypto-blind: it stores and forwards opaque `mls_private_message` frames (commits and application messages) without decrypting them. The server learns membership changes only via the declared metadata (`addedUserIds`, `removedUserIds`) the client provides in the commit POST body. This metadata is asserted, not cryptographically verified.

All group members are mutual peers: once admitted, any member can read any message sent at or after their join epoch. The adder is trusted transitively — existing members trust the new member because the adder vouched for them (identical to Signal's group model). Admins/roles are NOT enforced in v1.

---

## Threats

### T1 — Epoch-slot wedging (insider DoS)

**Attack:** A malicious member wins the server epoch lock by POSTing a syntactically valid but semantically broken commit (e.g. a commit that processes to an error on every peer). The slot at epoch N is now permanently occupied. Other members attempt to commit at epoch N, get 409, and rebase — but rebased commits win slot N+1, which can also be wedged. The group cannot make forward progress.

**Impact:** Permanent group unavailability. The attacker must remain a member (since the endpoint requires `requireMembership`).

**Mitigation:** Accepted for v1. A member who wins the slot but sends a broken commit is detectable in the audit log (sender_user_id, timestamp). Recovery: a new group must be created; members need to migrate manually.

**Deferred mitigation path:** MLS re-init (RFC 9420 §11.2) allows the group to fork into a fresh epoch from a quorum of remaining members without re-creating the conversation.

---

### T2 — Declared-delta lies (metadata/MLS divergence)

**Attack:** A malicious member POSTs a commit that cryptographically removes user B but declares `removedUserIds: []` in the POST body, or vice versa. The server updates `conversation_members` based on the declared delta, which diverges from what the MLS commit actually does.

**Impact:** Metadata divergence (conversation_members is wrong), but NOT a security compromise: the server's `conversation_members` table is only used for transport authorization (can this device fetch from this conversation?). The actual access decision is made by MLS on the client — a user whose leaf was removed by the commit can no longer decrypt subsequent messages regardless of what `conversation_members` says. Conversely, a user whose leaf was NOT removed but was deleted from `conversation_members` will get 404 when trying to fetch messages, which is a service disruption only.

**Mitigation:** Accepted as insider-scope. The server cannot verify the opaque commit content. Document: members who observe an anomaly (fetch 404 despite valid MLS state) can report it; the operator can inspect audit logs and correct `conversation_members` manually.

---

### T3 — Wrong-endpoint frames

**Attack:** An application message is POSTed to `POST /conversations/:id/commits`; a commit frame is POSTed to `POST /conversations/:id/messages`.

**Impact:**
- Commit posted as app message: `Conversation.decrypt()` calls `processMessage` and gets `kind:'newState'`; the existing guard throws `"expected applicationMessage, got newState"`. The message is rendered as undecryptable. No state corruption (state not advanced).
- App message posted as commit: `Conversation.processCommit()` calls `processMessage` and gets `kind:'applicationMessage'`; the guard throws `"expected commit (newState), got applicationMessage"`. The commit slot at that epoch is now occupied by garbage. No state corruption, but epoch-slot wedged (T1 scenario for this epoch).

**Mitigation:** Client enforces the correct endpoint by construction. Wrong-endpoint frame from a malicious peer is insider noise. Detection: audit log shows the sender.

---

### T4 — History visibility after add / remove

**Add:** New members joining at epoch N cannot decrypt messages from epochs < N (MLS forward secrecy; the Welcome does not include epoch < N key material).

**Remove:** A removed member retains all ciphertext they received at epochs ≤ removal epoch. They cannot decrypt messages from epochs > removal epoch (their ratchet key is not advanced by the remove commit, and they lose `requireMembership` transport access simultaneously — the server deletes their `conversation_members` row in the same transaction as the epoch-slot insert).

**Mitigation:** Inherent in MLS; consistent with the 1:1 model. No new threat.

---

### T5 — Missed-commit recovery failure (offline device)

**Scenario:** A device is offline at epoch 5; the group advances to epoch 9. On reconnect, the device drains commits 5–8 sequentially via `GET /conversations/:id/commits?afterEpoch=5`. If any single commit fails to process (e.g. the commit slot was occupied by a broken frame per T1), `processCommit()` throws, and the device cannot advance past that epoch.

**Impact:** The device enters a terminal desynced state ("Sync lost"). It can still read messages at epoch ≤ 5.

**Mitigation (v1):** The UI renders a "Sync lost — ask a member to re-invite you" banner. Recovery requires a member to remove the stale leaf and re-add the device. Auto-rejoin is deferred.

---

## Security properties preserved

1. **Crypto-blind server:** Commit and application message frames are opaque `mls_private_message` bytes. The server routes by endpoint (commit vs message), never by content inspection.
2. **Transport access removed atomically:** `conversation_members` deletion and epoch-slot insert are in the same DB transaction, so a removed user's transport access ends at the same commit that removes their MLS leaf.
3. **OOB fingerprint gate preserved:** Group add reuses the two-phase `prepare/confirm` flow. Safety number must be verified for each new member before staging a commit.
4. **Pending-commit protects forward secrecy:** The current `ClientState` is not advanced until the server confirms the epoch slot (200 OK). A crash between staging and promotion is recoverable without nonce/key reuse.
5. **RLS + composite tenant FKs:** `conversation_commits` carries `tenant_id` with a composite FK to `conversations(tenant_id, id)`, the same pattern as all other tenant-scoped tables.
