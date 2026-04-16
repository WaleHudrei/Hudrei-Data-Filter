// settings.js — app_settings table + delete code verification
// Used to gate destructive operations (records delete, bulk merges 10+ rows)

const { query } = require('./db');

const DEFAULT_DELETE_CODE = 'HudREI2026';

/**
 * Idempotent schema init. Creates app_settings table and seeds the delete_code
 * row if it doesn't exist. Called at app startup.
 */
async function ensureSettingsSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Seed default delete_code if not set. Never overwrites an existing value.
  await query(
    `INSERT INTO app_settings (key, value) VALUES ('delete_code', $1)
     ON CONFLICT (key) DO NOTHING`,
    [DEFAULT_DELETE_CODE]
  );
}

/**
 * Returns the current delete code. Falls back to default if not set (shouldn't
 * happen once ensureSettingsSchema runs at boot, but defensive).
 */
async function getDeleteCode() {
  const r = await query(`SELECT value FROM app_settings WHERE key = 'delete_code' LIMIT 1`);
  return r.rows.length ? r.rows[0].value : DEFAULT_DELETE_CODE;
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
 * Verifies a user-provided code against the stored value. Returns true/false.
 * Never throws — wraps DB errors and returns false.
 */
async function verifyDeleteCode(providedCode) {
  if (!providedCode || typeof providedCode !== 'string') return false;
  try {
    // Defensive — if a delete request lands before app.listen's async schema
    // init completes (cold boot race window), ensure the table + seeded row
    // exist before comparing. Idempotent so safe to call every time.
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
 * Returns { ok: true } or { ok: false, error: 'message' }.
 * Enforces min length 6 on the new code.
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
};
