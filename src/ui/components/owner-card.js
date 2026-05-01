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

function phoneRow(ph, isBest) {
  const tags = (ph.tags || []).map(t => phoneTagChip(ph.id, t)).join('');
  const bestPill = isBest
    ? `<span class="ocu-phone-best" title="Best phone to call — verified and most likely to reach the owner">★ Best</span>`
    : '';
  return `
    <div class="ocu-phone-row${isBest ? ' is-best' : ''}" data-phone-id="${ph.id}">
      <div class="ocu-phone-line">
        <span class="ocu-phone-num">${escHTML(ph.phone_number || '')}</span>
        <span class="ocu-phone-meta">
          ${bestPill}
          ${typeChip(ph.id, ph.phone_type)}
          ${statusPill(ph.id, ph.phone_status)}
        </span>
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

  // 2026-05-01 user request: cap visible phones at 4 per owner card. The
  // best-scoring phone is ALWAYS shown (pinned at index 0 of the cap) so
  // the operator never has to scroll/expand to see the recommended dial.
  // Remaining slots fill in original order. Hidden phones get a
  // "View all N phones →" link to the owner profile where the full list
  // lives.
  const PHONE_CAP = 4;
  let bestIdxAll = -1, bestScore = 0;
  for (let i = 0; i < phones.length; i++) {
    const s = scorePhone(phones[i]);
    if (s > bestScore) { bestScore = s; bestIdxAll = i; }
  }
  let visiblePhones;
  if (phones.length <= PHONE_CAP) {
    visiblePhones = phones.slice();
  } else {
    // Always include the best phone, then fill the remaining slots in order
    // (skipping best since we already added it).
    visiblePhones = [];
    if (bestIdxAll >= 0) visiblePhones.push(phones[bestIdxAll]);
    for (let i = 0; i < phones.length && visiblePhones.length < PHONE_CAP; i++) {
      if (i === bestIdxAll) continue;
      visiblePhones.push(phones[i]);
    }
  }
  const bestVisibleIdx = bestIdxAll >= 0
    ? visiblePhones.findIndex(p => p === phones[bestIdxAll])
    : -1;
  const moreCount = Math.max(0, phones.length - visiblePhones.length);
  const moreLink = moreCount > 0 && contact.id
    ? `<a class="ocu-phones-more-link" href="/oculah/owners/${escHTML(String(contact.id))}">View all ${phones.length} phones →</a>`
    : '';
  const phonesHTML = visiblePhones.length
    ? visiblePhones.map((p, i) => phoneRow(p, i === bestVisibleIdx)).join('')
    : `<div class="ocu-phones-empty">No phones on record.</div>`;

  // With the 4-phone cap the per-card phone area is bounded — drop the
  // overflow scroll cap (manyPhones gate). Keep the data-many attribute
  // off; CSS no longer needs to special-case tall owner cards.
  const manyPhones = false;

  const profileHref = contact.id ? `/oculah/owners/${escHTML(String(contact.id))}` : '';
  const profileLink = profileHref
    ? `<a class="ocu-owner-profile-link" href="${profileHref}" title="Open ${escHTML(contact.first_name || '')} ${escHTML(contact.last_name || '')}'s profile">View profile <span aria-hidden="true">→</span></a>`
    : '';

  // 2026-05-01 redesign per user spec: 4-column horizontal layout with
  // FIXED column widths so cards line up vertically across N owners.
  //   Col 1 (200px): owner number + PRIMARY + name + View profile
  //   Col 2 (220px): mailing label + address (or "—")
  //   Col 3 (1fr) : phones label + count + phone list
  //   Col 4 (auto): "+ Add phone" button pinned right
  // align-items:start so all four columns top-align even when mailing
  // wraps or phone list is long. Caller passes label dynamically (Owner 1,
  // Owner 2, Owner N+1) so any number of owners renders correctly.
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

        <div class="ocu-owner-col-phones" data-contact-id="${escHTML(String(contact.id || ''))}"${manyPhones ? ' data-many="true"' : ''}>
          <div class="ocu-owner-section-label">
            <span class="ocu-owner-section-icon">${_ICON_PHN}</span>Phones
            <span class="ocu-owner-count-chip">${phones.length}</span>
          </div>
          <div class="ocu-phones-grid">${phonesHTML}</div>
          ${moreLink}
        </div>

        <div class="ocu-owner-col-actions">
          ${contact.id ? `<button type="button" class="ocu-owner-add-phone-btn" data-action="add-phone" data-contact-id="${escHTML(String(contact.id))}" title="Add a new phone for this contact">+ Add phone</button>` : ''}
        </div>
      </div>
    </div>`;
}

module.exports = { ownerCard, STATUS_OPTIONS, TYPE_OPTIONS };
