// ─────────────────────────────────────────────────────────────────────────────
// distress.js — Phase 1 distress scoring engine for Loki
// Pure scoring + DB cache + event-driven updates + audit logging
// ─────────────────────────────────────────────────────────────────────────────

const { query } = require('../db');

// ── WEIGHTS (single source of truth — tune here, recompute, done) ──────────
const WEIGHTS = {
  list_tax_sale:        20,
  list_pre_foreclosure: 20,
  list_probate:         20,
  list_code_violation:  15,
  list_vacant:          15,
  stack_5_plus:         15,
  stack_3_4:            10,
  stack_2:              5,
  high_equity:          10,   // equity_percent >= 50
  out_of_state:         10,   // mailing_state != property state_code
  marketing_lead:       5,    // marketing_result = 'Lead'
};

// Display cap so the score reads as a 0-100 percentage-feel
const DISPLAY_CAP = 100;

// Bands
function bandFor(score) {
  if (score >= 75) return 'burning';
  if (score >= 55) return 'hot';
  if (score >= 30) return 'warm';
  return 'cold';
}

const BAND_COLORS = {
  burning: { bg: '#fdecec', text: '#c0392b', label: 'Burning' },
  hot:     { bg: '#fff2e6', text: '#d35400', label: 'Hot' },
  warm:    { bg: '#fff8e1', text: '#9a6800', label: 'Warm' },
  cold:    { bg: '#f5f4f0', text: '#888',    label: 'Cold' },
};

// ── List-type matcher ──────────────────────────────────────────────────────
// Maps a list's normalized type or name to a canonical signal key.
// Both list_type and list_name are checked so legacy lists with no type
// still match if the name is meaningful.
function classifyList(listType, listName) {
  const t = String(listType || '').toLowerCase().trim();
  const n = String(listName || '').toLowerCase().trim();
  const both = t + ' ' + n;
  if (/tax\s*sale|tax\s*delinq/.test(both)) return 'tax_sale';
  if (/pre[\s-]?foreclosure|pre[\s-]?fc|notice\s*of\s*default|nod|lis\s*pendens|auction/.test(both)) return 'pre_foreclosure';
  if (/probate|deceased|estate|affidavit\s*of\s*death/.test(both)) return 'probate';
  if (/code\s*violation|municipal\s*lien/.test(both)) return 'code_violation';
  if (/vacant/.test(both)) return 'vacant';
  return null;
}

// ── Pure scoring function ──────────────────────────────────────────────────
// Inputs: a "context" object with everything needed. Caller assembles it.
//   ctx = {
//     property_state_code, mailing_state, equity_percent, marketing_result,
//     list_signals: Set<string>,  // e.g. new Set(['tax_sale','vacant'])
//     list_count: number,
//   }
// Returns: { score, capped_score, band, breakdown: [{key, label, points}] }
function computeScore(ctx) {
  const breakdown = [];
  let raw = 0;
  const add = (key, points, label) => {
    if (points > 0) {
      breakdown.push({ key, label, points });
      raw += points;
    }
  };

  // List signals
  if (ctx.list_signals && ctx.list_signals.has('tax_sale'))        add('list_tax_sale',        WEIGHTS.list_tax_sale,        'On Tax Sale list');
  if (ctx.list_signals && ctx.list_signals.has('pre_foreclosure')) add('list_pre_foreclosure', WEIGHTS.list_pre_foreclosure, 'On Pre-Foreclosure list');
  if (ctx.list_signals && ctx.list_signals.has('probate'))         add('list_probate',         WEIGHTS.list_probate,         'On Probate list');
  if (ctx.list_signals && ctx.list_signals.has('code_violation'))  add('list_code_violation',  WEIGHTS.list_code_violation,  'On Code Violation list');
  if (ctx.list_signals && ctx.list_signals.has('vacant'))          add('list_vacant',          WEIGHTS.list_vacant,          'On Vacant list');

  // Stack count (mutually exclusive bands)
  const lc = parseInt(ctx.list_count) || 0;
  if (lc >= 5)      add('stack_5_plus', WEIGHTS.stack_5_plus, 'Stacked on 5+ lists');
  else if (lc >= 3) add('stack_3_4',    WEIGHTS.stack_3_4,    'Stacked on 3-4 lists');
  else if (lc === 2) add('stack_2',     WEIGHTS.stack_2,      'Stacked on 2 lists');

  // High equity
  const eq = parseFloat(ctx.equity_percent);
  if (!isNaN(eq) && eq >= 50) add('high_equity', WEIGHTS.high_equity, 'High equity (≥50%)');

  // Out-of-state owner (only if BOTH states populated)
  const ps = String(ctx.property_state_code || '').trim().toUpperCase();
  const ms = String(ctx.mailing_state || '').trim().toUpperCase();
  if (ps && ms && ps !== ms) add('out_of_state', WEIGHTS.out_of_state, 'Out-of-state owner');

  // Marketing already engaged
  if (String(ctx.marketing_result || '').toLowerCase() === 'lead') {
    add('marketing_lead', WEIGHTS.marketing_lead, 'Already a Lead');
  }

  const capped = Math.min(raw, DISPLAY_CAP);
  return {
    score: capped,
    raw_score: raw,
    band: bandFor(capped),
    breakdown,
  };
}

// ── Schema migration (idempotent) ──────────────────────────────────────────
async function ensureDistressSchema() {
  await query(`
    ALTER TABLE properties
      ADD COLUMN IF NOT EXISTS distress_score INTEGER DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS distress_band  VARCHAR(16) DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS distress_breakdown JSONB DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS distress_scored_at TIMESTAMP DEFAULT NULL
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_properties_distress_score ON properties(distress_score)`);
  await query(`
    CREATE TABLE IF NOT EXISTS distress_score_log (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
      score INTEGER NOT NULL,
      band VARCHAR(16),
      breakdown JSONB,
      logged_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_distress_log_property ON distress_score_log(property_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_distress_log_logged ON distress_score_log(logged_at)`);
  await query(`
    CREATE TABLE IF NOT EXISTS distress_outcome_log (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
      outcome_type VARCHAR(32) NOT NULL,
      old_value VARCHAR(64),
      new_value VARCHAR(64),
      score_at_event INTEGER,
      band_at_event VARCHAR(16),
      breakdown_at_event JSONB,
      logged_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_outcome_log_property ON distress_outcome_log(property_id)`);
}

// ── Score one property by ID ───────────────────────────────────────────────
// Reads everything needed, computes, stores, optionally logs.
async function scoreProperty(propertyId) {
  await ensureDistressSchema();

  const propRes = await query(
    `SELECT p.id, p.state_code, p.equity_percent, p.marketing_result,
            c.mailing_state
       FROM properties p
       LEFT JOIN property_contacts pc ON pc.property_id = p.id AND pc.primary_contact = true
       LEFT JOIN contacts c ON c.id = pc.contact_id
      WHERE p.id = $1`,
    [propertyId]
  );
  if (!propRes.rows.length) return null;
  const p = propRes.rows[0];

  // Lists this property is on
  const listRes = await query(
    `SELECT l.list_type, l.list_name
       FROM property_lists pl
       JOIN lists l ON l.id = pl.list_id
      WHERE pl.property_id = $1`,
    [propertyId]
  );
  const list_signals = new Set();
  for (const l of listRes.rows) {
    const sig = classifyList(l.list_type, l.list_name);
    if (sig) list_signals.add(sig);
  }
  const list_count = listRes.rows.length;

  const result = computeScore({
    property_state_code: p.state_code,
    mailing_state:       p.mailing_state,
    equity_percent:      p.equity_percent,
    marketing_result:    p.marketing_result,
    list_signals,
    list_count,
  });

  // Get prior score to detect changes
  const priorRes = await query(`SELECT distress_score FROM properties WHERE id = $1`, [propertyId]);
  const priorScore = priorRes.rows[0]?.distress_score ?? null;

  await query(
    `UPDATE properties
        SET distress_score      = $1,
            distress_band       = $2,
            distress_breakdown  = $3::jsonb,
            distress_scored_at  = NOW()
      WHERE id = $4`,
    [result.score, result.band, JSON.stringify(result.breakdown), propertyId]
  );

  // Log only if score changed
  if (priorScore !== result.score) {
    await query(
      `INSERT INTO distress_score_log (property_id, score, band, breakdown)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [propertyId, result.score, result.band, JSON.stringify(result.breakdown)]
    );
  }

  return result;
}

// ── Score many properties (batch, used by Recompute All button) ────────────
// Uses bulk SQL for performance. 41k properties done in ~2-3 seconds instead
// of 10+ minutes if we looped per-property.
async function scoreAllProperties(progressCb) {
  await ensureDistressSchema();

  // Build one big CTE that aggregates signals per property, then a single
  // UPDATE that computes score from those signals using the same weights.
  const w = WEIGHTS;
  // NB: keep list pattern matching in sync with classifyList() above
  const sql = `
    WITH list_flags AS (
      SELECT pl.property_id,
             BOOL_OR(LOWER(COALESCE(l.list_type,'') || ' ' || COALESCE(l.list_name,'')) ~ 'tax[[:space:]]*sale|tax[[:space:]]*delinq') AS has_tax_sale,
             BOOL_OR(LOWER(COALESCE(l.list_type,'') || ' ' || COALESCE(l.list_name,'')) ~ 'pre[[:space:]-]?foreclosure|pre[[:space:]-]?fc|notice[[:space:]]*of[[:space:]]*default|nod|lis[[:space:]]*pendens|auction') AS has_pre_fc,
             BOOL_OR(LOWER(COALESCE(l.list_type,'') || ' ' || COALESCE(l.list_name,'')) ~ 'probate|deceased|estate|affidavit[[:space:]]*of[[:space:]]*death') AS has_probate,
             BOOL_OR(LOWER(COALESCE(l.list_type,'') || ' ' || COALESCE(l.list_name,'')) ~ 'code[[:space:]]*violation|municipal[[:space:]]*lien') AS has_code_viol,
             BOOL_OR(LOWER(COALESCE(l.list_type,'') || ' ' || COALESCE(l.list_name,'')) ~ 'vacant') AS has_vacant,
             COUNT(DISTINCT pl.list_id) AS list_count
        FROM property_lists pl
        JOIN lists l ON l.id = pl.list_id
       GROUP BY pl.property_id
    ),
    primary_contact AS (
      SELECT pc.property_id, c.mailing_state
        FROM property_contacts pc
        JOIN contacts c ON c.id = pc.contact_id
       WHERE pc.primary_contact = true
    ),
    scored AS (
      SELECT p.id,
             LEAST(100,
               CASE WHEN lf.has_tax_sale  THEN ${w.list_tax_sale}        ELSE 0 END +
               CASE WHEN lf.has_pre_fc    THEN ${w.list_pre_foreclosure} ELSE 0 END +
               CASE WHEN lf.has_probate   THEN ${w.list_probate}         ELSE 0 END +
               CASE WHEN lf.has_code_viol THEN ${w.list_code_violation}  ELSE 0 END +
               CASE WHEN lf.has_vacant    THEN ${w.list_vacant}          ELSE 0 END +
               CASE
                 WHEN COALESCE(lf.list_count,0) >= 5 THEN ${w.stack_5_plus}
                 WHEN COALESCE(lf.list_count,0) >= 3 THEN ${w.stack_3_4}
                 WHEN COALESCE(lf.list_count,0) = 2 THEN ${w.stack_2}
                 ELSE 0
               END +
               CASE WHEN p.equity_percent >= 50 THEN ${w.high_equity} ELSE 0 END +
               CASE WHEN UPPER(TRIM(COALESCE(p.state_code,''))) <> ''
                     AND UPPER(TRIM(COALESCE(pc.mailing_state,''))) <> ''
                     AND UPPER(TRIM(p.state_code)) <> UPPER(TRIM(pc.mailing_state))
                    THEN ${w.out_of_state} ELSE 0 END +
               CASE WHEN LOWER(COALESCE(p.marketing_result,'')) = 'lead' THEN ${w.marketing_lead} ELSE 0 END
             ) AS score
        FROM properties p
        LEFT JOIN list_flags lf ON lf.property_id = p.id
        LEFT JOIN primary_contact pc ON pc.property_id = p.id
    )
    UPDATE properties p
       SET distress_score = s.score,
           distress_band = CASE
             WHEN s.score >= 75 THEN 'burning'
             WHEN s.score >= 55 THEN 'hot'
             WHEN s.score >= 30 THEN 'warm'
             ELSE 'cold'
           END,
           distress_scored_at = NOW()
      FROM scored s
     WHERE p.id = s.id;
  `;

  if (progressCb) progressCb({ done: 0, total: 0, phase: 'bulk_update' });
  const res = await query(sql);
  const scored = res.rowCount || 0;

  // For breakdowns (per-property JSONB), we'd need a second pass.
  // For Phase 1, breakdowns populate naturally on detail-page view (lazy)
  // or on next property edit. Bulk recompute intentionally skips breakdowns
  // to keep it fast — the scores are correct, just the drill-down is lazy.
  if (progressCb) progressCb({ done: scored, total: scored, finished: true });
  return { total: scored, scored };
}

// ── Full per-property rescore including breakdown (for smaller batches) ────
async function scoreAllPropertiesWithBreakdown(progressCb, limit) {
  await ensureDistressSchema();
  const lim = limit ? ` LIMIT ${parseInt(limit)}` : '';
  const idsRes = await query(`SELECT id FROM properties ORDER BY id ASC${lim}`);
  const ids = idsRes.rows.map(r => r.id);
  let done = 0;
  for (const id of ids) {
    try { await scoreProperty(id); }
    catch(e) { console.error('[distress] score failed for property', id, e.message); }
    done++;
    if (progressCb && done % 250 === 0) progressCb({ done, total: ids.length });
  }
  if (progressCb) progressCb({ done, total: ids.length, finished: true });
  return { total: ids.length, scored: done };
}

// ── Outcome logger (call when marketing_result or pipeline_stage changes) ──
async function logOutcomeChange(propertyId, outcomeType, oldValue, newValue) {
  await ensureDistressSchema();
  // Read current cached score (don't recompute — capture state at event)
  const r = await query(
    `SELECT distress_score, distress_band, distress_breakdown
       FROM properties WHERE id = $1`,
    [propertyId]
  );
  const row = r.rows[0] || {};
  await query(
    `INSERT INTO distress_outcome_log
       (property_id, outcome_type, old_value, new_value,
        score_at_event, band_at_event, breakdown_at_event)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      propertyId, outcomeType,
      oldValue == null ? null : String(oldValue),
      newValue == null ? null : String(newValue),
      row.distress_score ?? null,
      row.distress_band  ?? null,
      row.distress_breakdown == null ? null : JSON.stringify(row.distress_breakdown),
    ]
  );
}

// ── Distribution stats for the audit page ──────────────────────────────────
async function getScoreDistribution() {
  await ensureDistressSchema();
  const r = await query(`
    SELECT
      COUNT(*) FILTER (WHERE distress_score IS NULL)                    AS unscored,
      COUNT(*) FILTER (WHERE distress_band = 'cold')                    AS cold,
      COUNT(*) FILTER (WHERE distress_band = 'warm')                    AS warm,
      COUNT(*) FILTER (WHERE distress_band = 'hot')                     AS hot,
      COUNT(*) FILTER (WHERE distress_band = 'burning')                 AS burning,
      COUNT(*)                                                          AS total
    FROM properties
  `);
  return r.rows[0] || {};
}

// ── Outcome conversion stats by band (the learning loop) ───────────────────
async function getConversionByBand() {
  await ensureDistressSchema();
  const r = await query(`
    SELECT band_at_event AS band,
           outcome_type,
           new_value,
           COUNT(*) AS count
      FROM distress_outcome_log
     WHERE band_at_event IS NOT NULL
     GROUP BY band_at_event, outcome_type, new_value
     ORDER BY band_at_event, outcome_type, new_value
  `);
  return r.rows;
}

module.exports = {
  WEIGHTS,
  BAND_COLORS,
  bandFor,
  classifyList,
  computeScore,
  ensureDistressSchema,
  scoreProperty,
  scoreAllProperties,
  scoreAllPropertiesWithBreakdown,
  logOutcomeChange,
  getScoreDistribution,
  getConversionByBand,
};
