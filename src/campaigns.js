const { query } = require('./db');
const filtration = require('./filtration');
const { normalizePhone } = require('./phone-normalize');
const { normalizeState } = require('./import/state');

// ─────────────────────────────────────────────────────────────────────────────
// 2026-04-17 audit changes:
//   • importContactList uses MERGE semantics on re-upload (UPSERT by
//     (campaign_id, row_index) and (contact_id, slot_index)). The old
//     `DELETE FROM campaign_contacts WHERE campaign_id=$1` destroyed all
//     filter history (filtered/wrong_number/last_disposition/nis_flagged_at)
//     every time a user re-uploaded the list. (Decision #5.)
//   • BATCH bumped from 20 → 500. Contacts are ~150 bytes each; 500/batch
//     stays well under Postgres's 64k parameter limit (500*13 = 6500 params)
//     and cuts the number of round-trips 25×. (Audit issue #20.)
//   • Three locally-defined functions deleted — applyFiltrationToContacts,
//     generateCleanExport, and getContactStats were shadowed by the re-exports
//     from filtration.js at the bottom of the module (and those re-exports win
//     when external modules do `campaigns.getContactStats(...)`). The local
//     copies had drifted and were pure dead code. (Audit issue #11.)
//   • NIS auto-flag now scoped to active campaigns implicitly by the call
//     site (only fires for the campaign being imported, which is always the
//     active one); global NIS spread lives in filtration.importNisFile and is
//     scoped there too. (Decision #4.)
// ─────────────────────────────────────────────────────────────────────────────

// Module-level flag so initCampaignSchema runs DDL at most once per process.
let _campaignSchemaReady = false;

async function initCampaignSchema() {
  if (_campaignSchemaReady) return;
  await query(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id SERIAL PRIMARY KEY,
      tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      list_type VARCHAR(100) NOT NULL,
      market_name VARCHAR(100) NOT NULL,
      state_code CHAR(2) NOT NULL,
      status VARCHAR(20) DEFAULT 'active',
      active_channel VARCHAR(20) DEFAULT 'cold_call',
      cold_call_status VARCHAR(20) DEFAULT 'active',
      sms_status VARCHAR(20) DEFAULT 'dormant',
      notes TEXT,
      created_by VARCHAR(100) DEFAULT 'team',
      start_date DATE DEFAULT CURRENT_DATE,
      end_date DATE,
      total_unique_numbers INTEGER DEFAULT 0,
      total_callable INTEGER DEFAULT 0,
      total_filtered INTEGER DEFAULT 0,
      total_wrong_numbers INTEGER DEFAULT 0,
      total_voicemails INTEGER DEFAULT 0,
      total_not_interested INTEGER DEFAULT 0,
      total_do_not_call INTEGER DEFAULT 0,
      total_transfers INTEGER DEFAULT 0,
      total_connected INTEGER DEFAULT 0,
      manual_count INTEGER DEFAULT 0,
      upload_count INTEGER DEFAULT 0,
      last_filtered_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS campaign_uploads (
      id SERIAL PRIMARY KEY,
      tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      filename VARCHAR(255),
      source_list_name VARCHAR(255),
      channel VARCHAR(20) DEFAULT 'cold_call',
      uploaded_at TIMESTAMPTZ DEFAULT NOW(),
      total_records INTEGER DEFAULT 0,
      new_unique_numbers INTEGER DEFAULT 0,
      records_kept INTEGER DEFAULT 0,
      records_filtered INTEGER DEFAULT 0,
      wrong_numbers INTEGER DEFAULT 0,
      voicemails INTEGER DEFAULT 0,
      not_interested INTEGER DEFAULT 0,
      do_not_call INTEGER DEFAULT 0,
      transfers INTEGER DEFAULT 0,
      caught_by_memory INTEGER DEFAULT 0,
      connected INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS campaign_numbers (
      id SERIAL PRIMARY KEY,
      tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      phone_number VARCHAR(20) NOT NULL,
      first_seen_at TIMESTAMPTZ DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ DEFAULT NOW(),
      total_appearances INTEGER DEFAULT 1,
      last_disposition VARCHAR(100),
      last_disposition_normalized VARCHAR(50),
      cumulative_count INTEGER DEFAULT 1,
      current_status VARCHAR(20) DEFAULT 'callable',
      phone_status VARCHAR(50),
      phone_tag TEXT,
      marketing_result TEXT,
      UNIQUE(campaign_id, phone_number)
    );

    CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);
    CREATE INDEX IF NOT EXISTS idx_campaign_uploads_campaign ON campaign_uploads(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_campaign_numbers_campaign ON campaign_numbers(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_campaign_numbers_phone ON campaign_numbers(phone_number);
    CREATE INDEX IF NOT EXISTS idx_campaign_numbers_status ON campaign_numbers(current_status);

    CREATE TABLE IF NOT EXISTS campaign_contacts (
      id SERIAL PRIMARY KEY,
      tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      first_name VARCHAR(100),
      last_name VARCHAR(100),
      mailing_address VARCHAR(255),
      mailing_city VARCHAR(100),
      mailing_state VARCHAR(10),
      mailing_zip VARCHAR(20),
      mailing_county VARCHAR(100),
      property_address VARCHAR(255),
      property_city VARCHAR(100),
      property_state VARCHAR(10),
      property_zip VARCHAR(20),
      row_index INTEGER,
      all_phones_dead BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(campaign_id, row_index)
    );

    CREATE TABLE IF NOT EXISTS campaign_contact_phones (
      id SERIAL PRIMARY KEY,
      tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      contact_id INTEGER NOT NULL REFERENCES campaign_contacts(id) ON DELETE CASCADE,
      phone_number VARCHAR(20) NOT NULL,
      slot_index SMALLINT NOT NULL,
      phone_status VARCHAR(20) DEFAULT 'unknown',
      phone_tag TEXT,
      wrong_number BOOLEAN DEFAULT false,
      filtered BOOLEAN DEFAULT false,
      cumulative_count INTEGER DEFAULT 0,
      last_disposition VARCHAR(100),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(contact_id, slot_index)
    );

    CREATE INDEX IF NOT EXISTS idx_campaign_contacts_campaign ON campaign_contacts(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_campaign_phones_campaign ON campaign_contact_phones(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_campaign_phones_number ON campaign_contact_phones(phone_number);
    CREATE INDEX IF NOT EXISTS idx_campaign_phones_status ON campaign_contact_phones(phone_status);

    CREATE TABLE IF NOT EXISTS custom_list_types (
      id SERIAL PRIMARY KEY,
      tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name VARCHAR(100) NOT NULL UNIQUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS nis_numbers (
      tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      phone_number VARCHAR(20) PRIMARY KEY,
      first_seen_nis DATE,
      last_seen_nis DATE,
      times_reported INTEGER DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_nis_last_seen ON nis_numbers(last_seen_nis);
  `);

  const migrations = [
    `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS start_date DATE DEFAULT CURRENT_DATE`,
    `ALTER TABLE campaign_contacts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`,
    `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS end_date DATE`,
    `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS manual_count INTEGER DEFAULT 0`,
    `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS total_connected INTEGER DEFAULT 0`,
    `ALTER TABLE campaign_uploads ADD COLUMN IF NOT EXISTS connected INTEGER DEFAULT 0`,
    `ALTER TABLE campaign_contact_phones ADD COLUMN IF NOT EXISTS nis_flagged_at TIMESTAMPTZ`,
    `ALTER TABLE campaign_contact_phones ADD COLUMN IF NOT EXISTS wrong_number_flagged_at TIMESTAMPTZ`,
    `ALTER TABLE campaign_contact_phones ADD COLUMN IF NOT EXISTS correct_flagged_at TIMESTAMPTZ`,
    `ALTER TABLE campaign_contacts ADD COLUMN IF NOT EXISTS marketing_result VARCHAR(50)`,
    // Per-campaign filter thresholds (Task 2). Defaults make existing campaigns
    // behave like before: voicemails/hangups are NOT auto-filtered out at clean-
    // export time unless the user lowers the threshold. exclude_* defaults match
    // the prior hardcoded behavior (DNC + wrong + NIS + already-Lead all out).
    `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS voicemail_threshold     INT     DEFAULT 99`,
    `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS hangup_threshold        INT     DEFAULT 99`,
    `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS exclude_dnc             BOOLEAN DEFAULT TRUE`,
    `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS exclude_wrong_number    BOOLEAN DEFAULT TRUE`,
    `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS exclude_not_in_service  BOOLEAN DEFAULT TRUE`,
    `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS exclude_already_lead    BOOLEAN DEFAULT TRUE`,
    // 2026-04-18 audit fix #18: moved from db.js to here (where campaign_contacts
    // is actually created) to eliminate schema-init race condition. Previously
    // db.js::initSchema() ran in parallel with campaigns.initCampaignSchema(),
    // and if db.js won the race it tried to ALTER campaign_contacts before the
    // table existed — the error was silently swallowed and the column (and its
    // index) never got created, causing the marketing filter to return 0 rows.
    `ALTER TABLE campaign_contacts ADD COLUMN IF NOT EXISTS property_address_normalized TEXT
       GENERATED ALWAYS AS (
         LOWER(REGEXP_REPLACE(REGEXP_REPLACE(TRIM(COALESCE(property_address,'')), '[.,]+', '', 'g'), '\\s+', ' ', 'g'))
       ) STORED`,
    // 2026-04-20 audit fix #A: allow duplicate campaign names. The original
    // schema had `name VARCHAR(255) NOT NULL UNIQUE`, which (a) blocked users
    // from creating a second campaign with the same name — a legitimate use
    // case when running the same campaign type across different markets or
    // rounds — and (b) silently broke cloneCampaign() which tries to INSERT
    // the source's name verbatim. Dropping the PG auto-named constraint
    // (table_column_key pattern); IF EXISTS keeps the migration idempotent.
    `ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_name_key`,
  ];
  for (const m of migrations) {
    try { await query(m); } catch(e) { console.error('Migration error:', e.message); }
  }

  // 2026-04-18 audit fix #18 (cont): index for the normalized address column.
  // Created after the ALTER so the column is guaranteed to exist.
  try {
    await query(`CREATE INDEX IF NOT EXISTS idx_cc_property_addr_norm_state
                   ON campaign_contacts (property_address_normalized, UPPER(TRIM(property_state)))`);
  } catch(e) { console.error('Index create warning (cc_property_addr_norm_state):', e.message); }
  // Drop the old index that was never used (the filter does LOWER+TRIM, index was LOWER only).
  try { await query(`DROP INDEX IF EXISTS idx_cc_property_address_state`); } catch(_) {}

  // 2026-04-18 audit fix #14: Change phone uniqueness key from (contact_id,
  // slot_index) to (contact_id, phone_number). Previously a re-upload where
  // a phone changed at a given slot would OVERWRITE the phone_number but
  // KEEP the prior phone's status/wrong_number/filtered flags — a new phone
  // arrived pre-marked as Wrong/Filtered. Phone number is the real identity;
  // slot_index is positional-and-informational.
  //
  // 2026-04-20 hotfix (pass 10): The unique index creation above was failing
  // silently on boot because pre-existing rows had duplicate (contact_id,
  // phone_number) pairs — legacy artifacts from slot-shuffle re-uploads and
  // contact merges that predated fix #14. With the old slot-based constraint
  // dropped and the new phone-based index never created, the table had NO
  // unique constraint at all, so every `ON CONFLICT (contact_id, phone_number)`
  // in importContactList() crashed with Postgres 42P10. Contact uploads have
  // been dead since pass 1 deployed. Fix: dedup duplicates BEFORE creating
  // the index, keeping the row with the most informative state per group.
  try {
    // Drop the old slot-based unique if present (both common PG constraint names).
    await query(`ALTER TABLE campaign_contact_phones DROP CONSTRAINT IF EXISTS campaign_contact_phones_contact_id_slot_index_key`);
  } catch(_) {}

  // Dedup existing (contact_id, phone_number) duplicates.
  // Ranking for "keeper" row per group:
  //   1. phone_status set to something other than 'unknown' (has been filtered)
  //      beats unfiltered — don't lose call-result data.
  //   2. Higher cumulative_count — more call history is more valuable.
  //   3. Most recent updated_at — freshest state.
  //   4. Lowest id — stable tiebreak.
  // Runs once per boot; becomes a no-op (0 rows affected) after first success.
  try {
    const dedupRes = await query(`
      DELETE FROM campaign_contact_phones
       WHERE id IN (
         SELECT id FROM (
           SELECT id,
                  ROW_NUMBER() OVER (
                    PARTITION BY contact_id, phone_number
                    ORDER BY
                      CASE WHEN phone_status IS NOT NULL AND phone_status <> 'unknown' THEN 0 ELSE 1 END,
                      COALESCE(cumulative_count, 0) DESC,
                      updated_at DESC NULLS LAST,
                      id ASC
                  ) AS rn
             FROM campaign_contact_phones
         ) t
         WHERE t.rn > 1
       )
    `);
    if (dedupRes.rowCount > 0) {
      console.log(`[campaigns] Deduplicated ${dedupRes.rowCount} duplicate (contact_id, phone_number) row(s) in campaign_contact_phones`);
    }
  } catch(e) {
    console.error('[campaigns] Dedup of campaign_contact_phones failed:', e.message);
  }

  try {
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ccp_contact_phone_uniq
                   ON campaign_contact_phones (contact_id, phone_number)`);
  } catch(e) {
    // If this STILL fails after dedup, something is genuinely wrong. Surface it
    // LOUDLY — contact uploads will fail with 42P10 until resolved. Dump the
    // top remaining dupe groups so the operator can investigate by hand.
    console.error('[campaigns] CRITICAL: unique index idx_ccp_contact_phone_uniq failed to create AFTER dedup. Contact uploads will fail with ON CONFLICT 42P10 until fixed. Error:', e.message);
    try {
      const r = await query(`
        SELECT contact_id, phone_number, COUNT(*) AS cnt
          FROM campaign_contact_phones
         GROUP BY contact_id, phone_number
        HAVING COUNT(*) > 1
         ORDER BY cnt DESC
         LIMIT 5
      `);
      if (r.rows.length) {
        console.error('[campaigns]   Remaining dupe groups (top 5):', JSON.stringify(r.rows));
      }
    } catch(_) {}
  }

  // ── 2026-04-20 audit fix #1: campaign_contacts.property_state backfill ──────
  // Pre-fix, property_state was stored raw from the CSV — values like
  // "Indiana", "INDIANA", "  Indiana  ", "In." landed in the column. The
  // records filter does UPPER(TRIM(property_state)) = UPPER(TRIM(p.state_code))
  // against properties.state_code (always a 2-letter USPS code), so every one
  // of those rows silently dropped and the marketing-result filter returned 0.
  //
  // This block normalizes historical rows in-place. Gated by LOKI_STATE_FIX:
  //   unset / 'report' (default) — log how many rows would be changed
  //   'confirm'                  — actually run the UPDATE
  //   'skip'                     — no-op
  try {
    const mode = (process.env.LOKI_STATE_FIX || 'report').toLowerCase();
    if (mode !== 'skip') {
      // Pull distinct offenders
      const bad = await query(`
        SELECT DISTINCT TRIM(property_state) AS raw
          FROM campaign_contacts
         WHERE property_state IS NOT NULL
           AND TRIM(property_state) <> ''
           AND UPPER(TRIM(property_state)) NOT IN (
             'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA',
             'HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
             'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
             'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
             'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'
           )
      `);
      const toFix = [];
      for (const r of bad.rows) {
        const normed = normalizeState(r.raw);
        if (normed) toFix.push({ raw: r.raw, normed });
      }
      if (toFix.length === 0) {
        // nothing to do — stay silent
      } else if (mode === 'confirm') {
        let total = 0;
        for (const { raw, normed } of toFix) {
          const res = await query(
            `UPDATE campaign_contacts SET property_state = $1 WHERE TRIM(property_state) = $2`,
            [normed, raw]
          );
          total += res.rowCount;
        }
        console.log(`[campaigns] state backfill: normalized ${total} row(s) across ${toFix.length} distinct value(s). You can unset LOKI_STATE_FIX now.`);
      } else {
        const sample = toFix.slice(0, 10).map(t => `"${t.raw}" → ${t.normed}`).join(', ');
        console.log(`[campaigns] state backfill — REPORT ONLY (set LOKI_STATE_FIX=confirm to execute):`);
        console.log(`[campaigns]   ${toFix.length} distinct value(s) would be normalized`);
        console.log(`[campaigns]   sample: ${sample}${toFix.length > 10 ? ` (+${toFix.length - 10} more)` : ''}`);
      }
    }
  } catch (e) {
    console.error('[campaigns] state backfill warning:', e.message);
  }

  _campaignSchemaReady = true;
}

async function getCampaigns(tenantId) {
  if (!Number.isInteger(tenantId)) throw new Error('getCampaigns: tenantId required');
  const res = await query(`SELECT * FROM campaigns WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId]);
  return res.rows;
}

async function getCampaign(tenantId, id) {
  if (!Number.isInteger(tenantId)) throw new Error('getCampaign: tenantId required');
  const c = await query(`SELECT * FROM campaigns WHERE id=$1 AND tenant_id=$2`, [id, tenantId]);
  if (!c.rows.length) return null;
  const uploads = await query(`SELECT * FROM campaign_uploads WHERE campaign_id=$1 AND tenant_id=$2 ORDER BY uploaded_at DESC LIMIT 30`, [id, tenantId]);
  // Union call-log dispositions (from campaign_numbers) with SMS labels
  // (from campaign_contact_phones.last_disposition). Legacy raw "C2|Label 📞"
  // values are cleaned on the fly. After filtration.js's write-time-normalize
  // fix is deployed, the REGEXP_REPLACE is only needed for historical rows.
  const disposition_breakdown = await query(`
    SELECT disposition, SUM(count)::int AS count FROM (
      SELECT last_disposition_normalized AS disposition, COUNT(*) AS count
        FROM campaign_numbers
       WHERE campaign_id = $1 AND tenant_id = $2 AND last_disposition_normalized IS NOT NULL
       GROUP BY last_disposition_normalized
      UNION ALL
      SELECT TRIM(REGEXP_REPLACE(REGEXP_REPLACE(last_disposition, '^[^|]*\\|', ''), '[^A-Za-z ]+$', '')) AS disposition,
             COUNT(*) AS count
        FROM campaign_contact_phones
       WHERE campaign_id = $1 AND tenant_id = $2 AND last_disposition IS NOT NULL
       GROUP BY TRIM(REGEXP_REPLACE(REGEXP_REPLACE(last_disposition, '^[^|]*\\|', ''), '[^A-Za-z ]+$', ''))
    ) merged
    WHERE disposition IS NOT NULL AND disposition <> ''
    GROUP BY disposition
    ORDER BY count DESC`, [id, tenantId]);
  return { ...c.rows[0], uploads: uploads.rows, disposition_breakdown: disposition_breakdown.rows };
}

async function createCampaign({ tenantId, name, list_type, market_name, state_code, notes, created_by, start_date, active_channel }) {
  if (!Number.isInteger(tenantId)) throw new Error('createCampaign: tenantId required');
  const channel = active_channel === 'sms' ? 'sms' : 'cold_call';
  const cold_call_status = channel === 'cold_call' ? 'active' : 'dormant';
  const sms_status = channel === 'sms' ? 'active' : 'dormant';
  const res = await query(
    `INSERT INTO campaigns (tenant_id, name, list_type, market_name, state_code, notes, created_by, start_date, active_channel, cold_call_status, sms_status)
     VALUES ($11,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [name, list_type, market_name, state_code?.toUpperCase(), notes||'', created_by||'team', start_date||null, channel, cold_call_status, sms_status, tenantId]
  );
  return res.rows[0];
}

async function closeCampaign(tenantId, id) {
  if (!Number.isInteger(tenantId)) throw new Error('closeCampaign: tenantId required');
  await query(
    `UPDATE campaigns SET status='completed', end_date=CURRENT_DATE, updated_at=NOW() WHERE id=$1 AND tenant_id=$2`,
    [id, tenantId]
  );
}

async function cloneCampaign(tenantId, id) {
  if (!Number.isInteger(tenantId)) throw new Error('cloneCampaign: tenantId required');
  const res = await query(`SELECT * FROM campaigns WHERE id=$1 AND tenant_id=$2`, [id, tenantId]);
  if (!res.rows.length) return null;
  const c = res.rows[0];
  const newCamp = await query(
    `INSERT INTO campaigns (tenant_id, name, list_type, market_name, state_code, notes, created_by, active_channel, cold_call_status, sms_status, start_date)
     VALUES ($10,$1,$2,$3,$4,$5,$6,$7,$8,$9,CURRENT_DATE) RETURNING *`,
    [c.name, c.list_type, c.market_name, c.state_code, c.notes, c.created_by, c.active_channel, c.cold_call_status, c.sms_status, tenantId]
  );
  return newCamp.rows[0];
}

async function updateCampaignStatus(tenantId, id, status) {
  if (!Number.isInteger(tenantId)) throw new Error('updateCampaignStatus: tenantId required');
  await query(`UPDATE campaigns SET status=$1, updated_at=NOW() WHERE id=$2 AND tenant_id=$3`, [status, id, tenantId]);
}

async function updateCampaignChannel(tenantId, id, channel) {
  if (!Number.isInteger(tenantId)) throw new Error('updateCampaignChannel: tenantId required');
  const cold = channel==='cold_call'?'active':'dormant';
  const sms  = channel==='sms'?'active':'dormant';
  await query(`UPDATE campaigns SET active_channel=$1, cold_call_status=$2, sms_status=$3, updated_at=NOW() WHERE id=$4 AND tenant_id=$5`, [channel, cold, sms, id, tenantId]);
}

// Per-campaign filter thresholds (Task 2). All fields optional in the input —
// missing keys are left untouched. Numeric thresholds are clamped to [0, 99].
async function updateCampaignFilters(tenantId, id, body) {
  if (!Number.isInteger(tenantId)) throw new Error('updateCampaignFilters: tenantId required');
  const idInt = parseInt(id, 10);
  if (!Number.isFinite(idInt) || idInt <= 0) return { ok: false, error: 'Invalid campaign id.' };
  const clampInt = (raw, def) => {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 0) return def;
    return Math.min(99, n);
  };
  const asBool = (raw) => raw === '1' || raw === 'on' || raw === 'true' || raw === true;
  await query(
    `UPDATE campaigns SET
       voicemail_threshold    = $1,
       hangup_threshold       = $2,
       exclude_dnc            = $3,
       exclude_wrong_number   = $4,
       exclude_not_in_service = $5,
       exclude_already_lead   = $6,
       updated_at             = NOW()
     WHERE id = $7 AND tenant_id = $8`,
    [
      clampInt(body.voicemail_threshold, 99),
      clampInt(body.hangup_threshold,    99),
      asBool(body.exclude_dnc),
      asBool(body.exclude_wrong_number),
      asBool(body.exclude_not_in_service),
      asBool(body.exclude_already_lead),
      idInt,
      tenantId,
    ]
  );
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2026-04-20 audit fix #B: rename a campaign.
// Returns { ok, campaign?, error? }. Trims whitespace, validates length,
// and checks the campaign exists. Uniqueness was dropped in the migration
// above so duplicate names are allowed — two campaigns with the same name
// across different markets or rounds is a legitimate use case.
// ─────────────────────────────────────────────────────────────────────────────
async function updateCampaignName(tenantId, id, rawName) {
  if (!Number.isInteger(tenantId)) throw new Error('updateCampaignName: tenantId required');
  const name = String(rawName || '').trim();
  if (!name) return { ok: false, error: 'Name is required.' };
  if (name.length > 255) return { ok: false, error: 'Name too long (max 255 characters).' };
  const idInt = parseInt(id, 10);
  if (!Number.isFinite(idInt) || idInt <= 0) return { ok: false, error: 'Invalid campaign id.' };
  const res = await query(
    `UPDATE campaigns SET name = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3 RETURNING *`,
    [name, idInt, tenantId]
  );
  if (!res.rows.length) return { ok: false, error: 'Campaign not found.' };
  return { ok: true, campaign: res.rows[0] };
}

// ── Contact list management ───────────────────────────────────────────────────

// Detect phone columns from CSV headers.
// Kept local (not imported from filtration.js) so this module can stay
// self-contained for the importContactList flow below.
function detectPhoneColumns(headers) {
  const phones = [];
  const excludePatterns = [
    /type/i, /status/i, /tag/i, /connected/i, /score/i, /representative/i,
    /dnc/i, /do\s*not\s*call/i, /litigator/i, /carrier/i, /line\s*type/i,
    /last\s*call/i, /call\s*count/i, /disposition/i
  ];
  const includePatterns = [
    /^(owner\s+)?(alt\.?\s+)?ph(one)?[\s_#]*\d*(\s+number)?$/i,
    /^phone\s+number\s*\d*$/i,
    /^(wireless|mobile|cell|landline|home|work)[\s_#]*\d*(\s+phone)?$/i,
    /^phone[\s_#]*\d+[\s_]*(number|#)?$/i,
  ];
  headers.forEach((col, idx) => {
    const lower = String(col || '').toLowerCase().trim();
    if (!lower) return;
    if (excludePatterns.some(ep => ep.test(lower))) return;
    if (includePatterns.some(pat => pat.test(lower))) {
      phones.push({ col, idx });
    }
  });
  return phones;
}

// ─────────────────────────────────────────────────────────────────────────────
// importContactList — MERGE semantics (decision #5).
//
// Rows are upserted by (campaign_id, row_index). Phones are upserted by
// (contact_id, slot_index); EXISTING history columns — filtered, wrong_number,
// last_disposition, phone_status=='Correct' or 'dead_number', cumulative_count,
// *_flagged_at timestamps — are PRESERVED unless the new CSV provides a strong
// signal to overwrite. "Unknown" coming from a re-upload never overwrites a
// stored known status. This eliminates the data loss that used to happen
// every time a user re-uploaded the same list.
// ─────────────────────────────────────────────────────────────────────────────
async function importContactList(tenantId, campaignId, rows, headers, customMapping) {
  if (!Number.isInteger(tenantId)) throw new Error('importContactList: tenantId required');
  if (!rows.length) return { total: 0 };

  const h = headers.map(x => x.toLowerCase().trim());
  const find = (opts) => {
    for (const o of opts) {
      const i = h.findIndex(x => x.includes(o.toLowerCase()));
      if (i > -1) return headers[i];
    }
    return null;
  };

  const autoDetect = {
    fname:    find(['first name', 'firstname']),
    lname:    find(['last name', 'lastname']),
    maddr:    find(['mailing address', 'mailing addr', 'owner street']),
    mcity:    find(['mailing city', 'owner city']),
    mstate:   find(['mailing state', 'owner state']),
    mzip:     find(['mailing zip', 'mailing zip5', 'owner zip']),
    mcounty:  find(['mailing county', 'county']),
    paddr:    find(['property address', 'property street']),
    pcity:    find(['property city']),
    pstate:   find(['property state']),
    pzip:     find(['property zip', 'property zip code']),
  };
  const COL = customMapping ? {
    fname:   customMapping.fname   || autoDetect.fname,
    lname:   customMapping.lname   || autoDetect.lname,
    maddr:   customMapping.maddr   || autoDetect.maddr,
    mcity:   customMapping.mcity   || autoDetect.mcity,
    mstate:  customMapping.mstate  || autoDetect.mstate,
    mzip:    customMapping.mzip    || autoDetect.mzip,
    mcounty: customMapping.mcounty || autoDetect.mcounty,
    paddr:   customMapping.paddr   || autoDetect.paddr,
    pcity:   customMapping.pcity   || autoDetect.pcity,
    pstate:  customMapping.pstate  || autoDetect.pstate,
    pzip:    customMapping.pzip    || autoDetect.pzip,
  } : autoDetect;

  const phoneCols = detectPhoneColumns(headers);

  // ──────────────────────────────────────────────────────────────────────────
  // MERGE: no DELETE FROM campaign_contacts. Every row is UPSERTed by
  // (campaign_id, row_index). Missing row_indices from a shorter re-upload
  // are left in place (they might have filter history worth keeping). If the
  // operator genuinely wants a "wipe" they can do it in the DB — this import
  // defaults to safe.
  // ──────────────────────────────────────────────────────────────────────────

  let imported = 0;
  const BATCH = 500;   // was 20. 500 × 13 params = 6500, well under PG's 64k limit.

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);

    // Build batch UPSERT for contacts
    const vals = [];
    const params = [];
    let p = 1;
    for (let j = 0; j < batch.length; j++) {
      const r = batch[j];
      const idx = i + j;
      // 14 cols including tenant_id
      vals.push(`($${p},$${p+1},$${p+2},$${p+3},$${p+4},$${p+5},$${p+6},$${p+7},$${p+8},$${p+9},$${p+10},$${p+11},$${p+12},$${p+13})`);
      // 2026-04-20 audit fix #1: route property_state + mailing_state through
      // normalizeState() so the records filter's UPPER(TRIM(property_state))
      // = UPPER(TRIM(p.state_code)) comparison actually matches. Before this,
      // a CSV with "Indiana" in the Property State column got stored as "In"
      // (VARCHAR(10) no-op + no normalization) while properties.state_code
      // holds "IN" — the join silently dropped every row and the marketing
      // filter returned 0. normalizeState() accepts both 2-letter codes and
      // full state names, returns null for garbage (in which case we store
      // the raw trimmed value so the row isn't lost, just flagged).
      const rawMstate = String(r[COL.mstate] || '').trim();
      const rawPstate = String(r[COL.pstate] || '').trim();
      const mstate = normalizeState(rawMstate) || rawMstate;
      const pstate = normalizeState(rawPstate) || rawPstate;
      params.push(
        campaignId,
        r[COL.fname]||'', r[COL.lname]||'',
        r[COL.maddr]||'', r[COL.mcity]||'', mstate, r[COL.mzip]||'', r[COL.mcounty]||'',
        r[COL.paddr]||'', r[COL.pcity]||'', pstate, r[COL.pzip]||'',
        idx,
        tenantId
      );
      p += 14;
    }

    const contactRes = await query(
      `INSERT INTO campaign_contacts
         (campaign_id, first_name, last_name, mailing_address, mailing_city,
          mailing_state, mailing_zip, mailing_county, property_address,
          property_city, property_state, property_zip, row_index, tenant_id)
       VALUES ${vals.join(',')}
       ON CONFLICT (campaign_id, row_index) DO UPDATE SET
         first_name       = COALESCE(NULLIF(EXCLUDED.first_name,''),       campaign_contacts.first_name),
         last_name        = COALESCE(NULLIF(EXCLUDED.last_name,''),        campaign_contacts.last_name),
         mailing_address  = COALESCE(NULLIF(EXCLUDED.mailing_address,''),  campaign_contacts.mailing_address),
         mailing_city     = COALESCE(NULLIF(EXCLUDED.mailing_city,''),     campaign_contacts.mailing_city),
         mailing_state    = COALESCE(NULLIF(EXCLUDED.mailing_state,''),    campaign_contacts.mailing_state),
         mailing_zip      = COALESCE(NULLIF(EXCLUDED.mailing_zip,''),      campaign_contacts.mailing_zip),
         mailing_county   = COALESCE(NULLIF(EXCLUDED.mailing_county,''),   campaign_contacts.mailing_county),
         property_address = COALESCE(NULLIF(EXCLUDED.property_address,''), campaign_contacts.property_address),
         property_city    = COALESCE(NULLIF(EXCLUDED.property_city,''),    campaign_contacts.property_city),
         property_state   = COALESCE(NULLIF(EXCLUDED.property_state,''),   campaign_contacts.property_state),
         property_zip     = COALESCE(NULLIF(EXCLUDED.property_zip,''),     campaign_contacts.property_zip),
         updated_at       = NOW()
       RETURNING id, row_index`,
      params
    );

    // Build batch UPSERT for phones.
    //
    // 2026-04-20 pass 11: Dedup by (contact_id, phone_number) before building
    // the VALUES list. Previously we pushed every non-empty phone column for
    // every contact row without checking — if a single CSV row had the same
    // phone in multiple columns (very common in county-sourced lists where
    // scrapers fill 3–5 phone slots with the same cleaned number), the batch
    // contained multiple rows targeting the same (contact_id, phone_number)
    // key. ON CONFLICT DO UPDATE can't touch the same target row twice in
    // one statement — PG throws 21000 "ON CONFLICT DO UPDATE command cannot
    // affect row a second time" and the entire upload dies. First occurrence
    // (= lowest slot_index) wins, which is also the canonical position for
    // that phone. Same pattern as server.js:1196 bulk CSV ingest.
    const phoneBucket = new Map();  // key = `${contactId}|${phone}`
    let phoneDupesCollapsed = 0;
    for (const cRow of contactRes.rows) {
      const r = batch[cRow.row_index - i];
      if (!r) continue;
      for (let s = 0; s < phoneCols.length; s++) {
        // 2026-04-20 pass 12: route through shared normalizePhone so a contact
        // file with "1-555-123-4567" stores the same 10-digit canonical key
        // as every other import path. Pre-pass-12 inline cleaning produced
        // "15551234567" here while filtration.js produced "5551234567" for
        // the same input — cross-path dedup and NIS matches silently missed.
        const phone = normalizePhone(r[phoneCols[s].col]);
        if (!phone || phone.length < 7) continue;
        const k = `${cRow.id}|${phone}`;
        if (phoneBucket.has(k)) { phoneDupesCollapsed++; continue; }
        phoneBucket.set(k, { contactId: cRow.id, phone, slot: s + 1 });
      }
    }

    const phoneVals = [];
    const phoneParams = [];
    let pp = 1;
    for (const p of phoneBucket.values()) {
      phoneVals.push(`($${pp},$${pp+1},$${pp+2},$${pp+3},$${pp+4})`);
      phoneParams.push(campaignId, p.contactId, p.phone, p.slot, tenantId);
      pp += 5;
    }

    if (phoneVals.length > 0) {
      await query(
        `INSERT INTO campaign_contact_phones
           (campaign_id, contact_id, phone_number, slot_index, tenant_id)
         VALUES ${phoneVals.join(',')}
         ON CONFLICT (contact_id, phone_number) DO UPDATE SET
           slot_index = EXCLUDED.slot_index,
           updated_at = NOW()`,
        phoneParams
      );
    }

    if (phoneDupesCollapsed > 0) {
      console.log(`[campaigns/upload] collapsed ${phoneDupesCollapsed} duplicate phone entries within batch (same contact, same number in multiple slots)`);
    }

    imported += batch.length;
  }

  // Auto-flag any phones that are already in the NIS database.
  // Scoped by campaign_id so only THIS campaign is touched (not a global
  // cross-campaign spread — that's decision #4, handled in filtration.js
  // for the explicit NIS upload flow).
  //   times_reported >= 3 → overrides any non-dead status
  //   times_reported  < 3 → only flags if current status is unknown/non-Correct
  await query(
    `UPDATE campaign_contact_phones
        SET phone_status = 'dead_number', nis_flagged_at = NOW()
      WHERE campaign_id = $1
        AND tenant_id = $2
        AND phone_status != 'dead_number'
        AND (
          phone_number IN (SELECT phone_number FROM nis_numbers WHERE tenant_id = $2 AND times_reported >= 3)
          OR (
            phone_number IN (SELECT phone_number FROM nis_numbers WHERE tenant_id = $2 AND times_reported < 3)
            AND (phone_status IS NULL OR phone_status != 'Correct')
          )
        )`,
    [campaignId, tenantId]
  );

  // Update campaign total_unique_numbers — count the distinct phones actually
  // in the contact list, not just imported rows (rows may have no phones).
  await query(`
    UPDATE campaigns SET
      total_unique_numbers = (
        SELECT COUNT(DISTINCT phone_number)
          FROM campaign_contact_phones
         WHERE campaign_id = $1 AND tenant_id = $2
      ),
      updated_at = NOW()
    WHERE id = $1 AND tenant_id = $2`,
    [campaignId, tenantId]
  );

  return { total: imported };
}

// Get all custom list types merged with defaults
const DEFAULT_LIST_TYPES = ['Vacant Property','Pre-Foreclosure','Active Liens','2+ Mortgages','Absentee Owner','Tax Delinquent','Probate','Code Violation','Pre-Probate','Other'];

async function getListTypes(tenantId) {
  if (!Number.isInteger(tenantId)) throw new Error('getListTypes: tenantId required');
  try {
    const res = await query(`SELECT name FROM custom_list_types WHERE tenant_id = $1 ORDER BY name ASC`, [tenantId]);
    const custom = res.rows.map(r => r.name);
    const seen = new Set(DEFAULT_LIST_TYPES.map(t => t.toLowerCase()));
    const merged = [...DEFAULT_LIST_TYPES];
    for (const c of custom) {
      if (!seen.has(c.toLowerCase())) {
        merged.push(c);
        seen.add(c.toLowerCase());
      }
    }
    const other = merged.filter(t => t === 'Other');
    const rest = merged.filter(t => t !== 'Other');
    return [...rest, ...other];
  } catch(e) {
    console.error('getListTypes error:', e.message);
    return DEFAULT_LIST_TYPES;
  }
}

async function addListType(tenantId, name) {
  if (!Number.isInteger(tenantId)) throw new Error('addListType: tenantId required');
  const clean = String(name || '').trim();
  if (!clean || clean.length > 100) return false;
  if (DEFAULT_LIST_TYPES.some(t => t.toLowerCase() === clean.toLowerCase())) return true;
  try {
    await query(`INSERT INTO custom_list_types (tenant_id, name) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`, [tenantId, clean]);
    return true;
  } catch(e) {
    console.error('addListType error:', e.message);
    return false;
  }
}

module.exports = {
  initCampaignSchema, getCampaigns, getCampaign, createCampaign,
  updateCampaignStatus, updateCampaignChannel, updateCampaignName,
  updateCampaignFilters,
  closeCampaign, cloneCampaign,
  importContactList, getListTypes, addListType,
  // Re-exported from filtration.js (the authoritative implementations)
  recordUpload:              filtration.recordUpload,
  applyFiltrationToContacts: filtration.applyFiltrationToContacts,
  generateCleanExport:       filtration.generateCleanExport,
  getContactStats:           filtration.getContactStats,
  detectPhoneColumns:        filtration.detectPhoneColumns,
  importNisFile:             filtration.importNisFile,
  getNisStats:               filtration.getNisStats,
  normalizePhone:            filtration.normalizePhone,
  importSmarterContactFile:  filtration.importSmarterContactFile,
  normSmsLabel:              filtration.normSmsLabel,
  importSmarterContactAccepted: filtration.importSmarterContactAccepted,
  getSmsNextBatch:              filtration.getSmsNextBatch,
  getSmsEligibleStats:          filtration.getSmsEligibleStats,
  ensureSmsEligibleColumns:     filtration.ensureSmsEligibleColumns,
};
