'use strict';
const {bounded,id,httpError} = require('../utils/validation');
const CATEGORIES = ['Account Issues','Feedback Concerns','Technical Support','Privacy Concerns','General Inquiry','Others'];
const STATUSES = ['Open','Pending','Closed'];
const identifier = value => {const number=id(value);if(!number)throw httpError(422,'Choose a valid ticket.');return number;};
const requestKey = value => {
  if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))throw httpError(422,'Refresh the page before submitting this form.');
  return value;
};
function createSupportStore(pool,config=require('../config/env').loadConfig()) {
  const admins=(config.adminEmails||[]).map(email=>email.trim().toLowerCase());
  async function transaction(action) {
    for(let attempt=0;attempt<3;attempt++){
      const db=await pool.getConnection();
      try{await db.beginTransaction();const result=await action(db);await db.commit();return result;}
      catch(error){
        await db.rollback();
        if(['ER_LOCK_DEADLOCK','ER_LOCK_WAIT_TIMEOUT'].includes(error.code)&&attempt<2)continue;
        if(error.code==='ER_DUP_ENTRY')throw httpError(409,'This request has already been used. Refresh the conversation.');
        throw error;
      }finally{db.release();}
    }
  }
  async function actor(db,user,adminOnly=false,lock=false) {
    if(!user||!['student','admin'].includes(user.role))throw httpError(403,'User or administrator access is required.');
    const [[account]]=await db.execute('SELECT id,role,email,affiliation,session_version FROM users WHERE id=?'+(lock?' LOCK IN SHARE MODE':''),[identifier(user.id)]);
    if(!account||account.role!==user.role||Number(account.session_version)!==Number(user.session_version||0)||
      (account.role==='admin'&&!admins.includes(account.email.toLowerCase()))||(adminOnly&&account.role!=='admin'))throw httpError(403,'Your account permissions changed. Sign in again.');
    return account;
  }
  async function ticket(db,ticketId,account,lock=false) {
    const [[row]]=await db.execute('SELECT * FROM support_tickets WHERE id=?'+(account.role==='admin'?'':' AND user_id=?')+(lock?' FOR UPDATE':''),[identifier(ticketId),...(account.role==='admin'?[]:[account.id])]);
    if(!row)throw httpError(404,'Support ticket was not found.');
    return row;
  }
  async function audit(db,row,actorId,action,previous,key) {
    await db.execute('INSERT INTO support_history(ticket_id,actor_id,action,previous_status,status,version,request_key) VALUES (?,?,?,?,?,?,?)',[row.id,actorId,action,previous,row.status,row.version,key]);
  }
  async function notify(db,row,kind,key,administratorRecipients=false) {
    let recipients=[{id:row.user_id}];
    if(administratorRecipients){
      if(!admins.length)return;
      [recipients]=await db.execute(`SELECT id FROM users WHERE role='admin' AND LOWER(email) IN (${admins.map(()=>'?').join(',')})`,admins);
    }
    const message=kind==='SupportNew'?'A new private support ticket requires administrator attention.':kind==='SupportReply'?
      (administratorRecipients?'A user replied to a private support ticket.':'An administrator replied to your support ticket.'):`Your support ticket is now ${row.status.toLowerCase()}.`;
    for(const recipient of recipients){
      await db.execute('INSERT INTO feedback_notifications(user_id,support_ticket_id,kind,message,event_key) VALUES (?,?,?,?,?)',[recipient.id,row.id,kind,message,`support:${key}:${recipient.id}`]);
    }
  }
  async function priorAction(db,account,key,row,action,bodyOrStatus) {
    const [[prior]]=await db.execute('SELECT * FROM support_history WHERE actor_id=? AND request_key=? FOR UPDATE',[account.id,key]);
    if(!prior)return false;
    if(prior.ticket_id!==row.id||prior.action!==action)throw httpError(409,'This form was already used for another action. Refresh the page.');
    if(action==='StatusChanged'){
      if(prior.status!==bodyOrStatus)throw httpError(409,'This form was already used for a different status.');
    }else{
      const [[message]]=await db.execute('SELECT body FROM support_messages WHERE ticket_id=? AND sender_id=? AND request_key=? FOR UPDATE',[row.id,account.id,key]);
      if(message?.body!==bodyOrStatus)throw httpError(409,'This form was already used for a different message.');
    }
    return true;
  }
  async function createSupportTicket(user,values) {
    const category=values.category,subject=bounded(values.subject,'Subject',3,150),body=bounded(values.message,'Message',1,5000),key=requestKey(values.requestKey);
    if(!CATEGORIES.includes(category))throw httpError(422,'Choose a reason for contacting the administrator.');
    return transaction(async db=>{
      const account=await actor(db,user,false,true);
      if(account.role!=='student')throw httpError(403,'Use Contact Messages to manage user tickets.');
      const [[existing]]=await db.execute('SELECT * FROM support_tickets WHERE user_id=? AND request_key=? FOR UPDATE',[account.id,key]);
      if(existing){
        if(existing.subject!==subject||existing.category!==category)throw httpError(409,'This form was already used for a different ticket.');
        await priorAction(db,account,key,existing,'Created',body);
        return {id:existing.id,reference:existing.reference,changed:false};
      }
      const [[used]]=await db.execute('SELECT id FROM support_history WHERE actor_id=? AND request_key=? FOR UPDATE',[account.id,key]);
      if(used)throw httpError(409,'Refresh the page before creating another ticket.');
      const [inserted]=await db.execute('INSERT INTO support_tickets(user_id,affiliation,category,subject,request_key) VALUES (?,?,?,?,?)',[account.id,account.affiliation,category,subject,key]);
      const row={id:inserted.insertId,user_id:account.id,status:'Open',version:1};
      const [[date]]=await db.query('SELECT YEAR(CURRENT_TIMESTAMP) AS year');
      const reference=`ST-${date.year}-${String(row.id).padStart(5,'0')}`;
      await db.execute('UPDATE support_tickets SET reference=? WHERE id=?',[reference,row.id]);
      await db.execute('INSERT INTO support_messages(ticket_id,sender_id,sender_role,body,request_key) VALUES (?,?,?,?,?)',[row.id,account.id,account.role,body,key]);
      await audit(db,row,account.id,'Created',null,key);
      await notify(db,row,'SupportNew',`${account.id}:${key}`,true);
      return {id:row.id,reference,changed:true};
    });
  }
  async function replyToSupportTicket(user,ticketId,{message,requestKey:keyValue}) {
    const body=bounded(message,'Message',1,5000),key=requestKey(keyValue);
    return transaction(async db=>{
      const account=await actor(db,user,false,true),row=await ticket(db,ticketId,account,true);
      const action=account.role==='admin'?'AdminReply':'UserReply';
      if(await priorAction(db,account,key,row,action,body))return {id:row.id,changed:false};
      if(row.status==='Closed')throw httpError(409,account.role==='admin'?'Reopen this ticket before replying.':'This conversation is closed. Contact the administrator by email or create a new ticket.');
      await db.execute('INSERT INTO support_messages(ticket_id,sender_id,sender_role,body,request_key) VALUES (?,?,?,?,?)',[row.id,account.id,account.role,body,key]);
      const previous=row.status;
      row.status=account.role==='admin'?'Pending':'Open';row.version++;
      await db.execute('UPDATE support_tickets SET status=?,version=?,updated_at=CURRENT_TIMESTAMP(3) WHERE id=?',[row.status,row.version,row.id]);
      await audit(db,row,account.id,action,previous,key);
      await notify(db,row,'SupportReply',`${account.id}:${key}`,account.role!=='admin');
      return {id:row.id,changed:true};
    });
  }
  async function updateSupportStatus(user,ticketId,{status,version,requestKey:keyValue}) {
    const key=requestKey(keyValue),expected=identifier(version);
    if(!STATUSES.includes(status))throw httpError(422,'Choose Open, Pending, or Closed.');
    return transaction(async db=>{
      const account=await actor(db,user,true,true),row=await ticket(db,ticketId,account,true);
      if(await priorAction(db,account,key,row,'StatusChanged',status))return {id:row.id,changed:false};
      if(row.version!==expected)throw httpError(409,'This ticket changed. Refresh the conversation before updating its status.');
      if(row.status===status)return {id:row.id,changed:false};
      const previous=row.status;row.status=status;row.version++;
      await db.execute('UPDATE support_tickets SET status=?,version=?,updated_at=CURRENT_TIMESTAMP(3) WHERE id=?',[status,row.version,row.id]);
      await audit(db,row,account.id,'StatusChanged',previous,key);
      await notify(db,row,'SupportStatus',`${account.id}:${key}`);
      return {id:row.id,changed:true};
    });
  }
  async function listSupportTickets(user,{status='',search='',page=1,limit=12}={}) {
    const account=await actor(pool,user),conditions=[],params=[];
    if(account.role!=='admin'){conditions.push('t.user_id=?');params.push(account.id);}
    if(status){if(!STATUSES.includes(status))throw httpError(422,'Choose a valid ticket status.');conditions.push('t.status=?');params.push(status);}
    if(search){
      const pattern='%'+bounded(search,'Search',1,150).replace(/[!%_]/g,match=>'!'+match)+'%';
      conditions.push("(t.subject LIKE ? ESCAPE '!' OR t.reference LIKE ? ESCAPE '!'"+(account.role==='admin'?" OR u.name LIKE ? ESCAPE '!' OR u.email LIKE ? ESCAPE '!'":'')+')');
      params.push(pattern,pattern,...(account.role==='admin'?[pattern,pattern]:[]));
    }
    const from='FROM support_tickets t INNER JOIN users u ON u.id=t.user_id'+(conditions.length?' WHERE '+conditions.join(' AND '):'');
    const [[count]]=await pool.execute('SELECT COUNT(*) AS total '+from,params);
    limit=Math.min(id(limit)||12,50);const pages=Math.max(1,Math.ceil(Number(count.total)/limit));page=Math.min(id(page)||1,pages);
    const [items]=await pool.execute('SELECT t.*,u.name AS sender_name '+from+' ORDER BY t.updated_at DESC,t.id DESC LIMIT ? OFFSET ?',[...params,limit,(page-1)*limit]);
    return {items,total:Number(count.total),page,pages};
  }
  async function supportTicketDetail(user,ticketId) {
    const account=await actor(pool,user),row=await ticket(pool,ticketId,account);
    const [[owner]]=await pool.execute('SELECT name,email FROM users WHERE id=?',[row.user_id]);
    const [[messages],[history]]=await Promise.all([
      pool.execute('SELECT m.id,m.sender_id,m.sender_role,m.body,m.created_at,u.name AS sender_name FROM support_messages m INNER JOIN users u ON u.id=m.sender_id WHERE m.ticket_id=? ORDER BY m.id ASC',[row.id]),
      pool.execute('SELECT h.*,u.name AS actor_name FROM support_history h INNER JOIN users u ON u.id=h.actor_id WHERE h.ticket_id=? ORDER BY h.id ASC',[row.id])
    ]);
    return {...row,sender_name:owner.name,sender_email:owner.email,messages,history};
  }
  async function openSupportTicketCount(user) {
    await actor(pool,user,true);
    const [[row]]=await pool.query("SELECT COUNT(*) AS total FROM support_tickets WHERE status='Open'");return Number(row.total);
  }
  return {createSupportTicket,replyToSupportTicket,updateSupportStatus,listSupportTickets,supportTicketDetail,openSupportTicketCount};
}
module.exports={createSupportStore,CATEGORIES,STATUSES};
