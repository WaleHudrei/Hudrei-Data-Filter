// ═══════════════════════════════════════════════════════════════════════════════
// lists/list-types-routes.js
// 2026-04-23 List Registry — "HUDREI Data Lab" equivalent inside Loki.
//
// Routes:
//   GET  /lists/types              → registry page (the grid)
//   POST /lists/types              → create a new template row
//   POST /lists/types/:id          → update a single field (inline edit)
//   POST /lists/types/:id/delete   → delete a row
//   POST /lists/types/:id/pull     → mark as pulled today (sets last_pull_date)
//   GET  /lists/types/overdue-count → JSON for dashboard widget
// ═══════════════════════════════════════════════════════════════════════════════

const express  = require('express');
const router   = express.Router();
const { query } = require('../db');
const { shell }  = require('../shared-shell');
const { normalizeState } = require('../import/state');

function requireAuth(req, res, next) {
  if (!req.session || !req.session.authenticated) return res.redirect('/login');
  if (!req.session.tenantId) return res.redirect('/login');
  req.tenantId = req.session.tenantId;
  req.userId = req.session.userId;
  req.role = req.session.role;
  next();
}

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const VALID_ACTIONS   = ['pull', 'paused', ''];
const VALID_TIERS     = ['s_tier', 'stack_only', 'tier_1', 'tier_2', ''];
const VALID_SOURCES   = ['Dealmachine', 'County', 'Propstream', 'Propwire', ''];
const VALID_FREQ      = [1, 7, 14, 30, 60, 90, 180, 365];

const TIER_LABELS = {
  s_tier: 'S.Tier', stack_only: 'Stack Only',
  tier_1: 'Tier 1', tier_2: 'Tier 2', '': '—',
};
const ACTION_LABELS = { pull: 'Pull', paused: 'Paused', '': '—' };
const FREQ_LABELS = {
  1: 'Daily', 7: 'Every 7 Days', 14: 'Every 14 Days',
  30: 'Every 30 Days', 60: 'Every 60 Days', 90: 'Every 90 Days',
  180: 'Every 6 Months', 365: 'Once a Year', null: '—',
};

function nextPullDate(lastPullDate, frequencyDays) {
  if (!lastPullDate || !frequencyDays) return null;
  const d = new Date(lastPullDate);
  d.setDate(d.getDate() + frequencyDays);
  return d;
}

function isOverdue(lastPullDate, frequencyDays) {
  const next = nextPullDate(lastPullDate, frequencyDays);
  if (!next) return false;
  return next < new Date();
}

function isDueSoon(lastPullDate, frequencyDays) {
  const next = nextPullDate(lastPullDate, frequencyDays);
  if (!next) return false;
  const soon = new Date();
  soon.setDate(soon.getDate() + 7);
  return next >= new Date() && next <= soon;
}

function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function safeInt(v) {
  if (v == null || v === '') return null;
  const n = parseInt(String(v).trim(), 10);
  return Number.isFinite(n) ? n : null;
}

// ── GET /lists/types ─────────────────────────────────────────────────────────
// Milestone A: legacy /lists/types redirects to Ocular's List Registry.
// POST handlers below stay — Ocular's grid still uses them.
router.get('/types', requireAuth, (req, res) => res.redirect('/oculah/lists/types'));


// ── POST /lists/types — create new row ───────────────────────────────────────
router.post('/types', requireAuth, async (req, res) => {
  try {
    const name = String(req.body.list_name || 'New List Type').slice(0, 100).trim();
    const r = await query(
      `INSERT INTO list_templates (tenant_id, list_name, action, sort_order) VALUES ($1, $2, '', 0) RETURNING id`,
      [req.tenantId, name]
    );
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) {
    console.error('[lists/types POST]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /lists/types/:id — update a single field ────────────────────────────
router.post('/types/:id(\\d+)', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { field, value } = req.body;

    // Whitelist of editable fields + their validators/coercers
    const ALLOWED = {
      action:         v => VALID_ACTIONS.includes(v) ? v : '',
      state_code:     v => { const s = String(v||'').toUpperCase().trim(); return s.length === 2 ? s : ''; },
      list_name:      v => String(v||'').trim().slice(0, 100) || 'Unnamed',
      list_tier:      v => VALID_TIERS.includes(v) ? v : '',
      source:         v => String(v||'').slice(0, 50),
      frequency_days: v => { const n = safeInt(v); return VALID_FREQ.includes(n) ? n : null; },
      require_bot:    v => v === 'true' ? true : v === 'false' ? false : null,
      last_pull_date: v => { if (!v || v === '') return null; const d = new Date(v); return isNaN(d) ? null : v; },
      sort_order:     v => { const n = safeInt(v); return n !== null ? n : 0; },
      // Per-row "remind me X days before next pull". 0–60 inclusive;
      // empty/invalid clears the reminder.
      remind_days_before: v => { const n = safeInt(v); return n != null && n >= 0 && n <= 60 ? n : null; },
    };

    if (!ALLOWED[field]) return res.status(400).json({ error: 'Invalid field: ' + field });
    const coerced = ALLOWED[field](value);

    await query(
      `UPDATE list_templates SET ${field} = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3`,
      [coerced, id, req.tenantId]
    );

    // Return the derived next_pull_date so the client can update the cell
    const updated = await query(`SELECT last_pull_date, frequency_days FROM list_templates WHERE id = $1 AND tenant_id = $2`, [id, req.tenantId]);
    const row = updated.rows[0];
    const next = row ? nextPullDate(row.last_pull_date, row.frequency_days) : null;
    const over = row ? isOverdue(row.last_pull_date, row.frequency_days) : false;
    const soon = row ? isDueSoon(row.last_pull_date, row.frequency_days) : false;

    res.json({
      ok: true,
      next_pull_date: next ? fmtDate(next) : '—',
      overdue: over,
      due_soon: soon,
    });
  } catch (e) {
    console.error('[lists/types/:id POST]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /lists/types/:id/delete ─────────────────────────────────────────────
router.post('/types/:id(\\d+)/delete', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await query(`DELETE FROM list_templates WHERE id = $1 AND tenant_id = $2`, [id, req.tenantId]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[lists/types/:id/delete]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /lists/types/:id/pull — mark pulled today ───────────────────────────
router.post('/types/:id(\\d+)/pull', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const today = new Date().toISOString().slice(0, 10);
    await query(`UPDATE list_templates SET last_pull_date = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3`, [today, id, req.tenantId]);
    const r = await query(`SELECT last_pull_date, frequency_days FROM list_templates WHERE id = $1 AND tenant_id = $2`, [id, req.tenantId]);
    const row = r.rows[0];
    const next = row ? nextPullDate(row.last_pull_date, row.frequency_days) : null;
    res.json({ ok: true, last_pull_date: today, next_pull_date: next ? fmtDate(next) : '—' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /lists/types/overdue-count — dashboard widget JSON ───────────────────
router.get('/types/overdue-count', requireAuth, async (req, res) => {
  try {
    const result = await query(`SELECT last_pull_date, frequency_days FROM list_templates WHERE tenant_id = $1 AND action = 'pull'`, [req.tenantId]);
    const rows = result.rows;
    const overdue  = rows.filter(r => isOverdue(r.last_pull_date, r.frequency_days)).length;
    const dueSoon  = rows.filter(r => isDueSoon(r.last_pull_date, r.frequency_days)).length;
    const total    = rows.length;
    res.json({ overdue, dueSoon, total });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
