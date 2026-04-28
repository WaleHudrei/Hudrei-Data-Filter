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
  return `<tr>
    <td>
      <a href="/ocular/campaigns/${c.id}" class="ocu-link" style="font-weight:500">${escHTML(c.name)}</a>
      <div class="ocu-text-3" style="font-size:11px;margin-top:2px">${escHTML(c.market_name || '')}${c.state_code ? ' · ' + escHTML(c.state_code) : ''}</div>
    </td>
    <td><span class="ocu-pill">${escHTML(c.list_type || '—')}</span></td>
    <td>${channelBadge(c.active_channel)}</td>
    <td>${statusBadge(c.status)}</td>
    <td class="ocu-text-right ocu-mono">${fmtNum(counts.total_contacts || 0)}</td>
    <td class="ocu-text-right ocu-mono">${fmtNum(Math.max(0, callable))}</td>
    <td class="ocu-text-right ocu-mono">${counts.lead_contacts > 0 ? fmtNum(counts.lead_contacts) : '<span class="ocu-text-3">—</span>'}</td>
    <td class="ocu-text-3 ocu-mono" style="font-size:11px;white-space:nowrap">${fmtRelative(c.start_date || c.created_at)}</td>
  </tr>`;
}

function tabLink(label, value, currentTab, count) {
  const isActive = (currentTab || 'active') === value;
  return `<a href="/ocular/campaigns?tab=${escHTML(value)}" class="ocu-tab ${isActive ? 'active' : ''}" style="text-decoration:none;display:inline-block">${escHTML(label)} <span class="ocu-text-3">(${fmtNum(count)})</span></a>`;
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

  const totalContactsAcross = all.reduce((sum, c) => sum + ((c.contact_counts && c.contact_counts.total_contacts) || 0), 0);
  const totalLeadsAcross    = all.reduce((sum, c) => sum + ((c.contact_counts && c.contact_counts.lead_contacts)  || 0), 0);

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
              <th>Campaign</th>
              <th>List type</th>
              <th>Channel</th>
              <th>Status</th>
              <th class="ocu-text-right">Contacts</th>
              <th class="ocu-text-right">Callable</th>
              <th class="ocu-text-right">Leads</th>
              <th>Started</th>
            </tr>
          </thead>
          <tbody>${filtered.map(row).join('')}</tbody>
        </table>
      </div>`;

  const body = `
    <div class="ocu-page-header">
      <div>
        <h1 class="ocu-page-title">Campaigns</h1>
        <div class="ocu-page-subtitle">Track call/SMS campaigns and their results</div>
      </div>
      <div>
        <a href="/campaigns/new" class="ocu-btn ocu-btn-primary">+ New campaign</a>
      </div>
    </div>

    ${kpiStrip}

    <div class="ocu-tabs" style="margin-bottom:14px">
      ${tabLink('Active', 'active', tab, counts.active)}
      ${tabLink('Completed', 'completed', tab, counts.completed)}
      ${tabLink('All', 'all', tab, counts.all)}
    </div>

    ${tableHTML}`;

  return shell({
    title:      'Campaigns',
    activePage: 'campaigns',
    user:       data.user,
    badges:     data.badges || {},
    body,
  });
}

module.exports = { campaignsList };
