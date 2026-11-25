'use strict';
require('dotenv').config({ quiet: true });
const fs = require('node:fs/promises');
const path = require('node:path');
async function migrate(pool = require('../src/config/db').pool) {
  const [rows] = await pool.query("SHOW COLUMNS FROM users LIKE 'role'");
  if (!rows.length || !/^enum\(/i.test(rows[0].Type)) throw new Error('Expected users.role enum; review the schema before migrating.');
  if (!rows[0].Type.includes("'security'")) {
    if (rows[0].Type !== "enum('student','admin')") throw new Error('Unexpected account roles; migration stopped.');
    await pool.query("ALTER TABLE users MODIFY role ENUM('student','admin','security') NOT NULL DEFAULT 'student'");
  }
  const sql = await fs.readFile(path.join(__dirname, 'emergency-schema.sql'), 'utf8');
  for (const statement of sql.split(';').map(value => value.trim()).filter(Boolean)) await pool.query(statement);
}
if (require.main === module) migrate().then(() => console.log('Emergency prototype tables are ready; existing feedback is retained.'))
  .catch(error => { console.error('Emergency migration failed:', error.code || error.message); process.exitCode = 1; })
  .finally(() => require('../src/config/db').pool.end());
module.exports = { migrate };
