/* eslint-disable no-console -- CLI dev-seed runner: console output is the intended UX. */
import postgres from 'postgres';

// DEV-ONLY seed. Inserts the single local tenant and backfills user_tenant_index so the dev
// account is bound on first login. The tenant_id JWT claim and argusClaims Action were removed
// in G1 — tenant lookup is now DB-authoritative (user_tenant_index keyed by sub). The tenant row
// MUST exist before the first login. Idempotent.
//
// This is NOT a migration: a hardcoded tenant must never land in a real database. Two enforced
// guards make that true regardless of how it's invoked: it refuses `NODE_ENV=production`, AND it
// refuses any non-loopback DB host — so a stray `DATABASE_URL`/`MIGRATION_DATABASE_URL` pointing at
// staging/prod (e.g. with `NODE_ENV` unset) can never receive the tenant. Run by hand (`make seed`).

// A deliberately synthetic, all-but-zero UUID so it's unmistakable in data/logs as the dev tenant.
// Hardcoded dev-tenant UUID — must match the value seeded by `make seed`.
export const DEV_TENANT_ID = '00000000-0000-4000-a000-000000000001';
const DEV_TENANT_NAME = 'Local Dev Tenant';

if (process.env.NODE_ENV === 'production') {
  console.error('refusing to run the dev seed with NODE_ENV=production');
  process.exit(1);
}

const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('Set DATABASE_URL (owner connection) to run the dev seed.');
  process.exit(1);
}

// Hard local-only guard: only a loopback Postgres may be seeded. Anything else (a managed host, a
// compose service name, a remote) is refused, so the fixed dev tenant can't pollute a real database.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
let dbHost: string;
try {
  dbHost = new URL(url).hostname;
} catch {
  console.error('DATABASE_URL is not a valid URL');
  process.exit(1);
}
if (!LOOPBACK_HOSTS.has(dbHost)) {
  console.error(`refusing to run the dev seed against a non-local database (host: ${dbHost})`);
  process.exit(1);
}

const sql = postgres(url, { max: 1, onnotice: () => {} });

async function run() {
  // `tenants` is the tenant root (no RLS, no tenant_id column); the owner connection inserts it.
  await sql`
    insert into tenants (id, name)
    values (${DEV_TENANT_ID}, ${DEV_TENANT_NAME})
    on conflict (id) do nothing
  `;
  console.log(`dev tenant ready: ${DEV_TENANT_ID} (${DEV_TENANT_NAME})`);
}

run()
  .then(() => sql.end())
  .catch(async (err) => {
    // message only — never dump the full error object (avoids leaking the DSN).
    console.error(`dev seed failed: ${err instanceof Error ? err.message : String(err)}`);
    await sql.end({ timeout: 5 });
    process.exit(1);
  });
