-- 0015_db_backup_role — least-privilege role for the nightly logical backup worker (VM deploy track,
-- roadmap checkpoint 49). A standalone systemd unit runs `pg_dump` on the VM and ships an encrypted dump
-- to a private EU B2 bucket (see infra/backup/).
--
-- The problem: every tenant table is FORCE ROW LEVEL SECURITY, so a full cross-tenant dump is impossible
-- for a normal role — pg_dump sets `row_security = off` and ERRORS unless the role can bypass RLS. A backup
-- must capture ALL tenants' rows, so the backup role needs BYPASSRLS. We keep it least-privilege otherwise:
-- READ-ONLY (pg_read_all_data), NOLOGIN until provisioned, no write/DDL, not a superuser.
--
-- Why this is acceptable despite reading every tenant's data:
--   - It is the inherent power of "back up the whole database" — nothing finer can produce a restorable dump.
--   - Message CONTENT is MLS ciphertext (the server is crypto-blind); the sensitive cleartext is METADATA
--     (emails, display names, membership). The backup worker encrypts the dump CLIENT-SIDE (age, asymmetric)
--     before it leaves the VM, so B2 only ever holds ciphertext (invariant #2 — no plaintext at rest off-box).
--   - Read-only: it can SELECT but never INSERT/UPDATE/DELETE/DDL, so a compromised backup credential cannot
--     mutate or destroy data — only read it (and the dump it could produce is itself encrypted to a key it
--     does not hold; the age PRIVATE key lives only in Key Vault, fetched at RESTORE time, never on the VM).
--
-- Creating a BYPASSRLS role requires the migration to run as a SUPERUSER — it does (the owner/migration
-- connection). NOLOGIN here (no password in source); PROD grants LOGIN + a Key Vault password out-of-band
-- (see infra/backup/README.md), exactly like argus_cleanup (0013).
do $$
begin
  if not exists (select from pg_roles where rolname = 'argus_backup') then
    -- INHERIT (default) so the pg_read_all_data grant below takes effect without SET ROLE.
    create role argus_backup nologin nosuperuser bypassrls;
  end if;
end
$$;

-- pg_read_all_data (PG14+ predefined role): SELECT on ALL tables/views/sequences + USAGE on all schemas,
-- and it is DYNAMIC — future tables are covered automatically, so a new table can never be silently omitted
-- from backups. Combined with BYPASSRLS, pg_dump sees every row of every table, current and future.
grant pg_read_all_data to argus_backup;

-- Defence-in-depth: explicitly deny the ability to create new objects / write. The role has no such grants
-- to begin with (only the inherited SELECT), but make the intent unmistakable for any future reader.
-- (No INSERT/UPDATE/DELETE grant, no schema CREATE grant, no role membership beyond pg_read_all_data.)
