// ui/components/activity-timeline.js
// Vertical timeline of campaign activity (calls, sms) for this property.
const { escHTML, fmtRelative } = require('../_helpers');

function channelIcon(channel) {
  if (channel === 'sms') {
    return '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';
  }
  return '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>';
}

function activityTimeline(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    return `<div style="color:var(--ocu-text-3);font-size:13px;padding:8px 0">No campaign activity yet.</div>`;
  }
  return `
    <div class="ocu-timeline">
      ${list.map(r => {
        const disposition = r.disposition_normalized || r.disposition || 'Unknown';
        return `
          <div class="ocu-timeline-row">
            <div class="ocu-timeline-icon">${channelIcon(r.channel)}</div>
            <div class="ocu-timeline-body">
              <div class="ocu-timeline-line">
                <span class="ocu-timeline-campaign">${escHTML(r.campaign_name || 'Campaign')}</span>
                <span class="ocu-pill" style="background:#F3F4F6;color:#4B5563">${escHTML(disposition)}</span>
              </div>
              <div class="ocu-timeline-meta">
                ${r.agent_name ? escHTML(r.agent_name) + ' · ' : ''}${escHTML(fmtRelative(r.activity_date))}
              </div>
            </div>
          </div>`;
      }).join('')}
    </div>`;
}

module.exports = { activityTimeline };
