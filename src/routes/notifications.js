'use strict';
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const requireNotifications = (req,res,next) => requireAuth(req,res,()=>{
  if(['student','admin'].includes(req.user.role))return next();
  next(Object.assign(new Error('User or administrator access is required.'),{status:403}));
});
function notificationRoutes(store) {
  const router = express.Router();
  router.get('/notifications', requireNotifications, async (req, res) => {
    res.render('student/notifications', { title: 'Notifications', active: req.user.role==='admin'?'activity':'notifications', query: {}, result: await store.listNotifications(req.user.id, { page: req.query.page }) });
  });
  router.get('/api/notifications/unread', requireNotifications, async (req, res) => {
    res.json({ unreadCount: await store.unreadNotificationCount(req.user.id) });
  });
  router.post('/notifications/read-all', requireNotifications, async (req, res) => {
    await store.readAllNotifications(req.user.id, req.body.throughId);
    res.redirect('/notifications');
  });
  router.post('/notifications/:id/read', requireNotifications, async (req, res) => {
    const target = await store.readNotification(req.user.id, req.params.id);
    res.redirect(target.ticketId ? (req.user.role==='admin'?'/admin/contact/':'/contact/')+target.ticketId : (req.user.role==='admin'?'/admin/feedback/':'/feedback/')+target.feedbackId);
  });
  return router;
}
module.exports = { notificationRoutes };
