# Threat model: MLS Welcome delivery (live client loop)

> One page. Written before code. The missing server piece between "key directory" (#19) and a live
> two-user conversation: relaying the opaque MLS **Welcome** so an added member can join the group.

## 1. Feature & data flow

To add a member, the inviter (an existing member) **claims one of the recipient's one-time KeyPackages**
from the key directory (#19) — which names a **specific device** — and runs MLS `addMember(keyPackage)`
locally, yielding an opaque **Welcome** + **RatchetTree**. The inviter `POST`s them to the server **for
that recipient device**; the server stores them ciphertext-only. The recipient device, on connect, `GET`s
its pending welcomes, runs `joinConversation(welcome, ratchetTree)` to enter the group, then `DELETE`s the
consumed row. The server **never decrypts** the Welcome (it carries the group's key material, HPKE-sealed
to that device's KeyPackage key). Server stores + forwards opaque base64 only — crypto-blind.

- **Deliver = invite** (one op): in a transaction the server verifies the caller is a member, adds the
  recipient to `conversation_members`, and stores the welcome for the recipient's **specific device** (the
  one whose KeyPackage the inviter claimed — the Welcome is HPKE-sealed to it).
- **List is metadata-only; material-fetch + consume are device-*authenticated*** (caller-scoped like
  `/sync` #30, plus the device). `GET /welcomes` returns **ids + conversationId only** — never the blobs.
  To **fetch** a welcome's sealed join material, or to **consume** (delete) it, the device proves
  possession of its signature key (an Ed25519 proof the server verifies against the published public key).
  So a second device/session of the same user that spoofs a `deviceId` sees only ids on the list — it can
  neither pull another device's join material nor destroy it (consume), which would otherwise permanently
  strand the intended device.

## 2. Assets & trust boundaries

- **Assets:** the Welcome (opaque join material — confidential to the recipient; the server cannot read
  the group secrets it carries), and the membership graph (who is in which conversation).
- **Boundaries:** client↔server (server is crypto-blind — stores/relays ciphertext, sets no group state),
  tenant↔tenant (RLS), and member↔non-member (only a member may add members / deliver; only the recipient
  may read or consume their welcome).

## 3. Threats (STRIDE-lite)

- **Information disclosure (group key material):** the Welcome is **opaque** — the server stores base64 it
  never parses, so it learns no group secret. RLS blocks cross-tenant reads; fetch/consume are filtered to
  `recipient_user_id = caller` **and** `recipient_device_id = the calling device`, so one member can't read
  **another** member's welcome. (Each welcome is sealed to a single device's HPKE key anyway, so even a
  same-user sibling device that fetched one couldn't decrypt it — we don't even hand it over.)
- **Same-user fetch/consume forgery (elevation / DoS):** `deviceId` is a client param, so without a check
  any session of the recipient *user* could pull a **sibling** device's pending welcome blobs (by passing
  its id), or delete it — destroying that device's only join material. The "recipient device only" contract
  would be unenforced. Closed by **proof-of-possession** on BOTH destructive/material ops: the material
  fetch (`GET …/material`) and consume (`DELETE`) each require an Ed25519 signature over
  (op, deviceId, welcomeId) by the device's signature key, verified against its published public key — a
  sibling device, lacking that private key, can't forge either (and the `fetch` and `consume` domains are
  separated, so a fetch proof can't delete). Listing is metadata-only, so it discloses no join material at
  all. Verifying a public-key signature is an auth check, not content decryption, so the server stays
  crypto-blind.
- **Spoofing / elevation (who can add a member):** delivery is **membership-gated** — `requireMembership`
  on the verified caller; a non-member adding members / planting welcomes → 404 (no existence leak, same
  as send #26). The recipient must be a user **in the caller's tenant** (composite FK). `sender_user_id`
  is the verified caller, never client input. Tenant context comes from the verified token only; RLS
  `WITH CHECK` is the backstop.
- **Stale invite after revocation (elevation):** a pending welcome is **owned by the recipient's
  `conversation_members` row** — a composite FK `(tenant_id, conversation_id, recipient_user_id) →
  conversation_members` with **ON DELETE CASCADE**. Revoking app-level membership (the granted member
  DELETE) drops the pending join material atomically, so a removed member can't still fetch a Welcome and
  re-enter the group (mirrors `conversation_receipts`). The deliver tx adds the membership before storing
  the welcome, so it is always bound to a member.
- **Tampering (forged/altered Welcome):** the server can't forge a valid Welcome — it's produced inside
  the inviter's MLS group and integrity-protected; `joinConversation` rejects a tampered blob (MLS
  verification) and the recipient simply fails to join. A malicious server can at most **withhold** a
  welcome (DoS), not forge group membership.
- **MITM at add-time:** a malicious server could hand the inviter the **attacker's** KeyPackage under the
  peer's name (key directory). That is **not** closed here — it's closed by out-of-band fingerprint
  verification (#20, built) BEFORE trusting the add. This feature relays the welcome; #20 verifies the key.
- **DoS / welcome spam:** a member could deliver many welcomes to an offline device. The connect-time
  **fetch is bounded** — `GET /welcomes` takes a `limit` (≤100, default 50), so the response can't grow
  without limit even if a row carries two 32 KiB blobs; the client drains the transient queue by consuming
  each welcome and re-fetching. Bounding *storage* (a spammer filling the DB) stays the accepted welcome-spam
  residual: welcomes are transient (consumed on join) + prunable, and global rate-limiting is #46.

## 4. Invariant check

- **#1 crypto-blind server:** upheld — `welcome`/`ratchet_tree` are opaque base64, never decrypted or
  interpreted; the server brokers, it does not participate in the group.
- **#2 no secret logging:** upheld — logs carry conversation/user **ids** only, never the blobs.
- **#3 RLS:** `conversation_welcomes` has `tenant_id` + ENABLE/FORCE RLS + `WITH CHECK`; composite FK pins
  the conversation to the tenant.
- **#4 no hand-rolled crypto:** the Welcome is MLS (`@argus/crypto`). The only crypto the server adds is
  verifying the device **fetch/consume proofs** via `@argus/crypto/device-proof` (audited Ed25519, not
  hand-rolled) — a public-key authentication check, never content decryption (so #1 still holds). Primitive
  stays in the crypto package; the API only calls it.
- **#5/#6:** untouched. No tension.

## 5. Decision & mitigations

- **Table** `conversation_welcomes` (0012): `tenant_id` + `conversation_id` + `recipient_user_id` +
  `recipient_device_id` + `sender_user_id` + `welcome` + `ratchet_tree` (both base64, ciphertext-only) +
  `created_at`. RLS ENABLE+FORCE+WITH CHECK; composite FK `(tenant_id, conversation_id) → conversations`
  CASCADE; **`(tenant_id, recipient_user_id, recipient_device_id) → devices` NO ACTION** (the welcome must
  be sealed to a real device **of the recipient** — rejects an unknown device or one of another user);
  **`(tenant_id, conversation_id, recipient_user_id) → conversation_members` CASCADE** (the welcome is owned
  by the membership — revoking it drops the pending welcome); user FKs NO ACTION (preserve like
  `messages.sender_user_id`; tenant teardown still cascades). Leading-`tenant_id`
  indexes: `(tenant_id, recipient_user_id, recipient_device_id)` (device fetch-mine) and
  `(tenant_id, conversation_id)` (FK cascade). Grants `select, insert, delete` to `argus_app` (transient).
- **Endpoints** (Zod `.strict()` + OpenAPI bounds, base64 patterns): `POST /conversations/:id/welcomes`
  (deliver = invite; membership-gated; body carries `recipientUserId` + `recipientDeviceId`; adds the
  member + stores the welcome atomically), `GET /welcomes?deviceId=&limit=` (the calling device's pending
  list — **metadata only**, bounded `limit` ≤100), `GET /welcomes/:id/material?deviceId=&proof=` (the sealed
  blobs — requires a **fetch** proof-of-possession), `DELETE /welcomes/:id?deviceId=&proof=` (consume —
  requires a **consume** proof). Each proof is an Ed25519 signature over (op, deviceId, welcomeId) by the
  device's signature key, verified against its published public key, so only the sealed-to device can pull
  or delete its material; the `fetch` and `consume` domains are separated (a fetch proof can't delete). The
  token proves the user (RLS + `recipient_user_id` scoping is the authz boundary); the proof binds the
  **device**. The proofs/verify live in `@argus/crypto/device-proof` (no ts-mls, so the crypto-blind server
  verifies without loading the MLS WASM).
- **Reviewers:** `security-boundary-auditor` (server boundary) + `crypto-reviewer` (the `device-proof`
  Ed25519 module). **Tests (live-DB + crypto unit):** cross-tenant isolation, non-member deliver → 404,
  metadata-only device-scoped list, proof-gated material fetch + consume (sibling-device forgery, cross-op,
  & invalid-proof → 404), wrong-device → 404, bounded-fetch limit, opaque round-trip, conversation-delete
  cascade, membership-revocation cascade, WITH CHECK.

## 6. Residual risk

- **Any member can add anyone** in the tenant (no invite-role authz in v1) — acceptable for 1:1 + small
  groups; admin/role gating is later. Mitigated by tenant isolation + #20 (the added member's key is what
  the inviter verifies).
- **The recipient must already be a provisioned tenant user** (the FK) — fine; users JIT-provision on
  login (#15) and are discoverable via the directory. The composite FK checks the recipient *exists in
  the tenant*, not that they're `active`: an inviter can add a soft-deleted/suspended user (consistent
  with `createConversation`, which adds members the same way). Low impact — an offboarded user can't
  authenticate to fetch the welcome, the membership row is inert, and the directory won't surface them;
  active-status gating on member-add is deferred with role-based invite authz.
- **Blob size ceiling:** `welcome`/`ratchet_tree` are bounded to 32 KiB each (Zod + OpenAPI), sized for
  the v1 1:1 add and kept under the platform's ~100 KB JSON body cap so the documented contract is also
  the enforced one. N-party group RatchetTrees (B1) can exceed this and will need the body cap raised
  alongside the bound.
- **`deviceId` on the LIST is client-asserted (metadata routing only).** The access token carries the user
  (`sub`), not the device, so `GET /welcomes` takes the device id from the client — but it returns **metadata
  only** (ids), never join material, and only within the **caller's own** welcomes (cross-user/tenant blocked
  by the token-derived user + RLS). The destructive/material ops are stronger: **fetching the blobs and
  consuming both require a device proof-of-possession** (§3), so a sibling session can neither pull nor delete
  another device's material. Binding the device into the access token (so the server *verifies* it for the
  list too, dropping the per-request proofs) is later hardening, tracked with multi-device session management.
- **No server-pushed real-time welcome** yet — the recipient polls `GET /welcomes` on connect; a WS push
  is a later refinement (the receipts/realtime gateway #28 can carry it).
- **Group / PCS** semantics (N-party adds, post-compromise security) are deferred (B1); v1 is the 1:1 add.
