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

// Wrapper: callers rely on string truthiness (empty string = skip). The
// shared helper returns null for garbage — we normalize that to '' here
// so existing `if (!state)` branches behave the same. Uppercase valid codes
// pass through untouched. This replaces the three older in-file copies that
// used raw .slice(0,2) fallback (which poisoned the markets table with "46"
// from ZIP codes that landed in the State column). (Audit #3.)
function normalizeState(v) {
  return sharedNormalizeState(v) || '';
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
  if (req.session && req.session.authenticated) return next();
  res.redirect('/login');
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
 */
async function ensureMappingSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS mapping_templates (
      id SERIAL PRIMARY KEY,
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
 * Looks up a saved mapping by fingerprint. Bumps use_count + last_used_at if
 * found (so we can see which templates are hot). Returns null if no match.
 */
async function lookupMappingByFingerprint(fingerprint) {
  if (!fingerprint) return null;
  await ensureMappingSchema();
  const r = await query(
    `SELECT id, fingerprint, name, headers, mapping, use_count, created_at, last_used_at
       FROM mapping_templates WHERE fingerprint = $1 LIMIT 1`,
    [fingerprint]
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
async function upsertMapping(fingerprint, columns, mapping) {
  if (!fingerprint) return null;
  await ensureMappingSchema();
  const name = autoNameFromHeaders(columns);
  const r = await query(`
    INSERT INTO mapping_templates (fingerprint, name, headers, mapping, use_count, last_used_at)
    VALUES ($1, $2, $3::jsonb, $4::jsonb, 1, NOW())
    ON CONFLICT (fingerprint) DO UPDATE SET
      mapping      = EXCLUDED.mapping,
      headers      = EXCLUDED.headers,
      use_count    = mapping_templates.use_count + 1,
      last_used_at = NOW()
    RETURNING id, fingerprint, name, use_count
  `, [fingerprint, name, JSON.stringify(columns), JSON.stringify(mapping)]);
  return r.rows[0];
}

/**
 * Deletes a saved mapping by fingerprint. Returns count of rows removed.
 */
async function deleteMapping(fingerprint) {
  if (!fingerprint) return 0;
  await ensureMappingSchema();
  const r = await query(`DELETE FROM mapping_templates WHERE fingerprint = $1`, [fingerprint]);
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
  // Owner
  { key: 'first_name',      label: 'Owner First Name',  required: false, group: 'Owner' },
  { key: 'last_name',       label: 'Owner Last Name',   required: false, group: 'Owner' },
  { key: 'mailing_address', label: 'Mailing Address',   required: false, group: 'Owner' },
  { key: 'mailing_city',    label: 'Mailing City',      required: false, group: 'Owner' },
  { key: 'mailing_state',   label: 'Mailing State',     required: false, group: 'Owner' },
  { key: 'mailing_zip',     label: 'Mailing ZIP',       required: false, group: 'Owner' },
  { key: 'email_1',          label: 'Email 1',           required: false, group: 'Owner' },
  { key: 'email_2',          label: 'Email 2',           required: false, group: 'Owner' },
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
    first_name: ['firstname','ownerfirst','ownersfirstname','first'],
    last_name: ['lastname','ownerlast','ownerslastname','last'],
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
  const existingLists = await query(`SELECT id, list_name, list_type FROM lists ORDER BY list_name ASC`);
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
      const template = await lookupMappingByFingerprint(fingerprint);
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
    const saved = await upsertMapping(fingerprint, columns, cleanMapping);
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
    const deleted = await deleteMapping(fingerprint);
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
        const res = await fetch('/import/property/start-job', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mapping,
            filename: importData.filename,
            listName:   importData.listName   || null,
            listId:     importData.listId     || null,
            listType:   importData.listType   || null,
            listSource: importData.listSource || null
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

    // ── Resolve list: create new or use existing ──────────────────────────────
    let resolvedListId = null;
    if (listName && listName.trim()) {
      // 2026-04-20 pass 12: atomic UPSERT. Pre-pass-12 this was SELECT then
      // conditional INSERT — two concurrent imports for the same list name
      // both saw "doesn't exist" and both INSERTed, one hitting UNIQUE
      // constraint violation and returning a 500. UPSERT keyed on the
      // existing UNIQUE(list_name) constraint handles both "create new"
      // and "fetch existing" atomically. The DO UPDATE branch re-writes
      // list_name to itself — no-op but lets RETURNING fire so we always
      // get the id regardless of branch.
      const upserted = await query(
        `INSERT INTO lists (list_name, list_type, source, upload_date, active)
         VALUES ($1, $2, $3, NOW(), true)
         ON CONFLICT (list_name) DO UPDATE SET list_name = EXCLUDED.list_name
         RETURNING id`,
        [listName.trim(), listType || null, listSource || null]
      );
      resolvedListId = upserted.rows[0].id;
    } else if (listId) {
      resolvedListId = parseInt(listId);
    }

    // Ensure markets
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
      ('VA','VA','Virginia'),('WA','WA','Washington'),('WV','WV','West Virginia'),('WI','WI','Wisconsin'),('WY','WY','Wyoming')
      ON CONFLICT (state_code) DO UPDATE SET name=EXCLUDED.name, state_name=EXCLUDED.state_name`);
    const mktRes = await query(`SELECT id, state_code FROM markets`);
    const mktMap = {};
    mktRes.rows.forEach(m => { mktMap[m.state_code] = m.id; });

    const get = (row, key) => {
      const col = mapping[key];
      return col ? (row[col] || '').toString().trim() : '';
    };

    const toNum = v => v && !isNaN(v) ? parseFloat(v.replace(/[$,%]/g, '')) : null;
    const toInt = v => v && !isNaN(v) ? parseInt(v) : null;
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
    const normalizeZip = v => {
      if (!v) return '';
      const m = String(v).trim().match(/^\d{5}/);
      return m ? m[0] : String(v).trim().slice(0, 10);
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
      const state  = normalizeState(get(row,'state_code'));
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
        normalizeState(get(row,'state_code')),
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

    if (!dedupedRows.length) {
      return res.json({ created, updated, errors, resolvedListId, skipped: skippedReasons, firstError: firstError || null });
    }

    // Build arrays for UNNEST bulk insert
    const streets=[], cities=[], states=[], zips=[], counties=[], mktIds=[], sources=[];
    const propTypes=[], yearBuilts=[], sqfts=[], bedrooms=[], bathrooms=[], lotSizes=[];
    const assessedVals=[], estVals=[], equityPcts=[], propStatuses=[], conditions=[];
    const lastSaleDates=[], lastSalePrices=[], vacants=[];

    for (const row of dedupedRows) {
      const state = normalizeState(get(row,'state_code'));
      streets.push(get(row,'street'));
      cities.push(get(row,'city'));
      states.push(state);
      zips.push(normalizeZip(get(row,'zip_code')));
      counties.push(get(row,'county')||null);
      mktIds.push(mktMap[state]||null);
      sources.push(get(row,'source')||filename||null);
      propTypes.push(get(row,'property_type')||null);
      yearBuilts.push(toInt(get(row,'year_built')));
      sqfts.push(toInt(get(row,'sqft')));
      bedrooms.push(toInt(get(row,'bedrooms')));
      bathrooms.push(toNum(get(row,'bathrooms')));
      lotSizes.push(toInt(get(row,'lot_size')));
      assessedVals.push(toNum(get(row,'assessed_value')));
      estVals.push(toNum(get(row,'estimated_value')));
      equityPcts.push(toNum(get(row,'equity_percent')));
      propStatuses.push(get(row,'property_status')||null);
      conditions.push(get(row,'condition')||null);
      lastSaleDates.push(toDate(get(row,'last_sale_date')));
      lastSalePrices.push(toNum(get(row,'last_sale_price')));
      vacants.push(toBool(get(row,'vacant')));
    }

    const propRes = await query(`
      INSERT INTO properties (
        street,city,state_code,zip_code,county,market_id,source,
        property_type,year_built,sqft,bedrooms,bathrooms,lot_size,
        assessed_value,estimated_value,equity_percent,property_status,
        condition,last_sale_date,last_sale_price,vacant,first_seen_at
      )
      SELECT * FROM UNNEST(
        $1::text[],$2::text[],$3::text[],$4::text[],$5::text[],$6::int[],$7::text[],
        $8::text[],$9::int[],$10::int[],$11::int[],$12::numeric[],$13::int[],
        $14::numeric[],$15::numeric[],$16::numeric[],$17::text[],
        $18::text[],$19::date[],$20::numeric[],$21::boolean[]
      ) AS t(street,city,state_code,zip_code,county,market_id,source,
        property_type,year_built,sqft,bedrooms,bathrooms,lot_size,
        assessed_value,estimated_value,equity_percent,property_status,
        condition,last_sale_date,last_sale_price,vacant),
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
        updated_at      = NOW()
      RETURNING id, xmax, street, city, state_code, zip_code
    `, [streets,cities,states,zips,counties,mktIds,sources,
        propTypes,yearBuilts,sqfts,bedrooms,bathrooms,lotSizes,
        assessedVals,estVals,equityPcts,propStatuses,conditions,
        lastSaleDates,lastSalePrices,vacants]);

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
        const state  = normalizeState(get(row,'state_code'));
        const zip    = normalizeZip(get(row,'zip_code'));
        const key    = (street+'|'+city+'|'+state+'|'+zip).toLowerCase();
        const prop   = propMap[key];
        if (!prop) continue;
        const propertyId = prop.id;

        const firstName = get(row,'first_name');
        const lastName  = get(row,'last_name');
        if (firstName || lastName) {
          const existPC = await query(`SELECT contact_id FROM property_contacts WHERE property_id=$1 AND primary_contact=true LIMIT 1`,[propertyId]);
          let contactId;
          if (existPC.rows.length) {
            contactId = existPC.rows[0].contact_id;
            await query(`UPDATE contacts SET
              first_name=COALESCE(NULLIF($1,''),first_name),last_name=COALESCE(NULLIF($2,''),last_name),
              mailing_address=COALESCE(NULLIF($3,''),mailing_address),mailing_city=COALESCE(NULLIF($4,''),mailing_city),
              mailing_state=COALESCE(NULLIF($5,''),mailing_state),mailing_zip=COALESCE(NULLIF($6,''),mailing_zip),
              email_1=COALESCE(NULLIF($7,''),email_1),email_2=COALESCE(NULLIF($8,''),email_2),updated_at=NOW()
              WHERE id=$9`,
              [firstName,lastName,get(row,'mailing_address'),get(row,'mailing_city'),
               get(row,'mailing_state'),get(row,'mailing_zip'),get(row,'email_1')||'',get(row,'email_2')||'',contactId]);
          } else {
            const cr = await query(`INSERT INTO contacts (first_name,last_name,mailing_address,mailing_city,mailing_state,mailing_zip,email_1,email_2)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
              [firstName,lastName,get(row,'mailing_address'),get(row,'mailing_city'),
               get(row,'mailing_state'),get(row,'mailing_zip'),get(row,'email_1')||null,get(row,'email_2')||null]);
            contactId = cr.rows[0].id;
            await query(`INSERT INTO property_contacts (property_id,contact_id,primary_contact) VALUES ($1,$2,true) ON CONFLICT DO NOTHING`,[propertyId,contactId]);
          }

          // Phones
          for (let i=1;i<=10;i++) {
            const phoneRaw = cleanPhone(get(row,`phone_${i}`));
            if (!phoneRaw||phoneRaw.length<7) continue;
            const pType   = (get(row,`phone_type_${i}`)||'unknown').toLowerCase().trim();
            const pStatus = (get(row,`phone_status_${i}`)||'unknown').toLowerCase().trim();
            await query(`INSERT INTO phones (contact_id,phone_number,phone_index,phone_type,phone_status)
              VALUES ($1,$2,$3,$4,$5) ON CONFLICT (contact_id,phone_number) DO UPDATE SET
              phone_type=CASE WHEN EXCLUDED.phone_type!='unknown' THEN EXCLUDED.phone_type ELSE phones.phone_type END,
              phone_status=CASE WHEN EXCLUDED.phone_status!='unknown' THEN EXCLUDED.phone_status ELSE phones.phone_status END`,
              [contactId,phoneRaw,i,pType,pStatus]);
          }
        }

        // Tag to list
        if (resolvedListId) {
          await query(`INSERT INTO property_lists (property_id,list_id,added_at) VALUES ($1,$2,NOW()) ON CONFLICT DO NOTHING`,
            [propertyId,resolvedListId]);
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

    const allRows = req.session.importRows;
    if (!allRows || !allRows.length) return res.status(400).json({ error: 'Session expired. Please re-upload your file.' });

    // Resolve or create list first
    let resolvedListId = null;
    if (listName && listName.trim()) {
      // 2026-04-20 pass 12: atomic UPSERT (same race fix as the /commit
      // flow — see comment there).
      const upserted = await query(
        `INSERT INTO lists (list_name, list_type, source, upload_date, active)
         VALUES ($1, $2, $3, NOW(), true)
         ON CONFLICT (list_name) DO UPDATE SET list_name = EXCLUDED.list_name
         RETURNING id`,
        [listName.trim(), listType || null, listSource || null]
      );
      resolvedListId = upserted.rows[0].id;
    } else if (listId) {
      resolvedListId = parseInt(listId);
    }

    // Create job record
    const jobRes = await query(
      `INSERT INTO bulk_import_jobs (status, filename, list_id, total_rows) VALUES ('pending',$1,$2,$3) RETURNING id`,
      [filename || 'import.csv', resolvedListId, allRows.length]
    );
    const jobId = jobRes.rows[0].id;

    // Copy rows out of session for background use (session may expire)
    const rows = [...allRows];
    req.session.importRows = null;
    req.session.save();

    // Fire background processing
    setImmediate(() => runBackgroundImport(jobId, rows, mapping, filename, resolvedListId, listType, listSource));

    res.json({ jobId, resolvedListId, total: allRows.length });
  } catch(e) {
    console.error('Start job error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── BACKGROUND IMPORT WORKER ──────────────────────────────────────────────────
async function runBackgroundImport(jobId, allRows, mapping, filename, resolvedListId) {
  const BATCH = 500;
  let inserted = 0, updated = 0, errors = 0, processed = 0;
  const allSkipped = [];  // hoisted so the catch block can reference it
  let totalDuplicatesMerged = 0;  // 2026-04-20: tracked separately from allSkipped — these rows aren't dropped, they're merged into the keeper

  try {
    await query(`UPDATE bulk_import_jobs SET status='running', updated_at=NOW() WHERE id=$1`, [jobId]);

    // Ensure markets
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
      ('VA','VA','Virginia'),('WA','WA','Washington'),('WV','WV','West Virginia'),('WI','WI','Wisconsin'),('WY','WY','Wyoming')
      ON CONFLICT (state_code) DO UPDATE SET name=EXCLUDED.name, state_name=EXCLUDED.state_name`);
    const mktRes = await query(`SELECT id, state_code FROM markets`);
    const mktMap = {};
    mktRes.rows.forEach(m => { mktMap[m.state_code] = m.id; });

    const get = (row, key) => { const col = mapping[key]; return col ? (row[col] || '').toString().trim() : ''; };
    const toNum = v => v && !isNaN(String(v).replace(/[$,%]/g,'')) ? parseFloat(String(v).replace(/[$,%]/g,'')) : null;
    const toInt = v => v && !isNaN(v) ? parseInt(v) : null;
    const toDate = v => { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString().split('T')[0]; };
    const toBool = v => { const s=(v||'').toLowerCase(); return s==='yes'||s==='true'||s==='1'||s==='y'?true:s==='no'||s==='false'||s==='0'||s==='n'?false:null; };
    const cleanPhone = v => normalizePhone(v);
    // Normalize ZIP to 5-digit only — strips ZIP+4 suffixes ("47303-3111" → "47303")
    // and any whitespace. Prevents duplicates when same property is exported by
    // different providers (PropStream uses 5-digit, REISift uses ZIP+4, etc.).
    const normalizeZip = v => {
      if (!v) return '';
      const m = String(v).trim().match(/^\d{5}/);
      return m ? m[0] : String(v).trim().slice(0, 10);
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
          normalizeState(get(row,'state_code')),
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

      if (dedupedRows.length) {
        // Bulk upsert properties (using deduped batch)
        const streets=[],cities=[],states=[],zips=[],counties=[],mktIds=[],sources=[];
        const propTypes=[],yearBuilts=[],sqfts=[],beds=[],baths=[],lots=[];
        const assessed=[],estVals=[],equity=[],propStatus=[],conds=[];
        const lastSaleDates=[],lastSalePrices=[],vacants=[];

        for (const row of dedupedRows) {
          const state = normalizeState(get(row,'state_code'));
          streets.push(get(row,'street')); cities.push(get(row,'city')); states.push(state);
          zips.push(normalizeZip(get(row,'zip_code'))); counties.push(get(row,'county')||null);
          mktIds.push(mktMap[state]||null); sources.push(get(row,'source')||filename||null);
          propTypes.push(get(row,'property_type')||null); yearBuilts.push(toInt(get(row,'year_built')));
          sqfts.push(toInt(get(row,'sqft'))); beds.push(toInt(get(row,'bedrooms')));
          baths.push(toNum(get(row,'bathrooms'))); lots.push(toInt(get(row,'lot_size')));
          assessed.push(toNum(get(row,'assessed_value'))); estVals.push(toNum(get(row,'estimated_value')));
          equity.push(toNum(get(row,'equity_percent'))); propStatus.push(get(row,'property_status')||null);
          conds.push(get(row,'condition')||null); lastSaleDates.push(toDate(get(row,'last_sale_date')));
          lastSalePrices.push(toNum(get(row,'last_sale_price'))); vacants.push(toBool(get(row,'vacant')));
        }

        const propRes = await query(`
          INSERT INTO properties (street,city,state_code,zip_code,county,market_id,source,property_type,year_built,sqft,bedrooms,bathrooms,lot_size,assessed_value,estimated_value,equity_percent,property_status,condition,last_sale_date,last_sale_price,vacant,first_seen_at)
          SELECT *,NOW() FROM UNNEST($1::text[],$2::text[],$3::text[],$4::text[],$5::text[],$6::int[],$7::text[],$8::text[],$9::int[],$10::int[],$11::int[],$12::numeric[],$13::int[],$14::numeric[],$15::numeric[],$16::numeric[],$17::text[],$18::text[],$19::date[],$20::numeric[],$21::boolean[])
          AS t(street,city,state_code,zip_code,county,market_id,source,property_type,year_built,sqft,bedrooms,bathrooms,lot_size,assessed_value,estimated_value,equity_percent,property_status,condition,last_sale_date,last_sale_price,vacant)
          ON CONFLICT (street,city,state_code,zip_code) DO UPDATE SET
            county=COALESCE(EXCLUDED.county,properties.county),source=COALESCE(EXCLUDED.source,properties.source),
            property_type=COALESCE(EXCLUDED.property_type,properties.property_type),year_built=COALESCE(EXCLUDED.year_built,properties.year_built),
            sqft=COALESCE(EXCLUDED.sqft,properties.sqft),bedrooms=COALESCE(EXCLUDED.bedrooms,properties.bedrooms),
            bathrooms=COALESCE(EXCLUDED.bathrooms,properties.bathrooms),lot_size=COALESCE(EXCLUDED.lot_size,properties.lot_size),
            assessed_value=COALESCE(EXCLUDED.assessed_value,properties.assessed_value),estimated_value=COALESCE(EXCLUDED.estimated_value,properties.estimated_value),
            equity_percent=COALESCE(EXCLUDED.equity_percent,properties.equity_percent),property_status=COALESCE(EXCLUDED.property_status,properties.property_status),
            condition=COALESCE(EXCLUDED.condition,properties.condition),last_sale_date=COALESCE(EXCLUDED.last_sale_date,properties.last_sale_date),
            last_sale_price=COALESCE(EXCLUDED.last_sale_price,properties.last_sale_price),vacant=COALESCE(EXCLUDED.vacant,properties.vacant),updated_at=NOW()
          RETURNING id, xmax, street, city, state_code, zip_code
        `, [streets,cities,states,zips,counties,mktIds,sources,propTypes,yearBuilts,sqfts,beds,baths,lots,assessed,estVals,equity,propStatus,conds,lastSaleDates,lastSalePrices,vacants]);

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
          normalizeState(get(r,'state_code')) + '|' +
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
              WHERE property_id = ANY($1::int[]) AND primary_contact = true`,
            [batchPropIds]
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
                WHERE phone_number = ANY($1::text[])
                ORDER BY phone_number, contact_id ASC`,
              [phoneArr]
            );
            for (const r of phRes.rows) phoneToExistingContact.set(r.phone_number, r.contact_id);
          }
        }

        // Split into update-existing vs insert-new
        const updIds=[], updFns=[], updLns=[], updMaddr=[], updMcity=[], updMstate=[], updMzip=[], updE1=[], updE2=[];
        const newPropIds=[], newFns=[], newLns=[], newMaddr=[], newMcity=[], newMstate=[], newMzip=[], newE1=[], newE2=[];
        const contactIdByProp = new Map();
        let reusedContactCount = 0;

        for (const [propId, row] of rowByPropId) {
          // 2026-04-20 bug #1 fix: skip blank-name rows from primary-contact
          // processing. They only exist in rowByPropId so the co-owner phase
          // can find their __secondaryOwners — no primary contact should be
          // created/updated from a row without a name.
          const rowFn = get(row,'first_name'), rowLn = get(row,'last_name');
          if (!rowFn && !rowLn) continue;

          if (existingPC.has(propId)) {
            const cid = existingPC.get(propId);
            contactIdByProp.set(propId, cid);
            updIds.push(cid);
            updFns.push(get(row,'first_name') || '');
            updLns.push(get(row,'last_name') || '');
            updMaddr.push(get(row,'mailing_address') || '');
            updMcity.push(get(row,'mailing_city') || '');
            updMstate.push(get(row,'mailing_state') || '');
            updMzip.push(get(row,'mailing_zip') || '');
            updE1.push(get(row,'email_1') || '');
            updE2.push(get(row,'email_2') || '');
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
            updFns.push(get(row,'first_name') || '');
            updLns.push(get(row,'last_name') || '');
            updMaddr.push(get(row,'mailing_address') || '');
            updMcity.push(get(row,'mailing_city') || '');
            updMstate.push(get(row,'mailing_state') || '');
            updMzip.push(get(row,'mailing_zip') || '');
            updE1.push(get(row,'email_1') || '');
            updE2.push(get(row,'email_2') || '');
            // Create the primary property_contacts link — safe via ON CONFLICT
            // on (property_id, contact_id).
            await query(
              `INSERT INTO property_contacts (property_id, contact_id, primary_contact)
               VALUES ($1, $2, true)
               ON CONFLICT (property_id, contact_id) DO UPDATE SET primary_contact = true`,
              [propId, reusedCid]
            );
            reusedContactCount++;
          } else {
            newPropIds.push(propId);
            newFns.push(get(row,'first_name') || '');
            newLns.push(get(row,'last_name') || '');
            newMaddr.push(get(row,'mailing_address') || '');
            newMcity.push(get(row,'mailing_city') || '');
            newMstate.push(get(row,'mailing_state') || '');
            newMzip.push(get(row,'mailing_zip') || '');
            newE1.push(get(row,'email_1') || null);
            newE2.push(get(row,'email_2') || null);
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
              updated_at      = NOW()
            FROM UNNEST(
              $1::int[], $2::text[], $3::text[], $4::text[], $5::text[],
              $6::text[], $7::text[], $8::text[], $9::text[]
            ) AS t(id, first_name, last_name, mailing_address, mailing_city,
                   mailing_state, mailing_zip, email_1, email_2)
            WHERE contacts.id = t.id
          `, [updIds, updFns, updLns, updMaddr, updMcity, updMstate, updMzip, updE1, updE2]);
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
            INSERT INTO contacts (id, first_name, last_name, mailing_address, mailing_city, mailing_state, mailing_zip, email_1, email_2)
            SELECT * FROM UNNEST(
              $1::int[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[]
            ) AS t(id, first_name, last_name, mailing_address, mailing_city, mailing_state, mailing_zip, email_1, email_2)
          `, [newIds, newFns, newLns, newMaddr, newMcity, newMstate, newMzip, newE1, newE2]);
          await query(`
            INSERT INTO property_contacts (property_id, contact_id, primary_contact)
            SELECT property_id, contact_id, true
              FROM UNNEST($1::int[], $2::int[]) AS t(property_id, contact_id)
            ON CONFLICT DO NOTHING
          `, [newPropIds, newIds]);
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
            const pType   = (get(row, `phone_type_${i}`)   || 'unknown').toLowerCase().trim();
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
            INSERT INTO phones (contact_id, phone_number, phone_index, phone_type, phone_status)
            SELECT * FROM UNNEST($1::int[], $2::text[], $3::int[], $4::text[], $5::text[])
              AS t(contact_id, phone_number, phone_index, phone_type, phone_status)
            ON CONFLICT (contact_id, phone_number) DO UPDATE SET
              phone_type   = CASE WHEN EXCLUDED.phone_type   != 'unknown' THEN EXCLUDED.phone_type   ELSE phones.phone_type   END,
              phone_status = CASE WHEN EXCLUDED.phone_status != 'unknown' THEN EXCLUDED.phone_status ELSE phones.phone_status END,
              updated_at   = NOW()
          `, [phCids, phNums, phIdxs, phTypes, phStats]);
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
                 JOIN contacts c ON c.id = pc.contact_id
                WHERE pc.property_id = ANY($1::int[])
                  AND pc.primary_contact = false`,
              [coPropIds]
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
              WHERE contacts.id = t.id
            `, [
              coUpdateTasks.map(t => t.contactId),
              coUpdateTasks.map(t => get(t.row,'first_name') || ''),
              coUpdateTasks.map(t => get(t.row,'last_name')  || ''),
              coUpdateTasks.map(t => get(t.row,'mailing_address') || ''),
              coUpdateTasks.map(t => get(t.row,'mailing_city')    || ''),
              coUpdateTasks.map(t => get(t.row,'mailing_state')   || ''),
              coUpdateTasks.map(t => get(t.row,'mailing_zip')     || ''),
              coUpdateTasks.map(t => get(t.row,'email_1') || ''),
              coUpdateTasks.map(t => get(t.row,'email_2') || ''),
            ]);
          }

          // Link reused contacts with primary_contact=false
          if (coReuseTasks.length > 0) {
            await query(`
              INSERT INTO property_contacts (property_id, contact_id, primary_contact)
              SELECT t.property_id, t.contact_id, false
                FROM UNNEST($1::int[], $2::int[]) AS t(property_id, contact_id)
              ON CONFLICT (property_id, contact_id) DO NOTHING
            `, [
              coReuseTasks.map(t => t.propId),
              coReuseTasks.map(t => t.contactId),
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
              INSERT INTO contacts (id, first_name, last_name, mailing_address, mailing_city, mailing_state, mailing_zip, email_1, email_2)
              SELECT * FROM UNNEST(
                $1::int[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[]
              ) AS t(id, first_name, last_name, mailing_address, mailing_city, mailing_state, mailing_zip, email_1, email_2)
            `, [
              coContactIds,
              coNewTasks.map(t => get(t.row,'first_name') || ''),
              coNewTasks.map(t => get(t.row,'last_name')  || ''),
              coNewTasks.map(t => get(t.row,'mailing_address') || ''),
              coNewTasks.map(t => get(t.row,'mailing_city')    || ''),
              coNewTasks.map(t => get(t.row,'mailing_state')   || ''),
              coNewTasks.map(t => get(t.row,'mailing_zip')     || ''),
              coNewTasks.map(t => get(t.row,'email_1') || ''),
              coNewTasks.map(t => get(t.row,'email_2') || ''),
            ]);

            await query(`
              INSERT INTO property_contacts (property_id, contact_id, primary_contact)
              SELECT t.property_id, t.contact_id, false
                FROM UNNEST($1::int[], $2::int[]) AS t(property_id, contact_id)
              ON CONFLICT (property_id, contact_id) DO NOTHING
            `, [
              coNewTasks.map(t => t.propId),
              coContactIds,
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
              const pType   = (get(t.row, `phone_type_${i}`)   || 'unknown').toLowerCase().trim();
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
              INSERT INTO phones (contact_id, phone_number, phone_index, phone_type, phone_status)
              SELECT * FROM UNNEST($1::int[], $2::text[], $3::int[], $4::text[], $5::text[])
                AS t(contact_id, phone_number, phone_index, phone_type, phone_status)
              ON CONFLICT (contact_id, phone_number) DO UPDATE SET
                phone_type   = CASE WHEN EXCLUDED.phone_type   != 'unknown' THEN EXCLUDED.phone_type   ELSE phones.phone_type   END,
                phone_status = CASE WHEN EXCLUDED.phone_status != 'unknown' THEN EXCLUDED.phone_status ELSE phones.phone_status END,
                updated_at   = NOW()
            `, [cCids, cNums, cIdxs, cTypes, cStats]);
          }

          console.log(`[property-import] attached ${coOwnerTasks.length} co-owner(s): ${coUpdateTasks.length} existing (updated), ${coReuseTasks.length} reused, ${coNewTasks.length} new`);
        }

        // Bulk INSERT property_lists links for every property in the batch
        if (resolvedListId && propIds.length > 0) {
          await query(`
            INSERT INTO property_lists (property_id, list_id, added_at)
            SELECT property_id, $2, NOW()
              FROM UNNEST($1::int[]) AS t(property_id)
            ON CONFLICT DO NOTHING
          `, [propIds, resolvedListId]);
        }
      }

      processed += rows.length;
      await query(`UPDATE bulk_import_jobs SET processed_rows=$1,inserted=$2,updated=$3,errors=$4,updated_at=NOW() WHERE id=$5`,
        [processed, inserted, updated, errors, jobId]);
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
