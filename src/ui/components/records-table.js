// ui/components/records-table.js
// Records data table — one row per property.
//
// Phase 1: read-only, click row to view detail.
// Phase 2 (2026-04-25): added checkbox column for bulk selection. Selection
// state is managed by /oculah-static/records-bulk.js — this component just
// renders the checkboxes with data-id attributes.
const { escHTML, fmtNum } = require('../_helpers');

const PIPELINE_STYLES = {
  prospect: { bg: '#F3F4F6', fg: '#4B5563', label: 'Prospect' },
  lead:     { bg: '#DCFCE7', fg: '#16A34A', label: 'Lead' },
  contract: { bg: '#FEF3C7', fg: '#92400E', label: 'Contract' },
  closed:   { bg: '#E0F2FE', fg: '#0369A1', label: 'Closed' },
};

const OWNER_TYPE_STYLES = {
  Person:  { bg: '#F3F4F6', fg: '#4B5563' },
  Company: { bg: '#E0F2FE', fg: '#0369A1' },
  Trust:   { bg: '#F3E8FF', fg: '#6D28D9' },
};

// Distress chip — score + colored band indicator. Bands are tied to the
// scoring thresholds in scoring/distress.js (cold <30, warm <55, hot <75,
// burning ≥75). The chip's left edge is a 3px-wide colored bar so users
// scanning a 25-row table can spot Burning/Hot rows at a glance even when
// the values themselves are crowded.
function distressCell(score) {
  if (score == null) return `<span class="ocu-text-3">—</span>`;
  const s = Number(score) || 0;
  let band = 'cold', label = 'Cold';
  if (s >= 75)      { band = 'burning'; label = 'Burning'; }
  else if (s >= 55) { band = 'hot';     label = 'Hot'; }
  else if (s >= 30) { band = 'warm';    label = 'Warm'; }
  return `<span class="ocu-distress-chip" data-band="${band}" title="${label} (${s})">
    <span class="ocu-distress-chip-bar"></span>
    <span class="ocu-distress-chip-score">${s}</span>
    <span class="ocu-distress-chip-band">${label}</span>
  </span>`;
}

// Initials avatar — first letter of first+last, one of 6 stable colors hashed
// from the name. Used in the Owner column so the cell reads as an "owner
// card" instead of generic blue link text.
const AVATAR_PALETTE = [
  ['#E0F2FE', '#0369A1'],
  ['#DCFCE7', '#16A34A'],
  ['#FEF3C7', '#92400E'],
  ['#F3E8FF', '#6D28D9'],
  ['#FFE4E6', '#BE123C'],
  ['#E0E7FF', '#4338CA'],
];
function ownerAvatar(first, last) {
  const f = String(first || '').trim();
  const l = String(last  || '').trim();
  const initials = ((f[0] || '') + (l[0] || '')).toUpperCase() || '?';
  const seed = (f + l).split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const [bg, fg] = AVATAR_PALETTE[seed % AVATAR_PALETTE.length];
  return `<span style="display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;background:${bg};color:${fg};font-size:11px;font-weight:700;letter-spacing:0;flex-shrink:0">${escHTML(initials)}</span>`;
}
function pipelineCell(stage) {
  const s = String(stage || 'prospect').toLowerCase();
  const opt = PIPELINE_STYLES[s] || PIPELINE_STYLES.prospect;
  return `<span class="ocu-pill" style="background:${opt.bg};color:${opt.fg}">${opt.label}</span>`;
}
function ownerTypeCell(type) {
  if (!type || !OWNER_TYPE_STYLES[type]) return `<span style="color:var(--ocu-text-3)">—</span>`;
  const opt = OWNER_TYPE_STYLES[type];
  return `<span class="ocu-pill" style="background:${opt.bg};color:${opt.fg}">${escHTML(type)}</span>`;
}
function fmtCount(n) {
  const v = Number(n) || 0;
  if (v === 0) return `<span style="color:var(--ocu-text-3)">0</span>`;
  return `<span style="font-family:var(--ocu-mono);font-weight:600">${fmtNum(v)}</span>`;
}
function sortHeader(label, col, sortBy, sortDir, querystring) {
  const isActive = sortBy === col;
  const nextDir = isActive && sortDir === 'desc' ? 'asc' : 'desc';
  const arrow = isActive ? (sortDir === 'desc' ? ' ↓' : ' ↑') : '';
  const qs = querystring + (querystring ? '&' : '') + `sort=${col}&dir=${nextDir}`;
  return `<a href="?${qs}" class="ocu-th-sort${isActive ? ' active' : ''}">${escHTML(label)}<span class="ocu-th-arrow">${arrow}</span></a>`;
}
function formatDate(d) {
  if (!d) return '—';
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function recordsTable(opts = {}) {
  const rows = Array.isArray(opts.rows) ? opts.rows : [];
  const sortBy = opts.sortBy || 'id';
  const sortDir = opts.sortDir || 'desc';
  const qs = opts.querystring || '';

  if (!rows.length) {
    return `
      <div class="ocu-empty-table">
        <div class="ocu-empty-title">No records match these filters.</div>
        <div class="ocu-empty-sub">Try clearing some filters or broadening your search.</div>
      </div>`;
  }

  // Header row — first column is the master "select all on this page" checkbox.
  // The bulk JS attaches a click handler to it that flips every row checkbox.
  const headers = `
    <tr>
      <th class="ocu-th ocu-th-check">
        <input type="checkbox" class="ocu-row-checkall" aria-label="Select all on this page">
      </th>
      <th class="ocu-th ocu-th-address">${sortHeader('Address', 'street', sortBy, sortDir, qs)}</th>
      <th class="ocu-th">Owner</th>
      <th class="ocu-th">Type</th>
      <th class="ocu-th">Property</th>
      <th class="ocu-th ocu-th-num">Phones</th>
      <th class="ocu-th ocu-th-num">Lists</th>
      <th class="ocu-th ocu-th-num">${sortHeader('Distress', 'distress_score', sortBy, sortDir, qs)}</th>
      <th class="ocu-th">Stage</th>
      <th class="ocu-th ocu-th-date">${sortHeader('Added', 'created_at', sortBy, sortDir, qs)}</th>
    </tr>`;

  const body = rows.map(r => {
    const ownerNameRaw = [r.first_name, r.last_name].filter(Boolean).join(' ');
    const ownerName = escHTML(ownerNameRaw);
    // Owner cell: non-link "owner card" — colored initial avatar + name.
    // The whole table row is clickable (ocu-tr-clickable), so navigating
    // to the owner page still works via the row's own click handler. We
    // add a 2nd handler that detects clicks INSIDE the owner cell and
    // routes to /oculah/owners/:contact_id instead of the property page.
    // No <a> tag, so it doesn't read as link text.
    let ownerCell;
    if (r.contact_id && ownerNameRaw) {
      ownerCell = `
        <span class="ocu-owner-card" data-owner-id="${r.contact_id}">
          ${ownerAvatar(r.first_name, r.last_name)}
          <span class="ocu-owner-card-name">${ownerName}</span>
        </span>`;
    } else if (ownerNameRaw) {
      ownerCell = `
        <span class="ocu-owner-card">
          ${ownerAvatar(r.first_name, r.last_name)}
          <span class="ocu-owner-card-name">${ownerName}</span>
        </span>`;
    } else {
      ownerCell = `<a href="/oculah/records/${r.id}" class="ocu-add-owner-link" onclick="event.stopPropagation()">+ Add owner</a>`;
    }
    const street = escHTML(r.street || '');
    const city = escHTML(r.city || '');
    const state = escHTML(r.state_code || '');
    const zip = escHTML(r.zip_code || '');
    const propType = escHTML(r.property_type || '—');
    return `
      <tr class="ocu-tr-clickable ocu-row-card" data-row-id="${r.id}">
        <td class="ocu-td ocu-td-check" onclick="event.stopPropagation()">
          <input type="checkbox" class="ocu-row-check" data-id="${r.id}" aria-label="Select row">
        </td>
        <td class="ocu-td ocu-td-address-cell">
          <div class="ocu-td-primary">${street}</div>
          <div class="ocu-td-meta">${city}${city ? ', ' : ''}${state} ${zip}</div>
        </td>
        <td class="ocu-td ocu-td-owner-cell">${ownerCell}</td>
        <td class="ocu-td">${ownerTypeCell(r.owner_type)}</td>
        <td class="ocu-td ocu-td-text">${propType}</td>
        <td class="ocu-td ocu-td-num">${fmtCount(r.phone_count)}</td>
        <td class="ocu-td ocu-td-num">${fmtCount(r.list_count)}</td>
        <td class="ocu-td ocu-td-num">${distressCell(r.distress_score)}</td>
        <td class="ocu-td">${pipelineCell(r.pipeline_stage)}</td>
        <td class="ocu-td ocu-td-date">${escHTML(formatDate(r.created_at))}</td>
      </tr>`;
  }).join('');

  // Click-through behavior: an inner click on .ocu-owner-card with a
  // data-owner-id routes to the owner page; otherwise the row's normal
  // click handler routes to the property page. Inlined once so each
  // table doesn't ship its own copy.
  const clickShim = `
    <script>
      (function(){
        var t = document.currentScript.previousElementSibling;
        if (!t) return;
        t.addEventListener('click', function(e){
          var oc = e.target.closest('.ocu-owner-card[data-owner-id]');
          if (oc) {
            e.stopPropagation();
            window.location.href = '/oculah/owners/' + oc.getAttribute('data-owner-id');
          }
        });
      })();
    </script>`;

  return `
    <div class="ocu-table-wrap ocu-records-table-wrap">
      <table class="ocu-table ocu-records-table">
        <thead>${headers}</thead>
        <tbody>${body}</tbody>
      </table>
    </div>${clickShim}`;
}

module.exports = { recordsTable };
