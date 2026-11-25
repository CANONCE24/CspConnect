'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');
const request = require('supertest');
require('dotenv').config({quiet:true});
const csrf = response => response.text.match(/name="csrf-token" content="([^"]+)"/)[1];
const password = 'Verified-affiliation-test-password!';
test('affiliation authentication, preservation and authorization with real MySQL', {skip:process.env.TEST_DB!=='1',timeout:120000}, async t => {
  const database = 'cspc_affiliation_test_' + crypto.randomBytes(8).toString('hex');
  const db = await mysql.createConnection({host:process.env.DB_HOST||'127.0.0.1',port:Number(process.env.DB_PORT||3306),user:process.env.DB_USER||'root',password:process.env.DB_PASSWORD||''});
  let owned = false, pool;
  const previousDatabase = process.env.DB_NAME;
  try {
    assert.match(database,/^cspc_affiliation_test_[a-f0-9]{16}$/);
    await db.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`); owned = true;
    await db.changeUser({database});
    const sql = await fs.readFile(path.join(__dirname,'../schema.sql'),'utf8') + '\n' + await fs.readFile(path.join(__dirname,'../seed.sql'),'utf8');
    for (const statement of sql.replace(/^\s*--.*$/gm,'').split(';').map(value=>value.trim()).filter(Boolean)) await db.query(statement);
    process.env.DB_NAME = database;
    pool = require('../src/config/db').pool;
    const store = require('../src/models/store');
    const {createHash} = require('../src/services/passwords');
    const hash = await createHash(password);
    const domains = ['cspc.edu.ph','my.cspc.edu.ph'];
    const adminEmail = 'existing.admin@my.cspc.edu.ph';
    const config = {nodeEnv:'test',cspcEmailDomains:domains,adminEmails:[adminEmail],securityEmails:[],googleClientId:'affiliation-test-client',googleClientSecret:'test-secret',googleCallbackUrl:'http://localhost/auth/google/callback'};
    const claims = new Map();
    const passport = require('../src/config/passport').configurePassport(store,config,{verifyGoogleToken:async key=>claims.get(key)});
    passport._strategy('google')._oauth2.getOAuthAccessToken = (code,_params,done)=>done(null,'local-access','local-refresh',{id_token:code});
    const verification = require('../src/services/email-verification').createEmailVerification(pool,{sessionSecret:'affiliation-verification-secret-at-least-32-characters'});
    const codes = [];
    let app;
    // Independent scenarios get fresh session and rate-limit stores, retaining production limits.
    t.beforeEach(async()=>{
      ({app} = await require('./support').fixtureApp({store,passport,emailVerification:verification,sendVerificationEmail:async item=>codes.push(item),userIds:{},config}));
    });
    const google = async (browser,key,payload,landing='/dashboard') => {
      claims.set(key,payload);
      const start = await browser.get('/auth/google').expect(302), url = new URL(start.headers.location);
      return browser.get('/auth/google/callback').query({code:key,state:url.searchParams.get('state'),email_verified:true,affiliation:'Staff',role:'admin'}).expect(302).expect('Location',landing);
    };
    const choose = async (browser,affiliation,landing='/dashboard') => {
      const form = await browser.get('/complete-profile').expect(200);
      assert(!form.text.includes('value="Visitor"'));
      return browser.post('/complete-profile').send({_csrf:csrf(form),affiliation,role:'admin',email:'forged@cspc.edu.ph'}).expect(302).expect('Location',landing);
    };
    const login = async (browser,email,landing='/dashboard') => {
      const form = await browser.get('/login');
      return browser.post('/auth/login').send({_csrf:csrf(form),email,password}).expect(302).expect('Location',landing);
    };
    const signup = async (browser,email,landing) => {
      const form = await browser.get('/signup');
      await browser.post('/auth/signup').send({_csrf:csrf(form),name:'Affiliation Test',email,password,passwordConfirmation:password,role:'admin',affiliation:'Faculty'}).expect(302).expect('Location','/verify-email');
      assert.equal(await store.passwordAccountByEmail(email.toLowerCase()),null);
      const otp = await browser.get('/verify-email');
      await browser.post('/auth/verify-email').send({_csrf:csrf(otp),code:codes.at(-1).code,role:'admin',affiliation:'Faculty'}).expect(302).expect('Location',landing);
    };
    await t.test('additive migration is repeatable and preserves every existing account field',async()=>{
      await db.execute("INSERT INTO users(name,email,password_hash,role,email_verified_at,password_verified_at) VALUES ('Existing administrator',?,?,'admin',NOW(3),NOW(3))",[adminEmail,hash]);
      const [before] = await db.query('SELECT * FROM users');
      // Only the newly owned test database simulates an older schema.
      await db.query('ALTER TABLE users DROP COLUMN affiliation,DROP COLUMN affiliation_email');
      const {migrate} = require('../scripts/migrate-affiliation');
      await migrate(pool); await migrate(pool);
      const [after] = await db.query('SELECT * FROM users');
      assert.deepEqual(after,before);
    });
    await t.test('verified CSPC Google users choose once; invalid choices, CSRF bypass and role escalation fail',async()=>{
      for (const [index,affiliation] of ['Student','Faculty','Staff'].entries()) {
        const browser = request.agent(app), email = `google.${index}@${index===1?'MY.CSPC.EDU.PH':'cspc.edu.ph'}`;
        const payload = {sub:'campus-'+index,email,email_verified:true,name:'Campus User'};
        await google(browser,'campus-first-'+index,payload,'/complete-profile');
        await browser.get('/dashboard').expect(302).expect('Location','/complete-profile');
        await browser.get('/api/notifications/unread').expect(403);
        const form = await browser.get('/complete-profile').expect(200);
        await browser.post('/complete-profile').send({affiliation}).expect(403);
        for (const value of ['Visitor','Administrator','admin','student','']) await browser.post('/complete-profile').send({_csrf:csrf(form),affiliation:value}).expect(422);
        assert.equal((await store.passwordAccountByEmail(email)).affiliation,null);
        await choose(browser,affiliation);
        const user = await store.passwordAccountByEmail(email);
        assert.equal(user.affiliation,affiliation); assert.equal(user.role,'student');
        await browser.get('/dashboard').expect(200); await browser.get('/admin').expect(403);
        await browser.get('/complete-profile').expect(302).expect('Location','/dashboard');
        const dashboard = await browser.get('/dashboard');
        await browser.post('/complete-profile').send({_csrf:csrf(dashboard),affiliation:affiliation==='Student'?'Staff':'Student'}).expect(409);
        await google(browser,'campus-return-'+index,payload);
        assert.equal((await store.passwordAccountByEmail(email)).id,user.id);
      }
    });
    await t.test('CSPC email OTP activates, signs in and requires the same profile choice',async()=>{
      const browser = request.agent(app), email = 'otp.faculty@my.cspc.edu.ph';
      await signup(browser,email,'/complete-profile');
      const before = await store.passwordAccountByEmail(email);
      assert(before.email_verified_at); assert.equal(before.affiliation,null); assert.equal(before.role,'student');
      await choose(browser,'Faculty');
      assert.equal((await store.passwordAccountByEmail(email)).password_hash,before.password_hash);
      const dashboard = await browser.get('/dashboard'); await browser.post('/logout').send({_csrf:csrf(dashboard)}).expect(302);
      await login(browser,email); await browser.get('/account').expect(200).expect(/Faculty/);
    });
    await t.test('Gmail, Yahoo, Outlook, other domains and lookalike domains become Visitors through Google and OTP',async()=>{
      for (const [index,domain] of ['gmail.com','yahoo.com','outlook.com','example.net','cspc.edu.ph.attacker.com','dept.cspc.edu.ph'].entries()) {
        const browser = request.agent(app), email = `google.visitor@${domain}`;
        await google(browser,'visitor-'+index,{sub:'visitor-'+index,email,email_verified:true});
        assert.equal((await store.passwordAccountByEmail(email)).affiliation,'Visitor');
        await browser.get('/complete-profile').expect(302).expect('Location','/dashboard');
        const form = await browser.get('/account');
        await browser.post('/complete-profile').send({_csrf:csrf(form),affiliation:'Staff',email:'fake@cspc.edu.ph'}).expect(403);
        if (index<4) {
          const passwordBrowser=request.agent(app), address=`otp.visitor@${domain}`;
          await signup(passwordBrowser,address,'/dashboard');
          const user = await store.passwordAccountByEmail(address);
          assert.equal(user.affiliation,'Visitor'); assert.equal(user.role,'student');
        }
      }
    });
    await t.test('unverified identities cannot assign affiliation, including legacy accounts',async()=>{
      const browser = request.agent(app);
      await google(browser,'unverified',{sub:'unverified',email:'unverified@my.cspc.edu.ph',email_verified:false},'/login');
      assert.equal(await store.passwordAccountByEmail('unverified@my.cspc.edu.ph'),null);
      const user = await store.createPasswordAccount({name:'Legacy Unverified',email:'legacy@cspc.edu.ph',passwordHash:hash});
      await pool.execute('UPDATE users SET legacy_active=1 WHERE id=?',[user.id]);
      assert.equal((await store.ensureAffiliation(user.id,domains)).affiliation,null);
      await assert.rejects(store.ensureAffiliation(user.id,domains,'Staff'),{status:403});
      await login(browser,'legacy@cspc.edu.ph');
      await browser.get('/complete-profile').expect(403);
      const page = await browser.get('/dashboard');
      await browser.post('/complete-profile').send({_csrf:csrf(page),affiliation:'Faculty'}).expect(403);
      const saved = await store.getUser(user.id); assert.equal(saved.email_verified_at,null); assert.equal(saved.affiliation,null);
    });
    await t.test('existing administrators keep permissions and credentials; affiliation never promotes a new Google account',async()=>{
      const browser = request.agent(app), before = await store.passwordAccountByEmail(adminEmail);
      await login(browser,adminEmail,'/complete-profile'); await choose(browser,'Staff','/admin');
      await browser.get('/admin').expect(200);
      const saved = await store.passwordAccountByEmail(adminEmail);
      assert.equal(saved.id,before.id); assert.equal(saved.password_hash,before.password_hash); assert.equal(saved.role,'admin');
      const fresh = await store.upsertGoogleUser({id:'allowlisted-but-unprovisioned',displayName:'New User',emails:[{value:'new.admin@cspc.edu.ph',verified:true}]},['new.admin@cspc.edu.ph']);
      assert.equal(fresh.role,'student');
    });
    await t.test('existing verified external accounts become Visitors without changing their password or account',async()=>{
      const [insert] = await pool.execute("INSERT INTO users(name,email,password_hash,email_verified_at,password_verified_at) VALUES ('Existing visitor','existing@outlook.com',?,NOW(3),NOW(3))",[hash]);
      const browser=request.agent(app);
      await login(browser,'existing@outlook.com');
      const saved=await store.passwordAccountByEmail('existing@outlook.com');
      assert.equal(saved.id,insert.insertId); assert.equal(saved.password_hash,hash); assert.equal(saved.affiliation,'Visitor');
      await browser.get('/complete-profile').expect(302).expect('Location','/dashboard');
    });
    await t.test('concurrent selections save once and existing valid affiliations are retained',async()=>{
      const user=await store.upsertGoogleUser({id:'concurrent-affiliation',displayName:'Concurrent User',emails:[{value:'concurrent@cspc.edu.ph',verified:true}]});
      const results=await Promise.allSettled(['Faculty','Staff'].map(choice=>store.ensureAffiliation(user.id,domains,choice)));
      assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
      assert.equal(results.find(result=>result.status==='rejected').reason.status,409);
      const saved=await store.getUser(user.id);
      await Promise.all([store.ensureAffiliation(user.id,domains,saved.affiliation),store.ensureAffiliation(user.id,domains,saved.affiliation)]);
      await pool.execute('UPDATE users SET affiliation_email=NULL WHERE id=?',[user.id]);
      const retained=await store.ensureAffiliation(user.id,domains);
      assert.equal(retained.affiliation,saved.affiliation); assert.equal(retained.affiliation_email,saved.email);
    });
    await t.test('a newly verified Google email reclassifies the same account and invalidates old session and recovery proofs',async()=>{
      const browser = request.agent(app), sub='changing-subject';
      await google(browser,'changed-1',{sub,email:'before@cspc.edu.ph',email_verified:true},'/complete-profile'); await choose(browser,'Staff');
      const before = await store.passwordAccountByEmail('before@cspc.edu.ph');
      const oldSession=request.agent(app);
      await google(oldSession,'changed-old-session',{sub,email:'before@cspc.edu.ph',email_verified:true});
      const security=require('../src/services/account-security').createAccountSecurity(pool,config);
      const recovery=await security.issue('before@cspc.edu.ph','reset');
      assert(await security.inspect(recovery.token,'reset'));
      await google(browser,'changed-2',{sub,email:'after@yahoo.com',email_verified:true});
      const after = await store.passwordAccountByEmail('after@yahoo.com');
      assert.equal(after.id,before.id); assert.equal(after.affiliation,'Visitor'); assert.equal(after.session_version,before.session_version+1);
      assert.equal(await store.passwordAccountByEmail('before@cspc.edu.ph'),null);
      assert.equal(await security.inspect(recovery.token,'reset'),false);
      await oldSession.get('/dashboard').expect(302).expect('Location','/login');
      await google(browser,'changed-3',{sub,email:'returned@my.cspc.edu.ph',email_verified:true},'/complete-profile');
      assert.equal((await store.getUser(before.id)).affiliation,null); await choose(browser,'Faculty');
    });
    await t.test('admin affiliation filtering uses accurate combined counts and public DTOs omit the field',async()=>{
      const users = [];
      for (const affiliation of ['Student','Faculty','Staff','Visitor']) {
        const email = affiliation==='Visitor'?'google.visitor@gmail.com':`filter.${affiliation.toLowerCase()}@cspc.edu.ph`;
        let user = await store.passwordAccountByEmail(email);
        if (!user) user = await store.upsertGoogleUser({id:'filter-'+affiliation,displayName:'Filter User',emails:[{value:email,verified:true}]});
        await store.ensureAffiliation(user.id,domains,affiliation==='Visitor'?undefined:affiliation); users.push(user);
      }
      const category = (await store.categories())[0];
      const admin = await store.passwordAccountByEmail(adminEmail);
      for (const user of users) {
        const entry = await store.submit(user.id,{type:'Suggestion',categoryId:category.id,title:'Affiliation filter submission',description:'A test submission for combined affiliation filtering.',isAnonymous:true});
        await store.publish(entry.id,true,admin.id);
      }
      for (const affiliation of ['Student','Faculty','Staff','Visitor']) {
        const result = await store.listFeedback({affiliation,categoryId:category.id,type:'Suggestion',status:'Submitted',search:'Affiliation filter',visibility:'published',page:99,limit:1});
        assert.equal(result.total,1); assert.equal(result.page,1); assert.equal(result.items[0].author_affiliation,affiliation);
      }
      const publicRows = await store.listFeedback({publicOnly:true});
      assert(publicRows.items.every(row=>!Object.hasOwn(row,'author_affiliation')&&!Object.hasOwn(row,'author_email')));
      const summary = await store.analytics(); assert.equal(summary.byAffiliation.reduce((total,row)=>total+row.count,0),summary.total);
      await assert.rejects(store.listFeedback({affiliation:"Staff' OR 1=1"}),/Invalid affiliation/);
    });
  } finally {
    if (pool) await pool.end();
    if (owned) await db.query(`DROP DATABASE \`${database}\``);
    await db.end();
    if (previousDatabase===undefined) delete process.env.DB_NAME; else process.env.DB_NAME=previousDatabase;
  }
});
