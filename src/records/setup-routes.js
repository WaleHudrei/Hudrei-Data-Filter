const express = require('express');
const router = express.Router();
const { query } = require('../db');

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.redirect('/login');
}

function shell(title, body, activePage) {
  return `<!DOCTYPE html><html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — Loki</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f4f0;color:#1a1a1a;min-height:100vh;display:flex}
.sidebar{width:220px;min-height:100vh;background:#1a1a1a;display:flex;flex-direction:column;position:fixed;top:0;left:0;bottom:0;z-index:20}
.sidebar-logo{padding:20px 20px 16px;border-bottom:1px solid #2a2a2a}
.sidebar-logo-title{font-size:15px;font-weight:600;color:#fff}
.sidebar-logo-sub{font-size:11px;color:#666;margin-top:2px}
.sidebar-nav{padding:12px 10px;flex:1}
.sidebar-section{font-size:10px;font-weight:600;color:#444;text-transform:uppercase;letter-spacing:.06em;padding:8px 10px 4px}
.sidebar-link{display:flex;align-items:center;gap:12px;padding:12px 12px;border-radius:8px;color:#888;font-size:14px;text-decoration:none;margin-bottom:6px;transition:all .15s}
.sidebar-link:hover{background:#2a2a2a;color:#fff}
.sidebar-link.active{background:#2a2a2a;color:#fff}
.sidebar-link svg{width:18px;height:18px;flex-shrink:0;opacity:.7}
.sidebar-link.active svg{opacity:1}
.sidebar-footer{padding:14px 16px;border-top:1px solid #2a2a2a}
.sidebar-footer a{font-size:12px;color:#666;text-decoration:none}
.sidebar-footer a:hover{color:#fff}
.page-wrap{margin-left:220px;min-height:100vh;flex:1}
.main{max-width:1100px;margin:0 auto;padding:2rem 1.5rem}
.data-table{width:100%;font-size:13px;border-collapse:collapse}
.data-table th{text-align:left;padding:9px 14px;font-weight:500;color:#888;border-bottom:1px solid #f0efe9;font-size:11px;white-space:nowrap;background:#fff;text-transform:uppercase;letter-spacing:.04em}
.data-table td{padding:11px 14px;border-bottom:1px solid #f8f7f4;vertical-align:middle}
</style></head><body>
<div class="sidebar">
  <div class="sidebar-logo">
    <div class="sidebar-logo-title">Loki</div>
    <div class="sidebar-logo-sub">Developed by HudREI</div>
  </div>
  <div class="sidebar-nav">
    <div class="sidebar-section">Tools</div>
    <a href="/" class="sidebar-link ${activePage==='filter'?'active':''}">
      <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M3 4h18M3 8h18M3 12h12M3 16h8"/></svg>
      List Filtration
    </a>
    <a href="/records" class="sidebar-link ${activePage==='records'?'active':''}">
      <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
      Records
    </a>
    <a href="/upload" class="sidebar-link ${activePage==='upload'?'active':''}">
      <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
      Upload Data
    </a>
    <a href="/campaigns" class="sidebar-link ${activePage==='campaigns'?'active':''}">
      <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
      Campaigns
    </a>
    <a href="/nis" class="sidebar-link ${activePage==='nis'?'active':''}">
      <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
      NIS Numbers
    </a>
    <a href="/changelog" class="sidebar-link ${activePage==='changelog'?'active':''}">
      <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="10"/></svg>
      Changelog
    </a>
    <div class="sidebar-section" style="margin-top:8px">System</div>
    <a href="/setup" class="sidebar-link ${activePage==='setup'?'active':''}">
      <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 010 14.14M4.93 4.93a10 10 0 000 14.14"/></svg>
      Setup
    </a>
  </div>
  <div class="sidebar-footer"><a href="/logout">Sign out</a></div>
</div>
<div class="page-wrap"><div class="main">${body}</div></div>
</body></html>`;
}

function fmtDate(val) { if (!val) return '—'; return new Date(val).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }); }

// ── GET /setup ────────────────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const msg = req.query.msg || '';
    const marketsRes = await query(`SELECT * FROM markets ORDER BY state_name ASC`);
    const statsRes = await query(`
      SELECT
        (SELECT COUNT(*) FROM properties) AS total_properties,
        (SELECT COUNT(*) FROM contacts) AS total_contacts,
        (SELECT COUNT(*) FROM phones) AS total_phones,
        (SELECT COUNT(*) FROM lists) AS total_lists,
        (SELECT COUNT(*) FROM call_logs) AS total_call_logs,
        (SELECT COUNT(*) FROM sms_logs) AS total_sms_logs
    `);
    const stats = statsRes.rows[0];

    const marketsHTML = marketsRes.rows.map(m => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid #f0efe9">
        <div>
          <div style="font-weight:500;font-size:14px">${m.name}</div>
          <div style="font-size:12px;color:#888;font-family:monospace">${m.state_name} (${m.state_code})</div>
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          <span style="font-size:12px;background:${m.active?'#e8f5ee':'#f5f4f0'};color:${m.active?'#1a7a4a':'#888'};padding:2px 9px;border-radius:4px;font-weight:600">${m.active?'Active':'Inactive'}</span>
          <form method="POST" action="/setup/markets/${m.id}/toggle" style="margin:0">
            <button type="submit" style="padding:5px 12px;font-size:12px;background:#fff;border:1px solid #ddd;border-radius:8px;cursor:pointer;font-family:inherit">${m.active?'Deactivate':'Activate'}</button>
          </form>
        </div>
      </div>`).join('');

    res.send(shell('Setup', `
      ${msg==='saved'?'<div style="background:#e8f5ee;border:1px solid #c3e6cc;border-radius:8px;padding:10px 14px;font-size:13px;color:#1a7a4a;margin-bottom:1rem">✓ Changes saved</div>':''}
      ${msg==='error'?'<div style="background:#fdf0f0;border:1px solid #f5c5c5;border-radius:8px;padding:10px 14px;font-size:13px;color:#c0392b;margin-bottom:1rem">Something went wrong</div>':''}

      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.5rem;flex-wrap:wrap;gap:12px">
        <div>
          <div style="font-size:20px;font-weight:600">Setup</div>
          <div style="font-size:13px;color:#888;margin-top:2px">System configuration and database overview</div>
        </div>
      </div>

      <div style="background:#fff;border:1px solid #e0dfd8;border-radius:12px;padding:1.25rem 1.5rem;margin-bottom:1.25rem">
        <div style="font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px">Database Overview</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px">
          ${[
            ['Properties', stats.total_properties],
            ['Contacts', stats.total_contacts],
            ['Phones', stats.total_phones],
            ['Lists', stats.total_lists],
            ['Call Logs', stats.total_call_logs],
            ['SMS Logs', stats.total_sms_logs],
          ].map(([label, val]) => `
            <div style="background:#fafaf8;border:1px solid #f0efe9;border-radius:8px;padding:12px 14px">
              <div style="font-size:11px;color:#888;margin-bottom:4px">${label}</div>
              <div style="font-size:20px;font-weight:600">${Number(val).toLocaleString()}</div>
            </div>`).join('')}
        </div>
      </div>

      <div style="background:#fff;border:1px solid #e0dfd8;border-radius:12px;padding:1.25rem 1.5rem;margin-bottom:1.25rem">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
          <div style="font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.05em">Active Markets</div>
          <button onclick="document.getElementById('add-market-modal').style.display='flex'" style="padding:6px 14px;font-size:12px;background:#1a1a1a;color:#fff;border:none;border-radius:8px;cursor:pointer;font-family:inherit;font-weight:500">+ Add Market</button>
        </div>
        ${marketsHTML || '<div style="color:#aaa;font-size:13px">No markets configured</div>'}
      </div>

      <div style="background:#fff;border:1px solid #e0dfd8;border-radius:12px;padding:1.25rem 1.5rem;margin-bottom:1.25rem">
        <div style="font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px">Import Column Mapping</div>
        <p style="font-size:13px;color:#888;margin-bottom:14px">Column names Loki recognizes when importing CSVs. Auto-detected — this is for reference.</p>
        <table style="width:100%;font-size:13px;border-collapse:collapse">
          <thead><tr>
            <th style="text-align:left;padding:8px 14px;font-size:11px;color:#888;border-bottom:1px solid #f0efe9;font-weight:500;text-transform:uppercase;letter-spacing:.04em">Field</th>
            <th style="text-align:left;padding:8px 14px;font-size:11px;color:#888;border-bottom:1px solid #f0efe9;font-weight:500;text-transform:uppercase;letter-spacing:.04em">Accepted Column Names</th>
          </tr></thead>
          <tbody>
            ${[
              ['Address','Address, Street, Property Address'],
              ['City','City'],
              ['State','State, State Code'],
              ['Zip','Zip Code, Zip, Postal Code'],
              ['First Name','First Name, FirstName, Owner First'],
              ['Last Name','Last Name, LastName, Owner Last'],
              ['Phone 1–10','Ph#1 … Ph#10, Phone1 … Phone10'],
              ['Source','Source, Lead Source, List Source'],
              ['Property Type','Property Type, Type'],
              ['Est. Value','Estimated Value, Est Value, AVM'],
            ].map(([f,v])=>`<tr>
              <td style="padding:10px 14px;border-bottom:1px solid #f8f7f4;font-weight:500">${f}</td>
              <td style="padding:10px 14px;border-bottom:1px solid #f8f7f4;font-family:monospace;font-size:12px;color:#888">${v}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>

      <!-- ADD MARKET MODAL -->
      <div id="add-market-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:200;align-items:center;justify-content:center">
        <div style="background:#fff;border-radius:14px;padding:1.5rem;width:100%;max-width:420px;box-shadow:0 20px 60px rgba(0,0,0,.2)">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.25rem">
            <div style="font-size:16px;font-weight:600">Add Market</div>
            <button onclick="document.getElementById('add-market-modal').style.display='none'" style="background:none;border:none;font-size:20px;color:#888;cursor:pointer;line-height:1">×</button>
          </div>
          <form method="POST" action="/setup/markets/add">
            <div style="margin-bottom:1rem"><label style="font-size:13px;color:#555;display:block;margin-bottom:4px;font-weight:500">Market Name</label>
              <input type="text" name="name" placeholder="e.g. Columbus Metro" required style="width:100%;padding:9px 12px;border:1px solid #ddd;border-radius:8px;font-size:14px;background:#fafaf8;font-family:inherit">
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:1rem">
              <div><label style="font-size:13px;color:#555;display:block;margin-bottom:4px;font-weight:500">State Code</label>
                <input type="text" name="state_code" maxlength="2" placeholder="OH" required style="width:100%;padding:9px 12px;border:1px solid #ddd;border-radius:8px;font-size:14px;background:#fafaf8;font-family:inherit">
              </div>
              <div><label style="font-size:13px;color:#555;display:block;margin-bottom:4px;font-weight:500">State Name</label>
                <input type="text" name="state_name" placeholder="Ohio" required style="width:100%;padding:9px 12px;border:1px solid #ddd;border-radius:8px;font-size:14px;background:#fafaf8;font-family:inherit">
              </div>
            </div>
            <button type="submit" style="width:100%;padding:10px;background:#1a1a1a;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer;font-family:inherit">Add Market</button>
          </form>
        </div>
      </div>
    `, 'setup'));
  } catch(e) {
    console.error(e);
    res.status(500).send('Server error: ' + e.message);
  }
});

// ── POST /setup/markets/add ───────────────────────────────────────────────────
router.post('/markets/add', requireAuth, async (req, res) => {
  try {
    const { name, state_code, state_name } = req.body;
    await query(`
      INSERT INTO markets (name, state_code, state_name)
      VALUES ($1, $2, $3)
      ON CONFLICT (state_code) DO UPDATE SET name = EXCLUDED.name, state_name = EXCLUDED.state_name
    `, [name, state_code.toUpperCase(), state_name]);
    res.redirect('/setup?msg=saved');
  } catch(e) {
    console.error(e);
    res.redirect('/setup?msg=error');
  }
});

// ── POST /setup/markets/:id/toggle ───────────────────────────────────────────
router.post('/markets/:id/toggle', requireAuth, async (req, res) => {
  try {
    await query(`UPDATE markets SET active = NOT active WHERE id = $1`, [req.params.id]);
    res.redirect('/setup?msg=saved');
  } catch(e) {
    console.error(e);
    res.redirect('/setup?msg=error');
  }
});

module.exports = router;
