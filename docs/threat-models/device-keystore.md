# Threat model: client device keystore (IndexedDB)

> Status: **DRAFT for ratification.** Covers roadmap checkpoint 18 — device MLS keys generated client-side and persisted in the browser. Pairs with `mls-integration.md` (key generation) and `key-backup.md` (the at-rest sealing this note defers to).

## 1. Feature & data flow

On first use a device generates its MLS key material via `@secmes/crypto` (`MlsEngine.generateDeviceKeys`, CSPRNG through WebCrypto — no hand-rolled crypto), and `DeviceKeystore` persists it in **IndexedDB** (origin-isolated). The **public** package is later published to the key directory (checkpoint 19); the **private** package never leaves the device and is never sent to the server. The server stays crypto-blind.

## 2. Assets & trust boundaries

- **Asset:** the device's MLS **private key material** (and, later, group `ClientState`).
- **Boundaries:** browser-origin ↔ other origins (IndexedDB is same-origin only); page JS ↔ at-rest storage (XSS / device-compromise can read IndexedDB); device ↔ server (server must never receive private material).

## 3. Threats (STRIDE-lite)

1. **At-rest disclosure (Information disclosure — the open gap).** IndexedDB is **not encrypted**; XSS or a local-device compromise can read the stored private keys. → **MUST be sealed by checkpoints 21–22** (passphrase-derived Argon2id key encrypts the private material before persistence). Until then the keystore is **dev/beta-only and stores no real message-bearing keys** — this is a hard gate, loudly marked in `keystore.ts`. CSP/SRI (checkpoint 43) reduces the XSS surface.
2. **Eviction / data loss.** iOS Safari can evict IndexedDB. → recovery via passphrase backup (checkpoints 21–23); a lost device re-derives from backup, not from the evicted store.
3. **Server exfiltration of private keys.** → structural: only the keystore (client) touches the private package; nothing serializes it toward the server (the key directory publishes the **public** package only).

## 4. Invariant check

- **#1 crypto-blind / #4 no hand-rolled crypto:** keys come from `@secmes/crypto` (ts-mls/WebCrypto); the server never sees private material.
- **#2 no secret logging:** the keystore logs nothing.
- No tension; the only open item is at-rest encryption (#3.1), explicitly deferred to 21–22.

## 5. Decision & mitigations

- `DeviceKeystore` (IndexedDB) generates + persists the device key (single device per user, v1). Reviewer: **`crypto-reviewer`**. Test: generate → persist → reload → the reloaded keys still encrypt/decrypt over MLS.
- **Gate:** sealing (21–22) and key-loss recovery (23) MUST land before production / before real history persists.

## 6. Residual risk

- **Unsealed at rest until 21–22** — accepted only for the dev/beta window with no real message-bearing keys; this is the single largest open item and is gated, not ignored.
- Structured-clone persistence assumes the ts-mls key objects are clonable (verified by the round-trip test); if a future ts-mls version changes that, switch to an explicit serializer.
