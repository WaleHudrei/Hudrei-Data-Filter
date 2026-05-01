// ═══════════════════════════════════════════════════════════════════════════
// src/invitations.js — Phase 4 invite-by-email
//
// Tenant admins invite teammates by email; recipient clicks a link and
// creates an account inside that workspace. 7-day token expiry. One
// pending invite per (tenant, email) — re-inviting refreshes the token.
// ═══════════════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const { query } = require('./db');
const passwords = require('./passwords');

const TOKEN_BYTES = 32;
const EXPIRY_DAYS = 7;

const ALLOWED_ROLES = new Set(['tenant_user', 'tenant_admin']);

function _genToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

/**
 * Issue or refresh an invitation. If a pending (un-accepted, un-revoked,
 * un-expired) invite already exists for this tenant + email, refresh its
 * token + expiry rather than creating a duplicate. Returns
 * { token, expiresAt, refreshed }.
 */
async function createInvite(tenantId, email, role, invitedByUserId) {
  if (!Number.isInteger(tenantId)) throw new Error('createInvite: tenantId required');
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail)) {
    throw new Error('Invalid email');
  }
  const cleanRole = ALLOWED_ROLES.has(role) ? role : 'tenant_user';
  if (!Number.isInteger(invitedByUserId)) throw new Error('createInvite: invitedByUserId required');

  // Existing user in THIS tenant? Reject — they don't need an invite.
  const existingUser = await query(
    `SELECT id FROM users WHERE tenant_id = $1 AND LOWER(email) = $2 LIMIT 1`,
    [tenantId, cleanEmail]
  );
  if (existingUser.rows.length) throw new Error('That email is already a member of this workspace.');

  const token = _genToken();
  const expiresAt = new Date(Date.now() + EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Refresh path: pending invite already exists.
  const pending = await query(
    `SELECT id FROM invitations
      WHERE tenant_id = $1 AND LOWER(email) = $2
        AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()
      LIMIT 1`,
    [tenantId, cleanEmail]
  );
  if (pending.rows.length) {
    await query(
      `UPDATE invitations SET token = $2, expires_at = $3, role = $4, invited_by = $5
        WHERE id = $1`,
      [pending.rows[0].id, token, expiresAt, cleanRole, invitedByUserId]
    );
    return { token, expiresAt, refreshed: true };
  }

  await query(
    `INSERT INTO invitations (tenant_id, email, role, token, invited_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [tenantId, cleanEmail, cleanRole, token, invitedByUserId, expiresAt]
  );
  return { token, expiresAt, refreshed: false };
}

/**
 * Look up an invite by token. Returns null if missing / expired / used /
 * revoked. Returned shape: { id, tenant_id, email, role, expires_at,
 * tenant_name }.
 */
async function findInviteByToken(token) {
  if (!token || typeof token !== 'string') return null;
  const r = await query(
    `SELECT i.id, i.tenant_id, i.email, i.role, i.expires_at,
            t.name AS tenant_name
       FROM invitations i
       JOIN tenants t ON t.id = i.tenant_id
      WHERE i.token = $1
        AND i.accepted_at IS NULL
        AND i.revoked_at IS NULL
        AND i.expires_at > NOW()
      LIMIT 1`,
    [token]
  );
  return r.rows[0] || null;
}

/**
 * Atomic accept: mark invite consumed + create user + return new userId.
 * Throws if invite is invalid / a user with that email already exists in
 * the tenant.
 */
async function acceptInvite(token, name, password) {
  const inv = await findInviteByToken(token);
  if (!inv) throw new Error('This invitation link is no longer valid.');
  const cleanName = String(name || '').trim().slice(0, 100);
  if (!cleanName) throw new Error('Please provide your name.');
  const pwErr = passwords.validate(password);
  if (pwErr) throw new Error(pwErr);

  // Defensive — same email could've been added directly via /admin between
  // invite creation + acceptance.
  const exists = await query(
    `SELECT 1 FROM users WHERE tenant_id = $1 AND LOWER(email) = $2 LIMIT 1`,
    [inv.tenant_id, inv.email.toLowerCase()]
  );
  if (exists.rows.length) {
    throw new Error('A user with that email already exists in this workspace. Sign in instead.');
  }

  const hashed = await passwords.hash(password);
  const u = await query(
    `INSERT INTO users (tenant_id, email, password_hash, name, role, status, email_verified_at)
     VALUES ($1, $2, $3, $4, $5, 'active', NOW())
     RETURNING id`,
    [inv.tenant_id, inv.email, hashed, cleanName, inv.role]
  );
  await query(`UPDATE invitations SET accepted_at = NOW() WHERE id = $1`, [inv.id]);
  return { userId: u.rows[0].id, tenantId: inv.tenant_id, role: inv.role };
}

async function listInvitesForTenant(tenantId) {
  if (!Number.isInteger(tenantId)) throw new Error('listInvitesForTenant: tenantId required');
  const r = await query(
    `SELECT i.id, i.email, i.role, i.expires_at, i.accepted_at, i.revoked_at, i.created_at,
            u.name AS invited_by_name
       FROM invitations i
       LEFT JOIN users u ON u.id = i.invited_by
      WHERE i.tenant_id = $1
      ORDER BY i.created_at DESC
      LIMIT 200`,
    [tenantId]
  );
  return r.rows;
}

async function revokeInvite(tenantId, inviteId) {
  if (!Number.isInteger(tenantId) || !Number.isInteger(inviteId)) return false;
  const r = await query(
    `UPDATE invitations SET revoked_at = NOW()
      WHERE id = $1 AND tenant_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL
      RETURNING id`,
    [inviteId, tenantId]
  );
  return r.rowCount > 0;
}

async function listMembers(tenantId) {
  if (!Number.isInteger(tenantId)) throw new Error('listMembers: tenantId required');
  const r = await query(
    `SELECT id, email, name, role, status, created_at, last_login_at
       FROM users
      WHERE tenant_id = $1
      ORDER BY created_at ASC`,
    [tenantId]
  );
  return r.rows;
}

async function updateMemberRole(tenantId, userId, role) {
  if (!ALLOWED_ROLES.has(role)) throw new Error('Invalid role');
  const r = await query(
    `UPDATE users SET role = $3 WHERE id = $1 AND tenant_id = $2 RETURNING id`,
    [userId, tenantId, role]
  );
  return r.rowCount > 0;
}

async function disableMember(tenantId, userId) {
  // Prevent disabling the last active admin (lockout protection).
  const adminCount = await query(
    `SELECT COUNT(*)::int AS n FROM users
      WHERE tenant_id = $1 AND role = 'tenant_admin' AND status = 'active'`,
    [tenantId]
  );
  const target = await query(
    `SELECT role, status FROM users WHERE id = $1 AND tenant_id = $2`,
    [userId, tenantId]
  );
  if (!target.rows.length) return { ok: false, error: 'User not found' };
  if (target.rows[0].role === 'tenant_admin' && target.rows[0].status === 'active'
      && adminCount.rows[0].n <= 1) {
    return { ok: false, error: 'Cannot disable the last active admin.' };
  }
  await query(`UPDATE users SET status = 'disabled' WHERE id = $1 AND tenant_id = $2`, [userId, tenantId]);
  return { ok: true };
}

module.exports = {
  createInvite,
  findInviteByToken,
  acceptInvite,
  listInvitesForTenant,
  revokeInvite,
  listMembers,
  updateMemberRole,
  disableMember,
};
