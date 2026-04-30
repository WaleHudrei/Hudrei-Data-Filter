const express = require('express');
const router = express.Router();
const { query } = require('./db');
const { shell } = require('./shared-shell');

function requireAuth(req, res, next) {
  if (!req.session || !req.session.authenticated) return res.redirect('/login');
  if (!req.session.tenantId) return res.redirect('/login');
  req.tenantId = req.session.tenantId;
  req.userId = req.session.userId;
  req.role = req.session.role;
  next();
}

function fmtDate(val) {
  if (!val) return '—';
  const d = new Date(val);
  const now = new Date();
  const diff = Math.floor((now - d) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff/60) + 'm ago';
  if (diff < 86400) return Math.floor(diff/3600) + 'h ago';
  return d.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared row renderer. Previously these ~100 lines of HTML were duplicated
// in BOTH GET / and GET /status, so adding/changing a column meant editing
// in two places (and the two drifted). One function, two callers. (Audit #30.)
// ─────────────────────────────────────────────────────────────────────────────
function renderJobRow(j) {
  const pct = j.total_rows > 0 ? Math.round((j.processed_rows / j.total_rows) * 100) : 0;
  const statusIcon = { pending:'⏳', running:'🔄', complete:'✅', error:'❌' }[j.status] || '⏳';
  const statusColor = { pending:'#888', running:'#9a6800', complete:'#1a7a4a', error:'#c0392b' }[j.status] || '#888';

  // error_log on a 'complete' job = a warning (some rows skipped). On 'error' = real crash.
  let errBlock = '';
  if (j.error_log) {
    const isWarn = j.status === 'complete';
    const color = isWarn ? '#9a6800' : '#c0392b';
    const bg    = isWarn ? '#fff8e1' : '#fdecec';
    const icon  = isWarn ? '⚠️' : '❌';
    const msg   = String(j.error_log).replace(/</g,'&lt;');
    const shown = msg.slice(0, 500) + (msg.length > 500 ? '…' : '');
    errBlock = `<div style="margin-top:4px;font-size:11px;color:${color};background:${bg};padding:5px 8px;border-radius:4px;white-space:pre-wrap;word-break:break-word;max-width:400px;font-weight:normal;line-height:1.4">${icon} ${shown}</div>`;
  }

  return `<tr>
    <td style="padding:13px 16px;font-weight:500">
      ${j.filename || '—'}
      ${errBlock}
    </td>
    <td style="padding:13px 16px">
      ${j.list_name ? `<a href="/records?list_id=${j.list_id}" style="color:#1a1a1a;text-decoration:none;font-weight:500">${j.list_name}</a>` : '—'}
    </td>
    <td style="padding:13px 16px">
      <span style="color:${statusColor};font-weight:600;font-size:12px">${statusIcon} ${j.status.charAt(0).toUpperCase()+j.status.slice(1)}</span>
    </td>
    <td style="padding:13px 16px">
      <div style="display:flex;align-items:center;gap:8px">
        <div style="flex:1;background:#f0efe9;border-radius:4px;height:6px;min-width:80px;overflow:hidden">
          <div style="background:${j.status==='complete'?'#1a7a4a':j.status==='error'?'#c0392b':'#1a1a1a'};height:6px;width:${pct}%;border-radius:4px;transition:width .3s"></div>
        </div>
        <span style="font-size:12px;color:#888;white-space:nowrap">${j.processed_rows.toLocaleString()} / ${j.total_rows.toLocaleString()}</span>
      </div>
    </td>
    <td style="padding:13px 16px;font-size:12px;color:#888">
      ${j.inserted > 0 || j.updated > 0 ? `<span style="color:#1a7a4a">+${j.inserted.toLocaleString()}</span> new, <span style="color:#2c5cc5">${j.updated.toLocaleString()}</span> updated` : '—'}
      ${j.errors > 0 ? `, <span style="color:#c0392b">${j.errors.toLocaleString()} errors</span>` : ''}
    </td>
    <td style="padding:13px 16px;font-size:12px;color:#888;white-space:nowrap">${fmtDate(j.created_at)}</td>
    <td style="padding:13px 16px;text-align:right;white-space:nowrap;min-width:110px">
      ${j.list_id ? `<a href="/records?list_id=${j.list_id}" style="display:inline-block;padding:5px 12px;background:#f5f4f0;border:1px solid #e0dfd8;border-radius:6px;font-size:12px;color:#1a1a1a;text-decoration:none;white-space:nowrap;line-height:1.2">View List</a>` : ''}
    </td>
  </tr>`;
}

async function fetchJobs(tenantId) {
  return query(`
    SELECT j.*, l.list_name
      FROM bulk_import_jobs j
      LEFT JOIN lists l ON l.id = j.list_id AND l.tenant_id = j.tenant_id
     WHERE j.tenant_id = $1
     ORDER BY j.created_at DESC
     LIMIT 50
  `, [tenantId]);
}

// ── Activity Page ─────────────────────────────────────────────────────────────
// Milestone A: legacy /activity redirects to Ocular's activity page.
// /activity/status JSON polling stays for any external consumer; Ocular
// uses /oculah/activity/poll which is a separate endpoint.
router.get('/', requireAuth, (req, res) => res.redirect('/oculah/activity'));


// ── Status API (auto-refresh) ────────────────────────────────────────────────
router.get('/status', requireAuth, async (req, res) => {
  try {
    const jobs = await fetchJobs(req.tenantId);
    const hasRunning = jobs.rows.some(j => j.status === 'running' || j.status === 'pending');
    const html = jobs.rows.map(renderJobRow).join('');
    res.json({ html, hasRunning });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Single job status (for polling) ──────────────────────────────────────────
router.get('/job/:id', requireAuth, async (req, res) => {
  try {
    const result = await query(`SELECT * FROM bulk_import_jobs WHERE id=$1 AND tenant_id=$2`, [req.params.id, req.tenantId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Job not found' });
    const j = result.rows[0];
    res.json({ status: j.status, total: j.total_rows, processed: j.processed_rows, inserted: j.inserted, updated: j.updated, errors: j.errors });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
