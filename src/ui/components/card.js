// ui/components/card.js
// Generic card wrapper with optional title, meta, and right-aligned link.
//
// Usage:
//   card({ title, meta, link: { href, label }, body })
const { escHTML } = require('../_helpers');

// Defensive href whitelist: only allow safe schemes. javascript: and data:
// URLs are blocked even if escHTML wouldn't catch them, because component
// callers shouldn't be passing user-controlled URLs but we don't trust that.
function safeHref(h) {
  const s = String(h || '');
  if (/^(javascript|data|vbscript):/i.test(s.trim())) return '#';
  return s;
}

function card(opts = {}) {
  const { title = '', meta = '', link = null, body = '' } = opts;

  let header = '';
  if (title || link) {
    header = `
      <div class="ocu-card-header">
        <div>
          ${title ? `<div class="ocu-card-title">${escHTML(title)}</div>` : ''}
          ${meta ? `<div class="ocu-card-meta">${escHTML(meta)}</div>` : ''}
        </div>
        ${link ? `<a class="ocu-card-link" href="${escHTML(safeHref(link.href))}">${escHTML(link.label || '')}</a>` : ''}
      </div>`;
  }

  return `<div class="ocu-card">${header}${body}</div>`;
}

module.exports = { card };
