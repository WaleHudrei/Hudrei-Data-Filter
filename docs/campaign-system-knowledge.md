# Campaign & Filtration System — Full Knowledge Map

**Audience:** Operator (Wale) preparing to refine the campaign filtration process and the data-enrichment loop into the records DB.
**Source:** Code on `staging`, May 2 2026.
**Companion doc:** `docs/filtration-system-review.md` covers the *rules* (decision tree, disposition buckets, thresholds). This doc covers the *system* — UI, data flows, enrichment loop, and refinement opportunities.

---

## 1 — What this system is FOR

The campaign filtration system is a **lead-qualification feedback loop**. Outbound call activity from the dialer gets uploaded as a CSV; the system applies decision rules to decide which numbers stay callable; and the **outcomes flow back into the global records database** to enrich every property the operator works going forward.

The enrichment loop is the whole point. Every cold-call disposition is data. Wrong-numbers, dead numbers, confirmed-correct numbers, and confirmed leads are all written back to the records DB so that:

- The next campaign on the same property doesn't waste calls on phones already proven wrong.
- Once a property has produced a lead, that property is permanently marked `pipeline_stage='lead'`.
- Once a phone has produced a lead (via Layer 1.5 of `phone_intelligence`), that phone is excluded from re-marketing globally — even if the property changes hands.
- The distress score ranks properties for future campaigns, factoring in pipeline_stage.

Without the enrichment loop, the system is just a CSV deduper. With it, the records DB gets smarter every time a campaign runs.

---

## 2 — High-level data flow

```
┌──────────────────┐
│  Dialer CSV      │   Readymode call log / SmarterContact SMS results
│  (Phone, Dispo)  │
└────────┬─────────┘
         │
         ▼
┌──────────────────────────────────────────┐
│  Campaign-scoped filtration              │
│  • processCSV (rules + memory)           │
│  • recordUpload (per-phone tally)        │
│  • applyFiltrationToContacts             │
└────────┬──────────────────┬──────────────┘
         │                  │
         │ writes to        │ writes back to
         ▼                  ▼
┌─────────────────┐  ┌─────────────────────────────────────┐
│ Campaign tables │  │ Global records DB (enrichment)       │
│ campaigns       │  │ • properties.pipeline_stage='lead'   │
│ campaign_       │  │ • phones.phone_status='correct'/dnc/ │
│  numbers        │  │     wrong                            │
│ campaign_       │  │ • phone_intelligence Layer 1/1.5     │
│  contacts       │  │ • call_logs (every dispo logged)     │
│ campaign_       │  │ • property_lists (list memberships)  │
│  contact_phones │  │ • nis_numbers (dead phones)          │
│ campaign_       │  │ • filtration_results (audit trail)   │
│  uploads        │  └─────────────────────────────────────┘
└─────────────────┘                │
                                   ▼
                         ┌──────────────────────┐
                         │ /records page filters│
                         │ surface the enriched │
                         │ data for next pass   │
                         └──────────────────────┘
```

---

## 3 — UI surface: page by page

### 3.1  Campaigns list — `/oculah/campaigns`

**File:** `src/ui/pages/campaigns-list.js` · **Route:** `src/ui/ocular-routes.js:1196-1218`

**Top KPI strip** (`campaigns-list.js:100-105`):
- **Active campaigns** — count of `status='active'`
- **Total contacts** — `SUM(contact_counts.total_contacts)` across campaigns
- **Leads (all campaigns)** — `SUM(contact_counts.lead_contacts)` (highlighted when > 0)

**Tab filter** (`campaigns-list.js:70-73`): Active / Completed / All — filters by `campaigns.status`. **No text search, no sort, no pagination.** Whole table renders.

**Row columns** (`campaigns-list.js:27-68`):

| Column | Source | Notes |
|--------|--------|-------|
| Name | `campaigns.name` | Click → detail page; market/state shown as subtext |
| List type | `campaigns.list_type` | Pill |
| Channel | `campaigns.active_channel` | cold_call / sms badge |
| Status | `campaigns.status` | active / paused / completed (color-coded) |
| Contacts | `total_contacts` | Master list size |
| Callable | `total_phones - wrong_phones - nis_phones` | Active pool |
| Leads | `lead_contacts` | From transfer dispos |
| Started | `campaigns.start_date` | Relative ("3 days ago") |

**Hover popover** (`campaigns-list.js:144-201`): hover any row to see CLR%, CR%, Wrong#, Callable, Leads, last round date — pulled from `data-*` attributes on the row, no extra fetch.

**Buttons:** `+ New campaign` only.

**Refinement opportunity:** No search, no sort, no pagination. Once a tenant has 50+ campaigns this page falls apart.

---

### 3.2  Create campaign — `/oculah/campaigns/new`

**File:** `src/ui/pages/campaign-new.js` · **Route:** `src/ui/ocular-routes.js:1142-1194`

| Field | Required | Where it goes | Notes |
|-------|----------|---------------|-------|
| Name | Yes | `campaigns.name` | Operator-facing label |
| List type | Yes | `campaigns.list_type` | Dropdown + "Add new list type…" → custom row in `custom_list_types` |
| State | Yes | `campaigns.state_code` | 16 hard-coded US states + "Other" |
| Market name | Yes | `campaigns.market_name` | Free text, e.g. "Indianapolis Metro" |
| Start date | No | `campaigns.start_date` | Defaults to today |
| Channel | No | `campaigns.active_channel` | cold_call (default) / sms |
| **Dialer / platform** | **Yes** (5C) | `campaigns.platform` | Two optgroups (cold_call / sms); built-ins hard-coded; "Add custom…" persists to `tenant_dialer_options` |
| Notes | No | `campaigns.notes` | Free text, max 2000 |

**Built-in dialer options** (hard-coded in `campaign-new.js:21-22`):
- Cold call: ReadyMode, CallTools, Batch Dialer
- SMS: Smarter Contact, Launch Control

**Channel toggle** (`campaign-new.js:117-126`): switching channel swaps the visible platform optgroup and resets the platform selection. JS function `cn_swapPlatform()`.

**On submit:** writes one row to `campaigns`, optionally one to `custom_list_types`, optionally one to `tenant_dialer_options`. All counts initialize at 0. Status = `active`.

---

### 3.3  Campaign detail — `/oculah/campaigns/:id`

**File:** `src/ui/pages/campaign-detail.js` · **Route:** `src/ui/ocular-routes.js:1221-1242`

This is the workhorse page. Eleven distinct panels.

#### 3.3.1  Header (`campaign-detail.js:573-589`)
- Back link · Rename (inline form) · Status badge · Channel select · **Platform pill (read-only)** · Status select

#### 3.3.2  Filter rules (collapsible, `campaign-detail.js:511-541`)
The thresholds that drive `generateCleanExport`:
- **Voicemail threshold** — skip phones with N+ VMs (range 0-99, default 99 = no limit)
- **Hangup threshold** — skip phones with N+ hangups (default 99)
- **Skip wrong-number phones** — boolean, default ON
- **Skip do-not-call phones** — boolean, default ON
- **Skip not-in-service phones** — boolean, default ON
- **Skip already-converted leads** — boolean, default ON

Saved to `campaigns` columns via `POST /oculah/campaigns/:id/filters` → `campaigns.updateCampaignFilters()`.

#### 3.3.3  KPI strip — Filtration totals (`campaign-detail.js:176-197`)

Cold-call view (7 cards):

| Card | Field | Source |
|------|-------|--------|
| Call logs | `total_call_logs` (subtitle: unique count) | SUM(cumulative_count) |
| Connected | `total_connected` | aggregated on `campaigns` |
| Wrong numbers | `total_wrong_numbers` | aggregated |
| Not interested | `total_not_interested` | aggregated |
| Leads generated | `total_transfers` | aggregated |
| Callable | `acceptedPhones - filtered - wrong - nis` | derived |
| Filtration runs | `upload_count` | counter |

SMS view drops Call Logs / Connected / Filtration Runs.

#### 3.3.4  Campaign ratios (`campaign-detail.js:220-227`)

| Ratio | Formula | Color |
|-------|---------|-------|
| CLR | calls / acceptedPhones | primary |
| CR | connected / calls | primary |
| W#% | wrong / (connected+wrong) | red |
| NI% | ni / connected | amber |
| LGR | transfers / connected | green |
| LCV | leadContacts / acceptedContacts | purple |
| Health | callable / acceptedPhones | green/amber/red gradient |

**5D anchoring:** all denominators land on `accepted_phones`/`accepted_contacts` when populated; fall back to `total_phones`/`total_contacts` otherwise.

#### 3.3.5  Channel status (`campaign-detail.js:231-255`)
Status pills (active/dormant) per channel + rolling "wrong removed" + "voicemails accumulated" counters.

#### 3.3.6  Contact list panel (`campaign-detail.js:260-350`)

Seven sub-KPIs:
- Total properties · Accepted by Dialer (with inline edit override → `manual_count`) · Total phones · Wrong numbers · NIS flagged · Confirmed correct · Contacts reached (with %)

Header buttons:
- **Sync wrong numbers** → POST `/oculah/campaigns/:id/sync-wrong-numbers` — backfills historical wrong-number flags from `campaign_numbers` to `campaign_contact_phones`
- **Download clean export** → `/campaigns/:id/export/clean`

Master-list upload section drops into the **mapping wizard** (§3.4).

SMS results upload section (SMS campaigns only) → POST `/oculah/campaigns/:id/sms/upload` → `campaigns.importSmarterContactFile()`.

#### 3.3.7  Disposition breakdown (`campaign-detail.js:484-488`)
Horizontal bar chart per disposition. Counts come from `c.disposition_breakdown`.

#### 3.3.8  Filtration history table (`campaign-detail.js:543-564`)
File · Channel · Total · Kept · Filtered · Memory caught · Uploaded — one row per upload from `campaign_uploads`.

#### 3.3.9  Quick filtration drop zone (`campaign-detail.js:371-390`)
Inline drag-drop CSV → AJAX through `/upload/filter/parse` → `/upload/filter/process`. No mapping screen — uses auto-detect. Returns stats inline + download buttons. For larger files, links to `/oculah/filtration` full wizard.

#### 3.3.10  Action buttons (`campaign-detail.js:594-599`, repeated `618-622`)
- **Upload list / call log** → full filtration wizard
- **Start new round** → closes campaign + clones it (new campaign, fresh counters, same rules)
- **Close campaign** → status='completed'
- **Delete campaign** → only when status='completed'; requires typed-name confirmation; cascades to `campaign_contacts`, `campaign_contact_phones`, `campaign_numbers`, `campaign_uploads`

---

### 3.4  Contact mapping wizard — `/oculah/campaigns/:id/contacts/map`

**File:** `src/ui/pages/contacts-map.js` · **Routes:** `ocular-routes.js:1423-1575`

Three-step flow:

1. **Parse** (POST `/contacts/parse`) — operator uploads CSV. Server parses headers + sample rows + auto-detects columns. Stashes parsed rows in session.
2. **Map** (GET `/contacts/map`) — operator confirms/overrides each field mapping. Page shows first 5 sample rows.
3. **Commit** (POST `/contacts/commit`) — server validates required fields, calls `campaigns.importContactList(...)`. On success, session cleared, redirect back to detail page.

**Required mappings** (validated server-side, `ocular-routes.js:1536`):
- `fname`, `lname` (owner)
- `paddr`, `pcity`, `pstate`, `pzip` (property address)
- **`accepted`** — yes/no column from dialer's accepted-list export
- `phone1`

**Optional mappings:**
- Mailing fields (5 fields)
- `mcounty`, `pcounty`
- Phones 2–10
- `dnc`

**Auto-detect heuristic** (`ocular-routes.js:1463-1479`): tokenize header on `_-# `, match if every needle token appears in header tokens. Phone columns picked via 10-column heuristic with include/exclude pattern lists.

**On commit, `campaigns.importContactList()` writes:**
- `campaign_contacts` (UPSERT by `campaign_id, row_index`)
- `campaign_contact_phones` (UPSERT by `contact_id, phone_number`)
- Triggers `phone_intelligence.clearLayer1OnOwnerMismatch()` — clears Layer 1 wrong/correct flags on phones that arrive on a NEW owner name (Layer 1.5 lead flag preserved)

---

### 3.5  Filtration wizard — `/oculah/filtration`

**File:** `src/ui/pages/filtration.js` · **Routes:** `src/routes/upload-routes.js:46-169`

Three sections, progressive disclosure:

1. **Memory card** (`filtration.js:27-56`) — shows: lists tracked, scopes in memory, Redis status. Buttons: Export memory, Import memory, Clear memory.
2. **Upload step** (`filtration.js:58-101`) — searchable campaign combobox + drag-drop CSV (max 50 MB). Campaign is the filtration scope.
3. **Mapping + run** (`filtration.js:104-123`) — auto-mapped columns + override option + "Run filtration" button.
4. **Results** (`filtration.js:125-150`) — stats row, two download buttons (Filtered → REISift, Clean → Readymode), preview tabs.

**If campaign is selected**, `upload-routes.js:117-127` calls:
- `saveRunToDB()` — writes to global records (properties, contacts, phones, call_logs, filtration_results)
- `campaigns.recordUpload()` — writes per-phone tally to `campaign_numbers`
- `campaigns.applyFiltrationToContacts()` — propagates outcomes to `campaign_contact_phones` AND back into the records DB (the enrichment loop)

**If no campaign**, only memory dedup runs and CSVs are returned. No DB writes, no enrichment. (This is the legacy "just give me the files" path.)

---

## 4 — Data IN

Every place data enters the campaign system:

| Entry point | UI | Handler | Writes to |
|-------------|----|---------|-----------|
| Master contact list CSV | Campaign detail · Contact List panel | `ocular-routes.js:1423-1575` → `campaigns.importContactList` | `campaign_contacts`, `campaign_contact_phones`, `phone_intelligence` (mismatch clear) |
| Call-log CSV (Readymode) | `/oculah/filtration` or campaign detail quick-drop | `upload-routes.js:46-169` → `processCSV` + `saveRunToDB` + `campaigns.recordUpload` + `applyFiltrationToContacts` | `filtration_results`, `properties`, `contacts`, `phones`, `phone_intelligence`, `call_logs`, `campaign_numbers`, `campaign_uploads`, campaign aggregates |
| SMS results CSV (SmarterContact) | Campaign detail · SMS upload form | `ocular-routes.js:1373-1396` → `campaigns.importSmarterContactFile` | `campaign_contact_phones` (dispositions), `campaign_contacts.marketing_result`, `campaigns` totals, `phone_intelligence` |
| Manual form fields (create / rename / status / channel / filters / accepted-count) | Various forms on detail page | `ocular-routes.js:1142-1713` | `campaigns` columns |

**There is no direct dialer API integration.** Everything is CSV-driven. The dialer exports a file, operator uploads it, system processes it.

---

## 5 — Data OUT: the enrichment loop

This is the heart of the document. **Every place campaign activity writes back into the global records database.**

### 5.1  `properties` table

| Write | Trigger | SQL | File:Line |
|-------|---------|-----|-----------|
| `pipeline_stage = 'lead'` | Transfer disposition on a call/SMS | `UPDATE properties SET pipeline_stage='lead' FROM campaign_contacts WHERE cc.property_address_normalized = p.street_normalized AND UPPER(TRIM(cc.property_state)) = UPPER(TRIM(p.state_code)) AND p.pipeline_stage NOT IN ('contract','closed')` | `filtration.js:319-328` (per-row), `527-539` (bulk), `1402-1409` (SMS), `1767-1775` (SMS bulk) |

**Important: pipeline_stage='lead' is sticky against contract/closed.** A property already at `contract` or `closed` is NOT downgraded back to `lead` on a fresh transfer.

**No synchronous distress recompute.** Distress scores are lazy-computed at query time. The next call to `/records/_distress` "Recompute All" picks up the change.

### 5.2  `phones` table

| Write | Trigger | Where |
|-------|---------|-------|
| `phone_status = 'correct'` | Transfer disposition (live pickup that converted) | `filtration.js:336-348`, `527-539`, `1399-1409` |
| `phone_status = 'dnc'` | SMS DNC label | `filtration.js:1494-1497` |
| `phone_status = 'wrong'` + `wrong_number = true` | Wrong-number disposition (SMS path) | `filtration.js:1339-1350`, `1703-1716` |
| `do_not_call = true` (sticky via `GREATEST`) | DNC disposition during cold-call upload | `server.js:1248-1261` (`saveRunToDB` Pass 8) |

**Scope guard:** all writes filter by `cc.property_address_normalized = p.street_normalized AND state` so a number shared across multiple owners doesn't get globally tagged from one campaign's outcome on a different property.

### 5.3  `phone_intelligence` table — Layers 1 and 1.5

**File:** `src/phone-intelligence.js` · **Schema added in db.js**

This is the **most important enrichment surface**. Three layers per phone, scoped by tenant:

| Layer | Field | Lifetime | Set when |
|-------|-------|----------|----------|
| 1 — Wrong | `is_wrong=true, wrong_flagged_at, last_owner_name` | 6 months rolling (db.js boot sweep clears expired) | Wrong-number disposition confirmed |
| 1 — Correct | `is_correct=true, correct_flagged_at, last_owner_name` | 6 months rolling | Live pickup (any CONNECTED disposition that's not wrong/transfer) |
| 1.5 — Lead | `is_lead=true, lead_flagged_at` | **Permanent — never decays** | Transfer disposition (lead converted) |

**Owner-mismatch detector** (`phone-intelligence.js:125-140`): when a contact list arrives with the same phone but a different owner name, **Layer 1 flags clear** (wrong/correct), but **Layer 1.5 lead flag persists**. Rationale: phone may have been recycled to a new person; old wrong/correct guesses stale; but a number that ever produced a lead should never be re-marketed regardless.

**Used downstream:** the records page filters and the Records bulk export consult these flags to exclude phones from re-marketing.

### 5.4  `call_logs` table

Written by `saveRunToDB` Pass 9 (`server.js:1290-1320`). One row per phone+disposition pair from the upload. Includes `disposition` (raw) + `disposition_normalized` (canonical). Used by the analytics dashboard for trend graphs.

### 5.5  `filtration_results` table

Written by `saveRunToDB` Pass 12 (`server.js:1380-1410`). **One row per CSV row processed**, including invalid-state rows. Audit trail. Not surfaced in the UI today — pure backend log.

**Refinement opportunity:** this table is rich and not yet surfaced. A "filtration audit" view per campaign could be built from it.

### 5.6  `lists` and `property_lists`

When a CSV upload arrives with an `Original Lead File` column, that name becomes a `lists` row (UPSERT) and every property in the upload gets linked via `property_lists`. This is what powers the records page's "On X list" filter and the multi-list distress signal stacking.

### 5.7  `nis_numbers` and `nis_events`

NIS uploads (separate flow, `filtration.js:1030-1050`) write tenant-scoped phone numbers as not-in-service. The `nis_events` table dedupes by `(phone, day)` so re-uploading the same NIS export doesn't double-count (audit fix #23).

### 5.8  `markets`

`saveRunToDB` Pass 2 upserts every state seen in an upload into `markets`. Side effect — populates the markets dropdown for campaign creation.

### 5.9  `activity_log` (Phase 4 audit)

Pipeline-stage changes — when a property flips to `lead` from a transfer, `distress.logOutcomeChange()` writes an entry to `activity_log` (records-routes.js:774). Visible on the property detail page.

### 5.10  Summary: what the records DB knows after a campaign runs

After a single Readymode upload tied to a campaign, here's what the records DB has gained:

- Every property in the upload exists in `properties` (created or updated).
- Every contact in the upload exists in `contacts` (created or updated).
- Every phone in the upload exists in `phones` with `do_not_call`, `wrong_number`, `phone_status` set per disposition.
- Every transfer outcome has flipped the property's `pipeline_stage` to `lead`.
- Every phone outcome (wrong / correct / lead) is recorded in `phone_intelligence` with a timestamp.
- Every CSV row is auditable in `filtration_results`.
- Every list name is a row in `lists` with property links in `property_lists`.

This is the enrichment loop. The next campaign on overlapping properties starts with all of this context already in place.

---

## 6 — How the records page surfaces the enrichment

**File:** `src/records/records-routes.js`

The records page is the consumer of the enrichment loop. Filters that depend on campaign-derived data:

| Filter | Source field | Set by |
|--------|--------------|--------|
| Pipeline stage = lead | `properties.pipeline_stage` | Campaign transfer outcomes |
| Marketing Result | `campaign_contacts.marketing_result` | Campaign filtration & SMS results |
| Phone status (correct/wrong/dnc) | `phones.phone_status` | Campaign outcomes via §5.2 writes |
| Wrong number | `phones.wrong_number` | Campaign outcomes |
| On list X | `property_lists` | CSV `Original Lead File` column |
| High equity / out-of-state owner / etc. | (separate distress signals) | Property data, not campaign |

**Filter parity rule** (CLAUDE.md): every filter must be re-implemented identically across every "Select All → bulk action" SQL handler. Drift = silent over-deletion.

**Property detail page** (records-routes.js:697-774): editing `pipeline_stage` to `lead` propagates `marketing_result='Lead'` to all matching `campaign_contacts` (lines 728-735). This is the manual override path — operator decides "this is a lead" without going through a transfer disposition.

---

## 7 — Refinement opportunities (what's worth fixing)

Cataloged from gaps surfaced during this audit. Operator decides which to prioritize.

### 7.1  UI gaps

- **Campaigns list has no search, sort, or pagination.** First thing to break at scale.
- **No filtration audit view per campaign.** `filtration_results` has rich row-by-row data; nothing surfaces it. A "see what got filtered and why" tab on the campaign detail page would be high-value.
- **No "see overlap" view between campaigns.** Two campaigns might share 80% of their properties; nothing surfaces this. A `properties overlap` query per campaign would help.
- **Disposition breakdown is a static bar chart.** Not clickable — operator can't drill from "47 Wrong Number" to the rows behind it.
- **Manual Accepted-by-Dialer override is text-only.** No history of overrides; the inline edit just overwrites `manual_count` with no audit log.

### 7.2  Data flow gaps

- **`call_logs` is written but barely read.** Trend analytics exist on the dashboard but per-property call history isn't on the property detail page. Adding a "Call history" tab on the property page would close this gap.
- **`phone_intelligence` Layer 1 expiry is at boot only.** A daily cron would be more responsive. Also no UI shows when a Layer 1 flag was set or how long it has left.
- **Wrong-number sync is operator-triggered.** The "Sync wrong numbers" button on the contact list panel suggests this isn't automatic. Worth understanding why and either making it automatic or surfacing a "sync needed" indicator.
- **DNC has no un-DNC path.** Once flagged, only manual DB edit removes it. Worth adding a UI path for operator review.
- **No cross-campaign deduplication of leads.** A property that produces a lead in Campaign A is `pipeline_stage='lead'`, but Campaign B can still upload the same address and double-count it as a fresh lead. The "exclude already converted leads" filter rule helps, but only on the same campaign's own contact list — not across campaigns.

### 7.3  Records-DB enrichment gaps

- **Owner-mismatch detection is binary.** Either the owner matches or it doesn't. There's no "probably the same person" middle ground (typos, abbreviations). Layer 1 flags clear too aggressively when someone types the owner name differently.
- **No back-flow from `pipeline_stage='contract'` or `'closed'`.** When a property advances past lead, nothing tells the campaign system "stop showing this on Active Leads filters." It still shows because `pipeline_stage` is read directly.
- **The distress score doesn't yet weight campaign engagement.** A property with 5 confirmed-correct phones and a transfer history is more valuable than one never called, but the distress signal stack treats them the same. Worth a pass through `src/scoring/distress.js`.
- **`marketing_result` on `campaign_contacts` is last-write-wins.** A property with multiple campaigns / multiple phones can have inconsistent marketing_result across them. Worth either (a) always taking the strongest outcome (Lead > Sold > Listed > Not Interested > DNC > Spanish Speaker) or (b) tracking it as a list of outcomes per phone.

### 7.4  Operational gaps

- **Memory is global (across tenants) for DNC and wrong-number.** Acceptable today (single-tenant), needs scoping before HudREI accepts a sub-tenant or before opening to other tenants.
- **Filtration memory has no upload-hash dedupe.** Re-uploading the same file double-counts every disposition. A simple `filtration_runs.upload_sha256` column would prevent this.
- **No webhook / API path for the dialer.** Everything is manual CSV. Even a lightweight "drop this URL in the dialer, it gets the call log every hour" path would remove operator friction.

---

## 8 — File reference index

| Concern | File | Lines |
|---------|------|-------|
| Campaigns list page | `src/ui/pages/campaigns-list.js` | full |
| Campaign create page | `src/ui/pages/campaign-new.js` | full |
| Campaign detail page | `src/ui/pages/campaign-detail.js` | full |
| Contact mapping wizard | `src/ui/pages/contacts-map.js` | full |
| Filtration wizard page | `src/ui/pages/filtration.js` | full |
| Campaign + contact mapping routes | `src/ui/ocular-routes.js` | 1142-1713 |
| Filtration upload routes | `src/routes/upload-routes.js` | 46-169 |
| `processCSV` core filter | `src/server.js` | 603-716 |
| `saveRunToDB` 13 passes | `src/server.js` | 1023-1454 |
| Campaign module (CRUD + import) | `src/campaigns.js` | full |
| Filtration module (recordUpload, applyFiltrationToContacts, getContactStats, generateCleanExport, importSmarterContactFile) | `src/filtration.js` | full |
| Phone Intelligence Layer 1/1.5 | `src/phone-intelligence.js` | full |
| Disposition canonical | `src/disposition-normalize.js` | full |
| Records page (consumer of enrichment) | `src/records/records-routes.js` | full |
| Companion: filtration rules review | `docs/filtration-system-review.md` | full |

---

**Last updated:** 2026-05-02 from `staging` head.
