# Threat model: key backup & recovery

> Status: **DRAFT for ratification.** Blocks Phase 2 (checkpoints 21–23). Fills the empty `kdf_params` in plan §7. The hard tension: **recovery vs. forward secrecy.** Written against the `ts-mls` model (device signature keys + per-epoch group secrets).

## 1. Feature & data flow

```
backup:   passphrase → Argon2id(salt, params) → backupKey
          backupKey → AEAD-encrypt(device private key material) → ciphertext → server stores it
recovery: passphrase → Argon2id(salt, params) → backupKey → decrypt → load keys into IndexedDB → re-sync
```

The server stores **only ciphertext it cannot open** (no passphrase). This exists because **iOS evicts IndexedDB** under storage pressure — without backup, a user silently loses their identity and history.

## 2. Assets & trust boundaries

- **Asset:** the device's MLS **signature private key** (identity) and any backed-up group secrets.
- **Boundary:** the backup ciphertext sits on the server (untrusted for confidentiality) and is gated only by the passphrase.

## 3. Threats (STRIDE-lite)

1. **Offline brute-force of a leaked backup (Info-disclosure).** If the `key_backups` table leaks, the only thing between an attacker and the keys is the passphrase + KDF cost.
   → **Argon2id** with strong params + a **unique CSPRNG salt** per user; a passphrase-strength policy; **rate-limit** backup *fetch* server-side.
2. **Recovery breaks forward secrecy (the core tension).** If we back up enough to read *old* messages, a stolen backup + passphrase decrypts history — contradicting the FS claim. If we back up only identity keys, FS holds but old history isn't recoverable.
   → **Decision below.**
3. **Backup key reuse / derivation from message keys.** → The backup key is **independent** (derived only from the passphrase), never from message/session keys.

## 4. Decisions

- **Argon2id parameters (starting point):** `m = 64 MiB, t = 3, p = 1`; **tune to ~1–2 s on a budget phone** before GA. Store per-backup: `kdf_params = { algo: "argon2id", m, t, p, salt(base64), v }`. Unique 16-byte CSPRNG salt per user. Version the params so we can raise cost later without breaking old backups.
- **Scope = identity, not history (v1).** Back up the **device signature/identity private key** only → recovery restores the ability to **receive new messages** (re-publish a KeyPackage, re-join groups from server-held Welcomes/state). **Old messages are NOT recoverable** — their per-epoch keys were deleted by forward secrecy. State this plainly in the UI ("messages from before this device are not restored"). *This preserves FS.*
- **Optional, opt-in "history backup" (post-v1):** a user who explicitly accepts the tradeoff can additionally back up group secrets → recoverable history, **at the cost of FS for that data.** Off by default; clearly labeled.
- **Rotation:** after recovery on a new device, or on suspected compromise, **rotate**: generate a new device key, publish a new KeyPackage, mark the old device revoked (ties to `device-lifecycle.md`).
- **AEAD:** encrypt the key material with the ciphersuite AEAD (e.g. AES-256-GCM / XChaCha20-Poly1305) under `backupKey`, random nonce, stored with the ciphertext.

## 5. Invariant check

Upholds #1 (server stores ciphertext only, never the passphrase or plaintext keys), #2 (passphrase/keys never logged). The FS nuance is the only tension — resolved by the identity-only default.

## 6. Residual risk

- **Lost passphrase = unrecoverable** (by design — no server-side reset, or the server could decrypt). Communicate at backup time.
- **Weak passphrase** remains the weakest link; mitigated by Argon2id cost + fetch rate-limiting + a strength meter, not eliminated.
- Identity-only recovery means a device loss loses pre-existing history (FS); acceptable and honest for beta.
