'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');
const request = require('supertest');
const { io: client } = require('socket.io-client');
require('dotenv').config({ quiet: true });
function once(socket, event) { return new Promise((resolve, reject) => { const timer = setTimeout(() => { socket.off(event, listener); reject(new Error('Timed out: ' + event)); }, 8000); const listener = data => { clearTimeout(timer); resolve(data); }; socket.once(event, listener); }); }
const input = () => ({ type: 'Medical', location: 'CSPC Library', description: 'Prototype test: student needs assistance near entrance.', contact_number: '', request_key: randomUUID() });

test('emergency real database, authenticated Socket.IO, recovery, browser audio and mobile flow', { skip: process.env.TEST_DB !== '1', timeout: 120000 }, async t => {
  const dbName = 'cspc_emergency_test_' + randomBytes(8).toString('hex');
  const connection = await mysql.createConnection({ host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', multipleStatements: false });
  const previousDb = process.env.DB_NAME;
  let pool, io, server, browser, sessions; const sockets = [];
  try {
    await connection.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await connection.changeUser({ database: dbName });
    const schema = await fs.readFile(path.join(__dirname, '../schema.sql'), 'utf8');
    for (const sql of schema.replace(/^\s*--.*$/gm, '').split(';').map(sql => sql.trim()).filter(Boolean)) await connection.query(sql);
    process.env.DB_NAME = dbName;
    pool = require('../src/config/db').pool;
    const accounts = require('../src/models/store');
    for (const [id, name, email, role] of [[841,'Student','private-student@example.test','student'],[842,'Admin','admin@example.test','admin'],[843,'Other','another@example.test','student'],[844,'Guard','guard@example.test','security']]) await pool.execute('INSERT INTO users (id,name,email,role,email_verified_at,password_verified_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3))', [id,name,email,role]);
    const { fixtureApp } = require('./support');
    const { createEmergencyStore } = require('../src/models/emergencies');
    const config = { guardhouseNumber: '', guardhouseNumberVerified: false, emergencyEscalationMinutes: 3 };
    const emergencyStore = createEmergencyStore(pool, config);
    const fixture = await fixtureApp({ store: accounts, emergencyStore, config: { ...config, securityEmails: ['guard@example.test'] }, userIds: { owner: 841, other: 843, admin: 842, guard: 844 } });
    const { app, cookies, csrfToken } = fixture; sessions = fixture.sessionStore;
    const student = await accounts.getUser(841), guard = await accounts.getUser(844), admin = await accounts.getUser(842);
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const baseUrl = 'http://127.0.0.1:' + server.address().port; app.locals.config.appUrl = baseUrl;
    io = require('../src/services/emergency-realtime').attachEmergencyRealtime(server, app, { escalationInterval: 60000 });
    const connect = (cookie, token = csrfToken) => { const socket = client(baseUrl, { autoConnect: false, reconnection: false, extraHeaders: { Cookie: cookie }, auth: { csrfToken: token } }); sockets.push(socket); return socket; };
    const guardSocket = connect(cookies.guard), studentSocket = connect(cookies.owner), otherSocket = connect(cookies.other);
    for (const socket of [guardSocket, studentSocket, otherSocket]) { const ready = once(socket, 'emergency:ready'); socket.connect(); await ready; }
    let report, second;
    await t.test('atomic submission, idempotency, audit log, ownership, notifications after save', async () => {
      const received = once(guardSocket, 'emergency:changed'); const own = once(studentSocket, 'emergency:changed');
      let leaked = false; const listener = () => { leaked = true; }; otherSocket.on('emergency:changed', listener);
      const values = input();
      const response = await request(app).post('/emergency/reports').set('Cookie', cookies.owner).send({ ...values, _csrf: csrfToken }).expect(302);
      const id = response.headers.location.split('/').at(-1); report = await emergencyStore.detail(student, id);
      assert.equal((await received).id, id); assert.equal((await own).id, id); assert.equal(leaked, false); otherSocket.off('emergency:changed', listener);
      assert.equal(report.status, 'Submitted'); assert.equal(report.acknowledged_at, null); assert.equal(report.history.length, 1);
      const duplicates = await Promise.all([emergencyStore.submit(student, values), emergencyStore.submit(student, values)]);
      assert.equal(duplicates[0].id, id); assert.equal(duplicates[1].id, id);
      await request(app).get('/api/emergencies/' + id).set('Cookie', cookies.other).expect(404);
      await assert.rejects(emergencyStore.submit(admin, input()), { status: 403 });
    });
    await t.test('concurrent emergencies, status sequencing, acknowledgment and student live status', async () => {
      const result = await Promise.all([emergencyStore.submit(student, input()), emergencyStore.submit(await accounts.getUser(843), input())]);
      second = result[0]; assert.equal(new Set([report.id, ...result.map(row => row.id)]).size, 3);
      await assert.rejects(emergencyStore.updateStatus(guard, report.id, 'Resolved'), { status: 409 });
      await assert.rejects(emergencyStore.updateStatus(student, report.id, 'Acknowledged'), { status: 403 });
      const live = once(studentSocket, 'emergency:changed');
      await request(app).post('/security/reports/' + report.id + '/status').set('Cookie', cookies.guard).set('Accept', 'application/json').send({ _csrf: csrfToken, status: 'Acknowledged' }).expect(200);
      assert.equal((await live).id, report.id);
      report = await emergencyStore.detail(student, report.id); assert.equal(report.acknowledged_by, guard.id); assert.ok(report.acknowledged_at);
      assert.equal((await emergencyStore.detail(student, second.id)).status, 'Submitted');
      await Promise.all([emergencyStore.updateStatus(guard, report.id, 'Responding'), emergencyStore.updateStatus(guard, report.id, 'Responding')]);
      report = await emergencyStore.updateStatus(guard, report.id, 'Resolved'); assert.ok(report.resolved_at); assert.equal(report.history.length, 4);
      assert.equal((await emergencyStore.list(guard, { history: true })).reports.length, 1);
    });
    await t.test('reconnect database recovery, handshake rejection, and revoked existing socket', async () => {
      guardSocket.disconnect();
      const outstanding = await emergencyStore.submit(await accounts.getUser(843), input()); await app.locals.publishEmergency(outstanding);
      const ready = once(guardSocket, 'emergency:ready'); guardSocket.connect(); await ready;
      const snapshot = await request(app).get('/api/emergencies').set('Cookie', cookies.guard).expect(200);
      assert.ok(snapshot.body.reports.some(row => row.id === outstanding.id)); assert.equal(new Set(snapshot.body.reports.map(row => row.id)).size, snapshot.body.reports.length);
      for (const socket of [connect('', csrfToken), connect(cookies.guard, 'wrong'), connect(cookies.admin)]) { const denied = once(socket, 'connect_error'); socket.connect(); await denied; socket.disconnect(); }
      app.locals.config.securityEmails = [];
      const revoked = once(guardSocket, 'disconnect'); await app.locals.publishEmergency(second); await revoked;
      app.locals.config.securityEmails = ['guard@example.test'];
    });
    await t.test('durable escalation, settings audit and configuration fallback', async () => {
      assert.equal((await emergencyStore.settings()).call_number, null);
      config.guardhouseNumber = 'invalid'; config.guardhouseNumberVerified = true; assert.equal((await emergencyStore.settings()).call_number, null);
      await emergencyStore.saveSettings(admin, { guardhouse_number: '+639123456789', number_verified: '1', escalation_minutes: 1 });
      await pool.execute('UPDATE emergency_reports SET created_at=DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 MINUTE) WHERE id=?', [second.id]);
      assert.equal((await emergencyStore.escalate()).filter(row => row.id === second.id).length, 1);
      assert.equal((await emergencyStore.escalate()).length, 0);
      const escalated = await emergencyStore.detail(guard, second.id); assert.ok(escalated.escalated_at); assert.equal(escalated.status, 'Submitted'); assert.equal(escalated.history.at(-1).action, 'Escalated');
      assert.equal((await emergencyStore.settings()).call_number, '+639123456789');
      const [[audit]] = await pool.query('SELECT COUNT(*) AS total FROM emergency_settings_history'); assert.equal(audit.total, 1);
      await assert.rejects(emergencyStore.saveSettings(student, { escalation_minutes: 1 }), { status: 403 });
    });
    await t.test('Respond action atomically acknowledges and starts response, is idempotent, and enforces role/CSRF', async () => {
      const incoming = await emergencyStore.submit(student, input());
      await assert.rejects(emergencyStore.respond(student, incoming.id), { status: 403 });
      await request(app).post('/security/reports/' + incoming.id + '/respond').set('Cookie', cookies.guard).send({}).expect(403);
      await request(app).post('/security/reports/' + incoming.id + '/respond').set('Cookie', cookies.owner).send({ _csrf: csrfToken }).expect(403);
      await Promise.all([emergencyStore.respond(guard, incoming.id), emergencyStore.respond(guard, incoming.id)]);
      const accepted = await emergencyStore.detail(guard, incoming.id);
      assert.equal(accepted.status, 'Responding'); assert.equal(accepted.acknowledged_by, guard.id); assert.ok(accepted.acknowledged_at);
      assert.deepEqual(accepted.history.map(item => item.status), ['Submitted', 'Acknowledged', 'Responding']);
    });
    await t.test('database anti-spam persists beyond HTTP limiter and rejects sixth submission', async () => {
      while ((await pool.execute('SELECT COUNT(*) AS total FROM emergency_reports WHERE reporter_id=841'))[0][0].total < 5) await emergencyStore.submit(student, input());
      // One escalated record was backdated; bring it back inside the rate-limit window.
      await pool.execute('UPDATE emergency_reports SET created_at=UTC_TIMESTAMP() WHERE reporter_id=841');
      await assert.rejects(emergencyStore.submit(student, input()), { status: 429 });
    });
    await t.test('browser live popup, audio, independent acknowledgment, offline recovery, mobile form and tel link', async () => {
      const { existsSync } = require('node:fs');
      const executablePath = process.env.BROWSER_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
      assert.ok(executablePath, 'Set BROWSER_PATH for browser verification');
      browser = await require('playwright-core').chromium.launch({ executablePath, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const addCookie = (ctx, cookie) => ctx.addCookies([{ name: 'cspc.sid', value: cookie.slice('cspc.sid='.length), url: baseUrl }]);
      await addCookie(context, cookies.guard); const page = await context.newPage(); const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      // Instrument the real AudioContext to count oscillator starts while keeping the native audio behavior.
      await page.addInitScript(() => { window.__alarmStarts = 0; const start = OscillatorNode.prototype.start; OscillatorNode.prototype.start = function(...args) { window.__alarmStarts++; window.__alarmContext = this.context; return start.apply(this, args); }; });
      await page.addInitScript(() => { const resume = AudioContext.prototype.resume; AudioContext.prototype.resume = function(...args) { window.__alarmContext = this; return resume.apply(this, args); }; });
      await page.goto(baseUrl + '/security'); await page.waitForFunction(() => document.querySelector('[data-connection]').dataset.state === 'connected');
      assert.equal(await page.locator('[data-next-page]').isVisible(), false);
      const popup = page.locator('[data-emergency-dialog]');
      await popup.waitFor({ state: 'visible' });
      assert.equal(await page.locator('[data-enable-alarm]').count(), 0);
      await page.waitForFunction(() => window.__alarmStarts > 0);
      while (await popup.isVisible()) {
        const count = await popup.locator('[data-alarm-reports] article').count();
        await popup.getByRole('button', { name: 'Respond to Emergency', exact: true }).first().click();
        await page.waitForFunction(count => !document.querySelector('[data-emergency-dialog]').open || document.querySelectorAll('[data-alarm-reports] article').length < count, count);
      }
      await popup.waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => window.__alarmContext.state), 'running');
      assert.equal(await page.locator('[data-emergency-app] [data-connection]').isVisible(), false);
      assert.equal(await page.locator('[data-emergency-app] [data-audio-status]').isVisible(), false);
      assert.equal(await page.locator('.emergency-stat').count(), 3);
      assert.ok(!(await page.locator('body').innerText()).includes('synchronized from the database'));
      await page.getByRole('button', { name: 'Needs response', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('[data-emergency-list]').textContent.includes('No reports need a response'));
      await page.getByRole('button', { name: 'All active', exact: true }).click();
      assert.equal(await page.locator('[data-emergency-attention]').evaluate(el => el.classList.contains('is-alerting')), false);
      const startsBeforeReport = await page.evaluate(() => window.__alarmStarts);
      const fresh = await emergencyStore.submit(await accounts.getUser(843), input()); await app.locals.publishEmergency(fresh);
      await popup.locator('[data-report-id="' + fresh.id + '"]').waitFor();
      assert.equal(await page.locator('[data-emergency-attention] .emergency-signal').evaluate(el => getComputedStyle(el).animationName), 'emergency-soft-pulse');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      assert.equal(await page.locator('[data-emergency-attention] .emergency-signal').evaluate(el => getComputedStyle(el).animationName), 'none');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      // No second enable click: the incoming report starts and repeats the alarm automatically.
      await page.waitForFunction(count => window.__alarmStarts >= count + 6, startsBeforeReport, { timeout: 8000 });
      await page.keyboard.press('Escape'); assert.equal(await popup.isVisible(), true);
      assert.equal((await emergencyStore.detail(guard, fresh.id)).status, 'Submitted');
      await page.screenshot({ path: path.join(__dirname, '../docs/qa/emergency-alarm-popup.png') });
      await page.route('**/security/reports/' + fresh.id + '/respond', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Simulated response failure' }) }));
      await popup.getByRole('button', { name: 'Respond to Emergency', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('[data-emergency-dialog] [data-live-error]').textContent.includes('Simulated response failure'));
      assert.equal(await popup.isVisible(), true);
      assert.equal((await emergencyStore.detail(guard, fresh.id)).status, 'Submitted');
      await page.unroute('**/security/reports/' + fresh.id + '/respond');
      await popup.getByRole('button', { name: 'Respond to Emergency', exact: true }).click();
      await popup.waitFor({ state: 'hidden' });
      const stoppedStarts = await page.evaluate(() => window.__alarmStarts);
      await page.waitForTimeout(2200); // Longer than a complete alarm cycle: stopping must cancel repetition.
      assert.equal(await page.evaluate(() => window.__alarmStarts), stoppedStarts);
      assert.equal((await emergencyStore.detail(guard, fresh.id)).status, 'Responding');
      const activeReport = page.locator('[data-emergency-list] [data-report-id="' + fresh.id + '"]');
      await activeReport.getByRole('button', { name: 'Mark Resolved', exact: true }).click();
      await page.waitForFunction(id => !document.querySelector('[data-emergency-list] [data-report-id="' + id + '"]'), fresh.id);
      const resolved = await emergencyStore.detail(guard, fresh.id);
      assert.equal(resolved.status, 'Resolved'); assert.ok(resolved.resolved_at); assert.equal(resolved.history.length, 4);
      await context.setOffline(true); await page.waitForFunction(() => document.querySelector('[data-connection]').textContent.includes('Offline'));
      const missed = await emergencyStore.submit(await accounts.getUser(843), input()); await app.locals.publishEmergency(missed);
      await context.setOffline(false); await page.locator('[data-emergency-list] [data-status="Submitted"][data-report-id="' + missed.id + '"]').waitFor();
      await popup.locator('[data-report-id="' + missed.id + '"]').waitFor();
      await popup.getByRole('button', { name: 'Respond to Emergency', exact: true }).click();
      await page.waitForFunction(id => !document.querySelector('[data-emergency-list] [data-status="Submitted"][data-report-id="' + id + '"]'), missed.id);
      const alerts = await page.locator('[data-emergency-list] [data-status="Submitted"]').count(); await page.reload();
      await page.waitForFunction(total => document.querySelectorAll('[data-emergency-list] [data-status="Submitted"]').length === total, alerts);
      assert.equal(await page.locator('[data-emergency-list] [data-status="Submitted"][data-report-id="' + missed.id + '"]').count(), 0);
      assert.equal(await popup.isVisible(), false, 'Accepted reports must not reopen on reload/reconnect');
      await fs.mkdir(path.join(__dirname, '../docs/qa'), { recursive: true });
      await page.screenshot({ path: path.join(__dirname, '../docs/qa/emergency-security.png') });
      const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); await addCookie(mobile, cookies.other);
      const studentPage = await mobile.newPage(); studentPage.on('pageerror', error => errors.push(error.message));
      await studentPage.goto(baseUrl + '/emergency');
      assert.equal(await studentPage.getByRole('link', { name: 'CALL GUARDHOUSE', exact: true }).getAttribute('href'), 'tel:+639123456789');
      assert.equal(await studentPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await studentPage.screenshot({ path: path.join(__dirname, '../docs/qa/emergency-student-mobile.png'), fullPage: true });
      const desktopStudent = await browser.newContext({ viewport: { width: 1365, height: 1000 } });
      await addCookie(desktopStudent, cookies.other);
      const desktopPage = await desktopStudent.newPage();
      await desktopPage.goto(baseUrl + '/emergency');
      assert.equal(await desktopPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await desktopPage.screenshot({ path: path.join(__dirname, '../docs/qa/emergency-student-desktop.png') });
      await desktopStudent.close();
      // Avoid quota interference; earlier test reports belong only to this temporary database.
      await pool.execute('UPDATE emergency_reports SET created_at=DATE_SUB(UTC_TIMESTAMP(), INTERVAL 11 MINUTE) WHERE reporter_id=843');
      await studentPage.selectOption('#type', 'Fire'); await studentPage.fill('#location', 'Engineering Building'); await studentPage.fill('#description', 'Browser prototype test report only.');
      await studentPage.getByRole('button', { name: 'Submit Emergency Report', exact: true }).click();
      await studentPage.waitForURL('**/emergency/reports/*'); const mobileId = studentPage.url().split('/').at(-1);
      assert.match(await studentPage.locator('body').innerText(), /Emergency report submitted/);
      await popup.locator('[data-report-id="' + mobileId + '"]').waitFor();
      await emergencyStore.updateStatus(guard, mobileId, 'Acknowledged'); await app.locals.publishEmergency(await emergencyStore.detail(guard, mobileId));
      await studentPage.waitForFunction(() => document.querySelector('[data-report-status]').textContent === 'Acknowledged');
      assert.equal(await popup.isVisible(), true, 'A status change must not silently dismiss the alarm');
      await popup.getByRole('button', { name: 'Respond to Emergency', exact: true }).click();
      await popup.waitFor({ state: 'hidden' });
      const remaining = (await emergencyStore.list(guard)).reports.filter(report => report.status === 'Submitted');
      for (const report of remaining) await emergencyStore.updateStatus(guard, report.id, 'Acknowledged');
      if (remaining.length) await app.locals.publishEmergency(remaining[0]);
      await page.waitForFunction(() => !document.querySelector('[data-emergency-attention]').classList.contains('is-alerting'));
      assert.equal(await page.locator('[data-alert-count]').innerText(), '0');
      assert.deepEqual(errors, []);
      await context.close(); await mobile.close();
    });
    await t.test('security detail and account pages receive new popup alarms, including on mobile', async () => {
      assert.ok(browser);
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      await context.addCookies([{ name: 'cspc.sid', value: cookies.guard.slice('cspc.sid='.length), url: baseUrl }]);
      const page = await context.newPage(); const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      try {
        await page.goto(baseUrl + '/security/reports/' + report.id);
        await page.waitForFunction(() => document.querySelector('[data-connection]').dataset.state === 'connected');
        const first = await emergencyStore.submit(await accounts.getUser(843), input()); await app.locals.publishEmergency(first);
        const popup = page.locator('[data-emergency-dialog]');
        await popup.locator('[data-report-id="' + first.id + '"]').waitFor();
        await popup.getByRole('button', { name: 'Respond to Emergency', exact: true }).click();
        await popup.waitFor({ state: 'hidden' });
        assert.equal((await emergencyStore.detail(guard, first.id)).status, 'Responding');
        await page.goto(baseUrl + '/account');
        await page.waitForFunction(() => document.querySelector('[data-security-alarm] [data-connection]').dataset.state === 'connected');
        assert.equal(await popup.isVisible(), false);
        const reporter = await accounts.getUser(843);
        const [second, third] = await Promise.all([emergencyStore.submit(reporter, input()), emergencyStore.submit(reporter, input())]);
        await app.locals.publishEmergency(second); await app.locals.publishEmergency(third);
        await popup.locator('[data-report-id="' + second.id + '"]').waitFor();
        await popup.locator('[data-report-id="' + third.id + '"]').waitFor();
        assert.equal(await popup.locator('[data-alarm-reports] article').count(), 2);
        assert.equal(await popup.evaluate(el => el.getBoundingClientRect().width <= innerWidth), true);
        await page.screenshot({ path: path.join(__dirname, '../docs/qa/emergency-alarm-mobile.png') });
        await popup.locator('[data-report-id="' + second.id + '"]').getByRole('button', { name: 'Respond to Emergency', exact: true }).click();
        await page.waitForFunction(() => document.querySelectorAll('[data-alarm-reports] article').length === 1);
        assert.equal(await popup.isVisible(), true);
        assert.equal((await emergencyStore.detail(guard, third.id)).status, 'Submitted');
        await popup.getByRole('button', { name: 'Respond to Emergency', exact: true }).click();
        await popup.waitFor({ state: 'hidden' });
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
    await t.test('migration is repeatable and preserves reports', async () => {
      const [[before]] = await pool.query('SELECT COUNT(*) AS total FROM emergency_reports');
      await require('../scripts/migrate-emergency').migrate(pool); await require('../scripts/migrate-emergency').migrate(pool);
      const [[after]] = await pool.query('SELECT COUNT(*) AS total FROM emergency_reports'); assert.equal(after.total, before.total);
    });
  } finally {
    await browser?.close(); sockets.forEach(socket => socket.disconnect());
    if (io) await new Promise(resolve => io.close(resolve)); else if (server) await new Promise(resolve => server.close(resolve));
    sessions?.clear?.(() => {}); await pool?.end();
    if (previousDb === undefined) delete process.env.DB_NAME; else process.env.DB_NAME = previousDb;
    assert.match(dbName, /^cspc_emergency_test_[a-f0-9]{16}$/);
    await connection.query(`DROP DATABASE \`${dbName}\``); await connection.end();
  }
});
