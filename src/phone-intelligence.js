// phone-intelligence.js
// 2026-05-01 — Layer 1 + 1.5 global phone-flag store per the campaign
// filtration spec (Section 3). One row per (tenant_id, phone_number) in
// the `phone_intelligence` table; this module exposes the small upsert
// helpers the rule engine + NIS importer call into.
//
// Layer 1 (is_wrong / is_dead / is_correct): time-decaying. Persisted
// here with timestamps so the boot-time sweep in db.js can clear flags
// that are 6+ months stale.
//
// Layer 1.5 (is_lead): permanent. Never decayed. Once a phone has
// produced a transfer/lead disposition, it stays excluded from every
// future campaign and channel for that tenant.
//
// Why a separate table from `phones` + `campaign_contact_phones`?
//   * `phones` is per-(tenant, contact, phone_number) — the same number on
//     two contacts is two rows, so a flag on one row doesn't affect the
//     other.
//   * `campaign_contact_phones` is per-campaign — a flag set during one
//     campaign doesn't follow the number into the next.
//   * The spec specifically wants "wrong everywhere within the tenant"
//     semantics. That's exactly one row per (tenant, phone_number).
//
// The legacy per-row flags on the other tables remain authoritative for
// the per-card UI; this table is the AGGREGATE that drives future-campaign
// gating, owner-mismatch detection (last_owner_name), and decay.

const { query } = require('./db');
const { normalizePhone } = require('./phone-normalize');

function _validTenant(t) { return Number.isInteger(t) && t > 0; }

// Bulk upsert helper. Pass an array of `{ phone, flagsToSet }` where
// flagsToSet is one of 'wrong' | 'dead' | 'correct' | 'lead'. ownerName
// is optional and only meaningful with 'wrong' / 'correct' (it's recorded
// as last_owner_name so importContactList can detect owner mismatches on
// future uploads). Phones that fail normalize are silently dropped.
async function setLayerFlag(tenantId, items, flag) {
  if (!_validTenant(tenantId)) throw new Error('phone-intelligence: tenantId required (int)');
  if (!Array.isArray(items) || items.length === 0) return { updated: 0 };
  if (!['wrong', 'dead', 'correct', 'lead'].includes(flag)) {
    throw new Error(`phone-intelligence: unknown flag "${flag}"`);
  }
  const phones = [];
  const owners = [];
  for (const it of items) {
    const norm = normalizePhone(it && it.phone);
    if (!norm || norm.length !== 10) continue;
    phones.push(norm);
    owners.push(String(it.ownerName || '').slice(0, 200) || null);
  }
  if (phones.length === 0) return { updated: 0 };

  // Map the `flag` argument to the column pair (boolean + timestamp).
  // Using static SQL switch (not user-controlled string interpolation)
  // because pg parameters can't substitute into column identifiers.
  const sql = {
    wrong: `
      INSERT INTO phone_intelligence (tenant_id, phone_number, is_wrong, wrong_flagged_at, last_owner_name)
      SELECT $1, t.phone, true, NOW(), t.owner
        FROM UNNEST($2::text[], $3::text[]) AS t(phone, owner)
      ON CONFLICT (tenant_id, phone_number) DO UPDATE
        SET is_wrong = true,
            wrong_flagged_at = NOW(),
            last_owner_name = COALESCE(EXCLUDED.last_owner_name, phone_intelligence.last_owner_name),
            updated_at = NOW()`,
    dead: `
      INSERT INTO phone_intelligence (tenant_id, phone_number, is_dead, dead_flagged_at)
      SELECT $1, t.phone, true, NOW()
        FROM UNNEST($2::text[]) AS t(phone)
      ON CONFLICT (tenant_id, phone_number) DO UPDATE
        SET is_dead = true,
            dead_flagged_at = NOW(),
            updated_at = NOW()`,
    correct: `
      INSERT INTO phone_intelligence (tenant_id, phone_number, is_correct, correct_flagged_at, last_owner_name)
      SELECT $1, t.phone, true, NOW(), t.owner
        FROM UNNEST($2::text[], $3::text[]) AS t(phone, owner)
      ON CONFLICT (tenant_id, phone_number) DO UPDATE
        SET is_correct = true,
            correct_flagged_at = NOW(),
            last_owner_name = COALESCE(EXCLUDED.last_owner_name, phone_intelligence.last_owner_name),
            updated_at = NOW()`,
    lead: `
      INSERT INTO phone_intelligence (tenant_id, phone_number, is_lead, lead_flagged_at)
      SELECT $1, t.phone, true, NOW()
        FROM UNNEST($2::text[]) AS t(phone)
      ON CONFLICT (tenant_id, phone_number) DO UPDATE
        SET is_lead = true,
            lead_flagged_at = COALESCE(phone_intelligence.lead_flagged_at, NOW()),
            updated_at = NOW()`,
  };
  const params = (flag === 'dead' || flag === 'lead')
    ? [tenantId, phones]
    : [tenantId, phones, owners];
  const r = await query(sql[flag], params);
  return { updated: r.rowCount || 0 };
}

// Owner-mismatch handler. When importContactList sees a phone number
// arriving on a NEW owner (different last_owner_name than what we've
// got stored), Layer 1's "wrong"/"correct" memory is no longer trusted —
// this is a different person on the same line. Clear those two flags so
// the new owner gets a fresh shot at being marketed. is_lead is NOT
// cleared (Layer 1.5 — once a transfer happens on a number, never
// re-market regardless of who owns it).
async function clearLayer1OnOwnerMismatch(tenantId, items) {
  if (!_validTenant(tenantId)) throw new Error('phone-intelligence: tenantId required (int)');
  if (!Array.isArray(items) || items.length === 0) return { cleared: 0 };
  const pairs = [];
  for (const it of items) {
    const norm = normalizePhone(it && it.phone);
    if (!norm || norm.length !== 10) continue;
    const newOwner = String(it.ownerName || '').trim().slice(0, 200);
    if (!newOwner) continue;
    pairs.push({ phone: norm, owner: newOwner });
  }
  if (pairs.length === 0) return { cleared: 0 };
  const phones = pairs.map(p => p.phone);
  const owners = pairs.map(p => p.owner);
  // CLEAR is_wrong + is_correct ONLY when the existing last_owner_name
  // differs (case-insensitive, whitespace-collapsed). Same-owner re-imports
  // shouldn't reset the memory.
  const r = await query(
    `UPDATE phone_intelligence pi
        SET is_wrong   = false,
            is_correct = false,
            wrong_flagged_at   = NULL,
            correct_flagged_at = NULL,
            last_owner_name    = t.owner,
            updated_at         = NOW()
       FROM UNNEST($2::text[], $3::text[]) AS t(phone, owner)
      WHERE pi.tenant_id    = $1
        AND pi.phone_number = t.phone
        AND pi.last_owner_name IS NOT NULL
        AND LOWER(REGEXP_REPLACE(pi.last_owner_name, '\\s+', ' ', 'g'))
            <> LOWER(REGEXP_REPLACE(t.owner,         '\\s+', ' ', 'g'))`,
    [tenantId, phones, owners]
  );
  return { cleared: r.rowCount || 0 };
}

module.exports = {
  setLayerFlag,
  clearLayer1OnOwnerMismatch,
};
