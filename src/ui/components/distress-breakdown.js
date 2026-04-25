// ui/components/distress-breakdown.js
// Shows the score's component signals — what made this property distressed.
const { escHTML, fmtNum } = require('../_helpers');

function distressBreakdown(opts = {}) {
  const score = Number(opts.score) || 0;
  const breakdown = Array.isArray(opts.breakdown) ? opts.breakdown : [];

  if (!breakdown.length) {
    return `
      <div class="ocu-distress-empty">
        <div style="font-size:24px;color:var(--ocu-text-2);font-family:var(--ocu-mono);font-weight:600">${fmtNum(score)}</div>
        <div style="font-size:12px;color:var(--ocu-text-3);margin-top:4px">No distress signals detected.</div>
      </div>`;
  }

  // Sort breakdown highest-weight-first so the strongest signals lead.
  const sorted = breakdown.slice().sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0));

  return `
    <div class="ocu-distress-list">
      ${sorted.map(b => {
        const weight = Number(b.weight) || 0;
        const sign = weight >= 0 ? '+' : '';
        return `
          <div class="ocu-signal-row">
            <div class="ocu-signal-label">${escHTML(b.label || b.signal || 'Signal')}</div>
            <div class="ocu-signal-weight" style="color:${weight > 0 ? 'var(--ocu-burning)' : 'var(--ocu-text-3)'}">
              ${sign}${weight}
            </div>
          </div>`;
      }).join('')}
    </div>`;
}

module.exports = { distressBreakdown };
