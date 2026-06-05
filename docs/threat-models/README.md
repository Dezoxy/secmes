# Threat models

Per the Definition of Done in `AGENTS.md`, every **security-relevant feature** gets a short threat-model note **before** coding. Use `/feature-threat-model` (Claude) or `.codex/prompts/feature-threat-model.md` (Codex) to draft one from `_TEMPLATE.md`.

## Required before their phase

| Note | Blocks | Status |
| --- | --- | --- |
| `key-directory.md` — server key-substitution / MITM on the KeyPackage directory; fingerprint/safety-number verification; key-transparency as the later upgrade | Phase 2 (device keys), Phase 3 (1:1 text) | ☐ TODO |
| `key-backup.md` — Argon2id parameters, unique CSPRNG salt, recovery semantics, forward-secrecy implications, key rotation | Phase 2 (checkpoint 21) | ☐ TODO |
| `device-lifecycle.md` — device pending→active→revoked, KeyPackage invalidate-not-delete, history readability, "new browser"/"lost phone" | Phase 2 | ☐ TODO |
| `attachments.md` — server-generated tenant-namespaced object keys, presigned-URL membership checks, blob authz outside RLS | Phase 4 | ✍️ DRAFT — ratify |
| `rls-tenant-isolation.md` — `set_config('app.tenant_id', …, true)` per-transaction, PgBouncer transaction mode, non-bypass runtime role | Phase 1 | ✍️ DRAFT — ratify |

> **MLS library choice:** see [`../mls-library-selection.md`](../mls-library-selection.md) — DRAFT recommendation is **`ts-mls`** (MIT, pure TS; CoreCrypto ruled out as GPL-3.0). `key-directory.md` + `key-backup.md` firm up once that's ratified.

Each must explicitly verify against the **six invariants** in `AGENTS.md` and state residual risk.
