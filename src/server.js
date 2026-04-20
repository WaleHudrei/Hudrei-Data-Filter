const { query: dbQuery, initSchema } = require('./db');
const campaigns = require('./campaigns');
const changelogModule = require('./changelog');
const uploadRoutes = require('./routes/upload-routes');
const uploadUI = require('./ui/upload');
const express = require('express');
const { bufferToCsvText, stripBom } = require('./csv-utils');
const session = require('express-session');
const multer = require('multer');
const Papa = require('papaparse');
const Redis = require('ioredis');
const { normalizeState } = require('./import/state');

const app = express();
// 2026-04-18 audit fix #21: previously multer accepted any file up to 50MB
// with no type check. Client-side had `.endsWith('.csv')` but a hostile or
// confused caller could POST any bytes. xlsx files would silently fail in
// Papaparse (returning 0 rows with no explanation — wasted operator time).
// Now rejects anything that isn't a CSV/TXT by extension or MIME type.
const csvFileFilter = (req, file, cb) => {
  const name = String(file.originalname || '').toLowerCase();
  const okExt = /\.(csv|txt)$/.test(name);
  const okMime = ['text/csv', 'text/plain', 'application/csv', 'application/vnd.ms-excel',
                  'application/octet-stream'].includes(String(file.mimetype || '').toLowerCase());
  if (okExt || okMime) return cb(null, true);
  cb(new Error('Only CSV files are accepted. Convert xlsx/xls to CSV before uploading.'));
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: csvFileFilter,
});

const APP_USERNAME   = process.env.APP_USERNAME   || 'hudrei';
const APP_PASSWORD   = process.env.APP_PASSWORD   || 'changeme123';
const SESSION_SECRET = process.env.SESSION_SECRET || 'hudrei-secret-key-2026';
const PORT           = process.env.PORT           || 3000;
const REDIS_URL      = process.env.REDIS_URL      || null;
const MEMORY_KEY     = 'hudrei:filtration:memory';
const IS_PROD        = process.env.NODE_ENV === 'production';

// ── Production hardening checks (Audit #32 / security) ────────────────────────
// Fail fast at boot rather than ship a production deploy with the default
// credentials baked into the repo.
if (IS_PROD) {
  if (APP_PASSWORD === 'changeme123') {
    throw new Error('Refusing to start in production with default APP_PASSWORD. Set APP_PASSWORD env var on Railway before deploying.');
  }
  if (SESSION_SECRET === 'hudrei-secret-key-2026') {
    throw new Error('Refusing to start in production with default SESSION_SECRET. Set SESSION_SECRET env var on Railway before deploying.');
  }
}

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

// Behind a Railway / Cloudflare proxy — required for `cookie.secure = true` to
// not drop cookies over HTTPS, and for `req.ip` to report the real client IP.
app.set('trust proxy', 1);

app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ── Session store (Audit #6) ──────────────────────────────────────────────────
// In-memory MemoryStore is Express's default — it's unsafe for production:
//   (a) every deploy wipes all user sessions → users forced to re-login,
//   (b) it leaks memory over time (no TTL cleanup),
//   (c) it stores session data in the Node heap which fights with the
//       50 MB importRows payloads used by the property importer.
// When REDIS_URL is set we use connect-redis to persist sessions to the
// same Redis instance used for the filtration memory cache. When not set
// (local dev), we fall back to MemoryStore with a loud warning.
let sessionStore;
if (REDIS_URL) {
  try {
    // connect-redis v7+ exports { RedisStore } (named), but earlier 7.x
    // minor versions and all of v6 export the class as the default export.
    // Also some bundlers expose it as .default. Try all three shapes.
    const mod = require('connect-redis');
    const RedisStore =
      (mod && mod.RedisStore) ||
      (typeof mod === 'function' ? mod : null) ||
      (mod && mod.default && (mod.default.RedisStore || mod.default));

    if (typeof RedisStore !== 'function') {
      throw new Error('RedisStore export not found in connect-redis module. Got keys: ' + Object.keys(mod || {}).join(','));
    }
    sessionStore = new RedisStore({ client: redis, prefix: 'loki:sess:' });
    console.log('Session store: Redis');
  } catch (e) {
    console.error('connect-redis failed to initialize — falling back to MemoryStore.', e.message);
    sessionStore = undefined;
  }
} else if (IS_PROD) {
  console.warn('[warn] Production with no REDIS_URL — using MemoryStore. Sessions will not survive deploys.');
}

app.use(session({
  store: sessionStore,
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: IS_PROD,     // HTTPS-only cookies in production (trust proxy above enables this over Railway's TLS termination)
    httpOnly: true,      // JS can't read the cookie
    sameSite: 'lax',     // protects against CSRF while still allowing top-level nav
    maxAge: 8 * 60 * 60 * 1000,
  },
}));

// Serve static files (client JS, CSS, images) from /public
const path = require('path');
app.use(express.static(path.join(__dirname, 'public')));

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
const bulkImportRoutes = require('./import/bulk-import-routes');
const activityRoutes = require('./activity-routes');

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
  // 2026-04-18 audit: add cold-call parity for SMS-only outcomes so the
  // Marketing Result filter values (Potential Lead / Sold / Listed) are
  // actually reachable from cold-call dispositions too. Match BEFORE the
  // generic "not interested" check since 'potential lead' could otherwise
  // be missed.
  if (s==='potential lead'||s.includes('potential lead')) return 'potential_lead';
  if (s==='sold'||s.includes('sold')) return 'sold';
  if (s==='listed'||s.includes('listed')) return 'listed';
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
function phoneStatus(d) { return {transfer:'Correct',potential_lead:'Correct',sold:'Correct',listed:'Correct',not_interested:'Correct',do_not_call:'Correct',spanish_speaker:'Correct',wrong_number:'Wrong',callback:'Correct',disqualified:'Correct',completed:'Correct',hung_up:'Tentative'}[d]||''; }
function mktResult(d,l) {
  // 2026-04-18 audit fix: previously `do_not_call` mapped to `Not Interested — {list}`
  // (copy-paste bug — DNC and NI are compliance-distinct outcomes that must not
  // collapse to the same value in marketing_result). Also added explicit rows for
  // potential_lead / sold / listed so cold-call and SMS pipelines produce the
  // same filter-dropdown vocabulary. Previously these were only ever written by
  // the SMS flow, making the "Sold"/"Listed"/"Potential Lead" filter values
  // silently unreachable for cold-call-sourced leads.
  if(d==='transfer')         return 'Lead';
  if(d==='potential_lead')   return 'Potential Lead';
  if(d==='sold')             return 'Sold';
  if(d==='listed')           return 'Listed';
  if(d==='not_interested')   return `Not Interested — ${l}`;
  if(d==='do_not_call')      return `Do Not Call — ${l}`;
  if(d==='spanish_speaker')  return 'Spanish Speaker';
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
  // 2026-04-18 audit fix #9: previously fell back to list-name scoping when
  // campaignId was missing. Two different campaigns with the same list name
  // (e.g. both using "Tax Delinquent IN") would share filtration memory —
  // a DNC count from Campaign A would retroactively filter rows in Campaign B.
  // Now we REQUIRE campaignId. Callers must supply it; undefined/null throws.
  if (!campaignId) {
    throw new Error('memKey: campaignId is required. List-name-only scoping was causing cross-campaign data leaks.');
  }
  const scope = 'campaign:'+campaignId;
  return scope+'||'+String(phone).replace(/\D/g,'');
}
// Global keys — shared across ALL campaigns (wrong numbers, DNC stay permanent)
function globalKey(dispo,phone){
  const p = String(phone).replace(/\D/g,'');
  if(dispo==='wrong_number') return 'wn:'+p;
  if(dispo==='do_not_call')  return 'dnc:'+p;
  return null;
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
    const dRaw=normDispo(r[COLS.dispo]||'');
    // Use global key for WN/DNC so they don't inflate per-campaign counts
    const gk=globalKey(dRaw,phone);
    const k=gk||memKey(list,phone,campaignId);
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
    // Use global key for wrong_number and DNC — campaign-scoped for everything else
    const gk=globalKey(dispo,phone);
    const mkey=gk||memKey(list,phone,campaignId);
    // Transfers NEVER get deduplicated — always record every transfer
    if(dispo!=='transfer'&&processedKeys[mkey]) return;
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
    // 2026-04-18 audit: added potential_lead, sold, listed so cold-call uploads
    // with these dispositions get removed from callable list (they're all
    // real-conversation outcomes, same treatment as 'transfer').
    const ALWAYS_REM=new Set(['transfer','potential_lead','sold','listed','do_not_call','wrong_number','spanish_speaker','disqualified']);
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
  // 2026-04-18 audit fix #26: CSV injection protection. Prefix any cell
  // starting with =, +, -, @, or control chars with a single quote so Excel
  // treats it as text instead of a formula.
  const safe = (v) => {
    const s = String(v || '');
    return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  };
  return [cols.join(','),...rows.map(r=>cols.map(c=>`"${safe(r[c]).replace(/"/g,'""')}"`).join(','))].join('\n');
}

app.get('/login',(req,res)=>{
  const error=req.query.error?'Invalid username or password.':'';
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Loki</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f4f0;display:flex;align-items:center;justify-content:center;min-height:100vh}.box{background:#fff;border:1px solid #e0dfd8;border-radius:12px;padding:2.5rem 2rem;width:100%;max-width:380px;text-align:center}h1{font-size:36px;font-weight:600;margin-bottom:.5rem;letter-spacing:-.5px}.sub{font-size:13px;color:#888;margin-bottom:1.75rem}label{font-size:13px;color:#555;display:block;margin-bottom:4px;text-align:left}input{width:100%;padding:9px 12px;border:1px solid #ddd;border-radius:8px;font-size:14px;background:#fafaf8;color:#1a1a1a;margin-bottom:1rem;font-family:inherit}input:focus{outline:none;border-color:#888}button{width:100%;padding:10px;background:#1a1a1a;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer;font-family:inherit}button:hover{background:#333}.error{background:#fff0f0;border:1px solid #f5c5c5;border-radius:8px;padding:9px 12px;font-size:13px;color:#c0392b;margin-bottom:1rem;text-align:left}</style></head><body><div class="box"><h1>Loki</h1><p class="sub">Sign in to begin</p>${error?`<div class="error">${error}</div>`:''}<form method="POST" action="/login"><label>Username</label><input type="text" name="username" autofocus><label>Password</label><input type="password" name="password"><button type="submit">Sign in</button></form></div></body></html>`);
});

// 2026-04-18 audit fix #25: simple in-memory login rate limiter. Previously
// /login accepted unlimited POSTs per IP, making brute-force trivial. Keyed
// by trusted IP; limit of 5 failed attempts per 15 minutes. On exceed, returns
// 429 with a Retry-After header. Successful login clears the counter.
// Multi-replica note: each Node process has its own counter; an attacker
// distributing across replicas gets N × 5 attempts. For tighter security,
// move to Redis-backed tracking. Acceptable for current single-replica deploy.
const _loginAttempts = new Map(); // ip -> { count, firstAt }
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;

function _loginIp(req) {
  // trust proxy is set earlier; req.ip reflects the real client when behind Railway
  return String(req.ip || req.connection?.remoteAddress || 'unknown');
}

function _loginRateLimit(req, res, next) {
  const ip = _loginIp(req);
  const now = Date.now();
  const rec = _loginAttempts.get(ip);
  if (rec && (now - rec.firstAt) < LOGIN_WINDOW_MS && rec.count >= LOGIN_MAX_FAILURES) {
    const retryAfter = Math.ceil((LOGIN_WINDOW_MS - (now - rec.firstAt)) / 1000);
    res.set('Retry-After', String(retryAfter));
    return res.status(429).send(
      `<!DOCTYPE html><html><body style="font-family:system-ui;padding:2rem;text-align:center">
       <h2>Too many login attempts</h2>
       <p>Try again in ${Math.ceil(retryAfter / 60)} minute(s).</p></body></html>`
    );
  }
  // Window expired — reset
  if (rec && (now - rec.firstAt) >= LOGIN_WINDOW_MS) {
    _loginAttempts.delete(ip);
  }
  next();
}

app.post('/login', _loginRateLimit, (req, res) => {
  const { username, password } = req.body;
  const ip = _loginIp(req);
  if (username === APP_USERNAME && password === APP_PASSWORD) {
    _loginAttempts.delete(ip); // success → clear counter
    req.session.authenticated = true;
    res.redirect('/dashboard');
  } else {
    const rec = _loginAttempts.get(ip) || { count: 0, firstAt: Date.now() };
    rec.count++;
    _loginAttempts.set(ip, rec);
    res.redirect('/login?error=1');
  }
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
    // 2026-04-18 audit fix #9: reject uploads without a campaign id. Previously
    // fell through to list-name scoping which caused cross-campaign memory
    // contamination. Every upload must be tagged to a campaign.
    const cId = req.body.campaign_id;
    if (!cId) {
      return res.status(400).json({
        error: 'campaign_id is required. Select a campaign before uploading a filtration file.'
      });
    }
    const memory=await loadMemory();
    const result=processCSV(bufferToCsvText(req.file.buffer),memory,cId);
    await saveMemory(result.memory);
    req.session.lastResult={cleanRows:result.cleanRows,filteredRows:result.filteredRows};
    const allRows=[...result.cleanRows,...result.filteredRows];
    const runId=await saveRunToDB(req.file.originalname||'upload.csv',{totalRows:result.totalRows,listsCount:Object.keys(result.listsSeen).length,kept:result.cleanRows.length,filtered:result.filteredRows.length,memCaught:result.memCaught},result.listsSeen,allRows);
    if(runId) console.log('Saved to DB, run ID:',runId);
    const campaignId = req.body.campaign_id;
    if(campaignId){
      try{
        await campaigns.initCampaignSchema();
        await campaigns.recordUpload(campaignId, req.file.originalname||'upload.csv', Object.keys(result.listsSeen)[0]||'upload', 'cold_call', allRows, result.totalRows);
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
  try{const data=JSON.parse(bufferToCsvText(req.file.buffer));await saveMemory(data);res.json({success:true,count:Object.keys(data).length});}
  catch(e){res.status(400).json({error:'Invalid memory file.'});}
});

app.post('/memory/clear',requireAuth,async(req,res)=>{await clearMemory();res.json({success:true});});

// Records + Setup routes
app.use('/records', slice1Records);
app.use('/setup', setupRoutes);
app.use('/lists', listsRoutes);
app.use('/import/property', importRoutes);
app.use('/import/bulk', bulkImportRoutes);
app.use('/activity', activityRoutes);







// ── Dashboard ─────────────────────────────────────────────────────────────────
app.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const { shell } = require('./shared-shell');

    // Counts use Postgres's approximate live-tuple statistics for the three
    // biggest tables (properties, contacts, phones) instead of full COUNT(*)
    // scans. On databases >100k rows the full scan was ~200-500ms per dashboard
    // load. n_live_tup is maintained by autovacuum and is close enough for a
    // dashboard headline; the small pipeline-stage counts stay exact because
    // they're already fast thanks to idx_properties_pipeline_stage. (Audit #34.)
    const stats = await dbQuery(`SELECT
      (SELECT COALESCE(NULLIF(n_live_tup, 0), (SELECT COUNT(*) FROM properties)) FROM pg_stat_user_tables WHERE relname = 'properties') AS total_properties,
      (SELECT COUNT(*) FROM properties WHERE created_at >= date_trunc('month', NOW())) AS new_this_month,
      (SELECT COALESCE(NULLIF(n_live_tup, 0), (SELECT COUNT(*) FROM contacts)) FROM pg_stat_user_tables WHERE relname = 'contacts') AS total_contacts,
      (SELECT COALESCE(NULLIF(n_live_tup, 0), (SELECT COUNT(*) FROM phones)) FROM pg_stat_user_tables WHERE relname = 'phones') AS total_phones,
      (SELECT COUNT(*) FROM phones WHERE LOWER(phone_status) = 'correct') AS correct_phones,
      (SELECT COUNT(*) FROM phones WHERE LOWER(phone_status) = 'wrong' OR wrong_number = true) AS wrong_phones,
      (SELECT COUNT(*) FROM phones WHERE LOWER(phone_status) IN ('dead','dead_number')) AS dead_phones,
      (SELECT COUNT(*) FROM lists) AS total_lists,
      (
        -- 2026-04-20 audit fix #2: dashboard leads = union of two sources.
        --   (a) properties with pipeline_stage='lead' (set by filtration's
        --       cold-call and SMS transfer paths when the address can be
        --       resolved back to a property row)
        --   (b) campaign_contacts.marketing_result='Lead' rows (SMS path
        --       source-of-truth — some never resolve to a property because
        --       the address doesn't match).
        -- DISTINCT on the resolved property avoids double-counting. The extra
        -- clause unions in unresolved campaign leads so the total matches the
        -- campaign-level lead count the user sees in /campaigns.
        SELECT COUNT(*) FROM (
          SELECT 'p:' || p.id::text AS key FROM properties p WHERE p.pipeline_stage = 'lead'
          UNION
          SELECT 'cc:' || cc.id::text AS key
            FROM campaign_contacts cc
           WHERE LOWER(TRIM(cc.marketing_result)) = 'lead'
             AND NOT EXISTS (
               SELECT 1 FROM properties p2
                WHERE p2.pipeline_stage = 'lead'
                  AND p2.street_normalized = cc.property_address_normalized
                  AND UPPER(TRIM(p2.state_code)) = UPPER(TRIM(cc.property_state))
             )
        ) lead_union
      ) AS leads,
      (SELECT COUNT(*) FROM properties WHERE pipeline_stage = 'contract') AS contracts,
      (SELECT COUNT(*) FROM properties WHERE pipeline_stage = 'closed') AS closed,
      (SELECT COUNT(*) FROM properties WHERE state_code = 'IN') AS indiana_props,
      (SELECT COUNT(*) FROM properties WHERE state_code = 'GA') AS georgia_props,
      (SELECT COUNT(*) FROM filtration_runs) AS total_filtration_runs,
      (SELECT COUNT(*) FROM filtration_runs WHERE run_at >= date_trunc('month', NOW())) AS filtration_runs_month
    `);
    const s = stats.rows[0];

    // Recent filtration runs
    const recentRuns = await dbQuery(`
      SELECT filename, run_at, total_records, records_kept, records_filtered, caught_by_memory
      FROM filtration_runs ORDER BY run_at DESC LIMIT 5
    `);

    // Distress distribution + top hot leads (defensive — schema may not exist on first deploy)
    let distressDist = { burning: 0, hot: 0, warm: 0, cold: 0, unscored: 0, total: 0 };
    let topHotLeads = [];
    try {
      const distress = require('./scoring/distress');
      await distress.ensureDistressSchema();
      distressDist = await distress.getScoreDistribution();
      const hotRes = await dbQuery(`
        SELECT id, street, city, state_code, distress_score, distress_band
          FROM properties
         WHERE distress_score >= 30
         ORDER BY distress_score DESC, id DESC
         LIMIT 5
      `);
      topHotLeads = hotRes.rows;
    } catch(e) {
      console.error('[dashboard] distress fetch failed:', e.message);
    }

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

    // Default-code security banner — reminds the operator to change the
    // stock delete code. Safe to skip if settings module hasn't initialized
    // yet or if the check fails (non-fatal). (Audit gap 5.)
    let defaultCodeBanner = '';
    try {
      const settings = require('./settings');
      if (await settings.isUsingDefaultCode()) {
        defaultCodeBanner = `
          <div style="background:#fff8e1;border:1px solid #e8cf87;border-radius:8px;padding:12px 16px;margin-bottom:1.25rem;display:flex;align-items:center;gap:12px">
            <svg width="18" height="18" fill="none" stroke="#9a6800" stroke-width="2" viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            <div style="flex:1;font-size:13px;color:#6a4a00">
              <strong>Delete code still using the default.</strong>
              Anyone with the default code can delete records in bulk.
              <a href="/settings/security" style="color:#6a4a00;text-decoration:underline;font-weight:600">Change it now →</a>
            </div>
          </div>`;
      }
    } catch (e) { /* non-fatal */ }

    res.send(shell('Dashboard', `
      ${defaultCodeBanner}
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

      <!-- Distress Score Snapshot -->
      <div class="card" style="margin-bottom:1.25rem">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
          <div class="sec-lbl" style="margin:0">🔥 Distress Score Snapshot</div>
          <a href="/records/_distress" style="font-size:12px;color:#888;text-decoration:none">Audit page →</a>
        </div>
        <div style="display:grid;grid-template-columns:2fr 3fr;gap:24px;align-items:start">
          <!-- Band breakdown -->
          <div>
            <div style="display:flex;gap:6px;height:36px;border-radius:6px;overflow:hidden;background:#f0efe9;margin-bottom:10px">
              ${[
                ['burning', '#c0392b', distressDist.burning],
                ['hot',     '#d35400', distressDist.hot],
                ['warm',    '#9a6800', distressDist.warm],
                ['cold',    '#bbb',    distressDist.cold],
              ].map(([band, color, count]) => {
                const c = parseInt(count || 0);
                const total = parseInt(distressDist.total || 0) || 1;
                const pct = (c / total) * 100;
                return pct > 0 ? `<div style="width:${pct}%;background:${color}" title="${band}: ${c.toLocaleString()}"></div>` : '';
              }).join('')}
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px">
              <div style="display:flex;justify-content:space-between"><span style="color:#c0392b;font-weight:600">● Burning</span><span style="color:#444">${parseInt(distressDist.burning||0).toLocaleString()}</span></div>
              <div style="display:flex;justify-content:space-between"><span style="color:#d35400;font-weight:600">● Hot</span><span style="color:#444">${parseInt(distressDist.hot||0).toLocaleString()}</span></div>
              <div style="display:flex;justify-content:space-between"><span style="color:#9a6800;font-weight:600">● Warm</span><span style="color:#444">${parseInt(distressDist.warm||0).toLocaleString()}</span></div>
              <div style="display:flex;justify-content:space-between"><span style="color:#888;font-weight:600">● Cold</span><span style="color:#444">${parseInt(distressDist.cold||0).toLocaleString()}</span></div>
            </div>
            ${parseInt(distressDist.unscored||0) > 0 ? `<div style="font-size:11px;color:#aaa;margin-top:6px">${parseInt(distressDist.unscored).toLocaleString()} unscored — visit audit page to recompute</div>` : ''}
          </div>
          <!-- Top hot leads -->
          <div>
            <div style="font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Top Distressed Leads (Score 30+)</div>
            ${topHotLeads.length === 0
              ? '<div style="font-size:13px;color:#aaa;padding:12px 0">No properties scored 30 or higher yet.</div>'
              : topHotLeads.map(l => {
                  const colorMap = { burning: '#c0392b', hot: '#d35400', warm: '#9a6800', cold: '#888' };
                  const bgMap = { burning: '#fdecec', hot: '#fff2e6', warm: '#fff8e1', cold: '#f5f4f0' };
                  const color = colorMap[l.distress_band] || '#888';
                  const bg = bgMap[l.distress_band] || '#f5f4f0';
                  return `
                    <a href="/records/${l.id}" style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid #f0efe9;text-decoration:none">
                      <div>
                        <div style="font-size:13px;color:#1a1a1a;font-weight:500">${l.street}</div>
                        <div style="font-size:11px;color:#888">${l.city}, ${l.state_code}</div>
                      </div>
                      <span style="background:${bg};color:${color};padding:3px 9px;border-radius:5px;font-size:11px;font-weight:600">${l.distress_score}</span>
                    </a>`;
                }).join('')}
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

  // Parallel startup — the four ensure* calls don't depend on each other,
  // so run them concurrently. Previously they ran sequentially (~3-4s of DDL)
  // which delayed the first request post-deploy. (Audit #16.)
  const [baseRes, campRes, distRes, settingsRes] = await Promise.allSettled([
    initSchema(),
    campaigns.initCampaignSchema(),
    require('./scoring/distress').ensureDistressSchema(),
    require('./settings').ensureSettingsSchema(),
  ]);
  if (baseRes.status === 'fulfilled')    console.log('Schema ready');
  else                                   console.error('Schema init error:', baseRes.reason?.message || baseRes.reason);
  if (campRes.status === 'fulfilled')    console.log('Campaign schema ready');
  else                                   console.error('Campaign schema init error:', campRes.reason?.message || campRes.reason);
  if (distRes.status === 'fulfilled')    console.log('Distress schema ready');
  else                                   console.error('Distress schema init error:', distRes.reason?.message || distRes.reason);
  if (settingsRes.status === 'fulfilled')console.log('Settings schema ready');
  else                                   console.error('Settings schema init error:', settingsRes.reason?.message || settingsRes.reason);
});

// ─────────────────────────────────────────────────────────────────────────────
// saveRunToDB — bulk UNNEST rewrite (2026-04-17, decision #3).
//
// The old version ran ~12 queries per row in an `allRows` loop: one for each
// of markets/lists/properties/contacts/phones upserts + call_log + marketing
// touch + filtration_result, plus an extra SELECT to look up the existing
// primary contact. At 10k rows, that's 120,000 round-trips to Postgres — on
// a Railway shared worker this meant 3–6 minute "saves" that often timed
// out the browser. This rewrite uses a 13-pass structure where each pass is
// a SINGLE bulk query using UNNEST arrays; entire 10k-row uploads now save
// in 3–8 seconds (~50× improvement).
//
// Also gone: the `await initSchema()` call on line 782. Schema init is now
// gated by a module-level flag in db.js (Audit #16); we don't pay the DDL
// cost per upload any more.
// ─────────────────────────────────────────────────────────────────────────────
async function saveRunToDB(filename, stats, listsSeen, allRows) {
  if (!process.env.DATABASE_URL) return null;
  if (!allRows || !allRows.length) return null;

  const distress = require('./scoring/distress');

  try {
    // ── Pass 0: normalize + partition all rows up-front ──────────────────────
    // Rows with invalid/garbage state_codes are DROPPED (decision #2). Keeps
    // the properties table clean from "46" / "UN" / other nonsense that used
    // to get silently inserted via raw toUpperCase().
    const cleaned = [];
    for (const row of allRows) {
      const state = normalizeState(row['State'] || '');
      if (!state) {
        // Row keeps a filtration_result entry below (for audit) but won't
        // produce a property/market row.
        cleaned.push({ _invalidState: true, phone: String(row['Phone'] || '').replace(/\D/g, ''),
                       listName: row['List Name (REISift Campaign)'] || '',
                       dispo: row['Disposition'] || '',
                       dispoNorm: normDispo(row['Disposition'] || ''),
                       mktResult: row['Marketing Results'] || '',
                       phoneStatus: row['Phone Status'] || '',
                       phoneTag: row['Phone Tag'] || '',
                       callLogCount: row['Call Log Count'] || 0,
                       action: row['Action'] || 'keep' });
        continue;
      }
      cleaned.push({
        street:    (row['Address'] || '').trim(),
        city:      (row['City'] || '').trim(),
        state:     state,
        zip:       (row['Zip Code'] || '').trim(),
        firstName: row['First Name'] || '',
        lastName:  row['Last Name']  || '',
        phone:     String(row['Phone'] || '').replace(/\D/g, ''),
        listName:  row['List Name (REISift Campaign)'] || '',
        dispo:     row['Disposition'] || '',
        dispoNorm: normDispo(row['Disposition'] || ''),
        callDate:  row['Call Log Date'] || null,
        mktResult: row['Marketing Results'] || '',
        phoneStatus: row['Phone Status'] || '',
        phoneTag:  row['Phone Tag'] || '',
        callLogCount: parseInt(row['Call Log Count']) || 0,
        action:    row['Action'] || 'keep',
      });
    }
    const validRows = cleaned.filter(r => !r._invalidState);

    // ── Pass 1: filtration_runs header row ──────────────────────────────────
    const runRes = await dbQuery(
      `INSERT INTO filtration_runs (filename, total_records, lists_detected, records_kept, records_filtered, caught_by_memory)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [filename, stats.totalRows, stats.listsCount, stats.kept, stats.filtered, stats.memCaught]
    );
    const runId = runRes.rows[0].id;

    // Build keys
    const propKey = (r) => `${r.street.toLowerCase()}|${r.city.toLowerCase()}|${r.state}|${r.zip}`;
    const propMap = new Map();    // key → property_id
    const listMap = new Map();    // name → list_id
    const mktMap  = new Map();    // state → market_id
    const contactIdByProp = new Map(); // property_id → contact_id
    const phoneIdMap = new Map(); // "contactId|phone" → phone_id

    // ── Pass 2: bulk INSERT markets for all unique states ────────────────────
    const uniqueStates = [...new Set(validRows.map(r => r.state).filter(Boolean))];
    if (uniqueStates.length > 0) {
      await dbQuery(
        `INSERT INTO markets (name, state_code, state_name)
         SELECT code || ' Market', code, code FROM UNNEST($1::text[]) AS t(code)
         ON CONFLICT (state_code) DO NOTHING`,
        [uniqueStates]
      );
      const mr = await dbQuery(`SELECT id, state_code FROM markets WHERE state_code = ANY($1::text[])`, [uniqueStates]);
      for (const m of mr.rows) mktMap.set(m.state_code, m.id);
    }

    // ── Pass 3: bulk UPSERT lists ────────────────────────────────────────────
    const uniqueLists = [...new Set(validRows.map(r => r.listName).filter(Boolean))];
    if (uniqueLists.length > 0) {
      const lr = await dbQuery(
        `INSERT INTO lists (list_name) SELECT unnest($1::text[])
         ON CONFLICT (list_name) DO UPDATE SET list_name = EXCLUDED.list_name
         RETURNING id, list_name`,
        [uniqueLists]
      );
      for (const l of lr.rows) listMap.set(l.list_name, l.id);
    }

    // ── Pass 4: dedupe properties, bulk UPSERT via UNNEST ────────────────────
    const propBucket = new Map();
    for (const r of validRows) {
      if (!r.street || !r.city) continue;
      const k = propKey(r);
      if (!propBucket.has(k)) propBucket.set(k, r);
    }
    const propArr = Array.from(propBucket.values());
    if (propArr.length > 0) {
      const pr = await dbQuery(`
        INSERT INTO properties (street, city, state_code, zip_code, market_id)
        SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::int[])
          AS t(street, city, state_code, zip_code, market_id)
        ON CONFLICT (street, city, state_code, zip_code) DO UPDATE SET updated_at = NOW()
        RETURNING id, street, city, state_code, zip_code
      `, [
        propArr.map(r => r.street),
        propArr.map(r => r.city),
        propArr.map(r => r.state),
        propArr.map(r => r.zip),
        propArr.map(r => mktMap.get(r.state) || null),
      ]);
      for (const p of pr.rows) {
        const k = `${p.street.toLowerCase()}|${p.city.toLowerCase()}|${p.state_code}|${p.zip_code}`;
        propMap.set(k, p.id);
      }
    }

    // ── Pass 5: bulk INSERT property_lists links ─────────────────────────────
    const plPairs = new Set();
    for (const r of validRows) {
      if (!r.listName || !r.street) continue;
      const pid = propMap.get(propKey(r));
      const lid = listMap.get(r.listName);
      if (pid && lid) plPairs.add(`${pid}|${lid}`);
    }
    if (plPairs.size > 0) {
      const propIds = [], listIds = [];
      for (const pair of plPairs) {
        const [pi, li] = pair.split('|');
        propIds.push(parseInt(pi));
        listIds.push(parseInt(li));
      }
      await dbQuery(`
        INSERT INTO property_lists (property_id, list_id)
        SELECT * FROM UNNEST($1::int[], $2::int[]) AS t(property_id, list_id)
        ON CONFLICT DO NOTHING
      `, [propIds, listIds]);
    }

    // ── Pass 6: preload existing primary contacts for touched properties ─────
    const touchedPropIds = [...new Set(Array.from(propMap.values()))];
    const existingPC = new Map();
    if (touchedPropIds.length > 0) {
      const ex = await dbQuery(
        `SELECT property_id, contact_id FROM property_contacts
          WHERE property_id = ANY($1::int[]) AND primary_contact = true`,
        [touchedPropIds]
      );
      for (const row of ex.rows) existingPC.set(row.property_id, row.contact_id);
    }

    // ── Pass 7: split contacts into update vs insert, do each in bulk ────────
    const propContactData = new Map(); // propId → {first, last}
    for (const r of validRows) {
      if (!r.street || !r.city) continue;
      if (!r.firstName && !r.lastName) continue;
      const pid = propMap.get(propKey(r));
      if (!pid) continue;
      if (!propContactData.has(pid)) {
        propContactData.set(pid, { firstName: r.firstName, lastName: r.lastName });
      }
    }

    const updIds = [], updFirst = [], updLast = [];
    const newProps = [], newFirsts = [], newLasts = [];
    for (const [pid, data] of propContactData) {
      if (existingPC.has(pid)) {
        const cid = existingPC.get(pid);
        contactIdByProp.set(pid, cid);
        updIds.push(cid); updFirst.push(data.firstName); updLast.push(data.lastName);
      } else {
        newProps.push(pid); newFirsts.push(data.firstName); newLasts.push(data.lastName);
      }
    }
    if (updIds.length > 0) {
      await dbQuery(`
        UPDATE contacts SET
          first_name = COALESCE(NULLIF(t.first_name,''), contacts.first_name),
          last_name  = COALESCE(NULLIF(t.last_name,''),  contacts.last_name),
          updated_at = NOW()
        FROM UNNEST($1::int[], $2::text[], $3::text[]) AS t(id, first_name, last_name)
        WHERE contacts.id = t.id
      `, [updIds, updFirst, updLast]);
    }
    if (newProps.length > 0) {
      const nr = await dbQuery(`
        INSERT INTO contacts (first_name, last_name)
        SELECT * FROM UNNEST($1::text[], $2::text[]) AS t(first_name, last_name)
        RETURNING id
      `, [newFirsts, newLasts]);
      const newIds = nr.rows.map(r => r.id);
      await dbQuery(`
        INSERT INTO property_contacts (property_id, contact_id, primary_contact)
        SELECT * FROM UNNEST($1::int[], $2::int[], $3::bool[]) AS t(property_id, contact_id, primary_contact)
        ON CONFLICT DO NOTHING
      `, [newProps, newIds, newProps.map(() => true)]);
      for (let i = 0; i < newProps.length; i++) contactIdByProp.set(newProps[i], newIds[i]);
    }

    // ── Pass 8: bulk UPSERT phones ───────────────────────────────────────────
    const phoneBucket = new Map();
    for (const r of validRows) {
      if (!r.phone || !r.street) continue;
      const pid = propMap.get(propKey(r));
      const cid = pid ? contactIdByProp.get(pid) : null;
      if (!cid) continue;
      const key = `${cid}|${r.phone}`;
      phoneBucket.set(key, { contactId: cid, phone: r.phone, status: r.phoneStatus, tag: r.phoneTag });
    }
    if (phoneBucket.size > 0) {
      const arr = Array.from(phoneBucket.values());
      const phr = await dbQuery(`
        INSERT INTO phones (contact_id, phone_number, phone_status, phone_tag)
        SELECT * FROM UNNEST($1::int[], $2::text[], $3::text[], $4::text[])
          AS t(contact_id, phone_number, phone_status, phone_tag)
        ON CONFLICT (contact_id, phone_number) DO UPDATE SET
          phone_status = CASE WHEN EXCLUDED.phone_status NOT IN ('','unknown')
                              THEN EXCLUDED.phone_status
                              ELSE phones.phone_status END,
          phone_tag    = COALESCE(NULLIF(EXCLUDED.phone_tag,''), phones.phone_tag),
          updated_at   = NOW()
        RETURNING id, contact_id, phone_number
      `, [
        arr.map(p => p.contactId),
        arr.map(p => p.phone),
        arr.map(p => p.status),
        arr.map(p => p.tag),
      ]);
      for (const p of phr.rows) phoneIdMap.set(`${p.contact_id}|${p.phone_number}`, p.id);
    }

    // ── Pass 9: bulk INSERT call_logs for rows with a disposition + phone ────
    const callLogRows = [];
    for (const r of validRows) {
      if (!r.dispo || !r.phone || !r.street) continue;
      const pid = propMap.get(propKey(r));
      const cid = pid ? contactIdByProp.get(pid) : null;
      const phoneId = (cid && r.phone) ? phoneIdMap.get(`${cid}|${r.phone}`) : null;
      if (!phoneId) continue;
      callLogRows.push({
        phoneId,
        listId:    listMap.get(r.listName) || null,
        propertyId: pid,
        dispo:     r.dispo,
        dispoNorm: r.dispoNorm,
        callDate:  r.callDate,
        campaignName: r.listName,
      });
    }
    if (callLogRows.length > 0) {
      await dbQuery(`
        INSERT INTO call_logs (phone_id, list_id, property_id, disposition, disposition_normalized, call_date, campaign_name)
        SELECT * FROM UNNEST($1::int[], $2::int[], $3::int[], $4::text[], $5::text[], $6::date[], $7::text[])
          AS t(phone_id, list_id, property_id, disposition, disposition_normalized, call_date, campaign_name)
      `, [
        callLogRows.map(r => r.phoneId),
        callLogRows.map(r => r.listId),
        callLogRows.map(r => r.propertyId),
        callLogRows.map(r => r.dispo),
        callLogRows.map(r => r.dispoNorm),
        callLogRows.map(r => r.callDate),
        callLogRows.map(r => r.campaignName),
      ]);
    }

    // ── Pass 10: transfer handling — single UPDATE for each of props/phones ──
    const transferRows = callLogRows.filter(r => r.dispoNorm === 'transfer' && r.propertyId);
    if (transferRows.length > 0) {
      const xferPropIds  = [...new Set(transferRows.map(r => r.propertyId))];
      const xferPhoneIds = [...new Set(transferRows.map(r => r.phoneId))];
      const priorRes = await dbQuery(
        `SELECT id, pipeline_stage FROM properties WHERE id = ANY($1::int[])`,
        [xferPropIds]
      );
      const priorMap = new Map();
      for (const p of priorRes.rows) priorMap.set(p.id, p.pipeline_stage);

      await dbQuery(
        `UPDATE properties SET pipeline_stage='lead', updated_at=NOW()
          WHERE id = ANY($1::int[]) AND pipeline_stage NOT IN ('contract','closed')`,
        [xferPropIds]
      );
      await dbQuery(
        `UPDATE phones SET phone_status='correct', updated_at=NOW()
          WHERE id = ANY($1::int[])`,
        [xferPhoneIds]
      );
      // Outcome log — only for props that actually changed stage
      for (const pid of xferPropIds) {
        const prev = priorMap.get(pid);
        if (prev !== 'lead' && prev !== 'contract' && prev !== 'closed') {
          try { await distress.logOutcomeChange(pid, 'pipeline_stage', prev, 'lead'); }
          catch (e) {
            // 2026-04-20 pass 12: was `catch(e) { /* non-fatal */ }` — swallowed
            // audit log failures silently, leaving invisible holes in the
            // pipeline_stage outcome history on any FK violation or schema
            // drift. Still non-fatal to the parent request (transfer succeeded)
            // but now the operator can see the gap in Railway logs.
            console.error(`[distress/outcome-log] pipeline_stage ${prev}→lead for property ${pid} failed to log:`, e.message);
          }
        }
      }
    }

    // ── Pass 11: marketing_touches writes REMOVED (audit fix #12) ────────────
    // The marketing_touches table is written here on every filtration but is
    // never read anywhere in the app. It was an aspirational data model for a
    // "marketing history" feature that was never built. Writes removed to stop
    // silently accumulating rows and paying for index maintenance. The same
    // data lives in filtration_results (Pass 12 below) which IS used. If the
    // history feature is built later, either read from filtration_results or
    // revive this write path.
    //
    // The table itself is NOT dropped — that's destructive and data could still
    // be useful if someone wants it later. It just stops growing from now on.

    // ── Pass 12: bulk INSERT filtration_results (every row, valid or not) ────
    await dbQuery(`
      INSERT INTO filtration_results (run_id, phone_number, list_name, property_id, phone_id, disposition, disposition_normalized, cumulative_count, action, phone_status, phone_tag, marketing_result)
      SELECT $1, * FROM UNNEST($2::text[], $3::text[], $4::int[], $5::int[], $6::text[], $7::text[], $8::int[], $9::text[], $10::text[], $11::text[], $12::text[])
        AS t(phone_number, list_name, property_id, phone_id, disposition, disposition_normalized, cumulative_count, action, phone_status, phone_tag, marketing_result)
    `, [
      runId,
      cleaned.map(r => r.phone),
      cleaned.map(r => r.listName),
      cleaned.map(r => r._invalidState ? null : (propMap.get(propKey(r)) || null)),
      cleaned.map(r => {
        if (r._invalidState) return null;
        const pid = propMap.get(propKey(r));
        const cid = pid ? contactIdByProp.get(pid) : null;
        return (cid && r.phone) ? phoneIdMap.get(`${cid}|${r.phone}`) || null : null;
      }),
      cleaned.map(r => r.dispo),
      cleaned.map(r => r.dispoNorm),
      cleaned.map(r => r.callLogCount),
      cleaned.map(r => r.action),
      cleaned.map(r => r.phoneStatus),
      cleaned.map(r => r.phoneTag),
      cleaned.map(r => r.mktResult),
    ]);

    // ── Pass 13: distress rescoring ──────────────────────────────────────────
    if (touchedPropIds.length > 0) {
      try {
        const startedAt = Date.now();
        const { scored } = await distress.scoreProperties(touchedPropIds);
        console.log(`[saveRunToDB] distress rescored ${scored} of ${touchedPropIds.length} properties in ${Date.now()-startedAt}ms`);
      } catch (e) {
        console.error('[saveRunToDB] distress rescoring failed:', e.message);
      }
    }

    return runId;
  } catch (err) {
    console.error('saveRunToDB error:', err.message);
    return null;
  }
}



// ── Upload Flow Routes (OLD handlers here were dead — superseded by
//    app.use('/upload', uploadRoutes) at line 112, which routes everything
//    to routes/upload-routes.js. Removed in 2026-04-17 audit. If you want
//    the Bulk Import (REISift) 3-card landing page restored, update
//    ui/upload.js uploadChoosePage() instead of adding handlers here.) ─────

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
    res.send(campaignDetailPage(c, { msg: req.query.msg || '', err: req.query.err || '' }));
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

// 2026-04-20 audit fix #B: rename a campaign. Validation lives in
// campaigns.updateCampaignName(); route just surfaces the result via flash.
app.post('/campaigns/:id/rename', requireAuth, async (req, res) => {
  try {
    const result = await campaigns.updateCampaignName(req.params.id, req.body.name);
    if (!result.ok) {
      return res.redirect('/campaigns/' + req.params.id + '?err=' + encodeURIComponent(result.error));
    }
    res.redirect('/campaigns/' + req.params.id + '?msg=' + encodeURIComponent('Campaign renamed.'));
  } catch (e) {
    console.error('[campaigns/rename]', e);
    res.redirect('/campaigns/' + req.params.id + '?err=' + encodeURIComponent('Rename failed: ' + e.message));
  }
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
    const result = processCSV(bufferToCsvText(req.file.buffer), memory, req.params.id);
    await saveMemory(result.memory);
    req.session.lastResult = { cleanRows: result.cleanRows, filteredRows: result.filteredRows };
    const allRows = [...result.cleanRows, ...result.filteredRows];
    const sourceList = allRows[0]?.['List Name (REISift Campaign)'] || req.file.originalname;
    await campaigns.recordUpload(req.params.id, req.file.originalname, sourceList, req.body.channel || 'cold_call', allRows, result.totalRows);
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
    const parsed = Papa.parse(bufferToCsvText(req.file.buffer), { header: true, skipEmptyLines: true });
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
    const parsed = Papa.parse(bufferToCsvText(req.file.buffer), { header: true, skipEmptyLines: true });
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

// ═══════════════════════════════════════════════════════════════════════════════
// SECURITY SETTINGS — Delete code management
// Gates all destructive operations (record deletion, bulk merges of 10+).
// Default code is seeded to 'HudREI2026' on first boot; user should change it
// immediately via the UI here.
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/settings/security', requireAuth, async (req, res) => {
  const settings = require('./settings');
  const { shell } = require('./shared-shell');
  let updatedAt = null;
  try {
    await settings.ensureSettingsSchema();
    updatedAt = await settings.getDeleteCodeUpdatedAt();
  } catch (e) { console.error('[settings/security] load error:', e.message); }
  const msg = req.query.msg || '';
  const err = req.query.err || '';
  const escHTML = (s) => String(s || '').replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
  const msgSafe = escHTML(msg);
  const errSafe = escHTML(err);
  const lastUpdated = updatedAt ? new Date(updatedAt).toLocaleString('en-US') : '—';
  res.send(shell('Security Settings', `
    <div style="max-width:640px">
      <div style="margin-bottom:1rem"><a href="/dashboard" style="font-size:13px;color:#888;text-decoration:none">← Dashboard</a></div>
      <div style="margin-bottom:1.5rem">
        <div style="font-size:24px;font-weight:700;letter-spacing:-.3px">Security Settings</div>
        <div style="font-size:13px;color:#888;margin-top:4px">Control the delete code that gates destructive operations</div>
      </div>

      ${msgSafe ? `<div class="card" style="margin-bottom:1rem;background:#eaf6ea;border-color:#9bd09b;padding:12px 16px;color:#1a5f1a;font-size:13px">✅ ${msgSafe}</div>` : ''}
      ${errSafe ? `<div class="card" style="margin-bottom:1rem;background:#fdeaea;border-color:#f5c5c5;padding:12px 16px;color:#8b1f1f;font-size:13px">❌ ${errSafe}</div>` : ''}

      <div class="card" style="padding:20px;margin-bottom:1rem">
        <div style="font-size:15px;font-weight:600;margin-bottom:8px">Delete Code</div>
        <div style="font-size:13px;color:#666;margin-bottom:16px;line-height:1.5">
          This code is required before any property records can be deleted or when bulk-merging 10+ duplicate groups.
          It is shared across all destructive actions — one code for everything.
          <br><br>
          <strong>Last updated:</strong> ${lastUpdated}
        </div>

        <form method="POST" action="/settings/security/delete-code" style="display:flex;flex-direction:column;gap:12px">
          <div>
            <label style="font-size:12px;color:#888;display:block;margin-bottom:4px">Current Code</label>
            <input type="password" name="old_code" required autocomplete="off" style="width:100%;padding:9px 12px;border:1px solid #ddd;border-radius:8px;font-size:14px;font-family:inherit">
          </div>
          <div>
            <label style="font-size:12px;color:#888;display:block;margin-bottom:4px">New Code (min 6 characters)</label>
            <input type="password" name="new_code" required minlength="6" autocomplete="new-password" style="width:100%;padding:9px 12px;border:1px solid #ddd;border-radius:8px;font-size:14px;font-family:inherit">
          </div>
          <div>
            <label style="font-size:12px;color:#888;display:block;margin-bottom:4px">Confirm New Code</label>
            <input type="password" name="confirm_code" required minlength="6" autocomplete="new-password" style="width:100%;padding:9px 12px;border:1px solid #ddd;border-radius:8px;font-size:14px;font-family:inherit">
          </div>
          <button type="submit" style="background:#1a1a1a;color:#fff;border:none;padding:10px 16px;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer;font-family:inherit;margin-top:4px">Update Delete Code</button>
        </form>
      </div>

      <div class="card" style="padding:16px;background:#fff8e1;border-color:#f5d06b">
        <div style="font-size:13px;color:#7a5a00;line-height:1.6">
          <strong>⚠️ Important:</strong> If you forget this code, an admin with database access will need to reset it via SQL:
          <code style="background:#fff;padding:2px 6px;border-radius:3px;font-size:11px;display:inline-block;margin-top:4px">UPDATE app_settings SET value = 'NewCode' WHERE key = 'delete_code';</code>
        </div>
      </div>
    </div>
  `, 'setup'));
});

app.post('/settings/security/delete-code', requireAuth, async (req, res) => {
  const settings = require('./settings');
  const { old_code, new_code, confirm_code } = req.body;
  if (!old_code || !new_code || !confirm_code) {
    return res.redirect('/settings/security?err=' + encodeURIComponent('All fields required.'));
  }
  if (new_code !== confirm_code) {
    return res.redirect('/settings/security?err=' + encodeURIComponent('New code and confirmation do not match.'));
  }
  const result = await settings.updateDeleteCode(old_code, new_code);
  if (!result.ok) {
    return res.redirect('/settings/security?err=' + encodeURIComponent(result.error));
  }
  res.redirect('/settings/security?msg=' + encodeURIComponent('Delete code updated successfully.'));
});

// NIS upload POST
app.post('/nis/upload', requireAuth, upload.single('nisfile'), async (req, res) => {
  try {
    if (!req.file) return res.redirect('/nis');
    await campaigns.initCampaignSchema();
    const csvText = bufferToCsvText(req.file.buffer);
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


// Reset campaign stats — clears numbers, uploads, and campaign-scoped Redis keys
app.post('/campaigns/:id/reset', requireAuth, async (req, res) => {
  try {
    const { query: dbQ } = require('./db');
    const campId = req.params.id;

    // Clear campaign numbers and uploads from DB
    await dbQ('DELETE FROM campaign_numbers WHERE campaign_id=$1', [campId]);
    await dbQ('DELETE FROM campaign_uploads WHERE campaign_id=$1', [campId]);

    // Reset all campaign totals to zero
    await dbQ(`UPDATE campaigns SET
      total_unique_numbers=0, total_callable=0, total_filtered=0,
      total_wrong_numbers=0, total_voicemails=0, total_not_interested=0,
      total_do_not_call=0, total_transfers=0, total_connected=0,
      upload_count=0, updated_at=NOW()
      WHERE id=$1`, [campId]);

    // Clear campaign-scoped Redis memory keys
    const memory = await loadMemory();
    const prefix = 'campaign:' + campId + '||';
    let cleared = 0;
    Object.keys(memory).forEach(k => {
      if (k.startsWith(prefix)) { delete memory[k]; cleared++; }
    });
    await saveMemory(memory);
    console.log('[reset] Campaign', campId, '— cleared', cleared, 'Redis keys');

    res.redirect('/campaigns/' + campId);
  } catch(e) {
    console.error('Reset campaign error:', e.message);
    res.redirect('/campaigns/' + req.params.id);
  }
});

// Delete campaign
app.post('/campaigns/:id/delete', requireAuth, async (req, res) => {
  try {
    const { query: dbQ } = require('./db');
    const id = req.params.id;
    // Only allow deleting completed campaigns
    const campRes = await dbQ('SELECT status FROM campaigns WHERE id=$1', [id]);
    if (!campRes.rows.length) return res.redirect('/campaigns');
    if (campRes.rows[0].status !== 'completed') return res.redirect('/campaigns/' + id);
    // Cascade delete — uploads, numbers, contacts, phones all cascade via FK
    await dbQ('DELETE FROM campaigns WHERE id=$1', [id]);
    res.redirect('/campaigns');
  } catch(e) {
    console.error('Delete campaign error:', e.message);
    res.redirect('/campaigns');
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


function campaignDetailPage(c, flash) {
  flash = flash || {};
  // Escape so the campaign name can safely flow into an HTML attribute on
  // the rename modal's <input value="..."> and into visible text.
  const escAttr = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;');
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
    ${flash.err ? `<div class="alert alert-error" style="margin-bottom:1rem">${escAttr(flash.err)}</div>` : ''}
    ${flash.msg ? `<div class="alert alert-success" style="margin-bottom:1rem">${escAttr(flash.msg)}</div>` : ''}
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:1.5rem;flex-wrap:wrap;gap:12px">
      <div>
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">
          <h2 style="font-size:20px;font-weight:500">${escAttr(c.name)}</h2>
          <!-- 2026-04-20 audit fix #B: edit-name pencil icon -->
          <button type="button" onclick="document.getElementById('rename-campaign-modal').classList.add('open');setTimeout(function(){document.getElementById('rename-campaign-input').focus();document.getElementById('rename-campaign-input').select();},50)"
                  title="Edit campaign name"
                  style="background:none;border:none;padding:4px;cursor:pointer;color:#888;display:inline-flex;align-items:center;border-radius:6px;transition:background .12s"
                  onmouseover="this.style.background='#f0efe9';this.style.color='#1a1a1a'"
                  onmouseout="this.style.background='none';this.style.color='#888'">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
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
        <form method="POST" action="/campaigns/${c.id}/reset" onsubmit="return confirm('Reset all campaign stats and memory? This clears all upload history and counts for this campaign. Cannot be undone.')" style="display:inline">
          <button type="submit" style="padding:7px 14px;font-size:13px;border:1px solid #f5c5c5;border-radius:8px;background:#fff;color:#c0392b;cursor:pointer;font-family:inherit">Reset stats</button>
        </form>
        <form method="POST" action="/campaigns/${c.id}/new-round" onsubmit="return confirm('Close this campaign and start a new round with the same settings and fresh memory?')" style="display:inline">
          <button type="submit" style="padding:7px 14px;font-size:13px;border:none;border-radius:8px;background:#1a1a1a;color:#fff;cursor:pointer;font-family:inherit">Start new round</button>
        </form>` : `<span style="font-size:13px;color:#888;padding:7px 0;display:inline-block">Completed ${c.end_date ? '· ' + new Date(c.end_date).toLocaleDateString() : ''}</span>
        <form method="POST" action="/campaigns/${c.id}/delete" onsubmit="return confirm('Permanently delete this campaign and all its data? This cannot be undone.')" style="display:inline">
          <button type="submit" style="padding:7px 14px;font-size:13px;border:1px solid #f5c5c5;border-radius:8px;background:#fff;color:#c0392b;cursor:pointer;font-family:inherit">Delete campaign</button>
        </form>`}
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
${c.sms_status === 'active' ? `
        <div style="margin-top:1rem;padding-top:1rem;border-top:1px solid #f0f0f0">
          <div class="sec-lbl" style="margin-bottom:8px">Upload SmarterContact SMS results</div>
          <form method="POST" action="/campaigns/${c.id}/sms/upload" enctype="multipart/form-data">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <input type="file" name="smsfile" accept=".csv" required style="font-size:13px;padding:6px;border:1px solid #ddd;border-radius:7px;background:#fff">
              <button type="submit" style="padding:7px 16px;background:#2563eb;color:#fff;border:none;border-radius:7px;font-size:13px;cursor:pointer;font-family:inherit">Upload SMS results</button>
            </div>
            <p style="font-size:11px;color:#aaa;margin-top:6px">Required columns: Phone, Labels, First name, Last name, Property address, Property city, Property state, Property zip. One label per row only.</p>
          </form>
        </div>` : ''}
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
    </div>` : c.active_channel === 'cold_call' ? `
    <div class="card" style="padding:1rem 1.25rem;margin-bottom:1.25rem">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div class="sec-lbl" style="margin-bottom:0">Upload filtration file to this campaign</div>
        <select id="channel-select" class="inline-select">
          <option value="cold_call" selected>Cold Call</option>
        </select>
      </div>
      <div class="drop-zone" id="drop-zone" style="padding:1.5rem">
        <strong style="font-size:14px">Drop Readymode CSV here or click to browse</strong>
        <p style="font-size:12px;color:#888;margin-top:4px">File will be filtered and recorded against this campaign</p>
      </div>
      <input type="file" id="file-input" accept=".csv" style="display:none">
      <div id="upload-spinner" style="display:none;align-items:center;gap:8px;font-size:13px;color:#888;padding:8px 0"><div class="spinner"></div> Processing…</div>
    </div>` : `
    <div class="card" style="padding:1rem 1.25rem;margin-bottom:1.25rem;background:#fafaf8">
      <p style="font-size:13px;color:#888;text-align:center;padding:8px 0">This is an SMS campaign — upload SMS results in the Contact List section above.</p>
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

    <!-- 2026-04-20 audit fix #B: rename campaign modal -->
    <div id="rename-campaign-modal" class="modal-overlay">
      <div class="modal" style="max-width:480px">
        <div class="modal-header">
          <div class="modal-title">Rename campaign</div>
          <button type="button" class="modal-close" onclick="document.getElementById('rename-campaign-modal').classList.remove('open')">×</button>
        </div>
        <form method="POST" action="/campaigns/${c.id}/rename">
          <div class="form-field">
            <label>Campaign name</label>
            <input type="text" id="rename-campaign-input" name="name" value="${escAttr(c.name)}" required maxlength="255" autocomplete="off">
            <span class="field-hint">Duplicate names are allowed — use whatever makes sense for you.</span>
          </div>
          <div style="display:flex;gap:8px;margin-top:1rem">
            <button type="submit" class="btn btn-primary" style="flex:1">Save</button>
            <button type="button" class="btn btn-ghost" onclick="document.getElementById('rename-campaign-modal').classList.remove('open')">Cancel</button>
          </div>
        </form>
      </div>
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
