const express = require('express');
const router = express.Router();
const { query } = require('./db');
const { shell } = require('./shared-shell');

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.redirect('/login');
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

// ── Activity Page ─────────────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const jobs = await query(`
      SELECT j.*, l.list_name
      FROM bulk_import_jobs j
      LEFT JOIN lists l ON l.id = j.list_id
      ORDER BY j.created_at DESC
      LIMIT 50
    `);

    const rows = jobs.rows.map(j => {
      const pct = j.total_rows > 0 ? Math.round((j.processed_rows / j.total_rows) * 100) : 0;
      const statusIcon = {
        pending:    '⏳',
        running:    '🔄',
        complete:   '✅',
        error:      '❌',
      }[j.status] || '⏳';
      const statusColor = {
        pending:  '#888',
        running:  '#9a6800',
        complete: '#1a7a4a',
        error:    '#c0392b',
      }[j.status] || '#888';

      return `<tr>
        <td style="padding:13px 16px;font-weight:500">
          ${j.filename || '—'}
          ${j.error_log ? (() => {
            // Complete + error_log = warning (skipped rows). Error status = real crash.
            const isWarn = j.status === 'complete';
            const color = isWarn ? '#9a6800' : '#c0392b';
            const bg    = isWarn ? '#fff8e1' : '#fdecec';
            const icon  = isWarn ? '⚠️' : '❌';
            const msg   = String(j.error_log).replace(/</g,'&lt;');
            const shown = msg.slice(0, 500) + (msg.length > 500 ? '…' : '');
            return `<div style="margin-top:4px;font-size:11px;color:${color};background:${bg};padding:5px 8px;border-radius:4px;white-space:pre-wrap;word-break:break-word;max-width:400px;font-weight:normal;line-height:1.4">${icon} ${shown}</div>`;
          })() : ''}
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
        <td style="padding:13px 16px;text-align:right">
          ${j.list_id ? `<a href="/records?list_id=${j.list_id}" style="padding:5px 12px;background:#f5f4f0;border:1px solid #e0dfd8;border-radius:6px;font-size:12px;color:#1a1a1a;text-decoration:none">View List</a>` : ''}
        </td>
      </tr>`;
    }).join('');

    const hasRunning = jobs.rows.some(j => j.status === 'running' || j.status === 'pending');

    res.send(shell('Activity', `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.5rem;flex-wrap:wrap;gap:12px">
        <div>
          <div class="page-title">Activity <span class="count-pill">${jobs.rows.length}</span></div>
          <div class="page-sub">Import jobs and background tasks</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          ${hasRunning ? `<span style="font-size:12px;color:#9a6800;background:#fff8e1;padding:4px 10px;border-radius:6px;font-weight:500">🔄 Import running…</span>` : ''}
          <a href="/import/property" class="btn btn-primary">+ New Import</a>
        </div>
      </div>

      ${jobs.rows.length === 0 ? `
        <div class="card" style="text-align:center;padding:3rem;color:#aaa">
          <div style="font-size:32px;margin-bottom:12px">📋</div>
          <div style="font-size:15px;font-weight:500;color:#555;margin-bottom:6px">No import activity yet</div>
          <div style="font-size:13px">Start by importing a property list</div>
          <a href="/import/property" class="btn btn-primary" style="margin-top:1rem;display:inline-block">Import Property List</a>
        </div>
      ` : `
        <div style="background:#fff;border-radius:12px;border:1px solid #e0dfd8;overflow:hidden">
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <thead>
              <tr style="border-bottom:1px solid #e0dfd8">
                <th style="padding:10px 16px;text-align:left;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.05em">File</th>
                <th style="padding:10px 16px;text-align:left;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.05em">List</th>
                <th style="padding:10px 16px;text-align:left;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.05em">Status</th>
                <th style="padding:10px 16px;text-align:left;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.05em">Progress</th>
                <th style="padding:10px 16px;text-align:left;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.05em">Results</th>
                <th style="padding:10px 16px;text-align:left;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.05em">Started</th>
                <th style="padding:10px 16px"></th>
              </tr>
            </thead>
            <tbody id="activity-tbody">
              ${rows}
            </tbody>
          </table>
        </div>
      `}

      <script>
      // Auto-refresh if any job is running
      ${hasRunning ? `
      let refreshInterval = setInterval(async () => {
        try {
          const res = await fetch('/activity/status');
          const data = await res.json();
          if (data.html) document.getElementById('activity-tbody').innerHTML = data.html;
          if (!data.hasRunning) clearInterval(refreshInterval);
        } catch(e) {}
      }, 2000);
      ` : ''}
      </script>
    `, 'activity'));
  } catch(e) {
    console.error(e);
    res.status(500).send('Server error: ' + e.message);
  }
});

// ── Status API (for auto-refresh) ─────────────────────────────────────────────
router.get('/status', requireAuth, async (req, res) => {
  try {
    const jobs = await query(`
      SELECT j.*, l.list_name
      FROM bulk_import_jobs j
      LEFT JOIN lists l ON l.id = j.list_id
      ORDER BY j.created_at DESC
      LIMIT 50
    `);

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

    const hasRunning = jobs.rows.some(j => j.status === 'running' || j.status === 'pending');

    const html = jobs.rows.map(j => {
      const pct = j.total_rows > 0 ? Math.round((j.processed_rows / j.total_rows) * 100) : 0;
      const statusIcon = { pending:'⏳', running:'🔄', complete:'✅', error:'❌' }[j.status] || '⏳';
      const statusColor = { pending:'#888', running:'#9a6800', complete:'#1a7a4a', error:'#c0392b' }[j.status] || '#888';
      return `<tr>
        <td style="padding:13px 16px;font-weight:500">
          ${j.filename || '—'}
          ${j.error_log ? (() => {
            // Complete + error_log = warning (skipped rows). Error status = real crash.
            const isWarn = j.status === 'complete';
            const color = isWarn ? '#9a6800' : '#c0392b';
            const bg    = isWarn ? '#fff8e1' : '#fdecec';
            const icon  = isWarn ? '⚠️' : '❌';
            const msg   = String(j.error_log).replace(/</g,'&lt;');
            const shown = msg.slice(0, 500) + (msg.length > 500 ? '…' : '');
            return `<div style="margin-top:4px;font-size:11px;color:${color};background:${bg};padding:5px 8px;border-radius:4px;white-space:pre-wrap;word-break:break-word;max-width:400px;font-weight:normal;line-height:1.4">${icon} ${shown}</div>`;
          })() : ''}
        </td>
        <td style="padding:13px 16px">${j.list_name ? `<a href="/records?list_id=${j.list_id}" style="color:#1a1a1a;text-decoration:none;font-weight:500">${j.list_name}</a>` : '—'}</td>
        <td style="padding:13px 16px"><span style="color:${statusColor};font-weight:600;font-size:12px">${statusIcon} ${j.status.charAt(0).toUpperCase()+j.status.slice(1)}</span></td>
        <td style="padding:13px 16px">
          <div style="display:flex;align-items:center;gap:8px">
            <div style="flex:1;background:#f0efe9;border-radius:4px;height:6px;min-width:80px;overflow:hidden">
              <div style="background:${j.status==='complete'?'#1a7a4a':j.status==='error'?'#c0392b':'#1a1a1a'};height:6px;width:${pct}%;border-radius:4px"></div>
            </div>
            <span style="font-size:12px;color:#888;white-space:nowrap">${j.processed_rows.toLocaleString()} / ${j.total_rows.toLocaleString()}</span>
          </div>
        </td>
        <td style="padding:13px 16px;font-size:12px;color:#888">
          ${j.inserted > 0 || j.updated > 0 ? `<span style="color:#1a7a4a">+${j.inserted.toLocaleString()}</span> new, <span style="color:#2c5cc5">${j.updated.toLocaleString()}</span> updated` : '—'}
          ${j.errors > 0 ? `, <span style="color:#c0392b">${j.errors.toLocaleString()} errors</span>` : ''}
        </td>
        <td style="padding:13px 16px;font-size:12px;color:#888;white-space:nowrap">${fmtDate(j.created_at)}</td>
        <td style="padding:13px 16px;text-align:right">${j.list_id ? `<a href="/records?list_id=${j.list_id}" style="padding:5px 12px;background:#f5f4f0;border:1px solid #e0dfd8;border-radius:6px;font-size:12px;color:#1a1a1a;text-decoration:none">View List</a>` : ''}</td>
      </tr>`;
    }).join('');

    res.json({ html, hasRunning });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Single job status (for polling) ──────────────────────────────────────────
router.get('/job/:id', requireAuth, async (req, res) => {
  try {
    const result = await query(`SELECT * FROM bulk_import_jobs WHERE id=$1`, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Job not found' });
    const j = result.rows[0];
    res.json({ status: j.status, total: j.total_rows, processed: j.processed_rows, inserted: j.inserted, updated: j.updated, errors: j.errors });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
