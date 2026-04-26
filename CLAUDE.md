# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

HudREI List Filtration Bot ("Loki"). Internal Node.js/Express tool for the HudREI cold-calling team. Two intertwined responsibilities:

1. **Filtration**: ingest Readymode call-log CSV exports, apply SOP filtration rules (see README.md), and emit two outputs — a "Filtered → REISift" update file and a "Clean → Readymode" file. Cumulative cross-upload memory survives dialer resets.
2. **Property records system ("Phase 2")**: a CRM-like property/contact/phone/list/campaign data model, populated by additional CSV importers (PropStream, REISift bulk) and surfaced under `/records`, `/owners/:id`, `/lists`, `/campaigns`, etc.

The repo has **no test suite, no lint config, and no build step**. Code ships directly via Railway (Nixpacks).

## Commands

```bash
npm start          # runs `node src/server.js` — same as `npm run dev`
npm run dev        # alias for start; there is no nodemon/watcher
```

Local development requires (at minimum) `DATABASE_URL` pointing at a Postgres instance. `REDIS_URL` is optional locally but strongly recommended in production (sessions + filtration memory).

There is no test runner, no linter, no formatter, and no TypeScript. Don't add a "run the tests" step to verify changes — there's nothing to run.

### One-time scripts (do NOT run in deploy pipelines)

```bash
CONFIRM_MIGRATION=yes node src/migrate-properties.js   # backfills properties/contacts/phones from filtration_results
LOKI_DEDUP_PHONES=confirm node src/server.js           # actually merge phone-shared duplicate contacts (default = report-only)
```

`migrate-properties.js` exits 1 unless `CONFIRM_MIGRATION=yes` is set — by design. Phone dedup runs every boot in `report` mode (logs would-be merges); set `LOKI_DEDUP_PHONES=confirm` once to actually merge, then unset.

## Environment variables

- `DATABASE_URL` — Postgres connection string. Railway hosts get `?sslmode=require` automatically; the `pg` Pool detects "railway" in the URL and turns on `rejectUnauthorized: false`.
- `REDIS_URL` — optional. When set, used for both `connect-redis` session store (`loki:sess:` prefix) and the filtration memory cache (`hudrei:filtration:memory`). When missing in production, server logs a warning and falls back to in-memory MemoryStore (sessions die on every deploy).
- `APP_USERNAME` / `APP_PASSWORD` — single-user basic auth. **Production boot fails fast** if `APP_PASSWORD === 'changeme123'` (the dev default).
- `SESSION_SECRET` — same fail-fast guard against the baked-in default.
- `NODE_ENV=production` — flips on cookie `secure`, the prod-secret guards, and the trust-proxy assumption (Railway/Cloudflare TLS termination).
- `PORT` — defaults to 3000.
- `LOKI_DEDUP_PHONES` — `report` (default) | `confirm` | `skip`. See `src/maintenance.js`.
- `LOKI_BATCHED_FILTRATION`, `LOKI_CLEANUP`, `LOKI_STATE_FIX` — feature/maintenance flags consulted at boot.

## Architecture

### Single-process Express app, monolithic `server.js`

`src/server.js` is ~2,500 lines and owns: auth, top-level routes, the campaign UI, the call-log filtration pipeline (`processCSV` → `saveRunToDB`), startup orchestration, and most HTML rendering for the legacy filtration pages. New features are split into per-domain routers and mounted from the bottom of `server.js`:

```
app.use('/upload',   uploadRoutes)            // routes/upload-routes.js — multi-step CSV upload UI
app.use('/records',  slice1Records)           // records/records-routes.js — properties list + detail
app.use('/setup',    setupRoutes)             // records/setup-routes.js
app.use('/lists',    listsRoutes)             // lists/lists-routes.js (+ list-types-routes.js)
app.use('/import/property', importRoutes)     // import/property-import-routes.js — PropStream / REISift property CSV
app.use('/import/bulk',     bulkImportRoutes) // import/bulk-import-routes.js   — REISift contacted-lead reconciliation
app.use('/activity', activityRoutes)
app.use('/owners',   ownersRoutes)            // owners/owners-routes.js
app.use('/ocular',   ocularRoutes)            // ui/ocular-routes.js — newer UI surface
```

There is **no view engine**. HTML is built with backtick-tagged template strings; `src/shared-shell.js` exports `shell(title, body, activePage)` which produces the sidebar + outer chrome shared across pages. The newer "ocular" UI lives in `src/ui/{components,layouts,pages,static}/` and is the direction new pages should follow.

### Data layer

- All Postgres access goes through `src/db.js` (`query`, `pool`, `initSchema`, `refreshOwnerPortfolioMv`). Don't construct `new Pool()` elsewhere — `migrate-properties.js` is the only exception and is a one-shot script.
- Schema is **created and migrated idempotently inside `initSchema()`** using `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, and a chain of try/catch'd `ALTER`/`CREATE INDEX` blocks. There are **no separate migration files**. To add a column: add it to the `CREATE TABLE` block AND add an `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for in-place upgrades.
- `_schemaReady` is a module-level flag — `initSchema()` runs at most once per process. Other domains have parallel ensure-functions: `campaigns.initCampaignSchema()`, `scoring/distress.ensureDistressSchema()`, `settings.ensureSettingsSchema()`. All four run in parallel via `Promise.allSettled` inside `app.listen`'s callback — schema failure does not block boot.
- `owner_portfolio_counts` is a materialized view. Refresh after big property imports via `refreshOwnerPortfolioMv()`.
- Two tables (`owner_messages`, `owner_activities`) are still **lazy-created on first visit to `/owners/:id`** and have not been moved into `initSchema` yet — known follow-up item.

### Performance pattern: bulk UNNEST upserts

The historic shape of write paths was N+1 (one `SELECT` + one `INSERT/UPDATE` per row). Both `saveRunToDB` (server.js) and `recordUpload` (filtration.js) were rewritten to a multi-pass structure where each pass is **one** bulk SQL using `UNNEST($1::text[], $2::int[], …)`. Same idea is repeated across `property-import-routes.js`, `bulk-import-routes.js`, and `records/records-routes.js`. When you add a write path, follow this pattern — N+1 in a 10k-row upload regresses Railway timeouts.

### COALESCE safe-merge UPSERT pattern

Every importer treats blank source fields as "don't overwrite":

```sql
INSERT ... ON CONFLICT (...) DO UPDATE
SET col = COALESCE(EXCLUDED.col, properties.col)
```

This means re-uploading the same address with new fields fills gaps without clobbering existing data. When you add a new column to an importable table, plumb it through the `UNNEST` arrays AND add the `COALESCE(EXCLUDED.x, table.x)` line to the `ON CONFLICT` clause. Missing the second step silently drops data on re-import.

### Single-source-of-truth helpers (don't reintroduce duplicates)

These exist because multiple in-tree implementations had drifted in subtly broken ways. Always import from these:

- `src/phone-normalize.js` — `normalizePhone(raw)` and `normalizePhoneStrict(raw)`. Strips extensions, drops international, normalizes `1-NPA-NXX-XXXX` → `NPANXXXXXX`. Four older copies existed and only one stripped the leading `1`.
- `src/import/state.js` — `normalizeState(raw)` returns valid 2-letter USPS code or `null`. **Caller must treat null as "skip row"**, not as a fallback to `slice(0,2)`.
- `src/import/zip-to-state.js` — derive state from ZIP when state is missing.
- `src/owner-type.js` — `inferOwnerType(first, last)` classifies Person / Company / Trust from name patterns. Used at every contact insert site.
- `src/csv-utils.js` — `bufferToCsvText(buf)`, `stripBom`. Always parse uploaded CSVs through this; raw `buf.toString()` re-introduces BOM-prefix bugs.

### Filter parity rule (hard requirement)

The `/records` page exposes ~30 filters. Each bulk action (export, delete, tag, remove-from-list, add-to-list) has its own "selectAll" SQL handler that re-applies the same filter set server-side. **Every filter must be implemented identically across every selectAll path.** When you add a filter, search `records-routes.js` for an existing filter name (e.g. `mkt_result`) and add yours at every site. Drift here means "Manage → Add to List" silently mutates more rows than the user saw on screen — exactly the class of bug the changelog repeatedly cites.

### `changelog.js` is the release log, not a docs file

`src/changelog.js` exports a hand-edited `ENTRIES` array rendered at `/changelog`. **Prepend new entries to the top** as features ship. Each entry has `{ date, title, items: [{ tag, text }] }` where `tag` is `feat` | `fix` | `note`. This is the canonical record of audit fixes — when investigating odd code, search this file for the relevant decision history before assuming a pattern is accidental.

### Auth & sessions

Single-user gate. `requireAuth` middleware (defined in `server.js` and re-defined in each sub-router because cross-imports were avoided) checks `req.session.authenticated`. `app.set('trust proxy', 1)` is required for Railway TLS termination — don't remove it. Cookie is `httpOnly`, `sameSite: 'lax'`, `secure` only in production. **There are no CSRF tokens** on POST routes — see the April 21, 2026 changelog `note` for the rationale (app-wide refactor required, SameSite=lax is the current mitigation).

### CSV upload guardrails

Two `multer` instances exist (one in `server.js`, one in `routes/upload-routes.js`). **Both** must use the same fileFilter (extension + MIME check) and 50 MB limit. A non-CSV upload reaching `Papa.parse` returns 0 rows with no error — wasted operator time, which is what fix #21 / #43 were about.

### Production hardening that breaks if removed

- The fail-fast guards on default `APP_PASSWORD` / `SESSION_SECRET` in production.
- `connect-redis` import is wrapped in try/catch with three module-shape detections (`mod.RedisStore` | callable default | `mod.default.RedisStore`) — different `connect-redis` versions ship differently.
- `_schemaReady` / `_distressSchemaReady` / `_ensured` idempotency flags. Removing them re-introduces multi-second DDL latency on every request.
- `pg` Pool capped at `max: 20` to stay under Railway's connection cap.

## Style notes specific to this codebase

- New domain code goes in subdirectories under `src/` (`records/`, `owners/`, `lists/`, `import/`, `scoring/`, `ui/`). New top-level files in `src/` should be reserved for cross-cutting helpers like `phone-normalize.js`.
- HTML escape with `escHTML`/`escAttr` (defined in `shared-shell.js` / domain routers). User-supplied tag/note text has historically been the XSS source.
- Inline styles are heavily used in older pages; the newer `src/ui/static/ocular.css` is the migration target.
- Cache-bust client JS via `?v=N` query strings (e.g. `records-list.js?v=5`). Bump on change.
- All numeric CSV inputs go through bounded coercion helpers (`toMoney`, `toYear`, `toSmallInt`, `toBathrooms`, `toPercent`) defined in the importers — never hand a raw `parseFloat`/`parseInt` result to Postgres without a NaN guard, or the whole batch fails.
