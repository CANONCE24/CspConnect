'use strict';
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { requireStudent, requireSecurity, requireAdmin, requireAuth } = require('../middleware/auth');
const { TYPES, STATUSES, randomUUID } = require('../utils/emergency');
function emergencyRoutes(store, publish) {
  const router = express.Router();
  const renderForm = async (req, res, values = {}, errors = [], status = 200) => res.status(status).render('emergency/student', {
    title: 'Emergency Assistance', active: 'emergency', settings: await store.settings(), emergencyTypes: TYPES,
    values: { request_key: randomUUID(), ...values }, errors
  });
  router.get('/emergency', requireStudent, (req, res) => renderForm(req, res));
  router.post('/emergency/reports', requireStudent, rateLimit({ windowMs: 10 * 60 * 1000, limit: 20,
    keyGenerator: req => String(req.user.id), standardHeaders: 'draft-8', legacyHeaders: false,
    message: 'Too many attempts. Call official emergency channels directly for urgent help.' }), async (req, res) => {
    let report;
    try { report = await store.submit(req.user, req.body); }
    catch (error) { if (error.status === 422) return renderForm(req, res, req.body, [error.message], 422); throw error; }
    // A failed delivery must never turn a committed submission into a failed submission.
    await publish(report);
    req.session.flash = { type: 'success', message: 'Emergency report submitted.' };
    res.redirect('/emergency/reports/' + report.id);
  });
  router.get('/emergency/reports/:id', requireStudent, async (req, res) => res.render('emergency/detail', {
    title: 'Emergency Report', active: 'emergency', report: await store.detail(req.user, req.params.id), settings: await store.settings(), emergencyStatuses: STATUSES
  }));
  router.get('/security', requireSecurity, async (req, res) => res.render('emergency/security', {
    title: 'Security Emergency Dashboard', active: 'emergency', settings: await store.settings()
  }));
  router.get('/security/reports/:id', requireSecurity, async (req, res) => res.render('emergency/detail', {
    title: 'Emergency Details', active: 'emergency', report: await store.detail(req.user, req.params.id), settings: await store.settings(), emergencyStatuses: STATUSES
  }));
  router.post('/security/reports/:id/status', requireSecurity, async (req, res) => {
    const report = await store.updateStatus(req.user, req.params.id, req.body.status);
    await publish(report);
    if (req.accepts(['html', 'json']) === 'json') return res.json({ report });
    res.redirect('/security/reports/' + report.id);
  });
  router.post('/security/reports/:id/respond', requireSecurity, async (req, res) => {
    const report = await store.respond(req.user, req.params.id);
    await publish(report);
    if (req.accepts(['html', 'json']) === 'json') return res.json({ report });
    res.redirect('/security/reports/' + report.id);
  });
  router.get('/api/emergencies', requireAuth, async (req, res) => res.json(await store.list(req.user, { history: req.query.history === '1', page: req.query.page })));
  router.get('/api/emergencies/:id', requireAuth, async (req, res) => res.json({ report: await store.detail(req.user, req.params.id) }));
  router.get('/admin/emergency-settings', requireAdmin, async (_req, res) => res.render('emergency/settings', {
    title: 'Emergency Settings', active: 'emergency', settings: await store.settings()
  }));
  router.post('/admin/emergency-settings', requireAdmin, async (req, res) => {
    await store.saveSettings(req.user, req.body);
    req.session.flash = { type: 'success', message: 'Emergency settings saved and audited.' };
    res.redirect('/admin/emergency-settings');
  });
  return router;
}
module.exports = { emergencyRoutes };
