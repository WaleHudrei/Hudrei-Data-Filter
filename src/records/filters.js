// ─────────────────────────────────────────────────────────────────────────────
// ⚠️  DEAD CODE — UNUSED AS OF 2026-04-18 AUDIT ⚠️
//
// This module exports parseFilterInput + buildPropertyFilters but is never
// imported anywhere in the codebase. The filter-building logic lives inline
// in records-routes.js across multiple handlers (records list, export, delete,
// bulk-tag). This file was apparently created as an aspirational refactor
// that was never wired up.
//
// Options for the next cleanup pass:
//   (a) Delete this file and remove the 288 lines of dead code, OR
//   (b) Actually use it — refactor records-routes.js to require('./filters')
//       and replace the 4 duplicate filter-building blocks with calls into
//       this module. Bigger change but reduces duplication.
//
// Leaving in place for now since it's harmless dead code; flagged so the next
// person to touch this understands it's not in use.
// ─────────────────────────────────────────────────────────────────────────────
//
// Original header (retained for reference):
// filters.js — shared WHERE-clause builder for /records + bulk handlers.
//
// Before this file, the filter-building logic was hand-duplicated in 5 places:
//   - GET  /records                 (records-routes.js)
//   - POST /records/export           (records-routes.js)
//   - POST /records/delete           (records-routes.js)
//   - POST /records/bulk-tag         (records-routes.js)
//   - POST /records/remove-from-list (records-routes.js)
//
// The copies had drifted (free-text search `q` in /records matched phone + zip,
// but the bulk handlers only matched street/city/first_name/last_name — so
// "Select all N" + Delete could hit the wrong rows). This file is the single
// source of truth. Every handler calls parseFilterInput(source) then
// buildPropertyFilters(parsed).
//
// Marketing Result filter is PER-CAMPAIGN (decision from 4/17 audit):
//   source-of-truth is campaign_contacts.marketing_result (SMS path) +
//   campaign_numbers.marketing_result (cold-call path). We split on the ' — '
//   list suffix so stored values like "Not Interested — MyList_2024" match
//   the clean dropdown value "Not Interested".
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pulls all filter values out of req.query (plain object) OR URLSearchParams.
 * Returns a normalized object used by both the UI render and the SQL builder.
 */
function parseFilterInput(source) {
  const isUSP = source && typeof source.getAll === 'function' && typeof source.get === 'function';

  const get = (k) => {
    if (isUSP) return source.get(k) || '';
    const v = source[k];
    if (Array.isArray(v)) return v[0] || '';
    return v || '';
  };
  const getAll = (k) => {
    let arr;
    if (isUSP) arr = source.getAll(k);
    else {
      const v = source[k];
      if (v === null || v === undefined) arr = [];
      else if (Array.isArray(v)) arr = v;
      else arr = [v];
    }
    return arr.filter(v => v !== null && v !== undefined && String(v).trim() !== '');
  };
  const splitCsv = (raw) => !raw ? [] : String(raw).split(/[,\s]+/).map(s => s.trim()).filter(Boolean);

  return {
    q:                get('q'),
    stateList:        getAll('state').map(s => String(s).toUpperCase()),
    cityList:         splitCsv(get('city')),
    zipList:          splitCsv(get('zip')),
    countyList:       splitCsv(get('county')),
    type:             get('type'),
    pipeline:         get('pipeline'),
    propStatus:       get('prop_status'),
    occupancy:        get('occupancy'),
    mktResult:        get('mkt_result'),                  // legacy single-value (kept for compat)
    mktIncludeList:   getAll('mkt_include'),
    mktExcludeList:   getAll('mkt_exclude'),
    minAssessed:      get('min_assessed'),
    maxAssessed:      get('max_assessed'),
    minEquity:        get('min_equity'),
    maxEquity:        get('max_equity'),
    minYear:          get('min_year'),
    maxYear:          get('max_year'),
    uploadFrom:       get('upload_from'),
    uploadTo:         get('upload_to'),
    phones:           get('phones'),
    minOwned:         get('min_owned'),
    maxOwned:         get('max_owned'),
    tag:              get('tag'),
    listId:           get('list_id'),
    stackList:        getAll('stack_list').map(v => parseInt(v)).filter(n => !isNaN(n)),
    minStack:         get('min_stack'),
    minDistress:      get('min_distress'),
    // Raw city/zip/county kept for form repopulation
    cityRaw:          get('city'),
    zipRaw:           get('zip'),
    countyRaw:        get('county'),
  };
}

/**
 * Turns the parsed filter object into { conditions: string[], params: any[], nextIdx }.
 * Caller composes: `WHERE ${conditions.join(' AND ')}` with `params` + LIMIT/OFFSET.
 *
 * Assumes the FROM clause is:
 *   FROM properties p
 *   LEFT JOIN property_contacts pc ON pc.property_id = p.id AND pc.primary_contact = true
 *   LEFT JOIN contacts c ON c.id = pc.contact_id
 * (Note: no LEFT JOIN on phones — we use EXISTS subqueries for phone search so
 *  the row count doesn't balloon. This is the Issue #4(c) fix.)
 */
function buildPropertyFilters(parsed) {
  const conditions = [];
  const params = [];
  let idx = 1;

  // Normalized address helpers — prefer generated columns if present in schema,
  // fall back to the inline LOWER+TRIM+REGEXP for older DBs.
  const pStreetN = 'COALESCE(p.street_normalized, LOWER(TRIM(p.street)))';
  const cMailN   = 'COALESCE(c.mailing_address_normalized, LOWER(TRIM(c.mailing_address)))';

  // ── Free-text search (street/city/zip/name/phone via EXISTS) ────────────────
  if (parsed.q) {
    conditions.push(`(
      p.street ILIKE $${idx}
      OR p.city ILIKE $${idx}
      OR p.zip_code ILIKE $${idx}
      OR c.first_name ILIKE $${idx}
      OR c.last_name ILIKE $${idx}
      OR EXISTS (
        SELECT 1 FROM phones ph_q
        JOIN property_contacts pc_q ON pc_q.contact_id = ph_q.contact_id
        WHERE pc_q.property_id = p.id AND ph_q.phone_number ILIKE $${idx}
      )
    )`);
    params.push(`%${parsed.q}%`); idx++;
  }

  // ── Location ────────────────────────────────────────────────────────────────
  if (parsed.stateList.length > 0) {
    conditions.push(`p.state_code = ANY($${idx}::text[])`);
    params.push(parsed.stateList); idx++;
  }
  if (parsed.cityList.length > 0) {
    const ors = parsed.cityList.map(() => `p.city ILIKE $${idx++}`);
    conditions.push(`(${ors.join(' OR ')})`);
    parsed.cityList.forEach(v => params.push(`%${v}%`));
  }
  if (parsed.zipList.length > 0) {
    const ors = parsed.zipList.map(() => `p.zip_code ILIKE $${idx++}`);
    conditions.push(`(${ors.join(' OR ')})`);
    parsed.zipList.forEach(v => params.push(`${v}%`));
  }
  if (parsed.countyList.length > 0) {
    const ors = parsed.countyList.map(() => `p.county ILIKE $${idx++}`);
    conditions.push(`(${ors.join(' OR ')})`);
    parsed.countyList.forEach(v => params.push(`%${v}%`));
  }

  // ── Property attributes (exact match) ───────────────────────────────────────
  if (parsed.type)       { conditions.push(`p.property_type = $${idx}`);     params.push(parsed.type); idx++; }
  if (parsed.pipeline)   { conditions.push(`p.pipeline_stage = $${idx}`);    params.push(parsed.pipeline); idx++; }
  if (parsed.propStatus) { conditions.push(`p.property_status = $${idx}`);   params.push(parsed.propStatus); idx++; }

  // ── Owner Occupancy ────────────────────────────────────────────────────────
  if (parsed.occupancy === 'owner_occupied') {
    conditions.push(`(
      c.mailing_address IS NOT NULL
      AND ${pStreetN} = ${cMailN}
      AND LOWER(TRIM(p.city)) = LOWER(TRIM(c.mailing_city))
      AND UPPER(TRIM(p.state_code)) = UPPER(TRIM(c.mailing_state))
      AND SUBSTRING(TRIM(p.zip_code) FROM 1 FOR 5) = SUBSTRING(TRIM(c.mailing_zip) FROM 1 FOR 5)
    )`);
  } else if (parsed.occupancy === 'absent_owner') {
    conditions.push(`(
      c.mailing_address IS NOT NULL AND TRIM(c.mailing_address) != ''
      AND NOT (
        ${pStreetN} = ${cMailN}
        AND LOWER(TRIM(p.city)) = LOWER(TRIM(c.mailing_city))
        AND UPPER(TRIM(p.state_code)) = UPPER(TRIM(c.mailing_state))
        AND SUBSTRING(TRIM(p.zip_code) FROM 1 FOR 5) = SUBSTRING(TRIM(c.mailing_zip) FROM 1 FOR 5)
      )
    )`);
  } else if (parsed.occupancy === 'unknown') {
    conditions.push(`(c.mailing_address IS NULL OR TRIM(c.mailing_address) = '')`);
  }

  // ── Marketing Result (PER-CAMPAIGN source — split on ' — ' list suffix) ─────
  // A property matches a marketing-result value if ANY of its campaign appearances
  // (SMS → campaign_contacts OR cold-call → campaign_numbers) has that value.
  const mktMatchExpr = (paramIdx) => `(
    EXISTS (
      SELECT 1 FROM campaign_contacts cc_mkt
      WHERE LOWER(TRIM(cc_mkt.property_address)) = LOWER(TRIM(p.street))
        AND UPPER(TRIM(cc_mkt.property_state)) = UPPER(TRIM(p.state_code))
        AND cc_mkt.marketing_result IS NOT NULL
        AND split_part(cc_mkt.marketing_result, ' — ', 1) = ANY($${paramIdx}::text[])
    )
    OR EXISTS (
      SELECT 1 FROM campaign_numbers cn_mkt
      JOIN phones ph_mkt ON ph_mkt.phone_number = cn_mkt.phone_number
      JOIN property_contacts pc_mkt ON pc_mkt.contact_id = ph_mkt.contact_id AND pc_mkt.property_id = p.id
      WHERE cn_mkt.marketing_result IS NOT NULL
        AND split_part(cn_mkt.marketing_result, ' — ', 1) = ANY($${paramIdx}::text[])
    )
  )`;

  if (parsed.mktResult) {
    conditions.push(mktMatchExpr(idx));
    params.push([parsed.mktResult]); idx++;
  }
  if (parsed.mktIncludeList.length > 0) {
    conditions.push(mktMatchExpr(idx));
    params.push(parsed.mktIncludeList); idx++;
  }
  if (parsed.mktExcludeList.length > 0) {
    conditions.push(`NOT ${mktMatchExpr(idx)}`);
    params.push(parsed.mktExcludeList); idx++;
  }

  // ── Numeric ranges ─────────────────────────────────────────────────────────
  if (parsed.minAssessed) { conditions.push(`p.assessed_value >= $${idx}`); params.push(parsed.minAssessed); idx++; }
  if (parsed.maxAssessed) { conditions.push(`p.assessed_value <= $${idx}`); params.push(parsed.maxAssessed); idx++; }
  if (parsed.minEquity)   { conditions.push(`p.equity_percent >= $${idx}`); params.push(parsed.minEquity); idx++; }
  if (parsed.maxEquity)   { conditions.push(`p.equity_percent <= $${idx}`); params.push(parsed.maxEquity); idx++; }
  if (parsed.minYear)     { conditions.push(`p.year_built >= $${idx}`);     params.push(parsed.minYear); idx++; }
  if (parsed.maxYear)     { conditions.push(`p.year_built <= $${idx}`);     params.push(parsed.maxYear); idx++; }

  // ── Dates ──────────────────────────────────────────────────────────────────
  if (parsed.uploadFrom) { conditions.push(`p.created_at >= $${idx}`); params.push(parsed.uploadFrom); idx++; }
  if (parsed.uploadTo)   { conditions.push(`p.created_at <= $${idx}`); params.push(parsed.uploadTo + ' 23:59:59'); idx++; }

  // ── Phones (has / none) — EXISTS to avoid join bloat ───────────────────────
  if (parsed.phones === 'has') {
    conditions.push(`EXISTS (SELECT 1 FROM phones ph_f JOIN property_contacts pc_f ON pc_f.contact_id = ph_f.contact_id WHERE pc_f.property_id = p.id)`);
  } else if (parsed.phones === 'none') {
    conditions.push(`NOT EXISTS (SELECT 1 FROM phones ph_f JOIN property_contacts pc_f ON pc_f.contact_id = ph_f.contact_id WHERE pc_f.property_id = p.id)`);
  }

  // ── Properties owned (portfolio count) — uses owner_portfolio_counts MV ────
  // Falls back to correlated subquery if MV not present. The MV is per-tenant
  // (tenant_id is in the unique key), so the lookup constrains by p.tenant_id.
  if (parsed.minOwned || parsed.maxOwned) {
    const ownedExpr = `(
      CASE WHEN c.mailing_address IS NULL OR TRIM(c.mailing_address) = '' THEN 1
      ELSE COALESCE(
        (SELECT owned_count FROM owner_portfolio_counts opc
          WHERE opc.tenant_id = p.tenant_id
            AND opc.mailing_address_normalized = ${cMailN}
            AND opc.mailing_city_normalized    = LOWER(TRIM(c.mailing_city))
            AND opc.mailing_state              = UPPER(TRIM(c.mailing_state))
            AND opc.zip5                       = SUBSTRING(TRIM(c.mailing_zip) FROM 1 FOR 5)),
        (SELECT COUNT(*) FROM properties p2
          JOIN property_contacts pc2 ON pc2.property_id = p2.id AND pc2.primary_contact = true AND pc2.tenant_id = p.tenant_id
          JOIN contacts c2 ON c2.id = pc2.contact_id AND c2.tenant_id = p.tenant_id
          WHERE p2.tenant_id = p.tenant_id
            AND c2.mailing_address IS NOT NULL AND TRIM(c2.mailing_address) != ''
            AND COALESCE(c2.mailing_address_normalized, LOWER(TRIM(c2.mailing_address))) = ${cMailN}
            AND LOWER(TRIM(c2.mailing_city)) = LOWER(TRIM(c.mailing_city))
            AND UPPER(TRIM(p2.state_code))   = UPPER(TRIM(p.state_code))
            AND SUBSTRING(TRIM(c2.mailing_zip) FROM 1 FOR 5) = SUBSTRING(TRIM(c.mailing_zip) FROM 1 FOR 5))
      ) END
    )`;
    if (parsed.minOwned) { conditions.push(`${ownedExpr} >= $${idx}`); params.push(parseInt(parsed.minOwned)); idx++; }
    if (parsed.maxOwned) { conditions.push(`${ownedExpr} <= $${idx}`); params.push(parseInt(parsed.maxOwned)); idx++; }
  }

  // ── Tag ────────────────────────────────────────────────────────────────────
  if (parsed.tag) {
    conditions.push(`EXISTS (SELECT 1 FROM property_tags pt_f WHERE pt_f.property_id = p.id AND pt_f.tag_id = $${idx})`);
    params.push(parseInt(parsed.tag)); idx++;
  }

  // ── List membership ────────────────────────────────────────────────────────
  if (parsed.listId) {
    conditions.push(`EXISTS (SELECT 1 FROM property_lists pl2 WHERE pl2.property_id = p.id AND pl2.list_id = $${idx})`);
    params.push(parsed.listId); idx++;
  }

  // ── Stack list (AND logic — must be on ALL selected lists) ─────────────────
  if (parsed.stackList.length > 0) {
    conditions.push(
      `(SELECT COUNT(DISTINCT pl_stack.list_id)
          FROM property_lists pl_stack
         WHERE pl_stack.property_id = p.id
           AND pl_stack.list_id = ANY($${idx}::int[])) = $${idx + 1}`
    );
    params.push(parsed.stackList);
    params.push(parsed.stackList.length);
    idx += 2;
  }

  // ── Min list stack / min distress ──────────────────────────────────────────
  if (parsed.minStack) {
    conditions.push(`(SELECT COUNT(*) FROM property_lists plc WHERE plc.property_id = p.id) >= $${idx}`);
    params.push(parseInt(parsed.minStack)); idx++;
  }
  if (parsed.minDistress) {
    conditions.push(`p.distress_score >= $${idx}`);
    params.push(parseInt(parsed.minDistress)); idx++;
  }

  return { conditions, params, nextIdx: idx };
}

module.exports = { parseFilterInput, buildPropertyFilters };
