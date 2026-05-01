// ═══════════════════════════════════════════════════════════════════════════
// src/error-monitor.js — Phase 2 finalization: Sentry integration.
//
// Plan reference (docs/saas-conversion-plan.md, "Cross-cutting → Monitoring"):
//
//     Errors: Sentry or LogTail. Capture unhandled exceptions and
//     500-level responses.
//
// Design choices:
//
//   * Env-gated: only initializes when SENTRY_DSN is set. Without it, every
//     export is a no-op (init returns false; captureError returns false).
//     Lets us ship the wiring without forcing anyone to create a Sentry
//     account before public launch.
//
//   * `tracesSampleRate` defaults to 0 (errors only). Set
//     SENTRY_TRACES_SAMPLE_RATE if you want performance tracing.
//
//   * Tenant context: when we have a request, attach
//     `tenant_id` + `user_id` as Sentry tags via setTag. Errors get
//     filtered/grouped by tenant on the Sentry side. No PII (no email).
//
//   * Two functions: requestHandler() + errorHandler() return Express
//     middleware that's only meaningful when Sentry is enabled. When
//     disabled, both return no-op middleware. Caller can wire them
//     unconditionally.
// ═══════════════════════════════════════════════════════════════════════════

let _sentry = null;
let _enabled = false;

function _isConfigured() {
  return !!process.env.SENTRY_DSN;
}

function init() {
  if (!_isConfigured()) {
    console.log('[sentry] disabled — set SENTRY_DSN to enable error reporting');
    return false;
  }
  if (_enabled) return true;
  try {
    _sentry = require('@sentry/node');
    _sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV || 'development',
      // Default to errors-only. Tracing is expensive and not what the plan
      // asked for; opt in via SENTRY_TRACES_SAMPLE_RATE when actually needed.
      tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0'),
      // Don't ship request body / headers by default — could leak credentials
      // or PII. Operator can override via SENTRY_SEND_DEFAULT_PII=true if
      // their threat model accepts it.
      sendDefaultPii: String(process.env.SENTRY_SEND_DEFAULT_PII || '').toLowerCase() === 'true',
      release: process.env.RAILWAY_DEPLOYMENT_ID || process.env.GIT_COMMIT_SHA || undefined,
    });
    _enabled = true;
    console.log('[sentry] initialized');
    return true;
  } catch (e) {
    console.error('[sentry] init failed (non-fatal):', e.message);
    _sentry = null;
    _enabled = false;
    return false;
  }
}

/**
 * Express middleware that attaches tenant + user identifiers to the Sentry
 * scope for any error reported during this request. Cheap when disabled
 * (single boolean check + next).
 */
function requestHandler() {
  return (req, res, next) => {
    if (!_enabled) return next();
    try {
      _sentry.withScope((scope) => {
        if (req.session && req.session.tenantId) {
          scope.setTag('tenant_id', String(req.session.tenantId));
        }
        if (req.session && req.session.userId) {
          scope.setUser({ id: String(req.session.userId) });
        }
        scope.setTag('route', req.method + ' ' + (req.route?.path || req.path || ''));
      });
    } catch (e) { /* never let monitoring break the app */ }
    next();
  };
}

/**
 * Express error-handler middleware. Mounts AFTER all routes. Forwards the
 * error to next() so Express's default handler (or any subsequent handler)
 * still runs — we just side-effect-report to Sentry first.
 */
function errorHandler() {
  return (err, req, res, next) => {
    if (_enabled && err) {
      try { _sentry.captureException(err); } catch (e) { /* swallow */ }
    }
    next(err);
  };
}

/**
 * Manually capture an error (e.g. from a try/catch inside a job worker).
 * Returns true when reported, false when disabled.
 */
function captureError(err, extra) {
  if (!_enabled || !err) return false;
  try {
    if (extra && typeof extra === 'object') {
      _sentry.withScope((scope) => {
        for (const [k, v] of Object.entries(extra)) {
          if (v != null) scope.setExtra(k, v);
        }
        _sentry.captureException(err);
      });
    } else {
      _sentry.captureException(err);
    }
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = { init, requestHandler, errorHandler, captureError };
