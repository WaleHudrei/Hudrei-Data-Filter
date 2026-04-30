// ═══════════════════════════════════════════════════════════════════════════
// ui/pages/list-registry.js
// Ocular's List Registry. Spreadsheet-like grid where each row is a
// list_templates row — the recurring "type of list we pull every N days"
// abstraction that powers the dashboard's "lists overdue" badge.
//
// Inline editing: every cell auto-saves on blur/change via POST to
// /oculah/lists/types/:id with field+value. Mark-pulled stamps last_pull_date
// to today. Add Row creates a blank template via POST /oculah/lists/types.
// ═══════════════════════════════════════════════════════════════════════════
const { shell }   = require('../layouts/shell');
const { kpiCard } = require('../components/kpi-card');
const { escHTML, fmtNum } = require('../_helpers');

const ACTION_LABELS = { pull: 'Pull', paused: 'Paused', '': '—' };
const TIER_LABELS = {
  s_tier: 'S.Tier', stack_only: 'Stack Only',
  tier_1: 'Tier 1', tier_2: 'Tier 2', '': '—',
};
const FREQ_LABELS = {
  '1':   'Daily',
  '7':   'Every 7 days',
  '14':  'Every 14 days',
  '30':  'Every 30 days',
  '60':  'Every 60 days',
  '90':  'Every 90 days',
  '180': 'Every 6 months',
  '365': 'Once a year',
  '':    '—',
};
const VALID_SOURCES = ['Dealmachine','County','Propstream','Propwire',''];
const STATES = ['','AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI',
  'ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO',
  'MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI',
  'SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'];

function nextPullDate(lastPullDate, frequencyDays) {
  if (!lastPullDate || !frequencyDays) return null;
  const d = new Date(lastPullDate);
  d.setDate(d.getDate() + Number(frequencyDays));
  return d;
}
function isOverdue(lastPullDate, frequencyDays) {
  const next = nextPullDate(lastPullDate, frequencyDays);
  return next ? next < new Date() : false;
}
function isDueSoon(lastPullDate, frequencyDays) {
  const next = nextPullDate(lastPullDate, frequencyDays);
  if (!next) return false;
  const soon = new Date(); soon.setDate(soon.getDate() + 7);
  return next >= new Date() && next <= soon;
}
function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
}

function selectCell(field, currentValue, options, rowId) {
  const opts = options.map(opt => {
    const [val, label] = Array.isArray(opt) ? opt : [opt, opt];
    const sel = String(currentValue || '') === String(val) ? 'selected' : '';
    return `<option value="${escHTML(val)}" ${sel}>${escHTML(label || '—')}</option>`;
  }).join('');
  return `<select class="ocu-cell-input" data-field="${field}" onchange="lr_save(${rowId}, '${field}', this.value)">${opts}</select>`;
}

function rowHTML(r) {
  const over = isOverdue(r.last_pull_date, r.frequency_days);
  const soon = isDueSoon(r.last_pull_date, r.frequency_days);
  const next = nextPullDate(r.last_pull_date, r.frequency_days);
  const nextLabel = next ? fmtDate(next) : '—';
  const nextStyle = over ? 'color:#c0392b;font-weight:600'
                  : soon ? 'color:#c07a1a;font-weight:600'
                  : 'color:var(--ocu-text-2)';
  const lastDate = r.last_pull_date ? new Date(r.last_pull_date).toISOString().slice(0, 10) : '';

  return `<tr data-id="${r.id}">
    <td class="ocu-td">${selectCell('action', r.action, Object.entries(ACTION_LABELS), r.id)}</td>
    <td class="ocu-td">${selectCell('state_code', r.state_code, STATES.map(s => [s, s || '—']), r.id)}</td>
    <td class="ocu-td">
      <input class="ocu-cell-input" type="text" value="${escHTML(r.list_name)}"
             onblur="lr_save(${r.id}, 'list_name', this.value)"
             onkeydown="if(event.key==='Enter')this.blur()" />
    </td>
    <td class="ocu-td">${selectCell('list_tier', r.list_tier, Object.entries(TIER_LABELS), r.id)}</td>
    <td class="ocu-td">${selectCell('source', r.source, [...VALID_SOURCES.map(s => [s, s || '—']), ['Other', 'Other']], r.id)}</td>
    <td class="ocu-td">${selectCell('frequency_days', r.frequency_days != null ? String(r.frequency_days) : '', Object.entries(FREQ_LABELS), r.id)}</td>
    <td class="ocu-td">
      <select class="ocu-cell-input" onchange="lr_save(${r.id}, 'require_bot', this.value)">
        <option value=""      ${r.require_bot === null ? 'selected' : ''}>—</option>
        <option value="true"  ${r.require_bot === true  ? 'selected' : ''}>Yes</option>
        <option value="false" ${r.require_bot === false ? 'selected' : ''}>No</option>
      </select>
    </td>
    <td class="ocu-td ocu-td-date">
      <input class="ocu-cell-input" type="date" value="${lastDate}"
             onchange="lr_save(${r.id}, 'last_pull_date', this.value)" />
    </td>
    <td class="ocu-td ocu-td-date" style="${nextStyle}">${escHTML(nextLabel)}</td>
    <td class="ocu-td ocu-lr-actions">
      <button type="button" class="ocu-lr-action-btn ocu-lr-action-pull" onclick="lr_pull(${r.id})" title="Mark pulled today">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        <span>Pulled</span>
      </button>
      <button type="button" class="ocu-lr-action-btn ocu-lr-action-delete" onclick="lr_delete(${r.id})" title="Delete row">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
      </button>
    </td>
  </tr>`;
}

function listRegistry(data = {}) {
  const rows = Array.isArray(data.rows) ? data.rows : [];
  const flash = data.flash || {};
  const total = rows.length;
  const overdue = rows.filter(r => isOverdue(r.last_pull_date, r.frequency_days)).length;
  const dueSoon = rows.filter(r => isDueSoon(r.last_pull_date, r.frequency_days)).length;
  const neverPulled = rows.filter(r => r.action === 'pull' && !r.last_pull_date).length;

  const flashHTML = flash.msg
    ? `<div class="ocu-card" style="margin-bottom:14px;background:#e8f5ee;border-color:#9bd0a8;color:#1a5f1a;padding:12px 16px;font-size:13px">${escHTML(flash.msg)}</div>`
    : flash.err
    ? `<div class="ocu-card" style="margin-bottom:14px;background:#fdeaea;border-color:#f5c5c5;color:#8b1f1f;padding:12px 16px;font-size:13px">${escHTML(flash.err)}</div>`
    : '';

  const kpiStrip = `
    <div class="ocu-kpi-row" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr));margin-bottom:18px">
      ${kpiCard({ label: 'Total list types', value: total, featured: true })}
      ${kpiCard({ label: 'Overdue', value: overdue, valueClass: overdue > 0 ? 'burning' : '' })}
      ${kpiCard({ label: 'Due this week', value: dueSoon })}
      ${kpiCard({ label: 'Never pulled', value: neverPulled })}
    </div>`;

  const tableHTML = rows.length === 0
    ? `<div class="ocu-empty">No list types defined yet. Click "+ Add row" above to create your first.</div>`
    : `
      <div class="ocu-table-wrap">
        <table class="ocu-table ocu-list-registry-table">
          <thead>
            <tr>
              <th class="ocu-th" style="min-width:110px">Action</th>
              <th class="ocu-th" style="min-width:78px">State</th>
              <th class="ocu-th" style="min-width:240px">List name</th>
              <th class="ocu-th" style="min-width:120px">Tier</th>
              <th class="ocu-th" style="min-width:130px">Source</th>
              <th class="ocu-th" style="min-width:160px">Frequency</th>
              <th class="ocu-th" style="min-width:90px">Bot</th>
              <th class="ocu-th ocu-th-date" style="min-width:150px">Last pull</th>
              <th class="ocu-th ocu-th-date" style="min-width:130px">Next pull</th>
              <th class="ocu-th" style="min-width:140px;text-align:right">Actions</th>
            </tr>
          </thead>
          <tbody id="lr-tbody">${rows.map(rowHTML).join('')}</tbody>
        </table>
      </div>`;

  const body = `
    <div style="display:flex;justify-content:flex-end;margin-bottom:14px">
      <button class="ocu-btn ocu-btn-primary" onclick="lr_addRow()">+ Add row</button>
    </div>

    ${flashHTML}
    ${kpiStrip}
    ${tableHTML}

    <script>
      // Inline auto-save: POST single field+value, swap row HTML on success.
      async function lr_save(id, field, value) {
        try {
          var r = await fetch('/oculah/lists/types/' + id, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'field=' + encodeURIComponent(field) + '&value=' + encodeURIComponent(value),
          });
          if (!r.ok) throw new Error('save failed');
          // Server returns the freshly-rendered row HTML so date math stays in sync.
          var html = await r.text();
          if (html && html.trim()) {
            var tr = document.querySelector('tr[data-id="' + id + '"]');
            if (tr) {
              var tmp = document.createElement('tbody');
              tmp.innerHTML = html;
              if (tmp.firstElementChild) tr.parentNode.replaceChild(tmp.firstElementChild, tr);
            }
          }
        } catch (e) {
          console.warn('[list-registry] save:', e.message);
          alert('Save failed: ' + e.message);
        }
      }
      async function lr_pull(id) {
        try {
          var r = await fetch('/oculah/lists/types/' + id + '/pull', { method: 'POST' });
          if (!r.ok) throw new Error('pull failed');
          location.reload();
        } catch (e) { alert('Failed: ' + e.message); }
      }
      async function lr_delete(id) {
        if (!confirm('Delete this list type? This cannot be undone.')) return;
        try {
          var r = await fetch('/oculah/lists/types/' + id + '/delete', { method: 'POST' });
          if (!r.ok) throw new Error('delete failed');
          var tr = document.querySelector('tr[data-id="' + id + '"]');
          if (tr) tr.remove();
        } catch (e) { alert('Failed: ' + e.message); }
      }
      async function lr_addRow() {
        try {
          var r = await fetch('/oculah/lists/types', { method: 'POST' });
          if (!r.ok) throw new Error('add failed');
          location.reload();
        } catch (e) { alert('Failed: ' + e.message); }
      }
    </script>`;

  return shell({
    title:          'List Registry',
    topbarTitle:    'List Registry',
    topbarSubtitle: 'Track every list type you pull — when it was last pulled and when it\'s due again',
    activePage:     'list-registry',
    user:           data.user,
    badges:         data.badges || {},
    body,
  });
}

module.exports = { listRegistry, rowHTML };
