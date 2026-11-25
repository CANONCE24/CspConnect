'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const request = require('supertest');
const mysql = require('mysql2/promise');
const { SMTPServer } = require('smtp-server');
require('dotenv').config({ quiet:true });
test('feedback emails: real database transactions, local SMTP, retries, privacy, and browser workflows', {skip:process.env.TEST_DB !== '1',timeout:120000}, async t => {
  const database = 'cspc_email_test_' + randomBytes(8).toString('hex');
  const connection = await mysql.createConnection({host:process.env.DB_HOST||'127.0.0.1',port:Number(process.env.DB_PORT||3306),user:process.env.DB_USER||'root',password:process.env.DB_PASSWORD||'',multipleStatements:false});
  const previous = process.env.DB_NAME;
  let pool, smtp, web, browser, worker;
  const messages = [], flags = { unavailable:false };
  try {
    await connection.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await connection.changeUser({database});
    const sql = (await fs.readFile(path.join(__dirname,'../schema.sql'),'utf8')) + '\n' + await fs.readFile(path.join(__dirname,'../seed.sql'),'utf8');
    for (const statement of sql.replace(/^\s*--.*$/gm,'').split(';').map(s=>s.trim()).filter(Boolean)) await connection.query(statement);
    process.env.DB_NAME = database;
    pool = require('../src/config/db').pool;
    const store = require('../src/models/store');
    const { createHash } = require('../src/services/passwords');
    const password = 'Email-test-password-2026!';
    const hash = await createHash(password);
    for (const [id,name,email,role] of [[841,'Email Student','private-student@example.test','student'],[842,'Email Administrator','admin@example.test','admin'],[843,'Other Student','another@example.test','student'],[844,'Security','guard@example.test','security']]) await pool.execute('INSERT INTO users (id,name,email,role,password_hash,email_verified_at,password_verified_at) VALUES (?,?,?,?,?,CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3))',[id,name,email,role,hash]);
    const {createEmailOutbox} = require('../src/models/email-outbox');
    const outbox = createEmailOutbox(pool);
    const {fixtureApp} = require('./support');
    const fixture = await fixtureApp({store,emailOutbox:outbox,userIds:{owner:841,admin:842,other:843,guard:844},config:{securityEmails:['guard@example.test']}});
    const {app,cookies,csrfToken} = fixture;
    const admin = await store.getUser(842), student = await store.getUser(841);
    const values = {type:'Suggestion',categoryId:(await store.categories())[0].id,title:'Improve the campus study space',description:'Please improve the study space lighting and seating.'};
    const make = () => store.submit(student.id,values);
    const post = (id,status,fields={}) => request(app).post('/admin/feedback/'+id+'/status').set('Cookie',cookies.admin).send({
      _csrf:csrfToken,status,request_key:randomUUID(),confirmed:'1',notificationMethod:'both',response:'The administration has reviewed the submission and recorded this update.',
      actionTaken:'The broken lighting was replaced and its operation checked.',actionConfirmed:'1',closureReason:'The request duplicates an existing campus improvement project.',...fields});
    let report;
    await t.test('status update queues once, repeated saves and request-key replay do not duplicate',async()=>{
      report = await make(); const key=randomUUID();
      const results=await Promise.all([store.updateStatus(report.id,'Under Review',admin.id,{requestKey:key}),store.updateStatus(report.id,'Under Review',admin.id,{requestKey:key})]);
      assert.equal(results.filter(row=>row.changed).length,1);
      assert.equal((await outbox.list(admin,{feedbackId:report.id})).items.length,1);
      await store.updateStatus(report.id,'In Progress',admin.id);
      assert.equal((await store.updateStatus(report.id,'Under Review',admin.id,{requestKey:key})).changed,false);
      assert.equal((await store.detail(report.id,{userId:student.id})).status,'In Progress');
    });
    await t.test('removed feedback statuses are refused and closure queues automatically',async()=>{
      const item=await make();
      await post(item.id,'Acknowledged').expect(422);
      await post(item.id,'Rejected').expect(422);
      await post(item.id,'Closed').expect(302);
      assert.equal((await store.detail(item.id,{userId:student.id})).status,'Closed');
      assert.equal((await outbox.list(admin,{feedbackId:item.id})).items.length,1);
    });
    smtp = new SMTPServer({authOptional:true,disabledCommands:['AUTH','STARTTLS'],logger:false,
      onRcptTo(_address,_session,callback){if(flags.unavailable){const error=new Error('Temporary testing failure');error.responseCode=450;return callback(error);}callback();},
      onData(stream,_session,callback){const chunks=[];stream.on('data',chunk=>chunks.push(chunk));stream.on('end',()=>{messages.push(Buffer.concat(chunks).toString('utf8'));callback();});}
    });
    await new Promise(resolve=>smtp.listen(0,'127.0.0.1',resolve));
    const emailConfig={nodeEnv:'test',smtpEnabled:true,smtpHost:'127.0.0.1',smtpPort:smtp.server.address().port,smtpSecure:false,smtpAllowInsecureLocal:true,smtpFrom:'notifications@example.test',smtpFromName:'CSPConnect Team',appUrl:'http://localhost:3000'};
    const {createEmailWorker}=require('../src/services/email-worker');
    worker=createEmailWorker({outbox,config:emailConfig});
    await t.test('actual local SMTP handoff includes multipart HTML/text and records acceptance',async()=>{
      assert.equal(await worker.tick(),true); while(await worker.tick()) {} assert.equal(messages.length,3);
      assert.match(messages[0],/multipart\/alternative/); assert.match(messages[0],/text\/plain/); assert.match(messages[0],/text\/html/);
      const row=(await outbox.list(admin,{feedbackId:report.id})).items[0];
      assert.equal(row.state,'Sent'); assert.ok(row.accepted_at); assert.equal(row.attempts[0].outcome,'Accepted');
      await assert.rejects(outbox.retry(admin,row.id),{status:409});
    });
    await t.test('approved responses and action details stay private; all statuses queue concise email updates',async()=>{
      const summary='Installed brighter lighting and repaired the desks.';
      await post(report.id,'Resolved',{response:summary,actionTaken:summary}).expect(302);
      const detail=await store.detail(report.id,{userId:student.id}); assert.ok(detail.resolved_at); assert.equal(detail.responses.at(-1).body,summary);
      await worker.tick(); assert.equal(messages.length,4);assert.ok(!messages.at(-1).includes('Installed brighter'));
      const closed=await make();await post(closed.id,'Closed').expect(302);
      await worker.tick(); assert.equal(messages.length,5);
      const allStatuses=await make();
      for(const status of ['Under Review','In Progress','Resolved','Closed','Submitted']) {
        await post(allStatuses.id,status).expect(302);await worker.tick();
        const [[row]]=await pool.execute('SELECT payload_json FROM feedback_email_outbox WHERE feedback_id=? ORDER BY created_at DESC LIMIT 1',[allStatuses.id]);
        const payload=typeof row.payload_json==='string'?JSON.parse(row.payload_json):row.payload_json;assert.equal(payload.status,status);assert.ok(payload.response);assert.equal(payload.concise,true);
      }
      const own=await request(app).get('/feedback/'+report.id).set('Cookie',cookies.owner).expect(200);assert.ok(own.text.includes(summary));
      await request(app).get('/feedback/'+report.id).set('Cookie',cookies.other).expect(404);
      await store.publish(report.id,true,admin.id);
      const publicRecord=await store.detail(report.id,{publicOnly:true});assert.deepEqual(publicRecord.history,[]);assert.ok(!JSON.stringify(publicRecord).includes(summary));
      await assert.rejects(outbox.list(student),{status:403});
      await request(app).get('/admin/notifications').set('Cookie',cookies.owner).expect(403);
      await request(app).get('/admin/notifications').set('Cookie',cookies.guard).expect(403);
    });
    await t.test('response-only updates notify once, repeat saves are harmless, and invalid responses do not commit',async()=>{
      const item=await make(),key=randomUUID(),response='The administration has received your request.';
      const results=await Promise.all([store.updateStatus(item.id,'Submitted',admin.id,{requestKey:key,response}),store.updateStatus(item.id,'Submitted',admin.id,{requestKey:key,response})]);
      assert.equal(results.filter(row=>row.changed).length,1);
      let detail=await store.detail(item.id,{userId:student.id});assert.equal(detail.responses.length,1);assert.equal(detail.status,'Submitted');
      assert.equal((await outbox.list(admin,{feedbackId:item.id})).items.length,1);
      await worker.tick();
      assert.equal((await store.updateStatus(item.id,'Submitted',admin.id)).changed,false);
      await post(item.id,'Resolved',{response:'x'.repeat(5001)}).expect(422);
      await post(item.id,'Resolved',{response:{bad:'value'}}).expect(422);
      detail=await store.detail(item.id,{userId:student.id});assert.equal(detail.status,'Submitted');assert.equal(detail.responses.length,1);
      assert.equal((await outbox.list(admin,{feedbackId:item.id})).items.length,1);
    });
    await t.test('status and outbox roll back together if creating the notification fails',async()=>{
      const item=await make(); const key=randomUUID();
      await connection.query("CREATE TRIGGER email_test_fail BEFORE INSERT ON feedback_email_outbox FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Injected outbox failure'");
      try { await assert.rejects(store.updateStatus(item.id,'Under Review',admin.id,{requestKey:key,response:'This must roll back with the status.'})); }
      finally { await connection.query('DROP TRIGGER email_test_fail'); }
      const detail=await store.detail(item.id,{userId:student.id});assert.equal(detail.status,'Submitted');assert.equal(detail.history.length,1);assert.equal(detail.responses.length,0);
    });
    await t.test('temporary SMTP outage queues retry and preserves committed status',async()=>{
      const item=await make();await store.updateStatus(item.id,'Under Review',admin.id);
      flags.unavailable=true; await worker.tick(); flags.unavailable=false;
      let row=(await outbox.list(admin,{feedbackId:item.id})).items[0];assert.equal(row.state,'Pending');assert.equal(row.attempt_count,1);assert.equal(row.last_error,'SMTP450');
      assert.equal((await store.detail(item.id,{userId:student.id})).status,'Under Review');
      const before=messages.length;await worker.tick();assert.equal(messages.length,before);
      await pool.execute('UPDATE feedback_email_outbox SET next_attempt_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE id=?',[row.id]);
      await worker.tick();row=(await outbox.list(admin,{feedbackId:item.id})).items[0];assert.equal(row.state,'Sent');assert.equal(row.attempt_count,2);
    });
    await t.test('invalid recipient does not roll back status and can be retried after account correction',async()=>{
      await pool.execute('UPDATE users SET email=? WHERE id=841',['not-an-address']);
      const item=await make(); await store.updateStatus(item.id,'Under Review',admin.id);
      let row=(await outbox.list(admin,{feedbackId:item.id})).items[0];assert.equal(row.state,'Failed');assert.equal(row.last_error,'InvalidRecipient');assert.equal(row.attempt_count,0);
      await assert.rejects(outbox.retry(admin,row.id),{status:422});
      await pool.execute('UPDATE users SET email=? WHERE id=841',[student.email]);
      await outbox.retry(admin,row.id);await worker.tick();row=(await outbox.list(admin,{feedbackId:item.id})).items[0];assert.equal(row.state,'Sent');
    });
    await t.test('worker claims are exclusive, expired sends require confirmation, and manual retries are audited',async()=>{
      const item=await make();await store.updateStatus(item.id,'Under Review',admin.id);
      const claims=await Promise.all([outbox.claim(),outbox.claim()]);assert.equal(claims.filter(Boolean).length,1);
      const row=claims.find(Boolean); await pool.execute('UPDATE feedback_email_outbox SET lease_expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE id=?',[row.id]);
      await outbox.recover();await assert.rejects(outbox.retry(admin,row.id),{status:422});
      await outbox.retry(admin,row.id,true);
      const [[retries]]=await pool.query('SELECT COUNT(*) AS total FROM feedback_email_retries WHERE notification_id=?',[row.id]);assert.equal(retries.total,1);
      await worker.tick();assert.equal((await outbox.list(admin,{feedbackId:item.id})).items[0].state,'Sent');
    });
    await t.test('missing recipient preserves the change and temporary retries stop after five attempts',async()=>{
      await pool.execute("UPDATE users SET email='' WHERE id=841");
      const missing=await make();await store.updateStatus(missing.id,'Under Review',admin.id);
      const failed=(await outbox.list(admin,{feedbackId:missing.id})).items[0];
      assert.equal(failed.state,'Failed');assert.equal(failed.last_error,'InvalidRecipient');
      await pool.execute('UPDATE users SET email=? WHERE id=841',[student.email]);
      const item=await make();await store.updateStatus(item.id,'Under Review',admin.id);
      let notification;
      for(let attempt=1;attempt<=5;attempt++) {
        notification=await outbox.claim();assert.ok(notification);assert.equal(notification.feedback_id,item.id);
        await outbox.finish(notification,{temporary:true,errorCode:'SMTP450'});
        await pool.execute('UPDATE feedback_email_outbox SET next_attempt_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE id=?',[notification.id]);
      }
      const row=(await outbox.list(admin,{feedbackId:item.id})).items[0];assert.equal(row.state,'Failed');assert.equal(row.attempt_count,5);assert.equal(row.attempts.length,5);
      await assert.rejects(outbox.retry(admin,row.id),{status:409});assert.equal(await outbox.claim(),null);
    });
    await t.test('private email link returns to the owning feedback after sign-in',async()=>{
      const agent=request.agent(app);await agent.get('/feedback/'+report.id).expect(302).expect('Location','/login');
      const page=await agent.get('/login').expect(200);const token=page.text.match(/name="csrf-token" content="([^"]+)"/)[1];
      await agent.post('/auth/login').send({_csrf:token,email:student.email,password}).expect(302).expect('Location','/feedback/'+report.id);
      await agent.get('/feedback/'+report.id).expect(200);
    });
    await t.test('email notifications do not subscribe to emergency status changes',async()=>{
      const [[before]]=await pool.query('SELECT COUNT(*) AS total FROM feedback_email_outbox');
      const emergency=require('../src/models/emergencies').createEmergencyStore(pool,{});
      const item=await emergency.submit(student,{type:'Other',location:'Test area',description:'Emergency isolation test.',request_key:randomUUID(),contact_number:''});
      await emergency.respond(await store.getUser(844),item.id);
      const [[after]]=await pool.query('SELECT COUNT(*) AS total FROM feedback_email_outbox');assert.equal(after.total,before.total);
    });
    await t.test('browser previews and edits templates, protects edits, requires approval and renders concise email on mobile',async()=>{
      const {existsSync}=require('node:fs');const executablePath=process.env.BROWSER_PATH||['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);assert.ok(executablePath);
      web=await new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server));});const url='http://127.0.0.1:'+web.address().port;
      browser=await require('playwright-core').chromium.launch({executablePath,headless:true});const context=await browser.newContext({viewport:{width:1365,height:1000}});
      await context.addCookies([{name:'cspc.sid',value:cookies.admin.slice('cspc.sid='.length),url}]);const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
      const item=await make();await page.goto(url+'/admin/feedback/'+item.id);
      assert.equal(await page.locator('.feedback-update textarea:visible').count(),1);
      assert.equal(await page.locator('[name="notificationMethod"]:checked').inputValue(),'both');
      assert.deepEqual(await page.locator('#status option').allTextContents(),['Submitted','Under Review','In Progress','Resolved','Closed']);
      const save = async () => {
        await page.getByRole('button',{name:'Update & Notify',exact:true}).click();
        await page.getByRole('button',{name:'Confirm update',exact:true}).click();
        await page.waitForLoadState('networkidle');
      };
      const initial = await page.inputValue('#response-body');assert.ok(initial.includes('Submitted'));assert.ok(initial.includes(item.reference));
      await page.fill('#response-body','An edited response that must not disappear.');
      page.once('dialog',dialog=>dialog.dismiss());await page.selectOption('#status','Under Review');
      assert.equal(await page.inputValue('#status'),'Submitted');assert.equal(await page.inputValue('#response-body'),'An edited response that must not disappear.');
      page.once('dialog',dialog=>dialog.accept());await page.selectOption('#status','Under Review');
      assert.ok((await page.inputValue('#response-body')).includes('Under Review'));
      await page.fill('#response-body','Another edited response.');
      page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Restore Default Response',exact:true}).click();
      assert.ok((await page.inputValue('#response-body')).includes('Under Review'));
      await page.getByRole('button',{name:'Update & Notify',exact:true}).click();
      assert.equal(await page.locator('[data-review-method]').textContent(),'Both');
      await page.locator('[data-update-dialog]').screenshot({path:path.join(__dirname,'../docs/qa/feedback-update-confirmation.png')});
      assert.equal((await store.detail(item.id,{admin:true})).status,'Submitted');assert.equal((await outbox.list(admin,{feedbackId:item.id})).items.length,0);
      await page.getByRole('button',{name:'Keep editing',exact:true}).click();assert.equal((await store.detail(item.id,{admin:true})).history.length,1);
      await save();assert.equal((await store.detail(item.id,{admin:true})).status,'Under Review');
      await page.selectOption('#status','Resolved');
      await page.getByRole('button',{name:'Update & Notify',exact:true}).click();assert.equal(await page.locator('dialog[open]').count(),0);
      await page.fill('#action-taken','The broken lights have been replaced and checked.');
      assert.ok((await page.inputValue('#response-body')).includes('The broken lights have been replaced and checked.'));
      await page.check('[name="actionConfirmed"]');
      await save();assert.equal((await store.detail(item.id,{admin:true})).status,'Resolved');
      await page.selectOption('#status','Closed');await page.fill('#closure-reason','This completed request is being archived after confirmation of the repair.');
      await save();assert.equal((await store.detail(item.id,{admin:true})).status,'Closed');
      await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await page.locator('.feedback-update').screenshot({path:path.join(__dirname,'../docs/qa/feedback-update-controls-mobile.png')});
      await page.getByRole('button',{name:'Update & Notify',exact:true}).click();
      assert.equal(await page.locator('dialog[open]').count(),1);
      await page.locator('[data-update-dialog]').screenshot({path:path.join(__dirname,'../docs/qa/feedback-update-confirmation-mobile.png')});
      await page.getByRole('button',{name:'Keep editing',exact:true}).click();
      await page.screenshot({path:path.join(__dirname,'../docs/qa/feedback-update-mobile.png'),fullPage:true});await page.setViewportSize({width:1365,height:1000});
      await fs.mkdir(path.join(__dirname,'../docs/qa'),{recursive:true});await page.screenshot({path:path.join(__dirname,'../docs/qa/feedback-email-admin.png'),fullPage:true});
      await page.goto(url+'/admin/notifications');assert.ok((await page.locator('body').innerText()).includes('Queued'));
      const {buildFeedbackEmail}=require('../src/services/feedback-email');const [rows]=await pool.execute("SELECT * FROM feedback_email_outbox WHERE feedback_id=? AND JSON_UNQUOTE(JSON_EXTRACT(payload_json,'$.status'))='Resolved'",[item.id]);
      const message=await buildFeedbackEmail(rows[0],emailConfig);const mobile=await browser.newPage({viewport:{width:390,height:844}});await mobile.setContent(message.html);
      assert.equal(await mobile.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.ok((await mobile.locator('body').innerText()).includes('full approved administrator response'));
      await mobile.screenshot({path:path.join(__dirname,'../docs/qa/feedback-email-mobile.png'),fullPage:true});await mobile.close();assert.deepEqual(errors,[]);await context.close();
    });
    await t.test('all statuses and delivery methods preserve approved history and queue only selected notifications',async()=>{
      const { responseFor } = require('../src/services/responseTemplates');
      for (const status of ['Submitted','Under Review','In Progress','Resolved','Closed']) for (const notificationMethod of ['web','email','both']) {
        const item=await make(), detail=await store.detail(item.id,{admin:true});
        const actionTaken='The faulty lights have been replaced and checked.';
        const closureReason='The requested change duplicates a campus project already approved.';
        const response=responseFor(detail,status).replace('{{actionTaken}}',actionTaken).replace('{{closureReason}}',closureReason);
        const fields={response,notificationMethod,actionTaken,closureReason,request_key:randomUUID()};
        await post(item.id,status,fields).expect(302);
        await post(item.id,status,fields).expect(302);
        await post(item.id,status,{...fields,request_key:randomUUID()}).expect(302);
        const saved=await store.detail(item.id,{userId:student.id});
        assert.equal(saved.status,status);assert.equal(saved.responses.length,1);assert.equal(saved.responses[0].body,response);
        assert.equal(saved.history.length,2);assert.equal(saved.history[1].additional_message,response);
        assert.equal(saved.history[1].resolution_summary,status==='Resolved'?actionTaken:null);
        assert.equal(saved.history[1].rejection_reason,status==='Closed'?closureReason:null);
        const [[webCount]]=await pool.execute('SELECT COUNT(*) AS total FROM feedback_notifications WHERE feedback_id=? AND user_id=?',[item.id,student.id]);
        assert.equal(Number(webCount.total),notificationMethod==='email'?0:1);
        const emails=await outbox.list(admin,{feedbackId:item.id});assert.equal(emails.total,notificationMethod==='web'?0:1);
        if(emails.total){
          const [[queued]]=await pool.execute('SELECT * FROM feedback_email_outbox WHERE feedback_id=?',[item.id]);
          const message=await require('../src/services/feedback-email').buildFeedbackEmail(queued,emailConfig);
          assert.ok(message.text.includes('/feedback/'+item.id));assert.ok(!message.text.includes(response));
          assert.equal(message.text.includes('full approved administrator response'),true);
        }
        const otherMethod=notificationMethod==='web'?'email':'web';
        await post(item.id,status,{...fields,notificationMethod:otherMethod}).expect(409);
        const own=await request(app).get('/feedback/'+item.id).set('Cookie',cookies.owner).expect(200);
        assert.ok(own.text.includes('Message from the administration'));
        await request(app).get('/feedback/'+item.id).set('Cookie',cookies.other).expect(404);
      }
    });
    await t.test('unapproved, incomplete and malformed updates create neither history nor notifications',async()=>{
      const item=await make();
      const invalid=[{confirmed:'0'},{response:''},{notificationMethod:'invalid'},{notificationMethod:['both']},{status:'Resolved',actionTaken:''},{status:'Resolved',actionConfirmed:'0'},{status:'Closed',closureReason:''},{response:'Action: {{actionTaken}}'},{request_key:''}];
      for(const fields of invalid) await post(item.id,'Under Review',fields).expect(422);
      const saved=await store.detail(item.id,{admin:true});assert.equal(saved.status,'Submitted');assert.equal(saved.history.length,1);assert.equal(saved.responses.length,0);
      assert.equal((await outbox.list(admin,{feedbackId:item.id})).total,0);
      const [[count]]=await pool.execute('SELECT COUNT(*) AS total FROM feedback_notifications WHERE feedback_id=?',[item.id]);assert.equal(Number(count.total),0);
    });
    await t.test('legacy status migration retains records, explanations and queued notifications and is repeatable',async()=>{
      const item=await make();await store.updateStatus(item.id,'Under Review',admin.id);
      await store.updateStatus(item.id,'Closed',admin.id,{closureReason:'Archived with the original student explanation.'});
      await pool.execute("UPDATE feedback_status_history SET rejection_reason=? WHERE feedback_id=? AND status='Closed'",['Archived with the original student explanation.',item.id]);
      const before=await store.detail(item.id,{userId:student.id});
      const notifications=(await outbox.list(admin,{feedbackId:item.id})).items;
      const oldEnum="ENUM('Submitted','Acknowledged','Under Review','In Progress','Resolved','Rejected','Closed')";
      for(const [table,column,suffix] of [['feedback','status',"NOT NULL DEFAULT 'Submitted'"],['feedback_status_history','previous_status','NULL'],['feedback_status_history','status','NOT NULL']]) {
        await pool.query('ALTER TABLE '+table+' MODIFY '+column+' '+oldEnum+' '+suffix);
        await pool.query("UPDATE "+table+" SET "+column+"=CASE WHEN "+column+"='Under Review' THEN 'Acknowledged' WHEN "+column+"='Closed' THEN 'Rejected' ELSE "+column+" END WHERE "+(table==='feedback'?'id':'feedback_id')+'=?',[item.id]);
      }
      await require('../scripts/migrate-email').migrate(pool);await require('../scripts/migrate-email').migrate(pool);
      const after=await store.detail(item.id,{userId:student.id});
      assert.equal(after.status,'Closed');assert.deepEqual(after.history,before.history);
      assert.deepEqual((await outbox.list(admin,{feedbackId:item.id})).items,notifications);
      const [[column]]=await pool.query("SHOW COLUMNS FROM feedback LIKE 'status'");assert.equal(column.Type,"enum('Submitted','Under Review','In Progress','Resolved','Closed')");
    });
  } finally {
    await browser?.close();if(web)await new Promise(resolve=>web.close(resolve));await worker?.stop();if(smtp)await new Promise(resolve=>smtp.close(resolve));await pool?.end();
    if(previous===undefined)delete process.env.DB_NAME;else process.env.DB_NAME=previous;
    assert.match(database,/^cspc_email_test_[a-f0-9]{16}$/);await connection.query(`DROP DATABASE \`${database}\``);await connection.end();
  }
});
