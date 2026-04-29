// ui/pages/property-detail.js
// Composes the full property detail page using the shell + components.
// Page-specific click handlers live in /ocular-static/detail-actions.js
// (loaded at end of <body> via shell's extraBodyEnd hook).
//
// Write actions wired up:
//   1. Phone status pill click → option popover → save
//   2. Phone type chip click → option popover → save
//   3. Phone tag × → remove
//   4. Phone "+ tag" → inline input → enter → add
//   5. Property tag × → remove
//   6. Property "+ tag" → inline input → enter → add
//   7. Pipeline dropdown change → auto-save
//
// All handlers POST to existing Loki endpoints under /records/* — see
// detail-actions.js for the full list.
const { shell }              = require('../layouts/shell');
const { card }               = require('../components/card');
const { propertyHeader }     = require('../components/property-header');
const { propertyInfo }       = require('../components/property-info');
const { ownerCard }          = require('../components/owner-card');
const { distressBreakdown }  = require('../components/distress-breakdown');
const { tagChips }           = require('../components/tag-chips');
const { listMembership }     = require('../components/list-membership');
const { activityTimeline }   = require('../components/activity-timeline');
const { fmtNum, escHTML }    = require('../_helpers');

// 2026-04-29 user request: notes section per record. Each note is rendered
// as a row with author + relative time + body + a × delete button. The
// add-note input is a simple form posting to /records/:id/notes.
function fmtRel(d) {
  if (!d) return '';
  const ms = Date.now() - new Date(d).getTime();
  const min = Math.round(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return min + 'm ago';
  const hr = Math.round(min / 60);
  if (hr < 24) return hr + 'h ago';
  const day = Math.round(hr / 24);
  if (day < 30) return day + 'd ago';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function notesCard(propertyId, notes) {
  const list = (notes || []).map(n => `
    <div class="ocu-note" data-note-id="${escHTML(n.id)}">
      <div class="ocu-note-meta">
        <span class="ocu-note-author">${escHTML(n.author || 'Unknown')}</span>
        <span class="ocu-text-3" style="font-size:11px">${escHTML(fmtRel(n.created_at))}</span>
        <button type="button" class="ocu-note-remove" data-action="property-note-remove"
                data-property-id="${escHTML(propertyId)}" data-note-id="${escHTML(n.id)}"
                title="Delete note">×</button>
      </div>
      <div class="ocu-note-body">${escHTML(n.body)}</div>
    </div>`).join('');
  return `
    <div class="ocu-notes-add">
      <form id="ocu-note-form" data-property-id="${escHTML(propertyId)}"
            onsubmit="return ocu_addNote(event)">
        <textarea name="body" rows="2" maxlength="4000"
                  placeholder="Add a note about this property…"
                  class="ocu-textarea ocu-note-input"></textarea>
        <div style="display:flex;justify-content:flex-end;margin-top:6px">
          <button type="submit" class="ocu-btn ocu-btn-primary ocu-btn-sm">Add note</button>
        </div>
      </form>
    </div>
    <div class="ocu-notes-list" id="ocu-notes-list">
      ${list || '<div class="ocu-text-3" style="font-size:12px;font-style:italic;padding:8px 4px">No notes yet.</div>'}
    </div>`;
}

function propertyDetail(data) {
  data = data || {};
  const p = data.property || {};
  const primary = data.primaryContact || null;
  const secondaries = Array.isArray(data.secondaryContacts) ? data.secondaryContacts : [];
  const phones = Array.isArray(data.phones) ? data.phones : [];

  const ownerCards = [
    ownerCard({ contact: primary, phones, label: 'Owner 1', isPrimary: true }),
    ...secondaries.map((sc, i) => ownerCard({
      contact: sc,
      phones: sc.phones || [],
      label: 'Owner ' + (i + 2),
      isPrimary: false,
    })),
  ].filter(Boolean).join('');

  const distressCard = card({
    title: 'Distress score',
    meta: 'Total: ' + fmtNum(p.distress_score || 0),
    body: distressBreakdown({ score: p.distress_score, breakdown: data.distressBreakdown }),
  });

  // Pass propertyId so tag chips render with × buttons + the "+ tag" affordance.
  const tagsCard = card({
    title: 'Tags',
    body: tagChips({ tags: data.tags || [], propertyId: p.id }),
  });

  const listsCard = card({
    title: 'Lists',
    body: listMembership(data.lists || []),
  });

  const activityCard = card({
    title: 'Recent activity',
    meta: 'Calls and SMS · most recent first',
    body: activityTimeline(data.activity || []),
  });

  const propertyInfoCard = card({
    title: 'Property',
    body: propertyInfo(p),
  });

  const propNotesCard = card({
    title: 'Notes',
    meta:  Array.isArray(data.notes) && data.notes.length ? `${data.notes.length} on file` : '',
    body:  notesCard(p.id, data.notes || []),
  });

  const body = `
    ${propertyHeader(p)}

    <div class="ocu-detail-grid">
      <div class="ocu-detail-main">
        ${propertyInfoCard}
        <div class="ocu-owner-grid">
          ${ownerCards}
        </div>
        ${propNotesCard}
      </div>
      <div class="ocu-detail-side">
        ${distressCard}
        ${tagsCard}
        ${listsCard}
      </div>
    </div>

    ${activityCard}
  `;

  const titlePart = p.property_address
    ? p.property_address
    : 'Property #' + (p.id || '');

  return shell({
    title:       titlePart,
    body,
    activePage:  'records',
    user:        data.user || { name: 'User', initials: '?' },
    badges:      data.badges || {},
    // 2026-04-29 Tier-3 follow-up: was extraBodyEnd, but shell() only honors
    // extraHead. The script silently never loaded, so every onclick handler
    // wired up by detail-actions.js was dead — phone-tag-add/remove,
    // property-tag-add/remove, distress recompute, owner-occupancy toggle,
    // pipeline change, etc. The user reported "phone tag is broken" on
    // 2026-04-29; this was the root cause for all of them. Move to extraHead
    // with `defer` so it still runs after the DOM is parsed.
    extraHead: '<script src="/ocular-static/detail-actions.js?v=3" defer></script>',
  });
}

module.exports = { propertyDetail };
