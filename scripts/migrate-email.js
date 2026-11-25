'use strict';
require('dotenv').config({ quiet: true });
const fs = require('node:fs/promises');
const path = require('node:path');
const STATUS_ENUM = "ENUM('Submitted','Under Review','In Progress','Resolved','Closed')";
async function migrate(pool = require('../src/config/db').pool) {
  for (const [table, column, suffix] of [['feedback','status',"NOT NULL DEFAULT 'Submitted'"],['feedback_status_history','previous_status','NULL'],['feedback_status_history','status','NOT NULL']]) {
    const [rows] = await pool.query(`SHOW COLUMNS FROM ${table} LIKE ?`, [column]);
    if (!rows.length || !/^enum\(/i.test(rows[0].Type)) throw new Error(`Unexpected ${table}.${column}; review the schema.`);
    const allowed = ['Submitted','Acknowledged','Under Review','In Progress','Resolved','Rejected','Closed'];
    if ([...rows[0].Type.matchAll(/'([^']+)'/g)].some(match => !allowed.includes(match[1]))) throw new Error('Unexpected feedback status; migration stopped.');
    // Canonicalize legacy labels before narrowing the enum; keep records and explanations.
    if (rows[0].Type.includes("'Acknowledged'")) await pool.query(`UPDATE ${table} SET ${column}='Under Review' WHERE ${column}='Acknowledged'`);
    if (rows[0].Type.includes("'Rejected'")) await pool.query(`UPDATE ${table} SET ${column}='Closed' WHERE ${column}='Rejected'`);
    if (rows[0].Type.toLowerCase() !== STATUS_ENUM.toLowerCase()) await pool.query(`ALTER TABLE ${table} MODIFY ${column} ${STATUS_ENUM} ${suffix}`);
  }
  const [history] = await pool.query('SHOW COLUMNS FROM feedback_status_history');
  const names = new Set(history.map(row => row.Field));
  for (const [name, type] of [['resolution_summary','TEXT NULL'],['additional_message','TEXT NULL'],['rejection_reason','TEXT NULL'],['request_key','CHAR(36) NULL']]) {
    if (!names.has(name)) await pool.query(`ALTER TABLE feedback_status_history ADD COLUMN ${name} ${type}`);
  }
  const [indexes] = await pool.query("SHOW INDEX FROM feedback_status_history WHERE Key_name='feedback_status_request'");
  if (!indexes.length) await pool.query('ALTER TABLE feedback_status_history ADD UNIQUE KEY feedback_status_request (feedback_id,request_key)');
  const [feedback] = await pool.query("SHOW COLUMNS FROM feedback LIKE 'resolved_at'");
  if (!feedback.length) await pool.query('ALTER TABLE feedback ADD COLUMN resolved_at DATETIME(3) NULL');
  const sql = await fs.readFile(path.join(__dirname, 'email-schema.sql'), 'utf8');
  for (const statement of sql.split(';').map(value => value.trim()).filter(Boolean)) await pool.query(statement);
  const [[kind]] = await pool.query("SHOW COLUMNS FROM feedback_email_outbox LIKE 'kind'");
  if (!kind.Type.includes("'StatusUpdated'")) await pool.query("ALTER TABLE feedback_email_outbox MODIFY kind ENUM('Acknowledged','Resolved','Rejected','StatusUpdated') NOT NULL");
}
if (require.main === module) migrate().then(() => console.log('Feedback email statuses, explanations, and outbox are ready. Existing records were retained.'))
  .catch(error => { console.error('Email migration failed:', error.code || error.message); process.exitCode = 1; }).finally(() => require('../src/config/db').pool.end());
module.exports = { migrate };
