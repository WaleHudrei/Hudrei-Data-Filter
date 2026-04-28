// ═══════════════════════════════════════════════════════════════════════════
// ui/pages/list-registry.js
// Ocular's List Registry. Spreadsheet-like grid where each row is a
// list_templates row — the recurring "type of list we pull every N days"
// abstraction that powers the dashboard's "lists overdue" badge.
//
// Inline editing: every cell auto-saves on blur/change via POST to
// /ocular/lists/types/:id with field+value. Mark-pulled stamps last_pull_date
// to today. Add Row creates a blank template via POST /ocular/lists/types.
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
    <td>${selectCell('action', r.action, Object.entries(ACTION_LABELS), r.id)}</td>
    <td>${selectCell('state_code', r.state_code, STATES.map(s => [s, s || '—']), r.id)}</td>
    <td>
      <input class="ocu-cell-input" type="text" value="${escHTML(r.list_name)}"
             onblur="lr_save(${r.id}, 'list_name', this.value)"
             onkeydown="if(event.key==='Enter')this.blur()" />
    </td>
    <td>${selectCell('list_tier', r.list_tier, Object.entries(TIER_LABELS), r.id)}</td>
    <td>${selectCell('source', r.source, [...VALID_SOURCES.map(s => [s, s || '—']), ['Other', 'Other']], r.id)}</td>
    <td>${selectCell('frequency_days', r.frequency_days != null ? String(r.frequency_days) : '', Object.entries(FREQ_LABELS), r.id)}</td>
    <td>
      <select class="ocu-cell-input" onchange="lr_save(${r.id}, 'require_bot', this.value)">
        <option value=""      ${r.require_bot === null ? 'selected' : ''}>—</option>
        <option value="true"  ${r.require_bot === true  ? 'selected' : ''}>Yes</option>
        <option value="false" ${r.require_bot === false ? 'selected' : ''}>No</option>
      </select>
    </td>
    <td>
      <input class="ocu-cell-input" type="date" value="${lastDate}"
             onchange="lr_save(${r.id}, 'last_pull_date', this.value)" />
    </td>
    <td style="${nextStyle}">${escHTML(nextLabel)}</td>
    <td class="ocu-text-right" style="white-space:nowrap">
      <button class="ocu-btn ocu-btn-primary" style="padding:4px 10px;font-size:11px" onclick="lr_pull(${r.id})">✓ Pulled</button>
      <button class="ocu-btn ocu-btn-ghost" style="padding:4px 8px;font-size:14px;color:#c0392b" onclick="lr_delete(${r.id})" title="Delete row">×</button>
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
              <th style="width:90px">Action</th>
              <th style="width:70px">State</th>
              <th>List name</th>
              <th style="width:110px">Tier</th>
              <th style="width:120px">Source</th>
              <th style="width:140px">Frequency</th>
              <th style="width:80px">Bot</th>
              <th style="width:140px">Last pull</th>
              <th style="width:130px">Next pull</th>
              <th class="ocu-text-right" style="width:130px">Actions</th>
            </tr>
          </thead>
          <tbody id="lr-tbody">${rows.map(rowHTML).join('')}</tbody>
        </table>
      </div>`;

  const body = `
    <div class="ocu-page-header">
      <div>
        <h1 class="ocu-page-title">List Registry</h1>
        <div class="ocu-page-subtitle">Track every list type you pull — when it was last pulled and when it's due again</div>
      </div>
      <button class="ocu-btn ocu-btn-primary" onclick="lr_addRow()">+ Add row</button>
    </div>

    ${flashHTML}
    ${kpiStrip}
    ${tableHTML}

    <script>
      // Inline auto-save: POST single field+value, swap row HTML on success.
      async function lr_save(id, field, value) {
        try {
          var r = await fetch('/ocular/lists/types/' + id, {
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
          var r = await fetch('/ocular/lists/types/' + id + '/pull', { method: 'POST' });
          if (!r.ok) throw new Error('pull failed');
          location.reload();
        } catch (e) { alert('Failed: ' + e.message); }
      }
      async function lr_delete(id) {
        if (!confirm('Delete this list type? This cannot be undone.')) return;
        try {
          var r = await fetch('/ocular/lists/types/' + id + '/delete', { method: 'POST' });
          if (!r.ok) throw new Error('delete failed');
          var tr = document.querySelector('tr[data-id="' + id + '"]');
          if (tr) tr.remove();
        } catch (e) { alert('Failed: ' + e.message); }
      }
      async function lr_addRow() {
        try {
          var r = await fetch('/ocular/lists/types', { method: 'POST' });
          if (!r.ok) throw new Error('add failed');
          location.reload();
        } catch (e) { alert('Failed: ' + e.message); }
      }
    </script>`;

  return shell({
    title:      'List Registry',
    activePage: 'list-registry',
    user:       data.user,
    badges:     data.badges || {},
    body,
  });
}

module.exports = { listRegistry, rowHTML };
