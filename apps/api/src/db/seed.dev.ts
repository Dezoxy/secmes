/* eslint-disable no-console -- CLI dev-seed runner: console output is the intended UX. */
import postgres from 'postgres';

// DEV-ONLY seed. Inserts the single local tenant that the local Zitadel instance maps every
// login into (an org-scoped Action asserts `tenant_id` = DEV_TENANT_ID into the access token;
// see docs/threat-models/auth-tenant-context.md §9). The API casts that verified claim to
// `tenants.id`, and JIT provisioning (auth-tenant-context.md §7) creates the user under it — so
// this row MUST exist before the first login. Idempotent.
//
// This is NOT a migration: a hardcoded tenant must never land in a real database. It is gated on
// a non-production NODE_ENV and run by hand against the local Docker stack.

// A deliberately synthetic, all-but-zero UUID so it's unmistakable in data/logs as the dev tenant.
// Keep in lockstep with the Zitadel bootstrap (the Action emits this exact value).
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
