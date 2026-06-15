# Threat model: RLS tenant isolation (Postgres)

> Status: **DRAFT for ratification.** Blocks Phase 1 (checkpoints 11–16). Pairs with the `/db-migration` skill, which already emits `ENABLE`+`FORCE ROW LEVEL SECURITY`, a `WITH CHECK` policy on `current_setting('app.tenant_id')`, and a leading `tenant_id` index. This note covers the parts the table DDL **cannot** guarantee on its own.

## 1. Feature & data flow

Every tenant-scoped query runs inside a transaction that first sets `app.tenant_id` from the **verified JWT** (never client input). Postgres RLS policies then filter every row by `tenant_id = current_setting('app.tenant_id')::uuid`. The app is the only thing that sets the var; the DB is the thing that enforces it.

## 2. Assets & trust boundaries

- **Asset:** one tenant's rows (messages ciphertext, devices, key packages, conversations, audit).
- **Boundary:** tenant↔tenant inside a single shared Postgres; and app-code-bug↔database (RLS is the backstop when app code forgets a `WHERE tenant_id`).

## 3. Threats (STRIDE-lite) & the four ways RLS silently fails

1. **Connection pooling leaks the session var (Information disclosure — highest risk).**
   A session-level `SET app.tenant_id` survives on a pooled connection and is then reused by the **next** tenant's request → cross-tenant read with no error. Azure Database for PostgreSQL Flexible Server's built-in **PgBouncer in transaction mode** makes session-level `SET` either invisible or pool-poisoning.
   → **Mitigation (mandatory):** set the var **transaction-locally** only:
   ```sql
   BEGIN;
   SELECT set_config('app.tenant_id', $1, true);  -- true = local to this transaction
   -- ... queries ...
   COMMIT;
   ```
   Forbid plain `SET app.tenant_id` (session scope) anywhere. With Drizzle/Kysely, wrap every tenant-scoped unit of work in a transaction that calls `set_config(..., true)` first. Run the pooler in **transaction mode** and document it.

2. **App connects as an RLS-exempt role (Elevation).**
   `FORCE RLS` (already in the skill) is bypassed by any role that is the table **owner**, a **superuser**, or has **`BYPASSRLS`**. Local dev currently connects as the all-powerful `argus` superuser → RLS is silently inert.
   → **Mitigation (mandatory):** runtime connects as a dedicated **`argus_app` role: `NOSUPERUSER NOBYPASSRLS`, owns no tables**, granted only `SELECT/INSERT/UPDATE/DELETE` on app tables. **Migrations** run as the owner role; **the app never does.** Add this role to `compose.yaml` (local) and to the Phase-1 Postgres provisioning.

3. **`worker` / `realtime` touch data with no per-request token (Spoofing/EoP).**
   The API tenant guard is request-scoped; background GC / KeyPackage jobs and the WS gateway have no JWT.
   → **Rule:** `realtime` sets `app.tenant_id` from the authenticated **WS session** per query; `worker` iterates **tenant-by-tenant**, setting the var for each, always under the non-bypass `argus_app` role. A GC job that connects as owner would read/delete across every tenant.

4. **Tenant context set from client input (Spoofing).**
   → `app.tenant_id` is derived **only** from claims in the verified token; never from a header, body, or query param.

## 4. Invariant check

Upholds invariant #3 (RLS on every tenant table, no cross-tenant reads). No tension with the others.

## 5. Decision & mitigations

- Transaction-local `set_config(..., true)`; pooler in transaction mode; ban session `SET`.
- `argus_app` (`NOSUPERUSER NOBYPASSRLS`) for runtime; owner role only for migrations.
- worker/realtime context rules above.
- **Tests (gate Phase 1):** (a) an **interleaved two-tenant bleed test** — two transactions on pooled connections, assert tenant A never sees tenant B; (b) a test that the app role cannot `SET ROLE` to owner or disable RLS; (c) a cross-tenant `JOIN` returns zero rows.
- Add an AGENTS.md procedure: "all tenant DB access goes through the transaction helper that sets `app.tenant_id` locally."

## 6. Residual risk

A developer using a raw connection outside the transaction helper bypasses the per-tx var. Mitigated by: the helper being the only sanctioned DB entry point, the non-bypass role (so even a raw query is RLS-filtered, and with no tenant var set `current_setting('app.tenant_id')` raises rather than returning rows — fail-closed loudly, not silently empty), and a Semgrep rule flagging direct `pool.query` outside the helper. Accept for beta.
