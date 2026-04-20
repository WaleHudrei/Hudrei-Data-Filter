const express = require('express');
const multer = require('multer');
const Papa = require('papaparse');
const router = express.Router();
const uploadUI = require('../ui/upload');
const { bufferToCsvText } = require('../csv-utils');

// 2026-04-18 audit fix #43: this second multer instance (separate from the one
// in server.js) was missing the fileFilter from fix #21. Non-CSV uploads would
// reach Papa.parse and silently produce empty results — wasted operator time.
// Shared filter logic: accept .csv/.txt by extension or common MIME variants.
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

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.redirect('/login');
}

router.get('/', requireAuth, (req, res) => res.send(uploadUI.uploadChoosePage()));
router.get('/filter', requireAuth, (req, res) => res.send(uploadUI.uploadFilterStep1Page()));
router.get('/filter/map', requireAuth, (req, res) => res.send(uploadUI.uploadFilterStep2Page()));
router.get('/filter/review', requireAuth, (req, res) => res.send(uploadUI.uploadFilterStep3Page()));
router.get('/property', requireAuth, (req, res) => res.send(uploadUI.uploadPropertyStep1Page()));
router.get('/property/map', requireAuth, (req, res) => res.send(uploadUI.uploadPropertyStep2Page()));
router.get('/property/review', requireAuth, (req, res) => res.send(uploadUI.uploadPropertyStep3Page()));

router.post('/filter/parse', requireAuth, upload.single('csvfile'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const parsed = Papa.parse(bufferToCsvText(req.file.buffer), { header: true, skipEmptyLines: true });
    const columns = parsed.meta.fields || [];
    const rows = parsed.data;
    const autoMap = uploadUI.autoMap(columns, uploadUI.REISIFT_FILTER_FIELDS);
    res.json({ columns, rows, autoMap, filename: req.file.originalname, total: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/property/parse', requireAuth, upload.single('csvfile'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const parsed = Papa.parse(bufferToCsvText(req.file.buffer), { header: true, skipEmptyLines: true });
    const columns = parsed.meta.fields || [];
    const rows = parsed.data;
    const autoMap = uploadUI.autoMap(columns, uploadUI.REISIFT_PROPERTY_FIELDS);
    res.json({ columns, rows, autoMap, filename: req.file.originalname, total: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/filter/process', requireAuth, async (req, res) => {
  try {
    const { rows, mapping, campaignId, filename } = req.body;
    if (!rows || !mapping) return res.status(400).json({ error: 'Missing data.' });

    // 2026-04-18 audit fix #44: after fix #9 made campaignId mandatory in
    // processCSV (to prevent cross-campaign memory leaks), this route broke
    // because it was calling processCSV(csvText, memory) with no third arg.
    // Users going through Upload → Filter → Review would hit a 500 error.
    //
    // Preferred behavior: require campaignId in the request. UI should pass
    // the selected campaign into the review step. Fall back to a synthetic
    // per-request scope if absent — safer than the pre-fix-9 behavior (which
    // shared memory across campaigns with the same list name) because every
    // request gets its own unique scope, so memory is effectively disabled
    // for uploads made through this route without a campaign.
    const scopeId = campaignId
      || `legacy-upload:${filename || 'unnamed'}:${Date.now()}`;

    const { processCSV, loadMemory, saveMemory } = req.app.locals;
    const memory = await loadMemory();
    const csvText = Papa.unparse(rows);
    const result = processCSV(csvText, memory, scopeId);
    await saveMemory(result.memory);
    req.session.lastResult = { cleanRows: result.cleanRows, filteredRows: result.filteredRows };

    const FIELD_MAP = {
      'Call Log Date':    'Call Log Date',
      'Phone':            'Phone',
      'Phone Tag':        'Phone Tag',
      'Call Log Count':   'Call Log Count',
      'Marketing Results':'Marketing Result',
      'Phone Status':     'Phone Status',
      'Call Notes':       'Call Notes',
      'First Name':       'First Name',
      'Last Name':        'Last Name',
      'City':             'City',
      'Address':          'Address',
      'Zip Code':         'Zip Code',
      'State':            'State',
    };

    const filteredMapped = result.filteredRows.map(r => {
      const out = {};
      Object.entries(FIELD_MAP).forEach(([internal, reisiftDefault]) => {
        const userMapped = mapping[reisiftDefault];
        const outputKey = userMapped || reisiftDefault;
        if (r[internal] !== undefined) out[outputKey] = r[internal];
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

module.exports = router;
