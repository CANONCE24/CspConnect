'use strict';
const { randomUUID } = require('node:crypto');
const { STATUSES } = require('../utils/constants');
const { httpError, id } = require('../utils/validation');
const { validateUpdate } = require('./responseTemplates');
async function methodForHistory(db, historyId) {
  // Current locking reads also see an update committed by a concurrent first click.
  const [emails] = await db.execute('SELECT id FROM feedback_email_outbox WHERE history_id=? FOR UPDATE', [historyId]);
  const [web] = await db.execute('SELECT id FROM feedback_notifications WHERE event_key=? FOR UPDATE', ['status:' + historyId]);
  return emails.length && web.length ? 'both' : emails.length ? 'email' : 'web';
}
function validEmail(value) {
  if (typeof value !== 'string' || value.length > 254 || /[\r\n\s]/.test(value)) return false;
  const parts = value.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  return local.length > 0 && local.length <= 64 && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) && !local.startsWith('.') && !local.endsWith('.') && !local.includes('..') &&
    domain.split('.').length >= 2 && domain.split('.').every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)) && /^[A-Za-z]{2,63}$/.test(domain.split('.').at(-1));
}
async function changeFeedbackStatus(pool, feedbackId, status, adminId, input = {}) {
  if (!STATUSES.includes(status)) throw httpError(422, 'Choose a valid status.');
  if (!id(feedbackId) || !id(adminId)) throw httpError(422, 'Invalid feedback or account.');
  const key = input.requestKey || randomUUID();
  if (typeof key !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) throw httpError(422, 'Refresh the page before submitting this action.');
  const db = await pool.getConnection();
  try {
    await db.beginTransaction();
    const [admins] = await db.execute("SELECT id FROM users WHERE id=? AND role='admin'", [adminId]);
    if (!admins.length) throw httpError(403, 'Administrator access is required.');
    const [rows] = await db.execute(`SELECT f.id,f.status,f.title,f.reference,u.name,u.email FROM feedback f INNER JOIN users u ON u.id=f.user_id WHERE f.id=? FOR UPDATE`, [feedbackId]);
    if (!rows.length) throw httpError(404, 'Feedback was not found.');
    const row = rows[0];
    const [replays] = await db.execute('SELECT id,status,changed_by,additional_message,resolution_summary,rejection_reason FROM feedback_status_history WHERE feedback_id=? AND request_key=? FOR UPDATE', [feedbackId, key]);
    if (replays.length && (replays[0].status !== status || replays[0].changed_by !== Number(adminId))) throw httpError(409, 'This action was already used. Refresh the page.');
    const { response, notificationMethod, actionTaken, closureReason } = validateUpdate(status, input);
    if (replays.length) {
      const previous = replays[0];
      const previousMethod = await methodForHistory(db, previous.id);
      if ((previous.additional_message || null) !== response || (previous.resolution_summary || null) !== actionTaken || (previous.rejection_reason || null) !== closureReason || previousMethod !== notificationMethod) throw httpError(409, 'This action was already used for a different update. Refresh the page.');
      await db.commit(); return { changed: false };
    }
    const statusChanged = row.status !== status;
    if (!statusChanged && !response) { await db.commit(); return { changed: false }; }
    if (!statusChanged) {
      const [latest] = await db.execute('SELECT id,additional_message,resolution_summary,rejection_reason FROM feedback_status_history WHERE feedback_id=? ORDER BY id DESC LIMIT 1 FOR UPDATE', [feedbackId]);
      const previous = latest[0];
      if (previous && previous.additional_message === response && (previous.resolution_summary || null) === actionTaken && (previous.rejection_reason || null) === closureReason && await methodForHistory(db,previous.id) === notificationMethod) {
        await db.commit(); return { changed:false };
      }
    }
    await db.execute("UPDATE feedback SET status=?,updated_at=CURRENT_TIMESTAMP,resolved_at=CASE WHEN ?='Resolved' AND ?=1 THEN CURRENT_TIMESTAMP(3) ELSE resolved_at END WHERE id=?", [status,status,statusChanged ? 1 : 0,feedbackId]);
    const [history] = await db.execute(`INSERT INTO feedback_status_history (feedback_id,previous_status,status,changed_by,request_key,additional_message,resolution_summary,rejection_reason) VALUES (?,?,?,?,?,?,?,?)`, [feedbackId,row.status,status,adminId,key,response,actionTaken,closureReason]);
    if (response) await db.execute('INSERT INTO feedback_responses (feedback_id,admin_id,body) VALUES (?,?,?)', [feedbackId,adminId,response]);
    const invalid = !validEmail(row.email);
    const payload = { name: row.name, title: row.title, reference: row.reference, feedbackId: Number(feedbackId), status, response, statusChanged, concise: true };
    if (notificationMethod !== 'web') await db.execute(`INSERT INTO feedback_email_outbox (id,feedback_id,history_id,kind,recipient,payload_json,state,last_error) VALUES (?,?,?,?,?,?,?,?)`, [randomUUID(),feedbackId,history.insertId,'StatusUpdated',row.email || '',JSON.stringify(payload),invalid ? 'Failed' : 'Pending',invalid ? 'InvalidRecipient' : null]);
    if (notificationMethod !== 'email') await require('../models/notifications').queueNotification(db, feedbackId, {
      kind: statusChanged ? 'StatusUpdated' : 'AdminResponse', eventKey: 'status:' + history.insertId,
      message: statusChanged ? `Your submission status changed to ${status}.${response ? ' An administrator also added a response.' : ''}` : 'An administrator added a response to your submission.'
    });
    await db.commit(); return { changed: true, notificationMethod, emailQueued: notificationMethod !== 'web' && !invalid, emailFailed: notificationMethod !== 'web' && invalid };
  } catch (error) { await db.rollback(); throw error; } finally { db.release(); }
}
module.exports = { changeFeedbackStatus, validEmail };
