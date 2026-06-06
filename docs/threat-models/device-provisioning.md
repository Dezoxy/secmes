# Threat model: client device provisioning + KeyPackage pool (live client loop, Slice 2)

> One page. Written before code. The first client slice of the live message loop: on login, unlock (or
> create) the device's sealed keystore and publish a pool of one-time MLS KeyPackages to the key
> directory (#19) so peers can claim one and add this device to a group.

## 1. Feature & data flow

On entering the authenticated app, the client:

1. **Unlocks the device** — the device's MLS keys are sealed at rest in IndexedDB under the user's
   passphrase (Argon2id + AES-256-GCM, #21/#23). A passphrase gate unseals the existing device, or
   creates one on first run. The unsealed keys live only in memory for the session.
2. **Provisions a KeyPackage pool** — mints a pool of **one-time** KeyPackages under the device's stable
   signature identity (`mintKeyPackage` → fresh HPKE init key, same Ed25519 signature key), persists them
   sealed (the privates are retained — a Welcome will be HPKE-sealed to one of them), and **publishes the
   public KeyPackages** to `POST /devices/me/key-packages`.

Only **public** key material leaves the device (the signature public key + the public KeyPackages — both
opaque base64 to the crypto-blind server). Private keys never leave; the passphrase never leaves.

- **Idempotent publish**: the server upserts the device by signature key and dedups KeyPackages (unique
  `(tenant, device, md5)`), so re-publishing the same pool each login is a safe no-op.

## 2. Assets & trust boundaries

- **Assets:** the device's signature **private** key (the stable identity root — its leak lets an
  attacker impersonate the device) and each KeyPackage's **HPKE init private** key (needed to open the
  Welcome sealed to it). Both stay sealed at rest + in-memory only when unlocked. The passphrase.
- **Boundaries:** at-rest (sealed blob ↔ unsealed memory — the passphrase is the gate), client↔server
  (server stores **public** key material only — crypto-blind), and client↔key-directory (the server is
  untrusted for *authenticity*: a peer must verify the claimed KeyPackage's fingerprint out-of-band #20).

## 3. Threats (STRIDE-lite)

- **Information disclosure (private keys):** the at-rest blob is Argon2id+AES-GCM sealed; only public
  material is published. A wrong/missing passphrase fails the unseal (GCM auth) — no plaintext keys ever
  touch disk unsealed or the network. The publish body carries public keys only.
- **Spoofing (publish for another user):** publish is bound to the **verified caller** (`auth.sub` →
  user); a user can only register their own device + packages (server-side, #19). The client never sends
  a user id.
- **Tampering / downgrade:** KeyPackages advertise only the pinned ciphersuite (existing
  `generateDeviceKeys` capability pin) — a peer can't be steered to a weaker suite. The sealed blob is
  GCM-authenticated (tamper → unseal fails).
- **One-time-key reuse (forward secrecy):** each pool member has a **unique** HPKE init key; a KeyPackage
  is claimed once (server one-time-use) and the matching private is consumed on join (Slice 4). The
  client must **retain** each published KeyPackage's private until its Welcome is joined — losing it
  strands the join; reusing one across two joins would break FS. v1 retains all pool privates sealed and
  removes a member only on consume (Slice 4).
- **MITM at add-time:** NOT closed here — the directory hands a peer this device's KeyPackage, but the
  peer must verify its fingerprint out-of-band (#20) before trusting the add. This slice only publishes.
- **Pool exhaustion (DoS):** others claiming this device's KeyPackages drains the server pool; an empty
  pool → claim 404 ("ask to replenish"). v1 publishes a 10-deep pool; availability-driven replenishment
  after others' claims is a follow-up (see §6).

## 4. Invariant check

- **#1 crypto-blind server:** upheld — only public KeyPackages + the signature public key are sent;
  opaque base64 the server stores and never interprets.
- **#2 no secret logging:** upheld — private keys/passphrase never logged or transmitted; the keystore
  seals at rest; the API client logs nothing sensitive.
- **#4 no hand-rolled crypto:** all key material from `@argus/crypto` (MLS/ts-mls); the pool mint reuses
  `generateKeyPackageWithKey` under the existing signature key; serialization is ts-mls `encodeKeyPackage`.
- **#3/#5/#6:** untouched (no new server table; secrets stay client-side; no admin path).

## 5. Decision & mitigations

- **`@argus/crypto`**: `MlsEngine.mintKeyPackage(device)` (fresh one-time KeyPackage, same signature
  identity) + `serializeKeyPackage`/`deserializeKeyPackage` (ts-mls wire codec) + a DeviceKeys-array codec
  for the sealed pool.
- **Keystore**: a **sealed pool** of one-time DeviceKeys alongside the identity device; `ensurePool(target)`
  mints up to `target` and re-seals. Privates retained until consumed (Slice 4). One Argon2 seal per change.
- **Client**: a passphrase **unlock/create gate** (a `DeviceProvider` holding the unlocked device + pool
  for the session) → provision (ensure pool → `publishKeyPackages`). `api.ts` gains the directory call.
- **Reviewers:** `crypto-reviewer` (keystore pool + crypto additions) + `security-boundary-auditor` (the
  publish API client — public-only, no secret logging). **Tests:** crypto round-trips + pool minting
  (same signature, distinct HPKE); keystore pool persistence/seal; api client shape.

## 6. Residual risk

- **Passphrase UX is v1** — a local passcode gate (the sealed-keystore pattern; like Signal/Element
  desktop). Open to refinement (strength meter, biometric unlock, session timeout). Reversible.
- **Replenishment is availability-driven**: the publish response returns `available` (this device's
  unclaimed count), and provisioning mints + publishes FRESH replacements until the directory is back at
  target — so a device stays addressable after peers claim its packages while it was offline (re-publishing
  the claimed ones inserts nothing). The `available` count is the caller's OWN device metadata (no
  cross-tenant leak). Bounded by `MAX_REPLENISH_ROUNDS` + the server's 200/device cap.
- **Local pool growth / pruning**: replenishment retains claimed members' privates (needed to join an
  in-flight Welcome) and appends fresh ones, so the local pool grows over time; consumed members are
  removed on join (Slice 4); expired-KeyPackage pruning (MLS lifetime) is a follow-up. Bounded by the
  server's 200/device cap.
- **Stranded server-side packages after reset/recovery**: clearing the device (`clearDevice`, used by the
  account-switch reset and the pre-restore wipe) discards the retained HPKE privates locally, but the
  matching PUBLIC KeyPackages already in the directory stay unclaimed — so a peer can claim one and seal a
  Welcome this browser can never open until the stale set is exhausted. This is an **availability
  degradation only**: the discarded private is unrecoverable, so no Welcome sealed to it ever leaks (FS
  preserved); it is **bounded** (≤ the published pool / 200-per-device cap) and **self-healing** (each dead
  package is consumed on the claim that poisons one initiation attempt, after which fresh packages are
  served). The proper fix is a **server-side, device-scoped revoke** of unclaimed packages, landing with
  the claim/Welcome lifecycle in **Slice 3** (a user revokes their own device's unclaimed packages before
  re-provisioning). The **account-switch** case is intentionally *not* client-revocable: the abandoned
  device belongs to a different user and the current session has no authority over it (correct authz);
  those packages are cleaned when that user next re-provisions. (Codex P2, PR #66 — accepted residual.)
- **Single device per user** (v1, B2) — multi-device key management is deferred; ties into the
  device-bound-session hardening noted in `welcome-delivery.md` §6.
