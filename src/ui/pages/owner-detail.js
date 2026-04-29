// ═══════════════════════════════════════════════════════════════════════════
// ui/pages/owner-detail.js
// Ocular's Owner Dashboard (Feature 5 in Loki). One page per contact.
//
// Three tabs:
//   - Properties — every property this contact is linked to (primary + co-owner)
//   - Message Board — free-text notes posted via the form
//   - Activity Log — manual entries from owner_activities + derived call_log
//                    rows joined through phones.contact_id
//
// Right sidebar shows phones (with type/status badges) + email.
// Message form posts to /ocular/owners/:id/message.
// ═══════════════════════════════════════════════════════════════════════════
const { shell }   = require('../layouts/shell');
const { card }    = require('../components/card');
const { kpiCard } = require('../components/kpi-card');
const { escHTML, fmtNum, fmtRelative } = require('../_helpers');

function fmtMoney(v) {
  if (v == null) return '—';
  return '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function fmtDate(v) {
  if (!v) return '—';
  return new Date(v).toLocaleDateString('en-US', { year:'numeric', month:'short', day:'numeric' });
}

function fmtDateTime(v) {
  if (!v) return '—';
  return new Date(v).toLocaleString('en-US', {
    year:'numeric', month:'short', day:'numeric', hour:'numeric', minute:'2-digit',
  });
}

function pipelineColor(stage) {
  const map = {
    prospect:'#6b7280', lead:'#1a7a4a', contract:'#c07a1a', closed:'#1a4a9a',
  };
  return map[stage] || '#6b7280';
}

// ─── small reusable bits ────────────────────────────────────────────────────

function phoneRow(ph) {
  const type = (ph.phone_type || '').toLowerCase();
  const status = (ph.phone_status || '').toLowerCase();
  const typeBadge = type && type !== 'unknown'
    ? `<span class="ocu-pill" data-type="${escHTML(type)}">${escHTML(ph.phone_type)}</span>`
    : '';
  const statusBadge = status === 'correct'
    ? `<span class="ocu-pill ocu-pill-good">✓ Verified</span>`
    : (status === 'wrong' || ph.wrong_number)
      ? `<span class="ocu-pill ocu-pill-bad">✗ Wrong</span>`
      : '';
  const dncBadge = ph.do_not_call
    ? `<span class="ocu-pill ocu-pill-warn">DNC</span>`
    : '';
  return `<div class="ocu-owner-phone-row">
      <div class="ocu-owner-phone-num">${escHTML(ph.phone_number)}</div>
      <div class="ocu-owner-phone-badges">${typeBadge}${statusBadge}${dncBadge}</div>
    </div>`;
}

function propRow(p) {
  const address = [p.street, p.city].filter(Boolean).join(', ')
    + (p.state_code ? ', ' + p.state_code : '')
    + (p.zip_code ? ' ' + p.zip_code : '');
  const stage = p.pipeline_stage || 'prospect';
  const color = pipelineColor(stage);
  const value = p.estimated_value || p.assessed_value;
  // 2026-04-29 Tier-3 follow-up: data cells now use .ocu-td so they line
  // up with the .ocu-th headers (same root cause as owners-list and
  // activity-list — raw <td> defaults to text-align:start while raw <th>
  // defaults to center).
  return `<tr>
      <td class="ocu-td">
        <a href="/ocular/records/${p.id}" class="ocu-link">${escHTML(address)}</a>
        ${p.primary_contact ? '<span class="ocu-pill ocu-pill-primary" style="margin-left:6px">PRIMARY</span>' : ''}
      </td>
      <td class="ocu-td ocu-td-text">${escHTML(p.property_type || '—')}</td>
      <td class="ocu-td"><span class="ocu-pill" style="background:${color}15;color:${color}">${escHTML(stage)}</span></td>
      <td class="ocu-td ocu-td-num"><span class="ocu-mono">${fmtMoney(value)}</span></td>
      <td class="ocu-td ocu-td-date">${fmtDate(p.last_sale_date)}</td>
    </tr>`;
}

function messageRow(m) {
  return `
    <div class="ocu-owner-message">
      <div class="ocu-owner-message-head">
        <span class="ocu-owner-message-author">${escHTML(m.author)}</span>
        <span class="ocu-text-3 ocu-mono" style="font-size:11px">${fmtDateTime(m.created_at)}</span>
      </div>
      <div class="ocu-owner-message-body">${escHTML(m.body)}</div>
    </div>`;
}

function activityRow(a) {
  const kind = (a.kind || '').toLowerCase();
  const kindLabel = {
    call: 'Call', pipeline: 'Pipeline', edit: 'Edit', manual: 'Note',
  }[kind] || (a.kind || 'Event');
  return `
    <div class="ocu-owner-activity-row">
      <div class="ocu-owner-activity-time ocu-mono">${fmtRelative(a.created_at)}</div>
      <span class="ocu-pill" data-kind="${escHTML(kind)}">${escHTML(kindLabel)}</span>
      <div class="ocu-owner-activity-body">
        <div>${escHTML(a.summary)}</div>
        ${a.author ? `<div class="ocu-text-3" style="font-size:11px;margin-top:2px">by ${escHTML(a.author)}</div>` : ''}
      </div>
    </div>`;
}

// ─── main page renderer ────────────────────────────────────────────────────

/**
 * @param {Object} data
 *   - user, badges
 *   - contact: contacts row
 *   - properties: array of property rows joined via property_contacts
 *   - phones: array of phones rows
 *   - messages: owner_messages rows newest-first
 *   - activities: union of owner_activities + derived call_logs newest-first
 *   - kpis: { sold, lead, contract, calls, phoneTotal, phoneCorrect, totalValue }
 *   - flash: { msg?, err? }
 */
function ownerDetail(data = {}) {
  const c = data.contact || {};
  const ownerName = [c.first_name, c.last_name].filter(Boolean).join(' ') || '(no name)';
  const props = Array.isArray(data.properties) ? data.properties : [];
  const phones = Array.isArray(data.phones) ? data.phones : [];
  const messages = Array.isArray(data.messages) ? data.messages : [];
  const activities = Array.isArray(data.activities) ? data.activities : [];
  const k = data.kpis || {};
  const flash = data.flash || {};

  const pctVerified = k.phoneTotal > 0
    ? Math.round((k.phoneCorrect * 100) / k.phoneTotal)
    : 0;

  const flashHTML = flash.msg
    ? `<div class="ocu-card" style="margin-bottom:14px;background:#e8f5ee;border-color:#9bd0a8;color:#1a5f1a;padding:12px 16px;font-size:13px">${escHTML(flash.msg)}</div>`
    : flash.err
    ? `<div class="ocu-card" style="margin-bottom:14px;background:#fdeaea;border-color:#f5c5c5;color:#8b1f1f;padding:12px 16px;font-size:13px">${escHTML(flash.err)}</div>`
    : '';

  const subtitleBits = [];
  if (c.owner_type) subtitleBits.push(`<span class="ocu-pill">${escHTML(c.owner_type)}</span>`);
  if (c.mailing_city) {
    subtitleBits.push(`${escHTML(c.mailing_city)}, ${escHTML(c.mailing_state || '')} ${escHTML(c.mailing_zip || '')}`);
  } else {
    subtitleBits.push(`<span class="ocu-text-3">No mailing address on file</span>`);
  }

  // ─── KPI strip ────────────────────────────────────────────────────────
  const kpiStrip = `
    <div class="ocu-kpi-row" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
      ${kpiCard({ label: 'Properties', value: props.length, featured: true })}
      ${kpiCard({ label: 'Sold', value: k.sold || 0 })}
      ${kpiCard({ label: 'Leads', value: k.lead || 0 })}
      ${kpiCard({ label: 'Contracts', value: k.contract || 0 })}
      ${kpiCard({ label: 'Calls logged', value: k.calls || 0 })}
      ${kpiCard({
        label: '% verified',
        value: pctVerified + '%',
        delta: { direction: 'neutral', label: `${k.phoneCorrect || 0} of ${k.phoneTotal || 0} phones` },
      })}
      ${kpiCard({
        label: 'Total value',
        value: fmtMoney(k.totalValue || 0),
        delta: { direction: 'neutral', label: 'assessed + estimated' },
      })}
    </div>`;

  // ─── Properties tab ───────────────────────────────────────────────────
  const propsTab = props.length === 0
    ? `<div class="ocu-empty">No properties linked to this owner yet.</div>`
    : `
      <div class="ocu-table-wrap">
        <table class="ocu-table">
          <thead>
            <tr>
              <th class="ocu-th">Address</th>
              <th class="ocu-th">Type</th>
              <th class="ocu-th">Stage</th>
              <th class="ocu-th ocu-th-num">Value</th>
              <th class="ocu-th ocu-th-date">Last sale</th>
            </tr>
          </thead>
          <tbody>${props.map(propRow).join('')}</tbody>
        </table>
      </div>`;

  // ─── Message board tab ────────────────────────────────────────────────
  const messagesTab = `
    <form method="POST" action="/ocular/owners/${c.id}/message" class="ocu-card" style="padding:14px;margin-bottom:14px">
      <div style="display:grid;grid-template-columns:200px 1fr;gap:10px;margin-bottom:10px">
        <input type="text" name="author" placeholder="Your name" maxlength="100" required class="ocu-input" />
        <div></div>
      </div>
      <textarea name="body" placeholder="Add a note about this owner…" maxlength="4000" required class="ocu-textarea" rows="3"></textarea>
      <div style="display:flex;justify-content:flex-end;margin-top:10px">
        <button type="submit" class="ocu-btn ocu-btn-primary">Post note</button>
      </div>
    </form>
    ${messages.length === 0
      ? `<div class="ocu-empty">No notes yet. Be the first to leave one.</div>`
      : messages.map(messageRow).join('')}`;

  // ─── Activity tab ─────────────────────────────────────────────────────
  const activityTab = activities.length === 0
    ? `<div class="ocu-empty">No activity logged yet.</div>`
    : `<div class="ocu-card" style="padding:6px 14px">${activities.map(activityRow).join('')}</div>`;

  // ─── Sidebar (phones + email) ─────────────────────────────────────────
  const phonesCard = card({
    title: 'Phones',
    meta:  phones.length ? `${phones.length} on file` : '',
    body:  phones.length === 0
      ? `<div class="ocu-text-3" style="font-size:12px;font-style:italic">No phones on file</div>`
      : phones.map(phoneRow).join(''),
  });

  const emailCard = card({
    title: 'Email',
    body:  c.email
      ? `<a href="mailto:${escHTML(c.email)}" class="ocu-link" style="word-break:break-all">${escHTML(c.email)}</a>`
      : `<div class="ocu-text-3" style="font-size:12px;font-style:italic">No email on file</div>`,
  });

  // 2026-04-29 user request: Edit button on owner detail. Native <dialog>
  // modal pre-populated with the contact's current values; submit posts
  // JSON to /owners/:id/edit and reloads.
  const ownerEditDialog = `
    <dialog id="ocu-edit-owner-dialog" class="ocu-dialog">
      <form id="ocu-edit-owner-form" data-contact-id="${c.id || ''}"
            onsubmit="return ocu_editOwner(event)" class="ocu-dialog-form">
        <div class="ocu-dialog-header">
          <div class="ocu-dialog-title">Edit owner</div>
          <button type="button" class="ocu-dialog-close"
                  onclick="document.getElementById('ocu-edit-owner-dialog').close()" aria-label="Close">×</button>
        </div>
        <div class="ocu-form-grid">
          <div class="ocu-form-field"><label class="ocu-form-label">First name</label>
            <input type="text" name="first_name" value="${escHTML(c.first_name || '')}" class="ocu-input" maxlength="100"></div>
          <div class="ocu-form-field"><label class="ocu-form-label">Last name</label>
            <input type="text" name="last_name" value="${escHTML(c.last_name || '')}" class="ocu-input" maxlength="100"></div>
          <div class="ocu-form-field"><label class="ocu-form-label">Owner type</label>
            <select name="owner_type" class="ocu-input">
              <option value="">— unchanged —</option>
              <option value="Person"  ${c.owner_type === 'Person'  ? 'selected' : ''}>Person</option>
              <option value="Company" ${c.owner_type === 'Company' ? 'selected' : ''}>Company</option>
              <option value="Trust"   ${c.owner_type === 'Trust'   ? 'selected' : ''}>Trust</option>
            </select>
          </div>
          <div class="ocu-form-field" style="grid-column:1 / -1"><label class="ocu-form-label">Mailing address</label>
            <input type="text" name="mailing_address" value="${escHTML(c.mailing_address || '')}" class="ocu-input" maxlength="255"></div>
          <div class="ocu-form-field"><label class="ocu-form-label">Mailing city</label>
            <input type="text" name="mailing_city" value="${escHTML(c.mailing_city || '')}" class="ocu-input" maxlength="100"></div>
          <div class="ocu-form-field"><label class="ocu-form-label">Mailing state</label>
            <input type="text" name="mailing_state" value="${escHTML(c.mailing_state || '')}" class="ocu-input" maxlength="10"></div>
          <div class="ocu-form-field"><label class="ocu-form-label">Mailing ZIP</label>
            <input type="text" name="mailing_zip" value="${escHTML(c.mailing_zip || '')}" class="ocu-input" maxlength="10"></div>
          <div class="ocu-form-field" style="grid-column:1 / -1"><label class="ocu-form-label">Email</label>
            <input type="email" name="email" value="${escHTML(c.email || '')}" class="ocu-input" maxlength="255"></div>
        </div>
        <div class="ocu-dialog-footer">
          <button type="button" class="ocu-btn ocu-btn-ghost"
                  onclick="document.getElementById('ocu-edit-owner-dialog').close()">Cancel</button>
          <button type="submit" class="ocu-btn ocu-btn-primary">Save changes</button>
        </div>
      </form>
    </dialog>`;

  // ─── Page body ────────────────────────────────────────────────────────
  const body = `
    ${ownerEditDialog}
    <div class="ocu-page-header" style="display:flex;align-items:flex-start;justify-content:space-between;gap:14px">
      <div style="flex:1;min-width:0">
        <div style="margin-bottom:6px"><a href="/ocular/owners" class="ocu-text-3" style="font-size:13px;text-decoration:none">← Owners</a></div>
        <h1 class="ocu-page-title">${escHTML(ownerName)}</h1>
        <div class="ocu-page-subtitle" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${subtitleBits.join(' ')}</div>
      </div>
      ${c.id ? `<button type="button" class="ocu-btn ocu-btn-secondary"
        onclick="document.getElementById('ocu-edit-owner-dialog').showModal()">Edit</button>` : ''}
    </div>

    ${flashHTML}
    ${kpiStrip}

    <div class="ocu-owner-detail-layout">
      <div>
        <div class="ocu-tabs" id="owner-tabs">
          <button class="ocu-tab active" data-pane="pane-props">Properties <span class="ocu-text-3">(${props.length})</span></button>
          <button class="ocu-tab" data-pane="pane-messages">Message board <span class="ocu-text-3">(${messages.length})</span></button>
          <button class="ocu-tab" data-pane="pane-activity">Activity log <span class="ocu-text-3">(${activities.length})</span></button>
        </div>
        <div id="pane-props" class="ocu-tab-pane active">${propsTab}</div>
        <div id="pane-messages" class="ocu-tab-pane">${messagesTab}</div>
        <div id="pane-activity" class="ocu-tab-pane">${activityTab}</div>
      </div>
      <aside class="ocu-owner-sidebar">
        ${phonesCard}
        <div style="margin-top:14px">${emailCard}</div>
      </aside>
    </div>

    <script>
      (function() {
        var tabs = document.querySelectorAll('#owner-tabs .ocu-tab');
        tabs.forEach(function(btn) {
          btn.addEventListener('click', function() {
            tabs.forEach(function(t) { t.classList.remove('active'); });
            document.querySelectorAll('.ocu-tab-pane').forEach(function(p) { p.classList.remove('active'); });
            btn.classList.add('active');
            var pane = document.getElementById(btn.getAttribute('data-pane'));
            if (pane) pane.classList.add('active');
          });
        });
      })();
    </script>`;

  return shell({
    title:      ownerName,
    activePage: 'owners',
    user:       data.user,
    badges:     data.badges || {},
    body,
    // 2026-04-29 load detail-actions.js so the ocu_editOwner submit
    // handler is available. Same pattern as the property detail page.
    extraHead:  '<script src="/ocular-static/detail-actions.js?v=5" defer></script>',
  });
}

module.exports = { ownerDetail };
