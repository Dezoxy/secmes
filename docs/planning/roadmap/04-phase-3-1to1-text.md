# Phase 3 — 1:1 encrypted text

> Part of the [build roadmap](README.md). Legend: `[ ]` todo · `[~]` in progress · `[x]` done · 🔒 security-gated.

**Progress:** 9/9 done.

> Goal: send and receive encrypted messages in real time.

- [x] 25. **Schema** — `conversations`, `conversation_members`, `messages` (RLS, ciphertext only) 🔒
- [x] 26. **Send API** — membership authz + Zod I/O + store ciphertext (no plaintext server-side) 🔒
- [x] 26a. **MLS Welcome delivery** — relay opaque join material so an added member can join the group 🔒
- [x] 27. **End-to-end text** — client MLS-encrypts → stored → recipient fetches → decrypts
- [x] 28. **WebSocket gateway** — authenticated connections; real-time ciphertext delivery 🔒
- [x] 29. **Redis backplane** — the realtime bus (and future throttler store) 🔒
- [x] 30. **Offline delivery** — queue + catch-up on reconnect
- [x] 31. **Delivery receipts** — sent/delivered/read end-to-end 🔒
- [x] 32. **API security** — messaging endpoints in OpenAPI; 42Crunch audit ≥ 75 (achieved 100/100) 🔒
