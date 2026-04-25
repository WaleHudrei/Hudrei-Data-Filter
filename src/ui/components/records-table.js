// ui/components/records-table.js
// Records data table — one row per property.
//
// Phase 1: read-only, click row to view detail.
// Phase 2 (2026-04-25): added checkbox column for bulk selection. Selection
// state is managed by /ocular-static/records-bulk.js — this component just
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

function distressCell(score) {
  if (score == null) return `<span style="color:var(--ocu-text-3)">—</span>`;
  let color = '#9CA3AF';
  const s = Number(score) || 0;
  if (s >= 80)      color = '#DC2626';
  else if (s >= 60) color = '#D97706';
  else if (s >= 40) color = '#2563EB';
  return `<span class="ocu-pill" style="background:${color}15;color:${color};font-family:var(--ocu-mono)">${s}</span>`;
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
    const owner = [r.first_name, r.last_name].filter(Boolean).map(escHTML).join(' ') || '—';
    const street = escHTML(r.street || '');
    const city = escHTML(r.city || '');
    const state = escHTML(r.state_code || '');
    const zip = escHTML(r.zip_code || '');
    const propType = escHTML(r.property_type || '—');
    return `
      <tr class="ocu-tr-clickable" data-row-id="${r.id}">
        <td class="ocu-td ocu-td-check" onclick="event.stopPropagation()">
          <input type="checkbox" class="ocu-row-check" data-id="${r.id}" aria-label="Select row">
        </td>
        <td class="ocu-td">
          <div class="ocu-td-primary">${street}</div>
          <div class="ocu-td-meta">${city}${city ? ', ' : ''}${state} ${zip}</div>
        </td>
        <td class="ocu-td ocu-td-text">${owner}</td>
        <td class="ocu-td">${ownerTypeCell(r.owner_type)}</td>
        <td class="ocu-td ocu-td-text">${propType}</td>
        <td class="ocu-td ocu-td-num">${fmtCount(r.phone_count)}</td>
        <td class="ocu-td ocu-td-num">${fmtCount(r.list_count)}</td>
        <td class="ocu-td ocu-td-num">${distressCell(r.distress_score)}</td>
        <td class="ocu-td">${pipelineCell(r.pipeline_stage)}</td>
        <td class="ocu-td ocu-td-date">${escHTML(formatDate(r.created_at))}</td>
      </tr>`;
  }).join('');

  return `
    <div class="ocu-table-wrap">
      <table class="ocu-table">
        <thead>${headers}</thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

module.exports = { recordsTable };
