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

// ─── /ocular/records — Records list page ──────────────────────────────────
// Phase 2 (2026-04-25): full filter set + bulk action support. Param names
// match what the old Loki bulk endpoints (/records/bulk-tag, /delete,
// /remove-from-list, /export) understand, so the bulk action JS can pass
// the current querystring as `filterParams` and the server re-runs the
// query to act on the full filtered result set.
//
// Param contract:
//   q, state[], city, zip, county, pipeline, phones, min_distress,
//   list_id, owner_type, occupancy, min_year, max_year, min_equity,
//   max_equity, phone_type, tag_include[], tag_exclude[]
router.get('/records', requireAuth, async (req, res) => {
  try {
    const { recordsList } = require('./pages/records-list');

    // ── Parse + sanitize filter params ─────────────────────────────────────
    const q              = String(req.query.q || '').trim();
    const city           = String(req.query.city || '').trim();
    const zip            = String(req.query.zip || '').trim();
    const county         = String(req.query.county || '').trim();
    const pipeline       = String(req.query.pipeline || '').trim().toLowerCase();
    const phones         = String(req.query.phones || '').trim().toLowerCase();
    const min_distress   = String(req.query.min_distress || '').trim();
    const list_id        = String(req.query.list_id || '').trim();
    // Phase 2 additions
    const owner_type     = String(req.query.owner_type || '').trim();
    const occupancy      = String(req.query.occupancy || '').trim().toLowerCase();
    const min_year       = String(req.query.min_year || '').trim();
    const max_year       = String(req.query.max_year || '').trim();
    const min_equity     = String(req.query.min_equity || '').trim();
    const max_equity     = String(req.query.max_equity || '').trim();
    const phone_type     = String(req.query.phone_type || '').trim().toLowerCase();

    // Multi-arrays — state, tag_include, tag_exclude
    const normArr = (raw) => {
      if (!raw) return [];
      const a = Array.isArray(raw) ? raw : [raw];
      return a.filter(v => v && String(v).trim() !== '');
    };
    const stateList = normArr(req.query.state).map(s => String(s).toUpperCase());
    const tagIncludeList = normArr(req.query.tag_include).map(v => parseInt(v, 10)).filter(Number.isFinite);
    const tagExcludeList = normArr(req.query.tag_exclude).map(v => parseInt(v, 10)).filter(Number.isFinite);

    // Sort + pagination
    const allowedSort = { id: 'p.id', street: 'p.street', distress_score: 'p.distress_score', created_at: 'p.created_at' };
    const sortByKey = String(req.query.sort || 'id');
    const sortBy    = allowedSort[sortByKey] ? sortByKey : 'id';
    const sortCol   = allowedSort[sortBy];
    const sortDir   = String(req.query.dir || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const sortDirLc = sortDir.toLowerCase();

    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = 25;
    const offset = (page - 1) * limit;

    // ── Build WHERE clause + params ─────────────────────────────────────────
    const conditions = [];
    const params = [];
    let idx = 1;

    if (q) {
      conditions.push(`(p.street ILIKE $${idx} OR p.city ILIKE $${idx} OR p.zip_code ILIKE $${idx} OR c.first_name ILIKE $${idx} OR c.last_name ILIKE $${idx})`);
      params.push(`%${q}%`); idx++;
    }
    if (stateList.length) {
      conditions.push(`p.state_code = ANY($${idx}::text[])`);
      params.push(stateList); idx++;
    }
    if (city) {
      const cityList = city.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
      if (cityList.length) {
        const ors = cityList.map(() => `p.city ILIKE $${idx++}`);
        conditions.push(`(${ors.join(' OR ')})`);
        cityList.forEach(c => params.push(`%${c}%`));
      }
    }
    if (zip) {
      const zipList = zip.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
      if (zipList.length) {
        const ors = zipList.map(() => `p.zip_code ILIKE $${idx++}`);
        conditions.push(`(${ors.join(' OR ')})`);
        zipList.forEach(z => params.push(`${z}%`));
      }
    }
    if (county) {
      const countyList = county.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
      if (countyList.length) {
        const ors = countyList.map(() => `p.county ILIKE $${idx++}`);
        conditions.push(`(${ors.join(' OR ')})`);
        countyList.forEach(c => params.push(`%${c}%`));
      }
    }
    if (pipeline && ['prospect', 'lead', 'contract', 'closed'].includes(pipeline)) {
      conditions.push(`p.pipeline_stage = $${idx}`);
      params.push(pipeline); idx++;
    }
    if (min_distress && /^\d+$/.test(min_distress)) {
      conditions.push(`p.distress_score >= $${idx}`);
      params.push(parseInt(min_distress, 10)); idx++;
    }
    // Phones filter
    if (phones === 'has') {
      conditions.push(`EXISTS (SELECT 1 FROM phones ph2 JOIN property_contacts pc2 ON pc2.contact_id = ph2.contact_id WHERE pc2.property_id = p.id)`);
    } else if (phones === 'none') {
      conditions.push(`NOT EXISTS (SELECT 1 FROM phones ph2 JOIN property_contacts pc2 ON pc2.contact_id = ph2.contact_id WHERE pc2.property_id = p.id)`);
    } else if (phones === 'correct') {
      conditions.push(`EXISTS (SELECT 1 FROM phones ph2 JOIN property_contacts pc2 ON pc2.contact_id = ph2.contact_id WHERE pc2.property_id = p.id AND LOWER(ph2.phone_status) = 'correct')`);
    }
    // List filter
    if (list_id && /^\d+$/.test(list_id)) {
      conditions.push(`EXISTS (SELECT 1 FROM property_lists pl WHERE pl.property_id = p.id AND pl.list_id = $${idx})`);
      params.push(parseInt(list_id, 10)); idx++;
    }

    // ── Phase 2 filters ────────────────────────────────────────────────────
    if (owner_type && ['Person', 'Company', 'Trust'].includes(owner_type)) {
      conditions.push(`c.owner_type = $${idx}`);
      params.push(owner_type); idx++;
    }
    // Occupancy: address-based mailing match (mirrors old Loki logic)
    if (['owner_occupied', 'absent_owner', 'unknown'].includes(occupancy)) {
      if (occupancy === 'unknown') {
        conditions.push(`(c.mailing_address IS NULL OR TRIM(c.mailing_address) = '')`);
      } else {
        // Compare normalized property address to normalized mailing address
        const sameAddr = `(c.mailing_address IS NOT NULL
          AND COALESCE(p.street_normalized, LOWER(TRIM(p.street))) = COALESCE(c.mailing_address_normalized, LOWER(TRIM(c.mailing_address)))
          AND LOWER(TRIM(p.city)) = LOWER(TRIM(c.mailing_city))
          AND UPPER(TRIM(p.state_code)) = UPPER(TRIM(c.mailing_state))
          AND SUBSTRING(TRIM(p.zip_code) FROM 1 FOR 5) = SUBSTRING(TRIM(c.mailing_zip) FROM 1 FOR 5))`;
        if (occupancy === 'owner_occupied') {
          conditions.push(sameAddr);
        } else { // absent_owner
          conditions.push(`(c.mailing_address IS NOT NULL AND TRIM(c.mailing_address) != '' AND NOT ${sameAddr})`);
        }
      }
    }
    if (min_year && /^\d+$/.test(min_year)) {
      conditions.push(`p.year_built >= $${idx}`); params.push(parseInt(min_year, 10)); idx++;
    }
    if (max_year && /^\d+$/.test(max_year)) {
      conditions.push(`p.year_built <= $${idx}`); params.push(parseInt(max_year, 10)); idx++;
    }
    if (min_equity && /^-?\d+(\.\d+)?$/.test(min_equity)) {
      conditions.push(`p.equity_percent >= $${idx}`); params.push(parseFloat(min_equity)); idx++;
    }
    if (max_equity && /^-?\d+(\.\d+)?$/.test(max_equity)) {
      conditions.push(`p.equity_percent <= $${idx}`); params.push(parseFloat(max_equity)); idx++;
    }
    if (phone_type && ['mobile', 'landline', 'voip'].includes(phone_type)) {
      conditions.push(`EXISTS (SELECT 1 FROM phones ph3 JOIN property_contacts pc3 ON pc3.contact_id = ph3.contact_id WHERE pc3.property_id = p.id AND LOWER(ph3.phone_type) = $${idx})`);
      params.push(phone_type); idx++;
    }
    // Tag include — multi: property must have ALL selected tags
    if (tagIncludeList.length) {
      conditions.push(`(SELECT COUNT(DISTINCT tag_id) FROM property_tags WHERE property_id = p.id AND tag_id = ANY($${idx}::int[])) = $${idx + 1}`);
      params.push(tagIncludeList);
      params.push(tagIncludeList.length);
      idx += 2;
    }
    // Tag exclude — property must NOT have ANY of the selected tags
    if (tagExcludeList.length) {
      conditions.push(`NOT EXISTS (SELECT 1 FROM property_tags WHERE property_id = p.id AND tag_id = ANY($${idx}::int[]))`);
      params.push(tagExcludeList); idx++;
    }

    const whereSQL = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    // ── COUNT ──────────────────────────────────────────────────────────────
    const countRes = await query(`
      SELECT COUNT(*)::int AS n
      FROM properties p
      LEFT JOIN property_contacts pc ON pc.property_id = p.id AND pc.primary_contact = true
      LEFT JOIN contacts c ON c.id = pc.contact_id
      ${whereSQL}
    `, params);
    const total = countRes.rows[0].n || 0;

    // ── ROWS ───────────────────────────────────────────────────────────────
    const rowsRes = await query(`
      SELECT
        p.id, p.street, p.city, p.state_code, p.zip_code,
        p.property_type, p.pipeline_stage, p.created_at,
        p.distress_score, p.distress_band,
        c.first_name, c.last_name, c.owner_type,
        (SELECT COUNT(*) FROM property_lists pl WHERE pl.property_id = p.id) AS list_count,
        (SELECT COUNT(*) FROM phones ph2
           JOIN property_contacts pc2 ON pc2.contact_id = ph2.contact_id
          WHERE pc2.property_id = p.id) AS phone_count
      FROM properties p
      LEFT JOIN property_contacts pc ON pc.property_id = p.id AND pc.primary_contact = true
      LEFT JOIN contacts c ON c.id = pc.contact_id
      ${whereSQL}
      ORDER BY ${sortCol} ${sortDir} NULLS LAST, p.id DESC
      LIMIT $${idx} OFFSET $${idx + 1}
    `, [...params, limit, offset]);

    // ── Lookup data for filter dropdowns ───────────────────────────────────
    // States are hardcoded in records-filters.js (all 50 + DC) so we don't
    // need to query the DB for them here anymore.
    const allTagsRes = await query(`SELECT id, name FROM tags ORDER BY name ASC LIMIT 200`).catch(() => ({ rows: [] }));
    const allListsRes = await query(`SELECT id, list_name FROM lists ORDER BY list_name ASC LIMIT 200`);

    // Pass through the original querystring (for chip-x removal links etc.)
    const querystring = req.url.includes('?') ? req.url.split('?')[1] : '';

    res.send(recordsList({
      rows: rowsRes.rows,
      total, page, limit,
      sortBy, sortDir: sortDirLc,
      querystring,
      filters: {
        q, city, zip, county, pipeline, phones, min_distress, list_id, stateList,
        owner_type, occupancy, min_year, max_year, min_equity, max_equity, phone_type,
        tagIncludeList, tagExcludeList,
      },
      allTags:   allTagsRes.rows,
      allLists:  allListsRes.rows,
      user:      getUser(req),
    }));
  } catch (e) {
    console.error('[ocular/records]', e);
    res.status(500).send('Error loading records: ' + e.message);
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
// 2026-04-25 'records' removed from placeholders — now has a real GET handler
// above this block. Keep the others until they're built in their own sessions.
const placeholderPages = ['owners', 'campaigns', 'lists', 'lists/types', 'upload', 'activity', 'setup'];
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
