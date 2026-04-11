// Records DB — normalized properties / owners / phones filing cabinet
const { query } = require(’../db’);

async function initRecordsSchema() {
await query(`
CREATE TABLE IF NOT EXISTS rec_properties (
id SERIAL PRIMARY KEY,
property_address VARCHAR(255) NOT NULL,
property_city VARCHAR(100),
property_state VARCHAR(10),
property_zip VARCHAR(20),
address_key VARCHAR(255) NOT NULL UNIQUE,
created_at TIMESTAMPTZ DEFAULT NOW(),
updated_at TIMESTAMPTZ DEFAULT NOW()
);

```
CREATE TABLE IF NOT EXISTS rec_owners (
  id SERIAL PRIMARY KEY,
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  mailing_address VARCHAR(255),
  mailing_city VARCHAR(100),
  mailing_state VARCHAR(10),
  mailing_zip VARCHAR(20),
  owner_key VARCHAR(255) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rec_property_owners (
  property_id INTEGER NOT NULL REFERENCES rec_properties(id) ON DELETE CASCADE,
  owner_id INTEGER NOT NULL REFERENCES rec_owners(id) ON DELETE CASCADE,
  PRIMARY KEY (property_id, owner_id)
);

CREATE TABLE IF NOT EXISTS rec_property_campaigns (
  property_id INTEGER NOT NULL REFERENCES rec_properties(id) ON DELETE CASCADE,
  campaign_id INTEGER NOT NULL,
  PRIMARY KEY (property_id, campaign_id)
);

CREATE INDEX IF NOT EXISTS idx_rec_prop_addr ON rec_properties(address_key);
CREATE INDEX IF NOT EXISTS idx_rec_owner_key ON rec_owners(owner_key);
CREATE INDEX IF NOT EXISTS idx_rec_prop_state ON rec_properties(property_state);
```

`);
}

// Normalize a string for dedup keys — lowercase, collapse spaces, strip punctuation
function normalizeKey(s) {
return String(s || ‘’).toLowerCase().replace(/[^\w\s]/g, ‘’).replace(/\s+/g, ’ ’).trim();
}

// Sync all campaign_contacts into the normalized records tables
async function syncRecordsFromContacts() {
await initRecordsSchema();
const contacts = await query(`SELECT id, campaign_id, first_name, last_name, mailing_address, mailing_city, mailing_state, mailing_zip, property_address, property_city, property_state, property_zip FROM campaign_contacts WHERE property_address IS NOT NULL AND property_address <> ''`);

let newProperties = 0, newOwners = 0, links = 0;

for (const c of contacts.rows) {
const addrKey = normalizeKey(`${c.property_address} ${c.property_city||''} ${c.property_state||''} ${c.property_zip||''}`);
if (!addrKey) continue;

```
// Upsert property
const propRes = await query(
  `INSERT INTO rec_properties (property_address, property_city, property_state, property_zip, address_key)
   VALUES ($1,$2,$3,$4,$5)
   ON CONFLICT (address_key) DO UPDATE SET updated_at = NOW()
   RETURNING id, (xmax = 0) AS inserted`,
  [c.property_address, c.property_city, c.property_state, c.property_zip, addrKey]
);
const propertyId = propRes.rows[0].id;
if (propRes.rows[0].inserted) newProperties++;

// Upsert owner (only if we have a name)
if (c.first_name || c.last_name) {
  const ownerKey = normalizeKey(`${c.first_name||''} ${c.last_name||''} ${c.mailing_address||''} ${c.mailing_zip||''}`);
  if (ownerKey) {
    const ownerRes = await query(
      `INSERT INTO rec_owners (first_name, last_name, mailing_address, mailing_city, mailing_state, mailing_zip, owner_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (owner_key) DO UPDATE SET updated_at = NOW()
       RETURNING id, (xmax = 0) AS inserted`,
      [c.first_name, c.last_name, c.mailing_address, c.mailing_city, c.mailing_state, c.mailing_zip, ownerKey]
    );
    const ownerId = ownerRes.rows[0].id;
    if (ownerRes.rows[0].inserted) newOwners++;

    // Link
    await query(
      `INSERT INTO rec_property_owners (property_id, owner_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [propertyId, ownerId]
    );
  }
}

// Link to campaign
await query(
  `INSERT INTO rec_property_campaigns (property_id, campaign_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
  [propertyId, c.campaign_id]
);
links++;
```

}

return { processed: contacts.rows.length, newProperties, newOwners, links };
}

// Query properties with search + pagination
async function getProperties({ search = ‘’, page = 1, pageSize = 50 }) {
await initRecordsSchema();
const offset = (page - 1) * pageSize;
const searchPattern = `%${search.toLowerCase()}%`;

const whereClause = search ? `WHERE LOWER(p.property_address) LIKE $1 OR LOWER(p.property_city) LIKE $1` : ‘’;
const params = search ? [searchPattern, pageSize, offset] : [pageSize, offset];
const limitParams = search ? ‘$2 OFFSET $3’ : ‘$1 OFFSET $2’;

const totalRes = await query(
`SELECT COUNT(*) as c FROM rec_properties p ${whereClause}`,
search ? [searchPattern] : []
);
const total = parseInt(totalRes.rows[0]?.c || 0);

const rows = await query(
`SELECT p.id, p.property_address, p.property_city, p.property_state, p.property_zip, COALESCE( (SELECT STRING_AGG(DISTINCT TRIM(COALESCE(o.first_name,'') || ' ' || COALESCE(o.last_name,'')), ', ') FROM rec_property_owners po JOIN rec_owners o ON o.id = po.owner_id WHERE po.property_id = p.id), '—' ) as owners, (SELECT COUNT(DISTINCT ccp.phone_number) FROM campaign_contacts cc JOIN campaign_contact_phones ccp ON ccp.contact_id = cc.id WHERE LOWER(cc.property_address) = LOWER(p.property_address) AND LOWER(COALESCE(cc.property_zip,'')) = LOWER(COALESCE(p.property_zip,'')) ) as phone_count, (SELECT COUNT(*) FROM rec_property_campaigns pc WHERE pc.property_id = p.id) as list_count FROM rec_properties p ${whereClause} ORDER BY p.id DESC LIMIT ${limitParams}`,
params
);

return { rows: rows.rows, total, page, pageSize };
}

async function getRecordsStats() {
await initRecordsSchema();
const props = await query(`SELECT COUNT(*) as c FROM rec_properties`);
const owners = await query(`SELECT COUNT(*) as c FROM rec_owners`);
return {
total_properties: parseInt(props.rows[0]?.c || 0),
total_owners: parseInt(owners.rows[0]?.c || 0),
};
}

module.exports = { initRecordsSchema, syncRecordsFromContacts, getProperties, getRecordsStats };
