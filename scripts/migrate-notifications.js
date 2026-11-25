'use strict';
require('dotenv').config({ quiet: true });
const fs = require('node:fs/promises');
const path = require('node:path');
async function migrate(pool = require('../src/config/db').pool) {
  const sql = await fs.readFile(path.join(__dirname, 'notifications-schema.sql'), 'utf8');
  await pool.query(sql);
}
if (require.main === module) migrate().then(() => console.log('In-app notifications are ready. Existing records were retained.'))
  .catch(error => { console.error('Notification migration failed:', error.code || error.message); process.exitCode = 1; })
  .finally(() => require('../src/config/db').pool.end());
module.exports = { migrate };
