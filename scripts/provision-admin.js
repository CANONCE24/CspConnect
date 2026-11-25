'use strict';

require('dotenv').config({ quiet: true });
const { createHash } = require('../src/services/passwords');
const { pool } = require('../src/config/db');

async function provision() {
  const email = (process.env.ADMIN_BOOTSTRAP_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  const allowlist = (process.env.ADMIN_EMAILS || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !allowlist.includes(email)) {
    throw new Error('Set ADMIN_BOOTSTRAP_EMAIL to an address already present in ADMIN_EMAILS.');
  }
  if (typeof password !== 'string' || [...password].length < 12 || Buffer.byteLength(password, 'utf8') > 128) {
    throw new Error('The initial admin password must contain 12 to 128 UTF-8 bytes.');
  }
  if (process.env.NODE_ENV === 'production' || !['127.0.0.1', 'localhost', '::1'].includes(process.env.DB_HOST || '127.0.0.1')) {
    throw new Error('Local administrator provisioning is restricted to a local development database.');
  }
  const encoded = await createHash(password);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [existing] = await connection.execute('SELECT id, password_hash FROM users WHERE email = ? FOR UPDATE', [email]);
    let action;
    if (existing.length) {
      if (existing[0].password_hash) throw new Error('This account already has a password. The existing credential was not changed.');
      await connection.execute(`UPDATE users SET password_hash = ?, role = 'admin', must_change_password = 1,legacy_active=1,session_version=session_version+1 WHERE id = ?`, [encoded, existing[0].id]);
      action = 'linked';
    } else {
      await connection.execute(`INSERT INTO users (google_id, name, email, password_hash, role, must_change_password,legacy_active)
        VALUES (NULL, 'CSPC Administrator', ?, ?, 'admin', 1,1)`, [email, encoded]);
      action = 'created';
    }
    await connection.commit();
    console.log(`Administrator account ${action}; initial password is hashed and must be changed at first sign-in.`);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

if (require.main === module) provision()
  .catch(error => { console.error(`Admin provisioning failed: ${error.code || error.message}`); process.exitCode = 1; })
  .finally(() => pool.end());

module.exports = { provision };
