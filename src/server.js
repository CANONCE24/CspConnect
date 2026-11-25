'use strict';
const http = require('node:http');
const { loadConfig } = require('./config/env');
const { pool } = require('./config/db');
const { createApp } = require('./app');

async function start() {
  const config = loadConfig({ strict: true });
  await pool.query('SELECT 1');
  await pool.query('SELECT id FROM categories LIMIT 1');
  await pool.query('SELECT session_id FROM sessions LIMIT 1');
  await pool.query('SELECT id FROM emergency_reports LIMIT 1');
  await pool.query('SELECT id FROM feedback_email_outbox LIMIT 1');
  await pool.query('SELECT id,support_ticket_id FROM feedback_notifications LIMIT 1');
  await pool.query('SELECT id FROM support_tickets LIMIT 1');
  await pool.query('SELECT id FROM support_messages LIMIT 1');
  await pool.query('SELECT id FROM support_history LIMIT 1');
  await pool.query('SELECT comment_id FROM comment_moderation LIMIT 1');
  await pool.query('SELECT id FROM comment_reports LIMIT 1');
  await pool.query('SELECT id FROM comment_moderation_history LIMIT 1');
  await pool.query('SELECT email_verified_at,password_verified_at,session_version,legacy_active,affiliation,affiliation_email FROM users LIMIT 1');
  await pool.query('SELECT token_hash FROM account_action_tokens LIMIT 1');
  await pool.query('SELECT challenge_id FROM email_verifications LIMIT 1');
  const app = createApp({ config });
  const server = http.createServer(app);
  const io = require('./services/emergency-realtime').attachEmergencyRealtime(server, app);
  try {
    await new Promise((resolve, reject) => {
      const failed = error => { server.off('listening', ready); reject(error); };
      const ready = () => { server.off('error', failed); resolve(); };
      server.once('error', failed);
      server.once('listening', ready);
      server.listen(config.port, config.host);
    });
  } catch (error) {
    io.close();
    app.locals.sessionStore.close?.();
    throw error;
  }
  // Background work starts only after successfully binding the port.
  const emailWorker = require('./services/email-worker').createEmailWorker({ outbox: app.locals.emailOutbox, config });
  emailWorker.start();
  console.log('CSPConnect: ' + config.appUrl);
  if (!config.googleClientId || !config.googleClientSecret) console.log('Google sign-in requires credentials in .env.');
  if (!config.geminiApiKey) console.log('Professor is disabled until GEMINI_API_KEY is configured.');
  if (!emailWorker.enabled) console.log('SMTP is disabled or incomplete. Configure SMTP to send verification, recovery and feedback email.');
  let stopping = false;
  async function stop(exitCode = 0) {
    if (stopping) return;
    stopping = true;
    await emailWorker.stop();
    await new Promise(resolve => io.close(resolve));
    app.locals.sessionStore.close?.();
    await pool.end();
    process.exit(exitCode);
  }
  server.on('error', error => { console.error('Server error:', error.code || error.name); void stop(1); });
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
}

start().catch(async error => {
  const connectionFailed = ['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH'].includes(error.code);
  const schemaMissing = ['ER_BAD_FIELD_ERROR', 'ER_NO_SUCH_TABLE'].includes(error.code);
  console.error('Startup failed:', error.code === 'EADDRINUSE'
    ? `Port ${process.env.PORT || 3000} is already in use. Stop the other CSPConnect instance before starting another.`
    : connectionFailed ? 'MySQL is unavailable. Check DB_HOST/DB_PORT and run npm run db:start.'
    : schemaMissing ? 'The database needs a migration. Run npm run db:migrate-login, npm run db:migrate-notifications, npm run db:migrate-comments, npm run db:migrate-affiliation, and npm run db:migrate-support; db:setup is only for a fresh installation.'
    : error.message);
  await pool.end();
  process.exitCode = 1;
});
