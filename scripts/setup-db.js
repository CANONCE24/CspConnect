'use strict';

require('dotenv').config({ quiet: true });
const fs = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');

async function setup() {
  const name = process.env.DB_NAME || 'cspc_feedback_db';
  if (!/^cspc_[a-z0-9_]{1,58}$/.test(name)) {
    throw new Error('DB_NAME must be a new database name beginning with cspc_ and contain only lowercase letters, digits, and underscores.');
  }
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    charset: 'utf8mb4',
    multipleStatements: false
  });
  try {
    const [existing] = await connection.execute(
      'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [name]
    );
    if (existing.length) {
      throw new Error(`Database ${name} already exists. Setup refuses to inspect, modify, or reuse it. Choose a different new cspc_ DB_NAME in .env.`);
    }
    const root = path.resolve(__dirname, '..');
    const schema = await fs.readFile(path.join(root, 'schema.sql'), 'utf8');
    const seed = await fs.readFile(path.join(root, 'seed.sql'), 'utf8');
    // Both files are this project's trusted static SQL. Query one statement at a time.
    const statements = `${schema}\n${seed}`.replace(/^\s*--.*$/gm, '').split(';').map(item => item.trim()).filter(Boolean);
    if (statements.some(statement => /\b(?:DROP|TRUNCATE|ALTER|USE)\b/i.test(statement))) {
      throw new Error('Setup accepts only this fresh schema and category seed; destructive or migration statements are forbidden.');
    }
    await connection.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await connection.changeUser({ database: name });
    await connection.query("SET time_zone = '+00:00'");
    for (const statement of statements) await connection.query(statement);
    await connection.query("INSERT INTO login_migrations(name) VALUES ('email-otp-v1')");
    console.log(`Created new database ${name}. Schema and six configuration categories are ready.`);
  } finally {
    await connection.end();
  }
}

if (require.main === module) {
  setup().catch(error => {
    console.error(`Database setup failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { setup };
