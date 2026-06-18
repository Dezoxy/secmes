# Threat model: contact-list recovery + tap-to-resume

> One page. Written before code. Prerequisite: task #16 (key_backups teardown) landed in PR #233.
> Gates PR 2 (task #21), PR 3 (task #22), PR 4 (task #23) — no feature code starts without
> `security-architect` ratification of this note. Ratified after two passes.

## 1. Feature & data flow

**Two independent halves:**

1. **Roster recovery (PR 2).** After a PWA reinstall wipes `argus-keystore` (IndexedDB), the client
   reads back its own membership from the server: `GET /devices/me/conversations` (ids) + `GET
   /conversations/:id/members` (peers). Both endpoints are RLS-protected and return **metadata only**
   (userId, displayName — no keys, no content). The client renders read-only placeholder rows.
   A new `conversations.is_direct` column (set at creation) lets the client skip group conversations —
   group recovery (N-party safety numbers) is deferred.

2. **Tap-to-resume (PR 4).** Tapping a placeholder calls `ConversationManager.prepare(peerUserId)` →
   `VerifySecurity` gate → `confirm()`, which creates a fresh MLS 1:1 group (new `conversationId`).
   The old placeholder is removed client-side; the new live conversation replaces it in UI state. The
   server sees only an opaque Welcome + Commit, identical to a normal conversation start. Old history
   is unrecoverable by design.

3. **Identity-change signal (PR 3 — lands before PR 4).** Reinstalling mints a brand-new MLS identity
   (random device keys) even though the PRF unlock key is deterministic. The peer receives a Welcome
   from a key it has never verified. PR 3 persists the verified-state as a **set of per-device safety
   numbers** keyed by `peerUserId`, **sealed under the PRF session key in `argus-keystore`** — never
   plain `localStorage` (this is social-graph metadata) and never sent to the server. On an incoming
   conversation whose present-device safety-number set diverges from the stored set, the client resets
   verified-state and surfaces the re-verify prompt through the existing `VerifySecurity` panel.

**Server sees:** conversation ids, member ids, displayNames (existing routing metadata). No keys, no
content, no trust-state delta. The safety-number set is computed and stored entirely client-side.
However: the server **does** assert the `senderUserId` label on an incoming Welcome — see §2.

## 2. Assets & trust boundaries

| Asset | Owner | Where it lives |
|---|---|---|
| MLS group-state / message keys | Client | `argus-keystore` (sealed under PRF key) |
| Verified safety-number set per peer | Client | `argus-keystore` (sealed under PRF key) — **wiped on reinstall** |
| Social graph (membership) | Server | `conversation_members` table (RLS) |
| `is_direct` flag | Server | `conversations` table (non-content metadata column) |

**Trust boundaries crossed:**
- `client → server` on roster read: server is trusted only for *routing metadata*, not key material.
  A fabricated roster name cannot be silently messaged (safety-number gate runs before `confirm()`).
- `client ↔ client` on identity-change: the peer-device safety-number set is computed from MLS group
  public keys **after `joinConversation`** — not from fresh directory KeyPackages (avoiding a
  directory-substitution at claim time). However, the `userId ↔ key` binding is **server-asserted**:
  the Welcome's `senderUserId` field is written by the server from the authenticated caller at
  delivery time. The server cannot read the trust state, but it chooses which `userId` the trust
  state is keyed to. Consequently the safety-number comparison is a **change-detector** that funnels
  the peer into an OOB human check; it is not a cryptographic MITM-defeater. The OOB safety-number
  comparison (via `VerifySecurity`) is the actual defense (same model as `fingerprint-verification.md`).

## 3. Threats (STRIDE-lite)

**T-resume-1 (Spoofing — key substitution):** A malicious server hands the peer a Welcome carrying
an *attacker's* key, labeled with the victim's `senderUserId`. The peer's identity-change signal
computes a safety-number set from the **present-member public keys inside the joined group** and
compares it against the stored set for that `userId`. Any change — whether a legitimate reinstall
or an injected attacker key — produces a diverging set → verified-state resets → re-verify prompt
fires. **The two cases are indistinguishable at the client layer.** The signal's security value is
solely that it converts silent re-trust into an explicit OOB TOFU decision: the peer cannot be
silently *re-trusted* without reading the safety number aloud. The actual MITM defense is the OOB
comparison, identical to `fingerprint-verification.md §3`. Residual: a peer who taps "mark as
verified" without comparing accepts the key on TOFU — attacker-injected key or genuine reinstall,
same prompt, user decides.

**T-resume-2 (Elevation — stale badge):** A stored "verified" badge survives the reinstall on the
**peer's** side because it was computed against the old identity. Mitigated by keying the stored
state to the **safety-number set** (a set of per-device numbers, covering primary and all
secondaries) rather than to the `conversationId` — any change in the set (new device, replaced
device, any secondary changed) resets the badge to unverified. Invariant: stale trust cannot
persist past the first incoming message from the new identity.

**T-resume-3 (Delivery gap — old-thread send window):** After a reinstall the peer still has the
live dead thread in their keystore. If the peer sends a message to the old `conversationId` before
the new Welcome arrives, those messages are delivered to a device that no longer exists and are
silently undeliverable/undecryptable. Not a confidentiality failure (the reinstalled device is gone)
but a correctness + UX gap. Mitigation in PR 3/4: once a newer direct conversation exists for the
same `peerUserId` (via `findConversationWith` dedup), the dead thread must be marked non-sendable
on the peer's side — composer disabled, same as read-only placeholder.

**T-resume-4 (Spoofing — roster injection):** The server inserts a `userId` into
`conversation_members` for a contact the user never spoke to, causing a spurious placeholder to
appear in the recovered roster. Not a new server capability (the server already controls routing),
but the reinstall path makes it more visible. Mitigated by the safety-number gate: the injected
placeholder is inert (read-only); tap-to-resume runs `prepare()` → `VerifySecurity` → `confirm()`
— no message reaches the fabricated peer without OOB number comparison. The server cannot silently
inject a trusted contact.

**T-resume-5 (Spoofing — reinstaller-side blindness):** The reinstalled device has no stored
safety-number set for anyone (wiped with `argus-keystore`). When it calls
`ConversationManager.prepare(peerUserId)` → `claimKeyPackage`, it receives a KeyPackage whose
authenticity it cannot verify against any prior record — exactly TOFU. A malicious server could
substitute an attacker's KeyPackage at this point and the reinstalled device has no stored number
to compare against. The only mitigation is the existing `prepare()` → `VerifySecurity` gate: the
user is prompted to compare the safety number OOB before `confirm()` can complete. This is the
same TOFU boundary as any first-time conversation start (`fingerprint-verification.md §6`); the
*lost* stored set does not weaken the guarantee below what a brand-new user faces.

**T-resume-6 (Repudiation — cross-identity continuity claim):** A user could later deny that the
new identity minted after reinstall was theirs ("that wasn't me — someone else used my `userId`").
MLS guarantees in-group authenticity (messages are signed with the device's key); it does not
guarantee cross-identity continuity (that the new identity belongs to the same human). This feature
makes no stronger claim. Reinstall is explicitly outside the enrollment path
(`multi-device-enrollment.md`), which is the only flow that chains identities with a vouching
device. Accepted: continuity beyond TOFU is deferred (sealed identity transfer, see §6).

**T-resume-7 (Spoofing — malicious peer fabricating a re-verify prompt):** A peer's client can
locally drop its stored set for your `userId` and show its user the "security code changed" prompt
at will — social-engineering vector ("I got a reinstall notice, please re-confirm your number").
Low severity: the peer is already in the conversation and can read cleartext; this attack adds no
new capability. The signal is meaningful only to the *honest* client. Accepted.

## 4. Invariant check

- **#1 crypto-blind server:** upheld for content. The server returns membership metadata; Welcome +
  Commit are sealed ciphertext. However the server **does** assert the `senderUserId` on incoming
  Welcomes — it controls which `userId` the trust state is keyed to. It cannot read the trust state
  or safety numbers (client-local, sealed); it can influence which peer's slot they're compared
  against. This is the root of T-resume-1's TOFU residual. The crypto-blind guarantee covers
  *content* and *key material*; the `userId` attribution is server-asserted metadata, as it is for
  all routed messages.
- **#2 no secret logging:** upheld. Safety-number sets are client-local, sealed in `argus-keystore`,
  never logged or sent. Roster reads carry only userId/displayName (existing metadata); `is_direct`
  is non-sensitive metadata. Nothing new is logged.
- **#3 RLS:** upheld. No new tables. Reads use `conversation_members` and `conversations`, both
  FORCE RLS. `is_direct` is a non-content metadata column on the already-RLS-protected
  `conversations` table; existing `conversations_tenant_idx` suffices; no new policy, no new index.
- **#4 no hand-rolled crypto:** upheld. Sealing verified-state reuses `sealWithKey` / `openWithKey`
  (`packages/crypto/src/seal.ts`). Safety-number computation reuses `safetyNumber()` and a new
  derivation-equivalent variant (see §5 PR 3). No new primitive.
- **#5 secrets via Key Vault:** untouched. PRF key from WebAuthn authenticator; no new server-side
  secret.
- **#6 no admin path to content:** upheld. Roster recovery reads member ids only. Safety-number sets
  are client-computed and never sent.

## 5. Decision & mitigations

**PR 2 (roster recovery, no crypto):**
- Migration `conversations.is_direct` via `/db-migration`. `conversations` already has `tenant_id` +
  FORCE RLS; `is_direct` is a non-content metadata column — no new policy, no new index needed.
- **Backfill rule:** the backfill query MUST NOT use member count as a proxy for `is_direct` (a
  2-member group would be mislabeled). PR 2 must specify an unambiguous creation-time predicate (e.g.
  rows created via the known 1:1 code path, identified by a stored creation-type field or structural
  marker). Any row that cannot be unambiguously classified defaults to `NULL` (treated as `false`),
  is excluded from recovery placeholders, and is never fed to tap-to-resume. Accepting missed
  recovery for ambiguous pre-existing rows is safer than a false-positive `is_direct` on a group.
- **Invariant for PR 4:** a conversation row with `is_direct ≠ true` can never reach
  `ConversationManager.prepare()`. The UI must gate on this flag before enabling tap-to-resume; the
  `security-boundary-auditor` will assert this explicitly.
- `security-boundary-auditor` gates: both reads confirm RLS + member-only, no content; creation-time
  write sets the flag; backfill predicate reviewed.
- `/api-spec` → regenerate `openapi.json` → 42Crunch audit (target 90+, fix all incl. LOW).
- Unit tests: placeholder builder dedup by `peerUserId` (highest `conversations.created_at` wins —
  the column indexed by `conversations_tenant_idx`); backfill does not misclassify a 2-member group;
  non-`is_direct` rows produce no resumable placeholder.
- Playwright E2E: fresh keystore + valid session → roster appears, history empty, composer disabled.
- **No `crypto-reviewer`** (no crypto surface in PR 2).

**PR 3 (persist + reset verified-state, identity-change signal):**
- `crypto-reviewer` **required** for the new safety-number variant. The variant must accept
  `GroupMember { identity: string, signaturePublicKey: Uint8Array }` (from `Conversation.members()`)
  and produce a number **derivation-equivalent** to the existing `safetyNumber()` path. Specifically:
  - `Conversation.members()` returns `identity` as a UTF-8-**decoded** string (strict decoder,
    `packages/crypto/src/index.ts:526`). The variant must re-encode it to bytes with `TextEncoder`
    before feeding it to `deviceFingerprint` — this is lossless because strict decode rejects
    invalid sequences, but the re-encode dependency must be called out explicitly.
  - Use the same per-device framing: `FP_DOMAIN || u16(len(identityBytes)) || identityBytes ||
    signaturePublicKey` (as in `deviceFingerprint`, `packages/crypto/src/index.ts:165-177`).
  - Combine **two** per-device fingerprints — local device and peer device — exactly as
    `safetyNumber(local, remote)` does: sort the two fingerprint byte arrays, concatenate
    (sorted[0] || sorted[1]), hash with SHA-256, render as decimal groups. Sorting preserves
    symmetry; both sides of the OOB comparison must produce the same output.
  - Gate on a **cross-consistency test**: `newVariant(memberView(kp)) === safetyNumber(kpA, kpB)`
    for the same underlying device. Without this test the feature can ship looking correct and
    silently produce different numbers than the `prepare()` side, breaking every OOB comparison.
    The test MUST include a **non-ASCII identity** (multi-byte UTF-8) to exercise the
    `TextEncoder` re-encode path — ASCII alone cannot prove the round-trip claim.
    This test is **mandatory** in PR 3's gate list.
- `security-boundary-auditor`: confirm nothing leaves the client (no new server field, no log line).
  Confirm the sealed blob lives only in `argus-keystore` and is not mirrored elsewhere.
- Unit tests: key-change resets verified; same-key keeps it; multi-device set collapse (any one
  changed device resets the whole set for that `peerUserId`); derivation-consistency test (above).
- E2E: simulated peer identity change → re-verify prompt appears, send gated.

**PR 4 (tap-to-resume, MLS group creation):**
- `crypto-reviewer` **required**: drives MLS `prepare()` + Welcome from the recovery flow.
- `security-boundary-auditor`: confirm the `is_direct ≠ true` gate holds at every entry point;
  confirm no new authz surface.
- E2E: reinstall simulation → tap placeholder → verify safety number → send → peer receives under new
  group; old placeholder gone, one conversation per contact; non-direct placeholders remain inert.

## 6. Residual risk — friendships table + API (Slices C–D, 2026-06-18)

The `friendships` table introduces pre-conversation social-graph metadata; Slice D adds the seven friends
endpoints over it. The six risks below were identified before the schema landed; the mitigations now cite
the concrete endpoint behaviour that shipped in Slice D (`apps/api/src/friends/`).

- **R-friends-1 (pre-conversation social graph):** `friendships` lets a DB-compromise/subpoena see "A and B are friends" with zero messages. Mitigated by storing **accepted-only** (no rejection/intent ledger) and bounding pending to the open-request lifetime. Same class as `conversation_members`; accepted + documented.

- **R-friends-2 (open-request intent):** while `pending`, the server sees "A wants to reach B" and the direction. Bounded by a 14-day TTL (`expires_at`) + decline/cancel-as-DELETE; `requested_by` NULLed on accept. Residual: the open window. Closing it fully needs the deferred deliver-only model. The `argus_cleanup` RLS policies + grants for the sweep shipped in Slice C (migration 0042); **wiring the scheduled DELETE that invokes them is a small Slice E/F follow-up** (no NestJS scheduler exists yet).

- **R-friends-3 (request-create enumeration oracle):** `POST /friends/requests` is a state-changing argus-id probe. Mitigated by a **uniform `202` with a constant body** (`{ status: 'accepted' }` for found / not-found / inactive / self / already-friends / already-pending — verified by the service test) + the dedicated `SENSITIVE_LIMITS.sendFriendRequest` = 10/hour limit. Residual: an attacker can still confirm existence by completing a friendship if the target accepts — but that needs target consent, so it is not a silent oracle. The target argus-id is **log-sanitised** (`ARGUS_ID_RE`, else `<invalid-format>`) before the `friends.request_created` audit row, reusing the lookup pattern.

- **R-friends-4 (friendship injection — the friends-list analogue of T-resume-4):** a malicious server inserts a `friendships` row, making a stranger appear as an accepted friend. Mitigated by the safety-number gate being the only path to a conversation — an injected friend is inert until the user taps and completes the OOB `VerifySecurity` check (Slice E/F wiring; the API itself never starts a conversation). Same mitigation and residual as the existing T-resume-4.

- **R-friends-5 (IDOR on request actions):** accept/decline/cancel/unfriend take a request `:id`/`:userId`; without the recipient-/requester-/member-only predicate, A could act on a row not addressed to them. **Mitigated in Slice D by placing the authz predicate in the SQL `WHERE` clause** of every mutation (recipient = member AND `requested_by ≠ caller`; cancel = `requested_by = caller`; unfriend = caller ∈ canonical pair), so an unauthorized caller affects 0 rows → uniform 404. Covered by service tests (self-accept → 404, third-party accept → 404, recipient-cancel → 404). `security-boundary-auditor` asserts this.

- **R-friends-6 (admin social-graph widening):** admin/ops must not query `friendships`; if a future ops need arises it must be threat-modelled separately. Keeps invariant #6's metadata-only admin surface from quietly absorbing the pre-conversation graph. No admin friends endpoint exists.

- **GDPR (Slice D):** `friendships` is personal data, so the Art. 20 export (`GET /me/export`) includes the caller's accepted friendships + open requests (other-party id, status, direction-while-pending, timestamps). Art. 17 erasure is automatic — the `(tenant_id, user_low_id/high_id)` FKs are `ON DELETE CASCADE`, so deleting the user row removes every friendship they are a party to. The `friends.request_created` audit metadata deliberately stores **only** the sanitised probed argus-id, never a `found` flag, so the export cannot be replayed as a stored enumeration oracle.

## 7. Residual risk — tap-to-resume original risks

- **TOFU on resume (both sides — T-resume-1 and T-resume-5):** the safety-number comparison is a
  change-detector, not a MITM-defeater. A legitimate reinstall and an attacker-injected key produce
  the same prompt; the human OOB comparison is the sole distinguisher. Same class as
  `fingerprint-verification.md §6` and `multi-device-enrollment.md §4` T2 TOFU. Accepted.
- **Reinstaller-side blindness (T-resume-5):** wiped `argus-keystore` → no stored set for any peer.
  The reinstaller faces pure TOFU at `claimKeyPackage`. Mitigated only by the `VerifySecurity` gate
  in `prepare()`, identical to a first-time conversation start. Accepted; no regression below the
  new-user baseline.
- **Old-thread send window (T-resume-3):** peer may send to the dead thread before the new Welcome
  arrives. Messages are undeliverable but not disclosed. Mitigated in PR 3/4 (dead-thread becomes
  non-sendable once a newer conversation for the same `peerUserId` exists). Accepted as a bounded
  window; not a confidentiality failure.
- **Deferred: group recovery.** Non-`is_direct` conversations are excluded. Non-direct rows are
  inert and explicitly blocked from tap-to-resume (see the `is_direct` invariant in §5).
- **Deferred: cross-identity continuity / sealed identity transfer** (cryptographic proof "same
  human, new device"). Reinstall is outside the enrollment path; proof-of-possession in enrollment
  (`multi-device-enrollment.md §4`) requires a surviving device to vouch — which is exactly what a
  reinstall lacks. The OOB re-verify is the accepted substitute. Deferred as a future "sealed
  identity transfer" capability.
- **Repudiation (T-resume-6):** MLS guarantees in-group authenticity; cross-identity continuity is
  explicitly not claimed. Accepted at this phase.
- **Cross-references:** `fingerprint-verification.md` (§3 Spoofing, §6 TOFU residual — same model),
  `multi-device-enrollment.md` (§4 proof-of-possession gate; §5 residuals — reinstall is outside
  the enrollment path), `metadata-exposure.md` (no new server-visible metadata beyond existing
  routing fields).
