// ═══════════════════════════════════════════════════════════════════════════
// ui/pages/settings.js
// The Ocular settings page. Currently just exposes the delete-code change
// form (the only setting Loki has). Extend with new sections as features
// land — each gets its own card.
//
// Form posts to /oculah/setup/delete-code (handler in ocular-routes.js)
// which delegates to the shared settings.updateDeleteCode helper.
// ═══════════════════════════════════════════════════════════════════════════
const { shell } = require('../layouts/shell');
const { card }  = require('../components/card');
const { escHTML } = require('../_helpers');

/**
 * @param {Object} data
 *   - user: { name, role, initials } — sidebar
 *   - badges: { 'records-count'?, 'overdue-count'? }
 *   - lastUpdatedAt: Date|null — when the delete code was last changed
 *   - usingDefault: boolean — true if delete code is still 'HudREI2026'
 *   - userEmail: string — current signed-in email (display only)
 *   - flash: { msg?, err?, pwMsg?, pwErr? } — from query string after redirect
 */
function settingsPage(data = {}) {
  const isAdmin = data.user && (data.user.roleKey === 'tenant_admin' || data.user.roleKey === 'super_admin');
  const lastUpdated = data.lastUpdatedAt
    ? new Date(data.lastUpdatedAt).toLocaleString('en-US', {
        year:'numeric', month:'short', day:'numeric',
        hour:'numeric', minute:'2-digit',
      })
    : 'Never';

  const flash = data.flash || {};
  const flashHTML = flash.msg
    ? `<div class="ocu-card" style="margin-bottom:16px;background:#e8f5ee;border-color:#9bd0a8;color:#1a5f1a;padding:12px 16px;font-size:13px">${escHTML(flash.msg)}</div>`
    : flash.err
    ? `<div class="ocu-card" style="margin-bottom:16px;background:#fdeaea;border-color:#f5c5c5;color:#8b1f1f;padding:12px 16px;font-size:13px">${escHTML(flash.err)}</div>`
    : '';
  const pwFlashHTML = flash.pwMsg
    ? `<div class="ocu-card" style="margin-bottom:16px;background:#e8f5ee;border-color:#9bd0a8;color:#1a5f1a;padding:12px 16px;font-size:13px">${escHTML(flash.pwMsg)}</div>`
    : flash.pwErr
    ? `<div class="ocu-card" style="margin-bottom:16px;background:#fdeaea;border-color:#f5c5c5;color:#8b1f1f;padding:12px 16px;font-size:13px">${escHTML(flash.pwErr)}</div>`
    : '';

  const defaultBanner = data.usingDefault
    ? `<div class="ocu-card" style="margin-bottom:16px;background:#fff8e1;border-color:#e8cf87;padding:12px 16px;color:#6a4a00;font-size:13px;display:flex;align-items:center;gap:10px">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <div><strong>Delete code still using the default.</strong> Anyone with the default code can delete records in bulk. Change it below.</div>
      </div>`
    : '';

  const deleteCodeForm = `
    <div style="font-size:13px;color:var(--ocu-text-2);line-height:1.6;margin-bottom:16px">
      The delete code is required for destructive operations: deleting property records,
      bulk-merging 10+ duplicate groups, deleting a list, and removing properties from a list.
      One code, shared across every destructive action.
    </div>
    <div style="font-size:12px;color:var(--ocu-text-2);margin-bottom:16px">
      <span style="color:var(--ocu-text-3)">Last changed:</span>
      <span style="color:var(--ocu-text-1);font-weight:500;margin-left:6px">${escHTML(lastUpdated)}</span>
    </div>

    <form method="POST" action="/oculah/setup/delete-code" autocomplete="off" style="display:flex;flex-direction:column;gap:14px">
      <div>
        <label class="ocu-form-label">Current code</label>
        <input type="password" name="old_code" required autocomplete="current-password" class="ocu-input" />
      </div>
      <div>
        <label class="ocu-form-label">New code <span style="color:var(--ocu-text-3);font-weight:400">(at least 6 characters)</span></label>
        <input type="password" name="new_code" required minlength="6" autocomplete="new-password" class="ocu-input" />
      </div>
      <div>
        <label class="ocu-form-label">Confirm new code</label>
        <input type="password" name="confirm_code" required minlength="6" autocomplete="new-password" class="ocu-input" />
      </div>
      <div style="display:flex;justify-content:flex-end;margin-top:4px">
        <button type="submit" class="ocu-btn ocu-btn-primary">Update delete code</button>
      </div>
    </form>`;

  const passwordForm = `
    <div style="font-size:13px;color:var(--ocu-text-2);line-height:1.6;margin-bottom:16px">
      Signed in as <strong style="color:var(--ocu-text-1)">${escHTML(data.userEmail || 'you')}</strong>.
      Choose a new password — at least 8 characters. We'll send you an email confirmation when it changes.
    </div>
    <form method="POST" action="/oculah/setup/password" autocomplete="off" style="display:flex;flex-direction:column;gap:14px">
      <div>
        <label class="ocu-form-label">Current password</label>
        <input type="password" name="current_password" required autocomplete="current-password" class="ocu-input" />
      </div>
      <div>
        <label class="ocu-form-label">New password <span style="color:var(--ocu-text-3);font-weight:400">(at least 8 characters)</span></label>
        <input type="password" name="new_password" required minlength="8" maxlength="200" autocomplete="new-password" class="ocu-input" />
      </div>
      <div>
        <label class="ocu-form-label">Confirm new password</label>
        <input type="password" name="confirm_password" required minlength="8" maxlength="200" autocomplete="new-password" class="ocu-input" />
      </div>
      <div style="display:flex;justify-content:flex-end;margin-top:4px">
        <button type="submit" class="ocu-btn ocu-btn-primary">Update password</button>
      </div>
    </form>`;

  const distressCard = `
    <div style="font-size:13px;color:var(--ocu-text-2);line-height:1.6;margin-bottom:16px">
      Tune how Oculah ranks your leads. Adjust the weight of each built-in signal, change the band thresholds (cold/warm/hot/burning), or add your own keyword-based signals to match list patterns specific to your team.
    </div>
    <div style="display:flex;justify-content:flex-end">
      <a href="/oculah/setup/distress" class="ocu-btn ocu-btn-primary">Open distress matrix →</a>
    </div>`;

  const dedupCard = `
    <div style="font-size:13px;color:var(--ocu-text-2);line-height:1.6;margin-bottom:16px">
      Find contacts that share a phone number and merge them. Auto-runs after every bulk import — use this button to clean up duplicates that pre-date the auto-merge or accumulated from manual edits.
      Merging keeps the oldest contact record and re-homes property links, phones, tags, and call history onto it.
    </div>
    <form method="POST" action="/oculah/setup/dedup">
      <button type="submit" class="ocu-btn ocu-btn-primary">Run duplicate cleanup</button>
    </form>`;

  const recoveryNote = `
    <div style="font-size:13px;color:var(--ocu-text-2);line-height:1.6">
      <strong style="color:var(--ocu-text-1)">If you forget this code,</strong> an admin with database access
      can reset it directly. Each tenant has its own row in <code style="background:var(--ocu-bg-2);padding:2px 6px;border-radius:4px;font-size:12px;font-family:'JetBrains Mono',ui-monospace,monospace">app_settings</code>
      keyed by <code style="background:var(--ocu-bg-2);padding:2px 6px;border-radius:4px;font-size:12px;font-family:'JetBrains Mono',ui-monospace,monospace">(tenant_id, key)</code>.
    </div>`;

  const body = `
    <div style="max-width:680px">
      ${pwFlashHTML}
      ${card({
        title: 'Change password',
        meta:  'Update your sign-in password',
        body:  passwordForm,
      })}
      ${isAdmin ? `
      <div style="margin-top:16px">
        ${flashHTML}
        ${defaultBanner}
        ${card({
          title: 'Delete code',
          meta:  'Required for any destructive action',
          body:  deleteCodeForm,
        })}
      </div>
      <div style="margin-top:16px">
        ${card({
          title: 'Distress score matrix',
          meta:  'Customize weights, bands, and signals',
          body:  distressCard,
        })}
      </div>
      <div style="margin-top:16px">
        ${card({
          title: 'Duplicate cleanup',
          meta:  'Auto-runs on import — manual trigger for legacy data',
          body:  dedupCard,
        })}
      </div>
      <div style="margin-top:16px">
        ${card({
          title: 'Recovery',
          body:  recoveryNote,
        })}
      </div>` : ''}
    </div>`;

  return shell({
    title:          'Settings',
    topbarTitle:    'Settings',
    topbarSubtitle: 'Manage security and workspace preferences',
    activePage:     'settings',
    user:           data.user,
    badges:         data.badges || {},
    body,
  });
}

module.exports = { settingsPage };
