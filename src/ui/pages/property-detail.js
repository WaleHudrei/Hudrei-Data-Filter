// ui/pages/property-detail.js
// Composes the full property detail page using the shell + components.
// Page-specific click handlers live in /ocular-static/detail-actions.js
// (loaded at end of <body> via shell's extraBodyEnd hook).
//
// Write actions wired up:
//   1. Phone status pill click → option popover → save
//   2. Phone type chip click → option popover → save
//   3. Phone tag × → remove
//   4. Phone "+ tag" → inline input → enter → add
//   5. Property tag × → remove
//   6. Property "+ tag" → inline input → enter → add
//   7. Pipeline dropdown change → auto-save
//
// All handlers POST to existing Loki endpoints under /records/* — see
// detail-actions.js for the full list.
const { shell }              = require('../layouts/shell');
const { card }               = require('../components/card');
const { propertyHeader }     = require('../components/property-header');
const { propertyInfo }       = require('../components/property-info');
const { ownerCard }          = require('../components/owner-card');
const { distressBreakdown }  = require('../components/distress-breakdown');
const { tagChips }           = require('../components/tag-chips');
const { listMembership }     = require('../components/list-membership');
const { activityTimeline }   = require('../components/activity-timeline');
const { fmtNum }             = require('../_helpers');

function propertyDetail(data) {
  data = data || {};
  const p = data.property || {};
  const primary = data.primaryContact || null;
  const secondaries = Array.isArray(data.secondaryContacts) ? data.secondaryContacts : [];
  const phones = Array.isArray(data.phones) ? data.phones : [];

  const ownerCards = [
    ownerCard({ contact: primary, phones, label: 'Owner 1', isPrimary: true }),
    ...secondaries.map((sc, i) => ownerCard({
      contact: sc,
      phones: sc.phones || [],
      label: 'Owner ' + (i + 2),
      isPrimary: false,
    })),
  ].filter(Boolean).join('');

  const distressCard = card({
    title: 'Distress score',
    meta: 'Total: ' + fmtNum(p.distress_score || 0),
    body: distressBreakdown({ score: p.distress_score, breakdown: data.distressBreakdown }),
  });

  // Pass propertyId so tag chips render with × buttons + the "+ tag" affordance.
  const tagsCard = card({
    title: 'Tags',
    body: tagChips({ tags: data.tags || [], propertyId: p.id }),
  });

  const listsCard = card({
    title: 'Lists',
    body: listMembership(data.lists || []),
  });

  const activityCard = card({
    title: 'Recent activity',
    meta: 'Calls and SMS · most recent first',
    body: activityTimeline(data.activity || []),
  });

  const propertyInfoCard = card({
    title: 'Property',
    body: propertyInfo(p),
  });

  const body = `
    ${propertyHeader(p)}

    <div class="ocu-detail-grid">
      <div class="ocu-detail-main">
        ${propertyInfoCard}
        <div class="ocu-owner-grid">
          ${ownerCards}
        </div>
      </div>
      <div class="ocu-detail-side">
        ${distressCard}
        ${tagsCard}
        ${listsCard}
      </div>
    </div>

    ${activityCard}
  `;

  const titlePart = p.property_address
    ? p.property_address
    : 'Property #' + (p.id || '');

  return shell({
    title:       titlePart,
    body,
    activePage:  'records',
    user:        data.user || { name: 'User', initials: '?' },
    badges:      data.badges || {},
    // Load the click-handlers bundle. `defer` so it runs after the DOM
    // is parsed, and so it doesn't block initial render.
    extraBodyEnd: '<script src="/ocular-static/detail-actions.js" defer></script>',
  });
}

module.exports = { propertyDetail };
