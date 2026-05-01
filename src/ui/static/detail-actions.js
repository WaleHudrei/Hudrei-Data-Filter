/* ═══════════════════════════════════════════════════════════════════════════
   ui/static/detail-actions.js
   Click handlers for the property detail page.
   Loaded only on /oculah/records/:id pages.

   All actions follow the same pattern:
     1. Listen for click on a [data-action="..."] element via event delegation
     2. Update the DOM optimistically (color change, pill swap, chip removal)
     3. POST to the appropriate endpoint
     4. On error: revert DOM + show toast

   Endpoints used (all reused from records-routes.js — see records/records-routes.js):
     POST   /records/phones/:id/status                  { phone_status }    line 1107
     POST   /records/phones/:id/type                    { phone_type }      line 1088
     POST   /records/phones/:id/tags                    { name }            line 1032
     POST   /records/phones/:phoneId/tags/:tagId/remove                     line 1073
     POST   /records/:id/tags                           { name }            line 1152
     DELETE /records/:id/tags/:tagId                                         line 1197
     POST   /records/:id/pipeline                       { pipeline_stage }  line 1131
   ═══════════════════════════════════════════════════════════════════════════ */
(function() {
  'use strict';

  // ─── Pill option lookups (must mirror owner-card.js exactly) ──────────────
  const STATUS = {
    correct: { label: 'Correct', bg: '#DCFCE7', fg: '#16A34A' },
    wrong:   { label: 'Wrong',   bg: '#FEF3C7', fg: '#D97706' },
    dead:    { label: 'Dead',    bg: '#FEE2E2', fg: '#DC2626' },
    unknown: { label: 'Unknown', bg: '#F3F4F6', fg: '#6B7280' },
  };
  const TYPE = {
    mobile:   { label: 'Mobile',   bg: '#E0F2FE', fg: '#0369A1' },
    landline: { label: 'Landline', bg: '#EDE9FE', fg: '#6D28D9' },
    voip:     { label: 'VoIP',     bg: '#FEF3C7', fg: '#92400E' },
    unknown:  { label: 'Type ?',   bg: '#F3F4F6', fg: '#6B7280' },
  };

  // ─── Toast helper ─────────────────────────────────────────────────────────
  let toastTimer = null;
  function toast(msg, isError) {
    let t = document.getElementById('ocu-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'ocu-toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.className = 'ocu-toast' + (isError ? ' err' : ' ok');
    t.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.style.opacity = '0'; }, 2400);
  }

  // ─── Fetch helper with JSON ──────────────────────────────────────────────
  async function jpost(url, body, method) {
    const res = await fetch(url, {
      method: method || 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (_) { /* non-JSON response, leave null */ }
    if (!res.ok) {
      const msg = (data && data.error) || ('HTTP ' + res.status);
      throw new Error(msg);
    }
    return data;
  }

  // ─── Popover for picking from a small set of options ──────────────────────
  // Used for phone status + phone type. Returns a promise that resolves to
  // the picked value, or null if dismissed.
  function showOptionPopover(anchor, options, current) {
    return new Promise(resolve => {
      // Tear down any existing popover first
      document.querySelectorAll('.ocu-popover').forEach(el => el.remove());

      const pop = document.createElement('div');
      pop.className = 'ocu-popover';
      pop.innerHTML = options.map(o =>
        `<button type="button" class="ocu-popover-opt${o.value === current ? ' active' : ''}" data-value="${o.value}" style="background:${o.bg};color:${o.fg}">${o.label}</button>`
      ).join('');
      document.body.appendChild(pop);

      // Position below the anchor
      const r = anchor.getBoundingClientRect();
      pop.style.left = (r.left + window.scrollX) + 'px';
      pop.style.top  = (r.bottom + window.scrollY + 4) + 'px';

      let resolved = false;
      function cleanup(value) {
        if (resolved) return;
        resolved = true;
        pop.remove();
        document.removeEventListener('click', onDocClick, true);
        document.removeEventListener('keydown', onKey);
        resolve(value);
      }
      function onDocClick(e) {
        if (pop.contains(e.target)) {
          const btn = e.target.closest('.ocu-popover-opt');
          if (btn) cleanup(btn.dataset.value);
        } else {
          cleanup(null);
        }
      }
      function onKey(e) { if (e.key === 'Escape') cleanup(null); }

      // setTimeout so the click that opened the popover doesn't immediately close it
      setTimeout(() => {
        document.addEventListener('click', onDocClick, true);
        document.addEventListener('keydown', onKey);
      }, 0);
    });
  }

  // ─── Inline text input for tag name with autocomplete dropdown ──────────
  // Replaces a "+ tag" button with an input + suggestions popover. Returns
  // a promise that resolves to the trimmed name (or null if cancelled).
  // The autocomplete fetches /records/tags/suggest as the user types and
  // accepts either a click on a suggestion or Enter on whatever's typed
  // (so creating a brand-new tag still works — same as before, just less
  // painful at 100+ tags).
  function promptTagName(anchorBtn, opts = {}) {
    const suggestUrl = opts.suggestUrl || '/records/tags/suggest';
    return new Promise(resolve => {
      const wrap = document.createElement('span');
      wrap.className = 'ocu-tag-input-wrap';
      wrap.style.position = 'relative';
      wrap.style.display = 'inline-block';

      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'Search or create tag…';
      input.className = 'ocu-tag-input';
      input.maxLength = 100;
      input.autocomplete = 'off';

      const dropdown = document.createElement('div');
      dropdown.className = 'ocu-tag-suggest';
      dropdown.style.cssText = 'position:absolute;top:100%;left:0;min-width:200px;background:var(--ocu-bg);border:1px solid var(--ocu-border-strong);border-radius:6px;box-shadow:0 4px 12px rgba(11,18,32,0.08);margin-top:2px;z-index:50;max-height:240px;overflow-y:auto;display:none';

      wrap.appendChild(input);
      wrap.appendChild(dropdown);
      anchorBtn.style.display = 'none';
      anchorBtn.parentNode.insertBefore(wrap, anchorBtn);
      input.focus();

      let resolved = false;
      let suggestSeq = 0;
      let highlight = -1;
      let lastSuggestions = [];

      function done(value) {
        if (resolved) return;
        resolved = true;
        wrap.remove();
        anchorBtn.style.display = '';
        resolve(value);
      }

      function renderSuggestions(rows) {
        lastSuggestions = rows || [];
        if (!lastSuggestions.length) {
          dropdown.style.display = 'none';
          return;
        }
        const typed = input.value.trim().toLowerCase();
        const exactMatch = lastSuggestions.some(r => r.name.toLowerCase() === typed);
        dropdown.innerHTML = lastSuggestions.map((r, i) =>
          '<div class="ocu-tag-suggest-item" data-idx="' + i + '" style="padding:7px 10px;cursor:pointer;font-size:13px;' + (i === highlight ? 'background:var(--ocu-surface)' : '') + '">' +
          '<span style="font-weight:500;color:var(--ocu-text-1)">' + escapeHTML(r.name) + '</span>' +
          '</div>'
        ).join('') + (typed && !exactMatch
          ? '<div class="ocu-tag-suggest-create" data-idx="-1" style="padding:7px 10px;cursor:pointer;font-size:13px;border-top:1px solid var(--ocu-border);color:var(--ocu-text-3)">+ Create &ldquo;' + escapeHTML(typed) + '&rdquo;</div>'
          : '');
        dropdown.style.display = 'block';
      }

      function fetchSuggestions(q) {
        const seq = ++suggestSeq;
        fetch(suggestUrl + (q ? '?q=' + encodeURIComponent(q) : ''), { credentials: 'same-origin' })
          .then(r => r.ok ? r.json() : [])
          .then(rows => {
            if (seq !== suggestSeq) return; // stale request
            highlight = -1;
            renderSuggestions(Array.isArray(rows) ? rows : []);
          })
          .catch(() => { /* non-fatal */ });
      }

      function escapeHTML(s) {
        return String(s == null ? '' : s)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      }

      // Click handler — picks suggestion or creates a new one
      dropdown.addEventListener('mousedown', e => {
        // mousedown (not click) so the input's blur handler doesn't fire first
        const item = e.target.closest('[data-idx]');
        if (!item) return;
        e.preventDefault();
        const idx = parseInt(item.dataset.idx, 10);
        const value = idx >= 0 ? lastSuggestions[idx].name : input.value.trim();
        done(value || null);
      });

      input.addEventListener('input', () => fetchSuggestions(input.value.trim()));
      input.addEventListener('focus', () => fetchSuggestions(input.value.trim()));
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (highlight >= 0 && lastSuggestions[highlight]) {
            done(lastSuggestions[highlight].name);
          } else {
            const v = input.value.trim();
            done(v || null);
          }
        } else if (e.key === 'Escape') {
          done(null);
        } else if (e.key === 'ArrowDown' && lastSuggestions.length) {
          e.preventDefault();
          highlight = Math.min(highlight + 1, lastSuggestions.length - 1);
          renderSuggestions(lastSuggestions);
        } else if (e.key === 'ArrowUp' && lastSuggestions.length) {
          e.preventDefault();
          highlight = Math.max(highlight - 1, -1);
          renderSuggestions(lastSuggestions);
        }
      });
      // Close on blur — but delay so dropdown clicks land first.
      input.addEventListener('blur', () => {
        setTimeout(() => done(input.value.trim() || null), 120);
      });

      fetchSuggestions(''); // prime the dropdown with top-50 on focus
    });
  }

  // ─── Click delegation ─────────────────────────────────────────────────────
  document.addEventListener('click', async function(e) {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;

    // ── Phone status pill ──────────────────────────────────────────────────
    if (action === 'phone-status') {
      e.stopPropagation();
      const phoneId = target.dataset.phoneId;
      const current = target.dataset.current;
      const opts = Object.entries(STATUS).map(([v, o]) => ({ value: v, ...o }));
      const picked = await showOptionPopover(target, opts, current);
      if (!picked || picked === current) return;
      // Optimistic: swap pill immediately
      const prev = { current, label: target.textContent, bg: target.style.background, color: target.style.color };
      const next = STATUS[picked];
      target.dataset.current = picked;
      target.textContent = next.label;
      target.style.background = next.bg;
      target.style.color = next.fg;
      try {
        await jpost('/records/phones/' + phoneId + '/status', { phone_status: picked });
        toast('Status updated', false);
      } catch (err) {
        // Revert
        target.dataset.current = prev.current;
        target.textContent = prev.label;
        target.style.background = prev.bg;
        target.style.color = prev.color;
        toast('Failed to update status: ' + err.message, true);
      }
      return;
    }

    // ── Phone type chip ────────────────────────────────────────────────────
    if (action === 'phone-type') {
      e.stopPropagation();
      const phoneId = target.dataset.phoneId;
      const current = target.dataset.current;
      const opts = Object.entries(TYPE).map(([v, o]) => ({ value: v, ...o }));
      const picked = await showOptionPopover(target, opts, current);
      if (!picked || picked === current) return;
      const prev = { current, label: target.textContent, bg: target.style.background, color: target.style.color };
      const next = TYPE[picked];
      target.dataset.current = picked;
      target.textContent = next.label;
      target.style.background = next.bg;
      target.style.color = next.fg;
      try {
        await jpost('/records/phones/' + phoneId + '/type', { phone_type: picked });
        toast('Type updated', false);
      } catch (err) {
        target.dataset.current = prev.current;
        target.textContent = prev.label;
        target.style.background = prev.bg;
        target.style.color = prev.color;
        toast('Failed to update type: ' + err.message, true);
      }
      return;
    }

    // ── Phone tag remove ───────────────────────────────────────────────────
    if (action === 'phone-tag-remove') {
      e.stopPropagation();
      const phoneId = target.dataset.phoneId;
      const tagId = target.dataset.tagId;
      const pill = target.closest('.ocu-tag-pill');
      const parent = pill && pill.parentNode;
      const sibling = pill && pill.nextSibling;
      // Optimistic remove
      if (pill) pill.remove();
      try {
        await jpost('/records/phones/' + phoneId + '/tags/' + tagId + '/remove');
        toast('Tag removed', false);
      } catch (err) {
        // Revert
        if (pill && parent) parent.insertBefore(pill, sibling);
        toast('Failed to remove tag: ' + err.message, true);
      }
      return;
    }

    // ── Phone tag add ──────────────────────────────────────────────────────
    if (action === 'phone-tag-add') {
      e.stopPropagation();
      const phoneId = target.dataset.phoneId;
      // Phone tags live in their own pool, so target the phone-tag suggest
      // endpoint instead of the property-tag one.
      const name = await promptTagName(target, { suggestUrl: '/records/phone-tags/suggest' });
      if (!name) return;
      try {
        const data = await jpost('/records/phones/' + phoneId + '/tags', { name });
        if (data && data.tag) {
          // Insert the new tag pill before the "+ tag" button
          const tag = data.tag;
          const c = tag.color || '#6B7280';
          const html = '<span class="ocu-tag-pill ocu-tag-removable" style="border-color:' + c + ';color:' + c + ';background:' + c + '11">'
                     + '<span>' + escapeHTML(tag.name) + '</span>'
                     + '<button type="button" class="ocu-tag-remove" data-action="phone-tag-remove" data-phone-id="' + phoneId + '" data-tag-id="' + tag.id + '" title="Remove">×</button>'
                     + '</span>';
          target.insertAdjacentHTML('beforebegin', html);
          toast('Tag added', false);
        }
      } catch (err) {
        toast('Failed to add tag: ' + err.message, true);
      }
      return;
    }

    // ── Add phone to a contact ─────────────────────────────────────────────
    // The owner card's "+ Add phone" button. Prompts for the number and
    // posts to /records/contacts/:id/phones. On success we just reload —
    // the new phone needs full markup (best-pill scoring, type/status
    // pills, tag input) which is non-trivial to build client-side; a
    // page reload is fast and gets the rendering right.
    if (action === 'add-phone') {
      e.stopPropagation();
      const contactId = target.dataset.contactId;
      if (!contactId) return;
      const raw = window.prompt('Add a phone number for this contact:\n(US 10-digit, with or without formatting)');
      if (!raw || !raw.trim()) return;
      target.disabled = true;
      try {
        const data = await jpost('/records/contacts/' + contactId + '/phones', {
          phone_number: raw.trim(),
        });
        if (data && data.ok) {
          toast('Phone added', false);
          window.location.reload();
        }
      } catch (err) {
        toast('Failed to add phone: ' + err.message, true);
        target.disabled = false;
      }
      return;
    }

    // ── Property tag remove ────────────────────────────────────────────────
    if (action === 'property-tag-remove') {
      e.stopPropagation();
      const propertyId = target.dataset.propertyId;
      const tagId = target.dataset.tagId;
      const pill = target.closest('.ocu-tag-pill');
      const parent = pill && pill.parentNode;
      const sibling = pill && pill.nextSibling;
      if (pill) pill.remove();
      try {
        await jpost('/records/' + propertyId + '/tags/' + tagId, null, 'DELETE');
        toast('Tag removed', false);
      } catch (err) {
        if (pill && parent) parent.insertBefore(pill, sibling);
        toast('Failed to remove tag: ' + err.message, true);
      }
      return;
    }

    // ── Property tag add ───────────────────────────────────────────────────
    if (action === 'property-tag-add') {
      e.stopPropagation();
      const propertyId = target.dataset.propertyId;
      const name = await promptTagName(target);
      if (!name) return;
      try {
        const data = await jpost('/records/' + propertyId + '/tags', { name });
        if (data && data.tag) {
          const tag = data.tag;
          const c = tag.color || '#6B7280';
          const html = '<span class="ocu-tag-pill ocu-tag-removable" style="border-color:' + c + ';color:' + c + ';background:' + c + '11">'
                     + '<span>' + escapeHTML(tag.name) + '</span>'
                     + '<button type="button" class="ocu-tag-remove" data-action="property-tag-remove" data-property-id="' + propertyId + '" data-tag-id="' + tag.id + '" title="Remove">×</button>'
                     + '</span>';
          target.insertAdjacentHTML('beforebegin', html);
          toast('Tag added', false);
        }
      } catch (err) {
        toast('Failed to add tag: ' + err.message, true);
      }
      return;
    }

    // ── Property note remove (2026-04-29) ─────────────────────────────────
    if (action === 'property-note-remove') {
      e.stopPropagation();
      const propertyId = target.dataset.propertyId;
      const noteId = target.dataset.noteId;
      const row = target.closest('.ocu-note');
      const parent = row && row.parentNode;
      const sibling = row && row.nextSibling;
      if (row) row.remove();
      try {
        await jpost('/records/' + propertyId + '/notes/' + noteId, null, 'DELETE');
        toast('Note deleted', false);
      } catch (err) {
        if (row && parent) parent.insertBefore(row, sibling);
        toast('Failed to delete note: ' + err.message, true);
      }
      return;
    }

    // ── Edit owners dialog: open / close / remove / make-primary ───────────
    // Add owner via the dialog's form is handled by an explicit submit
    // listener (see below) — not delegation — so we can use form.elements
    // directly and call preventDefault cleanly.
    if (action === 'open-edit-owners') {
      const dlg = document.getElementById('ocu-edit-owners-dialog');
      if (dlg && dlg.showModal) dlg.showModal();
      return;
    }
    if (action === 'close-edit-owners') {
      const dlg = document.getElementById('ocu-edit-owners-dialog');
      if (dlg && dlg.close) dlg.close();
      return;
    }
    if (action === 'owner-remove') {
      e.stopPropagation();
      const propertyId = target.dataset.propertyId;
      const contactId  = target.dataset.contactId;
      if (!propertyId || !contactId) return;
      if (!window.confirm('Remove this owner from the property? Their phones go with them. If they own no other properties they\'ll also be deleted as a contact.')) return;
      target.disabled = true;
      target.textContent = 'Removing…';
      try {
        await jpost('/records/' + propertyId + '/owner/' + contactId, null, 'DELETE');
        toast('Owner removed', false);
        // Full reload — keeps owner_portfolio_counts MV, "first owner"
        // subqueries, and the Records list owner column all in sync with
        // the DB. Re-rendering the cards client-side would risk drift.
        setTimeout(() => window.location.reload(), 300);
      } catch (err) {
        target.disabled = false;
        target.textContent = 'Remove';
        toast('Failed to remove owner: ' + err.message, true);
      }
      return;
    }
    if (action === 'owner-make-primary') {
      e.stopPropagation();
      const propertyId = target.dataset.propertyId;
      const contactId  = target.dataset.contactId;
      if (!propertyId || !contactId) return;
      target.disabled = true;
      target.textContent = 'Saving…';
      try {
        await jpost('/records/' + propertyId + '/owner/' + contactId + '/primary');
        toast('Primary owner updated', false);
        setTimeout(() => window.location.reload(), 300);
      } catch (err) {
        target.disabled = false;
        target.textContent = 'Make primary';
        toast('Failed to update primary: ' + err.message, true);
      }
      return;
    }

    // ── Inline owner edit toggle ──────────────────────────────────────────
    // Click "Edit" on a row → expand the inline form. Click "Cancel" or
    // submit → collapse. Multiple rows can be expanded simultaneously
    // (each operates on its own contact id) but typically only one is.
    if (action === 'owner-edit-toggle') {
      e.stopPropagation();
      const contactId = target.dataset.contactId;
      const row = target.closest('.ocu-edit-owner-row');
      if (!row) return;
      const form = row.querySelector('.ocu-edit-owner-form');
      if (!form) return;
      const open = form.hasAttribute('hidden');
      if (open) {
        form.removeAttribute('hidden');
        row.classList.add('is-editing');
        target.textContent = 'Close';
        const firstInput = form.querySelector('input[name="first_name"]');
        if (firstInput) firstInput.focus();
      } else {
        form.setAttribute('hidden', '');
        row.classList.remove('is-editing');
        target.textContent = 'Edit';
      }
      return;
    }
    if (action === 'owner-edit-cancel') {
      e.stopPropagation();
      const row = target.closest('.ocu-edit-owner-row');
      if (!row) return;
      const form = row.querySelector('.ocu-edit-owner-form');
      const toggleBtn = row.querySelector('[data-action="owner-edit-toggle"]');
      if (form) form.setAttribute('hidden', '');
      row.classList.remove('is-editing');
      if (toggleBtn) toggleBtn.textContent = 'Edit';
      return;
    }

    // ── Add-owner form open / close (collapsed by default) ────────────────
    if (action === 'open-add-owner-form') {
      e.stopPropagation();
      const trigger = document.getElementById('ocu-edit-owners-add-trigger');
      const panel   = document.getElementById('ocu-edit-owners-add');
      if (trigger) trigger.style.display = 'none';
      if (panel) {
        panel.removeAttribute('hidden');
        const firstInput = panel.querySelector('input[name="first_name"]');
        if (firstInput) firstInput.focus();
      }
      return;
    }
    if (action === 'cancel-add-owner-form') {
      e.stopPropagation();
      const trigger = document.getElementById('ocu-edit-owners-add-trigger');
      const panel   = document.getElementById('ocu-edit-owners-add');
      if (panel) panel.setAttribute('hidden', '');
      if (trigger) trigger.style.display = '';
      return;
    }
  }, false);

  // ─── Edit owners — submit handlers ──────────────────────────────────────
  // Two forms inside the Edit Owners dialog handled via one submit listener
  // dispatching on data-action / form id:
  //   #ocu-edit-owners-add-form           → add new (POST /records/:id/owner)
  //   .ocu-edit-owner-form (per-owner)    → save edit (POST /records/:id/owner/:cid/edit)
  document.addEventListener('submit', async function(e) {
    const form = e.target;
    if (!form) return;

    // Add new owner
    if (form.id === 'ocu-edit-owners-add-form') {
      e.preventDefault();
      const propertyId = form.dataset.propertyId;
      const data = {};
      form.querySelectorAll('input, select').forEach(el => {
        if (el.name) data[el.name] = el.value;
      });
      const fn = (data.first_name || '').trim();
      const ln = (data.last_name  || '').trim();
      if (!fn && !ln) { toast('Provide at least a first or last name', true); return; }
      const submitBtn = form.querySelector('button[type="submit"]');
      if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Adding…'; }
      try {
        await jpost('/records/' + propertyId + '/owner', data);
        toast('Owner added', false);
        setTimeout(() => window.location.reload(), 300);
      } catch (err) {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Add owner'; }
        toast('Failed to add owner: ' + err.message, true);
      }
      return;
    }

    // Save edits to an existing owner
    if (form.dataset.action === 'owner-edit-submit') {
      e.preventDefault();
      const propertyId = form.dataset.propertyId;
      const contactId  = form.dataset.contactId;
      if (!propertyId || !contactId) return;
      const data = {};
      form.querySelectorAll('input, select').forEach(el => {
        if (el.name) data[el.name] = el.value;
      });
      const fn = (data.first_name || '').trim();
      const ln = (data.last_name  || '').trim();
      if (!fn && !ln) { toast('Provide at least a first or last name', true); return; }
      const submitBtn = form.querySelector('button[type="submit"]');
      if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Saving…'; }
      try {
        await jpost('/records/' + propertyId + '/owner/' + contactId + '/edit', data);
        toast('Owner updated', false);
        // Reload so every dependent surface (owner card, /owners profile,
        // owner_portfolio_counts MV, mailing-key dedup keys) reflects the
        // edits. Trying to patch the DOM in-place would risk drift.
        setTimeout(() => window.location.reload(), 300);
      } catch (err) {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Save changes'; }
        toast('Failed to save: ' + err.message, true);
      }
      return;
    }
  });

  // ─── Property note add (form submit handler exposed globally so the
  //     onsubmit attribute can call it) ────────────────────────────────────
  window.ocu_addNote = async function (e) {
    e.preventDefault();
    const form = e.target;
    const propertyId = form.dataset.propertyId;
    const ta = form.querySelector('textarea[name="body"]');
    const body = (ta && ta.value || '').trim();
    if (!body) { toast('Note is empty', true); return false; }
    try {
      const data = await jpost('/records/' + propertyId + '/notes', { body });
      if (data && data.note) {
        const n = data.note;
        const html = '<div class="ocu-note" data-note-id="' + n.id + '">'
          + '<div class="ocu-note-meta">'
          + '<span class="ocu-note-author">' + escapeHTML(n.author || 'Unknown') + '</span>'
          + '<span class="ocu-text-3" style="font-size:11px">just now</span>'
          + '<button type="button" class="ocu-note-remove" data-action="property-note-remove"'
          + ' data-property-id="' + propertyId + '" data-note-id="' + n.id + '" title="Delete note">×</button>'
          + '</div>'
          + '<div class="ocu-note-body">' + escapeHTML(n.body) + '</div>'
          + '</div>';
        const list = document.getElementById('ocu-notes-list');
        // Replace the "No notes yet" placeholder if present.
        const placeholder = list && list.querySelector('.ocu-text-3');
        if (placeholder && /No notes yet/.test(placeholder.textContent)) list.innerHTML = '';
        list.insertAdjacentHTML('afterbegin', html);
        ta.value = '';
        toast('Note added', false);
      }
    } catch (err) {
      toast('Failed to add note: ' + err.message, true);
    }
    return false;
  };

  // ─── Add owner (2026-04-29 Option A) ────────────────────────────────────
  // No auto-created placeholder rows; when a property has no primary
  // contact the detail page renders an inline "Add owner" form. Submitting
  // it posts to /records/:id/owner and reloads the page so the new owner
  // shows up in its proper card with phones/messages/etc. wired up.
  window.ocu_addOwner = async function(e) {
    e.preventDefault();
    const form = e.target;
    const propertyId = form.dataset.propertyId;
    const data = {};
    form.querySelectorAll('input, select').forEach(el => {
      if (el.name) data[el.name] = el.value;
    });
    const fn = (data.first_name || '').trim();
    const ln = (data.last_name  || '').trim();
    if (!fn && !ln) { toast('Provide at least a first or last name', true); return false; }
    try {
      await jpost('/records/' + propertyId + '/owner', data);
      toast('Owner added', false);
      // Reload so the page renders the proper Owner card with phones,
      // tag affordances, etc. — simpler and less error-prone than
      // re-rendering the card client-side.
      setTimeout(() => window.location.reload(), 350);
    } catch (err) {
      toast('Failed to add owner: ' + err.message, true);
    }
    return false;
  };

  // ─── Edit property (2026-04-29 / expanded 2026-04-30) ───────────────────
  // Modal opens via showModal() on the Edit button. Submit collects every
  // named field (input, select, textarea), including blanks so the server
  // can clear optional columns. Posts JSON to /records/:id/edit-fields,
  // shows an inline error on failure, closes dialog + reloads on success.
  window.ocu_editProperty = async function(e) {
    e.preventDefault();
    const form = e.target;
    const propertyId = form.dataset.propertyId;
    const errEl = form.querySelector('.ocu-edit-property-error');
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }

    const data = {};
    form.querySelectorAll('input, select, textarea').forEach(el => {
      if (!el.name) return;
      // Send EVERY named field, even blanks. The server treats blank on a
      // nullable column as "clear it" and skips blank on required columns.
      data[el.name] = el.value;
    });

    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Saving…'; }
    try {
      const resp = await jpost('/records/' + propertyId + '/edit-fields', data);
      toast('Property updated · ' + (resp && resp.updated || 0) + ' field(s) changed', false);
      const dlg = document.getElementById('ocu-edit-property-dialog');
      if (dlg && dlg.close) dlg.close();
      setTimeout(() => window.location.reload(), 350);
    } catch (err) {
      if (errEl) {
        errEl.textContent = 'Save failed: ' + (err && err.message || 'unknown error');
        errEl.style.display = 'block';
      } else {
        toast('Failed to save: ' + (err && err.message || 'error'), true);
      }
    } finally {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Save changes'; }
    }
    return false;
  };

  // ─── Edit owner (2026-04-29) ────────────────────────────────────────────
  window.ocu_editOwner = async function(e) {
    e.preventDefault();
    const form = e.target;
    const contactId = form.dataset.contactId;
    const data = {};
    form.querySelectorAll('input, select').forEach(el => {
      if (el.name && el.value !== '') data[el.name] = el.value;
    });
    try {
      await jpost('/owners/' + contactId + '/edit', data);
      toast('Owner updated', false);
      const dlg = document.getElementById('ocu-edit-owner-dialog');
      if (dlg && dlg.close) dlg.close();
      setTimeout(() => window.location.reload(), 350);
    } catch (err) {
      toast('Failed to save: ' + err.message, true);
    }
    return false;
  };

  // ─── Pipeline dropdown — change event (not click) ────────────────────────
  document.addEventListener('change', async function(e) {
    const select = e.target.closest('[data-action="property-pipeline"]');
    if (!select) return;
    const propertyId = select.dataset.propertyId;
    const newStage = select.value;
    // Server-rendered HTML sets data-previous-value to the original stage,
    // so this is always defined. We update it after each successful save.
    const prev = select.dataset.previousValue;
    try {
      await jpost('/records/' + propertyId + '/pipeline', { pipeline_stage: newStage });
      select.dataset.previousValue = newStage;
      toast('Pipeline → ' + newStage, false);
    } catch (err) {
      // Revert to last successfully-saved value
      if (prev) select.value = prev;
      toast('Failed to update pipeline: ' + err.message, true);
    }
  });

  // ─── Tiny HTML escape for client-side insertion ───────────────────────────
  function escapeHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

})();
