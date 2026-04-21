// ═══════════════════════════════════════════════════════════════════════════════
// 2026-04-21 Feature 5 — Owners Dashboard
//
// /owners/:id  → full owner detail page with KPIs, tabs (Properties / Message
//                Board / Activity Log), and phone/email sidebar.
//
// An "owner" in Loki is a contact row. One contact can be linked to many
// properties via property_contacts. This dashboard aggregates across all of
// that contact's properties to produce per-owner KPIs and activity.
//
// New tables (lazy-created here, not in db.js init — keeps the init file
// focused on core schema and avoids a mandatory migration for installs that
// never visit /owners/:id):
//   - owner_messages   — message board posts (free-text notes with author/time)
//   - owner_activities — audit log of owner-related events (pipeline changes,
//                        phone edits, calls logged, etc. — populated here as
//                        a read-only log; other routes can insert as needed)
// ═══════════════════════════════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { shell } = require('../shared-shell');

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.redirect('/login');
}

// Ensure the two Feature 5 tables exist. Idempotent (IF NOT EXISTS), runs
// once per process lifetime via the _ensured flag so we don't pay the
// round-trip on every request.
let _ensured = false;
async function ensureFeature5Schema() {
  if (_ensured) return;
  await query(`
    CREATE TABLE IF NOT EXISTS owner_messages (
      id SERIAL PRIMARY KEY,
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      author VARCHAR(100) NOT NULL DEFAULT 'Unknown',
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_owner_messages_contact ON owner_messages(contact_id, created_at DESC)`);
  await query(`
    CREATE TABLE IF NOT EXISTS owner_activities (
      id SERIAL PRIMARY KEY,
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      property_id INTEGER REFERENCES properties(id) ON DELETE SET NULL,
      kind VARCHAR(50) NOT NULL,
      summary TEXT NOT NULL,
      author VARCHAR(100),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_owner_activities_contact ON owner_activities(contact_id, created_at DESC)`);
  _ensured = true;
}

// Helper — escape HTML (mirrors records-routes pattern). Never trust DB text.
const escHTML = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, ch => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
));
const fmtMoney = (v) => v == null ? '—' : '$' + Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 });
const fmtDate  = (v) => !v ? '—' : new Date(v).toLocaleDateString('en-US', { year:'numeric', month:'short', day:'numeric' });
const fmtDateTime = (v) => !v ? '—' : new Date(v).toLocaleString('en-US', { year:'numeric', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });

// ═══════════════════════════════════════════════════════════════════════════════
// GET /owners/:id — dashboard page
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/:id(\\d+)', requireAuth, async (req, res) => {
  try {
    await ensureFeature5Schema();
    const contactId = parseInt(req.params.id, 10);
    if (!contactId || isNaN(contactId)) return res.status(400).send('Invalid owner id');

    // Fetch the contact core row.
    const contactRes = await query(
      `SELECT id, first_name, last_name, email, mailing_address, mailing_city,
              mailing_state, mailing_zip, owner_type, created_at
         FROM contacts WHERE id = $1`,
      [contactId]
    );
    if (!contactRes.rowCount) return res.status(404).send('Owner not found');
    const c = contactRes.rows[0];
    const ownerName = [c.first_name, c.last_name].filter(Boolean).join(' ') || '(no name)';

    // Flash message + error from redirects (e.g. after post-message submit)
    const msg = req.query.msg ? String(req.query.msg).slice(0, 500) : '';
    const err = req.query.err ? String(req.query.err).slice(0, 500) : '';

    // ─── Properties linked to this owner ──────────────────────────────────
    // Uses property_contacts as the junction. A contact can be non-primary on
    // some properties (co-owner) — include those too, so users see all props
    // this person is associated with. Ordered newest-first by created_at.
    const propsRes = await query(
      `SELECT p.id, p.street, p.city, p.state_code, p.zip_code,
              p.property_type, p.pipeline_stage, p.estimated_value, p.assessed_value,
              p.last_sale_date, p.last_sale_price, p.created_at,
              pc.primary_contact, pc.role
         FROM property_contacts pc
         JOIN properties p ON p.id = pc.property_id
        WHERE pc.contact_id = $1
        ORDER BY pc.primary_contact DESC, p.created_at DESC`,
      [contactId]
    );
    const props = propsRes.rows;
    const propIds = props.map(p => p.id);

    // ─── Phones for this contact (with Mobile/Landline badges) ────────────
    const phonesRes = await query(
      `SELECT id, phone_number, phone_index, phone_type, phone_status,
              wrong_number, do_not_call, created_at
         FROM phones WHERE contact_id = $1
        ORDER BY phone_index ASC, id ASC`,
      [contactId]
    );
    const phones = phonesRes.rows;

    // ─── KPIs ─────────────────────────────────────────────────────────────
    // Computed in a single query for speed. Each subquery scopes to this
    // owner's property set or phone set. All "count" metrics are null-safe.
    const kpiRes = await query(
      `SELECT
         $1::int AS property_count,
         (SELECT COUNT(*)::int FROM properties WHERE id = ANY($2::int[]) AND pipeline_stage='closed') AS sold_count,
         (SELECT COUNT(*)::int FROM properties WHERE id = ANY($2::int[]) AND pipeline_stage='lead')   AS lead_count,
         (SELECT COUNT(*)::int FROM properties WHERE id = ANY($2::int[]) AND pipeline_stage='contract') AS contract_count,
         (SELECT COUNT(*)::int FROM call_logs WHERE property_id = ANY($2::int[])) AS call_count,
         (SELECT COUNT(*)::int FROM phones WHERE contact_id = $3) AS phone_total,
         (SELECT COUNT(*)::int FROM phones WHERE contact_id = $3 AND LOWER(phone_status) = 'correct') AS phone_correct,
         (SELECT COALESCE(SUM(COALESCE(assessed_value, estimated_value, 0)), 0)::numeric FROM properties WHERE id = ANY($2::int[])) AS total_investment
      `,
      [props.length, propIds.length ? propIds : [0], contactId]
    );
    const k = kpiRes.rows[0];
    const pctVerified = k.phone_total > 0 ? Math.round((k.phone_correct * 100) / k.phone_total) : 0;

    // ─── Message board posts ──────────────────────────────────────────────
    const msgsRes = await query(
      `SELECT id, author, body, created_at FROM owner_messages
        WHERE contact_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [contactId]
    );
    const messages = msgsRes.rows;

    // ─── Activity log ─────────────────────────────────────────────────────
    // Two sources: explicit entries in owner_activities (future), and
    // derived from call_logs against this owner's phones. Union + order.
    const actRes = await query(
      `(
         SELECT 'manual' AS src, id, kind, summary, author, created_at, property_id
           FROM owner_activities WHERE contact_id = $1
       )
       UNION ALL
       (
         SELECT 'call' AS src, cl.id, 'call' AS kind,
                COALESCE(cl.disposition, 'call') || COALESCE(' — ' || NULLIF(cl.campaign_name, ''), '') AS summary,
                COALESCE(cl.agent_name, 'Unknown') AS author,
                COALESCE(cl.call_date::timestamptz, cl.created_at) AS created_at,
                cl.property_id
           FROM call_logs cl
           JOIN phones ph ON ph.id = cl.phone_id
          WHERE ph.contact_id = $1
       )
       ORDER BY created_at DESC
       LIMIT 200`,
      [contactId]
    );
    const activities = actRes.rows;

    // ─── Render ───────────────────────────────────────────────────────────
    const msgSafe = escHTML(msg);
    const errSafe = escHTML(err);

    const pipelineColor = (stage) => {
      const map = { prospect:'#6b7280', lead:'#1a7a4a', contract:'#c07a1a', closed:'#1a4a9a' };
      return map[stage] || '#6b7280';
    };

    const phoneRow = (ph) => {
      const typeBadge = ph.phone_type && ph.phone_type !== 'unknown'
        ? `<span style="font-size:10px;background:${ph.phone_type==='mobile'?'#e8f0fc':ph.phone_type==='landline'?'#f5f0e8':'#f0e8f5'};color:${ph.phone_type==='mobile'?'#2a4a8a':ph.phone_type==='landline'?'#8a5a2a':'#5a2a8a'};border-radius:4px;padding:2px 6px;font-weight:600;text-transform:uppercase;letter-spacing:.04em">${escHTML(ph.phone_type)}</span>`
        : '';
      const statusBadge = ph.phone_status === 'correct'
        ? `<span style="font-size:10px;background:#e8f5ee;color:#1a7a4a;border-radius:4px;padding:2px 6px;font-weight:600">✓ Verified</span>`
        : (ph.phone_status === 'wrong' || ph.wrong_number)
          ? `<span style="font-size:10px;background:#fdeaea;color:#8b1f1f;border-radius:4px;padding:2px 6px;font-weight:600">✗ Wrong</span>`
          : '';
      const dncBadge = ph.do_not_call
        ? `<span style="font-size:10px;background:#fef3c7;color:#92400e;border-radius:4px;padding:2px 6px;font-weight:600">DNC</span>`
        : '';
      return `<div style="padding:10px 0;border-bottom:1px solid #f0efe9">
          <div style="font-family:ui-monospace,monospace;font-size:13px;color:#1a1a1a;margin-bottom:4px">${escHTML(ph.phone_number)}</div>
          <div style="display:flex;gap:4px;flex-wrap:wrap">${typeBadge}${statusBadge}${dncBadge}</div>
        </div>`;
    };

    const propRow = (p) => {
      const address = [p.street, p.city].filter(Boolean).join(', ') + (p.state_code ? ', ' + p.state_code : '') + (p.zip_code ? ' ' + p.zip_code : '');
      const stage = p.pipeline_stage || 'prospect';
      const value = p.estimated_value || p.assessed_value;
      return `<tr style="border-bottom:1px solid #f0efe9">
          <td style="padding:10px 12px;font-size:13px">
            <a href="/records/${p.id}" style="color:#1a4a9a;text-decoration:none;font-weight:500">${escHTML(address)}</a>
            ${p.primary_contact ? '<span style="margin-left:6px;font-size:10px;background:#e8f0fc;color:#2a4a8a;border-radius:4px;padding:2px 6px;font-weight:600">PRIMARY</span>' : ''}
          </td>
          <td style="padding:10px 12px;font-size:12px;color:#666">${escHTML(p.property_type || '—')}</td>
          <td style="padding:10px 12px"><span style="font-size:11px;background:${pipelineColor(stage)}15;color:${pipelineColor(stage)};border-radius:4px;padding:3px 8px;font-weight:600;text-transform:capitalize">${escHTML(stage)}</span></td>
          <td style="padding:10px 12px;font-size:13px;text-align:right;font-family:ui-monospace,monospace">${fmtMoney(value)}</td>
          <td style="padding:10px 12px;font-size:12px;color:#888">${fmtDate(p.last_sale_date)}</td>
        </tr>`;
    };

    const messageRow = (m) => `
      <div style="padding:12px 14px;border:1px solid #f0efe9;border-radius:8px;margin-bottom:10px;background:#fafaf8">
        <div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:12px">
          <span style="color:#1a1a1a;font-weight:600">${escHTML(m.author)}</span>
          <span style="color:#888">${fmtDateTime(m.created_at)}</span>
        </div>
        <div style="font-size:13px;color:#333;line-height:1.5;white-space:pre-wrap">${escHTML(m.body)}</div>
      </div>`;

    const activityRow = (a) => {
      const kindBadge = {
        call: '<span style="font-size:11px;background:#e8f0fc;color:#2a4a8a;border-radius:4px;padding:2px 7px;font-weight:600;text-transform:uppercase">Call</span>',
        pipeline: '<span style="font-size:11px;background:#f5f0e8;color:#8a5a2a;border-radius:4px;padding:2px 7px;font-weight:600;text-transform:uppercase">Pipeline</span>',
        edit: '<span style="font-size:11px;background:#f0e8f5;color:#5a2a8a;border-radius:4px;padding:2px 7px;font-weight:600;text-transform:uppercase">Edit</span>',
        manual: '<span style="font-size:11px;background:#f0efe9;color:#555;border-radius:4px;padding:2px 7px;font-weight:600;text-transform:uppercase">Note</span>',
      }[a.kind] || '<span style="font-size:11px;background:#f0efe9;color:#555;border-radius:4px;padding:2px 7px;font-weight:600;text-transform:uppercase">'+escHTML(a.kind)+'</span>';
      return `<div style="display:flex;gap:12px;padding:10px 0;border-bottom:1px solid #f0efe9;align-items:flex-start">
          <div style="flex-shrink:0;width:80px;font-size:11px;color:#888;padding-top:2px">${fmtDateTime(a.created_at)}</div>
          <div style="flex-shrink:0">${kindBadge}</div>
          <div style="flex:1;font-size:13px;color:#333;line-height:1.4">${escHTML(a.summary)}${a.author ? `<div style="font-size:11px;color:#888;margin-top:2px">by ${escHTML(a.author)}</div>` : ''}</div>
        </div>`;
    };

    const kpiCard = (label, value, sub = '') => `
      <div style="background:#fff;border:1px solid #f0efe9;border-radius:10px;padding:14px 16px">
        <div style="font-size:10px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px">${label}</div>
        <div style="font-size:24px;font-weight:500;color:#1a1a1a">${value}</div>
        ${sub ? `<div style="font-size:11px;color:#888;margin-top:2px">${sub}</div>` : ''}
      </div>`;

    res.send(shell('Owner: ' + ownerName, `
      <style>
        .owner-tabs { display:flex; gap:0; border-bottom:1px solid #f0efe9; margin-bottom:16px }
        .owner-tab { padding:10px 18px; font-size:13px; font-weight:500; color:#888; cursor:pointer; border:none; background:none; border-bottom:2px solid transparent; font-family:inherit }
        .owner-tab:hover { color:#1a1a1a }
        .owner-tab.active { color:#1a1a1a; border-bottom-color:#1a1a1a; font-weight:600 }
        .owner-pane { display:none }
        .owner-pane.active { display:block }
      </style>
      <div style="max-width:1200px">
        <div style="margin-bottom:1rem"><a href="/records" style="font-size:13px;color:#888;text-decoration:none">← Records</a></div>
        <div style="margin-bottom:1.5rem">
          <h2 style="font-size:24px;font-weight:500;margin:0 0 4px 0;color:#1a1a1a">${escHTML(ownerName)}</h2>
          <div style="font-size:13px;color:#888">
            ${c.owner_type ? `<span style="font-size:11px;background:#f0efe9;color:#555;border-radius:4px;padding:2px 7px;font-weight:600;margin-right:8px;text-transform:uppercase">${escHTML(c.owner_type)}</span>` : ''}
            ${c.mailing_city ? `${escHTML(c.mailing_city)}, ${escHTML(c.mailing_state || '')} ${escHTML(c.mailing_zip || '')}` : 'No mailing address on file'}
          </div>
        </div>

        ${msgSafe ? `<div style="background:#eaf6ea;border:1px solid #9bd09b;border-radius:8px;padding:10px 14px;color:#1a5f1a;font-size:13px;margin-bottom:12px">✅ ${msgSafe}</div>` : ''}
        ${errSafe ? `<div style="background:#fdeaea;border:1px solid #f5c5c5;border-radius:8px;padding:10px 14px;color:#8b1f1f;font-size:13px;margin-bottom:12px">❌ ${errSafe}</div>` : ''}

        <!-- KPI STRIP -->
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:24px">
          ${kpiCard('Properties', props.length.toLocaleString())}
          ${kpiCard('Sold', k.sold_count, k.sold_count > 0 ? 'Pipeline: closed' : '')}
          ${kpiCard('Leads', k.lead_count, k.lead_count > 0 ? 'Pipeline: lead' : '')}
          ${kpiCard('Contracts', k.contract_count, k.contract_count > 0 ? 'Pipeline: contract' : '')}
          ${kpiCard('Calls Logged', k.call_count.toLocaleString())}
          ${kpiCard('% Verified', pctVerified + '%', `${k.phone_correct} of ${k.phone_total} phones`)}
          ${kpiCard('Total Value', fmtMoney(k.total_investment), 'Assessed + estimated')}
        </div>

        <div style="display:grid;grid-template-columns:1fr 300px;gap:20px">
          <!-- MAIN COLUMN: TABS -->
          <div>
            <div class="owner-tabs">
              <button class="owner-tab active" data-pane="pane-props" onclick="ownerTab(this)">Properties <span style="color:#aaa;font-weight:400">(${props.length})</span></button>
              <button class="owner-tab" data-pane="pane-messages" onclick="ownerTab(this)">Message Board <span style="color:#aaa;font-weight:400">(${messages.length})</span></button>
              <button class="owner-tab" data-pane="pane-activity" onclick="ownerTab(this)">Activity Log <span style="color:#aaa;font-weight:400">(${activities.length})</span></button>
            </div>

            <!-- Properties pane -->
            <div id="pane-props" class="owner-pane active">
              ${props.length === 0
                ? '<div style="padding:40px;text-align:center;color:#888;font-size:13px;background:#fafaf8;border-radius:8px">No properties linked to this owner yet.</div>'
                : `<table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #f0efe9;border-radius:8px;overflow:hidden">
                    <thead style="background:#fafaf8">
                      <tr>
                        <th style="padding:10px 12px;text-align:left;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.08em">Address</th>
                        <th style="padding:10px 12px;text-align:left;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.08em">Type</th>
                        <th style="padding:10px 12px;text-align:left;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.08em">Stage</th>
                        <th style="padding:10px 12px;text-align:right;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.08em">Value</th>
                        <th style="padding:10px 12px;text-align:left;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.08em">Last Sale</th>
                      </tr>
                    </thead>
                    <tbody>${props.map(propRow).join('')}</tbody>
                  </table>`}
            </div>

            <!-- Message Board pane -->
            <div id="pane-messages" class="owner-pane">
              <form method="POST" action="/owners/${c.id}/message" style="background:#fff;border:1px solid #f0efe9;border-radius:8px;padding:14px;margin-bottom:16px">
                <div style="display:grid;grid-template-columns:1fr 2fr;gap:10px;margin-bottom:10px">
                  <input type="text" name="author" placeholder="Your name" maxlength="100" required style="padding:8px 10px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit" value="">
                  <div></div>
                </div>
                <textarea name="body" placeholder="Add a note about this owner…" maxlength="4000" required rows="3" style="width:100%;padding:9px 12px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit;resize:vertical;box-sizing:border-box"></textarea>
                <div style="display:flex;justify-content:flex-end;margin-top:10px">
                  <button type="submit" style="padding:8px 16px;background:#1a1a1a;color:#fff;border:none;border-radius:7px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">Post Note</button>
                </div>
              </form>
              ${messages.length === 0
                ? '<div style="padding:40px;text-align:center;color:#888;font-size:13px;background:#fafaf8;border-radius:8px">No notes yet. Be the first to leave one.</div>'
                : messages.map(messageRow).join('')}
            </div>

            <!-- Activity pane -->
            <div id="pane-activity" class="owner-pane">
              ${activities.length === 0
                ? '<div style="padding:40px;text-align:center;color:#888;font-size:13px;background:#fafaf8;border-radius:8px">No activity logged yet.</div>'
                : `<div style="background:#fff;border:1px solid #f0efe9;border-radius:8px;padding:6px 14px">${activities.map(activityRow).join('')}</div>`}
            </div>
          </div>

          <!-- SIDEBAR: PHONES + EMAILS -->
          <div>
            <div style="background:#fff;border:1px solid #f0efe9;border-radius:10px;padding:16px;margin-bottom:16px">
              <div style="font-size:10px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px">Phones <span style="color:#aaa;font-weight:400;text-transform:none;letter-spacing:0;margin-left:4px">(${phones.length})</span></div>
              ${phones.length === 0 ? '<div style="font-size:12px;color:#aaa;font-style:italic">No phones on file</div>' : phones.map(phoneRow).join('')}
            </div>
            <div style="background:#fff;border:1px solid #f0efe9;border-radius:10px;padding:16px">
              <div style="font-size:10px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px">Email</div>
              ${c.email
                ? `<a href="mailto:${escHTML(c.email)}" style="color:#1a4a9a;font-size:13px;text-decoration:none;word-break:break-all">${escHTML(c.email)}</a>`
                : '<div style="font-size:12px;color:#aaa;font-style:italic">No email on file</div>'}
            </div>
          </div>
        </div>
      </div>

      <script>
        function ownerTab(btn) {
          document.querySelectorAll('.owner-tab').forEach(function(t){ t.classList.remove('active'); });
          document.querySelectorAll('.owner-pane').forEach(function(p){ p.classList.remove('active'); });
          btn.classList.add('active');
          var paneId = btn.getAttribute('data-pane');
          var pane = document.getElementById(paneId);
          if (pane) pane.classList.add('active');
        }
      </script>
    `, 'records'));
  } catch (e) {
    console.error('[owners/:id GET]', e);
    res.status(500).send('Error: ' + (e.message || 'unknown'));
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /owners/:id/message — post a new message to the message board
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/:id(\\d+)/message', requireAuth, async (req, res) => {
  const contactId = parseInt(req.params.id, 10);
  if (!contactId || isNaN(contactId)) return res.status(400).send('Invalid owner id');
  try {
    await ensureFeature5Schema();
    const author = String(req.body.author || '').trim().slice(0, 100);
    const body   = String(req.body.body   || '').trim().slice(0, 4000);
    if (!author) return res.redirect(`/owners/${contactId}?err=${encodeURIComponent('Your name is required')}`);
    if (!body)   return res.redirect(`/owners/${contactId}?err=${encodeURIComponent('Message body is required')}`);

    // Verify contact exists — gives a clearer error than a FK violation later.
    const c = await query(`SELECT id FROM contacts WHERE id = $1`, [contactId]);
    if (!c.rowCount) return res.status(404).send('Owner not found');

    await query(
      `INSERT INTO owner_messages (contact_id, author, body) VALUES ($1, $2, $3)`,
      [contactId, author, body]
    );
    res.redirect(`/owners/${contactId}?msg=${encodeURIComponent('Note posted')}#pane-messages`);
  } catch (e) {
    console.error('[owners/:id/message POST]', e);
    res.redirect(`/owners/${contactId}?err=${encodeURIComponent('Post failed: ' + (e.message || 'unknown'))}`);
  }
});

module.exports = router;
