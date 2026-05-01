// ═══════════════════════════════════════════════════════════════════════════
// ui/pages/dashboard.js
// The Ocular dashboard. Takes data fetched by the route handler and renders
// a complete page using the shell + components.
// ═══════════════════════════════════════════════════════════════════════════
const { shell }          = require('../layouts/shell');
const { kpiCard }        = require('../components/kpi-card');
const { card }           = require('../components/card');
const { distressRings }  = require('../components/distress-rings');
const { activityFeed }   = require('../components/activity-feed');
const { topLists }       = require('../components/top-lists');
const { escHTML, fmtNum } = require('../_helpers');

/**
 * Render the dashboard page.
 *
 * @param {Object} data — everything the page needs:
 *   - kpis: { totalRecords, totalOwners, leadCount, withPhones, multiOwners, activeLists, recordsThisWeek, ownersThisWeek, leadDeltaPct, listsOverdue }
 *   - distress: { burning, hot, warm, cold }
 *   - listRegistry: { overdue, dueWeek, total }
 *   - topListsItems: [{ name, count }]
 *   - activity: [{ dot, html, time }]
 *   - user: { name, role, initials }
 *   - lastUpdatedAt: Date
 */
function dashboard(data = {}) {
  const k = data.kpis || {};
  const d = data.distress || {};
  const r = data.listRegistry || {};

  // ─── KPI row ──────────────────────────────────────────────────────────
  const kpiRow = `
    <div class="ocu-kpi-row">
      ${kpiCard({
        label: 'Total records',
        value: k.totalRecords || 0,
        delta: k.recordsThisWeek != null
          ? { direction: 'up', num: fmtNum(k.recordsThisWeek), label: 'this week' }
          : null,
        featured: true,
      })}
      ${kpiCard({
        label: 'Total owners',
        value: k.totalOwners || 0,
        delta: k.ownersThisWeek != null
          ? { direction: 'up', num: fmtNum(k.ownersThisWeek), label: 'this week' }
          : null,
      })}
      ${kpiCard({
        label: 'Lead count',
        value: k.leadCount || 0,
        delta: k.leadDeltaPct != null
          ? { direction: k.leadDeltaPct >= 0 ? 'up' : 'down', label: Math.abs(k.leadDeltaPct) + '% from last week' }
          : null,
      })}
      ${kpiCard({
        label: 'With phones',
        value: k.withPhones || 0,
        delta: k.phoneCoveragePct != null
          ? { direction: 'neutral', label: k.phoneCoveragePct + '% coverage' }
          : null,
      })}
      ${kpiCard({
        label: 'Multi-property owners',
        value: k.multiOwners || 0,
        delta: k.multiOwnersPct != null
          ? { direction: 'neutral', label: k.multiOwnersPct + '% of total' }
          : null,
      })}
      ${kpiCard({
        label: 'Active lists',
        value: k.activeLists || 0,
        delta: k.listsOverdue
          ? { direction: 'down', label: k.listsOverdue + ' overdue' }
          : null,
      })}
    </div>`;

  // ─── Distress + List Registry row ─────────────────────────────────────
  const distressBody = distressRings({
    burning: d.burning, hot: d.hot, warm: d.warm, cold: d.cold,
  });
  const distressCard = card({
    title: 'Distress score distribution',
    meta: fmtNum((d.burning||0)+(d.hot||0)+(d.warm||0)+(d.cold||0)) + ' properties scored',
    link: { href: '/records/_distress', label: 'Recompute →' },
    body: distressBody,
  });

  // Surface "what's next" — a counts-only widget gives no urgency signal
  // when everything is on schedule, so pin the next-upcoming list with
  // its due date inline. Falls back to the alert banner if there's
  // anything actually overdue.
  const nextPull = r.nextPull;
  const nextPullDateStr = nextPull && nextPull.dueDate
    ? new Date(nextPull.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : '';
  const isPast = nextPull && nextPull.dueDate && new Date(nextPull.dueDate) < new Date();

  const registryBody = `
    <div class="ocu-mini-stats">
      <div class="ocu-mini-stat alert">
        <div class="num">${fmtNum(r.overdue || 0)}</div>
        <div class="lbl">Overdue</div>
      </div>
      <div class="ocu-mini-stat warn">
        <div class="num">${fmtNum(r.dueWeek || 0)}</div>
        <div class="lbl">Due this week</div>
      </div>
      <div class="ocu-mini-stat">
        <div class="num">${fmtNum(r.total || 0)}</div>
        <div class="lbl">Total lists</div>
      </div>
    </div>
    ${(r.overdue || 0) > 0 ? `
      <div class="ocu-alert">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
          <line x1="12" y1="9" x2="12" y2="13"/>
          <line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
        <span>${r.overdue} list${r.overdue === 1 ? '' : 's'} overdue for a pull</span>
      </div>`
    : nextPull ? `
      <div class="ocu-next-pull">
        <span class="ocu-next-pull-label">Next:</span>
        <span class="ocu-next-pull-name">${escHTML(nextPull.listName || 'Unnamed list')}${nextPull.stateCode ? ` · ${escHTML(nextPull.stateCode)}` : ''}</span>
        <span class="ocu-next-pull-date${isPast ? ' is-overdue' : ''}">due ${escHTML(nextPullDateStr)}</span>
      </div>` : ''}`;

  const registryCard = card({
    title: 'List registry',
    meta: 'Pull cadence overview',
    link: { href: '/lists/types', label: 'View all →' },
    body: registryBody,
  });

  // ─── Top lists + Activity row ─────────────────────────────────────────
  const topListsCard = card({
    title: 'Top lists by volume',
    meta: 'All time',
    link: { href: '/lists', label: 'All lists →' },
    body: topLists(data.topListsItems || []),
  });

  // Activity card meta surfaces the day's total count alongside the
  // window label — answers "is there more activity I should know about?"
  // without forcing a click into /activity.
  const todayCount = Number(data.activityTodayCount || 0);
  const activityMeta = todayCount > 0
    ? `Last 24 hours · <strong>${fmtNum(todayCount)}</strong> total today`
    : 'Last 24 hours';
  const activityCard = card({
    title: 'Recent activity',
    metaHTML: activityMeta,
    link: { href: '/activity', label: 'View all →' },
    body: activityFeed(data.activity || []),
  });

  // ─── Page body ────────────────────────────────────────────────────────
  // 2026-04-30: removed the "Last updated 0s ago" / "Live" indicator and
  // its surrounding row. The polling logic (every-30s refresh) still runs;
  // the visible indicator was just visual noise in a band that pushed the
  // KPI strip down. Body now starts directly with the KPI row.
  const body = `

    ${kpiRow}

    <div class="ocu-grid ocu-grid-2-1">
      ${distressCard}
      ${registryCard}
    </div>

    <div class="ocu-grid ocu-grid-1-1">
      ${topListsCard}
      ${activityCard}
    </div>
  `;

  const { dashboardSwitcher } = require('../components/dashboard-switcher');
  return shell({
    title: 'Main Dashboard',
    topbarTitleHTML: dashboardSwitcher({ active: 'main', defaultView: data.defaultView || 'main' }),
    topbarSubtitle: 'Overview of your operations across all markets',
    body,
    activePage: 'dashboard',
    user: data.user || { name: 'User', role: '', initials: '?' },
    badges: {
      'records-count':  fmtNum(k.totalRecords || 0),
      'overdue-count':  r.overdue ? String(r.overdue) : '',
    },
    extraHead: '<script src="/oculah-static/dashboard-switcher.js?v=1" defer></script>',
  });
}

module.exports = { dashboard };
