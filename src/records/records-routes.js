const express = require('express');
const router = express.Router();
const { query } = require('../db');
const distress = require('../scoring/distress');

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.redirect('/login');
}

const { shell } = require('../shared-shell');

function fmt(val, fallback) { return val || fallback || '—'; }
function fmtDate(val) { if (!val) return '—'; return new Date(val).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }); }
function fmtMoney(val) { if (!val) return '—'; return '$' + Number(val).toLocaleString(); }

// ═══════════════════════════════════════════════════════════════════════════════
// RECORDS LIST — GET /records
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/', requireAuth, async (req, res) => {
  try {
    // Ensure distress columns exist before querying them
    await distress.ensureDistressSchema();
    const {
      q = '', city = '', zip = '', county = '',
      type = '', list_id = '', min_stack = '',
      pipeline = '', mkt_result = '', prop_status = '',
      min_assessed = '', max_assessed = '',
      min_equity = '', max_equity = '',
      min_year = '', max_year = '',
      upload_from = '', upload_to = '',
      min_distress = '',
      page = 1
    } = req.query;

    // stack_list can arrive as a single string, an array (multi-checkbox), or absent.
    // Normalize to an array of non-empty strings.
    let stackList = req.query.stack_list;
    if (!stackList) stackList = [];
    else if (!Array.isArray(stackList)) stackList = [stackList];
    stackList = stackList.filter(v => v !== null && v !== undefined && String(v).trim() !== '');

    // state can arrive as a single string OR an array. Normalize to array of upper-case codes.
    let stateList = req.query.state;
    if (!stateList) stateList = [];
    else if (!Array.isArray(stateList)) stateList = [stateList];
    stateList = stateList.filter(v => v !== null && v !== undefined && String(v).trim() !== '').map(s => String(s).toUpperCase());

    // Helper: parse comma- or whitespace-separated values into an array of trimmed strings.
    // "46218, 46219 46220" => ['46218','46219','46220']
    function splitCsv(raw) {
      if (!raw) return [];
      return String(raw).split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
    }
    const cityList   = splitCsv(city);
    const zipList    = splitCsv(zip);
    const countyList = splitCsv(county);

    const limit = 25;
    const offset = (parseInt(page) - 1) * limit;

    let conditions = [];
    let params = [];
    let idx = 1;

    if (q) {
      conditions.push(`(p.street ILIKE $${idx} OR p.city ILIKE $${idx} OR p.zip_code ILIKE $${idx} OR c.first_name ILIKE $${idx} OR c.last_name ILIKE $${idx} OR ph.phone_number ILIKE $${idx})`);
      params.push(`%${q}%`); idx++;
    }
    if (stateList.length > 0) {
      conditions.push(`p.state_code = ANY($${idx}::text[])`);
      params.push(stateList);
      idx++;
    }
    if (cityList.length > 0) {
      // ILIKE doesn't work reliably with ANY(array) — build explicit OR chain
      const orClauses = cityList.map(() => `p.city ILIKE $${idx++}`);
      conditions.push(`(${orClauses.join(' OR ')})`);
      cityList.forEach(c => params.push(`%${c}%`));
    }
    if (zipList.length > 0) {
      // Same fix: explicit OR chain for ZIP prefix matches
      const orClauses = zipList.map(() => `p.zip_code ILIKE $${idx++}`);
      conditions.push(`(${orClauses.join(' OR ')})`);
      zipList.forEach(z => params.push(`${z}%`));
    }
    if (countyList.length > 0) {
      const orClauses = countyList.map(() => `p.county ILIKE $${idx++}`);
      conditions.push(`(${orClauses.join(' OR ')})`);
      countyList.forEach(c => params.push(`%${c}%`));
    }
    if (type)         { conditions.push(`p.property_type = $${idx}`);     params.push(type); idx++; }
    if (pipeline)     { conditions.push(`p.pipeline_stage = $${idx}`);    params.push(pipeline); idx++; }
    if (prop_status)  { conditions.push(`p.property_status = $${idx}`);   params.push(prop_status); idx++; }
    if (mkt_result)   { conditions.push(`p.marketing_result = $${idx}`);  params.push(mkt_result); idx++; }
    if (min_assessed) { conditions.push(`p.assessed_value >= $${idx}`);   params.push(min_assessed); idx++; }
    if (max_assessed) { conditions.push(`p.assessed_value <= $${idx}`);   params.push(max_assessed); idx++; }
    if (min_equity)   { conditions.push(`p.equity_percent >= $${idx}`);   params.push(min_equity); idx++; }
    if (max_equity)   { conditions.push(`p.equity_percent <= $${idx}`);   params.push(max_equity); idx++; }
    if (min_year)     { conditions.push(`p.year_built >= $${idx}`);       params.push(min_year); idx++; }
    if (max_year)     { conditions.push(`p.year_built <= $${idx}`);       params.push(max_year); idx++; }
    if (upload_from)  { conditions.push(`p.created_at >= $${idx}`);       params.push(upload_from); idx++; }
    if (upload_to)    { conditions.push(`p.created_at <= $${idx}`);       params.push(upload_to + ' 23:59:59'); idx++; }
    if (list_id)      { conditions.push(`EXISTS (SELECT 1 FROM property_lists pl2 WHERE pl2.property_id = p.id AND pl2.list_id = $${idx})`); params.push(list_id); idx++; }

    // ── AND-stacking: property must appear on EVERY selected list ────────────
    // For N selected lists, require N matching rows in property_lists. If only
    // 1 list is selected, this behaves identically to the old single-list filter.
    if (stackList.length > 0) {
      const listIdInts = stackList.map(v => parseInt(v)).filter(n => !isNaN(n));
      if (listIdInts.length > 0) {
        conditions.push(
          `(SELECT COUNT(DISTINCT pl_stack.list_id)
              FROM property_lists pl_stack
             WHERE pl_stack.property_id = p.id
               AND pl_stack.list_id = ANY($${idx}::int[])) = $${idx+1}`
        );
        params.push(listIdInts);
        params.push(listIdInts.length);
        idx += 2;
      }
    }

    if (min_stack)    { conditions.push(`(SELECT COUNT(*) FROM property_lists plc WHERE plc.property_id = p.id) >= $${idx}`); params.push(parseInt(min_stack)); idx++; }
    if (min_distress) { conditions.push(`p.distress_score >= $${idx}`); params.push(parseInt(min_distress)); idx++; }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const countRes = await query(`
      SELECT COUNT(DISTINCT p.id) FROM properties p
      LEFT JOIN property_contacts pc ON pc.property_id = p.id AND pc.primary_contact = true
      LEFT JOIN contacts c ON c.id = pc.contact_id
      LEFT JOIN phones ph ON ph.contact_id = c.id
      ${where}
    `, params);
    const total = parseInt(countRes.rows[0].count);

    // Fetch all lists for stack filter dropdown
    const allListsRes = await query(`SELECT id, list_name FROM lists ORDER BY list_name ASC`);
    const allLists = allListsRes.rows;

    // Fetch all distinct states present in the DB for multi-select state filter
    const allStatesRes = await query(`SELECT DISTINCT state_code FROM properties WHERE state_code IS NOT NULL AND state_code <> '' ORDER BY state_code ASC`);
    const STATE_NAMES = { AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',CT:'Connecticut',DE:'Delaware',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming',DC:'District of Columbia' };
    const allStates = allStatesRes.rows.map(r => ({ code: r.state_code, name: STATE_NAMES[r.state_code] || r.state_code }));

    const rows = await query(`
      SELECT DISTINCT ON (p.id)
        p.id, p.street, p.city, p.state_code, p.zip_code,
        p.property_type, p.vacant, p.pipeline_stage, p.source,
        p.estimated_value, p.condition, p.created_at,
        p.distress_score, p.distress_band,
        c.first_name, c.last_name,
        (SELECT COUNT(*) FROM property_lists pl WHERE pl.property_id = p.id) AS list_count,
        (SELECT COUNT(*) FROM phones ph2
          JOIN property_contacts pc2 ON pc2.contact_id = ph2.contact_id
          WHERE pc2.property_id = p.id) AS phone_count
      FROM properties p
      LEFT JOIN property_contacts pc ON pc.property_id = p.id AND pc.primary_contact = true
      LEFT JOIN contacts c ON c.id = pc.contact_id
      LEFT JOIN phones ph ON ph.contact_id = c.id
      ${where}
      ORDER BY p.id DESC, p.created_at DESC
      LIMIT $${idx} OFFSET $${idx+1}
    `, [...params, limit, offset]);

    const totalPages = Math.ceil(total / limit);

    const tableRows = rows.rows.map(r => {
      const owner = [r.first_name, r.last_name].filter(Boolean).join(' ') || '—';
      const stage = r.pipeline_stage || 'prospect';
      const stageColor = {prospect:'#f5f4f0',lead:'#e8f5ee',contract:'#fff8e1',closed:'#e8f0ff'}[stage]||'#f5f4f0';
      const stageText = {prospect:'#555',lead:'#1a7a4a',contract:'#9a6800',closed:'#2c5cc5'}[stage]||'#555';
      // Distress badge
      const dScore = r.distress_score;
      const dBand = r.distress_band;
      const dColor = (dBand && distress.BAND_COLORS[dBand]) ? distress.BAND_COLORS[dBand] : null;
      const distressCell = (dScore == null || dScore === undefined)
        ? '<span style="color:#ccc;font-size:12px">—</span>'
        : `<span style="background:${dColor.bg};color:${dColor.text};padding:3px 9px;border-radius:5px;font-size:11px;font-weight:600;display:inline-block;min-width:38px">${dScore}</span>`;
      return `<tr data-id="${r.id}" style="cursor:pointer;border-bottom:1px solid #f0efe9" onclick="window.location='/records/${r.id}'" onmouseover="if(!this.classList.contains('row-selected'))this.style.background='#fafaf8'" onmouseout="if(!this.classList.contains('row-selected'))this.style.background=''">
        <td style="width:40px;padding:12px 0 12px 16px" onclick="event.stopPropagation()"><input type="checkbox" class="row-check" data-id="${r.id}" onchange="selectRow(this, this.checked)" style="cursor:pointer;width:15px;height:15px"></td>
        <td style="padding:12px"><div style="font-weight:500;font-size:13px">${r.street}</div><div style="font-size:12px;color:#888;margin-top:2px">${r.city}, ${r.state_code} ${r.zip_code}</div></td>
        <td style="padding:12px;font-size:13px;color:#555;text-align:left">${owner}</td>
        <td style="padding:12px;font-size:13px;color:#555;text-align:left">${fmt(r.property_type)}</td>
        <td style="padding:12px;font-size:13px;text-align:center">${r.phone_count || 0}</td>
        <td style="padding:12px;font-size:13px;text-align:center">${r.list_count || 0}</td>
        <td style="padding:12px;text-align:center">${distressCell}</td>
        <td style="padding:12px;text-align:left"><span style="background:${stageColor};color:${stageText};padding:3px 10px;border-radius:5px;font-size:11px;font-weight:600;text-transform:capitalize">${stage}</span></td>
        <td style="padding:12px;font-size:12px;color:#888;white-space:nowrap;text-align:right">${fmtDate(r.created_at)}</td>
      </tr>`;
    }).join('');

    // Build a pagination URL that preserves ALL current filters including multi-select stack_list
    const preserveQS = (newPage) => {
      const parts = [];
      const add = (k, v) => { if (v !== undefined && v !== null && v !== '') parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`); };
      add('q', q); add('city', city); add('zip', zip); add('county', county);
      add('type', type); add('list_id', list_id); add('min_stack', min_stack);
      add('pipeline', pipeline); add('mkt_result', mkt_result); add('prop_status', prop_status);
      add('min_assessed', min_assessed); add('max_assessed', max_assessed);
      add('min_equity', min_equity); add('max_equity', max_equity);
      add('min_year', min_year); add('max_year', max_year);
      add('upload_from', upload_from); add('upload_to', upload_to);
      add('min_distress', min_distress);
      stackList.forEach(sl => parts.push(`stack_list=${encodeURIComponent(sl)}`));
      stateList.forEach(s => parts.push(`state=${encodeURIComponent(s)}`));
      parts.push(`page=${newPage}`);
      return '/records?' + parts.join('&');
    };

    const pagination = totalPages > 1 ? `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:1rem;font-size:13px;color:#555;padding:4px 0">
        <span>Showing ${offset+1}–${Math.min(offset+limit,total)} of ${total.toLocaleString()} records</span>
        <div style="display:flex;gap:6px">
          ${parseInt(page) > 1 ? `<a href="${preserveQS(parseInt(page)-1)}" class="btn btn-ghost" style="padding:6px 12px">← Prev</a>` : ''}
          ${parseInt(page) < totalPages ? `<a href="${preserveQS(parseInt(page)+1)}" class="btn btn-ghost" style="padding:6px 12px">Next →</a>` : ''}
        </div>
      </div>` : '';

    // Filter count — multi-select filters count as 1 each regardless of how many values
    const activeFilterCount = [city,zip,county,type,pipeline,prop_status,mkt_result,min_assessed,max_assessed,min_equity,max_equity,min_year,max_year,upload_from,upload_to,min_stack,min_distress].filter(Boolean).length + (stackList.length > 0 ? 1 : 0) + (stateList.length > 0 ? 1 : 0);

    res.send(shell('Records', `
      <div class="page-header">
        <div>
          <div class="page-title">Records <span class="count-pill">${total.toLocaleString()}</span></div>
          <div class="page-sub">${list_id ? '<a href="/lists" style="color:#888;font-size:13px;text-decoration:none">← Back to Lists</a> &nbsp;·&nbsp; Filtered by list' : 'All properties across Indiana &amp; Georgia'}</div>
        </div>
      </div>

      <form method="GET" action="/records" id="filter-form">
        ${list_id ? '<input type="hidden" name="list_id" value="' + list_id + '">' : ''}

        <!-- Search bar + filter toggle -->
        <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
          <input type="text" name="q" value="${q}" placeholder="Search address, owner name, phone…" autocomplete="off"
            style="flex:1;min-width:200px;padding:9px 14px;border:1px solid #ddd;border-radius:8px;font-size:14px;font-family:inherit;background:#fff">
          <button type="submit" class="btn btn-primary">Search</button>
          <button type="button" class="btn btn-ghost" onclick="toggleFilters()" id="filter-toggle">
            ⚙ Filters${activeFilterCount > 0 ? ' <span style="background:#1a1a1a;color:#fff;border-radius:10px;padding:1px 7px;font-size:11px;margin-left:4px">'+activeFilterCount+'</span>' : ''}
          </button>
          ${q || activeFilterCount > 0
            ? '<a href="/records' + (list_id?'?list_id='+list_id:'') + '" class="btn btn-ghost" style="color:#c0392b;border-color:#f5c5c5">✕ Clear</a>' : ''}
        </div>

        <!-- Expandable filter panel -->
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
                  <input type="text" id="state-ms-search" placeholder="Search state…" oninput="filterStateMsOptions()" onclick="event.stopPropagation()" style="width:100%;padding:7px 9px;border:none;border-bottom:1px solid #eee;font-size:13px;font-family:inherit;outline:none;box-sizing:border-box">
                  <div id="state-ms-options" style="overflow-y:auto;flex:1">
                    ${allStates.length === 0
                      ? '<div style="color:#aaa;font-size:13px;padding:10px">No states found</div>'
                      : allStates.map(s => {
                          const isSel = stateList.includes(s.code);
                          const safeName = (s.name || '').replace(/'/g, "\\'");
                          return `<div class="state-ms-option" data-id="${s.code}" data-search="${(s.code+' '+s.name).toLowerCase()}" onclick="toggleStateMsOption(event,'${s.code}','${safeName}')" style="padding:6px 10px;font-size:13px;cursor:pointer;display:flex;align-items:center;gap:8px;${isSel ? 'background:#f0f7ff;color:#1a4a9a;font-weight:500' : ''}" onmouseover="if(!this.classList.contains('state-ms-selected'))this.style.background='#fafaf8'" onmouseout="if(!this.classList.contains('state-ms-selected'))this.style.background=''">
                            <span style="width:14px;display:inline-block">${isSel ? '✓' : ''}</span>
                            <span style="font-weight:500;font-family:monospace;width:28px">${s.code}</span>
                            <span style="color:#888">${s.name}</span>
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

            <!-- Marketing -->
            <div style="grid-column:1/-1;font-size:10px;font-weight:700;color:#aaa;text-transform:uppercase;letter-spacing:.1em;margin:6px 0 2px">Marketing</div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">Marketing Result</label>
              <select name="mkt_result" style="width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit;background:#fff">
                <option value="">Any</option>
                ${['Lead','Not Interested','Do Not Call','Wrong Number','Spanish Speaker','Callback','Voicemail'].map(s=>`<option value="${s}" ${mkt_result===s?'selected':''}>${s}</option>`).join('')}
              </select>
            </div>
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
                        ${l.list_name}
                        <button type="button" onclick="removeMsPill(event, ${l.id})" style="background:none;border:none;color:#1a4a9a;cursor:pointer;padding:0;font-size:14px;line-height:1;font-family:inherit">×</button>
                      </span>
                    `).join('')}
                  </div>
                  <span style="position:absolute;right:10px;top:50%;transform:translateY(-50%);color:#888;font-size:11px;pointer-events:none">▾</span>
                </div>
                <div id="ms-dropdown" style="display:none;position:absolute;top:calc(100% + 4px);left:0;right:0;background:#fff;border:1px solid #ddd;border-radius:7px;box-shadow:0 4px 16px rgba(0,0,0,.08);max-height:240px;overflow:hidden;z-index:100;flex-direction:column">
                  <input type="text" id="ms-search" placeholder="Search lists…" oninput="filterMsOptions()" onclick="event.stopPropagation()" style="width:100%;padding:8px 10px;border:none;border-bottom:1px solid #eee;font-size:13px;font-family:inherit;outline:none;box-sizing:border-box">
                  <div id="ms-options" style="overflow-y:auto;flex:1">
                    ${allLists.length === 0
                      ? '<div style="color:#aaa;font-size:13px;padding:10px">No lists available yet</div>'
                      : allLists.map(l => {
                          const isSel = stackList.includes(String(l.id));
                          return `<div class="ms-option" data-id="${l.id}" data-name="${l.list_name.toLowerCase()}" onclick="toggleMsOption(event, ${l.id}, '${l.list_name.replace(/'/g, "\\'")}')" style="padding:8px 12px;font-size:13px;cursor:pointer;display:flex;align-items:center;gap:8px;${isSel ? 'background:#f0f7ff;color:#1a4a9a;font-weight:500' : ''}" onmouseover="if(!this.classList.contains('ms-selected'))this.style.background='#fafaf8'" onmouseout="if(!this.classList.contains('ms-selected'))this.style.background=''">
                            <span style="width:14px;display:inline-block">${isSel ? '✓' : ''}</span>
                            <span>${l.list_name}</span>
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
      </form>

      <style>
      tr.row-selected td { background: #f0f7ff !important; }
      tr.row-selected:hover td { background: #e8f0ff !important; }
      </style>
      <script>
      function toggleFilters() {
        const p = document.getElementById('filter-panel');
        p.style.display = p.style.display === 'none' ? 'block' : 'none';
      }

      // ── Multi-select dropdown for List Stacking ────────────────────────────
      function toggleMsDropdown(ev) {
        ev.stopPropagation();
        const dd = document.getElementById('ms-dropdown');
        const isOpen = dd.style.display === 'flex';
        dd.style.display = isOpen ? 'none' : 'flex';
        if (!isOpen) {
          const search = document.getElementById('ms-search');
          if (search) { search.value = ''; filterMsOptions(); setTimeout(() => search.focus(), 10); }
        }
      }

      document.addEventListener('click', function(e) {
        const wrapper = document.getElementById('ms-wrapper');
        if (wrapper && !wrapper.contains(e.target)) {
          const dd = document.getElementById('ms-dropdown');
          if (dd) dd.style.display = 'none';
        }
      });

      function filterMsOptions() {
        const q = document.getElementById('ms-search').value.toLowerCase();
        const opts = document.querySelectorAll('#ms-options .ms-option');
        opts.forEach(o => {
          const name = o.getAttribute('data-name') || '';
          o.style.display = name.includes(q) ? 'flex' : 'none';
        });
      }

      function getSelectedStackIds() {
        const inputs = document.querySelectorAll('#ms-hidden-inputs input[name="stack_list"]');
        return Array.from(inputs).map(i => String(i.value));
      }

      function renderMsPills() {
        const ids = getSelectedStackIds();
        const pillsEl = document.getElementById('ms-pills');
        const countEl = document.getElementById('stack-count-label');
        if (countEl) countEl.textContent = '(' + ids.length + ' selected)';

        pillsEl.innerHTML = '';
        if (ids.length === 0) {
          const ph = document.createElement('span');
          ph.id = 'ms-placeholder';
          ph.style.cssText = 'color:#aaa;font-size:13px;padding:4px 2px';
          ph.textContent = 'Select lists…';
          pillsEl.appendChild(ph);
          return;
        }
        ids.forEach(id => {
          const opt = document.querySelector('#ms-options .ms-option[data-id="' + id + '"]');
          const name = opt ? opt.querySelector('span:last-child').textContent : ('List ' + id);
          const pill = document.createElement('span');
          pill.className = 'ms-pill';
          pill.setAttribute('data-id', id);
          pill.style.cssText = 'display:inline-flex;align-items:center;gap:5px;background:#e8f0ff;color:#1a4a9a;padding:3px 8px;border-radius:5px;font-size:12px;font-weight:500';
          pill.appendChild(document.createTextNode(name));
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.style.cssText = 'background:none;border:none;color:#1a4a9a;cursor:pointer;padding:0;font-size:14px;line-height:1;font-family:inherit';
          btn.textContent = '×';
          btn.addEventListener('click', function(ev) { removeMsPill(ev, id); });
          pill.appendChild(btn);
          pillsEl.appendChild(pill);
        });
      }

      function toggleMsOption(ev, id, name) {
        ev.stopPropagation();
        const sid = String(id);
        const container = document.getElementById('ms-hidden-inputs');
        const existing = container.querySelector('input[value="' + sid + '"]');
        const opt = document.querySelector('#ms-options .ms-option[data-id="' + sid + '"]');

        if (existing) {
          existing.remove();
          if (opt) {
            opt.classList.remove('ms-selected');
            opt.style.background = '';
            opt.style.color = '';
            opt.style.fontWeight = '';
            opt.querySelector('span').textContent = '';
          }
        } else {
          const input = document.createElement('input');
          input.type = 'hidden';
          input.name = 'stack_list';
          input.value = sid;
          container.appendChild(input);
          if (opt) {
            opt.classList.add('ms-selected');
            opt.style.background = '#f0f7ff';
            opt.style.color = '#1a4a9a';
            opt.style.fontWeight = '500';
            opt.querySelector('span').textContent = '✓';
          }
        }
        renderMsPills();
      }

      function removeMsPill(ev, id) {
        ev.stopPropagation();
        const sid = String(id);
        const container = document.getElementById('ms-hidden-inputs');
        const existing = container.querySelector('input[value="' + sid + '"]');
        if (existing) existing.remove();
        const opt = document.querySelector('#ms-options .ms-option[data-id="' + sid + '"]');
        if (opt) {
          opt.classList.remove('ms-selected');
          opt.style.background = '';
          opt.style.color = '';
          opt.style.fontWeight = '';
          opt.querySelector('span').textContent = '';
        }
        renderMsPills();
      }

      // ── Multi-select dropdown for STATE ──────────────────────────────────
      function toggleStateMsDropdown(ev) {
        ev.stopPropagation();
        const dd = document.getElementById('state-ms-dropdown');
        const isOpen = dd.style.display === 'flex';
        dd.style.display = isOpen ? 'none' : 'flex';
        if (!isOpen) {
          const search = document.getElementById('state-ms-search');
          if (search) { search.value = ''; filterStateMsOptions(); setTimeout(() => search.focus(), 10); }
        }
      }

      document.addEventListener('click', function(e) {
        const wrapper = document.getElementById('state-ms-wrapper');
        if (wrapper && !wrapper.contains(e.target)) {
          const dd = document.getElementById('state-ms-dropdown');
          if (dd) dd.style.display = 'none';
        }
      });

      function filterStateMsOptions() {
        const q = document.getElementById('state-ms-search').value.toLowerCase();
        const opts = document.querySelectorAll('#state-ms-options .state-ms-option');
        opts.forEach(o => {
          const term = o.getAttribute('data-search') || '';
          o.style.display = term.includes(q) ? 'flex' : 'none';
        });
      }

      function getSelectedStateCodes() {
        const inputs = document.querySelectorAll('#state-ms-hidden-inputs input[name="state"]');
        return Array.from(inputs).map(i => String(i.value));
      }

      function renderStateMsPills() {
        const codes = getSelectedStateCodes();
        const pillsEl = document.getElementById('state-ms-pills');
        const countEl = document.getElementById('state-count-label');
        if (countEl) countEl.textContent = codes.length > 0 ? '(' + codes.length + ' selected)' : '';

        // Clear and rebuild via DOM (avoids quote-escaping nightmares)
        pillsEl.innerHTML = '';
        if (codes.length === 0) {
          const ph = document.createElement('span');
          ph.id = 'state-ms-placeholder';
          ph.style.cssText = 'color:#aaa;font-size:13px;padding:2px';
          ph.textContent = 'All States';
          pillsEl.appendChild(ph);
          return;
        }
        codes.forEach(code => {
          const pill = document.createElement('span');
          pill.className = 'state-ms-pill';
          pill.setAttribute('data-id', code);
          pill.style.cssText = 'display:inline-flex;align-items:center;gap:4px;background:#e8f0ff;color:#1a4a9a;padding:2px 6px;border-radius:4px;font-size:12px;font-weight:500';
          pill.appendChild(document.createTextNode(code));
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.style.cssText = 'background:none;border:none;color:#1a4a9a;cursor:pointer;padding:0;font-size:13px;line-height:1;font-family:inherit';
          btn.textContent = '×';
          btn.addEventListener('click', function(ev) { removeStateMsPill(ev, code); });
          pill.appendChild(btn);
          pillsEl.appendChild(pill);
        });
      }

      function toggleStateMsOption(ev, code, name) {
        ev.stopPropagation();
        const sid = String(code);
        const container = document.getElementById('state-ms-hidden-inputs');
        const existing = container.querySelector('input[value="' + sid + '"]');
        const opt = document.querySelector('#state-ms-options .state-ms-option[data-id="' + sid + '"]');

        if (existing) {
          existing.remove();
          if (opt) {
            opt.classList.remove('state-ms-selected');
            opt.style.background = '';
            opt.style.color = '';
            opt.style.fontWeight = '';
            opt.querySelector('span').textContent = '';
          }
        } else {
          const input = document.createElement('input');
          input.type = 'hidden';
          input.name = 'state';
          input.value = sid;
          container.appendChild(input);
          if (opt) {
            opt.classList.add('state-ms-selected');
            opt.style.background = '#f0f7ff';
            opt.style.color = '#1a4a9a';
            opt.style.fontWeight = '500';
            opt.querySelector('span').textContent = '✓';
          }
        }
        renderStateMsPills();
      }

      function removeStateMsPill(ev, code) {
        ev.stopPropagation();
        const sid = String(code);
        const container = document.getElementById('state-ms-hidden-inputs');
        const existing = container.querySelector('input[value="' + sid + '"]');
        if (existing) existing.remove();
        const opt = document.querySelector('#state-ms-options .state-ms-option[data-id="' + sid + '"]');
        if (opt) {
          opt.classList.remove('state-ms-selected');
          opt.style.background = '';
          opt.style.color = '';
          opt.style.fontWeight = '';
          opt.querySelector('span').textContent = '';
        }
        renderStateMsPills();
      }
      </script>

      <!-- Export Modal -->
      <div class="modal-overlay" id="export-modal">
        <div class="modal" style="max-width:520px">
          <div class="modal-header">
            <div class="modal-title">Choose Export Columns</div>
            <button class="modal-close" onclick="document.getElementById('export-modal').classList.remove('open')">×</button>
          </div>
          <div style="margin-bottom:12px;display:flex;gap:8px">
            <button onclick="checkAll(true)" style="padding:5px 12px;font-size:12px;background:#f5f4f0;border:1px solid #ddd;border-radius:6px;cursor:pointer;font-family:inherit">Select All</button>
            <button onclick="checkAll(false)" style="padding:5px 12px;font-size:12px;background:#f5f4f0;border:1px solid #ddd;border-radius:6px;cursor:pointer;font-family:inherit">Clear All</button>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:1.25rem" id="col-checks">
            ${[
              ['street','Street Address'],['city','City'],['state_code','State'],['zip_code','ZIP'],['county','County'],
              ['first_name','Owner First Name'],['last_name','Owner Last Name'],
              ['mailing_address','Mailing Address'],['mailing_city','Mailing City'],['mailing_state','Mailing State'],['mailing_zip','Mailing ZIP'],['email_1','Email 1'],['email_2','Email 2'],
              ['phones','Phones (1–15 separate columns)'],
              ['property_type','Property Type'],['year_built','Year Built'],['sqft','Sq Ft'],['bedrooms','Bedrooms'],['bathrooms','Bathrooms'],
              ['assessed_value','Assessed Value'],['estimated_value','Est. Value'],['equity_percent','Equity %'],
              ['property_status','Property Status'],['pipeline_stage','Pipeline Stage'],['condition','Condition'],
              ['last_sale_date','Last Sale Date'],['last_sale_price','Last Sale Price'],
              ['marketing_result','Marketing Result'],['source','Source'],
              ['list_count','Lists Count'],['created_at','Date Added'],
              ['distress_score','Distress Score'],['distress_band','Distress Band'],
            ].map(([k,l]) => `<label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;padding:4px 0">
              <input type="checkbox" value="${k}" class="col-check" checked style="width:14px;height:14px"> ${l}
            </label>`).join('')}
          </div>
          <button onclick="doExport()" style="width:100%;padding:10px;background:#1a1a1a;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer;font-family:inherit">Download CSV</button>
        </div>
      </div>

      <!-- Export toolbar -->
      <div id="export-toolbar" style="display:none;background:#1a1a1a;color:#fff;border-radius:10px;padding:10px 16px;margin-bottom:8px;align-items:center;justify-content:space-between;gap:12px">
        <div style="font-size:13px"><span id="selected-count">0</span> records selected</div>
        <div style="display:flex;gap:8px">
          <button onclick="clearSelection()" style="padding:6px 12px;background:transparent;color:#aaa;border:1px solid #444;border-radius:7px;font-size:12px;cursor:pointer;font-family:inherit">Clear</button>
          <button onclick="openExportModal()" style="padding:6px 14px;background:#fff;color:#1a1a1a;border:none;border-radius:7px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">⬇ Export CSV</button>
        </div>
      </div>

      <div id="select-all-banner" data-total="${total}" style="display:none;background:#e8f0ff;border:1px solid #c5d5f5;border-radius:8px;padding:10px 16px;margin-bottom:8px;font-size:13px;color:#1a4a9a;align-items:center;justify-content:space-between;gap:12px">
        <span>All <strong>${total.toLocaleString()}</strong> records on this page selected. Select all records?</span>
        <button onclick="selectAllRecords()" style="padding:5px 14px;background:#1a4a9a;color:#fff;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">Select all ${total.toLocaleString()} records</button>
      </div>

      <div style="background:#fff;border-radius:10px;border:1px solid #e0dfd8;overflow:hidden">
        <table style="width:100%;font-size:13px;border-collapse:collapse">
          <thead><tr style="border-bottom:1px solid #e0dfd8">
            <th style="width:40px;padding:10px 0 10px 16px;text-align:left"><input type="checkbox" id="select-all" onchange="selectAllOnPage(this.checked)" style="cursor:pointer;width:15px;height:15px" title="Select all on this page"></th>
            <th style="padding:10px 12px;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.05em;text-align:left">Address</th>
            <th style="padding:10px 12px;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.05em;text-align:left">Owner</th>
            <th style="padding:10px 12px;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.05em;text-align:left">Type</th>
            <th style="padding:10px 12px;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.05em;text-align:center">Phones</th>
            <th style="padding:10px 12px;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.05em;text-align:center">Lists</th>
            <th style="padding:10px 12px;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.05em;text-align:center">Distress</th>
            <th style="padding:10px 12px;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.05em;text-align:left">Stage</th>
            <th style="padding:10px 12px;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.05em;text-align:right">Added</th>
          </tr></thead>
          <tbody>
            ${tableRows || '<tr><td colspan="9" style="text-align:center;padding:40px;color:#aaa;font-size:13px">No records found</td></tr>'}
          </tbody>
        </table>
      </div>
      ${pagination}

      <script>
      var selectedIds = {};
      var _allSelected = false;
      var _pageTotal = parseInt(document.getElementById('select-all-banner')?.getAttribute('data-total') || '0', 10);

      function updateToolbar() {
        var count = _allSelected ? _pageTotal : Object.keys(selectedIds).length;
        var toolbar = document.getElementById('export-toolbar');
        var counter = document.getElementById('selected-count');
        if (toolbar) toolbar.style.display = count > 0 ? 'flex' : 'none';
        if (counter) counter.textContent = count.toLocaleString();
      }

      function selectRow(cb, checked) {
        _allSelected = false; // manual selection cancels "select all across pages"
        var banner = document.getElementById('select-all-banner');
        if (banner) banner.style.display = 'none';

        var id = cb.getAttribute('data-id');
        if (!id) return;
        cb.checked = checked;
        var tr = cb.parentNode.parentNode;
        if (tr) {
          if (checked) tr.classList.add('row-selected');
          else tr.classList.remove('row-selected');
        }
        if (checked) selectedIds[id] = true;
        else delete selectedIds[id];
        updateToolbar();
      }

      // Header checkbox: toggle every row on this page, then show cross-page banner
      function selectAllOnPage(checked) {
        var boxes = document.querySelectorAll('.row-check');
        for (var i = 0; i < boxes.length; i++) {
          selectRow(boxes[i], checked);
        }
        var banner = document.getElementById('select-all-banner');
        if (banner) {
          // Show banner only if the total exceeds the current page AND user just checked all
          var onPage = boxes.length;
          if (checked && _pageTotal > onPage) {
            banner.style.display = 'flex';
          } else {
            banner.style.display = 'none';
          }
        }
      }

      // "Select all N records" banner button — flags every filtered record on the server
      function selectAllRecords() {
        _allSelected = true;
        var banner = document.getElementById('select-all-banner');
        if (banner) banner.style.display = 'none';
        updateToolbar();
      }

      function clearSelection() {
        selectedIds = {};
        _allSelected = false;
        var boxes = document.querySelectorAll('.row-check');
        for (var i = 0; i < boxes.length; i++) {
          boxes[i].checked = false;
          boxes[i].parentNode.parentNode.classList.remove('row-selected');
        }
        var sa = document.getElementById('select-all');
        if (sa) sa.checked = false;
        var banner = document.getElementById('select-all-banner');
        if (banner) banner.style.display = 'none';
        updateToolbar();
      }

      function openExportModal() {
        document.getElementById('export-modal').classList.add('open');
      }

      function checkAll(val) {
        var cols = document.querySelectorAll('.col-check');
        for (var i = 0; i < cols.length; i++) cols[i].checked = val;
      }

      async function doExport() {
        var colEls = document.querySelectorAll('.col-check:checked');
        var cols = [];
        for (var i = 0; i < colEls.length; i++) cols.push(colEls[i].value);
        if (!cols.length) { alert('Select at least one column.'); return; }
        var ids = Object.keys(selectedIds);
        if (!_allSelected && !ids.length) { alert('No records selected.'); return; }
        var btn = document.querySelector('[onclick="doExport()"]');
        if (btn) { btn.textContent = 'Downloading…'; btn.disabled = true; }
        try {
          var res = await fetch('/records/export', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: _allSelected ? [] : ids, columns: cols, selectAll: _allSelected, filterParams: window.location.search })
          });
          if (!res.ok) { alert('Export failed.'); return; }
          var blob = await res.blob();
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url;
          a.download = 'loki_export_' + new Date().toISOString().split('T')[0] + '.csv';
          a.click();
          URL.revokeObjectURL(url);
          document.getElementById('export-modal').classList.remove('open');
        } catch(err) { alert('Export failed: ' + err.message); }
        finally { if (btn) { btn.textContent = 'Download CSV'; btn.disabled = false; } }
      }
      </script>
    `, 'records'));
  } catch (e) {
    console.error(e);
    res.status(500).send('Server error: ' + e.message);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORT — POST /records/export
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/export', requireAuth, async (req, res) => {
  try {
    await distress.ensureDistressSchema();
    const { ids, columns, selectAll, filterParams } = req.body;
    if (!columns || !columns.length) return res.status(400).json({ error: 'No columns selected' });

    let props;
    if (selectAll) {
      const qs = new URLSearchParams(filterParams || '');
      let conditions = [], params = [], idx = 1;
      const qv = (k) => qs.get(k) || '';
      const qvAll = (k) => qs.getAll(k).filter(v => v && String(v).trim() !== '');
      if (qv('q'))           { conditions.push(`(p.street ILIKE $${idx} OR p.city ILIKE $${idx} OR c.first_name ILIKE $${idx} OR c.last_name ILIKE $${idx})`); params.push(`%${qv('q')}%`); idx++; }
      const stateArr = qvAll('state').map(s => String(s).toUpperCase());
      if (stateArr.length > 0) {
        conditions.push(`p.state_code = ANY($${idx}::text[])`);
        params.push(stateArr);
        idx++;
      }
      // Same comma-split logic as the list view (consistency)
      const splitCsv = (raw) => !raw ? [] : String(raw).split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
      const cityArr   = splitCsv(qv('city'));
      const zipArr    = splitCsv(qv('zip'));
      const countyArr = splitCsv(qv('county'));
      if (cityArr.length > 0) {
        const o = cityArr.map(() => `p.city ILIKE $${idx++}`);
        conditions.push(`(${o.join(' OR ')})`);
        cityArr.forEach(c => params.push(`%${c}%`));
      }
      if (zipArr.length > 0) {
        const o = zipArr.map(() => `p.zip_code ILIKE $${idx++}`);
        conditions.push(`(${o.join(' OR ')})`);
        zipArr.forEach(z => params.push(`${z}%`));
      }
      if (countyArr.length > 0) {
        const o = countyArr.map(() => `p.county ILIKE $${idx++}`);
        conditions.push(`(${o.join(' OR ')})`);
        countyArr.forEach(c => params.push(`%${c}%`));
      }
      if (qv('type'))        { conditions.push(`p.property_type = $${idx}`);     params.push(qv('type')); idx++; }
      if (qv('pipeline'))    { conditions.push(`p.pipeline_stage = $${idx}`);    params.push(qv('pipeline')); idx++; }
      if (qv('prop_status')) { conditions.push(`p.property_status = $${idx}`);   params.push(qv('prop_status')); idx++; }
      if (qv('mkt_result'))  { conditions.push(`p.marketing_result = $${idx}`);  params.push(qv('mkt_result')); idx++; }
      if (qv('min_assessed')){ conditions.push(`p.assessed_value >= $${idx}`);   params.push(qv('min_assessed')); idx++; }
      if (qv('max_assessed')){ conditions.push(`p.assessed_value <= $${idx}`);   params.push(qv('max_assessed')); idx++; }
      if (qv('min_equity'))  { conditions.push(`p.equity_percent >= $${idx}`);   params.push(qv('min_equity')); idx++; }
      if (qv('max_equity'))  { conditions.push(`p.equity_percent <= $${idx}`);   params.push(qv('max_equity')); idx++; }
      if (qv('min_year'))    { conditions.push(`p.year_built >= $${idx}`);       params.push(qv('min_year')); idx++; }
      if (qv('max_year'))    { conditions.push(`p.year_built <= $${idx}`);       params.push(qv('max_year')); idx++; }
      if (qv('upload_from')) { conditions.push(`p.created_at >= $${idx}`);       params.push(qv('upload_from')); idx++; }
      if (qv('upload_to'))   { conditions.push(`p.created_at <= $${idx}`);       params.push(qv('upload_to') + ' 23:59:59'); idx++; }
      if (qv('list_id'))     { conditions.push(`EXISTS (SELECT 1 FROM property_lists pl2 WHERE pl2.property_id = p.id AND pl2.list_id = $${idx})`); params.push(qv('list_id')); idx++; }
      const stackArr = qvAll('stack_list').map(v => parseInt(v)).filter(n => !isNaN(n));
      if (stackArr.length > 0) {
        conditions.push(
          `(SELECT COUNT(DISTINCT pl_stack.list_id)
              FROM property_lists pl_stack
             WHERE pl_stack.property_id = p.id
               AND pl_stack.list_id = ANY($${idx}::int[])) = $${idx+1}`
        );
        params.push(stackArr);
        params.push(stackArr.length);
        idx += 2;
      }
      if (qv('min_stack'))   { conditions.push(`(SELECT COUNT(*) FROM property_lists plc WHERE plc.property_id = p.id) >= $${idx}`); params.push(parseInt(qv('min_stack'))); idx++; }
      const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
      props = await query(`
        SELECT DISTINCT ON (p.id)
          p.id, p.street, p.city, p.state_code, p.zip_code, p.county,
          p.property_type, p.year_built, p.sqft, p.bedrooms, p.bathrooms,
          p.assessed_value, p.estimated_value, p.equity_percent,
          p.property_status, p.pipeline_stage, p.condition,
          p.last_sale_date, p.last_sale_price, p.marketing_result,
          p.distress_score, p.distress_band,
          p.source, p.created_at,
          c.first_name, c.last_name,
          c.mailing_address, c.mailing_city, c.mailing_state, c.mailing_zip,
          c.email_1, c.email_2,
          (SELECT COUNT(*) FROM property_lists pl WHERE pl.property_id = p.id) AS list_count
        FROM properties p
        LEFT JOIN property_contacts pc ON pc.property_id = p.id AND pc.primary_contact = true
        LEFT JOIN contacts c ON c.id = pc.contact_id
        ${where}
        ORDER BY p.id DESC
      `, params);
    } else {
      if (!ids || !ids.length) return res.status(400).json({ error: 'No IDs provided' });
      const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
      props = await query(`
        SELECT
          p.id, p.street, p.city, p.state_code, p.zip_code, p.county,
          p.property_type, p.year_built, p.sqft, p.bedrooms, p.bathrooms,
          p.assessed_value, p.estimated_value, p.equity_percent,
          p.property_status, p.pipeline_stage, p.condition,
          p.last_sale_date, p.last_sale_price, p.marketing_result,
          p.distress_score, p.distress_band,
          p.source, p.created_at,
          c.first_name, c.last_name,
          c.mailing_address, c.mailing_city, c.mailing_state, c.mailing_zip,
          c.email_1, c.email_2,
          (SELECT COUNT(*) FROM property_lists pl WHERE pl.property_id = p.id) AS list_count
        FROM properties p
        LEFT JOIN property_contacts pc ON pc.property_id = p.id AND pc.primary_contact = true
        LEFT JOIN contacts c ON c.id = pc.contact_id
        WHERE p.id IN (${placeholders})
      `, ids);
    }

    // Fetch phones
    const allIds = props.rows.map(r => r.id);
    const phoneMap = {};
    if (columns.includes('phones') && allIds.length) {
      const phonePlaceholders = allIds.map((_, i) => `$${i + 1}`).join(',');
      const phoneRes = await query(`
        SELECT ph.phone_number, ph.phone_index, pc.property_id
        FROM phones ph
        JOIN property_contacts pc ON pc.contact_id = ph.contact_id
        WHERE pc.property_id IN (${phonePlaceholders})
        ORDER BY ph.phone_index ASC
      `, allIds);
      phoneRes.rows.forEach(ph => {
        if (!phoneMap[ph.property_id]) phoneMap[ph.property_id] = [];
        phoneMap[ph.property_id].push(ph.phone_number);
      });
    }

    const colLabels = {
      street: 'Street Address', city: 'City', state_code: 'State', zip_code: 'ZIP', county: 'County',
      first_name: 'Owner First Name', last_name: 'Owner Last Name',
      mailing_address: 'Mailing Address', mailing_city: 'Mailing City',
      mailing_state: 'Mailing State', mailing_zip: 'Mailing ZIP',
      email_1: 'Email 1', email_2: 'Email 2',
      phones: 'Phones',
      property_type: 'Property Type', year_built: 'Year Built', sqft: 'Sq Ft',
      bedrooms: 'Bedrooms', bathrooms: 'Bathrooms',
      assessed_value: 'Assessed Value', estimated_value: 'Est. Value', equity_percent: 'Equity %',
      property_status: 'Property Status', pipeline_stage: 'Pipeline Stage', condition: 'Condition',
      last_sale_date: 'Last Sale Date', last_sale_price: 'Last Sale Price',
      marketing_result: 'Marketing Result', source: 'Source',
      list_count: 'Lists Count', created_at: 'Date Added',
      distress_score: 'Distress Score', distress_band: 'Distress Band',
    };

    // Expand the single 'phones' column into Phone 1 ... Phone 15 columns.
    // Wherever 'phones' appears in the user's selection, splice in 15 keys.
    const PHONE_SLOTS = 15;
    const expandedColumns = [];
    for (const c of columns) {
      if (c === 'phones') {
        for (let i = 1; i <= PHONE_SLOTS; i++) expandedColumns.push(`__phone_${i}`);
      } else {
        expandedColumns.push(c);
      }
    }

    const headers = expandedColumns.map(k => {
      if (k.startsWith('__phone_')) return 'Phone ' + k.replace('__phone_', '');
      return colLabels[k] || k;
    });

    const csvRows = props.rows.map(row => {
      const phoneList = phoneMap[row.id] || [];
      return expandedColumns.map(col => {
        let val = '';
        if (col.startsWith('__phone_')) {
          const slot = parseInt(col.replace('__phone_', ''), 10);
          val = phoneList[slot - 1] || '';
        } else if (col === 'last_sale_date' || col === 'created_at') {
          val = row[col] ? new Date(row[col]).toLocaleDateString('en-US') : '';
        } else if (col === 'distress_band') {
          // Render as nice label ("Burning" not "burning")
          const labels = { burning: 'Burning', hot: 'Hot', warm: 'Warm', cold: 'Cold' };
          val = row[col] ? (labels[row[col]] || row[col]) : '';
        } else {
          val = row[col] !== null && row[col] !== undefined ? String(row[col]) : '';
        }
        return `"${String(val).replace(/"/g, '""')}"`;
      }).join(',');
    });

    const csv = [headers.map(h => `"${h}"`).join(','), ...csvRows].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="loki_export_${new Date().toISOString().split('T')[0]}.csv"`);
    res.send(csv);

  } catch (e) {
    console.error('Export error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PROPERTY DETAIL — GET /records/:id
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/:id(\\d+)', requireAuth, async (req, res) => {
  try {
    await distress.ensureDistressSchema();
    const { id } = req.params;
    const msg = req.query.msg || '';

    // Property
    const propRes = await query(`SELECT * FROM properties WHERE id = $1`, [id]);
    if (!propRes.rows.length) return res.status(404).send('Property not found');
    const p = propRes.rows[0];

    // Owner contact + phones
    const contactRes = await query(`
      SELECT c.*, pc.role, pc.primary_contact
      FROM contacts c
      JOIN property_contacts pc ON pc.contact_id = c.id
      WHERE pc.property_id = $1
      ORDER BY pc.primary_contact DESC
    `, [id]);

    const primaryContact = contactRes.rows[0] || null;
    let phones = [];
    if (primaryContact) {
      const phoneRes = await query(`
        SELECT * FROM phones WHERE contact_id = $1 ORDER BY phone_index ASC
      `, [primaryContact.id]);
      phones = phoneRes.rows;
    }

    // Lists
    const listsRes = await query(`
      SELECT l.list_name, l.list_type, l.source, pl.added_at
      FROM property_lists pl
      JOIN lists l ON l.id = pl.list_id
      WHERE pl.property_id = $1
      ORDER BY pl.added_at DESC
    `, [id]);

    // Compute distress score on detail view if not yet scored
    // (event-driven updates handle most cases; this catches any gaps)
    // Parse current breakdown to check if it's empty
    let currentBreakdown = p.distress_breakdown;
    if (typeof currentBreakdown === 'string') {
      try { currentBreakdown = JSON.parse(currentBreakdown); } catch(_) { currentBreakdown = null; }
    }
    const breakdownIsEmpty = !Array.isArray(currentBreakdown) || currentBreakdown.length === 0;

    // Lazy-score this property if:
    //   - never scored at all (distress_scored_at is null), OR
    //   - has a non-zero score but breakdown is missing (bulk Recompute All
    //     skips breakdown for performance — fill it on demand here)
    // Skip clean properties (score=0 with empty breakdown is correct, not a gap).
    const neverScored  = p.distress_scored_at == null;
    const breakdownGap = (p.distress_score || 0) > 0 && breakdownIsEmpty;
    if (neverScored || breakdownGap) {
      try {
        const scored = await distress.scoreProperty(id);
        if (scored) {
          p.distress_score = scored.score;
          p.distress_band = scored.band;
          p.distress_breakdown = scored.breakdown;
        }
      } catch(e) { console.error('[distress] detail-page score failed:', e.message); }
    }
    // Parse breakdown for render (re-parse in case scoreProperty just refreshed it)
    let distressBreakdown = p.distress_breakdown;
    if (typeof distressBreakdown === 'string') {
      try { distressBreakdown = JSON.parse(distressBreakdown); } catch(_) { distressBreakdown = []; }
    }
    if (!Array.isArray(distressBreakdown)) distressBreakdown = [];

    // Campaign history (via call_logs + sms_logs joined through phones)
    const campaignRes = await query(`
      SELECT
        cl.campaign_name,
        'call' AS channel,
        cl.disposition,
        cl.disposition_normalized,
        cl.call_date AS activity_date,
        cl.agent_name
      FROM call_logs cl
      JOIN phones ph ON ph.id = cl.phone_id
      JOIN contacts ct ON ct.id = ph.contact_id
      JOIN property_contacts pc ON pc.contact_id = ct.id
      WHERE pc.property_id = $1 AND cl.campaign_name IS NOT NULL
      UNION ALL
      SELECT
        sl.campaign_name,
        'sms' AS channel,
        sl.disposition,
        NULL AS disposition_normalized,
        sl.sent_at AS activity_date,
        NULL AS agent_name
      FROM sms_logs sl
      JOIN phones ph ON ph.id = sl.phone_id
      JOIN contacts ct ON ct.id = ph.contact_id
      JOIN property_contacts pc ON pc.contact_id = ct.id
      WHERE pc.property_id = $1 AND sl.campaign_name IS NOT NULL
      ORDER BY activity_date DESC
      LIMIT 50
    `, [id]);

    // Import history
    const importRes = await query(`
      SELECT * FROM import_history WHERE property_id = $1 ORDER BY imported_at DESC
    `, [id]);

    // ── Render phones ──
    const phoneHTML = phones.length ? phones.map(ph => {
      const statusClass = {unknown:'ps-unknown',correct:'ps-correct',wrong:'ps-wrong',dead:'ps-dead'}[ph.phone_status?.toLowerCase()] || 'ps-unknown';
      return `<div class="phone-row">
        <span class="phone-num">${ph.phone_number}</span>
        <div style="display:flex;align-items:center;gap:8px">
          ${ph.phone_tag ? `<span class="tag">${ph.phone_tag}</span>` : ''}
          <span class="phone-status ${statusClass}">${ph.phone_status || 'Unknown'}</span>
        </div>
      </div>`;
    }).join('') : '<div style="color:#aaa;font-size:13px">No phones on record</div>';

    // ── Render lists ──
    const listsHTML = listsRes.rows.length ? `
      <table class="data-table">
        <thead><tr><th>List Name</th><th>Type</th><th>Source</th><th>Date Added</th></tr></thead>
        <tbody>${listsRes.rows.map(l => `<tr>
          <td style="font-weight:500">${l.list_name}</td>
          <td>${l.list_type ? `<span class="chip chip-call">${l.list_type}</span>` : '—'}</td>
          <td style="color:#888;font-size:12px;font-family:monospace">${l.source || '—'}</td>
          <td style="color:#888;font-size:12px">${fmtDate(l.added_at)}</td>
        </tr>`).join('')}</tbody>
      </table>` : '<div class="empty-state" style="padding:1.5rem">Not on any lists yet</div>';

    // ── Render campaign history ──
    const campaignHTML = campaignRes.rows.length ? `
      <table class="data-table">
        <thead><tr><th>Campaign</th><th>Channel</th><th>Disposition</th><th>Date</th></tr></thead>
        <tbody>${campaignRes.rows.map(c => {
          const chipClass = c.channel === 'call' ? 'chip-call' : 'chip-sms';
          return `<tr>
            <td style="font-weight:500">${c.campaign_name || '—'}</td>
            <td><span class="chip ${chipClass}">${c.channel}</span></td>
            <td style="font-size:12px">${c.disposition || '—'}</td>
            <td style="color:#888;font-size:12px">${fmtDate(c.activity_date)}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>` : '<div class="empty-state" style="padding:1.5rem">No campaign activity yet</div>';

    // ── Render import history ──
    const importHTML = importRes.rows.length ? importRes.rows.map(i => `
      <div class="timeline-item">
        <div class="timeline-date">${fmtDate(i.imported_at)}</div>
        <div>
          <div class="timeline-source">${i.source || 'Unknown source'}${i.imported_by ? ` — ${i.imported_by}` : ''}</div>
          <div class="timeline-detail">
            ${i.fields_added ? `<span class="added">+${i.fields_added}</span>` : ''}
            ${i.fields_updated ? ` · <span class="updated">Updated: ${i.fields_updated}</span>` : ''}
            ${i.notes ? ` · ${i.notes}` : ''}
          </div>
        </div>
      </div>`).join('') : '<div style="color:#aaa;font-size:13px;padding:8px 0">No import history yet</div>';

    const owner = primaryContact ? `${primaryContact.first_name || ''} ${primaryContact.last_name || ''}`.trim() : null;
    const mailingAddr = primaryContact ? [primaryContact.mailing_address, primaryContact.mailing_city, primaryContact.mailing_state, primaryContact.mailing_zip].filter(Boolean).join(', ') : null;

    res.send(shell(`${p.street}`, `
      ${msg === 'saved' ? '<div class="alert alert-success">✓ Changes saved successfully</div>' : ''}
      ${msg === 'error' ? '<div class="alert alert-error">Something went wrong. Please try again.</div>' : ''}

      <!-- HEADER -->
      <div style="margin-bottom:1.5rem">
        <div style="margin-bottom:10px"><a href="/records" style="font-size:13px;color:#888;text-decoration:none">← Records</a></div>
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap">
          <div>
            <div style="font-size:24px;font-weight:700;letter-spacing:-.3px">${p.street}</div>
            <div style="font-size:14px;color:#888;margin-top:4px;font-family:monospace">${p.city}, ${p.state_code} · ${p.zip_code}</div>
            <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
              ${p.source ? `<span class="badge" style="background:#e8f0ff;color:#2c5cc5">📂 ${p.source}</span>` : ''}
              ${p.vacant ? `<span class="badge" style="background:#fdf0f0;color:#c0392b">⚠ Vacant</span>` : ''}
              ${listsRes.rows.length ? `<span class="badge" style="background:#e8f5ee;color:#1a7a4a">${listsRes.rows.length} List${listsRes.rows.length!==1?'s':''}</span>` : ''}
              ${p.distress_score != null && p.distress_band ? (() => {
                const c = distress.BAND_COLORS[p.distress_band];
                return `<span class="badge" style="background:${c.bg};color:${c.text}">🔥 Distress ${p.distress_score} · ${c.label}</span>`;
              })() : ''}
              <span style="font-size:12px;color:#aaa;font-family:monospace">First seen: ${fmtDate(p.first_seen_at || p.created_at)}</span>
            </div>
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            ${p.estimated_value ? `<div style="text-align:right"><div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.06em">Est. Value</div><div style="font-size:22px;font-weight:700;color:#1a7a4a">${fmtMoney(p.estimated_value)}</div></div>` : ''}
            <button class="btn btn-ghost" onclick="document.getElementById('edit-modal').classList.add('open')">✏ Edit</button>
          </div>
        </div>
      </div>

      <!-- OWNER + PHONES -->
      <div class="grid-2" style="margin-bottom:1.25rem">
        <div class="card">
          <div class="sec-lbl">Owner</div>
          <div class="kv-grid" style="margin-bottom:1.25rem">
            <div class="kv"><div class="kv-label">First Name</div><div class="kv-val">${primaryContact?.first_name || '—'}</div></div>
            <div class="kv"><div class="kv-label">Last Name</div><div class="kv-val">${primaryContact?.last_name || '—'}</div></div>
            <div class="kv" style="grid-column:1/-1"><div class="kv-label">Mailing Address</div><div class="kv-val">${mailingAddr || '—'}</div></div>
            ${primaryContact?.email_1 ? `<div class="kv"><div class="kv-label">Email 1</div><div class="kv-val"><a href="mailto:${primaryContact.email_1}" style="color:#1a4a9a">${primaryContact.email_1}</a></div></div>` : ''}
            ${primaryContact?.email_2 ? `<div class="kv"><div class="kv-label">Email 2</div><div class="kv-val"><a href="mailto:${primaryContact.email_2}" style="color:#1a4a9a">${primaryContact.email_2}</a></div></div>` : ''}
          </div>
          <div class="sec-lbl">Phone Numbers <span class="count-pill">${phones.length}</span></div>
          ${phoneHTML}
        </div>

        <div class="card">
          <div class="sec-lbl">Property Details</div>
          <div class="kv-grid" style="margin-bottom:1.25rem">
            <div class="kv"><div class="kv-label">Type</div><div class="kv-val">${fmt(p.property_type)}</div></div>
            <div class="kv"><div class="kv-label">Bed / Bath</div><div class="kv-val">${p.bedrooms||'—'} / ${p.bathrooms||'—'}</div></div>
            <div class="kv"><div class="kv-label">Sq Ft</div><div class="kv-val">${p.sqft ? Number(p.sqft).toLocaleString() : '—'}</div></div>
            <div class="kv"><div class="kv-label">Year Built</div><div class="kv-val">${fmt(p.year_built)}</div></div>
            <div class="kv"><div class="kv-label">Lot Size</div><div class="kv-val">${p.lot_size ? Number(p.lot_size).toLocaleString() + ' sf' : '—'}</div></div>
            <div class="kv"><div class="kv-label">Condition</div><div class="kv-val" style="${p.condition==='Fair'?'color:#9a6800':p.condition==='Poor'?'color:#c0392b':''}">${fmt(p.condition)}</div></div>
            <div class="kv"><div class="kv-label">Property Status</div><div class="kv-val" style="${p.property_status==='Sold'?'color:#c0392b':p.property_status==='Pending'?'color:#9a6800':''}">${fmt(p.property_status)}</div></div>
            <div class="kv"><div class="kv-label">Assessed Value</div><div class="kv-val">${fmtMoney(p.assessed_value)}</div></div>
            <div class="kv"><div class="kv-label">Equity %</div><div class="kv-val highlight">${p.equity_percent ? p.equity_percent + '%' : '—'}</div></div>
            <div class="kv"><div class="kv-label">Marketing Result</div><div class="kv-val">${fmt(p.marketing_result)}</div></div>
          </div>
          <div class="sec-lbl">Sale History</div>
          <div class="kv-grid">
            <div class="kv"><div class="kv-label">Last Sale Date</div><div class="kv-val">${fmtDate(p.last_sale_date)}</div></div>
            <div class="kv"><div class="kv-label">Last Sale Price</div><div class="kv-val highlight">${fmtMoney(p.last_sale_price)}</div></div>
          </div>
        </div>
      </div>

      <!-- LISTS -->
      <div class="card" style="margin-bottom:1.25rem">
        <div class="sec-lbl">Lists <span class="count-pill">${listsRes.rows.length}</span></div>
        ${listsHTML}
      </div>

      <!-- DISTRESS SCORE CARD -->
      ${p.distress_score != null ? (() => {
        const c = distress.BAND_COLORS[p.distress_band] || distress.BAND_COLORS.cold;
        const breakdownHtml = distressBreakdown.length > 0
          ? distressBreakdown.map(b => `
              <div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid #f0efe9;font-size:13px">
                <span style="color:#444">${b.label}</span>
                <span style="font-weight:600;color:#1a7a4a">+${b.points}</span>
              </div>`).join('')
          : '<div style="color:#aaa;font-size:13px;padding:12px 0;text-align:center">No distress signals detected. This property looks clean.</div>';
        return `
        <div class="card" style="margin-bottom:1.25rem;border-left:4px solid ${c.text}">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
            <div>
              <div class="sec-lbl" style="margin-bottom:4px">Distress Score</div>
              <div style="display:flex;align-items:baseline;gap:10px">
                <span style="font-size:36px;font-weight:700;color:${c.text};letter-spacing:-.5px">${p.distress_score}</span>
                <span style="font-size:14px;color:${c.text};font-weight:600;text-transform:uppercase;letter-spacing:.06em">${c.label}</span>
              </div>
              <p style="font-size:11px;color:#aaa;margin-top:6px">Scored ${p.distress_scored_at ? fmtDate(p.distress_scored_at) : 'just now'}</p>
            </div>
            <div style="text-align:right;max-width:280px">
              <p style="font-size:11px;color:#888;line-height:1.5;margin:0">Rule-based score from signals in Loki. <br><span style="color:#aaa">Audit and tune weights in Setup → Distress.</span></p>
            </div>
          </div>
          <div style="margin-top:8px">
            <div class="sec-lbl" style="margin-bottom:4px">Signals Contributing</div>
            ${breakdownHtml}
          </div>
        </div>`;
      })() : ''}

      <!-- CAMPAIGN HISTORY -->
      <div class="card" style="margin-bottom:1.25rem">
        <div class="sec-lbl">Campaign History <span class="count-pill">${campaignRes.rows.length}</span></div>
        ${campaignHTML}
      </div>

      <!-- IMPORT HISTORY -->
      <div class="card" style="margin-bottom:1.25rem">
        <div class="sec-lbl">Import History <span class="count-pill">${importRes.rows.length}</span></div>
        ${importHTML}
      </div>

      <!-- EDIT MODAL -->
      <div class="modal-overlay" id="edit-modal">
        <div class="modal">
          <div class="modal-header">
            <div class="modal-title">Edit Property</div>
            <button class="modal-close" onclick="document.getElementById('edit-modal').classList.remove('open')">×</button>
          </div>
          <form method="POST" action="/records/${p.id}/edit">
            <div style="font-size:12px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px">Property</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
              <div class="form-field" style="margin:0"><label>Property Type</label>
                <select name="property_type">
                  <option value="">—</option>
                  ${['SFR','MFR','Land','Commercial'].map(t=>`<option value="${t}" ${p.property_type===t?'selected':''}>${t}</option>`).join('')}
                </select>
              </div>
              <div class="form-field" style="margin:0"><label>Condition</label>
                <select name="condition">
                  <option value="">—</option>
                  ${['Excellent','Good','Fair','Poor'].map(t=>`<option value="${t}" ${p.condition===t?'selected':''}>${t}</option>`).join('')}
                </select>
              </div>
              <div class="form-field" style="margin:0"><label>Bedrooms</label><input type="number" name="bedrooms" value="${p.bedrooms||''}"></div>
              <div class="form-field" style="margin:0"><label>Bathrooms</label><input type="number" step="0.5" name="bathrooms" value="${p.bathrooms||''}"></div>
              <div class="form-field" style="margin:0"><label>Sq Ft</label><input type="number" name="sqft" value="${p.sqft||''}"></div>
              <div class="form-field" style="margin:0"><label>Year Built</label><input type="number" name="year_built" value="${p.year_built||''}"></div>
              <div class="form-field" style="margin:0"><label>Est. Value ($)</label><input type="number" name="estimated_value" value="${p.estimated_value||''}"></div>
              <div class="form-field" style="margin:0"><label>Vacant</label>
                <select name="vacant">
                  <option value="">Unknown</option>
                  <option value="true" ${p.vacant===true?'selected':''}>Yes</option>
                  <option value="false" ${p.vacant===false?'selected':''}>No</option>
                </select>
              </div>
              <div class="form-field" style="margin:0"><label>Last Sale Date</label><input type="date" name="last_sale_date" value="${p.last_sale_date ? String(p.last_sale_date).split('T')[0] : ''}"></div>
              <div class="form-field" style="margin:0"><label>Last Sale Price ($)</label><input type="number" name="last_sale_price" value="${p.last_sale_price||''}"></div>
              <div class="form-field" style="margin:0;grid-column:1/-1"><label>Source</label><input type="text" name="source" value="${p.source||''}" placeholder="DealMachine, PropStream, etc."></div>
              <div class="form-field" style="margin:0"><label>Property Status</label>
                <select name="property_status">
                  <option value="">—</option>
                  ${['Off Market','Pending','Sold'].map(t=>`<option value="${t}" ${p.property_status===t?'selected':''}>${t}</option>`).join('')}
                </select>
              </div>
              <div class="form-field" style="margin:0"><label>Assessed Value ($)</label><input type="number" name="assessed_value" value="${p.assessed_value||''}"></div>
              <div class="form-field" style="margin:0"><label>Equity (%)</label><input type="number" step="0.01" name="equity_percent" value="${p.equity_percent||''}"></div>
              <div class="form-field" style="margin:0"><label>Marketing Result</label>
                <select name="marketing_result">
                  <option value="">—</option>
                  ${['Lead','Not Interested','Do Not Call','Wrong Number','Callback','Voicemail'].map(t=>`<option value="${t}" ${p.marketing_result===t?'selected':''}>${t}</option>`).join('')}
                </select>
              </div>
              <div class="form-field" style="margin:0"><label>Pipeline Stage</label>
                <select name="pipeline_stage">
                  <option value="">—</option>
                  ${['prospect','lead','contract','closed'].map(s=>`<option value="${s}" ${p.pipeline_stage===s?'selected':''}>${s.charAt(0).toUpperCase()+s.slice(1)}</option>`).join('')}
                </select>
              </div>
            </div>
            ${primaryContact ? `
            <div style="font-size:12px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.06em;margin:14px 0 10px">Owner</div>
            <input type="hidden" name="contact_id" value="${primaryContact.id}">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
              <div class="form-field" style="margin:0"><label>First Name</label><input type="text" name="first_name" value="${primaryContact.first_name||''}"></div>
              <div class="form-field" style="margin:0"><label>Last Name</label><input type="text" name="last_name" value="${primaryContact.last_name||''}"></div>
              <div class="form-field" style="margin:0;grid-column:1/-1"><label>Mailing Address</label><input type="text" name="mailing_address" value="${primaryContact.mailing_address||''}"></div>
              <div class="form-field" style="margin:0"><label>Mailing City</label><input type="text" name="mailing_city" value="${primaryContact.mailing_city||''}"></div>
              <div class="form-field" style="margin:0"><label>Mailing State</label><input type="text" name="mailing_state" value="${primaryContact.mailing_state||''}" maxlength="2"></div>
              <div class="form-field" style="margin:0;grid-column:1/-1"><label>Email 1</label><input type="email" name="email_1" value="${primaryContact.email_1||''}" placeholder="email@example.com"></div>
              <div class="form-field" style="margin:0;grid-column:1/-1"><label>Email 2</label><input type="email" name="email_2" value="${primaryContact.email_2||''}" placeholder="email@example.com"></div>
            </div>` : ''}
            <div class="form-field" style="margin-top:4px"><label>Notes (logged to import history)</label><textarea name="edit_notes" rows="2" placeholder="Optional note about this edit…"></textarea></div>
            <div style="display:flex;gap:8px;margin-top:4px">
              <button type="submit" class="btn btn-primary" style="flex:1">Save Changes</button>
              <button type="button" class="btn btn-ghost" onclick="document.getElementById('edit-modal').classList.remove('open')">Cancel</button>
            </div>
          </form>
        </div>
      </div>
    `, 'records'));
  } catch (e) {
    console.error(e);
    res.status(500).send('Server error: ' + e.message);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// EDIT SUBMIT — POST /records/:id/edit
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/:id(\\d+)/edit', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      property_type, condition, bedrooms, bathrooms, sqft, year_built,
      estimated_value, vacant, last_sale_date, last_sale_price, source,
      property_status, assessed_value, equity_percent, marketing_result,
      pipeline_stage,
      contact_id, first_name, last_name, mailing_address, mailing_city,
      mailing_state, email_1, email_2, edit_notes
    } = req.body;

    // Capture before-state for outcome logging
    const beforeRes = await query(
      `SELECT marketing_result, pipeline_stage FROM properties WHERE id = $1`,
      [id]
    );
    const before = beforeRes.rows[0] || {};

    const updated = [];

    await query(`
      UPDATE properties SET
        property_type = COALESCE(NULLIF($1,''), property_type),
        condition = COALESCE(NULLIF($2,''), condition),
        bedrooms = CASE WHEN $3 = '' THEN bedrooms ELSE $3::smallint END,
        bathrooms = CASE WHEN $4 = '' THEN bathrooms ELSE $4::numeric END,
        sqft = CASE WHEN $5 = '' THEN sqft ELSE $5::integer END,
        year_built = CASE WHEN $6 = '' THEN year_built ELSE $6::smallint END,
        estimated_value = CASE WHEN $7 = '' THEN estimated_value ELSE $7::numeric END,
        vacant = CASE WHEN $8 = '' THEN vacant WHEN $8 = 'true' THEN true ELSE false END,
        last_sale_date = CASE WHEN $9 = '' THEN last_sale_date ELSE $9::date END,
        last_sale_price = CASE WHEN $10 = '' THEN last_sale_price ELSE $10::numeric END,
        source = COALESCE(NULLIF($11,''), source),
        property_status = COALESCE(NULLIF($12,''), property_status),
        assessed_value = CASE WHEN $13 = '' THEN assessed_value ELSE $13::numeric END,
        equity_percent = CASE WHEN $14 = '' THEN equity_percent ELSE $14::numeric END,
        marketing_result = COALESCE(NULLIF($15,''), marketing_result),
        pipeline_stage = COALESCE(NULLIF($16,''), pipeline_stage),
        updated_at = NOW()
      WHERE id = $17
    `, [property_type, condition, bedrooms||'', bathrooms||'', sqft||'', year_built||'',
        estimated_value||'', vacant||'', last_sale_date||'', last_sale_price||'', source,
        property_status||'', assessed_value||'', equity_percent||'',
        marketing_result||'', pipeline_stage||'', id]);

    updated.push('property fields');

    if (contact_id) {
      await query(`
        UPDATE contacts SET
          first_name = COALESCE(NULLIF($1,''), first_name),
          last_name = COALESCE(NULLIF($2,''), last_name),
          mailing_address = COALESCE(NULLIF($3,''), mailing_address),
          mailing_city = COALESCE(NULLIF($4,''), mailing_city),
          mailing_state = COALESCE(NULLIF($5,''), mailing_state),
          email_1 = COALESCE(NULLIF($6,''), email_1),
          email_2 = COALESCE(NULLIF($7,''), email_2),
          updated_at = NOW()
        WHERE id = $8
      `, [first_name, last_name, mailing_address, mailing_city, mailing_state, email_1||'', email_2||'', contact_id]);
      updated.push('owner info');
    }

    // Log to import history
    await query(`
      INSERT INTO import_history (property_id, source, imported_by, fields_updated, notes)
      VALUES ($1, 'Manual Edit', $2, $3, $4)
    `, [id, req.session.username || 'admin', updated.join(', '), edit_notes || null]);

    // Distress: log outcome transitions + rescore
    try {
      // If marketing_result or pipeline_stage actually changed, log outcome
      const newMkt = (marketing_result || '').trim();
      const newStage = (pipeline_stage || '').trim();
      if (newMkt && newMkt !== (before.marketing_result || '')) {
        await distress.logOutcomeChange(id, 'marketing_result', before.marketing_result, newMkt);
      }
      if (newStage && newStage !== (before.pipeline_stage || '')) {
        await distress.logOutcomeChange(id, 'pipeline_stage', before.pipeline_stage, newStage);
      }
      // Always re-score after edit — equity, mailing state, marketing result all affect it
      await distress.scoreProperty(id);
    } catch(e) {
      console.error('[distress] post-edit hook failed:', e.message);
      // Non-fatal — don't block the user's edit on scoring failure
    }

    res.redirect(`/records/${id}?msg=saved`);
  } catch (e) {
    console.error(e);
    res.redirect(`/records/${req.params.id}?msg=error`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SETUP → DISTRESS (admin audit page)
// Mounted at /records/_distress — links from Setup sidebar go here.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/_distress', requireAuth, async (req, res) => {
  try {
    await distress.ensureDistressSchema();
    const dist = await distress.getScoreDistribution();
    const conv = await distress.getConversionByBand();
    // 3 new audit datasets
    const closedHistory = await distress.getClosedDealScoreHistory();
    const coverage = await distress.getSignalCoverage();
    const convRates = await distress.getConversionRateByBand();

    const total = parseInt(dist.total || 0);
    const scored = total - parseInt(dist.unscored || 0);
    const pct = (n) => total > 0 ? ((parseInt(n||0) / total) * 100).toFixed(1) + '%' : '0%';

    // Group conversion data by band → outcome type → {new_value: count}
    const convByBand = { burning: {}, hot: {}, warm: {}, cold: {} };
    conv.forEach(r => {
      if (!convByBand[r.band]) convByBand[r.band] = {};
      if (!convByBand[r.band][r.outcome_type]) convByBand[r.band][r.outcome_type] = {};
      convByBand[r.band][r.outcome_type][r.new_value || '(empty)'] = parseInt(r.count);
    });

    const weightRows = Object.entries(distress.WEIGHTS).map(([k, v]) =>
      `<tr>
        <td style="padding:8px 12px;font-size:13px;color:#444">${k.replace(/_/g, ' ')}</td>
        <td style="padding:8px 12px;font-size:13px;font-weight:600;color:#1a7a4a;text-align:right">+${v}</td>
      </tr>`
    ).join('');

    const bandBar = (band, count) => {
      const c = distress.BAND_COLORS[band];
      const width = total > 0 ? (parseInt(count||0) / total) * 100 : 0;
      return `
        <div style="margin-bottom:12px">
          <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px">
            <span style="color:${c.text};font-weight:600">${c.label}</span>
            <span style="color:#888">${parseInt(count||0).toLocaleString()} · ${pct(count)}</span>
          </div>
          <div style="background:#f0efe9;border-radius:6px;height:10px;overflow:hidden">
            <div style="background:${c.text};width:${width}%;height:100%;transition:width .3s"></div>
          </div>
        </div>`;
    };

    const convTable = Object.entries(convByBand).map(([band, outcomes]) => {
      const c = distress.BAND_COLORS[band];
      const outcomeKeys = Object.keys(outcomes);
      if (outcomeKeys.length === 0) return '';
      const rows = outcomeKeys.map(ot => {
        return Object.entries(outcomes[ot]).map(([val, cnt]) =>
          `<tr>
            <td style="padding:6px 12px;font-size:12px;color:#888">${ot}</td>
            <td style="padding:6px 12px;font-size:12px;color:#444">${val}</td>
            <td style="padding:6px 12px;font-size:12px;text-align:right;font-weight:600">${cnt.toLocaleString()}</td>
          </tr>`
        ).join('');
      }).join('');
      return `
        <div style="margin-bottom:16px">
          <div style="padding:6px 12px;background:${c.bg};color:${c.text};font-size:12px;font-weight:600;border-radius:6px 6px 0 0">${c.label} band outcomes</div>
          <table style="width:100%;border:1px solid #e0dfd8;border-top:none;border-collapse:collapse;border-radius:0 0 6px 6px;overflow:hidden">
            <thead><tr style="background:#fafaf8">
              <th style="padding:6px 12px;text-align:left;font-size:11px;color:#888;font-weight:600;text-transform:uppercase">Type</th>
              <th style="padding:6px 12px;text-align:left;font-size:11px;color:#888;font-weight:600;text-transform:uppercase">New Value</th>
              <th style="padding:6px 12px;text-align:right;font-size:11px;color:#888;font-weight:600;text-transform:uppercase">Count</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    }).join('');

    res.send(shell('Distress Score Audit', `
      <div style="margin-bottom:1rem"><a href="/records" style="font-size:13px;color:#888;text-decoration:none">← Records</a></div>
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:1.5rem">
        <div>
          <div style="font-size:24px;font-weight:700;letter-spacing:-.3px">Distress Score Audit</div>
          <div style="font-size:13px;color:#888;margin-top:4px">Rule-based scoring engine · Phase 1</div>
        </div>
        <form method="POST" action="/records/_distress/recompute" onsubmit="return confirm('Recompute distress score for ALL ${total.toLocaleString()} properties? This may take 30-60 seconds.')">
          <button type="submit" class="btn" style="background:#1a4a9a;color:#fff;border:none">↻ Recompute All Scores</button>
        </form>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:1.25rem">
        <div class="card">
          <div class="sec-lbl" style="margin-bottom:10px">Score Distribution</div>
          <div style="font-size:12px;color:#888;margin-bottom:10px">${scored.toLocaleString()} of ${total.toLocaleString()} records scored${dist.unscored > 0 ? ` · ${parseInt(dist.unscored).toLocaleString()} pending` : ''}</div>
          ${bandBar('burning', dist.burning)}
          ${bandBar('hot', dist.hot)}
          ${bandBar('warm', dist.warm)}
          ${bandBar('cold', dist.cold)}
        </div>

        <div class="card">
          <div class="sec-lbl" style="margin-bottom:10px">Current Weights</div>
          <table style="width:100%;border-collapse:collapse">
            <tbody>${weightRows}</tbody>
          </table>
          <p style="font-size:11px;color:#aaa;margin-top:10px">Tune weights in <code>src/scoring/distress.js</code>, then click <b>Recompute All</b>.</p>
        </div>
      </div>

      <!-- AUDIT 1: Closed Deal Score History — "Did the system catch deals that closed?" -->
      <div class="card" style="margin-bottom:1.25rem">
        <div class="sec-lbl" style="margin-bottom:10px">📊 Closed Deal Score History</div>
        <div style="font-size:12px;color:#888;margin-bottom:14px">Properties currently in Lead / Contract / Closed stages. Look at score history — if deals closed while scoring Cold, the system missed signals. If they climbed Hot before closing, the system caught them.</div>
        ${closedHistory.length === 0 ? `
          <div style="color:#aaa;font-size:13px;text-align:center;padding:20px">No properties in Lead / Contract / Closed yet. As you mark them, score histories will appear here.</div>
        ` : `
          <div style="overflow-x:auto">
            <table style="width:100%;font-size:12px;border-collapse:collapse">
              <thead><tr style="border-bottom:1px solid #e0dfd8;text-align:left">
                <th style="padding:8px;font-size:11px;color:#888;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Property</th>
                <th style="padding:8px;font-size:11px;color:#888;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Stage</th>
                <th style="padding:8px;font-size:11px;color:#888;font-weight:600;text-transform:uppercase;letter-spacing:.05em;text-align:center">Current Score</th>
                <th style="padding:8px;font-size:11px;color:#888;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Score History</th>
                <th style="padding:8px;font-size:11px;color:#888;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Verdict</th>
              </tr></thead>
              <tbody>
                ${closedHistory.map(p => {
                  const c = distress.BAND_COLORS[p.distress_band] || distress.BAND_COLORS.cold;
                  const history = p.score_history || [];
                  const histStr = history.length === 0
                    ? '<span style="color:#aaa">No prior scores</span>'
                    : history.map(h => {
                        const hc = distress.BAND_COLORS[h.band] || distress.BAND_COLORS.cold;
                        return `<span style="display:inline-block;background:${hc.bg};color:${hc.text};padding:2px 6px;border-radius:4px;font-size:10px;font-weight:600;margin-right:3px">${h.score}</span>`;
                      }).join('→');
                  // Verdict logic
                  const stage = p.pipeline_stage;
                  let verdict = '';
                  if (stage === 'closed' || stage === 'contract') {
                    if (p.distress_band === 'burning' || p.distress_band === 'hot') verdict = '<span style="color:#1a7a4a;font-weight:600">✓ Caught</span>';
                    else if (p.distress_band === 'warm') verdict = '<span style="color:#9a6800;font-weight:600">~ Borderline</span>';
                    else verdict = '<span style="color:#c0392b;font-weight:600">✗ Missed</span>';
                  } else {
                    verdict = '<span style="color:#888">In progress</span>';
                  }
                  return `
                    <tr style="border-bottom:1px solid #f0efe9">
                      <td style="padding:8px"><a href="/records/${p.id}" style="color:#1a4a9a;text-decoration:none">${p.street}</a><br><span style="color:#888;font-size:11px">${p.city}, ${p.state_code}</span></td>
                      <td style="padding:8px;text-transform:capitalize">${stage}</td>
                      <td style="padding:8px;text-align:center"><span style="background:${c.bg};color:${c.text};padding:3px 8px;border-radius:4px;font-weight:600">${p.distress_score}</span></td>
                      <td style="padding:8px">${histStr}</td>
                      <td style="padding:8px">${verdict}</td>
                    </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>
        `}
      </div>

      <!-- AUDIT 2: Signal Coverage Report — "What data is missing?" -->
      <div class="card" style="margin-bottom:1.25rem">
        <div class="sec-lbl" style="margin-bottom:10px">📋 Signal Coverage Report</div>
        <div style="font-size:12px;color:#888;margin-bottom:14px">% of records with each scoring input populated. <b>Low coverage = signal silently mutes scoring.</b> If only 12% have equity data, the High Equity rule fires for nobody — that's a data gap, not a scoring problem.</div>
        ${coverage.total === 0 ? '<div style="color:#aaa">No records to analyze.</div>' : (() => {
          const sigs = [
            { label: 'Property State Code', count: coverage.has_state, signal: 'Required for out-of-state detection' },
            { label: 'Mailing State (owner)', count: coverage.has_mailing_state, signal: 'Required for out-of-state detection' },
            { label: 'Equity %', count: coverage.has_equity, signal: 'Drives High Equity (+10) signal' },
            { label: 'Marketing Result', count: coverage.has_marketing, signal: 'Drives Marketing Lead (+5) signal' },
            { label: 'On at least 1 List', count: coverage.has_any_list, signal: 'Required for ALL list-based signals' },
          ];
          return `<div style="display:grid;gap:10px">
            ${sigs.map(s => {
              const p = (s.count / coverage.total) * 100;
              const color = p >= 80 ? '#1a7a4a' : p >= 40 ? '#9a6800' : '#c0392b';
              return `
                <div>
                  <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:3px">
                    <span style="color:#1a1a1a;font-weight:500">${s.label}</span>
                    <span style="color:${color};font-weight:600">${s.count.toLocaleString()} / ${coverage.total.toLocaleString()} (${p.toFixed(1)}%)</span>
                  </div>
                  <div style="background:#f0efe9;height:6px;border-radius:3px;overflow:hidden;margin-bottom:3px">
                    <div style="background:${color};width:${p}%;height:100%"></div>
                  </div>
                  <div style="font-size:11px;color:#aaa">${s.signal}</div>
                </div>`;
            }).join('')}
          </div>`;
        })()}
      </div>

      <!-- AUDIT 3: Conversion Rate by Band — "Are weights calibrated correctly?" -->
      <div class="card" style="margin-bottom:1.25rem">
        <div class="sec-lbl" style="margin-bottom:10px">🎯 Conversion Rate by Band</div>
        <div style="font-size:12px;color:#888;margin-bottom:14px">% of properties in each band that have advanced to Lead / Contract / Closed. <b>If higher bands convert at higher rates, weights are calibrated.</b> If they're flat or inverted, time to tune.</div>
        ${convRates.length === 0 ? '<div style="color:#aaa">No band data yet — recompute scores first.</div>' : `
          <table style="width:100%;font-size:12px;border-collapse:collapse">
            <thead><tr style="border-bottom:1px solid #e0dfd8">
              <th style="padding:8px;text-align:left;font-size:11px;color:#888;font-weight:600;text-transform:uppercase">Band</th>
              <th style="padding:8px;text-align:right;font-size:11px;color:#888;font-weight:600;text-transform:uppercase">Total</th>
              <th style="padding:8px;text-align:right;font-size:11px;color:#888;font-weight:600;text-transform:uppercase">Lead</th>
              <th style="padding:8px;text-align:right;font-size:11px;color:#888;font-weight:600;text-transform:uppercase">Contract</th>
              <th style="padding:8px;text-align:right;font-size:11px;color:#888;font-weight:600;text-transform:uppercase">Closed</th>
              <th style="padding:8px;text-align:right;font-size:11px;color:#888;font-weight:600;text-transform:uppercase">Any Adv. %</th>
            </tr></thead>
            <tbody>
              ${convRates.map(r => {
                const c = distress.BAND_COLORS[r.band] || distress.BAND_COLORS.cold;
                return `
                  <tr style="border-bottom:1px solid #f0efe9">
                    <td style="padding:8px"><span style="background:${c.bg};color:${c.text};padding:3px 9px;border-radius:5px;font-weight:600;font-size:11px">${c.label}</span></td>
                    <td style="padding:8px;text-align:right">${r.total.toLocaleString()}</td>
                    <td style="padding:8px;text-align:right">${r.leads.toLocaleString()}</td>
                    <td style="padding:8px;text-align:right">${r.contracts.toLocaleString()}</td>
                    <td style="padding:8px;text-align:right;font-weight:600">${r.closed.toLocaleString()}</td>
                    <td style="padding:8px;text-align:right;font-weight:600;color:${r.any_rate >= 5 ? '#1a7a4a' : r.any_rate >= 1 ? '#9a6800' : '#888'}">${r.any_rate.toFixed(2)}%</td>
                  </tr>`;
              }).join('')}
            </tbody>
          </table>
          <p style="font-size:11px;color:#aaa;margin-top:12px;padding-top:8px;border-top:1px solid #f0efe9">
            <b>Healthy pattern:</b> Burning &gt; Hot &gt; Warm &gt; Cold conversion rates.<br>
            <b>Need tuning:</b> Cold converting equally well, or Hot converting worse than Warm.
          </p>
        `}
      </div>

      <div class="card">
        <div class="sec-lbl" style="margin-bottom:10px">Outcome Log — Conversion by Band</div>
        <div style="font-size:12px;color:#888;margin-bottom:14px">Captures what happened to properties at each score level. As data accumulates, this tells you which bands actually convert — the feedback loop for tuning weights.</div>
        ${convTable || '<div style="color:#aaa;font-size:13px;text-align:center;padding:20px">No outcome data yet. As you mark properties as Lead / Contract / Closed, data will accumulate here.</div>'}
      </div>
    `));
  } catch (e) {
    console.error('[distress/audit]', e);
    res.status(500).send('Distress audit page error: ' + e.message);
  }
});

router.post('/_distress/recompute', requireAuth, async (req, res) => {
  try {
    const startedAt = Date.now();
    console.log('[distress/recompute] starting…');
    const result = await distress.scoreAllProperties((p) => {
      if (p.finished) console.log(`[distress/recompute] done: ${p.done}/${p.total}`);
      else console.log(`[distress/recompute] progress: ${p.done}/${p.total}`);
    });
    console.log(`[distress/recompute] finished in ${Math.round((Date.now()-startedAt)/1000)}s — scored ${result.scored} of ${result.total}`);
    res.redirect('/records/_distress');
  } catch(e) {
    console.error('[distress/recompute]', e);
    res.status(500).send('Recompute failed: ' + e.message);
  }
});

module.exports = router;
