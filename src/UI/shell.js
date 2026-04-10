const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f4f0;color:#1a1a1a;min-height:100vh;display:flex}
.sidebar{width:220px;min-height:100vh;background:#1a1a1a;display:flex;flex-direction:column;position:fixed;top:0;left:0;bottom:0;z-index:20}
.sidebar-logo{padding:20px 20px 16px;border-bottom:1px solid #2a2a2a}
.sidebar-logo-title{font-size:15px;font-weight:600;color:#fff}
.sidebar-logo-sub{font-size:11px;color:#666;margin-top:2px}
.sidebar-ver{font-size:10px;background:#2a2a2a;padding:1px 6px;border-radius:3px;color:#666;margin-top:6px;display:inline-block}
.sidebar-nav{padding:12px 10px;flex:1}
.sidebar-section{font-size:10px;font-weight:600;color:#444;text-transform:uppercase;letter-spacing:.06em;padding:8px 10px 4px}
.sidebar-link{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:8px;color:#888;font-size:13px;text-decoration:none;margin-bottom:2px;transition:all .15s}
.sidebar-link:hover{background:#2a2a2a;color:#fff}
.sidebar-link.active{background:#2a2a2a;color:#fff}
.sidebar-link svg{width:16px;height:16px;flex-shrink:0;opacity:.7}
.sidebar-link.active svg{opacity:1}
.sidebar-footer{padding:14px 16px;border-top:1px solid #2a2a2a}
.sidebar-footer a{font-size:12px;color:#666;text-decoration:none}
.sidebar-footer a:hover{color:#fff}
.page-wrap{margin-left:220px;min-height:100vh;flex:1;width:calc(100% - 220px)}
.main{max-width:980px;margin:0 auto;padding:2rem 1.5rem}
.card{background:#fff;border:1px solid #e0dfd8;border-radius:12px;padding:1.25rem 1.5rem;margin-bottom:1.25rem}
.sec-lbl{font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.05em}
.badge{display:inline-block;font-size:11px;padding:2px 8px;border-radius:4px;font-weight:500}
.b-keep{background:#e8f5ee;color:#1a7a4a}.b-remove{background:#fdf0f0;color:#c0392b}
.stat-card{background:#fff;border:1px solid #e0dfd8;border-radius:10px;padding:12px 14px}
.stat-lbl{font-size:12px;color:#888;margin-bottom:4px}
.stat-num{font-size:22px;font-weight:500}
.stat-num.green{color:#1a7a4a}.stat-num.red{color:#c0392b}.stat-num.blue{color:#2471a3}.stat-num.amber{color:#9a6800}
.data-table{width:100%;font-size:12px;border-collapse:collapse}
.data-table th{text-align:left;padding:8px 12px;font-weight:500;color:#888;border-bottom:1px solid #f0efe9;font-size:11px;white-space:nowrap;background:#fff}
.data-table td{padding:8px 12px;border-bottom:1px solid #f8f7f4;vertical-align:top}
.data-table tbody tr:hover{background:#fafaf8}
.data-table tbody tr:last-child td{border-bottom:none}
.btn-primary{display:inline-flex;align-items:center;gap:6px;padding:9px 18px;background:#1a1a1a;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:500;cursor:pointer;font-family:inherit;text-decoration:none}
.btn-primary:hover{background:#333}
.btn-secondary{display:inline-flex;align-items:center;gap:6px;padding:9px 18px;border:1px solid #ddd;background:#fff;color:#1a1a1a;border-radius:8px;font-size:13px;cursor:pointer;font-family:inherit;text-decoration:none}
.btn-secondary:hover{background:#f5f4f0}
.btn-danger{display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border:1px solid #f5c5c5;background:#fff;color:#c0392b;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit}
.btn-danger:hover{background:#fff0f0}
.inline-select{padding:5px 10px;font-size:12px;border:1px solid #ddd;border-radius:7px;background:#fff;color:#1a1a1a;font-family:inherit;cursor:pointer}
.form-field{margin-bottom:1rem}
.form-field label{font-size:13px;color:#555;display:block;margin-bottom:4px;font-weight:500}
.form-field input,.form-field select,.form-field textarea{width:100%;padding:9px 12px;border:1px solid #ddd;border-radius:8px;font-size:14px;background:#fafaf8;color:#1a1a1a;font-family:inherit}
.form-field input:focus,.form-field select:focus,.form-field textarea:focus{outline:none;border-color:#888}
.field-hint{font-size:11px;color:#aaa;margin-top:3px;display:block}
.error-box{background:#fff0f0;border:1px solid #f5c5c5;border-radius:8px;padding:9px 12px;font-size:13px;color:#c0392b;margin-bottom:1rem}
.info-box{background:#e8f5ee;border:1px solid #9FE1CB;border-radius:8px;padding:9px 12px;font-size:13px;color:#0F6E56;margin-bottom:1rem}
.empty-state{text-align:center;padding:3rem;color:#888;font-size:14px}
.drop-zone{border:1.5px dashed #ccc;border-radius:10px;padding:2rem;text-align:center;cursor:pointer;background:#fafaf8;transition:all .15s}
.drop-zone:hover,.drop-zone.drag{border-color:#888;background:#f0efe9}
.tabs{display:flex;gap:2px;border-bottom:1px solid #e0dfd8;margin-bottom:1rem}
.tab{padding:8px 16px;font-size:13px;cursor:pointer;border:none;background:transparent;color:#888;border-bottom:2px solid transparent;margin-bottom:-1px;font-family:inherit}
.tab.active{color:#1a1a1a;border-bottom-color:#1a1a1a}
.tab-panel{display:none}.tab-panel.active{display:block}
.tbl-wrap{overflow-x:auto;max-height:360px;overflow-y:auto}
.spinner{width:16px;height:16px;border:2px solid #ddd;border-top-color:#888;border-radius:50%;animation:spin .6s linear infinite;display:inline-block}
@keyframes spin{to{transform:rotate(360deg)}}
.step-bar{display:flex;align-items:center;gap:0;margin-bottom:2rem}
.step{display:flex;align-items:center;gap:8px;font-size:13px;color:#888}
.step.active{color:#1a1a1a;font-weight:500}
.step.done{color:#1a7a4a}
.step-num{width:26px;height:26px;border-radius:50%;border:2px solid #ddd;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:500;background:#fff;flex-shrink:0}
.step.active .step-num{border-color:#1a1a1a;background:#1a1a1a;color:#fff}
.step.done .step-num{border-color:#1a7a4a;background:#1a7a4a;color:#fff}
.step-divider{flex:1;height:1px;background:#e0dfd8;margin:0 8px}
.map-row{display:grid;grid-template-columns:1fr 40px 1fr;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid #f5f4f0}
.map-row:last-child{border-bottom:none}
.map-src{font-size:13px;color:#1a1a1a;background:#f5f4f0;padding:6px 10px;border-radius:6px}
.map-arrow{text-align:center;color:#aaa;font-size:16px}
.map-dst select{width:100%;padding:6px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px;background:#fff;color:#1a1a1a;font-family:inherit}
`;

function shell(title, body, activePage) {
  const isFilter = activePage === 'filter';
  const isCampaign = activePage === 'campaigns';
  const isUpload = activePage === 'upload';

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — HudREI</title>
<style>${CSS}</style>
</head><body>
<div class="sidebar">
  <div class="sidebar-logo">
    <div class="sidebar-logo-title">HudREI LLC</div>
    <div class="sidebar-logo-sub">Data Filter</div>
    <span class="sidebar-ver">v2.0</span>
  </div>
  <div class="sidebar-nav">
    <div class="sidebar-section">Tools</div>
    <a href="/" class="sidebar-link ${isFilter?'active':''}">
      <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M3 6h18M6 12h12M9 18h6"/></svg>
      List Filtration
    </a>
    <a href="/upload" class="sidebar-link ${isUpload?'active':''}">
      <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
      Upload Data
    </a>
    <a href="/campaigns" class="sidebar-link ${isCampaign?'active':''}">
      <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
      Campaigns
    </a>
  </div>
  <div class="sidebar-footer"><a href="/logout">Sign out</a></div>
</div>
<div class="page-wrap"><div class="main">${body}</div></div>
</body></html>`;
}

function stepBar(steps, currentStep) {
  return `<div class="step-bar">${steps.map((s,i) => {
    const num = i+1;
    const cls = num < currentStep ? 'done' : num === currentStep ? 'active' : '';
    return `${i>0?'<div class="step-divider"></div>':''}
    <div class="step ${cls}">
      <div class="step-num">${num < currentStep ? '✓' : num}</div>
      <span>${s}</span>
    </div>`;
  }).join('')}</div>`;
}

module.exports = { shell, stepBar, CSS };
