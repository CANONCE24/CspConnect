'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const sharp = require('sharp');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixtureApp } = require('./support');
const { uploadDir, removeImage } = require('../src/services/uploads');

test('account information is authenticated and profile updates cannot change email, role, or another user', async () => {
  const { app, store, cookies, csrfToken } = await fixtureApp();
  await request(app).get('/account').expect(302).expect('Location', '/login');
  const account = await request(app).get('/account').set('Cookie', cookies.owner).expect(200);
  assert.match(account.text, /My account/);
  assert.match(account.text, /private-student@example.test/);
  assert.match(account.text, /CSPConnect/);
  await request(app).post('/account/profile').set('Cookie', cookies.owner).send({ name: 'Forged' }).expect(403);
  await request(app).post('/account/profile').set('Cookie', cookies.owner)
    .send({ _csrf: csrfToken, name: '   ' }).expect(422);
  await request(app).post('/account/profile').set('Cookie', cookies.owner)
    .send({ _csrf: csrfToken, name: 'x'.repeat(201) }).expect(422);
  await request(app).post('/account/profile').set('Cookie', cookies.owner)
    .send({ _csrf: csrfToken, name: '  Updated Student  ', role: 'admin', email: 'hijack@example.test', userId: 843, avatar_url: 'https://outside.test/a.png' })
    .expect(302).expect('Location', '/account');
  assert.equal(store.users[0].name, 'Updated Student');
  assert.equal(store.users[0].role, 'student');
  assert.equal(store.users[0].email, 'private-student@example.test');
  assert.equal(store.users[0].avatar_url, undefined);
  assert.equal(store.users[2].name, 'Another Student');
  const refreshed = await request(app).get('/account').set('Cookie', cookies.owner).expect(200);
  assert.match(refreshed.text, /Updated Student/);
  await request(app).get('/account').set('Cookie', cookies.admin).expect(200);
});

test('profile photos validate image bytes, resize safely, load only while referenced, and can be replaced and removed', async () => {
  const { app, store, cookies, csrfToken } = await fixtureApp();
  const png = await sharp({ create: { width: 900, height: 600, channels: 3, background: '#335577' } }).png().toBuffer();
  let first, second;
  try {
    await request(app).post('/account/profile').set('Cookie', cookies.owner)
      .field('name', 'Student').attach('attachment', png, 'photo.png').expect(403);
    await request(app).post('/account/profile').query({ _csrf: csrfToken }).set('Cookie', cookies.owner)
      .field('name', 'Student').attach('attachment', Buffer.from('not a real image'), 'photo.png').expect(422);
    assert.equal(store.users[0].avatar_url, undefined);
    await request(app).post('/account/profile').query({ _csrf: csrfToken }).set('Cookie', cookies.owner)
      .field('name', 'Student').attach('attachment', png, 'photo.png').expect(302);
    first = store.users[0].avatar_url.split('/').at(-1);
    const meta = await sharp(await fs.readFile(path.join(uploadDir, first))).metadata();
    assert.equal(meta.format, 'webp'); assert.equal(meta.width, 512); assert.equal(meta.height, 512);
    await request(app).get('/avatars/' + first).expect(302).expect('Location', '/login');
    const image = await request(app).get('/avatars/' + first).set('Cookie', cookies.other).expect(200);
    assert.match(image.headers['content-type'], /image\/webp/);
    assert.equal(image.headers['cache-control'], 'private, no-store');
    const dashboard = await request(app).get('/dashboard').set('Cookie', cookies.owner).expect(200);
    assert(dashboard.text.includes('/avatars/' + first));
    await request(app).post('/account/profile').query({ _csrf: csrfToken }).set('Cookie', cookies.owner)
      .field('name', 'Student').attach('attachment', png, 'new-photo.png').expect(302);
    second = store.users[0].avatar_url.split('/').at(-1);
    assert.notEqual(first, second);
    await assert.rejects(fs.access(path.join(uploadDir, first)), { code: 'ENOENT' });
    await request(app).get('/avatars/' + first).set('Cookie', cookies.owner).expect(404);
    await request(app).post('/account/profile').set('Cookie', cookies.owner)
      .send({ _csrf: csrfToken, name: 'Student', removePhoto: '1' }).expect(302);
    assert.equal(store.users[0].avatar_url, null);
    await assert.rejects(fs.access(path.join(uploadDir, second)), { code: 'ENOENT' });
    await request(app).get('/avatars/' + second).set('Cookie', cookies.owner).expect(404);
    await request(app).get('/avatars/not-an-image').set('Cookie', cookies.owner).expect(404);
  } finally { await removeImage(first); await removeImage(second); }
});

test('a failed profile database update does not leave an uploaded photo behind', async () => {
  const { app, store, cookies, csrfToken } = await fixtureApp();
  const png = await sharp({ create: { width: 3, height: 3, channels: 3, background: '#224466' } }).png().toBuffer();
  let uploaded;
  store.updateProfile = async (_id, values) => { uploaded = values.avatarUrl.split('/').at(-1); const error = new Error('Unavailable'); error.status = 503; throw error; };
  await request(app).post('/account/profile').query({ _csrf: csrfToken }).set('Cookie', cookies.owner)
    .field('name', 'Student').attach('attachment', png, 'photo.png').expect(503);
  await assert.rejects(fs.access(path.join(uploadDir, uploaded)), { code: 'ENOENT' });
});
