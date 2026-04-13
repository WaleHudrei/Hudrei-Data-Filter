const express = require('express');
const router = express.Router();
const multer = require('multer');
const Papa = require('papaparse');
const { query } = require('../db');
const { shell } = require('../shared-shell');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.redirect('/login');
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
              <select id="list-source" style="width:100%;padding:9px 12px;border:1px solid #ddd;border-radius:8px;font-size:13px;font-family:inherit;background:#fff">
                <option value="">— Source (optional) —</option>
                <option value="PropStream">PropStream</option>
                <option value="DealMachine">DealMachine</option>
                <option value="BatchSkipTracing">BatchSkipTracing</option>
                <option value="REISift">REISift</option>
                <option value="DataSift">DataSift</option>
                <option value="Listsource">Listsource</option>
                <option value="Manual">Manual</option>
              </select>
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
      const listSource = document.getElementById('list-source').value;
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
router.post('/parse', requireAuth, upload.single('csvfile'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const parsed = Papa.parse(req.file.buffer.toString('utf8'), { header: true, skipEmptyLines: true });
    const columns = parsed.meta.fields || [];
    const rows = parsed.data;
    if (!rows.length) return res.status(400).json({ error: 'File is empty.' });
    const MAX_ROWS = 100000;
    if (rows.length > MAX_ROWS) {
      return res.status(400).json({ error: `File has ${rows.length.toLocaleString()} rows. Use Bulk Import for files over 100k rows.` });
    }
    const mapping = autoMap(columns);
    // Store full rows in server session — only send preview to browser
    req.session.importRows = rows;
    req.session.save();
    res.json({ columns, previewRows: rows.slice(0, 10), totalRows: rows.length, mapping, filename: req.file.originalname });
  } catch(e) { res.status(500).json({ error: e.message }); }
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
          <div id="list-badge" style="display:none;margin-top:6px;display:inline-flex;align-items:center;gap:6px;background:#e8f5ee;color:#1a7a4a;border-radius:6px;padding:4px 10px;font-size:12px;font-weight:600"></div>
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

    document.getElementById('file-info').textContent =
      (importData.filename || 'Unknown file') + ' — ' + (importData.totalRows || 0).toLocaleString() + ' rows';
    if (importData.listName) {
      const badge = document.getElementById('list-badge');
      badge.textContent = '📋 ' + importData.listName;
      badge.style.display = 'inline-flex';
    }

    // Populate all dropdowns with CSV columns
    document.querySelectorAll('select[data-loki]').forEach(sel => {
      columns.forEach(col => {
        const opt = document.createElement('option');
        opt.value = col; opt.textContent = col;
        sel.appendChild(opt);
      });
      // Apply auto-mapping
      const lokiKey = sel.dataset.loki;
      if (mapping[lokiKey]) sel.value = mapping[lokiKey];
    });

    function proceed() {
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
          <div id="list-badge" style="display:none;margin-top:6px;display:inline-flex;align-items:center;gap:6px;background:#e8f5ee;color:#1a7a4a;border-radius:6px;padding:4px 10px;font-size:12px;font-weight:600"></div>
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
          } catch(e) {}
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

    // ── Resolve list: create new or use existing ──────────────────────────────
    let resolvedListId = null;
    if (listName && listName.trim()) {
      // Create new list (or get existing by same name)
      const existingList = await query(`SELECT id FROM lists WHERE LOWER(list_name) = LOWER($1)`, [listName.trim()]);
      if (existingList.rows.length) {
        resolvedListId = existingList.rows[0].id;
      } else {
        const newList = await query(
          `INSERT INTO lists (list_name, list_type, source, upload_date, active)
            VALUES ($1, $2, $3, NOW(), true) RETURNING id`,
          [listName.trim(), listType || null, listSource || null]
        );
        resolvedListId = newList.rows[0].id;
      }
    } else if (listId) {
      resolvedListId = parseInt(listId);
    }

    // Ensure markets
    await query(`INSERT INTO markets (name, state_code, state_name) VALUES
      ('Indianapolis Metro','IN','Indiana'),('Atlanta Metro','GA','Georgia')
      ON CONFLICT (state_code) DO NOTHING`);
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
    const cleanPhone = v => v ? v.replace(/\D/g,'') : '';

    // ── Bulk upsert properties ───────────────────────────────────────────────
    const validRows = [];
    for (const row of rows) {
      const street = get(row, 'street');
      const city   = get(row, 'city');
      const state  = (get(row, 'state_code') || '').toUpperCase().slice(0,2);
      if (!street || !city || !state) { errors++; continue; }
      validRows.push(row);
    }

    if (!validRows.length) {
      return res.json({ created, updated, errors, resolvedListId, firstError: global._importFirstError || null });
    }

    // Build arrays for UNNEST bulk insert
    const streets=[], cities=[], states=[], zips=[], counties=[], mktIds=[], sources=[];
    const propTypes=[], yearBuilts=[], sqfts=[], bedrooms=[], bathrooms=[], lotSizes=[];
    const assessedVals=[], estVals=[], equityPcts=[], propStatuses=[], conditions=[];
    const lastSaleDates=[], lastSalePrices=[], vacants=[];

    for (const row of validRows) {
      const state = get(row,'state_code').toUpperCase().slice(0,2);
      streets.push(get(row,'street'));
      cities.push(get(row,'city'));
      states.push(state);
      zips.push(get(row,'zip_code')||'');
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
    for (const row of validRows) {
      try {
        const street = get(row,'street');
        const city   = get(row,'city');
        const state  = get(row,'state_code').toUpperCase().slice(0,2);
        const zip    = get(row,'zip_code')||'';
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
        if (errors===1) global._importFirstError = rowErr.message;
      }
    }

    res.json({ created, updated, errors, firstError: global._importFirstError || null, resolvedListId });
    global._importFirstError = null;
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
      const existingList = await query(`SELECT id FROM lists WHERE LOWER(list_name) = LOWER($1)`, [listName.trim()]);
      if (existingList.rows.length) {
        resolvedListId = existingList.rows[0].id;
      } else {
        const newList = await query(
          `INSERT INTO lists (list_name, list_type, source, upload_date, active) VALUES ($1,$2,$3,NOW(),true) RETURNING id`,
          [listName.trim(), listType || null, listSource || null]
        );
        resolvedListId = newList.rows[0].id;
      }
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

  try {
    await query(`UPDATE bulk_import_jobs SET status='running', updated_at=NOW() WHERE id=$1`, [jobId]);

    // Ensure markets
    await query(`INSERT INTO markets (name,state_code,state_name) VALUES ('Indianapolis Metro','IN','Indiana'),('Atlanta Metro','GA','Georgia') ON CONFLICT (state_code) DO NOTHING`);
    const mktRes = await query(`SELECT id, state_code FROM markets`);
    const mktMap = {};
    mktRes.rows.forEach(m => { mktMap[m.state_code] = m.id; });

    const get = (row, key) => { const col = mapping[key]; return col ? (row[col] || '').toString().trim() : ''; };
    const toNum = v => v && !isNaN(String(v).replace(/[$,%]/g,'')) ? parseFloat(String(v).replace(/[$,%]/g,'')) : null;
    const toInt = v => v && !isNaN(v) ? parseInt(v) : null;
    const toDate = v => { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString().split('T')[0]; };
    const toBool = v => { const s=(v||'').toLowerCase(); return s==='yes'||s==='true'||s==='1'||s==='y'?true:s==='no'||s==='false'||s==='0'||s==='n'?false:null; };
    const cleanPhone = v => v ? v.replace(/\D/g,'') : '';

    for (let offset = 0; offset < allRows.length; offset += BATCH) {
      const rows = allRows.slice(offset, offset + BATCH);
      const validRows = rows.filter(row => get(row,'street') && get(row,'city') && get(row,'state_code'));
      errors += rows.length - validRows.length;

      if (validRows.length) {
        // Bulk upsert properties
        const streets=[],cities=[],states=[],zips=[],counties=[],mktIds=[],sources=[];
        const propTypes=[],yearBuilts=[],sqfts=[],beds=[],baths=[],lots=[];
        const assessed=[],estVals=[],equity=[],propStatus=[],conds=[];
        const lastSaleDates=[],lastSalePrices=[],vacants=[];

        for (const row of validRows) {
          const state = get(row,'state_code').toUpperCase().slice(0,2);
          streets.push(get(row,'street')); cities.push(get(row,'city')); states.push(state);
          zips.push(get(row,'zip_code')||''); counties.push(get(row,'county')||null);
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
        for (const p of propRes.rows) {
          propMap[(p.street+'|'+p.city+'|'+p.state_code+'|'+p.zip_code).toLowerCase()] = { id: p.id, wasInsert: p.xmax==='0' };
          if (p.xmax==='0') inserted++; else updated++;
        }

        // Contacts + phones
        for (const row of validRows) {
          try {
            const key = (get(row,'street')+'|'+get(row,'city')+'|'+get(row,'state_code').toUpperCase().slice(0,2)+'|'+(get(row,'zip_code')||'')).toLowerCase();
            const prop = propMap[key];
            if (!prop) continue;
            const propertyId = prop.id;
            const firstName = get(row,'first_name'), lastName = get(row,'last_name');
            if (firstName || lastName) {
              const existPC = await query(`SELECT contact_id FROM property_contacts WHERE property_id=$1 AND primary_contact=true LIMIT 1`,[propertyId]);
              let contactId;
              if (existPC.rows.length) {
                contactId = existPC.rows[0].contact_id;
                await query(`UPDATE contacts SET first_name=COALESCE(NULLIF($1,''),first_name),last_name=COALESCE(NULLIF($2,''),last_name),mailing_address=COALESCE(NULLIF($3,''),mailing_address),mailing_city=COALESCE(NULLIF($4,''),mailing_city),mailing_state=COALESCE(NULLIF($5,''),mailing_state),mailing_zip=COALESCE(NULLIF($6,''),mailing_zip),email_1=COALESCE(NULLIF($7,''),email_1),email_2=COALESCE(NULLIF($8,''),email_2),updated_at=NOW() WHERE id=$9`,
                  [firstName,lastName,get(row,'mailing_address'),get(row,'mailing_city'),get(row,'mailing_state'),get(row,'mailing_zip'),get(row,'email_1')||'',get(row,'email_2')||'',contactId]);
              } else {
                const cr = await query(`INSERT INTO contacts (first_name,last_name,mailing_address,mailing_city,mailing_state,mailing_zip,email_1,email_2) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
                  [firstName,lastName,get(row,'mailing_address'),get(row,'mailing_city'),get(row,'mailing_state'),get(row,'mailing_zip'),get(row,'email_1')||null,get(row,'email_2')||null]);
                contactId = cr.rows[0].id;
                await query(`INSERT INTO property_contacts (property_id,contact_id,primary_contact) VALUES ($1,$2,true) ON CONFLICT DO NOTHING`,[propertyId,contactId]);
              }
              for (let i=1;i<=10;i++) {
                const phoneRaw = cleanPhone(get(row,`phone_${i}`));
                if (!phoneRaw||phoneRaw.length<7) continue;
                const pType=(get(row,`phone_type_${i}`)||'unknown').toLowerCase().trim();
                const pStatus=(get(row,`phone_status_${i}`)||'unknown').toLowerCase().trim();
                await query(`INSERT INTO phones (contact_id,phone_number,phone_index,phone_type,phone_status) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (contact_id,phone_number) DO UPDATE SET phone_type=CASE WHEN EXCLUDED.phone_type!='unknown' THEN EXCLUDED.phone_type ELSE phones.phone_type END,phone_status=CASE WHEN EXCLUDED.phone_status!='unknown' THEN EXCLUDED.phone_status ELSE phones.phone_status END`,
                  [contactId,phoneRaw,i,pType,pStatus]);
              }
            }
            if (resolvedListId) {
              await query(`INSERT INTO property_lists (property_id,list_id,added_at) VALUES ($1,$2,NOW()) ON CONFLICT DO NOTHING`,[propertyId,resolvedListId]);
            }
          } catch(rowErr) { errors++; }
        }
      }

      processed += rows.length;
      await query(`UPDATE bulk_import_jobs SET processed_rows=$1,inserted=$2,updated=$3,errors=$4,updated_at=NOW() WHERE id=$5`,
        [processed, inserted, updated, errors, jobId]);
    }

    await query(`UPDATE bulk_import_jobs SET status='complete',processed_rows=$1,inserted=$2,updated=$3,errors=$4,updated_at=NOW() WHERE id=$5`,
      [allRows.length, inserted, updated, errors, jobId]);

  } catch(e) {
    console.error('Background import error:', e.message);
    await query(`UPDATE bulk_import_jobs SET status='error',error_log=$1,updated_at=NOW() WHERE id=$2`, [e.message, jobId]);
  }
}

module.exports = router;
