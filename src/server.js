const { query: dbQuery, initSchema } = require('./db');
const campaigns = require('./campaigns');
const changelogModule = require('./changelog');
const uploadRoutes = require('./routes/upload-routes');
// const recordsRoutes = require('./routes/records-routes'); // Replaced by phase 2 ./records/records-routes.js
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
// Old records routes replaced by phase 2 slice 1 — registered at bottom of file
// app.use('/records', recordsRoutes);

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.redirect('/login');
}

// Phase 2: Records + Setup + Lists + Import routes
const slice1Records = require('./records/records-routes');
const setupRoutes = require('./records/setup-routes');
const listsRoutes = require('./lists/lists-routes');
const importRoutes = require('./import/property-import-routes');

const COL = { phone:'Phone', dispo:'Log Type', listname:'Original lead file', date:'Log Time', fname:'First Name', lname:'Last Name', addr:'Address', city:'City', state:'State', zip:'Zip Code', notes:'Call Notes' };

// Auto-detect column names from file headers (handles both Readymode call log and list progress exports)
function detectCols(headers) {
  const h = headers.map(x => x.toLowerCase().trim());
  const find = (options) => {
    for (const opt of options) {
      const idx = h.findIndex(x => x === opt.toLowerCase() || x.includes(opt.toLowerCase()));
      if (idx > -1) return headers[idx];
    }
    return null;
  };
  return {
    phone:    find(['phone']),
    dispo:    find(['log type', 'logtype', 'last dispo', 'lastdispo', 'disposition', 'status']),
    listname: find(['original lead file', 'lead file campaign', 'batch name', 'original file name', 'list name', 'campaign']),
    date:     find(['log time', 'logtime', 'status (time)', 'upload date', 'date']),
    fname:    find(['first name', 'firstname']),
    lname:    find(['last name', 'lastname']),
    addr:     find(['address']),
    city:     find(['city']),
    state:    find(['state']),
    zip:      find(['zip code', 'zip']),
    notes:    find(['call notes', 'notes']),
  };
}

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
function phoneStatus(d) { return {transfer:'Correct',not_interested:'Correct',do_not_call:'Correct',spanish_speaker:'Correct',wrong_number:'Wrong',callback:'Correct',disqualified:'Correct',completed:'Correct',hung_up:'Tentative'}[d]||''; }
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
function memKey(list,phone,campaignId){
  const scope = campaignId ? 'campaign:'+campaignId : list.toLowerCase().trim();
  return scope+'||'+String(phone).replace(/\D/g,'');
}

function processCSV(csvText, memory, campaignId) {
  const parsed=Papa.parse(csvText,{header:true,skipEmptyLines:true});
  const rows=parsed.data;
  if(!rows.length) throw new Error('File is empty or could not be parsed.');
  const headers = parsed.meta.fields || [];
  const COLS = detectCols(headers);
  const fileCount={};
  rows.forEach(r=>{
    const phone=String(r[COLS.phone]||'').replace(/\D/g,'');
    const list=(r[COLS.listname]||'Unknown List').trim();
    if(!phone||phone==='0') return;
    const k=memKey(list,phone,campaignId);
    fileCount[k]=(fileCount[k]||0)+1;
  });
  const cleanRows=[],filteredRows=[];
  let memCaught=0;
  const listsSeen={},processedKeys={};
  rows.forEach(r=>{
    const phone=String(r[COLS.phone]||'').replace(/\D/g,'');
    const list=(r[COLS.listname]||'Unknown List').trim();
    const dispoRaw=r[COLS.dispo]||'';
    const dispo=normDispo(dispoRaw);
    const dateRaw=r[COLS.date]||'';
    if(!phone||phone==='0') return;
    const mkey=memKey(list,phone,campaignId);
    if(processedKeys[mkey]) return;
    processedKeys[mkey]=true;
    const countInFile=fileCount[mkey]||1;
    const prevMem=memory[mkey]||{count:0,lastDispo:'',dispoCounts:{}};
    const prevCount=prevMem.count||0;
    const prevDispoCounts=prevMem.dispoCounts||{};
    const cumCount=prevCount+countInFile;
    // Update per-disposition counts
    const newDispoCounts={...prevDispoCounts};
    newDispoCounts[dispo]=(newDispoCounts[dispo]||0)+countInFile;
    memory[mkey]={count:cumCount,lastDispo:dispoRaw,dispoCounts:newDispoCounts};
    if(!listsSeen[list]) listsSeen[list]={keep:0,rem:0,dispositions:{}};
    listsSeen[list].dispositions[dispo]=(listsSeen[list].dispositions[dispo]||0)+1;
    // Pull per-dispo counts for rules
    const niCount=newDispoCounts['not_interested']||0;
    const hupCount=newDispoCounts['hung_up']||0;
    const dcCount=newDispoCounts['dead_call']||0;
    const naCount=newDispoCounts['not_available']||0;
    const vmCount=newDispoCounts['voicemail']||0;
    // Reclassification: if hung_up causes removal (alone or via combined NI bucket), reclassify as NI
    let effectiveDispo=dispo;
    let tag=phoneTag(dispo,cumCount,list);
    let status=phoneStatus(dispo);
    let mkt=mktResult(dispo,list);
    const dateClean=stripTime(dateRaw);
    const ALWAYS_REM=new Set(['transfer','do_not_call','wrong_number','spanish_speaker','disqualified']);
    let action='keep',byMem=false,caughtByMem=false;
    const prevNi=prevDispoCounts['not_interested']||0;
    const prevHup=prevDispoCounts['hung_up']||0;
    const prevDc=prevDispoCounts['dead_call']||0;
    const prevNa=prevDispoCounts['not_available']||0;
    const prevVm=prevDispoCounts['voicemail']||0;
    if(ALWAYS_REM.has(dispo)){
      action='remove';
    }
    // Individual NI 3-strike
    else if(dispo==='not_interested'&&niCount>=3){
      action='remove';
      if(prevNi<3)byMem=true;
    }
    // Individual hang_up 3-strike → reclassify as NI
    else if(dispo==='hung_up'&&hupCount>=3){
      action='remove';
      effectiveDispo='not_interested';
      tag=phoneTag('not_interested',cumCount,list);
      status=phoneStatus('not_interested');
      mkt=mktResult('not_interested',list);
      if(prevHup<3)byMem=true;
    }
    // Combined NI + hang_up bucket (4 total) → reclassify as NI
    else if((dispo==='not_interested'||dispo==='hung_up')&&(niCount+hupCount)>=4){
      action='remove';
      effectiveDispo='not_interested';
      tag=phoneTag('not_interested',cumCount,list);
      status=phoneStatus('not_interested');
      mkt=mktResult('not_interested',list);
      if((prevNi+prevHup)<4)byMem=true;
    }
    // Combined dead_call + not_available bucket (4 total)
    else if((dispo==='dead_call'||dispo==='not_available')&&(dcCount+naCount)>=4){
      action='remove';
      if((prevDc+prevNa)<4)byMem=true;
    }
    // Voicemail standalone (>3 = 4th VM removes — keeping original behavior)
    else if(dispo==='voicemail'&&vmCount>3){
      action='remove';
      if(prevVm<=3)byMem=true;
    }
    if(byMem){memCaught++;caughtByMem=true;}
    if(action==='remove') listsSeen[list].rem++; else listsSeen[list].keep++;
    const enriched={'List Name (REISift Campaign)':list,'First Name':r[COL.fname]||'','Last Name':r[COL.lname]||'','Address':r[COL.addr]||'','City':r[COL.city]||'','State':r[COL.state]||'','Zip Code':r[COL.zip]||'','Phone':r[COL.phone]||'','Disposition':dispoRaw,'Call Log Count':cumCount,'Call Log Date':dateClean,'Phone Status':status,'Phone Tag':tag,'Marketing Results':mkt,'Cold Call Campaign Name':list,'Call Notes':r[COL.notes]||'','Action':action,'_normDispo':effectiveDispo,'_caughtByMemory':byMem};
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
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap">
        <div style="flex:1;min-width:200px">
          <label style="font-size:12px;color:#888;display:block;margin-bottom:4px">Campaign <span style="color:#c0392b">*</span> <span style="color:#aaa">(required)</span></label>
          <select id="campaign-select" style="width:100%;padding:8px 10px;border:1px solid #ddd;border-radius:8px;font-size:13px;background:#fff;font-family:inherit">
            <option value="">— Select a campaign first —</option>
          </select>
        </div>
        <div style="padding-top:18px">
          <a href="/campaigns/new" style="font-size:12px;color:#888;text-decoration:none">+ New campaign</a>
        </div>
      </div>
      <div class="drop-zone" id="drop-zone" style="opacity:0.4;pointer-events:none;cursor:not-allowed"><strong style="font-size:15px">Drop Readymode CSV here or click to browse</strong><p style="font-size:12px;color:#888;margin-top:5px">Select a campaign above first</p></div>
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
    // Load campaigns into dropdown
    fetch('/api/campaigns').then(r=>r.json()).then(list=>{
      const sel=document.getElementById('campaign-select');
      list.forEach(c=>{
        const opt=document.createElement('option');
        opt.value=c.id;opt.textContent=c.name;
        sel.appendChild(opt);
      });
    }).catch(()=>{});

    // Enable drop zone only when campaign selected
    document.getElementById('campaign-select').addEventListener('change', function(){
      const dz=document.getElementById('drop-zone');
      if(this.value){
        dz.style.opacity='1';
        dz.style.pointerEvents='auto';
        dz.style.cursor='pointer';
        dz.querySelector('p').textContent='Phone · Log Type · Original lead file · Log Time · First/Last Name · Address · City · State · Zip Code';
      } else {
        dz.style.opacity='0.4';
        dz.style.pointerEvents='none';
        dz.style.cursor='not-allowed';
        dz.querySelector('p').textContent='Select a campaign above first';
      }
    });

    async function handleFile(file){
      if(!file.name.endsWith('.csv')){showError('Please upload a CSV file.');return;}
      const campaignId=document.getElementById('campaign-select').value;
      if(!campaignId){showError('Please select a campaign before uploading.');return;}
      const form=new FormData();form.append('csvfile',file);
      form.append('campaign_id',campaignId);
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
    const cId = req.body.campaign_id||null;
    const result=processCSV(req.file.buffer.toString('utf8'),memory,cId);
    await saveMemory(result.memory);
    req.session.lastResult={cleanRows:result.cleanRows,filteredRows:result.filteredRows};
    const allRows=[...result.cleanRows,...result.filteredRows];
    const runId=await saveRunToDB(req.file.originalname||'upload.csv',{totalRows:result.totalRows,listsCount:Object.keys(result.listsSeen).length,kept:result.cleanRows.length,filtered:result.filteredRows.length,memCaught:result.memCaught},result.listsSeen,allRows);
    if(runId) console.log('Saved to DB, run ID:',runId);
    const campaignId = req.body.campaign_id;
    if(campaignId){
      try{
        await campaigns.initCampaignSchema();
        await campaigns.recordUpload(campaignId, req.file.originalname||'upload.csv', Object.keys(result.listsSeen)[0]||'upload', 'cold_call', allRows);
      // Apply filtration results to contact phone statuses
      try { await campaigns.applyFiltrationToContacts(campaignId, allRows); } catch(e) { console.error('applyFiltration error:', e.message); }
      }catch(campErr){ console.error('Campaign record error:', campErr.message); }
    }
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

// Records + Setup routes
app.use('/records', slice1Records);
app.use('/setup', setupRoutes);
app.use('/lists', listsRoutes);
app.use('/import/property', importRoutes);







// ── Dashboard ─────────────────────────────────────────────────────────────────
app.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const { shell } = require('./shared-shell');

    const stats = await dbQuery(`SELECT
      (SELECT COUNT(*) FROM properties) AS total_properties,
      (SELECT COUNT(*) FROM properties WHERE created_at >= NOW() - INTERVAL '30 days') AS new_this_month,
      (SELECT COUNT(*) FROM contacts) AS total_contacts,
      (SELECT COUNT(*) FROM phones) AS total_phones,
      (SELECT COUNT(*) FROM phones WHERE phone_status = 'correct') AS correct_phones,
      (SELECT COUNT(*) FROM phones WHERE phone_status = 'wrong' OR wrong_number = true) AS wrong_phones,
      (SELECT COUNT(*) FROM phones WHERE phone_status = 'dead') AS dead_phones,
      (SELECT COUNT(*) FROM lists) AS total_lists,
      (SELECT COUNT(*) FROM properties WHERE pipeline_stage = 'lead') AS leads,
      (SELECT COUNT(*) FROM properties WHERE pipeline_stage = 'contract') AS contracts,
      (SELECT COUNT(*) FROM properties WHERE pipeline_stage = 'closed') AS closed,
      (SELECT COUNT(*) FROM properties WHERE state_code = 'IN') AS indiana_props,
      (SELECT COUNT(*) FROM properties WHERE state_code = 'GA') AS georgia_props,
      (SELECT COUNT(*) FROM filtration_runs) AS total_filtration_runs,
      (SELECT COUNT(*) FROM filtration_runs WHERE run_at >= NOW() - INTERVAL '30 days') AS filtration_runs_month
    `);
    const s = stats.rows[0];

    // Recent filtration runs
    const recentRuns = await dbQuery(`
      SELECT filename, run_at, total_records, records_kept, records_filtered, caught_by_memory
      FROM filtration_runs ORDER BY run_at DESC LIMIT 5
    `);

    // Recent imports
    const recentImports = await dbQuery(`
      SELECT source, imported_at, COUNT(*) AS count
      FROM import_history
      WHERE imported_at >= NOW() - INTERVAL '30 days'
      GROUP BY source, imported_at
      ORDER BY imported_at DESC LIMIT 5
    `);

    // Top lists by property count
    const topLists = await dbQuery(`
      SELECT l.list_name, COUNT(pl.property_id) AS prop_count
      FROM lists l
      LEFT JOIN property_lists pl ON pl.list_id = l.id
      GROUP BY l.id, l.list_name
      ORDER BY prop_count DESC LIMIT 5
    `);

    const fmtNum = n => Number(n||0).toLocaleString();
    const fmtDate = v => v ? new Date(v).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '—';

    const statCard = (label, value, sub, color) => `
      <div style="background:#fff;border:1px solid #e0dfd8;border-radius:10px;padding:14px 16px">
        <div style="font-size:11px;color:#888;margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em">${label}</div>
        <div style="font-size:24px;font-weight:600;color:${color||'#1a1a1a'}">${value}</div>
        ${sub ? `<div style="font-size:11px;color:#aaa;margin-top:2px">${sub}</div>` : ''}
      </div>`;

    const runRows = recentRuns.rows.map(r => `<tr>
      <td style="font-weight:500;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.filename||'—'}</td>
      <td style="color:#888;font-size:12px">${fmtDate(r.run_at)}</td>
      <td>${fmtNum(r.total_records)}</td>
      <td style="color:#1a7a4a;font-weight:500">${fmtNum(r.records_kept)}</td>
      <td style="color:#c0392b">${fmtNum(r.records_filtered)}</td>
      <td style="color:#2471a3">${fmtNum(r.caught_by_memory)}</td>
    </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;color:#aaa;padding:16px">No filtration runs yet</td></tr>';

    const listRows = topLists.rows.map(l => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid #f5f4f0">
        <div style="font-size:13px;font-weight:500;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-right:12px">${l.list_name}</div>
        <div style="font-size:13px;color:#888;white-space:nowrap">${fmtNum(l.prop_count)} properties</div>
      </div>`).join('') || '<div style="color:#aaa;font-size:13px;padding:10px 0">No lists yet</div>';

    res.send(shell('Dashboard', `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.5rem;flex-wrap:wrap;gap:12px">
        <div>
          <div style="font-size:20px;font-weight:600">Dashboard</div>
          <div style="font-size:13px;color:#888;margin-top:2px">HudREI · Indiana &amp; Georgia</div>
        </div>
        <div style="display:flex;gap:8px">
          <a href="/import/property" class="btn-primary-link" style="font-size:13px">+ Import List</a>
        </div>
      </div>

      <!-- Stats grid -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:1.5rem">
        ${statCard('Properties', fmtNum(s.total_properties), '+'+fmtNum(s.new_this_month)+' this month')}
        ${statCard('Contacts', fmtNum(s.total_contacts))}
        ${statCard('Phones', fmtNum(s.total_phones), fmtNum(s.correct_phones)+' correct')}
        ${statCard('Lists', fmtNum(s.total_lists))}
        ${statCard('Leads', fmtNum(s.leads), 'pipeline stage', '#1a7a4a')}
        ${statCard('Contracts', fmtNum(s.contracts), 'pipeline stage', '#9a6800')}
      </div>

      <!-- Market split + Phone health -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:1.25rem;margin-bottom:1.25rem">
        <div class="card">
          <div class="sec-lbl">Markets</div>
          <div style="display:flex;flex-direction:column;gap:10px;margin-top:8px">
            <div style="display:flex;align-items:center;justify-content:space-between">
              <div style="font-size:13px;font-weight:500">Indiana</div>
              <div style="font-size:13px;color:#888">${fmtNum(s.indiana_props)} properties</div>
            </div>
            <div style="background:#f0efe9;border-radius:4px;height:6px">
              <div style="background:#1a1a1a;height:6px;border-radius:4px;width:${s.total_properties > 0 ? Math.round(s.indiana_props/s.total_properties*100) : 0}%"></div>
            </div>
            <div style="display:flex;align-items:center;justify-content:space-between">
              <div style="font-size:13px;font-weight:500">Georgia</div>
              <div style="font-size:13px;color:#888">${fmtNum(s.georgia_props)} properties</div>
            </div>
            <div style="background:#f0efe9;border-radius:4px;height:6px">
              <div style="background:#1a1a1a;height:6px;border-radius:4px;width:${s.total_properties > 0 ? Math.round(s.georgia_props/s.total_properties*100) : 0}%"></div>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="sec-lbl">Phone Health</div>
          <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px">
            ${[
              ['Correct', s.correct_phones, '#1a7a4a', '#e8f5ee'],
              ['Wrong', s.wrong_phones, '#9a6800', '#fff8e1'],
              ['Dead', s.dead_phones, '#c0392b', '#fdf0f0'],
              ['Unknown', Math.max(0, s.total_phones - s.correct_phones - s.wrong_phones - s.dead_phones), '#888', '#f5f4f0'],
            ].map(([label, count, color, bg]) => `
              <div style="display:flex;align-items:center;justify-content:space-between">
                <div style="display:flex;align-items:center;gap:6px">
                  <div style="width:8px;height:8px;border-radius:50%;background:${color}"></div>
                  <div style="font-size:13px">${label}</div>
                </div>
                <div style="font-size:13px;font-weight:500;background:${bg};color:${color};padding:2px 9px;border-radius:4px">${fmtNum(count)}</div>
              </div>`).join('')}
          </div>
        </div>
      </div>

      <!-- Recent filtration runs + Top lists -->
      <div style="display:grid;grid-template-columns:2fr 1fr;gap:1.25rem;margin-bottom:1.25rem">
        <div class="card" style="padding:0;overflow:hidden">
          <div style="padding:14px 16px;border-bottom:1px solid #f0efe9;display:flex;align-items:center;justify-content:space-between">
            <div class="sec-lbl" style="margin:0">Recent Filtration Runs</div>
            <a href="/" style="font-size:12px;color:#888;text-decoration:none">View all →</a>
          </div>
          <div style="overflow-x:auto">
            <table class="data-table">
              <thead><tr>
                <th>File</th><th>Date</th><th>Total</th><th>Kept</th><th>Filtered</th><th>Memory</th>
              </tr></thead>
              <tbody>${runRows}</tbody>
            </table>
          </div>
        </div>

        <div class="card">
          <div class="sec-lbl" style="margin-bottom:0">Top Lists</div>
          <div style="margin-top:10px">${listRows}</div>
          <a href="/lists" style="font-size:12px;color:#888;text-decoration:none;display:block;margin-top:10px">View all lists →</a>
        </div>
      </div>
    `, 'dashboard'));
  } catch(e) {
    console.error(e);
    res.status(500).send('Dashboard error: ' + e.message);
  }
});


app.listen(PORT, async ()=>{
  console.log(`HudREI Filtration Bot v2 running on port ${PORT}`);
  console.log(`Redis: ${redis?'connected':'not configured'}`);
  try { await initSchema(); console.log('Schema ready'); } catch(e) { console.error('Schema init error:', e.message); }
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

        // Upsert contact — keyed by property address to avoid duplicates
        const firstName = row['First Name'] || '';
        const lastName  = row['Last Name']  || '';
        let contactId = null;
        if (firstName || lastName) {
          // Reuse existing primary contact for this property if one exists
          if (propertyId) {
            const existingContact = await dbQuery(
              `SELECT contact_id FROM property_contacts WHERE property_id = $1 AND primary_contact = true LIMIT 1`,
              [propertyId]
            );
            if (existingContact.rows.length > 0) {
              contactId = existingContact.rows[0].contact_id;
              await dbQuery(
                `UPDATE contacts SET
                  first_name = COALESCE(NULLIF($1,''), first_name),
                  last_name  = COALESCE(NULLIF($2,''), last_name),
                  updated_at = NOW()
                WHERE id = $3`,
                [firstName, lastName, contactId]
              );
            }
          }
          if (!contactId) {
            const cr = await dbQuery(
              `INSERT INTO contacts (first_name, last_name) VALUES ($1,$2) RETURNING id`,
              [firstName, lastName]
            );
            contactId = cr.rows[0].id;
            if (propertyId) {
              await dbQuery(
                `INSERT INTO property_contacts (property_id, contact_id, primary_contact)
                 VALUES ($1,$2,true) ON CONFLICT DO NOTHING`,
                [propertyId, contactId]
              );
            }
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

app.get('/upload', requireAuth, (req, res) => {
  const { shell } = require('./shared-shell');
  res.send(shell('Upload', `
    <div style="max-width:680px">
      <div style="font-size:20px;font-weight:600;margin-bottom:4px">Upload</div>
      <p style="font-size:13px;color:#888;margin-bottom:2rem">What are you uploading today?</p>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">

        <a href="/import/property" style="text-decoration:none;display:block;background:#fff;border:1px solid #e0dfd8;border-radius:12px;padding:28px 24px;transition:all .15s;cursor:pointer" onmouseover="this.style.borderColor='#1a1a1a';this.style.boxShadow='0 4px 16px rgba(0,0,0,.08)'" onmouseout="this.style.borderColor='#e0dfd8';this.style.boxShadow='none'">
          <div style="width:40px;height:40px;background:#f5f4f0;border-radius:8px;display:flex;align-items:center;justify-content:center;margin-bottom:14px">
            <svg width="20" height="20" fill="none" stroke="#1a1a1a" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </div>
          <div style="font-size:15px;font-weight:600;color:#1a1a1a;margin-bottom:6px">Import Property List</div>
          <div style="font-size:13px;color:#888;line-height:1.5">Upload a CSV from PropStream, DealMachine, BatchSkipTrace or any data source. Map columns and import into Records.</div>
        </a>

        <a href="/upload/filter" style="text-decoration:none;display:block;background:#fff;border:1px solid #e0dfd8;border-radius:12px;padding:28px 24px;transition:all .15s;cursor:pointer" onmouseover="this.style.borderColor='#1a1a1a';this.style.boxShadow='0 4px 16px rgba(0,0,0,.08)'" onmouseout="this.style.borderColor='#e0dfd8';this.style.boxShadow='none'">
          <div style="width:40px;height:40px;background:#f5f4f0;border-radius:8px;display:flex;align-items:center;justify-content:center;margin-bottom:14px">
            <svg width="20" height="20" fill="none" stroke="#1a1a1a" stroke-width="2" viewBox="0 0 24 24"><path d="M3 4h18M3 8h18M3 12h12M3 16h8"/></svg>
          </div>
          <div style="font-size:15px;font-weight:600;color:#1a1a1a;margin-bottom:6px">Upload Call Log</div>
          <div style="font-size:13px;color:#888;line-height:1.5">Upload a Readymode call log export for filtration. Counts are calculated and output is ready for REISift import.</div>
        </a>

      </div>
    </div>
  `, 'upload'));
});
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
    // Enrich each campaign with contact_counts so we can show Total Contacts, Callable Contacts, LGR
    for (const c of list) {
      try { c.contact_counts = await campaigns.getContactStats(c.id); }
      catch(e) { c.contact_counts = { total_contacts: 0, total_phones: 0, wrong_phones: 0, nis_phones: 0, lead_contacts: 0 }; }
    }
    res.send(campaignsPage(list, req.query.tab||'active'));
  } catch (e) { res.status(500).send('Error: ' + e.message); }
});

// New campaign form
app.get('/campaigns/new', requireAuth, async (req, res) => {
  await campaigns.initCampaignSchema();
  const listTypes = await campaigns.getListTypes();
  res.send(newCampaignPage(null, listTypes));
});

// Create campaign
app.post('/campaigns/new', requireAuth, async (req, res) => {
  try {
    await campaigns.initCampaignSchema();
    const customType = (req.body.custom_list_type || '').trim();
    const body = { ...req.body, created_by: 'team' };
    // If the user picked "+ Add new list type…" or typed a custom value, use and save it
    if (body.list_type === '__new__' || customType) {
      if (!customType) {
        return res.redirect('/campaigns/new?error=' + encodeURIComponent('Enter a new list type or pick one from the dropdown'));
      }
      body.list_type = customType;
      await campaigns.addListType(customType);
    }
    delete body.custom_list_type;
    await campaigns.createCampaign(body);
    res.redirect('/campaigns');
  } catch (e) { res.redirect('/campaigns/new?error=' + encodeURIComponent(e.message)); }
});

// Close campaign
app.post('/campaigns/:id/close', requireAuth, async (req, res) => {
  try {
    await campaigns.closeCampaign(req.params.id);
    res.redirect('/campaigns/' + req.params.id);
  } catch(e) { res.redirect('/campaigns/' + req.params.id); }
});

// Start new round (clone campaign with fresh memory)
app.post('/campaigns/:id/new-round', requireAuth, async (req, res) => {
  try {
    await campaigns.closeCampaign(req.params.id);
    const newCamp = await campaigns.cloneCampaign(req.params.id);
    res.redirect('/campaigns/' + newCamp.id);
  } catch(e) { res.redirect('/campaigns/' + req.params.id); }
});

// Campaign detail
app.get('/campaigns/:id', requireAuth, async (req, res) => {
  try {
    const c = await campaigns.getCampaign(req.params.id);
    if (!c) return res.redirect('/campaigns');
    c.contact_counts = await campaigns.getContactStats(req.params.id);
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


// ── Contact List Routes ───────────────────────────────────────────────────────

// Upload original contact list to campaign
app.post('/campaigns/:id/contacts/upload', requireAuth, upload.single('contactfile'), async (req, res) => {
  try {
    if (!req.file) return res.redirect('/campaigns/' + req.params.id);
    await campaigns.initCampaignSchema();
    const parsed = Papa.parse(req.file.buffer.toString('utf8'), { header: true, skipEmptyLines: true });
    console.log('[contacts/upload] file received:', req.file.originalname, 'rows:', parsed.data.length, 'headers:', (parsed.meta.fields||[]).length);
    await campaigns.importContactList(req.params.id, parsed.data, parsed.meta.fields || []);
    console.log('[contacts/upload] import complete for campaign', req.params.id);
    res.redirect('/campaigns/' + req.params.id);
  } catch (e) {
    console.error('[contacts/upload] ERROR:', e.message);
    console.error('[contacts/upload] code:', e.code, 'detail:', e.detail);
    console.error('[contacts/upload] stack:', e.stack);
    res.status(500).send(`<h2>Upload failed</h2><p>${e.message}</p><pre>${e.code||''} ${e.detail||''}</pre><p><a href="/campaigns/${req.params.id}">Back to campaign</a></p>`);
  }
});

// Delete master contact list
app.post('/campaigns/:id/contacts/delete', requireAuth, async (req, res) => {
  try {
    const { query: dbQ } = require('./db');
    await dbQ('DELETE FROM campaign_contacts WHERE campaign_id=$1', [req.params.id]);
    await dbQ('UPDATE campaigns SET total_unique_numbers=0, updated_at=NOW() WHERE id=$1', [req.params.id]);
    res.redirect('/campaigns/' + req.params.id);
  } catch(e) { res.redirect('/campaigns/' + req.params.id); }
});

// SMS SmarterContact upload
app.post('/campaigns/:id/sms/upload', requireAuth, upload.single('smsfile'), async (req, res) => {
  try {
    if (!req.file) return res.redirect('/campaigns/' + req.params.id);
    const parsed = Papa.parse(req.file.buffer.toString('utf8'), { header: true, skipEmptyLines: true });
    const result = await campaigns.importSmarterContactFile(
      req.params.id,
      parsed.data,
      parsed.meta.fields || []
    );
    if (!result.success) {
      return res.status(400).send(`
        <h2>SMS Upload Failed</h2>
        <p style="color:red">${result.error}</p>
        <p><a href="/campaigns/${req.params.id}">Back to campaign</a></p>
      `);
    }
    const t = result.tally;
    console.log(`[sms/upload] campaign ${req.params.id} — total:${t.total} wrong:${t.wrong} ni:${t.not_interested} leads:${t.leads} dq:${t.disqualified} no_action:${t.no_action} unmatched:${t.unmatched}`);
    res.redirect('/campaigns/' + req.params.id);
  } catch(e) {
    console.error('[sms/upload] ERROR:', e.message);
    console.error('[sms/upload] stack:', e.stack);
    res.status(500).send(`<h2>SMS Upload Error</h2><p>${e.message}</p><p><a href="/campaigns/${req.params.id}">Back to campaign</a></p>`);
  }
});

// NIS upload page
app.get('/nis', requireAuth, async (req, res) => {
  await campaigns.initCampaignSchema();
  const stats = await campaigns.getNisStats();
  res.send(nisPage(stats, req.query.msg));
});

// Changelog page
app.get('/changelog', requireAuth, (req, res) => {
  res.send(changelogPage());
});

// NIS upload POST
app.post('/nis/upload', requireAuth, upload.single('nisfile'), async (req, res) => {
  try {
    if (!req.file) return res.redirect('/nis');
    await campaigns.initCampaignSchema();
    const csvText = req.file.buffer.toString('utf8').replace(/^\uFEFF/, '');
    const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
    const result = await campaigns.importNisFile(parsed.data);
    const msg = `Processed ${result.totalRows} rows — ${result.uniqueNumbers} unique NIS numbers (${result.inserted} new, ${result.updated} updated). Flagged ${result.flagged} phones across all campaigns.`;
    res.redirect('/nis?msg=' + encodeURIComponent(msg));
  } catch(e) {
    console.error('[nis/upload] error:', e.message, e.stack);
    res.status(500).send(`<h2>NIS upload failed</h2><p>${e.message}</p><p><a href="/nis">Back</a></p>`);
  }
});

// One-time sync: flag all historical wrong numbers in master contact list for this campaign
app.post('/campaigns/:id/sync-wrong-numbers', requireAuth, async (req, res) => {
  try {
    const { query: dbQ } = require('./db');
    const result = await dbQ(
      `UPDATE campaign_contact_phones ccp
       SET wrong_number = true, updated_at = NOW()
       FROM campaign_numbers cn
       WHERE cn.phone_number = ccp.phone_number
         AND cn.campaign_id = ccp.campaign_id
         AND cn.campaign_id = $1
         AND cn.last_disposition_normalized = 'wrong_number'
         AND ccp.wrong_number = false`,
      [req.params.id]
    );
    console.log('[sync-wrong-numbers] flagged', result.rowCount, 'phones for campaign', req.params.id);
    res.redirect('/campaigns/' + req.params.id);
  } catch(e) {
    console.error('[sync-wrong-numbers] error:', e.message);
    res.redirect('/campaigns/' + req.params.id);
  }
});

// Update Readymode accepted count
app.post('/campaigns/:id/readymode-count', requireAuth, async (req, res) => {
  try {
    const { query: dbQ } = require('./db');
    await dbQ('UPDATE campaigns SET manual_count=$1, updated_at=NOW() WHERE id=$2',
      [parseInt(req.body.count)||0, req.params.id]);
    res.redirect('/campaigns/' + req.params.id);
  } catch(e) { res.redirect('/campaigns/' + req.params.id); }
});

// Download clean export (callable contacts only)
app.get('/campaigns/:id/export/clean', requireAuth, async (req, res) => {
  try {
    await campaigns.initCampaignSchema();
    const result = await campaigns.generateCleanExport(req.params.id);
    if (!result.rows.length) return res.status(400).send('No callable contacts to export.');

    const cols = Object.keys(result.rows[0]);
    const csv = [cols.join(','), ...result.rows.map(r =>
      cols.map(c => `"${(r[c]||'').toString().replace(/"/g,'""')}"`).join(',')
    )].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="loki_clean_export_campaign_${req.params.id}.csv"`);
    res.send(csv);
  } catch(e) { res.status(500).send('Error: ' + e.message); }
});

// Get contact stats API
app.get('/campaigns/:id/contacts/stats', requireAuth, async (req, res) => {
  try {
    await campaigns.initCampaignSchema();
    const stats = await campaigns.getContactStats(req.params.id);
    res.json(stats);
  } catch(e) { res.json({}); }
});

// Delete campaign upload + reverse memory
app.post('/campaigns/:id/uploads/:uploadId/delete', requireAuth, async (req, res) => {
  try {
    await campaigns.initCampaignSchema();
    const { query: dbQ } = require('./db');
    const campId = req.params.id;
    const uploadId = req.params.uploadId;

    // Get the upload record first
    const upRes = await dbQ('SELECT * FROM campaign_uploads WHERE id=$1 AND campaign_id=$2', [uploadId, campId]);
    if (!upRes.rows.length) return res.redirect('/campaigns/' + campId);
    const up = upRes.rows[0];

    // Reverse the phone counts from Redis memory for this campaign
    const memory = await loadMemory();
    let reversed = 0;
    Object.keys(memory).forEach(k => {
      if (k.startsWith('campaign:' + campId + '||')) {
        // Subtract the upload count contribution — set to 0 minimum
        if (memory[k].count > 0) {
          memory[k].count = Math.max(0, memory[k].count - 1);
          reversed++;
        }
      }
    });
    await saveMemory(memory);

    // Delete the upload record
    await dbQ('DELETE FROM campaign_uploads WHERE id=$1', [uploadId]);

    // Recalculate campaign totals from remaining uploads
    const totals = await dbQ(`
      SELECT
        COALESCE(SUM(total_records),0) as total,
        COALESCE(SUM(records_kept),0) as kept,
        COALESCE(SUM(records_filtered),0) as filtered,
        COALESCE(SUM(wrong_numbers),0) as wrong,
        COALESCE(SUM(voicemails),0) as vm,
        COALESCE(SUM(not_interested),0) as ni,
        COALESCE(SUM(do_not_call),0) as dnc,
        COALESCE(SUM(transfers),0) as transfer,
        COALESCE(SUM(connected),0) as connected,
        COUNT(*) as upload_count
      FROM campaign_uploads WHERE campaign_id=$1`, [campId]);

    const t = totals.rows[0];
    await dbQ(`UPDATE campaigns SET
      total_unique_numbers=$1, total_callable=$2, total_filtered=$3,
      total_wrong_numbers=$4, total_voicemails=$5, total_not_interested=$6,
      total_do_not_call=$7, total_transfers=$8, total_connected=$9,
      upload_count=$10, updated_at=NOW()
      WHERE id=$11`,
      [t.total, t.kept, t.filtered, t.wrong, t.vm, t.ni, t.dnc, t.transfer, t.connected, t.upload_count, campId]);

    res.redirect('/campaigns/' + campId);
  } catch(e) {
    console.error('Delete upload error:', e.message);
    res.redirect('/campaigns/' + req.params.id);
  }
});

// ── Campaign HTML Pages ───────────────────────────────────────────────────────

const STATUS_COLORS = { active: '#1a7a4a', paused: '#9a6800', completed: '#888' };
const CHANNEL_LABELS = { cold_call: 'Cold Call', sms: 'SMS' };

function campaignsPage(list, tab) {
  tab = tab || 'active';
  const active = list.filter(c => c.status !== 'completed');
  const completed = list.filter(c => c.status === 'completed');
  const display = tab === 'completed' ? completed : active;
  const rows = display.map(c => {
    const totalContacts = parseInt(c.contact_counts?.total_contacts||0);
    const totalPhones = parseInt(c.contact_counts?.total_phones||0);
    const wrongPhones = parseInt(c.contact_counts?.wrong_phones||0);
    const nisPhones = parseInt(c.contact_counts?.nis_phones||0);
    const filteredPhones = parseInt(c.contact_counts?.filtered_phones||0);
    // Approximate callable contacts: total contacts × (callable phones ÷ total phones)
    const callablePhones = Math.max(0, totalPhones - wrongPhones - nisPhones - filteredPhones);
    const callableContacts = totalPhones > 0
      ? Math.round((callablePhones / totalPhones) * totalContacts)
      : totalContacts;
    const connected = parseInt(c.total_connected||0);
    const transfers = parseInt(c.total_transfers||0);
    const lgr = connected > 0 ? ((transfers / connected) * 100).toFixed(2) : '0.00';
    return `
    <tr onclick="location.href='/campaigns/${c.id}'" style="cursor:pointer">
      <td><strong>${c.name}</strong><br><span style="font-size:11px;color:#888">${c.list_type} · ${c.market_name}</span></td>
      <td><span class="badge" style="background:${STATUS_COLORS[c.status]}20;color:${STATUS_COLORS[c.status]}">${c.status}</span></td>
      <td><span class="badge" style="background:${c.active_channel==='sms'?'#f0e6fb':'#e6f1fb'};color:${c.active_channel==='sms'?'#7b2fa5':'#185fa5'}">${CHANNEL_LABELS[c.active_channel]||c.active_channel}</span></td>
      <td style="font-size:12px">${c.start_date ? new Date(c.start_date).toLocaleDateString() : '—'}</td>
      <td style="font-size:12px;color:#888">${c.end_date ? new Date(c.end_date).toLocaleDateString() : '—'}</td>
      <td>${Number(totalContacts).toLocaleString()}</td>
      <td>${lgr}%</td>
      <td style="color:#1a7a4a">${Number(callableContacts).toLocaleString()}</td>
      <td>${c.upload_count||0}</td>
    </tr>`;
  }).join('');

  return shell('Campaigns', `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.5rem">
      <div><h2 style="font-size:20px;font-weight:500;margin-bottom:3px">Campaigns</h2>
      <p style="font-size:13px;color:#888">Each campaign tracks all filtration activity for a list type in a market</p></div>
      <a href="/campaigns/new" class="btn-primary-link">+ New Campaign</a>
    </div>
    <div style="display:flex;gap:2px;border-bottom:1px solid #e0dfd8;margin-bottom:1.25rem">
      <a href="/campaigns?tab=active" style="padding:8px 16px;font-size:13px;text-decoration:none;border-bottom:2px solid ${tab==='active'?'#1a1a1a':'transparent'};color:${tab==='active'?'#1a1a1a':'#888'}">Active (${active.length})</a>
      <a href="/campaigns?tab=completed" style="padding:8px 16px;font-size:13px;text-decoration:none;border-bottom:2px solid ${tab==='completed'?'#1a1a1a':'transparent'};color:${tab==='completed'?'#1a1a1a':'#888'}">Completed (${completed.length})</a>
    </div>
    ${display.length === 0 ? `<div class="empty-state">No ${tab} campaigns yet.</div>` : `
    <div class="card" style="padding:0;overflow:hidden">
      <table class="data-table">
        <thead><tr><th>Campaign</th><th>Status</th><th>Channel</th><th>Start date</th><th>End date</th><th>Total Contacts</th><th>LGR</th><th>Callable Contacts</th><th>Uploads</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`}
  `, 'campaigns');
}

function newCampaignPage(error, listTypes) {
  const LIST_TYPES = listTypes && listTypes.length ? listTypes : ['Vacant Property','Pre-Foreclosure','Active Liens','2+ Mortgages','Absentee Owner','Tax Delinquent','Probate','Code Violation','Pre-Probate','Other'];
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
              <select name="list_type" id="list_type_select" onchange="document.getElementById('custom_lt_wrap').style.display=this.value==='__new__'?'block':'none';document.getElementById('custom_lt_input').required=this.value==='__new__'">
                <option value="">Select...</option>
                ${LIST_TYPES.map(t=>`<option value="${t}">${t}</option>`).join('')}
                <option value="__new__">+ Add new list type…</option>
              </select>
              <div id="custom_lt_wrap" style="display:none;margin-top:8px">
                <input type="text" id="custom_lt_input" name="custom_list_type" placeholder="Enter new list type" maxlength="100">
                <span class="field-hint">Saved for future campaigns</span>
              </div>
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
            <label>Start date</label>
            <input type="date" name="start_date" value="${new Date().toISOString().split('T')[0]}">
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

function nisPage(stats, msg) {
  const lastUpload = stats.last_upload ? new Date(stats.last_upload).toLocaleString() : 'Never';
  return shell('NIS Numbers', `
    <div style="max-width:720px">
      <h2 style="font-size:20px;font-weight:500;margin-bottom:4px">NIS Numbers</h2>
      <p style="font-size:13px;color:#888;margin-bottom:1.5rem">Upload Readymode Detailed NIS exports to flag dead numbers across all campaigns. Flagged numbers are excluded from future clean exports.</p>

      ${msg ? `<div style="background:#eaf6ea;border:1px solid #b8e0b8;color:#1a5f1a;padding:12px 16px;border-radius:8px;margin-bottom:1rem;font-size:13px">${msg}</div>` : ''}

      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:1.5rem">
        <div class="stat-card">
          <div class="stat-lbl">Total NIS numbers</div>
          <div class="stat-num">${Number(stats.total_nis||0).toLocaleString()}</div>
          <div style="font-size:11px;color:#888;margin-top:2px">In database</div>
        </div>
        <div class="stat-card">
          <div class="stat-lbl">Flagged phones</div>
          <div class="stat-num" style="color:#c0392b">${Number(stats.total_flagged||0).toLocaleString()}</div>
          <div style="font-size:11px;color:#888;margin-top:2px">Across all campaigns</div>
        </div>
        <div class="stat-card">
          <div class="stat-lbl">Last upload</div>
          <div class="stat-num" style="font-size:14px">${lastUpload}</div>
        </div>
      </div>

      <div class="card">
        <div style="font-size:14px;font-weight:500;margin-bottom:8px">Upload NIS file</div>
        <p style="font-size:12px;color:#888;margin-bottom:12px">Drop a Readymode Detailed NIS CSV export. The file must have a "dialed" column with phone numbers and a "day" column with the NIS date.</p>
        <form method="POST" action="/nis/upload" enctype="multipart/form-data">
          <input type="file" name="nisfile" accept=".csv" required style="margin-bottom:12px;display:block;font-size:13px">
          <button type="submit" class="btn-submit">Upload and flag</button>
        </form>
      </div>
    </div>
  `, 'nis');
}

function changelogPage() {
  return shell('Changelog', changelogModule.renderChangelog(), 'changelog');
}


function campaignDetailPage(c) {
  const n = c.total_unique_numbers || 0;
  const manualCount = parseInt(c.manual_count) || 0;
  const rmCount = manualCount > 0 ? manualCount : n;
  const connected = c.total_connected || 0;
  const totalPhones = parseInt(c.contact_counts?.total_phones||0);
  const callablePhones = totalPhones - parseInt(c.contact_counts?.wrong_phones||0) - parseInt(c.contact_counts?.filtered_phones||0) - parseInt(c.contact_counts?.nis_phones||0);
  const health = totalPhones > 0 ? ((callablePhones / totalPhones) * 100).toFixed(1) : '0.0';
  const callable_pct_old = n > 0 ? Math.round((c.total_callable / n) * 100) : 0;
  const totalContacts = parseInt(c.contact_counts?.total_contacts||0);
  const leadContacts = parseInt(c.contact_counts?.lead_contacts||0);
  const wrongNums = parseInt(c.total_wrong_numbers||0);
  const nisPhones = parseInt(c.contact_counts?.nis_phones||0);
  // Callable pool: master list phones minus filtered-out phones AND minus NIS phones
  const filteredOutCount = parseInt(c.total_filtered||0) + wrongNums;
  const masterCallable = Math.max(0, totalPhones - filteredOutCount - nisPhones);
  const callable_pct = totalPhones > 0 ? Math.round((masterCallable / totalPhones) * 100) : 0;
  const callLogs = parseInt(n) || 0;
  const cr    = callLogs > 0 && connected > 0 ? ((connected / callLogs) * 100).toFixed(2) : '0.00';
  const clr   = totalPhones > 0 && callLogs > 0 ? ((callLogs / totalPhones) * 100).toFixed(2) : '0.00';
  const wPct  = (connected + wrongNums) > 0 ? ((wrongNums / (connected + wrongNums)) * 100).toFixed(2) : '0.00';
  const niPct = connected > 0 ? (((c.total_not_interested||0) / connected) * 100).toFixed(2) : '0.00';
  const lgr   = connected > 0 ? (((c.total_transfers||0) / connected) * 100).toFixed(2) : '0.00';
  const lcv   = totalContacts > 0 ? ((leadContacts / totalContacts) * 100).toFixed(2) : '0.00';

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
      <td>
        <form method="POST" action="/campaigns/${c.id}/uploads/${u.id}/delete" onsubmit="return confirm('Remove this upload from the campaign? This will reverse its counts from memory.')">
          <button type="submit" style="background:none;border:none;color:#c0392b;font-size:11px;cursor:pointer;text-decoration:underline;font-family:inherit;padding:0">Remove</button>
        </form>
      </td>
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
        <p style="font-size:13px;color:#888">${c.list_type} · ${c.market_name} · ${c.state_code} · Started ${c.start_date ? new Date(c.start_date).toLocaleDateString() : '—'} ${c.end_date ? '· Ended ' + new Date(c.end_date).toLocaleDateString() : ''} · ${c.upload_count} uploads</p>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <form method="POST" action="/campaigns/${c.id}/channel" style="display:inline">
          <select name="channel" onchange="this.form.submit()" class="inline-select">
            <option ${c.active_channel==='cold_call'?'selected':''} value="cold_call">Cold Call active</option>
            <option ${c.active_channel==='sms'?'selected':''} value="sms">SMS active</option>
          </select>
        </form>
        ${c.status !== 'completed' ? `
        <form method="POST" action="/campaigns/${c.id}/close" onsubmit="return confirm('Close this campaign? It will be marked completed and no more uploads will be accepted.')" style="display:inline">
          <button type="submit" style="padding:7px 14px;font-size:13px;border:1px solid #e0dfd8;border-radius:8px;background:#fff;color:#888;cursor:pointer;font-family:inherit">Close campaign</button>
        </form>
        <form method="POST" action="/campaigns/${c.id}/new-round" onsubmit="return confirm('Close this campaign and start a new round with the same settings and fresh memory?')" style="display:inline">
          <button type="submit" style="padding:7px 14px;font-size:13px;border:none;border-radius:8px;background:#1a1a1a;color:#fff;cursor:pointer;font-family:inherit">Start new round</button>
        </form>` : `<span style="font-size:13px;color:#888;padding:7px 0;display:inline-block">Completed ${c.end_date ? '· ' + new Date(c.end_date).toLocaleDateString() : ''}</span>`}
      </div>
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:1.25rem">
      ${c.active_channel === 'sms' ? `
      <div class="stat-card"><div class="stat-lbl">SMS uploads</div><div class="stat-num">${c.upload_count||0}</div><div style="font-size:11px;color:#888;margin-top:2px">Uploads</div></div>
      <div class="stat-card"><div class="stat-lbl">Wrong numbers</div><div class="stat-num red">${Number(c.total_wrong_numbers||0).toLocaleString()}</div><div style="font-size:11px;color:#888;margin-top:2px">Removed</div></div>
      <div class="stat-card"><div class="stat-lbl">Not interested</div><div class="stat-num" style="color:#9a6800">${Number(c.total_not_interested||0).toLocaleString()}</div><div style="font-size:11px;color:#888;margin-top:2px">Total NI</div></div>
      <div class="stat-card"><div class="stat-lbl">Leads generated</div><div class="stat-num green">${Number(c.total_transfers||0).toLocaleString()}</div><div style="font-size:11px;color:#888;margin-top:2px">Transfers</div></div>
      <div class="stat-card"><div class="stat-lbl">Callable</div><div class="stat-num green">${Number(masterCallable).toLocaleString()} <span style="font-size:12px;font-weight:400;color:#888">(${callable_pct}%)</span></div><div style="font-size:11px;color:#888;margin-top:2px">Active pool</div></div>
      ` : `
      <div class="stat-card"><div class="stat-lbl">Call logs</div><div class="stat-num">${Number(n).toLocaleString()}</div><div style="font-size:11px;color:#888;margin-top:2px">Logged numbers</div></div>
      <div class="stat-card"><div class="stat-lbl">Connected</div><div class="stat-num blue">${Number(connected).toLocaleString()}</div><div style="font-size:11px;color:#888;margin-top:2px">Live pickups</div></div>
      <div class="stat-card"><div class="stat-lbl">Wrong numbers</div><div class="stat-num red">${Number(c.total_wrong_numbers||0).toLocaleString()}</div><div style="font-size:11px;color:#888;margin-top:2px">Removed</div></div>
      <div class="stat-card"><div class="stat-lbl">Not interested</div><div class="stat-num" style="color:#9a6800">${Number(c.total_not_interested||0).toLocaleString()}</div><div style="font-size:11px;color:#888;margin-top:2px">Total NI</div></div>
      <div class="stat-card"><div class="stat-lbl">Leads generated</div><div class="stat-num green">${Number(c.total_transfers||0).toLocaleString()}</div><div style="font-size:11px;color:#888;margin-top:2px">Transfers</div></div>
      <div class="stat-card"><div class="stat-lbl">Callable</div><div class="stat-num green">${Number(masterCallable).toLocaleString()} <span style="font-size:12px;font-weight:400;color:#888">(${callable_pct}%)</span></div><div style="font-size:11px;color:#888;margin-top:2px">Active pool</div></div>
      <div class="stat-card"><div class="stat-lbl">Filtration runs</div><div class="stat-num">${c.upload_count||0}</div><div style="font-size:11px;color:#888;margin-top:2px">Uploads</div></div>
      `}
    </div>

    ${c.active_channel === 'sms' ? `
    <div style="background:#fff;border:1px solid #e0dfd8;border-radius:12px;padding:14px 16px;margin-bottom:1.25rem">
      <div style="font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px">SMS Campaign KPIs</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px">
        <div style="text-align:center;padding:10px;background:#f5f4f0;border-radius:8px">
          <div style="font-size:22px;font-weight:500;color:#c0392b">${wPct}%</div>
          <div style="font-size:11px;color:#888;margin-top:2px">W#%</div>
          <div style="font-size:10px;color:#aaa">Wrong ÷ Total contacts</div>
        </div>
        <div style="text-align:center;padding:10px;background:#f5f4f0;border-radius:8px">
          <div style="font-size:22px;font-weight:500;color:#9a6800">${niPct}%</div>
          <div style="font-size:11px;color:#888;margin-top:2px">NI%</div>
          <div style="font-size:10px;color:#aaa">NI ÷ Total contacts</div>
        </div>
        <div style="text-align:center;padding:10px;background:#f5f4f0;border-radius:8px">
          <div style="font-size:22px;font-weight:500;color:#1a7a4a">${lgr}%</div>
          <div style="font-size:11px;color:#888;margin-top:2px">LGR</div>
          <div style="font-size:10px;color:#aaa">Leads ÷ Total contacts</div>
        </div>
        <div style="text-align:center;padding:10px;background:#f5f4f0;border-radius:8px">
          <div style="font-size:22px;font-weight:500;color:#534AB7">${lcv}%</div>
          <div style="font-size:11px;color:#888;margin-top:2px">LCV</div>
          <div style="font-size:10px;color:#aaa">Lead contacts ÷ Total contacts</div>
        </div>
        <div style="text-align:center;padding:10px;background:#f5f4f0;border-radius:8px">
          <div style="font-size:22px;font-weight:500;color:${parseFloat(health)>50?'#1a7a4a':parseFloat(health)>25?'#9a6800':'#c0392b'}">${health}%</div>
          <div style="font-size:11px;color:#888;margin-top:2px">Health</div>
          <div style="font-size:10px;color:#aaa">Callable ÷ Total phones</div>
        </div>
      </div>
    </div>
    ` : `
    <div style="background:#fff;border:1px solid #e0dfd8;border-radius:12px;padding:14px 16px;margin-bottom:1.25rem">
      <div style="font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px">Campaign KPIs</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px">
        <div style="text-align:center;padding:10px;background:#f5f4f0;border-radius:8px">
          <div style="font-size:22px;font-weight:500;color:#534AB7">${clr}%</div>
          <div style="font-size:11px;color:#888;margin-top:2px">CLR</div>
          <div style="font-size:10px;color:#aaa">Call logs ÷ Total phones</div>
        </div>
        <div style="text-align:center;padding:10px;background:#f5f4f0;border-radius:8px">
          <div style="font-size:22px;font-weight:500;color:#2471a3">${cr}%</div>
          <div style="font-size:11px;color:#888;margin-top:2px">CR</div>
          <div style="font-size:10px;color:#aaa">Connected ÷ Call logs</div>
        </div>
        <div style="text-align:center;padding:10px;background:#f5f4f0;border-radius:8px">
          <div style="font-size:22px;font-weight:500;color:#c0392b">${wPct}%</div>
          <div style="font-size:11px;color:#888;margin-top:2px">W#%</div>
          <div style="font-size:10px;color:#aaa">Wrong ÷ Humans reached</div>
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
          <div style="font-size:10px;color:#aaa">Lead contacts ÷ Total contacts</div>
        </div>
        <div style="text-align:center;padding:10px;background:#f5f4f0;border-radius:8px">
          <div style="font-size:22px;font-weight:500;color:${parseFloat(health)>50?'#1a7a4a':parseFloat(health)>25?'#9a6800':'#c0392b'}">${health}%</div>
          <div style="font-size:11px;color:#888;margin-top:2px">Health</div>
          <div style="font-size:10px;color:#aaa">Callable ÷ Total phones</div>
        </div>
      </div>
    </div>
    `}



    <div class="card" style="padding:1rem 1.25rem;margin-bottom:1.25rem">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:10px">
        <div class="sec-lbl" style="margin-bottom:0">Contact list</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <form method="POST" action="/campaigns/${c.id}/sync-wrong-numbers" style="display:inline" onsubmit="return confirm('Sync all historical wrong numbers to the master contact list? Safe to run anytime.')">
            <button type="submit" style="font-size:12px;padding:6px 14px;background:#fff;border:1px solid #ddd;border-radius:8px;cursor:pointer;color:#1a1a1a;font-family:inherit">Sync wrong numbers</button>
          </form>
          <a href="/campaigns/${c.id}/export/clean" class="btn-primary" style="font-size:12px;padding:6px 14px">Download clean export (Readymode)</a>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:14px">
        <div class="stat-card"><div class="stat-lbl">Total properties</div><div class="stat-num">${Number(c.contact_counts?.total_contacts||0).toLocaleString()}</div><div style="font-size:11px;color:#888;margin-top:2px">Contacts uploaded</div></div>
        <div class="stat-card"><div class="stat-lbl">Accepted by Readymode</div><div class="stat-num">${Number(c.manual_count||0).toLocaleString()} <button onclick="document.getElementById('rm-count-form').style.display=document.getElementById('rm-count-form').style.display==='none'?'block':'none'" style="font-size:11px;color:#888;background:none;border:none;cursor:pointer;text-decoration:underline">edit</button></div><div style="font-size:11px;color:#888;margin-top:2px">Manually entered</div></div>
        <div class="stat-card"><div class="stat-lbl">Total phones</div><div class="stat-num">${Number(c.contact_counts?.total_phones||0).toLocaleString()}</div><div style="font-size:11px;color:#888;margin-top:2px">Across all contacts</div></div>
        <div class="stat-card"><div class="stat-lbl">Wrong numbers</div><div class="stat-num red">${Number(c.contact_counts?.wrong_phones||0).toLocaleString()}</div><div style="font-size:11px;color:#888;margin-top:2px">Permanently excluded</div></div>
        <div class="stat-card"><div class="stat-lbl">NIS flagged</div><div class="stat-num" style="color:#c0392b">${Number(c.contact_counts?.nis_phones||0).toLocaleString()}</div><div style="font-size:11px;color:#888;margin-top:2px">Dead numbers</div></div>
        <div class="stat-card"><div class="stat-lbl">Confirmed correct</div><div class="stat-num green">${Number(c.contact_counts?.correct_phones||0).toLocaleString()}</div><div style="font-size:11px;color:#888;margin-top:2px">Live person confirmed</div></div>
        <div class="stat-card"><div class="stat-lbl">Contacts reached</div><div class="stat-num" style="color:#185fa5">${Number(c.contact_counts?.reached_contacts||0).toLocaleString()} ${c.contact_counts?.total_contacts>0?`<span style="font-size:13px;color:#888">(${((c.contact_counts.reached_contacts/c.contact_counts.total_contacts)*100).toFixed(1)}%)</span>`:''}</div><div style="font-size:11px;color:#888;margin-top:2px">At least 1 live pickup</div></div>
      </div>
      <div id="rm-count-form" style="display:none;background:#f5f4f0;border-radius:8px;padding:12px;margin-bottom:10px">
        <form method="POST" action="/campaigns/${c.id}/readymode-count" style="display:flex;align-items:center;gap:8px">
          <input type="number" name="count" value="${c.manual_count||''}" placeholder="e.g. 4163" style="padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:14px;width:150px;font-family:inherit">
          <button type="submit" style="padding:7px 16px;background:#1a1a1a;color:#fff;border:none;border-radius:7px;font-size:13px;cursor:pointer;font-family:inherit">Save</button>
          <span style="font-size:12px;color:#888">Total contacts Readymode accepted</span>
        </form>
      </div>
      <div style="border-top:1px solid #f0efe9;padding-top:12px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <div class="sec-lbl">Upload original contact list</div>
          ${parseInt(c.total_unique_numbers||0) > 0 ? `
          <form method="POST" action="/campaigns/${c.id}/contacts/delete" onsubmit="return confirm('Delete the master contact list for this campaign? This cannot be undone.')">
            <button type="submit" style="background:none;border:none;color:#c0392b;font-size:12px;cursor:pointer;text-decoration:underline;font-family:inherit">Delete master list</button>
          </form>` : ''}
        </div>
        <form method="POST" action="/campaigns/${c.id}/contacts/upload" enctype="multipart/form-data">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <input type="file" name="contactfile" accept=".csv" required style="font-size:13px;padding:6px;border:1px solid #ddd;border-radius:7px;background:#fff">
            <button type="submit" style="padding:7px 16px;background:#1a1a1a;color:#fff;border:none;border-radius:7px;font-size:13px;cursor:pointer;font-family:inherit">Upload contact list</button>
          </div>
          <p style="font-size:11px;color:#aaa;margin-top:6px">Loki will auto-detect all columns and phone numbers. Re-upload to replace.</p>
        </form>
        <div style="margin-top:1rem;padding-top:1rem;border-top:1px solid #f0f0f0">
          <div class="sec-lbl" style="margin-bottom:8px">Upload SmarterContact SMS results</div>
          <form method="POST" action="/campaigns/${c.id}/sms/upload" enctype="multipart/form-data">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <input type="file" name="smsfile" accept=".csv" required style="font-size:13px;padding:6px;border:1px solid #ddd;border-radius:7px;background:#fff">
              <button type="submit" style="padding:7px 16px;background:#2563eb;color:#fff;border:none;border-radius:7px;font-size:13px;cursor:pointer;font-family:inherit">Upload SMS results</button>
            </div>
            <p style="font-size:11px;color:#aaa;margin-top:6px">Required columns: Phone, Labels, First name, Last name, Property address, Property city, Property state, Property zip. One label per row only.</p>
          </form>
        </div>
      </div>
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

    ${c.status === 'completed' ? `
    <div class="card" style="padding:1rem 1.25rem;margin-bottom:1.25rem;background:#fafaf8">
      <p style="font-size:13px;color:#888;text-align:center;padding:8px 0">This campaign is completed — no more uploads accepted. <a href="/campaigns" style="color:#1a1a1a">Start a new round</a> to continue.</p>
    </div>` : `
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
    </div>`}

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
        <thead><tr><th>Date</th><th>File / Source list</th><th>Channel</th><th>Total</th><th>Kept</th><th>Filtered</th><th>Breakdown</th><th>Memory catches</th><th></th></tr></thead>
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
      var s=data.stats;
      var sg=document.getElementById('result-stats');
      sg.innerHTML='<div class="stat-card"><div class="stat-lbl">Uploaded</div><div class="stat-num">'+s.totalRows+'</div></div>'+
        '<div class="stat-card"><div class="stat-lbl">Kept</div><div class="stat-num green">'+s.kept+'</div></div>'+
        '<div class="stat-card"><div class="stat-lbl">Filtered</div><div class="stat-num red">'+s.filtered+'</div></div>'+
        '<div class="stat-card"><div class="stat-lbl">Lists in file</div><div class="stat-num">'+s.listsCount+'</div></div>'+
        '<div class="stat-card"><div class="stat-lbl">Caught by memory</div><div class="stat-num blue">'+s.memCaught+'</div></div>';
      renderTable('rem-head','rem-body',data.preview.filtered);
      renderTable('cln-head','cln-body',data.preview.clean);
      document.getElementById('results').style.display='block';
    }
    function renderTable(hId,bId,rows){
      var cols=PREVIEW_COLS;
      var thead=document.getElementById(hId),tbody=document.getElementById(bId);
      thead.innerHTML='';tbody.innerHTML='';
      if(!rows.length){tbody.innerHTML='<tr><td colspan="99" style="color:#aaa;padding:12px">No records</td></tr>';cols.forEach(function(c){var th=document.createElement('th');th.textContent=c;thead.appendChild(th);});return;}
      cols.forEach(function(c){var th=document.createElement('th');th.textContent=c;thead.appendChild(th);});
      rows.forEach(function(r){var tr=document.createElement('tr');cols.forEach(function(c){var td=document.createElement('td');var v=r[c]!==undefined?r[c]:'';if(c==='Action'){var cls=v==='remove'?'b-remove':'b-keep';td.innerHTML='<span class="badge '+cls+'">'+v+'</span>';}else td.textContent=v;tr.appendChild(td);});tbody.appendChild(tr);});
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
const { shell } = require('./shared-shell');
