// ═══════════════════════════════════════════════════════════════════════════
// src/billing.js — Phase 3 Stripe billing
//
// Env-gated: every export is a no-op unless STRIPE_SECRET_KEY is set, so
// this ships inert and activates the day you wire the keys.
//
// Required env (when enabling):
//   STRIPE_SECRET_KEY        sk_live_... or sk_test_...
//   STRIPE_WEBHOOK_SECRET    whsec_... — for webhook signature verification
//   STRIPE_PRICE_BASE        price_id of the $299/mo (5-seat) plan (recurring)
//   STRIPE_PRICE_EXTRA_SEAT  price_id of the $99/seat add-on (recurring metered or qty)
//
// The plan structure: customer subscribes once with quantity=1 of the base
// plan, plus quantity = max(0, seat_count - 5) of the extra-seat plan.
// When seat_count crosses 5 we adjust the subscription items.
//
// Trial handling: signup creates the tenant with subscription_status =
// 'trialing' and trial_ends_at = NOW() + 14 days. The /billing/upgrade page
// is the only place that creates the Stripe Customer + Subscription via
// Checkout. Billing access gate (server.js requireAuth chain) enforces:
// during trial → app works; after trial without active sub → forced to
// /billing/upgrade.
// ═══════════════════════════════════════════════════════════════════════════

const { query } = require('./db');

let _stripe = null;
function _client() {
  if (_stripe) return _stripe;
  if (!process.env.STRIPE_SECRET_KEY) return null;
  try {
    const Stripe = require('stripe');
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
    return _stripe;
  } catch (e) {
    console.error('[billing] stripe init failed:', e.message);
    return null;
  }
}

function isEnabled() { return !!process.env.STRIPE_SECRET_KEY; }

/**
 * Ensure a Stripe Customer exists for this tenant. Idempotent — looks up
 * tenants.stripe_customer_id first; if missing, creates one and persists.
 */
async function ensureCustomer(tenantId, email, name) {
  const stripe = _client();
  if (!stripe) throw new Error('billing: STRIPE_SECRET_KEY not set');
  const r = await query('SELECT stripe_customer_id, name FROM tenants WHERE id = $1', [tenantId]);
  if (!r.rows.length) throw new Error('tenant not found');
  if (r.rows[0].stripe_customer_id) return r.rows[0].stripe_customer_id;
  const customer = await stripe.customers.create({
    email,
    name: name || r.rows[0].name,
    metadata: { tenant_id: String(tenantId) },
  });
  await query('UPDATE tenants SET stripe_customer_id = $1 WHERE id = $2', [customer.id, tenantId]);
  return customer.id;
}

/**
 * Create a Checkout Session for new subscription. seatCount=1 for v1 signup;
 * /admin can adjust later via Phase 4 invite flow.
 */
async function createCheckoutSession(tenantId, email, name, seatCount = 1) {
  const stripe = _client();
  if (!stripe) throw new Error('billing: STRIPE_SECRET_KEY not set');
  const customerId = await ensureCustomer(tenantId, email, name);
  const priceBase  = process.env.STRIPE_PRICE_BASE;
  const priceExtra = process.env.STRIPE_PRICE_EXTRA_SEAT;
  if (!priceBase) throw new Error('STRIPE_PRICE_BASE not set');
  const items = [{ price: priceBase, quantity: 1 }];
  const extra = Math.max(0, Number(seatCount || 1) - 5);
  if (extra > 0 && priceExtra) items.push({ price: priceExtra, quantity: extra });

  const baseUrl = process.env.APP_BASE_URL || 'http://localhost:3000';
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: items,
    allow_promotion_codes: true,
    success_url: `${baseUrl}/billing?msg=Subscription+active`,
    cancel_url:  `${baseUrl}/billing/upgrade?msg=Cancelled`,
    metadata: { tenant_id: String(tenantId) },
    subscription_data: { metadata: { tenant_id: String(tenantId) } },
  });
  return session.url;
}

/**
 * Create a Customer-Portal session — Stripe-hosted "manage your card / cancel"
 * page. Returns redirect URL.
 */
async function createPortalSession(tenantId) {
  const stripe = _client();
  if (!stripe) throw new Error('billing: STRIPE_SECRET_KEY not set');
  const r = await query('SELECT stripe_customer_id FROM tenants WHERE id = $1', [tenantId]);
  if (!r.rows.length || !r.rows[0].stripe_customer_id) throw new Error('no stripe customer');
  const baseUrl = process.env.APP_BASE_URL || 'http://localhost:3000';
  const portal = await stripe.billingPortal.sessions.create({
    customer: r.rows[0].stripe_customer_id,
    return_url: `${baseUrl}/billing`,
  });
  return portal.url;
}

/**
 * Verify Stripe webhook signature against the raw body. Throws on mismatch.
 * Returns the parsed event.
 */
function verifyWebhook(rawBody, signature) {
  const stripe = _client();
  if (!stripe) throw new Error('billing: STRIPE_SECRET_KEY not set');
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET not set');
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}

/**
 * Apply a Stripe webhook event to our DB. Handles the five events the plan
 * lists. Idempotent on each — re-delivering the same event produces the
 * same row state.
 */
async function applyWebhookEvent(event) {
  const obj = event && event.data && event.data.object;
  if (!obj) return { ignored: true };

  // Resolve tenant_id either from metadata (preferred) or via stripe_customer_id.
  async function resolveTenantId() {
    const md = obj.metadata && obj.metadata.tenant_id;
    if (md && /^\d+$/.test(md)) return parseInt(md, 10);
    const customerId = obj.customer || (obj.subscription && obj.subscription.customer);
    if (!customerId) return null;
    const r = await query('SELECT id FROM tenants WHERE stripe_customer_id = $1', [customerId]);
    return r.rows[0]?.id || null;
  }

  switch (event.type) {
    case 'checkout.session.completed':
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const tenantId = await resolveTenantId();
      if (!tenantId) return { ignored: 'no tenant' };
      // For checkout.session.completed obj.subscription is an id; for
      // customer.subscription.* the obj is the subscription itself.
      const sub = (event.type === 'checkout.session.completed')
        ? null
        : obj;
      const subId = sub ? sub.id : (obj.subscription || null);
      const status = sub ? sub.status : null;
      const cancel = sub ? !!sub.cancel_at_period_end : null;
      const periodEnd = sub && sub.current_period_end
        ? new Date(sub.current_period_end * 1000).toISOString()
        : null;
      await query(`
        UPDATE tenants SET
          stripe_subscription_id = COALESCE($2, stripe_subscription_id),
          subscription_status    = COALESCE($3, subscription_status),
          cancel_at_period_end   = COALESCE($4, cancel_at_period_end),
          current_period_end     = COALESCE($5::timestamptz, current_period_end),
          updated_at = NOW()
        WHERE id = $1
      `, [tenantId, subId, status, cancel, periodEnd]);
      return { ok: true, tenantId, status };
    }
    case 'customer.subscription.deleted': {
      const tenantId = await resolveTenantId();
      if (!tenantId) return { ignored: 'no tenant' };
      await query(`
        UPDATE tenants SET subscription_status = 'canceled', updated_at = NOW()
         WHERE id = $1
      `, [tenantId]);
      return { ok: true, tenantId };
    }
    case 'invoice.payment_failed': {
      const tenantId = await resolveTenantId();
      if (!tenantId) return { ignored: 'no tenant' };
      await query(`
        UPDATE tenants SET subscription_status = 'past_due', updated_at = NOW()
         WHERE id = $1
      `, [tenantId]);
      return { ok: true, tenantId };
    }
    case 'invoice.payment_succeeded': {
      const tenantId = await resolveTenantId();
      if (!tenantId) return { ignored: 'no tenant' };
      await query(`
        UPDATE tenants SET subscription_status = 'active', updated_at = NOW()
         WHERE id = $1
      `, [tenantId]);
      return { ok: true, tenantId };
    }
    default:
      return { ignored: event.type };
  }
}

/**
 * Returns true if a tenant has access to the app right now (trialing or
 * active). Used by the access-gating middleware in server.js.
 */
async function hasActiveAccess(tenantId) {
  // If billing isn't even wired up yet, everyone has access — this
  // module is fully optional.
  if (!isEnabled()) return true;
  const r = await query(
    `SELECT subscription_status, trial_ends_at FROM tenants WHERE id = $1`,
    [tenantId]
  );
  if (!r.rows.length) return false;
  const t = r.rows[0];
  // tenants that signed up before billing existed have NULL — grandfathered.
  if (!t.subscription_status) return true;
  if (t.subscription_status === 'active') return true;
  if (t.subscription_status === 'trialing') {
    if (!t.trial_ends_at) return true;
    return new Date(t.trial_ends_at) > new Date();
  }
  return false;
}

module.exports = {
  isEnabled,
  ensureCustomer,
  createCheckoutSession,
  createPortalSession,
  verifyWebhook,
  applyWebhookEvent,
  hasActiveAccess,
};
