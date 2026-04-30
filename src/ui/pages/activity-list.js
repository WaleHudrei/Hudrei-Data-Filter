// ═══════════════════════════════════════════════════════════════════════════
// ui/pages/activity-list.js
// Ocular's Activity page. Lists recent bulk_import_jobs for this tenant
// with status, progress, results. Auto-refreshes every 2s while any job is
// pending or running, then stops polling.
// ═══════════════════════════════════════════════════════════════════════════
const { shell } = require('../layouts/shell');
const { escHTML, fmtNum, fmtRelative } = require('../_helpers');

function progressBar(j) {
  const total = j.total_rows || 0;
  const processed = j.processed_rows || 0;
  const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
  const fillColor = j.status === 'complete' ? '#1a7a4a'
                  : j.status === 'error'    ? '#c0392b'
                  : 'var(--ocu-text-1)';
  return `
    <div style="display:flex;align-items:center;gap:8px">
      <div class="ocu-progress-track" style="flex:1;min-width:80px">
        <div class="ocu-progress-fill" style="width:${pct}%;background:${fillColor}"></div>
      </div>
      <span class="ocu-text-3 ocu-mono" style="font-size:11px;white-space:nowrap">${fmtNum(processed)} / ${fmtNum(total)}</span>
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

function jobRow(j) {
  const total = j.total_rows || 0;
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

  const resultsCell = (inserted > 0 || updated > 0)
    ? `<span class="ocu-pill ocu-pill-good">+${fmtNum(inserted)}</span> new, <span class="ocu-pill ocu-pill-primary">${fmtNum(updated)}</span> updated${errors > 0 ? `, <span class="ocu-pill ocu-pill-bad">${fmtNum(errors)}</span> errors` : ''}`
    : '<span class="ocu-text-3">—</span>';

  // 2026-04-29 Tier-3 follow-up: switched raw <td> to .ocu-td so the data
  // cells line up with the .ocu-th headers below. Pre-fix every cell got
  // text-align:start while every header got browser-default text-align:center,
  // so File/List/Status/Started labels floated to the middle of their wide
  // columns while the data sat at the left edge.
  return `<tr>
    <td class="ocu-td">
      <div class="ocu-td-primary">${escHTML(j.filename || '—')}</div>
      ${errBlock}
    </td>
    <td class="ocu-td">${j.list_name ? `<a href="/oculah/records?list_id=${j.list_id}" class="ocu-link">${escHTML(j.list_name)}</a>` : '<span class="ocu-text-3">—</span>'}</td>
    <td class="ocu-td">${statusBadge(j.status)}</td>
    <td class="ocu-td" style="min-width:200px">${progressBar(j)}</td>
    <td class="ocu-td" style="font-size:12px">${resultsCell}</td>
    <td class="ocu-td ocu-td-date">${fmtRelative(startedAt)}</td>
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
        <table class="ocu-table">
          <thead>
            <tr>
              <th class="ocu-th">File</th>
              <th class="ocu-th">List</th>
              <th class="ocu-th">Status</th>
              <th class="ocu-th">Progress</th>
              <th class="ocu-th">Results</th>
              <th class="ocu-th ocu-th-date">Upload Date</th>
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
