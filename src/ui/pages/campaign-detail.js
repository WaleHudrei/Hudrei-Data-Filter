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
// Contact-list management card. Shows the contact-list metrics returned by
// filtration.getContactStats() and exposes the upload / delete / sync /
// Readymode-count writes.
function contactListCard(c, counts) {
  const isCold = (c.active_channel || 'cold_call') === 'cold_call';
  const totalContacts = Number(counts.total_contacts || 0);
  const totalPhones   = Number(counts.total_phones   || 0);
  const correct       = Number(counts.correct_phones || 0);
  const wrong         = Number(counts.wrong_phones   || 0);
  const nis           = Number(counts.nis_phones     || 0);
  const reached       = Number(counts.reached_contacts || 0);
  const manualCount   = Number(c.manual_count || 0);

  const stats = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:14px">
      <div class="ocu-mini-stat"><div class="v ocu-mono">${fmtNum(totalContacts)}</div><div class="l">Contacts</div></div>
      <div class="ocu-mini-stat"><div class="v ocu-mono">${fmtNum(totalPhones)}</div><div class="l">Total phones</div></div>
      <div class="ocu-mini-stat"><div class="v ocu-mono">${fmtNum(correct)}</div><div class="l">Confirmed correct</div></div>
      <div class="ocu-mini-stat"><div class="v ocu-mono">${fmtNum(wrong)}</div><div class="l">Wrong numbers</div></div>
      <div class="ocu-mini-stat"><div class="v ocu-mono">${fmtNum(nis)}</div><div class="l">NIS flagged</div></div>
      <div class="ocu-mini-stat"><div class="v ocu-mono">${fmtNum(reached)}</div><div class="l">Reached</div></div>
      ${isCold ? `<div class="ocu-mini-stat"><div class="v ocu-mono">${fmtNum(manualCount)}</div><div class="l">Accepted by Readymode</div></div>` : ''}
    </div>`;

  const uploadForm = `
    <form method="POST" action="/oculah/campaigns/${c.id}/contacts/upload"
          enctype="multipart/form-data"
          style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <input type="file" name="contactfile" accept=".csv,.txt" required
             style="flex:1;min-width:200px;font-size:13px" />
      <button type="submit" class="ocu-btn ocu-btn-primary">Upload contact list</button>
    </form>`;

  const deleteForm = totalContacts > 0 ? `
    <form method="POST" action="/oculah/campaigns/${c.id}/contacts/delete"
          style="display:inline-block"
          onsubmit="return confirm('Delete the contact list for this campaign? Filtration data on dialed phones will remain.');">
      <button type="submit" class="ocu-btn ocu-btn-ghost" style="color:#a02222">Delete contact list</button>
    </form>` : '';

  const syncForm = totalContacts > 0 ? `
    <form method="POST" action="/oculah/campaigns/${c.id}/sync-wrong-numbers"
          style="display:inline-block"
          onsubmit="return confirm('Apply historical wrong-number flags to the master contact list?');">
      <button type="submit" class="ocu-btn ocu-btn-secondary">Sync wrong numbers</button>
    </form>` : '';

  const readymodeForm = isCold ? `
    <form method="POST" action="/oculah/campaigns/${c.id}/readymode-count"
          style="display:inline-flex;gap:6px;align-items:center">
      <label class="ocu-text-3" style="font-size:12px">Readymode accepted:</label>
      <input type="number" name="count" min="0" step="1" value="${manualCount}"
             class="ocu-input" style="width:90px;padding:5px 8px;font-size:12px" required />
      <button type="submit" class="ocu-btn ocu-btn-secondary">Update</button>
    </form>` : '';

  const cleanExportLink = totalContacts > 0
    ? `<a href="/campaigns/${c.id}/export/clean" class="ocu-btn ocu-btn-secondary">⤓ Clean export (Readymode)</a>`
    : '';

  const body = `
    ${stats}
    <div style="margin-bottom:12px">${uploadForm}</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      ${cleanExportLink}
      ${syncForm}
      ${readymodeForm}
      ${deleteForm}
    </div>
    ${totalContacts === 0
      ? '<div class="ocu-text-3" style="font-size:12px;margin-top:10px">No contact list uploaded yet. Drop a master CSV above to enable filtration tracking.</div>'
      : ''}`;

  return card({
    title: 'Contact list',
    meta:  totalContacts > 0 ? `${fmtNum(totalContacts)} contacts · ${fmtNum(totalPhones)} phones` : 'Empty',
    body,
  });
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
  const smsCard       = isSms ? smsResultsCard(c) : '';
  const quickFilter   = quickFiltrationCard(c);

  const body = `
    <div class="ocu-page-header" style="align-items:flex-start">
      <div style="flex:1;min-width:0">
        <div style="margin-bottom:6px"><a href="/oculah/campaigns" class="ocu-text-3" style="font-size:13px;text-decoration:none">← Campaigns</a></div>
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
      ${contactCard}
    </div>

    ${smsCard ? `<div style="margin-top:14px">${smsCard}</div>` : ''}

    <div style="margin-top:14px">${quickFilter}</div>

    <div style="margin-top:14px">${uploadsCard}</div>

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
    title:      c.name || 'Campaign',
    activePage: 'campaigns',
    user:       data.user,
    badges:     data.badges || {},
    body,
  });
}

module.exports = { campaignDetail };
