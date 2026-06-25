-- 0047_call_relay_only — per-user relay-only call preference.
-- Stored on the users row so the existing users_tenant_isolation RLS policy
-- and argus_app table-level UPDATE grant (from 0001, role renamed in 0009)
-- cover it automatically — no new table, no new RLS policy, no new grants.
--
-- Default TRUE: all users start relay-only (privacy-first; they can opt out
-- in settings once P1-UI lands). NOT NULL; the app never coerces NULL here.
--
-- No index: this column is read per-user via the existing PK lookup only.
--
-- See docs/threat-models/voip-calling.md.

ALTER TABLE users ADD COLUMN IF NOT EXISTS call_relay_only boolean NOT NULL DEFAULT TRUE;
