// ═══════════════════════════════════════════════════════════════════════════════
// views/filter-panel.js — renders the collapsible filter panel for /records.
//
// 2026-04-23 extracted from records-routes.js. This is a PURE HTML renderer:
//   - No DB queries
//   - No query param parsing
//   - No SQL building
//   - No side effects
//
// It takes an object with all the variables the old inline template literal
// closed over, and returns the HTML string. One call replaces ~314 lines.
// If this renders wrong, the fix is visual, not correctness — no silent bugs.
// ═══════════════════════════════════════════════════════════════════════════════

// Duplicated from records-routes.js — kept local so this module has no
// runtime dependencies. Identical behavior.
function escHTML(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
const esc = escHTML;

function renderFilterPanel(opts) {
  const {
    activeFilterCount,
    allLists, allPhoneTags, allStates, allTags,
    stateList, city, zip, county,
    type, prop_status, occupancy, pipeline,
    min_year, max_year, min_assessed, max_assessed,
    min_equity, max_equity, min_owned, max_owned,
    min_years_owned, max_years_owned,
    min_stack, min_distress,
    phones, owner_type, mailing, phone_type,
    tagIncludeList, tagExcludeList,
    phoneTagIncludeList, phoneTagExcludeList,
    mktIncludeList, mktExcludeList,
    stackList,
    upload_from, upload_to,
    list_id,
  } = opts;

  return `
        <div id="filter-panel" style="display:${activeFilterCount>0?'block':'none'};background:#fff;border:1px solid #e0dfd8;border-radius:10px;padding:16px 18px;margin-bottom:14px">

          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px">

            <!-- Location -->
            <div style="grid-column:1/-1;font-size:10px;font-weight:700;color:#aaa;text-transform:uppercase;letter-spacing:.1em;margin-bottom:2px">Location</div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">State <span id="state-count-label" style="color:#888">${stateList.length > 0 ? '('+stateList.length+' selected)' : ''}</span></label>
              <div id="state-ms-wrapper" style="position:relative">
                <div id="state-ms-control" onclick="toggleStateMsDropdown(event)" style="min-height:34px;border:1px solid #ddd;border-radius:7px;padding:4px 26px 4px 6px;background:#fff;cursor:text;display:flex;flex-wrap:wrap;gap:3px;align-items:center;font-size:13px">
                  <div id="state-ms-pills" style="display:flex;flex-wrap:wrap;gap:3px">
                    ${stateList.length === 0 ? '<span id="state-ms-placeholder" style="color:#aaa;font-size:13px;padding:2px">All States</span>' : ''}
                    ${allStates.filter(s => stateList.includes(s.code)).map(s => `
                      <span class="state-ms-pill" data-id="${s.code}" style="display:inline-flex;align-items:center;gap:4px;background:#e8f0ff;color:#1a4a9a;padding:2px 6px;border-radius:4px;font-size:12px;font-weight:500">
                        ${s.code}
                        <button type="button" onclick="removeStateMsPill(event,'${s.code}')" style="background:none;border:none;color:#1a4a9a;cursor:pointer;padding:0;font-size:13px;line-height:1;font-family:inherit">×</button>
                      </span>
                    `).join('')}
                  </div>
                  <span style="position:absolute;right:8px;top:50%;transform:translateY(-50%);color:#888;font-size:10px;pointer-events:none">▾</span>
                </div>
                <div id="state-ms-dropdown" style="display:none;position:absolute;top:calc(100% + 4px);left:0;right:0;background:#fff;border:1px solid #ddd;border-radius:7px;box-shadow:0 4px 16px rgba(0,0,0,.08);max-height:240px;overflow:hidden;z-index:100;flex-direction:column">
                  <input type="text" id="state-ms-search" placeholder="Search state…" oninput="filterStateMsOptions()" onclick="event.stopPropagation()" onkeydown="stateMsSearchKeydown(event)" style="width:100%;padding:7px 9px;border:none;border-bottom:1px solid #eee;font-size:13px;font-family:inherit;outline:none;box-sizing:border-box">
                  <div id="state-ms-options" style="overflow-y:auto;flex:1">
                    ${allStates.length === 0
                      ? '<div style="color:#aaa;font-size:13px;padding:10px">No states found</div>'
                      : allStates.map(s => {
                          const isSel = stateList.includes(s.code);
                          const safeName = (s.name || '').replace(/'/g, "\\'");
                          return `<div class="state-ms-option" data-id="${s.code}" data-search="${(s.code+' '+s.name).toLowerCase()}" onclick="toggleStateMsOption(event,'${s.code}','${safeName}')" style="padding:6px 10px;font-size:13px;cursor:pointer;display:flex;align-items:center;gap:8px;${isSel ? 'background:#f0f7ff;color:#1a4a9a;font-weight:500' : ''}" onmouseover="if(!this.classList.contains('state-ms-selected'))this.style.background='#fafaf8'" onmouseout="if(!this.classList.contains('state-ms-selected'))this.style.background=''">
                            <span style="width:14px;display:inline-block">${isSel ? '✓' : ''}</span>
                            <span style="font-weight:500;font-family:monospace;width:28px">${s.code}</span>
                            <span style="color:#888">${escHTML(s.name || '')}</span>
                          </div>`;
                        }).join('')}
                  </div>
                </div>
              </div>
              <div id="state-ms-hidden-inputs">
                ${stateList.map(c => `<input type="hidden" name="state" value="${c}">`).join('')}
              </div>
            </div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">City</label>
              <input type="text" name="city" value="${city}" placeholder="e.g. Indianapolis, Avon" style="width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit">
              <p style="font-size:10px;color:#aaa;margin-top:3px">Comma-separate to match multiple</p>
            </div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">ZIP Code</label>
              <input type="text" name="zip" value="${zip}" placeholder="e.g. 46218, 46219, 46220" style="width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit">
              <p style="font-size:10px;color:#aaa;margin-top:3px">Comma- or space-separated</p>
            </div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">County</label>
              <input type="text" name="county" value="${county}" placeholder="e.g. Marion, Hamilton" style="width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit">
              <p style="font-size:10px;color:#aaa;margin-top:3px">Comma-separate to match multiple</p>
            </div>

            <!-- Property -->
            <div style="grid-column:1/-1;font-size:10px;font-weight:700;color:#aaa;text-transform:uppercase;letter-spacing:.1em;margin:6px 0 2px">Property</div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">Type</label>
              <select name="type" style="width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit;background:#fff">
                <option value="">All Types</option>
                ${['SFR','MFR','Land','Commercial'].map(t=>`<option value="${t}" ${type===t?'selected':''}>${t}</option>`).join('')}
              </select>
            </div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">Property Status</label>
              <select name="prop_status" style="width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit;background:#fff">
                <option value="">Any</option>
                ${['Off Market','Pending','Sold'].map(s=>`<option value="${s}" ${prop_status===s?'selected':''}>${s}</option>`).join('')}
              </select>
            </div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">Owner Occupancy</label>
              <select name="occupancy" style="width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit;background:#fff">
                <option value="">Any</option>
                <option value="owner_occupied" ${occupancy==='owner_occupied'?'selected':''}>Owner Occupied</option>
                <option value="absent_owner"   ${occupancy==='absent_owner'?'selected':''}>Absent Owner</option>
                <option value="unknown"        ${occupancy==='unknown'?'selected':''}>Unknown</option>
              </select>
            </div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">Pipeline Stage</label>
              <select name="pipeline" style="width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit;background:#fff">
                <option value="">Any</option>
                ${['prospect','lead','contract','closed'].map(s=>`<option value="${s}" ${pipeline===s?'selected':''}>${s.charAt(0).toUpperCase()+s.slice(1)}</option>`).join('')}
              </select>
            </div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">Year Built</label>
              <div style="display:flex;gap:6px;align-items:center">
                <input type="number" name="min_year" value="${min_year}" placeholder="From" style="width:100%;padding:7px 8px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit">
                <span style="color:#aaa;font-size:12px">–</span>
                <input type="number" name="max_year" value="${max_year}" placeholder="To" style="width:100%;padding:7px 8px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit">
              </div>
            </div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">Assessed Value ($)</label>
              <div style="display:flex;gap:6px;align-items:center">
                <input type="number" name="min_assessed" value="${min_assessed}" placeholder="Min" style="width:100%;padding:7px 8px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit">
                <span style="color:#aaa;font-size:12px">–</span>
                <input type="number" name="max_assessed" value="${max_assessed}" placeholder="Max" style="width:100%;padding:7px 8px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit">
              </div>
            </div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">Equity (%)</label>
              <div style="display:flex;gap:6px;align-items:center">
                <input type="number" name="min_equity" value="${min_equity}" placeholder="Min" style="width:100%;padding:7px 8px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit">
                <span style="color:#aaa;font-size:12px">–</span>
                <input type="number" name="max_equity" value="${max_equity}" placeholder="Max" style="width:100%;padding:7px 8px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit">
              </div>
            </div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">Phones</label>
              <select name="phones" style="width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit;background:#fff">
                <option value="">Any</option>
                <option value="has"  ${phones==='has' ?'selected':''}>Has phones</option>
                <option value="none" ${phones==='none'?'selected':''}>No phones</option>
              </select>
            </div>
            <!-- 2026-04-21 Phone Type filter. "Any linked phone matches"
                 semantics — the property shows if at least one phone on
                 the primary contact has the selected type. -->
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">Phone Type</label>
              <select name="phone_type" style="width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit;background:#fff">
                <option value="">Any</option>
                <option value="mobile"   ${phone_type==='mobile'  ?'selected':''}>Mobile (textable)</option>
                <option value="landline" ${phone_type==='landline'?'selected':''}>Landline (call only)</option>
                <option value="voip"     ${phone_type==='voip'    ?'selected':''}>VoIP</option>
                <option value="unknown"  ${phone_type==='unknown' ?'selected':''}>Unknown</option>
              </select>
            </div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">Phone Tag — Include</label>
              <select name="phone_tag_include" multiple size="3" style="width:100%;padding:5px 10px;border:1px solid #ddd;border-radius:7px;font-size:12px;font-family:inherit;background:#fff" ${allPhoneTags.length === 0 ? 'disabled' : ''}>
                ${allPhoneTags.map(t => `<option value="${t.id}" ${phoneTagIncludeList.includes(t.id) ? 'selected' : ''}>${escHTML(t.name)}</option>`).join('')}
              </select>
              <div style="font-size:10px;color:#aaa;margin-top:2px">Ctrl/Cmd-click to multi-select · has ANY of these</div>
            </div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">Phone Tag — Exclude</label>
              <select name="phone_tag_exclude" multiple size="3" style="width:100%;padding:5px 10px;border:1px solid #ddd;border-radius:7px;font-size:12px;font-family:inherit;background:#fff" ${allPhoneTags.length === 0 ? 'disabled' : ''}>
                ${allPhoneTags.map(t => `<option value="${t.id}" ${phoneTagExcludeList.includes(t.id) ? 'selected' : ''}>${escHTML(t.name)}</option>`).join('')}
              </select>
              <div style="font-size:10px;color:#aaa;margin-top:2px">Hide if has ANY of these</div>
            </div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">Properties Owned</label>
              <div style="display:flex;gap:6px;align-items:center">
                <input type="number" name="min_owned" value="${min_owned}" placeholder="Min" min="1" style="width:100%;padding:7px 8px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit">
                <span style="color:#aaa;font-size:12px">–</span>
                <input type="number" name="max_owned" value="${max_owned}" placeholder="Max" min="1" style="width:100%;padding:7px 8px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit">
              </div>
              <div style="font-size:10px;color:#aaa;margin-top:2px">By mailing address</div>
            </div>
            <!-- 2026-04-21 Feature 3: Ownership Duration. Years computed
                 from p.last_sale_date. Properties with NULL last_sale_date
                 are excluded (see SQL comment in main list route). -->
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">Years Owned</label>
              <div style="display:flex;gap:6px;align-items:center">
                <input type="number" name="min_years_owned" value="${min_years_owned}" placeholder="Min" min="0" max="200" style="width:100%;padding:7px 8px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit">
                <span style="color:#aaa;font-size:12px">–</span>
                <input type="number" name="max_years_owned" value="${max_years_owned}" placeholder="Max" min="0" max="200" style="width:100%;padding:7px 8px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit">
              </div>
              <div style="font-size:10px;color:#aaa;margin-top:2px">Since last sale date</div>
            </div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">Tag — Include</label>
              <select name="tag_include" multiple size="3" style="width:100%;padding:5px 10px;border:1px solid #ddd;border-radius:7px;font-size:12px;font-family:inherit;background:#fff" ${allTags.length === 0 ? 'disabled' : ''}>
                ${allTags.map(t => `<option value="${t.id}" ${tagIncludeList.includes(t.id) ? 'selected' : ''}>${escHTML(t.name)}</option>`).join('')}
              </select>
              <div style="font-size:10px;color:#aaa;margin-top:2px">Ctrl/Cmd-click to multi-select · has ANY of these</div>
            </div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">Tag — Exclude</label>
              <select name="tag_exclude" multiple size="3" style="width:100%;padding:5px 10px;border:1px solid #ddd;border-radius:7px;font-size:12px;font-family:inherit;background:#fff" ${allTags.length === 0 ? 'disabled' : ''}>
                ${allTags.map(t => `<option value="${t.id}" ${tagExcludeList.includes(t.id) ? 'selected' : ''}>${escHTML(t.name)}</option>`).join('')}
              </select>
              <div style="font-size:10px;color:#aaa;margin-top:2px">Hide if has ANY of these</div>
            </div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">Owner Type</label>
              <select name="owner_type" style="width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit;background:#fff">
                <option value="">Any</option>
                <option value="Person"  ${owner_type==='Person' ?'selected':''}>Person</option>
                <option value="Company" ${owner_type==='Company'?'selected':''}>Company (LLC / Corp)</option>
                <option value="Trust"   ${owner_type==='Trust'  ?'selected':''}>Trust</option>
              </select>
            </div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">Mailing Address</label>
              <select name="mailing" style="width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit;background:#fff">
                <option value="">Any</option>
                <option value="clean"      ${mailing==='clean'     ?'selected':''}>Clean (complete)</option>
                <option value="incomplete" ${mailing==='incomplete'?'selected':''}>Incomplete</option>
              </select>
              <div style="font-size:10px;color:#aaa;margin-top:2px">All four fields required for Clean</div>
            </div>

            <!-- Marketing -->
            <div style="grid-column:1/-1;font-size:10px;font-weight:700;color:#aaa;text-transform:uppercase;letter-spacing:.1em;margin:6px 0 2px">Marketing</div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">Marketing Result — Include</label>
              <div style="position:relative">
                <button type="button" id="mkt-inc-btn" onclick="toggleMkt('inc')" style="width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit;background:#fff;text-align:left;cursor:pointer">
                  <span id="mkt-inc-summary">${mktIncludeList.length > 0 ? esc(mktIncludeList.join(', ')) : 'Any'}</span>
                  <span style="float:right;color:#aaa">▾</span>
                </button>
                <div id="mkt-inc-pop" style="display:none;position:absolute;top:100%;left:0;right:0;margin-top:4px;background:#fff;border:1px solid #ddd;border-radius:7px;box-shadow:0 4px 12px rgba(0,0,0,.08);z-index:10;max-height:240px;overflow-y:auto;padding:6px 0">
                  ${['Lead','Potential Lead','Sold','Listed','Not Interested','Do Not Call','Spanish Speaker'].map(s => `
                    <label style="display:flex;align-items:center;gap:8px;padding:6px 12px;cursor:pointer;font-size:13px" onmouseover="this.style.background='#f5f4f0'" onmouseout="this.style.background='transparent'">
                      <input type="checkbox" name="mkt_include" value="${s}" ${mktIncludeList.includes(s) ? 'checked' : ''} onchange="updateMktSummary('inc')">
                      <span>${s}</span>
                    </label>`).join('')}
                </div>
              </div>
              <p style="font-size:10px;color:#aaa;margin-top:3px">Match any selected (OR)</p>
            </div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">Marketing Result — Exclude</label>
              <div style="position:relative">
                <button type="button" id="mkt-exc-btn" onclick="toggleMkt('exc')" style="width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit;background:#fff;text-align:left;cursor:pointer">
                  <span id="mkt-exc-summary">${mktExcludeList.length > 0 ? esc(mktExcludeList.join(', ')) : 'None'}</span>
                  <span style="float:right;color:#aaa">▾</span>
                </button>
                <div id="mkt-exc-pop" style="display:none;position:absolute;top:100%;left:0;right:0;margin-top:4px;background:#fff;border:1px solid #ddd;border-radius:7px;box-shadow:0 4px 12px rgba(0,0,0,.08);z-index:10;max-height:240px;overflow-y:auto;padding:6px 0">
                  ${['Lead','Potential Lead','Sold','Listed','Not Interested','Do Not Call','Spanish Speaker'].map(s => `
                    <label style="display:flex;align-items:center;gap:8px;padding:6px 12px;cursor:pointer;font-size:13px" onmouseover="this.style.background='#f5f4f0'" onmouseout="this.style.background='transparent'">
                      <input type="checkbox" name="mkt_exclude" value="${s}" ${mktExcludeList.includes(s) ? 'checked' : ''} onchange="updateMktSummary('exc')">
                      <span>${s}</span>
                    </label>`).join('')}
                </div>
              </div>
              <p style="font-size:10px;color:#aaa;margin-top:3px">Hide these results from list</p>
            </div>
            ${(() => {
              const overlap = mktIncludeList.filter(v => mktExcludeList.includes(v));
              return overlap.length > 0 ? `
                <div style="grid-column:1/-1;background:#fff8e1;border:1px solid #f5d06b;border-radius:7px;padding:8px 12px;font-size:12px;color:#7a5a00">
                  ⚠️ <strong>${esc(overlap.join(', '))}</strong> is in both Include and Exclude — this will return 0 results. Remove from one side.
                </div>` : '';
            })()}
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">Upload Date From</label>
              <input type="date" name="upload_from" value="${upload_from}" style="width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit">
            </div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">Upload Date To</label>
              <input type="date" name="upload_to" value="${upload_to}" style="width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit">
            </div>

            <!-- List Stacking -->
            <div style="grid-column:1/-1;font-size:10px;font-weight:700;color:#aaa;text-transform:uppercase;letter-spacing:.1em;margin:6px 0 2px">List Stacking</div>
            <div style="grid-column:1/-1">
              <label style="font-size:11px;color:#888;display:block;margin-bottom:6px">Stacks on ALL of these lists <span id="stack-count-label" style="color:#1a1a1a;font-weight:600">(${stackList.length} selected)</span></label>

              <!-- Multi-select dropdown: pills above, dropdown opens on click -->
              <div id="ms-wrapper" style="position:relative">
                <div id="ms-control" onclick="toggleMsDropdown(event)" style="min-height:38px;border:1px solid #ddd;border-radius:7px;padding:5px 30px 5px 8px;background:#fff;cursor:text;display:flex;flex-wrap:wrap;gap:4px;align-items:center">
                  <div id="ms-pills" style="display:flex;flex-wrap:wrap;gap:4px">
                    ${stackList.length === 0 ? '<span id="ms-placeholder" style="color:#aaa;font-size:13px;padding:4px 2px">Select lists…</span>' : ''}
                    ${allLists.filter(l => stackList.includes(String(l.id))).map(l => `
                      <span class="ms-pill" data-id="${l.id}" style="display:inline-flex;align-items:center;gap:5px;background:#e8f0ff;color:#1a4a9a;padding:3px 8px;border-radius:5px;font-size:12px;font-weight:500">
                        ${escHTML(l.list_name)}
                        <button type="button" onclick="removeMsPill(event, ${l.id})" style="background:none;border:none;color:#1a4a9a;cursor:pointer;padding:0;font-size:14px;line-height:1;font-family:inherit">×</button>
                      </span>
                    `).join('')}
                  </div>
                  <span style="position:absolute;right:10px;top:50%;transform:translateY(-50%);color:#888;font-size:11px;pointer-events:none">▾</span>
                </div>
                <div id="ms-dropdown" style="display:none;position:absolute;top:calc(100% + 4px);left:0;right:0;background:#fff;border:1px solid #ddd;border-radius:7px;box-shadow:0 4px 16px rgba(0,0,0,.08);max-height:240px;overflow:hidden;z-index:100;flex-direction:column">
                  <input type="text" id="ms-search" placeholder="Search lists…" oninput="filterMsOptions()" onclick="event.stopPropagation()" onkeydown="msSearchKeydown(event)" style="width:100%;padding:8px 10px;border:none;border-bottom:1px solid #eee;font-size:13px;font-family:inherit;outline:none;box-sizing:border-box">
                  <div id="ms-options" style="overflow-y:auto;flex:1">
                    ${allLists.length === 0
                      ? '<div style="color:#aaa;font-size:13px;padding:10px">No lists available yet</div>'
                      : allLists.map(l => {
                          const isSel = stackList.includes(String(l.id));
                          // Escape list_name for HTML context AND for JS string
                          // context inside the onclick handler.
                          const nameHtml = escHTML(l.list_name || '');
                          const nameJs   = String(l.list_name || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/</g, '\\x3C');
                          return `<div class="ms-option" data-id="${l.id}" data-name="${nameHtml.toLowerCase()}" onclick="toggleMsOption(event, ${l.id}, '${nameJs}')" style="padding:8px 12px;font-size:13px;cursor:pointer;display:flex;align-items:center;gap:8px;${isSel ? 'background:#f0f7ff;color:#1a4a9a;font-weight:500' : ''}" onmouseover="if(!this.classList.contains('ms-selected'))this.style.background='#fafaf8'" onmouseout="if(!this.classList.contains('ms-selected'))this.style.background=''">
                            <span style="width:14px;display:inline-block">${isSel ? '✓' : ''}</span>
                            <span>${nameHtml}</span>
                          </div>`;
                        }).join('')}
                  </div>
                </div>
              </div>

              <!-- Hidden inputs that actually submit with the form -->
              <div id="ms-hidden-inputs">
                ${stackList.map(id => `<input type="hidden" name="stack_list" value="${id}">`).join('')}
              </div>

              <p style="font-size:11px;color:#aaa;margin-top:5px">Select 2+ lists to find properties on every one (AND logic). Select 1 for "on this list."</p>
            </div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">Min list stack count</label>
              <input type="number" name="min_stack" value="${min_stack}" placeholder="e.g. 2" min="1" style="width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit">
            </div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">Min Distress Score</label>
              <input type="number" name="min_distress" value="${min_distress}" placeholder="e.g. 55" min="0" max="100" style="width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit">
              <p style="font-size:10px;color:#aaa;margin-top:3px">30+ Warm · 55+ Hot · 75+ Burning</p>
            </div>

          </div>

          <div style="margin-top:14px;display:flex;gap:8px">
            <button type="submit" class="btn btn-primary">Apply Filters</button>
            <a href="/records${list_id?'?list_id='+list_id:''}" class="btn btn-ghost">Reset</a>
          </div>
        </div>

`;
}

module.exports = { renderFilterPanel };
