# Ocular SaaS — Engineering Handoff Document

**Purpose.** This document is a complete handoff for engineering. It describes what Ocular is, where the codebase stands today (April 26, 2026), the SaaS conversion plan, all architectural decisions made and the reasoning behind them, and concrete file-by-file work for each of the four implementation phases.

**Audience.** An engineer (human or AI) picking up this project cold and continuing the SaaS conversion. Read every section. The "why" matters as much as the "what" — many of these decisions will be tempting to revisit, and the reasoning is captured here so you don't re-litigate them.

**Status as of this handoff.** Phase 1 migration SQL is written and audited but **not yet run**. No SaaS code changes have been made. Ocular itself (single-tenant CRM UI built on top of Loki) is in active production use and works correctly.

---

## Table of contents

1. [Executive summary](#executive-summary)
2. [Business context](#business-context)
3. [Current state — Loki + Ocular](#current-state--loki--ocular)
4. [Architectural decisions for SaaS](#architectural-decisions-for-saas)
5. [Phase 1 — Multi-tenancy foundation](#phase-1--multi-tenancy-foundation)
6. [Phase 2 — Public signup + auth](#phase-2--public-signup--auth)
7. [Phase 3 — Stripe billing](#phase-3--stripe-billing)
8. [Phase 4 — Multi-user invites](#phase-4--multi-user-invites)
9. [Cross-cutting concerns](#cross-cutting-concerns)
10. [Out of scope for v1](#out-of-scope-for-v1)
11. [Open questions](#open-questions)
12. [Appendix — Migration SQL](#appendix--migration-sql)

---

## Executive summary

**The product.** Ocular is a CRM and lead-management platform for real estate wholesalers, lead-generation companies, and investors. It manages distressed property records, contact information, phone numbers, list memberships, distress scoring, and CSV import pipelines. Originally built as an internal tool ("Loki") for HudREI, it is being converted into a multi-tenant SaaS so other operators in the same space can use it.

**The conversion.** Loki currently has hardcoded HudREI branding and serves a single user (Wale Oladapo). The SaaS conversion is a four-phase project:

1. **Phase 1 — Multi-tenancy foundation.** Add `tenants` and `users` tables, retrofit `tenant_id` onto every existing tenant-owned table, update every SQL query to filter and insert with tenant context. Invisible to current user; under the hood, the system becomes ready to host multiple tenants.

2. **Phase 2 — Public signup + auth.** Replace the single-password gate with email/password authentication. Build a marketing landing page, signup flow with email verification, password reset, and tenant provisioning on signup.

3. **Phase 3 — Stripe billing.** Integrate Stripe Checkout for subscription start. Implement 14-day trial → paid conversion. Pricing is $299/month flat for up to 5 users + $99/additional user, with 20% off annual. Block access on payment failure.

4. **Phase 4 — Multi-user invites.** Tenant admins can invite teammates via email with role-based access (admin / operator / viewer). Activity log tracks who did what.

**Pricing model.**
- $299/month flat for up to 5 users
- $99/month per additional user
- 20% discount on annual billing
- 14-day free trial
- No usage caps in v1 (property count, phone count, list count all unlimited)

**Architecture choices.**
- **Shared database with `tenant_id` column** (not separate DBs per tenant) — chosen to reduce operational cost. Tradeoffs documented in [Architectural decisions](#architectural-decisions-for-saas).
- **Stripe** for billing.
- **Postmark** recommended for transactional email (Phase 2 dependency).
- **Railway** for hosting (Postgres + Node.js app).

**Timeline estimate.** 7–10 focused engineering sessions across all four phases. Phase 1 alone is 2–3 sessions. Realistic calendar time: 2–4 months including parallel GTM work, customer feedback, and bugs.

---

## Business context

### Why this exists

Ocular's distress-scoring, dedup pipeline, and lead-management features solve real pain for real estate wholesalers and lead-generation companies. The same problem HudREI solves internally is being solved badly (or not at all) by competitors using Excel, REIPro, ReSimpli, or hacked-together CRMs. Ocular's combination of:

- Fuzzy CSV header fingerprinting (drops the "remap every CSV manually" pain),
- Distress scoring with multi-signal weights (tax_sale, sheriff_sale, mortgage_foreclosure, county_source signals),
- Phone-status normalization with three-signal clean-phones filter,
- Per-tenant lists, tags, and campaign management,

…produces a product that wholesalers will pay $299/user/month for if positioned correctly.

### Target customers

1. **Real estate wholesalers** — operators sourcing distressed off-market properties to assign or flip.
2. **Lead-generation companies** — businesses that aggregate distress data and sell leads to investors.
3. **Real estate investors** doing significant volume — typically 50+ deals/year, multi-state.

### Founder context

Wale Oladapo runs HudREI / OOJ Acquisitions LLC. HudREI is the founding tenant of Ocular and remains the platform's primary internal use case. HudREI's data (103,278 properties, 117,000 contacts, 190,000 phone records as of April 2026) becomes tenant_id=1 after Phase 1 migration.

### Operating principles inherited from Loki

Carry these forward into Ocular SaaS. They were arrived at through real production pain in Loki:

- **No soft deletes.** Skip-and-log pattern for invalid data; deletes are real.
- **Database-clean discipline.** State abbreviations only (IN, GA), never full names. UTF-8 BOM stripped at parse sites. Phone normalization unified. UPPER/LOWER consistency on city/state.
- **Full filter parity.** Whatever filters work on the records list must also work on bulk delete, bulk export, and remove-from-list paths. No silent feature divergence between code paths.
- **Confirmation-first for non-trivial work.** Always propose a plan with options before writing code on wide-scope changes. Wale rejected this often enough that it became a working principle.
- **Comprehensive bug audits.** Pass 12 (April 2026) found and fixed 15 issues across 12 files: phone normalization unification, FK cascade safety, atomic recompute race, merge-all concurrency guard, list-creation race UPSERT, NIS date parsing, county source bonus gating, owner portfolio MV refresh paths.

These principles are why the codebase is in good shape going into the SaaS conversion. Maintain them.

---

## Current state — Loki + Ocular

### Stack

- **Runtime.** Node.js + Express
- **Database.** PostgreSQL 18.3 (on Railway)
- **Cache.** Redis (on Railway)
- **Hosting.** Railway, deployed at `hudrei-loki.up.railway.app`
- **Repo.** GitHub: `WaleHudrei/Hudrei-Data-Filter`
- **Frontend.** Server-rendered HTML/CSS, vanilla JS for interactivity (no React/Vue framework)

### Two concurrent UIs

The codebase has TWO front-end surfaces running side by side:

#### 1. Old Loki UI (untouched legacy)

Routes: `/dashboard`, `/records`, `/records/:id`, `/lists`, `/upload`, `/owners`, `/campaigns`, `/setup`, etc. This is the original HudREI internal tool. It works, it's in production, **do not modify** unless a bug is found. Wale uses it for advanced/long-tail tasks.

#### 2. New Ocular UI (SaaS-bound)

Routes mounted under `/ocular/*` — the modern UI being designed for the SaaS product. Currently has:

- **`/ocular/dashboard`** — KPI cards, distress rings, activity feed, top lists. Working with real data.
- **`/ocular/records`** — list page with top filter bar, table, bulk actions (Phase 2 of records-list, deployed). All 50 states + DC, multi-select, compact grid.
- **`/ocular/records/:id`** — property detail with 7 write actions (phone status/type, phone tag add/remove, property tag add/remove, pipeline stage). Optimistic UI with toast on revert.
- **Placeholder routes** for: `/ocular/owners`, `/ocular/campaigns`, `/ocular/lists`, `/ocular/lists/types`, `/ocular/upload`, `/ocular/activity`, `/ocular/setup`, `/ocular/settings`. These currently 404 to "coming soon."

### File structure

```
src/
├── server.js                              ── Express app entry. ~1100 LOC. Mounts all routers, runs schema init.
├── db.js                                  ── Postgres pool + initSchema(). 17+ CREATE TABLE definitions.
├── settings.js                            ── App settings (delete code). Hardcoded HudREI2026 default.
├── filtration.js                          ── Old Loki CSV filtration engine. ~85k LOC.
├── changelog.js                           ── Internal changelog rendering for /setup.
├── csv-utils.js                           ── CSV parse/dedup helpers.
├── phone-normalize.js                     ── Unified phone normalization module (Pass 12 fix).
├── shared-shell.js                        ── Old Loki shared HTML shell.
├── activity-routes.js                     ── /activity endpoint.
├── owner-type.js                          ── Owner type detection (Person/Company/Trust).
├── campaigns.js                           ── Campaign management. Creates campaigns, campaign_*, custom_list_types, nis_numbers tables.
├── maintenance.js                         ── Background maintenance tasks (phone dedup).
├── records/
│   ├── records-routes.js                  ── Old Loki records routes. ~330k LOC. Bulk endpoints live here.
│   ├── filters.js                         ── Filter-clause builder (legacy).
│   └── views/filter-panel.js              ── Old Loki filter panel template.
├── owners/
│   └── owners-routes.js                   ── /owners route. Lazy-creates owner_messages, owner_activities.
├── lists/
│   ├── lists-routes.js                    ── /lists route. Property list management.
│   └── list-types-routes.js               ── /lists/types — the List Registry feature. Creates list_templates.
├── routes/
│   └── upload-routes.js                   ── /upload main CSV upload endpoint.
├── import/
│   ├── property-import-routes.js          ── Property import pipeline. Creates mapping_templates.
│   └── bulk-import-routes.js              ── Background bulk import job runner.
├── scoring/
│   └── distress.js                        ── Distress scoring engine. Creates distress_score_log, distress_outcome_log.
├── public/                                ── Static assets for Loki UI.
└── ui/                                    ── NEW Ocular UI namespace
    ├── _helpers.js                        ── escHTML, fmtNum, fmtRelative
    ├── ocular-routes.js                   ── All /ocular/* routes
    ├── layouts/shell.js                   ── Ocular shared shell
    ├── pages/                             ── dashboard.js, records-list.js, property-detail.js
    ├── components/                        ── Server-rendered HTML components
    └── static/                            ── Client-side assets at /ocular-static/
```

### Database schema

All tenant-owned tables (will get `tenant_id` in Phase 1):

**Core:** `properties` (103,278 rows), `contacts` (~117,000), `phones` (~190,000), `property_contacts`, `property_lists`, `lists`, `markets`

**Tags:** `tags`, `property_tags`, `phone_tags`, `phone_tag_links`

**Activity / logs:** `call_logs`, `sms_logs`, `marketing_touches`, `deals`

**Filtration / imports:** `filtration_runs`, `filtration_results`, `import_history`, `bulk_import_jobs`, `list_templates`, `custom_list_types`, `mapping_templates`

**Campaigns:** `campaigns`, `campaign_uploads`, `campaign_contacts`, `campaign_numbers`, `campaign_contact_phones`

**Compliance:** `nis_numbers`, `nis_events`

**Distress scoring audit:** `distress_score_log`, `distress_outcome_log`

**Lazy-created tables (created on first use, not in initSchema):** `owner_messages`, `owner_activities` (created when /owners/:id is first visited)

**Per-tenant settings:** `app_settings` — currently `(key TEXT PRIMARY KEY, value TEXT, ...)`. Stores delete_code. **Phase 1 migration changes PK to (tenant_id, key)** so each tenant has its own delete code.

**Materialized view:** `owner_portfolio_counts` — aggregates property counts per mailing address. **Currently NOT tenant-aware. Must be rebuilt with tenant_id grouping in Phase 1 code phase.**

### Tables that will NOT get tenant_id

Intentionally global:
- **`session`** — Express session store. Sessions are per-user, tenant flows through user_id.
- **`tenants`** and **`users`** — these define the tenant relationship; can't have a tenant_id of their own.

### Authentication today

Single-password gate. Anyone with the password (env var `APP_PASSWORD`) can log in. After Phase 1 this stays the same temporarily, but session also carries `tenantId=1, userId=1, role='admin'`. Phase 2 replaces the password gate with proper email/password auth.

### Hardcoded references to remove in Phase 1 code phase

| File | Line | Content |
|---|---|---|
| `ui/ocular-routes.js` | 586 | `name: 'Wale Oladapo'` — in `getUser(req)` |
| `ui/ocular-routes.js` | 587 | `role: 'Owner · OOJ Acquisitions'` — in `getUser(req)` |
| `shared-shell.js` | 142 | `<div class="sidebar-logo-sub">OOJ Acquisitions</div>` — old Loki sidebar |
| `settings.js` | 6 | `const DEFAULT_DELETE_CODE = 'HudREI2026'` — keep as default for new tenants |
| `server.js` | 880 | `<div ...>HudREI · Indiana &amp; Georgia</div>` — old Loki dashboard |
| `server.js` | 1101 | `console.log('HudREI Filtration Bot v2 running ...')` — boot log |
| `filtration.js` | 2 | `// filtration.js — HudREI Loki` — file header comment, harmless |

The first three are user-facing and must change to read from `users.name` and `tenants.name`.

### SQL footprint for Phase 1 code update

- **84 INSERT statements** across the codebase
- **280+ SELECT statements** with `FROM` clauses
- Heaviest files (in order): `import/property-import-routes.js`, `filtration.js`, `records/records-routes.js`, `campaigns.js`, `scoring/distress.js`, `import/bulk-import-routes.js`, `owners/owners-routes.js`, `lists/list-types-routes.js`, `settings.js`, `db.js`

Every INSERT into a tenant-owned table must add `tenant_id`. Every SELECT/UPDATE/DELETE on a tenant-owned table must include `WHERE tenant_id = $tenantId` (or a join that constrains it). RLS policies (recommended addition — see below) provide a database-layer safety net.

---

## Architectural decisions for SaaS

### Decision 1 — Shared database with `tenant_id`, not separate DBs

**Decision.** All tenants share the same Postgres database. Every tenant-owned table has a `tenant_id` column. Every query filters by tenant.

**Why this and not separate DBs.**

Initially the user wanted separate databases per tenant for stronger isolation. After discussion, the decision was reversed because:

- Operationally, 50 customers means 50 DBs to migrate, monitor, back up. Each schema change becomes 50 migrations.
- Connection pooling becomes a problem (50 pools or one shared but sharded?).
- Cross-tenant analytics ("what's our average distress score across customers?") becomes impossible without a separate analytics pipeline.
- Most B2B SaaS at our scale uses shared DB + tenant_id (Stripe, Linear, Notion, Airtable all started this way).
- We can migrate big customers to dedicated DBs later as a paid feature without affecting the architecture.

**Tradeoff accepted.** A query bug that forgets `WHERE tenant_id = $current` could leak data across tenants. Mitigations:

1. The Phase 1 migration drops the `DEFAULT 1` from `tenant_id` columns after backfill, so any INSERT that forgets `tenant_id` fails immediately. This catches bugs at write time.
2. **Recommended: PostgreSQL Row-Level Security (RLS) policies** as a defense-in-depth layer. Enable RLS on every tenant table; policy reads `tenant_id` from `current_setting('app.tenant_id')`; middleware sets that setting on every request. Even if a query forgets the WHERE clause, the database refuses to return rows for the wrong tenant. **This was discussed but deferred to "after the migration runs clean."** Strongly recommended to ship before Phase 2 starts.

### Decision 2 — Pricing model

**Decision.**
- $299/month flat for up to 5 users per tenant
- $99/month per additional user beyond 5
- 20% discount on annual billing (effectively ~$240/month equivalent)
- 14-day free trial, auto-converts to paid (Stripe handles trial mechanics)
- No caps in v1 on property count, phone count, list count, CSV imports

**Why no caps.** At $299/month for 5 users, the customer expects unlimited operational use. Caps create friction at the worst time (active deal, deal closing). Add caps later only if abuse becomes a real problem.

**Why $299 base.** Comparable products: ReSimpli $99-$649, REIPro $97-$397, BatchLeads $99-$299. $299 positions Ocular competitively at the high-mid range, signaling a serious tool for serious operators.

### Decision 3 — Auth: email/password, not magic links or OAuth

**Decision.** Phase 2 implements traditional email + password auth with bcrypt password hashing. Magic-link login is a Phase 5+ enhancement; OAuth (Google/Microsoft) is not in scope.

**Why.** Wholesalers/lead-gen operators expect to log in with email + password. Magic links feel "consumer-y" and add email-deliverability dependencies on every login. OAuth requires users to have a Google/Microsoft account, which is fine for tech audiences but unreliable for the target market.

### Decision 4 — Email provider: Postmark (recommended)

**Decision.** Postmark for transactional email (password resets, invitations, billing receipts).

**Why Postmark over alternatives.**
- **Postmark:** highest deliverability for transactional. Clean dashboard. Reasonable pricing ($15/mo for 10k emails). Best onboarding experience.
- **SendGrid:** popular but oriented toward marketing email; transactional is OK but UI is cluttered.
- **AWS SES:** cheapest. Most setup work. IP reputation requires warmup. Skip until at significant scale.

**Pending.** Wale needs to create a Postmark account before Phase 2 can begin (DNS records, API key, sender domain verification — typically 1–2 days).

### Decision 5 — Stripe for billing

**Decision.** Stripe Checkout + Customer Portal for subscription management. Webhooks for payment_failed, subscription_canceled, etc.

**Why Stripe.** Industry default. Best documentation. Customer Portal lets tenants self-serve card updates and cancellation, drastically reducing support burden. Subscription scheduling (annual vs monthly) is built in.

**Implementation approach:**
- Stripe Checkout for initial subscription creation (hosted by Stripe; fewer PCI compliance concerns)
- Stripe Customer Portal for ongoing management (also hosted by Stripe)
- Webhooks for state synchronization back to our `tenants.subscription_status`
- `tenants` table gets these columns in Phase 3: `stripe_customer_id`, `stripe_subscription_id`, `subscription_status`, `trial_ends_at`, `plan`, `seat_count`

**Pending.** Wale needs to verify Stripe business account before Phase 3. Verification can take 3–7 business days.

### Decision 6 — Subdomain or path-based tenant routing?

**Decision deferred.** Both options are open:

- **Subdomain routing:** `acme.useocular.com` — feels more like a serious SaaS product, slight DNS/wildcard SSL setup work.
- **Path-based:** `useocular.com/acme/dashboard` — simpler infrastructure, no wildcard SSL.

For Phase 1 and Phase 2, neither is needed — every tenant accesses via the root domain and tenant identity comes from session, not URL. Decision can be made before Phase 4 invites.

**Recommendation when the time comes:** subdomain. Worth the DNS setup work for the product feel.

### Decision 7 — Domain name

**Pending.** Wale to choose. Suggestions: `useocular.com`, `goocular.com`, `ocular.app`, `ocularcrm.com`. Decision needed before Phase 2 (marketing landing page) ships.

### Decision 8 — Materialized view rebuild for tenant scope

**Decision.** The `owner_portfolio_counts` materialized view is currently global. In Phase 1 code phase, drop and recreate it with `tenant_id` in the GROUP BY and the unique index. Every query against the MV must filter by tenant.

**Why this matters.** This MV powers the "min owned / max owned" filter in the records list. After Phase 1 schema migration but BEFORE the MV rebuild, queries against this MV would return cross-tenant aggregations, causing UI glitches and (eventually) data leaks.

**Migration ordering:** schema migration adds `tenant_id` columns → MV rebuild happens IN the code phase, not the schema phase → code deploy uses the rebuilt MV.

---

## Phase 1 — Multi-tenancy foundation

**Goal.** Add tenant context to the schema and codebase. Invisible to existing user. Sets the stage for Phases 2–4.

**Output.** Same Ocular UI works for HudREI as before, but underneath:
- Two new tables (`tenants`, `users`) exist
- Every tenant-owned table has `tenant_id`
- Every query filters by tenant
- Sessions carry `tenantId`, `userId`, `role`
- Hardcoded HudREI branding is removed and replaced with reads from `tenants` + `users` tables

**Estimated effort.** 2–3 sessions.

### Phase 1, Step A — Schema migration

**Status: SQL written, audited, awaiting execution.**

Two SQL files in `/saas-phase1-migration/`:
1. `01-create-tenants-and-users.sql` — creates the new tables, seeds HudREI tenant + Wale user. Idempotent (safe to re-run).
2. `02-add-tenant-id-to-all-tables.sql` — adds `tenant_id` to ~32 tables, backfills with HudREI's id, builds 33 composite indexes with `CREATE INDEX CONCURRENTLY`, swaps `app_settings` PK to `(tenant_id, key)`.

Plus:
3. `99-rollback.sql` — undoes everything if needed.
4. `README.md` — operator runbook with pre-flight checklist, including: backup integrity check, disabling Railway auto-deploy during the migration window, psql fallback for Railway query UI timeouts, INVALID index detection.

**Critical operational rule:** Disable Railway auto-deploy before running migration. Step 2 drops the `DEFAULT 1` from tenant_id, so existing INSERTs will fail until code phase deploys. The window between "migration done" and "code deployed" must be minutes, not hours. No git pushes during that window.

### Phase 1, Step B — Code updates (after migration succeeds)

This is the work the engineer picks up. The migration provides the schema; this section provides the code work.

#### B.1 — Session middleware

**File:** `server.js`

**Current `requireAuth`:**
```javascript
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.redirect('/login');
}
```

**New version:** still checks `authenticated`, but also reads `tenantId`, `userId`, `role` from session and attaches to `req` for downstream use:
```javascript
function requireAuth(req, res, next) {
  if (!req.session || !req.session.authenticated) {
    return res.redirect('/login');
  }
  req.tenantId = req.session.tenantId;
  req.userId = req.session.userId;
  req.role = req.session.role;
  next();
}
```

**Login handler change:** after successful password check, populate session:
```javascript
const userResult = await query(
  'SELECT id, tenant_id, role FROM users WHERE email = $1 AND status = $2',
  ['wale@hudrei.com', 'active']
);
const user = userResult.rows[0];
req.session.authenticated = true;
req.session.userId = user.id;
req.session.tenantId = user.tenant_id;
req.session.role = user.role;
res.redirect('/dashboard');
```

**Note:** Phase 1 keeps the single-password gate. The login form submits a password, server validates, then *automatically* logs in as Wale (HudREI tenant). Phase 2 replaces this with real email/password auth.

#### B.2 — `getUser(req)` rewrite

**File:** `ui/ocular-routes.js`, around line 580.

Replace the hardcoded `name: 'Wale Oladapo'` with a query reading `users.name` and `tenants.name` based on `req.userId` and `req.tenantId`. Function becomes async — every caller needs `await getUser(req)`.

#### B.3 — Update every SQL query to filter by tenant_id

This is the mechanical bulk of Phase 1. ~280 SELECT statements and ~84 INSERT statements need updating.

**Pattern for SELECTs:** add `AND tenant_id = $N` to the WHERE clause.

**Pattern for INSERTs:** add `tenant_id` to the column list and pass `req.tenantId` as a parameter.

**Pattern for JOINs:** filter on the leftmost table. Postgres' planner handles propagation.

**File-by-file order recommended:**
1. `db.js` — schema init
2. `settings.js` — uses `app_settings`, currently fails post-migration. Highest priority.
3. `ui/ocular-routes.js` — Ocular's main router.
4. `records/records-routes.js` — bulk endpoints. Largest file.
5. `import/property-import-routes.js` — heaviest INSERT footprint
6. `filtration.js` — heavy SELECT footprint
7. `campaigns.js`, `scoring/distress.js`, `owners/owners-routes.js`, `lists/list-types-routes.js`, `import/bulk-import-routes.js`
8. Smaller files

**For each file:**
- Read every `query(SQL)` call
- Add `tenant_id` to INSERTs (column list AND values)
- Add `WHERE tenant_id = $tenantId` to every SELECT/UPDATE/DELETE
- Pass `req.tenantId` through helper functions that take a request
- Smoke-test the file's routes with HudREI session before moving to next

#### B.4 — Materialized view rebuild

Drop and recreate `owner_portfolio_counts` with `tenant_id` in the GROUP BY and unique index. Every query against the MV must filter by tenant.

#### B.5 — Settings module update

The current `INSERT INTO app_settings (key, value)` is broken after migration. Update to include `tenant_id` and use `ON CONFLICT (tenant_id, key)`.

Add a helper for getting a tenant's delete code.

#### B.6 — RLS policies (recommended addition)

Enable Row-Level Security on every tenant table. Policy says "you can only see rows where `tenant_id` matches `current_setting('app.tenant_id')`". Middleware sets that setting on every request:

```javascript
await query("SELECT set_config('app.tenant_id', $1::text, true)", [String(req.tenantId)]);
```

```sql
ALTER TABLE properties ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON properties
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id')::int);
```

This is the strongest defense against tenant-data leaks. Strongly recommended; flagged as "after migration runs clean" but should ship before Phase 2 launches.

---

## Phase 2 — Public signup + auth

**Goal.** Allow new tenants to self-serve sign up and start a trial.

**Estimated effort.** 2–3 sessions.

### Dependencies before starting

- [ ] Postmark account verified, sending domain configured
- [ ] Domain name purchased and pointed at Railway
- [ ] Phase 1 RLS policies live in production
- [ ] At least 1 beta customer ready to be the first signup test

### Schema additions

```sql
CREATE TABLE email_verification_tokens (
  token         TEXT PRIMARY KEY,
  user_id       INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE password_reset_tokens (
  token         TEXT PRIMARY KEY,
  user_id       INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN email_verified_at TIMESTAMPTZ;
```

### New routes

| Route | Purpose |
|---|---|
| `GET  /` | Marketing landing page |
| `GET  /signup` | Signup form (email, password, company name) |
| `POST /signup` | Create tenant + first user, send verification email |
| `GET  /verify-email?token=...` | Verify email, mark user active |
| `GET  /login` | Login form (replaces current single-password gate) |
| `POST /login` | Email/password authentication |
| `GET  /forgot-password` | Form |
| `POST /forgot-password` | Send reset email |
| `GET  /reset-password?token=...` | Form |
| `POST /reset-password` | Update password, invalidate token |
| `GET  /logout` | (existing, kept) |

### Signup flow

1. User visits `/signup`, enters email, password, company name.
2. Server validates: email format, password strength, company name not empty.
3. Server creates `tenants` row with auto-generated slug.
4. Server creates `users` row with bcrypt-hashed password, `role='admin'`, `status='invited'`.
5. Server creates `email_verification_tokens` row with random 32-byte hex token, 24-hour expiry.
6. Server sends verification email via Postmark.
7. User clicks link → server validates token, sets `email_verified_at = NOW()`, sets `status = 'active'`.
8. User is auto-logged in, redirected to `/dashboard`.
9. Tenant initialization creates default `app_settings` rows.

### Password requirements

- Minimum 10 characters
- Must contain at least one number AND one letter
- Block known weak passwords
- Bcrypt cost factor 12

### Marketing landing page

Separate from the app. Simple. Hero, features, pricing, signup CTA. Recommended: keep it in the Express app for v1.

---

## Phase 3 — Stripe billing

**Goal.** Tenants pay before continued use after trial.

**Estimated effort.** 2 sessions.

### Dependencies before starting

- [ ] Stripe account verified
- [ ] Stripe products + prices created in dashboard

### Schema additions

```sql
ALTER TABLE tenants ADD COLUMN stripe_customer_id      TEXT UNIQUE;
ALTER TABLE tenants ADD COLUMN stripe_subscription_id  TEXT UNIQUE;
ALTER TABLE tenants ADD COLUMN subscription_status     TEXT;
ALTER TABLE tenants ADD COLUMN trial_ends_at           TIMESTAMPTZ;
ALTER TABLE tenants ADD COLUMN current_period_end      TIMESTAMPTZ;
ALTER TABLE tenants ADD COLUMN plan                    TEXT;
ALTER TABLE tenants ADD COLUMN seat_count              INT NOT NULL DEFAULT 1;
ALTER TABLE tenants ADD COLUMN cancel_at_period_end    BOOLEAN NOT NULL DEFAULT FALSE;
```

### New routes

| Route | Purpose |
|---|---|
| `POST /billing/checkout` | Create Stripe Checkout session, return URL |
| `GET  /billing/portal` | Redirect to Stripe Customer Portal |
| `POST /billing/webhook` | Stripe webhook handler |
| `GET  /billing` | View own subscription status |
| `GET  /billing/upgrade` | Plan selection page (during trial) |

### Trial flow

- Phase 2 signup creates tenant with `subscription_status = 'trialing'`, `trial_ends_at = NOW() + 14 days`.
- During trial, app works fully. Banner shows days remaining.
- 7 days before trial ends: email reminder.
- Day of trial end: redirect to `/billing/upgrade` on next request. Tenant must enter payment.
- `/billing/checkout` creates Stripe Checkout. On success, webhook fires, `subscription_status = 'active'`.

### Webhook events to handle

- `customer.subscription.created` — sync subscription_id
- `customer.subscription.updated` — sync status, current_period_end, cancel_at_period_end
- `customer.subscription.deleted` — set status to canceled
- `invoice.payment_failed` — set status to past_due, send email
- `invoice.payment_succeeded` — set status to active

### Access gating

In `requireAuth` middleware, after tenantId is set:
```javascript
const tenant = await getTenantStatus(req.tenantId);
if (!['trialing', 'active'].includes(tenant.subscription_status)) {
  return res.redirect('/billing/upgrade');
}
```

### Per-user billing

Phase 4 adds invites. Each accepted invite increments `seat_count`. Stripe subscription quantity needs to update when `seat_count` crosses 5: $299 base for seats 1-5, $99/month each for seat 6+.

---

## Phase 4 — Multi-user invites

**Goal.** Tenant admins can invite team members.

**Estimated effort.** 1–2 sessions.

### Schema additions

```sql
CREATE TABLE invitations (
  id              SERIAL PRIMARY KEY,
  tenant_id       INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email           TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'operator',
  token           TEXT UNIQUE NOT NULL,
  invited_by      INT NOT NULL REFERENCES users(id),
  expires_at      TIMESTAMPTZ NOT NULL,
  accepted_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX invitations_tenant_id_idx ON invitations(tenant_id);
CREATE INDEX invitations_token_idx ON invitations(token);
```

### Roles

- **admin** — full access including billing, user management, delete operations
- **operator** — read/write all data, can do bulk operations, can't manage users or billing
- **viewer** — read-only

Permission enforcement is route-level middleware:

```javascript
function requireRole(...allowed) {
  return (req, res, next) => {
    if (!allowed.includes(req.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}
```

### Activity log

```sql
CREATE TABLE activity_log (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id         INT NOT NULL REFERENCES users(id),
  action          TEXT NOT NULL,
  resource_type   TEXT,
  resource_id     TEXT,
  metadata        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX activity_log_tenant_id_idx ON activity_log(tenant_id, created_at DESC);
```

Logged in `/ocular/activity` for tenant admins to review.

---

## Cross-cutting concerns

### Backups

**Pre-SaaS state:** No automated backups. Manual `pg_dump` taken April 26, 2026 saved offsite.

**SaaS requirement:** Once paying customers exist, weekly automated `pg_dump` to S3 or Backblaze. Quarterly restore drill.

**Implementation:** A simple Node.js script + cron job + AWS S3 SDK. ~50 LOC + ~$5/month for S3.

### Monitoring

**SaaS minimum viable:**
- **Uptime:** UptimeRobot or BetterStack ping `/health` endpoint every minute.
- **Errors:** Sentry or LogTail. Capture unhandled exceptions and 500-level responses.
- **Database:** Railway's built-in metrics. Track query duration on the slowest 10 queries.
- **Stripe:** Stripe dashboard for billing; webhook delivery monitor.

Costs ~$30/month combined.

### Security responsibilities

- **Password storage:** bcrypt cost 12
- **Session management:** secure cookies, httpOnly, sameSite=lax, expires 30 days
- **CSRF:** add CSRF tokens on state-changing forms (Phase 2)
- **Rate limiting:** existing `_loginRateLimit` covers login. Extend to signup, password reset.
- **SQL injection:** every query uses parameterized statements. RLS adds defense-in-depth.
- **Email enumeration:** signup/forgot-password should give generic responses regardless of whether email exists.
- **Stripe webhook signature verification:** mandatory; never skip.

### Data isolation

- Phase 1 column-level via `tenant_id` and dropped DEFAULT.
- Phase 1 (recommended add) RLS as defense-in-depth.
- Stripe customers tied to tenant via `tenants.stripe_customer_id`. No cross-tenant Stripe state leaks possible.

### Customer support

Once paying customers exist:
- **Channel:** email + in-app contact form (Phase 4). No live chat in v1.
- **SLA:** 24-hour response on weekdays.
- **Escalation:** founder owns all support in v1. Plan to delegate at 50+ customers.
- **Onboarding:** expect every new tenant to need 30-60 min of attention in week 1.

### GDPR / privacy

- Privacy policy required before public signup (Phase 2).
- "Delete my account" feature: cascade delete `tenants` row → cascades through all foreign keys.
- Data export: tenant admin can request CSV export of all their data.

---

## Out of scope for v1

These are explicitly NOT in the Phase 1-4 scope. Add to a Phase 5+ roadmap.

- **API for third-party integrations.** REST or GraphQL API for tenants to programmatically import/export. Likely Phase 6+.
- **SSO / SAML.** Enterprise feature, requires per-customer setup. Wait until enterprise customers explicitly demand it.
- **Mobile apps.** The web UI works on mobile. Native app is a major investment; defer.
- **White-labeling.** Tenants want to rebrand the app for their own use. Niche; defer.
- **Advanced analytics dashboards.** Beyond the existing `/dashboard`. Power-user feature. Defer.
- **Real-time collaboration.** "I see Bob editing this property right now." Not a wholesaling pain point.
- **Webhook outbound.** Tenants subscribing to events from their own data. Phase 6+.
- **Multi-language UI.** English only. Defer.
- **Tenant subdomain routing.** All tenants on root domain initially. Subdomain when it earns its complexity.
- **Cross-tenant analytics for the platform owner.** Build separately when needed.

---

## Open questions

These need decisions before or during implementation. Listed in approximate order they'll come up.

1. **Domain name** — needs to be purchased before Phase 2.
2. **Postmark vs SendGrid** — recommend Postmark; needs Wale's signoff and account creation.
3. **Subdomain vs path-based routing** — defer until before Phase 4. Recommended: subdomains.
4. **Per-tenant delete code default** — should new tenants get a randomly generated delete code (recommended, more secure) or share the `'HudREI2026'` default (insecure, easier)? Recommended: random.
5. **Trial: must enter card to start?** — Stripe supports both. Lower friction = no card upfront, but lower conversion. Recommended: card required at signup.
6. **Pricing display: monthly or annual default?** — annual default tilts customers toward $240/month effective (better LTV). Recommend monthly default with clear annual discount displayed.
7. **Onboarding: empty workspace or sample data?** — Recommended: empty, with prominent "Import your first list" CTA and a 5-min video.
8. **Customer success approach** — do we proactively schedule a 30-min onboarding call with every new paying customer? Founder time justified for the first 20 customers, then automate.
9. **Marketing channel** — content (SEO), paid (Google Ads), partnerships (REI groups), or product-led? Out of scope for engineering. Defer.
10. **Pricing experiments** — should the launch price be lower than $299 to gather signal, then raise? Recommended: launch at $299 from day one.

---

## Appendix — Migration SQL

The complete SQL for Phase 1 schema migration. These files are also delivered separately; included here for self-containment.

### `01-create-tenants-and-users.sql`

```sql
-- Creates tenants + users tables, seeds HudREI tenant.
-- Idempotent — safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS tenants (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  slug            TEXT UNIQUE NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tenants_slug_format CHECK (
    slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'
  ),
  CONSTRAINT tenants_status_valid CHECK (status IN ('active', 'suspended', 'canceled'))
);

CREATE INDEX IF NOT EXISTS tenants_status_idx ON tenants(status);

CREATE TABLE IF NOT EXISTS users (
  id              SERIAL PRIMARY KEY,
  tenant_id       INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email           TEXT NOT NULL,
  password_hash   TEXT,
  name            TEXT,
  role            TEXT NOT NULL DEFAULT 'admin',
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at   TIMESTAMPTZ,
  CONSTRAINT users_email_per_tenant UNIQUE (tenant_id, email),
  CONSTRAINT users_role_valid CHECK (role IN ('admin', 'operator', 'viewer')),
  CONSTRAINT users_status_valid CHECK (status IN ('active', 'invited', 'disabled'))
);

CREATE INDEX IF NOT EXISTS users_tenant_id_idx ON users(tenant_id);
CREATE INDEX IF NOT EXISTS users_email_idx ON users(LOWER(email));

INSERT INTO tenants (id, name, slug, status)
  VALUES (1, 'HudREI', 'hudrei', 'active')
  ON CONFLICT (id) DO NOTHING;

SELECT setval('tenants_id_seq', GREATEST(1, (SELECT COALESCE(MAX(id), 1) FROM tenants)), true);

INSERT INTO users (id, tenant_id, email, name, role, status)
  VALUES (1, 1, 'wale@hudrei.com', 'Wale Oladapo', 'admin', 'active')
  ON CONFLICT (id) DO NOTHING;

SELECT setval('users_id_seq', GREATEST(1, (SELECT COALESCE(MAX(id), 1) FROM users)), true);

SELECT id, name, slug, status FROM tenants;
SELECT id, tenant_id, email, name, role FROM users;

COMMIT;
```

### `02-add-tenant-id-to-all-tables.sql`

Long file. See `/saas-phase1-migration/02-add-tenant-id-to-all-tables.sql` for the full SQL. Summary:

1. Pre-flight: verify tenant id=1 is HudREI.
2. Helper function `_add_tenant_id(table_name)`:
   - Skip if table doesn't exist (lazy-created tables).
   - Skip if column already exists (idempotent).
   - Add column with `NOT NULL DEFAULT 1` (Postgres 11+ metadata-only optimization, no table rewrite).
   - Drop the default.
   - Add foreign key constraint to tenants.
3. Apply helper to 32 tables.
4. Update `app_settings` PRIMARY KEY from `(key)` to `(tenant_id, key)`.
5. Drop helper function.
6. Commit.
7. Outside transaction: `CREATE INDEX CONCURRENTLY` on `tenant_id` for each of 31 tables that don't have a composite-PK-covering index already.
8. Verification queries:
   - Check 1: every table has `tenant_id` column.
   - Check 2: every existing row has `tenant_id = 1` (HudREI).
   - Check 3: indexes exist.
   - Check 4: no INVALID indexes from CONCURRENTLY failures.

### `99-rollback.sql`

Restores `app_settings.key` PRIMARY KEY. Drops `tenant_id` from every table. Drops `tenants` and `users` tables. Returns DB to pre-Phase-1 state.

---

## Recommended next steps for Claude Code (or whoever picks this up)

1. **Read this entire document** before making any changes. The "why" decisions matter.
2. **Verify backup exists** at `loki-pre-saas-backup-2026-04-25.sql` (119 MB, on Wale's laptop and offsite).
3. **Coordinate the migration window with Wale.** 30-minute uninterrupted block. Disable Railway auto-deploy first.
4. **Execute Phase 1, Step A** — run the two SQL files in order. Verify all four checks pass.
5. **Execute Phase 1, Step B** — code updates. File-by-file. Smoke test each.
6. **Add RLS policies** before Phase 2 begins. Strong recommendation, not optional in spirit.
7. **Stop after Phase 1** — confirm with Wale before starting Phase 2. Get customer feedback in parallel.
8. **Phases 2-4 in sequence**, not parallel. Each phase is a deployable, testable milestone.

---

**End of document.**

For questions or clarifications during implementation, contact Wale Oladapo (wale@hudrei.com). For architectural decisions not covered here, default to the principle: "what's safest for tenant data isolation?" then "what's simplest to operate?" then "what's fastest to implement?" In that order.
