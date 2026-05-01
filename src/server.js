const { query: dbQuery, initSchema, runWithTenant } = require('./db');
const campaigns = require('./campaigns');
const changelogModule = require('./changelog');
const uploadRoutes = require('./routes/upload-routes');
const uploadUI = require('./ui/upload');
const express = require('express');
const { bufferToCsvText, stripBom } = require('./csv-utils');
const session = require('express-session');
const multer = require('multer');
const Papa = require('papaparse');
const Redis = require('ioredis');
const { normalizeState } = require('./import/state');
const { normalizePhone } = require('./phone-normalize');

// 2026-05-01 Phase 2 finalization — observability. Both modules are
// env-gated: errorMonitor activates only when SENTRY_DSN is set; backup
// activates only when BACKUP_S3_BUCKET is set. Without those env vars,
// init/scheduleBackups are no-ops and no AWS/Sentry SDK code runs.
// Initialized as early as possible so errors during the rest of the boot
// path get captured.
const errorMonitor = require('./error-monitor');
errorMonitor.init();
const backup = require('./backup');

const app = express();
// 2026-04-18 audit fix #21: previously multer accepted any file up to 50MB
// with no type check. Client-side had `.endsWith('.csv')` but a hostile or
// confused caller could POST any bytes. xlsx files would silently fail in
// Papaparse (returning 0 rows with no explanation — wasted operator time).
// Now rejects anything that isn't a CSV/TXT by extension or MIME type.
const csvFileFilter = (req, file, cb) => {
  const name = String(file.originalname || '').toLowerCase();
  const okExt = /\.(csv|txt)$/.test(name);
  const okMime = ['text/csv', 'text/plain', 'application/csv', 'application/vnd.ms-excel',
                  'application/octet-stream'].includes(String(file.mimetype || '').toLowerCase());
  if (okExt || okMime) return cb(null, true);
  cb(new Error('Only CSV files are accepted. Convert xlsx/xls to CSV before uploading.'));
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: csvFileFilter,
});

// 2026-04-28 audit fix S-4: generate a short correlation id for error
// responses. Lets the user share the id with support without us having to
// leak Postgres error codes / details / stack traces / column values back
// in the HTTP response body. Server-side log keeps the full picture.
function errRefId() {
  return 'err_' + Math.random().toString(36).slice(2, 10);
}

// 2026-04-29 audit fix K6: escape user-controlled content before HTML
// interpolation. Reflected XSS via `?msg=<script>` was possible in pages
// (e.g. nisPage) that rendered req.query.msg into a flash banner without
// escaping. Mirrors the helper in records-routes.js / auth-routes.js so
// every old-Loki shell page has access to it.
function escHTML(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

const APP_USERNAME   = process.env.APP_USERNAME   || 'hudrei';
const APP_PASSWORD   = process.env.APP_PASSWORD   || 'changeme123';
// 2026-04-28 audit fix S-7: drop the hardcoded fallback for SESSION_SECRET.
// The previous prod-only guard let preview/non-production deploys silently
// ship a known secret, allowing session cookie forgery anywhere NODE_ENV
// wasn't explicitly 'production'. Now: missing env var fails hard at boot,
// regardless of environment. Set SESSION_SECRET in your shell for local dev
// (any 32+ char random string is fine).
if (!process.env.SESSION_SECRET) {
  throw new Error(`SESSION_SECRET env var is required. Generate one with: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`);
}
const SESSION_SECRET = process.env.SESSION_SECRET;
const PORT           = process.env.PORT           || 3000;
const REDIS_URL      = process.env.REDIS_URL      || null;
const MEMORY_KEY     = 'hudrei:filtration:memory';
const IS_PROD        = process.env.NODE_ENV === 'production';

// ── Production hardening checks (Audit #32 / security) ────────────────────────
// 2026-04-29 audit fix M5: drop the IS_PROD gate, mirroring S-7's pattern.
// Pre-fix the guard only fired when NODE_ENV === 'production'. Preview /
// staging / non-prod deploys missing that env var would silently ship with
// the baked-in default credential 'changeme123' — same trap S-7 closed for
// SESSION_SECRET. Fail hard at boot regardless of environment.
if (APP_PASSWORD === 'changeme123') {
  throw new Error('Refusing to start with default APP_PASSWORD. Set APP_PASSWORD env var on Railway (any 16+ char random string is fine for the legacy single-user gate).');
}

let redis = null;
if (REDIS_URL) {
  // 2026-04-29 audit fix L5: matches the records-routes + auth-routes Redis
  // clients (both already at 2). Pre-fix this one was 3, the others 2 —
  // inconsistent retry budget across modules. Picked 2 because a flaky Redis
  // adds 3× round-trip latency to every session lookup, and 2 retries is
  // already plenty before falling back to the per-process Map / MemoryStore.
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 });
  redis.on('connect', () => console.log('Redis connected'));
  redis.on('error', (e) => console.error('Redis error:', e.message));
}

async function loadMemory() {
  if (!redis) return {};
  try { const raw = await redis.get(MEMORY_KEY); return raw ? JSON.parse(raw) : {}; }
  catch (e) { console.error('loadMemory:', e.message); return {}; }
}
async function saveMemory(memory) {
  if (!redis) return;
  try { await redis.set(MEMORY_KEY, JSON.stringify(memory)); }
  catch (e) { console.error('saveMemory:', e.message); }
}
async function clearMemory() {
  if (!redis) return;
  try { await redis.del(MEMORY_KEY); } catch (e) { console.error(e.message); }
}

// Behind Railway + Fastly (CDN) — the full chain is
// Client → Fastly edge → Railway internal LB → Node.
//
// 2026-04-29 audit follow-up: `trust proxy: 1` (the previous value) only
// trusted ONE upstream hop, so Express's req.ip was the Railway internal LB
// address — which rotates per-request across LB instances. Result: every
// rate-limited POST hit a fresh bucket and the limiter never fired. Verified
// by stress test: 30 quick /signup POSTs all returned 302 redirects (route
// handler ran), 0 returned 429 (limiter never engaged). Same effect on
// /login (Redis-backed) — even a stable shared store can't dedupe if the
// "client IP" is different per request.
//
// Setting `trust proxy: true` tells Express to use the LEFTMOST X-Forwarded-For
// entry (the original client IP) regardless of how many proxies are in the
// chain. This is the standard Railway+CDN configuration and is safe ONLY
// because both Fastly and Railway strip any client-supplied X-Forwarded-For
// before forwarding (preventing IP spoofing). Required for:
//   - cookie.secure = true to not drop cookies on HTTPS-terminated proxies
//   - req.ip to identify the actual client (rate limiters key off this)
app.set('trust proxy', true);

// 2026-05-01 audit fix QW#6: gzip/brotli compression. The HTML pages
// (Records list, Activity log, Dashboard) easily hit 100KB+ uncompressed;
// JSON responses (export, /api/dashboard-stats) compress 70-90%. Cloudflare
// in front compresses outbound, but the Railway-internal hop between
// Cloudflare and the Node process is uncompressed without this — wasted
// bandwidth and slower TTFB on big payloads. threshold:1024 skips
// compression on tiny responses where overhead exceeds savings.
const compression = require('compression');
app.use(compression({ threshold: 1024 }));

// 2026-05-01 Phase 2 finalization — Sentry request scope. Attaches
// tenant_id + user_id tags to any error reported during this request,
// so errors group by tenant in the Sentry dashboard. No-op when
// SENTRY_DSN isn't set; cheap (one boolean check) when it is.
app.use(errorMonitor.requestHandler());

// 2026-04-29 audit fix L7 + L8: minimal security-headers middleware.
// Equivalent to a stripped-down `helmet()` — picked the headers that matter
// for an internal CRM behind Cloudflare/Railway TLS termination, skipped the
// ones that don't apply (CSP would break inline-style HTML, expectCt is
// deprecated, crossOriginResourcePolicy is overkill for same-origin).
// Adding these inline avoids pulling helmet as a new dependency (which would
// require a package-lock.json update — risky for Railway's `npm ci` build).
//
//   - HSTS:           force HTTPS for 6mo, include subdomains. Only set in
//                     production — local dev over http would otherwise pin.
//   - X-Frame-Options: prevent click-jacking via iframe embedding.
//   - X-Content-Type-Options: prevent MIME sniffing.
//   - Referrer-Policy: don't leak full URL on cross-origin nav.
app.use((req, res, next) => {
  if (IS_PROD) {
    res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  res.set('X-Frame-Options', 'DENY');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// 2026-04-29 audit fix H1 + M3: tighten the global body-parser limits.
// Pre-fix:
//   - urlencoded was registered TWICE (lines 95 and 97 of the old layout):
//     once with default 100KB, once with 50MB. The first registration's 100KB
//     limit fired before the 50MB one ever got a chance, so the documented
//     50MB ceiling was misleading dead syntax. (Audit M3.)
//   - express.json's 50MB limit applied to EVERY route. 100 abusive clients
//     × 50MB JSON to /login = 5GB of buffered request bodies on Railway's
//     8GB worker. (Audit H1.)
// File uploads go through multer (server.js's 50MB CSV limit and
// import/bulk-import-routes.js's 600MB), not these body parsers — multer
// handles multipart/form-data independently. The only routes that send
// non-trivial JSON bodies (e.g. /import/property/commit) post a mapping
// object + a few flags, well under 1MB.
// 2026-05-01 Phase 3 — Stripe webhook needs the RAW body to verify the
// signature, so it MUST be mounted BEFORE express.json() which would
// consume + JSON.parse the request body. The raw-body middleware here
// only fires for the exact webhook path; everything else flows through
// express.json/urlencoded normally.
const _billingRoutes = require('./billing-routes');
app.post('/billing/webhook',
  express.raw({ type: 'application/json', limit: '1mb' }),
  _billingRoutes.webhookHandler
);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ── Session store (Audit #6) ──────────────────────────────────────────────────
// In-memory MemoryStore is Express's default — it's unsafe for production:
//   (a) every deploy wipes all user sessions → users forced to re-login,
//   (b) it leaks memory over time (no TTL cleanup),
//   (c) it stores session data in the Node heap which fights with the
//       50 MB importRows payloads used by the property importer.
// When REDIS_URL is set we use connect-redis to persist sessions to the
// same Redis instance used for the filtration memory cache. When not set
// (local dev), we fall back to MemoryStore with a loud warning.
let sessionStore;
if (REDIS_URL) {
  try {
    // connect-redis v7+ exports { RedisStore } (named), but earlier 7.x
    // minor versions and all of v6 export the class as the default export.
    // Also some bundlers expose it as .default. Try all three shapes.
    const mod = require('connect-redis');
    const RedisStore =
      (mod && mod.RedisStore) ||
      (typeof mod === 'function' ? mod : null) ||
      (mod && mod.default && (mod.default.RedisStore || mod.default));

    if (typeof RedisStore !== 'function') {
      throw new Error('RedisStore export not found in connect-redis module. Got keys: ' + Object.keys(mod || {}).join(','));
    }
    sessionStore = new RedisStore({ client: redis, prefix: 'loki:sess:' });
    console.log('Session store: Redis');
  } catch (e) {
    console.error('connect-redis failed to initialize — falling back to MemoryStore.', e.message);
    sessionStore = undefined;
  }
} else if (IS_PROD) {
  console.warn('[warn] Production with no REDIS_URL — using MemoryStore. Sessions will not survive deploys.');
}

app.use(session({
  store: sessionStore,
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: IS_PROD,     // HTTPS-only cookies in production (trust proxy above enables this over Railway's TLS termination)
    httpOnly: true,      // JS can't read the cookie
    sameSite: 'lax',     // protects against CSRF while still allowing top-level nav
    maxAge: 8 * 60 * 60 * 1000,
  },
}));

// Serve static files (client JS, CSS, images) from /public
const path = require('path');
app.use(express.static(path.join(__dirname, 'public')));

// 2026-05-01 Phase 2 finalization — /health endpoint for UptimeRobot /
// Railway / BetterStack probes. Mounted BEFORE the tenant-status gate so
// uptime checks don't pay any auth/DB overhead. Returns 200 with a minimal
// JSON payload + `Cache-Control: no-store` so probers get fresh state.
//
// This is intentionally a liveness probe (does the process accept HTTP?),
// not a deep readiness probe (is the DB reachable? is Redis up?). Adding
// a DB ping turns a probe failure into a cascading "everything is down"
// signal when only Postgres is briefly unreachable. Liveness is what the
// uptime monitor actually wants to alert on.
app.get('/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, ts: Date.now() });
});

// 2026-05-01 Phase 2 finalization — CSRF protection. Mounted after session
// (so req.session exists) and BEFORE tenant-status / RLS / routes. On
// state-changing methods (POST/PUT/PATCH/DELETE) it requires either an
// `x-csrf-token` header (fetch / XHR path) or an `_csrf` form field
// matching the session-stored token. Public auth endpoints (/login,
// /signup, /forgot-password, /reset-password, /hq/login, /health) are
// exempt — they pre-date a session. Multipart uploads are exempt because
// SameSite=lax on the session cookie covers them at the transport level.
//
// The matching client-side patch lives at /js/csrf-protect.js (loaded by
// the Ocular shell) — it auto-attaches the header to every fetch() and
// auto-injects a hidden _csrf input into every POST form. So the legacy
// Loki UI's ~200 forms didn't have to be modified individually.
const { csrfMiddleware } = require('./csrf');
app.use(csrfMiddleware);

// 2026-05-01 Phase 2 finalization — global tenant-status gate. Runs after
// static so /oculah-static/* + /public/* don't pay the check, but BEFORE
// every router (auth, ocular, records, owners, lists, imports, admin, hq).
// The 11 per-router requireAuth functions only validated session +
// tenantId — never re-checked the tenant's `status`. So a tenant suspended
// from /admin kept working until cookie expiry. This middleware closes
// that gap exactly once per request, with a 60s in-memory cache to keep
// the per-request cost effectively zero.
app.use(async (req, res, next) => {
  // Unauthenticated requests fall straight through (login, signup,
  // verify-email, marketing landing, etc.).
  if (!req.session || !req.session.authenticated || !req.session.tenantId) {
    return next();
  }
  // Super-admin sessions (HQ portal) carry tenantId of the tenant they're
  // viewing — but the super-admin's authority isn't gated by that tenant's
  // status. Skip the gate when the session is the dedicated HQ portal one.
  if (req.session.superAdmin === true) return next();

  try {
    const active = await _checkTenantActive(req.session.tenantId);
    if (!active) {
      return req.session.destroy(() => {
        // For JSON / fetch callers, return 401 instead of redirect so the
        // client-side error handler shows a sensible toast rather than
        // tripping a CORS preflight on the redirect target.
        const wantsJson = req.headers.accept && req.headers.accept.includes('application/json');
        if (wantsJson) return res.status(401).json({ error: 'Workspace inactive — please log in again.' });
        res.redirect('/login?msg=' + encodeURIComponent('Your workspace is inactive. Please log in again.'));
      });
    }
    next();
  } catch (e) {
    // Don't fail-closed on a DB hiccup. _checkTenantActive already catches
    // and returns true on error; this catch is the belt-and-suspenders layer.
    console.error('[tenant-status-gate]', e.message);
    next();
  }
});

// 2026-05-01 Phase 1 closure — RLS context middleware. Pushes the
// authenticated user's tenantId into AsyncLocalStorage for the rest of the
// request. db.js's query() then wraps every DB call in BEGIN/SET LOCAL
// app.tenant_id/COMMIT, and the RLS policies on every tenant-owned table
// enforce isolation. Super-admin (HQ portal) sessions explicitly bypass
// so /admin can see across tenants. Unauthenticated requests don't push
// either — they hit RLS-bypass paths (login, signup, verify-email,
// landing).
app.use((req, res, next) => {
  // Super-admin / unauthenticated → no tenant context, RLS short-circuits
  // to "all rows visible" (admin/HQ ops + boot/scheduler paths).
  if (!req.session || !req.session.authenticated || !req.session.tenantId
      || req.session.superAdmin === true) {
    return next();
  }
  // runWithTenant returns the result of next() — but Express middleware
  // expects us to call next() and return undefined. So we ignore the
  // return value; the AsyncLocalStorage context flows through next()'s
  // synchronous call and into all the async work that follows it.
  runWithTenant(req.session.tenantId, () => next());
});

// 2026-05-01 Phase 3 — Stripe billing access gate. Authenticated tenant
// requests whose subscription_status is past_due / canceled / null (and
// not legacy-grandfathered) get redirected to /billing/upgrade. Trialing
// + active pass through. Super-admin sessions and unauthenticated paths
// bypass entirely. Billing routes themselves bypass so users can always
// reach /billing to fix payment. /logout bypasses so the dead-end state
// is exit-able.
const _billing = require('./billing');
const _BILLING_BYPASS = ['/billing', '/logout', '/login'];
app.use(async (req, res, next) => {
  if (!req.session?.authenticated || !req.session?.tenantId) return next();
  if (req.session.superAdmin === true) return next();
  if (_BILLING_BYPASS.some(p => req.path === p || req.path.startsWith(p + '/'))) return next();
  try {
    const ok = await _billing.hasActiveAccess(req.session.tenantId);
    if (ok) return next();
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return res.status(402).json({ error: 'Subscription required', billingUrl: '/billing/upgrade' });
    }
    res.redirect('/billing/upgrade?msg=' + encodeURIComponent('Trial ended — please continue with a paid plan to keep using Oculah.'));
  } catch (e) {
    console.error('[billing-gate]', e.message);
    next();   // fail-open on error so a billing-table hiccup doesn't lock everyone out
  }
});

// 2026-04-29 audit fix H2: proactive 503 when the pg pool is saturated.
// Pre-fix, requests beyond the pool's cap silently waited up to 5s
// (`connectionTimeoutMillis`) and then erupted as generic 500s. Under load
// this looked like sporadic "internal server error" with no obvious cause.
// Now: if 5+ requests are already queued for a connection, every new request
// gets 503 + Retry-After immediately. In-flight queries finish without being
// slowed by waiters; clients (browsers, dialer scripts) honour Retry-After
// and back off. We avoid hitting the static routes by mounting after
// express.static. (Pool cap is currently max: 50 — see db.js.)
const { pool: _pgPool } = require('./db');
const POOL_SATURATION_THRESHOLD = 5;
app.use((req, res, next) => {
  if (_pgPool.waitingCount >= POOL_SATURATION_THRESHOLD) {
    res.set('Retry-After', '5');
    res.status(503);
    // Send JSON for API/POST callers, HTML for browser GETs.
    if (req.accepts('html') && req.method === 'GET') {
      return res.send('<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:600px;margin:80px auto;padding:0 24px;text-align:center"><h1>Server busy</h1><p>The server is temporarily at capacity. Please retry in a few seconds.</p></body></html>');
    }
    return res.json({ error: 'Server is at capacity. Please retry in a few seconds.' });
  }
  next();
});

// expose helpers to upload router
app.locals.processCSV = processCSV;
app.locals.loadMemory = loadMemory;
app.locals.saveMemory = saveMemory;
app.locals.saveRunToDB = saveRunToDB;

// mount upload routes
app.use('/upload', uploadRoutes);
// Old records routes replaced by phase 2 slice 1 — registered at bottom of file
// app.use('/records', recordsRoutes);

// Phase 2 — public auth routes (signup + verify-email; login replacement
// arrives in 2c). Mounted at root so /signup, /verify-email work directly.
const authRoutes = require('./auth-routes');
app.use('/', authRoutes);

// Phase 2 / RBAC: dedicated HQ login portal (separate from tenant auth).
// Operators authenticate against HQ_USERNAME / HQ_PASSWORD env vars and the
// session carries `superAdmin:true` which the /admin/* console accepts.
const hqRoutes = require('./auth/hq-routes');
app.use('/', hqRoutes);

// 2026-05-01 Phase 2 finalization — tenant status gate.
// Plan + adversarial audit (Section 11 CRITICAL) called this out: when an
// /admin operator suspends a tenant, the tenant's already-logged-in users
// keep working until their session cookie expires (8h). Pre-fix the only
// `status` check happened at POST /login, never per-request. Now: every
// authed request re-checks `tenants.status`, with a 60-second in-memory
// cache to amortize the lookup so we don't pay one DB round-trip per
// request. Suspended/canceled tenants get their session destroyed and
// redirected to /login. New /admin status flips show within 60s.
const _tenantStatusCache = new Map();   // tenantId -> { status, t }
const TENANT_STATUS_TTL_MS = 60_000;
async function _checkTenantActive(tenantId) {
  const now = Date.now();
  const cached = _tenantStatusCache.get(tenantId);
  if (cached && (now - cached.t) < TENANT_STATUS_TTL_MS) {
    return cached.status === 'active';
  }
  try {
    const r = await dbQuery('SELECT status FROM tenants WHERE id = $1', [tenantId]);
    const status = r.rows[0]?.status || null;
    _tenantStatusCache.set(tenantId, { status, t: now });
    // Cap the map at ~1000 entries (well above any realistic tenant count
    // for v1) so a long-running process can't grow it unbounded.
    if (_tenantStatusCache.size > 1000) {
      const oldest = _tenantStatusCache.keys().next().value;
      _tenantStatusCache.delete(oldest);
    }
    return status === 'active';
  } catch (e) {
    // Don't fail-closed on a DB hiccup — log and let the request through.
    // Worst case: a suspended tenant gets one extra request through during
    // a transient DB outage. Better than a tenant-wide outage on top of a
    // DB outage.
    console.error('[requireAuth] tenant status check failed (allowing through):', e.message);
    return true;
  }
}

async function requireAuth(req, res, next) {
  if (!req.session || !req.session.authenticated) return res.redirect('/login');
  // Sessions created before Phase 1 don't carry tenant context. Bounce them
  // to /login so they re-authenticate and pick up tenantId/userId/role.
  if (!req.session.tenantId) return res.redirect('/login');

  const active = await _checkTenantActive(req.session.tenantId);
  if (!active) {
    // Tenant got suspended/canceled while this user was logged in. Destroy
    // the session and bounce to /login. Returning a generic /login redirect
    // (rather than a "your tenant is suspended" page) avoids leaking
    // workspace status to anyone who just lost access.
    req.session.destroy(() => res.redirect('/login'));
    return;
  }

  req.tenantId = req.session.tenantId;
  req.userId = req.session.userId;
  req.role = req.session.role;
  next();
}

// Phase 2: Records + Setup + Lists + Import routes
const slice1Records = require('./records/records-routes');
const setupRoutes = require('./records/setup-routes');
const listsRoutes = require('./lists/lists-routes');
const importRoutes = require('./import/property-import-routes');
const bulkImportRoutes = require('./import/bulk-import-routes');
const activityRoutes = require('./activity-routes');
// 2026-04-21 Feature 5: owner dashboard routes (/owners/:id)
const ownersRoutes = require('./owners/owners-routes');
const listTypesRoutes = require('./lists/list-types-routes');
const ocularRoutes = require('./ui/ocular-routes');
// 2026-04-28 SaaS super-admin console at /admin/* — gated by SUPER_ADMIN_EMAIL
// env var, separate chrome from the Ocular tenant UI.
const adminRoutes = require('./admin/admin-routes');


const COL = { phone:'Phone', dispo:'Log Type', listname:'Original lead file', date:'Log Time', fname:'First Name', lname:'Last Name', addr:'Address', city:'City', state:'State', zip:'Zip Code', notes:'Call Notes' };

// Auto-detect column names from file headers (handles both Readymode call log and list progress exports)
function detectCols(headers) {
  const h = headers.map(x => x.toLowerCase().trim());
  const find = (options) => {
    for (const opt of options) {
      const idx = h.findIndex(x => x === opt.toLowerCase() || x.includes(opt.toLowerCase()));
      if (idx > -1) return headers[idx];
    }
    return null;
  };
  return {
    phone:    find(['phone']),
    dispo:    find(['log type', 'logtype', 'last dispo', 'lastdispo', 'disposition', 'status']),
    listname: find(['original lead file', 'lead file campaign', 'batch name', 'original file name', 'list name', 'campaign']),
    date:     find(['log time', 'logtime', 'status (time)', 'upload date', 'date']),
    fname:    find(['first name', 'firstname']),
    lname:    find(['last name', 'lastname']),
    addr:     find(['address']),
    city:     find(['city']),
    state:    find(['state']),
    zip:      find(['zip code', 'zip']),
    notes:    find(['call notes', 'notes']),
  };
}

// 2026-05-01 (5E): delegated to the canonical normalizer in
// src/disposition-normalize.js so 'not_interested' / 'not interested' /
// 'Not Interested' all reduce to the same bucket app-wide. Local function
// kept as a thin alias because dozens of in-file call sites reference it.
//
// Note: the legacy bucket name 'dead_call' is preserved for downstream
// thresholds that check `dispo === 'dead_call'`. The new helper's canonical
// name is 'dead_number'; we map back here so server-side state machines
// don't have to change in this commit.
const { normalizeDisposition } = require('./disposition-normalize');
function normDispo(v) {
  const out = normalizeDisposition(v);
  return out === 'dead_number' ? 'dead_call' : out;
}
function phoneStatus(d) { return {transfer:'Correct',potential_lead:'Correct',sold:'Correct',listed:'Correct',not_interested:'Correct',do_not_call:'Correct',spanish_speaker:'Correct',wrong_number:'Wrong',callback:'Correct',disqualified:'Correct',completed:'Correct',hung_up:'Tentative'}[d]||''; }
function mktResult(d,l) {
  // 2026-04-18 audit fix: previously `do_not_call` mapped to `Not Interested — {list}`
  // (copy-paste bug — DNC and NI are compliance-distinct outcomes that must not
  // collapse to the same value in marketing_result). Also added explicit rows for
  // potential_lead / sold / listed so cold-call and SMS pipelines produce the
  // same filter-dropdown vocabulary. Previously these were only ever written by
  // the SMS flow, making the "Sold"/"Listed"/"Potential Lead" filter values
  // silently unreachable for cold-call-sourced leads.
  if(d==='transfer')         return 'Lead';
  if(d==='potential_lead')   return 'Potential Lead';
  if(d==='sold')             return 'Sold';
  if(d==='listed')           return 'Listed';
  if(d==='not_interested')   return `Not Interested — ${l}`;
  if(d==='do_not_call')      return `Do Not Call — ${l}`;
  if(d==='spanish_speaker')  return 'Spanish Speaker';
  return '';
}
function phoneTag(d,count,l) {
  const M={voicemail:'Voicemail',hung_up:'Hung Up',dead_call:'Dead Call',not_available:'Not Available'};
  if(d==='do_not_call') return 'Do Not Call';
  if(M[d]) return count>3?`${M[d]} — ${l}`:'';
  if(d==='not_interested') return count>=3?`Not Interested — ${l}`:'';
  return '';
}
function stripTime(val) {
  if(!val) return '';
  const s=String(val).trim();
  const m=s.match(/^(\d{2}\/\d{2}\/\d{4})/);
  if(m){const p=m[0].split('/');return `${p[2]}-${p[0]}-${p[1]}`;}
  const m2=s.match(/^(\d{4}-\d{2}-\d{2})/);
  if(m2) return m2[0];
  const d=new Date(s);if(!isNaN(d)) return d.toISOString().split('T')[0];
  return s.split(' ')[0];
}
function memKey(list,phone,campaignId){
  // 2026-04-18 audit fix #9: previously fell back to list-name scoping when
  // campaignId was missing. Two different campaigns with the same list name
  // (e.g. both using "Tax Delinquent IN") would share filtration memory —
  // a DNC count from Campaign A would retroactively filter rows in Campaign B.
  // Now we REQUIRE campaignId. Callers must supply it; undefined/null throws.
  if (!campaignId) {
    throw new Error('memKey: campaignId is required. List-name-only scoping was causing cross-campaign data leaks.');
  }
  const scope = 'campaign:'+campaignId;
  return scope+'||'+String(phone).replace(/\D/g,'');
}
// Global keys — shared across ALL campaigns (wrong numbers, DNC stay permanent)
function globalKey(dispo,phone){
  const p = String(phone).replace(/\D/g,'');
  if(dispo==='wrong_number') return 'wn:'+p;
  if(dispo==='do_not_call')  return 'dnc:'+p;
  return null;
}

function processCSV(csvText, memory, campaignId) {
  const parsed=Papa.parse(csvText,{header:true,skipEmptyLines:true});
  const rows=parsed.data;
  if(!rows.length) throw new Error('File is empty or could not be parsed.');
  const headers = parsed.meta.fields || [];
  const COLS = detectCols(headers);
  // 2026-05-01 audit fix QW#3: use normalizePhone() so memory keys match
  // every other path. Pre-fix this used .replace(/\D/g,'') which preserves
  // a leading 1, so "5551234567" and "15551234567" became different memory
  // keys — the cross-upload 3-strike rule never matched the same number
  // across CSVs that used different phone formats.
  const fileCount={};
  rows.forEach(r=>{
    const phone=normalizePhone(r[COLS.phone]);
    const list=(r[COLS.listname]||'Unknown List').trim();
    if(!phone||phone==='0') return;
    const dRaw=normDispo(r[COLS.dispo]||'');
    // Use global key for WN/DNC so they don't inflate per-campaign counts
    const gk=globalKey(dRaw,phone);
    const k=gk||memKey(list,phone,campaignId);
    fileCount[k]=(fileCount[k]||0)+1;
  });
  const cleanRows=[],filteredRows=[];
  let memCaught=0;
  const listsSeen={},processedKeys={};
  rows.forEach(r=>{
    const phone=normalizePhone(r[COLS.phone]);
    const list=(r[COLS.listname]||'Unknown List').trim();
    const dispoRaw=r[COLS.dispo]||'';
    const dispo=normDispo(dispoRaw);
    const dateRaw=r[COLS.date]||'';
    if(!phone||phone==='0') return;
    // Use global key for wrong_number and DNC — campaign-scoped for everything else
    const gk=globalKey(dispo,phone);
    const mkey=gk||memKey(list,phone,campaignId);
    // Transfers NEVER get deduplicated — always record every transfer
    if(dispo!=='transfer'&&processedKeys[mkey]) return;
    processedKeys[mkey]=true;
    const countInFile=fileCount[mkey]||1;
    const prevMem=memory[mkey]||{count:0,lastDispo:'',dispoCounts:{}};
    const prevCount=prevMem.count||0;
    const prevDispoCounts=prevMem.dispoCounts||{};
    const cumCount=prevCount+countInFile;
    // Update per-disposition counts
    const newDispoCounts={...prevDispoCounts};
    newDispoCounts[dispo]=(newDispoCounts[dispo]||0)+countInFile;
    memory[mkey]={count:cumCount,lastDispo:dispoRaw,dispoCounts:newDispoCounts};
    if(!listsSeen[list]) listsSeen[list]={keep:0,rem:0,dispositions:{}};
    listsSeen[list].dispositions[dispo]=(listsSeen[list].dispositions[dispo]||0)+1;
    // Pull per-dispo counts for rules
    const niCount=newDispoCounts['not_interested']||0;
    const hupCount=newDispoCounts['hung_up']||0;
    const dcCount=newDispoCounts['dead_call']||0;
    const naCount=newDispoCounts['not_available']||0;
    const vmCount=newDispoCounts['voicemail']||0;
    // Reclassification: if hung_up causes removal (alone or via combined NI bucket), reclassify as NI
    let effectiveDispo=dispo;
    let tag=phoneTag(dispo,cumCount,list);
    let status=phoneStatus(dispo);
    let mkt=mktResult(dispo,list);
    const dateClean=stripTime(dateRaw);
    // 2026-04-18 audit: added potential_lead, sold, listed so cold-call uploads
    // with these dispositions get removed from callable list (they're all
    // real-conversation outcomes, same treatment as 'transfer').
    const ALWAYS_REM=new Set(['transfer','potential_lead','sold','listed','do_not_call','wrong_number','spanish_speaker','disqualified']);
    let action='keep',byMem=false,caughtByMem=false;
    const prevNi=prevDispoCounts['not_interested']||0;
    const prevHup=prevDispoCounts['hung_up']||0;
    const prevDc=prevDispoCounts['dead_call']||0;
    const prevNa=prevDispoCounts['not_available']||0;
    const prevVm=prevDispoCounts['voicemail']||0;
    if(ALWAYS_REM.has(dispo)){
      action='remove';
    }
    // Individual NI 3-strike
    else if(dispo==='not_interested'&&niCount>=3){
      action='remove';
      if(prevNi<3)byMem=true;
    }
    // Individual hang_up 3-strike → reclassify as NI
    else if(dispo==='hung_up'&&hupCount>=3){
      action='remove';
      effectiveDispo='not_interested';
      tag=phoneTag('not_interested',cumCount,list);
      status=phoneStatus('not_interested');
      mkt=mktResult('not_interested',list);
      if(prevHup<3)byMem=true;
    }
    // Combined NI + hang_up bucket (4 total) → reclassify as NI
    else if((dispo==='not_interested'||dispo==='hung_up')&&(niCount+hupCount)>=4){
      action='remove';
      effectiveDispo='not_interested';
      tag=phoneTag('not_interested',cumCount,list);
      status=phoneStatus('not_interested');
      mkt=mktResult('not_interested',list);
      if((prevNi+prevHup)<4)byMem=true;
    }
    // Combined dead_call + not_available bucket (4 total)
    else if((dispo==='dead_call'||dispo==='not_available')&&(dcCount+naCount)>=4){
      action='remove';
      if((prevDc+prevNa)<4)byMem=true;
    }
    // Voicemail standalone (>3 = 4th VM removes — keeping original behavior)
    else if(dispo==='voicemail'&&vmCount>3){
      action='remove';
      if(prevVm<=3)byMem=true;
    }
    if(byMem){memCaught++;caughtByMem=true;}
    if(action==='remove') listsSeen[list].rem++; else listsSeen[list].keep++;
    const enriched={'List Name (REISift Campaign)':list,'First Name':r[COL.fname]||'','Last Name':r[COL.lname]||'','Address':r[COL.addr]||'','City':r[COL.city]||'','State':r[COL.state]||'','Zip Code':r[COL.zip]||'','Phone':r[COL.phone]||'','Disposition':dispoRaw,'Call Log Count':cumCount,'Call Log Date':dateClean,'Phone Status':status,'Phone Tag':tag,'Marketing Results':mkt,'Cold Call Campaign Name':list,'Call Notes':r[COL.notes]||'','Action':action,'_normDispo':effectiveDispo,'_caughtByMemory':byMem};
    if(action==='remove') filteredRows.push(enriched); else cleanRows.push(enriched);
  });
  return {cleanRows,filteredRows,listsSeen,memCaught,totalRows:rows.length,memory};
}

function toCSV(rows) {
  if(!rows.length) return '';
  const cols=Object.keys(rows[0]).filter(c=>!c.startsWith('_'));
  // 2026-04-18 audit fix #26: CSV injection protection. Prefix any cell
  // starting with =, +, -, @, or control chars with a single quote so Excel
  // treats it as text instead of a formula.
  const safe = (v) => {
    const s = String(v || '');
    return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  };
  return [cols.join(','),...rows.map(r=>cols.map(c=>`"${safe(r[c]).replace(/"/g,'""')}"`).join(','))].join('\n');
}

// /login, /logout — moved to src/auth-routes.js (Phase 2c). Email + password
// (bcrypt) replaces the old single APP_USERNAME/APP_PASSWORD gate. The
// founding wale@hudrei.com user keeps working because seedFoundingUserPassword()
// at boot bcrypt-hashes APP_PASSWORD into their users.password_hash on first
// run and marks them email_verified.


app.post('/process',requireAuth,upload.single('csvfile'),async(req,res)=>{
  try{
    if(!req.file) return res.status(400).json({error:'No file uploaded.'});
    // 2026-04-18 audit fix #9: reject uploads without a campaign id. Previously
    // fell through to list-name scoping which caused cross-campaign memory
    // contamination. Every upload must be tagged to a campaign.
    const cId = req.body.campaign_id;
    if (!cId) {
      return res.status(400).json({
        error: 'campaign_id is required. Select a campaign before uploading a filtration file.'
      });
    }
    const memory=await loadMemory();
    const result=processCSV(bufferToCsvText(req.file.buffer),memory,cId);
    await saveMemory(result.memory);
    req.session.lastResult={cleanRows:result.cleanRows,filteredRows:result.filteredRows};
    const allRows=[...result.cleanRows,...result.filteredRows];
    const runId=await saveRunToDB(req.tenantId, req.file.originalname||'upload.csv',{totalRows:result.totalRows,listsCount:Object.keys(result.listsSeen).length,kept:result.cleanRows.length,filtered:result.filteredRows.length,memCaught:result.memCaught},result.listsSeen,allRows);
    if(runId) console.log('Saved to DB, run ID:',runId);
    const campaignId = req.body.campaign_id;
    if(campaignId){
      try{
        await campaigns.initCampaignSchema();
        await campaigns.recordUpload(req.tenantId, campaignId, req.file.originalname||'upload.csv', Object.keys(result.listsSeen)[0]||'upload', 'cold_call', allRows, result.totalRows);
      // Apply filtration results to contact phone statuses
      try { await campaigns.applyFiltrationToContacts(campaignId, allRows); } catch(e) { console.error('applyFiltration error:', e.message); }
      }catch(campErr){ console.error('Campaign record error:', campErr.message); }
    }
    const newMemSize=Object.keys(result.memory).length;
    const newListCount=new Set(Object.keys(result.memory).map(k=>k.split('||')[0])).size;
    res.json({success:true,stats:{totalRows:result.totalRows,listsCount:Object.keys(result.listsSeen).length,kept:result.cleanRows.length,filtered:result.filteredRows.length,memCaught:result.memCaught},listsSeen:result.listsSeen,memSize:newMemSize,listCount:newListCount,preview:{filtered:result.filteredRows.slice(0,50),clean:result.cleanRows.slice(0,50)}});
  }catch(err){res.status(500).json({error:err.message});}
});

app.get('/download/filtered',requireAuth,(req,res)=>{
  if(!req.session.lastResult) return res.redirect('/');
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition','attachment; filename="hudrei_filtered_reisift.csv"');
  res.send(toCSV(req.session.lastResult.filteredRows));
});

app.get('/download/clean',requireAuth,(req,res)=>{
  if(!req.session.lastResult) return res.redirect('/');
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition','attachment; filename="hudrei_clean_list.csv"');
  res.send(toCSV(req.session.lastResult.cleanRows));
});

app.get('/memory/export',requireAuth,async(req,res)=>{
  const memory=await loadMemory();
  res.setHeader('Content-Type','application/json');
  res.setHeader('Content-Disposition','attachment; filename="hudrei_memory.json"');
  res.send(JSON.stringify(memory,null,2));
});

app.post('/memory/import',requireAuth,upload.single('memfile'),async(req,res)=>{
  // 2026-05-01 audit fix QW#9: guard req.file. When multer rejects an
  // upload via fileFilter (or the user POSTs without a file), req.file is
  // undefined — pre-fix `req.file.buffer` threw TypeError, swallowed by
  // the catch and surfaced as the generic "Invalid memory file." error,
  // masking the actual cause.
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  try{
    const data=JSON.parse(bufferToCsvText(req.file.buffer));
    // Defensive shape check — saveMemory expects a plain object map.
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return res.status(400).json({ error: 'Memory file must be a JSON object.' });
    }
    await saveMemory(data);
    res.json({success:true,count:Object.keys(data).length});
  } catch(e){res.status(400).json({error:'Invalid memory file.'});}
});

app.post('/memory/clear',requireAuth,async(req,res)=>{await clearMemory();res.json({success:true});});

// Records + Setup routes
app.use('/records', slice1Records);
app.use('/setup', setupRoutes);
app.use('/lists', listsRoutes);
app.use('/import/property', importRoutes);
app.use('/import/bulk', bulkImportRoutes);
app.use('/activity', activityRoutes);
// 2026-04-21 Feature 5: owner dashboard
app.use('/owners', ownersRoutes);
app.use('/lists', listTypesRoutes);

// 2026-04-23 Ocular UI — new design system at /oculah/*. Old Loki routes
// Static assets and Ocular UI routes.
// 2026-04-30 rebrand to Oculah: serve static files under /oculah-static and
// mount the UI router under /oculah. The legacy /ocular* paths are kept as
// aliases so old bookmarks, cached HTML, and outbound emails referencing the
// previous URL keep working — both prefixes hit the same handler. New code
// uses the /oculah prefix.
app.use('/oculah-static', express.static(path.join(__dirname, 'ui/static'), { maxAge: '1d' }));
app.use('/ocular-static', express.static(path.join(__dirname, 'ui/static'), { maxAge: '1d' }));
app.use('/oculah', ocularRoutes);
app.use('/ocular', ocularRoutes);

// 2026-04-28 SaaS super-admin console. The router self-gates via
// SUPER_ADMIN_EMAIL — only the operator whose email matches that env var
// reaches any handler. Mounted last so /admin doesn't collide with anything.
app.use('/admin', adminRoutes);

// 2026-05-01 Phase 3 — billing UI routes (the webhook is mounted earlier
// with raw body parsing). _billingRoutes was loaded near the top.
app.use(_billingRoutes.router);

// 2026-05-01 Phase 4 — workspace member management (admin-only) +
// public invite-accept flow. Both live in the same router to keep the
// invitations module's helpers in one place.
app.use(require('./invitations-routes'));

// 2026-05-01 Phase 2 finalization — Sentry error handler. MUST mount
// after all routes so it sees errors propagated by next(err) from any
// route. Forwards err on to whatever handler comes after (or Express's
// default), so this only side-effect-reports — never swallows.
app.use(errorMonitor.errorHandler());







// ── Dashboard stats helper ────────────────────────────────────────────────────
// 2026-04-21 PM: extracted from /dashboard so /api/dashboard-stats can reuse.
// Live-refresh: /dashboard polls this endpoint every 30s to update counters
// in-place without a full page reload. Single source of truth for "what does
// a lead mean" — any future change goes in one place.
async function getDashboardStats(tenantId) {
  // 2026-05-01 audit fix QW#8: tenant-scope every COUNT. Pre-fix every
  // subquery here was unscoped — `(SELECT COUNT(*) FROM properties WHERE
  // state_code='IN')`, `(SELECT COUNT(*) FROM lists)` etc. — so the
  // dashboard showed cross-tenant counts AND scanned every tenant's rows on
  // every poll (every 30s). Required tenantId param. n_live_tup shortcut
  // can't be tenant-scoped (it's a per-table estimate), so those three
  // counts now go directly through COUNT(*) WHERE tenant_id = $1.
  const stats = await dbQuery(`SELECT
    (SELECT COUNT(*) FROM properties WHERE tenant_id = $1) AS total_properties,
    (SELECT COUNT(*) FROM properties WHERE tenant_id = $1 AND created_at >= date_trunc('month', NOW())) AS new_this_month,
    (SELECT COUNT(*) FROM contacts WHERE tenant_id = $1) AS total_contacts,
    (SELECT COUNT(*) FROM phones WHERE tenant_id = $1) AS total_phones,
    (SELECT COUNT(*) FROM phones WHERE tenant_id = $1 AND LOWER(phone_status) = 'correct') AS correct_phones,
    (SELECT COUNT(*) FROM phones WHERE tenant_id = $1 AND (LOWER(phone_status) = 'wrong' OR wrong_number = true)) AS wrong_phones,
    (SELECT COUNT(*) FROM phones WHERE tenant_id = $1 AND LOWER(phone_status) IN ('dead','dead_number')) AS dead_phones,
    (SELECT COUNT(*) FROM lists WHERE tenant_id = $1) AS total_lists,
    -- 2026-04-21 PM v3 fix: Leads = SUM(campaigns.total_transfers).
    --
    -- History: this query went through 3 iterations today because Loki had
    -- THREE different "lead" counters that each counted differently:
    --   v1 (old): COUNT properties.pipeline_stage='lead' + cc.marketing_result='Lead'
    --             → 41 (too narrow; missed most SMS leads)
    --   v2:       JOIN campaign_numbers.last_disposition_normalized='transfer'
    --             → 74 (still missed SMS — SMS path never writes campaign_numbers)
    --   v3 (now): SUM(campaigns.total_transfers)
    --             → 147 (matches what campaign detail pages already show —
    --                    the number users have been trusting all along)
    --
    -- campaigns.total_transfers is incremented at ingest time (filtration.js)
    -- on every transfer/potential_lead/sold/listed outcome, across BOTH
    -- cold-call AND SMS paths. It's the broadest and most accurate counter,
    -- and since it's pre-aggregated a simple SUM beats any join-based query
    -- for speed. Same definition also drives the /campaigns list column and
    -- the per-campaign detail page — single source of truth.
    (SELECT COALESCE(SUM(total_transfers), 0)::int FROM campaigns WHERE tenant_id = $1) AS leads,
    (SELECT COUNT(*) FROM properties WHERE tenant_id = $1 AND pipeline_stage = 'contract') AS contracts,
    (SELECT COUNT(*) FROM properties WHERE tenant_id = $1 AND pipeline_stage = 'closed') AS closed,
    (SELECT COUNT(*) FROM properties WHERE tenant_id = $1 AND state_code = 'IN') AS indiana_props,
    (SELECT COUNT(*) FROM properties WHERE tenant_id = $1 AND state_code = 'GA') AS georgia_props,
    (SELECT COUNT(*) FROM filtration_runs WHERE tenant_id = $1) AS total_filtration_runs,
    (SELECT COUNT(*) FROM filtration_runs WHERE tenant_id = $1 AND run_at >= date_trunc('month', NOW())) AS filtration_runs_month
  `, [tenantId]);
  return stats.rows[0];
}

// JSON endpoint for live-refresh. Dashboard polls this every 30s.
app.get('/api/dashboard-stats', requireAuth, async (req, res) => {
  try {
    const s = await getDashboardStats(req.tenantId);
    res.json({ ok: true, stats: s, timestamp: Date.now() });
  } catch (e) {
    console.error('[api/dashboard-stats]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Dashboard ─────────────────────────────────────────────────────────────────
// Milestone A: /dashboard redirects to the Ocular dashboard. The legacy
// renderer below isn't reachable from this app any more; left in place for
// one cycle in case we need to roll back, then it can be removed.
app.get('/dashboard', requireAuth, (req, res) => res.redirect('/oculah/dashboard'));



app.listen(PORT, async ()=>{
  console.log(`Oculah running on port ${PORT}`);
  console.log(`Redis: ${redis?'connected':'not configured'}`);

  // 2026-04-29 audit fix M8: split startup into "core must succeed" vs
  // "optional, log-and-continue". Pre-fix the Promise.allSettled wrapped
  // initSchema (the foundational tenants/users/properties tables) alongside
  // the optional ensure* calls — meaning if initSchema failed, the server
  // still came up and started serving requests against a half-initialized
  // schema. Now: initSchema is awaited synchronously; failure here means
  // process.exit(1) so the deploy fails fast and the bad image doesn't ship.
  // Optional schemas (campaigns, distress, settings) keep allSettled — their
  // individual failure shouldn't take down the whole app.
  try {
    await initSchema();
    console.log('Schema ready');
  } catch (e) {
    console.error('FATAL: core schema init failed — refusing to serve traffic:', e.message);
    process.exit(1);
  }

  // Optional schemas — concurrent, log-and-continue.
  const [campRes, distRes, settingsRes] = await Promise.allSettled([
    campaigns.initCampaignSchema(),
    require('./scoring/distress').ensureDistressSchema(),
    require('./settings').ensureSettingsSchema(),
  ]);
  if (campRes.status === 'fulfilled')    console.log('Campaign schema ready');
  else                                   console.error('Campaign schema init error:', campRes.reason?.message || campRes.reason);
  if (distRes.status === 'fulfilled')    console.log('Distress schema ready');
  else                                   console.error('Distress schema init error:', distRes.reason?.message || distRes.reason);
  if (settingsRes.status === 'fulfilled')console.log('Settings schema ready');
  else                                   console.error('Settings schema init error:', settingsRes.reason?.message || settingsRes.reason);

  // Phase 1: ensure HudREI (tenant_id=1) has its default settings row.
  // Idempotent — does nothing if the row already exists. Phase 2 signup
  // will call provisionTenantSettings(newTenantId) for each new tenant.
  try {
    await require('./settings').provisionTenantSettings(1);
  } catch (e) {
    console.error('HudREI settings provisioning warning:', e.message);
  }

  // 2026-05-01 Phase 2 finalization — kick off the weekly backup scheduler.
  // No-op when BACKUP_S3_BUCKET isn't set; logs the disabled state once so
  // operators know what env to set when they're ready to enable.
  backup.scheduleBackups();

  // Phase 2c: founding-user backfill. The seed user (wale@hudrei.com, id=1)
  // was created in Phase 1 with NULL password_hash because login still used
  // APP_USERNAME/APP_PASSWORD. Now that login expects bcrypt, hash the env
  // password into the row exactly once. Idempotent — runs only when the
  // password_hash column is still NULL.
  try {
    const seed = await dbQuery(
      `SELECT id, password_hash FROM users WHERE email = $1 LIMIT 1`,
      ['wale@hudrei.com']
    );
    if (seed.rows.length && !seed.rows[0].password_hash) {
      const passwords = require('./passwords');
      const hashed = await passwords.hash(APP_PASSWORD);
      await dbQuery(
        `UPDATE users
            SET password_hash = $1,
                email_verified_at = COALESCE(email_verified_at, NOW())
          WHERE id = $2`,
        [hashed, seed.rows[0].id]
      );
      console.log('Founding user password backfilled from APP_PASSWORD env');
    }
  } catch (e) {
    console.error('Founding-user backfill warning:', e.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// saveRunToDB — bulk UNNEST rewrite (2026-04-17, decision #3).
//
// The old version ran ~12 queries per row in an `allRows` loop: one for each
// of markets/lists/properties/contacts/phones upserts + call_log + marketing
// touch + filtration_result, plus an extra SELECT to look up the existing
// primary contact. At 10k rows, that's 120,000 round-trips to Postgres — on
// a Railway shared worker this meant 3–6 minute "saves" that often timed
// out the browser. This rewrite uses a 13-pass structure where each pass is
// a SINGLE bulk query using UNNEST arrays; entire 10k-row uploads now save
// in 3–8 seconds (~50× improvement).
//
// Also gone: the `await initSchema()` call on line 782. Schema init is now
// gated by a module-level flag in db.js (Audit #16); we don't pay the DDL
// cost per upload any more.
// ─────────────────────────────────────────────────────────────────────────────
async function saveRunToDB(tenantId, filename, stats, listsSeen, allRows) {
  if (!Number.isInteger(tenantId)) throw new Error('saveRunToDB: tenantId required');
  if (!process.env.DATABASE_URL) return null;
  if (!allRows || !allRows.length) return null;

  const distress = require('./scoring/distress');

  // 2026-04-29 audit fix H3: wrap the entire 13-pass import in a single
  // transaction. Pre-fix, each pass used the pool-level dbQuery — pass N
  // failure left passes 1..N-1 committed, leaving inconsistent state
  // (markets seeded but no properties; properties imported but no contacts;
  // etc.). Now: dedicated client + BEGIN/COMMIT, with the distress rescore
  // (Pass 13) intentionally moved OUTSIDE the txn since it's a long-running
  // separate concern and shouldn't hold the connection.
  // Same shadowed-symbol trick as audit K9 / H3 (bulk-import). The 16
  // existing `dbQuery(...)` call sites inside saveRunToDB now route through
  // the dedicated client without per-line edits.
  const client = await _pgPool.connect();
  // eslint-disable-next-line no-shadow
  const dbQuery = client.query.bind(client);
  let txnStarted = false;
  try {
    await dbQuery('BEGIN');
    txnStarted = true;
    // ── Pass 0: normalize + partition all rows up-front ──────────────────────
    // Rows with invalid/garbage state_codes are DROPPED (decision #2). Keeps
    // the properties table clean from "46" / "UN" / other nonsense that used
    // to get silently inserted via raw toUpperCase().
    const cleaned = [];
    for (const row of allRows) {
      const state = normalizeState(row['State'] || '');
      if (!state) {
        // Row keeps a filtration_result entry below (for audit) but won't
        // produce a property/market row.
        // 2026-05-01 audit fix QW#3: normalizePhone strips a leading "1"
        // and is the single source of truth — was raw .replace(/\D/g,'')
        // which let "1NPANXXXXXX" through unchanged and broke every
        // cross-path lookup (NIS / dedup / campaign-phones-update).
        cleaned.push({ _invalidState: true, phone: normalizePhone(row['Phone']),
                       listName: row['List Name (REISift Campaign)'] || '',
                       dispo: row['Disposition'] || '',
                       dispoNorm: normDispo(row['Disposition'] || ''),
                       mktResult: row['Marketing Results'] || '',
                       phoneStatus: row['Phone Status'] || '',
                       phoneTag: row['Phone Tag'] || '',
                       callLogCount: row['Call Log Count'] || 0,
                       action: row['Action'] || 'keep' });
        continue;
      }
      cleaned.push({
        street:    (row['Address'] || '').trim(),
        city:      (row['City'] || '').trim(),
        state:     state,
        zip:       (row['Zip Code'] || '').trim(),
        firstName: row['First Name'] || '',
        lastName:  row['Last Name']  || '',
        // 2026-05-01 audit fix QW#3: normalizePhone — strips leading "1",
        // unifies key shape with every other path.
        phone:     normalizePhone(row['Phone']),
        listName:  row['List Name (REISift Campaign)'] || '',
        dispo:     row['Disposition'] || '',
        dispoNorm: normDispo(row['Disposition'] || ''),
        callDate:  row['Call Log Date'] || null,
        mktResult: row['Marketing Results'] || '',
        phoneStatus: row['Phone Status'] || '',
        phoneTag:  row['Phone Tag'] || '',
        callLogCount: parseInt(row['Call Log Count']) || 0,
        action:    row['Action'] || 'keep',
      });
    }
    const validRows = cleaned.filter(r => !r._invalidState);

    // ── Pass 1: filtration_runs header row ──────────────────────────────────
    const runRes = await dbQuery(
      `INSERT INTO filtration_runs (tenant_id, filename, total_records, lists_detected, records_kept, records_filtered, caught_by_memory)
       VALUES ($7,$1,$2,$3,$4,$5,$6) RETURNING id`,
      [filename, stats.totalRows, stats.listsCount, stats.kept, stats.filtered, stats.memCaught, tenantId]
    );
    const runId = runRes.rows[0].id;

    // Build keys
    const propKey = (r) => `${r.street.toLowerCase()}|${r.city.toLowerCase()}|${r.state}|${r.zip}`;
    const propMap = new Map();    // key → property_id
    const listMap = new Map();    // name → list_id
    const mktMap  = new Map();    // state → market_id
    const contactIdByProp = new Map(); // property_id → contact_id
    const phoneIdMap = new Map(); // "contactId|phone" → phone_id

    // ── Pass 2: bulk INSERT markets for all unique states ────────────────────
    const uniqueStates = [...new Set(validRows.map(r => r.state).filter(Boolean))];
    if (uniqueStates.length > 0) {
      await dbQuery(
        `INSERT INTO markets (tenant_id, name, state_code, state_name)
         SELECT $2, code || ' Market', code, code FROM UNNEST($1::text[]) AS t(code)
         ON CONFLICT (tenant_id, state_code) DO NOTHING`,
        [uniqueStates, tenantId]
      );
      const mr = await dbQuery(`SELECT id, state_code FROM markets WHERE tenant_id = $2 AND state_code = ANY($1::text[])`, [uniqueStates, tenantId]);
      for (const m of mr.rows) mktMap.set(m.state_code, m.id);
    }

    // ── Pass 3: bulk UPSERT lists ────────────────────────────────────────────
    const uniqueLists = [...new Set(validRows.map(r => r.listName).filter(Boolean))];
    if (uniqueLists.length > 0) {
      const lr = await dbQuery(
        `INSERT INTO lists (tenant_id, list_name) SELECT $2, unnest($1::text[])
         ON CONFLICT (tenant_id, list_name) DO UPDATE SET list_name = EXCLUDED.list_name
         RETURNING id, list_name`,
        [uniqueLists, tenantId]
      );
      for (const l of lr.rows) listMap.set(l.list_name, l.id);
    }

    // ── Pass 4: dedupe properties, bulk UPSERT via UNNEST ────────────────────
    const propBucket = new Map();
    for (const r of validRows) {
      if (!r.street || !r.city) continue;
      const k = propKey(r);
      if (!propBucket.has(k)) propBucket.set(k, r);
    }
    const propArr = Array.from(propBucket.values());
    if (propArr.length > 0) {
      const pr = await dbQuery(`
        INSERT INTO properties (tenant_id, street, city, state_code, zip_code, market_id)
        SELECT $6, street, city, state_code, zip_code, market_id FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::int[])
          AS t(street, city, state_code, zip_code, market_id)
        ON CONFLICT (tenant_id, street, city, state_code, zip_code) DO UPDATE SET updated_at = NOW()
        RETURNING id, street, city, state_code, zip_code
      `, [
        propArr.map(r => r.street),
        propArr.map(r => r.city),
        propArr.map(r => r.state),
        propArr.map(r => r.zip),
        propArr.map(r => mktMap.get(r.state) || null),
        tenantId,
      ]);
      for (const p of pr.rows) {
        const k = `${p.street.toLowerCase()}|${p.city.toLowerCase()}|${p.state_code}|${p.zip_code}`;
        propMap.set(k, p.id);
      }
    }

    // ── Pass 5: bulk INSERT property_lists links ─────────────────────────────
    const plPairs = new Set();
    for (const r of validRows) {
      if (!r.listName || !r.street) continue;
      const pid = propMap.get(propKey(r));
      const lid = listMap.get(r.listName);
      if (pid && lid) plPairs.add(`${pid}|${lid}`);
    }
    if (plPairs.size > 0) {
      const propIds = [], listIds = [];
      for (const pair of plPairs) {
        const [pi, li] = pair.split('|');
        propIds.push(parseInt(pi));
        listIds.push(parseInt(li));
      }
      await dbQuery(`
        INSERT INTO property_lists (tenant_id, property_id, list_id)
        SELECT $3, property_id, list_id FROM UNNEST($1::int[], $2::int[]) AS t(property_id, list_id)
        ON CONFLICT DO NOTHING
      `, [propIds, listIds, tenantId]);
    }

    // ── Pass 6: preload existing primary contacts for touched properties ─────
    const touchedPropIds = [...new Set(Array.from(propMap.values()))];
    const existingPC = new Map();
    if (touchedPropIds.length > 0) {
      const ex = await dbQuery(
        `SELECT property_id, contact_id FROM property_contacts
          WHERE tenant_id = $2 AND property_id = ANY($1::int[]) AND primary_contact = true`,
        [touchedPropIds, tenantId]
      );
      for (const row of ex.rows) existingPC.set(row.property_id, row.contact_id);
    }

    // ── Pass 7: split contacts into update vs insert, do each in bulk ────────
    const propContactData = new Map(); // propId → {first, last}
    for (const r of validRows) {
      if (!r.street || !r.city) continue;
      if (!r.firstName && !r.lastName) continue;
      const pid = propMap.get(propKey(r));
      if (!pid) continue;
      if (!propContactData.has(pid)) {
        propContactData.set(pid, { firstName: r.firstName, lastName: r.lastName });
      }
    }

    const updIds = [], updFirst = [], updLast = [];
    const newProps = [], newFirsts = [], newLasts = [];
    for (const [pid, data] of propContactData) {
      if (existingPC.has(pid)) {
        const cid = existingPC.get(pid);
        contactIdByProp.set(pid, cid);
        updIds.push(cid); updFirst.push(data.firstName); updLast.push(data.lastName);
      } else {
        newProps.push(pid); newFirsts.push(data.firstName); newLasts.push(data.lastName);
      }
    }
    if (updIds.length > 0) {
      await dbQuery(`
        UPDATE contacts SET
          first_name = COALESCE(NULLIF(t.first_name,''), contacts.first_name),
          last_name  = COALESCE(NULLIF(t.last_name,''),  contacts.last_name),
          updated_at = NOW()
        FROM UNNEST($1::int[], $2::text[], $3::text[]) AS t(id, first_name, last_name)
        WHERE contacts.id = t.id AND contacts.tenant_id = $4
      `, [updIds, updFirst, updLast, tenantId]);
    }
    if (newProps.length > 0) {
      const nr = await dbQuery(`
        INSERT INTO contacts (tenant_id, first_name, last_name)
        SELECT $3, first_name, last_name FROM UNNEST($1::text[], $2::text[]) AS t(first_name, last_name)
        RETURNING id
      `, [newFirsts, newLasts, tenantId]);
      const newIds = nr.rows.map(r => r.id);
      await dbQuery(`
        INSERT INTO property_contacts (tenant_id, property_id, contact_id, primary_contact)
        SELECT $4, property_id, contact_id, primary_contact FROM UNNEST($1::int[], $2::int[], $3::bool[]) AS t(property_id, contact_id, primary_contact)
        ON CONFLICT DO NOTHING
      `, [newProps, newIds, newProps.map(() => true), tenantId]);
      for (let i = 0; i < newProps.length; i++) contactIdByProp.set(newProps[i], newIds[i]);
    }

    // ── Pass 8: bulk UPSERT phones ───────────────────────────────────────────
    // 2026-04-29 audit fix C-1 follow-up: propagate the do_not_call flag from
    // call-log dispositions ('do not call' / 'dnc' rows) into phones.do_not_call.
    // Pre-fix Pass 8 wrote only phone_status and phone_tag — DNC dispositions
    // recorded on a call log never marked the phone as DNC in the global phones
    // table. generateCleanExport's DNC filter (line 588 of filtration.js, my
    // C-1 fix) was reading phones.do_not_call which was always false because
    // nothing here was setting it. Net effect: TCPA-flagged phones from the
    // dialer's call log were re-included in the clean callable export on the
    // next campaign cycle — exactly what the C-1 fix was supposed to prevent.
    //
    // Now: any row whose normalized disposition is 'do_not_call' marks the
    // phone do_not_call=true. Idempotent — once a phone is DNC, it stays DNC
    // (the ON CONFLICT branch uses GREATEST(EXCLUDED.do_not_call, phones.do_not_call)
    // so a later non-DNC call log can't UN-flag the phone).
    const phoneBucket = new Map();
    for (const r of validRows) {
      if (!r.phone || !r.street) continue;
      const pid = propMap.get(propKey(r));
      const cid = pid ? contactIdByProp.get(pid) : null;
      if (!cid) continue;
      const key = `${cid}|${r.phone}`;
      const existing = phoneBucket.get(key);
      const isDnc = (r.dispoNorm === 'do_not_call');
      // Sticky DNC: once we see DNC for a (contact, phone) in this batch, keep it.
      const dnc = (existing && existing.dnc) || isDnc;
      phoneBucket.set(key, {
        contactId: cid,
        phone: r.phone,
        status: r.phoneStatus,
        tag: r.phoneTag,
        dnc,
      });
    }
    if (phoneBucket.size > 0) {
      const arr = Array.from(phoneBucket.values());
      const phr = await dbQuery(`
        INSERT INTO phones (tenant_id, contact_id, phone_number, phone_status, phone_tag, do_not_call)
        SELECT $6, contact_id, phone_number, phone_status, phone_tag, do_not_call
          FROM UNNEST($1::int[], $2::text[], $3::text[], $4::text[], $5::bool[])
          AS t(contact_id, phone_number, phone_status, phone_tag, do_not_call)
        ON CONFLICT (contact_id, phone_number) DO UPDATE SET
          phone_status = CASE WHEN EXCLUDED.phone_status NOT IN ('','unknown')
                              THEN EXCLUDED.phone_status
                              ELSE phones.phone_status END,
          phone_tag    = COALESCE(NULLIF(EXCLUDED.phone_tag,''), phones.phone_tag),
          do_not_call  = GREATEST(EXCLUDED.do_not_call::int, phones.do_not_call::int)::bool,
          updated_at   = NOW()
        RETURNING id, contact_id, phone_number
      `, [
        arr.map(p => p.contactId),
        arr.map(p => p.phone),
        arr.map(p => p.status),
        arr.map(p => p.tag),
        arr.map(p => p.dnc),
        tenantId,
      ]);
      for (const p of phr.rows) phoneIdMap.set(`${p.contact_id}|${p.phone_number}`, p.id);
    }

    // ── Pass 9: bulk INSERT call_logs for rows with a disposition + phone ────
    const callLogRows = [];
    for (const r of validRows) {
      if (!r.dispo || !r.phone || !r.street) continue;
      const pid = propMap.get(propKey(r));
      const cid = pid ? contactIdByProp.get(pid) : null;
      const phoneId = (cid && r.phone) ? phoneIdMap.get(`${cid}|${r.phone}`) : null;
      if (!phoneId) continue;
      callLogRows.push({
        phoneId,
        listId:    listMap.get(r.listName) || null,
        propertyId: pid,
        dispo:     r.dispo,
        dispoNorm: r.dispoNorm,
        callDate:  r.callDate,
        campaignName: r.listName,
      });
    }
    if (callLogRows.length > 0) {
      await dbQuery(`
        INSERT INTO call_logs (tenant_id, phone_id, list_id, property_id, disposition, disposition_normalized, call_date, campaign_name)
        SELECT $8, phone_id, list_id, property_id, disposition, disposition_normalized, call_date, campaign_name FROM UNNEST($1::int[], $2::int[], $3::int[], $4::text[], $5::text[], $6::date[], $7::text[])
          AS t(phone_id, list_id, property_id, disposition, disposition_normalized, call_date, campaign_name)
      `, [
        callLogRows.map(r => r.phoneId),
        callLogRows.map(r => r.listId),
        callLogRows.map(r => r.propertyId),
        callLogRows.map(r => r.dispo),
        callLogRows.map(r => r.dispoNorm),
        callLogRows.map(r => r.callDate),
        callLogRows.map(r => r.campaignName),
        tenantId,
      ]);
    }

    // ── Pass 10: transfer handling — single UPDATE for each of props/phones ──
    const transferRows = callLogRows.filter(r => r.dispoNorm === 'transfer' && r.propertyId);
    if (transferRows.length > 0) {
      const xferPropIds  = [...new Set(transferRows.map(r => r.propertyId))];
      const xferPhoneIds = [...new Set(transferRows.map(r => r.phoneId))];
      const priorRes = await dbQuery(
        `SELECT id, pipeline_stage FROM properties WHERE tenant_id = $2 AND id = ANY($1::int[])`,
        [xferPropIds, tenantId]
      );
      const priorMap = new Map();
      for (const p of priorRes.rows) priorMap.set(p.id, p.pipeline_stage);

      await dbQuery(
        `UPDATE properties SET pipeline_stage='lead', updated_at=NOW()
          WHERE tenant_id = $2 AND id = ANY($1::int[]) AND pipeline_stage NOT IN ('contract','closed')`,
        [xferPropIds, tenantId]
      );
      await dbQuery(
        `UPDATE phones SET phone_status='correct', updated_at=NOW()
          WHERE tenant_id = $2 AND id = ANY($1::int[])`,
        [xferPhoneIds, tenantId]
      );
      // Outcome log — only for props that actually changed stage
      for (const pid of xferPropIds) {
        const prev = priorMap.get(pid);
        if (prev !== 'lead' && prev !== 'contract' && prev !== 'closed') {
          try { await distress.logOutcomeChange(pid, 'pipeline_stage', prev, 'lead'); }
          catch (e) {
            // 2026-04-20 pass 12: was `catch(e) { /* non-fatal */ }` — swallowed
            // audit log failures silently, leaving invisible holes in the
            // pipeline_stage outcome history on any FK violation or schema
            // drift. Still non-fatal to the parent request (transfer succeeded)
            // but now the operator can see the gap in Railway logs.
            console.error(`[distress/outcome-log] pipeline_stage ${prev}→lead for property ${pid} failed to log:`, e.message);
          }
        }
      }
    }

    // ── Pass 11: marketing_touches writes REMOVED (audit fix #12) ────────────
    // The marketing_touches table is written here on every filtration but is
    // never read anywhere in the app. It was an aspirational data model for a
    // "marketing history" feature that was never built. Writes removed to stop
    // silently accumulating rows and paying for index maintenance. The same
    // data lives in filtration_results (Pass 12 below) which IS used. If the
    // history feature is built later, either read from filtration_results or
    // revive this write path.
    //
    // The table itself is NOT dropped — that's destructive and data could still
    // be useful if someone wants it later. It just stops growing from now on.

    // ── Pass 12: bulk INSERT filtration_results (every row, valid or not) ────
    await dbQuery(`
      INSERT INTO filtration_results (tenant_id, run_id, phone_number, list_name, property_id, phone_id, disposition, disposition_normalized, cumulative_count, action, phone_status, phone_tag, marketing_result)
      SELECT $13, $1, * FROM UNNEST($2::text[], $3::text[], $4::int[], $5::int[], $6::text[], $7::text[], $8::int[], $9::text[], $10::text[], $11::text[], $12::text[])
        AS t(phone_number, list_name, property_id, phone_id, disposition, disposition_normalized, cumulative_count, action, phone_status, phone_tag, marketing_result)
    `, [
      runId,
      cleaned.map(r => r.phone),
      cleaned.map(r => r.listName),
      cleaned.map(r => r._invalidState ? null : (propMap.get(propKey(r)) || null)),
      cleaned.map(r => {
        if (r._invalidState) return null;
        const pid = propMap.get(propKey(r));
        const cid = pid ? contactIdByProp.get(pid) : null;
        return (cid && r.phone) ? phoneIdMap.get(`${cid}|${r.phone}`) || null : null;
      }),
      cleaned.map(r => r.dispo),
      cleaned.map(r => r.dispoNorm),
      cleaned.map(r => r.callLogCount),
      cleaned.map(r => r.action),
      cleaned.map(r => r.phoneStatus),
      cleaned.map(r => r.phoneTag),
      cleaned.map(r => r.mktResult),
      tenantId,
    ]);

    // H3: COMMIT before pass 13. Distress rescoring runs OUTSIDE the txn —
    // it's a long-running operation that shouldn't hold the connection, and
    // its failure shouldn't roll back the import.
    await dbQuery('COMMIT');
    txnStarted = false;

    // ── Pass 13: distress rescoring ──────────────────────────────────────────
    if (touchedPropIds.length > 0) {
      try {
        const startedAt = Date.now();
        const { scored } = await distress.scoreProperties(touchedPropIds);
        console.log(`[saveRunToDB] distress rescored ${scored} of ${touchedPropIds.length} properties in ${Date.now()-startedAt}ms`);
      } catch (e) {
        console.error('[saveRunToDB] distress rescoring failed:', e.message);
      }
    }

    return runId;
  } catch (err) {
    // H3: roll back the import txn if it was started so we don't leak a
    // poisoned client back to the pool.
    if (txnStarted) {
      try { await client.query('ROLLBACK'); }
      catch (rbErr) { console.error('[saveRunToDB] ROLLBACK failed:', rbErr.message); }
      txnStarted = false;
    }
    console.error('saveRunToDB error:', err.message);
    return null;
  } finally {
    // Belt-and-suspenders for any future early-return path.
    if (txnStarted) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    client.release();
  }
}



// ── Upload Flow Routes (OLD handlers here were dead — superseded by
//    app.use('/upload', uploadRoutes) at line 112, which routes everything
//    to routes/upload-routes.js. Removed in 2026-04-17 audit. If you want
//    the Bulk Import (REISift) 3-card landing page restored, update
//    ui/upload.js uploadChoosePage() instead of adding handlers here.) ─────

// ── Campaign Routes ───────────────────────────────────────────────────────────

// 2026-05-01 audit fix: cross-tenant write protection. Every campaign mutation
// route below verifies that req.params.id belongs to the caller's tenant
// before doing any work. Returns true if owned, sends a redirect/404 and
// returns false otherwise. The historic shape of these handlers was to UPDATE
// WHERE id=$1 with no tenant filter, so any authed user could mutate any
// other tenant's campaigns by guessing the SERIAL id.
async function _requireOwnedCampaign(req, res, opts) {
  const { query: dbQ } = require('./db');
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    if (opts && opts.json) res.status(400).json({ error: 'Bad campaign id' });
    else res.redirect('/oculah/campaigns');
    return false;
  }
  const r = await dbQ('SELECT 1 FROM campaigns WHERE id=$1 AND tenant_id=$2', [id, req.tenantId]);
  if (!r.rows.length) {
    if (opts && opts.json) res.status(404).json({ error: 'Campaign not found' });
    else res.redirect('/oculah/campaigns');
    return false;
  }
  return true;
}

// Update manual count
app.post('/campaigns/:id/count', requireAuth, async (req, res) => {
  try {
    if (!(await _requireOwnedCampaign(req, res))) return;
    const count = parseInt(req.body.manual_count) || 0;
    await campaigns.initCampaignSchema();
    const { query: dbQ } = require('./db');
    await dbQ('UPDATE campaigns SET manual_count=$1, updated_at=NOW() WHERE id=$2 AND tenant_id=$3', [count, req.params.id, req.tenantId]);
    res.redirect('/oculah/campaigns/' + req.params.id);
  } catch(e) { res.redirect('/oculah/campaigns/' + req.params.id); }
});

// List all campaigns
// /campaigns redirects to the Ocular list — Ocular's version is the
// canonical campaigns surface now. The old campaignsPage() renderer
// still exists below for any legacy linkers.
app.get('/campaigns', requireAuth, (req, res) => {
  const tab = req.query.tab ? '?tab=' + encodeURIComponent(req.query.tab) : '';
  res.redirect('/oculah/campaigns' + tab);
});

// New campaign form
app.get('/campaigns/new', requireAuth, async (req, res) => {
  const { getUser } = require('./get-user');
  await campaigns.initCampaignSchema();
  const listTypes = await campaigns.getListTypes(req.tenantId);
  const user = await getUser(req);
  res.send(newCampaignPage(req.query.error || null, listTypes, user));
});

// Create campaign
app.post('/campaigns/new', requireAuth, async (req, res) => {
  try {
    await campaigns.initCampaignSchema();
    const customType = (req.body.custom_list_type || '').trim();
    const body = { ...req.body, created_by: 'team' };
    // If the user picked "+ Add new list type…" or typed a custom value, use and save it
    if (body.list_type === '__new__' || customType) {
      if (!customType) {
        return res.redirect('/campaigns/new?error=' + encodeURIComponent('Enter a new list type or pick one from the dropdown'));
      }
      body.list_type = customType;
      await campaigns.addListType(req.tenantId, customType);
    }
    delete body.custom_list_type;
    await campaigns.createCampaign({ ...body, tenantId: req.tenantId });
    res.redirect('/campaigns');
  } catch (e) { res.redirect('/campaigns/new?error=' + encodeURIComponent(e.message)); }
});

// Close campaign
app.post('/campaigns/:id/close', requireAuth, async (req, res) => {
  try {
    await campaigns.closeCampaign(req.tenantId, req.params.id);
    res.redirect('/oculah/campaigns/' + req.params.id);
  } catch(e) { res.redirect('/oculah/campaigns/' + req.params.id); }
});

// Start new round (clone campaign with fresh memory)
app.post('/campaigns/:id/new-round', requireAuth, async (req, res) => {
  try {
    await campaigns.closeCampaign(req.tenantId, req.params.id);
    const newCamp = await campaigns.cloneCampaign(req.tenantId, req.params.id);
    res.redirect('/oculah/campaigns/' + newCamp.id);
  } catch(e) { res.redirect('/oculah/campaigns/' + req.params.id); }
});

// Update campaign status
app.post('/campaigns/:id/status', requireAuth, async (req, res) => {
  await campaigns.updateCampaignStatus(req.tenantId, req.params.id, req.body.status);
  res.redirect('/oculah/campaigns/' + req.params.id);
});

// Update campaign channel
app.post('/campaigns/:id/channel', requireAuth, async (req, res) => {
  await campaigns.updateCampaignChannel(req.tenantId, req.params.id, req.body.channel);
  res.redirect('/oculah/campaigns/' + req.params.id);
});

// 2026-04-20 audit fix #B: rename a campaign. Validation lives in
// campaigns.updateCampaignName(); route just surfaces the result via flash.
app.post('/campaigns/:id/rename', requireAuth, async (req, res) => {
  try {
    const result = await campaigns.updateCampaignName(req.tenantId, req.params.id, req.body.name);
    if (!result.ok) {
      return res.redirect('/oculah/campaigns/' + req.params.id + '?err=' + encodeURIComponent(result.error));
    }
    res.redirect('/oculah/campaigns/' + req.params.id + '?msg=' + encodeURIComponent('Campaign renamed.'));
  } catch (e) {
    console.error('[campaigns/rename]', e);
    res.redirect('/oculah/campaigns/' + req.params.id + '?err=' + encodeURIComponent('Rename failed: ' + e.message));
  }
});

// Get campaigns as JSON (for upload selector)
app.get('/api/campaigns', requireAuth, async (req, res) => {
  try {
    await campaigns.initCampaignSchema();
    const list = await campaigns.getCampaigns(req.tenantId);
    res.json(list.filter(c => c.status === 'active'));
  } catch (e) { res.json([]); }
});

// Record upload into campaign
app.post('/campaigns/:id/upload', requireAuth, upload.single('csvfile'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file.' });
    if (!(await _requireOwnedCampaign(req, res, { json: true }))) return;
    const memory = await loadMemory();
    const result = processCSV(bufferToCsvText(req.file.buffer), memory, req.params.id);
    await saveMemory(result.memory);
    req.session.lastResult = { cleanRows: result.cleanRows, filteredRows: result.filteredRows };
    const allRows = [...result.cleanRows, ...result.filteredRows];
    const sourceList = allRows[0]?.['List Name (REISift Campaign)'] || req.file.originalname;
    await campaigns.recordUpload(req.tenantId, req.params.id, req.file.originalname, sourceList, req.body.channel || 'cold_call', allRows, result.totalRows);
    // 2026-05-01 audit fix QW#4: propagate wrong_number/filtered/nis flags
    // from cold-call dispositions to campaign_contact_phones. Pre-fix the
    // /process route did this but the campaign-detail upload UI (which posts
    // here) didn't, so flags from this surface never reached the master
    // contact list. Errors are non-fatal — the upload itself already
    // committed to filtration_results / campaign_numbers.
    try { await campaigns.applyFiltrationToContacts(req.params.id, allRows); }
    catch (e) { console.error('[campaigns/upload] applyFiltrationToContacts:', e.message); }
    const newMemSize = Object.keys(result.memory).length;
    const newListCount = new Set(Object.keys(result.memory).map(k => k.split('||')[0])).size;
    res.json({
      success: true,
      redirectTo: '/oculah/campaigns/' + req.params.id,
      stats: { totalRows: result.totalRows, listsCount: Object.keys(result.listsSeen).length, kept: result.cleanRows.length, filtered: result.filteredRows.length, memCaught: result.memCaught },
      listsSeen: result.listsSeen, memSize: newMemSize, listCount: newListCount,
      preview: { filtered: result.filteredRows.slice(0, 50), clean: result.cleanRows.slice(0, 50) }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ── Contact List Routes ───────────────────────────────────────────────────────

// Upload original contact list to campaign
app.post('/campaigns/:id/contacts/upload', requireAuth, upload.single('contactfile'), async (req, res) => {
  try {
    if (!req.file) return res.redirect('/oculah/campaigns/' + req.params.id);
    if (!(await _requireOwnedCampaign(req, res))) return;
    await campaigns.initCampaignSchema();
    const parsed = Papa.parse(bufferToCsvText(req.file.buffer), { header: true, skipEmptyLines: true });
    console.log('[contacts/upload] file received:', req.file.originalname, 'rows:', parsed.data.length, 'headers:', (parsed.meta.fields||[]).length);
    await campaigns.importContactList(req.tenantId, req.params.id, parsed.data, parsed.meta.fields || []);
    console.log('[contacts/upload] import complete for campaign', req.params.id);
    res.redirect('/oculah/campaigns/' + req.params.id);
  } catch (e) {
    const ref = errRefId();
    // 2026-04-28 audit fix S-4: full Postgres error code/detail and stack are
    // logged server-side keyed to the ref id. Browser sees only the ref id —
    // no schema/column/value leaks.
    console.error(`[contacts/upload] ${ref} ERROR:`, e.message);
    console.error(`[contacts/upload] ${ref} code:`, e.code, 'detail:', e.detail);
    console.error(`[contacts/upload] ${ref} stack:`, e.stack);
    res.status(500).send(`<h2>Upload failed</h2><p>Something went wrong while processing this upload. Try again, or share this reference with support: <code>${ref}</code></p><p><a href="/oculah/campaigns/${req.params.id}">Back to campaign</a></p>`);
  }
});

// Delete master contact list
app.post('/campaigns/:id/contacts/delete', requireAuth, async (req, res) => {
  try {
    if (!(await _requireOwnedCampaign(req, res))) return;
    const { query: dbQ } = require('./db');
    await dbQ('DELETE FROM campaign_contacts WHERE campaign_id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
    await dbQ('UPDATE campaigns SET total_unique_numbers=0, updated_at=NOW() WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
    res.redirect('/oculah/campaigns/' + req.params.id);
  } catch(e) { res.redirect('/oculah/campaigns/' + req.params.id); }
});

// SMS SmarterContact upload
app.post('/campaigns/:id/sms/upload', requireAuth, upload.single('smsfile'), async (req, res) => {
  try {
    if (!req.file) return res.redirect('/oculah/campaigns/' + req.params.id);
    if (!(await _requireOwnedCampaign(req, res))) return;
    const parsed = Papa.parse(bufferToCsvText(req.file.buffer), { header: true, skipEmptyLines: true });
    const result = await campaigns.importSmarterContactFile(
      req.tenantId,
      req.params.id,
      parsed.data,
      parsed.meta.fields || []
    );
    if (!result.success) {
      return res.status(400).send(`
        <h2>SMS Upload Failed</h2>
        <p style="color:red">${result.error}</p>
        <p><a href="/oculah/campaigns/${req.params.id}">Back to campaign</a></p>
      `);
    }
    const t = result.tally;
    console.log(`[sms/upload] campaign ${req.params.id} — total:${t.total} wrong:${t.wrong} ni:${t.not_interested} leads:${t.leads} dq:${t.disqualified} no_action:${t.no_action} unmatched:${t.unmatched}`);
    res.redirect('/oculah/campaigns/' + req.params.id);
  } catch(e) {
    const ref = errRefId();
    // 2026-04-28 audit fix S-4: error details server-side only.
    console.error(`[sms/upload] ${ref} ERROR:`, e.message);
    console.error(`[sms/upload] ${ref} code:`, e.code, 'detail:', e.detail);
    console.error(`[sms/upload] ${ref} stack:`, e.stack);
    res.status(500).send(`<h2>SMS Upload Error</h2><p>Something went wrong while processing this upload. Try again, or share this reference with support: <code>${ref}</code></p><p><a href="/oculah/campaigns/${req.params.id}">Back to campaign</a></p>`);
  }
});

// NIS upload page
app.get('/nis', requireAuth, async (req, res) => {
  const { getUser } = require('./get-user');
  await campaigns.initCampaignSchema();
  const stats = await campaigns.getNisStats(req.tenantId);
  const user = await getUser(req);
  res.send(nisPage(stats, req.query.msg, user));
});

// Changelog page — admin-only. Regular workspace members (tenant_user) can't
// reach it: they redirect to the dashboard instead. The sidebar entry is
// already hidden via shell.js; this is the matching server-side gate so a
// hand-typed URL doesn't leak the page.
app.get('/changelog', requireAuth, async (req, res) => {
  const { isWorkspaceAdmin } = require('./auth/roles');
  if (!isWorkspaceAdmin(req)) return res.redirect('/oculah/dashboard');
  const { getUser } = require('./get-user');
  const user = await getUser(req);
  res.send(changelogPage(user));
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECURITY SETTINGS — Delete code management
// Gates all destructive operations (record deletion, bulk merges of 10+).
// Default code is seeded to 'HudREI2026' on first boot; user should change it
// immediately via the UI here.
// ═══════════════════════════════════════════════════════════════════════════════
// Milestone A: legacy /settings/security redirects to the Ocular settings page.
app.get('/settings/security', requireAuth, (req, res) => res.redirect('/oculah/setup'));

app.post('/settings/security/delete-code', requireAuth, async (req, res) => {
  const settings = require('./settings');
  const { old_code, new_code, confirm_code } = req.body;
  if (!old_code || !new_code || !confirm_code) {
    return res.redirect('/settings/security?err=' + encodeURIComponent('All fields required.'));
  }
  if (new_code !== confirm_code) {
    return res.redirect('/settings/security?err=' + encodeURIComponent('New code and confirmation do not match.'));
  }
  const result = await settings.updateDeleteCode(req.tenantId, old_code, new_code);
  if (!result.ok) {
    return res.redirect('/settings/security?err=' + encodeURIComponent(result.error));
  }
  res.redirect('/settings/security?msg=' + encodeURIComponent('Delete code updated successfully.'));
});

// NIS upload POST
app.post('/nis/upload', requireAuth, upload.single('nisfile'), async (req, res) => {
  try {
    if (!req.file) return res.redirect('/nis');
    await campaigns.initCampaignSchema();
    const csvText = bufferToCsvText(req.file.buffer);
    const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
    // 2026-05-01 audit fix QW#5: pass filename so the nis_uploads audit
    // row records which file produced each entry. Pre-fix every audit row
    // had filename=null, defeating the /nis history page.
    const result = await campaigns.importNisFile(req.tenantId, parsed.data, { filename: req.file.originalname });
    const msg = `Processed ${result.totalRows} rows — ${result.uniqueNumbers} unique NIS numbers (${result.inserted} new, ${result.updated} updated). Flagged ${result.flagged} phones across all campaigns.`;
    res.redirect('/nis?msg=' + encodeURIComponent(msg));
  } catch(e) {
    const ref = errRefId();
    // 2026-04-28 audit fix S-4: error details server-side only.
    console.error(`[nis/upload] ${ref} ERROR:`, e.message);
    console.error(`[nis/upload] ${ref} code:`, e.code, 'detail:', e.detail);
    console.error(`[nis/upload] ${ref} stack:`, e.stack);
    res.status(500).send(`<h2>NIS upload failed</h2><p>Something went wrong while processing this upload. Try again, or share this reference with support: <code>${ref}</code></p><p><a href="/nis">Back</a></p>`);
  }
});

// One-time sync: flag all historical wrong numbers in master contact list for this campaign
app.post('/campaigns/:id/sync-wrong-numbers', requireAuth, async (req, res) => {
  try {
    if (!(await _requireOwnedCampaign(req, res))) return;
    const { query: dbQ } = require('./db');
    // RETURNING the affected phones so we can mirror the wrong-number flag
    // into phone_intelligence (Spec Section 3 Layer 1). Pre-fix the bulk
    // back-fill updated only ccp.wrong_number; the global Layer 1 store
    // never saw these historical confirmations and stayed stale.
    const result = await dbQ(
      `UPDATE campaign_contact_phones ccp
       SET wrong_number = true, updated_at = NOW()
       FROM campaign_numbers cn
       WHERE cn.phone_number = ccp.phone_number
         AND cn.campaign_id = ccp.campaign_id
         AND cn.campaign_id = $1
         AND ccp.tenant_id = $2
         AND cn.tenant_id = $2
         AND cn.last_disposition_normalized = 'wrong_number'
         AND ccp.wrong_number = false
       RETURNING ccp.phone_number`,
      [req.params.id, req.tenantId]
    );
    console.log('[sync-wrong-numbers] flagged', result.rowCount, 'phones for campaign', req.params.id);

    // Mirror to phone_intelligence. Best-effort — if it fails, the
    // per-row flag still committed and the operator's UI is correct;
    // only the global aggregate is stale.
    if (result.rowCount > 0) {
      try {
        const _phintel = require('./phone-intelligence');
        const items = result.rows.map(r => ({ phone: r.phone_number }));
        await _phintel.setLayerFlag(req.tenantId, items, 'wrong');
      } catch (e) {
        console.error('[sync-wrong-numbers] phone_intelligence sync (non-fatal):', e.message);
      }
    }

    res.redirect('/oculah/campaigns/' + req.params.id);
  } catch(e) {
    console.error('[sync-wrong-numbers] error:', e.message);
    res.redirect('/oculah/campaigns/' + req.params.id);
  }
});

// Update dialer-accepted count (legacy /readymode-count alias for in-flight bookmarks)
app.post(['/campaigns/:id/accepted-count', '/campaigns/:id/readymode-count'], requireAuth, async (req, res) => {
  try {
    if (!(await _requireOwnedCampaign(req, res))) return;
    const { query: dbQ } = require('./db');
    await dbQ('UPDATE campaigns SET manual_count=$1, updated_at=NOW() WHERE id=$2 AND tenant_id=$3',
      [parseInt(req.body.count)||0, req.params.id, req.tenantId]);
    res.redirect('/oculah/campaigns/' + req.params.id);
  } catch(e) { res.redirect('/oculah/campaigns/' + req.params.id); }
});

// Download clean export (callable contacts only)
app.get('/campaigns/:id/export/clean', requireAuth, async (req, res) => {
  try {
    if (!(await _requireOwnedCampaign(req, res))) return;
    await campaigns.initCampaignSchema();
    // 2026-04-28 audit fix C-1: pass tenantId so DNC scoping uses the correct
    // tenant's do_not_call list (phones.phone_number is not globally unique).
    const result = await campaigns.generateCleanExport(req.params.id, req.tenantId);
    if (!result.rows.length) return res.status(400).send('No callable contacts to export.');

    // 2026-04-29 audit fix: CSV-formula injection protection (CWE-1236).
    // Pre-fix this builder dropped raw user-controlled values (names from CSV
    // imports, addresses, mailing fields) directly into the export. A name
    // like `=cmd|' /C calc'!A0` would execute as a formula when an operator
    // opened the CSV in Excel. The records-routes.js export already had a
    // csvSafe() helper for this; the campaign clean-export was the gap.
    // Standard OWASP guidance: prefix with a single quote so spreadsheets
    // treat the cell as text instead of a formula. Header row also quoted +
    // escaped now (was previously naked `cols.join(',')` — would break the
    // CSV if a column name ever contained a comma; defensive at no cost).
    const csvSafe = (val) => {
      const s = String(val == null ? '' : val);
      return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
    };
    const csvCell = (val) => `"${csvSafe(val).replace(/"/g, '""')}"`;
    const cols = Object.keys(result.rows[0]);
    const csv = [
      cols.map(csvCell).join(','),
      ...result.rows.map(r => cols.map(c => csvCell(r[c])).join(',')),
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="loki_clean_export_campaign_${req.params.id}.csv"`);
    res.send(csv);
  } catch(e) { res.status(500).send('Error: ' + e.message); }
});

// Get contact stats API
app.get('/campaigns/:id/contacts/stats', requireAuth, async (req, res) => {
  try {
    await campaigns.initCampaignSchema();
    const stats = await campaigns.getContactStats(req.params.id);
    res.json(stats);
  } catch(e) { res.json({}); }
});

// Delete campaign upload + reverse memory
app.post('/campaigns/:id/uploads/:uploadId/delete', requireAuth, async (req, res) => {
  try {
    if (!(await _requireOwnedCampaign(req, res))) return;
    await campaigns.initCampaignSchema();
    const { query: dbQ } = require('./db');
    const campId = req.params.id;
    const uploadId = req.params.uploadId;

    // 2026-05-01 audit fix QW#1: tenant_id check on the upload row prevents
    // cross-tenant deletion via guessable id pairs.
    const upRes = await dbQ('SELECT * FROM campaign_uploads WHERE id=$1 AND campaign_id=$2 AND tenant_id=$3', [uploadId, campId, req.tenantId]);
    if (!upRes.rows.length) return res.redirect('/campaigns/' + campId);
    const up = upRes.rows[0];

    // Reverse the phone counts from Redis memory for this campaign
    const memory = await loadMemory();
    let reversed = 0;
    Object.keys(memory).forEach(k => {
      if (k.startsWith('campaign:' + campId + '||')) {
        // Subtract the upload count contribution — set to 0 minimum
        if (memory[k].count > 0) {
          memory[k].count = Math.max(0, memory[k].count - 1);
          reversed++;
        }
      }
    });
    await saveMemory(memory);

    // Delete the upload record (tenant-scoped — prevents cross-tenant by id)
    await dbQ('DELETE FROM campaign_uploads WHERE id=$1 AND tenant_id=$2', [uploadId, req.tenantId]);

    // Recalculate campaign totals from remaining uploads
    const totals = await dbQ(`
      SELECT
        COALESCE(SUM(total_records),0) as total,
        COALESCE(SUM(records_kept),0) as kept,
        COALESCE(SUM(records_filtered),0) as filtered,
        COALESCE(SUM(wrong_numbers),0) as wrong,
        COALESCE(SUM(voicemails),0) as vm,
        COALESCE(SUM(not_interested),0) as ni,
        COALESCE(SUM(do_not_call),0) as dnc,
        COALESCE(SUM(transfers),0) as transfer,
        COALESCE(SUM(connected),0) as connected,
        COUNT(*) as upload_count
      FROM campaign_uploads WHERE campaign_id=$1 AND tenant_id=$2`, [campId, req.tenantId]);

    const t = totals.rows[0];
    await dbQ(`UPDATE campaigns SET
      total_unique_numbers=$1, total_callable=$2, total_filtered=$3,
      total_wrong_numbers=$4, total_voicemails=$5, total_not_interested=$6,
      total_do_not_call=$7, total_transfers=$8, total_connected=$9,
      upload_count=$10, updated_at=NOW()
      WHERE id=$11 AND tenant_id=$12`,
      [t.total, t.kept, t.filtered, t.wrong, t.vm, t.ni, t.dnc, t.transfer, t.connected, t.upload_count, campId, req.tenantId]);

    res.redirect('/campaigns/' + campId);
  } catch(e) {
    console.error('Delete upload error:', e.message);
    res.redirect('/oculah/campaigns/' + req.params.id);
  }
});


// Reset campaign stats — clears numbers, uploads, and campaign-scoped Redis keys
app.post('/campaigns/:id/reset', requireAuth, async (req, res) => {
  try {
    if (!(await _requireOwnedCampaign(req, res))) return;
    const { query: dbQ } = require('./db');
    const campId = req.params.id;

    // Clear campaign numbers and uploads from DB (tenant-scoped)
    await dbQ('DELETE FROM campaign_numbers WHERE campaign_id=$1 AND tenant_id=$2', [campId, req.tenantId]);
    await dbQ('DELETE FROM campaign_uploads WHERE campaign_id=$1 AND tenant_id=$2', [campId, req.tenantId]);

    // Reset all campaign totals to zero
    await dbQ(`UPDATE campaigns SET
      total_unique_numbers=0, total_callable=0, total_filtered=0,
      total_wrong_numbers=0, total_voicemails=0, total_not_interested=0,
      total_do_not_call=0, total_transfers=0, total_connected=0,
      upload_count=0, updated_at=NOW()
      WHERE id=$1 AND tenant_id=$2`, [campId, req.tenantId]);

    // Clear campaign-scoped Redis memory keys
    const memory = await loadMemory();
    const prefix = 'campaign:' + campId + '||';
    let cleared = 0;
    Object.keys(memory).forEach(k => {
      if (k.startsWith(prefix)) { delete memory[k]; cleared++; }
    });
    await saveMemory(memory);
    console.log('[reset] Campaign', campId, '— cleared', cleared, 'Redis keys');

    res.redirect('/campaigns/' + campId);
  } catch(e) {
    console.error('Reset campaign error:', e.message);
    res.redirect('/oculah/campaigns/' + req.params.id);
  }
});

// Delete campaign
app.post('/campaigns/:id/delete', requireAuth, async (req, res) => {
  try {
    const { query: dbQ } = require('./db');
    const id = req.params.id;
    // Only allow deleting completed campaigns. tenant_id check on both
    // SELECT and DELETE — prevents cross-tenant cascade-delete via guessed
    // SERIAL ids.
    const campRes = await dbQ('SELECT status FROM campaigns WHERE id=$1 AND tenant_id=$2', [id, req.tenantId]);
    if (!campRes.rows.length) return res.redirect('/campaigns');
    if (campRes.rows[0].status !== 'completed') return res.redirect('/campaigns/' + id);
    // Cascade delete — uploads, numbers, contacts, phones all cascade via FK
    await dbQ('DELETE FROM campaigns WHERE id=$1 AND tenant_id=$2', [id, req.tenantId]);
    res.redirect('/campaigns');
  } catch(e) {
    console.error('Delete campaign error:', e.message);
    res.redirect('/campaigns');
  }
});

// ── Campaign HTML Pages ───────────────────────────────────────────────────────

const STATUS_COLORS = { active: '#1a7a4a', paused: '#9a6800', completed: '#888' };
const CHANNEL_LABELS = { cold_call: 'Cold Call', sms: 'SMS' };

function campaignsPage(list, tab) {
  tab = tab || 'active';
  const active = list.filter(c => c.status !== 'completed');
  const completed = list.filter(c => c.status === 'completed');
  const display = tab === 'completed' ? completed : active;
  // 2026-04-21 PM: running total of leads across ALL campaigns (active +
  // completed combined) so the headline number reflects total lead volume
  // regardless of which tab is selected. Per-row leads render in the Leads
  // column below so users can see which campaigns contributed. Uses the
  // same lead_contacts field the per-campaign detail page + the dashboard
  // both read — single source of truth (filtration.getContactStats, which
  // counts campaign_numbers.last_disposition_normalized='transfer').
  // 2026-04-21 PM v3: total uses c.total_transfers — same source as the
  // per-row Leads column and the dashboard "Leads" card. All three stats
  // now reconcile to SUM(campaigns.total_transfers). See comment on
  // getDashboardStats() for the full history of why this changed.
  const totalLeads = list.reduce((sum, c) => sum + parseInt(c.total_transfers || 0), 0);
  const rows = display.map(c => {
    const totalContacts = parseInt(c.contact_counts?.total_contacts||0);
    const totalPhones = parseInt(c.contact_counts?.total_phones||0);
    const wrongPhones = parseInt(c.contact_counts?.wrong_phones||0);
    const nisPhones = parseInt(c.contact_counts?.nis_phones||0);
    const filteredPhones = parseInt(c.contact_counts?.filtered_phones||0);
    // Approximate callable contacts: total contacts × (callable phones ÷ total phones)
    const callablePhones = Math.max(0, totalPhones - wrongPhones - nisPhones - filteredPhones);
    const callableContacts = totalPhones > 0
      ? Math.round((callablePhones / totalPhones) * totalContacts)
      : totalContacts;
    const connected = parseInt(c.total_connected||0);
    const transfers = parseInt(c.total_transfers||0);
    const lgr = connected > 0 ? ((transfers / connected) * 100).toFixed(2) : '0.00';
    // 2026-04-21 PM v3: Leads column reads c.total_transfers — the same
    // counter shown on the campaign detail page. Previously the column
    // read contact_counts.lead_contacts (the narrow campaign_numbers
    // transfer query) which missed SMS leads. c.total_transfers is
    // incremented at ingest for transfer + potential_lead + sold + listed
    // across BOTH cold-call and SMS paths, so the column matches what
    // users see when they click into any individual campaign.
    const leadContacts = transfers;
    return `
    <tr onclick="location.href='/campaigns/${c.id}'" style="cursor:pointer">
      <td><strong>${c.name}</strong><br><span style="font-size:11px;color:#888">${c.list_type} · ${c.market_name}</span></td>
      <td><span class="badge" style="background:${STATUS_COLORS[c.status]}20;color:${STATUS_COLORS[c.status]}">${c.status}</span></td>
      <td><span class="badge" style="background:${c.active_channel==='sms'?'#f0e6fb':'#e6f1fb'};color:${c.active_channel==='sms'?'#7b2fa5':'#185fa5'}">${CHANNEL_LABELS[c.active_channel]||c.active_channel}</span></td>
      <td style="font-size:12px">${c.start_date ? new Date(c.start_date).toLocaleDateString() : '—'}</td>
      <td style="font-size:12px;color:#888">${c.end_date ? new Date(c.end_date).toLocaleDateString() : '—'}</td>
      <td>${Number(totalContacts).toLocaleString()}</td>
      <td>${lgr}%</td>
      <td style="color:#1a7a4a">${Number(callableContacts).toLocaleString()}</td>
      <td style="color:#1a7a4a;font-weight:${leadContacts > 0 ? '600' : '400'}">${Number(leadContacts).toLocaleString()}</td>
      <td>${c.upload_count||0}</td>
    </tr>`;
  }).join('');

  return shell('Campaigns', `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.5rem">
      <div><h2 style="font-size:20px;font-weight:500;margin-bottom:3px">Campaigns</h2>
      <p style="font-size:13px;color:#888">Each campaign tracks all filtration activity for a list type in a market</p></div>
      <a href="/campaigns/new" class="btn-primary-link">+ New Campaign</a>
    </div>
    <div style="display:flex;gap:2px;border-bottom:1px solid #e0dfd8;margin-bottom:1.25rem;align-items:center">
      <a href="/campaigns?tab=active" style="padding:8px 16px;font-size:13px;text-decoration:none;border-bottom:2px solid ${tab==='active'?'#1a1a1a':'transparent'};color:${tab==='active'?'#1a1a1a':'#888'}">Active (${active.length})</a>
      <a href="/campaigns?tab=completed" style="padding:8px 16px;font-size:13px;text-decoration:none;border-bottom:2px solid ${tab==='completed'?'#1a1a1a':'transparent'};color:${tab==='completed'?'#1a1a1a':'#888'}">Completed (${completed.length})</a>
      <!-- 2026-04-21 PM: running total of leads across ALL campaigns
           (active + completed combined). Stays constant when switching tabs. -->
      <div style="margin-left:auto;padding:6px 14px;background:#e8f5ed;color:#1a7a4a;border-radius:7px;font-size:13px;font-weight:600">
        ${Number(totalLeads).toLocaleString()} leads <span style="font-weight:400;color:#5a8a6a;font-size:11px;text-transform:uppercase;letter-spacing:.05em">total</span>
      </div>
    </div>
    ${display.length === 0 ? `<div class="empty-state">No ${tab} campaigns yet.</div>` : `
    <div class="card" style="padding:0;overflow:hidden">
      <table class="data-table">
        <thead><tr><th>Campaign</th><th>Status</th><th>Channel</th><th>Start date</th><th>End date</th><th>Total Contacts</th><th>LGR</th><th>Callable Contacts</th><th>Leads</th><th>Uploads</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`}
  `, 'campaigns');
}

function newCampaignPage(error, listTypes, user) {
  const LIST_TYPES = listTypes && listTypes.length ? listTypes : ['Vacant Property','Pre-Foreclosure','Active Liens','2+ Mortgages','Absentee Owner','Tax Delinquent','Probate','Code Violation','Pre-Probate','Other'];
  const STATES = ['IN','GA','TX','FL','OH','MI','IL','NC','TN','MO','AZ','CO','NV','PA','NY','Other'];
  return shell('New Campaign', `
    <div class="ocu-page-header">
      <div>
        <div style="margin-bottom:6px"><a href="/oculah/campaigns" class="ocu-text-3" style="font-size:13px;text-decoration:none">← Campaigns</a></div>
        <h1 class="ocu-page-title">New campaign</h1>
        <div class="ocu-page-subtitle">Create a campaign to start tracking filtration activity</div>
      </div>
    </div>

    ${error ? `<div class="ocu-card" style="margin-bottom:16px;background:#fdeaea;border-color:#f5c5c5;color:#8b1f1f;padding:12px 16px;font-size:13px;max-width:580px">${error}</div>` : ''}

    <div class="ocu-card" style="max-width:580px;padding:22px 24px">
      <form method="POST" action="/campaigns/new">
        <div style="margin-bottom:14px">
          <label class="ocu-form-label">Campaign name</label>
          <input type="text" name="name" placeholder="e.g. Vacant Property Indiana 2026" required class="ocu-input" />
          <div class="ocu-text-3" style="font-size:11px;margin-top:4px">This is what you'll select when uploading filtration files.</div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">
          <div>
            <label class="ocu-form-label">List type</label>
            <select name="list_type" id="list_type_select" class="ocu-input"
                    onchange="document.getElementById('custom_lt_wrap').style.display=this.value==='__new__'?'block':'none';document.getElementById('custom_lt_input').required=this.value==='__new__'">
              <option value="">Select…</option>
              ${LIST_TYPES.map(t=>`<option value="${t}">${t}</option>`).join('')}
              <option value="__new__">+ Add new list type…</option>
            </select>
            <div id="custom_lt_wrap" style="display:none;margin-top:8px">
              <input type="text" id="custom_lt_input" name="custom_list_type" placeholder="Enter new list type" maxlength="100" class="ocu-input" />
              <div class="ocu-text-3" style="font-size:11px;margin-top:4px">Saved for future campaigns.</div>
            </div>
          </div>
          <div>
            <label class="ocu-form-label">State</label>
            <select name="state_code" required class="ocu-input">
              <option value="">Select…</option>
              ${STATES.map(s=>`<option value="${s}">${s}</option>`).join('')}
            </select>
          </div>
        </div>

        <div style="margin-bottom:14px">
          <label class="ocu-form-label">Market name</label>
          <input type="text" name="market_name" placeholder="e.g. Indianapolis Metro" required class="ocu-input" />
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">
          <div>
            <label class="ocu-form-label">Start date</label>
            <input type="date" name="start_date" value="${new Date().toISOString().split('T')[0]}" class="ocu-input" />
          </div>
          <div>
            <label class="ocu-form-label">Active channel</label>
            <select name="active_channel" class="ocu-input">
              <option value="cold_call">Cold call</option>
              <option value="sms">SMS</option>
            </select>
          </div>
        </div>

        <div style="margin-bottom:18px">
          <label class="ocu-form-label">Notes <span class="ocu-text-3" style="font-weight:400">(optional)</span></label>
          <textarea name="notes" rows="2" placeholder="Any notes about this campaign…" class="ocu-textarea"></textarea>
        </div>

        <div style="display:flex;gap:8px;justify-content:flex-end">
          <a href="/oculah/campaigns" class="ocu-btn ocu-btn-ghost">Cancel</a>
          <button type="submit" class="ocu-btn ocu-btn-primary">Create campaign</button>
        </div>
      </form>
    </div>
  `, 'campaigns', user);
}

function nisPage(stats, msg, user) {
  const fmtNum = (n) => Number(n || 0).toLocaleString('en-US');
  const lastUpload = stats.last_upload
    ? new Date(stats.last_upload).toLocaleString('en-US', {
        year:'numeric', month:'short', day:'numeric', hour:'numeric', minute:'2-digit',
      })
    : 'Never';

  return shell('NIS Numbers', `
    <div class="ocu-page-header">
      <div>
        <h1 class="ocu-page-title">NIS Numbers</h1>
        <div class="ocu-page-subtitle">Upload Readymode Detailed NIS exports to flag dead numbers across every active campaign</div>
      </div>
    </div>

    ${msg ? `<div class="ocu-card" style="margin-bottom:16px;background:#e8f5ee;border-color:#9bd0a8;color:#1a5f1a;padding:12px 16px;font-size:13px">${escHTML(msg)}</div>` : ''}

    <div class="ocu-kpi-row" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr));margin-bottom:18px">
      <div class="ocu-kpi featured">
        <div class="ocu-kpi-label">Total NIS numbers</div>
        <div class="ocu-kpi-value">${fmtNum(stats.total_nis)}</div>
        <div class="ocu-kpi-delta">In database</div>
      </div>
      <div class="ocu-kpi">
        <div class="ocu-kpi-label">Flagged phones</div>
        <div class="ocu-kpi-value burning">${fmtNum(stats.total_flagged)}</div>
        <div class="ocu-kpi-delta">Across all campaigns</div>
      </div>
      <div class="ocu-kpi">
        <div class="ocu-kpi-label">Last upload</div>
        <div class="ocu-kpi-value" style="font-size:15px;font-weight:500">${lastUpload}</div>
      </div>
    </div>

    <div class="ocu-card" style="max-width:680px;padding:20px 22px">
      <div style="font-size:15px;font-weight:600;margin-bottom:8px;color:var(--ocu-text-1)">Upload NIS file</div>
      <div style="font-size:13px;color:var(--ocu-text-2);margin-bottom:16px;line-height:1.5">
        Drop a Readymode Detailed NIS CSV. The file must have a
        <code style="background:var(--ocu-surface);padding:1px 6px;border-radius:4px;font-size:12px;font-family:'JetBrains Mono',ui-monospace,monospace">dialed</code>
        column with phone numbers and a
        <code style="background:var(--ocu-surface);padding:1px 6px;border-radius:4px;font-size:12px;font-family:'JetBrains Mono',ui-monospace,monospace">day</code>
        column with the NIS date.
      </div>
      <form method="POST" action="/nis/upload" enctype="multipart/form-data" style="display:flex;flex-direction:column;gap:12px">
        <input type="file" name="nisfile" accept=".csv" required class="ocu-input" style="padding:8px 10px" />
        <div style="display:flex;justify-content:flex-end">
          <button type="submit" class="ocu-btn ocu-btn-primary">Upload and flag</button>
        </div>
      </form>
    </div>
  `, 'nis', user);
}

function changelogPage(user) {
  return shell('Changelog', changelogModule.renderChangelog(), 'changelog', user);
}



// ── Shared shell ─────────────────────────────────────────────────────────────
const { shell } = require('./shared-shell');
