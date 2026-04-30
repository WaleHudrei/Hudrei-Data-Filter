# Loki Feature Inventory — Commit 0d79f14

This document captures the **user-visible features** of Loki at git commit 0d79f14 (April 17–21, 2026). Use this as a checklist to identify what's missing in the current Ocular UI.

## 1. Filtration Pipeline

**Routes:** `/` (GET), `/process` (POST), `/download/filtered` (GET), `/download/clean` (GET)

**Core Flow:**
- User selects a campaign from a dropdown (required before upload)
- Drop zone accepts Readymode call log export CSVs
- Uploads via `/process` endpoint
- Filtration engine categorizes each record based on disposition rules
- Applies memory (historical phone number tracking across campaigns)

**Outputs (Two CSVs):**
1. **Filtered → REISift** (phone status/tags updated per list disposition breakdowns)
2. **Clean → Readymode** (passed all filters, ready for re-upload)

**Disposition Rules (SOP Reference Table on page):**
- **Transfer** (any) → Remove (marked as lead)
- **Not Interested** (3+ logs) → Remove + tag
- **Do Not Call** (any) → Remove + tag
- **Wrong Number** (any) → Remove (phone status = Wrong)
- **Spanish Speaker** (any) → Remove
- **Voicemail** (4+ logs) → Remove + tag
- **Hung Up** (4+ logs) → Remove + tag
- **Dead Call** (4+ logs) → Remove + tag
- **Not Available** (4+ logs) → Remove + tag
- **Callback** (any) → Keep

**Results Display:**
- Stats cards: Total, Lists detected, Kept, Filtered, Caught by memory
- List chips showing per-list keep/filter counts + top 3 dispositions
- Tabbed tables (Filtered vs. Clean) with preview
- Download buttons for both outputs

## 2. Memory Operations

**Routes:** `/memory/export` (GET), `/memory/import` (POST), `/memory/clear` (POST)

**Features:**
- Displays current memory size (number of tracked phone numbers)
- Displays number of unique lists tracked
- **Export** as JSON backup file
- **Import** from previously exported JSON
- **Clear** all memory (with confirmation)
- Redis status indicator: shows if memory is persistent or will reset on restart

## 3. Records

**Route:** `/records` (GET)

**List View Features:**
- Paginated records table (50 per page)
- Search by text query
- **Filters:**
  - City, ZIP, County
  - Property type, Pipeline stage
  - Stack list (list_id) — multi-checkbox
  - Minimum stack count
  - Marketing result (multi-value)
  - Property status
  - Assessed/estimated value range (min/max)
  - Equity range
  - Year built range
  - Upload date range
  - Distress score minimum
  - Owner occupancy (Owner Occupied / Absent Owner / Unknown)
  - Phone count
  - Years owned range
  - Owner type
  - Mailing address match (toggle)
  - **Property tags** (single select)
  - **Phone type** (Mobile / Landline / VoIP / Unknown)
  - **Phone tags** (single select)
- Bulk actions (via checkbox select):
  - Add/remove tags (modal with color picker)
  - Merge duplicates (10+ requires delete code confirmation)
  - Export selected
  - Delete selected
  - Mark Right For List (RFL)
- Column sorting
- Row selection (individual + select-all)
- Detail view via row click

## 4. Owners

**Route:** `/owners/:id` (GET)

**Owner Dashboard:**
- Contact info card with phone/email
- **KPIs:** Property count, Sold count, Lead count, Contract count, Total call logs, Phone verification %
- Investment value (sum of property assessed/estimated values)
- **Properties tab:** All properties linked to this owner (primary + co-owner roles)
- **Message board:** Free-text notes (author, timestamp)
- **Activity log:** Union of owner_activities table + derived call log events
- Message post form + edit/delete per message

## 5. Lists

**Route:** `/lists` (GET), `/lists/edit` (POST), `/lists/delete` (POST), `/lists/types` (routes)

**Lists Page:**
- Paginated list table (50 per page)
- Search by list name
- Columns: Name, Type, Source, Property count, Created date
- **Type colors** (badges): Cold Call (blue), SMS (green), Direct Mail (orange), PPL (red), Referral (purple), Driving for Dollars (pink)
- **Sources:** PropStream, DealMachine, BatchSkipTracing, REISift, DataSift, Listsource, Manual
- Actions per list: View, Edit, Delete
- **Edit modal:** Update name, type, source
- **Delete modal:** Confirmation + delete code entry

**List Types Management:**
- `/lists/types` — manage custom list type definitions

## 6. Campaigns

**Routes:** `/campaigns` (GET), `/campaigns/new` (GET/POST), `/campaigns/:id` (GET), `/campaigns/:id/upload` (POST), `/campaigns/:id/contacts/upload` (POST), `/campaigns/:id/status` (POST), `/campaigns/:id/channel` (POST), `/campaigns/:id/rename` (POST), `/campaigns/:id/close` (POST), `/campaigns/:id/new-round` (POST), `/campaigns/:id/contacts/delete` (POST), `/campaigns/:id/sms/upload` (POST), `/campaigns/:id/sync-wrong-numbers` (POST), `/campaigns/:id/readymode-count` (POST), `/campaigns/:id/export/clean` (GET), `/campaigns/:id/reset` (POST), `/campaigns/:id/delete` (POST)

**Campaign List:**
- List all campaigns with status badge
- New campaign button

**Campaign Detail Page:**
- **Header:** Campaign name (editable via modal), status, market, list type, created date
- **Channel selector:** Toggle between Cold Call / SMS (affects upload flow + KPI display)
- **Status indicators:** Cold Call status, SMS status badges
- **KPIs (dynamic by channel):**
  - SMS: SMS uploads, Wrong numbers, Not interested, Leads generated, Callable
  - Cold Call: Call logs, Connected, Wrong numbers, Not interested, Leads generated, Callable, Filtration runs
- **KPI metrics:** W#%, NI%, LGR, LCV, Health (% callable)
  - Additional (Cold Call only): CLR, CR

**Contact List Section:**
- Total contacts, Accepted by Readymode (editable count), Total phones, Wrong numbers, NIS flagged, Confirmed correct, Contacts reached %
- Upload master contact list (CSV) — auto-detects columns + phone numbers
- Delete master list button
- (SMS only) Upload SmarterContact SMS results CSV

**Filtration Upload Section:**
- Campaign-scoped file drop zone (Cold Call only)
- Channel selector inline
- Auto-processes on file drop; reloads after 3s

**Disposition Breakdown Table:**
- Disposition name / Count

**Channel Status Card:**
- Cold Call status badge
- SMS status badge
- Wrong numbers removed (count)
- Voicemails accumulated (count)

**Filtration History Table:**
- Columns: Date, File/Source list, Channel, Total, Kept, Filtered, Breakdown, Memory catches, Actions
- One row per upload
- View/delete per upload

**Actions:**
- Rename campaign (modal)
- Sync wrong numbers (button + confirm)
- Download clean export (Readymode format)
- Mark campaign completed (requires status change)
- Start new round (clone campaign)
- Reset campaign (clear all data)
- Delete campaign (requires code)

## 7. Imports

**Routes:** `/import/property` (GET/POST hierarchy), `/import/bulk` (GET/POST hierarchy)

### Property Import (`/import/property/*`)
- **Step 1 (Choose):** Upload CSV
- **Step 2 (Map):** Auto-map columns with manual override + template save
  - Detects column fingerprint; auto-applies saved mapping
  - Mapping templates stored by header fingerprint
  - Use count tracking
- **Step 3 (Preview):** First 5 rows preview + error summary
- **Background job tracking** in Activity page
- Async processing (user can close tab)
- Job status: pending / running / complete / error
- Per-row error logging (max 500 errors shown)

### Bulk Import (`/import/bulk`)
- Upload full REISift export (up to 600MB)
- REISift column mapping (hardcoded, auto-applied)
- Field mapping with bounds checking:
  - Money values (max $9.9B)
  - Year (1800–2200)
  - Bathrooms (0–99)
  - SmallInt range checks
- Async batch processing (500 rows/batch)
- UPSERT semantics (properties, contacts, phones)
- Job status page with progress bar + error summary

## 8. Activity

**Route:** `/activity` (GET), `/activity/status` (GET)

**Activity Feed:**
- Paginated import job table (50 most recent)
- Columns: File, List, Status, Progress (%), Results (inserted/updated/errors), Started
- Status icons + color-coded badges: pending (⏳), running (🔄), complete (✅), error (❌)
- Progress bar per job with (processed / total) count
- Error message summary (first 500 chars) shown inline
- "View List" button links to Records filtered by that list
- **Auto-refresh** if jobs running (every 2s)
- Empty state + call-to-action to start import

## 9. NIS

**Route:** `/nis` (GET), `/nis/upload` (POST)

**NIS Page:**
- Stats display: Total NIS numbers, First seen, Last seen, Times reported
- Upload form for NIS number CSV
- Processes CSV and flags matching phones across all campaigns
- Displays result message: rows processed, unique numbers, new vs. updated, phones flagged
- Uses `nis_numbers` table for global NIS tracking

## 10. Settings / Security

**Route:** `/settings/security` (GET/POST)

**Security Settings Page:**
- Delete code management (password change form)
  - Current code (password field)
  - New code (min 6 characters)
  - Confirm new code
- Last updated timestamp display
- Warning banner: "If you forget this code, an admin with database access will need to reset via SQL"
- Constant-time comparison to prevent timing attacks

**Default Code:** `HudREI2026`

## 11. Auth

**Routes:** `/login` (GET/POST), `/logout` (GET)

**Login:**
- Simple password form (`APP_PASSWORD` from env)
- Rate-limited POST (uses rate limiter middleware)
- Express session management (Redis-backed in production, MemoryStore in dev)
- Session TTL: 8 hours
- Secure cookies: `httpOnly`, `sameSite=lax`, `secure=true` in production

**Logout:**
- Destroys session, redirects to `/login`

## 12. Sidebar / Shell

**Sidebar Navigation Items:**
1. Dashboard (`/dashboard`)
2. Records (`/records`)
3. Lists (`/lists`)
4. Campaigns (`/campaigns`)
5. Filter (`/`)
6. Upload (`/upload`)
7. Activity (`/activity`)
8. NIS (`/nis`)
9. Changelog (`/changelog`)
10. **System section:**
    - Setup (`/setup`)
    - List Types (`/lists/types`)
    - Security Settings (`/settings/security`)

**Footer:**
- Sign out link (`/logout`)

**Shell Features:**
- Fixed left sidebar (220px, dark theme)
- Active page indicator (highlight nav item)
- Responsive page wrap (margin-left: 220px)
- Logo: "Loki" / "OOJ Acquisitions"

## 13. Dashboard

**Route:** `/dashboard` (GET), `/api/dashboard-stats` (GET)

**Stats Section:**
- Total properties
- Total contacts
- Total phones
- Total leads (contacts with pipeline_stage = 'lead')
- Recent imports (5 most recent with run timestamp, record counts, memory catch count)
- Monthly trends (filtration + leads)

**API Endpoint:**
- `/api/dashboard-stats` returns JSON with all dashboard metrics for live refresh

## 14. Changelog

**Route:** `/changelog` (GET)

**Changelog Page:**
- Displays versioned feature/fix/note entries
- Date, title, tag, description per entry
- Entries at 0d79f14 include:
  - Phone tags + phone type editing
  - Phone type + phone tag filters
  - Email display fix
  - Various bug fixes and audits

## 15. CSV Upload (Upload Routes)

**Routes:** `/upload` (GET), `/upload/filter` (GET/POST), `/upload/property` (GET/POST), `/upload/filter/parse` (POST), `/upload/property/parse` (POST), `/upload/filter/process` (POST), `/upload/property/process` (POST)

**Filter Upload Pipeline:**
- Step 1: File upload (trigger parse)
- Step 2: Column mapping (auto-map to REISift fields)
- Step 3: Review preview
- Two-phase (parse / process):
  - `/upload/filter/parse` → returns columns + auto-mapping suggestion
  - `/upload/filter/process` → executes filtration, returns results

**Property Upload Pipeline:**
- Similar three-step flow
- Maps to REISift property fields

## 16. Database Schema Highlights

**Key Tables:**
- `campaigns` — campaign metadata (status, channels, counts)
- `campaign_numbers` — per-campaign phone tracking (cumulative count, status, tag, marketing result)
- `campaign_uploads` — upload history per campaign
- `campaign_contacts` — contact master list per campaign
- `campaign_contact_phones` — per-phone filtration/status tracking
- `nis_numbers` — global NIS dead-letter list
- `properties` — property records
- `contacts` — contact records (first/last, mailing address, owner_type)
- `phones` — phone numbers (phone_type, phone_status, phone_tag)
- `property_contacts` — junction (primary_contact, role)
- `property_tags` — custom tags for properties (color, name)
- `phone_tags` — custom tags for phone numbers (separate from property tags)
- `lists` — list definitions (name, type, source)
- `bulk_import_jobs` — async job tracking
- `mapping_templates` — saved CSV column mappings by fingerprint
- `owner_messages` — message board posts per owner (contact_id, author, body, timestamp)
- `owner_activities` — audit log per owner (kind, summary, author, timestamp)
- `app_settings` — app config (delete_code)

**Indexes:**
- Campaign + upload history
- NIS last seen date
- Property tags + phone tags
- Contact/property relationships
- Mapping template fingerprint

---

**Summary:** Loki at 0d79f14 is a **call log filtration + campaign management system** with:
- Single-password auth + session management
- Readymode CSV import → disposition-based filtration → two-output flow
- Memory (persistent via Redis, local via JSON backup)
- Campaign + contact list management
- Multi-source bulk import (REISift, PropStream, etc.)
- Phone + property tagging
- NIS tracking
- Activity logging + changelog
- Delete-code-protected destructive operations
