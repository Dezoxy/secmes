# Threat model: start a 1:1 conversation (initiator side, Slice 3)

> One page. Written before code. The initiator half of the live message loop: discover a peer, claim one
> of their one-time KeyPackages, **verify the safety number out-of-band (#20)**, MLS-`addMember`, create
> the conversation, and deliver the sealed Welcome. The recipient's join is Slice 4; live send is Slice 5.

## 1. Feature & data flow

On "New conversation", the client:

1. **Discovers the peer** — `GET /users` returns tenant members as metadata only (`{ id, email,
   displayName }`, RLS-scoped). The user picks one.
2. **Claims a KeyPackage** — `POST /users/:userId/key-package/claim` returns one of the peer's one-time
   KeyPackages: `{ deviceId, signaturePublicKey, keyPackage }` (opaque base64).
3. **Verifies out-of-band (#20)** — computes `safetyNumber(localDevice.publicPackage, peerKeyPackage)` and
   shows it; the user confirms it matches the peer over a **separate channel** before trust is granted.
4. **Adds + delivers** — only after confirmation: `addMember(peerKeyPackage)` (local MLS op) yields a
   `{ welcome, ratchetTree }`; `POST /conversations` creates the conversation; `POST
   /conversations/:id/welcomes` delivers the **serialized, opaque** Welcome + ratchet tree to the peer's
   claimed device.

The server sees ids (user/device/conversation), the signature public key, and **opaque base64**
welcome/ratchetTree — never plaintext, never private keys. The unlocked `DeviceKeys` and the MLS group
state stay **in memory** (this slice does not persist group state — Slice 5).

## 2. Assets & trust boundaries

- **Assets:** the unlocked device keys (signature private + HPKE privates) and the MLS group `ClientState`
  — both **in-memory only** while a session is active; the **authenticity** of the peer's claimed
  KeyPackage (is it really the peer's, not a substitute?).
- **Boundaries:** client↔directory (the server is **untrusted for authenticity** — it could hand back an
  attacker's KeyPackage); client↔server (crypto-blind — only opaque ciphertext + ids leave); tenant↔tenant
  (RLS); user↔user (a claim/add targets a peer in the **same tenant**, FK-enforced).

## 3. Threats (STRIDE-lite)

- **Spoofing / MITM key-swap at add-time (the headline threat):** a malicious or compromised server
  returns an **attacker's** KeyPackage in place of the peer's; the initiator would add the attacker to the
  group and leak content. `addMember` **cannot** detect this (its own docstring warns it does not verify
  the package belongs to the intended peer). **Closed by the #20 out-of-band safety-number gate:** any key
  substitution changes `safetyNumber(local, claimed)`, which the user compares with the peer over a
  separate channel **before** the add. Enforced structurally — the session manager is **two-phase**
  (claim+compute → user confirms → add+create+deliver), so code cannot add before verification.
- **Tampering:** welcome/ratchetTree are MLS/AEAD-authenticated; the server stores them opaque and cannot
  forge a Welcome that the peer's join (Slice 4) will accept. A tampered claim KeyPackage shifts the safety
  number → caught at the gate.
- **Information disclosure:** only public key material + opaque ciphertext + ids leave the device. The
  session manager never serializes `DeviceKeys` / `Conversation` to the network or logs; the safety number
  is shown in-UI, never logged.
- **Elevation / cross-tenant:** claim, create, and deliver are RLS-scoped and composite-FK-bound to the
  **verified caller's** tenant — a peer id outside the tenant is rejected (400); `createConversation`
  auto-adds only the creator; `deliverWelcome` is membership-gated.
- **Wrong-device delivery:** the delivered Welcome pins `recipientDeviceId` to the `deviceId` from the
  **same claim** (the device whose KeyPackage it is HPKE-sealed to) — it can't be misrouted to another
  device that couldn't open it.

## 4. Invariant check

- **#1 crypto-blind server:** upheld — welcome/ratchetTree are opaque base64; the server never decrypts or
  interprets them; conversation/membership rows are ids only.
- **#2 no secret logging:** upheld — device keys, group state, and the safety number are never logged or
  transmitted; only ids/counts.
- **#3 RLS on every tenant query:** upheld — claim/create/deliver run under the existing tenant-scoped, RLS
  policies; **no new table** in this PR.
- **#4 no hand-rolled crypto:** upheld — the invite codec is a structural re-encoding (tagged-JSON base64,
  the same codec as the KeyPackage wire form) of MLS objects ts-mls itself produced — not a new primitive;
  `safetyNumber` + `addMember` come from `@argus/crypto`; the conversation id uses `crypto.randomUUID()`
  (CSPRNG), never `Math.random`.
- **#5 secrets via Key Vault / #6 no admin content path:** untouched (no new secrets; no admin surface).
- **Tension (resolved):** the server is both the **discovery channel** and **untrusted for authenticity** —
  this is the standard MLS directory trust model, resolved by the mandatory out-of-band #20 gate.

## 5. Decision & mitigations

- **`@argus/crypto`:** add `serializeInvite`/`deserializeInvite` (a tagged-JSON base64 codec — the same as
  the KeyPackage wire form; ts-mls' own TLS encoders are reachable only via a deep subpath, not the barrel,
  so this mirrors the existing codec for consistency) — the missing piece for delivery; a spec proves
  `addMember → serialize → base64 → deserialize → joinConversation` round-trips through the wire form.
- **Client:** API wrappers carrying public/opaque material only; a **two-phase, safety-number-gated**
  in-memory session manager (phase 2 consumes the phase-1 claim result, so `addMember` is unreachable
  before the gate); a contact picker → the existing `VerifySecurity` gate → create + deliver. Coexists with
  demo mode (forks on `device == null` — demo keeps the seed/loopback path).
- **Reviewers:** `crypto-reviewer` (invite codec; session-manager key handling; the #20-before-add
  ordering) + `security-boundary-auditor` (API client — public/opaque only, no secret logging, Zod-typed
  boundaries). **Tests:** crypto round-trip through base64; each API wrapper; session-manager phase
  ordering (assert `addMember` is never called before confirmation).

## 6. Residual risk

- **In-memory group state (Slice 5):** a page reload before Slice 5 loses the initiator's freshly-created
  local group (the server still holds the conversation + delivered Welcome). Sealed persistence
  (`encodeGroupState`, sealed like the keystore pool) + send/fetch land with the messaging loop in Slice 5.
  Accepted for this slice.
- **Safety-number UX depends on the user actually comparing it out-of-band** — the standard E2EE
  assumption; v1 shows the number with an explicit confirm. Re-verification prompts on key change are a
  follow-up (the verified flag already resets when the number changes).
- **Picker is a bounded top-N list** (no search/pagination yet) — sufficient for v1; an optional `?q=`
  filter is a follow-up.
