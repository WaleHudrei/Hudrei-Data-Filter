/* ═══════════════════════════════════════════════════════════════════════════
   csrf-protect.js — auto-attach CSRF token to every state-changing request.

   Loaded by both shells (legacy + Ocular) so this script runs on every
   page. It does two things, both transparently:

     1. Wraps window.fetch — every non-GET fetch automatically gets the
        x-csrf-token header.

     2. Adds a delegated `submit` listener — every non-GET form gets a
        hidden _csrf input injected before it submits.

   Reads the token from <meta name="csrf-token"> rendered by the server
   shell. If the meta tag is absent (unauthenticated landing pages, etc.)
   this script is a no-op.

   Why both fetch + form injection? Because the codebase uses both:
     * Newer Ocular UI uses fetch() for inline writes (phone status,
       tag add/remove, owner edit dialog).
     * Legacy Loki UI submits raw <form action=POST>.

   No-op design: if everything is already in order (token present, header
   already attached), the script just runs and does nothing visible.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  function getToken() {
    var el = document.querySelector('meta[name="csrf-token"]');
    return el ? el.getAttribute('content') : '';
  }

  // Read once on script load; will hold the value for the page lifetime.
  // If a fetch fires before meta is in the DOM (very early script tag),
  // we re-read on each fetch — cheap.
  var TOKEN = getToken();

  // ── fetch() wrapper ─────────────────────────────────────────────────────
  if (typeof window.fetch === 'function') {
    var origFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      init = init || {};
      var method = String(init.method || 'GET').toUpperCase();
      // Safe methods don't need the header.
      if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
        return origFetch(input, init);
      }
      var token = TOKEN || getToken();
      if (!token) return origFetch(input, init);
      // Build a fresh Headers object so we don't mutate caller-provided ones.
      var hdrs;
      if (init.headers instanceof Headers) {
        hdrs = new Headers(init.headers);
      } else if (Array.isArray(init.headers)) {
        hdrs = new Headers(init.headers);
      } else if (init.headers && typeof init.headers === 'object') {
        hdrs = new Headers(init.headers);
      } else {
        hdrs = new Headers();
      }
      // Don't overwrite if caller already set one — they might know better.
      if (!hdrs.has('x-csrf-token')) {
        hdrs.set('x-csrf-token', token);
      }
      init.headers = hdrs;
      return origFetch(input, init);
    };
  }

  // ── XHR wrapper (some legacy code uses XMLHttpRequest directly) ─────────
  if (typeof window.XMLHttpRequest === 'function') {
    var origOpen = XMLHttpRequest.prototype.open;
    var origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__csrfMethod = String(method || '').toUpperCase();
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      var m = this.__csrfMethod || 'GET';
      if (m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS') {
        var token = TOKEN || getToken();
        if (token) {
          try { this.setRequestHeader('x-csrf-token', token); } catch (_) {}
        }
      }
      return origSend.apply(this, arguments);
    };
  }

  // ── delegated form-submit injector ──────────────────────────────────────
  // Capture phase so we run before any form's own submit handler. We
  // skip GET forms and skip forms that already have an _csrf input
  // (e.g. someone has already added one explicitly).
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (!(f instanceof HTMLFormElement)) return;
    var method = String(f.method || 'get').toLowerCase();
    if (method !== 'post') return;
    if (f.querySelector('input[name="_csrf"]')) return;
    var token = TOKEN || getToken();
    if (!token) return;
    var input = document.createElement('input');
    input.type = 'hidden';
    input.name = '_csrf';
    input.value = token;
    f.appendChild(input);
  }, true);

  // Re-read the token if it gets rotated mid-page (rare; future-proofing).
  document.addEventListener('DOMContentLoaded', function () {
    var t = getToken();
    if (t) TOKEN = t;
  });
})();
