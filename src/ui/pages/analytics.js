// ═══════════════════════════════════════════════════════════════════════════
// ui/pages/analytics.js
// Campaign comparison + leads-over-time trend (Task 5).
// Renders a side-by-side table of every campaign with the headline KPIs and
// a per-campaign sparkline of leads/week so users can pick the top performer
// at a glance and see whether momentum is up or down.
// ═══════════════════════════════════════════════════════════════════════════
const { shell } = require('../layouts/shell');
const { card }  = require('../components/card');
const { escHTML, fmtNum, fmtRelative } = require('../_helpers');

function pct(n, d) {
  if (!d || d <= 0) return '—';
  return Math.round((n * 100) / d) + '%';
}

// Render a tiny inline sparkline from an array of weekly counts. SVG so it
// scales crisp; no external deps. Empty array → dash.
function sparkline(weekly) {
  const arr = (weekly || []).map(w => Number(w.count) || 0);
  if (!arr.length) return '<span class="ocu-text-3">—</span>';
  const w = 100, h = 26, pad = 2;
  const max = Math.max(1, ...arr);
  const step = arr.length > 1 ? (w - pad * 2) / (arr.length - 1) : 0;
  const pts = arr.map((v, i) => {
    const x = pad + i * step;
    const y = h - pad - (v / max) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const areaPts = `${pad},${h - pad} ${pts} ${(pad + (arr.length - 1) * step).toFixed(1)},${h - pad}`;
  return `
    <svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" style="display:block">
      <polygon points="${areaPts}" fill="#1a7a4a22" />
      <polyline points="${pts}" fill="none" stroke="#1a7a4a" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" />
    </svg>`;
}

// One row = one campaign. The "Conv." column is leads ÷ unique-numbers because
// "leads ÷ contacted" would punish brand-new campaigns where contacted=0.
function campaignRow(c) {
  const leads      = Number(c.leads || 0);
  const transfers  = Number(c.total_transfers || 0);
  const callable   = Number(c.total_callable || 0);
  const unique     = Number(c.total_unique_numbers || 0);
  const connected  = Number(c.total_connected || 0);
  const filtered   = Number(c.total_filtered || 0);
  const status     = c.status || 'active';
  const statusCls  = status === 'active' ? 'ocu-pill-good' : (status === 'paused' ? 'ocu-pill-warn' : 'ocu-pill-primary');
  return `<tr>
    <td class="ocu-td"><a href="/oculah/campaigns/${c.id}" class="ocu-link" style="font-weight:500">${escHTML(c.name)}</a></td>
    <td class="ocu-td"><span class="ocu-pill ${statusCls}">${escHTML(status)}</span></td>
    <td class="ocu-td ocu-td-text">${escHTML(c.list_type || '—')}</td>
    <td class="ocu-td ocu-td-num"><span class="ocu-mono">${fmtNum(unique)}</span></td>
    <td class="ocu-td ocu-td-num"><span class="ocu-mono">${fmtNum(callable)}</span></td>
    <td class="ocu-td ocu-td-num"><span class="ocu-mono">${fmtNum(filtered)}</span></td>
    <td class="ocu-td ocu-td-num"><span class="ocu-mono">${fmtNum(connected)}</span></td>
    <td class="ocu-td ocu-td-num"><span class="ocu-mono" style="color:${transfers > 0 ? '#1a7a4a' : '#888'};font-weight:${transfers > 0 ? '600' : '400'}">${fmtNum(transfers)}</span></td>
    <td class="ocu-td ocu-td-num"><span class="ocu-mono">${pct(leads || transfers, unique)}</span></td>
    <td class="ocu-td">${sparkline(c.weekly_leads)}</td>
  </tr>`;
}

// Crown the top-performing campaign (most transfers, then most leads). Used
// for the "Top performer" callout above the comparison table.
function topPerformer(rows) {
  let best = null, bestScore = -1;
  for (const c of rows) {
    const score = (Number(c.total_transfers || 0) * 10) + Number(c.leads || 0);
    if (score > bestScore) { best = c; bestScore = score; }
  }
  return best;
}

function analytics(data = {}) {
  const rows = Array.isArray(data.campaigns) ? data.campaigns : [];
  const totalLeads     = rows.reduce((a, c) => a + Number(c.leads || c.total_transfers || 0), 0);
  const totalCallable  = rows.reduce((a, c) => a + Number(c.total_callable || 0), 0);
  const totalUnique    = rows.reduce((a, c) => a + Number(c.total_unique_numbers || 0), 0);
  const totalFiltered  = rows.reduce((a, c) => a + Number(c.total_filtered || 0), 0);
  const totalConnected = rows.reduce((a, c) => a + Number(c.total_connected || 0), 0);
  const top = topPerformer(rows);

  const headerKpis = `
    <div class="ocu-kpi-row" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
      <div class="ocu-card" style="padding:14px">
        <div class="ocu-card-meta" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px">Campaigns</div>
        <div class="ocu-mono" style="font-size:24px;font-weight:600;margin-top:4px">${fmtNum(rows.length)}</div>
      </div>
      <div class="ocu-card" style="padding:14px">
        <div class="ocu-card-meta" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px">Total leads</div>
        <div class="ocu-mono" style="font-size:24px;font-weight:600;margin-top:4px;color:${totalLeads > 0 ? '#1a7a4a' : 'inherit'}">${fmtNum(totalLeads)}</div>
      </div>
      <div class="ocu-card" style="padding:14px">
        <div class="ocu-card-meta" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px">Connected</div>
        <div class="ocu-mono" style="font-size:24px;font-weight:600;margin-top:4px">${fmtNum(totalConnected)}</div>
      </div>
      <div class="ocu-card" style="padding:14px">
        <div class="ocu-card-meta" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px">Filtered out</div>
        <div class="ocu-mono" style="font-size:24px;font-weight:600;margin-top:4px;color:#9a6800">${fmtNum(totalFiltered)}</div>
      </div>
      <div class="ocu-card" style="padding:14px">
        <div class="ocu-card-meta" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px">Conv. rate</div>
        <div class="ocu-mono" style="font-size:24px;font-weight:600;margin-top:4px">${pct(totalLeads, totalUnique)}</div>
      </div>
    </div>`;

  const topCard = top
    ? card({
        title: 'Top performer',
        meta:  'By transfers, leads tiebreaks',
        body: `
          <div style="display:flex;justify-content:space-between;align-items:center;gap:14px;font-size:14px">
            <div>
              <a href="/oculah/campaigns/${top.id}" class="ocu-link" style="font-weight:600;font-size:15px">${escHTML(top.name)}</a>
              <div class="ocu-text-3" style="font-size:12px;margin-top:2px">${escHTML(top.list_type || '—')} · ${escHTML(top.market_name || '')}</div>
            </div>
            <div style="display:flex;gap:18px;font-size:12px">
              <div><div class="ocu-text-3">Transfers</div><div class="ocu-mono" style="font-size:18px;font-weight:600">${fmtNum(top.total_transfers || 0)}</div></div>
              <div><div class="ocu-text-3">Leads</div><div class="ocu-mono" style="font-size:18px;font-weight:600">${fmtNum(top.leads || 0)}</div></div>
              <div><div class="ocu-text-3">Conv.</div><div class="ocu-mono" style="font-size:18px;font-weight:600">${pct(top.leads || top.total_transfers || 0, top.total_unique_numbers || 0)}</div></div>
            </div>
          </div>`,
      })
    : '';

  const tableCard = card({
    title: 'Campaign comparison',
    meta:  rows.length ? `${rows.length} campaigns · trend = leads/week (last 8 weeks)` : '',
    body:  rows.length === 0
      ? `<div class="ocu-empty" style="padding:24px;text-align:center;color:var(--ocu-text-3)">No campaigns yet. Create one from the Campaigns page.</div>`
      : `<div class="ocu-table-wrap">
          <table class="ocu-table">
            <thead>
              <tr>
                <th class="ocu-th">Campaign</th>
                <th class="ocu-th">Status</th>
                <th class="ocu-th">Type</th>
                <th class="ocu-th ocu-th-num">Unique #s</th>
                <th class="ocu-th ocu-th-num">Callable</th>
                <th class="ocu-th ocu-th-num">Filtered</th>
                <th class="ocu-th ocu-th-num">Connected</th>
                <th class="ocu-th ocu-th-num">Transfers</th>
                <th class="ocu-th ocu-th-num">Conv.</th>
                <th class="ocu-th">Trend</th>
              </tr>
            </thead>
            <tbody>${rows.map(campaignRow).join('')}</tbody>
          </table>
        </div>`,
  });

  return shell({
    title:      'Analytics',
    activePage: 'analytics',
    user:       data.user,
    badges:     data.badges || {},
    body: `
      <div class="ocu-page-header">
        <div>
          <h1 class="ocu-page-title">Analytics</h1>
          <div class="ocu-page-subtitle">Campaign comparison + 8-week trend</div>
        </div>
      </div>
      ${headerKpis}
      <div style="margin-top:18px">${topCard}</div>
      <div style="margin-top:14px">${tableCard}</div>
    `,
  });
}

module.exports = { analytics };
