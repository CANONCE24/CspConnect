'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs/promises');
const path=require('node:path');
const mysql=require('mysql2/promise');
const request=require('supertest');
const {chromium}=require('playwright-core');
require('dotenv').config({quiet:true});
const key=()=>crypto.randomUUID();
const token=res=>res.text.match(/name="csrf-token" content="([^"]+)"/)[1];
const formKey=res=>res.text.match(/name="request_key" value="([^"]+)"/)[1];
const mailto='mailto:canoncesam76@gmail.com?subject=CSPConnect%20Support%20Inquiry';
test('private support tickets, existing notifications and browser communication with real MySQL',{skip:process.env.TEST_DB!=='1',timeout:120000},async t=>{
  const database='cspc_support_test_'+crypto.randomBytes(8).toString('hex');
  const db=await mysql.createConnection({host:process.env.DB_HOST||'127.0.0.1',port:Number(process.env.DB_PORT||3306),user:process.env.DB_USER||'root',password:process.env.DB_PASSWORD||''});
  const previous=process.env.DB_NAME;let owned=false,pool,browser,server;
  try{
    assert.match(database,/^cspc_support_test_[a-f0-9]{16}$/);
    await db.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);owned=true;await db.changeUser({database});
    const sql=await fs.readFile(path.join(__dirname,'../schema.sql'),'utf8')+'\n'+await fs.readFile(path.join(__dirname,'../seed.sql'),'utf8');
    for(const statement of sql.replace(/^\s*--.*$/gm,'').split(';').map(s=>s.trim()).filter(Boolean))await db.query(statement);
    process.env.DB_NAME=database;pool=require('../src/config/db').pool;
    const config={adminEmails:['admin@example.test','second.admin@example.test'],securityEmails:['guard@example.test']};
    const store={...require('../src/models/store'),...require('../src/models/support').createSupportStore(pool,config)};
    const fixtures=[
      [841,'Student Example','student@my.cspc.edu.ph','student','Student'],[842,'Administrator','admin@example.test','admin','Staff'],
      [843,'Faculty Example','faculty@cspc.edu.ph','student','Faculty'],[844,'Staff Example','staff@cspc.edu.ph','student','Staff'],
      [845,'Visitor Example','visitor@example.test','student','Visitor'],[846,'Second Administrator','second.admin@example.test','admin','Staff'],
      [847,'Not Allowlisted','excluded@example.test','admin','Staff'],[848,'Campus Guard','guard@example.test','security','Staff']
    ];
    for(const [id,name,email,role,affiliation] of fixtures)await pool.execute('INSERT INTO users(id,name,email,role,affiliation,affiliation_email,email_verified_at,password_verified_at) VALUES (?,?,?,?,?,?,NOW(3),NOW(3))',[id,name,email,role,affiliation,email]);
    const users={};for(const [id] of fixtures)users[id]=await store.getUser(id);
    const userIds={owner:841,admin:842,faculty:843,staff:844,visitor:845,secondAdmin:846,excluded:847,guard:848};
    let app,cookies,csrfToken,sessionStore;
    t.beforeEach(async()=>{({app,cookies,csrfToken,sessionStore}=await require('./support').fixtureApp({store,config,userIds}));});
    let mainTicket;
    await t.test('migration extends the old notification schema safely and is repeatable with existing notifications',async()=>{
      const feedback=await store.submit(841,{type:'Concern',categoryId:1,title:'Existing feedback record',description:'An existing feedback entry to preserve during migration.',isAnonymous:true});
      await store.addResponse(feedback.id,842,'Existing administrator response.');
      const [before]=await pool.query('SELECT id,user_id,feedback_id,kind,message,event_key,read_at,created_at FROM feedback_notifications');
      await pool.query('ALTER TABLE feedback_notifications DROP FOREIGN KEY notification_support_fk');
      await pool.query('ALTER TABLE feedback_notifications DROP COLUMN support_ticket_id');
      await pool.query('ALTER TABLE feedback_notifications MODIFY feedback_id INT UNSIGNED NOT NULL');
      await pool.query("ALTER TABLE feedback_notifications MODIFY kind ENUM('StatusUpdated','AdminResponse','Published','Unpublished') NOT NULL");
      const {migrate}=require('../scripts/migrate-support');await migrate(pool);await migrate(pool);
      const [after]=await pool.query('SELECT id,user_id,feedback_id,kind,message,event_key,read_at,created_at FROM feedback_notifications');assert.deepEqual(after,before);
      assert.equal((await store.detail(feedback.id,{userId:841})).responses[0].body,'Existing administrator response.');
    });
    await t.test('login help exposes the exact mailto address without authentication or ticket creation',async()=>{
      const before=(await pool.query('SELECT COUNT(*) AS total FROM support_tickets'))[0][0].total;
      await request(app).get('/login').expect(200).expect(/Need Help\? Contact Admin/);
      const page=await request(app).get('/contact-admin').expect(200);
      assert(page.text.includes(mailto));assert(page.text.includes('canoncesam76@gmail.com'));assert(!page.text.includes('ST-'));
      await request(app).get('/contact').expect(302).expect('Location','/login');
      await request(app).get('/contact/1').expect(302).expect('Location','/login');
      await request(app).get('/admin/contact').expect(302).expect('Location','/login');
      await request(app).post('/contact').send({message:'Unauthenticated'}).expect(403);
      assert.equal((await pool.query('SELECT COUNT(*) AS total FROM support_tickets'))[0][0].total,before);
    });
    await t.test('all four affiliations can submit; ownership and affiliation come from the server and admins are notified',async()=>{
      for(const name of ['owner','faculty','staff','visitor']){
        const page=await request(app).get('/contact').set('Cookie',cookies[name]).expect(200);
        const sent=await request(app).post('/contact').set('Cookie',cookies[name]).send({_csrf:csrfToken,request_key:formKey(page),category:'Technical Support',subject:'Private technical concern '+name,message:'Private message body for '+name,user_id:842,affiliation:'Administrator',role:'admin'}).expect(302);
        const id=Number(sent.headers.location.split('/').at(-1)),ticket=await store.supportTicketDetail(users[userIds[name]],id);
        assert.equal(ticket.user_id,userIds[name]);assert.equal(ticket.affiliation,users[userIds[name]].affiliation);assert.equal(ticket.status,'Open');assert.match(ticket.reference,/^ST-\d{4}-\d{5,}$/);
        assert.equal(ticket.messages.length,1);assert.equal(ticket.history.length,1);
        if(name==='owner')mainTicket=ticket;
      }
      assert.equal(await store.unreadNotificationCount(842),4);assert.equal(await store.unreadNotificationCount(846),4);assert.equal(await store.unreadNotificationCount(847),0);
      const notifications=await store.listNotifications(842);assert.equal(notifications.items.length,4);assert(!JSON.stringify(notifications).includes('Private message body'));assert(!JSON.stringify(notifications).includes('Private technical concern'));
      await request(app).get('/notifications').set('Cookie',cookies.admin).expect(200).expect(/New support ticket/);
      await request(app).get('/admin').set('Cookie',cookies.admin).expect(200).expect(/4 Open/);
    });
    await t.test('authorization, ID tampering, CSRF and server length/category validation protect private conversations',async()=>{
      for(const name of ['faculty','staff','visitor']){
        await request(app).get('/contact/'+mainTicket.id).set('Cookie',cookies[name]).expect(404);
        await request(app).post(`/contact/${mainTicket.id}/reply`).set('Cookie',cookies[name]).send({_csrf:csrfToken,request_key:key(),message:'Unauthorized reply',user_id:841}).expect(404);
      }
      for(const name of ['owner','guard','excluded'])await request(app).get('/admin/contact').set('Cookie',cookies[name]).expect(403);
      await request(app).post('/contact').set('Cookie',cookies.owner).send({category:'Others',subject:'CSRF test',message:'No proof',request_key:key()}).expect(403);
      for(const invalid of [{category:'Administrator'},{subject:'x'},{message:''},{message:'a'.repeat(5001)}]){
        await request(app).post('/contact').set('Cookie',cookies.owner).send({_csrf:csrfToken,request_key:key(),category:'Others',subject:'Valid subject',message:'Valid body',...invalid}).expect(422);
      }
      await request(app).post(`/admin/contact/${mainTicket.id}/status`).set('Cookie',cookies.owner).send({_csrf:csrfToken,request_key:key(),status:'Closed',version:1}).expect(403);
      await request(app).post(`/contact/${mainTicket.id}/reply`).set('Cookie',cookies.owner).send({message:'No CSRF',request_key:key()}).expect(403);
    });
    await t.test('administrator replies, user replies and status changes notify the correct accounts and preserve all history',async()=>{
      const first=await request(app).get('/admin/contact/'+mainTicket.id).set('Cookie',cookies.admin).expect(200).expect(/Student Example/).expect(/Student/);
      await request(app).post(`/admin/contact/${mainTicket.id}/reply`).set('Cookie',cookies.admin).send({_csrf:csrfToken,request_key:formKey(first),message:'We are looking into this private concern.'}).expect(302);
      let ticket=await store.supportTicketDetail(users[841],mainTicket.id);assert.equal(ticket.status,'Pending');assert.equal(ticket.messages.length,2);
      const notifications=await store.listNotifications(841),replyNotification=notifications.items.find(item=>item.kind==='SupportReply');assert(replyNotification);
      await request(app).post(`/notifications/${replyNotification.id}/read`).set('Cookie',cookies.owner).send({_csrf:csrfToken}).expect(302).expect('Location','/contact/'+mainTicket.id);
      await request(app).post(`/notifications/${replyNotification.id}/read`).set('Cookie',cookies.faculty).send({_csrf:csrfToken}).expect(404);
      await request(app).get('/contact/'+mainTicket.id).set('Cookie',cookies.owner).expect(200).expect(/We are looking into/);
      const before=await store.unreadNotificationCount(842);
      await store.replyToSupportTicket(users[841],mainTicket.id,{message:'Here is more information for the administrator.',requestKey:key()});
      ticket=await store.supportTicketDetail(users[842],mainTicket.id);assert.equal(ticket.status,'Open');assert.equal(await store.unreadNotificationCount(842),before+1);
      await request(app).post(`/admin/contact/${mainTicket.id}/status`).set('Cookie',cookies.admin).send({_csrf:csrfToken,request_key:key(),status:'Closed',version:ticket.version}).expect(302);
      const closed=await store.supportTicketDetail(users[841],mainTicket.id);assert.equal(closed.status,'Closed');
      await request(app).post(`/contact/${mainTicket.id}/reply`).set('Cookie',cookies.owner).send({_csrf:csrfToken,request_key:key(),message:'A late reply'}).expect(409);
      await request(app).post(`/admin/contact/${mainTicket.id}/reply`).set('Cookie',cookies.admin).send({_csrf:csrfToken,request_key:key(),message:'A late admin reply'}).expect(409);
      await request(app).post(`/admin/contact/${mainTicket.id}/status`).set('Cookie',cookies.admin).send({_csrf:csrfToken,request_key:key(),status:'Open',version:closed.version}).expect(302);
      const reopened=await store.supportTicketDetail(users[841],mainTicket.id);assert.equal(reopened.status,'Open');assert.equal(reopened.messages.length,3);assert.equal(reopened.history.length,5);
      assert.deepEqual(reopened.history.map(entry=>entry.action),['Created','AdminReply','UserReply','StatusChanged','StatusChanged']);
    });
    await t.test('duplicate and concurrent submissions/replies are idempotent; conflicting payloads and stale updates fail safely',async()=>{
      const data={category:'Account Issues',subject:'Duplicate ticket test',message:'Only one ticket should be saved.',requestKey:key()};
      const results=await Promise.all([store.createSupportTicket(users[841],data),store.createSupportTicket(users[841],data)]);assert.equal(results[0].id,results[1].id);assert.equal(results.filter(result=>result.changed).length,1);
      await assert.rejects(store.createSupportTicket(users[841],{...data,message:'Changed duplicate payload'}),{status:409});
      const message={message:'A duplicate administrator reply.',requestKey:key()};
      const replies=await Promise.all([store.replyToSupportTicket(users[842],results[0].id,message),store.replyToSupportTicket(users[842],results[0].id,message)]);assert.equal(replies.filter(result=>result.changed).length,1);
      const ticket=await store.supportTicketDetail(users[842],results[0].id);assert.equal(ticket.messages.length,2);
      const updates=await Promise.allSettled(['Closed','Open'].map(status=>store.updateSupportStatus(users[842],ticket.id,{status,version:ticket.version,requestKey:key()})));
      assert.equal(updates.filter(result=>result.status==='fulfilled').length,1);assert.equal(updates.find(result=>result.status==='rejected').reason.status,409);
      const [[count]]=await pool.execute("SELECT COUNT(*) AS total FROM feedback_notifications WHERE support_ticket_id=? AND kind='SupportReply'",[ticket.id]);assert.equal(count.total,1);
    });
    await t.test('filters, sender and ticket searches, pagination and escaped output remain private',async()=>{
      const ticket=await store.createSupportTicket(users[844],{category:'Privacy Concerns',subject:'<script>private subject</script>',message:'<img src=x onerror=alert(1)> private contents',requestKey:key()});
      const page=await request(app).get('/admin/contact/'+ticket.id).set('Cookie',cookies.admin).expect(200);
      assert(page.text.includes('&lt;script&gt;private subject&lt;/script&gt;'));assert(page.text.includes('&lt;img src=x onerror=alert(1)&gt;'));assert(!page.text.includes('<img src=x'));
      for(const term of ['Staff Example','staff@cspc.edu.ph',ticket.reference,'private subject']){
        const search=term===ticket.reference?(await store.supportTicketDetail(users[844],ticket.id)).reference:term;
        const result=await store.listSupportTickets(users[842],{search,status:'Open',page:999,limit:1});assert(result.total>=1,search);assert(result.page<=result.pages);
      }
      const mine=await store.listSupportTickets(users[843],{search:'Private'});assert(mine.items.every(row=>row.user_id===843));
      const literal=await store.listSupportTickets(users[842],{search:"%' OR 1=1 --"});assert.equal(literal.total,0);
      await request(app).get('/admin/contact?status=Open&q=Staff').set('Cookie',cookies.admin).expect(200).expect(/Staff Example/);
      const notifications=await store.listNotifications(842);assert(!JSON.stringify(notifications).includes('onerror'));
    });
    await t.test('new ticket rate limit is enforced without creating extra records',async()=>{
      for(let number=0;number<5;number++)await request(app).post('/contact').set('Cookie',cookies.visitor).send({_csrf:csrfToken,request_key:key(),category:'Others',subject:'Rate limit example '+number,message:'A private test message.'}).expect(302);
      await request(app).post('/contact').set('Cookie',cookies.visitor).send({_csrf:csrfToken,request_key:key(),category:'Others',subject:'Blocked sixth message',message:'A private test message.'}).expect(429);
      const result=await store.listSupportTickets(users[845],{search:'Rate limit example'});assert.equal(result.total,5);
    });
    await t.test('desktop and mobile browsers send, notify, reply, close, reopen and access public email help',async()=>{
      const executablePath=process.env.BROWSER_PATH||['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(filename=>require('node:fs').existsSync(filename));assert(executablePath);
      browser=await chromium.launch({executablePath,headless:true});
      server=await new Promise(resolve=>{const instance=app.listen(0,'127.0.0.1',()=>resolve(instance));});const base='http://127.0.0.1:'+server.address().port;
      const errors=[];
      const makePage=async name=>{
        const context=await browser.newContext({viewport:{width:1440,height:1000}});
        if(name){const cookie=cookies[name].split(';')[0],index=cookie.indexOf('=');await context.addCookies([{name:cookie.slice(0,index),value:cookie.slice(index+1),url:base}]);}
        const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));return page;
      };
      const owner=await makePage('owner'),admin=await makePage('admin');
      const visit=async(page,url)=>{const response=await page.goto(base+url,{waitUntil:'networkidle'});assert.equal(response.status(),200);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false,url);};
      const qa=path.join(__dirname,'../docs/qa');await fs.mkdir(qa,{recursive:true});
      await visit(owner,'/contact');await owner.screenshot({path:path.join(qa,'contact-admin-desktop.png'),fullPage:true});
      assert.equal(await owner.getByRole('link',{name:'Email Administrator',exact:true}).getAttribute('href'),mailto);
      await owner.locator('#contact-category').selectOption('Feedback Concerns');await owner.locator('#contact-subject').fill('Browser private support concern');await owner.locator('#contact-message').fill('Please help me understand a private feedback concern.');
      await owner.getByRole('button',{name:'Send Message',exact:true}).click();await owner.waitForURL(/\/contact\/\d+$/);const id=Number(owner.url().split('/').at(-1));
      await visit(admin,'/notifications');await admin.locator('.notification-item').filter({hasText:'New support ticket'}).first().getByRole('button',{name:'View conversation'}).click();await admin.waitForURL(base+'/admin/contact/'+id);
      await admin.locator('#support-reply').fill('An administrator has reviewed this private concern.');await admin.getByRole('button',{name:'Send Reply',exact:true}).click();await admin.waitForLoadState('networkidle');
      await visit(owner,'/notifications');await owner.locator('.notification-item').filter({hasText:'Support reply'}).first().getByRole('button',{name:'View conversation'}).click();await owner.waitForURL(base+'/contact/'+id);
      assert((await owner.locator('.support-conversation').textContent()).includes('An administrator has reviewed'));
      await owner.locator('#support-reply').fill('Thank you. Here is the follow-up.');await owner.getByRole('button',{name:'Send Reply',exact:true}).click();await owner.waitForLoadState('networkidle');
      await visit(admin,'/admin/contact/'+id);await admin.locator('#ticket-status').selectOption('Closed');await admin.getByRole('button',{name:'Update Status',exact:true}).click();await admin.waitForLoadState('networkidle');
      await admin.locator('#ticket-status').selectOption('Open');await admin.getByRole('button',{name:'Update / Reopen Ticket',exact:true}).click();await admin.waitForLoadState('networkidle');
      await admin.screenshot({path:path.join(qa,'support-conversation-desktop.png'),fullPage:true});
      await visit(admin,'/admin/contact');await admin.screenshot({path:path.join(qa,'contact-messages-desktop.png'),fullPage:true});
      await owner.setViewportSize({width:390,height:844});await visit(owner,'/contact');await owner.screenshot({path:path.join(qa,'contact-admin-mobile.png'),fullPage:true});
      await visit(owner,'/contact?view=conversations');await visit(owner,'/contact/'+id);await owner.screenshot({path:path.join(qa,'support-conversation-mobile.png'),fullPage:true});
      await admin.setViewportSize({width:390,height:844});await visit(admin,'/admin/contact');await admin.screenshot({path:path.join(qa,'contact-messages-mobile.png'),fullPage:true});
      const anonymous=await makePage();await anonymous.setViewportSize({width:390,height:844});await visit(anonymous,'/login');await anonymous.getByRole('link',{name:'Need Help? Contact Admin'}).click();await anonymous.waitForURL(base+'/contact-admin');
      assert.equal(await anonymous.getByRole('link',{name:'Email Administrator',exact:true}).getAttribute('href'),mailto);
      assert((await anonymous.locator('main').textContent()).includes('canoncesam76@gmail.com'));assert.deepEqual(errors,[]);
      assert.equal((await store.supportTicketDetail(users[841],id)).messages.length,3);
    });
  }finally{
    await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));
    if(pool)await pool.end();if(owned)await db.query(`DROP DATABASE \`${database}\``);await db.end();
    if(previous===undefined)delete process.env.DB_NAME;else process.env.DB_NAME=previous;
  }
});
