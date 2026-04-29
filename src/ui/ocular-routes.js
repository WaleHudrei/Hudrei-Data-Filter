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
  if (!req.session || !req.session.authenticated) return res.redirect('/login');
  if (!req.session.tenantId) return res.redirect('/login');
  req.tenantId = req.session.tenantId;
  req.userId = req.session.userId;
  req.role = req.session.role;
  next();
}

// Note: Ocular CSS is served from server.js at /ocular-static/ocular.css
// (mounted there to avoid double-mount complexity here).

// ─── /ocular/dashboard ─────────────────────────────────────────────────────
router.get('/dashboard', requireAuth, async (req, res) => {
  try {
    // Fetch all the data the dashboard needs in parallel.
    // Each query is simple enough to run from this handler; we'll extract
    // them into a dashboard-stats service if it grows.
    const t = req.tenantId;
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
      query(`SELECT COUNT(*)::int AS n FROM properties WHERE tenant_id = $1`, [t]),
      query(`SELECT COUNT(DISTINCT contact_id)::int AS n FROM property_contacts WHERE tenant_id = $1 AND primary_contact = true`, [t]),
      // 2026-04-29 dash-audit fix #1: count ANY phone on file (not just
      // primary contact's), and scope phones to tenant. Pre-fix the JOIN
      // had no ph.tenant_id clause so on a multi-tenant deploy a phone
      // belonging to another tenant could keep this tenant's property in
      // the count. Also pre-fix only primary_contact phones counted —
      // a property with a secondary owner whose phones were on file
      // showed up as "no phones" on the dashboard.
      query(`SELECT COUNT(DISTINCT pc.property_id)::int AS n
               FROM property_contacts pc
               JOIN phones ph ON ph.contact_id = pc.contact_id
                              AND ph.tenant_id = pc.tenant_id
              WHERE pc.tenant_id = $1`, [t]),
      query(`SELECT COUNT(*)::int AS n FROM (
               SELECT contact_id FROM property_contacts
                WHERE tenant_id = $1 AND primary_contact = true
                GROUP BY contact_id HAVING COUNT(*) > 1
             ) t`, [t]),
      query(`SELECT COUNT(*)::int AS n FROM properties WHERE tenant_id = $1 AND created_at > NOW() - INTERVAL '7 days'`, [t]),
      query(`
        SELECT
          COUNT(*) FILTER (WHERE distress_band = 'burning')::int AS burning,
          COUNT(*) FILTER (WHERE distress_band = 'hot')::int     AS hot,
          COUNT(*) FILTER (WHERE distress_band = 'warm')::int    AS warm,
          COUNT(*) FILTER (WHERE distress_band = 'cold')::int    AS cold
        FROM properties WHERE tenant_id = $1`, [t]),
      query(`SELECT COUNT(*)::int AS n FROM lists WHERE tenant_id = $1`, [t]),
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
        FROM list_templates WHERE tenant_id = $1
      `, [t]).catch(() => ({ rows: [{ total: 0, overdue: 0, due_week: 0 }] })),
      // 2026-04-29 dash-audit fix #2: pl.tenant_id was missing from the
      // LEFT JOIN, so on a multi-tenant deploy any property_lists row
      // sharing a list_id (impossible with the current composite UNIQUE,
      // but defensive) — and more importantly, the cross-tenant safety
      // rule says every join touching a tenant-scoped table carries its
      // tenant clause. Aligned with the filter-parity rule from CLAUDE.md.
      query(`
        SELECT l.list_name AS name, COUNT(pl.property_id)::int AS count
          FROM lists l
          LEFT JOIN property_lists pl ON pl.list_id = l.id
                                      AND pl.tenant_id = l.tenant_id
          WHERE l.tenant_id = $1
          GROUP BY l.id, l.list_name
          ORDER BY count DESC
          LIMIT 5`, [t]),
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
    // 2026-04-29 dash-audit fix #3: status='completed' is what bulk-import
    // writes; property-import (the more common path) writes 'complete'
    // (no d) — pre-existing column-name/value drift we documented in
    // earlier audits. Filtering by 'completed' alone meant every
    // /import/property job (the kind operators run for property CSVs)
    // was silently invisible in the dashboard activity feed. Accept both.
    // Also pre-fix used `created_at` which doesn't exist on this table —
    // it's `started_at`. Same column-drift issue.
    const recentImportsRes = await query(`
      SELECT total_rows::int AS n, filename, started_at AS created_at
        FROM bulk_import_jobs
       WHERE tenant_id = $1
         AND status IN ('complete','completed')
       ORDER BY started_at DESC
       LIMIT 3
    `, [t]).catch(() => ({ rows: [] }));

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

    const user = await getUser(req);

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
    // 2026-04-29 filter-parity gap fix: these were already supported by the
    // bulk-export selectAll path (records-routes.js /export) but the list
    // view silently ignored them. Users would type a value into the form
    // and the list would render unchanged — looks broken even when the
    // SQL was fine on the export side. Wiring all of them through.
    const property_type  = String(req.query.type || '').trim();
    const prop_status    = String(req.query.prop_status || '').trim();
    const source_filter  = String(req.query.source || '').trim();
    const min_assessed   = String(req.query.min_assessed || '').trim();
    const max_assessed   = String(req.query.max_assessed || '').trim();
    const min_owned      = String(req.query.min_owned || '').trim();
    const max_owned      = String(req.query.max_owned || '').trim();
    const min_stack      = String(req.query.min_stack || '').trim();
    const min_years_owned = String(req.query.min_years_owned || '').trim();
    const max_years_owned = String(req.query.max_years_owned || '').trim();

    // Multi-arrays — state, tag_include, tag_exclude
    const normArr = (raw) => {
      if (!raw) return [];
      const a = Array.isArray(raw) ? raw : [raw];
      return a.filter(v => v && String(v).trim() !== '');
    };
    const stateList = normArr(req.query.state).map(s => String(s).toUpperCase());
    const tagIncludeList = normArr(req.query.tag_include).map(v => parseInt(v, 10)).filter(Number.isFinite);
    const tagExcludeList = normArr(req.query.tag_exclude).map(v => parseInt(v, 10)).filter(Number.isFinite);
    const phoneTagIncludeList = normArr(req.query.phone_tag_include).map(v => parseInt(v, 10)).filter(Number.isFinite);
    const phoneTagExcludeList = normArr(req.query.phone_tag_exclude).map(v => parseInt(v, 10)).filter(Number.isFinite);

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
    // Tenant filter is the first WHERE clause; every subquery below also
    // carries a tenant filter on the tables it touches so cross-tenant
    // rows can never satisfy a subquery condition.
    const conditions = [`p.tenant_id = $1`];
    const params = [req.tenantId];
    let idx = 2;

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
      conditions.push(`EXISTS (SELECT 1 FROM phones ph2 JOIN property_contacts pc2 ON pc2.contact_id = ph2.contact_id WHERE pc2.property_id = p.id AND pc2.tenant_id = p.tenant_id AND ph2.tenant_id = p.tenant_id)`);
    } else if (phones === 'none') {
      conditions.push(`NOT EXISTS (SELECT 1 FROM phones ph2 JOIN property_contacts pc2 ON pc2.contact_id = ph2.contact_id WHERE pc2.property_id = p.id AND pc2.tenant_id = p.tenant_id AND ph2.tenant_id = p.tenant_id)`);
    } else if (phones === 'correct') {
      conditions.push(`EXISTS (SELECT 1 FROM phones ph2 JOIN property_contacts pc2 ON pc2.contact_id = ph2.contact_id WHERE pc2.property_id = p.id AND pc2.tenant_id = p.tenant_id AND ph2.tenant_id = p.tenant_id AND LOWER(ph2.phone_status) = 'correct')`);
    }
    // List filter
    if (list_id && /^\d+$/.test(list_id)) {
      conditions.push(`EXISTS (SELECT 1 FROM property_lists pl WHERE pl.property_id = p.id AND pl.tenant_id = p.tenant_id AND pl.list_id = $${idx})`);
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
      conditions.push(`EXISTS (SELECT 1 FROM phones ph3 JOIN property_contacts pc3 ON pc3.contact_id = ph3.contact_id WHERE pc3.property_id = p.id AND pc3.tenant_id = p.tenant_id AND ph3.tenant_id = p.tenant_id AND LOWER(ph3.phone_type) = $${idx})`);
      params.push(phone_type); idx++;
    }
    // Tag include — multi: property must have ALL selected tags
    if (tagIncludeList.length) {
      conditions.push(`(SELECT COUNT(DISTINCT tag_id) FROM property_tags WHERE property_id = p.id AND tenant_id = p.tenant_id AND tag_id = ANY($${idx}::int[])) = $${idx + 1}`);
      params.push(tagIncludeList);
      params.push(tagIncludeList.length);
      idx += 2;
    }
    // Tag exclude — property must NOT have ANY of the selected tags
    if (tagExcludeList.length) {
      conditions.push(`NOT EXISTS (SELECT 1 FROM property_tags WHERE property_id = p.id AND tenant_id = p.tenant_id AND tag_id = ANY($${idx}::int[]))`);
      params.push(tagExcludeList); idx++;
    }

    // 2026-04-29 filter-parity gap fix: every clause from here down was
    // already implemented in the bulk-export selectAll handler
    // (records-routes.js POST /export). The list view now mirrors them so
    // typing into the form actually changes the rendered list — that was
    // the user-reported "filters don't filter anything" bug.

    // Property type
    if (property_type) {
      conditions.push(`p.property_type = $${idx}`);
      params.push(property_type); idx++;
    }
    // Property status
    if (prop_status) {
      conditions.push(`p.property_status = $${idx}`);
      params.push(prop_status); idx++;
    }
    // Source (free-text contains)
    if (source_filter) {
      conditions.push(`p.source ILIKE $${idx}`);
      params.push('%' + source_filter + '%'); idx++;
    }
    // Assessed value range
    if (min_assessed && /^-?\d+(\.\d+)?$/.test(min_assessed)) {
      conditions.push(`p.assessed_value >= $${idx}`); params.push(parseFloat(min_assessed)); idx++;
    }
    if (max_assessed && /^-?\d+(\.\d+)?$/.test(max_assessed)) {
      conditions.push(`p.assessed_value <= $${idx}`); params.push(parseFloat(max_assessed)); idx++;
    }
    // Min list-stack count — property is on at least N lists
    if (min_stack && /^\d+$/.test(min_stack)) {
      conditions.push(`(SELECT COUNT(*) FROM property_lists plc WHERE plc.property_id = p.id AND plc.tenant_id = p.tenant_id) >= $${idx}`);
      params.push(parseInt(min_stack, 10)); idx++;
    }
    // Multi-property (owned-count) range — uses owner_portfolio_counts MV
    // for performance, falling back to 1 when there's no mailing address.
    // Mirrors the bulk-export sub-expression exactly.
    if (min_owned || max_owned) {
      const ownedSubX = `
        CASE WHEN c.mailing_address IS NULL OR TRIM(c.mailing_address) = '' THEN 1
        ELSE COALESCE(
          (SELECT opc.owned_count FROM owner_portfolio_counts opc
            WHERE opc.mailing_address_normalized = c.mailing_address_normalized
              AND opc.mailing_city_normalized = LOWER(TRIM(c.mailing_city))
              AND opc.mailing_state = UPPER(TRIM(c.mailing_state))
              AND opc.zip5 = SUBSTRING(TRIM(c.mailing_zip) FROM 1 FOR 5)),
          1
        ) END`;
      if (min_owned && /^\d+$/.test(min_owned)) {
        conditions.push(`${ownedSubX} >= $${idx}`); params.push(parseInt(min_owned, 10)); idx++;
      }
      if (max_owned && /^\d+$/.test(max_owned)) {
        conditions.push(`${ownedSubX} <= $${idx}`); params.push(parseInt(max_owned, 10)); idx++;
      }
    }
    // Years-owned (ownership duration) — needs last_sale_date.
    if (min_years_owned && /^\d+$/.test(min_years_owned)) {
      conditions.push(`p.last_sale_date IS NOT NULL AND EXTRACT(YEAR FROM AGE(CURRENT_DATE, p.last_sale_date)) >= $${idx}`);
      params.push(parseInt(min_years_owned, 10)); idx++;
    }
    if (max_years_owned && /^\d+$/.test(max_years_owned)) {
      conditions.push(`p.last_sale_date IS NOT NULL AND EXTRACT(YEAR FROM AGE(CURRENT_DATE, p.last_sale_date)) <= $${idx}`);
      params.push(parseInt(max_years_owned, 10)); idx++;
    }
    // Phone tag include / exclude. Tag → phone link is `phone_tag_links`
    // (phone_id, phone_tag_id); the tag pool itself lives in `phone_tags`.
    // We join through the link table back to property_contacts so the
    // filter applies per-property.
    if (phoneTagIncludeList.length) {
      conditions.push(`EXISTS (
        SELECT 1 FROM phone_tag_links ptl
          JOIN phones ph_pti ON ph_pti.id = ptl.phone_id
          JOIN property_contacts pc_pti ON pc_pti.contact_id = ph_pti.contact_id
        WHERE pc_pti.property_id = p.id
          AND pc_pti.tenant_id = p.tenant_id
          AND ph_pti.tenant_id = p.tenant_id
          AND ptl.phone_tag_id = ANY($${idx}::int[]))`);
      params.push(phoneTagIncludeList); idx++;
    }
    if (phoneTagExcludeList.length) {
      conditions.push(`NOT EXISTS (
        SELECT 1 FROM phone_tag_links ptl
          JOIN phones ph_pte ON ph_pte.id = ptl.phone_id
          JOIN property_contacts pc_pte ON pc_pte.contact_id = ph_pte.contact_id
        WHERE pc_pte.property_id = p.id
          AND pc_pte.tenant_id = p.tenant_id
          AND ph_pte.tenant_id = p.tenant_id
          AND ptl.phone_tag_id = ANY($${idx}::int[]))`);
      params.push(phoneTagExcludeList); idx++;
    }

    const whereSQL = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    // ── COUNT ──────────────────────────────────────────────────────────────
    const countRes = await query(`
      SELECT COUNT(*)::int AS n
      FROM properties p
      LEFT JOIN property_contacts pc ON pc.property_id = p.id AND pc.tenant_id = p.tenant_id AND pc.primary_contact = true
      LEFT JOIN contacts c ON c.id = pc.contact_id AND c.tenant_id = p.tenant_id
      ${whereSQL}
    `, params);
    const total = countRes.rows[0].n || 0;

    // ── ROWS ───────────────────────────────────────────────────────────────
    // 2026-04-29 Tier-3 follow-up: rewrote the per-row correlated subqueries
    // (list_count, phone_count) as post-pagination CTE LEFT JOINs. The old
    // shape evaluated the two COUNT(*) subqueries once per output row using
    // an Index Scan; the new shape pages first (CTE `paged`) and then runs
    // exactly two GROUP BY scans bounded to the 25 paged ids. Functionally
    // identical, but the planner can pick a better aggregate strategy and
    // we no longer pay correlated-subquery overhead.
    const rowsRes = await query(`
      WITH paged AS (
        SELECT
          p.id, p.street, p.city, p.state_code, p.zip_code,
          p.property_type, p.pipeline_stage, p.created_at,
          p.distress_score, p.distress_band,
          c.first_name, c.last_name, c.owner_type
        FROM properties p
        LEFT JOIN property_contacts pc ON pc.property_id = p.id AND pc.tenant_id = p.tenant_id AND pc.primary_contact = true
        LEFT JOIN contacts c ON c.id = pc.contact_id AND c.tenant_id = p.tenant_id
        ${whereSQL}
        ORDER BY ${sortCol} ${sortDir} NULLS LAST, p.id DESC
        LIMIT $${idx} OFFSET $${idx + 1}
      ),
      list_counts AS (
        SELECT pl.property_id, COUNT(*)::int AS cnt
        FROM property_lists pl
        WHERE pl.tenant_id = $1 AND pl.property_id IN (SELECT id FROM paged)
        GROUP BY pl.property_id
      ),
      phone_counts AS (
        SELECT pc2.property_id, COUNT(*)::int AS cnt
        FROM phones ph2
        JOIN property_contacts pc2 ON pc2.contact_id = ph2.contact_id
        WHERE pc2.tenant_id = $1 AND ph2.tenant_id = $1
          AND pc2.property_id IN (SELECT id FROM paged)
        GROUP BY pc2.property_id
      )
      SELECT
        paged.id, paged.street, paged.city, paged.state_code, paged.zip_code,
        paged.property_type, paged.pipeline_stage, paged.created_at,
        paged.distress_score, paged.distress_band,
        paged.first_name, paged.last_name, paged.owner_type,
        COALESCE(lc.cnt, 0) AS list_count,
        COALESCE(phc.cnt, 0) AS phone_count
      FROM paged
      LEFT JOIN list_counts lc ON lc.property_id = paged.id
      LEFT JOIN phone_counts phc ON phc.property_id = paged.id
      ORDER BY paged.${sortBy} ${sortDir} NULLS LAST, paged.id DESC
    `, [...params, limit, offset]);

    // ── Lookup data for filter dropdowns ───────────────────────────────────
    // States are hardcoded in records-filters.js (all 50 + DC) so we don't
    // need to query the DB for them here anymore.
    const allTagsRes = await query(`SELECT id, name FROM tags WHERE tenant_id = $1 ORDER BY name ASC LIMIT 200`, [req.tenantId]).catch(() => ({ rows: [] }));
    const allListsRes = await query(`SELECT id, list_name FROM lists WHERE tenant_id = $1 ORDER BY list_name ASC LIMIT 200`, [req.tenantId]);
    // Phone-tag pool. The phone_tags table is process-wide (not tenant-scoped
    // — see records-routes.js:92), so this is the same list every tenant
    // sees. catch() guards against the table being absent on a fresh boot.
    const allPhoneTagsRes = await query(`SELECT id, name FROM phone_tags ORDER BY name ASC LIMIT 200`).catch(() => ({ rows: [] }));

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
        // 2026-04-29 filter-parity gap fix: surface the new filters back to
        // the form so existing filter values stay populated on reload.
        property_type, prop_status, source: source_filter,
        min_assessed, max_assessed, min_owned, max_owned, min_stack,
        min_years_owned, max_years_owned,
        phoneTagIncludeList, phoneTagExcludeList,
      },
      allTags:      allTagsRes.rows,
      allLists:     allListsRes.rows,
      allPhoneTags: allPhoneTagsRes.rows,
      user:         await getUser(req),
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
    const t = req.tenantId;
    const { propertyDetail } = require('./pages/property-detail');

    // Property — tenant_id check ensures cross-tenant ID lookups 404 cleanly
    const propRes = await query(`SELECT * FROM properties WHERE id = $1 AND tenant_id = $2`, [id, t]);
    if (!propRes.rows.length) {
      return res.status(404).send('Property not found');
    }
    const p = propRes.rows[0];

    // Contacts (Owner 1 + any Owner 2+)
    const contactRes = await query(`
      SELECT c.*, pc.role, pc.primary_contact
        FROM contacts c
        JOIN property_contacts pc ON pc.contact_id = c.id AND pc.tenant_id = $2
       WHERE pc.property_id = $1 AND c.tenant_id = $2
       ORDER BY pc.primary_contact DESC, c.id ASC
    `, [id, t]);
    const primaryContact   = contactRes.rows.find(r => r.primary_contact) || null;
    const secondaryContacts = contactRes.rows.filter(r => !r.primary_contact);

    // Phones for the primary contact, with phone_tags attached
    let phones = [];
    if (primaryContact) {
      const phoneRes = await query(
        `SELECT * FROM phones WHERE contact_id = $1 AND tenant_id = $2 ORDER BY phone_index ASC`,
        [primaryContact.id, t]
      );
      phones = phoneRes.rows;
      if (phones.length) {
        const phoneIds = phones.map(ph => ph.id);
        const ptRes = await query(`
          SELECT ptl.phone_id, pt.id, pt.name, pt.color
            FROM phone_tag_links ptl
            JOIN phone_tags pt ON pt.id = ptl.phone_tag_id AND pt.tenant_id = $2
           WHERE ptl.phone_id = ANY($1::int[]) AND ptl.tenant_id = $2
           ORDER BY pt.name ASC
        `, [phoneIds, t]).catch(() => ({ rows: [] }));
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
        `SELECT * FROM phones WHERE contact_id = $1 AND tenant_id = $2 ORDER BY phone_index ASC`,
        [sc.id, t]
      );
      sc.phones = scPhoneRes.rows;
    }

    // Lists membership
    const listsRes = await query(`
      SELECT l.list_name, l.list_type, l.source, pl.added_at
        FROM property_lists pl
        JOIN lists l ON l.id = pl.list_id AND l.tenant_id = $2
       WHERE pl.property_id = $1 AND pl.tenant_id = $2
       ORDER BY pl.added_at DESC
    `, [id, t]).catch(() => ({ rows: [] }));

    // Property tags
    const tagsRes = await query(`
      SELECT t.id, t.name, t.color
        FROM property_tags pt
        JOIN tags t ON t.id = pt.tag_id AND t.tenant_id = $2
       WHERE pt.property_id = $1 AND pt.tenant_id = $2
       ORDER BY t.name ASC
    `, [id, t]).catch(() => ({ rows: [] }));

    // Property notes (2026-04-29). Lazy-create on first read so the
    // table exists even if a brand-new tenant hasn't hit the POST yet.
    await query(`
      CREATE TABLE IF NOT EXISTS property_notes (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
        author VARCHAR(120),
        body TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_property_notes_property
        ON property_notes(property_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_property_notes_tenant
        ON property_notes(tenant_id);
    `).catch(() => {});
    const notesRes = await query(`
      SELECT id, author, body, created_at
        FROM property_notes
       WHERE property_id = $1 AND tenant_id = $2
       ORDER BY created_at DESC
       LIMIT 100
    `, [id, t]).catch(() => ({ rows: [] }));

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
      JOIN phones ph ON ph.id = cl.phone_id AND ph.tenant_id = $2
      JOIN contacts ct ON ct.id = ph.contact_id AND ct.tenant_id = $2
      JOIN property_contacts pc ON pc.contact_id = ct.id AND pc.tenant_id = $2
      WHERE pc.property_id = $1 AND cl.tenant_id = $2 AND cl.campaign_name IS NOT NULL
      UNION ALL
      SELECT
        sl.campaign_name,
        'sms' AS channel,
        sl.disposition,
        NULL AS disposition_normalized,
        sl.sent_at AS activity_date,
        NULL AS agent_name
      FROM sms_logs sl
      JOIN phones ph ON ph.id = sl.phone_id AND ph.tenant_id = $2
      JOIN contacts ct ON ct.id = ph.contact_id AND ct.tenant_id = $2
      JOIN property_contacts pc ON pc.contact_id = ct.id AND pc.tenant_id = $2
      WHERE pc.property_id = $1 AND sl.tenant_id = $2 AND sl.campaign_name IS NOT NULL
      ORDER BY activity_date DESC NULLS LAST
      LIMIT 50
    `, [id, t]).catch(() => ({ rows: [] }));

    res.send(propertyDetail({
      property:           p,
      primaryContact,
      secondaryContacts,
      phones,
      lists:              listsRes.rows,
      tags:               tagsRes.rows,
      notes:              notesRes.rows,
      distressBreakdown,
      activity:           activityRes.rows,
      user:               await getUser(req),
    }));
  } catch (e) {
    console.error('[ocular/records/:id]', e);
    res.status(500).send('Error loading property: ' + e.message);
  }
});

// ─── /ocular/upload — Upload chooser landing page ─────────────────────────
router.get('/upload', requireAuth, async (req, res) => {
  try {
    const { uploadChooser } = require('./pages/upload-chooser');
    res.send(uploadChooser({ user: await getUser(req) }));
  } catch (e) {
    console.error('[ocular/upload]', e);
    res.status(500).send('Error loading upload page: ' + e.message);
  }
});

// ─── /ocular/campaigns — Campaigns list ────────────────────────────────────
router.get('/campaigns', requireAuth, async (req, res) => {
  try {
    const { campaignsList } = require('./pages/campaigns-list');
    const campaigns = require('../campaigns');
    const filtration = require('../filtration');
    await campaigns.initCampaignSchema();
    const list = await campaigns.getCampaigns(req.tenantId);
    // Enrich each campaign with contact_counts so the list shows live numbers.
    // Same shape the Loki /campaigns route uses.
    for (const c of list) {
      try { c.contact_counts = await filtration.getContactStats(c.id); }
      catch (_) { c.contact_counts = { total_contacts: 0, total_phones: 0, wrong_phones: 0, nis_phones: 0, lead_contacts: 0 }; }
    }
    res.send(campaignsList({
      user: await getUser(req),
      campaigns: list,
      tab: req.query.tab || 'active',
    }));
  } catch (e) {
    console.error('[ocular/campaigns]', e);
    res.status(500).send('Error loading campaigns: ' + e.message);
  }
});

// Campaign detail
router.get('/campaigns/:id(\\d+)', requireAuth, async (req, res) => {
  try {
    const { campaignDetail } = require('./pages/campaign-detail');
    const campaigns = require('../campaigns');
    const filtration = require('../filtration');
    const c = await campaigns.getCampaign(req.tenantId, req.params.id);
    if (!c) return res.redirect('/ocular/campaigns');
    try { c.contact_counts = await filtration.getContactStats(req.params.id); }
    catch (_) { c.contact_counts = { total_contacts: 0, total_phones: 0, wrong_phones: 0, nis_phones: 0, lead_contacts: 0 }; }
    res.send(campaignDetail({
      user: await getUser(req),
      campaign: c,
      flash: {
        msg: req.query.msg ? String(req.query.msg).slice(0, 300) : '',
        err: req.query.err ? String(req.query.err).slice(0, 300) : '',
      },
    }));
  } catch (e) {
    console.error('[ocular/campaigns/:id]', e);
    res.status(500).send('Error loading campaign: ' + e.message);
  }
});

router.post('/campaigns/:id(\\d+)/status', requireAuth, async (req, res) => {
  try {
    const campaigns = require('../campaigns');
    await campaigns.updateCampaignStatus(req.tenantId, req.params.id, req.body.status);
    res.redirect('/ocular/campaigns/' + req.params.id + '?msg=' + encodeURIComponent('Status updated'));
  } catch (e) {
    res.redirect('/ocular/campaigns/' + req.params.id + '?err=' + encodeURIComponent('Failed to update status'));
  }
});

router.post('/campaigns/:id(\\d+)/channel', requireAuth, async (req, res) => {
  try {
    const campaigns = require('../campaigns');
    await campaigns.updateCampaignChannel(req.tenantId, req.params.id, req.body.channel);
    res.redirect('/ocular/campaigns/' + req.params.id + '?msg=' + encodeURIComponent('Channel updated'));
  } catch (e) {
    res.redirect('/ocular/campaigns/' + req.params.id + '?err=' + encodeURIComponent('Failed to update channel'));
  }
});

router.post('/campaigns/:id(\\d+)/rename', requireAuth, async (req, res) => {
  try {
    const campaigns = require('../campaigns');
    const result = await campaigns.updateCampaignName(req.tenantId, req.params.id, req.body.name);
    if (!result.ok) {
      return res.redirect('/ocular/campaigns/' + req.params.id + '?err=' + encodeURIComponent(result.error || 'Rename failed'));
    }
    res.redirect('/ocular/campaigns/' + req.params.id + '?msg=' + encodeURIComponent('Campaign renamed'));
  } catch (e) {
    res.redirect('/ocular/campaigns/' + req.params.id + '?err=' + encodeURIComponent('Rename failed'));
  }
});

router.post('/campaigns/:id(\\d+)/close', requireAuth, async (req, res) => {
  try {
    const campaigns = require('../campaigns');
    await campaigns.closeCampaign(req.tenantId, req.params.id);
    res.redirect('/ocular/campaigns/' + req.params.id + '?msg=' + encodeURIComponent('Campaign closed'));
  } catch (e) {
    res.redirect('/ocular/campaigns/' + req.params.id + '?err=' + encodeURIComponent('Failed to close'));
  }
});

router.post('/campaigns/:id(\\d+)/new-round', requireAuth, async (req, res) => {
  try {
    const campaigns = require('../campaigns');
    await campaigns.closeCampaign(req.tenantId, req.params.id);
    const newCamp = await campaigns.cloneCampaign(req.tenantId, req.params.id);
    res.redirect('/ocular/campaigns/' + (newCamp ? newCamp.id : req.params.id) + '?msg=' + encodeURIComponent('New round started'));
  } catch (e) {
    res.redirect('/ocular/campaigns/' + req.params.id + '?err=' + encodeURIComponent('Failed to start new round'));
  }
});

// ─── /ocular/lists/types — List Registry ───────────────────────────────────
const ALLOWED_REGISTRY_FIELDS = new Set([
  'action', 'state_code', 'list_name', 'list_tier',
  'source', 'frequency_days', 'require_bot', 'last_pull_date',
]);

router.get('/lists/types', requireAuth, async (req, res) => {
  try {
    const { listRegistry } = require('./pages/list-registry');
    const r = await query(
      `SELECT * FROM list_templates WHERE tenant_id = $1
        ORDER BY sort_order ASC, state_code ASC, list_name ASC`,
      [req.tenantId]
    );
    res.send(listRegistry({
      user: await getUser(req),
      rows: r.rows,
      flash: {
        msg: req.query.msg ? String(req.query.msg).slice(0, 300) : '',
        err: req.query.err ? String(req.query.err).slice(0, 300) : '',
      },
    }));
  } catch (e) {
    console.error('[ocular/lists/types]', e);
    res.status(500).send('Error loading list registry: ' + e.message);
  }
});

// Create a blank row.
router.post('/lists/types', requireAuth, async (req, res) => {
  try {
    await query(
      `INSERT INTO list_templates (tenant_id, action, list_name, sort_order)
       VALUES ($1, '', 'Untitled list type',
               COALESCE((SELECT MAX(sort_order) + 1 FROM list_templates WHERE tenant_id = $1), 0))`,
      [req.tenantId]
    );
    res.redirect('/ocular/lists/types?msg=' + encodeURIComponent('Row added'));
  } catch (e) {
    console.error('[ocular/lists/types POST]', e);
    res.status(500).send('Failed to add row');
  }
});

// Inline single-field update. Returns the freshly-rendered row HTML so the
// client can swap it in place (keeps the next-pull date math in sync).
router.post('/lists/types/:id(\\d+)', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const field = String(req.body.field || '');
    const rawValue = req.body.value;
    if (!ALLOWED_REGISTRY_FIELDS.has(field)) {
      return res.status(400).send('Field not allowed');
    }
    // Coerce per field — db column types are strict.
    let value;
    if (field === 'frequency_days') {
      value = (rawValue == null || rawValue === '') ? null : parseInt(rawValue, 10);
      if (value != null && !Number.isFinite(value)) return res.status(400).send('Invalid frequency');
    } else if (field === 'require_bot') {
      value = rawValue === 'true' ? true : rawValue === 'false' ? false : null;
    } else if (field === 'last_pull_date') {
      value = (rawValue == null || rawValue === '') ? null : String(rawValue).slice(0, 10);
    } else {
      value = String(rawValue == null ? '' : rawValue).trim();
      if (field === 'list_name' && !value) return res.status(400).send('Name required');
    }
    const r = await query(
      `UPDATE list_templates SET ${field} = $1, updated_at = NOW()
        WHERE id = $2 AND tenant_id = $3 RETURNING *`,
      [value, id, req.tenantId]
    );
    if (!r.rowCount) return res.status(404).send('Not found');
    // Re-render this row so the client can replace it.
    const { rowHTML } = require('./pages/list-registry');
    res.type('html').send(rowHTML(r.rows[0]));
  } catch (e) {
    console.error('[ocular/lists/types/:id POST]', e);
    res.status(500).send('Save failed');
  }
});

router.post('/lists/types/:id(\\d+)/pull', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const r = await query(
      `UPDATE list_templates SET last_pull_date = CURRENT_DATE, updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2`,
      [id, req.tenantId]
    );
    if (!r.rowCount) return res.status(404).send('Not found');
    res.json({ ok: true });
  } catch (e) {
    console.error('[ocular/lists/types/:id/pull]', e);
    res.status(500).send('Failed');
  }
});

router.post('/lists/types/:id(\\d+)/delete', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const r = await query(
      `DELETE FROM list_templates WHERE id = $1 AND tenant_id = $2`,
      [id, req.tenantId]
    );
    if (!r.rowCount) return res.status(404).send('Not found');
    res.json({ ok: true });
  } catch (e) {
    console.error('[ocular/lists/types/:id/delete]', e);
    res.status(500).send('Failed');
  }
});

// ─── /ocular/lists — Lists page ────────────────────────────────────────────
router.get('/lists', requireAuth, async (req, res) => {
  try {
    const { listsPage } = require('./pages/lists');
    const t = req.tenantId;
    const q = String(req.query.q || '').trim();
    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = 50;
    const offset = (page - 1) * limit;

    const conditions = [`l.tenant_id = $1`];
    const params = [t];
    let idx = 2;
    if (q) {
      conditions.push(`l.list_name ILIKE $${idx}`);
      params.push(`%${q}%`); idx++;
    }
    const whereSQL = `WHERE ${conditions.join(' AND ')}`;

    const countRes = await query(`SELECT COUNT(*)::int AS n FROM lists l ${whereSQL}`, params);
    const total = countRes.rows[0]?.n || 0;

    const rowsRes = await query(`
      SELECT l.id, l.list_name, l.list_type, l.source, l.active, l.upload_date, l.created_at,
             COUNT(pl.property_id)::int AS property_count
        FROM lists l
        LEFT JOIN property_lists pl ON pl.list_id = l.id AND pl.tenant_id = l.tenant_id
        ${whereSQL}
        GROUP BY l.id
        ORDER BY l.created_at DESC NULLS LAST
        LIMIT $${idx} OFFSET $${idx + 1}
    `, [...params, limit, offset]);

    const querystring = req.url.includes('?') ? req.url.split('?')[1] : '';

    res.send(listsPage({
      user: await getUser(req),
      rows: rowsRes.rows,
      total, page, limit,
      querystring,
      filters: { q },
      flash: {
        msg: req.query.msg ? String(req.query.msg).slice(0, 500) : '',
        err: req.query.err ? String(req.query.err).slice(0, 500) : '',
      },
    }));
  } catch (e) {
    console.error('[ocular/lists]', e);
    res.status(500).send('Error loading lists: ' + e.message);
  }
});

router.post('/lists/edit', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.body.id, 10);
    if (!id) return res.redirect('/ocular/lists?err=' + encodeURIComponent('Missing list id'));
    const list_name = String(req.body.list_name || '').trim();
    if (!list_name) return res.redirect('/ocular/lists?err=' + encodeURIComponent('List name is required'));
    const list_type = String(req.body.list_type || '').trim() || null;
    const source    = String(req.body.source    || '').trim() || null;
    const r = await query(
      `UPDATE lists
          SET list_name = $1,
              list_type = COALESCE(NULLIF($2, ''), list_type),
              source    = COALESCE(NULLIF($3, ''), source)
        WHERE id = $4 AND tenant_id = $5`,
      [list_name, list_type, source, id, req.tenantId]
    );
    if (!r.rowCount) return res.redirect('/ocular/lists?err=' + encodeURIComponent('List not found'));
    res.redirect('/ocular/lists?msg=' + encodeURIComponent('List updated'));
  } catch (e) {
    console.error('[ocular/lists/edit]', e);
    res.redirect('/ocular/lists?err=' + encodeURIComponent('Failed to update list'));
  }
});

router.post('/lists/delete', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.body.id, 10);
    if (!id) return res.redirect('/ocular/lists?err=' + encodeURIComponent('Missing list id'));
    const code = String(req.body.code || '');
    const settings = require('../settings');
    const verified = await settings.verifyDeleteCode(req.tenantId, code);
    if (!verified) return res.redirect('/ocular/lists?err=' + encodeURIComponent('Invalid delete code'));

    // Verify list belongs to this tenant before any DELETE.
    const own = await query(`SELECT 1 FROM lists WHERE id = $1 AND tenant_id = $2`, [id, req.tenantId]);
    if (!own.rows.length) return res.redirect('/ocular/lists?err=' + encodeURIComponent('List not found'));

    await query(`DELETE FROM property_lists WHERE list_id = $1 AND tenant_id = $2`, [id, req.tenantId]);
    await query(`DELETE FROM lists WHERE id = $1 AND tenant_id = $2`, [id, req.tenantId]);
    res.redirect('/ocular/lists?msg=' + encodeURIComponent('List deleted'));
  } catch (e) {
    console.error('[ocular/lists/delete]', e);
    res.redirect('/ocular/lists?err=' + encodeURIComponent('Failed to delete list'));
  }
});

// ─── /ocular/activity — Activity (background import jobs) ──────────────────
async function fetchActivityJobs(tenantId) {
  // bulk_import_jobs schema lives in src/import/bulk-import-routes.js's
  // ensureJobsTable — single source of truth as of audit fix L-3 (2026-04-28).
  //
  // ⚠ KNOWN COLUMN-NAME DRIFT (2026-04-29 audit follow-up): the canonical
  // ensureJobsTable defines `rows_processed / rows_created / rows_updated /
  // rows_errored / error_message / started_at` (this is what processImport
  // WRITES to). But this SELECT and src/activity-routes.js still reference
  // the LEGACY names `processed_rows / inserted / updated / errors /
  // error_log / created_at` from the pre-L-3 db.js definition. On older DBs
  // (created when db.js still had its own CREATE TABLE) the legacy columns
  // exist and this query works against them, but the writer's rows_processed
  // updates silently fail — progress never updates. On fresh DBs the legacy
  // columns DON'T exist and this SELECT throws "column does not exist".
  // Tracked as a follow-up: align readers + writers to one column set, with
  // an ALTER TABLE ... RENAME COLUMN pass to migrate existing tables.
  const r = await query(`
    SELECT j.id, j.tenant_id, j.status, j.filename, j.list_id,
           COALESCE(j.total_rows, 0)::int     AS total_rows,
           COALESCE(j.processed_rows, 0)::int AS processed_rows,
           COALESCE(j.inserted, 0)::int       AS inserted,
           COALESCE(j.updated, 0)::int        AS updated,
           COALESCE(j.errors, 0)::int         AS errors,
           j.error_log,
           j.created_at,
           l.list_name
      FROM bulk_import_jobs j
      LEFT JOIN lists l ON l.id = j.list_id AND l.tenant_id = j.tenant_id
     WHERE j.tenant_id = $1
     ORDER BY j.created_at DESC NULLS LAST
     LIMIT 50
  `, [tenantId]);
  return r.rows;
}

router.get('/activity', requireAuth, async (req, res) => {
  try {
    const { activityList } = require('./pages/activity-list');
    const jobs = await fetchActivityJobs(req.tenantId);
    const hasRunning = jobs.some(j => j.status === 'running' || j.status === 'pending');
    res.send(activityList({
      user: await getUser(req),
      jobs,
      hasRunning,
    }));
  } catch (e) {
    console.error('[ocular/activity]', e);
    res.status(500).send('Error loading activity: ' + e.message);
  }
});

// Polling endpoint for the auto-refresh script on the activity page.
router.get('/activity/poll', requireAuth, async (req, res) => {
  try {
    const { jobRow } = require('./pages/activity-list');
    const jobs = await fetchActivityJobs(req.tenantId);
    const hasRunning = jobs.some(j => j.status === 'running' || j.status === 'pending');
    res.json({ html: jobs.map(jobRow).join(''), hasRunning });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── /ocular/owners — Owners list page ─────────────────────────────────────
router.get('/owners', requireAuth, async (req, res) => {
  try {
    const { ownersList } = require('./pages/owners-list');
    const t = req.tenantId;

    // ── Parse + sanitize filter params ─────────────────────────────────────
    const q          = String(req.query.q || '').trim();
    const ownerType  = String(req.query.owner_type || '').trim();
    const minPropsRaw = String(req.query.min_props || '').trim();
    const minProps   = /^\d+$/.test(minPropsRaw) ? parseInt(minPropsRaw, 10) : null;

    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = 25;
    const offset = (page - 1) * limit;

    // ── WHERE builder ──────────────────────────────────────────────────────
    // Tenant filter is always-on; everything else stacks on top.
    const conditions = [`c.tenant_id = $1`];
    const params = [t];
    let idx = 2;

    if (q) {
      conditions.push(`(
        c.first_name ILIKE $${idx}
        OR c.last_name ILIKE $${idx}
        OR (c.first_name || ' ' || c.last_name) ILIKE $${idx}
        OR c.mailing_city ILIKE $${idx}
      )`);
      params.push(`%${q}%`); idx++;
    }
    if (['Person', 'Company', 'Trust'].includes(ownerType)) {
      conditions.push(`c.owner_type = $${idx}`);
      params.push(ownerType); idx++;
    }

    // Constrain to contacts that have at least one property link in this tenant.
    // The HAVING clause below handles the min_props filter.
    const whereSQL = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    // ── COUNT (with HAVING for min_props) ──────────────────────────────────
    // Two-step: subquery groups, outer counts. min_props applies to the
    // group-level property_count, so it has to be inside a subquery.
    const havingClause = minProps != null && minProps > 0
      ? `HAVING COUNT(pc.property_id) >= $${idx}`
      : '';
    const havingParam  = minProps != null && minProps > 0 ? [minProps] : [];

    const countRes = await query(`
      SELECT COUNT(*)::int AS n FROM (
        SELECT c.id
          FROM contacts c
          JOIN property_contacts pc ON pc.contact_id = c.id AND pc.tenant_id = c.tenant_id
          ${whereSQL}
          GROUP BY c.id
          ${havingClause}
      ) t
    `, [...params, ...havingParam]);
    const total = countRes.rows[0]?.n || 0;

    // ── ROWS ───────────────────────────────────────────────────────────────
    // Per-row aggregates: property_count, phone_total, phone_correct, lead_count.
    // Sorted by property_count DESC by default (most-portfolio first).
    const limitIdx = idx + havingParam.length;
    const offsetIdx = limitIdx + 1;
    const rowsRes = await query(`
      SELECT
        c.id,
        c.first_name,
        c.last_name,
        c.owner_type,
        c.mailing_city,
        c.mailing_state,
        COUNT(DISTINCT pc.property_id)::int AS property_count,
        (SELECT COUNT(*)::int FROM phones ph
           WHERE ph.contact_id = c.id AND ph.tenant_id = c.tenant_id) AS phone_total,
        (SELECT COUNT(*)::int FROM phones ph
           WHERE ph.contact_id = c.id AND ph.tenant_id = c.tenant_id
             AND LOWER(ph.phone_status) = 'correct') AS phone_correct,
        (SELECT COUNT(*)::int FROM properties p
           WHERE p.tenant_id = c.tenant_id
             AND p.id = ANY(ARRAY(SELECT pc2.property_id FROM property_contacts pc2
                                    WHERE pc2.contact_id = c.id AND pc2.tenant_id = c.tenant_id))
             AND p.pipeline_stage = 'lead') AS lead_count
      FROM contacts c
      JOIN property_contacts pc ON pc.contact_id = c.id AND pc.tenant_id = c.tenant_id
      ${whereSQL}
      GROUP BY c.id
      ${havingClause}
      ORDER BY property_count DESC, c.last_name ASC, c.first_name ASC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `, [...params, ...havingParam, limit, offset]);

    // ── KPIs ───────────────────────────────────────────────────────────────
    // Lightweight tenant-wide aggregates for the strip at the top.
    const kpiRes = await query(`
      SELECT
        (SELECT COUNT(DISTINCT c.id)::int
           FROM contacts c
           JOIN property_contacts pc ON pc.contact_id = c.id AND pc.tenant_id = c.tenant_id
          WHERE c.tenant_id = $1) AS total_contacts,
        (SELECT COUNT(*)::int FROM (
          SELECT pc.contact_id FROM property_contacts pc
           WHERE pc.tenant_id = $1
           GROUP BY pc.contact_id HAVING COUNT(*) > 1
        ) t) AS multi_owners,
        (SELECT COUNT(DISTINCT ph.contact_id)::int FROM phones ph
          WHERE ph.tenant_id = $1 AND LOWER(ph.phone_status) = 'correct') AS verified
    `, [t]);
    const k = kpiRes.rows[0] || {};

    const querystring = req.url.includes('?') ? req.url.split('?')[1] : '';

    res.send(ownersList({
      user: await getUser(req),
      rows: rowsRes.rows,
      total, page, limit,
      querystring,
      filters: { q, ownerType, minProps: minProps != null ? String(minProps) : '' },
      kpis: {
        totalContacts:       k.total_contacts || 0,
        multiPropertyOwners: k.multi_owners || 0,
        withVerifiedPhone:   k.verified || 0,
      },
    }));
  } catch (e) {
    console.error('[ocular/owners]', e);
    res.status(500).send('Error loading owners: ' + e.message);
  }
});

// ─── /ocular/owners/:id — Owner detail page ────────────────────────────────
router.get('/owners/:id(\\d+)', requireAuth, async (req, res) => {
  try {
    const { ownerDetail } = require('./pages/owner-detail');
    const t = req.tenantId;
    const contactId = parseInt(req.params.id, 10);
    if (!contactId) return res.status(400).send('Invalid owner id');

    // Lazy-create the two Feature 5 tables (mirrors old Loki behavior).
    // Idempotent IF NOT EXISTS — safe to run on every request.
    await query(`
      CREATE TABLE IF NOT EXISTS owner_messages (
        id SERIAL PRIMARY KEY,
        tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        author VARCHAR(100) NOT NULL DEFAULT 'Unknown',
        body TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `).catch(() => {});
    await query(`CREATE INDEX IF NOT EXISTS idx_owner_messages_contact ON owner_messages(contact_id, created_at DESC)`).catch(() => {});
    await query(`
      CREATE TABLE IF NOT EXISTS owner_activities (
        id SERIAL PRIMARY KEY,
        tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        property_id INTEGER REFERENCES properties(id) ON DELETE SET NULL,
        kind VARCHAR(50) NOT NULL,
        summary TEXT NOT NULL,
        author VARCHAR(100),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `).catch(() => {});
    await query(`CREATE INDEX IF NOT EXISTS idx_owner_activities_contact ON owner_activities(contact_id, created_at DESC)`).catch(() => {});

    // Contact row — tenant-scoped so cross-tenant id lookups 404 cleanly.
    const cRes = await query(
      `SELECT id, first_name, last_name, email, mailing_address, mailing_city,
              mailing_state, mailing_zip, owner_type, created_at
         FROM contacts WHERE id = $1 AND tenant_id = $2`,
      [contactId, t]
    );
    if (!cRes.rows.length) return res.status(404).send('Owner not found');
    const c = cRes.rows[0];

    // Properties this owner is linked to (primary OR co-owner).
    const propsRes = await query(
      `SELECT p.id, p.street, p.city, p.state_code, p.zip_code,
              p.property_type, p.pipeline_stage, p.estimated_value, p.assessed_value,
              p.last_sale_date, p.last_sale_price, p.created_at,
              pc.primary_contact, pc.role
         FROM property_contacts pc
         JOIN properties p ON p.id = pc.property_id AND p.tenant_id = pc.tenant_id
        WHERE pc.contact_id = $1 AND pc.tenant_id = $2
        ORDER BY pc.primary_contact DESC, p.created_at DESC`,
      [contactId, t]
    );
    const props = propsRes.rows;
    const propIds = props.map(p => p.id);

    // Phones for this contact.
    const phonesRes = await query(
      `SELECT id, phone_number, phone_index, phone_type, phone_status,
              wrong_number, do_not_call, created_at
         FROM phones
        WHERE contact_id = $1 AND tenant_id = $2
        ORDER BY phone_index ASC, id ASC`,
      [contactId, t]
    );
    const phones = phonesRes.rows;

    // KPIs — single query, scoped to this owner's property + phone set.
    // Param $3 was previously `props.length` but never referenced in any
    // expression of this SELECT — Postgres couldn't infer its type and threw
    // "could not determine data type of parameter $3" the first time an
    // owner detail page was actually requested. Latent since this file was
    // added; surfaced on 2026-04-29 after the 100K import created the first
    // contacts. props.length is already known in JS, so we just drop the
    // unused param and renumber tenant_id from $4 to $3.
    const kpiRes = await query(
      `SELECT
         (SELECT COUNT(*)::int FROM properties WHERE tenant_id = $3 AND id = ANY($1::int[]) AND pipeline_stage='closed')   AS sold,
         (SELECT COUNT(*)::int FROM properties WHERE tenant_id = $3 AND id = ANY($1::int[]) AND pipeline_stage='lead')     AS lead,
         (SELECT COUNT(*)::int FROM properties WHERE tenant_id = $3 AND id = ANY($1::int[]) AND pipeline_stage='contract') AS contract,
         (SELECT COUNT(*)::int FROM call_logs WHERE tenant_id = $3 AND property_id = ANY($1::int[])) AS calls,
         (SELECT COUNT(*)::int FROM phones WHERE tenant_id = $3 AND contact_id = $2) AS phone_total,
         (SELECT COUNT(*)::int FROM phones WHERE tenant_id = $3 AND contact_id = $2 AND LOWER(phone_status) = 'correct') AS phone_correct,
         (SELECT COALESCE(SUM(COALESCE(assessed_value, estimated_value, 0)), 0)::numeric
            FROM properties WHERE tenant_id = $3 AND id = ANY($1::int[])) AS total_value
      `,
      [propIds.length ? propIds : [0], contactId, t]
    );
    const kr = kpiRes.rows[0] || {};

    // Messages.
    const msgsRes = await query(
      `SELECT id, author, body, created_at FROM owner_messages
        WHERE contact_id = $1 AND tenant_id = $2
        ORDER BY created_at DESC LIMIT 100`,
      [contactId, t]
    );

    // Activity (manual entries + derived call_logs).
    const actRes = await query(
      `(
         SELECT 'manual' AS src, id, kind, summary, author, created_at, property_id
           FROM owner_activities
          WHERE contact_id = $1 AND tenant_id = $2
       )
       UNION ALL
       (
         SELECT 'call' AS src, cl.id, 'call' AS kind,
                COALESCE(cl.disposition, 'call') || COALESCE(' — ' || NULLIF(cl.campaign_name, ''), '') AS summary,
                COALESCE(cl.agent_name, 'Unknown') AS author,
                COALESCE(cl.call_date::timestamptz, cl.created_at) AS created_at,
                cl.property_id
           FROM call_logs cl
           JOIN phones ph ON ph.id = cl.phone_id AND ph.tenant_id = cl.tenant_id
          WHERE ph.contact_id = $1 AND cl.tenant_id = $2
       )
       ORDER BY created_at DESC
       LIMIT 200`,
      [contactId, t]
    );

    res.send(ownerDetail({
      user: await getUser(req),
      contact: c,
      properties: props,
      phones,
      messages: msgsRes.rows,
      activities: actRes.rows,
      kpis: {
        sold:         kr.sold || 0,
        lead:         kr.lead || 0,
        contract:     kr.contract || 0,
        calls:        kr.calls || 0,
        phoneTotal:   kr.phone_total || 0,
        phoneCorrect: kr.phone_correct || 0,
        totalValue:   kr.total_value || 0,
      },
      flash: {
        msg: req.query.msg ? String(req.query.msg).slice(0, 500) : '',
        err: req.query.err ? String(req.query.err).slice(0, 500) : '',
      },
    }));
  } catch (e) {
    console.error('[ocular/owners/:id]', e);
    res.status(500).send('Error loading owner: ' + e.message);
  }
});

// POST /ocular/owners/:id/message — post a note to the message board
router.post('/owners/:id(\\d+)/message', requireAuth, async (req, res) => {
  const contactId = parseInt(req.params.id, 10);
  if (!contactId) return res.status(400).send('Invalid owner id');
  try {
    const author = String(req.body.author || '').trim().slice(0, 100);
    const body   = String(req.body.body   || '').trim().slice(0, 4000);
    if (!author) return res.redirect(`/ocular/owners/${contactId}?err=` + encodeURIComponent('Your name is required'));
    if (!body)   return res.redirect(`/ocular/owners/${contactId}?err=` + encodeURIComponent('Message body is required'));

    // Verify the contact belongs to this tenant before writing — defense
    // against a crafted POST against a contact id that isn't ours.
    const own = await query(`SELECT 1 FROM contacts WHERE id = $1 AND tenant_id = $2`, [contactId, req.tenantId]);
    if (!own.rows.length) return res.status(404).send('Owner not found');

    await query(
      `INSERT INTO owner_messages (tenant_id, contact_id, author, body) VALUES ($1, $2, $3, $4)`,
      [req.tenantId, contactId, author, body]
    );
    res.redirect(`/ocular/owners/${contactId}?msg=` + encodeURIComponent('Note posted'));
  } catch (e) {
    console.error('[ocular/owners/:id POST]', e);
    res.redirect(`/ocular/owners/${contactId}?err=` + encodeURIComponent('Failed to post note'));
  }
});

// ─── /ocular/setup — Settings page (delete-code + change-password) ─────────
router.get('/setup', requireAuth, async (req, res) => {
  try {
    const { settingsPage } = require('./pages/settings');
    const settings = require('../settings');
    let updatedAt = null;
    let usingDefault = true;
    try {
      await settings.ensureSettingsSchema();
      updatedAt = await settings.getDeleteCodeUpdatedAt(req.tenantId);
      usingDefault = await settings.isUsingDefaultCode(req.tenantId);
    } catch (e) {
      console.error('[ocular/setup] settings load:', e.message);
    }

    // Pull the current user's email so the change-password card can show it.
    let userEmail = '';
    try {
      const r = await query('SELECT email FROM users WHERE id = $1', [req.userId]);
      if (r.rows.length) userEmail = r.rows[0].email;
    } catch (e) { /* non-fatal */ }

    res.send(settingsPage({
      user: await getUser(req),
      lastUpdatedAt: updatedAt,
      usingDefault,
      userEmail,
      flash: {
        msg:   req.query.msg   ? String(req.query.msg).slice(0, 500)   : '',
        err:   req.query.err   ? String(req.query.err).slice(0, 500)   : '',
        pwMsg: req.query.pwMsg ? String(req.query.pwMsg).slice(0, 500) : '',
        pwErr: req.query.pwErr ? String(req.query.pwErr).slice(0, 500) : '',
      },
    }));
  } catch (e) {
    console.error('[ocular/setup]', e);
    res.status(500).send('Error loading settings: ' + e.message);
  }
});

router.post('/setup/delete-code', requireAuth, async (req, res) => {
  const settings = require('../settings');
  const { old_code, new_code, confirm_code } = req.body;
  if (!old_code || !new_code || !confirm_code) {
    return res.redirect('/ocular/setup?err=' + encodeURIComponent('All fields required.'));
  }
  if (new_code !== confirm_code) {
    return res.redirect('/ocular/setup?err=' + encodeURIComponent('New code and confirmation do not match.'));
  }
  const result = await settings.updateDeleteCode(req.tenantId, old_code, new_code);
  if (!result.ok) {
    return res.redirect('/ocular/setup?err=' + encodeURIComponent(result.error));
  }
  res.redirect('/ocular/setup?msg=' + encodeURIComponent('Delete code updated successfully.'));
});

// ─── POST /ocular/setup/password — change own password ────────────────────
router.post('/setup/password', requireAuth, async (req, res) => {
  const passwords = require('../passwords');
  const emailMod  = require('../email');
  const { current_password, new_password, confirm_password } = req.body;

  const back = (msg) => res.redirect('/ocular/setup?pwErr=' + encodeURIComponent(msg));

  if (!current_password || !new_password || !confirm_password) {
    return back('All fields are required.');
  }
  if (new_password !== confirm_password) {
    return back('New password and confirmation do not match.');
  }
  const pwErr = passwords.validate(new_password);
  if (pwErr) return back(pwErr);

  try {
    const r = await query(
      `SELECT id, email, name, password_hash FROM users WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
      [req.userId, req.tenantId]
    );
    if (!r.rows.length) return back('Account not found.');
    const u = r.rows[0];
    const ok = await passwords.verify(current_password, u.password_hash);
    if (!ok) return back('Current password is incorrect.');

    const hashed = await passwords.hash(new_password);
    await query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hashed, u.id]);

    // Best-effort confirmation email.
    emailMod.sendPasswordChangedEmail(u.email, u.name).catch(() => {});

    return res.redirect('/ocular/setup?pwMsg=' + encodeURIComponent('Password updated.'));
  } catch (e) {
    console.error('[setup/password POST]', e);
    return back('Something went wrong. Please try again.');
  }
});

// ─── Placeholder routes for unbuilt pages ──────────────────────────────────
// These exist so the sidebar doesn't 404 if you click around. Each shows
// "Coming next session" until we wire up the real implementation.
//
// Note: 'lists/types' is included separately because the List Registry
// sidebar link targets /ocular/lists/types (not /ocular/lists). Without it,
// clicking List Registry in the sidebar 404s.
// All Ocular pages now have real implementations. Empty array kept so
// the loop below is a no-op rather than a code-removal that future
// merges might re-introduce a name into.
const placeholderPages = [];
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

  router.get('/' + page, requireAuth, async (req, res) => {
    res.send(shell({
      title: niceTitle,
      activePage: activeId,
      user: await getUser(req),
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

// Shared with the legacy shell so both render the same user info.
const { getUser } = require('../get-user');

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
