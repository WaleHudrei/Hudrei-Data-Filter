// ui/components/records-filters.js
// Left-side filter panel for the Ocular records list.
//
// Phase 2 (2026-04-25): expanded filter set. Param names match what old
// Loki bulk endpoints expect, so the bulk-action filterParams pattern works
// without translation:
//   q, state[], city, zip, county, pipeline, phones, min_distress,
//   tag_include[], tag_exclude[], list_id, owner_type, occupancy,
//   min_year, max_year, min_equity, max_equity, phone_type
const { escHTML } = require('../_helpers');

function checkOption(name, value, label, checked) {
  return `
    <label class="ocu-check">
      <input type="checkbox" name="${escHTML(name)}" value="${escHTML(value)}"${checked ? ' checked' : ''}>
      <span>${escHTML(label)}</span>
    </label>`;
}

function recordsFilters(opts = {}) {
  const f = opts.filters || {};
  const allStates    = Array.isArray(opts.allStates)    ? opts.allStates    : [];
  const allTags      = Array.isArray(opts.allTags)      ? opts.allTags      : [];
  const allLists     = Array.isArray(opts.allLists)     ? opts.allLists     : [];

  // ── State checkbox grid ───────────────────────────────────────────────
  const stateOptions = allStates.map(s =>
    checkOption('state', s.code, s.code, (f.stateList || []).includes(s.code))
  ).join('');

  // ── Tag include / exclude as multi-checkbox lists ─────────────────────
  const tagInc = (f.tagIncludeList || []).map(String);
  const tagExc = (f.tagExcludeList || []).map(String);
  const tagIncludeChecks = allTags.map(t =>
    checkOption('tag_include', String(t.id), t.name, tagInc.includes(String(t.id)))
  ).join('');
  const tagExcludeChecks = allTags.map(t =>
    checkOption('tag_exclude', String(t.id), t.name, tagExc.includes(String(t.id)))
  ).join('');

  // ── Lists multi-select removed; keep simple list_id dropdown ──────────
  const listOptions = allLists.map(l =>
    `<option value="${l.id}"${String(f.list_id || '') === String(l.id) ? ' selected' : ''}>${escHTML(l.list_name)}</option>`
  ).join('');

  // ── Pipeline dropdown ─────────────────────────────────────────────────
  const pipeStages = [['', 'Any'], ['prospect', 'Prospect'], ['lead', 'Lead'], ['contract', 'Contract'], ['closed', 'Closed']];
  const pipelineOptions = pipeStages.map(([v, l]) =>
    `<option value="${v}"${(f.pipeline || '') === v ? ' selected' : ''}>${escHTML(l)}</option>`
  ).join('');

  // ── Phones (Has/None/Correct only) ────────────────────────────────────
  const phoneOptions = [['', 'Any'], ['has', 'Has phones'], ['none', 'No phones'], ['correct', 'Correct phones only']];
  const phonesSelect = phoneOptions.map(([v, l]) =>
    `<option value="${v}"${(f.phones || '') === v ? ' selected' : ''}>${escHTML(l)}</option>`
  ).join('');

  // ── Phase 2: Owner type ───────────────────────────────────────────────
  const ownerTypeOptions = [['', 'Any'], ['Person', 'Person'], ['Company', 'Company'], ['Trust', 'Trust']];
  const ownerTypeSelect = ownerTypeOptions.map(([v, l]) =>
    `<option value="${v}"${(f.owner_type || '') === v ? ' selected' : ''}>${escHTML(l)}</option>`
  ).join('');

  // ── Phase 2: Occupancy (mailing match) ────────────────────────────────
  const occOptions = [
    ['', 'Any'],
    ['owner_occupied', 'Owner occupied'],
    ['absent_owner', 'Absent owner'],
    ['unknown', 'Unknown / no mailing'],
  ];
  const occSelect = occOptions.map(([v, l]) =>
    `<option value="${v}"${(f.occupancy || '') === v ? ' selected' : ''}>${escHTML(l)}</option>`
  ).join('');

  // ── Phase 2: Phone type ───────────────────────────────────────────────
  const phoneTypeOptions = [['', 'Any'], ['mobile', 'Mobile'], ['landline', 'Landline'], ['voip', 'VoIP']];
  const phoneTypeSelect = phoneTypeOptions.map(([v, l]) =>
    `<option value="${v}"${(f.phone_type || '') === v ? ' selected' : ''}>${escHTML(l)}</option>`
  ).join('');

  return `
    <form class="ocu-filters" method="GET" action="/ocular/records">
      <div class="ocu-filters-header">
        <span class="ocu-filters-title">Filters</span>
        <a href="/ocular/records" class="ocu-filters-clear">Clear all</a>
      </div>

      <div class="ocu-filter">
        <label class="ocu-filter-label">Search</label>
        <input type="text" name="q" value="${escHTML(f.q || '')}"
               placeholder="Address, city, name…" class="ocu-filter-input" autocomplete="off">
      </div>

      ${allStates.length > 1 ? `
      <div class="ocu-filter">
        <label class="ocu-filter-label">State</label>
        <div class="ocu-check-grid">${stateOptions}</div>
      </div>` : ''}

      <div class="ocu-filter">
        <label class="ocu-filter-label">City</label>
        <input type="text" name="city" value="${escHTML(f.city || '')}"
               placeholder="Indianapolis…" class="ocu-filter-input">
      </div>

      <div class="ocu-filter">
        <label class="ocu-filter-label">ZIP</label>
        <input type="text" name="zip" value="${escHTML(f.zip || '')}"
               placeholder="46218, 46219…" class="ocu-filter-input">
      </div>

      <div class="ocu-filter">
        <label class="ocu-filter-label">County</label>
        <input type="text" name="county" value="${escHTML(f.county || '')}"
               placeholder="Marion, Lake…" class="ocu-filter-input">
      </div>

      <div class="ocu-filter">
        <label class="ocu-filter-label">Pipeline stage</label>
        <select name="pipeline" class="ocu-filter-input">${pipelineOptions}</select>
      </div>

      <div class="ocu-filter">
        <label class="ocu-filter-label">Owner type</label>
        <select name="owner_type" class="ocu-filter-input">${ownerTypeSelect}</select>
      </div>

      <div class="ocu-filter">
        <label class="ocu-filter-label">Occupancy</label>
        <select name="occupancy" class="ocu-filter-input">${occSelect}</select>
      </div>

      <div class="ocu-filter">
        <label class="ocu-filter-label">Min distress</label>
        <input type="number" name="min_distress" value="${escHTML(f.min_distress || '')}"
               min="0" max="100" placeholder="0–100" class="ocu-filter-input">
      </div>

      <div class="ocu-filter">
        <label class="ocu-filter-label">Equity ($)</label>
        <div class="ocu-filter-pair">
          <input type="number" name="min_equity" value="${escHTML(f.min_equity || '')}" placeholder="Min" class="ocu-filter-input">
          <input type="number" name="max_equity" value="${escHTML(f.max_equity || '')}" placeholder="Max" class="ocu-filter-input">
        </div>
      </div>

      <div class="ocu-filter">
        <label class="ocu-filter-label">Year built</label>
        <div class="ocu-filter-pair">
          <input type="number" name="min_year" value="${escHTML(f.min_year || '')}" placeholder="From" class="ocu-filter-input">
          <input type="number" name="max_year" value="${escHTML(f.max_year || '')}" placeholder="To" class="ocu-filter-input">
        </div>
      </div>

      <div class="ocu-filter">
        <label class="ocu-filter-label">Phones</label>
        <select name="phones" class="ocu-filter-input">${phonesSelect}</select>
      </div>

      <div class="ocu-filter">
        <label class="ocu-filter-label">Phone type</label>
        <select name="phone_type" class="ocu-filter-input">${phoneTypeSelect}</select>
      </div>

      ${allTags.length > 0 ? `
      <details class="ocu-filter-details">
        <summary class="ocu-filter-label" style="cursor:pointer">Tags include (${tagInc.length || 'any'})</summary>
        <div class="ocu-check-list">${tagIncludeChecks}</div>
      </details>
      <details class="ocu-filter-details">
        <summary class="ocu-filter-label" style="cursor:pointer">Tags exclude (${tagExc.length || 'none'})</summary>
        <div class="ocu-check-list">${tagExcludeChecks}</div>
      </details>` : ''}

      ${allLists.length > 0 ? `
      <div class="ocu-filter">
        <label class="ocu-filter-label">On list</label>
        <select name="list_id" class="ocu-filter-input">
          <option value="">Any</option>
          ${listOptions}
        </select>
      </div>` : ''}

      <button type="submit" class="ocu-btn ocu-btn-primary ocu-filter-submit">Apply filters</button>
    </form>
  `;
}

module.exports = { recordsFilters };
