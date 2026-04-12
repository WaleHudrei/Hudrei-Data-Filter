/**
 * shared-shell.js
 * Single source of truth for Loki's sidebar + HTML shell.
 * All route files import this — update once, applies everywhere.
 */

function shell(title, body, activePage) {
  activePage = activePage || 'filter';
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — Loki</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f4f0;color:#1a1a1a;min-height:100vh;display:flex}
.sidebar{width:220px;min-height:100vh;background:#1a1a1a;display:flex;flex-direction:column;position:fixed;top:0;left:0;bottom:0;z-index:20}
.sidebar-logo{padding:20px 20px 16px;border-bottom:1px solid #2a2a2a}
.sidebar-logo-title{font-size:15px;font-weight:600;color:#fff}
.sidebar-logo-sub{font-size:11px;color:#666;margin-top:2px}
.sidebar-nav{padding:12px 10px;flex:1}
.sidebar-section{font-size:10px;font-weight:600;color:#444;text-transform:uppercase;letter-spacing:.06em;padding:8px 10px 4px}
.sidebar-link{display:flex;align-items:center;gap:12px;padding:12px 12px;border-radius:8px;color:#888;font-size:14px;text-decoration:none;margin-bottom:6px;transition:all .15s}
.sidebar-link:hover{background:#2a2a2a;color:#fff}
.sidebar-link.active{background:#2a2a2a;color:#fff}
.sidebar-link svg{width:18px;height:18px;flex-shrink:0;opacity:.7}
.sidebar-link.active svg{opacity:1}
.sidebar-footer{padding:14px 16px;border-top:1px solid #2a2a2a}
.sidebar-footer a{font-size:12px;color:#666;text-decoration:none}
.sidebar-footer a:hover{color:#fff}
.page-wrap{margin-left:220px;min-height:100vh;flex:1}
.main{max-width:1400px;margin:0 auto;padding:2rem 1.5rem}
.card{background:#fff;border:1px solid #e0dfd8;border-radius:12px;padding:1.25rem 1.5rem;margin-bottom:1.25rem}
.sec-lbl{font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.05em}
.badge{display:inline-block;font-size:11px;padding:2px 8px;border-radius:4px;font-weight:500}
.b-keep{background:#e8f5ee;color:#1a7a4a}.b-remove{background:#fdf0f0;color:#c0392b}
.stats-grid-5{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
.stat-card{background:#fff;border:1px solid #e0dfd8;border-radius:10px;padding:12px 14px}
.stat-lbl{font-size:12px;color:#888;margin-bottom:4px}
.stat-num{font-size:22px;font-weight:500}
.stat-num.green{color:#1a7a4a}.stat-num.red{color:#c0392b}.stat-num.blue{color:#2471a3}
.data-table{width:100%;font-size:12px;border-collapse:collapse}
.data-table th{text-align:left;padding:8px 12px;font-weight:500;color:#888;border-bottom:1px solid #f0efe9;font-size:11px;white-space:nowrap;background:#fff}
.data-table td{padding:8px 12px;border-bottom:1px solid #f8f7f4;vertical-align:top}
.data-table tbody tr:hover{background:#fafaf8}
.data-table tbody tr:last-child td{border-bottom:none}
.btn-primary-link{display:inline-flex;padding:8px 16px;background:#1a1a1a;color:#fff;border-radius:8px;font-size:13px;font-weight:500;text-decoration:none}
.btn-primary-link:hover{background:#333}
.btn-link{display:inline-flex;padding:8px 16px;border:1px solid #ddd;background:#fff;color:#1a1a1a;border-radius:8px;font-size:13px;text-decoration:none}
.btn-link:hover{background:#f5f4f0}
.inline-select{padding:5px 10px;font-size:12px;border:1px solid #ddd;border-radius:7px;background:#fff;color:#1a1a1a;font-family:inherit;cursor:pointer}
.form-field{margin-bottom:1rem}
.form-field label{font-size:13px;color:#555;display:block;margin-bottom:4px;font-weight:500}
.form-field input,.form-field select,.form-field textarea{width:100%;padding:9px 12px;border:1px solid #ddd;border-radius:8px;font-size:14px;background:#fafaf8;color:#1a1a1a;font-family:inherit}
.form-field input:focus,.form-field select:focus,.form-field textarea:focus{outline:none;border-color:#888}
.field-hint{font-size:11px;color:#aaa;margin-top:3px;display:block}
.btn-submit{width:100%;padding:10px;background:#1a1a1a;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer;font-family:inherit;margin-top:4px}
.btn-submit:hover{background:#333}
.error-box{background:#fff0f0;border:1px solid #f5c5c5;border-radius:8px;padding:9px 12px;font-size:13px;color:#c0392b;margin-bottom:1rem}
.empty-state{text-align:center;padding:3rem;color:#888;font-size:14px}
.empty-state a{color:#1a1a1a}
.drop-zone{border:1.5px dashed #ccc;border-radius:10px;padding:2rem;text-align:center;cursor:pointer;background:#fafaf8;transition:all .15s}
.drop-zone:hover{border-color:#888;background:#f0efe9}
.tabs{display:flex;gap:2px;border-bottom:1px solid #e0dfd8;margin-bottom:1rem}
.tab{padding:8px 16px;font-size:13px;cursor:pointer;border:none;background:transparent;color:#888;border-bottom:2px solid transparent;margin-bottom:-1px;font-family:inherit}
.tab.active{color:#1a1a1a;border-bottom-color:#1a1a1a}
.tab-panel{display:none}.tab-panel.active{display:block}
.tbl-wrap{overflow-x:auto;max-height:360px;overflow-y:auto}
.spinner{width:16px;height:16px;border:2px solid #ddd;border-top-color:#888;border-radius:50%;animation:spin .6s linear infinite;display:inline-block}
@keyframes spin{to{transform:rotate(360deg)}}
.list-row{background:#fff;border:1px solid #e0dfd8;border-radius:10px;padding:14px 18px;margin-bottom:8px;display:flex;align-items:center;gap:16px;transition:box-shadow .15s}
.list-row:hover{box-shadow:0 2px 8px rgba(0,0,0,.06)}
.list-name{font-size:14px;font-weight:600;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:500px}
.list-count{font-size:13px;color:#888;white-space:nowrap;min-width:110px}
.btn-show{padding:7px 14px;background:#f5f4f0;border:1px solid #e0dfd8;border-radius:7px;font-size:13px;font-weight:500;color:#1a1a1a;text-decoration:none;white-space:nowrap;transition:all .15s}
.btn-show:hover{background:#1a1a1a;color:#fff;border-color:#1a1a1a}
.dots-btn{background:none;border:none;cursor:pointer;padding:6px 8px;border-radius:6px;color:#888;font-size:18px;line-height:1;position:relative}
.dots-btn:hover{background:#f5f4f0;color:#1a1a1a}
.dropdown{display:none;position:absolute;right:0;top:100%;background:#fff;border:1px solid #e0dfd8;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.1);min-width:120px;z-index:100;overflow:hidden}
.dropdown.open{display:block}
.dropdown a,.dropdown button{display:block;width:100%;padding:10px 14px;font-size:13px;color:#1a1a1a;text-decoration:none;background:none;border:none;text-align:left;cursor:pointer;font-family:inherit}
.dropdown a:hover,.dropdown button:hover{background:#f5f4f0}
.dropdown .delete-btn{color:#c0392b}
.dropdown .delete-btn:hover{background:#fdf0f0}
.pagination{display:flex;align-items:center;justify-content:space-between;margin-top:1rem;font-size:13px;color:#888}
.pagination a{padding:6px 12px;background:#fff;border:1px solid #ddd;border-radius:7px;color:#1a1a1a;text-decoration:none;font-size:13px}
.pagination a:hover{background:#f5f4f0}
.btn-row{display:flex;gap:8px}
.btn-danger{background:#fff;color:#c0392b;border:1px solid #f5c5c5}.btn-danger:hover{background:#fff5f5}
.sec-lbl{font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px}
.modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:200;align-items:center;justify-content:center}
.modal-overlay.open{display:flex}
.modal{background:#fff;border-radius:14px;padding:1.5rem;width:100%;max-width:560px;max-height:90vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.2)}
.modal-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:1.25rem}
.modal-title{font-size:16px;font-weight:600}
.modal-close{background:none;border:none;font-size:20px;color:#888;cursor:pointer;line-height:1}
.btn{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:8px;font-size:13px;font-weight:500;text-decoration:none;cursor:pointer;border:none;font-family:inherit;transition:all .15s}
.btn-primary{background:#1a1a1a;color:#fff}.btn-primary:hover{background:#333}
.btn-ghost{background:#fff;color:#1a1a1a;border:1px solid #ddd}.btn-ghost:hover{background:#f5f4f0}
.page-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:1.5rem;flex-wrap:wrap;gap:12px}
.page-title{font-size:20px;font-weight:600}
.page-sub{font-size:13px;color:#888;margin-top:2px}
.count-pill{display:inline-block;background:#f0efe9;color:#555;font-size:11px;font-weight:600;padding:2px 8px;border-radius:12px;margin-left:6px}
.search-bar{display:flex;gap:8px;margin-bottom:1.25rem;flex-wrap:wrap}
.search-bar input{flex:1;min-width:200px;padding:9px 14px;border:1px solid #ddd;border-radius:8px;font-size:14px;font-family:inherit;background:#fff}
.search-bar input:focus{outline:none;border-color:#888}
.search-bar select{padding:9px 12px;border:1px solid #ddd;border-radius:8px;font-size:13px;font-family:inherit;background:#fff;color:#1a1a1a}
.alert{padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:1rem}
.alert-success{background:#e8f5ee;color:#1a7a4a;border:1px solid #c3e6cc}
.alert-error{background:#fdf0f0;color:#c0392b;border:1px solid #f5c5c5}
.kv-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:14px 20px}
.kv{display:flex;flex-direction:column;gap:3px}
.kv-label{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#888;font-weight:600}
.kv-val{font-size:14px;font-weight:500;color:#1a1a1a}
.kv-val.highlight{color:#1a7a4a;font-weight:600}
.phone-row{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#fafaf8;border-radius:8px;border:1px solid #f0efe9;margin-bottom:8px}
.phone-num{font-family:monospace;font-size:14px;font-weight:500}
.phone-status{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;padding:3px 9px;border-radius:4px}
.ps-unknown{background:#f5f4f0;color:#888}
.ps-correct{background:#e8f5ee;color:#1a7a4a}
.ps-wrong{background:#fff8e1;color:#9a6800}
.ps-dead{background:#fdf0f0;color:#c0392b}
.timeline-item{display:grid;grid-template-columns:130px 1fr;gap:16px;padding:13px 0;border-bottom:1px solid #f5f4f0}
.timeline-item:last-child{border-bottom:none}
.timeline-date{font-family:monospace;font-size:12px;color:#aaa;padding-top:2px}
.timeline-source{font-size:13px;font-weight:600;margin-bottom:3px}
.timeline-detail{font-size:12px;color:#888}
.timeline-detail .added{color:#1a7a4a;font-weight:600}
.timeline-detail .updated{color:#9a6800;font-weight:600}
.chip{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600}
.chip-call{background:#e8f5ee;color:#1a7a4a}
.chip-sms{background:#e8f0ff;color:#2c5cc5}
.chip-email{background:#fff8e1;color:#9a6800}
.tag{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;background:#f5f4f0;color:#555;margin-right:4px}
.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:1.25rem}
.grid-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:1.25rem}
</style></head><body>
<div class="sidebar">
  <div class="sidebar-logo">
    <div class="sidebar-logo-title">Loki</div>
    <div class="sidebar-logo-sub">Developed by HudREI</div>
  </div>
  <div class="sidebar-nav">
    <div class="sidebar-section">Tools</div>
    <a href="/dashboard" class="sidebar-link ${activePage==='dashboard'?'active':''}">
      <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
      Dashboard
    </a>
    <a href="/" class="sidebar-link ${activePage==='filter'?'active':''}">
      <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M3 4h18M3 8h18M3 12h12M3 16h8"/></svg>
      List Filtration
    </a>
    <a href="/records" class="sidebar-link ${activePage==='records'?'active':''}">
      <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
      Records
    </a>
    <a href="/lists" class="sidebar-link ${activePage==='lists'?'active':''}">
      <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 12h6M9 16h4"/></svg>
      Lists
    </a>
    <a href="/upload" class="sidebar-link ${activePage==='upload'?'active':''}">
      <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
      Upload
    </a>
    <a href="/campaigns" class="sidebar-link ${activePage==='campaigns'?'active':''}">
      <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
      Campaigns
    </a>
    <a href="/nis" class="sidebar-link ${activePage==='nis'?'active':''}">
      <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
      NIS Numbers
    </a>
    <a href="/changelog" class="sidebar-link ${activePage==='changelog'?'active':''}">
      <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="10"/></svg>
      Changelog
    </a>
    <div class="sidebar-section" style="margin-top:8px">System</div>
    <a href="/setup" class="sidebar-link ${activePage==='setup'?'active':''}">
      <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 010 14.14M4.93 4.93a10 10 0 000 14.14"/></svg>
      Setup
    </a>
  </div>
  <div class="sidebar-footer">
    <a href="/logout">Sign out</a>
  </div>
</div>
<div class="page-wrap">
<div class="main">${body}</div>
</div>
<script>
// Records page checkbox logic — runs at true bottom of DOM
if (document.getElementById('select-all')) {
  var _selIds = {};
  function _upd() {
    var c = Object.keys(_selIds).length;
    var t = document.getElementById('export-toolbar');
    var s = document.getElementById('selected-count');
    if (t) t.style.display = c > 0 ? 'flex' : 'none';
    if (s) s.textContent = c.toLocaleString();
  }
  function selectRow(cb, on) {
    var id = cb.getAttribute('data-id'); if (!id) return;
    cb.checked = on;
    var tr = cb.closest ? cb.closest('tr') : cb.parentNode.parentNode;
    if (tr) { if (on) tr.classList.add('row-selected'); else tr.classList.remove('row-selected'); }
    if (on) _selIds[id] = 1; else delete _selIds[id];
    _upd();
  }
  function clearSelection() {
    _selIds = {};
    document.querySelectorAll('.row-check').forEach(function(cb) { cb.checked = false; var tr = cb.closest ? cb.closest('tr') : cb.parentNode.parentNode; if (tr) tr.classList.remove('row-selected'); });
    document.getElementById('select-all').checked = false;
    _upd();
  }
  document.getElementById('select-all').addEventListener('change', function() {
    var on = this.checked;
    document.querySelectorAll('.row-check').forEach(function(cb) { selectRow(cb, on); });
  });
  document.querySelectorAll('.row-check').forEach(function(cb) {
    cb.addEventListener('change', function() { selectRow(cb, cb.checked); });
  });
}
</script>
</body></html>`;
}

module.exports = { shell };
