'use strict';
require('dotenv').config({ quiet: true });
const { pool } = require('../src/config/db');
async function provision() {
  const email = (process.env.SECURITY_PROVISION_EMAIL || '').trim().toLowerCase();
  const { loadConfig } = require('../src/config/env');
  const config = loadConfig();
  if (!email || !config.securityEmails.includes(email) || config.adminEmails.includes(email)) throw new Error('Set SECURITY_PROVISION_EMAIL to an existing non-admin account in SECURITY_EMAILS.');
  const [result] = await pool.execute("UPDATE users SET role='security',session_version=session_version+1 WHERE email=? AND role IN ('student','security') AND (email_verified_at IS NOT NULL OR legacy_active=1)", [email]);
  if (!result.affectedRows) throw new Error('Create the account and verify its email first. No credentials were changed.');
  console.log('Security role assigned. The account must remain in SECURITY_EMAILS to retain access.');
}
if (require.main === module) provision().catch(error => { console.error(error.code || error.message); process.exitCode = 1; }).finally(() => pool.end());
module.exports = { provision };
