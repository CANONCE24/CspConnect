'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');
const fs = require('node:fs/promises');
const path = require('node:path');
const request = require('supertest');
const sharp = require('sharp');
const cloudinary = require('cloudinary').v2;
const { fixtureApp } = require('./support');
const { saveImage, removeImage, uploadDir } = require('../src/services/uploads');
const { loadConfig } = require('../src/config/env');

function cloudFixture(t) {
  const values = { SESSION_SECRET: 'isolated-deployment-test-secret-at-least-32-characters',
    UPLOAD_STORAGE: 'cloudinary', CLOUDINARY_CLOUD_NAME: 'isolated-test-cloud',
    CLOUDINARY_API_KEY: 'isolated-test-key', CLOUDINARY_API_SECRET: 'isolated-test-secret' };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const assets = new Map(), uploads = [], downloads = [], removed = [];
  t.mock.method(cloudinary.uploader, 'upload_stream', (options, callback) => {
    uploads.push(options);
    const chunks = [];
    return new Writable({
      write(chunk, _encoding, done) { chunks.push(chunk); done(); },
      final(done) { assets.set(options.public_id, Buffer.concat(chunks)); callback(null, { public_id: options.public_id }); done(); }
    });
  });
  t.mock.method(cloudinary.uploader, 'destroy', async (id, options) => {
    removed.push({ id, options }); assets.delete(id); return { result: 'ok' };
  });
  t.mock.method(globalThis, 'fetch', async address => {
    const url = new URL(address);
    downloads.push(url);
    const bytes = assets.get(url.searchParams.get('public_id'));
    return new Response(bytes || 'not found', { status: bytes ? 200 : 404 });
  });
  return { assets, uploads, downloads, removed };
}

test('production login sets secure cookies behind Render while local HTTP still works', async () => {
  const { app } = await fixtureApp({ config: { nodeEnv: 'production' } });
  const login = await request(app).get('/login').set('X-Forwarded-Proto', 'https').expect(200);
  assert.match(login.headers['set-cookie'].join(';'), /; Secure/);
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const csrf = login.text.match(/name="_csrf" value="([a-f0-9]+)"/)[1];
  const next = await request(app).get('/login').set('X-Forwarded-Proto', 'https').set('Cookie', cookie).expect(200);
  assert(next.text.includes(csrf), 'the session persists through forwarded HTTPS requests');
  const direct = await request(app).get('/login').expect(200);
  assert.equal(direct.headers['set-cookie'], undefined, 'secure cookies must not be issued over plain HTTP');
  const local = await fixtureApp();
  const localLogin = await request(local.app).get('/login').expect(200);
  assert.doesNotMatch(localLogin.headers['set-cookie'].join(';'), /; Secure/);
});

test('Cloudinary attachments preserve ownership and publication checks without exposing signed URLs', async t => {
  const cloud = cloudFixture(t);
  const { app, store, cookies, csrfToken } = await fixtureApp();
  const png = await sharp({ create: { width: 4, height: 3, channels: 3, background: '#335577' } }).png().toBuffer();
  await request(app).post('/feedback').set('Cookie', cookies.owner).set('X-CSRF-Token', csrfToken)
    .field('type', 'Suggestion').field('categoryId', '1').field('title', 'Cloudinary private feedback')
    .field('description', 'An attachment with existing privacy rules.')
    .attach('attachment', png, 'photo.png').expect(302);
  const row = store.feedback.find(item => item.id === 30);
  assert.match(row.attachment_path, /^[a-f0-9-]+\.webp$/);
  await assert.rejects(fs.access(path.join(uploadDir, row.attachment_path)), { code: 'ENOENT' });
  assert.equal(cloud.uploads[0].type, 'authenticated');
  assert.equal(cloud.uploads[0].overwrite, false);
  assert.match(cloud.uploads[0].public_id, /^cspconnect-v2\//);
  assert.equal((await sharp([...cloud.assets.values()][0]).metadata()).format, 'webp');
  await request(app).get('/attachments/30').expect(302);
  await request(app).get('/attachments/30').set('Cookie', cookies.other).expect(404);
  assert.equal(cloud.downloads.length, 0, 'unauthorized requests must not reach Cloudinary');
  const image = await request(app).get('/attachments/30').set('Cookie', cookies.owner).expect(200);
  assert.match(image.headers['content-type'], /image\/webp/);
  assert.equal(image.headers['cache-control'], 'private, no-store');
  assert.equal(image.headers.location, undefined);
  assert.equal(cloud.downloads[0].searchParams.get('type'), 'authenticated');
  assert(cloud.downloads[0].searchParams.get('signature'));
  assert(Number(cloud.downloads[0].searchParams.get('expires_at')) <= Date.now() / 1000 + 60);
  row.is_published = 1;
  await request(app).get('/attachments/30').set('Cookie', cookies.other).expect(200);
  row.is_published = 0;
  await request(app).get('/attachments/30').set('Cookie', cookies.other).expect(404);
  await request(app).get('/uploads/' + row.attachment_path).set('Cookie', cookies.owner).expect(404);
  await removeImage(row.attachment_path);
  assert.equal(cloud.removed[0].options.type, 'authenticated');
  assert.equal(cloud.assets.size, 0);
});

test('Cloudinary profile photos resize, remain protected, and are removed after failed saves', async t => {
  const cloud = cloudFixture(t);
  const { app, store, cookies, csrfToken } = await fixtureApp();
  const png = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#335577' } }).png().toBuffer();
  const uploadPhoto = () => request(app).post('/account/profile').query({ _csrf: csrfToken })
    .set('Cookie', cookies.owner).field('name', 'Test Student').attach('attachment', png, 'photo.png');
  await uploadPhoto().expect(302);
  const avatar = store.users[0].avatar_url;
  const metadata = await sharp([...cloud.assets.values()][0]).metadata();
  assert.equal(metadata.width, 512); assert.equal(metadata.height, 512);
  await request(app).get(avatar).expect(302);
  await request(app).get(avatar).set('Cookie', cookies.other).expect(200);
  await request(app).post('/account/profile').set('Cookie', cookies.owner)
    .send({ _csrf: csrfToken, name: 'Test Student', removePhoto: '1' }).expect(302);
  assert.equal(cloud.assets.size, 0);
  await request(app).get(avatar).set('Cookie', cookies.owner).expect(404);
  store.updateProfile = async () => { throw Object.assign(new Error('Unavailable'), { status: 503 }); };
  await uploadPhoto().expect(503);
  assert.equal(cloud.assets.size, 0, 'a failed database save must clean up its cloud upload');
});

test('Cloudinary failures never silently save uploads to ephemeral disk', async t => {
  const cloud = cloudFixture(t);
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#335577' } }).png().toBuffer();
  const file = { buffer: png, mimetype: 'image/png' };
  t.mock.method(cloudinary.uploader, 'upload_stream', (_options, callback) => new Writable({
    write(_chunk, _encoding, done) { callback(new Error('Offline')); done(); }
  }));
  await assert.rejects(saveImage(file), { status: 503 });
  assert.equal(cloud.assets.size, 0);
  process.env.CLOUDINARY_API_SECRET = '';
  await assert.rejects(saveImage(file), { status: 503 });
  assert.throws(() => loadConfig({ strict: true }), /CLOUDINARY/);
});
