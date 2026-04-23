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
  if (req.session && req.session.authenticated) return next();
  res.redirect('/login');
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
router.get('/types', requireAuth, async (req, res) => {
  try {
    const msg = req.query.msg ? String(req.query.msg).slice(0, 300) : '';
    const err = req.query.err ? String(req.query.err).slice(0, 300) : '';
    const msgSafe = esc(msg);
    const errSafe = esc(err);

    const result = await query(
      `SELECT * FROM list_templates ORDER BY sort_order ASC, state_code ASC, list_name ASC`
    );
    const rows = result.rows;

    // Summary counts for the top bar
    const overdue   = rows.filter(r => isOverdue(r.last_pull_date, r.frequency_days)).length;
    const dueSoon   = rows.filter(r => isDueSoon(r.last_pull_date, r.frequency_days)).length;
    const neverPulled = rows.filter(r => r.action === 'pull' && !r.last_pull_date).length;
    const total     = rows.length;

    const stateOptions = ['', 'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI',
      'ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO',
      'MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI',
      'SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'].map(s =>
        `<option value="${s}">${s || '—'}</option>`).join('');

    const tierOptions = Object.entries(TIER_LABELS).map(([v, l]) =>
      `<option value="${v}">${l}</option>`).join('');
    const actionOptions = Object.entries(ACTION_LABELS).map(([v, l]) =>
      `<option value="${v}">${l}</option>`).join('');
    const freqOptions = Object.entries(FREQ_LABELS).map(([v, l]) =>
      `<option value="${v === 'null' ? '' : v}">${l}</option>`).join('');
    const sourceOptions = [...VALID_SOURCES, 'Other'].map(s =>
      `<option value="${s}">${s || '—'}</option>`).join('');

    const rowHTML = rows.map(r => {
      const next  = nextPullDate(r.last_pull_date, r.frequency_days);
      const over  = isOverdue(r.last_pull_date, r.frequency_days);
      const soon  = isDueSoon(r.last_pull_date, r.frequency_days);
      const rowClass = over ? 'lt-row lt-overdue' : soon ? 'lt-row lt-soon' : 'lt-row';
      const nextStr  = next ? fmtDate(next) : '—';
      const nextStyle = over ? 'color:#c0392b;font-weight:600' : soon ? 'color:#c07a1a;font-weight:600' : 'color:#555';

      return `<tr class="${rowClass}" data-id="${r.id}">
        <td class="lt-drag" title="Drag to reorder">⠿</td>
        <td>
          <select class="lt-sel lt-action" data-field="action" onchange="ltSave(${r.id},'action',this.value)">
            ${Object.entries(ACTION_LABELS).map(([v,l]) => `<option value="${v}" ${r.action===v?'selected':''}>${l}</option>`).join('')}
          </select>
        </td>
        <td>
          <select class="lt-sel lt-state" data-field="state_code" onchange="ltSave(${r.id},'state_code',this.value)">
            ${['','AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'].map(s => `<option value="${s}" ${(r.state_code||'')===(s)?'selected':''}>${s||'—'}</option>`).join('')}
          </select>
        </td>
        <td>
          <input class="lt-input lt-name" type="text" value="${esc(r.list_name)}" data-field="list_name"
            onblur="ltSave(${r.id},'list_name',this.value)" onkeydown="if(event.key==='Enter')this.blur()">
        </td>
        <td>
          <select class="lt-sel lt-tier" data-field="list_tier" onchange="ltSave(${r.id},'list_tier',this.value)">
            ${Object.entries(TIER_LABELS).map(([v,l]) => `<option value="${v}" ${(r.list_tier||'')===v?'selected':''}>${l}</option>`).join('')}
          </select>
        </td>
        <td>
          <select class="lt-sel lt-source" data-field="source" onchange="ltSave(${r.id},'source',this.value)">
            ${[...VALID_SOURCES,'Other'].map(s => `<option value="${s}" ${(r.source||'')===s?'selected':''}>${s||'—'}</option>`).join('')}
          </select>
        </td>
        <td>
          <select class="lt-sel lt-freq" data-field="frequency_days" onchange="ltSave(${r.id},'frequency_days',this.value)">
            ${Object.entries(FREQ_LABELS).map(([v,l]) => `<option value="${v==='null'?'':v}" ${String(r.frequency_days||'')===String(v==='null'?'':v)?'selected':''}>${l}</option>`).join('')}
          </select>
        </td>
        <td>
          <select class="lt-sel lt-bot" data-field="require_bot" onchange="ltSave(${r.id},'require_bot',this.value)">
            <option value="" ${r.require_bot===null?'selected':''}>—</option>
            <option value="true"  ${r.require_bot===true?'selected':''}>TRUE</option>
            <option value="false" ${r.require_bot===false?'selected':''}>FALSE</option>
          </select>
        </td>
        <td class="lt-date-cell">
          <input class="lt-input lt-date" type="date" value="${r.last_pull_date ? new Date(r.last_pull_date).toISOString().slice(0,10) : ''}"
            data-field="last_pull_date" onblur="ltSave(${r.id},'last_pull_date',this.value)" onchange="ltSave(${r.id},'last_pull_date',this.value)">
        </td>
        <td class="lt-next-cell" style="${nextStyle}">${nextStr}</td>
        <td>
          <div style="display:flex;gap:6px;align-items:center">
            <button class="lt-pull-btn" onclick="ltMarkPulled(${r.id})" title="Mark pulled today" style="font-size:10px;padding:3px 8px;background:#1a7a4a;color:#fff;border:none;border-radius:4px;cursor:pointer;font-family:inherit;font-weight:600;white-space:nowrap">✓ Pulled</button>
            <button onclick="ltDelete(${r.id})" title="Delete row" style="font-size:11px;padding:3px 7px;background:#fff;color:#c0392b;border:1px solid #f5c5c5;border-radius:4px;cursor:pointer;font-family:inherit">×</button>
          </div>
        </td>
      </tr>`;
    }).join('');

    res.send(shell('List Registry', `
      <div style="max-width:1400px">
        <div style="margin-bottom:1.5rem;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px">
          <div>
            <h2 style="font-size:22px;font-weight:500;margin:0 0 4px 0">List Registry</h2>
            <p style="font-size:13px;color:#888;margin:0">Track every list type you pull — when it was last pulled and when it's due again.</p>
          </div>
          <button onclick="ltAddRow()" style="padding:9px 18px;background:#1a1a1a;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">+ Add List Type</button>
        </div>

        ${msgSafe ? `<div style="background:#eaf6ea;border:1px solid #9bd09b;border-radius:8px;padding:10px 14px;color:#1a5f1a;font-size:13px;margin-bottom:12px">✅ ${msgSafe}</div>` : ''}
        ${errSafe ? `<div style="background:#fdeaea;border:1px solid #f5c5c5;border-radius:8px;padding:10px 14px;color:#8b1f1f;font-size:13px;margin-bottom:12px">❌ ${errSafe}</div>` : ''}

        <!-- Summary bar -->
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:1.5rem">
          <div style="background:#fff;border:1px solid #f0efe9;border-radius:10px;padding:12px 14px">
            <div style="font-size:10px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px">Total Lists</div>
            <div style="font-size:24px;font-weight:500">${total}</div>
          </div>
          <div style="background:#fff;border:1px solid ${overdue>0?'#f5c5c5':'#f0efe9'};border-radius:10px;padding:12px 14px">
            <div style="font-size:10px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px">Overdue</div>
            <div style="font-size:24px;font-weight:500;color:${overdue>0?'#c0392b':'#1a1a1a'}">${overdue}</div>
          </div>
          <div style="background:#fff;border:1px solid ${dueSoon>0?'#ffe0a0':'#f0efe9'};border-radius:10px;padding:12px 14px">
            <div style="font-size:10px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px">Due This Week</div>
            <div style="font-size:24px;font-weight:500;color:${dueSoon>0?'#c07a1a':'#1a1a1a'}">${dueSoon}</div>
          </div>
          <div style="background:#fff;border:1px solid ${neverPulled>0?'#dde8ff':'#f0efe9'};border-radius:10px;padding:12px 14px">
            <div style="font-size:10px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px">Never Pulled</div>
            <div style="font-size:24px;font-weight:500;color:${neverPulled>0?'#2c5cc5':'#1a1a1a'}">${neverPulled}</div>
          </div>
        </div>

        <!-- Grid -->
        <div style="background:#fff;border:1px solid #f0efe9;border-radius:10px;overflow-x:auto">
          <table id="lt-table" style="width:100%;border-collapse:collapse;font-size:13px">
            <thead>
              <tr style="background:#fafaf8;border-bottom:2px solid #f0efe9">
                <th style="width:28px;padding:10px 8px"></th>
                <th style="padding:10px 8px;text-align:left;font-size:10px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.08em;white-space:nowrap">Action</th>
                <th style="padding:10px 8px;text-align:left;font-size:10px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.08em">State</th>
                <th style="padding:10px 8px;text-align:left;font-size:10px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.08em;min-width:160px">List Name</th>
                <th style="padding:10px 8px;text-align:left;font-size:10px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.08em;white-space:nowrap">Tier</th>
                <th style="padding:10px 8px;text-align:left;font-size:10px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.08em">Source</th>
                <th style="padding:10px 8px;text-align:left;font-size:10px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.08em;white-space:nowrap">Frequency</th>
                <th style="padding:10px 8px;text-align:left;font-size:10px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.08em;white-space:nowrap">Bot?</th>
                <th style="padding:10px 8px;text-align:left;font-size:10px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.08em;white-space:nowrap">Last Pull</th>
                <th style="padding:10px 8px;text-align:left;font-size:10px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.08em;white-space:nowrap">Next Pull</th>
                <th style="padding:10px 8px"></th>
              </tr>
            </thead>
            <tbody id="lt-tbody">
              ${rowHTML || `<tr><td colspan="11" style="padding:32px;text-align:center;color:#aaa;font-size:13px">No list types yet — click <strong>+ Add List Type</strong> to get started.</td></tr>`}
            </tbody>
          </table>
        </div>

        <p style="font-size:11px;color:#aaa;margin-top:10px">
          <span style="display:inline-block;width:10px;height:10px;background:#fdeaea;border-radius:2px;margin-right:4px;vertical-align:middle"></span>Overdue &nbsp;
          <span style="display:inline-block;width:10px;height:10px;background:#fff8e1;border-radius:2px;margin-right:4px;vertical-align:middle"></span>Due this week &nbsp;
          All edits save automatically on change.
        </p>
      </div>

      <style>
        .lt-row td { padding:8px 8px; border-bottom:1px solid #f5f4f0; vertical-align:middle; }
        .lt-row:hover td { background:#fafaf8; }
        .lt-overdue td { background:#fff5f5 !important; }
        .lt-soon td { background:#fffdf0 !important; }
        .lt-sel, .lt-input {
          font-family:inherit; font-size:12px; padding:5px 7px; border:1px solid transparent;
          border-radius:5px; background:transparent; color:#1a1a1a; width:100%;
          transition:border-color .12s;
        }
        .lt-sel:focus, .lt-input:focus {
          border-color:#1a1a1a; background:#fff; outline:none;
        }
        .lt-sel:hover, .lt-input:hover { border-color:#ddd; background:#fff; }
        .lt-name { min-width:140px; }
        .lt-date { min-width:120px; }
        .lt-drag { cursor:grab; color:#ccc; font-size:14px; padding:0 4px; user-select:none; width:24px; }
        .lt-saving { opacity:.5; pointer-events:none; }
        .lt-saved-flash td { background:#eaf6ea !important; transition:background .4s; }
      </style>

      <script>
        var ltSaveTimer = {};

        async function ltSave(id, field, value) {
          var row = document.querySelector('[data-id="' + id + '"]');
          if (row) row.classList.add('lt-saving');
          try {
            var res = await fetch('/lists/types/' + id, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ field: field, value: value })
            });
            var data = await res.json();
            if (!res.ok || data.error) {
              console.error('Save failed:', data.error);
              return;
            }
            if (row) {
              row.classList.remove('lt-saving');
              // Update Next Pull date cell in place if relevant fields changed
              if (field === 'last_pull_date' || field === 'frequency_days') {
                var nextCell = row.querySelector('.lt-next-cell');
                if (nextCell && data.next_pull_date) {
                  nextCell.textContent = data.next_pull_date;
                  nextCell.style.color = data.overdue ? '#c0392b' : data.due_soon ? '#c07a1a' : '#555';
                  nextCell.style.fontWeight = (data.overdue || data.due_soon) ? '600' : 'normal';
                  if (data.overdue) {
                    row.classList.remove('lt-soon'); row.classList.add('lt-overdue');
                    row.querySelectorAll('td').forEach(td => td.style.background = '#fff5f5');
                  } else if (data.due_soon) {
                    row.classList.remove('lt-overdue'); row.classList.add('lt-soon');
                    row.querySelectorAll('td').forEach(td => td.style.background = '#fffdf0');
                  } else {
                    row.classList.remove('lt-overdue'); row.classList.remove('lt-soon');
                    row.querySelectorAll('td').forEach(td => td.style.background = '');
                  }
                }
              }
            }
          } catch(e) {
            console.error('ltSave error:', e.message);
            if (row) row.classList.remove('lt-saving');
          }
        }

        async function ltMarkPulled(id) {
          var today = new Date().toISOString().slice(0,10);
          var row = document.querySelector('[data-id="' + id + '"]');
          if (row) {
            var dateInput = row.querySelector('input[type="date"]');
            if (dateInput) dateInput.value = today;
          }
          await ltSave(id, 'last_pull_date', today);
          // Flash the row green briefly
          if (row) {
            var tds = row.querySelectorAll('td');
            tds.forEach(td => { td.style.transition = 'background .1s'; td.style.background = '#eaf6ea'; });
            setTimeout(() => tds.forEach(td => td.style.background = ''), 800);
          }
        }

        async function ltDelete(id) {
          if (!confirm('Delete this list type? This cannot be undone.')) return;
          var res = await fetch('/lists/types/' + id + '/delete', { method: 'POST' });
          var data = await res.json();
          if (data.ok) {
            var row = document.querySelector('[data-id="' + id + '"]');
            if (row) row.remove();
          }
        }

        async function ltAddRow() {
          var res = await fetch('/lists/types', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ list_name: 'New List Type' })
          });
          var data = await res.json();
          if (data.ok && data.id) {
            // Reload so the new row appears with proper selects
            window.location.reload();
          }
        }
      </script>
    `, 'list-types'));
  } catch (e) {
    console.error('[lists/types GET]', e);
    res.status(500).send('Error loading List Registry: ' + e.message);
  }
});

// ── POST /lists/types — create new row ───────────────────────────────────────
router.post('/types', requireAuth, async (req, res) => {
  try {
    const name = String(req.body.list_name || 'New List Type').slice(0, 100).trim();
    const r = await query(
      `INSERT INTO list_templates (list_name, action, sort_order) VALUES ($1, '', 0) RETURNING id`,
      [name]
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
    };

    if (!ALLOWED[field]) return res.status(400).json({ error: 'Invalid field: ' + field });
    const coerced = ALLOWED[field](value);

    await query(
      `UPDATE list_templates SET ${field} = $1, updated_at = NOW() WHERE id = $2`,
      [coerced, id]
    );

    // Return the derived next_pull_date so the client can update the cell
    const updated = await query(`SELECT last_pull_date, frequency_days FROM list_templates WHERE id = $1`, [id]);
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
    await query(`DELETE FROM list_templates WHERE id = $1`, [id]);
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
    await query(`UPDATE list_templates SET last_pull_date = $1, updated_at = NOW() WHERE id = $2`, [today, id]);
    const r = await query(`SELECT last_pull_date, frequency_days FROM list_templates WHERE id = $1`, [id]);
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
    const result = await query(`SELECT last_pull_date, frequency_days FROM list_templates WHERE action = 'pull'`);
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
