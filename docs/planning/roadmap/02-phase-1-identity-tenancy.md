# Phase 1 — Identity & tenancy

> Part of the [build roadmap](README.md). Legend: `[ ]` todo · `[~]` in progress · `[x]` done · 🔒 security-gated.

**Progress:** 7/8 done (1 in progress).

> Goal: real login, real tenant isolation enforced by the database.

- [~] 9. **Zitadel deployed** (Docker Compose on the VM) with its DB — admin console reachable — _local stand-in done; VM prod stack built; awaits arming + provisioning._
- [x] 10. ~~**Managed Postgres** (Flexible Server) + private endpoint~~ 🔒 — **SUPERSEDED / N/A** (the VM self-hosts Postgres under FORCE-RLS; see #11/#12).
- [x] 11. **Drizzle wired** with a per-transaction `app.tenant_id` session var
- [x] 12. **`tenants` + `users` with RLS** — cross-tenant read provably blocked by a test 🔒
- [x] 13. **OIDC login** via Zitadel works; API validates JWTs
- [x] 14. **Tenant guard** sets `app.tenant_id` from the verified token only (never client input) 🔒
- [x] 15. **`/me` + user directory** (per tenant) — Zod-validated, documented in the spec
- [x] 16. **Audit events** table + login/logout auditing (IDs/metadata only, no secrets) 🔒
