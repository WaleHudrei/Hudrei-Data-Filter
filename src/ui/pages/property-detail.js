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

  // 2026-04-29 user request: when a property has NO primary contact, render
  // an "Add owner" inline form instead of a blank Owner 1 card. Option A
  // — no auto-created placeholder rows in the DB; the operator chooses
  // when to create one. POST handler is /records/:id/owner.
  const addOwnerCard = !primary ? `
    <div class="ocu-card ocu-add-owner-card">
      <div class="ocu-card-title">Add owner</div>
      <div class="ocu-text-3" style="font-size:12px;margin-bottom:10px">No owner is linked to this property yet. Add one below.</div>
      <form id="ocu-add-owner-form" data-property-id="${p.id || ''}" onsubmit="return ocu_addOwner(event)">
        <div class="ocu-form-grid">
          <div class="ocu-form-field">
            <label class="ocu-form-label">First name</label>
            <input type="text" name="first_name" maxlength="100" class="ocu-input" autocomplete="off">
          </div>
          <div class="ocu-form-field">
            <label class="ocu-form-label">Last name</label>
            <input type="text" name="last_name" maxlength="100" class="ocu-input" autocomplete="off">
          </div>
          <div class="ocu-form-field">
            <label class="ocu-form-label">Owner type</label>
            <select name="owner_type" class="ocu-input">
              <option value="">Auto-detect</option>
              <option value="Person">Person</option>
              <option value="Company">Company</option>
              <option value="Trust">Trust</option>
            </select>
          </div>
          <div class="ocu-form-field" style="grid-column:1 / -1">
            <label class="ocu-form-label">Mailing address (optional)</label>
            <input type="text" name="mailing_address" maxlength="255" class="ocu-input" placeholder="Street address">
          </div>
          <div class="ocu-form-field">
            <label class="ocu-form-label">Mailing city</label>
            <input type="text" name="mailing_city" maxlength="100" class="ocu-input">
          </div>
          <div class="ocu-form-field">
            <label class="ocu-form-label">Mailing state</label>
            <input type="text" name="mailing_state" maxlength="10" class="ocu-input" placeholder="2-letter code">
          </div>
          <div class="ocu-form-field">
            <label class="ocu-form-label">Mailing ZIP</label>
            <input type="text" name="mailing_zip" maxlength="10" class="ocu-input">
          </div>
        </div>
        <div style="display:flex;justify-content:flex-end;margin-top:10px;gap:8px">
          <button type="submit" class="ocu-btn ocu-btn-primary">Save owner</button>
        </div>
      </form>
    </div>` : '';

  const ownerCards = primary
    ? [
        ownerCard({ contact: primary, phones, label: 'Owner 1', isPrimary: true }),
        ...secondaries.map((sc, i) => ownerCard({
          contact: sc,
          phones: sc.phones || [],
          label: 'Owner ' + (i + 2),
          isPrimary: false,
        })),
      ].filter(Boolean).join('')
    : addOwnerCard;

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

  // 2026-04-29 user request: Edit button on property page. Modal uses
  // the native <dialog> element so we don't need a 3rd-party modal lib.
  // Pre-populated with current property values; on submit, posts JSON
  // to /records/:id/edit-fields and reloads the page.
  const editFieldVal = (key) => p[key] != null ? escHTML(String(p[key])) : '';
  const editPropertyDialog = `
    <dialog id="ocu-edit-property-dialog" class="ocu-dialog">
      <form id="ocu-edit-property-form" data-property-id="${p.id || ''}"
            onsubmit="return ocu_editProperty(event)" class="ocu-dialog-form">
        <div class="ocu-dialog-header">
          <div class="ocu-dialog-title">Edit property</div>
          <button type="button" class="ocu-dialog-close"
                  onclick="document.getElementById('ocu-edit-property-dialog').close()" aria-label="Close">×</button>
        </div>
        <div class="ocu-form-grid">
          <div class="ocu-form-field"><label class="ocu-form-label">Property type</label>
            <input type="text" name="property_type" value="${editFieldVal('property_type')}" class="ocu-input"></div>
          <div class="ocu-form-field"><label class="ocu-form-label">Year built</label>
            <input type="number" name="year_built" value="${editFieldVal('year_built')}" class="ocu-input" min="1800" max="2100"></div>
          <div class="ocu-form-field"><label class="ocu-form-label">Sqft</label>
            <input type="number" name="sqft" value="${editFieldVal('sqft')}" class="ocu-input" min="0"></div>
          <div class="ocu-form-field"><label class="ocu-form-label">Bedrooms</label>
            <input type="number" name="bedrooms" value="${editFieldVal('bedrooms')}" class="ocu-input" min="0"></div>
          <div class="ocu-form-field"><label class="ocu-form-label">Bathrooms</label>
            <input type="number" name="bathrooms" value="${editFieldVal('bathrooms')}" class="ocu-input" min="0" step="0.5"></div>
          <div class="ocu-form-field"><label class="ocu-form-label">Estimated value ($)</label>
            <input type="number" name="estimated_value" value="${editFieldVal('estimated_value')}" class="ocu-input" min="0"></div>
          <div class="ocu-form-field"><label class="ocu-form-label">Assessed value ($)</label>
            <input type="number" name="assessed_value" value="${editFieldVal('assessed_value')}" class="ocu-input" min="0"></div>
          <div class="ocu-form-field"><label class="ocu-form-label">Equity %</label>
            <input type="number" name="equity_percent" value="${editFieldVal('equity_percent')}" class="ocu-input" min="-100" max="100" step="0.1"></div>
          <div class="ocu-form-field"><label class="ocu-form-label">Last sale date</label>
            <input type="date" name="last_sale_date" value="${p.last_sale_date ? new Date(p.last_sale_date).toISOString().slice(0,10) : ''}" class="ocu-input"></div>
          <div class="ocu-form-field"><label class="ocu-form-label">Last sale price ($)</label>
            <input type="number" name="last_sale_price" value="${editFieldVal('last_sale_price')}" class="ocu-input" min="0"></div>
          <div class="ocu-form-field"><label class="ocu-form-label">Source</label>
            <input type="text" name="source" value="${editFieldVal('source')}" class="ocu-input"></div>
          <div class="ocu-form-field"><label class="ocu-form-label">County</label>
            <input type="text" name="county" value="${editFieldVal('county')}" class="ocu-input"></div>
        </div>
        <div class="ocu-dialog-footer">
          <button type="button" class="ocu-btn ocu-btn-ghost"
                  onclick="document.getElementById('ocu-edit-property-dialog').close()">Cancel</button>
          <button type="submit" class="ocu-btn ocu-btn-primary">Save changes</button>
        </div>
      </form>
    </dialog>`;

  const body = `
    ${propertyHeader(p)}
    ${editPropertyDialog}

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
    extraHead: '<script src="/ocular-static/detail-actions.js?v=5" defer></script>',
  });
}

module.exports = { propertyDetail };
