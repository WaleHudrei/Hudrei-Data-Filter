// ═══════════════════════════════════════════════════════════════════════════
// ui/pages/campaign-detail.js
// Ocular campaign detail page. Shows the campaign header (name, market,
// status, channel toggles), a KPI strip of all the running totals, the
// disposition breakdown as horizontal bars, contact-list management, SMS
// results upload (SMS campaigns), per-campaign filtration drop zone, and a
// full filtration history table.
//
// Inline writes wired here:
//   - Rename, status, channel, close, new-round (POST /oculah/campaigns/:id/{rename,status,channel,close,new-round})
//   - Contact list upload + delete + sync-wrong-numbers (POST /oculah/campaigns/:id/contacts/*)
//   - SMS results upload (POST /oculah/campaigns/:id/sms/upload — SMS campaigns only)
//   - Readymode-count override (POST /oculah/campaigns/:id/readymode-count)
//
// Per-campaign drop zone reuses POST /upload/filter/parse + /upload/filter/process
// with this campaign's id pre-filled, so memory dedup is correctly scoped.
// All processing logic stays in src/filtration.js + processCSV — UNCHANGED.
// ═══════════════════════════════════════════════════════════════════════════
const { shell }   = require('../layouts/shell');
const { card }    = require('../components/card');
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
  // Filtration history mirrors legacy /campaigns/:id columns: file, channel,
  // total, kept, filtered, memory catches (if recorded), date.
  const memCaught = (u.memory_caught != null) ? u.memory_caught
                  : (u.mem_caught != null)    ? u.mem_caught
                  : null;
  return `<tr>
    <td class="ocu-td">${escHTML(u.filename || '—')}</td>
    <td class="ocu-td"><span class="ocu-pill" data-channel="${escHTML(u.channel || '')}">${escHTML(channelLabel)}</span></td>
    <td class="ocu-td ocu-td-num"><span class="ocu-mono">${fmtNum(u.total_records || 0)}</span></td>
    <td class="ocu-td ocu-td-num"><span class="ocu-mono">+${fmtNum(u.records_kept || 0)}</span></td>
    <td class="ocu-td ocu-td-num"><span class="ocu-mono">${fmtNum(u.records_filtered || 0)}</span></td>
    <td class="ocu-td ocu-td-num"><span class="ocu-mono">${memCaught != null ? fmtNum(memCaught) : '—'}</span></td>
    <td class="ocu-td ocu-td-date">${fmtRelative(u.uploaded_at)}</td>
  </tr>`;
}

// ── New campaign-detail sections (Loki port) ──────────────────────────────
//
// Local mini-card primitives — match the Loki kpi/ratioCard look.
// (We don't reuse <kpiCard> from components/kpi-card.js because the legacy
// Loki layout uses a denser, label/value/sub form with a per-card value
// color that the shared component doesn't expose.)
function _kpiCell(label, value, sub, valueColor) {
  return `
    <div class="ocu-kpi">
      <div class="ocu-kpi-label">${escHTML(label)}</div>
      <div class="ocu-kpi-value"${valueColor ? ` style="color:${valueColor}"` : ''}>${value}</div>
      ${sub ? `<div class="ocu-kpi-delta">${escHTML(sub)}</div>` : ''}
    </div>`;
}
function _ratioCard(label, value, hint, color) {
  return `
    <div class="ocu-card" style="text-align:center;padding:14px 10px">
      <div style="font-size:22px;font-weight:600;color:${color}">${value}%</div>
      <div style="font-size:11px;color:var(--ocu-text-2);margin-top:4px;font-weight:600">${escHTML(label)}</div>
      <div style="font-size:10px;color:var(--ocu-text-3);margin-top:2px">${escHTML(hint)}</div>
    </div>`;
}

// Compute the metrics block once and reuse across the strips. Keeps the math
// in one place so a label tweak doesn't require chasing duplicate calcs.
function _campaignMetrics(c) {
  const counts = c.contact_counts || {};
  const callLogs       = Number(c.total_unique_numbers || 0);
  const connected      = Number(c.total_connected      || 0);
  const transfers      = Number(c.total_transfers      || 0);
  const wrongNums      = Number(c.total_wrong_numbers  || 0);
  const notInterested  = Number(c.total_not_interested || 0);
  const filtered       = Number(c.total_filtered       || 0);
  const uploadCount    = Number(c.upload_count         || 0);
  const totalContacts  = Number(counts.total_contacts  || 0);
  const totalPhones    = Number(counts.total_phones    || 0);
  const correctPhones  = Number(counts.correct_phones  || 0);
  const wrongPhones    = Number(counts.wrong_phones    || 0);
  const nisPhones      = Number(counts.nis_phones      || 0);
  const filteredPhones = Number(counts.filtered_phones || 0);
  const reached        = Number(counts.reached_contacts || 0);
  const leadContacts   = Number(counts.lead_contacts   || 0);
  const manualCount    = Number(c.manual_count         || 0);

  // "Callable" = total phones minus everything that's been pulled out of the
  // active dialer pool. Filtered + wrong + NIS are excluded from calling, and
  // we floor at 0 so a stale upload doesn't show a negative number.
  const callablePhones = Math.max(0, totalPhones - wrongPhones - filteredPhones - nisPhones);
  const masterCallable = Math.max(0, totalPhones - (filtered + wrongNums) - nisPhones);
  const callablePct    = totalPhones > 0 ? Math.round((masterCallable / totalPhones) * 100) : 0;
  const health         = totalPhones > 0 ? ((callablePhones / totalPhones) * 100).toFixed(1) : '0.0';

  const cr    = (callLogs > 0 && connected > 0) ? ((connected / callLogs) * 100).toFixed(2) : '0.00';
  const clr   = (totalPhones > 0 && callLogs > 0) ? ((callLogs / totalPhones) * 100).toFixed(2) : '0.00';
  const wPct  = (connected + wrongNums) > 0 ? ((wrongNums / (connected + wrongNums)) * 100).toFixed(2) : '0.00';
  const niPct = connected > 0 ? ((notInterested / connected) * 100).toFixed(2) : '0.00';
  const lgr   = connected > 0 ? ((transfers / connected) * 100).toFixed(2) : '0.00';
  const lcv   = totalContacts > 0 ? ((leadContacts / totalContacts) * 100).toFixed(2) : '0.00';

  return {
    callLogs, connected, transfers, wrongNums, notInterested, filtered, uploadCount,
    totalContacts, totalPhones, correctPhones, wrongPhones, nisPhones, reached,
    leadContacts, manualCount, masterCallable, callablePct, health, cr, clr, wPct, niPct, lgr, lcv,
  };
}

// Top filtration KPI strip — 7 cards for cold-call, 5 for SMS.
function filtrationKpiStrip(c, m) {
  const isSms = (c.active_channel || 'cold_call') === 'sms';
  const cards = isSms ? `
    ${_kpiCell('SMS uploads',     fmtNum(m.uploadCount),  'Uploads')}
    ${_kpiCell('Wrong numbers',   fmtNum(m.wrongNums),    'Removed', '#c0392b')}
    ${_kpiCell('Not interested',  fmtNum(m.notInterested),'Total NI', '#9a6800')}
    ${_kpiCell('Leads generated', fmtNum(m.transfers),    'Transfers', '#1a7a4a')}
    ${_kpiCell('Callable',        fmtNum(m.masterCallable), `${m.callablePct}% active pool`, '#1a7a4a')}
  ` : `
    ${_kpiCell('Call logs',       fmtNum(m.callLogs),     'Logged numbers')}
    ${_kpiCell('Connected',       fmtNum(m.connected),    'Live pickups', '#2471a3')}
    ${_kpiCell('Wrong numbers',   fmtNum(m.wrongNums),    'Removed', '#c0392b')}
    ${_kpiCell('Not interested',  fmtNum(m.notInterested),'Total NI', '#9a6800')}
    ${_kpiCell('Leads generated', fmtNum(m.transfers),    'Transfers', '#1a7a4a')}
    ${_kpiCell('Callable',        fmtNum(m.masterCallable), `${m.callablePct}% active pool`, '#1a7a4a')}
    ${_kpiCell('Filtration runs', fmtNum(m.uploadCount),  'Uploads')}
  `;
  return `
    <div class="ocu-kpi-row" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr));margin-bottom:18px">
      ${cards}
    </div>`;
}

// Campaign ratio cards — 6 colored % cards (CR/W#%/NI%/LGR/LCV/Health for
// cold-call; W#%/NI%/LGR/LCV/Health for SMS).
function ratioCardsBlock(c, m) {
  const isSms = (c.active_channel || 'cold_call') === 'sms';
  const healthColor = parseFloat(m.health) > 50 ? '#1a7a4a'
                    : parseFloat(m.health) > 25 ? '#9a6800' : '#c0392b';
  const cards = isSms ? `
    ${_ratioCard('W#%',    m.wPct,   'Wrong ÷ Total contacts',           '#c0392b')}
    ${_ratioCard('NI%',    m.niPct,  'NI ÷ Total contacts',              '#9a6800')}
    ${_ratioCard('LGR',    m.lgr,    'Leads ÷ Total contacts',           '#1a7a4a')}
    ${_ratioCard('LCV',    m.lcv,    'Lead contacts ÷ Total contacts',   '#534AB7')}
    ${_ratioCard('Health', m.health, 'Callable ÷ Total phones',          healthColor)}
  ` : `
    ${_ratioCard('CLR',    m.clr,    'Call logs ÷ Total phones',         '#534AB7')}
    ${_ratioCard('CR',     m.cr,     'Connected ÷ Call logs',            '#2471a3')}
    ${_ratioCard('W#%',    m.wPct,   'Wrong ÷ Humans reached',           '#c0392b')}
    ${_ratioCard('NI%',    m.niPct,  'NI ÷ Connected',                   '#9a6800')}
    ${_ratioCard('LGR',    m.lgr,    'Leads ÷ Connected',                '#1a7a4a')}
    ${_ratioCard('LCV',    m.lcv,    'Lead contacts ÷ Total contacts',   '#534AB7')}
    ${_ratioCard('Health', m.health, 'Callable ÷ Total phones',          healthColor)}
  `;
  return `
    <div class="ocu-card" style="padding:16px 18px;margin-bottom:18px">
      <div class="ocu-text-3" style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px">${isSms ? 'SMS campaign ratios' : 'Campaign KPIs'}</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px">
        ${cards}
      </div>
    </div>`;
}

// Side card mirroring the Loki "Channel status" panel — pills per channel
// plus the rolling wrong-number / voicemail counters.
function channelStatusCard(c, m) {
  const coldActive = c.cold_call_status === 'active';
  const smsActive  = c.sms_status === 'active';
  return card({
    title: 'Channel status',
    meta:  '',
    body: `
      <div style="margin-bottom:10px">
        <div class="ocu-text-3" style="font-size:11px;margin-bottom:4px">Cold call</div>
        <span class="ocu-pill ${coldActive ? 'ocu-pill-good' : ''}">${escHTML(c.cold_call_status || '—')}</span>
      </div>
      <div>
        <div class="ocu-text-3" style="font-size:11px;margin-bottom:4px">SMS</div>
        <span class="ocu-pill ${smsActive ? 'ocu-pill-good' : ''}">${escHTML(c.sms_status || '—')}</span>
      </div>
      <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--ocu-border)">
        <div class="ocu-text-3" style="font-size:11px;margin-bottom:2px">Wrong numbers removed</div>
        <div class="ocu-mono" style="font-size:18px;font-weight:600;color:#c0392b">${fmtNum(m.wrongNums)}</div>
      </div>
      <div style="margin-top:10px">
        <div class="ocu-text-3" style="font-size:11px;margin-bottom:2px">Voicemails accumulated</div>
        <div class="ocu-mono" style="font-size:18px;font-weight:600;color:#9a6800">${fmtNum(c.total_voicemails || 0)}</div>
      </div>`,
  });
}

// Contact list section — Loki layout with 7-card KPI grid + inline edit for
// "Accepted by Readymode" + upload/sync/delete + clean export. Replaces the
// old slim contact-list card.
function contactListCard(c, counts) {
  const isCold        = (c.active_channel || 'cold_call') === 'cold_call';
  const totalContacts = Number(counts.total_contacts || 0);
  const totalPhones   = Number(counts.total_phones   || 0);
  const correct       = Number(counts.correct_phones || 0);
  const wrong         = Number(counts.wrong_phones   || 0);
  const nis           = Number(counts.nis_phones     || 0);
  const reached       = Number(counts.reached_contacts || 0);
  const manualCount   = Number(c.manual_count || 0);
  const reachedPct    = totalContacts > 0 ? ((reached / totalContacts) * 100).toFixed(1) : null;
  const reachedValue  = reachedPct
    ? `${fmtNum(reached)} <span style="font-size:13px;color:var(--ocu-text-3);font-weight:400">(${reachedPct}%)</span>`
    : fmtNum(reached);

  const acceptedValue = `${fmtNum(manualCount)} <button type="button" onclick="cd_toggleRm()" style="font-size:11px;color:var(--ocu-text-3);background:none;border:none;cursor:pointer;text-decoration:underline">edit</button>`;

  const kpis = `
    <div class="ocu-kpi-row" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr));margin-bottom:14px">
      ${_kpiCell('Total properties',     fmtNum(totalContacts), 'Contacts uploaded')}
      ${isCold ? _kpiCell('Accepted by Readymode', acceptedValue, 'Manually entered') : ''}
      ${_kpiCell('Total phones',         fmtNum(totalPhones),  'Across all contacts')}
      ${_kpiCell('Wrong numbers',        fmtNum(wrong),        'Permanently excluded', '#c0392b')}
      ${_kpiCell('NIS flagged',          fmtNum(nis),          'Dead numbers',         '#c0392b')}
      ${_kpiCell('Confirmed correct',    fmtNum(correct),      'Live person confirmed', '#1a7a4a')}
      ${_kpiCell('Contacts reached',     reachedValue,         'At least 1 live pickup', '#185fa5')}
    </div>`;

  const readymodeForm = isCold ? `
    <div id="cd-rm-form" style="display:none;background:var(--ocu-surface);border-radius:8px;padding:12px;margin-bottom:14px">
      <form method="POST" action="/oculah/campaigns/${c.id}/readymode-count" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <input type="number" name="count" min="0" step="1" value="${manualCount}" placeholder="e.g. 4163" class="ocu-input" style="width:160px" required />
        <button type="submit" class="ocu-btn ocu-btn-primary">Save</button>
        <span class="ocu-text-3" style="font-size:12px">Total contacts Readymode accepted</span>
      </form>
    </div>` : '';

  const headerActions = `
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      ${totalContacts > 0 ? `
        <form method="POST" action="/oculah/campaigns/${c.id}/sync-wrong-numbers" style="display:inline" onsubmit="return confirm('Sync all historical wrong numbers to the master contact list? Safe to run anytime.')">
          <button type="submit" class="ocu-btn ocu-btn-secondary">Sync wrong numbers</button>
        </form>
        <a href="/campaigns/${c.id}/export/clean" class="ocu-btn ocu-btn-primary">Download clean export (Readymode)</a>
      ` : ''}
    </div>`;

  const uploadForm = `
    <div style="border-top:1px solid var(--ocu-border);padding-top:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:8px">
        <div class="ocu-text-3" style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em">Upload original contact list</div>
        ${totalContacts > 0 ? `
          <form method="POST" action="/oculah/campaigns/${c.id}/contacts/delete" onsubmit="return confirm('Delete the master contact list for this campaign? This cannot be undone.')">
            <button type="submit" class="ocu-btn ocu-btn-ghost" style="color:#c0392b;font-size:12px">Delete master list</button>
          </form>` : ''}
      </div>
      <form method="POST" action="/oculah/campaigns/${c.id}/contacts/upload" enctype="multipart/form-data">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <input type="file" name="contactfile" accept=".csv,.txt" required class="ocu-input" style="padding:6px 10px;flex:1;min-width:240px" />
          <button type="submit" class="ocu-btn ocu-btn-primary">Upload contact list</button>
        </div>
        <div class="ocu-text-3" style="font-size:11px;margin-top:6px">Oculah auto-detects all columns and phone numbers. Re-upload to replace.</div>
      </form>
      ${c.sms_status === 'active' ? `
        <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--ocu-border)">
          <div class="ocu-text-3" style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Upload SmarterContact SMS results</div>
          <form method="POST" action="/oculah/campaigns/${c.id}/sms/upload" enctype="multipart/form-data">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <input type="file" name="smsfile" accept=".csv,.txt" required class="ocu-input" style="padding:6px 10px;flex:1;min-width:240px" />
              <button type="submit" class="ocu-btn ocu-btn-primary" style="background:#2563eb">Upload SMS results</button>
            </div>
            <div class="ocu-text-3" style="font-size:11px;margin-top:6px">Required columns: Phone, Labels, First name, Last name, Property address, Property city, Property state, Property zip. One label per row.</div>
          </form>
        </div>` : ''}
    </div>`;

  return `
    <div class="ocu-card" style="padding:18px 20px;margin-bottom:18px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:10px">
        <div style="font-size:14px;font-weight:600;color:var(--ocu-text-1)">Contact list</div>
        ${headerActions}
      </div>
      ${kpis}
      ${readymodeForm}
      ${uploadForm}
    </div>`;
}

function smsResultsCard(c) {
  const body = `
    <div class="ocu-text-3" style="font-size:13px;margin-bottom:10px">
      Upload a SmarterContact SMS results CSV to mark wrong numbers, leads, and DNC across this campaign's contacts.
    </div>
    <form method="POST" action="/oculah/campaigns/${c.id}/sms/upload"
          enctype="multipart/form-data"
          style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <input type="file" name="smsfile" accept=".csv,.txt" required
             style="flex:1;min-width:200px;font-size:13px" />
      <button type="submit" class="ocu-btn ocu-btn-primary">Upload SMS results</button>
    </form>`;
  return card({ title: 'SMS results', meta: 'SmarterContact CSV', body });
}

// Per-campaign quick filtration drop zone. Auto-maps and posts to the existing
// /upload/filter/parse + /upload/filter/process endpoints with this campaign's
// id, so memory dedup is correctly scoped. Inline AJAX, no page reload.
// Heavier flows (manual mapping, larger files) live on /oculah/filtration.
function quickFiltrationCard(c) {
  const body = `
    <div class="ocu-text-3" style="font-size:13px;margin-bottom:10px">
      Drop a Readymode call-log export here. We'll filter against this campaign's memory and show the results inline.
      For manual column mapping or larger uploads, use <a href="/oculah/filtration?campaign=${c.id}" style="text-decoration:underline">List Filtration</a>.
    </div>
    <div id="cd-drop" class="cd-drop" data-campaign="${c.id}">
      <input type="file" id="cd-file" accept=".csv,.txt" style="display:none">
      <div class="cd-drop-inner">
        <div style="font-size:24px;color:#7a808a;margin-bottom:6px">⬆</div>
        <div style="font-weight:600;color:#1a1f25">Drop CSV here, or click to browse</div>
        <div class="ocu-text-3" style="font-size:12px;margin-top:4px">Readymode call-log export · max 50&nbsp;MB</div>
      </div>
    </div>
    <div id="cd-progress" style="display:none;margin-top:10px;font-size:13px;color:#6b6f7a"></div>
    <div id="cd-error"    style="display:none;margin-top:10px;background:#fff0f0;border:1px solid #f5c5c5;color:#a02222;padding:10px 12px;border-radius:8px;font-size:13px"></div>
    <div id="cd-results"  style="display:none;margin-top:14px"></div>`;

  return card({ title: 'Quick filtration', meta: 'Inline drop zone', body });
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

  // Loki-parity KPI strips: filtration totals on top, then a ratio-cards
  // panel ("Campaign KPIs" — CR/W#%/NI%/LGR/LCV/Health). Both calc once via
  // _campaignMetrics so labels and ratios stay in lockstep.
  const metrics = _campaignMetrics(c);
  const kpiStrip = filtrationKpiStrip(c, metrics);
  const ratioStrip = ratioCardsBlock(c, metrics);

  // Channel + status controls
  const channelControl = `
    <form method="POST" action="/oculah/campaigns/${c.id}/channel" style="display:flex;gap:6px;align-items:center">
      <span class="ocu-text-3" style="font-size:11px">Channel:</span>
      <select name="channel" onchange="this.form.submit()" class="ocu-input" style="padding:5px 8px;font-size:12px;width:auto">
        <option value="cold_call" ${c.active_channel === 'cold_call' ? 'selected' : ''}>Cold call</option>
        <option value="sms"       ${c.active_channel === 'sms'       ? 'selected' : ''}>SMS</option>
      </select>
    </form>`;

  const statusControl = `
    <form method="POST" action="/oculah/campaigns/${c.id}/status" style="display:flex;gap:6px;align-items:center">
      <span class="ocu-text-3" style="font-size:11px">Status:</span>
      <select name="status" onchange="this.form.submit()" class="ocu-input" style="padding:5px 8px;font-size:12px;width:auto">
        <option value="active"    ${c.status === 'active'    ? 'selected' : ''}>Active</option>
        <option value="paused"    ${c.status === 'paused'    ? 'selected' : ''}>Paused</option>
        <option value="completed" ${c.status === 'completed' ? 'selected' : ''}>Completed</option>
      </select>
    </form>`;

  // Rename — inline form, only shown when user clicks pencil
  const renameForm = `
    <form method="POST" action="/oculah/campaigns/${c.id}/rename" id="cd-rename-form" style="display:none;flex:1;gap:6px">
      <input type="text" name="name" value="${escHTML(c.name)}" maxlength="255" required class="ocu-input" style="flex:1" />
      <button type="submit" class="ocu-btn ocu-btn-primary">Save</button>
      <button type="button" class="ocu-btn ocu-btn-ghost" onclick="cd_cancelRename()">Cancel</button>
    </form>`;

  const closeBtn = c.status !== 'completed'
    ? `<form method="POST" action="/oculah/campaigns/${c.id}/close" style="display:inline-block" onsubmit="return confirm('Close this campaign? It will be marked completed.')">
        <button type="submit" class="ocu-btn ocu-btn-secondary">Close campaign</button>
       </form>`
    : '';

  const newRoundBtn = `
    <form method="POST" action="/oculah/campaigns/${c.id}/new-round" style="display:inline-block" onsubmit="return confirm('Close this campaign and start a fresh round with the same settings?')">
      <button type="submit" class="ocu-btn ocu-btn-secondary">Start new round</button>
    </form>`;

  const dispositionsCard = card({
    title: 'Disposition breakdown',
    meta:  dispositions.length ? `${dispositions.length} dispositions seen` : '',
    body:  dispositionBars(dispositions),
  });

  // Per-campaign filter rules (Task 2). These determine which phones survive
  // the next clean-export. Defaults: voicemail/hangup off (threshold 99 = no
  // limit); DNC + wrong + NIS + already-Lead all on. Lower the thresholds to
  // stop calling numbers that ignore you, and toggle each row to override.
  const num = (k, fallback) => (c[k] != null && c[k] !== '' ? c[k] : fallback);
  const checked = (k, fallback) => (c[k] === false ? '' : (c[k] === true || fallback ? 'checked' : ''));
  const filtersCard = card({
    title: 'Filter rules',
    meta:  'Applied on every clean export and "Start new round"',
    body: `
      <form method="POST" action="/oculah/campaigns/${c.id}/filters" style="display:flex;flex-direction:column;gap:14px;font-size:13px">
        <div style="display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center">
          <label for="cd-vm-th">Skip if voicemailed at least</label>
          <input id="cd-vm-th" type="number" name="voicemail_threshold" min="0" max="99" value="${num('voicemail_threshold', 99)}" class="ocu-input" style="width:70px;text-align:center" />
        </div>
        <div style="display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center">
          <label for="cd-hu-th">Skip if hung up at least</label>
          <input id="cd-hu-th" type="number" name="hangup_threshold" min="0" max="99" value="${num('hangup_threshold', 99)}" class="ocu-input" style="width:70px;text-align:center" />
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;border-top:1px solid var(--ocu-border);padding-top:10px">
          <label style="display:flex;gap:8px;align-items:center;cursor:pointer">
            <input type="checkbox" name="exclude_wrong_number" value="1" ${checked('exclude_wrong_number', true)} /> Skip Wrong-Number phones
          </label>
          <label style="display:flex;gap:8px;align-items:center;cursor:pointer">
            <input type="checkbox" name="exclude_dnc" value="1" ${checked('exclude_dnc', true)} /> Skip Do-Not-Call phones
          </label>
          <label style="display:flex;gap:8px;align-items:center;cursor:pointer">
            <input type="checkbox" name="exclude_not_in_service" value="1" ${checked('exclude_not_in_service', true)} /> Skip Not-In-Service phones
          </label>
          <label style="display:flex;gap:8px;align-items:center;cursor:pointer">
            <input type="checkbox" name="exclude_already_lead" value="1" ${checked('exclude_already_lead', true)} /> Skip contacts already converted to Leads
          </label>
        </div>
        <div style="display:flex;justify-content:flex-end;gap:8px">
          <button type="submit" class="ocu-btn ocu-btn-primary">Save filter rules</button>
        </div>
      </form>`,
  });

  const uploadsCard = card({
    title: 'Filtration history',
    meta:  uploads.length ? `${uploads.length} upload${uploads.length === 1 ? '' : 's'}` : '',
    body:  uploads.length === 0
      ? `<div class="ocu-text-3" style="font-size:13px;text-align:center;padding:20px">No uploads to this campaign yet. Drop a Readymode CSV in the Quick filtration card below to get started.</div>`
      : `<div class="ocu-table-wrap">
          <table class="ocu-table">
            <thead>
              <tr>
                <th class="ocu-th">File</th>
                <th class="ocu-th">Channel</th>
                <th class="ocu-th ocu-th-num">Total</th>
                <th class="ocu-th ocu-th-num">Kept</th>
                <th class="ocu-th ocu-th-num">Filtered</th>
                <th class="ocu-th ocu-th-num">Memory caught</th>
                <th class="ocu-th ocu-th-date">Uploaded</th>
              </tr>
            </thead>
            <tbody>${uploads.map(uploadRow).join('')}</tbody>
          </table>
        </div>`,
  });

  // New cards (Loki port)
  const isSms = (c.active_channel || 'cold_call') === 'sms';
  const contactCard   = contactListCard(c, counts);
  const channelCard   = channelStatusCard(c, metrics);
  const smsCard       = isSms ? smsResultsCard(c) : '';
  const quickFilter   = quickFiltrationCard(c);

  const body = `
    <!-- Campaign name + subtitle live in the topbar (via shell({topbarTitle,
         topbarSubtitle})). Body keeps the back-link, the inline rename
         action + status badge, and the channel/status select controls. -->
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:14px">
      <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0">
        <a href="/oculah/campaigns" class="ocu-text-3" style="font-size:13px;text-decoration:none">← Campaigns</a>
        <span class="ocu-text-3" style="opacity:.5">·</span>
        <button class="ocu-btn ocu-btn-ghost" style="padding:4px 8px;font-size:12px" onclick="cd_startRename()">Rename</button>
        ${statusBadge(c.status)}
      </div>
      <div style="display:flex;gap:10px;align-items:center">
        ${channelControl}
        ${statusControl}
      </div>
    </div>
    ${renameForm}

    ${flashHTML}

    <div style="margin-bottom:14px;display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap">
      <a href="/campaigns/${c.id}" class="ocu-btn ocu-btn-primary">Upload list / call log</a>
      ${newRoundBtn}
      ${closeBtn}
    </div>

    ${kpiStrip}
    ${ratioStrip}
    ${contactCard}

    <div style="display:grid;grid-template-columns:1fr 280px;gap:14px;margin-bottom:18px">
      ${dispositionsCard}
      ${channelCard}
    </div>

    ${smsCard ? `<div style="margin-bottom:14px">${smsCard}</div>` : ''}

    <div style="margin-bottom:14px">${quickFilter}</div>

    <div style="margin-bottom:14px">${uploadsCard}</div>

    <div style="display:grid;grid-template-columns:1fr;gap:14px;margin-bottom:14px">
      ${filtersCard}
    </div>

    <div style="margin-top:18px;display:flex;gap:8px;justify-content:flex-end">
      <a href="/campaigns/${c.id}" class="ocu-btn ocu-btn-ghost">Legacy uploads page →</a>
      ${newRoundBtn}
      ${closeBtn}
    </div>

    <style>
      .ocu-mini-stat{background:#f7f8fa;border:1px solid #e6e8ec;border-radius:8px;padding:10px 12px}
      .ocu-mini-stat .v{font-size:18px;font-weight:700;color:#0c1116;line-height:1.1}
      .ocu-mini-stat .l{font-size:11px;color:#6b6f7a;margin-top:2px}
      .cd-drop{border:2px dashed #c7ccd4;border-radius:10px;padding:24px;text-align:center;cursor:pointer;transition:background .15s,border-color .15s}
      .cd-drop:hover,.cd-drop.dragover{background:#f0f7ff;border-color:#3b82f6}
      .cd-drop-inner{pointer-events:none}
      .cd-result-stats{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px}
      .cd-result-stat{background:#f7f8fa;border:1px solid #e6e8ec;border-radius:8px;padding:8px 12px;min-width:90px}
      .cd-result-stat .v{font-size:18px;font-weight:700;color:#0c1116}
      .cd-result-stat .l{font-size:11px;color:#6b6f7a}
    </style>

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
      function cd_toggleRm() {
        var f = document.getElementById('cd-rm-form');
        if (!f) return;
        f.style.display = (f.style.display === 'none' || !f.style.display) ? 'block' : 'none';
        if (f.style.display === 'block') {
          var inp = f.querySelector('input[name="count"]');
          if (inp) { inp.focus(); inp.select(); }
        }
      }

      // ── Quick filtration drop zone ──────────────────────────────────────
      // Same backend as /oculah/filtration: POST /upload/filter/parse → POST
      // /upload/filter/process. Auto-mapping only — for manual mapping use
      // the full filtration page.
      (function () {
        var zone = document.getElementById('cd-drop');
        if (!zone) return;
        var input    = document.getElementById('cd-file');
        var progress = document.getElementById('cd-progress');
        var errorEl  = document.getElementById('cd-error');
        var results  = document.getElementById('cd-results');
        var campaignId = zone.getAttribute('data-campaign');

        function escHTML(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
        function show(el){if(el)el.style.display='';} function hide(el){if(el)el.style.display='none';}

        zone.addEventListener('click', function(){ input.click(); });
        input.addEventListener('change', function(){ if(input.files&&input.files[0]) run(input.files[0]); });
        ['dragenter','dragover'].forEach(function(ev){
          zone.addEventListener(ev,function(e){e.preventDefault();e.stopPropagation();zone.classList.add('dragover');});
        });
        ['dragleave','drop'].forEach(function(ev){
          zone.addEventListener(ev,function(e){e.preventDefault();e.stopPropagation();zone.classList.remove('dragover');});
        });
        zone.addEventListener('drop',function(e){
          var f=e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files[0];
          if(f) run(f);
        });

        function run(file){
          hide(errorEl); hide(results);
          progress.textContent = 'Parsing ' + file.name + '…';
          show(progress);
          var fd = new FormData(); fd.append('csvfile', file);
          fetch('/upload/filter/parse',{method:'POST',body:fd,credentials:'same-origin'})
            .then(function(r){return r.json().then(function(j){return {ok:r.ok,body:j};});})
            .then(function(res){
              if(!res.ok||res.body.error){
                progress.style.display='none';
                errorEl.textContent = res.body.error||'Parse failed.';
                show(errorEl); return;
              }
              progress.textContent = 'Processing ' + (res.body.total||0).toLocaleString() + ' rows…';
              return fetch('/upload/filter/process',{
                method:'POST',
                headers:{'Content-Type':'application/json'},
                credentials:'same-origin',
                body:JSON.stringify({rows:res.body.rows,mapping:res.body.autoMap||{},campaignId:campaignId,filename:res.body.filename||file.name}),
              }).then(function(r){return r.json().then(function(j){return {ok:r.ok,body:j};});});
            })
            .then(function(res){
              if(!res) return;
              hide(progress);
              if(!res.ok||res.body.error){
                errorEl.textContent = res.body.error||'Filtration failed.';
                show(errorEl); return;
              }
              renderResults(res.body);
            })
            .catch(function(err){
              hide(progress);
              errorEl.textContent = 'Network error: ' + (err.message||err);
              show(errorEl);
            });
        }

        function renderResults(b){
          var s = b.stats || {};
          var html = ''
            + '<div class="cd-result-stats">'
            + statHTML(s.total,'Total rows')
            + statHTML(s.kept,'Kept')
            + statHTML(s.filtered,'Filtered')
            + statHTML(s.lists,'Lists')
            + statHTML(s.memCaught,'Memory caught')
            + '</div>'
            + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">'
            + '<a class="ocu-btn ocu-btn-primary" href="/download/filtered">⤓ Filtered (REISift)</a>'
            + '<a class="ocu-btn ocu-btn-secondary" href="/download/clean">⤓ Clean (Readymode)</a>'
            + '<a class="ocu-btn ocu-btn-ghost" href="/oculah/filtration?campaign=' + encodeURIComponent(campaignId) + '">Open in List Filtration →</a>'
            + '</div>';
          results.innerHTML = html;
          show(results);
          // Reset file input so the same file can be re-dropped if needed.
          input.value = '';
        }

        function statHTML(v,l){
          return '<div class="cd-result-stat"><div class="v">' + Number(v||0).toLocaleString() + '</div><div class="l">' + escHTML(l) + '</div></div>';
        }
      })();
    </script>`;

  return shell({
    title:          c.name || 'Campaign',
    topbarTitle:    c.name || 'Campaign',
    topbarSubtitle: [c.list_type, c.market_name, c.state_code].filter(Boolean).join(' · '),
    activePage:     'campaigns',
    user:           data.user,
    badges:         data.badges || {},
    body,
  });
}

module.exports = { campaignDetail };
