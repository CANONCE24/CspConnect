'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');
const request = require('supertest');
require('dotenv').config({ quiet: true });

test('real MariaDB integration in a newly created, owned temporary database', { skip: process.env.TEST_DB !== '1' }, async t => {
  const databaseName = 'cspc_feedback_test_' + crypto.randomBytes(8).toString('hex');
  assert.match(databaseName, /^cspc_feedback_test_[a-f0-9]{16}$/);
  const connection = await mysql.createConnection({ host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', charset: 'utf8mb4', multipleStatements: false });
  let created = false, pool, sessions;
  const previousDatabase = process.env.DB_NAME;
  try {
    const [existing] = await connection.execute('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [databaseName]);
    assert.equal(existing.length, 0, 'Refuse to use any pre-existing database');
    await connection.query(`CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    created = true;
    await connection.changeUser({ database: databaseName });
    const root = path.resolve(__dirname, '..');
    const sql = await fs.readFile(path.join(root, 'schema.sql'), 'utf8') + '\n' + await fs.readFile(path.join(root, 'seed.sql'), 'utf8');
    const statements = sql.replace(/^\s*--.*$/gm, '').split(';').map(statement => statement.trim()).filter(Boolean);
    assert.ok(statements.every(statement => !/\b(?:DROP|TRUNCATE|ALTER|USE|CREATE DATABASE)\b/i.test(statement)));
    for (const statement of statements) await connection.query(statement);
    process.env.DB_NAME = databaseName;
    const store = require('../src/models/store');
    pool = require('../src/config/db').pool;
    const { MySQLSessionStore } = require('../src/services/session-store');
    const { fixtureApp } = require('./support');
    const profile = (id, email, displayName) => ({ id, emails: [{ value: email, verified: true }], displayName, photos: [] });
    const owner = await store.upsertGoogleUser(profile('isolated-owner', 'private-student@example.test', 'Private Student Name'), ['admin@example.test']);
    const other = await store.upsertGoogleUser(profile('isolated-other', 'another@example.test', 'Another Student'), ['admin@example.test']);
    const admin = await store.upsertGoogleUser(profile('isolated-admin', 'admin@example.test', 'Test Administrator'), ['admin@example.test']);
    await store.syncAccountRole(admin.id,'admin'); admin.role='admin';
    const category = (await store.categories())[0];
    const values = { type: 'Suggestion', categoryId: category.id, title: 'Improve classroom ventilation', description: 'Please improve ventilation in the classroom for better comfort.', isAnonymous: true };
    let submission;

    await t.test('fresh schema, Google account upsert, foreign keys, and actual empty statistics', async () => {
      const empty = await store.stats();
      assert.equal(empty.total, 0); assert.equal(empty.submitted, 0);
      assert.equal((await store.categories()).length, 6);
      assert.equal(admin.role, 'admin'); assert.equal(owner.role, 'student');
      const duplicate = await store.upsertGoogleUser(profile('isolated-owner', owner.email, owner.name), ['admin@example.test']);
      assert.equal(duplicate.id, owner.id);
      const [[counts]] = await pool.query('SELECT COUNT(*) AS total FROM users');
      assert.equal(counts.total, 3);
      await assert.rejects(pool.execute('INSERT INTO feedback_reactions (feedback_id,user_id,kind) VALUES (?,?,?)', [999999, owner.id, 'support']), error => error.code === 'ER_NO_REFERENCED_ROW_2');
    });

    await t.test('profile changes persist through Google sign-in and preserve account ownership', async () => {
      const photo = '/avatars/11111111-2222-4333-8444-555555555555.webp';
      await store.updateProfile(owner.id, { name: 'Chosen Profile Name', avatarUrl: photo });
      assert.equal(await store.profilePhotoExists(photo.split('/').at(-1)), true);
      const signedIn = await store.upsertGoogleUser({ ...profile('isolated-owner', owner.email, 'Provider Name'), photos: [{ value: 'https://example.test/provider.png' }] }, ['admin@example.test']);
      assert.equal(signedIn.name, 'Chosen Profile Name');
      assert.equal(signedIn.avatar_url, photo);
      assert.equal(signedIn.id, owner.id);
      assert.equal(signedIn.email, owner.email);
      assert.equal((await store.getUser(other.id)).name, other.name);
      await assert.rejects(store.updateProfile(owner.id, { name: 'Student', avatarUrl: '../../file.webp' }));
      await store.updateProfile(owner.id, { name: owner.name, avatarUrl: null });
      assert.equal(await store.profilePhotoExists(photo.split('/').at(-1)), false);
    });

    await t.test('password role synchronization updates only the specified account', async () => {
      await store.syncAccountRole(other.id, 'admin');
      assert.equal((await store.getUser(other.id)).role, 'admin');
      assert.equal((await store.getUser(owner.id)).role, 'student');
      await store.syncAccountRole(other.id, 'student');
      await assert.rejects(store.syncAccountRole(other.id, 'invalid'));
      await assert.rejects(store.syncAccountRole(999999, 'student'), error => error.status === 404);
      const demoted = await fixtureApp({ store, config: { adminEmails: [] }, userIds: { admin: admin.id } });
      try {
        await request(demoted.app).get('/admin').set('Cookie', demoted.cookies.admin).expect(403);
        assert.equal((await store.getUser(admin.id)).role, 'student');
        await request(demoted.app).get('/dashboard').set('Cookie', demoted.cookies.admin).expect(200);
      } finally { await store.syncAccountRole(admin.id, 'admin'); }
    });

    await t.test('submission atomically generates unique references and enforces student/category validation', async () => {
      submission = await store.submit(owner.id, values);
      assert.match(submission.reference, /^FB-\d{4}-\d{5,}$/);
      const [a, b] = await Promise.all([store.submit(owner.id, { ...values, title: 'Concurrent first submission' }), store.submit(other.id, { ...values, title: 'Concurrent second submission', isAnonymous: false })]);
      assert.equal(new Set([submission.reference, a.reference, b.reference]).size, 3);
      await assert.rejects(store.submit(admin.id, values), error => error.status === 403);
      await assert.rejects(store.submit(owner.id, { ...values, categoryId: 999999 }));
      await assert.rejects(store.submit(owner.id, { ...values, attachmentPath: '../payload.exe', attachmentMime: 'application/octet-stream' }));
      const inactive = await store.categorySave({ name: 'Inactive test category', active: false });
      await assert.rejects(store.submit(owner.id, { ...values, categoryId: inactive.id }));
      assert.equal((await store.stats()).total, 3);
      assert.equal((await store.stats(owner.id)).total, 2);
      const detail = await store.detail(submission.id, { userId: owner.id });
      assert.equal(detail.history.length, 1); assert.equal(detail.history[0].to_status, 'Submitted');
      assert.ok(detail.history[0].created_at instanceof Date);
    });

    await t.test('private IDOR boundaries and anonymous public DTO allowlist', async () => {
      assert.equal(await store.detail(submission.id, { userId: other.id }), null);
      assert.equal(await store.detail(submission.id, { publicOnly: true }), null);
      assert.equal((await store.listFeedback({ publicOnly: true })).total, 0);
      await assert.rejects(store.publish(submission.id, true, owner.id), error => error.status === 403);
      await store.publish(submission.id,true,admin.id);
      const publicDetail = await store.detail(submission.id, { publicOnly: true });
      assert.equal(publicDetail.author_name, 'Anonymous');
      for (const field of ['user_id', 'author_email', 'google_id', 'attachment_path', 'avatar_url']) assert.ok(!(field in publicDetail), `Public DTO exposed ${field}`);
      assert.deepEqual(publicDetail.history, []); assert.deepEqual(publicDetail.responses, []);
      const publicList = await store.listFeedback({ publicOnly: true });
      assert.equal(publicList.total, 1);
      assert.ok(!JSON.stringify(publicList).includes(owner.email));
      const ownList = await store.listFeedback({ userId: other.id });
      assert.ok(ownList.items.every(row => row.user_id === other.id));
    });

    await t.test('official status history and responses remain private and require admin', async () => {
      await assert.rejects(store.updateStatus(submission.id, 'Resolved', owner.id), error => error.status === 403);
      await assert.rejects(store.addResponse(submission.id, owner.id, 'Forged response'), error => error.status === 403);
      const details = { actionTaken:'The classroom ventilation was repaired and tested.',actionConfirmed:true,closureReason:'The requested work has been completed and this record is archived.' };
      for (const status of ['Under Review', 'In Progress', 'Resolved', 'Closed']) await store.updateStatus(submission.id, status, admin.id, details);
      assert.equal((await store.updateStatus(submission.id, 'Closed', admin.id,details)).changed, false);
      await store.addResponse(submission.id, admin.id, '  Official private response  ');
      const detail = await store.detail(submission.id, { userId: owner.id });
      assert.deepEqual(detail.history.map(row => row.to_status), ['Submitted', 'Under Review', 'In Progress', 'Resolved', 'Closed']);
      assert.equal(detail.responses[0].body, 'Official private response');
      assert.equal(detail.responses[0].admin_name, admin.name);
      const publicDetail = await store.detail(submission.id, { publicOnly: true });
      assert.deepEqual(publicDetail.responses, []);
      assert.equal((await store.stats()).closed, 1);
    });

    await t.test('real reactions switch/remove with UNIQUE constraint and session-independent ownership', async () => {
      assert.equal(await store.react(submission.id, owner.id, 'support'), 'support');
      assert.equal(await store.reactionFor(submission.id, owner.id), 'support');
      assert.equal((await store.detail(submission.id, { publicOnly: true })).support_count, 1);
      assert.deepEqual(await store.react(submission.id, owner.id, 'support', { withCounts: true }), { reaction: null, support_count: 0, not_helpful_count: 0 });
      assert.equal(await store.react(submission.id, owner.id, 'support'), 'support');
      await assert.rejects(pool.execute('INSERT INTO feedback_reactions (feedback_id,user_id,kind) VALUES (?,?,?)', [submission.id, owner.id, 'not_helpful']), error => error.code === 'ER_DUP_ENTRY');
      assert.equal(await store.react(submission.id, owner.id, 'not_helpful'), 'not_helpful');
      const switched = await store.detail(submission.id, { publicOnly: true });
      assert.equal(switched.support_count, 0); assert.equal(switched.not_helpful_count, 1);
      await store.react(submission.id, owner.id, 'remove');
      assert.equal(await store.reactionFor(submission.id, owner.id), null);
      await Promise.all([store.react(submission.id, owner.id, 'support'), store.react(submission.id, owner.id, 'not_helpful')]);
      const [[count]] = await pool.execute('SELECT COUNT(*) AS total FROM feedback_reactions WHERE feedback_id=? AND user_id=?', [submission.id, owner.id]);
      assert.equal(count.total, 1);
      await assert.rejects(store.react(submission.id, admin.id, 'support'), error => error.status === 403);
      await assert.rejects(store.react(submission.id, owner.id, 'bad'));
    });

    await t.test('comments store literal text, validate Unicode limits, order and hide/restore', async () => {
      await assert.rejects(store.addComment(submission.id, other.id, ' '));
      await assert.rejects(store.addComment(submission.id, other.id, 'x'.repeat(501)));
      await assert.rejects(store.addComment(submission.id, admin.id, 'Admin community attempt'), error => error.status === 403);
      const first = await store.addComment(submission.id, other.id, '  <script>alert(1)</script>  ');
      const second = await store.addComment(submission.id, other.id, '字'.repeat(500));
      assert.equal(second.pending,true,'Long repetitive text is retained for moderation.');
      await store.moderateComment(second.id,'approve',admin.id);
      let comments = await store.comments(submission.id);
      assert.deepEqual(comments.map(row => row.id), [first.id, second.id]);
      assert.equal(comments[0].body, '<script>alert(1)</script>');
      await store.moderateComment(first.id,true,admin.id,'Test moderation');
      comments = await store.comments(submission.id);
      assert.deepEqual(comments.map(row => row.id), [second.id]);
      assert.equal((await store.comments(submission.id, { includeHidden: true })).length, 2);
      assert.equal((await store.listComments({ search: '<script>' })).items[0].is_hidden, 1);
      await store.moderateComment(first.id,false,admin.id,'Test moderation');
      assert.equal((await store.comments(submission.id)).length, 2);
    });

    await t.test('actual HTTP rendering with real DB enforces privacy and escapes XSS', async () => {
      sessions = new MySQLSessionStore(pool);
      const { app, cookies, csrfToken } = await fixtureApp({ store, sessionStore: sessions, userIds: { owner: owner.id, other: other.id, admin: admin.id } });
      await request(app).get('/feedback/' + submission.id).set('Cookie', cookies.other).expect(404);
      const discussion = await request(app).get('/community/' + submission.id).set('Cookie', cookies.other).expect(200);
      for (const hidden of [owner.name, owner.email, 'isolated-owner', 'Official private response', '<script>alert(1)</script>']) assert.ok(!discussion.text.includes(hidden), `HTML exposed ${hidden}`);
      assert.match(discussion.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
      await request(app).post('/community/' + submission.id + '/comments').set('Cookie', cookies.other).send({ _csrf: csrfToken, body: 'Browser-supplied user ID test', user_id: owner.id }).expect(302);
      const [[row]] = await pool.execute('SELECT user_id FROM feedback_comments WHERE body=?', ['Browser-supplied user ID test']);
      assert.equal(row.user_id, other.id);
      await request(app).post('/admin/feedback/' + submission.id + '/status').set('Cookie', cookies.other).send({ _csrf: csrfToken, status: 'Resolved' }).expect(403);

      const submitted = await request(app).post('/feedback').set('Cookie', cookies.owner).send({ _csrf: csrfToken,request_key:crypto.randomUUID(),publicConsent:'1', type: 'Concern', categoryId: category.id,
        title: 'Joined HTTP workflow submission', description: 'This fixture checks the entire authenticated route and real database workflow.', isAnonymous: '1', user_id: other.id }).expect(302);
      const joinedId = Number(submitted.headers.location.split('/').at(-1));
      assert.ok(joinedId > 0);
      const privatePage = await request(app).get('/feedback/' + joinedId).set('Cookie', cookies.owner).expect(200);
      assert.match(privatePage.text, /FB-\d{4}-\d{5,}/);
      await request(app).get('/feedback/' + joinedId).set('Cookie', cookies.other).expect(404);
      await request(app).post('/admin/feedback/' + joinedId + '/status').set('Cookie', cookies.admin).send({ _csrf: csrfToken, status: 'In Progress',confirmed:'1',request_key:crypto.randomUUID(),response:'The administration has recorded a confirmed progress update.' }).expect(302);
      await request(app).post('/admin/feedback/' + joinedId + '/response').set('Cookie', cookies.admin).send({ _csrf: csrfToken, body: 'Joined workflow official response',confirmed:'1',request_key:crypto.randomUUID() }).expect(302);
      await request(app).post('/admin/feedback/' + joinedId + '/publish').set('Cookie', cookies.admin).send({ _csrf: csrfToken, published: '1',reviewed:'1',publicTitle:'Reviewed community submission',publicDescription:'This reviewed description is safe for the campus community.',reason:'Reviewed before publication' }).expect(302);
      await request(app).get('/community/' + joinedId).set('Cookie', cookies.other).expect(200);
      await request(app).post('/community/' + joinedId + '/reaction').set('Cookie', cookies.other).send({ _csrf: csrfToken, kind: 'support', user_id: owner.id }).expect(302);
      assert.equal(await store.reactionFor(joinedId, other.id), 'support');
      await request(app).post('/community/' + joinedId + '/comments').set('Cookie', cookies.other).send({ _csrf: csrfToken, body: 'Joined workflow comment' }).expect(302);
      const joinedComment = (await store.comments(joinedId))[0];
      await request(app).post('/admin/comments/' + joinedComment.id + '/moderate').set('Cookie', cookies.admin).send({ _csrf: csrfToken, hidden: '1',version:'1',confirmed:'1',reason:'Test moderation action' }).expect(302);
      assert.equal((await store.comments(joinedId)).length, 0);
      await request(app).post('/admin/feedback/' + joinedId + '/publish').set('Cookie', cookies.admin).send({ _csrf: csrfToken, published: '0',reason:'Fixture unpublication' }).expect(302);
      await request(app).get('/community/' + joinedId).set('Cookie', cookies.other).expect(404);
      await request(app).post('/community/' + joinedId + '/reaction').set('Cookie', cookies.other).send({ _csrf: csrfToken, kind: 'support' }).expect(404);
      await request(app).post('/community/' + joinedId + '/comments').set('Cookie', cookies.other).send({ _csrf: csrfToken, body: 'Unpublished attempt' }).expect(404);
      const joinedPrivate = await store.detail(joinedId, { userId: owner.id });
      assert.equal(joinedPrivate.user_id, owner.id); assert.equal(joinedPrivate.status, 'In Progress');
      assert.equal(joinedPrivate.history.length, 3); assert.equal(joinedPrivate.responses.at(-1).body, 'Joined workflow official response');
    });

    await t.test('search literals, filters, bounded pagination, and analytics use real rows', async () => {
      const literal = await store.submit(owner.id, { ...values, title: "Literal ' OR 1=1 -- and 100%_ match" });
      await store.publish(literal.id,true,admin.id);
      const injection = await store.listFeedback({ publicOnly: true, search: "' OR 1=1 --" });
      assert.deepEqual(injection.items.map(row => row.id), [literal.id]);
      const wildcard = await store.listFeedback({ publicOnly: true, search: '100%_' });
      assert.equal(wildcard.total, 1);
      assert.equal((await store.listComments({ search: "' OR 1=1 --" })).total, 0);
      assert.equal((await store.listFeedback({ userId: other.id, search: "' OR 1=1 --" })).total, 0);
      assert.equal((await store.listFeedback({ status: 'Closed', type: 'Suggestion', categoryId: category.id })).total, 1);
      assert.equal((await store.listFeedback({ visibility: 'published' })).total, 2);
      for (let index = 0; index < 14; index++) {
        const result = await store.submit(owner.id, { ...values, title: 'Pagination fixture ' + String(index).padStart(2, '0'), type: index % 2 ? 'Complaint' : 'Concern' });
        await store.publish(result.id,true,admin.id);
      }
      const first = await store.listFeedback({ publicOnly: true, page: 1, limit: 12 });
      const second = await store.listFeedback({ publicOnly: true, page: 2, limit: 12 });
      assert.equal(first.items.length, 12); assert.equal(second.items.length, 4); assert.equal(first.pages, 2);
      assert.equal(new Set([...first.items, ...second.items].map(row => row.id)).size, 16);
      assert.equal((await store.listFeedback({ publicOnly: true, type: 'Concern' })).total, 7);
      assert.equal((await store.listFeedback({ publicOnly: true, page: 999999, limit: 12 })).page, 2);
      assert.ok((await store.listFeedback({ limit: 99999 })).items.length <= 50);
      const analytics = await store.analytics();
      assert.equal(analytics.byType.reduce((sum, row) => sum + row.count, 0), analytics.total);
      assert.equal(analytics.byCategory.reduce((sum, row) => sum + row.count, 0), analytics.total);
    });

    await t.test('community ranking uses active reaction dates, submission dates, filters and persisted viewer selections', async () => {
      const make = async (label, type = 'Suggestion') => {
        const result = await store.submit(owner.id, { ...values, title: 'Community sort fixture ' + label, type });
        await store.publish(result.id,true,admin.id);
        return result.id;
      };
      const popular = await make('popular');
      const trending = await make('recent support on older submission');
      const newest = await make('newest', 'Complaint');
      const hidden = await make('unpublished');
      await pool.execute('UPDATE feedback SET created_at = CURRENT_TIMESTAMP - INTERVAL 20 DAY WHERE id = ?', [popular]);
      await pool.execute('UPDATE feedback SET created_at = CURRENT_TIMESTAMP - INTERVAL 30 DAY WHERE id = ?', [trending]);
      await pool.execute('UPDATE feedback SET published_at = CURRENT_TIMESTAMP + INTERVAL 1 DAY WHERE id = ?', [popular]);
      const concurrent = await Promise.all([
        store.react(popular, owner.id, 'support', { withCounts: true }),
        store.react(popular, other.id, 'support', { withCounts: true })
      ]);
      assert.deepEqual(concurrent.map(result => result.support_count).sort(), [1, 2], 'serialized votes return current committed totals');
      await pool.execute('UPDATE feedback_reactions SET created_at = CURRENT_TIMESTAMP - INTERVAL 8 DAY, updated_at = CURRENT_TIMESTAMP - INTERVAL 8 DAY WHERE feedback_id = ?', [popular]);
      await store.react(trending, owner.id, 'not_helpful');
      await pool.execute('UPDATE feedback_reactions SET created_at = CURRENT_TIMESTAMP - INTERVAL 20 DAY, updated_at = CURRENT_TIMESTAMP - INTERVAL 20 DAY WHERE feedback_id = ?', [trending]);
      await store.react(trending, owner.id, 'support');
      await store.react(trending, other.id, 'not_helpful');
      await store.react(hidden, owner.id, 'support');
      await store.react(hidden, other.id, 'support');
      await store.publish(hidden,false,admin.id,{reason:'Test unpublication'});
      const options = { publicOnly: true, search: 'Community sort fixture', viewerId: owner.id };
      const ids = result => result.items.map(row => row.id);
      assert.deepEqual(ids(await store.listFeedback({ ...options, sort: 'most_supported' })), [popular, trending, newest]);
      assert.deepEqual(ids(await store.listFeedback({ ...options, sort: 'trending' })), [trending, newest, popular]);
      assert.deepEqual(ids(await store.listFeedback({ ...options, sort: 'newest' })), [newest, popular, trending]);
      const filtered = await store.listFeedback({ ...options, type: 'Suggestion', categoryId: category.id, status: 'Submitted', sort: 'most_supported' });
      assert.deepEqual(ids(filtered), [popular, trending]);
      assert.equal(filtered.items[0].support_count, 2);
      assert.equal(filtered.items[0].current_reaction, 'support');
      const otherView = await store.listFeedback({ ...options, viewerId: other.id, sort: 'trending' });
      assert.equal(otherView.items[0].current_reaction, 'not_helpful');
      assert.equal((await store.listFeedback({ ...options, search: (await store.detail(popular, { admin: true })).reference, sort: 'trending' })).total, 1);
      assert.equal((await store.listFeedback({ ...options, type: 'Suggestion', sort: 'most_supported', limit: 1, page: 2 })).items[0].id, trending);
      await assert.rejects(store.listFeedback({ ...options, sort: 'support_count; DROP TABLE feedback' }));
      // Removing Support immediately removes it from both rankings; Not Helpful is never subtracted.
      await store.react(trending, owner.id, 'support');
      assert.equal((await store.listFeedback({ ...options, sort: 'trending' })).items[0].id, newest);
      assert.equal((await store.listFeedback({ ...options, sort: 'most_supported' })).items[0].id, popular);
      const { app, cookies, csrfToken } = await fixtureApp({ store, userIds: { owner: owner.id, other: other.id, admin: admin.id } });
      const response = await request(app).post(`/community/${trending}/reaction`).set('Cookie', cookies.owner)
        .set('Accept', 'application/json').set('X-CSRF-Token', csrfToken).send({ kind: 'support', user_id: other.id }).expect(200);
      assert.deepEqual(response.body, { reaction: 'support', support_count: 1, not_helpful_count: 1 });
      const feed = await request(app).get('/community').query({ q: 'Community sort fixture', type: 'Suggestion', sort: 'trending' }).set('Cookie', cookies.owner).expect(200);
      assert.ok(feed.text.indexOf('recent support on older submission') < feed.text.indexOf('Community sort fixture popular'));
      assert.doesNotMatch(feed.text, /Community sort fixture unpublished/);
      assert.match(feed.text, /data-reaction="support" aria-pressed="true"/);
      await request(app).post(`/community/${hidden}/reaction`).set('Cookie', cookies.owner).set('Accept', 'application/json')
        .send({ _csrf: csrfToken, kind: 'support' }).expect(404);
      assert.equal((await store.detail(trending, { admin: true })).status, 'Submitted');
    });

    await t.test('every existing category combines with every community sort, filters, counts and pagination', async () => {
      const before = await store.categories(true);
      const rows = [];
      const prefix = 'Category ranking integration';
      for (const current of before.filter(item => item.active)) {
        for (const [kind, age, supports, recent] of [['popular', 20, 2, 0], ['trending', 30, 1, 1], ['newest', 10, 0, 0]]) {
          const item = await store.submit(owner.id, { ...values, categoryId: current.id, title: `${prefix} ${current.id} ${kind}` });
          await store.publish(item.id, true, admin.id);
          await pool.execute('UPDATE feedback SET created_at = TIMESTAMPADD(DAY, ?, CURRENT_TIMESTAMP) WHERE id = ?', [-age, item.id]);
          if (supports) await store.react(item.id, owner.id, 'support');
          if (supports === 2) await store.react(item.id, other.id, 'support');
          if (supports && !recent) await pool.execute('UPDATE feedback_reactions SET updated_at = CURRENT_TIMESTAMP - INTERVAL 8 DAY WHERE feedback_id = ?', [item.id]);
          rows.push({ id: item.id, categoryId: current.id, age, supports, recent });
        }
        // Same category and search, excluded by visibility or the type/status filters.
        await store.submit(owner.id, { ...values, categoryId: current.id, title: `${prefix} ${current.id} private` });
        const complaint = await store.submit(owner.id, { ...values, categoryId: current.id, type: 'Complaint', title: `${prefix} ${current.id} complaint` });
        await store.publish(complaint.id, true, admin.id);
        await pool.execute("UPDATE feedback SET status = 'Resolved' WHERE id = ?", [complaint.id]);
      }
      const fixture = await fixtureApp({ store, userIds: { owner: owner.id, admin: admin.id, other: other.id } });
      const comparators = {
        trending: (a, b) => b.recent - a.recent || a.age - b.age || b.id - a.id,
        most_supported: (a, b) => b.supports - a.supports || a.age - b.age || b.id - a.id,
        newest: (a, b) => a.age - b.age || b.id - a.id
      };
      const ids = result => result.items.map(item => item.id);
      for (const current of [null, ...before]) {
        for (const [sort, compare] of Object.entries(comparators)) {
          const options = { publicOnly: true, viewerId: owner.id, search: prefix, type: 'Suggestion', status: 'Submitted', visibility: 'published', categoryId: current?.id || '', sort };
          const expected = rows.filter(item => !current || item.categoryId === current.id).sort(compare).map(item => item.id);
          const result = await store.listFeedback({ ...options, limit: 100 });
          assert.deepEqual(ids(result), expected, `${current?.name || 'All Categories'} + ${sort}`);
          assert.equal(result.total, expected.length);
          const paged = [];
          for (let page = 1; page <= Math.max(1, Math.ceil(expected.length / 2)); page++) {
            const part = await store.listFeedback({ ...options, page, limit: 2 });
            assert.equal(part.total, expected.length);
            assert.equal(part.pages, Math.max(1, Math.ceil(expected.length / 2)));
            paged.push(...ids(part));
          }
          assert.deepEqual(paged, expected, 'no missing or duplicated results across pages');
          const last = await store.listFeedback({ ...options, page: 999, limit: 2 });
          assert.equal(last.page, Math.max(1, Math.ceil(expected.length / 2)));
          const response = await request(fixture.app).get('/community').query({ q: prefix, category: current?.id || '', sort, type: 'Suggestion', status: 'Submitted', visibility: 'published' })
            .set('Cookie', fixture.cookies.owner).expect(200);
          assert.doesNotMatch(response.text, new RegExp(`${prefix} \\d+ (?:private|complaint)`));
          assert.match(response.text, new RegExp(`community-result-count">${expected.length} results?`));
          if (current) assert.match(response.text, new RegExp(`<option value="${current.id}" selected>`));
          const articleIds = [...response.text.matchAll(/data-reactions="(\d+)"/g)].map(match => Number(match[1]));
          assert.deepEqual(articleIds, expected.slice(0, 12));
          for (const [, href] of response.text.matchAll(/href="([^\"]*page=\d+[^\"]*)"/g)) {
            const params = new URL(href.replaceAll('&amp;', '&'), 'http://localhost/community').searchParams;
            assert.equal(params.get('category'), String(current?.id || ''));
            assert.equal(params.get('sort'), sort); assert.equal(params.get('q'), prefix);
            assert.equal(params.get('type'), 'Suggestion'); assert.equal(params.get('status'), 'Submitted');
            assert.equal(params.get('visibility'), 'published');
          }
          const empty = await request(fixture.app).get('/community').query({ category: current?.id || '', sort, q: prefix + ' unmatched' })
            .set('Cookie', fixture.cookies.owner).expect(200);
          assert.match(empty.text, /No feedback matches your filters\./);
          assert.match(empty.text, /community-result-count">0 results/);
          assert.doesNotMatch(empty.text, /<nav class="pagination"/);
        }
      }
      for (const sort of Object.keys(comparators)) {
        const complaints = await store.listFeedback({ publicOnly: true, search: prefix, type: 'Complaint', status: 'Resolved', sort });
        assert.equal(complaints.total, before.filter(item => item.active).length);
        assert.equal((await store.listFeedback({ publicOnly: true, visibility: 'private', search: prefix, sort })).total, 0);
        const privateFeed = await request(fixture.app).get('/community').query({ visibility: 'private', sort })
          .set('Cookie', fixture.cookies.owner).expect(200);
        assert.match(privateFeed.text, /No feedback matches your filters\./);
        assert.doesNotMatch(privateFeed.text, /data-reactions="/);
      }
      assert.deepEqual(await store.categories(true), before, 'category records remain unchanged');
    });

    await t.test('unpublication retains feedback and blocks all community interactions', async () => {
      await store.publish(submission.id,false,admin.id,{reason:'Test unpublication'});
      assert.equal(await store.detail(submission.id, { publicOnly: true }), null);
      assert.equal(await store.attachmentForPublished(submission.id), null);
      assert.equal(await store.reactionFor(submission.id, owner.id), null);
      assert.deepEqual(await store.comments(submission.id), []);
      await assert.rejects(store.react(submission.id, owner.id, 'support'), error => error.status === 404);
      await assert.rejects(store.addComment(submission.id, owner.id, 'After unpublication'), error => error.status === 404);
      const retained = await store.detail(submission.id, { userId: owner.id });
      assert.equal(retained.reference, submission.reference); assert.equal(retained.history.length, 5); assert.equal(retained.responses.length, 1);
    });

    await t.test('submission notifications persist, deduplicate admin actions, isolate owners and require CSRF to read', async () => {
      const { app, cookies, csrfToken } = await fixtureApp({ store, userIds: { owner: owner.id, admin: admin.id, other: other.id } });
      const before = await store.unreadNotificationCount(owner.id);
      const otherBefore = await store.unreadNotificationCount(other.id);
      const item = await store.submit(owner.id, { ...values, title: 'Notification ownership <script>alert(1)</script>' });
      const key = crypto.randomUUID();
      await store.updateStatus(item.id, 'Under Review', admin.id, { requestKey: key });
      await store.updateStatus(item.id, 'Under Review', admin.id, { requestKey: key });
      await store.updateStatus(item.id, 'Under Review', admin.id);
      await store.updateStatus(item.id, 'Under Review', admin.id, { response: 'An administrator response without changing the status.' });
      await store.addResponse(item.id, admin.id, 'A separate official response.');
      await store.publish(item.id, true, admin.id);
      await store.publish(item.id, true, admin.id);
      await store.publish(item.id, false, admin.id);
      assert.equal(await store.unreadNotificationCount(owner.id), before + 5);
      assert.equal(await store.unreadNotificationCount(other.id), otherBefore);
      const listed = await store.listNotifications(owner.id);
      // The additive migration is safe to rerun with saved notifications.
      await require('../scripts/migrate-notifications').migrate(pool);
      await require('../scripts/migrate-notifications').migrate(pool);
      assert.deepEqual(await store.listNotifications(owner.id), listed);
      const mine = listed.items.filter(row => row.feedback_id === item.id);
      assert.deepEqual(mine.map(row => row.kind), ['Unpublished', 'Published', 'AdminResponse', 'AdminResponse', 'StatusUpdated']);
      assert.ok(mine.every(row => !row.read_at));
      assert.equal((await store.listNotifications(other.id)).items.some(row => row.feedback_id === item.id), false);
      const page = await request(app).get('/notifications').set('Cookie', cookies.owner).expect(200);
      assert.match(page.text, /Notifications/);
      assert.match(page.text, /Notification ownership &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
      assert.doesNotMatch(page.text, /Notification ownership <script>/);
      const count = await request(app).get('/api/notifications/unread').query({ userId: other.id }).set('Cookie', cookies.owner).expect(200);
      assert.equal(count.body.unreadCount, before + 5);
      await request(app).get('/api/notifications/unread').expect(401);
      await request(app).get('/notifications').set('Cookie', cookies.admin).expect(200);
      await request(app).post(`/notifications/${mine[0].id}/read`).set('Cookie', cookies.owner).send({}).expect(403);
      await request(app).post(`/notifications/${mine[0].id}/read`).set('Cookie', cookies.other).send({ _csrf: csrfToken }).expect(404);
      await request(app).post('/notifications/not-an-id/read').set('Cookie', cookies.owner).send({ _csrf: csrfToken }).expect(422);
      for (let repeat = 0; repeat < 2; repeat++) await request(app).post(`/notifications/${mine[0].id}/read`).set('Cookie', cookies.owner)
        .send({ _csrf: csrfToken, userId: other.id }).expect(302).expect('Location', '/feedback/' + item.id);
      assert.equal(await store.unreadNotificationCount(owner.id), before + 4);
      // New updates arriving after the list was opened must survive Mark all as read.
      await store.addResponse(item.id, admin.id, 'Another update after opening the notification list.');
      await request(app).post('/notifications/read-all').set('Cookie', cookies.owner).send({ throughId: listed.latestId }).expect(403);
      await request(app).post('/notifications/read-all').set('Cookie', cookies.owner).send({ _csrf: csrfToken, throughId: listed.latestId }).expect(302);
      assert.equal(await store.unreadNotificationCount(owner.id), 1);
      assert.equal(await store.unreadNotificationCount(other.id), otherBefore);
      const lastPage = await store.listNotifications(owner.id, { page: 99999 });
      assert.equal(lastPage.page, lastPage.pages);
      const allIds = [];
      for (let number = 1; number <= lastPage.pages; number++) allIds.push(...(await store.listNotifications(owner.id, { page: number })).items.map(row => row.id));
      assert.equal(new Set(allIds).size, lastPage.total);
      await request(app).post('/notifications/read-all').set('Cookie', cookies.owner)
        .send({ _csrf: csrfToken, throughId: (await store.listNotifications(owner.id)).latestId }).expect(302);
      const [[saved]] = await pool.execute('SELECT COUNT(*) AS total FROM feedback_notifications WHERE feedback_id=? AND read_at IS NOT NULL', [item.id]);
      assert.equal(Number(saved.total), 6);
      assert.equal(await store.unreadNotificationCount(owner.id), 0);
    });

    await t.test('MySQL sessions persist across adapters, touch, expire, and destroy', async () => {
      sessions ||= new MySQLSessionStore(pool);
      const otherAdapter = new MySQLSessionStore(pool);
      const call = (adapter, method, ...args) => new Promise((resolve, reject) => adapter[method](...args, (error, result) => error ? reject(error) : resolve(result)));
      const sid = 'owned-integration-session';
      const data = { cookie: { expires: new Date(Date.now() + 60000) }, passport: { user: owner.id }, csrfToken: 'c'.repeat(64) };
      try {
        await call(sessions, 'set', sid, data);
        assert.equal((await call(otherAdapter, 'get', sid)).passport.user, owner.id);
        await call(otherAdapter, 'touch', sid, { ...data, cookie: { expires: new Date(Date.now() + 120000) } });
        const [[stored]] = await pool.execute('SELECT expires FROM sessions WHERE session_id=?', [sid]);
        assert.ok(Number(stored.expires) > Date.now() + 90000);
        await pool.execute('UPDATE sessions SET expires=? WHERE session_id=?', [Date.now() - 1000, sid]);
        assert.equal(await call(sessions, 'get', sid), null);
        await call(sessions, 'destroy', sid);
        assert.equal(await call(otherAdapter, 'get', sid), null);
      } finally { otherAdapter.close(); }
    });
  } finally {
    if (previousDatabase === undefined) delete process.env.DB_NAME; else process.env.DB_NAME = previousDatabase;
    sessions?.close();
    if (pool) await pool.end();
    if (created) {
      assert.match(databaseName, /^cspc_feedback_test_[a-f0-9]{16}$/);
      await connection.query(`DROP DATABASE \`${databaseName}\``);
    }
    await connection.end();
  }
});
