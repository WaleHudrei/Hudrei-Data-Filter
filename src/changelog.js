// Changelog module — version history shown in /changelog
// Add new entries to the TOP of the entries array as you ship features.

const ENTRIES = [
  {
    date: 'April 14, 2026',
    title: 'Distress scoring engine, multi-value filters, import crash fixes & source customization',
    items: [
      // ── Distress Scoring Engine (Phase 1) ──
      { tag: 'feature', text: 'Distress Score Engine — rule-based scoring system with 12+ distress signals. Each property receives a cached score (0-100) and band (Cold/Warm/Hot/Burning) based on list membership, equity, out-of-state ownership, stacking depth, and marketing results.' },
      { tag: 'feature', text: 'Signals: Tax Sale (+20), Pre-Foreclosure (+20), Probate (+20), Code Violation (+15), Vacant (+15), Tax Delinquent (+10), Stack 5+ (+15), Stack 3-4 (+10), Stack 2 (+5), High Equity ≥50% (+10), Out-of-State Owner (+10), Marketing Lead (+5), County-sourced list (+5).' },
      { tag: 'feature', text: 'Bulk SQL recompute — scores all 41,230 properties in ~2-3 seconds via a single SQL CTE. Skips per-property JSONB breakdown for speed; breakdowns lazy-fill on detail page view.' },
      { tag: 'feature', text: 'Distress Score column on Records table — colored badge showing score number. Min Distress Score filter input on filter panel (30+ Warm, 55+ Hot, 75+ Burning).' },
      { tag: 'feature', text: 'Property detail Distress card — shows score, band, scoring date, and itemized Signals Contributing breakdown with point values for each signal.' },
      { tag: 'feature', text: 'Dashboard Distress Score Snapshot — stacked proportion bar showing band distribution across all properties. Top 5 hottest leads listed with clickable links.' },
      { tag: 'feature', text: 'Distress Audit page at /records/_distress — Recompute All button, score distribution histogram, current weights table, Closed Deal Score History, Signal Coverage Report, Conversion Rate by Band.' },
      { tag: 'feature', text: 'Event-driven rescoring — properties are automatically rescored when imported or updated. Outcome logging tracks score changes and lead/contract transitions for future ML training.' },
      { tag: 'fix', text: 'Distress breakdown empty on detail page — bulk Recompute All populated scores but skipped JSONB breakdowns. Detail page now lazy-fills breakdown when score exists but breakdown is missing.' },
      { tag: 'improvement', text: 'Distress card moved below Lists section on property detail page for natural reading order: lists → score → campaign history.' },

      // ── Multi-value Filters ──
      { tag: 'feature', text: 'Multi-value ZIP filter — type comma- or space-separated ZIPs (e.g. "46218, 46219, 46220") to find properties in any of those ZIPs. OR logic, prefix-matching (46218 catches 46218-1234).' },
      { tag: 'feature', text: 'Multi-value City filter — comma-separated city names with OR logic and substring matching.' },
      { tag: 'feature', text: 'Multi-value County filter — comma-separated county names with OR logic and substring matching.' },
      { tag: 'fix', text: 'ILIKE ANY(array) was unreliable in Postgres for multi-value matching. Replaced with explicit OR chain: (p.zip_code ILIKE $1 OR p.zip_code ILIKE $2 OR ...). Applied to both list view and export paths.' },
      { tag: 'improvement', text: 'Filter inputs updated with helper text showing comma-separate syntax and example placeholders.' },

      // ── Import Improvements ──
      { tag: 'feature', text: 'Custom source on import — "+ Add custom source…" option in the Source dropdown reveals a text input. Type any source name (e.g. County Records, Cook County Auditor). Validated before upload starts.' },
      { tag: 'fix', text: 'Import crash: value too long for character varying(10) — rows with oversized state_code or zip_code values now skip cleanly instead of crashing the entire batch at row 5,000. Skip reasons logged to bulk_import_jobs.error_log.' },
      { tag: 'fix', text: 'Import crash: ON CONFLICT DO UPDATE cannot affect row a second time — duplicate (street,city,state,zip) rows within a single batch now deduplicated in JavaScript before the SQL INSERT. First occurrence kept, duplicates logged.' },
      { tag: 'improvement', text: 'Activity page error visibility — failed imports now show error details inline under the filename. Red box for crashes, yellow ⚠️ box for completed-with-skips. First 500 chars of error_log displayed.' },

      // ── SMS Filtration ──
      { tag: 'feature', text: 'SMS Accepted + SMS Results upload channels — campaign_uploads now tracks sms_accepted (green badge) and sms_results (purple badge) separately. Breakdown column is SMS-aware.' },

      // ── State Filter ──
      { tag: 'feature', text: 'State multi-select dropdown — searchable dropdown with pills for selecting multiple states simultaneously. Pulls DISTINCT state_code values from DB.' },
      { tag: 'feature', text: 'List stacking multi-select — AND-logic filter to find properties appearing on every selected list simultaneously.' },
    ],
  },
  {
    date: 'April 13, 2026 — Session 2',
    title: 'Records overhaul, Import engine rebuild, Activity page, Lists redesign & 50-state expansion',
    items: [
      // ── Records ──
      { tag: 'feature', text: 'Records page — full-width table layout, 25 rows per page, uppercase column headers, responsive to screen width up to 1400px.' },
      { tag: 'feature', text: 'Select-all with bulk banner — clicking select-all selects current page. Blue banner appears offering to select all N records across all pages. Selecting all sends selectAll flag to export route which rebuilds filter conditions server-side and exports entire matching dataset.' },
      { tag: 'feature', text: 'Row click navigation — clicking any row opens property detail. Checkbox cell has stopPropagation so selecting does not navigate. Selected rows highlighted with CSS class.' },
      { tag: 'fix', text: 'Select-all checkbox was returning null addEventListener error — fixed by moving wiring script to absolute bottom of HTML page in shared-shell after all DOM elements exist.' },
      { tag: 'fix', text: 'Export route registered before /:id wildcard route — prevents Express treating /export as a property ID.' },
      { tag: 'fix', text: 'Duplicate module.exports removed from records-routes.js.' },

      // ── Import engine ──
      { tag: 'feature', text: 'List assignment on import — Step 1 now has an Assign to List panel. Type a new list name or pick an existing list from a live dropdown. Set List Type and Source. List is created in DB on first batch and all imported properties are tagged to it automatically.' },
      { tag: 'feature', text: 'Background job import — clicking Import Records now fires a server-side background job immediately. Browser is freed instantly. Job runs entirely on server using setImmediate batching. You can navigate away, upload another list, do anything — import keeps running.' },
      { tag: 'feature', text: 'Bulk UNNEST property insert — properties are now inserted in one SQL UNNEST query per batch instead of one query per row. 500 rows = 1 DB round trip instead of 500. Import time cut from 3-6 minutes to 15-25 seconds for 6,600 rows.' },
      { tag: 'feature', text: 'Phone type and phone status import — Phone Type 1 through Phone Type 10 and Phone Status 1 through Phone Status 10 columns auto-mapped and saved to phones table. Conflict logic: only overwrites unknown with known value, never overwrites known data with unknown.' },
      { tag: 'feature', text: 'Email fields — email_1 and email_2 added to contacts table. Auto-mapped on import from Email 1 / Email 2 columns. Displayed and editable on property detail page.' },
      { tag: 'feature', text: 'Import list badge — list name shown as green badge on Map Columns and Preview Import pages so you always know which list you are importing into.' },
      { tag: 'fix', text: 'sessionStorage quota exceeded — was storing all 6,617 CSV rows in browser storage hitting the 5MB limit. Fixed: rows now stored in Express server session. Browser only receives 10 preview rows. Background job reads from server session.' },
      { tag: 'fix', text: 'PayloadTooLargeError — Express default body limit of 100kb was rejecting batch commit requests. Fixed: body limit increased to 50mb.' },
      { tag: 'fix', text: 'Progress bar stuck at Starting — was dividing by rows.length which was 0 after sessionStorage change. Fixed to use totalRows from server response.' },
      { tag: 'fix', text: 'View Records button on import completion now redirects to /records?list_id=X filtered to the imported list instead of doing nothing.' },

      // ── Activity page ──
      { tag: 'feature', text: 'Activity page — new page in sidebar showing all import jobs. Columns: File, List, Status (⏳/🔄/✅/❌), Progress bar, Results (new + updated + errors), Started. Auto-refreshes every 2 seconds when any job is running. Stops polling when all jobs complete.' },
      { tag: 'feature', text: 'Job status API — GET /activity/job/:id returns live progress for any job. Used by import preview page to poll real-time progress after firing background job.' },

      // ── Lists page ──
      { tag: 'improvement', text: 'Lists page redesigned — replaced card layout with clean table. Columns: List Name, Type (color-coded badge), Source, Properties count, Created date, Actions. Row click navigates to records filtered by list.' },
      { tag: 'improvement', text: 'List type color badges — Cold Call (blue), SMS (green), Direct Mail (yellow), PPL (red), Referral (purple), Driving for Dollars (pink).' },
      { tag: 'improvement', text: 'Lists edit modal — Source field added (PropStream, DealMachine, REISift etc). Source saved on edit. List types updated to match import options.' },

      // ── 50 states ──
      { tag: 'feature', text: '50-state expansion — all 50 US states seeded into markets table on every boot using abbreviations (IN, GA, TX, FL etc). Replaces hardcoded Indianapolis Metro / Atlanta Metro.' },
      { tag: 'feature', text: 'State auto-normalization on import — if CSV has full state name (Indiana, indiana, INDIANA) it is automatically converted to abbreviation (IN) before saving. Handles all 50 state full names + existing abbreviations pass through unchanged.' },

      // ── Sidebar & shell ──
      { tag: 'improvement', text: 'Sidebar reordered — Dashboard, Records, Lists, Campaigns, List Filtration, Upload, Activity, NIS Numbers, Changelog, Setup.' },
      { tag: 'improvement', text: 'Map Columns page — responsive auto-fill grid that adapts to screen width. Phones section shows each phone on one row with Number, Type, Status columns clearly labeled.' },
      { tag: 'improvement', text: 'Preview Import page — full width layout matching Records page.' },
      { tag: 'improvement', text: 'bulk_import_jobs table added to DB migrations with list_id FK. tr.row-selected CSS added to shared-shell for selection highlight.' },
    ],
  },
  {
    date: 'April 13, 2026',
    title: 'Dashboard, Import Flow, Export, UI fixes & Loki branding',
    items: [
      { tag: 'feature', text: 'Dashboard — live stats page showing total properties, contacts, phones, lists, leads, contracts. Market split (Indiana vs Georgia) with progress bars. Phone health breakdown (correct, wrong, dead, unknown). Recent filtration runs table. Top lists by property count.' },
      { tag: 'feature', text: 'Import Property List — 3-step CSV import flow. Upload any CSV from PropStream, DealMachine, BatchSkipTrace or any source. Step 2 maps your columns to Loki fields with auto-mapping for 30+ common column name patterns. Step 3 previews first 10 rows then imports in batches of 200 with live progress bar.' },
      { tag: 'feature', text: 'Records export — checkbox selection on every row with Select All header checkbox. Black export toolbar appears when records are selected showing count. Export CSV modal with 29 column choices including all phones, financials, owner info, pipeline stage. Downloads instantly as CSV.' },
      { tag: 'feature', text: 'Records filter system — full filter panel with 13 filters: State, City, ZIP, County, Type, Property Status, Pipeline Stage, Year Built range, Assessed Value range, Equity % range, Marketing Result, Upload Date range, List Stacking dropdown. Active filter count badge on Filters button. Panel stays open when filters are active.' },
      { tag: 'feature', text: 'Stack list filter — dropdown of actual list names instead of requiring manual list ID entry.' },
      { tag: 'feature', text: 'Property detail page — new fields displayed: Assessed Value, Equity %, Property Status, Marketing Result. All 4 fields editable in the edit modal and saved via POST.' },
      { tag: 'feature', text: 'Delete completed campaign — Delete button appears only on completed campaigns. Requires confirmation. Permanently deletes campaign and all related data via cascade.' },
      { tag: 'feature', text: 'Upload merged — single Upload page with two cards: Import Property List and Upload Call Log. Removes duplicate sidebar entry. Each card routes to its own flow.' },
      { tag: 'fix', text: 'Campaign detail — SMS upload section now only shows when sms_status is active. Was incorrectly showing on all campaigns including Cold Call only campaigns.' },
      { tag: 'fix', text: 'Campaign detail — Filtration upload drop zone now only shows on Cold Call campaigns. SMS campaigns show an info message directing to the SMS upload section. Completed campaigns show a locked message.' },
      { tag: 'fix', text: 'All upload pages (filter step 1, 2, 3) now use shared-shell instead of the old ./shell module — full sidebar shows on every upload page including Dashboard, Lists, Setup.' },
      { tag: 'fix', text: 'SQL filter conditions — all 20 conditions were missing the $ before ${idx}, producing invalid SQL like WHERE state_code = 1 instead of $1. Fixed across all filter conditions.' },
      { tag: 'fix', text: 'Dashboard phone health — queries were case-sensitive (correct vs Correct). Fixed with LOWER() so all phone statuses match regardless of case. Dead number now catches both dead and dead_number values.' },
      { tag: 'fix', text: 'Contact dedup — filtration upload was creating duplicate contacts instead of reusing the existing primary contact per property address. Fixed in saveRunToDB.' },
      { tag: 'fix', text: 'Export route registered before /:id route — prevents Express from treating export as a property ID.' },
      { tag: 'improvement', text: 'Login now redirects to Dashboard instead of List Filtration.' },
      { tag: 'improvement', text: 'Sidebar updated — Dashboard added at top, Import List removed as separate entry (merged into Upload), Upload renamed from Upload Data.' },
      { tag: 'improvement', text: 'DB migrations — 4 new columns added to properties table: assessed_value, property_status, equity_percent, marketing_result. All added via ADD COLUMN IF NOT EXISTS.' },
      { tag: 'improvement', text: 'Loki logo designed — dark background, gold horned crown, green glowing eyes, Norse runes, gold LOKI wordmark with DATA INTELLIGENCE subtitle. SVG format for infinite scaling.' },
    ],
  },
  {
    date: 'April 12, 2026 — Architecture Decisions',
    title: 'Phone intelligence model revised + SMS architecture locked in',
    items: [
      { tag: 'improvement', text: 'DECISION: Wrong number is contact-scoped, not global. Larry\'s wrong number stays wrong for Larry only. Sally importing the same number starts as unknown and builds her own history independently. Phone status belongs to the contact-phone relationship, not the number globally.' },
      { tag: 'improvement', text: 'DECISION: Wrong number and NIS flags are permanent — no time-based expiry. The only legitimate reason to clear a wrong/NIS flag is a fresh skip trace returning a new owner on that number. This replaces the previous 6-month expiry plan.' },
      { tag: 'improvement', text: 'DECISION: Correct phone status stays Correct until a live disposition proves otherwise. No timer-based expiry needed. A confirmed correct number doesn\'t go stale just because time passed.' },
      { tag: 'improvement', text: 'DECISION: Lead flag is campaign-scoped, not global. When a Transfer fires, the contact is flagged as Lead in that campaign only. Other campaigns manage their own Lead flags independently. The same owner appearing in a different campaign starts fresh.' },
      { tag: 'improvement', text: 'DECISION: NIS 3x threshold — NIS reported 1–2 times only flags unknown phones, leaves Correct alone. NIS reported 3+ times overrides everything including Correct. Reasoning: one NIS report could be a glitch, three means the line is genuinely gone.' },
      { tag: 'improvement', text: 'DECISION: Roadmap Item 2 (expiry cleanup job) closed without building. No timer-based expiry is needed under the revised architecture. Flags are permanent and only cleared by real data events.' },
      { tag: 'improvement', text: 'SMS architecture locked in: SmarterContact Labels export (one row per contact) is the valid import format. Stats summary export (File 2) is not used. One label per row required — multiple labels cause entire upload rejection. CRM Transferred is ignored (no action).' },
      { tag: 'improvement', text: 'SMS filter logic: no cumulative counting. One reply is definitive. Wrong number is contact-scoped. Lead is campaign-scoped. NIS remains global. All consistent with cold call architecture.' },
    ],
  },
  {
    date: 'April 12, 2026',
    title: 'filtration.js extracted + Roadmap Items 1–4 + full SMS pipeline',
    items: [
      { tag: 'feature', text: 'filtration.js — new dedicated module combining all filtration logic and NIS logic, extracted from campaigns.js. Covers: recordUpload, applyFiltrationToContacts, generateCleanExport, getContactStats, importNisFile, getNisStats, normalizePhone, detectPhoneColumns, importSmarterContactFile.' },
      { tag: 'feature', text: 'Roadmap Item 1 — flagged_at timestamps added to campaign_contact_phones: wrong_number_flagged_at (set once on first wrong confirmation, never overwritten) and correct_flagged_at (refreshed on every live pickup confirmation).' },
      { tag: 'feature', text: 'Roadmap Item 3 — NIS 3x threshold implemented. NIS < 3 reports: only flags unknown phones, protects Correct. NIS 3+ reports: overrides everything including Correct. Applied on both contact list upload and retroactive NIS file import.' },
      { tag: 'feature', text: 'Roadmap Item 4 — Lead permanent flag. When Transfer fires, campaign_contacts.marketing_result is set to \'Lead\' for that campaign. generateCleanExport() excludes all Lead contacts. marketing_result column added via auto-migration.' },
      { tag: 'feature', text: 'SMS pipeline — importSmarterContactFile() in filtration.js. Validates required columns (Phone, Labels, First name, Last name, Property address, Property city, Property state, Property zip). Rejects entire upload if any column missing or any row has multiple pipe-separated labels.' },
      { tag: 'feature', text: 'SMS label mapping: Wrong Number → wrong_number (contact-scoped). Not interested → not_interested (filtered). Lead / Appointment → transfer (Lead flag). disqualified → filtered. CRM Transferred / Potential Lead / No answer / New / Left voicemail → no action.' },
      { tag: 'feature', text: 'SMS campaign type — createCampaign() now correctly saves active_channel from the New Campaign form. SMS campaigns set sms_status=active and cold_call_status=dormant. Previously active_channel was silently ignored and always defaulted to cold_call.' },
      { tag: 'feature', text: 'SMS campaign dashboard — SMS campaigns now show a channel-specific view: SMS uploads, Wrong numbers, Not interested, Leads generated, Callable, plus SMS KPIs (W#%, NI%, LGR, LCV, Health). Cold call metrics (Call logs, Connected, CLR, CR) hidden on SMS campaigns.' },
      { tag: 'feature', text: 'Campaign list page — SMS campaigns now show a purple SMS badge instead of the blue Cold Call badge for visual distinction.' },
      { tag: 'feature', text: 'Upload SmarterContact SMS Results section added to campaign detail page — file picker with blue Upload SMS results button and required column instructions shown inline.' },
      { tag: 'fix', text: 'createCampaign() was ignoring the active_channel parameter from the New Campaign form — all campaigns were saved as cold_call regardless of selection. Fixed by destructuring and saving active_channel with proper cold_call_status / sms_status derivation.' },
      { tag: 'improvement', text: 'campaigns.js cleaned up — recordUpload, applyFiltrationToContacts, generateCleanExport, getContactStats, importNisFile, getNisStats, normalizePhone all moved to filtration.js. campaigns.js re-exports them for backward compatibility. server.js unchanged.' },
    ],
  },
  {
    date: 'April 11, 2026 — Architecture Decision',
    title: 'Phone Intelligence Architecture (locked in)',
    items: [
      { tag: 'improvement', text: 'DECISION: Loki phone state is now organized into three layers — global signals (with shelf life), permanent global signals, and per-campaign isolated dispositions. This balances cross-channel data quality with the need to re-pitch sellers across different list types.' },
      { tag: 'improvement', text: 'Layer 1 — Time-decaying global flags with 6-month shelf life from last update: Wrong Number, NIS (dead number), Correct Number. These apply across all campaigns and both channels (cold call + SMS).' },
      { tag: 'improvement', text: 'Layer 1 expiration rules: All three flags auto-expire after 6 months. Wrong Number and Correct also clear immediately when a new contact list arrives with a different owner name on the same phone (data provider signaling ownership change). Correct timer resets on every confirming touch. NIS is time-based only.' },
      { tag: 'improvement', text: 'Layer 1.5 — Permanent global flag with NO expiry: Lead / Transfer. Once a phone is tagged as a lead, it is permanently excluded from all future marketing across every campaign and channel. Once they are in pipeline, they stay there.' },
      { tag: 'improvement', text: 'Layer 2 — Per-campaign isolated dispositions: Not Interested, Disqualified, Hang Up, Voicemail, Dead Call, Not Available. Each campaign maintains its own count, even when campaigns run simultaneously. A seller saying NI on Pre-Foreclosure does not affect their dispositions on Vacant Property — they get a fresh 3-strike rule on each list.' },
      { tag: 'improvement', text: 'Layer 3 — Records section: passive logging of every disposition across every campaign for the same contact. Available for manual analysis but never auto-blocks any campaign from dialing.' },
      { tag: 'improvement', text: 'Why per-campaign isolation matters: A seller who is "not interested" on a Vacant Property pitch in April could be a motivated seller on a Pre-Foreclosure list in July. Cost of being too cautious (skipping them) is much higher than cost of being too aggressive (a few extra dials).' },
      { tag: 'improvement', text: 'Build sequence: (1) Add flagged_at timestamps to wrong_number, dead_number, and Correct on campaign_contact_phones. (2) Daily cleanup job that expires 6-month-old flags. (3) Owner-mismatch detection on contact list uploads. (4) Lead permanent global flag. (5) Then SMS pipeline build.' },
    ],
  },
  {
    date: 'April 11, 2026',
    title: 'Filter rule overhaul + dashboard refinements',
    items: [
      { tag: 'feature', text: 'New filter rules: Disqualified now removed instantly. Hang Up has a 3-strike individual rule (3rd hang-up removes). Not Interested has a 3-strike rule (3rd NI removes).' },
      { tag: 'feature', text: 'Combined kill buckets: 4 total Not Interested + Hang Up across both → removed and reclassified as NI. 4 total Dead Call + Not Available across both → removed.' },
      { tag: 'feature', text: 'Combined buckets and individual rules run in parallel — whichever fires first triggers removal. Each disposition still tracked individually for the dashboard breakdown.' },
      { tag: 'feature', text: 'Per-disposition memory tracking — Loki now stores individual disposition counts per phone (dispoCounts) so combined buckets can work properly across uploads.' },
      { tag: 'feature', text: 'Phone status tagging updates: Disqualified and Completed → tagged Correct. Hang Up → tagged Tentative (new status type, neither Correct nor Wrong).' },
      { tag: 'feature', text: 'Two new KPIs on the campaign dashboard. CLR (Call Log Rate) = call logs ÷ total phones. CR redefined as connected ÷ call logs (was connected ÷ total phones). CLR shows list penetration, CR shows live-pickup rate on what was actually dialed.' },
      { tag: 'feature', text: 'Campaigns list table redesigned. New columns: Total Contacts, LGR, Callable Contacts (estimated). Old "Total numbers / Callable / Filtered" columns removed.' },
      { tag: 'improvement', text: 'Top row of campaign dashboard now leads with "Call logs" (formerly "Total properties" — confusing label fixed).' },
      { tag: 'improvement', text: 'Hang Up still counts as Connected on each dial, but reclassifies into NI count when removed (so NI% reflects effective rejection rate).' },
      { tag: 'improvement', text: 'Changelog extracted into its own module (src/changelog.js) — first step in modularizing server.js.' },
    ],
  },
  {
    date: 'April 10, 2026 — Phase 2, Slice 1',
    title: 'Records database — Properties (read-only)',
    items: [
      { tag: 'feature', text: 'Records page now backed by a normalized filing cabinet: rec_properties, rec_owners, and a property↔owner join table. Dedupes by address and by name+mailing address.' },
      { tag: 'feature', text: '"Sync from campaigns" button on the Records page — walks all campaign contacts and files them into the new Records tables. Run it once after deploy.' },
      { tag: 'feature', text: 'Properties tab: searchable, paginated table (50/page) showing Address, City, State, Zip, Owner(s), Phone count, List count.' },
      { tag: 'improvement', text: 'Records module lives in its own folder (src/records/) so phase 2 work stays isolated from the working filtration pipeline.' },
    ],
  },
  {
    date: 'April 10, 2026',
    title: 'Major feature & bug fix release',
    items: [
      { tag: 'feature', text: 'NIS Numbers section added. Upload Readymode Detailed NIS exports to globally flag dead phone numbers across all campaigns. Flagged numbers are auto-excluded from clean exports.' },
      { tag: 'feature', text: 'New "Contacts reached" card in Contact List section showing unique contacts (households) with at least one live pickup, plus reach percentage.' },
      { tag: 'feature', text: 'Custom list types — "+ Add new list type" option in the New Campaign form. Custom types are saved to the database and reusable across future campaigns.' },
      { tag: 'feature', text: 'Sync wrong numbers button on campaign page — one-click retroactive sync of historical wrong number dispositions to the master contact list.' },
      { tag: 'fix', text: 'Master contact list upload — phone columns (Phone 1 through Phone 10) are now correctly detected across PropStream, BatchSkipTracing, DealMachine, and REISift export formats.' },
      { tag: 'fix', text: 'Contact list stats display bug — the campaign dashboard was reading from an empty field. Stats now correctly hydrate from the database.' },
      { tag: 'fix', text: 'Filtration pipeline → campaign tracking — normalized disposition values were being dropped between the filter step and campaign recording, so all dispositions showed as "unknown". Fixed, so Connected, Wrong, NI, Leads counters now populate correctly.' },
      { tag: 'fix', text: 'Clean export phone column consistency — the exported CSV now has a fixed Ph#1 through Ph#N header row, so multi-phone contacts no longer lose data to header mismatch.' },
      { tag: 'fix', text: 'Clean export now correctly scrubs NIS (dead number) phones and wrong numbers from the file.' },
      { tag: 'fix', text: 'Wrong number flagging — now runs on every filtration row (not just removed rows), keeping the master list in sync with confirmed wrong numbers automatically.' },
      { tag: 'improvement', text: 'KPI definitions re-aligned. CR = Connected ÷ Total phones. W#% = Wrong ÷ Humans reached. NI% = NI ÷ Connected. LGR = Leads ÷ Connected. LCV = Unique lead contacts ÷ Total contacts. Health = Callable ÷ Total phones.' },
      { tag: 'improvement', text: 'Callable pool now reflects master list (Total phones − wrong − filtered − NIS) instead of only the phones touched by filtration uploads.' },
      { tag: 'improvement', text: 'Added logging throughout the filtration and contact upload pipelines for faster debugging.' },
    ],
  },
];

const TAG_COLORS = {
  feature:     { bg: '#eaf6ea', color: '#1a5f1a' },
  fix:         { bg: '#fdeaea', color: '#8b1f1f' },
  improvement: { bg: '#eaf1fb', color: '#185fa5' },
};

function renderChangelog() {
  const html = ENTRIES.map(e => `
    <div class="card" style="margin-bottom:1.5rem">
      <div style="border-bottom:1px solid #f0efe9;padding-bottom:10px;margin-bottom:14px">
        <div style="font-size:12px;color:#888;text-transform:uppercase;letter-spacing:0.5px">${e.date}</div>
        <div style="font-size:16px;font-weight:500;margin-top:2px">${e.title}</div>
      </div>
      ${e.items.map(i => {
        const c = TAG_COLORS[i.tag] || { bg: '#f0efe9', color: '#888' };
        return `<div style="display:flex;gap:10px;align-items:flex-start;padding:8px 0">
          <span style="background:${c.bg};color:${c.color};font-size:10px;text-transform:uppercase;font-weight:500;padding:3px 8px;border-radius:4px;flex-shrink:0;margin-top:2px;min-width:70px;text-align:center">${i.tag}</span>
          <span style="font-size:13px;line-height:1.5;color:#333">${i.text}</span>
        </div>`;
      }).join('')}
    </div>
  `).join('');

  return `
    <div style="max-width:760px">
      <h2 style="font-size:20px;font-weight:500;margin-bottom:4px">Changelog</h2>
      <p style="font-size:13px;color:#888;margin-bottom:1.5rem">Track what's new and what's been fixed in Loki.</p>
      ${html}
    </div>
  `;
}

module.exports = { renderChangelog, ENTRIES };
