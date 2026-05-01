// ui/pages/property-detail.js
// Composes the full property detail page using the shell + components.
// Page-specific click handlers live in /oculah-static/detail-actions.js
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

  // 2026-05-01 user request: an Edit Owners button that opens a dialog
  // where the user can remove existing owners and add a new one. All
  // changes go through /records/:id/owner POST and DELETE so the DB is
  // the single source of truth — no client-only state, the page reloads
  // after each change so every dependent surface (records list, MV
  // counts, owner profile pages) reflects the new state.
  const allOwners = primary
    ? [{ ...primary, _isPrimary: true, _label: 'Owner 1' },
       ...secondaries.map((sc, i) => ({ ...sc, _isPrimary: false, _label: 'Owner ' + (i + 2) }))]
    : [];

  // 2026-05-01 polish pass + inline edit. Each owner row is now a card with
  // an avatar, label/name, and three actions: Edit (opens an inline form),
  // Make primary (if not already), Remove. The Add Another Owner form is
  // collapsed by default behind a "+ Add another owner" button so the
  // dialog opens compact instead of dumping a 7-field form on the user.
  const _ownerInitials = (fn, ln) => {
    const f = (fn || '').trim();
    const l = (ln || '').trim();
    return ((f[0] || '') + (l[0] || '')).toUpperCase() || '?';
  };
  const _ownerEditFormFields = (o) => `
    <div class="ocu-form-grid">
      <div class="ocu-form-field">
        <label class="ocu-form-label">First name</label>
        <input type="text" name="first_name" value="${escHTML(o.first_name || '')}" maxlength="100" class="ocu-input" autocomplete="off">
      </div>
      <div class="ocu-form-field">
        <label class="ocu-form-label">Last name</label>
        <input type="text" name="last_name" value="${escHTML(o.last_name || '')}" maxlength="100" class="ocu-input" autocomplete="off">
      </div>
      <div class="ocu-form-field">
        <label class="ocu-form-label">Owner type</label>
        <select name="owner_type" class="ocu-input">
          <option value=""${!o.owner_type ? ' selected' : ''}>— Auto-detect —</option>
          <option value="Person"${o.owner_type === 'Person' ? ' selected' : ''}>Person</option>
          <option value="Company"${o.owner_type === 'Company' ? ' selected' : ''}>Company</option>
          <option value="Trust"${o.owner_type === 'Trust' ? ' selected' : ''}>Trust</option>
        </select>
      </div>
      <div class="ocu-form-field" style="grid-column: 1 / -1">
        <label class="ocu-form-label">Mailing address</label>
        <input type="text" name="mailing_address" value="${escHTML(o.mailing_address || '')}" maxlength="255" class="ocu-input" autocomplete="off">
      </div>
      <div class="ocu-form-field">
        <label class="ocu-form-label">Mailing city</label>
        <input type="text" name="mailing_city" value="${escHTML(o.mailing_city || '')}" maxlength="100" class="ocu-input">
      </div>
      <div class="ocu-form-field">
        <label class="ocu-form-label">Mailing state</label>
        <input type="text" name="mailing_state" value="${escHTML(o.mailing_state || '')}" maxlength="10" class="ocu-input" placeholder="2-letter code">
      </div>
      <div class="ocu-form-field">
        <label class="ocu-form-label">Mailing ZIP</label>
        <input type="text" name="mailing_zip" value="${escHTML(o.mailing_zip || '')}" maxlength="10" class="ocu-input">
      </div>
    </div>`;

  const editOwnersDialog = `
    <dialog id="ocu-edit-owners-dialog" class="ocu-dialog ocu-dialog-edit-owners">
      <div class="ocu-dialog-header">
        <div>
          <div class="ocu-dialog-title">Edit owners</div>
          <div class="ocu-dialog-subtitle">${allOwners.length ? `${allOwners.length} owner${allOwners.length === 1 ? '' : 's'} on this property` : 'No owners yet'}</div>
        </div>
        <button type="button" class="ocu-dialog-close" data-action="close-edit-owners" aria-label="Close">×</button>
      </div>
      <div class="ocu-dialog-body" data-property-id="${escHTML(String(p.id || ''))}">
        <div class="ocu-edit-owners-list" id="ocu-edit-owners-list">
          ${allOwners.length ? allOwners.map(o => {
            const fullName = ((o.first_name || '') + ' ' + (o.last_name || '')).trim() || 'Unnamed';
            const cityState = [o.mailing_city, o.mailing_state].filter(Boolean).join(', ');
            const sub = o.mailing_address ? `${o.mailing_address}${cityState ? ' · ' + cityState : ''}` : (o.owner_type || '—');
            return `
            <div class="ocu-edit-owner-row" data-contact-id="${escHTML(String(o.id))}">
              <div class="ocu-edit-owner-summary">
                <div class="ocu-edit-owner-avatar">${escHTML(_ownerInitials(o.first_name, o.last_name))}</div>
                <div class="ocu-edit-owner-info">
                  <div class="ocu-edit-owner-label">${escHTML(o._label)}${o._isPrimary ? ' <span class="ocu-owner-primary-tag">Primary</span>' : ''}</div>
                  <div class="ocu-edit-owner-name">${escHTML(fullName)}</div>
                  <div class="ocu-edit-owner-sub">${escHTML(sub)}</div>
                </div>
                <div class="ocu-edit-owner-actions">
                  <button type="button" class="ocu-btn ocu-btn-secondary ocu-btn-sm" data-action="owner-edit-toggle" data-contact-id="${escHTML(String(o.id))}">Edit</button>
                  ${!o._isPrimary ? `<button type="button" class="ocu-btn ocu-btn-ghost ocu-btn-sm" data-action="owner-make-primary" data-property-id="${escHTML(String(p.id))}" data-contact-id="${escHTML(String(o.id))}">Make primary</button>` : ''}
                  <button type="button" class="ocu-btn ocu-btn-danger-ghost ocu-btn-sm" data-action="owner-remove" data-property-id="${escHTML(String(p.id))}" data-contact-id="${escHTML(String(o.id))}" title="Remove this owner">Remove</button>
                </div>
              </div>
              <form class="ocu-edit-owner-form" hidden data-action="owner-edit-submit" data-property-id="${escHTML(String(p.id || ''))}" data-contact-id="${escHTML(String(o.id))}">
                ${_ownerEditFormFields(o)}
                <div class="ocu-edit-owner-form-actions">
                  <button type="button" class="ocu-btn ocu-btn-ghost ocu-btn-sm" data-action="owner-edit-cancel" data-contact-id="${escHTML(String(o.id))}">Cancel</button>
                  <button type="submit" class="ocu-btn ocu-btn-primary ocu-btn-sm">Save changes</button>
                </div>
              </form>
            </div>`;
          }).join('') : '<div class="ocu-edit-owners-empty">No owners on this property yet. Add one below.</div>'}
        </div>

        <div class="ocu-edit-owners-add-trigger" id="ocu-edit-owners-add-trigger">
          <button type="button" class="ocu-btn ocu-btn-secondary" data-action="open-add-owner-form">+ Add another owner</button>
        </div>

        <div class="ocu-edit-owners-add" id="ocu-edit-owners-add" hidden>
          <div class="ocu-edit-owners-add-header">Add another owner</div>
          <form id="ocu-edit-owners-add-form" data-property-id="${escHTML(String(p.id || ''))}">
            ${_ownerEditFormFields({})}
            <div class="ocu-edit-owner-form-actions">
              <button type="button" class="ocu-btn ocu-btn-ghost ocu-btn-sm" data-action="cancel-add-owner-form">Cancel</button>
              <button type="submit" class="ocu-btn ocu-btn-primary ocu-btn-sm">Add owner</button>
            </div>
          </form>
        </div>
      </div>
    </dialog>`;

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

  // 2026-04-30 user request: full editor — every property column is
  // editable from this dialog. Sectioned layout (Address / Property /
  // Valuation / Tax & Liens / Pipeline / Legal). Required NOT-NULL columns
  // (street, city, state_code, zip_code) carry the `required` attribute so
  // the browser blocks submit if the user blanks them. Optional columns
  // accept empty input — the server clears them via `SET col = NULL`.
  const editFieldVal = (key) => p[key] != null ? escHTML(String(p[key])) : '';
  const editDateVal = (key) => p[key] ? new Date(p[key]).toISOString().slice(0, 10) : '';

  const US_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'];
  const stateSelected = String(p.state_code || '').toUpperCase();
  const stateOptions = US_STATES.map(s =>
    `<option value="${s}"${s === stateSelected ? ' selected' : ''}>${s}</option>`
  ).join('');

  const PIPELINE_STAGES = [
    { v: 'prospect', label: 'Prospect' },
    { v: 'lead',     label: 'Lead' },
    { v: 'contract', label: 'Contract' },
    { v: 'closed',   label: 'Closed' },
    { v: 'dead',     label: 'Dead' },
  ];
  const stageSelected = String(p.pipeline_stage || 'prospect').toLowerCase();
  const stageOptions = PIPELINE_STAGES.map(s =>
    `<option value="${s.v}"${s.v === stageSelected ? ' selected' : ''}>${escHTML(s.label)}</option>`
  ).join('');

  const vacantSelected = p.vacant === true ? 'true' : p.vacant === false ? 'false' : '';
  const vacantOptions = `
    <option value=""${vacantSelected === '' ? ' selected' : ''}>— Unknown —</option>
    <option value="true"${vacantSelected === 'true' ? ' selected' : ''}>Yes (vacant)</option>
    <option value="false"${vacantSelected === 'false' ? ' selected' : ''}>No (occupied)</option>`;

  // Compact field helper to keep the markup readable.
  const field = (label, name, html) => `
    <div class="ocu-form-field">
      <label class="ocu-form-label">${escHTML(label)}</label>
      ${html}
    </div>`;
  const txt = (name, opts = {}) => {
    const required = opts.required ? ' required' : '';
    const max      = opts.maxlength ? ` maxlength="${opts.maxlength}"` : '';
    const ph       = opts.placeholder ? ` placeholder="${escHTML(opts.placeholder)}"` : '';
    return `<input type="text" name="${name}" value="${editFieldVal(name)}"${max}${required}${ph} class="ocu-input">`;
  };
  const num = (name, opts = {}) => {
    const min  = opts.min  != null ? ` min="${opts.min}"`  : '';
    const max  = opts.max  != null ? ` max="${opts.max}"`  : '';
    const step = opts.step != null ? ` step="${opts.step}"` : '';
    return `<input type="number" name="${name}" value="${editFieldVal(name)}"${min}${max}${step} class="ocu-input">`;
  };
  const dat = (name) =>
    `<input type="date" name="${name}" value="${editDateVal(name)}" class="ocu-input">`;

  const sectionHdr = (title) =>
    `<div class="ocu-edit-section-header">${escHTML(title)}</div>`;

  const editPropertyDialog = `
    <dialog id="ocu-edit-property-dialog" class="ocu-dialog ocu-dialog-wide">
      <form id="ocu-edit-property-form" data-property-id="${p.id || ''}"
            onsubmit="return ocu_editProperty(event)" class="ocu-dialog-form">
        <div class="ocu-dialog-header">
          <div class="ocu-dialog-title">Edit property</div>
          <button type="button" class="ocu-dialog-close"
                  onclick="document.getElementById('ocu-edit-property-dialog').close()" aria-label="Close">×</button>
        </div>

        <div class="ocu-dialog-body">
        <div class="ocu-edit-property-error" style="display:none;background:#fdeaea;border:1px solid #f5c5c5;border-radius:8px;padding:10px 14px;font-size:13px;color:#8b1f1f;margin-bottom:14px"></div>

        ${sectionHdr('Address')}
        <div class="ocu-form-grid">
          ${field('Street *', 'street', txt('street', { required: true, maxlength: 255 }))}
          ${field('City *',   'city',   txt('city',   { required: true, maxlength: 100 }))}
          ${field('State *',  'state_code', `<select name="state_code" required class="ocu-input"><option value="">— Select state —</option>${stateOptions}</select>`)}
          ${field('Zip *',    'zip_code', txt('zip_code', { required: true, maxlength: 10, placeholder: '12345' }))}
          ${field('County',   'county',   txt('county',   { maxlength: 100 }))}
          ${field('APN',      'apn',      txt('apn',      { maxlength: 50, placeholder: 'Parcel number' }))}
        </div>

        ${sectionHdr('Property details')}
        <div class="ocu-form-grid">
          ${field('Property type',  'property_type',  txt('property_type',  { maxlength: 50, placeholder: 'SFR, MFR, Condo…' }))}
          ${field('Structure type', 'structure_type', txt('structure_type', { maxlength: 50 }))}
          ${field('Year built',     'year_built',     num('year_built',     { min: 1800, max: 2100 }))}
          ${field('Sqft',           'sqft',           num('sqft',           { min: 0 }))}
          ${field('Lot size (sqft)','lot_size',       num('lot_size',       { min: 0 }))}
          ${field('Stories',        'stories',        num('stories',        { min: 0, max: 10 }))}
          ${field('Bedrooms',       'bedrooms',       num('bedrooms',       { min: 0 }))}
          ${field('Bathrooms',      'bathrooms',      num('bathrooms',      { min: 0, step: 0.5 }))}
          ${field('Condition',      'condition',      txt('condition',      { maxlength: 50, placeholder: 'Excellent / Good / Fair / Poor' }))}
          ${field('Vacant',         'vacant',         `<select name="vacant" class="ocu-input">${vacantOptions}</select>`)}
        </div>

        ${sectionHdr('Valuation')}
        <div class="ocu-form-grid">
          ${field('Estimated value ($)', 'estimated_value',  num('estimated_value',  { min: 0 }))}
          ${field('Assessed value ($)',  'assessed_value',   num('assessed_value',   { min: 0 }))}
          ${field('Equity %',            'equity_percent',   num('equity_percent',   { min: -100, max: 100, step: 0.1 }))}
          ${field('Last sale date',      'last_sale_date',   dat('last_sale_date'))}
          ${field('Last sale price ($)', 'last_sale_price',  num('last_sale_price',  { min: 0 }))}
        </div>

        ${sectionHdr('Tax & liens')}
        <div class="ocu-form-grid">
          ${field('Total tax owed ($)',     'total_tax_owed',      num('total_tax_owed',      { min: 0 }))}
          ${field('Tax delinquent year',    'tax_delinquent_year', num('tax_delinquent_year', { min: 1900, max: 2100 }))}
          ${field('Tax auction date',       'tax_auction_date',    dat('tax_auction_date'))}
          ${field('Deed type',              'deed_type',           txt('deed_type',           { maxlength: 50 }))}
          ${field('Lien type',              'lien_type',           txt('lien_type',           { maxlength: 50 }))}
          ${field('Lien date',              'lien_date',           dat('lien_date'))}
        </div>

        ${sectionHdr('Pipeline & meta')}
        <div class="ocu-form-grid">
          ${field('Pipeline stage',  'pipeline_stage',  `<select name="pipeline_stage" class="ocu-input">${stageOptions}</select>`)}
          ${field('Property status', 'property_status', txt('property_status', { maxlength: 50 }))}
          ${field('Source',          'source',          txt('source',          { maxlength: 100 }))}
        </div>

        ${sectionHdr('Legal description')}
        <div class="ocu-form-field" style="margin-bottom:8px">
          <textarea name="legal_description" rows="4" class="ocu-input" placeholder="Optional legal description from county records.">${editFieldVal('legal_description')}</textarea>
        </div>
        </div><!-- /.ocu-dialog-body -->

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
        <div class="ocu-owners-section-header">
          <div class="ocu-owners-section-title">Owners ${primary ? `<span class="ocu-text-3" style="font-weight:400;font-size:13px">· ${1 + secondaries.length}</span>` : ''}</div>
          <button type="button" class="ocu-btn ocu-btn-secondary ocu-btn-sm" data-action="open-edit-owners">Edit owners</button>
        </div>
        <div class="ocu-owner-grid">
          ${ownerCards}
        </div>
        ${editOwnersDialog}
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
    title:           titlePart,
    // Back-link to Records list lives in the topbar slot. Rendered as a
    // small text link (not the bold page-title style) so it visually reads
    // as a navigation aid instead of competing with the property address
    // heading inside the body.
    topbarTitleHTML: '<a href="/oculah/records" class="ocu-detail-backlink ocu-topbar-backlink">← All records</a>',
    body,
    activePage:      'records',
    user:            data.user || { name: 'User', initials: '?' },
    badges:          data.badges || {},
    // 2026-04-29 Tier-3 follow-up: was extraBodyEnd, but shell() only honors
    // extraHead. The script silently never loaded, so every onclick handler
    // wired up by detail-actions.js was dead — phone-tag-add/remove,
    // property-tag-add/remove, distress recompute, owner-occupancy toggle,
    // pipeline change, etc. The user reported "phone tag is broken" on
    // 2026-04-29; this was the root cause for all of them. Move to extraHead
    // with `defer` so it still runs after the DOM is parsed.
    extraHead: '<script src="/oculah-static/detail-actions.js?v=10" defer></script>',
  });
}

module.exports = { propertyDetail };
