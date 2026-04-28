const { shell } = require('../shared-shell');

// Step bar helper — matches Ocular palette via --ocu-* tokens.
function stepBar(steps, current) {
  return `<div style="display:flex;align-items:center;gap:0;margin-bottom:20px;flex-wrap:wrap">
    ${steps.map((s, i) => {
      const n = i + 1;
      const active = n === current;
      const done = n < current;
      const labelColor = done ? '#1a7a4a' : active ? 'var(--ocu-text-1)' : 'var(--ocu-text-3)';
      const circleBg = done ? '#e8f5ee' : active ? 'var(--ocu-text-1)' : 'var(--ocu-surface)';
      const circleText = done ? '#1a7a4a' : active ? '#fff' : 'var(--ocu-text-3)';
      const circleBorder = done ? '#9bd0a8' : active ? 'var(--ocu-text-1)' : 'var(--ocu-border)';
      return `<div style="display:flex;align-items:center;gap:8px">
        <div style="width:26px;height:26px;border-radius:50%;background:${circleBg};color:${circleText};border:1px solid ${circleBorder};font-size:12px;font-weight:600;display:flex;align-items:center;justify-content:center;flex-shrink:0">${done ? '✓' : n}</div>
        <div style="font-size:13px;color:${labelColor};font-weight:${active?'600':'500'}">${s}</div>
        ${i < steps.length - 1 ? `<div style="width:32px;height:1px;background:var(--ocu-border);margin:0 8px"></div>` : ''}
      </div>`;
    }).join('')}
  </div>`;
}

// REISift target fields for filter list output
const REISIFT_FILTER_FIELDS = [
  { key: 'Call Log Date',    label: 'Call Log Date',    required: true  },
  { key: 'Phone',            label: 'Phone',            required: true  },
  { key: 'Phone Tag',        label: 'Phone Tag',        required: false },
  { key: 'Call Log Count',   label: 'Call Log Count',   required: false },
  { key: 'Marketing Result', label: 'Marketing Result', required: false },
  { key: 'Phone Status',     label: 'Phone Status',     required: false },
  { key: 'Call Notes',       label: 'Call Notes',       required: false },
  { key: 'First Name',       label: 'First Name',       required: false },
  { key: 'Last Name',        label: 'Last Name',        required: false },
  { key: 'City',             label: 'City',             required: false },
  { key: 'Address',          label: 'Address',          required: false },
  { key: 'Zip Code',         label: 'Zip Code',         required: false },
  { key: 'State',            label: 'State',            required: false },
];

// REISift target fields for property records upload
const REISIFT_PROPERTY_FIELDS = [
  { key: 'Property Street',   label: 'Property Street',   required: true  },
  { key: 'Property City',     label: 'Property City',     required: true  },
  { key: 'Property State',    label: 'Property State',    required: true  },
  { key: 'Property ZIP Code', label: 'Property ZIP Code', required: true  },
  { key: 'Property County',   label: 'Property County',   required: false },
  { key: 'Owner First Name',  label: 'Owner First Name',  required: false },
  { key: 'Owner Last Name',   label: 'Owner Last Name',   required: false },
  { key: 'Owner Street',      label: 'Owner Street',      required: false },
  { key: 'Owner City',        label: 'Owner City',        required: false },
  { key: 'Owner State',       label: 'Owner State',       required: false },
  { key: 'Owner ZIP Code',    label: 'Owner ZIP Code',    required: false },
  { key: 'Phone 1',           label: 'Phone 1',           required: false },
  { key: 'Phone 2',           label: 'Phone 2',           required: false },
  { key: 'Phone 3',           label: 'Phone 3',           required: false },
  { key: 'Email',             label: 'Email',             required: false },
  { key: 'List Name',         label: 'List Name',         required: false },
];

// Auto-map source columns to target fields
function autoMap(sourceCols, targetFields) {
  const mapping = {};
  targetFields.forEach(tf => {
    const key = tf.key.toLowerCase().replace(/\s+/g,'').replace(/[^a-z0-9]/g,'');
    const match = sourceCols.find(sc => {
      const sc2 = sc.toLowerCase().replace(/\s+/g,'').replace(/[^a-z0-9]/g,'');
      return sc2 === key || sc2.includes(key) || key.includes(sc2);
    });
    mapping[tf.key] = match || '';
  });
  return mapping;
}

// Step 1: Choose upload type
function uploadChoosePage() {
  return shell('Upload', `
    <div style="max-width:960px">
      <div style="font-size:20px;font-weight:600;margin-bottom:4px">Upload</div>
      <p style="font-size:13px;color:#888;margin-bottom:2rem">What are you uploading today?</p>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px">
        <a href="/upload/filter" style="text-decoration:none;display:block;background:#fff;border:1px solid #e0dfd8;border-radius:12px;padding:28px 24px;transition:all .15s" onmouseover="this.style.borderColor='#1a1a1a';this.style.boxShadow='0 4px 16px rgba(0,0,0,.08)'" onmouseout="this.style.borderColor='#e0dfd8';this.style.boxShadow='none'">
          <div style="width:40px;height:40px;background:#f5f4f0;border-radius:8px;display:flex;align-items:center;justify-content:center;margin-bottom:14px">
            <svg width="20" height="20" fill="none" stroke="#1a1a1a" stroke-width="2" viewBox="0 0 24 24"><path d="M3 4h18M3 8h18M3 12h12M3 16h8"/></svg>
          </div>
          <div style="font-size:15px;font-weight:600;color:#1a1a1a;margin-bottom:6px">Upload Call Log</div>
          <div style="font-size:13px;color:#888;line-height:1.5">Upload a Readymode call log export for filtration. Output is ready for REISift import.</div>
        </a>
        <a href="/import/property" style="text-decoration:none;display:block;background:#fff;border:1px solid #e0dfd8;border-radius:12px;padding:28px 24px;transition:all .15s" onmouseover="this.style.borderColor='#1a1a1a';this.style.boxShadow='0 4px 16px rgba(0,0,0,.08)'" onmouseout="this.style.borderColor='#e0dfd8';this.style.boxShadow='none'">
          <div style="width:40px;height:40px;background:#f5f4f0;border-radius:8px;display:flex;align-items:center;justify-content:center;margin-bottom:14px">
            <svg width="20" height="20" fill="none" stroke="#1a1a1a" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </div>
          <div style="font-size:15px;font-weight:600;color:#1a1a1a;margin-bottom:6px">Import Property List</div>
          <div style="font-size:13px;color:#888;line-height:1.5">Upload a CSV from PropStream, DealMachine or any data source. Map columns and import into Records.</div>
        </a>
        <a href="/import/bulk" style="text-decoration:none;display:block;background:#fff;border:1px solid #e0dfd8;border-radius:12px;padding:28px 24px;transition:all .15s" onmouseover="this.style.borderColor='#1a1a1a';this.style.boxShadow='0 4px 16px rgba(0,0,0,.08)'" onmouseout="this.style.borderColor='#e0dfd8';this.style.boxShadow='none'">
          <div style="width:40px;height:40px;background:#f5f4f0;border-radius:8px;display:flex;align-items:center;justify-content:center;margin-bottom:14px">
            <svg width="20" height="20" fill="none" stroke="#1a1a1a" stroke-width="2" viewBox="0 0 24 24"><path d="M3 17l-6-6 6-6M21 17l-6-6 6-6"/><line x1="9" y1="12" x2="21" y2="12"/></svg>
          </div>
          <div style="font-size:15px;font-weight:600;color:#1a1a1a;margin-bottom:6px">Bulk Import <span style="font-size:11px;background:#e8f5ee;color:#1a7a4a;padding:2px 7px;border-radius:4px;margin-left:6px">REISift</span></div>
          <div style="font-size:13px;color:#888;line-height:1.5">Import your full REISift export. No row limit — streams from disk, handles 700k+ records with live progress.</div>
        </a>
      </div>
    </div>
  `, 'upload');
}

// Step 1 Filter: Upload CSV
function uploadFilterStep1Page(error) {
  return shell('Upload Call Log', `
    <div class="ocu-page-header">
      <div>
        <div style="margin-bottom:6px"><a href="/ocular/upload" class="ocu-text-3" style="font-size:13px;text-decoration:none">← Upload</a></div>
        <h1 class="ocu-page-title">Upload call log</h1>
        <div class="ocu-page-subtitle">Upload your Readymode call log export to filter and prepare for REISift</div>
      </div>
    </div>
    ${stepBar(['Upload file','Map columns','Review & download'], 1)}
    ${error ? `<div class="ocu-card" style="margin-bottom:14px;background:#fdeaea;border-color:#f5c5c5;color:#8b1f1f;padding:12px 16px;font-size:13px">${error}</div>` : ''}
    <div class="ocu-card" style="padding:18px 20px">
      <div id="drop-zone" style="border:1.5px dashed var(--ocu-border);border-radius:10px;padding:32px;text-align:center;cursor:pointer;background:var(--ocu-surface);transition:all .15s">
        <svg width="32" height="32" fill="none" stroke="var(--ocu-text-3)" stroke-width="1.5" viewBox="0 0 24 24" style="margin-bottom:10px"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        <div style="font-size:15px;font-weight:600;margin-bottom:4px;color:var(--ocu-text-1)">Drop Readymode CSV here or click to browse</div>
        <div class="ocu-text-3" style="font-size:12px">Call log export from Readymode dialer</div>
      </div>
      <input type="file" id="file-input" accept=".csv" style="display:none">
      <div id="upload-spinner" style="display:none;align-items:center;gap:8px;font-size:13px;color:var(--ocu-text-3);padding:12px 0"><div class="spinner"></div> Reading file…</div>
    </div>
    <script>
    function handleFile(file){
      if(!file.name.endsWith('.csv')){alert('CSV files only.');return;}
      document.getElementById('upload-spinner').style.display='flex';
      document.getElementById('drop-zone').style.display='none';
      const form=new FormData();form.append('csvfile',file);
      fetch('/upload/filter/parse',{method:'POST',body:form})
        .then(r=>r.json())
        .then(d=>{
          if(d.error){alert(d.error);location.reload();return;}
          sessionStorage.setItem('filterUpload',JSON.stringify(d));
          location.href='/upload/filter/map';
        })
        .catch(e=>{alert(e.message);location.reload();});
    }
    document.getElementById('file-input').addEventListener('change',e=>{if(e.target.files[0])handleFile(e.target.files[0]);});
    const dz=document.getElementById('drop-zone');
    dz.addEventListener('click',()=>document.getElementById('file-input').click());
    dz.addEventListener('dragover',e=>{e.preventDefault();dz.style.borderColor='#888';});
    dz.addEventListener('dragleave',()=>dz.style.borderColor='');
    dz.addEventListener('drop',e=>{e.preventDefault();dz.style.borderColor='';if(e.dataTransfer.files[0])handleFile(e.dataTransfer.files[0]);});
    </script>
  `, 'upload');
}

// Step 2 Filter: Map columns
function uploadFilterStep2Page() {
  const targetFieldsJson = JSON.stringify(REISIFT_FILTER_FIELDS);
  return shell('Upload Call Log — Map Columns', `
    <div class="ocu-page-header">
      <div>
        <div style="margin-bottom:6px"><a href="/upload/filter" class="ocu-text-3" style="font-size:13px;text-decoration:none">← Back</a></div>
        <h1 class="ocu-page-title">Map columns</h1>
        <div class="ocu-page-subtitle">Match your file's columns to REISift's fields. We've auto-mapped where possible.</div>
      </div>
    </div>
    ${stepBar(['Upload file','Map columns','Review & download'], 2)}
    <div class="ocu-card" style="padding:18px 20px">
      <div style="display:grid;grid-template-columns:1fr 40px 1fr;gap:8px;padding-bottom:8px;margin-bottom:8px;border-bottom:1px solid var(--ocu-border-soft, #f0efe9)">
        <div class="ocu-text-3" style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em">Your column</div>
        <div></div>
        <div class="ocu-text-3" style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em">REISift field</div>
      </div>
      <div id="map-rows"></div>
    </div>
    <div style="display:flex;gap:8px;margin-top:14px">
      <button onclick="proceed()" class="ocu-btn ocu-btn-primary">Continue to review →</button>
      <button onclick="location.href='/upload/filter'" class="ocu-btn ocu-btn-ghost">Start over</button>
    </div>
    <script>
    const TARGET_FIELDS = ${targetFieldsJson};
    const data = JSON.parse(sessionStorage.getItem('filterUpload')||'{}');
    if(!data.columns){location.href='/upload/filter';}
    const srcCols = data.columns||[];
    const autoMaps = data.autoMap||{};
    function buildRows(){
      const wrap = document.getElementById('map-rows');
      wrap.innerHTML = '';
      TARGET_FIELDS.forEach(tf => {
        const row = document.createElement('div');
        row.style.cssText = 'display:grid;grid-template-columns:1fr 40px 1fr;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid #f8f7f4';
        const opts = ['<option value="">— skip —</option>', ...srcCols.map(c=>\`<option value="\${c}" \${autoMaps[tf.key]===c?'selected':''}>\${c}</option>\`)].join('');
        row.innerHTML = \`
          <div><select data-target="\${tf.key}" class="ocu-input" style="padding:7px 10px;font-size:13px">\${opts}</select></div>
          <div style="text-align:center;color:var(--ocu-text-3);font-size:12px">→</div>
          <div style="font-size:13px;color:var(--ocu-text-1)">\${tf.label}\${tf.required?' <span style="color:#c0392b">*</span>':''}</div>\`;
        wrap.appendChild(row);
      });
    }
    buildRows();
    function proceed(){
      const mapping={};
      document.querySelectorAll('[data-target]').forEach(sel=>{if(sel.value)mapping[sel.dataset.target]=sel.value;});
      const required=TARGET_FIELDS.filter(f=>f.required&&!mapping[f.key]);
      if(required.length){alert('Please map required fields: '+required.map(f=>f.label).join(', '));return;}
      data.mapping=mapping;
      sessionStorage.setItem('filterUpload',JSON.stringify(data));
      location.href='/upload/filter/review';
    }
    </script>
  `, 'upload');
}

// Step 3 Filter: Review & download
function uploadFilterStep3Page() {
  return shell('Upload Call Log — Review', `
    <div class="ocu-page-header">
      <div>
        <div style="margin-bottom:6px"><a href="/upload/filter/map" class="ocu-text-3" style="font-size:13px;text-decoration:none">← Back to mapping</a></div>
        <h1 class="ocu-page-title">Review &amp; download</h1>
        <div class="ocu-page-subtitle">Check the results below then download your REISift-ready files</div>
      </div>
    </div>
    ${stepBar(['Upload file','Map columns','Review & download'], 3)}
    <div id="spinner-wrap" style="text-align:center;padding:48px 24px;color:var(--ocu-text-3)"><div class="spinner" style="width:24px;height:24px;margin:0 auto 12px"></div><p>Processing filtration…</p></div>
    <div id="results-wrap" style="display:none">
      <div id="stats-grid" class="ocu-kpi-row" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr));margin-bottom:14px"></div>
      <div id="list-chips" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px"></div>
      <div class="ocu-card" style="padding:18px 20px">
        <div class="tabs">
          <button class="tab active" data-tab="filtered">Filtered → REISift</button>
          <button class="tab" data-tab="clean">Clean → Readymode</button>
        </div>
        <div id="tab-filtered" class="tab-panel active">
          <div class="ocu-text-3" style="font-size:12px;background:var(--ocu-surface);border-radius:8px;padding:10px 14px;margin-bottom:10px">Mapped to your REISift field names — upload this file directly to REISift.</div>
          <div class="tbl-wrap"><table class="data-table"><thead><tr id="rem-head"></tr></thead><tbody id="rem-body"></tbody></table></div>
        </div>
        <div id="tab-clean" class="tab-panel">
          <div class="ocu-text-3" style="font-size:12px;background:var(--ocu-surface);border-radius:8px;padding:10px 14px;margin-bottom:10px">Records that passed all filters — re-upload to Readymode.</div>
          <div class="tbl-wrap"><table class="data-table"><thead><tr id="cln-head"></tr></thead><tbody id="cln-body"></tbody></table></div>
        </div>
        <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">
          <button id="dl-filtered" class="ocu-btn ocu-btn-primary">Download filtered (REISift)</button>
          <button id="dl-clean" class="ocu-btn ocu-btn-secondary">Download clean (Readymode)</button>
          <a href="/upload/filter" class="ocu-btn ocu-btn-ghost">Filter another list</a>
        </div>
      </div>
    </div>
    <script>
    const data = JSON.parse(sessionStorage.getItem('filterUpload')||'{}');
    if(!data.rows||!data.mapping){location.href='/upload/filter';}
    let filteredMapped=[], cleanRows=[];
    async function run(){
      const res = await fetch('/upload/filter/process',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rows:data.rows,mapping:data.mapping,filename:data.filename})});
      const result = await res.json();
      if(result.error){alert(result.error);return;}
      filteredMapped=result.filteredMapped; cleanRows=result.cleanRows;
      document.getElementById('spinner-wrap').style.display='none';
      document.getElementById('results-wrap').style.display='block';
      const s=result.stats;
      const card = (lbl,val,color) => '<div class="ocu-kpi"><div class="ocu-kpi-label">'+lbl+'</div><div class="ocu-kpi-value"'+(color?' style="color:'+color+'"':'')+'>'+val+'</div></div>';
      document.getElementById('stats-grid').innerHTML =
        card('Total records', s.total) +
        card('Kept', s.kept, '#1a7a4a') +
        card('Filtered out', s.filtered, '#c0392b') +
        card('Lists detected', s.lists) +
        card('Caught by memory', s.memCaught, '#2471a3');
      const chips=document.getElementById('list-chips');
      Object.entries(result.listsSeen||{}).forEach(([name,v])=>{
        chips.innerHTML+=\`<div class="ocu-card" style="padding:8px 12px;font-size:12px;margin:0"><div style="font-weight:600;margin-bottom:3px;color:var(--ocu-text-1)">\${name}</div><div style="display:flex;gap:12px"><span style="color:#1a7a4a">Kept: \${v.keep}</span><span style="color:#c0392b">Filtered: \${v.rem}</span></div></div>\`;
      });
      renderTable('rem-head','rem-body',filteredMapped.slice(0,50),Object.keys(filteredMapped[0]||{}));
      renderTable('cln-head','cln-body',cleanRows.slice(0,50),Object.keys(cleanRows[0]||{}));
    }
    function renderTable(hId,bId,rows,cols){
      const thead=document.getElementById(hId),tbody=document.getElementById(bId);
      thead.innerHTML='';tbody.innerHTML='';
      if(!rows.length){tbody.innerHTML='<tr><td colspan="99" style="color:#aaa;padding:12px">No records</td></tr>';cols.forEach(c=>{const th=document.createElement('th');th.textContent=c;thead.appendChild(th);});return;}
      cols.forEach(c=>{const th=document.createElement('th');th.textContent=c;thead.appendChild(th);});
      rows.forEach(r=>{const tr=document.createElement('tr');cols.forEach(c=>{const td=document.createElement('td');td.textContent=r[c]||'';tr.appendChild(td);});tbody.appendChild(tr);});
    }
    function toCSV(rows){if(!rows.length)return'';const cols=Object.keys(rows[0]);return[cols.join(','),...rows.map(r=>cols.map(c=>\`"\${(r[c]||'').toString().replace(/"/g,'""')}"\`).join(','))].join('\\n');}
    function dlCSV(name,rows){const a=document.createElement('a');a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(toCSV(rows));a.download=name;a.click();}
    document.getElementById('dl-filtered').addEventListener('click',()=>dlCSV('hudrei_filtered_reisift.csv',filteredMapped));
    document.getElementById('dl-clean').addEventListener('click',()=>dlCSV('hudrei_clean_readymode.csv',cleanRows));
    document.querySelectorAll('.tab').forEach(t=>t.addEventListener('click',()=>{
      document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(x=>x.classList.remove('active'));
      t.classList.add('active');
      document.getElementById('tab-'+t.dataset.tab).classList.add('active');
    }));
    run();
    </script>
  `, 'upload');
}

// Property upload steps (kept for backwards compat but redirects to new import flow)
function uploadPropertyStep1Page() {
  return shell('Import Property List', `
    <script>window.location.href='/import/property';</script>
  `, 'upload');
}
function uploadPropertyStep2Page() {
  return shell('Import Property List', `
    <script>window.location.href='/import/property/map';</script>
  `, 'upload');
}
function uploadPropertyStep3Page() {
  return shell('Import Property List', `
    <script>window.location.href='/import/property/preview';</script>
  `, 'upload');
}

module.exports = {
  uploadChoosePage, uploadFilterStep1Page, uploadFilterStep2Page, uploadFilterStep3Page,
  uploadPropertyStep1Page, uploadPropertyStep2Page, uploadPropertyStep3Page,
  REISIFT_FILTER_FIELDS, REISIFT_PROPERTY_FIELDS, autoMap
};
