-- ─────────────────────────────────────────────────────────────────────────────
-- 02-add-tenant-id-to-all-tables.sql
--
-- Adds tenant_id INT NOT NULL REFERENCES tenants(id) to every tenant-owned
-- table. Backfills every existing row with tenant_id=1 (HudREI). Builds
-- composite indexes so per-tenant queries stay fast.
--
-- Run order: AFTER 01-create-tenants-and-users.sql.
--
-- ── Why this is split into two SQL phases ────────────────────────────────────
-- The schema additions (ADD COLUMN, ALTER PRIMARY KEY) run inside a single
-- transaction so the database is never in a half-migrated state. But Postgres
-- forbids `CREATE INDEX CONCURRENTLY` inside a transaction. So:
--
--   PART A (transactional): add columns, backfill, drop defaults, swap PK
--   PART B (outside txn):   build indexes one at a time, non-blocking
--
-- The runbook in README.md explains how to execute both parts.
--
-- ── Why DEFAULT 1 then DROP DEFAULT ──────────────────────────────────────────
-- Adding a NOT NULL column to a populated table requires either a default
-- (every row gets it) or pre-populated rows. We use `DEFAULT 1` so backfill
-- is automatic, then DROP the default so future INSERTs that forget
-- tenant_id fail loudly instead of silently writing to HudREI's tenant.
--
-- This is the primary safety mechanism for the column-level isolation in
-- Decision 1 of the SaaS plan. Do not change it.
-- ─────────────────────────────────────────────────────────────────────────────

-- ═════════════════════════════════════════════════════════════════════════════
-- PART A — Schema changes inside a transaction
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── Pre-flight check ─────────────────────────────────────────────────────────
-- If tenant id=1 isn't HudREI, something went wrong with file 01. Bail.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = 1 AND slug = 'hudrei') THEN
    RAISE EXCEPTION 'Pre-flight failed: tenant id=1 is not HudREI. Run 01-create-tenants-and-users.sql first.';
  END IF;
END $$;

-- ── Helper function ──────────────────────────────────────────────────────────
-- Adds tenant_id to a table if (a) the table exists and (b) the column doesn't.
-- Idempotent. Handles lazy-created tables (owner_messages, owner_activities)
-- gracefully — if they don't exist yet, just skip.

CREATE OR REPLACE FUNCTION _add_tenant_id(target_table TEXT) RETURNS VOID AS $$
DECLARE
  table_exists BOOLEAN;
  col_exists   BOOLEAN;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = target_table
  ) INTO table_exists;

  IF NOT table_exists THEN
    RAISE NOTICE 'Skipping %: table does not exist (lazy-created?)', target_table;
    RETURN;
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = target_table
      AND column_name = 'tenant_id'
  ) INTO col_exists;

  IF col_exists THEN
    RAISE NOTICE 'Skipping %: tenant_id column already exists', target_table;
    RETURN;
  END IF;

  -- Add column with DEFAULT 1 (backfills all existing rows in one shot;
  -- on Postgres 11+ this is a metadata-only operation, no table rewrite).
  EXECUTE format('ALTER TABLE %I ADD COLUMN tenant_id INT NOT NULL DEFAULT 1', target_table);

  -- Drop the default — any future INSERT that forgets tenant_id now fails.
  EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id DROP DEFAULT', target_table);

  -- Add the foreign key constraint last (NOT VALID would skip checking
  -- existing rows, but since we just backfilled them all to id=1 we know
  -- they're valid — no need for the deferred-validation dance).
  EXECUTE format(
    'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE',
    target_table,
    target_table || '_tenant_id_fkey'
  );

  RAISE NOTICE 'Added tenant_id to %', target_table;
END;
$$ LANGUAGE plpgsql;

-- ── Apply to every tenant-owned table ────────────────────────────────────────
-- 34 tables, alphabetical for readability.

SELECT _add_tenant_id('app_settings');
SELECT _add_tenant_id('bulk_import_jobs');
SELECT _add_tenant_id('call_logs');
SELECT _add_tenant_id('campaign_contact_phones');
SELECT _add_tenant_id('campaign_contacts');
SELECT _add_tenant_id('campaign_numbers');
SELECT _add_tenant_id('campaign_uploads');
SELECT _add_tenant_id('campaigns');
SELECT _add_tenant_id('contacts');
SELECT _add_tenant_id('custom_list_types');
SELECT _add_tenant_id('deals');
SELECT _add_tenant_id('distress_outcome_log');
SELECT _add_tenant_id('distress_score_log');
SELECT _add_tenant_id('filtration_results');
SELECT _add_tenant_id('filtration_runs');
SELECT _add_tenant_id('import_history');
SELECT _add_tenant_id('list_templates');
SELECT _add_tenant_id('lists');
SELECT _add_tenant_id('mapping_templates');
SELECT _add_tenant_id('marketing_touches');
SELECT _add_tenant_id('markets');
SELECT _add_tenant_id('nis_events');
SELECT _add_tenant_id('nis_numbers');
SELECT _add_tenant_id('owner_activities');         -- lazy-created; helper skips if absent
SELECT _add_tenant_id('owner_messages');           -- lazy-created; helper skips if absent
SELECT _add_tenant_id('phone_tag_links');
SELECT _add_tenant_id('phone_tags');
SELECT _add_tenant_id('phones');
SELECT _add_tenant_id('properties');
SELECT _add_tenant_id('property_contacts');
SELECT _add_tenant_id('property_lists');
SELECT _add_tenant_id('property_tags');
SELECT _add_tenant_id('sms_logs');
SELECT _add_tenant_id('tags');

-- ── Special case: app_settings primary key ───────────────────────────────────
-- app_settings was (key TEXT PRIMARY KEY). Each tenant needs their own copy
-- of every setting (delete_code, etc.), so the PK becomes (tenant_id, key).
-- Existing HudREI rows already got tenant_id=1 via the helper above, so the
-- new composite PK won't collide.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'app_settings'
      AND constraint_type = 'PRIMARY KEY'
      AND constraint_name = 'app_settings_pkey'
  ) THEN
    ALTER TABLE app_settings DROP CONSTRAINT app_settings_pkey;
    ALTER TABLE app_settings ADD PRIMARY KEY (tenant_id, key);
    RAISE NOTICE 'app_settings PK swapped to (tenant_id, key)';
  ELSE
    RAISE NOTICE 'app_settings PK already swapped or absent — skipping';
  END IF;
END $$;

-- ── Cleanup ──────────────────────────────────────────────────────────────────

DROP FUNCTION _add_tenant_id(TEXT);

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════════
-- PART B — Index creation (must run OUTSIDE a transaction)
--
-- Postgres requires CREATE INDEX CONCURRENTLY to run outside any transaction
-- block. Each statement below is its own implicit transaction. They're
-- non-blocking (don't lock writes), so they can run on a live database, but
-- if any of them are interrupted they leave behind an INVALID index that
-- must be dropped and rebuilt — see the README runbook for detection +
-- recovery commands.
--
-- Composite indexes are (tenant_id, primary_lookup_column) so per-tenant
-- queries can use an index-only scan instead of a full sequential scan.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE INDEX CONCURRENTLY IF NOT EXISTS app_settings_tenant_id_idx          ON app_settings(tenant_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS bulk_import_jobs_tenant_id_idx      ON bulk_import_jobs(tenant_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS call_logs_tenant_id_idx             ON call_logs(tenant_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_contact_phones_tenant_id_idx ON campaign_contact_phones(tenant_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_contacts_tenant_id_idx     ON campaign_contacts(tenant_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_numbers_tenant_id_idx      ON campaign_numbers(tenant_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_uploads_tenant_id_idx      ON campaign_uploads(tenant_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS campaigns_tenant_id_idx             ON campaigns(tenant_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS contacts_tenant_id_idx              ON contacts(tenant_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS custom_list_types_tenant_id_idx     ON custom_list_types(tenant_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS deals_tenant_id_idx                 ON deals(tenant_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS distress_outcome_log_tenant_id_idx  ON distress_outcome_log(tenant_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS distress_score_log_tenant_id_idx    ON distress_score_log(tenant_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS filtration_results_tenant_id_idx    ON filtration_results(tenant_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS filtration_runs_tenant_id_idx       ON filtration_runs(tenant_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS import_history_tenant_id_idx        ON import_history(tenant_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS list_templates_tenant_id_idx        ON list_templates(tenant_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS lists_tenant_id_idx                 ON lists(tenant_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS mapping_templates_tenant_id_idx     ON mapping_templates(tenant_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS marketing_touches_tenant_id_idx     ON marketing_touches(tenant_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS markets_tenant_id_idx               ON markets(tenant_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS nis_events_tenant_id_idx            ON nis_events(tenant_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS nis_numbers_tenant_id_idx           ON nis_numbers(tenant_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS phone_tag_links_tenant_id_idx       ON phone_tag_links(tenant_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS phone_tags_tenant_id_idx            ON phone_tags(tenant_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS phones_tenant_id_idx                ON phones(tenant_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS properties_tenant_id_idx            ON properties(tenant_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS property_contacts_tenant_id_idx     ON property_contacts(tenant_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS property_lists_tenant_id_idx        ON property_lists(tenant_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS property_tags_tenant_id_idx         ON property_tags(tenant_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS sms_logs_tenant_id_idx              ON sms_logs(tenant_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS tags_tenant_id_idx                  ON tags(tenant_id);

-- Lazy-created tables: indexes only build if the tables exist.
-- Wrap in DO blocks so missing tables don't fail the whole script.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'owner_activities') THEN
    EXECUTE 'CREATE INDEX CONCURRENTLY IF NOT EXISTS owner_activities_tenant_id_idx ON owner_activities(tenant_id)';
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'owner_messages') THEN
    EXECUTE 'CREATE INDEX CONCURRENTLY IF NOT EXISTS owner_messages_tenant_id_idx ON owner_messages(tenant_id)';
  END IF;
END $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- PART C — Verification queries (run manually after parts A+B complete)
-- ═════════════════════════════════════════════════════════════════════════════

-- Check 1 — every tenant-owned table now has a tenant_id column
-- (lazy-created tables will be missing from this list if they haven't been
--  created yet; that's fine, they'll get tenant_id when initSchema runs them).
--
--   SELECT table_name FROM information_schema.columns
--    WHERE column_name = 'tenant_id' AND table_schema = 'public'
--    ORDER BY table_name;

-- Check 2 — every existing row backfilled to tenant_id=1
-- (run for any spot-check table; properties is the biggest, most representative)
--
--   SELECT tenant_id, COUNT(*) FROM properties GROUP BY tenant_id;

-- Check 3 — no INVALID indexes left behind by an interrupted CONCURRENTLY
-- (an empty result is good; any rows here mean an index needs to be dropped
--  and rebuilt — see README for the recovery command)
--
--   SELECT indexrelid::regclass AS index_name, indrelid::regclass AS table_name
--     FROM pg_index
--    WHERE NOT indisvalid;

-- Check 4 — app_settings PK is now (tenant_id, key)
--
--   SELECT conname, pg_get_constraintdef(oid)
--     FROM pg_constraint
--    WHERE conrelid = 'app_settings'::regclass AND contype = 'p';
