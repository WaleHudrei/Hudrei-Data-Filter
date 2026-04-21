const { Pool } = require('pg');
const { allValidStates } = require('./import/state');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
  // Tuned for Railway shared workers — keep at or below Railway's default cap.
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

async function query(text, params) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

// Module-level flag so initSchema runs AT MOST ONCE per process. Previous code
// called initSchema inside saveRunToDB for every filtration upload, which made
// every upload pay 2-3 seconds of DDL + migration overhead. Routes that need
// to "ensure" schema exists before serving can just call initSchema(); it's
// a no-op after first success. (Audit issue #16.)
let _schemaReady = false;

async function initSchema() {
  if (_schemaReady) return;

  // ── Core tables (idempotent — CREATE TABLE IF NOT EXISTS) ───────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS markets (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      state_code CHAR(2) NOT NULL,
      state_name VARCHAR(100) NOT NULL,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(state_code)
    );

    CREATE TABLE IF NOT EXISTS properties (
      id SERIAL PRIMARY KEY,
      street VARCHAR(255) NOT NULL,
      city VARCHAR(100) NOT NULL,
      state_code CHAR(2) NOT NULL,
      zip_code VARCHAR(10) NOT NULL,
      county VARCHAR(100),
      market_id INTEGER REFERENCES markets(id),
      property_type VARCHAR(50),
      vacant BOOLEAN,
      pipeline_stage VARCHAR(50) DEFAULT 'prospect',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(street, city, state_code, zip_code)
    );

    CREATE TABLE IF NOT EXISTS contacts (
      id SERIAL PRIMARY KEY,
      first_name VARCHAR(100),
      last_name VARCHAR(100),
      email VARCHAR(255),
      mailing_address VARCHAR(255),
      mailing_city VARCHAR(100),
      mailing_state CHAR(2),
      mailing_zip VARCHAR(10),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS property_contacts (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      role VARCHAR(50) DEFAULT 'owner',
      primary_contact BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(property_id, contact_id)
    );

    CREATE TABLE IF NOT EXISTS phones (
      id SERIAL PRIMARY KEY,
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      phone_number VARCHAR(20) NOT NULL,
      phone_index SMALLINT DEFAULT 1,
      phone_status VARCHAR(50) DEFAULT 'unknown',
      phone_type VARCHAR(50) DEFAULT 'unknown',
      phone_tag TEXT,
      do_not_call BOOLEAN DEFAULT false,
      wrong_number BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(contact_id, phone_number)
    );

    CREATE TABLE IF NOT EXISTS lists (
      id SERIAL PRIMARY KEY,
      list_name VARCHAR(255) NOT NULL,
      dialer_campaign_name VARCHAR(255),
      list_type VARCHAR(100),
      market_id INTEGER REFERENCES markets(id),
      source VARCHAR(100),
      upload_date DATE,
      total_records INTEGER,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(list_name)
    );

    CREATE TABLE IF NOT EXISTS property_lists (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
      list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      added_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(property_id, list_id)
    );

    CREATE TABLE IF NOT EXISTS call_logs (
      id SERIAL PRIMARY KEY,
      phone_id INTEGER NOT NULL REFERENCES phones(id) ON DELETE CASCADE,
      list_id INTEGER REFERENCES lists(id),
      property_id INTEGER REFERENCES properties(id),
      disposition VARCHAR(100) NOT NULL,
      disposition_normalized VARCHAR(50),
      agent_name VARCHAR(100),
      call_date DATE,
      call_notes TEXT,
      campaign_name VARCHAR(255),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sms_logs (
      id SERIAL PRIMARY KEY,
      phone_id INTEGER REFERENCES phones(id),
      contact_id INTEGER REFERENCES contacts(id),
      property_id INTEGER REFERENCES properties(id),
      campaign_name VARCHAR(255),
      direction VARCHAR(10) DEFAULT 'outbound',
      message_text TEXT,
      disposition VARCHAR(100),
      sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS filtration_runs (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255),
      run_at TIMESTAMPTZ DEFAULT NOW(),
      total_records INTEGER,
      lists_detected INTEGER,
      records_kept INTEGER,
      records_filtered INTEGER,
      caught_by_memory INTEGER,
      run_by VARCHAR(100)
    );

    CREATE TABLE IF NOT EXISTS filtration_results (
      id SERIAL PRIMARY KEY,
      run_id INTEGER NOT NULL REFERENCES filtration_runs(id) ON DELETE CASCADE,
      phone_number VARCHAR(20),
      list_name VARCHAR(255),
      property_id INTEGER REFERENCES properties(id),
      phone_id INTEGER REFERENCES phones(id),
      disposition VARCHAR(100),
      disposition_normalized VARCHAR(50),
      cumulative_count INTEGER,
      action VARCHAR(20),
      phone_status VARCHAR(50),
      phone_tag TEXT,
      marketing_result TEXT,
      caught_by_memory BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS deals (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES properties(id),
      stage VARCHAR(50) DEFAULT 'lead',
      lead_source VARCHAR(100),
      lead_date DATE,
      appointment_date DATE,
      offer_amount NUMERIC(12,2),
      offer_date DATE,
      contract_date DATE,
      closing_date DATE,
      assignment_fee NUMERIC(12,2),
      end_buyer VARCHAR(255),
      notes TEXT,
      assigned_am VARCHAR(100),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS marketing_touches (
      id SERIAL PRIMARY KEY,
      property_id INTEGER REFERENCES properties(id),
      contact_id INTEGER REFERENCES contacts(id),
      channel VARCHAR(50) NOT NULL,
      campaign_name VARCHAR(255),
      list_id INTEGER REFERENCES lists(id),
      touch_date DATE,
      outcome VARCHAR(100),
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS import_history (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
      source VARCHAR(100),
      imported_at TIMESTAMPTZ DEFAULT NOW(),
      imported_by VARCHAR(100),
      fields_added TEXT,
      fields_updated TEXT,
      notes TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_phones_number                ON phones(phone_number);
    CREATE INDEX IF NOT EXISTS idx_phones_contact               ON phones(contact_id);
    CREATE INDEX IF NOT EXISTS idx_call_logs_phone              ON call_logs(phone_id);
    CREATE INDEX IF NOT EXISTS idx_call_logs_date               ON call_logs(call_date);
    CREATE INDEX IF NOT EXISTS idx_call_logs_list               ON call_logs(list_id);
    CREATE INDEX IF NOT EXISTS idx_properties_address           ON properties(street, city, state_code, zip_code);
    CREATE INDEX IF NOT EXISTS idx_properties_state             ON properties(state_code);
    CREATE INDEX IF NOT EXISTS idx_filtration_results_run       ON filtration_results(run_id);
    CREATE INDEX IF NOT EXISTS idx_filtration_results_phone     ON filtration_results(phone_number);
    CREATE INDEX IF NOT EXISTS idx_deals_property               ON deals(property_id);
    CREATE INDEX IF NOT EXISTS idx_deals_stage                  ON deals(stage);
    CREATE INDEX IF NOT EXISTS idx_marketing_touches_property   ON marketing_touches(property_id);
    CREATE INDEX IF NOT EXISTS idx_marketing_touches_channel    ON marketing_touches(channel);
    CREATE INDEX IF NOT EXISTS idx_import_history_property      ON import_history(property_id);
  `);

  await query(`CREATE TABLE IF NOT EXISTS bulk_import_jobs (
    id SERIAL PRIMARY KEY,
    status VARCHAR(20) DEFAULT 'pending',
    filename TEXT,
    list_id INTEGER REFERENCES lists(id) ON DELETE SET NULL,
    total_rows INTEGER DEFAULT 0,
    processed_rows INTEGER DEFAULT 0,
    inserted INTEGER DEFAULT 0,
    updated INTEGER DEFAULT 0,
    skipped INTEGER DEFAULT 0,
    errors INTEGER DEFAULT 0,
    error_log TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await query(`ALTER TABLE bulk_import_jobs ADD COLUMN IF NOT EXISTS list_id INTEGER REFERENCES lists(id) ON DELETE SET NULL`);

  // ── Seed all 50 state markets (+ DC) ────────────────────────────────────────
  await query(`INSERT INTO markets (name,state_code,state_name) VALUES
    ('AL','AL','Alabama'),('AK','AK','Alaska'),('AZ','AZ','Arizona'),('AR','AR','Arkansas'),('CA','CA','California'),
    ('CO','CO','Colorado'),('CT','CT','Connecticut'),('DE','DE','Delaware'),('FL','FL','Florida'),('GA','GA','Georgia'),
    ('HI','HI','Hawaii'),('ID','ID','Idaho'),('IL','IL','Illinois'),('IN','IN','Indiana'),('IA','IA','Iowa'),
    ('KS','KS','Kansas'),('KY','KY','Kentucky'),('LA','LA','Louisiana'),('ME','ME','Maine'),('MD','MD','Maryland'),
    ('MA','MA','Massachusetts'),('MI','MI','Michigan'),('MN','MN','Minnesota'),('MS','MS','Mississippi'),('MO','MO','Missouri'),
    ('MT','MT','Montana'),('NE','NE','Nebraska'),('NV','NV','Nevada'),('NH','NH','New Hampshire'),('NJ','NJ','New Jersey'),
    ('NM','NM','New Mexico'),('NY','NY','New York'),('NC','NC','North Carolina'),('ND','ND','North Dakota'),('OH','OH','Ohio'),
    ('OK','OK','Oklahoma'),('OR','OR','Oregon'),('PA','PA','Pennsylvania'),('RI','RI','Rhode Island'),('SC','SC','South Carolina'),
    ('SD','SD','South Dakota'),('TN','TN','Tennessee'),('TX','TX','Texas'),('UT','UT','Utah'),('VT','VT','Vermont'),
    ('VA','VA','Virginia'),('WA','WA','Washington'),('WV','WV','West Virginia'),('WI','WI','Wisconsin'),('WY','WY','Wyoming'),
    ('DC','DC','District of Columbia')
    ON CONFLICT (state_code) DO UPDATE SET name=EXCLUDED.name, state_name=EXCLUDED.state_name`);

  // ── Column migrations ───────────────────────────────────────────────────────
  const migrations = [
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS assessed_value NUMERIC(12,2)`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS property_status VARCHAR(50)`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS equity_percent NUMERIC(5,2)`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS marketing_result VARCHAR(100)`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS source VARCHAR(100)`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS bedrooms SMALLINT`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS bathrooms NUMERIC(3,1)`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS sqft INTEGER`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS year_built SMALLINT`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS lot_size INTEGER`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS condition VARCHAR(50)`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS estimated_value NUMERIC(12,2)`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS last_sale_date DATE`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS last_sale_price NUMERIC(12,2)`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ DEFAULT NOW()`,

    `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS mailing_address VARCHAR(255)`,
    `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_1 VARCHAR(255)`,
    `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_2 VARCHAR(255)`,
    `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS mailing_city VARCHAR(100)`,
    `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS mailing_state CHAR(2)`,
    `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS mailing_zip VARCHAR(10)`,

    `ALTER TABLE lists ADD COLUMN IF NOT EXISTS source VARCHAR(100)`,
    `ALTER TABLE phones ADD COLUMN IF NOT EXISTS phone_type VARCHAR(50) DEFAULT 'unknown'`,

    // ── 2026-04-21 Feature 1: owner_type on contacts ────────────────────────
    // Values: 'Person' | 'Company' | 'Trust'. NULLable — inferred on import
    // via src/owner-type.js from first_name/last_name patterns. Existing rows
    // stay NULL and render as "—" until re-imported or manually edited.
    `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS owner_type VARCHAR(20)`,
    `CREATE INDEX IF NOT EXISTS idx_contacts_owner_type ON contacts(owner_type) WHERE owner_type IS NOT NULL`,

    // ── 2026-04-21 Feature 2: property "Additional Info" fields ─────────────
    // 10 new columns, all NULLable, all populated via CSV import mapping or
    // the manual edit form. `year_built` is NOT in this block — it already
    // exists from an earlier migration (line ~280). Safe_merge upsert logic
    // will backfill empty columns only; won't overwrite user-entered values.
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS stories SMALLINT`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS structure_type VARCHAR(50)`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS apn VARCHAR(50)`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS legal_description TEXT`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS total_tax_owed NUMERIC(12,2)`,
    // 2026-04-21 PM hotfix: tax_delinquent_year originally SMALLINT. PropStream
    // CSVs leak currency values ($57,142 etc.) into this column via their
    // column-shift export bug. SMALLINT max is 32,767 → overflow → whole import
    // batch crashes. Widen to INTEGER as defense-in-depth; importer also
    // coerces garbage values to NULL at read time so the DB only sees sane years.
    // ALTER TYPE INTEGER from SMALLINT is a safe widening cast — no data loss.
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS tax_delinquent_year INTEGER`,
    `ALTER TABLE properties ALTER COLUMN tax_delinquent_year TYPE INTEGER`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS tax_auction_date DATE`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS deed_type VARCHAR(50)`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS lien_type VARCHAR(50)`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS lien_date DATE`,
    // apn gets an index — it's a natural secondary key and we'll eventually use
    // it as a match key in Feature 8 (safe-merge upsert via address OR apn).
    `CREATE INDEX IF NOT EXISTS idx_properties_apn ON properties(apn) WHERE apn IS NOT NULL`,
    // 2026-04-21 PM hotfix: equity_percent was NUMERIC(5,2) (max 999.99).
    // PropStream exports occasionally carry absurd values (e.g. $403,382 in
    // the equity_percent column — that's a dollar amount, not a percent).
    // Widen to NUMERIC(8,2) so the DB can absorb the bad row; importer
    // separately clamps to a sane range. This is a pre-existing column, so
    // the ALTER is the only step — no ADD COLUMN needed.
    `ALTER TABLE properties ALTER COLUMN equity_percent TYPE NUMERIC(8,2)`,
  ];

  for (const sql of migrations) {
    try { await query(sql); }
    catch (e) { if (!e.message.includes('already exists')) console.error('Migration warning:', e.message); }
  }

  // ── 2026-04-21 Feature 1: owner_type backfill ───────────────────────────────
  // Classifies existing contacts into Person/Company/Trust by scanning their
  // first_name + last_name against the same keyword lists used by the JS
  // inferOwnerType() helper in src/owner-type.js. Keep the two lists in sync.
  //
  // SAFETY:
  //   - Guarded by `WHERE owner_type IS NULL` → never overwrites a manual or
  //     previously-inferred classification. Safe to run on every boot.
  //   - Gated by a cheap COUNT first so we skip the UPDATE entirely once every
  //     row is classified (no table-scan churn on subsequent boots).
  //   - Non-fatal on error — logs and moves on so import/UI still come up.
  //   - Strips periods/commas before matching so "L.L.C." matches "LLC".
  //   - Trust pattern is checked first (takes precedence over Company) — same
  //     order as the JS helper, so e.g. "SMITH FAMILY TRUST LLC" classifies as
  //     Trust (the more specific/senior legal form wins).
  try {
    const pending = await query(
      `SELECT COUNT(*)::int AS n FROM contacts
        WHERE owner_type IS NULL
          AND (COALESCE(first_name,'') <> '' OR COALESCE(last_name,'') <> '')`
    );
    const pendingN = pending.rows[0]?.n || 0;
    if (pendingN > 0) {
      const res = await query(`
        UPDATE contacts SET owner_type =
          CASE
            WHEN REGEXP_REPLACE(COALESCE(first_name,'') || ' ' || COALESCE(last_name,''), '[.,]', '', 'g')
                 ~* '\\y(TRUST|TRUSTEE|LIVING\\s+TRUST|FAMILY\\s+TRUST|REVOCABLE\\s+TRUST|IRREVOCABLE\\s+TRUST|TESTAMENTARY\\s+TRUST)\\y'
              THEN 'Trust'
            WHEN REGEXP_REPLACE(COALESCE(first_name,'') || ' ' || COALESCE(last_name,''), '[.,]', '', 'g')
                 ~* '\\y(LLC|INC|INCORPORATED|CORP|CORPORATION|COMPANY|LP|LLP|LTD|LIMITED|PROPERTIES|PROPS|INVESTMENTS?|HOLDINGS?|GROUP|ENTERPRISES|VENTURES|MANAGEMENT|MGMT|DEVELOPMENT|DEVELOPERS|PARTNERS|PARTNERSHIP|REALTY|ASSOCIATES|CAPITAL|REAL\\s+ESTATE)\\y'
              THEN 'Company'
            ELSE 'Person'
          END
        WHERE owner_type IS NULL
          AND (COALESCE(first_name,'') <> '' OR COALESCE(last_name,'') <> '')
      `);
      console.log(`[db] owner_type backfill: classified ${res.rowCount.toLocaleString()} of ${pendingN.toLocaleString()} unclassified contact(s)`);
    }
  } catch (e) {
    console.error('[db] owner_type backfill warning (non-fatal):', e.message);
  }

  // ── Fix: garbage state_codes (Audit issue #3 / decision #2) ────────────────
  // The old normalizeState fell back to raw.slice(0,2).toUpperCase() for any
  // unrecognized value, which silently inserted "46" (from "46218" zip code
  // that landed in the State column), "UN", etc. into the properties and
  // markets tables. Those rows are unreachable via the filter UI (which uses
  // a whitelist) and add only noise to counts.
  //
  // SAFETY: this used to DELETE unconditionally on every startup. That's scary
  // because there's no way to preview the blast radius before it runs, and FK
  // cascades could take real data with the garbage. It now runs in one of
  // three modes, controlled by the LOKI_CLEANUP env var:
  //   unset or 'report'  → count-only. Logs how many rows WOULD be deleted.
  //                        This is the safe default on every boot.
  //   'confirm'          → executes the DELETE. One-time operation; after the
  //                        first successful run you can unset this env var.
  //   'skip'             → no-op. Use if you've already cleaned up manually
  //                        and want to silence the report on boot.
  try {
    const mode = (process.env.LOKI_CLEANUP || 'report').toLowerCase();
    if (mode === 'skip') {
      // explicit opt-out — no log noise
    } else {
      const validStatesSql = allValidStates().map(s => `'${s}'`).join(',');

      // Always run the count so we have visibility
      const propCount = await query(
        `SELECT COUNT(*) AS n, ARRAY_AGG(DISTINCT state_code) FILTER (WHERE state_code IS NOT NULL) AS codes
           FROM properties
          WHERE state_code IS NULL OR state_code NOT IN (${validStatesSql})`
      );
      const mktCount = await query(
        `SELECT COUNT(*) AS n FROM markets
          WHERE state_code IS NULL OR state_code NOT IN (${validStatesSql})`
      );
      const propN = parseInt(propCount.rows[0]?.n || 0);
      const mktN  = parseInt(mktCount.rows[0]?.n || 0);
      const codes = propCount.rows[0]?.codes || [];

      if (propN === 0 && mktN === 0) {
        // Nothing to do — silently skip the whole block.
      } else if (mode !== 'confirm') {
        console.log(`[db] garbage-state cleanup — REPORT ONLY (set LOKI_CLEANUP=confirm to execute):`);
        console.log(`[db]   ${propN.toLocaleString()} properties with invalid state_code`);
        console.log(`[db]   ${mktN} markets with invalid state_code`);
        console.log(`[db]   Offending codes sample: ${codes.slice(0, 20).join(', ')}${codes.length > 20 ? ` (+${codes.length - 20} more)` : ''}`);
      } else {
        // Mode === 'confirm' — actually delete. Check FK CASCADE behavior first:
        // if property_contacts, phones, call_logs, etc. have ON DELETE RESTRICT,
        // the DELETE will fail and roll back. Abort with a clear message so the
        // operator knows rather than silently catching the error.
        const fkCheck = await query(`
          SELECT conname, conrelid::regclass::text AS table_name, confdeltype
            FROM pg_constraint
           WHERE confrelid = 'properties'::regclass AND contype = 'f'
        `);
        const restrictors = fkCheck.rows.filter(r => r.confdeltype === 'r' || r.confdeltype === 'a');
        if (restrictors.length > 0) {
          console.error(`[db] cleanup ABORTED: ${restrictors.length} FK constraint(s) on properties use ON DELETE RESTRICT/NO ACTION. Deleting garbage properties would fail. Offending constraints:`);
          for (const r of restrictors) console.error(`  - ${r.table_name}: ${r.conname}`);
          console.error(`[db] Options: (a) change those FKs to ON DELETE CASCADE or SET NULL, (b) manually delete dependent rows first, or (c) leave LOKI_CLEANUP unset to skip.`);
        } else {
          console.log(`[db] garbage-state cleanup — EXECUTING (LOKI_CLEANUP=confirm)`);
          const delProps = await query(
            `DELETE FROM properties WHERE state_code IS NULL OR state_code NOT IN (${validStatesSql})`
          );
          const delMarkets = await query(
            `DELETE FROM markets WHERE state_code IS NULL OR state_code NOT IN (${validStatesSql})`
          );
          console.log(`[db] cleanup complete: removed ${delProps.rowCount} properties, ${delMarkets.rowCount} markets. You can now unset LOKI_CLEANUP.`);
        }
      }
    }
  } catch (e) {
    console.error('[db] garbage-state cleanup warning:', e.message);
  }

  // ── Generated columns for normalized address matching (Audit issue #4) ──────
  // The records filter used to run a 13-layer REGEXP_REPLACE chain on every
  // properties.street and contacts.mailing_address on every request. A STORED
  // generated column computes the normalized form once at write time, and
  // indexes cover the common lookups.
  const genCols = [
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS street_normalized TEXT
       GENERATED ALWAYS AS (
         LOWER(REGEXP_REPLACE(REGEXP_REPLACE(TRIM(COALESCE(street,'')), '[.,]+', '', 'g'), '\\s+', ' ', 'g'))
       ) STORED`,
    `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS mailing_address_normalized TEXT
       GENERATED ALWAYS AS (
         LOWER(REGEXP_REPLACE(REGEXP_REPLACE(TRIM(COALESCE(mailing_address,'')), '[.,]+', '', 'g'), '\\s+', ' ', 'g'))
       ) STORED`,
    // 2026-04-18 audit fix #18: campaign_contacts.property_address_normalized
    // was previously added here, which created a schema-init race with
    // campaigns.initCampaignSchema(). Moved to campaigns.js where the table is
    // actually created — see migrations[] block in campaigns.initCampaignSchema().
  ];
  for (const sql of genCols) {
    try { await query(sql); }
    catch (e) {
      // Older Postgres (<12) doesn't support generated columns. Filter helper
      // falls back to inline LOWER+TRIM if the column isn't present.
      if (!e.message.includes('already exists') && !e.message.includes('generated')) {
        console.error('Generated-column migration warning:', e.message);
      }
    }
  }

  // ── Additional indexes for the new filter / campaigns / distress paths ──────
  const extraIndexes = [
    `CREATE INDEX IF NOT EXISTS idx_properties_street_norm   ON properties(street_normalized)`,
    `CREATE INDEX IF NOT EXISTS idx_contacts_mail_norm       ON contacts(mailing_address_normalized)`,
    `CREATE INDEX IF NOT EXISTS idx_properties_distress_score ON properties(distress_score) WHERE distress_score IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_properties_pipeline_stage ON properties(pipeline_stage)`,
    `CREATE INDEX IF NOT EXISTS idx_property_lists_list      ON property_lists(list_id)`,
    `CREATE INDEX IF NOT EXISTS idx_property_contacts_primary ON property_contacts(property_id) WHERE primary_contact = true`,
    // 2026-04-18 audit fix #32: properties.created_at was unindexed but queried
    // in 5+ sites — the Records filter's upload_from/upload_to date range, the
    // dashboard's new-this-month count, and the main ORDER BY on Records. On
    // 75k properties each dashboard hit was doing a full sequential scan.
    `CREATE INDEX IF NOT EXISTS idx_properties_created_at    ON properties(created_at)`,
    // 2026-04-18 audit fix #17: partial-unique — at most one primary contact per
    // property. Previously nothing prevented the duplicate-merge path from
    // producing two primary_contact=true rows for the same property, which made
    // the main list query's LEFT JOIN produce duplicate rows (only DISTINCT ON
    // saved it, and it picked an arbitrary winner). Before creating this index,
    // clean up any existing dupes by downgrading all but the lowest-id primary.
    // ─────────────────────────────────────────────────────────────────────────
    // 2026-04-20 audit fix #5 (query performance):
    // (street_normalized, state_code) composite covers the marketing-result
    // EXISTS subquery's join condition exactly:
    //   WHERE cc.property_address_normalized = p.street_normalized
    //     AND UPPER(TRIM(cc.property_state)) = UPPER(TRIM(p.state_code))
    // The pre-existing idx_properties_street_norm was single-column; Postgres
    // couldn't combine it with a seq-scan on state. With the composite, the
    // filter hits an index both sides of the join and the EXISTS bails out
    // early. Expect 10–20× speedup on the ~7000-row list.
    `CREATE INDEX IF NOT EXISTS idx_properties_street_state_norm ON properties(street_normalized, state_code)`,
    // Partial index on campaign_contacts rows that actually have a marketing_result —
    // speeds up the "lead" roll-up used by the dashboard's new UNION count.
    `CREATE INDEX IF NOT EXISTS idx_cc_marketing_result_set
                     ON campaign_contacts(LOWER(TRIM(marketing_result)))
                  WHERE marketing_result IS NOT NULL AND TRIM(marketing_result) <> ''`,
    // 2026-04-20 audit fix #5 (cont): composite index for the stack_list
    // semi-join rewrite. The old idx_property_lists_list covered list_id
    // alone; adding property_id second lets the planner do an index-only
    // scan when answering "is property X on list Y" — no heap lookup per
    // row. Huge win when a single-list filter needs to verify ~30k
    // properties against a popular list.
    `CREATE INDEX IF NOT EXISTS idx_property_lists_list_property
                     ON property_lists(list_id, property_id)`,
  ];
  for (const sql of extraIndexes) {
    try { await query(sql); }
    catch (e) {
      if (!e.message.includes('does not exist') && !e.message.includes('already exists')) {
        console.error('Index migration warning:', e.message);
      }
    }
  }

  // Fix #17 cleanup: demote duplicate primaries, keeping the oldest per property
  try {
    const res = await query(`
      UPDATE property_contacts SET primary_contact = false
       WHERE id IN (
         SELECT id FROM (
           SELECT id, property_id,
             ROW_NUMBER() OVER (PARTITION BY property_id ORDER BY id ASC) AS rn
             FROM property_contacts
            WHERE primary_contact = true
         ) ranked
         WHERE rn > 1
       )
    `);
    if (res.rowCount > 0) {
      console.log(`[db] demoted ${res.rowCount} duplicate primary_contact rows (fix #17)`);
    }
  } catch (e) { console.error('Primary-contact cleanup warning:', e.message); }

  // Fix #17: now-safe partial unique index. Created after the cleanup above.
  try {
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_property_contacts_single_primary
                   ON property_contacts(property_id) WHERE primary_contact = true`);
  } catch (e) { console.error('Primary-contact uniqueness index warning:', e.message); }

  // 2026-04-18 audit fix #18: moved campaign_contacts index creation to
  // campaigns.initCampaignSchema() since that's where the table is created.
  // No longer tries to drop/recreate from here to avoid the schema-init race.

  // ── Owner portfolio counts MV (Audit issue #4c / min-owned filter) ──────────
  try {
    await query(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS owner_portfolio_counts AS
      SELECT
        COALESCE(c.mailing_address_normalized, LOWER(TRIM(c.mailing_address))) AS mailing_address_normalized,
        LOWER(TRIM(c.mailing_city))                                           AS mailing_city_normalized,
        UPPER(TRIM(c.mailing_state))                                          AS mailing_state,
        SUBSTRING(TRIM(c.mailing_zip) FROM 1 FOR 5)                           AS zip5,
        COUNT(*)                                                              AS owned_count
      FROM properties p
      JOIN property_contacts pc ON pc.property_id = p.id AND pc.primary_contact = true
      JOIN contacts c           ON c.id = pc.contact_id
      WHERE c.mailing_address IS NOT NULL AND TRIM(c.mailing_address) != ''
      GROUP BY 1, 2, 3, 4
    `);
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_opc_key
                   ON owner_portfolio_counts(mailing_address_normalized, mailing_city_normalized, mailing_state, zip5)`);
  } catch (e) {
    if (!e.message.includes('already exists')) {
      console.error('MV migration warning:', e.message);
    }
  }

  _schemaReady = true;
  console.log('Database schema initialized + migrations applied');

  // ── 2026-04-20 audit fix #6: phone-based contact dedup ─────────────────────
  // Dry-run by default. Gated by LOKI_DEDUP_PHONES env var — see
  // maintenance.js for semantics. Non-fatal on any failure (won't block boot).
  try {
    const { runScheduledMaintenance } = require('./maintenance');
    await runScheduledMaintenance();
  } catch (e) {
    console.error('[db] dedup maintenance warning:', e.message);
  }
}

/**
 * Refresh the owner-portfolio MV. Call after big imports or on a nightly cron.
 * Non-fatal if it fails (filter code falls back to the correlated subquery).
 */
async function refreshOwnerPortfolioMv() {
  try {
    await query(`REFRESH MATERIALIZED VIEW CONCURRENTLY owner_portfolio_counts`);
  } catch (e) {
    try { await query(`REFRESH MATERIALIZED VIEW owner_portfolio_counts`); }
    catch (ee) { console.error('[db] MV refresh failed:', ee.message); }
  }
}

module.exports = { query, initSchema, refreshOwnerPortfolioMv, pool };
