'use strict';
require('dotenv').config({ quiet: true });
const fs = require('node:fs/promises');
const path = require('node:path');
async function migrate(pool = require('../src/config/db').pool) {
  const sql = await fs.readFile(path.join(__dirname, 'comment-moderation-schema.sql'), 'utf8');
  for (const statement of sql.split(';').map(value => value.trim()).filter(Boolean)) await pool.query(statement);
}
if (require.main === module) migrate().then(() => console.log('Comment review, reports, and history are ready. Existing comments and visibility were retained.'))
  .catch(error => { console.error('Comment moderation migration failed:', error.code || error.message); process.exitCode = 1; })
  .finally(() => require('../src/config/db').pool.end());
module.exports = { migrate };
