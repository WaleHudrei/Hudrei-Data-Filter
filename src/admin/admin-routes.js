// ═══════════════════════════════════════════════════════════════════════════════
// src/admin/admin-routes.js — Super-Admin SaaS console
//
// Single-operator console for the SaaS owner (Wale + dev team) to see every
// signup, suspend or delete tenants, and manage users across the platform.
//
// Auth model: SUPER_ADMIN_EMAIL env var. Only a logged-in user whose email
// matches that env var (case-insensitive) can reach any /admin route. This is
// deliberately decoupled from the per-tenant `role` column — a normal tenant
// admin must NOT be able to escalate into this surface, and we don't want to
// add a global is_super_admin column that any future bug could mistakenly flip.
//
// Routes mounted here:
//   GET  /admin                                 → tenants list
//   GET  /admin/tenants/new                     → create-tenant form
//   POST /admin/tenants/new                     → create tenant + initial user
//   GET  /admin/tenants/:id                     → tenant detail (users, actions)
//   POST /admin/tenants/:id/status              → suspend / reactivate
//   POST /admin/tenants/:id/delete              → destructive delete (cascades)
//   POST /admin/tenants/:id/users/:uid/status   → disable / re-enable a user
//   POST /admin/tenants/:id/users/:uid/delete   → delete a user
//
// Layout: own minimal chrome — intentionally NOT the Ocular sidebar. "What
// tenants can't see" is a different mental model than "my workspace."
// ═══════════════════════════════════════════════════════════════════════════════

const express = require('express');
const router  = express.Router();
const { query } = require('../db');
const passwords = require('../passwords');
const { provisionTenantSettings } = require('../settings');

// ── helpers ──────────────────────────────────────────────────────────────────
function escHTML(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function isValidEmail(e) {
  if (!e || typeof e !== 'string') return false;
  if (e.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

function slugify(name) {
  return String(name || 'workspace')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'workspace';
}

async function uniqueSlug(base) {
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const r = await query('SELECT 1 FROM tenants WHERE slug = $1', [candidate]);
    if (!r.rows.length) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

function fmtDate(d) {
  if (!d) return '—';
  try { return new Date(d).toISOString().slice(0, 10); }
  catch { return '—'; }
}

function fmtDateTime(d) {
  if (!d) return '—';
  try {
    const x = new Date(d);
    return x.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  } catch { return '—'; }
}

// ── auth gate ────────────────────────────────────────────────────────────────
// Two layers: must be authenticated (session.userId set), and that user's
// email must equal SUPER_ADMIN_EMAIL. We re-load the email from the DB on
// every request rather than trusting session state — that way revoking
// admin is as simple as changing the env var; no session invalidation
// dance required.
function requireSuperAdmin(req, res, next) {
  // Path A: dedicated /hq/login portal. Session was authed via env-var
  // credentials and is platform-only (no tenant context). Preferred path
  // going forward.
  if (req.session && req.session.superAdmin === true) {
    req.superAdminEmail = req.session.superAdminUsername || 'hq';
    return next();
  }

  // Path B (legacy): tenant-side login where the user's email matches the
  // SUPER_ADMIN_EMAIL env var. Kept for back-compat — operators who were
  // already using this gate before /hq/login landed don't get locked out.
  if (!req.session || !req.session.authenticated || !req.session.userId) {
    return res.redirect('/hq/login');
  }
  const allowed = String(process.env.SUPER_ADMIN_EMAIL || '').trim().toLowerCase();
  if (!allowed) {
    // No legacy gate configured AND no /hq session → bounce to the new
    // portal. The portal itself handles the "fully disabled" case.
    return res.redirect('/hq/login');
  }
  query(`SELECT email FROM users WHERE id = $1 LIMIT 1`, [req.session.userId])
    .then(r => {
      const email = r.rows.length ? String(r.rows[0].email || '').toLowerCase() : '';
      if (email !== allowed) {
        return res.status(404).send(adminShell('Not found', `
          <div class="card">
            <h1>404</h1>
            <p class="lede">No such page.</p>
          </div>
        `));
      }
      req.superAdminEmail = email;
      next();
    })
    .catch(e => {
      console.error('[admin/requireSuperAdmin]', e);
      res.status(500).send('Admin gate failed.');
    });
}

// ── layout ───────────────────────────────────────────────────────────────────
// Deliberately spare. Dark top bar so it's visually distinct from Ocular —
// a constant reminder this surface affects ALL tenants.
function adminShell(title, bodyHtml, opts = {}) {
  const flash = opts.flash ? `<div class="flash ${opts.flashKind === 'error' ? 'flash-err' : 'flash-ok'}">${escHTML(opts.flash)}</div>` : '';
  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHTML(title)} — Oculah Admin</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f1115;color:#e4e6eb;line-height:1.5;min-height:100vh}
  a{color:#9ec5ff;text-decoration:none}
  a:hover{text-decoration:underline}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#1c1f26;padding:1px 6px;border-radius:4px;font-size:12px}
  .topbar{background:#000;border-bottom:1px solid #1c1f26;padding:14px 28px;display:flex;align-items:center;justify-content:space-between}
  .topbar .brand{font-weight:700;letter-spacing:.5px}
  .topbar .brand .tag{background:#7a1a1a;color:#fff;font-size:11px;padding:2px 8px;border-radius:4px;margin-left:10px;letter-spacing:1px;text-transform:uppercase}
  .topbar nav a{color:#aab1bd;font-size:13px;margin-left:20px}
  .topbar nav a.active{color:#fff;font-weight:600}
  .topbar .who{font-size:12px;color:#8b919c}
  main{max-width:1100px;margin:32px auto;padding:0 28px 80px}
  h1{font-size:26px;font-weight:700;margin-bottom:6px;letter-spacing:-.4px}
  .lede{color:#8b919c;font-size:14px;margin-bottom:24px}
  .card{background:#161922;border:1px solid #232733;border-radius:10px;padding:22px}
  .card + .card{margin-top:16px}
  .row{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:18px}
  .row h1{margin:0}
  table{width:100%;border-collapse:collapse;font-size:14px}
  th,td{text-align:left;padding:12px 14px;border-bottom:1px solid #232733}
  th{font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:#8b919c;background:#11141b}
  tr:hover td{background:#1a1e29}
  .pill{display:inline-block;font-size:11px;padding:2px 8px;border-radius:999px;text-transform:uppercase;letter-spacing:.5px;font-weight:600}
  .pill-active{background:#0e3b22;color:#7ee2a8}
  .pill-suspended{background:#3b2a0e;color:#e2c47e}
  .pill-canceled{background:#3b0e0e;color:#e27e7e}
  .pill-disabled{background:#2a2a2a;color:#aaa}
  .pill-invited{background:#0e2a3b;color:#7ec3e2}
  .btn{display:inline-block;padding:9px 14px;border-radius:7px;border:1px solid #2d3344;background:#1c2030;color:#e4e6eb;font-size:13px;font-weight:500;cursor:pointer;font-family:inherit;text-decoration:none}
  .btn:hover{background:#252a3d;text-decoration:none}
  .btn-primary{background:#1f4a87;border-color:#2c5fb5;color:#fff}
  .btn-primary:hover{background:#2c5fb5}
  .btn-warn{background:#5a3a0e;border-color:#7a4d12;color:#ffd897}
  .btn-warn:hover{background:#7a4d12}
  .btn-danger{background:#5a1414;border-color:#7a1a1a;color:#ffb0b0}
  .btn-danger:hover{background:#7a1a1a}
  .btn-sm{padding:5px 10px;font-size:12px}
  form.inline{display:inline}
  label{display:block;font-size:12px;color:#aab1bd;margin-bottom:6px;font-weight:500;text-transform:uppercase;letter-spacing:.4px}
  input[type=text],input[type=email],input[type=password]{width:100%;padding:10px 12px;border-radius:7px;border:1px solid #2d3344;background:#0f1115;color:#e4e6eb;font-size:14px;font-family:inherit}
  input:focus{outline:none;border-color:#4a7fc1}
  .field{margin-bottom:16px}
  .hint{font-size:12px;color:#6b7280;margin-top:5px}
  .flash{padding:11px 14px;border-radius:7px;margin-bottom:18px;font-size:13px}
  .flash-ok{background:#0e2e1d;border:1px solid #1e6e3e;color:#9ee6b8}
  .flash-err{background:#2e0e0e;border:1px solid #6e1e1e;color:#e69e9e}
  .empty{padding:40px;text-align:center;color:#6b7280;font-size:14px}
  .meta-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:18px}
  .meta-grid .stat{background:#11141b;border:1px solid #232733;border-radius:8px;padding:14px}
  .meta-grid .stat .lbl{font-size:11px;color:#8b919c;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px}
  .meta-grid .stat .val{font-size:20px;font-weight:700}
  .danger-zone{border:1px solid #5a1414;background:#1a0d0d}
  .danger-zone h2{color:#ffb0b0;font-size:14px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
  .danger-zone p{font-size:13px;color:#aab1bd;margin-bottom:14px}
  .breadcrumbs{font-size:13px;color:#8b919c;margin-bottom:8px}
  .breadcrumbs a{color:#aab1bd}
</style>
</head><body>
<header class="topbar">
  <div class="brand">Oculah <span class="tag">HQ</span></div>
  <nav>
    <a href="/admin">Tenants</a>
    <a href="/hq/logout">Sign out</a>
  </nav>
</header>
<main>
${flash}
${bodyHtml}
</main>
</body></html>`;
}

function flashFromQuery(req) {
  if (req.query.ok)  return { flash: String(req.query.ok),  flashKind: 'ok' };
  if (req.query.err) return { flash: String(req.query.err), flashKind: 'error' };
  return {};
}

// All routes below require super-admin.
router.use(requireSuperAdmin);

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin — tenants list
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const r = await query(`
      SELECT t.id, t.name, t.slug, t.status, t.created_at,
             COALESCE(uc.user_count, 0) AS user_count,
             u.email AS primary_email,
             u.last_login_at
        FROM tenants t
        LEFT JOIN (
          SELECT tenant_id, COUNT(*) AS user_count
            FROM users
           GROUP BY tenant_id
        ) uc ON uc.tenant_id = t.id
        LEFT JOIN LATERAL (
          SELECT email, last_login_at
            FROM users
           WHERE tenant_id = t.id
           ORDER BY id ASC
           LIMIT 1
        ) u ON TRUE
        ORDER BY t.created_at DESC, t.id DESC
    `);
    const rows = r.rows.map(t => `
      <tr>
        <td><a href="/admin/tenants/${t.id}"><strong>${escHTML(t.name)}</strong></a><div style="font-size:12px;color:#8b919c">${escHTML(t.slug)}</div></td>
        <td>${escHTML(t.primary_email || '—')}</td>
        <td>${t.user_count}</td>
        <td><span class="pill pill-${escHTML(t.status)}">${escHTML(t.status)}</span></td>
        <td>${escHTML(fmtDate(t.created_at))}</td>
        <td>${escHTML(fmtDateTime(t.last_login_at))}</td>
        <td style="text-align:right">
          <a class="btn btn-sm" href="/admin/tenants/${t.id}">Manage</a>
        </td>
      </tr>
    `).join('');

    const empty = r.rows.length ? '' : `<div class="empty">No tenants yet. Sign-ups will land here.</div>`;
    const stats = {
      total: r.rows.length,
      active: r.rows.filter(t => t.status === 'active').length,
      suspended: r.rows.filter(t => t.status === 'suspended').length,
      users: r.rows.reduce((a, t) => a + Number(t.user_count || 0), 0),
    };

    res.send(adminShell('Tenants', `
      <div class="row">
        <div>
          <h1>Tenants</h1>
          <div class="lede">Every workspace on the platform. Signed in as <code>${escHTML(req.superAdminEmail)}</code>.</div>
        </div>
        <a class="btn btn-primary" href="/admin/tenants/new">+ New tenant</a>
      </div>
      <div class="meta-grid">
        <div class="stat"><div class="lbl">Tenants</div><div class="val">${stats.total}</div></div>
        <div class="stat"><div class="lbl">Active</div><div class="val">${stats.active}</div></div>
        <div class="stat"><div class="lbl">Suspended</div><div class="val">${stats.suspended}</div></div>
        <div class="stat"><div class="lbl">Total users</div><div class="val">${stats.users}</div></div>
      </div>
      <div class="card" style="padding:0;overflow:hidden">
        ${r.rows.length ? `
        <table>
          <thead><tr>
            <th>Workspace</th><th>Primary email</th><th>Users</th><th>Status</th><th>Created</th><th>Last login</th><th></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>` : empty}
      </div>
    `, flashFromQuery(req)));
  } catch (e) {
    console.error('[admin GET /]', e);
    res.status(500).send(adminShell('Error', `<div class="card"><h1>Something went wrong</h1><p class="lede">${escHTML(e.message)}</p></div>`));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/tenants/new — form
// ─────────────────────────────────────────────────────────────────────────────
router.get('/tenants/new', (req, res) => {
  const f = req.session.adminNewTenantFlash || {};
  delete req.session.adminNewTenantFlash;
  const v = f.form || {};
  const err = f.err ? `<div class="flash flash-err">${escHTML(f.err)}</div>` : '';
  res.send(adminShell('New tenant', `
    <div class="breadcrumbs"><a href="/admin">Tenants</a> / New</div>
    <h1>Create a tenant</h1>
    <p class="lede">Provisions a new workspace and its first admin user. Used for onboarding paid customers manually or seeding internal demo accounts.</p>
    ${err}
    <form method="POST" action="/admin/tenants/new" novalidate>
      <div class="card">
        <div class="field">
          <label>Workspace name</label>
          <input type="text" name="workspace" value="${escHTML(v.workspace || '')}" required maxlength="60" placeholder="Acme Realty">
          <div class="hint">Shows up in the user's Oculah sidebar.</div>
        </div>
        <div class="field">
          <label>Admin name</label>
          <input type="text" name="name" value="${escHTML(v.name || '')}" required maxlength="100" placeholder="Jane Doe">
        </div>
        <div class="field">
          <label>Admin email</label>
          <input type="email" name="email" value="${escHTML(v.email || '')}" required maxlength="254" placeholder="jane@acmerealty.com">
        </div>
        <div class="field">
          <label>Initial password</label>
          <input type="password" name="password" required minlength="8" maxlength="200">
          <div class="hint">At least 8 characters. Share it securely with the customer; they can change it after first login.</div>
        </div>
        <button class="btn btn-primary" type="submit">Create tenant</button>
        <a class="btn" href="/admin" style="margin-left:6px">Cancel</a>
      </div>
    </form>
  `));
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/tenants/new
// ─────────────────────────────────────────────────────────────────────────────
router.post('/tenants/new', async (req, res) => {
  const workspace = String(req.body.workspace || '').trim().slice(0, 60);
  const name      = String(req.body.name || '').trim().slice(0, 100);
  const emailAddr = String(req.body.email || '').trim().toLowerCase().slice(0, 254);
  const password  = String(req.body.password || '');

  const back = (msg) => {
    req.session.adminNewTenantFlash = { err: msg, form: { workspace, name, email: emailAddr } };
    return res.redirect('/admin/tenants/new');
  };

  if (!workspace) return back('Workspace name is required.');
  if (!name)      return back('Admin name is required.');
  if (!isValidEmail(emailAddr)) return back('That email looks invalid.');
  const pwErr = passwords.validate(password);
  if (pwErr) return back(pwErr);

  try {
    const existing = await query('SELECT 1 FROM users WHERE LOWER(email) = $1 LIMIT 1', [emailAddr]);
    if (existing.rows.length) return back('A user with that email already exists.');

    const slug = await uniqueSlug(slugify(workspace));
    const hashed = await passwords.hash(password);

    const t = await query(
      `INSERT INTO tenants (name, slug, status) VALUES ($1, $2, 'active') RETURNING id`,
      [workspace, slug]
    );
    const tenantId = t.rows[0].id;

    await query(
      `INSERT INTO users (tenant_id, email, password_hash, name, role, status, email_verified_at)
       VALUES ($1, $2, $3, $4, 'tenant_admin', 'active', NOW())`,
      [tenantId, emailAddr, hashed, name]
    );

    await provisionTenantSettings(tenantId);

    res.redirect('/admin/tenants/' + tenantId + '?ok=' + encodeURIComponent('Tenant created.'));
  } catch (e) {
    console.error('[admin POST /tenants/new]', e);
    return back('Something went wrong: ' + e.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/tenants/:id — detail
// ─────────────────────────────────────────────────────────────────────────────
router.get('/tenants/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.redirect('/admin');
  try {
    const t = await query(`SELECT id, name, slug, status, created_at, updated_at FROM tenants WHERE id = $1`, [id]);
    if (!t.rows.length) {
      return res.status(404).send(adminShell('Not found', `<div class="card"><h1>Tenant not found</h1><p class="lede"><a href="/admin">Back to tenants</a></p></div>`));
    }
    const tenant = t.rows[0];
    const u = await query(
      `SELECT id, email, name, role, status, email_verified_at, last_login_at, created_at
         FROM users
        WHERE tenant_id = $1
        ORDER BY id ASC`,
      [id]
    );

    const counts = await query(`
      SELECT
        (SELECT COUNT(*) FROM properties WHERE tenant_id = $1) AS properties,
        (SELECT COUNT(*) FROM contacts   WHERE tenant_id = $1) AS contacts,
        (SELECT COUNT(*) FROM lists      WHERE tenant_id = $1) AS lists,
        (SELECT COUNT(*) FROM campaigns  WHERE tenant_id = $1) AS campaigns
    `, [id]).catch(() => ({ rows: [{ properties: '?', contacts: '?', lists: '?', campaigns: '?' }] }));
    const c = counts.rows[0];

    const userRows = u.rows.map(usr => `
      <tr>
        <td><strong>${escHTML(usr.email)}</strong>${usr.email_verified_at ? '' : ' <span class="pill pill-invited">unverified</span>'}<div style="font-size:12px;color:#8b919c">${escHTML(usr.name || '—')}</div></td>
        <td>${escHTML(usr.role)}</td>
        <td><span class="pill pill-${escHTML(usr.status)}">${escHTML(usr.status)}</span></td>
        <td>${escHTML(fmtDateTime(usr.last_login_at))}</td>
        <td>${escHTML(fmtDate(usr.created_at))}</td>
        <td style="text-align:right;white-space:nowrap">
          ${usr.status === 'disabled'
            ? `<form class="inline" method="POST" action="/admin/tenants/${id}/users/${usr.id}/status"><input type="hidden" name="status" value="active"><button class="btn btn-sm" type="submit">Re-enable</button></form>`
            : `<form class="inline" method="POST" action="/admin/tenants/${id}/users/${usr.id}/status"><input type="hidden" name="status" value="disabled"><button class="btn btn-sm btn-warn" type="submit">Disable</button></form>`}
          <form class="inline" method="POST" action="/admin/tenants/${id}/users/${usr.id}/delete" onsubmit="return confirm('Delete user ${escHTML(usr.email)}? This cannot be undone.')"><button class="btn btn-sm btn-danger" type="submit">Delete</button></form>
        </td>
      </tr>
    `).join('');

    const isSuspended = tenant.status === 'suspended';
    const statusToggleLabel = isSuspended ? 'Reactivate tenant' : 'Pause (suspend) tenant';
    const statusToggleClass = isSuspended ? 'btn-primary' : 'btn-warn';
    const statusToggleNext  = isSuspended ? 'active' : 'suspended';
    const statusBlurb = isSuspended
      ? 'Currently suspended. Users in this workspace cannot sign in until reactivated.'
      : 'Suspending blocks all logins for users in this workspace. Data is retained.';

    res.send(adminShell(tenant.name, `
      <div class="breadcrumbs"><a href="/admin">Tenants</a> / ${escHTML(tenant.name)}</div>
      <div class="row">
        <div>
          <h1>${escHTML(tenant.name)} <span class="pill pill-${escHTML(tenant.status)}" style="margin-left:8px;vertical-align:middle">${escHTML(tenant.status)}</span></h1>
          <div class="lede">slug <code>${escHTML(tenant.slug)}</code> · created ${escHTML(fmtDate(tenant.created_at))}</div>
        </div>
      </div>

      <div class="meta-grid">
        <div class="stat"><div class="lbl">Users</div><div class="val">${u.rows.length}</div></div>
        <div class="stat"><div class="lbl">Properties</div><div class="val">${c.properties}</div></div>
        <div class="stat"><div class="lbl">Lists</div><div class="val">${c.lists}</div></div>
        <div class="stat"><div class="lbl">Campaigns</div><div class="val">${c.campaigns}</div></div>
      </div>

      <div class="card">
        <div class="row" style="margin-bottom:14px"><h2 style="font-size:16px;font-weight:600">Users</h2></div>
        ${u.rows.length ? `
        <div style="margin:0 -22px;overflow-x:auto"><table>
          <thead><tr><th>Email / name</th><th>Role</th><th>Status</th><th>Last login</th><th>Created</th><th></th></tr></thead>
          <tbody>${userRows}</tbody>
        </table></div>` : `<div class="empty">No users — orphaned tenant.</div>`}
      </div>

      <div class="card">
        <h2 style="font-size:16px;font-weight:600;margin-bottom:6px">Lifecycle</h2>
        <p class="lede" style="margin-bottom:14px">${escHTML(statusBlurb)}</p>
        <form class="inline" method="POST" action="/admin/tenants/${id}/status">
          <input type="hidden" name="status" value="${statusToggleNext}">
          <button class="btn ${statusToggleClass}" type="submit">${escHTML(statusToggleLabel)}</button>
        </form>
      </div>

      <div class="card danger-zone">
        <h2>Danger zone</h2>
        <p>Deletes this tenant and ALL associated data — every property, contact, phone, list, campaign, upload, and user account. Cascades through every <code>tenant_id</code> foreign key in the database. This cannot be undone.</p>
        <form class="inline" method="POST" action="/admin/tenants/${id}/delete" onsubmit="return confirmDelete()">
          <input type="hidden" name="confirm_slug" id="confirm_slug">
          <button class="btn btn-danger" type="submit">Delete tenant permanently</button>
        </form>
        <script>
          function confirmDelete() {
            var s = prompt('Type the tenant slug "${escHTML(tenant.slug)}" to confirm deletion:');
            if (s === null) return false;
            if (s !== ${JSON.stringify(tenant.slug)}) { alert('Slug did not match. Aborted.'); return false; }
            document.getElementById('confirm_slug').value = s;
            return true;
          }
        </script>
      </div>
    `, flashFromQuery(req)));
  } catch (e) {
    console.error('[admin GET /tenants/:id]', e);
    res.status(500).send(adminShell('Error', `<div class="card"><h1>Something went wrong</h1><p class="lede">${escHTML(e.message)}</p></div>`));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/tenants/:id/status — suspend / reactivate
// ─────────────────────────────────────────────────────────────────────────────
router.post('/tenants/:id/status', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const next = String(req.body.status || '').trim();
  if (!Number.isFinite(id)) return res.redirect('/admin');
  if (!['active', 'suspended', 'canceled'].includes(next)) {
    return res.redirect('/admin/tenants/' + id + '?err=' + encodeURIComponent('Invalid status.'));
  }
  try {
    await query(`UPDATE tenants SET status = $1, updated_at = NOW() WHERE id = $2`, [next, id]);
    const msg = next === 'suspended' ? 'Tenant suspended. Users can no longer sign in.'
              : next === 'active'    ? 'Tenant reactivated.'
              :                        'Tenant canceled.';
    res.redirect('/admin/tenants/' + id + '?ok=' + encodeURIComponent(msg));
  } catch (e) {
    console.error('[admin POST /tenants/:id/status]', e);
    res.redirect('/admin/tenants/' + id + '?err=' + encodeURIComponent(e.message));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/tenants/:id/delete — destructive
// ─────────────────────────────────────────────────────────────────────────────
router.post('/tenants/:id/delete', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.redirect('/admin');
  // Refuse to delete the super-admin's OWN tenant — that would log them out
  // mid-flow and leave the platform without a way back in.
  try {
    const meTenant = await query(`SELECT tenant_id FROM users WHERE id = $1`, [req.session.userId]);
    if (meTenant.rows.length && meTenant.rows[0].tenant_id === id) {
      return res.redirect('/admin/tenants/' + id + '?err=' + encodeURIComponent("Refusing to delete your own tenant. Switch accounts first."));
    }

    const confirmSlug = String(req.body.confirm_slug || '').trim();
    const t = await query(`SELECT slug FROM tenants WHERE id = $1`, [id]);
    if (!t.rows.length) return res.redirect('/admin?err=' + encodeURIComponent('Tenant not found.'));
    if (t.rows[0].slug !== confirmSlug) {
      return res.redirect('/admin/tenants/' + id + '?err=' + encodeURIComponent('Slug confirmation did not match. Aborted.'));
    }

    // ON DELETE CASCADE on every tenant_id FK does the heavy lifting.
    await query(`DELETE FROM tenants WHERE id = $1`, [id]);
    res.redirect('/admin?ok=' + encodeURIComponent('Tenant deleted.'));
  } catch (e) {
    console.error('[admin POST /tenants/:id/delete]', e);
    res.redirect('/admin/tenants/' + id + '?err=' + encodeURIComponent(e.message));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/tenants/:id/users/:uid/status — disable / re-enable user
// ─────────────────────────────────────────────────────────────────────────────
router.post('/tenants/:id/users/:uid/status', async (req, res) => {
  const id  = parseInt(req.params.id, 10);
  const uid = parseInt(req.params.uid, 10);
  const next = String(req.body.status || '').trim();
  if (!Number.isFinite(id) || !Number.isFinite(uid)) return res.redirect('/admin');
  if (!['active', 'disabled'].includes(next)) {
    return res.redirect('/admin/tenants/' + id + '?err=' + encodeURIComponent('Invalid user status.'));
  }
  if (uid === req.session.userId) {
    return res.redirect('/admin/tenants/' + id + '?err=' + encodeURIComponent("Refusing to change your own user status."));
  }
  try {
    await query(`UPDATE users SET status = $1 WHERE id = $2 AND tenant_id = $3`, [next, uid, id]);
    res.redirect('/admin/tenants/' + id + '?ok=' + encodeURIComponent(next === 'disabled' ? 'User disabled.' : 'User re-enabled.'));
  } catch (e) {
    console.error('[admin POST /tenants/:id/users/:uid/status]', e);
    res.redirect('/admin/tenants/' + id + '?err=' + encodeURIComponent(e.message));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/tenants/:id/users/:uid/delete
// ─────────────────────────────────────────────────────────────────────────────
router.post('/tenants/:id/users/:uid/delete', async (req, res) => {
  const id  = parseInt(req.params.id, 10);
  const uid = parseInt(req.params.uid, 10);
  if (!Number.isFinite(id) || !Number.isFinite(uid)) return res.redirect('/admin');
  if (uid === req.session.userId) {
    return res.redirect('/admin/tenants/' + id + '?err=' + encodeURIComponent("Refusing to delete your own user account."));
  }
  try {
    await query(`DELETE FROM users WHERE id = $1 AND tenant_id = $2`, [uid, id]);
    res.redirect('/admin/tenants/' + id + '?ok=' + encodeURIComponent('User deleted.'));
  } catch (e) {
    console.error('[admin POST /tenants/:id/users/:uid/delete]', e);
    res.redirect('/admin/tenants/' + id + '?err=' + encodeURIComponent(e.message));
  }
});

module.exports = router;
