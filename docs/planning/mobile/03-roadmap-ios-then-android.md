# 03 — Roadmap (iOS first, then Android)

> **Status:** planning. The phased delivery. iOS leads because the UI is cross-platform once written and iOS is both the harder platform-integration target and the original pain point. Estimates are rough solo-dev calendar time; the back half overlaps with crypto-reviewer/boundary-auditor/infra-reviewer gates per the project's review contract.

---

## Timeline at a glance

| Phase | What | Estimate |
|---|---|---|
| **0** | Foundation spike (fail-closed gate) + monorepo wiring | ~3 wks |
| **1** | Server prerequisites (additive, crypto-blind preserved) | 2–3 wks |
| **2** | Native client core: storage, transport, auth, native passkey | 5–7 wks |
| **3** | iOS UI rewrite + messaging app | 8–12 wks |
| **4** | Native VoIP on iOS (CallKit + PushKit) | 6–9 wks |
| **5** | iOS App Store submission + EAS Update channel | 2–3 wks + review |
| **6** | Android parity + Play submission | 4–6 wks + review |

Rough order-of-magnitude: a working **iOS messaging app** around the end of Phase 3; **iOS calling** at Phase 4; **Android parity** at Phase 6. Phases 1 and the non-VoIP parts of 2 can overlap once Phase 0 passes.

---

## Phase 0 — Foundation spike + monorepo wiring

Detailed in **[02 — Phase-0 spike](./02-phase-0-spike.md)**. Fail-closed: no UI until the four checks pass on real devices with crypto-reviewer sign-off.

---

## Phase 1 — Server prerequisites (2–3 wks)

**Goal:** make the crypto-blind, RLS-enforced `apps/api` speak to native clients — three additive deliverables: widen WebAuthn origin trust, add the native push-token contract + sender, and add a native refresh-token transport contract. The *only* server changes the pivot needs; no invariant is relaxed.

**Tasks**
- **Widen WebAuthn origin trust.** Keep `rpID = WEBAUTHN_RP_ID` (PWA passkeys stay valid). Widen `webauthn.service.ts` `expectedOrigin` from a single `FRONTEND_ORIGIN` to an **exact app-origin allowlist** (iOS associated-domain origin; Android `android:apk-key-hash:<base64>`) — **never a wildcard**. Serve `apple-app-site-association` + `assetlinks.json` (app signing-cert SHA-256) on the RP domain.
- **Native push-token contract + sender.** Add an APNs/FCM device-token registration shape to `@argus/contracts` (replacing the Web-Push/VAPID `SubscribePushRequest` for native). Add a `push_subscriptions`-style table via the `/db-migration` skill: `tenant_id` + `ENABLE`+`FORCE` RLS `TO argus_app` + leading `tenant_id` index + caller-owns-device check. Build the server-side push sender (none exists today) emitting **content-free** payloads: message wakes carry a **fixed generic visible alert** (`alert: "New message"`) alongside `{type:'new_message'}` — so the OS notifies even if iOS drops the background JS wake (see [04](./04-security-and-threat-model.md) §3); call wakes use `{type:'call', callId}` via PushKit / FCM-high-priority (CallKit rings, no alert needed). **No** `conversationId`, `senderId`, text, or caller identity in any payload — the fixed string carries no metadata. APNs `.p8` / FCM service-account delivered as **Key-Vault file secrets** via Managed Identity (never env), mirroring `VAPID_PRIVATE_KEY_FILE`. Never log tokens.
- **Native refresh-token transport contract.** Today the server returns only an access token in the body and sets the rotated 30-day refresh token as an **HttpOnly cookie** scoped to `/api/auth/session/refresh`, with `X-Argus-Refresh` used **only as a CSRF marker** (`session-token.controller.ts`, `webauthn.controller.ts`). A native client has no cookie jar and **cannot read an HttpOnly cookie**, so refresh is impossible as-is — sessions would die on the first rotation. Add a **native-client refresh contract**: on register/authenticate/refresh, return the rotated refresh token **in the response body** for native clients — **gated on the Phase-1 origin allowlist** (native app origin → body; `FRONTEND_ORIGIN` → HttpOnly cookie only), **never** a client-settable header (a client-claimed `X-Argus-Client: native` would let web XSS request the token in-body and defeat the HttpOnly boundary) — and accept it on `POST /auth/session/refresh` via the body (or an `Authorization`-style header) instead of the cookie, preserving rotation + reuse-detection (web keeps the HttpOnly-cookie path). Add the shape to `@argus/contracts`; pin the route posture in a controller spec; refresh `openapi.json` + 42Crunch.
- **Contract hygiene.** Add/extend controller specs pinning `@Public`-vs-guard posture + status contract; refresh `apps/api/openapi.json`; run the 42Crunch audit (target 90+). Write `docs/threat-models/native-push.md` mirroring `web-push.md`; append a T1 origin-allowlist note to `passkey-auth.md`.

**Verification:** `security-boundary-auditor` (RLS, no token logging, no IDs in payload, exact-allowlist origins, **and that in-body refresh-token delivery is gated on the verified origin — never a client-claimed header**); db-migration RLS verified; `infra-reviewer` on the Key-Vault file secret; 42Crunch 90+; controller specs green; a manual register/authenticate round-trip from a native-shaped origin verifies against the widened pin.

**Risks:** origin allowlist too loose (must be exact bundle/cert hashes); APNs/FCM become Article-30 sub-processors (ROPA deliverable); a push payload accidentally leaking IDs breaks the content-free invariant.

---

## Phase 2 — Native client core (5–7 wks)

**Goal:** the non-UI native foundation — hardware-backed keystore (biometric-wrapped random key, **no PRF** — decision #8), transport, token storage, native passkey (account auth).

**Tasks**
- **Two-tier key storage (decision #8 — hardware-wrapped, no PRF).** ROOT **wrapping** key in `react-native-keychain` — non-exportable, **mandatory biometric `accessControl`**, `accessible=WhenUnlockedThisDeviceOnly`, **never synced** (iOS Secure Enclave; Android `securityLevel: SECURE_HARDWARE` + `getSecurityLevel()` probe, TEE floor — StrongBox is a best-effort upgrade needing a native module, not a `react-native-keychain` flag) — preferred over `expo-secure-store` (which generates the key in JS memory, weaker). It wraps a **random 32-byte DB key** (OS CSPRNG) that the BLOB tier's AES-GCM seal/open consumes. BLOB tier (sealed device keys, key-package pool, group state, message log) keeps the opaque `SealedBlob` model verbatim with domain-separated AAD, persisted in `expo-sqlite`/`op-sqlite` via a `get/put/delete`-by-key adapter swapped in for `keystore.ts`'s `idb` calls — **preserving the existing CAS/versioning**. **Wipe working keys on lock/background; wipe orphaned root on fresh install** (iOS Keychain survives uninstall).
- **Transport.** Port `ws.ts` onto RN's `WebSocket` global via its injectable `WebSocketImpl` seam; replicate first-frame auth (10 s / 4408 close), subscribe-per-room, reconnect/backoff, and per-`(socket, conversation)` `deliverySeq` gap-detection faithfully. Add explicit foreground/background lifecycle handling.
- **Token storage.** Consume the native refresh-token contract from Phase 1: capture the **body-delivered** 30-day refresh token (an HttpOnly cookie is unreadable on native), store it in the OS keystore, and replay it on `POST /auth/session/refresh` per that contract (body or `Authorization`-style header, **not** the cookie). The `Fetcher` seam is already injectable; access tokens stay in memory.
- **Native passkey — account auth only, no PRF (decision #8).** Ceremonies via `react-native-passkey` / ASAuthorization (iOS) + Credential Manager (Android) emitting the FIDO2 JSON `@simplewebauthn` expects, against the widened `expectedOrigin` (Phase 1). The keystore unlock is the **hardware-wrapped random DB key** above, *not* a PRF derivation — so there is **no PRF eval/strip code on native**. Device-enrollment authority stays Ed25519 proof-of-possession + OOB safety numbers.

**Verification:** `crypto-reviewer` on the storage adapter (non-exportable biometric-gated root, mandatory `accessControl`, working-key wipe-on-background, CSPRNG for the DB key, wipe-on-fresh-install) per `native-keystore-unlock.md`; `security-boundary-auditor` on the native passkey ceremony (exact origin allowlist; no token/secret logging); **on-device end-to-end**: register a passkey, unlock the keystore, connect `/ws`, send/receive a real MLS message that the PWA can also decrypt.

**Risks:** the non-extractable-key guarantee is lost once `@noble` needs the raw key in JS — mitigate by minimizing lifetime (load on unlock, `wipe(fill 0)` on lock/background) and keeping the root key as a non-exportable OS handle; RN crash reporter (Sentry/GlitchTip) capturing key material/tokens — re-run banned-pattern checks against native code; background socket suspension breaking live delivery if lifecycle handling is wrong.

---

## Phase 3 — iOS UI rewrite + messaging app (8–12 wks) — *largest effort*

**Goal:** rewrite the presentation layer as RN components for the messaging product on iOS and ship a working internal build.

**Tasks**
- Rewrite ~11.9k lines of `.tsx` as RN primitives (`View`/`Text`/`Pressable`/`TextInput`/`Image`); keep Tailwind class strings via **NativeWind**; `lucide-react` → `lucide-react-native`; `@dicebear` SVG via `react-native-svg`; replace `apply-theme.ts` CSS-variable application with a theme context (color math in `theme.ts` reused).
- Re-wire `react-router-dom` routes to **React Navigation / Expo Router**; the 6 React Contexts (Auth/Chat/Device/Update/Toast/NavVisibility) and reducers run under RN React largely unchanged — only render output is ported; gain real native gesture nav (retire `useSwipeBack`/`useSwipeTabs`).
- Integrate native push (`expo-notifications`): the payload carries a **generic content-free *visible* alert** ("New message", no IDs/text) so the OS notifies even if the background JS wake is dropped; on open, reconnect WS → fetch ciphertext → render the real content. (Don't depend on a silent/data-only wake as the sole path — see [04](./04-security-and-threat-model.md) §3.)
- Wire the existing release-notes pipeline into a native "what's new" screen.

**Verification:** on-device iOS dev build — full passkey login, send/receive messages live, friends/groups/settings flows, push wakes + live-delivers; **shares the same conversations as the PWA** (cross-client interop). Snapshot/behavioral tests on the shared `client-core`; manual product walkthrough.

**Risks:** the UI rewrite is the biggest mechanical effort (scope creep); an Expo SDK upgrade (~3/yr) breaking a config plugin and forcing Gradle/CocoaPods/Xcode debugging — the skill area a TS-native dev is weakest in; avatar/SVG perf on long lists.

---

## Phase 4 — Native VoIP on iOS (6–9 wks) — *the pivot driver*

**Goal:** 1:1 audio calling on iOS with native CallKit ringing a locked/backgrounded phone via PushKit. Only after Phase-0 CHECK 3 (authenticated-sender decrypt) has merged.

**Tasks**
- **Native owns the call state machine; JS observes — never the reverse.** Model the call as a native (Swift/Kotlin) state machine: `IDLE → INCOMING_REPORTED → RINGING → ANSWER_REQUESTED → CONNECTING_MEDIA → ACTIVE → ENDING → ENDED`. The OS callback cannot wait for Metro to load, React to mount, or the WebSocket to reconnect — native must satisfy the call-reporting deadline *first*, **persist the pending call + native actions durably**, and expose them so the RN layer consumes them *after* startup (a `getPendingNativeActions()`-style port). React Native presents and observes this state; it is never the sole owner. *(Design sharpened per the external memo's §14.)*
- `react-native-webrtc` standard `RTCPeerConnection`, `iceTransportPolicy: 'relay'` from `POST /calls/turn-credentials`; `getUserMedia(audio)` + AVAudioSession; MLS-seal/open the inner `CallSignal` via `@argus/crypto` (uses the authenticated-sender decrypt).
- `expo-callkit-telecom` (primary; `react-native-callkeep` fallback) for CallKit; iOS PushKit VoIP push that **synchronously calls `reportNewIncomingCall` per push** (iOS 13+ mandate), then fetches the MLS-sealed `CallSignal` over the authenticated `/ws` to learn the caller (rendered from **local friend data, never from the push**) + SDP; coordinate CallKit↔WebRTC AVAudioSession.
- Wire VoIP entitlement / background modes (`voip`, `remote-notification`); server push sender emits `{type:'call', callId}` only.

**Verification:** locked iPhone rings via CallKit; two-way relay-only audio connects; signaling stays E2EE (server sees only `envelope.ciphertext`). `crypto-reviewer` (authenticated-sender path) + `security-boundary-auditor` (no caller identity in push) + `infra-reviewer` (coturn) per `voip-calling.md` §14.

**Risks:** the call stack is on transitional libs (callkeep stale / expo-callkit-telecom less proven) — likely a mid-life migration redoing PushKit parsing + RTCAudioSession coordination; CallKit↔WebRTC audio-session coordination is the fiddliest native surface (failures are Swift/ObjC stack traces); PushKit needs Apple review justification.

---

## Phase 5 — iOS App Store submission + EAS Update (2–3 wks + review)

**Goal:** ship to the App Store with export-compliance and a signed OTA path.

**Tasks**
- EAS Build/Submit from Linux (no local Mac needed for release; Mac only for Simulator debugging); Apple Developer account (USD 99/yr).
- `ITSAppUsesNonExemptEncryption=YES` (E2EE/custom crypto, non-exempt); file the annual BIS self-classification (due Feb 1 for prior-year builds). Add `NSMicrophoneUsageDescription`, privacy nutrition label + policy, **in-app account deletion** (required), and a **block/report** mechanism for UGC (required even for E2EE).
- **OTA (EAS Update) governance — treat it as privileged remote code deployment, not a convenience.** A JS OTA update can silently change crypto/auth/protocol behavior, so it is a production root of trust. Solo-dev policy: **OTA is disabled for any crypto, auth, protocol, or `@argus/crypto`/`client-core` change** — those ship *only* via a store release with the same review as native code; OTA is permitted **only for pure UI / non-security fixes**. Every OTA update is **signed** (EAS end-to-end code signing) with the signing key held outside the dev laptop; the embedded bundle stays a safe fallback; native/JS runtime versions cannot mismatch; and a **forced-minimum-version kill switch** exists for emergency vulnerabilities. This replaces the web SRI/CDI-1 control as a new signed code-delivery trust path. *(Hardened per the external memo's §15, scaled for solo: its two-person-approval control is replaced by the "crypto code never ships via OTA" rule, which a single dev can actually enforce.)*
- TestFlight beta before public release.

**Verification:** passes App Review (lean on genuine native features — push, CallKit, biometrics, secure storage — to clear Guideline 4.2 minimum-functionality); export-compliance filed; a signed OTA update lands on a TestFlight build.

**Risks:** Guideline 4.2 (low for RN since it's genuinely native); store review latency the PWA never had; EAS paid-tier recurring cost; the OTA channel must be integrity-pinned.

---

## Phase 6 — Android parity + Play submission (4–6 wks + review)

**Goal:** bring the now-proven RN app to Android. The UI is already cross-platform; the differences are platform integrations.

**Tasks**
- Android integrations: ConnectionService / `androidx.core:core-telecom` + full-screen-intent for incoming calls; FCM high-priority data messages for **both** message-wake and VoIP-class wake (Android has no PushKit); foreground service for active calls; Credential Manager passkey (account auth, no PRF); `securityLevel: SECURE_HARDWARE` + `getSecurityLevel()` hardware-backing probe for the root wrapping key.
- `assetlinks.json` (signing-cert SHA-256) already served from Phase 1; verify the `android:apk-key-hash` origin is in the server allowlist.
- Google Play Developer account (USD 25 one-time); Play export-compliance declaration; Play Integrity **not** required (attestation deferred).
- EAS Build/Submit to Play; closed-track beta.

**Verification:** on-device Android — passkey login, messaging live-delivery, FCM message-wake, locked-device ring via full-screen-intent, two-way relay audio; cross-platform interop with iOS + PWA in the same MLS groups; Play closed-track beta passes review.

**Risks:** StrongBox is device-dependent (probe at runtime); Android Doze throttling the socket (rely on FCM high-priority wake); a long tail of low-end devices for Hermes MLS perf.

---

## Platform-specific checklists

### iOS
- CallKit + AVAudioSession coordination with `react-native-webrtc` (fiddliest surface; expo-callkit-telecom primary, callkeep fallback).
- PushKit VoIP push — the only API that legitimately triggers CallKit on a locked device; `reportNewIncomingCall` synchronously per push; payload content-free `{type:'call', callId}`.
- Associated Domains entitlement (`webcredentials:<rpID>`) + `apple-app-site-association` so platform passkeys verify against the widened `expectedOrigin`.
- Export compliance: `ITSAppUsesNonExemptEncryption=YES` + annual BIS self-classification.
- ~~iOS 18+ platform-passkey PRF requires iCloud Keychain~~ — **N/A** (decision #8): native doesn't use PRF; this iCloud-Keychain/platform-passkey coupling is exactly what the hardware-wrap model avoids.
- Secure Enclave-backed root key (`WhenUnlockedThisDeviceOnly`, never synced); Keychain persists across uninstall → wipe-on-fresh-install decision.
- VoIP + remote-notification background modes; `NSMicrophoneUsageDescription`.
- EAS Build/Submit ships iOS from Linux — no local Mac required for release.

### Android
- ConnectionService / `core-telecom` + full-screen-intent for the ring.
- FCM high-priority data for message-wake **and** call-wake (no PushKit equivalent).
- Foreground service for active calls.
- Credential Manager passkey ceremonies (account auth; no PRF on native).
- `assetlinks.json` (signing-cert SHA-256); `android:apk-key-hash` origin in the server allowlist.
- Hardware-backed root key via `react-native-keychain` `securityLevel: SECURE_HARDWARE` + a `getSecurityLevel()` runtime probe (TEE floor). `react-native-keychain` exposes **no** StrongBox toggle (`setIsStrongBoxBacked` is an Android-platform API, not a library option) — explicit StrongBox selection needs a small native keystore module; treat it as a best-effort upgrade (device-dependent, ~Pixel 3+/S9+).
- Play Developer account (USD 25); Play export-compliance declaration; Play Integrity deferred.
- Confirm `react-native-webrtc` + CallKit lib are New-Architecture (Fabric) clean for the target SDK.
