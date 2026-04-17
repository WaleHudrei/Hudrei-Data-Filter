// ─────────────────────────────────────────────────────────────────────────────
// state.js — single source of truth for state_code validation
//
// Used by every importer (property-import, bulk-import, call-log saveRunToDB,
// setup-routes). Replaces the old "slice(0,2) of whatever" fallback that let
// garbage like "46" (truncated ZIP) or "UN" (truncated "Unknown") into the
// properties and markets tables.
//
// Contract: normalizeState returns a valid 2-letter USPS code or null.
//           Caller must treat null as "skip row, invalid state".
// ─────────────────────────────────────────────────────────────────────────────

const VALID_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA',
  'HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
  'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
  'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY',
  'DC',
]);

const STATE_ABBR = {
  'alabama':'AL','alaska':'AK','arizona':'AZ','arkansas':'AR','california':'CA',
  'colorado':'CO','connecticut':'CT','delaware':'DE','florida':'FL','georgia':'GA',
  'hawaii':'HI','idaho':'ID','illinois':'IL','indiana':'IN','iowa':'IA',
  'kansas':'KS','kentucky':'KY','louisiana':'LA','maine':'ME','maryland':'MD',
  'massachusetts':'MA','michigan':'MI','minnesota':'MN','mississippi':'MS','missouri':'MO',
  'montana':'MT','nebraska':'NE','nevada':'NV','new hampshire':'NH','new jersey':'NJ',
  'new mexico':'NM','new york':'NY','north carolina':'NC','north dakota':'ND','ohio':'OH',
  'oklahoma':'OK','oregon':'OR','pennsylvania':'PA','rhode island':'RI','south carolina':'SC',
  'south dakota':'SD','tennessee':'TN','texas':'TX','utah':'UT','vermont':'VT',
  'virginia':'VA','washington':'WA','west virginia':'WV','wisconsin':'WI','wyoming':'WY',
  'district of columbia':'DC','washington dc':'DC','washington d.c.':'DC',
};

/**
 * Normalizes a raw state value to a valid 2-letter USPS code.
 * Accepts:
 *   - Existing 2-letter codes ("CA", "ca") — returned uppercased
 *   - Full names ("California", "CALIFORNIA", " california ")
 * Rejects (returns null):
 *   - Anything that doesn't match a known state
 *   - Empty / whitespace / numeric / truncated garbage
 */
function normalizeState(v) {
  if (v === null || v === undefined) return null;
  const raw = String(v).trim();
  if (!raw) return null;

  const up = raw.toUpperCase();
  if (VALID_STATES.has(up)) return up;

  const mapped = STATE_ABBR[raw.toLowerCase()];
  if (mapped) return mapped;

  // Unrecognized — do NOT fall back to slice(0,2). That's how "46218" → "46"
  // poisoned the markets table in the old implementation.
  return null;
}

/**
 * Convenience check used by the markets seed / cleanup migration.
 */
function isValidState(code) {
  if (!code) return false;
  return VALID_STATES.has(String(code).toUpperCase());
}

/**
 * Returns the full uppercase set — handy for SQL cleanup:
 *   DELETE FROM markets WHERE state_code NOT IN (${validStateList.map(s => `'${s}'`).join(',')})
 */
function allValidStates() {
  return Array.from(VALID_STATES);
}

module.exports = { normalizeState, isValidState, allValidStates, VALID_STATES, STATE_ABBR };
