'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const sharp = require('sharp');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixtureApp } = require('./support');
const { uploadDir, removeImage } = require('../src/services/uploads');
const { configurePassport } = require('../src/config/passport');
const validFeedback = { request_key: require('node:crypto').randomUUID(), type: 'Suggestion', categoryId: '1', title: 'Improve classroom ventilation', description: 'Please improve ventilation in our classrooms.', isAnonymous: '1' };

test('login, security headers, and unauthenticated access', async () => {
  const { app, store } = await fixtureApp();
  const login = await request(app).get('/login').expect(200);
  assert.match(login.headers['content-security-policy'], /script-src 'self'/);
  assert.match(login.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(login.headers['x-content-type-options'], 'nosniff');
  assert.equal(login.headers['cache-control'], 'no-store');
  assert.ok(!login.headers['x-powered-by']);
  assert.match(login.headers['set-cookie'][0], /HttpOnly/);
  assert.match(login.headers['set-cookie'][0], /SameSite=Lax/);
  for (const endpoint of ['/dashboard', '/admin', '/community', '/feedback', '/feedback/11', '/attachments/11']) {
    await request(app).get(endpoint).expect(302).expect('Location', '/login');
  }
  const response = await request(app).post('/api/professor').send({ message: 'Help' }).expect(403);
  assert.match(response.body.error, /session expired/);
  assert.equal(store.calls.length, 0);
  await request(app).get('/auth/google').expect(302).expect('Location', '/login');
  await request(app).get('/auth/google/callback').expect(302).expect('Location', '/login');
  await request(app).get('/auth/dev').expect(404);
});

test('OAuth authorization uses state and rejects missing or mismatched callback state without provider calls', async () => {
  const { app } = await fixtureApp({ config: { googleClientId: 'isolated-client', googleClientSecret: 'isolated-secret' } });
  const browser = request.agent(app);
  const authorization = await browser.get('/auth/google').expect(302);
  const url = new URL(authorization.headers.location);
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.ok(url.searchParams.get('state')?.length >= 20);
  assert.equal(url.searchParams.get('client_id'), 'isolated-client');
  assert.match(url.searchParams.get('scope'), /email/);
  assert.match(url.searchParams.get('scope'), /profile/);
  await browser.get('/auth/google/callback').query({ code: 'unexchanged-code', state: 'incorrect-state' }).expect(302).expect('Location', '/login');
  const missing = request.agent(app);
  await missing.get('/auth/google/callback').query({ code: 'unexchanged-code' }).expect(302).expect('Location', '/login');
});

test('Google strategy rejects unverified identities, accepts external domains and forwards server allowlist only', async () => {
  const calls = [];
  const store = { async upsertGoogleUser(profile, allowlist) { calls.push({ profile, allowlist }); return { id: 1, email: profile.emails[0].value, role: allowlist.includes(profile.emails[0].value) ? 'admin' : 'student' }; } };
  const passport = configurePassport(store, { googleClientId: 'isolated-client', googleClientSecret: 'isolated-secret', googleCallbackUrl: 'http://localhost:3000/auth/google/callback',
    allowedEmailDomain: 'example.test', adminEmails: ['admin@example.test'] },{verifyGoogleToken:async token=>{const profile=JSON.parse(token);return {sub:profile.id,email:profile.emails?.[0]?.value,email_verified:profile._json?.email_verified===true||profile.emails?.[0]?.verified===true,name:profile.displayName};}});
  const verify = profile => new Promise((resolve, reject) => passport._strategy('google')._verify('not-used', 'not-used',{id_token:JSON.stringify(profile)},null, (error, user, info) => error ? reject(error) : resolve({ user, info })));
  const unverified = await verify({ id: '1', emails: [{ value: 'admin@example.test', verified: false }], _json: { email_verified: false } });
  assert.equal(unverified.user, false); assert.equal(calls.length, 0);
  const external = await verify({ id: '2', emails: [{ value: 'admin@outside.test', verified: true }] });
  assert.equal(external.user.role, 'student'); assert.equal(calls.length, 1);
  const accepted = await verify({ id: '3', displayName: 'Authorized Admin', emails: [{ value: 'admin@example.test', verified: true }] });
  assert.equal(accepted.user.role, 'admin'); assert.deepEqual(calls[1].allowlist, ['admin@example.test']);
  const student = await verify({ id: '4', emails: [{ value: 'student@example.test', verified: true }], role: 'admin' });
  assert.equal(student.user.role, 'student');
});

test('server allowlist controls administration; stored role and browser IDs do not grant it', async () => {
  const { app, store, cookies, csrfToken } = await fixtureApp();
  store.users[0].role = 'admin';
  await request(app).get('/admin').set('Cookie', cookies.owner).expect(403);
  await request(app).get('/admin').set('Cookie', cookies.admin).expect(200);
  await request(app).get('/dashboard').set('Cookie', cookies.admin).expect(403);
  await request(app).post('/admin/feedback/11/status').set('Cookie', cookies.owner).send({ _csrf: csrfToken, status: 'Resolved', role: 'admin', user_id: 842 }).expect(403);
  assert.equal(store.feedback[0].status, 'Submitted');
  const denied = await fixtureApp({ config: { adminEmails: [] } });
  await request(denied.app).get('/admin').set('Cookie', denied.cookies.admin).expect(403);
});

test('institutional classification does not restrict external-domain sessions', async () => {
  const { app, cookies } = await fixtureApp({ config: { allowedEmailDomain: 'institution.test' } });
  await request(app).get('/dashboard').set('Cookie', cookies.owner).expect(200);
});

test('private ownership and published-only community visibility', async () => {
  const { app, store, cookies } = await fixtureApp();
  await request(app).get('/feedback/11').set('Cookie', cookies.owner).expect(200);
  await request(app).get('/feedback/11').set('Cookie', cookies.other).expect(404);
  await request(app).get('/feedback/not-an-id').set('Cookie', cookies.owner).expect(404);
  await request(app).get('/community/11').set('Cookie', cookies.owner).expect(404);
  await request(app).get('/community/12').set('Cookie', cookies.other).expect(200);
  await request(app).get('/feedback?user_id=841').set('Cookie', cookies.other).expect(200);
  const lastList = store.calls.filter(call => call.name === 'listFeedback').at(-1);
  assert.equal(lastList.args[0].userId, 843);
});

test('anonymous community HTML excludes identity and private responses', async () => {
  const { app, store, cookies } = await fixtureApp();
  store.feedback[1].responses.push({ body: 'PRIVATE OFFICIAL RESPONSE', admin_name: 'Administrator', created_at: '2026-10-06T06:00:00Z' });
  for (const endpoint of ['/community', '/community/12']) {
    const response = await request(app).get(endpoint).set('Cookie', cookies.other).expect(200);
    assert.match(response.text, /Anonymous/);
    for (const secret of ['Private Student Name', 'private-student@example.test', 'google-private-student', 'PRIVATE OFFICIAL RESPONSE']) assert.ok(!response.text.includes(secret), `${endpoint} leaked ${secret}`);
    assert.ok(!/user_id[="': ]+841/.test(response.text));
  }
});

test('CSRF rejects missing, malformed, and another-session tokens before mutations', async () => {
  const { app, store, cookies, csrfToken } = await fixtureApp();
  for (const token of [undefined, 'x', 'b'.repeat(64), [csrfToken]]) {
    await request(app).post('/community/12/comments').set('Cookie', cookies.owner).send({ body: 'A useful comment', _csrf: token }).expect(403);
  }
  const otherSession = await request.agent(app).get('/login').expect(200);
  const differentToken = otherSession.text.match(/name="csrf-token" content="([a-f0-9]{64})"/)[1];
  assert.notEqual(differentToken, csrfToken);
  await request(app).post('/community/12/comments').set('Cookie', cookies.owner).send({ body: 'A useful comment', _csrf: differentToken }).expect(403);
  assert.equal(store.calls.filter(call => call.name === 'addComment').length, 0);
  await request(app).post('/community/12/comments').set('Cookie', cookies.owner).set('X-CSRF-Token', csrfToken).send({ body: 'A useful comment' }).expect(302);
  await request(app).post('/admin/feedback/11/status').set('Cookie', cookies.admin).send({ status: 'Resolved' }).expect(403);
  assert.equal(store.feedback[0].status, 'Submitted');
});

test('feedback, account, and category values escape hostile content in templates', async () => {
  const { app, store, cookies } = await fixtureApp();
  const hostile = '<img src=x onerror="alert(1)">';
  store.feedback[0].title = hostile;
  store.feedback[0].description = hostile;
  store.users[0].name = hostile;
  (await store.categories())[0].name = hostile;
  for (const endpoint of ['/feedback/11', '/feedback/new', '/feedback']) {
    const rendered = await request(app).get(endpoint).set('Cookie', cookies.owner).expect(200);
    assert.ok(!rendered.text.includes(hostile), `${endpoint} rendered executable content`);
    assert.match(rendered.text, /&lt;img src=x onerror=&#34;alert\(1\)&#34;&gt;/);
  }
});

test('feedback validates on server, records authenticated owner, and remains private', async () => {
  const { app, store, cookies, csrfToken } = await fixtureApp();
  for (const values of [{ ...validFeedback, type: 'Invalid' }, { ...validFeedback, title: 'x' }, { ...validFeedback, categoryId: '999' }, { ...validFeedback, description: 'short' }]) {
    await request(app).post('/feedback').set('Cookie', cookies.owner).send({ ...values, _csrf: csrfToken }).expect(422);
  }
  assert.equal(store.calls.filter(call => call.name === 'submit').length, 0);
  await request(app).post('/feedback').set('Cookie', cookies.owner).send({ ...validFeedback, _csrf: csrfToken, user_id: 842, role: 'admin', isPublished: '1' }).expect(302).expect('Location', '/feedback/30');
  const call = store.calls.find(call => call.name === 'submit');
  assert.equal(call.args[0], 841);
  assert.equal(call.args[1].isAnonymous, true);
  assert.ok(!('isPublished' in call.args[1]));
  const details = await request(app).get('/feedback/30').set('Cookie', cookies.owner).expect(200);
  assert.match(details.text, /FB-2026-00030/);
  await request(app).get('/community/30').set('Cookie', cookies.other).expect(404);
});

test('image uploads reject invalid type, extension, bytes, mismatch, and excessive size', async () => {
  const { app, store, cookies, csrfToken } = await fixtureApp();
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#12589b' } }).png().toBuffer();
  const cases = [
    { filename: 'payload.exe', contentType: 'application/octet-stream', data: Buffer.from('MZ') },
    { filename: 'payload.svg', contentType: 'image/svg+xml', data: Buffer.from('<svg onload="alert(1)"></svg>') },
    { filename: 'payload.png', contentType: 'image/png', data: Buffer.from('not an image') },
    { filename: 'wrong.jpg', contentType: 'image/jpeg', data: png },
    { filename: 'huge.png', contentType: 'image/png', data: Buffer.alloc(5 * 1024 * 1024 + 1) }
  ];
  for (const item of cases) {
    let pending = request(app).post('/feedback').query({ _csrf: csrfToken }).set('Cookie', cookies.owner);
    for (const [key, value] of Object.entries(validFeedback)) pending = pending.field(key, value);
    await pending.attach('attachment', item.data, { filename: item.filename, contentType: item.contentType }).expect(422);
  }
  assert.equal(store.calls.filter(call => call.name === 'submit').length, 0);
});

test('form byte limits accept valid multilingual text while character validation still enforces bounds', async () => {
  const { app, store, cookies, csrfToken } = await fixtureApp();
  const text = String.fromCodePoint(0x5b66).repeat(10000);
  await request(app).post('/feedback').query({ _csrf: csrfToken }).set('Cookie', cookies.owner)
    .field('type', 'Suggestion').field('categoryId', '1').field('title', 'Multilingual feedback boundary')
    .field('request_key', require('node:crypto').randomUUID()).field('description', text).expect(302);
  assert.equal(store.calls.find(call => call.name === 'submit').args[1].description, text);
  const response = String.fromCodePoint(0x1f600).repeat(5000);
  const approval = { confirmed:'1',request_key:require('node:crypto').randomUUID() };
  await request(app).post('/admin/feedback/11/response').set('Cookie', cookies.admin).type('form')
    .send({ _csrf: csrfToken, body: response, ...approval }).expect(302);
  assert.equal(store.calls.filter(call => call.name === 'updateStatus').at(-1).args[3].response, response);
  await request(app).post('/admin/feedback/11/response').set('Cookie', cookies.admin).type('form')
    .send({ _csrf: csrfToken, body: response + 'x', ...approval }).expect(422);
  await request(app).post('/feedback').query({ _csrf: csrfToken }).set('Cookie', cookies.owner)
    .field('type', 'Suggestion').field('categoryId', '1').field('title', 'Multilingual feedback boundary')
    .field('description', text + 'x').expect(422);
});

test('valid image is normalized, privately accessible, and never served by static uploads', async () => {
  const { app, store, cookies, csrfToken } = await fixtureApp();
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#12589b' } }).png().toBuffer();
  let pending = request(app).post('/feedback').set('Cookie', cookies.owner).set('X-CSRF-Token', csrfToken);
  for (const [key, value] of Object.entries(validFeedback)) pending = pending.field(key, value);
  await pending.attach('attachment', png, { filename: '../../unsafe-name.png', contentType: 'image/png' }).expect(302);
  const row = store.feedback.find(row => row.id === 30);
  try {
    assert.match(row.attachment_path, /^[a-f0-9-]+\.webp$/);
    const metadata = await sharp(await fs.readFile(path.join(uploadDir, row.attachment_path))).metadata();
    assert.equal(metadata.format, 'webp');
    await request(app).get('/attachments/30').set('Cookie', cookies.owner).expect(200).expect('Content-Type', /image\/webp/);
    await request(app).get('/attachments/30').set('Cookie', cookies.other).expect(404);
    await request(app).get('/uploads/' + row.attachment_path).set('Cookie', cookies.owner).expect(404);
    row.is_published = 1;
    await request(app).get('/attachments/30').set('Cookie', cookies.other).expect(200);
    row.is_published = 0;
    await request(app).get('/attachments/30').set('Cookie', cookies.other).expect(404);
  } finally { await removeImage(row.attachment_path); }
});

test('reactions use session identity and support switching/removal on published feedback only', async () => {
  const { app, store, cookies, csrfToken } = await fixtureApp();
  for (const kind of ['support', 'not_helpful', 'remove']) {
    await request(app).post('/community/12/reaction').set('Cookie', cookies.owner).send({ _csrf: csrfToken, kind, user_id: 843 }).expect(302);
    assert.deepEqual(store.calls.filter(call => call.name === 'react').at(-1).args, [12, 841, kind]);
  }
  assert.equal(store.reactions.size, 0);
  await request(app).post('/community/12/reaction').set('Cookie', cookies.owner).send({ _csrf: csrfToken, kind: 'invalid' }).expect(422);
  await request(app).post('/community/11/reaction').set('Cookie', cookies.owner).send({ _csrf: csrfToken, kind: 'support' }).expect(404);
  await request(app).post('/community/12/reaction').set('Cookie', cookies.admin).send({ _csrf: csrfToken, kind: 'support' }).expect(403);
});

test('JSON reactions return saved counts, toggle and switch, and keep student/CSRF/publication checks', async () => {
  const { app, store, cookies, csrfToken } = await fixtureApp();
  const react = (kind, cookie = cookies.owner, token = csrfToken, feedback = 12) => request(app)
    .post(`/community/${feedback}/reaction`).set('Cookie', cookie).set('Accept', 'application/json')
    .set('X-CSRF-Token', token).send({ kind, user_id: 843 });
  for (const [kind, expected] of [
    ['support', { reaction: 'support', support_count: 1, not_helpful_count: 0 }],
    ['support', { reaction: null, support_count: 0, not_helpful_count: 0 }],
    ['not_helpful', { reaction: 'not_helpful', support_count: 0, not_helpful_count: 1 }],
    ['support', { reaction: 'support', support_count: 1, not_helpful_count: 0 }],
    ['remove', { reaction: null, support_count: 0, not_helpful_count: 0 }]
  ]) assert.deepEqual((await react(kind).expect(200)).body, expected);
  await react('support').expect(200);
  const feed = await request(app).get('/community').set('Cookie', cookies.owner).expect(200);
  assert.match(feed.text, /data-reaction="support" aria-pressed="true"/);
  const other = await request(app).get('/community').set('Cookie', cookies.other).expect(200);
  assert.doesNotMatch(other.text, /aria-pressed="true"/);
  const callsBeforeDenials = store.calls.filter(call => call.name === 'react').length;
  await react('support', cookies.owner, 'invalid').expect(403);
  await react('support', cookies.admin).expect(403);
  await react('invalid').expect(422);
  assert.equal(store.calls.filter(call => call.name === 'react').length, callsBeforeDenials);
  await react('support', cookies.owner, csrfToken, 11).expect(404);
  const anonymous = request.agent(app);
  const login = await anonymous.get('/login').expect(200);
  const token = /name="csrf-token" content="([^"]+)"/.exec(login.text)[1];
  await anonymous.post('/community/12/reaction').set('Accept', 'application/json').send({ _csrf: token, kind: 'support' }).expect(302).expect('Location', '/login');
  assert.equal(store.reactions.get('12:841'), 'support');
});

test('community sorting retains filters and pagination, falls back safely, and supplies admin support tables', async () => {
  const { app, store, cookies } = await fixtureApp();
  const row = store.feedback.find(row => row.id === 12);
  row.support_count = 3;
  for (const sort of ['trending', 'most_supported', 'newest']) {
    const response = await request(app).get('/community').query({ q: 'ventilation', type: 'Suggestion', category: 1, status: 'Submitted', visibility: 'published', sort, page: 2, viewerId: 843 })
      .set('Cookie', cookies.owner).expect(200);
    const options = store.calls.filter(call => call.name === 'listFeedback').at(-1).args[0];
    assert.equal(options.sort, sort); assert.equal(options.search, 'ventilation'); assert.equal(options.type, 'Suggestion');
    assert.equal(options.viewerId, 841); assert.equal(options.publicOnly, true);
    assert.equal(options.categoryId, 1); assert.equal(options.status, 'Submitted'); assert.equal(options.visibility, 'published');
    assert.match(response.text, new RegExp(`name="sort" value="${sort}"`));
    assert.match(response.text, /<option value="">All Categories<\/option>/);
    assert.match(response.text, /<option value="1" selected>Facilities<\/option>/);
    assert.match(response.text, /type="hidden" name="status" value="Submitted"/);
    assert.match(response.text, /type="hidden" name="visibility" value="published"/);
    assert.match(response.text, /q=ventilation&amp;type=Suggestion/);
    const sorting = response.text.match(/<nav class="feed-sorting"[\s\S]*?<\/nav>/)[0];
    assert.doesNotMatch(sorting, /page=/);
    for (const [, href] of sorting.matchAll(/href="([^"]+)"/g)) {
      const params = new URL(href.replaceAll('&amp;', '&'), 'http://localhost/community').searchParams;
      assert.equal(params.get('category'), '1'); assert.equal(params.get('status'), 'Submitted');
      assert.equal(params.get('visibility'), 'published'); assert.equal(params.get('q'), 'ventilation');
    }
  }
  await request(app).get('/community?sort=hostile').set('Cookie', cookies.owner).expect(200);
  assert.equal(store.calls.filter(call => call.name === 'listFeedback').at(-1).args[0].sort, 'newest');
  for (const endpoint of ['/admin', '/admin/analytics']) {
    const response = await request(app).get(endpoint).set('Cookie', cookies.admin).expect(200);
    assert.match(response.text, /Most supported feedback/);
    assert.match(response.text, /<th scope="col">Category<\/th><th scope="col">Support<\/th><th scope="col">Current status<\/th>/);
    assert.match(response.text, /<strong>3<\/strong>/);
    const options = store.calls.filter(call => call.name === 'listFeedback').at(-1).args[0];
    assert.equal(options.sort, 'most_supported'); assert.equal(options.publicOnly, true);
  }
});

test('comments validate codepoint length, trim whitespace, escape content, and honor moderation', async () => {
  const { app, store, cookies, csrfToken } = await fixtureApp();
  for (const body of ['', '   ', 'x'.repeat(501), '\u0000bad']) {
    await request(app).post('/community/12/comments').set('Cookie', cookies.owner).send({ _csrf: csrfToken, body }).expect(422);
  }
  await request(app).post('/community/11/comments').set('Cookie', cookies.owner).send({ _csrf: csrfToken, body: 'Private discussion attempt' }).expect(404);
  const hostile = '<script>alert(1)</script>';
  await request(app).post('/community/12/comments').set('Cookie', cookies.owner).send({ _csrf: csrfToken, body: `  ${hostile}  `, user_id: 843 }).expect(302);
  assert.deepEqual(store.calls.filter(call => call.name === 'addComment').at(-1).args, [12, 841, hostile]);
  const shown = await request(app).get('/community/12').set('Cookie', cookies.other).expect(200);
  assert.ok(!shown.text.includes(hostile));
  assert.match(shown.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  await request(app).post('/admin/comments/21/moderate').set('Cookie', cookies.admin).send({ _csrf: csrfToken, hidden: '1',version:'1',confirmed:'1',reason:'Test moderation reason' }).expect(302);
  const hidden = await request(app).get('/community/12').set('Cookie', cookies.other).expect(200);
  assert.ok(!hidden.text.includes('Visible community comment'));
  await request(app).post('/admin/comments/21/moderate').set('Cookie', cookies.admin).send({ _csrf: csrfToken, hidden: '0',version:'2',reason:'Test restoration reason' }).expect(302);
  const restored = await request(app).get('/community/12').set('Cookie', cookies.other).expect(200);
  assert.match(restored.text, /Visible community comment/);
});

test('admin status history, official response, publication, and input validation', async () => {
  const { app, store, cookies, csrfToken } = await fixtureApp();
  await request(app).post('/admin/feedback/11/status').set('Cookie', cookies.admin).send({ _csrf: csrfToken, status: 'Invented' }).expect(422);
  const approval = { _csrf:csrfToken,confirmed:'1',request_key:require('node:crypto').randomUUID(),notificationMethod:'both' };
  await request(app).post('/admin/feedback/11/status').set('Cookie', cookies.admin).send({ ...approval,status:'Under Review',response:'Our office is evaluating the submitted information.' }).expect(302);
  assert.equal(store.feedback[0].history.at(-1).to_status, 'Under Review');
  await request(app).post('/admin/feedback/11/response').set('Cookie', cookies.admin).send({ ...approval,request_key:require('node:crypto').randomUUID(),body:'Our office is reviewing the request.' }).expect(302);
  const privateDetail = await request(app).get('/feedback/11').set('Cookie', cookies.owner).expect(200);
  assert.match(privateDetail.text, /Our office is reviewing the request/);
  for (const published of ['1', '0']) {
    await request(app).post('/admin/feedback/11/publish').set('Cookie', cookies.admin).send({ _csrf: csrfToken, published, reason:"Reviewed for community publication" }).expect(302);
    await request(app).get('/community/11').set('Cookie', cookies.other).expect(published === '1' ? 200 : 404);
  }
  await request(app).get('/feedback/11').set('Cookie', cookies.owner).expect(200);
  await request(app).post('/admin/feedback/11/publish').set('Cookie', cookies.admin).send({ _csrf: csrfToken, published: 'yes' }).expect(422);
});

test('search/filter/page inputs are bounded, scoped and escaped in EJS', async () => {
  const { app, store, cookies } = await fixtureApp();
  const hostile = '"><script>alert(1)</script>';
  const response = await request(app).get('/community').query({ q: hostile, type: 'Suggestion', page: '2', user_id: 841 }).set('Cookie', cookies.other).expect(200);
  assert.ok(!response.text.includes(hostile));
  const options = store.calls.filter(call => call.name === 'listFeedback').at(-1).args[0];
  assert.equal(options.publicOnly, true); assert.equal(options.type, 'Suggestion'); assert.equal(options.page, 2); assert.equal(options.limit, 12);
  assert.ok(!('userId' in options));
  await request(app).get('/feedback').query({ q: 'x'.repeat(500), page: '99999999999999', type: 'bad' }).set('Cookie', cookies.owner).expect(200);
  const bounded = store.calls.filter(call => call.name === 'listFeedback').at(-1).args[0];
  assert.equal(bounded.search.length, 150); assert.equal(bounded.page, 100000); assert.equal(bounded.type, ''); assert.equal(bounded.userId, 841);
});

test('Professor returns friendly missing-key/error messages and never exposes the key', async () => {
  const { app, cookies, csrfToken } = await fixtureApp();
  const unavailable = await request(app).post('/api/professor').set('Cookie', cookies.owner).set('X-CSRF-Token', csrfToken).send({ message: 'How do I submit feedback?' }).expect(503);
  assert.match(unavailable.body.error, /Professor is unavailable/);
  const liveFixture = await fixtureApp({ config: { geminiApiKey: 'isolated-server-only-secret' } });
  const originalFetch = global.fetch;
  try {
    global.fetch = async (_url, options) => {
      assert.equal(options.headers['x-goog-api-key'], 'isolated-server-only-secret');
      const payload = JSON.parse(options.body);
      assert.match(payload.systemInstruction.parts[0].text, /Never invent CSPC policies/);
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'Open Submit Feedback to begin.' }] } }] }) };
    };
    const reply = await request(liveFixture.app).post('/api/professor').set('Cookie', liveFixture.cookies.owner).set('X-CSRF-Token', csrfToken).send({ message: 'Help' }).expect(200);
    assert.equal(reply.body.reply, 'Open Submit Feedback to begin.');
    assert.ok(!JSON.stringify(reply.body).includes('isolated-server-only-secret'));
    global.fetch = async () => { throw new Error('network unavailable'); };
    const failure = await request(liveFixture.app).post('/api/professor').set('Cookie', liveFixture.cookies.owner).set('X-CSRF-Token', csrfToken).send({ message: 'Help' }).expect(503);
    assert.match(failure.body.error, /could not respond/);
  } finally { global.fetch = originalFetch; }
});

test('logout destroys authenticated session and requires CSRF', async () => {
  const { app, cookies, csrfToken } = await fixtureApp();
  await request(app).post('/logout').set('Cookie', cookies.owner).expect(403);
  await request(app).post('/logout').set('Cookie', cookies.owner).send({ _csrf: csrfToken }).expect(302).expect('Location', '/login');
  await request(app).get('/dashboard').set('Cookie', cookies.owner).expect(302).expect('Location', '/login');
});
