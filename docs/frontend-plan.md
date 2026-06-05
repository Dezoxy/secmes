# Frontend plan (`apps/web`)

The client is the security boundary in an E2EE app — it does the crypto; the server only forwards ciphertext. So the frontend is a **static SPA/PWA**, not SSR.

## Stack

- **React 19 + Vite + TypeScript**, **Tailwind v4**, **shadcn/ui** (add components as needed), **vite-plugin-pwa**.
- Shared types/validation from **`@secmes/contracts`** (Zod) — same package the API uses.
- Crypto from **`packages/crypto`** (the `ts-mls` wrapper) — runs client-side; private keys live in **IndexedDB**.
- Realtime over a **WebSocket** to the gateway; offline via the service worker + a local outbox.
- **Why not Next.js:** SSR/RSC renders on the server, which is the wrong model when the server must be crypto-blind and the app must be an installable static PWA. (The downloaded design shipped as Next.js; we ported the *design*, not the framework.)

## Design language

The dark `#1a1a24` / `#12121a` surfaces + purple (`purple-400→600`) accents + rounded-2xl + the mount/transition animations from the ported landing screen become the secmes system. Consolidate into Tailwind theme tokens as the component set grows.

## Screens (mapped to the roadmap)

| Screen | Status | Roadmap |
| --- | --- | --- |
| Landing / auth (split-screen) | ✅ ported | done |
| OIDC redirect + callback | ✅ stub wired (this change) | Phase 1 (real token exchange) |
| Authenticated shell + routing | next | Phase 1 |
| Conversation list | — | Phase 3 |
| Chat view (composer, messages, delivery states) | — | Phase 3 |
| Encrypted image attachments | — | Phase 4 |
| Key backup / recovery flow | — | Phase 2 (iOS-eviction safety net) |
| Device fingerprint / key verification | — | Phase 5 (the `key-directory.md` mitigation) |
| Settings / device management | — | Phase 6 |

## Auth flow (Zitadel OIDC, Authorization Code + PKCE)

1. "Sign in" / provider buttons → `lib/auth.ts#startLogin()` builds the Zitadel authorize URL with **PKCE** (code_verifier in `sessionStorage`) and redirects. *(Implemented as a stub now; gated on `VITE_OIDC_*` env.)*
2. Zitadel authenticates → redirects back to `/auth/callback?code=…`.
3. **Phase 1:** the callback hands the `code` to `apps/api`, which does the **back-channel token exchange** (client secret stays server-side) and sets a session; the SPA gets identity + the tenant. **No password ever reaches our server.**

## Build order

Auth shell + routing (now) → crypto foundation (Phase 2) → conversation UI (Phase 3). The UI deliberately can't do anything real until `packages/crypto` + the key layer exist — which is why the roadmap's **`16a` headless 2-device test harness** is the oracle for everything in 17–38.

## Config

`apps/web/.env.example` lists `VITE_OIDC_ISSUER`, `VITE_OIDC_CLIENT_ID`, `VITE_OIDC_REDIRECT_URI`. Copy to `.env.local` (gitignored) with your Zitadel values once it's deployed.
