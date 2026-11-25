'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const request = require('supertest');
const { fixtureApp, fixtureStore } = require('./support');
const { phone, reportInput, settingsInput, roleFor } = require('../src/utils/emergency');
const input = () => ({ type: 'Medical', location: 'CSPC Library', description: 'Test report: assistance requested at entrance.', contact_number: '', request_key: randomUUID() });

test('emergency validation, contact configuration, and role allowlists', () => {
  for (const value of ['', 'not a number', '123', 'tel:+1234567', '+0000000', '<script>']) assert.equal(phone(value), null);
  assert.equal(phone('+63 (912) 345-6789'), '+639123456789');
  assert.equal(reportInput(input()).contact_number, null);
  for (const changes of [{ type: 'Fake' }, { location: '' }, { description: 'tiny' }, { contact_number: 'bad' }, { request_key: '../a' }, { location: ['Room'] }]) assert.throws(() => reportInput({ ...input(), ...changes }), { status: 422 });
  assert.throws(() => settingsInput({ guardhouse_number: 'invalid', escalation_minutes: 3 }), { status: 422 });
  assert.throws(() => settingsInput({ escalation_minutes: 0 }), { status: 422 });
  assert.equal(settingsInput({ guardhouse_number: '+639123456789', number_verified: '1', escalation_minutes: '2' }).number_verified, true);
  const config = { adminEmails: [], securityEmails: ['guard@example.test'] };
  assert.equal(roleFor({ email: 'guard@example.test', role: 'student' }, config), 'student');
  assert.equal(roleFor({ email: 'guard@example.test', role: 'security',email_verified_at:new Date(),session_version:0 }, config), 'security');
  assert.equal(roleFor({ email: 'unknown@example.test', role: 'security' }, config), 'student');
});

test('emergency HTTP pages, role denial, CSRF, and saved submission surviving live-delivery failure', async () => {
  const accounts = fixtureStore(); accounts.users.push({ id: 844, name: 'Guard', email: 'guard@example.test', role: 'security',email_verified_at:new Date(),session_version:0 });
  const reports = [];
  const emergencyStore = {
    settings: async () => ({ guardhouse_number: '', number_verified: false, call_number: null, escalation_minutes: 3 }),
    submit: async (user, values) => { const row = { ...reportInput(values), id: randomUUID(), reporter_id: user.id, status: 'Submitted' }; reports.push(row); return row; },
    detail: async (user, id) => { const row = reports.find(row => row.id === id && (user.role === 'security' || row.reporter_id === user.id)); if (!row) { const error = new Error('Missing'); error.status = 404; throw error; } return { ...row, history: [], created_at: new Date() }; },
    list: async user => { if (!['student', 'security'].includes(user.role)) { const error = new Error('Denied'); error.status = 403; throw error; } return { reports: reports.filter(row => user.role === 'security' || row.reporter_id === user.id) }; }
  };
  const { app, cookies, csrfToken } = await fixtureApp({ store: accounts, emergencyStore, config: { securityEmails: ['guard@example.test'] }, userIds: { owner: 841, other: 843, admin: 842, guard: 844 } });
  const page = await request(app).get('/emergency').set('Cookie', cookies.owner).expect(200);
  assert.match(page.text, /UNAVAILABLE/); assert.ok(!page.text.includes('href="tel:'));
  await request(app).get('/security').set('Cookie', cookies.guard).expect(200);
  await request(app).get('/').set('Cookie', cookies.guard).expect(302).expect('Location', '/security');
  await request(app).get('/security').set('Cookie', cookies.owner).expect(403);
  await request(app).get('/security').set('Cookie', cookies.admin).expect(403);
  await request(app).get('/api/emergencies').expect(401);
  await request(app).get('/api/emergencies').set('Cookie', cookies.admin).expect(403);
  await request(app).post('/emergency/reports').set('Cookie', cookies.owner).send(input()).expect(403);
  app.locals.publishEmergency = async () => { throw new Error('Simulated delivery failure'); };
  const response = await request(app).post('/emergency/reports').set('Cookie', cookies.owner).send({ ...input(), _csrf: csrfToken }).expect(302);
  assert.equal(reports.length, 1); assert.match(response.headers.location, /\/emergency\/reports\//);
  await request(app).get(response.headers.location).set('Cookie', cookies.owner).expect(200);
  await request(app).get('/api/emergencies/' + reports[0].id).set('Cookie', cookies.other).expect(404);
  assert.equal((await request(app).get('/api/emergencies').set('Cookie', cookies.other)).body.reports.length, 0);
  accounts.users.find(user => user.id === 844).role = 'student';
  await request(app).get('/security').set('Cookie', cookies.guard).expect(403);
});
