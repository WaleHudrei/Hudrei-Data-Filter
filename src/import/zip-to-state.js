// ═══════════════════════════════════════════════════════════════════════════════
// 2026-04-21 ZIP → state lookup.
//
// Public USPS data: the first 3 digits of a US ZIP ("ZIP3 prefix") map to
// exactly one state with a handful of well-known exceptions. We store the
// 3-digit prefix → state mapping as a compact object (~900 entries) rather
// than the full 42,000-ZIP table because:
//   - 100x smaller in memory (~10KB vs ~1MB)
//   - Same accuracy for our use case (state-level recovery)
//   - No external dependency
//
// For prefixes that straddle two states (very rare — mostly military/federal
// ranges like APO/FPO), we return null to force a downstream fallback rather
// than guess wrong.
//
// Source: USPS Publication 65 (Address Information Products), 2024 edition.
// ═══════════════════════════════════════════════════════════════════════════════

// Build the full prefix table by expanding declared ranges. Source format
// below mirrors the USPS ZIP3 ranges-by-state table so a human can verify
// it against the USPS reference if needed.
const STATE_RANGES = {
  // state_code: [[start_prefix, end_prefix], ...]
  AL: [['350','369']],
  AK: [['995','999']],
  AZ: [['850','850'],['852','853'],['855','857'],['859','860'],['863','865']],
  AR: [['716','729']],
  CA: [['900','908'],['910','928'],['930','961']],
  CO: [['800','816']],
  CT: [['060','069']],
  DE: [['197','199']],
  DC: [['200','200'],['202','205'],['569','569']],
  FL: [['320','339'],['341','342'],['344','344'],['346','347'],['349','349']],
  GA: [['300','319'],['398','399']],
  HI: [['967','968']],
  ID: [['832','838']],
  IL: [['600','629']],
  IN: [['460','479']],
  IA: [['500','528']],
  KS: [['660','679']],
  KY: [['400','427']],
  LA: [['700','701'],['703','708'],['710','714']],
  ME: [['039','049']],
  MD: [['206','219']],
  MA: [['010','027'],['055','055']],
  MI: [['480','499']],
  MN: [['550','567']],
  MS: [['386','397']],
  MO: [['630','631'],['633','641'],['644','658']],
  MT: [['590','599']],
  NE: [['680','681'],['683','693']],
  NV: [['889','891'],['893','895'],['897','898']],
  NH: [['030','038']],
  NJ: [['070','089']],
  NM: [['870','871'],['873','875'],['877','884']],
  NY: [['005','005'],['100','149']],
  NC: [['270','289']],
  ND: [['580','588']],
  OH: [['430','459']],
  OK: [['730','731'],['734','749']],
  OR: [['970','979']],
  PA: [['150','196']],
  RI: [['028','029']],
  SC: [['290','299']],
  SD: [['570','577']],
  TN: [['370','385']],
  TX: [['750','770'],['772','799'],['885','885']],
  UT: [['840','847']],
  VT: [['050','054'],['056','059']],
  VA: [['201','201'],['220','246']],
  WA: [['980','994']],
  WV: [['247','268']],
  WI: [['530','535'],['537','549']],
  WY: [['820','831']],
};

// Build the flat lookup once at require time.
const ZIP3_TO_STATE = {};
for (const [state, ranges] of Object.entries(STATE_RANGES)) {
  for (const [start, end] of ranges) {
    const s = parseInt(start, 10);
    const e = parseInt(end, 10);
    for (let i = s; i <= e; i++) {
      const key = String(i).padStart(3, '0');
      ZIP3_TO_STATE[key] = state;
    }
  }
}

/**
 * Look up a state code from a ZIP. Accepts 5-digit, 9-digit (ZIP+4),
 * or leading-zero-stripped forms ("8001" → "08001"). Returns null if the
 * ZIP is missing, malformed, or doesn't match a known prefix.
 */
function lookupStateByZip(zipRaw) {
  if (!zipRaw) return null;
  // Normalize — strip non-digits, pad leading zeros, take first 5.
  const digits = String(zipRaw).replace(/\D/g, '');
  if (digits.length < 3) return null;
  // Pad 3-4 digit inputs with leading zeros (common when Excel strips them).
  const padded = digits.length < 5 ? digits.padStart(5, '0') : digits;
  const prefix = padded.slice(0, 3);
  return ZIP3_TO_STATE[prefix] || null;
}

/**
 * How many distinct prefixes we know about. Useful in audit output to
 * assure the caller the lookup table loaded correctly.
 */
function lookupStats() {
  return { prefix_count: Object.keys(ZIP3_TO_STATE).length };
}

module.exports = { lookupStateByZip, lookupStats, ZIP3_TO_STATE };
