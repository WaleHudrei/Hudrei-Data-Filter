// Records page HTML — Properties tab (slice 1)

function recordsPage({ properties, stats, search, page, pageSize, total, syncMsg }) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const startRow = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const endRow = Math.min(page * pageSize, total);

  const rowsHtml = properties.map(p => `
    <tr>
      <td style="font-weight:500;color:#1a1a1a">${escapeHtml(p.property_address||'')}</td>
      <td>${escapeHtml(p.property_city||'')}</td>
      <td>${escapeHtml(p.property_state||'')}</td>
      <td>${escapeHtml(p.property_zip||'')}</td>
      <td>${escapeHtml(p.owners||'—')}</td>
      <td style="text-align:center">${p.phone_count||0}</td>
      <td style="text-align:center">${p.list_count||0}</td>
    </tr>
  `).join('');

  const emptyState = `
    <tr><td colspan="7" style="text-align:center;padding:40px;color:#888;font-size:13px">
      ${search ? 'No properties match your search.' : 'No properties yet. Click <strong>Sync from campaigns</strong> above to import from your existing contact lists.'}
    </td></tr>
  `;

  // Pagination links
  const qs = (p) => `?page=${p}${search ? '&search=' + encodeURIComponent(search) : ''}`;
  const prevDisabled = page <= 1;
  const nextDisabled = page >= totalPages;

  return `
    <div style="max-width:1200px">
      <h2 style="font-size:20px;font-weight:500;margin-bottom:4px">Records</h2>
      <p style="font-size:13px;color:#888;margin-bottom:1.5rem">Browse your property database.</p>

      ${syncMsg ? `<div style="background:#eaf6ea;border:1px solid #b8e0b8;color:#1a5f1a;padding:12px 16px;border-radius:8px;margin-bottom:1rem;font-size:13px">${escapeHtml(syncMsg)}</div>` : ''}

      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-bottom:1.5rem;max-width:400px">
        <div class="stat-card">
          <div class="stat-lbl">Total properties</div>
          <div class="stat-num">${Number(stats.total_properties||0).toLocaleString()}</div>
        </div>
        <div class="stat-card">
          <div class="stat-lbl">Total owners</div>
          <div class="stat-num">${Number(stats.total_owners||0).toLocaleString()}</div>
        </div>
      </div>

      <div class="card" style="padding:0;overflow:hidden">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid #f0efe9;flex-wrap:wrap;gap:10px">
          <div style="display:flex;gap:4px;background:#f5f4f0;border-radius:8px;padding:3px">
            <div style="padding:7px 16px;background:#fff;border-radius:6px;font-size:13px;font-weight:500;color:#1a1a1a;box-shadow:0 1px 2px rgba(0,0,0,0.04)">Properties</div>
            <div style="padding:7px 16px;font-size:13px;color:#bbb;cursor:not-allowed" title="Coming soon">Owners</div>
            <div style="padding:7px 16px;font-size:13px;color:#bbb;cursor:not-allowed" title="Coming soon">Phones</div>
          </div>
          <form method="POST" action="/records/sync" style="display:inline" onsubmit="return confirm('Sync all campaign contacts into the Records database? This can take a minute on large lists.')">
            <button type="submit" style="font-size:12px;padding:7px 14px;background:#1a1a1a;border:none;border-radius:8px;cursor:pointer;color:#fff;font-family:inherit;font-weight:500">Sync from campaigns</button>
          </form>
        </div>

        <form method="GET" action="/records" style="padding:14px 20px;border-bottom:1px solid #f0efe9">
          <input type="text" name="search" value="${escapeHtml(search||'')}" placeholder="Search by address or city..." style="width:100%;max-width:500px;padding:9px 14px;border:1px solid #ddd;border-radius:8px;font-size:13px;font-family:inherit">
        </form>

        <div style="padding:8px 20px;font-size:12px;color:#888">
          ${total > 0 ? `Showing ${startRow.toLocaleString()}–${endRow.toLocaleString()} of ${total.toLocaleString()} properties` : 'No properties'}
        </div>

        <div style="overflow-x:auto">
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <thead>
              <tr style="background:#fafaf7">
                <th style="text-align:left;padding:10px 14px;font-weight:500;color:#888;font-size:11px;text-transform:uppercase;letter-spacing:0.3px;border-bottom:1px solid #f0efe9">Address</th>
                <th style="text-align:left;padding:10px 14px;font-weight:500;color:#888;font-size:11px;text-transform:uppercase;letter-spacing:0.3px;border-bottom:1px solid #f0efe9">City</th>
                <th style="text-align:left;padding:10px 14px;font-weight:500;color:#888;font-size:11px;text-transform:uppercase;letter-spacing:0.3px;border-bottom:1px solid #f0efe9">State</th>
                <th style="text-align:left;padding:10px 14px;font-weight:500;color:#888;font-size:11px;text-transform:uppercase;letter-spacing:0.3px;border-bottom:1px solid #f0efe9">Zip</th>
                <th style="text-align:left;padding:10px 14px;font-weight:500;color:#888;font-size:11px;text-transform:uppercase;letter-spacing:0.3px;border-bottom:1px solid #f0efe9">Owner(s)</th>
                <th style="text-align:center;padding:10px 14px;font-weight:500;color:#888;font-size:11px;text-transform:uppercase;letter-spacing:0.3px;border-bottom:1px solid #f0efe9">Phones</th>
                <th style="text-align:center;padding:10px 14px;font-weight:500;color:#888;font-size:11px;text-transform:uppercase;letter-spacing:0.3px;border-bottom:1px solid #f0efe9">Lists</th>
              </tr>
            </thead>
            <tbody>
              ${properties.length > 0 ? rowsHtml : emptyState}
            </tbody>
          </table>
        </div>

        ${total > pageSize ? `
          <div style="padding:14px 20px;display:flex;justify-content:space-between;align-items:center;border-top:1px solid #f0efe9;font-size:12px;color:#888">
            <div>Page ${page} of ${totalPages}</div>
            <div style="display:flex;gap:6px">
              ${prevDisabled ? '<span style="padding:6px 12px;color:#ccc">← Prev</span>' : `<a href="${qs(page-1)}" style="padding:6px 12px;color:#1a1a1a;text-decoration:none;border:1px solid #ddd;border-radius:6px">← Prev</a>`}
              ${nextDisabled ? '<span style="padding:6px 12px;color:#ccc">Next →</span>' : `<a href="${qs(page+1)}" style="padding:6px 12px;color:#1a1a1a;text-decoration:none;border:1px solid #ddd;border-radius:6px">Next →</a>`}
            </div>
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

function escapeHtml(s) {
  return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

module.exports = { recordsPage };
