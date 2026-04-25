// ui/components/list-membership.js
// Shows the lists this property belongs to. Each row: list name + type + when added.
const { escHTML, fmtRelative } = require('../_helpers');

function listMembership(lists = []) {
  const list = Array.isArray(lists) ? lists : [];
  if (!list.length) {
    return `<div style="color:var(--ocu-text-3);font-size:13px;padding:8px 0">Not on any lists.</div>`;
  }
  return `
    <div class="ocu-list-membership">
      ${list.map(l => `
        <div class="ocu-membership-row">
          <div class="ocu-membership-name">${escHTML(l.list_name || 'Unnamed list')}</div>
          <div class="ocu-membership-meta">
            ${l.list_type ? `<span class="ocu-pill" style="background:#F3F4F6;color:#4B5563">${escHTML(l.list_type)}</span>` : ''}
            <span class="ocu-membership-time">${escHTML(fmtRelative(l.added_at))}</span>
          </div>
        </div>
      `).join('')}
    </div>`;
}

module.exports = { listMembership };
