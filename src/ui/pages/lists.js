// ═══════════════════════════════════════════════════════════════════════════
// ui/pages/lists.js
// Ocular Lists page. Shows every list in the tenant with property count,
// type, source, and created date. Inline Edit/Delete via Ocular endpoints
// (delete code required for Delete, same as old Loki).
// ═══════════════════════════════════════════════════════════════════════════
const { shell } = require('../layouts/shell');
const { escHTML, fmtNum, fmtRelative } = require('../_helpers');

function listTypeBadge(t) {
  if (!t) return '<span class="ocu-text-3">—</span>';
  return `<span class="ocu-pill" data-list-type="${escHTML(t)}">${escHTML(t)}</span>`;
}

function listRow(l) {
  const safeName = JSON.stringify(l.list_name || '');
  const safeType = JSON.stringify(l.list_type || '');
  const safeSrc  = JSON.stringify(l.source || '');
  return `<tr>
    <td>
      <a href="/ocular/records?list_id=${l.id}" class="ocu-link" style="font-weight:500">${escHTML(l.list_name)}</a>
    </td>
    <td>${listTypeBadge(l.list_type)}</td>
    <td class="ocu-text-3">${l.source ? escHTML(l.source) : '—'}</td>
    <td class="ocu-text-right ocu-mono">${fmtNum(l.property_count)}</td>
    <td class="ocu-text-3 ocu-mono" style="font-size:11px;white-space:nowrap">${fmtRelative(l.created_at)}</td>
    <td class="ocu-text-right" style="white-space:nowrap">
      <a href="/ocular/records?list_id=${l.id}" class="ocu-btn ocu-btn-secondary">View</a>
      <button class="ocu-btn ocu-btn-secondary" onclick="lists_openEdit(${l.id}, ${safeName}, ${safeType}, ${safeSrc})">Edit</button>
      <button class="ocu-btn ocu-btn-secondary" style="color:#c0392b" onclick="lists_openDelete(${l.id}, ${safeName})">Delete</button>
    </td>
  </tr>`;
}

const LIST_TYPES = [
  'Absentee','Vacant','Pre-Foreclosure','High Equity',
  'Tax Delinquent','Probate','Pre-FC','SFR','MFR','Other',
];
const SOURCES = [
  'PropStream','DealMachine','BatchSkipTracing','REISift',
  'DataSift','Listsource','Manual',
];

/**
 * @param {Object} data
 *   - user, badges
 *   - rows: array of lists rows joined with property_count
 *   - total, page, limit, querystring
 *   - filters: { q }
 *   - flash: { msg?, err? }
 */
function listsPage(data = {}) {
  const rows = Array.isArray(data.rows) ? data.rows : [];
  const total = data.total || 0;
  const page = data.page || 1;
  const limit = data.limit || 50;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const filters = data.filters || {};
  const flash = data.flash || {};

  const flashHTML = flash.msg
    ? `<div class="ocu-card" style="margin-bottom:14px;background:#e8f5ee;border-color:#9bd0a8;color:#1a5f1a;padding:12px 16px;font-size:13px">${escHTML(flash.msg)}</div>`
    : flash.err
    ? `<div class="ocu-card" style="margin-bottom:14px;background:#fdeaea;border-color:#f5c5c5;color:#8b1f1f;padding:12px 16px;font-size:13px">${escHTML(flash.err)}</div>`
    : '';

  const filterBar = `
    <form method="GET" action="/ocular/lists" class="ocu-card" style="padding:12px 14px;margin-bottom:14px;display:grid;grid-template-columns:1fr auto;gap:10px;align-items:end">
      <div>
        <label class="ocu-form-label">Search lists</label>
        <input type="text" name="q" value="${escHTML(filters.q || '')}" placeholder="List name…" class="ocu-input" />
      </div>
      <div style="display:flex;gap:6px">
        <button type="submit" class="ocu-btn ocu-btn-primary">Filter</button>
        ${filters.q ? `<a href="/ocular/lists" class="ocu-btn ocu-btn-ghost">Reset</a>` : ''}
      </div>
    </form>`;

  const tableHTML = rows.length === 0
    ? `<div class="ocu-empty">No lists yet — import a property list to get started.</div>`
    : `
      <div class="ocu-table-wrap">
        <table class="ocu-table">
          <thead>
            <tr>
              <th>List name</th>
              <th>Type</th>
              <th>Source</th>
              <th class="ocu-text-right">Properties</th>
              <th>Created</th>
              <th class="ocu-text-right">Actions</th>
            </tr>
          </thead>
          <tbody>${rows.map(listRow).join('')}</tbody>
        </table>
      </div>
      ${pager({ page, totalPages, querystring: data.querystring })}`;

  // ─── Edit modal ───────────────────────────────────────────────────────
  const editModal = `
    <div class="ocu-modal-overlay" id="lists-edit-modal" onclick="if (event.target.id === 'lists-edit-modal') lists_closeEdit()">
      <div class="ocu-modal">
        <div class="ocu-modal-header">
          <div class="ocu-modal-title">Edit list</div>
          <button class="ocu-modal-close" onclick="lists_closeEdit()">×</button>
        </div>
        <form method="POST" action="/ocular/lists/edit" id="lists-edit-form">
          <input type="hidden" name="id" id="edit-list-id" />
          <div style="margin-bottom:12px">
            <label class="ocu-form-label">List name</label>
            <input type="text" name="list_name" id="edit-list-name" required class="ocu-input" />
          </div>
          <div style="margin-bottom:12px">
            <label class="ocu-form-label">Type</label>
            <select name="list_type" id="edit-list-type" class="ocu-input">
              <option value="">— None —</option>
              ${LIST_TYPES.map(t => `<option value="${escHTML(t)}">${escHTML(t)}</option>`).join('')}
            </select>
          </div>
          <div style="margin-bottom:16px">
            <label class="ocu-form-label">Source</label>
            <select name="source" id="edit-list-source" class="ocu-input">
              <option value="">— None —</option>
              ${SOURCES.map(s => `<option value="${escHTML(s)}">${escHTML(s)}</option>`).join('')}
            </select>
          </div>
          <div style="display:flex;gap:6px;justify-content:flex-end">
            <button type="button" class="ocu-btn ocu-btn-ghost" onclick="lists_closeEdit()">Cancel</button>
            <button type="submit" class="ocu-btn ocu-btn-primary">Save</button>
          </div>
        </form>
      </div>
    </div>`;

  // ─── Delete modal (delete code required) ──────────────────────────────
  const deleteModal = `
    <div class="ocu-modal-overlay" id="lists-delete-modal" onclick="if (event.target.id === 'lists-delete-modal') lists_closeDelete()">
      <div class="ocu-modal">
        <div class="ocu-modal-header">
          <div class="ocu-modal-title">Delete list</div>
          <button class="ocu-modal-close" onclick="lists_closeDelete()">×</button>
        </div>
        <p style="font-size:13px;color:var(--ocu-text-2);line-height:1.5;margin-bottom:14px">
          You're about to delete <strong id="delete-list-name" style="color:var(--ocu-text-1)"></strong>.
          This removes the list and every property's membership in it. The properties themselves stay.
          <br><br>
          This cannot be undone.
        </p>
        <form method="POST" action="/ocular/lists/delete" id="lists-delete-form">
          <input type="hidden" name="id" id="delete-list-id" />
          <div style="margin-bottom:14px">
            <label class="ocu-form-label">Delete code</label>
            <input type="password" name="code" required autocomplete="off" class="ocu-input" placeholder="Enter delete code" />
          </div>
          <div style="display:flex;gap:6px;justify-content:flex-end">
            <button type="button" class="ocu-btn ocu-btn-ghost" onclick="lists_closeDelete()">Cancel</button>
            <button type="submit" class="ocu-btn ocu-btn-primary" style="background:#c0392b">Delete</button>
          </div>
        </form>
      </div>
    </div>`;

  const body = `
    <div class="ocu-page-header">
      <div>
        <h1 class="ocu-page-title">Lists</h1>
        <div class="ocu-page-subtitle">${fmtNum(total)} list${total === 1 ? '' : 's'}</div>
      </div>
      <div>
        <a href="/import/property" class="ocu-btn ocu-btn-primary">+ Import new list</a>
      </div>
    </div>

    ${flashHTML}
    ${filterBar}
    ${tableHTML}
    ${editModal}
    ${deleteModal}

    <script>
      function lists_openEdit(id, name, type, source) {
        document.getElementById('edit-list-id').value = id;
        document.getElementById('edit-list-name').value = name || '';
        var typeSel = document.getElementById('edit-list-type');
        for (var i = 0; i < typeSel.options.length; i++) {
          if (typeSel.options[i].value === (type || '')) { typeSel.selectedIndex = i; break; }
        }
        var srcSel = document.getElementById('edit-list-source');
        for (var j = 0; j < srcSel.options.length; j++) {
          if (srcSel.options[j].value === (source || '')) { srcSel.selectedIndex = j; break; }
        }
        document.getElementById('lists-edit-modal').classList.add('open');
      }
      function lists_closeEdit() { document.getElementById('lists-edit-modal').classList.remove('open'); }
      function lists_openDelete(id, name) {
        document.getElementById('delete-list-id').value = id;
        document.getElementById('delete-list-name').textContent = name;
        document.getElementById('lists-delete-modal').classList.add('open');
      }
      function lists_closeDelete() { document.getElementById('lists-delete-modal').classList.remove('open'); }
    </script>`;

  return shell({
    title:      'Lists',
    activePage: 'lists',
    user:       data.user,
    badges:     data.badges || {},
    body,
  });
}

function pager({ page, totalPages, querystring }) {
  if (totalPages <= 1) return '';
  const baseQS = (querystring || '').split('&').filter(p => p && !p.startsWith('page=')).join('&');
  const qsWith = (n) => baseQS ? `?${baseQS}&page=${n}` : `?page=${n}`;
  const prev = page > 1          ? `<a href="${qsWith(page - 1)}" class="ocu-btn ocu-btn-secondary">← Prev</a>` : '';
  const next = page < totalPages ? `<a href="${qsWith(page + 1)}" class="ocu-btn ocu-btn-secondary">Next →</a>` : '';
  return `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:14px">
      <div class="ocu-text-3" style="font-size:12px">Page ${page} of ${totalPages}</div>
      <div style="display:flex;gap:8px">${prev}${next}</div>
    </div>`;
}

module.exports = { listsPage };
