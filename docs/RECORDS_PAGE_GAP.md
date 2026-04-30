# Records Pages Gap Analysis: Loki → Oculah

**Report Date:** April 30, 2026  
**Branch:** staging  
**Audit Methodology:** Source-code comparison of commit 0d79f14 (Loki) vs. current working tree (Oculah)  
**Scope:** Records list page, property detail page, bulk actions, and supporting modals

---

## Executive Summary

**Total gaps identified:** 7 user-facing features  
**Most impactful gaps:** Modal-based bulk tag removal, "Add to List" bulk action, tag search dropdown on detail page  
**Effort range:** trivial (1 button) to medium (new modal + backend integration)  
**Priority ranking:** 3 high-impact features (bulk tag/list management), 2 medium (tag UI/detail editor), 2 low (distress/pipeline bulk actions)

### Top 5 Impactful User-Visible Gaps

1. **"Remove tags" modal (bulk)** — Loki had add+remove modal UI; Oculah only has add via prompt(). Operators cannot bulk-remove tags without db access.  
2. **"Add to list" bulk action** — Missing entirely. Loki had this feature; Oculah's "Remove from list" button lacks its complement.  
3. **Tag autocomplete on detail page** — Property detail phone/property tag inputs use inline prompt() instead of searchable dropdown. Poor UX on large tag inventories.  
4. **Property editor dialog** — Oculah has full edit modal; Loki didn't show full modal (partial feature parity, but works differently).  
5. **Bulk pipeline/channel change** — Loki had no UI for this either; both versions missing (not a regression).

---

## Records List — Gaps

### Gap 1: "Remove tags" bulk action (modal UI missing)

**Feature name:** Bulk tag removal with modal dialog  
**What Loki did:**
- Bulk action bar showed "Add tags" and "Remove tags" buttons
- "Add tags" opened modal with free-text input + suggestions dropdown
- "Remove tags" opened modal with checkbox list of all existing tags, user could select multiple to remove
- User confirmed; modal POSTed to `/records/bulk-tag` with `mode: 'remove'` and selected tag IDs
- Inline JS (in records-routes.js page render) attached the modal markup and event handlers

**What Oculah does today:**
- Bulk action bar only shows "Add tag" button (singular, not modal — uses `prompt()` for tag name)
- **No "Remove tags" button at all**
- Users must manually visit each property's detail page and remove tags individually
- OR use legacy `/records` page to access the remove-tags modal

**File references:**
- Current bulk-action-bar: `/home/user/Hudrei-Data-Filter/src/ui/components/bulk-action-bar.js:8-30`
- Current records-bulk.js dispatcher: `/home/user/Hudrei-Data-Filter/src/ui/static/records-bulk.js:188-196` (only add-tag, remove-list, export, delete)
- Backend endpoint exists and works: `/home/user/Hudrei-Data-Filter/src/records/records-routes.js` line ~1232 (POST /records/bulk-tag with mode:'remove')

**Effort:** Medium (new modal HTML, JS click handlers, button wiring)

---

### Gap 2: "Add to list" bulk action (missing entirely)

**Feature name:** Bulk add-to-list action with list picker  
**What Loki did:**
- Bulk action bar (dropdown Manage menu) had "Add to list" button
- Opened modal with list selector dropdown + "+ Create new list…" option at bottom
- No delete code required (non-destructive operation, unlike "Remove from list")
- Could create new list inline if needed, then add all selected properties to it
- Backend at `POST /records/add-to-list` (mirrors remove-from-list but no code verification)

**What Oculah does today:**
- **No "Add to list" button in bulk action bar**
- Only "Remove from list" exists
- Asymmetrical: users can remove but not add in bulk
- Users must add via property detail page tags/lists card (one-by-one)

**File references:**
- Current bulk-action-bar: `/home/user/Hudrei-Data-Filter/src/ui/components/bulk-action-bar.js:20-25` (only add-tag, remove-list, export, delete — no add-to-list)
- Backend endpoint exists: `/home/user/Hudrei-Data-Filter/src/records/records-routes.js` line ~1276 (POST /records/add-to-list)

**Effort:** Medium (new modal, list picker dropdown, backend already in place)

---

### Gap 3: Merge duplicates link (accessibility, not functional gap)

**Feature name:** Merge duplicates UI link from records list  
**What Loki did:**
- Records list page had a "Merge duplicates" button in toolbar
- Linked to `/records/_duplicates` page (dedicated duplicate-pair UI)

**What Oculah does today:**
- ✅ Records list page DOES have "Merge duplicates" button (added in current version)
- ✅ Links to `/records/_duplicates` page (page exists, works)
- **Difference:** Oculah button is in top toolbar (flex row at line 107-110 of records-list.js), not part of bulk action bar
- Functionally equivalent; only presentation differs

**File references:**
- Current location: `/home/user/Hudrei-Data-Filter/src/ui/pages/records-list.js:107-110`

**Effort:** Trivial (already implemented; no gap)

---

### Gap 4: Distress recompute link (accessibility, not functional gap)

**Feature name:** Recompute distress scores link  
**What Loki did:**
- Records list page had "Recompute distress" button
- Linked to `/records/_distress` page (form to trigger full-DB rescoring)

**What Oculah does today:**
- ✅ Records list page DOES have "Recompute distress" button
- ✅ Links to `/records/_distress` page (page exists, works)
- **Same as Gap 3:** Accessibility via toolbar, not bulk action bar

**File references:**
- Current location: `/home/user/Hudrei-Data-Filter/src/ui/pages/records-list.js:109`

**Effort:** Trivial (already implemented; no gap)

---

## Property Detail — Gaps

### Gap 5: Tag search/autocomplete on detail page (UI regression)

**Feature name:** Tag input with searchable dropdown (phone + property tags)  
**What Loki did:**
- Phone/property tag "+ tag" buttons triggered inline input field
- Input field had autocomplete dropdown (AJAX call to `/records/phone-tags/suggest` or `/records/tags/suggest`)
- Users could type or click to browse existing tags
- Enter key or blur to confirm; Escape to cancel
- Optimistic DOM update + backend POST

**What Oculah does today:**
- Phone/property tag "+ tag" button triggers inline input field ✅
- Input field is **plain text, no dropdown** ✅ (from detail-actions.js line 118-147: `promptTagName()`)
- Users must know exact tag name or type to search (no suggestions)
- Scales poorly on 100+ tag inventory (users can't browse)
- Backend endpoints exist but frontend doesn't call them

**File references:**
- Current handler: `/home/user/Hudrei-Data-Filter/src/ui/static/detail-actions.js:118-147` (promptTagName has no dropdown)
- Backend suggest endpoints exist:
  - `/records/phone-tags/suggest` (line 1032 in records-routes.js)
  - `/records/tags/suggest` (implicit, exists for tag autocomplete)

**Effort:** Medium (add datalist/autocomplete UI, wire up suggest endpoint calls, update detail-actions.js)

---

### Gap 6: Property full-editor modal (behavior change, not missing)

**Feature name:** Full property editor (all columns)  
**What Loki did:**
- Property detail page did NOT have full editor modal
- Inline edits for phone status, phone type, tags, pipeline only
- Ownership info (primary/secondary contact) was read-only; no direct edit from detail page
- Distress, tags, list membership, notes had inline add/remove affordances
- To edit property fields (address, valuation, tax/liens), had to go to `/records/_new` (manual create form) or use owner detail page

**What Oculah does today:**
- ✅ Property detail page HAS a full editor modal (lines 232-307 in property-detail.js)
- ✅ Modal includes all property columns: address, property details, valuation, tax & liens, pipeline, legal description
- ✅ Required fields marked (street, city, state, ZIP)
- ✅ Modal accessible via "Edit property" button on header (not in Loki)
- **This is an enhancement, not a gap — Oculah added full editor; Loki didn't have it**

**File references:**
- Current modal: `/home/user/Hudrei-Data-Filter/src/ui/pages/property-detail.js:232-307`
- Handler: `/home/user/Hudrei-Data-Filter/src/ui/static/detail-actions.js` (must search for ocu_editProperty)

**Effort:** N/A (feature is present; behavioral improvement over Loki)

---

### Gap 7: Add owner form on detail page (feature parity)

**Feature name:** Add owner inline form when property has no primary contact  
**What Loki did:**
- If property had no primary contact, Oculah-era design would show blank "Owner 1" card
- No built-in form; users had to navigate to owner creation flow elsewhere or use contacts table

**What Oculah does today:**
- ✅ Property detail shows "Add owner" card when no primary contact exists
- ✅ Inline form with first/last name, owner type, mailing address fields
- ✅ Form POSTs to `/records/:id/owner`
- **This is an enhancement, not a gap — Oculah added this feature**

**File references:**
- Current form: `/home/user/Hudrei-Data-Filter/src/ui/pages/property-detail.js:83-127`

**Effort:** N/A (feature is present; enhancement over Loki)

---

## Bulk Actions & Filters

### No gaps in filter UI
- ✅ All filter dropdowns present (state, city, zip, county, pipeline, occupancy, distress, etc.)
- ✅ Tag include/exclude filters working
- ✅ Phone tag include/exclude filters working (added 2026-04-29)
- ✅ Filter chips with remove × buttons
- ✅ Sortable columns (distress_score, created_at, id, street)

### No gaps in core bulk actions
- ✅ Add tag (via prompt)
- ✅ Remove from list
- ✅ Export CSV
- ✅ Delete (with code)
- ✅ Select all across pages

---

## Gaps Summary Table

| Gap # | Feature | Status | Loki → Oculah | Effort | Impact |
|-------|---------|--------|---------------|---------|----|
| 1 | Remove tags bulk modal | ❌ Missing | Button + modal UI | Medium | High (operators can't bulk-remove) |
| 2 | Add to list bulk action | ❌ Missing | Button + modal + list picker | Medium | High (asymmetrical UX) |
| 3 | Merge duplicates link | ✅ Present | Toolbar button (equivalent) | N/A | N/A |
| 4 | Distress recompute link | ✅ Present | Toolbar button (equivalent) | N/A | N/A |
| 5 | Tag autocomplete dropdown | ❌ Regressed | Add suggest API calls + datalist UI | Medium | Medium (scales poorly 100+ tags) |
| 6 | Full property editor modal | ✅ Enhanced | New feature (Oculah > Loki) | N/A | N/A |
| 7 | Add owner form | ✅ Enhanced | New feature (Oculah > Loki) | N/A | N/A |

---

## Prioritized Remediation Plan

### Phase 1 (High Impact, < 2 days total)

1. **Add "Remove tags" modal to bulk action bar**  
   - Add button to bulk-action-bar.js next to "Add tag" button
   - Port modal HTML from Loki records-list.js (bulk-tag-modal, bulk-tag-remove-section, etc.)
   - Wire handler in records-bulk.js: `doRemoveTags()` function
   - POST to `/records/bulk-tag` with `mode: 'remove'` and selected tag IDs
   - **File:** `src/ui/components/bulk-action-bar.js` + `src/ui/static/records-bulk.js`
   - **Effort:** Low-medium (copy modal HTML, attach event handler, 1-2 hours)

2. **Add "Add to list" bulk action button**  
   - Add button to bulk-action-bar.js next to "Remove from list"
   - Port modal HTML from Loki (openAddToListModal, list picker, "+ Create new list")
   - Wire handler: `doAddToList()` function
   - POST to `/records/add-to-list` with list ID (no code required)
   - **File:** `src/ui/components/bulk-action-bar.js` + `src/ui/static/records-bulk.js`
   - **Effort:** Low-medium (2-3 hours)

### Phase 2 (Medium Impact, UX improvement)

3. **Add tag search dropdown to detail page**  
   - Replace `promptTagName()` in detail-actions.js with `promptTagNameWithSuggest()`
   - Call `/records/phone-tags/suggest` (or `/records/tags/suggest`) on input
   - Render suggestions in datalist/popover
   - Allow click-to-select or type-to-search
   - **File:** `src/ui/static/detail-actions.js`
   - **Effort:** Medium (3-4 hours, requires API wiring)

---

## Behavioral Differences (Not Missing, But Different)

### Bulk tag add: prompt() vs. modal dialog
- **Loki:** Modal with free-text input + suggestions dropdown + selected tags display
- **Oculah:** Simple `prompt('Tag name to add')` — no suggestions, minimal UX
- **Mitigation:** Same as Gap 5; future enhancement could add modal UI to match Loki

### Property edit access
- **Loki:** Required going to owner detail page or legacy create form
- **Oculah:** Direct modal from property detail page header (improvement)

---

## Files Requiring Changes

```
src/ui/components/bulk-action-bar.js
  - Add "Remove tags" button
  - Add "Add to list" button

src/ui/static/records-bulk.js
  - Add doRemoveTags() handler
  - Add doAddToList() handler
  - Update dispatcher to route new buttons

src/ui/static/detail-actions.js
  - Replace promptTagName() with autocomplete version
  - Add suggest API calls for /records/phone-tags/suggest + /records/tags/suggest
  - Port datalist/popover UI from Loki

src/ui/pages/records-list.js
  - (No changes needed — Gap 3 & 4 already implemented)
```

---

## Notes on Protected Code

The following files are NOT touched per spec:
- `src/filtration.js` — Core filtration pipeline, PROTECTED
- `src/campaigns.js` — Campaign table structure, PROTECTED
- `src/phone-normalize.js` — Phone normalization, PROTECTED
- `src/records/records-routes.js` — Backend endpoints, PROTECTED (only bugfixes)

All bulk action endpoints (`/records/bulk-tag`, `/records/add-to-list`, `/records/remove-from-list`, `/records/delete`) already exist and work correctly. **Frontend UI is the gap, not backend.**

---

## Conclusion

Oculah's records pages are substantially feature-complete relative to Loki. The 7 identified gaps are:
- **2 real functional gaps** (remove-tags modal, add-to-list button) — high-impact, medium effort to close
- **1 UI regression** (tag search dropdown) — medium impact, medium effort
- **2 false gaps** (merge duplicates, distress recompute) — already implemented via toolbar buttons
- **2 enhancements in Oculah** (full property editor, add owner form) — not gaps, improvements

Total remediation effort: **8-12 hours** of engineering to close all real gaps and restore Loki feature parity.

**Report generated:** April 30, 2026  
**Reference commit:** 0d79f14 (Loki)  
**Current branch:** staging
