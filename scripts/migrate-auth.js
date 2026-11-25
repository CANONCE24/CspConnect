'use strict';

require('dotenv').config({ quiet: true });
const mysql = require('mysql2/promise');

async function migrate() {
  const database = process.env.DB_NAME || 'cspc_feedback_db';
  const host = process.env.DB_HOST || '127.0.0.1';
  if (!/^cspc_[a-z0-9_]{1,58}$/.test(database) || process.env.NODE_ENV === 'production' ||
      !['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error('Auth migration is restricted to a configured local CSPC development database.');
  }
  const connection = await mysql.createConnection({
    host, port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '', database, charset: 'utf8mb4', multipleStatements: false
  });
  try {
    const [columns] = await connection.execute(
      'SELECT COLUMN_NAME, IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME IN (?, ?, ?)',
      [database, 'users', 'google_id', 'password_hash', 'must_change_password']
    );
    const byName = new Map(columns.map(column => [column.COLUMN_NAME, column]));
    if (!byName.has('google_id')) throw new Error('The users.google_id column is missing; no changes were made.');
    if (byName.get('google_id').IS_NULLABLE !== 'YES') await connection.query('ALTER TABLE users MODIFY google_id VARCHAR(191) NULL');
    if (!byName.has('password_hash')) await connection.query('ALTER TABLE users ADD COLUMN password_hash VARCHAR(255) NULL AFTER email');
    if (!byName.has('must_change_password')) await connection.query('ALTER TABLE users ADD COLUMN must_change_password TINYINT(1) NOT NULL DEFAULT 0 AFTER password_hash');
    console.log('Email/password authentication columns are ready.');
  } finally {
    await connection.end();
  }
}

if (require.main === module) migrate().catch(error => {
  console.error(`Auth migration failed: ${error.code || error.message}`);
  process.exitCode = 1;
});

module.exports = { migrate };
