// ui/components/bulk-action-bar.js
// Floating action bar that appears when at least one row is selected.
// Shows count + the action buttons. The bar's visibility is toggled by the
// inline JS in /oculah-static/records-bulk.js.
//
// Design: starts hidden (visibility:hidden). Bulk JS sets `data-active="true"`
// on a parent when count > 0, which CSS uses to show + animate it in.
function bulkActionBar() {
  return `
    <div class="ocu-bulk-bar" id="ocu-bulk-bar" data-active="false">
      <div class="ocu-bulk-bar-inner">
        <div class="ocu-bulk-status">
          <span class="ocu-bulk-count" id="ocu-bulk-count">0</span>
          <span class="ocu-bulk-label" id="ocu-bulk-label">selected</span>
          <button type="button" class="ocu-bulk-selectall-link" id="ocu-bulk-selectall-link" hidden>
            Select all <span id="ocu-bulk-selectall-total"></span> across all pages
          </button>
          <button type="button" class="ocu-bulk-clear" id="ocu-bulk-clear">Clear</button>
        </div>
        <div class="ocu-bulk-actions">
          <button type="button" class="ocu-btn ocu-btn-secondary" data-bulk-action="add-tag">Add tag</button>
          <button type="button" class="ocu-btn ocu-btn-secondary" data-bulk-action="remove-tag">Remove tag</button>
          <button type="button" class="ocu-btn ocu-btn-secondary" data-bulk-action="add-list">Add to list</button>
          <button type="button" class="ocu-btn ocu-btn-secondary" data-bulk-action="remove-list">Remove from list</button>
          <button type="button" class="ocu-btn ocu-btn-secondary" data-bulk-action="export">Export CSV</button>
          <button type="button" class="ocu-btn ocu-btn-danger" data-bulk-action="delete">Delete</button>
        </div>
      </div>
    </div>`;
}

module.exports = { bulkActionBar };
