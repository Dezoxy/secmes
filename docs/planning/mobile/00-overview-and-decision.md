# 00 — Overview & decision

> **Status:** planning. The executive summary: what we're building, why React Native + Expo over the alternatives, the source-level evidence, the locked decisions, and the open questions only the owner can close.

---

## 1. Goal

Pivot argus from a PWA to **native iOS + Android apps as the primary client**, because:

1. **Locked-phone calling is impossible in a PWA.** The VoIP feature needs to ring a phone that is asleep/locked. Only **CallKit (iOS) + ConnectionService (Android)**, woken by **VoIP push (PushKit / FCM high-priority)**, can do this. A PWA fundamentally cannot. This is the #1 driver.
2. **The iOS PWA "backfire."** Unreliable Web Push (install-only, `userVisibleOnly`, subscriptions silently dropped on every service-worker update), no background execution, install friction, evictable storage, and a pile of iOS-WKWebView CSS/JS workarounds (safe-area, repaint hacks).

The **server changes only additively** — three Phase-1 deliverables: the WebAuthn origin allowlist, the native push-token contract, and a native refresh-token transport contract (RN can't read the HttpOnly refresh cookie). `apps/api` stays crypto-blind, RLS-enforced, transport-agnostic; the pivot is otherwise entirely client-side.

## 2. Decision: React Native + Expo

Scored for *this* project — solo TypeScript dev, pure-TS MLS crypto, passkey-only auth, WebRTC calling, EU/GDPR.

| Framework | Score | Code reuse | Crypto | Locked-phone calls | Solo maintainability |
|---|---|---|---|---|---|
| **React Native + Expo** | **8/10** | ~45–55% (the expensive, security-critical half) | `ts-mls` runs in-language after a bounded shim | **Yes** (CallKit/PushKit) | One language everywhere |
| Capacitor | 6.5/10 | ~90–95% verbatim | runs **unmodified** in the WebView | **No** (WebView mutes mic on background) | Best for messaging, inverts for calling |
| Flutter | 3/10 | ~10–15% (only the server you keep anyway) | **cannot** run `ts-mls`; different MLS impl | Yes (but on a foreign crypto stack) | Two-language tax forever |
| Native Swift+Kotlin | 3/10 | ~0% | **cannot** run `ts-mls`; Rust FFI | Yes (capability ceiling) | Worst — Swift+Kotlin+Rust |

**Chosen: React Native + Expo** (prebuild/CNG + config plugins, iterated via EAS development builds on a physical device — **not** Expo Go, which can't load the WebRTC/CallKit native modules).

### Why it wins

- **One language.** TypeScript across `apps/api`, `apps/web`, and `apps/mobile`. The dev stays in their wheelhouse; the crypto engine stays auditable by the one person who owns it.
- **Reuses the crown jewels in-language.** `@argus/contracts` (Zod) ports verbatim; `@argus/crypto` (the `ts-mls` + `@noble` MLS engine) runs on Hermes after the Phase-0 shim — the *same* engine the web clients use, so there is **zero cross-implementation interop risk**.
- **The only option that delivers the pivot driver.** `react-native-webrtc` + `expo-callkit-telecom` (or `react-native-callkeep`) give real CallKit/ConnectionService + VoIP push.
- **Mac-free release path.** EAS Build compiles and ships iOS from Linux; a local Mac is only needed for Simulator debugging. A paid Apple Developer account (USD 99/yr) is the one hard requirement.

## 3. Why the alternatives lose

### Flutter (3/10) — the intuitive pick that's actually the trap
The "Google-backed, best-practice" reputation does not survive the fact that **Dart cannot run `ts-mls`**. Two options, both bad:
- **Adopt a different MLS implementation** (the Dart `openmls` package is Rust-OpenMLS via FFI — single unverified maintainer, thinly adopted). Your web fleet speaks `ts-mls`; mobile would speak Rust-OpenMLS; they must interoperate **byte-perfectly inside the same encrypted group**. MLS cross-implementation interop is documented ecosystem-wide as experimental/config-limited. If it doesn't interop, Flutter is dead on arrival unless you *also* re-engine the web client. **Unbounded risk a solo dev cannot own.**
- **Embed a JS engine** (`flutter_js`) to run `ts-mls` — still hits the *same* X25519/`crypto.subtle` problem as React Native, *plus* wraps your most security-critical code in a Dart↔JS FFI bridge. Strictly more moving parts than just writing the app in RN.

Plus: `@argus/contracts` (Zod) can't be reused — every wire schema re-encoded in Dart and kept in lockstep by hand, forever. Every concrete Flutter capability (`flutter_webrtc`, `flutter_callkit_incoming`, `flutter_secure_storage`) is matched one-for-one by an RN equivalent that *also* keeps your crypto in-language — so Flutter's wins are non-unique while its costs are unique.

### Native Swift + Kotlin (3/10) — the capability ceiling, unsustainable solo
Best CallKit/Secure-Enclave/passkey integration, and the cleanest non-extractable key handles. But **~0% TS reuse**, two full codebases, a hand-duplicated contract layer in two languages (every server change is a 3-place edit), and a forced re-platforming of the MLS core onto Rust (mls-rs/OpenMLS via UniFFI) with the same cross-impl interop risk as Flutter. A TS-native solo dev would need Swift + Kotlin + Rust + SwiftUI + Compose + two build systems. RN already reaches ~95% of the native capability via maintained config plugins.

### Capacitor (6.5/10) — the legitimate fast bridge we are *not* taking
Genuinely the cheapest path, and its under-appreciated win is real: the OS **WebView has full SubtleCrypto including X25519** (WebKit since iOS 18.4 / Chromium 133+), so `packages/crypto` runs **unmodified** and ~90–95% of the TS ships verbatim — **no crypto spike on the critical path**. It fixes every messaging backfire (real APNs/FCM push, store install, hardware key storage, biometric unlock).

It is **not** the destination because the named pivot driver — a reliable backgrounded/locked-phone two-way audio call — is exactly what it cannot do:
- WKWebView transitions `microphoneCaptureState` to **muted** shortly after the app backgrounds (iOS 15+). Incoming audio plays; your mic stops transmitting — precisely the state a CallKit call lives in.
- The only WebView→native libwebrtc bridge (`cordova-plugin-iosrtc`) is **~5 years stale and seeking maintainers**.
- CallKit gives you the ring screen, but the WebView gives you no dependable call media without writing the very native code you adopted Capacitor to avoid.

**When Capacitor would have been right:** if foreground-ring V1 calling were acceptable and shipping the messaging fixes fast were the priority. The owner has chosen native locked-phone calling as a first-class goal, so RN + Expo is the call. (Capacitor remains the documented fallback if the Phase-0 crypto shim proves intractable — see [02](./02-phase-0-spike.md) §"If the linchpin fails".)

## 4. The decisive technical fact (verified at source)

`packages/crypto` is pure TypeScript (`ts-mls` + `@noble/*`, **no WASM**) and algorithm-portable. But it is **runtime-blocked on React Native** by one thing:

- `ts-mls@1.6.2` composes HPKE via `@hpke/core`'s `DhkemX25519HkdfSha256`. Its X25519 class `extends NativeAlgorithm`, which calls `globalThis.crypto.subtle.generateKey('X25519')` / `deriveBits`.
- **Both** the `default` *and* the `noble` providers route through this — `ts-mls`' `noble/makeDhKem.js` is literally `export * from "../default/makeDhKem.js"`.
- Hermes has **no `crypto.subtle`**, and **no RN polyfill** (including `react-native-quick-crypto`) implements **X25519** in `subtle`. AES-GCM/SHA-256/HMAC are covered by polyfills; X25519 is not.
- X25519 HPKE underlies `createGroup` / `joinGroup` / `addMember` / Welcome-sealing — so **nothing in the messaging engine works on RN until this is fixed.**

**The fix** (Phase 0, crypto-reviewer-gated): give `ts-mls` a custom `CryptoProvider` whose **X25519 KEM** is backed by `@noble/curves` (the piece Hermes can't do via `crypto.subtle` at all), and make the `seal.ts` / `index.ts` / `turn-credential.ts` primitives **capability-detected**: use WebCrypto `crypto.subtle` where it exists, fall back to `@noble` only on Hermes. **The PWA keeps its WebCrypto sealing** — including the non-extractable `importUnlockKey(…, extractable:false)` key the shipped web threat models rely on — so there is **no web regression**. A blanket swap to `@noble` *everywhere* would downgrade the web keystore to a raw JS `Uint8Array` (decision #8's hardware wrap only compensates for that on native), so the provider is **conditional, not global**.

Load-bearing source references (verified this audit):
- `ts-mls@1.6.2 .../crypto/implementation/noble/makeDhKem.js` → `export * from "../default/makeDhKem.js"`
- `.../implementation/default/makeDhKem.js` → `new DhkemX25519HkdfSha256()` from `@hpke/core`
- `@hpke/core .../kems/dhkemPrimitives/x25519.js` → `class X25519 extends NativeAlgorithm`
- `@hpke/common .../algorithm.js` → `loadSubtleCrypto()` → `globalThis.crypto.subtle`
- `ts-mls .../crypto/getCiphersuiteImpl.js` → `provider` is the clean injection point (the shim is viable)
- `crypto.subtle` sites to reroute: `packages/crypto/src/index.ts:148`, `packages/crypto/src/seal.ts` (AES-GCM import/encrypt/decrypt), `packages/crypto/src/turn-credential.ts` (HMAC)

## 5. Locked decisions

| # | Decision | Why |
|---|---|---|
| 1 | **React Native + Expo** (prebuild/CNG + config plugins; EAS dev builds; not Expo Go) | Mono-TypeScript, in-language crypto reuse, only path to native calling. |
| 2 | **Phase-0 spike is a fail-closed gate** before any UI | The X25519 reroute (CHECK 1) is the sole make-or-break linchpin; prove it on a real device first. (PRF parity was the second gate — retired by decision #8.) |
| 3 | **Keep `rpID` = existing `WEBAUTHN_RP_ID`** | PWA-registered passkeys stay valid on native — no re-enrollment. |
| 4 | **PWA is kept as a shared-logic web client**, deprioritized but not retired | The reuse strategy depends on web + native sharing the same core; the PWA is also the validation harness. See [01](./01-code-reuse-and-monorepo.md) §6. |
| 5 | **iOS first, then Android** | The UI is cross-platform once written; iOS is the harder platform-integration target (CallKit/PushKit/App Review) and the original pain point. |
| 6 | **Attestation (App Attest / Play Integrity) deferred** | The trust model doesn't depend on client integrity (crypto-blind server, server-verified authz, human-verified safety numbers). See [04](./04-security-and-threat-model.md) §6. |
| 7 | **`ts-mls` sits behind an Argus-owned `GroupCryptoEngine` interface** | The engine is swappable for a native/Rust core without touching UI — the reversibility escape hatch behind the framework bet. See [01](./01-code-reuse-and-monorepo.md) §9. |
| 8 | **Native at-rest keystore = hardware-wrapped random DB key (biometric-gated), NOT PRF** | `security-architect` (2026-06-26): PRF on web is a *local biometric-gated key derivation*, not server authz; a non-exportable Keychain/StrongBox key gated by `accessControl` + `WhenUnlockedThisDeviceOnly` gives the same user-presence property and *recovers* the non-extractability the `@noble` reroute otherwise forfeits. PRF stays **web-only**. Retires Phase-0 CHECK 4a. See [04](./04-security-and-threat-model.md) §2. |
| 9 | **Native refresh preserves HttpOnly; web-origin is always cookie-only** | `security-architect` (2026-06-26): native HTTP stacks have a cookie jar (`NSURLSession`/OkHttp) that resends the HttpOnly cookie without the app reading it — so native refreshes (incl. background locked-call wakes) without exposing the token to JS. Web-origin + same-origin iOS stay **cookie-only** (origin can't distinguish iOS-native from web, so web XSS can't elect body delivery). Fallback only: a sender-constrained (DPoP-style) body token on a **background-signable** non-exportable key, gated to a distinct native origin / unspoofable signal. Keeps attestation deferred. See [03](./03-roadmap-ios-then-android.md) Phase 1 + [04](./04-security-and-threat-model.md) §6. |

## 6. Open questions (owner decisions)

0. **Keystore-unlock model (native) — RESOLVED 2026-06-26 → hardware-wrapped random DB key (locked decision #8).** `security-architect` recommended hybrid (C): a random DB key wrapped by a non-exportable Secure-Enclave/StrongBox key, **mandatorily** gated by biometric `accessControl` + `WhenUnlockedThisDeviceOnly`; drop PRF from the native at-rest path; keep PRF on web. Rationale: it recovers the non-extractability the `@noble` reroute forfeits, removes **zero** authz properties (device enrollment is Ed25519 proof-of-possession + OOB safety numbers, PRF-independent), and avoids the iOS PRF coupling (iCloud Keychain + platform-passkey-only). **Retires CHECK 4a** — Phase 0 drops from two framework-invalidating gates to one. New deliverable: `docs/threat-models/native-keystore-unlock.md` (written before native keystore code lands).
1. **Wipe-on-fresh-install:** iOS Keychain survives app uninstall under the same bundle ID. Recommend wiping a detected fresh install's orphaned root key to avoid identity-confusion. **Decision needed before beta.**
2. ~~**PRF-parity fallback.**~~ **MOOT** — superseded by decision #8 (native drops PRF entirely), so cross-platform PRF parity is no longer required on native.
3. **EU data-residency for push:** APNs/FCM become Article-30 sub-processors with limited EU-residency control. Accept and document in the ROPA, or investigate constraints. **GDPR doc deliverable.**
4. **EAS paid tier vs self-hosted macOS CI runner:** confirm the recurring EAS cost is acceptable. **Cost decision.**
5. **`expo-secure-store` vs `react-native-keychain` for the root key — RESOLVED → `react-native-keychain`.** Decision #8 makes the non-exportable keychain key the root by design; `expo-secure-store` is only a fallback on Android devices lacking StrongBox (TEE-backed Keystore is the floor).
6. **`ts-mls` independent audit before any strong public security claim** — a launch gate, not a mobile-specific item (see [04](./04-security-and-threat-model.md) §8.5). Decide when/how to fund the review.

## 7. How we'll know it worked

- A locked iPhone **rings via CallKit** on an incoming call; two-way relay-only audio connects; the server sees only `envelope.ciphertext`.
- A native client and the PWA **share the same MLS conversations** (cross-client interop proven) — the same engine, the same wire format.
- Native push **wakes the app** to live-deliver messages, with **content-free** payloads (no IDs, no text).
- All six security invariants hold; the only server changes are additive (origin allowlist, native push-token contract, native refresh-token transport).
