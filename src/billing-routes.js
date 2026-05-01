// ═══════════════════════════════════════════════════════════════════════════
// src/billing-routes.js — Phase 3 Stripe billing routes
//
// Mounted at root: /billing/* and /billing/webhook
// All routes are env-gated — when STRIPE_SECRET_KEY is unset, GET /billing
// shows a "billing not configured yet" message and POST /billing/checkout
// returns a friendly error instead of throwing.
// ═══════════════════════════════════════════════════════════════════════════

const express = require('express');
const router  = express.Router();
const billing = require('./billing');
const { query } = require('./db');
const { escHTML } = require('./ui/_helpers');

function _shell(title, body) {
  // 2026-05-01 gap fix — load CSRF meta + auto-attach script. Without
  // these, the POST /billing/checkout and POST /billing/portal forms
  // would 403 against the global CSRF middleware.
  let _t = '';
  try { _t = require('./csrf').currentToken() || ''; } catch (_) {}
  const _safe = String(_t).replace(/[^a-zA-Z0-9]/g, '');
  return `<!DOCTYPE html><html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${_safe ? `<meta name="csrf-token" content="${_safe}">` : ''}
<script src="/js/csrf-protect.js" defer></script>
<title>${escHTML(title)} · Oculah</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f4f0;color:#1a1a1a;line-height:1.55}
  .top{display:flex;justify-content:space-between;align-items:center;padding:18px 32px;border-bottom:1px solid #e8e7e1;background:#fff}
  .brand{font-weight:700;font-size:18px}
  .brand a{color:inherit;text-decoration:none}
  .top a{font-size:14px;text-decoration:none;color:#444;margin-left:18px}
  .wrap{max-width:720px;margin:48px auto;padding:0 32px 96px}
  h1{font-size:32px;font-weight:700;letter-spacing:-.5px;margin-bottom:6px}
  .meta{font-size:13px;color:#888;margin-bottom:24px}
  .card{background:#fff;border:1px solid #e8e7e1;border-radius:14px;padding:24px;margin-bottom:16px}
  .row{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}
  .stat-label{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#888;font-weight:600;margin-bottom:4px}
  .stat-value{font-size:18px;font-weight:600}
  .pill{display:inline-block;padding:4px 12px;border-radius:999px;font-size:12px;font-weight:600}
  .pill-ok{background:#dcfce7;color:#166534}
  .pill-trial{background:#fef3c7;color:#92400e}
  .pill-warn{background:#fee2e2;color:#991b1b}
  .pill-off{background:#e5e7eb;color:#374151}
  .btn{display:inline-block;padding:11px 20px;border-radius:10px;font-weight:600;font-size:14px;text-decoration:none;cursor:pointer;border:none;font-family:inherit}
  .btn-primary{background:#1a1a1a;color:#fff}
  .btn-primary:hover{background:#333}
  .btn-secondary{background:#fff;border:1px solid #ddd;color:#1a1a1a}
  .flash-ok{background:#eaf6ea;border:1px solid #9bd09b;color:#1a5f1a;padding:10px 14px;border-radius:8px;margin-bottom:14px;font-size:13px}
  .flash-err{background:#fdeaea;border:1px solid #f5c5c5;color:#8b1f1f;padding:10px 14px;border-radius:8px;margin-bottom:14px;font-size:13px}
  .placeholder{background:#fffbeb;border:1px solid #fde68a;color:#78350f;padding:14px 18px;border-radius:10px;font-size:13px;margin-bottom:24px}
</style>
</head><body>
<header class="top">
  <div class="brand"><a href="/oculah/dashboard">Oculah</a></div>
  <nav><a href="/oculah/dashboard">Dashboard</a><a href="/billing">Billing</a><a href="/logout">Sign out</a></nav>
</header>
<main class="wrap">${body}</main>
</body></html>`;
}

function _statusPill(s) {
  if (s === 'active')   return '<span class="pill pill-ok">Active</span>';
  if (s === 'trialing') return '<span class="pill pill-trial">Trial</span>';
  if (s === 'past_due') return '<span class="pill pill-warn">Past due</span>';
  if (s === 'canceled') return '<span class="pill pill-warn">Canceled</span>';
  if (s == null)        return '<span class="pill pill-off">Not started</span>';
  return `<span class="pill">${escHTML(s)}</span>`;
}

function _daysLeft(endsAt) {
  if (!endsAt) return null;
  const ms = new Date(endsAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
}

// ── GET /billing — current status + actions ────────────────────────────────
router.get('/billing', async (req, res) => {
  if (!req.session?.authenticated || !req.session?.tenantId) return res.redirect('/login');
  try {
    const r = await query(`
      SELECT t.name, t.subscription_status, t.trial_ends_at, t.current_period_end,
             t.cancel_at_period_end, t.plan, t.seat_count, t.stripe_customer_id
        FROM tenants t WHERE t.id = $1`, [req.session.tenantId]);
    const t = r.rows[0] || {};
    const trialDays = _daysLeft(t.trial_ends_at);
    const periodDays = _daysLeft(t.current_period_end);

    const flashOk  = req.query.msg ? `<div class="flash-ok">${escHTML(req.query.msg)}</div>` : '';
    const flashErr = req.query.err ? `<div class="flash-err">${escHTML(req.query.err)}</div>` : '';
    const notConfigured = !billing.isEnabled() ? `<div class="placeholder">Billing isn't configured on this deployment yet. Set <code>STRIPE_SECRET_KEY</code> + <code>STRIPE_WEBHOOK_SECRET</code> + <code>STRIPE_PRICE_BASE</code> to enable.</div>` : '';

    const portalBtn = t.stripe_customer_id && billing.isEnabled()
      ? `<form method="POST" action="/billing/portal" style="display:inline"><button class="btn btn-secondary" type="submit">Manage payment + cancel</button></form>`
      : '';
    const upgradeBtn = (!t.subscription_status || t.subscription_status === 'trialing' || t.subscription_status === 'past_due' || t.subscription_status === 'canceled')
      ? `<a class="btn btn-primary" href="/billing/upgrade">${t.subscription_status === 'past_due' ? 'Resolve payment' : 'Upgrade now'}</a>`
      : '';

    res.send(_shell('Billing', `
      <h1>Billing</h1>
      <div class="meta">${escHTML(t.name || 'Workspace')}</div>
      ${flashOk}${flashErr}${notConfigured}
      <div class="card">
        <div class="row">
          <div>
            <div class="stat-label">Subscription</div>
            <div class="stat-value">${_statusPill(t.subscription_status)}</div>
          </div>
          ${trialDays != null && t.subscription_status === 'trialing' ? `
            <div>
              <div class="stat-label">Trial ends in</div>
              <div class="stat-value">${trialDays} day${trialDays === 1 ? '' : 's'}</div>
            </div>` : ''}
          ${periodDays != null && t.subscription_status === 'active' ? `
            <div>
              <div class="stat-label">${t.cancel_at_period_end ? 'Ends in' : 'Renews in'}</div>
              <div class="stat-value">${periodDays} day${periodDays === 1 ? '' : 's'}</div>
            </div>` : ''}
          <div>
            <div class="stat-label">Seats</div>
            <div class="stat-value">${escHTML(String(t.seat_count || 1))}</div>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="row">
          <div style="flex:1">
            <strong>Plan.</strong> $299/month for up to 5 users, $99/month per additional user.
            20% off when billed annually. 14-day free trial.
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            ${upgradeBtn}
            ${portalBtn}
          </div>
        </div>
      </div>
    `));
  } catch (e) {
    console.error('[GET /billing]', e);
    res.status(500).send(_shell('Billing', `<h1>Error</h1><p class="flash-err">${escHTML(e.message)}</p>`));
  }
});

// ── GET /billing/upgrade — plan picker → checkout ──────────────────────────
router.get('/billing/upgrade', async (req, res) => {
  if (!req.session?.authenticated || !req.session?.tenantId) return res.redirect('/login');
  if (!billing.isEnabled()) {
    return res.redirect('/billing?err=' + encodeURIComponent('Billing is not configured yet on this deployment.'));
  }
  res.send(_shell('Upgrade', `
    <h1>Upgrade to a paid plan</h1>
    <div class="meta">Continue without interruption when your trial ends.</div>
    <div class="card">
      <div class="stat-label">Plan</div>
      <div class="stat-value" style="margin:6px 0 12px">$299/month <span style="font-size:13px;font-weight:400;color:#888">— up to 5 users, +$99/user beyond</span></div>
      <p style="font-size:13px;color:#444;margin-bottom:14px">Click below to enter payment. Stripe handles the card form; we never see your card number.</p>
      <form method="POST" action="/billing/checkout">
        <button class="btn btn-primary" type="submit">Continue to Stripe Checkout →</button>
      </form>
    </div>
    <div class="card">
      <a href="/billing" style="font-size:13px;color:#888;text-decoration:none">← Back to billing</a>
    </div>
  `));
});

// ── POST /billing/checkout — create Checkout Session ───────────────────────
router.post('/billing/checkout', async (req, res) => {
  if (!req.session?.authenticated || !req.session?.tenantId) return res.redirect('/login');
  try {
    const u = await query('SELECT email, name FROM users WHERE id = $1', [req.session.userId]);
    const email = u.rows[0]?.email;
    const name  = u.rows[0]?.name;
    const seat  = req.session.seatCount || 1;
    const url = await billing.createCheckoutSession(req.session.tenantId, email, name, seat);
    res.redirect(303, url);
  } catch (e) {
    console.error('[POST /billing/checkout]', e);
    res.redirect('/billing?err=' + encodeURIComponent('Could not start checkout: ' + e.message));
  }
});

// ── POST /billing/portal — Stripe Customer Portal ──────────────────────────
router.post('/billing/portal', async (req, res) => {
  if (!req.session?.authenticated || !req.session?.tenantId) return res.redirect('/login');
  try {
    const url = await billing.createPortalSession(req.session.tenantId);
    res.redirect(303, url);
  } catch (e) {
    console.error('[POST /billing/portal]', e);
    res.redirect('/billing?err=' + encodeURIComponent('Could not open portal: ' + e.message));
  }
});

// ── POST /billing/webhook — Stripe → us ────────────────────────────────────
// Mounted with express.raw at the server.js level so we get the raw body
// for signature verification. CSRF middleware exempts `/billing/webhook`
// path prefix.
async function webhookHandler(req, res) {
  const sig = req.headers['stripe-signature'];
  if (!billing.isEnabled()) return res.status(503).send('billing not configured');
  try {
    const event = billing.verifyWebhook(req.body, sig);
    const result = await billing.applyWebhookEvent(event);
    res.json({ received: true, ...result });
  } catch (e) {
    console.error('[stripe webhook]', e.message);
    res.status(400).send('Webhook Error: ' + e.message);
  }
}

module.exports = { router, webhookHandler };
