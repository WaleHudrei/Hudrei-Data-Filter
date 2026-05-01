// ui/components/owner-card.js
// Renders a contact (Owner 1 or Owner 2) with mailing address and phones.
//
// 2026-04-25 Session-1 write actions: phone status, phone type, and phone
// tag add/remove are now editable inline. The pills carry data-* attributes
// the inline JS in detail-actions.js looks up to wire click handlers.
const { escHTML } = require('../_helpers');

const STATUS_OPTIONS = [
  { value: 'correct', label: 'Correct', bg: '#DCFCE7', fg: '#16A34A' },
  { value: 'wrong',   label: 'Wrong',   bg: '#FEF3C7', fg: '#D97706' },
  { value: 'dead',    label: 'Dead',    bg: '#FEE2E2', fg: '#DC2626' },
  { value: 'unknown', label: 'Unknown', bg: '#F3F4F6', fg: '#6B7280' },
];

const TYPE_OPTIONS = [
  { value: 'mobile',   label: 'Mobile',   bg: '#E0F2FE', fg: '#0369A1' },
  { value: 'landline', label: 'Landline', bg: '#EDE9FE', fg: '#6D28D9' },
  { value: 'voip',     label: 'VoIP',     bg: '#FEF3C7', fg: '#92400E' },
  { value: 'unknown',  label: 'Type ?',   bg: '#F3F4F6', fg: '#6B7280' },
];

// Loki stores `dead_number`; UI uses `dead`. Translate when reading.
function normalizeStatus(s) {
  const v = String(s || 'unknown').toLowerCase();
  if (v === 'dead_number') return 'dead';
  if (['correct', 'wrong', 'dead', 'unknown'].includes(v)) return v;
  return 'unknown';
}
function normalizeType(t) {
  const v = String(t || 'unknown').toLowerCase();
  if (['mobile', 'landline', 'voip', 'unknown'].includes(v)) return v;
  return 'unknown';
}

function statusPill(phoneId, status) {
  const v = normalizeStatus(status);
  const opt = STATUS_OPTIONS.find(o => o.value === v) || STATUS_OPTIONS[3];
  return `<button type="button" class="ocu-pill ocu-pill-editable" data-action="phone-status" data-phone-id="${phoneId}" data-current="${v}" style="background:${opt.bg};color:${opt.fg}">${opt.label}</button>`;
}

function typeChip(phoneId, type) {
  const v = normalizeType(type);
  const opt = TYPE_OPTIONS.find(o => o.value === v) || TYPE_OPTIONS[3];
  return `<button type="button" class="ocu-pill ocu-pill-editable" data-action="phone-type" data-phone-id="${phoneId}" data-current="${v}" style="background:${opt.bg};color:${opt.fg}">${opt.label}</button>`;
}

function phoneTagChip(phoneId, t) {
  const c = String(t.color || '#6B7280');
  return `<span class="ocu-tag-pill ocu-tag-removable" style="border-color:${c};color:${c};background:${c}11">
    <span>${escHTML(t.name)}</span>
    <button type="button" class="ocu-tag-remove" data-action="phone-tag-remove" data-phone-id="${phoneId}" data-tag-id="${t.id}" title="Remove">×</button>
  </span>`;
}

// "Best to call" scoring (Task 4). Mirrors the rubric in pages/owner-detail.js
// — verified+mobile wins, anything wrong/dead/DNC drops to negative. The phone
// list rendered by ownerCard then highlights the top scorer with a ★ Best pill.
function scorePhone(ph) {
  if (!ph || !ph.phone_number) return -Infinity;
  const status = String(ph.phone_status || '').toLowerCase();
  const type   = String(ph.phone_type   || '').toLowerCase();
  if (status === 'wrong' || status === 'dead' || status === 'dead_number' || ph.wrong_number) return -100;
  if (ph.do_not_call) return -100;
  let s = 0;
  if (status === 'correct') s += 50;
  if (type === 'mobile')    s += 20;
  if (type === 'landline')  s += 10;
  return s;
}

// Pencil + trash icons for the per-phone-row Edit / Remove affordances.
const _ICON_PENCIL = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>';
const _ICON_TRASH  = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';

function phoneRow(ph, isBest) {
  const tags = (ph.tags || []).map(t => phoneTagChip(ph.id, t)).join('');
  const bestPill = isBest
    ? `<span class="ocu-phone-best" title="Best phone to call — verified and most likely to reach the owner">★ Best</span>`
    : '';
  // 2026-05-01: per-row Edit + Remove icon-buttons. Sit at the top-right
  // of the phone card. Clicking Edit toggles an inline input over the
  // number; clicking Remove confirms and DELETEs the phone via
  // /records/phones/:id/delete.
  return `
    <div class="ocu-phone-row${isBest ? ' is-best' : ''}" data-phone-id="${ph.id}" data-phone-number="${escHTML(ph.phone_number || '')}">
      <div class="ocu-phone-line">
        <span class="ocu-phone-num" data-phone-num-display>${escHTML(ph.phone_number || '')}</span>
        <span class="ocu-phone-meta">
          ${bestPill}
          ${typeChip(ph.id, ph.phone_type)}
          ${statusPill(ph.id, ph.phone_status)}
        </span>
        <span class="ocu-phone-row-actions">
          <button type="button" class="ocu-phone-icon-btn" data-action="phone-edit" data-phone-id="${ph.id}" title="Edit phone number" aria-label="Edit phone number">${_ICON_PENCIL}</button>
          <button type="button" class="ocu-phone-icon-btn ocu-phone-icon-btn-danger" data-action="phone-delete" data-phone-id="${ph.id}" title="Remove phone" aria-label="Remove phone">${_ICON_TRASH}</button>
        </span>
      </div>
      <div class="ocu-phone-edit-form" hidden data-phone-id="${ph.id}">
        <input type="tel" inputmode="tel" autocomplete="off" maxlength="20" class="ocu-input ocu-phone-edit-input" value="${escHTML(ph.phone_number || '')}" />
        <button type="button" class="ocu-btn ocu-btn-primary ocu-btn-sm" data-action="phone-edit-save" data-phone-id="${ph.id}">Save</button>
        <button type="button" class="ocu-btn ocu-btn-ghost ocu-btn-sm" data-action="phone-edit-cancel" data-phone-id="${ph.id}">Cancel</button>
      </div>
      <div class="ocu-phone-tags" data-phone-tags-for="${ph.id}">
        ${tags}
        <button type="button" class="ocu-add-chip" data-action="phone-tag-add" data-phone-id="${ph.id}">+ tag</button>
      </div>
    </div>`;
}

// Stable hash-color avatar — same palette/seed as records-table so the
// same person looks the same color on both pages.
const AVATAR_PALETTE = [
  { bg: '#DBEAFE', fg: '#1D4ED8' }, // blue
  { bg: '#FEF3C7', fg: '#92400E' }, // amber
  { bg: '#DCFCE7', fg: '#15803D' }, // green
  { bg: '#FCE7F3', fg: '#BE185D' }, // pink
  { bg: '#EDE9FE', fg: '#6D28D9' }, // violet
  { bg: '#FFE4E6', fg: '#9F1239' }, // rose
];
function ownerInitials(first, last) {
  const f = (first || '').trim();
  const l = (last  || '').trim();
  const ini = ((f[0] || '') + (l[0] || '')).toUpperCase() || '?';
  let h = 0;
  const seed = (f + l).toLowerCase();
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const c = AVATAR_PALETTE[h % AVATAR_PALETTE.length];
  return `<span class="ocu-owner-avatar" style="background:${c.bg};color:${c.fg}">${escHTML(ini)}</span>`;
}

// Inline currentColor SVGs — pin (mailing) + phone (phones).
const _ICON_PIN = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>';
const _ICON_PHN = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>';

function ownerCard(opts = {}) {
  const {
    contact = null,
    phones = [],
    label = 'Owner',
    isPrimary = true,
  } = opts;

  if (!contact) return '';

  const fullName = [contact.first_name, contact.last_name]
    .filter(Boolean).map(escHTML).join(' ') || '<em style="color:var(--ocu-text-3)">Unnamed</em>';
  const avatar = ownerInitials(contact.first_name, contact.last_name);

  const mailingParts = [contact.mailing_address, contact.mailing_city, contact.mailing_state]
    .filter(Boolean).map(escHTML).join(', ');
  const mailingZip = contact.mailing_zip ? ` ${escHTML(contact.mailing_zip)}` : '';
  const mailing = mailingParts ? `${mailingParts}${mailingZip}` : '';

  // 2026-05-01 user request: show 2 phones visible by default. If more
  // exist, an expand chevron next to the count chip reveals the rest
  // INSIDE the same card (no link-out to a separate page). Best-scoring
  // phone is always pinned to position 0 of the visible group.
  const PHONE_VISIBLE = 2;
  let bestIdxAll = -1, bestScore = 0;
  for (let i = 0; i < phones.length; i++) {
    const s = scorePhone(phones[i]);
    if (s > bestScore) { bestScore = s; bestIdxAll = i; }
  }
  // Reorder phones so the best phone is first, then fill the rest in
  // original order. The first PHONE_VISIBLE entries become the visible
  // group; the remainder are hidden behind the expand toggle.
  let orderedPhones;
  if (phones.length <= PHONE_VISIBLE || bestIdxAll < 0 || bestIdxAll < PHONE_VISIBLE) {
    orderedPhones = phones.slice();
  } else {
    orderedPhones = [phones[bestIdxAll]];
    for (let i = 0; i < phones.length; i++) {
      if (i === bestIdxAll) continue;
      orderedPhones.push(phones[i]);
    }
  }
  const visibleGroup = orderedPhones.slice(0, PHONE_VISIBLE);
  const hiddenGroup  = orderedPhones.slice(PHONE_VISIBLE);
  const bestInOrdered = orderedPhones.findIndex(p => p === phones[bestIdxAll]);

  const visibleHTML = visibleGroup.length
    ? visibleGroup.map((p, i) => phoneRow(p, i === bestInOrdered)).join('')
    : `<div class="ocu-phones-empty">No phones on record.</div>`;
  const hiddenHTML = hiddenGroup.length
    ? hiddenGroup.map((p, i) => phoneRow(p, (i + PHONE_VISIBLE) === bestInOrdered)).join('')
    : '';

  const profileHref = contact.id ? `/oculah/owners/${escHTML(String(contact.id))}` : '';
  const profileLink = profileHref
    ? `<a class="ocu-owner-profile-link" href="${profileHref}" title="Open ${escHTML(contact.first_name || '')} ${escHTML(contact.last_name || '')}'s profile">View profile <span aria-hidden="true">→</span></a>`
    : '';

  // 2026-05-01 latest spec: 3-column row — Owner | Mailing | Phones.
  // The +Add phone button + expand-more chevron live INSIDE the phones
  // section header (right side) instead of being their own column. This
  // simplifies the visual hierarchy ("phones" is one bounded section) and
  // means the chevron is always adjacent to the phones it reveals.
  //   Col 1 (200px): owner number + PRIMARY + name + View profile
  //   Col 2 (220px): mailing label + address (or "—")
  //   Col 3 (1fr) : phones header (label + count + expand + Add phone)
  //                 + visible phones (max 2) + collapsible hidden phones
  const expandToggle = hiddenGroup.length
    ? `<button type="button" class="ocu-phones-expand" data-action="phones-toggle" aria-expanded="false" title="Show ${hiddenGroup.length} more phone${hiddenGroup.length === 1 ? '' : 's'}"><span class="ocu-phones-expand-text">+${hiddenGroup.length} more</span><span class="ocu-phones-expand-icon" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></span></button>`
    : '';
  // 2026-05-01: per-owner phone cap is 4. When the owner is at the cap,
  // the +Add phone button visually disables and the title explains why.
  // The server enforces the same limit (POST /records/contacts/:id/phones)
  // so a stale tab that bypasses this can still get the toast error.
  const PHONE_CAP_PER_OWNER = 4;
  const atCap = phones.length >= PHONE_CAP_PER_OWNER;
  const addPhoneBtn = contact.id
    ? `<button type="button" class="ocu-owner-add-phone-btn" data-action="add-phone" data-contact-id="${escHTML(String(contact.id))}"${atCap ? ' disabled' : ''} title="${atCap ? `Limit of ${PHONE_CAP_PER_OWNER} phones reached — remove one to add another` : 'Add a new phone for this contact'}">+ Add phone</button>`
    : '';

  return `
    <div class="ocu-card ocu-owner-card">
      <div class="ocu-owner-row">
        <div class="ocu-owner-col-identity">
          ${avatar}
          <div class="ocu-owner-titles">
            <div class="ocu-owner-label-row">
              <span class="ocu-owner-label">${escHTML(label)}</span>
              ${isPrimary ? '<span class="ocu-owner-primary-tag">Primary</span>' : ''}
            </div>
            <div class="ocu-owner-name">${fullName}</div>
            ${profileLink}
          </div>
        </div>

        <div class="ocu-owner-col-mailing">
          <div class="ocu-owner-section-label"><span class="ocu-owner-section-icon">${_ICON_PIN}</span>Mailing address</div>
          <div class="ocu-owner-section-value">${mailing || '<span class="ocu-text-3">—</span>'}</div>
        </div>

        <div class="ocu-owner-col-phones" data-contact-id="${escHTML(String(contact.id || ''))}">
          <div class="ocu-owner-section-label">
            <span class="ocu-owner-section-icon">${_ICON_PHN}</span>Phones
            <span class="ocu-owner-count-chip">${phones.length}</span>
            <span class="ocu-phones-header-actions">
              ${expandToggle}
              ${addPhoneBtn}
            </span>
          </div>
          <div class="ocu-phones-grid">${visibleHTML}</div>
          ${hiddenHTML ? `<div class="ocu-phones-grid ocu-phones-hidden" hidden data-phones-hidden>${hiddenHTML}</div>` : ''}
        </div>
      </div>
    </div>`;
}

module.exports = { ownerCard, STATUS_OPTIONS, TYPE_OPTIONS };
