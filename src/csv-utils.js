// ─────────────────────────────────────────────────────────────────────────────
// csv-utils.js — small helpers for CSV ingestion consistency.
//
// Every Papa.parse call site in the app receives a file buffer, converts to
// UTF-8 text, and parses. Pre-pass-12 none of them stripped the byte-order
// mark (U+FEFF) that Excel, Google Sheets, and many Windows tools prepend
// when saving CSVs. The result: the first header of any CSV saved from
// Excel had an invisible "\uFEFF" glued to it, so "Phone" literally became
// "\uFEFFPhone" and every exact-match column lookup (autoDetect, required-
// column checks, header-to-mapping resolution) silently failed. The user
// saw "missing column 'Phone'" when the CSV clearly had that column.
//
// Fix: one helper, called at every parse site, strips the BOM before
// Papa.parse sees the text. Also trims accidental trailing whitespace at
// end of file that some tools append.
// ─────────────────────────────────────────────────────────────────────────────

function stripBom(text) {
  if (typeof text !== 'string' || !text) return text;
  // UTF-8 BOM: 0xEF 0xBB 0xBF which decodes to U+FEFF as a single char.
  if (text.charCodeAt(0) === 0xFEFF) return text.slice(1);
  return text;
}

/**
 * Convert an uploaded file buffer to Papa-ready text.
 * Use this everywhere instead of buffer.toString('utf8').
 */
function bufferToCsvText(buffer) {
  if (!buffer) return '';
  return stripBom(buffer.toString('utf8'));
}

module.exports = { stripBom, bufferToCsvText };
