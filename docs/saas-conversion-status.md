# SaaS Phase 1 — Status

**Last updated:** end of session, 2026-04-28
**Branch:** `claude/verify-staging-migration-Qw1zm`
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
- **Step B (code phase):** ~60% done. Plan was 5 commits (1 → 5); we shipped
  the equivalent of 1, 2, 3a, 3b, 3c. Commits 4 and 5 remain.

What works on staging right now:
- Login (one-time re-login required after first deploy because old sessions
  don't carry `tenantId`)
- Ocular dashboard, records list, property detail
- Settings (delete code change)
- CSV imports — both the foreground `/import/property` flow and the REISift
  bulk reconciliation `/import/bulk` flow
- Readymode call-log filtration via `/process`
- Campaign creation, contact list upload, SMS uploads, NIS uploads
- Distress rescoring (runs after each filtration save)
- Boot-time phone dedup maintenance

What's not yet wired:
- The Records page filters and bulk actions (delete, export, tag, remove-from-list,
  add-to-list). They still query without `WHERE tenant_id`. Phase 1 is
  one tenant so nothing leaks today, but the guards aren't there.
- Owners pages, Lists routes, Upload routes, Activity routes — same situation.
- The `owner_portfolio_counts` materialized view is still global. Min-owned
  filter would mix tenants once a second tenant exists.
- RLS policies — not added yet.
- Hardcoded "HudREI / OOJ Acquisitions" strings in older Loki HTML still
  present (only the Ocular UI got the dynamic `getUser()`).

---

## Commits in this session (in order)

```
34c79e3  tenant context plumbing in auth middleware
dde7074  fix boot-blocking files (db, settings, ocular UI)
d17a806  tenant-aware mapping_templates + fix markets seed
87d01ab  CSV import paths (property + REISift bulk)
59009bb  filtration save path (filtration.js + saveRunToDB)
3841581  campaigns + distress + maintenance
```

### What each commit changed in plain English

**1. Auth middleware** — every `requireAuth` (11 copies across routers) now
reads `tenantId / userId / role` from the session and bounces sessions that
don't carry `tenantId` to `/login`. The login handler does a DB lookup for
`wale@hudrei.com` after a successful password match and populates the session.

**2. Boot-blocking files** — `db.js` got `tenants` and `users` CREATE TABLE
at the top of `initSchema`, plus `tenant_id` baked into the 16 tables this
file owns (no-op on staging because the migration already added them; matters
for fresh installs and Phase 2 new tenants). `settings.js` rewritten to
require a `tenantId` arg on every public function and seed default rows
per-tenant via a new `provisionTenantSettings()`. `ui/ocular-routes.js`
got an async `getUser()` that reads from `users` + `tenants` (no more
hardcoded "Wale Oladapo / OOJ Acquisitions"), and every Ocular query
filters by `tenant_id`.

**3a. CSV imports** — `property-import-routes.js` and `bulk-import-routes.js`
thread `req.tenantId` through every INSERT and lookup in the synchronous
commit path and the background job runner. Background jobs read `tenant_id`
from the `bulk_import_jobs` row when the in-memory caller arg is missing.
Module-level market cache is now per-tenant (different tenants have
different `market_id` for the same state code).

**3b. Filtration save path** — `filtration.js` public functions
(`recordUpload`, `importNisFile`, `recordSmsUploadEvent`,
`importSmarterContactFile + Bulk + PerRow`, `importSmarterContactAccepted`,
`getNisStats`) now require `tenantId` as the first arg.
`server.js::saveRunToDB` likewise. INSERTs into `filtration_runs`,
`filtration_results`, `markets`, `lists`, `properties`, `property_lists`,
`contacts`, `property_contacts`, `phones`, `call_logs`,
`campaign_numbers`, `campaign_uploads`, `nis_events`, `nis_numbers`
all carry `tenant_id`. NIS retroactive flagging scoped to tenant.

**3c. Campaigns + scoring + maintenance** — `campaigns.js` CREATE TABLE
blocks for `campaigns`, `campaign_uploads`, `campaign_numbers`,
`campaign_contacts`, `campaign_contact_phones`, `custom_list_types`,
`nis_numbers` all include `tenant_id`. Public CRUD functions all require
`tenantId`. `scoring/distress.js` log-table writes derive `tenant_id`
from the property row (so signatures stay clean). `maintenance.js`
phone-dedup groups by `(tenant_id, phone_number)` so cross-tenant
contacts can never be merged.

---

## What remains (Commits 4 and 5)

### Commit 4 — read paths + bulk endpoints

Files in scope:
- `records/records-routes.js` (5,308 lines — the big one)
- `owners/owners-routes.js` (also lazy-creates `owner_messages` and
  `owner_activities`; needs `tenant_id` in those CREATE TABLEs)
- `lists/lists-routes.js`, `lists/list-types-routes.js`
- `routes/upload-routes.js`
- `activity-routes.js`
- `records/setup-routes.js` (cleanup of any remaining bare queries)

Critical: the **filter parity rule** from `CLAUDE.md`. Every filter on the
`/records` page is re-applied server-side on each bulk action (export,
delete, tag, remove-from-list, add-to-list). Tenant scoping has to be
threaded into every filter AND every selectAll path. If they drift, "Manage
→ Add to List" silently mutates more rows than the user saw on screen.

Recommended split for next session:
- **4a** — `records-routes.js` alone
- **4b** — owners + lists + upload + activity + setup

### Commit 5 — MV rebuild + RLS + branding cleanup

- Drop and recreate the `owner_portfolio_counts` materialized view with
  `tenant_id` in the GROUP BY and the unique index. Every query against
  the MV must filter by tenant.
- Add Row-Level Security policies on every tenant table. Middleware sets
  `current_setting('app.tenant_id')` per request. This is the
  defense-in-depth that backstops the gaps left by Phase 1's pragmatic
  shortcuts (see "Known gaps" below).
- Remove remaining hardcoded "HudREI / OOJ Acquisitions" strings:
  `shared-shell.js:142`, `server.js:880`, `server.js:1101`. Keep
  `settings.js` `'HudREI2026'` only as the default for new tenants.

---

## Known gaps left in the code

These are deliberate Phase 1 shortcuts. They're safe today (HudREI is the
only tenant) but need to be cleaned up before Phase 2 launches a second
tenant. Each is flagged with a comment in the code.

1. **`mapping_templates` UNIQUE constraint** is single-column on `fingerprint`.
   Two tenants can't share a fingerprint. ON CONFLICT keys assume single
   tenant. Should become `UNIQUE(tenant_id, fingerprint)`.

2. **`markets` UNIQUE constraint** is single-column on `state_code`. Each
   tenant gets their own market rows seeded for HudREI; new tenants would
   collide on the unique. Should become `UNIQUE(tenant_id, state_code)`.

3. **`lists.list_name` UNIQUE constraint** is single-column. Should become
   `UNIQUE(tenant_id, list_name)` so two tenants can both have a list named
   "Tax Sale".

4. **`bulk_import_jobs` schema collision** (pre-existing, not caused by
   this work) — `db.js` and `import/bulk-import-routes.js::ensureJobsTable`
   define the same table with different columns. Whichever runs first wins.
   Out of scope for SaaS; flag for general cleanup.

5. **SMS UPDATE paths in `filtration.js`** that touch `phones.phone_status`
   and `properties.pipeline_stage` resolve through `campaign_contact_phones`
   via id-only subqueries. Cross-tenant in theory; safe today; RLS in
   commit 5 backstops.

6. **Distress dashboard read functions** (`getScoreDistribution`,
   `getConversionByBand`, `getSignalCoverage`, etc.) aggregate over all
   properties without a `WHERE tenant_id`. Used by the Records dashboard
   which is in Commit 4's scope; address there.

7. **`scoring/distress.js::scoreAllProperties`** rescores every row in the
   database. Should become a per-tenant operation (or document that it
   intentionally crosses tenants for backfills).

8. **All boot-time maintenance** (`db.js` garbage-state cleanup,
   `campaigns.js` ccp dedup, owner-type backfill) operates globally.
   Acceptable for boot operations; document that they're cross-tenant by
   design.

---

## How to resume next session

1. Verify staging is still green after the four 3a/3b/3c deploys. Try
   uploading a small CSV via `/import/property`, run a Readymode filtration
   via `/`, log a campaign upload. Confirm nothing regressed.
2. Pick up Commit 4 — start with `records-routes.js`. Read
   `CLAUDE.md`'s "Filter parity rule" section first.
3. Each filter has at least 5 places it lives: the GET handler,
   the `selectAll` builder, and the bulk endpoints (export / delete /
   tag / remove-from-list / add-to-list). Each one needs `WHERE tenant_id =
   $tenantId`. Search for an existing filter (e.g. `mkt_result`) to see
   the pattern.
4. After Commit 4, run a smoke test on staging: filter the records list,
   then run "Manage → Tag" to confirm the bulk action acts on the same
   rows that were displayed.
5. Then Commit 5 (MV + RLS + branding cleanup).
6. Once Phase 1 is verified end-to-end on staging, plan the production
   migration as a separate, coordinated session: disable Railway
   auto-deploy, run the SQL migration, verify, then re-enable
   auto-deploy. The window between "production schema migrated" and
   "Phase 1 code deployed to production" must be measured in minutes —
   any code path that doesn't pass `tenant_id` will fail with a NOT NULL
   violation as soon as the schema migration drops the `DEFAULT 1`.

---

## Where the code is

- All work on branch `claude/verify-staging-migration-Qw1zm`, pushed
  to GitHub.
- Each commit is small enough to revert individually if anything regresses.
- No production secrets touched. No production database touched.
