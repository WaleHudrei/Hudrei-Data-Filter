// ═══════════════════════════════════════════════════════════════════════════
// ui/layouts/shell.js
// The Ocular page shell — dark sidebar with cyan logo, light content area.
// Every Ocular page wraps its body in this. It's the equivalent of
// shared-shell.js but for the new design system.
// ═══════════════════════════════════════════════════════════════════════════
const { escHTML } = require('../_helpers');
const { ROLES } = require('../../auth/roles');

// Nav structure — one source of truth. Add items here, they appear in
// every page's sidebar. `adminOnly: true` hides the entry from tenant_user
// (regular workspace members); only tenant_admin and super_admin see it.
const NAV = [
  { section: 'Workspace', items: [
    // Analytics + Executive used to live as their own sidebar items. They're
    // now consolidated under Dashboard and accessed via the in-topbar
    // dashboard-switcher dropdown. Their old URLs (/oculah/analytics and
    // /oculah/exec) 301-redirect to /oculah/dashboard/{analytics,executive}.
    { id: 'dashboard',     href: '/oculah/dashboard',  label: 'Dashboard',     icon: 'grid' },
    { id: 'records',       href: '/oculah/records',    label: 'Records',       icon: 'box',   badge: 'records-count' },
    { id: 'owners',        href: '/oculah/owners',     label: 'Owners',        icon: 'users' },
    { id: 'campaigns',     href: '/oculah/campaigns',  label: 'Campaigns',     icon: 'phone' },
    { id: 'lists',         href: '/oculah/lists',      label: 'Lists',         icon: 'list' },
  ]},
  { section: 'Operations', items: [
    { id: 'upload',        href: '/oculah/upload',     label: 'Upload',        icon: 'upload' },
    { id: 'filtration',    href: '/oculah/filtration', label: 'List Filtration', icon: 'filter' },
    { id: 'activity',      href: '/oculah/activity',   label: 'Activity',      icon: 'activity' },
    { id: 'list-registry', href: '/oculah/lists/types', label: 'List Registry', icon: 'layers', badge: 'overdue-count' },
  ]},
  { section: 'System', items: [
    { id: 'settings',      href: '/oculah/setup',      label: 'Settings',      icon: 'settings' },
    { id: 'changelog',     href: '/changelog',         label: 'Changelog',     icon: 'history', adminOnly: true },
  ]},
];

// Inline SVG library — same icons across the app. Stroke-based, 24x24 viewBox.
const ICONS = {
  grid:     '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
  box:      '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>',
  users:    '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><path d="M20 8v6M23 11h-6"/>',
  phone:    '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
  list:     '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
  upload:   '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  filter:   '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  layers:   '<path d="M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>',
  shield:   '<path d="M12 2L4 5v6c0 5 3.5 9 8 11 4.5-2 8-6 8-11V5l-8-3z"/><line x1="4.5" y1="4.5" x2="19.5" y2="19.5"/>',
  history:  '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  bell:     '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  chevronLeft: '<polyline points="15 18 9 12 15 6"/>',
};

function navIcon(name) {
  return `<svg class="ocu-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">${ICONS[name] || ''}</svg>`;
}

/**
 * Render the full Ocular shell.
 *
 * @param {Object} opts
 *   - title: string — used in <title> tag
 *   - body: string — HTML for the main content area
 *   - activePage: string — id of the active nav item (matches NAV.items[].id)
 *   - user: { name, role, initials } — sidebar footer
 *   - badges: { 'records-count': '21,153', 'overdue-count': 3, ... }
 *      Map of nav-item badge ID → display value
 *   - searchPlaceholder: string (optional)
 *   - extraHead: string (optional) — page-specific <head> content
 */
function shell(opts = {}) {
  const {
    title = 'Oculah',
    body = '',
    activePage = '',
    user = { name: 'User', role: '', initials: '?' },
    badges = {},
    searchPlaceholder = 'Search records, owners, addresses…',
    extraHead = '',
    // Optional in-topbar page title. Pages that pass this should also drop
    // their own large H1 from the body so the heading isn't duplicated.
    // Currently used only by the Dashboard — opt-in per page to avoid a
    // wholesale UX change.
    topbarTitle = '',
    topbarTitleHTML = '',     // raw HTML alternative — bypasses escaping; use
                              // for pages that need an interactive trigger
                              // (e.g. dashboard switcher dropdown) inline
                              // with the topbar title.
    topbarSubtitle = '',     // optional smaller line below topbarTitle
  } = opts;

  // Top-bar search is only relevant on Records and Owners — every other page
  // (Settings, Changelog, Activity, Dashboard, Upload, Lists, etc.) either has
  // its own search UI or has nothing meaningful to search globally.
  const SEARCH_PAGES = new Set(['records', 'owners']);
  const showTopSearch = SEARCH_PAGES.has(activePage);
  const searchAction = activePage === 'owners' ? '/oculah/owners' : '/oculah/records';

  // RBAC: admin-only nav items (e.g. Changelog) are hidden from tenant_user.
  const userRole = (user && user.roleKey) || ROLES.TENANT_ADMIN;
  const isAdminRole = userRole === ROLES.TENANT_ADMIN || userRole === ROLES.SUPER_ADMIN;

  const navHTML = NAV.map(section => {
    const visibleItems = section.items.filter(it => !it.adminOnly || isAdminRole);
    if (!visibleItems.length) return '';
    return `
    <div class="ocu-nav-label">${escHTML(section.section)}</div>
    ${visibleItems.map(item => {
      const isActive = item.id === activePage;
      const badgeVal = item.badge ? badges[item.badge] : null;
      // Don't render the badge wrapper if value is null/undefined/empty.
      // Numeric 0 also hides — a "0 overdue" badge adds noise without info.
      const showBadge = badgeVal != null && badgeVal !== '' && badgeVal !== 0 && badgeVal !== '0';
      return `
        <a class="ocu-nav-item${isActive ? ' active' : ''}" href="${escHTML(item.href)}">
          ${navIcon(item.icon)}
          <span class="ocu-nav-text">${escHTML(item.label)}</span>
          ${showBadge ? `<span class="ocu-nav-badge">${escHTML(badgeVal)}</span>` : ''}
        </a>`;
    }).join('')}
  `;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escHTML(title)} · Oculah</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <!-- Visual-overhaul: Inter replaces Manrope. Higher legibility at the
       small data-table sizes that dominate Oculah pages. Includes the
       400-700 weight range we use across the design tokens. -->
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/oculah-static/oculah.css?v=61">
  ${extraHead}
</head>
<body class="ocu">

<div class="ocu-app" id="ocu-app">
  <aside class="ocu-sidebar">
    <div class="ocu-sidebar-header">
      <a class="ocu-logo" href="/oculah/dashboard">
        <div class="ocu-logo-mark">
          <svg viewBox="0 0 32 32">
            <circle class="letter-o" cx="16" cy="16" r="12"/>
            <line class="aperture" x1="16" y1="6" x2="16" y2="11"/>
            <line class="aperture" x1="16" y1="21" x2="16" y2="26"/>
            <line class="aperture" x1="6" y1="16" x2="11" y2="16"/>
            <line class="aperture" x1="21" y1="16" x2="26" y2="16"/>
            <circle class="center-dot" cx="16" cy="16" r="1.5"/>
          </svg>
        </div>
        <div class="ocu-logo-text">CULAH</div>
      </a>
      <!-- 2026-04-29 redesigned sidebar collapse button. The original was a
           floating cyan circle stuck on the sidebar's right edge — high
           contrast but looked like a sticker pasted on. This version sits
           inside the sidebar header next to the logo as a flat 28x28
           transparent button with a chevron icon. Hover shows a subtle
           white-on-dark surface tint. The chevron rotates 180° on collapse. -->
      <button class="ocu-sidebar-collapse" id="ocu-collapse"
              title="Collapse sidebar" aria-label="Collapse sidebar">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="15 18 9 12 15 6"/>
        </svg>
      </button>
    </div>
    <nav class="ocu-nav">${navHTML}</nav>
    <div class="ocu-sidebar-footer">
      <div class="ocu-avatar">${escHTML(user.initials || '?')}</div>
      <div class="ocu-user">
        <div class="ocu-user-name">${escHTML(user.name || 'User')}</div>
        <div class="ocu-user-role">${escHTML(user.role || '')}</div>
      </div>
      <a href="/logout" class="ocu-logout-btn" title="Sign out" aria-label="Sign out">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
      </a>
    </div>
  </aside>

  <main class="ocu-main">
    <div class="ocu-topbar">
      <div class="ocu-topbar-titlewrap">
        ${topbarTitleHTML
          ? `<div class="ocu-topbar-title">${topbarTitleHTML}</div>`
          : (topbarTitle ? `<div class="ocu-topbar-title">${escHTML(topbarTitle)}</div>` : '')}
        ${topbarSubtitle ? `<div class="ocu-topbar-subtitle">${escHTML(topbarSubtitle)}</div>` : ''}
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        ${showTopSearch ? `
        <form method="GET" action="${searchAction}" class="ocu-search-form" role="search">
          <input class="ocu-search" type="search" name="q" placeholder="${escHTML(searchPlaceholder)}">
        </form>` : ''}
        <button class="ocu-icon-btn" title="Notifications">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${ICONS.bell}</svg>
        </button>
      </div>
    </div>
    <div class="ocu-content">${body}</div>
  </main>
</div>

<script>
  // Sidebar collapse — pure JS, no framework. Persists across navigations
  // via localStorage so the user's preference sticks.
  (function() {
    var KEY = 'ocu.sidebarCollapsed';
    var app = document.getElementById('ocu-app');
    var btn = document.getElementById('ocu-collapse');
    if (!app || !btn) return;
    if (localStorage.getItem(KEY) === '1') app.classList.add('sidebar-collapsed');
    btn.addEventListener('click', function() {
      app.classList.toggle('sidebar-collapsed');
      localStorage.setItem(KEY, app.classList.contains('sidebar-collapsed') ? '1' : '0');
      // Chevron flips when collapsed (← becomes →)
      btn.style.transform = app.classList.contains('sidebar-collapsed') ? 'rotate(180deg)' : '';
    });
    if (app.classList.contains('sidebar-collapsed')) btn.style.transform = 'rotate(180deg)';
  })();
</script>

</body>
</html>`;
}

module.exports = { shell };
