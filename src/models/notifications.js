'use strict';
const { randomUUID } = require('node:crypto');
const { id, httpError } = require('../utils/validation');
const recordId = value => { const result = id(value); if (!result) throw httpError(422, 'Choose a valid notification.'); return result; };

// Use the administrator action's transaction: an update and its notification commit together.
async function queueNotification(db, feedbackId, { kind, message, eventKey = randomUUID() }) {
  await db.execute(`INSERT INTO feedback_notifications (user_id,feedback_id,kind,message,event_key)
    SELECT user_id,id,?,?,? FROM feedback WHERE id=?`, [kind, message, eventKey, feedbackId]);
}

function createNotificationStore(pool) {
  const joins = `FROM feedback_notifications n LEFT JOIN feedback f ON f.id=n.feedback_id
    LEFT JOIN support_tickets t ON t.id=n.support_ticket_id INNER JOIN users recipient ON recipient.id=n.user_id`;
  const permitted = "(n.support_ticket_id IS NULL OR t.user_id=n.user_id OR recipient.role='admin')";
  async function unreadNotificationCount(userId) {
    const [[row]] = await pool.execute(`SELECT COUNT(*) AS total ${joins} WHERE n.user_id=? AND n.read_at IS NULL AND ${permitted}`, [recordId(userId)]);
    return Number(row.total);
  }
  async function listNotifications(userId, { page = 1 } = {}) {
    const owner = recordId(userId);
    const [[counts]] = await pool.execute(`SELECT COUNT(*) AS total,MAX(n.id) AS latestId ${joins} WHERE n.user_id=? AND ${permitted}`, [owner]);
    const total = Number(counts.total), pages = Math.max(1, Math.ceil(total / 20));
    page = Math.min(id(page) || 1, pages);
    const [items] = await pool.execute(`SELECT n.id,n.feedback_id,n.support_ticket_id,n.kind,n.message,n.read_at,n.created_at,
      CASE WHEN n.support_ticket_id IS NOT NULL THEN 'Private support conversation' ELSE f.title END AS title,
      COALESCE(f.reference,t.reference) AS reference ${joins}
      WHERE n.user_id=? AND ${permitted} ORDER BY n.id DESC LIMIT ? OFFSET ?`, [owner,20,(page - 1) * 20]);
    return { items, total, page, pages, latestId: Number(counts.latestId || 0) };
  }
  async function readNotification(userId, notificationId) {
    const owner = recordId(userId), notification = recordId(notificationId);
    const [rows] = await pool.execute(`SELECT n.feedback_id,n.support_ticket_id ${joins} WHERE n.id=? AND n.user_id=? AND ${permitted}`, [notification, owner]);
    if (!rows.length) throw httpError(404, 'Notification was not found.');
    await pool.execute('UPDATE feedback_notifications SET read_at=COALESCE(read_at,CURRENT_TIMESTAMP(3)) WHERE id=? AND user_id=?', [notification, owner]);
    return {feedbackId:rows[0].feedback_id ? Number(rows[0].feedback_id) : null,ticketId:rows[0].support_ticket_id ? Number(rows[0].support_ticket_id) : null};
  }
  async function readAllNotifications(userId, throughId) {
    await pool.execute('UPDATE feedback_notifications SET read_at=CURRENT_TIMESTAMP(3) WHERE user_id=? AND id<=? AND read_at IS NULL', [recordId(userId), recordId(throughId)]);
  }
  return { unreadNotificationCount, listNotifications, readNotification, readAllNotifications };
}
module.exports = { queueNotification, createNotificationStore };
