// owner-type.js — infer contact owner_type from name patterns.
//
// Values: 'Person' | 'Company' | 'Trust'. Returns null when the name is empty
// (no guessing on empty strings — let the DB hold NULL so it's visibly unset).
//
// Used by:
//   - import/property-import-routes.js (CSV import — single-row + bulk UNNEST)
//   - records/records-routes.js (manual record edit)
//
// Principle: conservative. Default to 'Person' whenever the name exists but no
// entity keyword matches. The UI allows manual override so users can correct
// edge cases (e.g. an individually-named LLC or a family trust with no keyword).

// Company keywords — common US entity suffixes + investor-vocabulary terms
// that show up in DealMachine / PropStream / county-sourced lists.
// \b ensures whole-word match so "COMPANIONS" doesn't match "COMPANY", etc.
const COMPANY_RE = /\b(LLC|L\.L\.C|INC|INCORPORATED|CORP|CORPORATION|COMPANY|LP|LLP|LTD|LIMITED|PROPERTIES|PROPS|INVESTMENTS?|HOLDINGS?|GROUP|ENTERPRISES|VENTURES|MANAGEMENT|MGMT|DEVELOPMENT|DEVELOPERS|PARTNERS|PARTNERSHIP|REALTY|ASSOCIATES|CAPITAL|REAL ESTATE|RE)\b/i;

// Trust keywords — explicit only. "Estate" is intentionally NOT here: many
// county records list deceased owners as "SMITH JOHN EST" and those are closer
// to personal ownership (via executor) than entity ownership. Users can
// override to Trust manually if needed.
const TRUST_RE = /\b(TRUST|TRUSTEE|LIVING\s+TRUST|FAMILY\s+TRUST|REVOCABLE\s+TRUST|IRREVOCABLE\s+TRUST|TESTAMENTARY\s+TRUST)\b/i;

const VALID_OWNER_TYPES = ['Person', 'Company', 'Trust'];

/**
 * @param {string|null|undefined} firstName
 * @param {string|null|undefined} lastName
 * @returns {'Person'|'Company'|'Trust'|null}
 */
function inferOwnerType(firstName, lastName) {
  const full = [firstName, lastName].filter(Boolean).map(s => String(s).trim()).filter(Boolean).join(' ');
  if (!full) return null;
  // Normalize: strip periods/commas so "L.L.C." matches "LLC", and collapse whitespace.
  const norm = full.replace(/[.,]/g, '').replace(/\s+/g, ' ');
  if (TRUST_RE.test(norm))   return 'Trust';
  if (COMPANY_RE.test(norm)) return 'Company';
  return 'Person';
}

/**
 * Normalize a user-provided string to a valid owner_type value, or null if invalid.
 * Accepts case-insensitive input. Used in the edit-record handler to sanitize
 * form submissions.
 */
function normalizeOwnerType(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  for (const v of VALID_OWNER_TYPES) {
    if (v.toLowerCase() === lower) return v;
  }
  return null;
}

module.exports = { inferOwnerType, normalizeOwnerType, VALID_OWNER_TYPES };
