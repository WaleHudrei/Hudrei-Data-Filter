// ui/components/records-filters.js
// Top filter bar — collapsed by default. Click "Filters" → panel slides down
// with a compact grid layout. State persists in localStorage.
//
// 2026-04-25 Restructured: was a left sidebar, now a top bar. Compact grid
// inside the panel. State filter is now a searchable multi-select dropdown
// covering all 50 states + DC, not just states currently in the DB.
const { escHTML } = require('../_helpers');

// Full US states + DC. Hardcoded so future imports (GA, FL, TX, etc.) are
// pickable before any data lands.
const ALL_STATES = [
  ['AL','Alabama'],['AK','Alaska'],['AZ','Arizona'],['AR','Arkansas'],['CA','California'],
  ['CO','Colorado'],['CT','Connecticut'],['DE','Delaware'],['DC','District of Columbia'],
  ['FL','Florida'],['GA','Georgia'],['HI','Hawaii'],['ID','Idaho'],['IL','Illinois'],
  ['IN','Indiana'],['IA','Iowa'],['KS','Kansas'],['KY','Kentucky'],['LA','Louisiana'],
  ['ME','Maine'],['MD','Maryland'],['MA','Massachusetts'],['MI','Michigan'],['MN','Minnesota'],
  ['MS','Mississippi'],['MO','Missouri'],['MT','Montana'],['NE','Nebraska'],['NV','Nevada'],
  ['NH','New Hampshire'],['NJ','New Jersey'],['NM','New Mexico'],['NY','New York'],
  ['NC','North Carolina'],['ND','North Dakota'],['OH','Ohio'],['OK','Oklahoma'],
  ['OR','Oregon'],['PA','Pennsylvania'],['RI','Rhode Island'],['SC','South Carolina'],
  ['SD','South Dakota'],['TN','Tennessee'],['TX','Texas'],['UT','Utah'],['VT','Vermont'],
  ['VA','Virginia'],['WA','Washington'],['WV','West Virginia'],['WI','Wisconsin'],['WY','Wyoming'],
];

function recordsFilters(opts = {}) {
  const f = opts.filters || {};
  const allTags  = Array.isArray(opts.allTags)  ? opts.allTags  : [];
  const allLists = Array.isArray(opts.allLists) ? opts.allLists : [];
  const allPhoneTags = Array.isArray(opts.allPhoneTags) ? opts.allPhoneTags : [];
  const activeFilterCount = countActive(f);

  // ── State multi-select: rendered as a searchable popover dropdown ─────
  // The popover is purely a UI affordance — we still emit hidden <input
  // type="checkbox" name="state" value="IN"> for each selected state so
  // form submission works without extra JS plumbing.
  const selectedStates = new Set((f.stateList || []).map(s => String(s).toUpperCase()));
  const stateRowsHTML = ALL_STATES.map(([code, name]) => {
    const checked = selectedStates.has(code);
    return `
      <label class="ocu-state-opt" data-search="${escHTML((code + ' ' + name).toLowerCase())}">
        <input type="checkbox" name="state" value="${code}"${checked ? ' checked' : ''}>
        <span class="ocu-state-code">${escHTML(code)}</span>
        <span class="ocu-state-name">${escHTML(name)}</span>
      </label>`;
  }).join('');
  const selectedStatePills = [...selectedStates].map(code => {
    const name = (ALL_STATES.find(([c]) => c === code) || [code, code])[1];
    return `<span class="ocu-state-pill" title="${escHTML(name)}">${escHTML(code)}</span>`;
  }).join('');
  const stateButtonLabel = selectedStates.size === 0
    ? 'Any state'
    : (selectedStates.size === 1 ? '1 state' : selectedStates.size + ' states');

  // ── Tag include/exclude as multi-checkbox lists (kept compact) ────────
  const tagInc = (f.tagIncludeList || []).map(String);
  const tagExc = (f.tagExcludeList || []).map(String);
  const tagIncludeChecks = allTags.map(t => `
    <label class="ocu-check ocu-check-line">
      <input type="checkbox" name="tag_include" value="${t.id}"${tagInc.includes(String(t.id)) ? ' checked' : ''}>
      <span>${escHTML(t.name)}</span>
    </label>`).join('');
  const tagExcludeChecks = allTags.map(t => `
    <label class="ocu-check ocu-check-line">
      <input type="checkbox" name="tag_exclude" value="${t.id}"${tagExc.includes(String(t.id)) ? ' checked' : ''}>
      <span>${escHTML(t.name)}</span>
    </label>`).join('');

  // 2026-04-29 phone-tag filter UI. Backend wires were added earlier
  // (commit bcb73d8); this exposes a checkbox list in the form so users
  // can actually pick phone tags. Mirrors the structure of property-tag
  // include/exclude.
  const phoneTagInc = (f.phoneTagIncludeList || []).map(String);
  const phoneTagExc = (f.phoneTagExcludeList || []).map(String);
  const phoneTagIncludeChecks = allPhoneTags.map(t => `
    <label class="ocu-check ocu-check-line">
      <input type="checkbox" name="phone_tag_include" value="${t.id}"${phoneTagInc.includes(String(t.id)) ? ' checked' : ''}>
      <span>${escHTML(t.name)}</span>
    </label>`).join('');
  const phoneTagExcludeChecks = allPhoneTags.map(t => `
    <label class="ocu-check ocu-check-line">
      <input type="checkbox" name="phone_tag_exclude" value="${t.id}"${phoneTagExc.includes(String(t.id)) ? ' checked' : ''}>
      <span>${escHTML(t.name)}</span>
    </label>`).join('');

  const listOptions = allLists.map(l =>
    `<option value="${l.id}"${String(f.list_id || '') === String(l.id) ? ' selected' : ''}>${escHTML(l.list_name)}</option>`
  ).join('');

  const opt = (sel, value, label) =>
    `<option value="${value}"${sel === value ? ' selected' : ''}>${escHTML(label)}</option>`;

  // 2026-04-29 user request (v2): keep ONLY distress sort, drop the field
  // selector. One compact dropdown — High→Low / Low→High. The form below
  // already supports `sort=distress_score&dir=...` URL params; this is
  // just a UI affordance. Hidden inputs preserve every other active
  // filter when sort changes.
  const sortingByDistress = String(opts.sortBy || '') === 'distress_score';
  const currentDir = sortingByDistress
    ? (String(opts.sortDir || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc')
    : '';
  const sortPassthroughHTML = (opts.sortPassthrough || []).map(([k, v]) =>
    `<input type="hidden" name="${escHTML(k)}" value="${escHTML(v)}">`
  ).join('');
  // 2026-04-29: removed redundant "Default" option — when dir="" the
  // server falls back to desc anyway, so it was visually identical to
  // High → Low.
  const sortControl = `
    <form method="GET" action="/oculah/records" class="ocu-sort-form">
      ${sortPassthroughHTML}
      <input type="hidden" name="sort" value="distress_score">
      <label class="ocu-sort-label" for="ocu-sort-distress">Distress</label>
      <select name="dir" id="ocu-sort-distress" class="ocu-sort-select" onchange="this.form.submit()">
        <option value="desc" ${currentDir !== 'asc' ? 'selected' : ''}>High → Low</option>
        <option value="asc"  ${currentDir === 'asc' ? 'selected' : ''}>Low → High</option>
      </select>
    </form>`;

  // ── The bar itself ─────────────────────────────────────────────────────
  // Recompute Distress lives in the same row as Filters + the distress sort
  // since it operates on the same data the user is sorting through. Moved
  // here from the page header (2026-04-30 user request).
  const recomputeBtn = `
    <a href="/records/_distress" class="ocu-btn ocu-btn-secondary ocu-filter-bar-action" title="Re-score every property's distress band">
      Recompute distress
    </a>`;

  return `
    <div class="ocu-filter-bar" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <button type="button" class="ocu-filter-toggle" id="ocu-filter-toggle"
              aria-expanded="false" aria-controls="ocu-filter-panel">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
          <line x1="4" y1="6" x2="20" y2="6"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="10" y1="18" x2="14" y2="18"/>
        </svg>
        <span>Filters</span>
        ${activeFilterCount > 0 ? `<span class="ocu-filter-toggle-count">${activeFilterCount}</span>` : ''}
        <svg class="ocu-filter-toggle-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>
      ${sortControl}
      ${recomputeBtn}

      <form id="ocu-filter-panel" class="ocu-filter-panel" method="GET" action="/oculah/records" hidden>
        <div class="ocu-filter-grid">

          <!-- Search field intentionally removed — the global search bar at
               the top right of the page covers this. Persist any incoming q
               param invisibly so deep links (e.g. /oculah/records?q=foo)
               keep their search applied even after the user opens filters. -->
          ${f.q ? `<input type="hidden" name="q" value="${escHTML(f.q)}">` : ''}

          <div class="ocu-filter ocu-filter-state">
            <label class="ocu-filter-label">State</label>
            <button type="button" class="ocu-filter-input ocu-state-button" id="ocu-state-button" aria-expanded="false">
              <span class="ocu-state-button-text">${stateButtonLabel}</span>
              <span class="ocu-state-button-pills">${selectedStatePills}</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            <div class="ocu-state-popover" id="ocu-state-popover" hidden>
              <div class="ocu-state-search-wrap">
                <input type="text" class="ocu-state-search" id="ocu-state-search"
                       placeholder="Search states…" autocomplete="off">
              </div>
              <div class="ocu-state-list" id="ocu-state-list">
                ${stateRowsHTML}
              </div>
              <!-- 2026-04-29: removed redundant "Done" button. The form's
                   own "Apply filters" submit button is the canonical apply
                   action; "Done" inside the popover only ever closed the
                   popover, which now happens via outside-click or Esc
                   (handled in records-filter-bar.js) — same UX, less clutter. -->
              <div class="ocu-state-footer">
                <button type="button" class="ocu-state-clear" id="ocu-state-clear">Clear states</button>
              </div>
            </div>
          </div>

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
            <select name="pipeline" class="ocu-filter-input">
              ${opt(f.pipeline || '', '', 'Any')}
              ${opt(f.pipeline || '', 'prospect', 'Prospect')}
              ${opt(f.pipeline || '', 'lead', 'Lead')}
              ${opt(f.pipeline || '', 'contract', 'Contract')}
              ${opt(f.pipeline || '', 'closed', 'Closed')}
            </select>
          </div>

          <div class="ocu-filter">
            <label class="ocu-filter-label">Owner type</label>
            <select name="owner_type" class="ocu-filter-input">
              ${opt(f.owner_type || '', '', 'Any')}
              ${opt(f.owner_type || '', 'Person', 'Person')}
              ${opt(f.owner_type || '', 'Company', 'Company')}
              ${opt(f.owner_type || '', 'Trust', 'Trust')}
            </select>
          </div>

          <div class="ocu-filter">
            <label class="ocu-filter-label">Occupancy</label>
            <select name="occupancy" class="ocu-filter-input">
              ${opt(f.occupancy || '', '', 'Any')}
              ${opt(f.occupancy || '', 'owner_occupied', 'Owner occupied')}
              ${opt(f.occupancy || '', 'absent_owner', 'Absent owner')}
              ${opt(f.occupancy || '', 'unknown', 'Unknown')}
            </select>
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
            <select name="phones" class="ocu-filter-input">
              ${opt(f.phones || '', '', 'Any')}
              ${opt(f.phones || '', 'has', 'Has phones')}
              ${opt(f.phones || '', 'none', 'No phones')}
              ${opt(f.phones || '', 'correct', 'Correct phones only')}
            </select>
          </div>

          <div class="ocu-filter">
            <label class="ocu-filter-label">Phone type</label>
            <select name="phone_type" class="ocu-filter-input">
              ${opt(f.phone_type || '', '', 'Any')}
              ${opt(f.phone_type || '', 'mobile', 'Mobile')}
              ${opt(f.phone_type || '', 'landline', 'Landline')}
              ${opt(f.phone_type || '', 'voip', 'VoIP')}
            </select>
          </div>

          ${allLists.length > 0 ? `
          <div class="ocu-filter">
            <label class="ocu-filter-label">On list</label>
            <select name="list_id" class="ocu-filter-input">
              <option value="">Any</option>
              ${listOptions}
            </select>
          </div>` : ''}

          <!-- 2026-04-29 filter-parity additions: these were already
               supported by the bulk-export selectAll handler but the form
               only exposed half of them. Same set as the bulk-export now. -->
          <div class="ocu-filter">
            <label class="ocu-filter-label">Property type</label>
            <input type="text" name="type" value="${escHTML(f.property_type || '')}"
                   placeholder="SFR, Townhouse…" class="ocu-filter-input">
          </div>
          <div class="ocu-filter">
            <label class="ocu-filter-label">Source</label>
            <input type="text" name="source" value="${escHTML(f.source || '')}"
                   placeholder="PropStream, REISift…" class="ocu-filter-input">
          </div>
          <div class="ocu-filter">
            <label class="ocu-filter-label">Assessed value ($)</label>
            <div class="ocu-filter-pair">
              <input type="number" name="min_assessed" value="${escHTML(f.min_assessed || '')}" placeholder="Min" class="ocu-filter-input">
              <input type="number" name="max_assessed" value="${escHTML(f.max_assessed || '')}" placeholder="Max" class="ocu-filter-input">
            </div>
          </div>
          <div class="ocu-filter">
            <label class="ocu-filter-label">Properties owned</label>
            <div class="ocu-filter-pair">
              <input type="number" name="min_owned" value="${escHTML(f.min_owned || '')}" placeholder="Min" class="ocu-filter-input" min="1">
              <input type="number" name="max_owned" value="${escHTML(f.max_owned || '')}" placeholder="Max" class="ocu-filter-input" min="1">
            </div>
          </div>
          <div class="ocu-filter">
            <label class="ocu-filter-label">Min lists (stack)</label>
            <input type="number" name="min_stack" value="${escHTML(f.min_stack || '')}"
                   min="1" placeholder="e.g. 2" class="ocu-filter-input">
          </div>
          <div class="ocu-filter">
            <label class="ocu-filter-label">Years owned</label>
            <div class="ocu-filter-pair">
              <input type="number" name="min_years_owned" value="${escHTML(f.min_years_owned || '')}" placeholder="Min" class="ocu-filter-input" min="0">
              <input type="number" name="max_years_owned" value="${escHTML(f.max_years_owned || '')}" placeholder="Max" class="ocu-filter-input" min="0">
            </div>
          </div>

          ${allTags.length > 0 ? `
          <details class="ocu-filter ocu-filter-details">
            <summary class="ocu-filter-label">Tags include (${tagInc.length || 'any'})</summary>
            <div class="ocu-check-list">${tagIncludeChecks}</div>
          </details>
          <details class="ocu-filter ocu-filter-details">
            <summary class="ocu-filter-label">Tags exclude (${tagExc.length || 'none'})</summary>
            <div class="ocu-check-list">${tagExcludeChecks}</div>
          </details>` : ''}

          ${allPhoneTags.length > 0 ? `
          <details class="ocu-filter ocu-filter-details">
            <summary class="ocu-filter-label">Phone tags include (${phoneTagInc.length || 'any'})</summary>
            <div class="ocu-check-list">${phoneTagIncludeChecks}</div>
          </details>
          <details class="ocu-filter ocu-filter-details">
            <summary class="ocu-filter-label">Phone tags exclude (${phoneTagExc.length || 'none'})</summary>
            <div class="ocu-check-list">${phoneTagExcludeChecks}</div>
          </details>` : ''}

        </div>

        <div class="ocu-filter-actions">
          <a href="/oculah/records" class="ocu-filters-clear">Clear all</a>
          <button type="submit" class="ocu-btn ocu-btn-primary">Apply filters</button>
        </div>
      </form>
    </div>
  `;
}

// Count active filters so the toggle button can show a badge
function countActive(f) {
  let n = 0;
  if (f.q) n++;
  if (Array.isArray(f.stateList) && f.stateList.length) n += f.stateList.length;
  if (f.city) n++;
  if (f.zip) n++;
  if (f.county) n++;
  if (f.pipeline) n++;
  if (f.owner_type) n++;
  if (f.occupancy) n++;
  if (f.min_distress) n++;
  if (f.min_equity || f.max_equity) n++;
  if (f.min_year || f.max_year) n++;
  if (f.phones) n++;
  if (f.phone_type) n++;
  if (f.list_id) n++;
  if (Array.isArray(f.tagIncludeList) && f.tagIncludeList.length) n += f.tagIncludeList.length;
  if (Array.isArray(f.tagExcludeList) && f.tagExcludeList.length) n += f.tagExcludeList.length;
  // 2026-04-29 new filters: count active ones in the toggle-button badge
  if (f.property_type) n++;
  if (f.source) n++;
  if (f.min_assessed || f.max_assessed) n++;
  if (f.min_owned || f.max_owned) n++;
  if (f.min_stack) n++;
  if (f.min_years_owned || f.max_years_owned) n++;
  if (Array.isArray(f.phoneTagIncludeList) && f.phoneTagIncludeList.length) n += f.phoneTagIncludeList.length;
  if (Array.isArray(f.phoneTagExcludeList) && f.phoneTagExcludeList.length) n += f.phoneTagExcludeList.length;
  return n;
}

module.exports = { recordsFilters };
