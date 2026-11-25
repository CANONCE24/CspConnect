'use strict';
const { randomUUID } = require('node:crypto');
const { httpError } = require('../utils/validation');
const { validEmail } = require('../services/feedback-status');
const MAX_ATTEMPTS = 5;
function createEmailOutbox(pool) {
  async function transaction(action) {
    const db = await pool.getConnection();
    try { await db.beginTransaction(); const result = await action(db); await db.commit(); return result; }
    catch (error) { await db.rollback(); throw error; } finally { db.release(); }
  }
  async function admin(db, user) {
    if (user?.role !== 'admin') throw httpError(403, 'Administrator access is required.');
    const [rows] = await db.execute("SELECT id FROM users WHERE id=? AND role='admin'", [user.id]);
    if (!rows.length) throw httpError(403, 'Administrator access is required.');
  }
  async function list(user, { feedbackId = null, state = '', page = 1 } = {}) {
    await admin(pool, user);
    const args = [], conditions = [];
    if (feedbackId !== null) { conditions.push('n.feedback_id=?'); args.push(feedbackId); }
    if (['Pending','Processing','Sent','Failed'].includes(state)) { conditions.push('n.state=?'); args.push(state); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const p = Math.max(1, Math.min(100000, Number.parseInt(page, 10) || 1));
    const [rows] = await pool.execute(`SELECT n.id,n.feedback_id,n.kind,n.recipient,n.state,n.attempt_count,n.last_error,n.accepted_at,n.next_attempt_at,n.created_at,f.title,f.reference FROM feedback_email_outbox n INNER JOIN feedback f ON f.id=n.feedback_id ${where} ORDER BY n.created_at DESC,n.id DESC LIMIT 25 OFFSET ${(p-1)*25}`, args);
    const [[total]] = await pool.execute(`SELECT COUNT(*) AS total FROM feedback_email_outbox n ${where}`, args);
    for (const row of rows) {
      const [attempts] = await pool.execute('SELECT attempt_number,outcome,error_code,started_at,finished_at FROM feedback_email_attempts WHERE notification_id=? ORDER BY attempt_number', [row.id]); row.attempts = attempts;
    }
    return { items: rows, total: Number(total.total), page: p, pages: Math.max(1, Math.ceil(Number(total.total)/25)) };
  }
  async function retry(user, id, confirmed = false) {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) throw httpError(404, 'Notification was not found.');
    return transaction(async db => {
      await admin(db, user);
      const [rows] = await db.execute('SELECT n.*,u.email FROM feedback_email_outbox n INNER JOIN feedback f ON f.id=n.feedback_id INNER JOIN users u ON u.id=f.user_id WHERE n.id=? FOR UPDATE', [id]);
      if (!rows.length) throw httpError(404, 'Notification was not found.');
      const row = rows[0];
      if (row.state !== 'Failed' || row.attempt_count >= MAX_ATTEMPTS) throw httpError(409, 'This notification cannot be retried. It may already be queued, accepted, or at its retry limit.');
      if (row.last_error === 'DeliveryUnconfirmed' && !confirmed) throw httpError(422, 'Confirm retrying an unconfirmed send; the student may receive a duplicate.');
      if (!validEmail(row.email)) throw httpError(422, 'The student needs a valid registered email before retrying.');
      await db.execute("UPDATE feedback_email_outbox SET recipient=?,state='Pending',next_attempt_at=CURRENT_TIMESTAMP(3),last_error=NULL,lease_token=NULL,lease_expires_at=NULL WHERE id=?", [row.email,id]);
      await db.execute('INSERT INTO feedback_email_retries (notification_id,requested_by) VALUES (?,?)', [id,user.id]);
    });
  }
  async function recover() {
    await transaction(async db => {
      const [rows] = await db.query("SELECT id,attempt_count FROM feedback_email_outbox WHERE state='Processing' AND lease_expires_at<CURRENT_TIMESTAMP(3) FOR UPDATE");
      for (const row of rows) {
        await db.execute("UPDATE feedback_email_outbox SET state='Failed',last_error='DeliveryUnconfirmed',lease_token=NULL,lease_expires_at=NULL WHERE id=?", [row.id]);
        await db.execute("UPDATE feedback_email_attempts SET outcome='Unconfirmed',error_code='DeliveryUnconfirmed',finished_at=CURRENT_TIMESTAMP(3) WHERE notification_id=? AND attempt_number=?", [row.id,row.attempt_count]);
      }
    });
  }
  async function claim() {
    return transaction(async db => {
      const [rows] = await db.query(`SELECT * FROM feedback_email_outbox WHERE state='Pending' AND attempt_count<${MAX_ATTEMPTS} AND next_attempt_at<=CURRENT_TIMESTAMP(3) ORDER BY created_at,id LIMIT 1 FOR UPDATE`);
      if (!rows.length) return null;
      const row = rows[0], token = randomUUID(), attempt = row.attempt_count + 1;
      await db.execute("UPDATE feedback_email_outbox SET state='Processing',attempt_count=?,lease_token=?,lease_expires_at=DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 2 MINUTE) WHERE id=?", [attempt,token,row.id]);
      await db.execute("INSERT INTO feedback_email_attempts (notification_id,attempt_number,outcome) VALUES (?,?,'Processing')", [row.id,attempt]);
      return { ...row, attempt_count: attempt, lease_token: token };
    });
  }
  async function finish(row, { accepted = false, temporary = false, unconfirmed = false, errorCode = null } = {}) {
    return transaction(async db => {
      const [current] = await db.execute("SELECT id FROM feedback_email_outbox WHERE id=? AND lease_token=? AND state='Processing' FOR UPDATE", [row.id,row.lease_token]);
      if (!current.length) return false;
      const retry = temporary && row.attempt_count < MAX_ATTEMPTS;
      const state = accepted ? 'Sent' : retry ? 'Pending' : 'Failed';
      const outcome = accepted ? 'Accepted' : unconfirmed ? 'Unconfirmed' : retry ? 'TemporaryFailure' : 'Failed';
      const delay = [60,300,900,3600,3600][Math.min(row.attempt_count-1,4)];
      const code = unconfirmed ? 'DeliveryUnconfirmed' : errorCode;
      await db.execute(`UPDATE feedback_email_outbox SET state=?,last_error=?,accepted_at=CASE WHEN ?=1 THEN CURRENT_TIMESTAMP(3) ELSE accepted_at END,next_attempt_at=DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL ? SECOND),lease_token=NULL,lease_expires_at=NULL WHERE id=?`, [state,code,accepted ? 1 : 0,delay,row.id]);
      await db.execute('UPDATE feedback_email_attempts SET outcome=?,error_code=?,finished_at=CURRENT_TIMESTAMP(3) WHERE notification_id=? AND attempt_number=?', [outcome,code,row.id,row.attempt_count]);
      return true;
    });
  }
  return { list, retry, recover, claim, finish };
}
module.exports = { createEmailOutbox, MAX_ATTEMPTS };
