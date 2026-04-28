# SaaS Phase 1 — Status

**Branch:** `staging`
**Pushed to:** GitHub → staging auto-deploy
**Production:** untouched

This is a working status doc, not a redesign. The full plan lives in
[saas-conversion-plan.md](./saas-conversion-plan.md). Read this first to know
where we are; read that for the why.

---

## Where we are

Phase 1 = "make the schema and code tenant-aware before public signup."

- **Step A (schema migration):** done on staging. 34 tables have `tenant_id`,
  every existing row backfilled to HudREI (`tenant_id=1`), composite indexes
  built. Production DB **not migrated yet**.
- **Step B (code phase):** ~95% done. All Commits 1 through 5 (except RLS)
  shipped. RLS is deferred — see "Known gaps" below.

## What works on staging

Every read and write across both UIs (old Loki + Ocular) is tenant-aware:
- **Auth:** login looks up `wale@hudrei.com`, populates session with
  `{tenantId, userId, role}`. Old sessions without `tenantId` redirect to login.
- **Ocular UI** — every sidebar page (Dashboard, Records, Owners, Campaigns,
  Lists, List Registry, Activity, Upload, Settings, NIS, Changelog) filters
  by `req.tenantId`.
- **Old Loki UI** — same treatment. Records list, bulk actions (export, delete,
  bulk-tag, remove-from-list, add-to-list), single-property detail/edit/delete,
  tag operations, manual property creation, owners detail, lists, list registry,
  setup, activity, NIS, changelog all scope by tenant.
- **Write paths** — CSV imports (property + REISift bulk), filtration
  (`saveRunToDB`), campaigns, distress scoring, phone dedup, NIS uploads.
- **Materialized view `owner_portfolio_counts`** — rebuilt with `tenant_id`
  in the GROUP BY and the unique key. The min-owned/max-owned filter in
  records is now correctly per-tenant.
- **Bulk action intake validation** — every bulk handler that accepts
  user-supplied `ids` now filters them through a tenant-scoped SELECT, so
  a crafted POST can't target another tenant's properties.
- **HudREI branding removed** from the old Loki dashboard subtitle and the
  boot log. `'HudREI2026'` stays as the default delete code seed for new
  tenants — it's not user-facing branding.
- **Ocular UI body restyle** — every old-Loki page now renders inside the
  Ocular shell (one unified chrome). Major pages (changelog, NIS, campaigns,
  upload flows, import flows) have been restyled with Ocular components.

## What's NOT done

1. **Row-Level Security (RLS) is deferred.** Originally part of Commit 5,
   but turned out to require a query-helper refactor to actually work — the
   pg pool gives a fresh connection per `query()` call, so a `set_config`
   in middleware doesn't persist to the connection that runs queries. Making
   RLS actually enforce requires every `query()` to wrap in `BEGIN; SELECT
   set_config('app.tenant_id', $tenantId, true); …; COMMIT;`. That's a
   refactor on its own. **For Phase 1 with one tenant, RLS isn't needed.**
   Before Phase 2 launches a second tenant, this should be addressed.

2. **A handful of admin routes** (`/_state_cleanup`, `/_distress`,
   `/_duplicates` in `records-routes.js`) still operate globally without
   tenant scoping. They're maintenance ops invoked by admins, not regular
   user routes. Safe in Phase 1; need scoping for Phase 2.

3. **Production schema migration.** Staging has the SaaS schema; production
   doesn't. **30-min coordinated session** required: disable Railway
   auto-deploy, run `01-create-tenants-and-users.sql` then
   `02-add-tenant-id-to-all-tables.sql`, verify the four checks in section
   2's verification block, re-enable auto-deploy.

4. **No way to create a second tenant via UI.** Currently HudREI is the
   only tenant. Adding more requires raw SQL (`INSERT INTO tenants…
   INSERT INTO users…`). Phase 2 (signup form) solves this.

## Commits this session

```
1   tenant context plumbing in auth middleware
2   fix boot-blocking files (db, settings, ocular UI)
3a  CSV import paths (property + REISift bulk)
3b  filtration save path (filtration.js + saveRunToDB)
3c  campaigns + distress + maintenance
+   build Ocular Owners list/detail + Settings pages
+   build Ocular Activity, Lists, List Registry, Campaigns,
    Upload chooser pages
+   re-skin shared-shell.js to render through Ocular shell
+   restyle /changelog, /nis bodies + factor getUser
+   add NIS Numbers and Changelog to Ocular sidebar
+   restyle /campaigns/new + redirect old /campaigns to Ocular
+   restyle /campaigns/:id detail page
+   restyle /upload/filter step pages
+   restyle /import/property + /import/bulk
+   make Ocular sidebar collapse button more obvious
4a  tenant_id baseline on /records GET + dropdown queries
4b  tenant_id through bulk-action handlers + intake validation
4c  tenant_id through single-property + tag handlers
4d  tenant_id through owners + lists + list-types + activity + setup
5   owner_portfolio_counts MV rebuild with tenant_id;
    drop HudREI branding from old dashboard + boot log
```

---

## Known gaps left in the code

These are deliberate Phase 1 shortcuts. They're safe today (HudREI is the
only tenant) but need to be cleaned up before Phase 2 launches a second
tenant. Each is flagged with a comment in the code or noted here.

1. **RLS not enforced** — see "What's NOT done" #1. The application-level
   `WHERE tenant_id = $X` clauses are the primary defense; RLS is the
   missing safety net.

2. **`mapping_templates` UNIQUE constraint** is single-column on
   `fingerprint`. Should become `UNIQUE(tenant_id, fingerprint)` so two
   tenants can share a fingerprint.

3. **`markets` UNIQUE constraint** is single-column on `state_code`. Each
   tenant gets their own market rows; new tenants would collide. Should
   become `UNIQUE(tenant_id, state_code)`.

4. **`lists.list_name` UNIQUE constraint** is single-column. Should
   become `UNIQUE(tenant_id, list_name)` so two tenants can both have a
   list named "Tax Sale".

5. **`bulk_import_jobs` schema collision** — `db.js` and
   `import/bulk-import-routes.js::ensureJobsTable` define the same table
   with different columns. Whichever runs first wins. Pre-existing,
   unrelated to SaaS work but should be cleaned up.

6. **Admin routes still global** — `_state_cleanup`, `_distress`,
   `_duplicates` in `records-routes.js`. Maintenance ops; not user-facing.

7. **Distress dashboard read functions** in `scoring/distress.js`
   (`getScoreDistribution`, `getConversionByBand`, etc.) aggregate
   without tenant scoping. Used by Records dashboard; safe in Phase 1.

8. **`scoring/distress.js::scoreAllProperties`** rescores every row in the
   database. Should become per-tenant or document that it intentionally
   crosses tenants for backfills.

9. **All boot-time maintenance** (`db.js` garbage-state cleanup,
   `campaigns.js` ccp dedup, owner-type backfill) operates globally.
   Acceptable for boot operations; document that they're cross-tenant
   by design.

---

## How to resume next session

If you're picking up cold:

1. **Verify staging is green.** Try uploading a small CSV via
   `/import/property`, run a Readymode filtration via the dashboard, log
   into a campaign. Confirm nothing regressed.
2. **Run the production schema migration.** See
   [`saas-phase1-migration/README.md`](../saas-phase1-migration/README.md)
   for the runbook. Disable Railway auto-deploy first; the window between
   "production schema migrated" and "Phase 1 code deployed to production"
   should be measured in minutes — any code path that doesn't pass
   `tenant_id` will fail with a NOT NULL violation as soon as the schema
   migration drops the `DEFAULT 1`.
3. **Decide on RLS.** Either ship the query-helper refactor that wraps
   each call in BEGIN/SET LOCAL/COMMIT, or skip RLS and ship Phase 2 now.
   The plan says "strongly recommended before Phase 2." Honest read: the
   application-level filters are thorough and audited; RLS would be
   defense-in-depth, not a primary defense.
4. **Then Phase 2.** Per the plan: schema additions
   (`email_verification_tokens`, `password_reset_tokens`), signup flow,
   email verification, password reset, replace single-password gate with
   email/password auth. Postmark account + domain name needed before
   shipping to public.
