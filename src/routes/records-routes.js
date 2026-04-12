const express = require('express');
const router = express.Router();
const { query } = require('../db');

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
    const {
      q = '', state = '', city = '', zip = '', county = '',
      type = '', list_id = '', stack_list = '', min_stack = '',
      pipeline = '', mkt_result = '', prop_status = '',
      min_assessed = '', max_assessed = '',
      min_equity = '', max_equity = '',
      min_year = '', max_year = '',
      upload_from = '', upload_to = '',
      page = 1
    } = req.query;
    const limit = 50;
    const offset = (parseInt(page) - 1) * limit;

    let conditions = [];
    let params = [];
    let idx = 1;

    if (q) {
      conditions.push(`(p.street ILIKE $${idx} OR p.city ILIKE $${idx} OR p.zip_code ILIKE $${idx} OR c.first_name ILIKE $${idx} OR c.last_name ILIKE $${idx} OR ph.phone_number ILIKE $${idx})`);
      params.push(`%${q}%`); idx++;
    }
    if (state)        { conditions.push(`p.state_code = $${idx}`);       params.push(state); idx++; }
    if (city)         { conditions.push(`p.city ILIKE $${idx}`);          params.push(`%${city}%`); idx++; }
    if (zip)          { conditions.push(`p.zip_code ILIKE $${idx}`);      params.push(`%${zip}%`); idx++; }
    if (county)       { conditions.push(`p.county ILIKE $${idx}`);        params.push(`%${county}%`); idx++; }
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
    if (stack_list)   { conditions.push(`EXISTS (SELECT 1 FROM property_lists pl3 WHERE pl3.property_id = p.id AND pl3.list_id = $${idx})`); params.push(stack_list); idx++; }
    if (min_stack)    { conditions.push(`(SELECT COUNT(*) FROM property_lists plc WHERE plc.property_id = p.id) >= $${idx}`); params.push(parseInt(min_stack)); idx++; }

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

    const rows = await query(`
      SELECT DISTINCT ON (p.id)
        p.id, p.street, p.city, p.state_code, p.zip_code,
        p.property_type, p.vacant, p.pipeline_stage, p.source,
        p.estimated_value, p.condition, p.created_at,
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
      return `<tr data-id="${r.id}" data-street="${r.street}" data-city="${r.city}" data-state="${r.state_code}" data-zip="${r.zip_code}" data-owner="${owner}" data-type="${r.property_type||''}" data-stage="${stage}" data-phones="${r.phone_count||0}" data-lists="${r.list_count||0}" data-added="${r.created_at||''}" onclick="handleRowClick(event,this)">
        <td onclick="event.stopPropagation()" style="width:36px;padding-left:14px"><input type="checkbox" class="row-check" data-id="${r.id}" style="cursor:pointer;width:15px;height:15px"></td>
        <td><div style="font-weight:500">${r.street}</div><div style="font-size:12px;color:#888">${r.city}, ${r.state_code} ${r.zip_code}</div></td>
        <td>${owner}</td>
        <td>${fmt(r.property_type)}</td>
        <td>${r.phone_count || 0}</td>
        <td>${r.list_count || 0}</td>
        <td><span style="background:${stageColor};color:${stageText};padding:2px 9px;border-radius:4px;font-size:11px;font-weight:600;text-transform:capitalize">${stage}</span></td>
        <td>${fmtDate(r.created_at)}</td>
      </tr>`;
    }).join('');

    const pagination = totalPages > 1 ? `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:1rem;font-size:13px;color:#888">
        <span>Showing ${offset+1}–${Math.min(offset+limit,total)} of ${total.toLocaleString()} records</span>
        <div style="display:flex;gap:6px">
          ${parseInt(page) > 1 ? `<a href="/records?q=${encodeURIComponent(q)}&state=${state}&type=${type}&list_id=${list_id}&page=${parseInt(page)-1}" class="btn btn-ghost" style="padding:6px 12px">← Prev</a>` : ''}
          ${parseInt(page) < totalPages ? `<a href="/records?q=${encodeURIComponent(q)}&state=${state}&type=${type}&list_id=${list_id}&page=${parseInt(page)+1}" class="btn btn-ghost" style="padding:6px 12px">Next →</a>` : ''}
        </div>
      </div>` : '';

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
            ⚙ Filters${[state,city,zip,county,type,pipeline,prop_status,mkt_result,min_assessed,max_assessed,min_equity,max_equity,min_year,max_year,upload_from,upload_to,stack_list,min_stack].filter(Boolean).length > 0 ? ' <span style="background:#1a1a1a;color:#fff;border-radius:10px;padding:1px 7px;font-size:11px;margin-left:4px">'+[state,city,zip,county,type,pipeline,prop_status,mkt_result,min_assessed,max_assessed,min_equity,max_equity,min_year,max_year,upload_from,upload_to,stack_list,min_stack].filter(Boolean).length+'</span>' : ''}
          </button>
          ${[q,state,city,zip,county,type,pipeline,prop_status,mkt_result,min_assessed,max_assessed,min_equity,max_equity,min_year,max_year,upload_from,upload_to,stack_list,min_stack].filter(Boolean).length > 0
            ? '<a href="/records' + (list_id?'?list_id='+list_id:'') + '" class="btn btn-ghost" style="color:#c0392b;border-color:#f5c5c5">✕ Clear</a>' : ''}
        </div>

        <!-- Expandable filter panel -->
        <div id="filter-panel" style="display:${[state,city,zip,county,type,pipeline,prop_status,mkt_result,min_assessed,max_assessed,min_equity,max_equity,min_year,max_year,upload_from,upload_to,stack_list,min_stack].filter(Boolean).length>0?'block':'none'};background:#fff;border:1px solid #e0dfd8;border-radius:10px;padding:16px 18px;margin-bottom:14px">

          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px">

            <!-- Location -->
            <div style="grid-column:1/-1;font-size:10px;font-weight:700;color:#aaa;text-transform:uppercase;letter-spacing:.1em;margin-bottom:2px">Location</div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">State</label>
              <select name="state" style="width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit;background:#fff">
                <option value="">All States</option>
                <option value="IN" ${state==='IN'?'selected':''}>Indiana</option>
                <option value="GA" ${state==='GA'?'selected':''}>Georgia</option>
              </select>
            </div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">City</label>
              <input type="text" name="city" value="${city}" placeholder="e.g. Indianapolis" style="width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit">
            </div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">ZIP Code</label>
              <input type="text" name="zip" value="${zip}" placeholder="e.g. 46218" style="width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit">
            </div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">County</label>
              <input type="text" name="county" value="${county}" placeholder="e.g. Marion" style="width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit">
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
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">Also appears on list</label>
              <select name="stack_list" style="width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit;background:#fff">
                <option value="">— Any list —</option>
                ${allLists.map(l=>`<option value="${l.id}" ${stack_list==l.id?'selected':''}}>${l.list_name}</option>`).join('')}
              </select>
            </div>
            <div>
              <label style="font-size:11px;color:#888;display:block;margin-bottom:3px">Min list stack count</label>
              <input type="number" name="min_stack" value="${min_stack}" placeholder="e.g. 2" min="1" style="width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:13px;font-family:inherit">
            </div>

          </div>

          <div style="margin-top:14px;display:flex;gap:8px">
            <button type="submit" class="btn btn-primary">Apply Filters</button>
            <a href="/records${list_id?'?list_id='+list_id:''}" class="btn btn-ghost">Reset</a>
          </div>
        </div>
      </form>

      <script>
      function toggleFilters() {
        const p = document.getElementById('filter-panel');
        p.style.display = p.style.display === 'none' ? 'block' : 'none';
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
              ['mailing_address','Mailing Address'],['mailing_city','Mailing City'],['mailing_state','Mailing State'],['mailing_zip','Mailing ZIP'],
              ['phones','All Phones'],
              ['property_type','Property Type'],['year_built','Year Built'],['sqft','Sq Ft'],['bedrooms','Bedrooms'],['bathrooms','Bathrooms'],
              ['assessed_value','Assessed Value'],['estimated_value','Est. Value'],['equity_percent','Equity %'],
              ['property_status','Property Status'],['pipeline_stage','Pipeline Stage'],['condition','Condition'],
              ['last_sale_date','Last Sale Date'],['last_sale_price','Last Sale Price'],
              ['marketing_result','Marketing Result'],['source','Source'],
              ['list_count','Lists Count'],['created_at','Date Added'],
            ].map(([k,l]) => `<label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;padding:4px 0">
              <input type="checkbox" value="${k}" class="col-check" checked style="width:14px;height:14px"> ${l}
            </label>`).join('')}
          </div>
          <button onclick="doExport()" style="width:100%;padding:10px;background:#1a1a1a;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer;font-family:inherit">Download CSV</button>
        </div>
      </div>

      <script>
      // ── Selection & Export ─────────────────────────────────────────────────
      const selectedIds = new Set();

      function onCheckChange(cb) {
        const id = cb.dataset.id;
        if (!id) return;
        if (cb.checked) {
          selectedIds.add(id);
          cb.closest('tr').style.background = '#f0f7ff';
        } else {
          selectedIds.delete(id);
          cb.closest('tr').style.background = '';
        }
        updateToolbar();
      }

      function updateToolbar() {
        const toolbar = document.getElementById('export-toolbar');
        const count = selectedIds.size;
        document.getElementById('selected-count').textContent = count.toLocaleString();
        toolbar.style.display = count > 0 ? 'flex' : 'none';
      }

      function clearSelection() {
        selectedIds.clear();
        document.querySelectorAll('.row-check').forEach(cb => {
          cb.checked = false;
          if (cb.closest('tr')) cb.closest('tr').style.background = '';
        });
        const sa = document.getElementById('select-all');
        if (sa) sa.checked = false;
        updateToolbar();
      }

      // ── Event delegation — works regardless of when script runs ───────────
      document.addEventListener('change', function(e) {
        if (e.target.id === 'select-all') {
          const checked = e.target.checked;
          document.querySelectorAll('.row-check').forEach(cb => {
            cb.checked = checked;
            const id = cb.dataset.id;
            if (!id) return;
            if (checked) {
              selectedIds.add(id);
              cb.closest('tr').style.background = '#f0f7ff';
            } else {
              selectedIds.delete(id);
              cb.closest('tr').style.background = '';
            }
          });
          updateToolbar();
        }
        if (e.target.classList.contains('row-check')) {
          onCheckChange(e.target);
        }
      });

      // Row click (not on checkbox) toggles checkbox
      document.addEventListener('click', function(e) {
        const tr = e.target.closest('tr[data-id]');
        if (!tr) return;
        if (e.target.type === 'checkbox' || e.target.closest('a')) return;
        const cb = tr.querySelector('.row-check');
        if (!cb) return;
        cb.checked = !cb.checked;
        onCheckChange(cb);
      });

      // ── Export logic ───────────────────────────────────────────────────────
      function openExportModal() {
        document.getElementById('export-modal').classList.add('open');
      }

      function checkAll(val) {
        document.querySelectorAll('.col-check').forEach(cb => cb.checked = val);
      }

      async function doExport() {
        const cols = [...document.querySelectorAll('.col-check:checked')].map(cb => cb.value);
        if (!cols.length) { alert('Select at least one column.'); return; }
        const ids = [...selectedIds];
        if (!ids.length) { alert('No records selected.'); return; }
        const btn = document.querySelector('[onclick="doExport()"]');
        if (btn) { btn.textContent = 'Downloading…'; btn.disabled = true; }
        try {
          const res = await fetch('/records/export', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids, columns: cols })
          });
          if (!res.ok) { alert('Export failed.'); return; }
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = 'loki_export_' + new Date().toISOString().split('T')[0] + '.csv';
          a.click(); URL.revokeObjectURL(url);
          document.getElementById('export-modal').classList.remove('open');
        } catch(e) { alert('Export failed: ' + e.message); }
        finally { if (btn) { btn.textContent = 'Download CSV'; btn.disabled = false; } }
      }
      </script>

      <!-- Export toolbar -->
      <div id="export-toolbar" style="display:none;background:#1a1a1a;color:#fff;border-radius:10px;padding:10px 16px;margin-bottom:10px;align-items:center;justify-content:space-between;gap:12px">
        <div style="font-size:13px"><span id="selected-count">0</span> records selected</div>
        <div style="display:flex;gap:8px">
          <button onclick="clearSelection()" style="padding:6px 12px;background:transparent;color:#aaa;border:1px solid #444;border-radius:7px;font-size:12px;cursor:pointer;font-family:inherit">Clear</button>
          <button onclick="openExportModal()" style="padding:6px 14px;background:#fff;color:#1a1a1a;border:none;border-radius:7px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">⬇ Export CSV</button>
        </div>
      </div>

      <div class="card" style="padding:0;overflow:hidden">
        <table class="data-table">
          <thead><tr>
            <th style="width:36px;padding-left:14px"><input type="checkbox" id="select-all" style="cursor:pointer;width:15px;height:15px" title="Select all"></th>
            <th>Address</th>
            <th>Owner</th>
            <th>Type</th>
            <th>Phones</th>
            <th>Lists</th>
            <th>Stage</th>
            <th>Added</th>
          </tr></thead>
          <tbody>
            ${tableRows || '<tr><td colspan="8" class="empty-state">No records found</td></tr>'}
          </tbody>
        </table>
      </div>
      ${pagination}
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
    const { ids, columns } = req.body;
    if (!ids || !ids.length) return res.status(400).json({ error: 'No IDs provided' });
    if (!columns || !columns.length) return res.status(400).json({ error: 'No columns selected' });

    // Fetch full property data for selected IDs
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
    const props = await query(`
      SELECT
        p.id, p.street, p.city, p.state_code, p.zip_code, p.county,
        p.property_type, p.year_built, p.sqft, p.bedrooms, p.bathrooms,
        p.assessed_value, p.estimated_value, p.equity_percent,
        p.property_status, p.pipeline_stage, p.condition,
        p.last_sale_date, p.last_sale_price, p.marketing_result,
        p.source, p.created_at,
        c.first_name, c.last_name,
        c.mailing_address, c.mailing_city, c.mailing_state, c.mailing_zip,
        (SELECT COUNT(*) FROM property_lists pl WHERE pl.property_id = p.id) AS list_count
      FROM properties p
      LEFT JOIN property_contacts pc ON pc.property_id = p.id AND pc.primary_contact = true
      LEFT JOIN contacts ct ON ct.id = pc.contact_id
      LEFT JOIN contacts c ON c.id = pc.contact_id
      WHERE p.id IN (${placeholders})
    `, ids);

    // Fetch phones for each property
    const phoneMap = {};
    if (columns.includes('phones')) {
      const phoneRes = await query(`
        SELECT ph.phone_number, ph.phone_index, pc.property_id
        FROM phones ph
        JOIN property_contacts pc ON pc.contact_id = ph.contact_id
        WHERE pc.property_id IN (${placeholders})
        ORDER BY ph.phone_index ASC
      `, ids);
      phoneRes.rows.forEach(ph => {
        if (!phoneMap[ph.property_id]) phoneMap[ph.property_id] = [];
        phoneMap[ph.property_id].push(ph.phone_number);
      });
    }

    // Column label map
    const colLabels = {
      street: 'Street Address', city: 'City', state_code: 'State', zip_code: 'ZIP', county: 'County',
      first_name: 'Owner First Name', last_name: 'Owner Last Name',
      mailing_address: 'Mailing Address', mailing_city: 'Mailing City',
      mailing_state: 'Mailing State', mailing_zip: 'Mailing ZIP',
      phones: 'Phones',
      property_type: 'Property Type', year_built: 'Year Built', sqft: 'Sq Ft',
      bedrooms: 'Bedrooms', bathrooms: 'Bathrooms',
      assessed_value: 'Assessed Value', estimated_value: 'Est. Value', equity_percent: 'Equity %',
      property_status: 'Property Status', pipeline_stage: 'Pipeline Stage', condition: 'Condition',
      last_sale_date: 'Last Sale Date', last_sale_price: 'Last Sale Price',
      marketing_result: 'Marketing Result', source: 'Source',
      list_count: 'Lists Count', created_at: 'Date Added',
    };

    // Build CSV
    const headers = columns.map(k => colLabels[k] || k);
    const csvRows = props.rows.map(row => {
      return columns.map(col => {
        let val = '';
        if (col === 'phones') {
          val = (phoneMap[row.id] || []).join(' | ');
        } else if (col === 'last_sale_date' || col === 'created_at') {
          val = row[col] ? new Date(row[col]).toLocaleDateString('en-US') : '';
        } else {
          val = row[col] !== null && row[col] !== undefined ? String(row[col]) : '';
        }
        return `"${val.replace(/"/g, '""')}"`;
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
router.get('/:id', requireAuth, async (req, res) => {
  try {
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
router.post('/:id/edit', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      property_type, condition, bedrooms, bathrooms, sqft, year_built,
      estimated_value, vacant, last_sale_date, last_sale_price, source,
      property_status, assessed_value, equity_percent, marketing_result,
      contact_id, first_name, last_name, mailing_address, mailing_city,
      mailing_state, edit_notes
    } = req.body;

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
        updated_at = NOW()
      WHERE id = $16
    `, [property_type, condition, bedrooms||'', bathrooms||'', sqft||'', year_built||'',
        estimated_value||'', vacant||'', last_sale_date||'', last_sale_price||'', source,
        property_status||'', assessed_value||'', equity_percent||'', marketing_result||'', id]);

    updated.push('property fields');

    if (contact_id) {
      await query(`
        UPDATE contacts SET
          first_name = COALESCE(NULLIF($1,''), first_name),
          last_name = COALESCE(NULLIF($2,''), last_name),
          mailing_address = COALESCE(NULLIF($3,''), mailing_address),
          mailing_city = COALESCE(NULLIF($4,''), mailing_city),
          mailing_state = COALESCE(NULLIF($5,''), mailing_state),
          updated_at = NOW()
        WHERE id = $6
      `, [first_name, last_name, mailing_address, mailing_city, mailing_state, contact_id]);
      updated.push('owner info');
    }

    // Log to import history
    await query(`
      INSERT INTO import_history (property_id, source, imported_by, fields_updated, notes)
      VALUES ($1, 'Manual Edit', $2, $3, $4)
    `, [id, req.session.username || 'admin', updated.join(', '), edit_notes || null]);

    res.redirect(`/records/${id}?msg=saved`);
  } catch (e) {
    console.error(e);
    res.redirect(`/records/${req.params.id}?msg=error`);
  }
});

module.exports = router;

module.exports = router;
module.exports.shellFn = shell;
