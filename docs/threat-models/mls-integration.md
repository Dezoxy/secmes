# Threat model: MLS integration (`packages/crypto`)

> Status: **DRAFT for ratification.** Covers roadmap checkpoints 16a (headless 2-device harness) + 17 (MLS wrapper). This is the **only** place cryptography lives. Pairs with `mls-library-selection.md` (why ts-mls), `key-directory.md`, and `prf-keystore-unlock.md` (at-rest sealing). The formal independent crypto review is checkpoint 20 + GA gate G4 — this note covers the initial integration.

## 1. Feature & data flow

`packages/crypto` is a thin, typed wrapper over **`ts-mls`** (RFC 9420 MLS). It runs **client-side** (browser PWA; Node only for tests). A device generates MLS key material locally; the public `KeyPackage` is published to the key directory, the `PrivateKeyPackage` never leaves the device. `Conversation.encrypt(plaintext) → opaque wire bytes` is the **only** thing that crosses to the server; `decrypt(wire) → plaintext` happens only on a recipient device. The server stores/forwards wire bytes (and the `Welcome`/`RatchetTree` on member-add) — all opaque to it. The crypto-blind invariant holds: the server never sees plaintext or key material.

**Crypto-blind ≠ metadata-blind.** The server still sees unavoidable MLS framing: the `group_id` (our `conversationId`), epoch, content-type, and each message's size/timing. Use **opaque (random) conversation IDs** so `group_id` carries no meaning; message timing/size are accepted metadata (padding is a later option).

## 2. Assets & trust boundaries

- **Assets:** device private keys (`PrivateKeyPackage`), MLS group state (`ClientState` — holds ratchet/epoch secrets), and message plaintext.
- **Boundaries:** client↔server (server gets only ciphertext), device↔device (group members), and `packages/crypto`↔rest-of-app (crypto must exist nowhere else).

## 3. Threats (STRIDE-lite)

1. **Hand-rolled crypto / primitive misuse (Tampering/Info-disclosure).** → **All** crypto goes through ts-mls; our wrapper contains **no primitives** (no AEAD/KDF/curve code, no key derivation). Randomness comes from ts-mls → WebCrypto CSPRNG; **no `Math.random`** in this package (Semgrep-enforced).
2. **Key or plaintext leakage (Info-disclosure).** → Private material lives inside `DeviceKeys`/`Conversation` objects and is **never logged, never serialized toward the server, never thrown in an error message**. The wrapper has zero `console`/logging. Only `encrypt()` output leaves a device. The 2-device harness asserts the plaintext bytes never appear in the wire blob.
3. **Server learns content (Info-disclosure — the core invariant).** → Server handles wire bytes only; proven crypto-blind by the harness (checkpoint 16a).
9. **Key substitution / MITM via an unverified KeyPackage (Spoofing — the key-directory threat).** ts-mls v1.6.2's default `validateCredential` returns `true`, so the Basic credential is **not** bound to an authenticated identity by this wrapper; a server that mediates KeyPackage exchange could substitute a peer's package and join itself. → **Owned by the key-directory layer** (`key-directory.md`: server stores KeyPackages under the authenticated user + RLS; clients verify **out-of-band fingerprints**; later a transparency log). At checkpoint 17 there is **no** key directory — KeyPackages are exchanged directly — so it is not yet reachable. **MUST-WIRE before checkpoint 19:** a credential/fingerprint verification step before any externally-sourced KeyPackage enters group state via `addMember` (a stricter `AuthenticationService` or a pre-add fingerprint check).
10. **Trailing bytes after the MLS message (Tampering).** `decodeMlsMessage` reports bytes-consumed; `decrypt` **rejects** unless the decoder consumed exactly `wire.length`, so appended non-MLS bytes (framing bug or a malicious client smuggling plaintext alongside ciphertext) are refused.
4. **Ciphersuite downgrade / wrong suite (Tampering).** → Suite is a pinned constant (`MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`); no client-driven negotiation in v1. The published `KeyPackage` advertises **only** the pinned suite (not ts-mls's default of all 21), so a peer that creates a group and adds us cannot select a weaker one.
8. **Concurrent ops on one conversation (Tampering — nonce/key reuse).** Two `encrypt`/`decrypt` calls racing on the same `Conversation` (a double-click, `Promise.all`) would both read the same ratchet generation before either advances state → AEAD nonce/key reuse. → A **per-conversation operation lock** serializes all stateful ops so each observes the previous op's resulting state.
7. **Spent ratchet secrets retained (forward secrecy).** ts-mls returns `consumed` (spent secrets) from each op; the wrapper **overwrites them with zeros (`wipe`)** after `encrypt`/`decrypt`/`addMember` and never copies them into long-lived structures. JS cannot guarantee the engine kept no internal copies, so erasure is best-effort — a known, accepted limitation of a JS/WASM client.
5. **Group state at rest (Info-disclosure).** → `ClientState` is persisted to IndexedDB **sealed under the per-passkey PRF unlock key** (AES-256-GCM; `prf-keystore-unlock.md`, `live-messaging.md`) — no passphrase, no Argon2. Shipped in Slice 5.
6. **Library/supply-chain trust.** → ts-mls is MIT (vendor-forkable if the single maintainer stalls), version-pinned; RFC 9420 interop test vectors are a planned gate; `@hpke/*`/post-quantum peers are unused by the classic suite (lazy-loaded) and intentionally not installed. `@noble/{curves,ciphers,hashes}` are listed only because ts-mls **requires them as peer dependencies** (not for our direct use) — direct imports of primitive libraries are forbidden by the "only ts-mls" rule and the crypto-reviewer gate.

## 4. Invariant check

- **#1 crypto-blind server / #6 no admin content:** upheld — only ciphertext crosses the boundary.
- **#2 no secret logging:** the package logs nothing; keys/state never serialized for the server.
- **#4 no hand-rolled crypto:** all via ts-mls; primitives appear nowhere in our code. CSPRNG only.
- **#3 RLS / #5 Key Vault:** N/A to this client package (no DB, no cloud secrets). No tension with any invariant.

## 5. Decision & mitigations

- `packages/crypto` is the **sole** crypto home; pinned suite; **no logging of any kind** in the package.
- **Reviewer:** `crypto-reviewer` (mandatory for this and every change here). **Tests:** smoke encrypt/decrypt, multi-message ratchet, unicode, malformed-input rejection (17); headless 2-device harness with a **server-blind assertion** (16a).
- Follow-ups gated before GA: RFC 9420 interop vectors; encrypted `ClientState`-at-rest; independent crypto review (checkpoint 20 + G4).
- **Group / PCS handshake processing** — `addMember` is **2-party-scoped** (the adder applies the commit locally). Before group chat (backlog **B1**) or post-compromise-security self-updates ship, the wrapper must surface `commit.commit` for fan-out to existing members and add a `processHandshake()` path that applies received commits/proposals. `decrypt()` deliberately handles application messages only and does **not** mutate state on a non-application message.

## 6. Residual risk

- **ts-mls maturity / single maintainer** — accepted with the MIT fork escape hatch + planned interop-vector verification.
- **Encrypted state-at-rest shipped (Slice 5)** — `ClientState`, the device keys, the KeyPackage pool, and the message log are persisted to IndexedDB sealed under the per-passkey PRF unlock key (AES-256-GCM; `prf-keystore-unlock.md`). No passphrase, no Argon2, no server backup.
- **2-party only** — `addMember` desyncs 3+ members without commit fan-out; group chat is deferred (B1) and gated on the handshake path above.
- **No formal crypto review yet** — this is initial integration; checkpoint 20 + G4 are the gates, scheduled separately.
