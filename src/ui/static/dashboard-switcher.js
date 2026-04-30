// ═══════════════════════════════════════════════════════════════════════════
// dashboard-switcher.js — client controller for the dashboard view dropdown
// in the topbar. Pure DOM, no framework.
//
// Server-rendered HTML lives in src/ui/components/dashboard-switcher.js.
// We just wire:
//   - Click trigger → toggle popover
//   - Outside-click / Escape → close
//   - Click "Set default" → POST /oculah/dashboard/set-default and update UI
// ═══════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  function init() {
    var trigger = document.getElementById('ocu-dsw-trigger');
    var popover = document.getElementById('ocu-dsw-popover');
    if (!trigger || !popover) return;

    function open()  { popover.hidden = false; trigger.setAttribute('aria-expanded', 'true'); }
    function close() { popover.hidden = true;  trigger.setAttribute('aria-expanded', 'false'); }
    function toggle() { popover.hidden ? open() : close(); }

    trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      toggle();
    });

    // Outside click closes
    document.addEventListener('click', function (e) {
      if (popover.hidden) return;
      var wrap = document.getElementById('ocu-dsw');
      if (wrap && !wrap.contains(e.target)) close();
    });

    // Escape closes
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !popover.hidden) close();
    });

    // "Set as default" buttons — don't trigger the surrounding <a> nav,
    // POST the user preference, swap the row UI to show "Default" pill.
    popover.addEventListener('click', function (e) {
      var btn = e.target.closest('.ocu-dsw-set-default');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      var view = btn.getAttribute('data-view');
      btn.disabled = true;
      btn.textContent = 'Saving…';
      fetch('/oculah/dashboard/set-default', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        credentials: 'same-origin',
        body: 'view=' + encodeURIComponent(view),
      })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('save-failed')); })
      .then(function () {
        // Swap the "Default" pill onto the chosen row, remove it from others.
        popover.querySelectorAll('.ocu-dsw-item').forEach(function (item) {
          var meta = item.querySelector('.ocu-dsw-item-meta');
          if (!meta) return;
          var oldPill = meta.querySelector('.ocu-dsw-default-pill');
          if (oldPill) oldPill.remove();
          var oldBtn  = meta.querySelector('.ocu-dsw-set-default');
          if (oldBtn)  oldBtn.remove();
        });
        popover.querySelectorAll('.ocu-dsw-item').forEach(function (item) {
          var href = item.getAttribute('href') || '';
          var isThis = href.indexOf('/oculah/dashboard/' + view) === 0;
          var meta = item.querySelector('.ocu-dsw-item-meta');
          if (!meta) return;
          if (isThis) {
            var pill = document.createElement('span');
            pill.className = 'ocu-dsw-default-pill';
            pill.textContent = 'Default';
            meta.insertBefore(pill, meta.firstChild);
          } else {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'ocu-dsw-set-default';
            b.setAttribute('data-view', /\/dashboard\/([^/?#]+)/.exec(href)[1]);
            b.title = 'Set as default';
            b.textContent = 'Set default';
            meta.insertBefore(b, meta.firstChild);
          }
        });
      })
      .catch(function () {
        btn.disabled = false;
        btn.textContent = 'Set default';
        alert('Could not save default. Try again.');
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
