'use strict';
const crypto=require('node:crypto');
const {httpError}=require('../utils/validation');
function createEmailVerification(pool,config) {
  const digest=(id,code)=>crypto.createHmac('sha256',config.sessionSecret).update(id+':'+code).digest('hex');
  async function transaction(action){
    for(let attempt=0;attempt<3;attempt++){
      const db=await pool.getConnection();
      try{await db.beginTransaction();const value=await action(db);await db.commit();return value;}
      catch(error){await db.rollback();if(error.code!=='ER_LOCK_DEADLOCK'||attempt===2)throw error;}
      finally{db.release();}
    }
  }
  async function issue({email,name,passwordHash,userId=null,expectedHash=null},previousChallenge=null){
    return transaction(async db=>{
      const [[row]]=await db.execute('SELECT * FROM email_verifications WHERE email=? FOR UPDATE',[email]);
      if(previousChallenge && (!row || row.challenge_id!==previousChallenge || row.consumed_at))throw httpError(422,'Start registration or email sign-in again.');
      const now=Date.now();
      if(row && now-new Date(row.sent_at).getTime()<60000)throw httpError(429,'Wait 60 seconds after the last code before requesting another.');
      const sameHour=row && now-new Date(row.hour_started_at).getTime()<3600000;
      if(sameHour && row.send_count>=5)throw httpError(429,'Too many verification emails. Please try again in an hour.');
      const challenge=crypto.randomBytes(32).toString('hex');
      let code;
      do{code=String(crypto.randomInt(0,1000000)).padStart(6,'0');}while(row&&digest(row.challenge_id,code)===row.code_hash);
      const expires=new Date(now+5*60000);
      await db.execute(`INSERT INTO email_verifications(email,challenge_id,code_hash,name,password_hash,expected_hash,user_id,expires_at,attempts,sent_at,consumed_at,hour_started_at,send_count)
        VALUES (?,?,?,?,?,?,?,?,0,?,NULL,?,?) ON DUPLICATE KEY UPDATE challenge_id=VALUES(challenge_id),code_hash=VALUES(code_hash),name=VALUES(name),password_hash=VALUES(password_hash),expected_hash=VALUES(expected_hash),user_id=VALUES(user_id),expires_at=VALUES(expires_at),attempts=0,sent_at=VALUES(sent_at),consumed_at=NULL,hour_started_at=VALUES(hour_started_at),send_count=VALUES(send_count)`,
      [email,challenge,digest(challenge,code),name,passwordHash,expectedHash,userId,expires,new Date(now),sameHour?row.hour_started_at:new Date(now),sameHour?row.send_count+1:1]);
      return {challenge,code,email,expiresAt:expires};
    });
  }
  async function status(challenge){
    if(typeof challenge!=='string'||!/^[a-f0-9]{64}$/.test(challenge))return null;
    const [[row]]=await pool.execute('SELECT email,name,password_hash,expected_hash,user_id,expires_at,attempts,sent_at,consumed_at FROM email_verifications WHERE challenge_id=?',[challenge]);
    return row && !row.consumed_at ? row : null;
  }
  async function resend(challenge){
    const row=await status(challenge);if(!row)throw httpError(422,'Start registration or email sign-in again.');
    return issue({email:row.email,name:row.name,passwordHash:row.password_hash,userId:row.user_id,expectedHash:row.expected_hash},challenge);
  }
  async function verify(challenge,code){
    if(typeof challenge!=='string'||!/^[a-f0-9]{64}$/.test(challenge))return {error:'Start registration or email sign-in again.'};
    return transaction(async db=>{
      const [[row]]=await db.execute('SELECT * FROM email_verifications WHERE challenge_id=? FOR UPDATE',[challenge]);
      if(!row || row.consumed_at)return {error:'This code has already been used or replaced. Request a new code.'};
      if(row.attempts>=5)return {error:'Five attempts used. Request a new code.'};
      if(new Date(row.expires_at).getTime()<=Date.now())return {error:'This code expired. Request a new code.'};
      const matches=typeof code==='string' && /^\d{6}$/.test(code) && crypto.timingSafeEqual(Buffer.from(row.code_hash,'hex'),Buffer.from(digest(challenge,code),'hex'));
      if(!matches){
        await db.execute('UPDATE email_verifications SET attempts=attempts+1 WHERE challenge_id=?',[challenge]);
        const remaining=4-row.attempts;
        return {error:remaining>0?`Incorrect code. ${remaining} attempts remaining.`:'Five attempts used. Request a new code.'};
      }
      const [[existing]]=await db.execute('SELECT id,google_id,email_verified_at,password_hash,legacy_active FROM users WHERE email=? FOR UPDATE',[row.email]);
      if(existing && !row.user_id && (existing.google_id || existing.email_verified_at || existing.legacy_active))return {error:'An account already exists. Sign in and explicitly link Google if needed.'};
      if(row.user_id && (!existing || existing.id!==row.user_id))return {error:'Your account changed. Start email sign-in again.'};
      if(row.user_id && existing.password_hash!==row.expected_hash)return {error:'Your password changed. Start email sign-in again.'};
      let id;
      if(existing){
        id=existing.id;
        await db.execute('UPDATE users SET name=IF(?,name,?),password_hash=?,email_verified_at=CURRENT_TIMESTAMP(3),password_verified_at=CURRENT_TIMESTAMP(3),session_version=session_version+1 WHERE id=?',[Boolean(row.user_id),row.name,row.password_hash,id]);
      }else{
        const [result]=await db.execute("INSERT INTO users(name,email,password_hash,role,email_verified_at,password_verified_at) VALUES (?,?,?,'student',CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3))",[row.name,row.email,row.password_hash]);id=result.insertId;
      }
      await db.execute('UPDATE email_verifications SET consumed_at=CURRENT_TIMESTAMP(3) WHERE challenge_id=?',[challenge]);
      return {id,email:row.email};
    });
  }
  return {issue,status,resend,verify};
}
function createVerificationMailer(config,transport=require('./feedback-email').createEmailTransport(config)){
  return async ({email,code})=>{
    if(!transport)throw Object.assign(new Error('Configure Gmail SMTP to send verification codes.'),{code:'SMTPUnavailable'});
    const info=await transport.sendMail({from:{name:config.smtpFromName||'CSPConnect',address:config.smtpFrom},to:email,subject:'CSPConnect email verification code',
      text:`Your CSPConnect verification code is: ${code}\n\nIt expires in 5 minutes. You have 5 attempts. Do not share this code. If you did not request it, ignore this message.`,disableFileAccess:true,disableUrlAccess:true});
    if(!info.accepted?.some(address=>String(address).toLowerCase()===email.toLowerCase()))throw Object.assign(new Error('Verification email was not accepted.'),{code:'SMTPRejected'});
  };
}
module.exports={createEmailVerification,createVerificationMailer};
