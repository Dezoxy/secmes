# Threat model: join a conversation on connect (recipient side, Slice 4)

> One page. Written before code. The recipient half of the live message loop: on connect, the device joins
> any conversations it was added to — list pending Welcomes, fetch each (with a proof-of-possession), join
> the MLS group with the one retained private the Welcome was sealed to, and surface it. **Consuming** the
> Welcome and **pruning** the spent private are deferred to Slice 5 — deleting a Welcome before the joined
> group is durably persisted would lose the conversation on reload. Live send/fetch is Slice 5.

## 1. Feature & data flow

When the device is unlocked + provisioned (`status === 'ready'`), the client:

1. **Lists** pending Welcomes — `GET /welcomes?deviceId=` returns metadata only (`{ id, conversationId,
   createdAt }`, RLS- + device-scoped).
2. **Fetches** each Welcome's sealed material — signs a **fetch** proof (Ed25519 over
   `argus-welcome-fetch:v1\n{deviceId}\n{welcomeId}`, base64url) and calls `GET
   /welcomes/:id/material?deviceId=&proof=` → opaque `{ welcome, ratchetTree }`.
3. **Joins** — `deserializeInvite` → `joinConversationFromPool(pool, invite)` selects the ONE retained
   one-time KeyPackage the Welcome was HPKE-sealed to (by matching each member's `key_package_ref` against
   the Welcome's `secrets[].newMember`) and joins the MLS group with it.
4. **Surfaces** — adds the conversation to the UI. The Welcome is LEFT **pending** (not consumed) and its
   private **retained** — with no durable group-state store until Slice 5, the pending Welcome is the only
   way to recover the conversation on reload, so the device re-joins from it each connect.
5. **Clears stranded Welcomes** — a Welcome matching no retained private (`NoMatchingPoolMember`) is
   permanently unjoinable, so it IS consumed (signs a **consume** proof → `DELETE /welcomes/:id`) to drop it
   from the bounded, cursorless list — otherwise a head of stranded Welcomes would hide valid newer ones.

The server sees ids, the device's **public-key signatures** (proofs), and **opaque base64** blobs — never
plaintext, never private keys. All MLS work is client-side. Joined group state lives **in memory** (Slice 5
persists it; until then a reload re-joins from the still-pending Welcomes).

## 2. Assets & trust boundaries

- **Assets:** the retained one-time **HPKE private keys** (the sealed pool — exactly one opens this
  Welcome); the device's **Ed25519 signature private** (signs the proofs); the **joined MLS group state**
  (in-memory; persisted in Slice 5).
- **Boundaries:** client↔server (crypto-blind — opaque blobs + ids; proofs prove device possession);
  **device↔sibling-device** (a second session/device of the same user must not fetch or destroy another
  device's Welcome — per-device proof-of-possession); tenant↔tenant (RLS); at-rest (the sealed pool).

## 3. Threats (STRIDE-lite)

- **Spoofing (sibling-device fetch/consume):** a session spoofing a `deviceId` could try to pull or destroy
  another device's Welcome. **Closed by Ed25519 proof-of-possession** — fetch and consume each require a
  signature by **that** device's signature key over `(op, deviceId, welcomeId)`, verified server-side
  against the published public key; fetch and consume use **separate domains**, so a fetch proof can't be
  replayed to consume. The list returns ids only, so an unproven `deviceId` leaks nothing.
- **Forward secrecy / one-time-key reuse (the headline invariant):** the HPKE private that opens this
  Welcome must **never** open a *different* Welcome — reuse across two distinct joins breaks FS. In a drain,
  the matched member is dropped from the in-memory **working pool** the moment it opens a Welcome, so two
  Welcomes sealed to the **same** package (a deliver duplicate, or a replayed/reused claimed KeyPackage)
  can't reuse the spent private — the second finds no match and is cleared. (Re-joining the **same** pending
  Welcome on a later connect re-derives the **same** group from the **same** secrets — not reuse across
  *distinct* joins — so it is FS-safe.) The durable **sealed-pool prune** of the spent private lands with the
  consume in **Slice 5** (it needs the group persisted first); until then the private stays retained so a
  reload can re-join. The drain **re-lists** to drain pages beyond the first (a `seen` set stops
  re-processing); stranded Welcomes are consumed-to-clear so they don't hold the cursorless page.
- **Tampering:** welcome/ratchetTree are MLS-authenticated — a tampered Welcome fails `joinGroup`
  validation (e.g. parent-hash). Matching is over the byte-exact `key_package_ref`: a forged/foreign Welcome
  either matches **no** pool member (`NoMatchingPoolMember`, skipped) or fails the join. No state is
  corrupted on a failed attempt (`joinGroup` validates before producing state; pool privates are read-only
  inputs).
- **Information disclosure:** only ids + opaque blobs + public-key signatures leave the device; the
  transiently-unsealed pool plaintext is wiped (`.fill(0)`); no plaintext/keys/passphrase is logged.
- **Elevation / cross-tenant:** list/fetch/consume are RLS- + device-scoped to the **verified caller**; a
  non-member / cross-tenant / foreign-device request gets the same opaque **404**.

## 4. Invariant check

- **#1 crypto-blind server:** upheld — opaque welcome/ratchetTree; the server stores/forwards and never
  decrypts; matching + join are client-side.
- **#2 no secret logging:** upheld — HPKE/signature privates + passphrase never logged or transmitted; the
  unsealed pool is wiped after each reseal.
- **#3 RLS on every tenant query:** upheld — the three welcome routes already enforce tenant + device
  scoping; **no new table** in this slice.
- **#4 no hand-rolled crypto:** upheld — matching uses ts-mls `makeKeyPackageRef`; join via ts-mls
  `joinGroup`; proofs via `@argus/crypto/device-proof` (Ed25519 / `@noble`). Selecting one's **own** key by
  public ref is not a secret comparison, so plain byte-equality is fine (no timing concern).
- **#5 secrets via Key Vault / #6 no admin content path:** untouched.

## 5. Decision & mitigations

- **`@argus/crypto`:** `MlsEngine.keyPackageRef(keys)` (= ts-mls `makeKeyPackageRef(publicPackage,
  cs.hash)`) + `joinConversationFromPool(pool, invite) → { conversation, member }` (ref-match select-and-
  join; throws typed `NoMatchingPoolMember` if none fits). All ts-mls/WASM use stays inside the crypto pkg.
- **Keystore:** `removePoolMember(device, passphrase, publicKeyPackageB64)` — CAS-guarded reseal (mirrors
  `ensurePool`), match on the serialized **public** KeyPackage, wipe transients. The FS prune.
- **Client (PR-4B):** `api.ts` `listWelcomes`/`fetchWelcomeMaterial`/`consumeWelcome` (base64url proofs);
  `DeviceProvider` captures + exposes the server `deviceId`; a `join.ts` orchestrator (list → fetch → join →
  surface; stranded → consume-to-clear; per-Welcome failures isolated; re-list to drain pages); a
  `ChatScreen` effect surfaces joined conversations (deduped by id). Consume/prune of JOINED Welcomes +
  the `removePoolMember`/`prunePoolMember` + passphrase wiring land in Slice 5 with group-state persistence.
- **Reviewers:** `crypto-reviewer` (ref-match, within-drain FS, proof signing) + `security-boundary-auditor`
  (api client — public/opaque only, no secret logging). **Tests:** end-to-end deliver→list→fetch→join
  through base64 + proofs; the spent-member FS (a duplicate sealed to the same package is cleared, not
  reused); the cursorless-page drain (a stranded head is cleared so a valid Welcome behind it is reached);
  per-Welcome failures don't abort the batch.

## 6. Residual risk

- **Stranded Welcome (no matching private):** a Welcome sealed to a KeyPackage whose private was discarded
  (device reset/recovery — `device-provisioning.md` §6) matches no pool member → `NoMatchingPoolMember`. It
  is permanently unjoinable, so the drain **consumes it to clear it** (the consume proof needs only the
  device signature key, not a join) — otherwise, because the welcome list is bounded and **cursorless**
  (oldest-first), a head of stranded Welcomes would hide valid newer ones behind it. Availability
  degradation only; FS preserved (the private is gone, so no one — including this device — can ever open it,
  so deleting it loses nothing recoverable).
- **Consume + prune of joined Welcomes deferred to Slice 5:** consuming a Welcome before the joined group is
  durably persisted would lose the conversation on a reload (the Welcome is deleted, the in-memory group
  with it). So Slice 4 leaves joined Welcomes **pending** and their privates **retained** — the Welcome is
  the reload anchor; the device re-joins from it each connect (re-deriving the same group — FS-safe). Slice 5
  adds sealed group-state persistence, after which consume + the sealed-pool prune (`removePoolMember`)
  become safe, and the spent private is dropped + the server-side **revoke** (task #20) cleans up.
- **Bounded by the cursorless list until Slice 5:** joined-but-unconsumed Welcomes hold their slots in the
  oldest-first, cursorless list, so a device in **more than one page** (>100) of conversations joins only
  the oldest page per connect until Slice 5 lets consumption (and drop-off) happen. Strictly better than the
  permanent loss that consuming-before-persistence would cause; resolved in Slice 5.
- **Weak inviter identity in the UI:** the list returns only `conversationId` (no `senderUserId`), so a
  joined conversation renders a directory-resolved or placeholder peer name. The Welcome carries the
  inviter's leaf credential; mapping it to a display name is a follow-up.
