// ui/pages/records-list.js
// /oculah/records — list page. Layout: filter bar on top (collapsed by
// default), then table + pagination full-width below.
//
// 2026-04-25 Refactored from two-column to top-bar layout. Bulk action bar
// continues to slide up from the bottom when rows are selected.
const { shell }              = require('../layouts/shell');
const { recordsTable }       = require('../components/records-table');
const { recordsFilters }     = require('../components/records-filters');
const { recordsPagination }  = require('../components/records-pagination');
const { bulkActionBar }      = require('../components/bulk-action-bar');
const { recordsKpiStrip }    = require('../components/records-kpi-strip');
const { fmtNum, escHTML }    = require('../_helpers');

function buildFilterChips(filters, querystring) {
  const chips = [];
  function chip(label, removeKey) {
    const params = new URLSearchParams(querystring);
    params.delete(removeKey);
    const qs = params.toString();
    const href = '/oculah/records' + (qs ? '?' + qs : '');
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
    const params = new URLSearchParams(querystring);
    params.delete('min_year'); params.delete('max_year');
    const qs = params.toString();
    chips.push(`<a class="ocu-filter-chip" href="${escHTML('/oculah/records' + (qs ? '?' + qs : ''))}">${escHTML(lbl)} <span class="ocu-filter-chip-x">×</span></a>`);
  }
  if (filters.min_equity || filters.max_equity) {
    const lbl = 'Equity: $' + (filters.min_equity || '?') + '–$' + (filters.max_equity || '?');
    const params = new URLSearchParams(querystring);
    params.delete('min_equity'); params.delete('max_equity');
    const qs = params.toString();
    chips.push(`<a class="ocu-filter-chip" href="${escHTML('/oculah/records' + (qs ? '?' + qs : ''))}">${escHTML(lbl)} <span class="ocu-filter-chip-x">×</span></a>`);
  }
  if (Array.isArray(filters.stateList) && filters.stateList.length) {
    filters.stateList.forEach(code => {
      const params = new URLSearchParams();
      for (const [k, v] of new URLSearchParams(querystring).entries()) {
        if (k === 'state' && v === code) continue;
        params.append(k, v);
      }
      const qs = params.toString();
      const href = '/oculah/records' + (qs ? '?' + qs : '');
      chips.push(`<a class="ocu-filter-chip" href="${escHTML(href)}">${escHTML('State: ' + code)} <span class="ocu-filter-chip-x">×</span></a>`);
    });
  }
  function tagChips(list, kind, label) {
    if (!Array.isArray(list) || !list.length) return;
    list.forEach(id => {
      const params = new URLSearchParams();
      for (const [k, v] of new URLSearchParams(querystring).entries()) {
        if (k === kind && v === String(id)) continue;
        params.append(k, v);
      }
      const qs = params.toString();
      const href = '/oculah/records' + (qs ? '?' + qs : '');
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
  const actionBar = bulkActionBar();

  // Top-bar layout: filters bar full-width on top, then chips, then table.
  // Title + count live in the shell topbar; "Recompute distress" moved into
  // the filter bar (records-filters.js); "Merge duplicates" moved to HQ.
  // KPI strip sits above the filters — 8 quick-filter cards that toggle a
  // single param each on click.
  const body = `
    ${recordsKpiStrip({ counts: data.kpiCounts || {}, querystring })}

    ${recordsFilters({
      filters,
      allTags:      data.allTags      || [],
      allLists:     data.allLists     || [],
      allPhoneTags: data.allPhoneTags || [],
      sortBy:       sortBy,
      sortDir:      sortDir,
      // Passthrough every non-sort param so the sort form preserves
      // filters when the user changes the dropdown.
      sortPassthrough: (() => {
        const out = [];
        const qs = new URLSearchParams(data.querystring || '');
        for (const [k, v] of qs.entries()) {
          if (k === 'sort' || k === 'dir' || k === 'page') continue;
          out.push([k, v]);
        }
        return out;
      })(),
    })}

    ${filterChips}

    <div class="ocu-records-main-fullwidth">
      ${recordsTable({ rows, sortBy, sortDir, querystring: tableQs })}
      ${recordsPagination({ totalRows: total, limit, page, querystring: paginationQs })}
    </div>

    ${actionBar.replace('data-active="false"', `data-active="false" data-total-rows="${total}"`)}
  `;

  return shell({
    title: 'Records',
    topbarTitle:    'Records',
    topbarSubtitle: `${fmtNum(total)} ${total === 1 ? 'property' : 'properties'}`,
    body,
    activePage: 'records',
    user: data.user || { name: 'User', initials: '?' },
    badges: data.badges || {},
    extraHead: `
      <script src="/oculah-static/records-filter-bar.js?v=3" defer></script>
      <script src="/oculah-static/records-bulk.js" defer></script>
    `,
  });
}

module.exports = { recordsList };
