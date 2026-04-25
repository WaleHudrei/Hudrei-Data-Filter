// ui/components/kpi-card.js
// Renders a single KPI card: label, big value, optional delta line.
//
// Usage:
//   kpiCard({ label, value, delta, featured, valueClass })
const { escHTML, fmtNum } = require('../_helpers');

function kpiCard(opts = {}) {
  const {
    label = '',
    value = 0,
    delta = null,        // { direction: 'up'|'down'|'neutral', label, num }
    featured = false,
    valueClass = '',     // 'burning' for red, etc.
  } = opts;

  const valueDisplay = typeof value === 'number' ? fmtNum(value) : escHTML(value);

  let deltaHTML = '';
  if (delta) {
    const dir = delta.direction || 'neutral';
    const arrow = dir === 'up' ? '↑' : dir === 'down' ? '↓' : '';
    const numPart = delta.num != null ? `<span class="num">${escHTML(delta.num)}</span>` : '';
    deltaHTML = `
      <div class="ocu-kpi-delta">
        ${dir !== 'neutral' ? `<span class="${dir}">${arrow} ${numPart}</span>` : ''}
        ${escHTML(delta.label || '')}
      </div>`;
  }

  return `
    <div class="ocu-kpi${featured ? ' featured' : ''}">
      <div class="ocu-kpi-label">${escHTML(label)}</div>
      <div class="ocu-kpi-value${valueClass ? ' ' + valueClass : ''}">${valueDisplay}</div>
      ${deltaHTML}
    </div>`;
}

module.exports = { kpiCard };
