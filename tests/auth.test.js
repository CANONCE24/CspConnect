'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { fixtureApp } = require('./support');
const { createHash, verifyPassword } = require('../src/services/passwords');

const password = 'A-long-test-password!';
const changedPassword = 'A-new-long-password!';
const token = response => response.text.match(/name="csrf-token" content="([^"]+)"/)[1];
async function authenticationFixture(options = {}) {
  const fixture = await fixtureApp(options);
  const { store } = fixture;
  for (const user of store.users) {
    user.password_hash = await createHash(password);
    user.has_password = true;
  }
  store.passwordAccountByEmail = async email => store.users.find(user => user.email === email) || null;
  store.createPasswordAccount = async ({ name, email, passwordHash }) => {
    if (store.users.some(user => user.email === email)) { const error = new Error('An account may already exist for this email.'); error.status = 409; throw error; }
    const user = { id: 900 + store.users.length, name, email, password_hash: passwordHash, has_password: true, role: 'student' };
    store.users.push(user); return user;
  };
  store.changePassword = async (id, encoded) => {
    const user = store.users.find(item => item.id === id);
    user.password_hash = encoded; user.has_password = true; user.must_change_password = 0; user.session_version=(user.session_version || 0)+1;
  };
  store.syncAccountRole = async (id, role) => { store.users.find(item => item.id === id).role = role; };
  return fixture;
}

test('email sign-up stages a bcrypt password and requires OTP activation before creating an account', async () => {
  const { app, store } = await authenticationFixture({ config: { allowedEmailDomain: 'cspc.edu.ph' } });
  const agent=request.agent(app); const csrf=token(await agent.get('/signup').expect(200));
  const base={_csrf:csrf,name:'New Student',email:'student@gmail.com',password,passwordConfirmation:password};
  for(const invalid of [{name:''},{email:'bad'},{password:'short'},{passwordConfirmation:'mismatch'}])await agent.post('/auth/signup').send({...base,...invalid}).expect(422);
  await agent.post('/auth/signup').send({...base,role:'admin'}).expect(302).expect('Location','/verify-email');
  assert.equal(store.users.find(user=>user.email===base.email),undefined);
  const staged=store.calls.find(call=>call.name==='issueVerification').args[0];assert.match(staged.passwordHash,/^\$2b\$12\$/);assert.equal(await verifyPassword(password,staged.passwordHash),true);
  await agent.get('/verify-email').expect(200);
  await agent.get('/dashboard').expect(302).expect('Location','/login');
});

test('password changes validate the current password, show one error, and replace the old credential', async () => {
  const { app, store, cookies, csrfToken } = await authenticationFixture();
  const invalid = await request(app).post('/account/password').set('Cookie', cookies.owner)
    .send({ _csrf: csrfToken, password: 'short', passwordConfirmation: 'short' }).expect(422);
  assert.equal((invalid.text.match(/role="alert"/g) || []).length, 1);
  await request(app).post('/account/password').set('Cookie', cookies.owner)
    .send({ _csrf: csrfToken, currentPassword: 'wrong', password: changedPassword, passwordConfirmation: changedPassword }).expect(422);
  assert.equal(await verifyPassword(password, store.users[0].password_hash), true);
  await request(app).post('/account/password').set('Cookie', cookies.owner)
    .send({ _csrf: csrfToken, currentPassword: password, password: changedPassword, passwordConfirmation: changedPassword }).expect(302);
  assert.equal(await verifyPassword(changedPassword, store.users[0].password_hash), true);
  assert.equal(await verifyPassword(password, store.users[0].password_hash), false);
  const agent = request.agent(app);
  const loginToken = token(await agent.get('/login'));
  await agent.post('/auth/login').send({ _csrf: loginToken, email: store.users[0].email, password }).expect(302).expect('Location', '/login');
  const rejected = await agent.get('/login'); assert.match(rejected.text, /Email or password is incorrect/);
  assert.equal((rejected.text.match(/role="alert"/g) || []).length, 1);
  await agent.post('/auth/login').send({ _csrf: token(rejected), email: '  PRIVATE-STUDENT@EXAMPLE.TEST ', password: changedPassword }).expect(302).expect('Location', '/dashboard');
  await agent.get('/dashboard').expect(200);
});

test('password sign-in preserves provisioned roles and requires the server allowlist', async () => {
  for (const [adminEmails, email, expectedRole, landing] of [
    [[], 'admin@example.test', 'student', '/dashboard'],
    [['private-student@example.test'], 'private-student@example.test', 'student', '/dashboard'],
    [['admin@example.test'], 'admin@example.test', 'admin', '/admin']
  ]) {
    const { app, store } = await authenticationFixture({ config: { adminEmails } });
    const agent = request.agent(app);
    const csrf = token(await agent.get('/login'));
    await agent.post('/auth/login').send({ _csrf: csrf, email, password, role: 'admin' }).expect(302).expect('Location', landing);
    assert.equal(store.users.find(user => user.email === email).role, expectedRole);
    await agent.get(landing).expect(200);
  }
});

test('initial administrator password change is required before accessing app routes', async () => {
  const { app, store } = await authenticationFixture();
  store.users[1].must_change_password = 1;
  const agent = request.agent(app);
  const loginToken = token(await agent.get('/login'));
  await agent.post('/auth/login').send({ _csrf: loginToken, email: 'admin@example.test', password })
    .expect(302).expect('Location', '/account/password');
  for (const route of ['/admin', '/community', '/account']) await agent.get(route).expect(302).expect('Location', '/account/password');
  const form = await agent.get('/account/password').expect(200);
  await agent.post('/account/password').send({ _csrf: token(form), password: changedPassword, passwordConfirmation: changedPassword })
    .expect(302).expect('Location', '/admin');
  assert.equal(store.users[1].must_change_password, 0);
  await agent.get('/admin').expect(200);
});

test('removing admin access from an existing session also updates model authorization', async () => {
  const adminEmails = ['admin@example.test'];
  const { app, store } = await authenticationFixture({ config: { adminEmails } });
  const agent = request.agent(app);
  const csrf = token(await agent.get('/login'));
  await agent.post('/auth/login').send({ _csrf: csrf, email: 'admin@example.test', password }).expect(302).expect('Location', '/admin');
  await agent.get('/admin').expect(200);
  adminEmails.splice(0);
  await agent.get('/admin').expect(403);
  assert.equal(store.users.find(user => user.email === 'admin@example.test').role, 'student');
  await agent.get('/dashboard').expect(200);
});

test('Google-only users can add an email password without an existing password', async () => {
  const { app, store, cookies, csrfToken } = await authenticationFixture();
  store.users[0].password_hash = null; store.users[0].has_password = false;
  const form = await request(app).get('/account/password').set('Cookie', cookies.owner).expect(200);
  assert.doesNotMatch(form.text, /id="current-password"/);
  await request(app).post('/account/password').set('Cookie', cookies.owner)
    .send({ _csrf: csrfToken, password: changedPassword, passwordConfirmation: changedPassword }).expect(302);
  assert.equal(await verifyPassword(changedPassword, store.users[0].password_hash), true);
});

test('unsupported or empty bodies are rejected by form validation without server errors', async () => {
  const { app, cookies, csrfToken, store } = await authenticationFixture();
  for (const route of ['/auth/login', '/auth/signup', '/account/profile', '/account/password', '/community/12/comments', '/admin/categories', '/admin/feedback/11/status']) {
    const response = await request(app).post(route).set('Cookie', route.startsWith('/admin/') ? cookies.admin : cookies.owner)
      .set('X-CSRF-Token', csrfToken).set('Content-Type', 'text/plain').send('unsupported body');
    assert(response.status < 500, route + ' must not cause a server error');
  }
  assert.equal(store.calls.filter(call => ['submit', 'updateProfile', 'categorySave', 'addComment', 'updateStatus'].includes(call.name)).length, 0);
});
