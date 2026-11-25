'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
async function migrate(pool = require('../src/config/db').pool) {
  const sql = await fs.readFile(path.join(__dirname,'support-schema.sql'),'utf8');
  for (const statement of sql.split(';').map(value=>value.trim()).filter(Boolean)) await pool.query(statement);
  const [columns] = await pool.query('SHOW COLUMNS FROM feedback_notifications');
  if (columns.find(column=>column.Field==='feedback_id')?.Null === 'NO') await pool.query('ALTER TABLE feedback_notifications MODIFY feedback_id INT UNSIGNED NULL');
  if (!columns.some(column=>column.Field==='support_ticket_id')) await pool.query('ALTER TABLE feedback_notifications ADD COLUMN support_ticket_id INT UNSIGNED NULL');
  const kind = columns.find(column=>column.Field==='kind');
  if (!kind?.Type.includes("'SupportNew'")) await pool.query("ALTER TABLE feedback_notifications MODIFY kind ENUM('StatusUpdated','AdminResponse','Published','Unpublished','SupportNew','SupportReply','SupportStatus') NOT NULL");
  const [keys] = await pool.execute("SELECT CONSTRAINT_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='feedback_notifications' AND CONSTRAINT_NAME='notification_support_fk'");
  if (!keys.length) await pool.query('ALTER TABLE feedback_notifications ADD CONSTRAINT notification_support_fk FOREIGN KEY (support_ticket_id) REFERENCES support_tickets(id) ON DELETE CASCADE');
}
if (require.main === module) migrate().then(()=>console.log('Private support tickets and notifications are ready. Existing accounts, feedback and notifications were preserved.'))
  .catch(error=>{console.error('Support migration failed:',error.code||error.message);process.exitCode=1;})
  .finally(()=>require('../src/config/db').pool.end());
module.exports = {migrate};
