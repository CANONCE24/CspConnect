'use strict';
const { test }=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs/promises');
const path=require('node:path');
const mysql=require('mysql2/promise');
const request=require('supertest');
require('dotenv').config({quiet:true});

test('comment screening, reports, audited decisions and edits in an owned temporary database',{skip:process.env.TEST_DB!=='1'},async t=>{
  const database='cspc_comments_test_'+crypto.randomBytes(8).toString('hex');
  assert.match(database,/^cspc_comments_test_[a-f0-9]{16}$/);
  const connection=await mysql.createConnection({host:process.env.DB_HOST || '127.0.0.1',port:Number(process.env.DB_PORT || 3306),user:process.env.DB_USER || 'root',password:process.env.DB_PASSWORD || ''});
  const previous=process.env.DB_NAME;let owned=false,pool,browser,web;
  try {
    const [existing]=await connection.execute('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?',[database]);assert.equal(existing.length,0);
    await connection.query('CREATE DATABASE `'+database+'` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');owned=true;await connection.changeUser({database});
    const root=path.resolve(__dirname,'..');
    const sql=await fs.readFile(path.join(root,'schema.sql'),'utf8')+'\n'+await fs.readFile(path.join(root,'seed.sql'),'utf8');
    for(const statement of sql.replace(/^\s*--.*$/gm,'').split(';').map(value=>value.trim()).filter(Boolean))await connection.query(statement);
    process.env.DB_NAME=database;pool=require('../src/config/db').pool;const store=require('../src/models/store');
    const profile=(id,email)=>({id,displayName:id,emails:[{value:email,verified:true}],photos:[]});
    const owner=await store.upsertGoogleUser(profile('Comment Owner','owner@example.test'),['admin@example.test']);
    const other=await store.upsertGoogleUser(profile('Other Student','other@example.test'),['admin@example.test']);
    const third=await store.upsertGoogleUser(profile('Third Student','third@example.test'),['admin@example.test']);
    const admin=await store.upsertGoogleUser(profile('Comment Administrator','admin@example.test'),['admin@example.test']);
    await store.syncAccountRole(admin.id,'admin'); admin.role='admin';
    const item=await store.submit(owner.id,{categoryId:(await store.categories())[0].id,type:'Suggestion',title:'Improve the campus comment discussion',description:'Please improve the campus discussion tools for students.'});
    await store.publish(item.id,true,admin.id);
    const {fixtureApp}=require('./support');
    const fixture=await fixtureApp({store,userIds:{owner:owner.id,other:other.id,third:third.id,admin:admin.id}});
    const {app,cookies,csrfToken}=fixture;
    const metadata=async id=>(await pool.execute('SELECT * FROM comment_moderation WHERE comment_id=?',[id]))[0][0];
    const history=async id=>(await pool.execute('SELECT * FROM comment_moderation_history WHERE comment_id=? ORDER BY id',[id]))[0];
    const make=(body,user=owner)=>store.addComment(item.id,user.id,body);
    const decide=async(comment,action,options={})=>store.moderateComment(comment.id,action,admin.id,{version:(await metadata(comment.id)).version,requestKey:crypto.randomUUID(),...options});
    const visible=async()=>new Set((await store.comments(item.id)).map(row=>row.id));
    let reported,flagged;

    await t.test('clean comments publish, profanity and suspicious links queue privately, counts exclude pending',async()=>{
      const clean=await make('Please provide a quiet space for students.');assert.equal(clean.pending,false);
      flagged=await make('Review marker g4g0 about the proposed schedule.');assert.equal(flagged.pending,true);
      const link=await make('Link marker https://bit.ly/unknown');assert.equal(link.pending,true);
      assert.deepEqual([...(await visible())],[clean.id]);
      assert.equal((await store.detail(item.id,{publicOnly:true})).comment_count,1);
      const own=await request(app).get('/community/'+item.id).set('Cookie',cookies.owner).expect(200);assert.match(own.text,/Your comments awaiting review/);assert.match(own.text,/Review marker g4g0/);
      const publicPage=await request(app).get('/community/'+item.id+'?includeHidden=1&viewerId='+owner.id).set('Cookie',cookies.other).expect(200);
      assert.doesNotMatch(publicPage.text,/Review marker g4g0|Link marker/);
      const page=await request(app).get('/admin/comments?view=flagged').set('Cookie',cookies.admin).expect(200);assert.match(page.text,/Possible offensive language|Link needs a safety review/);
      const dashboard=await request(app).get('/admin').set('Cookie',cookies.admin).expect(200);assert.match(dashboard.text,/Comments Pending Review/);assert.match(dashboard.text,/\/admin\/comments\?view=flagged/);
      await request(app).get('/admin/comments').set('Cookie',cookies.owner).expect(403);
    });
    await t.test('approvals, removals and restoration preserve text and history and reject repeated/stale actions',async()=>{
      const key=crypto.randomUUID(),version=(await metadata(flagged.id)).version;
      const before=(await history(flagged.id)).length;
      const results=await Promise.all([decide(flagged,'approve',{requestKey:key,version}),decide(flagged,'approve',{requestKey:key,version})]);
      assert.equal(results.filter(row=>row.changed).length,1);assert.equal((await history(flagged.id)).length,before+1);assert.equal((await visible()).has(flagged.id),true);
      await assert.rejects(decide(flagged,'remove',{version}),{status:409});
      await decide(flagged,'remove');assert.equal((await visible()).has(flagged.id),false);
      assert.equal((await store.listComments({view:'hidden'})).items.some(row=>row.id===flagged.id),true);
      await decide(flagged,'restore');assert.equal((await visible()).has(flagged.id),true);
      const saved=await history(flagged.id);assert.deepEqual(saved.map(row=>row.action),['Submitted','Approved','Removed','Restored']);assert.ok(saved.every(row=>row.body_snapshot.includes('Review marker')));
      await assert.rejects(store.moderateComment(flagged.id,'remove',owner.id),{status:403});
      await request(app).post('/admin/comments/'+flagged.id+'/moderate').set('Cookie',cookies.owner).send({_csrf:csrfToken,action:'remove',version:4,confirmed:'1'}).expect(403);
      await request(app).post('/admin/comments/'+flagged.id+'/moderate').set('Cookie',cookies.admin).send({action:'remove',version:4,confirmed:'1'}).expect(403);
      await request(app).post('/admin/comments/'+flagged.id+'/moderate').set('Cookie',cookies.admin).send({_csrf:csrfToken,action:'remove',version:4}).expect(422);
    });
    await t.test('student reports queue visible comments, deduplicate per student and preserve report details',async()=>{
      reported=await make('Report marker: the campus proposal deserves careful consideration.',other);
      const before=await store.pendingCommentCount();
      await request(app).post('/community/'+item.id+'/comments/'+reported.id+'/report').set('Cookie',cookies.owner)
        .send({_csrf:csrfToken,reason:'harassment',details:'Please review the context <script>test</script>.',is_hidden:'1',user_id:third.id}).expect(302);
      await store.reportComment(item.id,reported.id,owner.id,'spam');
      await store.reportComment(item.id,reported.id,third.id,'other','A second student concern.');
      assert.equal(await store.pendingCommentCount(),before+1);assert.equal((await visible()).has(reported.id),true);
      const [[count]]=await pool.execute('SELECT COUNT(*) AS total FROM comment_reports WHERE comment_id=?',[reported.id]);assert.equal(Number(count.total),2);
      const queue=await store.listComments({view:'flagged',search:'Report marker'});assert.equal(queue.total,1);assert.equal(Number(queue.items[0].report_count),2);
      const page=await request(app).get('/admin/comments?view=flagged&q=Report%20marker').set('Cookie',cookies.admin).expect(200);
      assert.match(page.text,/Harassment or bullying/);assert.match(page.text,/&lt;script&gt;test&lt;\/script&gt;/);assert.doesNotMatch(page.text,/<script>test<\/script>/);
      await assert.rejects(store.reportComment(item.id,reported.id,other.id,'spam'),{status:422});
      await assert.rejects(store.reportComment(item.id,reported.id,owner.id,'invented'),{status:422});
      await decide(reported,'approve');assert.equal((await store.listComments({view:'flagged',search:'Report marker'})).total,0);
      assert.equal((await store.reportComment(item.id,reported.id,owner.id,'other')).changed,false);
    });
    await t.test('edits rescan, preserve previous text, stay pending until review and cannot bypass removals',async()=>{
      const comment=await make('Edit marker: a constructive original comment.');
      await store.editComment(item.id,comment.id,owner.id,'Edit marker: p*tangina is inappropriate.',{version:1});
      assert.equal((await visible()).has(comment.id),false);assert.equal((await metadata(comment.id)).state,'Pending');
      await store.editComment(item.id,comment.id,owner.id,'Edit marker: a revised constructive comment.',{version:2});
      assert.equal((await metadata(comment.id)).state,'Pending');
      const records=await history(comment.id);assert.equal(records.length,3);assert.match(records[0].body_snapshot,/constructive original/);assert.match(records[1].body_snapshot,/p\*tangina/);
      await assert.rejects(decide(comment,'approve',{version:1}),{status:409});
      await assert.rejects(store.editComment(item.id,comment.id,other.id,'Unauthorized edit attempt.',{version:3}),{status:403});
      await decide(comment,'approve');assert.equal((await visible()).has(comment.id),true);
      await decide(comment,'remove');
      await assert.rejects(store.editComment(item.id,comment.id,owner.id,'Bypass removal with an edited comment.',{version:5}),{status:403});
      await decide(comment,'restore');assert.equal((await visible()).has(comment.id),true);
    });
    await t.test('repeated comments are reviewed, while retried submissions do not create duplicates',async()=>{
      const key=crypto.randomUUID(),body='Duplicate marker: provide a sheltered student walkway.';
      const first=await store.addComment(item.id,third.id,body,{requestKey:key});
      const retry=await store.addComment(item.id,third.id,body,{requestKey:key});assert.equal(retry.id,first.id);assert.equal(retry.changed,false);
      const repeated=await store.addComment(item.id,third.id,body.toUpperCase());assert.equal(repeated.pending,true);assert.notEqual(repeated.id,first.id);
      assert.equal((await metadata(repeated.id)).state,'Pending');
    });
    await t.test('an audit failure rolls back the edit or moderation decision without losing text',async()=>{
      const comment=await make('Audit rollback marker: preserve this constructive comment.');
      await connection.query("CREATE TRIGGER comment_audit_test_fail BEFORE INSERT ON comment_moderation_history FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Injected audit failure'");
      try {
        await assert.rejects(decide(comment,'remove'));
        await assert.rejects(store.editComment(item.id,comment.id,owner.id,'Audit rollback marker: gago should not replace the saved text.',{version:1}));
      } finally {await connection.query('DROP TRIGGER comment_audit_test_fail');}
      const [[saved]]=await pool.execute('SELECT body,is_hidden FROM feedback_comments WHERE id=?',[comment.id]);
      assert.equal(saved.body,'Audit rollback marker: preserve this constructive comment.');assert.equal(saved.is_hidden,0);
      assert.equal((await metadata(comment.id)).version,1);assert.equal((await history(comment.id)).length,1);
    });
    await t.test('the migration preserves legacy visibility and snapshots old text on its first edit',async()=>{
      const [legacy]=await pool.execute('INSERT INTO feedback_comments (feedback_id,user_id,body,is_hidden) VALUES (?,?,?,0)',[item.id,owner.id,'Legacy original text preserved.']);
      const [hidden]=await pool.execute('INSERT INTO feedback_comments (feedback_id,user_id,body,is_hidden) VALUES (?,?,?,1)',[item.id,other.id,'Legacy hidden comment preserved.']);
      const [before]=await pool.execute('SELECT * FROM feedback_comments ORDER BY id');
      await require('../scripts/migrate-comment-moderation').migrate(pool);await require('../scripts/migrate-comment-moderation').migrate(pool);
      const [after]=await pool.execute('SELECT * FROM feedback_comments ORDER BY id');assert.deepEqual(after,before);
      await store.editComment(item.id,legacy.insertId,owner.id,'Legacy edited text preserved.',{version:1});
      assert.deepEqual((await history(legacy.insertId)).map(row=>row.body_snapshot),['Legacy original text preserved.','Legacy edited text preserved.']);
      assert.equal((await store.listComments({view:'hidden',search:'Legacy hidden'})).total,1);
      await store.moderateComment(hidden.insertId,'restore',admin.id,{version:1});assert.equal((await visible()).has(hidden.insertId),true);
    });
    await t.test('queue tabs, search, pagination and public counts agree with saved visibility',async()=>{
      const all=await store.listComments({limit:2});const ids=[];
      for(let page=1;page<=all.pages;page++)ids.push(...(await store.listComments({page,limit:2})).items.map(row=>row.id));
      assert.equal(new Set(ids).size,all.total);
      for(const view of ['all','flagged','hidden']){
        const result=await store.listComments({view,search:'marker',limit:2,page:9999});assert.equal(result.page,result.pages);
        const response=await request(app).get('/admin/comments').query({view,q:'marker'}).set('Cookie',cookies.admin).expect(200);assert.ok(response.text.includes('name="view" value="'+view+'"'));
      }
      assert.equal((await store.detail(item.id,{publicOnly:true})).comment_count,(await visible()).size);
      const otherItem=await store.submit(owner.id,{categoryId:(await store.categories())[0].id,type:'Concern',title:'Private discussion boundary',description:'A separate unpublished submission for boundary verification.'});
      await assert.rejects(store.addComment(otherItem.id,owner.id,'Private parent cannot accept comments.'),{status:404});
      await request(app).post('/community/'+otherItem.id+'/comments/'+reported.id+'/report').set('Cookie',cookies.owner).send({_csrf:csrfToken,reason:'spam'}).expect(404);
    });
    await t.test('browser supports private pending edits, reporting, confirmation, review tabs and mobile layouts',async()=>{
      const executablePath=process.env.BROWSER_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(require('node:fs').existsSync);assert.ok(executablePath);
      web=await new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server));});const base='http://127.0.0.1:'+web.address().port;
      browser=await require('playwright-core').chromium.launch({executablePath,headless:true});const errors=[];
      const pageFor=async name=>{const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.addCookies([{name:'cspc.sid',value:cookies[name].slice('cspc.sid='.length),url:base}]);const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));return page;};
      const ownerPage=await pageFor('owner'),otherPage=await pageFor('other'),adminPage=await pageFor('admin');
      await fs.mkdir(path.join(root,'docs/qa'),{recursive:true});
      await ownerPage.goto(base+'/community/'+item.id,{waitUntil:'networkidle'});
      await ownerPage.locator('#comment-body').fill('Browser queue marker: g4g0 comment requires review.');await ownerPage.getByRole('button',{name:'Post comment',exact:true}).click();
      await ownerPage.getByText('Your comment has been submitted and is pending moderation.',{exact:true}).waitFor();
      const pending=ownerPage.locator('.own-pending-comments .comment').filter({hasText:'Browser queue marker'});
      await pending.locator('.comment-edit summary').click();await pending.locator('textarea').fill('Browser queue marker: a revised respectful comment.');await pending.getByRole('button',{name:'Save comment',exact:true}).click();
      const [[saved]]=await pool.execute("SELECT id FROM feedback_comments WHERE body='Browser queue marker: a revised respectful comment.'");assert.ok(saved);
      await adminPage.goto(base+'/admin/comments?view=flagged&q=Browser%20queue%20marker',{waitUntil:'networkidle'});
      let row=adminPage.locator('tbody tr').filter({hasText:'Browser queue marker'});await row.getByRole('button',{name:'Approve',exact:true}).click();
      await otherPage.goto(base+'/community/'+item.id,{waitUntil:'networkidle'});
      let visibleComment=otherPage.locator('.comment-list .comment').filter({hasText:'Browser queue marker'});await visibleComment.locator('.comment-report summary').click();
      await visibleComment.locator('select[name="reason"]').selectOption('inappropriate');await visibleComment.locator('[name="details"]').fill('Please review the context of this comment.');
      await visibleComment.locator('.comment-report').screenshot({path:path.join(root,'docs/qa/comment-report-controls.png')});
      await visibleComment.getByRole('button',{name:'Submit report',exact:true}).click();await otherPage.getByText('Reported for review',{exact:true}).waitFor();assert.equal((await visible()).has(saved.id),true);
      await adminPage.goto(base+'/admin/comments?view=flagged&q=Browser%20queue%20marker',{waitUntil:'networkidle'});row=adminPage.locator('tbody tr').filter({hasText:'Browser queue marker'});
      adminPage.once('dialog',dialog=>dialog.dismiss());await row.getByRole('button',{name:'Remove',exact:true}).click();assert.equal((await visible()).has(saved.id),true);
      adminPage.once('dialog',dialog=>dialog.accept());await row.getByRole('button',{name:'Remove',exact:true}).click();assert.equal((await visible()).has(saved.id),false);
      await adminPage.goto(base+'/admin/comments?view=hidden&q=Browser%20queue%20marker',{waitUntil:'networkidle'});await adminPage.getByRole('button',{name:'Restore',exact:true}).click();assert.equal((await visible()).has(saved.id),true);
      await ownerPage.goto(base+'/community/'+item.id,{waitUntil:'networkidle'});
      const edited=ownerPage.locator('.comment-list .comment').filter({hasText:'Browser queue marker'});await edited.locator('.comment-edit summary').click();await edited.locator('textarea').fill('Browser queue marker: f.u.c.k is flagged after an edit.');await edited.getByRole('button',{name:'Save comment',exact:true}).click();assert.equal((await visible()).has(saved.id),false);
      await ownerPage.setViewportSize({width:390,height:844});assert.equal(await ownerPage.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false);
      await ownerPage.locator('.own-pending-comments').screenshot({path:path.join(root,'docs/qa/comment-pending-student-mobile.png')});
      await adminPage.goto(base+'/admin/comments?view=flagged&q=Browser%20queue%20marker',{waitUntil:'networkidle'});
      await adminPage.screenshot({path:path.join(root,'docs/qa/comment-moderation-desktop.png'),fullPage:true});await adminPage.setViewportSize({width:390,height:844});assert.equal(await adminPage.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false);
      await adminPage.screenshot({path:path.join(root,'docs/qa/comment-moderation-mobile.png'),fullPage:true});
      await adminPage.getByRole('link',{name:/Hidden Comments/}).click();assert.equal(new URL(adminPage.url()).searchParams.get('view'),'hidden');assert.equal(new URL(adminPage.url()).searchParams.get('q'),'Browser queue marker');
      assert.deepEqual(errors,[]);await browser.close();browser=null;await new Promise(resolve=>web.close(resolve));web=null;
    });
    await t.test('report rate limiting and server-side identity checks prevent report flooding',async()=>{
      const fresh=await fixtureApp({store,userIds:{owner:owner.id,admin:admin.id,other:other.id}});
      for(let index=0;index<10;index++)await request(fresh.app).post('/community/'+item.id+'/comments/'+reported.id+'/report').set('Cookie',fresh.cookies.owner).send({_csrf:csrfToken,reason:'spam'}).expect(302);
      await request(fresh.app).post('/community/'+item.id+'/comments/'+reported.id+'/report').set('Cookie',fresh.cookies.owner).send({_csrf:csrfToken,reason:'spam'}).expect(429);
      const [[count]]=await pool.execute('SELECT COUNT(*) AS total FROM comment_reports WHERE comment_id=? AND reporter_id=?',[reported.id,owner.id]);assert.equal(Number(count.total),1);
    });
  } finally {
    await browser?.close();if(web)await new Promise(resolve=>web.close(resolve));await pool?.end();
    if(previous===undefined)delete process.env.DB_NAME;else process.env.DB_NAME=previous;
    if(owned){assert.match(database,/^cspc_comments_test_[a-f0-9]{16}$/);await connection.query('DROP DATABASE `'+database+'`');}await connection.end();
  }
});
