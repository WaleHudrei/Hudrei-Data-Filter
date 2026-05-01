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

    <div class="ocu-upload-grid">${cards}</div>

    <!-- Page-wide drag overlay. Activates when a file is dragged onto the
         page; on drop, auto-routes to the right uploader based on the
         filename + size heuristics. The user re-drops on the destination
         page (file objects can't be carried across navigation). -->
    <div id="ocu-upload-dragover" class="ocu-upload-dragover" hidden>
      <div class="ocu-upload-dragover-inner">
        <div class="ocu-upload-dragover-icon" aria-hidden="true">
          <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        </div>
        <div class="ocu-upload-dragover-title">Drop your file</div>
        <div class="ocu-upload-dragover-desc">We'll detect the type and route you to the right uploader.</div>
      </div>
    </div>

    <!-- Auto-route confirmation. After a drop we sniff the file and show
         the suggested route here; user can confirm or pick a different
         uploader. The file itself isn't carried — operator re-drops on
         the destination page (a one-step penalty in exchange for not
         building a parallel multipart-upload pipeline on this page). -->
    <dialog id="ocu-upload-route-dialog" class="ocu-dialog">
      <div class="ocu-dialog-header">
        <div class="ocu-dialog-title">Where should this go?</div>
        <button type="button" class="ocu-dialog-close" onclick="document.getElementById('ocu-upload-route-dialog').close()" aria-label="Close">×</button>
      </div>
      <div class="ocu-dialog-body">
        <p class="ocu-card-desc" id="ocu-upload-route-msg">…</p>
        <div class="ocu-upload-route-choices">
          <button type="button" class="ocu-upload-route-choice" data-route="/upload/filter">Call log → REISift</button>
          <button type="button" class="ocu-upload-route-choice" data-route="/import/property">Property list (PropStream / DealMachine)</button>
          <button type="button" class="ocu-upload-route-choice" data-route="/import/bulk">Bulk import (REISift)</button>
          <button type="button" class="ocu-upload-route-choice" data-route="/nis">Not-in-Service numbers</button>
        </div>
      </div>
    </dialog>

    <script>
      (function() {
        var overlay = document.getElementById('ocu-upload-dragover');
        var dialog  = document.getElementById('ocu-upload-route-dialog');
        var msg     = document.getElementById('ocu-upload-route-msg');
        if (!overlay || !dialog || !msg) return;

        // Filename-based routing heuristics. Order matters: NIS check
        // before bulk because a "reisift_nis_export.csv" should go to
        // NIS, not bulk import.
        function suggestRoute(file) {
          var name = (file.name || '').toLowerCase();
          var size = file.size || 0;
          if (/(^|[^a-z])nis|disconnect|not.in.service/.test(name)) {
            return { route: '/nis', label: 'Not-in-Service numbers (filename matches "nis")' };
          }
          if (/calllog|call.log|readymode.*export/.test(name)) {
            return { route: '/upload/filter', label: 'Call log → REISift (filename looks like a Readymode export)' };
          }
          if (/bulk|reisift.*contacted|all.contacted.lead/.test(name) || size > 50 * 1024 * 1024) {
            return { route: '/import/bulk', label: 'Bulk import (filename or size suggests a REISift bulk export)' };
          }
          if (/propstream|dealmachine|property|skip.trace/.test(name)) {
            return { route: '/import/property', label: 'Property list (filename matches a property source)' };
          }
          return { route: '/import/property', label: "We couldn't tell the file type — defaulting to property list. Pick a different one if needed." };
        }

        var dragDepth = 0;
        function isFileDrag(e) {
          if (!e.dataTransfer || !e.dataTransfer.types) return false;
          var t = e.dataTransfer.types;
          // Browsers expose either an array or a DOMStringList; both
          // have indexOf / contains semantics.
          for (var i = 0; i < t.length; i++) if (t[i] === 'Files') return true;
          return false;
        }

        document.addEventListener('dragenter', function(e) {
          if (!isFileDrag(e)) return;
          dragDepth++;
          overlay.hidden = false;
        });
        document.addEventListener('dragover', function(e) {
          if (!isFileDrag(e)) return;
          e.preventDefault();
        });
        document.addEventListener('dragleave', function(e) {
          if (!isFileDrag(e)) return;
          dragDepth = Math.max(0, dragDepth - 1);
          if (dragDepth === 0) overlay.hidden = true;
        });
        document.addEventListener('drop', function(e) {
          if (!isFileDrag(e)) return;
          e.preventDefault();
          dragDepth = 0;
          overlay.hidden = true;

          var f = e.dataTransfer.files && e.dataTransfer.files[0];
          if (!f) return;
          var hint = suggestRoute(f);
          msg.textContent = '"' + f.name + '" — ' + hint.label;
          // Highlight the suggested choice so a single Enter / click confirms.
          dialog.querySelectorAll('.ocu-upload-route-choice').forEach(function(btn) {
            btn.classList.toggle('is-suggested', btn.dataset.route === hint.route);
          });
          dialog.showModal();
        });

        dialog.addEventListener('click', function(e) {
          var btn = e.target.closest && e.target.closest('.ocu-upload-route-choice');
          if (!btn) return;
          var route = btn.dataset.route;
          if (route) window.location.href = route;
        });
      })();
    </script>`;

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
