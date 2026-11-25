'use strict';
require('dotenv').config({quiet:true});
const fs=require('node:fs/promises');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
async function backup() {
  const database=process.env.DB_NAME;
  if(!/^cspc_[a-z0-9_]+$/.test(database || '') || !['127.0.0.1','localhost','::1'].includes(process.env.DB_HOST || '127.0.0.1'))throw new Error('Backup supports the configured local CSPC database only.');
  const directory=path.resolve(__dirname,'../.local/backups');await fs.mkdir(directory,{recursive:true});
  const filename=path.join(directory,`${database}-before-security-${new Date().toISOString().replace(/[:.]/g,'-')}.sql`);
  const executable=process.env.MYSQLDUMP_BIN || path.join(process.env.LOCAL_MYSQL_BIN || 'C:/xampp/mysql/bin','mysqldump.exe');
  await promisify(execFile)(executable,['--no-defaults',`--host=${process.env.DB_HOST || '127.0.0.1'}`,`--port=${process.env.DB_PORT || 3306}`,`--user=${process.env.DB_USER || 'root'}`,'--single-transaction','--skip-lock-tables','--hex-blob',`--result-file=${filename}`,database],{env:{...process.env,MYSQL_PWD:process.env.DB_PASSWORD || ''},windowsHide:true});
  const content=await fs.readFile(filename,'utf8');if(!content.includes('Dump completed on') || !content.includes('CREATE TABLE `users`'))throw new Error('Backup verification failed.');
  console.log('Database backup verified: '+filename);return filename;
}
if(require.main===module)backup().catch(error=>{console.error('Backup failed:',error.code || error.message);process.exitCode=1;});
module.exports={backup};
