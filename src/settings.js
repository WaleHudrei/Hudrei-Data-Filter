// settings.js — app_settings table + delete code verification
// Used to gate destructive operations (records delete, bulk merges 10+ rows)
//
// Phase 1 SaaS: every public function takes tenantId so each tenant has its
// own delete_code. The app_settings PK is now (tenant_id, key).

const { query } = require('./db');

const DEFAULT_DELETE_CODE = 'HudREI2026';

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
 */
async function provisionTenantSettings(tenantId) {
  if (!Number.isInteger(tenantId)) throw new Error('provisionTenantSettings: tenantId required');
  await ensureSettingsSchema();
  await query(
    `INSERT INTO app_settings (tenant_id, key, value) VALUES ($1, 'delete_code', $2)
     ON CONFLICT (tenant_id, key) DO NOTHING`,
    [tenantId, DEFAULT_DELETE_CODE]
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
  ensureSettingsSchema,
  provisionTenantSettings,
  verifyDeleteCode,
  updateDeleteCode,
  getDeleteCodeUpdatedAt,
  isUsingDefaultCode,
};
