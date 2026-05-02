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

// 2026-05-01 Phase 4 — admin-action audit trail. Logs against the TARGET
// tenant (not the operator's own tenant — operators don't have one) so
// each tenant's activity feed shows operator actions taken on their data.
const _activityLog = require('../activity-log');
function _logAdmin(req, action, tenantId, opts = {}) {
  // Synthesize a fake req with the target tenantId so the helper writes
  // the row scoped to the affected tenant. The operator's identity is
  // captured in metadata.acting_admin.
  const operatorId = (req && req.session && req.session.userId) || null;
  const operatorEmail = (req && req.session && (req.session.email || req.session.superAdminEmail)) || null;
  const fakeReq = {
    session: { tenantId, userId: null },
    ip: req && (req.ip || req.headers['x-forwarded-for']) || null,
    headers: req && req.headers || {},
  };
  const md = Object.assign(
    { acting_admin_user_id: operatorId, acting_admin_email: operatorEmail, source: 'admin' },
    opts.metadata || {}
  );
  return _activityLog.log(fakeReq, action, { ...opts, metadata: md });
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
  // 2026-05-01 gap fix — every /admin POST flows through the global CSRF
  // middleware (mounted in server.js BEFORE the /admin router). Without
  // this meta tag + the auto-attach script, every Suspend / Delete / Role
  // change / Dedup form would 403 with "CSRF token missing or invalid."
  // Token comes from AsyncLocalStorage populated by csrfMiddleware.
  const _csrfToken = (() => {
    try { return require('../csrf').currentToken(); }
    catch (_) { return ''; }
  })();
  const _csrfMeta = _csrfToken
    ? `<meta name="csrf-token" content="${String(_csrfToken).replace(/[^a-zA-Z0-9]/g, '')}">`
    : '';
  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${_csrfMeta}
<title>${escHTML(title)} — Oculah Admin</title>
<script src="/js/csrf-protect.js" defer></script>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  /* 2026-05-01 Phase 4 — HQ visual polish.
     Goal: feel like a control plane, not a bargain admin theme.
     Tokens follow the Ocular palette but darker / higher-contrast.
     The dark theme is intentional — visually distinct from the
     tenant-facing app so operators always know which surface they're on. */
  :root{
    --hq-bg:           #0a0c10;
    --hq-bg-2:         #11141b;
    --hq-card:         #161a23;
    --hq-card-2:       #1a1f2c;
    --hq-border:       #232a3a;
    --hq-border-2:     #2d364a;
    --hq-text:         #e4e7ed;
    --hq-text-2:       #aeb4c0;
    --hq-text-3:       #6e7585;
    --hq-accent:       #5b8def;
    --hq-accent-soft:  rgba(91,141,239,.15);
    --hq-success:      #34d399;
    --hq-success-soft: rgba(52,211,153,.15);
    --hq-warn:         #fbbf24;
    --hq-warn-soft:    rgba(251,191,36,.15);
    --hq-danger:       #f87171;
    --hq-danger-soft:  rgba(248,113,113,.15);
    --hq-violet:       #a78bfa;
    --hq-violet-soft:  rgba(167,139,250,.15);
    --hq-radius:       12px;
    --hq-radius-sm:    8px;
    --hq-shadow:       0 1px 0 rgba(255,255,255,0.03) inset, 0 1px 3px rgba(0,0,0,0.3);
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{
    font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    background:var(--hq-bg);color:var(--hq-text);line-height:1.55;min-height:100vh;
    -webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;
    font-feature-settings:'cv02','cv03','cv04','cv11';
  }
  a{color:var(--hq-accent);text-decoration:none}
  a:hover{color:#7ba2f4}
  code{font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--hq-bg-2);padding:2px 7px;border-radius:5px;font-size:12px;color:var(--hq-text-2);border:1px solid var(--hq-border)}

  /* Top bar */
  .topbar{
    background:linear-gradient(180deg,#000 0%,#070a0f 100%);
    border-bottom:1px solid var(--hq-border);
    padding:0 32px;display:flex;align-items:center;justify-content:space-between;
    height:60px;position:sticky;top:0;z-index:50;
    backdrop-filter:saturate(180%) blur(8px);
  }
  .topbar .brand{font-weight:700;font-size:16px;letter-spacing:-.2px;display:flex;align-items:center;gap:10px}
  .topbar .brand .tag{
    background:linear-gradient(135deg,#7a1a1a,#9a2a2a);color:#fff;font-size:10px;
    padding:3px 8px;border-radius:5px;letter-spacing:1.2px;text-transform:uppercase;font-weight:700;
    box-shadow:0 1px 0 rgba(255,255,255,.1) inset;
  }
  .topbar nav{display:flex;gap:4px;align-items:center}
  .topbar nav a{
    color:var(--hq-text-2);font-size:13px;padding:8px 14px;border-radius:7px;font-weight:500;
    transition:background .12s,color .12s;
  }
  .topbar nav a:hover{background:var(--hq-card);color:var(--hq-text)}
  .topbar nav a.active{color:#fff;background:var(--hq-card)}

  /* Main container */
  main{max-width:1240px;margin:36px auto;padding:0 32px 96px}

  /* Headings */
  h1{font-size:28px;font-weight:700;margin-bottom:6px;letter-spacing:-.5px;line-height:1.2}
  h2{font-size:16px;font-weight:600;margin-bottom:4px;letter-spacing:-.2px}
  .lede{color:var(--hq-text-2);font-size:14px;margin-bottom:28px}
  .lede code{font-size:12px}

  /* Breadcrumbs */
  .breadcrumbs{font-size:13px;color:var(--hq-text-3);margin-bottom:14px;display:flex;align-items:center;gap:8px}
  .breadcrumbs a{color:var(--hq-text-2);transition:color .12s}
  .breadcrumbs a:hover{color:var(--hq-text)}
  .breadcrumbs::before{content:'';width:0;height:0}

  /* Layout helpers */
  .row{display:flex;justify-content:space-between;align-items:center;gap:14px;margin-bottom:24px;flex-wrap:wrap}
  .row h1{margin:0}

  /* Cards */
  .card{
    background:var(--hq-card);border:1px solid var(--hq-border);border-radius:var(--hq-radius);
    padding:24px;box-shadow:var(--hq-shadow);
  }
  .card + .card{margin-top:16px}
  .card-table{padding:0;overflow:hidden}

  /* KPI strip */
  .meta-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:22px}
  .meta-grid .stat{
    background:var(--hq-card);border:1px solid var(--hq-border);border-radius:var(--hq-radius);
    padding:18px 20px;transition:border-color .15s,transform .15s;
  }
  .meta-grid .stat:hover{border-color:var(--hq-border-2)}
  .meta-grid .stat .lbl{
    font-size:11px;color:var(--hq-text-3);text-transform:uppercase;
    letter-spacing:.08em;margin-bottom:8px;font-weight:600;
  }
  .meta-grid .stat .val{font-size:24px;font-weight:700;letter-spacing:-.5px;line-height:1.2}
  .meta-grid .stat .stat-sub{font-size:13px;font-weight:500;color:var(--hq-text-3);margin-left:6px}
  @media (max-width:840px){.meta-grid{grid-template-columns:repeat(2,1fr)}}

  /* Table */
  table{width:100%;border-collapse:collapse;font-size:13.5px}
  th,td{text-align:left;padding:14px 18px;border-bottom:1px solid var(--hq-border)}
  th{
    font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.07em;
    color:var(--hq-text-3);background:var(--hq-bg-2);position:sticky;top:0;
  }
  tbody tr{transition:background .12s}
  tbody tr:hover td{background:var(--hq-card-2)}
  tbody tr:last-child td{border-bottom:none}
  td .t-name{display:block;color:var(--hq-text)}
  td .t-slug{font-size:12px;color:var(--hq-text-3);font-family:'JetBrains Mono',monospace;margin-top:3px}
  td .t-num{font-size:14px;font-weight:600}
  td .t-sub{font-size:11.5px;color:var(--hq-text-3);margin-left:6px}

  /* Pills */
  .pill{
    display:inline-flex;align-items:center;font-size:10.5px;padding:3px 9px;
    border-radius:999px;text-transform:uppercase;letter-spacing:.06em;font-weight:700;
    border:1px solid transparent;line-height:1.5;
  }
  .pill-active{background:var(--hq-success-soft);color:var(--hq-success);border-color:rgba(52,211,153,.3)}
  .pill-suspended{background:var(--hq-warn-soft);color:var(--hq-warn);border-color:rgba(251,191,36,.3)}
  .pill-canceled{background:var(--hq-danger-soft);color:var(--hq-danger);border-color:rgba(248,113,113,.3)}
  .pill-disabled{background:rgba(255,255,255,.06);color:var(--hq-text-3)}
  .pill-invited{background:rgba(91,141,239,.12);color:var(--hq-accent);border-color:rgba(91,141,239,.3)}
  .pill-role-admin{background:var(--hq-violet-soft);color:var(--hq-violet);border-color:rgba(167,139,250,.3)}
  .pill-role-member{background:rgba(255,255,255,.04);color:var(--hq-text-2);border-color:var(--hq-border)}
  .pill-role-other{background:rgba(255,255,255,.04);color:var(--hq-text-3);border-color:var(--hq-border)}

  /* Buttons */
  .btn{
    display:inline-flex;align-items:center;justify-content:center;gap:6px;
    padding:9px 16px;border-radius:8px;border:1px solid var(--hq-border-2);
    background:var(--hq-card-2);color:var(--hq-text);
    font-size:13px;font-weight:500;cursor:pointer;font-family:inherit;
    text-decoration:none;transition:background .12s,border-color .12s,color .12s,transform .05s;
    white-space:nowrap;line-height:1;
  }
  .btn:hover{background:#222837;border-color:#39435c;text-decoration:none;color:#fff}
  .btn:active{transform:translateY(1px)}
  .btn-primary{
    background:linear-gradient(180deg,#3b6ed8,#2c5fb5);border-color:#2c5fb5;color:#fff;
    box-shadow:0 1px 0 rgba(255,255,255,.15) inset;
  }
  .btn-primary:hover{background:linear-gradient(180deg,#4a7ce0,#3565bf);color:#fff}
  .btn-warn{background:linear-gradient(180deg,#7a4d12,#5a3a0e);border-color:#7a4d12;color:#ffd897}
  .btn-warn:hover{background:#8a5816;color:#ffd897}
  .btn-danger{background:linear-gradient(180deg,#7a1a1a,#5a1414);border-color:#7a1a1a;color:#ffb0b0}
  .btn-danger:hover{background:#8a1f1f}
  .btn-sm{padding:6px 12px;font-size:12px}
  form.inline{display:inline-flex;gap:6px;align-items:center}

  /* Role dropdown */
  .role-select{
    padding:6px 28px 6px 11px;border-radius:7px;border:1px solid var(--hq-border-2);
    background:var(--hq-card-2);color:var(--hq-text);font-size:12px;font-family:inherit;
    font-weight:500;cursor:pointer;-webkit-appearance:none;-moz-appearance:none;appearance:none;
    background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23aeb4c0' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>");
    background-repeat:no-repeat;background-position:right 8px center;
    transition:border-color .12s,background-color .12s;
  }
  .role-select:hover{border-color:var(--hq-accent);background-color:#222837}
  .role-select:focus{outline:none;border-color:var(--hq-accent);box-shadow:0 0 0 3px var(--hq-accent-soft)}

  /* Forms */
  label{
    display:block;font-size:11px;color:var(--hq-text-3);margin-bottom:7px;
    font-weight:600;text-transform:uppercase;letter-spacing:.07em;
  }
  input[type=text],input[type=email],input[type=password],textarea,select{
    width:100%;padding:11px 13px;border-radius:8px;border:1px solid var(--hq-border-2);
    background:var(--hq-bg-2);color:var(--hq-text);font-size:14px;font-family:inherit;
    transition:border-color .12s,box-shadow .12s,background-color .12s;
  }
  input:focus,textarea:focus,select:focus{
    outline:none;border-color:var(--hq-accent);box-shadow:0 0 0 3px var(--hq-accent-soft);
    background:var(--hq-card);
  }
  .field{margin-bottom:18px}
  .hint{font-size:12px;color:var(--hq-text-3);margin-top:6px}

  /* Flash */
  .flash{
    padding:13px 16px;border-radius:var(--hq-radius-sm);margin-bottom:18px;
    font-size:13px;border:1px solid transparent;font-weight:500;
  }
  .flash-ok{background:var(--hq-success-soft);border-color:rgba(52,211,153,.3);color:var(--hq-success)}
  .flash-err{background:var(--hq-danger-soft);border-color:rgba(248,113,113,.3);color:var(--hq-danger)}

  /* Empty state */
  .empty{padding:64px 32px;text-align:center;color:var(--hq-text-3);font-size:14px}

  /* Danger zone */
  .danger-zone{border:1px solid rgba(248,113,113,.3);background:linear-gradient(180deg,rgba(248,113,113,.05),rgba(248,113,113,.02))}
  .danger-zone h2{color:var(--hq-danger);font-size:13px;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px;font-weight:700}
  .danger-zone p{font-size:13px;color:var(--hq-text-2);margin-bottom:14px}
</style>
</head><body>
<header class="topbar">
  <div class="brand">Oculah <span class="tag">HQ</span></div>
  <nav>
    <a href="/admin">Tenants</a>
    <a href="/admin/promos">Promo codes</a>
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
             COALESCE(uc.user_count, 0)  AS user_count,
             COALESCE(ac.admin_count, 0) AS admin_count,
             u.email         AS primary_email,
             u.role          AS primary_role,
             u.last_login_at AS primary_last_login
        FROM tenants t
        LEFT JOIN (
          SELECT tenant_id, COUNT(*) AS user_count
            FROM users
           GROUP BY tenant_id
        ) uc ON uc.tenant_id = t.id
        LEFT JOIN (
          SELECT tenant_id, COUNT(*) AS admin_count
            FROM users
           WHERE role = 'tenant_admin'
           GROUP BY tenant_id
        ) ac ON ac.tenant_id = t.id
        LEFT JOIN LATERAL (
          -- 2026-05-01: prefer the tenant's actual admin (lowest-id active
          -- admin) over the lowest-id user overall, so the "Primary email"
          -- column reflects who actually runs the workspace.
          SELECT email, role, last_login_at
            FROM users
           WHERE tenant_id = t.id
           ORDER BY (role = 'tenant_admin' AND status = 'active') DESC, id ASC
           LIMIT 1
        ) u ON TRUE
        ORDER BY t.created_at DESC, t.id DESC
    `);
    const _roleLabel = (rl) => rl === 'tenant_admin' ? 'Admin'
                              : rl === 'tenant_user' ? 'Member'
                              : rl === 'super_admin' ? 'Super-admin'
                              : (rl ? escHTML(rl) : '—');
    const _rolePill = (rl) => {
      const label = _roleLabel(rl);
      const cls = rl === 'tenant_admin' ? 'pill-role-admin'
                : rl === 'tenant_user'  ? 'pill-role-member'
                : 'pill-role-other';
      return `<span class="pill ${cls}">${label}</span>`;
    };
    const rows = r.rows.map(t => `
      <tr>
        <td>
          <a href="/admin/tenants/${t.id}" class="t-name"><strong>${escHTML(t.name)}</strong></a>
          <div class="t-slug">${escHTML(t.slug)}</div>
        </td>
        <td>${escHTML(t.primary_email || '—')}</td>
        <td>${_rolePill(t.primary_role)}</td>
        <td>
          <span class="t-num">${t.user_count}</span>
          <span class="t-sub">${t.admin_count} admin${t.admin_count === 1 ? '' : 's'}</span>
        </td>
        <td><span class="pill pill-${escHTML(t.status)}">${escHTML(t.status)}</span></td>
        <td>${escHTML(fmtDate(t.created_at))}</td>
        <td>${escHTML(fmtDateTime(t.primary_last_login))}</td>
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
      admins: r.rows.reduce((a, t) => a + Number(t.admin_count || 0), 0),
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
        <div class="stat"><div class="lbl">Total users</div><div class="val">${stats.users}<span class="stat-sub"> · ${stats.admins} admin${stats.admins === 1 ? '' : 's'}</span></div></div>
      </div>
      <div class="card card-table">
        ${r.rows.length ? `
        <table>
          <thead><tr>
            <th>Workspace</th>
            <th>Primary email</th>
            <th>Role</th>
            <th>Users</th>
            <th>Status</th>
            <th>Created</th>
            <th>Last login</th>
            <th></th>
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

    _logAdmin(req, 'admin.tenant_created', tenantId, { resource_type: 'tenant', resource_id: String(tenantId), metadata: { workspace, slug, primary_email: emailAddr } });
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

    // 2026-05-01 Phase 4 — readable role labels + per-user role dropdown.
    // The Role column used to render the raw enum value (`tenant_admin`).
    // Now shows a dropdown that double-serves as label + change control.
    // POSTing a different value hits /admin/tenants/:id/users/:uid/role.
    // Same pattern as the workspace-level /oculah/members page so the two
    // surfaces stay consistent.
    const _roleLabel = (r) => r === 'tenant_admin' ? 'Admin'
                            : r === 'tenant_user'  ? 'Member'
                            : r === 'super_admin'  ? 'Super-admin'
                            : escHTML(r);
    const _roleSelect = (uid, currentRole) => `
      <form class="inline" method="POST" action="/admin/tenants/${id}/users/${uid}/role" onchange="this.requestSubmit()">
        <select name="role" class="role-select">
          <option value="tenant_admin" ${currentRole === 'tenant_admin' ? 'selected' : ''}>Admin</option>
          <option value="tenant_user"  ${currentRole === 'tenant_user'  ? 'selected' : ''}>Member</option>
        </select>
      </form>`;
    const userRows = u.rows.map(usr => `
      <tr>
        <td><strong>${escHTML(usr.email)}</strong>${usr.email_verified_at ? '' : ' <span class="pill pill-invited">unverified</span>'}<div style="font-size:12px;color:#8b919c">${escHTML(usr.name || '—')}</div></td>
        <td>${usr.role === 'super_admin' ? `<span class="pill">${_roleLabel(usr.role)}</span>` : _roleSelect(usr.id, usr.role)}</td>
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

      <div class="card">
        <h2 style="font-size:16px;font-weight:600;margin-bottom:6px">Data maintenance</h2>
        <p class="lede" style="margin-bottom:14px">Run a duplicate-contact merge across this tenant's records. Collapses contacts that share a phone number, and contacts that share name+state+zip. Re-homes property links and phone rows onto the lowest-id keeper. Safe to run any time; auto-runs after every bulk import as well.</p>
        <form class="inline" method="POST" action="/admin/tenants/${id}/dedup"
              onsubmit="return confirm('Run duplicate-contact merge for this tenant? This rewrites property_contacts and phones rows.');">
          <button class="btn btn-primary" type="submit">Merge duplicates</button>
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
// POST /admin/tenants/:id/dedup — run dedupByPhone + dedupByNameAddress
// scoped to one tenant. Super-admin only (whole router is requireSuperAdmin).
// Moved here from /oculah/records on 2026-04-30 — it shouldn't have been a
// regular-user action since it rewrites cross-record state.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/tenants/:id/dedup', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.redirect('/admin');
  try {
    const { dedupByPhone, dedupByNameAddress } = require('../maintenance');
    const phoneStats = await dedupByPhone('confirm',       { tenantId: id });
    const nameStats  = await dedupByNameAddress('confirm', { tenantId: id });
    const total = phoneStats.losersMerged + nameStats.losersMerged;
    const msg = total > 0
      ? `Merged ${total} duplicate contact(s): ${phoneStats.losersMerged} via shared phone, ${nameStats.losersMerged} via name+address.`
      : 'No duplicate contacts found — tenant data is clean.';
    _logAdmin(req, 'admin.dedup_run', id, { resource_type: 'tenant', resource_id: String(id), metadata: { merged_total: total, by_phone: phoneStats.losersMerged, by_name_addr: nameStats.losersMerged } });
    res.redirect('/admin/tenants/' + id + '?ok=' + encodeURIComponent(msg));
  } catch (e) {
    console.error('[admin POST /tenants/:id/dedup]', e);
    res.redirect('/admin/tenants/' + id + '?err=' + encodeURIComponent('Dedup failed: ' + e.message));
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
    _logAdmin(req, 'admin.tenant_status_changed', id, { resource_type: 'tenant', resource_id: String(id), metadata: { new_status: next } });
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

    // 2026-05-01: log BEFORE the delete because the cascade nukes the
    // activity_log row alongside the tenant. So this entry will only
    // exist on a separate audit surface (server logs / future
    // platform-level audit log) — but the helper is best-effort and
    // we'd rather log on the tenant's row than nowhere.
    _logAdmin(req, 'admin.tenant_deleted', id, { resource_type: 'tenant', resource_id: String(id), metadata: { slug: t.rows[0].slug } });
    console.warn(`[ADMIN_AUDIT] tenant deleted id=${id} slug=${t.rows[0].slug} by_user=${req.session.userId} ip=${req.ip}`);
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
    _logAdmin(req, 'admin.user_status_changed', id, { resource_type: 'user', resource_id: String(uid), metadata: { new_status: next } });
    res.redirect('/admin/tenants/' + id + '?ok=' + encodeURIComponent(next === 'disabled' ? 'User disabled.' : 'User re-enabled.'));
  } catch (e) {
    console.error('[admin POST /tenants/:id/users/:uid/status]', e);
    res.redirect('/admin/tenants/' + id + '?err=' + encodeURIComponent(e.message));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2026-05-01 Phase 4 — POST /admin/tenants/:id/users/:uid/role
// Promote/demote a user. Allowed roles from this surface: tenant_admin /
// tenant_user. Refuses to demote the last active admin (would orphan the
// tenant — no one could manage it from inside the workspace).
// ─────────────────────────────────────────────────────────────────────────────
router.post('/tenants/:id/users/:uid/role', async (req, res) => {
  const id  = parseInt(req.params.id, 10);
  const uid = parseInt(req.params.uid, 10);
  const next = String(req.body.role || '').trim();
  if (!Number.isFinite(id) || !Number.isFinite(uid)) return res.redirect('/admin');
  if (!['tenant_admin', 'tenant_user'].includes(next)) {
    return res.redirect('/admin/tenants/' + id + '?err=' + encodeURIComponent('Invalid role.'));
  }
  try {
    // Refuse to demote the last active admin.
    const target = await query(`SELECT role, status FROM users WHERE id = $1 AND tenant_id = $2`, [uid, id]);
    if (!target.rows.length) {
      return res.redirect('/admin/tenants/' + id + '?err=' + encodeURIComponent('User not found.'));
    }
    if (target.rows[0].role === 'tenant_admin' && next !== 'tenant_admin') {
      const adminCount = await query(
        `SELECT COUNT(*)::int AS n FROM users
          WHERE tenant_id = $1 AND role = 'tenant_admin' AND status = 'active'`,
        [id]
      );
      if (adminCount.rows[0].n <= 1) {
        return res.redirect('/admin/tenants/' + id + '?err=' + encodeURIComponent('Cannot demote the last active admin.'));
      }
    }
    if (target.rows[0].role === next) {
      return res.redirect('/admin/tenants/' + id + '?ok=' + encodeURIComponent('Role unchanged.'));
    }
    await query(`UPDATE users SET role = $1 WHERE id = $2 AND tenant_id = $3`, [next, uid, id]);
    _logAdmin(req, 'admin.user_role_changed', id, { resource_type: 'user', resource_id: String(uid), metadata: { from: target.rows[0].role, to: next } });
    res.redirect('/admin/tenants/' + id + '?ok=' + encodeURIComponent(next === 'tenant_admin' ? 'User promoted to Admin.' : 'User changed to Member.'));
  } catch (e) {
    console.error('[admin POST /tenants/:id/users/:uid/role]', e);
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
    _logAdmin(req, 'admin.user_deleted', id, { resource_type: 'user', resource_id: String(uid) });
    await query(`DELETE FROM users WHERE id = $1 AND tenant_id = $2`, [uid, id]);
    res.redirect('/admin/tenants/' + id + '?ok=' + encodeURIComponent('User deleted.'));
  } catch (e) {
    console.error('[admin POST /tenants/:id/users/:uid/delete]', e);
    res.redirect('/admin/tenants/' + id + '?err=' + encodeURIComponent(e.message));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3b — promo codes (single-use, bypass card on signup)
// ─────────────────────────────────────────────────────────────────────────────
function _promoStatus(row) {
  if (row.redeemed_at) return `<span class="pill pill-suspended">Redeemed</span>`;
  if (row.expires_at && new Date(row.expires_at) <= new Date()) return `<span class="pill pill-suspended">Expired</span>`;
  if (!row.active) return `<span class="pill pill-suspended">Inactive</span>`;
  return `<span class="pill pill-active">Available</span>`;
}

router.get('/promos', async (req, res) => {
  try {
    const r = await query(`
      SELECT p.id, p.code, p.description, p.expires_at, p.active, p.redeemed_at,
             p.redeemed_by_email, p.created_by_admin, p.created_at,
             t.name AS tenant_name, t.id AS tenant_id
        FROM trial_promo_codes p
        LEFT JOIN tenants t ON t.id = p.redeemed_by_tenant_id
        ORDER BY p.created_at DESC
        LIMIT 500
    `);
    const rows = r.rows.map(p => `
      <tr>
        <td><code style="font-family:monospace;font-weight:600">${escHTML(p.code)}</code>
            <div class="t-sub">${escHTML(p.description || '')}</div></td>
        <td>${_promoStatus(p)}</td>
        <td>${p.redeemed_by_email
              ? `<a href="/admin/tenants/${p.tenant_id}">${escHTML(p.tenant_name || '—')}</a><div class="t-sub">${escHTML(p.redeemed_by_email)}</div>`
              : '—'}</td>
        <td>${escHTML(fmtDate(p.expires_at))}</td>
        <td>${escHTML(fmtDate(p.created_at))}</td>
        <td>${escHTML(p.created_by_admin || '—')}</td>
        <td style="text-align:right">
          ${(p.active && !p.redeemed_at) ? `
            <form method="POST" action="/admin/promos/${p.id}/deactivate" style="display:inline">
              <button class="btn btn-sm" type="submit">Deactivate</button>
            </form>` : ''}
        </td>
      </tr>
    `).join('');
    const empty = r.rows.length ? '' : `<div class="empty">No promo codes yet.</div>`;
    res.send(adminShell('Promo codes', `
      <div class="row">
        <div>
          <h1>Promo codes</h1>
          <div class="lede">Single-use codes that bypass card collection and start a 7-day free trial.</div>
        </div>
        <a class="btn btn-primary" href="/admin/promos/new">+ New code</a>
      </div>
      <div class="card card-table">
        ${r.rows.length ? `
        <table>
          <thead><tr>
            <th>Code</th>
            <th>Status</th>
            <th>Redeemed by</th>
            <th>Expires</th>
            <th>Created</th>
            <th>Created by</th>
            <th></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>` : empty}
      </div>
    `));
  } catch (e) {
    console.error('[admin GET /promos]', e);
    res.status(500).send(adminShell('Error', `<div class="card"><h1>Something went wrong</h1><p class="lede">${escHTML(e.message)}</p></div>`));
  }
});

router.get('/promos/new', (req, res) => {
  const err = req.query.err ? `<div class="flash flash-error">${escHTML(req.query.err)}</div>` : '';
  res.send(adminShell('New promo code', `
    ${err}
    <div class="card">
      <h1>New promo code</h1>
      <form method="POST" action="/admin/promos/new">
        <div class="field">
          <label>Code</label>
          <input type="text" name="code" required maxlength="60" autocomplete="off"
                 placeholder="e.g. FOUNDERS2026" style="text-transform:uppercase;font-family:monospace">
          <div class="hint">Letters, numbers, hyphens. Stored uppercase.</div>
        </div>
        <div class="field">
          <label>Description (internal)</label>
          <input type="text" name="description" maxlength="200" placeholder="What's this code for?">
        </div>
        <div class="field">
          <label>Expires (optional)</label>
          <input type="date" name="expires_at">
          <div class="hint">Leave blank for no expiry.</div>
        </div>
        <button class="btn btn-primary" type="submit">Create code</button>
        <a href="/admin/promos" style="margin-left:12px">Cancel</a>
      </form>
    </div>
  `));
});

router.post('/promos/new', async (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const description = String(req.body.description || '').trim().slice(0, 200) || null;
  const expRaw = String(req.body.expires_at || '').trim();
  if (!code || !/^[A-Z0-9-]{3,60}$/.test(code)) {
    return res.redirect('/admin/promos/new?err=' + encodeURIComponent('Code must be 3-60 chars: A-Z, 0-9, hyphen.'));
  }
  const expiresAt = expRaw ? expRaw : null;
  try {
    const operator = (req.session && (req.session.superAdminUsername || req.superAdminEmail)) || 'hq';
    const r = await query(`
      INSERT INTO trial_promo_codes (code, description, expires_at, created_by_admin)
      VALUES ($1, $2, $3::date, $4)
      RETURNING id`, [code, description, expiresAt, operator]);
    res.redirect('/admin/promos?ok=' + encodeURIComponent('Code ' + code + ' created (id ' + r.rows[0].id + ').'));
  } catch (e) {
    if (String(e.message).includes('duplicate')) {
      return res.redirect('/admin/promos/new?err=' + encodeURIComponent('That code already exists.'));
    }
    console.error('[admin POST /promos/new]', e);
    res.redirect('/admin/promos/new?err=' + encodeURIComponent(e.message));
  }
});

router.post('/promos/:id/deactivate', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.redirect('/admin/promos');
  try {
    await query(`UPDATE trial_promo_codes SET active = FALSE WHERE id = $1 AND redeemed_at IS NULL`, [id]);
    res.redirect('/admin/promos?ok=' + encodeURIComponent('Code deactivated.'));
  } catch (e) {
    console.error('[admin POST /promos/:id/deactivate]', e);
    res.redirect('/admin/promos?err=' + encodeURIComponent(e.message));
  }
});

module.exports = router;
