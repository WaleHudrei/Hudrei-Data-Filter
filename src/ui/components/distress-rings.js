// ui/components/distress-rings.js
// Distress score visualization — donut ring + horizontal bars side by side.
//
// Usage:
//   distressRings({ burning, hot, warm, cold })   // numbers (counts)
const { escHTML, fmtNum } = require('../_helpers');

function distressRings(opts = {}) {
  const burning = Number(opts.burning) || 0;
  const hot     = Number(opts.hot)     || 0;
  const warm    = Number(opts.warm)    || 0;
  const cold    = Number(opts.cold)    || 0;
  const total = burning + hot + warm + cold;

  // Pct of total — guard against div-by-zero
  const pct = (n) => total > 0 ? (n / total) * 100 : 0;

  // Ring math: circumference of r=40 circle ≈ 251.33
  // Each segment's stroke-dasharray = (pct/100) * 251.33 followed by space and a large rest
  const C = 251.33;
  const seg = (n) => (pct(n) / 100) * C;

  const offBurning = 0;
  const offHot     = -seg(burning);
  const offWarm    = -(seg(burning) + seg(hot));
  const offCold    = -(seg(burning) + seg(hot) + seg(warm));

  // Bar widths use percentages
  const bands = [
    { key: 'burning', label: 'Burning', count: burning, color: '#DC2626' },
    { key: 'hot',     label: 'Hot',     count: hot,     color: '#D97706' },
    { key: 'warm',    label: 'Warm',    count: warm,    color: '#2563EB' },
    { key: 'cold',    label: 'Cold',    count: cold,    color: '#6B7280' },
  ];

  const bandRows = bands.map(b => `
    <div class="ocu-band">
      <div class="ocu-band-label"><span class="ocu-band-dot ${b.key}"></span>${escHTML(b.label)}</div>
      <div class="ocu-band-bar"><div class="ocu-band-bar-fill" style="width:${pct(b.count).toFixed(1)}%;background:${b.color}"></div></div>
      <div class="ocu-band-count">${fmtNum(b.count)}</div>
    </div>`).join('');

  return `
    <div class="ocu-distress-layout">
      <div class="ocu-ring-viz">
        <svg viewBox="0 0 100 100">
          <circle class="ring-bg" cx="50" cy="50" r="40"/>
          <circle class="ring-seg" cx="50" cy="50" r="40" stroke="#DC2626"
                  stroke-dasharray="${seg(burning).toFixed(2)} ${(C - seg(burning)).toFixed(2)}"
                  stroke-dashoffset="${offBurning.toFixed(2)}"/>
          <circle class="ring-seg" cx="50" cy="50" r="40" stroke="#D97706"
                  stroke-dasharray="${seg(hot).toFixed(2)} ${(C - seg(hot)).toFixed(2)}"
                  stroke-dashoffset="${offHot.toFixed(2)}"/>
          <circle class="ring-seg" cx="50" cy="50" r="40" stroke="#2563EB"
                  stroke-dasharray="${seg(warm).toFixed(2)} ${(C - seg(warm)).toFixed(2)}"
                  stroke-dashoffset="${offWarm.toFixed(2)}"/>
          <circle class="ring-seg" cx="50" cy="50" r="40" stroke="#6B7280"
                  stroke-dasharray="${seg(cold).toFixed(2)} ${(C - seg(cold)).toFixed(2)}"
                  stroke-dashoffset="${offCold.toFixed(2)}"/>
        </svg>
        <div class="ocu-ring-center">
          <div class="num">${fmtNum(total)}</div>
          <div class="lbl">total scored</div>
        </div>
      </div>
      <div class="ocu-bands">${bandRows}</div>
    </div>`;
}

module.exports = { distressRings };
