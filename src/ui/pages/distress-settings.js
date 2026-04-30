// ═══════════════════════════════════════════════════════════════════════════
// ui/pages/distress-settings.js
// Per-tenant distress-matrix editor. Three sections:
//   1. Built-in signal weights (14 rows of label + number input)
//   2. Band thresholds (warm / hot / burning)
//   3. Custom signals (repeater: label + keyword + points)
//
// Save posts to /oculah/setup/distress; Reset to /oculah/setup/distress/reset.
// ═══════════════════════════════════════════════════════════════════════════
const { shell } = require('../layouts/shell');
const { card } = require('../components/card');
const { escHTML } = require('../_helpers');
const {
  DEFAULT_WEIGHTS, DEFAULT_BANDS, BUILTIN_SIGNAL_LABELS,
} = require('../../scoring/distress-config');

function distressSettingsPage(data = {}) {
  const cfg = data.config || { weights: DEFAULT_WEIGHTS, bands: DEFAULT_BANDS, custom_signals: [], _hasOverrides: false };
  const flash = data.flash || {};

  const flashHTML = flash.msg
    ? `<div class="ocu-card" style="margin-bottom:16px;background:#e8f5ee;border-color:#9bd0a8;color:#1a5f1a;padding:12px 16px;font-size:13px">${escHTML(flash.msg)}</div>`
    : flash.err
    ? `<div class="ocu-card" style="margin-bottom:16px;background:#fdeaea;border-color:#f5c5c5;color:#8b1f1f;padding:12px 16px;font-size:13px">${escHTML(flash.err)}</div>`
    : '';

  // Built-in weight rows. Each is one input named weights[<key>].
  const builtinRows = Object.keys(DEFAULT_WEIGHTS).map(key => {
    const label   = BUILTIN_SIGNAL_LABELS[key] || key;
    const current = cfg.weights[key];
    const def     = DEFAULT_WEIGHTS[key];
    const isCustomized = current !== def;
    return `
      <div class="ocu-distress-row">
        <div class="ocu-distress-row-label">
          ${escHTML(label)}
          ${isCustomized ? `<span class="ocu-pill ocu-pill-warn" style="margin-left:8px;font-size:10px">customized · default ${def}</span>` : ''}
        </div>
        <div class="ocu-distress-row-input">
          <input type="number" name="weights[${escHTML(key)}]" value="${current}" min="0" max="100" class="ocu-input" style="width:90px" />
          <span class="ocu-text-3" style="font-size:12px">pts</span>
        </div>
      </div>`;
  }).join('');

  // Bands table
  const bandsHTML = ['warm', 'hot', 'burning'].map(b => `
    <div class="ocu-distress-row">
      <div class="ocu-distress-row-label">
        <strong style="color:var(--ocu-text-1);text-transform:capitalize">${b}</strong>
        <span class="ocu-text-3" style="margin-left:6px;font-size:12px">≥</span>
      </div>
      <div class="ocu-distress-row-input">
        <input type="number" name="bands[${b}]" value="${cfg.bands[b]}" min="0" max="200" class="ocu-input" style="width:90px" />
        <span class="ocu-text-3" style="font-size:12px">pts</span>
      </div>
    </div>`).join('');

  // Custom signal rows. Rendered with a hidden template that JS clones for
  // "+ Add custom signal".
  const customRowsHTML = cfg.custom_signals.map((s, i) => `
    <div class="ocu-custom-signal-row" data-row-index="${i}">
      <input type="hidden" name="custom_signals[${i}][id]" value="${escHTML(s.id)}" />
      <div>
        <label class="ocu-form-label">Label</label>
        <input type="text" name="custom_signals[${i}][label]" value="${escHTML(s.label)}" maxlength="60" required class="ocu-input" placeholder="e.g. Auction-bound" />
      </div>
      <div>
        <label class="ocu-form-label">Match keyword in list name/type</label>
        <input type="text" name="custom_signals[${i}][match_value]" value="${escHTML(s.match_value)}" maxlength="80" required class="ocu-input" placeholder="e.g. auction" />
      </div>
      <div>
        <label class="ocu-form-label">Points</label>
        <input type="number" name="custom_signals[${i}][weight]" value="${s.weight}" min="0" max="100" required class="ocu-input" style="width:90px" />
      </div>
      <button type="button" class="ocu-btn ocu-btn-ghost ocu-custom-signal-remove" title="Remove">×</button>
    </div>`).join('');

  const customHelp = `
    <div class="ocu-text-3" style="font-size:12px;line-height:1.5;margin-bottom:14px">
      Custom signals add points when a property is on a list whose name OR type contains your keyword (case-insensitive). Use them to weight any list pattern your team cares about — auction listings, county-specific feeds, internal tags, etc.
    </div>`;

  const overridesBanner = cfg._hasOverrides
    ? `<div class="ocu-card" style="margin-bottom:16px;background:#eef9f1;border-color:#c5e8d4;color:#1a5f1a;padding:10px 14px;font-size:13px">
        Using your custom matrix. <a href="/oculah/setup/distress/reset" class="ocu-link" onclick="return confirm('Reset all weights, bands, and custom signals to defaults?')">Reset to defaults →</a>
      </div>`
    : `<div class="ocu-card" style="margin-bottom:16px;background:#f5f4f0;border-color:#e0dfd8;color:var(--ocu-text-2);padding:10px 14px;font-size:13px">
        Currently using the built-in defaults. Customize any weight, band, or add a custom signal below.
      </div>`;

  const recomputeNote = `
    <div class="ocu-text-3" style="font-size:12px;line-height:1.5;margin-top:14px">
      Saving updates the matrix immediately, but existing scores are not recomputed automatically — go to <a href="/records/_distress" class="ocu-link">Records → Recompute</a> to rescore your data with the new rules.
    </div>`;

  const body = `
    <div class="ocu-page-header">
      <div>
        <div style="margin-bottom:6px"><a href="/oculah/setup" class="ocu-text-3" style="font-size:13px;text-decoration:none">← Settings</a></div>
        <h1 class="ocu-page-title">Distress score matrix</h1>
        <div class="ocu-page-subtitle">Tune how Oculah ranks your leads. Per-workspace.</div>
      </div>
    </div>

    <div style="max-width:780px">
      ${flashHTML}
      ${overridesBanner}

      <form method="POST" action="/oculah/setup/distress" id="distress-form">
        ${card({
          title: 'Built-in signals',
          meta:  'Adjust how strongly each pre-defined signal weighs. Set to 0 to disable.',
          body:  `<div class="ocu-distress-grid">${builtinRows}</div>`,
        })}
        <div style="margin-top:16px">
          ${card({
            title: 'Band thresholds',
            meta:  'Minimum score to enter each band. Must be increasing.',
            body:  `<div class="ocu-distress-grid">${bandsHTML}</div>`,
          })}
        </div>
        <div style="margin-top:16px">
          ${card({
            title: 'Custom signals',
            meta:  'Your own list-keyword rules.',
            body:  `${customHelp}
              <div id="custom-signals-list">${customRowsHTML}</div>
              <button type="button" class="ocu-btn ocu-btn-secondary" id="add-custom-signal-btn" style="margin-top:8px">+ Add custom signal</button>`,
          })}
        </div>

        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:18px">
          <a href="/oculah/setup" class="ocu-btn ocu-btn-ghost">Cancel</a>
          <button type="submit" class="ocu-btn ocu-btn-primary">Save matrix</button>
        </div>
        ${recomputeNote}
      </form>
    </div>

    <script>
      (function () {
        var listEl = document.getElementById('custom-signals-list');
        var addBtn = document.getElementById('add-custom-signal-btn');

        function rowHtml(idx) {
          var prefix = 'custom_signals[' + idx + ']';
          return '<div class="ocu-custom-signal-row" data-row-index="' + idx + '">'
               +   '<input type="hidden" name="' + prefix + '[id]" value="cs_' + Math.random().toString(36).slice(2,10) + '" />'
               +   '<div><label class="ocu-form-label">Label</label>'
               +     '<input type="text" name="' + prefix + '[label]" maxlength="60" required class="ocu-input" placeholder="e.g. Auction-bound" /></div>'
               +   '<div><label class="ocu-form-label">Match keyword in list name/type</label>'
               +     '<input type="text" name="' + prefix + '[match_value]" maxlength="80" required class="ocu-input" placeholder="e.g. auction" /></div>'
               +   '<div><label class="ocu-form-label">Points</label>'
               +     '<input type="number" name="' + prefix + '[weight]" min="0" max="100" required class="ocu-input" style="width:90px" value="10" /></div>'
               +   '<button type="button" class="ocu-btn ocu-btn-ghost ocu-custom-signal-remove" title="Remove">×</button>'
               + '</div>';
        }

        function nextIndex() {
          var rows = listEl.querySelectorAll('.ocu-custom-signal-row');
          return rows.length;
        }

        addBtn.addEventListener('click', function() {
          var idx = nextIndex();
          listEl.insertAdjacentHTML('beforeend', rowHtml(idx));
        });

        listEl.addEventListener('click', function(e) {
          var btn = e.target.closest('.ocu-custom-signal-remove');
          if (!btn) return;
          var row = btn.closest('.ocu-custom-signal-row');
          if (row) row.remove();
          // Note: we don't renumber inputs after remove — the server-side
          // parser groups by ANY index so gaps don't matter.
        });
      })();
    </script>`;

  return shell({
    title:      'Distress matrix',
    activePage: 'settings',
    user:       data.user,
    badges:     data.badges || {},
    body,
  });
}

module.exports = { distressSettingsPage };
