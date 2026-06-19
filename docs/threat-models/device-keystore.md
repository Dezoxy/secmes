# Threat model: client device keystore (IndexedDB)

> **SUPERSEDED (at-rest sealing + recovery model).** This note originally described a passphrase / Argon2id / server-side-recovery design that has since been **removed**. The authoritative current model is **[`prf-keystore-unlock.md`](prf-keystore-unlock.md)**: the keystore is sealed under a per-passkey **WebAuthn-PRF** secret imported as a non-extractable AES-256-GCM key — **no passphrase, no Argon2id, no server-side recovery** (a lost passkey is a fresh start). The passphrase/`key_backups` surface and `packages/crypto/src/key-backup.ts` were deleted (PR #233, migration `0040_drop_key_backups.sql`). The threat *structure* below (assets, boundaries, server-exfiltration) still holds; every reference to a passphrase, Argon2id, or a server-recoverable backup is obsolete — read `prf-keystore-unlock.md` for the shipped sealing.

> Status: **DRAFT for ratification.** Covers roadmap checkpoint 18 — device MLS keys generated client-side and persisted in the browser. Pairs with `mls-integration.md` (key generation) and `prf-keystore-unlock.md` (the at-rest sealing this note defers to).

## 1. Feature & data flow

On first use a device generates its MLS key material via `@argus/crypto` (`MlsEngine.generateDeviceKeys`, CSPRNG through WebCrypto — no hand-rolled crypto), and the keystore persists it in **IndexedDB SEALED** under a per-passkey WebAuthn-PRF unlock key (a non-extractable AES-256-GCM `CryptoKey`; see `prf-keystore-unlock.md`). Unlocking requires a WebAuthn ceremony with that passkey. The **public** package is later published to the key directory (checkpoint 19); the **private** package never leaves the device unencrypted and is never sent to the server. The server stays crypto-blind.

## 2. Assets & trust boundaries

- **Asset:** the device's MLS **private key material** (and, later, group `ClientState`).
- **Boundaries:** browser-origin ↔ other origins (IndexedDB is same-origin only); page JS ↔ at-rest storage (XSS / device-compromise can read IndexedDB); device ↔ server (server must never receive private material).

## 3. Threats (STRIDE-lite)

1. **At-rest disclosure (Information disclosure).** IndexedDB stores **only the PRF-sealed blob** (AES-256-GCM under the per-passkey unlock key) — XSS or a local-device compromise reads ciphertext that's useless without a WebAuthn ceremony on the passkey. The exposure window is now an **unlocked session** (unsealed keys in memory), not data-at-rest; CSP/SRI (checkpoint 43) reduces the in-session XSS surface.
2. **Eviction / data loss.** iOS Safari can evict IndexedDB. → **no recovery by design** (`prf-keystore-unlock.md`): a wiped store is a fresh start (the admin mints a new registration code), consistent with forward secrecy — there is no passphrase backup to re-derive from.
3. **Server exfiltration of private keys.** → structural: only the keystore (client) touches the private package; nothing serializes it toward the server (the key directory publishes the **public** package only).

## 4. Invariant check

- **#1 crypto-blind / #4 no hand-rolled crypto:** keys come from `@argus/crypto` (ts-mls/WebCrypto); the server never sees private material.
- **#2 no secret logging:** the keystore logs nothing.
- No tension. **At-rest encryption (#3.1) is now implemented** — IndexedDB holds only the PRF-sealed blob.

## 5. Decision & mitigations

- The keystore (IndexedDB) generates the device key and **persists it SEALED** (AES-256-GCM under the per-passkey PRF unlock key — `importUnlockKey` in `packages/crypto/src/seal.ts`; see `prf-keystore-unlock.md`). Unlock is a WebAuthn ceremony, not a passphrase. **There is no server recovery artifact** — the old identity-only `exportRecoveryArtifact`/`importRecoveryArtifact` + `key_backups` path was removed (PR #233, migration `0040_drop_key_backups.sql`); a lost passkey is a fresh start, preserving forward secrecy (nothing sealed to a discarded private leaks). The at-rest blob is never uploaded. IndexedDB `DB_VERSION` is **8**; an upgrade wipes and recreates the secret-bearing stores (old rows are unreadable under the new scheme). Reviewer: **`crypto-reviewer`**.
- **Tests:** generate → seal → reload → unseal → the keys still encrypt/decrypt over MLS; a different passkey (different PRF output) fails closed (GCM); `unseal` checks the identity embedded in the decrypted KeyPackage against the requested identity; `clearDevice` allows re-create; legacy records are dropped on `DB_VERSION` upgrade.
- **18's unsealed dev/beta gate is removed** — the keystore is sealed at rest by default.

## 6. Residual risk

- **Unsealed keys in memory during an active session** — once unlocked, the DeviceKeys live in JS memory and are readable by a successful XSS *while the session is unlocked*. Reduced by CSP/SRI (checkpoint 43); not eliminated in a browser.
- **No recovery is a deliberate availability trade** (`prf-keystore-unlock.md` T6) — a lost passkey or evicted store is unrecoverable by design; the admin mints a new registration code and the device starts fresh. This is the cost of having no server-recoverable backup (and no passphrase) to leak.
- **Unlock depends on the authenticator's PRF (hmac-secret) support** — an authenticator without PRF cannot open the keystore (no silent fallback); the gate shows a fresh-start message. See `prf-keystore-unlock.md` T6.
- **Shared browser profile reused by another identity** — `getOrCreateDevice`/`loadDevice` are identity-checked and **throw** rather than hand one identity another's keys; the complete fix is **logout clearing the keystore** (tracked with the session work).
