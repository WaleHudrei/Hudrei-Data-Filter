// Changelog module — version history shown in /changelog
// Add new entries to the TOP of the entries array as you ship features.

const ENTRIES = [
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

// Render the changelog page body. Caller wraps it in shell().
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
