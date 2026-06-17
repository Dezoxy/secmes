# Threat model: passkey authentication (Phase 2)

> Invariant check: this feature routes all session minting through `SessionTokenService.mintSession()` (Phase 1).
> The WebAuthn public key stored in `webauthn_credentials` is server-auth key material only — not E2EE content
> key material — so invariant #1 (crypto-blind server) holds. See §passkey-vs-mls below.

## Scope

`POST /auth/register/redeem`, `POST /auth/webauthn/register/options`, `POST /auth/webauthn/register/verify`,
`POST /auth/webauthn/authenticate/options`, `POST /auth/webauthn/authenticate/verify`,
`apps/api/src/auth/webauthn.service.ts`, `apps/api/src/db/migrations/0033_webauthn.sql`.

---

## T1 — Phishing via RP ID / origin mismatch

**Threat:** an attacker registers a lookalike domain, lures the user there, and tries to use their passkey.
WebAuthn's core anti-phishing guarantee is **origin binding**: the browser signs the assertion with the
`clientDataJSON` that includes the page origin, and the authenticator binds to the `rpId` at registration.
An authenticator registered for `app.argus.example` will never produce a valid assertion for `evil.argus.example`.

**Mitigation:**
- `rpID` is set from `WEBAUTHN_RP_ID` env (the public hostname, e.g. `app.argus.example`). Set in `main.ts` config.
- `expectedOrigin` is set from `FRONTEND_ORIGIN` env — the same value the CORS policy uses in `main.ts`.
- The server validates both in `verifyRegistrationResponse()` and `verifyAuthenticationResponse()` on EVERY call.
- Mismatch → `verified: false` → 401. The browser alone can't be tricked; a forged assertion fails server-side.
- Behind Cloudflare Tunnel: `rpID` MUST be the public hostname (not the internal Caddy address), and
  `expectedOrigin` MUST match the browser-visible origin, not `http://caddy:3001`.

**Residual:** a compromised DNS record + valid TLS cert on the attacker's server could trick a user into registering
on a cloned page. Mitigation: the origin-bound `rpID` still blocks CROSS-ORIGIN replay; the domain-theft scenario
is out of scope (that's a PKI/DNS attack, not a WebAuthn attack).

---

## T2 — No enumeration oracle (discoverable authentication)

**Threat:** `POST /auth/webauthn/authenticate/options` reveals whether an argus-id exists.

**Mitigation:** `allowCredentials: []` is always returned — the browser/authenticator picks the resident passkey
without server input. The server never looks up a user in this endpoint; it only generates a random challenge and
stores a short-lived `webauthn_challenges` row. An unauthenticated caller cannot probe for valid argus-ids.

**Rejected design:** typed-argusId as the authenticate-start input — a valid argusId returns credential hints,
an invalid one returns an error, creating a user-existence oracle. This was rejected during security-architect review.
See docs/threat-models/argus-id-identity.md §T5 (enumeration posture).

---

## T3 — Cross-account login via tampered `userHandle`

**Threat:** a valid credential + a tampered `userHandle` in the assertion → session minted as a different user.
FIDO2 discoverable credentials include a server-issued `userHandle` (set at registration). A malicious client could
POST the correct credential response but with a victim's argus-id as `userHandle`.

**Mitigation (mandatory):**
1. Identity is resolved **solely** from the stored `webauthn_credentials.user_id` row matched by `credential_id`.
2. `verifyAuthentication` asserts: if `response.response.userHandle` is present, it MUST equal the stored user's
   `argus_id`. Mismatch → `throw new UnauthorizedException('userHandle mismatch')`.
3. `mintSession` is called with `userId` from the stored row, not from the response.

**Why `@simplewebauthn/server` alone is insufficient:** the library verifies the signature and counter but does
not enforce this `userHandle` policy — the application must do it explicitly.

---

## T4 — Challenge replay within TTL

**Threat:** an intercepted WebAuthn authentication response is replayed before the challenge expires.

**Mitigations:**
1. **Delete-on-use**: `verifyAuthentication` opens with `DELETE FROM webauthn_challenges WHERE ceremony_id=$1
   RETURNING *`. The first verifier deletes the row; a second call finds no row → 401. This is the primary control.
2. **`expires_at` backstop**: the challenge row has a 5-minute TTL; a periodic sweep removes stale rows.
   This is defense-in-depth only — delete-on-use is the real control.
3. **WebAuthn's own replay protection**: the assertion `clientDataJSON.challenge` is verified against the expected
   challenge; the authenticator's counter (§T5) detects cloned credentials.

---

## T5 — Cloned credential / authenticator clone detection

**Threat:** the credential is cloned (private key copied), allowing a second actor to authenticate as the user.

**Mitigation — counter-based clone detection:**
- `webauthn_credentials.counter` is the last verified counter value.
- On each authentication: `newCounter` is returned by `@simplewebauthn/server verifyAuthenticationResponse()`.
- **Accept counter=0**: synced/platform passkeys (Touch ID, iCloud Keychain, Windows Hello) report counter=0
  permanently; rejecting counter=0 breaks every login after the first on these (the most common) authenticators.
- **Reject only regression**: if `stored_counter > 0 AND newCounter <= stored_counter` → clone detected →
  emit audit event `passkey.counter_regression` (includes argus-id, IP, UA) → throw 401.
- If counter regression is detected, the audit event is the signal for the admin to investigate; the session is
  NOT created. Revoking all sessions for the user is a policy decision for Phase 3+ (requires admin tooling).

---

## T6 — PRF extension (NOW WIRED — keystore unlock)

**Status:** the PRF output now derives the keystore unlock key. Full design + threat analysis is in
[`prf-keystore-unlock.md`](prf-keystore-unlock.md); this section is the auth-side summary.

**Server:** the API requests `extensions: { prf: {} }` in both `generateRegistrationOptions()` and
`generateAuthenticationOptions()` (the enable signal — requesting PRF at registration is REQUIRED so the
authenticator includes it in later assertions). The server still NEVER reads the PRF output; it stays
crypto-blind.

**Client:** the salt is client-owned (a fixed, non-secret 32-byte constant in `apps/web/src/lib/prf.ts`),
injected as raw bytes into `extensions.prf.eval.first` before each ceremony — @simplewebauthn v13 passes
`extensions` through verbatim and does NOT base64url-decode the salt, so a server-sent salt string would
silently break PRF. The PRF output (a native `ArrayBuffer`) is imported as a non-extractable AES-256-GCM
`CryptoKey` and never logged or transmitted.

**Decision (owner, 2026-06-17): PRF-only — no recovery code.** A device with no PRF (or a wiped browser
keystore) is a fresh start: the admin mints a new registration code. This removed the recovery-file /
key-backup surface entirely (the redesign no-restore rule).

---

## T7 — Metadata exposure

**What the server learns per authentication:**
- `credential_id` (stored, opaque bytes)
- Source IP + User-Agent header (logged with audit event)
- Timestamp
- AAGUID (stored; often zero under `attestationType:'none'`)

**What is NOT logged:**
- The raw assertion bytes, challenge value, or signature
- PRF output (ignored in Phase 2; must never be logged in Phase 5 either — it is key material)
- `userHandle` bytes (only its match/mismatch verdict is evaluated)

This is consistent with the existing logging posture: `docs/threat-models/metadata-exposure.md` and invariant #2.

---

## T8 — AAGUID and attestation policy

**Phase 2 policy:** `attestationType: 'none'` (privacy default). No AAGUID allowlist is enforced.

**Rationale:** attestation-based allowlists require maintaining FIDO MDS metadata and break open-source or
self-hosted authenticators, contrary to the product's privacy-first stance. The AAGUID column is stored for
future audit/policy use. Under `none` attestation, most platforms return an all-zeros AAGUID.

**Migration column comment:** `aaguid — best-effort, often zero under attestationType:'none'`.

---

## §passkey-vs-mls — why storing a WebAuthn public key is crypto-blind-compatible

Invariant #1: "The server is crypto-blind. It stores and forwards ciphertext only."

WebAuthn public keys stored in `webauthn_credentials.public_key` are **server-auth key material** (they let the
server verify a passkey assertion), not E2EE message key material. They are analogous to an OIDC JWKS entry — the
server holds a public key to authenticate the user, not to read their messages. This is the same exception already
ratified for `jose`/EdDSA in `docs/threat-models/session-tokens.md §invariant-4`. No message content is derivable
from a WebAuthn credential public key.

**MLS device keys (E2EE)** remain client-side only, in `packages/crypto` / IndexedDB. They are unrelated to the
WebAuthn passkey.
