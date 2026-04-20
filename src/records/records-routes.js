const express = require('express');
const router = express.Router();
const { query, pool } = require('../db');
const distress = require('../scoring/distress');
const settings = require('../settings');

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.redirect('/login');
}

const { shell } = require('../shared-shell');

// ── Tag Schema ──────────────────────────────────────────────────────────────
let _tagSchemaReady = false;
async function ensureTagSchema() {
  if (_tagSchemaReady) return;
  await query(`
    CREATE TABLE IF NOT EXISTS tags (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      color VARCHAR(7) DEFAULT '#6b7280',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_name_lower ON tags (LOWER(name));
    CREATE TABLE IF NOT EXISTS property_tags (
      property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (property_id, tag_id)
    );
    CREATE INDEX IF NOT EXISTS idx_property_tags_tag ON property_tags(tag_id);
    CREATE INDEX IF NOT EXISTS idx_property_tags_prop ON property_tags(property_id);
  `);
  _tagSchemaReady = true;
}

function fmt(val, fallback) { return val || fallback || '—'; }
function fmtDate(val) { if (!val) return '—'; return new Date(val).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }); }
function fmtMoney(val) { if (!val) return '—'; return '$' + Number(val).toLocaleString(); }
function escHTML(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

// Owner Occupancy — derived from comparing property address to mailing address.
// Returns 'owner_occupied' | 'absent_owner' | 'unknown'.
// Normalizes case + whitespace + common abbreviations to avoid false negatives
// like "St" vs "Street". ZIP collapses to 5 digits.
function normalizeAddrPart(s) {
  if (!s) return '';
  return String(s).toLowerCase().trim()
    .replace(/[.,]/g, '')                  // strip periods + commas
    .replace(/\s+/g, ' ')                  // collapse whitespace
    .replace(/\bstreet\b/g, 'st')          // common abbreviations
    .replace(/\bavenue\b/g, 'ave')
    .replace(/\bdrive\b/g, 'dr')
    .replace(/\bboulevard\b/g, 'blvd')
    .replace(/\broad\b/g, 'rd')
    .replace(/\blane\b/g, 'ln')
    .replace(/\bcourt\b/g, 'ct')
    .replace(/\bplace\b/g, 'pl')
    .replace(/\bcircle\b/g, 'cir')
    .replace(/\bterrace\b/g, 'ter')
    .replace(/\bparkway\b/g, 'pkwy')
    .replace(/\bhighway\b/g, 'hwy');
}
function computeOwnerOccupancy(prop, contact) {
  if (!contact || !contact.mailing_address) return 'unknown';
  const propStreet = normalizeAddrPart(prop.street);
  const propCity   = normalizeAddrPart(prop.city);
  const propState  = (prop.state_code || '').toUpperCase().trim();
  const propZip    = (prop.zip_code || '').trim().slice(0, 5);
  const mailStreet = normalizeAddrPart(contact.mailing_address);
  const mailCity   = normalizeAddrPart(contact.mailing_city);
  const mailState  = (contact.mailing_state || '').toUpperCase().trim();
  const mailZip    = (contact.mailing_zip || '').trim().slice(0, 5);
  if (!mailStreet) return 'unknown';
  // Strict match: street + city + state + zip-5 all align
  if (propStreet === mailStreet && propCity === mailCity && propState === mailState && propZip === mailZip) {
    return 'owner_occupied';
  }
  return 'absent_owner';
}
const OCCUPANCY_LABELS = {
  owner_occupied: 'Owner Occupied',
  absent_owner:   'Absent Owner',
  unknown:        'Unknown',
};

// ═══════════════════════════════════════════════════════════════════════════════
// RECORDS LIST — GET /records
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/', requireAuth, async (req, res) => {
  try {
    // Ensure distress columns exist before querying them
    await distress.ensureDistressSchema();
    const {
      q = '', city = '', zip = '', county = '',
      type = '', list_id = '', min_stack = '',
      pipeline = '', mkt_result = '', prop_status = '',
      min_assessed = '', max_assessed = '',
      min_equity = '', max_equity = '',
      min_year = '', max_year = '',
      upload_from = '', upload_to = '',
      min_distress = '',
      occupancy = '',
      phones = '',
      min_owned = '', max_owned = '',
      tag = '',
      msg = '', err = '',
      page = 1
    } = req.query;

    // Escape user-supplied flash messages before rendering into HTML
    const escHTML = (s) => String(s || '').replace(/[&<>"']/g, ch => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
    const msgSafe = escHTML(msg);
    const errSafe = escHTML(err);

    // stack_list can arrive as a single string, an array (multi-checkbox), or absent.
    // Normalize to an array of non-empty strings.
    let stackList = req.query.stack_list;
    if (!stackList) stackList = [];
    else if (!Array.isArray(stackList)) stackList = [stackList];
    stackList = stackList.filter(v => v !== null && v !== undefined && String(v).trim() !== '');

    // state can arrive as a single string OR an array. Normalize to array of upper-case codes.
    let stateList = req.query.state;
    if (!stateList) stateList = [];
    else if (!Array.isArray(stateList)) stateList = [stateList];
    stateList = stateList.filter(v => v !== null && v !== undefined && String(v).trim() !== '').map(s => String(s).toUpperCase());

    // Marketing Result Include/Exclude — both arrive as arrays from multi-select
    const normalizeArr = (raw) => {
      if (!raw) return [];
      const arr = Array.isArray(raw) ? raw : [raw];
      return arr.filter(v => v !== null && v !== undefined && String(v).trim() !== '');
    };
    const mktIncludeList = normalizeArr(req.query.mkt_include);
    const mktExcludeList = normalizeArr(req.query.mkt_exclude);

    // Helper: parse comma- or whitespace-separated values into an array of trimmed strings.
    // "46218, 46219 46220" => ['46218','46219','46220']
    function splitCsv(raw) {
      if (!raw) return [];
      return String(raw).split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
    }
    // HTML escape — used wherever user-controlled query params flow into rendered HTML
    const esc = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    const cityList   = splitCsv(city);
    const zipList    = splitCsv(zip);
    const countyList = splitCsv(county);

    const limit = 25;
    const offset = (parseInt(page) - 1) * limit;

    let conditions = [];
    let params = [];
    let idx = 1;

    if (q) {
      conditions.push(`(p.street ILIKE $${idx} OR p.city ILIKE $${idx} OR p.zip_code ILIKE $${idx} OR c.first_name ILIKE $${idx} OR c.last_name ILIKE $${idx} OR ph.phone_number ILIKE $${idx})`);
      params.push(`%${q}%`); idx++;
    }
    if (stateList.length > 0) {
      conditions.push(`p.state_code = ANY($${idx}::text[])`);
      params.push(stateList);
      idx++;
    }
    if (cityList.length > 0) {
      // ILIKE doesn't work reliably with ANY(array) — build explicit OR chain
      const orClauses = cityList.map(() => `p.city ILIKE $${idx++}`);
      conditions.push(`(${orClauses.join(' OR ')})`);
      cityList.forEach(c => params.push(`%${c}%`));
    }
    if (zipList.length > 0) {
      // Same fix: explicit OR chain for ZIP prefix matches
      const orClauses = zipList.map(() => `p.zip_code ILIKE $${idx++}`);
      conditions.push(`(${orClauses.join(' OR ')})`);
      zipList.forEach(z => params.push(`${z}%`));
    }
    if (countyList.length > 0) {
      const orClauses = countyList.map(() => `p.county ILIKE $${idx++}`);
      conditions.push(`(${orClauses.join(' OR ')})`);
      countyList.forEach(c => params.push(`%${c}%`));
    }
    if (type)         { conditions.push(`p.property_type = $${idx}`);     params.push(type); idx++; }
    if (pipeline)     { conditions.push(`p.pipeline_stage = $${idx}`);    params.push(pipeline); idx++; }
    if (prop_status)  { conditions.push(`p.property_status = $${idx}`);   params.push(prop_status); idx++; }
    // Owner Occupancy filter — SQL logic must match the JS computeOwnerOccupancy()
    // helper (case-insensitive, strip periods/commas, normalize street suffix
    // abbreviations so "Main St" matches "Main Street", ZIP collapsed to 5).
    // This is wrapped in a CTE-style expression: REGEXP_REPLACE chained for each
    // suffix word boundary. \y is Postgres word-boundary. (?i) is case-insensitive.
    const NORM_ADDR = (col) => `
      REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(
      REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(
        LOWER(REGEXP_REPLACE(TRIM(${col}), '[.,]+', '', 'g')),
        '\\ystreet\\y',  'st',   'g'),
        '\\yavenue\\y',  'ave',  'g'),
        '\\ydrive\\y',   'dr',   'g'),
        '\\yboulevard\\y','blvd', 'g'),
        '\\yroad\\y',    'rd',   'g'),
        '\\ylane\\y',    'ln',   'g'),
        '\\ycourt\\y',   'ct',   'g'),
        '\\yplace\\y',   'pl',   'g'),
        '\\ycircle\\y',  'cir',  'g'),
        '\\yterrace\\y', 'ter',  'g'),
        '\\yparkway\\y', 'pkwy', 'g'),
        '\\yhighway\\y', 'hwy',  'g'),
        '\\s+', ' ', 'g')`;
    if (occupancy === 'owner_occupied') {
      conditions.push(`(
        c.mailing_address IS NOT NULL
        AND ${NORM_ADDR('p.street')} = ${NORM_ADDR('c.mailing_address')}
        AND LOWER(TRIM(p.city)) = LOWER(TRIM(c.mailing_city))
        AND UPPER(TRIM(p.state_code)) = UPPER(TRIM(c.mailing_state))
        AND SUBSTRING(TRIM(p.zip_code) FROM 1 FOR 5) = SUBSTRING(TRIM(c.mailing_zip) FROM 1 FOR 5)
      )`);
    } else if (occupancy === 'absent_owner') {
      conditions.push(`(
        c.mailing_address IS NOT NULL AND TRIM(c.mailing_address) != ''
        AND NOT (
          ${NORM_ADDR('p.street')} = ${NORM_ADDR('c.mailing_address')}
          AND LOWER(TRIM(p.city)) = LOWER(TRIM(c.mailing_city))
          AND UPPER(TRIM(p.state_code)) = UPPER(TRIM(c.mailing_state))
          AND SUBSTRING(TRIM(p.zip_code) FROM 1 FOR 5) = SUBSTRING(TRIM(c.mailing_zip) FROM 1 FOR 5)
        )
      )`);
    } else if (occupancy === 'unknown') {
      conditions.push(`(c.mailing_address IS NULL OR TRIM(c.mailing_address) = '')`);
    }
    // ── Marketing Result (PER-CAMPAIGN source — decision #1, Audit #1) ──────
    // A property matches if ANY of its campaign appearances (SMS via
    // campaign_contacts OR cold-call via campaign_numbers) has the given
    // marketing_result value (list suffix " — ListName" stripped on compare).
    // Was `p.marketing_result` — that column is almost never populated and
    // returned 0 rows for every filter choice.
    const mktCampaignMatch = (paramIdx) => `(
      EXISTS (
        SELECT 1 FROM campaign_contacts cc_mkt
        WHERE cc_mkt.property_address_normalized = p.street_normalized
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
    if (mkt_result)   { conditions.push(mktCampaignMatch(idx));  params.push([mkt_result]); idx++; }
    if (mktIncludeList.length > 0) {
      conditions.push(mktCampaignMatch(idx));
      params.push(mktIncludeList);
      idx++;
    }
    if (mktExcludeList.length > 0) {
      conditions.push(`NOT ${mktCampaignMatch(idx)}`);
      params.push(mktExcludeList);
      idx++;
    }
    if (min_assessed) { conditions.push(`p.assessed_value >= $${idx}`);   params.push(min_assessed); idx++; }
    if (max_assessed) { conditions.push(`p.assessed_value <= $${idx}`);   params.push(max_assessed); idx++; }
    if (min_equity)   { conditions.push(`p.equity_percent >= $${idx}`);   params.push(min_equity); idx++; }
    if (max_equity)   { conditions.push(`p.equity_percent <= $${idx}`);   params.push(max_equity); idx++; }
    // Phones filter: 'has' = property has 1+ phone numbers attached via its contacts,
    // 'none' = property has zero phones. Uses EXISTS / NOT EXISTS against the phones
    // table joined through property_contacts for efficiency.
    if (phones === 'has') {
      conditions.push(`EXISTS (SELECT 1 FROM phones ph_f JOIN property_contacts pc_f ON pc_f.contact_id = ph_f.contact_id WHERE pc_f.property_id = p.id)`);
    } else if (phones === 'none') {
      conditions.push(`NOT EXISTS (SELECT 1 FROM phones ph_f JOIN property_contacts pc_f ON pc_f.contact_id = ph_f.contact_id WHERE pc_f.property_id = p.id)`);
    }
    // Properties-owned filter: counts how many properties in the DB share the
    // same normalized mailing address (via the primary contact). This identifies
    // portfolio landlords (high count) vs individual homeowners (count = 1).
    // Properties with no mailing address are treated as count 1 (unknowable).
    if (min_owned || max_owned) {
      // 2026-04-18 audit fix #8: was running a 13-layer REGEXP_REPLACE chain
      // as a correlated subquery for every property row. On 75k properties
      // that's 75k × 75k = ~5B row comparisons per filter. Now uses the
      // owner_portfolio_counts materialized view (created in db.js). The MV
      // pre-aggregates counts keyed by normalized (address, city, state, zip5).
      // Single indexed lookup per property row instead of a full scan.
      //   Properties with no mailing address still treated as count 1.
      const ownedSubquery = `
        CASE WHEN c.mailing_address IS NULL OR TRIM(c.mailing_address) = '' THEN 1
        ELSE COALESCE(
          (SELECT opc.owned_count FROM owner_portfolio_counts opc
            WHERE opc.mailing_address_normalized = c.mailing_address_normalized
              AND opc.mailing_city_normalized = LOWER(TRIM(c.mailing_city))
              AND opc.mailing_state = UPPER(TRIM(c.mailing_state))
              AND opc.zip5 = SUBSTRING(TRIM(c.mailing_zip) FROM 1 FOR 5)),
          1
        ) END`;
      if (min_owned) { conditions.push(`${ownedSubquery} >= $${idx}`); params.push(parseInt(min_owned)); idx++; }
      if (max_owned) { conditions.push(`${ownedSubquery} <= $${idx}`); params.push(parseInt(max_owned)); idx++; }
    }
    // Tag filter — show only properties that have a specific tag
    if (tag) {
      conditions.push(`EXISTS (SELECT 1 FROM property_tags pt_f WHERE pt_f.property_id = p.id AND pt_f.tag_id = $${idx})`);
      params.push(parseInt(tag)); idx++;
    }
    if (min_year)     { conditions.push(`p.year_built >= $${idx}`);       params.push(min_year); idx++; }
    if (max_year)     { conditions.push(`p.year_built <= $${idx}`);       params.push(max_year); idx++; }
    if (upload_from)  { conditions.push(`p.created_at >= $${idx}`);       params.push(upload_from); idx++; }
    if (upload_to)    { conditions.push(`p.created_at <= $${idx}`);       params.push(upload_to + ' 23:59:59'); idx++; }
    if (list_id)      { conditions.push(`EXISTS (SELECT 1 FROM property_lists pl2 WHERE pl2.property_id = p.id AND pl2.list_id = $${idx})`); params.push(list_id); idx++; }

    // ── AND-stacking: property must appear on EVERY selected list ────────────
    // For N selected lists, require N matching rows in property_lists. If only
    // 1 list is selected, this behaves identically to the old single-list filter.
    if (stackList.length > 0) {
      const listIdInts = stackList.map(v => parseInt(v)).filter(n => !isNaN(n));
      if (listIdInts.length > 0) {
        conditions.push(
          `(SELECT COUNT(DISTINCT pl_stack.list_id)
              FROM property_lists pl_stack
             WHERE pl_stack.property_id = p.id
               AND pl_stack.list_id = ANY($${idx}::int[])) = $${idx+1}`
        );
        params.push(listIdInts);
        params.push(listIdInts.length);
        idx += 2;
      }
    }

    if (min_stack)    { conditions.push(`(SELECT COUNT(*) FROM property_lists plc WHERE plc.property_id = p.id) >= $${idx}`); params.push(parseInt(min_stack)); idx++; }
    if (min_distress) { conditions.push(`p.distress_score >= $${idx}`); params.push(parseInt(min_distress)); idx++; }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    // 2026-04-18 audit fix #5: LEFT JOIN phones was unconditional but only
    // used when `q` search is active (via ph.phone_number ILIKE in the OR chain
    // at the top of this handler). Without `q`, the join just fans out rows
    // per-phone then gets deduplicated by COUNT(DISTINCT) / DISTINCT ON — pure
    // overhead. Big perf win on large DBs.
    const phoneJoin = q ? `LEFT JOIN phones ph ON ph.contact_id = c.id` : '';

    const countRes = await query(`
      SELECT COUNT(DISTINCT p.id) FROM properties p
      LEFT JOIN property_contacts pc ON pc.property_id = p.id AND pc.primary_contact = true
      LEFT JOIN contacts c ON c.id = pc.contact_id
      ${phoneJoin}
      ${where}
    `, params);
    const total = parseInt(countRes.rows[0].count);

    // Fetch all lists for stack filter dropdown
    const allListsRes = await query(`SELECT id, list_name FROM lists ORDER BY list_name ASC`);
    const allLists = allListsRes.rows;

    // Fetch all distinct states present in the DB for multi-select state filter
    const allStatesRes = await query(`SELECT DISTINCT state_code FROM properties WHERE state_code IS NOT NULL AND state_code <> '' ORDER BY state_code ASC`);
    const STATE_NAMES = { AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',CT:'Connecticut',DE:'Delaware',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming',DC:'District of Columbia' };
    const allStates = allStatesRes.rows.map(r => ({ code: r.state_code, name: STATE_NAMES[r.state_code] || r.state_code }));

    const rows = await query(`
      SELECT DISTINCT ON (p.id)
        p.id, p.street, p.city, p.state_code, p.zip_code,
        p.property_type, p.vacant, p.pipeline_stage, p.source,
        p.estimated_value, p.condition, p.created_at,
        p.distress_score, p.distress_band,
        c.first_name, c.last_name,
        (SELECT COUNT(*) FROM property_lists pl WHERE pl.property_id = p.id) AS list_count,
        (SELECT COUNT(*) FROM phones ph2
          JOIN property_contacts pc2 ON pc2.contact_id = ph2.contact_id
          WHERE pc2.property_id = p.id) AS phone_count
      FROM properties p
      LEFT JOIN property_contacts pc ON pc.property_id = p.id AND pc.primary_contact = true
      LEFT JOIN contacts c ON c.id = pc.contact_id
      ${phoneJoin}
      ${where}
      ORDER BY p.id DESC, p.created_at DESC
      LIMIT $${idx} OFFSET $${idx+1}
    `, [...params, limit, offset]);

    // Fetch all tags for the tag filter dropdown + bulk-tag remove modal
    await ensureTagSchema();
    const allTagsRes = await query(`SELECT id, name, color FROM tags ORDER BY name ASC`);
    const allTags = allTagsRes.rows;

    const totalPages = Math.ceil(total / limit);

    const tableRows = rows.rows.map(r => {
      const owner = [r.first_name, r.last_name].filter(Boolean).join(' ') || '—';
      const stage = r.pipeline_stage || 'prospect';
      const stageColor = {prospect:'#f5f4f0',lead:'#e8f5ee',contract:'#fff8e1',closed:'#e8f0ff'}[stage]||'#f5f4f0';
      const stageText = {prospect:'#555',lead:'#1a7a4a',contract:'#9a6800',closed:'#2c5cc5'}[stage]||'#555';
      // Distress badge
      const dScore = r.distress_score;
      const dBand = r.distress_band;
      const dColor = (dBand && distress.BAND_COLORS[dBand]) ? distress.BAND_COLORS[dBand] : null;
      const distressCell = (dScore == null || dScore === undefined)
        ? '<span style="color:#ccc;font-size:12px">—</span>'
        : `<span style="background:${dColor.bg};color:${dColor.text};padding:3px 9px;border-radius:5px;font-size:11px;font-weight:600;display:inline-block;min-width:38px">${dScore}</span>`;
      return `<tr data-id="${r.id}" style="cursor:pointer;border-bottom:1px solid #f0efe9" onclick="window.location='/records/${r.id}'" onmouseover="if(!this.classList.contains('row-selected'))this.style.background='#fafaf8'" onmouseout="if(!this.classList.contains('row-selected'))this.style.background=''">
        <td style="width:40px;padding:12px 0 12px 16px" onclick="event.stopPropagation()"><input type="checkbox" class="row-check" data-id="${r.id}" onchange="selectRow(this, this.checked)" style="cursor:pointer;width:15px;height:15px"></td>
        <td style="padding:12px"><div style="font-weight:500;font-size:13px">${r.street}</div><div style="font-size:12px;color:#888;margin-top:2px">${r.city}, ${r.state_code} ${r.zip_code}</div></td>
        <td style="padding:12px;font-size:13px;color:#555;text-align:left">${owner}</td>
        <td style="padding:12px;font-size:13px;color:#555;text-align:left">${fmt(r.property_type)}</td>
        <td style="padding:12px;font-size:13px;text-align:center">${r.phone_count || 0}</td>
        <td style="padding:12px;font-size:13px;text-align:center">${r.list_count || 0}</td>
        <td style="padding:12px;text-align:center">${distressCell}</td>
        <td style="padding:12px;text-align:left"><span style="background:${stageColor};color:${stageText};padding:3px 10px;border-radius:5px;font-size:11px;font-weight:600;text-transform:capitalize">${stage}</span></td>
        <td style="padding:12px;font-size:12px;color:#888;white-space:nowrap;text-align:right">${fmtDate(r.created_at)}</td>
      </tr>`;
    }).join('');

    // Build a pagination URL that preserves ALL current filters including multi-select stack_list
    const preserveQS = (newPage) => {
      const parts = [];
      const add = (k, v) => { if (v !== undefined && v !== null && v !== '') parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`); };
      add('q', q); add('city', city); add('zip', zip); add('county', county);
      add('type', type); add('list_id', list_id); add('min_stack', min_stack);
      add('pipeline', pipeline); add('mkt_result', mkt_result); add('prop_status', prop_status);
      add('min_assessed', min_assessed); add('max_assessed', max_assessed);
      add('min_equity', min_equity); add('max_equity', max_equity);
      add('min_year', min_year); add('max_year', max_year);
      add('upload_from', upload_from); add('upload_to', upload_to);
      add('min_distress', min_distress); add('occupancy', occupancy); add('phones', phones);
      add('min_owned', min_owned); add('max_owned', max_owned);
      add('tag', tag);
      stackList.forEach(sl => parts.push(`stack_list=${encodeURIComponent(sl)}`));
      stateList.forEach(s => parts.push(`state=${encodeURIComponent(s)}`));
      mktIncludeList.forEach(m => parts.push(`mkt_include=${encodeURIComponent(m)}`));
      mktExcludeList.forEach(m => parts.push(`mkt_exclude=${encodeURIComponent(m)}`));
      parts.push(`page=${newPage}`);
      return '/records?' + parts.join('&');
    };

    const pagination = totalPages > 1 ? `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:1rem;font-size:13px;color:#555;padding:4px 0">
        <span>Showing ${offset+1}–${Math.min(offset+limit,total)} of ${total.toLocaleString()} records</span>
        <div style="display:flex;gap:6px">
          ${parseInt(page) > 1 ? `<a href="${preserveQS(parseInt(page)-1)}" class="btn btn-ghost" style="padding:6px 12px">← Prev</a>` : ''}
          ${parseInt(page) < totalPages ? `<a href="${preserveQS(parseInt(page)+1)}" class="btn btn-ghost" style="padding:6px 12px">Next →</a>` : ''}
        </div>
      </div>` : '';

    // Filter count — multi-select filters count as 1 each regardless of how many values
    const activeFilterCount = [city,zip,county,type,pipeline,prop_status,mkt_result,occupancy,phones,min_assessed,max_assessed,min_equity,max_equity,min_year,max_year,upload_from,upload_to,min_stack,min_distress,min_owned,max_owned,tag].filter(Boolean).length + (stackList.length > 0 ? 1 : 0) + (stateList.length > 0 ? 1 : 0) + (mktIncludeList.length > 0 ? 1 : 0) + (mktExcludeList.length > 0 ? 1 : 0);

    res.send(shell('Records', `
      <div class="page-header">
        <div>
          <div class="page-title">Records <span class="count-pill">${total.toLocaleString()}</span></div>
          <div class="page-sub">${list_id ? '<a href="/lists" style="color:#888;font-size:13px;text-decoration:none">← Back to Lists</a> &nbsp;·&nbsp; Filtered by list' : 'All properties'}</div>
        </div>
      </div>

      ${msgSafe ? `<div style="background:#eaf6ea;border:1px solid #9bd09b;border-radius:8px;padding:10px 14px;color:#1a5f1a;font-size:13px;margin-bottom:12px">✅ ${msgSafe}</div>` : ''}
      ${errSafe ? `<div style="background:#fdeaea;border:1px solid #f5c5c5;border-radius:8px;padding:10px 14px;color:#8b1f1f;font-size:13px;margin-bottom:12px">❌ ${errSafe}</div>` : ''}

      <form method="GET" action="/records" id="filter-form">
        ${list_id ? '<input type="hidden" name="list_id" value="' + list_id + '">' : ''}

        <!-- Search bar + filter toggle -->
        <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
          <input type="text" name="q" value="${q}" placeholder="Search address, owner name, phone…" autocomplete="off"
            style="flex:1;min-width:200px;padding:9px 14px;border:1px solid #ddd;border-radius:8px;font-size:14px;font-family:inherit;background:#fff">
          <button type="submit" class="btn btn-primary">Search</button>
          <button type="button" class="btn btn-ghost" onclick="toggleFilters()" id="filter-toggle">
            ⚙ Filters${activeFilterCount > 0 ? ' <span style="background:#1a1a1a;color:#fff;border-radius:10px;padding:1px 7px;font-size:11px;margin-left:4px">'+activeFilterCount+'</span>' : ''}
          </button>
          ${q || activeFilterCount > 0
            ? '<a href="/records' + (list_id?'?list_id='+list_id:'') + '" class="btn btn-ghost" style="color:#c0392b;border-color:#f5c5c5">✕ Clear</a>' : ''}
        </div>

        <!-- Expandable filter panel -->
        <div id="filter-panel" style="display:${activeFilterCount>0?'block':'none'};background:#fff;border:1px solid #e0dfd8;border-radius:10px;padding:16px 18px;margin-bottom:14px">

          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px">

            <!-- Location -->
            <div style="grid-column:1/-1;font-size:10px;font-weight:700;color:#aaa;text-transform:uppercase;letter-spacing:.1em;margin-bottom:2px">Location</div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">State <span id="state-count-label" style="color:#888">${stateList.length > 0 ? '('+stateList.length+' selected)' : ''}</span></label>
              <div id="state-ms-wrapper" style="position:relative">
                <div id="state-ms-control" onclick="toggleStateMsDropdown(event)" style="min-height:34px;border:1px solid #ddd;border-radius:7px;padding:4px 26px 4px 6px;background:#fff;cursor:text;display:flex;flex-wrap:wrap;gap:3px;align-items:center;font-size:13px">
                  <div id="state-ms-pills" style="display:flex;flex-wrap:wrap;gap:3px">
                    ${stateList.length === 0 ? '<span id="state-ms-placeholder" style="color:#aaa;font-size:13px;padding:2px">All States</span>' : ''}
                    ${allStates.filter(s => stateList.includes(s.code)).map(s => `
                      <span class="state-ms-pill" data-id="${s.code}" style="display:inline-flex;align-items:center;gap:4px;background:#e8f0ff;color:#1a4a9a;padding:2px 6px;border-radius:4px;font-size:12px;font-weight:500">
                        ${s.code}
                        <button type="button" onclick="removeStateMsPill(event,'${s.code}')" style="background:none;border:none;color:#1a4a9a;cursor:pointer;padding:0;font-size:13px;line-height:1;font-family:inherit">×</button>
                      </span>
                    `).join('')}
                  </div>
                  <span style="position:absolute;right:8px;top:50%;transform:translateY(-50%);color:#888;font-size:10px;pointer-events:none">▾</span>
                </div>
                <div id="state-ms-dropdown" style="display:none;position:absolute;top:calc(100% + 4px);left:0;right:0;background:#fff;border:1px solid #ddd;border-radius:7px;box-shadow:0 4px 16px rgba(0,0,0,.08);max-height:240px;overflow:hidden;z-index:100;flex-direction:column">
                  <input type="text" id="state-ms-search" placeholder="Search state…" oninput="filterStateMsOptions()" onclick="event.stopPropagation()" style="width:100%;padding:7px 9px;border:none;border-bottom:1px solid #eee;font-size:13px;font-family:inherit;outline:none;box-sizing:border-box">
                  <div id="state-ms-options" style="overflow-y:auto;flex:1">
                    ${allStates.length === 0
                      ? '<div style="color:#aaa;font-size:13px;padding:10px">No states found</div>'
                      : allStates.map(s => {
                          const isSel = stateList.includes(s.code);
                          const safeName = (s.name || '').replace(/'/g, "\\'");
                          return `<div class="state-ms-option" data-id="${s.code}" data-search="${(s.code+' '+s.name).toLowerCase()}" onclick="toggleStateMsOption(event,'${s.code}','${safeName}')" style="padding:6px 10px;font-size:13px;cursor:pointer;display:flex;align-items:center;gap:8px;${isSel ? 'background:#f0f7ff;color:#1a4a9a;font-weight:500' : ''}" onmouseover="if(!this.classList.contains('state-ms-selected'))this.style.background='#fafaf8'" onmouseout="if(!this.classList.contains('state-ms-selected'))this.style.background=''">
                            <span style="width:14px;display:inline-block">${isSel ? '✓' : ''}</span>
                            <span style="font-weight:500;font-family:monospace;width:28px">${s.code}</span>
                            <span style="color:#888">${s.name}</span>
                          </div>`;
                        }).join('')}
                  </div>
                </div>
              </div>
              <div id="state-ms-hidden-inputs">
                ${stateList.map(c => `<input type="hidden" name="state" value="${c}">`).join('')}
              </div>
            </div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">City</label>
              <input type="text" name="city" value="${city}" placeholder="e.g. Indianapolis, Avon" style="width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit">
              <p style="font-size:10px;color:#aaa;margin-top:3px">Comma-separate to match multiple</p>
            </div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">ZIP Code</label>
              <input type="text" name="zip" value="${zip}" placeholder="e.g. 46218, 46219, 46220" style="width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit">
              <p style="font-size:10px;color:#aaa;margin-top:3px">Comma- or space-separated</p>
            </div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">County</label>
              <input type="text" name="county" value="${county}" placeholder="e.g. Marion, Hamilton" style="width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit">
              <p style="font-size:10px;color:#aaa;margin-top:3px">Comma-separate to match multiple</p>
            </div>

            <!-- Property -->
            <div style="grid-column:1/-1;font-size:10px;font-weight:700;color:#aaa;text-transform:uppercase;letter-spacing:.1em;margin:6px 0 2px">Property</div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">Type</label>
              <select name="type" style="width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit;background:#fff">
                <option value="">All Types</option>
                ${['SFR','MFR','Land','Commercial'].map(t=>`<option value="${t}" ${type===t?'selected':''}>${t}</option>`).join('')}
              </select>
            </div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">Property Status</label>
              <select name="prop_status" style="width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit;background:#fff">
                <option value="">Any</option>
                ${['Off Market','Pending','Sold'].map(s=>`<option value="${s}" ${prop_status===s?'selected':''}>${s}</option>`).join('')}
              </select>
            </div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">Owner Occupancy</label>
              <select name="occupancy" style="width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit;background:#fff">
                <option value="">Any</option>
                <option value="owner_occupied" ${occupancy==='owner_occupied'?'selected':''}>Owner Occupied</option>
                <option value="absent_owner"   ${occupancy==='absent_owner'?'selected':''}>Absent Owner</option>
                <option value="unknown"        ${occupancy==='unknown'?'selected':''}>Unknown</option>
              </select>
            </div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">Pipeline Stage</label>
              <select name="pipeline" style="width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit;background:#fff">
                <option value="">Any</option>
                ${['prospect','lead','contract','closed'].map(s=>`<option value="${s}" ${pipeline===s?'selected':''}>${s.charAt(0).toUpperCase()+s.slice(1)}</option>`).join('')}
              </select>
            </div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">Year Built</label>
              <div style="display:flex;gap:6px;align-items:center">
                <input type="number" name="min_year" value="${min_year}" placeholder="From" style="width:100%;padding:7px 8px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit">
                <span style="color:#aaa;font-size:12px">–</span>
                <input type="number" name="max_year" value="${max_year}" placeholder="To" style="width:100%;padding:7px 8px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit">
              </div>
            </div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">Assessed Value ($)</label>
              <div style="display:flex;gap:6px;align-items:center">
                <input type="number" name="min_assessed" value="${min_assessed}" placeholder="Min" style="width:100%;padding:7px 8px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit">
                <span style="color:#aaa;font-size:12px">–</span>
                <input type="number" name="max_assessed" value="${max_assessed}" placeholder="Max" style="width:100%;padding:7px 8px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit">
              </div>
            </div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">Equity (%)</label>
              <div style="display:flex;gap:6px;align-items:center">
                <input type="number" name="min_equity" value="${min_equity}" placeholder="Min" style="width:100%;padding:7px 8px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit">
                <span style="color:#aaa;font-size:12px">–</span>
                <input type="number" name="max_equity" value="${max_equity}" placeholder="Max" style="width:100%;padding:7px 8px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit">
              </div>
            </div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">Phones</label>
              <select name="phones" style="width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit;background:#fff">
                <option value="">Any</option>
                <option value="has"  ${phones==='has' ?'selected':''}>Has phones</option>
                <option value="none" ${phones==='none'?'selected':''}>No phones</option>
              </select>
            </div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">Properties Owned</label>
              <div style="display:flex;gap:6px;align-items:center">
                <input type="number" name="min_owned" value="${min_owned}" placeholder="Min" min="1" style="width:100%;padding:7px 8px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit">
                <span style="color:#aaa;font-size:12px">–</span>
                <input type="number" name="max_owned" value="${max_owned}" placeholder="Max" min="1" style="width:100%;padding:7px 8px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit">
              </div>
              <div style="font-size:10px;color:#aaa;margin-top:2px">By mailing address</div>
            </div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">Tag</label>
              <select name="tag" style="width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit;background:#fff">
                <option value="">Any</option>
                ${allTags.map(t => `<option value="${t.id}" ${tag == t.id ? 'selected' : ''}>${escHTML(t.name)}</option>`).join('')}
              </select>
            </div>

            <!-- Marketing -->
            <div style="grid-column:1/-1;font-size:10px;font-weight:700;color:#aaa;text-transform:uppercase;letter-spacing:.1em;margin:6px 0 2px">Marketing</div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">Marketing Result — Include</label>
              <div style="position:relative">
                <button type="button" id="mkt-inc-btn" onclick="toggleMkt('inc')" style="width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit;background:#fff;text-align:left;cursor:pointer">
                  <span id="mkt-inc-summary">${mktIncludeList.length > 0 ? esc(mktIncludeList.join(', ')) : 'Any'}</span>
                  <span style="float:right;color:#aaa">▾</span>
                </button>
                <div id="mkt-inc-pop" style="display:none;position:absolute;top:100%;left:0;right:0;margin-top:4px;background:#fff;border:1px solid #ddd;border-radius:7px;box-shadow:0 4px 12px rgba(0,0,0,.08);z-index:10;max-height:240px;overflow-y:auto;padding:6px 0">
                  ${['Lead','Potential Lead','Sold','Listed','Not Interested','Do Not Call','Spanish Speaker'].map(s => `
                    <label style="display:flex;align-items:center;gap:8px;padding:6px 12px;cursor:pointer;font-size:13px" onmouseover="this.style.background='#f5f4f0'" onmouseout="this.style.background='transparent'">
                      <input type="checkbox" name="mkt_include" value="${s}" ${mktIncludeList.includes(s) ? 'checked' : ''} onchange="updateMktSummary('inc')">
                      <span>${s}</span>
                    </label>`).join('')}
                </div>
              </div>
              <p style="font-size:10px;color:#aaa;margin-top:3px">Match any selected (OR)</p>
            </div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">Marketing Result — Exclude</label>
              <div style="position:relative">
                <button type="button" id="mkt-exc-btn" onclick="toggleMkt('exc')" style="width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit;background:#fff;text-align:left;cursor:pointer">
                  <span id="mkt-exc-summary">${mktExcludeList.length > 0 ? esc(mktExcludeList.join(', ')) : 'None'}</span>
                  <span style="float:right;color:#aaa">▾</span>
                </button>
                <div id="mkt-exc-pop" style="display:none;position:absolute;top:100%;left:0;right:0;margin-top:4px;background:#fff;border:1px solid #ddd;border-radius:7px;box-shadow:0 4px 12px rgba(0,0,0,.08);z-index:10;max-height:240px;overflow-y:auto;padding:6px 0">
                  ${['Lead','Potential Lead','Sold','Listed','Not Interested','Do Not Call','Spanish Speaker'].map(s => `
                    <label style="display:flex;align-items:center;gap:8px;padding:6px 12px;cursor:pointer;font-size:13px" onmouseover="this.style.background='#f5f4f0'" onmouseout="this.style.background='transparent'">
                      <input type="checkbox" name="mkt_exclude" value="${s}" ${mktExcludeList.includes(s) ? 'checked' : ''} onchange="updateMktSummary('exc')">
                      <span>${s}</span>
                    </label>`).join('')}
                </div>
              </div>
              <p style="font-size:10px;color:#aaa;margin-top:3px">Hide these results from list</p>
            </div>
            ${(() => {
              const overlap = mktIncludeList.filter(v => mktExcludeList.includes(v));
              return overlap.length > 0 ? `
                <div style="grid-column:1/-1;background:#fff8e1;border:1px solid #f5d06b;border-radius:7px;padding:8px 12px;font-size:12px;color:#7a5a00">
                  ⚠️ <strong>${esc(overlap.join(', '))}</strong> is in both Include and Exclude — this will return 0 results. Remove from one side.
                </div>` : '';
            })()}
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">Upload Date From</label>
              <input type="date" name="upload_from" value="${upload_from}" style="width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit">
            </div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">Upload Date To</label>
              <input type="date" name="upload_to" value="${upload_to}" style="width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit">
            </div>

            <!-- List Stacking -->
            <div style="grid-column:1/-1;font-size:10px;font-weight:700;color:#aaa;text-transform:uppercase;letter-spacing:.1em;margin:6px 0 2px">List Stacking</div>
            <div style="grid-column:1/-1">
              <label style="font-size:11px;color:#888;display:block;margin-bottom:6px">Stacks on ALL of these lists <span id="stack-count-label" style="color:#1a1a1a;font-weight:600">(${stackList.length} selected)</span></label>

              <!-- Multi-select dropdown: pills above, dropdown opens on click -->
              <div id="ms-wrapper" style="position:relative">
                <div id="ms-control" onclick="toggleMsDropdown(event)" style="min-height:38px;border:1px solid #ddd;border-radius:7px;padding:5px 30px 5px 8px;background:#fff;cursor:text;display:flex;flex-wrap:wrap;gap:4px;align-items:center">
                  <div id="ms-pills" style="display:flex;flex-wrap:wrap;gap:4px">
                    ${stackList.length === 0 ? '<span id="ms-placeholder" style="color:#aaa;font-size:13px;padding:4px 2px">Select lists…</span>' : ''}
                    ${allLists.filter(l => stackList.includes(String(l.id))).map(l => `
                      <span class="ms-pill" data-id="${l.id}" style="display:inline-flex;align-items:center;gap:5px;background:#e8f0ff;color:#1a4a9a;padding:3px 8px;border-radius:5px;font-size:12px;font-weight:500">
                        ${l.list_name}
                        <button type="button" onclick="removeMsPill(event, ${l.id})" style="background:none;border:none;color:#1a4a9a;cursor:pointer;padding:0;font-size:14px;line-height:1;font-family:inherit">×</button>
                      </span>
                    `).join('')}
                  </div>
                  <span style="position:absolute;right:10px;top:50%;transform:translateY(-50%);color:#888;font-size:11px;pointer-events:none">▾</span>
                </div>
                <div id="ms-dropdown" style="display:none;position:absolute;top:calc(100% + 4px);left:0;right:0;background:#fff;border:1px solid #ddd;border-radius:7px;box-shadow:0 4px 16px rgba(0,0,0,.08);max-height:240px;overflow:hidden;z-index:100;flex-direction:column">
                  <input type="text" id="ms-search" placeholder="Search lists…" oninput="filterMsOptions()" onclick="event.stopPropagation()" style="width:100%;padding:8px 10px;border:none;border-bottom:1px solid #eee;font-size:13px;font-family:inherit;outline:none;box-sizing:border-box">
                  <div id="ms-options" style="overflow-y:auto;flex:1">
                    ${allLists.length === 0
                      ? '<div style="color:#aaa;font-size:13px;padding:10px">No lists available yet</div>'
                      : allLists.map(l => {
                          const isSel = stackList.includes(String(l.id));
                          return `<div class="ms-option" data-id="${l.id}" data-name="${l.list_name.toLowerCase()}" onclick="toggleMsOption(event, ${l.id}, '${l.list_name.replace(/'/g, "\\'")}')" style="padding:8px 12px;font-size:13px;cursor:pointer;display:flex;align-items:center;gap:8px;${isSel ? 'background:#f0f7ff;color:#1a4a9a;font-weight:500' : ''}" onmouseover="if(!this.classList.contains('ms-selected'))this.style.background='#fafaf8'" onmouseout="if(!this.classList.contains('ms-selected'))this.style.background=''">
                            <span style="width:14px;display:inline-block">${isSel ? '✓' : ''}</span>
                            <span>${l.list_name}</span>
                          </div>`;
                        }).join('')}
                  </div>
                </div>
              </div>

              <!-- Hidden inputs that actually submit with the form -->
              <div id="ms-hidden-inputs">
                ${stackList.map(id => `<input type="hidden" name="stack_list" value="${id}">`).join('')}
              </div>

              <p style="font-size:11px;color:#aaa;margin-top:5px">Select 2+ lists to find properties on every one (AND logic). Select 1 for "on this list."</p>
            </div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">Min list stack count</label>
              <input type="number" name="min_stack" value="${min_stack}" placeholder="e.g. 2" min="1" style="width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit">
            </div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">Min Distress Score</label>
              <input type="number" name="min_distress" value="${min_distress}" placeholder="e.g. 55" min="0" max="100" style="width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit">
              <p style="font-size:10px;color:#aaa;margin-top:3px">30+ Warm · 55+ Hot · 75+ Burning</p>
            </div>

          </div>

          <div style="margin-top:14px;display:flex;gap:8px">
            <button type="submit" class="btn btn-primary">Apply Filters</button>
            <a href="/records${list_id?'?list_id='+list_id:''}" class="btn btn-ghost">Reset</a>
          </div>
        </div>
      </form>

      <style>
      tr.row-selected td { background: #f0f7ff !important; }
      tr.row-selected:hover td { background: #e8f0ff !important; }
      </style>

      <!-- Export Modal -->
      <div class="modal-overlay" id="export-modal">
        <div class="modal" style="max-width:520px">
          <div class="modal-header">
            <div class="modal-title">Choose Export Columns</div>
            <button class="modal-close" onclick="document.getElementById('export-modal').classList.remove('open')">×</button>
          </div>
          <div style="margin-bottom:12px;display:flex;gap:8px">
            <button onclick="checkAll(true)" style="padding:5px 12px;font-size:12px;background:#f5f4f0;border:1px solid #ddd;border-radius:6px;cursor:pointer;font-family:inherit">Select All</button>
            <button onclick="checkAll(false)" style="padding:5px 12px;font-size:12px;background:#f5f4f0;border:1px solid #ddd;border-radius:6px;cursor:pointer;font-family:inherit">Clear All</button>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:1.25rem" id="col-checks">
            ${[
              ['street','Street Address'],['city','City'],['state_code','State'],['zip_code','ZIP'],['county','County'],
              ['first_name','Owner First Name'],['last_name','Owner Last Name'],
              ['mailing_address','Mailing Address'],['mailing_city','Mailing City'],['mailing_state','Mailing State'],['mailing_zip','Mailing ZIP'],['email_1','Email 1'],['email_2','Email 2'],
              ['phones','Phones (1–15 separate columns)'],
              ['property_type','Property Type'],['year_built','Year Built'],['sqft','Sq Ft'],['bedrooms','Bedrooms'],['bathrooms','Bathrooms'],
              ['assessed_value','Assessed Value'],['estimated_value','Est. Value'],['equity_percent','Equity %'],
              ['property_status','Property Status'],['owner_occupancy','Owner Occupancy'],['pipeline_stage','Pipeline Stage'],['condition','Condition'],
              ['last_sale_date','Last Sale Date'],['last_sale_price','Last Sale Price'],
              ['marketing_result','Marketing Result'],['source','Source'],
              ['list_count','Lists Count'],['created_at','Date Added'],
              ['distress_score','Distress Score'],['distress_band','Distress Band'],
            ].map(([k,l]) => `<label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;padding:4px 0">
              <input type="checkbox" value="${k}" class="col-check" checked style="width:14px;height:14px"> ${l}
            </label>`).join('')}
          </div>
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;padding:10px 12px;margin-bottom:1rem;background:#f5f4f0;border-radius:8px">
            <input type="checkbox" id="clean-phones-only" checked style="width:14px;height:14px">
            <span>Exclude wrong/dead phone numbers</span>
            <span style="font-size:11px;color:#888;margin-left:auto">Recommended for dialer exports</span>
          </label>
          <button onclick="doExport()" style="width:100%;padding:10px;background:#1a1a1a;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer;font-family:inherit">Download CSV</button>
        </div>
      </div>

      <!-- Delete modal -->
      <div class="modal-overlay" id="delete-modal">
        <div class="modal" style="max-width:480px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
            <h3 style="font-size:17px;font-weight:600;margin:0;color:#c0392b">🗑 Delete Records</h3>
            <button onclick="document.getElementById('delete-modal').classList.remove('open')" style="background:none;border:none;font-size:22px;cursor:pointer;color:#888;line-height:1">×</button>
          </div>
          <div id="delete-modal-msg" style="font-size:14px;margin-bottom:16px;color:#333;line-height:1.5"></div>
          <div id="delete-modal-err" style="display:none;background:#fdeaea;border:1px solid #f5c5c5;border-radius:6px;padding:8px 12px;color:#8b1f1f;font-size:13px;margin-bottom:12px"></div>
          <div style="margin-bottom:14px">
            <label style="font-size:12px;color:#888;display:block;margin-bottom:4px">Delete Code</label>
            <input type="password" id="delete-code-input" autocomplete="off" placeholder="Enter delete code" style="width:100%;padding:9px 12px;border:1px solid #ddd;border-radius:8px;font-size:14px;font-family:inherit" onkeydown="if(event.key==='Enter'){event.preventDefault();confirmDelete();}">
          </div>
          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button onclick="document.getElementById('delete-modal').classList.remove('open')" style="padding:9px 16px;background:#fff;color:#666;border:1px solid #ddd;border-radius:8px;font-size:13px;cursor:pointer;font-family:inherit">Cancel</button>
            <button onclick="confirmDelete()" id="delete-confirm-btn" style="padding:9px 16px;background:#c0392b;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">Delete Records</button>
          </div>
          <div style="font-size:11px;color:#888;margin-top:12px;line-height:1.4">
            Forgot the code? <a href="/settings/security" style="color:#666">Update it in Security Settings</a>.
          </div>
        </div>
      </div>

      <!-- Remove from List modal -->
      <div class="modal-overlay" id="rfl-modal">
        <div class="modal" style="max-width:480px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
            <h3 style="font-size:17px;font-weight:600;margin:0;color:#1a1a1a">📋 Remove from List</h3>
            <button onclick="document.getElementById('rfl-modal').classList.remove('open')" style="background:none;border:none;font-size:22px;cursor:pointer;color:#888;line-height:1">×</button>
          </div>
          <div id="rfl-modal-msg" style="font-size:14px;margin-bottom:16px;color:#333;line-height:1.5"></div>
          <div id="rfl-modal-err" style="display:none;background:#fdeaea;border:1px solid #f5c5c5;border-radius:6px;padding:8px 12px;color:#8b1f1f;font-size:13px;margin-bottom:12px"></div>
          <div style="margin-bottom:14px">
            <label style="font-size:12px;color:#888;display:block;margin-bottom:4px">Delete Code</label>
            <input type="password" id="rfl-code-input" autocomplete="off" placeholder="Enter delete code" style="width:100%;padding:9px 12px;border:1px solid #ddd;border-radius:8px;font-size:14px;font-family:inherit" onkeydown="if(event.key==='Enter'){event.preventDefault();confirmRemoveFromList();}">
          </div>
          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button onclick="document.getElementById('rfl-modal').classList.remove('open')" style="padding:9px 16px;background:#fff;color:#666;border:1px solid #ddd;border-radius:8px;font-size:13px;cursor:pointer;font-family:inherit">Cancel</button>
            <button onclick="confirmRemoveFromList()" id="rfl-confirm-btn" style="padding:9px 16px;background:#1a1a1a;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">Remove from List</button>
          </div>
          <div style="font-size:11px;color:#888;margin-top:12px;line-height:1.4">
            This detaches the selected properties from this list but keeps the property records themselves.
          </div>
        </div>
      </div>

      <!-- Bulk Tag modal -->
      <div class="modal-overlay" id="bulk-tag-modal">
        <div class="modal" style="max-width:480px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
            <h3 style="font-size:17px;font-weight:600;margin:0;color:#1a1a1a" id="bulk-tag-title">Add Tags</h3>
            <button onclick="document.getElementById('bulk-tag-modal').classList.remove('open')" style="background:none;border:none;font-size:22px;cursor:pointer;color:#888;line-height:1">×</button>
          </div>
          <div id="bulk-tag-msg" style="font-size:14px;margin-bottom:12px;color:#333;line-height:1.5"></div>
          <div id="bulk-tag-err" style="display:none;background:#fdeaea;border:1px solid #f5c5c5;border-radius:6px;padding:8px 12px;color:#8b1f1f;font-size:13px;margin-bottom:12px"></div>

          <!-- Add mode: free-text input with suggestions -->
          <div id="bulk-tag-add-section">
            <div style="position:relative;margin-bottom:10px">
              <input type="text" id="bulk-tag-input" placeholder="Type a tag name…" autocomplete="off"
                style="width:100%;padding:9px 12px;border:1px solid #ddd;border-radius:8px;font-size:14px;font-family:inherit"
                oninput="bulkTagSuggest(this.value)"
                onkeydown="if(event.key==='Enter'){event.preventDefault();bulkTagAdd();}"
              >
              <div id="bulk-tag-suggestions" style="display:none;position:absolute;top:100%;left:0;right:0;margin-top:4px;background:#fff;border:1px solid #ddd;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.08);max-height:160px;overflow-y:auto;z-index:50"></div>
            </div>
            <div id="bulk-tag-selected" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px;min-height:28px"></div>
          </div>

          <!-- Remove mode: checkboxes of existing tags -->
          <div id="bulk-tag-remove-section" style="display:none;margin-bottom:14px;max-height:240px;overflow-y:auto">
            ${allTags.map(t => `
              <label style="display:flex;align-items:center;gap:8px;padding:6px 0;font-size:13px;cursor:pointer;border-bottom:1px solid #f0efe9">
                <input type="checkbox" class="bulk-tag-rm-check" value="${t.id}" style="width:14px;height:14px">
                <span style="width:10px;height:10px;border-radius:50%;background:${escHTML(t.color)}"></span>
                ${escHTML(t.name)}
              </label>
            `).join('')}
            ${allTags.length === 0 ? '<div style="color:#aaa;font-size:13px;padding:12px 0;text-align:center">No tags exist yet</div>' : ''}
          </div>

          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button onclick="document.getElementById('bulk-tag-modal').classList.remove('open')" style="padding:9px 16px;background:#fff;color:#666;border:1px solid #ddd;border-radius:8px;font-size:13px;cursor:pointer;font-family:inherit">Cancel</button>
            <button onclick="confirmBulkTag()" id="bulk-tag-confirm-btn" style="padding:9px 16px;background:#1a1a1a;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">Apply</button>
          </div>
        </div>
      </div>

      <!-- Export toolbar -->
      <div id="export-toolbar" data-list-id="${list_id || ''}" style="display:none;background:#1a1a1a;color:#fff;border-radius:10px;padding:10px 16px;margin-bottom:8px;align-items:center;justify-content:space-between;gap:12px">
        <div style="font-size:13px"><span id="selected-count">0</span> records selected</div>
        <div style="display:flex;gap:8px;position:relative">
          <button onclick="clearSelection()" style="padding:6px 12px;background:transparent;color:#aaa;border:1px solid #444;border-radius:7px;font-size:12px;cursor:pointer;font-family:inherit">Clear</button>
          <button onclick="toggleManageMenu(event)" id="manage-btn" style="padding:6px 14px;background:#fff;color:#1a1a1a;border:none;border-radius:7px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;display:flex;align-items:center;gap:4px">Manage <span style="font-size:9px;opacity:.6">▾</span></button>

          <!-- Manage dropdown menu -->
          <div id="manage-menu" style="display:none;position:absolute;top:100%;right:0;margin-top:6px;background:#fff;border:1px solid #e0dfd8;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,0.12);padding:6px;min-width:220px;z-index:100">
            <button onclick="openExportModalFromMenu()" style="display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:9px 12px;background:none;border:none;border-radius:7px;font-size:13px;font-family:inherit;color:#1a1a1a;cursor:pointer" onmouseover="this.style.background='#f5f4f0'" onmouseout="this.style.background='none'">
              <span style="font-size:14px">⬇</span><span>Export CSV</span>
            </button>
            <div style="height:1px;background:#eee;margin:4px 6px"></div>
            <button onclick="openBulkTagModal('add')" style="display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:9px 12px;background:none;border:none;border-radius:7px;font-size:13px;font-family:inherit;color:#1a1a1a;cursor:pointer" onmouseover="this.style.background='#f5f4f0'" onmouseout="this.style.background='none'">
              <span style="font-size:14px">🏷️</span><span>Add tags</span>
            </button>
            <button onclick="openBulkTagModal('remove')" style="display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:9px 12px;background:none;border:none;border-radius:7px;font-size:13px;font-family:inherit;color:#1a1a1a;cursor:pointer" onmouseover="this.style.background='#f5f4f0'" onmouseout="this.style.background='none'">
              <span style="font-size:14px">🏷️</span><span>Remove tags</span>
            </button>
            <div style="height:1px;background:#eee;margin:4px 6px"></div>
            <button onclick="openRemoveFromListModal()" style="display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:9px 12px;background:none;border:none;border-radius:7px;font-size:13px;font-family:inherit;color:#1a1a1a;cursor:pointer" onmouseover="this.style.background='#f5f4f0'" onmouseout="this.style.background='none'">
              <span style="font-size:14px">📋</span><span>Remove from list</span>
            </button>
            <button onclick="openDeleteModal()" style="display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:9px 12px;background:none;border:none;border-radius:7px;font-size:13px;font-family:inherit;color:#c0392b;cursor:pointer" onmouseover="this.style.background='#fdeaea'" onmouseout="this.style.background='none'">
              <span style="font-size:14px">🗑</span><span>Delete records</span>
            </button>
            <div style="height:1px;background:#eee;margin:4px 6px"></div>
            <div style="padding:4px 12px;font-size:10px;color:#aaa;text-transform:uppercase;letter-spacing:.08em">Coming soon</div>
            <div style="display:flex;align-items:center;gap:10px;width:100%;padding:9px 12px;font-size:13px;color:#bbb;cursor:not-allowed" title="Coming soon">
              <span style="font-size:14px">➕</span><span>Add to list</span>
            </div>
            <div style="display:flex;align-items:center;gap:10px;width:100%;padding:9px 12px;font-size:13px;color:#bbb;cursor:not-allowed" title="Coming soon">
              <span style="font-size:14px">🎯</span><span>Change pipeline stage</span>
            </div>
            <div style="display:flex;align-items:center;gap:10px;width:100%;padding:9px 12px;font-size:13px;color:#bbb;cursor:not-allowed" title="Coming soon">
              <span style="font-size:14px">🏷️</span><span>Change property status</span>
            </div>
          </div>
        </div>
      </div>

      <div id="select-all-banner" data-total="${total}" style="display:none;background:#e8f0ff;border:1px solid #c5d5f5;border-radius:8px;padding:10px 16px;margin-bottom:8px;font-size:13px;color:#1a4a9a;align-items:center;justify-content:space-between;gap:12px">
        <span>All <strong>${total.toLocaleString()}</strong> records on this page selected. Select all records?</span>
        <button onclick="selectAllRecords()" style="padding:5px 14px;background:#1a4a9a;color:#fff;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">Select all ${total.toLocaleString()} records</button>
      </div>

      <div style="background:#fff;border-radius:10px;border:1px solid #e0dfd8;overflow:hidden">
        <table style="width:100%;font-size:13px;border-collapse:collapse">
          <thead><tr style="border-bottom:1px solid #e0dfd8">
            <th style="width:40px;padding:10px 0 10px 16px;text-align:left"><input type="checkbox" id="select-all" onchange="selectAllOnPage(this.checked)" style="cursor:pointer;width:15px;height:15px" title="Select all on this page"></th>
            <th style="padding:10px 12px;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.05em;text-align:left">Address</th>
            <th style="padding:10px 12px;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.05em;text-align:left">Owner</th>
            <th style="padding:10px 12px;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.05em;text-align:left">Type</th>
            <th style="padding:10px 12px;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.05em;text-align:center">Phones</th>
            <th style="padding:10px 12px;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.05em;text-align:center">Lists</th>
            <th style="padding:10px 12px;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.05em;text-align:center">Distress</th>
            <th style="padding:10px 12px;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.05em;text-align:left">Stage</th>
            <th style="padding:10px 12px;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.05em;text-align:right">Added</th>
          </tr></thead>
          <tbody>
            ${tableRows || '<tr><td colspan="9" style="text-align:center;padding:40px;color:#aaa;font-size:13px">No records found</td></tr>'}
          </tbody>
        </table>
      </div>
      ${pagination}
      <script src="/js/records-list.js?v=2"></script>

    `, 'records'));
  } catch (e) {
    console.error(e);
    res.status(500).send('Server error: ' + e.message);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// TAGS — API routes for property tagging
// ═══════════════════════════════════════════════════════════════════════════════

// Auto-suggest: returns existing tags matching a partial query
router.get('/tags/suggest', requireAuth, async (req, res) => {
  try {
    await ensureTagSchema();
    const q = String(req.query.q || '').trim();
    if (!q) {
      // Return all tags (for dropdown initialization)
      const r = await query(`SELECT id, name, color FROM tags ORDER BY name ASC LIMIT 50`);
      return res.json(r.rows);
    }
    const r = await query(
      `SELECT id, name, color FROM tags WHERE name ILIKE $1 ORDER BY name ASC LIMIT 20`,
      [`%${q}%`]
    );
    res.json(r.rows);
  } catch (e) {
    console.error('[tags/suggest]', e);
    res.status(500).json({ error: e.message });
  }
});

// Add tag to a property — creates the tag if it doesn't exist
router.post('/:id(\\d+)/tags', requireAuth, async (req, res) => {
  try {
    await ensureTagSchema();
    const propertyId = parseInt(req.params.id);
    const tagName = String(req.body.name || '').trim();
    if (!tagName || tagName.length > 100) {
      return res.status(400).json({ error: 'Tag name required (max 100 chars).' });
    }
    // Find existing tag by case-insensitive name, or create a new one.
    // The try/catch handles the rare race condition where two concurrent
    // requests both pass the SELECT, and the second INSERT hits the unique index.
    let tagRes = await query(
      `SELECT id, name, color FROM tags WHERE LOWER(name) = LOWER($1) LIMIT 1`,
      [tagName]
    );
    if (!tagRes.rows.length) {
      try {
        tagRes = await query(
          `INSERT INTO tags (name) VALUES ($1) RETURNING id, name, color`,
          [tagName]
        );
      } catch (dupErr) {
        // Unique violation — another request created it between our SELECT and INSERT
        tagRes = await query(
          `SELECT id, name, color FROM tags WHERE LOWER(name) = LOWER($1) LIMIT 1`,
          [tagName]
        );
      }
    }
    const tag = tagRes.rows[0];
    // Link tag to property (ignore if already linked)
    await query(
      `INSERT INTO property_tags (property_id, tag_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [propertyId, tag.id]
    );
    console.log(`[tags] Added "${tag.name}" to property #${propertyId}`);
    res.json({ ok: true, tag });
  } catch (e) {
    console.error('[tags/add]', e);
    res.status(500).json({ error: e.message });
  }
});

// Remove tag from a property
router.delete('/:id(\\d+)/tags/:tagId(\\d+)', requireAuth, async (req, res) => {
  try {
    await ensureTagSchema();
    const propertyId = parseInt(req.params.id);
    const tagId = parseInt(req.params.tagId);
    const r = await query(
      `DELETE FROM property_tags WHERE property_id = $1 AND tag_id = $2 RETURNING tag_id`,
      [propertyId, tagId]
    );
    if (!r.rowCount) {
      return res.status(404).json({ error: 'Tag not found on this property.' });
    }
    console.log(`[tags] Removed tag #${tagId} from property #${propertyId}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[tags/remove]', e);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORT — POST /records/export
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/export', requireAuth, async (req, res) => {
  try {
    await distress.ensureDistressSchema();
    const { ids, columns, selectAll, filterParams, cleanPhonesOnly } = req.body;
    if (!columns || !columns.length) return res.status(400).json({ error: 'No columns selected' });
    // Default ON if not provided — matches the checkbox default
    const excludeBadPhones = cleanPhonesOnly !== false;

    // 2026-04-20 pass 12: hard cap on export size. Pre-pass-12 the selectAll
    // branch ran with no LIMIT and could pull the entire 77k+ property table
    // into memory as JSON. The ids branch had no bound either — sending more
    // than Postgres's 65,535 parameter limit crashed the query with an
    // unhelpful error. Cap both paths at 100k rows; if users need more,
    // they should use the Bulk Import flow or do the export in chunks.
    const EXPORT_MAX_ROWS = 100000;

    let props;
    if (selectAll) {
      const qs = new URLSearchParams(filterParams || '');
      let conditions = [], params = [], idx = 1;
      const qv = (k) => qs.get(k) || '';
      const qvAll = (k) => qs.getAll(k).filter(v => v && String(v).trim() !== '');
      if (qv('q'))           { conditions.push(`(p.street ILIKE $${idx} OR p.city ILIKE $${idx} OR c.first_name ILIKE $${idx} OR c.last_name ILIKE $${idx})`); params.push(`%${qv('q')}%`); idx++; }
      const stateArr = qvAll('state').map(s => String(s).toUpperCase());
      if (stateArr.length > 0) {
        conditions.push(`p.state_code = ANY($${idx}::text[])`);
        params.push(stateArr);
        idx++;
      }
      // Same comma-split logic as the list view (consistency)
      const splitCsv = (raw) => !raw ? [] : String(raw).split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
      const cityArr   = splitCsv(qv('city'));
      const zipArr    = splitCsv(qv('zip'));
      const countyArr = splitCsv(qv('county'));
      if (cityArr.length > 0) {
        const o = cityArr.map(() => `p.city ILIKE $${idx++}`);
        conditions.push(`(${o.join(' OR ')})`);
        cityArr.forEach(c => params.push(`%${c}%`));
      }
      if (zipArr.length > 0) {
        const o = zipArr.map(() => `p.zip_code ILIKE $${idx++}`);
        conditions.push(`(${o.join(' OR ')})`);
        zipArr.forEach(z => params.push(`${z}%`));
      }
      if (countyArr.length > 0) {
        const o = countyArr.map(() => `p.county ILIKE $${idx++}`);
        conditions.push(`(${o.join(' OR ')})`);
        countyArr.forEach(c => params.push(`%${c}%`));
      }
      if (qv('type'))        { conditions.push(`p.property_type = $${idx}`);     params.push(qv('type')); idx++; }
      if (qv('pipeline'))    { conditions.push(`p.pipeline_stage = $${idx}`);    params.push(qv('pipeline')); idx++; }
      if (qv('prop_status')) { conditions.push(`p.property_status = $${idx}`);   params.push(qv('prop_status')); idx++; }
      // Owner Occupancy — same NORM_ADDR helper logic as the list view
      const NORM_ADDR_X = (col) => `
        REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(
        REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(
          LOWER(REGEXP_REPLACE(TRIM(${col}), '[.,]+', '', 'g')),
          '\\ystreet\\y',  'st',   'g'),
          '\\yavenue\\y',  'ave',  'g'),
          '\\ydrive\\y',   'dr',   'g'),
          '\\yboulevard\\y','blvd', 'g'),
          '\\yroad\\y',    'rd',   'g'),
          '\\ylane\\y',    'ln',   'g'),
          '\\ycourt\\y',   'ct',   'g'),
          '\\yplace\\y',   'pl',   'g'),
          '\\ycircle\\y',  'cir',  'g'),
          '\\yterrace\\y', 'ter',  'g'),
          '\\yparkway\\y', 'pkwy', 'g'),
          '\\yhighway\\y', 'hwy',  'g'),
          '\\s+', ' ', 'g')`;
      const occX = qv('occupancy');
      if (occX === 'owner_occupied') {
        conditions.push(`(c.mailing_address IS NOT NULL
          AND ${NORM_ADDR_X('p.street')} = ${NORM_ADDR_X('c.mailing_address')}
          AND LOWER(TRIM(p.city)) = LOWER(TRIM(c.mailing_city))
          AND UPPER(TRIM(p.state_code)) = UPPER(TRIM(c.mailing_state))
          AND SUBSTRING(TRIM(p.zip_code) FROM 1 FOR 5) = SUBSTRING(TRIM(c.mailing_zip) FROM 1 FOR 5))`);
      } else if (occX === 'absent_owner') {
        conditions.push(`(c.mailing_address IS NOT NULL AND TRIM(c.mailing_address) != ''
          AND NOT (
            ${NORM_ADDR_X('p.street')} = ${NORM_ADDR_X('c.mailing_address')}
            AND LOWER(TRIM(p.city)) = LOWER(TRIM(c.mailing_city))
            AND UPPER(TRIM(p.state_code)) = UPPER(TRIM(c.mailing_state))
            AND SUBSTRING(TRIM(p.zip_code) FROM 1 FOR 5) = SUBSTRING(TRIM(c.mailing_zip) FROM 1 FOR 5)
          ))`);
      } else if (occX === 'unknown') {
        conditions.push(`(c.mailing_address IS NULL OR TRIM(c.mailing_address) = '')`);
      }
      // Marketing Result — per-campaign (decision #1)
      const mktMatchExp_export = (paramIdx) => `(
        EXISTS (
          SELECT 1 FROM campaign_contacts cc_mkt
          WHERE cc_mkt.property_address_normalized = p.street_normalized
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
      if (qv('mkt_result'))  { conditions.push(mktMatchExp_export(idx)); params.push([qv('mkt_result')]); idx++; }
      const mktIncArr = qvAll('mkt_include');
      const mktExcArr = qvAll('mkt_exclude');
      if (mktIncArr.length > 0) {
        conditions.push(mktMatchExp_export(idx));
        params.push(mktIncArr); idx++;
      }
      if (mktExcArr.length > 0) {
        conditions.push(`NOT ${mktMatchExp_export(idx)}`);
        params.push(mktExcArr); idx++;
      }
      if (qv('min_assessed')){ conditions.push(`p.assessed_value >= $${idx}`);   params.push(qv('min_assessed')); idx++; }
      if (qv('max_assessed')){ conditions.push(`p.assessed_value <= $${idx}`);   params.push(qv('max_assessed')); idx++; }
      if (qv('min_equity'))  { conditions.push(`p.equity_percent >= $${idx}`);   params.push(qv('min_equity')); idx++; }
      if (qv('max_equity'))  { conditions.push(`p.equity_percent <= $${idx}`);   params.push(qv('max_equity')); idx++; }
      if (qv('min_year'))    { conditions.push(`p.year_built >= $${idx}`);       params.push(qv('min_year')); idx++; }
      if (qv('max_year'))    { conditions.push(`p.year_built <= $${idx}`);       params.push(qv('max_year')); idx++; }
      if (qv('upload_from')) { conditions.push(`p.created_at >= $${idx}`);       params.push(qv('upload_from')); idx++; }
      if (qv('upload_to'))   { conditions.push(`p.created_at <= $${idx}`);       params.push(qv('upload_to') + ' 23:59:59'); idx++; }
      if (qv('list_id'))     { conditions.push(`EXISTS (SELECT 1 FROM property_lists pl2 WHERE pl2.property_id = p.id AND pl2.list_id = $${idx})`); params.push(qv('list_id')); idx++; }
      const stackArr = qvAll('stack_list').map(v => parseInt(v)).filter(n => !isNaN(n));
      if (stackArr.length > 0) {
        conditions.push(
          `(SELECT COUNT(DISTINCT pl_stack.list_id)
              FROM property_lists pl_stack
             WHERE pl_stack.property_id = p.id
               AND pl_stack.list_id = ANY($${idx}::int[])) = $${idx+1}`
        );
        params.push(stackArr);
        params.push(stackArr.length);
        idx += 2;
      }
      if (qv('min_stack'))   { conditions.push(`(SELECT COUNT(*) FROM property_lists plc WHERE plc.property_id = p.id) >= $${idx}`); params.push(parseInt(qv('min_stack'))); idx++; }
      if (qv('min_distress')){ conditions.push(`p.distress_score >= $${idx}`);   params.push(parseInt(qv('min_distress'))); idx++; }
      // Phones filter — mirror list route logic
      const phonesX = qv('phones');
      if (phonesX === 'has') {
        conditions.push(`EXISTS (SELECT 1 FROM phones ph_f JOIN property_contacts pc_f ON pc_f.contact_id = ph_f.contact_id WHERE pc_f.property_id = p.id)`);
      } else if (phonesX === 'none') {
        conditions.push(`NOT EXISTS (SELECT 1 FROM phones ph_f JOIN property_contacts pc_f ON pc_f.contact_id = ph_f.contact_id WHERE pc_f.property_id = p.id)`);
      }
      // Properties-owned filter — mirror list route logic
      const minOwnedX = qv('min_owned'), maxOwnedX = qv('max_owned');
      if (minOwnedX || maxOwnedX) {
        // 2026-04-18 audit fix #8: use materialized view (same pattern as list query)
        const ownedSubX = `
          CASE WHEN c.mailing_address IS NULL OR TRIM(c.mailing_address) = '' THEN 1
          ELSE COALESCE(
            (SELECT opc.owned_count FROM owner_portfolio_counts opc
              WHERE opc.mailing_address_normalized = c.mailing_address_normalized
                AND opc.mailing_city_normalized = LOWER(TRIM(c.mailing_city))
                AND opc.mailing_state = UPPER(TRIM(c.mailing_state))
                AND opc.zip5 = SUBSTRING(TRIM(c.mailing_zip) FROM 1 FOR 5)),
            1
          ) END`;
        if (minOwnedX) { conditions.push(`${ownedSubX} >= $${idx}`); params.push(parseInt(minOwnedX)); idx++; }
        if (maxOwnedX) { conditions.push(`${ownedSubX} <= $${idx}`); params.push(parseInt(maxOwnedX)); idx++; }
      }
      // Tag filter
      if (qv('tag')) {
        conditions.push(`EXISTS (SELECT 1 FROM property_tags pt_f WHERE pt_f.property_id = p.id AND pt_f.tag_id = $${idx})`);
        params.push(parseInt(qv('tag'))); idx++;
      }
      const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
      props = await query(`
        SELECT DISTINCT ON (p.id)
          p.id, p.street, p.city, p.state_code, p.zip_code, p.county,
          p.property_type, p.year_built, p.sqft, p.bedrooms, p.bathrooms,
          p.assessed_value, p.estimated_value, p.equity_percent,
          p.property_status, p.pipeline_stage, p.condition,
          p.last_sale_date, p.last_sale_price, p.marketing_result,
          p.distress_score, p.distress_band,
          p.source, p.created_at,
          c.first_name, c.last_name,
          c.mailing_address, c.mailing_city, c.mailing_state, c.mailing_zip,
          c.email_1, c.email_2,
          (SELECT COUNT(*) FROM property_lists pl WHERE pl.property_id = p.id) AS list_count
        FROM properties p
        LEFT JOIN property_contacts pc ON pc.property_id = p.id AND pc.primary_contact = true
        LEFT JOIN contacts c ON c.id = pc.contact_id
        ${where}
        ORDER BY p.id DESC
        LIMIT ${EXPORT_MAX_ROWS}
      `, params);
    } else {
      if (!ids || !ids.length) return res.status(400).json({ error: 'No IDs provided' });
      // Bound the ids list — anything over 100k exceeds Postgres parameter
      // limits anyway. Also filter to valid numeric IDs defensively.
      const cleanIds = ids
        .map(n => parseInt(n))
        .filter(n => !isNaN(n) && n > 0)
        .slice(0, EXPORT_MAX_ROWS);
      if (cleanIds.length === 0) return res.status(400).json({ error: 'No valid IDs' });
      // Use ANY($1::int[]) — sends a single array parameter rather than
      // expanding into 100k placeholder params that would crash PG.
      props = await query(`
        SELECT
          p.id, p.street, p.city, p.state_code, p.zip_code, p.county,
          p.property_type, p.year_built, p.sqft, p.bedrooms, p.bathrooms,
          p.assessed_value, p.estimated_value, p.equity_percent,
          p.property_status, p.pipeline_stage, p.condition,
          p.last_sale_date, p.last_sale_price, p.marketing_result,
          p.distress_score, p.distress_band,
          p.source, p.created_at,
          c.first_name, c.last_name,
          c.mailing_address, c.mailing_city, c.mailing_state, c.mailing_zip,
          c.email_1, c.email_2,
          (SELECT COUNT(*) FROM property_lists pl WHERE pl.property_id = p.id) AS list_count
        FROM properties p
        LEFT JOIN property_contacts pc ON pc.property_id = p.id AND pc.primary_contact = true
        LEFT JOIN contacts c ON c.id = pc.contact_id
        WHERE p.id = ANY($1::int[])
      `, [cleanIds]);
    }

    // Fetch phones (number + status, stored together so we can interleave in CSV)
    const allIds = props.rows.map(r => r.id);
    const phoneMap = {};
    if (columns.includes('phones') && allIds.length) {
      // LEFT JOIN against nis_numbers so we can mark phones as "dead" even if
      // the master phones.phone_status wasn't synced from the campaign flow.
      // is_nis = true for any phone that appears in the NIS registry (any count).
      const phoneRes = await query(`
        SELECT
          ph.phone_number,
          ph.phone_status,
          ph.phone_index,
          ph.wrong_number,
          pc.property_id,
          (nis.phone_number IS NOT NULL) AS is_nis
        FROM phones ph
        JOIN property_contacts pc ON pc.contact_id = ph.contact_id
        LEFT JOIN nis_numbers nis ON nis.phone_number = ph.phone_number
        WHERE pc.property_id = ANY($1::int[])
        ORDER BY ph.phone_index ASC
      `, [allIds]);
      phoneRes.rows.forEach(ph => {
        if (!phoneMap[ph.property_id]) phoneMap[ph.property_id] = [];
        phoneMap[ph.property_id].push({
          number: ph.phone_number,
          status: ph.phone_status || '',
          isNis:  !!ph.is_nis,
          isWrong: !!ph.wrong_number,
        });
      });

      // If "Exclude wrong/dead" is on, filter out bad statuses and shift remaining
      // phones up into the lower slots. This means "Phone 1" in the CSV is always
      // the first dialable number — crucial for Readymode imports to not waste
      // attempts on known-bad slots.
      //
      // Three signals that mark a phone as bad:
      //   1) phone_status (text) — can be 'wrong', 'Wrong', 'dead', 'dead_number'
      //      depending on which flow wrote the row. Normalized via toLowerCase.
      //   2) wrong_number (boolean) — set when a campaign disposition flags the
      //      number as wrong. This is the ONLY signal for wrong numbers that
      //      never made it into the phone_status text field.
      //   3) is_nis — the phone appears in the NIS registry. Catches dead numbers
      //      even when the master phones.phone_status wasn't synced.
      if (excludeBadPhones) {
        const isBadStatus = (s) => {
          const v = String(s || '').toLowerCase().trim();
          return v === 'wrong' || v === 'dead' || v === 'dead_number';
        };
        let removed = 0;
        for (const pid in phoneMap) {
          const before = phoneMap[pid].length;
          phoneMap[pid] = phoneMap[pid].filter(p =>
            !isBadStatus(p.status) && !p.isNis && !p.isWrong
          );
          removed += (before - phoneMap[pid].length);
        }
        console.log(`[export] Clean-phones mode: removed ${removed} wrong/dead/NIS phones, shifted remaining up`);
      }

      console.log(`[export] Fetched ${phoneRes.rows.length} phones across ${Object.keys(phoneMap).length}/${allIds.length} properties`);
    }

    const colLabels = {
      street: 'Street Address', city: 'City', state_code: 'State', zip_code: 'ZIP', county: 'County',
      first_name: 'Owner First Name', last_name: 'Owner Last Name',
      mailing_address: 'Mailing Address', mailing_city: 'Mailing City',
      mailing_state: 'Mailing State', mailing_zip: 'Mailing ZIP',
      email_1: 'Email 1', email_2: 'Email 2',
      phones: 'Phones',
      property_type: 'Property Type', year_built: 'Year Built', sqft: 'Sq Ft',
      bedrooms: 'Bedrooms', bathrooms: 'Bathrooms',
      assessed_value: 'Assessed Value', estimated_value: 'Est. Value', equity_percent: 'Equity %',
      property_status: 'Property Status', owner_occupancy: 'Owner Occupancy', pipeline_stage: 'Pipeline Stage', condition: 'Condition',
      last_sale_date: 'Last Sale Date', last_sale_price: 'Last Sale Price',
      marketing_result: 'Marketing Result', source: 'Source',
      list_count: 'Lists Count', created_at: 'Date Added',
      distress_score: 'Distress Score', distress_band: 'Distress Band',
    };

    // Expand the single 'phones' column into INTERLEAVED:
    // Phone 1 | Phone 1 Status | Phone 2 | Phone 2 Status | ... | Phone 15 | Phone 15 Status
    // (30 columns total — easier for callers to read in Excel)
    const PHONE_SLOTS = 15;
    const expandedColumns = [];
    for (const c of columns) {
      if (c === 'phones') {
        for (let i = 1; i <= PHONE_SLOTS; i++) {
          expandedColumns.push(`__phone_${i}`);
          expandedColumns.push(`__phonestatus_${i}`);
        }
      } else {
        expandedColumns.push(c);
      }
    }

    const headers = expandedColumns.map(k => {
      if (k.startsWith('__phonestatus_')) return 'Phone ' + k.replace('__phonestatus_', '') + ' Status';
      if (k.startsWith('__phone_'))       return 'Phone ' + k.replace('__phone_', '');
      return colLabels[k] || k;
    });

    // 2026-04-18 audit fix #26: CSV injection protection. Excel will execute
    // cell contents that begin with =, +, -, @, or certain control chars as
    // formulas. If any string in the DB (owner name, street, source, etc.)
    // starts with one of those, opening the export in Excel could leak data
    // via =HYPERLINK() or similar. Prefix any such value with a single quote
    // to force Excel to treat it as text. Standard OWASP guidance.
    const csvSafe = (val) => {
      const s = String(val);
      return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
    };

    const csvRows = props.rows.map(row => {
      const phoneList = phoneMap[row.id] || [];
      return expandedColumns.map(col => {
        let val = '';
        if (col.startsWith('__phonestatus_')) {
          const slot = parseInt(col.replace('__phonestatus_', ''), 10);
          val = phoneList[slot - 1]?.status || '';
        } else if (col.startsWith('__phone_')) {
          const slot = parseInt(col.replace('__phone_', ''), 10);
          val = phoneList[slot - 1]?.number || '';
        } else if (col === 'last_sale_date' || col === 'created_at') {
          val = row[col] ? new Date(row[col]).toLocaleDateString('en-US') : '';
        } else if (col === 'distress_band') {
          // Render as nice label ("Burning" not "burning")
          const labels = { burning: 'Burning', hot: 'Hot', warm: 'Warm', cold: 'Cold' };
          val = row[col] ? (labels[row[col]] || row[col]) : '';
        } else if (col === 'owner_occupancy') {
          // Derive at export time from property + mailing address fields already in row
          const occ = computeOwnerOccupancy(
            { street: row.street, city: row.city, state_code: row.state_code, zip_code: row.zip_code },
            { mailing_address: row.mailing_address, mailing_city: row.mailing_city, mailing_state: row.mailing_state, mailing_zip: row.mailing_zip }
          );
          val = OCCUPANCY_LABELS[occ];
        } else {
          val = row[col] !== null && row[col] !== undefined ? String(row[col]) : '';
        }
        return `"${csvSafe(val).replace(/"/g, '""')}"`;
      }).join(',');
    });

    const csv = [headers.map(h => `"${h}"`).join(','), ...csvRows].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="loki_export_${new Date().toISOString().split('T')[0]}.csv"`);
    res.send(csv);

  } catch (e) {
    console.error('Export error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PROPERTY DETAIL — GET /records/:id
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/:id(\\d+)', requireAuth, async (req, res) => {
  try {
    await distress.ensureDistressSchema();
    const { id } = req.params;
    const msg = req.query.msg || '';

    // Property
    const propRes = await query(`SELECT * FROM properties WHERE id = $1`, [id]);
    if (!propRes.rows.length) return res.status(404).send('Property not found');
    const p = propRes.rows[0];

    // Owner contact + phones
    const contactRes = await query(`
      SELECT c.*, pc.role, pc.primary_contact
      FROM contacts c
      JOIN property_contacts pc ON pc.contact_id = c.id
      WHERE pc.property_id = $1
      ORDER BY pc.primary_contact DESC
    `, [id]);

    const primaryContact = contactRes.rows[0] || null;
    let phones = [];
    if (primaryContact) {
      const phoneRes = await query(`
        SELECT * FROM phones WHERE contact_id = $1 ORDER BY phone_index ASC
      `, [primaryContact.id]);
      phones = phoneRes.rows;
    }

    // Lists
    const listsRes = await query(`
      SELECT l.list_name, l.list_type, l.source, pl.added_at
      FROM property_lists pl
      JOIN lists l ON l.id = pl.list_id
      WHERE pl.property_id = $1
      ORDER BY pl.added_at DESC
    `, [id]);

    // Tags
    await ensureTagSchema();
    const tagsRes = await query(`
      SELECT t.id, t.name, t.color
      FROM property_tags pt
      JOIN tags t ON t.id = pt.tag_id
      WHERE pt.property_id = $1
      ORDER BY t.name ASC
    `, [id]);

    // Compute distress score on detail view if not yet scored
    // (event-driven updates handle most cases; this catches any gaps)
    // Parse current breakdown to check if it's empty
    let currentBreakdown = p.distress_breakdown;
    if (typeof currentBreakdown === 'string') {
      try { currentBreakdown = JSON.parse(currentBreakdown); } catch(_) { currentBreakdown = null; }
    }
    const breakdownIsEmpty = !Array.isArray(currentBreakdown) || currentBreakdown.length === 0;

    // Lazy-score this property if:
    //   - never scored at all (distress_scored_at is null), OR
    //   - has a non-zero score but breakdown is missing (bulk Recompute All
    //     skips breakdown for performance — fill it on demand here)
    // Skip clean properties (score=0 with empty breakdown is correct, not a gap).
    const neverScored  = p.distress_scored_at == null;
    const breakdownGap = (p.distress_score || 0) > 0 && breakdownIsEmpty;
    if (neverScored || breakdownGap) {
      try {
        const scored = await distress.scoreProperty(id);
        if (scored) {
          p.distress_score = scored.score;
          p.distress_band = scored.band;
          p.distress_breakdown = scored.breakdown;
        }
      } catch(e) { console.error('[distress] detail-page score failed:', e.message); }
    }
    // Parse breakdown for render (re-parse in case scoreProperty just refreshed it)
    let distressBreakdown = p.distress_breakdown;
    if (typeof distressBreakdown === 'string') {
      try { distressBreakdown = JSON.parse(distressBreakdown); } catch(_) { distressBreakdown = []; }
    }
    if (!Array.isArray(distressBreakdown)) distressBreakdown = [];

    // Campaign history (via call_logs + sms_logs joined through phones)
    const campaignRes = await query(`
      SELECT
        cl.campaign_name,
        'call' AS channel,
        cl.disposition,
        cl.disposition_normalized,
        cl.call_date AS activity_date,
        cl.agent_name
      FROM call_logs cl
      JOIN phones ph ON ph.id = cl.phone_id
      JOIN contacts ct ON ct.id = ph.contact_id
      JOIN property_contacts pc ON pc.contact_id = ct.id
      WHERE pc.property_id = $1 AND cl.campaign_name IS NOT NULL
      UNION ALL
      SELECT
        sl.campaign_name,
        'sms' AS channel,
        sl.disposition,
        NULL AS disposition_normalized,
        sl.sent_at AS activity_date,
        NULL AS agent_name
      FROM sms_logs sl
      JOIN phones ph ON ph.id = sl.phone_id
      JOIN contacts ct ON ct.id = ph.contact_id
      JOIN property_contacts pc ON pc.contact_id = ct.id
      WHERE pc.property_id = $1 AND sl.campaign_name IS NOT NULL
      ORDER BY activity_date DESC
      LIMIT 50
    `, [id]);

    // Import history
    const importRes = await query(`
      SELECT * FROM import_history WHERE property_id = $1 ORDER BY imported_at DESC
    `, [id]);

    // ── Render phones ──
    const phoneHTML = phones.length ? phones.map(ph => {
      const statusClass = {unknown:'ps-unknown',correct:'ps-correct',wrong:'ps-wrong',dead:'ps-dead'}[ph.phone_status?.toLowerCase()] || 'ps-unknown';
      return `<div class="phone-row">
        <span class="phone-num">${ph.phone_number}</span>
        <div style="display:flex;align-items:center;gap:8px">
          ${ph.phone_tag ? `<span class="tag">${ph.phone_tag}</span>` : ''}
          <span class="phone-status ${statusClass}">${ph.phone_status || 'Unknown'}</span>
        </div>
      </div>`;
    }).join('') : '<div style="color:#aaa;font-size:13px">No phones on record</div>';

    // ── Render lists ──
    const listsHTML = listsRes.rows.length ? `
      <table class="data-table">
        <thead><tr><th>List Name</th><th>Type</th><th>Source</th><th>Date Added</th></tr></thead>
        <tbody>${listsRes.rows.map(l => `<tr>
          <td style="font-weight:500">${l.list_name}</td>
          <td>${l.list_type ? `<span class="chip chip-call">${l.list_type}</span>` : '—'}</td>
          <td style="color:#888;font-size:12px;font-family:monospace">${l.source || '—'}</td>
          <td style="color:#888;font-size:12px">${fmtDate(l.added_at)}</td>
        </tr>`).join('')}</tbody>
      </table>` : '<div class="empty-state" style="padding:1.5rem">Not on any lists yet</div>';

    // ── Render campaign history ──
    const campaignHTML = campaignRes.rows.length ? `
      <table class="data-table">
        <thead><tr><th>Campaign</th><th>Channel</th><th>Disposition</th><th>Date</th></tr></thead>
        <tbody>${campaignRes.rows.map(c => {
          const chipClass = c.channel === 'call' ? 'chip-call' : 'chip-sms';
          return `<tr>
            <td style="font-weight:500">${c.campaign_name || '—'}</td>
            <td><span class="chip ${chipClass}">${c.channel}</span></td>
            <td style="font-size:12px">${c.disposition || '—'}</td>
            <td style="color:#888;font-size:12px">${fmtDate(c.activity_date)}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>` : '<div class="empty-state" style="padding:1.5rem">No campaign activity yet</div>';

    // ── Render import history ──
    const importHTML = importRes.rows.length ? importRes.rows.map(i => `
      <div class="timeline-item">
        <div class="timeline-date">${fmtDate(i.imported_at)}</div>
        <div>
          <div class="timeline-source">${i.source || 'Unknown source'}${i.imported_by ? ` — ${i.imported_by}` : ''}</div>
          <div class="timeline-detail">
            ${i.fields_added ? `<span class="added">+${i.fields_added}</span>` : ''}
            ${i.fields_updated ? ` · <span class="updated">Updated: ${i.fields_updated}</span>` : ''}
            ${i.notes ? ` · ${i.notes}` : ''}
          </div>
        </div>
      </div>`).join('') : '<div style="color:#aaa;font-size:13px;padding:8px 0">No import history yet</div>';

    const owner = primaryContact ? `${primaryContact.first_name || ''} ${primaryContact.last_name || ''}`.trim() : null;
    const mailingAddr = primaryContact ? [primaryContact.mailing_address, primaryContact.mailing_city, primaryContact.mailing_state, primaryContact.mailing_zip].filter(Boolean).join(', ') : null;

    res.send(shell(`${p.street}`, `
      ${msg === 'saved' ? '<div class="alert alert-success">✓ Changes saved successfully</div>' : ''}
      ${msg === 'error' ? '<div class="alert alert-error">Something went wrong. Please try again.</div>' : ''}

      <!-- HEADER -->
      <div id="property-detail" data-prop-id="${p.id}" style="margin-bottom:1.5rem">
        <div style="margin-bottom:10px"><a href="/records" style="font-size:13px;color:#888;text-decoration:none">← Records</a></div>
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap">
          <div>
            <div style="font-size:24px;font-weight:700;letter-spacing:-.3px">${p.street}</div>
            <div style="font-size:14px;color:#888;margin-top:4px;font-family:monospace">${p.city}, ${p.state_code} · ${p.zip_code}</div>
            <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
              ${p.source ? `<span class="badge" style="background:#e8f0ff;color:#2c5cc5">📂 ${p.source}</span>` : ''}
              ${p.vacant ? `<span class="badge" style="background:#fdf0f0;color:#c0392b">⚠ Vacant</span>` : ''}
              ${listsRes.rows.length ? `<span class="badge" style="background:#e8f5ee;color:#1a7a4a">${listsRes.rows.length} List${listsRes.rows.length!==1?'s':''}</span>` : ''}
              ${p.distress_score != null && p.distress_band ? (() => {
                const c = distress.BAND_COLORS[p.distress_band];
                return `<span class="badge" style="background:${c.bg};color:${c.text}">🔥 Distress ${p.distress_score} · ${c.label}</span>`;
              })() : ''}
              <span style="font-size:12px;color:#aaa;font-family:monospace">First seen: ${fmtDate(p.first_seen_at || p.created_at)}</span>
            </div>
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            ${p.estimated_value ? `<div style="text-align:right"><div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.06em">Est. Value</div><div style="font-size:22px;font-weight:700;color:#1a7a4a">${fmtMoney(p.estimated_value)}</div></div>` : ''}
            <button class="btn btn-ghost" onclick="document.getElementById('edit-modal').classList.add('open')">✏ Edit</button>
            <button onclick="deleteThisProperty(${p.id})" style="background:#fff;color:#c0392b;border:1px solid #f0c0b8;padding:6px 14px;border-radius:7px;font-size:13px;font-weight:500;cursor:pointer;font-family:inherit">🗑 Delete</button>
          </div>
        </div>
      </div>

      <!-- OWNER + PHONES -->
      <div class="grid-2" style="margin-bottom:1.25rem">
        <div class="card">
          <div class="sec-lbl">Owner</div>
          <div class="kv-grid" style="margin-bottom:1.25rem">
            <div class="kv"><div class="kv-label">First Name</div><div class="kv-val">${primaryContact?.first_name || '—'}</div></div>
            <div class="kv"><div class="kv-label">Last Name</div><div class="kv-val">${primaryContact?.last_name || '—'}</div></div>
            <div class="kv" style="grid-column:1/-1"><div class="kv-label">Mailing Address</div><div class="kv-val">${mailingAddr || '—'}</div></div>
            ${primaryContact?.email_1 ? `<div class="kv"><div class="kv-label">Email 1</div><div class="kv-val"><a href="mailto:${primaryContact.email_1}" style="color:#1a4a9a">${primaryContact.email_1}</a></div></div>` : ''}
            ${primaryContact?.email_2 ? `<div class="kv"><div class="kv-label">Email 2</div><div class="kv-val"><a href="mailto:${primaryContact.email_2}" style="color:#1a4a9a">${primaryContact.email_2}</a></div></div>` : ''}
          </div>
          <div class="sec-lbl">Phone Numbers <span class="count-pill">${phones.length}</span></div>
          ${phoneHTML}
        </div>

        <div class="card">
          <div class="sec-lbl">Property Details</div>
          <div class="kv-grid" style="margin-bottom:1.25rem">
            <div class="kv"><div class="kv-label">Type</div><div class="kv-val">${fmt(p.property_type)}</div></div>
            <div class="kv"><div class="kv-label">Bed / Bath</div><div class="kv-val">${p.bedrooms||'—'} / ${p.bathrooms||'—'}</div></div>
            <div class="kv"><div class="kv-label">Sq Ft</div><div class="kv-val">${p.sqft ? Number(p.sqft).toLocaleString() : '—'}</div></div>
            <div class="kv"><div class="kv-label">Year Built</div><div class="kv-val">${fmt(p.year_built)}</div></div>
            <div class="kv"><div class="kv-label">Lot Size</div><div class="kv-val">${p.lot_size ? Number(p.lot_size).toLocaleString() + ' sf' : '—'}</div></div>
            <div class="kv"><div class="kv-label">Condition</div><div class="kv-val" style="${p.condition==='Fair'?'color:#9a6800':p.condition==='Poor'?'color:#c0392b':''}">${fmt(p.condition)}</div></div>
            <div class="kv"><div class="kv-label">Property Status</div><div class="kv-val" style="${p.property_status==='Sold'?'color:#c0392b':p.property_status==='Pending'?'color:#9a6800':''}">${fmt(p.property_status)}</div></div>
            ${(() => {
              const occ = computeOwnerOccupancy(p, primaryContact);
              return `<div class="kv"><div class="kv-label">Owner Occupancy</div><div class="kv-val">${OCCUPANCY_LABELS[occ]}</div></div>`;
            })()}
            <div class="kv"><div class="kv-label">Assessed Value</div><div class="kv-val">${fmtMoney(p.assessed_value)}</div></div>
            <div class="kv"><div class="kv-label">Equity %</div><div class="kv-val highlight">${p.equity_percent ? p.equity_percent + '%' : '—'}</div></div>
            <div class="kv"><div class="kv-label">Marketing Result</div><div class="kv-val">${fmt(p.marketing_result)}</div></div>
          </div>
          <div class="sec-lbl">Sale History</div>
          <div class="kv-grid">
            <div class="kv"><div class="kv-label">Last Sale Date</div><div class="kv-val">${fmtDate(p.last_sale_date)}</div></div>
            <div class="kv"><div class="kv-label">Last Sale Price</div><div class="kv-val highlight">${fmtMoney(p.last_sale_price)}</div></div>
          </div>
        </div>
      </div>

      <!-- LISTS -->
      <div class="card" style="margin-bottom:1.25rem">
        <div class="sec-lbl">Lists <span class="count-pill">${listsRes.rows.length}</span></div>
        ${listsHTML}
      </div>

      <!-- TAGS CARD -->
      <div class="card" style="margin-bottom:1.25rem">
        <div class="sec-lbl">Tags <span class="count-pill" id="tag-count">${tagsRes.rows.length}</span></div>
        <div id="tag-list" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;min-height:28px">
          ${tagsRes.rows.map(t => `
            <span class="tag-pill" data-tag-id="${t.id}" style="display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:20px;font-size:12px;font-weight:500;background:${escHTML(t.color)}20;color:${escHTML(t.color)};border:1px solid ${escHTML(t.color)}40">
              ${escHTML(t.name)}
              <button onclick="removeTag(${p.id}, ${t.id}, this)" style="background:none;border:none;cursor:pointer;font-size:14px;line-height:1;color:inherit;padding:0;margin-left:2px" title="Remove tag">×</button>
            </span>
          `).join('')}
          ${tagsRes.rows.length === 0 ? '<span style="color:#aaa;font-size:12px">No tags yet</span>' : ''}
        </div>
        <div style="display:flex;gap:6px;position:relative">
          <input type="text" id="tag-input" placeholder="Type to add a tag…" autocomplete="off"
            style="flex:1;padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit"
            oninput="suggestTags(this.value)"
            onkeydown="if(event.key==='Enter'){event.preventDefault();addTagFromInput(${p.id});}"
          >
          <button onclick="addTagFromInput(${p.id})" style="padding:7px 14px;background:#1a1a1a;color:#fff;border:none;border-radius:7px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">Add</button>
          <div id="tag-suggestions" style="display:none;position:absolute;top:100%;left:0;right:60px;margin-top:4px;background:#fff;border:1px solid #ddd;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.08);max-height:180px;overflow-y:auto;z-index:50"></div>
        </div>
      </div>

      <!-- DISTRESS SCORE CARD -->
      ${p.distress_score != null ? (() => {
        const c = distress.BAND_COLORS[p.distress_band] || distress.BAND_COLORS.cold;
        const breakdownHtml = distressBreakdown.length > 0
          ? distressBreakdown.map(b => `
              <div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid #f0efe9;font-size:13px">
                <span style="color:#444">${b.label}</span>
                <span style="font-weight:600;color:#1a7a4a">+${b.points}</span>
              </div>`).join('')
          : '<div style="color:#aaa;font-size:13px;padding:12px 0;text-align:center">No distress signals detected. This property looks clean.</div>';
        return `
        <div class="card" style="margin-bottom:1.25rem;border-left:4px solid ${c.text}">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
            <div>
              <div class="sec-lbl" style="margin-bottom:4px">Distress Score</div>
              <div style="display:flex;align-items:baseline;gap:10px">
                <span style="font-size:36px;font-weight:700;color:${c.text};letter-spacing:-.5px">${p.distress_score}</span>
                <span style="font-size:14px;color:${c.text};font-weight:600;text-transform:uppercase;letter-spacing:.06em">${c.label}</span>
              </div>
              <p style="font-size:11px;color:#aaa;margin-top:6px">Scored ${p.distress_scored_at ? fmtDate(p.distress_scored_at) : 'just now'}</p>
            </div>
            <div style="text-align:right;max-width:280px">
              <p style="font-size:11px;color:#888;line-height:1.5;margin:0">Rule-based score from signals in Loki. <br><span style="color:#aaa">Audit and tune weights in Setup → Distress.</span></p>
            </div>
          </div>
          <div style="margin-top:8px">
            <div class="sec-lbl" style="margin-bottom:4px">Signals Contributing</div>
            ${breakdownHtml}
          </div>
        </div>`;
      })() : ''}

      <!-- CAMPAIGN HISTORY -->
      <div class="card" style="margin-bottom:1.25rem">
        <div class="sec-lbl">Campaign History <span class="count-pill">${campaignRes.rows.length}</span></div>
        ${campaignHTML}
      </div>

      <!-- IMPORT HISTORY -->
      <div class="card" style="margin-bottom:1.25rem">
        <div class="sec-lbl">Import History <span class="count-pill">${importRes.rows.length}</span></div>
        ${importHTML}
      </div>

      <!-- EDIT MODAL -->
      <div class="modal-overlay" id="edit-modal">
        <div class="modal">
          <div class="modal-header">
            <div class="modal-title">Edit Property</div>
            <button class="modal-close" onclick="document.getElementById('edit-modal').classList.remove('open')">×</button>
          </div>
          <form method="POST" action="/records/${p.id}/edit">
            <div style="font-size:12px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px">Property</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
              <div class="form-field" style="margin:0"><label>Property Type</label>
                <select name="property_type">
                  <option value="">—</option>
                  ${['SFR','MFR','Land','Commercial'].map(t=>`<option value="${t}" ${p.property_type===t?'selected':''}>${t}</option>`).join('')}
                </select>
              </div>
              <div class="form-field" style="margin:0"><label>Condition</label>
                <select name="condition">
                  <option value="">—</option>
                  ${['Excellent','Good','Fair','Poor'].map(t=>`<option value="${t}" ${p.condition===t?'selected':''}>${t}</option>`).join('')}
                </select>
              </div>
              <div class="form-field" style="margin:0"><label>Bedrooms</label><input type="number" name="bedrooms" value="${p.bedrooms||''}"></div>
              <div class="form-field" style="margin:0"><label>Bathrooms</label><input type="number" step="0.5" name="bathrooms" value="${p.bathrooms||''}"></div>
              <div class="form-field" style="margin:0"><label>Sq Ft</label><input type="number" name="sqft" value="${p.sqft||''}"></div>
              <div class="form-field" style="margin:0"><label>Year Built</label><input type="number" name="year_built" value="${p.year_built||''}"></div>
              <div class="form-field" style="margin:0"><label>Est. Value ($)</label><input type="number" name="estimated_value" value="${p.estimated_value||''}"></div>
              <div class="form-field" style="margin:0"><label>Vacant</label>
                <select name="vacant">
                  <option value="">Unknown</option>
                  <option value="true" ${p.vacant===true?'selected':''}>Yes</option>
                  <option value="false" ${p.vacant===false?'selected':''}>No</option>
                </select>
              </div>
              <div class="form-field" style="margin:0"><label>Last Sale Date</label><input type="date" name="last_sale_date" value="${p.last_sale_date ? String(p.last_sale_date).split('T')[0] : ''}"></div>
              <div class="form-field" style="margin:0"><label>Last Sale Price ($)</label><input type="number" name="last_sale_price" value="${p.last_sale_price||''}"></div>
              <div class="form-field" style="margin:0;grid-column:1/-1"><label>Source</label><input type="text" name="source" value="${p.source||''}" placeholder="DealMachine, PropStream, etc."></div>
              <div class="form-field" style="margin:0"><label>Property Status</label>
                <select name="property_status">
                  <option value="">—</option>
                  ${['Off Market','Pending','Sold'].map(t=>`<option value="${t}" ${p.property_status===t?'selected':''}>${t}</option>`).join('')}
                </select>
              </div>
              <div class="form-field" style="margin:0"><label>Assessed Value ($)</label><input type="number" name="assessed_value" value="${p.assessed_value||''}"></div>
              <div class="form-field" style="margin:0"><label>Equity (%)</label><input type="number" step="0.01" name="equity_percent" value="${p.equity_percent||''}"></div>
              <div class="form-field" style="margin:0"><label>Marketing Result</label>
                <select name="marketing_result">
                  <option value="">—</option>
                  ${['Lead','Potential Lead','Sold','Listed','Not Interested','Do Not Call','Spanish Speaker'].map(t=>`<option value="${t}" ${p.marketing_result===t?'selected':''}>${t}</option>`).join('')}
                </select>
              </div>
              <div class="form-field" style="margin:0"><label>Pipeline Stage</label>
                <select name="pipeline_stage">
                  <option value="">—</option>
                  ${['prospect','lead','contract','closed'].map(s=>`<option value="${s}" ${p.pipeline_stage===s?'selected':''}>${s.charAt(0).toUpperCase()+s.slice(1)}</option>`).join('')}
                </select>
              </div>
            </div>
            ${primaryContact ? `
            <div style="font-size:12px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.06em;margin:14px 0 10px">Owner</div>
            <input type="hidden" name="contact_id" value="${primaryContact.id}">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
              <div class="form-field" style="margin:0"><label>First Name</label><input type="text" name="first_name" value="${primaryContact.first_name||''}"></div>
              <div class="form-field" style="margin:0"><label>Last Name</label><input type="text" name="last_name" value="${primaryContact.last_name||''}"></div>
              <div class="form-field" style="margin:0;grid-column:1/-1"><label>Mailing Address</label><input type="text" name="mailing_address" value="${primaryContact.mailing_address||''}"></div>
              <div class="form-field" style="margin:0"><label>Mailing City</label><input type="text" name="mailing_city" value="${primaryContact.mailing_city||''}"></div>
              <div class="form-field" style="margin:0"><label>Mailing State</label><input type="text" name="mailing_state" value="${primaryContact.mailing_state||''}" maxlength="2"></div>
              <div class="form-field" style="margin:0;grid-column:1/-1"><label>Email 1</label><input type="email" name="email_1" value="${primaryContact.email_1||''}" placeholder="email@example.com"></div>
              <div class="form-field" style="margin:0;grid-column:1/-1"><label>Email 2</label><input type="email" name="email_2" value="${primaryContact.email_2||''}" placeholder="email@example.com"></div>
            </div>` : ''}
            <div class="form-field" style="margin-top:4px"><label>Notes (logged to import history)</label><textarea name="edit_notes" rows="2" placeholder="Optional note about this edit…"></textarea></div>
            <div style="display:flex;gap:8px;margin-top:4px">
              <button type="submit" class="btn btn-primary" style="flex:1">Save Changes</button>
              <button type="button" class="btn btn-ghost" onclick="document.getElementById('edit-modal').classList.remove('open')">Cancel</button>
            </div>
          </form>
        </div>
      </div>

      <!-- Delete modal (single record) -->
      <div class="modal-overlay" id="delete-modal">
        <div class="modal" style="max-width:480px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
            <h3 style="font-size:17px;font-weight:600;margin:0;color:#c0392b">🗑 Delete Record</h3>
            <button onclick="document.getElementById('delete-modal').classList.remove('open')" style="background:none;border:none;font-size:22px;cursor:pointer;color:#888;line-height:1">×</button>
          </div>
          <div style="font-size:14px;margin-bottom:16px;color:#333;line-height:1.5">
            You are about to permanently delete <strong>${escHTML(p.street)}, ${escHTML(p.city)}, ${escHTML(p.state_code)}</strong>. This cannot be undone.
          </div>
          <div id="delete-modal-err" style="display:none;background:#fdeaea;border:1px solid #f5c5c5;border-radius:6px;padding:8px 12px;color:#8b1f1f;font-size:13px;margin-bottom:12px"></div>
          <div style="margin-bottom:14px">
            <label style="font-size:12px;color:#888;display:block;margin-bottom:4px">Delete Code</label>
            <input type="password" id="delete-code-input" autocomplete="off" placeholder="Enter delete code" style="width:100%;padding:9px 12px;border:1px solid #ddd;border-radius:8px;font-size:14px;font-family:inherit" onkeydown="if(event.key==='Enter'){event.preventDefault();confirmDeleteSingle();}">
          </div>
          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button onclick="document.getElementById('delete-modal').classList.remove('open')" style="padding:9px 16px;background:#fff;color:#666;border:1px solid #ddd;border-radius:8px;font-size:13px;cursor:pointer;font-family:inherit">Cancel</button>
            <button onclick="confirmDeleteSingle()" id="delete-confirm-btn" style="padding:9px 16px;background:#c0392b;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">Delete</button>
          </div>
          <div style="font-size:11px;color:#888;margin-top:12px;line-height:1.4">
            Forgot the code? <a href="/settings/security" style="color:#666">Update it in Security Settings</a>.
          </div>
        </div>
      </div>

      <script src="/js/records-detail.js?v=2"></script>
    `, 'records'));
  } catch (e) {
    console.error(e);
    res.status(500).send('Server error: ' + e.message);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// EDIT SUBMIT — POST /records/:id/edit
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/:id(\\d+)/edit', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      property_type, condition, bedrooms, bathrooms, sqft, year_built,
      estimated_value, vacant, last_sale_date, last_sale_price, source,
      property_status, assessed_value, equity_percent, marketing_result,
      pipeline_stage,
      contact_id, first_name, last_name, mailing_address, mailing_city,
      mailing_state, email_1, email_2, edit_notes
    } = req.body;

    // Capture before-state for outcome logging
    const beforeRes = await query(
      `SELECT marketing_result, pipeline_stage FROM properties WHERE id = $1`,
      [id]
    );
    const before = beforeRes.rows[0] || {};

    const updated = [];

    await query(`
      UPDATE properties SET
        property_type = COALESCE(NULLIF($1,''), property_type),
        condition = COALESCE(NULLIF($2,''), condition),
        bedrooms = CASE WHEN $3 = '' THEN bedrooms ELSE $3::smallint END,
        bathrooms = CASE WHEN $4 = '' THEN bathrooms ELSE $4::numeric END,
        sqft = CASE WHEN $5 = '' THEN sqft ELSE $5::integer END,
        year_built = CASE WHEN $6 = '' THEN year_built ELSE $6::smallint END,
        estimated_value = CASE WHEN $7 = '' THEN estimated_value ELSE $7::numeric END,
        vacant = CASE WHEN $8 = '' THEN vacant WHEN $8 = 'true' THEN true ELSE false END,
        last_sale_date = CASE WHEN $9 = '' THEN last_sale_date ELSE $9::date END,
        last_sale_price = CASE WHEN $10 = '' THEN last_sale_price ELSE $10::numeric END,
        source = COALESCE(NULLIF($11,''), source),
        property_status = COALESCE(NULLIF($12,''), property_status),
        assessed_value = CASE WHEN $13 = '' THEN assessed_value ELSE $13::numeric END,
        equity_percent = CASE WHEN $14 = '' THEN equity_percent ELSE $14::numeric END,
        marketing_result = COALESCE(NULLIF($15,''), marketing_result),
        pipeline_stage = COALESCE(NULLIF($16,''), pipeline_stage),
        updated_at = NOW()
      WHERE id = $17
    `, [property_type, condition, bedrooms||'', bathrooms||'', sqft||'', year_built||'',
        estimated_value||'', vacant||'', last_sale_date||'', last_sale_price||'', source,
        property_status||'', assessed_value||'', equity_percent||'',
        marketing_result||'', pipeline_stage||'', id]);

    updated.push('property fields');

    if (contact_id) {
      await query(`
        UPDATE contacts SET
          first_name = COALESCE(NULLIF($1,''), first_name),
          last_name = COALESCE(NULLIF($2,''), last_name),
          mailing_address = COALESCE(NULLIF($3,''), mailing_address),
          mailing_city = COALESCE(NULLIF($4,''), mailing_city),
          mailing_state = COALESCE(NULLIF($5,''), mailing_state),
          email_1 = COALESCE(NULLIF($6,''), email_1),
          email_2 = COALESCE(NULLIF($7,''), email_2),
          updated_at = NOW()
        WHERE id = $8
      `, [first_name, last_name, mailing_address, mailing_city, mailing_state, email_1||'', email_2||'', contact_id]);
      updated.push('owner info');
    }

    // Log to import history
    await query(`
      INSERT INTO import_history (property_id, source, imported_by, fields_updated, notes)
      VALUES ($1, 'Manual Edit', $2, $3, $4)
    `, [id, req.session.username || 'admin', updated.join(', '), edit_notes || null]);

    // Distress: log outcome transitions + rescore
    try {
      // If marketing_result or pipeline_stage actually changed, log outcome
      const newMkt = (marketing_result || '').trim();
      const newStage = (pipeline_stage || '').trim();
      if (newMkt && newMkt !== (before.marketing_result || '')) {
        await distress.logOutcomeChange(id, 'marketing_result', before.marketing_result, newMkt);
      }
      if (newStage && newStage !== (before.pipeline_stage || '')) {
        await distress.logOutcomeChange(id, 'pipeline_stage', before.pipeline_stage, newStage);
      }
      // Always re-score after edit — equity, mailing state, marketing result all affect it
      await distress.scoreProperty(id);
    } catch(e) {
      console.error('[distress] post-edit hook failed:', e.message);
      // Non-fatal — don't block the user's edit on scoring failure
    }

    res.redirect(`/records/${id}?msg=saved`);
  } catch (e) {
    console.error(e);
    res.redirect(`/records/${req.params.id}?msg=error`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SETUP → DISTRESS (admin audit page)
// Mounted at /records/_distress — links from Setup sidebar go here.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/_distress', requireAuth, async (req, res) => {
  try {
    await distress.ensureDistressSchema();
    const dist = await distress.getScoreDistribution();
    const conv = await distress.getConversionByBand();
    // 3 new audit datasets
    const closedHistory = await distress.getClosedDealScoreHistory();
    const coverage = await distress.getSignalCoverage();
    const convRates = await distress.getConversionRateByBand();

    const total = parseInt(dist.total || 0);
    const scored = total - parseInt(dist.unscored || 0);
    const pct = (n) => total > 0 ? ((parseInt(n||0) / total) * 100).toFixed(1) + '%' : '0%';

    // Group conversion data by band → outcome type → {new_value: count}
    const convByBand = { burning: {}, hot: {}, warm: {}, cold: {} };
    conv.forEach(r => {
      if (!convByBand[r.band]) convByBand[r.band] = {};
      if (!convByBand[r.band][r.outcome_type]) convByBand[r.band][r.outcome_type] = {};
      convByBand[r.band][r.outcome_type][r.new_value || '(empty)'] = parseInt(r.count);
    });

    const weightRows = Object.entries(distress.WEIGHTS).map(([k, v]) =>
      `<tr>
        <td style="padding:8px 12px;font-size:13px;color:#444">${k.replace(/_/g, ' ')}</td>
        <td style="padding:8px 12px;font-size:13px;font-weight:600;color:#1a7a4a;text-align:right">+${v}</td>
      </tr>`
    ).join('');

    const bandBar = (band, count) => {
      const c = distress.BAND_COLORS[band];
      const width = total > 0 ? (parseInt(count||0) / total) * 100 : 0;
      return `
        <div style="margin-bottom:12px">
          <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px">
            <span style="color:${c.text};font-weight:600">${c.label}</span>
            <span style="color:#888">${parseInt(count||0).toLocaleString()} · ${pct(count)}</span>
          </div>
          <div style="background:#f0efe9;border-radius:6px;height:10px;overflow:hidden">
            <div style="background:${c.text};width:${width}%;height:100%;transition:width .3s"></div>
          </div>
        </div>`;
    };

    const convTable = Object.entries(convByBand).map(([band, outcomes]) => {
      const c = distress.BAND_COLORS[band];
      const outcomeKeys = Object.keys(outcomes);
      if (outcomeKeys.length === 0) return '';
      const rows = outcomeKeys.map(ot => {
        return Object.entries(outcomes[ot]).map(([val, cnt]) =>
          `<tr>
            <td style="padding:6px 12px;font-size:12px;color:#888">${ot}</td>
            <td style="padding:6px 12px;font-size:12px;color:#444">${val}</td>
            <td style="padding:6px 12px;font-size:12px;text-align:right;font-weight:600">${cnt.toLocaleString()}</td>
          </tr>`
        ).join('');
      }).join('');
      return `
        <div style="margin-bottom:16px">
          <div style="padding:6px 12px;background:${c.bg};color:${c.text};font-size:12px;font-weight:600;border-radius:6px 6px 0 0">${c.label} band outcomes</div>
          <table style="width:100%;border:1px solid #e0dfd8;border-top:none;border-collapse:collapse;border-radius:0 0 6px 6px;overflow:hidden">
            <thead><tr style="background:#fafaf8">
              <th style="padding:6px 12px;text-align:left;font-size:11px;color:#888;font-weight:600;text-transform:uppercase">Type</th>
              <th style="padding:6px 12px;text-align:left;font-size:11px;color:#888;font-weight:600;text-transform:uppercase">New Value</th>
              <th style="padding:6px 12px;text-align:right;font-size:11px;color:#888;font-weight:600;text-transform:uppercase">Count</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    }).join('');

    const flashMsg = req.query.msg || '';
    res.send(shell('Distress Score Audit', `
      <div style="margin-bottom:1rem"><a href="/records" style="font-size:13px;color:#888;text-decoration:none">← Records</a></div>

      ${flashMsg ? `<div id="flash-msg" style="background:#e8f0ff;border:1px solid #b5ccf0;border-radius:8px;padding:12px 16px;margin-bottom:1rem;font-size:13px;color:#1a4a9a">${flashMsg}</div>` : ''}

      <!-- Job status banner (populated by the poller below) -->
      <div id="distress-job-status" style="display:none;margin-bottom:1rem"></div>

      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:1.5rem">
        <div>
          <div style="font-size:24px;font-weight:700;letter-spacing:-.3px">Distress Score Audit</div>
          <div style="font-size:13px;color:#888;margin-top:4px">Rule-based scoring engine · Phase 1</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <a href="/records/_duplicates" class="btn btn-ghost" style="font-size:13px">🔍 Find Duplicates</a>
          <form method="POST" action="/records/_distress/recompute" onsubmit="return confirm('Recompute distress score for ALL ${total.toLocaleString()} properties? This runs in the background and typically takes 2-5 minutes for 75k properties. You can close this tab; the rescore will continue on the server.')" style="margin:0">
            <button type="submit" id="recompute-btn" class="btn" style="background:#1a4a9a;color:#fff;border:none">↻ Recompute All Scores</button>
          </form>
        </div>
      </div>

      <script>
      // Poll job status every 3 seconds. Show banner with progress / completion.
      async function checkDistressJob() {
        try {
          const r = await fetch('/records/_distress/status');
          if (!r.ok) return;
          const j = await r.json();
          const el = document.getElementById('distress-job-status');
          const btn = document.getElementById('recompute-btn');

          if (j.running) {
            el.style.display = 'block';
            const elapsedMin = Math.floor((j.elapsed_seconds||0) / 60);
            const elapsedSec = (j.elapsed_seconds||0) % 60;
            const timeStr = elapsedMin > 0 ? elapsedMin + 'm ' + elapsedSec + 's' : elapsedSec + 's';
            el.innerHTML = '<div style="background:#fff8e1;border:1px solid #e8cf87;border-radius:8px;padding:12px 16px;font-size:13px;color:#6a4a00;display:flex;align-items:center;gap:10px">' +
              '<div class="spinner" style="width:14px;height:14px;border:2px solid #e8cf87;border-top-color:#6a4a00;border-radius:50%;animation:spin 0.8s linear infinite"></div>' +
              '<div><b>Rescore running…</b> elapsed ' + timeStr + '. Safe to navigate away — it\\'ll finish on the server.</div>' +
              '</div>';
            if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; btn.textContent = '⏳ Running…'; }
            setTimeout(checkDistressJob, 3000);
          } else if (j.error) {
            el.style.display = 'block';
            el.innerHTML = '<div style="background:#fdecec;border:1px solid #f5c5c5;border-radius:8px;padding:12px 16px;font-size:13px;color:#c0392b"><b>Rescore failed:</b> ' + j.error.replace(/</g, '&lt;') + '</div>';
          } else if (j.finishedAt) {
            // Job finished — show a success banner, prompt reload to see new numbers
            const ago = Math.round((Date.now() - j.finishedAt) / 1000);
            // Only show the banner if it finished recently (within last 2 minutes)
            if (ago < 120) {
              el.style.display = 'block';
              el.innerHTML = '<div style="background:#e8f5ee;border:1px solid #8dcaa3;border-radius:8px;padding:12px 16px;font-size:13px;color:#1a7a4a;display:flex;align-items:center;justify-content:space-between;gap:10px">' +
                '<div>✓ <b>Rescore complete.</b> Scored ' + (j.scored||0).toLocaleString() + ' properties.</div>' +
                '<button onclick="location.reload()" style="background:#1a7a4a;color:#fff;border:none;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600">Reload to see new scores</button>' +
                '</div>';
            }
          }
        } catch(e) { /* swallow — retry on next interval */ }
      }
      // Start polling on page load — cheap even if no job is running
      checkDistressJob();
      // Add spinner keyframes if not already present
      if (!document.getElementById('spinner-style')) {
        const s = document.createElement('style');
        s.id = 'spinner-style';
        s.textContent = '@keyframes spin{to{transform:rotate(360deg)}}';
        document.head.appendChild(s);
      }
      </script>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:1.25rem">
        <div class="card">
          <div class="sec-lbl" style="margin-bottom:10px">Score Distribution</div>
          <div style="font-size:12px;color:#888;margin-bottom:10px">${scored.toLocaleString()} of ${total.toLocaleString()} records scored${dist.unscored > 0 ? ` · ${parseInt(dist.unscored).toLocaleString()} pending` : ''}</div>
          ${bandBar('burning', dist.burning)}
          ${bandBar('hot', dist.hot)}
          ${bandBar('warm', dist.warm)}
          ${bandBar('cold', dist.cold)}
        </div>

        <div class="card">
          <div class="sec-lbl" style="margin-bottom:10px">Current Weights</div>
          <table style="width:100%;border-collapse:collapse">
            <tbody>${weightRows}</tbody>
          </table>
          <p style="font-size:11px;color:#aaa;margin-top:10px">Tune weights in <code>src/scoring/distress.js</code>, then click <b>Recompute All</b>.</p>
        </div>
      </div>

      <!-- AUDIT 1: Closed Deal Score History — "Did the system catch deals that closed?" -->
      <div class="card" style="margin-bottom:1.25rem">
        <div class="sec-lbl" style="margin-bottom:10px">📊 Closed Deal Score History</div>
        <div style="font-size:12px;color:#888;margin-bottom:14px">Properties currently in Lead / Contract / Closed stages. Look at score history — if deals closed while scoring Cold, the system missed signals. If they climbed Hot before closing, the system caught them.</div>
        ${closedHistory.length === 0 ? `
          <div style="color:#aaa;font-size:13px;text-align:center;padding:20px">No properties in Lead / Contract / Closed yet. As you mark them, score histories will appear here.</div>
        ` : `
          <div style="overflow-x:auto">
            <table style="width:100%;font-size:12px;border-collapse:collapse">
              <thead><tr style="border-bottom:1px solid #e0dfd8;text-align:left">
                <th style="padding:8px;font-size:11px;color:#888;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Property</th>
                <th style="padding:8px;font-size:11px;color:#888;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Stage</th>
                <th style="padding:8px;font-size:11px;color:#888;font-weight:600;text-transform:uppercase;letter-spacing:.05em;text-align:center">Current Score</th>
                <th style="padding:8px;font-size:11px;color:#888;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Score History</th>
                <th style="padding:8px;font-size:11px;color:#888;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Verdict</th>
              </tr></thead>
              <tbody>
                ${closedHistory.map(p => {
                  const c = distress.BAND_COLORS[p.distress_band] || distress.BAND_COLORS.cold;
                  const history = p.score_history || [];
                  const histStr = history.length === 0
                    ? '<span style="color:#aaa">No prior scores</span>'
                    : history.map(h => {
                        const hc = distress.BAND_COLORS[h.band] || distress.BAND_COLORS.cold;
                        return `<span style="display:inline-block;background:${hc.bg};color:${hc.text};padding:2px 6px;border-radius:4px;font-size:10px;font-weight:600;margin-right:3px">${h.score}</span>`;
                      }).join('→');
                  // Verdict logic
                  const stage = p.pipeline_stage;
                  let verdict = '';
                  if (stage === 'closed' || stage === 'contract') {
                    if (p.distress_band === 'burning' || p.distress_band === 'hot') verdict = '<span style="color:#1a7a4a;font-weight:600">✓ Caught</span>';
                    else if (p.distress_band === 'warm') verdict = '<span style="color:#9a6800;font-weight:600">~ Borderline</span>';
                    else verdict = '<span style="color:#c0392b;font-weight:600">✗ Missed</span>';
                  } else {
                    verdict = '<span style="color:#888">In progress</span>';
                  }
                  return `
                    <tr style="border-bottom:1px solid #f0efe9">
                      <td style="padding:8px"><a href="/records/${p.id}" style="color:#1a4a9a;text-decoration:none">${p.street}</a><br><span style="color:#888;font-size:11px">${p.city}, ${p.state_code}</span></td>
                      <td style="padding:8px;text-transform:capitalize">${stage}</td>
                      <td style="padding:8px;text-align:center"><span style="background:${c.bg};color:${c.text};padding:3px 8px;border-radius:4px;font-weight:600">${p.distress_score}</span></td>
                      <td style="padding:8px">${histStr}</td>
                      <td style="padding:8px">${verdict}</td>
                    </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>
        `}
      </div>

      <!-- AUDIT 2: Signal Coverage Report — "What data is missing?" -->
      <div class="card" style="margin-bottom:1.25rem">
        <div class="sec-lbl" style="margin-bottom:10px">📋 Signal Coverage Report</div>
        <div style="font-size:12px;color:#888;margin-bottom:14px">% of records with each scoring input populated. <b>Low coverage = signal silently mutes scoring.</b> If only 12% have equity data, the High Equity rule fires for nobody — that's a data gap, not a scoring problem.</div>
        ${coverage.total === 0 ? '<div style="color:#aaa">No records to analyze.</div>' : (() => {
          const sigs = [
            { label: 'Property State Code', count: coverage.has_state, signal: 'Required for out-of-state detection' },
            { label: 'Mailing State (owner)', count: coverage.has_mailing_state, signal: 'Required for out-of-state detection' },
            { label: 'Equity %', count: coverage.has_equity, signal: 'Drives High Equity (+10) signal' },
            { label: 'Marketing Result', count: coverage.has_marketing, signal: 'Drives Marketing Lead (+5) signal' },
            { label: 'On at least 1 List', count: coverage.has_any_list, signal: 'Required for ALL list-based signals' },
          ];
          return `<div style="display:grid;gap:10px">
            ${sigs.map(s => {
              const p = (s.count / coverage.total) * 100;
              const color = p >= 80 ? '#1a7a4a' : p >= 40 ? '#9a6800' : '#c0392b';
              return `
                <div>
                  <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:3px">
                    <span style="color:#1a1a1a;font-weight:500">${s.label}</span>
                    <span style="color:${color};font-weight:600">${s.count.toLocaleString()} / ${coverage.total.toLocaleString()} (${p.toFixed(1)}%)</span>
                  </div>
                  <div style="background:#f0efe9;height:6px;border-radius:3px;overflow:hidden;margin-bottom:3px">
                    <div style="background:${color};width:${p}%;height:100%"></div>
                  </div>
                  <div style="font-size:11px;color:#aaa">${s.signal}</div>
                </div>`;
            }).join('')}
          </div>`;
        })()}
      </div>

      <!-- AUDIT 3: Conversion Rate by Band — "Are weights calibrated correctly?" -->
      <div class="card" style="margin-bottom:1.25rem">
        <div class="sec-lbl" style="margin-bottom:10px">🎯 Conversion Rate by Band</div>
        <div style="font-size:12px;color:#888;margin-bottom:14px">% of properties in each band that have advanced to Lead / Contract / Closed. <b>If higher bands convert at higher rates, weights are calibrated.</b> If they're flat or inverted, time to tune.</div>
        ${convRates.length === 0 ? '<div style="color:#aaa">No band data yet — recompute scores first.</div>' : `
          <table style="width:100%;font-size:12px;border-collapse:collapse">
            <thead><tr style="border-bottom:1px solid #e0dfd8">
              <th style="padding:8px;text-align:left;font-size:11px;color:#888;font-weight:600;text-transform:uppercase">Band</th>
              <th style="padding:8px;text-align:right;font-size:11px;color:#888;font-weight:600;text-transform:uppercase">Total</th>
              <th style="padding:8px;text-align:right;font-size:11px;color:#888;font-weight:600;text-transform:uppercase">Lead</th>
              <th style="padding:8px;text-align:right;font-size:11px;color:#888;font-weight:600;text-transform:uppercase">Contract</th>
              <th style="padding:8px;text-align:right;font-size:11px;color:#888;font-weight:600;text-transform:uppercase">Closed</th>
              <th style="padding:8px;text-align:right;font-size:11px;color:#888;font-weight:600;text-transform:uppercase">Any Adv. %</th>
            </tr></thead>
            <tbody>
              ${convRates.map(r => {
                const c = distress.BAND_COLORS[r.band] || distress.BAND_COLORS.cold;
                return `
                  <tr style="border-bottom:1px solid #f0efe9">
                    <td style="padding:8px"><span style="background:${c.bg};color:${c.text};padding:3px 9px;border-radius:5px;font-weight:600;font-size:11px">${c.label}</span></td>
                    <td style="padding:8px;text-align:right">${r.total.toLocaleString()}</td>
                    <td style="padding:8px;text-align:right">${r.leads.toLocaleString()}</td>
                    <td style="padding:8px;text-align:right">${r.contracts.toLocaleString()}</td>
                    <td style="padding:8px;text-align:right;font-weight:600">${r.closed.toLocaleString()}</td>
                    <td style="padding:8px;text-align:right;font-weight:600;color:${r.any_rate >= 5 ? '#1a7a4a' : r.any_rate >= 1 ? '#9a6800' : '#888'}">${r.any_rate.toFixed(2)}%</td>
                  </tr>`;
              }).join('')}
            </tbody>
          </table>
          <p style="font-size:11px;color:#aaa;margin-top:12px;padding-top:8px;border-top:1px solid #f0efe9">
            <b>Healthy pattern:</b> Burning &gt; Hot &gt; Warm &gt; Cold conversion rates.<br>
            <b>Need tuning:</b> Cold converting equally well, or Hot converting worse than Warm.
          </p>
        `}
      </div>

      <div class="card">
        <div class="sec-lbl" style="margin-bottom:10px">Outcome Log — Conversion by Band</div>
        <div style="font-size:12px;color:#888;margin-bottom:14px">Captures what happened to properties at each score level. As data accumulates, this tells you which bands actually convert — the feedback loop for tuning weights.</div>
        ${convTable || '<div style="color:#aaa;font-size:13px;text-align:center;padding:20px">No outcome data yet. As you mark properties as Lead / Contract / Closed, data will accumulate here.</div>'}
      </div>
    `));
  } catch (e) {
    console.error('[distress/audit]', e);
    res.status(500).send('Distress audit page error: ' + e.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Distress recompute — background job pattern (2026-04-18 fix).
//
// The old synchronous handler blocked the HTTP request for the entire 3-10 min
// UPDATE query, which Railway's edge proxy timed out at ~100s — so the UI
// showed "nothing happening" even when the backend was still working.
//
// Now: start a background job, return immediately, let the UI poll for status.
// ─────────────────────────────────────────────────────────────────────────────

// 2026-04-18 audit fix #11: job state was module-level JS, meaning each Node
// process had its own copy. If Railway scales to 2+ replicas, two users clicking
// Recompute on different replicas would both see `running: false` and fire
// simultaneous rescores against the same DB. Moved to Redis so all replicas see
// a single source of truth. Falls back to in-memory if Redis unavailable
// (single-replica dev mode).

const DISTRESS_JOB_KEY = 'loki:distress:job';
const DISTRESS_JOB_TTL = 30 * 60; // 30 minutes — job must finish or fail in this window

// Lazy Redis connection — only created if REDIS_URL is set. Avoids circular
// require of server.js. If Redis is unreachable, falls back to in-memory.
let _distressRedis = null;
let _distressRedisInitTried = false;
function _getDistressRedis() {
  if (_distressRedisInitTried) return _distressRedis;
  _distressRedisInitTried = true;
  if (!process.env.REDIS_URL) return null;
  try {
    const Redis = require('ioredis');
    _distressRedis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: true });
    _distressRedis.on('error', (e) => { /* fall back to memory silently */ });
  } catch (e) {
    console.warn('[distress] Redis unavailable for job state:', e.message);
    _distressRedis = null;
  }
  return _distressRedis;
}

// In-memory fallback only used when Redis isn't configured (local dev).
let _localDistressJob = {
  running: false, startedAt: null, finishedAt: null,
  scored: 0, total: 0, error: null,
};

async function getDistressJob() {
  const redis = _getDistressRedis();
  if (redis) {
    try {
      const raw = await redis.get(DISTRESS_JOB_KEY);
      return raw ? JSON.parse(raw) : _localDistressJob;
    } catch (_) { /* fall through to local */ }
  }
  return _localDistressJob;
}

async function setDistressJob(job) {
  _localDistressJob = job;   // always keep local copy in sync
  const redis = _getDistressRedis();
  if (redis) {
    try { await redis.setex(DISTRESS_JOB_KEY, DISTRESS_JOB_TTL, JSON.stringify(job)); }
    catch (_) { /* non-fatal — memory still has it */ }
  }
}

// 2026-04-20 pass 12: atomic test-and-set.
// Pre-pass-12 the recompute endpoint did getDistressJob() → check !running →
// setDistressJob({running:true}) in three separate awaits. Two fast clicks
// on the Recompute button (or two users hitting it within the same 100ms)
// both observed running=false and both proceeded to start workers.
// tryClaimDistressJob uses Redis SET NX EX for a single-shot atomic claim;
// falls back to a JS-level boolean when Redis isn't available (Railway runs
// single-process so this is race-free within one worker).
let _localClaimFlag = false;
async function tryClaimDistressJob(newJob) {
  const redis = _getDistressRedis();
  if (redis) {
    try {
      // NX = only set if key doesn't exist. Returns 'OK' on success, null if
      // someone else already holds the key.
      const result = await redis.set(DISTRESS_JOB_KEY, JSON.stringify(newJob), 'NX', 'EX', DISTRESS_JOB_TTL);
      if (result === 'OK') {
        _localDistressJob = newJob;
        _localClaimFlag = true;
        return true;
      }
      // Someone else claimed it; make sure our local copy reflects that.
      const raw = await redis.get(DISTRESS_JOB_KEY);
      if (raw) _localDistressJob = JSON.parse(raw);
      return false;
    } catch (e) {
      console.error('[distress] Redis claim failed, falling back to local flag:', e.message);
      // Fall through to the local-flag path.
    }
  }
  // Local fallback — single-process node is single-threaded, this synchronous
  // read-write block cannot race with itself.
  if (_localClaimFlag || (_localDistressJob && _localDistressJob.running)) return false;
  _localClaimFlag = true;
  _localDistressJob = newJob;
  return true;
}

async function releaseDistressJob(finalJob) {
  _localClaimFlag = false;
  await setDistressJob(finalJob);
}

router.post('/_distress/recompute', requireAuth, async (req, res) => {
  // 2026-04-20 pass 12: atomic claim. See tryClaimDistressJob.
  const newJob = {
    running: true,
    startedAt: Date.now(),
    finishedAt: null,
    scored: 0,
    total: 0,
    error: null,
  };
  const claimed = await tryClaimDistressJob(newJob);
  if (!claimed) {
    return res.redirect('/records/_distress?msg=' + encodeURIComponent('A rescore is already running. Check back in a minute.'));
  }

  // Respond immediately — browser won't hang
  res.redirect('/records/_distress?msg=' + encodeURIComponent('Rescore started. This runs in the background (typically 2-5 minutes for 75k properties). The Score Distribution numbers will update when it finishes — refresh this page to check.'));

  // Fire the actual work in the background, no await on the response path
  setImmediate(async () => {
    try {
      console.log('[distress/recompute] starting background rescore…');
      const result = await distress.scoreAllProperties((p) => {
        if (p.finished) {
          console.log(`[distress/recompute] done: ${p.done}/${p.total}`);
        }
      });
      const finishedAt = Date.now();
      await releaseDistressJob({
        running: false,
        startedAt: newJob.startedAt,
        finishedAt,
        scored: result.scored,
        total: result.total,
        error: null,
      });
      const secs = Math.round((finishedAt - newJob.startedAt) / 1000);
      console.log(`[distress/recompute] finished in ${secs}s — scored ${result.scored} of ${result.total}`);
    } catch (e) {
      console.error('[distress/recompute] FAILED:', e);
      await releaseDistressJob({
        running: false,
        startedAt: newJob.startedAt,
        finishedAt: Date.now(),
        scored: 0,
        total: 0,
        error: e.message,
      });
    }
  });
});

// Status endpoint — lets the UI poll without doing any work
router.get('/_distress/status', requireAuth, async (req, res) => {
  const job = await getDistressJob();
  const now = Date.now();
  const elapsed = job.startedAt ? Math.round((now - job.startedAt) / 1000) : 0;
  res.json({
    running: job.running,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    elapsed_seconds: job.running ? elapsed : null,
    scored: job.scored,
    total: job.total,
    error: job.error,
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DUPLICATE FINDER & MERGE — GET /records/_duplicates
// Finds property groups with the same normalized (street, city, state, zip-5) key
// where multiple property rows exist (typically caused by ZIP+4 vs 5-digit
// inconsistencies before normalizeZip was applied).
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/_duplicates', requireAuth, async (req, res) => {
  try {
    const msg = req.query.msg || '';
    const err = req.query.err || '';

    // Group properties by normalized key. SUBSTRING(zip_code, 1, 5) collapses
    // ZIP+4 to 5-digit; LOWER + TRIM normalize street/city/state casing.
    // 2026-04-18 audit fix #22: previously used LOWER(TRIM(street)) which
    // differed from the rest of the system — marketing filter, owner occupancy,
    // and street_normalized generated column all strip periods/commas and
    // collapse whitespace. So "123 Main St." and "123 Main St" were treated as
    // different records by the dedup finder but same by everything else — you
    // had ghost duplicates the dedup page would never show. Now uses
    // street_normalized with a COALESCE fallback for any row where the
    // generated column hasn't been populated yet (defensive).
    const groupsRes = await query(`
      WITH normalized AS (
        SELECT
          id,
          street,
          city,
          state_code,
          zip_code,
          COALESCE(
            street_normalized,
            LOWER(REGEXP_REPLACE(REGEXP_REPLACE(TRIM(COALESCE(street,'')), '[.,]+', '', 'g'), '\\s+', ' ', 'g'))
          )                                    AS k_street,
          LOWER(TRIM(city))                    AS k_city,
          UPPER(TRIM(state_code))              AS k_state,
          SUBSTRING(TRIM(zip_code) FROM 1 FOR 5) AS k_zip,
          first_seen_at,
          updated_at
        FROM properties
        WHERE street IS NOT NULL AND street != ''
          AND city IS NOT NULL AND city != ''
          AND state_code IS NOT NULL AND state_code != ''
      ),
      keyed AS (
        SELECT
          k_street, k_city, k_state, k_zip,
          COUNT(*)                             AS dup_count,
          ARRAY_AGG(id ORDER BY id ASC)        AS ids,
          MIN(street || ' • ' || city || ', ' || state_code || ' ' || zip_code) AS sample_label
        FROM normalized
        WHERE k_zip IS NOT NULL AND k_zip != ''
        GROUP BY k_street, k_city, k_state, k_zip
        HAVING COUNT(*) > 1
      )
      SELECT * FROM keyed
      ORDER BY dup_count DESC, k_state, k_city, k_street
      LIMIT 200
    `);

    const totalDupGroups = groupsRes.rows.length;
    // Postgres COUNT() returns a STRING, not a number. Cast to int to prevent
    // string-concatenation ("0" + "3" = "03") in reduce.
    const totalDupRows   = groupsRes.rows.reduce((s, g) => s + parseInt(g.dup_count), 0);
    const totalRedundant = groupsRes.rows.reduce((s, g) => s + (parseInt(g.dup_count) - 1), 0);

    // Render each group as a card with a one-click merge form
    const groupCards = groupsRes.rows.map((g, i) => {
      const idsList = g.ids.join(',');
      const keepId = g.ids[0]; // oldest = lowest id
      const dropIds = g.ids.slice(1);
      return `
        <div class="card" style="margin-bottom:14px;padding:16px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:10px">
            <div>
              <div style="font-size:14px;font-weight:600;color:#1a1a1a">${(g.sample_label||'').replace(/</g,'&lt;')}</div>
              <div style="font-size:12px;color:#888;margin-top:2px">${g.dup_count} records · key: <code style="background:#f0efe9;padding:1px 5px;border-radius:3px;font-size:11px">${(g.k_street||'').slice(0,40)} | ${g.k_city} | ${g.k_state} | ${g.k_zip}</code></div>
            </div>
            <form method="POST" action="/records/_duplicates/merge" onsubmit="return confirm('Merge ${g.dup_count} records into the oldest one (#${keepId})?\\n\\nThis will:\\n• Move all lists, contacts, phones to property #${keepId}\\n• Delete property records: #${dropIds.join(', #')}\\n• Cannot be undone');">
              <input type="hidden" name="keep_id" value="${keepId}">
              <input type="hidden" name="drop_ids" value="${dropIds.join(',')}">
              <button type="submit" style="background:#1a1a1a;color:#fff;border:none;padding:7px 14px;border-radius:7px;font-size:12px;font-weight:500;cursor:pointer;font-family:inherit">Merge into #${keepId}</button>
            </form>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            ${g.ids.map((id, idx) => `
              <a href="/records/${id}" target="_blank" style="background:${idx===0?'#eaf6ea':'#fff8e1'};border:1px solid ${idx===0?'#9bd09b':'#f5d06b'};border-radius:6px;padding:5px 10px;font-size:12px;color:#1a1a1a;text-decoration:none">
                ${idx===0?'KEEP ':''}#${id}
              </a>
            `).join('')}
          </div>
        </div>`;
    }).join('');

    res.send(shell('Find Duplicates', `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.5rem;flex-wrap:wrap;gap:12px">
        <div>
          <div class="page-title">Duplicate Properties</div>
          <div class="page-sub">Find and merge property records that share the same address (after ZIP normalization)</div>
        </div>
        <a href="/records" class="btn btn-ghost" style="font-size:13px">← Back to Records</a>
      </div>

      ${msg ? `<div class="card" style="margin-bottom:1rem;background:#eaf6ea;border-color:#9bd09b;padding:12px 16px;color:#1a5f1a;font-size:13px">✅ ${msg}</div>` : ''}
      ${err ? `<div class="card" style="margin-bottom:1rem;background:#fdeaea;border-color:#f5c5c5;padding:12px 16px;color:#8b1f1f;font-size:13px">❌ ${err}</div>` : ''}

      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:1.5rem">
        <div class="card" style="padding:14px">
          <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.05em">Duplicate Groups</div>
          <div style="font-size:24px;font-weight:600;margin-top:4px">${totalDupGroups}</div>
        </div>
        <div class="card" style="padding:14px">
          <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.05em">Total Duplicate Rows</div>
          <div style="font-size:24px;font-weight:600;margin-top:4px">${totalDupRows}</div>
        </div>
        <div class="card" style="padding:14px">
          <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.05em">Rows To Be Merged Away</div>
          <div style="font-size:24px;font-weight:600;margin-top:4px;color:#c0392b">${totalRedundant}</div>
        </div>
      </div>

      ${totalDupGroups === 0 ? `
        <div class="card" style="text-align:center;padding:3rem;color:#888">
          <div style="font-size:32px;margin-bottom:12px">🎉</div>
          <div style="font-size:15px;font-weight:500;color:#555">No duplicates found</div>
          <div style="font-size:13px;margin-top:6px">All property addresses are unique after ZIP normalization.</div>
        </div>
      ` : `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap">
          <div style="font-size:12px;color:#888">
            Showing top ${groupsRes.rows.length} duplicate groups (capped at 200). The OLDEST record (lowest ID) is kept; others are merged into it.
          </div>
          <form method="POST" action="/records/_duplicates/merge_all" onsubmit="return confirm('Merge ALL ${totalDupGroups} duplicate group(s)?\\n\\nThis will:\\n• Process every group on this page\\n• Keep the oldest record in each group\\n• Delete ${totalRedundant} redundant records\\n• Cannot be undone\\n\\nMay take 30-60 seconds.');" style="margin:0;display:flex;gap:8px;align-items:center">
            ${totalDupGroups >= 10 ? `<input type="password" name="code" placeholder="Delete code" required autocomplete="off" style="padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:12px;font-family:inherit;width:140px" title="Required when merging 10+ groups">` : ''}
            <button type="submit" style="background:#c0392b;color:#fff;border:none;padding:8px 16px;border-radius:7px;font-size:13px;font-weight:500;cursor:pointer;font-family:inherit">⚡ Merge All ${totalDupGroups} Groups</button>
          </form>
        </div>
        ${groupCards}
      `}
    `, 'records'));
  } catch(e) {
    console.error('[duplicates] page error:', e);
    res.status(500).send('Server error: ' + e.message);
  }
});

// POST /records/_duplicates/merge — merges drop_ids into keep_id
router.post('/_duplicates/merge', requireAuth, async (req, res) => {
  try {
    const keepId = parseInt(req.body.keep_id);
    const dropIds = String(req.body.drop_ids || '').split(',').map(s => parseInt(s)).filter(n => !isNaN(n) && n > 0 && n !== keepId);

    if (!keepId || isNaN(keepId)) return res.redirect('/records/_duplicates?err=' + encodeURIComponent('Missing keep_id'));
    if (dropIds.length === 0)     return res.redirect('/records/_duplicates?err=' + encodeURIComponent('No drop_ids provided'));

    // Verify keep_id exists
    const keepCheck = await query(`SELECT id FROM properties WHERE id = $1`, [keepId]);
    if (!keepCheck.rows.length) return res.redirect('/records/_duplicates?err=' + encodeURIComponent('Keep property not found: ' + keepId));

    // Verify all drop_ids exist
    const dropCheck = await query(`SELECT id FROM properties WHERE id = ANY($1::int[])`, [dropIds]);
    if (dropCheck.rows.length !== dropIds.length) {
      return res.redirect('/records/_duplicates?err=' + encodeURIComponent('Some drop_ids not found'));
    }

    let movedLists = 0, movedContacts = 0;

    // NOTE: This runs as separate queries (no explicit transaction). If a step
    // fails, re-running the merge is safe — the INSERT...NOT IN is idempotent
    // and DELETE on already-removed rows is a no-op. Worst-case partial state:
    // the kept property has the merged children but the dropped properties
    // still exist (just with no children). User can simply click Merge again.

    // 1) Move list memberships from dropped → kept (skip duplicates that already exist on keep)
    const listRes = await query(`
      INSERT INTO property_lists (property_id, list_id, added_at)
      SELECT $1, list_id, MIN(added_at)
      FROM property_lists
      WHERE property_id = ANY($2::int[])
        AND list_id NOT IN (SELECT list_id FROM property_lists WHERE property_id = $1)
      GROUP BY list_id
      RETURNING list_id
    `, [keepId, dropIds]);
    movedLists = listRes.rowCount || 0;

    // 2) Move contact relationships (skip those already on keep)
    // 2026-04-18 audit fix #17: Previously BOOL_OR(primary_contact) could
    // produce TRUE for incoming contacts even when the keep property already
    // had a primary. That would violate the new partial-unique index
    // (idx_property_contacts_single_primary) and fail the merge. Check
    // whether keep already has a primary; if so, all incoming moves come in
    // as primary_contact = false.
    const keepHasPrimaryRes = await query(
      `SELECT 1 FROM property_contacts WHERE property_id = $1 AND primary_contact = true LIMIT 1`,
      [keepId]
    );
    const keepHasPrimary = keepHasPrimaryRes.rows.length > 0;

    const contactRes = await query(`
      INSERT INTO property_contacts (property_id, contact_id, primary_contact)
      SELECT $1, contact_id, ${keepHasPrimary ? 'false' : 'BOOL_OR(primary_contact)'}
      FROM property_contacts
      WHERE property_id = ANY($2::int[])
        AND contact_id NOT IN (SELECT contact_id FROM property_contacts WHERE property_id = $1)
      GROUP BY contact_id
      RETURNING contact_id
    `, [keepId, dropIds]);
    movedContacts = contactRes.rowCount || 0;

    // 3) Move or clean FK-dependent history rows so the DELETE doesn't fail.
    //    For merges we REPARENT history to the keeper (call_logs, sms_logs,
    //    filtration_results, marketing_touches, deals) instead of discarding
    //    it — the merge is supposed to consolidate a duplicate onto one
    //    canonical property, so the canonical one should inherit the call
    //    attempts, SMS sends, deals, etc.
    //    2026-04-20 pass 12: pre-pass-12 these steps were absent, and any
    //    duplicate property that happened to carry call/SMS/deal history
    //    blew up the DELETE with a FK violation, leaving the merge half-
    //    complete (list memberships already moved) with no transaction to
    //    unwind. Now: reparent, then delete.
    await query(`UPDATE call_logs          SET property_id = $1 WHERE property_id = ANY($2::int[])`, [keepId, dropIds]);
    await query(`UPDATE sms_logs           SET property_id = $1 WHERE property_id = ANY($2::int[])`, [keepId, dropIds]);
    await query(`UPDATE filtration_results SET property_id = $1 WHERE property_id = ANY($2::int[])`, [keepId, dropIds]);
    await query(`UPDATE marketing_touches  SET property_id = $1 WHERE property_id = ANY($2::int[])`, [keepId, dropIds]);
    await query(`UPDATE deals              SET property_id = $1 WHERE property_id = ANY($2::int[])`, [keepId, dropIds]);

    // 4) Delete the dropped properties — distress logs cascade automatically;
    //    property_lists / property_contacts for the drops are no longer needed
    //    (we copied the unique ones; rest were duplicates already on keep).
    await query(`DELETE FROM property_lists    WHERE property_id = ANY($1::int[])`, [dropIds]);
    await query(`DELETE FROM property_contacts WHERE property_id = ANY($1::int[])`, [dropIds]);
    await query(`DELETE FROM properties        WHERE id = ANY($1::int[])`, [dropIds]);

    // 5) Refresh owner_portfolio_counts — the owned-count for every property
    //    owned by this contact just changed.
    try {
      const { refreshOwnerPortfolioMv } = require('../db');
      await refreshOwnerPortfolioMv();
    } catch (e) {
      console.error('[duplicates/merge] MV refresh failed (non-fatal):', e.message);
    }

    // 6) Recompute distress for the kept property since lists may have changed
    // 2026-04-18 audit fix #27: previously `catch(_) {}` silently swallowed any
    // scoring failure. Merge appeared successful but kept property had a stale
    // score with no way to know. Log the error so operators can investigate;
    // still non-fatal (merge itself is done, don't block the success redirect).
    try {
      await distress.scoreProperty(keepId);
    } catch (e) {
      console.error(`[duplicates/merge] post-merge scoreProperty(${keepId}) failed:`, e.message);
    }

    const summary = `Merged ${dropIds.length} record(s) into property #${keepId}. Moved ${movedLists} list(s), ${movedContacts} contact(s). Deleted: #${dropIds.join(', #')}`;
    console.log('[duplicates/merge]', summary);
    res.redirect('/records/_duplicates?msg=' + encodeURIComponent(summary));
  } catch(e) {
    console.error('[duplicates/merge]', e);
    res.redirect('/records/_duplicates?err=' + encodeURIComponent('Merge failed: ' + e.message));
  }
});

// POST /records/_duplicates/merge_all — finds and merges every duplicate group
// in one shot. Same logic as single merge, just iterated. Capped at 500 groups
// per request to avoid Express timeouts.
// 2026-04-20 pass 12: merge_all concurrency guard. Pre-pass-12 two
// simultaneous requests both ran the full merge sequence; the second one
// tried to touch properties the first had already deleted, producing FK-
// violation noise in logs. A module-level flag suffices since node is
// single-threaded per process and merge_all is a big synchronous-ish
// job (typically 30-60s per the UI copy).
let _mergeAllRunning = false;

router.post('/_duplicates/merge_all', requireAuth, async (req, res) => {
  if (_mergeAllRunning) {
    return res.redirect('/records/_duplicates?err=' + encodeURIComponent('Another merge_all is already running. Wait for it to finish and try again.'));
  }
  _mergeAllRunning = true;
  try {
    const startedAt = Date.now();
    // 2026-04-18 audit fix #37: previously grouped by LOWER(TRIM(street)) —
    // the old normalization. The GET /_duplicates page (fix #22) uses
    // street_normalized, so the UI showed one set of groups and the POST
    // handler merged a different set. Now both sides use the same key.
    // COALESCE defensive fallback for any row where the generated column
    // hasn't been populated yet.
    const groupsRes = await query(`
      WITH normalized AS (
        SELECT
          id,
          COALESCE(
            street_normalized,
            LOWER(REGEXP_REPLACE(REGEXP_REPLACE(TRIM(COALESCE(street,'')), '[.,]+', '', 'g'), '\\s+', ' ', 'g'))
          )                                    AS k_street,
          LOWER(TRIM(city))                    AS k_city,
          UPPER(TRIM(state_code))              AS k_state,
          SUBSTRING(TRIM(zip_code) FROM 1 FOR 5) AS k_zip
        FROM properties
        WHERE street IS NOT NULL AND street != ''
          AND city IS NOT NULL AND city != ''
          AND state_code IS NOT NULL AND state_code != ''
      )
      SELECT
        ARRAY_AGG(id ORDER BY id ASC) AS ids
      FROM normalized
      WHERE k_zip IS NOT NULL AND k_zip != ''
      GROUP BY k_street, k_city, k_state, k_zip
      HAVING COUNT(*) > 1
      ORDER BY COUNT(*) DESC
      LIMIT 500
    `);

    // Gate: if merging 10+ groups, require the delete code
    if (groupsRes.rows.length >= 10) {
      const verified = await settings.verifyDeleteCode(req.body.code);
      if (!verified) {
        return res.redirect('/records/_duplicates?err=' + encodeURIComponent(`Delete code required for bulk merge of ${groupsRes.rows.length} groups. Enter code and try again.`));
      }
    }

    let groupsMerged = 0, totalDropped = 0, totalMovedLists = 0, totalMovedContacts = 0;
    const errors = [];
    const recomputeIds = [];

    for (const g of groupsRes.rows) {
      const keepId = g.ids[0];
      const dropIds = g.ids.slice(1);
      try {
        const lr = await query(`
          INSERT INTO property_lists (property_id, list_id, added_at)
          SELECT $1, list_id, MIN(added_at)
          FROM property_lists
          WHERE property_id = ANY($2::int[])
            AND list_id NOT IN (SELECT list_id FROM property_lists WHERE property_id = $1)
          GROUP BY list_id
          RETURNING list_id
        `, [keepId, dropIds]);
        totalMovedLists += lr.rowCount || 0;

        // 2026-04-18 audit fix #38: previously used BOOL_OR(primary_contact)
        // which could produce TRUE when the keep property already had a
        // primary, violating the idx_property_contacts_single_primary partial
        // unique index from fix #17. The error was caught and logged but
        // every affected group failed entirely — dropped records stayed
        // around as orphan duplicates, lists weren't moved. Now mirrors the
        // single-merge fix: check whether keep already has a primary and
        // assign primary_contact = false for all incoming rows if it does.
        const keepHasPrimaryRes = await query(
          `SELECT 1 FROM property_contacts WHERE property_id = $1 AND primary_contact = true LIMIT 1`,
          [keepId]
        );
        const keepHasPrimary = keepHasPrimaryRes.rows.length > 0;

        const cr = await query(`
          INSERT INTO property_contacts (property_id, contact_id, primary_contact)
          SELECT $1, contact_id, ${keepHasPrimary ? 'false' : 'BOOL_OR(primary_contact)'}
          FROM property_contacts
          WHERE property_id = ANY($2::int[])
            AND contact_id NOT IN (SELECT contact_id FROM property_contacts WHERE property_id = $1)
          GROUP BY contact_id
          RETURNING contact_id
        `, [keepId, dropIds]);
        totalMovedContacts += cr.rowCount || 0;

        // 2026-04-20 pass 12: reparent history to the keeper before deleting
        // dropped properties. Same fix as the single-merge path above —
        // without it, any duplicate with a deal/call_log/sms_log/filtration
        // record blew up the DELETE with an FK violation, leaving the group's
        // merge half-complete (list memberships moved but dropped properties
        // still present). Now history consolidates onto the keeper.
        await query(`UPDATE call_logs          SET property_id = $1 WHERE property_id = ANY($2::int[])`, [keepId, dropIds]);
        await query(`UPDATE sms_logs           SET property_id = $1 WHERE property_id = ANY($2::int[])`, [keepId, dropIds]);
        await query(`UPDATE filtration_results SET property_id = $1 WHERE property_id = ANY($2::int[])`, [keepId, dropIds]);
        await query(`UPDATE marketing_touches  SET property_id = $1 WHERE property_id = ANY($2::int[])`, [keepId, dropIds]);
        await query(`UPDATE deals              SET property_id = $1 WHERE property_id = ANY($2::int[])`, [keepId, dropIds]);

        await query(`DELETE FROM property_lists    WHERE property_id = ANY($1::int[])`, [dropIds]);
        await query(`DELETE FROM property_contacts WHERE property_id = ANY($1::int[])`, [dropIds]);
        await query(`DELETE FROM properties        WHERE id = ANY($1::int[])`, [dropIds]);

        groupsMerged++;
        totalDropped += dropIds.length;
        recomputeIds.push(keepId);
      } catch (e) {
        console.error(`[duplicates/merge_all] failed for keepId=${keepId}:`, e.message);
        errors.push(`#${keepId}: ${e.message}`);
      }
    }

    // Bulk rescore all kept properties at the end
    try {
      if (recomputeIds.length > 0) await distress.scoreProperties(recomputeIds);
    } catch(e) { console.error('[duplicates/merge_all] rescore failed:', e.message); }

    // 2026-04-18 audit fix #35: merges consolidate properties, which changes
    // the owned_count aggregation. Refresh the MV so the Min/Max Owned filter
    // stays accurate. Non-fatal.
    try {
      const { refreshOwnerPortfolioMv } = require('../db');
      await refreshOwnerPortfolioMv();
    } catch (e) {
      console.error('[duplicates/merge_all] MV refresh failed (non-fatal):', e.message);
    }

    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const summary = `Merged ${groupsMerged} group(s) in ${elapsed}s. Deleted ${totalDropped} duplicates. Moved ${totalMovedLists} list link(s), ${totalMovedContacts} contact link(s).${errors.length > 0 ? ' Errors: ' + errors.length : ''}`;
    console.log('[duplicates/merge_all]', summary);
    res.redirect('/records/_duplicates?msg=' + encodeURIComponent(summary));
  } catch(e) {
    console.error('[duplicates/merge_all]', e);
    res.redirect('/records/_duplicates?err=' + encodeURIComponent('Bulk merge failed: ' + e.message));
  } finally {
    _mergeAllRunning = false;
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// DELETE RECORDS — bulk + single
// Gated by the delete code from app_settings. Required for:
//   - POST /records/delete              (bulk — any count)
//   - POST /records/:id(\d+)/delete     (single — to keep flow consistent)
// Returns JSON so the frontend can show inline errors.
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/delete', requireAuth, async (req, res) => {
  try {
    const { ids, selectAll, filterParams, code } = req.body;

    // Verify delete code BEFORE touching any data
    const verified = await settings.verifyDeleteCode(code);
    if (!verified) {
      return res.status(403).json({ error: 'Invalid delete code.' });
    }

    let idsToDelete = [];
    if (selectAll) {
      // Rebuild the same filter conditions as the records list, then SELECT
      // matching IDs. Mirrors the export route's selectAll logic.
      const qs = new URLSearchParams(filterParams || '');
      let conditions = [], params = [], idx = 1;
      const qv = (k) => qs.get(k) || '';
      const qvAll = (k) => qs.getAll(k).filter(v => v && String(v).trim() !== '');

      if (qv('q')) {
        conditions.push(`(p.street ILIKE $${idx} OR p.city ILIKE $${idx} OR c.first_name ILIKE $${idx} OR c.last_name ILIKE $${idx})`);
        params.push(`%${qv('q')}%`); idx++;
      }
      const stateArr = qvAll('state').map(s => String(s).toUpperCase());
      if (stateArr.length > 0) {
        conditions.push(`p.state_code = ANY($${idx}::text[])`);
        params.push(stateArr); idx++;
      }
      const splitCsv = (raw) => !raw ? [] : String(raw).split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
      const cityArr   = splitCsv(qv('city'));
      const zipArr    = splitCsv(qv('zip'));
      const countyArr = splitCsv(qv('county'));
      if (cityArr.length > 0) {
        const o = cityArr.map(() => `p.city ILIKE $${idx++}`);
        conditions.push(`(${o.join(' OR ')})`);
        cityArr.forEach(c => params.push(`%${c}%`));
      }
      if (zipArr.length > 0) {
        const o = zipArr.map(() => `p.zip_code ILIKE $${idx++}`);
        conditions.push(`(${o.join(' OR ')})`);
        zipArr.forEach(z => params.push(`${z}%`));
      }
      if (countyArr.length > 0) {
        const o = countyArr.map(() => `p.county ILIKE $${idx++}`);
        conditions.push(`(${o.join(' OR ')})`);
        countyArr.forEach(c => params.push(`%${c}%`));
      }
      if (qv('type'))        { conditions.push(`p.property_type = $${idx}`);     params.push(qv('type')); idx++; }
      if (qv('pipeline'))    { conditions.push(`p.pipeline_stage = $${idx}`);    params.push(qv('pipeline')); idx++; }
      if (qv('prop_status')) { conditions.push(`p.property_status = $${idx}`);   params.push(qv('prop_status')); idx++; }
      if (qv('mkt_result'))  { conditions.push(`(
        EXISTS (
          SELECT 1 FROM campaign_contacts cc_mkt
          WHERE cc_mkt.property_address_normalized = p.street_normalized
            AND UPPER(TRIM(cc_mkt.property_state)) = UPPER(TRIM(p.state_code))
            AND cc_mkt.marketing_result IS NOT NULL
            AND split_part(cc_mkt.marketing_result, ' — ', 1) = ANY($${idx}::text[])
        )
        OR EXISTS (
          SELECT 1 FROM campaign_numbers cn_mkt
          JOIN phones ph_mkt ON ph_mkt.phone_number = cn_mkt.phone_number
          JOIN property_contacts pc_mkt ON pc_mkt.contact_id = ph_mkt.contact_id AND pc_mkt.property_id = p.id
          WHERE cn_mkt.marketing_result IS NOT NULL
            AND split_part(cn_mkt.marketing_result, ' — ', 1) = ANY($${idx}::text[])
        )
      )`); params.push([qv('mkt_result')]); idx++; }
      const mktIncArr = qvAll('mkt_include');
      const mktExcArr = qvAll('mkt_exclude');
      if (mktIncArr.length > 0) {
        conditions.push(`(
        EXISTS (
          SELECT 1 FROM campaign_contacts cc_mkt
          WHERE cc_mkt.property_address_normalized = p.street_normalized
            AND UPPER(TRIM(cc_mkt.property_state)) = UPPER(TRIM(p.state_code))
            AND cc_mkt.marketing_result IS NOT NULL
            AND split_part(cc_mkt.marketing_result, ' — ', 1) = ANY($${idx}::text[])
        )
        OR EXISTS (
          SELECT 1 FROM campaign_numbers cn_mkt
          JOIN phones ph_mkt ON ph_mkt.phone_number = cn_mkt.phone_number
          JOIN property_contacts pc_mkt ON pc_mkt.contact_id = ph_mkt.contact_id AND pc_mkt.property_id = p.id
          WHERE cn_mkt.marketing_result IS NOT NULL
            AND split_part(cn_mkt.marketing_result, ' — ', 1) = ANY($${idx}::text[])
        )
      )`);
        params.push(mktIncArr); idx++;
      }
      if (mktExcArr.length > 0) {
        conditions.push(`NOT (
        EXISTS (
          SELECT 1 FROM campaign_contacts cc_mkt
          WHERE cc_mkt.property_address_normalized = p.street_normalized
            AND UPPER(TRIM(cc_mkt.property_state)) = UPPER(TRIM(p.state_code))
            AND cc_mkt.marketing_result IS NOT NULL
            AND split_part(cc_mkt.marketing_result, ' — ', 1) = ANY($${idx}::text[])
        )
        OR EXISTS (
          SELECT 1 FROM campaign_numbers cn_mkt
          JOIN phones ph_mkt ON ph_mkt.phone_number = cn_mkt.phone_number
          JOIN property_contacts pc_mkt ON pc_mkt.contact_id = ph_mkt.contact_id AND pc_mkt.property_id = p.id
          WHERE cn_mkt.marketing_result IS NOT NULL
            AND split_part(cn_mkt.marketing_result, ' — ', 1) = ANY($${idx}::text[])
        )
      )`);
        params.push(mktExcArr); idx++;
      }
      if (qv('min_assessed')){ conditions.push(`p.assessed_value >= $${idx}`);   params.push(qv('min_assessed')); idx++; }
      if (qv('max_assessed')){ conditions.push(`p.assessed_value <= $${idx}`);   params.push(qv('max_assessed')); idx++; }
      if (qv('min_equity'))  { conditions.push(`p.equity_percent >= $${idx}`);   params.push(qv('min_equity')); idx++; }
      if (qv('max_equity'))  { conditions.push(`p.equity_percent <= $${idx}`);   params.push(qv('max_equity')); idx++; }
      if (qv('min_year'))    { conditions.push(`p.year_built >= $${idx}`);       params.push(qv('min_year')); idx++; }
      if (qv('max_year'))    { conditions.push(`p.year_built <= $${idx}`);       params.push(qv('max_year')); idx++; }
      if (qv('upload_from')) { conditions.push(`p.created_at >= $${idx}`);       params.push(qv('upload_from')); idx++; }
      if (qv('upload_to'))   { conditions.push(`p.created_at <= $${idx}`);       params.push(qv('upload_to') + ' 23:59:59'); idx++; }
      if (qv('list_id'))     { conditions.push(`EXISTS (SELECT 1 FROM property_lists pl2 WHERE pl2.property_id = p.id AND pl2.list_id = $${idx})`); params.push(qv('list_id')); idx++; }
      const stackArr = qvAll('stack_list').map(v => parseInt(v)).filter(n => !isNaN(n));
      if (stackArr.length > 0) {
        conditions.push(
          `(SELECT COUNT(DISTINCT pl_stack.list_id)
              FROM property_lists pl_stack
             WHERE pl_stack.property_id = p.id
               AND pl_stack.list_id = ANY($${idx}::int[])) = $${idx+1}`
        );
        params.push(stackArr);
        params.push(stackArr.length);
        idx += 2;
      }
      if (qv('min_stack'))   { conditions.push(`(SELECT COUNT(*) FROM property_lists plc WHERE plc.property_id = p.id) >= $${idx}`); params.push(parseInt(qv('min_stack'))); idx++; }
      if (qv('min_distress')){ conditions.push(`p.distress_score >= $${idx}`);   params.push(parseInt(qv('min_distress'))); idx++; }
      // Phones filter — mirror list route so a delete targeted at "No phones"
      // doesn't sweep records that DO have phones.
      const phonesDel = qv('phones');
      if (phonesDel === 'has') {
        conditions.push(`EXISTS (SELECT 1 FROM phones ph_f JOIN property_contacts pc_f ON pc_f.contact_id = ph_f.contact_id WHERE pc_f.property_id = p.id)`);
      } else if (phonesDel === 'none') {
        conditions.push(`NOT EXISTS (SELECT 1 FROM phones ph_f JOIN property_contacts pc_f ON pc_f.contact_id = ph_f.contact_id WHERE pc_f.property_id = p.id)`);
      }

      // Owner Occupancy — must match the same logic as the records list route.
      // Without this, a user filtering by "Absent Owner" and clicking Select All
      // would unintentionally delete records across ALL occupancy buckets.
      const NORM_ADDR_DEL = (col) => `
        REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(
        REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(
          LOWER(REGEXP_REPLACE(TRIM(${col}), '[.,]+', '', 'g')),
          '\\ystreet\\y',  'st',   'g'),
          '\\yavenue\\y',  'ave',  'g'),
          '\\ydrive\\y',   'dr',   'g'),
          '\\yboulevard\\y','blvd', 'g'),
          '\\yroad\\y',    'rd',   'g'),
          '\\ylane\\y',    'ln',   'g'),
          '\\ycourt\\y',   'ct',   'g'),
          '\\yplace\\y',   'pl',   'g'),
          '\\ycircle\\y',  'cir',  'g'),
          '\\yterrace\\y', 'ter',  'g'),
          '\\yparkway\\y', 'pkwy', 'g'),
          '\\yhighway\\y', 'hwy',  'g'),
          '\\s+', ' ', 'g')`;
      const occDel = qv('occupancy');
      if (occDel === 'owner_occupied') {
        conditions.push(`(c.mailing_address IS NOT NULL
          AND ${NORM_ADDR_DEL('p.street')} = ${NORM_ADDR_DEL('c.mailing_address')}
          AND LOWER(TRIM(p.city)) = LOWER(TRIM(c.mailing_city))
          AND UPPER(TRIM(p.state_code)) = UPPER(TRIM(c.mailing_state))
          AND SUBSTRING(TRIM(p.zip_code) FROM 1 FOR 5) = SUBSTRING(TRIM(c.mailing_zip) FROM 1 FOR 5))`);
      } else if (occDel === 'absent_owner') {
        conditions.push(`(c.mailing_address IS NOT NULL AND TRIM(c.mailing_address) != ''
          AND NOT (
            ${NORM_ADDR_DEL('p.street')} = ${NORM_ADDR_DEL('c.mailing_address')}
            AND LOWER(TRIM(p.city)) = LOWER(TRIM(c.mailing_city))
            AND UPPER(TRIM(p.state_code)) = UPPER(TRIM(c.mailing_state))
            AND SUBSTRING(TRIM(p.zip_code) FROM 1 FOR 5) = SUBSTRING(TRIM(c.mailing_zip) FROM 1 FOR 5)
          ))`);
      } else if (occDel === 'unknown') {
        conditions.push(`(c.mailing_address IS NULL OR TRIM(c.mailing_address) = '')`);
      }
      // Properties-owned filter — mirror list route logic
      const minOwnedDel = qv('min_owned'), maxOwnedDel = qv('max_owned');
      if (minOwnedDel || maxOwnedDel) {
        const ownedSubDel = `
          CASE WHEN c.mailing_address IS NULL OR TRIM(c.mailing_address) = '' THEN 1
          ELSE (
            SELECT COUNT(*)
            FROM properties p2
            JOIN property_contacts pc2 ON pc2.property_id = p2.id AND pc2.primary_contact = true
            JOIN contacts c2 ON c2.id = pc2.contact_id
            WHERE c2.mailing_address IS NOT NULL AND TRIM(c2.mailing_address) != ''
              AND ${NORM_ADDR_DEL('c2.mailing_address')} = ${NORM_ADDR_DEL('c.mailing_address')}
              AND LOWER(TRIM(c2.mailing_city)) = LOWER(TRIM(c.mailing_city))
              AND UPPER(TRIM(p2.state_code)) = UPPER(TRIM(p.state_code))
              AND SUBSTRING(TRIM(c2.mailing_zip) FROM 1 FOR 5) = SUBSTRING(TRIM(c.mailing_zip) FROM 1 FOR 5)
          ) END`;
        if (minOwnedDel) { conditions.push(`${ownedSubDel} >= $${idx}`); params.push(parseInt(minOwnedDel)); idx++; }
        if (maxOwnedDel) { conditions.push(`${ownedSubDel} <= $${idx}`); params.push(parseInt(maxOwnedDel)); idx++; }
      }
      // Tag filter
      if (qv('tag')) {
        conditions.push(`EXISTS (SELECT 1 FROM property_tags pt_f WHERE pt_f.property_id = p.id AND pt_f.tag_id = $${idx})`);
        params.push(parseInt(qv('tag'))); idx++;
      }

      const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
      const idsRes = await query(`
        SELECT DISTINCT p.id
        FROM properties p
        LEFT JOIN property_contacts pc ON pc.property_id = p.id AND pc.primary_contact = true
        LEFT JOIN contacts c ON c.id = pc.contact_id
        ${where}
      `, params);
      idsToDelete = idsRes.rows.map(r => r.id);
    } else {
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: 'No records selected.' });
      }
      idsToDelete = ids.map(n => parseInt(n)).filter(n => !isNaN(n) && n > 0);
    }

    if (idsToDelete.length === 0) {
      return res.status(400).json({ error: 'No valid records to delete.' });
    }

    // 2026-04-20 pass 12: Pre-pass-12 this only deleted property_lists and
    // property_contacts. But properties are also referenced without CASCADE
    // by: call_logs.property_id, sms_logs.property_id, deals.property_id,
    // filtration_results.property_id, marketing_touches.property_id. Any
    // property with call history, SMS history, or a deal attached would
    // block the DELETE with a FK-violation 500. We set those references to
    // NULL (preserves the history row, just detaches it from a property
    // that's going away) then delete. deals.property_id is NOT NULL so we
    // have to delete deal rows outright — acceptable because a deal on a
    // property the operator is deleting is almost certainly a test deal or
    // stale lead, and the delete code is gated behind settings.verifyDeleteCode.
    await query(`UPDATE call_logs          SET property_id = NULL WHERE property_id = ANY($1::int[])`, [idsToDelete]);
    await query(`UPDATE sms_logs           SET property_id = NULL WHERE property_id = ANY($1::int[])`, [idsToDelete]);
    await query(`UPDATE filtration_results SET property_id = NULL WHERE property_id = ANY($1::int[])`, [idsToDelete]);
    await query(`UPDATE marketing_touches  SET property_id = NULL WHERE property_id = ANY($1::int[])`, [idsToDelete]);
    await query(`DELETE FROM deals                           WHERE property_id = ANY($1::int[])`, [idsToDelete]);
    // Distress logs cascade via FK so they clean up automatically.
    await query(`DELETE FROM property_lists    WHERE property_id = ANY($1::int[])`, [idsToDelete]);
    await query(`DELETE FROM property_contacts WHERE property_id = ANY($1::int[])`, [idsToDelete]);
    const result = await query(`DELETE FROM properties WHERE id = ANY($1::int[]) RETURNING id`, [idsToDelete]);

    // Refresh owner_portfolio_counts MV — deleting a property changes the
    // owned-count for every remaining property owned by the same person.
    try {
      const { refreshOwnerPortfolioMv } = require('../db');
      await refreshOwnerPortfolioMv();
    } catch (e) {
      console.error('[records/delete] MV refresh failed (non-fatal):', e.message);
    }

    console.log(`[records/delete] Deleted ${result.rowCount} properties`);
    res.json({ ok: true, deleted: result.rowCount });
  } catch (e) {
    console.error('[records/delete]', e);
    res.status(500).json({ error: 'Delete failed: ' + e.message });
  }
});

router.post('/:id(\\d+)/delete', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { code } = req.body;
    const verified = await settings.verifyDeleteCode(code);
    if (!verified) {
      return res.status(403).json({ error: 'Invalid delete code.' });
    }
    // 2026-04-20 pass 12: same FK-dependent cleanup as bulk delete above.
    // See comment there for rationale.
    await query(`UPDATE call_logs          SET property_id = NULL WHERE property_id = $1`, [id]);
    await query(`UPDATE sms_logs           SET property_id = NULL WHERE property_id = $1`, [id]);
    await query(`UPDATE filtration_results SET property_id = NULL WHERE property_id = $1`, [id]);
    await query(`UPDATE marketing_touches  SET property_id = NULL WHERE property_id = $1`, [id]);
    await query(`DELETE FROM deals                           WHERE property_id = $1`, [id]);
    await query(`DELETE FROM property_lists    WHERE property_id = $1`, [id]);
    await query(`DELETE FROM property_contacts WHERE property_id = $1`, [id]);
    const r = await query(`DELETE FROM properties WHERE id = $1 RETURNING id`, [id]);
    if (!r.rowCount) {
      return res.status(404).json({ error: 'Record not found.' });
    }
    try {
      const { refreshOwnerPortfolioMv } = require('../db');
      await refreshOwnerPortfolioMv();
    } catch (e) {
      console.error('[records/:id/delete] MV refresh failed (non-fatal):', e.message);
    }
    console.log(`[records/delete] Deleted single property #${id}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[records/:id/delete]', e);
    res.status(500).json({ error: 'Delete failed: ' + e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// BULK TAG — POST /records/bulk-tag
// Add or remove tags from multiple selected properties at once.
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/bulk-tag', requireAuth, async (req, res) => {
  try {
    await ensureTagSchema();
    const { ids, selectAll, filterParams, mode, tagNames, tagIds } = req.body;

    // Resolve property IDs — same selectAll filter-rebuild as other bulk routes
    let propertyIds = [];
    if (selectAll) {
      const qs = new URLSearchParams(filterParams || '');
      let conditions = [], params = [], idx = 1;
      const qv = (k) => qs.get(k) || '';
      const qvAll = (k) => qs.getAll(k).filter(v => v && String(v).trim() !== '');

      if (qv('q')) {
        conditions.push(`(p.street ILIKE $${idx} OR p.city ILIKE $${idx} OR c.first_name ILIKE $${idx} OR c.last_name ILIKE $${idx})`);
        params.push(`%${qv('q')}%`); idx++;
      }
      const stateArr = qvAll('state').map(s => String(s).toUpperCase());
      if (stateArr.length > 0) { conditions.push(`p.state_code = ANY($${idx}::text[])`); params.push(stateArr); idx++; }
      const splitCsv = (raw) => !raw ? [] : String(raw).split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
      const cityArr = splitCsv(qv('city')), zipArr = splitCsv(qv('zip')), countyArr = splitCsv(qv('county'));
      if (cityArr.length > 0)   { const o = cityArr.map(() => `p.city ILIKE $${idx++}`); conditions.push(`(${o.join(' OR ')})`); cityArr.forEach(c => params.push(`%${c}%`)); }
      if (zipArr.length > 0)    { const o = zipArr.map(() => `p.zip_code ILIKE $${idx++}`); conditions.push(`(${o.join(' OR ')})`); zipArr.forEach(z => params.push(`${z}%`)); }
      if (countyArr.length > 0) { const o = countyArr.map(() => `p.county ILIKE $${idx++}`); conditions.push(`(${o.join(' OR ')})`); countyArr.forEach(c => params.push(`%${c}%`)); }
      if (qv('type'))        { conditions.push(`p.property_type = $${idx}`);   params.push(qv('type')); idx++; }
      if (qv('pipeline'))    { conditions.push(`p.pipeline_stage = $${idx}`);  params.push(qv('pipeline')); idx++; }
      if (qv('prop_status')) { conditions.push(`p.property_status = $${idx}`); params.push(qv('prop_status')); idx++; }
      if (qv('mkt_result'))  { conditions.push(`(
        EXISTS (
          SELECT 1 FROM campaign_contacts cc_mkt
          WHERE cc_mkt.property_address_normalized = p.street_normalized
            AND UPPER(TRIM(cc_mkt.property_state)) = UPPER(TRIM(p.state_code))
            AND cc_mkt.marketing_result IS NOT NULL
            AND split_part(cc_mkt.marketing_result, ' — ', 1) = ANY($${idx}::text[])
        )
        OR EXISTS (
          SELECT 1 FROM campaign_numbers cn_mkt
          JOIN phones ph_mkt ON ph_mkt.phone_number = cn_mkt.phone_number
          JOIN property_contacts pc_mkt ON pc_mkt.contact_id = ph_mkt.contact_id AND pc_mkt.property_id = p.id
          WHERE cn_mkt.marketing_result IS NOT NULL
            AND split_part(cn_mkt.marketing_result, ' — ', 1) = ANY($${idx}::text[])
        )
      )`);params.push([qv('mkt_result')]); idx++; }
      const mktIncArr = qvAll('mkt_include'), mktExcArr = qvAll('mkt_exclude');
      if (mktIncArr.length > 0) { conditions.push(`(
        EXISTS (
          SELECT 1 FROM campaign_contacts cc_mkt
          WHERE cc_mkt.property_address_normalized = p.street_normalized
            AND UPPER(TRIM(cc_mkt.property_state)) = UPPER(TRIM(p.state_code))
            AND cc_mkt.marketing_result IS NOT NULL
            AND split_part(cc_mkt.marketing_result, ' — ', 1) = ANY($${idx}::text[])
        )
        OR EXISTS (
          SELECT 1 FROM campaign_numbers cn_mkt
          JOIN phones ph_mkt ON ph_mkt.phone_number = cn_mkt.phone_number
          JOIN property_contacts pc_mkt ON pc_mkt.contact_id = ph_mkt.contact_id AND pc_mkt.property_id = p.id
          WHERE cn_mkt.marketing_result IS NOT NULL
            AND split_part(cn_mkt.marketing_result, ' — ', 1) = ANY($${idx}::text[])
        )
      )`); params.push(mktIncArr); idx++; }
      if (mktExcArr.length > 0) { conditions.push(`NOT (
        EXISTS (
          SELECT 1 FROM campaign_contacts cc_mkt
          WHERE cc_mkt.property_address_normalized = p.street_normalized
            AND UPPER(TRIM(cc_mkt.property_state)) = UPPER(TRIM(p.state_code))
            AND cc_mkt.marketing_result IS NOT NULL
            AND split_part(cc_mkt.marketing_result, ' — ', 1) = ANY($${idx}::text[])
        )
        OR EXISTS (
          SELECT 1 FROM campaign_numbers cn_mkt
          JOIN phones ph_mkt ON ph_mkt.phone_number = cn_mkt.phone_number
          JOIN property_contacts pc_mkt ON pc_mkt.contact_id = ph_mkt.contact_id AND pc_mkt.property_id = p.id
          WHERE cn_mkt.marketing_result IS NOT NULL
            AND split_part(cn_mkt.marketing_result, ' — ', 1) = ANY($${idx}::text[])
        )
      )`); params.push(mktExcArr); idx++; }
      if (qv('min_assessed')){ conditions.push(`p.assessed_value >= $${idx}`);   params.push(qv('min_assessed')); idx++; }
      if (qv('max_assessed')){ conditions.push(`p.assessed_value <= $${idx}`);   params.push(qv('max_assessed')); idx++; }
      if (qv('min_equity'))  { conditions.push(`p.equity_percent >= $${idx}`);   params.push(qv('min_equity')); idx++; }
      if (qv('max_equity'))  { conditions.push(`p.equity_percent <= $${idx}`);   params.push(qv('max_equity')); idx++; }
      if (qv('min_year'))    { conditions.push(`p.year_built >= $${idx}`);       params.push(qv('min_year')); idx++; }
      if (qv('max_year'))    { conditions.push(`p.year_built <= $${idx}`);       params.push(qv('max_year')); idx++; }
      if (qv('upload_from')) { conditions.push(`p.created_at >= $${idx}`);       params.push(qv('upload_from')); idx++; }
      if (qv('upload_to'))   { conditions.push(`p.created_at <= $${idx}`);       params.push(qv('upload_to') + ' 23:59:59'); idx++; }
      if (qv('list_id'))     { conditions.push(`EXISTS (SELECT 1 FROM property_lists pl2 WHERE pl2.property_id = p.id AND pl2.list_id = $${idx})`); params.push(qv('list_id')); idx++; }
      const stackArr = qvAll('stack_list').map(v => parseInt(v)).filter(n => !isNaN(n));
      if (stackArr.length > 0) {
        conditions.push(`(SELECT COUNT(DISTINCT pl_stack.list_id) FROM property_lists pl_stack WHERE pl_stack.property_id = p.id AND pl_stack.list_id = ANY($${idx}::int[])) = $${idx+1}`);
        params.push(stackArr); params.push(stackArr.length); idx += 2;
      }
      if (qv('min_stack'))   { conditions.push(`(SELECT COUNT(*) FROM property_lists plc WHERE plc.property_id = p.id) >= $${idx}`); params.push(parseInt(qv('min_stack'))); idx++; }
      if (qv('min_distress')){ conditions.push(`p.distress_score >= $${idx}`);   params.push(parseInt(qv('min_distress'))); idx++; }
      const phonesBt = qv('phones');
      if (phonesBt === 'has') { conditions.push(`EXISTS (SELECT 1 FROM phones ph_f JOIN property_contacts pc_f ON pc_f.contact_id = ph_f.contact_id WHERE pc_f.property_id = p.id)`); }
      else if (phonesBt === 'none') { conditions.push(`NOT EXISTS (SELECT 1 FROM phones ph_f JOIN property_contacts pc_f ON pc_f.contact_id = ph_f.contact_id WHERE pc_f.property_id = p.id)`); }

      // Owner Occupancy — mirror list route
      const NORM_ADDR_BT = (col) => `
        REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(
        REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(
          LOWER(REGEXP_REPLACE(TRIM(${col}), '[.,]+', '', 'g')),
          '\\ystreet\\y',  'st',   'g'),
          '\\yavenue\\y',  'ave',  'g'),
          '\\ydrive\\y',   'dr',   'g'),
          '\\yboulevard\\y','blvd', 'g'),
          '\\yroad\\y',    'rd',   'g'),
          '\\ylane\\y',    'ln',   'g'),
          '\\ycourt\\y',   'ct',   'g'),
          '\\yplace\\y',   'pl',   'g'),
          '\\ycircle\\y',  'cir',  'g'),
          '\\yterrace\\y', 'ter',  'g'),
          '\\yparkway\\y', 'pkwy', 'g'),
          '\\yhighway\\y', 'hwy',  'g'),
          '\\s+', ' ', 'g')`;
      const occBt = qv('occupancy');
      if (occBt === 'owner_occupied') {
        conditions.push(`(c.mailing_address IS NOT NULL
          AND ${NORM_ADDR_BT('p.street')} = ${NORM_ADDR_BT('c.mailing_address')}
          AND LOWER(TRIM(p.city)) = LOWER(TRIM(c.mailing_city))
          AND UPPER(TRIM(p.state_code)) = UPPER(TRIM(c.mailing_state))
          AND SUBSTRING(TRIM(p.zip_code) FROM 1 FOR 5) = SUBSTRING(TRIM(c.mailing_zip) FROM 1 FOR 5))`);
      } else if (occBt === 'absent_owner') {
        conditions.push(`(c.mailing_address IS NOT NULL AND TRIM(c.mailing_address) != ''
          AND NOT (
            ${NORM_ADDR_BT('p.street')} = ${NORM_ADDR_BT('c.mailing_address')}
            AND LOWER(TRIM(p.city)) = LOWER(TRIM(c.mailing_city))
            AND UPPER(TRIM(p.state_code)) = UPPER(TRIM(c.mailing_state))
            AND SUBSTRING(TRIM(p.zip_code) FROM 1 FOR 5) = SUBSTRING(TRIM(c.mailing_zip) FROM 1 FOR 5)
          ))`);
      } else if (occBt === 'unknown') {
        conditions.push(`(c.mailing_address IS NULL OR TRIM(c.mailing_address) = '')`);
      }
      // Properties-owned filter
      const minOwnedBt = qv('min_owned'), maxOwnedBt = qv('max_owned');
      if (minOwnedBt || maxOwnedBt) {
        const ownedSubBt = `
          CASE WHEN c.mailing_address IS NULL OR TRIM(c.mailing_address) = '' THEN 1
          ELSE (
            SELECT COUNT(*)
            FROM properties p2
            JOIN property_contacts pc2 ON pc2.property_id = p2.id AND pc2.primary_contact = true
            JOIN contacts c2 ON c2.id = pc2.contact_id
            WHERE c2.mailing_address IS NOT NULL AND TRIM(c2.mailing_address) != ''
              AND ${NORM_ADDR_BT('c2.mailing_address')} = ${NORM_ADDR_BT('c.mailing_address')}
              AND LOWER(TRIM(c2.mailing_city)) = LOWER(TRIM(c.mailing_city))
              AND UPPER(TRIM(p2.state_code)) = UPPER(TRIM(p.state_code))
              AND SUBSTRING(TRIM(c2.mailing_zip) FROM 1 FOR 5) = SUBSTRING(TRIM(c.mailing_zip) FROM 1 FOR 5)
          ) END`;
        if (minOwnedBt) { conditions.push(`${ownedSubBt} >= $${idx}`); params.push(parseInt(minOwnedBt)); idx++; }
        if (maxOwnedBt) { conditions.push(`${ownedSubBt} <= $${idx}`); params.push(parseInt(maxOwnedBt)); idx++; }
      }

      if (qv('tag')) { conditions.push(`EXISTS (SELECT 1 FROM property_tags pt_f WHERE pt_f.property_id = p.id AND pt_f.tag_id = $${idx})`); params.push(parseInt(qv('tag'))); idx++; }
      const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
      const idsRes = await query(`SELECT DISTINCT p.id FROM properties p LEFT JOIN property_contacts pc ON pc.property_id = p.id AND pc.primary_contact = true LEFT JOIN contacts c ON c.id = pc.contact_id ${where}`, params);
      propertyIds = idsRes.rows.map(r => r.id);
    } else {
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: 'No records selected.' });
      }
      propertyIds = ids.map(n => parseInt(n)).filter(n => !isNaN(n) && n > 0);
    }

    if (propertyIds.length === 0) {
      return res.status(400).json({ error: 'No valid properties found.' });
    }

    let affected = 0;

    if (mode === 'add') {
      if (!Array.isArray(tagNames) || tagNames.length === 0) {
        return res.status(400).json({ error: 'No tags specified.' });
      }
      // Resolve or create each tag
      const resolvedTags = [];
      for (const name of tagNames) {
        const trimmed = String(name).trim();
        if (!trimmed || trimmed.length > 100) continue;
        let tagRes = await query(`SELECT id FROM tags WHERE LOWER(name) = LOWER($1) LIMIT 1`, [trimmed]);
        if (!tagRes.rows.length) {
          try {
            tagRes = await query(`INSERT INTO tags (name) VALUES ($1) RETURNING id`, [trimmed]);
          } catch (e) {
            tagRes = await query(`SELECT id FROM tags WHERE LOWER(name) = LOWER($1) LIMIT 1`, [trimmed]);
          }
        }
        if (tagRes.rows.length) resolvedTags.push(tagRes.rows[0].id);
      }
      // Bulk insert property_tags via UNNEST
      for (const tagId of resolvedTags) {
        const r = await query(
          `INSERT INTO property_tags (property_id, tag_id)
           SELECT unnest($1::int[]), $2
           ON CONFLICT DO NOTHING`,
          [propertyIds, tagId]
        );
        affected += r.rowCount;
      }
      console.log(`[bulk-tag] Added ${resolvedTags.length} tag(s) to ${propertyIds.length} properties (${affected} new links)`);
    } else if (mode === 'remove') {
      if (!Array.isArray(tagIds) || tagIds.length === 0) {
        return res.status(400).json({ error: 'No tags specified.' });
      }
      const safeTagIds = tagIds.map(n => parseInt(n)).filter(n => !isNaN(n) && n > 0);
      const r = await query(
        `DELETE FROM property_tags
         WHERE property_id = ANY($1::int[])
           AND tag_id = ANY($2::int[])`,
        [propertyIds, safeTagIds]
      );
      affected = r.rowCount;
      console.log(`[bulk-tag] Removed ${safeTagIds.length} tag(s) from ${propertyIds.length} properties (${affected} links removed)`);
    } else {
      return res.status(400).json({ error: 'Invalid mode. Use "add" or "remove".' });
    }

    res.json({ ok: true, affected, propertyCount: propertyIds.length });
  } catch (e) {
    console.error('[bulk-tag]', e);
    res.status(500).json({ error: 'Bulk tag failed: ' + e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// REMOVE FROM LIST — POST /records/remove-from-list
// Detaches selected properties from a specific list without deleting the
// property records themselves. Code-gated. Properties remain in Loki with all
// their contacts, phones, and other list memberships intact — only the link to
// the specified list is removed.
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/remove-from-list', requireAuth, async (req, res) => {
  try {
    const { ids, selectAll, filterParams, listId, code } = req.body;

    // Verify delete code BEFORE touching any data
    const verified = await settings.verifyDeleteCode(code);
    if (!verified) {
      return res.status(403).json({ error: 'Invalid delete code.' });
    }

    const listIdInt = parseInt(listId);
    if (!listIdInt || isNaN(listIdInt)) {
      return res.status(400).json({ error: 'List ID required. Filter by a specific list first.' });
    }

    // Confirm the list exists — give a clearer error than "0 rows removed"
    const listCheck = await query(`SELECT id, list_name FROM lists WHERE id = $1`, [listIdInt]);
    if (!listCheck.rowCount) {
      return res.status(404).json({ error: 'List not found.' });
    }

    let idsToRemove = [];
    if (selectAll) {
      // Rebuild the same filter conditions as the records list. Mirrors the
      // delete route's selectAll logic exactly — keep them in sync.
      const qs = new URLSearchParams(filterParams || '');
      let conditions = [], params = [], idx = 1;
      const qv = (k) => qs.get(k) || '';
      const qvAll = (k) => qs.getAll(k).filter(v => v && String(v).trim() !== '');

      if (qv('q')) {
        conditions.push(`(p.street ILIKE $${idx} OR p.city ILIKE $${idx} OR c.first_name ILIKE $${idx} OR c.last_name ILIKE $${idx})`);
        params.push(`%${qv('q')}%`); idx++;
      }
      const stateArr = qvAll('state').map(s => String(s).toUpperCase());
      if (stateArr.length > 0) {
        conditions.push(`p.state_code = ANY($${idx}::text[])`);
        params.push(stateArr); idx++;
      }
      const splitCsv = (raw) => !raw ? [] : String(raw).split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
      const cityArr   = splitCsv(qv('city'));
      const zipArr    = splitCsv(qv('zip'));
      const countyArr = splitCsv(qv('county'));
      if (cityArr.length > 0) {
        const o = cityArr.map(() => `p.city ILIKE $${idx++}`);
        conditions.push(`(${o.join(' OR ')})`);
        cityArr.forEach(c => params.push(`%${c}%`));
      }
      if (zipArr.length > 0) {
        const o = zipArr.map(() => `p.zip_code ILIKE $${idx++}`);
        conditions.push(`(${o.join(' OR ')})`);
        zipArr.forEach(z => params.push(`${z}%`));
      }
      if (countyArr.length > 0) {
        const o = countyArr.map(() => `p.county ILIKE $${idx++}`);
        conditions.push(`(${o.join(' OR ')})`);
        countyArr.forEach(c => params.push(`%${c}%`));
      }
      if (qv('type'))        { conditions.push(`p.property_type = $${idx}`);     params.push(qv('type')); idx++; }
      if (qv('pipeline'))    { conditions.push(`p.pipeline_stage = $${idx}`);    params.push(qv('pipeline')); idx++; }
      if (qv('prop_status')) { conditions.push(`p.property_status = $${idx}`);   params.push(qv('prop_status')); idx++; }
      if (qv('mkt_result'))  { conditions.push(`(
        EXISTS (
          SELECT 1 FROM campaign_contacts cc_mkt
          WHERE cc_mkt.property_address_normalized = p.street_normalized
            AND UPPER(TRIM(cc_mkt.property_state)) = UPPER(TRIM(p.state_code))
            AND cc_mkt.marketing_result IS NOT NULL
            AND split_part(cc_mkt.marketing_result, ' — ', 1) = ANY($${idx}::text[])
        )
        OR EXISTS (
          SELECT 1 FROM campaign_numbers cn_mkt
          JOIN phones ph_mkt ON ph_mkt.phone_number = cn_mkt.phone_number
          JOIN property_contacts pc_mkt ON pc_mkt.contact_id = ph_mkt.contact_id AND pc_mkt.property_id = p.id
          WHERE cn_mkt.marketing_result IS NOT NULL
            AND split_part(cn_mkt.marketing_result, ' — ', 1) = ANY($${idx}::text[])
        )
      )`); params.push([qv('mkt_result')]); idx++; }
      const mktIncArr = qvAll('mkt_include');
      const mktExcArr = qvAll('mkt_exclude');
      if (mktIncArr.length > 0) {
        conditions.push(`(
        EXISTS (
          SELECT 1 FROM campaign_contacts cc_mkt
          WHERE cc_mkt.property_address_normalized = p.street_normalized
            AND UPPER(TRIM(cc_mkt.property_state)) = UPPER(TRIM(p.state_code))
            AND cc_mkt.marketing_result IS NOT NULL
            AND split_part(cc_mkt.marketing_result, ' — ', 1) = ANY($${idx}::text[])
        )
        OR EXISTS (
          SELECT 1 FROM campaign_numbers cn_mkt
          JOIN phones ph_mkt ON ph_mkt.phone_number = cn_mkt.phone_number
          JOIN property_contacts pc_mkt ON pc_mkt.contact_id = ph_mkt.contact_id AND pc_mkt.property_id = p.id
          WHERE cn_mkt.marketing_result IS NOT NULL
            AND split_part(cn_mkt.marketing_result, ' — ', 1) = ANY($${idx}::text[])
        )
      )`);
        params.push(mktIncArr); idx++;
      }
      if (mktExcArr.length > 0) {
        conditions.push(`NOT (
        EXISTS (
          SELECT 1 FROM campaign_contacts cc_mkt
          WHERE cc_mkt.property_address_normalized = p.street_normalized
            AND UPPER(TRIM(cc_mkt.property_state)) = UPPER(TRIM(p.state_code))
            AND cc_mkt.marketing_result IS NOT NULL
            AND split_part(cc_mkt.marketing_result, ' — ', 1) = ANY($${idx}::text[])
        )
        OR EXISTS (
          SELECT 1 FROM campaign_numbers cn_mkt
          JOIN phones ph_mkt ON ph_mkt.phone_number = cn_mkt.phone_number
          JOIN property_contacts pc_mkt ON pc_mkt.contact_id = ph_mkt.contact_id AND pc_mkt.property_id = p.id
          WHERE cn_mkt.marketing_result IS NOT NULL
            AND split_part(cn_mkt.marketing_result, ' — ', 1) = ANY($${idx}::text[])
        )
      )`);
        params.push(mktExcArr); idx++;
      }
      if (qv('min_assessed')){ conditions.push(`p.assessed_value >= $${idx}`);   params.push(qv('min_assessed')); idx++; }
      if (qv('max_assessed')){ conditions.push(`p.assessed_value <= $${idx}`);   params.push(qv('max_assessed')); idx++; }
      if (qv('min_equity'))  { conditions.push(`p.equity_percent >= $${idx}`);   params.push(qv('min_equity')); idx++; }
      if (qv('max_equity'))  { conditions.push(`p.equity_percent <= $${idx}`);   params.push(qv('max_equity')); idx++; }
      if (qv('min_year'))    { conditions.push(`p.year_built >= $${idx}`);       params.push(qv('min_year')); idx++; }
      if (qv('max_year'))    { conditions.push(`p.year_built <= $${idx}`);       params.push(qv('max_year')); idx++; }
      if (qv('upload_from')) { conditions.push(`p.created_at >= $${idx}`);       params.push(qv('upload_from')); idx++; }
      if (qv('upload_to'))   { conditions.push(`p.created_at <= $${idx}`);       params.push(qv('upload_to') + ' 23:59:59'); idx++; }
      // Force-scope to the list being operated on (critical correctness — we
      // should never remove-from-list for properties that aren't on that list).
      // The client-side filter already has list_id set, but we belt-and-suspender it.
      conditions.push(`EXISTS (SELECT 1 FROM property_lists pl2 WHERE pl2.property_id = p.id AND pl2.list_id = $${idx})`);
      params.push(listIdInt); idx++;

      const stackArr = qvAll('stack_list').map(v => parseInt(v)).filter(n => !isNaN(n));
      if (stackArr.length > 0) {
        conditions.push(
          `(SELECT COUNT(DISTINCT pl_stack.list_id)
              FROM property_lists pl_stack
             WHERE pl_stack.property_id = p.id
               AND pl_stack.list_id = ANY($${idx}::int[])) = $${idx+1}`
        );
        params.push(stackArr);
        params.push(stackArr.length);
        idx += 2;
      }
      if (qv('min_stack'))   { conditions.push(`(SELECT COUNT(*) FROM property_lists plc WHERE plc.property_id = p.id) >= $${idx}`); params.push(parseInt(qv('min_stack'))); idx++; }
      if (qv('min_distress')){ conditions.push(`p.distress_score >= $${idx}`);   params.push(parseInt(qv('min_distress'))); idx++; }
      const phonesRfl = qv('phones');
      if (phonesRfl === 'has') {
        conditions.push(`EXISTS (SELECT 1 FROM phones ph_f JOIN property_contacts pc_f ON pc_f.contact_id = ph_f.contact_id WHERE pc_f.property_id = p.id)`);
      } else if (phonesRfl === 'none') {
        conditions.push(`NOT EXISTS (SELECT 1 FROM phones ph_f JOIN property_contacts pc_f ON pc_f.contact_id = ph_f.contact_id WHERE pc_f.property_id = p.id)`);
      }

      // Owner Occupancy — mirror list route so a user filtering by "Absent Owner"
      // doesn't sweep owner-occupied properties off the list too.
      const NORM_ADDR_RFL = (col) => `
        REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(
        REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(
          LOWER(REGEXP_REPLACE(TRIM(${col}), '[.,]+', '', 'g')),
          '\\ystreet\\y',  'st',   'g'),
          '\\yavenue\\y',  'ave',  'g'),
          '\\ydrive\\y',   'dr',   'g'),
          '\\yboulevard\\y','blvd', 'g'),
          '\\yroad\\y',    'rd',   'g'),
          '\\ylane\\y',    'ln',   'g'),
          '\\ycourt\\y',   'ct',   'g'),
          '\\yplace\\y',   'pl',   'g'),
          '\\ycircle\\y',  'cir',  'g'),
          '\\yterrace\\y', 'ter',  'g'),
          '\\yparkway\\y', 'pkwy', 'g'),
          '\\yhighway\\y', 'hwy',  'g'),
          '\\s+', ' ', 'g')`;
      const occRfl = qv('occupancy');
      if (occRfl === 'owner_occupied') {
        conditions.push(`(c.mailing_address IS NOT NULL
          AND ${NORM_ADDR_RFL('p.street')} = ${NORM_ADDR_RFL('c.mailing_address')}
          AND LOWER(TRIM(p.city)) = LOWER(TRIM(c.mailing_city))
          AND UPPER(TRIM(p.state_code)) = UPPER(TRIM(c.mailing_state))
          AND SUBSTRING(TRIM(p.zip_code) FROM 1 FOR 5) = SUBSTRING(TRIM(c.mailing_zip) FROM 1 FOR 5))`);
      } else if (occRfl === 'absent_owner') {
        conditions.push(`(c.mailing_address IS NOT NULL AND TRIM(c.mailing_address) != ''
          AND NOT (
            ${NORM_ADDR_RFL('p.street')} = ${NORM_ADDR_RFL('c.mailing_address')}
            AND LOWER(TRIM(p.city)) = LOWER(TRIM(c.mailing_city))
            AND UPPER(TRIM(p.state_code)) = UPPER(TRIM(c.mailing_state))
            AND SUBSTRING(TRIM(p.zip_code) FROM 1 FOR 5) = SUBSTRING(TRIM(c.mailing_zip) FROM 1 FOR 5)
          ))`);
      } else if (occRfl === 'unknown') {
        conditions.push(`(c.mailing_address IS NULL OR TRIM(c.mailing_address) = '')`);
      }
      // Properties-owned filter — mirror list route logic
      const minOwnedRfl = qv('min_owned'), maxOwnedRfl = qv('max_owned');
      if (minOwnedRfl || maxOwnedRfl) {
        const ownedSubRfl = `
          CASE WHEN c.mailing_address IS NULL OR TRIM(c.mailing_address) = '' THEN 1
          ELSE (
            SELECT COUNT(*)
            FROM properties p2
            JOIN property_contacts pc2 ON pc2.property_id = p2.id AND pc2.primary_contact = true
            JOIN contacts c2 ON c2.id = pc2.contact_id
            WHERE c2.mailing_address IS NOT NULL AND TRIM(c2.mailing_address) != ''
              AND ${NORM_ADDR_RFL('c2.mailing_address')} = ${NORM_ADDR_RFL('c.mailing_address')}
              AND LOWER(TRIM(c2.mailing_city)) = LOWER(TRIM(c.mailing_city))
              AND UPPER(TRIM(p2.state_code)) = UPPER(TRIM(p.state_code))
              AND SUBSTRING(TRIM(c2.mailing_zip) FROM 1 FOR 5) = SUBSTRING(TRIM(c.mailing_zip) FROM 1 FOR 5)
          ) END`;
        if (minOwnedRfl) { conditions.push(`${ownedSubRfl} >= $${idx}`); params.push(parseInt(minOwnedRfl)); idx++; }
        if (maxOwnedRfl) { conditions.push(`${ownedSubRfl} <= $${idx}`); params.push(parseInt(maxOwnedRfl)); idx++; }
      }
      // Tag filter
      if (qv('tag')) {
        conditions.push(`EXISTS (SELECT 1 FROM property_tags pt_f WHERE pt_f.property_id = p.id AND pt_f.tag_id = $${idx})`);
        params.push(parseInt(qv('tag'))); idx++;
      }

      const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
      const idsRes = await query(`
        SELECT DISTINCT p.id
        FROM properties p
        LEFT JOIN property_contacts pc ON pc.property_id = p.id AND pc.primary_contact = true
        LEFT JOIN contacts c ON c.id = pc.contact_id
        ${where}
      `, params);
      idsToRemove = idsRes.rows.map(r => r.id);
    } else {
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: 'No records selected.' });
      }
      idsToRemove = ids.map(n => parseInt(n)).filter(n => !isNaN(n) && n > 0);
    }

    if (idsToRemove.length === 0) {
      return res.status(400).json({ error: 'No valid properties to remove.' });
    }

    // The ONLY thing we delete is the link in property_lists — properties,
    // contacts, phones, distress scores, campaign history all remain intact.
    const result = await query(
      `DELETE FROM property_lists
         WHERE list_id = $1
           AND property_id = ANY($2::int[])
         RETURNING property_id`,
      [listIdInt, idsToRemove]
    );

    console.log(`[records/remove-from-list] Removed ${result.rowCount} property-list links from list "${listCheck.rows[0].list_name}" (id=${listIdInt})`);
    res.json({ ok: true, removed: result.rowCount, listName: listCheck.rows[0].list_name });
  } catch (e) {
    console.error('[records/remove-from-list]', e);
    res.status(500).json({ error: 'Remove failed: ' + e.message });
  }
});

module.exports = router;
