'use strict';
// Isolated UI verification only. No test login route or fixture data enters the application database.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const session = require('express-session');
const { chromium } = require('playwright-core');
const { createApp } = require('../src/app');

async function main() {
  const executablePath = process.env.BROWSER_PATH || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  ].find(file => fs.existsSync(file));
  if (!executablePath) throw new Error('Set BROWSER_PATH to an installed Chrome or Edge executable.');
  const sessionSecret = crypto.randomBytes(48).toString('hex');
  const sessionStore = new session.MemoryStore();
  const csrfToken = crypto.randomBytes(32).toString('hex');
  const users = {
    1: { id: 1, name: 'QA student', email: 'student@example.test', role: 'student', created_at: new Date('2026-10-01'), has_password: true },
    2: { id: 2, name: 'QA administrator', email: 'admin@example.test', role: 'admin', created_at: new Date('2026-10-01'), has_password: true }
  };
  for(const user of Object.values(users)){user.email_verified_at=new Date();user.campus_approved_at=new Date();user.session_version=0;}
  const zeroStats = { total: 0, submitted: 0, underReview: 0, inProgress: 0, resolved: 0, closed: 0, published: 0, hiddenComments: 0 };
  const categoryList = [{ id: 1, name: 'Campus facilities', active: 1 }];
  let populated = false;
  const feedback = {
    id: 1, reference: 'FB-2026-00001', type: 'Suggestion', category_name: 'Campus facilities',
    title: 'A'.repeat(150), description: 'Quality assurance text. '.repeat(20), is_anonymous: true,
    is_published: true, status: 'Under Review', created_at: new Date(), published_at: new Date(),
    author_name: 'Anonymous', support_count: 0, not_helpful_count: 0, comment_count: 0,
    history: [{ to_status: 'Submitted', created_at: new Date() }, { from_status: 'Submitted', to_status: 'Under Review', created_at: new Date() }],
    responses: [{ body: 'Quality assurance official response.', admin_name: 'QA administrator', created_at: new Date() }]
  };
  const store = {
    unreadNotificationCount: async () => 0,
    getUser: async id => users[id], stats: async () => zeroStats,
    updateProfile: async (id, values) => {
      users[id].name = values.name;
      if (values.avatarUrl !== undefined) users[id].avatar_url = values.avatarUrl;
    },
    profilePhotoExists: async filename => Object.values(users).some(user => user.avatar_url === '/avatars/' + filename),
    categories: async () => categoryList,
    listFeedback: async () => ({ items: populated ? [feedback] : [], total: populated ? 1 : 0, page: 1, pages: 1 }),
    listComments: async () => ({ items: [], total: 0, page: 1, pages: 1 }),
    detail: async (id, options) => id === 1 ? { ...feedback, history: options.publicOnly ? [] : feedback.history, responses: options.publicOnly ? [] : feedback.responses } : null,
    comments: async () => [], reactionFor: async () => feedback.current_reaction || null,
    react: async (_id, _userId, kind, { withCounts = false } = {}) => {
      feedback.current_reaction = kind === 'remove' || feedback.current_reaction === kind ? null : kind;
      feedback.support_count = feedback.current_reaction === 'support' ? 1 : 0;
      feedback.not_helpful_count = feedback.current_reaction === 'not_helpful' ? 1 : 0;
      return withCounts ? { reaction: feedback.current_reaction, support_count: feedback.support_count, not_helpful_count: feedback.not_helpful_count } : feedback.current_reaction;
    }
  };
  const app = createApp({ store, sessionStore, emailOutbox: { async list() { return {items:[],total:0,page:1,pages:1}; } }, config: {
    nodeEnv: 'development', sessionSecret, googleClientId: 'isolated-qa-client', googleClientSecret: 'isolated-qa-secret',
    geminiApiKey: '', adminEmails: ['admin@example.test'], allowedEmailDomain: ''
  } });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  let browser;
  const errors = [];
  const directory = path.resolve(__dirname, '../docs/qa');
  fs.mkdirSync(directory, { recursive: true });
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    async function visit(route, filename) {
      const response = await page.goto(baseUrl + route, { waitUntil: 'networkidle' });
      assert.equal(response.status(), 200, route + ' should render');
      assert.equal(await page.locator('h1').count(), 1, route + ' should have one page heading');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
      if (overflow) {
        console.log(JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('main *')]
          .filter(element => element.getBoundingClientRect().right > window.innerWidth + 2)
          .slice(0, 15).map(element => ({ tag: element.tagName, class: element.className, right: Math.round(element.getBoundingClientRect().right), width: Math.round(element.getBoundingClientRect().width) })))));
        await page.screenshot({ path: path.join(directory, 'overflow-diagnostic.png'), fullPage: true });
      }
      assert.equal(overflow, false, route + ' should fit the viewport');
      if (filename) await page.screenshot({ path: path.join(directory, filename), fullPage: true });
    }
    async function authenticate(userId) {
      const sid = crypto.randomBytes(24).toString('hex');
      await new Promise((resolve, reject) => sessionStore.set(sid, {
        cookie: { originalMaxAge: 3600000, expires: new Date(Date.now() + 3600000), httpOnly: true, sameSite: 'lax', path: '/' },
        passport: { user: {id:userId,version:0} }, csrfToken
      }, error => error ? reject(error) : resolve()));
      const sig = crypto.createHmac('sha256', sessionSecret).update(sid).digest('base64').replace(/=+$/, '');
      await context.clearCookies();
      await context.addCookies([{ name: 'cspc.sid', value: 's:' + sid + '.' + sig, url: baseUrl, httpOnly: true, sameSite: 'Lax' }]);
    }
    await visit('/login', 'login-desktop.png');
    assert.match(await page.title(), /CSPConnect/);
    await page.locator('#login-password').fill('isolated-preview-password');
    await page.getByRole('button', { name: 'Show password', exact: true }).click();
    assert.equal(await page.locator('#login-password').getAttribute('type'), 'text');
    await page.getByRole('button', { name: 'Hide password', exact: true }).click();
    assert.equal(await page.locator('#login-password').getAttribute('type'), 'password');
    await visit('/signup', 'signup-desktop.png');
    await visit('/forgot-password', 'forgot-password-desktop.png');
    await visit('/reset-password?token=invalid', 'reset-password-desktop.png');
    await page.setViewportSize({ width: 390, height: 844 });
    await visit('/login', 'login-mobile.png');
    await visit('/signup');
    await visit('/forgot-password', 'forgot-password-mobile.png');
    await visit('/reset-password?token=invalid', 'reset-password-mobile.png');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await authenticate(1);
    await visit('/dashboard');
    await page.getByLabel('My account', { exact: true }).click();
    assert.equal(await page.locator('[data-account-menu]').getAttribute('open'), '');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('[data-account-menu]').getAttribute('open'), null);
    await page.getByLabel('My account', { exact: true }).click();
    await page.locator('.account-dropdown').getByRole('link', { name: 'My account', exact: true }).click();
    await page.waitForURL(baseUrl + '/account');
    await page.locator('#profile-name').fill('Mika Reyes');
    const profilePhoto = await require('sharp')({ create: { width: 400, height: 500, channels: 3, background: '#528778' } }).png().toBuffer();
    await page.locator('#profile-photo').setInputFiles({ name: 'profile.png', mimeType: 'image/png', buffer: profilePhoto });
    await page.getByText(/Ready to save/).waitFor();
    assert.match(await page.locator('[data-photo-preview] img').getAttribute('src'), /^blob:/);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.getByRole('status').filter({ hasText: 'Your profile has been updated.' }).waitFor();
    await visit('/account', 'account-desktop.png');
    assert.equal(await page.locator('.profile-identity h2').textContent(), 'Mika Reyes');
    assert.match(await page.locator('.account .profile-avatar img').getAttribute('src'), /^\/avatars\//);
    await page.getByLabel('My account', { exact: true }).click();
    await page.screenshot({ path: path.join(directory, 'account-menu.png'), fullPage: true });
    await page.locator('h1').click();
    assert.equal(await page.locator('[data-account-menu]').getAttribute('open'), null);
    await page.setViewportSize({ width: 390, height: 844 });
    await visit('/account', 'account-mobile.png');
    await page.locator('[data-remove-photo]').check();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.getByRole('status').filter({ hasText: 'Your profile has been updated.' }).waitFor();
    assert.equal(await page.locator('.account .profile-avatar img').count(), 0);
    await page.setViewportSize({ width: 1440, height: 1000 });
    for (const route of ['/dashboard', '/feedback/new', '/feedback', '/community', '/professor']) {
      await visit(route, route === '/dashboard' ? 'student-dashboard.png' : route === '/feedback/new' ? 'submit-feedback.png' : undefined);
    }
    await page.locator('[name="message"]').fill('How do I track feedback?');
    await page.locator('button[type="submit"]').last().click();
    await page.getByText(/Professor is unavailable right now/).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    for (const route of ['/dashboard', '/feedback/new', '/community', '/professor']) await visit(route);
    await page.screenshot({ path: path.join(directory, 'student-mobile.png'), fullPage: true });
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.getByRole('navigation').first().getByRole('link').first().waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('button', { name: 'Menu', exact: true }).getAttribute('aria-expanded'), 'false');
    populated = true;
    for (const route of ['/dashboard', '/feedback', '/feedback/1', '/community', '/community/1']) await visit(route);
    feedback.title = 'Extend library opening hours during examination weeks';
    feedback.description = 'Keeping the library open later during examinations would give students a quiet place to study and access learning resources after classes.';
    await page.setViewportSize({ width: 1440, height: 1000 });
    await visit('/community');
    await page.evaluate(() => { window.communityNavigationMarker = 'same-page'; });
    const group = page.locator('[data-reactions="1"]');
    const support = group.locator('button[data-reaction="support"]');
    const notHelpful = group.locator('button[data-reaction="not_helpful"]');
    async function react(button, selected, supportCount, notHelpfulCount) {
      await button.click();
      await page.waitForFunction(() => !document.querySelector('[data-reactions="1"]').hasAttribute('aria-busy'));
      assert.equal(await support.getAttribute('aria-pressed'), String(selected === 'support'));
      assert.equal(await notHelpful.getAttribute('aria-pressed'), String(selected === 'not_helpful'));
      assert.equal(await group.locator('[data-reaction-count="support"]').textContent(), String(supportCount));
      assert.equal(await group.locator('[data-reaction-count="not_helpful"]').textContent(), String(notHelpfulCount));
      assert.equal(await page.evaluate(() => window.communityNavigationMarker), 'same-page', 'reactions must not reload');
    }
    await react(support, 'support', 1, 0);
    await react(support, null, 0, 0);
    await react(notHelpful, 'not_helpful', 0, 1);
    await react(support, 'support', 1, 0);
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await support.getAttribute('aria-pressed'), 'true', 'saved selection survives reload');
    await page.route('**/community/1/reaction', route => route.fulfill({ status: 403, contentType: 'text/html', body: 'Expired CSRF token' }));
    await notHelpful.click();
    await group.locator('.reaction-message.is-error').waitFor();
    assert.match(await group.locator('.reaction-message').textContent(), /session expired/);
    assert.equal(await support.getAttribute('aria-pressed'), 'true', 'failed request preserves saved state');
    assert.equal(await group.locator('[data-reaction-count="support"]').textContent(), '1');
    await page.unroute('**/community/1/reaction');
    await page.locator('#filter-q').fill('library');
    await page.locator('#filter-type').selectOption('Suggestion');
    await page.locator('#filter-category').selectOption('1');
    await Promise.all([page.waitForURL(url => url.searchParams.get('q') === 'library'), page.getByRole('button', { name: 'Apply filters' }).click()]);
    await Promise.all([page.waitForURL(url => url.searchParams.get('sort') === 'most_supported'), page.getByRole('link', { name: 'Most Supported', exact: true }).click()]);
    assert.equal(new URL(page.url()).searchParams.get('q'), 'library');
    assert.equal(new URL(page.url()).searchParams.get('type'), 'Suggestion');
    assert.equal(new URL(page.url()).searchParams.get('category'), '1');
    assert.equal(await page.locator('#filter-category').inputValue(), '1');
    await page.getByRole('link', { name: 'Trending', exact: true }).click();
    await page.waitForURL(url => url.searchParams.get('sort') === 'trending');
    assert.equal(await page.locator('input[name="sort"]').inputValue(), 'trending');
    await page.locator('#filter-category').selectOption('');
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await page.waitForLoadState('networkidle');
    assert.equal(new URL(page.url()).searchParams.get('sort'), 'trending');
    assert.equal(new URL(page.url()).searchParams.get('category'), '');
    await page.locator('#filter-category').selectOption('1');
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await page.waitForLoadState('networkidle');
    assert.equal(new URL(page.url()).searchParams.get('sort'), 'trending');
    assert.equal(new URL(page.url()).searchParams.get('category'), '1');
    await page.getByRole('link', { name: 'Reset', exact: true }).click();
    await page.waitForURL(baseUrl + '/community');
    assert.equal(await page.locator('.feed-sort[aria-current="true"]>span').textContent(), 'Newest');
    await visit('/community', 'community-desktop.png');
    await page.setViewportSize({ width: 390, height: 844 });
    await visit('/community', 'community-mobile.png');
    await group.getByRole('link', { name: /Comments/ }).click();
    await page.waitForURL(baseUrl + '/community/1#discussion');
    assert.equal(await support.getAttribute('aria-pressed'), 'true');
    await page.evaluate(() => { window.communityNavigationMarker = 'same-page'; });
    await react(notHelpful, 'not_helpful', 0, 1);
    await react(support, 'support', 1, 0);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await authenticate(2);
    await visit('/admin', 'admin-community-support.png');
    assert.equal(await page.locator('.most-supported tbody tr').count(), 1);
    assert.equal(await page.locator('.most-supported tbody tr td').nth(3).textContent(), '1');
    await visit('/community');
    assert.equal(await page.locator('button[data-reaction]').count(), 0, 'administrators cannot vote');
    populated = false;
    await page.setViewportSize({ width: 1440, height: 1000 });
    await authenticate(2);
    for (const route of ['/admin', '/admin/feedback', '/community', '/admin/comments', '/admin/categories', '/admin/analytics', '/account']) {
      await visit(route, route === '/admin' ? 'admin-dashboard.png' : undefined);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    for (const route of ['/admin', '/admin/feedback', '/admin/comments', '/admin/categories', '/admin/analytics']) await visit(route);
    populated = true;
    for (const route of ['/admin', '/admin/feedback', '/admin/feedback/1', '/community/1']) await visit(route);
    assert.deepEqual(errors, [], 'Browser should have no uncaught JavaScript errors');
    console.log('Browser QA passed: CSPConnect login/signup, password visibility, account menu keyboard/outside dismissal, profile editing, photo preview/upload/removal, student/admin pages, mobile fit, long titles, keyboard menu, Professor fallback, feed/detail reaction toggles and switching without navigation, persistence, failed reaction state, sorting with filters/reset, admin support table. Screenshots: docs/qa/.');
  } finally {
    for (const user of Object.values(users)) {
      if (user.avatar_url?.startsWith('/avatars/')) await require('../src/services/uploads').removeImage(user.avatar_url.split('/').at(-1));
    }
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    sessionStore.clear();
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
