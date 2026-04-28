// ═══════════════════════════════════════════════════════════════════════════
// ui/pages/campaign-detail.js
// Ocular campaign detail page. Shows the campaign header (name, market,
// status, channel toggles), a KPI strip of all the running totals, the
// disposition breakdown as horizontal bars, and recent uploads.
//
// Inline writes wired here:
//   - Rename (POST /ocular/campaigns/:id/rename)
//   - Status change (POST /ocular/campaigns/:id/status)
//   - Channel switch (POST /ocular/campaigns/:id/channel)
//   - Close + Start new round (POST /ocular/campaigns/:id/close, /new-round)
//
// Heavy uploads (contact list, SMS export, NIS, manual count) intentionally
// link out to the existing Loki endpoints — those are multi-step flows we
// haven't ported.
// ═══════════════════════════════════════════════════════════════════════════
const { shell }   = require('../layouts/shell');
const { card }    = require('../components/card');
const { kpiCard } = require('../components/kpi-card');
const { escHTML, fmtNum, fmtRelative } = require('../_helpers');

function statusBadge(s) {
  const map = {
    active:    { label: 'Active',    cls: 'ocu-pill ocu-pill-good' },
    completed: { label: 'Completed', cls: 'ocu-pill ocu-pill-primary' },
    paused:    { label: 'Paused',    cls: 'ocu-pill ocu-pill-warn' },
  };
  const m = map[s] || { label: s || '—', cls: 'ocu-pill' };
  return `<span class="${m.cls}">${escHTML(m.label)}</span>`;
}

function dispositionBars(rows) {
  if (!rows || !rows.length) {
    return `<div class="ocu-empty" style="padding:20px">No dispositions logged yet.</div>`;
  }
  const max = Math.max(...rows.map(r => Number(r.count) || 0), 1);
  return `<div style="display:flex;flex-direction:column;gap:8px">
    ${rows.map(r => {
      const w = Math.max(2, Math.round((Number(r.count) / max) * 100));
      return `<div style="display:grid;grid-template-columns:160px 1fr 60px;gap:10px;align-items:center;font-size:12px">
        <div class="ocu-text-2" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHTML(r.disposition || '—')}</div>
        <div class="ocu-progress-track" style="height:8px"><div class="ocu-progress-fill" style="width:${w}%;height:8px;background:var(--ocu-text-1)"></div></div>
        <div class="ocu-text-right ocu-mono">${fmtNum(r.count)}</div>
      </div>`;
    }).join('')}
  </div>`;
}

function uploadRow(u) {
  const channelLabel = u.channel === 'sms' ? 'SMS'
                     : u.channel === 'sms_results' ? 'SMS results'
                     : u.channel === 'sms_accepted' ? 'SMS accepted'
                     : 'Cold call';
  return `<tr>
    <td>${escHTML(u.filename || '—')}</td>
    <td><span class="ocu-pill" data-channel="${escHTML(u.channel || '')}">${escHTML(channelLabel)}</span></td>
    <td class="ocu-text-right ocu-mono">${fmtNum(u.total_records || 0)}</td>
    <td class="ocu-text-right ocu-mono">+${fmtNum(u.records_kept || 0)}</td>
    <td class="ocu-text-right ocu-mono">${fmtNum(u.records_filtered || 0)}</td>
    <td class="ocu-text-3 ocu-mono" style="font-size:11px;white-space:nowrap">${fmtRelative(u.uploaded_at)}</td>
  </tr>`;
}

/**
 * @param {Object} data
 *   - user, badges
 *   - campaign: campaigns row (with .uploads, .disposition_breakdown, .contact_counts)
 *   - flash: { msg?, err? }
 */
function campaignDetail(data = {}) {
  const c = data.campaign || {};
  const uploads = Array.isArray(c.uploads) ? c.uploads : [];
  const dispositions = Array.isArray(c.disposition_breakdown) ? c.disposition_breakdown : [];
  const counts = c.contact_counts || {};
  const flash = data.flash || {};

  const flashHTML = flash.msg
    ? `<div class="ocu-card" style="margin-bottom:14px;background:#e8f5ee;border-color:#9bd0a8;color:#1a5f1a;padding:12px 16px;font-size:13px">${escHTML(flash.msg)}</div>`
    : flash.err
    ? `<div class="ocu-card" style="margin-bottom:14px;background:#fdeaea;border-color:#f5c5c5;color:#8b1f1f;padding:12px 16px;font-size:13px">${escHTML(flash.err)}</div>`
    : '';

  const kpiStrip = `
    <div class="ocu-kpi-row" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr))">
      ${kpiCard({ label: 'Unique numbers',    value: c.total_unique_numbers || 0, featured: true })}
      ${kpiCard({ label: 'Callable',          value: c.total_callable || 0 })}
      ${kpiCard({ label: 'Filtered',          value: c.total_filtered || 0 })}
      ${kpiCard({ label: 'Connected',         value: c.total_connected || 0 })}
      ${kpiCard({ label: 'Transfers (leads)', value: c.total_transfers || 0, valueClass: c.total_transfers > 0 ? 'burning' : '' })}
      ${kpiCard({ label: 'Contacts',          value: counts.total_contacts || 0 })}
      ${kpiCard({ label: 'Leads (all)',       value: counts.lead_contacts || 0 })}
    </div>`;

  // Channel + status controls
  const channelControl = `
    <form method="POST" action="/ocular/campaigns/${c.id}/channel" style="display:flex;gap:6px;align-items:center">
      <span class="ocu-text-3" style="font-size:11px">Channel:</span>
      <select name="channel" onchange="this.form.submit()" class="ocu-input" style="padding:5px 8px;font-size:12px;width:auto">
        <option value="cold_call" ${c.active_channel === 'cold_call' ? 'selected' : ''}>Cold call</option>
        <option value="sms"       ${c.active_channel === 'sms'       ? 'selected' : ''}>SMS</option>
      </select>
    </form>`;

  const statusControl = `
    <form method="POST" action="/ocular/campaigns/${c.id}/status" style="display:flex;gap:6px;align-items:center">
      <span class="ocu-text-3" style="font-size:11px">Status:</span>
      <select name="status" onchange="this.form.submit()" class="ocu-input" style="padding:5px 8px;font-size:12px;width:auto">
        <option value="active"    ${c.status === 'active'    ? 'selected' : ''}>Active</option>
        <option value="paused"    ${c.status === 'paused'    ? 'selected' : ''}>Paused</option>
        <option value="completed" ${c.status === 'completed' ? 'selected' : ''}>Completed</option>
      </select>
    </form>`;

  // Rename — inline form, only shown when user clicks pencil
  const renameForm = `
    <form method="POST" action="/ocular/campaigns/${c.id}/rename" id="cd-rename-form" style="display:none;flex:1;gap:6px">
      <input type="text" name="name" value="${escHTML(c.name)}" maxlength="255" required class="ocu-input" style="flex:1" />
      <button type="submit" class="ocu-btn ocu-btn-primary">Save</button>
      <button type="button" class="ocu-btn ocu-btn-ghost" onclick="cd_cancelRename()">Cancel</button>
    </form>`;

  const closeBtn = c.status !== 'completed'
    ? `<form method="POST" action="/ocular/campaigns/${c.id}/close" style="display:inline-block" onsubmit="return confirm('Close this campaign? It will be marked completed.')">
        <button type="submit" class="ocu-btn ocu-btn-secondary">Close campaign</button>
       </form>`
    : '';

  const newRoundBtn = `
    <form method="POST" action="/ocular/campaigns/${c.id}/new-round" style="display:inline-block" onsubmit="return confirm('Close this campaign and start a fresh round with the same settings?')">
      <button type="submit" class="ocu-btn ocu-btn-secondary">Start new round</button>
    </form>`;

  const dispositionsCard = card({
    title: 'Disposition breakdown',
    meta:  dispositions.length ? `${dispositions.length} dispositions seen` : '',
    body:  dispositionBars(dispositions),
  });

  const uploadsCard = card({
    title: 'Recent uploads',
    meta:  uploads.length ? `${uploads.length} most recent` : '',
    body:  uploads.length === 0
      ? `<div class="ocu-text-3" style="font-size:13px;text-align:center;padding:20px">No uploads to this campaign yet. Use the existing Loki page to upload a call log or SMS export.</div>`
      : `<div class="ocu-table-wrap">
          <table class="ocu-table">
            <thead>
              <tr>
                <th>File</th>
                <th>Channel</th>
                <th class="ocu-text-right">Total</th>
                <th class="ocu-text-right">Kept</th>
                <th class="ocu-text-right">Filtered</th>
                <th>Uploaded</th>
              </tr>
            </thead>
            <tbody>${uploads.map(uploadRow).join('')}</tbody>
          </table>
        </div>`,
  });

  const body = `
    <div class="ocu-page-header" style="align-items:flex-start">
      <div style="flex:1;min-width:0">
        <div style="margin-bottom:6px"><a href="/ocular/campaigns" class="ocu-text-3" style="font-size:13px;text-decoration:none">← Campaigns</a></div>
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
          <h1 class="ocu-page-title" id="cd-name" style="margin:0">${escHTML(c.name)}</h1>
          <button class="ocu-btn ocu-btn-ghost" style="padding:4px 8px;font-size:11px" onclick="cd_startRename()">Rename</button>
          ${statusBadge(c.status)}
        </div>
        ${renameForm}
        <div class="ocu-page-subtitle">${escHTML(c.list_type || '')} · ${escHTML(c.market_name || '')}${c.state_code ? ' · ' + escHTML(c.state_code) : ''}</div>
      </div>
      <div style="display:flex;gap:10px;align-items:center">
        ${channelControl}
        ${statusControl}
      </div>
    </div>

    ${flashHTML}
    ${kpiStrip}

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:18px">
      ${dispositionsCard}
      ${uploadsCard}
    </div>

    <div style="margin-top:18px;display:flex;gap:8px;justify-content:flex-end">
      <a href="/campaigns/${c.id}" class="ocu-btn ocu-btn-secondary">Open in Loki (uploads)</a>
      ${newRoundBtn}
      ${closeBtn}
    </div>

    <script>
      function cd_startRename() {
        document.getElementById('cd-name').style.display = 'none';
        var f = document.getElementById('cd-rename-form');
        f.style.display = 'flex';
        f.querySelector('input').focus();
      }
      function cd_cancelRename() {
        document.getElementById('cd-name').style.display = '';
        document.getElementById('cd-rename-form').style.display = 'none';
      }
    </script>`;

  return shell({
    title:      c.name || 'Campaign',
    activePage: 'campaigns',
    user:       data.user,
    badges:     data.badges || {},
    body,
  });
}

module.exports = { campaignDetail };
