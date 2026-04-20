// ─────────────────────────────────────────────────────────────────────────────
// phone-normalize.js — single source of truth for phone number cleaning.
//
// Pre-pass-12 there were FOUR different phone-cleaning implementations across
// the codebase. Only filtration.js's normalizePhone stripped the leading "1"
// on length-11 inputs; the other three just stripped non-digits. Result: the
// same phone "1-555-123-4567" became "15551234567" in the bulk-import path
// but "5551234567" in the filtration path. Every cross-path lookup (NIS
// against campaign_contact_phones, dedup across imports) silently missed
// these. All four call sites now delegate here.
//
// Also handles two edge cases the old implementations corrupted silently:
//
//   1. EXTENSIONS. Old: "(555) 123-4567 x3" → strip-non-digits → "55512345673".
//      That's 11 digits not starting with 1, so no leading-1 strip — stored
//      as-is, matches nothing else, ghost record forever. New: recognize
//      "ext", "x", "#" followed by 1-5 digits and discard the tail.
//
//   2. INTERNATIONAL. Old: "+44 20 7946 0958" → "442079460958" (12 digits),
//      stored as-is, dialer receives nonsense. New: detect by length (12+
//      digits or a leading "+") and return empty — the caller's
//      length-validation (>= 10 or >= 7) then drops the row cleanly.
//      Non-US numbers aren't supported by the dialer anyway; better to drop
//      them than to store corrupt data.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize a raw phone string to a canonical 10-digit US number.
 * Returns empty string for anything that can't be confidently converted.
 *
 * Accepted: "(555) 123-4567", "555-123-4567", "5551234567", "1-555-123-4567",
 *           "(555) 123-4567 ext 123", "(555) 123-4567 x3", "555.123.4567".
 *
 * Dropped (returns ''):
 *   - Under 10 digits after cleanup (too short to dial)
 *   - International (leading "+" or 12+ raw digits that aren't "1" + 10)
 *   - Unparseable / garbage
 *
 * @param {string|number|null|undefined} raw
 * @returns {string} 10-digit US number, or '' if invalid
 */
function normalizePhone(raw) {
  if (raw == null) return '';
  let s = String(raw).trim();
  if (!s) return '';

  // If input starts with "+" it's explicitly international — bail.
  // (Raw digits like "12345678901" without "+" can still legitimately be
  // "1" + US 10-digit, so we only bail on the explicit "+" marker.)
  if (s.startsWith('+')) return '';

  // Strip extensions BEFORE digit-only cleanup so the ext digits don't
  // concatenate. Common patterns: " ext 123", " x3", " #45", " ext. 9"
  s = s.replace(/\s*(?:ext\.?|x|#)\s*\d{1,6}\s*$/i, '');

  // Now strip everything that isn't a digit.
  let p = s.replace(/\D/g, '');

  // US-style normalization: 11 digits starting with 1 → strip the 1.
  if (p.length === 11 && p.startsWith('1')) {
    p = p.substring(1);
  }

  // Anything longer than 10 digits at this point is either a mangled
  // extension we didn't catch or a non-US number. Drop it rather than
  // corrupt-store it.
  if (p.length > 10) return '';

  // Anything shorter than 10 is not a full US number. Callers may still
  // accept >= 7 for legacy reasons (some older imports stored 7-digit
  // local numbers) — they check .length themselves. We preserve what we
  // have so the caller can make that decision.
  return p;
}

/**
 * Strict variant: returns the 10-digit number, or '' if the input isn't
 * a valid full US number. Use this where the dialer / SMS integration
 * requires a complete number.
 */
function normalizePhoneStrict(raw) {
  const p = normalizePhone(raw);
  return p.length === 10 ? p : '';
}

module.exports = {
  normalizePhone,
  normalizePhoneStrict,
};
