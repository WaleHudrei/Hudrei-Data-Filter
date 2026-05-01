// ═══════════════════════════════════════════════════════════════════════════
// ui/pages/filtration.js
// Ocular-styled "List Filtration" tab. Single-page interactive UI that ports
// the legacy Loki filtration flow (campaign select → CSV upload → column map
// → preview → results) into the Ocular shell.
//
// Reuses existing backend endpoints — nothing new server-side:
//   POST /upload/filter/parse    parse CSV, return columns + autoMap + rows
//   POST /upload/filter/process  run filtration, return stats + two outputs
//   GET  /api/campaigns          campaign dropdown source
//   GET  /memory/export          download memory JSON
//   POST /memory/import          restore memory from JSON
//   POST /memory/clear           wipe memory
//   GET  /download/filtered      session-bound CSV (REISift output)
//   GET  /download/clean         session-bound CSV (Readymode output)
// ═══════════════════════════════════════════════════════════════════════════
const { shell } = require('../layouts/shell');
const { escHTML } = require('../_helpers');

function filtrationPage(data = {}) {
  const memSize  = Number(data.memSize  || 0);
  const listsCount = Number(data.listsCount || 0);
  const redisOn  = !!data.redisConnected;

  const body = `
    <!-- Memory card ─────────────────────────────────────────────────────── -->
    <div class="ocu-card" style="margin-bottom:18px">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:14px">
        <div>
          <div style="font-size:13px;color:#6b6f7a;font-weight:600;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px">Memory</div>
          <div style="display:flex;gap:24px;flex-wrap:wrap">
            <div>
              <div style="font-size:24px;font-weight:700;color:#0c1116" id="memListsCount">${escHTML(String(listsCount))}</div>
              <div style="font-size:12px;color:#6b6f7a;font-weight:600">Lists tracked</div>
              <div style="font-size:11px;color:#9aa0aa;margin-top:1px">Unique list names remembered across imports</div>
            </div>
            <div>
              <div style="font-size:24px;font-weight:700;color:#0c1116" id="memPhonesCount">${escHTML(String(memSize))}</div>
              <div style="font-size:12px;color:#6b6f7a;font-weight:600">Scopes in memory</div>
              <div style="font-size:11px;color:#9aa0aa;margin-top:1px">Campaign × list dedup entries</div>
            </div>
            <div>
              <div style="font-size:13px;font-weight:600;${redisOn ? 'color:#1a7a4a' : 'color:#a05500'};margin-top:6px">
                ${redisOn ? '● Redis connected' : '○ In-memory only — resets on restart'}
              </div>
            </div>
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <a class="ocu-btn ocu-btn-secondary" href="/memory/export">Export memory</a>
          <button class="ocu-btn ocu-btn-secondary" type="button" onclick="document.getElementById('memImportFile').click()">Import memory</button>
          <input type="file" id="memImportFile" accept=".json" style="display:none" onchange="filtrationApp.importMemory(this.files[0])">
          <button class="ocu-btn ocu-btn-danger" type="button" onclick="filtrationApp.clearMemory()">Clear memory</button>
        </div>
      </div>
    </div>

    <!-- Step 1: Campaign + file upload ──────────────────────────────────── -->
    <div class="ocu-card" id="stepUpload" style="margin-bottom:18px">
      <div class="ocu-card-header">
        <div class="ocu-card-title">1. Pick a campaign and drop your CSV</div>
      </div>
      <div class="ocu-card-body">
        <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:14px">
          <div style="flex:1;min-width:260px">
            <label class="ocu-label">Campaign</label>
            <!-- Searchable combobox. Hidden #campaignSelect input keeps the
                 same id the existing JS reads (.value on the input still
                 works exactly like a <select>'s .value). -->
            <div class="ocu-combobox" id="campaignBox" data-empty-label="— select campaign —">
              <input type="hidden" id="campaignSelect" value="">
              <button type="button" class="ocu-combobox-trigger ocu-input" id="campaignBoxTrigger" aria-haspopup="listbox" aria-expanded="false">
                <span class="ocu-combobox-current">Loading campaigns…</span>
                <span class="ocu-combobox-arrow" aria-hidden="true">▾</span>
              </button>
              <div class="ocu-combobox-popover" id="campaignBoxPopover" hidden>
                <input type="search" class="ocu-combobox-search ocu-input" id="campaignBoxSearch" placeholder="Search campaigns…" autocomplete="off">
                <div class="ocu-combobox-list" id="campaignBoxList" role="listbox" tabindex="-1"></div>
              </div>
            </div>
            <div class="ocu-hint" style="margin-top:6px">
              The filtration scope is per campaign — memory and list-name dedup is keyed by campaign id.
            </div>
          </div>
        </div>

        <div id="dropZone" class="ocu-drop-zone">
          <input type="file" id="csvFile" accept=".csv,.txt" style="display:none">
          <div class="ocu-drop-zone-inner">
            <div style="font-size:32px;color:#7a808a;margin-bottom:8px">⬆</div>
            <div style="font-weight:600;color:#1a1f25">Drop CSV here, or click to browse</div>
            <div class="ocu-hint" style="margin-top:6px">Readymode call-log export, .csv (max 50&nbsp;MB)</div>
          </div>
        </div>

        <div id="parseProgress" style="display:none;margin-top:14px">
          <div style="font-size:13px;color:#6b6f7a">Loading…</div>
        </div>
        <div id="parseError" class="ocu-flash ocu-flash-error" style="display:none;margin-top:14px"></div>
      </div>
    </div>

    <!-- Step 2: Column mapping (hidden until parsed) ────────────────────── -->
    <div class="ocu-card" id="stepMap" style="display:none;margin-bottom:18px">
      <div class="ocu-card-header">
        <div class="ocu-card-title">2. Confirm column mapping</div>
        <div class="ocu-card-subtitle" id="mapSubtitle">—</div>
      </div>
      <div class="ocu-card-body">
        <div class="ocu-hint" style="margin-bottom:12px">
          We auto-detected your CSV columns. Adjust any that don't match the REISift output names below, then run filtration.
        </div>
        <div id="mapTable" style="overflow-x:auto"></div>
        <div style="margin-top:18px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="ocu-btn ocu-btn-primary" type="button" onclick="filtrationApp.runFilter()">Run filtration</button>
          <button class="ocu-btn ocu-btn-secondary" type="button" onclick="filtrationApp.reset()">Cancel</button>
        </div>
        <div id="processProgress" style="display:none;margin-top:14px">
          <div style="font-size:13px;color:#6b6f7a">Processing… this may take a moment for large files.</div>
        </div>
        <div id="processError" class="ocu-flash ocu-flash-error" style="display:none;margin-top:14px"></div>
      </div>
    </div>

    <!-- Step 3: Results (hidden until processed) ────────────────────────── -->
    <div class="ocu-card" id="stepResults" style="display:none;margin-bottom:18px">
      <div class="ocu-card-header">
        <div class="ocu-card-title">3. Results</div>
        <div class="ocu-card-subtitle" id="resultsSubtitle">—</div>
      </div>
      <div class="ocu-card-body">
        <!-- Stats row -->
        <div id="resultStats" style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:18px"></div>

        <!-- Download buttons -->
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px">
          <a class="ocu-btn ocu-btn-primary" href="/download/filtered" id="dlFiltered">⤓ Filtered (REISift)</a>
          <a class="ocu-btn ocu-btn-secondary" href="/download/clean" id="dlClean">⤓ Clean (Readymode)</a>
          <button class="ocu-btn ocu-btn-secondary" type="button" onclick="filtrationApp.reset()">Filter another file</button>
        </div>

        <!-- Tabs -->
        <div class="ocu-tabs" style="margin-bottom:0">
          <button class="ocu-tab active" type="button" data-tab="filtered" onclick="filtrationApp.showTab('filtered')">Filtered → REISift <span id="tabCountFiltered" class="ocu-pill" style="margin-left:6px">0</span></button>
          <button class="ocu-tab" type="button" data-tab="clean" onclick="filtrationApp.showTab('clean')">Clean → Readymode <span id="tabCountClean" class="ocu-pill" style="margin-left:6px">0</span></button>
        </div>
        <div class="ocu-hint" style="margin:8px 0 12px">Showing first 50 rows of each output. Use the download buttons for the full CSV.</div>
        <div id="tabContent" style="overflow-x:auto"></div>
      </div>
    </div>

    <!-- Page-local CSS for drop zone + tabs (kept inline so this page is self-contained
         and we don't fight cache-busting on ocular.css for one feature) -->
    <style>
      .ocu-drop-zone{border:2px dashed #c7ccd4;border-radius:10px;padding:32px;text-align:center;cursor:pointer;transition:background .15s,border-color .15s}
      .ocu-drop-zone:hover,.ocu-drop-zone.dragover{background:#f0f7ff;border-color:#3b82f6}
      .ocu-drop-zone-inner{pointer-events:none}
      .ocu-tabs{display:flex;gap:4px;border-bottom:1px solid #e6e8ec}
      .ocu-tab{background:none;border:none;padding:10px 16px;font-size:14px;color:#6b6f7a;cursor:pointer;border-bottom:2px solid transparent;font-family:inherit;font-weight:500}
      .ocu-tab.active{color:#0c1116;border-bottom-color:#0c1116}
      .ocu-tab:hover{color:#0c1116}
      .ocu-result-table{width:100%;border-collapse:collapse;font-size:13px}
      .ocu-result-table th{text-align:left;padding:8px 10px;background:#f5f6f8;border-bottom:1px solid #e6e8ec;font-weight:600;color:#3a3f47;white-space:nowrap}
      .ocu-result-table td{padding:8px 10px;border-bottom:1px solid #f0f1f4;color:#1a1f25;white-space:nowrap;max-width:240px;overflow:hidden;text-overflow:ellipsis}
      .ocu-result-table tr:hover td{background:#fafbfc}
      .ocu-stat-card{background:#f7f8fa;border:1px solid #e6e8ec;border-radius:8px;padding:12px 16px;min-width:120px}
      .ocu-stat-card .v{font-size:22px;font-weight:700;color:#0c1116;line-height:1.1}
      .ocu-stat-card .l{font-size:12px;color:#6b6f7a;margin-top:4px}
      .ocu-flash-error{background:#fff0f0;border:1px solid #f5c5c5;color:#a02222;padding:10px 12px;border-radius:8px;font-size:13px}
      .ocu-flash-ok{background:#eef9f1;border:1px solid #c5e8d4;color:#1a7a4a;padding:10px 12px;border-radius:8px;font-size:13px}
      .ocu-btn-danger{background:#a02222;color:#fff;border:1px solid #a02222}
      .ocu-btn-danger:hover{background:#8a1d1d}
      .ocu-card-subtitle{font-size:12px;color:#6b6f7a;margin-top:2px}
      .ocu-label{font-size:12px;font-weight:600;color:#3a3f47;display:block;margin-bottom:6px;text-transform:uppercase;letter-spacing:.03em}
      .ocu-hint{font-size:12px;color:#7a808a}
      .ocu-pill{display:inline-block;padding:2px 8px;border-radius:10px;background:#e6e8ec;color:#3a3f47;font-size:11px;font-weight:600}
    </style>

    <script src="/oculah-static/filtration-app.js?v=2"></script>
  `;

  return shell({
    title:          'List Filtration',
    topbarTitle:    'List Filtration',
    topbarSubtitle: 'Filter a Readymode call log against memory — outputs Filtered → REISift and Clean → Readymode',
    activePage:     'filtration',
    user:           data.user,
    badges:         data.badges || {},
    body,
  });
}

module.exports = { filtrationPage };
