// ═══════════════════════════════════════════════════════════════════════════
// ui/components/records-kpi-strip.js
// 8 quick-filter KPI cards above the Records table. Each card respects
// the page's current filter set, and clicking any card adds (or removes)
// a single quick-filter param while preserving every other filter.
//
// Counts come from the route handler (one aggregation query). This
// component just renders the strip.
// ═══════════════════════════════════════════════════════════════════════════
const { escHTML, fmtNum } = require('../_helpers');

// One row defines a card: query-param key, expected value, label.
// The route turns the (key=value) pair into a SQL condition.
const CARDS = [
  { key: null,            value: null,        label: 'Total',          field: 'total'        },
  { key: 'pipeline',      value: 'lead',      label: 'Leads',          field: 'leads'        },
  { key: 'sold',          value: '1',         label: 'Recently sold',  field: 'sold'         },
  { key: 'vacant',        value: '1',         label: 'Vacant',         field: 'vacant'       },
  { key: 'equity_band',   value: 'high',      label: 'High equity',    field: 'high_equity'  },
  { key: 'equity_band',   value: 'low',       label: 'Low equity',     field: 'low_equity'   },
  { key: 'source_kind',   value: 'third_party', label: 'Third party',  field: 'third_party'  },
  { key: 'source_kind',   value: 'county',    label: 'County records', field: 'county'       },
];

// Build the URL for a given card. If the card is already active, clicking
// removes its filter (toggle behavior). Otherwise it adds the filter on
// top of every other current filter.
function cardHref(card, currentParams) {
  const params = new URLSearchParams(currentParams);
  params.delete('page'); // jump back to page 1 when toggling a quick filter
  if (card.key === null) {
    // "Total" — clear ALL the quick-filter params (but keep general filters
    // like state, city, etc.). Clicking Total feels like "clear quick filters".
    ['pipeline', 'sold', 'vacant', 'equity_band', 'source_kind'].forEach(k => params.delete(k));
  } else if (params.get(card.key) === card.value) {
    // Already active → toggle off
    params.delete(card.key);
  } else {
    params.set(card.key, card.value);
  }
  const qs = params.toString();
  return '/oculah/records' + (qs ? '?' + qs : '');
}

function isCardActive(card, currentParams) {
  if (card.key === null) {
    // "Total" card is "active" only when no quick-filter params are set
    const params = new URLSearchParams(currentParams);
    return !['pipeline', 'sold', 'vacant', 'equity_band', 'source_kind']
      .some(k => params.has(k));
  }
  const params = new URLSearchParams(currentParams);
  return params.get(card.key) === card.value;
}

function recordsKpiStrip(opts = {}) {
  const counts = opts.counts || {};
  const querystring = opts.querystring || '';

  const cardsHTML = CARDS.map(c => {
    const value = Number(counts[c.field] || 0);
    const active = isCardActive(c, querystring);
    const href = cardHref(c, querystring);
    return `
      <a href="${escHTML(href)}" class="ocu-rkpi-card${active ? ' active' : ''}" title="${escHTML(active ? 'Remove this filter' : 'Filter records to ' + c.label)}">
        <div class="ocu-rkpi-label">${escHTML(c.label)}</div>
        <div class="ocu-rkpi-value">${fmtNum(value)}</div>
      </a>`;
  }).join('');

  return `<div class="ocu-rkpi-strip">${cardsHTML}</div>`;
}

module.exports = { recordsKpiStrip };
