'use strict';
const express = require('express');
const {requireAuth} = require('../middleware/auth');
const {CAMPUS_AFFILIATIONS, needsAffiliation, prepareAffiliation, destinationFor} = require('../services/affiliation');
function affiliationRoutes(store, config) {
  const router = express.Router();
  const nextPage = (user,req) => destinationFor(user,req,config.cspcEmailDomains);
  const render = (res, message = null, status = 200) => res.status(status).render('auth/complete-profile', {
    title:'Complete Your Profile', active:'', affiliations:CAMPUS_AFFILIATIONS, message, flash:null
  });
  router.get('/complete-profile', requireAuth, async (req,res) => {
    req.user = await prepareAffiliation(store, req.user, config.cspcEmailDomains);
    res.locals.user = req.user;
    if (!req.user.email_verified_at) return res.status(403).render('error', {status:403, message:'Verify your email before choosing an affiliation.'});
    if (!needsAffiliation(req.user, config.cspcEmailDomains)) return res.redirect(nextPage(req.user,req));
    render(res);
  });
  router.post('/complete-profile', requireAuth, async (req,res,next) => {
    try {
      const state = await store.ensureAffiliation(req.user.id, config.cspcEmailDomains, req.body.affiliation ?? '');
      req.user = {...req.user, ...state};
      req.session.flash = {type:'success', message:'Your affiliation has been saved. Welcome to CSPConnect.'};
      res.redirect(nextPage(req.user,req));
    } catch (error) {
      if (error.status === 422) return render(res, error.message, 422);
      next(error);
    }
  });
  router.use(async (req,res,next) => {
    if (!req.isAuthenticated()) return next();
    req.user = await prepareAffiliation(store, req.user, config.cspcEmailDomains);
    res.locals.user = req.user;
    if (!needsAffiliation(req.user, config.cspcEmailDomains)) return next();
    if (req.path.startsWith('/api/')) return res.status(403).json({error:'Complete your profile before continuing.', redirect:'/complete-profile'});
    res.redirect('/complete-profile');
  });
  return router;
}
module.exports = {affiliationRoutes};
