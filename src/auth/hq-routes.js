// ═══════════════════════════════════════════════════════════════════════════
// src/auth/hq-routes.js — HQ / Platform Admin login portal
//
// Distinct from the tenant /login flow. Operators authenticate against env
// vars (HQ_USERNAME + HQ_PASSWORD), and on success the session carries
// `superAdmin = true` which gates the existing /admin/* console.
//
// The portal lives on its own URL prefix so it doesn't appear in the tenant
// navigation, isn't crawled, and rate-limit / IP-allowlist policies can be
// added independently of tenant signup.
//
// Routes:
//   GET  /hq          → redirect to /admin if already authed, else /hq/login
//   GET  /hq/login    → render minimal login form
//   POST /hq/login    → check creds, set session.superAdmin=true, redirect /admin
//   GET  /hq/logout   → clear superAdmin flag, redirect /hq/login
// ═══════════════════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();

function escHTML(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function hqShell(title, body) {
  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escHTML(title)} — HQ</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0E1116;color:#F0F3F6;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
  .box{background:#161B22;border:1px solid #21262D;border-radius:14px;padding:2.25rem 2rem;width:100%;max-width:380px}
  .brand{text-align:center;margin-bottom:1.25rem}
  .brand-name{font-size:14px;font-weight:600;letter-spacing:2px;color:#22D3EE;text-transform:uppercase}
  h1{font-size:22px;font-weight:600;margin-bottom:.25rem;text-align:center}
  .lede{font-size:13px;color:#9DA7B0;text-align:center;margin-bottom:1.5rem}
  label{font-size:12px;color:#9DA7B0;display:block;margin-bottom:5px;font-weight:500}
  input{width:100%;padding:10px 12px;border:1px solid #21262D;border-radius:8px;font-size:14px;background:#0E1116;color:#F0F3F6;font-family:inherit}
  input:focus{outline:none;border-color:#22D3EE}
  .field{margin-bottom:1rem}
  button{width:100%;padding:11px;background:#22D3EE;color:#0E1116;border:none;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer}
  button:hover{background:#67e8f9}
  .error{background:#3a1a1a;border:1px solid #6b2e2e;border-radius:8px;padding:10px 12px;font-size:13px;color:#ff8a80;margin-bottom:1rem}
</style>
</head><body>
<div class="box">
  <div class="brand"><div class="brand-name">HQ Console</div></div>
  ${body}
</div>
</body></html>`;
}

// In-memory rate limiter — same pattern as auth-routes, scoped to this module.
const _hqAttempts = new Map();
function _hqRateLimit(req, res, next) {
  const ip = String(req.ip || req.connection?.remoteAddress || 'unknown');
  const now = Date.now();
  const WIN = 15 * 60 * 1000; // 15 min
  const MAX = 8;
  const rec = _hqAttempts.get(ip);
  if (rec && (now - rec.firstAt) < WIN && rec.count >= MAX) {
    const retryAfter = Math.ceil((WIN - (now - rec.firstAt)) / 1000);
    res.set('Retry-After', String(retryAfter));
    return res.status(429).send(hqShell('Too many attempts',
      `<h1>Slow down</h1><p class="lede">Try again in ${Math.ceil(retryAfter / 60)} minute(s).</p>`));
  }
  if (rec && (now - rec.firstAt) >= WIN) _hqAttempts.delete(ip);
  const cur = _hqAttempts.get(ip) || { count: 0, firstAt: now };
  cur.count++;
  _hqAttempts.set(ip, cur);
  next();
}

function _hqClear(req) {
  const ip = String(req.ip || req.connection?.remoteAddress || 'unknown');
  _hqAttempts.delete(ip);
}

// Constant-time string compare to avoid timing leaks on the username check.
// (Password is bcrypt'd in the env var; that already runs constant-time.)
function _ctEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

router.get('/hq', (req, res) => {
  if (req.session && req.session.superAdmin) return res.redirect('/admin');
  res.redirect('/hq/login');
});

router.get('/hq/login', (req, res) => {
  if (req.session && req.session.superAdmin) return res.redirect('/admin');
  const err = req.query.error
    ? `<div class="error">Invalid credentials</div>`
    : '';
  res.send(hqShell('HQ Sign-in', `
    <h1>HQ Sign-in</h1>
    <p class="lede">Platform operators only.</p>
    ${err}
    <form method="POST" action="/hq/login" novalidate autocomplete="off">
      <div class="field">
        <label for="u">Username</label>
        <input id="u" type="text" name="username" autocomplete="username" required maxlength="120">
      </div>
      <div class="field">
        <label for="p">Password</label>
        <input id="p" type="password" name="password" autocomplete="current-password" required maxlength="200">
      </div>
      <button type="submit">Sign in</button>
    </form>
  `));
});

router.post('/hq/login', _hqRateLimit, async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const expectedUser = String(process.env.HQ_USERNAME || '').trim();
  const expectedPass = String(process.env.HQ_PASSWORD || '');

  if (!expectedUser || !expectedPass) {
    return res.status(503).send(hqShell('Unavailable', `
      <h1>HQ console disabled</h1>
      <p class="lede">Set <code>HQ_USERNAME</code> and <code>HQ_PASSWORD</code> on the deployment to enable.</p>
    `));
  }

  if (!username || !password ||
      !_ctEqual(username, expectedUser) ||
      !_ctEqual(password, expectedPass)) {
    return res.redirect('/hq/login?error=1');
  }

  _hqClear(req);
  // Don't carry tenant context — HQ session is platform-only. Explicitly
  // clear any tenant-side fields if a previous session left them.
  req.session.superAdmin = true;
  req.session.superAdminUsername = username;
  delete req.session.tenantId;
  delete req.session.userId;
  delete req.session.role;
  delete req.session.authenticated;
  res.redirect('/admin');
});

router.get('/hq/logout', (req, res) => {
  if (req.session) {
    req.session.destroy(() => res.redirect('/hq/login'));
  } else {
    res.redirect('/hq/login');
  }
});

module.exports = router;
