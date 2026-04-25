/* ═══════════════════════════════════════════════════════════════════════════
   ui/static/records-bulk.js
   Bulk-selection logic for the Ocular records list.
   Loaded only on /ocular/records (the list page).

   Design:
     - Selection state lives in two places:
         (a) selectedIds — Set of property IDs currently checked on this page
         (b) selectAllAcrossPages — boolean, true when user has clicked the
             "select all N across all pages" link in the action bar
     - When selectAllAcrossPages is true, individual row checkboxes still
       behave normally on the visible page (visual consistency), but the
       authoritative source for "what to act on" is the filterParams URL.
     - All bulk endpoints are old Loki routes under /records/* — they take
       { selectAll, filterParams, ids, ...action-specific }.

   Endpoints used:
     POST /records/bulk-tag           { selectAll, filterParams, ids, mode:'add', tagNames:[] }
     POST /records/remove-from-list   { selectAll, filterParams, ids, listId, code }
     POST /records/delete             { selectAll, filterParams, ids, code }
     POST /records/export             { selectAll, filterParams, ids, columns, cleanPhonesOnly }
   ═══════════════════════════════════════════════════════════════════════════ */
(function() {
  'use strict';

  // ─── State ────────────────────────────────────────────────────────────────
  const selectedIds = new Set();
  let selectAllAcrossPages = false;
  let totalRowsAcrossPages = 0;

  // Read totalRows from data attr on the bulk bar — server-rendered.
  // Read filter querystring from the current URL, stripped of `page` so the
  // selectAll endpoint operates on the full filtered result set.
  function getFilterParams() {
    const params = new URLSearchParams(window.location.search);
    params.delete('page');
    return params.toString();
  }

  // ─── DOM refs ─────────────────────────────────────────────────────────────
  const bar              = document.getElementById('ocu-bulk-bar');
  const countEl          = document.getElementById('ocu-bulk-count');
  const labelEl          = document.getElementById('ocu-bulk-label');
  const selectAllLink    = document.getElementById('ocu-bulk-selectall-link');
  const selectAllTotalEl = document.getElementById('ocu-bulk-selectall-total');
  const clearBtn         = document.getElementById('ocu-bulk-clear');

  // The action bar may not exist if the page rendered with 0 results
  if (!bar) return;

  // The total comes from a data attr the page sets — see records-list.js
  totalRowsAcrossPages = parseInt(bar.dataset.totalRows || '0', 10);

  // ─── Toast helper (re-uses the same toast styles as detail-actions.js) ─────
  let toastTimer = null;
  function toast(msg, isError) {
    let t = document.getElementById('ocu-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'ocu-toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.className = 'ocu-toast' + (isError ? ' err' : ' ok');
    t.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.style.opacity = '0'; }, 2800);
  }

  async function jpost(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body || {}),
    });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) {
      const msg = (data && data.error) || ('HTTP ' + res.status);
      throw new Error(msg);
    }
    return data;
  }

  // ─── Selection state mutations ────────────────────────────────────────────
  function refreshBar() {
    const onPageCount = selectedIds.size;
    const isAcross = selectAllAcrossPages;
    const count = isAcross ? totalRowsAcrossPages : onPageCount;

    if (count === 0) {
      bar.dataset.active = 'false';
      selectAllLink.hidden = true;
      return;
    }

    bar.dataset.active = 'true';
    countEl.textContent = count.toLocaleString();
    labelEl.textContent = (count === 1 ? 'property' : 'properties') + ' selected';

    // Show "Select all N across all pages" only when:
    //   - User has selected at least 1 row on this page
    //   - There are MORE properties than what's selected
    //   - selectAllAcrossPages isn't already true
    if (!isAcross && totalRowsAcrossPages > onPageCount && onPageCount > 0) {
      selectAllLink.hidden = false;
      selectAllTotalEl.textContent = totalRowsAcrossPages.toLocaleString();
    } else {
      selectAllLink.hidden = true;
    }
  }

  function clearSelection() {
    selectedIds.clear();
    selectAllAcrossPages = false;
    document.querySelectorAll('.ocu-row-check').forEach(cb => { cb.checked = false; });
    const headCb = document.querySelector('.ocu-row-checkall');
    if (headCb) headCb.checked = false;
    refreshBar();
  }

  // ─── Event wiring ─────────────────────────────────────────────────────────

  // Individual row checkbox
  document.addEventListener('change', e => {
    const cb = e.target.closest('.ocu-row-check');
    if (!cb) return;
    const id = parseInt(cb.dataset.id, 10);
    if (!id) return;
    if (cb.checked) selectedIds.add(id);
    else            selectedIds.delete(id);
    // If user touches an individual row while in select-all-across mode,
    // drop back to per-page mode so the action operates on visible selection.
    if (selectAllAcrossPages) {
      selectAllAcrossPages = false;
    }
    refreshBar();
  });

  // Header "select all on page" checkbox
  document.addEventListener('change', e => {
    const cb = e.target.closest('.ocu-row-checkall');
    if (!cb) return;
    const rows = document.querySelectorAll('.ocu-row-check');
    if (cb.checked) {
      rows.forEach(r => {
        r.checked = true;
        const id = parseInt(r.dataset.id, 10);
        if (id) selectedIds.add(id);
      });
    } else {
      rows.forEach(r => {
        r.checked = false;
        const id = parseInt(r.dataset.id, 10);
        if (id) selectedIds.delete(id);
      });
      selectAllAcrossPages = false;
    }
    refreshBar();
  });

  // "Select all N across pages" link
  selectAllLink.addEventListener('click', () => {
    selectAllAcrossPages = true;
    // Visually, also check every row on this page (for clarity)
    document.querySelectorAll('.ocu-row-check').forEach(r => { r.checked = true; });
    const headCb = document.querySelector('.ocu-row-checkall');
    if (headCb) headCb.checked = true;
    refreshBar();
  });

  // "Clear" button
  clearBtn.addEventListener('click', clearSelection);

  // Row click navigation — if the click landed on a checkbox cell, ignore;
  // otherwise navigate to the detail page.
  document.addEventListener('click', e => {
    const tr = e.target.closest('.ocu-tr-clickable');
    if (!tr) return;
    // If the click was inside the checkbox cell, we already stopPropagation'd it
    if (e.target.closest('.ocu-td-check')) return;
    const id = tr.dataset.rowId;
    if (id) window.location = '/ocular/records/' + id;
  });

  // ─── Bulk action dispatcher ───────────────────────────────────────────────
  document.addEventListener('click', async e => {
    const btn = e.target.closest('[data-bulk-action]');
    if (!btn) return;
    const action = btn.dataset.bulkAction;
    if (action === 'add-tag')      return doAddTag();
    if (action === 'remove-list')  return doRemoveList();
    if (action === 'export')       return doExport();
    if (action === 'delete')       return doDelete();
  });

  function buildSelectionPayload() {
    return selectAllAcrossPages
      ? { selectAll: true,  filterParams: getFilterParams(), ids: [] }
      : { selectAll: false, ids: Array.from(selectedIds) };
  }

  function selectionCount() {
    return selectAllAcrossPages ? totalRowsAcrossPages : selectedIds.size;
  }

  // ─── Bulk: Add tag ────────────────────────────────────────────────────────
  async function doAddTag() {
    const name = prompt('Tag name to add to ' + selectionCount().toLocaleString() + ' properties:');
    if (!name || !name.trim()) return;
    try {
      const data = await jpost('/records/bulk-tag', {
        ...buildSelectionPayload(),
        mode: 'add',
        tagNames: [name.trim()],
      });
      toast('Tag added to ' + (data.affected || 0) + ' new properties', false);
      // Reload to reflect the new tag count and any other state changes
      setTimeout(() => window.location.reload(), 800);
    } catch (err) {
      toast('Bulk tag failed: ' + err.message, true);
    }
  }

  // ─── Bulk: Remove from list ───────────────────────────────────────────────
  async function doRemoveList() {
    const listIdStr = prompt('Enter the list ID to remove these properties from.\n(Tip: visit Loki list page to find the ID.)');
    if (!listIdStr) return;
    const listId = parseInt(listIdStr, 10);
    if (!Number.isFinite(listId) || listId <= 0) {
      toast('Invalid list ID', true);
      return;
    }
    const code = prompt('Enter delete code to confirm:');
    if (!code) return;
    if (!confirm('Remove ' + selectionCount().toLocaleString() + ' properties from list ' + listId + '?')) return;
    try {
      const data = await jpost('/records/remove-from-list', {
        ...buildSelectionPayload(),
        listId, code,
      });
      toast('Removed ' + (data.affected || 0) + ' from list', false);
      setTimeout(() => window.location.reload(), 800);
    } catch (err) {
      toast('Remove from list failed: ' + err.message, true);
    }
  }

  // ─── Bulk: Delete ─────────────────────────────────────────────────────────
  async function doDelete() {
    const count = selectionCount();
    if (!confirm('PERMANENTLY delete ' + count.toLocaleString() + ' properties? This cannot be undone.')) return;
    const code = prompt('Enter delete code to confirm:');
    if (!code) return;
    try {
      const data = await jpost('/records/delete', {
        ...buildSelectionPayload(),
        code,
      });
      toast('Deleted ' + (data.deleted || data.affected || 0) + ' properties', false);
      setTimeout(() => window.location.reload(), 800);
    } catch (err) {
      toast('Delete failed: ' + err.message, true);
    }
  }

  // ─── Bulk: Export CSV ────────────────────────────────────────────────────
  // Uses a default column set — if the user wants more, they can use the old
  // Loki export form. We submit a programmatic form so the browser's native
  // file-download flow takes over (the response is text/csv).
  async function doExport() {
    if (!confirm('Export ' + selectionCount().toLocaleString() + ' properties to CSV?')) return;
    const defaultColumns = [
      'street','city','state_code','zip_code','county',
      'property_type','year_built','sqft','bedrooms','bathrooms',
      'first_name','last_name','owner_type','is_primary',
      'mailing_address','mailing_city','mailing_state','mailing_zip',
      'phones',
      'assessed_value','estimated_value','equity_percent',
      'pipeline_stage','distress_score','distress_band',
      'list_count','created_at',
    ];
    // Programmatic form POST to /records/export
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = '/records/export';
    form.style.display = 'none';

    function add(name, value) {
      const i = document.createElement('input');
      i.type = 'hidden';
      i.name = name;
      i.value = value;
      form.appendChild(i);
    }
    if (selectAllAcrossPages) {
      add('selectAll', 'true');
      add('filterParams', getFilterParams());
    } else {
      add('selectAll', 'false');
      Array.from(selectedIds).forEach(id => add('ids[]', String(id)));
    }
    defaultColumns.forEach(c => add('columns[]', c));
    add('cleanPhonesOnly', 'true');

    document.body.appendChild(form);
    // /records/export expects JSON, not form-encoded — so we use fetch instead.
    document.body.removeChild(form);

    // Build the JSON body and POST it. Server returns CSV text — turn it
    // into a Blob and trigger download client-side.
    try {
      toast('Building export…', false);
      const body = selectAllAcrossPages
        ? { selectAll: true, filterParams: getFilterParams(), columns: defaultColumns, cleanPhonesOnly: true }
        : { selectAll: false, ids: Array.from(selectedIds), columns: defaultColumns, cleanPhonesOnly: true };
      const res = await fetch('/records/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let err = 'HTTP ' + res.status;
        try { const j = await res.json(); err = j.error || err; } catch (_) {}
        throw new Error(err);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const stamp = new Date().toISOString().slice(0, 10);
      a.download = 'ocular-records-' + stamp + '.csv';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast('Export downloaded', false);
    } catch (err) {
      toast('Export failed: ' + err.message, true);
    }
  }

  // Initial render — bar starts hidden via dataset
  refreshBar();
})();
