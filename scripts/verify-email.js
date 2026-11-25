'use strict';
const { loadConfig } = require('../src/config/env');
const { createEmailTransport } = require('../src/services/feedback-email');
async function verify() {
  const transport = createEmailTransport(loadConfig());
  if (!transport) throw new Error('Set SMTP_ENABLED=true and configure SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, and SMTP_FROM.');
  try { await transport.verify(); console.log('SMTP connection, TLS, and authentication passed. No email was sent; sender acceptance and inbox delivery are not verified.'); }
  finally { transport.close(); }
}
if (require.main === module) verify().catch(error => { console.error('SMTP verification failed:',error.code || error.message);process.exitCode=1; });
module.exports = { verify };
