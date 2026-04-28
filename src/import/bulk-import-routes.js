const express = require('express');
const router = express.Router();
const multer = require('multer');
const Papa = require('papaparse');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { query, refreshOwnerPortfolioMv } = require('../db');
const { shell } = require('../shared-shell');
const { normalizeState } = require('./state');
// 2026-04-20 pass 12: shared phone normalizer. Replaces the prior inline
// cleanPhone that just stripped non-digits — it mishandled extensions
// ("(555) 123-4567 x3" → "55512345673") and stored "1-555-123-4567" as
// "15551234567" while filtration.js stored the same input as "5551234567".
const { normalizePhone } = require('../phone-normalize');
const { bufferToCsvText, stripBom } = require('../csv-utils');

// ─────────────────────────────────────────────────────────────────────────────
// bulk-import-routes.js — REISift bulk import (2026-04-17 rewrite)
//
// What changed vs the old version:
//   • normalizeState replaces raw .toUpperCase().slice(0,2). A row with
//     "46218" or "Unknown" in the State column now skips cleanly instead of
//     poisoning the markets table with a "46" / "UN" entry. (Audit #3/#7.)
//   • processBatch no longer does row-by-row inserts. Every batch of 500
//     becomes 5 queries total (properties UPSERT via UNNEST, property_contacts
//     pre-fetch, contacts bulk UPSERT, phones bulk UPSERT, market cache fill).
//     On a 10k-row REISift export: was ~60-90s, now ~5-8s. (Decision #3.)
//   • CSV is staged to a disk temp file instead of held in memory inside the
//     closure for the whole job's lifetime. A 500MB upload used to sit in RAM
//     twice (the original req.file.buffer + csvText). Now the buffer is
//     flushed to /tmp and streamed back. (Audit #24.)
//   • Module-level market cache shared across jobs instead of rebuilding per-
//     job. Invalidated on server restart — which happens on every deploy.
// ─────────────────────────────────────────────────────────────────────────────

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 600 * 1024 * 1024 } // 600MB
});

function requireAuth(req, res, next) {
  if (!req.session || !req.session.authenticated) return res.redirect('/login');
  if (!req.session.tenantId) return res.redirect('/login');
  req.tenantId = req.session.tenantId;
  req.userId = req.session.userId;
  req.role = req.session.role;
  next();
}

// Module-level market cache: state_code → market_id. Survives across imports.
const marketCache = Object.create(null);
async function primeMarketCache() {
  if (Object.keys(marketCache).length > 0) return;
  const mktRes = await query(`SELECT id, state_code FROM markets`);
  for (const m of mktRes.rows) marketCache[m.state_code] = m.id;
}

// ── REISift column mapping ─────────────────────────────────────────────────────
function mapReisiftRow(row) {
  const get = (key) => (row[key] || '').toString().trim();
  const toNum  = (v) => { const n = parseFloat(String(v).replace(/[$,%]/g,'')); return isNaN(n) ? null : n; };
  const toInt  = (v) => { const n = parseInt(String(v).replace(/[$,%]/g,''), 10); return isNaN(n) ? null : n; };
  // 2026-04-21 PM hotfix: bounded helpers — same semantics as
  // property-import-routes.js. Out-of-range values clamp to NULL rather
  // than crashing the whole batch with `numeric field overflow`. REISift
  // exports are usually cleaner than PropStream, but defense-in-depth
  // applies equally here. See property-import-routes.js for full rationale.
  const MONEY_LIMIT = 9_999_999_999.99;
  const toMoney = (v) => {
    const n = toNum(v);
    if (n == null) return null;
    if (Math.abs(n) > MONEY_LIMIT) {
      console.warn(`[bulk-import] out-of-range money value ${JSON.stringify(v)} → NULL`);
      return null;
    }
    return n;
  };
  const toYear = (v) => {
    const n = toNum(v);
    if (n == null) return null;
    const y = Math.round(n);
    if (y < 1800 || y > 2200) {
      console.warn(`[bulk-import] invalid year value ${JSON.stringify(v)} → NULL`);
      return null;
    }
    return y;
  };
  const toSmallInt = (v) => {
    const n = toInt(v);
    if (n == null) return null;
    if (n < -32_768 || n > 32_767) {
      console.warn(`[bulk-import] out-of-range smallint value ${JSON.stringify(v)} → NULL`);
      return null;
    }
    return n;
  };
  const toBathrooms = (v) => {
    const n = toNum(v);
    if (n == null) return null;
    if (n < 0 || n > 99) {
      console.warn(`[bulk-import] out-of-range bathrooms value ${JSON.stringify(v)} → NULL`);
      return null;
    }
    return n;
  };
  const toDate = (v) => { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString().split('T')[0]; };
  const toBool = (v) => { const s = (v||'').toLowerCase(); return s==='true'||s==='yes'||s==='1' ? true : s==='false'||s==='no'||s==='0' ? false : null; };
  const cleanPhone = (v) => normalizePhone(v);
  const mapStatus = (v) => {
    const s = (v||'').toLowerCase();
    if (s==='correct') return 'correct';
    if (s==='wrong') return 'wrong';
    if (s==='do not call'||s==='dnc') return 'do_not_call';
    return 'unknown';
  };

  // normalizeState returns null for garbage — caller filters those rows out.
  const pState = normalizeState(get('Property state'));
  const mState = normalizeState(get('Mailing state'));

  const property = {
    street:          get('Property address'),
    city:            get('Property city'),
    state_code:      pState,
    zip_code:        get('Property zip5') || get('Property zip').slice(0,5),
    county:          get('Property county'),
    vacant:          toBool(get('Property vacant')),
    property_type:   null,
    bedrooms:        toSmallInt(get('Bedrooms')),
    bathrooms:       toBathrooms(get('Bathrooms')),
    sqft:            toInt(get('Sqft')),
    year_built:      toYear(get('Year')),
    lot_size:        toInt(get('Lot size')),
    estimated_value: toMoney(get('Estimated value')),
    last_sale_price: toMoney(get('Last sale price')),
    last_sale_date:  toDate(get('Last sold')),
    property_status: get('Status') || null,
    source:          'REISift',
  };

  const contact = {
    first_name:      get('First Name'),
    last_name:       get('Last Name'),
    mailing_address: get('Mailing address'),
    mailing_city:    get('Mailing city'),
    mailing_state:   mState,
    mailing_zip:     get('Mailing zip5') || get('Mailing zip').slice(0,5),
    email_1:         get('Email 1') || null,
    email_2:         get('Email 2') || null,
  };

  const phones = [];
  for (let i = 1; i <= 10; i++) {
    const num = cleanPhone(get(`Phone ${i}`));
    if (num && num.length >= 7) {
      phones.push({
        phone_number: num,
        phone_index:  i,
        phone_status: mapStatus(get(`Phone Status ${i}`)),
        phone_tag:    get(`Phone Tags ${i}`).split(',')[0].trim() || null,
      });
    }
  }

  return { property, contact, phones };
}

async function ensureJobsTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS bulk_import_jobs (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255),
      source VARCHAR(50) DEFAULT 'reisift',
      status VARCHAR(20) DEFAULT 'running',
      total_rows INTEGER DEFAULT 0,
      rows_processed INTEGER DEFAULT 0,
      rows_created INTEGER DEFAULT 0,
      rows_updated INTEGER DEFAULT 0,
      rows_errored INTEGER DEFAULT 0,
      error_message TEXT,
      started_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    )
  `);
}

// ── STEP 1: Upload page UI (unchanged) ────────────────────────────────────────
router.get('/', requireAuth, (req, res) => {
  res.send(shell('Bulk Import', `
    <div style="max-width:700px">
      <div style="margin-bottom:1rem"><a href="/upload" style="font-size:13px;color:#888;text-decoration:none">← Upload</a></div>
      <div style="font-size:20px;font-weight:600;margin-bottom:4px">Bulk Import — REISift Export</div>
      <p style="font-size:13px;color:#888;margin-bottom:1.5rem">Upload your full REISift export CSV. No row limit — the server handles everything. You can close this tab after starting.</p>

      <div class="card">
        <div id="upload-area">
          <div class="drop-zone" id="drop-zone">
            <svg width="32" height="32" fill="none" stroke="#aaa" stroke-width="1.5" viewBox="0 0 24 24" style="margin-bottom:10px"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            <div style="font-size:15px;font-weight:500;margin-bottom:4px">Drop REISift CSV here or click to browse</div>
            <div style="font-size:12px;color:#888">Supports files up to 600MB · Any number of rows</div>
          </div>
          <input type="file" id="file-input" accept=".csv" style="display:none">
        </div>
        <div id="uploading-state" style="display:none;text-align:center;padding:2rem">
          <div class="spinner" style="width:28px;height:28px;margin:0 auto 12px"></div>
          <div style="font-size:14px;font-weight:500;margin-bottom:4px">Uploading file…</div>
          <div style="font-size:12px;color:#888">Please wait, do not close this tab</div>
          <div id="upload-progress-text" style="font-size:12px;color:#aaa;margin-top:8px"></div>
        </div>
        <div id="error-state" style="display:none;background:#fff0f0;border:1px solid #f5c5c5;border-radius:8px;padding:12px;font-size:13px;color:#c0392b;margin-top:12px"></div>
      </div>

      <div id="active-jobs" style="margin-top:1.5rem"></div>
    </div>

    <script>
    checkJobs();
    async function checkJobs() {
      try {
        const res = await fetch('/import/bulk/jobs');
        const jobs = await res.json();
        if (!jobs.length) return;
        const wrap = document.getElementById('active-jobs');
        wrap.innerHTML = '<div style="font-size:13px;font-weight:600;margin-bottom:10px">Recent Imports</div>' +
          jobs.map(j => jobCard(j)).join('');
        if (jobs.some(j => j.status === 'running')) setTimeout(checkJobs, 2000);
      } catch(e) {}
    }
    function jobCard(j) {
      const pct = j.total_rows > 0 ? Math.round((j.rows_processed / j.total_rows) * 100) : 0;
      const statusColor = j.status === 'completed' ? '#1a7a4a' : j.status === 'failed' ? '#c0392b' : '#9a6800';
      const statusBg = j.status === 'completed' ? '#e8f5ee' : j.status === 'failed' ? '#fdf0f0' : '#fff8e1';
      return \`<div style="background:#fff;border:1px solid #e0dfd8;border-radius:10px;padding:14px 16px;margin-bottom:10px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <div style="font-size:13px;font-weight:500">\${j.filename||'Unknown file'}</div>
          <span style="font-size:11px;padding:2px 8px;border-radius:4px;background:\${statusBg};color:\${statusColor};font-weight:600">\${j.status}</span>
        </div>
        \${j.status === 'running' ? \`
        <div style="background:#f0efe9;border-radius:4px;height:6px;margin-bottom:6px">
          <div style="background:#1a1a1a;height:6px;border-radius:4px;width:\${pct}%;transition:width .5s"></div>
        </div>
        <div style="font-size:12px;color:#888">\${j.rows_processed.toLocaleString()} / \${j.total_rows.toLocaleString()} rows (\${pct}%)</div>
        \` : \`
        <div style="font-size:12px;color:#888">
          \${j.rows_created.toLocaleString()} new · \${j.rows_updated.toLocaleString()} updated · \${j.rows_errored} errors
          \${j.completed_at ? ' · ' + new Date(j.completed_at).toLocaleString() : ''}
        </div>
        \`}
        \${j.status === 'failed' ? \`<div style="font-size:12px;color:#c0392b;margin-top:4px">\${j.error_message||''}</div>\` : ''}
      </div>\`;
    }
    const dz = document.getElementById('drop-zone');
    const fi = document.getElementById('file-input');
    dz.addEventListener('click', () => fi.click());
    dz.addEventListener('dragover', e => { e.preventDefault(); dz.style.borderColor='#888'; });
    dz.addEventListener('dragleave', () => dz.style.borderColor='');
    dz.addEventListener('drop', e => { e.preventDefault(); dz.style.borderColor=''; if(e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });
    fi.addEventListener('change', e => { if(e.target.files[0]) handleFile(e.target.files[0]); });

    async function handleFile(file) {
      if (!file.name.endsWith('.csv')) { showError('CSV files only.'); return; }
      document.getElementById('upload-area').style.display = 'none';
      document.getElementById('uploading-state').style.display = 'block';
      const form = new FormData();
      form.append('csvfile', file);
      const xhr = new XMLHttpRequest();
      xhr.upload.addEventListener('progress', e => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100);
          document.getElementById('upload-progress-text').textContent = pct + '% uploaded (' + Math.round(e.loaded/1024/1024) + 'MB of ' + Math.round(e.total/1024/1024) + 'MB)';
        }
      });
      xhr.onload = function() {
        try {
          const data = JSON.parse(xhr.responseText);
          if (data.error) { showError(data.error); return; }
          document.getElementById('uploading-state').style.display = 'none';
          document.getElementById('upload-area').style.display = 'block';
          checkJobs();
        } catch(e) { showError('Upload failed: ' + e.message); }
      };
      xhr.onerror = () => showError('Upload failed. Check your connection.');
      xhr.open('POST', '/import/bulk/start');
      xhr.send(form);
    }
    function showError(msg) {
      document.getElementById('uploading-state').style.display = 'none';
      document.getElementById('upload-area').style.display = 'block';
      const el = document.getElementById('error-state');
      el.textContent = msg;
      el.style.display = 'block';
    }
    </script>
  `, 'upload'));
});

// ── START: Stage to disk, create job, fire background processor ──────────────
router.post('/start', requireAuth, upload.single('csvfile'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    await ensureJobsTable();

    // Peek at header to validate format before committing to a job.
    // Strip the UTF-8 BOM via the shared helper so Excel-saved CSVs don't
    // report "Property address" missing because the first header has an
    // invisible U+FEFF prefix.
    const head = stripBom(req.file.buffer.toString('utf8', 0, Math.min(8192, req.file.buffer.length)));
    const firstPass = Papa.parse(head, { header: true, skipEmptyLines: true, preview: 1 });
    // 2026-04-21 Gap #6 parity: surface malformed-CSV errors before we go
    // any further. A fatal parse error at the head (unmatched quote,
    // delimiter confusion) means every downstream step — header validation,
    // row counting, streamed commit — is operating on garbage.
    const headFatalErr = (firstPass.errors || []).find(e => e.type === 'Quotes' || e.type === 'Delimiter');
    if (headFatalErr) {
      const rowHint = (headFatalErr.row != null) ? ` near row ${headFatalErr.row + 1}` : '';
      return res.status(400).json({
        error: `CSV is malformed${rowHint}: ${headFatalErr.message}. This usually means an unmatched quote or the file isn't comma-separated. Open it in a text editor, fix the bad row, and re-upload.`
      });
    }
    const headers = firstPass.meta.fields || [];
    if (!headers.includes('Property address') && !headers.includes('First Name')) {
      return res.status(400).json({ error: 'This doesn\'t look like a REISift export. Expected columns: First Name, Property address, etc.' });
    }

    // Stream-count total rows without loading CSV twice in memory. We DO still
    // hold the full buffer once while writing to disk; after that, the in-
    // memory copy is eligible for GC.
    let totalRows = 0;
    let mismatchCount = 0;
    const countPass = Papa.parse(bufferToCsvText(req.file.buffer), {
      header: true,
      skipEmptyLines: true,
      step: (result) => {
        totalRows++;
        // Count per-row errors during the count pass so we can warn the user
        // up front how many rows will get dropped/misaligned. Non-fatal —
        // the commit step logs individual rows.
        if (result.errors && result.errors.length) mismatchCount += result.errors.length;
      }
    });
    if (mismatchCount > 0) {
      console.warn(`[bulk-import/parse] ${mismatchCount} rows had field-count mismatches (rows may have misaligned values)`);
    }

    // Write CSV to a temp file so the closure for processImport doesn't keep
    // the whole string pinned in RAM for the job's lifetime.
    const tmpName = `loki-bulk-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.csv`;
    const tmpPath = path.join(os.tmpdir(), tmpName);
    fs.writeFileSync(tmpPath, req.file.buffer);

    const jobRes = await query(
      `INSERT INTO bulk_import_jobs (filename, source, status, total_rows) VALUES ($1, 'reisift', 'running', $2) RETURNING id`,
      [req.file.originalname, totalRows]
    );
    const jobId = jobRes.rows[0].id;

    res.json({ jobId, totalRows, message: 'Import started' });

    setImmediate(() => processImport(jobId, tmpPath, req.file.originalname));
  } catch(e) {
    console.error('[bulk/start] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── BACKGROUND PROCESSOR (UNNEST batches) ────────────────────────────────────
async function processImport(jobId, csvPath, filename) {
  let rowsProcessed = 0, rowsCreated = 0, rowsUpdated = 0, rowsErrored = 0;
  const BATCH = 500;
  let batch = [];

  await primeMarketCache();

  async function processBatch(raw) {
    // 1. Map rows; drop any with invalid state.
    const mapped = [];
    for (const row of raw) {
      try {
        const m = mapReisiftRow(row);
        if (!m.property.street || !m.property.city || !m.property.state_code) {
          rowsErrored++;
          continue;
        }
        mapped.push(m);
      } catch (e) { rowsErrored++; }
    }
    if (mapped.length === 0) {
      rowsProcessed += raw.length;
      return;
    }

    // 2. Ensure markets for all unique states in this batch — one query.
    const uniqueStates = [...new Set(mapped.map(m => m.property.state_code))]
      .filter(s => !marketCache[s]);
    if (uniqueStates.length > 0) {
      const mr = await query(
        `INSERT INTO markets (name, state_code, state_name)
         SELECT code || ' Market', code, code
           FROM UNNEST($1::text[]) AS t(code)
         ON CONFLICT (state_code) DO UPDATE SET name = EXCLUDED.name
         RETURNING id, state_code`,
        [uniqueStates]
      );
      for (const r of mr.rows) marketCache[r.state_code] = r.id;
    }

    // 3. De-duplicate properties within this batch by (street,city,state,zip).
    //    Keeps the LAST occurrence — consistent with the old "last row wins".
    const propKey = (p) => `${p.street.toLowerCase()}|${p.city.toLowerCase()}|${p.state_code}|${p.zip_code}`;
    const propMap = new Map();
    for (const m of mapped) propMap.set(propKey(m.property), m);
    const deduped = Array.from(propMap.values());

    // 4. Bulk UPSERT properties via UNNEST.
    const pr = await query(`
      INSERT INTO properties (
        street, city, state_code, zip_code, county, market_id, source,
        vacant, bedrooms, bathrooms, sqft, year_built, lot_size,
        estimated_value, last_sale_price, last_sale_date,
        property_status, first_seen_at
      )
      SELECT street, city, state_code, zip_code, county, market_id, source,
             vacant, bedrooms, bathrooms, sqft, year_built, lot_size,
             estimated_value, last_sale_price, last_sale_date,
             property_status, NOW()
        FROM UNNEST(
          $1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::int[], $7::text[],
          $8::bool[], $9::int[], $10::numeric[], $11::int[], $12::int[], $13::int[],
          $14::numeric[], $15::numeric[], $16::date[],
          $17::text[]
        ) AS t(street, city, state_code, zip_code, county, market_id, source,
               vacant, bedrooms, bathrooms, sqft, year_built, lot_size,
               estimated_value, last_sale_price, last_sale_date,
               property_status)
      ON CONFLICT (street, city, state_code, zip_code) DO UPDATE SET
        county          = COALESCE(NULLIF(EXCLUDED.county,''),        properties.county),
        source          = COALESCE(NULLIF(EXCLUDED.source,''),        properties.source),
        vacant          = COALESCE(EXCLUDED.vacant,                   properties.vacant),
        bedrooms        = COALESCE(EXCLUDED.bedrooms,                 properties.bedrooms),
        bathrooms       = COALESCE(EXCLUDED.bathrooms,                properties.bathrooms),
        sqft            = COALESCE(EXCLUDED.sqft,                     properties.sqft),
        year_built      = COALESCE(EXCLUDED.year_built,               properties.year_built),
        lot_size        = COALESCE(EXCLUDED.lot_size,                 properties.lot_size),
        estimated_value = COALESCE(EXCLUDED.estimated_value,          properties.estimated_value),
        last_sale_price = COALESCE(EXCLUDED.last_sale_price,          properties.last_sale_price),
        last_sale_date  = COALESCE(EXCLUDED.last_sale_date,           properties.last_sale_date),
        property_status = COALESCE(NULLIF(EXCLUDED.property_status,''), properties.property_status),
        updated_at      = NOW()
      RETURNING id, street, city, state_code, zip_code, (xmax = 0) AS inserted
    `, [
      deduped.map(m => m.property.street),
      deduped.map(m => m.property.city),
      deduped.map(m => m.property.state_code),
      deduped.map(m => m.property.zip_code || ''),
      deduped.map(m => m.property.county || ''),
      deduped.map(m => marketCache[m.property.state_code] || null),
      deduped.map(m => m.property.source),
      deduped.map(m => m.property.vacant),
      deduped.map(m => m.property.bedrooms),
      deduped.map(m => m.property.bathrooms),
      deduped.map(m => m.property.sqft),
      deduped.map(m => m.property.year_built),
      deduped.map(m => m.property.lot_size),
      deduped.map(m => m.property.estimated_value),
      deduped.map(m => m.property.last_sale_price),
      deduped.map(m => m.property.last_sale_date),
      deduped.map(m => m.property.property_status || null),
    ]);

    // Build property_id lookup
    const propIdByKey = new Map();
    for (const r of pr.rows) {
      const k = `${r.street.toLowerCase()}|${r.city.toLowerCase()}|${r.state_code}|${r.zip_code}`;
      propIdByKey.set(k, r.id);
      if (r.inserted) rowsCreated++; else rowsUpdated++;
    }
    const propIds = pr.rows.map(r => r.id);

    // 5. Pre-load existing primary contact_id for each property in this batch.
    const existingPC = new Map();
    if (propIds.length > 0) {
      const pcRes = await query(
        `SELECT property_id, contact_id FROM property_contacts
          WHERE property_id = ANY($1::int[]) AND primary_contact = true`,
        [propIds]
      );
      for (const r of pcRes.rows) existingPC.set(r.property_id, r.contact_id);
    }

    // 6. Split into "update existing contact" vs "create new contact + link".
    const updateContactIds = [], updateFirsts = [], updateLasts = [];
    const updateMaddr = [], updateMcity = [], updateMstate = [], updateMzip = [];
    const updateEmail1 = [], updateEmail2 = [];
    const newContactProps  = [], newContactFirsts = [], newContactLasts = [];
    const newContactMaddr  = [], newContactMcity  = [], newContactMstate = [], newContactMzip = [];
    const newContactEmail1 = [], newContactEmail2 = [];

    const contactIdByProp = new Map();
    const mappedByKey = new Map();
    for (const m of deduped) mappedByKey.set(propKey(m.property), m);

    for (const [k, propId] of propIdByKey) {
      const m = mappedByKey.get(k);
      if (!m) continue;
      const c = m.contact;
      if (!c.first_name && !c.last_name) continue;

      if (existingPC.has(propId)) {
        const cid = existingPC.get(propId);
        contactIdByProp.set(propId, cid);
        updateContactIds.push(cid);
        updateFirsts.push(c.first_name || '');
        updateLasts.push(c.last_name || '');
        updateMaddr.push(c.mailing_address || '');
        updateMcity.push(c.mailing_city || '');
        updateMstate.push(c.mailing_state || '');
        updateMzip.push(c.mailing_zip || '');
        updateEmail1.push(c.email_1 || '');
        updateEmail2.push(c.email_2 || '');
      } else {
        newContactProps.push(propId);
        newContactFirsts.push(c.first_name || '');
        newContactLasts.push(c.last_name || '');
        newContactMaddr.push(c.mailing_address || '');
        newContactMcity.push(c.mailing_city || '');
        newContactMstate.push(c.mailing_state || '');
        newContactMzip.push(c.mailing_zip || '');
        newContactEmail1.push(c.email_1 || '');
        newContactEmail2.push(c.email_2 || '');
      }
    }

    // 7a. Bulk UPDATE existing contacts (COALESCE preserves non-blank prior values).
    if (updateContactIds.length > 0) {
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
      `, [updateContactIds, updateFirsts, updateLasts, updateMaddr, updateMcity,
          updateMstate, updateMzip, updateEmail1, updateEmail2]);
    }

    // 7b. Bulk INSERT new contacts + link via property_contacts.
    if (newContactProps.length > 0) {
      const nr = await query(`
        INSERT INTO contacts (first_name, last_name, mailing_address, mailing_city,
                              mailing_state, mailing_zip, email_1, email_2)
        SELECT * FROM UNNEST(
          $1::text[], $2::text[], $3::text[], $4::text[],
          $5::text[], $6::text[], $7::text[], $8::text[]
        ) AS t(first_name, last_name, mailing_address, mailing_city,
               mailing_state, mailing_zip, email_1, email_2)
        RETURNING id
      `, [newContactFirsts, newContactLasts, newContactMaddr, newContactMcity,
          newContactMstate, newContactMzip, newContactEmail1, newContactEmail2]);
      const newIds = nr.rows.map(r => r.id);

      await query(`
        INSERT INTO property_contacts (property_id, contact_id, primary_contact)
        SELECT property_id, contact_id, true
          FROM UNNEST($1::int[], $2::int[]) AS t(property_id, contact_id)
        ON CONFLICT DO NOTHING
      `, [newContactProps, newIds]);

      for (let i = 0; i < newContactProps.length; i++) {
        contactIdByProp.set(newContactProps[i], newIds[i]);
      }
    }

    // 8. Bulk UPSERT phones. One row per (contact_id, phone_number).
    //
    // 2026-04-20 pass 11: Dedup by (contact_id, phone_number) before UNNEST.
    // Same bug class as campaigns.js — county-sourced CSVs commonly repeat
    // the same phone across multiple slots for one property, and property
    // merges can make two properties share a contact_id so their phones
    // collide across the batch. ON CONFLICT DO UPDATE crashes with 21000
    // when the same key appears twice. First occurrence wins (lowest
    // phone_index = canonical slot), most-informative status preserved.
    const phoneBucket = new Map();   // key = `${cid}|${phone_number}`
    let phoneDupesCollapsed = 0;
    for (const [k, propId] of propIdByKey) {
      const m = mappedByKey.get(k);
      if (!m) continue;
      const cid = contactIdByProp.get(propId);
      if (!cid) continue;
      for (const ph of m.phones) {
        const key = `${cid}|${ph.phone_number}`;
        const existing = phoneBucket.get(key);
        if (existing) {
          phoneDupesCollapsed++;
          // Prefer the entry whose phone_status is something other than
          // 'unknown' — don't let a later blank-status duplicate erase a
          // real disposition. If existing is already informative, keep it.
          const existingInformative = existing.phone_status && existing.phone_status !== 'unknown';
          const incomingInformative = ph.phone_status && ph.phone_status !== 'unknown';
          if (!existingInformative && incomingInformative) {
            phoneBucket.set(key, {
              contact_id: cid,
              phone_number: ph.phone_number,
              phone_index: existing.phone_index,         // keep lowest index
              phone_status: ph.phone_status,
              phone_tag: ph.phone_tag || existing.phone_tag,
            });
          }
          continue;
        }
        phoneBucket.set(key, {
          contact_id: cid,
          phone_number: ph.phone_number,
          phone_index: ph.phone_index,
          phone_status: ph.phone_status,
          phone_tag: ph.phone_tag || '',
        });
      }
    }

    const phContactIds = [], phNumbers = [], phStatuses = [], phTags = [], phIdx = [];
    for (const p of phoneBucket.values()) {
      phContactIds.push(p.contact_id);
      phNumbers.push(p.phone_number);
      phStatuses.push(p.phone_status);
      phTags.push(p.phone_tag || '');
      phIdx.push(p.phone_index);
    }

    if (phContactIds.length > 0) {
      await query(`
        INSERT INTO phones (contact_id, phone_number, phone_index, phone_status, phone_tag)
        SELECT * FROM UNNEST(
          $1::int[], $2::text[], $3::int[], $4::text[], $5::text[]
        ) AS t(contact_id, phone_number, phone_index, phone_status, phone_tag)
        ON CONFLICT (contact_id, phone_number) DO UPDATE SET
          phone_status = CASE WHEN EXCLUDED.phone_status != 'unknown'
                              THEN EXCLUDED.phone_status
                              ELSE phones.phone_status END,
          phone_tag    = COALESCE(NULLIF(EXCLUDED.phone_tag,''), phones.phone_tag),
          updated_at   = NOW()
      `, [phContactIds, phNumbers, phIdx, phStatuses, phTags]);
    }

    if (phoneDupesCollapsed > 0) {
      console.log(`[bulk-import] collapsed ${phoneDupesCollapsed} duplicate phone entries in batch`);
    }

    rowsProcessed += raw.length;

    // Persist progress every batch so polling shows live updates.
    await query(
      `UPDATE bulk_import_jobs SET rows_processed=$1, rows_created=$2, rows_updated=$3, rows_errored=$4 WHERE id=$5`,
      [rowsProcessed, rowsCreated, rowsUpdated, rowsErrored, jobId]
    );
  }

  try {
    // Stream from disk so we don't hold the CSV in memory.
    const stream = fs.createReadStream(csvPath, { encoding: 'utf8' });
    await new Promise((resolve, reject) => {
      Papa.parse(stream, {
        header: true,
        skipEmptyLines: true,
        step: async (result, parser) => {
          batch.push(result.data);
          if (batch.length >= BATCH) {
            parser.pause();
            const toProcess = batch.splice(0, BATCH);
            try { await processBatch(toProcess); }
            catch (e) { console.error('[bulk] batch error:', e.message); }
            parser.resume();
          }
        },
        complete: async () => {
          if (batch.length > 0) {
            try { await processBatch(batch); }
            catch (e) { console.error('[bulk] final batch error:', e.message); }
          }
          resolve();
        },
        error: reject
      });
    });

    await query(
      `UPDATE bulk_import_jobs SET status='completed', rows_processed=$1, rows_created=$2, rows_updated=$3, rows_errored=$4, completed_at=NOW() WHERE id=$5`,
      [rowsProcessed, rowsCreated, rowsUpdated, rowsErrored, jobId]
    );
    console.log(`[bulk] Job ${jobId} complete — ${rowsCreated} created, ${rowsUpdated} updated, ${rowsErrored} errors`);

    // 2026-04-18 audit fix #35: refresh owner_portfolio_counts MV after every
    // import. The MV powers the Min/Max Owned filter (fix #8). Previously it
    // was created once at boot and never refreshed, so the owned-count filter
    // returned increasingly stale numbers as new properties arrived.
    // Non-fatal — log on failure but don't fail the import.
    try {
      const t = Date.now();
      await refreshOwnerPortfolioMv();
      console.log(`[bulk] refreshed owner_portfolio_counts MV (${Date.now() - t}ms)`);
    } catch (e) {
      console.error(`[bulk] MV refresh failed (non-fatal):`, e.message);
    }
  } catch(e) {
    console.error(`[bulk] Job ${jobId} failed:`, e.message);
    await query(
      `UPDATE bulk_import_jobs SET status='failed', error_message=$1, completed_at=NOW() WHERE id=$2`,
      [e.message, jobId]
    );
  } finally {
    // Clean up the staged CSV so /tmp doesn't fill up.
    try { fs.unlinkSync(csvPath); } catch (e) { /* already gone */ }
  }
}

// ── STATUS: Poll job progress ─────────────────────────────────────────────────
router.get('/status/:jobId', requireAuth, async (req, res) => {
  try {
    const r = await query(`SELECT * FROM bulk_import_jobs WHERE id=$1`, [req.params.jobId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Job not found' });
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── JOBS LIST ────────────────────────────────────────────────────────────────
router.get('/jobs', requireAuth, async (req, res) => {
  try {
    await ensureJobsTable();
    const r = await query(`SELECT * FROM bulk_import_jobs ORDER BY started_at DESC LIMIT 10`);
    res.json(r.rows);
  } catch(e) { res.json([]); }
});

module.exports = router;
