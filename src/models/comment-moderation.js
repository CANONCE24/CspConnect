'use strict';
const { randomUUID } = require('node:crypto');
const { bounded, id, httpError } = require('../utils/validation');
const { scanComment } = require('../services/comment-filter');
const rules = require('../config/comment-rules.json');
const REPORT_REASONS = { harassment:'Harassment or bullying',offensive:'Offensive language',spam:'Spam',inappropriate:'Inappropriate content',other:'Other concerns' };
const identifier = value => { const n=id(value); if(!n) throw httpError(422,'Choose a valid comment.'); return n; };
const keyFor = value => {
  if(value===undefined) return randomUUID();
  if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw httpError(422,'Refresh the page before submitting this action.');
  return value;
};
const array = value => typeof value==='string' ? JSON.parse(value) : value || [];
const PENDING = "(m.state='Pending' OR EXISTS(SELECT 1 FROM comment_reports cr WHERE cr.comment_id=c.id AND cr.resolved_at IS NULL))";
const SELECT = `SELECT c.*,COALESCE(m.state,IF(c.is_hidden=1,'Removed','Published')) AS state,COALESCE(m.version,1) AS version,m.reasons_json,
  (m.comment_id IS NOT NULL) AS has_metadata FROM feedback_comments c LEFT JOIN comment_moderation m ON m.comment_id=c.id`;
function createCommentModerationStore(pool) {
  async function transaction(action) {
    const db=await pool.getConnection();
    try { await db.beginTransaction(); const result=await action(db); await db.commit(); return result; }
    catch(error){await db.rollback();throw error;} finally {db.release();}
  }
  async function role(db,userId,expected,lock=false) {
    const [rows]=await db.execute('SELECT id FROM users WHERE id=? AND role=?'+(lock?' FOR UPDATE':''),[identifier(userId),expected]);
    if(!rows.length) throw httpError(403,expected==='admin'?'Administrator access is required.':'Student access is required.');
  }
  async function feedback(db,feedbackId,publicOnly=true) {
    const [rows]=await db.execute('SELECT id,is_published FROM feedback WHERE id=? FOR UPDATE',[identifier(feedbackId)]);
    if(!rows.length||(publicOnly&&!rows[0].is_published)) throw httpError(404,'This community discussion is not available.');
  }
  async function lockedComment(db,commentId,feedbackId) {
    const [rows]=await db.execute(SELECT+' WHERE c.id=? AND c.feedback_id=? FOR UPDATE',[identifier(commentId),identifier(feedbackId)]);
    if(!rows.length) throw httpError(404,'Comment was not found.');
    return rows[0];
  }
  async function audit(db,row,actorId,action,note='',requestKey=null) {
    await db.execute(`INSERT INTO comment_moderation_history (comment_id,actor_id,action,state,version,body_snapshot,reasons_json,note,request_key)
      VALUES (?,?,?,?,?,?,?,?,?)`,[row.id,actorId,action,row.state,row.version,row.body,JSON.stringify(array(row.reasons_json)),note,requestKey]);
  }
  async function ensureMetadata(db,row) {
    if(row.has_metadata) return;
    await db.execute('INSERT INTO comment_moderation (comment_id,state,version) VALUES (?,?,?)',[row.id,row.state,row.version]);
    await audit(db,row,row.user_id,'Submitted','Existing comment preserved before the first audited change.','legacy-baseline');
    row.has_metadata=true;
  }
  async function save(db,row,reviewer=null) {
    await db.execute('UPDATE feedback_comments SET body=?,is_hidden=? WHERE id=?',[row.body,row.is_hidden?1:0,row.id]);
    await db.execute('UPDATE comment_moderation SET state=?,reasons_json=?,version=?,reviewed_by=?,reviewed_at=IF(? IS NULL,NULL,CURRENT_TIMESTAMP(3)) WHERE comment_id=?',
      [row.state,JSON.stringify(array(row.reasons_json)),row.version,reviewer,reviewer,row.id]);
  }
  async function recent(db,userId,excludeId=0) {
    const [rows]=await db.execute('SELECT body FROM feedback_comments WHERE user_id=? AND id<>? AND created_at>=TIMESTAMPADD(MINUTE,?,CURRENT_TIMESTAMP) ORDER BY id DESC LIMIT 30 FOR UPDATE',[userId,excludeId,-rules.repeatWindowMinutes]);
    return rows;
  }
  async function addComment(feedbackId,userId,body,options={}) {
    const text=bounded(body,'Comment',1,500), key=keyFor(options.requestKey);
    return transaction(async db=>{
      await feedback(db,feedbackId);await role(db,userId,'student',true);
      const [replays]=await db.execute(`SELECT h.comment_id,h.body_snapshot,c.feedback_id,c.is_hidden FROM comment_moderation_history h
        INNER JOIN feedback_comments c ON c.id=h.comment_id WHERE h.actor_id=? AND h.request_key=? AND h.action='Submitted' FOR UPDATE`,[userId,key]);
      if(replays.length){const previous=replays[0];if(previous.body_snapshot!==text||previous.feedback_id!==Number(feedbackId))throw httpError(409,'This action was already used for a different comment.');return {id:previous.comment_id,pending:Boolean(previous.is_hidden),changed:false};}
      const scan=scanComment(text,await recent(db,userId));
      const [inserted]=await db.execute('INSERT INTO feedback_comments (feedback_id,user_id,body,is_hidden) VALUES (?,?,?,?)',[feedbackId,userId,text,scan.flagged?1:0]);
      const row={id:inserted.insertId,user_id:userId,body:text,state:scan.flagged?'Pending':'Published',version:1,is_hidden:scan.flagged,reasons_json:scan.reasons};
      await db.execute('INSERT INTO comment_moderation (comment_id,state,reasons_json) VALUES (?,?,?)',[row.id,row.state,JSON.stringify(scan.reasons)]);
      await audit(db,row,userId,'Submitted',scan.flagged?'Automatic flag; administrator review required.':'Published after automatic screening.',key);
      return {id:row.id,pending:scan.flagged,changed:true};
    });
  }
  async function editComment(feedbackId,commentId,userId,body,options={}) {
    const text=bounded(body,'Comment',1,500), key=keyFor(options.requestKey);
    return transaction(async db=>{
      await feedback(db,feedbackId);await role(db,userId,'student',true);
      const row=await lockedComment(db,commentId,feedbackId);
      if(row.user_id!==Number(userId))throw httpError(403,'You can edit only your own comments.');
      const [replays]=await db.execute('SELECT action,actor_id,body_snapshot FROM comment_moderation_history WHERE comment_id=? AND request_key=? FOR UPDATE',[row.id,key]);
      if(replays.length){if(replays[0].action!=='Edited'||replays[0].actor_id!==Number(userId)||replays[0].body_snapshot!==text)throw httpError(409,'This action was already used.');return {pending:row.state==='Pending',changed:false};}
      if(row.state==='Removed')throw httpError(403,'Removed comments cannot be edited. An administrator must restore them first.');
      if(identifier(options.version)!==Number(row.version))throw httpError(409,'This comment changed. Refresh the discussion before editing.');
      if(row.body===text)return {pending:row.state==='Pending',changed:false};
      await ensureMetadata(db,row);
      const scan=scanComment(text,await recent(db,userId,row.id));
      const alreadyPending=row.state==='Pending';
      row.body=text;row.version++;row.state=scan.flagged||alreadyPending?'Pending':'Published';row.is_hidden=row.state==='Pending';
      row.reasons_json=scan.flagged?scan.reasons:alreadyPending?['Edited while awaiting administrator review']:[];
      await save(db,row);await audit(db,row,userId,'Edited',row.is_hidden?'Edit requires administrator review.':'Edit passed automatic screening.',key);
      return {pending:Boolean(row.is_hidden),changed:true};
    });
  }
  async function reportComment(feedbackId,commentId,userId,reason,details='') {
    if(typeof reason!=='string'||!Object.hasOwn(REPORT_REASONS,reason))throw httpError(422,'Choose a valid report reason.');
    const note=bounded(details,'Report details',0,300);
    return transaction(async db=>{
      await feedback(db,feedbackId);await role(db,userId,'student',true);
      const row=await lockedComment(db,commentId,feedbackId);
      if(row.is_hidden)throw httpError(404,'Comment was not found.');
      if(row.user_id===Number(userId))throw httpError(422,'You cannot report your own comment.');
      const [existing]=await db.execute('SELECT id FROM comment_reports WHERE comment_id=? AND reporter_id=? FOR UPDATE',[row.id,userId]);
      if(existing.length)return {changed:false};
      await ensureMetadata(db,row);
      await db.execute('INSERT INTO comment_reports (comment_id,reporter_id,reason,details) VALUES (?,?,?,?)',[row.id,userId,reason,note]);
      row.version++;await save(db,row);
      await audit(db,row,userId,'Reported',[...(`${REPORT_REASONS[reason]}${note?': '+note:''}`)].slice(0,300).join(''),'report:'+userId);
      return {changed:true};
    });
  }
  async function moderateComment(commentId,action,adminId,options={}) {
    if(typeof action==='boolean')action=action?'remove':'restore';
    if(!['approve','remove','restore'].includes(action))throw httpError(422,'Choose a valid moderation action.');
    if(typeof options==='string')options={note:options};
    const note=bounded(options.note || '','Decision note',0,300),key=keyFor(options.requestKey);
    const [found]=await pool.execute('SELECT feedback_id FROM feedback_comments WHERE id=?',[identifier(commentId)]);
    if(!found.length)throw httpError(404,'Comment was not found.');
    return transaction(async db=>{
      await feedback(db,found[0].feedback_id,false);await role(db,adminId,'admin');
      const row=await lockedComment(db,commentId,found[0].feedback_id);
      const label={approve:'Approved',remove:'Removed',restore:'Restored'}[action];
      const [replays]=await db.execute('SELECT action,actor_id,note FROM comment_moderation_history WHERE comment_id=? AND request_key=? FOR UPDATE',[row.id,key]);
      if(replays.length){if(replays[0].action!==label||replays[0].actor_id!==Number(adminId)||replays[0].note!==note)throw httpError(409,'This action was already used. Refresh the queue.');return {changed:false};}
      if(options.version!==undefined&&identifier(options.version)!==Number(row.version))throw httpError(409,'This comment or its reports changed. Refresh the queue and review the latest version.');
      const [[reports]]=await db.execute('SELECT COUNT(*) AS total FROM comment_reports WHERE comment_id=? AND resolved_at IS NULL',[row.id]);
      if((action==='remove'&&row.state==='Removed'&&row.is_hidden)||(action==='restore'&&!row.is_hidden)||(action==='approve'&&row.state==='Approved'&&!row.is_hidden&&!Number(reports.total)))return {changed:false};
      if(action==='restore'&&row.state==='Pending')throw httpError(422,'Use Approve to review a pending comment.');
      await ensureMetadata(db,row);row.state=action==='remove'?'Removed':'Approved';row.is_hidden=action==='remove';row.version++;
      await save(db,row,adminId);
      await db.execute('UPDATE comment_reports SET resolved_at=CURRENT_TIMESTAMP(3),resolved_by=? WHERE comment_id=? AND resolved_at IS NULL',[adminId,row.id]);
      await audit(db,row,adminId,label,note,key);
      return {changed:true};
    });
  }
  async function comments(feedbackId,{includeHidden=false,viewerId=0}={}) {
    const [rows]=await pool.execute(`SELECT c.id,c.body,c.created_at,c.is_hidden,COALESCE(m.version,1) AS version,u.name AS author_name,
      (c.user_id=?) AS is_owner,EXISTS(SELECT 1 FROM comment_reports cr WHERE cr.comment_id=c.id AND cr.reporter_id=?) AS reported_by_me
      FROM feedback_comments c INNER JOIN users u ON u.id=c.user_id INNER JOIN feedback f ON f.id=c.feedback_id LEFT JOIN comment_moderation m ON m.comment_id=c.id
      WHERE c.feedback_id=? ${includeHidden?'':'AND c.is_hidden=0 AND f.is_published=1'} ORDER BY c.created_at,c.id`,[viewerId,viewerId,identifier(feedbackId)]);
    return rows;
  }
  async function ownPendingComments(feedbackId,userId) {
    const [rows]=await pool.execute(`SELECT c.id,c.body,c.created_at,m.version FROM feedback_comments c INNER JOIN comment_moderation m ON m.comment_id=c.id
      INNER JOIN feedback f ON f.id=c.feedback_id WHERE c.feedback_id=? AND c.user_id=? AND c.is_hidden=1 AND m.state='Pending' AND f.is_published=1 ORDER BY c.id`,[identifier(feedbackId),identifier(userId)]);
    return rows;
  }
  async function pendingCommentCount() {
    const [[row]]=await pool.execute(`SELECT COUNT(*) AS total FROM feedback_comments c LEFT JOIN comment_moderation m ON m.comment_id=c.id WHERE ${PENDING}`);
    return Number(row.total);
  }
  async function listComments({page=1,limit=20,search='',view='all'}={}) {
    limit=Math.min(identifier(limit),50);view=['all','flagged','hidden'].includes(view)?view:'all';
    const conditions=[],params=[];
    if(view==='flagged')conditions.push(PENDING);
    if(view==='hidden')conditions.push("c.is_hidden=1 AND COALESCE(m.state,'Removed')<>'Pending'");
    if(search){const pattern='%'+bounded(search,'Search',1,150).replace(/[!%_]/g,match=>'!'+match)+'%';conditions.push("(c.body LIKE ? ESCAPE '!' OR f.title LIKE ? ESCAPE '!' OR f.reference LIKE ? ESCAPE '!')");params.push(pattern,pattern,pattern);}
    const from=' FROM feedback_comments c INNER JOIN feedback f ON f.id=c.feedback_id LEFT JOIN comment_moderation m ON m.comment_id=c.id';
    const where=conditions.length?' WHERE '+conditions.join(' AND '):'';
    const [[count]]=await pool.execute('SELECT COUNT(*) AS total'+from+where,params);
    const total=Number(count.total),pages=Math.max(1,Math.ceil(total/limit));page=Math.min(id(page)||1,pages);
    const [items]=await pool.execute(`SELECT c.id,c.feedback_id,c.body,c.is_hidden,c.created_at,u.name AS author_name,f.title AS feedback_title,f.reference,f.is_published,
      COALESCE(m.state,IF(c.is_hidden=1,'Removed','Published')) AS state,COALESCE(m.version,1) AS version,m.reasons_json,
      (SELECT COUNT(*) FROM comment_reports cr WHERE cr.comment_id=c.id AND cr.resolved_at IS NULL) AS report_count`+from+' INNER JOIN users u ON u.id=c.user_id'+where+' ORDER BY c.id DESC LIMIT ? OFFSET ?',[...params,limit,(page-1)*limit]);
    for(const item of items){
      item.reasons=array(item.reasons_json);
      const [reports]=await pool.execute('SELECT reason,details,created_at FROM comment_reports WHERE comment_id=? AND resolved_at IS NULL ORDER BY id',[item.id]);item.reports=reports;
      const [history]=await pool.execute(`SELECT h.action,h.state,h.version,h.body_snapshot,h.reasons_json,h.note,h.created_at,u.name AS actor_name
        FROM comment_moderation_history h INNER JOIN users u ON u.id=h.actor_id WHERE h.comment_id=? ORDER BY h.id DESC LIMIT 10`,[item.id]);item.history=history;
    }
    return {items,total,page,pages,pendingCount:await pendingCommentCount()};
  }
  return {addComment,editComment,reportComment,moderateComment,comments,ownPendingComments,pendingCommentCount,listComments};
}
module.exports={createCommentModerationStore,REPORT_REASONS};
