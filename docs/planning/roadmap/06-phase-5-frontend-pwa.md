# Phase 5 — Frontend PWA

> Part of the [build roadmap](README.md). Legend: `[ ]` todo · `[~]` in progress · `[x]` done · 🔒 security-gated.

**Progress:** 7/9 done (2 in progress).

> Goal: installable on every platform, no app store.

- [~] 39. **Installable PWA** — manifest + service worker + offline shell; Lighthouse PWA pass — _residual: iOS installed-PWA proof (S1, USER)._
- [x] 40. **Web Push** — content-free VAPID notifications; iOS installed-PWA path verified
- [~] 41. **Core UX** — conversation list, composer, image, delivery states — _live loop complete (41a); the seed/demo path is retained alongside it._
- [x] 42. **Key-loss UX** — fresh-start message + new-registration-code flow (no backup/recovery by design) — **revised (2026-06)**
- [x] 41a. **Live client message loop** — chat wired to the real server (device provisioning → start 1:1 → join → live send/fetch/receive + sealed message-history persistence), replacing the seed/loopback
- [x] 43. **Code-delivery hardening** — CSP + SRI + service-worker pinning; published bundle hash 🔒
- [x] 44. **A11y + responsive** — WCAG AA pass; mobile/desktop layouts
- [x] 44a. **Frontend maintainability + PWA/UX hardening pass** — the canonical 14-step `apps/web` upgrade + F1–F6 follow-ups (design tokens, UI primitives, route-owned shell, settings split, pseudonymous-profile boundary, typed API client, versioned persistence, chat-hook decomposition, safe async/error states, PWA caching safety, telemetry boundary, a11y/Lighthouse/bundle/update-prompt polish). Canonical detail in `docs/planning/frontend-plan.md`.
- [x] 44b. **Generated pseudonymous identity** — local DiceBear avatars (no external requests) + random `<Adjective> <Animal>` handles, extending the #44a profile boundary. Custom avatar **photo upload is deferred** (the button shows a "coming soon" notice; the generated avatar is the only avatar for now). Display names stay editable but are hardened by a shared Latin-only, 2–32-char validator that rejects zero-width / RTL-override / homoglyph / emoji / Zalgo spoofing — see `docs/threat-models/profile-edit.md` §7–§8.
