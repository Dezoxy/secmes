Create a PostgreSQL migration for argus that is correct-by-construction for multi-tenant isolation.

Rules (refuse to violate):
- Every tenant-scoped table has `tenant_id uuid NOT NULL`.
- Enable AND force Row-Level Security, with a policy keyed on `current_setting('app.tenant_id')::uuid`.
- Add an index leading with `tenant_id`.
- Content columns store ciphertext only — no plaintext-bearing columns.
- Only truly global tables (e.g. schema_migrations) may omit `tenant_id`; call them out.

Produce `up` and `down` SQL using this shape, then note which app code sets `app.tenant_id` (the request-scoped tenant guard):

```sql
-- up
CREATE TABLE <name> (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL,
  -- columns (ciphertext only for content)
  created_at timestamptz NOT NULL DEFAULT now()
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

Then apply the "Server boundary" review checklist from AGENTS.md.
