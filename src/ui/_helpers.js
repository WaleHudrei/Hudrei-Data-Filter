// ═══════════════════════════════════════════════════════════════════════════
// ui/_helpers.js — primitives every Ocular component depends on.
// Single source of truth for HTML escaping + number formatting.
// ═══════════════════════════════════════════════════════════════════════════

function escHTML(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Format numbers with thousands separators ("21,153" from 21153).
// Returns '0' for null/undefined/NaN — never throws.
function fmtNum(n) {
  if (n == null || Number.isNaN(Number(n))) return '0';
  return Number(n).toLocaleString('en-US');
}

// "8 min ago" / "1 hr ago" — relative time without bringing in moment/date-fns.
function fmtRelative(date) {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return '';
  const diffSec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diffSec < 60)        return diffSec + 's ago';
  if (diffSec < 3600)      return Math.floor(diffSec / 60) + ' min ago';
  if (diffSec < 86400)     return Math.floor(diffSec / 3600) + ' hr ago';
  if (diffSec < 86400 * 7) return Math.floor(diffSec / 86400) + 'd ago';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

module.exports = { escHTML, fmtNum, fmtRelative };
