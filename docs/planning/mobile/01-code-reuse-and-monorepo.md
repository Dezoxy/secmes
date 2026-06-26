# 01 — Code reuse & monorepo wiring

> **Status:** planning. What ports verbatim, what needs adaptation, what is thrown away — and how `apps/mobile` consumes the shared workspace packages. The thesis: **share the expensive, security-critical half; rewrite only the cheap presentation half.**

---

## 1. The reuse ledger

Measured from the audit. Line counts are approximate.

| Layer | Lines | Verdict |
|---|---|---|
| `@argus/contracts` (Zod schemas) | 943 | **Verbatim.** Only dep is `zod`; pure JS; runs on Hermes unchanged. |
| `@argus/crypto` logic (`ts-mls` wrapper, device-proof, codec) | ~1.5k | **Verbatim after the Phase-0 crypto shim** (X25519 + the `crypto.subtle` reroute). |
| `apps/web/src/lib/*` business logic | ~9.7k | **Mostly portable** behind injected seams → extract to `packages/client-core`. |
| `apps/web/src/**/*.tsx` presentation + Tailwind | ~11.9k | **Rewritten** as RN primitives (NativeWind keeps the class strings). |
| Service worker / Web Push / PWA-install / iOS-WKWebView hacks | — | **Deleted** (replaced by native; this is the "backfire" code). |

Net: ~45–55% of the TypeScript ports — and it's the half that is hard, security-critical, and shared with the server.

## 2. Ports verbatim (zero rewrite)

- **`@argus/contracts`** — the single source of truth for client↔server wire shapes. Drives the RN API client and form validation exactly as it does the PWA. Pin a single `zod` major across the monorepo (workspace dedupe) so types and runtime parsing never diverge.
- **`@argus/crypto`** — after the Phase-0 shim, the MLS engine (class shapes, call sequencing, the op-queue mutex, safety-number/fingerprint logic, epoch handling), `device-proof.ts` (Ed25519 over `@noble`), and `device-codec.ts` (JSON+base64) all run on Hermes.
- **Pure `lib/` helpers** — `messaging.ts`, `conversations.ts`, `auth.ts` (in-memory token holder), `base64.ts`, `message-envelope.ts`, `locks.ts`, `mls.ts`, plus pure feature hooks (`useChatState`, `useMessageSending`, `useConversationBackfill`, `useLiveConversations`, `peer-naming`, `receipts`, settings logic). These are React hooks with **no DOM access** — they run under React Native's React unchanged.

## 3. Needs adaptation (logic kept, host swapped)

| Item | Effort | What changes |
|---|---|---|
| `lib/keystore.ts` (~54 KB, IndexedDB via `idb`, 16 call sites) | **High** | The sealing/unlock/pool/group-state logic is pure; swap the `idb` persistence for `expo-sqlite`/`op-sqlite` (or MMKV) via a `get/put/delete`-by-key adapter — rows are opaque AES-GCM, so the adapter is small. Security-critical; move its tests with it. |
| WebAuthn ceremonies (`lib/prf.ts` is **web-only**) | **Medium** | `@simplewebauthn/browser` → `react-native-passkey` / ASAuthorization (iOS) + Credential Manager (Android), **account-auth only**. Per decision #8 the native keystore uses a hardware-wrapped random key, so `prf.ts` is **not** ported to native (it stays web-only) — this removes the old riskiest adaptation (cross-platform PRF parity). The high-effort item is now the sealed-state persistence swap (the `keystore.ts` row). |
| `lib/ws.ts` (~480 lines) | **Medium** | Already has an injectable `WebSocketImpl` seam and accepts an explicit `url`. RN has a global `WebSocket`. Add explicit foreground/background lifecycle handling (mobile OSes suspend sockets). |
| `lib/api-client.ts` + `lib/api.ts` (~60 endpoints) | **Medium** | `fetch`/`Headers` exist on RN, but the **HttpOnly refresh-cookie** model does not (no shared cookie jar). Move to explicit refresh-token storage in the OS keystore + `X-Argus-Refresh` header. The `Fetcher` is already injectable. |
| 6 React Contexts + provider tree | **Medium** | State shapes/reducers reusable; render output (JSX, error boundaries) ported. |
| `react-router-dom` v7 | **Medium** | → React Navigation / Expo Router. Gains real native gesture nav (retires `useSwipeBack`/`useSwipeTabs`). |
| `features/ui/apply-theme.ts` | **Low** | Writes CSS custom properties; native has no CSS vars → a theme context. The color math in `theme.ts` is reused. |
| `import.meta.env` (Vite) reads | **Low but pervasive** | Re-source via `expo-constants`/EAS env behind a single injected `Config` object. |

## 4. Thrown away (deleted, not ported)

The entire browser platform shim — and this is the literal "backfire":
- `sw.ts` (Workbox service worker, SRI integrity route, push handler), `lib/push.ts`, `lib/sw-integrity.ts`, `features/pwa/*`.
- Web Push / VAPID subscription machinery (`PushReconciler.tsx` and the `pushsubscriptionchange` churn).
- `beforeinstallprompt` / add-to-Home-Screen install flow + manifest install path.
- iOS-WKWebView workarounds: `useResumeRepaint`, `window.matchMedia('(display-mode: standalone)')`, `env(safe-area-inset-*)` hacks, `maximum-scale` viewport.

Offline/precache is automatic (the app bundle). The subresource-integrity control (CDI-1) becomes **app-store code-signing**. The in-app update flow becomes **EAS Update (OTA)** for JS-only changes, fed by the existing release-notes pipeline.

## 5. The `packages/client-core` extraction

The move that makes web + native genuinely share logic:

1. Create **`packages/client-core`** and move the ~9.7k lines of UI-agnostic `lib/` logic into it, behind small **injected seams**:
   - `Fetcher` (already a `typeof fetch` param in `api.ts`)
   - `WebSocketImpl` (already injectable in `ws.ts`)
   - `Storage` interface (already abstracted as `BrowserStorage` in `persistence.ts` — swap the one `browserLocalStorage()` factory for an AsyncStorage/MMKV adapter)
   - `Config` object (replaces inline `import.meta.env` reads)
2. **Repoint the PWA to import from `packages/client-core` first** — prove the seams work on web before RN consumes them. This is a Phase-0 task and keeps the PWA green throughout.
3. RN's `apps/mobile` then imports `@argus/contracts`, `@argus/crypto`, and `packages/client-core` exactly as `apps/web` does — injecting native implementations of the seams.

## 6. PWA fate: kept, not retired

**Keep the PWA as a thin web client over the same shared core.** Rationale:
- The whole reuse argument *depends* on web + native sharing `@argus/contracts`, `@argus/crypto`, and `packages/client-core`. Freezing the PWA would fork the shared logic; deleting it loses the no-install client and the validation harness.
- The Phase-0 crypto provider is **capability-detected**: the PWA keeps WebCrypto `crypto.subtle` sealing (no regression — it retains its non-extractable unlock key), while Hermes uses the `@noble` fallback. The shared `@argus/crypto` runs on both *without* downgrading the web keystore.
- Feature development now **leads on native**; the PWA tracks via the shared core. Only the PWA's platform shim (service worker, Web Push, install, safe-area hacks) is replaced by native — the rest is shared.

## 7. Monorepo & build wiring

Keep the existing pnpm-workspace monorepo. Add **`apps/mobile`** as an Expo (prebuild/CNG) TypeScript app — `ios/` and `android/` native projects are *generated*, not hand-maintained.

Two Metro-specific items:
1. **Workspace package resolution.** Metro does not run the workspace `tsc` build, and packages publish to gitignored `./dist`. Either add a prebuild step (`pnpm --filter @argus/crypto --filter @argus/contracts --filter @argus/client-core build`) before Metro, **or** point Metro at each package's `src/index.ts` via a resolver alias / a `source`/`react-native` package.json field. Enable Metro's symlink-aware resolution for pnpm.
2. **Env seam.** The `Config` object sources values from `expo-constants`/EAS env, so the shared lib has no Vite coupling.

`apps/api` and `infra/*` are **unchanged** by the client pivot, except for the three additive server deliverables in [03](./03-roadmap-ios-then-android.md) Phase 1 (origin allowlist, native push-token contract, native refresh-token transport). One language, one contracts source, one crypto engine across `api` + `web` + `mobile`.

**Boundary discipline (enforced by lint, not convention).** Add an ESLint `no-restricted-imports` / `no-restricted-globals` rule so the shared packages (`@argus/contracts`, `@argus/crypto`, `packages/client-core`) **cannot** import React Native, Expo, browser DOM (`window`/`document`/IndexedDB), Node (`Buffer`/streams/`process`), native SQLite/APNs/FCM/CallKit libs, or any UI code — and cannot reach `Math.random` or an unapproved RNG. The shared core stays platform-neutral *by construction*; a violating import fails CI. This is what makes the same packages safe to run on Node tests, the web bundler, and Hermes. *(Cross-reviewed against an external architecture memo, 2026-06-26.)*

## 8. Native gaps (net-new, not ports)

These have no existing implementation and must be built fresh:
- **Native push** — APNs (iOS) + FCM (Android) device tokens, replacing Web Push/VAPID. The server has **no push sender today**.
- **Native passkey (account auth)** — platform authenticators emitting FIDO2 JSON. The native keystore unlock is hardware-wrapped (decision #8), **not** PRF-derived — no PRF on native.
- **Hardware-backed secure storage** — Keychain/Secure Enclave + Keystore/StrongBox for the root unlock key; SQLite/MMKV for the sealed blobs.
- **Native call UI + media** — `react-native-webrtc` + CallKit/ConnectionService + VoIP push. *There is no WebRTC/VoIP client code in `apps/web` at all*, so VoIP is **greenfield native** — which is an argument for building it native-first, not a porting cost.
- **Background lifecycle** — explicit foreground/background socket handling + push-triggered wakeups (mobile OSes suspend sockets aggressively).
- **Avatar SVG** — `@dicebear` SVG strings → `react-native-svg`.

## 9. Crypto engine boundary — `GroupCryptoEngine`

Put `ts-mls` behind an **Argus-owned engine interface**, so the app depends on *our* contract — never on `ts-mls` object shapes scattered across the codebase. This sits **above** `ts-mls`, and is distinct from the Phase-0 `@noble` `CryptoProvider`, which sits **below** it. Two boundaries, two jobs: the provider makes the engine *run on Hermes*; the engine interface makes the engine *replaceable*.

```ts
export interface GroupCryptoEngine {
  createDeviceIdentity(): Promise<DeviceIdentity>;
  generateKeyPackage(): Promise<KeyPackageBundle>;
  createGroup(input: CreateGroupInput): Promise<GroupSnapshot>;
  joinGroup(input: JoinGroupInput): Promise<GroupSnapshot>;
  processIncoming(input: ProcessIncomingInput): Promise<ProcessIncomingResult>;
  createApplicationMessage(input: CreateApplicationMessageInput): Promise<CreateApplicationMessageResult>;
}
```

Implementations behind the one interface:
- **`TsMlsEngine`** — the initial and current implementation (`ts-mls` + `@noble`).
- **`NativeRustMlsEngine`** — a future hardened option (a Rust MLS core via JSI) **if** Phase-0 CHECK 2 perf or an independent crypto review rejects JS crypto.
- **`TestVectorEngine`** — a deterministic implementation driven by RFC 9420 / interop fixtures.

**Why it matters:** it converts our two scariest failure modes — "JS MLS too slow on low-end Android" and "security review rejects JS crypto" — from *re-do-the-app* into *swap-one-package*. UI, sync, storage, and contracts are untouched. This is the documented escape hatch *behind* the framework choice (and the reason RN+Expo's bet is reversible at the crypto layer, not just the UI layer). *(Folded in from the external memo's §9 — its single strongest contribution.)*
