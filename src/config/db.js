'use strict';
require('dotenv').config({ quiet: true });
const mysql = require('mysql2/promise');
const poolConfig = {
  host: process.env.DATABASE_HOST || process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DATABASE_PORT || process.env.DB_PORT || 3306),
  user: process.env.DATABASE_USER || process.env.DB_USER || 'root',
  password: process.env.DATABASE_PASSWORD || process.env.DB_PASSWORD || '',
  database: process.env.DATABASE_NAME || process.env.DB_NAME || 'cspc_feedback_db',
  waitForConnections: true,
  connectionLimit: 10, queueLimit: 50, charset: 'utf8mb4', timezone: 'Z',
  multipleStatements: false, supportBigNumbers: true, bigNumberStrings: false
};
if (process.env.NODE_ENV === 'production') {
  poolConfig.ssl = { rejectUnauthorized: false };
}
const pool = mysql.createPool(poolConfig);
// Driver parsing and database-generated timestamps both use UTC.
pool.pool.on('connection', connection => {
  connection.query("SET time_zone = '+00:00'", error => {
    if (error) connection.destroy();
  });
});
module.exports = { pool };
