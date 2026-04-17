// settings.js — app_settings table + delete code verification
// Used to gate destructive operations (records delete, bulk merges 10+ rows)

const { query } = require('./db');

const DEFAULT_DELETE_CODE = 'HudREI2026';

// Module-level idempotency flag — ensureSettingsSchema only pays DDL cost
// once per process, not every time verifyDeleteCode runs. (Audit issue #16.)
let _settingsSchemaReady = false;

/**
 * Idempotent schema init. Creates app_settings table and seeds the delete_code
 * row if it doesn't exist. Called at app startup and defensively before any
 * destructive operation.
 */
async function ensureSettingsSchema() {
  if (_settingsSchemaReady) return;
  await query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(
    `INSERT INTO app_settings (key, value) VALUES ('delete_code', $1)
     ON CONFLICT (key) DO NOTHING`,
    [DEFAULT_DELETE_CODE]
  );
  _settingsSchemaReady = true;
}

/**
 * Returns the current delete code. Falls back to default if not set.
 */
async function getDeleteCode() {
  const r = await query(`SELECT value FROM app_settings WHERE key = 'delete_code' LIMIT 1`);
  return r.rows.length ? r.rows[0].value : DEFAULT_DELETE_CODE;
}

/**
 * Returns true if the delete code is still the default shipped in the repo.
 * Used by the dashboard to render a warning banner. (Audit issue #32.)
 */
async function isUsingDefaultCode() {
  try {
    await ensureSettingsSchema();
    const stored = await getDeleteCode();
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
 * Verifies a user-provided code against the stored value.
 */
async function verifyDeleteCode(providedCode) {
  if (!providedCode || typeof providedCode !== 'string') return false;
  try {
    await ensureSettingsSchema();
    const stored = await getDeleteCode();
    return constantTimeEquals(providedCode.trim(), stored.trim());
  } catch (e) {
    console.error('[settings] verifyDeleteCode error:', e.message);
    return false;
  }
}

/**
 * Updates the delete code. Requires the OLD code to authenticate the change.
 */
async function updateDeleteCode(oldCode, newCode) {
  if (!newCode || typeof newCode !== 'string') {
    return { ok: false, error: 'New code required.' };
  }
  const trimmed = newCode.trim();
  if (trimmed.length < 6) {
    return { ok: false, error: 'New code must be at least 6 characters.' };
  }
  const verified = await verifyDeleteCode(oldCode);
  if (!verified) {
    return { ok: false, error: 'Current code is incorrect.' };
  }
  await query(
    `UPDATE app_settings SET value = $1, updated_at = NOW() WHERE key = 'delete_code'`,
    [trimmed]
  );
  return { ok: true };
}

/**
 * Returns when the code was last changed. Used in the Security UI.
 */
async function getDeleteCodeUpdatedAt() {
  const r = await query(`SELECT updated_at FROM app_settings WHERE key = 'delete_code' LIMIT 1`);
  return r.rows.length ? r.rows[0].updated_at : null;
}

module.exports = {
  DEFAULT_DELETE_CODE,
  ensureSettingsSchema,
  verifyDeleteCode,
  updateDeleteCode,
  getDeleteCodeUpdatedAt,
  isUsingDefaultCode,
};
