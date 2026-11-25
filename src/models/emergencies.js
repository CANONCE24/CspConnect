'use strict';
const { fail, reportInput, settingsInput, STATUSES, randomUUID, phone, isId } = require('../utils/emergency');
function createEmergencyStore(pool, config) {
  async function transaction(action) {
    const db = await pool.getConnection();
    try { await db.beginTransaction(); const result = await action(db); await db.commit(); return result; }
    catch (error) { await db.rollback(); throw error; } finally { db.release(); }
  }
  async function needRole(db, user, role, lock = false) {
    const [rows] = await db.execute(`SELECT id FROM users WHERE id = ? AND role = ?${lock ? ' FOR UPDATE' : ''}`, [user.id, role]);
    if (!rows.length || user.role !== role) fail(403, 'This action is not authorized.');
  }
  function scope(user) {
    if (user.role === 'security') return ['', []];
    if (user.role === 'student') return [' AND reporter_id = ?', [user.id]];
    fail(403, 'This action is not authorized.');
  }
  async function settings() {
    const [rows] = await pool.query('SELECT guardhouse_number, number_verified, escalation_minutes FROM emergency_settings WHERE id = 1');
    const value = rows[0] || { guardhouse_number: config.guardhouseNumber || '', number_verified: config.guardhouseNumberVerified, escalation_minutes: config.emergencyEscalationMinutes || 3 };
    return { ...value, guardhouse_name: config.guardhouseName || 'Guardhouse', number_verified: Boolean(value.number_verified), call_number: value.number_verified ? phone(value.guardhouse_number) : null };
  }
  async function saveSettings(user, input) {
    const values = settingsInput(input);
    await transaction(async db => {
      await needRole(db, user, 'admin');
      await db.execute(`INSERT INTO emergency_settings (id,guardhouse_number,number_verified,escalation_minutes,updated_by) VALUES (1,?,?,?,?)
        ON DUPLICATE KEY UPDATE guardhouse_number=VALUES(guardhouse_number),number_verified=VALUES(number_verified),escalation_minutes=VALUES(escalation_minutes),updated_by=VALUES(updated_by),updated_at=CURRENT_TIMESTAMP(3)`,
      [values.guardhouse_number, values.number_verified ? 1 : 0, values.escalation_minutes, user.id]);
      await db.execute('INSERT INTO emergency_settings_history (actor_id,settings_json) VALUES (?,?)', [user.id, JSON.stringify(values)]);
    });
  }
  async function detail(user, reportId) {
    if (!isId(reportId)) fail(404, 'Emergency report was not found.');
    const [where, args] = scope(user);
    const [rows] = await pool.execute(`SELECT * FROM emergency_reports WHERE id = ?${where}`, [reportId, ...args]);
    if (!rows.length) fail(404, 'Emergency report was not found.');
    const [history] = await pool.execute('SELECT action,previous_status,status,actor_id,created_at FROM emergency_history WHERE report_id = ? ORDER BY id', [reportId]);
    return { ...rows[0], history };
  }
  async function list(user, { history = false, page = 1 } = {}) {
    const [where, args] = scope(user);
    const resolved = history ? "status = 'Resolved'" : "status <> 'Resolved'";
    const offset = (Math.max(1, Math.min(100000, Number.parseInt(page, 10) || 1)) - 1) * 25;
    // All outstanding incidents are returned, so an old unacknowledged report cannot fall off a page.
    const [rows] = await pool.execute(`SELECT * FROM emergency_reports WHERE ${resolved}${where} ORDER BY created_at DESC,id DESC${history ? ` LIMIT 25 OFFSET ${offset}` : ''}`, args);
    const [counts] = await pool.execute(`SELECT status,COUNT(*) AS total FROM emergency_reports WHERE 1=1${where} GROUP BY status`, args);
    return { reports: rows, counts: Object.fromEntries(STATUSES.map(status => [status, Number(counts.find(row => row.status === status)?.total || 0)])) };
  }
  async function submit(user, input) {
    const value = reportInput(input);
    const reportId = await transaction(async db => {
      await needRole(db, user, 'student', true);
      const [existing] = await db.execute('SELECT id FROM emergency_reports WHERE reporter_id = ? AND request_key = ?', [user.id, value.request_key]);
      if (existing.length) return existing[0].id;
      const [count] = await db.execute('SELECT COUNT(*) AS total FROM emergency_reports WHERE reporter_id = ? AND created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 MINUTE)', [user.id]);
      if (Number(count[0].total) >= 5) fail(429, 'Too many reports. Call the guardhouse or official emergency services directly for urgent help.');
      const id = randomUUID();
      await db.execute('INSERT INTO emergency_reports (id,reporter_id,request_key,type,location,description,contact_number) VALUES (?,?,?,?,?,?,?)', [id, user.id, value.request_key, value.type, value.location, value.description, value.contact_number]);
      await db.execute("INSERT INTO emergency_history (report_id,actor_id,action,status) VALUES (?,?,'Submitted','Submitted')", [id, user.id]);
      return id;
    });
    return detail(user, reportId);
  }
  async function updateStatus(user, reportId, status) {
    if (!isId(reportId) || !STATUSES.includes(status)) fail(422, 'Choose a valid report and status.');
    await transaction(async db => {
      await needRole(db, user, 'security');
      const [rows] = await db.execute('SELECT status FROM emergency_reports WHERE id = ? FOR UPDATE', [reportId]);
      if (!rows.length) fail(404, 'Emergency report was not found.');
      const previous = rows[0].status;
      if (status === previous) return;
      if (STATUSES.indexOf(status) !== STATUSES.indexOf(previous) + 1) fail(409, 'The report changed or this transition is invalid. Refresh and follow Submitted → Acknowledged → Responding → Resolved.');
      await db.execute(`UPDATE emergency_reports SET status=?,updated_at=CURRENT_TIMESTAMP(3),
        acknowledged_by=CASE WHEN ?='Acknowledged' THEN ? ELSE acknowledged_by END,
        acknowledged_at=CASE WHEN ?='Acknowledged' THEN CURRENT_TIMESTAMP(3) ELSE acknowledged_at END,
        resolved_at=CASE WHEN ?='Resolved' THEN CURRENT_TIMESTAMP(3) ELSE resolved_at END WHERE id=?`, [status, status, user.id, status, status, reportId]);
      await db.execute("INSERT INTO emergency_history (report_id,actor_id,action,previous_status,status) VALUES (?,?,'Status changed',?,?)", [reportId, user.id, previous, status]);
    });
    return detail(user, reportId);
  }
  async function escalate() {
    const config = await settings();
    return transaction(async db => {
      const [rows] = await db.execute("SELECT id,reporter_id FROM emergency_reports WHERE status='Submitted' AND escalated_at IS NULL AND created_at <= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? MINUTE) FOR UPDATE", [config.escalation_minutes]);
      for (const row of rows) {
        await db.execute('UPDATE emergency_reports SET escalated_at=CURRENT_TIMESTAMP(3),updated_at=CURRENT_TIMESTAMP(3) WHERE id=?', [row.id]);
        await db.execute("INSERT INTO emergency_history (report_id,action,previous_status,status) VALUES (?,'Escalated','Submitted','Submitted')", [row.id]);
      }
      return rows;
    });
  }
  async function respond(user, reportId) {
    if (!isId(reportId)) fail(404, 'Emergency report was not found.');
    await transaction(async db => {
      await needRole(db, user, 'security');
      const [rows] = await db.execute('SELECT status FROM emergency_reports WHERE id=? FOR UPDATE', [reportId]);
      if (!rows.length) fail(404, 'Emergency report was not found.');
      const previous = rows[0].status;
      if (['Responding', 'Resolved'].includes(previous)) return;
      if (previous === 'Submitted') {
        await db.execute('UPDATE emergency_reports SET acknowledged_by=?,acknowledged_at=CURRENT_TIMESTAMP(3) WHERE id=?', [user.id, reportId]);
        await db.execute("INSERT INTO emergency_history (report_id,actor_id,action,previous_status,status) VALUES (?,?,'Status changed','Submitted','Acknowledged')", [reportId, user.id]);
      }
      await db.execute("UPDATE emergency_reports SET status='Responding',updated_at=CURRENT_TIMESTAMP(3) WHERE id=?", [reportId]);
      await db.execute("INSERT INTO emergency_history (report_id,actor_id,action,previous_status,status) VALUES (?,?,'Response accepted','Acknowledged','Responding')", [reportId, user.id]);
    });
    return detail(user, reportId);
  }
  return { settings, saveSettings, detail, list, submit, updateStatus, respond, escalate };
}
module.exports = { createEmergencyStore };
