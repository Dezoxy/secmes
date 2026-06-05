import { sql as dsql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';

import * as schema from './schema.js';

type Db = PostgresJsDatabase<typeof schema>;
// Drizzle's transaction callback argument type, derived so callers stay typed.
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

let pool: Sql | undefined;
let db: Db | undefined;

/** Lazily open the pool so importing this module never requires DATABASE_URL (e.g. unit tests). */
export function getDb(): { sql: Sql; db: Db } {
  if (!pool || !db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    // prepare:false — the runtime runs behind PgBouncer in transaction mode (see threat model),
    // where server-side prepared statements don't survive backend switches across pooled txns.
    pool = postgres(url, { max: 10, prepare: false });
    db = drizzle(pool, { schema });
  }
  return { sql: pool, db };
}

// Shape-validate tenant ids before they reach SQL. The HTTP tenant guard (checkpoint 14) is the
// authoritative source; this is defense-in-depth so a malformed/hostile value fails fast here
// instead of as an opaque 22P02 error inside the RLS predicate.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Branded tenant id — only producible via asTenantId(), so a raw request string can't slip in. */
export type TenantId = string & { readonly __tenantId: unique symbol };

export function asTenantId(value: string): TenantId {
  if (!UUID_RE.test(value)) throw new Error('invalid tenant id');
  return value as TenantId;
}

/**
 * Run `fn` inside a transaction scoped to a single tenant.
 *
 * Sets `app.tenant_id` transaction-locally (`set_config(..., true)`) and drops to the non-bypass
 * `secmes_app` role, so PostgreSQL RLS enforces tenant isolation. `SET LOCAL ROLE` works in BOTH
 * deployment shapes: prod connects directly as `secmes_app` (a role may SET ROLE to itself —
 * pg_has_role self-member), dev connects as the superuser and this drops it to the non-bypass
 * role. Both the var and the role reset at COMMIT/ROLLBACK, so nothing leaks across the pool.
 *
 * `tenantId` MUST come from the verified session (the request-scoped tenant guard), never from
 * raw client input — see docs/threat-models/rls-tenant-isolation.md.
 */
export async function withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tid = asTenantId(tenantId); // fail fast before opening a transaction
  return getDb().db.transaction(async (tx) => {
    await tx.execute(dsql`set local role secmes_app`);
    await tx.execute(dsql`select set_config('app.tenant_id', ${tid}, true)`);
    return fn(tx);
  });
}

export { schema };
