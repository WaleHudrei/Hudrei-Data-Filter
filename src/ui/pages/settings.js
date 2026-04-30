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
const { escHTML } = require('../_helpers');

// Icons — small inline SVGs, one per section. Stroke-based, currentColor.
const ICONS = {
  lock:    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  shield:  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  target:  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>',
  merge:   '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="12" r="3"/><path d="M9 6h3a3 3 0 0 1 3 3v3"/><path d="M9 18h3a3 3 0 0 0 3-3v-3"/></svg>',
  info:    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
};

// Settings card with colored icon tile + title + meta. Replaces the plain
// `card()` component so every settings section reads as one polished
// stack — matching the distress-matrix tab. Tones map a section's
// "feeling" to a color (security → blue/amber, scoring → violet, etc.).
function settingsCard({ icon = 'info', tone = 'slate', title = '', meta = '', body = '' }) {
  return `
    <div class="ocu-settings-card">
      <div class="ocu-settings-card-header">
        <div class="ocu-settings-card-icon" data-tone="${escHTML(tone)}" aria-hidden="true">${ICONS[icon] || ICONS.info}</div>
        <div class="ocu-settings-card-titles">
          ${title ? `<div class="ocu-settings-card-title">${escHTML(title)}</div>` : ''}
          ${meta ? `<div class="ocu-settings-card-meta">${escHTML(meta)}</div>` : ''}
        </div>
      </div>
      <div class="ocu-settings-card-body">${body}</div>
    </div>`;
}

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

  // All sections rendered as the same enriched card style — matches the
  // distress matrix tab. Colored icon tiles, larger titles, soft hover
  // shadow, consistent vertical rhythm via .ocu-settings-stack.
  const body = `
    <div style="max-width:780px;margin:0 auto" class="ocu-settings-stack">
      ${pwFlashHTML}
      ${settingsCard({
        icon: 'lock',  tone: 'blue',
        title: 'Change password',
        meta:  'Update your sign-in password.',
        body:  passwordForm,
      })}
      ${isAdmin ? `
        ${flashHTML}
        ${defaultBanner}
        ${settingsCard({
          icon: 'shield', tone: 'amber',
          title: 'Delete code',
          meta:  'Required for any destructive action — record deletion, list deletion, bulk merges.',
          body:  deleteCodeForm,
        })}
        ${settingsCard({
          icon: 'target', tone: 'violet',
          title: 'Distress score matrix',
          meta:  'Customize weights, band thresholds, and your own keyword-based signals.',
          body:  distressCard,
        })}
        ${settingsCard({
          icon: 'merge', tone: 'green',
          title: 'Duplicate cleanup',
          meta:  'Auto-runs on import — manual trigger for legacy data.',
          body:  dedupCard,
        })}
        ${settingsCard({
          icon: 'info', tone: 'slate',
          title: 'Recovery',
          meta:  'If you forget the delete code, an admin can reset it from the database.',
          body:  recoveryNote,
        })}
      ` : ''}
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
