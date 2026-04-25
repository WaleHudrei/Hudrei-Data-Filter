// ui/components/top-lists.js
// Ranked top lists with progress bar.
//
// items: [{ name, count }] — count drives the bar width relative to the max.
const { escHTML, fmtNum } = require('../_helpers');

function topLists(items) {
  // Default-coalesce so explicit null/undefined doesn't crash.
  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    return `<div style="font-size:13px;color:var(--ocu-text-3);padding:8px 0">No lists yet.</div>`;
  }
  const max = Math.max(...list.map(i => Number(i.count) || 0), 1);
  return `
    <div class="ocu-top-lists">
      ${list.map((it, idx) => {
        const pct = ((Number(it.count) || 0) / max) * 100;
        return `
        <div class="ocu-list-row">
          <div class="ocu-list-rank">${String(idx + 1).padStart(2, '0')}</div>
          <div>
            <div class="ocu-list-name">${escHTML(it.name)}</div>
            <div class="ocu-list-bar-wrap"><div class="ocu-list-bar" style="width:${pct.toFixed(1)}%"></div></div>
          </div>
          <div class="ocu-list-count">${fmtNum(it.count)}</div>
        </div>`;
      }).join('')}
    </div>`;
}

module.exports = { topLists };
