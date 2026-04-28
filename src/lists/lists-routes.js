const express = require('express');
const router = express.Router();
const { query } = require('../db');
const settings = require('../settings');

function requireAuth(req, res, next) {
  if (!req.session || !req.session.authenticated) return res.redirect('/login');
  if (!req.session.tenantId) return res.redirect('/login');
  req.tenantId = req.session.tenantId;
  req.userId = req.session.userId;
  req.role = req.session.role;
  next();
}

const { shell } = require('../shared-shell');

function fmtDate(val) {
  if (!val) return '—';
  return new Date(val).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
}

// ═══════════════════════════════════════════════════════════════════════════════
// LISTS PAGE — GET /lists
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/', requireAuth, async (req, res) => {
  try {
    const { q = '', page = 1 } = req.query;
    const msg = req.query.msg || '';
    const limit = 50;
    const offset = (parseInt(page) - 1) * limit;

    let where = '';
    let params = [];
    if (q) {
      where = `WHERE l.list_name ILIKE $1`;
      params.push(`%${q}%`);
    }

    const countRes = await query(`SELECT COUNT(*) FROM lists l ${where}`, params);
    const total = parseInt(countRes.rows[0].count);

    const lists = await query(`
      SELECT
        l.id, l.list_name, l.list_type, l.source, l.active, l.upload_date, l.created_at,
        COUNT(pl.property_id) AS property_count
      FROM lists l
      LEFT JOIN property_lists pl ON pl.list_id = l.id
      ${where}
      GROUP BY l.id
      ORDER BY l.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, limit, offset]);

    const totalPages = Math.ceil(total / limit);

    const typeColors = {
      'Cold Call':  {bg:'#e8f0ff',tx:'#2c5cc5'},
      'SMS':        {bg:'#e8f5ee',tx:'#1a7a4a'},
      'Direct Mail':{bg:'#fff8e1',tx:'#9a6800'},
      'PPL':        {bg:'#fdf0f0',tx:'#c0392b'},
      'Referral':   {bg:'#f0f0ff',tx:'#5b4cc5'},
      'Driving for Dollars':{bg:'#fff0f8',tx:'#c54c8a'},
    };

    const listRows = lists.rows.length ? `
      <div style="background:#fff;border-radius:12px;border:1px solid #e0dfd8;overflow:hidden">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead>
            <tr style="border-bottom:1px solid #e0dfd8">
              <th style="padding:10px 16px;text-align:left;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.05em">List Name</th>
              <th style="padding:10px 16px;text-align:left;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.05em">Type</th>
              <th style="padding:10px 16px;text-align:left;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.05em">Source</th>
              <th style="padding:10px 16px;text-align:center;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.05em">Properties</th>
              <th style="padding:10px 16px;text-align:left;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.05em">Created</th>
              <th style="padding:10px 16px;text-align:right;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.05em">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${lists.rows.map(l => {
              const tc = typeColors[l.list_type] || {bg:'#f5f4f0',tx:'#555'};
              const sn = (l.list_name||'').replace(/'/g,"\\'");
              const st = (l.list_type||'').replace(/'/g,"\\'");
              const ss = (l.source||'').replace(/'/g,"\\'");
              return `<tr style="border-bottom:1px solid #f5f4f0" onmouseover="this.style.background='#fafaf8'" onmouseout="this.style.background=''">
                <td style="padding:13px 16px;font-weight:500;cursor:pointer" onclick="window.location='/records?list_id=${l.id}'">${l.list_name}</td>
                <td style="padding:13px 16px">${l.list_type?`<span style="background:${tc.bg};color:${tc.tx};padding:2px 9px;border-radius:5px;font-size:11px;font-weight:600">${l.list_type}</span>`:'<span style="color:#bbb;font-size:12px">—</span>'}</td>
                <td style="padding:13px 16px;color:#888;font-size:12px">${l.source||'—'}</td>
                <td style="padding:13px 16px;text-align:center;font-weight:600">${Number(l.property_count).toLocaleString()}</td>
                <td style="padding:13px 16px;color:#888;font-size:12px;white-space:nowrap">${fmtDate(l.created_at)}</td>
                <td style="padding:13px 16px;text-align:right">
                  <div style="display:inline-flex;gap:6px">
                    <a href="/records?list_id=${l.id}" style="padding:5px 12px;background:#f5f4f0;border:1px solid #e0dfd8;border-radius:6px;font-size:12px;color:#1a1a1a;text-decoration:none">View</a>
                    <button onclick="openEdit(${l.id},'${sn}','${st}','${ss}')" style="padding:5px 12px;background:#f5f4f0;border:1px solid #e0dfd8;border-radius:6px;font-size:12px;color:#1a1a1a;cursor:pointer;font-family:inherit">Edit</button>
                    <button onclick="confirmDelete(${l.id},'${sn}')" style="padding:5px 12px;background:#fff0f0;border:1px solid #f5c5c5;border-radius:6px;font-size:12px;color:#c0392b;cursor:pointer;font-family:inherit">Delete</button>
                  </div>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>` : '<div class="empty-state">No lists yet — import a property list to get started</div>';

    const pagination = totalPages > 1 ? `
      <div class="pagination">
        <span>Showing ${offset+1}–${Math.min(offset+limit,total)} of ${total.toLocaleString()}</span>
        <div style="display:flex;gap:6px">
          ${parseInt(page)>1?`<a href="/lists?q=${encodeURIComponent(q)}&page=${parseInt(page)-1}">← Prev</a>`:''}
          ${parseInt(page)<totalPages?`<a href="/lists?q=${encodeURIComponent(q)}&page=${parseInt(page)+1}">Next →</a>`:''}
        </div>
      </div>` : '';

    res.send(shell('Lists', `
      ${msg==='saved'?'<div class="alert alert-success">✓ Changes saved</div>':''}
      ${msg==='deleted'?'<div class="alert alert-success">✓ List deleted</div>':''}
      ${msg==='error'?'<div class="alert alert-error">Something went wrong</div>':''}

      <div class="page-header">
        <div class="page-title">Lists <span class="count-pill">${total.toLocaleString()}</span></div>
      </div>

      <form method="GET" action="/lists">
        <div class="search-bar">
          <input type="text" name="q" value="${q}" placeholder="Search lists…" autocomplete="off">
          <button type="submit">Search</button>
          ${q?`<a href="/lists" style="padding:9px 14px;background:#fff;border:1px solid #ddd;border-radius:8px;font-size:13px;color:#888;text-decoration:none">Clear</a>`:''}
        </div>
      </form>

      ${listRows || '<div class="empty-state">No lists found</div>'}
      ${pagination}

      <!-- EDIT MODAL -->
      <div class="modal-overlay" id="edit-modal">
        <div class="modal">
          <div class="modal-header">
            <div class="modal-title">Edit List</div>
            <button class="modal-close" onclick="closeEdit()">×</button>
          </div>
          <form method="POST" action="/lists/edit" id="edit-form">
            <input type="hidden" name="id" id="edit-id">
            <div class="form-field">
              <label>List Name</label>
              <input type="text" name="list_name" id="edit-name" required>
            </div>
            <div class="form-field">
              <label>List Type</label>
              <select name="list_type" id="edit-type">
                <option value="">— None —</option>
                ${['Absentee','Vacant','Pre-Foreclosure','High Equity','Tax Delinquent','Probate','Pre-FC','SFR','MFR','Other'].map(t=>`<option value="${t}">${t}</option>`).join('')}
              </select>
            </div>
            <div class="form-field">
              <label>Source</label>
              <select name="source" id="edit-source">
                <option value="">— None —</option>
                <option value="PropStream">PropStream</option><option value="DealMachine">DealMachine</option><option value="BatchSkipTracing">BatchSkipTracing</option><option value="REISift">REISift</option><option value="DataSift">DataSift</option><option value="Listsource">Listsource</option><option value="Manual">Manual</option>
              </select>
            </div>
            <div class="btn-row">
              <button type="submit" class="btn-primary">Save</button>
              <button type="button" class="btn-ghost" onclick="closeEdit()">Cancel</button>
            </div>
          </form>
        </div>
      </div>

      <!-- DELETE CONFIRM MODAL -->
      <div class="modal-overlay" id="delete-modal">
        <div class="modal">
          <div class="modal-header">
            <div class="modal-title">Delete List</div>
            <button class="modal-close" onclick="closeDelete()">×</button>
          </div>
          <p style="font-size:14px;color:#555;margin-bottom:1.25rem">Are you sure you want to delete <strong id="delete-name"></strong>? This cannot be undone.</p>
          <form method="POST" action="/lists/delete" id="delete-form">
            <input type="hidden" name="id" id="delete-id">
            <div style="margin-bottom:1rem">
              <label style="font-size:12px;font-weight:600;color:#666;display:block;margin-bottom:4px">Delete code</label>
              <input type="password" name="code" required autocomplete="off" style="width:100%;padding:8px 10px;border:1px solid #ddd;border-radius:7px;font-size:14px;font-family:inherit" placeholder="Enter delete code">
            </div>
            <div class="btn-row">
              <button type="submit" class="btn-primary" style="background:#c0392b">Delete</button>
              <button type="button" class="btn-ghost" onclick="closeDelete()">Cancel</button>
            </div>
          </form>
        </div>
      </div>

      <script>
      // Close dropdowns on outside click
      document.addEventListener('click', function(e) {
        if (!e.target.closest('.dots-btn')) {
          document.querySelectorAll('.dropdown').forEach(d => d.classList.remove('open'));
        }
      });
      function toggleMenu(e, id) {
        e.stopPropagation();
        document.querySelectorAll('.dropdown').forEach(d => { if(d.id!==id) d.classList.remove('open'); });
        document.getElementById(id).classList.toggle('open');
      }
      function openEdit(id, name, type, source) {
        document.getElementById('edit-id').value = id;
        document.getElementById('edit-name').value = name;
        const sel = document.getElementById('edit-type');
        for (let i=0;i<sel.options.length;i++) { if(sel.options[i].value===type){sel.selectedIndex=i;break;} }
        const srcEl = document.getElementById('edit-source');
        if (srcEl) { for (let i=0;i<srcEl.options.length;i++) { if(srcEl.options[i].value===source){srcEl.selectedIndex=i;break;} } }
        document.getElementById('edit-modal').classList.add('open');
      }
      function closeEdit() { document.getElementById('edit-modal').classList.remove('open'); }
      function confirmDelete(id, name) {
        document.getElementById('delete-id').value = id;
        document.getElementById('delete-name').textContent = name;
        document.getElementById('delete-modal').classList.add('open');
        document.querySelectorAll('.dropdown').forEach(d=>d.classList.remove('open'));
      }
      function closeDelete() { document.getElementById('delete-modal').classList.remove('open'); }
      </script>
    `, 'lists'));
  } catch(e) {
    console.error(e);
    res.status(500).send('Server error: ' + e.message);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// EDIT — POST /lists/edit
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/edit', requireAuth, async (req, res) => {
  try {
    const { id, list_name, list_type, source } = req.body;
    await query(`UPDATE lists SET list_name=$1, list_type=COALESCE(NULLIF($2,''),list_type), source=COALESCE(NULLIF($3,''),source) WHERE id=$4`,
      [list_name, list_type, source, id]);
    res.redirect('/lists?msg=saved');
  } catch(e) {
    console.error(e);
    res.redirect('/lists?msg=error');
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// DELETE — POST /lists/delete
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/delete', requireAuth, async (req, res) => {
  try {
    const { id, code } = req.body;
    // 2026-04-18 audit fix #41: lists delete was ungated. The records delete,
    // bulk merges ≥10 groups, and single property delete all require the
    // delete code (see settings.verifyDeleteCode). Deleting a list wipes
    // every property→list membership row for that list, a similarly
    // destructive operation. Now gated the same way for consistency.
    const verified = await settings.verifyDeleteCode(code);
    if (!verified) {
      return res.redirect('/lists?msg=error&err=' + encodeURIComponent('Invalid delete code.'));
    }
    await query(`DELETE FROM property_lists WHERE list_id=$1`, [id]);
    await query(`DELETE FROM lists WHERE id=$1`, [id]);
    res.redirect('/lists?msg=deleted');
  } catch(e) {
    console.error(e);
    res.redirect('/lists?msg=error');
  }
});

module.exports = router;
