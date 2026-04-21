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
