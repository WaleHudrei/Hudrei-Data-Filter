// ui/components/property-header.js
// Top-of-page header: back link, big address, pipeline stage dropdown,
// distress score badge, "Edit in Loki" escape hatch.
//
// 2026-04-25 Pipeline dropdown is now editable inline (auto-save).
const { escHTML, fmtNum } = require('../_helpers');

const PIPELINE_STAGES = [
  { value: 'prospect',  label: 'Prospect' },
  { value: 'lead',      label: 'Lead' },
  { value: 'contract',  label: 'Contract' },
  { value: 'closed',    label: 'Closed' },
];

function distressBadge(score) {
  const s = Number(score) || 0;
  let color = '#9CA3AF', label = 'Cold';
  if (s >= 80)      { color = '#DC2626'; label = 'Burning'; }
  else if (s >= 60) { color = '#D97706'; label = 'Hot'; }
  else if (s >= 40) { color = '#2563EB'; label = 'Warm'; }
  return `
    <div class="ocu-distress-badge" style="border-color:${color}40;background:${color}10;color:${color}">
      <span class="ocu-distress-badge-num">${fmtNum(s)}</span>
      <span class="ocu-distress-badge-band">${label}</span>
    </div>`;
}

function pipelineDropdown(propertyId, current) {
  const cur = String(current || 'prospect').toLowerCase();
  const options = PIPELINE_STAGES.map(s =>
    `<option value="${s.value}"${s.value === cur ? ' selected' : ''}>${s.label}</option>`
  ).join('');
  // 2026-04-25 Set data-previous-value to the *currently-saved* stage so
  // the inline JS can revert correctly if the first save fails. Without
  // this, the rollback fell back to options[0] ('prospect') even when the
  // original stage was different.
  return `
    <div class="ocu-pipeline-wrap">
      <label class="ocu-pipeline-label">Stage</label>
      <select class="ocu-pipeline-select"
              data-action="property-pipeline"
              data-property-id="${propertyId}"
              data-previous-value="${cur}">
        ${options}
      </select>
    </div>`;
}

function propertyHeader(p = {}) {
  // 2026-04-29 fix: was reading p.property_address / p.property_city /
  // p.property_state / p.property_zip — those columns don't exist. The
  // DB row from `SELECT * FROM properties` exposes street / city /
  // state_code / zip_code. The H1 was silently rendering as empty for
  // every property since the page was created. User reported "the
  // address on the top left to be bold and much bigger so we can see
  // it" — but it wasn't even rendering.
  const addrLine1 = escHTML(p.street || '');
  const addrLine2 = [p.city, p.state_code].filter(Boolean).map(escHTML).join(', ')
    + (p.zip_code ? ' ' + escHTML(p.zip_code) : '');
  const fullAddr = addrLine1 + (addrLine2 ? ', ' + addrLine2 : '');

  return `
    <div class="ocu-detail-header">
      <a href="/oculah/records" class="ocu-detail-backlink">← All records</a>
      <div class="ocu-detail-header-main">
        <div class="ocu-detail-title-block">
          <h1 class="ocu-detail-title" title="${fullAddr}">${addrLine1 || '(no address)'}</h1>
          ${addrLine2 ? `<div class="ocu-detail-address-line2">${addrLine2}</div>` : ''}
          <div class="ocu-detail-subtitle">
            ${escHTML(p.property_type || 'Unknown type')}
            ${p.year_built ? ` · Built ${escHTML(p.year_built)}` : ''}
            ${p.county ? ` · ${escHTML(p.county)} County` : ''}
          </div>
        </div>
        <div class="ocu-detail-header-right">
          ${p.id ? pipelineDropdown(p.id, p.pipeline_stage) : ''}
          ${distressBadge(p.distress_score)}
          ${p.id ? `<button type="button" class="ocu-btn ocu-btn-secondary"
            onclick="document.getElementById('ocu-edit-property-dialog').showModal()">Edit</button>` : ''}
        </div>
      </div>
    </div>`;
}

module.exports = { propertyHeader, PIPELINE_STAGES };
