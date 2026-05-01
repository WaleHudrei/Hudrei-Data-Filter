// ═══════════════════════════════════════════════════════════════════════════
// src/invitations-routes.js — Phase 4 routes
//
// Members management (admin-only): /oculah/members
//   GET  /oculah/members            — list workspace members + pending invites
//   POST /oculah/members/invite     — send an invite
//   POST /oculah/members/:id/role   — change a member's role
//   POST /oculah/members/:id/disable — disable a member (soft-disable)
//   POST /oculah/members/invites/:id/revoke — revoke a pending invite
//
// Public accept flow:
//   GET  /invite/:token             — accept-invite page
//   POST /invite/:token             — submit name + password, become a user
// ═══════════════════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();

const invitations = require('./invitations');
const email       = require('./email');
const activity    = require('./activity-log');
const { isWorkspaceAdmin } = require('./auth/roles');
const { escHTML } = require('./ui/_helpers');
const { query }   = require('./db');

function _requireAdmin(req, res, next) {
  if (!req.session?.authenticated) return res.redirect('/login');
  if (!isWorkspaceAdmin(req)) return res.status(403).send('Workspace admin only.');
  next();
}

// ── Members page (admin only) ──────────────────────────────────────────────
router.get('/oculah/members', _requireAdmin, async (req, res) => {
  try {
    const [members, invites, tenant] = await Promise.all([
      invitations.listMembers(req.session.tenantId),
      invitations.listInvitesForTenant(req.session.tenantId),
      query('SELECT name FROM tenants WHERE id = $1', [req.session.tenantId]),
    ]);
    const tName = tenant.rows[0]?.name || 'Workspace';
    const flashOk  = req.query.msg ? `<div style="background:#eaf6ea;border:1px solid #9bd09b;color:#1a5f1a;padding:10px 14px;border-radius:8px;margin-bottom:14px;font-size:13px">${escHTML(req.query.msg)}</div>` : '';
    const flashErr = req.query.err ? `<div style="background:#fdeaea;border:1px solid #f5c5c5;color:#8b1f1f;padding:10px 14px;border-radius:8px;margin-bottom:14px;font-size:13px">${escHTML(req.query.err)}</div>` : '';

    const memberRows = members.map(m => `<tr>
      <td>${escHTML(m.name || '—')}</td>
      <td>${escHTML(m.email)}</td>
      <td>${escHTML(m.role)}</td>
      <td>${escHTML(m.status)}</td>
      <td>${m.last_login_at ? new Date(m.last_login_at).toLocaleString() : '—'}</td>
      <td style="white-space:nowrap">
        ${m.id !== req.session.userId ? `
          <form method="POST" action="/oculah/members/${m.id}/role" style="display:inline">
            <select name="role" onchange="this.form.submit()" style="font-size:12px;padding:4px">
              <option value="tenant_user"  ${m.role==='tenant_user'?'selected':''}>Member</option>
              <option value="tenant_admin" ${m.role==='tenant_admin'?'selected':''}>Admin</option>
            </select>
          </form>
          ${m.status === 'active' ? `
            <form method="POST" action="/oculah/members/${m.id}/disable" style="display:inline" onsubmit="return confirm('Disable this user? They keep their data but can\\'t sign in until re-enabled.')">
              <button type="submit" style="font-size:12px;padding:4px 8px;border:1px solid #ddd;background:#fff;border-radius:4px;cursor:pointer">Disable</button>
            </form>` : '<span style="color:#888;font-size:12px">disabled</span>'}
        ` : '<span style="color:#888;font-size:12px">(you)</span>'}
      </td>
    </tr>`).join('');

    const inviteRows = invites.map(i => {
      const status = i.accepted_at ? 'Accepted'
                   : i.revoked_at ? 'Revoked'
                   : new Date(i.expires_at) < new Date() ? 'Expired'
                   : 'Pending';
      const pending = !i.accepted_at && !i.revoked_at && new Date(i.expires_at) > new Date();
      return `<tr>
        <td>${escHTML(i.email)}</td>
        <td>${escHTML(i.role)}</td>
        <td>${status}</td>
        <td>${escHTML(i.invited_by_name || '—')}</td>
        <td>${new Date(i.created_at).toLocaleDateString()}</td>
        <td>${pending ? `<form method="POST" action="/oculah/members/invites/${i.id}/revoke" style="display:inline"><button type="submit" style="font-size:12px;padding:4px 8px;border:1px solid #ddd;background:#fff;border-radius:4px;cursor:pointer">Revoke</button></form>` : '—'}</td>
      </tr>`;
    }).join('');

    res.send(`<!DOCTYPE html><html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Members · Oculah</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f4f0;color:#1a1a1a}
  .top{display:flex;justify-content:space-between;align-items:center;padding:18px 32px;border-bottom:1px solid #e8e7e1;background:#fff}
  .brand a{color:inherit;text-decoration:none;font-weight:700;font-size:18px}
  .top a{font-size:14px;text-decoration:none;color:#444;margin-left:18px}
  .wrap{max-width:1100px;margin:32px auto;padding:0 32px 96px}
  h1{font-size:28px;font-weight:700;margin-bottom:4px}
  .meta{font-size:13px;color:#888;margin-bottom:24px}
  h2{font-size:18px;font-weight:600;margin:28px 0 12px}
  .card{background:#fff;border:1px solid #e8e7e1;border-radius:12px;padding:18px 22px;margin-bottom:16px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;padding:8px 10px;font-size:11px;text-transform:uppercase;color:#888;font-weight:600;letter-spacing:.06em;border-bottom:1px solid #f0efe9}
  td{padding:10px;border-bottom:1px solid #f8f7f4;vertical-align:middle}
  tr:last-child td{border-bottom:none}
  form.inline{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap}
  label{display:block;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px}
  input,select{padding:9px 12px;border:1px solid #ddd;border-radius:8px;font-size:13px;font-family:inherit;background:#fff}
  button.primary{padding:9px 18px;background:#1a1a1a;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}
</style></head><body>
<header class="top">
  <div class="brand"><a href="/oculah/dashboard">Oculah</a></div>
  <nav>
    <a href="/oculah/dashboard">Dashboard</a>
    <a href="/oculah/members">Members</a>
    <a href="/billing">Billing</a>
    <a href="/logout">Sign out</a>
  </nav>
</header>
<main class="wrap">
  <h1>Members</h1>
  <div class="meta">${escHTML(tName)}</div>
  ${flashOk}${flashErr}

  <div class="card">
    <h2 style="margin:0 0 14px">Invite a teammate</h2>
    <form method="POST" action="/oculah/members/invite" class="inline">
      <div><label>Email</label><input type="email" name="email" required maxlength="254"></div>
      <div><label>Role</label>
        <select name="role">
          <option value="tenant_user">Member</option>
          <option value="tenant_admin">Admin</option>
        </select>
      </div>
      <button type="submit" class="primary">Send invite</button>
    </form>
  </div>

  <h2>Members (${members.length})</h2>
  <div class="card" style="padding:0">
    <table>
      <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Last login</th><th></th></tr></thead>
      <tbody>${memberRows || '<tr><td colspan="6" style="text-align:center;color:#888;padding:20px">No members yet.</td></tr>'}</tbody>
    </table>
  </div>

  <h2>Invitations (${invites.length})</h2>
  <div class="card" style="padding:0">
    <table>
      <thead><tr><th>Email</th><th>Role</th><th>Status</th><th>Invited by</th><th>Sent</th><th></th></tr></thead>
      <tbody>${inviteRows || '<tr><td colspan="6" style="text-align:center;color:#888;padding:20px">No invites yet.</td></tr>'}</tbody>
    </table>
  </div>
</main></body></html>`);
  } catch (e) {
    console.error('[members]', e);
    res.status(500).send('Error: ' + escHTML(e.message));
  }
});

// ── Invite create ──────────────────────────────────────────────────────────
router.post('/oculah/members/invite', _requireAdmin, async (req, res) => {
  try {
    const inv = await invitations.createInvite(
      req.session.tenantId,
      req.body.email,
      req.body.role,
      req.session.userId
    );
    // Best-effort send the email
    try {
      const t = await query('SELECT name FROM tenants WHERE id = $1', [req.session.tenantId]);
      const u = await query('SELECT name FROM users WHERE id = $1', [req.session.userId]);
      await email.sendInviteEmail(req.body.email, u.rows[0]?.name, t.rows[0]?.name, inv.token);
    } catch (e) {
      console.warn('[invite] email send failed:', e.message);
    }
    activity.log(req, 'invite.created', { resource_type: 'invitation', metadata: { email: req.body.email, role: req.body.role } });
    res.redirect('/oculah/members?msg=' + encodeURIComponent(inv.refreshed ? 'Invite refreshed.' : 'Invite sent.'));
  } catch (e) {
    res.redirect('/oculah/members?err=' + encodeURIComponent(e.message));
  }
});

router.post('/oculah/members/:id(\\d+)/role', _requireAdmin, async (req, res) => {
  try {
    const ok = await invitations.updateMemberRole(req.session.tenantId, parseInt(req.params.id, 10), req.body.role);
    if (!ok) return res.redirect('/oculah/members?err=Member+not+found');
    activity.log(req, 'member.role_changed', { resource_type: 'user', resource_id: req.params.id, metadata: { role: req.body.role } });
    res.redirect('/oculah/members?msg=Role+updated');
  } catch (e) {
    res.redirect('/oculah/members?err=' + encodeURIComponent(e.message));
  }
});

router.post('/oculah/members/:id(\\d+)/disable', _requireAdmin, async (req, res) => {
  try {
    const r = await invitations.disableMember(req.session.tenantId, parseInt(req.params.id, 10));
    if (!r.ok) return res.redirect('/oculah/members?err=' + encodeURIComponent(r.error));
    activity.log(req, 'member.disabled', { resource_type: 'user', resource_id: req.params.id });
    res.redirect('/oculah/members?msg=Member+disabled');
  } catch (e) {
    res.redirect('/oculah/members?err=' + encodeURIComponent(e.message));
  }
});

router.post('/oculah/members/invites/:id(\\d+)/revoke', _requireAdmin, async (req, res) => {
  try {
    const ok = await invitations.revokeInvite(req.session.tenantId, parseInt(req.params.id, 10));
    if (ok) activity.log(req, 'invite.revoked', { resource_type: 'invitation', resource_id: req.params.id });
    res.redirect('/oculah/members?msg=' + encodeURIComponent(ok ? 'Invite revoked.' : 'Invite not found.'));
  } catch (e) {
    res.redirect('/oculah/members?err=' + encodeURIComponent(e.message));
  }
});

// ── Public accept flow ─────────────────────────────────────────────────────
function _acceptShell(title, body) {
  return `<!DOCTYPE html><html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHTML(title)} · Oculah</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f4f0;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;color:#1a1a1a}
  .box{background:#fff;border:1px solid #e0dfd8;border-radius:14px;padding:36px 32px;width:100%;max-width:440px}
  h1{font-size:22px;font-weight:600;margin-bottom:6px;text-align:center}
  .lede{font-size:13px;color:#666;text-align:center;margin-bottom:20px}
  label{display:block;font-size:12px;color:#555;margin-bottom:5px;font-weight:500}
  input{width:100%;padding:10px 12px;border:1px solid #ddd;border-radius:8px;font-size:14px;background:#fafaf8;color:#1a1a1a;font-family:inherit;margin-bottom:12px}
  input:focus{outline:none;border-color:#888;background:#fff}
  button{width:100%;padding:11px;background:#1a1a1a;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit}
  .err{background:#fff0f0;border:1px solid #f5c5c5;color:#c0392b;padding:9px 12px;border-radius:8px;font-size:13px;margin-bottom:14px}
</style></head><body><div class="box">${body}</div></body></html>`;
}

router.get('/invite/:token', async (req, res) => {
  const inv = await invitations.findInviteByToken(req.params.token);
  if (!inv) {
    return res.send(_acceptShell('Invitation', `
      <h1>Invitation not valid</h1>
      <p class="lede">This link has expired, been revoked, or already been used.</p>
      <p class="lede"><a href="/login">Sign in</a> if you already have an account.</p>
    `));
  }
  const err = req.query.err ? `<div class="err">${escHTML(req.query.err)}</div>` : '';
  res.send(_acceptShell('Accept invitation', `
    <h1>Join ${escHTML(inv.tenant_name)}</h1>
    <p class="lede">You're being invited to <strong>${escHTML(inv.email)}</strong> as ${escHTML(inv.role === 'tenant_admin' ? 'Admin' : 'Member')}.</p>
    ${err}
    <form method="POST" action="/invite/${encodeURIComponent(req.params.token)}">
      <label>Your name</label>
      <input type="text" name="name" required maxlength="100" autofocus>
      <label>Choose a password</label>
      <input type="password" name="password" required minlength="8" maxlength="200">
      <button type="submit">Accept invitation</button>
    </form>
  `));
});

router.post('/invite/:token', async (req, res) => {
  try {
    const result = await invitations.acceptInvite(req.params.token, req.body.name, req.body.password);
    req.session.authenticated = true;
    req.session.userId   = result.userId;
    req.session.tenantId = result.tenantId;
    req.session.role     = result.role;
    res.redirect('/oculah/dashboard?msg=' + encodeURIComponent('Welcome to your workspace.'));
  } catch (e) {
    res.redirect(`/invite/${encodeURIComponent(req.params.token)}?err=${encodeURIComponent(e.message)}`);
  }
});

module.exports = router;
