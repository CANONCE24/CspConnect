'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

// Filess.io provisions the database itself. Only initialize an explicitly named,
// completely empty database; never create, clear, or migrate an existing one here.
async function setup(pool, expectedDatabase) {
  if (!expectedDatabase) throw new Error('Pass --database=EXACT_NEW_DATABASE_NAME to identify the new database.');
  const root = path.resolve(__dirname, '..');
  const sql = (await fs.readFile(path.join(root, 'schema.sql'), 'utf8')) + '\n' +
    (await fs.readFile(path.join(root, 'seed.sql'), 'utf8'));
  const statements = sql.replace(/^\s*--.*$/gm, '').split(';').map(item => item.trim()).filter(Boolean);
  if (statements.some(statement => !/^(?:CREATE TABLE\b|INSERT INTO categories\b)/i.test(statement))) {
    throw new Error('The fresh setup accepts only table definitions and the category seed.');
  }
  const connection = await pool.getConnection();
  try {
    const [[selected]] = await connection.query('SELECT DATABASE() AS name');
    if (selected.name !== expectedDatabase) throw new Error('The connected database does not match --database. Nothing was imported.');
    const [tables] = await connection.query('SHOW FULL TABLES');
    if (tables.length) throw new Error('The database is not empty. Setup refuses to change it, including a partially initialized database.');
    for (const statement of statements) await connection.query(statement);
    await connection.query("INSERT INTO login_migrations(name) VALUES ('email-otp-v1')");
    return { database: selected.name, statements: statements.length + 1 };
  } finally {
    connection.release();
  }
}

if (require.main === module) {
  const expectedDatabase = process.argv.find(value => value.startsWith('--database='))?.slice('--database='.length);
  if (!expectedDatabase) {
    console.error('Usage: npm run db:setup-hosted -- --database=EXACT_NEW_DATABASE_NAME');
    process.exitCode = 1;
  } else {
    const { pool } = require('../src/config/db');
    setup(pool, expectedDatabase)
      .then(() => console.log('Initialized the new empty database with the application schema and six categories. No user accounts or demo records were added.'))
      .catch(error => {
        console.error('Hosted database setup failed:', error.code || error.message);
        console.error('Do not clear or overwrite tables to retry. Inspect the new database before continuing.');
        process.exitCode = 1;
      })
      .finally(() => pool.end());
  }
}

module.exports = { setup };
