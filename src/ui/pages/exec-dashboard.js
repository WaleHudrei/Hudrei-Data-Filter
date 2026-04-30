// ═══════════════════════════════════════════════════════════════════════════
// ui/pages/exec-dashboard.js
// One-page executive summary (Task 13). Composite health score + the three
// "spend decision" KPIs the CEO actually asks about: how much data we have,
// how clean it is, how much of it has been called, and how productive that
// calling has been. No drill-downs — every metric is a single number with a
// simple "is it good or bad?" treatment.
// ═══════════════════════════════════════════════════════════════════════════
const { shell } = require('../layouts/shell');
const { card }  = require('../components/card');
const { escHTML, fmtNum } = require('../_helpers');

// Translate a 0-100 score into a color. Health and quality scores share this
// gradient so the page reads at a glance.
function scoreColor(s) {
  if (s >= 80) return '#1a7a4a';
  if (s >= 60) return '#9a6800';
  if (s >= 40) return '#c07a1a';
  return '#c0392b';
}
function scoreLabel(s) {
  if (s >= 80) return 'Healthy';
  if (s >= 60) return 'OK';
  if (s >= 40) return 'Needs attention';
  return 'Critical';
}

// Big circular score widget — used for both Overall Health and Data Quality.
function scoreRing(score, label) {
  const s = Math.max(0, Math.min(100, Math.round(score || 0)));
  const c = scoreColor(s);
  const r = 52, cx = 64, cy = 64;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - s / 100);
  return `
    <div style="display:flex;flex-direction:column;align-items:center;gap:8px">
      <svg width="128" height="128" viewBox="0 0 128 128">
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#f0efe9" stroke-width="10" />
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${c}" stroke-width="10"
                stroke-dasharray="${circumference.toFixed(1)}"
                stroke-dashoffset="${offset.toFixed(1)}"
                stroke-linecap="round"
                transform="rotate(-90 ${cx} ${cy})" />
        <text x="${cx}" y="${cy + 6}" text-anchor="middle" font-size="32" font-weight="700" fill="${c}">${s}</text>
      </svg>
      <div style="font-size:12px;color:${c};font-weight:600;text-transform:uppercase;letter-spacing:0.5px">${escHTML(scoreLabel(s))}</div>
      <div style="font-size:13px;color:var(--ocu-text-2);text-align:center">${escHTML(label)}</div>
    </div>`;
}

function metricRow(label, value, hint) {
  return `
    <div style="display:flex;justify-content:space-between;align-items:baseline;padding:8px 0;border-bottom:1px solid var(--ocu-border)">
      <div>
        <div style="font-size:13px;font-weight:500">${escHTML(label)}</div>
        ${hint ? `<div class="ocu-text-3" style="font-size:11px;margin-top:2px">${escHTML(hint)}</div>` : ''}
      </div>
      <div class="ocu-mono" style="font-size:18px;font-weight:600">${value}</div>
    </div>`;
}

function execDashboard(data = {}) {
  const m = data.metrics || {};
  const props        = Number(m.total_properties || 0);
  const owners       = Number(m.total_owners || 0);
  const phones       = Number(m.total_phones || 0);
  const correctPh    = Number(m.correct_phones || 0);
  const wrongPh      = Number(m.wrong_phones || 0);
  const deadPh       = Number(m.dead_phones || 0);
  const dncPh        = Number(m.dnc_phones || 0);
  const leads        = Number(m.lead_props || 0);
  const contracts    = Number(m.contract_props || 0);
  const closed       = Number(m.closed_props || 0);
  const activeCamps  = Number(m.active_campaigns || 0);
  const transfers30  = Number(m.transfers_30d || 0);
  const calls30      = Number(m.calls_30d || 0);

  // ── Health & quality scores ────────────────────────────────────────────────
  // Health = composite of:
  //   - reachable phone share (correct + neutral, divided by total) × 40
  //   - lead conversion (leads / props) × 30, capped
  //   - active campaign presence × 30 (binary: any active = 30, else 0)
  // Quality = (1 - bad_phones / total_phones) × 100, where bad = wrong + dead + dnc.
  const reachableShare = phones > 0 ? (phones - wrongPh - deadPh - dncPh) / phones : 0;
  const leadShare      = props > 0 ? Math.min(1, leads / Math.max(1, props * 0.05)) : 0; // 5% leads = full credit
  const campSignal     = activeCamps > 0 ? 1 : 0;
  const health = Math.round(reachableShare * 40 + leadShare * 30 + campSignal * 30);
  const quality = phones > 0 ? Math.max(0, Math.round((1 - (wrongPh + deadPh + dncPh) / phones) * 100)) : 0;

  // Pipeline value: sum of (estimated_value or assessed_value) for properties
  // in the Lead+ pipeline. Provided by caller in m.pipeline_value (numeric or
  // null if unavailable).
  const pipelineValue = Number(m.pipeline_value || 0);
  const fmtMoney = (n) => n >= 1000000 ? `$${(n / 1000000).toFixed(1)}M` : n >= 1000 ? `$${Math.round(n / 1000)}K` : `$${fmtNum(n)}`;

  const scoresCard = card({
    title: 'Health snapshot',
    meta:  'Updated each page load',
    body: `
      <div style="display:flex;justify-content:space-around;align-items:flex-start;gap:24px;padding:16px 0;flex-wrap:wrap">
        ${scoreRing(health,  'Overall campaign health')}
        ${scoreRing(quality, 'Phone-data quality')}
      </div>`,
  });

  const dataCard = card({
    title: 'Data inventory',
    meta:  '',
    body: `
      ${metricRow('Properties on file', fmtNum(props))}
      ${metricRow('Distinct owners',    fmtNum(owners))}
      ${metricRow('Phones on file',     fmtNum(phones))}
      ${metricRow('Verified phones',    `<span style="color:#1a7a4a">${fmtNum(correctPh)}</span>`, `${phones > 0 ? Math.round(correctPh * 100 / phones) : 0}% of total`)}
      ${metricRow('Bad phones',         `<span style="color:#c0392b">${fmtNum(wrongPh + deadPh + dncPh)}</span>`, `${fmtNum(wrongPh)} wrong · ${fmtNum(deadPh)} dead · ${fmtNum(dncPh)} DNC`)}
    `,
  });

  const pipelineCard = card({
    title: 'Pipeline',
    meta:  pipelineValue > 0 ? `Est. value: ${fmtMoney(pipelineValue)}` : '',
    body: `
      ${metricRow('Active campaigns',   `<span style="color:${activeCamps > 0 ? '#1a7a4a' : '#c0392b'}">${fmtNum(activeCamps)}</span>`)}
      ${metricRow('Leads',              `<span style="color:#1a7a4a">${fmtNum(leads)}</span>`)}
      ${metricRow('Under contract',     `<span style="color:#c07a1a">${fmtNum(contracts)}</span>`)}
      ${metricRow('Closed deals',       `<span style="color:#1a4a9a">${fmtNum(closed)}</span>`)}
    `,
  });

  const activityCard = card({
    title: 'Last 30 days',
    meta:  '',
    body: `
      ${metricRow('Calls logged',     fmtNum(calls30))}
      ${metricRow('Live transfers',   `<span style="color:${transfers30 > 0 ? '#1a7a4a' : '#888'}">${fmtNum(transfers30)}</span>`,
                   calls30 > 0 ? `${(transfers30 * 100 / calls30).toFixed(1)}% of calls` : 'No calls logged in the last 30 days')}
    `,
  });

  return shell({
    title:          'Executive dashboard',
    topbarTitle:    'Executive dashboard',
    topbarSubtitle: 'One-page health view — pick where to invest next',
    activePage:     'exec',
    user:           data.user,
    badges:         data.badges || {},
    body: `
      <div style="display:grid;grid-template-columns:1fr;gap:14px">${scoresCard}</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px;margin-top:14px">
        ${dataCard}
        ${pipelineCard}
        ${activityCard}
      </div>
    `,
  });
}

module.exports = { execDashboard };
