// ═══════════════════════════════════════════════════════════════════════════
// ui/pages/campaigns-list.js
// Ocular Campaigns list page. Tabs filter by status (active/completed/all).
// Each row shows market, list type, channel, contacts, callable, leads,
// started date. Click through to the Ocular campaign detail page.
// ═══════════════════════════════════════════════════════════════════════════
const { shell }   = require('../layouts/shell');
const { kpiCard } = require('../components/kpi-card');
const { escHTML, fmtNum, fmtRelative } = require('../_helpers');

function statusBadge(s) {
  const map = {
    active:    { label: 'Active',    cls: 'ocu-pill ocu-pill-good' },
    completed: { label: 'Completed', cls: 'ocu-pill ocu-pill-primary' },
    paused:    { label: 'Paused',    cls: 'ocu-pill ocu-pill-warn' },
  };
  const m = map[s] || { label: s || '—', cls: 'ocu-pill' };
  return `<span class="${m.cls}">${escHTML(m.label)}</span>`;
}

function channelBadge(ch) {
  if (!ch) return '<span class="ocu-text-3">—</span>';
  const map = { cold_call: 'Cold call', sms: 'SMS' };
  return `<span class="ocu-pill" data-channel="${escHTML(ch)}">${escHTML(map[ch] || ch)}</span>`;
}

function row(c) {
  const counts = c.contact_counts || {};
  const callable = (counts.total_phones || 0) - (counts.wrong_phones || 0) - (counts.nis_phones || 0);

  // Triage stats stamped on the row for the hover popover. Mirrors the
  // metrics that drive the campaign detail page's KPI strip — call-log
  // ratio, connect ratio, wrong-number count, callable remaining, last
  // round timestamp. Computed once per row, escaped as data-* attributes
  // so the popover JS can render without re-fetching.
  const callLogs    = Number(c.total_unique_numbers || 0);
  const connected   = Number(c.total_connected     || 0);
  const wrongNums   = Number(c.total_wrong_numbers || 0);
  const totalPhones = Number(counts.total_phones   || 0);
  const totalCt     = Number(counts.total_contacts || 0);
  const clr = totalPhones > 0 ? ((callLogs / totalPhones) * 100).toFixed(1) : '0.0';
  const cr  = callLogs    > 0 ? ((connected / callLogs)  * 100).toFixed(1) : '0.0';
  const lastRound = c.last_round_at || c.last_round_date || c.updated_at || c.start_date || c.created_at;

  return `<tr class="ocu-campaign-row" tabindex="0"
              data-campaign-id="${c.id}"
              data-campaign-name="${escHTML(c.name)}"
              data-stat-clr="${clr}"
              data-stat-cr="${cr}"
              data-stat-callable="${Math.max(0, callable)}"
              data-stat-wrong="${wrongNums}"
              data-stat-leads="${counts.lead_contacts || 0}"
              data-stat-contacts="${totalCt}"
              data-stat-last-round="${lastRound ? escHTML(fmtRelative(lastRound)) : '—'}"
              onclick="window.location='/oculah/campaigns/${c.id}'">
    <td class="ocu-td">
      <a href="/oculah/campaigns/${c.id}" class="ocu-link ocu-td-primary">${escHTML(c.name)}</a>
      ${c.market_name || c.state_code ? `<div class="ocu-td-meta">${escHTML(c.market_name || '')}${c.state_code ? ' · ' + escHTML(c.state_code) : ''}</div>` : ''}
    </td>
    <td class="ocu-td"><span class="ocu-pill">${escHTML(c.list_type || '—')}</span></td>
    <td class="ocu-td">${channelBadge(c.active_channel)}</td>
    <td class="ocu-td">${statusBadge(c.status)}</td>
    <td class="ocu-td ocu-td-num"><span class="ocu-mono">${fmtNum(counts.total_contacts || 0)}</span></td>
    <td class="ocu-td ocu-td-num"><span class="ocu-mono">${fmtNum(Math.max(0, callable))}</span></td>
    <td class="ocu-td ocu-td-num">${counts.lead_contacts > 0 ? `<span class="ocu-mono">${fmtNum(counts.lead_contacts)}</span>` : '<span class="ocu-text-3">—</span>'}</td>
    <td class="ocu-td ocu-td-date">${fmtRelative(c.start_date || c.created_at)}</td>
  </tr>`;
}

function tabLink(label, value, currentTab, count) {
  const isActive = (currentTab || 'active') === value;
  return `<a href="/oculah/campaigns?tab=${escHTML(value)}" class="ocu-tab ${isActive ? 'active' : ''}" style="text-decoration:none;display:inline-block">${escHTML(label)} <span class="ocu-text-3">(${fmtNum(count)})</span></a>`;
}

/**
 * @param {Object} data
 *   - user, badges
 *   - campaigns: array of all campaigns (already enriched with .contact_counts)
 *   - tab: 'active' | 'completed' | 'all'
 */
function campaignsList(data = {}) {
  const all = Array.isArray(data.campaigns) ? data.campaigns : [];
  const tab = data.tab || 'active';

  const counts = {
    active:    all.filter(c => c.status === 'active').length,
    completed: all.filter(c => c.status === 'completed').length,
    all:       all.length,
  };

  const filtered = tab === 'all' ? all : all.filter(c => c.status === tab);

  // total_contacts / lead_contacts come back from the SQL aggregate as
  // strings on some pg builds (no explicit ::int cast on the SUM); the
  // raw `+` was string-concatenating "0" + "5149" + "1277" + "5149" =
  // "0514912775149". Number() forces coercion before addition.
  const totalContactsAcross = all.reduce((sum, c) => sum + Number((c.contact_counts && c.contact_counts.total_contacts) || 0), 0);
  const totalLeadsAcross    = all.reduce((sum, c) => sum + Number((c.contact_counts && c.contact_counts.lead_contacts)  || 0), 0);

  const kpiStrip = `
    <div class="ocu-kpi-row" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr));margin-bottom:18px">
      ${kpiCard({ label: 'Active campaigns', value: counts.active, featured: true })}
      ${kpiCard({ label: 'Total contacts', value: totalContactsAcross })}
      ${kpiCard({ label: 'Leads (all campaigns)', value: totalLeadsAcross, valueClass: totalLeadsAcross > 0 ? 'burning' : '' })}
    </div>`;

  const tableHTML = filtered.length === 0
    ? `<div class="ocu-empty">No ${tab === 'all' ? '' : tab + ' '}campaigns yet.</div>`
    : `
      <div class="ocu-table-wrap">
        <table class="ocu-table">
          <thead>
            <tr>
              <th class="ocu-th">Campaign</th>
              <th class="ocu-th">List type</th>
              <th class="ocu-th">Channel</th>
              <th class="ocu-th">Status</th>
              <th class="ocu-th ocu-th-num">Contacts</th>
              <th class="ocu-th ocu-th-num">Callable</th>
              <th class="ocu-th ocu-th-num">Leads</th>
              <th class="ocu-th ocu-th-date">Started</th>
            </tr>
          </thead>
          <tbody>${filtered.map(row).join('')}</tbody>
        </table>
      </div>`;

  // "+ New campaign" lives on the tabs row right after All (2026-04-30 user
  // request). Tabs sit on the left, button anchors to the right of the row;
  // both share a single baseline so the button height matches the underlined
  // tab labels.
  const body = `
    ${kpiStrip}

    <div class="ocu-tabs" style="display:flex;align-items:center;gap:14px;margin-bottom:14px">
      ${tabLink('Active', 'active', tab, counts.active)}
      ${tabLink('Completed', 'completed', tab, counts.completed)}
      ${tabLink('All', 'all', tab, counts.all)}
      <a href="/oculah/campaigns/new" class="ocu-btn ocu-btn-primary" style="margin-left:auto">+ New campaign</a>
    </div>

    ${tableHTML}

    <!-- Campaign quick-stats popover. One shared element appended once;
         JS below populates from data-* attributes on the hovered row and
         positions it over the row. Uses pointer-events:none on the popover
         itself so moving the mouse onto it doesn't dismiss the row hover. -->
    <div id="ocu-campaign-popover" class="ocu-campaign-popover" hidden role="status" aria-live="polite">
      <div class="ocu-campaign-popover-title" data-pop-name></div>
      <div class="ocu-campaign-popover-grid">
        <div class="ocu-campaign-popover-stat"><div class="lbl">CLR</div><div class="val" data-pop-clr></div></div>
        <div class="ocu-campaign-popover-stat"><div class="lbl">CR</div><div class="val" data-pop-cr></div></div>
        <div class="ocu-campaign-popover-stat"><div class="lbl">Wrong #</div><div class="val" data-pop-wrong></div></div>
        <div class="ocu-campaign-popover-stat"><div class="lbl">Callable</div><div class="val" data-pop-callable></div></div>
        <div class="ocu-campaign-popover-stat"><div class="lbl">Leads</div><div class="val" data-pop-leads></div></div>
        <div class="ocu-campaign-popover-stat"><div class="lbl">Last round</div><div class="val" data-pop-last></div></div>
      </div>
    </div>

    <script>
      (function() {
        var pop = document.getElementById('ocu-campaign-popover');
        if (!pop) return;
        var setText = function(sel, val) { var el = pop.querySelector(sel); if (el) el.textContent = val; };

        function show(row) {
          setText('[data-pop-name]',     row.dataset.campaignName || '');
          setText('[data-pop-clr]',      (row.dataset.statClr || '0') + '%');
          setText('[data-pop-cr]',       (row.dataset.statCr  || '0') + '%');
          setText('[data-pop-wrong]',    row.dataset.statWrong    || '0');
          setText('[data-pop-callable]', row.dataset.statCallable || '0');
          setText('[data-pop-leads]',    row.dataset.statLeads    || '0');
          setText('[data-pop-last]',     row.dataset.statLastRound || '—');

          var rect = row.getBoundingClientRect();
          pop.hidden = false;
          // Render once to measure, then position below the row, clamped to
          // the viewport so it never clips off-screen at the right edge.
          var pw = pop.offsetWidth, ph = pop.offsetHeight;
          var top = window.scrollY + rect.bottom + 6;
          var left = window.scrollX + rect.left;
          if (left + pw > window.scrollX + window.innerWidth - 16) {
            left = window.scrollX + window.innerWidth - pw - 16;
          }
          // If there's no room below, flip above the row.
          if (rect.bottom + ph + 12 > window.innerHeight) {
            top = window.scrollY + rect.top - ph - 6;
          }
          pop.style.top  = top  + 'px';
          pop.style.left = left + 'px';
        }
        function hide() { pop.hidden = true; }

        document.querySelectorAll('.ocu-campaign-row').forEach(function(row) {
          row.addEventListener('mouseenter', function() { show(row); });
          row.addEventListener('focus',      function() { show(row); });
          row.addEventListener('mouseleave', hide);
          row.addEventListener('blur',       hide);
        });
      })();
    </script>`;

  return shell({
    title:          'Campaigns',
    topbarTitle:    'Campaigns',
    topbarSubtitle: 'Track call/SMS campaigns and their results',
    activePage:     'campaigns',
    user:           data.user,
    badges:         data.badges || {},
    body,
  });
}

module.exports = { campaignsList };
