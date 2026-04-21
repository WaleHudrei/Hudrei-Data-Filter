// ═══════════════════════════════════════════════════════════════
// Loki Records Detail — Client-side JS
// ═══════════════════════════════════════════════════════════════

var _propId = parseInt(document.getElementById('property-detail').getAttribute('data-prop-id'), 10);

function deleteThisProperty(id) {
  _propId = id;
  document.getElementById('delete-modal-err').style.display = 'none';
  document.getElementById('delete-code-input').value = '';
  document.getElementById('delete-modal').classList.add('open');
  setTimeout(function(){ document.getElementById('delete-code-input').focus(); }, 50);
}
async function confirmDeleteSingle() {
  var code = document.getElementById('delete-code-input').value;
  if (!code) { showDeleteErr('Delete code required.'); return; }
  var btn = document.getElementById('delete-confirm-btn');
  btn.textContent = 'Deleting…';
  btn.disabled = true;
  try {
    var res = await fetch('/records/' + _propId + '/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code })
    });
    var data = await res.json();
    if (!res.ok || data.error) {
      showDeleteErr(data.error || 'Delete failed.');
      btn.textContent = 'Delete';
      btn.disabled = false;
      return;
    }
    window.location.href = '/records?msg=' + encodeURIComponent('Record deleted.');
  } catch(err) {
    showDeleteErr('Network error: ' + err.message);
    btn.textContent = 'Delete';
    btn.disabled = false;
  }
}
function showDeleteErr(msg) {
  var el = document.getElementById('delete-modal-err');
  el.textContent = msg;
  el.style.display = 'block';
}

// ─── Tag management ─────────────────────────────────────────────────
function _esc(s) {
  var d = document.createElement('div');
  d.appendChild(document.createTextNode(s));
  return d.innerHTML;
}
var _suggestTimer = null;
function suggestTags(q) {
  clearTimeout(_suggestTimer);
  var box = document.getElementById('tag-suggestions');
  // 2026-04-21 fix: query on focus/empty too so clicking the field shows
  // all existing tags for browsing (previously this returned 0 results
  // until the user typed something, which looked broken).
  _suggestTimer = setTimeout(async function() {
    try {
      var res = await fetch('/records/tags/suggest?q=' + encodeURIComponent((q||'').trim()));
      var tags = await res.json();
      // Filter out tags already on this property
      var existing = Array.from(document.querySelectorAll('.tag-pill')).map(function(el){ return parseInt(el.getAttribute('data-tag-id')); });
      tags = tags.filter(function(t){ return existing.indexOf(t.id) === -1; });
      if (!tags.length) {
        var q2 = (q||'').trim();
        box.innerHTML = '<div style="padding:10px 12px;font-size:12px;color:#aaa;font-style:italic">'
          + (q2 ? 'No matching tags — press Enter to create "' + _esc(q2) + '"' : 'This property already has every tag that exists. Type a new name to create one.')
          + '</div>';
        box.style.display = 'block';
        return;
      }
      box.innerHTML = tags.map(function(t){
        return '<div onclick="pickSuggestion(' + t.id + ', this)" style="padding:8px 12px;cursor:pointer;font-size:13px;display:flex;align-items:center;gap:8px" onmouseover="this.style.background=\'#f5f4f0\'" onmouseout="this.style.background=\'none\'">'
          + '<span style="width:10px;height:10px;border-radius:50%;background:' + (t.color||'#6b7280') + '"></span>'
          + '<span>' + _esc(t.name) + '</span></div>';
      }).join('');
      box.style.display = 'block';
    } catch(e) { box.style.display = 'none'; }
  }, 200);
}

// 2026-04-21: click/focus handler — triggers suggest with current input value.
function suggestTagsOnFocus() {
  var input = document.getElementById('tag-input');
  if (input) suggestTags(input.value || '');
}

function pickSuggestion(tagId, el) {
  var name = el.querySelector('span:last-child').textContent;
  document.getElementById('tag-input').value = name;
  document.getElementById('tag-suggestions').style.display = 'none';
}

async function addTagFromInput(propId) {
  var input = document.getElementById('tag-input');
  var name = input.value.trim();
  if (!name) return;
  input.disabled = true;
  try {
    var res = await fetch('/records/' + propId + '/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name })
    });
    var data = await res.json();
    if (!res.ok || data.error) { alert(data.error || 'Failed to add tag.'); return; }
    var tag = data.tag;
    var list = document.getElementById('tag-list');
    // Remove "No tags yet" placeholder
    var placeholder = list.querySelector('span:not(.tag-pill)');
    if (placeholder) placeholder.remove();
    // Check if already present
    if (list.querySelector('[data-tag-id="' + tag.id + '"]')) { input.value = ''; return; }
    var pill = document.createElement('span');
    pill.className = 'tag-pill';
    pill.setAttribute('data-tag-id', tag.id);
    pill.style.cssText = 'display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:20px;font-size:12px;font-weight:500;background:' + tag.color + '20;color:' + tag.color + ';border:1px solid ' + tag.color + '40';
    pill.innerHTML = _esc(tag.name) + ' <button onclick="removeTag(' + propId + ',' + tag.id + ',this)" style="background:none;border:none;cursor:pointer;font-size:14px;line-height:1;color:inherit;padding:0;margin-left:2px" title="Remove tag">×</button>';
    list.appendChild(pill);
    input.value = '';
    updateTagCount();
  } catch(e) { alert('Error: ' + e.message); }
  finally { input.disabled = false; input.focus(); }
  document.getElementById('tag-suggestions').style.display = 'none';
}

async function removeTag(propId, tagId, btn) {
  if (!confirm('Remove this tag?')) return;
  try {
    var res = await fetch('/records/' + propId + '/tags/' + tagId, { method: 'DELETE' });
    var data = await res.json();
    if (!res.ok || data.error) { alert(data.error || 'Failed to remove tag.'); return; }
    var pill = btn.closest('.tag-pill');
    if (pill) pill.remove();
    updateTagCount();
    // If no tags left, show placeholder
    var list = document.getElementById('tag-list');
    if (!list.querySelector('.tag-pill')) {
      list.innerHTML = '<span style="color:#aaa;font-size:12px">No tags yet</span>';
    }
  } catch(e) { alert('Error: ' + e.message); }
}

function updateTagCount() {
  var count = document.querySelectorAll('.tag-pill').length;
  var el = document.getElementById('tag-count');
  if (el) el.textContent = count;
}

// Close suggestions on outside click
document.addEventListener('click', function(ev) {
  var box = document.getElementById('tag-suggestions');
  var input = document.getElementById('tag-input');
  if (box && !box.contains(ev.target) && ev.target !== input) {
    box.style.display = 'none';
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2026-04-21 Phone tags + phone type manual edit
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Phone type popover ───────────────────────────────────────────────────
var _phoneTypePopoverEl = null;
function togglePhoneTypePopover(phoneId, ev) {
  ev.stopPropagation();
  // Close any existing popover
  if (_phoneTypePopoverEl) { _phoneTypePopoverEl.remove(); _phoneTypePopoverEl = null; return; }
  var chip = ev.currentTarget;
  var pop = document.createElement('div');
  pop.style.cssText = 'position:absolute;z-index:100;background:#fff;border:1px solid #ddd;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.12);padding:6px;min-width:140px;font-family:inherit';
  var opts = [
    { v:'mobile',   label:'Mobile',   color:'#1a7a4a' },
    { v:'landline', label:'Landline', color:'#2c5cc5' },
    { v:'voip',     label:'VoIP',     color:'#9a6800' },
    { v:'unknown',  label:'Unknown',  color:'#888'    },
  ];
  pop.innerHTML = opts.map(function(o){
    return '<button type="button" onclick="setPhoneType(' + phoneId + ', \'' + o.v + '\')" style="display:block;width:100%;text-align:left;padding:7px 10px;font-size:12px;border:none;background:none;border-radius:5px;cursor:pointer;color:' + o.color + ';font-weight:600;font-family:inherit" onmouseover="this.style.background=\'#f5f4f0\'" onmouseout="this.style.background=\'none\'">' + o.label + '</button>';
  }).join('');
  document.body.appendChild(pop);
  // Position under the chip
  var rect = chip.getBoundingClientRect();
  pop.style.left = (rect.left + window.scrollX) + 'px';
  pop.style.top = (rect.bottom + window.scrollY + 4) + 'px';
  _phoneTypePopoverEl = pop;
}

async function setPhoneType(phoneId, newType) {
  try {
    var res = await fetch('/records/phones/' + phoneId + '/type', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone_type: newType })
    });
    var data = await res.json();
    if (!res.ok || data.error) { alert('Error: ' + (data.error || 'failed')); return; }
    // Close popover and update chip in place without full reload
    if (_phoneTypePopoverEl) { _phoneTypePopoverEl.remove(); _phoneTypePopoverEl = null; }
    var chip = document.querySelector('.phone-type-chip[data-phone-id="' + phoneId + '"]');
    if (chip) {
      var labels = { mobile:'Mobile', landline:'Landline', voip:'VoIP', unknown:'Unknown' };
      var colors = {
        mobile:   { bg:'#e8f5ee', text:'#1a7a4a' },
        landline: { bg:'#e8f0ff', text:'#2c5cc5' },
        voip:     { bg:'#fff8e1', text:'#9a6800' },
        unknown:  { bg:'#f0efe9', text:'#888'    },
      };
      var c = colors[newType] || colors.unknown;
      chip.textContent = labels[newType] || 'Unknown';
      chip.style.background = c.bg;
      chip.style.color = c.text;
    }
  } catch(e) { alert('Network error: ' + e.message); }
}

// Close type popover on outside click
document.addEventListener('click', function(ev){
  if (_phoneTypePopoverEl && !_phoneTypePopoverEl.contains(ev.target) && !ev.target.classList.contains('phone-type-chip')) {
    _phoneTypePopoverEl.remove();
    _phoneTypePopoverEl = null;
  }
});

// ─── Phone tags ───────────────────────────────────────────────────────────
function openPhoneTagInput(phoneId) {
  document.getElementById('ptag-addbtn-' + phoneId).style.display = 'none';
  document.getElementById('ptag-input-wrap-' + phoneId).style.display = 'inline-block';
  var input = document.getElementById('ptag-input-' + phoneId);
  input.value = '';
  setTimeout(function(){ input.focus(); }, 20);
}
function closePhoneTagInput(phoneId) {
  document.getElementById('ptag-addbtn-' + phoneId).style.display = '';
  document.getElementById('ptag-input-wrap-' + phoneId).style.display = 'none';
  var box = document.getElementById('ptag-suggest-' + phoneId);
  if (box) box.style.display = 'none';
}

var _phoneTagSuggestTimer = {};
function phoneTagSuggest(phoneId, q) {
  clearTimeout(_phoneTagSuggestTimer[phoneId]);
  var box = document.getElementById('ptag-suggest-' + phoneId);
  _phoneTagSuggestTimer[phoneId] = setTimeout(async function() {
    try {
      var res = await fetch('/records/phone-tags/suggest?q=' + encodeURIComponent((q||'').trim()));
      var tags = await res.json();
      // Filter out tags already on this phone
      var existing = Array.from(document.querySelectorAll('.phone-row[data-phone-id="' + phoneId + '"] .phone-tag-pill')).map(function(el){ return parseInt(el.getAttribute('data-tag-id')); });
      tags = tags.filter(function(t){ return existing.indexOf(t.id) === -1; });
      if (!tags.length) {
        var q2 = (q||'').trim();
        box.innerHTML = '<div style="padding:8px 10px;font-size:11px;color:#aaa;font-style:italic">'
          + (q2 ? 'Press Enter to create "' + _esc(q2) + '"' : 'No phone tags yet — type a name and press Enter to create one')
          + '</div>';
        box.style.display = 'block';
        return;
      }
      box.innerHTML = tags.map(function(t){
        return '<div onclick="pickPhoneTagSuggestion(' + phoneId + ', \'' + _esc(t.name).replace(/\'/g,"\\'") + '\')" style="padding:7px 10px;cursor:pointer;font-size:12px;display:flex;align-items:center;gap:6px" onmouseover="this.style.background=\'#f5f4f0\'" onmouseout="this.style.background=\'none\'">'
          + '<span style="width:8px;height:8px;border-radius:50%;background:' + (t.color||'#6b7280') + '"></span>'
          + '<span>' + _esc(t.name) + '</span></div>';
      }).join('');
      box.style.display = 'block';
    } catch(e) { box.style.display = 'none'; }
  }, 150);
}

function pickPhoneTagSuggestion(phoneId, name) {
  document.getElementById('ptag-input-' + phoneId).value = name;
  addPhoneTagFromInput(phoneId);
}

async function addPhoneTagFromInput(phoneId) {
  var input = document.getElementById('ptag-input-' + phoneId);
  var name = (input.value || '').trim();
  if (!name) return;
  try {
    var res = await fetch('/records/phones/' + phoneId + '/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name })
    });
    var data = await res.json();
    if (!res.ok || data.error) { alert(data.error || 'Failed to add tag'); return; }
    // Insert pill into DOM before the + tag button
    var row = document.querySelector('.phone-row[data-phone-id="' + phoneId + '"]');
    var addBtn = document.getElementById('ptag-addbtn-' + phoneId);
    var pill = document.createElement('span');
    pill.className = 'phone-tag-pill';
    pill.setAttribute('data-tag-id', data.tag.id);
    pill.style.cssText = 'display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:500;padding:3px 4px 3px 7px;border-radius:4px;background:' + data.tag.color + '22;color:' + data.tag.color + ';border:1px solid ' + data.tag.color + '55';
    pill.innerHTML = '<span>' + _esc(data.tag.name) + '</span>'
      + '<button type="button" onclick="removePhoneTag(' + phoneId + ',' + data.tag.id + ')" title="Remove tag" style="background:none;border:none;cursor:pointer;padding:0 2px;color:inherit;font-size:13px;line-height:1;opacity:.6">×</button>';
    addBtn.parentNode.insertBefore(pill, addBtn);
    closePhoneTagInput(phoneId);
  } catch(e) { alert('Network error: ' + e.message); }
}

async function removePhoneTag(phoneId, tagId) {
  try {
    await fetch('/records/phones/' + phoneId + '/tags/' + tagId + '/remove', { method: 'POST' });
    var pill = document.querySelector('.phone-row[data-phone-id="' + phoneId + '"] .phone-tag-pill[data-tag-id="' + tagId + '"]');
    if (pill) pill.remove();
  } catch(e) { alert('Network error: ' + e.message); }
}

// Close phone-tag suggestions on outside click
document.addEventListener('click', function(ev){
  document.querySelectorAll('[id^="ptag-suggest-"]').forEach(function(box){
    var phoneId = box.id.replace('ptag-suggest-','');
    var wrap = document.getElementById('ptag-input-wrap-' + phoneId);
    if (wrap && !wrap.contains(ev.target)) box.style.display = 'none';
  });
});
