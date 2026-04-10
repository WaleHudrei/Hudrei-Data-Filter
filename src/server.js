const { query: dbQuery, initSchema } = require('./db');
const campaigns = require('./campaigns');
const uploadRoutes = require('./routes/upload-routes');
const uploadUI = require('./ui/upload');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const Papa = require('papaparse');
const Redis = require('ioredis');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const APP_USERNAME   = process.env.APP_USERNAME   || 'hudrei';
const APP_PASSWORD   = process.env.APP_PASSWORD   || 'changeme123';
const SESSION_SECRET = process.env.SESSION_SECRET || 'hudrei-secret-key-2026';
const PORT           = process.env.PORT           || 3000;
const REDIS_URL      = process.env.REDIS_URL      || null;
const MEMORY_KEY     = 'hudrei:filtration:memory';

let redis = null;
if (REDIS_URL) {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });
  redis.on('connect', () => console.log('Redis connected'));
  redis.on('error', (e) => console.error('Redis error:', e.message));
}

async function loadMemory() {
  if (!redis) return {};
  try { const raw = await redis.get(MEMORY_KEY); return raw ? JSON.parse(raw) : {}; }
  catch (e) { console.error('loadMemory:', e.message); return {}; }
}
async function saveMemory(memory) {
  if (!redis) return;
  try { await redis.set(MEMORY_KEY, JSON.stringify(memory)); }
  catch (e) { console.error('saveMemory:', e.message); }
}
async function clearMemory() {
  if (!redis) return;
  try { await redis.del(MEMORY_KEY); } catch (e) { console.error(e.message); }
}

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({ secret: SESSION_SECRET, resave: false, saveUninitialized: false, cookie: { secure: false, maxAge: 8 * 60 * 60 * 1000 } }));

// expose helpers to upload router
app.locals.processCSV = processCSV;
app.locals.loadMemory = loadMemory;
app.locals.saveMemory = saveMemory;

// mount upload routes
app.use('/upload', uploadRoutes);

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.redirect('/login');
}

const COL = { phone:'Phone', dispo:'Log Type', listname:'Original lead file', date:'Log Time', fname:'First Name', lname:'Last Name', addr:'Address', city:'City', state:'State', zip:'Zip Code', notes:'Call Notes' };

function normDispo(v) {
  const s = (v||'').toLowerCase().trim();
  if (s.includes('transfer')||s==='lead') return 'transfer';
  if (s==='not interested'||s.includes('not interested')||s==='ni') return 'not_interested';
  if (s.includes('do not call')||s==='dnc') return 'do_not_call';
  if (s.includes('spanish')) return 'spanish_speaker';
  if (s.includes('wrong')) return 'wrong_number';
  if (s==='voicemail'||s.includes('voicemail')||s==='vm') return 'voicemail';
  if (s.includes('hung up')||s.includes('hang up')||s.includes('hangup')) return 'hung_up';
  if (s.includes('dead')) return 'dead_call';
  if (s.includes('not available')||s==='na'||s.includes('not avail')) return 'not_available';
  if (s.includes('callback')||s.includes('call back')) return 'callback';
  return 'other';
}
function phoneStatus(d) { return {transfer:'Correct',not_interested:'Correct',do_not_call:'Correct',spanish_speaker:'Correct',wrong_number:'Wrong',callback:'Correct'}[d]||''; }
function mktResult(d,l) {
  if(d==='transfer') return 'Lead';
  if(d==='not_interested') return `Not Interested — ${l}`;
  if(d==='do_not_call') return `Not Interested — ${l}`;
  if(d==='spanish_speaker') return 'Spanish Speaker';
  return '';
}
function phoneTag(d,count,l) {
  const M={voicemail:'Voicemail',hung_up:'Hung Up',dead_call:'Dead Call',not_available:'Not Available'};
  if(d==='do_not_call') return 'Do Not Call';
  if(M[d]) return count>3?`${M[d]} — ${l}`:'';
  if(d==='not_interested') return count>=3?`Not Interested — ${l}`:'';
  return '';
}
function stripTime(val) {
  if(!val) return '';
  const s=String(val).trim();
  const m=s.match(/^(\d{2}\/\d{2}\/\d{4})/);
  if(m){const p=m[0].split('/');return `${p[2]}-${p[0]}-${p[1]}`;}
  const m2=s.match(/^(\d{4}-\d{2}-\d{2})/);
  if(m2) return m2[0];
  const d=new Date(s);if(!isNaN(d)) return d.toISOString().split('T')[0];
  return s.split(' ')[0];
}
function memKey(list,phone){return list.toLowerCase().trim()+'||'+String(phone).replace(/\D/g,'');}

function processCSV(csvText, memory) {
  const parsed=Papa.parse(csvText,{header:true,skipEmptyLines:true});
  const rows=parsed.data;
  if(!rows.length) throw new Error('File is empty or could not be parsed.');
  const fileCount={};
  rows.forEach(r=>{
    const phone=String(r[COL.phone]||'').replace(/\D/g,'');
    const list=(r[COL.listname]||'Unknown List').trim();
    if(!phone||phone==='0') return;
    const k=memKey(list,phone);
    fileCount[k]=(fileCount[k]||0)+1;
  });
  const cleanRows=[],filteredRows=[];
  let memCaught=0;
  const listsSeen={},processedKeys={};
  rows.forEach(r=>{
    const phone=String(r[COL.phone]||'').replace(/\D/g,'');
    const list=(r[COL.listname]||'Unknown List').trim();
    const dispoRaw=r[COL.dispo]||'';
    const dispo=normDispo(dispoRaw);
    const dateRaw=r[COL.date]||'';
    if(!phone||phone==='0') return;
    const mkey=memKey(list,phone);
    if(processedKeys[mkey]) return;
    processedKeys[mkey]=true;
    const countInFile=fileCount[mkey]||1;
    const prevCount=memory[mkey]?memory[mkey].count:0;
    const cumCount=prevCount+countInFile;
    memory[mkey]={count:cumCount,lastDispo:dispoRaw};
    if(!listsSeen[list]) listsSeen[list]={keep:0,rem:0,dispositions:{}};
    listsSeen[list].dispositions[dispo]=(listsSeen[list].dispositions[dispo]||0)+1;
    const tag=phoneTag(dispo,cumCount,list);
    const status=phoneStatus(dispo);
    const mkt=mktResult(dispo,list);
    const dateClean=stripTime(dateRaw);
    const ALWAYS_REM=new Set(['transfer','do_not_call','wrong_number','spanish_speaker']);
    let action='keep',byMem=false,caughtByMem=false;
    if(ALWAYS_REM.has(dispo)){action='remove';}
    else if(dispo==='not_interested'&&cumCount>=3){action='remove';if(prevCount<3)byMem=true;}
    else if(['voicemail','hung_up','dead_call','not_available'].includes(dispo)&&cumCount>3){action='remove';if(prevCount<=3)byMem=true;}
    if(byMem){memCaught++;caughtByMem=true;}
    if(action==='remove') listsSeen[list].rem++; else listsSeen[list].keep++;
    const enriched={'List Name (REISift Campaign)':list,'First Name':r[COL.fname]||'','Last Name':r[COL.lname]||'','Address':r[COL.addr]||'','City':r[COL.city]||'','State':r[COL.state]||'','Zip Code':r[COL.zip]||'','Phone':r[COL.phone]||'','Disposition':dispoRaw,'Call Log Count':cumCount,'Call Log Date':dateClean,'Phone Status':status,'Phone Tag':tag,'Marketing Results':mkt,'Cold Call Campaign Name':list,'Call Notes':r[COL.notes]||'','Action':action};
    if(action==='remove') filteredRows.push(enriched); else cleanRows.push(enriched);
  });
  return {cleanRows,filteredRows,listsSeen,memCaught,totalRows:rows.length,memory};
}

function toCSV(rows) {
  if(!rows.length) return '';
  const cols=Object.keys(rows[0]).filter(c=>!c.startsWith('_'));
  return [cols.join(','),...rows.map(r=>cols.map(c=>`"${(r[c]||'').toString().replace(/"/g,'""')}"`).join(','))].join('\n');
}

app.get('/login',(req,res)=>{
  const error=req.query.error?'Invalid username or password.':'';
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HudREI Filtration Bot</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f4f0;display:flex;align-items:center;justify-content:center;min-height:100vh}.box{background:#fff;border:1px solid #e0dfd8;border-radius:12px;padding:2.5rem 2rem;width:100%;max-width:380px}.logo{font-size:15px;font-weight:600;color:#1a1a1a;margin-bottom:14px}.logo span{color:#888;font-weight:400}h1{font-size:22px;font-weight:500;margin-bottom:.25rem}.sub{font-size:13px;color:#888;margin-bottom:1.75rem}label{font-size:13px;color:#555;display:block;margin-bottom:4px}input{width:100%;padding:9px 12px;border:1px solid #ddd;border-radius:8px;font-size:14px;background:#fafaf8;color:#1a1a1a;margin-bottom:1rem;font-family:inherit}input:focus{outline:none;border-color:#888}button{width:100%;padding:10px;background:#1a1a1a;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer;font-family:inherit}button:hover{background:#333}.error{background:#fff0f0;border:1px solid #f5c5c5;border-radius:8px;padding:9px 12px;font-size:13px;color:#c0392b;margin-bottom:1rem}</style></head><body><div class="box"><div class="logo">HudREI LLC <span>/ Data Team</span></div><h1>List Filtration Bot</h1><p class="sub">Sign in to access the filtration tool</p>${error?`<div class="error">${error}</div>`:''}<form method="POST" action="/login"><label>Username</label><input type="text" name="username" autofocus><label>Password</label><input type="password" name="password"><button type="submit">Sign in</button></form></div></body></html>`);
});

app.post('/login',(req,res)=>{
  const{username,password}=req.body;
  if(username===APP_USERNAME&&password===APP_PASSWORD){req.session.authenticated=true;res.redirect('/');}
  else res.redirect('/login?error=1');
});

app.get('/logout',(req,res)=>{req.session.destroy();res.redirect('/login');});

app.get('/',requireAuth,async(req,res)=>{
  const memory=await loadMemory();
  const memSize=Object.keys(memory).length;
  const listCount=new Set(Object.keys(memory).map(k=>k.split('||')[0])).size;
  const persistent=!!redis;
  const memStatus=persistent
    ?`<span style="color:#1a7a4a;font-size:12px">&#10003; Memory is persistent — Redis connected</span>`
    :`<span style="color:#c07000;font-size:12px">&#9888; Redis not connected — memory will reset on server restart</span>`;
  res.send(shell('List Filtration Bot', `
    <h2 style="font-size:20px;font-weight:500;margin-bottom:4px">List Filtration Bot</h2>
    <p style="font-size:13px;color:#888;margin-bottom:1.75rem">Drop a Readymode call log export. Counts are calculated by the bot. Output is ready for REISift import.</p>
    <div id="error-banner" style="display:none;background:#fff0f0;border:1px solid #f5c5c5;border-radius:8px;padding:10px 14px;font-size:13px;color:#c0392b;margin-bottom:1rem"></div>
    <div class="card">
      <div class="sec-lbl" style="margin-bottom:10px">Upload call log export</div>
      <div class="drop-zone" id="drop-zone"><strong style="font-size:15px">Drop Readymode CSV here or click to browse</strong><p style="font-size:12px;color:#888;margin-top:5px">Phone · Log Type · Original lead file · Log Time · First/Last Name · Address · City · State · Zip Code</p></div>
      <input type="file" id="file-input" accept=".csv" style="display:none">
      <div id="upload-spinner" style="display:none;align-items:center;gap:8px;font-size:13px;color:#888;padding:10px 0"><div class="spinner"></div> Processing…</div>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:1rem;border-top:1px solid #f0efe9;margin-top:1rem">
        <div style="font-size:12px;padding:4px 10px;background:#f5f4f0;border:1px solid #e0dfd8;border-radius:6px;color:#888">Lists in memory: <b id="m-lists" style="color:#1a1a1a">${listCount}</b></div>
        <div style="font-size:12px;padding:4px 10px;background:#f5f4f0;border:1px solid #e0dfd8;border-radius:6px;color:#888">Numbers tracked: <b id="m-phones" style="color:#1a1a1a">${memSize}</b></div>
        ${memStatus}
        <button onclick="window.location='/memory/export'" style="display:inline-flex;align-items:center;padding:6px 12px;font-size:12px;border-radius:7px;border:1px solid #ddd;background:#fff;color:#1a1a1a;cursor:pointer;font-family:inherit">Export memory backup</button>
        <label style="display:inline-flex;align-items:center;padding:6px 12px;font-size:12px;border-radius:7px;border:1px solid #ddd;background:#fff;color:#1a1a1a;cursor:pointer;font-family:inherit">Import memory backup<input type="file" id="mem-file-input" accept=".json" style="display:none"></label>
        <button id="btn-clear" style="display:inline-flex;align-items:center;padding:6px 12px;font-size:12px;border-radius:7px;border:1px solid #f5c5c5;background:#fff;color:#c0392b;cursor:pointer;font-family:inherit">Clear all memory</button>
      </div>
    </div>
    <div id="results" style="display:none">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:1.25rem">
        <div style="background:#f5f4f0;border-radius:8px;padding:12px 14px"><div style="font-size:12px;color:#888;margin-bottom:4px">Total records</div><div style="font-size:24px;font-weight:500" id="s-total">0</div></div>
        <div style="background:#f5f4f0;border-radius:8px;padding:12px 14px"><div style="font-size:12px;color:#888;margin-bottom:4px">Lists detected</div><div style="font-size:24px;font-weight:500;color:#9a6800" id="s-lists">0</div></div>
        <div style="background:#f5f4f0;border-radius:8px;padding:12px 14px"><div style="font-size:12px;color:#888;margin-bottom:4px">Kept</div><div style="font-size:24px;font-weight:500;color:#1a7a4a" id="s-keep">0</div></div>
        <div style="background:#f5f4f0;border-radius:8px;padding:12px 14px"><div style="font-size:12px;color:#888;margin-bottom:4px">Filtered out</div><div style="font-size:24px;font-weight:500;color:#c0392b" id="s-rem">0</div></div>
        <div style="background:#f5f4f0;border-radius:8px;padding:12px 14px"><div style="font-size:12px;color:#888;margin-bottom:4px">Caught by memory</div><div style="font-size:24px;font-weight:500;color:#2471a3" id="s-mem">0</div></div>
      </div>
      <div id="list-chips" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:1.25rem"></div>
      <div class="card" style="padding:1rem 1.25rem">
        <div class="tabs"><button class="tab active" data-tab="filtered">Filtered → REISift</button><button class="tab" data-tab="clean">Clean → Readymode</button></div>
        <div id="tab-filtered" class="tab-panel active"><p style="font-size:12px;color:#888;background:#f5f4f0;border-radius:8px;padding:8px 12px;margin-bottom:10px">Upload this file to REISift to update Phone Status, Phone Tag, and Marketing Results per list.</p><div class="tbl-wrap"><table><thead><tr id="rem-head"></tr></thead><tbody id="rem-body"></tbody></table></div></div>
        <div id="tab-clean" class="tab-panel"><p style="font-size:12px;color:#888;background:#f5f4f0;border-radius:8px;padding:8px 12px;margin-bottom:10px">These records passed all filters. Re-upload to Readymode per list.</p><div class="tbl-wrap"><table><thead><tr id="cln-head"></tr></thead><tbody id="cln-body"></tbody></table></div></div>
        <div style="display:flex;gap:8px;margin-top:1rem;flex-wrap:wrap">
          <a style="display:inline-flex;padding:8px 16px;background:#1a1a1a;color:#fff;border-radius:8px;font-size:13px;font-weight:500;text-decoration:none" href="/download/filtered">Download filtered records (REISift update)</a>
          <a style="display:inline-flex;padding:8px 16px;border:1px solid #ddd;background:#fff;color:#1a1a1a;border-radius:8px;font-size:13px;text-decoration:none" href="/download/clean">Download clean list (Readymode re-upload)</a>
        </div>
      </div>
    </div>
    <div class="card" style="margin-top:1.5rem">
      <div class="sec-lbl" style="margin-bottom:10px">SOP rules reference</div>
      <table style="width:100%;font-size:12px;border-collapse:collapse">
        <thead><tr><th style="text-align:left;padding:6px 10px;font-weight:500;color:#888;border-bottom:1px solid #f0efe9;font-size:11px">Disposition</th><th style="text-align:left;padding:6px 10px;font-weight:500;color:#888;border-bottom:1px solid #f0efe9;font-size:11px">Threshold</th><th style="text-align:left;padding:6px 10px;font-weight:500;color:#888;border-bottom:1px solid #f0efe9;font-size:11px">Action</th><th style="text-align:left;padding:6px 10px;font-weight:500;color:#888;border-bottom:1px solid #f0efe9;font-size:11px">Phone status</th><th style="text-align:left;padding:6px 10px;font-weight:500;color:#888;border-bottom:1px solid #f0efe9;font-size:11px">Phone tag</th></tr></thead>
        <tbody>
          <tr><td style="padding:6px 10px;border-bottom:1px solid #f8f7f4">Transfer</td><td style="padding:6px 10px;border-bottom:1px solid #f8f7f4">Any</td><td style="padding:6px 10px;border-bottom:1px solid #f8f7f4"><span style="display:inline-block;font-size:11px;padding:2px 8px;border-radius:4px;font-weight:500;background:#fdf0f0;color:#c0392b">Remove — lead</span></td><td style="padding:6px 10px;border-bottom:1px solid #f8f7f4">Correct</td><td style="padding:6px 10px;border-bottom:1px solid #f8f7f4">—</td></tr>
          <tr><td style="padding:6px 10px;border-bottom:1px solid #f8f7f4">Not Interested</td><td style="padding:6px 10px;border-bottom:1px solid #f8f7f4">3+ logs</td><td style="padding:6px 10px;border-bottom:1px solid #f8f7f4"><span style="display:inline-block;font-size:11px;padding:2px 8px;border-radius:4px;font-weight:500;background:#fdf0f0;color:#c0392b">Remove</span></td><td style="padding:6px 10px;border-bottom:1px solid #f8f7f4">Correct</td><td style="padding:6px 10px;border-bottom:1px solid #f8f7f4">Not Interested — [List]</td></tr>
          <tr><td style="padding:6px 10px;border-bottom:1px solid #f8f7f4">Do Not Call</td><td style="padding:6px 10px;border-bottom:1px solid #f8f7f4">Any</td><td style="padding:6px 10px;border-bottom:1px solid #f8f7f4"><span style="display:inline-block;font-size:11px;padding:2px 8px;border-radius:4px;font-weight:500;background:#fdf0f0;color:#c0392b">Remove</span></td><td style="padding:6px 10px;border-bottom:1px solid #f8f7f4">Correct</td><td style="padding:6px 10px;border-bottom:1px solid #f8f7f4">Do Not Call</td></tr>
          <tr><td style="padding:6px 10px;border-bottom:1px solid #f8f7f4">Wrong Number</td><td style="padding:6px 10px;border-bottom:1px solid #f8f7f4">Any</td><td style="padding:6px 10px;border-bottom:1px solid #f8f7f4"><span style="display:inline-block;font-size:11px;padding:2px 8px;border-radius:4px;font-weight:500;background:#fdf0f0;color:#c0392b">Remove</span></td><td style="padding:6px 10px;border-bottom:1px solid #f8f7f4">Wrong</td><td style="padding:6px 10px;border-bottom:1px solid #f8f7f4">—</td></tr>
          <tr><td style="padding:6px 10px;border-bottom:1px solid #f8f7f4">Spanish Speaker</td><td style="padding:6px 10px;border-bottom:1px solid #f8f7f4">Any</td><td style="padding:6px 10px;border-bottom:1px solid #f8f7f4"><span style="display:inline-block;font-size:11px;padding:2px 8px;border-radius:4px;font-weight:500;background:#fdf0f0;color:#c0392b">Remove</span></td><td style="padding:6px 10px;border-bottom:1px solid #f8f7f4">Correct</td><td style="padding:6px 10px;border-bottom:1px solid #f8f7f4">—</td></tr>
          <tr><td style="padding:6px 10px;border-bottom:1px solid #f8f7f4">Voicemail</td><td style="padding:6px 10px;border-bottom:1px solid #f8f7f4">4+ logs</td><td style="padding:6px 10px;border-bottom:1px solid #f8f7f4"><span style="display:inline-block;font-size:11px;padding:2px 8px;border-radius:4px;font-weight:500;background:#fdf0f0;color:#c0392b">Remove</span></td><td style="padding:6px 10px;border-bottom:1px solid #f8f7f4">—</td><td style="padding:6px 10px;border-bottom:1px solid #f8f7f4">Voicemail — [List]</td></tr>
          <tr><td style="padding:6px 10px;border-bottom:1px solid #f8f7f4">Hung Up</td><td style="padding:6px 10px;border-bottom:1px solid #f8f7f4">4+ logs</td><td style="padding:6px 10px;border-bottom:1px solid #f8f7f4"><span style="display:inline-block;font-size:11px;padding:2px 8px;border-radius:4px;font-weight:500;background:#fdf0f0;color:#c0392b">Remove</span></td><td style="padding:6px 10px;border-bottom:1px solid #f8f7f4">—</td><td style="padding:6px 10px;border-bottom:1px solid #f8f7f4">Hung Up — [List]</td></tr>
          <tr><td style="padding:6px 10px;border-bottom:1px solid #f8f7f4">Dead Call</td><td style="padding:6px 10px;border-bottom:1px solid #f8f7f4">4+ logs</td><td style="padding:6px 10px;border-bottom:1px solid #f8f7f4"><span style="display:inline-block;font-size:11px;padding:2px 8px;border-radius:4px;font-weight:500;background:#fdf0f0;color:#c0392b">Remove</span></td><td style="padding:6px 10px;border-bottom:1px solid #f8f7f4">—</td><td style="padding:6px 10px;border-bottom:1px solid #f8f7f4">Dead Call — [List]</td></tr>
          <tr><td style="padding:6px 10px;border-bottom:1px solid #f8f7f4">Not Available</td><td style="padding:6px 10px;border-bottom:1px solid #f8f7f4">4+ logs</td><td style="padding:6px 10px;border-bottom:1px solid #f8f7f4"><span style="display:inline-block;font-size:11px;padding:2px 8px;border-radius:4px;font-weight:500;background:#fdf0f0;color:#c0392b">Remove</span></td><td style="padding:6px 10px;border-bottom:1px solid #f8f7f4">—</td><td style="padding:6px 10px;border-bottom:1px solid #f8f7f4">Not Available — [List]</td></tr>
          <tr><td style="padding:6px 10px">Callback</td><td style="padding:6px 10px">Any</td><td style="padding:6px 10px"><span style="display:inline-block;font-size:11px;padding:2px 8px;border-radius:4px;font-weight:500;background:#e8f5ee;color:#1a7a4a">Keep</span></td><td style="padding:6px 10px">Correct</td><td style="padding:6px 10px">—</td></tr>
        </tbody>
      </table>
    </div>
    <script>
    const COLS=['List Name (REISift Campaign)','First Name','Last Name','Address','City','State','Zip Code','Phone','Disposition','Call Log Count','Action','Phone Tag','Phone Status','Marketing Results'];
    function showError(msg){const b=document.getElementById('error-banner');b.textContent=msg;b.style.display='block';setTimeout(()=>b.style.display='none',6000);}
    async function handleFile(file){
      if(!file.name.endsWith('.csv')){showError('Please upload a CSV file.');return;}
      const form=new FormData();form.append('csvfile',file);
      document.getElementById('upload-spinner').style.display='flex';
      document.getElementById('drop-zone').style.opacity='0.6';
      try{
        const res=await fetch('/process',{method:'POST',body:form});
        const data=await res.json();
        if(!res.ok||data.error){showError(data.error||'Processing failed.');return;}
        const s=data.stats;
        document.getElementById('s-total').textContent=s.totalRows;
        document.getElementById('s-lists').textContent=s.listsCount;
        document.getElementById('s-keep').textContent=s.kept;
        document.getElementById('s-rem').textContent=s.filtered;
        document.getElementById('s-mem').textContent=s.memCaught;
        document.getElementById('m-lists').textContent=data.listCount;
        document.getElementById('m-phones').textContent=data.memSize;
        const chips=document.getElementById('list-chips');chips.innerHTML='';
        Object.entries(data.listsSeen).forEach(([name,v])=>{
          const top=Object.entries(v.dispositions).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([k,c])=>k+':'+c).join(' · ');
          chips.innerHTML+=\`<div style="background:#fff;border:1px solid #e0dfd8;border-radius:8px;padding:8px 12px;font-size:12px;min-width:160px"><div style="font-weight:500;font-size:13px;margin-bottom:4px">\${name}</div><div style="display:flex;justify-content:space-between"><span style="color:#1a7a4a">Kept: \${v.keep}</span><span style="color:#c0392b">Filtered: \${v.rem}</span></div><div style="font-size:11px;color:#aaa;margin-top:3px">\${top}</div></div>\`;
        });
        renderTable('rem-head','rem-body',data.preview.filtered);
        renderTable('cln-head','cln-body',data.preview.clean);
        document.getElementById('results').style.display='block';
        window.scrollTo({top:document.getElementById('results').offsetTop-20,behavior:'smooth'});
      }catch(e){showError('Upload failed: '+e.message);}
      finally{document.getElementById('upload-spinner').style.display='none';document.getElementById('drop-zone').style.opacity='1';}
    }
    function renderTable(hId,bId,rows){
      const thead=document.getElementById(hId),tbody=document.getElementById(bId);
      thead.innerHTML='';tbody.innerHTML='';
      if(!rows.length){tbody.innerHTML='<tr><td colspan="99" style="color:#aaa;padding:16px">No records</td></tr>';COLS.forEach(c=>{const th=document.createElement('th');th.textContent=c;thead.appendChild(th);});return;}
      COLS.forEach(c=>{const th=document.createElement('th');th.textContent=c;thead.appendChild(th);});
      rows.forEach(r=>{const tr=document.createElement('tr');COLS.forEach(c=>{const td=document.createElement('td');const v=r[c]!==undefined?r[c]:'';if(c==='Action'){const cls=v==='remove'?'b-remove':'b-keep';td.innerHTML=\`<span class="badge \${cls}">\${v}</span>\`;}else td.textContent=v;tr.appendChild(td);});tbody.appendChild(tr);});
    }
    document.getElementById('file-input').addEventListener('change',e=>{if(e.target.files[0])handleFile(e.target.files[0]);});
    const dz=document.getElementById('drop-zone');
    dz.addEventListener('click',()=>document.getElementById('file-input').click());
    dz.addEventListener('dragover',e=>{e.preventDefault();dz.style.borderColor='#888';});
    dz.addEventListener('dragleave',()=>dz.style.borderColor='');
    dz.addEventListener('drop',e=>{e.preventDefault();dz.style.borderColor='';if(e.dataTransfer.files[0])handleFile(e.dataTransfer.files[0]);});
    document.getElementById('mem-file-input').addEventListener('change',async e=>{
      const f=e.target.files[0];if(!f)return;
      const form=new FormData();form.append('memfile',f);
      const res=await fetch('/memory/import',{method:'POST',body:form});
      const data=await res.json();
      if(data.success){document.getElementById('m-phones').textContent=data.count;alert('Memory imported — '+data.count+' records.');}
      else showError(data.error||'Import failed.');
    });
    document.getElementById('btn-clear').addEventListener('click',async()=>{
      if(!confirm('Clear ALL memory? This cannot be undone.'))return;
      await fetch('/memory/clear',{method:'POST'});
      document.getElementById('m-phones').textContent='0';
      document.getElementById('m-lists').textContent='0';
    });
    document.querySelectorAll('.tab').forEach(t=>t.addEventListener('click',()=>{
      document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(x=>x.classList.remove('active'));
      t.classList.add('active');
      document.getElementById('tab-'+t.dataset.tab).classList.add('active');
    }));
    </script>
  `));
});

app.post('/process',requireAuth,upload.single('csvfile'),async(req,res)=>{
  try{
    if(!req.file) return res.status(400).json({error:'No file uploaded.'});
    const memory=await loadMemory();
    const result=processCSV(req.file.buffer.toString('utf8'),memory);
    await saveMemory(result.memory);
    req.session.lastResult={cleanRows:result.cleanRows,filteredRows:result.filteredRows};
    const allRows=[...result.cleanRows,...result.filteredRows];
    const runId=await saveRunToDB(req.file.originalname||'upload.csv',{totalRows:result.totalRows,listsCount:Object.keys(result.listsSeen).length,kept:result.cleanRows.length,filtered:result.filteredRows.length,memCaught:result.memCaught},result.listsSeen,allRows);
    if(runId) console.log('Saved to DB, run ID:',runId);
    const newMemSize=Object.keys(result.memory).length;
    const newListCount=new Set(Object.keys(result.memory).map(k=>k.split('||')[0])).size;
    res.json({success:true,stats:{totalRows:result.totalRows,listsCount:Object.keys(result.listsSeen).length,kept:result.cleanRows.length,filtered:result.filteredRows.length,memCaught:result.memCaught},listsSeen:result.listsSeen,memSize:newMemSize,listCount:newListCount,preview:{filtered:result.filteredRows.slice(0,50),clean:result.cleanRows.slice(0,50)}});
  }catch(err){res.status(500).json({error:err.message});}
});

app.get('/download/filtered',requireAuth,(req,res)=>{
  if(!req.session.lastResult) return res.redirect('/');
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition','attachment; filename="hudrei_filtered_reisift.csv"');
  res.send(toCSV(req.session.lastResult.filteredRows));
});

app.get('/download/clean',requireAuth,(req,res)=>{
  if(!req.session.lastResult) return res.redirect('/');
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition','attachment; filename="hudrei_clean_list.csv"');
  res.send(toCSV(req.session.lastResult.cleanRows));
});

app.get('/memory/export',requireAuth,async(req,res)=>{
  const memory=await loadMemory();
  res.setHeader('Content-Type','application/json');
  res.setHeader('Content-Disposition','attachment; filename="hudrei_memory.json"');
  res.send(JSON.stringify(memory,null,2));
});

app.post('/memory/import',requireAuth,upload.single('memfile'),async(req,res)=>{
  try{const data=JSON.parse(req.file.buffer.toString('utf8'));await saveMemory(data);res.json({success:true,count:Object.keys(data).length});}
  catch(e){res.status(400).json({error:'Invalid memory file.'});}
});

app.post('/memory/clear',requireAuth,async(req,res)=>{await clearMemory();res.json({success:true});});

app.listen(PORT,()=>{
  console.log(`HudREI Filtration Bot v2 running on port ${PORT}`);
  console.log(`Redis: ${redis?'connected':'not configured'}`);
});

// ── DB Write: save filtration run + results + upsert properties/phones ───────
async function saveRunToDB(filename, stats, listsSeen, allRows) {
  if (!process.env.DATABASE_URL) return null;
  try {
    await initSchema();

    // Insert filtration run record
    const runRes = await dbQuery(
      `INSERT INTO filtration_runs (filename, total_records, lists_detected, records_kept, records_filtered, caught_by_memory)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [filename, stats.totalRows, stats.listsCount, stats.kept, stats.filtered, stats.memCaught]
    );
    const runId = runRes.rows[0].id;

    for (const row of allRows) {
      try {
        // Upsert market
        const stateCode = (row['State'] || '').trim().toUpperCase();
        if (stateCode) {
          await dbQuery(
            `INSERT INTO markets (name, state_code, state_name)
             VALUES ($1,$2,$2) ON CONFLICT (state_code) DO NOTHING`,
            [`${stateCode} Market`, stateCode]
          );
        }

        // Upsert list
        const listName = row['List Name (REISift Campaign)'] || '';
        let listId = null;
        if (listName) {
          const lr = await dbQuery(
            `INSERT INTO lists (list_name) VALUES ($1)
             ON CONFLICT (list_name) DO UPDATE SET list_name=EXCLUDED.list_name RETURNING id`,
            [listName]
          );
          listId = lr.rows[0].id;
        }

        // Upsert property
        const street = (row['Address'] || '').trim();
        const city   = (row['City'] || '').trim();
        const zip    = (row['Zip Code'] || '').trim();
        let propertyId = null;
        if (street && city && stateCode) {
          const marketRes = await dbQuery(`SELECT id FROM markets WHERE state_code=$1`, [stateCode]);
          const marketId = marketRes.rows[0]?.id || null;
          const pr = await dbQuery(
            `INSERT INTO properties (street, city, state_code, zip_code, market_id)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (street, city, state_code, zip_code)
             DO UPDATE SET updated_at=NOW() RETURNING id`,
            [street, city, stateCode, zip, marketId]
          );
          propertyId = pr.rows[0].id;

          // Link property to list
          if (listId) {
            await dbQuery(
              `INSERT INTO property_lists (property_id, list_id)
               VALUES ($1,$2) ON CONFLICT DO NOTHING`,
              [propertyId, listId]
            );
          }
        }

        // Upsert contact
        const firstName = row['First Name'] || '';
        const lastName  = row['Last Name']  || '';
        let contactId = null;
        if (firstName || lastName) {
          const cr = await dbQuery(
            `INSERT INTO contacts (first_name, last_name)
             VALUES ($1,$2) RETURNING id`,
            [firstName, lastName]
          );
          contactId = cr.rows[0].id;

          if (propertyId && contactId) {
            await dbQuery(
              `INSERT INTO property_contacts (property_id, contact_id, primary_contact)
               VALUES ($1,$2,true) ON CONFLICT DO NOTHING`,
              [propertyId, contactId]
            );
          }
        }

        // Upsert phone
        const phoneNum = String(row['Phone'] || '').replace(/\D/g,'');
        let phoneId = null;
        if (phoneNum && contactId) {
          const phr = await dbQuery(
            `INSERT INTO phones (contact_id, phone_number, phone_status, phone_tag)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (contact_id, phone_number)
             DO UPDATE SET phone_status=$3, phone_tag=$4, updated_at=NOW() RETURNING id`,
            [contactId, phoneNum, row['Phone Status']||'', row['Phone Tag']||'']
          );
          phoneId = phr.rows[0].id;

          // Insert call log entry
          if (row['Disposition']) {
            await dbQuery(
              `INSERT INTO call_logs (phone_id, list_id, property_id, disposition, disposition_normalized, call_date, campaign_name)
               VALUES ($1,$2,$3,$4,$5,$6,$7)`,
              [phoneId, listId, propertyId, row['Disposition'], normDispo(row['Disposition']), row['Call Log Date']||null, listName]
            );
          }

          // Marketing touch
          if (propertyId) {
            await dbQuery(
              `INSERT INTO marketing_touches (property_id, contact_id, channel, campaign_name, list_id, touch_date, outcome)
               VALUES ($1,$2,'cold_call',$3,$4,$5,$6)`,
              [propertyId, contactId, listName, listId, row['Call Log Date']||null, row['Disposition']||'']
            );
          }
        }

        // Save filtration result
        await dbQuery(
          `INSERT INTO filtration_results (run_id, phone_number, list_name, property_id, phone_id, disposition, disposition_normalized, cumulative_count, action, phone_status, phone_tag, marketing_result)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [runId, phoneNum, listName, propertyId, phoneId, row['Disposition']||'', normDispo(row['Disposition']||''), row['Call Log Count']||0, row['Action']||'keep', row['Phone Status']||'', row['Phone Tag']||'', row['Marketing Results']||'']
        );

      } catch (rowErr) {
        console.error('Row save error:', rowErr.message);
      }
    }

    return runId;
  } catch (err) {
    console.error('saveRunToDB error:', err.message);
    return null;
  }
}


// ── Upload Flow Routes ────────────────────────────────────────────────────────

app.get('/upload', requireAuth, (req, res) => res.send(uploadUI.uploadChoosePage()));
app.get('/upload/filter', requireAuth, (req, res) => res.send(uploadUI.uploadFilterStep1Page()));
app.get('/upload/filter/map', requireAuth, (req, res) => res.send(uploadUI.uploadFilterStep2Page()));
app.get('/upload/filter/review', requireAuth, (req, res) => res.send(uploadUI.uploadFilterStep3Page()));
app.get('/upload/property', requireAuth, (req, res) => res.send(uploadUI.uploadPropertyStep1Page()));
app.get('/upload/property/map', requireAuth, (req, res) => res.send(uploadUI.uploadPropertyStep2Page()));
app.get('/upload/property/review', requireAuth, (req, res) => res.send(uploadUI.uploadPropertyStep3Page()));

// Parse CSV — return columns + first rows + auto-mapping (client-side session storage)
app.post('/upload/filter/parse', requireAuth, upload.single('csvfile'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const Papa = require('papaparse');
    const parsed = Papa.parse(req.file.buffer.toString('utf8'), { header: true, skipEmptyLines: true });
    const columns = parsed.meta.fields || [];
    const rows = parsed.data;
    const autoMap = uploadUI.autoMap(columns, uploadUI.REISIFT_FILTER_FIELDS);
    res.json({ columns, rows, autoMap, filename: req.file.originalname, total: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/upload/property/parse', requireAuth, upload.single('csvfile'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const Papa = require('papaparse');
    const parsed = Papa.parse(req.file.buffer.toString('utf8'), { header: true, skipEmptyLines: true });
    const columns = parsed.meta.fields || [];
    const rows = parsed.data;
    const autoMap = uploadUI.autoMap(columns, uploadUI.REISIFT_PROPERTY_FIELDS);
    res.json({ columns, rows, autoMap, filename: req.file.originalname, total: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Process filter + apply mapping → return mapped filtered rows
app.post('/upload/filter/process', requireAuth, async (req, res) => {
  try {
    const { rows, mapping, filename } = req.body;
    if (!rows || !mapping) return res.status(400).json({ error: 'Missing data.' });

    // Reconstruct CSV text from rows and run through processCSV
    const Papa = require('papaparse');
    const csvText = Papa.unparse(rows);
    const memory = await loadMemory();
    const result = processCSV(csvText, memory);
    await saveMemory(result.memory);
    req.session.lastResult = { cleanRows: result.cleanRows, filteredRows: result.filteredRows };

    // Apply column mapping to filtered rows
    const filteredMapped = result.filteredRows.map(r => {
      const out = {};
      // Internal field name → REISift field name mapping
      const internalToReisift = {
        'Call Log Date':     mapping['Call Log Date']     || 'Call Log Date',
        'Phone':             mapping['Phone']             || 'Phone',
        'Phone Tag':         mapping['Phone Tag']         || 'Phone Tag',
        'Call Log Count':    mapping['Call Log Count']    || 'Call Log Count',
        'Marketing Results': mapping['Marketing Result']  || 'Marketing Result',
        'Phone Status':      mapping['Phone Status']      || 'Phone Status',
        'Call Notes':        mapping['Call Notes']        || 'Call Notes',
        'First Name':        mapping['First Name']        || 'First Name',
        'Last Name':         mapping['Last Name']         || 'Last Name',
        'City':              mapping['City']              || 'City',
        'Address':           mapping['Address']           || 'Address',
        'Zip Code':          mapping['Zip Code']          || 'Zip Code',
        'State':             mapping['State']             || 'State',
      };
      Object.entries(internalToReisift).forEach(([internal, reisift]) => {
        if (r[internal] !== undefined) out[reisift] = r[internal];
      });
      return out;
    });

    res.json({
      filteredMapped,
      cleanRows: result.cleanRows,
      stats: {
        total: result.totalRows,
        kept: result.cleanRows.length,
        filtered: result.filteredRows.length,
        lists: Object.keys(result.listsSeen).length,
        memCaught: result.memCaught,
      },
      listsSeen: result.listsSeen,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Campaign Routes ───────────────────────────────────────────────────────────

// Update manual count
app.post('/campaigns/:id/count', requireAuth, async (req, res) => {
  try {
    const count = parseInt(req.body.manual_count) || 0;
    await campaigns.initCampaignSchema();
    const { query: dbQ } = require('./db');
    await dbQ('UPDATE campaigns SET manual_count=$1, updated_at=NOW() WHERE id=$2', [count, req.params.id]);
    res.redirect('/campaigns/' + req.params.id);
  } catch(e) { res.redirect('/campaigns/' + req.params.id); }
});

// List all campaigns
app.get('/campaigns', requireAuth, async (req, res) => {
  try {
    await campaigns.initCampaignSchema();
    const list = await campaigns.getCampaigns();
    res.send(campaignsPage(list));
  } catch (e) { res.status(500).send('Error: ' + e.message); }
});

// New campaign form
app.get('/campaigns/new', requireAuth, (req, res) => { res.send(newCampaignPage()); });

// Create campaign
app.post('/campaigns/new', requireAuth, async (req, res) => {
  try {
    await campaigns.initCampaignSchema();
    await campaigns.createCampaign({ ...req.body, created_by: 'team' });
    res.redirect('/campaigns');
  } catch (e) { res.redirect('/campaigns/new?error=' + encodeURIComponent(e.message)); }
});

// Campaign detail
app.get('/campaigns/:id', requireAuth, async (req, res) => {
  try {
    const c = await campaigns.getCampaign(req.params.id);
    if (!c) return res.redirect('/campaigns');
    res.send(campaignDetailPage(c));
  } catch (e) { res.status(500).send('Error: ' + e.message); }
});

// Update campaign status
app.post('/campaigns/:id/status', requireAuth, async (req, res) => {
  await campaigns.updateCampaignStatus(req.params.id, req.body.status);
  res.redirect('/campaigns/' + req.params.id);
});

// Update campaign channel
app.post('/campaigns/:id/channel', requireAuth, async (req, res) => {
  await campaigns.updateCampaignChannel(req.params.id, req.body.channel);
  res.redirect('/campaigns/' + req.params.id);
});

// Get campaigns as JSON (for upload selector)
app.get('/api/campaigns', requireAuth, async (req, res) => {
  try {
    await campaigns.initCampaignSchema();
    const list = await campaigns.getCampaigns();
    res.json(list.filter(c => c.status === 'active'));
  } catch (e) { res.json([]); }
});

// Record upload into campaign
app.post('/campaigns/:id/upload', requireAuth, upload.single('csvfile'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file.' });
    const memory = await loadMemory();
    const result = processCSV(req.file.buffer.toString('utf8'), memory);
    await saveMemory(result.memory);
    req.session.lastResult = { cleanRows: result.cleanRows, filteredRows: result.filteredRows };
    const allRows = [...result.cleanRows, ...result.filteredRows];
    const sourceList = allRows[0]?.['List Name (REISift Campaign)'] || req.file.originalname;
    await campaigns.recordUpload(req.params.id, req.file.originalname, sourceList, req.body.channel || 'cold_call', allRows);
    const newMemSize = Object.keys(result.memory).length;
    const newListCount = new Set(Object.keys(result.memory).map(k => k.split('||')[0])).size;
    res.json({
      success: true,
      redirectTo: '/campaigns/' + req.params.id,
      stats: { totalRows: result.totalRows, listsCount: Object.keys(result.listsSeen).length, kept: result.cleanRows.length, filtered: result.filteredRows.length, memCaught: result.memCaught },
      listsSeen: result.listsSeen, memSize: newMemSize, listCount: newListCount,
      preview: { filtered: result.filteredRows.slice(0, 50), clean: result.cleanRows.slice(0, 50) }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Campaign HTML Pages ───────────────────────────────────────────────────────

const STATUS_COLORS = { active: '#1a7a4a', paused: '#9a6800', completed: '#888' };
const CHANNEL_LABELS = { cold_call: 'Cold Call', sms: 'SMS' };

function campaignsPage(list) {
  const rows = list.map(c => `
    <tr onclick="location.href='/campaigns/${c.id}'" style="cursor:pointer">
      <td><strong>${c.name}</strong><br><span style="font-size:11px;color:#888">${c.list_type} · ${c.market_name}</span></td>
      <td><span class="badge" style="background:${STATUS_COLORS[c.status]}20;color:${STATUS_COLORS[c.status]}">${c.status}</span></td>
      <td><span class="badge" style="background:#e6f1fb;color:#185fa5">${CHANNEL_LABELS[c.active_channel]||c.active_channel}</span></td>
      <td>${Number(c.total_unique_numbers||0).toLocaleString()}</td>
      <td style="color:#1a7a4a">${Number(c.total_callable||0).toLocaleString()}</td>
      <td style="color:#c0392b">${Number(c.total_filtered||0).toLocaleString()}</td>
      <td>${c.upload_count||0}</td>
      <td style="font-size:11px;color:#888">${c.last_filtered_at ? new Date(c.last_filtered_at).toLocaleDateString() : '—'}</td>
    </tr>`).join('');

  return shell('Campaigns', `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.5rem">
      <div><h2 style="font-size:20px;font-weight:500;margin-bottom:3px">Campaigns</h2>
      <p style="font-size:13px;color:#888">Each campaign tracks all filtration activity for a list type in a market</p></div>
      <a href="/campaigns/new" class="btn-primary-link">+ New Campaign</a>
    </div>
    ${list.length === 0 ? `<div class="empty-state">No campaigns yet. <a href="/campaigns/new">Create your first one.</a></div>` : `
    <div class="card" style="padding:0;overflow:hidden">
      <table class="data-table">
        <thead><tr><th>Campaign</th><th>Status</th><th>Active channel</th><th>Total numbers</th><th>Callable</th><th>Filtered</th><th>Uploads</th><th>Last filtered</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`}
  `);
}

function newCampaignPage(error) {
  const LIST_TYPES = ['Vacant Property','Pre-Foreclosure','Active Liens','2+ Mortgages','Absentee Owner','Tax Delinquent','Probate','Code Violation','Pre-Probate','Other'];
  const STATES = ['IN','GA','TX','FL','OH','MI','IL','NC','TN','MO','AZ','CO','NV','PA','NY','Other'];
  return shell('New Campaign', `
    <div style="max-width:520px">
      <div style="margin-bottom:1.5rem"><a href="/campaigns" style="font-size:13px;color:#888;text-decoration:none">← Campaigns</a></div>
      <h2 style="font-size:20px;font-weight:500;margin-bottom:4px">New campaign</h2>
      <p style="font-size:13px;color:#888;margin-bottom:1.5rem">Create a campaign to start tracking filtration activity</p>
      ${error ? `<div class="error-box">${error}</div>` : ''}
      <div class="card">
        <form method="POST" action="/campaigns/new">
          <div class="form-field">
            <label>Campaign name</label>
            <input type="text" name="name" placeholder="e.g. Vacant Property Indiana 2026" required>
            <span class="field-hint">Use a clear name — this is what you'll select when uploading filtration files</span>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div class="form-field">
              <label>List type</label>
              <select name="list_type" required>
                <option value="">Select...</option>
                ${LIST_TYPES.map(t=>`<option value="${t}">${t}</option>`).join('')}
              </select>
            </div>
            <div class="form-field">
              <label>State</label>
              <select name="state_code" required>
                <option value="">Select...</option>
                ${STATES.map(s=>`<option value="${s}">${s}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="form-field">
            <label>Market name</label>
            <input type="text" name="market_name" placeholder="e.g. Indianapolis Metro" required>
          </div>
          <div class="form-field">
            <label>Active channel</label>
            <select name="active_channel">
              <option value="cold_call">Cold Call</option>
              <option value="sms">SMS</option>
            </select>
          </div>
          <div class="form-field">
            <label>Notes (optional)</label>
            <textarea name="notes" rows="2" placeholder="Any notes about this campaign..."></textarea>
          </div>
          <button type="submit" class="btn-submit">Create campaign</button>
        </form>
      </div>
    </div>
  `);
}

function campaignDetailPage(c) {
  const n = c.total_unique_numbers || 0;
  const manualCount = parseInt(c.manual_count) || 0;
  const count = manualCount > 0 ? manualCount : n;
  const connected = c.total_connected || 0;
  const callable_pct = n > 0 ? Math.round((c.total_callable / n) * 100) : 0;
  const filtered_pct = n > 0 ? Math.round((c.total_filtered / n) * 100) : 0;
  const cr   = count > 0 && connected > 0 ? ((connected / count) * 100).toFixed(2) : '0.00';
  const wPct = connected > 0 ? (((c.total_wrong_numbers||0) / connected) * 100).toFixed(2) : '0.00';
  const niPct= connected > 0 ? (((c.total_not_interested||0) / connected) * 100).toFixed(2) : '0.00';
  const lgr  = connected > 0 ? (((c.total_transfers||0) / connected) * 100).toFixed(2) : '0.00';
  const lcv  = count > 0 ? (((c.total_transfers||0) / count) * 100).toFixed(2) : '0.00';

  const uploadRows = (c.uploads||[]).map(u => `
    <tr>
      <td style="font-size:11px;color:#888">${new Date(u.uploaded_at).toLocaleDateString()} ${new Date(u.uploaded_at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</td>
      <td>${u.filename||'—'}<br><span style="font-size:11px;color:#888">${u.source_list_name||''}</span></td>
      <td><span class="badge" style="background:#e6f1fb;color:#185fa5">${CHANNEL_LABELS[u.channel]||u.channel}</span></td>
      <td>${u.total_records}</td>
      <td style="color:#1a7a4a">${u.records_kept}</td>
      <td style="color:#c0392b">${u.records_filtered}</td>
      <td style="color:#888;font-size:11px">WN:${u.wrong_numbers} VM:${u.voicemails} NI:${u.not_interested} DNC:${u.do_not_call} Lead:${u.transfers}</td>
      <td style="color:#2471a3;font-size:11px">${u.caught_by_memory} by memory</td>
    </tr>`).join('');

  const dispositionRows = (c.disposition_breakdown||[]).map(d => `
    <tr><td>${d.disposition||'unknown'}</td><td style="font-weight:500">${Number(d.count).toLocaleString()}</td></tr>`).join('');

  return shell(c.name, `
    <div style="margin-bottom:1rem"><a href="/campaigns" style="font-size:13px;color:#888;text-decoration:none">← Campaigns</a></div>
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:1.5rem;flex-wrap:wrap;gap:12px">
      <div>
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">
          <h2 style="font-size:20px;font-weight:500">${c.name}</h2>
          <span class="badge" style="background:${STATUS_COLORS[c.status]}20;color:${STATUS_COLORS[c.status]}">${c.status}</span>
        </div>
        <p style="font-size:13px;color:#888">${c.list_type} · ${c.market_name} · ${c.state_code} · ${c.upload_count} filtration uploads</p>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <form method="POST" action="/campaigns/${c.id}/status" style="display:inline">
          <select name="status" onchange="this.form.submit()" class="inline-select">
            <option ${c.status==='active'?'selected':''} value="active">Active</option>
            <option ${c.status==='paused'?'selected':''} value="paused">Paused</option>
            <option ${c.status==='completed'?'selected':''} value="completed">Completed</option>
          </select>
        </form>
        <form method="POST" action="/campaigns/${c.id}/channel" style="display:inline">
          <select name="channel" onchange="this.form.submit()" class="inline-select">
            <option ${c.active_channel==='cold_call'?'selected':''} value="cold_call">Cold Call active</option>
            <option ${c.active_channel==='sms'?'selected':''} value="sms">SMS active</option>
          </select>
        </form>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:1.25rem">
      <div class="stat-card" style="position:relative">
        <div class="stat-lbl">Count <span style="font-size:10px;color:#aaa">(dialer total)</span></div>
        <div class="stat-num">${Number(count).toLocaleString()}</div>
        <div style="font-size:11px;color:#888;margin-top:2px">${manualCount>0?'Manual entry':'Auto from uploads'}</div>
        <button onclick="document.getElementById('count-form').style.display=document.getElementById('count-form').style.display==='none'?'block':'none'" style="position:absolute;top:10px;right:10px;background:none;border:none;font-size:11px;color:#888;cursor:pointer;text-decoration:underline">edit</button>
      </div>
      <div class="stat-card"><div class="stat-lbl">Connected</div><div class="stat-num blue">${Number(connected).toLocaleString()}</div><div style="font-size:11px;color:#888;margin-top:2px">Live pickups</div></div>
      <div class="stat-card"><div class="stat-lbl">Wrong numbers</div><div class="stat-num red">${Number(c.total_wrong_numbers||0).toLocaleString()}</div><div style="font-size:11px;color:#888;margin-top:2px">Removed</div></div>
      <div class="stat-card"><div class="stat-lbl">Not interested</div><div class="stat-num" style="color:#9a6800">${Number(c.total_not_interested||0).toLocaleString()}</div><div style="font-size:11px;color:#888;margin-top:2px">Total NI</div></div>
      <div class="stat-card"><div class="stat-lbl">Leads generated</div><div class="stat-num green">${Number(c.total_transfers||0).toLocaleString()}</div><div style="font-size:11px;color:#888;margin-top:2px">Transfers</div></div>
      <div class="stat-card"><div class="stat-lbl">Callable</div><div class="stat-num green">${Number(c.total_callable||0).toLocaleString()} <span style="font-size:12px;font-weight:400;color:#888">(${callable_pct}%)</span></div><div style="font-size:11px;color:#888;margin-top:2px">Active pool</div></div>
      <div class="stat-card"><div class="stat-lbl">Filtration runs</div><div class="stat-num">${c.upload_count||0}</div><div style="font-size:11px;color:#888;margin-top:2px">Uploads</div></div>
    </div>
    <div style="background:#fff;border:1px solid #e0dfd8;border-radius:12px;padding:14px 16px;margin-bottom:1.25rem">
      <div style="font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px">Campaign KPIs</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px">
        <div style="text-align:center;padding:10px;background:#f5f4f0;border-radius:8px">
          <div style="font-size:22px;font-weight:500;color:#2471a3">${cr}%</div>
          <div style="font-size:11px;color:#888;margin-top:2px">CR</div>
          <div style="font-size:10px;color:#aaa">Connected ÷ Count</div>
        </div>
        <div style="text-align:center;padding:10px;background:#f5f4f0;border-radius:8px">
          <div style="font-size:22px;font-weight:500;color:#c0392b">${wPct}%</div>
          <div style="font-size:11px;color:#888;margin-top:2px">W#%</div>
          <div style="font-size:10px;color:#aaa">Wrong ÷ Connected</div>
        </div>
        <div style="text-align:center;padding:10px;background:#f5f4f0;border-radius:8px">
          <div style="font-size:22px;font-weight:500;color:#9a6800">${niPct}%</div>
          <div style="font-size:11px;color:#888;margin-top:2px">NI%</div>
          <div style="font-size:10px;color:#aaa">NI ÷ Connected</div>
        </div>
        <div style="text-align:center;padding:10px;background:#f5f4f0;border-radius:8px">
          <div style="font-size:22px;font-weight:500;color:#1a7a4a">${lgr}%</div>
          <div style="font-size:11px;color:#888;margin-top:2px">LGR</div>
          <div style="font-size:10px;color:#aaa">Leads ÷ Connected</div>
        </div>
        <div style="text-align:center;padding:10px;background:#f5f4f0;border-radius:8px">
          <div style="font-size:22px;font-weight:500;color:#534AB7">${lcv}%</div>
          <div style="font-size:11px;color:#888;margin-top:2px">LCV</div>
          <div style="font-size:10px;color:#aaa">Leads ÷ Count</div>
        </div>
      </div>
    </div>

    <div id="count-form" style="display:none;background:#fff;border:1px solid #e0dfd8;border-radius:10px;padding:14px 16px;margin-bottom:1rem">
      <div style="font-size:13px;font-weight:500;margin-bottom:8px">Update dialer count</div>
      <form method="POST" action="/campaigns/${c.id}/count" style="display:flex;align-items:center;gap:8px">
        <input type="number" name="manual_count" value="${manualCount||''}" placeholder="e.g. 15420" style="padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:14px;width:160px;font-family:inherit">
        <button type="submit" style="padding:7px 16px;background:#1a1a1a;color:#fff;border:none;border-radius:7px;font-size:13px;cursor:pointer;font-family:inherit">Save</button>
        <span style="font-size:12px;color:#888">Enter the total record count from Readymode for this campaign</span>
      </form>
    </div>

    <div style="display:grid;grid-template-columns:1fr 280px;gap:1.25rem;margin-bottom:1.25rem">
      <div class="card" style="padding:1rem 1.25rem">
        <div class="sec-lbl" style="margin-bottom:10px">Disposition breakdown</div>
        <table class="data-table" style="font-size:12px">
          <thead><tr><th>Disposition</th><th>Count</th></tr></thead>
          <tbody>${dispositionRows||'<tr><td colspan="2" style="color:#aaa;padding:12px">No data yet</td></tr>'}</tbody>
        </table>
      </div>
      <div class="card" style="padding:1rem 1.25rem">
        <div class="sec-lbl" style="margin-bottom:10px">Channel status</div>
        <div style="margin-bottom:10px">
          <div style="font-size:12px;color:#888;margin-bottom:3px">Cold Call</div>
          <span class="badge" style="background:${c.cold_call_status==='active'?'#e8f5ee':'#f5f4f0'};color:${c.cold_call_status==='active'?'#1a7a4a':'#888'}">${c.cold_call_status}</span>
        </div>
        <div>
          <div style="font-size:12px;color:#888;margin-bottom:3px">SMS</div>
          <span class="badge" style="background:${c.sms_status==='active'?'#e8f5ee':'#f5f4f0'};color:${c.sms_status==='active'?'#1a7a4a':'#888'}">${c.sms_status}</span>
        </div>
        <div style="margin-top:16px;padding-top:12px;border-top:1px solid #f0efe9">
          <div style="font-size:12px;color:#888;margin-bottom:3px">Wrong numbers removed</div>
          <div style="font-size:18px;font-weight:500;color:#c0392b">${Number(c.total_wrong_numbers||0).toLocaleString()}</div>
        </div>
        <div style="margin-top:12px">
          <div style="font-size:12px;color:#888;margin-bottom:3px">Voicemails accumulated</div>
          <div style="font-size:18px;font-weight:500;color:#9a6800">${Number(c.total_voicemails||0).toLocaleString()}</div>
        </div>
      </div>
    </div>

    <div class="card" style="padding:1rem 1.25rem;margin-bottom:1.25rem">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div class="sec-lbl" style="margin-bottom:0">Upload filtration file to this campaign</div>
        <select id="channel-select" class="inline-select">
          <option value="cold_call" ${c.active_channel==='cold_call'?'selected':''}>Cold Call</option>
          <option value="sms" ${c.active_channel==='sms'?'selected':''}>SMS</option>
        </select>
      </div>
      <div class="drop-zone" id="drop-zone" style="padding:1.5rem">
        <strong style="font-size:14px">Drop Readymode CSV here or click to browse</strong>
        <p style="font-size:12px;color:#888;margin-top:4px">File will be filtered and recorded against this campaign</p>
      </div>
      <input type="file" id="file-input" accept=".csv" style="display:none">
      <div id="upload-spinner" style="display:none;align-items:center;gap:8px;font-size:13px;color:#888;padding:8px 0"><div class="spinner"></div> Processing…</div>
    </div>

    <div id="results" style="display:none">
      <div class="stats-grid-5" id="result-stats" style="margin-bottom:1.25rem"></div>
      <div class="card" style="padding:1rem 1.25rem;margin-bottom:1.25rem">
        <div class="tabs"><button class="tab active" data-tab="filtered">Filtered → REISift</button><button class="tab" data-tab="clean">Clean → Readymode</button></div>
        <div id="tab-filtered" class="tab-panel active"><div class="tbl-wrap"><table><thead><tr id="rem-head"></tr></thead><tbody id="rem-body"></tbody></table></div></div>
        <div id="tab-clean" class="tab-panel"><div class="tbl-wrap"><table><thead><tr id="cln-head"></tr></thead><tbody id="cln-body"></tbody></table></div></div>
        <div style="display:flex;gap:8px;margin-top:1rem">
          <a class="btn-primary-link" href="/download/filtered">Download filtered (REISift)</a>
          <a href="/download/clean" class="btn-link">Download clean (Readymode)</a>
        </div>
      </div>
    </div>

    <div class="card" style="padding:0;overflow:hidden">
      <div style="padding:12px 16px;border-bottom:1px solid #f0efe9"><div class="sec-lbl" style="margin-bottom:0">Filtration history</div></div>
      <table class="data-table">
        <thead><tr><th>Date</th><th>File / Source list</th><th>Channel</th><th>Total</th><th>Kept</th><th>Filtered</th><th>Breakdown</th><th>Memory catches</th></tr></thead>
        <tbody>${uploadRows||'<tr><td colspan="8" style="color:#aaa;padding:16px;text-align:center">No uploads yet for this campaign</td></tr>'}</tbody>
      </table>
    </div>

    <script>
    const CAMPAIGN_ID = '${c.id}';
    const PREVIEW_COLS = ['List Name (REISift Campaign)','First Name','Last Name','Phone','Disposition','Call Log Count','Action','Phone Tag','Phone Status','Marketing Results'];
    function showError(msg){alert(msg);}
    async function handleFile(file){
      if(!file.name.endsWith('.csv')){showError('CSV files only.');return;}
      const form=new FormData();
      form.append('csvfile',file);
      form.append('channel',document.getElementById('channel-select').value);
      document.getElementById('upload-spinner').style.display='flex';
      document.getElementById('drop-zone').style.opacity='0.5';
      try{
        const res=await fetch('/campaigns/'+CAMPAIGN_ID+'/upload',{method:'POST',body:form});
        const data=await res.json();
        if(!res.ok||data.error){showError(data.error||'Failed.');return;}
        renderResults(data);
        setTimeout(()=>location.reload(),3000);
      }catch(e){showError(e.message);}
      finally{document.getElementById('upload-spinner').style.display='none';document.getElementById('drop-zone').style.opacity='1';}
    }
    function renderResults(data){
      const s=data.stats;
      const sg=document.getElementById('result-stats');
      sg.innerHTML=\`
        <div class="stat-card"><div class="stat-lbl">Uploaded</div><div class="stat-num">\${s.totalRows}</div></div>
        <div class="stat-card"><div class="stat-lbl">Kept</div><div class="stat-num green">\${s.kept}</div></div>
        <div class="stat-card"><div class="stat-lbl">Filtered</div><div class="stat-num red">\${s.filtered}</div></div>
        <div class="stat-card"><div class="stat-lbl">Lists in file</div><div class="stat-num">\${s.listsCount}</div></div>
        <div class="stat-card"><div class="stat-lbl">Caught by memory</div><div class="stat-num blue">\${s.memCaught}</div></div>\`;
      renderTable('rem-head','rem-body',data.preview.filtered);
      renderTable('cln-head','cln-body',data.preview.clean);
      document.getElementById('results').style.display='block';
    }
    function renderTable(hId,bId,rows){
      const cols=PREVIEW_COLS;
      const thead=document.getElementById(hId),tbody=document.getElementById(bId);
      thead.innerHTML='';tbody.innerHTML='';
      if(!rows.length){tbody.innerHTML='<tr><td colspan="99" style="color:#aaa;padding:12px">No records</td></tr>';cols.forEach(c=>{const th=document.createElement('th');th.textContent=c;thead.appendChild(th);});return;}
      cols.forEach(c=>{const th=document.createElement('th');th.textContent=c;thead.appendChild(th);});
      rows.forEach(r=>{const tr=document.createElement('tr');cols.forEach(c=>{const td=document.createElement('td');const v=r[c]!==undefined?r[c]:'';if(c==='Action'){const cls=v==='remove'?'b-remove':'b-keep';td.innerHTML=\`<span class="badge \${cls}">\${v}</span>\`;}else td.textContent=v;tr.appendChild(td);});tbody.appendChild(tr);});
    }
    document.getElementById('file-input').addEventListener('change',e=>{if(e.target.files[0])handleFile(e.target.files[0]);});
    const dz=document.getElementById('drop-zone');
    dz.addEventListener('click',()=>document.getElementById('file-input').click());
    dz.addEventListener('dragover',e=>{e.preventDefault();dz.style.borderColor='#888';});
    dz.addEventListener('dragleave',()=>dz.style.borderColor='');
    dz.addEventListener('drop',e=>{e.preventDefault();dz.style.borderColor='';if(e.dataTransfer.files[0])handleFile(e.dataTransfer.files[0]);});
    document.querySelectorAll('.tab').forEach(t=>t.addEventListener('click',()=>{document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));document.querySelectorAll('.tab-panel').forEach(x=>x.classList.remove('active'));t.classList.add('active');document.getElementById('tab-'+t.dataset.tab).classList.add('active');}));
    </script>
  `);
}

// ── Shared shell ─────────────────────────────────────────────────────────────
function shell(title, body) {
  const isFilter = title==='List Filtration Bot';
  const isCampaign = !isFilter;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — HudREI</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f4f0;color:#1a1a1a;min-height:100vh;display:flex}
.sidebar{width:220px;min-height:100vh;background:#1a1a1a;display:flex;flex-direction:column;position:fixed;top:0;left:0;bottom:0;z-index:20}
.sidebar-logo{padding:20px 20px 16px;border-bottom:1px solid #2a2a2a}
.sidebar-logo-title{font-size:15px;font-weight:600;color:#fff}
.sidebar-logo-sub{font-size:11px;color:#666;margin-top:2px}
.sidebar-ver{font-size:10px;background:#2a2a2a;padding:1px 6px;border-radius:3px;color:#666;margin-top:6px;display:inline-block}
.sidebar-nav{padding:12px 10px;flex:1}
.sidebar-section{font-size:10px;font-weight:600;color:#444;text-transform:uppercase;letter-spacing:.06em;padding:8px 10px 4px}
.sidebar-link{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:8px;color:#888;font-size:13px;text-decoration:none;margin-bottom:2px;transition:all .15s}
.sidebar-link:hover{background:#2a2a2a;color:#fff}
.sidebar-link.active{background:#2a2a2a;color:#fff}
.sidebar-link svg{width:16px;height:16px;flex-shrink:0;opacity:.7}
.sidebar-link.active svg{opacity:1}
.sidebar-footer{padding:14px 16px;border-top:1px solid #2a2a2a}
.sidebar-footer a{font-size:12px;color:#666;text-decoration:none}
.sidebar-footer a:hover{color:#fff}
.page-wrap{margin-left:220px;min-height:100vh;flex:1}
.main{max-width:980px;margin:0 auto;padding:2rem 1.5rem}
.card{background:#fff;border:1px solid #e0dfd8;border-radius:12px;padding:1.25rem 1.5rem;margin-bottom:1.25rem}
.sec-lbl{font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.05em}
.badge{display:inline-block;font-size:11px;padding:2px 8px;border-radius:4px;font-weight:500}
.b-keep{background:#e8f5ee;color:#1a7a4a}.b-remove{background:#fdf0f0;color:#c0392b}
.stats-grid-5{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
.stat-card{background:#fff;border:1px solid #e0dfd8;border-radius:10px;padding:12px 14px}
.stat-lbl{font-size:12px;color:#888;margin-bottom:4px}
.stat-num{font-size:22px;font-weight:500}
.stat-num.green{color:#1a7a4a}.stat-num.red{color:#c0392b}.stat-num.blue{color:#2471a3}
.data-table{width:100%;font-size:12px;border-collapse:collapse}
.data-table th{text-align:left;padding:8px 12px;font-weight:500;color:#888;border-bottom:1px solid #f0efe9;font-size:11px;white-space:nowrap;background:#fff}
.data-table td{padding:8px 12px;border-bottom:1px solid #f8f7f4;vertical-align:top}
.data-table tbody tr:hover{background:#fafaf8}
.data-table tbody tr:last-child td{border-bottom:none}
.btn-primary-link{display:inline-flex;padding:8px 16px;background:#1a1a1a;color:#fff;border-radius:8px;font-size:13px;font-weight:500;text-decoration:none}
.btn-primary-link:hover{background:#333}
.btn-link{display:inline-flex;padding:8px 16px;border:1px solid #ddd;background:#fff;color:#1a1a1a;border-radius:8px;font-size:13px;text-decoration:none}
.btn-link:hover{background:#f5f4f0}
.inline-select{padding:5px 10px;font-size:12px;border:1px solid #ddd;border-radius:7px;background:#fff;color:#1a1a1a;font-family:inherit;cursor:pointer}
.form-field{margin-bottom:1rem}
.form-field label{font-size:13px;color:#555;display:block;margin-bottom:4px;font-weight:500}
.form-field input,.form-field select,.form-field textarea{width:100%;padding:9px 12px;border:1px solid #ddd;border-radius:8px;font-size:14px;background:#fafaf8;color:#1a1a1a;font-family:inherit}
.form-field input:focus,.form-field select:focus,.form-field textarea:focus{outline:none;border-color:#888}
.field-hint{font-size:11px;color:#aaa;margin-top:3px;display:block}
.btn-submit{width:100%;padding:10px;background:#1a1a1a;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer;font-family:inherit;margin-top:4px}
.btn-submit:hover{background:#333}
.error-box{background:#fff0f0;border:1px solid #f5c5c5;border-radius:8px;padding:9px 12px;font-size:13px;color:#c0392b;margin-bottom:1rem}
.empty-state{text-align:center;padding:3rem;color:#888;font-size:14px}
.empty-state a{color:#1a1a1a}
.drop-zone{border:1.5px dashed #ccc;border-radius:10px;padding:2rem;text-align:center;cursor:pointer;background:#fafaf8;transition:all .15s}
.drop-zone:hover{border-color:#888;background:#f0efe9}
.tabs{display:flex;gap:2px;border-bottom:1px solid #e0dfd8;margin-bottom:1rem}
.tab{padding:8px 16px;font-size:13px;cursor:pointer;border:none;background:transparent;color:#888;border-bottom:2px solid transparent;margin-bottom:-1px;font-family:inherit}
.tab.active{color:#1a1a1a;border-bottom-color:#1a1a1a}
.tab-panel{display:none}.tab-panel.active{display:block}
.tbl-wrap{overflow-x:auto;max-height:360px;overflow-y:auto}
.spinner{width:16px;height:16px;border:2px solid #ddd;border-top-color:#888;border-radius:50%;animation:spin .6s linear infinite;display:inline-block}
@keyframes spin{to{transform:rotate(360deg)}}
</style></head><body>
<div class="sidebar">
  <div class="sidebar-logo">
    <div class="sidebar-logo-title">HudREI LLC</div>
    <div class="sidebar-logo-sub">Data Filter</div>
    <span class="sidebar-ver">v2.0</span>
  </div>
  <div class="sidebar-nav">
    <div class="sidebar-section">Tools</div>
    <a href="/" class="sidebar-link ${isFilter?'active':''}">
      <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M3 4h18M3 8h18M3 12h12M3 16h8"/></svg>
      List Filtration
    </a>
    <a href="/upload" class="sidebar-link ${activePage==='upload'?'active':''}">
      <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
      Upload Data
    </a>
    <a href="/campaigns" class="sidebar-link ${isCampaign?'active':''}">
      <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
      Campaigns
    </a>
  </div>
  <div class="sidebar-footer">
    <a href="/logout">Sign out</a>
  </div>
</div>
<div class="page-wrap">
<div class="main">${body}</div>
</div>
</body></html>`;
}
