const express = require('express');
const router = express.Router();
const multer = require('multer');
const Papa = require('papaparse');
const crypto = require('crypto');
const { query, refreshOwnerPortfolioMv } = require('../db');
const { shell } = require('../shared-shell');
const { normalizeState: sharedNormalizeState } = require('./state');
// 2026-04-20 pass 12: shared phone normalizer — see phone-normalize.js.
const { normalizePhone } = require('../phone-normalize');
const { bufferToCsvText } = require('../csv-utils');
// 2026-04-21 Feature 1: owner_type inference (Person / Company / Trust).
// Used in both the single-row INSERT path (~line 1190) and the bulk-UNNEST path
// (~line 1792) so every contact created via CSV import gets classified.
const { inferOwnerType } = require('../owner-type');

// Wrapper: callers rely on string truthiness (empty string = skip). The
// shared helper returns null for garbage — we normalize that to '' here
// so existing `if (!state)` branches behave the same. Uppercase valid codes
// pass through untouched. This replaces the three older in-file copies that
// used raw .slice(0,2) fallback (which poisoned the markets table with "46"
// from ZIP codes that landed in the State column). (Audit #3.)
const { lookupStateByZip } = require('./zip-to-state');

// 2026-04-21 State Cleanup: when the state column is garbage ("Owner Occupied",
// blank, single-letter, etc.) but the ZIP is valid, recover the state from
// the ZIP prefix rather than skipping the row. This prevents good data from
// being lost during import when the CSV is messy. Only triggers when the
// primary normalizeState() returns empty — never overrides a valid explicit
// state code in the source.
function normalizeState(v, zipFallback) {
  const primary = sharedNormalizeState(v);
  if (primary) return primary;
  if (zipFallback) {
    const fromZip = lookupStateByZip(zipFallback);
    if (fromZip) return fromZip;
  }
  return '';
}

// 2026-04-18 audit fix #21: add fileFilter to reject non-CSV uploads.
const csvFileFilter = (req, file, cb) => {
  const name = String(file.originalname || '').toLowerCase();
  const okExt = /\.(csv|txt)$/.test(name);
  const okMime = ['text/csv', 'text/plain', 'application/csv', 'application/vnd.ms-excel',
                  'application/octet-stream'].includes(String(file.mimetype || '').toLowerCase());
  if (okExt || okMime) return cb(null, true);
  cb(new Error('Only CSV files are accepted. Convert xlsx/xls to CSV before uploading.'));
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: csvFileFilter,
});

function requireAuth(req, res, next) {
  if (!req.session || !req.session.authenticated) return res.redirect('/login');
  if (!req.session.tenantId) return res.redirect('/login');
  req.tenantId = req.session.tenantId;
  req.userId = req.session.userId;
  req.role = req.session.role;
  next();
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAPPING TEMPLATES — remember CSV column layouts after first manual mapping
//
// Concept: every CSV has a set of column headers. We fingerprint those headers
// (lowercased, trimmed, sorted) into a stable hash. When the same fingerprint
// shows up again, we auto-apply the previously-saved mapping.
//
// Auto-save behaviour: whenever a user clicks "Preview Import" and the
// fingerprint is new OR the mapping has changed, save it silently. This builds
// the library organically as users upload real files.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Normalizes a column name so 'Property Address', 'property_address', and
 * 'PROPERTY ADDRESS' all match. Case-insensitive, collapses whitespace and
 * separator characters, trims.
 */
function normalizeHeader(h) {
  if (!h) return '';
  return String(h).toLowerCase().trim()
    .replace(/[_\-\.]+/g, ' ')     // separators → space
    .replace(/\s+/g, ' ');         // collapse whitespace
}

/**
 * Generates a stable fingerprint for a set of CSV column headers. DROPS headers
 * containing any number 11+ (which are overflow columns Loki doesn't map anyway)
 * before hashing. Rationale: Loki maps only contacts/phones 1-10; anything
 * numbered 11+ is overflow noise. Dropping them means a mapping saved on a
 * 14-contact DealMachine file applies to 10-contact and 20-contact files alike.
 */
function fingerprintHeaders(columns) {
  const HIGH_NUMBER_RE = /\b(1[1-9]|[2-9]\d|\d{3,})\b/;
  const mappable = (columns || [])
    .map(normalizeHeader)
    .filter(Boolean)
    .filter(h => !HIGH_NUMBER_RE.test(h));  // drop overflow headers
  if (mappable.length === 0) return null;
  const unique = Array.from(new Set(mappable)).sort();
  return crypto.createHash('sha256').update(unique.join('|')).digest('hex').slice(0, 16);
}

/**
 * Idempotent schema for mapping_templates. Called before every read/write.
 *
 * Note: the `fingerprint` UNIQUE constraint is single-column for now —
 * matches the existing prod schema (the Phase 1 migration added tenant_id
 * but did not swap the unique constraint to (tenant_id, fingerprint)).
 * Phase 2 should swap to a composite unique so two tenants can share a
 * fingerprint. For Phase 1 with one tenant, single-column UNIQUE is fine.
 */
async function ensureMappingSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS mapping_templates (
      id SERIAL PRIMARY KEY,
      tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      fingerprint VARCHAR(32) NOT NULL UNIQUE,
      name TEXT,
      headers JSONB NOT NULL,
      mapping JSONB NOT NULL,
      use_count INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_mapping_templates_fp ON mapping_templates(fingerprint)`);
}

/**
 * Looks up a saved mapping by fingerprint for a tenant. Bumps use_count +
 * last_used_at if found. Returns null if no match.
 */
async function lookupMappingByFingerprint(tenantId, fingerprint) {
  if (!fingerprint) return null;
  await ensureMappingSchema();
  const r = await query(
    `SELECT id, fingerprint, name, headers, mapping, use_count, created_at, last_used_at
       FROM mapping_templates WHERE tenant_id = $1 AND fingerprint = $2 LIMIT 1`,
    [tenantId, fingerprint]
  );
  return r.rows[0] || null;
}

/**
 * Generates a friendly name from headers. Picks 2-3 distinctive ones so users
 * can identify "PropStream-style" vs "DealMachine-style" vs "county records"
 * mappings without naming them manually.
 */
function autoNameFromHeaders(columns) {
  const hints = [];
  const cols = (columns || []).map(c => String(c));
  const colsLower = cols.map(c => c.toLowerCase());
  // Brand detection by signature columns (more reliable than string match
  // against the brand name, which rarely appears in real headers)
  let brand = null;
  if (colsLower.some(c => /^contact_\d+_phone\d/.test(c) || /^contact_\d+_name$/.test(c))) {
    brand = 'DealMachine';
  } else if (colsLower.some(c => /propstream/.test(c))) {
    brand = 'PropStream';
  } else if (colsLower.some(c => /reisift/.test(c))) {
    brand = 'REISift';
  } else if (colsLower.some(c => /batch\s*skip/.test(c))) {
    brand = 'BatchSkipTrace';
  } else if (colsLower.some(c => /datasift/.test(c))) {
    brand = 'DataSift';
  } else if (colsLower.some(c => /listsource/.test(c))) {
    brand = 'Listsource';
  }
  if (brand) hints.push(brand);
  // Count mappable (sub-11) phone slots as a differentiator
  const phoneCount = cols.filter(c => {
    const m = c.match(/\b(?:ph(?:one)?|contact)\s*_?(\d+)\b/i);
    if (!m) return false;
    const n = parseInt(m[1], 10);
    return n >= 1 && n <= 10;
  }).length;
  if (phoneCount > 0) hints.push(`${phoneCount} phone cols`);
  // Total column count (raw file width — useful for quick identification)
  hints.push(`${cols.length} cols`);
  return hints.join(' · ') || 'Custom mapping';
}

/**
 * Saves or updates a mapping template. If fingerprint exists, updates the
 * mapping (so iterative edits get captured) and bumps use_count + timestamp.
 */
async function upsertMapping(tenantId, fingerprint, columns, mapping) {
  if (!fingerprint) return null;
  await ensureMappingSchema();
  const name = autoNameFromHeaders(columns);
  // ON CONFLICT (fingerprint) is single-column — see ensureMappingSchema note.
  // Safe for Phase 1 (one tenant). When the unique becomes composite, switch
  // this to ON CONFLICT (tenant_id, fingerprint).
  const r = await query(`
    INSERT INTO mapping_templates (tenant_id, fingerprint, name, headers, mapping, use_count, last_used_at)
    VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, 1, NOW())
    ON CONFLICT (fingerprint) DO UPDATE SET
      mapping      = EXCLUDED.mapping,
      headers      = EXCLUDED.headers,
      use_count    = mapping_templates.use_count + 1,
      last_used_at = NOW()
    RETURNING id, fingerprint, name, use_count
  `, [tenantId, fingerprint, name, JSON.stringify(columns), JSON.stringify(mapping)]);
  return r.rows[0];
}

/**
 * Deletes a saved mapping by fingerprint for one tenant. Returns count.
 */
async function deleteMapping(tenantId, fingerprint) {
  if (!fingerprint) return 0;
  await ensureMappingSchema();
  const r = await query(
    `DELETE FROM mapping_templates WHERE tenant_id = $1 AND fingerprint = $2`,
    [tenantId, fingerprint]
  );
  return r.rowCount;
}


// ── Loki field definitions ────────────────────────────────────────────────────
const LOKI_FIELDS = [
  // Property
  { key: 'street',          label: 'Street Address',    required: true,  group: 'Property' },
  { key: 'city',            label: 'City',              required: true,  group: 'Property' },
  { key: 'state_code',      label: 'State',             required: true,  group: 'Property' },
  { key: 'zip_code',        label: 'ZIP Code',          required: false, group: 'Property' },
  { key: 'county',          label: 'County',            required: false, group: 'Property' },
  { key: 'property_type',   label: 'Property Type',     required: false, group: 'Property' },
  { key: 'year_built',      label: 'Year Built',        required: false, group: 'Property' },
  { key: 'sqft',            label: 'Sq Ft',             required: false, group: 'Property' },
  { key: 'bedrooms',        label: 'Bedrooms',          required: false, group: 'Property' },
  { key: 'bathrooms',       label: 'Bathrooms',         required: false, group: 'Property' },
  { key: 'lot_size',        label: 'Lot Size',          required: false, group: 'Property' },
  { key: 'assessed_value',  label: 'Assessed Value',    required: false, group: 'Property' },
  { key: 'estimated_value', label: 'Estimated Value',   required: false, group: 'Property' },
  { key: 'equity_percent',  label: 'Equity %',          required: false, group: 'Property' },
  { key: 'property_status', label: 'Property Status',   required: false, group: 'Property' },
  { key: 'condition',       label: 'Condition',         required: false, group: 'Property' },
  { key: 'last_sale_date',  label: 'Last Sale Date',    required: false, group: 'Property' },
  { key: 'last_sale_price', label: 'Last Sale Price',   required: false, group: 'Property' },
  { key: 'vacant',          label: 'Vacant',            required: false, group: 'Property' },
  { key: 'source',          label: 'Source',            required: false, group: 'Property' },
  // 2026-04-21 Feature 8: the 10 Additional Info fields shipped in Feature 2.
  // These were previously UI-only (edit form); now importable via CSV.
  { key: 'apn',                 label: 'APN / Parcel ID',    required: false, group: 'Additional Info' },
  { key: 'stories',             label: 'Stories',            required: false, group: 'Additional Info' },
  { key: 'structure_type',      label: 'Structure Type',     required: false, group: 'Additional Info' },
  { key: 'legal_description',   label: 'Legal Description',  required: false, group: 'Additional Info' },
  { key: 'total_tax_owed',      label: 'Total Tax Owed',     required: false, group: 'Additional Info' },
  { key: 'tax_delinquent_year', label: 'Tax Delinquent Year',required: false, group: 'Additional Info' },
  { key: 'tax_auction_date',    label: 'Tax Auction Date',   required: false, group: 'Additional Info' },
  { key: 'deed_type',           label: 'Deed Type',          required: false, group: 'Additional Info' },
  { key: 'lien_type',           label: 'Lien Type',          required: false, group: 'Additional Info' },
  { key: 'lien_date',           label: 'Lien Date',          required: false, group: 'Additional Info' },
  // Owner
  { key: 'first_name',        label: 'Owner First Name',    required: false, group: 'Owner' },
  { key: 'last_name',         label: 'Owner Last Name',     required: false, group: 'Owner' },
  // 2026-04-23 Owner 2 — creates a secondary contact linked to the same
  // property with primary_contact=false. Dealmachine exports include
  // "Owner 2 First Name" / "Owner 2 Last Name" columns for co-owners/spouses.
  { key: 'owner_2_first_name', label: 'Owner 2 First Name', required: false, group: 'Owner' },
  { key: 'owner_2_last_name',  label: 'Owner 2 Last Name',  required: false, group: 'Owner' },
  { key: 'mailing_address',   label: 'Mailing Address',     required: false, group: 'Owner' },
  { key: 'mailing_city',      label: 'Mailing City',        required: false, group: 'Owner' },
  { key: 'mailing_state',     label: 'Mailing State',       required: false, group: 'Owner' },
  { key: 'mailing_zip',       label: 'Mailing ZIP',         required: false, group: 'Owner' },
  { key: 'email_1',           label: 'Email 1',             required: false, group: 'Owner' },
  { key: 'email_2',           label: 'Email 2',             required: false, group: 'Owner' },
  // Phones
  { key: 'phone_1',         label: 'Phone 1',           required: false, group: 'Phones' },
  { key: 'phone_type_1',    label: 'Phone 1 Type',      required: false, group: 'Phones' },
  { key: 'phone_status_1',  label: 'Phone 1 Status',    required: false, group: 'Phones' },
  { key: 'phone_2',         label: 'Phone 2',           required: false, group: 'Phones' },
  { key: 'phone_type_2',    label: 'Phone 2 Type',      required: false, group: 'Phones' },
  { key: 'phone_status_2',  label: 'Phone 2 Status',    required: false, group: 'Phones' },
  { key: 'phone_3',         label: 'Phone 3',           required: false, group: 'Phones' },
  { key: 'phone_type_3',    label: 'Phone 3 Type',      required: false, group: 'Phones' },
  { key: 'phone_status_3',  label: 'Phone 3 Status',    required: false, group: 'Phones' },
  { key: 'phone_4',         label: 'Phone 4',           required: false, group: 'Phones' },
  { key: 'phone_type_4',    label: 'Phone 4 Type',      required: false, group: 'Phones' },
  { key: 'phone_status_4',  label: 'Phone 4 Status',    required: false, group: 'Phones' },
  { key: 'phone_5',         label: 'Phone 5',           required: false, group: 'Phones' },
  { key: 'phone_type_5',    label: 'Phone 5 Type',      required: false, group: 'Phones' },
  { key: 'phone_status_5',  label: 'Phone 5 Status',    required: false, group: 'Phones' },
  { key: 'phone_6',         label: 'Phone 6',           required: false, group: 'Phones' },
  { key: 'phone_type_6',    label: 'Phone 6 Type',      required: false, group: 'Phones' },
  { key: 'phone_status_6',  label: 'Phone 6 Status',    required: false, group: 'Phones' },
  { key: 'phone_7',         label: 'Phone 7',           required: false, group: 'Phones' },
  { key: 'phone_type_7',    label: 'Phone 7 Type',      required: false, group: 'Phones' },
  { key: 'phone_status_7',  label: 'Phone 7 Status',    required: false, group: 'Phones' },
  { key: 'phone_8',         label: 'Phone 8',           required: false, group: 'Phones' },
  { key: 'phone_type_8',    label: 'Phone 8 Type',      required: false, group: 'Phones' },
  { key: 'phone_status_8',  label: 'Phone 8 Status',    required: false, group: 'Phones' },
  { key: 'phone_9',         label: 'Phone 9',           required: false, group: 'Phones' },
  { key: 'phone_type_9',    label: 'Phone 9 Type',      required: false, group: 'Phones' },
  { key: 'phone_status_9',  label: 'Phone 9 Status',    required: false, group: 'Phones' },
  { key: 'phone_10',        label: 'Phone 10',          required: false, group: 'Phones' },
  { key: 'phone_type_10',   label: 'Phone 10 Type',     required: false, group: 'Phones' },
  { key: 'phone_status_10', label: 'Phone 10 Status',   required: false, group: 'Phones' },
];

// Auto-map CSV headers to Loki fields
function autoMap(csvColumns) {
  const map = {};
  const normalize = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const lookup = {
    street: ['address','propertyaddress','streetaddress','street','propaddress'],
    city: ['city','propertycity','propercity'],
    state_code: ['state','statecode','propertystate','st'],
    zip_code: ['zip','zipcode','postalcode','propertyzip'],
    county: ['county','propertycounty'],
    property_type: ['propertytype','type','proptype'],
    year_built: ['yearbuilt','year','built','yrbuilt'],
    sqft: ['sqft','squarefeet','sqfeet','livingarea','buildingsize'],
    bedrooms: ['bedrooms','beds','bd','br'],
    bathrooms: ['bathrooms','baths','ba'],
    lot_size: ['lotsize','lot','lotarea','lotsqft'],
    assessed_value: ['assessedvalue','assessedval','taxassessedvalue','assessmentvalue','totalassessedvalue'],
    estimated_value: ['estimatedvalue','estvalue','avm','marketvalue','estimatedmarketvalue'],
    equity_percent: ['equity','equitypercent','equityperc','equitypercentage'],
    property_status: ['propertystatus','status','mlsstatus','liststatus'],
    condition: ['condition','propertycondition'],
    last_sale_date: ['lastsaledate','saledate','lastsoldate','solddate'],
    last_sale_price: ['lastsaleprice','saleprice','lastsolprice'],
    vacant: ['vacant','vacancy','isvacant'],
    source: ['source','leadsource','datasource','listsource'],
    // 2026-04-21 Feature 8: auto-map aliases for Feature 2 Additional Info
    // fields. PropStream uses apnparcelid / apn_parcel_id ; County records
    // sometimes call it parcel / parcelnumber. Date fields try multiple name
    // variants. Tax aliases include "taxamount"/"taxamt" which PropStream uses.
    apn:                 ['apn','apnparcelid','parcelid','parcelnumber','parcelnum','parcel','parcel_number','assessorparcel','assessorparcelnumber'],
    stories:             ['stories','numstories','numberofstories','storycount','floors','numfloors'],
    structure_type:      ['structuretype','constructiontype','buildingtype','buildingstructure'],
    legal_description:   ['legaldescription','legaldesc','legal','propertylegaldescription'],
    total_tax_owed:      ['totaltaxowed','taxowed','taxdue','taxdelinquentamount','delinquenttaxamount','totaldelinquenttax','taxamt','taxamount'],
    tax_delinquent_year: ['taxdelinquentyear','delinquentyear','taxyear','delinquenttaxyear'],
    tax_auction_date:    ['taxauctiondate','auctiondate','taxsaledate','saleauctiondate','trusteesaledate'],
    deed_type:           ['deedtype','typeofdeed','documenttype','deed','typedeed'],
    lien_type:           ['lientype','typeoflien','lien','lientitle'],
    lien_date:           ['liendate','dateoflien','lienrecorded','recordingdate'],
    first_name: ['firstname','ownerfirst','ownersfirstname','first','owner1firstname','owner1first','owner1fn'],
    last_name: ['lastname','ownerlast','ownerslastname','last','owner1lastname','owner1last','owner1ln'],
    // 2026-04-23 Owner 2 — Dealmachine exports as "Owner 2 First Name" / "Owner 2 Last Name"
    owner_2_first_name: ['owner2firstname','owner2first','owner2fn','co-ownerfirstname','coownerfirst','secondownerfirst'],
    owner_2_last_name:  ['owner2lastname','owner2last','owner2ln','co-ownerlastname','coownerlast','secondownerlast'],
    mailing_address: ['mailingaddress','owneraddress','mailaddress'],
    mailing_city: ['mailingcity','ownercity','mailcity'],
    mailing_state: ['mailingstate','ownerstate','mailstate'],
    mailing_zip: ['mailingzip','ownerzip','mailzip','mailingzipcode'],
    email_1: ['email1','email','email#1','primaryemail','contactemail'],
    email_2: ['email2','email#2'],
    phone_1: ['phone1','ph1','phone','phonenumber','primaryphone','ph#1'],
    phone_2: ['phone2','ph2','ph#2'],
    phone_3: ['phone3','ph3','ph#3'],
    phone_4: ['phone4','ph4','ph#4'],
    phone_5: ['phone5','ph5','ph#5'],
    phone_6: ['phone6','ph6','ph#6'],
    phone_7: ['phone7','ph7','ph#7'],
    phone_8: ['phone8','ph8','ph#8'],
    phone_9: ['phone9','ph9','ph#9'],
    phone_10: ['phone10','ph10','ph#10'],
    phone_type_1:    ['phonetype1','phone1type','type1','phonetype','ph1type','phonetype#1','phonetype 1','phone type 1','phone 1 type'],
    phone_type_2:    ['phonetype2','phone2type','type2','ph2type','phonetype#2','phonetype 2','phone type 2','phone 2 type'],
    phone_type_3:    ['phonetype3','phone3type','type3','ph3type','phonetype 3','phone type 3','phone 3 type'],
    phone_type_4:    ['phonetype4','phone4type','type4','ph4type','phonetype 4','phone type 4','phone 4 type'],
    phone_type_5:    ['phonetype5','phone5type','type5','ph5type','phonetype 5','phone type 5','phone 5 type'],
    phone_type_6:    ['phonetype6','phone6type','type6','ph6type','phonetype 6','phone type 6','phone 6 type'],
    phone_type_7:    ['phonetype7','phone7type','type7','ph7type','phonetype 7','phone type 7','phone 7 type'],
    phone_type_8:    ['phonetype8','phone8type','type8','ph8type','phonetype 8','phone type 8','phone 8 type'],
    phone_type_9:    ['phonetype9','phone9type','type9','ph9type','phonetype 9','phone type 9','phone 9 type'],
    phone_type_10:   ['phonetype10','phone10type','type10','ph10type','phonetype 10','phone type 10','phone 10 type'],
    phone_status_1:  ['phonestatus1','phone1status','status1','ph1status','phonestatus#1','phonestatus 1','phone status 1','phone 1 status'],
    phone_status_2:  ['phonestatus2','phone2status','status2','ph2status','phonestatus 2','phone status 2','phone 2 status'],
    phone_status_3:  ['phonestatus3','phone3status','status3','ph3status','phonestatus 3','phone status 3','phone 3 status'],
    phone_status_4:  ['phonestatus4','phone4status','status4','ph4status','phonestatus 4','phone status 4','phone 4 status'],
    phone_status_5:  ['phonestatus5','phone5status','status5','ph5status','phonestatus 5','phone status 5','phone 5 status'],
    phone_status_6:  ['phonestatus6','phone6status','status6','ph6status','phonestatus 6','phone status 6','phone 6 status'],
    phone_status_7:  ['phonestatus7','phone7status','status7','ph7status','phonestatus 7','phone status 7','phone 7 status'],
    phone_status_8:  ['phonestatus8','phone8status','status8','ph8status','phonestatus 8','phone status 8','phone 8 status'],
    phone_status_9:  ['phonestatus9','phone9status','status9','ph9status','phonestatus 9','phone status 9','phone 9 status'],
    phone_status_10: ['phonestatus10','phone10status','status10','ph10status','phonestatus 10','phone status 10','phone 10 status'],
  };

  for (const col of csvColumns) {
    const norm = normalize(col);
    for (const [lokiKey, aliases] of Object.entries(lookup)) {
      if (aliases.includes(norm)) {
        if (!map[lokiKey]) map[lokiKey] = col;
        break;
      }
    }
  }
  return map;
}

// ── STEP 1: Upload CSV ────────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  const existingLists = await query(`SELECT id, list_name, list_type FROM lists WHERE tenant_id = $1 ORDER BY list_name ASC`, [req.tenantId]);
  const listOptions = existingLists.rows.map(l =>
    `<option value="${l.id}" data-name="${l.list_name}">${l.list_name}${l.list_type ? ' ('+l.list_type+')' : ''}</option>`
  ).join('');

  res.send(shell('Import Properties', `
    <div style="max-width:700px">
      <div style="margin-bottom:1.5rem">
        <a href="/upload" style="font-size:13px;color:#888;text-decoration:none">← Back</a>
      </div>
      <div style="font-size:20px;font-weight:600;margin-bottom:4px">Import Property List</div>
      <p style="font-size:13px;color:#888;margin-bottom:1.5rem">Upload a CSV from any data source. You'll map your columns to Loki fields on the next step.</p>

      <div class="card">

        <!-- List Assignment -->
        <div style="margin-bottom:1.25rem">
          <div style="font-size:12px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px">Assign to List</div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <div style="flex:1;min-width:200px">
              <label style="font-size:12px;color:#888;display:block;margin-bottom:4px">New list name</label>
              <input type="text" id="new-list-name" placeholder="e.g. Code Violation IN — April 2026"
                style="width:100%;padding:9px 12px;border:1px solid #ddd;border-radius:8px;font-size:13px;font-family:inherit">
            </div>
            <div style="display:flex;align-items:center;font-size:12px;color:#aaa;padding-top:20px">or</div>
            <div style="flex:1;min-width:200px">
              <label style="font-size:12px;color:#888;display:block;margin-bottom:4px">Add to existing list</label>
              <select id="existing-list-id" style="width:100%;padding:9px 12px;border:1px solid #ddd;border-radius:8px;font-size:13px;font-family:inherit;background:#fff">
                <option value="">— Select existing list —</option>
                ${listOptions}
              </select>
            </div>
          </div>
          <div style="font-size:11px;color:#aaa;margin-top:6px">If you enter a new name and pick an existing list, the new name takes priority.</div>
          <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
            <div style="flex:1;min-width:150px">
              <label style="font-size:12px;color:#888;display:block;margin-bottom:4px">List Type</label>
              <select id="list-type" style="width:100%;padding:9px 12px;border:1px solid #ddd;border-radius:8px;font-size:13px;font-family:inherit;background:#fff">
                <option value="">— Type (optional) —</option>
                <option value="Cold Call">Cold Call</option>
                <option value="SMS">SMS</option>
                <option value="Direct Mail">Direct Mail</option>
                <option value="PPL">PPL</option>
                <option value="Referral">Referral</option>
                <option value="Driving for Dollars">Driving for Dollars</option>
              </select>
            </div>
            <div style="flex:1;min-width:150px">
              <label style="font-size:12px;color:#888;display:block;margin-bottom:4px">Source</label>
              <select id="list-source" onchange="document.getElementById('list-source-custom').style.display = this.value === '__custom__' ? 'block' : 'none'; if(this.value === '__custom__') document.getElementById('list-source-custom').focus();" style="width:100%;padding:9px 12px;border:1px solid #ddd;border-radius:8px;font-size:13px;font-family:inherit;background:#fff">
                <option value="">— Source (optional) —</option>
                <option value="PropStream">PropStream</option>
                <option value="DealMachine">DealMachine</option>
                <option value="BatchSkipTracing">BatchSkipTracing</option>
                <option value="REISift">REISift</option>
                <option value="DataSift">DataSift</option>
                <option value="Listsource">Listsource</option>
                <option value="Manual">Manual</option>
                <option value="__custom__">+ Add custom source…</option>
              </select>
              <input type="text" id="list-source-custom" placeholder="e.g. County Records, Cook County Auditor"
                style="display:none;width:100%;margin-top:6px;padding:9px 12px;border:1px solid #ddd;border-radius:8px;font-size:13px;font-family:inherit">
            </div>
          </div>
        </div>

        <div style="border-top:1px solid #f0efe9;margin-bottom:1.25rem"></div>

        <!-- Drop zone -->
        <div class="drop-zone" id="drop-zone">
          <strong style="font-size:15px">Drop CSV here or click to browse</strong>
          <p style="font-size:12px;color:#888;margin-top:6px">PropStream, DealMachine, BatchSkipTrace, or any CSV export</p>
        </div>
        <input type="file" id="file-input" accept=".csv" style="display:none">
        <div id="upload-spinner" style="display:none;align-items:center;gap:8px;font-size:13px;color:#888;padding:10px 0">
          <div class="spinner"></div> Parsing CSV…
        </div>
        <div id="error-msg" style="display:none;background:#fff0f0;border:1px solid #f5c5c5;border-radius:8px;padding:10px 14px;font-size:13px;color:#c0392b;margin-top:10px"></div>
      </div>
    </div>

    <script>
    const dz = document.getElementById('drop-zone');
    const fi = document.getElementById('file-input');
    dz.addEventListener('click', () => fi.click());
    dz.addEventListener('dragover', e => { e.preventDefault(); dz.style.borderColor='#888'; });
    dz.addEventListener('dragleave', () => dz.style.borderColor='');
    dz.addEventListener('drop', e => { e.preventDefault(); dz.style.borderColor=''; if(e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });
    fi.addEventListener('change', e => { if(e.target.files[0]) handleFile(e.target.files[0]); });

    // Mutual exclusivity: typing new name clears existing list selection
    document.getElementById('new-list-name').addEventListener('input', function() {
      if (this.value.trim()) document.getElementById('existing-list-id').value = '';
    });
    document.getElementById('existing-list-id').addEventListener('change', function() {
      if (this.value) document.getElementById('new-list-name').value = '';
    });

    async function handleFile(file) {
      if (!file.name.endsWith('.csv')) { showError('CSV files only.'); return; }
      const newName = document.getElementById('new-list-name').value.trim();
      const existingId = document.getElementById('existing-list-id').value;
      const listType = document.getElementById('list-type').value;
      // Source: if "Custom..." was selected, read the text input instead
      const sourceSelect = document.getElementById('list-source').value;
      const listSource = sourceSelect === '__custom__'
        ? document.getElementById('list-source-custom').value.trim()
        : sourceSelect;
      if (sourceSelect === '__custom__' && !listSource) {
        showError('Please type a custom source name or pick a different option.'); return;
      }
      if (!newName && !existingId) { showError('Please enter a list name or select an existing list before uploading.'); return; }
      document.getElementById('upload-spinner').style.display = 'flex';
      dz.style.opacity = '0.5';
      const form = new FormData();
      form.append('csvfile', file);
      try {
        const res = await fetch('/import/property/parse', { method: 'POST', body: form });
        const data = await res.json();
        if (!res.ok || data.error) { showError(data.error || 'Failed to parse.'); return; }
        const importMeta = {
          columns:    data.columns,
          previewRows: data.previewRows,
          totalRows:  data.totalRows,
          mapping:    data.mapping,
          filename:   data.filename,
          fingerprint: data.fingerprint,
          savedTemplate: data.savedTemplate,
          listName:   newName || document.getElementById('existing-list-id').options[document.getElementById('existing-list-id').selectedIndex]?.dataset?.name || '',
          listId:     existingId || null,
          listType:   listType,
          listSource: listSource
        };
        sessionStorage.setItem('loki_import', JSON.stringify(importMeta));
        window.location.href = '/import/property/map';
      } catch(e) { showError(e.message); }
      finally { document.getElementById('upload-spinner').style.display='none'; dz.style.opacity='1'; }
    }
    function showError(msg) {
      const el = document.getElementById('error-msg');
      el.textContent = msg; el.style.display='block';
    }
    </script>
  `, 'upload'));
});

// ── PARSE ─────────────────────────────────────────────────────────────────────
router.post('/parse', requireAuth, upload.single('csvfile'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const parsed = Papa.parse(bufferToCsvText(req.file.buffer), { header: true, skipEmptyLines: true });
    const columns = parsed.meta.fields || [];
    const rows = parsed.data;

    // 2026-04-21 Gap #6: Papa.parse never throws — it returns warnings in
    // parsed.errors. Previously we ignored that array entirely and handed
    // potentially garbage rows to the downstream pipeline (mapping modal,
    // preview, eventual INSERT). Two error classes matter:
    //   • Quotes / Delimiter errors signal the whole file is mis-parsed
    //     (unmatched quote cascades — every row after the break is
    //     misaligned). These are FATAL — refuse the upload and tell the
    //     user exactly which row broke.
    //   • FieldMismatch errors mean individual rows have too few or too
    //     many commas vs. the header. These are per-row and survivable —
    //     the row just has misaligned values but the rest of the file is
    //     fine. We surface the count in the response so the user knows
    //     their CSV has dirty rows, but don't block the import.
    const parseErrors = parsed.errors || [];
    const fatalErr = parseErrors.find(e => e.type === 'Quotes' || e.type === 'Delimiter');
    if (fatalErr) {
      const rowHint = (fatalErr.row != null) ? ` near row ${fatalErr.row + 1}` : '';
      return res.status(400).json({
        error: `CSV is malformed${rowHint}: ${fatalErr.message}. This usually means an unmatched quote or wrong delimiter. Open the file in a text editor, find the bad row, and resave — or re-export the source CSV.`
      });
    }
    const mismatchCount = parseErrors.filter(e => e.type === 'FieldMismatch').length;
    // Expose the mismatch count downstream so the preview page can warn the
    // user. Non-fatal — the import continues.
    if (mismatchCount > 0) {
      console.warn(`[import/parse] ${mismatchCount} rows had field-count mismatches (ignored, but rows may be misaligned)`);
    }

    if (!rows.length) return res.status(400).json({ error: 'File is empty.' });
    const MAX_ROWS = 100000;
    if (rows.length > MAX_ROWS) {
      return res.status(400).json({ error: `File has ${rows.length.toLocaleString()} rows. Use Bulk Import for files over 100k rows.` });
    }

    // Generate fingerprint of this CSV's column layout. If we've seen it before,
    // use the saved mapping. Otherwise, fall back to the heuristic autoMap().
    const fingerprint = fingerprintHeaders(columns);
    let mapping = autoMap(columns);
    const autoMapCount = Object.keys(mapping).length;
    let savedTemplate = null;
    try {
      const template = await lookupMappingByFingerprint(req.tenantId, fingerprint);
      if (template) {
        // A saved mapping might reference a column that doesn't exist in this
        // file (headers drifted slightly). Filter out dead references.
        const colSet = new Set(columns);
        const filtered = {};
        for (const [lokiKey, csvCol] of Object.entries(template.mapping || {})) {
          if (colSet.has(csvCol)) filtered[lokiKey] = csvCol;
        }
        // 2026-04-21 fix: merge saved template OVER autoMap instead of
        // replacing it. Pre-fix, `mapping = filtered` wiped any field
        // autoMap caught that the user hadn't explicitly configured in
        // the mapping modal. Result: DealMachine CSV had first_name and
        // last_name auto-detectable (phone/street/etc were in the saved
        // template, so template-replace dropped the names). Owner fields
        // came out blank despite being right there in the CSV. Now:
        // autoMap provides the baseline, template overrides win where
        // present. Users who DID configure a field keep their override;
        // fields autoMap can infer flow through automatically.
        if (Object.keys(filtered).length > 0) {
          mapping = { ...mapping, ...filtered };
          savedTemplate = {
            fingerprint: template.fingerprint,
            name: template.name,
            use_count: template.use_count,
          };
          const total = Object.keys(mapping).length;
          const templateCount = Object.keys(filtered).length;
          console.log(`[mapping matched] fingerprint=${fingerprint} name="${template.name}" use_count=${template.use_count} → ${total} fields mapped (${templateCount} from saved template, ${total - templateCount} auto-detected filled gaps)`);
        } else {
          console.log(`[mapping matched but stale] fingerprint=${fingerprint} — all saved columns missing from this CSV, falling back to autoMap (${autoMapCount} fields)`);
        }
      } else {
        console.log(`[mapping not found] fingerprint=${fingerprint} — using autoMap (${autoMapCount} fields); will save if user completes import`);
      }
    } catch (e) {
      // Non-fatal — if the lookup fails, we still have autoMap
      console.error('[import/parse] mapping lookup failed:', e.message);
    }

    // Cap rows stored in session at 50k (Audit #8). Huge REISift exports can
    // pin 500+ MB in Express session memory otherwise. User is told the count
    // and can use /import/bulk for bigger files. Preview always shows first 10.
    const ROW_CAP = 50_000;
    const rowsToStore = rows.length > ROW_CAP ? rows.slice(0, ROW_CAP) : rows;
    const wasCapped = rows.length > ROW_CAP;

    req.session.importRows = rowsToStore;
    req.session.save();
    res.json({
      columns,
      previewRows: rowsToStore.slice(0, 10),
      totalRows: rowsToStore.length,
      originalRows: rows.length,
      wasCapped,
      capNote: wasCapped ? `File has ${rows.length.toLocaleString()} rows — importing first ${ROW_CAP.toLocaleString()}. For larger imports, use the REISift Bulk Import flow at /import/bulk which streams from disk.` : null,
      mapping,
      filename: req.file.originalname,
      fingerprint,
      savedTemplate,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Save a user-confirmed mapping (called from the Map Columns page) ──────────
// Fires after the user clicks Preview Import. Silently upserts by fingerprint.
// If nothing has changed, this is still safe — the ON CONFLICT branch updates
// use_count and last_used_at, giving us "which templates are hot" telemetry.
router.post('/save-mapping', requireAuth, async (req, res) => {
  try {
    const { columns, mapping, fingerprint } = req.body;
    if (!fingerprint || !columns || !mapping) {
      return res.status(400).json({ error: 'Missing fingerprint, columns, or mapping.' });
    }
    if (!Array.isArray(columns) || typeof mapping !== 'object') {
      return res.status(400).json({ error: 'Bad request shape.' });
    }
    // Recompute fingerprint server-side; if the client-supplied value doesn't
    // match, reject. Prevents a client from silently corrupting saved templates
    // with a mismatched fingerprint/headers pair.
    const expected = fingerprintHeaders(columns);
    if (expected !== fingerprint) {
      return res.status(400).json({ error: 'Fingerprint mismatch — refusing to save.' });
    }
    // Defense-in-depth: sanitize the mapping so every value is an actual CSV
    // column from THIS file. A tampered DOM could otherwise inject arbitrary
    // strings into saved templates.
    const colSet = new Set(columns.map(c => String(c)));
    const cleanMapping = {};
    for (const [lokiKey, csvCol] of Object.entries(mapping)) {
      if (typeof lokiKey === 'string' && typeof csvCol === 'string' && colSet.has(csvCol)) {
        cleanMapping[lokiKey] = csvCol;
      }
    }
    if (Object.keys(cleanMapping).length === 0) {
      return res.status(400).json({ error: 'No valid mappings to save.' });
    }
    const saved = await upsertMapping(req.tenantId, fingerprint, columns, cleanMapping);
    console.log(`[mapping saved] fingerprint=${fingerprint} name="${saved?.name}" use_count=${saved?.use_count} cols=${columns.length} mapped=${Object.keys(cleanMapping).length}`);
    res.json({ ok: true, saved });
  } catch(e) {
    console.error('[import/save-mapping]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Delete a saved mapping by fingerprint (called from the badge on Map page) ─
router.post('/delete-mapping', requireAuth, async (req, res) => {
  try {
    const { fingerprint } = req.body;
    if (!fingerprint || !/^[a-f0-9]{16}$/.test(String(fingerprint))) {
      return res.status(400).json({ error: 'Invalid fingerprint format.' });
    }
    const deleted = await deleteMapping(req.tenantId, fingerprint);
    res.json({ ok: true, deleted });
  } catch(e) {
    console.error('[import/delete-mapping]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── STEP 2: Map columns ───────────────────────────────────────────────────────
router.get('/map', requireAuth, (req, res) => {
  const fieldsByGroup = group => LOKI_FIELDS.filter(f => f.group === group);

  const fieldRow = f => `
    <div style="display:flex;align-items:center;gap:10px;min-width:0">
      <div style="width:130px;font-size:13px;color:${f.required?'#1a1a1a':'#555'};flex-shrink:0;font-weight:${f.required?'500':'400'}">
        ${f.label}${f.required?' <span style="color:#c0392b">*</span>':''}
      </div>
      <select id="map_${f.key}" data-loki="${f.key}" style="flex:1;min-width:0;padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit;background:#fff">
        <option value="">— Skip —</option>
      </select>
    </div>`;

  // For phones: group each phone's number+type+status into one row
  const phoneNums = [1,2,3,4,5,6,7,8,9,10];
  const phoneHTML = phoneNums.map(n => `
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px 16px;padding:8px 0;border-bottom:1px solid #f0efe9">
      ${fieldRow({key:`phone_${n}`,       label:`Phone ${n}`,        required:false})}
      ${fieldRow({key:`phone_type_${n}`,  label:`Phone ${n} Type`,   required:false})}
      ${fieldRow({key:`phone_status_${n}`,label:`Phone ${n} Status`, required:false})}
    </div>`).join('');

  const groupHTML = ['Property','Owner'].map(group => `
    <div style="margin-bottom:1.5rem">
      <div style="font-size:11px;font-weight:700;color:#aaa;text-transform:uppercase;letter-spacing:.1em;margin-bottom:12px">${group}</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:10px 32px">
        ${fieldsByGroup(group).map(f => fieldRow(f)).join('')}
      </div>
    </div>`).join('') + `
    <div style="margin-bottom:1rem">
      <div style="font-size:11px;font-weight:700;color:#aaa;text-transform:uppercase;letter-spacing:.1em;margin-bottom:4px">Phones</div>
      <div style="display:grid;grid-template-columns:130px 1fr;gap:4px 0;margin-bottom:8px;font-size:11px;color:#aaa;font-weight:600;text-transform:uppercase;letter-spacing:.05em;padding:0 0 4px 0;border-bottom:2px solid #e0dfd8">
        <div></div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px 16px">
          <div>Number</div><div>Type</div><div>Status</div>
        </div>
      </div>
      ${phoneHTML}
    </div>`;

  res.send(shell('Map Columns', `
    <div style="max-width:100%">
      <div style="margin-bottom:1.5rem"><a href="/import/property" style="font-size:13px;color:#888;text-decoration:none">← Back</a></div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.5rem;flex-wrap:wrap;gap:12px">
        <div>
          <div style="font-size:20px;font-weight:600;margin-bottom:4px">Map Columns</div>
          <div style="font-size:13px;color:#888" id="file-info">Loading…</div>
          <div style="display:flex;gap:8px;align-items:center;margin-top:6px;flex-wrap:wrap">
            <div id="list-badge" style="display:none;align-items:center;gap:6px;background:#e8f5ee;color:#1a7a4a;border-radius:6px;padding:4px 10px;font-size:12px;font-weight:600"></div>
            <div id="template-badge" style="display:none;align-items:center;gap:8px;background:#eef2fb;color:#2a4a8a;border:1px solid #c5d5f5;border-radius:6px;padding:4px 10px;font-size:12px;font-weight:500">
              <span id="template-badge-text"></span>
              <button onclick="deleteTemplate()" title="Delete this saved mapping" style="background:none;border:none;cursor:pointer;color:#2a4a8a;font-size:14px;line-height:1;padding:0;font-family:inherit">🗑</button>
            </div>
          </div>
        </div>
        <button onclick="proceed()" class="btn-submit" style="width:auto;padding:9px 24px">Preview Import →</button>
      </div>

      <div class="card">
        ${groupHTML}
      </div>

      <div id="error-msg" style="display:none;background:#fff0f0;border:1px solid #f5c5c5;border-radius:8px;padding:10px 14px;font-size:13px;color:#c0392b;margin-top:10px"></div>
    </div>

    <script>
    const importData = JSON.parse(sessionStorage.getItem('loki_import') || '{}');
    const columns = importData.columns || [];
    const mapping = importData.mapping || {};
    const fingerprint = importData.fingerprint || null;
    const savedTemplate = importData.savedTemplate || null;

    document.getElementById('file-info').textContent =
      (importData.filename || 'Unknown file') + ' — ' + (importData.totalRows || 0).toLocaleString() + ' rows';
    if (importData.listName) {
      const badge = document.getElementById('list-badge');
      badge.textContent = '📋 ' + importData.listName;
      badge.style.display = 'inline-flex';
    }
    if (savedTemplate && savedTemplate.name) {
      const tb = document.getElementById('template-badge');
      const tt = document.getElementById('template-badge-text');
      tt.textContent = '✨ Using saved mapping: ' + savedTemplate.name + ' (' + savedTemplate.use_count + ' use' + (savedTemplate.use_count===1?'':'s') + ')';
      tb.style.display = 'inline-flex';
    }

    // Populate all dropdowns with CSV columns
    document.querySelectorAll('select[data-loki]').forEach(sel => {
      columns.forEach(col => {
        const opt = document.createElement('option');
        opt.value = col; opt.textContent = col;
        sel.appendChild(opt);
      });
      // Apply auto-mapping (or saved template, already merged into mapping by server)
      const lokiKey = sel.dataset.loki;
      if (mapping[lokiKey]) sel.value = mapping[lokiKey];
    });

    async function deleteTemplate() {
      if (!fingerprint) return;
      if (!confirm('Delete this saved mapping? Next time you upload a file with these headers, Loki will fall back to auto-detection.')) return;
      try {
        const res = await fetch('/import/property/delete-mapping', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fingerprint })
        });
        if (res.ok) {
          document.getElementById('template-badge').style.display = 'none';
          // Clear from session so this page doesn't show stale info on refresh
          importData.savedTemplate = null;
          sessionStorage.setItem('loki_import', JSON.stringify(importData));
        } else {
          alert('Failed to delete saved mapping.');
        }
      } catch(err) {
        alert('Network error: ' + err.message);
      }
    }

    async function proceed() {
      const finalMapping = {};
      document.querySelectorAll('select[data-loki]').forEach(sel => {
        if (sel.value) finalMapping[sel.dataset.loki] = sel.value;
      });
      if (!finalMapping.street || !finalMapping.city || !finalMapping.state_code) {
        const el = document.getElementById('error-msg');
        el.textContent = 'Street Address, City and State are required.';
        el.style.display = 'block';
        return;
      }
      importData.finalMapping = finalMapping;
      sessionStorage.setItem('loki_import', JSON.stringify(importData));

      // Save the mapping to the template library BEFORE navigating away. The
      // keepalive:true flag tells the browser not to cancel this request
      // when the page unloads — unlike plain fetch(), which browsers kill
      // mid-flight on navigation, causing saves to silently fail.
      if (fingerprint) {
        try {
          const res = await fetch('/import/property/save-mapping', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fingerprint, columns, mapping: finalMapping }),
            keepalive: true,
            credentials: 'same-origin'
          });
          if (!res.ok) {
            const txt = await res.text().catch(() => '');
            console.error('[mapping save] HTTP', res.status, txt.slice(0, 200));
          } else {
            const j = await res.json().catch(() => null);
            console.log('[mapping save] ok', j);
          }
        } catch(e) {
          console.error('[mapping save] error:', e.message);
        }
      }

      window.location.href = '/import/property/preview';
    }
    </script>
  `, 'upload'));
});

// ── STEP 3: Preview ───────────────────────────────────────────────────────────
router.get('/preview', requireAuth, (req, res) => {
  res.send(shell('Preview Import', `
    <div style="max-width:100%">
      <div style="margin-bottom:1.5rem"><a href="/import/property/map" style="font-size:13px;color:#888;text-decoration:none">← Back to mapping</a></div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.5rem;flex-wrap:wrap;gap:12px">
        <div>
          <div style="font-size:20px;font-weight:600;margin-bottom:4px">Preview Import</div>
          <div style="font-size:13px;color:#888" id="preview-info">Loading…</div>
          <div id="list-badge" style="display:none;margin-top:6px;align-items:center;gap:6px;background:#e8f5ee;color:#1a7a4a;border-radius:6px;padding:4px 10px;font-size:12px;font-weight:600"></div>
        </div>
        <div style="display:flex;gap:8px">
          <button onclick="startImport()" class="btn-submit" style="width:auto;padding:9px 24px" id="import-btn">Import Records</button>
        </div>
      </div>

      <!-- 2026-04-21 Feature 8(a): import-mode 3-way toggle. Controls the
           UPSERT branch on the server — "add_only" skips addresses that
           already exist (INSERT ... ON CONFLICT DO NOTHING), "update_only"
           skips brand-new rows (WHERE EXISTS pre-filter), "add_and_update"
           (the default) does the current COALESCE safe-merge UPSERT. -->
      <div class="card" style="margin-bottom:1.5rem;padding:14px 16px">
        <div style="font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px">Import mode</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px">
          <label style="flex:1;min-width:220px;display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border:1px solid #ddd;border-radius:8px;cursor:pointer;font-size:13px;background:#fff" onmouseover="this.style.borderColor='#1a1a1a'" onmouseout="this.style.borderColor='#ddd'">
            <input type="radio" name="import_mode" value="add_and_update" checked style="margin-top:2px">
            <div>
              <div style="font-weight:600;color:#1a1a1a">Add new + update existing</div>
              <div style="font-size:11px;color:#888;margin-top:2px">Default. New addresses get inserted; existing rows have blank fields filled in (non-blank DB values are never overwritten).</div>
            </div>
          </label>
          <label style="flex:1;min-width:220px;display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border:1px solid #ddd;border-radius:8px;cursor:pointer;font-size:13px;background:#fff" onmouseover="this.style.borderColor='#1a1a1a'" onmouseout="this.style.borderColor='#ddd'">
            <input type="radio" name="import_mode" value="add_only" style="margin-top:2px">
            <div>
              <div style="font-weight:600;color:#1a1a1a">Add new only</div>
              <div style="font-size:11px;color:#888;margin-top:2px">Skip any address already in Loki. Use for clean "net new" imports where existing data must not be touched.</div>
            </div>
          </label>
          <label style="flex:1;min-width:220px;display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border:1px solid #ddd;border-radius:8px;cursor:pointer;font-size:13px;background:#fff" onmouseover="this.style.borderColor='#1a1a1a'" onmouseout="this.style.borderColor='#ddd'">
            <input type="radio" name="import_mode" value="update_only" style="margin-top:2px">
            <div>
              <div style="font-weight:600;color:#1a1a1a">Update existing only</div>
              <div style="font-size:11px;color:#888;margin-top:2px">Skip any address not yet in Loki. Use for skip-trace re-runs where you only want to enrich known properties.</div>
            </div>
          </label>
        </div>
      </div>

      <div id="progress-bar" style="display:none;margin-bottom:1rem">
        <div style="background:#f0efe9;border-radius:6px;height:8px;overflow:hidden">
          <div id="progress-fill" style="background:#1a1a1a;height:8px;width:0%;transition:width .3s;border-radius:6px"></div>
        </div>
        <div style="font-size:12px;color:#888;margin-top:4px" id="progress-text">Starting…</div>
      </div>

      <div id="import-result" style="display:none;margin-bottom:1rem"></div>

      <div class="card" style="padding:0;overflow:hidden">
        <div style="overflow-x:auto;max-height:500px;overflow-y:auto">
          <table class="data-table" id="preview-table">
            <thead><tr id="preview-head"></tr></thead>
            <tbody id="preview-body"></tbody>
          </table>
        </div>
      </div>
    </div>

    <script>
    const importData = JSON.parse(sessionStorage.getItem('loki_import') || '{}');
    const mapping = importData.finalMapping || {};
    const previewRows = importData.previewRows || [];
    const totalRows = importData.totalRows || 0;

    document.getElementById('preview-info').textContent =
      (importData.filename||'') + ' — ' + totalRows.toLocaleString() + ' rows · Showing first ' + Math.min(previewRows.length, 10);
    if (importData.listName) {
      const badge = document.getElementById('list-badge');
      badge.textContent = '📋 ' + importData.listName;
      badge.style.display = 'inline-flex';
    }

    // Build preview table from previewRows
    const lokiKeys = Object.keys(mapping);
    const thead = document.getElementById('preview-head');
    const tbody = document.getElementById('preview-body');
    lokiKeys.forEach(k => { const th=document.createElement('th'); th.textContent=mapping[k]; thead.appendChild(th); });
    previewRows.slice(0,10).forEach(row => {
      const tr = document.createElement('tr');
      lokiKeys.forEach(k => {
        const td = document.createElement('td');
        td.textContent = row[mapping[k]] || '';
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });

    async function startImport() {
      const btn = document.getElementById('import-btn');
      btn.disabled = true;
      btn.textContent = 'Starting…';
      document.getElementById('progress-bar').style.display = 'block';
      document.getElementById('progress-text').textContent = 'Queuing import…';

      try {
        // 2026-04-21 Feature 8(a): read selected import mode from radio.
        var modeRadio = document.querySelector('input[name="import_mode"]:checked');
        var importMode = (modeRadio && modeRadio.value) || 'add_and_update';
        const res = await fetch('/import/property/start-job', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mapping,
            filename: importData.filename,
            listName:   importData.listName   || null,
            listId:     importData.listId     || null,
            listType:   importData.listType   || null,
            listSource: importData.listSource || null,
            importMode: importMode
          })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        const jobId = data.jobId;
        const listId = data.resolvedListId;
        window._resolvedListId = listId;
        sessionStorage.removeItem('loki_import');

        // Poll for progress
        document.getElementById('progress-text').textContent = 'Import running in background…';
        btn.textContent = 'View Activity →';
        btn.disabled = false;
        btn.style.background = '#2c5cc5';
        btn.onclick = () => window.location.href = '/activity';

        document.getElementById('import-result').style.display = 'block';
        document.getElementById('import-result').innerHTML =
          '<div style="background:#e8f0ff;border:1px solid #c5d5f5;border-radius:8px;padding:12px 16px;font-size:13px;color:#2c5cc5">'
          + '🔄 Import running in the background — <strong>' + totalRows.toLocaleString() + ' rows</strong> queued.'
          + ' You can navigate away and check progress on the <a href="/activity" style="color:#2c5cc5;font-weight:600">Activity page</a>.'
          + (listId ? ' · <a href="/records?list_id='+listId+'" style="color:#2c5cc5;font-weight:600">View List →</a>' : '')
          + '</div>';

        // Poll progress bar
        const poll = setInterval(async () => {
          try {
            const pr = await fetch('/activity/job/' + jobId);
            const pd = await pr.json();
            if (pd.total > 0) {
              const pct = Math.round((pd.processed / pd.total) * 100);
              document.getElementById('progress-fill').style.width = pct + '%';
              document.getElementById('progress-text').textContent = pd.processed.toLocaleString() + ' / ' + pd.total.toLocaleString() + ' processed';
            }
            if (pd.status === 'complete' || pd.status === 'error') {
              clearInterval(poll);
              document.getElementById('progress-fill').style.width = '100%';
              document.getElementById('progress-text').textContent = pd.status === 'complete' ? 'Complete ✓' : 'Error — check Activity page';
              if (pd.status === 'complete') {
                document.getElementById('import-result').innerHTML =
                  '<div style="background:#e8f5ee;border:1px solid #c3e6cc;border-radius:8px;padding:12px 16px;font-size:13px;color:#1a7a4a">'
                  + '✓ Import complete — <strong>' + pd.inserted.toLocaleString() + '</strong> new, <strong>' + pd.updated.toLocaleString() + '</strong> updated'
                  + (pd.errors > 0 ? ', <span style="color:#c0392b">'+pd.errors+' errors</span>' : '')
                  + (listId ? ' · <a href="/records?list_id='+listId+'" style="color:#1a7a4a;font-weight:600">View Records →</a>' : ' · <a href="/records" style="color:#1a7a4a;font-weight:600">View Records →</a>')
                  + '</div>';
                btn.textContent = 'View Records →';
                btn.style.background = '#1a7a4a';
                btn.onclick = () => listId ? window.location.href='/records?list_id='+listId : window.location.href='/records';
              }
            }
          } catch(e) {
            // pass 12: was an empty catch — a server-side 500 during poll
            // now logs to console so the operator can at least diagnose from
            // DevTools instead of staring at a frozen progress bar.
            console.warn('[import/poll] failed:', e && e.message ? e.message : e);
          }
        }, 2000);

      } catch(e) {
        btn.disabled = false;
        btn.textContent = 'Import Records';
        document.getElementById('progress-text').textContent = 'Error: ' + e.message;
      }
    }
    </script>
  `, 'upload'));
});

// ── COMMIT: Save batch to DB ──────────────────────────────────────────────────
router.post('/commit', requireAuth, async (req, res) => {
  try {
    const { mapping, filename, listName, listId, listType, listSource, offset, batchSize } = req.body;
    if (!mapping) return res.status(400).json({ error: 'Missing mapping.' });
    // 2026-04-21 Feature 8(a): import-mode whitelist; defaults to the safe
    // "add + update" behavior Loki has always used if client omits the field.
    const VALID_IMPORT_MODES = ['add_and_update', 'add_only', 'update_only'];
    const MODE = VALID_IMPORT_MODES.includes(req.body.importMode) ? req.body.importMode : 'add_and_update';

    // Read rows from server session
    const allRows = req.session.importRows;
    if (!allRows || !allRows.length) return res.status(400).json({ error: 'Session expired. Please re-upload your file.' });
    const rows = allRows.slice(offset || 0, (offset || 0) + (batchSize || 500));

    let created = 0, updated = 0, errors = 0;
    // 2026-04-20 pass 12: local error var instead of `global._importFirstError`.
    // The global was module-wide state — two concurrent /commit calls trampled
    // each other's error messages, and the failure path never cleared it so
    // stale errors could contaminate the next success response.
    let firstError = null;

    const tenantId = req.tenantId;

    // ── Resolve list: create new or use existing ──────────────────────────────
    let resolvedListId = null;
    if (listName && listName.trim()) {
      // 2026-04-20 pass 12: atomic UPSERT. ON CONFLICT (list_name) is
      // single-column — same Phase 2 caveat as markets/mapping_templates.
      const upserted = await query(
        `INSERT INTO lists (tenant_id, list_name, list_type, source, upload_date, active)
         VALUES ($1, $2, $3, $4, NOW(), true)
         ON CONFLICT (list_name) DO UPDATE SET list_name = EXCLUDED.list_name
         RETURNING id`,
        [tenantId, listName.trim(), listType || null, listSource || null]
      );
      resolvedListId = upserted.rows[0].id;
    } else if (listId) {
      resolvedListId = parseInt(listId);
    }

    // Ensure markets exist for this tenant. ON CONFLICT key is (state_code) —
    // works for one tenant; Phase 2 needs (tenant_id, state_code).
    await query(`INSERT INTO markets (tenant_id,name,state_code,state_name) VALUES
      ($1,'AL','AL','Alabama'),($1,'AK','AK','Alaska'),($1,'AZ','AZ','Arizona'),($1,'AR','AR','Arkansas'),($1,'CA','CA','California'),
      ($1,'CO','CO','Colorado'),($1,'CT','CT','Connecticut'),($1,'DE','DE','Delaware'),($1,'FL','FL','Florida'),($1,'GA','GA','Georgia'),
      ($1,'HI','HI','Hawaii'),($1,'ID','ID','Idaho'),($1,'IL','IL','Illinois'),($1,'IN','IN','Indiana'),($1,'IA','IA','Iowa'),
      ($1,'KS','KS','Kansas'),($1,'KY','KY','Kentucky'),($1,'LA','LA','Louisiana'),($1,'ME','ME','Maine'),($1,'MD','MD','Maryland'),
      ($1,'MA','MA','Massachusetts'),($1,'MI','MI','Michigan'),($1,'MN','MN','Minnesota'),($1,'MS','MS','Mississippi'),($1,'MO','MO','Missouri'),
      ($1,'MT','MT','Montana'),($1,'NE','NE','Nebraska'),($1,'NV','NV','Nevada'),($1,'NH','NH','New Hampshire'),($1,'NJ','NJ','New Jersey'),
      ($1,'NM','NM','New Mexico'),($1,'NY','NY','New York'),($1,'NC','NC','North Carolina'),($1,'ND','ND','North Dakota'),($1,'OH','OH','Ohio'),
      ($1,'OK','OK','Oklahoma'),($1,'OR','OR','Oregon'),($1,'PA','PA','Pennsylvania'),($1,'RI','RI','Rhode Island'),($1,'SC','SC','South Carolina'),
      ($1,'SD','SD','South Dakota'),($1,'TN','TN','Tennessee'),($1,'TX','TX','Texas'),($1,'UT','UT','Utah'),($1,'VT','VT','Vermont'),
      ($1,'VA','VA','Virginia'),($1,'WA','WA','Washington'),($1,'WV','WV','West Virginia'),($1,'WI','WI','Wisconsin'),($1,'WY','WY','Wyoming')
      ON CONFLICT (state_code) DO UPDATE SET name=EXCLUDED.name, state_name=EXCLUDED.state_name`, [tenantId]);
    const mktRes = await query(`SELECT id, state_code FROM markets WHERE tenant_id = $1`, [tenantId]);
    const mktMap = {};
    mktRes.rows.forEach(m => { mktMap[m.state_code] = m.id; });

    const get = (row, key) => {
      const col = mapping[key];
      return col ? (row[col] || '').toString().trim() : '';
    };

    // 2026-04-21 Crash prevention: VARCHAR columns have finite widths in the
    // schema, but user CSVs can contain arbitrarily long strings in any cell
    // (misaligned columns, junk pastes, malformed exports). When a row's
    // value exceeds the VARCHAR limit, Postgres raises `value too long for
    // type character varying(N)` and aborts the batch. This helper clips
    // values to the schema limit before INSERT so the import never crashes
    // on oversized data — we'd rather truncate than lose the row entirely.
    // Field limits mirror src/db.js schema exactly.
    const FIELD_LIMITS = {
      street: 255, city: 100, county: 100, property_type: 50, source: 100,
      condition: 50, property_status: 50, structure_type: 50, apn: 50,
      deed_type: 50, lien_type: 50,
      first_name: 100, last_name: 100,
      email_1: 255, email_2: 255,
      mailing_address: 255, mailing_city: 100,
      phone_status: 50, phone_type: 50, owner_type: 20,
      list_name: 255, list_type: 100,
      zip_code: 10, mailing_zip: 10,
    };
    const getClip = (row, key) => {
      const v = get(row, key);
      const n = FIELD_LIMITS[key];
      return n && v.length > n ? v.slice(0, n) : v;
    };

    // 2026-04-21 PM hotfix: the old `toNum = v && !isNaN(v) ? parseFloat(v.replace(...)) : null`
    // was BROKEN for any input with a $ or % prefix. isNaN("$189,000") is true,
    // so the function returned null for every currency-formatted value —
    // meaning every PropStream / DealMachine import through the /commit
    // foreground path was silently storing NULL for assessed_value,
    // estimated_value, last_sale_price, and equity_percent. The background
    // /start-job path got this right (stripped before isNaN). Now unified.
    const toNum = (v) => {
      if (!v) return null;
      const s = String(v).replace(/[$,%]/g, '').trim();
      if (!s || isNaN(s)) return null;
      return parseFloat(s);
    };
    const toInt = (v) => {
      if (!v) return null;
      const s = String(v).replace(/[$,%]/g, '').trim();
      if (!s || isNaN(s)) return null;
      return parseInt(s, 10);
    };
    // 2026-04-21 PM hotfix: equity_percent column is NUMERIC(8,2) post-hotfix
    // but even widened, a value like "$403,382" from a PropStream export is
    // obviously wrong — a percent should be in [-100, 100]. Anything outside
    // that range is almost certainly a dollar amount that leaked into the
    // percent column (PropStream column-shift bug), so clamp to NULL rather
    // than storing garbage. Logged for visibility. Applied to equity_percent
    // in both the /commit path and the /start-job background path.
    const toPercent = v => {
      const n = toNum(v);
      if (n == null) return null;
      if (n < -100 || n > 100) {
        console.warn(`[property-import] out-of-range percent value ${JSON.stringify(v)} → NULL`);
        return null;
      }
      return n;
    };
    // 2026-04-21 PM hotfix: bounded-money helper for NUMERIC(12,2) columns.
    // Max absolute value 9,999,999,999.99 (~$10B) — any row exceeding this is
    // garbage (wrong-column, extra-zero typo, scientific notation). Used for
    // assessed_value, estimated_value, last_sale_price, total_tax_owed.
    const MONEY_LIMIT = 9_999_999_999.99;
    const toMoney = v => {
      const n = toNum(v);
      if (n == null) return null;
      if (Math.abs(n) > MONEY_LIMIT) {
        console.warn(`[property-import] out-of-range money value ${JSON.stringify(v)} → NULL`);
        return null;
      }
      return n;
    };
    // Bounded-year helper. Year values MUST be a 4-digit year — PropStream
    // sometimes leaks money values ($57,142) into year columns. Clamp to a
    // wide-but-sane window to catch that.
    const toYear = v => {
      const n = toNum(v);
      if (n == null) return null;
      const y = Math.round(n);
      if (y < 1800 || y > 2200) {
        console.warn(`[property-import] invalid year value ${JSON.stringify(v)} → NULL`);
        return null;
      }
      return y;
    };
    // Bounded smallint helper (-32,768 to 32,767). Clamp to NULL if exceeded
    // — a bedroom count, stories count, or similar should never approach this.
    const toSmallInt = v => {
      const n = toInt(v);
      if (n == null) return null;
      if (n < -32_768 || n > 32_767) {
        console.warn(`[property-import] out-of-range smallint value ${JSON.stringify(v)} → NULL`);
        return null;
      }
      return n;
    };
    // Bounded bathroom helper. NUMERIC(3,1) max 99.9. Cap at 99 to be safe.
    const toBathrooms = v => {
      const n = toNum(v);
      if (n == null) return null;
      if (n < 0 || n > 99) {
        console.warn(`[property-import] out-of-range bathrooms value ${JSON.stringify(v)} → NULL`);
        return null;
      }
      return n;
    };
    const toDate = v => {
      if (!v) return null;
      const d = new Date(v);
      return isNaN(d) ? null : d.toISOString().split('T')[0];
    };
    const toBool = v => { const s = (v||'').toLowerCase(); return s==='yes'||s==='true'||s==='1'||s==='y' ? true : s==='no'||s==='false'||s==='0'||s==='n' ? false : null; };
    const cleanPhone = v => normalizePhone(v);
    // Normalize ZIP to 5-digit only — strips ZIP+4 suffixes ("47303-3111" → "47303")
    // and any whitespace. Prevents duplicates when same property is exported by
    // different providers (PropStream uses 5-digit, REISift uses ZIP+4, etc.).
    //
    // 2026-04-21 PM hotfix: if the value does not start with 5 digits it is
    // almost certainly garbage from a column-shift leak (PropStream sends
    // "is_corporate_owner" in the owner_address_zip column on some rows).
    // Return '' for non-numeric input rather than truncating to a 10-char
    // garbage string — NULLIF then preserves the existing DB value.
    const normalizeZip = v => {
      if (!v) return '';
      const s = String(v).trim();
      const m = s.match(/^\d{5}/);
      return m ? m[0] : '';
    };
    // 2026-04-21 Feature 4 hotfix: phone_type normalizer. PropStream sends
    // "Wireless" / "Landline" but the detail-page chip renderer expects
    // lowercase "mobile" / "landline" / "voip". Without this map, chips do
    // not render on PropStream-sourced data even though phone_type is set.
    const normalizePhoneType = v => {
      const s = String(v || '').toLowerCase().trim();
      if (!s) return 'unknown';
      if (s === 'wireless' || s === 'cell' || s === 'cellular' || s === 'mobile') return 'mobile';
      if (s === 'landline' || s === 'land line' || s === 'fixed' || s === 'residential') return 'landline';
      if (s === 'voip' || s === 'voice over ip') return 'voip';
      return 'unknown';
    };

    // ── Bulk upsert properties ───────────────────────────────────────────────
    // Length caps for short VARCHAR columns. Rows exceeding these limits are
    // SKIPPED (not silently truncated) so the DB stays clean and dirty data
    // surfaces explicitly in the error log.
    const CAP = {
      state_code: 10,  // VARCHAR(10) — normally 2 chars
      zip_code:   10,  // VARCHAR(10) — normally 5 or 5+4
    };
    const validRows = [];
    const skippedReasons = [];  // { street, reason } — logged on response
    for (const row of rows) {
      const street = get(row, 'street');
      const city   = get(row, 'city');
      const state  = normalizeState(get(row,'state_code'), get(row,'zip_code'));
      const zip    = get(row, 'zip_code') || '';
      if (!street || !city || !state) { errors++; continue; }
      // Length guards
      if (state.length > CAP.state_code) {
        errors++;
        skippedReasons.push({ street, reason: `state_code too long (${state.length} chars): "${state}"` });
        continue;
      }
      if (zip.length > CAP.zip_code) {
        errors++;
        skippedReasons.push({ street, reason: `zip_code too long (${zip.length} chars): "${zip}"` });
        continue;
      }
      validRows.push(row);
    }

    if (skippedReasons.length > 0) {
      console.warn(`[property-import] Skipped ${skippedReasons.length} rows due to length violations:`,
        skippedReasons.slice(0, 5));  // log first 5 for visibility
    }

    if (!validRows.length) {
      return res.json({ created, updated, errors, resolvedListId, skipped: skippedReasons, firstError: firstError || null });
    }

    // Dedup within batch — Postgres ON CONFLICT can't process the same key twice
    const seenKeysSync = new Set();
    const dedupedRows = [];
    for (const row of validRows) {
      const key = [
        (get(row,'street')||'').toLowerCase().trim(),
        (get(row,'city')||'').toLowerCase().trim(),
        normalizeState(get(row,'state_code'), get(row,'zip_code')),
        normalizeZip(get(row,'zip_code')),
      ].join('|');
      if (seenKeysSync.has(key)) {
        errors++;
        skippedReasons.push({ street: get(row,'street'), reason: `duplicate (street,city,state,zip) within batch` });
        continue;
      }
      seenKeysSync.add(key);
      dedupedRows.push(row);
    }

    // 2026-04-21 Feature 8(a): import-mode filter (mirrors background worker
    // exactly so both paths behave identically). See background comment for
    // rationale — pre-filter rather than branch the conflict clause.
    let skippedByMode = 0;
    if ((MODE === 'add_only' || MODE === 'update_only') && dedupedRows.length) {
      const tupStreets = dedupedRows.map(r => get(r,'street'));
      const tupCities  = dedupedRows.map(r => get(r,'city'));
      const tupStates  = dedupedRows.map(r => normalizeState(get(r,'state_code'), get(r,'zip_code')));
      const tupZips    = dedupedRows.map(r => normalizeZip(get(r,'zip_code')));
      const existsRes = await query(
        `SELECT DISTINCT
           LOWER(TRIM(street)) || '|' || LOWER(TRIM(city)) || '|' || UPPER(TRIM(state_code)) || '|' || SUBSTRING(TRIM(zip_code) FROM 1 FOR 5) AS k
           FROM properties
          WHERE tenant_id = $5 AND (street, city, state_code, zip_code) IN (
            SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[])
          )`,
        [tupStreets, tupCities, tupStates, tupZips, req.tenantId]
      );
      const existing = new Set(existsRes.rows.map(r => r.k));
      const kept = [];
      for (const row of dedupedRows) {
        const rk = [
          (get(row,'street')||'').toLowerCase().trim(),
          (get(row,'city')||'').toLowerCase().trim(),
          (normalizeState(get(row,'state_code'), get(row,'zip_code'))||'').toUpperCase(),
          (normalizeZip(get(row,'zip_code'))||'').slice(0,5),
        ].join('|');
        const isExisting = existing.has(rk);
        if (MODE === 'add_only'    && !isExisting) kept.push(row);
        else if (MODE === 'update_only' && isExisting) kept.push(row);
        else {
          skippedByMode++;
          skippedReasons.push({ street: get(row,'street'), reason: MODE === 'add_only' ? 'address already exists (add_only mode)' : 'address not in Loki yet (update_only mode)' });
        }
      }
      dedupedRows.length = 0;
      for (const k of kept) dedupedRows.push(k);
      if (skippedByMode > 0) console.log(`[import/commit] mode=${MODE}: skipped ${skippedByMode} row(s)`);
    }

    if (!dedupedRows.length) {
      return res.json({ created, updated, errors, resolvedListId, skipped: skippedReasons, firstError: firstError || null });
    }

    // Build arrays for UNNEST bulk insert
    const streets=[], cities=[], states=[], zips=[], counties=[], mktIds=[], sources=[];
    const propTypes=[], yearBuilts=[], sqfts=[], bedrooms=[], bathrooms=[], lotSizes=[];
    const assessedVals=[], estVals=[], equityPcts=[], propStatuses=[], conditions=[];
    const lastSaleDates=[], lastSalePrices=[], vacants=[];
    // 2026-04-21 Feature 8: Additional Info arrays. 10 columns from Feature 2.
    // Numeric columns use the same bounded helpers as the main batch. String
    // columns pass through as-is (slice to VARCHAR column width happens via
    // DB truncation if user provides oversized strings — prefer explicit nulls).
    const apns=[], stories=[], structureTypes=[], legalDescs=[];
    const totalTaxOwed=[], taxDelinquentYears=[], taxAuctionDates=[];
    const deedTypes=[], lienTypes=[], lienDates=[];

    for (const row of dedupedRows) {
      const state = normalizeState(get(row,'state_code'), get(row,'zip_code'));
      streets.push(getClip(row,'street'));
      cities.push(getClip(row,'city'));
      states.push(state);
      zips.push(normalizeZip(get(row,'zip_code')));
      counties.push(getClip(row,'county')||null);
      mktIds.push(mktMap[state]||null);
      sources.push(getClip(row,'source')||filename||null);
      propTypes.push(getClip(row,'property_type')||null);
      yearBuilts.push(toYear(get(row,'year_built')));
      sqfts.push(toInt(get(row,'sqft')));
      bedrooms.push(toSmallInt(get(row,'bedrooms')));
      bathrooms.push(toBathrooms(get(row,'bathrooms')));
      lotSizes.push(toInt(get(row,'lot_size')));
      assessedVals.push(toMoney(get(row,'assessed_value')));
      estVals.push(toMoney(get(row,'estimated_value')));
      equityPcts.push(toPercent(get(row,'equity_percent')));
      propStatuses.push(getClip(row,'property_status')||null);
      conditions.push(getClip(row,'condition')||null);
      lastSaleDates.push(toDate(get(row,'last_sale_date')));
      lastSalePrices.push(toMoney(get(row,'last_sale_price')));
      vacants.push(toBool(get(row,'vacant')));
      // Additional Info — mirror column types: apn VARCHAR(50), stories SMALLINT,
      // structure_type VARCHAR(50), legal_description TEXT, total_tax_owed
      // NUMERIC(12,2), tax_delinquent_year INTEGER, tax_auction_date DATE,
      // deed_type VARCHAR(50), lien_type VARCHAR(50), lien_date DATE.
      apns.push((get(row,'apn')||'').slice(0, 50) || null);
      stories.push(toSmallInt(get(row,'stories')));
      structureTypes.push((get(row,'structure_type')||'').slice(0, 50) || null);
      legalDescs.push(get(row,'legal_description') || null);  // TEXT — no cap
      totalTaxOwed.push(toMoney(get(row,'total_tax_owed')));
      taxDelinquentYears.push(toYear(get(row,'tax_delinquent_year')));
      taxAuctionDates.push(toDate(get(row,'tax_auction_date')));
      deedTypes.push((get(row,'deed_type')||'').slice(0, 50) || null);
      lienTypes.push((get(row,'lien_type')||'').slice(0, 50) || null);
      lienDates.push(toDate(get(row,'lien_date')));
    }

    const propRes = await query(`
      INSERT INTO properties (
        tenant_id,
        street,city,state_code,zip_code,county,market_id,source,
        property_type,year_built,sqft,bedrooms,bathrooms,lot_size,
        assessed_value,estimated_value,equity_percent,property_status,
        condition,last_sale_date,last_sale_price,vacant,
        apn,stories,structure_type,legal_description,total_tax_owed,
        tax_delinquent_year,tax_auction_date,deed_type,lien_type,lien_date,
        first_seen_at
      )
      SELECT $32, * FROM UNNEST(
        $1::text[],$2::text[],$3::text[],$4::text[],$5::text[],$6::int[],$7::text[],
        $8::text[],$9::int[],$10::int[],$11::int[],$12::numeric[],$13::int[],
        $14::numeric[],$15::numeric[],$16::numeric[],$17::text[],
        $18::text[],$19::date[],$20::numeric[],$21::boolean[],
        $22::text[],$23::int[],$24::text[],$25::text[],$26::numeric[],
        $27::int[],$28::date[],$29::text[],$30::text[],$31::date[]
      ) AS t(street,city,state_code,zip_code,county,market_id,source,
        property_type,year_built,sqft,bedrooms,bathrooms,lot_size,
        assessed_value,estimated_value,equity_percent,property_status,
        condition,last_sale_date,last_sale_price,vacant,
        apn,stories,structure_type,legal_description,total_tax_owed,
        tax_delinquent_year,tax_auction_date,deed_type,lien_type,lien_date),
      (SELECT NOW()) AS s(first_seen_at)
      ON CONFLICT (street,city,state_code,zip_code) DO UPDATE SET
        county          = COALESCE(EXCLUDED.county, properties.county),
        source          = COALESCE(EXCLUDED.source, properties.source),
        property_type   = COALESCE(EXCLUDED.property_type, properties.property_type),
        year_built      = COALESCE(EXCLUDED.year_built, properties.year_built),
        sqft            = COALESCE(EXCLUDED.sqft, properties.sqft),
        bedrooms        = COALESCE(EXCLUDED.bedrooms, properties.bedrooms),
        bathrooms       = COALESCE(EXCLUDED.bathrooms, properties.bathrooms),
        lot_size        = COALESCE(EXCLUDED.lot_size, properties.lot_size),
        assessed_value  = COALESCE(EXCLUDED.assessed_value, properties.assessed_value),
        estimated_value = COALESCE(EXCLUDED.estimated_value, properties.estimated_value),
        equity_percent  = COALESCE(EXCLUDED.equity_percent, properties.equity_percent),
        property_status = COALESCE(EXCLUDED.property_status, properties.property_status),
        condition       = COALESCE(EXCLUDED.condition, properties.condition),
        last_sale_date  = COALESCE(EXCLUDED.last_sale_date, properties.last_sale_date),
        last_sale_price = COALESCE(EXCLUDED.last_sale_price, properties.last_sale_price),
        vacant          = COALESCE(EXCLUDED.vacant, properties.vacant),
        -- 2026-04-21 Feature 8: preserve-blank safe-merge for Additional Info.
        -- Same COALESCE pattern — new values fill empty slots, never overwrite
        -- existing non-null DB values. Matches Feature 8 "safe-merge upsert"
        -- contract that's the primary /commit path behavior.
        apn                  = COALESCE(EXCLUDED.apn,                  properties.apn),
        stories              = COALESCE(EXCLUDED.stories,              properties.stories),
        structure_type       = COALESCE(EXCLUDED.structure_type,       properties.structure_type),
        legal_description    = COALESCE(EXCLUDED.legal_description,    properties.legal_description),
        total_tax_owed       = COALESCE(EXCLUDED.total_tax_owed,       properties.total_tax_owed),
        tax_delinquent_year  = COALESCE(EXCLUDED.tax_delinquent_year,  properties.tax_delinquent_year),
        tax_auction_date     = COALESCE(EXCLUDED.tax_auction_date,     properties.tax_auction_date),
        deed_type            = COALESCE(EXCLUDED.deed_type,            properties.deed_type),
        lien_type            = COALESCE(EXCLUDED.lien_type,            properties.lien_type),
        lien_date            = COALESCE(EXCLUDED.lien_date,            properties.lien_date),
        updated_at      = NOW()
      RETURNING id, xmax, street, city, state_code, zip_code
    `, [streets,cities,states,zips,counties,mktIds,sources,
        propTypes,yearBuilts,sqfts,bedrooms,bathrooms,lotSizes,
        assessedVals,estVals,equityPcts,propStatuses,conditions,
        lastSaleDates,lastSalePrices,vacants,
        apns,stories,structureTypes,legalDescs,totalTaxOwed,
        taxDelinquentYears,taxAuctionDates,deedTypes,lienTypes,lienDates,
        tenantId]);

    // Map address -> property id
    const propMap = {};
    for (const p of propRes.rows) {
      const key = (p.street+'|'+p.city+'|'+p.state_code+'|'+p.zip_code).toLowerCase();
      propMap[key] = { id: p.id, wasInsert: p.xmax === '0' };
      if (p.xmax === '0') created++; else updated++;
    }

    // ── Bulk upsert contacts + phones row by row (contacts need property_id lookup) ──
    for (const row of dedupedRows) {
      try {
        const street = get(row,'street');
        const city   = get(row,'city');
        const state  = normalizeState(get(row,'state_code'), get(row,'zip_code'));
        const zip    = normalizeZip(get(row,'zip_code'));
        const key    = (street+'|'+city+'|'+state+'|'+zip).toLowerCase();
        const prop   = propMap[key];
        if (!prop) continue;
        const propertyId = prop.id;

        const firstName = getClip(row,'first_name');
        const lastName  = get(row,'last_name');
        if (firstName || lastName) {
          // 2026-04-21 Feature 1: infer owner_type from name patterns.
          // Returns 'Person' | 'Company' | 'Trust' | null. Null passes through
          // COALESCE unchanged — we never overwrite a manual classification
          // with a null inference. Existing rows stay as they are if inference
          // returns null (defensive; should rarely happen when firstName||lastName).
          const inferredOT = inferOwnerType(firstName, lastName);
          // 2026-04-21 PM hotfix: normalize mailing_state BEFORE hitting the
          // DB. mailing_state is CHAR(2) — PropStream CSVs occasionally leak
          // non-state values like "Owner Occupied" (14 chars) or "Absentee
          // Owner" into this column (column-shift export bug). normalizeState
          // returns '' for garbage, which NULLIF treats as no-op (preserves
          // existing DB value). Same fix applied at all 4 mailing_state
          // write sites in this file + the bulk-import path.
          const mStateNorm = normalizeState(get(row,'mailing_state'));
          const existPC = await query(`SELECT contact_id FROM property_contacts WHERE property_id=$1 AND tenant_id=$2 AND primary_contact=true LIMIT 1`,[propertyId, tenantId]);
          let contactId;
          if (existPC.rows.length) {
            contactId = existPC.rows[0].contact_id;
            await query(`UPDATE contacts SET
              first_name=COALESCE(NULLIF($1,''),first_name),last_name=COALESCE(NULLIF($2,''),last_name),
              mailing_address=COALESCE(NULLIF($3,''),mailing_address),mailing_city=COALESCE(NULLIF($4,''),mailing_city),
              mailing_state=COALESCE(NULLIF($5,''),mailing_state),mailing_zip=COALESCE(NULLIF($6,''),mailing_zip),
              email_1=COALESCE(NULLIF($7,''),email_1),email_2=COALESCE(NULLIF($8,''),email_2),
              owner_type=COALESCE(owner_type, $10),
              updated_at=NOW()
              WHERE id=$9 AND tenant_id=$11`,
              [firstName,lastName,getClip(row,'mailing_address'),getClip(row,'mailing_city'),
               mStateNorm,normalizeZip(get(row,'mailing_zip')),getClip(row,'email_1')||'',getClip(row,'email_2')||'',contactId,inferredOT,tenantId]);
          } else {
            const cr = await query(`INSERT INTO contacts (tenant_id,first_name,last_name,mailing_address,mailing_city,mailing_state,mailing_zip,email_1,email_2,owner_type)
              VALUES ($1,$2,$3,$4,$5,NULLIF($6,''),NULLIF($7,''),$8,$9,$10) RETURNING id`,
              [tenantId,firstName,lastName,getClip(row,'mailing_address'),getClip(row,'mailing_city'),
               mStateNorm,normalizeZip(get(row,'mailing_zip')),getClip(row,'email_1')||null,getClip(row,'email_2')||null,inferredOT]);
            contactId = cr.rows[0].id;
            await query(`INSERT INTO property_contacts (tenant_id,property_id,contact_id,primary_contact) VALUES ($1,$2,$3,true) ON CONFLICT DO NOTHING`,[tenantId,propertyId,contactId]);
          }

          // Phones
          for (let i=1;i<=10;i++) {
            const phoneRaw = cleanPhone(get(row,`phone_${i}`));
            if (!phoneRaw||phoneRaw.length<7) continue;
            const pType   = normalizePhoneType(get(row,`phone_type_${i}`));
            const pStatus = (get(row,`phone_status_${i}`)||'unknown').toLowerCase().trim();
            await query(`INSERT INTO phones (tenant_id,contact_id,phone_number,phone_index,phone_type,phone_status)
              VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (contact_id,phone_number) DO UPDATE SET
              phone_type=CASE WHEN EXCLUDED.phone_type!='unknown' THEN EXCLUDED.phone_type ELSE phones.phone_type END,
              phone_status=CASE WHEN EXCLUDED.phone_status!='unknown' THEN EXCLUDED.phone_status ELSE phones.phone_status END`,
              [tenantId,contactId,phoneRaw,i,pType,pStatus]);
          }
        }

        // 2026-04-23 Owner 2 — create/update a secondary contact if the CSV
        // has Owner 2 First/Last Name. Uses the same COALESCE-safe-merge
        // pattern as Owner 1 so re-importing doesn't overwrite existing data.
        // Secondary contacts share the same mailing address as Owner 1 since
        // Dealmachine only provides one mailing address per property row.
        const o2First = getClip(row, 'owner_2_first_name');
        const o2Last  = getClip(row, 'owner_2_last_name');
        if (o2First || o2Last) {
          const o2InferredOT = inferOwnerType(o2First, o2Last);
          // Check if a secondary contact with this name already exists for
          // this property — avoid creating duplicates on re-import.
          const existO2 = await query(
            `SELECT c.id FROM contacts c
             JOIN property_contacts pc ON pc.contact_id = c.id AND pc.tenant_id = $4
             WHERE pc.property_id = $1
               AND c.tenant_id = $4
               AND pc.primary_contact = false
               AND LOWER(TRIM(c.first_name)) = LOWER(TRIM($2))
               AND LOWER(TRIM(c.last_name))  = LOWER(TRIM($3))
             LIMIT 1`,
            [propertyId, o2First, o2Last, tenantId]
          );
          if (existO2.rows.length) {
            // Secondary contact already exists — no-op (don't overwrite)
          } else {
            const o2r = await query(
              `INSERT INTO contacts (tenant_id, first_name, last_name, owner_type)
               VALUES ($1, $2, $3, $4) RETURNING id`,
              [tenantId, o2First, o2Last, o2InferredOT]
            );
            const o2Id = o2r.rows[0].id;
            await query(
              `INSERT INTO property_contacts (tenant_id, property_id, contact_id, primary_contact)
               VALUES ($1, $2, $3, false) ON CONFLICT DO NOTHING`,
              [tenantId, propertyId, o2Id]
            );
          }
        }

        // Tag to list
        if (resolvedListId) {
          await query(`INSERT INTO property_lists (tenant_id,property_id,list_id,added_at) VALUES ($1,$2,$3,NOW()) ON CONFLICT DO NOTHING`,
            [tenantId,propertyId,resolvedListId]);
        }
      } catch(rowErr) {
        errors++;
        if (errors<=3) console.error('Row error:',rowErr.message);
        if (errors===1) firstError = rowErr.message;
      }
    }

    // 2026-04-20 pass 12: refresh owner_portfolio_counts MV after the final
    // batch. Pre-pass-12 the /commit path never refreshed — only bulk-import's
    // background worker and merge_all did — so imports via the row-by-row
    // non-background path left the owned-count aggregation stale until the
    // next bulk op. The UI invokes /commit in fixed-size slices with an
    // explicit offset; the last batch is the one whose offset+batchSize
    // reaches or exceeds allRows.length.
    const isLastBatch = (offset || 0) + rows.length >= allRows.length;
    if (isLastBatch) {
      try {
        const t = Date.now();
        await refreshOwnerPortfolioMv();
        console.log(`[import/commit] refreshed owner_portfolio_counts MV (${Date.now() - t}ms)`);
      } catch (e) {
        console.error('[import/commit] MV refresh failed (non-fatal):', e.message);
      }
    }

    res.json({ created, updated, errors, skipped: skippedReasons, firstError: firstError || null, resolvedListId });
  } catch(e) {
    console.error('Import commit error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── BACKGROUND JOB: Start import as background job ───────────────────────────
router.post('/start-job', requireAuth, async (req, res) => {
  try {
    const { mapping, filename, listName, listId, listType, listSource } = req.body;
    if (!mapping) return res.status(400).json({ error: 'Missing mapping.' });

    // 2026-04-21 Feature 8(a): whitelist the 3 valid import modes. Anything
    // else (including undefined) falls back to the safe default. Server-side
    // whitelist is the source of truth — the client radio is UX only.
    const VALID_IMPORT_MODES = ['add_and_update', 'add_only', 'update_only'];
    const importMode = VALID_IMPORT_MODES.includes(req.body.importMode) ? req.body.importMode : 'add_and_update';

    const allRows = req.session.importRows;
    if (!allRows || !allRows.length) return res.status(400).json({ error: 'Session expired. Please re-upload your file.' });

    const tenantId = req.tenantId;

    // Resolve or create list first
    let resolvedListId = null;
    if (listName && listName.trim()) {
      const upserted = await query(
        `INSERT INTO lists (tenant_id, list_name, list_type, source, upload_date, active)
         VALUES ($1, $2, $3, $4, NOW(), true)
         ON CONFLICT (list_name) DO UPDATE SET list_name = EXCLUDED.list_name
         RETURNING id`,
        [tenantId, listName.trim(), listType || null, listSource || null]
      );
      resolvedListId = upserted.rows[0].id;
    } else if (listId) {
      resolvedListId = parseInt(listId);
    }

    // Create job record. tenant_id is persisted on the row so the
    // background worker can pick it up without needing a session.
    const jobRes = await query(
      `INSERT INTO bulk_import_jobs (tenant_id, status, filename, list_id, total_rows) VALUES ($1,'pending',$2,$3,$4) RETURNING id`,
      [tenantId, filename || 'import.csv', resolvedListId, allRows.length]
    );
    const jobId = jobRes.rows[0].id;

    // Copy rows out of session for background use (session may expire)
    const rows = [...allRows];
    req.session.importRows = null;
    req.session.save();

    // Fire background processing
    setImmediate(() => runBackgroundImport(jobId, rows, mapping, filename, resolvedListId, listType, listSource, importMode, tenantId));

    res.json({ jobId, resolvedListId, total: allRows.length });
  } catch(e) {
    console.error('Start job error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── BACKGROUND IMPORT WORKER ──────────────────────────────────────────────────
async function runBackgroundImport(jobId, allRows, mapping, filename, resolvedListId, listTypeIgnored, listSourceIgnored, importMode, tenantId) {
  // 2026-04-21 Feature 8(a): importMode is one of 'add_and_update' (default),
  // 'add_only', 'update_only' — branches the property UPSERT behavior below.
  // Validated against a whitelist in the caller before we get here; guard
  // here too in case of future call sites.
  const MODE = (['add_and_update','add_only','update_only'].includes(importMode)) ? importMode : 'add_and_update';
  // Phase 1 SaaS: tenantId comes from the caller (which read it from the
  // session). If it's missing we re-fetch from the job row as a fallback —
  // bulk_import_jobs.tenant_id is the canonical source of truth.
  if (!Number.isInteger(tenantId)) {
    const tr = await query(`SELECT tenant_id FROM bulk_import_jobs WHERE id = $1`, [jobId]);
    if (!tr.rows.length) {
      console.error(`[bg-import] job ${jobId} not found — aborting`);
      return;
    }
    tenantId = tr.rows[0].tenant_id;
  }
  const BATCH = 500;
  let inserted = 0, updated = 0, errors = 0, processed = 0;
  const allSkipped = [];  // hoisted so the catch block can reference it
  let totalDuplicatesMerged = 0;  // 2026-04-20: tracked separately from allSkipped — these rows aren't dropped, they're merged into the keeper

  try {
    await query(`UPDATE bulk_import_jobs SET status='running', updated_at=NOW() WHERE id=$1`, [jobId]);

    // Ensure markets exist for this tenant (same Phase 2 caveat as /commit)
    await query(`INSERT INTO markets (tenant_id,name,state_code,state_name) VALUES
      ($1,'AL','AL','Alabama'),($1,'AK','AK','Alaska'),($1,'AZ','AZ','Arizona'),($1,'AR','AR','Arkansas'),($1,'CA','CA','California'),
      ($1,'CO','CO','Colorado'),($1,'CT','CT','Connecticut'),($1,'DE','DE','Delaware'),($1,'FL','FL','Florida'),($1,'GA','GA','Georgia'),
      ($1,'HI','HI','Hawaii'),($1,'ID','ID','Idaho'),($1,'IL','IL','Illinois'),($1,'IN','IN','Indiana'),($1,'IA','IA','Iowa'),
      ($1,'KS','KS','Kansas'),($1,'KY','KY','Kentucky'),($1,'LA','LA','Louisiana'),($1,'ME','ME','Maine'),($1,'MD','MD','Maryland'),
      ($1,'MA','MA','Massachusetts'),($1,'MI','MI','Michigan'),($1,'MN','MN','Minnesota'),($1,'MS','MS','Mississippi'),($1,'MO','MO','Missouri'),
      ($1,'MT','MT','Montana'),($1,'NE','NE','Nebraska'),($1,'NV','NV','Nevada'),($1,'NH','NH','New Hampshire'),($1,'NJ','NJ','New Jersey'),
      ($1,'NM','NM','New Mexico'),($1,'NY','NY','New York'),($1,'NC','NC','North Carolina'),($1,'ND','ND','North Dakota'),($1,'OH','OH','Ohio'),
      ($1,'OK','OK','Oklahoma'),($1,'OR','OR','Oregon'),($1,'PA','PA','Pennsylvania'),($1,'RI','RI','Rhode Island'),($1,'SC','SC','South Carolina'),
      ($1,'SD','SD','South Dakota'),($1,'TN','TN','Tennessee'),($1,'TX','TX','Texas'),($1,'UT','UT','Utah'),($1,'VT','VT','Vermont'),
      ($1,'VA','VA','Virginia'),($1,'WA','WA','Washington'),($1,'WV','WV','West Virginia'),($1,'WI','WI','Wisconsin'),($1,'WY','WY','Wyoming')
      ON CONFLICT (state_code) DO UPDATE SET name=EXCLUDED.name, state_name=EXCLUDED.state_name`, [tenantId]);
    const mktRes = await query(`SELECT id, state_code FROM markets WHERE tenant_id = $1`, [tenantId]);
    const mktMap = {};
    mktRes.rows.forEach(m => { mktMap[m.state_code] = m.id; });

    const get = (row, key) => { const col = mapping[key]; return col ? (row[col] || '').toString().trim() : ''; };
    // 2026-04-21 Crash prevention: same as /commit — clip values to their
    // schema VARCHAR limit before INSERT. See FIELD_LIMITS comment in the
    // /commit handler for rationale.
    const FIELD_LIMITS = {
      street: 255, city: 100, county: 100, property_type: 50, source: 100,
      condition: 50, property_status: 50, structure_type: 50, apn: 50,
      deed_type: 50, lien_type: 50,
      first_name: 100, last_name: 100,
      email_1: 255, email_2: 255,
      mailing_address: 255, mailing_city: 100,
      phone_status: 50, phone_type: 50, owner_type: 20,
      list_name: 255, list_type: 100,
      zip_code: 10, mailing_zip: 10,
    };
    const getClip = (row, key) => {
      const v = get(row, key);
      const n = FIELD_LIMITS[key];
      return n && v.length > n ? v.slice(0, n) : v;
    };
    const toNum = v => v && !isNaN(String(v).replace(/[$,%]/g,'')) ? parseFloat(String(v).replace(/[$,%]/g,'')) : null;
    const toInt = v => v && !isNaN(v) ? parseInt(v) : null;
    // 2026-04-21 PM hotfix: clamp percent values to [-100, 100]. See the
    // /commit path's toPercent for full rationale — PropStream column-shift
    // bug puts dollar amounts into the equity_percent column on some rows.
    const toPercent = v => {
      const n = toNum(v);
      if (n == null) return null;
      if (n < -100 || n > 100) {
        console.warn(`[start-job] out-of-range percent value ${JSON.stringify(v)} → NULL`);
        return null;
      }
      return n;
    };
    // 2026-04-21 PM hotfix: bounded-money/year/smallint/bathrooms helpers.
    // All clamp out-of-range values to NULL and log. Keeps this background
    // path in lockstep with /commit's safety. See /commit toMoney/toYear/
    // toSmallInt/toBathrooms for full rationale.
    const MONEY_LIMIT = 9_999_999_999.99;
    const toMoney = v => {
      const n = toNum(v);
      if (n == null) return null;
      if (Math.abs(n) > MONEY_LIMIT) {
        console.warn(`[start-job] out-of-range money value ${JSON.stringify(v)} → NULL`);
        return null;
      }
      return n;
    };
    const toYear = v => {
      const n = toNum(v);
      if (n == null) return null;
      const y = Math.round(n);
      if (y < 1800 || y > 2200) {
        console.warn(`[start-job] invalid year value ${JSON.stringify(v)} → NULL`);
        return null;
      }
      return y;
    };
    const toSmallInt = v => {
      const n = toInt(v);
      if (n == null) return null;
      if (n < -32_768 || n > 32_767) {
        console.warn(`[start-job] out-of-range smallint value ${JSON.stringify(v)} → NULL`);
        return null;
      }
      return n;
    };
    const toBathrooms = v => {
      const n = toNum(v);
      if (n == null) return null;
      if (n < 0 || n > 99) {
        console.warn(`[start-job] out-of-range bathrooms value ${JSON.stringify(v)} → NULL`);
        return null;
      }
      return n;
    };
    const toDate = v => { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString().split('T')[0]; };
    const toBool = v => { const s=(v||'').toLowerCase(); return s==='yes'||s==='true'||s==='1'||s==='y'?true:s==='no'||s==='false'||s==='0'||s==='n'?false:null; };
    const cleanPhone = v => normalizePhone(v);
    // Normalize ZIP to 5-digit only — strips ZIP+4 suffixes ("47303-3111" → "47303")
    // and any whitespace. Prevents duplicates when same property is exported by
    // different providers (PropStream uses 5-digit, REISift uses ZIP+4, etc.).
    //
    // 2026-04-21 PM hotfix: mirror the /commit path — reject non-numeric
    // input rather than truncating to garbage. PropStream leaks non-ZIP
    // values like "is_corporate_owner" into owner_address_zip on some rows.
    const normalizeZip = v => {
      if (!v) return '';
      const s = String(v).trim();
      const m = s.match(/^\d{5}/);
      return m ? m[0] : '';
    };
    // 2026-04-21 Feature 4 hotfix: phone_type normalizer. Maps PropStream's
    // "Wireless" / "Landline" to the lowercase "mobile" / "landline" / "voip"
    // values that the detail-page chip renderer recognizes. Unknown/empty
    // inputs return 'unknown' so they match the DB column default.
    const normalizePhoneType = v => {
      const s = String(v || '').toLowerCase().trim();
      if (!s) return 'unknown';
      if (s === 'wireless' || s === 'cell' || s === 'cellular' || s === 'mobile') return 'mobile';
      if (s === 'landline' || s === 'land line' || s === 'fixed' || s === 'residential') return 'landline';
      if (s === 'voip' || s === 'voice over ip') return 'voip';
      return 'unknown';
    };
    // normalizeState used here is the module-level wrapper at the top of
    // this file; delegates to the shared helper in ./state.js. The local
    // copies (STATE_ABBR, VALID_STATES, and the slice(0,2) fallback) used
    // to live inline here — deleted in the 2026-04-17 audit because they
    // drifted from the shared source of truth.
    // Length caps for short VARCHAR columns — skip rows exceeding these
    const CAP = { state_code: 10, zip_code: 10 };
    // Normalize state: full name → abbreviation
    for (let offset = 0; offset < allRows.length; offset += BATCH) {
      const rows = allRows.slice(offset, offset + BATCH);
      // 2026-04-21 Crash prevention: wrap the entire batch in try/catch so a
      // single bad batch (unexpected NULL in required column, FK violation
      // from a deleted market, Postgres numeric overflow) doesn't abort the
      // whole import job. Without this, one bad row poisons the remaining
      // rows by throwing out of the for-loop. With it, the bad batch is
      // logged and skipped; the next batch continues fresh.
      //
      // This is a safety net, not a transaction — individual queries inside
      // the batch that succeeded before the throw stay committed. The clip
      // helper above removes the most common trigger (oversize VARCHAR), so
      // this catch should rarely fire in practice. When it does, the log
      // tells us what new failure mode to address.
      try {
      const validRows = [];
      for (const row of rows) {
        const street = get(row,'street');
        const city   = get(row,'city');
        const state  = get(row,'state_code');
        if (!street || !city || !state) { errors++; continue; }
        const stateNorm = normalizeState(state);
        const zip = normalizeZip(get(row,'zip_code'));
        if (stateNorm.length > CAP.state_code) {
          errors++;
          allSkipped.push(`Row skipped — state_code too long: "${stateNorm}" (street: ${street})`);
          continue;
        }
        if (zip.length > CAP.zip_code) {
          errors++;
          allSkipped.push(`Row skipped — zip_code too long: "${zip}" (street: ${street})`);
          continue;
        }
        validRows.push(row);
      }

      // ──────────────────────────────────────────────────────────────────
      // Dedup within this batch — Postgres ON CONFLICT can't act on the
      // same unique-key row twice in one INSERT statement.
      //
      // 2026-04-20 UX fix + multi-owner support:
      // When two rows share an address:
      //   • SAME person (identical normalized name, OR one side blank):
      //     merge backfill-only into the keeper (keeper wins non-empty).
      //   • DIFFERENT person (both have a non-empty name and they differ):
      //     the duplicate is a CO-OWNER. Stash it on the keeper's
      //     __secondaryOwners[] so the contact-insertion phase below
      //     creates a second contacts row linked with primary_contact=false.
      //     Phones/emails on the co-owner row attach to THAT contact, not
      //     the primary — important for accurate outbound call attribution.
      //
      // Strict equality rule: trim + collapse whitespace + lowercase,
      // then compare byte-for-byte. No fuzzy matching. "John" vs "Jon",
      // "John" vs "John Jr", "J Doe" vs "John Doe" all count as distinct
      // people to avoid false-negative merges that permanently erase a
      // real owner. Users can still manually merge via the existing
      // /records/_duplicates UI if they later determine two contacts
      // are actually the same person.
      // ──────────────────────────────────────────────────────────────────
      const seenKeys = new Map();  // key → index into dedupedRows
      const dedupedRows = [];
      let duplicatesMergedCount = 0;
      let secondaryOwnersCount = 0;

      // Normalize a person's full name for equality comparison.
      const normName = (row) => {
        const fn = (get(row,'first_name') || '').trim().toLowerCase().replace(/\s+/g, ' ');
        const ln = (get(row,'last_name')  || '').trim().toLowerCase().replace(/\s+/g, ' ');
        return { fn, ln, full: (fn + '|' + ln).trim() };
      };

      for (const row of validRows) {
        const key = [
          (get(row,'street')||'').toLowerCase().trim(),
          (get(row,'city')||'').toLowerCase().trim(),
          normalizeState(get(row,'state_code'), get(row,'zip_code')),
          normalizeZip(get(row,'zip_code')),
        ].join('|');
        if (seenKeys.has(key)) {
          const keeperIdx = seenKeys.get(key);
          const keeper = dedupedRows[keeperIdx];
          const keeperName = normName(keeper);
          const dupName = normName(row);

          // Decide: merge into keeper, or treat as co-owner?
          //
          // Merge ("same person"):
          //   - keeper name and dup name normalize to the same string, OR
          //   - one side is missing (no first AND no last) — treat the
          //     named side as the identity and take the other row as
          //     supplemental data.
          //
          // Co-owner ("different person"):
          //   - both sides have non-empty names AND they differ after
          //     normalization.
          const bothNamed = keeperName.full !== '|' && dupName.full !== '|';
          const sameNormalizedName = keeperName.full === dupName.full;
          const isSamePerson = sameNormalizedName || !bothNamed;

          if (isSamePerson) {
            // MERGE into keeper — backfill blank fields only.
            const mergeKey = (k) => {
              const col = mapping[k];
              if (!col) return;
              const keeperVal = (keeper[col] == null ? '' : String(keeper[col])).trim();
              if (keeperVal !== '') return;  // keeper wins when non-empty
              const dupVal = (row[col] == null ? '' : String(row[col])).trim();
              if (dupVal !== '') keeper[col] = row[col];
            };
            ['first_name', 'last_name',
             'mailing_address', 'mailing_city', 'mailing_state', 'mailing_zip',
             'email_1', 'email_2'
            ].forEach(mergeKey);
            for (let i = 1; i <= 10; i++) {
              mergeKey(`phone_${i}`);
              mergeKey(`phone_type_${i}`);
              mergeKey(`phone_status_${i}`);
            }
            duplicatesMergedCount++;
          } else {
            // CO-OWNER — stash the whole row on the keeper for the
            // insertion phase to process. We attach an underscore-prefixed
            // property directly on the source CSV row object (ugly but
            // pragmatic — doesn't require a parallel data structure and
            // the keeper stays a plain row for the existing code paths).
            // Also dedup co-owners by normalized name so repeated
            // appearances of the same secondary owner don't spawn
            // multiple contacts.
            if (!keeper.__secondaryOwners) keeper.__secondaryOwners = [];
            const seenCoNames = new Set();
            // Seed the set with names already stashed
            for (const s of keeper.__secondaryOwners) {
              seenCoNames.add(normName(s).full);
            }
            if (!seenCoNames.has(dupName.full)) {
              keeper.__secondaryOwners.push(row);
              secondaryOwnersCount++;
            } else {
              // Same co-owner name reappearing — merge into that stashed row
              const existing = keeper.__secondaryOwners.find(s => normName(s).full === dupName.full);
              if (existing) {
                const mergeKey = (k) => {
                  const col = mapping[k];
                  if (!col) return;
                  const exVal = (existing[col] == null ? '' : String(existing[col])).trim();
                  if (exVal !== '') return;
                  const dupVal = (row[col] == null ? '' : String(row[col])).trim();
                  if (dupVal !== '') existing[col] = row[col];
                };
                ['mailing_address','mailing_city','mailing_state','mailing_zip','email_1','email_2'].forEach(mergeKey);
                for (let i = 1; i <= 10; i++) {
                  mergeKey(`phone_${i}`); mergeKey(`phone_type_${i}`); mergeKey(`phone_status_${i}`);
                }
                duplicatesMergedCount++;
              }
            }
          }
          continue;
        }
        seenKeys.set(key, dedupedRows.length);
        dedupedRows.push(row);
      }

      if (duplicatesMergedCount > 0 || secondaryOwnersCount > 0) {
        console.log(`[property-import] batch: merged ${duplicatesMergedCount} same-person dup(s), flagged ${secondaryOwnersCount} co-owner row(s) for secondary contact insertion`);
        totalDuplicatesMerged += duplicatesMergedCount;
      }

      // 2026-04-21 Feature 8(a): import mode filter.
      //   add_only    → drop rows whose address ALREADY exists in Loki
      //   update_only → drop rows whose address does NOT yet exist
      //   add_and_update (default) → no filter, UPSERT handles both paths
      // Single pre-query against the batch's address tuples produces the set
      // of existing keys; we keep or drop against it based on MODE. Using a
      // pre-filter rather than branching the ON CONFLICT clause keeps the
      // downstream propMap/contact/phone linking code intact — every row
      // that reaches the INSERT is guaranteed to produce a matching RETURNING.
      let skippedByMode = 0;
      let skippedByModeReason = '';
      if ((MODE === 'add_only' || MODE === 'update_only') && dedupedRows.length) {
        const tupStreets = dedupedRows.map(r => get(r,'street'));
        const tupCities  = dedupedRows.map(r => get(r,'city'));
        const tupStates  = dedupedRows.map(r => normalizeState(get(r,'state_code'), get(r,'zip_code')));
        const tupZips    = dedupedRows.map(r => normalizeZip(get(r,'zip_code')));
        const existsRes = await query(
          `SELECT DISTINCT
             LOWER(TRIM(street)) || '|' || LOWER(TRIM(city)) || '|' || UPPER(TRIM(state_code)) || '|' || SUBSTRING(TRIM(zip_code) FROM 1 FOR 5) AS k
             FROM properties
            WHERE tenant_id = $5 AND (street, city, state_code, zip_code) IN (
              SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[])
            )`,
          [tupStreets, tupCities, tupStates, tupZips, tenantId]
        );
        const existing = new Set(existsRes.rows.map(r => r.k));
        const kept = [];
        for (const row of dedupedRows) {
          const rk = [
            (get(row,'street')||'').toLowerCase().trim(),
            (get(row,'city')||'').toLowerCase().trim(),
            (normalizeState(get(row,'state_code'), get(row,'zip_code'))||'').toUpperCase(),
            (normalizeZip(get(row,'zip_code'))||'').slice(0,5),
          ].join('|');
          const isExisting = existing.has(rk);
          if (MODE === 'add_only'    && !isExisting) kept.push(row);
          else if (MODE === 'update_only' && isExisting) kept.push(row);
          else skippedByMode++;
        }
        skippedByModeReason = MODE === 'add_only'
          ? `mode=add_only: skipped ${skippedByMode} row(s) whose address already exists`
          : `mode=update_only: skipped ${skippedByMode} row(s) whose address doesn't exist in Loki yet`;
        // Mutate dedupedRows in place — seenKeys map is not used after this point.
        dedupedRows.length = 0;
        for (const k of kept) dedupedRows.push(k);
        if (skippedByMode > 0) console.log(`[property-import] ${skippedByModeReason}`);
      }

      if (dedupedRows.length) {
        // Bulk upsert properties (using deduped batch)
        const streets=[],cities=[],states=[],zips=[],counties=[],mktIds=[],sources=[];
        const propTypes=[],yearBuilts=[],sqfts=[],beds=[],baths=[],lots=[];
        const assessed=[],estVals=[],equity=[],propStatus=[],conds=[];
        const lastSaleDates=[],lastSalePrices=[],vacants=[];
        // 2026-04-21 Feature 8: Additional Info arrays for background path.
        // Mirrors the /commit foreground path 1:1 so both code paths accept
        // the same CSV columns and produce the same DB writes.
        const apns=[], storiesArr=[], structureTypes=[], legalDescs=[];
        const totalTaxOwed=[], taxDelinquentYears=[], taxAuctionDates=[];
        const deedTypes=[], lienTypes=[], lienDates=[];

        for (const row of dedupedRows) {
          const state = normalizeState(get(row,'state_code'), get(row,'zip_code'));
          streets.push(getClip(row,'street')); cities.push(getClip(row,'city')); states.push(state);
          zips.push(normalizeZip(get(row,'zip_code'))); counties.push(getClip(row,'county')||null);
          mktIds.push(mktMap[state]||null); sources.push(getClip(row,'source')||filename||null);
          propTypes.push(getClip(row,'property_type')||null); yearBuilts.push(toYear(get(row,'year_built')));
          sqfts.push(toInt(get(row,'sqft'))); beds.push(toSmallInt(get(row,'bedrooms')));
          baths.push(toBathrooms(get(row,'bathrooms'))); lots.push(toInt(get(row,'lot_size')));
          assessed.push(toMoney(get(row,'assessed_value'))); estVals.push(toMoney(get(row,'estimated_value')));
          equity.push(toPercent(get(row,'equity_percent'))); propStatus.push(getClip(row,'property_status')||null);
          conds.push(getClip(row,'condition')||null); lastSaleDates.push(toDate(get(row,'last_sale_date')));
          lastSalePrices.push(toMoney(get(row,'last_sale_price'))); vacants.push(toBool(get(row,'vacant')));
          // Feature 8 additions
          apns.push((get(row,'apn')||'').slice(0, 50) || null);
          storiesArr.push(toSmallInt(get(row,'stories')));
          structureTypes.push((get(row,'structure_type')||'').slice(0, 50) || null);
          legalDescs.push(get(row,'legal_description') || null);
          totalTaxOwed.push(toMoney(get(row,'total_tax_owed')));
          taxDelinquentYears.push(toYear(get(row,'tax_delinquent_year')));
          taxAuctionDates.push(toDate(get(row,'tax_auction_date')));
          deedTypes.push((get(row,'deed_type')||'').slice(0, 50) || null);
          lienTypes.push((get(row,'lien_type')||'').slice(0, 50) || null);
          lienDates.push(toDate(get(row,'lien_date')));
        }

        const propRes = await query(`
          INSERT INTO properties (tenant_id,street,city,state_code,zip_code,county,market_id,source,property_type,year_built,sqft,bedrooms,bathrooms,lot_size,assessed_value,estimated_value,equity_percent,property_status,condition,last_sale_date,last_sale_price,vacant,apn,stories,structure_type,legal_description,total_tax_owed,tax_delinquent_year,tax_auction_date,deed_type,lien_type,lien_date,first_seen_at)
          SELECT $32,*,NOW() FROM UNNEST($1::text[],$2::text[],$3::text[],$4::text[],$5::text[],$6::int[],$7::text[],$8::text[],$9::int[],$10::int[],$11::int[],$12::numeric[],$13::int[],$14::numeric[],$15::numeric[],$16::numeric[],$17::text[],$18::text[],$19::date[],$20::numeric[],$21::boolean[],$22::text[],$23::int[],$24::text[],$25::text[],$26::numeric[],$27::int[],$28::date[],$29::text[],$30::text[],$31::date[])
          AS t(street,city,state_code,zip_code,county,market_id,source,property_type,year_built,sqft,bedrooms,bathrooms,lot_size,assessed_value,estimated_value,equity_percent,property_status,condition,last_sale_date,last_sale_price,vacant,apn,stories,structure_type,legal_description,total_tax_owed,tax_delinquent_year,tax_auction_date,deed_type,lien_type,lien_date)
          ON CONFLICT (street,city,state_code,zip_code) DO UPDATE SET
            county=COALESCE(EXCLUDED.county,properties.county),source=COALESCE(EXCLUDED.source,properties.source),
            property_type=COALESCE(EXCLUDED.property_type,properties.property_type),year_built=COALESCE(EXCLUDED.year_built,properties.year_built),
            sqft=COALESCE(EXCLUDED.sqft,properties.sqft),bedrooms=COALESCE(EXCLUDED.bedrooms,properties.bedrooms),
            bathrooms=COALESCE(EXCLUDED.bathrooms,properties.bathrooms),lot_size=COALESCE(EXCLUDED.lot_size,properties.lot_size),
            assessed_value=COALESCE(EXCLUDED.assessed_value,properties.assessed_value),estimated_value=COALESCE(EXCLUDED.estimated_value,properties.estimated_value),
            equity_percent=COALESCE(EXCLUDED.equity_percent,properties.equity_percent),property_status=COALESCE(EXCLUDED.property_status,properties.property_status),
            condition=COALESCE(EXCLUDED.condition,properties.condition),last_sale_date=COALESCE(EXCLUDED.last_sale_date,properties.last_sale_date),
            last_sale_price=COALESCE(EXCLUDED.last_sale_price,properties.last_sale_price),vacant=COALESCE(EXCLUDED.vacant,properties.vacant),
            apn=COALESCE(EXCLUDED.apn,properties.apn),stories=COALESCE(EXCLUDED.stories,properties.stories),
            structure_type=COALESCE(EXCLUDED.structure_type,properties.structure_type),legal_description=COALESCE(EXCLUDED.legal_description,properties.legal_description),
            total_tax_owed=COALESCE(EXCLUDED.total_tax_owed,properties.total_tax_owed),tax_delinquent_year=COALESCE(EXCLUDED.tax_delinquent_year,properties.tax_delinquent_year),
            tax_auction_date=COALESCE(EXCLUDED.tax_auction_date,properties.tax_auction_date),deed_type=COALESCE(EXCLUDED.deed_type,properties.deed_type),
            lien_type=COALESCE(EXCLUDED.lien_type,properties.lien_type),lien_date=COALESCE(EXCLUDED.lien_date,properties.lien_date),
            updated_at=NOW()
          RETURNING id, xmax, street, city, state_code, zip_code
        `, [streets,cities,states,zips,counties,mktIds,sources,propTypes,yearBuilts,sqfts,beds,baths,lots,assessed,estVals,equity,propStatus,conds,lastSaleDates,lastSalePrices,vacants,apns,storiesArr,structureTypes,legalDescs,totalTaxOwed,taxDelinquentYears,taxAuctionDates,deedTypes,lienTypes,lienDates,tenantId]);

        const propMap = {};
        const propIds = [];
        for (const p of propRes.rows) {
          propMap[(p.street+'|'+p.city+'|'+p.state_code+'|'+p.zip_code).toLowerCase()] = { id: p.id, wasInsert: p.xmax==='0' };
          propIds.push(p.id);
          if (p.xmax==='0') inserted++; else updated++;
        }

        // ─────────────────────────────────────────────────────────────────
        // Contacts + phones + list-links — UNNEST rewrite (2026-04-17 gap 4)
        //
        // Was: per-row loop issuing 12+ queries per property (500 rows/batch
        // × 12 = 6000 queries per batch). Now: 5 bulk queries per batch, same
        // semantics. A 50k-row import drops from ~3-4 min to ~10-15 s.
        // ─────────────────────────────────────────────────────────────────

        // Build row → property_id lookup keyed by the same composite we used
        // for dedup. We'll walk dedupedRows and assemble per-phase arrays.
        //
        // 2026-04-21 critical bug fix: propMap keys are built with a single
        // .toLowerCase() on the whole concatenated string (line 1541), so
        // state_code="IN" lands in the key as "in". But rowKey() only
        // lowercased street and city — state (via normalizeState, always
        // uppercase) and zip stayed as-is. Result: lookup key
        // "...|clayton|IN|46118" never matched propMap key
        // "...|clayton|in|46118", every property row fell through the
        // `if (!prop) continue` gate below, and NO CONTACTS were created
        // for any background (`/start-job`) import. The foreground
        // (`/commit`) path at line 1170 was unaffected because its rowKey
        // equivalent lowercases the entire concatenation. This caused
        // every DealMachine/large-file upload to produce properties with
        // no linked primary contact. Wrapping the whole expression in
        // .toLowerCase() matches the propMap format.
        const rowKey = (r) => (
          get(r,'street') + '|' +
          get(r,'city') + '|' +
          normalizeState(get(r,'state_code'), get(r,'zip_code')) + '|' +
          normalizeZip(get(r,'zip_code'))
        ).toLowerCase();

        // Collect rows that have owner data, keyed by property_id
        const rowByPropId = new Map();    // propId → row
        for (const row of dedupedRows) {
          const prop = propMap[rowKey(row)];
          if (!prop) continue;
          const fn = get(row,'first_name'), ln = get(row,'last_name');
          // 2026-04-20 bug #1 fix: don't skip rows whose keeper has no name
          // if they have co-owners stashed. Pre-fix, `if (!fn && !ln) continue`
          // dropped the keeper from rowByPropId entirely, and the co-owner
          // processing phase below (which iterates rowByPropId) never saw
          // the __secondaryOwners. Co-owners on blank-keeper parcels were
          // silently lost. Now: include the row so co-owners get processed;
          // the primary-contact arrays still skip blank-name rows via a
          // separate gate below.
          const hasCoOwners = Array.isArray(row.__secondaryOwners) && row.__secondaryOwners.length > 0;
          if (!fn && !ln && !hasCoOwners) continue;
          // If multiple rows landed on the same property_id (same address),
          // last-row-wins — matches old per-row loop behavior.
          rowByPropId.set(prop.id, row);
        }

        // Pre-load existing primary contacts for this batch's properties
        const batchPropIds = Array.from(rowByPropId.keys());
        const existingPC = new Map();
        if (batchPropIds.length > 0) {
          const ex = await query(
            `SELECT property_id, contact_id FROM property_contacts
              WHERE tenant_id = $2 AND property_id = ANY($1::int[]) AND primary_contact = true`,
            [batchPropIds, tenantId]
          );
          for (const r of ex.rows) existingPC.set(r.property_id, r.contact_id);
        }

        // ──────────────────────────────────────────────────────────────────
        // 2026-04-20 audit fix #6: phone-based contact reuse.
        //
        // Before this block: every new (property_id, has-no-primary-contact
        // yet) row would create a FRESH contacts row, even when the same
        // phone number already belongs to a contact in another property.
        // Result: John Smith who owns 5 properties had 5 contact rows, each
        // with (possibly the same) phone — making outbound calls look like
        // 5 separate people to every downstream system.
        //
        // Now: we scan every phone in the batch, ask the global phones table
        // "who already owns this?", and for any property whose row has at
        // least one already-owned phone, we reuse that contact instead of
        // creating a new one. Falls through to new-contact creation only for
        // genuinely new owners.
        // ──────────────────────────────────────────────────────────────────
        const phoneToExistingContact = new Map();   // phone_number → contact_id
        {
          const batchPhones = new Set();
          for (const [propId, row] of rowByPropId) {
            if (!existingPC.has(propId)) {
              // Primary row phones — only scanned if no primary exists yet
              // (if one exists, primary path won't create/reuse a contact).
              for (let i = 1; i <= 10; i++) {
                const p = cleanPhone(get(row, `phone_${i}`));
                if (p && p.length >= 7) batchPhones.add(p);
              }
            }
            // 2026-04-20 bug #2 fix: also scan co-owner phones. Previously
            // only primary row phones were queried, so the phone-reuse path
            // for co-owners (coReuseTasks) was dead code — the Map never
            // contained co-owner numbers for it to match. Unlike primary,
            // we always scan co-owner phones regardless of existingPC
            // because co-owners exist *alongside* the primary, not instead
            // of it.
            if (Array.isArray(row.__secondaryOwners)) {
              for (const coRow of row.__secondaryOwners) {
                for (let i = 1; i <= 10; i++) {
                  const p = cleanPhone(get(coRow, `phone_${i}`));
                  if (p && p.length >= 7) batchPhones.add(p);
                }
              }
            }
          }
          if (batchPhones.size > 0) {
            const phoneArr = Array.from(batchPhones);
            // Prefer oldest contact per phone (stable, deterministic)
            const phRes = await query(
              `SELECT DISTINCT ON (phone_number) phone_number, contact_id
                 FROM phones
                WHERE tenant_id = $2 AND phone_number = ANY($1::text[])
                ORDER BY phone_number, contact_id ASC`,
              [phoneArr, tenantId]
            );
            for (const r of phRes.rows) phoneToExistingContact.set(r.phone_number, r.contact_id);
          }
        }

        // Split into update-existing vs insert-new
        const updIds=[], updFns=[], updLns=[], updMaddr=[], updMcity=[], updMstate=[], updMzip=[], updE1=[], updE2=[];
        const newPropIds=[], newFns=[], newLns=[], newMaddr=[], newMcity=[], newMstate=[], newMzip=[], newE1=[], newE2=[];
        // 2026-04-21 Feature 1: parallel owner_type arrays. inferOwnerType()
        // returns 'Person' | 'Company' | 'Trust' | null. Null flows through
        // COALESCE unchanged so we never clobber a manual classification.
        const updOt=[], newOt=[];
        const contactIdByProp = new Map();
        let reusedContactCount = 0;

        for (const [propId, row] of rowByPropId) {
          // 2026-04-20 bug #1 fix: skip blank-name rows from primary-contact
          // processing. They only exist in rowByPropId so the co-owner phase
          // can find their __secondaryOwners — no primary contact should be
          // created/updated from a row without a name.
          const rowFn = get(row,'first_name'), rowLn = get(row,'last_name');
          if (!rowFn && !rowLn) continue;
          // Compute once per row and reuse across all three push branches below.
          const rowOwnerType = inferOwnerType(rowFn, rowLn);
          // 2026-04-21 PM hotfix: normalize mailing_state before pushing into
          // the UNNEST array. CHAR(2) will refuse values like "Owner Occupied"
          // (PropStream column-shift leak). normalizeState returns '' for
          // garbage, which the bulk UPDATE/INSERT's NULLIF then treats as
          // no-op (preserves existing DB value or leaves NULL respectively).
          const rowMailingState = normalizeState(get(row,'mailing_state'));
          // Same treatment for mailing_zip — VARCHAR(10), PropStream leaks
          // "is_corporate_owner" (18 chars) into owner_address_zip on some rows.
          const rowMailingZip = normalizeZip(get(row,'mailing_zip'));

          if (existingPC.has(propId)) {
            const cid = existingPC.get(propId);
            contactIdByProp.set(propId, cid);
            updIds.push(cid);
            updFns.push(getClip(row,'first_name') || '');
            updLns.push(getClip(row,'last_name') || '');
            updMaddr.push(getClip(row,'mailing_address') || '');
            updMcity.push(getClip(row,'mailing_city') || '');
            updMstate.push(rowMailingState);
            updMzip.push(rowMailingZip);
            updE1.push(getClip(row,'email_1') || '');
            updE2.push(getClip(row,'email_2') || '');
            updOt.push(rowOwnerType);  // null → COALESCE preserves existing
            continue;
          }

          // No primary yet — check if any phone on this row already belongs
          // to an existing contact (fix #6). First match wins.
          let reusedCid = null;
          for (let i = 1; i <= 10; i++) {
            const p = cleanPhone(get(row, `phone_${i}`));
            if (p && p.length >= 7 && phoneToExistingContact.has(p)) {
              reusedCid = phoneToExistingContact.get(p);
              break;
            }
          }

          if (reusedCid) {
            // Reuse the existing contact. Link it to this property as primary
            // (via property_contacts) and UPDATE the contact with any new
            // owner fields from this row (COALESCE preserves prior non-empty).
            contactIdByProp.set(propId, reusedCid);
            updIds.push(reusedCid);
            updFns.push(getClip(row,'first_name') || '');
            updLns.push(getClip(row,'last_name') || '');
            updMaddr.push(getClip(row,'mailing_address') || '');
            updMcity.push(getClip(row,'mailing_city') || '');
            updMstate.push(rowMailingState);
            updMzip.push(rowMailingZip);
            updE1.push(getClip(row,'email_1') || '');
            updE2.push(getClip(row,'email_2') || '');
            updOt.push(rowOwnerType);
            // Create the primary property_contacts link — safe via ON CONFLICT
            // on (property_id, contact_id).
            await query(
              `INSERT INTO property_contacts (tenant_id, property_id, contact_id, primary_contact)
               VALUES ($1, $2, $3, true)
               ON CONFLICT (property_id, contact_id) DO UPDATE SET primary_contact = true`,
              [tenantId, propId, reusedCid]
            );
            reusedContactCount++;
          } else {
            newPropIds.push(propId);
            newFns.push(getClip(row,'first_name') || '');
            newLns.push(getClip(row,'last_name') || '');
            newMaddr.push(getClip(row,'mailing_address') || '');
            newMcity.push(getClip(row,'mailing_city') || '');
            newMstate.push(rowMailingState);
            newMzip.push(rowMailingZip);
            newE1.push(getClip(row,'email_1') || null);
            newE2.push(getClip(row,'email_2') || null);
            newOt.push(rowOwnerType);
          }
        }

        if (reusedContactCount > 0) {
          console.log(`[property-import] reused ${reusedContactCount} existing contact(s) via phone-match (fix #6)`);
        }

        // Bulk UPDATE existing contacts (COALESCE preserves prior non-empty values)
        if (updIds.length > 0) {
          await query(`
            UPDATE contacts SET
              first_name      = COALESCE(NULLIF(t.first_name,''),      contacts.first_name),
              last_name       = COALESCE(NULLIF(t.last_name,''),       contacts.last_name),
              mailing_address = COALESCE(NULLIF(t.mailing_address,''), contacts.mailing_address),
              mailing_city    = COALESCE(NULLIF(t.mailing_city,''),    contacts.mailing_city),
              mailing_state   = COALESCE(NULLIF(t.mailing_state,''),   contacts.mailing_state),
              mailing_zip     = COALESCE(NULLIF(t.mailing_zip,''),     contacts.mailing_zip),
              email_1         = COALESCE(NULLIF(t.email_1,''),         contacts.email_1),
              email_2         = COALESCE(NULLIF(t.email_2,''),         contacts.email_2),
              -- 2026-04-21 Feature 1: owner_type. t.owner_type arrives as a
              -- VARCHAR (nulls preserved in the ::varchar[] cast), not a text
              -- literal — so COALESCE preserves existing classification unless
              -- the row had a non-null inference. No NULLIF needed here.
              owner_type      = COALESCE(contacts.owner_type, t.owner_type),
              updated_at      = NOW()
            FROM UNNEST(
              $1::int[], $2::text[], $3::text[], $4::text[], $5::text[],
              $6::text[], $7::text[], $8::text[], $9::text[], $10::varchar[]
            ) AS t(id, first_name, last_name, mailing_address, mailing_city,
                   mailing_state, mailing_zip, email_1, email_2, owner_type)
            WHERE contacts.id = t.id AND contacts.tenant_id = $11
          `, [updIds, updFns, updLns, updMaddr, updMcity, updMstate, updMzip, updE1, updE2, updOt, tenantId]);
        }

        // Bulk INSERT new contacts + property_contacts links
        //
        // 2026-04-21 audit fix: Postgres does NOT guarantee that
        // INSERT ... RETURNING emits rows in the same order as the input
        // UNNEST. The old `newIds[i]` paired with `newPropIds[i]` could
        // silently cross-contaminate contacts to the wrong properties
        // under any reordering (Samuel's name on Matt's property). Even
        // matching-back via field equality is unsafe because two input
        // rows can have identical fields (e.g., both blank, or same
        // name + mailing). Fix: pre-allocate contact IDs from the
        // sequence, then INSERT with explicit id values. IDs are known
        // before the INSERT runs, zero ordering assumption, zero match
        // ambiguity.
        if (newPropIds.length > 0) {
          const idRes = await query(
            `SELECT nextval(pg_get_serial_sequence('contacts', 'id')) AS id
               FROM generate_series(1, $1)`,
            [newPropIds.length]
          );
          const newIds = idRes.rows.map(r => Number(r.id));
          await query(`
            INSERT INTO contacts (id, tenant_id, first_name, last_name, mailing_address, mailing_city, mailing_state, mailing_zip, email_1, email_2, owner_type)
            SELECT id, $11, first_name, last_name, mailing_address, mailing_city, mailing_state, mailing_zip, email_1, email_2, owner_type FROM UNNEST(
              $1::int[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::varchar[]
            ) AS t(id, first_name, last_name, mailing_address, mailing_city, mailing_state, mailing_zip, email_1, email_2, owner_type)
          `, [newIds, newFns, newLns, newMaddr, newMcity, newMstate, newMzip, newE1, newE2, newOt, tenantId]);
          await query(`
            INSERT INTO property_contacts (tenant_id, property_id, contact_id, primary_contact)
            SELECT $3, property_id, contact_id, true
              FROM UNNEST($1::int[], $2::int[]) AS t(property_id, contact_id)
            ON CONFLICT DO NOTHING
          `, [newPropIds, newIds, tenantId]);
          for (let i = 0; i < newPropIds.length; i++) contactIdByProp.set(newPropIds[i], newIds[i]);
        }

        // Bulk UPSERT phones — walk every row × 10 slots, emit one array.
        //
        // 2026-04-20 pass 11: Dedup by (contact_id, phone_number) before the
        // UNNEST — without it, a single property row with the same phone
        // number in multiple slot columns OR two properties in the batch
        // that share a contact via property_contacts would both emit the
        // same (cid, phone) key, tripping PG 21000 and killing the import.
        // First occurrence wins (lowest slot = canonical); an informative
        // phone_status from a later duplicate is preserved over 'unknown'.
        const phoneBucket = new Map();   // key = `${cid}|${phone}`
        let phoneDupesCollapsed = 0;
        for (const [propId, row] of rowByPropId) {
          const cid = contactIdByProp.get(propId);
          if (!cid) continue;
          for (let i = 1; i <= 10; i++) {
            const phoneRaw = cleanPhone(get(row, `phone_${i}`));
            if (!phoneRaw || phoneRaw.length < 7) continue;
            // 2026-04-21 Feature 4 hotfix: normalize PropStream "Wireless"/
            // "Landline" to lowercase "mobile"/"landline" so chip renders.
            const pType   = normalizePhoneType(get(row, `phone_type_${i}`));
            const pStatus = (get(row, `phone_status_${i}`) || 'unknown').toLowerCase().trim();
            const key = `${cid}|${phoneRaw}`;
            const existing = phoneBucket.get(key);
            if (existing) {
              phoneDupesCollapsed++;
              // Upgrade to informative status/type if existing was blank
              const existingInformative = existing.status !== 'unknown';
              const incomingInformative = pStatus !== 'unknown';
              if (!existingInformative && incomingInformative) {
                existing.status = pStatus;
              }
              const existingInformativeType = existing.type !== 'unknown';
              const incomingInformativeType = pType !== 'unknown';
              if (!existingInformativeType && incomingInformativeType) {
                existing.type = pType;
              }
              continue;
            }
            phoneBucket.set(key, { cid, phone: phoneRaw, idx: i, type: pType, status: pStatus });
          }
        }

        const phCids=[], phNums=[], phIdxs=[], phTypes=[], phStats=[];
        for (const p of phoneBucket.values()) {
          phCids.push(p.cid);
          phNums.push(p.phone);
          phIdxs.push(p.idx);
          phTypes.push(p.type);
          phStats.push(p.status);
        }
        if (phCids.length > 0) {
          await query(`
            INSERT INTO phones (tenant_id, contact_id, phone_number, phone_index, phone_type, phone_status)
            SELECT $6, contact_id, phone_number, phone_index, phone_type, phone_status FROM UNNEST($1::int[], $2::text[], $3::int[], $4::text[], $5::text[])
              AS t(contact_id, phone_number, phone_index, phone_type, phone_status)
            ON CONFLICT (contact_id, phone_number) DO UPDATE SET
              phone_type   = CASE WHEN EXCLUDED.phone_type   != 'unknown' THEN EXCLUDED.phone_type   ELSE phones.phone_type   END,
              phone_status = CASE WHEN EXCLUDED.phone_status != 'unknown' THEN EXCLUDED.phone_status ELSE phones.phone_status END,
              updated_at   = NOW()
          `, [phCids, phNums, phIdxs, phTypes, phStats, tenantId]);
        }

        if (phoneDupesCollapsed > 0) {
          console.log(`[property-import] collapsed ${phoneDupesCollapsed} duplicate phone entries in batch`);
        }

        // ──────────────────────────────────────────────────────────────────
        // 2026-04-20 multi-owner support: insert co-owners from
        // __secondaryOwners[] as additional contacts linked with
        // primary_contact=false. Each secondary owner gets their own
        // contacts row; their phones/emails attach to that contact,
        // never to the primary. Respects the phone-reuse path so a
        // co-owner whose phone already matches a global contact reuses
        // that contact.
        //
        // 2026-04-20 re-import support: before creating a new co-owner,
        // check if a co-owner with the same normalized name is ALREADY
        // linked to this property (from a prior import of the same CSV
        // or a different list with overlapping contacts). If yes, reuse
        // that existing contact, backfill blank name/address/email
        // fields only, and let the phones UPSERT path add any new phone
        // numbers as additional rows. Old phones stay — history is
        // preserved, no overwrites.
        // ──────────────────────────────────────────────────────────────────
        // Flatten __secondaryOwners into per-owner tasks
        const coOwnerTasks = [];  // {propId, row}
        for (const [propId, row] of rowByPropId) {
          if (!row.__secondaryOwners) continue;
          for (const coRow of row.__secondaryOwners) {
            coOwnerTasks.push({ propId, row: coRow });
          }
        }

        if (coOwnerTasks.length > 0) {
          // Pre-load all existing NON-primary contacts attached to the
          // batch's properties, keyed by (property_id, normalized_name).
          // One query regardless of batch size.
          const coExistingByKey = new Map();  // `${propId}|${fn}|${ln}` → contact_id
          const normNameStr = (fn, ln) => (
            (fn || '').trim().toLowerCase().replace(/\s+/g, ' ') + '|' +
            (ln || '').trim().toLowerCase().replace(/\s+/g, ' ')
          );
          const coPropIds = Array.from(new Set(coOwnerTasks.map(t => t.propId)));
          if (coPropIds.length > 0) {
            const coExRes = await query(
              `SELECT pc.property_id, pc.contact_id, c.first_name, c.last_name
                 FROM property_contacts pc
                 JOIN contacts c ON c.id = pc.contact_id AND c.tenant_id = $2
                WHERE pc.tenant_id = $2
                  AND pc.property_id = ANY($1::int[])
                  AND pc.primary_contact = false`,
              [coPropIds, tenantId]
            );
            for (const r of coExRes.rows) {
              const nkey = normNameStr(r.first_name, r.last_name);
              if (nkey === '|') continue;  // skip blank-name existing rows
              coExistingByKey.set(`${r.property_id}|${nkey}`, r.contact_id);
            }
          }

          // Three buckets:
          //   coUpdateTasks — co-owner already exists on this property, reuse existing contact,
          //                   backfill blanks only (never overwrite), phones will add via UPSERT
          //   coReuseTasks  — phone matches a global contact elsewhere, reuse that contact,
          //                   link it to THIS property with primary_contact=false
          //   coNewTasks    — genuinely new co-owner, create contact from scratch
          const coUpdateTasks = [];  // {propId, contactId, row}
          const coReuseTasks  = [];  // {propId, contactId, row}
          const coNewTasks    = [];  // {propId, row}

          for (const t of coOwnerTasks) {
            const fn = get(t.row, 'first_name');
            const ln = get(t.row, 'last_name');
            const nkey = normNameStr(fn, ln);

            // Check existing co-owner on this property by name first
            const existingCid = (nkey !== '|') ? coExistingByKey.get(`${t.propId}|${nkey}`) : undefined;
            if (existingCid) {
              coUpdateTasks.push({ propId: t.propId, contactId: existingCid, row: t.row });
              continue;
            }

            // Fall back to phone-reuse (same logic as primary)
            let reusedCid = null;
            for (let i = 1; i <= 10; i++) {
              const p = cleanPhone(get(t.row, `phone_${i}`));
              if (p && p.length >= 7 && phoneToExistingContact.has(p)) {
                reusedCid = phoneToExistingContact.get(p);
                break;
              }
            }
            if (reusedCid) {
              coReuseTasks.push({ propId: t.propId, contactId: reusedCid, row: t.row });
            } else {
              coNewTasks.push({ propId: t.propId, row: t.row });
            }
          }

          // Backfill-only UPDATE for existing co-owners already on this property.
          // COALESCE(NULLIF(new,''), existing) preserves prior non-empty values —
          // new skip-trace data that fills in blanks is applied; anything already
          // populated is NOT overwritten. Phones are handled by the bulk UPSERT
          // below (add new phone_number rows, keep existing ones).
          if (coUpdateTasks.length > 0) {
            await query(`
              UPDATE contacts SET
                first_name      = COALESCE(NULLIF(t.first_name,''),      contacts.first_name),
                last_name       = COALESCE(NULLIF(t.last_name,''),       contacts.last_name),
                mailing_address = COALESCE(NULLIF(t.mailing_address,''), contacts.mailing_address),
                mailing_city    = COALESCE(NULLIF(t.mailing_city,''),    contacts.mailing_city),
                mailing_state   = COALESCE(NULLIF(t.mailing_state,''),   contacts.mailing_state),
                mailing_zip     = COALESCE(NULLIF(t.mailing_zip,''),     contacts.mailing_zip),
                email_1         = COALESCE(NULLIF(t.email_1,''),         contacts.email_1),
                email_2         = COALESCE(NULLIF(t.email_2,''),         contacts.email_2),
                updated_at      = NOW()
              FROM UNNEST(
                $1::int[], $2::text[], $3::text[], $4::text[], $5::text[],
                $6::text[], $7::text[], $8::text[], $9::text[]
              ) AS t(id, first_name, last_name, mailing_address, mailing_city,
                     mailing_state, mailing_zip, email_1, email_2)
              WHERE contacts.id = t.id AND contacts.tenant_id = $10
            `, [
              coUpdateTasks.map(t => t.contactId),
              coUpdateTasks.map(t => get(t.row,'first_name') || ''),
              coUpdateTasks.map(t => get(t.row,'last_name')  || ''),
              coUpdateTasks.map(t => get(t.row,'mailing_address') || ''),
              coUpdateTasks.map(t => get(t.row,'mailing_city')    || ''),
              coUpdateTasks.map(t => normalizeState(get(t.row,'mailing_state'))),
              coUpdateTasks.map(t => normalizeZip(get(t.row,'mailing_zip'))),
              coUpdateTasks.map(t => get(t.row,'email_1') || ''),
              coUpdateTasks.map(t => get(t.row,'email_2') || ''),
              tenantId,
            ]);
          }

          // Link reused contacts with primary_contact=false
          if (coReuseTasks.length > 0) {
            await query(`
              INSERT INTO property_contacts (tenant_id, property_id, contact_id, primary_contact)
              SELECT $3, t.property_id, t.contact_id, false
                FROM UNNEST($1::int[], $2::int[]) AS t(property_id, contact_id)
              ON CONFLICT (property_id, contact_id) DO NOTHING
            `, [
              coReuseTasks.map(t => t.propId),
              coReuseTasks.map(t => t.contactId),
              tenantId,
            ]);
          }

          // Create new co-owner contacts + link with primary_contact=false
          //
          // 2026-04-21 audit fix: pre-allocate IDs so the coContactIds[i] ↔
          // coNewTasks[i] pairing is bulletproof. Same RETURNING-ordering
          // hazard as the primary path — see comment there. The downstream
          // phone-attach block (allCoTasks map) relies on this pairing, so
          // any mismatch would attach phones to the wrong co-owner.
          const coContactIds = [];  // parallel to coNewTasks
          if (coNewTasks.length > 0) {
            const coIdRes = await query(
              `SELECT nextval(pg_get_serial_sequence('contacts', 'id')) AS id
                 FROM generate_series(1, $1)`,
              [coNewTasks.length]
            );
            for (const r of coIdRes.rows) coContactIds.push(Number(r.id));
            await query(`
              INSERT INTO contacts (id, tenant_id, first_name, last_name, mailing_address, mailing_city, mailing_state, mailing_zip, email_1, email_2)
              SELECT id, $10, first_name, last_name, mailing_address, mailing_city, mailing_state, mailing_zip, email_1, email_2 FROM UNNEST(
                $1::int[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[]
              ) AS t(id, first_name, last_name, mailing_address, mailing_city, mailing_state, mailing_zip, email_1, email_2)
            `, [
              coContactIds,
              coNewTasks.map(t => get(t.row,'first_name') || ''),
              coNewTasks.map(t => get(t.row,'last_name')  || ''),
              coNewTasks.map(t => get(t.row,'mailing_address') || ''),
              coNewTasks.map(t => get(t.row,'mailing_city')    || ''),
              coNewTasks.map(t => normalizeState(get(t.row,'mailing_state'))),
              coNewTasks.map(t => normalizeZip(get(t.row,'mailing_zip'))),
              coNewTasks.map(t => get(t.row,'email_1') || null),
              coNewTasks.map(t => get(t.row,'email_2') || null),
              tenantId,
            ]);

            await query(`
              INSERT INTO property_contacts (tenant_id, property_id, contact_id, primary_contact)
              SELECT $3, t.property_id, t.contact_id, false
                FROM UNNEST($1::int[], $2::int[]) AS t(property_id, contact_id)
              ON CONFLICT (property_id, contact_id) DO NOTHING
            `, [
              coNewTasks.map(t => t.propId),
              coContactIds,
              tenantId,
            ]);
          }

          // Attach phones for all co-owner tasks (update + reuse + new).
          // Existing phones stay (ON CONFLICT on (contact_id, phone_number)
          // only updates status/type, never deletes). New phones from a
          // skip-trace re-import land as additional phone rows under the
          // same contact_id — history preserved.
          const coPhoneBucket = new Map();
          const allCoTasks = [
            ...coUpdateTasks.map(t => ({ cid: t.contactId, row: t.row })),
            ...coReuseTasks.map(t  => ({ cid: t.contactId, row: t.row })),
            ...coNewTasks.map((t, i) => ({ cid: coContactIds[i], row: t.row })),
          ];
          for (const t of allCoTasks) {
            if (!t.cid) continue;
            for (let i = 1; i <= 10; i++) {
              const phoneRaw = cleanPhone(get(t.row, `phone_${i}`));
              if (!phoneRaw || phoneRaw.length < 7) continue;
              // 2026-04-21 Feature 4 hotfix: normalize for chip-render match.
              const pType   = normalizePhoneType(get(t.row, `phone_type_${i}`));
              const pStatus = (get(t.row, `phone_status_${i}`) || 'unknown').toLowerCase().trim();
              const key = `${t.cid}|${phoneRaw}`;
              if (coPhoneBucket.has(key)) continue;  // first occurrence wins within batch
              coPhoneBucket.set(key, { cid: t.cid, phone: phoneRaw, idx: i, type: pType, status: pStatus });
            }
          }

          if (coPhoneBucket.size > 0) {
            const cCids=[], cNums=[], cIdxs=[], cTypes=[], cStats=[];
            for (const p of coPhoneBucket.values()) {
              cCids.push(p.cid); cNums.push(p.phone); cIdxs.push(p.idx);
              cTypes.push(p.type); cStats.push(p.status);
            }
            await query(`
              INSERT INTO phones (tenant_id, contact_id, phone_number, phone_index, phone_type, phone_status)
              SELECT $6, contact_id, phone_number, phone_index, phone_type, phone_status FROM UNNEST($1::int[], $2::text[], $3::int[], $4::text[], $5::text[])
                AS t(contact_id, phone_number, phone_index, phone_type, phone_status)
              ON CONFLICT (contact_id, phone_number) DO UPDATE SET
                phone_type   = CASE WHEN EXCLUDED.phone_type   != 'unknown' THEN EXCLUDED.phone_type   ELSE phones.phone_type   END,
                phone_status = CASE WHEN EXCLUDED.phone_status != 'unknown' THEN EXCLUDED.phone_status ELSE phones.phone_status END,
                updated_at   = NOW()
            `, [cCids, cNums, cIdxs, cTypes, cStats, tenantId]);
          }

          console.log(`[property-import] attached ${coOwnerTasks.length} co-owner(s): ${coUpdateTasks.length} existing (updated), ${coReuseTasks.length} reused, ${coNewTasks.length} new`);
        }

        // 2026-04-23 Owner 2 — BULK pattern (rewritten after N+1 disaster).
        //
        // Previous implementation did SELECT + INSERT + INSERT per row, which
        // produced ~1500 round-trips per 500-row batch. A 19k-row import
        // hung for hours. This version does 3 queries per batch total:
        //   1. Bulk SELECT existing Owner 2 contacts on these properties
        //      (one query returns the set of (property_id, normalized name)
        //      pairs that already exist — we filter in JS)
        //   2. Bulk reserve contact IDs via generate_series (one query)
        //   3. Bulk INSERT new contacts via UNNEST (one query)
        //   4. Bulk INSERT property_contacts links via UNNEST (one query)
        //
        // This mirrors the proven pattern used for primary contacts + co-owners
        // above. Safe to re-run — dedup against existing Owner 2s by
        // (property_id, LOWER(TRIM(first_name)), LOWER(TRIM(last_name))).

        // Step 1: Collect Owner 2 candidates from this batch's rows
        const o2Candidates = [];  // { propId, firstName, lastName, normKey }
        for (const row of dedupedRows) {
          const o2First = getClip(row, 'owner_2_first_name');
          const o2Last  = getClip(row, 'owner_2_last_name');
          if (!o2First && !o2Last) continue;
          const prop = propMap[rowKey(row)];
          if (!prop) continue;
          const normKey = prop.id + '|' +
            (o2First||'').toLowerCase().trim() + '|' +
            (o2Last ||'').toLowerCase().trim();
          o2Candidates.push({
            propId: prop.id,
            firstName: o2First,
            lastName: o2Last,
            normKey,
          });
        }

        if (o2Candidates.length > 0) {
          // 2026-04-23 intra-batch dedup: if the CSV has the same (property_id,
          // owner2_name) tuple twice in this batch (e.g. duplicate rows that
          // both made it through earlier dedup), we must only insert once.
          // Without this, the bulk INSERT below would create two contact rows,
          // then the property_contacts link would ON CONFLICT DO NOTHING the
          // second — leaving one orphaned contact per duplicate.
          const seenKeys = new Set();
          const uniqCandidates = [];
          for (const c of o2Candidates) {
            if (seenKeys.has(c.normKey)) continue;
            seenKeys.add(c.normKey);
            uniqCandidates.push(c);
          }

          // Step 2: One SELECT to find which candidates already have a
          // secondary contact with that name on that property.
          const existRes = await query(
            `SELECT pc.property_id,
                    LOWER(TRIM(c.first_name)) AS fn,
                    LOWER(TRIM(c.last_name))  AS ln
               FROM property_contacts pc
               JOIN contacts c ON c.id = pc.contact_id AND c.tenant_id = $2
              WHERE pc.tenant_id = $2
                AND pc.property_id = ANY($1::int[])
                AND pc.primary_contact = false`,
            [uniqCandidates.map(c => c.propId), tenantId]
          );
          const existingSet = new Set();
          for (const r of existRes.rows) {
            existingSet.add(r.property_id + '|' + (r.fn||'') + '|' + (r.ln||''));
          }

          // Filter to genuinely new ones
          const newOnes = uniqCandidates.filter(c => !existingSet.has(c.normKey));

          if (newOnes.length > 0) {
            // Step 3: Reserve contact IDs in bulk
            const idRes = await query(
              `SELECT nextval(pg_get_serial_sequence('contacts', 'id')) AS id
                 FROM generate_series(1, $1)`,
              [newOnes.length]
            );
            const newIds = idRes.rows.map(r => Number(r.id));

            // Step 4: Bulk INSERT contacts via UNNEST
            await query(
              `INSERT INTO contacts (id, tenant_id, first_name, last_name, owner_type)
               SELECT id, $5, first_name, last_name, owner_type FROM UNNEST($1::int[], $2::text[], $3::text[], $4::text[])
                 AS t(id, first_name, last_name, owner_type)`,
              [
                newIds,
                newOnes.map(c => c.firstName),
                newOnes.map(c => c.lastName),
                newOnes.map(c => inferOwnerType(c.firstName, c.lastName)),
                tenantId,
              ]
            );

            // Step 5: Bulk INSERT property_contacts links via UNNEST
            await query(
              `INSERT INTO property_contacts (tenant_id, property_id, contact_id, primary_contact)
               SELECT $3, property_id, contact_id, false
                 FROM UNNEST($1::int[], $2::int[]) AS t(property_id, contact_id)
               ON CONFLICT (property_id, contact_id) DO NOTHING`,
              [
                newOnes.map(c => c.propId),
                newIds,
                tenantId,
              ]
            );

            console.log(`[property-import] batch: inserted ${newOnes.length} Owner 2 contact(s)`);
          }
        }

        // Bulk INSERT property_lists links for every property in the batch
        if (resolvedListId && propIds.length > 0) {
          await query(`
            INSERT INTO property_lists (tenant_id, property_id, list_id, added_at)
            SELECT $3, property_id, $2, NOW()
              FROM UNNEST($1::int[]) AS t(property_id)
            ON CONFLICT DO NOTHING
          `, [propIds, resolvedListId, tenantId]);
        }
      }

      processed += rows.length;
      await query(`UPDATE bulk_import_jobs SET processed_rows=$1,inserted=$2,updated=$3,errors=$4,updated_at=NOW() WHERE id=$5`,
        [processed, inserted, updated, errors, jobId]);
      } catch (batchErr) {
        // One batch exploded — log, count, keep going. The next batch starts
        // fresh with its own array builders, so this failure is contained.
        console.error(`[property-import] job ${jobId} batch at offset ${offset} failed:`, batchErr.message);
        allSkipped.push(`Batch at row ${offset + 1}-${offset + rows.length} failed: ${batchErr.message}`);
        errors += rows.length;  // conservative — count every row in the failed batch as errored
        processed += rows.length;
        await query(`UPDATE bulk_import_jobs SET processed_rows=$1,inserted=$2,updated=$3,errors=$4,updated_at=NOW() WHERE id=$5`,
          [processed, inserted, updated, errors, jobId]).catch(() => {});
      }
    }

    // ────────────────────────────────────────────────────────────────────────
    // Write skip/merge summary to error_log even on successful completion.
    //
    // 2026-04-20 UX fix: the old header hardcoded "skipped due to oversize
    // fields" for every allSkipped entry, even when most or all of them were
    // duplicates (which go to allSkipped under the previous behavior — now
    // they're merged instead and don't hit this array at all). Now: classify
    // by prefix and produce a breakdown that matches the actual cause.
    // totalDuplicatesMerged is reported separately since those rows weren't
    // dropped — they contributed data to the keeper.
    // ────────────────────────────────────────────────────────────────────────
    let oversizeState = 0, oversizeZip = 0, otherSkip = 0;
    for (const line of allSkipped) {
      if (line.startsWith('Row skipped — state_code')) oversizeState++;
      else if (line.startsWith('Row skipped — zip_code')) oversizeZip++;
      else otherSkip++;
    }
    const summaryParts = [];
    if (oversizeState > 0) summaryParts.push(`${oversizeState} row(s) skipped — state_code too long`);
    if (oversizeZip > 0)   summaryParts.push(`${oversizeZip} row(s) skipped — zip_code too long`);
    if (otherSkip > 0)     summaryParts.push(`${otherSkip} row(s) skipped (other)`);
    if (totalDuplicatesMerged > 0) summaryParts.push(`${totalDuplicatesMerged} duplicate row(s) merged into existing records (contact data preserved)`);

    let skipSummary = null;
    if (summaryParts.length > 0) {
      skipSummary = summaryParts.join(' · ');
      if (allSkipped.length > 0) {
        skipSummary += '\n\nDetails:\n' + allSkipped.slice(0, 20).join('\n')
          + (allSkipped.length > 20 ? `\n…(${allSkipped.length - 20} more)` : '');
      }
    }

    await query(`UPDATE bulk_import_jobs SET status='complete',processed_rows=$1,inserted=$2,updated=$3,errors=$4,error_log=$5,updated_at=NOW() WHERE id=$6`,
      [allRows.length, inserted, updated, errors, skipSummary, jobId]);

    if (allSkipped.length > 0 || totalDuplicatesMerged > 0) {
      console.warn(`[bulk-import] job ${jobId} — ${allSkipped.length} rows skipped, ${totalDuplicatesMerged} duplicates merged`);
    }

    // 2026-04-18 audit fix #35: refresh owner_portfolio_counts MV after every
    // import. The MV powers the Min/Max Owned filter (fix #8). Previously it
    // was created once at boot and never refreshed, so the owned-count filter
    // returned increasingly stale numbers as new properties arrived.
    // Non-fatal — log on failure but don't fail the import.
    try {
      const t = Date.now();
      await refreshOwnerPortfolioMv();
      console.log(`[bulk-import] refreshed owner_portfolio_counts MV (${Date.now() - t}ms)`);
    } catch (e) {
      console.error(`[bulk-import] MV refresh failed (non-fatal):`, e.message);
    }

  } catch(e) {
    console.error('Background import error:', e.message);
    // Preserve skipped-rows + duplicate-merge context when we crash
    const parts = [`CRASH: ${e.message}`];
    if (allSkipped && allSkipped.length > 0) {
      parts.push(`Before crash, ${allSkipped.length} row(s) had been skipped due to oversize state_code/zip_code fields.`);
    }
    if (typeof totalDuplicatesMerged !== 'undefined' && totalDuplicatesMerged > 0) {
      parts.push(`${totalDuplicatesMerged} duplicate row(s) had been merged into keeper rows before the crash.`);
    }
    const combined = parts.join('\n\n');
    await query(`UPDATE bulk_import_jobs SET status='error',error_log=$1,updated_at=NOW() WHERE id=$2`, [combined, jobId]);
  }
}

module.exports = router;
