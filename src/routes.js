const express = require('express');
const multer = require('multer');
const Papa = require('papaparse');
const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const uploadUI = require('../ui/upload');

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
    const parsed = Papa.parse(req.file.buffer.toString('utf8'), { header: true, skipEmptyLines: true });
    const columns = parsed.meta.fields || [];
    const rows = parsed.data;
    const autoMap = uploadUI.autoMap(columns, uploadUI.REISIFT_FILTER_FIELDS);
    res.json({ columns, rows, autoMap, filename: req.file.originalname, total: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/property/parse', requireAuth, upload.single('csvfile'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const parsed = Papa.parse(req.file.buffer.toString('utf8'), { header: true, skipEmptyLines: true });
    const columns = parsed.meta.fields || [];
    const rows = parsed.data;
    const autoMap = uploadUI.autoMap(columns, uploadUI.REISIFT_PROPERTY_FIELDS);
    res.json({ columns, rows, autoMap, filename: req.file.originalname, total: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/filter/process', requireAuth, async (req, res) => {
  try {
    const { rows, mapping } = req.body;
    if (!rows || !mapping) return res.status(400).json({ error: 'Missing data.' });

    const { processCSV, loadMemory, saveMemory } = req.app.locals;
    const memory = await loadMemory();
    const csvText = Papa.unparse(rows);
    const result = processCSV(csvText, memory);
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
