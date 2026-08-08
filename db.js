// Ashborn Studios — database pool + boot migration + first-run seed
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('FATAL: DATABASE_URL is not set. On Railway, link the PostgreSQL service to this service.');
  process.exit(1);
}

// Railway's internal network (postgres.railway.internal) does not use TLS.
// External connections (e.g. local dev via the public proxy) do.
const useSSL = !/railway\.internal/.test(DATABASE_URL) && !/localhost|127\.0\.0\.1/.test(DATABASE_URL);

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
  max: 10,
});

pool.on('error', (e) => console.error('pg pool error:', e.message));

async function q(text, params = []) {
  const res = await pool.query(text, params);
  return res.rows;
}
async function one(text, params = []) {
  const rows = await q(text, params);
  return rows[0] || null;
}

// ── Boot migration: run schema.sql (fully idempotent) ─────────
async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('✓ schema up to date');
}

// ── First-run seed: admin user + master workspace ─────────────
// Password comes from ADMIN_PASSWORD env var if set, else the known default.
// Change it after first login (POST /auth/change-password).
async function seed() {
  const admin = await one("SELECT id FROM users WHERE id='admin001'");
  if (!admin) {
    const pass = process.env.ADMIN_PASSWORD || 'ashborn2025';
    const hash = await bcrypt.hash(pass, 10);
    await q(
      "INSERT INTO users (id, username, password_hash, role, daily_ai_limit) VALUES ('admin001','thifrus',$1,'admin',50) ON CONFLICT (id) DO NOTHING",
      [hash]
    );
    console.log('✓ seeded admin user "thifrus"' + (process.env.ADMIN_PASSWORD ? ' (password from ADMIN_PASSWORD)' : ' (default password — change it after first login)'));
  }
  const master = await one("SELECT id FROM workspaces WHERE is_master=1");
  if (!master) {
    await q(
      "INSERT INTO workspaces (id, name, description, icon, owner_id, is_master) VALUES ('master001','Master Database','All analyzed videos','🗄️','admin001',1) ON CONFLICT (id) DO NOTHING"
    );
    await q(
      "INSERT INTO workspace_members (workspace_id, user_id, permission) VALUES ('master001','admin001','delete') ON CONFLICT (workspace_id, user_id) DO NOTHING"
    );
    console.log('✓ seeded master workspace');
  }
}

module.exports = { pool, q, one, migrate, seed };
