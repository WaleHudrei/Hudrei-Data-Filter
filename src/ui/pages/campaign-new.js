// ═══════════════════════════════════════════════════════════════════════════
// ui/pages/campaign-new.js
// Oculah-styled "New campaign" form. Mirrors the legacy page in server.js
// (newCampaignPage) so the same fields and validation paths apply, but the
// form action posts to /oculah/campaigns/new and the cancel link goes to
// /oculah/campaigns. Logic stays in src/campaigns.js — UNCHANGED.
// ═══════════════════════════════════════════════════════════════════════════
const { shell } = require('../layouts/shell');
const { escHTML } = require('../_helpers');

function campaignNewPage(data = {}) {
  const error = data.error || '';
  const listTypes = (Array.isArray(data.listTypes) && data.listTypes.length)
    ? data.listTypes
    : ['Vacant Property','Pre-Foreclosure','Active Liens','2+ Mortgages','Absentee Owner','Tax Delinquent','Probate','Code Violation','Pre-Probate','Other'];
  const STATES = ['IN','GA','TX','FL','OH','MI','IL','NC','TN','MO','AZ','CO','NV','PA','NY','Other'];
  const today = new Date().toISOString().split('T')[0];

  const body = `
    <div style="margin-bottom:14px"><a href="/oculah/campaigns" class="ocu-text-3" style="font-size:13px;text-decoration:none">← Campaigns</a></div>

    ${error ? `<div class="ocu-card" style="margin-bottom:16px;background:#fdeaea;border-color:#f5c5c5;color:#8b1f1f;padding:12px 16px;font-size:13px;max-width:580px">${escHTML(error)}</div>` : ''}

    <div class="ocu-card" style="max-width:580px;padding:22px 24px">
      <form method="POST" action="/oculah/campaigns/new">
        <div style="margin-bottom:14px">
          <label class="ocu-form-label">Campaign name</label>
          <input type="text" name="name" placeholder="e.g. Vacant Property Indiana 2026" required class="ocu-input" maxlength="255" />
          <div class="ocu-text-3" style="font-size:11px;margin-top:4px">This is what you'll select when uploading filtration files.</div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">
          <div>
            <label class="ocu-form-label">List type</label>
            <select name="list_type" id="list_type_select" class="ocu-input"
                    onchange="document.getElementById('custom_lt_wrap').style.display=this.value==='__new__'?'block':'none';document.getElementById('custom_lt_input').required=this.value==='__new__'">
              <option value="">Select…</option>
              ${listTypes.map(t => `<option value="${escHTML(t)}">${escHTML(t)}</option>`).join('')}
              <option value="__new__">+ Add new list type…</option>
            </select>
            <div id="custom_lt_wrap" style="display:none;margin-top:8px">
              <input type="text" id="custom_lt_input" name="custom_list_type" placeholder="Enter new list type" maxlength="100" class="ocu-input" />
              <div class="ocu-text-3" style="font-size:11px;margin-top:4px">Saved for future campaigns.</div>
            </div>
          </div>
          <div>
            <label class="ocu-form-label">State</label>
            <select name="state_code" required class="ocu-input">
              <option value="">Select…</option>
              ${STATES.map(s => `<option value="${escHTML(s)}">${escHTML(s)}</option>`).join('')}
            </select>
          </div>
        </div>

        <div style="margin-bottom:14px">
          <label class="ocu-form-label">Market name</label>
          <input type="text" name="market_name" placeholder="e.g. Indianapolis Metro" required class="ocu-input" maxlength="100" />
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">
          <div>
            <label class="ocu-form-label">Start date</label>
            <input type="date" name="start_date" value="${today}" class="ocu-input" />
          </div>
          <div>
            <label class="ocu-form-label">Active channel</label>
            <select name="active_channel" class="ocu-input">
              <option value="cold_call">Cold call</option>
              <option value="sms">SMS</option>
            </select>
          </div>
        </div>

        <div style="margin-bottom:18px">
          <label class="ocu-form-label">Notes <span class="ocu-text-3" style="font-weight:400">(optional)</span></label>
          <textarea name="notes" rows="2" placeholder="Any notes about this campaign…" class="ocu-textarea" maxlength="2000"></textarea>
        </div>

        <div style="display:flex;gap:8px;justify-content:flex-end">
          <a href="/oculah/campaigns" class="ocu-btn ocu-btn-ghost">Cancel</a>
          <button type="submit" class="ocu-btn ocu-btn-primary">Create campaign</button>
        </div>
      </form>
    </div>`;

  return shell({
    title:          'New campaign',
    topbarTitle:    'New campaign',
    topbarSubtitle: 'Create a campaign to start tracking filtration activity',
    activePage:     'campaigns',
    user:           data.user,
    badges:         data.badges || {},
    body,
  });
}

module.exports = { campaignNewPage };
