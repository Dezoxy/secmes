# 04 — Security & threat model

> **Status:** planning. How the trust boundary and security posture change when this E2EE messenger moves from a browser PWA to native iOS/Android. **Net verdict: a strengthening of the at-rest posture, at the cost of one documented native downgrade (working keys are extractable in the Hermes heap — mitigated by the hardware-wrapped root) and three additive server deliverables. No invariant is relaxed; the server stays crypto-blind and RLS-enforced.** Produced by a `security-architect` pass; the main session implements in small reviewer-gated slices.

---

## 1. Trust-boundary changes

| Change | Direction | Detail |
|---|---|---|
| Browser origin sandbox → **app sandbox + OS keystore** | **Strengthening** | At-rest protection moves from evictable, non-hardware-backed IndexedDB to a hardware-isolated Keychain/Secure Enclave / Keystore/StrongBox. New residual: the device is now a long-lived OS-persistent secret holder (iOS Keychain survives uninstall) → make a wipe-on-fresh-install decision. |
| XSS/service-worker/CSP attack surface → **RN-bundle/native-module/rooted-device** | Mixed | Native removes the entire web attack surface but substitutes bundle tampering, malicious native modules, and jailbreak/root key extraction. The in-memory-while-unlocked exposure persists (Hermes JS heap). |
| Non-extractable `CryptoKey` guarantee | **Downgrade only on Hermes (web unaffected); recovered at the native root** | The `@noble` fallback is used **only where `crypto.subtle` is absent (Hermes)** — so on native, working keys are plain JS `Uint8Array`s. The **PWA keeps WebCrypto sealing** (`crypto.subtle`, non-extractable `importUnlockKey`) — **no web regression**. **Mitigation on native (decision #8):** the ROOT wrapping key is a non-exportable hardware-keystore handle that never enters JS, recovering the non-exportability boundary for the root; working keys materialize briefly and are wiped on lock/background. See §2. |
| PRF salt/credential continuity | **RETIRED on native (decision #8)** | The web unlock key = `PRF(hmac-secret, APP_PRF_SALT)`. Native does **not** use PRF — it uses a hardware-wrapped random key (§2) — so the three-vendor byte-parity dependency does not exist on native. PRF stays web-only. |
| RP-ID / origin trust: one web origin → **multiple app origins** | Widening (controlled) | `expectedOrigin` widens to an **exact allowlist** of app origins (iOS associated-domain, Android `apk-key-hash`) — never a wildcard. The RP domain publishes `apple-app-site-association` + `assetlinks.json`. |
| App distribution | New intermediaries | Code reaches users via App Store / Play / EAS Update (OTA) instead of a Cloudflare-fronted bundle with SRI. CDI-1 subresource-integrity → store code-signing; OTA becomes a new signed code-delivery path. Apple/Google can now compel or push a build — a supply-chain trust expansion to document. |
| **Server trust model** | **Unchanged — and that's the point** | `apps/api` stays crypto-blind, transport-agnostic, RLS-enforced. The pivot adds **no** server-side ability to read content. All new trust surfaces are client-side, plus three additive server-config items (origin allowlist, native push-token contract, native refresh-token transport). |

## 2. Key storage — two-tier wrapping (native: hardware-wrapped random key, **no PRF**)

**Decision #8 (2026-06-26, `security-architect`):** native at-rest does **not** use the web's PRF-derived unlock. It uses envelope encryption — a random DB key wrapped by a hardware-backed non-exportable key, biometric-gated. PRF stays web-only.

- **ROOT tier (the wrapping key):** a **non-exportable** key generated *in hardware*. iOS: `react-native-keychain` with `accessControl` (Secure Enclave, biometric) + `accessible = WhenUnlockedThisDeviceOnly` (**never** synced/iCloud). Android: `react-native-keychain` with `securityLevel: SECURE_HARDWARE` plus a runtime `getSecurityLevel()` check to confirm hardware backing (TEE-backed Keystore is the floor). Note: `react-native-keychain`'s public `SetOptions` are `accessible` / `authenticationPrompt` / `securityLevel` / `storage` — there is **no `setIsStrongBoxBacked` option**; explicit StrongBox *selection* (`KeyGenParameterSpec.setIsStrongBoxBacked`) is an Android-platform API that needs a small native keystore module, so treat StrongBox as a best-effort upgrade over the SECURE_HARDWARE floor, not a library flag. `expo-secure-store` only as a last-resort fallback (generates the key in JS memory — protected-at-rest, **not** bound-at-generation). The **biometric `accessControl` is mandatory** — shipping `accessible: WhenUnlocked` *without* `accessControl` silently drops the user-presence property and must be a crypto-reviewer finding.
- **DB key:** a random 32-byte key from the OS CSPRNG, wrapped by the ROOT key. This is what the BLOB tier's AES-GCM seal/open consumes on native (replacing the PRF-derived unlock key).
- **BLOB tier (sealed MLS state):** keep the opaque AES-256-GCM `SealedBlob` model verbatim, with domain-separated AAD per store (`device` / `key-package-pool` / `group-state:<id>` / `pending-commit:<id>` / `log:<conversationId>`). Persist in `expo-sqlite`/`op-sqlite` (or MMKV) via a `get/put/delete`-by-key adapter — rows are opaque, so the adapter is small.
- **Working-key lifetime:** the ROOT key never enters JS (non-exportable handle; unwrap happens behind the OS keystore boundary). The DB key and decoded MLS state *do* materialize in the Hermes heap briefly — so **wipe them on lock/background** (`wipe(fill 0)`); a missing background-wipe must be a crypto-reviewer finding. This JS-heap-residence window is the primary at-rest exposure on native. (The lock-wipe is also why a **locked phone can ring but not decrypt the call `CallSignal` until unlock** — decision #10 / [03](./03-roadmap-ios-then-android.md) Phase 4; a background-accessible call-signaling key tier would relax this with a documented at-rest tradeoff.)
- **Never** use plain KV / AsyncStorage for the ROOT key. **Wipe-on-fresh-install** (iOS Keychain survives uninstall); a DB present without its enclave key **fails closed to fresh-start**, consistent with the shipped no-recovery model.

**Why this is a strengthening, not divergence-for-its-own-sake:** the `@noble` reroute (CHECK 1) already downgrades the web's non-extractable `CryptoKey` to a raw `Uint8Array` on native *regardless* of the unlock model. The hardware wrap is what **recovers** a real non-exportability boundary (for the root), while the biometric gate replicates PRF's user-presence property one-for-one (same Face ID / fingerprint, same Secure Enclave). It also drops the iOS PRF coupling (iCloud-Keychain + platform-passkey-only) and removes a three-vendor byte-parity dependency. Full analysis in `docs/threat-models/native-keystore-unlock.md` (to be written before the native keystore lands).

## 3. Push privacy — preserve the content-free invariant

Web Push today sends `{"type":"new_message"}` only — no sender, no conversationId, no text — and the client wakes, reconnects the WS, and fetches ciphertext. **APNs/FCM must carry the same content-free shape.**

- **Message wake:** the payload carries a **generic, content-free *visible* alert** — a fixed "New message" string, **no** `conversationId`/`senderId`/text — so the OS notifies the user **even when iOS throttles or drops the background JS wake** (silent/data-only pushes are opportunistic and unreliable on iOS; do **not** rely on a data-only wake as the sole delivery path). The fixed string carries no metadata, so content-freeness holds. Decrypt-on-open: when the app opens it reconnects `/ws` and fetches the MLS ciphertext to render the real content.
- **VoIP wake (Phase 4):** iOS PushKit / Android FCM high-priority + full-screen-intent. Payload carries **no caller identity** — only `{type:'call', callId}` (server-minted, opaque). On wake the app **synchronously** calls `reportNewIncomingCall` (iOS 13+ mandate), *then* fetches the MLS-sealed `CallSignal` to learn who's calling + SDP. The caller name is rendered from **local friend data**, never from the push.
- **Residual:** the provider (Apple/Google) still learns existence + timing of a wake for device X — the same accepted residual as Web Push. No *new* metadata leaks if IDs stay out of the payload.
- **GDPR:** APNs/FCM become named Article-30 sub-processors in the ROPA. EU-residency options are limited and not fully controllable — document it.

## 4. Passkey on native — map the existing ceremony unchanged

The server `@simplewebauthn` ceremony and its anti-abuse posture (no-enumeration `allowCredentials:[]`, userHandle-mismatch check, delete-on-use challenge, counter regression rejection, `attestationType:'none'`) all stay — native authenticators emit the same FIDO2 JSON. Three required changes:
1. **RP-ID continuity:** keep `rpID = WEBAUTHN_RP_ID` so PWA-registered passkeys remain valid; the native app declares it as an Associated Domain (iOS `webcredentials:<rpID>`) / `assetlinks.json` (Android signing-cert SHA-256).
2. **Origin allowlist:** widen `expectedOrigin` to accept native app origins **in addition to** the web origin, as an exact allowlist. Serve the association files or native passkeys won't verify at all.
3. **No PRF on native (decision #8).** The native passkey ceremony authenticates the **account only** — it does **not** derive any at-rest key, so there is no PRF eval/strip code on native (a simpler, less error-prone client). PRF parity (the old CHECK 4a) is retired. Device-enrollment authority is unchanged and PRF-independent: Ed25519 proof-of-possession + OOB safety numbers (see §1 and `multi-device-enrollment.md` T1/T2). Web keeps PRF.

## 5. Sequencing prerequisites (security-gated order)

| # | Prerequisite | Gates | Phase |
|---|---|---|---|
| 1 | **Crypto reroute:** X25519 + seal/SHA/HMAC off `crypto.subtle` onto `@noble` behind a custom provider (crypto-reviewer) | any MLS op on RN — gates the whole project | 0 |
| 2 | ~~PRF byte-parity~~ → **hardware-wrapped keystore capability probe** (non-exportable key, biometric gate, StrongBox probe) — *single-platform, non-gating* | the native keystore implementation | 0 |
| 3 | **Authenticated-sender decrypt** in `packages/crypto` (crypto-reviewer) | the first VoIP call that ever connects (web or native) | 0 |
| 4 | **Server origin allowlist** + `apple-app-site-association`/`assetlinks.json`, keeping `rpID` | the first native passkey login | 1 |
| 5 | **Native device-token contract + content-free push sender** (APNs/FCM) | backgrounded message-wake and VoIP call-wake | 1 |
| 6 | **Hardware-backed key-storage adapter** + non-extractability threat-model note | persisting any real MLS private key on a device | 2 |
| 7 | **EAS Update signing/integrity policy + export-compliance decision** | first store submission and first OTA update | 5 |

## 6. Attestation — defer (scope-creep for this threat model)

App Attest (iOS) / Play Integrity (Android) prove a request comes from a genuine, unmodified app. **Argus's trust model deliberately does not depend on client integrity:** the server is crypto-blind, authz is server-verified per request (RLS, friendship/membership gates, server-minted `callId`), and the MLS trust root is human-verified safety numbers + Ed25519 proof-of-possession — **not** device attestation. So attestation buys **no** content-confidentiality and **no** authz improvement for the core threats.

What it *would* add (anti-automation on the unauthenticated register/options endpoints; marginal stolen-refresh-token assurance) is already mitigated by existing controls (rate limits, no-enumeration, delete-on-use challenges, refresh-reuse family revocation). It also adds cost: Apple/Google dependencies, false-rejects on rooted-but-legitimate users (contrary to the privacy-first, self-host-friendly stance), and quota.

**Verdict:** do **not** build attestation for V1/V2. Revisit only if a concrete abuse problem emerges that rate-limiting cannot contain, and scope it narrowly to the unauthenticated abuse endpoints — never as a gate on content or auth correctness.

**Note (decision #9, 2026-06-26):** the native refresh-token problem — iOS native passkeys assert the same `https://<rpID>` origin as the PWA, so origin can't distinguish native from web — is resolved **without attestation**: native HTTP stacks have a cookie jar (`NSURLSession`/OkHttp) that resends the HttpOnly refresh cookie without the app reading it, so native refreshes (including **background locked-call wakes** — no biometric prompt needed) while the token stays out of JS. **Web-origin and same-origin iOS sessions are always cookie-only**, so web XSS cannot elect a body refresh token and gain a persistent session. The body-delivery fallback (only where the cookie jar is unreliable) is a **sender-constrained (DPoP-style) token on a *background-signable* non-exportable key**, granted only to a provably-distinct native origin or behind an unspoofable signal — never a same-origin client. A cryptographic binding (or simply keeping the token out of JS) is stronger and cheaper than App Attest / Play Integrity, so this does **not** reopen the deferral. Final mechanism settled in the Phase-1 `security-architect` pass; see [03](./03-roadmap-ios-then-android.md) Phase 1; full design in `docs/threat-models/native-refresh-pop.md` (before the contract lands).

## 7. Impact on the six invariants

| # | Invariant | Status |
|---|---|---|
| 1 | **Crypto-blind server** | **Preserved.** Server forwards opaque ciphertext; client decrypts. Push stays content-free. Watch item: keep the MLS engine pure-`@noble` so no key/plaintext ever needs server help. |
| 2 | **Never log/persist secrets** | **Preserved**, with new native log surfaces to audit. PRF output, unlock key, MLS private keys, APNs/FCM tokens must never hit native logs, crash reporters (Sentry/GlitchTip), or EAS build logs. Re-run banned-pattern checks against native code. |
| 3 | **RLS on every tenant table** | **Preserved.** One net-new table (native push tokens) ships with `tenant_id` + FORCE RLS `TO argus_app` + leading index + caller-owns-device check, per the `push_subscriptions` template. |
| 4 | **No hand-rolled crypto** | **At risk — crypto-reviewer-gated.** The `@noble` provider reroute + authenticated-sender decrypt are new code on the crypto boundary (vetted `@noble` primitives, not hand-rolled), but the wiring must pass crypto-reviewer before any native crypto runs. The non-extractability downgrade is a posture change to threat-model, not a primitive violation. |
| 5 | **Secrets from Key Vault via Managed Identity** | **Preserved** server-side; new client tier. APNs `.p8` / FCM service-account become Key-Vault file secrets for the push sender (never env). On the client, the per-device unlock key lives in the OS hardware keystore — the device-local analog of vault-backed secrecy. |
| 6 | **No admin path to content** | **Preserved.** Admin/ops surfaces stay metadata-only. Confirm any native admin/diagnostics screens expose metadata only, never message text/images. |

## 8. Implementation slices (each with its gate)

- **0** (docs, before any native keystore code): write `docs/threat-models/native-keystore-unlock.md` — native at-rest model, the non-extractability story both directions, threat table (stolen-locked / coerced-unlocked / malicious-bundle-or-rooted / server-compromise), authz-independence from PRF, StrongBox-absence fallback, wipe-on-fresh-install = fresh-start. **Gate:** security-architect + crypto-reviewer on the note (DoD: threat-model before code).
- **0a** (spike, no merge): `@noble` CryptoProvider for `ts-mls` + seal/SHA/HMAC reroute in a scratch RN harness. **Gate:** crypto-reviewer; CSPRNG audit; MLS round-trip green on a real device.
- **0b** (spike, no merge): **hardware-wrapped keystore capability** harness — non-exportable Keychain/StrongBox key, biometric `accessControl`, wrap/unwrap a random DB key, StrongBox probe (replaces the retired PRF-parity harness). **Gate:** crypto-reviewer (non-exportability, CSPRNG for the DB key); record in `native-keystore-unlock.md`.
- **1** (server): widen `expectedOrigin` to an exact allowlist; serve the association files; keep `rpID`. **Gate:** security-boundary-auditor; controller spec; 42Crunch; threat-model note on `passkey-auth.md`.
- **2** (server + contracts): native device-token contract + RLS table + content-free APNs/FCM sender. **Gate:** security-boundary-auditor (RLS, no token logging, no IDs in payload); db-migration; infra-reviewer (Key-Vault file secret); new `native-push.md`.
- **3** (client): hardware-backed key-storage adapter — random DB key wrapped by a non-exportable, **biometric-gated** Keychain/StrongBox root; **wipe working keys on lock/background**. **Gate:** crypto-reviewer (non-exportable root, mandatory `accessControl`, background-wipe, CSPRNG).
- **4** (client): native passkey ceremony — **account auth only, no PRF on native** (no eval/strip code). **Gate:** security-boundary-auditor (origin allowlist exact; no token/secret logging).
- **5+** (VoIP, native-first, only after authenticated-sender decrypt merges): `react-native-webrtc` relay-only + CallKit/PushKit content-free wake. **Gate:** crypto-reviewer + security-boundary-auditor (no caller identity in push) + infra-reviewer (coturn) per `voip-calling.md` §14.

## 8.5 Pre-existing launch-blocking risk: `ts-mls` is unaudited

**Not introduced by the mobile pivot** — it exists on web today — but the pivot is the right moment to elevate it. `ts-mls` states it has **not** had a formal security audit; `@noble` is partially audited but documents the limits of constant-time and memory-zeroization guarantees in a JIT/GC JavaScript runtime. For a product marketed as a *secure messenger*, this is a **launch gate independent of framework**:

- Pin exact `ts-mls` / `@noble` / `@hpke` versions; verify provenance; review the diff on every bump — and **re-validate the `@noble` `CryptoProvider` shim with crypto-reviewer each time** (a minor `ts-mls` release can change the provider interface; see [02](./02-phase-0-spike.md) "If the linchpin fails").
- Test against RFC 9420 vectors + an independent implementation; fuzz every untrusted decoder.
- Budget an **independent cryptographic review** before any strong public security claim.
- The **`GroupCryptoEngine` boundary** ([01](./01-code-reuse-and-monorepo.md) §9) is the mitigation path if review rejects JS crypto: swap the engine, not the app.

**OTA is also a production root of trust** — a JS update can change crypto/auth/protocol. Governed per [03](./03-roadmap-ios-then-android.md) Phase 5: crypto/auth/protocol never ship via OTA; every update signed; kill switch for forced minimum versions.

*(Both points raised by the external memo (§9, §15) and folded in, 2026-06-26.)*

## 9. Source references

- `packages/crypto/src/seal.ts` (`importUnlockKey` non-extractable — the downgrade site)
- `apps/web/src/lib/prf.ts:26` (fixed `APP_PRF_SALT`)
- `apps/api/src/auth/webauthn.service.ts:79-80` (`rpID`/`expectedOrigin` pins to widen)
- `docs/threat-models/prf-keystore-unlock.md` (unlock model + PRF-strip)
- `docs/threat-models/web-push.md` (content-free push template to preserve)
- `docs/threat-models/voip-calling.md` (authenticated-sender Phase-0 blocker + §14 invariant checklist)
- `docs/threat-models/multi-device-enrollment.md` (Ed25519 proof-of-possession trust root, **not** attestation)
