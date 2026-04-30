# Loki Feature Inventory (Commit 0d79f14)

Comprehensive checklist of user-visible features in Loki at the reference commit. Use this to identify what's missing or changed in the current Ocular UI.

---

## Authentication & Shell

**Routes:**
- `GET /login` — login form (single password)
- `POST /login` — authenticate via `APP_PASSWORD` env var
- `GET /logout` — destroy session and redirect to /login

**Features:**
- Session-based auth with configurable session secret (Redis-backed or in-memory)
- Rate-limited login attempts
- HTTPS-only secure cookies in production
- Shared navigation shell with page title, sidebar nav, and breadcrumbs

**Sidebar Navigation:**
- List Filtration Bot (home)
- Campaigns
- Records
- Lists
- Import Property
- Import Bulk
- Activity
- Owners
- NIS
- Changelog
- Settings / Security

---

## Filtration Pipeline (Core `/` and `/upload/`)

**Root Page: `GET /`**
- **Purpose:** Main "List Filtration Bot" dashboard — drop Readymode call log CSVs
- **UI Elements:**
  - Campaign selector dropdown (required before upload allowed)
  - Drag-drop file zone (disabled until campaign selected)
  - File input with click-to-browse
  - Upload progress spinner

**Memory Display:**
- Lists in memory count
- Phone numbers tracked count
- Memory persistence status badge (Redis connected or "will reset on restart")

**Memory Operations:**
- `GET /memory/export` — download filtration memory as JSON backup
- `POST /memory/import` — restore from JSON backup file
- `POST /memory/clear` — clear all memory (with confirmation)

**Upload Routes: `/upload/*`**
- `GET /upload` — choose filtration type (Filter vs Property)
- `GET /upload/filter` — Step 1: upload CSV
- `GET /upload/filter/map` — Step 2: auto-map columns to REISIFT_FILTER_FIELDS
- `GET /upload/filter/review` — Step 3: preview + review before processing
- `POST /upload/filter/parse` — parse CSV, return columns and rows
- `POST /upload/filter/process` — execute filtration, return clean/filtered rows
- Same pattern for `/upload/property/*` (distinct field set for property imports)

**Upload Processing:**
- Auto-detects phone columns from CSV headers
- Normalizes phone numbers (strips non-digits, leading 1 if 11 digits, handles extensions)
- Normalizes state codes (recovers state from ZIP if column is garbage)
- Two-output flow:
  - **Filtered output** (REISift) — records to update phone status/tags per campaign
  - **Clean output** (Readymode) — records passing all filters, ready for re-upload
- Memory-based deduplication across uploads (per campaign scope)

**Memory Scope:**
- Keyed by `campaign_id||list_name` (or synthetic scope for legacy uploads)
- Tracks phone numbers seen across all uploads to same campaign
- Auto-prevents re-processing same phones when re-uploading the same list

**Downloads:**
- `GET /download/filtered` — download filtered tab as CSV
- `GET /download/clean` — download clean tab as CSV
- `GET /download/campaigns/:id/clean` — campaign-scoped clean export for Readymode

---

## Campaigns (`/campaigns/` and `/campaigns/:id`)

**Campaign List: `GET /campaigns`**
- Lists all active + completed campaigns
- Columns: name, state, list type, market, status, created date
- Buttons: New Campaign, View Detail
- Pagination if needed

**Campaign Creation: `GET /campaigns/new` + `POST /campaigns/new`**
- Form fields:
  - Campaign name
  - Market name
  - State (dropdown)
  - List type (Cold Call / SMS / Direct Mail / PPL / Referral / etc.)
  - Notes
- Creates entry in `campaigns` table

**Campaign Detail: `GET /campaigns/:id`**
- **Campaign header:** Name, status (active/completed), created date
- **Buttons/Actions:**
  - Rename campaign (modal dialog)
  - Change active channel (Cold Call vs SMS)
  - Close campaign (mark completed)
  - New round (duplicate campaign state for next cycle)

**KPI Cards:**
- SMS mode: Upload count, wrong numbers, not interested, leads generated, callable, W#%, NI%, LGR%, LCV%, health%
- Cold Call mode: Call logs, connected, wrong numbers, not interested, leads, callable, filtration runs, CLR%, CR%, W#%, NI%, LGR%, LCV%, health%

**Contact List Section:**
- Upload original contact list (CSV with auto-detect of all columns)
- Sync wrong numbers button (apply historical wrong-number flags to master list)
- Download clean export (Readymode format)
- Stats: total properties, accepted by Readymode, total phones, wrong numbers, NIS flagged, confirmed correct, contacts reached
- Edit Readymode count (manual override for contacts accepted by Readymode)

**SMS Campaign Specific:**
- Upload SmarterContact SMS results (separate from contact list)

**Filtration Upload Section:**
- Drop zone for Readymode CSV (channel selector if cold_call only)
- Live results table with two tabs:
  - Filtered → REISift (records to update phone status/tags)
  - Clean → Readymode (passing records)
- Stats: uploaded, kept, filtered, lists in file, caught by memory

**Filtration History Table:**
- Columns: date, file/source list, channel, total, kept, filtered, breakdown, memory catches, actions
- Shows all uploads against this campaign with cumulative stats

**Status Controls:**
- `POST /campaigns/:id/status` — change campaign status
- `POST /campaigns/:id/channel` — change active channel (cold_call or sms)
- `POST /campaigns/:id/rename` — rename campaign (modal form)

**Contact Management:**
- `POST /campaigns/:id/contacts/upload` — upload contact list
- `POST /campaigns/:id/contacts/delete` — delete master contact list (confirmation required)
- `POST /campaigns/:id/sms/upload` — upload SMS results (SMS campaigns only)

**Phone Number Tracking:**
- `campaign_numbers` table: tracks phone numbers per campaign, last disposition, status (callable/filtered/wrong/etc.), cumulative call count, phone tag, marketing result

**API:**
- `GET /api/campaigns` — JSON list of campaigns for dropdown/selection

---

## Records (`/records/` and detail pages)

**Records List: `GET /records`**
- Searchable, filterable list of properties
- **Filters (query params):**
  - `list_id` — scope to specific list
  - Distress/risk filters
  - Owner type (Person / Company / Trust)
  - Pipeline stage (lead / contract / closed / etc.)
  - Market / state filters
  - Custom tag filters
  - Phone status (correct / wrong / do_not_call / etc.)
  - Date range filters

**Display:**
- Columns: address, owner name, owner type, distress score, pipeline stage, last updated, actions
- Pagination
- Bulk action bar (appears when rows selected)
- Row selection checkboxes

**Bulk Actions:**
- Add tag to selected records
- Change pipeline stage
- Assign to list
- Export selected as CSV
- Delete selected (requires delete code verification for 10+)
- Merge duplicates (requires delete code)

**Record Detail Page: `/records/:id`**
- Property header with address, county, market, estimated value
- Owner information: name, email, mailing address, owner type
- Distress score breakdown (rings + percentile)
- Phone numbers table with:
  - Phone number
  - Phone type (mobile/landline)
  - Status (correct/wrong/do_not_call/unknown)
  - Tags
  - Last call date
  - Call count
  - Actions (edit, tag, delete)
- Connected contacts (co-owners, other names for same property)
- Pipeline stage and notes
- Activity timeline (recent changes, calls logged, tags added)
- Message board / notes section
- Call logs linked to this property

**Features:**
- Tag system (property tags + phone tags kept separate)
- Distress scoring module (computed from property data)
- Owner occupancy detection (by comparing property address to mailing address)
- Pipeline stages: lead, contract, sold, inactive, etc.
- Export options: filtered list to CSV, detailed property report

---

## Imports (`/import/property/` and `/import/bulk/`)

### Property Import (`/import/property/`)

**Flow:**
1. `GET /import/property` — upload form
2. `POST /import/property/parse` — parse CSV, detect columns, suggest mapping
3. `POST /import/property/preview` — show mapped rows before import
4. `POST /import/property/start` — begin background import job

**Features:**
- **Column mapping templates:**
  - Auto-save mapping fingerprint (header hash → saved mapping)
  - Auto-apply mapping on subsequent uploads with same fingerprint
  - Manual column-to-field override
- **Field normalization:**
  - State code cleanup (recovers from ZIP if column garbage)
  - Phone normalization (shared across all import paths)
  - Property type inference
  - Vacant flag boolean conversion
  - Money/year/date validation with overflow protection (clamp to NULL)
- **CSV upload:**
  - Up to 600 MB file size
  - File type validation (.csv/.txt or common MIME types)
  - Memory streaming (staged to temp disk file, not held in memory)

**Background Job Tracking:**
- Job status: pending / running / complete / error
- Progress bar (processed_rows / total_rows)
- Inserted / updated / error counts
- Error log display (warnings for completed jobs, full errors for failed jobs)

**Database Operations:**
- UPSERT semantics: properties by (state, county, zip, street); contacts by (mailing zip + address hash)
- Batch processing (500 rows per batch) for speed
- Phone insertion with type detection
- Owner-portfolio materialized view refresh on completion

### Bulk Import (`/import/bulk/`)

**Similar to Property Import but for REISift bulk exports:**
- Column mapping with templates
- Multi-round batch processing
- Larger file support (600 MB)
- Same phone normalization and state cleanup

---

## Activity Page (`/activity/`)

**Purpose:** Dashboard for background import jobs

**Display:**
- List of recent import jobs (up to 50, newest first)
- "Import running…" badge if jobs pending/running
- `+ New Import` button

**Job Table Columns:**
- Filename
- List name (linked to records list filtered by that list)
- Status (⏳ pending / 🔄 running / ✅ complete / ❌ error) with color coding
- Progress bar (percentage + row count)
- Results: inserted, updated, errors
- Started timestamp (relative time)
- "View List" link (if job produced a list)

**Error Handling:**
- Warning blocks (orange) for jobs with errors but status=complete (some rows skipped)
- Error blocks (red) for jobs with status=error (full crash)
- Error log displayed inline (first 500 chars, truncated with "…")

**Auto-Refresh:**
- Poll `/activity/status` every 2 seconds while jobs are running
- Stop polling when all jobs are complete
- `GET /activity/job/:id` — single job status query (for integration)

---

## Lists (`/lists/`)

**Purpose:** Manage imported property lists

**Lists Page: `GET /lists`**
- Search by list name
- Pagination (50 per page)
- Columns:
  - List name (clickable → `/records?list_id=:id`)
  - Type badge (Cold Call / SMS / Direct Mail / PPL / Referral / etc.) with color coding
  - Source
  - Property count
  - Created date
  - Actions: View, Edit, Delete

**List Actions:**
- **Edit modal** — update:
  - List name
  - List type (dropdown)
  - Source
  - Active flag
- **Delete** — confirmation required, redirects with success message
- **View** — navigate to records filtered by this list

**Inline Feedback:**
- Success messages after save or delete (with `?msg=` query param)
- Empty state if no lists yet

---

## Owners Dashboard (`/owners/:id`)

**Purpose:** Aggregate all properties and contacts linked to one person

**Owner Detail Page: `GET /owners/:id`**
- Owner name (first + last or "(no name)")
- Contact info: email, mailing address

**KPIs (card grid):**
- Property count
- Sold count
- Lead count
- Contract count
- Call count
- Phone total / Phone correct (with verified %)
- Total investment (sum of assessed/estimated property values)

**Tabs:**
1. **Properties:** Table of all properties linked to owner
   - Columns: address, city, state, type, pipeline stage, estimated value, last sale, primary vs co-owner role
2. **Phones:** Table of contact's phone numbers
   - Phone number
   - Type (mobile/landline/unknown)
   - Status (correct/wrong/do_not_call/unknown)
   - Do-not-call flag
   - Created date
3. **Message Board:** Free-text notes with author and timestamp
   - Add new message form
4. **Activity Log:** Audit log of changes
   - Kind: pipeline change, phone edit, call logged, etc.
   - Summary
   - Author
   - Timestamp

**Lazy-Created Tables:**
- `owner_messages` — message board posts
- `owner_activities` — audit log entries

---

## NIS (Not-In-Service) Numbers (`/nis/`)

**Purpose:** Flag dead numbers across all campaigns

**NIS Page: `GET /nis`**
- Upload form for Readymode Detailed NIS CSV exports
- Required columns: "dialed" (phone), "day" (NIS date)

**Stats Display:**
- Total NIS numbers in database
- Flagged phones across all campaigns
- Last upload timestamp

**Upload Handler: `POST /nis/upload`**
- Parse CSV with "dialed" and "day" columns
- Insert into master NIS table
- Automatically flag matching phones in all `campaign_numbers` and `campaign_contact_phones` rows
- Return result message: rows processed, unique NIS numbers, inserted/updated counts, flagged phones count

**Features:**
- NIS numbers apply globally to all campaigns
- Once flagged, phones excluded from "clean" exports
- Persistent NIS list survives across campaigns

---

## Settings & Security (`/settings/security`)

**Purpose:** Manage delete code that gates destructive operations

**Delete Code:**
- Default: `HudREI2026` (shipped in repo)
- Required before:
  - Deleting 10+ records
  - Bulk merging duplicate groups
  - Clearing record batches
- Constant-time string comparison to prevent timing attacks

**UI Elements:**
- Current code input (password field)
- New code input (minimum 6 characters)
- Confirm new code input
- Last updated timestamp
- Warning banner if using default code (with SQL reset instructions)

**Form: `POST /settings/security/delete-code`**
- Verify old code matches stored value
- Validate new code (6+ chars)
- Update `app_settings` table
- Redirect with success/error message

---

## Dashboard / Statistics

**Dashboard Page: `GET /dashboard`**
- Overview KPIs across all campaigns
- Campaign status summary
- Recent activity snapshot
- Links to common actions

**API Endpoint: `GET /api/dashboard-stats`**
- JSON response with top-level metrics
- Used for dashboards and integrations

---

## Memory System

**Purpose:** Prevent re-processing same phone numbers across uploads to same campaign

**Storage:**
- Redis-backed (if `REDIS_URL` env set) — survives deploys
- Falls back to in-memory store (resets on restart, warning logged)
- Session store uses same Redis instance (if available)

**Key Structure:**
- `hudrei:filtration:memory` — JSON object
- Keys: `list_name||phone_number`
- Values: disposition, first seen, last seen, cumulative count

**Operations:**
- `GET /memory/export` — download entire memory as JSON
- `POST /memory/import` — restore from JSON file
- `POST /memory/clear` — flush all keys
- Auto-loaded before each filtration run
- Auto-saved after processing

---

## Changelog

**Route: `GET /changelog`**
- Renders audit log of recent fixes and features
- Sourced from `src/changelog.js`
- User-visible release notes

---

## Common UI Patterns

**Buttons & Controls:**
- Primary button: black background, white text
- Secondary button: gray background, dark text
- Danger button: light red background, red text
- Ghost button: transparent with border
- Inline buttons: small, within table rows or action bars

**Forms:**
- POST only (no PUT/PATCH)
- Inline validation and error messages
- Confirmation dialogs for destructive actions
- Success redirects with `?msg=` query param

**Tables:**
- Striped rows (alternating background on hover)
- Sortable headers (where applicable)
- Pagination links (← Prev / Next →)
- Bulk action checkbox column

**Modals:**
- Modal overlay with semi-transparent backdrop
- Close button (× icon top-right)
- Form fields stacked vertically
- Submit + Cancel buttons

**Color Coding:**
- Green (#1a7a4a): success, correct, active
- Red (#c0392b): danger, errors, wrong numbers
- Blue (#2c5cc5, #185fa5): info, details
- Amber/Gold (#9a6800): warnings, neutral counts
- Gray (#888, #aaa): secondary text, disabled

---

## Navigation & Routes Summary

| Feature Area | Routes |
|--------------|--------|
| Auth | `/login`, `/logout` |
| Filtration | `/`, `/upload/*`, `/download/*`, `/memory/*`, `/process` |
| Campaigns | `/campaigns`, `/campaigns/new`, `/campaigns/:id`, `/api/campaigns` |
| Records | `/records`, `/records/:id`, `/setup/*` |
| Lists | `/lists` |
| Import Property | `/import/property/*` |
| Import Bulk | `/import/bulk/*` |
| Activity | `/activity`, `/activity/status`, `/activity/job/:id` |
| Owners | `/owners/:id` |
| NIS | `/nis` |
| Settings | `/settings/security` |
| Changelog | `/changelog` |
| Dashboard | `/dashboard`, `/api/dashboard-stats` |

---

## Key Technical Features

**Session Management:**
- Express session with Redis or in-memory store
- HTTPS-only, HttpOnly, SameSite=lax cookies
- 8-hour max age
- Fallback to MemoryStore with warning if Redis unavailable

**File Upload:**
- Multer with file type validation (.csv/.txt by extension and MIME)
- Memory storage (streamed for large imports)
- 50 MB limit for most uploads (600 MB for bulk imports)
- BOM stripping for UTF-8 CSVs

**Normalization & Validation:**
- Phone number: strips non-digits, removes leading 1 if 11 digits, handles extensions
- State codes: uppercase 2-letter, recovers from ZIP if garbage, rejects invalid
- Money values: bounded range (max $9.99B), NULL if overflow
- Years: 1800–2200 range
- Bathrooms: 0–99 range
- Dates: ISO 8601 format

**Performance:**
- Batch processing (500 rows per batch)
- UNNEST for bulk inserts/updates (vs row-by-row)
- Materialized view refresh after bulk imports
- Market cache (state_code → market_id) survives across jobs

**Security:**
- Rate-limited login
- Delete code verification (constant-time comparison)
- HTML escaping for user input
- SQL parameterized queries
- Production hardening (rejects default credentials on boot)

---

## Setup Routes (`/setup/*`)

Reserved for initial application setup or admin tasks. Content not extensively detailed in commit but referenced in routes mount.

---

## Notes for Ocular Comparison

1. **Memory System:** Loki has sophisticated memory-based deduplication per campaign. Verify Ocular preserves this or provides equivalent.

2. **Two-Output Filtration:** The core feature is "filtered out" vs "clean" — REISift vs Readymode. Ocular should maintain this UX.

3. **Campaign Scoping:** All filtration, uploads, and phone tracking is scoped to campaigns. Properties/contacts are separate (cross-campaign).

4. **Status Fields:** Campaigns track cold_call_status and sms_status separately; records track pipeline_stage (lead/contract/sold/inactive).

5. **Phone Normalization:** Single source of truth in `src/phone-normalize.js` — all four prior implementations (filtration, campaigns, property-import, bulk-import) were unified to this shared function.

6. **NIS System:** Global list of dead numbers that flags phones across ALL campaigns. Not campaign-specific.

7. **Owner Type Inference:** Contacts auto-classified as Person / Company / Trust during import.

8. **Distress Scoring:** Property distress calculated and stored; visible on records list and detail.

9. **Owner-Portfolio MV:** Materialized view for fast owner KPI queries (refreshed after bulk imports).

10. **Delete Code:** Single code gates all destructive ops. No per-user permissions; shared across all operators.

