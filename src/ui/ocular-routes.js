// ═══════════════════════════════════════════════════════════════════════════
// ui/ocular-routes.js
// Routes for the new Ocular UI. Mounted at /ocular/* so the existing
// Loki UI keeps working while we migrate one page at a time.
//
// This file is a thin orchestration layer:
//   - Fetches the data each Ocular page needs (mostly reuses queries that
//     already exist in server.js / records-routes.js)
//   - Passes that data to the page renderer in ui/pages/
//   - Returns the HTML
//
// No business logic lives here. No SQL more complex than already exists.
// If a page needs new data, add the query to a service module — not here.
// ═══════════════════════════════════════════════════════════════════════════
const express = require('express');
const router  = express.Router();
const { query } = require('../db');
const { dashboard } = require('./pages/dashboard');

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.redirect('/login');
}

// Note: Ocular CSS is served from server.js at /ocular-static/ocular.css
// (mounted there to avoid double-mount complexity here).

// ─── /ocular/dashboard ─────────────────────────────────────────────────────
router.get('/dashboard', requireAuth, async (req, res) => {
  try {
    // Fetch all the data the dashboard needs in parallel.
    // Each query is simple enough to run from this handler; we'll extract
    // them into a dashboard-stats service if it grows.
    const [
      totalRecordsRes,
      totalOwnersRes,
      withPhonesRes,
      multiOwnersRes,
      thisWeekRes,
      distressRes,
      activeListsRes,
      registryRes,
      topListsRes,
    ] = await Promise.all([
      query(`SELECT COUNT(*)::int AS n FROM properties`),
      query(`SELECT COUNT(DISTINCT contact_id)::int AS n FROM property_contacts WHERE primary_contact = true`),
      query(`SELECT COUNT(DISTINCT pc.property_id)::int AS n
               FROM property_contacts pc
               JOIN phones ph ON ph.contact_id = pc.contact_id
              WHERE pc.primary_contact = true`),
      query(`SELECT COUNT(*)::int AS n FROM (
               SELECT contact_id FROM property_contacts
                WHERE primary_contact = true
                GROUP BY contact_id HAVING COUNT(*) > 1
             ) t`),
      query(`SELECT COUNT(*)::int AS n FROM properties WHERE created_at > NOW() - INTERVAL '7 days'`),
      query(`
        SELECT
          COUNT(*) FILTER (WHERE distress_band = 'burning')::int AS burning,
          COUNT(*) FILTER (WHERE distress_band = 'hot')::int     AS hot,
          COUNT(*) FILTER (WHERE distress_band = 'warm')::int    AS warm,
          COUNT(*) FILTER (WHERE distress_band = 'cold')::int    AS cold
        FROM properties`),
      query(`SELECT COUNT(*)::int AS n FROM lists`),
      // List registry — count active templates and overdue ones.
      // Wrapped in try/catch upstream because the table may not exist yet
      // on a brand-new deploy.
      query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (
            WHERE action = 'pull'
              AND last_pull_date IS NOT NULL
              AND frequency_days IS NOT NULL
              AND last_pull_date + (frequency_days || ' days')::interval < NOW()
          )::int AS overdue,
          COUNT(*) FILTER (
            WHERE action = 'pull'
              AND last_pull_date IS NOT NULL
              AND frequency_days IS NOT NULL
              AND last_pull_date + (frequency_days || ' days')::interval >= NOW()
              AND last_pull_date + (frequency_days || ' days')::interval < NOW() + INTERVAL '7 days'
          )::int AS due_week
        FROM list_templates
      `).catch(() => ({ rows: [{ total: 0, overdue: 0, due_week: 0 }] })),
      query(`
        SELECT l.list_name AS name, COUNT(pl.property_id)::int AS count
          FROM lists l
          LEFT JOIN property_lists pl ON pl.list_id = l.id
          GROUP BY l.id, l.list_name
          ORDER BY count DESC
          LIMIT 5`),
    ]);

    const totalRecords = totalRecordsRes.rows[0]?.n || 0;
    const totalOwners  = totalOwnersRes.rows[0]?.n || 0;
    const withPhones   = withPhonesRes.rows[0]?.n || 0;
    const multiOwners  = multiOwnersRes.rows[0]?.n || 0;
    const thisWeek     = thisWeekRes.rows[0]?.n || 0;
    const distress     = distressRes.rows[0] || { burning: 0, hot: 0, warm: 0, cold: 0 };
    const activeLists  = activeListsRes.rows[0]?.n || 0;
    const reg          = registryRes.rows[0] || { total: 0, overdue: 0, due_week: 0 };

    const phoneCoveragePct = totalRecords > 0 ? Math.round((withPhones / totalRecords) * 100) : 0;
    const multiOwnersPct   = totalOwners  > 0 ? +(multiOwners / totalOwners * 100).toFixed(1) : 0;

    // Activity feed — for now, derive recent rows from properties + import jobs.
    // Will be replaced with a proper activity log later.
    const recentImportsRes = await query(`
      SELECT 'import' AS kind, total_rows::int AS n, filename, created_at
        FROM bulk_import_jobs
       WHERE status = 'completed'
       ORDER BY created_at DESC
       LIMIT 3
    `).catch(() => ({ rows: [] }));

    const activity = recentImportsRes.rows.map(row => ({
      dot: 'success',
      html: `Imported <span class="actor">${row.n.toLocaleString()} records</span> from ${escapeHTML(row.filename || 'CSV')}`,
      time: fmtTimeAgo(row.created_at),
    }));

    // Pad with a synthetic entry if there's nothing else
    if (activity.length === 0) {
      activity.push({
        dot: 'accent',
        html: 'Welcome to Ocular. Import a CSV to get started.',
        time: 'now',
      });
    }

    // User from session (currently single-user — see getUser helper below)
    const user = getUser(req);

    res.send(dashboard({
      kpis: {
        totalRecords,
        totalOwners,
        burningLeads: distress.burning,
        withPhones,
        multiOwners,
        activeLists,
        recordsThisWeek: thisWeek,
        ownersThisWeek: null, // TODO: not currently tracked
        burningDeltaPct: null, // TODO: needs week-over-week table
        phoneCoveragePct,
        multiOwnersPct,
        listsOverdue: reg.overdue,
      },
      distress: {
        burning: distress.burning,
        hot: distress.hot,
        warm: distress.warm,
        cold: distress.cold,
      },
      listRegistry: {
        overdue: reg.overdue,
        dueWeek: reg.due_week,
        total: reg.total,
      },
      topListsItems: topListsRes.rows,
      activity,
      user,
      lastUpdatedAt: new Date(),
    }));
  } catch (e) {
    console.error('[ocular/dashboard]', e);
    res.status(500).send('Error loading Ocular dashboard: ' + e.message);
  }
});

// ─── /ocular/records/:id — Property detail page ───────────────────────────
// Read-only view in Ocular. Edit/delete still use old Loki routes via
// "Edit in Loki" button on the page header. Mounted BEFORE the /records
// placeholder so the more-specific :id route wins.
router.get('/records/:id(\\d+)', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { propertyDetail } = require('./pages/property-detail');

    // Property
    const propRes = await query(`SELECT * FROM properties WHERE id = $1`, [id]);
    if (!propRes.rows.length) {
      return res.status(404).send('Property not found');
    }
    const p = propRes.rows[0];

    // Contacts (Owner 1 + any Owner 2+)
    const contactRes = await query(`
      SELECT c.*, pc.role, pc.primary_contact
        FROM contacts c
        JOIN property_contacts pc ON pc.contact_id = c.id
       WHERE pc.property_id = $1
       ORDER BY pc.primary_contact DESC, c.id ASC
    `, [id]);
    const primaryContact   = contactRes.rows.find(r => r.primary_contact) || null;
    const secondaryContacts = contactRes.rows.filter(r => !r.primary_contact);

    // Phones for the primary contact, with phone_tags attached
    let phones = [];
    if (primaryContact) {
      const phoneRes = await query(
        `SELECT * FROM phones WHERE contact_id = $1 ORDER BY phone_index ASC`,
        [primaryContact.id]
      );
      phones = phoneRes.rows;
      if (phones.length) {
        const phoneIds = phones.map(ph => ph.id);
        const ptRes = await query(`
          SELECT ptl.phone_id, pt.id, pt.name, pt.color
            FROM phone_tag_links ptl
            JOIN phone_tags pt ON pt.id = ptl.phone_tag_id
           WHERE ptl.phone_id = ANY($1::int[])
           ORDER BY pt.name ASC
        `, [phoneIds]).catch(() => ({ rows: [] }));
        const tagsByPhone = {};
        for (const r of ptRes.rows) {
          if (!tagsByPhone[r.phone_id]) tagsByPhone[r.phone_id] = [];
          tagsByPhone[r.phone_id].push({ id: r.id, name: r.name, color: r.color });
        }
        for (const ph of phones) ph.tags = tagsByPhone[ph.id] || [];
      }
    }

    // Phones for each secondary contact (Owner 2+)
    for (const sc of secondaryContacts) {
      const scPhoneRes = await query(
        `SELECT * FROM phones WHERE contact_id = $1 ORDER BY phone_index ASC`,
        [sc.id]
      );
      sc.phones = scPhoneRes.rows;
    }

    // Lists membership
    const listsRes = await query(`
      SELECT l.list_name, l.list_type, l.source, pl.added_at
        FROM property_lists pl
        JOIN lists l ON l.id = pl.list_id
       WHERE pl.property_id = $1
       ORDER BY pl.added_at DESC
    `, [id]).catch(() => ({ rows: [] }));

    // Property tags
    const tagsRes = await query(`
      SELECT t.id, t.name, t.color
        FROM property_tags pt
        JOIN tags t ON t.id = pt.tag_id
       WHERE pt.property_id = $1
       ORDER BY t.name ASC
    `, [id]).catch(() => ({ rows: [] }));

    // Distress breakdown — already stored as JSON on the property row
    let distressBreakdown = p.distress_breakdown;
    if (typeof distressBreakdown === 'string') {
      try { distressBreakdown = JSON.parse(distressBreakdown); }
      catch { distressBreakdown = []; }
    }
    if (!Array.isArray(distressBreakdown)) distressBreakdown = [];

    // Campaign activity (calls + sms, most recent first, capped)
    const activityRes = await query(`
      SELECT
        cl.campaign_name,
        'call' AS channel,
        cl.disposition,
        cl.disposition_normalized,
        cl.call_date AS activity_date,
        cl.agent_name
      FROM call_logs cl
      JOIN phones ph ON ph.id = cl.phone_id
      JOIN contacts ct ON ct.id = ph.contact_id
      JOIN property_contacts pc ON pc.contact_id = ct.id
      WHERE pc.property_id = $1 AND cl.campaign_name IS NOT NULL
      UNION ALL
      SELECT
        sl.campaign_name,
        'sms' AS channel,
        sl.disposition,
        NULL AS disposition_normalized,
        sl.sent_at AS activity_date,
        NULL AS agent_name
      FROM sms_logs sl
      JOIN phones ph ON ph.id = sl.phone_id
      JOIN contacts ct ON ct.id = ph.contact_id
      JOIN property_contacts pc ON pc.contact_id = ct.id
      WHERE pc.property_id = $1 AND sl.campaign_name IS NOT NULL
      ORDER BY activity_date DESC NULLS LAST
      LIMIT 50
    `, [id]).catch(() => ({ rows: [] }));

    res.send(propertyDetail({
      property:           p,
      primaryContact,
      secondaryContacts,
      phones,
      lists:              listsRes.rows,
      tags:               tagsRes.rows,
      distressBreakdown,
      activity:           activityRes.rows,
      user:               getUser(req),
    }));
  } catch (e) {
    console.error('[ocular/records/:id]', e);
    res.status(500).send('Error loading property: ' + e.message);
  }
});

// ─── Placeholder routes for unbuilt pages ──────────────────────────────────
// These exist so the sidebar doesn't 404 if you click around. Each shows
// "Coming next session" until we wire up the real implementation.
//
// Note: 'lists/types' is included separately because the List Registry
// sidebar link targets /ocular/lists/types (not /ocular/lists). Without it,
// clicking List Registry in the sidebar 404s.
const placeholderPages = ['records', 'owners', 'campaigns', 'lists', 'lists/types', 'upload', 'activity', 'setup'];
const { shell } = require('./layouts/shell');
placeholderPages.forEach(page => {
  // Title and active-page name both need to work whether `page` is 'records'
  // or a nested path like 'lists/types'.
  const isListRegistry = page === 'lists/types';
  const niceTitle = isListRegistry ? 'List Registry'
    : page.charAt(0).toUpperCase() + page.slice(1);
  const activeId = isListRegistry ? 'list-registry'
    : page === 'setup' ? 'settings'
    : page;

  router.get('/' + page, requireAuth, (req, res) => {
    res.send(shell({
      title: niceTitle,
      activePage: activeId,
      user: getUser(req),
      body: `
        <div class="ocu-page-header">
          <div>
            <h1 class="ocu-page-title">${niceTitle}</h1>
            <div class="ocu-page-subtitle">This page hasn't been built in Ocular yet.</div>
          </div>
        </div>
        <div class="ocu-card" style="text-align:center;padding:60px 24px">
          <div style="color:var(--ocu-text-2);font-size:14px">
            Coming in the next session. Use the
            <a href="/${page === 'setup' ? 'setup' : page}" style="color:var(--ocu-accent)">existing Loki UI</a>
            for now.
          </div>
        </div>`,
    }));
  });
});

// ─── Helpers used inside the route handler ─────────────────────────────────

// User info source. Loki currently has a single-user system — the session
// only stores `authenticated`, no name/role. Hardcoding the operator here
// until proper user management is added. When that ships, swap to read
// from req.session.userName / userRole.
function getUser(req) {
  return {
    name: 'Wale Oladapo',
    role: 'Owner · OOJ Acquisitions',
    initials: 'WO',
  };
}

function escapeHTML(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtTimeAgo(date) {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return '';
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 60)        return sec + 's ago';
  if (sec < 3600)      return Math.floor(sec / 60) + ' min ago';
  if (sec < 86400)     return Math.floor(sec / 3600) + ' hr ago';
  if (sec < 86400 * 7) return Math.floor(sec / 86400) + 'd ago';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

module.exports = router;
