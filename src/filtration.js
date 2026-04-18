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
// Rewritten 2026-04-17: the old loop was N+1 (one SELECT and one INSERT/UPDATE
// per row — 20k round-trips on a 10k-row upload). This version pre-loads all
// existing campaign_numbers for this campaign into a Map, then does ONE bulk
// INSERT for new numbers and ONE bulk UPDATE for existing numbers via UNNEST.
// Same semantics; ~50× faster on typical uploads. (Audit — filtration.js gaps.)
async function recordUpload(campaignId, filename, sourceListName, channel, rows, rawTotal) {
  const CONNECTED_DISPOS = new Set(['not_interested','transfer','potential_lead','sold','listed','callback','spanish_speaker','hung_up','completed','disqualified','do_not_call']);
  const tally = { total:0, kept:0, filtered:0, wrong:0, vm:0, ni:0, dnc:0, transfer:0, mem:0, newNums:0, connected:0 };

  // ── Pass 1: tally counts + collect per-phone upsert payload ──────────────
  // "Last row wins" for a given phone_number within this upload — matches the
  // old loop's behavior (each iteration overwrote the previous).
  const byPhone = new Map();
  for (const row of rows) {
    tally.total++;
    if (row.Action === 'remove') tally.filtered++; else tally.kept++;
    const d = row._normDispo || '';
    if (d === 'wrong_number')    tally.wrong++;
    if (d === 'voicemail')       tally.vm++;
    if (d === 'not_interested')  tally.ni++;
    if (d === 'do_not_call')     tally.dnc++;
    if (d === 'transfer')        tally.transfer++;
    if (row._caughtByMemory)     tally.mem++;
    if (CONNECTED_DISPOS.has(d)) tally.connected++;

    const phone = String(row.Phone || '').replace(/\D/g, '');
    if (!phone) continue;

    byPhone.set(phone, {
      phone,
      dispo:     row.Disposition || '',
      dispoNorm: d,
      cumCount:  parseInt(row['Call Log Count']) || 1,
      status:    row.Action === 'remove' ? 'filtered' : 'callable',
      phStatus:  row['Phone Status'] || '',
      phTag:     row['Phone Tag'] || '',
      mktResult: row['Marketing Results'] || '',
    });
  }

  // ── Pass 2: one query pre-loads every existing campaign_number we'll touch
  const uniquePhones = Array.from(byPhone.keys());
  const existing = new Map();
  if (uniquePhones.length > 0) {
    const er = await query(
      `SELECT phone_number FROM campaign_numbers WHERE campaign_id = $1 AND phone_number = ANY($2::text[])`,
      [campaignId, uniquePhones]
    );
    for (const r of er.rows) existing.set(r.phone_number, true);
  }

  // ── Pass 3: split into new + updated, fire one bulk query for each ──────
  const newRows    = [];
  const updateRows = [];
  for (const p of byPhone.values()) {
    if (existing.has(p.phone)) updateRows.push(p);
    else                       newRows.push(p);
  }
  tally.newNums = newRows.length;

  if (newRows.length > 0) {
    await query(
      `INSERT INTO campaign_numbers
         (campaign_id, phone_number, last_disposition, last_disposition_normalized,
          cumulative_count, current_status, phone_status, phone_tag,
          marketing_result, total_appearances)
       SELECT $1, phone_number, last_disposition, last_disposition_normalized,
              cumulative_count, current_status, phone_status, phone_tag,
              marketing_result, 1
         FROM UNNEST(
           $2::text[], $3::text[], $4::text[],
           $5::int[],  $6::text[], $7::text[], $8::text[], $9::text[]
         ) AS t(phone_number, last_disposition, last_disposition_normalized,
                cumulative_count, current_status, phone_status, phone_tag,
                marketing_result)
       ON CONFLICT (campaign_id, phone_number) DO NOTHING`,
      [
        campaignId,
        newRows.map(r => r.phone),
        newRows.map(r => r.dispo),
        newRows.map(r => r.dispoNorm),
        newRows.map(r => r.cumCount),
        newRows.map(r => r.status),
        newRows.map(r => r.phStatus),
        newRows.map(r => r.phTag),
        newRows.map(r => r.mktResult),
      ]
    );
  }

  if (updateRows.length > 0) {
    await query(
      `UPDATE campaign_numbers cn SET
         last_disposition            = t.last_disposition,
         last_disposition_normalized = t.last_disposition_normalized,
         cumulative_count            = t.cumulative_count,
         current_status              = t.current_status,
         phone_status                = t.phone_status,
         phone_tag                   = t.phone_tag,
         marketing_result            = t.marketing_result,
         last_seen_at                = NOW(),
         total_appearances           = cn.total_appearances + 1
       FROM UNNEST(
         $2::text[], $3::text[], $4::text[],
         $5::int[],  $6::text[], $7::text[], $8::text[], $9::text[]
       ) AS t(phone_number, last_disposition, last_disposition_normalized,
              cumulative_count, current_status, phone_status, phone_tag,
              marketing_result)
       WHERE cn.campaign_id = $1 AND cn.phone_number = t.phone_number`,
      [
        campaignId,
        updateRows.map(r => r.phone),
        updateRows.map(r => r.dispo),
        updateRows.map(r => r.dispoNorm),
        updateRows.map(r => r.cumCount),
        updateRows.map(r => r.status),
        updateRows.map(r => r.phStatus),
        updateRows.map(r => r.phTag),
        updateRows.map(r => r.mktResult),
      ]
    );
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
// 2026-04-18 audit fix #29 (part 2): feature-flagged bulk pipeline for cold-call.
// Same pattern as the SMS bulk fix (#28) — per-row path remains the default,
// bulk activates via LOKI_BATCHED_FILTRATION=true. Cold-call uploads from
// Readymode are often 20K+ rows; per-row was the real pain point. Bulk does
// ONE UPDATE for all ccp rows plus up to 3 bulk UPDATEs for transfer rows.
async function applyFiltrationToContacts(campaignId, allRows) {
  if (String(process.env.LOKI_BATCHED_FILTRATION || '').toLowerCase() === 'true') {
    try {
      return await applyFiltrationToContactsBulk(campaignId, allRows);
    } catch (e) {
      // Hard fail — same reasoning as SMS: partial state from a failed bulk
      // would corrupt data if per-row re-ran on top of it.
      console.error('[coldcall/bulk] FAILED — refusing to fall back to per-row to avoid partial-state corruption:', e);
      throw new Error(`Bulk filtration failed: ${e.message}. Unset LOKI_BATCHED_FILTRATION to revert to per-row while we investigate.`);
    }
  }
  return applyFiltrationToContactsPerRow(campaignId, allRows);
}

async function applyFiltrationToContactsPerRow(campaignId, allRows) {
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
      // 2026-04-18 audit fix #29: previously used `p.street = cc.property_address`
      // — a raw case-sensitive string equality. "123 Main St" and "123 main st"
      // (from different CSV sources) never matched; the cold-call transfer
      // silently failed to flag the property as a lead. Now uses the normalized
      // address columns (property_address_normalized + street_normalized) which
      // strip punctuation and collapse whitespace on both sides. Same pattern
      // used by the marketing filter (audit fix #3).
      await query(
        `UPDATE properties p SET pipeline_stage = 'lead', updated_at = NOW()
         FROM campaign_contacts cc
         JOIN campaign_contact_phones ccp ON ccp.contact_id = cc.id
         WHERE cc.campaign_id = $1
           AND ccp.phone_number = $2
           AND p.street_normalized = cc.property_address_normalized
           AND UPPER(TRIM(p.state_code)) = UPPER(TRIM(cc.property_state))
           AND p.pipeline_stage NOT IN ('contract','closed')`,
        [campaignId, phone]
      );

      // 3. Mark the specific phone(s) as correct in the global phones table,
      //    scoped by the campaign linkage so shared phone numbers on other
      //    contacts (roommates, relisted, etc.) are NOT flagged. (Audit #15.)
      // 2026-04-18 audit fix #29 (cont): JOIN now uses normalized address
      // columns instead of LOWER+TRIM — same reasoning as above.
      await query(
        `UPDATE phones SET phone_status = 'correct', updated_at = NOW()
         WHERE id IN (
           SELECT DISTINCT ph.id
             FROM phones ph
             JOIN property_contacts pc ON pc.contact_id = ph.contact_id
             JOIN properties p         ON p.id = pc.property_id
             JOIN campaign_contacts cc ON cc.property_address_normalized = p.street_normalized
                                      AND UPPER(TRIM(cc.property_state))   = UPPER(TRIM(p.state_code))
            WHERE cc.campaign_id  = $1
              AND ph.phone_number = $2
         )`,
        [campaignId, phone]
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BULK cold-call filtration — identical semantics to the per-row version
// above, collapses N queries into at most 4 bulk UPDATEs. See audit fix #29.
// ─────────────────────────────────────────────────────────────────────────────
async function applyFiltrationToContactsBulk(campaignId, allRows) {
  // ── Step 1: Walk rows once, collect arrays for the bulk update ───────────
  // Rows with no phone number are skipped (same as per-row line 202).
  const phones = [];
  const statuses = [];
  const tags = [];
  const wrongs = [];
  const removes = [];
  const counts = [];
  const dispositions = [];
  const corrects = [];

  // Track which phone numbers had disposition === 'transfer' for the
  // follow-on UPDATEs. Deduped so we don't issue redundant writes for a
  // phone that appeared on multiple rows.
  const transferPhones = new Set();

  for (const row of allRows) {
    const phone = String(row.Phone || '').replace(/\D/g, '');
    if (!phone) continue;

    const dispo = row._normDispo || '';
    const isWrong = dispo === 'wrong_number';
    const wasRemoved = row.Action === 'remove';
    const status = row['Phone Status'] || '';
    const tag = row['Phone Tag'] || '';
    const count = parseInt(row['Call Log Count']) || 1;
    const isCorrect = ['not_interested', 'transfer', 'callback', 'do_not_call',
                       'spanish_speaker', 'hung_up', 'completed', 'disqualified'].includes(dispo);

    phones.push(phone);
    statuses.push(status || 'unknown');
    tags.push(tag);
    wrongs.push(isWrong);
    removes.push(wasRemoved);
    counts.push(count);
    dispositions.push(row.Disposition || '');
    corrects.push(isCorrect);

    if (dispo === 'transfer') transferPhones.add(phone);
  }

  if (phones.length === 0) return; // nothing to do

  // ── Step 2: Bulk UPDATE ccp — one query replaces N per-row UPDATEs ───────
  // Uses UNNEST to build a derived table of (phone, status, tag, ...), then
  // JOINs it to campaign_contact_phones by (campaign_id, phone_number).
  // Preserves every nuance of the per-row version:
  //   - phone_status isn't overwritten when it's already 'dead_number'
  //   - wrong_number is OR-ed (never downgraded from true to false)
  //   - filtered is OR-ed
  //   - wrong_number_flagged_at is set only on first confirmation
  //   - correct_flagged_at refreshes on every live pickup
  await query(
    `UPDATE campaign_contact_phones AS ccp SET
       phone_status = CASE WHEN ccp.phone_status = 'dead_number' THEN ccp.phone_status ELSE t.status END,
       phone_tag = t.tag,
       wrong_number = ccp.wrong_number OR t.is_wrong,
       filtered = ccp.filtered OR t.was_removed,
       cumulative_count = t.count,
       last_disposition = t.dispo,
       updated_at = NOW(),
       wrong_number_flagged_at = CASE
         WHEN t.is_wrong = true AND ccp.wrong_number_flagged_at IS NULL THEN NOW()
         ELSE ccp.wrong_number_flagged_at
       END,
       correct_flagged_at = CASE
         WHEN t.is_correct = true THEN NOW()
         ELSE ccp.correct_flagged_at
       END
     FROM UNNEST($2::text[], $3::text[], $4::text[], $5::bool[], $6::bool[], $7::int[], $8::text[], $9::bool[])
       AS t(phone, status, tag, is_wrong, was_removed, count, dispo, is_correct)
     WHERE ccp.campaign_id = $1
       AND ccp.phone_number = t.phone`,
    [campaignId, phones, statuses, tags, wrongs, removes, counts, dispositions, corrects]
  );

  // ── Step 3: Transfer-specific follow-ups, bulked by phone array ──────────
  // Only run if there were any transfers in this upload. Each of these
  // mirrors the corresponding per-row statement exactly — just with ANY($2)
  // instead of = $2.
  if (transferPhones.size > 0) {
    const transferPhoneArr = Array.from(transferPhones);

    // 1. Flag campaign contacts as Lead
    await query(
      `UPDATE campaign_contacts cc
         SET marketing_result = 'Lead'
        FROM campaign_contact_phones ccp
       WHERE ccp.contact_id = cc.id
         AND ccp.campaign_id = $1
         AND ccp.phone_number = ANY($2::text[])
         AND cc.campaign_id = $1`,
      [campaignId, transferPhoneArr]
    );

    // 2. Flag properties as lead in the main properties table
    //    Uses normalized address columns (audit fix #29).
    await query(
      `UPDATE properties p SET pipeline_stage = 'lead', updated_at = NOW()
         FROM campaign_contacts cc
         JOIN campaign_contact_phones ccp ON ccp.contact_id = cc.id
        WHERE cc.campaign_id = $1
          AND ccp.phone_number = ANY($2::text[])
          AND p.street_normalized = cc.property_address_normalized
          AND UPPER(TRIM(p.state_code)) = UPPER(TRIM(cc.property_state))
          AND p.pipeline_stage NOT IN ('contract','closed')`,
      [campaignId, transferPhoneArr]
    );

    // 3. Mark specific phone(s) as correct globally. Uses normalized address
    //    columns (audit fix #29). Scoped by campaign linkage so shared phone
    //    numbers on other contacts are NOT incorrectly flagged (Audit #15).
    await query(
      `UPDATE phones SET phone_status = 'correct', updated_at = NOW()
        WHERE id IN (
          SELECT DISTINCT ph.id
            FROM phones ph
            JOIN property_contacts pc ON pc.contact_id = ph.contact_id
            JOIN properties p         ON p.id = pc.property_id
            JOIN campaign_contacts cc ON cc.property_address_normalized = p.street_normalized
                                     AND UPPER(TRIM(cc.property_state))   = UPPER(TRIM(p.state_code))
           WHERE cc.campaign_id  = $1
             AND ph.phone_number = ANY($2::text[])
        )`,
      [campaignId, transferPhoneArr]
    );
  }

  const queryCount = 1 + (transferPhones.size > 0 ? 3 : 0);
  console.log(`[coldcall/bulk] processed ${phones.length} rows in ${queryCount} bulk updates (vs ${phones.length + transferPhones.size * 3}+ per-row queries)`);
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
// 2026-04-18 audit fix #23: previously the UPSERT did
// `times_reported = nis_numbers.times_reported + EXCLUDED.times_reported` which
// means re-uploading the same file DOUBLED every phone's count. The 3-strike
// rule (times_reported >= 3 overrides even Correct) could then falsely kill
// legitimate phones. Now idempotent: we track (phone_number, event_day) in a
// nis_events table. Each (phone, day) tuple only counts once, so uploading
// the same file twice is a no-op.
async function ensureNisEventsSchema() {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS nis_events (
        phone_number VARCHAR(20) NOT NULL,
        event_day    DATE        NOT NULL,
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (phone_number, event_day)
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_nis_events_phone ON nis_events(phone_number)`);
  } catch (e) { console.error('nis_events schema warning:', e.message); }
}

async function importNisFile(rows) {
  await ensureNisEventsSchema();
  let inserted = 0, updated = 0, flagged = 0, duplicateEvents = 0;
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
      phoneMap.set(phone, { phone, first: day, last: day, days: new Set(day ? [day] : []) });
    } else {
      const e = phoneMap.get(phone);
      if (day) e.days.add(day);
      if (day && (!e.first || day < e.first)) e.first = day;
      if (day && (!e.last  || day > e.last))  e.last  = day;
    }
  }

  const entries = Array.from(phoneMap.values());

  // Pass 1: Insert (phone, day) tuples. ON CONFLICT DO NOTHING — duplicates
  // from re-uploads are silently skipped. The number of actually-inserted rows
  // per phone is the true "new times_reported to add."
  const perPhoneNewCounts = new Map();
  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = entries.slice(i, i + BATCH);
    const eventVals = [];
    const eventParams = [];
    let ep = 1;
    // Unroll each phone's day-set into individual (phone, day) tuples
    for (const e of batch) {
      for (const day of e.days) {
        eventVals.push(`($${ep},$${ep+1})`);
        eventParams.push(e.phone, day);
        ep += 2;
      }
    }
    if (eventVals.length === 0) continue;
    const eventRes = await query(
      `INSERT INTO nis_events (phone_number, event_day)
       VALUES ${eventVals.join(',')}
       ON CONFLICT (phone_number, event_day) DO NOTHING
       RETURNING phone_number`,
      eventParams
    );
    for (const row of eventRes.rows) {
      perPhoneNewCounts.set(row.phone_number, (perPhoneNewCounts.get(row.phone_number) || 0) + 1);
    }
    duplicateEvents += (eventVals.length - eventRes.rowCount);
  }

  // Pass 2: For phones that had truly-new events, upsert nis_numbers with
  // the new-event count. Phones whose events were all duplicates don't get
  // their times_reported inflated — that's the whole point of the fix.
  const phonesToUpsert = entries.filter(e => perPhoneNewCounts.has(e.phone));

  for (let i = 0; i < phonesToUpsert.length; i += BATCH) {
    const batch = phonesToUpsert.slice(i, i + BATCH);
    const vals = [];
    const params = [];
    let p = 1;
    for (const e of batch) {
      const newCount = perPhoneNewCounts.get(e.phone) || 0;
      vals.push(`($${p},$${p+1},$${p+2},$${p+3})`);
      params.push(e.phone, e.first, e.last, newCount);
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

  if (duplicateEvents > 0) {
    console.log(`[nis] skipped ${duplicateEvents} duplicate (phone, day) event(s) — likely a re-upload of a previously processed file`);
  }

  // Retroactively flag matching phones — scoped to ACTIVE campaigns only.
  // Completed/archived campaigns don't get re-flagged (their history is a
  // snapshot). Also cuts rowcount by ~80% on typical workloads since most
  // campaigns complete. (Decision #4 — better performance + correctness.)
  //   Rule: times_reported >= 3 overrides any non-dead status
  //         times_reported  < 3 only flags unknown/non-Correct phones
  const flagRes = await query(
    `UPDATE campaign_contact_phones
        SET phone_status = 'dead_number', nis_flagged_at = NOW()
      WHERE phone_status != 'dead_number'
        AND campaign_id IN (SELECT id FROM campaigns WHERE status = 'active')
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
// 2026-04-18 audit fix #19: previously used exact string equality after
// lowercase+trim, so "Not Interested." (trailing period) or "Wrong  Number"
// (double space) silently fell through to no_action — a compliance hole for
// "Do Not Call". Fix: strip trailing punctuation and collapse internal
// whitespace before matching. Also added missing cases: do_not_call and
// spanish_speaker. Previously SMS-labeled DNCs were silently ignored (TCPA
// compliance risk); SMS-labeled Spanish speakers stayed callable with no flag.
function normSmsLabel(label) {
  const cleaned = stripSmsLabelPrefix(label);
  // Tolerant normalization:
  //   1. lowercase
  //   2. strip trailing punctuation (., !, ?, ;, :)
  //   3. collapse runs of whitespace (including tabs/newlines) to single space
  //   4. trim
  const l = cleaned
    .toLowerCase()
    .replace(/[.!?;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (l === 'wrong number')                        return 'wrong_number';
  if (l === 'not interested')                      return 'not_interested';
  if (l === 'lead' || l === 'appointment')         return 'transfer';
  if (l === 'disqualified')                        return 'disqualified';
  if (l === 'potential lead')                      return 'potential_lead';
  if (l === 'sold')                                return 'sold';
  if (l === 'listed')                              return 'listed';
  if (l === 'do not call' || l === 'dnc')          return 'do_not_call';
  if (l === 'spanish speaker' || l === 'spanish')  return 'spanish_speaker';
  // CRM Transferred, No answer, New, Left voicemail → no action
  return 'no_action';
}

// 2026-04-18 audit fix #28: feature-flagged bulk pipeline. Previously every
// SMS row ran 1-3 SQL queries (SELECT the phone, then UPDATE per dispo).
// A 10K-row upload = 20K-30K sequential round-trips. The bulk version loads
// all phones in ONE query, groups rows by dispo in memory, then runs ONE
// UNNEST-based UPDATE per (dispo, target_table). Typical speedup: 50-100x.
//
// The per-row function remains the default and can be reverted instantly by
// unsetting LOKI_BATCHED_FILTRATION. Set LOKI_BATCHED_FILTRATION=true to opt
// in. Both functions produce the same tally, the same DB state, the same
// log events — just different internal shapes.
async function importSmarterContactFile(campaignId, rows, headers, filename) {
  if (String(process.env.LOKI_BATCHED_FILTRATION || '').toLowerCase() === 'true') {
    try {
      return await importSmarterContactFileBulk(campaignId, rows, headers, filename);
    } catch (e) {
      // Hard fail — we want to notice if bulk is broken, not silently corrupt
      // data by running the per-row version on top of whatever partial state
      // bulk might have left behind.
      console.error('[sms/bulk] FAILED — refusing to fall back to per-row to avoid partial-state corruption:', e);
      return {
        success: false,
        error: `Bulk filtration failed: ${e.message}. Unset LOKI_BATCHED_FILTRATION to revert to the per-row path while we investigate.`,
      };
    }
  }
  return importSmarterContactFilePerRow(campaignId, rows, headers, filename);
}

async function importSmarterContactFilePerRow(campaignId, rows, headers, filename) {
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
  // 2026-04-18 audit fix #19: added dnc + spanish_speaker tally buckets
  const tally = { total: 0, wrong: 0, ni: 0, transfer: 0, disqualified: 0, potential_lead: 0, sold: 0, listed: 0, dnc: 0, spanish: 0, no_action: 0, unmatched: 0 };

  for (const row of rows) {
    tally.total++;
    const phone = normalizePhone(row[COL.phone] || '');
    if (!phone) { tally.unmatched++; continue; }

    const label    = String(row[COL.labels] || '').trim();
    const dispo    = normSmsLabel(label);
    // Store the cleaned label (prefix + trailing emoji stripped) so downstream
    // queries (e.g. "contacts reached") can match reliably without regex tricks.
    const cleanedLabel = stripSmsLabelPrefix(label);

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
        [cleanedLabel, phoneRow.id]
      );
      // 2026-04-18 audit fix #16: also update the global phones table so the
      // dashboard's "wrong phones" count reflects filtration outcomes. Previously
      // only campaign_contact_phones got updated — the dashboard (which reads
      // phones.wrong_number) was forever stuck on the original CSV-imported values.
      // Scoped by phone_number only so confirmed-wrong flags cross campaigns
      // (a phone confirmed wrong in one campaign is wrong everywhere).
      await query(
        `UPDATE phones SET
           wrong_number = true,
           phone_status = 'wrong',
           updated_at = NOW()
         WHERE phone_number = (SELECT phone_number FROM campaign_contact_phones WHERE id = $1)`,
        [phoneRow.id]
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
        [cleanedLabel, phoneRow.id]
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
        [cleanedLabel, phoneRow.id]
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
        [cleanedLabel, phoneRow.id]
      );
      // Flag the contact as Lead for this campaign
      await query(
        `UPDATE campaign_contacts SET marketing_result = 'Lead'
         WHERE id = $1`,
        [phoneRow.contact_id]
      );
    }

    if (dispo === 'potential_lead') {
      tally.potential_lead++;
      // Mark phone as correct + filtered (real conversation, don't text again)
      await query(
        `UPDATE campaign_contact_phones SET
           filtered = true,
           phone_status = 'Correct',
           correct_flagged_at = NOW(),
           last_disposition = $1,
           updated_at = NOW()
         WHERE id = $2`,
        [cleanedLabel, phoneRow.id]
      );
      await query(
        `UPDATE campaign_contacts SET marketing_result = 'Potential Lead'
         WHERE id = $1 AND (marketing_result IS NULL OR marketing_result = '')`,
        [phoneRow.contact_id]
      );
    }

    if (dispo === 'sold') {
      tally.sold++;
      await query(
        `UPDATE campaign_contact_phones SET
           filtered = true,
           phone_status = 'Correct',
           correct_flagged_at = NOW(),
           last_disposition = $1,
           updated_at = NOW()
         WHERE id = $2`,
        [cleanedLabel, phoneRow.id]
      );
      await query(
        `UPDATE campaign_contacts SET marketing_result = 'Sold'
         WHERE id = $1`,
        [phoneRow.contact_id]
      );
    }

    if (dispo === 'listed') {
      tally.listed++;
      await query(
        `UPDATE campaign_contact_phones SET
           filtered = true,
           phone_status = 'Correct',
           correct_flagged_at = NOW(),
           last_disposition = $1,
           updated_at = NOW()
         WHERE id = $2`,
        [cleanedLabel, phoneRow.id]
      );
      await query(
        `UPDATE campaign_contacts SET marketing_result = 'Listed'
         WHERE id = $1`,
        [phoneRow.contact_id]
      );
    }

    // 2026-04-18 audit fix #19: SMS "Do Not Call" was silently ignored. No
    // normalizer match, no handler branch, so DNC-labeled contacts stayed
    // callable — a TCPA compliance hole. Now treated the same as cold-call DNC:
    // phone filtered (never called again) + contact-level marketing_result.
    if (dispo === 'do_not_call') {
      tally.dnc++;
      await query(
        `UPDATE campaign_contact_phones SET
           filtered = true,
           phone_status = 'Correct',
           correct_flagged_at = NOW(),
           last_disposition = $1,
           updated_at = NOW()
         WHERE id = $2`,
        [cleanedLabel, phoneRow.id]
      );
      await query(
        `UPDATE campaign_contacts SET marketing_result = 'Do Not Call'
         WHERE id = $1`,
        [phoneRow.contact_id]
      );
      // Also update the global phones table so the dashboard reflects DNC
      // across campaigns (parity with wrong-number sync added in fix #16).
      await query(
        `UPDATE phones SET phone_status = 'dnc', updated_at = NOW()
         WHERE phone_number = (SELECT phone_number FROM campaign_contact_phones WHERE id = $1)`,
        [phoneRow.id]
      );
    }

    // 2026-04-18 audit fix #19: SMS "Spanish Speaker" was silently ignored.
    // Now matches the cold-call treatment — phone filtered (real conversation,
    // don't text again) + contact-level marketing_result so the filter dropdown
    // can surface these properties.
    if (dispo === 'spanish_speaker') {
      tally.spanish++;
      await query(
        `UPDATE campaign_contact_phones SET
           filtered = true,
           phone_status = 'Correct',
           correct_flagged_at = NOW(),
           last_disposition = $1,
           updated_at = NOW()
         WHERE id = $2`,
        [cleanedLabel, phoneRow.id]
      );
      await query(
        `UPDATE campaign_contacts SET marketing_result = 'Spanish Speaker'
         WHERE id = $1 AND (marketing_result IS NULL OR marketing_result = '')`,
        [phoneRow.contact_id]
      );
    }
  }

  // ── Step 4: Update campaign totals ────────────────────────────────────────
  // Note: total_transfers counts ALL lead-like outcomes (Lead, Appointment,
  // Potential Lead, Sold, Listed) since they all represent real conversions.
  const totalLeads = tally.transfer + tally.potential_lead + tally.sold + tally.listed;
  await query(
    `UPDATE campaigns SET
       total_wrong_numbers = total_wrong_numbers + $1,
       total_not_interested = total_not_interested + $2,
       total_transfers = total_transfers + $3,
       upload_count = upload_count + 1,
       last_filtered_at = NOW(),
       updated_at = NOW()
     WHERE id = $4`,
    [tally.wrong, tally.ni, totalLeads, campaignId]
  );

  // Log this upload to Filtration History
  await recordSmsUploadEvent({
    campaignId,
    filename,
    channel: 'sms_results',
    tally: {
      total_records:       tally.total,
      records_kept:        tally.total - tally.unmatched,
      records_filtered:    tally.unmatched,
      wrong_numbers:       tally.wrong,
      not_interested:      tally.ni,
      disqualified:        tally.disqualified,
      transfers_combined:  totalLeads,
    },
  });

  return {
    success: true,
    tally: {
      total:        tally.total,
      wrong:        tally.wrong,
      not_interested: tally.ni,
      leads:        tally.transfer,
      disqualified: tally.disqualified,
      potential_lead: tally.potential_lead,
      sold:         tally.sold,
      listed:       tally.listed,
      no_action:    tally.no_action,
      unmatched:    tally.unmatched,
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// BULK SMS filtration — same semantics as the per-row version above, but
// replaces the N+1 query pattern with a single bulk-load + grouped bulk-updates.
// Preserves tally counts, DB state, and upload event exactly. See audit fix #28.
// ─────────────────────────────────────────────────────────────────────────────
async function importSmarterContactFileBulk(campaignId, rows, headers, filename) {
  // ── Step 1: Validate required columns (identical to per-row) ──────────────
  const headerLower = headers.map(h => String(h || '').toLowerCase().trim());
  const missingCols = SMS_REQUIRED_COLS.filter(req => !headerLower.includes(req));
  if (missingCols.length > 0) {
    return {
      success: false,
      error: `Missing required columns: ${missingCols.map(c => c.charAt(0).toUpperCase() + c.slice(1)).join(', ')}. Please check your SmarterContact export before uploading.`,
    };
  }

  const findHeader = (req) => headers.find(h => String(h || '').toLowerCase().trim() === req);
  const COL = { phone: findHeader('phone'), labels: findHeader('labels') };

  // ── Step 2: Multi-label validation (identical to per-row) ─────────────────
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

  // ── Step 3: Parse all rows into a single normalized list ─────────────────
  // No DB access yet — just build the working set in memory.
  const parsed = rows.map((row, idx) => {
    const phoneRaw = row[COL.phone] || '';
    const phone = normalizePhone(phoneRaw);
    const label = String(row[COL.labels] || '').trim();
    const dispo = phone ? normSmsLabel(label) : null;
    const cleanedLabel = stripSmsLabelPrefix(label);
    return { idx, phone, dispo, cleanedLabel };
  });

  const tally = { total: rows.length, wrong: 0, ni: 0, transfer: 0, disqualified: 0, potential_lead: 0, sold: 0, listed: 0, dnc: 0, spanish: 0, no_action: 0, unmatched: 0 };

  // ── Step 4: Bulk-load all phone records for this campaign ────────────────
  // ONE query covers every phone in the upload. Previously: N separate SELECTs.
  const uniquePhones = Array.from(new Set(parsed.map(p => p.phone).filter(Boolean)));
  let phoneMap = new Map(); // phone_number → { id, contact_id }

  if (uniquePhones.length > 0) {
    const phonesRes = await query(
      `SELECT id, contact_id, phone_number
         FROM campaign_contact_phones
        WHERE campaign_id = $1
          AND phone_number = ANY($2::text[])`,
      [campaignId, uniquePhones]
    );
    for (const r of phonesRes.rows) {
      // If multiple slots hold the same phone on the same contact, the last
      // one wins — identical to the per-row LIMIT 1 behavior in practice,
      // since per-row also grabs whichever row comes first.
      phoneMap.set(r.phone_number, { id: r.id, contact_id: r.contact_id });
    }
  }

  // ── Step 5: Group rows by dispo ──────────────────────────────────────────
  // Each group is { phoneRowId, contactId, cleanedLabel }. Phones that didn't
  // match the campaign's contact list get counted as unmatched and skipped
  // (same as per-row: `if (!phoneRes.rows.length) { tally.unmatched++; continue; }`).
  const groups = {
    wrong_number: [], not_interested: [], disqualified: [], transfer: [],
    potential_lead: [], sold: [], listed: [], do_not_call: [], spanish_speaker: [],
  };

  for (const p of parsed) {
    if (!p.phone) { tally.unmatched++; continue; }
    const match = phoneMap.get(p.phone);
    if (!match) { tally.unmatched++; continue; }
    if (p.dispo === 'no_action') { tally.no_action++; continue; }
    if (groups[p.dispo]) {
      groups[p.dispo].push({ phoneRowId: match.id, contactId: match.contact_id, cleanedLabel: p.cleanedLabel });
    }
  }

  // Update tally counts per dispo group size (matches per-row behavior exactly:
  // per-row increments the tally inside each dispo branch after the successful
  // DB write, but ONLY for rows where the phone matched the campaign. The
  // grouping above already excludes non-matches, so grouping = per-row counts.)
  tally.wrong          = groups.wrong_number.length;
  tally.ni             = groups.not_interested.length;
  tally.disqualified   = groups.disqualified.length;
  tally.transfer       = groups.transfer.length;
  tally.potential_lead = groups.potential_lead.length;
  tally.sold           = groups.sold.length;
  tally.listed         = groups.listed.length;
  tally.dnc            = groups.do_not_call.length;
  tally.spanish        = groups.spanish_speaker.length;

  // ── Step 6: Run ONE bulk UPDATE per group per target table ──────────────
  // Each branch produces between 0 and 3 bulk SQL statements depending on
  // what the per-row version did for that dispo. UNNEST arrays the grouped
  // payloads; the UPDATE joins them by phoneRowId.
  const runBulkUpdate = async (sql, idArr, labelArr) => {
    if (idArr.length === 0) return;
    await query(sql, [idArr, labelArr]);
  };

  // — WRONG_NUMBER — mirrors per-row lines 629-641 + fix #16 global phones sync
  if (groups.wrong_number.length > 0) {
    const g = groups.wrong_number;
    await runBulkUpdate(
      `UPDATE campaign_contact_phones AS ccp SET
         wrong_number = true,
         phone_status = 'Wrong',
         wrong_number_flagged_at = CASE WHEN ccp.wrong_number_flagged_at IS NULL THEN NOW() ELSE ccp.wrong_number_flagged_at END,
         last_disposition = t.lbl,
         updated_at = NOW()
       FROM UNNEST($1::int[], $2::text[]) AS t(id, lbl)
       WHERE ccp.id = t.id`,
      g.map(r => r.phoneRowId), g.map(r => r.cleanedLabel)
    );
    // Global phones sync (fix #16)
    await query(
      `UPDATE phones SET wrong_number = true, phone_status = 'wrong', updated_at = NOW()
         WHERE phone_number IN (
           SELECT phone_number FROM campaign_contact_phones WHERE id = ANY($1::int[])
         )`,
      [g.map(r => r.phoneRowId)]
    );
  }

  // — NOT_INTERESTED — mirrors per-row lines 643-654
  if (groups.not_interested.length > 0) {
    const g = groups.not_interested;
    await runBulkUpdate(
      `UPDATE campaign_contact_phones AS ccp SET
         filtered = true,
         last_disposition = t.lbl,
         updated_at = NOW()
       FROM UNNEST($1::int[], $2::text[]) AS t(id, lbl)
       WHERE ccp.id = t.id`,
      g.map(r => r.phoneRowId), g.map(r => r.cleanedLabel)
    );
  }

  // — DISQUALIFIED — mirrors per-row lines 656-668
  if (groups.disqualified.length > 0) {
    const g = groups.disqualified;
    await runBulkUpdate(
      `UPDATE campaign_contact_phones AS ccp SET
         filtered = true,
         phone_status = 'Correct',
         correct_flagged_at = NOW(),
         last_disposition = t.lbl,
         updated_at = NOW()
       FROM UNNEST($1::int[], $2::text[]) AS t(id, lbl)
       WHERE ccp.id = t.id`,
      g.map(r => r.phoneRowId), g.map(r => r.cleanedLabel)
    );
  }

  // — TRANSFER — mirrors per-row lines 670-689 (ccp + campaign_contacts marketing_result)
  if (groups.transfer.length > 0) {
    const g = groups.transfer;
    await runBulkUpdate(
      `UPDATE campaign_contact_phones AS ccp SET
         filtered = true,
         phone_status = 'Correct',
         correct_flagged_at = NOW(),
         last_disposition = t.lbl,
         updated_at = NOW()
       FROM UNNEST($1::int[], $2::text[]) AS t(id, lbl)
       WHERE ccp.id = t.id`,
      g.map(r => r.phoneRowId), g.map(r => r.cleanedLabel)
    );
    await query(
      `UPDATE campaign_contacts SET marketing_result = 'Lead'
         WHERE id = ANY($1::int[])`,
      [g.map(r => r.contactId)]
    );
  }

  // — POTENTIAL_LEAD — mirrors per-row lines 691-710 (note: only sets marketing_result
  //   if currently NULL or empty — preserves per-row COALESCE-like behavior)
  if (groups.potential_lead.length > 0) {
    const g = groups.potential_lead;
    await runBulkUpdate(
      `UPDATE campaign_contact_phones AS ccp SET
         filtered = true,
         phone_status = 'Correct',
         correct_flagged_at = NOW(),
         last_disposition = t.lbl,
         updated_at = NOW()
       FROM UNNEST($1::int[], $2::text[]) AS t(id, lbl)
       WHERE ccp.id = t.id`,
      g.map(r => r.phoneRowId), g.map(r => r.cleanedLabel)
    );
    await query(
      `UPDATE campaign_contacts SET marketing_result = 'Potential Lead'
         WHERE id = ANY($1::int[])
           AND (marketing_result IS NULL OR marketing_result = '')`,
      [g.map(r => r.contactId)]
    );
  }

  // — SOLD — mirrors per-row lines 712-726
  if (groups.sold.length > 0) {
    const g = groups.sold;
    await runBulkUpdate(
      `UPDATE campaign_contact_phones AS ccp SET
         filtered = true,
         phone_status = 'Correct',
         correct_flagged_at = NOW(),
         last_disposition = t.lbl,
         updated_at = NOW()
       FROM UNNEST($1::int[], $2::text[]) AS t(id, lbl)
       WHERE ccp.id = t.id`,
      g.map(r => r.phoneRowId), g.map(r => r.cleanedLabel)
    );
    await query(
      `UPDATE campaign_contacts SET marketing_result = 'Sold'
         WHERE id = ANY($1::int[])`,
      [g.map(r => r.contactId)]
    );
  }

  // — LISTED — mirrors per-row lines 728-742
  if (groups.listed.length > 0) {
    const g = groups.listed;
    await runBulkUpdate(
      `UPDATE campaign_contact_phones AS ccp SET
         filtered = true,
         phone_status = 'Correct',
         correct_flagged_at = NOW(),
         last_disposition = t.lbl,
         updated_at = NOW()
       FROM UNNEST($1::int[], $2::text[]) AS t(id, lbl)
       WHERE ccp.id = t.id`,
      g.map(r => r.phoneRowId), g.map(r => r.cleanedLabel)
    );
    await query(
      `UPDATE campaign_contacts SET marketing_result = 'Listed'
         WHERE id = ANY($1::int[])`,
      [g.map(r => r.contactId)]
    );
  }

  // — DO_NOT_CALL — mirrors per-row lines 749-775 (includes global phones sync)
  if (groups.do_not_call.length > 0) {
    const g = groups.do_not_call;
    await runBulkUpdate(
      `UPDATE campaign_contact_phones AS ccp SET
         filtered = true,
         phone_status = 'Correct',
         correct_flagged_at = NOW(),
         last_disposition = t.lbl,
         updated_at = NOW()
       FROM UNNEST($1::int[], $2::text[]) AS t(id, lbl)
       WHERE ccp.id = t.id`,
      g.map(r => r.phoneRowId), g.map(r => r.cleanedLabel)
    );
    await query(
      `UPDATE campaign_contacts SET marketing_result = 'Do Not Call'
         WHERE id = ANY($1::int[])`,
      [g.map(r => r.contactId)]
    );
    // Global phones sync — parity with fix #16
    await query(
      `UPDATE phones SET phone_status = 'dnc', updated_at = NOW()
         WHERE phone_number IN (
           SELECT phone_number FROM campaign_contact_phones WHERE id = ANY($1::int[])
         )`,
      [g.map(r => r.phoneRowId)]
    );
  }

  // — SPANISH_SPEAKER — mirrors per-row lines 778-796
  if (groups.spanish_speaker.length > 0) {
    const g = groups.spanish_speaker;
    await runBulkUpdate(
      `UPDATE campaign_contact_phones AS ccp SET
         filtered = true,
         phone_status = 'Correct',
         correct_flagged_at = NOW(),
         last_disposition = t.lbl,
         updated_at = NOW()
       FROM UNNEST($1::int[], $2::text[]) AS t(id, lbl)
       WHERE ccp.id = t.id`,
      g.map(r => r.phoneRowId), g.map(r => r.cleanedLabel)
    );
    await query(
      `UPDATE campaign_contacts SET marketing_result = 'Spanish Speaker'
         WHERE id = ANY($1::int[])
           AND (marketing_result IS NULL OR marketing_result = '')`,
      [g.map(r => r.contactId)]
    );
  }

  // ── Step 7: Update campaign totals (identical to per-row) ────────────────
  const totalLeads = tally.transfer + tally.potential_lead + tally.sold + tally.listed;
  await query(
    `UPDATE campaigns SET
       total_wrong_numbers = total_wrong_numbers + $1,
       total_not_interested = total_not_interested + $2,
       total_transfers = total_transfers + $3,
       upload_count = upload_count + 1,
       last_filtered_at = NOW(),
       updated_at = NOW()
     WHERE id = $4`,
    [tally.wrong, tally.ni, totalLeads, campaignId]
  );

  await recordSmsUploadEvent({
    campaignId, filename, channel: 'sms_results',
    tally: {
      total_records:       tally.total,
      records_kept:        tally.total - tally.unmatched,
      records_filtered:    tally.unmatched,
      wrong_numbers:       tally.wrong,
      not_interested:      tally.ni,
      disqualified:        tally.disqualified,
      transfers_combined:  totalLeads,
    },
  });

  console.log(`[sms/bulk] processed ${tally.total} rows in ${Object.values(groups).reduce((s, g) => s + (g.length > 0 ? 1 : 0), 0)} grouped bulk updates (vs ${tally.total * 2}+ per-row queries)`);

  return {
    success: true,
    tally: {
      total:          tally.total,
      wrong:          tally.wrong,
      not_interested: tally.ni,
      leads:          tally.transfer,
      disqualified:   tally.disqualified,
      potential_lead: tally.potential_lead,
      sold:           tally.sold,
      listed:         tally.listed,
      no_action:      tally.no_action,
      unmatched:      tally.unmatched,
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

// Log an SMS upload event into campaign_uploads so it shows up in Filtration
// History. Reuses the existing schema; SMS-specific breakdown fields map as:
//   total_records     = total rows in file
//   records_kept      = rows that matched DB & were processed
//   records_filtered  = rows that were not matched / invalid
//   wrong_numbers     = Wrong Number label count
//   not_interested    = Not Interested label count
//   transfers         = Lead/Appointment/Potential Lead/Sold/Listed combined
//   voicemails        = 0 (SMS has no voicemails; kept for schema compat)
//   do_not_call       = Disqualified label count (closest analog)
async function recordSmsUploadEvent({ campaignId, filename, channel, tally, sourceListName }) {
  try {
    await query(
      `INSERT INTO campaign_uploads
         (campaign_id, filename, source_list_name, channel, total_records,
          new_unique_numbers, records_kept, records_filtered,
          wrong_numbers, voicemails, not_interested, do_not_call, transfers,
          caught_by_memory, connected)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        campaignId,
        filename || 'SMC Export',
        sourceListName || null,
        channel,
        tally.total_records || 0,
        0,
        tally.records_kept || 0,
        tally.records_filtered || 0,
        tally.wrong_numbers || 0,
        0,
        tally.not_interested || 0,
        tally.disqualified || 0,
        tally.transfers_combined || 0,
        0,
        0,
      ]
    );
  } catch (e) {
    console.error('[sms-upload-log] failed to record:', e.message);
    // Don't throw — logging failure should never block the main SMS import.
  }
}

async function importSmarterContactAccepted(campaignId, rows, headers, filename) {
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

  // Log this upload to Filtration History
  // Note: we store UNIQUE phone counts so the history row makes sense.
  //   total_records    = unique phones in the SMC export
  //   records_kept     = unique phones that matched the master list
  //   records_filtered = phones in file that didn't match any master row
  // (The DB-row count of 280 is internal plumbing — see audit notes.)
  const uniquePhonesMatched = Math.min(acceptedSet.size, matched);
  await recordSmsUploadEvent({
    campaignId,
    filename,
    channel: 'sms_accepted',
    tally: {
      total_records:       acceptedSet.size,
      records_kept:        uniquePhonesMatched,
      records_filtered:    unmatched + invalidRows,
      wrong_numbers:       0,
      not_interested:      0,
      disqualified:        0,
      transfers_combined:  0,
    },
  });

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
  // Return one row per UNIQUE phone number. When the same phone is on multiple
  // properties (e.g. Rodney Gaard owns 4 properties), we pick one property's
  // metadata (the first by sort order) to keep the CSV clean. SMC dedupes
  // anyway, but this keeps the next-batch count honest.
  const res = await query(
    `SELECT DISTINCT ON (ccp.phone_number)
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
      ORDER BY ccp.phone_number, cc.last_name, cc.first_name`,
    [campaignId]
  );
  return res.rows;
}

async function getSmsEligibleStats(campaignId) {
  await ensureSmsEligibleColumns();

  // Labels that count as a real response (business-meaningful engagement).
  // Excludes Wrong Number and no-action tags like New, CRM Transferred, etc.
  const REACHED_LABELS = [
    'Lead', 'Appointment',
    'Not interested',
    'disqualified', 'Disqualified',
    'Potential Lead',
    'Sold',
    'Listed',
  ];

  // ── Phone-level row counts (for backwards-compat + sidebar stats) ─────────
  const phoneRes = await query(
    `SELECT
        COUNT(*) FILTER (WHERE sms_eligible = true)  AS eligible_rows,
        COUNT(*) FILTER (WHERE sms_eligible = false) AS ineligible_rows,
        COUNT(*) FILTER (WHERE sms_eligible IS NULL) AS unchecked_rows
       FROM campaign_contact_phones
      WHERE campaign_id = $1`,
    [campaignId]
  );

  // ── Unique phones that are textable (dedup across duplicate contact rows) ─
  const uniquePhonesRes = await query(
    `SELECT COUNT(DISTINCT phone_number) AS unique_textable
       FROM campaign_contact_phones
      WHERE campaign_id = $1 AND sms_eligible = true`,
    [campaignId]
  );

  // ── Property-level metrics (the business-meaningful numbers) ──────────────
  // A property = one campaign_contacts row.
  // Properties with >=1 eligible phone = textable properties.
  // Properties with ALL phones ineligible = landline-only.
  // Properties where any phone got a real response = properties responded.
  // Properties in next batch = textable AND no response yet on any phone.
  //
  // Note on label matching: we accept BOTH cleaned labels ("Lead") and raw
  // SMC labels ("C2|Lead 📞"). The regex strips "<code>|" prefix AND trailing
  // whitespace/emojis so rows stored before the label-cleaning fix still match.
  const propRes = await query(
    `WITH prop AS (
       SELECT
         cc.id AS contact_id,
         BOOL_OR(ccp.sms_eligible = true)  AS has_textable,
         BOOL_OR(ccp.sms_eligible = false) AS has_ineligible,
         COUNT(ccp.id)                      AS phone_row_count,
         BOOL_OR(ccp.last_disposition IS NOT NULL
                 AND (
                   ccp.last_disposition ILIKE ANY($2::text[])
                   OR TRIM(REGEXP_REPLACE(REGEXP_REPLACE(ccp.last_disposition, '^[^|]*\\|', ''), '[^A-Za-z]+$', '')) ILIKE ANY($2::text[])
                 )) AS responded,
         BOOL_OR(ccp.sms_eligible = true
                 AND COALESCE(ccp.filtered, false) = false
                 AND COALESCE(ccp.wrong_number, false) = false) AS in_next_batch
       FROM campaign_contacts cc
       LEFT JOIN campaign_contact_phones ccp ON ccp.contact_id = cc.id
       WHERE cc.campaign_id = $1
       GROUP BY cc.id
     )
     SELECT
       COUNT(*) AS total_properties,
       COUNT(*) FILTER (WHERE has_textable = true)                          AS textable_properties,
       COUNT(*) FILTER (WHERE (has_textable IS NULL OR has_textable = false)
                          AND phone_row_count > 0)                          AS landline_only_properties,
       COUNT(*) FILTER (WHERE responded = true)                             AS properties_responded,
       COUNT(*) FILTER (WHERE in_next_batch = true)                         AS properties_next_batch
     FROM prop`,
    [campaignId, REACHED_LABELS]
  );

  // ── Unique phones in next batch (for the CSV export count) ────────────────
  const nextBatchPhonesRes = await query(
    `SELECT COUNT(DISTINCT phone_number) AS unique_next_batch_phones
       FROM campaign_contact_phones
      WHERE campaign_id = $1
        AND sms_eligible = true
        AND COALESCE(filtered, false) = false
        AND COALESCE(wrong_number, false) = false`,
    [campaignId]
  );

  const r = phoneRes.rows[0] || {};
  const p = propRes.rows[0] || {};

  return {
    // Property-level metrics (primary — shown on dashboard)
    total_properties:         parseInt(p.total_properties)          || 0,
    textable_properties:      parseInt(p.textable_properties)       || 0,
    landline_only_properties: parseInt(p.landline_only_properties)  || 0,
    properties_responded:     parseInt(p.properties_responded)      || 0,
    properties_next_batch:    parseInt(p.properties_next_batch)     || 0,

    // Unique phone counts
    unique_phones_textable:   parseInt(uniquePhonesRes.rows[0]?.unique_textable)       || 0,
    unique_phones_next_batch: parseInt(nextBatchPhonesRes.rows[0]?.unique_next_batch_phones) || 0,

    // Phone-row counts (kept for the small stats strip under Step 1 upload)
    eligible:    parseInt(r.eligible_rows)    || 0,
    ineligible:  parseInt(r.ineligible_rows)  || 0,
    unchecked:   parseInt(r.unchecked_rows)   || 0,
    next_batch:  parseInt(p.properties_next_batch) || 0,

    // Legacy aliases (keep working with any code still referencing these)
    reached_contacts: parseInt(p.properties_responded) || 0,
    total_contacts:   parseInt(p.total_properties)     || 0,
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
