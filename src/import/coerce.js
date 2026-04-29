/**
 * src/import/coerce.js — shared numeric / value coercion helpers for importers.
 *
 * 2026-04-29 audit fix M10: extracted from three inline copies that had
 * drifted in subtle ways (different isNaN ordering, different string-strip
 * sequencing, slightly different range checks). Pre-fix:
 *
 *   - bulk-import-routes.js mapReisiftRow had its own toMoney/toYear/etc.
 *   - property-import-routes.js /commit foreground had its own copy.
 *   - property-import-routes.js /start-job background had a third copy.
 *
 * The agent flagged that any future column add could miss the bounded
 * helper in one path and let unbounded scientific-notation values through
 * to Postgres (numeric overflow). Single source of truth — every importer
 * that touches money/year/smallint/bathrooms/percent now imports from here.
 *
 * All helpers return `null` for invalid / out-of-range input; importers
 * pass null through COALESCE-safe-merge so existing DB values are preserved.
 *
 * Out-of-range warnings are logged via console.warn so operators can audit
 * data quality after an import. The `[label]` prefix lets each caller
 * identify which import flow surfaced the bad value.
 */

// Strip currency / percent decoration (`$`, `,`, `%`) before numeric parse.
// Pre-fix some sites called isNaN BEFORE the strip, returning null for any
// "$1,234.56" — silently NULLing the column. (Audit #19 / changelog 2026-04-21.)
function toNum(v) {
  if (!v && v !== 0) return null;
  const s = String(v).replace(/[$,%]/g, '').trim();
  if (!s || isNaN(s)) return null;
  return parseFloat(s);
}

function toInt(v) {
  if (!v && v !== 0) return null;
  const s = String(v).replace(/[$,%]/g, '').trim();
  if (!s || isNaN(s)) return null;
  return parseInt(s, 10);
}

// NUMERIC(12,2) ceiling. Anything beyond ~$10B is wrong-column / scientific-
// notation / typo'd extra-zero garbage. Clamp to NULL.
const MONEY_LIMIT = 9_999_999_999.99;
function toMoney(v, label = 'coerce') {
  const n = toNum(v);
  if (n == null) return null;
  if (Math.abs(n) > MONEY_LIMIT) {
    console.warn(`[${label}] out-of-range money value ${JSON.stringify(v)} → NULL`);
    return null;
  }
  return n;
}

// 4-digit year window. Catches PropStream column-shift bugs that leak
// $57,142 into a year column.
function toYear(v, label = 'coerce') {
  const n = toNum(v);
  if (n == null) return null;
  const y = Math.round(n);
  if (y < 1800 || y > 2200) {
    console.warn(`[${label}] invalid year value ${JSON.stringify(v)} → NULL`);
    return null;
  }
  return y;
}

// Postgres SMALLINT range. Bedroom / stories counts shouldn't approach this
// — a value over 32,767 is column-shift garbage.
function toSmallInt(v, label = 'coerce') {
  const n = toInt(v);
  if (n == null) return null;
  if (n < -32_768 || n > 32_767) {
    console.warn(`[${label}] out-of-range smallint value ${JSON.stringify(v)} → NULL`);
    return null;
  }
  return n;
}

// NUMERIC(3,1) — max 99.9 bathrooms. Cap at 99 to be safe.
function toBathrooms(v, label = 'coerce') {
  const n = toNum(v);
  if (n == null) return null;
  if (n < 0 || n > 99) {
    console.warn(`[${label}] out-of-range bathrooms value ${JSON.stringify(v)} → NULL`);
    return null;
  }
  return n;
}

// equity_percent and similar — in [-100, 100]. Anything outside is almost
// certainly a dollar amount that leaked into a percent column.
function toPercent(v, label = 'coerce') {
  const n = toNum(v);
  if (n == null) return null;
  if (n < -100 || n > 100) {
    console.warn(`[${label}] out-of-range percent value ${JSON.stringify(v)} → NULL`);
    return null;
  }
  return n;
}

function toDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d) ? null : d.toISOString().split('T')[0];
}

function toBool(v) {
  const s = String(v || '').toLowerCase();
  if (s === 'yes' || s === 'true'  || s === '1' || s === 'y') return true;
  if (s === 'no'  || s === 'false' || s === '0' || s === 'n') return false;
  return null;
}

module.exports = {
  toNum, toInt, toMoney, toYear, toSmallInt, toBathrooms, toPercent,
  toDate, toBool,
  MONEY_LIMIT,
};
