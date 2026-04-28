const express = require('express');
const router = express.Router();
const { query, pool } = require('../db');
const distress = require('../scoring/distress');
const settings = require('../settings');
const { normalizeState, VALID_STATES } = require('../import/state');
const { lookupStateByZip } = require('../import/zip-to-state');
const { inferOwnerType, normalizeOwnerType, VALID_OWNER_TYPES } = require('../owner-type');
const { normalizePhone } = require('../phone-normalize');

function requireAuth(req, res, next) {
  if (!req.session || !req.session.authenticated) return res.redirect('/login');
  if (!req.session.tenantId) return res.redirect('/login');
  req.tenantId = req.session.tenantId;
  req.userId = req.session.userId;
  req.role = req.session.role;
  next();
}

const { shell } = require('../shared-shell');
const { renderFilterPanel } = require('./views/filter-panel');
// ─────────────────────────────────────────────────────────────────────────────
// 2026-04-20 audit fix #1 (marketing_result case-insensitivity):
// Lowercase + trim every value in a marketing-result filter array so the SQL
// side can do LOWER(TRIM(split_part(…))) = ANY($::text[]) and match regardless
// of how the CSV-sourced campaign_numbers.marketing_result row was cased. Also
// drops empties so ANY([]) never silently nukes the filter.
// ─────────────────────────────────────────────────────────────────────────────
function normMktList(arr) {
  if (!arr) return [];
  const a = Array.isArray(arr) ? arr : [arr];
  return a.map(v => String(v == null ? '' : v).trim().toLowerCase()).filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2026-04-20 audit fix #3 (single-select payload unification):
// Every bulk endpoint destructures `ids` from req.body and assumes it's an
// array. When the frontend sends a single item, some callers (detail page,
// inline row actions, future integrations) may post a scalar like
// `ids: 42` or `ids: "42"`. Instead of failing with "No records selected",
// we coerce to an int array. Scalar/array/string/nothing all normalize to
// the same shape so the server handles single and bulk identically.
// ─────────────────────────────────────────────────────────────────────────────
function coerceIdArray(raw) {
  if (raw == null) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr
    .map(v => parseInt(v, 10))
    .filter(n => Number.isFinite(n) && n > 0);
}

// 2026-04-21 Bug #3 fix: parseInt returns NaN on non-numeric input, and NaN
// sent as a Postgres integer parameter throws. safeInt returns null instead,
// which downstream callers can check or pass into nullable SQL comparisons.
// Applies to every user-supplied numeric query param in the new Feature 3
// and Feature 9 handlers. Not back-ported to pre-existing Loki code that
// uses bare parseInt() — that's a separate hardening pass.
function safeInt(v) {
  if (v == null || v === '') return null;
  const n = parseInt(String(v).trim(), 10);
  return Number.isFinite(n) ? n : null;
}


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
  // 2026-04-21 Phone tags — a completely separate tag pool for tagging
  // individual phone numbers (e.g. "Decision Maker", "Voicemail only",
  // "Spouse"). Does NOT share the property tag pool; users wanted the two
  // to stay distinct so a property's tags don't pollute the phone tag
  // dropdown and vice versa.
  await query(`
    CREATE TABLE IF NOT EXISTS phone_tags (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      color VARCHAR(7) DEFAULT '#6b7280',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_phone_tags_name_lower ON phone_tags (LOWER(name));
    CREATE TABLE IF NOT EXISTS phone_tag_links (
      phone_id INTEGER NOT NULL REFERENCES phones(id) ON DELETE CASCADE,
      phone_tag_id INTEGER NOT NULL REFERENCES phone_tags(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (phone_id, phone_tag_id)
    );
    CREATE INDEX IF NOT EXISTS idx_phone_tag_links_tag ON phone_tag_links(phone_tag_id);
    CREATE INDEX IF NOT EXISTS idx_phone_tag_links_phone ON phone_tag_links(phone_id);
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
      min_years_owned = '', max_years_owned = '',
      tag = '',
      phone_type = '',
      phone_tag = '',
      owner_type = '',
      mailing = '',
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
    // 2026-04-23 tag include/exclude filters — multi-select replacing the
    // old single-select `tag` / `phone_tag` params. Back-compat: if an old
    // URL still passes `?tag=123`, fold it into tagIncludeList so bookmarks
    // and sidebar links keep working.
    const tagIncludeList      = normalizeArr(req.query.tag_include).map(v => parseInt(v,10)).filter(Number.isFinite);
    const tagExcludeList      = normalizeArr(req.query.tag_exclude).map(v => parseInt(v,10)).filter(Number.isFinite);
    const phoneTagIncludeList = normalizeArr(req.query.phone_tag_include).map(v => parseInt(v,10)).filter(Number.isFinite);
    const phoneTagExcludeList = normalizeArr(req.query.phone_tag_exclude).map(v => parseInt(v,10)).filter(Number.isFinite);
    // Legacy single-select fallback — merge into the include list if present
    if (tag) {
      const tagInt = parseInt(tag, 10);
      if (Number.isFinite(tagInt) && !tagIncludeList.includes(tagInt)) tagIncludeList.push(tagInt);
    }
    if (phone_tag) {
      const ptInt = parseInt(phone_tag, 10);
      if (Number.isFinite(ptInt) && !phoneTagIncludeList.includes(ptInt)) phoneTagIncludeList.push(ptInt);
    }

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

    // Tenant baseline — every WHERE clause starts here so the result set
    // can never include rows from another tenant. This is the foundation
    // the filter parity rule extends. RLS in commit 5 will backstop it
    // even if a downstream subquery forgets its own tenant constraint.
    let conditions = [`p.tenant_id = $1`];
    let params = [req.tenantId];
    let idx = 2;

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
        AND COALESCE(p.street_normalized, LOWER(TRIM(p.street))) = COALESCE(c.mailing_address_normalized, LOWER(TRIM(c.mailing_address)))
        AND LOWER(TRIM(p.city)) = LOWER(TRIM(c.mailing_city))
        AND UPPER(TRIM(p.state_code)) = UPPER(TRIM(c.mailing_state))
        AND SUBSTRING(TRIM(p.zip_code) FROM 1 FOR 5) = SUBSTRING(TRIM(c.mailing_zip) FROM 1 FOR 5)
      )`);
    } else if (occupancy === 'absent_owner') {
      conditions.push(`(
        c.mailing_address IS NOT NULL AND TRIM(c.mailing_address) != ''
        AND NOT (
          COALESCE(p.street_normalized, LOWER(TRIM(p.street))) = COALESCE(c.mailing_address_normalized, LOWER(TRIM(c.mailing_address)))
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
          AND LOWER(TRIM(split_part(cc_mkt.marketing_result, ' — ', 1))) = ANY($${paramIdx}::text[])
      )
      OR EXISTS (
        SELECT 1 FROM campaign_numbers cn_mkt
        JOIN phones ph_mkt ON ph_mkt.phone_number = cn_mkt.phone_number
        JOIN property_contacts pc_mkt ON pc_mkt.contact_id = ph_mkt.contact_id AND pc_mkt.property_id = p.id
        WHERE cn_mkt.marketing_result IS NOT NULL
          AND LOWER(TRIM(split_part(cn_mkt.marketing_result, ' — ', 1))) = ANY($${paramIdx}::text[])
      )
    )`;
    if (mkt_result)   { conditions.push(mktCampaignMatch(idx));  params.push(normMktList([mkt_result])); idx++; }
    if (mktIncludeList.length > 0) {
      conditions.push(mktCampaignMatch(idx));
      params.push(normMktList(mktIncludeList));
      idx++;
    }
    if (mktExcludeList.length > 0) {
      conditions.push(`NOT ${mktCampaignMatch(idx)}`);
      params.push(normMktList(mktExcludeList));
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
    // 2026-04-21 Feature 3: Ownership Duration filter. Years owned is
    // derived from p.last_sale_date — EXTRACT(YEAR FROM AGE(...)) gives
    // the integer year diff from today. Properties with NULL last_sale_date
    // are EXCLUDED from both min and max filters (treating "unknown" as
    // "doesn't match" — otherwise a min=5 filter would confusingly include
    // properties where we genuinely don't know the ownership date).
    // Applied at all 5 filter-code-path sites per the filter parity rule.
    const minYoMain = safeInt(min_years_owned);
    const maxYoMain = safeInt(max_years_owned);
    if (minYoMain !== null) {
      conditions.push(`p.last_sale_date IS NOT NULL AND EXTRACT(YEAR FROM AGE(CURRENT_DATE, p.last_sale_date)) >= $${idx}`);
      params.push(minYoMain);
      idx++;
    }
    if (maxYoMain !== null) {
      conditions.push(`p.last_sale_date IS NOT NULL AND EXTRACT(YEAR FROM AGE(CURRENT_DATE, p.last_sale_date)) <= $${idx}`);
      params.push(maxYoMain);
      idx++;
    }
    // 2026-04-23 Tag Include/Exclude filters (replaced single-select).
    // INCLUDE: property must have at least ONE of the tags in the list (OR).
    // EXCLUDE: property must have NONE of the tags (NOT EXISTS).
    // The legacy single `tag` param (if passed) has already been folded
    // into tagIncludeList upstream.
    if (tagIncludeList.length > 0) {
      conditions.push(`EXISTS (SELECT 1 FROM property_tags pt_f WHERE pt_f.property_id = p.id AND pt_f.tag_id = ANY($${idx}::int[]))`);
      params.push(tagIncludeList); idx++;
    }
    if (tagExcludeList.length > 0) {
      conditions.push(`NOT EXISTS (SELECT 1 FROM property_tags pt_x WHERE pt_x.property_id = p.id AND pt_x.tag_id = ANY($${idx}::int[]))`);
      params.push(tagExcludeList); idx++;
    }
    // 2026-04-21 Phone Type filter. "Any linked phone matches" semantics —
    // show properties where at least one phone on the primary contact has
    // the selected phone_type. Whitelist to prevent arbitrary values leaking
    // into the SQL (param is still passed, but defense in depth).
    const VALID_PHONE_TYPES = ['mobile', 'landline', 'voip', 'unknown'];
    if (phone_type && VALID_PHONE_TYPES.includes(phone_type)) {
      conditions.push(`EXISTS (
        SELECT 1 FROM phones ph_pt
        JOIN property_contacts pc_pt ON pc_pt.contact_id = ph_pt.contact_id
        WHERE pc_pt.property_id = p.id AND LOWER(ph_pt.phone_type) = $${idx}
      )`);
      params.push(phone_type); idx++;
    }
    // 2026-04-23 Phone Tag Include/Exclude filters (replaced single-select).
    if (phoneTagIncludeList.length > 0) {
      conditions.push(`EXISTS (
        SELECT 1 FROM phone_tag_links ptl_f
        JOIN phones ph_ptl ON ph_ptl.id = ptl_f.phone_id
        JOIN property_contacts pc_ptl ON pc_ptl.contact_id = ph_ptl.contact_id
        WHERE pc_ptl.property_id = p.id AND ptl_f.phone_tag_id = ANY($${idx}::int[])
      )`);
      params.push(phoneTagIncludeList); idx++;
    }
    if (phoneTagExcludeList.length > 0) {
      conditions.push(`NOT EXISTS (
        SELECT 1 FROM phone_tag_links ptl_x
        JOIN phones ph_ptlx ON ph_ptlx.id = ptl_x.phone_id
        JOIN property_contacts pc_ptlx ON pc_ptlx.contact_id = ph_ptlx.contact_id
        WHERE pc_ptlx.property_id = p.id AND ptl_x.phone_tag_id = ANY($${idx}::int[])
      )`);
      params.push(phoneTagExcludeList); idx++;
    }
    // 2026-04-21 Feature 1: Owner Type filter (Person/Company/Trust). Matches
    // on the primary contact's owner_type. Empty string or 'any' = no filter.
    if (owner_type && VALID_OWNER_TYPES.includes(owner_type)) {
      conditions.push(`c.owner_type = $${idx}`);
      params.push(owner_type); idx++;
    }
    // 2026-04-21 Feature 6: Clean vs Incomplete mailing address segmentation.
    //   clean      = primary contact has ALL four mailing fields populated
    //                (matches REISift's "skip-traced" mental model — can be
    //                direct-mailed without further enrichment).
    //   incomplete = primary contact missing one or more mailing fields, OR
    //                no primary contact at all. These cannot be mailed to as-is.
    // Implemented as (NOT) NULL/empty check on all four fields. We deliberately
    // use c.mailing_* (which is already LEFT JOIN'd at line 437) — no extra
    // join cost. Null-safe via COALESCE/TRIM so blank strings count as missing.
    if (mailing === 'clean') {
      conditions.push(`(
        c.mailing_address IS NOT NULL AND TRIM(c.mailing_address) <> ''
        AND c.mailing_city IS NOT NULL AND TRIM(c.mailing_city) <> ''
        AND c.mailing_state IS NOT NULL AND TRIM(c.mailing_state) <> ''
        AND c.mailing_zip IS NOT NULL AND TRIM(c.mailing_zip) <> ''
      )`);
    } else if (mailing === 'incomplete') {
      conditions.push(`(
        c.id IS NULL
        OR c.mailing_address IS NULL OR TRIM(COALESCE(c.mailing_address,'')) = ''
        OR c.mailing_city    IS NULL OR TRIM(COALESCE(c.mailing_city,''))    = ''
        OR c.mailing_state   IS NULL OR TRIM(COALESCE(c.mailing_state,''))   = ''
        OR c.mailing_zip     IS NULL OR TRIM(COALESCE(c.mailing_zip,''))     = ''
      )`);
    }
    if (min_year)     { conditions.push(`p.year_built >= $${idx}`);       params.push(min_year); idx++; }
    if (max_year)     { conditions.push(`p.year_built <= $${idx}`);       params.push(max_year); idx++; }
    if (upload_from)  { conditions.push(`p.created_at >= $${idx}`);       params.push(upload_from); idx++; }
    if (upload_to)    { conditions.push(`p.created_at <= $${idx}`);       params.push(upload_to + ' 23:59:59'); idx++; }
    if (list_id)      { conditions.push(`EXISTS (SELECT 1 FROM property_lists pl2 WHERE pl2.property_id = p.id AND pl2.list_id = $${idx})`); params.push(list_id); idx++; }

    // ── AND-stacking: property must appear on EVERY selected list ────────────
    // For N selected lists, require N matching rows in property_lists. If only
    // 1 list is selected, this behaves identically to the old single-list filter.
    // 2026-04-20 audit fix #5 (cont): rewrite from correlated subquery to
    // semi-join. The old COUNT(DISTINCT) subquery ran ONCE PER outer row,
    // so filtering (state=IN) + (stack_list=[2630]) did ~30k subquery
    // evaluations against property_lists. Semi-joins let Postgres choose
    // whichever side is smaller as the driver — if list 2630 has 7k
    // members, we scan those 7k first instead of all Indiana properties.
    //
    // Special-cased length=1 to a plain EXISTS (fastest path — the query
    // planner hits idx_property_lists_list_property with an index-only
    // scan). Length>1 uses an IN (SELECT … GROUP BY … HAVING COUNT) —
    // single aggregation instead of N correlated subqueries.
    if (stackList.length > 0) {
      const listIdInts = stackList.map(v => parseInt(v)).filter(n => !isNaN(n));
      if (listIdInts.length === 1) {
        conditions.push(`EXISTS (
          SELECT 1 FROM property_lists pl_stack
           WHERE pl_stack.property_id = p.id
             AND pl_stack.list_id = $${idx}
        )`);
        params.push(listIdInts[0]); idx++;
      } else if (listIdInts.length > 1) {
        conditions.push(`p.id IN (
          SELECT pl_stack.property_id FROM property_lists pl_stack
           WHERE pl_stack.list_id = ANY($${idx}::int[])
           GROUP BY pl_stack.property_id
          HAVING COUNT(DISTINCT pl_stack.list_id) = $${idx+1}
        )`);
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

    // 2026-04-20 audit fix #5 (cont): DISTINCT / DISTINCT ON are pure overhead
    // when phoneJoin is empty. property_contacts has a partial unique index
    // (idx_property_contacts_single_primary) guaranteeing at most one
    // primary_contact row per property, and contacts.id is PK — so neither
    // of those LEFT JOINs can multiply rows. Only the phones LEFT JOIN can,
    // and it's only active when `q` is set. Skipping dedup when it's not
    // needed lets Postgres use simpler execution plans (often index-only
    // scans instead of sort+unique).
    const countExpr = phoneJoin ? 'COUNT(DISTINCT p.id)' : 'COUNT(*)';
    const distinctClause = phoneJoin ? 'DISTINCT ON (p.id)' : '';

    const countRes = await query(`
      SELECT ${countExpr} FROM properties p
      LEFT JOIN property_contacts pc ON pc.property_id = p.id AND pc.primary_contact = true
      LEFT JOIN contacts c ON c.id = pc.contact_id
      ${phoneJoin}
      ${where}
    `, params);
    const total = parseInt(countRes.rows[0].count);

    // Fetch all lists for stack filter dropdown
    const allListsRes = await query(`SELECT id, list_name FROM lists WHERE tenant_id = $1 ORDER BY list_name ASC`, [req.tenantId]);
    const allLists = allListsRes.rows;

    // Fetch all distinct states present in the DB for multi-select state filter
    const allStatesRes = await query(`SELECT DISTINCT state_code FROM properties WHERE tenant_id = $1 AND state_code IS NOT NULL AND state_code <> '' ORDER BY state_code ASC`, [req.tenantId]);
    const STATE_NAMES = { AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',CT:'Connecticut',DE:'Delaware',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming',DC:'District of Columbia' };
    const allStates = allStatesRes.rows.map(r => ({ code: r.state_code, name: STATE_NAMES[r.state_code] || r.state_code }));

    const rows = await query(`
      SELECT ${distinctClause}
        p.id, p.street, p.city, p.state_code, p.zip_code,
        p.property_type, p.vacant, p.pipeline_stage, p.source,
        p.estimated_value, p.condition, p.created_at,
        p.distress_score, p.distress_band,
        c.first_name, c.last_name, c.owner_type,
        (SELECT COUNT(*) FROM property_lists pl WHERE pl.property_id = p.id) AS list_count,
        (SELECT COUNT(*) FROM phones ph2
          JOIN property_contacts pc2 ON pc2.contact_id = ph2.contact_id
          WHERE pc2.property_id = p.id) AS phone_count
      FROM properties p
      LEFT JOIN property_contacts pc ON pc.property_id = p.id AND pc.primary_contact = true
      LEFT JOIN contacts c ON c.id = pc.contact_id
      ${phoneJoin}
      ${where}
      ORDER BY p.id DESC
      LIMIT $${idx} OFFSET $${idx+1}
    `, [...params, limit, offset]);

    // Fetch all tags for the tag filter dropdown + bulk-tag remove modal
    await ensureTagSchema();
    const allTagsRes = await query(`SELECT id, name, color FROM tags WHERE tenant_id = $1 ORDER BY name ASC`, [req.tenantId]);
    const allTags = allTagsRes.rows;
    // 2026-04-21 Phone tags for the filter dropdown.
    const allPhoneTagsRes = await query(`SELECT id, name, color FROM phone_tags WHERE tenant_id = $1 ORDER BY name ASC`, [req.tenantId]);
    const allPhoneTags = allPhoneTagsRes.rows;

    const totalPages = Math.ceil(total / limit);

    const tableRows = rows.rows.map(r => {
      const owner = [r.first_name, r.last_name].filter(Boolean).join(' ') || '—';
      const stage = r.pipeline_stage || 'prospect';
      const stageColor = {prospect:'#f5f4f0',lead:'#e8f5ee',contract:'#fff8e1',closed:'#e8f0ff'}[stage]||'#f5f4f0';
      const stageText = {prospect:'#555',lead:'#1a7a4a',contract:'#9a6800',closed:'#2c5cc5'}[stage]||'#555';
      // Owner-type badge (Person/Company/Trust). Different palette from Stage so
      // a user can quickly visually scan for LLC portfolios vs individual owners.
      const ot = r.owner_type;
      const otColors = {
        Person:  { bg: '#f0efe9', text: '#555'    },
        Company: { bg: '#e8f0ff', text: '#2c5cc5' },
        Trust:   { bg: '#f3e8ff', text: '#6f42c1' },
      };
      const ownerTypeCell = (ot && otColors[ot])
        ? `<span style="background:${otColors[ot].bg};color:${otColors[ot].text};padding:3px 10px;border-radius:5px;font-size:11px;font-weight:600">${ot}</span>`
        : '<span style="color:#ccc;font-size:12px">—</span>';
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
        <td style="padding:12px;text-align:left">${ownerTypeCell}</td>
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
      add('min_years_owned', min_years_owned); add('max_years_owned', max_years_owned);
      add('tag', tag);
      add('phone_type', phone_type); add('phone_tag', phone_tag);
      add('owner_type', owner_type);
      add('mailing', mailing);
      stackList.forEach(sl => parts.push(`stack_list=${encodeURIComponent(sl)}`));
      stateList.forEach(s => parts.push(`state=${encodeURIComponent(s)}`));
      mktIncludeList.forEach(m => parts.push(`mkt_include=${encodeURIComponent(m)}`));
      mktExcludeList.forEach(m => parts.push(`mkt_exclude=${encodeURIComponent(m)}`));
      // 2026-04-23 Tag/Phone Tag Include+Exclude arrays
      tagIncludeList.forEach(v => parts.push(`tag_include=${encodeURIComponent(v)}`));
      tagExcludeList.forEach(v => parts.push(`tag_exclude=${encodeURIComponent(v)}`));
      phoneTagIncludeList.forEach(v => parts.push(`phone_tag_include=${encodeURIComponent(v)}`));
      phoneTagExcludeList.forEach(v => parts.push(`phone_tag_exclude=${encodeURIComponent(v)}`));
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
    const activeFilterCount = [city,zip,county,type,pipeline,prop_status,mkt_result,occupancy,phones,min_assessed,max_assessed,min_equity,max_equity,min_year,max_year,upload_from,upload_to,min_stack,min_distress,min_owned,max_owned,min_years_owned,max_years_owned,phone_type,owner_type,mailing].filter(Boolean).length + (stackList.length > 0 ? 1 : 0) + (stateList.length > 0 ? 1 : 0) + (mktIncludeList.length > 0 ? 1 : 0) + (mktExcludeList.length > 0 ? 1 : 0) + (tagIncludeList.length > 0 ? 1 : 0) + (tagExcludeList.length > 0 ? 1 : 0) + (phoneTagIncludeList.length > 0 ? 1 : 0) + (phoneTagExcludeList.length > 0 ? 1 : 0);

    res.send(shell('Records', `
      <div class="page-header">
        <div>
          <div class="page-title">Records <span class="count-pill">${total.toLocaleString()}</span></div>
          <div class="page-sub">${list_id ? '<a href="/lists" style="color:#888;font-size:13px;text-decoration:none">← Back to Lists</a> &nbsp;·&nbsp; Filtered by list' : 'All properties'}</div>
        </div>
        <!-- 2026-04-21 Feature 7: manual property creation entry point. -->
        <div><a href="/records/_new" class="btn btn-primary" style="text-decoration:none">+ Add Property</a></div>
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
        ${renderFilterPanel({
          activeFilterCount,
          allLists, allPhoneTags, allStates, allTags,
          stateList, city, zip, county,
          type, prop_status, occupancy, pipeline,
          min_year, max_year, min_assessed, max_assessed,
          min_equity, max_equity, min_owned, max_owned,
          min_years_owned, max_years_owned,
          min_stack, min_distress,
          phones, owner_type, mailing, phone_type,
          tagIncludeList, tagExcludeList,
          phoneTagIncludeList, phoneTagExcludeList,
          mktIncludeList, mktExcludeList,
          stackList,
          upload_from, upload_to,
          list_id,
        })}
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
              ['street','Street Address',true],['city','City',true],['state_code','State',true],['zip_code','ZIP',true],['county','County',true],
              ['first_name','Owner First Name',true],['last_name','Owner Last Name',true],['owner_type','Owner Type',true],['is_primary','Primary Owner (Yes/No)',true],
              ['mailing_address','Mailing Address',true],['mailing_city','Mailing City',true],['mailing_state','Mailing State',true],['mailing_zip','Mailing ZIP',true],['email_1','Email 1',true],['email_2','Email 2',true],
              ['phones','Phones (1–15 separate columns)',true],
              ['property_type','Property Type',true],['year_built','Year Built',true],['sqft','Sq Ft',true],['bedrooms','Bedrooms',true],['bathrooms','Bathrooms',true],
              ['assessed_value','Assessed Value',true],['estimated_value','Est. Value',true],['equity_percent','Equity %',true],
              ['property_status','Property Status',true],['owner_occupancy','Owner Occupancy',true],['pipeline_stage','Pipeline Stage',true],['condition','Condition',true],
              ['last_sale_date','Last Sale Date',true],['last_sale_price','Last Sale Price',true],
              ['marketing_result','Marketing Result',true],['source','Source',true],
              ['list_count','Lists Count',true],['created_at','Date Added',true],
              ['distress_score','Distress Score',true],['distress_band','Distress Band',true],
              // 2026-04-21 Feature 2: Additional Info fields. Default UNCHECKED —
              // they bloat CSVs for typical dialer workflows (legal_description is
              // multi-paragraph county text). Users opt in per export.
              ['stories','Stories',false],['structure_type','Structure Type',false],['apn','APN',false],['legal_description','Legal Description',false],
              ['total_tax_owed','Total Tax Owed',false],['tax_delinquent_year','Tax Delinquent Year',false],['tax_auction_date','Tax Auction Date',false],
              ['deed_type','Deed Type',false],['lien_type','Lien Type',false],['lien_date','Lien Date',false],
            ].map(([k,l,def]) => `<label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;padding:4px 0">
              <input type="checkbox" value="${k}" class="col-check"${def ? ' checked' : ''} style="width:14px;height:14px"> ${l}
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

      <!-- 2026-04-21 Feature 9: Add to List modal. Mirrors the Remove-from-List
           flow structurally but does not require a delete code — adding to a
           list is a non-destructive operation. Supports creating a new list
           inline via the "+ Create new list…" option at the bottom. -->
      <div class="modal-overlay" id="atl-modal">
        <div class="modal" style="max-width:480px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
            <h3 style="font-size:17px;font-weight:600;margin:0;color:#1a1a1a">➕ Add to List</h3>
            <button onclick="document.getElementById('atl-modal').classList.remove('open')" style="background:none;border:none;font-size:22px;cursor:pointer;color:#888;line-height:1">×</button>
          </div>
          <div id="atl-modal-msg" style="font-size:14px;margin-bottom:16px;color:#333;line-height:1.5"></div>
          <div id="atl-modal-err" style="display:none;background:#fdeaea;border:1px solid #f5c5c5;border-radius:6px;padding:8px 12px;color:#8b1f1f;font-size:13px;margin-bottom:12px"></div>
          <div style="margin-bottom:14px">
            <label style="font-size:12px;color:#888;display:block;margin-bottom:4px">Select list</label>
            <select id="atl-list-select" onchange="atlOnSelectChange(this)" style="width:100%;padding:9px 12px;border:1px solid #ddd;border-radius:8px;font-size:14px;font-family:inherit;background:#fff">
              <option value="">— choose a list —</option>
              ${allLists.map(l => `<option value="${l.id}">${escHTML(l.list_name)}</option>`).join('')}
              <option value="__new__">+ Create new list…</option>
            </select>
          </div>
          <div id="atl-new-list-wrap" style="display:none;margin-bottom:14px">
            <label style="font-size:12px;color:#888;display:block;margin-bottom:4px">New list name</label>
            <input type="text" id="atl-new-list-name" maxlength="200" placeholder="e.g. Q2 2026 Hot Leads" style="width:100%;padding:9px 12px;border:1px solid #ddd;border-radius:8px;font-size:14px;font-family:inherit" onkeydown="if(event.key==='Enter'){event.preventDefault();confirmAddToList();}">
          </div>
          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button onclick="document.getElementById('atl-modal').classList.remove('open')" style="padding:9px 16px;background:#fff;color:#666;border:1px solid #ddd;border-radius:8px;font-size:13px;cursor:pointer;font-family:inherit">Cancel</button>
            <button onclick="confirmAddToList()" id="atl-confirm-btn" style="padding:9px 16px;background:#1a7a4a;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">Add to List</button>
          </div>
          <div style="font-size:11px;color:#888;margin-top:12px;line-height:1.4">
            Properties already on the selected list are skipped (no duplicates).
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
              <input type="text" id="bulk-tag-input" placeholder="Click to browse, or type a tag name…" autocomplete="off"
                style="width:100%;padding:9px 12px;border:1px solid #ddd;border-radius:8px;font-size:14px;font-family:inherit"
                oninput="bulkTagSuggest(this.value)"
                onfocus="bulkTagSuggestOnFocus()"
                onclick="bulkTagSuggestOnFocus()"
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
            <!-- 2026-04-21 Feature 9: Add to List (mirrors Remove from List). -->
            <button onclick="openAddToListModal()" style="display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:9px 12px;background:none;border:none;border-radius:7px;font-size:13px;font-family:inherit;color:#1a1a1a;cursor:pointer" onmouseover="this.style.background='#f5f4f0'" onmouseout="this.style.background='none'">
              <span style="font-size:14px">➕</span><span>Add to list</span>
            </button>
            <button onclick="openDeleteModal()" style="display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:9px 12px;background:none;border:none;border-radius:7px;font-size:13px;font-family:inherit;color:#c0392b;cursor:pointer" onmouseover="this.style.background='#fdeaea'" onmouseout="this.style.background='none'">
              <span style="font-size:14px">🗑</span><span>Delete records</span>
            </button>
            <div style="height:1px;background:#eee;margin:4px 6px"></div>
            <div style="padding:4px 12px;font-size:10px;color:#aaa;text-transform:uppercase;letter-spacing:.08em">Coming soon</div>
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
            <th style="padding:10px 12px;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.05em;text-align:left">Owner Type</th>
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
      <script src="/js/records-list.js?v=5"></script>

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

// ═══════════════════════════════════════════════════════════════════════════════
// 2026-04-21 Phone tags — separate pool from property tags.
// GET  /records/phone-tags/suggest       → auto-suggest for the tag picker
// POST /records/phones/:phoneId/tags     → attach a phone tag (creates if new)
// POST /records/phones/:phoneId/tags/:tagId/remove → detach one
// POST /records/phones/:phoneId/type     → set phone_type (manual override)
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/phone-tags/suggest', requireAuth, async (req, res) => {
  try {
    await ensureTagSchema();
    const q = String(req.query.q || '').trim();
    if (!q) {
      const r = await query(`SELECT id, name, color FROM phone_tags ORDER BY name ASC LIMIT 50`);
      return res.json(r.rows);
    }
    const r = await query(
      `SELECT id, name, color FROM phone_tags WHERE name ILIKE $1 ORDER BY name ASC LIMIT 20`,
      [`%${q}%`]
    );
    res.json(r.rows);
  } catch (e) {
    console.error('[phone-tags/suggest]', e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/phones/:phoneId(\\d+)/tags', requireAuth, async (req, res) => {
  try {
    await ensureTagSchema();
    const phoneId = parseInt(req.params.phoneId, 10);
    const name = String(req.body.name || '').trim().slice(0, 100);
    if (!phoneId || !name) return res.status(400).json({ error: 'phoneId + name required' });

    // Verify phone exists (clearer error than FK violation)
    const ph = await query(`SELECT id FROM phones WHERE id = $1`, [phoneId]);
    if (!ph.rowCount) return res.status(404).json({ error: 'Phone not found' });

    // Find-or-create the tag (case-insensitive). Race-safe via the unique
    // index on LOWER(name) — if two simultaneous creates happen, the second
    // hits ON CONFLICT and we SELECT again to grab the existing id.
    let tagRes = await query(`SELECT id, name, color FROM phone_tags WHERE LOWER(name) = LOWER($1) LIMIT 1`, [name]);
    let tag;
    if (tagRes.rowCount) {
      tag = tagRes.rows[0];
    } else {
      try {
        const ins = await query(`INSERT INTO phone_tags (name) VALUES ($1) RETURNING id, name, color`, [name]);
        tag = ins.rows[0];
      } catch (e) {
        // Race: concurrent insert won. Re-read.
        const r2 = await query(`SELECT id, name, color FROM phone_tags WHERE LOWER(name) = LOWER($1) LIMIT 1`, [name]);
        if (!r2.rowCount) throw e;
        tag = r2.rows[0];
      }
    }

    await query(
      `INSERT INTO phone_tag_links (phone_id, phone_tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [phoneId, tag.id]
    );
    res.json({ ok: true, tag });
  } catch (e) {
    console.error('[phones/:id/tags POST]', e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/phones/:phoneId(\\d+)/tags/:tagId(\\d+)/remove', requireAuth, async (req, res) => {
  try {
    const phoneId = parseInt(req.params.phoneId, 10);
    const tagId = parseInt(req.params.tagId, 10);
    await query(`DELETE FROM phone_tag_links WHERE phone_id = $1 AND phone_tag_id = $2`, [phoneId, tagId]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[phones/:id/tags/:tid/remove]', e);
    res.status(500).json({ error: e.message });
  }
});

// Manual phone type override — user-driven correction when the CSV import
// got it wrong (or when the source data had no type column). Whitelist the
// allowed values to keep the DB clean.
router.post('/phones/:phoneId(\\d+)/type', requireAuth, async (req, res) => {
  try {
    const phoneId = parseInt(req.params.phoneId, 10);
    const allowed = ['mobile', 'landline', 'voip', 'unknown'];
    const newType = String(req.body.phone_type || '').toLowerCase();
    if (!phoneId || !allowed.includes(newType)) return res.status(400).json({ error: 'Invalid phone_type. Use mobile / landline / voip / unknown.' });
    const r = await query(`UPDATE phones SET phone_type = $1, updated_at = NOW() WHERE id = $2 RETURNING id, phone_type`, [newType, phoneId]);
    if (!r.rowCount) return res.status(404).json({ error: 'Phone not found' });
    res.json({ ok: true, phone: r.rows[0] });
  } catch (e) {
    console.error('[phones/:id/type POST]', e);
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
// 2026-04-21 Feature 7 — Manual property creation
// GET  /records/_new  → form
// POST /records/_new  → create property + contact + up to 5 phones, then redirect
//
// Creates exactly ONE property row, links ONE primary contact, and optionally
// attaches phones. Uses the same normalization helpers as the CSV import path
// (normalizeState, normalizeZip, normalizePhone) so manually-entered data
// follows the same "clean DB" discipline.
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/_new', requireAuth, async (req, res) => {
  try {
    // 2026-04-21 Bug #1 fix: consume session flash instead of reading form
    // values from ?err=...&field1=...&field2=... URL. Previous approach
    // stuffed every submitted field into the query string, which could
    // exceed browser URL limits on long inputs (e.g. 3KB legal description).
    // Session flash is consumed once then cleared — if the user reloads
    // the /records/_new page without a fresh error, they get an empty form.
    const flash = (req.session && req.session.newPropertyFlash) || null;
    if (req.session) req.session.newPropertyFlash = null;  // consume
    const err = flash && flash.err ? String(flash.err).slice(0, 500) : '';
    const errSafe = err ? err.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])) : '';
    const f = (flash && flash.form) || {};
    const v = (k) => f[k] != null ? String(f[k]).replace(/"/g, '&quot;') : '';
    res.send(shell('Add Property', `
      <div style="max-width:820px">
        <div style="margin-bottom:1rem"><a href="/records" style="font-size:13px;color:#888;text-decoration:none">← Records</a></div>
        <h2 style="font-size:20px;font-weight:500;margin-bottom:4px">Add Property</h2>
        <p style="font-size:13px;color:#888;margin-bottom:1.5rem">Create a single property record manually. For bulk imports, use the Upload page instead.</p>
        ${errSafe ? `<div style="background:#fdeaea;border:1px solid #f5c5c5;border-radius:8px;padding:10px 14px;color:#8b1f1f;font-size:13px;margin-bottom:12px">❌ ${errSafe}</div>` : ''}
        <form method="POST" action="/records/_new" class="card" style="display:flex;flex-direction:column;gap:16px">
          <div>
            <div style="font-size:10px;font-weight:700;color:#aaa;text-transform:uppercase;letter-spacing:.1em;margin-bottom:8px">Property Address</div>
            <div style="display:grid;grid-template-columns:1fr;gap:10px">
              <div class="form-field" style="margin:0"><label>Street <span style="color:#c0392b">*</span></label><input type="text" name="street" value="${v('street')}" required maxlength="255" placeholder="123 Main St"></div>
              <div style="display:grid;grid-template-columns:2fr 1fr 1fr;gap:10px">
                <div class="form-field" style="margin:0"><label>City <span style="color:#c0392b">*</span></label><input type="text" name="city" value="${v('city')}" required maxlength="100"></div>
                <div class="form-field" style="margin:0"><label>State <span style="color:#c0392b">*</span></label><input type="text" name="state_code" value="${v('state_code')}" required maxlength="2" placeholder="IN" style="text-transform:uppercase"></div>
                <div class="form-field" style="margin:0"><label>ZIP <span style="color:#c0392b">*</span></label><input type="text" name="zip_code" value="${v('zip_code')}" required maxlength="10" placeholder="46201"></div>
              </div>
              <div class="form-field" style="margin:0"><label>County</label><input type="text" name="county" value="${v('county')}" maxlength="100"></div>
            </div>
          </div>

          <div>
            <div style="font-size:10px;font-weight:700;color:#aaa;text-transform:uppercase;letter-spacing:.1em;margin-bottom:8px">Property Details</div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
              <div class="form-field" style="margin:0"><label>Property Type</label><input type="text" name="property_type" value="${v('property_type')}" maxlength="50" placeholder="Single Family"></div>
              <div class="form-field" style="margin:0"><label>Year Built</label><input type="number" name="year_built" value="${v('year_built')}" min="1800" max="2200"></div>
              <div class="form-field" style="margin:0"><label>Sq Ft</label><input type="number" name="sqft" value="${v('sqft')}" min="0"></div>
              <div class="form-field" style="margin:0"><label>Bedrooms</label><input type="number" name="bedrooms" value="${v('bedrooms')}" min="0" max="99"></div>
              <div class="form-field" style="margin:0"><label>Bathrooms</label><input type="number" name="bathrooms" value="${v('bathrooms')}" min="0" max="99" step="0.5"></div>
              <div class="form-field" style="margin:0"><label>Lot Size (sqft)</label><input type="number" name="lot_size" value="${v('lot_size')}" min="0"></div>
              <div class="form-field" style="margin:0"><label>Estimated Value</label><input type="number" name="estimated_value" value="${v('estimated_value')}" min="0" step="0.01"></div>
              <div class="form-field" style="margin:0"><label>Assessed Value</label><input type="number" name="assessed_value" value="${v('assessed_value')}" min="0" step="0.01"></div>
              <div class="form-field" style="margin:0"><label>Last Sale Date</label><input type="date" name="last_sale_date" value="${v('last_sale_date')}"></div>
              <div class="form-field" style="margin:0"><label>Last Sale Price</label><input type="number" name="last_sale_price" value="${v('last_sale_price')}" min="0" step="0.01"></div>
              <div class="form-field" style="margin:0"><label>Equity %</label><input type="number" name="equity_percent" value="${v('equity_percent')}" min="-100" max="100" step="0.01"></div>
              <div class="form-field" style="margin:0"><label>Vacant</label><select name="vacant"><option value="">—</option><option value="true" ${f.vacant==='true'?'selected':''}>Yes</option><option value="false" ${f.vacant==='false'?'selected':''}>No</option></select></div>
            </div>
          </div>

          <div>
            <div style="font-size:10px;font-weight:700;color:#aaa;text-transform:uppercase;letter-spacing:.1em;margin-bottom:8px">Primary Contact (optional)</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <div class="form-field" style="margin:0"><label>First Name</label><input type="text" name="first_name" value="${v('first_name')}" maxlength="100"></div>
              <div class="form-field" style="margin:0"><label>Last Name</label><input type="text" name="last_name" value="${v('last_name')}" maxlength="100"></div>
            </div>
            <div style="display:grid;grid-template-columns:2fr 1.5fr 1fr 1fr;gap:10px;margin-top:10px">
              <div class="form-field" style="margin:0"><label>Mailing Address</label><input type="text" name="mailing_address" value="${v('mailing_address')}" maxlength="255"></div>
              <div class="form-field" style="margin:0"><label>City</label><input type="text" name="mailing_city" value="${v('mailing_city')}" maxlength="100"></div>
              <div class="form-field" style="margin:0"><label>State</label><input type="text" name="mailing_state" value="${v('mailing_state')}" maxlength="2" style="text-transform:uppercase"></div>
              <div class="form-field" style="margin:0"><label>ZIP</label><input type="text" name="mailing_zip" value="${v('mailing_zip')}" maxlength="10"></div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px">
              <div class="form-field" style="margin:0"><label>Email 1</label><input type="email" name="email_1" value="${v('email_1')}" maxlength="255"></div>
              <div class="form-field" style="margin:0"><label>Email 2</label><input type="email" name="email_2" value="${v('email_2')}" maxlength="255"></div>
            </div>
          </div>

          <div>
            <div style="font-size:10px;font-weight:700;color:#aaa;text-transform:uppercase;letter-spacing:.1em;margin-bottom:8px">Phones (optional, up to 5)</div>
            <div style="display:grid;grid-template-columns:1fr;gap:8px">
              ${[1,2,3,4,5].map(i => `
              <div style="display:grid;grid-template-columns:2fr 1fr 1fr;gap:8px">
                <input type="tel" name="phone_${i}" value="${v('phone_'+i)}" placeholder="Phone ${i} (e.g. 317-555-1234)" style="padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit">
                <select name="phone_type_${i}" style="padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit;background:#fff">
                  <option value="unknown">Type</option>
                  <option value="mobile" ${f['phone_type_'+i]==='mobile'?'selected':''}>Mobile</option>
                  <option value="landline" ${f['phone_type_'+i]==='landline'?'selected':''}>Landline</option>
                  <option value="voip" ${f['phone_type_'+i]==='voip'?'selected':''}>VoIP</option>
                </select>
                <select name="phone_status_${i}" style="padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit;background:#fff">
                  <option value="unknown">Status</option>
                  <option value="correct" ${f['phone_status_'+i]==='correct'?'selected':''}>Correct</option>
                  <option value="wrong" ${f['phone_status_'+i]==='wrong'?'selected':''}>Wrong</option>
                </select>
              </div>`).join('')}
            </div>
          </div>

          <div style="display:flex;gap:10px;justify-content:flex-end;border-top:1px solid #f0efe9;padding-top:14px">
            <a href="/records" class="btn btn-ghost" style="text-decoration:none">Cancel</a>
            <button type="submit" class="btn btn-primary">Create Property</button>
          </div>
        </form>
      </div>
    `, 'records'));
  } catch(e) {
    console.error('[records/_new GET]', e);
    res.status(500).send('Error: ' + e.message);
  }
});

router.post('/_new', requireAuth, async (req, res) => {
  const b = req.body || {};
  // Preserve all form values in the redirect on error so the user doesn't
  // lose what they typed. Builds a querystring of every posted field.
  // 2026-04-21 Bug #1 fix: stash form + err in session flash, redirect to
  // clean URL. GET /_new consumes + clears the flash on next render. This
  // replaces the old pattern of stuffing every field into a query string,
  // which overflowed on long inputs like a 3KB legal description.
  const backWith = (msg) => {
    if (req.session) req.session.newPropertyFlash = { err: msg, form: b };
    return '/records/_new';
  };

  try {
    // ── Validate required fields ───────────────────────────────────────────
    const street = (b.street || '').trim();
    const city   = (b.city || '').trim();
    const stateRaw = (b.state_code || '').trim();
    const zipRaw = (b.zip_code || '').trim();
    if (!street) return res.redirect(backWith('Street is required'));
    if (!city)   return res.redirect(backWith('City is required'));
    const stateNorm = normalizeState(stateRaw);
    if (!stateNorm) return res.redirect(backWith(`"${stateRaw}" is not a valid US state`));
    const zipMatch = zipRaw.match(/^\d{5}/);
    if (!zipMatch) return res.redirect(backWith('ZIP must start with 5 digits'));
    const zipNorm = zipMatch[0];

    // ── Coerce numeric fields with bounds (same rules as importer) ─────────
    const MONEY_LIMIT = 9_999_999_999.99;
    const toMoney = v => { if (!v) return null; const n = parseFloat(String(v).replace(/[$,%]/g,'')); if (isNaN(n) || Math.abs(n) > MONEY_LIMIT) return null; return n; };
    const toInt   = v => { if (!v) return null; const n = parseInt(String(v).replace(/[$,%]/g,''), 10); return isNaN(n) ? null : n; };
    const toYear  = v => { const n = toInt(v); if (n === null || n < 1800 || n > 2200) return null; return n; };
    const toSmallInt = v => { const n = toInt(v); if (n === null || n < -32768 || n > 32767) return null; return n; };
    const toBath  = v => { if (!v) return null; const n = parseFloat(v); if (isNaN(n) || n < 0 || n > 99) return null; return n; };
    const toPct   = v => { if (!v) return null; const n = parseFloat(v); if (isNaN(n) || n < -100 || n > 100) return null; return n; };
    const toBool  = v => { const s = (v||'').toLowerCase(); return s==='true' ? true : s==='false' ? false : null; };

    const yearBuilt = toYear(b.year_built);
    const sqft      = toInt(b.sqft);
    const beds      = toSmallInt(b.bedrooms);
    const baths     = toBath(b.bathrooms);
    const lotSize   = toInt(b.lot_size);
    const estValue  = toMoney(b.estimated_value);
    const assValue  = toMoney(b.assessed_value);
    const lastSaleP = toMoney(b.last_sale_price);
    const equityP   = toPct(b.equity_percent);
    const vacantV   = toBool(b.vacant);
    const lastSaleDate = b.last_sale_date && /^\d{4}-\d{2}-\d{2}$/.test(b.last_sale_date) ? b.last_sale_date : null;
    const propType  = (b.property_type || '').trim().slice(0, 50) || null;
    const county    = (b.county || '').trim().slice(0, 100) || null;

    // 2026-04-21 Bug #2 fix: wrap property + market + contact + phone writes
    // in a single transaction. Without this, two concurrent POSTs could both
    // observe "no primary contact exists" on line ~1445, both INSERT a new
    // contact row, and the second's property_contacts INSERT would succeed
    // via ON CONFLICT DO UPDATE — leaving the first request's contact as an
    // orphan (a contact row with no property_contacts link). A transaction
    // serializes the read-modify-write pattern so only one wins.
    const client = await pool.connect();
    let propId, wasExisting, contactId = null;
    try {
      await client.query('BEGIN');
      // ── Lookup or create market ────────────────────────────────────────────
      const mktRes = await client.query(`SELECT id FROM markets WHERE state_code = $1 LIMIT 1`, [stateNorm]);
      let mktId = mktRes.rows[0]?.id || null;
      if (!mktId) {
        const ins = await client.query(`INSERT INTO markets (state_code, name, state_name) VALUES ($1,$1,$1) ON CONFLICT (state_code) DO UPDATE SET state_code=EXCLUDED.state_code RETURNING id`, [stateNorm]);
        mktId = ins.rows[0].id;
      }

      // ── Insert or reuse property (ON CONFLICT on the 4-column address key) ─
      const propRes = await client.query(`
        INSERT INTO properties (street, city, state_code, zip_code, county, market_id,
                                source, property_type, year_built, sqft, bedrooms, bathrooms, lot_size,
                                assessed_value, estimated_value, equity_percent,
                                last_sale_date, last_sale_price, vacant, first_seen_at)
        VALUES ($1,$2,$3,$4,$5,$6,'manual',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW())
        ON CONFLICT (street, city, state_code, zip_code) DO UPDATE SET
          county = COALESCE(EXCLUDED.county, properties.county),
          property_type = COALESCE(EXCLUDED.property_type, properties.property_type),
          year_built = COALESCE(EXCLUDED.year_built, properties.year_built),
          sqft = COALESCE(EXCLUDED.sqft, properties.sqft),
          bedrooms = COALESCE(EXCLUDED.bedrooms, properties.bedrooms),
          bathrooms = COALESCE(EXCLUDED.bathrooms, properties.bathrooms),
          lot_size = COALESCE(EXCLUDED.lot_size, properties.lot_size),
          assessed_value = COALESCE(EXCLUDED.assessed_value, properties.assessed_value),
          estimated_value = COALESCE(EXCLUDED.estimated_value, properties.estimated_value),
          equity_percent = COALESCE(EXCLUDED.equity_percent, properties.equity_percent),
          last_sale_date = COALESCE(EXCLUDED.last_sale_date, properties.last_sale_date),
          last_sale_price = COALESCE(EXCLUDED.last_sale_price, properties.last_sale_price),
          vacant = COALESCE(EXCLUDED.vacant, properties.vacant),
          updated_at = NOW()
        RETURNING id, xmax`,
        [street, city, stateNorm, zipNorm, county, mktId, propType, yearBuilt, sqft, beds, baths, lotSize,
         assValue, estValue, equityP, lastSaleDate, lastSaleP, vacantV]
      );
      propId = propRes.rows[0].id;
      wasExisting = propRes.rows[0].xmax !== '0';

      // ── Optional primary contact ───────────────────────────────────────────
      const firstName = (b.first_name || '').trim();
      const lastName  = (b.last_name || '').trim();
      const hasContact = firstName || lastName || b.mailing_address || b.email_1;
      if (hasContact) {
        const mStateNorm = normalizeState(b.mailing_state || '');
        const mZipRaw = (b.mailing_zip || '').trim();
        const mZipMatch = mZipRaw.match(/^\d{5}/);
        const mZipNorm = mZipMatch ? mZipMatch[0] : '';
        const ownerType = inferOwnerType(firstName, lastName);

        // FOR UPDATE lock on the property_contacts row (if any) — this forces
        // any concurrent transaction doing the same lookup to wait for our
        // COMMIT, so the SELECT-then-INSERT pattern becomes race-safe.
        const existPC = await client.query(
          `SELECT contact_id FROM property_contacts WHERE property_id=$1 AND primary_contact=true LIMIT 1 FOR UPDATE`,
          [propId]
        );
        if (existPC.rows.length) {
          contactId = existPC.rows[0].contact_id;
          await client.query(`UPDATE contacts SET
            first_name = COALESCE(NULLIF($1,''), first_name),
            last_name  = COALESCE(NULLIF($2,''), last_name),
            mailing_address = COALESCE(NULLIF($3,''), mailing_address),
            mailing_city    = COALESCE(NULLIF($4,''), mailing_city),
            mailing_state   = COALESCE(NULLIF($5,''), mailing_state),
            mailing_zip     = COALESCE(NULLIF($6,''), mailing_zip),
            email_1 = COALESCE(NULLIF($7,''), email_1),
            email_2 = COALESCE(NULLIF($8,''), email_2),
            owner_type = COALESCE(owner_type, $9),
            updated_at = NOW()
            WHERE id = $10`,
            [firstName, lastName, (b.mailing_address||'').trim(), (b.mailing_city||'').trim(),
             mStateNorm, mZipNorm, (b.email_1||'').trim(), (b.email_2||'').trim(), ownerType, contactId]);
        } else {
          const cr = await client.query(`INSERT INTO contacts (first_name, last_name, mailing_address, mailing_city, mailing_state, mailing_zip, email_1, email_2, owner_type)
            VALUES ($1,$2,$3,$4,NULLIF($5,''),NULLIF($6,''),NULLIF($7,''),NULLIF($8,''),$9) RETURNING id`,
            [firstName, lastName, (b.mailing_address||'').trim(), (b.mailing_city||'').trim(),
             mStateNorm, mZipNorm, (b.email_1||'').trim(), (b.email_2||'').trim(), ownerType]);
          contactId = cr.rows[0].id;
          await client.query(`INSERT INTO property_contacts (property_id, contact_id, primary_contact) VALUES ($1,$2,true) ON CONFLICT (property_id, contact_id) DO UPDATE SET primary_contact=true`, [propId, contactId]);
        }

        // ── Optional phones ────────────────────────────────────────────────
        for (let i = 1; i <= 5; i++) {
          const raw = (b['phone_'+i] || '').trim();
          if (!raw) continue;
          const phoneNorm = normalizePhone(raw);
          if (!phoneNorm || phoneNorm.length < 7) continue;  // skip malformed
          const pType = ['mobile','landline','voip'].includes((b['phone_type_'+i]||'').toLowerCase()) ? b['phone_type_'+i].toLowerCase() : 'unknown';
          const pStatus = ['correct','wrong'].includes((b['phone_status_'+i]||'').toLowerCase()) ? b['phone_status_'+i].toLowerCase() : 'unknown';
          await client.query(`INSERT INTO phones (contact_id, phone_number, phone_index, phone_type, phone_status)
            VALUES ($1,$2,$3,$4,$5)
            ON CONFLICT (contact_id, phone_number) DO UPDATE SET
              phone_type = CASE WHEN EXCLUDED.phone_type <> 'unknown' THEN EXCLUDED.phone_type ELSE phones.phone_type END,
              phone_status = CASE WHEN EXCLUDED.phone_status <> 'unknown' THEN EXCLUDED.phone_status ELSE phones.phone_status END`,
            [contactId, phoneNorm, i, pType, pStatus]);
        }
      }

      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw txErr;
    } finally {
      client.release();
    }

    const msg = wasExisting
      ? `Updated existing property #${propId}`
      : `Created property #${propId}`;
    res.redirect(`/records/${propId}?msg=${encodeURIComponent(msg)}`);
  } catch(e) {
    console.error('[records/_new POST]', e);
    res.redirect(backWith('Create failed: ' + (e.message || 'unknown error')));
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORT — POST /records/export
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/export', requireAuth, async (req, res) => {
  try {
    await distress.ensureDistressSchema();
    const { columns, selectAll, filterParams, cleanPhonesOnly } = req.body;
    const ids = coerceIdArray(req.body.ids);
    if (!columns || !columns.length) return res.status(400).json({ error: 'No columns selected' });
    // Default ON if not provided — matches the checkbox default
    const excludeBadPhones = cleanPhonesOnly !== false;

    // 2026-04-20: Export is now one-row-per-contact (co-owners each get
    // their own row on a property). Cap is on distinct PROPERTY count, not
    // row count — so a property with 3 co-owners counts once toward the cap
    // but produces 3 rows in the CSV. 50k property cap keeps the worst
    // case bounded at ~500k rows if every property had 10 contacts.
    const EXPORT_MAX_PROPS = 50000;

    let props;
    if (selectAll) {
      const qs = new URLSearchParams(filterParams || '');
      // Tenant baseline — every bulk-action filter rebuild starts here
      // so the row set we act on can never include another tenant's data.
      // Filter-parity rule: every clause below this line must match the
      // GET / handler's filters.
      let conditions = [`p.tenant_id = $1`], params = [req.tenantId], idx = 2;
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
          AND COALESCE(p.street_normalized, LOWER(TRIM(p.street))) = COALESCE(c.mailing_address_normalized, LOWER(TRIM(c.mailing_address)))
          AND LOWER(TRIM(p.city)) = LOWER(TRIM(c.mailing_city))
          AND UPPER(TRIM(p.state_code)) = UPPER(TRIM(c.mailing_state))
          AND SUBSTRING(TRIM(p.zip_code) FROM 1 FOR 5) = SUBSTRING(TRIM(c.mailing_zip) FROM 1 FOR 5))`);
      } else if (occX === 'absent_owner') {
        conditions.push(`(c.mailing_address IS NOT NULL AND TRIM(c.mailing_address) != ''
          AND NOT (
            COALESCE(p.street_normalized, LOWER(TRIM(p.street))) = COALESCE(c.mailing_address_normalized, LOWER(TRIM(c.mailing_address)))
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
            AND LOWER(TRIM(split_part(cc_mkt.marketing_result, ' — ', 1))) = ANY($${paramIdx}::text[])
        )
        OR EXISTS (
          SELECT 1 FROM campaign_numbers cn_mkt
          JOIN phones ph_mkt ON ph_mkt.phone_number = cn_mkt.phone_number
          JOIN property_contacts pc_mkt ON pc_mkt.contact_id = ph_mkt.contact_id AND pc_mkt.property_id = p.id
          WHERE cn_mkt.marketing_result IS NOT NULL
            AND LOWER(TRIM(split_part(cn_mkt.marketing_result, ' — ', 1))) = ANY($${paramIdx}::text[])
        )
      )`;
      if (qv('mkt_result'))  { conditions.push(mktMatchExp_export(idx)); params.push(normMktList([qv('mkt_result')])); idx++; }
      const mktIncArr = qvAll('mkt_include');
      const mktExcArr = qvAll('mkt_exclude');
      if (mktIncArr.length > 0) {
        conditions.push(mktMatchExp_export(idx));
        params.push(normMktList(mktIncArr)); idx++;
      }
      if (mktExcArr.length > 0) {
        conditions.push(`NOT ${mktMatchExp_export(idx)}`);
        params.push(normMktList(mktExcArr)); idx++;
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
      // 2026-04-21 Feature 3 parity: Ownership Duration. Mirrors main list.
      const minYoX = safeInt(qv('min_years_owned')), maxYoX = safeInt(qv('max_years_owned'));
      if (minYoX !== null) {
        conditions.push(`p.last_sale_date IS NOT NULL AND EXTRACT(YEAR FROM AGE(CURRENT_DATE, p.last_sale_date)) >= $${idx}`);
        params.push(minYoX); idx++;
      }
      if (maxYoX !== null) {
        conditions.push(`p.last_sale_date IS NOT NULL AND EXTRACT(YEAR FROM AGE(CURRENT_DATE, p.last_sale_date)) <= $${idx}`);
        params.push(maxYoX); idx++;
      }
      // Tag filter
      // 2026-04-23 Tag Include/Exclude parity.
      const tagIncArr = qvAll('tag_include').map(v => parseInt(v,10)).filter(Number.isFinite);
      const tagExcArr = qvAll('tag_exclude').map(v => parseInt(v,10)).filter(Number.isFinite);
      // Legacy single-select fallback
      const legacyTag = parseInt(qv('tag'),10);
      if (Number.isFinite(legacyTag) && !tagIncArr.includes(legacyTag)) tagIncArr.push(legacyTag);
      if (tagIncArr.length > 0) {
        conditions.push(`EXISTS (SELECT 1 FROM property_tags pt_f WHERE pt_f.property_id = p.id AND pt_f.tag_id = ANY($${idx}::int[]))`);
        params.push(tagIncArr); idx++;
      }
      if (tagExcArr.length > 0) {
        conditions.push(`NOT EXISTS (SELECT 1 FROM property_tags pt_x WHERE pt_x.property_id = p.id AND pt_x.tag_id = ANY($${idx}::int[]))`);
        params.push(tagExcArr); idx++;
      }
      // 2026-04-21 phone_type + phone_tag parity filters.
      const VPT_SA = ['mobile','landline','voip','unknown'];
      const ptSA = qv('phone_type');
      if (ptSA && VPT_SA.includes(ptSA)) {
        conditions.push(`EXISTS (SELECT 1 FROM phones ph_pt JOIN property_contacts pc_pt ON pc_pt.contact_id = ph_pt.contact_id WHERE pc_pt.property_id = p.id AND LOWER(ph_pt.phone_type) = $${idx})`);
        params.push(ptSA); idx++;
      }
      // 2026-04-23 Phone Tag Include/Exclude parity.
      const ptagIncArr = qvAll('phone_tag_include').map(v => parseInt(v,10)).filter(Number.isFinite);
      const ptagExcArr = qvAll('phone_tag_exclude').map(v => parseInt(v,10)).filter(Number.isFinite);
      const legacyPtag = parseInt(qv('phone_tag'),10);
      if (Number.isFinite(legacyPtag) && !ptagIncArr.includes(legacyPtag)) ptagIncArr.push(legacyPtag);
      if (ptagIncArr.length > 0) {
        conditions.push(`EXISTS (SELECT 1 FROM phone_tag_links ptl_f JOIN phones ph_ptl ON ph_ptl.id = ptl_f.phone_id JOIN property_contacts pc_ptl ON pc_ptl.contact_id = ph_ptl.contact_id WHERE pc_ptl.property_id = p.id AND ptl_f.phone_tag_id = ANY($${idx}::int[]))`);
        params.push(ptagIncArr); idx++;
      }
      if (ptagExcArr.length > 0) {
        conditions.push(`NOT EXISTS (SELECT 1 FROM phone_tag_links ptl_x JOIN phones ph_ptlx ON ph_ptlx.id = ptl_x.phone_id JOIN property_contacts pc_ptlx ON pc_ptlx.contact_id = ph_ptlx.contact_id WHERE pc_ptlx.property_id = p.id AND ptl_x.phone_tag_id = ANY($${idx}::int[]))`);
        params.push(ptagExcArr); idx++;
      }
      // 2026-04-21 Feature 1 parity: Owner Type. Mirrors main list route.
      if (qv('owner_type') && VALID_OWNER_TYPES.includes(qv('owner_type'))) {
        conditions.push(`c.owner_type = $${idx}`);
        params.push(qv('owner_type')); idx++;
      }
      // 2026-04-21 Feature 6 parity: Clean vs Incomplete mailing address.
      // Keep this block identical to the main list route + delete/tag/RFL —
      // four code paths, one source of truth for the logic.
      const mailingX = qv('mailing');
      if (mailingX === 'clean') {
        conditions.push(`(
          c.mailing_address IS NOT NULL AND TRIM(c.mailing_address) <> ''
          AND c.mailing_city IS NOT NULL AND TRIM(c.mailing_city) <> ''
          AND c.mailing_state IS NOT NULL AND TRIM(c.mailing_state) <> ''
          AND c.mailing_zip IS NOT NULL AND TRIM(c.mailing_zip) <> ''
        )`);
      } else if (mailingX === 'incomplete') {
        conditions.push(`(
          c.id IS NULL
          OR c.mailing_address IS NULL OR TRIM(COALESCE(c.mailing_address,'')) = ''
          OR c.mailing_city    IS NULL OR TRIM(COALESCE(c.mailing_city,''))    = ''
          OR c.mailing_state   IS NULL OR TRIM(COALESCE(c.mailing_state,''))   = ''
          OR c.mailing_zip     IS NULL OR TRIM(COALESCE(c.mailing_zip,''))     = ''
        )`);
      }
      const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
      // 2026-04-20: one-row-per-contact export.
      // Property cap: outer CTE picks up to EXPORT_MAX_PROPS distinct properties.
      // Fan-out: LEFT JOIN against all contacts (primary + co-owners). The
      // LEFT JOIN covers properties with zero contacts — they still get one
      // row with blank name/email columns.
      // Ordering: primary contact first within each property so downstream
      // consumers can rely on "first row for a property is the primary."
      props = await query(`
        WITH limited_props AS (
          SELECT DISTINCT p.id FROM properties p
          LEFT JOIN property_contacts pc ON pc.property_id = p.id AND pc.primary_contact = true
          LEFT JOIN contacts c ON c.id = pc.contact_id
          ${where}
          ORDER BY p.id DESC
          LIMIT ${EXPORT_MAX_PROPS}
        )
        SELECT
          p.id, p.street, p.city, p.state_code, p.zip_code, p.county,
          p.property_type, p.year_built, p.sqft, p.bedrooms, p.bathrooms,
          p.assessed_value, p.estimated_value, p.equity_percent,
          p.property_status, p.pipeline_stage, p.condition,
          p.last_sale_date, p.last_sale_price, p.marketing_result,
          p.distress_score, p.distress_band,
          p.source, p.created_at,
          -- 2026-04-21 Feature 2: Additional Info fields. Safe to SELECT
          -- unconditionally — even if the checkbox is unchecked, the CSV emit
          -- loop skips columns not in the columns array. Bytes on the wire are
          -- negligible vs. the round-trip savings of one SELECT.
          p.stories, p.structure_type, p.apn, p.legal_description,
          p.total_tax_owed, p.tax_delinquent_year, p.tax_auction_date,
          p.deed_type, p.lien_type, p.lien_date,
          c.id AS contact_id,
          c.first_name, c.last_name,
          -- 2026-04-21 Feature 1: owner_type for export
          c.owner_type,
          c.mailing_address, c.mailing_city, c.mailing_state, c.mailing_zip,
          c.email_1, c.email_2,
          COALESCE(pc.primary_contact, false) AS is_primary,
          (SELECT COUNT(*) FROM property_lists pl WHERE pl.property_id = p.id) AS list_count
        FROM properties p
        JOIN limited_props lp ON lp.id = p.id
        LEFT JOIN property_contacts pc ON pc.property_id = p.id
        LEFT JOIN contacts c ON c.id = pc.contact_id
        ORDER BY p.id DESC, pc.primary_contact DESC NULLS LAST, c.id ASC
      `, params);
    } else {
      if (!ids || !ids.length) return res.status(400).json({ error: 'No IDs provided' });
      // Bound the ids list — anything over EXPORT_MAX_PROPS is dropped defensively.
      const cleanIds = ids
        .map(n => parseInt(n))
        .filter(n => !isNaN(n) && n > 0)
        .slice(0, EXPORT_MAX_PROPS);
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
          -- 2026-04-21 Feature 2: Additional Info (mirrors selectAll branch — keep in sync)
          p.stories, p.structure_type, p.apn, p.legal_description,
          p.total_tax_owed, p.tax_delinquent_year, p.tax_auction_date,
          p.deed_type, p.lien_type, p.lien_date,
          c.id AS contact_id,
          c.first_name, c.last_name,
          c.owner_type,  -- 2026-04-21 Feature 1
          c.mailing_address, c.mailing_city, c.mailing_state, c.mailing_zip,
          c.email_1, c.email_2,
          COALESCE(pc.primary_contact, false) AS is_primary,
          (SELECT COUNT(*) FROM property_lists pl WHERE pl.property_id = p.id) AS list_count
        FROM properties p
        LEFT JOIN property_contacts pc ON pc.property_id = p.id
        LEFT JOIN contacts c ON c.id = pc.contact_id
        WHERE p.id = ANY($1::int[])
        ORDER BY p.id DESC, pc.primary_contact DESC NULLS LAST, c.id ASC
      `, [cleanIds]);
    }

    // Fetch phones per CONTACT (one-row-per-contact export — each row
    // shows only the phones for the contact on that row, not the pool of
    // every contact's phones on the property).
    // Collect unique contact_ids from props.rows (some may be null if a
    // property has zero contacts — those rows show blank phones).
    const allContactIds = [...new Set(
      props.rows.map(r => r.contact_id).filter(cid => cid != null)
    )];
    const phoneMapByContact = {};
    if (columns.includes('phones') && allContactIds.length) {
      // LEFT JOIN against nis_numbers so we can mark phones as "dead" even if
      // the master phones.phone_status wasn't synced from the campaign flow.
      // is_nis = true for any phone that appears in the NIS registry (any count).
      const phoneRes = await query(`
        SELECT
          ph.phone_number,
          ph.phone_status,
          ph.phone_index,
          ph.wrong_number,
          ph.contact_id,
          (nis.phone_number IS NOT NULL) AS is_nis
        FROM phones ph
        LEFT JOIN nis_numbers nis ON nis.phone_number = ph.phone_number
        WHERE ph.contact_id = ANY($1::int[])
        ORDER BY ph.phone_index ASC
      `, [allContactIds]);
      phoneRes.rows.forEach(ph => {
        if (!phoneMapByContact[ph.contact_id]) phoneMapByContact[ph.contact_id] = [];
        phoneMapByContact[ph.contact_id].push({
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
        for (const cid in phoneMapByContact) {
          const before = phoneMapByContact[cid].length;
          phoneMapByContact[cid] = phoneMapByContact[cid].filter(p =>
            !isBadStatus(p.status) && !p.isNis && !p.isWrong
          );
          removed += (before - phoneMapByContact[cid].length);
        }
        console.log(`[export] Clean-phones mode: removed ${removed} wrong/dead/NIS phones, shifted remaining up`);
      }

      console.log(`[export] Fetched ${phoneRes.rows.length} phones across ${Object.keys(phoneMapByContact).length}/${allContactIds.length} contacts`);
    }

    const colLabels = {
      street: 'Street Address', city: 'City', state_code: 'State', zip_code: 'ZIP', county: 'County',
      first_name: 'Owner First Name', last_name: 'Owner Last Name',
      owner_type: 'Owner Type',  // 2026-04-21 Feature 1
      is_primary: 'Primary Owner',
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
      // 2026-04-21 Feature 2: Additional Info labels
      stories: 'Stories', structure_type: 'Structure Type', apn: 'APN', legal_description: 'Legal Description',
      total_tax_owed: 'Total Tax Owed', tax_delinquent_year: 'Tax Delinquent Year', tax_auction_date: 'Tax Auction Date',
      deed_type: 'Deed Type', lien_type: 'Lien Type', lien_date: 'Lien Date',
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
      // Phones belong to the CONTACT on this row, not the property.
      // If the row has no contact_id (property with zero contacts), no phones.
      const phoneList = (row.contact_id && phoneMapByContact[row.contact_id]) || [];
      return expandedColumns.map(col => {
        let val = '';
        if (col.startsWith('__phonestatus_')) {
          const slot = parseInt(col.replace('__phonestatus_', ''), 10);
          val = phoneList[slot - 1]?.status || '';
        } else if (col.startsWith('__phone_')) {
          const slot = parseInt(col.replace('__phone_', ''), 10);
          val = phoneList[slot - 1]?.number || '';
        } else if (col === 'last_sale_date' || col === 'created_at' || col === 'lien_date' || col === 'tax_auction_date') {
          // 2026-04-21 Feature 2: lien_date + tax_auction_date join the existing
          // date-render branch so they format as "M/D/YYYY" in the CSV (matching
          // last_sale_date + created_at). Keep this list in sync with any new
          // DATE columns added to the SELECTs above.
          val = row[col] ? new Date(row[col]).toLocaleDateString('en-US') : '';
        } else if (col === 'distress_band') {
          // Render as nice label ("Burning" not "burning")
          const labels = { burning: 'Burning', hot: 'Hot', warm: 'Warm', cold: 'Cold' };
          val = row[col] ? (labels[row[col]] || row[col]) : '';
        } else if (col === 'is_primary') {
          // Render the co-owner flag as a human-readable Yes/No
          val = row.is_primary ? 'Yes' : 'No';
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

    // 2026-04-23 Owner 2: split contacts by primary_contact flag, not row
    // position. rows[0] is the primary ONLY when primary_contact=true — if a
    // property somehow has only secondary contacts (blank Owner 1 name on
    // import), rows[0] would be a secondary and we'd render it wrong.
    const primaryContact    = contactRes.rows.find(r => r.primary_contact) || null;
    const secondaryContacts = contactRes.rows.filter(r => !r.primary_contact);
    let phones = [];
    if (primaryContact) {
      const phoneRes = await query(`
        SELECT * FROM phones WHERE contact_id = $1 ORDER BY phone_index ASC
      `, [primaryContact.id]);
      phones = phoneRes.rows;
      // Attach phone tags (new 2026-04-21). One query for all phones at once
      // to avoid N+1 on the detail page. Each phone gets .tags = [{id,name,color}, ...].
      if (phones.length) {
        const phoneIds = phones.map(p => p.id);
        const ptRes = await query(
          `SELECT ptl.phone_id, pt.id, pt.name, pt.color
             FROM phone_tag_links ptl
             JOIN phone_tags pt ON pt.id = ptl.phone_tag_id
            WHERE ptl.phone_id = ANY($1::int[])
            ORDER BY pt.name ASC`,
          [phoneIds]
        );
        const tagsByPhone = {};
        for (const r of ptRes.rows) {
          if (!tagsByPhone[r.phone_id]) tagsByPhone[r.phone_id] = [];
          tagsByPhone[r.phone_id].push({ id: r.id, name: r.name, color: r.color });
        }
        for (const p of phones) p.tags = tagsByPhone[p.id] || [];
      }
    }

    // 2026-04-23 Owner 2: fetch phones for each secondary contact.
    for (const sc of secondaryContacts) {
      const scPhoneRes = await query(
        `SELECT * FROM phones WHERE contact_id = $1 ORDER BY phone_index ASC`,
        [sc.id]
      );
      sc.phones = scPhoneRes.rows;
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
      // 2026-04-21 phone_type chip. Clickable — opens an inline popover with
      // a dropdown to manually correct the type if the CSV got it wrong or
      // the source data had no type column. Saves immediately on change.
      const ptRaw = (ph.phone_type || 'unknown').toLowerCase();
      const ptLabel = ptRaw === 'mobile'   ? 'Mobile'
                   : ptRaw === 'landline' ? 'Landline'
                   : ptRaw === 'voip'     ? 'VoIP'
                   : 'Unknown';
      const ptColor = ptRaw === 'mobile'   ? { bg:'#e8f5ee', text:'#1a7a4a' }
                    : ptRaw === 'landline' ? { bg:'#e8f0ff', text:'#2c5cc5' }
                    : ptRaw === 'voip'     ? { bg:'#fff8e1', text:'#9a6800' }
                    :                        { bg:'#f0efe9', text:'#888'    };
      const typeChip = `<span class="phone-type-chip" data-phone-id="${ph.id}" onclick="togglePhoneTypePopover(${ph.id}, event)" title="Click to change phone type" style="font-size:10px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;padding:3px 7px;border-radius:4px;background:${ptColor.bg};color:${ptColor.text};cursor:pointer;user-select:none">${ptLabel}</span>`;

      // Phone tag pills — each is removable (hover shows ×)
      const phoneTagPills = (ph.tags || []).map(t => `
        <span class="phone-tag-pill" data-tag-id="${t.id}" style="display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:500;padding:3px 4px 3px 7px;border-radius:4px;background:${escHTML(t.color)}22;color:${escHTML(t.color)};border:1px solid ${escHTML(t.color)}55">
          <span>${escHTML(t.name)}</span>
          <button type="button" onclick="removePhoneTag(${ph.id}, ${t.id})" title="Remove tag" style="background:none;border:none;cursor:pointer;padding:0 2px;color:inherit;font-size:13px;line-height:1;opacity:.6" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=.6">×</button>
        </span>
      `).join('');

      return `<div class="phone-row" data-phone-id="${ph.id}" style="flex-direction:column;align-items:stretch;gap:6px">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
          <span class="phone-num">${ph.phone_number}</span>
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            ${typeChip}
            <span class="phone-status ${statusClass}">${ph.phone_status || 'Unknown'}</span>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;position:relative">
          ${phoneTagPills}
          <button type="button" onclick="openPhoneTagInput(${ph.id})" id="ptag-addbtn-${ph.id}" style="font-size:10px;font-weight:500;padding:3px 8px;border-radius:4px;background:#fafaf8;color:#888;border:1px dashed #ccc;cursor:pointer;font-family:inherit">+ tag</button>
          <div id="ptag-input-wrap-${ph.id}" style="display:none;position:relative">
            <input type="text" id="ptag-input-${ph.id}" placeholder="Type tag…" autocomplete="off"
              style="font-size:11px;padding:3px 8px;border:1px solid #ddd;border-radius:4px;font-family:inherit;width:140px"
              oninput="phoneTagSuggest(${ph.id}, this.value)"
              onfocus="phoneTagSuggest(${ph.id}, this.value)"
              onclick="phoneTagSuggest(${ph.id}, this.value)"
              onkeydown="if(event.key==='Enter'){event.preventDefault();addPhoneTagFromInput(${ph.id});}else if(event.key==='Escape'){closePhoneTagInput(${ph.id});}">
            <div id="ptag-suggest-${ph.id}" style="display:none;position:absolute;top:100%;left:0;right:0;margin-top:3px;background:#fff;border:1px solid #ddd;border-radius:6px;box-shadow:0 2px 10px rgba(0,0,0,.08);max-height:180px;overflow-y:auto;z-index:50;min-width:160px"></div>
          </div>
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

      <!-- OWNER 1 + OWNER 2 side by side -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:1.25rem;margin-bottom:1.25rem;align-items:start">
        <div class="card">
          <div class="sec-lbl">Owner ${primaryContact?.id ? `<a href="/owners/${primaryContact.id}" style="font-size:11px;color:#1a4a9a;text-decoration:none;font-weight:500;margin-left:8px;text-transform:none;letter-spacing:0">→ View Owner Dashboard</a>` : ''}</div>
          <div class="kv-grid" style="margin-bottom:1.25rem">
            <div class="kv"><div class="kv-label">First Name</div><div class="kv-val">${primaryContact?.id ? `<a href="/owners/${primaryContact.id}" style="color:#1a4a9a;text-decoration:none">${primaryContact?.first_name || '—'}</a>` : (primaryContact?.first_name || '—')}</div></div>
            <div class="kv"><div class="kv-label">Last Name</div><div class="kv-val">${primaryContact?.id ? `<a href="/owners/${primaryContact.id}" style="color:#1a4a9a;text-decoration:none">${primaryContact?.last_name || '—'}</a>` : (primaryContact?.last_name || '—')}</div></div>
            ${(() => {
              // 2026-04-21 Feature 1: Owner Type badge on detail card.
              // Matches the Records-table palette so users see the same visual cue.
              const ot = primaryContact?.owner_type;
              if (!ot) return '<div class="kv"><div class="kv-label">Owner Type</div><div class="kv-val" style="color:#aaa">—</div></div>';
              const colors = {
                Person:  { bg:'#f0efe9', text:'#555'    },
                Company: { bg:'#e8f0ff', text:'#2c5cc5' },
                Trust:   { bg:'#f3e8ff', text:'#6f42c1' },
              };
              const c = colors[ot] || colors.Person;
              return `<div class="kv"><div class="kv-label">Owner Type</div><div class="kv-val"><span style="background:${c.bg};color:${c.text};padding:3px 10px;border-radius:5px;font-size:11px;font-weight:600;display:inline-block">${ot}</span></div></div>`;
            })()}
            <div class="kv" style="grid-column:1/-1"><div class="kv-label">Mailing Address</div><div class="kv-val">${mailingAddr || '—'}</div></div>
            ${primaryContact?.email_1 ? `<div class="kv"><div class="kv-label">Email 1</div><div class="kv-val" style="word-break:break-all;overflow-wrap:anywhere;min-width:0"><a href="mailto:${primaryContact.email_1}" style="color:#1a4a9a">${primaryContact.email_1}</a></div></div>` : ''}
            ${primaryContact?.email_2 ? `<div class="kv"><div class="kv-label">Email 2</div><div class="kv-val" style="word-break:break-all;overflow-wrap:anywhere;min-width:0"><a href="mailto:${primaryContact.email_2}" style="color:#1a4a9a">${primaryContact.email_2}</a></div></div>` : ''}
          </div>
          <div class="sec-lbl">Phone Numbers <span class="count-pill">${phones.length}</span></div>
          ${phoneHTML}
        </div>

        ${secondaryContacts.map(sc => {
          const scPhoneHTML = sc.phones && sc.phones.length ? sc.phones.map(ph => {
            const statusClass = {unknown:'ps-unknown',correct:'ps-correct',wrong:'ps-wrong',dead:'ps-dead'}[ph.phone_status?.toLowerCase()] || 'ps-unknown';
            const ptRaw   = (ph.phone_type || 'unknown').toLowerCase();
            const ptLabel = ptRaw === 'mobile' ? 'Mobile' : ptRaw === 'landline' ? 'Landline' : ptRaw === 'voip' ? 'VoIP' : 'Unknown';
            const ptColor = ptRaw === 'mobile'   ? { bg:'#e8f5ee', text:'#1a7a4a' }
                          : ptRaw === 'landline' ? { bg:'#e8f0ff', text:'#2c5cc5' }
                          : ptRaw === 'voip'     ? { bg:'#fff8e1', text:'#9a6800' }
                          :                        { bg:'#f0efe9', text:'#888'    };
            return `<div class="phone-row" style="flex-direction:column;align-items:stretch;gap:4px">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
                <span class="phone-num">${ph.phone_number}</span>
                <div style="display:flex;align-items:center;gap:6px">
                  <span style="font-size:10px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;padding:3px 7px;border-radius:4px;background:${ptColor.bg};color:${ptColor.text}">${ptLabel}</span>
                  <span class="phone-status ${statusClass}">${ph.phone_status || 'Unknown'}</span>
                </div>
              </div>
            </div>`;
          }).join('') : '<div style="color:#aaa;font-size:13px">No phones on record</div>';
          const scOt = sc.owner_type;
          const scOtColors = { Person:{bg:'#f0efe9',text:'#555'}, Company:{bg:'#e8f0ff',text:'#2c5cc5'}, Trust:{bg:'#f3e8ff',text:'#6f42c1'} };
          const scOtC = scOtColors[scOt] || scOtColors.Person;
          // Bug fix 2026-04-23: escape all DB-sourced values before rendering —
          // CSV imports can contain arbitrary strings including HTML.
          const scFirstSafe = escHTML(sc.first_name || '');
          const scLastSafe  = escHTML(sc.last_name  || '');
          const scEmail1Safe = escHTML(sc.email_1 || '');
          // Secondary contacts created from Owner 2 columns don't carry a
          // separate mailing address — the CSV has one mailing address per row
          // (Owner 1's). Show mailing addr only if it's actually populated.
          const scMailingParts = [sc.mailing_address, sc.mailing_city, sc.mailing_state, sc.mailing_zip].filter(Boolean);
          const scMailingAddrSafe = scMailingParts.length ? escHTML(scMailingParts.join(', ')) : '';
          return `<div class="card" style="border-left:3px solid #e8f0ff">
            <div class="sec-lbl" style="display:flex;align-items:center;gap:8px">
              Co-Owner
              <span style="font-size:10px;font-weight:500;color:#888;text-transform:none;letter-spacing:0">(Owner 2)</span>
            </div>
            <div class="kv-grid" style="margin-bottom:1.25rem">
              <div class="kv"><div class="kv-label">First Name</div><div class="kv-val">${scFirstSafe || '—'}</div></div>
              <div class="kv"><div class="kv-label">Last Name</div><div class="kv-val">${scLastSafe || '—'}</div></div>
              ${scOt ? `<div class="kv"><div class="kv-label">Owner Type</div><div class="kv-val"><span style="background:${scOtC.bg};color:${scOtC.text};padding:3px 10px;border-radius:5px;font-size:11px;font-weight:600;display:inline-block">${escHTML(scOt)}</span></div></div>` : ''}
              ${scMailingAddrSafe ? `<div class="kv" style="grid-column:1/-1"><div class="kv-label">Mailing Address</div><div class="kv-val">${scMailingAddrSafe}</div></div>` : ''}
              ${scEmail1Safe ? `<div class="kv"><div class="kv-label">Email 1</div><div class="kv-val" style="word-break:break-all;overflow-wrap:anywhere;min-width:0"><a href="mailto:${scEmail1Safe}" style="color:#1a4a9a">${scEmail1Safe}</a></div></div>` : ''}
            </div>
            <div class="sec-lbl">Phone Numbers <span class="count-pill">${sc.phones ? sc.phones.length : 0}</span></div>
            ${scPhoneHTML}
          </div>`;
        }).join('')}
      </div>

      <!-- PROPERTY DETAILS + OTHER CARDS -->
      <div class="grid-2" style="margin-bottom:1.25rem">
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
            <!-- 2026-04-21 Feature 3: Ownership Duration derived from
                 last_sale_date. Uses the same calendar-year calculation
                 semantics as the filter's SQL (EXTRACT(YEAR FROM AGE(...)))
                 — subtract year, subtract 1 more if the anniversary hasn't
                 passed yet this year. This matches Postgres exactly so the
                 displayed number always agrees with the filter's result. -->
            <div class="kv"><div class="kv-label">Years Owned</div><div class="kv-val">${
              p.last_sale_date
                ? (() => {
                    const sale = new Date(p.last_sale_date);
                    const now = new Date();
                    if (sale > now) return '—';  // future-dated sale, unknown state
                    let years = now.getFullYear() - sale.getFullYear();
                    const monthDiff = now.getMonth() - sale.getMonth();
                    if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < sale.getDate())) {
                      years--;
                    }
                    return `${years} year${years === 1 ? '' : 's'}`;
                  })()
                : '—'
            }</div></div>
          </div>
        </div>
      </div>

      <!-- ADDITIONAL INFO (Feature 2 — new 2026-04-21) -->
      <div class="card" style="margin-bottom:1.25rem">
        <div class="sec-lbl">Additional Info</div>
        <div class="kv-grid">
          <div class="kv"><div class="kv-label">Stories</div><div class="kv-val">${fmt(p.stories)}</div></div>
          <div class="kv"><div class="kv-label">Structure Type</div><div class="kv-val">${fmt(p.structure_type)}</div></div>
          <div class="kv"><div class="kv-label">APN</div><div class="kv-val" style="font-family:monospace;font-size:13px">${fmt(p.apn)}</div></div>
          <div class="kv"><div class="kv-label">Deed Type</div><div class="kv-val">${fmt(p.deed_type)}</div></div>
          <div class="kv"><div class="kv-label">Lien Type</div><div class="kv-val" style="${p.lien_type?'color:#9a6800':''}">${fmt(p.lien_type)}</div></div>
          <div class="kv"><div class="kv-label">Lien Date</div><div class="kv-val">${fmtDate(p.lien_date)}</div></div>
          <div class="kv"><div class="kv-label">Total Tax Owed</div><div class="kv-val" style="${p.total_tax_owed?'color:#c0392b;font-weight:600':''}">${fmtMoney(p.total_tax_owed)}</div></div>
          <div class="kv"><div class="kv-label">Tax Delinquent Year</div><div class="kv-val">${fmt(p.tax_delinquent_year)}</div></div>
          <div class="kv"><div class="kv-label">Tax Auction Date</div><div class="kv-val" style="${p.tax_auction_date?'color:#c0392b;font-weight:600':''}">${fmtDate(p.tax_auction_date)}</div></div>
        </div>
        ${p.legal_description ? `
        <div style="margin-top:14px;padding-top:14px;border-top:1px solid #f0efe9">
          <div class="kv-label" style="margin-bottom:4px">Legal Description</div>
          <div style="font-size:13px;color:#333;line-height:1.5;font-family:monospace;background:#fafaf8;padding:10px 12px;border-radius:7px;border:1px solid #f0efe9;white-space:pre-wrap">${escHTML(p.legal_description)}</div>
        </div>` : ''}
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
          <input type="text" id="tag-input" placeholder="Click to browse, or type to add a tag…" autocomplete="off"
            style="flex:1;padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit"
            oninput="suggestTags(this.value)"
            onfocus="suggestTagsOnFocus()"
            onclick="suggestTagsOnFocus()"
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

            <!-- 2026-04-21 Feature 2: Additional Info section in edit modal.
                 Leave every field value empty when the underlying column is NULL
                 so the POST handler COALESCE(NULLIF) pattern treats "user did not
                 touch it" the same as "field is empty" and preserves the existing
                 DB value instead of clobbering it. -->
            <div style="font-size:12px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.06em;margin:14px 0 10px">Additional Info</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
              <div class="form-field" style="margin:0"><label>Stories</label><input type="number" min="0" max="100" name="stories" value="${p.stories||''}"></div>
              <div class="form-field" style="margin:0"><label>Structure Type</label><input type="text" name="structure_type" value="${p.structure_type||''}" placeholder="e.g. Single Family, Duplex, Warehouse"></div>
              <div class="form-field" style="margin:0"><label>APN</label><input type="text" name="apn" value="${p.apn||''}" placeholder="Parcel number"></div>
              <div class="form-field" style="margin:0"><label>Deed Type</label><input type="text" name="deed_type" value="${p.deed_type||''}" placeholder="e.g. Warranty, Quitclaim"></div>
              <div class="form-field" style="margin:0"><label>Lien Type</label><input type="text" name="lien_type" value="${p.lien_type||''}" placeholder="e.g. Tax, Mechanic, Judgment"></div>
              <div class="form-field" style="margin:0"><label>Lien Date</label><input type="date" name="lien_date" value="${p.lien_date ? String(p.lien_date).split('T')[0] : ''}"></div>
              <div class="form-field" style="margin:0"><label>Total Tax Owed ($)</label><input type="number" step="0.01" name="total_tax_owed" value="${p.total_tax_owed||''}"></div>
              <div class="form-field" style="margin:0"><label>Tax Delinquent Year</label><input type="number" min="1900" max="2100" name="tax_delinquent_year" value="${p.tax_delinquent_year||''}" placeholder="YYYY"></div>
              <div class="form-field" style="margin:0"><label>Tax Auction Date</label><input type="date" name="tax_auction_date" value="${p.tax_auction_date ? String(p.tax_auction_date).split('T')[0] : ''}"></div>
              <div class="form-field" style="margin:0;grid-column:1/-1"><label>Legal Description</label><textarea name="legal_description" rows="2" placeholder="County legal description (lot/block/subdivision)" style="width:100%;padding:9px 12px;border:1px solid #ddd;border-radius:8px;font-size:14px;background:#fafaf8;color:#1a1a1a;font-family:inherit;resize:vertical">${p.legal_description||''}</textarea></div>
            </div>

            ${primaryContact ? `
            <div style="font-size:12px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.06em;margin:14px 0 10px">Owner</div>
            <input type="hidden" name="contact_id" value="${primaryContact.id}">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
              <div class="form-field" style="margin:0"><label>First Name</label><input type="text" name="first_name" value="${primaryContact.first_name||''}"></div>
              <div class="form-field" style="margin:0"><label>Last Name</label><input type="text" name="last_name" value="${primaryContact.last_name||''}"></div>
              <div class="form-field" style="margin:0;grid-column:1/-1"><label>Owner Type</label>
                <select name="owner_type">
                  <option value="">— Auto-detect on save if blank —</option>
                  <option value="Person"  ${primaryContact.owner_type==='Person' ?'selected':''}>Person</option>
                  <option value="Company" ${primaryContact.owner_type==='Company'?'selected':''}>Company (LLC / Corp / Inc)</option>
                  <option value="Trust"   ${primaryContact.owner_type==='Trust'  ?'selected':''}>Trust</option>
                </select>
                <span style="font-size:10px;color:#aaa">Leave blank to re-infer from name on save</span>
              </div>
              <div class="form-field" style="margin:0;grid-column:1/-1"><label>Mailing Address</label><input type="text" name="mailing_address" value="${primaryContact.mailing_address||''}"></div>
              <div class="form-field" style="margin:0"><label>Mailing City</label><input type="text" name="mailing_city" value="${primaryContact.mailing_city||''}"></div>
              <div class="form-field" style="margin:0"><label>Mailing State</label>
                <select name="mailing_state">
                  <option value="">—</option>
                  ${Array.from(VALID_STATES).sort().map(s => `<option value="${s}" ${(primaryContact.mailing_state||'').toUpperCase()===s?'selected':''}>${s}</option>`).join('')}
                </select>
              </div>
              <div class="form-field" style="margin:0"><label>Mailing Zip</label><input type="text" name="mailing_zip" value="${primaryContact.mailing_zip||''}" maxlength="10" placeholder="5 or 9 digits"></div>
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

      <script src="/js/records-detail.js?v=4"></script>
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
      // Feature 2 Additional Info — 10 new columns
      stories, structure_type, apn, legal_description,
      total_tax_owed, tax_delinquent_year, tax_auction_date,
      deed_type, lien_type, lien_date,
      // Owner fields (Feature 1 adds owner_type; mailing_zip was missing from old form)
      contact_id, first_name, last_name, owner_type: rawOwnerType,
      mailing_address, mailing_city,
      mailing_state: rawMailingState, mailing_zip,
      email_1, email_2, edit_notes
    } = req.body;

    // 2026-04-20 audit fix #4: validate mailing_state through normalizeState.
    // Pre-fix, whatever text the user typed was stored verbatim — including
    // full names like "California", typos like "CAA", or pure garbage. The
    // filter's UPPER(TRIM(c.mailing_state)) compare then silently dropped
    // every record where mailing_state wasn't a clean 2-letter USPS code.
    // Behavior: accept 2-letter codes and full names (normalizeState handles
    // both), reject everything else. If the user submitted garbage we just
    // skip updating that one column — the rest of the edit still applies.
    let mailing_state = rawMailingState;
    let mailingStateRejected = false;
    if (rawMailingState != null && String(rawMailingState).trim() !== '') {
      const normed = normalizeState(rawMailingState);
      if (normed) {
        mailing_state = normed;
      } else {
        mailing_state = '';  // blank-out so COALESCE(NULLIF($,'' ), ...) preserves prior
        mailingStateRejected = true;
        console.warn(`[records/edit] rejected invalid mailing_state "${rawMailingState}" on property ${id}`);
      }
    }

    // 2026-04-21 Feature 1: owner_type resolution.
    //   - If the user explicitly picked Person / Company / Trust, honor it.
    //   - If the user left it blank AND first/last name were provided, re-infer
    //     from the submitted name (useful after a name correction).
    //   - If blank and no name change, leave column untouched via blank string
    //     → COALESCE(NULLIF($,''), owner_type) preserves prior value.
    let owner_type = normalizeOwnerType(rawOwnerType);
    if (!owner_type && (first_name || last_name)) {
      owner_type = inferOwnerType(first_name, last_name);  // may return null if names were also blank
    }
    // Stringify back to '' when null, so the SQL preserves via NULLIF.
    const ownerTypeSql = owner_type || '';

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
        -- 2026-04-21 Feature 2: Additional Info columns. Same preserve-blank
        -- pattern as above: empty string = user didn't touch it, keep DB value.
        stories              = CASE WHEN $18 = '' THEN stories              ELSE $18::smallint END,
        structure_type       = COALESCE(NULLIF($19,''), structure_type),
        apn                  = COALESCE(NULLIF($20,''), apn),
        legal_description    = COALESCE(NULLIF($21,''), legal_description),
        total_tax_owed       = CASE WHEN $22 = '' THEN total_tax_owed       ELSE $22::numeric  END,
        tax_delinquent_year  = CASE WHEN $23 = '' THEN tax_delinquent_year  ELSE $23::integer END,
        tax_auction_date     = CASE WHEN $24 = '' THEN tax_auction_date     ELSE $24::date     END,
        deed_type            = COALESCE(NULLIF($25,''), deed_type),
        lien_type            = COALESCE(NULLIF($26,''), lien_type),
        lien_date            = CASE WHEN $27 = '' THEN lien_date            ELSE $27::date     END,
        updated_at = NOW()
      WHERE id = $17
    `, [property_type, condition, bedrooms||'', bathrooms||'', sqft||'', year_built||'',
        estimated_value||'', vacant||'', last_sale_date||'', last_sale_price||'', source,
        property_status||'', assessed_value||'', equity_percent||'',
        marketing_result||'', pipeline_stage||'', id,
        // New Feature 2 params — keep aligned with $18..$27 above
        stories||'', structure_type||'', apn||'', legal_description||'',
        total_tax_owed||'', tax_delinquent_year||'', tax_auction_date||'',
        deed_type||'', lien_type||'', lien_date||'']);

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
          -- 2026-04-21 Feature 1: owner_type (Person/Company/Trust)
          owner_type = COALESCE(NULLIF($9,''), owner_type),
          -- 2026-04-21 Feature 6 enabler: mailing_zip was missing from the
          -- prior edit form — users couldn't fix incomplete records from the
          -- UI. Now editable; preserve-blank pattern so empty string = no-op.
          mailing_zip = COALESCE(NULLIF($10,''), mailing_zip),
          updated_at = NOW()
        WHERE id = $8
      `, [first_name, last_name, mailing_address, mailing_city, mailing_state,
          email_1||'', email_2||'', contact_id,
          ownerTypeSql, mailing_zip||'']);
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

    res.redirect(`/records/${id}?msg=${mailingStateRejected ? 'saved_state_rejected' : 'saved'}`);
  } catch (e) {
    console.error(e);
    res.redirect(`/records/${req.params.id}?msg=error`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2026-04-21 State Cleanup — audit properties with invalid state_code values
// and offer to recover them from ZIP (high confidence) or keep for manual
// review. Delete-code gated on the fix endpoint.
//
// GET  /records/_state_cleanup       → audit page (counts, samples, fix button)
// POST /records/_state_cleanup/fix   → apply high-confidence fixes (delete-code)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/_state_cleanup', requireAuth, async (req, res) => {
  try {
    const msg = req.query.msg ? String(req.query.msg).slice(0, 300) : '';
    const err = req.query.err ? String(req.query.err).slice(0, 300) : '';
    const msgSafe = msg.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const errSafe = err.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

    // Pull every row whose state_code is NULL or not in the valid set.
    // NOTE: `<> ANY(array)` is a common SQL footgun — it returns TRUE if the
    // value differs from ANY one element, which is true for every row (IN
    // differs from AL, AK, etc). We want `NOT = ANY` / `<> ALL` instead.
    const validArr = Array.from(VALID_STATES);
    const badRes = await query(
      `SELECT id, street, city, state_code, zip_code, county, created_at
         FROM properties
        WHERE state_code IS NULL
           OR TRIM(state_code) = ''
           OR NOT (UPPER(TRIM(state_code)) = ANY($1::text[]))
        ORDER BY created_at DESC
        LIMIT 5000`,
      [validArr]
    );
    const bad = badRes.rows;

    // Classify each bad row into a confidence bucket.
    //   high   — ZIP lookup returns a state → safe to auto-fix
    //   low    — ZIP is missing or unmappable → needs manual review
    // Keep a rollup by current (bad) state_code value so the user can see
    // patterns ("Owner Occupied" × 846, "AN" × 2, blank × 12).
    let high = 0, low = 0;
    const byBadValue = {};
    const highSamples = [];
    const lowSamples = [];
    for (const r of bad) {
      const suggested = lookupStateByZip(r.zip_code);
      const conf = suggested ? 'high' : 'low';
      r.suggested_state = suggested;
      r.confidence = conf;
      if (conf === 'high') { high++; if (highSamples.length < 10) highSamples.push(r); }
      else { low++; if (lowSamples.length < 10) lowSamples.push(r); }
      const bv = (r.state_code == null || r.state_code === '') ? '(blank)' : String(r.state_code);
      byBadValue[bv] = (byBadValue[bv] || 0) + 1;
    }
    const totalBad = bad.length;
    const topBadValues = Object.entries(byBadValue).sort((a,b) => b[1]-a[1]).slice(0, 15);

    const sampleRow = (r) => `<tr style="border-bottom:1px solid #f0efe9">
      <td style="padding:7px 10px;font-size:12px"><a href="/records/${r.id}" style="color:#1a4a9a;text-decoration:none">${escHTML(r.street || '(no street)')}, ${escHTML(r.city || '—')}</a></td>
      <td style="padding:7px 10px;font-size:12px;color:#888">${escHTML(r.zip_code || '—')}</td>
      <td style="padding:7px 10px;font-size:12px"><code style="background:#fdeaea;color:#8b1f1f;padding:2px 6px;border-radius:3px">${escHTML(r.state_code == null ? '(null)' : r.state_code === '' ? '(blank)' : r.state_code)}</code></td>
      <td style="padding:7px 10px;font-size:12px">${r.suggested_state ? `<code style="background:#e8f5ee;color:#1a7a4a;padding:2px 6px;border-radius:3px">${r.suggested_state}</code>` : '<span style="color:#aaa">—</span>'}</td>
    </tr>`;

    res.send(shell('State Cleanup', `
      <div style="max-width:1100px">
        <div style="margin-bottom:1rem"><a href="/records" style="font-size:13px;color:#888;text-decoration:none">← Records</a></div>
        <h2 style="font-size:22px;font-weight:500;margin:0 0 4px 0">State Cleanup</h2>
        <p style="font-size:13px;color:#888;margin-bottom:1.5rem">Finds properties with invalid state codes (anything outside the 50 states + DC) and suggests the correct one based on the ZIP code.</p>

        ${msgSafe ? `<div style="background:#eaf6ea;border:1px solid #9bd09b;border-radius:8px;padding:10px 14px;color:#1a5f1a;font-size:13px;margin-bottom:12px">✅ ${msgSafe}</div>` : ''}
        ${errSafe ? `<div style="background:#fdeaea;border:1px solid #f5c5c5;border-radius:8px;padding:10px 14px;color:#8b1f1f;font-size:13px;margin-bottom:12px">❌ ${errSafe}</div>` : ''}

        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:1.5rem">
          <div style="background:#fff;border:1px solid #f0efe9;border-radius:10px;padding:14px 16px">
            <div style="font-size:10px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px">Total bad rows</div>
            <div style="font-size:28px;font-weight:500;color:#1a1a1a">${totalBad.toLocaleString()}</div>
            ${totalBad >= 5000 ? '<div style="font-size:11px;color:#c07a1a;margin-top:2px">Capped at 5000 — more may exist</div>' : ''}
          </div>
          <div style="background:#fff;border:1px solid #f0efe9;border-radius:10px;padding:14px 16px">
            <div style="font-size:10px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px">Fixable from ZIP</div>
            <div style="font-size:28px;font-weight:500;color:#1a7a4a">${high.toLocaleString()}</div>
            <div style="font-size:11px;color:#888;margin-top:2px">Safe to auto-fix</div>
          </div>
          <div style="background:#fff;border:1px solid #f0efe9;border-radius:10px;padding:14px 16px">
            <div style="font-size:10px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px">Need manual review</div>
            <div style="font-size:28px;font-weight:500;color:#c07a1a">${low.toLocaleString()}</div>
            <div style="font-size:11px;color:#888;margin-top:2px">ZIP is missing or invalid</div>
          </div>
        </div>

        ${high > 0 ? `
        <div class="card" style="margin-bottom:1.5rem;background:#f8faf6;border:1px solid #c9e0c9">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap">
            <div>
              <div style="font-size:14px;font-weight:600;color:#1a5f1a;margin-bottom:4px">Ready to auto-fix ${high.toLocaleString()} properties</div>
              <div style="font-size:12px;color:#555">Every row in this set has a ZIP that maps to exactly one state. Applying the fix updates <code>state_code</code> and re-links <code>market_id</code>. Original data stays in the audit log.</div>
            </div>
            <button onclick="confirmStateFix()" style="padding:10px 18px;background:#1a7a4a;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;white-space:nowrap">Apply ${high.toLocaleString()} fixes →</button>
          </div>
        </div>` : ''}

        ${topBadValues.length ? `
        <div class="card" style="margin-bottom:1.5rem">
          <div style="font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px">Bad values (most common)</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px">
            ${topBadValues.map(([v,n]) => `<span style="font-size:12px;background:#fdeaea;color:#8b1f1f;padding:4px 10px;border-radius:5px"><code>${escHTML(v)}</code> × ${n.toLocaleString()}</span>`).join('')}
          </div>
        </div>` : ''}

        ${high > 0 ? `
        <div class="card" style="margin-bottom:1.5rem">
          <div style="font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px">High-confidence sample (first 10 of ${high.toLocaleString()})</div>
          <table style="width:100%;border-collapse:collapse">
            <thead><tr style="background:#fafaf8">
              <th style="padding:8px 10px;text-align:left;font-size:10px;font-weight:600;color:#888;text-transform:uppercase">Address</th>
              <th style="padding:8px 10px;text-align:left;font-size:10px;font-weight:600;color:#888;text-transform:uppercase">ZIP</th>
              <th style="padding:8px 10px;text-align:left;font-size:10px;font-weight:600;color:#888;text-transform:uppercase">Current</th>
              <th style="padding:8px 10px;text-align:left;font-size:10px;font-weight:600;color:#888;text-transform:uppercase">Suggested</th>
            </tr></thead>
            <tbody>${highSamples.map(sampleRow).join('')}</tbody>
          </table>
        </div>` : ''}

        ${low > 0 ? `
        <div class="card" style="margin-bottom:1.5rem">
          <div style="font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px">Needs manual review — first 10 of ${low.toLocaleString()}</div>
          <p style="font-size:12px;color:#666;margin:0 0 10px 0">These rows have missing or malformed ZIP codes, so we can't recover the state automatically. Click into each to review and fix manually.</p>
          <table style="width:100%;border-collapse:collapse">
            <thead><tr style="background:#fafaf8">
              <th style="padding:8px 10px;text-align:left;font-size:10px;font-weight:600;color:#888;text-transform:uppercase">Address</th>
              <th style="padding:8px 10px;text-align:left;font-size:10px;font-weight:600;color:#888;text-transform:uppercase">ZIP</th>
              <th style="padding:8px 10px;text-align:left;font-size:10px;font-weight:600;color:#888;text-transform:uppercase">Current</th>
              <th style="padding:8px 10px;text-align:left;font-size:10px;font-weight:600;color:#888;text-transform:uppercase">Suggested</th>
            </tr></thead>
            <tbody>${lowSamples.map(sampleRow).join('')}</tbody>
          </table>
        </div>` : ''}

        ${totalBad === 0 ? `
        <div style="text-align:center;padding:40px;background:#fafaf8;border-radius:10px;color:#888">
          <div style="font-size:14px;color:#1a7a4a;font-weight:500;margin-bottom:4px">✓ All clear</div>
          <div style="font-size:12px">Every property has a valid state code.</div>
        </div>` : ''}
      </div>

      <!-- Delete code modal -->
      <div id="state-fix-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:9999;align-items:center;justify-content:center">
        <div style="background:#fff;max-width:420px;border-radius:10px;padding:18px;box-shadow:0 12px 32px rgba(0,0,0,.2)">
          <div style="font-size:15px;font-weight:600;margin-bottom:6px">Apply ${high.toLocaleString()} state fixes</div>
          <div style="font-size:12px;color:#666;margin-bottom:12px;line-height:1.5">This updates <code>state_code</code> on up to ${high.toLocaleString()} property rows. If a row conflicts with a correct duplicate that already exists, the bad row will be <strong>deleted</strong> (the correct one stays). Enter your admin code to confirm.</div>
          <div id="state-fix-err" style="display:none;background:#fdeaea;border:1px solid #f5c5c5;border-radius:6px;padding:8px 12px;color:#8b1f1f;font-size:12px;margin-bottom:10px"></div>
          <input type="password" id="state-fix-code" autocomplete="off" placeholder="Delete code" style="width:100%;padding:9px 12px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit;box-sizing:border-box" onkeydown="if(event.key==='Enter'){event.preventDefault();applyStateFix();}">
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
            <button onclick="document.getElementById('state-fix-modal').style.display='none'" style="padding:8px 14px;background:#fff;color:#666;border:1px solid #ddd;border-radius:7px;font-size:12px;cursor:pointer;font-family:inherit">Cancel</button>
            <button onclick="applyStateFix()" id="state-fix-confirm" style="padding:8px 14px;background:#1a7a4a;color:#fff;border:none;border-radius:7px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">Apply fixes</button>
          </div>
        </div>
      </div>

      <script>
        function confirmStateFix() {
          var m = document.getElementById('state-fix-modal');
          m.style.display = 'flex';
          document.getElementById('state-fix-err').style.display = 'none';
          document.getElementById('state-fix-code').value = '';
          setTimeout(function(){ document.getElementById('state-fix-code').focus(); }, 50);
        }
        async function applyStateFix() {
          var code = document.getElementById('state-fix-code').value;
          if (!code) { showStateFixErr('Delete code required'); return; }
          var btn = document.getElementById('state-fix-confirm');
          btn.disabled = true; btn.textContent = 'Applying…';
          try {
            var res = await fetch('/records/_state_cleanup/fix', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ code: code })
            });
            var data = await res.json();
            if (!res.ok || data.error) { showStateFixErr(data.error || 'Fix failed'); btn.disabled=false; btn.textContent='Apply fixes'; return; }
            var msg = 'Fixed ' + data.fixed + ' properties';
            if (data.deleted && data.deleted > 0) msg += ' (deleted ' + data.deleted + ' duplicate rows)';
            window.location.href = '/records/_state_cleanup?msg=' + encodeURIComponent(msg);
          } catch(e) { showStateFixErr('Network error: ' + e.message); btn.disabled=false; btn.textContent='Apply fixes'; }
        }
        function showStateFixErr(m) {
          var el = document.getElementById('state-fix-err');
          el.textContent = m; el.style.display='block';
        }
      </script>
    `, 'records'));
  } catch (e) {
    console.error('[records/_state_cleanup]', e);
    res.status(500).send('Error: ' + (e.message || 'unknown'));
  }
});

router.post('/_state_cleanup/fix', requireAuth, async (req, res) => {
  // 2026-04-21 Collision-aware state fix. When we update a row's state_code
  // to its ZIP-derived value, the (street, city, state_code, zip_code)
  // unique index can conflict if a *correct* version of the same property
  // already exists. Per user direction: auto-delete the bad duplicate so
  // the correct row stays.
  //
  // Strategy:
  //   1. Build the full list of candidate fixes (id + target_state) in JS
  //   2. Ask Postgres: for each bad row, does a correct row already exist
  //      at (street, city, target_state, zip_code)? If yes → collision.
  //   3. Partition into safeUpdates (no conflict) and collisionDeletes
  //      (bad row is redundant, drop it).
  //   4. One transaction: bulk-update the safe set, bulk-delete the
  //      collision set, commit or roll back together.
  const client = await pool.connect();
  try {
    const code = req.body.code || '';
    const verified = await settings.verifyDeleteCode(req.tenantId, code);
    if (!verified) { return res.status(403).json({ error: 'Invalid delete code.' }); }

    // 1) Re-scan bad rows
    const validArr = Array.from(VALID_STATES);
    const badRes = await client.query(
      `SELECT id, street, city, state_code, zip_code FROM properties
        WHERE state_code IS NULL
           OR TRIM(state_code) = ''
           OR NOT (UPPER(TRIM(state_code)) = ANY($1::text[]))`,
      [validArr]
    );
    const candidates = [];
    for (const r of badRes.rows) {
      const suggested = lookupStateByZip(r.zip_code);
      if (suggested) candidates.push({
        id: r.id,
        street: r.street,
        city: r.city,
        target_state: suggested,
        zip_code: r.zip_code,
      });
    }
    if (candidates.length === 0) { return res.json({ ok: true, fixed: 0, deleted: 0 }); }

    // 2) Detect collisions. For each candidate, check if a row already
    // exists at the TARGET (street, city, target_state, zip_code). That
    // row might be the candidate itself (no, because candidate.state_code
    // != target_state — that's why it's a candidate) or a separate row
    // that's the "correct" version. We use a batched IN() lookup.
    //
    // Build tuple arrays parallel to `candidates` so we can zip them back.
    const streets = candidates.map(c => c.street);
    const cities  = candidates.map(c => c.city);
    const states  = candidates.map(c => c.target_state);
    const zips    = candidates.map(c => c.zip_code);
    const existRes = await client.query(
      `SELECT id, LOWER(TRIM(street)) || '|' || LOWER(TRIM(city)) || '|' || UPPER(TRIM(state_code)) || '|' || SUBSTRING(TRIM(zip_code) FROM 1 FOR 5) AS k
         FROM properties
        WHERE (street, city, state_code, zip_code) IN (
          SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[])
        )`,
      [streets, cities, states, zips]
    );
    const existingByKey = {};
    for (const r of existRes.rows) existingByKey[r.k] = r.id;

    const safeUpdates = [];       // { id, target_state }
    const collisionDeletes = [];  // { id, target_state, kept_id }
    for (const c of candidates) {
      const key = [
        (c.street||'').toLowerCase().trim(),
        (c.city||'').toLowerCase().trim(),
        (c.target_state||'').toUpperCase(),
        String(c.zip_code||'').trim().slice(0,5),
      ].join('|');
      const existingId = existingByKey[key];
      if (existingId && existingId !== c.id) {
        // A "correct" row already exists at this target address. Drop the bad one.
        collisionDeletes.push({ id: c.id, target_state: c.target_state, kept_id: existingId });
      } else {
        safeUpdates.push({ id: c.id, target_state: c.target_state });
      }
    }

    // 3) Market-id map for all target states
    const neededStates = [...new Set(candidates.map(c => c.target_state))];
    const mktRes = await client.query(
      `SELECT state_code, id FROM markets WHERE state_code = ANY($1::text[])`,
      [neededStates]
    );
    const mktMap = {};
    for (const m of mktRes.rows) mktMap[m.state_code] = m.id;
    for (const s of neededStates) {
      if (mktMap[s]) continue;
      const ins = await client.query(
        `INSERT INTO markets (state_code, name, state_name) VALUES ($1,$1,$1)
         ON CONFLICT (state_code) DO UPDATE SET state_code=EXCLUDED.state_code RETURNING id`,
        [s]
      );
      mktMap[s] = ins.rows[0].id;
    }

    // 4) Transaction: updates + deletes together
    let updated = 0, deleted = 0;
    await client.query('BEGIN');
    try {
      // Safe updates, grouped by state
      const byState = {};
      for (const u of safeUpdates) { (byState[u.target_state] = byState[u.target_state] || []).push(u.id); }
      for (const [state, ids] of Object.entries(byState)) {
        const r = await client.query(
          `UPDATE properties SET state_code = $1, market_id = $2, updated_at = NOW()
            WHERE id = ANY($3::int[])`,
          [state, mktMap[state], ids]
        );
        updated += r.rowCount;
      }

      // Collision deletes — the bad row is redundant because a correct
      // version already exists. FK cascades handle property_contacts,
      // property_tags, property_lists, property_phones (if any).
      if (collisionDeletes.length > 0) {
        const deleteIds = collisionDeletes.map(d => d.id);
        const dr = await client.query(
          `DELETE FROM properties WHERE id = ANY($1::int[])`,
          [deleteIds]
        );
        deleted = dr.rowCount;
      }

      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw txErr;
    }

    console.log(`[records/_state_cleanup/fix] Fixed ${updated} properties, deleted ${deleted} collision duplicates`);
    res.json({ ok: true, fixed: updated, deleted });
  } catch (e) {
    console.error('[records/_state_cleanup/fix]', e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
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
      const verified = await settings.verifyDeleteCode(req.tenantId, req.body.code);
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
    const { selectAll, filterParams, code } = req.body;
    const ids = coerceIdArray(req.body.ids);

    // Verify delete code BEFORE touching any data
    const verified = await settings.verifyDeleteCode(req.tenantId, code);
    if (!verified) {
      return res.status(403).json({ error: 'Invalid delete code.' });
    }

    let idsToDelete = [];
    if (selectAll) {
      // Rebuild the same filter conditions as the records list, then SELECT
      // matching IDs. Mirrors the export route's selectAll logic.
      const qs = new URLSearchParams(filterParams || '');
      // Tenant baseline — every bulk-action filter rebuild starts here
      // so the row set we act on can never include another tenant's data.
      // Filter-parity rule: every clause below this line must match the
      // GET / handler's filters.
      let conditions = [`p.tenant_id = $1`], params = [req.tenantId], idx = 2;
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
            AND LOWER(TRIM(split_part(cc_mkt.marketing_result, ' — ', 1))) = ANY($${idx}::text[])
        )
        OR EXISTS (
          SELECT 1 FROM campaign_numbers cn_mkt
          JOIN phones ph_mkt ON ph_mkt.phone_number = cn_mkt.phone_number
          JOIN property_contacts pc_mkt ON pc_mkt.contact_id = ph_mkt.contact_id AND pc_mkt.property_id = p.id
          WHERE cn_mkt.marketing_result IS NOT NULL
            AND LOWER(TRIM(split_part(cn_mkt.marketing_result, ' — ', 1))) = ANY($${idx}::text[])
        )
      )`); params.push(normMktList([qv('mkt_result')])); idx++; }
      const mktIncArr = qvAll('mkt_include');
      const mktExcArr = qvAll('mkt_exclude');
      if (mktIncArr.length > 0) {
        conditions.push(`(
        EXISTS (
          SELECT 1 FROM campaign_contacts cc_mkt
          WHERE cc_mkt.property_address_normalized = p.street_normalized
            AND UPPER(TRIM(cc_mkt.property_state)) = UPPER(TRIM(p.state_code))
            AND cc_mkt.marketing_result IS NOT NULL
            AND LOWER(TRIM(split_part(cc_mkt.marketing_result, ' — ', 1))) = ANY($${idx}::text[])
        )
        OR EXISTS (
          SELECT 1 FROM campaign_numbers cn_mkt
          JOIN phones ph_mkt ON ph_mkt.phone_number = cn_mkt.phone_number
          JOIN property_contacts pc_mkt ON pc_mkt.contact_id = ph_mkt.contact_id AND pc_mkt.property_id = p.id
          WHERE cn_mkt.marketing_result IS NOT NULL
            AND LOWER(TRIM(split_part(cn_mkt.marketing_result, ' — ', 1))) = ANY($${idx}::text[])
        )
      )`);
        params.push(normMktList(mktIncArr)); idx++;
      }
      if (mktExcArr.length > 0) {
        conditions.push(`NOT (
        EXISTS (
          SELECT 1 FROM campaign_contacts cc_mkt
          WHERE cc_mkt.property_address_normalized = p.street_normalized
            AND UPPER(TRIM(cc_mkt.property_state)) = UPPER(TRIM(p.state_code))
            AND cc_mkt.marketing_result IS NOT NULL
            AND LOWER(TRIM(split_part(cc_mkt.marketing_result, ' — ', 1))) = ANY($${idx}::text[])
        )
        OR EXISTS (
          SELECT 1 FROM campaign_numbers cn_mkt
          JOIN phones ph_mkt ON ph_mkt.phone_number = cn_mkt.phone_number
          JOIN property_contacts pc_mkt ON pc_mkt.contact_id = ph_mkt.contact_id AND pc_mkt.property_id = p.id
          WHERE cn_mkt.marketing_result IS NOT NULL
            AND LOWER(TRIM(split_part(cn_mkt.marketing_result, ' — ', 1))) = ANY($${idx}::text[])
        )
      )`);
        params.push(normMktList(mktExcArr)); idx++;
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
          AND COALESCE(p.street_normalized, LOWER(TRIM(p.street))) = COALESCE(c.mailing_address_normalized, LOWER(TRIM(c.mailing_address)))
          AND LOWER(TRIM(p.city)) = LOWER(TRIM(c.mailing_city))
          AND UPPER(TRIM(p.state_code)) = UPPER(TRIM(c.mailing_state))
          AND SUBSTRING(TRIM(p.zip_code) FROM 1 FOR 5) = SUBSTRING(TRIM(c.mailing_zip) FROM 1 FOR 5))`);
      } else if (occDel === 'absent_owner') {
        conditions.push(`(c.mailing_address IS NOT NULL AND TRIM(c.mailing_address) != ''
          AND NOT (
            COALESCE(p.street_normalized, LOWER(TRIM(p.street))) = COALESCE(c.mailing_address_normalized, LOWER(TRIM(c.mailing_address)))
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
              AND COALESCE(c2.mailing_address_normalized, LOWER(TRIM(c2.mailing_address))) = COALESCE(c.mailing_address_normalized, LOWER(TRIM(c.mailing_address)))
              AND LOWER(TRIM(c2.mailing_city)) = LOWER(TRIM(c.mailing_city))
              AND UPPER(TRIM(p2.state_code)) = UPPER(TRIM(p.state_code))
              AND SUBSTRING(TRIM(c2.mailing_zip) FROM 1 FOR 5) = SUBSTRING(TRIM(c.mailing_zip) FROM 1 FOR 5)
          ) END`;
        if (minOwnedDel) { conditions.push(`${ownedSubDel} >= $${idx}`); params.push(parseInt(minOwnedDel)); idx++; }
        if (maxOwnedDel) { conditions.push(`${ownedSubDel} <= $${idx}`); params.push(parseInt(maxOwnedDel)); idx++; }
      }
      // 2026-04-21 Feature 3 parity: Ownership Duration.
      const minYoDel = safeInt(qv('min_years_owned')), maxYoDel = safeInt(qv('max_years_owned'));
      if (minYoDel !== null) {
        conditions.push(`p.last_sale_date IS NOT NULL AND EXTRACT(YEAR FROM AGE(CURRENT_DATE, p.last_sale_date)) >= $${idx}`);
        params.push(minYoDel); idx++;
      }
      if (maxYoDel !== null) {
        conditions.push(`p.last_sale_date IS NOT NULL AND EXTRACT(YEAR FROM AGE(CURRENT_DATE, p.last_sale_date)) <= $${idx}`);
        params.push(maxYoDel); idx++;
      }
      // Tag filter
      // 2026-04-23 Tag Include/Exclude parity.
      const tagIncArr = qvAll('tag_include').map(v => parseInt(v,10)).filter(Number.isFinite);
      const tagExcArr = qvAll('tag_exclude').map(v => parseInt(v,10)).filter(Number.isFinite);
      // Legacy single-select fallback
      const legacyTag = parseInt(qv('tag'),10);
      if (Number.isFinite(legacyTag) && !tagIncArr.includes(legacyTag)) tagIncArr.push(legacyTag);
      if (tagIncArr.length > 0) {
        conditions.push(`EXISTS (SELECT 1 FROM property_tags pt_f WHERE pt_f.property_id = p.id AND pt_f.tag_id = ANY($${idx}::int[]))`);
        params.push(tagIncArr); idx++;
      }
      if (tagExcArr.length > 0) {
        conditions.push(`NOT EXISTS (SELECT 1 FROM property_tags pt_x WHERE pt_x.property_id = p.id AND pt_x.tag_id = ANY($${idx}::int[]))`);
        params.push(tagExcArr); idx++;
      }
      // 2026-04-21 phone_type + phone_tag parity filters.
      const VPT_SA = ['mobile','landline','voip','unknown'];
      const ptSA = qv('phone_type');
      if (ptSA && VPT_SA.includes(ptSA)) {
        conditions.push(`EXISTS (SELECT 1 FROM phones ph_pt JOIN property_contacts pc_pt ON pc_pt.contact_id = ph_pt.contact_id WHERE pc_pt.property_id = p.id AND LOWER(ph_pt.phone_type) = $${idx})`);
        params.push(ptSA); idx++;
      }
      // 2026-04-23 Phone Tag Include/Exclude parity.
      const ptagIncArr = qvAll('phone_tag_include').map(v => parseInt(v,10)).filter(Number.isFinite);
      const ptagExcArr = qvAll('phone_tag_exclude').map(v => parseInt(v,10)).filter(Number.isFinite);
      const legacyPtag = parseInt(qv('phone_tag'),10);
      if (Number.isFinite(legacyPtag) && !ptagIncArr.includes(legacyPtag)) ptagIncArr.push(legacyPtag);
      if (ptagIncArr.length > 0) {
        conditions.push(`EXISTS (SELECT 1 FROM phone_tag_links ptl_f JOIN phones ph_ptl ON ph_ptl.id = ptl_f.phone_id JOIN property_contacts pc_ptl ON pc_ptl.contact_id = ph_ptl.contact_id WHERE pc_ptl.property_id = p.id AND ptl_f.phone_tag_id = ANY($${idx}::int[]))`);
        params.push(ptagIncArr); idx++;
      }
      if (ptagExcArr.length > 0) {
        conditions.push(`NOT EXISTS (SELECT 1 FROM phone_tag_links ptl_x JOIN phones ph_ptlx ON ph_ptlx.id = ptl_x.phone_id JOIN property_contacts pc_ptlx ON pc_ptlx.contact_id = ph_ptlx.contact_id WHERE pc_ptlx.property_id = p.id AND ptl_x.phone_tag_id = ANY($${idx}::int[]))`);
        params.push(ptagExcArr); idx++;
      }
      // 2026-04-21 Feature 1 parity: Owner Type.
      if (qv('owner_type') && VALID_OWNER_TYPES.includes(qv('owner_type'))) {
        conditions.push(`c.owner_type = $${idx}`);
        params.push(qv('owner_type')); idx++;
      }
      // 2026-04-21 Feature 6 parity: Clean vs Incomplete mailing address.
      const mailingDel = qv('mailing');
      if (mailingDel === 'clean') {
        conditions.push(`(
          c.mailing_address IS NOT NULL AND TRIM(c.mailing_address) <> ''
          AND c.mailing_city IS NOT NULL AND TRIM(c.mailing_city) <> ''
          AND c.mailing_state IS NOT NULL AND TRIM(c.mailing_state) <> ''
          AND c.mailing_zip IS NOT NULL AND TRIM(c.mailing_zip) <> ''
        )`);
      } else if (mailingDel === 'incomplete') {
        conditions.push(`(
          c.id IS NULL
          OR c.mailing_address IS NULL OR TRIM(COALESCE(c.mailing_address,'')) = ''
          OR c.mailing_city    IS NULL OR TRIM(COALESCE(c.mailing_city,''))    = ''
          OR c.mailing_state   IS NULL OR TRIM(COALESCE(c.mailing_state,''))   = ''
          OR c.mailing_zip     IS NULL OR TRIM(COALESCE(c.mailing_zip,''))     = ''
        )`);
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
      // ids is already cleaned via coerceIdArray above. Filter to IDs the
      // current tenant actually owns — defense against a crafted POST that
      // submits property IDs belonging to another tenant.
      if (ids.length === 0) {
        return res.status(400).json({ error: 'No records selected.' });
      }
      const ownRes = await query(
        `SELECT id FROM properties WHERE tenant_id = $1 AND id = ANY($2::int[])`,
        [req.tenantId, ids]
      );
      idsToDelete = ownRes.rows.map(r => r.id);
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
    // Defense in depth: idsToDelete already came from a tenant-scoped SELECT
    // (the where clause starts with p.tenant_id = $1), so cross-tenant IDs
    // can't be in the array. The AND tenant_id below is a belt-and-braces
    // guard in case a future code path injects a raw idsToDelete from
    // somewhere else.
    await query(`UPDATE call_logs          SET property_id = NULL WHERE property_id = ANY($1::int[]) AND tenant_id = $2`, [idsToDelete, req.tenantId]);
    await query(`UPDATE sms_logs           SET property_id = NULL WHERE property_id = ANY($1::int[]) AND tenant_id = $2`, [idsToDelete, req.tenantId]);
    await query(`UPDATE filtration_results SET property_id = NULL WHERE property_id = ANY($1::int[]) AND tenant_id = $2`, [idsToDelete, req.tenantId]);
    await query(`UPDATE marketing_touches  SET property_id = NULL WHERE property_id = ANY($1::int[]) AND tenant_id = $2`, [idsToDelete, req.tenantId]);
    await query(`DELETE FROM deals                           WHERE property_id = ANY($1::int[]) AND tenant_id = $2`, [idsToDelete, req.tenantId]);
    // Distress logs cascade via FK so they clean up automatically.
    await query(`DELETE FROM property_lists    WHERE property_id = ANY($1::int[]) AND tenant_id = $2`, [idsToDelete, req.tenantId]);
    await query(`DELETE FROM property_contacts WHERE property_id = ANY($1::int[]) AND tenant_id = $2`, [idsToDelete, req.tenantId]);
    const result = await query(`DELETE FROM properties WHERE id = ANY($1::int[]) AND tenant_id = $2 RETURNING id`, [idsToDelete, req.tenantId]);

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
    const verified = await settings.verifyDeleteCode(req.tenantId, code);
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
    const { selectAll, filterParams, mode, tagNames, tagIds } = req.body;
    const ids = coerceIdArray(req.body.ids);

    // Resolve property IDs — same selectAll filter-rebuild as other bulk routes
    let propertyIds = [];
    if (selectAll) {
      const qs = new URLSearchParams(filterParams || '');
      // Tenant baseline — every bulk-action filter rebuild starts here
      // so the row set we act on can never include another tenant's data.
      // Filter-parity rule: every clause below this line must match the
      // GET / handler's filters.
      let conditions = [`p.tenant_id = $1`], params = [req.tenantId], idx = 2;
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
            AND LOWER(TRIM(split_part(cc_mkt.marketing_result, ' — ', 1))) = ANY($${idx}::text[])
        )
        OR EXISTS (
          SELECT 1 FROM campaign_numbers cn_mkt
          JOIN phones ph_mkt ON ph_mkt.phone_number = cn_mkt.phone_number
          JOIN property_contacts pc_mkt ON pc_mkt.contact_id = ph_mkt.contact_id AND pc_mkt.property_id = p.id
          WHERE cn_mkt.marketing_result IS NOT NULL
            AND LOWER(TRIM(split_part(cn_mkt.marketing_result, ' — ', 1))) = ANY($${idx}::text[])
        )
      )`);params.push(normMktList([qv('mkt_result')])); idx++; }
      const mktIncArr = qvAll('mkt_include'), mktExcArr = qvAll('mkt_exclude');
      if (mktIncArr.length > 0) { conditions.push(`(
        EXISTS (
          SELECT 1 FROM campaign_contacts cc_mkt
          WHERE cc_mkt.property_address_normalized = p.street_normalized
            AND UPPER(TRIM(cc_mkt.property_state)) = UPPER(TRIM(p.state_code))
            AND cc_mkt.marketing_result IS NOT NULL
            AND LOWER(TRIM(split_part(cc_mkt.marketing_result, ' — ', 1))) = ANY($${idx}::text[])
        )
        OR EXISTS (
          SELECT 1 FROM campaign_numbers cn_mkt
          JOIN phones ph_mkt ON ph_mkt.phone_number = cn_mkt.phone_number
          JOIN property_contacts pc_mkt ON pc_mkt.contact_id = ph_mkt.contact_id AND pc_mkt.property_id = p.id
          WHERE cn_mkt.marketing_result IS NOT NULL
            AND LOWER(TRIM(split_part(cn_mkt.marketing_result, ' — ', 1))) = ANY($${idx}::text[])
        )
      )`); params.push(normMktList(mktIncArr)); idx++; }
      if (mktExcArr.length > 0) { conditions.push(`NOT (
        EXISTS (
          SELECT 1 FROM campaign_contacts cc_mkt
          WHERE cc_mkt.property_address_normalized = p.street_normalized
            AND UPPER(TRIM(cc_mkt.property_state)) = UPPER(TRIM(p.state_code))
            AND cc_mkt.marketing_result IS NOT NULL
            AND LOWER(TRIM(split_part(cc_mkt.marketing_result, ' — ', 1))) = ANY($${idx}::text[])
        )
        OR EXISTS (
          SELECT 1 FROM campaign_numbers cn_mkt
          JOIN phones ph_mkt ON ph_mkt.phone_number = cn_mkt.phone_number
          JOIN property_contacts pc_mkt ON pc_mkt.contact_id = ph_mkt.contact_id AND pc_mkt.property_id = p.id
          WHERE cn_mkt.marketing_result IS NOT NULL
            AND LOWER(TRIM(split_part(cn_mkt.marketing_result, ' — ', 1))) = ANY($${idx}::text[])
        )
      )`); params.push(normMktList(mktExcArr)); idx++; }
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
          AND COALESCE(p.street_normalized, LOWER(TRIM(p.street))) = COALESCE(c.mailing_address_normalized, LOWER(TRIM(c.mailing_address)))
          AND LOWER(TRIM(p.city)) = LOWER(TRIM(c.mailing_city))
          AND UPPER(TRIM(p.state_code)) = UPPER(TRIM(c.mailing_state))
          AND SUBSTRING(TRIM(p.zip_code) FROM 1 FOR 5) = SUBSTRING(TRIM(c.mailing_zip) FROM 1 FOR 5))`);
      } else if (occBt === 'absent_owner') {
        conditions.push(`(c.mailing_address IS NOT NULL AND TRIM(c.mailing_address) != ''
          AND NOT (
            COALESCE(p.street_normalized, LOWER(TRIM(p.street))) = COALESCE(c.mailing_address_normalized, LOWER(TRIM(c.mailing_address)))
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
              AND COALESCE(c2.mailing_address_normalized, LOWER(TRIM(c2.mailing_address))) = COALESCE(c.mailing_address_normalized, LOWER(TRIM(c.mailing_address)))
              AND LOWER(TRIM(c2.mailing_city)) = LOWER(TRIM(c.mailing_city))
              AND UPPER(TRIM(p2.state_code)) = UPPER(TRIM(p.state_code))
              AND SUBSTRING(TRIM(c2.mailing_zip) FROM 1 FOR 5) = SUBSTRING(TRIM(c.mailing_zip) FROM 1 FOR 5)
          ) END`;
        if (minOwnedBt) { conditions.push(`${ownedSubBt} >= $${idx}`); params.push(parseInt(minOwnedBt)); idx++; }
        if (maxOwnedBt) { conditions.push(`${ownedSubBt} <= $${idx}`); params.push(parseInt(maxOwnedBt)); idx++; }
      }
      // 2026-04-21 Feature 3 parity: Ownership Duration.
      const minYoBt = safeInt(qv('min_years_owned')), maxYoBt = safeInt(qv('max_years_owned'));
      if (minYoBt !== null) {
        conditions.push(`p.last_sale_date IS NOT NULL AND EXTRACT(YEAR FROM AGE(CURRENT_DATE, p.last_sale_date)) >= $${idx}`);
        params.push(minYoBt); idx++;
      }
      if (maxYoBt !== null) {
        conditions.push(`p.last_sale_date IS NOT NULL AND EXTRACT(YEAR FROM AGE(CURRENT_DATE, p.last_sale_date)) <= $${idx}`);
        params.push(maxYoBt); idx++;
      }

      // 2026-04-23 Tag Include/Exclude parity.
      const tagIncArr = qvAll('tag_include').map(v => parseInt(v,10)).filter(Number.isFinite);
      const tagExcArr = qvAll('tag_exclude').map(v => parseInt(v,10)).filter(Number.isFinite);
      // Legacy single-select fallback
      const legacyTag = parseInt(qv('tag'),10);
      if (Number.isFinite(legacyTag) && !tagIncArr.includes(legacyTag)) tagIncArr.push(legacyTag);
      if (tagIncArr.length > 0) {
        conditions.push(`EXISTS (SELECT 1 FROM property_tags pt_f WHERE pt_f.property_id = p.id AND pt_f.tag_id = ANY($${idx}::int[]))`);
        params.push(tagIncArr); idx++;
      }
      if (tagExcArr.length > 0) {
        conditions.push(`NOT EXISTS (SELECT 1 FROM property_tags pt_x WHERE pt_x.property_id = p.id AND pt_x.tag_id = ANY($${idx}::int[]))`);
        params.push(tagExcArr); idx++;
      }
      const VPT_SA = ['mobile','landline','voip','unknown'];
      const ptSA = qv('phone_type');
      if (ptSA && VPT_SA.includes(ptSA)) {
        conditions.push(`EXISTS (SELECT 1 FROM phones ph_pt JOIN property_contacts pc_pt ON pc_pt.contact_id = ph_pt.contact_id WHERE pc_pt.property_id = p.id AND LOWER(ph_pt.phone_type) = $${idx})`);
        params.push(ptSA); idx++;
      }
      // 2026-04-23 Phone Tag Include/Exclude parity.
      const ptagIncArr = qvAll('phone_tag_include').map(v => parseInt(v,10)).filter(Number.isFinite);
      const ptagExcArr = qvAll('phone_tag_exclude').map(v => parseInt(v,10)).filter(Number.isFinite);
      const legacyPtag = parseInt(qv('phone_tag'),10);
      if (Number.isFinite(legacyPtag) && !ptagIncArr.includes(legacyPtag)) ptagIncArr.push(legacyPtag);
      if (ptagIncArr.length > 0) {
        conditions.push(`EXISTS (SELECT 1 FROM phone_tag_links ptl_f JOIN phones ph_ptl ON ph_ptl.id = ptl_f.phone_id JOIN property_contacts pc_ptl ON pc_ptl.contact_id = ph_ptl.contact_id WHERE pc_ptl.property_id = p.id AND ptl_f.phone_tag_id = ANY($${idx}::int[]))`);
        params.push(ptagIncArr); idx++;
      }
      if (ptagExcArr.length > 0) {
        conditions.push(`NOT EXISTS (SELECT 1 FROM phone_tag_links ptl_x JOIN phones ph_ptlx ON ph_ptlx.id = ptl_x.phone_id JOIN property_contacts pc_ptlx ON pc_ptlx.contact_id = ph_ptlx.contact_id WHERE pc_ptlx.property_id = p.id AND ptl_x.phone_tag_id = ANY($${idx}::int[]))`);
        params.push(ptagExcArr); idx++;
      }
      // 2026-04-21 Feature 1 parity: Owner Type.
      if (qv('owner_type') && VALID_OWNER_TYPES.includes(qv('owner_type'))) {
        conditions.push(`c.owner_type = $${idx}`);
        params.push(qv('owner_type')); idx++;
      }
      // 2026-04-21 Feature 6 parity: Clean vs Incomplete mailing address.
      const mailingBt = qv('mailing');
      if (mailingBt === 'clean') {
        conditions.push(`(
          c.mailing_address IS NOT NULL AND TRIM(c.mailing_address) <> ''
          AND c.mailing_city IS NOT NULL AND TRIM(c.mailing_city) <> ''
          AND c.mailing_state IS NOT NULL AND TRIM(c.mailing_state) <> ''
          AND c.mailing_zip IS NOT NULL AND TRIM(c.mailing_zip) <> ''
        )`);
      } else if (mailingBt === 'incomplete') {
        conditions.push(`(
          c.id IS NULL
          OR c.mailing_address IS NULL OR TRIM(COALESCE(c.mailing_address,'')) = ''
          OR c.mailing_city    IS NULL OR TRIM(COALESCE(c.mailing_city,''))    = ''
          OR c.mailing_state   IS NULL OR TRIM(COALESCE(c.mailing_state,''))   = ''
          OR c.mailing_zip     IS NULL OR TRIM(COALESCE(c.mailing_zip,''))     = ''
        )`);
      }
      const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
      const idsRes = await query(`SELECT DISTINCT p.id FROM properties p LEFT JOIN property_contacts pc ON pc.property_id = p.id AND pc.primary_contact = true LEFT JOIN contacts c ON c.id = pc.contact_id ${where}`, params);
      propertyIds = idsRes.rows.map(r => r.id);
    } else {
      // Filter user-supplied IDs to ones this tenant owns — defends against
      // crafted POSTs that submit cross-tenant property IDs.
      if (ids.length === 0) {
        return res.status(400).json({ error: 'No records selected.' });
      }
      const ownRes = await query(
        `SELECT id FROM properties WHERE tenant_id = $1 AND id = ANY($2::int[])`,
        [req.tenantId, ids]
      );
      propertyIds = ownRes.rows.map(r => r.id);
    }

    if (propertyIds.length === 0) {
      return res.status(400).json({ error: 'No valid properties found.' });
    }

    let affected = 0;

    if (mode === 'add') {
      if (!Array.isArray(tagNames) || tagNames.length === 0) {
        return res.status(400).json({ error: 'No tags specified.' });
      }
      // Resolve or create each tag (tenant-scoped — every tenant has its own tag namespace).
      const resolvedTags = [];
      for (const name of tagNames) {
        const trimmed = String(name).trim();
        if (!trimmed || trimmed.length > 100) continue;
        let tagRes = await query(`SELECT id FROM tags WHERE tenant_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1`, [req.tenantId, trimmed]);
        if (!tagRes.rows.length) {
          try {
            tagRes = await query(`INSERT INTO tags (tenant_id, name) VALUES ($1, $2) RETURNING id`, [req.tenantId, trimmed]);
          } catch (e) {
            tagRes = await query(`SELECT id FROM tags WHERE tenant_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1`, [req.tenantId, trimmed]);
          }
        }
        if (tagRes.rows.length) resolvedTags.push(tagRes.rows[0].id);
      }
      // Bulk insert property_tags via UNNEST. Tenant_id flows into every link row.
      for (const tagId of resolvedTags) {
        const r = await query(
          `INSERT INTO property_tags (tenant_id, property_id, tag_id)
           SELECT $3, unnest($1::int[]), $2
           ON CONFLICT DO NOTHING`,
          [propertyIds, tagId, req.tenantId]
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
           AND tag_id = ANY($2::int[])
           AND tenant_id = $3`,
        [propertyIds, safeTagIds, req.tenantId]
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
    const { selectAll, filterParams, listId, code } = req.body;
    const ids = coerceIdArray(req.body.ids);

    // Verify delete code BEFORE touching any data
    const verified = await settings.verifyDeleteCode(req.tenantId, code);
    if (!verified) {
      return res.status(403).json({ error: 'Invalid delete code.' });
    }

    const listIdInt = parseInt(listId);
    if (!listIdInt || isNaN(listIdInt)) {
      return res.status(400).json({ error: 'List ID required. Filter by a specific list first.' });
    }

    // Confirm the list exists AND belongs to this tenant — gives a clean
    // 404 if a user crafts a request targeting another tenant's list.
    const listCheck = await query(`SELECT id, list_name FROM lists WHERE id = $1 AND tenant_id = $2`, [listIdInt, req.tenantId]);
    if (!listCheck.rowCount) {
      return res.status(404).json({ error: 'List not found.' });
    }

    let idsToRemove = [];
    if (selectAll) {
      // Rebuild the same filter conditions as the records list. Mirrors the
      // delete route's selectAll logic exactly — keep them in sync.
      const qs = new URLSearchParams(filterParams || '');
      // Tenant baseline — every bulk-action filter rebuild starts here
      // so the row set we act on can never include another tenant's data.
      // Filter-parity rule: every clause below this line must match the
      // GET / handler's filters.
      let conditions = [`p.tenant_id = $1`], params = [req.tenantId], idx = 2;
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
            AND LOWER(TRIM(split_part(cc_mkt.marketing_result, ' — ', 1))) = ANY($${idx}::text[])
        )
        OR EXISTS (
          SELECT 1 FROM campaign_numbers cn_mkt
          JOIN phones ph_mkt ON ph_mkt.phone_number = cn_mkt.phone_number
          JOIN property_contacts pc_mkt ON pc_mkt.contact_id = ph_mkt.contact_id AND pc_mkt.property_id = p.id
          WHERE cn_mkt.marketing_result IS NOT NULL
            AND LOWER(TRIM(split_part(cn_mkt.marketing_result, ' — ', 1))) = ANY($${idx}::text[])
        )
      )`); params.push(normMktList([qv('mkt_result')])); idx++; }
      const mktIncArr = qvAll('mkt_include');
      const mktExcArr = qvAll('mkt_exclude');
      if (mktIncArr.length > 0) {
        conditions.push(`(
        EXISTS (
          SELECT 1 FROM campaign_contacts cc_mkt
          WHERE cc_mkt.property_address_normalized = p.street_normalized
            AND UPPER(TRIM(cc_mkt.property_state)) = UPPER(TRIM(p.state_code))
            AND cc_mkt.marketing_result IS NOT NULL
            AND LOWER(TRIM(split_part(cc_mkt.marketing_result, ' — ', 1))) = ANY($${idx}::text[])
        )
        OR EXISTS (
          SELECT 1 FROM campaign_numbers cn_mkt
          JOIN phones ph_mkt ON ph_mkt.phone_number = cn_mkt.phone_number
          JOIN property_contacts pc_mkt ON pc_mkt.contact_id = ph_mkt.contact_id AND pc_mkt.property_id = p.id
          WHERE cn_mkt.marketing_result IS NOT NULL
            AND LOWER(TRIM(split_part(cn_mkt.marketing_result, ' — ', 1))) = ANY($${idx}::text[])
        )
      )`);
        params.push(normMktList(mktIncArr)); idx++;
      }
      if (mktExcArr.length > 0) {
        conditions.push(`NOT (
        EXISTS (
          SELECT 1 FROM campaign_contacts cc_mkt
          WHERE cc_mkt.property_address_normalized = p.street_normalized
            AND UPPER(TRIM(cc_mkt.property_state)) = UPPER(TRIM(p.state_code))
            AND cc_mkt.marketing_result IS NOT NULL
            AND LOWER(TRIM(split_part(cc_mkt.marketing_result, ' — ', 1))) = ANY($${idx}::text[])
        )
        OR EXISTS (
          SELECT 1 FROM campaign_numbers cn_mkt
          JOIN phones ph_mkt ON ph_mkt.phone_number = cn_mkt.phone_number
          JOIN property_contacts pc_mkt ON pc_mkt.contact_id = ph_mkt.contact_id AND pc_mkt.property_id = p.id
          WHERE cn_mkt.marketing_result IS NOT NULL
            AND LOWER(TRIM(split_part(cn_mkt.marketing_result, ' — ', 1))) = ANY($${idx}::text[])
        )
      )`);
        params.push(normMktList(mktExcArr)); idx++;
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
          AND COALESCE(p.street_normalized, LOWER(TRIM(p.street))) = COALESCE(c.mailing_address_normalized, LOWER(TRIM(c.mailing_address)))
          AND LOWER(TRIM(p.city)) = LOWER(TRIM(c.mailing_city))
          AND UPPER(TRIM(p.state_code)) = UPPER(TRIM(c.mailing_state))
          AND SUBSTRING(TRIM(p.zip_code) FROM 1 FOR 5) = SUBSTRING(TRIM(c.mailing_zip) FROM 1 FOR 5))`);
      } else if (occRfl === 'absent_owner') {
        conditions.push(`(c.mailing_address IS NOT NULL AND TRIM(c.mailing_address) != ''
          AND NOT (
            COALESCE(p.street_normalized, LOWER(TRIM(p.street))) = COALESCE(c.mailing_address_normalized, LOWER(TRIM(c.mailing_address)))
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
              AND COALESCE(c2.mailing_address_normalized, LOWER(TRIM(c2.mailing_address))) = COALESCE(c.mailing_address_normalized, LOWER(TRIM(c.mailing_address)))
              AND LOWER(TRIM(c2.mailing_city)) = LOWER(TRIM(c.mailing_city))
              AND UPPER(TRIM(p2.state_code)) = UPPER(TRIM(p.state_code))
              AND SUBSTRING(TRIM(c2.mailing_zip) FROM 1 FOR 5) = SUBSTRING(TRIM(c.mailing_zip) FROM 1 FOR 5)
          ) END`;
        if (minOwnedRfl) { conditions.push(`${ownedSubRfl} >= $${idx}`); params.push(parseInt(minOwnedRfl)); idx++; }
        if (maxOwnedRfl) { conditions.push(`${ownedSubRfl} <= $${idx}`); params.push(parseInt(maxOwnedRfl)); idx++; }
      }
      // 2026-04-21 Feature 3 parity: Ownership Duration.
      const minYoRfl = safeInt(qv('min_years_owned')), maxYoRfl = safeInt(qv('max_years_owned'));
      if (minYoRfl !== null) {
        conditions.push(`p.last_sale_date IS NOT NULL AND EXTRACT(YEAR FROM AGE(CURRENT_DATE, p.last_sale_date)) >= $${idx}`);
        params.push(minYoRfl); idx++;
      }
      if (maxYoRfl !== null) {
        conditions.push(`p.last_sale_date IS NOT NULL AND EXTRACT(YEAR FROM AGE(CURRENT_DATE, p.last_sale_date)) <= $${idx}`);
        params.push(maxYoRfl); idx++;
      }
      // Tag filter
      // 2026-04-23 Tag Include/Exclude parity.
      const tagIncArr = qvAll('tag_include').map(v => parseInt(v,10)).filter(Number.isFinite);
      const tagExcArr = qvAll('tag_exclude').map(v => parseInt(v,10)).filter(Number.isFinite);
      // Legacy single-select fallback
      const legacyTag = parseInt(qv('tag'),10);
      if (Number.isFinite(legacyTag) && !tagIncArr.includes(legacyTag)) tagIncArr.push(legacyTag);
      if (tagIncArr.length > 0) {
        conditions.push(`EXISTS (SELECT 1 FROM property_tags pt_f WHERE pt_f.property_id = p.id AND pt_f.tag_id = ANY($${idx}::int[]))`);
        params.push(tagIncArr); idx++;
      }
      if (tagExcArr.length > 0) {
        conditions.push(`NOT EXISTS (SELECT 1 FROM property_tags pt_x WHERE pt_x.property_id = p.id AND pt_x.tag_id = ANY($${idx}::int[]))`);
        params.push(tagExcArr); idx++;
      }
      // 2026-04-21 phone_type + phone_tag parity filters.
      const VPT_SA = ['mobile','landline','voip','unknown'];
      const ptSA = qv('phone_type');
      if (ptSA && VPT_SA.includes(ptSA)) {
        conditions.push(`EXISTS (SELECT 1 FROM phones ph_pt JOIN property_contacts pc_pt ON pc_pt.contact_id = ph_pt.contact_id WHERE pc_pt.property_id = p.id AND LOWER(ph_pt.phone_type) = $${idx})`);
        params.push(ptSA); idx++;
      }
      // 2026-04-23 Phone Tag Include/Exclude parity.
      const ptagIncArr = qvAll('phone_tag_include').map(v => parseInt(v,10)).filter(Number.isFinite);
      const ptagExcArr = qvAll('phone_tag_exclude').map(v => parseInt(v,10)).filter(Number.isFinite);
      const legacyPtag = parseInt(qv('phone_tag'),10);
      if (Number.isFinite(legacyPtag) && !ptagIncArr.includes(legacyPtag)) ptagIncArr.push(legacyPtag);
      if (ptagIncArr.length > 0) {
        conditions.push(`EXISTS (SELECT 1 FROM phone_tag_links ptl_f JOIN phones ph_ptl ON ph_ptl.id = ptl_f.phone_id JOIN property_contacts pc_ptl ON pc_ptl.contact_id = ph_ptl.contact_id WHERE pc_ptl.property_id = p.id AND ptl_f.phone_tag_id = ANY($${idx}::int[]))`);
        params.push(ptagIncArr); idx++;
      }
      if (ptagExcArr.length > 0) {
        conditions.push(`NOT EXISTS (SELECT 1 FROM phone_tag_links ptl_x JOIN phones ph_ptlx ON ph_ptlx.id = ptl_x.phone_id JOIN property_contacts pc_ptlx ON pc_ptlx.contact_id = ph_ptlx.contact_id WHERE pc_ptlx.property_id = p.id AND ptl_x.phone_tag_id = ANY($${idx}::int[]))`);
        params.push(ptagExcArr); idx++;
      }
      // 2026-04-21 Feature 1 parity: Owner Type.
      if (qv('owner_type') && VALID_OWNER_TYPES.includes(qv('owner_type'))) {
        conditions.push(`c.owner_type = $${idx}`);
        params.push(qv('owner_type')); idx++;
      }
      // 2026-04-21 Feature 6 parity: Clean vs Incomplete mailing address.
      const mailingRfl = qv('mailing');
      if (mailingRfl === 'clean') {
        conditions.push(`(
          c.mailing_address IS NOT NULL AND TRIM(c.mailing_address) <> ''
          AND c.mailing_city IS NOT NULL AND TRIM(c.mailing_city) <> ''
          AND c.mailing_state IS NOT NULL AND TRIM(c.mailing_state) <> ''
          AND c.mailing_zip IS NOT NULL AND TRIM(c.mailing_zip) <> ''
        )`);
      } else if (mailingRfl === 'incomplete') {
        conditions.push(`(
          c.id IS NULL
          OR c.mailing_address IS NULL OR TRIM(COALESCE(c.mailing_address,'')) = ''
          OR c.mailing_city    IS NULL OR TRIM(COALESCE(c.mailing_city,''))    = ''
          OR c.mailing_state   IS NULL OR TRIM(COALESCE(c.mailing_state,''))   = ''
          OR c.mailing_zip     IS NULL OR TRIM(COALESCE(c.mailing_zip,''))     = ''
        )`);
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
      // Filter user-supplied IDs to those owned by the current tenant —
      // defends against crafted POSTs targeting another tenant's properties.
      if (ids.length === 0) {
        return res.status(400).json({ error: 'No records selected.' });
      }
      const ownRes = await query(
        `SELECT id FROM properties WHERE tenant_id = $1 AND id = ANY($2::int[])`,
        [req.tenantId, ids]
      );
      idsToRemove = ownRes.rows.map(r => r.id);
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
           AND tenant_id = $3
         RETURNING property_id`,
      [listIdInt, idsToRemove, req.tenantId]
    );

    console.log(`[records/remove-from-list] Removed ${result.rowCount} property-list links from list "${listCheck.rows[0].list_name}" (id=${listIdInt})`);
    res.json({ ok: true, removed: result.rowCount, listName: listCheck.rows[0].list_name });
  } catch (e) {
    console.error('[records/remove-from-list]', e);
    res.status(500).json({ error: 'Remove failed: ' + e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2026-04-21 Feature 9 — ADD TO LIST — POST /records/add-to-list
// Attaches selected properties to a list. Non-destructive (no delete code).
// Supports:
//   • Individual checkbox selection (ids[])
//   • Cross-page selectAll (filterParams)
//   • Inline "create new list" via newListName
// Skips duplicates (ON CONFLICT DO NOTHING on property_lists PK).
// Filter-parity code block mirrors /remove-from-list — keep them in sync.
// Key difference: does NOT force-scope to a specific list (user may be adding
// from the global /records view), and does NOT require a delete code.
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/add-to-list', requireAuth, async (req, res) => {
  try {
    const { selectAll, filterParams, listId, newListName } = req.body;
    const ids = coerceIdArray(req.body.ids);

    // Resolve target list: either existing by id, or create new by name.
    let listIdInt = null;
    let listName = '';
    if (newListName && typeof newListName === 'string' && newListName.trim()) {
      const name = newListName.trim().slice(0, 200);
      // Case-insensitive name collision is checked within this tenant's lists.
      const existing = await query(`SELECT id, list_name FROM lists WHERE tenant_id = $1 AND LOWER(list_name) = LOWER($2) LIMIT 1`, [req.tenantId, name]);
      if (existing.rowCount) {
        listIdInt = existing.rows[0].id;
        listName = existing.rows[0].list_name;
      } else {
        const created = await query(
          `INSERT INTO lists (tenant_id, list_name, list_type, source) VALUES ($1, $2, 'Custom', 'manual') RETURNING id, list_name`,
          [req.tenantId, name]
        );
        listIdInt = created.rows[0].id;
        listName = created.rows[0].list_name;
      }
    } else {
      listIdInt = parseInt(listId);
      if (!listIdInt || isNaN(listIdInt)) {
        return res.status(400).json({ error: 'Pick a list or enter a new list name.' });
      }
      // Tenant-scoped lookup so a crafted POST can't target another tenant's list.
      const listCheck = await query(`SELECT id, list_name FROM lists WHERE id = $1 AND tenant_id = $2`, [listIdInt, req.tenantId]);
      if (!listCheck.rowCount) {
        return res.status(404).json({ error: 'List not found.' });
      }
      listName = listCheck.rows[0].list_name;
    }

    let idsToAdd = [];
    if (selectAll) {
      // Filter-parity block — mirrors /remove-from-list exactly EXCEPT we
      // do not force-scope to a target list (add-to-list works from any view).
      const qs = new URLSearchParams(filterParams || '');
      // Tenant baseline — every bulk-action filter rebuild starts here
      // so the row set we act on can never include another tenant's data.
      // Filter-parity rule: every clause below this line must match the
      // GET / handler's filters.
      let conditions = [`p.tenant_id = $1`], params = [req.tenantId], idx = 2;
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
      // 2026-04-21 filter-parity fix: Add to List was missing mkt_result /
      // mkt_include / mkt_exclude. Without these, a user filtering by
      // "Marketing Result = Lead" and hitting selectAll would add too many
      // properties because the SQL scope was wider than what they saw on screen.
      // Mirrors the RFL handler exactly.
      if (qv('mkt_result'))  { conditions.push(`(
        EXISTS (
          SELECT 1 FROM campaign_contacts cc_mkt
          WHERE cc_mkt.property_address_normalized = p.street_normalized
            AND UPPER(TRIM(cc_mkt.property_state)) = UPPER(TRIM(p.state_code))
            AND cc_mkt.marketing_result IS NOT NULL
            AND LOWER(TRIM(split_part(cc_mkt.marketing_result, ' — ', 1))) = ANY($${idx}::text[])
        )
        OR EXISTS (
          SELECT 1 FROM campaign_numbers cn_mkt
          JOIN phones ph_mkt ON ph_mkt.phone_number = cn_mkt.phone_number
          JOIN property_contacts pc_mkt ON pc_mkt.contact_id = ph_mkt.contact_id AND pc_mkt.property_id = p.id
          WHERE cn_mkt.marketing_result IS NOT NULL
            AND LOWER(TRIM(split_part(cn_mkt.marketing_result, ' — ', 1))) = ANY($${idx}::text[])
        )
      )`); params.push(normMktList([qv('mkt_result')])); idx++; }
      const mktIncAtl = qvAll('mkt_include');
      const mktExcAtl = qvAll('mkt_exclude');
      if (mktIncAtl.length > 0) {
        conditions.push(`(
        EXISTS (
          SELECT 1 FROM campaign_contacts cc_mkt
          WHERE cc_mkt.property_address_normalized = p.street_normalized
            AND UPPER(TRIM(cc_mkt.property_state)) = UPPER(TRIM(p.state_code))
            AND cc_mkt.marketing_result IS NOT NULL
            AND LOWER(TRIM(split_part(cc_mkt.marketing_result, ' — ', 1))) = ANY($${idx}::text[])
        )
        OR EXISTS (
          SELECT 1 FROM campaign_numbers cn_mkt
          JOIN phones ph_mkt ON ph_mkt.phone_number = cn_mkt.phone_number
          JOIN property_contacts pc_mkt ON pc_mkt.contact_id = ph_mkt.contact_id AND pc_mkt.property_id = p.id
          WHERE cn_mkt.marketing_result IS NOT NULL
            AND LOWER(TRIM(split_part(cn_mkt.marketing_result, ' — ', 1))) = ANY($${idx}::text[])
        )
      )`);
        params.push(normMktList(mktIncAtl)); idx++;
      }
      if (mktExcAtl.length > 0) {
        conditions.push(`NOT (
        EXISTS (
          SELECT 1 FROM campaign_contacts cc_mkt
          WHERE cc_mkt.property_address_normalized = p.street_normalized
            AND UPPER(TRIM(cc_mkt.property_state)) = UPPER(TRIM(p.state_code))
            AND cc_mkt.marketing_result IS NOT NULL
            AND LOWER(TRIM(split_part(cc_mkt.marketing_result, ' — ', 1))) = ANY($${idx}::text[])
        )
        OR EXISTS (
          SELECT 1 FROM campaign_numbers cn_mkt
          JOIN phones ph_mkt ON ph_mkt.phone_number = cn_mkt.phone_number
          JOIN property_contacts pc_mkt ON pc_mkt.contact_id = ph_mkt.contact_id AND pc_mkt.property_id = p.id
          WHERE cn_mkt.marketing_result IS NOT NULL
            AND LOWER(TRIM(split_part(cn_mkt.marketing_result, ' — ', 1))) = ANY($${idx}::text[])
        )
      )`);
        params.push(normMktList(mktExcAtl)); idx++;
      }
      if (qv('min_assessed')){ conditions.push(`p.assessed_value >= $${idx}`);   params.push(qv('min_assessed')); idx++; }
      if (qv('max_assessed')){ conditions.push(`p.assessed_value <= $${idx}`);   params.push(qv('max_assessed')); idx++; }
      if (qv('min_equity'))  { conditions.push(`p.equity_percent >= $${idx}`);   params.push(qv('min_equity')); idx++; }
      if (qv('max_equity'))  { conditions.push(`p.equity_percent <= $${idx}`);   params.push(qv('max_equity')); idx++; }
      if (qv('min_year'))    { conditions.push(`p.year_built >= $${idx}`);       params.push(qv('min_year')); idx++; }
      if (qv('max_year'))    { conditions.push(`p.year_built <= $${idx}`);       params.push(qv('max_year')); idx++; }
      if (qv('upload_from')) { conditions.push(`p.created_at >= $${idx}`);       params.push(qv('upload_from')); idx++; }
      if (qv('upload_to'))   { conditions.push(`p.created_at <= $${idx}`);       params.push(qv('upload_to') + ' 23:59:59'); idx++; }
      // Scope-by-list if user was filtering from a specific list view (list_id
      // in the QS). Unlike RFL this is optional — user could be in "All props".
      if (qv('list_id')) {
        conditions.push(`EXISTS (SELECT 1 FROM property_lists pl2 WHERE pl2.property_id = p.id AND pl2.list_id = $${idx})`);
        params.push(parseInt(qv('list_id'))); idx++;
      }
      const stackArr = qvAll('stack_list').map(v => parseInt(v)).filter(n => !isNaN(n));
      if (stackArr.length > 0) {
        conditions.push(
          `(SELECT COUNT(DISTINCT pl_stack.list_id)
              FROM property_lists pl_stack
             WHERE pl_stack.property_id = p.id
               AND pl_stack.list_id = ANY($${idx}::int[])) = $${idx+1}`
        );
        params.push(stackArr); params.push(stackArr.length); idx += 2;
      }
      if (qv('min_stack'))   { conditions.push(`(SELECT COUNT(*) FROM property_lists plc WHERE plc.property_id = p.id) >= $${idx}`); params.push(parseInt(qv('min_stack'))); idx++; }
      if (qv('min_distress')){ conditions.push(`p.distress_score >= $${idx}`); params.push(parseInt(qv('min_distress'))); idx++; }
      const phonesAtl = qv('phones');
      if (phonesAtl === 'has') {
        conditions.push(`EXISTS (SELECT 1 FROM phones ph_f JOIN property_contacts pc_f ON pc_f.contact_id = ph_f.contact_id WHERE pc_f.property_id = p.id)`);
      } else if (phonesAtl === 'none') {
        conditions.push(`NOT EXISTS (SELECT 1 FROM phones ph_f JOIN property_contacts pc_f ON pc_f.contact_id = ph_f.contact_id WHERE pc_f.property_id = p.id)`);
      }
      const occAtl = qv('occupancy');
      if (occAtl === 'owner_occupied') {
        conditions.push(`(c.mailing_address IS NOT NULL
          AND COALESCE(p.street_normalized, LOWER(TRIM(p.street))) = COALESCE(c.mailing_address_normalized, LOWER(TRIM(c.mailing_address)))
          AND LOWER(TRIM(p.city)) = LOWER(TRIM(c.mailing_city))
          AND UPPER(TRIM(p.state_code)) = UPPER(TRIM(c.mailing_state))
          AND SUBSTRING(TRIM(p.zip_code) FROM 1 FOR 5) = SUBSTRING(TRIM(c.mailing_zip) FROM 1 FOR 5))`);
      } else if (occAtl === 'absent_owner') {
        conditions.push(`(c.mailing_address IS NOT NULL AND TRIM(c.mailing_address) != ''
          AND NOT (
            COALESCE(p.street_normalized, LOWER(TRIM(p.street))) = COALESCE(c.mailing_address_normalized, LOWER(TRIM(c.mailing_address)))
            AND LOWER(TRIM(p.city)) = LOWER(TRIM(c.mailing_city))
            AND UPPER(TRIM(p.state_code)) = UPPER(TRIM(c.mailing_state))
            AND SUBSTRING(TRIM(p.zip_code) FROM 1 FOR 5) = SUBSTRING(TRIM(c.mailing_zip) FROM 1 FOR 5)
          ))`);
      } else if (occAtl === 'unknown') {
        conditions.push(`(c.mailing_address IS NULL OR TRIM(c.mailing_address) = '')`);
      }
      const minOwnedAtl = qv('min_owned'), maxOwnedAtl = qv('max_owned');
      if (minOwnedAtl || maxOwnedAtl) {
        const ownedSubAtl = `
          CASE WHEN c.mailing_address IS NULL OR TRIM(c.mailing_address) = '' THEN 1
          ELSE (
            SELECT COUNT(*)
            FROM properties p2
            JOIN property_contacts pc2 ON pc2.property_id = p2.id AND pc2.primary_contact = true
            JOIN contacts c2 ON c2.id = pc2.contact_id
            WHERE c2.mailing_address IS NOT NULL AND TRIM(c2.mailing_address) != ''
              AND COALESCE(c2.mailing_address_normalized, LOWER(TRIM(c2.mailing_address))) = COALESCE(c.mailing_address_normalized, LOWER(TRIM(c.mailing_address)))
              AND LOWER(TRIM(c2.mailing_city)) = LOWER(TRIM(c.mailing_city))
              AND UPPER(TRIM(p2.state_code)) = UPPER(TRIM(p.state_code))
              AND SUBSTRING(TRIM(c2.mailing_zip) FROM 1 FOR 5) = SUBSTRING(TRIM(c.mailing_zip) FROM 1 FOR 5)
          ) END`;
        if (minOwnedAtl) { conditions.push(`${ownedSubAtl} >= $${idx}`); params.push(parseInt(minOwnedAtl)); idx++; }
        if (maxOwnedAtl) { conditions.push(`${ownedSubAtl} <= $${idx}`); params.push(parseInt(maxOwnedAtl)); idx++; }
      }
      // 2026-04-21 Feature 3 parity: Ownership Duration.
      const minYoAtl = safeInt(qv('min_years_owned')), maxYoAtl = safeInt(qv('max_years_owned'));
      if (minYoAtl !== null) {
        conditions.push(`p.last_sale_date IS NOT NULL AND EXTRACT(YEAR FROM AGE(CURRENT_DATE, p.last_sale_date)) >= $${idx}`);
        params.push(minYoAtl); idx++;
      }
      if (maxYoAtl !== null) {
        conditions.push(`p.last_sale_date IS NOT NULL AND EXTRACT(YEAR FROM AGE(CURRENT_DATE, p.last_sale_date)) <= $${idx}`);
        params.push(maxYoAtl); idx++;
      }
      // 2026-04-23 Tag Include/Exclude parity.
      const tagIncArr = qvAll('tag_include').map(v => parseInt(v,10)).filter(Number.isFinite);
      const tagExcArr = qvAll('tag_exclude').map(v => parseInt(v,10)).filter(Number.isFinite);
      // Legacy single-select fallback
      const legacyTag = parseInt(qv('tag'),10);
      if (Number.isFinite(legacyTag) && !tagIncArr.includes(legacyTag)) tagIncArr.push(legacyTag);
      if (tagIncArr.length > 0) {
        conditions.push(`EXISTS (SELECT 1 FROM property_tags pt_f WHERE pt_f.property_id = p.id AND pt_f.tag_id = ANY($${idx}::int[]))`);
        params.push(tagIncArr); idx++;
      }
      if (tagExcArr.length > 0) {
        conditions.push(`NOT EXISTS (SELECT 1 FROM property_tags pt_x WHERE pt_x.property_id = p.id AND pt_x.tag_id = ANY($${idx}::int[]))`);
        params.push(tagExcArr); idx++;
      }
      // 2026-04-21 phone_type + phone_tag parity filters.
      const VPT_SA = ['mobile','landline','voip','unknown'];
      const ptSA = qv('phone_type');
      if (ptSA && VPT_SA.includes(ptSA)) {
        conditions.push(`EXISTS (SELECT 1 FROM phones ph_pt JOIN property_contacts pc_pt ON pc_pt.contact_id = ph_pt.contact_id WHERE pc_pt.property_id = p.id AND LOWER(ph_pt.phone_type) = $${idx})`);
        params.push(ptSA); idx++;
      }
      // 2026-04-23 Phone Tag Include/Exclude parity.
      const ptagIncArr = qvAll('phone_tag_include').map(v => parseInt(v,10)).filter(Number.isFinite);
      const ptagExcArr = qvAll('phone_tag_exclude').map(v => parseInt(v,10)).filter(Number.isFinite);
      const legacyPtag = parseInt(qv('phone_tag'),10);
      if (Number.isFinite(legacyPtag) && !ptagIncArr.includes(legacyPtag)) ptagIncArr.push(legacyPtag);
      if (ptagIncArr.length > 0) {
        conditions.push(`EXISTS (SELECT 1 FROM phone_tag_links ptl_f JOIN phones ph_ptl ON ph_ptl.id = ptl_f.phone_id JOIN property_contacts pc_ptl ON pc_ptl.contact_id = ph_ptl.contact_id WHERE pc_ptl.property_id = p.id AND ptl_f.phone_tag_id = ANY($${idx}::int[]))`);
        params.push(ptagIncArr); idx++;
      }
      if (ptagExcArr.length > 0) {
        conditions.push(`NOT EXISTS (SELECT 1 FROM phone_tag_links ptl_x JOIN phones ph_ptlx ON ph_ptlx.id = ptl_x.phone_id JOIN property_contacts pc_ptlx ON pc_ptlx.contact_id = ph_ptlx.contact_id WHERE pc_ptlx.property_id = p.id AND ptl_x.phone_tag_id = ANY($${idx}::int[]))`);
        params.push(ptagExcArr); idx++;
      }
      if (qv('owner_type') && VALID_OWNER_TYPES.includes(qv('owner_type'))) {
        conditions.push(`c.owner_type = $${idx}`);
        params.push(qv('owner_type')); idx++;
      }
      const mailingAtl = qv('mailing');
      if (mailingAtl === 'clean') {
        conditions.push(`(
          c.mailing_address IS NOT NULL AND TRIM(c.mailing_address) <> ''
          AND c.mailing_city IS NOT NULL AND TRIM(c.mailing_city) <> ''
          AND c.mailing_state IS NOT NULL AND TRIM(c.mailing_state) <> ''
          AND c.mailing_zip IS NOT NULL AND TRIM(c.mailing_zip) <> ''
        )`);
      } else if (mailingAtl === 'incomplete') {
        conditions.push(`(
          c.id IS NULL
          OR c.mailing_address IS NULL OR TRIM(COALESCE(c.mailing_address,'')) = ''
          OR c.mailing_city    IS NULL OR TRIM(COALESCE(c.mailing_city,''))    = ''
          OR c.mailing_state   IS NULL OR TRIM(COALESCE(c.mailing_state,''))   = ''
          OR c.mailing_zip     IS NULL OR TRIM(COALESCE(c.mailing_zip,''))     = ''
        )`);
      }

      const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
      const idsRes = await query(`
        SELECT DISTINCT p.id
        FROM properties p
        LEFT JOIN property_contacts pc ON pc.property_id = p.id AND pc.primary_contact = true
        LEFT JOIN contacts c ON c.id = pc.contact_id
        ${where}
      `, params);
      idsToAdd = idsRes.rows.map(r => r.id);
    } else {
      // Filter user-supplied IDs to those owned by the current tenant —
      // defends against crafted POSTs targeting another tenant's properties.
      if (ids.length === 0) {
        return res.status(400).json({ error: 'No records selected.' });
      }
      const ownRes = await query(
        `SELECT id FROM properties WHERE tenant_id = $1 AND id = ANY($2::int[])`,
        [req.tenantId, ids]
      );
      idsToAdd = ownRes.rows.map(r => r.id);
    }

    if (idsToAdd.length === 0) {
      return res.status(400).json({ error: 'No valid properties to add.' });
    }

    // Count existing links first so we can report skipped count accurately.
    const existingRes = await query(
      `SELECT COUNT(*)::int AS n
         FROM property_lists
        WHERE list_id = $1 AND property_id = ANY($2::int[]) AND tenant_id = $3`,
      [listIdInt, idsToAdd, req.tenantId]
    );
    const alreadyOnList = existingRes.rows[0].n;

    // INSERT with ON CONFLICT DO NOTHING skips properties already on the list.
    // added_at defaults in the schema; we also explicitly set it for clarity.
    const result = await query(
      `INSERT INTO property_lists (tenant_id, property_id, list_id, added_at)
         SELECT $3, unnest($1::int[]), $2, NOW()
       ON CONFLICT (property_id, list_id) DO NOTHING
       RETURNING property_id`,
      [idsToAdd, listIdInt, req.tenantId]
    );
    const added = result.rowCount;
    const skipped = alreadyOnList;

    console.log(`[records/add-to-list] Added ${added} to list "${listName}" (id=${listIdInt}); ${skipped} skipped as duplicates`);
    res.json({ ok: true, added, skipped, listName, listId: listIdInt });
  } catch (e) {
    console.error('[records/add-to-list]', e);
    res.status(500).json({ error: 'Add to list failed: ' + e.message });
  }
});

module.exports = router;
