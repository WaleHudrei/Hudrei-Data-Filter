const express = require('express');
const session = require('express-session');
const multer = require('multer');
const Papa = require('papaparse');
const path = require('path');
const fs = require('fs');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ── Config ──────────────────────────────────────────────────────────────────
const APP_USERNAME = process.env.APP_USERNAME || 'hudrei';
const APP_PASSWORD = process.env.APP_PASSWORD || 'changeme123';
const SESSION_SECRET = process.env.SESSION_SECRET || 'hudrei-secret-key-2026';
const PORT = process.env.PORT || 3000;

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 8 * 60 * 60 * 1000 } // 8hr session
}));
app.use(express.static(path.join(__dirname, '../public')));

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.redirect('/login');
}

// ── Filtration Logic ─────────────────────────────────────────────────────────
const COL = {
  phone:    'Phone',
  dispo:    'Log Type',
  listname: 'Original lead file',
  date:     'Log Time',
  fname:    'First Name',
  lname:    'Last Name',
  addr:     'Address',
  city:     'City',
  state:    'State',
  zip:      'Zip Code',
  notes:    'Call Notes',
  agent:    'Agent name',
};

function normDispo(v) {
  const s = (v || '').toLowerCase().trim();
  if (s.includes('transfer') || s === 'lead') return 'transfer';
  if (s === 'not interested' || s.includes('not interested') || s === 'ni') return 'not_interested';
  if (s.includes('do not call') || s === 'dnc') return 'do_not_call';
  if (s.includes('spanish')) return 'spanish_speaker';
  if (s.includes('wrong')) return 'wrong_number';
  if (s === 'voicemail' || s.includes('voicemail') || s === 'vm') return 'voicemail';
  if (s.includes('hung up') || s.includes('hang up') || s.includes('hangup')) return 'hung_up';
  if (s.includes('dead')) return 'dead_call';
  if (s.includes('not available') || s === 'na' || s.includes('not avail')) return 'not_available';
  if (s.includes('callback') || s.includes('call back')) return 'callback';
  return 'other';
}

function phoneStatus(d) {
  return { transfer: 'Correct', not_interested: 'Correct', do_not_call: 'Correct', spanish_speaker: 'Correct', wrong_number: 'Wrong', callback: 'Correct' }[d] || '';
}

function mktResult(d, listName) {
  if (d === 'transfer') return 'Lead';
  if (d === 'not_interested') return `Not Interested — ${listName}`;
  if (d === 'do_not_call') return `Not Interested — ${listName}`;
  if (d === 'spanish_speaker') return 'Spanish Speaker';
  return '';
}

function phoneTag(d, count, listName) {
  const MAP = { voicemail: 'Voicemail', hung_up: 'Hung Up', dead_call: 'Dead Call', not_available: 'Not Available' };
  if (d === 'do_not_call') return 'Do Not Call';
  if (MAP[d]) return count > 3 ? `${MAP[d]} — ${listName}` : '';
  if (d === 'not_interested') return count >= 3 ? `Not Interested — ${listName}` : '';
  return '';
}

function stripTime(val) {
  if (!val) return '';
  const s = String(val).trim();
  const m = s.match(/^(\d{2}\/\d{2}\/\d{4})/);
  if (m) { const p = m[0].split('/'); return `${p[2]}-${p[0]}-${p[1]}`; }
  const m2 = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m2) return m2[0];
  const d = new Date(s); if (!isNaN(d)) return d.toISOString().split('T')[0];
  return s.split(' ')[0];
}

function memKey(list, phone) {
  return list.toLowerCase().trim() + '||' + String(phone).replace(/\D/g, '');
}

function processCSV(csvText, memory) {
  const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
  const rows = parsed.data;
  if (!rows.length) throw new Error('File is empty or could not be parsed.');

  // Step 1: count appearances per phone+list in this file
  const fileCount = {};
  rows.forEach(r => {
    const phone = String(r[COL.phone] || '').replace(/\D/g, '');
    const list = (r[COL.listname] || 'Unknown List').trim();
    if (!phone || phone === '0') return;
    const k = memKey(list, phone);
    fileCount[k] = (fileCount[k] || 0) + 1;
  });

  const cleanRows = [], filteredRows = [];
  let memCaught = 0;
  const listsSeen = {};
  const processedKeys = {};

  rows.forEach(r => {
    const phone = String(r[COL.phone] || '').replace(/\D/g, '');
    const list = (r[COL.listname] || 'Unknown List').trim();
    const dispoRaw = r[COL.dispo] || '';
    const dispo = normDispo(dispoRaw);
    const dateRaw = r[COL.date] || '';

    if (!phone || phone === '0') return;
    const mkey = memKey(list, phone);
    if (processedKeys[mkey]) return;
    processedKeys[mkey] = true;

    const countInFile = fileCount[mkey] || 1;
    const prevCount = memory[mkey] ? memory[mkey].count : 0;
    const cumCount = prevCount + countInFile;

    memory[mkey] = { count: cumCount, lastDispo: dispoRaw };

    if (!listsSeen[list]) listsSeen[list] = { keep: 0, rem: 0, dispositions: {} };
    listsSeen[list].dispositions[dispo] = (listsSeen[list].dispositions[dispo] || 0) + 1;

    const tag = phoneTag(dispo, cumCount, list);
    const status = phoneStatus(dispo);
    const mkt = mktResult(dispo, list);
    const dateClean = stripTime(dateRaw);

    const ALWAYS_REM = new Set(['transfer', 'do_not_call', 'wrong_number', 'spanish_speaker']);
    let action = 'keep', byMem = false;
    if (ALWAYS_REM.has(dispo)) {
      action = 'remove';
    } else if (dispo === 'not_interested' && cumCount >= 3) {
      action = 'remove';
      if (prevCount < 3) byMem = true;
    } else if (['voicemail', 'hung_up', 'dead_call', 'not_available'].includes(dispo) && cumCount > 3) {
      action = 'remove';
      if (prevCount <= 3) byMem = true;
    }
    if (byMem) memCaught++;

    if (action === 'remove') listsSeen[list].rem++;
    else listsSeen[list].keep++;

    const enriched = {
      'List Name (REISift Campaign)': list,
      'First Name': r[COL.fname] || '',
      'Last Name': r[COL.lname] || '',
      'Address': r[COL.addr] || '',
      'City': r[COL.city] || '',
      'State': r[COL.state] || '',
      'Zip Code': r[COL.zip] || '',
      'Phone': r[COL.phone] || '',
      'Disposition': dispoRaw,
      'Call Log Count': cumCount,
      'Call Log Date': dateClean,
      'Phone Status': status,
      'Phone Tag': tag,
      'Marketing Results': mkt,
      'Cold Call Campaign Name': list,
      'Call Notes': r[COL.notes] || '',
      'Action': action,
    };

    if (action === 'remove') filteredRows.push(enriched);
    else cleanRows.push(enriched);
  });

  return { cleanRows, filteredRows, listsSeen, memCaught, totalRows: rows.length, memory };
}

function toCSV(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  return [cols.join(','), ...rows.map(r => cols.map(c => `"${(r[c] || '').toString().replace(/"/g, '""')}"`).join(','))].join('\n');
}

// ── Routes ───────────────────────────────────────────────────────────────────

// Login
app.get('/login', (req, res) => {
  const error = req.query.error ? 'Invalid username or password.' : '';
  res.send(loginPage(error));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === APP_USERNAME && password === APP_PASSWORD) {
    req.session.authenticated = true;
    req.session.memory = {};
    res.redirect('/');
  } else {
    res.redirect('/login?error=1');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// Main app
app.get('/', requireAuth, (req, res) => {
  if (!req.session.memory) req.session.memory = {};
  const memSize = Object.keys(req.session.memory).length;
  const listCount = new Set(Object.keys(req.session.memory).map(k => k.split('||')[0])).size;
  res.send(appPage(memSize, listCount));
});

// Process upload
app.post('/process', requireAuth, upload.single('csvfile'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    if (!req.session.memory) req.session.memory = {};

    const csvText = req.file.buffer.toString('utf8');
    const result = processCSV(csvText, req.session.memory);
    req.session.memory = result.memory;
    req.session.lastResult = {
      cleanRows: result.cleanRows,
      filteredRows: result.filteredRows,
    };

    res.json({
      success: true,
      stats: {
        totalRows: result.totalRows,
        listsCount: Object.keys(result.listsSeen).length,
        kept: result.cleanRows.length,
        filtered: result.filteredRows.length,
        memCaught: result.memCaught,
      },
      listsSeen: result.listsSeen,
      memSize: Object.keys(result.memory).length,
      listCount: new Set(Object.keys(result.memory).map(k => k.split('||')[0])).size,
      preview: {
        filtered: result.filteredRows.slice(0, 50),
        clean: result.cleanRows.slice(0, 50),
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Download filtered
app.get('/download/filtered', requireAuth, (req, res) => {
  if (!req.session.lastResult) return res.redirect('/');
  const csv = toCSV(req.session.lastResult.filteredRows);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="hudrei_filtered_reisift.csv"');
  res.send(csv);
});

// Download clean
app.get('/download/clean', requireAuth, (req, res) => {
  if (!req.session.lastResult) return res.redirect('/');
  const csv = toCSV(req.session.lastResult.cleanRows);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="hudrei_clean_list.csv"');
  res.send(csv);
});

// Export memory
app.get('/memory/export', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="hudrei_memory.json"');
  res.send(JSON.stringify(req.session.memory || {}, null, 2));
});

// Import memory
app.post('/memory/import', requireAuth, upload.single('memfile'), (req, res) => {
  try {
    const data = JSON.parse(req.file.buffer.toString('utf8'));
    req.session.memory = data;
    res.json({ success: true, count: Object.keys(data).length });
  } catch (e) {
    res.status(400).json({ error: 'Invalid memory file.' });
  }
});

// Clear memory
app.post('/memory/clear', requireAuth, (req, res) => {
  req.session.memory = {};
  res.json({ success: true });
});

// Memory stats
app.get('/memory/stats', requireAuth, (req, res) => {
  const mem = req.session.memory || {};
  const lists = new Set(Object.keys(mem).map(k => k.split('||')[0]));
  res.json({ phones: Object.keys(mem).length, lists: lists.size });
});

// ── HTML Templates ───────────────────────────────────────────────────────────

function loginPage(error) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HudREI Filtration Bot — Login</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f4f0;display:flex;align-items:center;justify-content:center;min-height:100vh}
.box{background:#fff;border:1px solid #e0dfd8;border-radius:12px;padding:2.5rem 2rem;width:100%;max-width:380px;box-shadow:0 2px 12px rgba(0,0,0,.06)}
.logo{font-size:15px;font-weight:600;color:#1a1a1a;margin-bottom:6px}
.logo span{color:#888;font-weight:400}
h1{font-size:22px;font-weight:500;color:#1a1a1a;margin-bottom:.25rem}
.sub{font-size:13px;color:#888;margin-bottom:1.75rem}
label{font-size:13px;color:#555;display:block;margin-bottom:4px}
input{width:100%;padding:9px 12px;border:1px solid #ddd;border-radius:8px;font-size:14px;background:#fafaf8;color:#1a1a1a;margin-bottom:1rem;font-family:inherit}
input:focus{outline:none;border-color:#888}
button{width:100%;padding:10px;background:#1a1a1a;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer;font-family:inherit}
button:hover{background:#333}
.error{background:#fff0f0;border:1px solid #f5c5c5;border-radius:8px;padding:9px 12px;font-size:13px;color:#c0392b;margin-bottom:1rem}
</style></head><body>
<div class="box">
  <div class="logo">HudREI LLC <span>/ Data Team</span></div>
  <h1>List Filtration Bot</h1>
  <p class="sub">Sign in to access the filtration tool</p>
  ${error ? `<div class="error">${error}</div>` : ''}
  <form method="POST" action="/login">
    <label>Username</label>
    <input type="text" name="username" autocomplete="username" autofocus>
    <label>Password</label>
    <input type="password" name="password" autocomplete="current-password">
    <button type="submit">Sign in</button>
  </form>
</div>
</body></html>`;
}

function appPage(memSize, listCount) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HudREI List Filtration Bot</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f4f0;color:#1a1a1a;min-height:100vh}
.topbar{background:#1a1a1a;color:#fff;padding:0 2rem;height:52px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10}
.topbar-left{display:flex;align-items:center;gap:16px}
.brand{font-size:14px;font-weight:600}
.brand span{color:#888;font-weight:400}
.version{font-size:11px;background:#333;padding:2px 8px;border-radius:4px;color:#aaa}
.topbar a{color:#aaa;font-size:13px;text-decoration:none}.topbar a:hover{color:#fff}
.main{max-width:900px;margin:0 auto;padding:2rem 1.5rem}
h2{font-size:20px;font-weight:500;margin-bottom:4px}
.sub{font-size:13px;color:#888;margin-bottom:1.75rem}
.card{background:#fff;border:1px solid #e0dfd8;border-radius:12px;padding:1.25rem 1.5rem;margin-bottom:1.25rem}
.section-label{font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px}
.drop-zone{border:1.5px dashed #ccc;border-radius:10px;padding:2.25rem;text-align:center;cursor:pointer;background:#fafaf8;transition:border-color .15s}
.drop-zone:hover,.drop-zone.drag{border-color:#888;background:#f0efe9}
.drop-zone strong{font-size:15px;color:#1a1a1a}
.drop-zone p{font-size:12px;color:#888;margin-top:5px}
.mem-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:1rem;border-top:1px solid #f0efe9;margin-top:1rem}
.mbadge{font-size:12px;padding:4px 10px;background:#f5f4f0;border:1px solid #e0dfd8;border-radius:6px;color:#888}
.mbadge b{color:#1a1a1a}
.btn{display:inline-flex;align-items:center;gap:5px;padding:7px 14px;font-size:13px;border-radius:8px;border:1px solid #ddd;background:#fff;color:#1a1a1a;cursor:pointer;font-family:inherit;white-space:nowrap;text-decoration:none}
.btn:hover{background:#f5f4f0}
.btn-sm{padding:5px 10px;font-size:12px}
.btn-danger{color:#c0392b;border-color:#f5c5c5}.btn-danger:hover{background:#fff0f0}
.btn-primary{background:#1a1a1a;color:#fff;border-color:#1a1a1a}.btn-primary:hover{background:#333}
.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:1.25rem}
.stat{background:#f5f4f0;border-radius:8px;padding:12px 14px}
.stat-label{font-size:12px;color:#888;margin-bottom:4px}
.stat-val{font-size:24px;font-weight:500}
.stat-val.green{color:#1a7a4a}.stat-val.red{color:#c0392b}.stat-val.blue{color:#2471a3}.stat-val.amber{color:#9a6800}
.list-chips{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:1.25rem}
.lchip{background:#fff;border:1px solid #e0dfd8;border-radius:8px;padding:8px 12px;font-size:12px;min-width:160px}
.lchip-name{font-weight:500;font-size:13px;margin-bottom:4px}
.lchip-row{display:flex;justify-content:space-between;color:#888}
.lchip-row .g{color:#1a7a4a}.lchip-row .r{color:#c0392b}
.tabs{display:flex;gap:2px;border-bottom:1px solid #e0dfd8;margin-bottom:1rem}
.tab{padding:8px 16px;font-size:13px;cursor:pointer;border:none;background:transparent;color:#888;border-bottom:2px solid transparent;margin-bottom:-1px;font-family:inherit}
.tab.active{color:#1a1a1a;border-bottom-color:#1a1a1a}
.tab-panel{display:none}.tab-panel.active{display:block}
.tbl-wrap{overflow-x:auto;max-height:420px;overflow-y:auto}
table{width:100%;font-size:12px;border-collapse:collapse;min-width:600px}
th{text-align:left;padding:7px 10px;font-weight:500;color:#888;border-bottom:1px solid #f0efe9;font-size:11px;white-space:nowrap;position:sticky;top:0;background:#fff;z-index:1}
td{padding:7px 10px;border-bottom:1px solid #f8f7f4;color:#1a1a1a;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.badge{display:inline-block;font-size:11px;padding:2px 8px;border-radius:4px;font-weight:500}
.b-keep{background:#e8f5ee;color:#1a7a4a}
.b-remove{background:#fdf0f0;color:#c0392b}
.actions{display:flex;gap:8px;margin-top:1rem;flex-wrap:wrap}
.info{font-size:12px;color:#888;background:#f5f4f0;border-radius:8px;padding:8px 12px;margin-bottom:10px;line-height:1.7}
.error-msg{background:#fff0f0;border:1px solid #f5c5c5;border-radius:8px;padding:10px 14px;font-size:13px;color:#c0392b;margin-bottom:1rem}
.hidden{display:none}
#upload-spinner{display:none;align-items:center;gap:8px;font-size:13px;color:#888;padding:8px 0}
.spinner{width:16px;height:16px;border:2px solid #ddd;border-top-color:#888;border-radius:50%;animation:spin .6s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div class="topbar">
  <div class="topbar-left">
    <span class="brand">HudREI LLC <span>/ List Filtration Bot</span></span>
    <span class="version">v1.0</span>
  </div>
  <a href="/logout">Sign out</a>
</div>

<div class="main">
  <h2>List Filtration Bot</h2>
  <p class="sub">Drop a Readymode call log export. Counts are calculated by the bot. Output is ready for REISift import.</p>

  <div id="error-banner" class="error-msg hidden"></div>

  <div class="card">
    <div class="section-label">Upload call log export</div>
    <div class="drop-zone" id="drop-zone">
      <strong>Drop Readymode CSV here or click to browse</strong>
      <p>Columns used: Phone · Log Type · Original lead file · Log Time · First/Last Name · Address · City · State · Zip Code</p>
    </div>
    <input type="file" id="file-input" accept=".csv" style="display:none">
    <div id="upload-spinner"><div class="spinner"></div> Processing…</div>

    <div class="mem-bar">
      <div class="mbadge">Lists in memory: <b id="m-lists">${listCount}</b></div>
      <div class="mbadge">Numbers tracked: <b id="m-phones">${memSize}</b></div>
      <button class="btn btn-sm" id="btn-exp-mem">Export memory</button>
      <label class="btn btn-sm" style="cursor:pointer">Import memory<input type="file" id="mem-file-input" accept=".json" style="display:none"></label>
      <button class="btn btn-sm btn-danger" id="btn-clear">Clear memory</button>
    </div>
  </div>

  <div id="results" class="hidden">
    <div class="stats-grid">
      <div class="stat"><div class="stat-label">Total records</div><div class="stat-val" id="s-total">0</div></div>
      <div class="stat"><div class="stat-label">Lists detected</div><div class="stat-val amber" id="s-lists">0</div></div>
      <div class="stat"><div class="stat-label">Kept</div><div class="stat-val green" id="s-keep">0</div></div>
      <div class="stat"><div class="stat-label">Filtered out</div><div class="stat-val red" id="s-rem">0</div></div>
      <div class="stat"><div class="stat-label">Caught by memory</div><div class="stat-val blue" id="s-mem">0</div></div>
    </div>

    <div id="list-chips" class="list-chips"></div>

    <div class="card" style="padding:1rem 1.25rem">
      <div class="tabs">
        <button class="tab active" data-tab="filtered">Filtered → REISift</button>
        <button class="tab" data-tab="clean">Clean → Readymode</button>
      </div>
      <div id="tab-filtered" class="tab-panel active">
        <p class="info">Upload this file to REISift to update Phone Status, Phone Tag, and Marketing Results per list.</p>
        <div class="tbl-wrap"><table><thead><tr id="rem-head"></tr></thead><tbody id="rem-body"></tbody></table></div>
      </div>
      <div id="tab-clean" class="tab-panel">
        <p class="info">These records passed all filters. Re-upload to Readymode per list.</p>
        <div class="tbl-wrap"><table><thead><tr id="cln-head"></tr></thead><tbody id="cln-body"></tbody></table></div>
      </div>
      <div class="actions">
        <a class="btn btn-primary" href="/download/filtered">Download filtered records (REISift update)</a>
        <a class="btn" href="/download/clean">Download clean list (Readymode re-upload)</a>
      </div>
    </div>
  </div>

  <div class="card" style="margin-top:1.5rem">
    <div class="section-label">SOP rules reference</div>
    <table>
      <thead><tr><th>Disposition</th><th>Threshold</th><th>Action</th><th>Phone status</th><th>Phone tag</th></tr></thead>
      <tbody>
        <tr><td>Transfer</td><td>Any</td><td><span class="badge b-remove">Remove — lead</span></td><td>Correct</td><td>—</td></tr>
        <tr><td>Not Interested</td><td>3+ logs</td><td><span class="badge b-remove">Remove</span></td><td>Correct</td><td>Not Interested — [List]</td></tr>
        <tr><td>Do Not Call</td><td>Any</td><td><span class="badge b-remove">Remove</span></td><td>Correct</td><td>Do Not Call</td></tr>
        <tr><td>Wrong Number</td><td>Any</td><td><span class="badge b-remove">Remove</span></td><td>Wrong</td><td>—</td></tr>
        <tr><td>Spanish Speaker</td><td>Any</td><td><span class="badge b-remove">Remove</span></td><td>Correct</td><td>—</td></tr>
        <tr><td>Voicemail</td><td>4+ logs</td><td><span class="badge b-remove">Remove</span></td><td>—</td><td>Voicemail — [List]</td></tr>
        <tr><td>Hung Up</td><td>4+ logs</td><td><span class="badge b-remove">Remove</span></td><td>—</td><td>Hung Up — [List]</td></tr>
        <tr><td>Dead Call</td><td>4+ logs</td><td><span class="badge b-remove">Remove</span></td><td>—</td><td>Dead Call — [List]</td></tr>
        <tr><td>Not Available</td><td>4+ logs</td><td><span class="badge b-remove">Remove</span></td><td>—</td><td>Not Available — [List]</td></tr>
        <tr><td>Callback</td><td>Any</td><td><span class="badge b-keep">Keep</span></td><td>Correct</td><td>—</td></tr>
      </tbody>
    </table>
  </div>
</div>

<script>
const PREVIEW_COLS = ['List Name (REISift Campaign)','First Name','Last Name','Address','City','State','Zip Code','Phone','Disposition','Call Log Count','Action','Phone Tag','Phone Status','Marketing Results'];

function showError(msg){ const b=document.getElementById('error-banner'); b.textContent=msg; b.classList.remove('hidden'); setTimeout(()=>b.classList.add('hidden'),6000); }

async function handleFile(file){
  if(!file.name.endsWith('.csv')){ showError('Please upload a CSV file.'); return; }
  const form=new FormData(); form.append('csvfile',file);
  document.getElementById('upload-spinner').style.display='flex';
  document.getElementById('drop-zone').classList.add('drag');
  try{
    const res=await fetch('/process',{method:'POST',body:form});
    const data=await res.json();
    if(!res.ok||data.error){ showError(data.error||'Processing failed.'); return; }
    renderResults(data);
    document.getElementById('m-lists').textContent=data.listCount;
    document.getElementById('m-phones').textContent=data.memSize;
  }catch(e){ showError('Upload failed: '+e.message); }
  finally{ document.getElementById('upload-spinner').style.display='none'; document.getElementById('drop-zone').classList.remove('drag'); }
}

function renderResults(data){
  const s=data.stats;
  document.getElementById('s-total').textContent=s.totalRows;
  document.getElementById('s-lists').textContent=s.listsCount;
  document.getElementById('s-keep').textContent=s.kept;
  document.getElementById('s-rem').textContent=s.filtered;
  document.getElementById('s-mem').textContent=s.memCaught;

  const chips=document.getElementById('list-chips'); chips.innerHTML='';
  Object.entries(data.listsSeen).forEach(([name,v])=>{
    const top=Object.entries(v.dispositions).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([k,c])=>k+':'+c).join(' · ');
    chips.innerHTML+=\`<div class="lchip"><div class="lchip-name">\${name}</div><div class="lchip-row"><span class="g">Kept: \${v.keep}</span><span class="r">Filtered: \${v.rem}</span></div><div style="font-size:11px;color:#aaa;margin-top:3px">\${top}</div></div>\`;
  });

  renderTable('rem-head','rem-body',data.preview.filtered);
  renderTable('cln-head','cln-body',data.preview.clean);
  document.getElementById('results').classList.remove('hidden');
  window.scrollTo({top:document.getElementById('results').offsetTop-20,behavior:'smooth'});
}

function renderTable(hId,bId,rows){
  const cols=PREVIEW_COLS;
  const thead=document.getElementById(hId), tbody=document.getElementById(bId);
  thead.innerHTML=''; tbody.innerHTML='';
  if(!rows.length){ tbody.innerHTML='<tr><td colspan="99" style="color:#aaa;padding:16px">No records</td></tr>'; cols.forEach(c=>{const th=document.createElement('th');th.textContent=c;thead.appendChild(th);}); return; }
  cols.forEach(c=>{const th=document.createElement('th');th.textContent=c;thead.appendChild(th);});
  rows.forEach(r=>{
    const tr=document.createElement('tr');
    cols.forEach(c=>{
      const td=document.createElement('td'); const v=r[c]!==undefined?r[c]:'';
      if(c==='Action'){const cls=v==='remove'?'b-remove':'b-keep';td.innerHTML=\`<span class="badge \${cls}">\${v}</span>\`;}
      else td.textContent=v;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
}

// File input
document.getElementById('file-input').addEventListener('change',e=>{if(e.target.files[0])handleFile(e.target.files[0]);});
const dz=document.getElementById('drop-zone');
dz.addEventListener('click',()=>document.getElementById('file-input').click());
dz.addEventListener('dragover',e=>{e.preventDefault();dz.classList.add('drag');});
dz.addEventListener('dragleave',()=>dz.classList.remove('drag'));
dz.addEventListener('drop',e=>{e.preventDefault();dz.classList.remove('drag');if(e.dataTransfer.files[0])handleFile(e.dataTransfer.files[0]);});

// Memory export
document.getElementById('btn-exp-mem').addEventListener('click',()=>window.location='/memory/export');

// Memory import
document.getElementById('mem-file-input').addEventListener('change',async e=>{
  const f=e.target.files[0]; if(!f)return;
  const form=new FormData(); form.append('memfile',f);
  const res=await fetch('/memory/import',{method:'POST',body:form});
  const data=await res.json();
  if(data.success){ document.getElementById('m-phones').textContent=data.count; alert('Memory loaded — '+data.count+' records.'); }
  else showError(data.error||'Import failed.');
});

// Clear memory
document.getElementById('btn-clear').addEventListener('click',async()=>{
  if(!confirm('Clear all session memory?'))return;
  await fetch('/memory/clear',{method:'POST'});
  document.getElementById('m-phones').textContent='0';
  document.getElementById('m-lists').textContent='0';
});

// Tabs
document.querySelectorAll('.tab').forEach(t=>t.addEventListener('click',()=>{
  document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(x=>x.classList.remove('active'));
  t.classList.add('active');
  document.getElementById('tab-'+t.dataset.tab).classList.add('active');
}));
</script>
</body></html>`;
}

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`HudREI Filtration Bot running on port ${PORT}`);
  console.log(`Username: ${APP_USERNAME}`);
});
