// ═══════════════════════════════════════════════════════════════
// Loki Records List — Client-side JS
// Handles: filter panel dropdowns, row selection, Manage actions,
//          bulk export/delete/tag/remove-from-list flows.
//
// ⚠ 2026-04-17 audit fix: selectRow / selectAllRecords / clearSelection in
// shared-shell.js used to overwrite the globals here (writing to _selIds
// instead of selectedIds), so individual-row selections never triggered
// bulk actions. That block was deleted from shared-shell.js. The three
// debug statements that helped track it down (console.log in selectRow,
// and the "debug: selectedIds={...}" alert in openBulkTagModal) have
// also been removed.
// ═══════════════════════════════════════════════════════════════

// ── Marketing multi-select dropdowns ──
function toggleMkt(which) {
  const me    = document.getElementById('mkt-' + which + '-pop');
  const other = document.getElementById('mkt-' + (which === 'inc' ? 'exc' : 'inc') + '-pop');
  const opening = me.style.display !== 'block';
  me.style.display = opening ? 'block' : 'none';
  if (other) other.style.display = 'none';
}
function updateMktSummary(which) {
  const boxes = document.querySelectorAll('input[name="mkt_' + (which==='inc'?'include':'exclude') + '"]:checked');
  const vals = Array.from(boxes).map(b => b.value);
  document.getElementById('mkt-' + which + '-summary').textContent = vals.length > 0 ? vals.join(', ') : (which === 'inc' ? 'Any' : 'None');
}
// Close popovers on outside click
document.addEventListener('click', (e) => {
  ['inc','exc'].forEach(w => {
    const pop = document.getElementById('mkt-' + w + '-pop');
    const btn = document.getElementById('mkt-' + w + '-btn');
    if (pop && btn && !pop.contains(e.target) && !btn.contains(e.target)) {
      pop.style.display = 'none';
    }
  });
});

// ── Filter panel toggle + list stacking multi-select ──
function toggleFilters() {
  const p = document.getElementById('filter-panel');
  p.style.display = p.style.display === 'none' ? 'block' : 'none';
}

// ── Multi-select dropdown for List Stacking ────────────────────────────
function toggleMsDropdown(ev) {
  ev.stopPropagation();
  const dd = document.getElementById('ms-dropdown');
  const isOpen = dd.style.display === 'flex';
  dd.style.display = isOpen ? 'none' : 'flex';
  if (!isOpen) {
    const search = document.getElementById('ms-search');
    if (search) { search.value = ''; filterMsOptions(); setTimeout(() => search.focus(), 10); }
  }
}

document.addEventListener('click', function(e) {
  const wrapper = document.getElementById('ms-wrapper');
  if (wrapper && !wrapper.contains(e.target)) {
    const dd = document.getElementById('ms-dropdown');
    if (dd) dd.style.display = 'none';
  }
});

function filterMsOptions() {
  const q = document.getElementById('ms-search').value.toLowerCase();
  const opts = document.querySelectorAll('#ms-options .ms-option');
  opts.forEach(o => {
    const name = o.getAttribute('data-name') || '';
    o.style.display = name.includes(q) ? 'flex' : 'none';
  });
}

// 2026-04-21 PM hotfix: the search input lives inside <form id="filter-form">,
// so pressing Enter while typing submitted the form and reloaded the page —
// user-visible effect was "the dropdown disappears when I type the name."
// This handler (a) blocks Enter from submitting; (b) if there's exactly one
// visible option, toggles it (Enter-to-select is the standard search-select
// UX); (c) Escape closes the dropdown cleanly.
function msSearchKeydown(ev) {
  if (ev.key === 'Enter') {
    ev.preventDefault();
    const visible = Array.from(document.querySelectorAll('#ms-options .ms-option'))
      .filter(o => o.style.display !== 'none');
    if (visible.length === 1) {
      // Simulate a click on the sole match — reuses the toggleMsOption binding
      visible[0].click();
      // Clear the search so the next character starts fresh
      const s = document.getElementById('ms-search');
      if (s) { s.value = ''; filterMsOptions(); }
    }
    return false;
  }
  if (ev.key === 'Escape') {
    const dd = document.getElementById('ms-dropdown');
    if (dd) dd.style.display = 'none';
  }
}

function getSelectedStackIds() {
  const inputs = document.querySelectorAll('#ms-hidden-inputs input[name="stack_list"]');
  return Array.from(inputs).map(i => String(i.value));
}

function renderMsPills() {
  const ids = getSelectedStackIds();
  const pillsEl = document.getElementById('ms-pills');
  const countEl = document.getElementById('stack-count-label');
  if (countEl) countEl.textContent = '(' + ids.length + ' selected)';

  pillsEl.innerHTML = '';
  if (ids.length === 0) {
    const ph = document.createElement('span');
    ph.id = 'ms-placeholder';
    ph.style.cssText = 'color:#aaa;font-size:13px;padding:4px 2px';
    ph.textContent = 'Select lists…';
    pillsEl.appendChild(ph);
    return;
  }
  ids.forEach(id => {
    const opt = document.querySelector('#ms-options .ms-option[data-id="' + id + '"]');
    const name = opt ? opt.querySelector('span:last-child').textContent : ('List ' + id);
    const pill = document.createElement('span');
    pill.className = 'ms-pill';
    pill.setAttribute('data-id', id);
    pill.style.cssText = 'display:inline-flex;align-items:center;gap:5px;background:#e8f0ff;color:#1a4a9a;padding:3px 8px;border-radius:5px;font-size:12px;font-weight:500';
    pill.appendChild(document.createTextNode(name));
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.style.cssText = 'background:none;border:none;color:#1a4a9a;cursor:pointer;padding:0;font-size:14px;line-height:1;font-family:inherit';
    btn.textContent = '×';
    btn.addEventListener('click', function(ev) { removeMsPill(ev, id); });
    pill.appendChild(btn);
    pillsEl.appendChild(pill);
  });
}

function toggleMsOption(ev, id, name) {
  ev.stopPropagation();
  const sid = String(id);
  const container = document.getElementById('ms-hidden-inputs');
  const existing = container.querySelector('input[value="' + sid + '"]');
  const opt = document.querySelector('#ms-options .ms-option[data-id="' + sid + '"]');

  if (existing) {
    existing.remove();
    if (opt) {
      opt.classList.remove('ms-selected');
      opt.style.background = '';
      opt.style.color = '';
      opt.style.fontWeight = '';
      opt.querySelector('span').textContent = '';
    }
  } else {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = 'stack_list';
    input.value = sid;
    container.appendChild(input);
    if (opt) {
      opt.classList.add('ms-selected');
      opt.style.background = '#f0f7ff';
      opt.style.color = '#1a4a9a';
      opt.style.fontWeight = '500';
      opt.querySelector('span').textContent = '✓';
    }
  }
  renderMsPills();
}

function removeMsPill(ev, id) {
  ev.stopPropagation();
  const sid = String(id);
  const existing = document.querySelector('#ms-hidden-inputs input[value="' + sid + '"]');
  if (existing) existing.remove();
  const opt = document.querySelector('#ms-options .ms-option[data-id="' + sid + '"]');
  if (opt) {
    opt.classList.remove('ms-selected');
    opt.style.background = '';
    opt.style.color = '';
    opt.style.fontWeight = '';
    opt.querySelector('span').textContent = '';
  }
  renderMsPills();
}

// ── Multi-select dropdown for State (mirrors list stacking pattern) ────
function toggleStateMsDropdown(ev) {
  ev.stopPropagation();
  const dd = document.getElementById('state-ms-dropdown');
  const isOpen = dd.style.display === 'flex';
  dd.style.display = isOpen ? 'none' : 'flex';
  if (!isOpen) {
    const search = document.getElementById('state-ms-search');
    if (search) { search.value = ''; filterStateMsOptions(); setTimeout(() => search.focus(), 10); }
  }
}

document.addEventListener('click', function(e) {
  const wrapper = document.getElementById('state-ms-wrapper');
  if (wrapper && !wrapper.contains(e.target)) {
    const dd = document.getElementById('state-ms-dropdown');
    if (dd) dd.style.display = 'none';
  }
});

function filterStateMsOptions() {
  const q = document.getElementById('state-ms-search').value.toLowerCase();
  const opts = document.querySelectorAll('#state-ms-options .state-ms-option');
  opts.forEach(o => {
    const s = o.getAttribute('data-search') || '';
    o.style.display = s.includes(q) ? 'flex' : 'none';
  });
}

// 2026-04-21 PM hotfix: same Enter-submits-form bug as the list search above.
// Prevents the form submit and supports Enter-to-select when the user has
// narrowed down to a single match.
function stateMsSearchKeydown(ev) {
  if (ev.key === 'Enter') {
    ev.preventDefault();
    const visible = Array.from(document.querySelectorAll('#state-ms-options .state-ms-option'))
      .filter(o => o.style.display !== 'none');
    if (visible.length === 1) {
      visible[0].click();
      const s = document.getElementById('state-ms-search');
      if (s) { s.value = ''; filterStateMsOptions(); }
    }
    return false;
  }
  if (ev.key === 'Escape') {
    const dd = document.getElementById('state-ms-dropdown');
    if (dd) dd.style.display = 'none';
  }
}

function getSelectedStateCodes() {
  const inputs = document.querySelectorAll('#state-ms-hidden-inputs input[name="state"]');
  return Array.from(inputs).map(i => String(i.value));
}

function renderStateMsPills() {
  const codes = getSelectedStateCodes();
  const pillsEl = document.getElementById('state-ms-pills');
  const countEl = document.getElementById('state-count-label');
  if (countEl) countEl.textContent = codes.length > 0 ? '(' + codes.length + ' selected)' : '';

  pillsEl.innerHTML = '';
  if (codes.length === 0) {
    const ph = document.createElement('span');
    ph.id = 'state-ms-placeholder';
    ph.style.cssText = 'color:#aaa;font-size:13px;padding:2px';
    ph.textContent = 'All States';
    pillsEl.appendChild(ph);
    return;
  }
  codes.forEach(code => {
    const pill = document.createElement('span');
    pill.className = 'state-ms-pill';
    pill.setAttribute('data-id', code);
    pill.style.cssText = 'display:inline-flex;align-items:center;gap:4px;background:#e8f0ff;color:#1a4a9a;padding:2px 6px;border-radius:4px;font-size:12px;font-weight:500';
    pill.appendChild(document.createTextNode(code));
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.style.cssText = 'background:none;border:none;color:#1a4a9a;cursor:pointer;padding:0;font-size:13px;line-height:1;font-family:inherit';
    btn.textContent = '×';
    btn.addEventListener('click', function(ev) { removeStateMsPill(ev, code); });
    pill.appendChild(btn);
    pillsEl.appendChild(pill);
  });
}

function toggleStateMsOption(ev, code, name) {
  ev.stopPropagation();
  const container = document.getElementById('state-ms-hidden-inputs');
  const existing = container.querySelector('input[value="' + code + '"]');
  const opt = document.querySelector('#state-ms-options .state-ms-option[data-id="' + code + '"]');

  if (existing) {
    existing.remove();
    if (opt) {
      opt.classList.remove('state-ms-selected');
      opt.style.background = '';
      opt.style.color = '';
      opt.style.fontWeight = '';
      opt.querySelector('span').textContent = '';
    }
  } else {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = 'state';
    input.value = code;
    container.appendChild(input);
    if (opt) {
      opt.classList.add('state-ms-selected');
      opt.style.background = '#f0f7ff';
      opt.style.color = '#1a4a9a';
      opt.style.fontWeight = '500';
      opt.querySelector('span').textContent = '✓';
    }
  }
  renderStateMsPills();
}

function removeStateMsPill(ev, code) {
  ev.stopPropagation();
  const existing = document.querySelector('#state-ms-hidden-inputs input[value="' + code + '"]');
  if (existing) existing.remove();
  const opt = document.querySelector('#state-ms-options .state-ms-option[data-id="' + code + '"]');
  if (opt) {
    opt.classList.remove('state-ms-selected');
    opt.style.background = '';
    opt.style.color = '';
    opt.style.fontWeight = '';
    opt.querySelector('span').textContent = '';
  }
  renderStateMsPills();
}

// ── Selection, toolbar, manage menu, export, delete, RFL, bulk tags ──
var selectedIds = {};
var _allSelected = false;
var _pageTotal = parseInt(document.getElementById('select-all-banner')?.getAttribute('data-total') || '0', 10);
var _currentListId = (function() {
  var el = document.getElementById('export-toolbar');
  var n = parseInt(el ? el.getAttribute('data-list-id') : '', 10);
  return (!isNaN(n) && n > 0) ? n : null;
})();

function updateToolbar() {
  var count = _allSelected ? _pageTotal : Object.keys(selectedIds).length;
  var toolbar = document.getElementById('export-toolbar');
  var counter = document.getElementById('selected-count');
  if (toolbar) toolbar.style.display = count > 0 ? 'flex' : 'none';
  if (counter) counter.textContent = count.toLocaleString();
}

function selectRow(cb, checked) {
  _allSelected = false; // manual selection cancels "select all across pages"
  var banner = document.getElementById('select-all-banner');
  if (banner) banner.style.display = 'none';

  var id = cb.getAttribute('data-id');
  if (!id) return;
  cb.checked = checked;
  var tr = cb.parentNode.parentNode;
  if (tr) {
    if (checked) tr.classList.add('row-selected');
    else tr.classList.remove('row-selected');
  }
  if (checked) selectedIds[id] = true;
  else delete selectedIds[id];
  updateToolbar();
}

// Header checkbox: toggle every row on this page, then show cross-page banner
function selectAllOnPage(checked) {
  var boxes = document.querySelectorAll('.row-check');
  for (var i = 0; i < boxes.length; i++) {
    selectRow(boxes[i], checked);
  }
  var banner = document.getElementById('select-all-banner');
  if (banner) {
    var onPage = boxes.length;
    if (checked && _pageTotal > onPage) {
      banner.style.display = 'flex';
    } else {
      banner.style.display = 'none';
    }
  }
}

// "Select all N records" banner button — flags every filtered record on the server
function selectAllRecords() {
  _allSelected = true;
  var banner = document.getElementById('select-all-banner');
  if (banner) banner.style.display = 'none';
  updateToolbar();
}

function clearSelection() {
  selectedIds = {};
  _allSelected = false;
  var boxes = document.querySelectorAll('.row-check');
  for (var i = 0; i < boxes.length; i++) {
    boxes[i].checked = false;
    boxes[i].parentNode.parentNode.classList.remove('row-selected');
  }
  var sa = document.getElementById('select-all');
  if (sa) sa.checked = false;
  var banner = document.getElementById('select-all-banner');
  if (banner) banner.style.display = 'none';
  updateToolbar();
}

function openExportModal() {
  var m = document.getElementById('manage-menu');
  if (m) m.style.display = 'none';
  document.getElementById('export-modal').classList.add('open');
}

function openExportModalFromMenu() {
  openExportModal();
}

function checkAll(val) {
  var cols = document.querySelectorAll('.col-check');
  for (var i = 0; i < cols.length; i++) cols[i].checked = val;
}

async function doExport() {
  var colEls = document.querySelectorAll('.col-check:checked');
  var cols = [];
  for (var i = 0; i < colEls.length; i++) cols.push(colEls[i].value);
  if (!cols.length) { alert('Select at least one column.'); return; }
  var ids = Object.keys(selectedIds);
  if (!_allSelected && !ids.length) { alert('No records selected.'); return; }
  var cleanPhonesOnly = document.getElementById('clean-phones-only')?.checked ?? true;
  var btn = document.querySelector('[onclick="doExport()"]');
  if (btn) { btn.textContent = 'Downloading…'; btn.disabled = true; }
  try {
    var res = await fetch('/records/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: _allSelected ? [] : ids, columns: cols, selectAll: _allSelected, filterParams: window.location.search, cleanPhonesOnly: cleanPhonesOnly })
    });
    if (!res.ok) { alert('Export failed.'); return; }
    var blob = await res.blob();
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'loki_export_' + new Date().toISOString().split('T')[0] + '.csv';
    a.click();
    URL.revokeObjectURL(url);
    document.getElementById('export-modal').classList.remove('open');
  } catch(err) { alert('Export failed: ' + err.message); }
  finally { if (btn) { btn.textContent = 'Download CSV'; btn.disabled = false; } }
}

function openDeleteModal() {
  var m = document.getElementById('manage-menu');
  if (m) m.style.display = 'none';
  var ids = Object.keys(selectedIds);
  var count = _allSelected ? _pageTotal : ids.length;
  if (!_allSelected && !ids.length) { alert('No records selected.'); return; }
  var msg = _allSelected
    ? 'You are about to permanently delete <strong>all ' + count.toLocaleString() + ' records</strong> matching your current filter. This cannot be undone.'
    : 'You are about to permanently delete <strong>' + count + ' record' + (count===1?'':'s') + '</strong>. This cannot be undone.';
  document.getElementById('delete-modal-msg').innerHTML = msg;
  document.getElementById('delete-modal-err').style.display = 'none';
  document.getElementById('delete-code-input').value = '';
  document.getElementById('delete-modal').classList.add('open');
  setTimeout(function(){ document.getElementById('delete-code-input').focus(); }, 50);
}

async function confirmDelete() {
  var code = document.getElementById('delete-code-input').value;
  if (!code) {
    showDeleteErr('Delete code required.');
    return;
  }
  var ids = Object.keys(selectedIds);
  var btn = document.getElementById('delete-confirm-btn');
  btn.textContent = 'Deleting…';
  btn.disabled = true;
  try {
    var res = await fetch('/records/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids: _allSelected ? [] : ids,
        selectAll: _allSelected,
        filterParams: window.location.search,
        code: code
      })
    });
    var data = await res.json();
    if (!res.ok || data.error) {
      showDeleteErr(data.error || 'Delete failed.');
      btn.textContent = 'Delete Records';
      btn.disabled = false;
      return;
    }
    window.location.href = '/records?msg=' + encodeURIComponent('Deleted ' + data.deleted + ' record' + (data.deleted===1?'':'s') + '.');
  } catch(err) {
    showDeleteErr('Network error: ' + err.message);
    btn.textContent = 'Delete Records';
    btn.disabled = false;
  }
}

function showDeleteErr(msg) {
  var el = document.getElementById('delete-modal-err');
  el.textContent = msg;
  el.style.display = 'block';
}

// ─── Manage dropdown ──────────────────────────────────────────────────
function toggleManageMenu(ev) {
  ev.stopPropagation();
  var m = document.getElementById('manage-menu');
  m.style.display = (m.style.display === 'none' || !m.style.display) ? 'block' : 'none';
}
document.addEventListener('click', function(ev) {
  var m = document.getElementById('manage-menu');
  var btn = document.getElementById('manage-btn');
  if (m && m.style.display === 'block' && !m.contains(ev.target) && ev.target !== btn && btn && !btn.contains(ev.target)) {
    m.style.display = 'none';
  }
});

// ─── Remove from List modal ───────────────────────────────────────────
function openRemoveFromListModal() {
  document.getElementById('manage-menu').style.display = 'none';
  var ids = Object.keys(selectedIds);
  var count = _allSelected ? _pageTotal : ids.length;
  if (!_allSelected && !ids.length) { alert('No records selected.'); return; }
  if (!_currentListId) {
    alert('No list selected. Filter by a specific list first (Lists page → click a list) to use Remove from List.');
    return;
  }
  var msg = _allSelected
    ? 'Remove <strong>all ' + count.toLocaleString() + ' selected properties</strong> from this list? The properties themselves remain in Ocular; only their link to this list is removed.'
    : 'Remove <strong>' + count + ' propert' + (count===1?'y':'ies') + '</strong> from this list? The propert' + (count===1?'y remains':'ies remain') + ' in Ocular; only the link to this list is removed.';
  document.getElementById('rfl-modal-msg').innerHTML = msg;
  document.getElementById('rfl-modal-err').style.display = 'none';
  document.getElementById('rfl-code-input').value = '';
  document.getElementById('rfl-modal').classList.add('open');
  setTimeout(function(){ document.getElementById('rfl-code-input').focus(); }, 50);
}

async function confirmRemoveFromList() {
  var code = document.getElementById('rfl-code-input').value;
  if (!code) { showRflErr('Delete code required.'); return; }
  var ids = Object.keys(selectedIds);
  var btn = document.getElementById('rfl-confirm-btn');
  btn.textContent = 'Removing…';
  btn.disabled = true;
  try {
    var res = await fetch('/records/remove-from-list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids: _allSelected ? [] : ids,
        selectAll: _allSelected,
        filterParams: window.location.search,
        listId: _currentListId,
        code: code
      })
    });
    var data = await res.json();
    if (!res.ok || data.error) {
      showRflErr(data.error || 'Remove failed.');
      btn.textContent = 'Remove from List';
      btn.disabled = false;
      return;
    }
    window.location.href = '/records?list_id=' + _currentListId + '&msg=' + encodeURIComponent('Removed ' + data.removed + ' propert' + (data.removed===1?'y':'ies') + ' from this list.');
  } catch(err) {
    showRflErr('Network error: ' + err.message);
    btn.textContent = 'Remove from List';
    btn.disabled = false;
  }
}

function showRflErr(msg) {
  var el = document.getElementById('rfl-modal-err');
  el.textContent = msg;
  el.style.display = 'block';
}

// ─── 2026-04-21 Feature 9: Add to List ──────────────────────────────────
// Mirrors the Remove-from-List flow structurally but:
//   • No delete-code required — adding is non-destructive.
//   • Supports creating a new list inline via the "+ Create new list…"
//     option — keeps users in flow instead of bouncing to /lists/new.
//   • Works with individual checkbox selection AND cross-page selectAll
//     (same pattern as the other bulk actions).

function openAddToListModal() {
  document.getElementById('manage-menu').style.display = 'none';
  var ids = Object.keys(selectedIds);
  var count = _allSelected ? _pageTotal : ids.length;
  if (!_allSelected && !ids.length) { alert('No records selected.'); return; }
  var msg = _allSelected
    ? 'Add <strong>all ' + count.toLocaleString() + ' filtered properties</strong> to a list.'
    : 'Add <strong>' + count + ' selected propert' + (count===1?'y':'ies') + '</strong> to a list.';
  document.getElementById('atl-modal-msg').innerHTML = msg;
  document.getElementById('atl-modal-err').style.display = 'none';
  document.getElementById('atl-list-select').value = '';
  document.getElementById('atl-new-list-wrap').style.display = 'none';
  document.getElementById('atl-new-list-name').value = '';
  var btn = document.getElementById('atl-confirm-btn');
  btn.textContent = 'Add to List';
  btn.disabled = false;
  document.getElementById('atl-modal').classList.add('open');
  setTimeout(function(){ document.getElementById('atl-list-select').focus(); }, 50);
}

function atlOnSelectChange(sel) {
  var wrap = document.getElementById('atl-new-list-wrap');
  if (sel.value === '__new__') {
    wrap.style.display = 'block';
    setTimeout(function(){ document.getElementById('atl-new-list-name').focus(); }, 50);
  } else {
    wrap.style.display = 'none';
  }
}

async function confirmAddToList() {
  var sel = document.getElementById('atl-list-select');
  var listValue = sel.value;
  var newListName = '';
  if (!listValue) { showAtlErr('Pick a list first.'); return; }
  if (listValue === '__new__') {
    newListName = (document.getElementById('atl-new-list-name').value || '').trim();
    if (!newListName) { showAtlErr('New list name required.'); return; }
    if (newListName.length > 200) { showAtlErr('List name too long (max 200 chars).'); return; }
  }
  var ids = Object.keys(selectedIds);
  var btn = document.getElementById('atl-confirm-btn');
  btn.textContent = 'Adding…';
  btn.disabled = true;
  try {
    var res = await fetch('/records/add-to-list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids: _allSelected ? [] : ids,
        selectAll: _allSelected,
        filterParams: window.location.search,
        listId: listValue === '__new__' ? null : parseInt(listValue),
        newListName: newListName
      })
    });
    var data = await res.json();
    if (!res.ok || data.error) {
      showAtlErr(data.error || 'Add to list failed.');
      btn.textContent = 'Add to List';
      btn.disabled = false;
      return;
    }
    // Compose a useful flash message
    var msg = 'Added ' + data.added + ' propert' + (data.added===1?'y':'ies') + ' to "' + data.listName + '"';
    if (data.skipped > 0) msg += ' (' + data.skipped + ' already on the list, skipped)';
    // Preserve current filter state in the redirect — window.location.search
    // is either '' or starts with '?' so we just append ?msg or &msg.
    var qs = window.location.search;
    if (!qs) qs = '?msg=' + encodeURIComponent(msg);
    else qs = qs + '&msg=' + encodeURIComponent(msg);
    window.location.href = '/records' + qs;
  } catch(err) {
    showAtlErr('Network error: ' + err.message);
    btn.textContent = 'Add to List';
    btn.disabled = false;
  }
}

function showAtlErr(msg) {
  var el = document.getElementById('atl-modal-err');
  el.textContent = msg;
  el.style.display = 'block';
}

// ─── Bulk Tag modal ───────────────────────────────────────────────────
function _esc(s) {
  var d = document.createElement('div');
  d.appendChild(document.createTextNode(s));
  return d.innerHTML;
}
var _bulkTagMode = 'add';
var _bulkTagQueue = [];

function openBulkTagModal(mode) {
  document.getElementById('manage-menu').style.display = 'none';
  _bulkTagMode = mode;
  _bulkTagQueue = [];
  var ids = Object.keys(selectedIds);
  var count = _allSelected ? _pageTotal : ids.length;
  if (!_allSelected && !ids.length) { alert('No records selected.'); return; }

  document.getElementById('bulk-tag-title').textContent = mode === 'add' ? 'Add Tags' : 'Remove Tags';
  document.getElementById('bulk-tag-msg').innerHTML = mode === 'add'
    ? 'Add tags to <strong>' + count.toLocaleString() + ' selected propert' + (count===1?'y':'ies') + '</strong>. Type a tag name and press Enter — new tags are created automatically.'
    : 'Remove tags from <strong>' + count.toLocaleString() + ' selected propert' + (count===1?'y':'ies') + '</strong>. Check the tags you want to remove.';
  document.getElementById('bulk-tag-err').style.display = 'none';
  document.getElementById('bulk-tag-confirm-btn').textContent = 'Apply';
  document.getElementById('bulk-tag-confirm-btn').disabled = false;

  // Toggle add vs remove sections
  var addSec = document.getElementById('bulk-tag-add-section');
  var rmSec  = document.getElementById('bulk-tag-remove-section');
  if (mode === 'add') {
    addSec.style.display = '';
    rmSec.style.display = 'none';
    document.getElementById('bulk-tag-input').value = '';
    document.getElementById('bulk-tag-selected').innerHTML = '';
    setTimeout(function() { document.getElementById('bulk-tag-input').focus(); }, 100);
  } else {
    addSec.style.display = 'none';
    rmSec.style.display = 'block';
    // Clear any previously-checked boxes
    document.querySelectorAll('.bulk-tag-rm-check').forEach(function(cb) { cb.checked = false; });
  }
  document.getElementById('bulk-tag-modal').classList.add('open');
}

var _bulkTagSuggestTimer = null;
function bulkTagSuggest(q) {
  clearTimeout(_bulkTagSuggestTimer);
  var box = document.getElementById('bulk-tag-suggestions');
  // 2026-04-21 fix: when q is empty, still query the server — it returns the
  // top 50 tags alphabetically. Previously this early-returned and the
  // dropdown stayed hidden until the user typed something, which felt like
  // "0 results" on first click. Now clicking the field (or clearing it)
  // shows the full list so users can browse, not just search-by-prefix.
  _bulkTagSuggestTimer = setTimeout(async function() {
    try {
      var res = await fetch('/records/tags/suggest?q=' + encodeURIComponent((q||'').trim()));
      var tags = await res.json();
      var queued = _bulkTagQueue.map(function(t){ return t.id; });
      tags = tags.filter(function(t){ return queued.indexOf(t.id) === -1; });
      if (!tags.length) {
        // Real empty state — user has typed something with no matches, OR
        // every tag in the DB is already queued. Show a helpful message
        // instead of silently hiding the box (the "0 results" bug).
        box.innerHTML = '<div style="padding:10px 12px;font-size:12px;color:#aaa;font-style:italic">'
          + (q && q.trim() ? 'No matching tags — press Enter to create "' + _esc(q.trim()) + '"' : 'No tags exist yet — type a name and press Enter to create one')
          + '</div>';
        box.style.display = 'block';
        return;
      }
      box.innerHTML = tags.map(function(t){
        return '<div onclick="bulkTagPick(' + t.id + ', \'' + _esc(t.name).replace(/'/g,"\\'") + '\', \'' + (t.color||'#6b7280') + '\')" style="padding:8px 12px;cursor:pointer;font-size:13px;display:flex;align-items:center;gap:8px" onmouseover="this.style.background=\'#f5f4f0\'" onmouseout="this.style.background=\'none\'">'
          + '<span style="width:10px;height:10px;border-radius:50%;background:' + (t.color||'#6b7280') + '"></span>'
          + '<span>' + _esc(t.name) + '</span></div>';
      }).join('');
      box.style.display = 'block';
    } catch(e) { box.style.display = 'none'; }
  }, 200);
}

// 2026-04-21: wire up focus and click to trigger suggest with current value.
// This way the dropdown appears immediately when the user clicks into the
// field, not only after they've typed.
function bulkTagSuggestOnFocus() {
  var input = document.getElementById('bulk-tag-input');
  if (input) bulkTagSuggest(input.value || '');
}

function bulkTagPick(id, name, color) {
  if (_bulkTagQueue.some(function(t){ return t.id === id; })) return;
  _bulkTagQueue.push({ id: id, name: name, color: color });
  bulkTagRenderSelected();
  document.getElementById('bulk-tag-input').value = '';
  document.getElementById('bulk-tag-suggestions').style.display = 'none';
  document.getElementById('bulk-tag-input').focus();
}

function bulkTagAdd() {
  var input = document.getElementById('bulk-tag-input');
  var name = input.value.trim();
  if (!name) return;
  // Queue new tag (server will create or reuse by name on commit)
  if (_bulkTagQueue.some(function(t){ return t.name.toLowerCase() === name.toLowerCase(); })) {
    input.value = '';
    return;
  }
  _bulkTagQueue.push({ id: null, name: name, color: '#6b7280' });
  bulkTagRenderSelected();
  input.value = '';
  document.getElementById('bulk-tag-suggestions').style.display = 'none';
  input.focus();
}

function bulkTagRenderSelected() {
  var el = document.getElementById('bulk-tag-selected');
  el.innerHTML = _bulkTagQueue.map(function(t, i){
    return '<span style="display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:16px;font-size:12px;font-weight:500;background:' + t.color + '20;color:' + t.color + ';border:1px solid ' + t.color + '40">'
      + _esc(t.name)
      + ' <button onclick="bulkTagRemoveQueued(' + i + ')" style="background:none;border:none;cursor:pointer;font-size:14px;line-height:1;color:inherit;padding:0">×</button></span>';
  }).join('');
}

function bulkTagRemoveQueued(idx) {
  _bulkTagQueue.splice(idx, 1);
  bulkTagRenderSelected();
}

function showBulkTagErr(msg) {
  var el = document.getElementById('bulk-tag-err');
  el.textContent = msg;
  el.style.display = 'block';
}

async function confirmBulkTag() {
  var btn = document.getElementById('bulk-tag-confirm-btn');
  var ids = Object.keys(selectedIds);
  var tagNames = [], tagIds = [];
  if (_bulkTagMode === 'add') {
    // 2026-04-20 UX fix: if the user typed a tag name but hit Apply instead
    // of Enter, auto-commit the input value first so they don't have to
    // re-type it. Mirrors the natural flow — typing then clicking Apply
    // is at least as common as typing then pressing Enter.
    var pending = (document.getElementById('bulk-tag-input').value || '').trim();
    if (pending) bulkTagAdd();
    if (_bulkTagQueue.length === 0) { showBulkTagErr('Add at least one tag first.'); return; }
    tagNames = _bulkTagQueue.map(function(t){ return t.name; });
  } else {
    var checked = document.querySelectorAll('.bulk-tag-rm-check:checked');
    if (checked.length === 0) { showBulkTagErr('Check at least one tag to remove.'); return; }
    tagIds = Array.from(checked).map(function(cb){ return parseInt(cb.value); });
  }
  btn.textContent = 'Applying…';
  btn.disabled = true;
  try {
    var res = await fetch('/records/bulk-tag', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids: _allSelected ? [] : ids,
        selectAll: _allSelected,
        filterParams: window.location.search,
        mode: _bulkTagMode,
        tagNames: tagNames,
        tagIds: tagIds
      })
    });
    var data = await res.json();
    if (!res.ok || data.error) {
      showBulkTagErr(data.error || 'Operation failed.');
      btn.textContent = 'Apply';
      btn.disabled = false;
      return;
    }
    window.location.reload();
  } catch(err) {
    showBulkTagErr('Network error: ' + err.message);
    btn.textContent = 'Apply';
    btn.disabled = false;
  }
}

// Close bulk-tag suggestions on outside click
document.addEventListener('click', function(ev) {
  var box = document.getElementById('bulk-tag-suggestions');
  var input = document.getElementById('bulk-tag-input');
  if (box && !box.contains(ev.target) && ev.target !== input) {
    box.style.display = 'none';
  }
});
