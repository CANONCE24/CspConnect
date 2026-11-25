'use strict';
async function migrate(pool = require('../src/config/db').pool) {
  const [columns] = await pool.query('SHOW COLUMNS FROM users');
  for (const [name, type] of [
    ['affiliation', "ENUM('Student','Faculty','Staff','Visitor') NULL"],
    ['affiliation_email', 'VARCHAR(254) NULL']
  ]) {
    if (!columns.some(column => column.Field === name)) await pool.query(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
  }
}
if (require.main === module) migrate().then(() => console.log('Affiliation fields are ready. Existing accounts, passwords and roles were preserved.'))
  .catch(error => { console.error('Affiliation migration failed:', error.code || error.message); process.exitCode = 1; })
  .finally(() => require('../src/config/db').pool.end());
module.exports = {migrate};
