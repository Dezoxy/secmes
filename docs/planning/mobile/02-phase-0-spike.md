# 02 — Phase-0 spike (the fail-closed gate)

> **Status:** planning. Before a single screen is written, prove the make-or-break unknowns on a **real device**. This phase exists to make the framework commitment *honest*: if CHECK 1 (the crypto reroute) proves intractable upstream, the decision re-opens — and discovering that here costs weeks, not months.

**Estimate:** ~3 weeks (trimmed from 3–4 after CHECK 4a's PRF-parity gate was retired, 2026-06-26). **Exit rule:** the checks below pass on real hardware, with crypto-reviewer sign-off on the crypto items, *before* any UI work begins. **CHECK 1 is the sole framework-invalidating linchpin.**

---

## Why a gate at all

**One** risk can invalidate the whole React Native choice, and it's cheap to test and expensive to discover late: the MLS engine doesn't run on Hermes out of the box (X25519 → `crypto.subtle`). Prove the fix first.

*(The original plan had a **second** framework-invalidating risk — a passkey PRF output being byte-identical across web/iOS/Android. It was **retired 2026-06-26**: the native keystore no longer uses PRF (it uses a hardware-wrapped random key). See CHECK 4a and [00](./00-overview-and-decision.md) decision #8.)*

Everything else (UI, navigation, push plumbing) is ordinary work that *will* succeed given time. CHECK 1 might not. Test it first.

---

## CHECK 1 — Crypto reroute (the linchpin) 🔑

**Claim to prove:** the MLS engine runs on Hermes with X25519 backed by `@noble/curves` instead of `crypto.subtle`.

**Tasks**
- Author a custom `ts-mls` `CryptoProvider` whose `makeHpke` supplies a **non-`@hpke/core`** KEM backed by `@noble/curves` x25519, satisfying `ts-mls`' HPKE seal/open contract. Injection point: `ts-mls .../crypto/getCiphersuiteImpl.js` `provider`.
- **Introduce the `GroupCryptoEngine` adapter from day one** (see [01](./01-code-reuse-and-monorepo.md) §9): wrap `ts-mls` behind the Argus-owned interface so the spike *also* validates the boundary that later lets the engine be swapped for a native/Rust core without touching UI. The provider (below `ts-mls`) and the engine interface (above it) land together.
- Reroute the four `crypto.subtle` sites in `packages/crypto` to `@noble`: `index.ts:148` (SHA-256), `seal.ts` (AES-GCM import/encrypt/decrypt, AAD-bound), `turn-credential.ts` (HMAC-SHA1 — or drop it from the client entirely; creds come from `POST /calls/turn-credentials`).
- Install `react-native-get-random-values` (imported **first** at app entry) and confirm it bridges the OS CSPRNG (`SecRandomCopyBytes` / `SecureRandom`). All MLS key material, attachment keys, and IVs depend on it.
- Verify `TextEncoder`/`TextDecoder` — including the strict `new TextDecoder('utf-8', { fatal: true })` in `index.ts` (a security control against lossy-UTF-8 identity collisions). Polyfill (`text-encoding`/`fast-text-encoding`) if `fatal` mode isn't honored.
- Verify `atob`/`btoa` (or replace `fromB64`/`toB64` with a Uint8Array base64 lib).

**Exit criteria**
- `createGroup` / `joinGroup` / `addMember` / Welcome-seal / `encrypt` / `decrypt` round-trip **green on a physical iPhone**.
- A message encrypted on RN **decrypts on the PWA and vice-versa** (same engine, same wire format — proves zero interop drift).
- **crypto-reviewer sign-off** on the provider wiring (it's new code on the crypto boundary; invariant #4).
- CSPRNG provenance confirmed.

**If it fails:** see "If the linchpin fails" below — the likely answer is *pin/fork the `ts-mls` provider*, not switch frameworks.

---

## CHECK 2 — MLS performance on Hermes 📊

**Claim to prove:** group operations stay fast enough on a mid-range Android.

The `@noble` primitives run **interpreted on Hermes (no JIT)**. Every commit/Welcome does X25519 + HKDF + AES-GCM in JS. Nobody has measured this for your ciphersuite (`MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`).

**Tasks**
- Benchmark `createGroup`, `addMember`/commit, and Welcome processing on a real mid-range Android device.

**Exit criteria**
- Group ops stay acceptably responsive (target: commit/Welcome well under ~100 ms; 1:1 messaging is not a concern). Record the numbers in the spike report.

**If it fails:** consider a native crypto module for the hot path, or accept a UX affordance (spinner) for group ops. Does not block 1:1 messaging.

---

## CHECK 3 — Authenticated-sender decrypt 🔐

**Claim to prove:** `packages/crypto` can tell the recipient *which* MLS member sent a signal.

This is the **DTLS-fingerprint MITM defense** for VoIP and a hard prerequisite for any connecting call (web *or* native). Today `decrypt()` returns a bare string with no sender identity. It is shared with the existing VoIP plan (`docs/threat-models/voip-calling.md`, R6).

**Tasks**
- Land the authenticated-sender decrypt path in `packages/crypto`.

**Exit criteria**
- `decrypt()` surfaces the authenticated sender's MLS identity; **crypto-reviewer sign-off**.

**Note:** this is on the critical path for native-first VoIP but does **not** block messaging — Phases 1–3 can proceed in parallel.

---

## CHECK 4 — Native keystore (hardware-wrap) + WebRTC/CallKit on device 📱

Two independent sub-checks, both on real hardware.

### 4a — Hardware-wrapped keystore capability *(replaces the retired PRF-parity gate)*
**Resolved by `security-architect` 2026-06-26** ([00](./00-overview-and-decision.md) §6 q0 / decision #8): native at-rest uses a random DB key wrapped by a non-exportable Secure-Enclave/StrongBox key, **biometric-gated** — **not** PRF. The old "prove byte-identical PRF output across web/iOS/Android" requirement was the second-riskiest unknown; deleting the dependency deletes the risk. This sub-check is now a *single-platform capability probe*, not a three-vendor parity proof, and is **non-framework-invalidating** (CHECK 1 is the sole linchpin).

**Tasks**
- `react-native-keychain`: generate a **non-exportable** enclave (iOS) / StrongBox-or-TEE (Android) key; wrap/unwrap a random 32-byte DB key; assert `accessControl` (biometric) + `accessible = WhenUnlockedThisDeviceOnly`.
- **Probe StrongBox availability** on a real mid-range Android (device-dependent; TEE-backed Keystore is the floor).
- Confirm the random DB key comes from the OS CSPRNG (`react-native-get-random-values`); confirm wipe-on-fresh-install behaviour on iOS (Keychain survives uninstall).

**Exit criteria**
- Wrap/unwrap round-trips behind a biometric gate; the wrapping key is provably non-exportable; the StrongBox/TEE tier is recorded per device class. Captured in the new `docs/threat-models/native-keystore-unlock.md`.
- Web keeps PRF **unchanged** — do **not** touch `prf.ts` / the web keystore.

### 4b — WebRTC relay + CallKit locked-device ring
**Tasks**
- `react-native-webrtc` standard `RTCPeerConnection` with `iceTransportPolicy: 'relay'` from `POST /calls/turn-credentials`; confirm a relay-only connection.
- `expo-callkit-telecom` (primary) / `react-native-callkeep` (fallback) rings a **locked** device via PushKit (iOS) / FCM high-priority (Android).

**Exit criteria**
- A locked device rings; a relay-only audio path connects.
- **Both libraries confirmed New-Architecture (Fabric) clean** for the target Expo SDK (legacy arch froze June 2025).

---

## Also in Phase 0 (non-gating)

- Scaffold `apps/mobile` (Expo prebuild/CNG, TypeScript) in the workspace; wire Metro to resolve `@argus/contracts`/`@argus/crypto` via `src` (resolver alias or `source` field) + symlink-aware resolution; produce an EAS development build on a physical iPhone.
- Extract `packages/client-core` behind the injected seams (`Fetcher`, `WebSocketImpl`, `Storage`, `Config`) and **repoint the PWA to it** to prove the seams on web first (keeps `pnpm -r typecheck && pnpm -r test` and Playwright green).

---

## Vertical-slice acceptance checklist

Build the spike as a deliberately *ugly* two-device vertical slice on **both** iOS and Android (no polished UI). The framework commitment is accepted only when it passes all of:

**Crypto & protocol**
- [ ] The exact production ciphersuite (`MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`) runs on Hermes, iOS *and* Android, via the `@noble` `CryptoProvider`.
- [ ] Secure randomness is explicit, OS-backed, and **fails closed** if unavailable (no silent `Math.random` / insecure shim).
- [ ] Web, iOS, and Android produce **identical encoded protocol output** for fixed inputs (shared test vectors).
- [ ] MLS state survives force-kill and restart.
- [ ] **A simulated crash *between computing the new MLS state and persisting it* leaves either the old state or the complete new state — never a partial epoch transition.** This means preserving the existing `keystore.ts` CAS/versioning semantics (monotonic per-conversation `version` + compare-and-swap in a single atomic transaction) across the IndexedDB→SQLite swap. *(argus already implements this on web; the risk is preserving it on the new storage engine, not building it.)*
- [ ] Duplicate, delayed, malformed, and out-of-order inputs behave correctly.
- [ ] No secret/plaintext appears in logs or crash reports.

**Auth, storage, calling** (built in their phases; listed here as the gate)
- [ ] Native passkey register + assert; **device identity separate from passkey identity**.
- [ ] Local DB key randomly generated and wrapped by a platform-backed **non-exportable** key, **biometric-gated** (`accessControl` + `WhenUnlockedThisDeviceOnly`) — decision #8; no PRF on native.
- [ ] Incoming call reported on a **terminated** app on both platforms; native answer/decline works *before* JS startup; state reconciles after JS starts.

*(Condensed from the external memo's §21 acceptance criteria, 2026-06-26.)*

---

## If the linchpin (CHECK 1) fails

Order of preference, before ever reconsidering the framework:
1. **Pin / fork the `ts-mls` provider** to accept a `@noble`-backed KEM (the injection point exists; this is the expected path).
2. **Upstream a pluggable-KEM contribution** to `ts-mls` if the interface resists injection.
3. **Native crypto module** exposing X25519 to the JS layer (last resort within RN).
4. **Only then** re-open the framework decision — and even then the fallback is **Capacitor** (the WebView has X25519 natively, so `packages/crypto` runs unmodified), *not* Flutter/native (which trade this bounded problem for an unbounded cross-implementation interop gamble). See [00](./00-overview-and-decision.md) §3.

The maintenance liability to record now: the `@noble` provider shim sits **under** the E2EE engine and must be **re-validated by crypto-reviewer on every `ts-mls` bump** (a minor release can change the provider interface or `encryptWithLabel` labels). This is the scariest recurring line for a solo dev — budget for it explicitly.
