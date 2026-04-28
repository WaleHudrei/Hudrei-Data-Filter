// ═══════════════════════════════════════════════════════════════════════════
// get-user.js
// Reads the current user + their tenant from the database for sidebar
// rendering. Cached on `req` so multiple shell() calls within one request
// only hit the DB once. Returns { name, role, initials } in the shape both
// the Ocular shell and the legacy shared-shell expect.
// ═══════════════════════════════════════════════════════════════════════════
const { query } = require('./db');

async function getUser(req) {
  if (req._cachedUser) return req._cachedUser;
  if (!req.userId) {
    return { name: '—', role: '—', initials: '·' };
  }
  try {
    const r = await query(
      `SELECT u.id, u.name, u.email, u.role, t.name AS tenant_name, t.slug AS tenant_slug
         FROM users u
         JOIN tenants t ON t.id = u.tenant_id
        WHERE u.id = $1`,
      [req.userId]
    );
    if (!r.rows.length) {
      req._cachedUser = { name: '—', role: '—', initials: '·' };
      return req._cachedUser;
    }
    const u = r.rows[0];
    const displayName = u.name || u.email || '—';
    const initials = displayName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map(s => s[0].toUpperCase())
      .join('') || '·';
    req._cachedUser = {
      name: displayName,
      role: u.role === 'admin' ? `Admin · ${u.tenant_name}` : `${u.role} · ${u.tenant_name}`,
      initials,
    };
    return req._cachedUser;
  } catch (e) {
    console.error('[get-user] lookup failed:', e.message);
    return { name: '—', role: '—', initials: '·' };
  }
}

module.exports = { getUser };
