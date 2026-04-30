const express = require('express');
const router = express.Router();
const { query } = require('../db');
const settings = require('../settings');

function requireAuth(req, res, next) {
  if (!req.session || !req.session.authenticated) return res.redirect('/login');
  if (!req.session.tenantId) return res.redirect('/login');
  req.tenantId = req.session.tenantId;
  req.userId = req.session.userId;
  req.role = req.session.role;
  next();
}

const { shell } = require('../shared-shell');

function fmtDate(val) {
  if (!val) return '—';
  return new Date(val).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
}

// ═══════════════════════════════════════════════════════════════════════════════
// LISTS PAGE — GET /lists
// ═══════════════════════════════════════════════════════════════════════════════
// Milestone A: legacy /lists redirects to Ocular's lists page. POST /edit
// and POST /delete below stay — both old and new modal forms call them.
router.get('/', requireAuth, (req, res) => {
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  res.redirect('/oculah/lists' + qs);
});


// ═══════════════════════════════════════════════════════════════════════════════
// EDIT — POST /lists/edit
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/edit', requireAuth, async (req, res) => {
  try {
    const { id, list_name, list_type, source } = req.body;
    await query(`UPDATE lists SET list_name=$1, list_type=COALESCE(NULLIF($2,''),list_type), source=COALESCE(NULLIF($3,''),source) WHERE id=$4 AND tenant_id=$5`,
      [list_name, list_type, source, id, req.tenantId]);
    res.redirect('/lists?msg=saved');
  } catch(e) {
    console.error(e);
    res.redirect('/lists?msg=error');
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// DELETE — POST /lists/delete
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/delete', requireAuth, async (req, res) => {
  try {
    const { id, code } = req.body;
    // 2026-04-18 audit fix #41: lists delete was ungated. The records delete,
    // bulk merges ≥10 groups, and single property delete all require the
    // delete code (see settings.verifyDeleteCode). Deleting a list wipes
    // every property→list membership row for that list, a similarly
    // destructive operation. Now gated the same way for consistency.
    const verified = await settings.verifyDeleteCode(req.tenantId, code);
    if (!verified) {
      return res.redirect('/lists?msg=error&err=' + encodeURIComponent('Invalid delete code.'));
    }
    // Verify the list belongs to this tenant before any DELETE.
    const own = await query(`SELECT 1 FROM lists WHERE id=$1 AND tenant_id=$2`, [id, req.tenantId]);
    if (!own.rowCount) return res.redirect('/lists?msg=error&err=' + encodeURIComponent('List not found.'));
    await query(`DELETE FROM property_lists WHERE list_id=$1 AND tenant_id=$2`, [id, req.tenantId]);
    await query(`DELETE FROM lists WHERE id=$1 AND tenant_id=$2`, [id, req.tenantId]);
    res.redirect('/lists?msg=deleted');
  } catch(e) {
    console.error(e);
    res.redirect('/lists?msg=error');
  }
});

module.exports = router;
