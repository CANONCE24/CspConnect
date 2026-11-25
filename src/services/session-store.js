'use strict';
const session = require('express-session');
class MySQLSessionStore extends session.Store {
  constructor(pool) {
    super(); this.pool = pool;
    this.cleanup = setInterval(() => {
      this.pool.execute('DELETE FROM sessions WHERE expires < ?', [Date.now()]).catch(() => {});
    }, 15 * 60 * 1000);
    this.cleanup.unref();
  }
  get(sid, callback) {
    this.pool.execute('SELECT data FROM sessions WHERE session_id = ? AND expires > ?', [sid, Date.now()])
      .then(([rows]) => callback(null, rows.length ? JSON.parse(rows[0].data) : null)).catch(callback);
  }
  set(sid, sess, callback = () => {}) {
    const expires = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 8 * 3600000;
    this.pool.execute('INSERT INTO sessions (session_id, expires, data) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE expires = VALUES(expires), data = VALUES(data)',
      [sid, expires, JSON.stringify(sess)]).then(() => callback()).catch(callback);
  }
  destroy(sid, callback = () => {}) {
    this.pool.execute('DELETE FROM sessions WHERE session_id = ?', [sid]).then(() => callback()).catch(callback);
  }
  touch(sid, sess, callback = () => {}) {
    const expires = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 8 * 3600000;
    this.pool.execute('UPDATE sessions SET expires = ? WHERE session_id = ?', [expires, sid])
      .then(() => callback()).catch(callback);
  }
  close() { clearInterval(this.cleanup); }
}
module.exports = { MySQLSessionStore };
