const express = require('express');
const router = express.Router();
const multer = require('multer');
const Papa = require('papaparse');
const { query } = require('../db');
const { shell } = require('../shared-shell');

// Large file support — 600MB limit
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 600 * 1024 * 1024 }
});

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.redirect('/login');
}

// ── REISift column mapping ─────────────────────────────────────────────────────
function mapReisiftRow(row) {
  const get = (key) => (row[key] || '').toString().trim();
  const toNum = (v) => { const n = parseFloat(String(v).replace(/[$,%]/g,'')); return isNaN(n) ? null : n; };
  const toInt = (v) => { const n = parseInt(v); return isNaN(n) ? null : n; };
  const toDate = (v) => { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString().split('T')[0]; };
  const toBool = (v) => { const s = (v||'').toLowerCase(); return s==='true'||s==='yes'||s==='1' ? true : s==='false'||s==='no'||s==='0' ? false : null; };
  const cleanPhone = (v) => String(v||'').replace(/\D/g,'');
  const mapStatus = (v) => {
    const s = (v||'').toLowerCase();
    if (s==='correct') return 'correct';
    if (s==='wrong') return 'wrong';
    if (s==='do not call'||s==='dnc') return 'do_not_call';
    return 'unknown';
  };

  // Property
  const property = {
    street:         get('Property address'),
    city:           get('Property city'),
    state_code:     get('Property state').toUpperCase().slice(0,2),
    zip_code:       get('Property zip5') || get('Property zip').slice(0,5),
    county:         get('Property county'),
    vacant:         toBool(get('Property vacant')),
    property_type:  null,
    bedrooms:       toInt(get('Bedrooms')),
    bathrooms:      toNum(get('Bathrooms')),
    sqft:           toInt(get('Sqft')),
    year_built:     toInt(get('Year')),
    lot_size:       toInt(get('Lot size')),
    estimated_value: toNum(get('Estimated value')),
    last_sale_price: toNum(get('Last sale price')),
    last_sale_date:  toDate(get('Last sold')),
    property_status: get('Status') || null,
    source:          'REISift',
  };

  // Owner / contact
  const contact = {
    first_name:      get('First Name'),
    last_name:       get('Last Name'),
    mailing_address: get('Mailing address'),
    mailing_city:    get('Mailing city'),
    mailing_state:   get('Mailing state').toUpperCase().slice(0,2),
    mailing_zip:     get('Mailing zip5') || get('Mailing zip').slice(0,5),
    email_1:         get('Email 1') || null,
    email_2:         get('Email 2') || null,
  };

  // Phones 1-10 (cap at 10, REISift has 15)
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

  return { property, contact, phones, lists: [] };
}

// ── DB: Init bulk import jobs table ───────────────────────────────────────────
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

// ── STEP 1: Upload page ────────────────────────────────────────────────────────
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

      <!-- Active jobs -->
      <div id="active-jobs" style="margin-top:1.5rem"></div>
    </div>

    <script>
    // Check for active jobs on load
    checkJobs();

    async function checkJobs() {
      try {
        const res = await fetch('/import/bulk/jobs');
        const jobs = await res.json();
        if (!jobs.length) return;
        const wrap = document.getElementById('active-jobs');
        wrap.innerHTML = '<div style="font-size:13px;font-weight:600;margin-bottom:10px">Recent Imports</div>' +
          jobs.map(j => jobCard(j)).join('');
        // Auto-poll running jobs
        if (jobs.some(j => j.status === 'running')) {
          setTimeout(checkJobs, 2000);
        }
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

    // File handling
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

      // Track upload progress
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
          // Job started — switch to polling
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

// ── START: Accept upload, create job, process in background ───────────────────
router.post('/start', requireAuth, upload.single('csvfile'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    await ensureJobsTable();

    // Parse just the header + count rows (fast pass)
    const csvText = req.file.buffer.toString('utf8');
    const firstPass = Papa.parse(csvText, { header: true, skipEmptyLines: true, preview: 1 });
    const headers = firstPass.meta.fields || [];

    // Validate it's a REISift export
    if (!headers.includes('Property address') && !headers.includes('First Name')) {
      return res.status(400).json({ error: 'This doesn\'t look like a REISift export. Expected columns: First Name, Property address, etc.' });
    }

    // Count total rows
    let totalRows = 0;
    Papa.parse(csvText, { header: true, skipEmptyLines: true, step: () => { totalRows++; } });

    // Create job record
    const jobRes = await query(
      `INSERT INTO bulk_import_jobs (filename, source, status, total_rows) VALUES ($1, 'reisift', 'running', $2) RETURNING id`,
      [req.file.originalname, totalRows]
    );
    const jobId = jobRes.rows[0].id;

    // Respond immediately — job ID returned to browser
    res.json({ jobId, totalRows, message: 'Import started' });

    // Process in background — non-blocking
    setImmediate(() => processImport(jobId, csvText, req.file.originalname));

  } catch(e) {
    console.error('[bulk/start] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── BACKGROUND PROCESSOR ──────────────────────────────────────────────────────
async function processImport(jobId, csvText, filename) {
  let rowsProcessed = 0, rowsCreated = 0, rowsUpdated = 0, rowsErrored = 0;
  const BATCH = 500;
  let batch = [];
  const marketCache = {}; // state_code → market_id cache

  // Pre-load markets
  try {
    const mktRes = await query(`SELECT id, state_code FROM markets`);
    mktRes.rows.forEach(m => { marketCache[m.state_code] = m.id; });
  } catch(e) {}

  async function processBatch(rows) {
    for (const row of rows) {
      try {
        const { property, contact, phones, lists } = mapReisiftRow(row);
        if (!property.street || !property.city || !property.state_code) { rowsErrored++; continue; }

        // Ensure market
        if (property.state_code && !marketCache[property.state_code]) {
          try {
            const mr = await query(
              `INSERT INTO markets (name, state_code, state_name) VALUES ($1,$2,$2) ON CONFLICT (state_code) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
              [`${property.state_code} Market`, property.state_code]
            );
            marketCache[property.state_code] = mr.rows[0].id;
          } catch(e) {}
        }

        // Upsert property
        const pr = await query(`
          INSERT INTO properties (
            street, city, state_code, zip_code, county, market_id, source,
            vacant, bedrooms, bathrooms, sqft, year_built, lot_size,
            estimated_value, last_sale_price, last_sale_date,
            property_status, first_seen_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())
          ON CONFLICT (street, city, state_code, zip_code) DO UPDATE SET
            county          = COALESCE(NULLIF($5,''), properties.county),
            source          = COALESCE(NULLIF($7,''), properties.source),
            vacant          = COALESCE($8, properties.vacant),
            bedrooms        = COALESCE($9, properties.bedrooms),
            bathrooms       = COALESCE($10, properties.bathrooms),
            sqft            = COALESCE($11, properties.sqft),
            year_built      = COALESCE($12, properties.year_built),
            lot_size        = COALESCE($13, properties.lot_size),
            estimated_value = COALESCE($14, properties.estimated_value),
            last_sale_price = COALESCE($15, properties.last_sale_price),
            last_sale_date  = COALESCE($16, properties.last_sale_date),
            property_status = COALESCE(NULLIF($17,''), properties.property_status),
            updated_at      = NOW()
          RETURNING id, xmax
        `, [
          property.street, property.city, property.state_code,
          property.zip_code || '', property.county || '',
          marketCache[property.state_code] || null, property.source,
          property.vacant, property.bedrooms, property.bathrooms,
          property.sqft, property.year_built, property.lot_size,
          property.estimated_value, property.last_sale_price,
          property.last_sale_date, property.property_status || null
        ]);

        const propertyId = pr.rows[0].id;
        const wasInsert = pr.rows[0].xmax === '0';
        if (wasInsert) rowsCreated++; else rowsUpdated++;

        // Upsert contact
        if (contact.first_name || contact.last_name) {
          let contactId = null;
          const existPC = await query(
            `SELECT contact_id FROM property_contacts WHERE property_id=$1 AND primary_contact=true LIMIT 1`,
            [propertyId]
          );
          if (existPC.rows.length > 0) {
            contactId = existPC.rows[0].contact_id;
            await query(`UPDATE contacts SET
              first_name = COALESCE(NULLIF($1,''), first_name),
              last_name  = COALESCE(NULLIF($2,''), last_name),
              mailing_address = COALESCE(NULLIF($3,''), mailing_address),
              mailing_city    = COALESCE(NULLIF($4,''), mailing_city),
              mailing_state   = COALESCE(NULLIF($5,''), mailing_state),
              mailing_zip     = COALESCE(NULLIF($6,''), mailing_zip),
              email_1 = COALESCE(NULLIF($7,''), email_1),
              email_2 = COALESCE(NULLIF($8,''), email_2),
              updated_at = NOW() WHERE id=$9`,
              [contact.first_name, contact.last_name, contact.mailing_address,
               contact.mailing_city, contact.mailing_state, contact.mailing_zip,
               contact.email_1 || '', contact.email_2 || '', contactId]);
          } else {
            const cr = await query(
              `INSERT INTO contacts (first_name,last_name,mailing_address,mailing_city,mailing_state,mailing_zip,email_1,email_2)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
              [contact.first_name, contact.last_name, contact.mailing_address,
               contact.mailing_city, contact.mailing_state, contact.mailing_zip,
               contact.email_1, contact.email_2]
            );
            contactId = cr.rows[0].id;
            await query(
              `INSERT INTO property_contacts (property_id,contact_id,primary_contact) VALUES ($1,$2,true) ON CONFLICT DO NOTHING`,
              [propertyId, contactId]
            );
          }

          // Upsert phones
          for (const ph of phones) {
            await query(`
              INSERT INTO phones (contact_id, phone_number, phone_index, phone_status, phone_tag)
              VALUES ($1,$2,$3,$4,$5)
              ON CONFLICT (contact_id, phone_number) DO UPDATE SET
                phone_status = CASE WHEN $4 != 'unknown' THEN $4 ELSE phones.phone_status END,
                phone_tag    = COALESCE(NULLIF($5,''), phones.phone_tag),
                updated_at   = NOW()`,
              [contactId, ph.phone_number, ph.phone_index, ph.phone_status, ph.phone_tag || '']
            );
          }
        }



      } catch(rowErr) {
        rowsErrored++;
      }
      rowsProcessed++;
    }

    // Update job progress in DB
    await query(
      `UPDATE bulk_import_jobs SET rows_processed=$1, rows_created=$2, rows_updated=$3, rows_errored=$4 WHERE id=$5`,
      [rowsProcessed, rowsCreated, rowsUpdated, rowsErrored, jobId]
    );
  }

  try {
    // Stream parse — process in batches of 500
    await new Promise((resolve, reject) => {
      Papa.parse(csvText, {
        header: true,
        skipEmptyLines: true,
        step: async (result, parser) => {
          batch.push(result.data);
          if (batch.length >= BATCH) {
            parser.pause();
            const toProcess = batch.splice(0, BATCH);
            await processBatch(toProcess).catch(e => console.error('[bulk] batch error:', e.message));
            parser.resume();
          }
        },
        complete: async () => {
          if (batch.length > 0) {
            await processBatch(batch).catch(e => console.error('[bulk] final batch error:', e.message));
          }
          resolve();
        },
        error: reject
      });
    });

    // Mark complete
    await query(
      `UPDATE bulk_import_jobs SET status='completed', rows_processed=$1, rows_created=$2, rows_updated=$3, rows_errored=$4, completed_at=NOW() WHERE id=$5`,
      [rowsProcessed, rowsCreated, rowsUpdated, rowsErrored, jobId]
    );
    console.log(`[bulk] Job ${jobId} complete — ${rowsCreated} created, ${rowsUpdated} updated, ${rowsErrored} errors`);

  } catch(e) {
    console.error(`[bulk] Job ${jobId} failed:`, e.message);
    await query(
      `UPDATE bulk_import_jobs SET status='failed', error_message=$1, completed_at=NOW() WHERE id=$2`,
      [e.message, jobId]
    );
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

// ── JOBS LIST: Recent jobs ─────────────────────────────────────────────────────
router.get('/jobs', requireAuth, async (req, res) => {
  try {
    await ensureJobsTable();
    const r = await query(`SELECT * FROM bulk_import_jobs ORDER BY started_at DESC LIMIT 10`);
    res.json(r.rows);
  } catch(e) { res.json([]); }
});

module.exports = router;
