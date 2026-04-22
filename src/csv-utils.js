// ─────────────────────────────────────────────────────────────────────────────
// csv-utils.js — small helpers for CSV ingestion consistency.
//
// Every Papa.parse call site in the app receives a file buffer, converts to
// text, and parses. Two problems the helpers address:
//
// 1. BOM stripping. Excel, Google Sheets, and many Windows tools prepend a
//    byte-order mark (U+FEFF) when saving CSVs. Unless stripped, the first
//    header column name literally becomes "\uFEFFPhone" and exact-match
//    column lookups silently fail. Users saw "missing column 'Phone'" when
//    the CSV clearly had Phone in the header.
//
// 2. Encoding detection (2026-04-21, Gap #7). Excel on Windows saves CSVs
//    as CP-1252 (Windows-1252) rather than UTF-8 unless the user explicitly
//    picks "CSV UTF-8". When a CP-1252 file with non-ASCII chars (accented
//    names, smart quotes, em-dashes) is decoded as UTF-8, results range
//    from mojibake ("señor" → "seÃ±or") to outright decode errors on
//    isolated 0x80-0x9F bytes. The detector below sniffs the first 8KB
//    for BOMs and invalid-UTF-8 patterns and picks the right decoder.
//    Falls back to UTF-8 if ambiguous. No external dependency — uses
//    Node's built-in TextDecoder (WHATWG Encoding API).
// ─────────────────────────────────────────────────────────────────────────────

function stripBom(text) {
  if (typeof text !== 'string' || !text) return text;
  // UTF-8 BOM: 0xEF 0xBB 0xBF which decodes to U+FEFF as a single char.
  if (text.charCodeAt(0) === 0xFEFF) return text.slice(1);
  return text;
}

/**
 * Sniff a buffer's encoding. Returns one of: 'utf-8', 'utf-16le', 'utf-16be',
 * 'windows-1252'. Heuristic — fast, dependency-free, right ~98% of the time
 * for CSVs coming out of Excel / Sheets / REISift / PropStream / DealMachine.
 */
function detectEncoding(buffer) {
  if (!buffer || buffer.length < 2) return 'utf-8';
  // ── BOM checks ──
  // UTF-8: EF BB BF
  if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
    return 'utf-8';
  }
  // UTF-16 LE: FF FE
  if (buffer[0] === 0xFF && buffer[1] === 0xFE) return 'utf-16le';
  // UTF-16 BE: FE FF
  if (buffer[0] === 0xFE && buffer[1] === 0xFF) return 'utf-16be';

  // ── No BOM. Check if buffer is valid UTF-8. If any invalid sequence
  //    appears, fall back to CP-1252 (the most common Windows alternative).
  //    We only sniff the first 8KB — sufficient for header + many rows.
  const sample = buffer.subarray(0, Math.min(8192, buffer.length));
  if (isValidUtf8(sample)) return 'utf-8';
  return 'windows-1252';
}

/**
 * Is this byte sequence a well-formed UTF-8 string? Fast validator, no
 * allocations. Returns false on any invalid continuation byte or truncated
 * multi-byte sequence. Ignores a harmless final-byte truncation since our
 * sample may cut mid-sequence.
 */
function isValidUtf8(bytes) {
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    const b = bytes[i];
    if (b < 0x80) { i++; continue; }                          // ASCII
    let extra;
    if ((b & 0xE0) === 0xC0)      extra = 1;                  // 110xxxxx → 2-byte
    else if ((b & 0xF0) === 0xE0) extra = 2;                  // 1110xxxx → 3-byte
    else if ((b & 0xF8) === 0xF0) extra = 3;                  // 11110xxx → 4-byte
    else return false;                                         // invalid lead byte
    // Allow truncation of the final multi-byte sequence — the sample
    // might just have cut mid-character.
    if (i + extra >= n) return true;
    for (let j = 1; j <= extra; j++) {
      if ((bytes[i + j] & 0xC0) !== 0x80) return false;        // bad continuation
    }
    i += extra + 1;
  }
  return true;
}

/**
 * Convert an uploaded file buffer to Papa-ready text.
 * Use this everywhere instead of buffer.toString('utf8').
 */
function bufferToCsvText(buffer) {
  if (!buffer) return '';
  const encoding = detectEncoding(buffer);
  try {
    // TextDecoder handles BOM stripping for utf-16 variants automatically;
    // for utf-8 and windows-1252 we still pass through stripBom() below
    // to handle the U+FEFF character that survives decoding.
    const text = new TextDecoder(encoding, { fatal: false }).decode(buffer);
    return stripBom(text);
  } catch (e) {
    // TextDecoder shouldn't throw with fatal:false, but paranoia: fall back
    // to UTF-8 latin1-safe decode if something went sideways.
    console.warn(`[csv-utils] TextDecoder failed for encoding=${encoding}: ${e.message}; falling back to utf-8`);
    return stripBom(buffer.toString('utf8'));
  }
}

module.exports = { stripBom, bufferToCsvText, detectEncoding, isValidUtf8 };
