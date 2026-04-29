// ═══════════════════════════════════════════════════════════════════════════
// src/auth/roles.js — Role-Based Access Control (RBAC)
//
// Three-role model:
//   tenant_user   — regular member of a workspace. No access to destructive
//                   ops or platform-wide pages (Changelog, Delete Code).
//   tenant_admin  — workspace owner. Sees Changelog + Delete Code + Settings.
//                   The user who created the workspace at signup gets this.
//   super_admin   — HQ/platform operator. Reaches /admin/*. Authenticated via
//                   the dedicated /hq/login portal (env-var credentials),
//                   distinct from tenant signup/login.
//
// `req.session.role` carries the user's role from login (set in auth-routes).
// `req.session.superAdmin` is the dedicated flag set by /hq/login.
// ═══════════════════════════════════════════════════════════════════════════

const ROLES = Object.freeze({
  TENANT_USER:  'tenant_user',
  TENANT_ADMIN: 'tenant_admin',
  SUPER_ADMIN:  'super_admin',
});

const ROLE_LABELS = Object.freeze({
  tenant_user:  'Member',
  tenant_admin: 'Workspace Admin',
  super_admin:  'Platform Admin',
});

// Whether the current request belongs to a workspace admin (or super-admin).
// Use this to gate destructive ops, the Delete Code form, and the Changelog
// nav entry.
function isWorkspaceAdmin(req) {
  if (!req || !req.session) return false;
  if (req.session.superAdmin) return true;
  const role = req.session.role || req.role;
  return role === ROLES.TENANT_ADMIN || role === ROLES.SUPER_ADMIN;
}

// Whether the current request is HQ/platform-level. Either the user is logged
// in with role='super_admin' on a tenant account, OR they came in via the
// dedicated /hq/login portal (session.superAdmin flag).
function isSuperAdmin(req) {
  if (!req || !req.session) return false;
  if (req.session.superAdmin === true) return true;
  const role = req.session.role || req.role;
  if (role === ROLES.SUPER_ADMIN) return true;
  // Back-compat: existing SUPER_ADMIN_EMAIL gate. The admin-routes module
  // has its own DB-lookup version; this function only covers the in-session
  // signals so it's safe to call from view layers.
  return false;
}

// Express middleware factory. Returns 403 if the request's role isn't allowed.
function requireRole(allowedRoles) {
  const allowed = new Set(Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles]);
  return function roleGate(req, res, next) {
    const role = (req.session && req.session.role) || req.role;
    if (!allowed.has(role)) {
      return res.status(403).send('Forbidden');
    }
    next();
  };
}

module.exports = { ROLES, ROLE_LABELS, isWorkspaceAdmin, isSuperAdmin, requireRole };
