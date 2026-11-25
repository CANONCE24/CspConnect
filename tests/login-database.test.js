'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs/promises');
const path=require('node:path');
const mysql=require('mysql2/promise');
const request=require('supertest');
const {SMTPServer}=require('smtp-server');
require('dotenv').config({quiet:true});
const token=res=>res.text.match(/name="csrf-token" content="([^"]+)"/)[1];
const password='A-real-storage-test-password!';

test('six-digit activation and explicit Google linking with real database and local SMTP', {skip:process.env.TEST_DB!=='1',timeout:120000},async t=>{
  const database='cspc_login_test_'+crypto.randomBytes(8).toString('hex');
  const db=await mysql.createConnection({host:process.env.DB_HOST||'127.0.0.1',port:Number(process.env.DB_PORT||3306),user:process.env.DB_USER||'root',password:process.env.DB_PASSWORD||''});
  let owned=false,pool,transport,smtp;
  try{
    assert.match(database,/^cspc_login_test_[a-f0-9]{16}$/);await db.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);owned=true;await db.changeUser({database});
    const sql=await fs.readFile(path.join(__dirname,'../schema.sql'),'utf8')+'\n'+await fs.readFile(path.join(__dirname,'../seed.sql'),'utf8');
    for(const statement of sql.replace(/^\s*--.*$/gm,'').split(';').map(s=>s.trim()).filter(Boolean))await db.query(statement);
    process.env.DB_NAME=database;pool=require('../src/config/db').pool;
    const store=require('../src/models/store');const {createHash,verifyPassword}=require('../src/services/passwords');
    const hash=await createHash(password);
    await pool.execute("INSERT INTO users(name,email,google_id,password_hash) VALUES ('Legacy Google','legacy@gmail.com','legacy-sub',?)",[hash]);
    await pool.execute("INSERT INTO users(name,email,password_hash) VALUES ('Existing active account','old-active@gmail.com',?)",[hash]);
    const [[legacy]]=await pool.query("SELECT id FROM users WHERE email='legacy@gmail.com'");
    const category=(await store.categories())[0];await pool.execute("INSERT INTO feedback(user_id,category_id,type,title,description,is_published) VALUES (?,?,'Suggestion','Preserved published feedback','The login migration must preserve this existing published record.',1)",[legacy.id,category.id]);
    await t.test('migration preserves Google IDs, passwords, feedback and publication state and is repeatable',async()=>{
      const {migrate}=require('../scripts/migrate-login');await migrate(pool);const user=await store.passwordAccountByEmail('legacy@gmail.com');assert.equal(user.password_hash,hash);assert(user.email_verified_at);const version=user.session_version;
      await migrate(pool);assert.equal((await store.getUser(legacy.id)).session_version,version);
      const [[row]]=await pool.query('SELECT is_published FROM feedback WHERE user_id=?',[legacy.id]);assert.equal(row.is_published,1);
    });
    const received=[];
    smtp=new SMTPServer({disabledCommands:['AUTH','STARTTLS'],onData(stream,_session,callback){let message='';stream.on('data',part=>{message+=part;});stream.on('end',()=>{received.push(message);callback();});}});
    await new Promise(resolve=>smtp.listen(0,'127.0.0.1',resolve));
    const config={nodeEnv:'test',sessionSecret:crypto.randomBytes(48).toString('hex'),allowedEmailDomain:'',adminEmails:[],securityEmails:[],googleClientId:'local-test-client',googleClientSecret:'local-test-secret',googleCallbackUrl:'http://localhost/auth/google/callback',smtpEnabled:true,smtpAllowInsecureLocal:true,smtpHost:'127.0.0.1',smtpPort:smtp.server.address().port,smtpFrom:'sender@example.test',smtpFromName:'CSPConnect'};
    const verification=require('../src/services/email-verification').createEmailVerification(pool,config);
    transport=require('../src/services/feedback-email').createEmailTransport(config);
    const mailer=require('../src/services/email-verification').createVerificationMailer(config,transport);
    const emails=[];
    const claims=new Map();
    const {configurePassport}=require('../src/config/passport');
    const passport=configurePassport(store,config,{verifyGoogleToken:async value=>{assert(claims.has(value));return claims.get(value);}});
    // Only provider exchange is stubbed; state, PKCE, callback routing, sessions and database linking are real.
    passport._strategy('google')._oauth2.getOAuthAccessToken=(code,_params,done)=>done(null,'test-access','test-refresh',{id_token:code});
    const {fixtureApp}=require('./support');
    const fixture=await fixtureApp({store,passport,emailVerification:verification,sendVerificationEmail:async item=>{await mailer(item);emails.push(item);},userIds:{},config});
    const {app}=fixture;
    const register=async(agent,email,status=302)=>{const form=await agent.get('/signup');return agent.post('/auth/signup').send({_csrf:token(form),name:'Verification Test Student',email,password,passwordConfirmation:password}).expect(status);};
    const activate=async(agent,code,status=302)=>{const form=await agent.get('/verify-email');return agent.post('/auth/verify-email').send({_csrf:token(form),code}).expect(status);};
    const google=async(agent,key,payload,landing='/dashboard')=>{claims.set(key,payload);const start=await agent.get('/auth/google').expect(302);const url=new URL(start.headers.location);assert(url.searchParams.get('code_challenge'));assert(url.searchParams.get('scope').includes('openid'));return agent.get('/auth/google/callback').query({state:url.searchParams.get('state'),code:key,email:'forged@example.test',role:'admin'}).expect(302).expect('Location',landing);};
    const student=request.agent(app);const email='registered@gmail.com';let accountId;
    await t.test('existing active password accounts keep their login without new OTP or approval requirements',async()=>{
      const browser=request.agent(app),form=await browser.get('/login'),before=emails.length;
      await browser.post('/auth/login').send({_csrf:token(form),email:'old-active@gmail.com',password}).expect(302).expect('Location','/dashboard');
      await browser.get('/dashboard').expect(200);assert.equal(emails.length,before);
      const user=await store.passwordAccountByEmail('old-active@gmail.com');assert.equal(user.legacy_active,1);assert.equal(user.email_verified_at,null,'Compatibility must not falsely assert email verification');
    });
    await t.test('regular signup sends a six-digit email and remains inactive until the code is verified',async()=>{
      await register(student,email);assert.equal(await store.passwordAccountByEmail(email),null);await student.get('/dashboard').expect(302).expect('Location','/login');
      const item=emails.at(-1);assert.match(item.code,/^\d{6}$/);assert(received.at(-1).includes(item.code));assert(received.at(-1).includes('5 minutes'));
      const [[stored]]=await pool.query('SELECT code_hash,password_hash FROM email_verifications WHERE email=?',[email]);assert.notEqual(stored.code_hash,item.code);assert.match(stored.password_hash,/^\$2b\$12\$/);
      await student.post('/auth/verify-email').send({code:item.code}).expect(403);
      await activate(student,item.code);const user=await store.passwordAccountByEmail(email);accountId=user.id;assert(user.email_verified_at);assert(user.password_verified_at);assert.equal(await verifyPassword(password,user.password_hash),true);
      assert((await verification.verify(item.challenge,item.code)).error,'Code must be single-use');
      const form=await student.get('/dashboard');await student.post('/auth/login').send({_csrf:token(form),email,password}).expect(302).expect('Location','/dashboard');await student.get('/dashboard').expect(200);
      const dashboard=await student.get('/dashboard');await student.post('/logout').send({_csrf:token(dashboard)}).expect(302);
    });
    await t.test('five wrong attempts lock the code, resend waits sixty seconds, and a new code replaces the old one',async()=>{
      const browser=request.agent(app),address='attempts@gmail.com';await register(browser,address);const first=emails.at(-1);const wrong=first.code==='000000'?'111111':'000000';
      for(let count=0;count<5;count++)await activate(browser,wrong,422);
      await activate(browser,first.code,422);assert.equal(await store.passwordAccountByEmail(address),null);
      const [[row]]=await pool.query('SELECT attempts FROM email_verifications WHERE email=?',[address]);assert.equal(row.attempts,5);
      let form=await browser.get('/verify-email');await browser.post('/auth/resend-verification').send({_csrf:token(form)}).expect(429);
      await pool.execute('UPDATE email_verifications SET sent_at=DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 61 SECOND) WHERE email=?',[address]);
      form=await browser.get('/verify-email');await browser.post('/auth/resend-verification').send({_csrf:token(form)}).expect(200);const second=emails.at(-1);assert.notEqual(second.code,first.code);
      await activate(browser,first.code,422);await activate(browser,second.code,302);
    });
    await t.test('five-minute expiry is enforced by the database and pending signups cannot reserve duplicate users',async()=>{
      const browser=request.agent(app),address='expired@gmail.com';await register(browser,address);const item=emails.at(-1);
      const [[row]]=await pool.query('SELECT TIMESTAMPDIFF(SECOND,sent_at,expires_at) AS lifetime FROM email_verifications WHERE email=?',[address]);assert.equal(row.lifetime,300);
      await pool.execute('UPDATE email_verifications SET expires_at=DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE email=?',[address]);await activate(browser,item.code,422);assert.equal(await store.passwordAccountByEmail(address),null);
      await register(request.agent(app),email,409);const [[count]]=await pool.query('SELECT COUNT(*) AS total FROM users WHERE email=?',[email]);assert.equal(count.total,1);
    });
    await t.test('new and returning Google identities enter the dashboard without verification codes or approval gates',async()=>{
      const browser=request.agent(app),before=emails.length;
      const payload={sub:'new-google-subject',email:'google-only@gmail.com',email_verified:true,name:'Google Test Student'};
      await google(browser,'google-first',payload);await browser.get('/dashboard').expect(200);assert.equal(emails.length,before);
      const user=await store.passwordAccountByEmail(payload.email);assert.equal(user.google_id,payload.sub);assert.equal(user.password_hash,null);assert.equal(user.role,'student');
      await google(browser,'google-return',payload);assert.equal((await store.passwordAccountByEmail(payload.email)).id,user.id);assert.equal(emails.length,before);
    });
    await t.test('an email match requires explicit password confirmation before linking and retains one account and its history',async()=>{
      const browser=request.agent(app),payload={sub:'google-for-existing-account',email,email_verified:true,name:'Verified Google Student'};
      await google(browser,'existing-email',payload,'/auth/google/link');assert.equal((await store.passwordAccountByEmail(email)).google_id,null);await browser.get('/dashboard').expect(302).expect('Location','/login');
      const form=await browser.get('/auth/google/link').expect(200),nonce=form.text.match(/name="nonce" value="([^"]+)"/)[1];
      await browser.post('/auth/google/link').send({nonce,password,confirm:'1'}).expect(403);
      await browser.post('/auth/google/link').send({_csrf:token(form),nonce,password}).expect(422);
      await browser.post('/auth/google/link').send({_csrf:token(form),nonce,password:'Wrong-existing-password!',confirm:'1'}).expect(422);
      assert.equal((await store.passwordAccountByEmail(email)).google_id,null);
      await browser.post('/auth/google/link').send({_csrf:token(form),nonce,password,confirm:'1',accountId:legacy.id,googleId:'forged-subject',email:'forged@gmail.com'}).expect(302).expect('Location','/dashboard');
      const linked=await store.passwordAccountByEmail(email);assert.equal(linked.id,accountId);assert.equal(linked.google_id,payload.sub);assert.equal((await store.passwordAccountByEmail('legacy@gmail.com')).google_id,'legacy-sub');
      const [[count]]=await pool.query('SELECT COUNT(*) AS total FROM users WHERE email=?',[email]);assert.equal(count.total,1);
      const dashboard=await browser.get('/dashboard');await browser.post('/auth/google/link').send({_csrf:token(dashboard),nonce,password,confirm:'1'}).expect(302);
    });
    await t.test('SMTP failure does not activate an account or expose the verification code',async()=>{
      const broken=await fixtureApp({store,emailVerification:verification,sendVerificationEmail:async()=>{throw Object.assign(new Error('Simulated local outage'),{code:'ECONNREFUSED'});},userIds:{},config});
      const browser=request.agent(broken.app);const response=await register(browser,'smtp-failed@gmail.com',503);assert(response.text.includes('could not send'));assert.equal(await store.passwordAccountByEmail('smtp-failed@gmail.com'),null);
    });
    await t.test('legacy scrypt email sign-in is upgraded only after OTP ownership proof',async()=>{
      const salt=crypto.randomBytes(16),key=crypto.scryptSync(password,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024});
      const legacyHash=`scrypt$32768$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`;
      const [insert]=await pool.execute("INSERT INTO users(name,email,password_hash) VALUES ('Legacy Email','legacy-email@gmail.com',?)",[legacyHash]);
      const fresh=await fixtureApp({store,emailVerification:verification,sendVerificationEmail:async item=>{await mailer(item);emails.push(item);},userIds:{},config});
      const browser=request.agent(fresh.app),form=await browser.get('/login');await browser.post('/auth/login').send({_csrf:token(form),email:'legacy-email@gmail.com',password}).expect(302).expect('Location','/verify-email');
      assert.equal((await store.passwordAccountByEmail('legacy-email@gmail.com')).password_hash,legacyHash);
      await activate(browser,emails.at(-1).code);const user=await store.passwordAccountByEmail('legacy-email@gmail.com');assert.equal(user.id,insert.insertId);assert.match(user.password_hash,/^\$2b\$12\$/);
    });
    await t.test('concurrent bad guesses cannot exceed the five-attempt budget or activate an account',async()=>{
      const item=await verification.issue({email:'parallel@gmail.com',name:'Parallel test',passwordHash:hash});
      const wrong=item.code==='000000'?'111111':'000000';
      await Promise.all(Array.from({length:12},()=>verification.verify(item.challenge,wrong)));
      const [[row]]=await pool.query('SELECT attempts FROM email_verifications WHERE email=?',[item.email]);assert.equal(row.attempts,5);assert((await verification.verify(item.challenge,item.code)).error);assert.equal(await store.passwordAccountByEmail(item.email),null);
    });
    await t.test('Google linking proof expires and cannot be used from another browser session',async()=>{
      const isolated=await fixtureApp({store,passport,emailVerification:verification,userIds:{},config});
      const browser=request.agent(isolated.app),payload={sub:'expires-google-subject',email:'attempts@gmail.com',email_verified:true,name:'Google owner'};
      await google(browser,'expiring-link',payload,'/auth/google/link');const page=await browser.get('/auth/google/link');const nonce=page.text.match(/name="nonce" value="([^"]+)"/)[1];
      const other=request.agent(isolated.app),otherPage=await other.get('/login');await other.post('/auth/google/link').send({_csrf:token(otherPage),nonce,password,confirm:'1'}).expect(302).expect('Location','/login');
      const sessions=await new Promise((resolve,reject)=>isolated.sessionStore.all((error,values)=>error?reject(error):resolve(values)));
      for(const [id,data] of Object.entries(sessions))if(data.pendingGoogleLink?.googleId===payload.sub){data.pendingGoogleLink.expiresAt=Date.now()-1;await new Promise((resolve,reject)=>isolated.sessionStore.set(id,data,error=>error?reject(error):resolve()));}
      await browser.post('/auth/google/link').send({_csrf:token(page),nonce,password,confirm:'1'}).expect(302).expect('Location','/login');assert.equal((await store.passwordAccountByEmail(payload.email)).google_id,null);
    });
  }finally{
    transport?.close();if(smtp)await new Promise(resolve=>smtp.close(resolve));if(pool)await pool.end();if(owned)await db.query(`DROP DATABASE \`${database}\``);await db.end();
  }
});
