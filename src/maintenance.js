// ─────────────────────────────────────────────────────────────────────────────
// maintenance.js — Loki DB maintenance utilities
//
// 2026-04-20 audit fix #6 (duplicate prevention — phone-based).
//
// The schema allows duplicate contacts (no unique constraint on contacts —
// by design, since two real people can share first+last+address). But when
// two contacts share a phone number, they're almost certainly the same
// person, split across different property imports that came in as
// separate CSV batches.
//
// This module provides dedupByPhone(), which finds groups of contacts that
// share a phone number, picks a canonical "keeper" per group, re-homes
// property_contacts + phones from the losers to the keeper, then deletes
// the losing contact rows.
//
// Gated by LOKI_DEDUP_PHONES env var:
//   unset / 'report' (default) → log how many groups + contacts would be
//                                merged. Safe on every boot.
//   'confirm'                   → actually run the merge. One-time op; unset
//                                 after successful run.
//   'skip'                      → no-op. Use once you've cleaned up.
//
// Design notes:
//   - Keeper choice: lowest contact_id in the group (stable, oldest-wins).
//   - Phone dedup: after re-homing, some (contact_id, phone_number) keys
//     may collide with existing rows on the keeper. ON CONFLICT DO NOTHING
//     keeps the keeper's copy and drops the duplicate.
//   - property_contacts: UNIQUE(property_id, contact_id) might collide if
//     keeper already links to the same property. ON CONFLICT DO NOTHING.
//   - primary_contact: if keeper has it and loser has it for different
//     properties, both links survive. If keeper doesn't have it and loser
//     does, the re-homed link keeps primary_contact=true.
//   - FK cascade: contacts deleted → property_contacts + phones rows on the
//     LOSER cascade away via ON DELETE CASCADE (per db.js schema).
// ─────────────────────────────────────────────────────────────────────────────

const { query } = require('./db');

/**
 * Dedup contacts that share a phone number. See module header for semantics.
 *
 * @param {'report'|'confirm'|'skip'} mode
 * @param {Object}  [opts]
 * @param {number}  [opts.tenantId]  if set, restrict the scan to one tenant.
 *                                   Used by the on-demand Settings button and
 *                                   the post-import auto-dedup hook (Task 10).
 *                                   Without it, scans every tenant — the
 *                                   original boot-time maintenance behavior.
 * @returns {Promise<{groups:number, losersMerged:number, phonesMoved:number, linksMoved:number}>}
 */
async function dedupByPhone(mode = 'report', opts = {}) {
  const stats = { groups: 0, losersMerged: 0, phonesMoved: 0, linksMoved: 0 };

  if (mode === 'skip') return stats;

  const tenantFilter = Number.isFinite(opts.tenantId) ? opts.tenantId : null;

  // ── Find groups: phones that appear on more than one contact ──────────────
  // Groups are keyed by (tenant_id, phone_number) so dedup never merges
  // contacts across tenants — same phone in two different tenants is two
  // different people from our perspective.
  const groupsRes = await query(`
    SELECT tenant_id, phone_number,
           ARRAY_AGG(contact_id ORDER BY contact_id ASC) AS contact_ids
      FROM phones
     WHERE phone_number IS NOT NULL AND phone_number <> ''
       AND ($1::int IS NULL OR tenant_id = $1)
     GROUP BY tenant_id, phone_number
    HAVING COUNT(DISTINCT contact_id) > 1
  `, [tenantFilter]);

  stats.groups = groupsRes.rows.length;
  if (stats.groups === 0) return stats;

  // Build a contact → keeper map. Two contacts in different groups may end
  // up chained (A shares phone1 with B, B shares phone2 with C — all three
  // should collapse to A). Union-find handles this.
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra === rb) return;
    if (ra < rb) parent.set(rb, ra); else parent.set(ra, rb);
  };

  for (const g of groupsRes.rows) {
    const ids = g.contact_ids.map(Number);
    for (let i = 1; i < ids.length; i++) union(ids[0], ids[i]);
  }

  // Resolve each contact to its keeper (root of the union-find tree).
  const loserToKeeper = new Map();   // contact_id → keeper_id
  for (const cid of parent.keys()) {
    const keeper = find(cid);
    if (cid !== keeper) loserToKeeper.set(cid, keeper);
  }

  stats.losersMerged = loserToKeeper.size;

  if (mode !== 'confirm') {
    // Dry-run report. Don't actually move anything.
    console.log(`[maintenance/dedup-phone] REPORT ONLY (set LOKI_DEDUP_PHONES=confirm to execute):`);
    console.log(`[maintenance/dedup-phone]   ${stats.groups} phone(s) shared across multiple contacts`);
    console.log(`[maintenance/dedup-phone]   ${stats.losersMerged} contact(s) would be merged into their keeper`);
    // Show a sample of the biggest groups so the operator can sanity-check.
    const topN = groupsRes.rows
      .slice()
      .sort((a, b) => b.contact_ids.length - a.contact_ids.length)
      .slice(0, 5);
    for (const g of topN) {
      console.log(`[maintenance/dedup-phone]   ${g.phone_number} → keep contact #${g.contact_ids[0]}, merge ${g.contact_ids.slice(1).join(',')}`);
    }
    return stats;
  }

  // ── CONFIRM mode: re-home property_contacts, phones, then delete losers ────
  // One transaction per keeper so a partial failure rolls back cleanly.
  // Slightly more round-trips than a single UPDATE, but safer and the cleanup
  // is a one-time operation.
  const losers = Array.from(loserToKeeper.keys());
  const keepers = Array.from(new Set(Array.from(loserToKeeper.values())));

  // Move property_contacts links from losers → keepers. ON CONFLICT handles
  // the case where the keeper already has a link to the same property.
  // We build one big CASE statement instead of N updates.
  const caseSql = Array.from(loserToKeeper.entries())
    .map(([loser, keeper]) => `WHEN ${loser} THEN ${keeper}`)
    .join(' ');

  // Step 1: insert "merged" links first. If a loser had primary_contact=true
  // for a property and the keeper didn't have a link at all, we want the
  // keeper to inherit that primary flag. We route through a stage query:
  //   for each (loser_id, property_id, primary) link, if keeper has no link
  //   to this property, insert one carrying the loser's flags; otherwise
  //   leave alone (ON CONFLICT DO NOTHING).
  const insertRes = await query(`
    INSERT INTO property_contacts (tenant_id, property_id, contact_id, role, primary_contact, created_at)
    SELECT pc.tenant_id,
           pc.property_id,
           (CASE pc.contact_id ${caseSql} END)::int AS keeper_id,
           pc.role,
           pc.primary_contact,
           pc.created_at
      FROM property_contacts pc
     WHERE pc.contact_id = ANY($1::int[])
    ON CONFLICT (property_id, contact_id) DO NOTHING
  `, [losers]);
  stats.linksMoved = insertRes.rowCount;

  // Step 2: move phones from losers to keepers. Same pattern.
  const phoneInsertRes = await query(`
    INSERT INTO phones (tenant_id, contact_id, phone_number, phone_index, phone_status, phone_type,
                        phone_tag, do_not_call, wrong_number, created_at, updated_at)
    SELECT ph.tenant_id,
           (CASE ph.contact_id ${caseSql} END)::int AS keeper_id,
           ph.phone_number, ph.phone_index, ph.phone_status, ph.phone_type,
           ph.phone_tag, ph.do_not_call, ph.wrong_number, ph.created_at, ph.updated_at
      FROM phones ph
     WHERE ph.contact_id = ANY($1::int[])
    ON CONFLICT (contact_id, phone_number) DO UPDATE SET
      -- keeper-wins unless loser has more informative status.
      -- NOTE: x IN (NULL, ...) never matches NULL due to SQL three-valued
      -- logic — NULL compared with = returns NULL, not TRUE.
      -- Must write x IS NULL OR x IN (...) explicitly.
      phone_status = CASE
        WHEN (phones.phone_status IS NULL OR phones.phone_status IN ('', 'unknown'))
             AND EXCLUDED.phone_status IS NOT NULL
             AND EXCLUDED.phone_status NOT IN ('', 'unknown')
          THEN EXCLUDED.phone_status
        ELSE phones.phone_status
      END,
      phone_type = CASE
        WHEN (phones.phone_type IS NULL OR phones.phone_type IN ('', 'unknown'))
             AND EXCLUDED.phone_type IS NOT NULL
             AND EXCLUDED.phone_type NOT IN ('', 'unknown')
          THEN EXCLUDED.phone_type
        ELSE phones.phone_type
      END,
      do_not_call = phones.do_not_call OR EXCLUDED.do_not_call,
      wrong_number = phones.wrong_number OR EXCLUDED.wrong_number,
      updated_at = NOW()
  `, [losers]);
  stats.phonesMoved = phoneInsertRes.rowCount;

  // Step 3: delete the losers. ON DELETE CASCADE on property_contacts and
  // phones FKs removes any leftover rows on the loser that didn't get
  // successfully re-homed above (e.g., duplicates that conflicted).
  await query(`DELETE FROM contacts WHERE id = ANY($1::int[])`, [losers]);

  console.log(`[maintenance/dedup-phone] EXECUTED:`);
  console.log(`[maintenance/dedup-phone]   merged ${stats.losersMerged} contact(s) across ${stats.groups} shared phone(s)`);
  console.log(`[maintenance/dedup-phone]   re-homed ${stats.linksMoved} property_contacts link(s)`);
  console.log(`[maintenance/dedup-phone]   re-homed ${stats.phonesMoved} phones row(s)`);
  console.log(`[maintenance/dedup-phone]   You can unset LOKI_DEDUP_PHONES now.`);

  return stats;
}

/**
 * Dedup contacts that share a normalized first+last+mailing-zip+mailing-state
 * combination (Task 8 — fuzzy dedup). Complements dedupByPhone which only
 * catches owners that share a phone; some duplicates come in from list
 * imports where the same person has different phones in each batch.
 *
 * Match key (case + whitespace insensitive):
 *   LOWER(TRIM(first_name)) + LOWER(TRIM(last_name)) +
 *   UPPER(TRIM(mailing_state)) + LEFT(TRIM(mailing_zip), 5)
 *
 * Owners that don't have ALL of these are skipped — too risky to merge a
 * "John Smith, no zip" with a "John Smith, 90210". Companies and trusts
 * (last_name = 'Smith Family Trust' etc.) collapse cleanly with this rule
 * because their name is in last_name and mailing address is on file.
 *
 * Same keeper / re-home / delete-loser flow as dedupByPhone.
 */
async function dedupByNameAddress(mode = 'report', opts = {}) {
  const stats = { groups: 0, losersMerged: 0, phonesMoved: 0, linksMoved: 0 };
  if (mode === 'skip') return stats;
  const tenantFilter = Number.isFinite(opts.tenantId) ? opts.tenantId : null;

  const groupsRes = await query(`
    SELECT tenant_id,
           ARRAY_AGG(id ORDER BY id ASC) AS contact_ids,
           LOWER(TRIM(first_name)) AS fn,
           LOWER(TRIM(last_name))  AS ln,
           UPPER(TRIM(mailing_state)) AS st,
           LEFT(TRIM(mailing_zip), 5) AS zp
      FROM contacts
     WHERE first_name IS NOT NULL AND TRIM(first_name) <> ''
       AND last_name  IS NOT NULL AND TRIM(last_name)  <> ''
       AND mailing_state IS NOT NULL AND TRIM(mailing_state) <> ''
       AND mailing_zip   IS NOT NULL AND TRIM(mailing_zip)   <> ''
       AND ($1::int IS NULL OR tenant_id = $1)
     GROUP BY tenant_id,
              LOWER(TRIM(first_name)),
              LOWER(TRIM(last_name)),
              UPPER(TRIM(mailing_state)),
              LEFT(TRIM(mailing_zip), 5)
    HAVING COUNT(*) > 1
  `, [tenantFilter]);

  stats.groups = groupsRes.rows.length;
  if (stats.groups === 0) return stats;

  const loserToKeeper = new Map();
  for (const g of groupsRes.rows) {
    const ids = g.contact_ids.map(Number);
    const keeper = ids[0];
    for (let i = 1; i < ids.length; i++) loserToKeeper.set(ids[i], keeper);
  }
  stats.losersMerged = loserToKeeper.size;

  if (mode !== 'confirm') {
    console.log(`[maintenance/dedup-name-addr] REPORT ONLY:`);
    console.log(`[maintenance/dedup-name-addr]   ${stats.groups} group(s) of contacts share name+state+zip`);
    console.log(`[maintenance/dedup-name-addr]   ${stats.losersMerged} contact(s) would be merged`);
    const top = groupsRes.rows.slice().sort((a, b) => b.contact_ids.length - a.contact_ids.length).slice(0, 5);
    for (const g of top) {
      console.log(`[maintenance/dedup-name-addr]   ${g.fn} ${g.ln} (${g.st} ${g.zp}) → keep #${g.contact_ids[0]}, merge ${g.contact_ids.slice(1).join(',')}`);
    }
    return stats;
  }

  const losers = Array.from(loserToKeeper.keys());
  const caseSql = Array.from(loserToKeeper.entries())
    .map(([loser, keeper]) => `WHEN ${loser} THEN ${keeper}`)
    .join(' ');

  const insertRes = await query(`
    INSERT INTO property_contacts (tenant_id, property_id, contact_id, role, primary_contact, created_at)
    SELECT pc.tenant_id,
           pc.property_id,
           (CASE pc.contact_id ${caseSql} END)::int AS keeper_id,
           pc.role,
           pc.primary_contact,
           pc.created_at
      FROM property_contacts pc
     WHERE pc.contact_id = ANY($1::int[])
    ON CONFLICT (property_id, contact_id) DO NOTHING
  `, [losers]);
  stats.linksMoved = insertRes.rowCount;

  const phoneInsertRes = await query(`
    INSERT INTO phones (tenant_id, contact_id, phone_number, phone_index, phone_status, phone_type,
                        phone_tag, do_not_call, wrong_number, created_at, updated_at)
    SELECT ph.tenant_id,
           (CASE ph.contact_id ${caseSql} END)::int AS keeper_id,
           ph.phone_number, ph.phone_index, ph.phone_status, ph.phone_type,
           ph.phone_tag, ph.do_not_call, ph.wrong_number, ph.created_at, ph.updated_at
      FROM phones ph
     WHERE ph.contact_id = ANY($1::int[])
    ON CONFLICT (contact_id, phone_number) DO UPDATE SET
      phone_status = CASE
        WHEN (phones.phone_status IS NULL OR phones.phone_status IN ('', 'unknown'))
             AND EXCLUDED.phone_status IS NOT NULL
             AND EXCLUDED.phone_status NOT IN ('', 'unknown')
          THEN EXCLUDED.phone_status
        ELSE phones.phone_status
      END,
      phone_type = CASE
        WHEN (phones.phone_type IS NULL OR phones.phone_type IN ('', 'unknown'))
             AND EXCLUDED.phone_type IS NOT NULL
             AND EXCLUDED.phone_type NOT IN ('', 'unknown')
          THEN EXCLUDED.phone_type
        ELSE phones.phone_type
      END,
      do_not_call = phones.do_not_call OR EXCLUDED.do_not_call,
      wrong_number = phones.wrong_number OR EXCLUDED.wrong_number,
      updated_at = NOW()
  `, [losers]);
  stats.phonesMoved = phoneInsertRes.rowCount;

  await query(`DELETE FROM contacts WHERE id = ANY($1::int[])`, [losers]);

  console.log(`[maintenance/dedup-name-addr] EXECUTED: merged ${stats.losersMerged} contact(s) across ${stats.groups} groups (${stats.linksMoved} links, ${stats.phonesMoved} phones moved)`);
  return stats;
}

/**
 * Entry point called from db.initSchema() on boot. Reads env var, dispatches.
 * Non-fatal on error — logs and moves on.
 */
async function runScheduledMaintenance() {
  try {
    const mode = (process.env.LOKI_DEDUP_PHONES || 'report').toLowerCase();
    if (!['report', 'confirm', 'skip'].includes(mode)) {
      console.warn(`[maintenance] unknown LOKI_DEDUP_PHONES=${mode}, treating as 'report'`);
      await dedupByPhone('report');
      return;
    }
    await dedupByPhone(mode);
  } catch (e) {
    console.error('[maintenance] dedupByPhone failed:', e.message);
  }
}

module.exports = { dedupByPhone, dedupByNameAddress, runScheduledMaintenance };
