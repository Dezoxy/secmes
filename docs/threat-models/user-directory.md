# Threat model: tenant user directory (`GET /users`)

> Status: **DRAFT for ratification.** Covers the directory half of roadmap checkpoint 15. Builds on `auth-tenant-context.md` (verified tenant) and `rls-tenant-isolation.md` (DB scoping).

## 1. Feature & data flow

An authenticated request lists the **active** users of the **caller's own tenant** — `id`, `email`, `display_name` (metadata only; no content, no keys). Deactivated/suspended members are excluded. The query runs inside `withTenant(verifiedTenantId)` so RLS scopes rows to the tenant; `limit` (1–100, default 50) is Zod-validated at the boundary and caps result size. Tenant comes from the verified token, never the request.

## 2. Assets & trust boundaries

- **Asset:** tenant-member PII — primarily member email addresses.
- **Boundaries:** tenant↔tenant (one tenant must never see another's members — RLS), and member↔member *inside* a tenant (any authenticated member can see the member list — a deliberate product choice for a team-messaging directory, like Slack's).

## 3. Threats (STRIDE-lite)

1. **Information disclosure — cross-tenant member read.** → `withTenant` + RLS `USING` policy; the query carries an explicit `tenant_id` predicate too (defense-in-depth). A token can only ever list its own tenant.
2. **Information disclosure — intra-tenant email exposure.** Any member can enumerate all member emails. → **Intended** for a collaborative workspace (you message people in your org). Flagged, not blocked; a future per-tenant admin toggle could restrict visibility if a buyer needs it.
3. **DoS — unbounded result set.** → `limit` capped at 100 by the Zod schema, served by the `(tenant_id, email)` index (no sort/scan). Today it's a **bounded top-N** with a silent cap; add keyset (cursor) pagination + a truncation signal before large tenants.
4. **Spoofing — tenant from client input.** → tenant is the verified claim only; `limit` is the sole client input and is strictly validated/coerced.

## 4. Invariant check

- **#3 RLS:** the directory reads only within the tenant's RLS context.
- **#1/#6 crypto-blind / no admin content:** metadata only — no message content or keys.
- **#2 no secret logging:** nothing sensitive logged; the validation pipe never echoes raw input. No tension.

## 5. Decision & mitigations

- `GET /users` is authenticated (global guard, not `@Public`), RLS-scoped via `withTenant`, bounded by a Zod-validated `limit`.
- **Reviewer:** `security-boundary-auditor`. **Tests:** tenant-scoped listing (no cross-tenant leak), ordering, `limit` bound; the `ZodValidationPipe` rejects out-of-range/non-numeric.

## 6. Residual risk

- **Intra-tenant email enumeration** by any member — accepted for a team-messaging product; revisit with a per-tenant directory-visibility setting if a regulated buyer requires it.
- **No cursor pagination yet** — a bounded top-N only; fine for beta-scale tenants, add keyset pagination before large tenants.
