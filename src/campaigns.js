const { query } = require('./db');
const filtration = require('./filtration');

async function initCampaignSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
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
      name VARCHAR(100) NOT NULL UNIQUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS nis_numbers (
      phone_number VARCHAR(20) PRIMARY KEY,
      first_seen_nis DATE,
      last_seen_nis DATE,
      times_reported INTEGER DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_nis_last_seen ON nis_numbers(last_seen_nis);
  `);

  // Safe migrations — add columns if they don't exist
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
  ];
  for (const m of migrations) {
    try { await query(m); } catch(e) { console.error('Migration error:', e.message); }
  }
}

async function getCampaigns() {
  const res = await query(`SELECT * FROM campaigns ORDER BY created_at DESC`);
  return res.rows;
}

async function getCampaign(id) {
  const c = await query(`SELECT * FROM campaigns WHERE id=$1`, [id]);
  if (!c.rows.length) return null;
  const uploads = await query(`SELECT * FROM campaign_uploads WHERE campaign_id=$1 ORDER BY uploaded_at DESC LIMIT 30`, [id]);
  const disposition_breakdown = await query(`
    SELECT last_disposition_normalized as disposition, COUNT(*) as count
    FROM campaign_numbers WHERE campaign_id=$1
    GROUP BY last_disposition_normalized ORDER BY count DESC`, [id]);
  return { ...c.rows[0], uploads: uploads.rows, disposition_breakdown: disposition_breakdown.rows };
}

async function createCampaign({ name, list_type, market_name, state_code, notes, created_by, start_date }) {
  const res = await query(
    `INSERT INTO campaigns (name, list_type, market_name, state_code, notes, created_by, start_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [name, list_type, market_name, state_code?.toUpperCase(), notes||'', created_by||'team', start_date||null]
  );
  return res.rows[0];
}

async function closeCampaign(id) {
  await query(
    `UPDATE campaigns SET status='completed', end_date=CURRENT_DATE, updated_at=NOW() WHERE id=$1`,
    [id]
  );
}

async function cloneCampaign(id) {
  const res = await query(`SELECT * FROM campaigns WHERE id=$1`, [id]);
  if (!res.rows.length) return null;
  const c = res.rows[0];
  const newCamp = await query(
    `INSERT INTO campaigns (name, list_type, market_name, state_code, notes, created_by, active_channel, cold_call_status, sms_status, start_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,CURRENT_DATE) RETURNING *`,
    [c.name, c.list_type, c.market_name, c.state_code, c.notes, c.created_by, c.active_channel, c.cold_call_status, c.sms_status]
  );
  return newCamp.rows[0];
}

async function updateCampaignStatus(id, status) {
  await query(`UPDATE campaigns SET status=$1, updated_at=NOW() WHERE id=$2`, [status, id]);
}

async function updateCampaignChannel(id, channel) {
  const cold = channel==='cold_call'?'active':'dormant';
  const sms  = channel==='sms'?'active':'dormant';
  await query(`UPDATE campaigns SET active_channel=$1, cold_call_status=$2, sms_status=$3, updated_at=NOW() WHERE id=$4`, [channel, cold, sms, id]);
}

// ── Contact list management ───────────────────────────────────────────────────

// Detect phone columns from CSV headers
function detectPhoneColumns(headers) {
  const phones = [];
  // Exclude columns that CONTAIN phone-related words but aren't the number itself
  const excludePatterns = [
    /type/i, /status/i, /tag/i, /connected/i, /score/i, /representative/i,
    /dnc/i, /do\s*not\s*call/i, /litigator/i, /carrier/i, /line\s*type/i,
    /last\s*call/i, /call\s*count/i, /disposition/i
  ];
  // Include: anything that looks like a phone number slot
  // Matches: Phone, Phone1, Phone 1, Phone_1, Phone #1, Ph1, Ph#1,
  //          Phone 1 Number, Phone Number 1, Wireless 1, Mobile 1,
  //          Landline 1, Cell 1, Alt Phone, Owner Phone 1, etc.
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
  console.log('[detectPhoneColumns] headers:', headers.length, 'detected phone cols:', phones.map(p => p.col));
  return phones;
}

// Import original contact list CSV into campaign
async function importContactList(campaignId, rows, headers, customMapping) {
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
  // Use custom mapping if provided, fall back to auto-detected
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

  // Clear existing contacts for this campaign
  await query(`DELETE FROM campaign_contacts WHERE campaign_id=$1`, [campaignId]);

  let imported = 0;
  const BATCH = 20;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    
    // Build batch insert for contacts
    const vals = [];
    const params = [];
    let p = 1;
    for (let j = 0; j < batch.length; j++) {
      const r = batch[j];
      const idx = i + j;
      vals.push(`($${p},$${p+1},$${p+2},$${p+3},$${p+4},$${p+5},$${p+6},$${p+7},$${p+8},$${p+9},$${p+10},$${p+11},$${p+12})`);
      params.push(campaignId, r[COL.fname]||'', r[COL.lname]||'',
        r[COL.maddr]||'', r[COL.mcity]||'', r[COL.mstate]||'', r[COL.mzip]||'', r[COL.mcounty]||'',
        r[COL.paddr]||'', r[COL.pcity]||'', r[COL.pstate]||'', r[COL.pzip]||'', idx);
      p += 13;
    }

    const contactRes = await query(
      `INSERT INTO campaign_contacts
       (campaign_id, first_name, last_name, mailing_address, mailing_city, mailing_state, mailing_zip, mailing_county, property_address, property_city, property_state, property_zip, row_index)
       VALUES ${vals.join(',')}
       ON CONFLICT (campaign_id, row_index) DO UPDATE SET
         first_name=EXCLUDED.first_name, last_name=EXCLUDED.last_name,
         property_address=EXCLUDED.property_address
       RETURNING id, row_index`,
      params
    );

    // Build batch insert for phones
    const phoneVals = [];
    const phoneParams = [];
    let pp = 1;

    for (const cRow of contactRes.rows) {
      const r = batch[cRow.row_index - i];
      for (let s = 0; s < phoneCols.length; s++) {
        const phone = String(r[phoneCols[s].col]||'').replace(/\D/g,'');
        if (!phone || phone === '0' || phone.length < 7) continue;
        phoneVals.push(`($${pp},$${pp+1},$${pp+2},$${pp+3})`);
        phoneParams.push(campaignId, cRow.id, phone, s + 1);
        pp += 4;
      }
    }

    if (i === 0) {
      const sampleRow = batch[0] || {};
      console.log('[importContactList] phoneCols:', phoneCols.map(p => p.col));
      console.log('[importContactList] sample row phone values:',
        phoneCols.map(p => ({ col: p.col, val: sampleRow[p.col] })));
      console.log('[importContactList] phones extracted in first batch:', phoneVals.length);
      console.log('[importContactList] contactRes.rows sample:', contactRes.rows.slice(0, 3));
      console.log('[importContactList] phoneParams first 12:', phoneParams.slice(0, 12));
    }

    if (phoneVals.length > 0) {
      try {
        const phoneInsertRes = await query(
          `INSERT INTO campaign_contact_phones (campaign_id, contact_id, phone_number, slot_index)
           VALUES ${phoneVals.join(',')}
           ON CONFLICT (contact_id, slot_index) DO NOTHING
           RETURNING id`,
          phoneParams
        );
        if (i === 0) {
          console.log('[importContactList] PHONE INSERT SUCCESS — rows returned:', phoneInsertRes.rows.length, 'of', phoneVals.length, 'attempted');
        }
      } catch(phoneErr) {
        console.error('[importContactList] PHONE INSERT ERROR:', phoneErr.message);
        console.error('[importContactList] error code:', phoneErr.code, 'detail:', phoneErr.detail);
        console.error('[importContactList] first phoneVals:', phoneVals.slice(0, 2), 'first phoneParams:', phoneParams.slice(0, 8));
        throw phoneErr;
      }
    } else if (i === 0) {
      console.error('[importContactList] NO PHONES extracted from first batch');
    }

    imported += batch.length;
  }

  // Auto-flag any phones that are already in the NIS database
  // Rule: times_reported >= 3 overrides everything including Correct
  //       times_reported < 3 only flags unknown/non-Correct phones
  await query(
    `UPDATE campaign_contact_phones
     SET phone_status = 'dead_number', nis_flagged_at = NOW()
     WHERE campaign_id = $1
       AND phone_status != 'dead_number'
       AND (
         phone_number IN (SELECT phone_number FROM nis_numbers WHERE times_reported >= 3)
         OR (
           phone_number IN (SELECT phone_number FROM nis_numbers WHERE times_reported < 3)
           AND (phone_status IS NULL OR phone_status != 'Correct')
         )
       )`,
    [campaignId]
  );

  // Update campaign total_properties count
  await query(`UPDATE campaigns SET total_unique_numbers=$1, updated_at=NOW() WHERE id=$2`, [imported, campaignId]);

  return { total: imported };
}

// Apply filtration results to contact phones
async function applyFiltrationToContacts(campaignId, allRows) {
  for (const row of allRows) {
    const phone = String(row.Phone||'').replace(/\D/g,'');
    if (!phone) continue;
    const dispo = row._normDispo || '';
    const isWrong = dispo === 'wrong_number';
    const wasRemoved = row.Action === 'remove';
    const status = row['Phone Status'] || '';
    const tag = row['Phone Tag'] || '';
    const count = parseInt(row['Call Log Count']) || 1;

    await query(
      `UPDATE campaign_contact_phones SET
         phone_status = CASE WHEN phone_status = 'dead_number' THEN phone_status ELSE $1 END,
         phone_tag=$2,
         wrong_number = wrong_number OR $3,
         filtered = filtered OR $4,
         cumulative_count=$5, last_disposition=$6, updated_at=NOW()
       WHERE campaign_id=$7 AND phone_number=$8`,
      [status||'unknown', tag, isWrong, wasRemoved, count, row.Disposition||'', campaignId, phone]
    );
  }
}

// Generate clean export file — one row per contact, blanked wrong/filtered phones
async function generateCleanExport(campaignId) {
  const contacts = await query(
    `SELECT cc.*, array_agg(
       json_build_object(
         'phone', ccp.phone_number,
         'slot', ccp.slot_index,
         'status', ccp.phone_status,
         'wrong', ccp.wrong_number,
         'filtered', ccp.filtered,
         'tag', ccp.phone_tag
       ) ORDER BY ccp.slot_index
     ) as phones
     FROM campaign_contacts cc
     LEFT JOIN campaign_contact_phones ccp ON ccp.contact_id = cc.id
     WHERE cc.campaign_id = $1
     GROUP BY cc.id
     ORDER BY cc.row_index`,
    [campaignId]
  );

  const rows = [];
  let callable = 0, dead = 0;

  // Determine global max slot across ALL contacts so the header is consistent
  let globalMaxSlot = 1;
  for (const c of contacts.rows) {
    const phones = (c.phones||[]).filter(p => p && p.phone);
    for (const p of phones) {
      if (p.slot > globalMaxSlot) globalMaxSlot = p.slot;
    }
  }
  // Cap at 10 — Readymode only accepts Ph#1..Ph#10
  if (globalMaxSlot > 10) globalMaxSlot = 10;

  for (const c of contacts.rows) {
    const phones = (c.phones||[]).filter(p => p && p.phone);
    const callablePhones = phones.filter(p => !p.wrong && !p.filtered && p.status !== 'dead_number');

    if (callablePhones.length === 0) { dead++; continue; } // all phones dead — skip row
    callable++;

    const row = {
      'First Name': c.first_name,
      'Last Name': c.last_name,
      'Mailing Address': c.mailing_address,
      'Mailing City': c.mailing_city,
      'Mailing State': c.mailing_state,
      'Mailing Zip': c.mailing_zip,
      'Mailing County': c.mailing_county,
      'Property Address': c.property_address,
      'Property City': c.property_city,
      'Property State': c.property_state,
      'Property Zip': c.property_zip,
    };

    // Fill every phone slot 1..globalMaxSlot for EVERY row — ensures consistent columns
    for (let s = 1; s <= globalMaxSlot; s++) {
      const ph = phones.find(p => p.slot === s);
      if (ph && !ph.wrong && !ph.filtered && ph.status !== 'dead_number') {
        row[`Ph#${s}`] = ph.phone;
      } else {
        row[`Ph#${s}`] = '';
      }
    }

    rows.push(row);
  }

  // Update campaign callable count
  await query(
    `UPDATE campaigns SET total_callable=$1, updated_at=NOW() WHERE id=$2`,
    [callable, campaignId]
  );

  return { rows, callable, dead };
}

// Get contact list stats for campaign
async function getContactStats(campaignId) {
  const res = await query(`
    SELECT
      COUNT(DISTINCT cc.id) as total_contacts,
      COUNT(DISTINCT CASE WHEN ccp.wrong_number = true THEN ccp.id END) as wrong_phones,
      COUNT(DISTINCT CASE WHEN ccp.phone_status = 'dead_number' THEN ccp.id END) as nis_phones,
      COUNT(DISTINCT CASE WHEN ccp.filtered = true AND ccp.wrong_number = false THEN ccp.id END) as filtered_phones,
      COUNT(DISTINCT CASE WHEN ccp.phone_status = 'Correct' THEN ccp.id END) as correct_phones,
      COUNT(DISTINCT ccp.id) as total_phones
    FROM campaign_contacts cc
    LEFT JOIN campaign_contact_phones ccp ON ccp.contact_id = cc.id
    WHERE cc.campaign_id = $1`, [campaignId]);

  // Count contacts where at least one phone has a live-pickup disposition
  const LIVE_PICKUPS = ['not_interested','transfer','callback','hung_up','spanish_speaker','do_not_call','completed','disqualified'];
  const reached = await query(`
    SELECT COUNT(DISTINCT cc.id) as reached_contacts
    FROM campaign_contacts cc
    JOIN campaign_contact_phones ccp ON ccp.contact_id = cc.id
    JOIN campaign_numbers cn ON cn.phone_number = ccp.phone_number AND cn.campaign_id = cc.campaign_id
    WHERE cc.campaign_id = $1
      AND cn.last_disposition_normalized = ANY($2::text[])`,
    [campaignId, LIVE_PICKUPS]);

  // Count contacts where at least one phone converted to a lead (transfer)
  const leads = await query(`
    SELECT COUNT(DISTINCT cc.id) as lead_contacts
    FROM campaign_contacts cc
    JOIN campaign_contact_phones ccp ON ccp.contact_id = cc.id
    JOIN campaign_numbers cn ON cn.phone_number = ccp.phone_number AND cn.campaign_id = cc.campaign_id
    WHERE cc.campaign_id = $1
      AND cn.last_disposition_normalized = 'transfer'`,
    [campaignId]);

  return {
    ...res.rows[0],
    reached_contacts: parseInt(reached.rows[0]?.reached_contacts||0),
    lead_contacts: parseInt(leads.rows[0]?.lead_contacts||0)
  };
}

// Get all custom list types (saved by users) merged with defaults
const DEFAULT_LIST_TYPES = ['Vacant Property','Pre-Foreclosure','Active Liens','2+ Mortgages','Absentee Owner','Tax Delinquent','Probate','Code Violation','Pre-Probate','Other'];

async function getListTypes() {
  try {
    const res = await query(`SELECT name FROM custom_list_types ORDER BY name ASC`);
    const custom = res.rows.map(r => r.name);
    // Merge: defaults first, then custom ones not already in defaults
    const seen = new Set(DEFAULT_LIST_TYPES.map(t => t.toLowerCase()));
    const merged = [...DEFAULT_LIST_TYPES];
    for (const c of custom) {
      if (!seen.has(c.toLowerCase())) {
        merged.push(c);
        seen.add(c.toLowerCase());
      }
    }
    // Put 'Other' at the end if present
    const other = merged.filter(t => t === 'Other');
    const rest = merged.filter(t => t !== 'Other');
    return [...rest, ...other];
  } catch(e) {
    console.error('getListTypes error:', e.message);
    return DEFAULT_LIST_TYPES;
  }
}

async function addListType(name) {
  const clean = String(name || '').trim();
  if (!clean || clean.length > 100) return false;
  // Don't save defaults as custom
  if (DEFAULT_LIST_TYPES.some(t => t.toLowerCase() === clean.toLowerCase())) return true;
  try {
    await query(`INSERT INTO custom_list_types (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [clean]);
    return true;
  } catch(e) {
    console.error('addListType error:', e.message);
    return false;
  }
}

module.exports = {
  initCampaignSchema, getCampaigns, getCampaign, createCampaign,
  updateCampaignStatus, updateCampaignChannel, closeCampaign, cloneCampaign,
  importContactList, getListTypes, addListType,
  // Re-exported from filtration.js
  recordUpload:              filtration.recordUpload,
  applyFiltrationToContacts: filtration.applyFiltrationToContacts,
  generateCleanExport:       filtration.generateCleanExport,
  getContactStats:           filtration.getContactStats,
  detectPhoneColumns:        filtration.detectPhoneColumns,
  importNisFile:             filtration.importNisFile,
  getNisStats:               filtration.getNisStats,
  normalizePhone:            filtration.normalizePhone,
};
