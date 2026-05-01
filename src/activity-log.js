// ═══════════════════════════════════════════════════════════════════════════
// src/activity-log.js — Phase 4 audit trail
//
// Helper for writing activity_log rows + a simple read for the activity
// page (/oculah/activity already exists from Phase 1; this just gives it
// a tenant-scoped feed). Best-effort writes — never fail the originating
// request because of a log insert.
// ═══════════════════════════════════════════════════════════════════════════

const { query } = require('./db');

/**
 * Log a user-initiated action. Pass the request to auto-extract
 * tenant/user/IP, plus an action string and optional resource.
 *
 *   log(req, 'invite.created', { resource_type: 'invitation',
 *                                resource_id: '42',
 *                                metadata: { email, role } });
 */
async function log(req, action, opts = {}) {
  try {
    const tenantId = req && req.session && req.session.tenantId;
    const userId   = req && req.session && req.session.userId;
    if (!Number.isInteger(tenantId)) return;
    const ip = req && (req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress) || null;
    await query(
      `INSERT INTO activity_log (tenant_id, user_id, action, resource_type, resource_id, metadata, ip)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        tenantId,
        Number.isInteger(userId) ? userId : null,
        String(action || '').slice(0, 100),
        opts.resource_type ? String(opts.resource_type).slice(0, 64) : null,
        opts.resource_id   ? String(opts.resource_id).slice(0, 64)   : null,
        opts.metadata ? JSON.stringify(opts.metadata).slice(0, 4000) : null,
        ip ? String(ip).slice(0, 64) : null,
      ]
    );
  } catch (e) {
    console.error('[activity-log]', e.message);
  }
}

async function recent(tenantId, limit = 100) {
  if (!Number.isInteger(tenantId)) return [];
  const r = await query(
    `SELECT a.action, a.resource_type, a.resource_id, a.metadata, a.created_at,
            u.name AS user_name, u.email AS user_email
       FROM activity_log a
       LEFT JOIN users u ON u.id = a.user_id
      WHERE a.tenant_id = $1
      ORDER BY a.created_at DESC
      LIMIT $2`,
    [tenantId, Math.min(500, Math.max(1, parseInt(limit, 10) || 100))]
  );
  return r.rows;
}

module.exports = { log, recent };
