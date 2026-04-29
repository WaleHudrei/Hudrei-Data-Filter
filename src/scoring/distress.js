// ─────────────────────────────────────────────────────────────────────────────
// distress.js — Phase 1 distress scoring engine for Loki
// Pure scoring + DB cache + event-driven updates + audit logging
// ─────────────────────────────────────────────────────────────────────────────

const { query } = require('../db');
const distressConfig = require('./distress-config');

// Module-level idempotency flag — ensureDistressSchema pays DDL cost at most
// once per process. Prior code called it at the top of every exported function,
// paying the cost on every single property view. (Audit issue #16.)
let _distressSchemaReady = false;

// ── WEIGHTS (single source of truth — tune here, recompute, done) ──────────
// 2026-04-18 weight rebalance (pass 9):
//   tax_sale          20 → 30   (highest-intent signal; sheriff sale = same)
//   tax_delinquent    10 → 15
//   pre_foreclosure   20 → 15   (weaker than active foreclosure action)
//   mortgage_foreclosure  —  → 20   NEW signal, more urgent than pre_foreclosure
//   county_source      5 → 10   (authoritative source, less competition)
// Unchanged: probate 20, code_violation 15, vacant 15, stacks 15/10/5,
//            high_equity 10, out_of_state 10, marketing_lead 5.
const WEIGHTS = {
  list_tax_sale:            30,   // also covers sheriff sale (same signal)
  list_tax_delinquent:      15,
  list_pre_foreclosure:     15,
  list_mortgage_foreclosure: 20,
  list_probate:             20,
  list_code_violation:      15,
  list_vacant:              15,
  stack_5_plus:             15,
  stack_3_4:                10,
  stack_2:                  5,
  high_equity:              10,   // equity_percent >= 50
  out_of_state:             10,   // mailing_state != property state_code
  marketing_lead:           5,    // pipeline_stage IN ('lead','contract','closed')
  county_source:            10,   // on at least one list whose source contains "county"
};

// Display cap so the score reads as a 0-100 percentage-feel
const DISPLAY_CAP = 100;

// Bands. With a per-tenant config the cutoffs are tenant-overridable; without
// one (legacy callers) the defaults are applied.
function bandFor(score, bands) {
  const b = bands || { warm: 30, hot: 55, burning: 75 };
  if (score >= b.burning) return 'burning';
  if (score >= b.hot)     return 'hot';
  if (score >= b.warm)    return 'warm';
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
//
// 2026-04-18 pass 9: sheriff sale is treated as the same signal as tax sale
// (same intent, same weight). Mortgage foreclosure is a NEW signal at +20 —
// more urgent than pre_foreclosure (notice stage) but not as late as tax_sale.
// Order matters — check more specific patterns first so they win over weaker
// matches (e.g. "mortgage foreclosure" should NOT fall through to pre_fc).
function classifyList(listType, listName) {
  const t = String(listType || '').toLowerCase().trim();
  const n = String(listName || '').toLowerCase().trim();
  const both = t + ' ' + n;
  // Tax sale and sheriff sale collapse to one signal (same weight, same meaning).
  if (/tax\s*sale|sheriff[\s']*s?\s*sale/.test(both)) return 'tax_sale';
  // Mortgage foreclosure — ACTIVE foreclosure action, stronger than pre_fc notice.
  // Check BEFORE pre_foreclosure so "mortgage foreclosure" doesn't fall through.
  if (/mortgage\s*foreclosure|mortgage\s*default|notice\s*of\s*sale/.test(both)) return 'mortgage_foreclosure';
  if (/tax\s*delinq/.test(both)) return 'tax_delinquent';
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
//     has_county_source: boolean,
//   }
// Returns: { score, capped_score, band, breakdown: [{key, label, points}] }
function computeScore(ctx, config) {
  // When called with no config (legacy in-process callers), fall back to the
  // built-in defaults so nothing breaks. Per-tenant config is supplied by
  // scoreProperty() after a config lookup.
  const W      = (config && config.weights) || {
    list_tax_sale: 30, list_tax_delinquent: 15, list_pre_foreclosure: 15,
    list_mortgage_foreclosure: 20, list_probate: 20, list_code_violation: 15,
    list_vacant: 15, stack_5_plus: 15, stack_3_4: 10, stack_2: 5,
    high_equity: 10, out_of_state: 10, marketing_lead: 5, county_source: 10,
  };
  const bands  = (config && config.bands) || { warm: 30, hot: 55, burning: 75 };
  const custom = (config && Array.isArray(config.custom_signals)) ? config.custom_signals : [];

  const breakdown = [];
  let raw = 0;
  const add = (key, points, label) => {
    if (points > 0) {
      breakdown.push({ key, label, points });
      raw += points;
    }
  };

  // List signals
  // 2026-04-18 audit fix #42: SQL bulk scorer (scoreAllProperties) treats
  // tax_sale and tax_delinquent as mutually exclusive (tax_sale wins when both
  // present — see `AND NOT COALESCE(lf.has_tax_sale,false)` in the SQL).
  // The JS scorer previously let BOTH apply, which made the same property
  // score differently depending on which code path ran last (scoreProperty
  // vs scoreAllProperties). Now matches SQL: tax_sale precludes tax_delinquent.
  //
  // Pass 9: mortgage_foreclosure added as NEW signal. It's more urgent than
  // pre_foreclosure (notice stage). Mutually exclusive — a property on both
  // a mortgage foreclosure list AND a pre-foreclosure list gets +20 once,
  // not +35. Same stage of the same process, just different naming.
  const hasTaxSale       = ctx.list_signals && ctx.list_signals.has('tax_sale');
  const hasTaxDelinquent = ctx.list_signals && ctx.list_signals.has('tax_delinquent');
  const hasMortgageFc    = ctx.list_signals && ctx.list_signals.has('mortgage_foreclosure');
  const hasPreFc         = ctx.list_signals && ctx.list_signals.has('pre_foreclosure');
  if (hasTaxSale)                            add('list_tax_sale',        W.list_tax_sale,        'On Tax Sale / Sheriff Sale list');
  if (hasTaxDelinquent && !hasTaxSale)       add('list_tax_delinquent',  W.list_tax_delinquent,  'On Tax Delinquent list');
  if (hasMortgageFc)                         add('list_mortgage_foreclosure', W.list_mortgage_foreclosure, 'On Mortgage Foreclosure list');
  if (hasPreFc && !hasMortgageFc)            add('list_pre_foreclosure', W.list_pre_foreclosure, 'On Pre-Foreclosure list');
  if (ctx.list_signals && ctx.list_signals.has('probate'))         add('list_probate',         W.list_probate,         'On Probate list');
  if (ctx.list_signals && ctx.list_signals.has('code_violation'))  add('list_code_violation',  W.list_code_violation,  'On Code Violation list');
  if (ctx.list_signals && ctx.list_signals.has('vacant'))          add('list_vacant',          W.list_vacant,          'On Vacant list');

  // Stack count (mutually exclusive bands)
  const lc = parseInt(ctx.list_count) || 0;
  if (lc >= 5)      add('stack_5_plus', W.stack_5_plus, 'Stacked on 5+ lists');
  else if (lc >= 3) add('stack_3_4',    W.stack_3_4,    'Stacked on 3-4 lists');
  else if (lc === 2) add('stack_2',     W.stack_2,      'Stacked on 2 lists');

  // High equity
  const eq = parseFloat(ctx.equity_percent);
  if (!isNaN(eq) && eq >= 50) add('high_equity', W.high_equity, 'High equity (≥50%)');

  // Out-of-state owner (only if BOTH states populated)
  const ps = String(ctx.property_state_code || '').trim().toUpperCase();
  const ms = String(ctx.mailing_state || '').trim().toUpperCase();
  if (ps && ms && ps !== ms) add('out_of_state', W.out_of_state, 'Out-of-state owner');

  // Marketing already engaged — property has advanced beyond "prospect" in the
  // pipeline. Uses pipeline_stage (set by filtration.js on transfer) rather
  // than marketing_result (which was never populated). (Audit issue #12.)
  const stage = String(ctx.pipeline_stage || '').toLowerCase().trim();
  if (stage === 'lead' || stage === 'contract' || stage === 'closed') {
    add('marketing_lead', W.marketing_lead, 'Already engaged (' + stage + ')');
  }

  // County-sourced data bonus — authoritative records, less competition from
  // scraper aggregators. 2026-04-20 pass 12: previously fired whenever ANY
  // list on the property had source matching "county", including pure
  // marketing lists. Now requires at least one actual distress signal to
  // fire — a property on only a "County Marketing List" with no distress
  // indicator no longer gets a free +10.
  const hasAnyDistressSignal = hasTaxSale || hasTaxDelinquent || hasMortgageFc || hasPreFc ||
    (ctx.list_signals && (ctx.list_signals.has('probate') || ctx.list_signals.has('code_violation') || ctx.list_signals.has('vacant')));
  if (ctx.has_county_source && hasAnyDistressSignal) {
    add('county_source', W.county_source, 'County-sourced distress list');
  }

  // Custom user-defined signals (Task 9). Each is a list-keyword matcher: if
  // any list this property is on has a name or type containing the keyword
  // (case-insensitive), the signal's points are added. Keyword set comes
  // from ctx.custom_matches which the caller pre-computes from list rows.
  const matchedCustom = ctx.custom_matches instanceof Set ? ctx.custom_matches : new Set();
  for (const sig of custom) {
    if (matchedCustom.has(sig.id)) {
      add('custom:' + sig.id, sig.weight, sig.label);
    }
  }

  const capped = Math.min(raw, DISPLAY_CAP);
  return {
    score: capped,
    raw_score: raw,
    band: bandFor(capped, bands),
    breakdown,
  };
}

// ── Scoring version — bump when the scoring logic changes ──────────────────
// Rows with distress_scoring_version < SCORING_VERSION are stale and need a
// rescore. Bumped to 2 in the 2026-04-17 audit when marketing_lead moved from
// p.marketing_result='lead' to p.pipeline_stage IN ('lead','contract','closed').
// Bumped to 3 on 2026-04-18 for the weight rebalance + mortgage_foreclosure
// signal + sheriff_sale alias. Every existing cached score is now stale under
// the new weights; operator should run "Recompute All" on /records/_distress
// to bring them up to date.
const SCORING_VERSION = 3;

// ── Schema migration (idempotent — runs at most once per process) ──────────
async function ensureDistressSchema() {
  if (_distressSchemaReady) return;
  await query(`
    ALTER TABLE properties
      ADD COLUMN IF NOT EXISTS distress_score INTEGER DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS distress_band  VARCHAR(16) DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS distress_breakdown JSONB DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS distress_scored_at TIMESTAMP DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS distress_scoring_version INTEGER DEFAULT 1
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_properties_distress_score ON properties(distress_score)`);
  await query(`
    CREATE TABLE IF NOT EXISTS distress_score_log (
      id SERIAL PRIMARY KEY,
      tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
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
      tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
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

  // Stale-score detection — count rows scored under an older scoring_version.
  // Does NOT rescore automatically (that's a potentially expensive operation
  // on 100k+ rows that we don't want happening as a side effect of boot).
  // Instead, log a loud warning telling the operator to run the rescore
  // endpoint. (Audit gap — pipeline_stage logic change in 2026-04-17.)
  try {
    const stale = await query(
      `SELECT COUNT(*) AS n FROM properties
        WHERE distress_score IS NOT NULL
          AND COALESCE(distress_scoring_version, 1) < $1`,
      [SCORING_VERSION]
    );
    const n = parseInt(stale.rows[0]?.n || 0);
    if (n > 0) {
      console.log(`[distress] ${n.toLocaleString()} properties have scores from an older scoring version (v${SCORING_VERSION} current).`);
      console.log(`[distress] Trigger a full rescore by POSTing to /records/_distress/recompute, or call distress.scoreAllProperties() from code.`);
      console.log(`[distress] Until rescored, the Records page will mix old and new scores.`);
    }
  } catch (e) { /* non-fatal */ }

  _distressSchemaReady = true;
}

// ── Score one property by ID ───────────────────────────────────────────────
// Reads everything needed, computes, stores, optionally logs.
async function scoreProperty(propertyId) {
  await ensureDistressSchema();

  const propRes = await query(
    `SELECT p.id, p.tenant_id, p.state_code, p.equity_percent, p.pipeline_stage,
            c.mailing_state
       FROM properties p
       LEFT JOIN property_contacts pc ON pc.property_id = p.id AND pc.primary_contact = true
       LEFT JOIN contacts c ON c.id = pc.contact_id
      WHERE p.id = $1`,
    [propertyId]
  );
  if (!propRes.rows.length) return null;
  const p = propRes.rows[0];

  // Per-tenant config: weights, bands, and custom keyword signals.
  const config = await distressConfig.getConfig(p.tenant_id);

  // Lists this property is on — needed for built-in signals AND for matching
  // custom keyword signals.
  const listRes = await query(
    `SELECT l.list_type, l.list_name, l.source
       FROM property_lists pl
       JOIN lists l ON l.id = pl.list_id
      WHERE pl.property_id = $1`,
    [propertyId]
  );
  const list_signals = new Set();
  const custom_matches = new Set();
  let has_county_source = false;
  for (const l of listRes.rows) {
    const sig = classifyList(l.list_type, l.list_name);
    if (sig) list_signals.add(sig);
    if (l.source && /county/i.test(String(l.source))) {
      has_county_source = true;
    }
    // Custom signals: list-keyword matchers. Each looks for its match_value
    // in the lowercased "list_type list_name" combined string. Same lookup
    // semantics as classifyList so users get consistent matching.
    const both = (String(l.list_type || '') + ' ' + String(l.list_name || '')).toLowerCase();
    for (const cs of config.custom_signals) {
      if (cs.match_type === 'list_keyword' && cs.match_value && both.includes(cs.match_value)) {
        custom_matches.add(cs.id);
      }
    }
  }
  const list_count = listRes.rows.length;

  const result = computeScore({
    property_state_code: p.state_code,
    mailing_state:       p.mailing_state,
    equity_percent:      p.equity_percent,
    pipeline_stage:      p.pipeline_stage,
    list_signals,
    list_count,
    has_county_source,
    custom_matches,
  }, config);

  // Get prior score to detect changes
  const priorRes = await query(`SELECT distress_score FROM properties WHERE id = $1`, [propertyId]);
  const priorScore = priorRes.rows[0]?.distress_score ?? null;

  await query(
    `UPDATE properties
        SET distress_score      = $1,
            distress_band       = $2,
            distress_breakdown  = $3::jsonb,
            distress_scored_at  = NOW(),
            distress_scoring_version = ${SCORING_VERSION}
      WHERE id = $4`,
    [result.score, result.band, JSON.stringify(result.breakdown), propertyId]
  );

  // Log only if score changed. tenant_id is read from the property row to
  // avoid plumbing tenantId through every caller (single property lookup is
  // already tenant-correct via the FK).
  if (priorScore !== result.score) {
    await query(
      `INSERT INTO distress_score_log (tenant_id, property_id, score, band, breakdown)
       SELECT tenant_id, $1, $2, $3, $4::jsonb FROM properties WHERE id = $1`,
      [propertyId, result.score, result.band, JSON.stringify(result.breakdown)]
    );
  }

  return result;
}

// ── Score a specific SET of properties (bulk SQL, no breakdown) ────────────
// Fast path used after imports/uploads — only rescores touched properties.
// 2026-04-30: with per-tenant distress config (Task 9), the bulk SQL path
// can no longer produce correct scores for tenants who have customized their
// matrix — it would apply default weights and bands, clobbering tenant-set
// scores. When the property set belongs to a single tenant AND that tenant
// has overrides, we fall back to looping scoreProperty() per id (slower but
// honors weights, bands, AND custom keyword signals). For everyone else the
// fast SQL path runs unchanged.
async function scoreProperties(propertyIds) {
  if (!Array.isArray(propertyIds) || propertyIds.length === 0) return { scored: 0 };
  await ensureDistressSchema();

  // Detect tenant of these ids. If they all share a tenant AND that tenant
  // has overrides, route through the per-property path.
  const tenantRes = await query(
    `SELECT DISTINCT tenant_id FROM properties WHERE id = ANY($1::int[])`,
    [propertyIds]
  );
  if (tenantRes.rows.length === 1) {
    const tid = tenantRes.rows[0].tenant_id;
    const cfg = await distressConfig.getConfig(tid);
    if (cfg._hasOverrides) {
      let scored = 0;
      for (const id of propertyIds) {
        try { await scoreProperty(id); scored++; }
        catch (e) { console.error('[distress] per-id score failed', id, e.message); }
      }
      return { scored };
    }
  }

  const w = WEIGHTS;
  const sql = `
    WITH touched AS (
      SELECT UNNEST($1::int[]) AS id
    ),
    list_flags AS (
      SELECT pl.property_id,
             -- Pass 9: tax_sale regex now matches "sheriff sale" / "sheriff's sale" /
             -- "sheriffs sale" — same signal, same +30 weight. The apostrophe is doubled
             -- inside this template literal because the SQL string is being embedded
             -- in a JS backtick string.
             BOOL_OR(LOWER(COALESCE(l.list_type,'') || ' ' || COALESCE(l.list_name,'')) ~ 'tax[[:space:]]*sale|sheriff[[:space:]'']*s?[[:space:]]*sale') AS has_tax_sale,
             BOOL_OR(LOWER(COALESCE(l.list_type,'') || ' ' || COALESCE(l.list_name,'')) ~ 'tax[[:space:]]*delinq') AS has_tax_delinq,
             -- Pass 9: new mortgage_foreclosure signal at +20. Distinct from
             -- pre_foreclosure (which covers earlier-stage signals: NOD, lis pendens).
             BOOL_OR(LOWER(COALESCE(l.list_type,'') || ' ' || COALESCE(l.list_name,'')) ~ 'mortgage[[:space:]]*foreclosure|mortgage[[:space:]]*default|notice[[:space:]]*of[[:space:]]*sale') AS has_mortgage_fc,
             BOOL_OR(LOWER(COALESCE(l.list_type,'') || ' ' || COALESCE(l.list_name,'')) ~ 'pre[[:space:]-]?foreclosure|pre[[:space:]-]?fc|notice[[:space:]]*of[[:space:]]*default|nod|lis[[:space:]]*pendens|auction') AS has_pre_fc,
             BOOL_OR(LOWER(COALESCE(l.list_type,'') || ' ' || COALESCE(l.list_name,'')) ~ 'probate|deceased|estate|affidavit[[:space:]]*of[[:space:]]*death') AS has_probate,
             BOOL_OR(LOWER(COALESCE(l.list_type,'') || ' ' || COALESCE(l.list_name,'')) ~ 'code[[:space:]]*violation|municipal[[:space:]]*lien') AS has_code_viol,
             BOOL_OR(LOWER(COALESCE(l.list_type,'') || ' ' || COALESCE(l.list_name,'')) ~ 'vacant') AS has_vacant,
             BOOL_OR(LOWER(COALESCE(l.source,'')) ~ 'county') AS has_county_source,
             COUNT(DISTINCT pl.list_id) AS list_count
        FROM property_lists pl
        JOIN lists l ON l.id = pl.list_id
       WHERE pl.property_id IN (SELECT id FROM touched)
       GROUP BY pl.property_id
    ),
    primary_contact AS (
      SELECT pc.property_id, c.mailing_state
        FROM property_contacts pc
        JOIN contacts c ON c.id = pc.contact_id
       WHERE pc.primary_contact = true
         AND pc.property_id IN (SELECT id FROM touched)
    ),
    scored AS (
      SELECT p.id,
             LEAST(100,
               CASE WHEN lf.has_tax_sale   THEN ${w.list_tax_sale}        ELSE 0 END +
               CASE WHEN lf.has_tax_delinq AND NOT COALESCE(lf.has_tax_sale,false)
                                           THEN ${w.list_tax_delinquent}  ELSE 0 END +
               -- Pass 9: mortgage_foreclosure is the stronger signal; when both
               -- present, only mortgage_foreclosure scores (stage-of-process mutex).
               CASE WHEN lf.has_mortgage_fc THEN ${w.list_mortgage_foreclosure} ELSE 0 END +
               CASE WHEN lf.has_pre_fc    AND NOT COALESCE(lf.has_mortgage_fc,false)
                                           THEN ${w.list_pre_foreclosure} ELSE 0 END +
               CASE WHEN lf.has_probate   THEN ${w.list_probate}         ELSE 0 END +
               CASE WHEN lf.has_code_viol THEN ${w.list_code_violation}  ELSE 0 END +
               CASE WHEN lf.has_vacant    THEN ${w.list_vacant}          ELSE 0 END +
               CASE WHEN lf.has_county_source AND (
                                      COALESCE(lf.has_tax_sale,false) OR COALESCE(lf.has_tax_delinq,false) OR
                                      COALESCE(lf.has_mortgage_fc,false) OR COALESCE(lf.has_pre_fc,false) OR
                                      COALESCE(lf.has_probate,false) OR COALESCE(lf.has_code_viol,false) OR
                                      COALESCE(lf.has_vacant,false)
                                    )
                                    THEN ${w.county_source} ELSE 0 END +
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
               -- Already engaged: pipeline_stage ∈ {lead, contract, closed}.
               -- Was marketing_result='lead' before, but that column is never
               -- populated by filtration.js (Audit #12). pipeline_stage is.
               CASE WHEN LOWER(COALESCE(p.pipeline_stage,'')) IN ('lead','contract','closed')
                    THEN ${w.marketing_lead} ELSE 0 END
             ) AS score
        FROM properties p
        LEFT JOIN list_flags lf ON lf.property_id = p.id
        LEFT JOIN primary_contact pc ON pc.property_id = p.id
       WHERE p.id IN (SELECT id FROM touched)
    )
    UPDATE properties p
       SET distress_score = s.score,
           distress_band = CASE
             WHEN s.score >= 75 THEN 'burning'
             WHEN s.score >= 55 THEN 'hot'
             WHEN s.score >= 30 THEN 'warm'
             ELSE 'cold'
           END,
           distress_scored_at = NOW(),
           distress_scoring_version = ${SCORING_VERSION}
      FROM scored s
     WHERE p.id = s.id;
  `;

  const res = await query(sql, [propertyIds]);
  return { scored: res.rowCount || 0 };
}

// ── Score many properties (batch, used by Recompute All button) ────────────
// Uses bulk SQL for performance. 41k properties done in ~2-3 seconds instead
// of 10+ minutes if we looped per-property.
async function scoreAllProperties(progressCb, tenantId) {
  // 2026-04-28 audit fix S-3: optional tenantId scopes the recompute to a
  // single tenant. Required when the per-tenant Redis lock is in play —
  // otherwise two tenants holding their own locks would each rescore the
  // whole platform, undoing the lock's safety property. Backwards-compatible:
  // callers that omit tenantId rescore all rows (used by boot-time backfill
  // and ops scripts).
  await ensureDistressSchema();
  const tenantClause = tenantId ? ' AND p.tenant_id = $1' : '';
  const params = tenantId ? [tenantId] : [];

  // Build one big CTE that aggregates signals per property, then a single
  // UPDATE that computes score from those signals using the same weights.
  // Pass 9: tax_sale regex now also matches "sheriff sale" (same weight);
  // added has_mortgage_fc flag at +20; pre_fc scores only when mortgage_fc
  // is absent (mutually exclusive, mortgage_fc wins). Matches classifyList.
  const w = WEIGHTS;
  // NB: keep list pattern matching in sync with classifyList() above
  const sql = `
    WITH list_flags AS (
      SELECT pl.property_id,
             BOOL_OR(LOWER(COALESCE(l.list_type,'') || ' ' || COALESCE(l.list_name,'')) ~ 'tax[[:space:]]*sale|sheriff[[:space:]'']*s?[[:space:]]*sale') AS has_tax_sale,
             BOOL_OR(LOWER(COALESCE(l.list_type,'') || ' ' || COALESCE(l.list_name,'')) ~ 'mortgage[[:space:]]*foreclosure|mortgage[[:space:]]*default|notice[[:space:]]*of[[:space:]]*sale') AS has_mortgage_fc,
             BOOL_OR(LOWER(COALESCE(l.list_type,'') || ' ' || COALESCE(l.list_name,'')) ~ 'tax[[:space:]]*delinq') AS has_tax_delinq,
             BOOL_OR(LOWER(COALESCE(l.list_type,'') || ' ' || COALESCE(l.list_name,'')) ~ 'pre[[:space:]-]?foreclosure|pre[[:space:]-]?fc|notice[[:space:]]*of[[:space:]]*default|nod|lis[[:space:]]*pendens|auction') AS has_pre_fc,
             BOOL_OR(LOWER(COALESCE(l.list_type,'') || ' ' || COALESCE(l.list_name,'')) ~ 'probate|deceased|estate|affidavit[[:space:]]*of[[:space:]]*death') AS has_probate,
             BOOL_OR(LOWER(COALESCE(l.list_type,'') || ' ' || COALESCE(l.list_name,'')) ~ 'code[[:space:]]*violation|municipal[[:space:]]*lien') AS has_code_viol,
             BOOL_OR(LOWER(COALESCE(l.list_type,'') || ' ' || COALESCE(l.list_name,'')) ~ 'vacant') AS has_vacant,
             BOOL_OR(LOWER(COALESCE(l.source,'')) ~ 'county') AS has_county_source,
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
               CASE WHEN lf.has_tax_sale   THEN ${w.list_tax_sale}        ELSE 0 END +
               CASE WHEN lf.has_tax_delinq AND NOT COALESCE(lf.has_tax_sale,false)
                                           THEN ${w.list_tax_delinquent}  ELSE 0 END +
               CASE WHEN lf.has_mortgage_fc THEN ${w.list_mortgage_foreclosure} ELSE 0 END +
               CASE WHEN lf.has_pre_fc AND NOT COALESCE(lf.has_mortgage_fc,false)
                                           THEN ${w.list_pre_foreclosure} ELSE 0 END +
               CASE WHEN lf.has_probate   THEN ${w.list_probate}         ELSE 0 END +
               CASE WHEN lf.has_code_viol THEN ${w.list_code_violation}  ELSE 0 END +
               CASE WHEN lf.has_vacant    THEN ${w.list_vacant}          ELSE 0 END +
               CASE WHEN lf.has_county_source AND (
                                      COALESCE(lf.has_tax_sale,false) OR COALESCE(lf.has_tax_delinq,false) OR
                                      COALESCE(lf.has_mortgage_fc,false) OR COALESCE(lf.has_pre_fc,false) OR
                                      COALESCE(lf.has_probate,false) OR COALESCE(lf.has_code_viol,false) OR
                                      COALESCE(lf.has_vacant,false)
                                    )
                                    THEN ${w.county_source} ELSE 0 END +
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
               CASE WHEN LOWER(COALESCE(p.pipeline_stage,'')) IN ('lead','contract','closed')
                    THEN ${w.marketing_lead} ELSE 0 END
             ) AS score
        FROM properties p
        LEFT JOIN list_flags lf ON lf.property_id = p.id
        LEFT JOIN primary_contact pc ON pc.property_id = p.id
       WHERE 1=1${tenantClause}
    )
    UPDATE properties p
       SET distress_score = s.score,
           distress_band = CASE
             WHEN s.score >= 75 THEN 'burning'
             WHEN s.score >= 55 THEN 'hot'
             WHEN s.score >= 30 THEN 'warm'
             ELSE 'cold'
           END,
           distress_scored_at = NOW(),
           distress_scoring_version = ${SCORING_VERSION}
      FROM scored s
     WHERE p.id = s.id${tenantClause};
  `;

  if (progressCb) progressCb({ done: 0, total: 0, phase: 'bulk_update' });
  const res = await query(sql, params);
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
  // Cap user-provided limit defensively at 250k and drop any non-integer.
  // Parameterized rather than interpolated to eliminate any injection vector.
  let lim = parseInt(limit, 10);
  if (isNaN(lim) || lim < 1) lim = 250_000;
  if (lim > 250_000) lim = 250_000;
  const idsRes = await query(`SELECT id FROM properties ORDER BY id ASC LIMIT $1`, [lim]);
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
  // Read current cached score (don't recompute — capture state at event).
  // tenant_id comes from the property row.
  const r = await query(
    `SELECT tenant_id, distress_score, distress_band, distress_breakdown
       FROM properties WHERE id = $1`,
    [propertyId]
  );
  const row = r.rows[0] || {};
  if (!row.tenant_id) return;  // property gone — nothing to log
  await query(
    `INSERT INTO distress_outcome_log
       (tenant_id, property_id, outcome_type, old_value, new_value,
        score_at_event, band_at_event, breakdown_at_event)
     VALUES ($8, $1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      propertyId, outcomeType,
      oldValue == null ? null : String(oldValue),
      newValue == null ? null : String(newValue),
      row.distress_score ?? null,
      row.distress_band  ?? null,
      row.distress_breakdown == null ? null : JSON.stringify(row.distress_breakdown),
      row.tenant_id,
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

// ── AUDIT 1: Score history of closed/contracted deals ─────────────────────
// "When you closed deals, what was their score path? Did the system catch them?"
async function getClosedDealScoreHistory() {
  await ensureDistressSchema();
  // Find properties currently in 'closed' or 'contract' stage,
  // then attach their full score history.
  const r = await query(`
    WITH closed_props AS (
      SELECT id, street, city, state_code, pipeline_stage, distress_score, distress_band, updated_at
        FROM properties
       WHERE pipeline_stage IN ('closed','contract','lead')
       ORDER BY
         CASE pipeline_stage WHEN 'closed' THEN 1 WHEN 'contract' THEN 2 WHEN 'lead' THEN 3 END,
         updated_at DESC
       LIMIT 50
    )
    SELECT cp.*,
           (SELECT json_agg(json_build_object(
              'score', dsl.score,
              'band', dsl.band,
              'logged_at', dsl.logged_at
            ) ORDER BY dsl.logged_at)
              FROM distress_score_log dsl
             WHERE dsl.property_id = cp.id
           ) AS score_history
      FROM closed_props cp
  `);
  return r.rows;
}

// ── AUDIT 2: Signal coverage report ───────────────────────────────────────
// "What % of records have each scoring input populated? Tells you where data
// gaps are silently muting the score."
async function getSignalCoverage() {
  await ensureDistressSchema();
  const r = await query(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE state_code IS NOT NULL AND state_code <> '')             AS has_state,
      COUNT(*) FILTER (WHERE equity_percent IS NOT NULL)                              AS has_equity,
      COUNT(*) FILTER (WHERE marketing_result IS NOT NULL AND marketing_result <> '') AS has_marketing,
      COUNT(*) FILTER (WHERE pipeline_stage IS NOT NULL AND pipeline_stage <> 'prospect') AS has_pipeline
    FROM properties
  `);
  // Mailing state lives on contacts (joined via property_contacts)
  const mailing = await query(`
    SELECT COUNT(DISTINCT pc.property_id) AS has_mailing_state
      FROM property_contacts pc
      JOIN contacts c ON c.id = pc.contact_id
     WHERE pc.primary_contact = true
       AND c.mailing_state IS NOT NULL
       AND c.mailing_state <> ''
  `);
  // List membership at all
  const onLists = await query(`
    SELECT COUNT(DISTINCT property_id) AS has_any_list
      FROM property_lists
  `);
  const base = r.rows[0] || {};
  return {
    total: parseInt(base.total || 0),
    has_state: parseInt(base.has_state || 0),
    has_equity: parseInt(base.has_equity || 0),
    has_marketing: parseInt(base.has_marketing || 0),
    has_pipeline: parseInt(base.has_pipeline || 0),
    has_mailing_state: parseInt(mailing.rows[0]?.has_mailing_state || 0),
    has_any_list: parseInt(onLists.rows[0]?.has_any_list || 0),
  };
}

// ── AUDIT 3: Conversion rate by band over time ────────────────────────────
// "How well does the score predict outcomes? If Burning closes more often
// than Cold, the score is working. If they're equal, weights need tuning."
async function getConversionRateByBand() {
  await ensureDistressSchema();
  // Count current pipeline state of properties grouped by their CURRENT band
  const r = await query(`
    SELECT distress_band AS band,
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE pipeline_stage = 'lead')     AS leads,
           COUNT(*) FILTER (WHERE pipeline_stage = 'contract') AS contracts,
           COUNT(*) FILTER (WHERE pipeline_stage = 'closed')   AS closed
      FROM properties
     WHERE distress_band IS NOT NULL
     GROUP BY distress_band
     ORDER BY CASE distress_band
       WHEN 'burning' THEN 1 WHEN 'hot' THEN 2 WHEN 'warm' THEN 3 WHEN 'cold' THEN 4
     END
  `);
  return r.rows.map(row => {
    const total = parseInt(row.total || 0);
    const leads = parseInt(row.leads || 0);
    const contracts = parseInt(row.contracts || 0);
    const closed = parseInt(row.closed || 0);
    const advancedAny = leads + contracts + closed;
    return {
      band: row.band,
      total,
      leads, contracts, closed,
      advanced_any: advancedAny,
      lead_rate:     total > 0 ? (leads / total) * 100 : 0,
      contract_rate: total > 0 ? (contracts / total) * 100 : 0,
      closed_rate:   total > 0 ? (closed / total) * 100 : 0,
      any_rate:      total > 0 ? (advancedAny / total) * 100 : 0,
    };
  });
}

module.exports = {
  WEIGHTS,
  SCORING_VERSION,
  BAND_COLORS,
  bandFor,
  classifyList,
  computeScore,
  ensureDistressSchema,
  scoreProperty,
  scoreProperties,
  scoreAllProperties,
  scoreAllPropertiesWithBreakdown,
  logOutcomeChange,
  getScoreDistribution,
  getConversionByBand,
  getClosedDealScoreHistory,
  getSignalCoverage,
  getConversionRateByBand,
};
