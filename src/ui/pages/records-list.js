// ui/pages/records-list.js
// The /ocular/records list page. Two-column layout: filters on left,
// table + pagination on right. Includes bulk action bar at the bottom
// that appears when rows are selected.
//
// Phase 1: viewing only.
// Phase 2 (2026-04-25): added checkbox selection + bulk action bar with
// add-tag, remove-from-list, delete, export-CSV.
const { shell }              = require('../layouts/shell');
const { recordsTable }       = require('../components/records-table');
const { recordsFilters }     = require('../components/records-filters');
const { recordsPagination }  = require('../components/records-pagination');
const { bulkActionBar }      = require('../components/bulk-action-bar');
const { fmtNum, escHTML }    = require('../_helpers');

function buildFilterChips(filters, querystring) {
  const chips = [];
  function chip(label, removeKey) {
    const params = new URLSearchParams(querystring);
    params.delete(removeKey);
    const qs = params.toString();
    const href = '/ocular/records' + (qs ? '?' + qs : '');
    chips.push(`<a class="ocu-filter-chip" href="${escHTML(href)}">${escHTML(label)} <span class="ocu-filter-chip-x">×</span></a>`);
  }
  if (filters.q)            chip('Search: "' + filters.q + '"', 'q');
  if (filters.city)         chip('City: ' + filters.city, 'city');
  if (filters.zip)          chip('ZIP: ' + filters.zip, 'zip');
  if (filters.county)       chip('County: ' + filters.county, 'county');
  if (filters.pipeline)     chip('Stage: ' + filters.pipeline, 'pipeline');
  if (filters.phones)       chip('Phones: ' + filters.phones, 'phones');
  if (filters.min_distress) chip('Distress ≥ ' + filters.min_distress, 'min_distress');
  if (filters.list_id)      chip('On list', 'list_id');
  if (filters.owner_type)   chip('Owner: ' + filters.owner_type, 'owner_type');
  if (filters.occupancy)    chip('Occupancy: ' + filters.occupancy.replace('_', ' '), 'occupancy');
  if (filters.phone_type)   chip('Phone type: ' + filters.phone_type, 'phone_type');
  if (filters.min_year || filters.max_year) {
    const lbl = 'Year: ' + (filters.min_year || '?') + '–' + (filters.max_year || '?');
    // Remove both — build the URL by stripping both keys at once
    const params = new URLSearchParams(querystring);
    params.delete('min_year'); params.delete('max_year');
    const qs = params.toString();
    chips.push(`<a class="ocu-filter-chip" href="${escHTML('/ocular/records' + (qs ? '?' + qs : ''))}">${escHTML(lbl)} <span class="ocu-filter-chip-x">×</span></a>`);
  }
  if (filters.min_equity || filters.max_equity) {
    const lbl = 'Equity: $' + (filters.min_equity || '?') + '–$' + (filters.max_equity || '?');
    const params = new URLSearchParams(querystring);
    params.delete('min_equity'); params.delete('max_equity');
    const qs = params.toString();
    chips.push(`<a class="ocu-filter-chip" href="${escHTML('/ocular/records' + (qs ? '?' + qs : ''))}">${escHTML(lbl)} <span class="ocu-filter-chip-x">×</span></a>`);
  }
  // States — one chip per state, each removable individually
  if (Array.isArray(filters.stateList) && filters.stateList.length) {
    filters.stateList.forEach(code => {
      const params = new URLSearchParams();
      for (const [k, v] of new URLSearchParams(querystring).entries()) {
        if (k === 'state' && v === code) continue;
        params.append(k, v);
      }
      const qs = params.toString();
      const href = '/ocular/records' + (qs ? '?' + qs : '');
      chips.push(`<a class="ocu-filter-chip" href="${escHTML(href)}">${escHTML('State: ' + code)} <span class="ocu-filter-chip-x">×</span></a>`);
    });
  }
  // Tag include/exclude — one chip per tag id
  function tagChips(list, kind, label) {
    if (!Array.isArray(list) || !list.length) return;
    list.forEach(id => {
      const params = new URLSearchParams();
      for (const [k, v] of new URLSearchParams(querystring).entries()) {
        if (k === kind && v === String(id)) continue;
        params.append(k, v);
      }
      const qs = params.toString();
      const href = '/ocular/records' + (qs ? '?' + qs : '');
      chips.push(`<a class="ocu-filter-chip" href="${escHTML(href)}">${escHTML(label + id)} <span class="ocu-filter-chip-x">×</span></a>`);
    });
  }
  tagChips(filters.tagIncludeList, 'tag_include', 'Tag +#');
  tagChips(filters.tagExcludeList, 'tag_exclude', 'Tag −#');

  if (!chips.length) return '';
  return `<div class="ocu-filter-chips">${chips.join('')}</div>`;
}

function recordsList(data = {}) {
  const rows         = Array.isArray(data.rows) ? data.rows : [];
  const total        = Number(data.total) || 0;
  const page         = Number(data.page) || 1;
  const limit        = Number(data.limit) || 25;
  const filters      = data.filters || {};
  const sortBy       = data.sortBy || 'id';
  const sortDir      = data.sortDir || 'desc';
  const querystring  = data.querystring || '';

  const tableQs = (() => {
    const params = new URLSearchParams(querystring);
    params.delete('sort'); params.delete('dir'); params.delete('page');
    return params.toString();
  })();
  const paginationQs = (() => {
    const params = new URLSearchParams(querystring);
    params.delete('page');
    return params.toString();
  })();

  const filterChips = buildFilterChips(filters, querystring);

  // The bulk action bar carries `data-total-rows` so the JS knows how many
  // properties exist behind the current filter (needed for "select all
  // across pages" count display).
  const actionBar = bulkActionBar();

  const body = `
    <div class="ocu-records-header">
      <div>
        <h1 class="ocu-records-title">Records</h1>
        <div class="ocu-records-subtitle">${fmtNum(total)} ${total === 1 ? 'property' : 'properties'}</div>
      </div>
    </div>

    ${filterChips}

    <div class="ocu-records-grid">
      <aside class="ocu-records-sidebar">
        ${recordsFilters({
          filters,
          allStates: data.allStates || [],
          allTags:   data.allTags   || [],
          allLists:  data.allLists  || [],
        })}
      </aside>
      <main class="ocu-records-main">
        ${recordsTable({ rows, sortBy, sortDir, querystring: tableQs })}
        ${recordsPagination({ totalRows: total, limit, page, querystring: paginationQs })}
      </main>
    </div>

    ${actionBar.replace('data-active="false"', `data-active="false" data-total-rows="${total}"`)}
  `;

  return shell({
    title: 'Records',
    body,
    activePage: 'records',
    user: data.user || { name: 'User', initials: '?' },
    badges: data.badges || {},
    extraHead: `<script src="/ocular-static/records-bulk.js" defer></script>`,
  });
}

module.exports = { recordsList };
