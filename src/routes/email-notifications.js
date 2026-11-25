'use strict';
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { requireAdmin } = require('../middleware/auth');
const { emailConfigured } = require('../services/feedback-email');
function emailNotificationRoutes(outbox, config) {
  const router = express.Router();
  router.get('/admin/notifications', requireAdmin, async (req, res) => res.render('admin/notifications', {
    title: 'Email Notifications', active: 'notifications', emailEnabled: emailConfigured(config),
    result: await outbox.list(req.user, { state: req.query.state, page: req.query.page }), stateFilter: req.query.state || ''
  }));
  router.post('/admin/notifications/:id/retry', requireAdmin, rateLimit({windowMs:10*60*1000,limit:15,keyGenerator:req=>String(req.user.id),standardHeaders:'draft-8',legacyHeaders:false}), async (req, res) => {
    await outbox.retry(req.user, req.params.id, req.body.confirmed === '1');
    req.session.flash = { type: 'success', message: 'Email queued for another attempt.' };
    res.redirect('/admin/notifications');
  });
  return router;
}
module.exports = { emailNotificationRoutes };
