// ═══════════════════════════════════════════════════════════════════════════
// ui/pages/owners-list.js
// Ocular's Owners list. New view that didn't exist in Loki — Loki only ever
// reached an owner from a property detail page. The list shows every contact
// with a property link, sorted by portfolio size (most properties first by
// default), with quick filters and search.
//
// Each row clicks through to /ocular/owners/:id (the detail page).
// ═══════════════════════════════════════════════════════════════════════════
const { shell }   = require('../layouts/shell');
const { card }    = require('../components/card');
const { kpiCard } = require('../components/kpi-card');
const { escHTML, fmtNum } = require('../_helpers');

function ownerTypeBadge(t) {
  if (!t) return '<span class="ocu-text-3" style="font-size:11px">—</span>';
  return `<span class="ocu-pill" data-owner-type="${escHTML(t)}">${escHTML(t)}</span>`;
}

function buildPager({ page, totalPages, querystring }) {
  if (totalPages <= 1) return '';
  // Strip the existing page= from the querystring so we can append our own.
  const baseQS = (querystring || '')
    .split('&')
    .filter(p => p && !p.startsWith('page='))
    .join('&');
  const qsWith = (n) => baseQS ? `?${baseQS}&page=${n}` : `?page=${n}`;
  const prev = page > 1 ? `<a href="${qsWith(page - 1)}" class="ocu-btn ocu-btn-secondary">← Prev</a>` : '';
  const next = page < totalPages ? `<a href="${qsWith(page + 1)}" class="ocu-btn ocu-btn-secondary">Next →</a>` : '';
  return `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:14px">
      <div class="ocu-text-3" style="font-size:12px">Page ${page} of ${totalPages}</div>
      <div style="display:flex;gap:8px">${prev}${next}</div>
    </div>`;
}

function ownerRow(o) {
  const name = [o.first_name, o.last_name].filter(Boolean).join(' ') || '(no name)';
  const mailing = [o.mailing_city, o.mailing_state].filter(Boolean).join(', ');
  const verifiedPct = o.phone_total > 0
    ? Math.round((o.phone_correct * 100) / o.phone_total) + '%'
    : '—';
  return `
    <tr>
      <td>
        <a href="/ocular/owners/${o.id}" class="ocu-link" style="font-weight:500">${escHTML(name)}</a>
        ${mailing ? `<div class="ocu-text-3" style="font-size:11px;margin-top:2px">${escHTML(mailing)}</div>` : ''}
      </td>
      <td>${ownerTypeBadge(o.owner_type)}</td>
      <td class="ocu-text-right ocu-mono">${fmtNum(o.property_count)}</td>
      <td class="ocu-text-right ocu-mono">${fmtNum(o.phone_total)}</td>
      <td class="ocu-text-right ocu-mono">${escHTML(verifiedPct)}</td>
      <td class="ocu-text-right ocu-mono">${o.lead_count > 0 ? fmtNum(o.lead_count) : '<span class="ocu-text-3">—</span>'}</td>
    </tr>`;
}

/**
 * @param {Object} data
 *   - user, badges
 *   - rows: array of owner rows (see route handler for shape)
 *   - total: total matching count
 *   - page, limit
 *   - filters: { q, ownerType, minProps }
 *   - querystring: original ?... so pagination can preserve it
 *   - kpis: { totalContacts, multiPropertyOwners, withVerifiedPhone }
 */
function ownersList(data = {}) {
  const rows = Array.isArray(data.rows) ? data.rows : [];
  const total = data.total || 0;
  const page = data.page || 1;
  const limit = data.limit || 25;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const filters = data.filters || {};
  const k = data.kpis || {};

  const kpiStrip = `
    <div class="ocu-kpi-row" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr));margin-bottom:18px">
      ${kpiCard({ label: 'Total owners', value: k.totalContacts || 0, featured: true })}
      ${kpiCard({
        label: 'Multi-property owners',
        value: k.multiPropertyOwners || 0,
        delta: k.totalContacts > 0
          ? { direction: 'neutral', label: Math.round((k.multiPropertyOwners / k.totalContacts) * 100) + '% of total' }
          : null,
      })}
      ${kpiCard({
        label: 'With verified phone',
        value: k.withVerifiedPhone || 0,
        delta: k.totalContacts > 0
          ? { direction: 'neutral', label: Math.round((k.withVerifiedPhone / k.totalContacts) * 100) + '% reachable' }
          : null,
      })}
    </div>`;

  const filterBar = `
    <form method="GET" action="/ocular/owners" class="ocu-card" style="padding:12px 14px;margin-bottom:14px;display:grid;grid-template-columns:2fr 1fr 1fr auto;gap:10px;align-items:end">
      <div>
        <label class="ocu-form-label">Search</label>
        <input type="text" name="q" value="${escHTML(filters.q || '')}" placeholder="Name or city" class="ocu-input" />
      </div>
      <div>
        <label class="ocu-form-label">Owner type</label>
        <select name="owner_type" class="ocu-input">
          <option value="">Any</option>
          <option value="Person"  ${filters.ownerType === 'Person'  ? 'selected' : ''}>Person</option>
          <option value="Company" ${filters.ownerType === 'Company' ? 'selected' : ''}>Company</option>
          <option value="Trust"   ${filters.ownerType === 'Trust'   ? 'selected' : ''}>Trust</option>
        </select>
      </div>
      <div>
        <label class="ocu-form-label">Min properties</label>
        <input type="number" name="min_props" min="1" value="${escHTML(filters.minProps || '')}" placeholder="any" class="ocu-input" />
      </div>
      <div style="display:flex;gap:6px">
        <button type="submit" class="ocu-btn ocu-btn-primary">Filter</button>
        <a href="/ocular/owners" class="ocu-btn ocu-btn-ghost">Reset</a>
      </div>
    </form>`;

  const tableHTML = rows.length === 0
    ? `<div class="ocu-empty">No owners match these filters.</div>`
    : `
      <div class="ocu-table-wrap">
        <table class="ocu-table">
          <thead>
            <tr>
              <th>Owner</th>
              <th>Type</th>
              <th class="ocu-text-right">Properties</th>
              <th class="ocu-text-right">Phones</th>
              <th class="ocu-text-right">Verified</th>
              <th class="ocu-text-right">Leads</th>
            </tr>
          </thead>
          <tbody>${rows.map(ownerRow).join('')}</tbody>
        </table>
      </div>
      ${buildPager({ page, totalPages, querystring: data.querystring })}`;

  const body = `
    <div class="ocu-page-header">
      <div>
        <h1 class="ocu-page-title">Owners</h1>
        <div class="ocu-page-subtitle">${fmtNum(total)} owner${total === 1 ? '' : 's'} matching your filters</div>
      </div>
    </div>

    ${kpiStrip}
    ${filterBar}
    ${tableHTML}`;

  return shell({
    title:     'Owners',
    activePage: 'owners',
    user:      data.user,
    badges:    data.badges || {},
    body,
  });
}

module.exports = { ownersList };
