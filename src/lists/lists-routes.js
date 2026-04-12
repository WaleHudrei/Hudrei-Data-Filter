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
.main{max-width:1000px;margin:0 auto;padding:2rem 1.5rem}
.page-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:1.5rem;flex-wrap:wrap;gap:12px}
.page-title{font-size:20px;font-weight:600}
.count-pill{display:inline-block;background:#f0efe9;color:#555;font-size:11px;font-weight:600;padding:2px 8px;border-radius:12px;margin-left:6px}
.search-bar{display:flex;gap:8px;margin-bottom:1.25rem}
.search-bar input{flex:1;padding:9px 14px;border:1px solid #ddd;border-radius:8px;font-size:14px;font-family:inherit;background:#fff}
.search-bar input:focus{outline:none;border-color:#888}
.search-bar button{padding:9px 18px;background:#1a1a1a;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:500;cursor:pointer;font-family:inherit}
.list-row{background:#fff;border:1px solid #e0dfd8;border-radius:10px;padding:14px 18px;margin-bottom:8px;display:flex;align-items:center;gap:16px;transition:box-shadow .15s}
.list-row:hover{box-shadow:0 2px 8px rgba(0,0,0,.06)}
.list-name{font-size:14px;font-weight:600;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:500px}
.list-count{font-size:13px;color:#888;white-space:nowrap;min-width:110px}
.btn-show{padding:7px 14px;background:#f5f4f0;border:1px solid #e0dfd8;border-radius:7px;font-size:13px;font-weight:500;color:#1a1a1a;text-decoration:none;white-space:nowrap;transition:all .15s}
.btn-show:hover{background:#1a1a1a;color:#fff;border-color:#1a1a1a}
.dots-btn{background:none;border:none;cursor:pointer;padding:6px 8px;border-radius:6px;color:#888;font-size:18px;line-height:1;position:relative}
.dots-btn:hover{background:#f5f4f0;color:#1a1a1a}
.dropdown{display:none;position:absolute;right:0;top:100%;background:#fff;border:1px solid #e0dfd8;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.1);min-width:120px;z-index:100;overflow:hidden}
.dropdown.open{display:block}
.dropdown a,.dropdown button{display:block;width:100%;padding:10px 14px;font-size:13px;color:#1a1a1a;text-decoration:none;background:none;border:none;text-align:left;cursor:pointer;font-family:inherit}
.dropdown a:hover,.dropdown button:hover{background:#f5f4f0}
.dropdown .delete-btn{color:#c0392b}
.dropdown .delete-btn:hover{background:#fdf0f0}
.empty-state{text-align:center;padding:4rem;color:#888;font-size:14px}
.alert{padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:1rem}
.alert-success{background:#e8f5ee;color:#1a7a4a;border:1px solid #c3e6cc}
.alert-error{background:#fdf0f0;color:#c0392b;border:1px solid #f5c5c5}
.modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:200;align-items:center;justify-content:center}
.modal-overlay.open{display:flex}
.modal{background:#fff;border-radius:14px;padding:1.5rem;width:100%;max-width:440px;box-shadow:0 20px 60px rgba(0,0,0,.2)}
.modal-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:1.25rem}
.modal-title{font-size:16px;font-weight:600}
.modal-close{background:none;border:none;font-size:20px;color:#888;cursor:pointer}
.form-field{margin-bottom:1rem}
.form-field label{font-size:13px;color:#555;display:block;margin-bottom:4px;font-weight:500}
.form-field input,.form-field select{width:100%;padding:9px 12px;border:1px solid #ddd;border-radius:8px;font-size:14px;background:#fafaf8;font-family:inherit}
.form-field input:focus,.form-field select:focus{outline:none;border-color:#888}
.btn-row{display:flex;gap:8px}
.btn-primary{padding:9px 18px;background:#1a1a1a;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:500;cursor:pointer;font-family:inherit;flex:1}
.btn-primary:hover{background:#333}
.btn-ghost{padding:9px 18px;background:#fff;color:#1a1a1a;border:1px solid #ddd;border-radius:8px;font-size:13px;font-weight:500;cursor:pointer;font-family:inherit}
.btn-ghost:hover{background:#f5f4f0}
.pagination{display:flex;align-items:center;justify-content:space-between;margin-top:1rem;font-size:13px;color:#888}
.pagination a{padding:6px 12px;background:#fff;border:1px solid #ddd;border-radius:7px;color:#1a1a1a;text-decoration:none;font-size:13px}
.pagination a:hover{background:#f5f4f0}
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
    <a href="/lists" class="sidebar-link ${activePage==='lists'?'active':''}">
      <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 12h6M9 16h4"/></svg>
      Lists
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
        l.id, l.list_name, l.list_type, l.active, l.upload_date, l.created_at,
        COUNT(pl.property_id) AS property_count
      FROM lists l
      LEFT JOIN property_lists pl ON pl.list_id = l.id
      ${where}
      GROUP BY l.id
      ORDER BY l.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, limit, offset]);

    const totalPages = Math.ceil(total / limit);

    const listRows = lists.rows.map(l => `
      <div class="list-row">
        <div class="list-name" title="${l.list_name}">${l.list_name}</div>
        <div class="list-count">${Number(l.property_count).toLocaleString()} properties</div>
        <a href="/records?list_id=${l.id}" class="btn-show">Show Properties</a>
        <div style="position:relative">
          <button class="dots-btn" onclick="toggleMenu(event,'menu-${l.id}')">⋯</button>
          <div class="dropdown" id="menu-${l.id}">
            <button onclick="openEdit(${l.id},'${l.list_name.replace(/'/g,"\\'")}','${l.list_type||''}')">Edit</button>
            <button class="delete-btn" onclick="confirmDelete(${l.id},'${l.list_name.replace(/'/g,"\\'")}')">Delete</button>
          </div>
        </div>
      </div>`).join('');

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
      function openEdit(id, name, type) {
        document.getElementById('edit-id').value = id;
        document.getElementById('edit-name').value = name;
        const sel = document.getElementById('edit-type');
        for (let i=0; i<sel.options.length; i++) { if(sel.options[i].value===type) { sel.selectedIndex=i; break; } }
        document.getElementById('edit-modal').classList.add('open');
        document.querySelectorAll('.dropdown').forEach(d=>d.classList.remove('open'));
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
    const { id, list_name, list_type } = req.body;
    await query(`UPDATE lists SET list_name=$1, list_type=COALESCE(NULLIF($2,''),list_type) WHERE id=$3`,
      [list_name, list_type, id]);
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
    const { id } = req.body;
    await query(`DELETE FROM property_lists WHERE list_id=$1`, [id]);
    await query(`DELETE FROM lists WHERE id=$1`, [id]);
    res.redirect('/lists?msg=deleted');
  } catch(e) {
    console.error(e);
    res.redirect('/lists?msg=error');
  }
});

module.exports = router;
