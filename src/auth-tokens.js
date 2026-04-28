// ═══════════════════════════════════════════════════════════════════════════════
// src/auth-tokens.js — Phase 2 token helpers
//
// Email verification + password reset both issue single-use, time-limited
// tokens. Same shape, same lifecycle: insert → email link → user clicks →
// consume (mark used_at, return user_id). Centralized so the two flows can't
// drift in subtle ways (e.g. one forgets to mark used_at and a token works
// twice).
// ═══════════════════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const { query } = require('./db');

function newToken() {
  return crypto.randomBytes(32).toString('hex'); // 64 chars
}

// Issue a token. Caller specifies which table. Returns the raw token string.
// We intentionally do NOT invalidate prior unused tokens — the user may have
// requested two emails in a row. They all expire normally; whichever one they
// click first works.
async function issueToken(table, userId, ttlMinutes) {
  if (!['email_verification_tokens', 'password_reset_tokens'].includes(table)) {
    throw new Error('issueToken: unknown table ' + table);
  }
  const token = newToken();
  const expires = new Date(Date.now() + ttlMinutes * 60 * 1000);
  await query(
    `INSERT INTO ${table} (user_id, token, expires_at) VALUES ($1, $2, $3)`,
    [userId, token, expires]
  );
  return token;
}

// Consume a token. Returns the user_id on success, null on failure (expired,
// already used, or no such token). One UPDATE so the same token can't be
// raced by two concurrent clicks.
async function consumeToken(table, token) {
  if (!['email_verification_tokens', 'password_reset_tokens'].includes(table)) {
    throw new Error('consumeToken: unknown table ' + table);
  }
  if (!token || typeof token !== 'string') return null;
  const r = await query(
    `UPDATE ${table}
        SET used_at = NOW()
      WHERE token = $1
        AND used_at IS NULL
        AND expires_at > NOW()
      RETURNING user_id`,
    [token]
  );
  return r.rows.length ? r.rows[0].user_id : null;
}

module.exports = {
  newToken,
  issueToken,
  consumeToken,
};
