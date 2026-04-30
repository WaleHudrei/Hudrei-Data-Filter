// ═══════════════════════════════════════════════════════════════════════════
// filtration-app.js — client-side controller for /oculah/filtration
//
// Drives the 3-step single-page flow:
//   1. Pick campaign + drop CSV → POST /upload/filter/parse
//   2. Confirm column mapping     → POST /upload/filter/process
//   3. Show results + downloads
// Plus memory-side actions: import / clear (export is a plain GET).
//
// All endpoints already exist in server.js + routes/upload-routes.js.
// ═══════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  // Ports the FIELD_MAP from routes/upload-routes.js. Keys are REISift output
  // names; values are the internal Loki column names. The mapping UI lets the
  // user override the right-hand side (which CSV column feeds each output).
  var REISIFT_OUTPUTS = [
    'Call Log Date', 'Phone', 'Phone Tag', 'Call Log Count',
    'Marketing Result', 'Phone Status', 'Call Notes',
    'First Name', 'Last Name', 'City', 'Address', 'Zip Code', 'State',
  ];

  var state = {
    columns: [],
    rows: [],
    autoMap: {},
    filename: '',
    total: 0,
    lastResult: null,
  };

  // ── DOM helpers ──────────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
  function show(id) { var el = $(id); if (el) el.style.display = ''; }
  function hide(id) { var el = $(id); if (el) el.style.display = 'none'; }
  function setText(id, txt) { var el = $(id); if (el) el.textContent = txt; }
  function setHTML(id, html) { var el = $(id); if (el) el.innerHTML = html; }
  function escHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ── Campaigns dropdown ───────────────────────────────────────────────────
  function loadCampaigns() {
    fetch('/api/campaigns', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (list) {
        var sel = $('campaignSelect');
        if (!sel) return;
        var opts = ['<option value="">— select campaign —</option>'];
        (list || []).forEach(function (c) {
          var name = c.name || ('Campaign ' + c.id);
          opts.push('<option value="' + escHTML(String(c.id)) + '">' + escHTML(name) + '</option>');
        });
        sel.innerHTML = opts.join('');
      })
      .catch(function () {
        $('campaignSelect').innerHTML = '<option value="">— could not load campaigns —</option>';
      });
  }

  // ── Drop zone wiring ─────────────────────────────────────────────────────
  function wireDropZone() {
    var zone = $('dropZone');
    var input = $('csvFile');
    if (!zone || !input) return;

    zone.addEventListener('click', function () { input.click(); });
    input.addEventListener('change', function () {
      if (input.files && input.files[0]) parseFile(input.files[0]);
    });

    ['dragenter', 'dragover'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) {
        e.preventDefault(); e.stopPropagation();
        zone.classList.add('dragover');
      });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) {
        e.preventDefault(); e.stopPropagation();
        zone.classList.remove('dragover');
      });
    });
    zone.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) parseFile(f);
    });
  }

  // ── Step 1 → 2: parse CSV ────────────────────────────────────────────────
  function parseFile(file) {
    hide('parseError');
    show('parseProgress');
    var fd = new FormData();
    fd.append('csvfile', file);
    fetch('/upload/filter/parse', {
      method: 'POST', body: fd, credentials: 'same-origin',
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
      .then(function (res) {
        hide('parseProgress');
        if (!res.ok || res.body.error) {
          setText('parseError', res.body.error || 'Parse failed.');
          show('parseError');
          return;
        }
        state.columns  = res.body.columns || [];
        state.rows     = res.body.rows || [];
        state.autoMap  = res.body.autoMap || {};
        state.filename = res.body.filename || file.name;
        state.total    = res.body.total || state.rows.length;
        renderMap();
        show('stepMap');
        $('stepMap').scrollIntoView({ behavior: 'smooth', block: 'start' });
      })
      .catch(function (err) {
        hide('parseProgress');
        setText('parseError', err.message || 'Network error.');
        show('parseError');
      });
  }

  // ── Render mapping table ─────────────────────────────────────────────────
  function renderMap() {
    setText('mapSubtitle',
      state.filename + ' · ' + state.total.toLocaleString() + ' rows · ' + state.columns.length + ' columns');

    var rows = REISIFT_OUTPUTS.map(function (out) {
      var current = state.autoMap[out] || '';
      var opts = ['<option value="">— skip / use default —</option>'];
      state.columns.forEach(function (c) {
        var sel = (c === current) ? ' selected' : '';
        opts.push('<option value="' + escHTML(c) + '"' + sel + '>' + escHTML(c) + '</option>');
      });
      return '<tr><td style="font-weight:600;color:#1a1f25">' + escHTML(out) + '</td>'
           + '<td><select class="ocu-input map-sel" data-output="' + escHTML(out) + '" style="min-width:240px">' + opts.join('') + '</select></td></tr>';
    }).join('');

    setHTML('mapTable',
      '<table class="ocu-result-table"><thead><tr>'
      + '<th style="width:40%">REISift output column</th><th>Maps from CSV column</th>'
      + '</tr></thead><tbody>' + rows + '</tbody></table>');
  }

  function collectMapping() {
    var m = {};
    var sels = document.querySelectorAll('.map-sel');
    for (var i = 0; i < sels.length; i++) {
      var s = sels[i];
      var out = s.getAttribute('data-output');
      if (s.value) m[out] = s.value;
    }
    return m;
  }

  // ── Step 2 → 3: run filtration ───────────────────────────────────────────
  function runFilter() {
    hide('processError');
    show('processProgress');
    var campaignId = $('campaignSelect').value || '';
    var mapping = collectMapping();

    fetch('/upload/filter/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        rows: state.rows,
        mapping: mapping,
        campaignId: campaignId,
        filename: state.filename,
      }),
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
      .then(function (res) {
        hide('processProgress');
        if (!res.ok || res.body.error) {
          setText('processError', res.body.error || 'Filtration failed.');
          show('processError');
          return;
        }
        state.lastResult = res.body;
        renderResults();
        show('stepResults');
        $('stepResults').scrollIntoView({ behavior: 'smooth', block: 'start' });
      })
      .catch(function (err) {
        hide('processProgress');
        setText('processError', err.message || 'Network error.');
        show('processError');
      });
  }

  // ── Render results ───────────────────────────────────────────────────────
  function renderResults() {
    var r = state.lastResult || {};
    var s = r.stats || {};
    var filtered = r.filteredMapped || [];
    var clean = r.cleanRows || [];

    setText('resultsSubtitle', state.filename + ' · ' + (s.total || 0).toLocaleString() + ' rows processed');

    var statCards = [
      { v: s.total || 0,     l: 'Total rows' },
      { v: s.kept || 0,      l: 'Clean (kept)' },
      { v: s.filtered || 0,  l: 'Filtered out' },
      { v: s.lists || 0,     l: 'Lists in file' },
      { v: s.memCaught || 0, l: 'Caught by memory' },
    ].map(function (c) {
      return '<div class="ocu-stat-card"><div class="v">' + Number(c.v).toLocaleString() + '</div><div class="l">' + escHTML(c.l) + '</div></div>';
    }).join('');
    setHTML('resultStats', statCards);

    setText('tabCountFiltered', filtered.length.toLocaleString());
    setText('tabCountClean', clean.length.toLocaleString());

    showTab('filtered');
  }

  function showTab(which) {
    var tabs = document.querySelectorAll('.ocu-tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('active', tabs[i].getAttribute('data-tab') === which);
    }
    var r = state.lastResult || {};
    var rows = (which === 'clean') ? (r.cleanRows || []) : (r.filteredMapped || []);
    var preview = rows.slice(0, 50);
    if (!preview.length) {
      setHTML('tabContent', '<div class="ocu-hint" style="padding:18px 0">No rows in this output.</div>');
      return;
    }
    var keys = Object.keys(preview[0]);
    var head = '<thead><tr>' + keys.map(function (k) { return '<th>' + escHTML(k) + '</th>'; }).join('') + '</tr></thead>';
    var body = '<tbody>' + preview.map(function (row) {
      return '<tr>' + keys.map(function (k) { return '<td title="' + escHTML(row[k] || '') + '">' + escHTML(row[k] == null ? '' : row[k]) + '</td>'; }).join('') + '</tr>';
    }).join('') + '</tbody>';
    setHTML('tabContent', '<table class="ocu-result-table">' + head + body + '</table>');
  }

  // ── Reset to step 1 ──────────────────────────────────────────────────────
  function reset() {
    state = { columns: [], rows: [], autoMap: {}, filename: '', total: 0, lastResult: null };
    hide('stepMap'); hide('stepResults');
    hide('parseError'); hide('processError');
    var input = $('csvFile'); if (input) input.value = '';
    $('stepUpload').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ── Memory ops ───────────────────────────────────────────────────────────
  function importMemory(file) {
    if (!file) return;
    if (!confirm('Replace current memory with the contents of "' + file.name + '"?')) return;
    var fd = new FormData();
    fd.append('memfile', file);
    fetch('/memory/import', { method: 'POST', body: fd, credentials: 'same-origin' })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
      .then(function (res) {
        if (!res.ok || res.body.error) { alert(res.body.error || 'Import failed.'); return; }
        alert('Imported ' + (res.body.count || 0) + ' memory entries. Reloading…');
        location.reload();
      })
      .catch(function (e) { alert('Import error: ' + e.message); });
  }

  function clearMemory() {
    if (!confirm('Clear ALL filtration memory? This cannot be undone.\n\nTip: export memory first as a backup.')) return;
    fetch('/memory/clear', { method: 'POST', credentials: 'same-origin' })
      .then(function () { alert('Memory cleared. Reloading…'); location.reload(); })
      .catch(function (e) { alert('Clear error: ' + e.message); });
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  function init() {
    loadCampaigns();
    wireDropZone();
  }

  // Public API used by inline onclick attributes.
  window.filtrationApp = {
    runFilter: runFilter,
    reset: reset,
    showTab: showTab,
    importMemory: importMemory,
    clearMemory: clearMemory,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
