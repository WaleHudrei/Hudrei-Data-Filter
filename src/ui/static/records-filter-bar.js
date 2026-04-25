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

  const STORAGE_KEY = 'ocularFilterPanelOpen';

  const toggle  = document.getElementById('ocu-filter-toggle');
  const panel   = document.getElementById('ocu-filter-panel');
  if (!toggle || !panel) return;

  // ─── Panel open/close ─────────────────────────────────────────────────────
  function setPanelOpen(open) {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.classList.toggle('open', open);
    try { localStorage.setItem(STORAGE_KEY, open ? '1' : '0'); } catch (_) {}
  }

  // Initial state: open if any filter is active (so users see why the count
  // badge is non-zero), or if localStorage previously had it open.
  // Otherwise default to closed.
  const hasActiveFilters = !!toggle.querySelector('.ocu-filter-toggle-count');
  let initialOpen = false;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === '1') initialOpen = true;
  } catch (_) {}
  if (hasActiveFilters) initialOpen = true;
  setPanelOpen(initialOpen);

  toggle.addEventListener('click', () => setPanelOpen(panel.hidden));

  // ─── State multi-select popover ───────────────────────────────────────────
  const stateBtn      = document.getElementById('ocu-state-button');
  const statePopover  = document.getElementById('ocu-state-popover');
  const stateSearch   = document.getElementById('ocu-state-search');
  const stateList     = document.getElementById('ocu-state-list');
  const stateClear    = document.getElementById('ocu-state-clear');
  const stateDone     = document.getElementById('ocu-state-done');
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
    stateDone.addEventListener('click', closeStatePopover);
  }

  // Tiny HTML-escape for client-side rendering of state codes (always 2 letters,
  // but we still escape defensively in case of unexpected values).
  function escapeHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
})();
