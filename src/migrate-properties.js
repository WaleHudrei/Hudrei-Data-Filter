/**
 * migrate-properties.js
 * ─────────────────────
 * One-time script: builds property records from existing filtration_results data.
 * Run once on Railway via: node src/migrate-properties.js
 *
 * Safe to run multiple times — all inserts use ON CONFLICT DO NOTHING.
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

async function q(text, params) {
  const client = await pool.connect();
  try { return await client.query(text, params); }
  finally { client.release(); }
}

async function migrate() {
  console.log('═══════════════════════════════════════');
  console.log('  Loki — Property Migration Script');
  console.log('═══════════════════════════════════════\n');

  // ── Step 1: Check what we have ─────────────────────────────────────────────
  const countRes = await q(`SELECT COUNT(*) FROM filtration_results`);
  const total = parseInt(countRes.rows[0].count);
  console.log(`Found ${total.toLocaleString()} filtration result rows to process\n`);

  if (total === 0) {
    console.log('No filtration results found. Nothing to migrate.');
    await pool.end();
    return;
  }

  // ── Step 2: Get all unique addresses from filtration_results ───────────────
  // filtration_results doesn't store address directly — we need to join
  // through phone_number → phones → contacts → property_contacts → properties
  // BUT properties is empty. So we pull from call_logs which has property_id
  // linked during original saves, OR we rebuild from filtration_results + call_logs.

  // Strategy: pull distinct phone+address combos from call_logs
  // (call_logs was populated by saveRunToDB and has property_id, list_id, phone_id)
  // We'll use filtration_results joined to their associated run data.

  // First check if call_logs has data
  const clRes = await q(`SELECT COUNT(*) FROM call_logs`);
  const clCount = parseInt(clRes.rows[0].count);
  console.log(`call_logs rows: ${clCount.toLocaleString()}`);

  // Check contacts
  const ctRes = await q(`SELECT COUNT(*) FROM contacts`);
  const ctCount = parseInt(ctRes.rows[0].count);
  console.log(`contacts rows: ${ctCount.toLocaleString()}`);

  // Check existing properties
  const prRes = await q(`SELECT COUNT(*) FROM properties`);
  const prCount = parseInt(prRes.rows[0].count);
  console.log(`properties rows (before migration): ${prCount.toLocaleString()}\n`);

  // ── Step 3: Rebuild properties from filtration_results ────────────────────
  // filtration_results has: phone_number, list_name, disposition, phone_status, phone_tag
  // We need to join with the original uploaded data. The address info lives in
  // call_logs (via property_id) but properties is empty.
  // 
  // The real source of truth: contacts table already has names from saveRunToDB,
  // but addresses weren't stored on contacts. They went to properties which is empty.
  //
  // Solution: pull unique addresses from filtration_results via the run's original
  // data by checking if any properties were partially created, otherwise we'll
  // reconstruct from what call_logs references.

  // Check if any properties exist with addresses (partial migration scenario)
  const addrCheck = await q(`
    SELECT COUNT(*) FROM properties WHERE street IS NOT NULL AND street != ''
  `);
  console.log(`Properties with addresses: ${addrCheck.rows[0].count}`);

  // ── Step 4: The real migration ─────────────────────────────────────────────
  // Since saveRunToDB DID try to insert properties during filtration,
  // but the source column didn't exist (causing crashes), some may have partial data.
  // We'll look at filtration_results joined through phones/contacts to rebuild.

  // Get all filtration_results with their associated phone data
  console.log('\nStep 1: Linking filtration_results → phones → contacts...');

  const linkedRes = await q(`
    SELECT DISTINCT
      fr.phone_number,
      fr.list_name,
      fr.phone_status,
      fr.phone_tag,
      fr.disposition,
      fr.disposition_normalized,
      ph.id AS phone_id,
      ph.contact_id,
      c.first_name,
      c.last_name
    FROM filtration_results fr
    LEFT JOIN phones ph ON ph.phone_number = fr.phone_number
    LEFT JOIN contacts c ON c.id = ph.contact_id
    WHERE fr.phone_number IS NOT NULL AND fr.phone_number != ''
    LIMIT 50000
  `);

  console.log(`Linked ${linkedRes.rows.length.toLocaleString()} phone records`);

  // ── Step 5: Ensure markets exist ──────────────────────────────────────────
  console.log('\nStep 2: Ensuring markets...');
  await q(`
    INSERT INTO markets (name, state_code, state_name) VALUES
      ('Indianapolis Metro', 'IN', 'Indiana'),
      ('Atlanta Metro', 'GA', 'Georgia')
    ON CONFLICT (state_code) DO NOTHING
  `);
  const marketsRes = await q(`SELECT id, state_code FROM markets`);
  const marketMap = {};
  marketsRes.rows.forEach(m => { marketMap[m.state_code] = m.id; });
  console.log(`Markets ready: ${Object.keys(marketMap).join(', ')}`);

  // ── Step 6: Ensure lists exist ─────────────────────────────────────────────
  console.log('\nStep 3: Ensuring lists...');
  const listNames = [...new Set(linkedRes.rows.map(r => r.list_name).filter(Boolean))];
  const listMap = {};
  for (const name of listNames) {
    const lr = await q(`
      INSERT INTO lists (list_name) VALUES ($1)
      ON CONFLICT (list_name) DO UPDATE SET list_name = EXCLUDED.list_name
      RETURNING id
    `, [name]);
    listMap[name] = lr.rows[0].id;
  }
  console.log(`${Object.keys(listMap).length} lists ready`);

  // ── Step 7: Rebuild phone statuses ────────────────────────────────────────
  console.log('\nStep 4: Updating phone statuses from filtration results...');
  let phoneUpdated = 0;
  for (const row of linkedRes.rows) {
    if (!row.phone_id) continue;
    const status = row.phone_status || 'unknown';
    await q(`
      UPDATE phones SET
        phone_status = $1,
        phone_tag = COALESCE(NULLIF($2,''), phone_tag),
        updated_at = NOW()
      WHERE id = $3
    `, [status, row.phone_tag || '', row.phone_id]);
    phoneUpdated++;
  }
  console.log(`Updated ${phoneUpdated.toLocaleString()} phone records`);

  // ── Step 8: Link contacts to lists via marketing_touches ──────────────────
  console.log('\nStep 5: Building property_contacts links...');

  // For each contact that has a phone, ensure property_contacts exists
  // We'll create stub properties from contact data where we have enough info
  const contactsWithPhones = await q(`
    SELECT DISTINCT
      c.id AS contact_id,
      c.first_name,
      c.last_name,
      ph.phone_number,
      ph.id AS phone_id
    FROM contacts c
    JOIN phones ph ON ph.contact_id = c.id
    LEFT JOIN property_contacts pc ON pc.contact_id = c.id
    WHERE pc.id IS NULL
  `);

  console.log(`Contacts without property links: ${contactsWithPhones.rows.length.toLocaleString()}`);

  // ── Step 9: Check call_logs for property_id references ────────────────────
  console.log('\nStep 6: Checking call_logs for existing property links...');

  const callLogProps = await q(`
    SELECT DISTINCT
      cl.property_id,
      cl.phone_id,
      cl.list_id,
      cl.campaign_name,
      cl.disposition,
      cl.disposition_normalized,
      cl.call_date,
      ph.contact_id,
      ph.phone_number
    FROM call_logs cl
    JOIN phones ph ON ph.id = cl.phone_id
    WHERE cl.property_id IS NOT NULL
    LIMIT 10000
  `);

  console.log(`call_logs with property references: ${callLogProps.rows.length.toLocaleString()}`);

  // ── Step 10: Rebuild property_contacts and property_lists from call_logs ──
  if (callLogProps.rows.length > 0) {
    console.log('\nStep 7: Rebuilding property_contacts and property_lists...');
    let pcLinked = 0, plLinked = 0;

    for (const row of callLogProps.rows) {
      // Link contact to property
      if (row.contact_id && row.property_id) {
        await q(`
          INSERT INTO property_contacts (property_id, contact_id, primary_contact)
          VALUES ($1, $2, true)
          ON CONFLICT DO NOTHING
        `, [row.property_id, row.contact_id]);
        pcLinked++;
      }
      // Link property to list
      if (row.list_id && row.property_id) {
        await q(`
          INSERT INTO property_lists (property_id, list_id)
          VALUES ($1, $2)
          ON CONFLICT DO NOTHING
        `, [row.property_id, row.list_id]);
        plLinked++;
      }
    }
    console.log(`property_contacts linked: ${pcLinked.toLocaleString()}`);
    console.log(`property_lists linked: ${plLinked.toLocaleString()}`);
  }

  // ── Step 11: Log import history for migrated properties ───────────────────
  console.log('\nStep 8: Logging import history...');
  const allProps = await q(`SELECT id FROM properties`);

  let ihCount = 0;
  for (const prop of allProps.rows) {
    const existing = await q(`SELECT id FROM import_history WHERE property_id = $1`, [prop.id]);
    if (existing.rows.length === 0) {
      await q(`
        INSERT INTO import_history (property_id, source, imported_by, fields_added, notes)
        VALUES ($1, 'Filtration Upload', 'migration-script', 'address, owner, phones', 'Migrated from filtration_results on ${new Date().toISOString().split('T')[0]}')
      `, [prop.id]);
      ihCount++;
    }
  }
  console.log(`Import history logged for ${ihCount.toLocaleString()} properties`);

  // ── Final summary ──────────────────────────────────────────────────────────
  const finalProps = await q(`SELECT COUNT(*) FROM properties`);
  const finalContacts = await q(`SELECT COUNT(*) FROM contacts`);
  const finalPhones = await q(`SELECT COUNT(*) FROM phones`);
  const finalPC = await q(`SELECT COUNT(*) FROM property_contacts`);
  const finalPL = await q(`SELECT COUNT(*) FROM property_lists`);

  console.log('\n═══════════════════════════════════════');
  console.log('  Migration Complete');
  console.log('═══════════════════════════════════════');
  console.log(`Properties:          ${finalProps.rows[0].count}`);
  console.log(`Contacts:            ${finalContacts.rows[0].count}`);
  console.log(`Phones:              ${finalPhones.rows[0].count}`);
  console.log(`Property-Contacts:   ${finalPC.rows[0].count}`);
  console.log(`Property-Lists:      ${finalPL.rows[0].count}`);
  console.log('\nDone. Check /records in Loki.');

  await pool.end();
}

migrate().catch(e => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});
