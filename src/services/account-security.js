'use strict';
const crypto = require('node:crypto');
const { httpError } = require('../utils/validation');
const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');
const tokenValid = token => typeof token === 'string' && /^[a-f0-9]{64}$/.test(token);
const accountReady = user => Boolean(user?.email_verified_at || user?.legacy_active);
function createAccountSecurity(pool, config) {
  async function transaction(action) {
    const db = await pool.getConnection();
    try { await db.beginTransaction(); const result=await action(db); await db.commit(); return result; }
    catch(error) { await db.rollback(); throw error; } finally { db.release(); }
  }
  async function issue(email, purpose) {
    if (!['verify','reset'].includes(purpose)) throw new Error('Invalid account action.');
    return transaction(async db => {
      const [users] = await db.execute('SELECT id,email,email_verified_at FROM users WHERE email=? FOR UPDATE',[email]);
      const user=users[0];
      if (!user || (purpose==='verify' && user.email_verified_at)) return null;
      const [recent] = await db.execute('SELECT COUNT(*) AS count,MAX(created_at) AS latest FROM account_action_tokens WHERE user_id=? AND created_at>DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 1 HOUR)',[user.id]);
      if (Number(recent[0].count)>=5 || (recent[0].latest && Date.now()-new Date(recent[0].latest).getTime()<60000)) return null;
      const token=crypto.randomBytes(32).toString('hex');
      await db.execute('UPDATE account_action_tokens SET used_at=CURRENT_TIMESTAMP(3) WHERE user_id=? AND purpose=? AND used_at IS NULL',[user.id,purpose]);
      await db.execute('INSERT INTO account_action_tokens(token_hash,user_id,purpose,expires_at) VALUES (?,?,?,DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 30 MINUTE))',[hashToken(token),user.id,purpose]);
      return {token,email:user.email,purpose};
    });
  }
  async function inspect(token, purpose) {
    if (!tokenValid(token)) return false;
    const [rows]=await pool.execute('SELECT user_id FROM account_action_tokens WHERE token_hash=? AND purpose=? AND used_at IS NULL AND expires_at>CURRENT_TIMESTAMP(3)',[hashToken(token),purpose]);
    return rows.length>0;
  }
  async function redeem(token,purpose,passwordHash) {
    if (!tokenValid(token) || !['verify','reset'].includes(purpose)) throw httpError(422,'This link is invalid or expired. Request another email.');
    return transaction(async db => {
      // Lock the account before its tokens, matching issue(), to serialize ownership changes.
      const [lookup]=await db.execute('SELECT user_id FROM account_action_tokens WHERE token_hash=?',[hashToken(token)]);
      if (!lookup.length) throw httpError(422,'This link is invalid or expired. Request another email.');
      const [users]=await db.execute('SELECT id,email FROM users WHERE id=? FOR UPDATE',[lookup[0].user_id]);
      const [rows]=await db.execute('SELECT user_id FROM account_action_tokens WHERE token_hash=? AND purpose=? AND used_at IS NULL AND expires_at>CURRENT_TIMESTAMP(3) FOR UPDATE',[hashToken(token),purpose]);
      if (!rows.length) throw httpError(422,'This link is invalid or expired. Request another email.');
      await db.execute('UPDATE users SET password_hash=?,must_change_password=0,email_verified_at=COALESCE(email_verified_at,CURRENT_TIMESTAMP(3)),password_verified_at=CURRENT_TIMESTAMP(3),session_version=session_version+1 WHERE id=?',[passwordHash,rows[0].user_id]);
      await db.execute('UPDATE account_action_tokens SET used_at=CURRENT_TIMESTAMP(3) WHERE user_id=? AND used_at IS NULL',[rows[0].user_id]);
      await db.execute('UPDATE email_verifications SET consumed_at=CURRENT_TIMESTAMP(3) WHERE email=? AND consumed_at IS NULL',[users[0].email]);
    });
  }
  return {issue,inspect,redeem};
}
function createAccountMailer(config,transport=require('./feedback-email').createEmailTransport(config)) {
  return async ({token,email,purpose}) => {
    if (!transport) throw new Error('Account email is not configured.');
    const link=new URL(purpose==='reset'?'/reset-password':'/verify-email',config.appUrl);
    if (!['http:','https:'].includes(link.protocol) || (config.nodeEnv==='production' && link.protocol!=='https:')) throw new Error('Invalid account link origin.');
    link.searchParams.set('token',token);
    const action=purpose==='reset'?'Reset your password':'Verify your email and set your password';
    const info=await transport.sendMail({from:{name:config.smtpFromName,address:config.smtpFrom},to:email,subject:'CSPConnect: '+action,
      text:`${action}\n\nOpen this link to choose your own password:\n${link.href}\n\nThis link expires in 30 minutes and can be used once. Existing sessions will be signed out. If you did not request this, ignore this email.`,disableFileAccess:true,disableUrlAccess:true});
    if (!info.accepted?.some(address=>String(address).toLowerCase()===email.toLowerCase())) throw new Error('Account email was not accepted.');
  };
}
module.exports={createAccountSecurity,createAccountMailer,accountReady};
