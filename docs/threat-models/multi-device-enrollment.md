# Threat model: multi-device enrollment (B2)

> Status: **DRAFT — written before code (DoD gate).** Roadmap **B2 (multi-device sync)**.
> Covers the enrollment trust boundary: how a second device (D2) is linked to a user account
> that already has an active device (D1), and how D2 joins existing MLS conversations.

## 1. Feature & data flow

```
D2 (new device)                       Server (crypto-blind transport)          D1 (existing device, online once)
───────────────                       ───────────────────────────────          ──────────────────────────────────
1. D2 signs in (OIDC) — same userId
2. D2 generates MLS device keys:
   identity = userId:newDeviceUuid
   (CSPRNG deviceUuid, client-minted)
3. D2 publishes KeyPackage pool          → devices + key_packages rows
4. D2 registers enrollment request       → device_enrollments row (status='pending')
   body: { fingerprint }                    emits DeviceEnrollmentPendingEvent → D1
5. D2 displays its full-width safety
   number (8×5 digits) and waits.
                                         ──nudge──>  6. D1 receives WS nudge
                                                     7. User compares the number on D1:
                                                        claim D2's package (claim-all selfUser)
                                                        D1 derives the number from the relayed
                                                        fingerprint; user confirms it matches
                                                        what D2 shows  ← MITM gate
                                                     8. D1 calls POST /devices/enrollments/:id/approve
                                                        body: { approvingDeviceId, proof }
                                                        proof = Ed25519(D1.privKey, 'argus-enroll:v1\n${D1id}\n${enrollId}')
                                         ──nudge──>  9. Server emits DeviceEnrollmentApprovedEvent → D2
                                                    10. D1 fetches GET /devices/me/conversations
                                                    11. D1 stages add-commit per conversation
                                                        (D2 not yet a leaf) via POST /conversations/:id/commits
                                                        ← existing B1 path, unchanged
12. D2 receives DeviceEnrollmentApproved
13. D2 calls drainWelcomes() — joins all
    conversations D1 added it to
    ← existing join.ts, unchanged
```

For **new conversations created after D2 is enrolled**: D1's `confirmCreate`/`confirm` calls `claimAllKeyPackages(selfUserId)`, adds D2's KeyPackage to the epoch-0 commit's Welcome list, so D2 joins immediately without a retroactive step.

**History**: D2 decrypts from its add-epoch forward only. Pre-join messages are intentionally inaccessible (forward secrecy preserved, `key-backup.md §4`). UI copy: "History stays on your other device."

## 2. Assets & trust boundaries

- **Assets:** D2's MLS signature private key (stable identity root); the enrollment linkage (proving D2 belongs to the user); future-traffic confidentiality (all conversations D1 adds D2 to).
- **New boundary:** the enrollment-coordination surface. The server stores and routes enrollment *metadata* (fingerprint is public; status is routing state; IDs are UUIDs). The server never makes the trust decision — D1 does, cryptographically, via proof-of-possession.
- **Existing boundaries (unchanged):** client-side MLS ratchet tree (crypto truth); per-device sealed keystores (IndexedDB, Argon2id + AES-GCM); `devices` / `key_packages` / `conversation_welcomes` tables (public key material + opaque join blobs only).

## 3. Threats (STRIDE-lite)

### T1 — Rogue-device enrollment via stolen session (CRITICAL)
**Threat:** An attacker with a stolen bearer token (from an OIDC replay, XSS cookie theft, etc.) registers a rogue device, which D1 approves, joining every conversation Alice is in. Reads all future traffic.

**Mitigations (layered):**
1. **Approval requires a proof-of-possession from D1** (`argus-enroll:v1\n${D1id}\n${enrollId}` signed by D1's Ed25519 private key). A session token alone cannot forge this — it doesn't hold D1's key. The server verifies the proof against D1's published signature public key.
2. **Out-of-band fingerprint comparison** — D1 must scan/enter D2's fingerprint. If the attacker registered a rogue device, its fingerprint won't match what's shown on the user's real D2. The user sees the mismatch and rejects.
3. **15-minute expiry** on enrollment requests — a stale pending enrollment can't be exploited hours later.

**Residual:** If D1 is *itself* compromised (the attacker controls D1's session AND D1's private key), it can approve a rogue D2. But a compromised D1 already has full access to all conversations; no new loss. Documented, accepted.

### T2 — Server key-swap of D2's package (self-add MITM)
**Threat:** A malicious server returns an attacker's KeyPackage when D1 calls `claimAllKeyPackages(selfUserId)` to claim D2's package. D1 adds the attacker's device instead of D2.

**Mitigation:** D1 and D2 each display a **full-width safety number** (`enrollmentSafetyNumber`, `packages/crypto/src/index.ts`) — 8 groups of 5 digits (~133-bit), the same rendering as the two-party `safetyNumber`, derived from D2's signature key. D2 computes it from its **own** key; D1 computes it from the server-relayed fingerprint of the claimed package. The user compares the two screens out-of-band and approves only if every group matches (step 7). A swapped package shifts D1's number → mismatch → the user refuses. **Width is the security property (closes FP-1):** the old artifact was a 9-digit (~30-bit) *typed* code, which a malicious server could grind (~10⁹ Ed25519 keygens) to manufacture a colliding number and inject its device — the exact MITM this gate exists to stop. At ~133 bits the second-preimage cost is ≥2⁶⁴, infeasible. (Closes **FP-1**, `docs/reviews/03-auth-identity.md`.)

**Residual:** TOFU / human negligence — the 30-bit grind is now closed, so the only remaining gap is a user who taps **Approve** without actually comparing the numbers. This is the irreducible floor of any out-of-band check (Signal's "they match" button has the identical residual); the UI keeps the compare prominent and the "do not approve if the numbers don't match" warning in view, but cannot force the comparison. Matches the existing #20 residual for peer-adds — accepted. **Future hardening (deferred):** QR-scan verification (camera, two devices co-present) would remove the manual-compare step entirely; not built in this phase.

### T3 — Identity-collision (two leaves with identical MLS credential bytes)
**Threat:** Two devices for the same user produce the same identity string → `Conversation.members()` is ambiguous; safety-number naming breaks; ts-mls may deduplicate or reject.

**Mitigation:** Composite identity `userId:deviceUuid` (CSPRNG UUID, client-generated on first provision) makes every device credential globally unique. The `deviceUuid` differs per device; the full credential bytes are distinct.

**Residual:** The format is now a wire contract. A stored keystore in old format (`userId` with no `:`) is detected by `parseDeviceIdentity` and handled as a `needs-switch` (re-provision). Since the client is unshipped at time of B2, no real production credentials exist to migrate.

### T4 — Enrollment-coordination DoS
**Threat:** An in-tenant attacker (authenticated) spams `POST /devices/me/enrollment` for a target user, flooding D1 with pending-enrollment notifications and consuming pool capacity.

**Mitigations:**
1. **Rate-limiting** — 5/min on enrollment register (same per-verified-user throttle pattern as key-directory mutations, `rate-limit.constants.ts`).
2. **`expires_at`** — pending enrollments expire after 15 minutes; the pending list seen by D1 is bounded.
3. **Enrollment is scoped to the caller's own user** — the server resolves `requesting_device_id` by `(userId, signaturePublicKey)` match, so a different authenticated user cannot create an enrollment for Alice's account. An in-tenant attacker can only flood their *own* enrollment queue.

**Residual:** An attacker with the victim's OIDC credentials (full account takeover) could register many devices. But at that point they control the account entirely; enrollment spam is the least of the concerns. Bounded by rate-limit + `expires_at` GC; no unbounded storage growth.

### T5 — History-expectation mismatch (UX, not security)
**Threat (UX):** A user sees an empty transcript on D2 after linking and believes messages were lost.

**Mitigation:** Clear UI copy in the link flow: "History stays on your other device. New messages will appear here." Mirrors `key-backup.md §4` (recovery brings back identity, not history) and `group-membership.md` T4 (joiners at epoch N can't decrypt epochs < N). This is an expected, documented, forward-secrecy consequence — not a data loss.

### T6 — Epoch-slot contention from enrollment fan-out
**Threat:** D1 issuing many add-commits (one per conversation) races with normal traffic, generating 409s.

**Mitigation:** The existing `stageMembershipCommit` → 409 → `discardStaged` → rebase loop (`conversations.ts:301–310`) handles this transparently. Enrollment commits are not privileged and are issued sequentially (not burst). Eventually consistent.

**Residual:** A user in many active conversations may have a slow fan-out. Bounded and accepted.

### T7 — Stranded KeyPackages after D2 reset or recovery
**Threat:** D2 is cleared (lost passphrase, recovery) and re-provisions with a new signature key. The old KeyPackages remain in the directory, unclaimed; a peer may claim one and produce a Welcome D2 can never open.

**Mitigation:** Existing `revokeUnclaimed` on the restore path (`DeviceContext.restore`) revokes stale packages before re-publishing. Already built and tested (`device-provisioning.md §6`). The remaining availability residual (≤ pool cap, self-healing) is inherited and documented.

## 4. Invariant check

- **#1 crypto-blind server:** the server stores enrollment metadata (fingerprint is public; status is routing state; ids are UUIDs) and relays opaque commits/welcomes. It never decrypts any message content and never makes the trust decision. ✔
- **#2 no secret logging:** enrollment carries no keys, passphrases, or tokens. The fingerprint is public (derived from the published signature key). Audit rows carry `device.enrollment_approved` + actor ids only. The enroll proof is verified and discarded — never stored or logged. ✔
- **#3 RLS on every tenant table:** `device_enrollments` gets `tenant_id` + `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` + `WITH CHECK (tenant_id = app.tenant_id::uuid)` + leading-`tenant_id` composite index. No other table changes grain. ✔
- **#4 no hand-rolled crypto:** the `'enroll'` proof domain is an additive operation on the existing audited `device-proof.ts` Ed25519 primitive (`@noble/curves`). No new primitive; no ts-mls change. ✔
- **#5 secrets via Key Vault:** no new cloud secrets. ✔
- **#6 no admin path to content:** enrollment surfaces expose device metadata only (fingerprint, status, ids). Admin sees device counts/fingerprints; never content. The `GET /devices/me/conversations` endpoint returns conversation IDs (metadata), not messages. ✔

## 5. Residual risk (recorded; carried forward)

1. **TOFU on first safety-number display (T2).** A user who skips the comparison can approve a swapped key. The artifact is now the full-width safety number (~133-bit), so a malicious server can no longer *grind* a colliding number (the closed FP-1 hole) — this residual is reduced to pure human negligence, the irreducible floor of any OOB check. The UI keeps the comparison prominent but cannot force it. Matches the existing #20 residual for peer-adds — accepted.
2. **D1 offline at enrollment time.** D2 can register and display its code, but must wait for D1 to come online to approve and issue add-commits. This is the Signal model ("waiting for your other device"). UI must communicate the dependency explicitly.
3. **Fan-out window.** Between D1 approving and D1 finishing all add-commits, D2 is partially enrolled (some conversations joined, some not). Messages in the unfinished conversations arrive before D2 is a leaf — they're undecryptable and silently skipped (existing join logic). Bounded by the number of conversations and 409-rebase retries; eventually consistent. Documented, accepted.
4. **No history.** Pre-join messages are intentionally inaccessible on D2 (forward secrecy). The opt-in "sealed history transfer" sub-project from `key-backup.md §4` remains deferred; it requires a separate threat model and explicit FS-weakening user acceptance.
5. **Unbounded device count per user (v1).** No per-user device cap is enforced. A user linking many devices (or an attacker with account access) can add many leaves to all conversations. Rate-limiting + the OOB verify gate bound this in practice; a hard cap is a follow-up.
