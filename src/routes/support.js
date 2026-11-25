'use strict';
const express = require('express');
const {randomUUID} = require('node:crypto');
const {rateLimit} = require('express-rate-limit');
const {requireStudent,requireAdmin} = require('../middleware/auth');
const {CATEGORIES,STATUSES} = require('../models/support');
const {text,id,httpError} = require('../utils/validation');
const EMAIL = 'canoncesam76@gmail.com';
const MAILTO = 'mailto:canoncesam76@gmail.com?subject=CSPConnect%20Support%20Inquiry';
const publicContactHelp = (_req,res)=>res.render('support/help',{contactEmail:EMAIL,contactMailto:MAILTO,title:'Contact Administrator',active:'',flash:null});
function supportRoutes(store) {
  const router=express.Router();
  const limit=(count,message)=>rateLimit({windowMs:10*60*1000,limit:count,keyGenerator:req=>String(req.user.id),standardHeaders:'draft-8',legacyHeaders:false,message});
  const submissions=limit(5,'Too many new support messages. Please wait a few minutes before creating another ticket.');
  const replies=limit(20,'Too many support updates. Please wait a few minutes and try again.');
  const locals={supportCategories:CATEGORIES,supportStatuses:STATUSES,contactEmail:EMAIL,contactMailto:MAILTO,newActionKey:randomUUID};
  const queries=req=>({status:STATUSES.includes(req.query.status)?req.query.status:'',q:text(req.query.q).slice(0,150)});
  const ticketId=req=>{const value=id(req.params.id);if(!value)throw httpError(404,'Support ticket was not found.');return value;};
  const flash=(req,message)=>{req.session.flash={type:'success',message};};
  const renderNew=(res,values={},error=null,key=randomUUID(),status=200)=>res.status(status).render('support/contact',{
    ...locals,title:'Contact Administrator',active:'contact',view:'new',values,formError:error,requestKey:key,result:null
  });
  router.get('/contact',requireStudent,async(req,res)=>{
    if(req.query.view!=='conversations')return renderNew(res);
    const query=queries(req);
    res.render('support/contact',{...locals,title:'My Conversations',active:'contact',view:'conversations',query,
      result:await store.listSupportTickets(req.user,{status:query.status,search:query.q,page:req.query.page}),values:{},formError:null,requestKey:''});
  });
  router.post('/contact',requireStudent,submissions,async(req,res,next)=>{
    try{
      const item=await store.createSupportTicket(req.user,{category:req.body.category,subject:req.body.subject,message:req.body.message,requestKey:req.body.request_key});
      flash(req,item.changed?`Message sent. Your private support ticket is ${item.reference}.`:'This message has already been sent.');
      res.redirect('/contact/'+item.id);
    }catch(error){if(error.status===422)return renderNew(res,req.body,error.message,randomUUID(),422);next(error);}
  });
  const showConversation=async(req,res,admin=false,formError=null,status=200,reply='')=>{
    const ticket=await store.supportTicketDetail(req.user,ticketId(req));
    res.status(status).render('support/conversation',{...locals,title:ticket.reference,active:'contact',ticket,admin,basePath:admin?'/admin/contact':'/contact',formError,reply});
  };
  router.get('/contact/:id',requireStudent,(req,res)=>showConversation(req,res));
  router.get('/admin/contact',requireAdmin,async(req,res)=>{
    const query=queries(req);
    res.render('support/inbox',{...locals,title:'Contact Messages',active:'contact',query,
      result:await store.listSupportTickets(req.user,{status:query.status,search:query.q,page:req.query.page})});
  });
  router.get('/admin/contact/:id',requireAdmin,(req,res)=>showConversation(req,res,true));
  const reply=(admin=false)=>async(req,res,next)=>{
    try{
      const result=await store.replyToSupportTicket(req.user,ticketId(req),{message:req.body.message,requestKey:req.body.request_key});
      flash(req,result.changed?'Your reply has been sent.':'This reply has already been sent.');res.redirect((admin?'/admin/contact/':'/contact/')+result.id);
    }catch(error){if([422,409].includes(error.status))return showConversation(req,res,admin,error.message,error.status,text(req.body.message).slice(0,5000));next(error);}
  };
  router.post('/contact/:id/reply',requireStudent,replies,reply());
  router.post('/admin/contact/:id/reply',requireAdmin,replies,reply(true));
  router.post('/admin/contact/:id/status',requireAdmin,replies,async(req,res,next)=>{
    try{
      await store.updateSupportStatus(req.user,ticketId(req),{status:req.body.status,version:req.body.version,requestKey:req.body.request_key});
      flash(req,'Ticket status saved.');res.redirect('/admin/contact/'+ticketId(req));
    }catch(error){if([422,409].includes(error.status))return showConversation(req,res,true,error.message,error.status);next(error);}
  });
  return router;
}
module.exports={supportRoutes,publicContactHelp,EMAIL,MAILTO};
