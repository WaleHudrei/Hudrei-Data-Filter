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
    ? `<span class="ocu-pill ocu-pill-primary" title="Best phone to call — verified and most likely to reach the owner" style="background:#FEF3C7;color:#92400E">★ Best</span>`
    : '';
  return `
    <div class="ocu-phone-row" data-phone-id="${ph.id}"${isBest ? ' style="background:#FEFCE8;border-radius:6px;padding:6px 8px"' : ''}>
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

  const mailing = [contact.mailing_address, contact.mailing_city, contact.mailing_state]
    .filter(Boolean).map(escHTML).join(', ');
  const mailingZip = contact.mailing_zip ? ` ${escHTML(contact.mailing_zip)}` : '';

  return `
    <div class="ocu-card ocu-owner-card">
      <div class="ocu-owner-card-header">
        <div>
          <div class="ocu-owner-label">${escHTML(label)}</div>
          <div class="ocu-owner-name">${fullName}</div>
        </div>
        ${isPrimary ? '<span class="ocu-pill" style="background:#0891B215;color:#0891B2">Primary</span>' : ''}
      </div>
      ${mailing ? `
        <div class="ocu-owner-mailing">
          <span class="ocu-fact-label">Mailing</span>
          <div>${mailing}${mailingZip}</div>
        </div>` : ''}
      <div class="ocu-phones-block">
        <div class="ocu-fact-label">Phones (${phones.length})</div>
        ${phones.length
          ? (() => {
              let bestIdx = -1, bestScore = 0;
              for (let i = 0; i < phones.length; i++) {
                const s = scorePhone(phones[i]);
                if (s > bestScore) { bestScore = s; bestIdx = i; }
              }
              return phones.map((p, i) => phoneRow(p, i === bestIdx)).join('');
            })()
          : `<div style="color:var(--ocu-text-3);font-size:13px;padding:8px 0">No phones on record.</div>`}
      </div>
    </div>`;
}

module.exports = { ownerCard, STATUS_OPTIONS, TYPE_OPTIONS };
