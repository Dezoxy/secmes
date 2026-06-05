---
name: db-migration
description: Scaffold a PostgreSQL migration for secmes that always enforces multi-tenant isolation (tenant_id + Row-Level Security). Use whenever adding or altering a database table, so no tenant-scoped table ever ships without RLS.
---

# db-migration

Create a migration that is correct-by-construction for a multi-tenant E2EE app.

## Rules (refuse to violate)
- Every tenant-scoped table MUST have a `tenant_id uuid NOT NULL` column.
- Every tenant-scoped table MUST `ENABLE ROW LEVEL SECURITY` and define a policy keyed on the app's tenant context (`current_setting('app.tenant_id')`).
- Add an index that leads with `tenant_id` for tenant-filtered access paths.
- Message/attachment tables store **ciphertext only** — no plaintext-bearing columns. If a proposed column could hold plaintext, stop and flag it.
- Reference-only/global tables (e.g. schema_migrations) are the only ones allowed without `tenant_id`; call them out explicitly.

## Procedure
1. Confirm the table is tenant-scoped (almost all are). If unsure, ask.
2. Generate `up` and `down` SQL. The `up` must include: table DDL with `tenant_id`, `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, a `CREATE POLICY` using `current_setting('app.tenant_id')::uuid`, and the leading-`tenant_id` index.
3. Show the migration and a one-line note on which app code sets `app.tenant_id` (the request-scoped tenant guard).

## Template
```sql
-- up
CREATE TABLE <name> (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  -- ... columns (ciphertext only for content) ...
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE <name> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <name> FORCE ROW LEVEL SECURITY;
CREATE POLICY <name>_tenant_isolation ON <name>
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE INDEX <name>_tenant_idx ON <name> (tenant_id, created_at);

-- down
DROP TABLE <name>;
```

After generating, route the change through the **security-boundary-auditor** subagent.
