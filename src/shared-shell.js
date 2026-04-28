/**
 * shared-shell.js
 *
 * Compatibility shim: every old-Loki page that calls shell(title, body,
 * activePage) now renders through the Ocular shell instead.
 *
 * The body content from old Loki pages still uses classes like .card,
 * .btn-primary, .page-title, .sidebar-link etc. that were defined in
 * this file's old <style> block. Those rules are preserved here scoped
 * under `.loki-legacy` and injected via the Ocular shell's extraHead, so
 * existing pages render identically aside from the shell chrome.
 *
 * Sidebar nav is now driven by the Ocular shell's NAV array; the old
 * Loki sidebar markup is gone. activePage IDs from old callsites get
 * mapped to the Ocular equivalents below.
 *
 * User info is a placeholder for now (`'—'` / blank role). Plumbing
 * real user info through each old route's `shell(...)` call is part of
 * the body-styling pass.
 */

const { shell: ocularShell } = require('./ui/layouts/shell');

// Map old Loki activePage IDs to Ocular sidebar IDs. IDs that don't have
// a direct equivalent (nis, changelog, filter) come back as ''  so no
// nav item lights up — better than highlighting the wrong one.
const ACTIVE_PAGE_MAP = {
  dashboard:    'dashboard',
  records:      'records',
  lists:        'lists',
  campaigns:    'campaigns',
  upload:       'upload',
  activity:     'activity',
  setup:        'settings',
  settings:     'settings',
  'list-types': 'list-registry',
  filter:       'upload',  // old "List Filtration" lives under Upload now
  nis:          'nis',
  changelog:    'changelog',
};

// Legacy body CSS, lifted from this file's old <style> block, scoped to
// `.loki-legacy` so it doesn't bleed into Ocular pages. Body/sidebar
// rules from the old shell are dropped — Ocular owns those now.
const LEGACY_CSS = `
<style>
.loki-legacy * { box-sizing: border-box; }
.loki-legacy { font-family: var(--ocu-display, -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif); color:#1a1a1a; }
.loki-legacy .main { max-width:1400px; margin:0 auto; }
.loki-legacy .card { background:#fff; border:1px solid #e0dfd8; border-radius:12px; padding:1.25rem 1.5rem; margin-bottom:1.25rem; }
.loki-legacy .sec-lbl { font-size:11px; font-weight:600; color:#888; text-transform:uppercase; letter-spacing:.05em; margin-bottom:12px; }
.loki-legacy .badge { display:inline-block; font-size:11px; padding:2px 8px; border-radius:4px; font-weight:500; }
.loki-legacy .b-keep { background:#e8f5ee; color:#1a7a4a; } .loki-legacy .b-remove { background:#fdf0f0; color:#c0392b; }
.loki-legacy .stats-grid-5 { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:10px; }
.loki-legacy .stat-card { background:#fff; border:1px solid #e0dfd8; border-radius:10px; padding:12px 14px; }
.loki-legacy .stat-lbl { font-size:12px; color:#888; margin-bottom:4px; }
.loki-legacy .stat-num { font-size:22px; font-weight:500; }
.loki-legacy .stat-num.green { color:#1a7a4a; } .loki-legacy .stat-num.red { color:#c0392b; } .loki-legacy .stat-num.blue { color:#2471a3; }
.loki-legacy .data-table { width:100%; font-size:12px; border-collapse:collapse; }
.loki-legacy .data-table th { text-align:left; padding:8px 12px; font-weight:500; color:#888; border-bottom:1px solid #f0efe9; font-size:11px; white-space:nowrap; background:#fff; }
.loki-legacy .data-table td { padding:8px 12px; border-bottom:1px solid #f8f7f4; vertical-align:top; }
.loki-legacy .data-table tbody tr:hover { background:#fafaf8; }
.loki-legacy tr.row-selected td { background:#eef4ff !important; }
.loki-legacy tr.row-selected:hover td { background:#e4edff !important; }
.loki-legacy .data-table tbody tr:last-child td { border-bottom:none; }
.loki-legacy .btn-primary-link { display:inline-flex; padding:8px 16px; background:#1a1a1a; color:#fff; border-radius:8px; font-size:13px; font-weight:500; text-decoration:none; }
.loki-legacy .btn-primary-link:hover { background:#333; }
.loki-legacy .btn-link { display:inline-flex; padding:8px 16px; border:1px solid #ddd; background:#fff; color:#1a1a1a; border-radius:8px; font-size:13px; text-decoration:none; }
.loki-legacy .btn-link:hover { background:#f5f4f0; }
.loki-legacy .inline-select { padding:5px 10px; font-size:12px; border:1px solid #ddd; border-radius:7px; background:#fff; color:#1a1a1a; font-family:inherit; cursor:pointer; }
.loki-legacy .form-field { margin-bottom:1rem; }
.loki-legacy .form-field label { font-size:13px; color:#555; display:block; margin-bottom:4px; font-weight:500; }
.loki-legacy .form-field input, .loki-legacy .form-field select, .loki-legacy .form-field textarea { width:100%; padding:9px 12px; border:1px solid #ddd; border-radius:8px; font-size:14px; background:#fafaf8; color:#1a1a1a; font-family:inherit; }
.loki-legacy .form-field input:focus, .loki-legacy .form-field select:focus, .loki-legacy .form-field textarea:focus { outline:none; border-color:#888; }
.loki-legacy .field-hint { font-size:11px; color:#aaa; margin-top:3px; display:block; }
.loki-legacy .btn-submit { width:100%; padding:10px; background:#1a1a1a; color:#fff; border:none; border-radius:8px; font-size:14px; font-weight:500; cursor:pointer; font-family:inherit; margin-top:4px; }
.loki-legacy .btn-submit:hover { background:#333; }
.loki-legacy .error-box { background:#fff0f0; border:1px solid #f5c5c5; border-radius:8px; padding:9px 12px; font-size:13px; color:#c0392b; margin-bottom:1rem; }
.loki-legacy .empty-state { text-align:center; padding:3rem; color:#888; font-size:14px; }
.loki-legacy .empty-state a { color:#1a1a1a; }
.loki-legacy .drop-zone { border:1.5px dashed #ccc; border-radius:10px; padding:2rem; text-align:center; cursor:pointer; background:#fafaf8; transition:all .15s; }
.loki-legacy .drop-zone:hover { border-color:#888; background:#f0efe9; }
.loki-legacy .tabs { display:flex; gap:2px; border-bottom:1px solid #e0dfd8; margin-bottom:1rem; }
.loki-legacy .tab { padding:8px 16px; font-size:13px; cursor:pointer; border:none; background:transparent; color:#888; border-bottom:2px solid transparent; margin-bottom:-1px; font-family:inherit; }
.loki-legacy .tab.active { color:#1a1a1a; border-bottom-color:#1a1a1a; }
.loki-legacy .tab-panel { display:none; } .loki-legacy .tab-panel.active { display:block; }
.loki-legacy .tbl-wrap { overflow-x:auto; max-height:360px; overflow-y:auto; }
.loki-legacy .spinner { width:16px; height:16px; border:2px solid #ddd; border-top-color:#888; border-radius:50%; animation:loki-spin .6s linear infinite; display:inline-block; }
@keyframes loki-spin { to { transform:rotate(360deg); } }
.loki-legacy .list-row { background:#fff; border:1px solid #e0dfd8; border-radius:10px; padding:14px 18px; margin-bottom:8px; display:flex; align-items:center; gap:16px; transition:box-shadow .15s; }
.loki-legacy .list-row:hover { box-shadow:0 2px 8px rgba(0,0,0,.06); }
.loki-legacy .list-name { font-size:14px; font-weight:600; flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:500px; }
.loki-legacy .list-count { font-size:13px; color:#888; white-space:nowrap; min-width:110px; }
.loki-legacy .btn-show { padding:7px 14px; background:#f5f4f0; border:1px solid #e0dfd8; border-radius:7px; font-size:13px; font-weight:500; color:#1a1a1a; text-decoration:none; white-space:nowrap; transition:all .15s; }
.loki-legacy .btn-show:hover { background:#1a1a1a; color:#fff; border-color:#1a1a1a; }
.loki-legacy .dots-btn { background:none; border:none; cursor:pointer; padding:6px 8px; border-radius:6px; color:#888; font-size:18px; line-height:1; position:relative; }
.loki-legacy .dots-btn:hover { background:#f5f4f0; color:#1a1a1a; }
.loki-legacy .dropdown { display:none; position:absolute; right:0; top:100%; background:#fff; border:1px solid #e0dfd8; border-radius:8px; box-shadow:0 4px 16px rgba(0,0,0,.1); min-width:120px; z-index:100; overflow:hidden; }
.loki-legacy .dropdown.open { display:block; }
.loki-legacy .dropdown a, .loki-legacy .dropdown button { display:block; width:100%; padding:10px 14px; font-size:13px; color:#1a1a1a; text-decoration:none; background:none; border:none; text-align:left; cursor:pointer; font-family:inherit; }
.loki-legacy .dropdown a:hover, .loki-legacy .dropdown button:hover { background:#f5f4f0; }
.loki-legacy .dropdown .delete-btn { color:#c0392b; }
.loki-legacy .dropdown .delete-btn:hover { background:#fdf0f0; }
.loki-legacy .pagination { display:flex; align-items:center; justify-content:space-between; margin-top:1rem; font-size:13px; color:#888; }
.loki-legacy .pagination a { padding:6px 12px; background:#fff; border:1px solid #ddd; border-radius:7px; color:#1a1a1a; text-decoration:none; font-size:13px; }
.loki-legacy .pagination a:hover { background:#f5f4f0; }
.loki-legacy .btn-row { display:flex; gap:8px; }
.loki-legacy .btn-danger { background:#fff; color:#c0392b; border:1px solid #f5c5c5; } .loki-legacy .btn-danger:hover { background:#fff5f5; }
.loki-legacy .modal-overlay { display:none; position:fixed; inset:0; background:rgba(0,0,0,.4); z-index:200; align-items:center; justify-content:center; }
.loki-legacy .modal-overlay.open { display:flex; }
.loki-legacy .modal { background:#fff; border-radius:14px; padding:1.5rem; width:100%; max-width:560px; max-height:90vh; overflow-y:auto; box-shadow:0 20px 60px rgba(0,0,0,.2); }
.loki-legacy .modal-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:1.25rem; }
.loki-legacy .modal-title { font-size:16px; font-weight:600; }
.loki-legacy .modal-close { background:none; border:none; font-size:20px; color:#888; cursor:pointer; line-height:1; }
.loki-legacy .btn { display:inline-flex; align-items:center; gap:6px; padding:8px 16px; border-radius:8px; font-size:13px; font-weight:500; text-decoration:none; cursor:pointer; border:none; font-family:inherit; transition:all .15s; }
.loki-legacy .btn-primary { background:#1a1a1a; color:#fff; } .loki-legacy .btn-primary:hover { background:#333; }
.loki-legacy .btn-ghost { background:#fff; color:#1a1a1a; border:1px solid #ddd; } .loki-legacy .btn-ghost:hover { background:#f5f4f0; }
.loki-legacy .page-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:1.5rem; flex-wrap:wrap; gap:12px; }
.loki-legacy .page-title { font-size:20px; font-weight:600; }
.loki-legacy .page-sub { font-size:13px; color:#888; margin-top:2px; }
.loki-legacy .count-pill { display:inline-block; background:#f0efe9; color:#555; font-size:11px; font-weight:600; padding:2px 8px; border-radius:12px; margin-left:6px; }
.loki-legacy .search-bar { display:flex; gap:8px; margin-bottom:1.25rem; flex-wrap:wrap; }
.loki-legacy .search-bar input { flex:1; min-width:200px; padding:9px 14px; border:1px solid #ddd; border-radius:8px; font-size:14px; font-family:inherit; background:#fff; }
.loki-legacy .search-bar input:focus { outline:none; border-color:#888; }
.loki-legacy .search-bar select { padding:9px 12px; border:1px solid #ddd; border-radius:8px; font-size:13px; font-family:inherit; background:#fff; color:#1a1a1a; }
.loki-legacy .alert { padding:10px 14px; border-radius:8px; font-size:13px; margin-bottom:1rem; }
.loki-legacy .alert-success { background:#e8f5ee; color:#1a7a4a; border:1px solid #c3e6cc; }
.loki-legacy .alert-error { background:#fdf0f0; color:#c0392b; border:1px solid #f5c5c5; }
.loki-legacy .alert-warn { background:#fff8e1; color:#7a5a00; border:1px solid #f5d06b; }
.loki-legacy .kv-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(160px,1fr)); gap:14px 20px; }
.loki-legacy .kv { display:flex; flex-direction:column; gap:3px; }
.loki-legacy .kv-label { font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:#888; font-weight:600; }
.loki-legacy .kv-val { font-size:14px; font-weight:500; color:#1a1a1a; }
.loki-legacy .kv-val.highlight { color:#1a7a4a; font-weight:600; }
.loki-legacy .phone-row { display:flex; align-items:center; justify-content:space-between; padding:10px 14px; background:#fafaf8; border-radius:8px; border:1px solid #f0efe9; margin-bottom:8px; }
.loki-legacy .phone-num { font-family:monospace; font-size:14px; font-weight:500; }
.loki-legacy .phone-status { font-size:11px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; padding:3px 9px; border-radius:4px; }
.loki-legacy .ps-unknown { background:#f5f4f0; color:#888; }
.loki-legacy .ps-correct { background:#e8f5ee; color:#1a7a4a; }
.loki-legacy .ps-wrong { background:#fff8e1; color:#9a6800; }
.loki-legacy .ps-dead { background:#fdf0f0; color:#c0392b; }
.loki-legacy .timeline-item { display:grid; grid-template-columns:130px 1fr; gap:16px; padding:13px 0; border-bottom:1px solid #f5f4f0; }
.loki-legacy .timeline-item:last-child { border-bottom:none; }
.loki-legacy .timeline-date { font-size:11px; color:#888; text-transform:uppercase; letter-spacing:.08em; font-weight:600; padding-top:2px; }
.loki-legacy .timeline-content { font-size:13px; }
.loki-legacy .timeline-title { font-weight:500; color:#1a1a1a; margin-bottom:2px; }
.loki-legacy .timeline-sub { font-size:12px; color:#888; }
</style>`;

// Default user when shell() is called without explicit user info. The
// per-route plumbing of req.userId → real user info is part of the body
// styling pass; until then the sidebar shows a placeholder.
const DEFAULT_USER = { name: '—', role: '', initials: '·' };

/**
 * Backward-compatible shell().
 *
 * @param {string} title
 * @param {string} body
 * @param {string} activePage  Old Loki page id ('records', 'lists', etc.)
 * @param {Object} [user]      Optional Ocular user object { name, role, initials }
 */
function shell(title, body, activePage, user) {
  const ocularActive = ACTIVE_PAGE_MAP[activePage || ''] || '';
  return ocularShell({
    title:      title,
    activePage: ocularActive,
    user:       user || DEFAULT_USER,
    extraHead:  LEGACY_CSS,
    body:       `<div class="loki-legacy">${body}</div>`,
  });
}

module.exports = { shell };
