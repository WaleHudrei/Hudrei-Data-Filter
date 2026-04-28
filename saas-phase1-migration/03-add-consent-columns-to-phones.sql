-- ─────────────────────────────────────────────────────────────────────────────
-- 03-add-consent-columns-to-phones.sql
--
-- Adds TCPA-relevant consent tracking columns to the `phones` table.
-- Required for any defensible answer to "did this number's owner expressly
-- consent to be contacted?" — TCPA, CCPA, and CTIA short-code rules all
-- assume the operator can produce that answer on demand. Pre-this-migration,
-- the schema had nothing to point at.
--
-- Run order: AFTER 02-add-tenant-id-to-all-tables.sql.
--
-- ── What gets added ──────────────────────────────────────────────────────────
--   consent_status        — text enum-style. Valid values:
--                             'express_written'  — TCPA-grade written consent
--                             'prior_business'   — TCPA prior-business-relationship
--                             'inquiry'          — recipient initiated contact
--                             'unverified'       — default; legacy / imported list
--                             'revoked'          — recipient asked to stop
--   consent_at            — when consent was captured (NULL for legacy rows)
--   consent_source        — free-text provenance (campaign id, list id, URL, etc.)
--   consent_revoked_at    — when 'revoked' status was set (NULL otherwise)
--
-- ── Why all-NULL/'unverified' default ────────────────────────────────────────
-- Existing rows pre-date this migration; we cannot retroactively manufacture
-- consent records. 'unverified' is honest. The dashboard / export path can
-- surface a warning ("you have N phones with consent_status='unverified'") so
-- the operator can backfill the actual consent context for legacy lists.
--
-- ── Operationally safe ───────────────────────────────────────────────────────
-- Pure additive migration. No row rewrites, no constraint changes. Locks the
-- `phones` table briefly for ALTER but each ADD COLUMN with a constant
-- default is a metadata-only change in Postgres 11+ (no full table scan).
-- Idempotent — safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── columns ──────────────────────────────────────────────────────────────────
ALTER TABLE phones ADD COLUMN IF NOT EXISTS consent_status     VARCHAR(20) NOT NULL DEFAULT 'unverified';
ALTER TABLE phones ADD COLUMN IF NOT EXISTS consent_at         TIMESTAMPTZ;
ALTER TABLE phones ADD COLUMN IF NOT EXISTS consent_source     VARCHAR(200);
ALTER TABLE phones ADD COLUMN IF NOT EXISTS consent_revoked_at TIMESTAMPTZ;

-- ── value constraint ─────────────────────────────────────────────────────────
-- Reject typos / unknown statuses. Wrapped in DO so re-runs don't error if
-- the constraint already exists (Postgres lacks ADD CONSTRAINT IF NOT EXISTS).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'phones_consent_status_chk'
  ) THEN
    ALTER TABLE phones ADD CONSTRAINT phones_consent_status_chk
      CHECK (consent_status IN ('express_written','prior_business','inquiry','unverified','revoked'));
  END IF;
END
$$;

-- ── index for compliance queries ─────────────────────────────────────────────
-- Partial index on revoked rows — the most common query is "show me every
-- revoked phone for tenant X". Cheap (a small fraction of rows) and lets
-- /forgot-style data-subject lookups run sub-100ms.
CREATE INDEX IF NOT EXISTS phones_consent_revoked_idx
  ON phones (tenant_id, phone_number)
  WHERE consent_status = 'revoked';

-- ── unverified-count index ───────────────────────────────────────────────────
-- Dashboard surfaces "X% of your phones have unverified consent" — cheap
-- partial index on the unverified subset (which will be ~100% on day 1, then
-- shrink as the operator backfills consent for legacy lists).
CREATE INDEX IF NOT EXISTS phones_consent_unverified_idx
  ON phones (tenant_id)
  WHERE consent_status = 'unverified';

-- ── verification ─────────────────────────────────────────────────────────────
-- Confirm every existing phone has a status (the DEFAULT did its job).
DO $$
DECLARE n_null INTEGER;
BEGIN
  SELECT COUNT(*) INTO n_null FROM phones WHERE consent_status IS NULL;
  IF n_null > 0 THEN
    RAISE EXCEPTION 'phones.consent_status NOT NULL violation: % rows still NULL', n_null;
  END IF;
END
$$;

COMMIT;

-- ── post-deploy follow-ups (track in a ticket, not here) ─────────────────────
-- 1. Importers (server.js saveRunToDB Pass 8, property-import-routes.js,
--    bulk-import-routes.js) should set consent_source='import:<list_id>'
--    and consent_status='unverified' explicitly on new phone rows.
--    Today the DEFAULT covers that, but explicit is better for grep-ability.
-- 2. The records detail UI should surface the consent fields with a
--    "mark consent verified" action gated by the delete code.
-- 3. SMS STOP detection (audit C-3, deferred) will set consent_status='revoked'
--    + consent_revoked_at=NOW().
-- 4. Dashboard banner: "X phones with consent_status='unverified' — review".
-- ─────────────────────────────────────────────────────────────────────────────
