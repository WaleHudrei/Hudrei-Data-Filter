# Campaign & Call-Log Filtration System — Review Document

**Audience:** Operator (Wale) for end-to-end review of how filtration actually works.
**Source:** Code as of `staging` head, May 2 2026. All facts cited with file:line.
**Purpose:** Confirm intended behavior, surface quirks worth fixing, agree on rule set.

---

## 1 — High-level flow

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  Readymode CSV  │ →  │   processCSV    │ →  │  Two CSV files  │
│  (call log)     │    │   (filter rules)│    │  Filtered →     │
└─────────────────┘    └─────────────────┘    │   REISift       │
                              │                │  Clean →        │
                              │                │   Readymode     │
                              ▼                └─────────────────┘
                       ┌──────────────┐
                       │   Memory     │  cumulative cross-upload
                       │   (Redis +   │  state — survives dialer
                       │    JSON)     │  resets
                       └──────────────┘
                              │
                              ▼
                  ┌────────────────────────┐
                  │   saveRunToDB          │  global audit + properties
                  │   (13 passes,          │  + contacts + phones +
                  │   single transaction)  │  call_logs + DNC flags
                  └────────────────────────┘
                              │
                              ▼
                  ┌────────────────────────┐
                  │  campaigns.recordUpload│  per-campaign tallies +
                  │  + applyFiltration     │  campaign_numbers +
                  │  ToContacts            │  campaign_contact_phones
                  └────────────────────────┘
                              │
                              ▼
                  ┌────────────────────────┐
                  │  Campaign detail page  │  KPIs anchored on
                  │  /oculah/campaigns/:id │  accepted-by-dialer
                  └────────────────────────┘
```

The same upload simultaneously updates **two stores**: the global properties/contacts/phones graph (cross-campaign) and the campaign-scoped tables (per-campaign tallies + per-phone outcomes for THIS campaign).

---

## 2 — CSV ingestion (`processCSV` in `src/server.js:603-716`)

### 2.1 Column detection

Token-based, case-insensitive. `detectCols()` at `server.js:510-532`. Required columns and the strings each is matched against:

| Logical column | Match candidates |
|----------------|------------------|
| Phone | `phone` |
| Disposition (Log Type) | `log type`, `logtype`, `last dispo`, `lastdispo`, `disposition`, `status` |
| Original Lead File | `original lead file`, `lead file campaign`, `batch name`, `original file name`, `list name`, `campaign` |
| Log Time | `log time`, `logtime`, `status (time)`, `upload date`, `date` |
| Optional | First Name, Last Name, Address, City, State, Zip, Call Notes |

If none match, hard-coded fallback names in `const COL` (`server.js:507`) are used.

### 2.2 Phone normalization

Always via `normalizePhone()` in `src/phone-normalize.js`:

- Strips extensions (`ext 123`, `x3`, `#45`)
- Strips non-digits
- Drops leading `1` on 11-digit numbers (`15551234567` → `5551234567`)
- Returns empty string for international (`+44...`) or 12+ digit non-1-leading
- **Audit note (QW#3):** the older inline `.replace(/\D/g,'')` did NOT strip leading `1`, breaking memory matching across uploads with different phone formats.

### 2.3 Disposition normalization

Single source: `src/disposition-normalize.js`. `normalizeDisposition(raw)` tokenizes (lowercase, replace `_-` with space, strip punctuation) and matches against keyword sets. Canonical buckets:

```
transfer | potential_lead | sold | listed | not_interested | hung_up
wrong_number | voicemail | not_available | do_not_call | dead_call
spanish_speaker | callback | completed | disqualified | other
```

Three exported sets (`disposition-normalize.js:107-137`):

- **CONNECTED_DISPOS** (12 buckets, anything where a human picked up):
  `transfer, potential_lead, sold, listed, not_interested, hung_up, callback, spanish_speaker, do_not_call, completed, disqualified, wrong_number`
- **REACHED_DISPOS:** identical to CONNECTED_DISPOS today (kept separate for future divergence)
- **LEAD_DISPOS:** only `transfer` (Lead / Appointment / Transfer-to-manager all normalize to `transfer`)

### 2.4 The filtration decision tree

For each row in the CSV, `processCSV` decides **Remove** vs **Keep**. Logic at `server.js:667-710`:

| Disposition | Rule | Action | Reclassify? |
|-------------|------|--------|-------------|
| `transfer` | always | Remove | — |
| `potential_lead` / `sold` / `listed` | always | Remove | — |
| `do_not_call` | always | Remove | — |
| `wrong_number` | always | Remove | — |
| `spanish_speaker` | always | Remove | — |
| `disqualified` | always | Remove | — |
| `not_interested` | count ≥ 3 | Remove | — |
| `hung_up` | count ≥ 3 | Remove | → `not_interested` |
| `(NI + HU)` | sum ≥ 4 | Remove | → `not_interested` |
| `(dead_call + not_available)` | sum ≥ 4 | Remove | — |
| `voicemail` | count > 3 (4th VM) | Remove | — |
| anything else | — | Keep | — |

**Reclassification note:** When `hung_up ≥ 3` triggers a remove, the row is output with disposition `not_interested`. The original `hung_up` count is **not** decremented in memory (so a later combined NI+HU rule can still trigger — see §6 quirk #6).

### 2.5 Memory (cross-upload state)

Persisted as JSON file (loaded via `loadMemory()` `server.js:108`, saved after every upload). Keys:

- `wn:{phone}` — global wrong-number, shared across **all** campaigns and tenants
- `dnc:{phone}` — global do-not-call, same scope
- `campaign:{campaignId}||{phone}` — every other disposition is campaign-scoped

**Audit fix #9 (`server.js:588-590`):** campaignId is now mandatory. Pre-fix, omitting it caused two campaigns named "Tax Delinquent IN" to share counters. Now: throws if missing.

**Memory record shape:**

```js
{
  count: cumulative_total,        // sum of all dispos for this phone
  lastDispo: 'raw_string',         // last raw disposition seen
  dispoCounts: {                   // per-bucket counters
    not_interested: 2,
    hung_up: 1,
    voicemail: 4,
    ...
  }
}
```

**Idempotency:** **NOT idempotent.** Re-uploading the same file increments counts twice. Operator must clear memory manually if a duplicate slips through.

**Transfer dedup exception (`server.js:638-640`):** `if (dispo !== 'transfer' && processedKeys[mkey]) return;`. Every transfer is recorded — they're outcomes worth seeing in full.

### 2.6 Output files

Two CSVs generated on `/process`:

| File | Rule | Goes to |
|------|------|---------|
| `hudrei_filtered_reisift.csv` | rows where `Action='remove'` | REISift (remove from callable pool) |
| `hudrei_clean_list.csv` | rows where `Action='keep'` | Readymode dialer |

Columns identical between both files — operator pastes one into REISift to remove, the other into Readymode to call.

---

## 3 — Persistence (`saveRunToDB`, `server.js:1023-1454`)

13 sequential passes inside a single Postgres transaction (Pass 13 — distress rescoring — runs **outside** the txn intentionally):

| Pass | Target table | What it does |
|------|--------------|--------------|
| 1 | `filtration_runs` | one header row per upload (totals) |
| 2 | `markets` | upsert states |
| 3 | `lists` | upsert list names from CSV |
| 4 | `properties` | upsert by (address, city, state, zip) |
| 5 | `property_lists` | property↔list linkage |
| 6-7 | `contacts` | primary contact UPSERT, split into update vs insert |
| 8 | `phones` | UPSERT on (contact_id, phone). **Sets `do_not_call=true` (sticky via GREATEST) when row dispo is `do_not_call`.** Audit fix C-1 |
| 9 | `call_logs` | one row per phone+dispo with disposition |
| 10 | (transfer follow-up) | flags property `pipeline_stage='lead'`; flags transfer phones globally `phone_status='Correct'` |
| 11 | (no-op, removed) | — |
| 12 | `filtration_results` | one audit-trail row per CSV row, including invalid-state rows |
| 13 | (distress rescoring) | re-runs scoring engine; runs OUTSIDE the txn so a scoring bug doesn't roll back the import |

All passes use bulk `UNNEST($1::text[], $2::int[], …)` patterns — single SQL per pass, no N+1.

---

## 4 — Campaign-scoped persistence (`src/filtration.js`)

After `saveRunToDB`, the upload route also calls `campaigns.recordUpload()` and `applyFiltrationToContacts()` to update **per-campaign** state.

### 4.1 `recordUpload(...)` — `filtration.js:67-217`

1. **Tally pass:** loops once, counts: total / kept / filtered / wrong / vm / ni / dnc / transfer / mem / connected / newNums.
2. **Bulk UPSERT into `campaign_numbers`:** split into INSERT (new phones for this campaign) and UPDATE (existing). Critical fields:
   - `current_status` is binary: `'callable'` or `'filtered'`.
   - `total_appearances` increments on every upload (never reset).
   - `cumulative_count` is **OVERWRITTEN, not added** — it reflects Readymode's per-export cumulative, which is already a running total at source.
3. **`campaign_uploads`** row written with all tally fields (per-upload audit).
4. **Campaign aggregates** updated:
   - `total_unique_numbers`, `total_callable`, `total_filtered` recomputed from `campaign_numbers`.
   - `total_wrong_numbers`, `total_voicemails`, `total_not_interested`, `total_do_not_call`, `total_transfers`, `total_connected` incremented additively from the tally.
   - `upload_count` += 1.

### 4.2 `applyFiltrationToContacts(...)` — `filtration.js:225-237`

Per-row OR bulk path, controlled by `LOKI_BATCHED_FILTRATION` env var.

For each row, updates `campaign_contact_phones`:

- `phone_status`: overridden unless already `'dead_number'` (sticky NIS).
- `wrong_number`, `filtered`: OR-ed with existing — **once true, always true**.
- `wrong_number_flagged_at`: set on first confirmation, never cleared.
- `correct_flagged_at`: refreshed on every live pickup.
- `cumulative_count`, `last_disposition`, `phone_tag`: overwritten.

**Transfer outcomes** trigger 3 follow-up bulk updates:
1. `campaign_contacts.marketing_result = 'Lead'`
2. Main `properties.pipeline_stage = 'lead'` (joined via address-normalized columns).
3. Phones with same address globally get `phone_status='Correct'`.

**Hard-fail on bulk failure** (`filtration.js:232-233`): no fallback to per-row — partial state is worse than failure.

### 4.3 `getContactStats(...)` — `filtration.js:778-851`

Returns the object that drives the campaign detail page. All metrics:

| Field | SQL |
|-------|-----|
| `total_contacts` | `COUNT(DISTINCT cc.id)` from `campaign_contacts` |
| `total_phones` | `COUNT(DISTINCT ccp.phone_number)` — **distinct phone, not row** |
| `wrong_phones` | `COUNT(DISTINCT ccp.id) WHERE wrong_number=true` |
| `nis_phones` | `... WHERE phone_status='dead_number'` |
| `filtered_phones` | `... WHERE filtered=true AND wrong_number=false` |
| `correct_phones` | `... WHERE phone_status='Correct'` |
| `reached_contacts` | `COUNT(DISTINCT cc.id)` joined to `campaign_numbers.last_disposition_normalized IN REACHED_DISPOS` |
| `lead_contacts` | same join, `IN LEAD_DISPOS` |
| `total_call_logs` | `SUM(cumulative_count)` from `campaign_numbers` |
| `unique_call_logs` | `COUNT(DISTINCT phone_number)` from `campaign_numbers` |
| `accepted_contacts` | `COUNT(DISTINCT cc.id) WHERE accepted=true` (0 for legacy) |
| `accepted_phones` | `COUNT(DISTINCT ccp.phone_number) WHERE accepted=true` |

---

## 5 — Campaign KPIs (`src/ui/pages/campaign-detail.js:119-173`)

The 5D rule: **denominators anchor on accepted-by-dialer**, falling back to totals only for legacy campaigns where no accepted flag exists.

```js
acceptedContacts = (accepted_contacts > 0) ? accepted_contacts : total_contacts;
acceptedPhones   = (accepted_phones   > 0) ? accepted_phones   : total_phones;
```

| KPI | Formula |
|-----|---------|
| **Call logs (top KPI)** | `SUM(cumulative_count)` — total dial attempts |
| **Unique** subtitle | `COUNT(DISTINCT phone_number)` |
| **Total phones** | `COUNT(DISTINCT phone_number)` — unique phones, not rows |
| **Accepted by Dialer** | `accepted_contacts` (with `manual_count` shown alongside if set) |
| **Callable** | `acceptedPhones - filtered - wrongNums - nisPhones` |
| **Health %** | `Callable / acceptedPhones` |
| **CR (Connect Rate)** | `connected / callLogs` |
| **CLR (Call-log ratio)** | `callLogs / acceptedPhones` |
| **W% (Wrong %)** | `wrongNums / (connected + wrongNums)` |
| **NI%** | `notInterested / connected` |
| **LGR (Lead generation rate)** | `transfers / connected` |
| **LCV (Lead conversion value)** | `leadContacts / acceptedContacts` |
| **Reached %** | `reached_contacts / acceptedContacts` |

**Operator note:** The 5D change moved several denominators from `total_phones` → `acceptedPhones`. For most campaigns, this makes percentages **higher** because the denominator shrinks (only counting contacts the dialer agreed to dial). Legacy campaigns with no accepted data appear unchanged.

---

## 6 — Edge cases / quirks worth knowing

These are the operationally important things — read these before signing off on the rules.

1. **Memory not idempotent.** Re-uploading the same CSV double-counts. No automatic dedupe. Mitigation: operator awareness; consider adding a hash-based dedupe in the future.

2. **Cumulative count is OVERWRITTEN per upload, not summed.** Aligns with Readymode's own meaning ("total dials at export time"). Re-importing an old export with `cumulative_count=5` won't add to a fresher value of 8 — it'll set it back to 5. Newest upload wins.

3. **Transfers never deduplicated.** Every transfer in every upload is recorded. Other dispositions are deduped per memory key per upload.

4. **Hung-up reclassification preserves original count.** When `hung_up ≥ 3` triggers a remove → `not_interested` reclass, the `hung_up` counter stays at 3+ in memory. A later not_interested can still trigger the combined `(NI+HU) ≥ 4` rule. Intentional — but means the same phone can hit two remove rules in a row.

5. **Global DNC and wrong-number keys cross tenant boundaries.** `wn:{phone}` and `dnc:{phone}` are bare phone numbers, not tenant-scoped. If two tenants share a phone number, the DNC mark applies to both. The campaign-clean-export step (`generateCleanExport`) does scope by `tenant_id`, so leakage is one-directional (the global memory thinks DNC, but the export still respects tenant boundaries on the phones table).

6. **No "un-DNC" path.** Once DNC, always DNC. Same for wrong_number. Manual DB edit only.

7. **Address case sensitivity fixed (audit #3, #29).** Address comparisons on transfer-flagging use `LOWER + TRIM + collapse-whitespace` normalization. "123 Main St" and "123 main st" now match.

8. **Phone status case sensitivity NOT fully fixed.** `generateCleanExport` checks `p.status === 'dead_number'` (lowercase). If a CSV writes `'Dead Number'` (title case) into `phone_status`, it won't match. Consider normalizing on write.

9. **`generateCleanExport` has a 250k row hard limit** (`filtration.js:666`). No warning if hit; quietly drops the rest. Hasn't bitten yet but worth knowing.

10. **CSV formula injection blocked** (`server.js:724-726`). Cells starting with `=`, `+`, `-`, `@` get a leading `'` so Excel won't execute them. Safe.

11. **NIS dedup fixed (audit #23).** Pre-fix: re-uploading the same NIS export double-incremented `times_reported`. Post-fix: a separate `nis_events` table tracks `(phone, day)` tuples, deduped by day.

12. **Owner-mismatch handling (5A.2).** When importing a contact list, if the same phone appears with a different owner name, Layer 1 wrong/correct memory is cleared on that phone (Layer 1.5 lead memory preserved). Prevents stale "wrong number" flags from sticking when a property changed hands.

13. **Filter parity rule (CLAUDE.md).** Every records-page filter must be re-applied identically across every "Select All → bulk action" SQL handler. Drift = silent over-deletion. Worth a periodic audit but not a runtime concern.

14. **Distress rescoring outside transaction.** Pass 13 of `saveRunToDB` runs after commit. A scoring bug won't roll back the upload, but it might leave scores stale — operator should check `/records/_distress` for the "last scored" timestamp.

---

## 7 — Sign-off checklist

Read this list. Confirm each is intended behavior, or flag for change.

- [ ] **The 8 ALWAYS_REM dispositions** (transfer, potential_lead, sold, listed, do_not_call, wrong_number, spanish_speaker, disqualified) are correct and complete.
- [ ] **3-strike thresholds** (NI ≥ 3, HU ≥ 3, VM > 3, NI+HU ≥ 4, DC+NA ≥ 4) match the SOP.
- [ ] **Hung-up reclassifies to not_interested** on remove — intended.
- [ ] **Wrong-number is a connected/live-pickup AND a remove** — intended (changed in 5E).
- [ ] **Transfer / potential_lead / sold / listed all count as Reached** — intended (changed in 5E).
- [ ] **Memory is global per phone for DNC + wrong, campaign-scoped for everything else** — intended.
- [ ] **Memory is NOT idempotent on re-upload** — acceptable given operator workflow, OR needs hash-based dedupe.
- [ ] **`cumulative_count` is overwritten, not summed** on subsequent uploads — intended (matches Readymode export semantics).
- [ ] **Transfers never deduplicated** — intended.
- [ ] **Once DNC / wrong, always DNC / wrong** — intended (no UI to reverse).
- [ ] **KPIs anchor on accepted_phones / accepted_contacts** with fallback to total — intended (5D).
- [ ] **`generateCleanExport` 250k hard limit** — acceptable cap, OR needs operator-visible warning when hit.
- [ ] **Cross-tenant DNC/wrong leakage** in global memory keys — acceptable for current single-tenant use, needs tenant-scoping before HudREI accepts a sub-tenant.

---

**File references**

| Concern | File | Lines |
|---------|------|-------|
| `processCSV` core filter | `src/server.js` | 603-716 |
| `saveRunToDB` 13 passes | `src/server.js` | 1023-1454 |
| Memory key building | `src/server.js` | 588-602 |
| `recordUpload` campaign tally | `src/filtration.js` | 67-217 |
| `applyFiltrationToContacts` per-row | `src/filtration.js` | 239-370 |
| `applyFiltrationToContacts` bulk | `src/filtration.js` | 376-544 |
| `getContactStats` | `src/filtration.js` | 778-851 |
| `generateCleanExport` callability | `src/filtration.js` | 565-775 |
| Disposition normalization | `src/disposition-normalize.js` | full file |
| Campaign schema | `src/campaigns.js` | 30-250 |
| `importContactList` (token auto-detect) | `src/campaigns.js` | 642-900 |
| KPI computation | `src/ui/pages/campaign-detail.js` | 119-173 |
| Upload wizard routes | `src/routes/upload-routes.js` | 46-169 |
| Phone normalization | `src/phone-normalize.js` | full file |
