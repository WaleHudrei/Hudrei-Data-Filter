// ═══════════════════════════════════════════════════════════════════════════
// src/csrf.js — Phase 2 finalization: CSRF protection.
//
// Plan reference (docs/saas-conversion-plan.md, "Cross-cutting → Security"):
//
//     CSRF: add CSRF tokens on state-changing forms (Phase 2).
//
// Background. The 2026-04-21 changelog (note line) explicitly deferred CSRF
// as an "app-wide refactor" since adding tokens to a few routes wouldn't
// meaningfully improve security while ~200 other unprotected POST routes
// existed across the legacy Loki UI + Ocular UI. The architectural
// blocker: every form would need a hidden _csrf input plumbed through it.
//
// Strategy here. Avoid touching individual forms by doing everything in
// middleware + a tiny client-side patch:
//
//   1. Server: every authenticated request gets a csrfToken stored in
//      req.session. On state-changing methods (POST/PUT/PATCH/DELETE), the
//      middleware requires either an `x-csrf-token` header or an `_csrf`
//      form field matching the session token.
//
//   2. Server-rendered HTML pages embed the token in a <meta> tag (the two
//      shells handle this — shared-shell.js + ui/layouts/shell.js).
//
//   3. Client-side csrf-protect.js (loaded by both shells) patches
//      window.fetch to auto-attach the header on non-GET calls and adds a
//      delegated `submit` listener that injects a hidden _csrf input into
//      every non-GET form before it submits.
//
// Threat model + exemptions:
//
//   * Session cookie is SameSite=lax. That blocks cross-site form POSTs
//     from leaking the cookie, so traditional form-CSRF on the auth flow
//     (login, signup, password reset) is already mitigated at the
//     transport level. We exempt those endpoints from the token check
//     because they pre-date a session and therefore can't have a token
//     to compare against.
//
//   * Multipart file uploads (browser <input type=file> forms) are exempt
//     because they don't submit through fetch and the delegated injector
//     can't always intercept them cleanly. SameSite=lax covers them.
//
//   * /health is exempt (probes, no session).
//
//   * /hq/login is exempt for the same reason as /login (pre-session).
//
//   * /webhook/* would be exempt if we ever add Stripe — webhooks come
//     from Stripe's IPs, not a browser, and use signed payloads.
//
// Constant-time comparison on token check so no timing oracle.
// ═══════════════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// AsyncLocalStorage so the shell render layer can pull the current token
// without every caller plumbing it through. Same pattern as db.js's
// tenant-context store. csrfMiddleware wraps the rest of the request in
// runWithToken() so any synchronous-or-async render call inside reaches
// currentToken() and gets the right value.
const _tokenStore = new AsyncLocalStorage();
function currentToken() { return _tokenStore.getStore()?.token || ''; }

// Exact paths exempted from token check. Use req.path (the route part,
// without query string) so a token in the URL doesn't accidentally bypass.
const EXEMPT_PATHS = new Set([
  '/login',
  '/signup',
  '/signup/resend',
  '/signup/plan/checkout',
  '/signup/plan/promo',
  '/forgot-password',
  '/reset-password',
  '/verify-email',         // GET, but defensive
  '/hq/login',
  '/health',
  '/logout',               // logout shouldn't need a token; GET-based already
]);

// Path prefixes that are exempt (webhooks, etc). None today; placeholder for
// when Stripe webhooks land in Phase 3.
const EXEMPT_PREFIXES = [
  '/webhook/',
  '/billing/webhook',
];

function _ensureToken(req) {
  if (!req.session) return null;
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  }
  return req.session.csrfToken;
}

function _constantTimeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  // crypto.timingSafeEqual requires equal-length buffers. If lengths
  // differ we still want a fixed-cost compare so the failure path's
  // timing doesn't leak the actual length.
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    // Hash-then-compare so the path is constant-time even on mismatch.
    const aH = crypto.createHash('sha256').update(aBuf).digest();
    const bH = crypto.createHash('sha256').update(bBuf).digest();
    return crypto.timingSafeEqual(aH, bH) && false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

/**
 * The Express middleware. Mount AFTER session middleware (so req.session
 * exists) and BEFORE any route handlers (so the token check runs first).
 * Every response gets a `res.locals.csrfToken` set so render helpers can
 * embed it in HTML.
 */
function csrfMiddleware(req, res, next) {
  // Make sure the token exists for every authenticated session — later
  // calls (incl. GETs) will read it.
  const token = _ensureToken(req);
  res.locals = res.locals || {};
  res.locals.csrfToken = token || '';

  // Push into ALS so the shell render layer can pull the token via
  // currentToken() without every caller plumbing res.locals through.
  // Every early-return path below uses wrappedNext() instead of next()
  // so a GET that renders a page reads the right token from ALS.
  const wrappedNext = () => _tokenStore.run({ token: token || '' }, next);

  // Safe methods bypass the check. State-changing methods need the token.
  if (SAFE_METHODS.has(req.method)) return wrappedNext();

  // Path-based exemptions for endpoints that legitimately can't carry a token.
  if (EXEMPT_PATHS.has(req.path)) return wrappedNext();
  for (const prefix of EXEMPT_PREFIXES) {
    if (req.path.startsWith(prefix)) return wrappedNext();
  }

  // Multipart file uploads — browsers submit them without easy fetch
  // interception. SameSite=lax cookie + the shell's delegated form-injector
  // covers most cases; the rare uncovered ones are file-upload forms with
  // no JS, and we exempt them rather than break the upload UX.
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  if (ct.startsWith('multipart/form-data')) return wrappedNext();

  // Compare token. Header wins (fetch / XHR path), form field is the
  // fallback (legacy form POST path).
  const provided = req.headers['x-csrf-token']
    || (req.body && typeof req.body === 'object' && req.body._csrf);

  if (!token) {
    // No session token means we never set one — likely an unauthenticated
    // POST that isn't on the exempt list. Refuse.
    return res.status(403).json({ error: 'CSRF token missing — open the page in a browser, do not POST directly.' });
  }
  if (!provided || !_constantTimeEquals(String(provided), token)) {
    return res.status(403).json({ error: 'CSRF token missing or invalid. Refresh the page and try again.' });
  }
  wrappedNext();
}

/**
 * Helper for HTML shells — returns the <meta> tag string to embed.
 * Caller passes res.locals.csrfToken (always present after middleware).
 */
function metaTag(token) {
  if (!token) return '';
  // Token is hex (no special chars), but escape defensively.
  const safe = String(token).replace(/[^a-zA-Z0-9]/g, '');
  return `<meta name="csrf-token" content="${safe}">`;
}

module.exports = { csrfMiddleware, metaTag, currentToken };
