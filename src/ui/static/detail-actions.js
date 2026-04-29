/* ═══════════════════════════════════════════════════════════════════════════
   ui/static/detail-actions.js
   Click handlers for the property detail page.
   Loaded only on /ocular/records/:id pages.

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

  // ─── Inline text input for tag name ───────────────────────────────────────
  // Replaces a "+ tag" button with an input field. Returns a promise that
  // resolves to the trimmed name (or null if cancelled).
  function promptTagName(anchorBtn) {
    return new Promise(resolve => {
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'Tag name…';
      input.className = 'ocu-tag-input';
      input.maxLength = 100;

      anchorBtn.style.display = 'none';
      anchorBtn.parentNode.insertBefore(input, anchorBtn);
      input.focus();

      let resolved = false;
      function done(value) {
        if (resolved) return;
        resolved = true;
        input.remove();
        anchorBtn.style.display = '';
        resolve(value);
      }
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter')      { e.preventDefault(); const v = input.value.trim(); done(v || null); }
        else if (e.key === 'Escape') { done(null); }
      });
      input.addEventListener('blur', () => done(input.value.trim() || null));
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
      const name = await promptTagName(target);
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
  }, false);

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
