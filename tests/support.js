'use strict';
const crypto = require('node:crypto');
const session = require('express-session');
const { createApp } = require('../src/app');
const secret = 'isolated-tests-session-secret-at-least-32-characters';
const csrfToken = 'a'.repeat(64);
const users = [
  { id: 841, name: 'Private Student Name', email: 'private-student@example.test', google_id: 'google-private-student', role: 'student' },
  { id: 842, name: 'Test Administrator', email: 'admin@example.test', google_id: 'google-admin', role: 'admin' },
  { id: 843, name: 'Another Student', email: 'another@example.test', google_id: 'google-another', role: 'student' }
];
function failure(status, message = 'Feedback was not found.') { const error = new Error(message); error.status = status; return error; }
function record(overrides = {}) {
  return { id: 11, reference: 'FB-2026-00011', reference_number: 'FB-2026-00011', user_id: 841,
    type: 'Suggestion', category_id: 1, category_name: 'Facilities', title: 'Improve classroom ventilation',
    description: 'Please improve ventilation in our classroom for better comfort.', status: 'Submitted',
    is_anonymous: 1, is_published: 0, published_at: null, created_at: '2026-10-06T02:00:00Z', updated_at: '2026-10-06T02:00:00Z',
    author_name: users[0].name, author_email: users[0].email, google_id: users[0].google_id,
    attachment_path: null, attachment_url: null, support_count: 0, not_helpful_count: 0, comment_count: 0,
    history: [{ from_status: null, to_status: 'Submitted', status: 'Submitted', created_at: '2026-10-06T02:00:00Z', admin_name: null }],
    responses: [], ...overrides };
}
function fixtureStore() {
  const feedback = [record(), record({ id: 12, reference: 'FB-2026-00012', is_published: 1, published_at: '2026-10-06T03:00:00Z' })];
  const commentRows = [{ id: 21, feedback_id: 12, user_id: 843, author_name: users[2].name, body: 'Visible community comment', is_hidden: 0, created_at: '2026-10-06T04:00:00Z' }];
  const reactions = new Map();
  const calls = [];
  const allCategories = [{ id: 1, name: 'Facilities', is_active: 1 }];
  const track = (name, args) => calls.push({ name, args });
  const find = id => feedback.find(item => item.id === id);
  const publicRecord = row => ({ ...row, author_name: row.is_anonymous ? 'Anonymous' : row.author_name,
    author_email: undefined, google_id: undefined, user_id: undefined, history: [], responses: [] });
  const needPublished = id => { const row = find(id); if (!row?.is_published) throw failure(404); return row; };
  const store = {
    calls, feedback, commentRows, reactions, users: users.map(user => ({ ...user,email_verified_at:new Date(),password_verified_at:new Date(),session_version:0 })),
    async getUser(id) { return store.users.find(user => user.id === Number(id)) || null; },
    async syncAccountRole(userId, role) { store.users.find(user => user.id === userId).role = role; },
    async updateProfile(userId, { name, avatarUrl }) {
      track('updateProfile', [userId, { name, avatarUrl }]);
      const user = store.users.find(item => item.id === userId);
      user.name = name;
      if (avatarUrl !== undefined) user.avatar_url = avatarUrl;
    },
    async profilePhotoExists(filename) { return store.users.some(user => user.avatar_url === '/avatars/' + filename); },
    async categories() { return allCategories; },
    async unreadNotificationCount() { return 0; },
    async stats(userId) { track('stats', [userId]); return { total: feedback.filter(row => !userId || row.user_id === userId).length,
      submitted: 2, underReview: 0, inProgress: 0, resolved: 0, closed: 0, published: 1, pending: 2, categories: [], types: [] }; },
    async listFeedback(options = {}) {
      track('listFeedback', [options]);
      let items = feedback.filter(row => (!options.userId || row.user_id === options.userId) && (!options.publicOnly || row.is_published));
      if (options.type) items = items.filter(row => row.type === options.type);
      if (options.status) items = items.filter(row => row.status === options.status);
      if (options.search) items = items.filter(row => row.title.includes(options.search) || row.description.includes(options.search));
      if (options.publicOnly) items = items.map(row => ({ ...publicRecord(row), current_reaction: reactions.get(`${row.id}:${options.viewerId}`) || null }));
      const limit = options.limit || 12, page = options.page || 1, total = items.length;
      return { items: items.slice((page - 1) * limit, page * limit), total, page, pages: Math.max(1, Math.ceil(total / limit)), limit };
    },
    async detail(id, options = {}) {
      track('detail', [id, options]);
      const row = find(id);
      if (!row || (options.publicOnly && !row.is_published) || (!options.publicOnly && !options.admin && row.user_id !== options.userId)) return null;
      return options.publicOnly ? publicRecord(row) : row;
    },
    async attachmentForPublished(id) { const row = find(id); return row?.is_published ? row : null; },
    async submit(userId, values) {
      track('submit', [userId, values]);
      const next = record({ id: 30, reference: 'FB-2026-00030', user_id: userId, type: values.type, title: values.title,
        description: values.description, is_anonymous: values.isAnonymous ? 1 : 0, category_id: values.categoryId,
        attachment_path: values.attachmentPath, attachment_mime: values.attachmentMime,
        attachment_url: values.attachmentPath ? '/attachments/30' : null });
      feedback.push(next); return { id: next.id, reference: next.reference };
    },
    async comments(id) { return commentRows.filter(row => row.feedback_id === id && !row.is_hidden); },
    async reactionFor(id, userId) { return reactions.get(`${id}:${userId}`) || null; },
    async react(id, userId, kind, { withCounts = false } = {}) {
      track('react', [id, userId, kind]); needPublished(id);
      if (kind === 'remove' || reactions.get(`${id}:${userId}`) === kind) {
        reactions.delete(`${id}:${userId}`); kind = null;
      } else reactions.set(`${id}:${userId}`, kind);
      const row = find(id);
      const kinds = [...reactions].filter(([key]) => key.startsWith(`${id}:`)).map(([, value]) => value);
      row.support_count = kinds.filter(value => value === 'support').length;
      row.not_helpful_count = kinds.filter(value => value === 'not_helpful').length;
      return withCounts ? { reaction: kind, support_count: row.support_count, not_helpful_count: row.not_helpful_count } : kind;
    },
    async addComment(id, userId, body) {
      track('addComment', [id, userId, body]); needPublished(id);
      commentRows.push({ id: 22 + commentRows.length, feedback_id: id, user_id: userId, body, author_name: users.find(user => user.id === userId).name,
        is_hidden: 0, created_at: '2026-10-06T05:00:00Z' });
    },
    async updateStatus(id, status, adminId, options = {}) { track('updateStatus', [id, status, adminId, options]); const row = find(id); if (!row) throw failure(404);
      row.history.push({ from_status: row.status, to_status: status, status, created_at: '2026-10-06T06:00:00Z', admin_name: 'Test Administrator' }); row.status = status; if(options.response?.trim()) row.responses.push({body:options.response.trim(),admin_name:'Test Administrator',created_at:'2026-10-06T06:00:00Z'}); },
    async addResponse(id, adminId, body) { track('addResponse', [id, adminId, body]); find(id).responses.push({ body, admin_name: 'Test Administrator', author_name: 'Test Administrator', created_at: '2026-10-06T06:00:00Z' }); },
    async publish(id, published, adminId) { track('publish', [id, published, adminId]); find(id).is_published = published ? 1 : 0; },
    async listComments() { return { items: commentRows, page: 1, pages: 1, total: commentRows.length, limit: 20 }; },
    async moderateComment(id, action, adminId) { track('moderateComment', [id, action, adminId]); const comment = commentRows.find(row => row.id === id); if (comment) { comment.is_hidden = action === true || action === 'remove' ? 1 : 0; comment.version=(comment.version || 1)+1; } },
    async categorySave(values) { track('categorySave', [values]); return 1; }
  };
  return store;
}
async function fixtureApp(overrides = {}) {
  const store = overrides.store || fixtureStore();
  const sessionStore = overrides.sessionStore || new session.MemoryStore();
  const challenges=new Map();
  const emailVerification=overrides.emailVerification || {async issue(details){const challenge=crypto.randomBytes(32).toString('hex');challenges.set(challenge,{...details,attempts:0,expires_at:new Date(Date.now()+300000),sent_at:new Date()});store.calls?.push({name:'issueVerification',args:[details]});return {challenge,code:'123456',email:details.email};},async status(challenge){return challenges.get(challenge)||null;}};
  const app = createApp({ store, sessionStore,passport:overrides.passport,emailVerification,sendVerificationEmail:overrides.sendVerificationEmail || (async()=>{}),verifyGoogleToken:overrides.verifyGoogleToken, accountSecurity:overrides.accountSecurity || {async issue(){return null;},async inspect(){return false;}},sendAccountEmail:overrides.sendAccountEmail || (async()=>{}), emergencyStore: overrides.emergencyStore, emailOutbox: overrides.emailOutbox || { async list() { return {items:[],total:0,page:1,pages:1}; } }, config: { sessionSecret: secret, nodeEnv: 'test', googleClientId: '', googleClientSecret: '',
    adminEmails: ['admin@example.test'], allowedEmailDomain: '', geminiApiKey: '', geminiModel: 'gemini-3.5-flash-lite', ...overrides.config } });
  const cookies = {};
  for (const [name, id] of Object.entries(overrides.userIds || { owner: 841, admin: 842, other: 843 })) {
    const sid = `isolated-${name}-${crypto.randomUUID()}`;
    const version=Number((await store.getUser(id))?.session_version || 0);
    await new Promise((resolve, reject) => sessionStore.set(sid, { cookie: { originalMaxAge: 3600000, expires: new Date(Date.now() + 3600000), httpOnly: true, path: '/' },
      passport: { user: {id,version} }, csrfToken }, error => error ? reject(error) : resolve()));
    const signed = sid + '.' + crypto.createHmac('sha256', secret).update(sid).digest('base64').replace(/=+$/, '');
    cookies[name] = 'cspc.sid=' + encodeURIComponent('s:' + signed);
  }
  return { app, store, sessionStore, cookies, csrfToken,emailVerification };
}
module.exports = { fixtureApp, fixtureStore, record, users, csrfToken };
