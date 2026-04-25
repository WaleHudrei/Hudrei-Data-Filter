// ui/components/activity-feed.js
// Vertical activity feed with dot, message, and timestamp.
//
// Each row: { dot: 'success'|'warn'|'accent'|'', html, time }
// `html` may include <span class="actor">Name</span> for highlighted entities;
// it's the caller's responsibility to escape any user data inside it.
const { escHTML } = require('../_helpers');

function activityFeed(rows) {
  // Default-coalesce so explicit null/undefined doesn't crash. JS default
  // params only kick in for `undefined`, not `null`.
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    return `<div style="font-size:13px;color:var(--ocu-text-3);padding:8px 0">No recent activity.</div>`;
  }
  return `
    <div class="ocu-activity">
      ${list.map(r => `
        <div class="ocu-activity-row">
          <div class="ocu-activity-dot ${escHTML(r.dot || '')}"></div>
          <div class="ocu-activity-text">${r.html || ''}</div>
          <div class="ocu-activity-time">${escHTML(r.time || '')}</div>
        </div>`).join('')}
    </div>`;
}

module.exports = { activityFeed };
