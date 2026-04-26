# Phase 1 Migration — Operator Runbook

This folder contains the SQL that bootstraps multi-tenancy on the Loki/Ocular database. Read this entire file before running anything.

## What's in here

| File | What it does |
|---|---|
| `01-create-tenants-and-users.sql` | Creates `tenants` and `users` tables. Seeds HudREI as tenant id=1 and Wale as user id=1. Safe to re-run. |
| `02-add-tenant-id-to-all-tables.sql` | Adds `tenant_id` to all 34 existing tenant-owned tables. Backfills every row to tenant_id=1. Builds composite indexes. |
| `99-rollback.sql` | Reverses everything. Drops the column from every table; drops `users` and `tenants`. |
| `README.md` | This file. |

## What this migration does, in plain English

Right now your database has tables like `properties`, `contacts`, `phones`, etc. Every row in those tables implicitly belongs to HudREI, because there's only one customer. After this migration:

- A new `tenants` table exists with one row: HudREI.
- A new `users` table exists with one row: Wale.
- Every row in every existing table gains a `tenant_id` column pointing back to HudREI.
- Future inserts that forget to specify `tenant_id` will fail loudly instead of silently writing to HudREI's data.

Visible to a logged-in user: **nothing changes**. The app keeps working exactly as it did. This migration is purely a foundation for Phase 1 Step B (the code changes that come next).

## Where to run this

**Always staging first.** Always.

| Environment | Branch | When to run | Risk |
|---|---|---|---|
| Staging | `staging` | First. As many times as you want. | None — staging data is fake/empty. |
| Production | `main` | Only after staging is verified, code is ready, and a backup exists. | High — touches 103k+ rows. Requires a maintenance window. |

## ── STAGING RUN (first attempt) ──

### Pre-flight checklist

- [ ] You're connected to **staging**, not production. Triple-check the database URL.
- [ ] Staging app is currently running (so the schema has been initialized — the migration assumes the existing tables already exist).

### How to run

There are two ways. Pick one.

**Option A — Railway's database query UI (easiest):**

1. In Railway, switch to the `staging` environment (top-left dropdown).
2. Click on the **Postgres** service.
3. Open the **Query** or **Data** tab.
4. Paste the contents of `01-create-tenants-and-users.sql`. Run it. Confirm the verification SELECTs at the bottom show 1 tenant and 1 user.
5. Open `02-add-tenant-id-to-all-tables.sql`. **You can only run PART A through the Railway UI** — it has the transaction. Copy lines from the top through `COMMIT;` (around line 145).
6. For PART B (the `CREATE INDEX CONCURRENTLY` block), Railway's query UI may time out on long-running statements. If it does, fall back to Option B for that part only.

**Option B — psql from your laptop (more reliable):**

1. Get the staging database connection string from Railway → Postgres service → Connect tab.
2. Run:
   ```bash
   psql "$STAGING_DATABASE_URL" -f 01-create-tenants-and-users.sql
   psql "$STAGING_DATABASE_URL" -f 02-add-tenant-id-to-all-tables.sql
   ```
3. Each file prints `NOTICE` messages as it works. Read them — they're useful confirmation that each table was processed.

### After running — verification

Run these four queries against staging. The expected results are noted.

**Check 1 — every table has tenant_id:**
```sql
SELECT table_name FROM information_schema.columns
 WHERE column_name = 'tenant_id' AND table_schema = 'public'
 ORDER BY table_name;
```
Expect ~32-34 rows (lazy-created tables only show up if they've been created).

**Check 2 — every existing row was backfilled:**
```sql
SELECT tenant_id, COUNT(*) FROM properties GROUP BY tenant_id;
```
Expect a single row: `tenant_id=1, count=<staging row count>`. (On staging this will be 0 unless you've added test data.)

**Check 3 — no broken indexes:**
```sql
SELECT indexrelid::regclass AS index_name
  FROM pg_index
 WHERE NOT indisvalid;
```
Expect zero rows. Any results here mean a `CREATE INDEX CONCURRENTLY` was interrupted — see "Recovery" below.

**Check 4 — app_settings PK was swapped:**
```sql
SELECT conname, pg_get_constraintdef(oid)
  FROM pg_constraint
 WHERE conrelid = 'app_settings'::regclass AND contype = 'p';
```
Expect: `PRIMARY KEY (tenant_id, key)`.

### After verification — smoke test

The staging app is still running on the old code (which doesn't know about `tenant_id`). The schema now requires `tenant_id` on every INSERT. **The app will start failing on any write operation until Phase 1 Step B (code changes) is deployed.**

That's expected. Step B is the next thing to do. Don't panic if you visit the staging URL right now and see errors on writes.

## ── PRODUCTION RUN ──

### Do not run on production until ALL of these are true

- [ ] Staging migration was run, all 4 verification checks passed.
- [ ] Staging app code (Phase 1 Step B) is updated, deployed, and working with the new schema.
- [ ] You did a smoke test of the staging app: log in, view a property, create a list, do a CSV import. Everything still works.
- [ ] A fresh `pg_dump` of production has been taken **today** and saved offsite.
- [ ] You're prepared for a 30-minute window where production might briefly fail writes.
- [ ] Railway auto-deploy is **disabled** for production (so a stray git push doesn't deploy old code mid-migration).

### The order matters

1. **Disable Railway auto-deploy on the production environment.** (Settings → Service → toggle off.)
2. Run `01-create-tenants-and-users.sql` against production.
3. Run `02-add-tenant-id-to-all-tables.sql` PART A against production.
4. Verify checks 1, 2, 4 pass (skip check 3 — indexes haven't been built yet).
5. **Deploy the Phase 1 Step B code to production immediately.** This is the gap window — every minute the schema requires `tenant_id` but the code doesn't supply it, every write fails.
6. Re-enable Railway auto-deploy.
7. Run PART B (the `CREATE INDEX CONCURRENTLY` block) against production. This is non-blocking and can run while the app is live.
8. Run check 3 to confirm no broken indexes.

## Recovery

### "I see an INVALID index in check 3"

A `CREATE INDEX CONCURRENTLY` was interrupted (network drop, query timeout, etc.). The index didn't finish but a stub was created.

```sql
-- Find the broken index name from check 3 above. Then:
DROP INDEX <index_name>;
-- Then re-run just the failed CREATE INDEX CONCURRENTLY statement.
```

### "I want to undo the whole migration on staging"

Run `99-rollback.sql`. It drops `tenant_id` from every table and removes `users` + `tenants`. **Do not run this on production after Phase 1 Step B code has been deployed** — the running app needs `tenant_id` to function.

### "The migration failed partway through Part A"

Part A is wrapped in a single transaction, so failure rolls back automatically. The database is back to its pre-migration state. Read the error message, fix it, re-run.

### "The migration failed partway through Part B"

Each `CREATE INDEX CONCURRENTLY` is its own implicit transaction. Some indexes may have been built successfully; others not. Re-running the file is safe — the `IF NOT EXISTS` clauses skip already-built indexes. Only INVALID indexes (see above) need manual cleanup.

## Why this script exists in this form

The plan document (`/docs/saas-conversion-plan.md`) explains the architectural reasoning. Three details worth re-emphasizing here:

1. **`DEFAULT 1` then `DROP DEFAULT`** — this is the safety mechanism. After the migration, any INSERT that forgets `tenant_id` fails immediately. That's catching bugs at the database layer before they leak data.

2. **Lazy-created tables** — `owner_messages` and `owner_activities` only exist after someone visits an owner's page. The helper function skips them if absent. They'll get `tenant_id` automatically when `initSchema()` next runs (after Phase 1 Step B is deployed and the schema definition includes the column).

3. **`CREATE INDEX CONCURRENTLY`** — non-blocking index builds. This is why Part B is outside the transaction — Postgres requires it. The tradeoff is recovery complexity (INVALID indexes need manual cleanup), but it's worth it on production where blocking the table for index builds would mean downtime.
