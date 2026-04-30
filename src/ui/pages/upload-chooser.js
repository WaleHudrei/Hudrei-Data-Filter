// ═══════════════════════════════════════════════════════════════════════════
// ui/pages/upload-chooser.js
// Ocular Upload landing page. Three cards, one per upload type.
//
// The downstream multi-step flows (parse → map → review) still live in the
// old Loki UI under /upload/filter, /import/property, and /import/bulk.
// Porting them is a separate, larger project — those flows have file-upload
// drag/drop, live progress bars, and detailed mapping UIs.
// ═══════════════════════════════════════════════════════════════════════════
const { shell } = require('../layouts/shell');
const { escHTML } = require('../_helpers');

function uploadCard(opts) {
  const { href, title, desc, icon, badge } = opts;
  return `
    <a href="${escHTML(href)}" class="ocu-upload-card">
      <div class="ocu-upload-card-icon">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${icon}</svg>
      </div>
      <div class="ocu-upload-card-title">
        ${escHTML(title)}
        ${badge ? `<span class="ocu-pill ocu-pill-good" style="margin-left:8px">${escHTML(badge)}</span>` : ''}
      </div>
      <div class="ocu-upload-card-desc">${escHTML(desc)}</div>
    </a>`;
}

function uploadChooser(data = {}) {
  const cards = [
    uploadCard({
      href: '/upload/filter',
      title: 'Upload call log',
      desc: 'A Readymode call-log export. We filter it against memory and produce a clean CSV ready for REISift.',
      icon: '<path d="M3 4h18M3 8h18M3 12h12M3 16h8"/>',
    }),
    uploadCard({
      href: '/import/property',
      title: 'Import property list',
      desc: 'A CSV from PropStream, DealMachine, or any other source. Map columns and import into Records.',
      icon: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
    }),
    uploadCard({
      href: '/import/bulk',
      title: 'Bulk import',
      desc: 'A full REISift contacted-lead export. No row limit — streams from disk and handles 700k+ records with live progress.',
      icon: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>',
      badge: 'REISift',
    }),
    uploadCard({
      href: '/nis',
      title: 'Not in Service numbers',
      desc: 'A CSV of disconnected/NIS phone numbers. Cumulative across uploads — once a number is tagged NIS, it stays caught.',
      icon: '<path d="M12 2L4 5v6c0 5 3.5 9 8 11 4.5-2 8-6 8-11V5l-8-3z"/><line x1="4.5" y1="4.5" x2="19.5" y2="19.5"/>',
    }),
  ].join('');

  const body = `
    <div style="display:flex;justify-content:flex-end;margin-bottom:14px">
      <a href="/oculah/activity" class="ocu-btn ocu-btn-secondary">View activity →</a>
    </div>

    <div class="ocu-upload-grid">${cards}</div>`;

  return shell({
    title:          'Upload',
    topbarTitle:    'Upload',
    topbarSubtitle: 'What are you uploading today?',
    activePage:     'upload',
    user:           data.user,
    badges:         data.badges || {},
    body,
  });
}

module.exports = { uploadChooser };
