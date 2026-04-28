-- ─────────────────────────────────────────────────────────────────────────────
-- 04-rebuild-tenant-unique-constraints.sql
--
-- Rebuilds three legacy single-column UNIQUE constraints to include tenant_id.
-- Pre-this-migration, the schema had:
--
--   markets:    UNIQUE(state_code)
--   lists:      UNIQUE(list_name)
--   properties: UNIQUE(street, city, state_code, zip_code)
--
-- These were authored before multi-tenancy. The moment a second tenant exists,
-- they corrupt: tenant B's "California" market silently UPDATEs tenant A's
-- row via ON CONFLICT; tenant B's import of "123 Main St, Indy IN 46218"
-- merges into tenant A's property. Both tenants see each other's data.
--
-- This migration replaces them with composite uniques that include tenant_id:
--
--   markets:    UNIQUE(tenant_id, state_code)
--   lists:      UNIQUE(tenant_id, list_name)
--   properties: UNIQUE(tenant_id, street, city, state_code, zip_code)
--
-- Run order: AFTER 02-add-tenant-id-to-all-tables.sql.
--
-- ── Why split into PART A and PART B ─────────────────────────────────────────
-- Postgres forbids `CREATE INDEX CONCURRENTLY` inside a transaction. So:
--
--   PART A (transactional): markets + lists are small (tens to thousands of
--                           rows). Drop+re-add inline. Locks each table for
--                           ~ms. Whole part runs in one txn so failure is
--                           clean rollback.
--   PART B (NON-transactional): properties is large (50k+ rows on prod and
--                           growing). Use CREATE UNIQUE INDEX CONCURRENTLY
--                           so writes aren't blocked during the index build,
--                           then swap the constraint via DROP+ADD USING INDEX
--                           inside its own txn.
--
-- See migration-readme.md for the runbook (one psql for PART A, one for B).
--
-- ── Pre-flight check ────────────────────────────────────────────────────────
-- BEFORE RUNNING: verify zero existing duplicates that would block the new
-- composite uniques. The PART A transaction includes the check; if it finds
-- duplicates, the whole transaction rolls back and the operator must clean
-- up before proceeding.
-- ─────────────────────────────────────────────────────────────────────────────

-- ═════════════════════════════════════════════════════════════════════════════
-- PART A — transactional rebuild for markets + lists
-- ═════════════════════════════════════════════════════════════════════════════
BEGIN;

-- ── Pre-flight: bail loudly on existing duplicates ──────────────────────────
DO $$
DECLARE n_mkt_dup INTEGER; n_list_dup INTEGER;
BEGIN
  SELECT COUNT(*) INTO n_mkt_dup FROM (
    SELECT tenant_id, state_code FROM markets
     GROUP BY tenant_id, state_code HAVING COUNT(*) > 1
  ) d;
  IF n_mkt_dup > 0 THEN
    RAISE EXCEPTION 'PRE-FLIGHT FAIL: % duplicate (tenant_id, state_code) groups exist in markets — clean up first', n_mkt_dup;
  END IF;

  SELECT COUNT(*) INTO n_list_dup FROM (
    SELECT tenant_id, list_name FROM lists
     GROUP BY tenant_id, list_name HAVING COUNT(*) > 1
  ) d;
  IF n_list_dup > 0 THEN
    RAISE EXCEPTION 'PRE-FLIGHT FAIL: % duplicate (tenant_id, list_name) groups exist in lists — clean up first', n_list_dup;
  END IF;
END
$$;

-- ── markets ──────────────────────────────────────────────────────────────────
-- Drop the old single-column key (auto-named by Postgres as
-- markets_state_code_key when the inline UNIQUE was declared).
ALTER TABLE markets DROP CONSTRAINT IF EXISTS markets_state_code_key;
-- Add the composite. IF NOT EXISTS is unavailable for ADD CONSTRAINT, so use
-- a DO-block guard for re-runnability.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'markets_tenant_state_unique') THEN
    ALTER TABLE markets ADD CONSTRAINT markets_tenant_state_unique UNIQUE (tenant_id, state_code);
  END IF;
END
$$;

-- ── lists ────────────────────────────────────────────────────────────────────
ALTER TABLE lists DROP CONSTRAINT IF EXISTS lists_list_name_key;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lists_tenant_listname_unique') THEN
    ALTER TABLE lists ADD CONSTRAINT lists_tenant_listname_unique UNIQUE (tenant_id, list_name);
  END IF;
END
$$;

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════════
-- PART B — properties: non-transactional, CONCURRENTLY
-- ═════════════════════════════════════════════════════════════════════════════
-- Run each statement separately (psql line by line is fine; do NOT wrap in
-- BEGIN/COMMIT). Each CREATE INDEX CONCURRENTLY blocks writes only on its
-- own row-by-row ShareUpdateExclusiveLock — far less disruptive than a full
-- table lock.

-- ── Pre-flight: count duplicates that would block the new constraint ────────
-- Run this manually first; abort if non-zero:
--
--   SELECT COUNT(*) FROM (
--     SELECT tenant_id, street, city, state_code, zip_code
--       FROM properties
--      GROUP BY 1, 2, 3, 4, 5
--     HAVING COUNT(*) > 1
--   ) d;
--
-- If this returns > 0, run the cleanup query in 04-cleanup.sql before
-- continuing. (Cleanup script not included in this PR — that's a separate
-- ops task that needs operator review of which row wins per group.)

-- ── Build the new composite unique index, no table lock ─────────────────────
-- May take 30+ minutes on a 50M-row properties table; safe to run in business
-- hours because it does NOT block reads or writes. Re-runnable via IF NOT
-- EXISTS — if a prior CONCURRENTLY left an INVALID index behind, drop it
-- first: DROP INDEX CONCURRENTLY IF EXISTS properties_tenant_addr_unique;
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS properties_tenant_addr_unique
  ON properties (tenant_id, street, city, state_code, zip_code);

-- Verify the index ended in VALID state (CONCURRENTLY can leave INVALID
-- indexes if a constraint violation is encountered mid-build):
--
--   SELECT indexrelid::regclass, indisvalid
--     FROM pg_index
--    WHERE indexrelid::regclass::text = 'properties_tenant_addr_unique';
--
-- If indisvalid = false: DROP INDEX CONCURRENTLY ... and re-run after
-- cleaning up the violating rows.

-- ── Swap the constraint atomically (this DOES need a brief table lock) ──────
-- Wraps the constraint swap in a single small transaction. The new constraint
-- is BACKED BY the index we just built (USING INDEX), so no second build.
BEGIN;
  -- Drop the old auto-named constraint. (If your install has a different
  -- name, find it via:
  --   SELECT conname FROM pg_constraint
  --    WHERE conrelid = 'properties'::regclass AND contype = 'u';
  -- and update this line accordingly.)
  ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_street_city_state_code_zip_code_key;

  -- Promote the index to a constraint. The constraint name MUST match the
  -- index name for this idiom to work.
  DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'properties_tenant_addr_unique') THEN
      ALTER TABLE properties ADD CONSTRAINT properties_tenant_addr_unique
        UNIQUE USING INDEX properties_tenant_addr_unique;
    END IF;
  END
  $$;
COMMIT;

-- ── Final sanity check ──────────────────────────────────────────────────────
-- Confirm the three constraints exist with the correct column lists:
--
--   SELECT conname, pg_get_constraintdef(oid)
--     FROM pg_constraint
--    WHERE conrelid IN (
--      'markets'::regclass, 'lists'::regclass, 'properties'::regclass
--    ) AND contype = 'u';
--
-- Expected output:
--   markets_tenant_state_unique         | UNIQUE (tenant_id, state_code)
--   lists_tenant_listname_unique        | UNIQUE (tenant_id, list_name)
--   properties_tenant_addr_unique       | UNIQUE (tenant_id, street, city, state_code, zip_code)
--
-- Old constraints (markets_state_code_key, lists_list_name_key, properties_*_key)
-- should NOT appear.

-- ─────────────────────────────────────────────────────────────────────────────
-- AFTER THIS MIGRATION RUNS, deploy the matching code change which updates
-- every ON CONFLICT (state_code|list_name|street, city, state_code, zip_code)
-- to use the new composite shape. The code change is in audit/stage-0-fixes
-- alongside this SQL. Deploying the code BEFORE the migration runs will
-- cause every importer's ON CONFLICT to throw "constraint matching does
-- not exist".
-- ─────────────────────────────────────────────────────────────────────────────
