# Threat Model — Phase 5: Frontend Passkey Client

> Written before Phase 5 code, per AGENTS.md requirement.

---

## 1. Feature & Data Flow

Phase 5 replaces the OIDC redirect with a passkey-first authentication UX and migrates the
directory picker to argus-id exact-match search. No new server endpoints — all APIs were added
in Phases 1–4.

### Auth boot flow (reload/restore)
```
Browser boots → send refresh cookie (HttpOnly, SameSite=Strict) to POST /auth/refresh
  → API returns new access token (memory only) + rotated refresh cookie
  → AuthContext sets in-memory access token → app renders authenticated
```

### Registration flow (new user)
```
User enters one-time code → POST /auth/register/redeem { code }
  → API returns short-lived redemption ticket (argus-id pre-minted server-side)
  → navigator.credentials.create() WebAuthn ceremony (PRF extension requested)
  → POST /auth/webauthn/register/verify { response }
  → API atomically: consumes code, inserts user+credential+session, returns access token + refresh cookie
  → if PRF supported: derive keystore-unlock key from PRF output (no passphrase stored)
  → navigator.storage.persist() called once on first successful unlock
```

### Login flow (returning user)
```
navigator.credentials.get() → discoverable passkey (empty allowCredentials)
  → POST /auth/webauthn/authenticate/verify { response }
  → API verifies credential by stored credential_id (NOT client userHandle)
  → mints session → returns access token + refresh cookie
  → keystore unlocked via PRF (or recovery-code fallback)
```

### Breakglass login (admin)
```
POST /auth/breakglass/login { username, password }
  → Argon2id verify + lockout check + constant-time path
  → admin session minted → access token + refresh cookie
```

### Add-contact-by-argus-id
```
User types argus-id → GET /users/lookup?argusId=… (exact match only, 10 req/min)
  → API returns { userId, argusId, displayName, avatarSeed } or 404
  → frontend initiates createConversation([userId]) via existing Phase 2 MLS flow
```

### Peer-naming migration
```
Old: peer-naming.ts calls listUsers() → scan full directory → find by userId
New: GET /conversations/:id/members → returns { userId, argusId, displayName, avatarSeed } for members
  → peer resolved by userId directly (server-authoritative, shared-membership scoped)
```

### Sensitive data path
- **Access token**: minted by API after WebAuthn/breakglass ceremony; held in **React state only**
  (never localStorage, sessionStorage, or IndexedDB). Lost on page close — reload restores via
  refresh cookie.
- **Refresh cookie**: HttpOnly + Secure + SameSite=Strict, scoped to the refresh path. Never
  readable by JS. CSRF protected by `X-Argus-Refresh` header.
- **PRF output**: used transiently to derive the keystore-unlock key (HKDF). Never persisted.
- **WebAuthn credential private key**: lives in the authenticator (hardware or platform TPM/Secure
  Enclave). Never touches the application layer.
- **Message keys / keystore**: managed by `packages/crypto` + `keystore.ts`. The server never
  sees plaintext or key material — Phase 5 changes nothing about the E2EE layer.

---

## 2. Assets & Trust Boundaries

| Asset | Where it lives | Who can read |
|---|---|---|
| Access token | React state (memory) | Current JS execution context |
| Refresh cookie | Browser cookie jar (HttpOnly) | API server only |
| WebAuthn private key | Authenticator / platform TPM | No application access |
| PRF output / keystore-unlock key | Transient memory | Current execution only |
| Message keys (MLS) | IndexedDB (sealed) | Crypto layer + client |
| argus-id | Public identifier | Anyone with the string |
| displayName / avatarSeed | Server DB + /me response | Tenant members |

**Trust boundaries crossed:**
1. **Browser → API** (HTTPS via Cloudflare Tunnel): bearer + refresh cookie.
2. **JS context → WebAuthn authenticator**: credential creation/assertion. Client is fully
   untrusted from the authenticator's view — the authenticator signs the challenge independently.
3. **Client → server for peer resolution**: lookup is scoped to authenticated tenant members;
   directory now requires intentional sharing of one's argus-id (no browsable list).

---

## 3. Threats (STRIDE-lite)

### Spoofing

| Threat | Mitigation |
|---|---|
| Attacker replays a WebAuthn registration challenge | Challenge is `DELETE … RETURNING` (consume-once) in Phase 2; `expires_at` sweeps any leftover |
| Attacker posts a tampered `userHandle` to hijack an account | API derives identity from stored `credential_id → user_id`, never from client-supplied `userHandle` |
| Access token stolen from memory (XSS) | Memory-only, 10-min lifetime; refresh cookie is HttpOnly so cannot be stolen by XSS |
| Refresh cookie stolen (network) | Cookie is Secure + SameSite=Strict; CSRF header required; single-use rotation invalidates leaked token |
| Breakglass brute-force | Lockout after N failures (Phase 3); throttle on endpoint; Argon2id cost |
| PKCE state/CSRF on passkey flow | Not applicable — no redirects; WebAuthn challenges are server-generated, random, single-use |

### Tampering

| Threat | Mitigation |
|---|---|
| Client sends a different `argus-id` from the one minted at register/verify | argus-id is minted server-side at redeem, stored on the challenge row, and committed at verify; client never picks it |
| Client manipulates registration options to weaken UV/RK requirements | Options are generated server-side; verify checks `userVerification: required` |
| Attacker modifies `navigator.storage.persist()` result to deny persistence | `persist()` is best-effort; failure is non-fatal (just means IndexedDB may be evicted — no security invariant) |

### Information Disclosure

| Threat | Mitigation |
|---|---|
| Directory enumeration via new search UI | `GET /users/lookup` is exact-match only, no prefix/fuzzy; uniform 404; 10 req/min per tenant+sub; argus-id format is opaque/random |
| Access token leak via logs | API must not log the `Authorization` header (existing invariant); client must not log token value |
| PRF output/keystore key in error/console logs | PRF path must never log the derived key; keystore.ts has existing guards |
| avatarSeed treated as a secret | avatarSeed is explicitly non-PII (non-secret aesthetic token) — no special protection needed |

### Elevation of Privilege

| Threat | Mitigation |
|---|---|
| Regular user reaches admin routes via access token after passkey login | `AdminGuard` re-reads `users.role` from DB per request (not from token claim); Phase 3 already handles this |
| Breakglass admin reads message content | Admin surfaces are metadata-only (invariant #6); no content route added in Phase 5 |
| XSS uses the in-memory access token to call API | Token is short-lived (10 min); no privileged action beyond what an authenticated user can do anyway |
| CSRF on refresh endpoint | `X-Argus-Refresh` custom header required on `/auth/refresh`; SameSite=Strict on cookie |

---

## 4. Invariant Check

| # | Invariant | Phase 5 status |
|---|---|---|
| 1 | Server is crypto-blind | ✅ No new server-side message handling; PRF output stays in client |
| 2 | No secret logging | ✅ Access token and PRF output must not be console.log'd — enforced by code review gate |
| 3 | tenant_id + RLS on every tenant table | ✅ No new tables in Phase 5; existing tables unchanged |
| 4 | No hand-rolled crypto | ✅ WebAuthn uses browser WebAuthn API; keystore unlock uses existing `packages/crypto` PRF path |
| 5 | Secrets from Key Vault | ✅ No new secrets in frontend; signing keys are backend (Phase 1) |
| 6 | No admin path to content | ✅ Breakglass login screen leads to AdminPanel (metadata only) |

**Tension note:** The PRF-derived key is computed in the browser JS context. There is no hardware
isolation at the JS layer (unlike the authenticator). An XSS that runs before the keystore is
unlocked and steals the PRF output could unlock the keystore in that session. Mitigated by:
memory-only token (10-min window), SameSite=Strict cookie preventing cross-origin request
exploitation, and CSP headers. This is the accepted residual risk of a PWA architecture.

---

## 5. Decision & Mitigations

### Must-fix before shipping Phase 5

1. **Never derive identity from client `userHandle`** — identity must come from the stored
   `credential_id → user_id` join (Phase 2 contract; verify in code review).
2. **Access token memory-only** — no `localStorage.setItem(token)` anywhere; search for
   `localStorage` + `sessionStorage` writes near the token in `auth.ts` rewrite.
3. **PRF output not logged** — grep for `console.log` near PRF-related code paths.
4. **CSRF header on refresh** — `X-Argus-Refresh` header sent with every `/auth/refresh` call.
5. **`navigator.storage.persist()` called once post-unlock**, not on page load (avoids a
   permission prompt before the user has performed any meaningful action).
6. **Remove `GET /users` endpoint and `UserSummary`/`UserDirectory` contracts in the same PR
   as the last caller migration** — no stranded delete-after; keep bootable throughout.
7. **`peer-naming.ts` must not fall back to `listUsers()` after migration** — any fallback would
   silently reintroduce the directory endpoint dependency.

### Review gates
- `/code-review` (medium effort) before PR open
- `security-boundary-auditor` — no token logging, auth state machine correctness
- `e2e` CI job (register → login → reload → add-contact → message) must pass

---

## 6. Residual Risk

| Risk | Rationale for acceptance |
|---|---|
| XSS steals in-memory access token | Token is 10-min lived; CSP + SameSite mitigate; only same-origin XSS applies; accepted for PWA |
| Platform passkey sync (iCloud/Google) leaks credential | Private key never leaves the authenticator key material; sync is at the hardware/OS layer |
| PRF not available on all authenticators | Phase 5 includes recovery-code fallback for PRF-less devices (decision #6 from plan) |
| `listUsers()` removal breaks any forgotten caller | Pre-removal audit: `grep -r "listUsers"` over `apps/web` must return zero matches before merge |
