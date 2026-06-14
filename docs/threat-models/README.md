# Threat models

Per the Definition of Done in `AGENTS.md`, every **security-relevant feature** gets a short threat-model note **before** coding. Use `/feature-threat-model` (Claude) or `.codex/prompts/feature-threat-model.md` (Codex) to draft one from `_TEMPLATE.md`.

## Required before their phase

These foundational notes gated their phases before coding — all are now **ratified** (the phases shipped). The full corpus (one note per security-relevant feature) lives alongside this index.

| Note | Blocks | Status |
| --- | --- | --- |
| `key-directory.md` — server key-substitution / MITM on the KeyPackage directory; fingerprint/safety-number verification; key-transparency as the later upgrade | Phase 2 (device keys), Phase 3 (1:1 text) | ✅ RATIFIED |
| `key-backup.md` — Argon2id parameters, unique CSPRNG salt, recovery semantics, forward-secrecy implications, key rotation | Phase 2 (checkpoint 21) | ✅ RATIFIED |
| `device-keystore.md` / `device-provisioning.md` / `multi-device-enrollment.md` — device pending→active→revoked, KeyPackage invalidate-not-delete, history readability, "new browser"/"lost phone" (the planned `device-lifecycle.md` was split across these as the work landed) | Phase 2 | ✅ RATIFIED |
| `attachments.md` — server-generated tenant-namespaced object keys, presigned-URL membership checks, blob authz outside RLS | Phase 4 | ✅ RATIFIED |
| `rls-tenant-isolation.md` — `set_config('app.tenant_id', …, true)` per-transaction, PgBouncer transaction mode, non-bypass runtime role | Phase 1 | ✅ RATIFIED |
| `metadata-exposure.md` — what the crypto-blind server can infer (social graph, timing, device topology, presence); the accepted metadata trade vs. content E2EE | GA (external privacy claims) | ✅ RATIFIED |

> **MLS library choice:** see [`../mls-library-selection.md`](../mls-library-selection.md) — **`ts-mls`** (MIT, pure TS; CoreCrypto ruled out as GPL-3.0) was chosen and is shipped in `packages/crypto`.

Each must explicitly verify against the **six invariants** in `AGENTS.md` and state residual risk.

> **Cross-cloud experiment:** [`cross-cloud-secret-fetch.md`](cross-cloud-secret-fetch.md) covers the parallel AWS EC2 + Azure Arc + Azure Key Vault stack (`infra/aws/`) — how a non-Azure host reads Azure secrets with no static credential, and the experiment-scoped residual risks (KV firewall by IP, deferred GDPR records).
