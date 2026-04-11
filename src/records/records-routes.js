// Records routes — wires up the records section to the main server
const recordsDb = require('./records-db');
const { recordsPage } = require('./records-page');

function registerRecordsRoutes(app, requireAuth, shell) {
  // GET /records — Properties tab (slice 1)
  app.get('/records', requireAuth, async (req, res) => {
    try {
      const search = (req.query.search || '').trim();
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const pageSize = 50;
      const { rows, total } = await recordsDb.getProperties({ search, page, pageSize });
      const stats = await recordsDb.getRecordsStats();
      const body = recordsPage({
        properties: rows,
        stats,
        search,
        page,
        pageSize,
        total,
        syncMsg: req.query.msg || null,
      });
      res.send(shell('Records', body, 'records'));
    } catch (e) {
      console.error('[records] error:', e.message, e.stack);
      res.status(500).send('Records error: ' + e.message);
    }
  });

  // POST /records/sync — import all campaign_contacts into records tables
  app.post('/records/sync', requireAuth, async (req, res) => {
    try {
      console.log('[records/sync] starting...');
      const result = await recordsDb.syncRecordsFromContacts();
      const msg = `Processed ${result.processed} contacts → ${result.newProperties} new properties, ${result.newOwners} new owners, ${result.links} links.`;
      console.log('[records/sync] done:', msg);
      res.redirect('/records?msg=' + encodeURIComponent(msg));
    } catch (e) {
      console.error('[records/sync] error:', e.message, e.stack);
      res.status(500).send(`<h2>Sync failed</h2><p>${e.message}</p><p><a href="/records">Back</a></p>`);
    }
  });
}

module.exports = { registerRecordsRoutes };
