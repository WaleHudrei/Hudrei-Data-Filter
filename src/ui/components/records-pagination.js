// ui/components/records-pagination.js
// Simple page navigator: prev / 1..N / next, with current page highlighted.
// Builds links that preserve current querystring (filters, sort).
const { escHTML, fmtNum } = require('../_helpers');

function pageLink(label, page, querystring, opts = {}) {
  const { active = false, disabled = false } = opts;
  if (disabled) {
    return `<span class="ocu-page-link disabled">${escHTML(label)}</span>`;
  }
  const qs = querystring + (querystring ? '&' : '') + `page=${page}`;
  return `<a class="ocu-page-link${active ? ' active' : ''}" href="?${qs}">${escHTML(label)}</a>`;
}

// Compute which page numbers to show. With many pages, we elide the middle.
// e.g. for currentPage=15 of 30: [1, 2, ... 13, 14, 15, 16, 17, ..., 29, 30]
function pageWindow(current, total) {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const out = [1];
  if (current > 4) out.push('…');
  for (let p = Math.max(2, current - 2); p <= Math.min(total - 1, current + 2); p++) {
    out.push(p);
  }
  if (current < total - 3) out.push('…');
  out.push(total);
  return out;
}

function recordsPagination(opts = {}) {
  const total = Number(opts.totalRows) || 0;
  const limit = Number(opts.limit) || 25;
  const page  = Math.max(1, Number(opts.page) || 1);
  const querystring = opts.querystring || '';

  const totalPages = Math.max(1, Math.ceil(total / limit));
  const from = total === 0 ? 0 : (page - 1) * limit + 1;
  const to   = Math.min(total, page * limit);

  // Don't render pagination at all if there's nothing to paginate
  if (total === 0) return '';

  const pages = pageWindow(page, totalPages);
  const pageButtons = pages.map(p => {
    if (p === '…') return `<span class="ocu-page-ellipsis">…</span>`;
    return pageLink(String(p), p, querystring, { active: p === page });
  }).join('');

  return `
    <div class="ocu-pagination">
      <div class="ocu-pagination-info">
        Showing <strong>${fmtNum(from)}</strong>–<strong>${fmtNum(to)}</strong> of <strong>${fmtNum(total)}</strong>
      </div>
      <div class="ocu-pagination-nav">
        ${pageLink('‹ Prev', page - 1, querystring, { disabled: page <= 1 })}
        ${pageButtons}
        ${pageLink('Next ›', page + 1, querystring, { disabled: page >= totalPages })}
      </div>
    </div>`;
}

module.exports = { recordsPagination };
