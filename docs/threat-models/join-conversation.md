# Threat model: join a conversation on connect (recipient side, Slice 4)

> One page. Written before code. The recipient half of the live message loop: on connect, the device joins
> any conversations it was added to — list pending Welcomes, fetch each (with a proof-of-possession), join
> the MLS group with the one retained private the Welcome was sealed to, then consume (delete) the Welcome
> and prune the used private. Live send/fetch is Slice 5.

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
4. **Consumes** — signs a **consume** proof and calls `DELETE /welcomes/:id?deviceId=&proof=` (204).
5. **Prunes** — removes the now-used private from the sealed pool (`removePoolMember`) so it is never
   reused or re-published.

The server sees ids, the device's **public-key signatures** (proofs), and **opaque base64** blobs — never
plaintext, never private keys. All MLS work is client-side. Joined group state lives **in memory** (Slice
5 persists it).

## 2. Assets & trust boundaries

- **Assets:** the retained one-time **HPKE private keys** (the sealed pool — exactly one opens this
  Welcome); the device's **Ed25519 signature private** (signs the proofs); the **joined MLS group state**
  (in-memory). The passphrase (needed only to re-seal the pool on prune).
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
  Welcome must **never** be reused — reusing it across two joins breaks FS. **Closed by pruning** the
  matched member from the sealed pool immediately after consume, so provisioning/replenishment never
  re-publishes it and no later Welcome can be opened with it.
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
  `DeviceProvider` captures + exposes the server `deviceId` and a `prunePoolMember` action (passphrase
  stays in the provider); a `join.ts` orchestrator (list → fetch → join → consume → prune; per-Welcome
  failures skip, not abort); a `ChatScreen` effect surfaces joined conversations (deduped by id).
- **Reviewers:** `crypto-reviewer` (FS prune, ref-match, proof signing) + `security-boundary-auditor` (api
  client — public/opaque only, no secret logging). **Tests:** end-to-end deliver→list→fetch→join→consume
  through base64 + proofs; `removePoolMember` (correct, persistent, race-safe, no resurrection);
  ordering (consume only after join, prune only after consume; a no-match doesn't abort the batch).

## 6. Residual risk

- **Stranded Welcome (no matching private):** a Welcome sealed to a KeyPackage whose private was discarded
  (device reset/recovery — `device-provisioning.md` §6) matches no pool member → `NoMatchingPoolMember`,
  skipped. Availability degradation only; FS preserved (the private is gone, so no one can open it).
- **Consume succeeds but prune fails (FS-relevant):** the used private lingers in the sealed pool and could
  later be re-published; if a peer then claims it and seals a new Welcome, this browser could open it with
  an already-used private — an FS regression. **Mitigation:** order **consume → prune**; a failed consume
  leaves both Welcome and member for an idempotent retry next connect; a failed prune is logged loudly
  (non-secret) and the member stays (so it won't be re-joined, only re-publishable). Bounded; the
  server-side device-scoped **revoke** (task #20) + a startup reconciliation are the follow-ups that close
  it fully.
- **In-memory group state (Slice 5):** joined `Conversation`s are in-memory; a reload re-joins from any
  still-pending Welcome, but a consumed-and-pruned one is gone until Slice 5 persists group state.
- **Weak inviter identity in the UI:** the list returns only `conversationId` (no `senderUserId`), so a
  joined conversation renders a directory-resolved or placeholder peer name. The Welcome carries the
  inviter's leaf credential; mapping it to a display name is a follow-up.
