// ═══════════════════════════════════════════════════════════════════════════════
// src/auth-routes.js — Phase 2 public auth routes
//
// All pre-login routes that touch the auth schema. Handlers here are PUBLIC —
// no requireAuth — and must be careful with rate-limiting / enumeration.
//
// Routes mounted in this module (Phase 2b — signup + verify):
//   GET  /signup            → signup form
//   POST /signup            → create tenant + user, send verify email
//   GET  /verify-email      → consume token, mark verified, log in
//   GET  /signup/sent       → "check your email" landing page after signup
//
// Phase 2c will add /login replacement, 2d /forgot-password + /reset-password.
// ═══════════════════════════════════════════════════════════════════════════════

const express = require('express');
const router  = express.Router();
const { query } = require('./db');
const passwords = require('./passwords');
const tokens    = require('./auth-tokens');
const email     = require('./email');
const { provisionTenantSettings } = require('./settings');

// ── Layout ───────────────────────────────────────────────────────────────────
// Auth pages share a single minimal shell. NOT the Ocular sidebar shell —
// these are pre-login. Cream background, centered card, matches the legacy
// /login styling so the brand transition feels intentional once you sign in.

function escHTML(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function authShell(title, bodyHtml, opts = {}) {
  const width = opts.width || 420;
  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHTML(title)} — Ocular</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f4f0;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;color:#1a1a1a}
  .auth-box{background:#fff;border:1px solid #e0dfd8;border-radius:14px;padding:2.25rem 2rem;width:100%;max-width:${width}px}
  .brand{text-align:center;margin-bottom:1.25rem}
  .brand-name{font-size:24px;font-weight:600;letter-spacing:-.5px}
  .brand-sub{font-size:12px;color:#888;margin-top:2px}
  h1{font-size:22px;font-weight:600;margin-bottom:.25rem;text-align:center}
  .lede{font-size:13px;color:#888;text-align:center;margin-bottom:1.5rem}
  label{font-size:12px;color:#555;display:block;margin-bottom:5px;font-weight:500}
  input[type=text],input[type=email],input[type=password]{width:100%;padding:10px 12px;border:1px solid #ddd;border-radius:8px;font-size:14px;background:#fafaf8;color:#1a1a1a;font-family:inherit}
  input:focus{outline:none;border-color:#888;background:#fff}
  .field{margin-bottom:1rem}
  .hint{font-size:11px;color:#999;margin-top:4px}
  button{width:100%;padding:11px;background:#1a1a1a;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit}
  button:hover{background:#333}
  button:disabled{background:#888;cursor:not-allowed}
  .alt{margin-top:1.25rem;text-align:center;font-size:13px;color:#666}
  .alt a{color:#1a1a1a;font-weight:600;text-decoration:none}
  .alt a:hover{text-decoration:underline}
  .error{background:#fff0f0;border:1px solid #f5c5c5;border-radius:8px;padding:10px 12px;font-size:13px;color:#c0392b;margin-bottom:1rem}
  .ok{background:#eef9f1;border:1px solid #c5e8d4;border-radius:8px;padding:10px 12px;font-size:13px;color:#1a7a4a;margin-bottom:1rem}
  .info{background:#f1f5fa;border:1px solid #cdd9ec;border-radius:8px;padding:10px 12px;font-size:13px;color:#2c5cc5;margin-bottom:1rem}
  .center-icon{display:flex;justify-content:center;margin-bottom:1rem;color:#1a7a4a}
  .center-icon svg{width:48px;height:48px}
</style>
</head><body>
<div class="auth-box">
  <div class="brand">
    <div class="brand-name">Ocular</div>
    <div class="brand-sub">Real estate data ops</div>
  </div>
  ${bodyHtml}
</div>
</body></html>`;
}

// ── helpers ──────────────────────────────────────────────────────────────────
function isValidEmail(e) {
  if (!e || typeof e !== 'string') return false;
  if (e.length > 254) return false;
  // Pragmatic check; real validation happens when verification email lands.
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
  // Probe slug, slug-2, slug-3 ... until we find an unused one.
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const r = await query('SELECT 1 FROM tenants WHERE slug = $1', [candidate]);
    if (!r.rows.length) return candidate;
  }
  // 50 collisions on a slug is absurd, but just in case:
  return `${base}-${Date.now().toString(36)}`;
}

// ── GET /signup ──────────────────────────────────────────────────────────────
router.get('/signup', (req, res) => {
  if (req.session && req.session.authenticated) return res.redirect('/ocular/dashboard');
  const err  = req.query.err  ? `<div class="error">${escHTML(req.query.err)}</div>` : '';
  const e    = escHTML(req.query.email || '');
  const n    = escHTML(req.query.name  || '');
  const w    = escHTML(req.query.workspace || '');
  res.send(authShell('Create your account', `
    <h1>Create your account</h1>
    <p class="lede">Free while we're in early access. No credit card.</p>
    ${err}
    <form method="POST" action="/signup" novalidate>
      <div class="field">
        <label for="name">Your name</label>
        <input id="name" type="text" name="name" value="${n}" autocomplete="name" required maxlength="100">
      </div>
      <div class="field">
        <label for="workspace">Workspace name</label>
        <input id="workspace" type="text" name="workspace" value="${w}" required maxlength="60" placeholder="Your company">
        <div class="hint">Shows up in your Ocular sidebar. Change later in Settings.</div>
      </div>
      <div class="field">
        <label for="email">Work email</label>
        <input id="email" type="email" name="email" value="${e}" autocomplete="email" required maxlength="254">
      </div>
      <div class="field">
        <label for="password">Password</label>
        <input id="password" type="password" name="password" autocomplete="new-password" required minlength="8" maxlength="200">
        <div class="hint">At least 8 characters.</div>
      </div>
      <button type="submit">Create account</button>
    </form>
    <div class="alt">Already have an account? <a href="/login">Sign in</a></div>
  `));
});

// ── POST /signup ─────────────────────────────────────────────────────────────
router.post('/signup', async (req, res) => {
  const name      = String(req.body.name || '').trim().slice(0, 100);
  const workspace = String(req.body.workspace || '').trim().slice(0, 60);
  const emailAddr = String(req.body.email || '').trim().toLowerCase().slice(0, 254);
  const password  = String(req.body.password || '');

  // Build a redirect-back URL that preserves the user's typed values so a
  // failure doesn't make them re-type everything.
  const back = (msg) => {
    const qp = new URLSearchParams({
      err: msg, email: emailAddr, name, workspace,
    });
    return res.redirect('/signup?' + qp.toString());
  };

  if (!name)             return back('Please enter your name.');
  if (!workspace)        return back('Please enter a workspace name.');
  if (!isValidEmail(emailAddr)) return back('That email address looks invalid.');
  const pwErr = passwords.validate(password);
  if (pwErr) return back(pwErr);

  try {
    // Refuse if email already exists in ANY tenant — keeps the email→user
    // lookup unambiguous at login time. (Multi-tenant per-email could come
    // later; not needed for free-tier launch.)
    const existing = await query('SELECT 1 FROM users WHERE email = $1 LIMIT 1', [emailAddr]);
    if (existing.rows.length) {
      return back('An account with that email already exists. Try signing in?');
    }

    const slug = await uniqueSlug(slugify(workspace));
    const hashed = await passwords.hash(password);

    // Create tenant + user atomically. If anything between the two queries
    // throws, we'd leak an empty tenant; acceptable in v1 (we can clean up
    // empty tenants later if it becomes a problem).
    const t = await query(
      `INSERT INTO tenants (name, slug, status) VALUES ($1, $2, 'active') RETURNING id`,
      [workspace, slug]
    );
    const tenantId = t.rows[0].id;

    const u = await query(
      `INSERT INTO users (tenant_id, email, password_hash, name, role, status)
       VALUES ($1, $2, $3, $4, 'admin', 'active') RETURNING id`,
      [tenantId, emailAddr, hashed, name]
    );
    const userId = u.rows[0].id;

    // Seed per-tenant defaults (delete_code etc.)
    await provisionTenantSettings(tenantId);

    // Issue verify token + send email. 24-hour TTL.
    const token = await tokens.issueToken('email_verification_tokens', userId, 24 * 60);
    const sent  = await email.sendVerifyEmail(emailAddr, name, token);
    if (!sent) {
      // Email failed — DON'T block the signup. Surface that on the next page
      // so the user knows to use /signup/resend if the email never arrives.
      console.warn('[signup] verification email failed for', emailAddr);
    }

    // Stash user-id in session so /signup/sent can offer a resend button.
    req.session.pendingUserId = userId;
    res.redirect('/signup/sent?email=' + encodeURIComponent(emailAddr));
  } catch (e) {
    console.error('[signup POST]', e);
    return back('Something went wrong. Please try again.');
  }
});

// ── GET /signup/sent — "check your email" page ──────────────────────────────
router.get('/signup/sent', (req, res) => {
  const e = escHTML(req.query.email || 'your inbox');
  const flash = req.query.flash ? `<div class="ok">${escHTML(req.query.flash)}</div>` : '';
  res.send(authShell('Check your email', `
    <div class="center-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
        <polyline points="22,6 12,13 2,6"/>
      </svg>
    </div>
    <h1>Check your email</h1>
    <p class="lede">We sent a verification link to <strong>${e}</strong>. Click it to finish setting up your account.</p>
    ${flash}
    <form method="POST" action="/signup/resend">
      <input type="hidden" name="email" value="${e}">
      <button type="submit">Resend verification email</button>
    </form>
    <div class="alt"><a href="/login">Back to sign in</a></div>
  `));
});

// ── POST /signup/resend ──────────────────────────────────────────────────────
router.post('/signup/resend', async (req, res) => {
  const emailAddr = String(req.body.email || '').trim().toLowerCase();
  if (!isValidEmail(emailAddr)) return res.redirect('/login');
  try {
    const u = await query(
      `SELECT id, name, email_verified_at FROM users WHERE email = $1 LIMIT 1`,
      [emailAddr]
    );
    if (!u.rows.length) {
      // Don't leak account existence — same response either way.
      return res.redirect('/signup/sent?email=' + encodeURIComponent(emailAddr) +
                          '&flash=' + encodeURIComponent('If an account exists, we sent a fresh link.'));
    }
    const user = u.rows[0];
    if (user.email_verified_at) {
      return res.redirect('/login?info=' + encodeURIComponent('That email is already verified. Sign in below.'));
    }
    const token = await tokens.issueToken('email_verification_tokens', user.id, 24 * 60);
    await email.sendVerifyEmail(emailAddr, user.name, token);
    return res.redirect('/signup/sent?email=' + encodeURIComponent(emailAddr) +
                        '&flash=' + encodeURIComponent('Fresh link sent.'));
  } catch (e) {
    console.error('[signup/resend]', e);
    return res.redirect('/signup/sent?email=' + encodeURIComponent(emailAddr));
  }
});

// ── GET /verify-email?token=... ──────────────────────────────────────────────
router.get('/verify-email', async (req, res) => {
  const token = String(req.query.token || '');
  if (!token) {
    return res.send(authShell('Invalid link', `
      <h1>Invalid link</h1>
      <p class="lede">That verification link is missing a token.</p>
      <div class="alt"><a href="/login">Back to sign in</a></div>
    `));
  }
  try {
    const userId = await tokens.consumeToken('email_verification_tokens', token);
    if (!userId) {
      return res.send(authShell('Link expired', `
        <h1>Link expired</h1>
        <div class="error">This verification link is invalid or has already been used.</div>
        <p class="lede">Try signing in — if your email isn't verified yet, we'll offer to resend the link.</p>
        <div class="alt"><a href="/login">Sign in</a></div>
      `));
    }

    // Mark verified (idempotent — safe even if already set).
    await query(
      `UPDATE users SET email_verified_at = COALESCE(email_verified_at, NOW()) WHERE id = $1`,
      [userId]
    );

    // Pull the user + tenant for the new session.
    const r = await query(
      `SELECT id, tenant_id, role, name FROM users WHERE id = $1 AND status = 'active' LIMIT 1`,
      [userId]
    );
    if (!r.rows.length) {
      return res.send(authShell('Account not found', `
        <h1>Account not found</h1>
        <div class="error">Your account couldn't be loaded. Please contact support.</div>
      `));
    }
    const u = r.rows[0];
    req.session.authenticated = true;
    req.session.userId        = u.id;
    req.session.tenantId      = u.tenant_id;
    req.session.role          = u.role;
    delete req.session.pendingUserId;

    res.redirect('/ocular/dashboard?welcome=1');
  } catch (e) {
    console.error('[verify-email GET]', e);
    return res.send(authShell('Something went wrong', `
      <h1>Something went wrong</h1>
      <div class="error">We couldn't verify your email. Try the link again, or sign in to request a fresh one.</div>
      <div class="alt"><a href="/login">Sign in</a></div>
    `));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Login / logout — Phase 2c
// ─────────────────────────────────────────────────────────────────────────────

// In-memory failed-attempt counter (carried over from the old /login). Same
// semantics: 5 failures per 15 min → 429 with Retry-After. Acceptable on a
// single Node replica; move to Redis when we scale out.
const _loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;

function _loginIp(req) {
  return String(req.ip || req.connection?.remoteAddress || 'unknown');
}

function _loginRateLimit(req, res, next) {
  const ip = _loginIp(req);
  const now = Date.now();
  const rec = _loginAttempts.get(ip);
  if (rec && (now - rec.firstAt) < LOGIN_WINDOW_MS && rec.count >= LOGIN_MAX_FAILURES) {
    const retryAfter = Math.ceil((LOGIN_WINDOW_MS - (now - rec.firstAt)) / 1000);
    res.set('Retry-After', String(retryAfter));
    return res.status(429).send(authShell('Too many attempts', `
      <h1>Too many login attempts</h1>
      <p class="lede">Try again in ${Math.ceil(retryAfter / 60)} minute(s).</p>
    `));
  }
  if (rec && (now - rec.firstAt) >= LOGIN_WINDOW_MS) {
    _loginAttempts.delete(ip);
  }
  next();
}

function _bumpLoginFailure(ip) {
  const rec = _loginAttempts.get(ip) || { count: 0, firstAt: Date.now() };
  rec.count++;
  _loginAttempts.set(ip, rec);
}

// ── GET /login ───────────────────────────────────────────────────────────────
router.get('/login', (req, res) => {
  if (req.session && req.session.authenticated && req.session.tenantId) {
    return res.redirect('/ocular/dashboard');
  }
  const err   = req.query.err  ? `<div class="error">${escHTML(req.query.err)}</div>` : '';
  const info  = req.query.info ? `<div class="info">${escHTML(req.query.info)}</div>` : '';
  const error = req.query.error ? `<div class="error">Invalid email or password.</div>` : '';
  const e     = escHTML(req.query.email || '');
  res.send(authShell('Sign in', `
    <h1>Sign in</h1>
    <p class="lede">Welcome back.</p>
    ${info}${error}${err}
    <form method="POST" action="/login" novalidate>
      <div class="field">
        <label for="email">Email</label>
        <input id="email" type="email" name="email" value="${e}" autocomplete="email" autofocus required maxlength="254">
      </div>
      <div class="field">
        <label for="password">Password</label>
        <input id="password" type="password" name="password" autocomplete="current-password" required>
        <div class="hint" style="text-align:right;margin-top:6px"><a href="/forgot-password" style="color:#666;text-decoration:none">Forgot password?</a></div>
      </div>
      <button type="submit">Sign in</button>
    </form>
    <div class="alt">No account? <a href="/signup">Create one</a></div>
  `));
});

// ── POST /login ──────────────────────────────────────────────────────────────
router.post('/login', _loginRateLimit, async (req, res) => {
  const ip = _loginIp(req);
  const emailAddr = String(req.body.email || '').trim().toLowerCase();
  const password  = String(req.body.password || '');

  const fail = () => {
    _bumpLoginFailure(ip);
    return res.redirect('/login?error=1&email=' + encodeURIComponent(emailAddr));
  };

  if (!isValidEmail(emailAddr) || !password) return fail();

  try {
    const r = await query(
      `SELECT id, tenant_id, role, password_hash, email_verified_at, status, name
         FROM users WHERE email = $1 LIMIT 1`,
      [emailAddr]
    );
    if (!r.rows.length) return fail();
    const u = r.rows[0];
    if (u.status !== 'active') return fail();
    const ok = await passwords.verify(password, u.password_hash);
    if (!ok) return fail();

    // Soft block on unverified email — they can re-trigger the link.
    if (!u.email_verified_at) {
      // Issue a fresh verify token and tell them.
      const token = await tokens.issueToken('email_verification_tokens', u.id, 24 * 60);
      await email.sendVerifyEmail(emailAddr, u.name, token);
      return res.redirect('/signup/sent?email=' + encodeURIComponent(emailAddr) +
                          '&flash=' + encodeURIComponent('Please verify your email before signing in. Fresh link sent.'));
    }

    _loginAttempts.delete(ip);
    req.session.authenticated = true;
    req.session.userId        = u.id;
    req.session.tenantId      = u.tenant_id;
    req.session.role          = u.role;

    // Best-effort last_login_at; non-fatal if it errors.
    query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [u.id]).catch(() => {});

    res.redirect('/ocular/dashboard');
  } catch (e) {
    console.error('[login POST]', e);
    return res.redirect('/login?err=' + encodeURIComponent('Something went wrong. Please try again.'));
  }
});

// ── GET /logout ──────────────────────────────────────────────────────────────
router.get('/logout', (req, res) => {
  if (req.session) req.session.destroy(() => res.redirect('/login'));
  else res.redirect('/login');
});

// ─────────────────────────────────────────────────────────────────────────────
// Password reset — Phase 2d
// ─────────────────────────────────────────────────────────────────────────────

// ── GET /forgot-password ─────────────────────────────────────────────────────
router.get('/forgot-password', (req, res) => {
  const flash = req.query.flash ? `<div class="ok">${escHTML(req.query.flash)}</div>` : '';
  const e = escHTML(req.query.email || '');
  res.send(authShell('Reset password', `
    <h1>Reset your password</h1>
    <p class="lede">Enter your email and we'll send you a reset link.</p>
    ${flash}
    <form method="POST" action="/forgot-password" novalidate>
      <div class="field">
        <label for="email">Email</label>
        <input id="email" type="email" name="email" value="${e}" autocomplete="email" autofocus required maxlength="254">
      </div>
      <button type="submit">Send reset link</button>
    </form>
    <div class="alt"><a href="/login">Back to sign in</a></div>
  `));
});

// ── POST /forgot-password ────────────────────────────────────────────────────
router.post('/forgot-password', async (req, res) => {
  const emailAddr = String(req.body.email || '').trim().toLowerCase();

  // Always show the same confirmation page — never leak whether the email
  // exists. Only act if we actually find a matching user.
  const ok = () => res.redirect('/forgot-password?email=' + encodeURIComponent(emailAddr) +
                                '&flash=' + encodeURIComponent('If an account exists for that email, we sent a reset link.'));

  if (!isValidEmail(emailAddr)) return ok();
  try {
    const r = await query(
      `SELECT id, name FROM users WHERE email = $1 AND status = 'active' LIMIT 1`,
      [emailAddr]
    );
    if (r.rows.length) {
      const u = r.rows[0];
      const token = await tokens.issueToken('password_reset_tokens', u.id, 60); // 1 hour
      await email.sendPasswordResetEmail(emailAddr, u.name, token);
    }
    return ok();
  } catch (e) {
    console.error('[forgot-password POST]', e);
    return ok();
  }
});

// ── GET /reset-password?token=... ────────────────────────────────────────────
router.get('/reset-password', async (req, res) => {
  const token = String(req.query.token || '');
  if (!token) {
    return res.send(authShell('Invalid link', `
      <h1>Invalid link</h1>
      <p class="lede">That password-reset link is missing a token.</p>
      <div class="alt"><a href="/forgot-password">Request a new link</a></div>
    `));
  }
  // Probe the token without consuming it — we only mark used_at after the
  // POST below succeeds. That way a click that lands the form but never
  // submits doesn't burn the token.
  try {
    const r = await query(
      `SELECT 1 FROM password_reset_tokens
        WHERE token = $1 AND used_at IS NULL AND expires_at > NOW()`,
      [token]
    );
    if (!r.rows.length) {
      return res.send(authShell('Link expired', `
        <h1>Link expired</h1>
        <div class="error">This reset link is invalid or has already been used.</div>
        <div class="alt"><a href="/forgot-password">Request a new link</a></div>
      `));
    }
  } catch (e) {
    console.error('[reset-password GET]', e);
    return res.send(authShell('Something went wrong', `
      <h1>Something went wrong</h1>
      <div class="error">Please try the link again.</div>
    `));
  }
  const err = req.query.err ? `<div class="error">${escHTML(req.query.err)}</div>` : '';
  res.send(authShell('Choose a new password', `
    <h1>Choose a new password</h1>
    <p class="lede">Enter and confirm your new password.</p>
    ${err}
    <form method="POST" action="/reset-password" novalidate>
      <input type="hidden" name="token" value="${escHTML(token)}">
      <div class="field">
        <label for="password">New password</label>
        <input id="password" type="password" name="password" autocomplete="new-password" required minlength="8" maxlength="200" autofocus>
        <div class="hint">At least 8 characters.</div>
      </div>
      <div class="field">
        <label for="confirm">Confirm new password</label>
        <input id="confirm" type="password" name="confirm" required minlength="8" maxlength="200">
      </div>
      <button type="submit">Update password</button>
    </form>
  `));
});

// ── POST /reset-password ─────────────────────────────────────────────────────
router.post('/reset-password', async (req, res) => {
  const token    = String(req.body.token    || '');
  const password = String(req.body.password || '');
  const confirm  = String(req.body.confirm  || '');

  const back = (msg) => res.redirect('/reset-password?token=' + encodeURIComponent(token) +
                                     '&err=' + encodeURIComponent(msg));

  const pwErr = passwords.validate(password);
  if (pwErr) return back(pwErr);
  if (password !== confirm) return back('Passwords do not match.');

  try {
    const userId = await tokens.consumeToken('password_reset_tokens', token);
    if (!userId) {
      return res.send(authShell('Link expired', `
        <h1>Link expired</h1>
        <div class="error">This reset link is invalid or has already been used.</div>
        <div class="alt"><a href="/forgot-password">Request a new link</a></div>
      `));
    }
    const hashed = await passwords.hash(password);
    await query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hashed, userId]);

    // Notify the account that the password was changed (best-effort).
    const u = await query(`SELECT email, name FROM users WHERE id = $1 LIMIT 1`, [userId]);
    if (u.rows.length) {
      email.sendPasswordChangedEmail(u.rows[0].email, u.rows[0].name).catch(() => {});
    }

    res.redirect('/login?info=' + encodeURIComponent('Password updated. Sign in with your new password.'));
  } catch (e) {
    console.error('[reset-password POST]', e);
    return back('Something went wrong. Please try the link again.');
  }
});

module.exports = router;
