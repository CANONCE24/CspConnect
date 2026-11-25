'use strict';
require('dotenv').config({quiet:true});
const crypto=require('node:crypto');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {pool}=require('../src/config/db');
const tables=['users','categories','feedback','feedback_status_history','feedback_responses','feedback_reactions','feedback_comments','emergency_reports','emergency_history','emergency_settings','emergency_settings_history','feedback_email_outbox','feedback_email_attempts','feedback_email_retries'];
async function snapshot(){
  const result={};
  for(const table of tables){
    const columns=table==='users'?'id,google_id,name,email,password_hash,must_change_password,avatar_url,role,created_at':'*';
    const [rows]=await pool.query(`SELECT ${columns} FROM ${table} ORDER BY id`);
    result[table]={count:rows.length,sha256:crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex')};
  }
  return result;
}
async function main(){
  const backup=await require('./backup-local-db').backup();
  const before=await snapshot();
  await require('./migrate-login').migrate(pool);
  const after=await snapshot();
  assert.deepEqual(after,before,'Existing account credentials and application records must be preserved.');
  const record={checkedAt:new Date().toISOString(),backup,result:'passed',preserved:after};
  await fs.writeFile(path.resolve(__dirname,'../.local/login-migration-verification.json'),JSON.stringify(record,null,2));
  console.log('Login migration applied. Existing accounts, password hashes, feedback, publication state and histories match the pre-migration snapshot.');
}
if(require.main===module)main().catch(error=>{console.error('Login update failed:',error.code||error.message);process.exitCode=1;}).finally(()=>pool.end());
