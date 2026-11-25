'use strict';
const { Server } = require('socket.io');
const { roleFor } = require('../utils/emergency');
function attachEmergencyRealtime(server, app, { escalationInterval = 15000 } = {}) {
  const { config, accountStore, emergencyStore, sessionMiddleware } = app.locals;
  const io = new Server(server, { maxHttpBufferSize: 8192, serveClient: true,
    allowRequest: (req, done) => {
      // Same origin browser requests; non-browser clients must still authenticate with a session and CSRF token.
      const origin = req.headers.origin;
      done(null, !origin || origin === new URL(config.appUrl).origin);
    }
  });
  io.engine.use(sessionMiddleware);
  async function identity(socket) {
    const req = socket.request;
    await new Promise((resolve, reject) => req.session.reload(error => error ? reject(error) : resolve()));
    const identity=req.session.passport?.user;
    const user = identity && typeof identity==='object' ? await accountStore.getUser(identity.id) : null;
    if (!user || Number(user.session_version || 0)!==identity.version || !require('./account-security').accountReady(user) || user.must_change_password || !['student', 'security'].includes(roleFor(user, config)) || socket.handshake.auth.csrfToken !== req.session.csrfToken) throw new Error('Sign in again to receive emergency updates.');
    const role = roleFor(user, config);
    if (socket.data.user && socket.data.user.role !== role) throw new Error('Account permissions changed.');
    return { ...user, role };
  }
  io.use(async (socket, next) => {
    try {
      if (!socket.request.session?.passport?.user) throw new Error('Authentication required.');
      socket.data.user = await identity(socket); next();
    } catch { next(new Error('Emergency connection not authorized.')); }
  });
  io.on('connection', socket => {
    // Room membership is entirely server controlled. No client event can join another student's room.
    const user = socket.data.user;
    socket.join(user.role === 'security' ? 'emergency:security' : 'emergency:student:' + user.id);
    socket.emit('emergency:ready');
  });
  const publish = async report => {
    const sockets = [...io.sockets.sockets.values()];
    await Promise.allSettled(sockets.map(async socket => {
      try {
        const user = await identity(socket);
        if (user.role === 'security' || user.id === report.reporter_id) socket.emit('emergency:changed', { id: report.id });
      } catch { socket.disconnect(true); }
    }));
  };
  app.locals.publishEmergency = publish;
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      // Revoke expired/logged-out/removed accounts even when no incidents arrive.
      await Promise.allSettled([...io.sockets.sockets.values()].map(async socket => {
        try { await identity(socket); } catch { socket.disconnect(true); }
      }));
      for (const report of await emergencyStore.escalate()) await publish(report);
    } catch (error) { console.error('Emergency recovery/escalation unavailable:', error.code || error.name); }
    finally { running = false; }
  }, escalationInterval);
  timer.unref();
  io.on('close', () => clearInterval(timer));
  // Socket.IO does not emit a public close event consistently across adapters.
  const close = io.close.bind(io);
  io.close = callback => { clearInterval(timer); return close(callback); };
  return io;
}
module.exports = { attachEmergencyRealtime };
