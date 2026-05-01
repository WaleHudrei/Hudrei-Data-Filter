// ui/components/property-info.js
// Grid of property facts. Each row is label + mono value.
const { escHTML, fmtNum } = require('../_helpers');

function fmtMoney(n) {
  if (n == null || isNaN(Number(n))) return '—';
  return '$' + fmtNum(Math.round(Number(n)));
}
function fmtPct(n) {
  if (n == null || isNaN(Number(n))) return '—';
  return Number(n).toFixed(1) + '%';
}
function or(value, fallback = '—') {
  if (value == null || value === '') return fallback;
  return value;
}

function propertyInfo(p = {}) {
  const facts = [
    { label: 'Type',          value: or(p.property_type) },
    { label: 'Year built',    value: or(p.year_built) },
    { label: 'Square feet',   value: p.sq_ft ? fmtNum(p.sq_ft) : '—' },
    { label: 'Bedrooms',      value: or(p.bedrooms) },
    { label: 'Bathrooms',     value: or(p.bathrooms) },
    { label: 'Lot size',      value: or(p.lot_size_sqft, '—') },
    { label: 'Assessed value',     value: fmtMoney(p.assessed_value),     mono: true },
    { label: 'Market value',       value: fmtMoney(p.estimated_market_value), mono: true },
    { label: 'Equity',             value: fmtPct(p.equity_percent),       mono: true },
    { label: 'Owner occupied',     value: p.owner_occupied === true ? 'Yes' : p.owner_occupied === false ? 'No' : '—' },
    { label: 'Years owned',        value: or(p.years_owned) },
    { label: 'Status',             value: or(p.property_status) },
  ];

  return `
    <div class="ocu-fact-grid">
      ${facts.map(f => `
        <div class="ocu-fact">
          <div class="ocu-fact-label">${escHTML(f.label)}</div>
          <div class="ocu-fact-value${f.mono ? ' mono' : ''}">${escHTML(f.value)}</div>
        </div>`).join('')}
    </div>`;
}

module.exports = { propertyInfo };
