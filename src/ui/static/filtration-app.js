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

  // ── Campaigns combobox ───────────────────────────────────────────────────
  // Replaces the native <select> with a searchable dropdown so it stays
  // usable as the campaign list grows past 10+. Renders into
  // #campaignBoxList; selecting an option writes the campaign id to the
  // hidden #campaignSelect input (kept under the same id so the existing
  // .value reads in runFilter() continue to work without changes).
  var _allCampaigns = [];

  function loadCampaigns() {
    fetch('/api/campaigns', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (list) {
        _allCampaigns = (list || []).map(function (c) {
          return { id: String(c.id), name: c.name || ('Campaign ' + c.id) };
        });
        renderCampaignList('');
        var current = $('campaignBoxTrigger');
        if (current) current.querySelector('.ocu-combobox-current').textContent = '— select campaign —';
      })
      .catch(function () {
        var current = $('campaignBoxTrigger');
        if (current) current.querySelector('.ocu-combobox-current').textContent = '— could not load campaigns —';
      });
  }

  function renderCampaignList(filter) {
    var listEl = $('campaignBoxList');
    if (!listEl) return;
    var q = String(filter || '').trim().toLowerCase();
    var matches = q
      ? _allCampaigns.filter(function (c) { return c.name.toLowerCase().indexOf(q) !== -1; })
      : _allCampaigns;
    if (!matches.length) {
      listEl.innerHTML = '<div class="ocu-combobox-empty">No campaigns match "' + escHTML(filter) + '"</div>';
      return;
    }
    listEl.innerHTML = matches.map(function (c) {
      return '<button type="button" class="ocu-combobox-option" role="option" data-id="' + escHTML(c.id) + '">' + escHTML(c.name) + '</button>';
    }).join('');
  }

  function setCampaign(id, name) {
    var hidden = $('campaignSelect');
    var trigger = $('campaignBoxTrigger');
    if (hidden) hidden.value = id;
    if (trigger) trigger.querySelector('.ocu-combobox-current').textContent = name || '— select campaign —';
    closeCampaignBox();
    // Mirror the change event the old <select> emitted so any listener
    // attached to the hidden input still fires.
    if (hidden) hidden.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function openCampaignBox() {
    var pop = $('campaignBoxPopover');
    var trigger = $('campaignBoxTrigger');
    var search = $('campaignBoxSearch');
    if (!pop || !trigger) return;
    pop.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    if (search) {
      search.value = '';
      renderCampaignList('');
      setTimeout(function () { search.focus(); }, 0);
    }
  }
  function closeCampaignBox() {
    var pop = $('campaignBoxPopover');
    var trigger = $('campaignBoxTrigger');
    if (!pop || !trigger) return;
    pop.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  }

  function wireCampaignBox() {
    var box = $('campaignBox');
    var trigger = $('campaignBoxTrigger');
    var search = $('campaignBoxSearch');
    var listEl = $('campaignBoxList');
    if (!box || !trigger || !search || !listEl) return;

    trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      var pop = $('campaignBoxPopover');
      if (pop && pop.hidden) openCampaignBox(); else closeCampaignBox();
    });

    search.addEventListener('input', function () { renderCampaignList(search.value); });
    search.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeCampaignBox(); trigger.focus(); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        var first = listEl.querySelector('.ocu-combobox-option');
        if (first) first.click();
      }
    });

    listEl.addEventListener('click', function (e) {
      var opt = e.target.closest && e.target.closest('.ocu-combobox-option');
      if (!opt) return;
      var id = opt.dataset.id;
      var name = opt.textContent;
      setCampaign(id, name);
    });

    // Click outside closes the popover.
    document.addEventListener('click', function (e) {
      if (!box.contains(e.target)) closeCampaignBox();
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
    wireCampaignBox();
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
