-- Migration 0030: argus_id identity spine
--
-- Adds a stable, immutable, system-generated argus_id to every user row.
-- Format: argus-<16 unambiguous lowercase chars>-<animal>
-- Example: argus-k7m2q9x4f3n8p1w5-otter
--
-- Design notes:
--   - DB DEFAULT gen_argus_id() is a VOLATILE function (re-evaluated per row), so:
--       (a) all existing rows are backfilled with distinct CSPRNG values in one ALTER,
--       (b) raw INSERT statements in specs that omit argus_id still work without modification.
--   - The app always supplies its own CSPRNG value (generateArgusId() in argus-id.ts);
--     the DB default is a safety net, not the primary generator.
--   - Immutability is enforced by a BEFORE UPDATE trigger — Postgres does not support
--     revoking a single column from a table-level GRANT (granted to argus_app in 0001).

-- pgcrypto is needed for gen_random_bytes() (CSPRNG). Idempotent.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- gen_argus_id(): produce one argus-<16 chars>-<animal> string using gen_random_bytes (CSPRNG).
--
-- Alphabet (31 unambiguous lowercase chars, no 0/1/i/l/o):
--   abcdefghjkmnpqrstuvwxyz23456789
--
-- Character selection: rejection sampling — accept byte_val if < 248 (= 31 × 8),
-- discard 248-255 (8 values, ~3.1% rejection, < 2 extra bytes expected per character).
--
-- Animal array: 64 entries (2^6) — byte_val % 64 is exactly uniform over a 256-byte range,
-- no rejection sampling needed. Animals are lowercase to match the canonical format.
CREATE OR REPLACE FUNCTION gen_argus_id() RETURNS text AS $$
DECLARE
  alphabet  text    := 'abcdefghjkmnpqrstuvwxyz23456789';
  animals   text[]  := ARRAY[
    'otter','badger','fox','wolf','bear','deer','elk','moose',
    'bison','boar','hare','rabbit','mole','hedgehog','squirrel','chipmunk',
    'beaver','raccoon','skunk','possum','bobcat','cougar','leopard','jaguar',
    'cheetah','lion','tiger','lynx','puma','coyote','jackal','hyena',
    'meerkat','mongoose','lemur','gibbon','baboon','gorilla','orangutan','chimp',
    'sloth','armadillo','anteater','aardvark','pangolin','tapir','capybara','wombat',
    'wallaby','koala','quokka','platypus','echidna','panda','elephant','rhino',
    'hippo','giraffe','zebra','antelope','gazelle','impala','buffalo','yak'
  ];
  id        text    := '';
  raw       bytea;
  byte_val  int;
  i         int     := 0;
  pool_size int     := 64;  -- raw bytes fetched per round (room for ~3% rejection)
BEGIN
  -- Build the 16-character random segment
  WHILE char_length(id) < 16 LOOP
    raw := gen_random_bytes(pool_size);
    i := 0;
    WHILE i < pool_size AND char_length(id) < 16 LOOP
      byte_val := get_byte(raw, i);
      -- Accept only if byte_val < 248 (= 31 * 8) to ensure uniform distribution
      IF byte_val < 248 THEN
        id := id || substr(alphabet, (byte_val % 31) + 1, 1);
      END IF;
      i := i + 1;
    END LOOP;
  END LOOP;

  RETURN 'argus-' || id || '-' || animals[1 + (get_byte(gen_random_bytes(1), 0) % 64)];
END;
$$ LANGUAGE plpgsql VOLATILE;

-- Add argus_id column with the volatile DB default.
-- VOLATILE default causes Postgres to rewrite the table and evaluate gen_argus_id() once
-- per existing row, producing distinct backfilled values with no manual loop required.
ALTER TABLE users
  ADD COLUMN argus_id text DEFAULT gen_argus_id();

-- Backfill should be complete via the DEFAULT above; this is a belt-and-suspenders guard.
UPDATE users SET argus_id = gen_argus_id() WHERE argus_id IS NULL;

-- Now lock it down.
ALTER TABLE users ALTER COLUMN argus_id SET NOT NULL;

-- Global uniqueness (not scoped to tenant — argus_id is a cross-tenant stable identity).
CREATE UNIQUE INDEX users_argus_id_idx ON users (argus_id);

-- Immutability trigger: reject any UPDATE that tries to change argus_id.
-- ON CONFLICT DO UPDATE is safe: the SET clause in provisionFromToken / acceptInvite
-- never includes argus_id, so NEW.argus_id = OLD.argus_id and the trigger passes silently.
CREATE OR REPLACE FUNCTION users_argus_id_immutable_fn() RETURNS trigger AS $$
BEGIN
  IF NEW.argus_id IS DISTINCT FROM OLD.argus_id THEN
    RAISE EXCEPTION 'argus_id is immutable (trigger: users_argus_id_immutable)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_argus_id_immutable
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION users_argus_id_immutable_fn();

-- Grant SELECT on the new column to the runtime role (table-level SELECT already granted
-- in 0001, but documenting the intent here for auditability).
-- No separate GRANT needed: argus_app already has SELECT on users (0001 table-level grant).
