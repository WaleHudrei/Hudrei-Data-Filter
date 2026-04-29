// ═══════════════════════════════════════════════════════════════════════════
// src/scoring/distress-config.js
//
// Per-tenant distress-scoring configuration. Tenants can:
//   1. Override the weight of any built-in signal (or set it to 0 to disable)
//   2. Adjust the band thresholds (cold/warm/hot/burning cutoffs)
//   3. Add custom user-defined signals — list-keyword matchers that add
//      points when a property is on a list whose name or type contains a
//      given keyword.
//
// Storage: a single row per tenant in `distress_settings` keyed by tenant_id,
// with the whole config blob stored as JSONB. Simpler than three tables and
// fast enough — config is read once per scoring call.
// ═══════════════════════════════════════════════════════════════════════════

const { query } = require('../db');

// ── Defaults (mirror the WEIGHTS object in distress.js verbatim) ──────────
const DEFAULT_WEIGHTS = Object.freeze({
  list_tax_sale:             30,
  list_tax_delinquent:       15,
  list_pre_foreclosure:      15,
  list_mortgage_foreclosure: 20,
  list_probate:              20,
  list_code_violation:       15,
  list_vacant:               15,
  stack_5_plus:              15,
  stack_3_4:                 10,
  stack_2:                    5,
  high_equity:               10,
  out_of_state:              10,
  marketing_lead:             5,
  county_source:             10,
});

// Threshold = the minimum score to enter that band. The lowest band (cold)
// has no threshold — everything below `warm` is cold.
const DEFAULT_BANDS = Object.freeze({
  warm:    30,
  hot:     55,
  burning: 75,
});

// Display labels for the built-in signals — used by the UI.
const BUILTIN_SIGNAL_LABELS = Object.freeze({
  list_tax_sale:             'On Tax Sale / Sheriff Sale list',
  list_tax_delinquent:       'On Tax Delinquent list',
  list_pre_foreclosure:      'On Pre-Foreclosure list',
  list_mortgage_foreclosure: 'On Mortgage Foreclosure list',
  list_probate:              'On Probate list',
  list_code_violation:       'On Code Violation list',
  list_vacant:               'On Vacant list',
  stack_5_plus:              'Stacked on 5+ lists',
  stack_3_4:                 'Stacked on 3–4 lists',
  stack_2:                   'Stacked on 2 lists',
  high_equity:               'High equity (≥50%)',
  out_of_state:              'Out-of-state owner',
  marketing_lead:            'Already engaged (lead/contract/closed)',
  county_source:             'County-sourced distress list',
});

let _settingsSchemaReady = false;
async function _ensureSettingsSchema() {
  if (_settingsSchemaReady) return;
  await query(`
    CREATE TABLE IF NOT EXISTS distress_settings (
      tenant_id  INT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
      config     JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  _settingsSchemaReady = true;
}

// Returns the merged config: defaults + tenant overrides. Always returns a
// fully-populated shape so callers don't have to defend against missing keys.
async function getConfig(tenantId) {
  await _ensureSettingsSchema();
  const r = await query(`SELECT config FROM distress_settings WHERE tenant_id = $1`, [tenantId]);
  const stored = r.rows.length ? (r.rows[0].config || {}) : {};
  const weights = { ...DEFAULT_WEIGHTS, ...(stored.weights || {}) };
  const bands   = { ...DEFAULT_BANDS,   ...(stored.bands   || {}) };
  const customSignals = Array.isArray(stored.custom_signals) ? stored.custom_signals : [];
  return { weights, bands, custom_signals: customSignals, _hasOverrides: r.rows.length > 0 };
}

// Validate + persist. Throws on malformed input so callers redirect with err.
async function setConfig(tenantId, raw) {
  await _ensureSettingsSchema();

  const weights = {};
  for (const key of Object.keys(DEFAULT_WEIGHTS)) {
    const v = raw && raw.weights && raw.weights[key];
    const n = parseInt(v, 10);
    weights[key] = Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : DEFAULT_WEIGHTS[key];
  }

  const bands = {};
  for (const key of Object.keys(DEFAULT_BANDS)) {
    const v = raw && raw.bands && raw.bands[key];
    const n = parseInt(v, 10);
    bands[key] = Number.isFinite(n) ? Math.max(0, Math.min(200, n)) : DEFAULT_BANDS[key];
  }
  // Bands must be monotonic: warm < hot < burning. Otherwise scoring is
  // ambiguous (a 60-point property could land in two bands at once).
  if (!(bands.warm < bands.hot && bands.hot < bands.burning)) {
    throw new Error('Band thresholds must be increasing: warm < hot < burning.');
  }

  const customSignals = [];
  const rawSignals = Array.isArray(raw && raw.custom_signals) ? raw.custom_signals : [];
  for (const s of rawSignals) {
    if (!s || typeof s !== 'object') continue;
    const label = String(s.label || '').trim().slice(0, 60);
    const matchValue = String(s.match_value || '').trim().slice(0, 80);
    const points = parseInt(s.weight, 10);
    if (!label || !matchValue || !Number.isFinite(points)) continue;
    // Only one match_type for now: list_keyword. We keep the field on the
    // record so future match types (column-based predicates, etc.) can be
    // added without a schema migration.
    customSignals.push({
      id:          s.id || ('cs_' + Math.random().toString(36).slice(2, 10)),
      label,
      match_type:  'list_keyword',
      match_value: matchValue.toLowerCase(),
      weight:      Math.max(0, Math.min(100, points)),
    });
  }

  const config = { weights, bands, custom_signals: customSignals };
  await query(`
    INSERT INTO distress_settings (tenant_id, config, updated_at)
    VALUES ($1, $2::jsonb, NOW())
    ON CONFLICT (tenant_id) DO UPDATE SET config = EXCLUDED.config, updated_at = NOW()
  `, [tenantId, JSON.stringify(config)]);
  return config;
}

async function resetConfig(tenantId) {
  await _ensureSettingsSchema();
  await query(`DELETE FROM distress_settings WHERE tenant_id = $1`, [tenantId]);
}

module.exports = {
  DEFAULT_WEIGHTS,
  DEFAULT_BANDS,
  BUILTIN_SIGNAL_LABELS,
  getConfig,
  setConfig,
  resetConfig,
};
