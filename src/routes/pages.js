'use strict';
const express = require('express');
const { requireAuth, requireStudent, requireAdmin } = require('../middleware/auth');
const { TYPES, STATUSES } = require('../utils/constants');
const { text, id, bounded, httpError } = require('../utils/validation');
const { upload, saveImage, removeImage, sendImage } = require('../services/uploads');
const { askProfessor } = require('../services/professor');
const { templatesFor, validateUpdate, METHODS } = require('../services/responseTemplates');
const { REPORT_REASONS } = require('../models/comment-moderation');
const { randomUUID } = require('node:crypto');
const { rateLimit } = require('express-rate-limit');
function pagesRoutes(store, config, professorLimiter, emailOutbox, supportStore=store) {
  const router = express.Router();
  const commentLimit = rateLimit({windowMs:10*60*1000,limit:30,keyGenerator:req=>String(req.user.id),standardHeaders:'draft-8',legacyHeaders:false,message:'Too many comment changes. Wait a few minutes and try again.'});
  const reportLimit = rateLimit({windowMs:10*60*1000,limit:10,keyGenerator:req=>String(req.user.id),standardHeaders:'draft-8',legacyHeaders:false,message:'Too many reports. Wait a few minutes and try again.'});
  const feedbackId = req => {
    const n = id(req.params.id); if (!n) throw httpError(404, 'Feedback was not found.'); return n;
  };
  const queryFor = req => ({
    search: text(req.query.q).slice(0, 150), type: TYPES.includes(req.query.type) ? req.query.type : '',
    status: STATUSES.includes(req.query.status) ? req.query.status : '',
    categoryId: id(req.query.category) || '', page: Math.min(id(req.query.page) || 1, 100000), limit: 12
  });
  const queryUI = req => ({ q: text(req.query.q).slice(0,150), type: text(req.query.type),
    status: text(req.query.status), category: text(req.query.category), visibility: text(req.query.visibility), page: id(req.query.page) || 1 });
  const communitySort = req => ['trending', 'most_supported', 'newest'].includes(req.query.sort) ? req.query.sort : 'newest';
  const statsUI = stats => ({ ...stats, under_review: stats.underReview, in_progress: stats.inProgress });
  const flash = (req, message) => { req.session.flash = { type: 'success', message }; };
  const privateDetail = async req => {
    const f = await store.detail(feedbackId(req), { userId: req.user.id, admin: req.user.role === 'admin' });
    if (!f) throw httpError(404, 'Feedback was not found.'); return f;
  };
  router.get('/', (req, res) => res.redirect(req.user ? (req.user.role === 'admin' ? '/admin' : req.user.role === 'security' ? '/security' : '/dashboard') : '/login'));
  router.get('/dashboard', requireStudent, async (req, res) => {
    const [stats, recent, community] = await Promise.all([
      store.stats(req.user.id), store.listFeedback({ userId: req.user.id, limit: 5 }),
      store.listFeedback({ publicOnly: true, viewerId: req.user.id, limit: 3 })
    ]);
    res.render('student/dashboard', { title: 'Dashboard', active: 'dashboard', stats: statsUI(stats), recent: recent.items, community: community.items });
  });
  router.get('/feedback/new', requireStudent, async (req,res) => {
    res.render('student/submit', { title: 'Submit Feedback', active: 'submit', categories: await store.categories(), values: {}, errors: [] });
  });
  router.post('/feedback', requireStudent, upload, async (req,res,next) => {
    let image;
    try {
      const values = { type: text(req.body.type), categoryId: id(req.body.categoryId), title: bounded(req.body.title,'Title',5,150),
        description: bounded(req.body.description,'Description',10,10000), isAnonymous: req.body.isAnonymous === '1' };
      if (!TYPES.includes(values.type)) throw httpError(422,'Choose a valid feedback type.');
      const categories = await store.categories();
      if (!categories.some(c => Number(c.id) === values.categoryId)) throw httpError(422,'Choose an active category.');
      image = await saveImage(req.file);
      const result = await store.submit(req.user.id, { ...values, ...image });
      req.session.flash = {
        type: 'success',
        title: 'Feedback submitted successfully',
        message: 'Feedback submitted. Your reference number is ' + result.reference + '.',
        description: 'Your feedback has been received. Keep this reference number to track updates in My Feedback.',
        reference: result.reference
      };
      res.redirect('/feedback/' + result.id);
    } catch (error) {
      if (image) await removeImage(image.attachmentPath);
      if (error.status === 422) return res.status(422).render('student/submit', {
        title: 'Submit Feedback', active: 'submit', categories: await store.categories(),
        values: req.body, errors: [error.message]
      });
      next(error);
    }
  });
  router.get('/feedback', requireStudent, async (req,res) => {
    res.render('student/feedback', { title: 'My Feedback', active: 'feedback', categories: await store.categories(),
      query: queryUI(req), result: await store.listFeedback({ ...queryFor(req), userId: req.user.id }) });
  });
  router.get('/feedback/:id', requireStudent, async (req,res) => {
    res.render('student/detail', { title: 'Feedback Details', active: 'feedback', feedback: await privateDetail(req) });
  });
  router.get('/attachments/:id', requireAuth, async (req,res) => {
    const n = feedbackId(req);
    const f = await store.detail(n, { userId: req.user.id, admin: req.user.role === 'admin' });
    const record = f || await store.attachmentForPublished(n);
    const filename = record?.attachment_path;
    if (!filename || !/^[a-f0-9-]+\.webp$/.test(filename)) throw httpError(404,'Attachment was not found.');
    res.set('Cache-Control','private, no-store');
    res.set('Content-Disposition','inline; filename="feedback-image.webp"');
    await sendImage(res, filename);
  });
  router.get('/community', requireAuth, async (req,res) => {
    const sort = communitySort(req);
    res.render('community/feed', { title: 'Community Feed', active: 'community', query: { ...queryUI(req), sort },
      categories: await store.categories(true), result: await store.listFeedback({ ...queryFor(req), publicOnly: true, viewerId: req.user.id, sort,
        visibility: ['published', 'private'].includes(req.query.visibility) ? req.query.visibility : '' }) });
  });
  router.get('/community/:id', requireAuth, async (req,res) => {
    const n = feedbackId(req);
    const f = await store.detail(n, { publicOnly: true });
    if (!f) throw httpError(404,'This community feedback is not available.');
    const [comments,reaction,pendingComments] = await Promise.all([store.comments(n,{viewerId:req.user.id}),store.reactionFor(n,req.user.id),
      req.user.role==='student'&&store.ownPendingComments ? store.ownPendingComments(n,req.user.id) : []]);
    res.render('community/detail', { title:'Community Discussion',active:'community',feedback:f,comments,reaction,pendingComments,reportReasons:REPORT_REASONS,newActionKey:randomUUID });
  });
  router.post('/community/:id/reaction', requireStudent, async (req,res) => {
    const kind = text(req.body.kind);
    if (!['support','not_helpful','remove'].includes(kind)) throw httpError(422,'Choose a valid reaction.');
    const json = req.accepts(['html', 'json']) === 'json';
    const result = await store.react(feedbackId(req), req.user.id, kind, { withCounts: json });
    if (json) return res.json(result);
    res.redirect('/community/' + feedbackId(req));
  });
  router.post('/community/:id/comments', requireStudent, commentLimit, async (req,res) => {
    const result=await store.addComment(feedbackId(req),req.user.id,bounded(req.body.body,'Comment',1,500),{requestKey:req.body.request_key});
    flash(req,result?.pending?'Your comment has been submitted and is pending moderation.':'Your comment was added.');res.redirect('/community/'+feedbackId(req));
  });
  router.post('/community/:id/comments/:commentId/edit',requireStudent,commentLimit,async(req,res)=>{
    const result=await store.editComment(feedbackId(req),req.params.commentId,req.user.id,bounded(req.body.body,'Comment',1,500),{version:req.body.version,requestKey:req.body.request_key});
    flash(req,result.pending?'Your comment has been submitted and is pending moderation.':'Your comment was updated.');res.redirect('/community/'+feedbackId(req)+'#discussion');
  });
  router.post('/community/:id/comments/:commentId/report',requireStudent,reportLimit,async(req,res)=>{
    const result=await store.reportComment(feedbackId(req),req.params.commentId,req.user.id,req.body.reason,bounded(req.body.details || '','Report details',0,300));
    flash(req,result.changed?'Your report was sent for administrator review.':'You have already reported this comment.');res.redirect('/community/'+feedbackId(req)+'#discussion');
  });
  router.get('/aizen', requireStudent, (_req,res) => res.redirect('/professor'));
  router.get('/professor', requireStudent, (req,res) => res.render('student/professor', {
    title: 'Professor Assistant', active: 'professor', geminiEnabled: Boolean(config.geminiApiKey) }));
  router.post(['/api/professor','/api/aizen'], requireStudent, professorLimiter, async (req,res) => {
    const message = bounded(req.body.message,'Message',1,1000);
    res.json({ reply: await askProfessor(message,config) });
  });
  router.get('/admin', requireAdmin, async (req,res) => {
    const [stats,recent,attention,community,mostSupported,pendingComments,openSupportTickets] = await Promise.all([
      store.stats(),store.listFeedback({limit:6}),store.listFeedback({status:'Submitted',limit:5}),
      store.listFeedback({publicOnly:true,limit:4}),store.listFeedback({publicOnly:true,sort:'most_supported',limit:5}),store.pendingCommentCount?store.pendingCommentCount():0,
      supportStore.openSupportTicketCount?supportStore.openSupportTicketCount(req.user):0
    ]);
    res.render('admin/dashboard',{title:'Admin Dashboard',active:'dashboard',stats:statsUI(stats),
      recent:recent.items,attention:attention.items,community:community.items,mostSupported:mostSupported.items,pendingComments,openSupportTickets});
  });
  router.get('/admin/feedback',requireAdmin,async (req,res) => {
    const affiliation = require('../services/affiliation').AFFILIATIONS.includes(req.query.affiliation) ? req.query.affiliation : '';
    res.render('admin/feedback',{title:'Feedback Management',active:'feedback',categories:await store.categories(true),
      query:{...queryUI(req),affiliation},result:await store.listFeedback({...queryFor(req), affiliation, visibility: text(req.query.visibility)})});
  });
  const showFeedbackUpdate = (res, feedback, draft = {}, updateError = null) => {
    const defaults = {
      actionTaken:[...(feedback.history || [])].reverse().find(entry => entry.resolution_summary)?.resolution_summary || '',
      closureReason:[...(feedback.history || [])].reverse().find(entry => entry.rejection_reason)?.rejection_reason || ''
    };
    const values = {...defaults,...draft};
    return res.render('admin/detail', {
      title:'Feedback Details',active:'feedback',feedback,updateError,
      updateDraft:Object.fromEntries(['status','response','actionTaken','closureReason','notificationMethod'].map(key => [key,typeof values[key] === 'string' ? values[key] : ''])),
      responseTemplates:templatesFor(feedback),actionKey:require('node:crypto').randomUUID()
    });
  };
  router.get('/admin/feedback/:id',requireAdmin,async (req,res) => showFeedbackUpdate(res,await privateDetail(req)));
  async function approveFeedbackUpdate(req,res) {
    try {
      const input = { requestKey:req.body.request_key,response:req.body.response,notificationMethod:req.body.notificationMethod,
        actionTaken:req.body.actionTaken,closureReason:req.body.closureReason,actionConfirmed:req.body.actionConfirmed==='1',confirmed:req.body.confirmed==='1' };
      validateUpdate(req.body.status,input,{requireApproval:true});
      if (typeof input.requestKey !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestKey)) throw httpError(422,'Refresh the page before approving an update.');
      const result = await store.updateStatus(feedbackId(req),req.body.status,req.user.id,input);
      let message = 'Update and approved response saved. Notifications prepared via ' + METHODS[input.notificationMethod || 'both'] + '.';
      if (result?.changed === false) message = 'This update was already saved. No duplicate notifications were created.';
      else if (result?.emailFailed) message = 'Update and response saved. Email could not be queued for the student’s address. Review Email history to correct and retry it.';
      else if (result?.emailQueued) message = 'Update and response saved. Email queued' + (result.notificationMethod === 'both' ? ' and web notification created.' : '.');
      else if (result?.notificationMethod === 'web') message = 'Update and response saved. Web notification created.';
      req.session.flash={type:result?.emailFailed?'error':'success',message};res.redirect('/admin/feedback/'+feedbackId(req));
    } catch (error) {
      if (![422,409].includes(error.status)) throw error;
      res.status(error.status);return showFeedbackUpdate(res,await privateDetail(req),req.body,error.message);
    }
  }
  router.post('/admin/feedback/:id/status',requireAdmin,approveFeedbackUpdate);
  // Older clients share the same approval, validation and delivery path.
  router.post('/admin/feedback/:id/response',requireAdmin,async (req,res) => {
    req.body.response=req.body.response ?? req.body.body;
    req.body.status=(await privateDetail(req)).status;
    return approveFeedbackUpdate(req,res);
  });
  router.post('/admin/feedback/:id/publish',requireAdmin,async (req,res) => {
    if (!['1','0'].includes(req.body.published)) throw httpError(422,'Choose a valid publication action.');
    const published=req.body.published==='1';
    await store.publish(feedbackId(req),published,req.user.id);
    flash(req,published?'Feedback published to the Community Feed.':'Feedback removed from the Community Feed. The private record is retained.');
    res.redirect('/admin/feedback/'+feedbackId(req));
  });
  const moderationView = value => ['flagged','hidden'].includes(value)?value:'all';
  router.get('/admin/comments',requireAdmin,async (req,res) => res.render('admin/comments',{
    title:'Comment Moderation',active:'comments',query:{...queryUI(req),view:moderationView(req.query.view)},newActionKey:randomUUID,reportReasons:REPORT_REASONS,
    result:await store.listComments({search:text(req.query.q).slice(0,150),page:id(req.query.page)||1,view:moderationView(req.query.view)})}));
  router.post('/admin/comments/:id/moderate',requireAdmin,async (req,res) => {
    const action=req.body.action || (req.body.hidden==='1'?'remove':req.body.hidden==='0'?'restore':'');
    if(!['approve','remove','restore'].includes(action)||!id(req.body.version))throw httpError(422,'Choose a valid action and refresh the queue before deciding.');
    if(action==='remove'&&req.body.confirmed!=='1')throw httpError(422,'Confirm removing this comment before submitting.');
    const result=await store.moderateComment(feedbackId(req),action,req.user.id,{version:id(req.body.version),requestKey:req.body.request_key,note:req.body.note || ''});
    flash(req,result?.changed===false?'This moderation action was already applied.':'Comment '+{approve:'approved',remove:'removed from public view',restore:'restored'}[action]+'.');
    const params=new URLSearchParams({view:moderationView(req.body.view)});if(text(req.body.q))params.set('q',text(req.body.q).slice(0,150));
    res.redirect('/admin/comments?'+params);
  });
  router.get('/admin/categories',requireAdmin,async (req,res) => res.render('admin/categories',{
    title:'Categories',active:'categories',categories:await store.categories(true)}));
  router.post('/admin/categories',requireAdmin,async (req,res) => {
    const categoryId=req.body.id ? id(req.body.id) : null;
    if (req.body.id && !categoryId) throw httpError(422,'Choose a valid category.');
    if (!['1','0'].includes(req.body.active)) throw httpError(422,'Choose a valid category state.');
    await store.categorySave({id:categoryId,name:bounded(req.body.name,'Category name',2,80),active:req.body.active==='1'});
    flash(req,'Category saved.');res.redirect('/admin/categories');
  });
  router.get('/admin/analytics',requireAdmin,async (req,res) => {
    const [stats, mostSupported] = await Promise.all([
      store.analytics ? store.analytics() : store.stats(),
      store.listFeedback({publicOnly:true,sort:'most_supported',limit:5})
    ]);
    res.render('admin/analytics',{title:'Analytics',active:'analytics',stats:statsUI(stats),mostSupported:mostSupported.items});
  });
  return router;
}
module.exports = { pagesRoutes };
