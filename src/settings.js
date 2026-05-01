// settings.js — app_settings table + delete code verification
// Used to gate destructive operations (records delete, bulk merges 10+ rows)
//
// Phase 1 SaaS: every public function takes tenantId so each tenant has its
// own delete_code. The app_settings PK is now (tenant_id, key).

const { query } = require('./db');
const crypto = require('crypto');

// HudREI's seeded delete code — kept as the LEGACY default for the
// pre-existing tenant_id=1 row that was provisioned before signup existed.
// New tenants get a randomly-generated code instead (see
// generateRandomDeleteCode + provisionTenantSettings).
const DEFAULT_DELETE_CODE = 'HudREI2026';

/**
 * Generate a fresh random delete code for a new tenant. 12 alphanumeric
 * characters drawn uniformly from a 62-char alphabet via crypto.randomInt
 * — ~71 bits of entropy, plenty for a confirm-action gate. Excludes 0/O/1/l
 * so the code is dictatable without ambiguity if the operator reads it from
 * the screen to a teammate.
 */
function generateRandomDeleteCode() {
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 12; i++) {
    s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  }
  return s;
}

// Module-level idempotency flag — ensureSettingsSchema only pays DDL cost
// once per process, not every time verifyDeleteCode runs. (Audit issue #16.)
let _settingsSchemaReady = false;

/**
 * Idempotent table creation. Does NOT seed any rows — that's per-tenant work
 * handled by provisionTenantSettings(tenantId).
 */
async function ensureSettingsSchema() {
  if (_settingsSchemaReady) return;
  await query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, key)
    )
  `);
  _settingsSchemaReady = true;
}

/**
 * Seeds default settings rows for one tenant. Idempotent — safe to call on
 * boot and at tenant signup. Currently only seeds delete_code.
 *
 * 2026-05-01 Phase 2 closure: every NEW tenant gets a random delete_code,
 * not the shared `HudREI2026` default. Plan open question #4 favored random
 * for security; the only reason it stayed default was friction during the
 * pre-public-launch period. Now: random by default, with the legacy
 * `HudREI2026` value preserved on tenant_id=1 (HudREI itself) so the
 * existing operator's saved code still works.
 *
 * Tenant 1 explicitly gets the legacy value to preserve continuity. Every
 * other tenant gets a fresh 12-char alphanumeric. The ON CONFLICT DO NOTHING
 * means a re-run never overwrites an existing row — so this is safe to call
 * on boot AND at signup.
 */
async function provisionTenantSettings(tenantId) {
  if (!Number.isInteger(tenantId)) throw new Error('provisionTenantSettings: tenantId required');
  await ensureSettingsSchema();
  const seed = (tenantId === 1) ? DEFAULT_DELETE_CODE : generateRandomDeleteCode();
  await query(
    `INSERT INTO app_settings (tenant_id, key, value) VALUES ($1, 'delete_code', $2)
     ON CONFLICT (tenant_id, key) DO NOTHING`,
    [tenantId, seed]
  );
}

/**
 * Returns the current delete code for a tenant. Falls back to default if not set.
 */
async function getDeleteCode(tenantId) {
  if (!Number.isInteger(tenantId)) throw new Error('getDeleteCode: tenantId required');
  const r = await query(
    `SELECT value FROM app_settings WHERE tenant_id = $1 AND key = 'delete_code' LIMIT 1`,
    [tenantId]
  );
  return r.rows.length ? r.rows[0].value : DEFAULT_DELETE_CODE;
}

/**
 * Returns true if this tenant's delete code is still the default. Used by
 * the dashboard to render a warning banner. (Audit issue #32.)
 */
async function isUsingDefaultCode(tenantId) {
  try {
    await ensureSettingsSchema();
    const stored = await getDeleteCode(tenantId);
    return constantTimeEquals(stored.trim(), DEFAULT_DELETE_CODE);
  } catch (e) {
    // If we can't even check, render the banner — it's safer.
    return true;
  }
}

/**
 * Constant-time string comparison to avoid timing attacks on the code check.
 * Uses a bitwise XOR + length check. Fine for short strings.
 */
function constantTimeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Verifies a user-provided code against the tenant's stored value.
 */
async function verifyDeleteCode(tenantId, providedCode) {
  if (!Number.isInteger(tenantId)) throw new Error('verifyDeleteCode: tenantId required');
  if (!providedCode || typeof providedCode !== 'string') return false;
  try {
    await ensureSettingsSchema();
    const stored = await getDeleteCode(tenantId);
    return constantTimeEquals(providedCode.trim(), stored.trim());
  } catch (e) {
    console.error('[settings] verifyDeleteCode error:', e.message);
    return false;
  }
}

/**
 * Updates the tenant's delete code. Requires the OLD code to authenticate.
 */
async function updateDeleteCode(tenantId, oldCode, newCode) {
  if (!Number.isInteger(tenantId)) throw new Error('updateDeleteCode: tenantId required');
  if (!newCode || typeof newCode !== 'string') {
    return { ok: false, error: 'New code required.' };
  }
  const trimmed = newCode.trim();
  if (trimmed.length < 6) {
    return { ok: false, error: 'New code must be at least 6 characters.' };
  }
  const verified = await verifyDeleteCode(tenantId, oldCode);
  if (!verified) {
    return { ok: false, error: 'Current code is incorrect.' };
  }
  // UPSERT — handles the case where this tenant has no row yet (first change
  // happens before provisionTenantSettings ever ran for them).
  await query(
    `INSERT INTO app_settings (tenant_id, key, value, updated_at)
     VALUES ($1, 'delete_code', $2, NOW())
     ON CONFLICT (tenant_id, key) DO UPDATE
       SET value = EXCLUDED.value, updated_at = NOW()`,
    [tenantId, trimmed]
  );
  return { ok: true };
}

/**
 * Returns when this tenant's code was last changed. Used in the Security UI.
 */
async function getDeleteCodeUpdatedAt(tenantId) {
  if (!Number.isInteger(tenantId)) throw new Error('getDeleteCodeUpdatedAt: tenantId required');
  const r = await query(
    `SELECT updated_at FROM app_settings WHERE tenant_id = $1 AND key = 'delete_code' LIMIT 1`,
    [tenantId]
  );
  return r.rows.length ? r.rows[0].updated_at : null;
}

module.exports = {
  DEFAULT_DELETE_CODE,
  generateRandomDeleteCode,
  ensureSettingsSchema,
  provisionTenantSettings,
  verifyDeleteCode,
  updateDeleteCode,
  getDeleteCodeUpdatedAt,
  isUsingDefaultCode,
  getDeleteCode,
};
