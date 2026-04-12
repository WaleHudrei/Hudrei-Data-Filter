const express = require('express');
const router = express.Router();
const { query } = require('../db');

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.redirect('/login');
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
