// ═══════════════════════════════════════════════════════════════════════════
// ui/pages/activity-list.js
// Ocular's Activity page. Lists recent bulk_import_jobs for this tenant
// with status, progress, results. Auto-refreshes every 2s while any job is
// pending or running, then stops polling.
// ═══════════════════════════════════════════════════════════════════════════
const { shell } = require('../layouts/shell');
const { escHTML, fmtNum } = require('../_helpers');

// Created/upload column matches records-page formatting: absolute date,
// not relative. (User request 2026-04-30.)
function fmtCreatedDate(d) {
  if (!d) return '—';
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Small file icon — sits in a soft tile next to the filename so the
// File cell reads as one self-contained card-row primary, not bare text.
const FILE_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';

function progressBar(j) {
  const total = j.total_rows || 0;
  const processed = j.processed_rows || 0;
  const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  const fillColor = j.status === 'complete' || j.status === 'completed' ? '#16A34A'
                  : j.status === 'error'    || j.status === 'failed'    ? '#DC2626'
                  : '#2563EB';
  return `
    <div class="ocu-activity-progress">
      <div class="ocu-activity-progress-track">
        <div class="ocu-activity-progress-fill" style="width:${pct}%;background:${fillColor}"></div>
      </div>
      <div class="ocu-activity-progress-label">${fmtNum(processed)} / ${fmtNum(total)} · ${pct}%</div>
    </div>`;
}

function statusBadge(s) {
  const map = {
    pending:  { label: 'Pending',  cls: 'ocu-pill ocu-pill-warn' },
    running:  { label: 'Running',  cls: 'ocu-pill ocu-pill-warn' },
    complete: { label: 'Complete', cls: 'ocu-pill ocu-pill-good' },
    completed:{ label: 'Complete', cls: 'ocu-pill ocu-pill-good' },
    error:    { label: 'Error',    cls: 'ocu-pill ocu-pill-bad'  },
    failed:   { label: 'Failed',   cls: 'ocu-pill ocu-pill-bad'  },
  };
  const m = map[s] || { label: s || '—', cls: 'ocu-pill' };
  return `<span class="${m.cls}">${escHTML(m.label)}</span>`;
}

function resultsCell(inserted, updated, errors) {
  const parts = [];
  if (inserted > 0) parts.push(`<span class="ocu-result-chip ocu-result-new">+${fmtNum(inserted)} new</span>`);
  if (updated  > 0) parts.push(`<span class="ocu-result-chip ocu-result-upd">${fmtNum(updated)} updated</span>`);
  if (errors   > 0) parts.push(`<span class="ocu-result-chip ocu-result-err">${fmtNum(errors)} errors</span>`);
  if (parts.length === 0) return '<span class="ocu-text-3" style="font-size:12px">—</span>';
  return `<div class="ocu-result-stack">${parts.join('')}</div>`;
}

function jobRow(j) {
  const inserted = j.inserted || j.rows_created || 0;
  const updated  = j.updated  || j.rows_updated || 0;
  const errors   = j.errors   || j.rows_errored || 0;
  const startedAt = j.created_at || j.started_at;

  // error_log (or error_message) on a 'complete' job is a warning; on 'error' it's a crash
  const errMsg = j.error_log || j.error_message;
  let errBlock = '';
  if (errMsg) {
    const isWarn = j.status === 'complete' || j.status === 'completed';
    const cls = isWarn ? 'ocu-pill-warn' : 'ocu-pill-bad';
    const truncated = String(errMsg).slice(0, 500) + (String(errMsg).length > 500 ? '…' : '');
    errBlock = `<div class="ocu-card" style="margin-top:6px;padding:6px 10px;font-size:11px;line-height:1.4;white-space:pre-wrap;word-break:break-word;max-width:520px"><span class="ocu-pill ${cls}" style="margin-right:6px">${isWarn ? 'Warn' : 'Error'}</span>${escHTML(truncated)}</div>`;
  }

  const listCell = j.list_name
    ? `<a href="/oculah/records?list_id=${j.list_id}" class="ocu-source-tag" style="text-decoration:none;max-width:100%;overflow:hidden;text-overflow:ellipsis">${escHTML(j.list_name)}</a>`
    : '<span class="ocu-text-3" style="font-size:12px">—</span>';

  return `<tr>
    <td class="ocu-td">
      <div class="ocu-activity-file">
        <span class="ocu-activity-file-icon" aria-hidden="true">${FILE_ICON}</span>
        <span class="ocu-activity-file-name" title="${escHTML(j.filename || '')}">${escHTML(j.filename || '—')}</span>
      </div>
      ${errBlock}
    </td>
    <td class="ocu-td">${listCell}</td>
    <td class="ocu-td">${statusBadge(j.status)}</td>
    <td class="ocu-td ocu-td-progress">${progressBar(j)}</td>
    <td class="ocu-td">${resultsCell(inserted, updated, errors)}</td>
    <td class="ocu-td ocu-td-date">${fmtCreatedDate(startedAt)}</td>
  </tr>`;
}

/**
 * @param {Object} data
 *   - user, badges
 *   - jobs: array of bulk_import_jobs rows joined with lists.list_name
 *   - hasRunning: bool — controls whether the auto-refresh script runs
 */
function activityList(data = {}) {
  const jobs = Array.isArray(data.jobs) ? data.jobs : [];
  const hasRunning = !!data.hasRunning;

  const tableHTML = jobs.length === 0
    ? `<div class="ocu-empty">
        <div style="font-size:13px;margin-bottom:6px">No import activity yet.</div>
        <a href="/import/property" class="ocu-link">Start an import →</a>
       </div>`
    : `
      <div class="ocu-table-wrap">
        <table class="ocu-table ocu-activity-table">
          <colgroup>
            <col style="width:auto" />
            <col style="width:200px" />
            <col style="width:120px" />
            <col style="width:240px" />
            <col style="width:230px" />
            <col style="width:120px" />
          </colgroup>
          <thead>
            <tr>
              <th class="ocu-th">File</th>
              <th class="ocu-th">List</th>
              <th class="ocu-th">Status</th>
              <th class="ocu-th">Progress</th>
              <th class="ocu-th">Results</th>
              <th class="ocu-th ocu-th-date">Upload date</th>
            </tr>
          </thead>
          <tbody>${jobs.map(jobRow).join('')}</tbody>
        </table>
      </div>`;

  const runningBadge = hasRunning
    ? `<span class="ocu-pill ocu-pill-warn">⟳ Import running</span>`
    : '';

  const body = `
    <div style="display:flex;justify-content:flex-end;gap:8px;align-items:center;margin-bottom:14px">
      ${runningBadge}
      <a href="/import/property" class="ocu-btn ocu-btn-primary">+ New import</a>
    </div>

    ${tableHTML}

    ${hasRunning ? `<script>
      (function () {
        var iv = setInterval(async function () {
          try {
            var r = await fetch('/oculah/activity/poll');
            var data = await r.json();
            if (!data.hasRunning) { clearInterval(iv); }
            if (data.html) { document.querySelector('.ocu-table tbody').innerHTML = data.html; }
          } catch (e) {
            console.warn('[activity] poll failed:', e && e.message);
          }
        }, 2000);
      })();
    </script>` : ''}`;

  return shell({
    title:          'Activity',
    topbarTitle:    'Activity',
    topbarSubtitle: `${fmtNum(jobs.length)} recent import job${jobs.length === 1 ? '' : 's'}`,
    activePage:     'activity',
    user:           data.user,
    badges:         data.badges || {},
    body,
  });
}

// Export jobRow + statusBadge so the polling endpoint can re-render rows
// without duplicating the markup.
module.exports = { activityList, jobRow };
