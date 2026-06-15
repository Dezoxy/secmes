# Threat model: client device keystore (IndexedDB)

> Status: **DRAFT for ratification.** Covers roadmap checkpoint 18 — device MLS keys generated client-side and persisted in the browser. Pairs with `mls-integration.md` (key generation) and `key-backup.md` (the at-rest sealing this note defers to).

## 1. Feature & data flow

On first use a device generates its MLS key material via `@argus/crypto` (`MlsEngine.generateDeviceKeys`, CSPRNG through WebCrypto — no hand-rolled crypto), and `DeviceKeystore` persists it in **IndexedDB SEALED** under the user's passphrase (`sealBackup`: Argon2id + AES-256-GCM). Unlocking requires the passphrase. The **public** package is later published to the key directory (checkpoint 19); the **private** package never leaves the device unencrypted and is never sent to the server. The server stays crypto-blind.

## 2. Assets & trust boundaries

- **Asset:** the device's MLS **private key material** (and, later, group `ClientState`).
- **Boundaries:** browser-origin ↔ other origins (IndexedDB is same-origin only); page JS ↔ at-rest storage (XSS / device-compromise can read IndexedDB); device ↔ server (server must never receive private material).

## 3. Threats (STRIDE-lite)

1. **At-rest disclosure (Information disclosure).** IndexedDB stores **only the passphrase-sealed blob** (Argon2id + AES-256-GCM) — XSS or a local-device compromise reads ciphertext that's useless without the passphrase. The exposure window is now an **unlocked session** (unsealed keys in memory), not data-at-rest; CSP/SRI (checkpoint 43) reduces the in-session XSS surface.
2. **Eviction / data loss.** iOS Safari can evict IndexedDB. → recovery via passphrase backup (checkpoints 21–23); a lost device re-derives from backup, not from the evicted store.
3. **Server exfiltration of private keys.** → structural: only the keystore (client) touches the private package; nothing serializes it toward the server (the key directory publishes the **public** package only).

## 4. Invariant check

- **#1 crypto-blind / #4 no hand-rolled crypto:** keys come from `@argus/crypto` (ts-mls/WebCrypto); the server never sees private material.
- **#2 no secret logging:** the keystore logs nothing.
- No tension. **At-rest encryption (#3.1) is now implemented** — IndexedDB holds only the passphrase-sealed blob.

## 5. Decision & mitigations

- `DeviceKeystore` (IndexedDB) generates the device key and **persists it SEALED** (`sealBackup`: Argon2id + AES-256-GCM, checkpoint 21) under the user's passphrase. `getOrCreateDevice`/`loadDevice` take the passphrase and unseal. The **server recovery artifact is a SEPARATE, identity-only blob** (`exportRecoveryArtifact`/`importRecoveryArtifact`, checkpoints 22–23): it seals only the signing identity — **not** the full at-rest `DeviceKeys`, so it carries no one-time KeyPackage HPKE private keys. On restore it mints a **fresh** KeyPackage under that identity (re-publish + re-join), preserving forward secrecy per `key-backup.md` §4. The full at-rest blob is never uploaded. IndexedDB schema is **v2**; the v1→v2 upgrade drops the legacy unsealed store. Reviewer: **`crypto-reviewer`**.
- **Tests:** generate → seal → reload → unseal → the keys still encrypt/decrypt over MLS; wrong passphrase rejected; **identity-only fresh-device recovery** (checkpoint 23) — recovered device shares the signing identity but gets a fresh KeyPackage (the artifact carries no init/hpke private keys); import authenticates before persisting (no stranded bad record), rejects a mismatched identity, and is race-safe; `clearDevice` allows re-import; legacy v1 records are dropped on upgrade.
- **18's unsealed dev/beta gate is removed** — the keystore is sealed at rest by default.

## 6. Residual risk

- **Unsealed keys in memory during an active session** — once unlocked, the DeviceKeys live in JS memory and are readable by a successful XSS *while the session is unlocked*. Reduced by CSP/SRI (checkpoint 43); not eliminated in a browser.
- **Passphrase strength is the weakest link** (shared with `key-backup.md`) — mitigated by Argon2id cost + a strength meter, not eliminated; a lost passphrase is unrecoverable by design.
- **MUST-WIRE (upload path):** the FS guarantee holds only because the **identity-only** artifact is the sole thing uploaded. When the backup-upload UI lands, it MUST call `exportRecoveryArtifact` and MUST NOT upload the full at-rest `sealed` blob (which still contains one-time HPKE private keys for local use). There is no type/lint guard yet — add one (or a wrapper type) with the upload wiring so a future caller can't pass the at-rest blob to the backup API.
- **Argon2id UX cost** — the 64 MiB KDF runs on each unlock; derive async (done) and run in a Web Worker (Phase-5 follow-up) so unlock doesn't stall the UI; cache the unsealed keys per session.
- **Shared browser profile reused by another identity** — `getOrCreateDevice`/`loadDevice` are identity-checked and **throw** rather than hand one identity another's keys; the complete fix is **logout clearing the keystore** (tracked with the session work).
