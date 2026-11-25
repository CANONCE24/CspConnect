'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
async function migrate(pool=require('../src/config/db').pool) {
  const [columns]=await pool.query('SHOW COLUMNS FROM users');
  for(const [name,type] of [['email_verified_at','DATETIME(3) NULL'],['password_verified_at','DATETIME(3) NULL'],['session_version','INT UNSIGNED NOT NULL DEFAULT 0'],['legacy_active','TINYINT(1) NOT NULL DEFAULT 0']]) {
    if(!columns.some(row=>row.Field===name))await pool.query(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
  }
  const sql=await fs.readFile(path.join(__dirname,'login-schema.sql'),'utf8');
  for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean))await pool.query(statement);
  const db=await pool.getConnection();
  try {
    await db.beginTransaction();
    const [done]=await db.query("SELECT name FROM login_migrations WHERE name='email-otp-v1' FOR UPDATE");
    if(!done.length){
      // Preserve existing Google identities and credentials; new registrations use OTP activation.
      await db.query('UPDATE users SET email_verified_at=CASE WHEN google_id IS NOT NULL THEN COALESCE(email_verified_at,created_at) ELSE email_verified_at END,session_version=session_version+1');
      await db.query("INSERT INTO login_migrations(name) VALUES ('email-otp-v1')");
    }
    const [compatible]=await db.query("SELECT name FROM login_migrations WHERE name='preserve-existing-active-v2' FOR UPDATE");
    if(!compatible.length){
      // Existing active accounts remain usable without falsely marking their email as verified.
      await db.query("UPDATE users u INNER JOIN login_migrations m ON m.name='email-otp-v1' SET u.legacy_active=1 WHERE u.password_hash IS NOT NULL AND u.created_at<=m.applied_at");
      await db.query("INSERT INTO login_migrations(name) VALUES ('preserve-existing-active-v2')");
    }
    await db.commit();
  }catch(error){await db.rollback();throw error;}finally{db.release();}
}
if(require.main===module)migrate().then(()=>console.log('Login migration complete. Accounts, passwords and feedback were preserved.'))
  .catch(error=>{console.error('Login migration failed:',error.code||error.message);process.exitCode=1;}).finally(()=>require('../src/config/db').pool.end());
module.exports={migrate};
