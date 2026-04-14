// ─────────────────────────────────────────────────────────────────────────────
// filtration.js — HudREI Loki
// Handles: call log filtration, NIS numbers, contact list phone management
// Extracted from campaigns.js — April 2026
// ─────────────────────────────────────────────────────────────────────────────

const { query } = require('./db');

// ── Normalize a phone number — strip non-digits, strip leading 1 if 11 digits ─
function normalizePhone(raw) {
  let p = String(raw || '').replace(/\D/g, '');
  if (p.length === 11 && p.startsWith('1')) p = p.substring(1);
  return p;
}

// ── Detect phone columns from CSV headers ─────────────────────────────────────
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
  console.log('[detectPhoneColumns] headers:', headers.length, 'detected phone cols:', phones.map(p => p.col));
  return phones;
}

// ── Record a filtration upload — write to campaign_numbers + campaign totals ──
async function recordUpload(campaignId, filename, sourceListName, channel, rows, rawTotal) {
  const CONNECTED_DISPOS = new Set(['not_interested','transfer','callback','spanish_speaker','hung_up','completed','disqualified','do_not_call']);
  const tally = { total:0, kept:0, filtered:0, wrong:0, vm:0, ni:0, dnc:0, transfer:0, mem:0, newNums:0, connected:0 };

  for (const row of rows) {
    tally.total++;
    if (row.Action === 'remove') tally.filtered++; else tally.kept++;
    const d = row._normDispo || '';
    if (d === 'wrong_number') tally.wrong++;
    if (d === 'voicemail') tally.vm++;
    if (d === 'not_interested') tally.ni++;
    if (d === 'do_not_call') tally.dnc++;
    if (d === 'transfer') tally.transfer++;
    if (row._caughtByMemory) tally.mem++;
    if (CONNECTED_DISPOS.has(d)) tally.connected++;

    const phone = String(row.Phone || '').replace(/\D/g, '');
    if (!phone) continue;

    const existing = await query(
      `SELECT id, cumulative_count FROM campaign_numbers WHERE campaign_id=$1 AND phone_number=$2`,
      [campaignId, phone]
    );
    const cumCount = parseInt(row['Call Log Count']) || 1;
    const status = row.Action === 'remove' ? 'filtered' : 'callable';

    if (!existing.rows.length) {
      tally.newNums++;
      await query(
        `INSERT INTO campaign_numbers (campaign_id, phone_number, last_disposition, last_disposition_normalized, cumulative_count, current_status, phone_status, phone_tag, marketing_result, total_appearances)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1)`,
        [campaignId, phone, row.Disposition || '', d, cumCount, status, row['Phone Status'] || '', row['Phone Tag'] || '', row['Marketing Results'] || '']
      );
    } else {
      await query(
        `UPDATE campaign_numbers SET last_disposition=$1, last_disposition_normalized=$2, cumulative_count=$3, current_status=$4, phone_status=$5, phone_tag=$6, marketing_result=$7, last_seen_at=NOW(), total_appearances=total_appearances+1
         WHERE campaign_id=$8 AND phone_number=$9`,
        [row.Disposition || '', d, cumCount, status, row['Phone Status'] || '', row['Phone Tag'] || '', row['Marketing Results'] || '', campaignId, phone]
      );
    }
  }

  // Insert upload record
  await query(
    `INSERT INTO campaign_uploads (campaign_id, filename, source_list_name, channel, total_records, new_unique_numbers, records_kept, records_filtered, wrong_numbers, voicemails, not_interested, do_not_call, transfers, caught_by_memory, connected)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [campaignId, filename, sourceListName, channel, rawTotal||tally.total, tally.newNums, tally.kept, tally.filtered, tally.wrong, tally.vm, tally.ni, tally.dnc, tally.transfer, tally.mem, tally.connected]
  );

  // Update campaign totals
  const totals = await query(`
    SELECT COUNT(*) as unique_numbers,
      SUM(CASE WHEN current_status='callable' THEN 1 ELSE 0 END) as callable,
      SUM(CASE WHEN current_status='filtered' THEN 1 ELSE 0 END) as filtered
    FROM campaign_numbers WHERE campaign_id=$1`, [campaignId]);
  const t = totals.rows[0];
  await query(
    `UPDATE campaigns SET
       total_unique_numbers=$1, total_callable=$2, total_filtered=$3,
       total_wrong_numbers=total_wrong_numbers+$4,
       total_voicemails=total_voicemails+$5,
       total_not_interested=total_not_interested+$6,
       total_do_not_call=total_do_not_call+$7,
       total_transfers=total_transfers+$8,
       total_connected=COALESCE(total_connected,0)+$9,
       upload_count=upload_count+1,
       last_filtered_at=NOW(), updated_at=NOW()
     WHERE id=$10`,
    [t.unique_numbers, t.callable, t.filtered, tally.wrong, tally.vm, tally.ni, tally.dnc, tally.transfer, tally.connected, campaignId]
  );

  return tally;
}

// ── Apply filtration results to contact phones (with flagged_at timestamps) ───
async function applyFiltrationToContacts(campaignId, allRows) {
  for (const row of allRows) {
    const phone = String(row.Phone || '').replace(/\D/g, '');
    if (!phone) continue;

    const dispo = row._normDispo || '';
    const isWrong = dispo === 'wrong_number';
    const wasRemoved = row.Action === 'remove';
    const status = row['Phone Status'] || '';
    const tag = row['Phone Tag'] || '';
    const count = parseInt(row['Call Log Count']) || 1;

    // Determine if this is a "Correct" confirmation (live pickup dispositions)
    const isCorrect = ['not_interested', 'transfer', 'callback', 'do_not_call',
                       'spanish_speaker', 'hung_up', 'completed', 'disqualified'].includes(dispo);

    await query(
      `UPDATE campaign_contact_phones SET
         phone_status = CASE WHEN phone_status = 'dead_number' THEN phone_status ELSE $1 END,
         phone_tag = $2,
         wrong_number = wrong_number OR $3,
         filtered = filtered OR $4,
         cumulative_count = $5,
         last_disposition = $6,
         updated_at = NOW(),
         -- wrong_number_flagged_at: set only on first confirmation, never overwrite
         wrong_number_flagged_at = CASE
           WHEN $3 = true AND wrong_number_flagged_at IS NULL THEN NOW()
           ELSE wrong_number_flagged_at
         END,
         -- correct_flagged_at: refresh timer on every live pickup confirmation
         correct_flagged_at = CASE
           WHEN $7 = true THEN NOW()
           ELSE correct_flagged_at
         END
       WHERE campaign_id = $8 AND phone_number = $9`,
      [status || 'unknown', tag, isWrong, wasRemoved, count, row.Disposition || '', isCorrect, campaignId, phone]
    );

    // If Transfer — flag lead at property level + mark phone correct globally
    if (dispo === 'transfer') {
      // 1. Flag campaign contact as Lead
      await query(
        `UPDATE campaign_contacts cc
         SET marketing_result = 'Lead'
         FROM campaign_contact_phones ccp
         WHERE ccp.contact_id = cc.id
           AND ccp.campaign_id = $1
           AND ccp.phone_number = $2
           AND cc.campaign_id = $1`,
        [campaignId, phone]
      );

      // 2. Flag the specific property as lead in the main properties table
      // Find property via campaign_contacts → property address match
      await query(
        `UPDATE properties p SET pipeline_stage = 'lead', updated_at = NOW()
         FROM campaign_contacts cc
         JOIN campaign_contact_phones ccp ON ccp.contact_id = cc.id
         WHERE cc.campaign_id = $1
           AND ccp.phone_number = $2
           AND p.street = cc.property_address
           AND p.state_code = cc.property_state
           AND p.pipeline_stage NOT IN ('contract','closed')`,
        [campaignId, phone]
      );

      // 3. Mark phone as correct in global phones table
      await query(
        `UPDATE phones SET phone_status = 'correct', updated_at = NOW()
         WHERE phone_number = $1`,
        [phone]
      );
    }
  }
}

// ── Generate clean export — one row per contact, blanked wrong/filtered phones ─
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
       AND (cc.marketing_result IS NULL OR cc.marketing_result != 'Lead')
     GROUP BY cc.id
     ORDER BY cc.row_index`,
    [campaignId]
  );

  const rows = [];
  let callable = 0, dead = 0;

  // Global max slot across ALL contacts — ensures consistent headers
  let globalMaxSlot = 1;
  for (const c of contacts.rows) {
    const phones = (c.phones || []).filter(p => p && p.phone);
    for (const p of phones) {
      if (p.slot > globalMaxSlot) globalMaxSlot = p.slot;
    }
  }
  if (globalMaxSlot > 10) globalMaxSlot = 10; // Cap at 10 for Readymode

  for (const c of contacts.rows) {
    const phones = (c.phones || []).filter(p => p && p.phone);
    const callablePhones = phones.filter(p => !p.wrong && !p.filtered && p.status !== 'dead_number');

    if (callablePhones.length === 0) { dead++; continue; }
    callable++;

    const row = {
      'First Name':       c.first_name,
      'Last Name':        c.last_name,
      'Mailing Address':  c.mailing_address,
      'Mailing City':     c.mailing_city,
      'Mailing State':    c.mailing_state,
      'Mailing Zip':      c.mailing_zip,
      'Mailing County':   c.mailing_county,
      'Property Address': c.property_address,
      'Property City':    c.property_city,
      'Property State':   c.property_state,
      'Property Zip':     c.property_zip,
    };

    for (let s = 1; s <= globalMaxSlot; s++) {
      const ph = phones.find(p => p.slot === s);
      row[`Ph#${s}`] = (ph && !ph.wrong && !ph.filtered && ph.status !== 'dead_number') ? ph.phone : '';
    }

    rows.push(row);
  }

  await query(
    `UPDATE campaigns SET total_callable=$1, updated_at=NOW() WHERE id=$2`,
    [callable, campaignId]
  );

  return { rows, callable, dead };
}

// ── Get contact list stats for a campaign ────────────────────────────────────
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

  const LIVE_PICKUPS = ['not_interested','transfer','callback','hung_up','spanish_speaker','do_not_call','completed','disqualified'];
  const reached = await query(`
    SELECT COUNT(DISTINCT cc.id) as reached_contacts
    FROM campaign_contacts cc
    JOIN campaign_contact_phones ccp ON ccp.contact_id = cc.id
    JOIN campaign_numbers cn ON cn.phone_number = ccp.phone_number AND cn.campaign_id = cc.campaign_id
    WHERE cc.campaign_id = $1
      AND cn.last_disposition_normalized = ANY($2::text[])`,
    [campaignId, LIVE_PICKUPS]);

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
    reached_contacts: parseInt(reached.rows[0]?.reached_contacts || 0),
    lead_contacts:    parseInt(leads.rows[0]?.lead_contacts || 0)
  };
}

// ── Import NIS file (Readymode Detailed NIS export) ───────────────────────────
async function importNisFile(rows) {
  let inserted = 0, updated = 0, flagged = 0;
  const BATCH = 500;

  const phoneMap = new Map();
  for (const r of rows) {
    const phone = normalizePhone(r.dialed || r.Dialed || r.phone || '');
    if (!phone || phone.length < 10) continue;
    const dayRaw = r.day || r.Day || '';
    let day = null;
    if (dayRaw) {
      const parsed = new Date(dayRaw);
      if (!isNaN(parsed)) day = parsed.toISOString().split('T')[0];
    }
    if (!phoneMap.has(phone)) {
      phoneMap.set(phone, { phone, first: day, last: day, count: 1 });
    } else {
      const e = phoneMap.get(phone);
      e.count++;
      if (day && (!e.first || day < e.first)) e.first = day;
      if (day && (!e.last  || day > e.last))  e.last  = day;
    }
  }

  const entries = Array.from(phoneMap.values());

  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = entries.slice(i, i + BATCH);
    const vals = [];
    const params = [];
    let p = 1;
    for (const e of batch) {
      vals.push(`($${p},$${p+1},$${p+2},$${p+3})`);
      params.push(e.phone, e.first, e.last, e.count);
      p += 4;
    }
    const res = await query(
      `INSERT INTO nis_numbers (phone_number, first_seen_nis, last_seen_nis, times_reported)
       VALUES ${vals.join(',')}
       ON CONFLICT (phone_number) DO UPDATE SET
         last_seen_nis    = GREATEST(nis_numbers.last_seen_nis, EXCLUDED.last_seen_nis),
         first_seen_nis   = LEAST(nis_numbers.first_seen_nis, EXCLUDED.first_seen_nis),
         times_reported   = nis_numbers.times_reported + EXCLUDED.times_reported,
         updated_at       = NOW()
       RETURNING (xmax = 0) AS inserted`,
      params
    );
    for (const row of res.rows) {
      if (row.inserted) inserted++; else updated++;
    }
  }

  // Retroactively flag matching phones across all campaigns
  // Rule: times_reported >= 3 overrides everything including Correct
  //       times_reported < 3 only flags unknown/non-Correct phones
  const flagRes = await query(
    `UPDATE campaign_contact_phones
     SET phone_status = 'dead_number', nis_flagged_at = NOW()
     WHERE phone_status != 'dead_number'
       AND (
         phone_number IN (SELECT phone_number FROM nis_numbers WHERE times_reported >= 3)
         OR (
           phone_number IN (SELECT phone_number FROM nis_numbers WHERE times_reported < 3)
           AND (phone_status IS NULL OR phone_status != 'Correct')
         )
       )`
  );
  flagged = flagRes.rowCount || 0;

  return { totalRows: rows.length, uniqueNumbers: entries.length, inserted, updated, flagged };
}

// ── Get NIS stats ─────────────────────────────────────────────────────────────
async function getNisStats() {
  try {
    const total      = await query(`SELECT COUNT(*) as c FROM nis_numbers`);
    const lastUpload = await query(`SELECT MAX(updated_at) as t FROM nis_numbers`);
    const flagged    = await query(`SELECT COUNT(*) as c FROM campaign_contact_phones WHERE phone_status = 'dead_number'`);
    return {
      total_nis:     parseInt(total.rows[0]?.c || 0),
      last_upload:   lastUpload.rows[0]?.t || null,
      total_flagged: parseInt(flagged.rows[0]?.c || 0),
    };
  } catch (e) {
    console.error('getNisStats error:', e.message);
    return { total_nis: 0, last_upload: null, total_flagged: 0 };
  }
}

// ── SMS: Import SmarterContact Labels export ──────────────────────────────────
// Required columns: Phone, Labels, First name, Last name,
//                   Property address, Property city, Property state, Property zip
// Rules:
//   - Missing required columns → reject entire upload
//   - Any row with multiple labels (pipe-separated) → reject entire upload
//   - One label per row, applied immediately (no cumulative counting)

const SMS_REQUIRED_COLS = ['phone', 'labels', 'first name', 'last name', 'property address', 'property city', 'property state', 'property zip'];

// Strip the SMC campaign-code prefix (e.g. "C2|Wrong Number" -> "Wrong Number")
// and any trailing emoji/whitespace. Returns the cleaned label string.
function stripSmsLabelPrefix(rawLabel) {
  let s = String(rawLabel || '').trim();
  if (!s) return '';
  // SMC format: "<campaign code>|<label name>" — exactly ONE pipe expected
  const pipes = (s.match(/\|/g) || []).length;
  if (pipes === 1) {
    s = s.split('|')[1].trim();
  }
  // Strip trailing emojis and any non-letter punctuation at the end
  // (preserves things like "Not Interested" but cleans "Not interested 📞")
  s = s.replace(/[\s\p{Extended_Pictographic}\p{Emoji_Presentation}]+$/u, '').trim();
  return s;
}

// Label → normalized disposition
function normSmsLabel(label) {
  const cleaned = stripSmsLabelPrefix(label);
  const l = cleaned.toLowerCase().trim();
  if (l === 'wrong number')   return 'wrong_number';
  if (l === 'not interested') return 'not_interested';
  if (l === 'lead')           return 'transfer';
  if (l === 'appointment')    return 'transfer';
  if (l === 'disqualified')   return 'disqualified';
  // CRM Transferred, Potential Lead, No answer, New, Left voicemail → no action
  return 'no_action';
}

async function importSmarterContactFile(campaignId, rows, headers) {
  // ── Step 1: Validate required columns ──────────────────────────────────────
  const headerLower = headers.map(h => String(h || '').toLowerCase().trim());
  const missingCols = SMS_REQUIRED_COLS.filter(req => !headerLower.includes(req));
  if (missingCols.length > 0) {
    return {
      success: false,
      error: `Missing required columns: ${missingCols.map(c => c.charAt(0).toUpperCase() + c.slice(1)).join(', ')}. Please check your SmarterContact export before uploading.`,
    };
  }

  // Map original header names (preserve case for row lookup)
  const findHeader = (req) => headers.find(h => String(h || '').toLowerCase().trim() === req);
  const COL = {
    phone:    findHeader('phone'),
    labels:   findHeader('labels'),
    fname:    findHeader('first name'),
    lname:    findHeader('last name'),
    paddr:    findHeader('property address'),
    pcity:    findHeader('property city'),
    pstate:   findHeader('property state'),
    pzip:     findHeader('property zip'),
  };

  // ── Step 2: Validate no MULTIPLE labels in any row ────────────────────────
  // SMC format is "<campaign code>|<label>" (1 pipe = normal).
  // 2+ pipes means the row has multiple labels concatenated, which we reject.
  const multiLabelRows = [];
  for (let i = 0; i < rows.length; i++) {
    const labelVal = String(rows[i][COL.labels] || '').trim();
    const pipeCount = (labelVal.match(/\|/g) || []).length;
    if (pipeCount >= 2) {
      multiLabelRows.push({ row: i + 2, phone: rows[i][COL.phone] || 'unknown', labels: labelVal });
    }
  }
  if (multiLabelRows.length > 0) {
    const examples = multiLabelRows.slice(0, 5).map(r => `Row ${r.row} (${r.phone}): "${r.labels}"`).join(', ');
    return {
      success: false,
      error: `Multiple labels detected on ${multiLabelRows.length} row(s). Each contact must have exactly one label in SmarterContact. Clean these in SMC and re-export. Examples: ${examples}`,
    };
  }

  // ── Step 3: Process rows ──────────────────────────────────────────────────
  const tally = { total: 0, wrong: 0, ni: 0, transfer: 0, disqualified: 0, no_action: 0, unmatched: 0 };

  for (const row of rows) {
    tally.total++;
    const phone = normalizePhone(row[COL.phone] || '');
    if (!phone) { tally.unmatched++; continue; }

    const label    = String(row[COL.labels] || '').trim();
    const dispo    = normSmsLabel(label);

    // Find the contact-phone record in this campaign
    const phoneRes = await query(
      `SELECT ccp.id, ccp.contact_id, ccp.phone_status
       FROM campaign_contact_phones ccp
       WHERE ccp.campaign_id = $1 AND ccp.phone_number = $2
       LIMIT 1`,
      [campaignId, phone]
    );

    if (!phoneRes.rows.length) { tally.unmatched++; continue; }
    const phoneRow = phoneRes.rows[0];

    if (dispo === 'no_action') {
      tally.no_action++;
      continue;
    }

    if (dispo === 'wrong_number') {
      tally.wrong++;
      await query(
        `UPDATE campaign_contact_phones SET
           wrong_number = true,
           phone_status = 'Wrong',
           wrong_number_flagged_at = CASE WHEN wrong_number_flagged_at IS NULL THEN NOW() ELSE wrong_number_flagged_at END,
           last_disposition = $1,
           updated_at = NOW()
         WHERE id = $2`,
        [label, phoneRow.id]
      );
    }

    if (dispo === 'not_interested') {
      tally.ni++;
      await query(
        `UPDATE campaign_contact_phones SET
           filtered = true,
           last_disposition = $1,
           updated_at = NOW()
         WHERE id = $2`,
        [label, phoneRow.id]
      );
    }

    if (dispo === 'disqualified') {
      tally.disqualified++;
      await query(
        `UPDATE campaign_contact_phones SET
           filtered = true,
           phone_status = 'Correct',
           correct_flagged_at = NOW(),
           last_disposition = $1,
           updated_at = NOW()
         WHERE id = $2`,
        [label, phoneRow.id]
      );
    }

    if (dispo === 'transfer') {
      tally.transfer++;
      // Mark phone as correct + filtered
      await query(
        `UPDATE campaign_contact_phones SET
           filtered = true,
           phone_status = 'Correct',
           correct_flagged_at = NOW(),
           last_disposition = $1,
           updated_at = NOW()
         WHERE id = $2`,
        [label, phoneRow.id]
      );
      // Flag the contact as Lead for this campaign
      await query(
        `UPDATE campaign_contacts SET marketing_result = 'Lead'
         WHERE id = $1`,
        [phoneRow.contact_id]
      );
    }
  }

  // ── Step 4: Update campaign totals ────────────────────────────────────────
  await query(
    `UPDATE campaigns SET
       total_wrong_numbers = total_wrong_numbers + $1,
       total_not_interested = total_not_interested + $2,
       total_transfers = total_transfers + $3,
       upload_count = upload_count + 1,
       last_filtered_at = NOW(),
       updated_at = NOW()
     WHERE id = $4`,
    [tally.wrong, tally.ni, tally.transfer, campaignId]
  );

  return {
    success: true,
    tally: {
      total:        tally.total,
      wrong:        tally.wrong,
      not_interested: tally.ni,
      leads:        tally.transfer,
      disqualified: tally.disqualified,
      no_action:    tally.no_action,
      unmatched:    tally.unmatched,
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SMC ACCEPTED CONTACTS — textability validator
// SmarterContact strips landlines on upload; the "accepted" export tells us
// exactly which phones SMC will actually send SMS to. We mirror that here.
// ─────────────────────────────────────────────────────────────────────────────

const SMC_ACCEPTED_REQUIRED_COLS = ['phone'];

async function ensureSmsEligibleColumns() {
  await query(`
    ALTER TABLE campaign_contact_phones
      ADD COLUMN IF NOT EXISTS sms_eligible BOOLEAN DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS sms_eligible_checked_at TIMESTAMP
  `);
}

async function importSmarterContactAccepted(campaignId, rows, headers) {
  await ensureSmsEligibleColumns();

  // ── Step 1: Validate required columns ──────────────────────────────────────
  const headerLower = headers.map(h => String(h || '').toLowerCase().trim());
  const missing = SMC_ACCEPTED_REQUIRED_COLS.filter(req => !headerLower.includes(req));
  if (missing.length > 0) {
    return {
      success: false,
      error: `Missing required column: ${missing.join(', ')}. The SmarterContact accepted-contacts export must include a "Phone" column.`,
    };
  }

  const findHeader = (req) => headers.find(h => String(h || '').toLowerCase().trim() === req);
  const phoneCol = findHeader('phone');

  // ── Step 2: Build set of accepted phones ──────────────────────────────────
  const acceptedSet = new Set();
  let invalidRows = 0;
  for (const row of rows) {
    const p = normalizePhone(row[phoneCol] || '');
    if (p && p.length === 10) acceptedSet.add(p);
    else invalidRows++;
  }

  if (acceptedSet.size === 0) {
    return {
      success: false,
      error: `No valid phone numbers found in the upload. Check the Phone column.`,
    };
  }

  // ── Step 3: Mark accepted phones as sms_eligible = true ───────────────────
  const acceptedArr = Array.from(acceptedSet);
  const updRes = await query(
    `UPDATE campaign_contact_phones
        SET sms_eligible = true,
            sms_eligible_checked_at = NOW(),
            updated_at = NOW()
      WHERE campaign_id = $1
        AND phone_number = ANY($2::text[])`,
    [campaignId, acceptedArr]
  );
  const matched = updRes.rowCount || 0;
  // Note: matched can EXCEED acceptedSet.size when the same phone appears
  // under multiple contacts in the master list (each is its own DB row).
  // unmatched = phones in the file with no DB row at all (clamped to >= 0).
  const unmatched = Math.max(0, acceptedSet.size - matched);
  const phoneRowsExpanded = Math.max(0, matched - acceptedSet.size);

  // ── Step 4: Mark every other phone in this campaign as ineligible ─────────
  // (these are the landlines/rejects SMC stripped out)
  const rejRes = await query(
    `UPDATE campaign_contact_phones
        SET sms_eligible = false,
            sms_eligible_checked_at = NOW(),
            updated_at = NOW()
      WHERE campaign_id = $1
        AND NOT (phone_number = ANY($2::text[]))
        AND (sms_eligible IS DISTINCT FROM false)`,
    [campaignId, acceptedArr]
  );
  const rejected = rejRes.rowCount || 0;

  console.log(`[smc/accepted] campaign ${campaignId} — file_rows:${rows.length} unique_phones_in_file:${acceptedSet.size} db_rows_marked_eligible:${matched} phones_unmatched:${unmatched} duplicate_phone_rows_in_master:${phoneRowsExpanded} db_rows_marked_ineligible:${rejected} invalid_phone_format:${invalidRows}`);

  return {
    success: true,
    tally: {
      total:     rows.length,
      accepted:  matched,
      rejected:  rejected,
      unmatched: unmatched,
      invalid:   invalidRows,
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// NEXT SMS BATCH — clean remarket list
// Phones in this campaign that are SMS-eligible AND haven't been responded
// against (not filtered, not wrong number). This is your "clean 800."
// ─────────────────────────────────────────────────────────────────────────────
async function getSmsNextBatch(campaignId) {
  await ensureSmsEligibleColumns();
  const res = await query(
    `SELECT
        cc.first_name,
        cc.last_name,
        cc.property_address,
        cc.property_city,
        cc.property_state,
        cc.property_zip,
        ccp.phone_number,
        ccp.phone_status,
        ccp.last_disposition
       FROM campaign_contact_phones ccp
       JOIN campaign_contacts cc ON cc.id = ccp.contact_id
      WHERE ccp.campaign_id = $1
        AND ccp.sms_eligible = true
        AND COALESCE(ccp.filtered, false) = false
        AND COALESCE(ccp.wrong_number, false) = false
      ORDER BY cc.last_name, cc.first_name, ccp.phone_number`,
    [campaignId]
  );
  return res.rows;
}

async function getSmsEligibleStats(campaignId) {
  await ensureSmsEligibleColumns();
  const res = await query(
    `SELECT
        COUNT(*) FILTER (WHERE sms_eligible = true)  AS eligible,
        COUNT(*) FILTER (WHERE sms_eligible = false) AS ineligible,
        COUNT(*) FILTER (WHERE sms_eligible IS NULL) AS unchecked,
        COUNT(*) FILTER (WHERE sms_eligible = true
                          AND COALESCE(filtered, false) = false
                          AND COALESCE(wrong_number, false) = false) AS next_batch
       FROM campaign_contact_phones
      WHERE campaign_id = $1`,
    [campaignId]
  );
  const r = res.rows[0] || {};
  return {
    eligible:   parseInt(r.eligible)   || 0,
    ineligible: parseInt(r.ineligible) || 0,
    unchecked:  parseInt(r.unchecked)  || 0,
    next_batch: parseInt(r.next_batch) || 0,
  };
}

module.exports = {
  normalizePhone,
  detectPhoneColumns,
  recordUpload,
  applyFiltrationToContacts,
  generateCleanExport,
  getContactStats,
  importNisFile,
  getNisStats,
  importSmarterContactFile,
  normSmsLabel,
  importSmarterContactAccepted,
  getSmsNextBatch,
  getSmsEligibleStats,
  ensureSmsEligibleColumns,
};
