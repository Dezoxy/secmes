/* eslint-disable no-console -- CLI migration runner: console output is the intended UX. */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import postgres from 'postgres';

// Minimal forward-only migration runner. Connects as the OWNER (DATABASE_URL / a superuser
// locally) and applies any *.sql in ./migrations not yet recorded in schema_migrations.
// schema_migrations is the one allowed global table (no tenant_id).
const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('Set DATABASE_URL (owner connection) to run migrations.');
  process.exit(1);
}

const migrationsDir = fileURLToPath(new URL('./migrations/', import.meta.url));
const sql = postgres(url, { max: 1, onnotice: () => {} });
const LOCK_KEY = 4927; // arbitrary constant — serialize concurrent migration runners

async function run() {
  await sql`select pg_advisory_lock(${LOCK_KEY})`;
  try {
    await sql`create table if not exists schema_migrations (
      version    text primary key,
      applied_at timestamptz not null default now()
    )`;
    const applied = new Set(
      (await sql`select version from schema_migrations`).map((r) => r.version),
    );
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is build-local, not user input
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`=  ${file} (already applied)`);
        continue;
      }
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is build-local, not user input
      const ddl = readFileSync(new URL(`./migrations/${file}`, import.meta.url), 'utf8');
      await sql.begin(async (tx) => {
        await tx.unsafe(ddl).simple(); // simple protocol → multi-statement DDL in one round trip
        await tx`insert into schema_migrations (version) values (${file})`;
      });
      console.log(`+  ${file} applied`);
    }
    console.log('migrations up to date');
  } finally {
    await sql`select pg_advisory_unlock(${LOCK_KEY})`;
  }
}

run()
  .then(() => sql.end())
  .catch(async (err) => {
    // message only — never dump the full error object (avoids leaking the DSN in a prod copy)
    console.error(`migration failed: ${err instanceof Error ? err.message : String(err)}`);
    await sql.end({ timeout: 5 });
    process.exit(1);
  });
