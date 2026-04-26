-- ─────────────────────────────────────────────────────────────────────────────
-- 01-create-tenants-and-users.sql
--
-- Creates the two tables that define multi-tenancy: `tenants` and `users`.
-- Seeds HudREI as tenant id=1 and Wale as user id=1 so the existing app keeps
-- working post-migration.
--
-- Idempotent — safe to re-run. Wraps all DDL + seed in a single transaction
-- so a partial failure rolls back cleanly.
--
-- Run order: this file runs FIRST. File 02 depends on `tenants(id)` existing
-- as a FK target.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── tenants ──────────────────────────────────────────────────────────────────
-- One row per customer (HudREI, plus any SaaS customers added later).
-- `slug` is the URL-safe identifier used for subdomain or path-based routing.

CREATE TABLE IF NOT EXISTS tenants (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  slug            TEXT UNIQUE NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tenants_slug_format CHECK (
    slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'
  ),
  CONSTRAINT tenants_status_valid CHECK (
    status IN ('active', 'suspended', 'canceled')
  )
);

CREATE INDEX IF NOT EXISTS tenants_status_idx ON tenants(status);

-- ── users ────────────────────────────────────────────────────────────────────
-- One row per human who can log in. Each user belongs to exactly one tenant.
-- `password_hash` is NULLable for now (Phase 1 still uses the single-password
-- gate); Phase 2 populates it via bcrypt at signup.

CREATE TABLE IF NOT EXISTS users (
  id              SERIAL PRIMARY KEY,
  tenant_id       INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email           TEXT NOT NULL,
  password_hash   TEXT,
  name            TEXT,
  role            TEXT NOT NULL DEFAULT 'admin',
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at   TIMESTAMPTZ,
  CONSTRAINT users_email_per_tenant UNIQUE (tenant_id, email),
  CONSTRAINT users_role_valid CHECK (
    role IN ('admin', 'operator', 'viewer')
  ),
  CONSTRAINT users_status_valid CHECK (
    status IN ('active', 'invited', 'disabled')
  )
);

CREATE INDEX IF NOT EXISTS users_tenant_id_idx ON users(tenant_id);
CREATE INDEX IF NOT EXISTS users_email_idx ON users(LOWER(email));

-- ── Seed: HudREI as tenant id=1, Wale as user id=1 ───────────────────────────
-- Forced ids ensure file 02 can backfill every existing row with tenant_id=1
-- without ambiguity. Conflict-do-nothing makes this safely re-runnable.

INSERT INTO tenants (id, name, slug, status)
  VALUES (1, 'HudREI', 'hudrei', 'active')
  ON CONFLICT (id) DO NOTHING;

-- After a forced INSERT with an explicit id, the SERIAL sequence is still at
-- its initial value. Bump it past MAX(id) so the next auto-generated id
-- doesn't collide with the seed.
SELECT setval(
  'tenants_id_seq',
  GREATEST(1, (SELECT COALESCE(MAX(id), 1) FROM tenants)),
  true
);

INSERT INTO users (id, tenant_id, email, name, role, status)
  VALUES (1, 1, 'wale@hudrei.com', 'Wale Oladapo', 'admin', 'active')
  ON CONFLICT (id) DO NOTHING;

SELECT setval(
  'users_id_seq',
  GREATEST(1, (SELECT COALESCE(MAX(id), 1) FROM users)),
  true
);

-- ── Verification ─────────────────────────────────────────────────────────────
-- These SELECTs are echoed back to whoever is running the migration so they
-- can eyeball that the seed worked.

SELECT id, name, slug, status FROM tenants ORDER BY id;
SELECT id, tenant_id, email, name, role, status FROM users ORDER BY id;

COMMIT;
