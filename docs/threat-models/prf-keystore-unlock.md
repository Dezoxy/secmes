# Threat model — passkey-PRF keystore unlock

**Scope:** how the local device keystore (`apps/web/src/lib/keystore.ts`) is sealed at rest and unlocked, now
that unlock is driven by the WebAuthn **PRF** extension instead of a typed passphrase. Companion to
[`device-keystore.md`](device-keystore.md), [`passkey-auth.md`](passkey-auth.md) §T6, and
[`key-model.md`](key-model.md).

**Change summary:** the keystore was previously sealed under an Argon2id-derived key from a user passphrase,
with a separate session key and a recovery-file / `key_backups` restore path. It is now sealed directly under
a **per-passkey PRF secret** imported as a non-extractable AES-256-GCM `CryptoKey`. There is **no passphrase,
no Argon2 for the keystore, and no recovery** — a lost passkey is a fresh start (the admin mints a new
registration code). This realizes redesign decision #6 (PRF unlock) and #7 (device-local history, fresh on a
new device), and the no-restore rule.

## Design

- **Salt (non-secret, client-owned).** `APP_PRF_SALT` is a fixed 32-byte constant in `apps/web/src/lib/prf.ts`.
  The real key separation is the per-credential PRF key *inside* the authenticator (the server never sees it),
  not the salt. The salt MUST be identical for registration and every login, or the keystore becomes
  permanently unopenable — hence a hardcoded constant, never per-login random.
- **Why the client injects the salt as bytes.** `@simplewebauthn/browser@13` passes the options' `extensions`
  through to the native `create()`/`get()` call **verbatim** (it only decodes `challenge` / `user.id` /
  `allowCredentials`) and its bundled DOM types are PRF-unaware. A base64url salt string in the server options
  would reach native WebAuthn as a *string*, which the PRF extension ignores → silent failure. So the client
  sets `extensions.prf.eval.first` to a `Uint8Array` right before the ceremony; the server's `prf: {}` is only
  the enable signal.
- **Sealing.** The 32-byte PRF output (a native `ArrayBuffer`) is imported via `importUnlockKey`
  (`packages/crypto/src/seal.ts:50-53`) as a **non-extractable** AES-256-GCM key with `encrypt`/`decrypt`
  usage. That one key seals the device, the one-time KeyPackage pool, and every per-conversation group
  state / message log / pending commit, via the existing `sealWithKey`/`openWithKey` (random 96-bit IV per
  seal; domain-separated AAD per store: `device`, `key-package-pool`, `group-state:<id>`,
  `pending-commit:<id>`, and the bare conversationId for the log).
- **Crypto-blind boundary (the secret never crosses it).** `@simplewebauthn/browser` returns the WebAuthn
  response with `clientExtensionResults.prf.results.first` (the raw secret) intact, and the auth flow POSTs
  that response to the server's verify endpoint. So the client **strips `clientExtensionResults.prf` from the
  response object before the verify POST** (`unlockKeyFromResponse` in `prf.ts`, called before
  `verifyAuthentication`/`verifyRegistration`). Defense in depth: the server `verifyRegistration`/
  `verifyAuthentication` also drop `clientExtensionResults.prf` on entry (`stripPrfOutput` in
  `webauthn.service.ts`), and the OpenAPI verify DTOs no longer declare a `prf` field. Signature verification
  does not use PRF, so stripping is safe. The server's options responses still send `extensions: { prf: {} }`
  (the empty *enable* hint, client→authenticator direction) — that carries no secret.
- **Lifecycle.** The PRF secret is produced only by a WebAuthn ceremony:
  - **Login / registration** (user gesture present): the same assertion/attestation that authenticates also
    yields the PRF output; the client imports it and hands the `CryptoKey` to the device gate (no second
    prompt). Registration uses `create()`’s output, falling back to one `get()` if the authenticator returned
    `enabled` only.
  - **Reload** (session restored silently from the refresh cookie — no ceremony): the gate runs ONE fresh
    assertion (behind a click, since WebAuthn `get()` needs a user gesture) to re-derive the key.
  - The key lives in memory only (React state + a transient module handoff in `prf.ts`); it is never persisted.
- **Cutover.** IndexedDB `DB_VERSION` → 7 wipes and recreates every secret-bearing store on upgrade from any
  prior version (old rows were sealed under the passphrase scheme and are unreadable). Local history starts
  fresh; the web client is unreleased, so no real user data is lost.
- **Breakglass admin.** The metadata-only admin authenticates with a password (not WebAuthn), has no MLS
  device and no keystore, and skips the gate entirely (`DeviceContext` → `ready` with `device`/`sessionKey`
  null). It reaches Settings → Admin with no content path.

## Threats & mitigations

| # | Threat | Mitigation |
|---|--------|-----------|
| T1 | **Server learns the unlock key / plaintext keys.** | Server stays crypto-blind. The PRF secret would otherwise ride in the WebAuthn verify request body (`@simplewebauthn` returns it in `clientExtensionResults`), so the **client strips `clientExtensionResults.prf` before the verify POST**; the server **also strips it on entry** (`stripPrfOutput`) and the verify DTOs no longer accept a `prf` field. The secret is computed in the authenticator and used only in the browser; never logged or transmitted. Options responses send only the empty `prf: {}` enable hint (no secret). |
| T2 | **Unlock key recoverable from disk.** | Imported `extractable: false`; the raw 32-byte secret is wiped (`fill(0)`) after import. At rest, IndexedDB holds only AES-GCM ciphertext; the key is never persisted. |
| T3 | **Salt instability orphans the keystore.** | Salt is a fixed app constant used identically at registration and every login; never per-login random. A salt change is an explicit keystore reset (bump the `-v1` suffix). |
| T4 | **Blob confusion / replay across stores.** | `sealWithKey`/`openWithKey` bind a domain-separation AAD per store (device, pool, group-state:<id>, pending-commit:<id>, log conversationId); a blob relocated to another slot fails GCM auth. |
| T5 | **Wrong / different passkey opens another identity's keystore.** | PRF is per-credential, so a different passkey derives a different key → `openWithKey` fails closed (GCM). `unseal` additionally checks the identity embedded in the decrypted KeyPackage against the requested identity. |
| T6 | **No PRF on the authenticator / wiped keystore.** | No silent fallback and no recovery: the gate shows a clear fresh-start message ("ask your admin for a new registration code"). Consistent with the no-restore rule + forward secrecy (a discarded private is unrecoverable, so nothing sealed to it leaks). |
| T7 | **Lost local history on cutover.** | Expected (decision #7 — history is device-local and fresh on a new device). Blast radius is dev-only: the client is unreleased. |
| T8 | **Auto-unlock abused without user presence.** | Auto-unlock runs only when the login/registration ceremony already stashed the key (no new WebAuthn call). The reload path requires a user gesture (a click) because native `get()` does. |

## Invariant check

1. Crypto-blind server — ✅ server never reads PRF output. 2. No plaintext/keys/secrets in logs — ✅ PRF
secret/unlock key never logged; wiped after import. 3. `tenant_id` + RLS — n/a (client-only change; no schema
change). 4. No hand-rolled crypto — ✅ WebCrypto AES-GCM + `@noble` via `packages/crypto`; PRF is the
authenticator's HMAC. 5. Secrets from Key Vault as files — n/a. 6. No admin path to content — ✅ breakglass
admin has no keystore and no content path.

## Residual / follow-ups

- The dead recovery-file + `key_backups` **server** surface has been removed: PR-1 removed the client surface,
  and the `packages/crypto/src/key-backup.ts` module, the GDPR export field, and the table were dropped in
  PR #233 (migration `0040_drop_key_backups.sql`). `importUnlockKey` and the seal/open helpers now live in
  `packages/crypto/src/seal.ts`.
- Multi-device (B2) under PRF: each device derives its own keystore key from its own passkey PRF; unchanged by
  this model (no cross-device key sharing — a new device starts fresh).
