-- ─────────────────────────────────────────────────────────────────────────────
-- 99-rollback.sql
--
-- Reverses files 01 + 02. Drops tenant_id from every table, restores
-- app_settings.key as the standalone primary key, drops users + tenants.
--
-- WHEN TO USE THIS:
--   • The migration ran but caused unexpected problems and you want to
--     get back to the pre-Phase-1 state.
--   • You're testing the migration on staging and want to reset between
--     attempts.
--
-- WHEN NOT TO USE THIS:
--   • You've already deployed code that depends on tenant_id (Phase 1
--     Step B). Rolling back the schema after that point will break the
--     live app. Roll back the code FIRST, then this SQL.
--   • You have multiple tenants in `tenants`. This script wipes them.
--     For multi-tenant rollback, you need a custom plan.
--
-- This script is idempotent — safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── Restore app_settings primary key to (key) ────────────────────────────────

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'app_settings'
      AND constraint_type = 'PRIMARY KEY'
  ) THEN
    ALTER TABLE app_settings DROP CONSTRAINT app_settings_pkey;
  END IF;

  -- Restoring the original PK requires app_settings to have unique `key`
  -- values. If multiple tenants exist, this fails — which is the intended
  -- safeguard for "don't roll back when you have multiple tenants."
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'app_settings'
  ) THEN
    ALTER TABLE app_settings ADD PRIMARY KEY (key);
  END IF;
END $$;

-- ── Helper: drop tenant_id from a table if it exists ─────────────────────────

CREATE OR REPLACE FUNCTION _drop_tenant_id(target_table TEXT) RETURNS VOID AS $$
DECLARE
  col_exists BOOLEAN;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = target_table
  ) THEN
    RETURN;
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = target_table
      AND column_name = 'tenant_id'
  ) INTO col_exists;

  IF col_exists THEN
    EXECUTE format('ALTER TABLE %I DROP COLUMN tenant_id', target_table);
    RAISE NOTICE 'Dropped tenant_id from %', target_table;
  END IF;
END;
$$ LANGUAGE plpgsql;

SELECT _drop_tenant_id('app_settings');
SELECT _drop_tenant_id('bulk_import_jobs');
SELECT _drop_tenant_id('call_logs');
SELECT _drop_tenant_id('campaign_contact_phones');
SELECT _drop_tenant_id('campaign_contacts');
SELECT _drop_tenant_id('campaign_numbers');
SELECT _drop_tenant_id('campaign_uploads');
SELECT _drop_tenant_id('campaigns');
SELECT _drop_tenant_id('contacts');
SELECT _drop_tenant_id('custom_list_types');
SELECT _drop_tenant_id('deals');
SELECT _drop_tenant_id('distress_outcome_log');
SELECT _drop_tenant_id('distress_score_log');
SELECT _drop_tenant_id('filtration_results');
SELECT _drop_tenant_id('filtration_runs');
SELECT _drop_tenant_id('import_history');
SELECT _drop_tenant_id('list_templates');
SELECT _drop_tenant_id('lists');
SELECT _drop_tenant_id('mapping_templates');
SELECT _drop_tenant_id('marketing_touches');
SELECT _drop_tenant_id('markets');
SELECT _drop_tenant_id('nis_events');
SELECT _drop_tenant_id('nis_numbers');
SELECT _drop_tenant_id('owner_activities');
SELECT _drop_tenant_id('owner_messages');
SELECT _drop_tenant_id('phone_tag_links');
SELECT _drop_tenant_id('phone_tags');
SELECT _drop_tenant_id('phones');
SELECT _drop_tenant_id('properties');
SELECT _drop_tenant_id('property_contacts');
SELECT _drop_tenant_id('property_lists');
SELECT _drop_tenant_id('property_tags');
SELECT _drop_tenant_id('sms_logs');
SELECT _drop_tenant_id('tags');

DROP FUNCTION _drop_tenant_id(TEXT);

-- ── Drop users + tenants tables ──────────────────────────────────────────────
-- ON DELETE CASCADE on users.tenant_id means dropping tenants drops users
-- automatically — but for clarity (and to handle the case where the FK was
-- somehow removed) we drop both explicitly.

DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS tenants;

COMMIT;
