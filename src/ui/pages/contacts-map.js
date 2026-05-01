// ═══════════════════════════════════════════════════════════════════════════
// ui/pages/contacts-map.js
// Master-list (campaign contacts) import — column-mapping step.
// Reached via POST /oculah/campaigns/:id/contacts/parse stashing parsed
// rows in session, then GET /oculah/campaigns/:id/contacts/map renders
// this page. Submitting POSTs to /oculah/campaigns/:id/contacts/commit
// which validates required mappings and calls campaigns.importContactList.
//
// Required mappings (server enforced): fname, lname, mailing addr/city/
// state/zip/county, property addr/city/state/zip, phone 1, accepted.
// Optional: phones 2..10, dnc.
// ═══════════════════════════════════════════════════════════════════════════
const { shell } = require('../layouts/shell');
const { escHTML, fmtNum } = require('../_helpers');
// Use escHTML for both text and attribute values — escHTML in _helpers.js
// already escapes & < > " ' which is sufficient for HTML attribute context.
const escAttr = escHTML;

function _select(name, headers, selected, opts) {
  const required = opts && opts.required ? 'required' : '';
  const blank = required ? '— select column —' : '— none —';
  return `<select name="${escAttr(name)}" class="ocu-input" ${required} style="width:100%">
    <option value="">${escHTML(blank)}</option>
    ${headers.map(h => `<option value="${escAttr(h)}"${h === selected ? ' selected' : ''}>${escHTML(h)}</option>`).join('')}
  </select>`;
}

function _row(label, name, headers, selected, hint, opts) {
  const required = opts && opts.required;
  return `
    <div style="display:grid;grid-template-columns:200px 1fr;gap:12px;align-items:start;padding:10px 0;border-bottom:1px solid var(--ocu-border-2)">
      <div>
        <div style="font-size:13px;color:var(--ocu-text-1)">${escHTML(label)}${required ? ' <span style="color:var(--ocu-danger)">*</span>' : ''}</div>
        ${hint ? `<div style="font-size:11px;color:var(--ocu-text-3);margin-top:2px">${escHTML(hint)}</div>` : ''}
      </div>
      <div>${_select(name, headers, selected, opts)}</div>
    </div>`;
}

function contactsMapPage(opts) {
  const { campaign, headers, autoMap, totalRows, originalname, sampleRows } = opts;
  const phones = autoMap.phones || [];
  const sampleHtml = (sampleRows && sampleRows.length)
    ? `<div class="ocu-card" style="margin-top:18px;padding:12px;overflow:auto">
        <div class="ocu-text-2" style="font-size:12px;margin-bottom:8px;font-weight:500">Sample of first ${sampleRows.length} rows from ${escHTML(originalname || 'upload.csv')}</div>
        <table class="ocu-table" style="font-size:11px">
          <thead><tr>${headers.slice(0, 12).map(h => `<th class="ocu-th">${escHTML(h)}</th>`).join('')}${headers.length > 12 ? `<th class="ocu-th">…</th>` : ''}</tr></thead>
          <tbody>
            ${sampleRows.slice(0, 5).map(r =>
              `<tr>${headers.slice(0, 12).map(h => `<td class="ocu-td">${escHTML(String(r[h] ?? '').slice(0, 50))}</td>`).join('')}${headers.length > 12 ? `<td class="ocu-td">…</td>` : ''}</tr>`
            ).join('')}
          </tbody>
        </table>
      </div>`
    : '';

  const phoneSlots = Array.from({ length: 10 }, (_, i) => i + 1).map(i =>
    _row(
      `Phone ${i}`,
      `phone${i}`,
      headers,
      phones[i - 1] || '',
      i === 1 ? 'Required — at least one phone column.' : null,
      { required: i === 1 }
    )
  ).join('');

  const body = `
    <div class="ocu-page" style="max-width:880px;margin:0 auto;padding:24px">
      <div style="margin-bottom:18px">
        <a href="/oculah/campaigns/${campaign.id}" class="ocu-link">← Back to ${escHTML(campaign.name || 'campaign')}</a>
      </div>
      <h1 style="font-size:22px;font-weight:600;margin:0 0 6px">Map columns for master list</h1>
      <div class="ocu-text-2" style="font-size:13px;margin-bottom:18px">
        ${escHTML(originalname || 'upload.csv')} · ${fmtNum(totalRows)} rows · ${fmtNum(headers.length)} columns
      </div>

      <form method="POST" action="/oculah/campaigns/${campaign.id}/contacts/commit">
        <div class="ocu-card" style="padding:16px;margin-bottom:18px">
          <h3 style="font-size:14px;font-weight:600;margin:0 0 8px">Owner</h3>
          ${_row('First name',   'fname',  headers, autoMap.fname  || '', null, { required: true })}
          ${_row('Last name',    'lname',  headers, autoMap.lname  || '', null, { required: true })}
        </div>

        <div class="ocu-card" style="padding:16px;margin-bottom:18px">
          <h3 style="font-size:14px;font-weight:600;margin:0 0 8px">Mailing address</h3>
          ${_row('Mailing address',  'maddr',   headers, autoMap.maddr   || '', null, { required: true })}
          ${_row('Mailing city',     'mcity',   headers, autoMap.mcity   || '', null, { required: true })}
          ${_row('Mailing state',    'mstate',  headers, autoMap.mstate  || '', null, { required: true })}
          ${_row('Mailing zip',      'mzip',    headers, autoMap.mzip    || '', null, { required: true })}
          ${_row('Mailing county',   'mcounty', headers, autoMap.mcounty || '', null, { required: true })}
        </div>

        <div class="ocu-card" style="padding:16px;margin-bottom:18px">
          <h3 style="font-size:14px;font-weight:600;margin:0 0 8px">Property address</h3>
          ${_row('Property address', 'paddr',  headers, autoMap.paddr  || '', null, { required: true })}
          ${_row('Property city',    'pcity',  headers, autoMap.pcity  || '', null, { required: true })}
          ${_row('Property state',   'pstate', headers, autoMap.pstate || '', null, { required: true })}
          ${_row('Property zip',     'pzip',   headers, autoMap.pzip   || '', null, { required: true })}
        </div>

        <div class="ocu-card" style="padding:16px;margin-bottom:18px">
          <h3 style="font-size:14px;font-weight:600;margin:0 0 8px">Phones</h3>
          <div class="ocu-text-3" style="font-size:11px;margin-bottom:8px">Up to 10 phone columns. Phone 1 is required; the rest are optional.</div>
          ${phoneSlots}
        </div>

        <div class="ocu-card" style="padding:16px;margin-bottom:18px">
          <h3 style="font-size:14px;font-weight:600;margin:0 0 8px">Dialer fields</h3>
          ${_row('Accepted by dialer', 'accepted', headers, autoMap.accepted || '',
                'Yes/No column. Drives the Accepted By Dialer count and downstream KPIs.', { required: true })}
          ${_row('DNC', 'dnc', headers, autoMap.dnc || '', 'Optional. Do-Not-Call flag — skip if your list has none.')}
        </div>

        <div style="display:flex;gap:12px;margin-top:24px">
          <button type="submit" class="ocu-btn ocu-btn-primary">Import ${fmtNum(totalRows)} contacts</button>
          <a href="/oculah/campaigns/${campaign.id}" class="ocu-btn ocu-btn-secondary">Cancel</a>
        </div>
      </form>

      ${sampleHtml}
    </div>`;

  return shell({
    title: `Map columns · ${campaign.name || 'campaign'}`,
    body,
    activePage: 'campaigns',
  });
}

module.exports = { contactsMapPage };
