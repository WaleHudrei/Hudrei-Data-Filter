// ui/components/tag-chips.js
// Property tag pill cluster with inline add + remove. Each removable pill
// has an × button; an "+ tag" button at the end opens a small input.
//
// 2026-04-25 Made interactive (was read-only). Caller must pass propertyId
// so the click handlers know which property to act on.
const { escHTML } = require('../_helpers');

function tagChips(opts = {}) {
  // Backward-compat: if called with just an array, treat as read-only
  if (Array.isArray(opts)) opts = { tags: opts, propertyId: null };

  const tags = Array.isArray(opts.tags) ? opts.tags : [];
  const propertyId = opts.propertyId;
  const editable = propertyId != null;

  const pills = tags.map(t => {
    const c = String(t.color || '#6B7280');
    if (!editable) {
      return `<span class="ocu-tag-pill" style="border-color:${c};color:${c};background:${c}11">${escHTML(t.name)}</span>`;
    }
    return `<span class="ocu-tag-pill ocu-tag-removable" style="border-color:${c};color:${c};background:${c}11">
      <span>${escHTML(t.name)}</span>
      <button type="button" class="ocu-tag-remove" data-action="property-tag-remove" data-property-id="${propertyId}" data-tag-id="${t.id}" title="Remove">×</button>
    </span>`;
  }).join('');

  const addBtn = editable
    ? `<button type="button" class="ocu-add-chip" data-action="property-tag-add" data-property-id="${propertyId}">+ tag</button>`
    : '';

  if (!tags.length && !editable) {
    return `<div style="color:var(--ocu-text-3);font-size:13px;padding:4px 0">No tags.</div>`;
  }

  return `
    <div class="ocu-tag-cluster" data-property-tags-for="${propertyId || ''}">
      ${pills}
      ${addBtn}
    </div>`;
}

module.exports = { tagChips };
