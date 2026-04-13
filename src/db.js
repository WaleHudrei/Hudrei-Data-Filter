const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

async function query(text, params) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

async function initSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS markets (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      state_code CHAR(2) NOT NULL,
      state_name VARCHAR(100) NOT NULL,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(state_code)
    );

    CREATE TABLE IF NOT EXISTS properties (
      id SERIAL PRIMARY KEY,
      street VARCHAR(255) NOT NULL,
      city VARCHAR(100) NOT NULL,
      state_code CHAR(2) NOT NULL,
      zip_code VARCHAR(10) NOT NULL,
      county VARCHAR(100),
      market_id INTEGER REFERENCES markets(id),
      property_type VARCHAR(50),
      vacant BOOLEAN,
      pipeline_stage VARCHAR(50) DEFAULT 'prospect',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(street, city, state_code, zip_code)
    );

    CREATE TABLE IF NOT EXISTS contacts (
      id SERIAL PRIMARY KEY,
      first_name VARCHAR(100),
      last_name VARCHAR(100),
      email VARCHAR(255),
      mailing_address VARCHAR(255),
      mailing_city VARCHAR(100),
      mailing_state CHAR(2),
      mailing_zip VARCHAR(10),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS property_contacts (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      role VARCHAR(50) DEFAULT 'owner',
      primary_contact BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(property_id, contact_id)
    );

    CREATE TABLE IF NOT EXISTS phones (
      id SERIAL PRIMARY KEY,
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      phone_number VARCHAR(20) NOT NULL,
      phone_index SMALLINT DEFAULT 1,
      phone_status VARCHAR(50) DEFAULT 'unknown',
      phone_tag TEXT,
      do_not_call BOOLEAN DEFAULT false,
      wrong_number BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(contact_id, phone_number)
    );

    CREATE TABLE IF NOT EXISTS lists (
      id SERIAL PRIMARY KEY,
      list_name VARCHAR(255) NOT NULL,
      dialer_campaign_name VARCHAR(255),
      list_type VARCHAR(100),
      market_id INTEGER REFERENCES markets(id),
      source VARCHAR(100),
      upload_date DATE,
      total_records INTEGER,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(list_name)
    );

    CREATE TABLE IF NOT EXISTS property_lists (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
      list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      added_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(property_id, list_id)
    );

    CREATE TABLE IF NOT EXISTS call_logs (
      id SERIAL PRIMARY KEY,
      phone_id INTEGER NOT NULL REFERENCES phones(id) ON DELETE CASCADE,
      list_id INTEGER REFERENCES lists(id),
      property_id INTEGER REFERENCES properties(id),
      disposition VARCHAR(100) NOT NULL,
      disposition_normalized VARCHAR(50),
      agent_name VARCHAR(100),
      call_date DATE,
      call_notes TEXT,
      campaign_name VARCHAR(255),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sms_logs (
      id SERIAL PRIMARY KEY,
      phone_id INTEGER REFERENCES phones(id),
      contact_id INTEGER REFERENCES contacts(id),
      property_id INTEGER REFERENCES properties(id),
      campaign_name VARCHAR(255),
      direction VARCHAR(10) DEFAULT 'outbound',
      message_text TEXT,
      disposition VARCHAR(100),
      sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS filtration_runs (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255),
      run_at TIMESTAMPTZ DEFAULT NOW(),
      total_records INTEGER,
      lists_detected INTEGER,
      records_kept INTEGER,
      records_filtered INTEGER,
      caught_by_memory INTEGER,
      run_by VARCHAR(100)
    );

    CREATE TABLE IF NOT EXISTS filtration_results (
      id SERIAL PRIMARY KEY,
      run_id INTEGER NOT NULL REFERENCES filtration_runs(id) ON DELETE CASCADE,
      phone_number VARCHAR(20),
      list_name VARCHAR(255),
      property_id INTEGER REFERENCES properties(id),
      phone_id INTEGER REFERENCES phones(id),
      disposition VARCHAR(100),
      disposition_normalized VARCHAR(50),
      cumulative_count INTEGER,
      action VARCHAR(20),
      phone_status VARCHAR(50),
      phone_tag TEXT,
      marketing_result TEXT,
      caught_by_memory BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS deals (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES properties(id),
      stage VARCHAR(50) DEFAULT 'lead',
      lead_source VARCHAR(100),
      lead_date DATE,
      appointment_date DATE,
      offer_amount NUMERIC(12,2),
      offer_date DATE,
      contract_date DATE,
      closing_date DATE,
      assignment_fee NUMERIC(12,2),
      end_buyer VARCHAR(255),
      notes TEXT,
      assigned_am VARCHAR(100),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS marketing_touches (
      id SERIAL PRIMARY KEY,
      property_id INTEGER REFERENCES properties(id),
      contact_id INTEGER REFERENCES contacts(id),
      channel VARCHAR(50) NOT NULL,
      campaign_name VARCHAR(255),
      list_id INTEGER REFERENCES lists(id),
      touch_date DATE,
      outcome VARCHAR(100),
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS import_history (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
      source VARCHAR(100),
      imported_at TIMESTAMPTZ DEFAULT NOW(),
      imported_by VARCHAR(100),
      fields_added TEXT,
      fields_updated TEXT,
      notes TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_phones_number ON phones(phone_number);
    CREATE INDEX IF NOT EXISTS idx_phones_contact ON phones(contact_id);
    CREATE INDEX IF NOT EXISTS idx_call_logs_phone ON call_logs(phone_id);
    CREATE INDEX IF NOT EXISTS idx_call_logs_date ON call_logs(call_date);
    CREATE INDEX IF NOT EXISTS idx_call_logs_list ON call_logs(list_id);
    CREATE INDEX IF NOT EXISTS idx_properties_address ON properties(street, city, state_code, zip_code);
    CREATE INDEX IF NOT EXISTS idx_properties_state ON properties(state_code);
    CREATE INDEX IF NOT EXISTS idx_filtration_results_run ON filtration_results(run_id);
    CREATE INDEX IF NOT EXISTS idx_filtration_results_phone ON filtration_results(phone_number);
    CREATE INDEX IF NOT EXISTS idx_deals_property ON deals(property_id);
    CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals(stage);
    CREATE INDEX IF NOT EXISTS idx_marketing_touches_property ON marketing_touches(property_id);
    CREATE INDEX IF NOT EXISTS idx_marketing_touches_channel ON marketing_touches(channel);
    CREATE INDEX IF NOT EXISTS idx_import_history_property ON import_history(property_id);
  `);

  // ── Migration: add new columns if they don't exist yet ──────────────────────
  const migrations = [

    // properties — filter fields
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS assessed_value NUMERIC(12,2)`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS property_status VARCHAR(50)`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS equity_percent NUMERIC(5,2)`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS marketing_result VARCHAR(100)`,
    // properties — detail fields
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS source VARCHAR(100)`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS bedrooms SMALLINT`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS bathrooms NUMERIC(3,1)`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS sqft INTEGER`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS year_built SMALLINT`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS lot_size INTEGER`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS condition VARCHAR(50)`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS estimated_value NUMERIC(12,2)`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS last_sale_date DATE`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS last_sale_price NUMERIC(12,2)`,
    `ALTER TABLE properties ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ DEFAULT NOW()`,

    // contacts — mailing address fields
    `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS mailing_address VARCHAR(255)`,
    `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_1 VARCHAR(255)`,
    `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_2 VARCHAR(255)`,
    `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS mailing_city VARCHAR(100)`,
    `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS mailing_state CHAR(2)`,
    `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS mailing_zip VARCHAR(10)`,

    // lists — source field
    `ALTER TABLE lists ADD COLUMN IF NOT EXISTS source VARCHAR(100)`,
  ];

  for (const sql of migrations) {
    try {
      await query(sql);
    } catch (e) {
      // Column may already exist on older Railway instances — safe to ignore
      if (!e.message.includes('already exists')) {
        console.error('Migration warning:', e.message);
      }
    }
  }

  // Seed base markets
  await query(`
    INSERT INTO markets (name, state_code, state_name) VALUES
      ('Indianapolis Metro', 'IN', 'Indiana'),
      ('Atlanta Metro', 'GA', 'Georgia')
    ON CONFLICT (state_code) DO NOTHING;
  `);

  console.log('Database schema initialized + migrations applied');
}

module.exports = { query, initSchema, pool };
