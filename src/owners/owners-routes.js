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
  if (!req.session || !req.session.authenticated) return res.redirect('/login');
  if (!req.session.tenantId) return res.redirect('/login');
  req.tenantId = req.session.tenantId;
  req.userId = req.session.userId;
  req.role = req.session.role;
  next();
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
      tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
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
      tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
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
// GET /owners/:id — Milestone A redirect to Ocular's owner detail.
// POST /:id/message stays below — Ocular's detail page can also use it
// (though Ocular has its own /ocular/owners/:id/message which is preferred).
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/:id(\\d+)', requireAuth, (req, res) => res.redirect('/ocular/owners/' + req.params.id));


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

    // Verify contact exists AND belongs to this tenant.
    const c = await query(`SELECT id FROM contacts WHERE id = $1 AND tenant_id = $2`, [contactId, req.tenantId]);
    if (!c.rowCount) return res.status(404).send('Owner not found');

    await query(
      `INSERT INTO owner_messages (tenant_id, contact_id, author, body) VALUES ($1, $2, $3, $4)`,
      [req.tenantId, contactId, author, body]
    );
    res.redirect(`/owners/${contactId}?msg=${encodeURIComponent('Note posted')}#pane-messages`);
  } catch (e) {
    console.error('[owners/:id/message POST]', e);
    res.redirect(`/owners/${contactId}?err=${encodeURIComponent('Post failed: ' + (e.message || 'unknown'))}`);
  }
});

module.exports = router;
