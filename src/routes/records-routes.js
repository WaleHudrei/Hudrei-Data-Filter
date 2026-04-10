const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { shell } = require('../ui/shell');

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.redirect('/login');
}

// ── Records list ──────────────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 50;
    const offset = (page - 1) * limit;
    const search = req.query.q || '';
    const stateFilter = req.query.state || '';
    const statusFilter = req.query.status || '';

    let where = ['1=1'];
    let params = [];
    let i = 1;

    if (search) {
      where.push(`(
        p.street ILIKE $${i} OR p.city ILIKE $${i} OR
        c.first_name ILIKE $${i} OR c.last_name ILIKE $${i}
      )`);
      params.push(`%${search}%`);
      i++;
    }
    if (stateFilter) { where.push(`p.state_code = $${i}`); params.push(stateFilter); i++; }
    if (statusFilter) { where.push(`p.pipeline_stage = $${i}`); params.push(statusFilter); i++; }

    const whereStr = where.join(' AND ');

    const countRes = await query(`
      SELECT COUNT(DISTINCT p.id) FROM properties p
      LEFT JOIN property_contacts pc ON pc.property_id = p.id AND pc.primary_contact = true
      LEFT JOIN contacts c ON c.id = pc.contact_id
      WHERE ${whereStr}`, params);

    const total = parseInt(countRes.rows[0].count);
    const totalPages = Math.ceil(total / limit);

    const rows = await query(`
      SELECT
        p.id, p.street, p.city, p.state_code, p.zip_code,
        p.pipeline_stage, p.created_at, p.updated_at,
        c.first_name, c.last_name,
        c.email,
        (SELECT COUNT(*) FROM property_lists pl WHERE pl.property_id = p.id) as list_count,
        (SELECT COUNT(*) FROM phones ph
          JOIN property_contacts pc2 ON pc2.contact_id = ph.contact_id
          WHERE pc2.property_id = p.id) as phone_count,
        (SELECT MAX(cl.call_date) FROM call_logs cl WHERE cl.property_id = p.id) as last_called
      FROM properties p
      LEFT JOIN property_contacts pc ON pc.property_id = p.id AND pc.primary_contact = true
      LEFT JOIN contacts c ON c.id = pc.contact_id
      WHERE ${whereStr}
      ORDER BY p.updated_at DESC
      LIMIT $${i} OFFSET $${i+1}`,
      [...params, limit, offset]);

    // Get states for filter dropdown
    const states = await query(`SELECT DISTINCT state_code FROM properties ORDER BY state_code`);
    const stages = await query(`SELECT DISTINCT pipeline_stage FROM properties ORDER BY pipeline_stage`);

    res.send(recordsPage(rows.rows, total, page, totalPages, search, stateFilter, statusFilter, states.rows, stages.rows));
  } catch (e) {
    res.status(500).send('Error: ' + e.message);
  }
});

// ── Record detail ─────────────────────────────────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const id = req.params.id;

    const propRes = await query(`SELECT * FROM properties WHERE id = $1`, [id]);
    if (!propRes.rows.length) return res.redirect('/records');
    const p = propRes.rows[0];

    const contacts = await query(`
      SELECT c.*, pc.role, pc.primary_contact FROM contacts c
      JOIN property_contacts pc ON pc.contact_id = c.id
      WHERE pc.property_id = $1 ORDER BY pc.primary_contact DESC`, [id]);

    const phones = await query(`
      SELECT ph.*, c.first_name, c.last_name FROM phones ph
      JOIN contacts c ON c.id = ph.contact_id
      JOIN property_contacts pc ON pc.contact_id = ph.contact_id
      WHERE pc.property_id = $1 ORDER BY ph.phone_index`, [id]);

    const lists = await query(`
      SELECT l.list_name, pl.added_at FROM lists l
      JOIN property_lists pl ON pl.list_id = l.id
      WHERE pl.property_id = $1 ORDER BY pl.added_at DESC`, [id]);

    const callHistory = await query(`
      SELECT cl.*, ph.phone_number FROM call_logs cl
      LEFT JOIN phones ph ON ph.id = cl.phone_id
      WHERE cl.property_id = $1 ORDER BY cl.call_date DESC LIMIT 30`, [id]);

    const campaigns = await query(`
      SELECT DISTINCT cn.campaign_id, ca.name, cn.current_status, cn.cumulative_count, cn.last_disposition
      FROM campaign_numbers cn
      JOIN campaigns ca ON ca.id = cn.campaign_id
      JOIN phones ph ON ph.phone_number = cn.phone_number
      JOIN property_contacts pc ON pc.contact_id = ph.contact_id
      WHERE pc.property_id = $1`, [id]);

    res.send(recordDetailPage(p, contacts.rows, phones.rows, lists.rows, callHistory.rows, campaigns.rows));
  } catch (e) {
    res.status(500).send('Error: ' + e.message);
  }
});

// ── Update pipeline stage ─────────────────────────────────────────────────────
router.post('/:id/stage', requireAuth, async (req, res) => {
  await query(`UPDATE properties SET pipeline_stage=$1, updated_at=NOW() WHERE id=$2`, [req.body.stage, req.params.id]);
  res.redirect('/records/' + req.params.id);
});

// ── HTML Pages ────────────────────────────────────────────────────────────────

const STAGE_COLORS = {
  prospect: '#888', lead: '#2471a3', appointment: '#9a6800',
  offer: '#854F0B', contract: '#0F6E56', closed: '#1a7a4a', dead: '#c0392b'
};

function stageBadge(stage) {
  const color = STAGE_COLORS[stage] || '#888';
  return `<span style="display:inline-block;font-size:11px;padding:2px 8px;border-radius:4px;font-weight:500;background:${color}18;color:${color}">${stage||'prospect'}</span>`;
}

function recordsPage(rows, total, page, totalPages, search, stateFilter, statusFilter, states, stages) {
  const params = new URLSearchParams({ q: search, state: stateFilter, status: statusFilter });

  const tableRows = rows.map(r => {
    const owner = [r.first_name, r.last_name].filter(Boolean).join(' ') || '—';
    const addr = `${r.street}, ${r.city}, ${r.state_code} ${r.zip_code}`;
    const lastCalled = r.last_called ? new Date(r.last_called).toLocaleDateString() : '—';
    return `<tr onclick="location.href='/records/${r.id}'" style="cursor:pointer">
      <td><div style="font-weight:500;color:#1a1a1a">${owner}</div><div style="font-size:11px;color:#888">${r.email||'—'}</div></td>
      <td><div>${r.street}</div><div style="font-size:11px;color:#888">${r.city}, ${r.state_code} ${r.zip_code}</div></td>
      <td style="font-size:12px;color:#888">${addr}</td>
      <td>${stageBadge(r.pipeline_stage)}</td>
      <td style="text-align:center;font-size:13px">${r.list_count||0}</td>
      <td style="text-align:center;font-size:13px">${r.phone_count||0}</td>
      <td style="font-size:11px;color:#888">${lastCalled}</td>
    </tr>`;
  }).join('');

  const stateOptions = states.map(s => `<option value="${s.state_code}" ${stateFilter===s.state_code?'selected':''}>${s.state_code}</option>`).join('');
  const stageOptions = stages.map(s => `<option value="${s.pipeline_stage}" ${statusFilter===s.pipeline_stage?'selected':''}>${s.pipeline_stage}</option>`).join('');

  const paginationPages = [];
  for (let i = Math.max(1, page-2); i <= Math.min(totalPages, page+2); i++) {
    const p2 = new URLSearchParams({ q: search, state: stateFilter, status: statusFilter, page: i });
    paginationPages.push(`<a href="/records?${p2}" style="display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:6px;font-size:13px;text-decoration:none;${i===page?'background:#1a1a1a;color:#fff':'background:#fff;color:#1a1a1a;border:1px solid #ddd'}">${i}</a>`);
  }

  return shell('Records', `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.25rem;flex-wrap:wrap;gap:10px">
      <div>
        <h2 style="font-size:20px;font-weight:500;margin-bottom:2px">Property Records</h2>
        <p style="font-size:13px;color:#888">${total.toLocaleString()} total records</p>
      </div>
      <a href="/upload/property" style="display:inline-flex;align-items:center;gap:6px;padding:8px 16px;background:#1a1a1a;color:#fff;border-radius:8px;font-size:13px;font-weight:500;text-decoration:none">
        <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Add Records
      </a>
    </div>

    <div style="display:flex;gap:8px;margin-bottom:1.25rem;flex-wrap:wrap">
      <form method="GET" action="/records" style="display:flex;gap:8px;flex-wrap:wrap;width:100%">
        <input type="text" name="q" value="${search}" placeholder="Search owner name or address…" style="flex:1;min-width:200px;padding:8px 12px;border:1px solid #ddd;border-radius:8px;font-size:13px;background:#fff;font-family:inherit">
        <select name="state" style="padding:8px 12px;border:1px solid #ddd;border-radius:8px;font-size:13px;background:#fff;font-family:inherit">
          <option value="">All states</option>
          ${stateOptions}
        </select>
        <select name="status" style="padding:8px 12px;border:1px solid #ddd;border-radius:8px;font-size:13px;background:#fff;font-family:inherit">
          <option value="">All stages</option>
          ${stageOptions}
        </select>
        <button type="submit" style="padding:8px 16px;background:#1a1a1a;color:#fff;border:none;border-radius:8px;font-size:13px;cursor:pointer;font-family:inherit">Search</button>
        ${search||stateFilter||statusFilter?`<a href="/records" style="padding:8px 14px;border:1px solid #ddd;background:#fff;color:#888;border-radius:8px;font-size:13px;text-decoration:none">Clear</a>`:''}
      </form>
    </div>

    <div class="card" style="padding:0;overflow:hidden">
      <div style="overflow-x:auto">
        <table class="data-table" style="min-width:700px">
          <thead>
            <tr>
              <th>Owner</th>
              <th>Property address</th>
              <th>Mailing address</th>
              <th>Stage</th>
              <th style="text-align:center">Lists</th>
              <th style="text-align:center">Phones</th>
              <th>Last called</th>
            </tr>
          </thead>
          <tbody>
            ${rows.length ? tableRows : '<tr><td colspan="7" style="text-align:center;padding:3rem;color:#aaa">No records found. Upload a property list to get started.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>

    ${totalPages > 1 ? `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-top:1rem;flex-wrap:wrap;gap:8px">
      <div style="font-size:13px;color:#888">Page ${page} of ${totalPages}</div>
      <div style="display:flex;gap:4px">
        ${page>1?`<a href="/records?${new URLSearchParams({q:search,state:stateFilter,status:statusFilter,page:page-1})}" style="display:inline-flex;align-items:center;padding:6px 12px;border:1px solid #ddd;background:#fff;color:#1a1a1a;border-radius:6px;font-size:13px;text-decoration:none">← Prev</a>`:''}
        ${paginationPages.join('')}
        ${page<totalPages?`<a href="/records?${new URLSearchParams({q:search,state:stateFilter,status:statusFilter,page:page+1})}" style="display:inline-flex;align-items:center;padding:6px 12px;border:1px solid #ddd;background:#fff;color:#1a1a1a;border-radius:6px;font-size:13px;text-decoration:none">Next →</a>`:''}
      </div>
    </div>` : ''}
  `, 'records');
}

function recordDetailPage(p, contacts, phones, lists, callHistory, campaigns) {
  const primaryContact = contacts.find(c => c.primary_contact) || contacts[0] || {};
  const ownerName = [primaryContact.first_name, primaryContact.last_name].filter(Boolean).join(' ') || 'Unknown Owner';

  const phoneRows = phones.map(ph => `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f5f4f0">
      <div>
        <div style="font-size:13px;font-weight:500">${ph.phone_number}</div>
        <div style="font-size:11px;color:#888">${ph.first_name} ${ph.last_name}</div>
      </div>
      <div style="display:flex;gap:6px;align-items:center">
        ${ph.phone_tag ? `<span style="font-size:11px;padding:2px 7px;background:#faeeda;color:#854F0B;border-radius:4px">${ph.phone_tag}</span>` : ''}
        ${ph.phone_status ? `<span style="font-size:11px;padding:2px 7px;background:${ph.phone_status==='Wrong'?'#fdf0f0':'#e8f5ee'};color:${ph.phone_status==='Wrong'?'#c0392b':'#1a7a4a'};border-radius:4px">${ph.phone_status}</span>` : ''}
      </div>
    </div>`).join('');

  const callRows = callHistory.map(cl => `
    <tr>
      <td style="font-size:11px;color:#888">${cl.call_date ? new Date(cl.call_date).toLocaleDateString() : '—'}</td>
      <td>${cl.phone_number||'—'}</td>
      <td><span style="font-size:11px;padding:2px 7px;background:#f5f4f0;border-radius:4px">${cl.disposition||'—'}</span></td>
      <td style="font-size:12px;color:#888">${cl.campaign_name||'—'}</td>
    </tr>`).join('');

  const listRows = lists.map(l => `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:7px 0;border-bottom:1px solid #f5f4f0">
      <div style="font-size:13px">${l.list_name}</div>
      <div style="font-size:11px;color:#888">${new Date(l.added_at).toLocaleDateString()}</div>
    </div>`).join('');

  const campaignRows = campaigns.map(c => `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:7px 0;border-bottom:1px solid #f5f4f0">
      <a href="/campaigns/${c.campaign_id}" style="font-size:13px;color:#2471a3;text-decoration:none">${c.name}</a>
      <div style="display:flex;gap:6px;align-items:center">
        <span style="font-size:11px;color:#888">${c.cumulative_count} calls</span>
        <span style="font-size:11px;padding:2px 7px;background:#f5f4f0;border-radius:4px">${c.last_disposition||'—'}</span>
      </div>
    </div>`).join('');

  return shell(ownerName, `
    <div style="margin-bottom:1rem;display:flex;align-items:center;gap:8px">
      <a href="/records" style="font-size:13px;color:#888;text-decoration:none">← Records</a>
    </div>

    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:1.5rem;flex-wrap:wrap;gap:12px">
      <div style="display:flex;align-items:center;gap:14px">
        <div style="width:48px;height:48px;border-radius:50%;background:#f0efe9;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:500;color:#888">
          ${(primaryContact.first_name||'?')[0]}${(primaryContact.last_name||'')[0]||''}
        </div>
        <div>
          <h2 style="font-size:20px;font-weight:500;margin-bottom:3px">${ownerName}</h2>
          <p style="font-size:13px;color:#888">${p.street}, ${p.city}, ${p.state_code} ${p.zip_code}</p>
        </div>
      </div>
      <form method="POST" action="/records/${p.id}/stage" style="display:inline">
        <select name="stage" onchange="this.form.submit()" style="padding:7px 12px;border:1px solid #ddd;border-radius:8px;font-size:13px;background:#fff;font-family:inherit;cursor:pointer">
          ${['prospect','lead','appointment','offer','contract','closed','dead'].map(s=>`<option value="${s}" ${p.pipeline_stage===s?'selected':''}>${s}</option>`).join('')}
        </select>
      </form>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:1.25rem;margin-bottom:1.25rem">
      <div class="card" style="padding:1rem 1.25rem">
        <div class="sec-lbl" style="margin-bottom:12px">Property info</div>
        <div style="font-size:13px;line-height:2">
          <div style="display:flex;justify-content:space-between"><span style="color:#888">Address</span><span>${p.street}</span></div>
          <div style="display:flex;justify-content:space-between"><span style="color:#888">City</span><span>${p.city}</span></div>
          <div style="display:flex;justify-content:space-between"><span style="color:#888">State</span><span>${p.state_code}</span></div>
          <div style="display:flex;justify-content:space-between"><span style="color:#888">ZIP</span><span>${p.zip_code}</span></div>
          <div style="display:flex;justify-content:space-between"><span style="color:#888">County</span><span>${p.county||'—'}</span></div>
          <div style="display:flex;justify-content:space-between"><span style="color:#888">Stage</span><span>${stageBadge(p.pipeline_stage)}</span></div>
          <div style="display:flex;justify-content:space-between"><span style="color:#888">Added</span><span>${new Date(p.created_at).toLocaleDateString()}</span></div>
        </div>
      </div>

      <div class="card" style="padding:1rem 1.25rem">
        <div class="sec-lbl" style="margin-bottom:12px">Phone numbers (${phones.length})</div>
        ${phones.length ? phoneRows : '<div style="color:#aaa;font-size:13px;padding:8px 0">No phones on record</div>'}
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:1.25rem;margin-bottom:1.25rem">
      <div class="card" style="padding:1rem 1.25rem">
        <div class="sec-lbl" style="margin-bottom:12px">Lists (${lists.length})</div>
        ${lists.length ? listRows : '<div style="color:#aaa;font-size:13px;padding:8px 0">Not on any lists yet</div>'}
      </div>
      <div class="card" style="padding:1rem 1.25rem">
        <div class="sec-lbl" style="margin-bottom:12px">Campaigns (${campaigns.length})</div>
        ${campaigns.length ? campaignRows : '<div style="color:#aaa;font-size:13px;padding:8px 0">Not in any campaigns yet</div>'}
      </div>
    </div>

    <div class="card" style="padding:0;overflow:hidden">
      <div style="padding:12px 16px;border-bottom:1px solid #f0efe9"><div class="sec-lbl">Call history (${callHistory.length})</div></div>
      <table class="data-table">
        <thead><tr><th>Date</th><th>Phone</th><th>Disposition</th><th>Campaign</th></tr></thead>
        <tbody>${callHistory.length ? callRows : '<tr><td colspan="4" style="text-align:center;padding:2rem;color:#aaa">No call history yet</td></tr>'}</tbody>
      </table>
    </div>
  `, 'records');
}

module.exports = router;
