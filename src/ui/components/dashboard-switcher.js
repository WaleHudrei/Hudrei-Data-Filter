// ═══════════════════════════════════════════════════════════════════════════
// ui/components/dashboard-switcher.js
// Renders the dropdown trigger that swaps between dashboard views (Main /
// Executive / Campaign analytics). Drops into the topbar via shell({
// topbarTitleHTML }) so the active view name appears as the inline trigger
// while the static word "Dashboard" lives next to it.
//
// Server-rendered HTML; client JS lives in src/ui/static/dashboard-switcher.js
// and handles popover open/close + the "Set as default" POST.
// ═══════════════════════════════════════════════════════════════════════════
const { escHTML } = require('../_helpers');

// Single source of truth for the view registry. Add a new entry here +
// route handler in ocular-routes.js to ship a new dashboard.
const VIEWS = [
  { id: 'main',      label: 'Main',               href: '/oculah/dashboard/main' },
  { id: 'executive', label: 'Executive',          href: '/oculah/dashboard/executive' },
  { id: 'analytics', label: 'Campaign analytics', href: '/oculah/dashboard/analytics' },
];

function isValidViewId(id) {
  return VIEWS.some(v => v.id === id);
}

function getView(id) {
  return VIEWS.find(v => v.id === id) || VIEWS[0];
}

// Renders the topbar title HTML: "[Active view name ▼] Dashboard"
// where the [...] piece is a button that opens the view popover.
function dashboardSwitcher({ active = 'main', defaultView = 'main' } = {}) {
  const current = getView(active);
  // Each item shows just the view name — the popover header makes it clear
  // we're picking a Dashboard, so doubling the word on every row caused
  // "Campaign analytics" to wrap onto two lines and look broken.
  const items = VIEWS.map(v => {
    const isActive  = v.id === active;
    const isDefault = v.id === defaultView;
    return `
      <a class="ocu-dsw-item${isActive ? ' active' : ''}" href="${escHTML(v.href)}">
        <span class="ocu-dsw-item-label">${escHTML(v.label)}</span>
        <span class="ocu-dsw-item-meta">
          ${isDefault ? '<span class="ocu-dsw-default-pill">Default</span>' : ''}
          ${!isDefault ? `<button type="button" class="ocu-dsw-set-default" data-view="${escHTML(v.id)}" title="Set as default">Set default</button>` : ''}
          ${isActive ? '<span class="ocu-dsw-check">✓</span>' : ''}
        </span>
      </a>`;
  }).join('');

  // The whole title — "Main Dashboard ⌄" — IS the trigger. One element, one
  // hit target. Cleaner than a separate "View" chip floating next to the
  // page title, which read as two competing UI elements at slightly
  // different sizes.
  return `
    <span class="ocu-dsw-wrap" id="ocu-dsw">
      <button type="button" class="ocu-dsw-trigger" id="ocu-dsw-trigger"
              aria-haspopup="true" aria-expanded="false"
              title="Switch dashboard view">
        <span class="ocu-dsw-trigger-label">${escHTML(current.label)} Dashboard</span>
        <svg class="ocu-dsw-chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>
      <div class="ocu-dsw-popover" id="ocu-dsw-popover" hidden>
        <div class="ocu-dsw-popover-header">Switch dashboard</div>
        ${items}
      </div>
    </span>`;
}

module.exports = { dashboardSwitcher, VIEWS, isValidViewId, getView };
