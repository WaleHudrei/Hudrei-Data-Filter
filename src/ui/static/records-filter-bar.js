/* ═══════════════════════════════════════════════════════════════════════════
   ui/static/records-filter-bar.js
   Filter bar interactions for /ocular/records:
     - Toggle the filter panel open/closed (state persisted in localStorage)
     - State multi-select popover with type-to-filter search
     - Auto-open the panel if any filter is active on initial load
   Loaded only on the records list page.
   ═══════════════════════════════════════════════════════════════════════════ */
(function() {
  'use strict';

  const toggle  = document.getElementById('ocu-filter-toggle');
  const panel   = document.getElementById('ocu-filter-panel');
  if (!toggle || !panel) return;

  // ─── Panel open/close ─────────────────────────────────────────────────────
  // 2026-04-29 Tier-3 follow-up: removed the localStorage persistence and the
  // "auto-open if filters are active" behavior. Pre-fix the panel re-opened
  // on every page load whenever the URL had any filter param OR localStorage
  // had previously been '1' — which made users think the panel "popped out
  // automatically without me touching it." Now: always closed on initial
  // page load. The active-filter count badge on the toggle button still
  // tells users which filters are applied, and clicking the toggle opens it.
  function setPanelOpen(open) {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.classList.toggle('open', open);
  }

  setPanelOpen(false);
  toggle.addEventListener('click', () => setPanelOpen(panel.hidden));

  // ─── State multi-select popover ───────────────────────────────────────────
  const stateBtn      = document.getElementById('ocu-state-button');
  const statePopover  = document.getElementById('ocu-state-popover');
  const stateSearch   = document.getElementById('ocu-state-search');
  const stateList     = document.getElementById('ocu-state-list');
  const stateClear    = document.getElementById('ocu-state-clear');
  // 2026-04-29: stateDone removed — Apply lives at form level only.
  const stateDone     = document.getElementById('ocu-state-done'); // null after rename; guarded below
  const stateBtnText  = stateBtn ? stateBtn.querySelector('.ocu-state-button-text') : null;
  const stateBtnPills = stateBtn ? stateBtn.querySelector('.ocu-state-button-pills') : null;

  if (stateBtn && statePopover) {
    function openStatePopover() {
      statePopover.hidden = false;
      stateBtn.setAttribute('aria-expanded', 'true');
      // Reset search filter every time we open
      stateSearch.value = '';
      filterStateOptions('');
      // Defer focus so click that opened the popover doesn't immediately blur
      setTimeout(() => stateSearch.focus(), 0);
    }
    function closeStatePopover() {
      statePopover.hidden = true;
      stateBtn.setAttribute('aria-expanded', 'false');
    }
    stateBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (statePopover.hidden) openStatePopover();
      else closeStatePopover();
    });
    document.addEventListener('click', e => {
      if (statePopover.hidden) return;
      if (statePopover.contains(e.target) || stateBtn.contains(e.target)) return;
      closeStatePopover();
    });
    // Escape key closes popover
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !statePopover.hidden) closeStatePopover();
    });

    // Type-to-filter the option list. Each option has data-search="code name lc".
    function filterStateOptions(query) {
      const q = String(query || '').toLowerCase().trim();
      stateList.querySelectorAll('.ocu-state-opt').forEach(opt => {
        const haystack = opt.dataset.search || '';
        opt.hidden = q && haystack.indexOf(q) === -1;
      });
    }
    stateSearch.addEventListener('input', () => filterStateOptions(stateSearch.value));

    // Update the button label whenever a checkbox flips
    function refreshStateButton() {
      const checked = stateList.querySelectorAll('input[name="state"]:checked');
      const codes = Array.from(checked).map(i => i.value);
      stateBtnText.textContent = codes.length === 0
        ? 'Any state'
        : (codes.length === 1 ? '1 state' : codes.length + ' states');
      stateBtnPills.innerHTML = codes
        .map(c => '<span class="ocu-state-pill">' + escapeHTML(c) + '</span>')
        .join('');
    }
    stateList.addEventListener('change', e => {
      if (e.target && e.target.matches('input[name="state"]')) refreshStateButton();
    });

    // Clear / Done buttons
    stateClear.addEventListener('click', () => {
      stateList.querySelectorAll('input[name="state"]').forEach(i => { i.checked = false; });
      refreshStateButton();
    });
    if (stateDone) stateDone.addEventListener('click', closeStatePopover);
  }

  // Tiny HTML-escape for client-side rendering of state codes (always 2 letters,
  // but we still escape defensively in case of unexpected values).
  function escapeHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
})();
