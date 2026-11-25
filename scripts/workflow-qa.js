'use strict';
// Real browser forms and the real model, confined to a newly owned temporary database.
require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');
const { chromium } = require('playwright-core');

async function main() {
  const database = 'cspc_feedback_test_' + crypto.randomBytes(8).toString('hex');
  assert.match(database, /^cspc_feedback_test_[a-f0-9]{16}$/);
  const connection = await mysql.createConnection({ host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '' });
  let owned = false, pool, app, server, browser;
  const steps = [];
  const pass = label => { steps.push(label); console.log('Passed: ' + label); };
  const originalDatabase = process.env.DB_NAME;
  try {
    const [existing] = await connection.execute('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [database]);
    assert.equal(existing.length, 0);
    await connection.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    owned = true;
    await connection.changeUser({ database });
    const root = path.resolve(__dirname, '..');
    const sql = await fs.readFile(path.join(root, 'schema.sql'), 'utf8') + '\n' + await fs.readFile(path.join(root, 'seed.sql'), 'utf8');
    for (const statement of sql.replace(/^\s*--.*$/gm, '').split(';').map(item => item.trim()).filter(Boolean)) await connection.query(statement);
    process.env.DB_NAME = database;
    pool = require('../src/config/db').pool;
    const store = require('../src/models/store');
    const { createHash } = require('../src/services/passwords');
    const originalPassword = 'Workflow-password-original!';
    const newPassword = 'Workflow-password-updated!';
    await pool.execute(`INSERT INTO users (name,email,password_hash,role,must_change_password,email_verified_at,password_verified_at) VALUES (?,?,?,'admin',1,CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3))`,
      ['Workflow Administrator', 'workflow.admin@example.test', await createHash(originalPassword)]);
    const accountEmails=[],verificationEmails=[];
    app = require('../src/app').createApp({sendAccountEmail:async item=>accountEmails.push(item),sendVerificationEmail:async item=>verificationEmails.push(item), config: { nodeEnv: 'test', sessionSecret: crypto.randomBytes(48).toString('hex'),
      googleClientId: '', googleClientSecret: '', geminiApiKey: '', adminEmails: ['workflow.admin@example.test'], allowedEmailDomain: '' } });
    server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
    const base = 'http://127.0.0.1:' + server.address().port;
    const executablePath = process.env.BROWSER_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(filename => require('node:fs').existsSync(filename));
    assert(executablePath, 'An installed browser is required.');
    browser = await chromium.launch({ executablePath, headless: true });
    const errors = [];
    const newPage = async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const page = await context.newPage();
      page.setDefaultTimeout(12000);
      page.on('pageerror', error => errors.push(error.message));
      return page;
    };
    const owner = await newPage(), viewer = await newPage(), admin = await newPage();
    const visit = async (page, route, status = 200) => {
      const response = await page.goto(base + route, { waitUntil: 'networkidle' });
      assert.equal(response.status(), status, route);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2), false, route + ' overflow');
    };
    const signup = async (page, name, email) => {
      await visit(page, '/signup');
      await page.locator('#signup-name').fill(name); await page.locator('#signup-email').fill(email);
      await page.locator('#signup-password').fill(originalPassword); await page.locator('#signup-confirmation').fill(originalPassword);
      await page.getByRole('button', { name: 'Create account', exact: true }).click();
      await page.waitForURL(base + '/verify-email');
      const item=verificationEmails.filter(item=>item.email===email).at(-1);assert(item);
      assert.equal(await page.locator('[data-resend-code]').isDisabled(),true);
      if(email==='workflow.student@cspc.edu.ph'){
        await page.screenshot({path:path.join(root,'docs/qa/email-verification-desktop.png'),fullPage:true});
        await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false);
        await page.screenshot({path:path.join(root,'docs/qa/email-verification-mobile.png'),fullPage:true});await page.setViewportSize({width:1440,height:1000});
      }
      await page.locator('#verification-code').fill(item.code);
      await page.getByRole('button',{name:'Verify email',exact:true}).click();await page.waitForURL(base+'/complete-profile');
      assert.equal(await page.locator('#affiliation option[value="Visitor"]').count(),0);
      await page.screenshot({path:path.join(root,'docs/qa/affiliation-desktop.png'),fullPage:true});
      await page.setViewportSize({width:390,height:844});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false);
      await page.screenshot({path:path.join(root,'docs/qa/affiliation-mobile.png'),fullPage:true});
      await page.setViewportSize({width:1440,height:1000});
      await page.locator('#affiliation').selectOption(email.includes('viewer')?'Faculty':'Student');
      await page.getByRole('button',{name:'Continue to CSPConnect',exact:true}).click();await page.waitForURL(base+'/dashboard');
      const user=await store.passwordAccountByEmail(email);assert.equal(user.role,'student');assert(user.affiliation);
      await visit(page,'/complete-profile');assert.equal(new URL(page.url()).pathname,'/dashboard');
    };
    const signin = async (page, email, password) => {
      await visit(page, '/login');
      await page.locator('#login-email').fill(email); await page.locator('#login-password').fill(password);
      await page.locator('form[action="/auth/login"] button[type="submit"]').click();
    };
    await signup(owner, 'Workflow Student', 'workflow.student@cspc.edu.ph');
    await signup(viewer, 'Workflow Viewer', 'workflow.viewer@cspc.edu.ph');
    pass('registration and authenticated student dashboards');
    await visit(owner, '/feedback/new');
    await owner.locator('#type').selectOption('Suggestion');
    await owner.locator('#categoryId').selectOption({ label: 'Campus Facilities' });
    const title = 'Provide quieter seating for individual study';
    await owner.locator('#feedback-title').fill(title);
    await owner.locator('#description').fill('Please consider a small quiet study section with accessible desks, while keeping a separate area for group discussion.');
    await owner.locator('#isAnonymous').check();
    const photo = await require('sharp')({ create: { width: 32, height: 20, channels: 3, background: '#668899' } }).png().toBuffer();
    await owner.locator('#attachment').setInputFiles({ name: 'study-area.png', mimeType: 'image/png', buffer: photo });
    await owner.getByRole('button', { name: 'Submit Feedback', exact: true }).click();
    await owner.waitForURL(/\/feedback\/\d+$/);
    const feedbackId = Number(owner.url().match(/\/feedback\/(\d+)$/)[1]);
    await owner.locator('[data-submission-notice]').waitFor();
    const reference = (await owner.locator('#submission-reference strong').textContent()).trim();
    assert.match(reference, /^FB-\d{4}-\d{5,}$/);
    await visit(viewer, '/feedback/' + feedbackId, 404);
    await visit(viewer, '/attachments/' + feedbackId, 404);
    await visit(viewer, '/community'); assert.equal(await viewer.getByRole('heading', { name: title }).count(), 0);
    pass('anonymous submission with real image, reference, and private ownership');
    await signin(admin, 'workflow.admin@example.test', originalPassword);
    await admin.waitForURL(base + '/account/password');
    await visit(admin, '/admin'); assert.equal(new URL(admin.url()).pathname, '/account/password');
    await admin.locator('#new-password').fill(newPassword); await admin.locator('#confirm-password').fill(newPassword);
    await admin.getByRole('button', { name: 'Save password', exact: true }).click(); await admin.waitForURL(base + '/admin');
    pass('administrator first-login password requirement');
    await visit(admin, '/admin/feedback/' + feedbackId);
    await admin.locator('#status').selectOption('In Progress');
    const responseText = 'We will review the available study areas and accessibility requirements before proposing a trial.';
    await admin.locator('#response-body').fill(responseText); await admin.getByRole('button', { name: 'Update & Notify', exact: true }).click();
    await admin.getByRole('button', { name: 'Confirm update', exact: true }).click();
    await admin.getByRole('button', { name: 'Publish to Community Feed', exact: true }).click();
    const privateRecord = await store.detail(feedbackId, { admin: true });
    assert.equal(privateRecord.status, 'In Progress'); assert.equal(privateRecord.responses[0].body, responseText);
    assert.equal(privateRecord.is_published, 1);
    await visit(owner, '/feedback/' + feedbackId); assert((await owner.textContent('main')).includes(responseText));
    pass('admin status, official response, publication, and owner tracking');
    await owner.getByLabel('My account', { exact: true }).click();
    await owner.locator('[data-notification-count]').filter({ hasText: '2' }).waitFor();
    await owner.screenshot({ path: path.join(root, 'docs/qa/notifications-menu.png'), fullPage: true });
    await owner.locator('[data-notification-link]').click();
    await owner.waitForURL(base + '/notifications');
    assert.equal(await owner.locator('.notification-item.is-unread').count(), 2);
    await owner.screenshot({ path: path.join(root, 'docs/qa/notifications-desktop.png'), fullPage: true });
    await owner.setViewportSize({ width: 390, height: 844 });
    assert.equal(await owner.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2), false);
    await owner.screenshot({ path: path.join(root, 'docs/qa/notifications-mobile.png'), fullPage: true });
    await owner.getByRole('button', { name: 'View submission', exact: true }).first().click();
    await owner.waitForURL(base + '/feedback/' + feedbackId);
    assert.equal(await owner.locator('[data-notification-count]').textContent(), '1');
    await visit(owner, '/notifications');
    await owner.getByRole('button', { name: 'Mark all as read', exact: true }).click();
    await owner.waitForLoadState('networkidle');
    assert.equal(await owner.locator('.notification-item.is-unread').count(), 0);
    assert.equal(await owner.locator('[data-notification-count]').isHidden(), true);
    await owner.setViewportSize({ width: 1440, height: 1000 });
    const notificationResponse = await store.addResponse(feedbackId, (await store.passwordAccountByEmail('workflow.admin@example.test')).id, 'Your feedback has received another official response.');
    assert.ok(notificationResponse.id);
    // Opening the menu refreshes the badge without reloading the page.
    await owner.bringToFront();
    await owner.getByLabel('My account', { exact: true }).click();
    await owner.locator('[data-notification-count]').filter({ hasText: '1' }).waitFor({ state: 'visible' });
    await owner.getByLabel('My account', { exact: true }).click();
    await visit(viewer, '/notifications');
    assert.equal(await viewer.locator('.notification-item').count(), 0);
    await viewer.getByText("You're all caught up.", { exact: true }).waitFor();
    pass('persistent owner notifications, live menu badge, read actions, privacy and mobile layout');
    if (process.env.QA_NOTIFICATIONS_ONLY === '1') { assert.deepEqual(errors, []); return; }
    await visit(viewer, '/community/' + feedbackId);
    const publicText = await viewer.textContent('main'); assert(publicText.includes('Anonymous'));
    assert(!publicText.includes('Workflow Student')); assert(!publicText.includes(responseText));
    const support = viewer.locator('button[data-reaction="support"]');
    const against = viewer.locator('button[data-reaction="not_helpful"]');
    for (const [button, expected] of [[support,'support'],[support,null],[against,'not_helpful'],[support,'support']]) {
      await button.click();
      await viewer.waitForFunction(() => !document.querySelector('[data-reactions]').hasAttribute('aria-busy'));
      assert.equal(await store.reactionFor(feedbackId, (await store.passwordAccountByEmail('workflow.viewer@cspc.edu.ph')).id), expected);
    }
    const commentText = 'Could the trial keep some walk-in seats available for students between classes?';
    await viewer.locator('#comment-body').fill(commentText); await viewer.getByRole('button', { name: 'Post comment', exact: true }).click();
    await viewer.locator('.comment').filter({ hasText: commentText }).waitFor();
    pass('anonymous public display, reaction toggle/switch, and comments');
    await visit(admin, '/admin/comments');
    const row = admin.locator('tbody tr').filter({ hasText: commentText });
    admin.once('dialog',dialog=>dialog.accept());await row.getByRole('button', { name: 'Hide', exact: true }).click();
    await visit(viewer, '/community/' + feedbackId); assert.equal(await viewer.locator('.comment').filter({ hasText: commentText }).count(), 0);
    await row.getByRole('button', { name: 'Restore', exact: true }).click();
    await visit(viewer, '/community/' + feedbackId); assert.equal(await viewer.locator('.comment').filter({ hasText: commentText }).count(), 1);
    pass('comment moderation and restoration');
    await visit(admin, '/admin/categories');
    await admin.locator('#new-category-name').fill('Workflow Services');
    await admin.getByRole('button', { name: 'Add category', exact: true }).click();
    const category = (await store.categories()).find(item => item.name === 'Workflow Services'); assert(category);
    await visit(owner, '/feedback/new'); assert.equal(await owner.locator('#categoryId option').filter({ hasText: 'Workflow Services' }).count(), 1);
    await admin.locator('#category-active-' + category.id).selectOption('0');
    await admin.locator('form').filter({ has: admin.locator('#category-active-' + category.id) }).getByRole('button', { name: 'Save', exact: true }).click();
    await visit(owner, '/feedback/new'); assert.equal(await owner.locator('#categoryId option').filter({ hasText: 'Workflow Services' }).count(), 0);
    await visit(admin, '/admin/analytics'); assert((await admin.textContent('.most-supported')).includes(title));
    pass('category creation/availability and database-backed analytics');
    await visit(owner, '/account');
    await owner.locator('#profile-name').fill('Updated Workflow Student');
    await owner.locator('#profile-photo').setInputFiles({ name: 'profile.png', mimeType: 'image/png', buffer: photo });
    await owner.getByRole('button', { name: 'Save changes', exact: true }).click();
    await owner.getByText('Your profile has been updated.', { exact: true }).waitFor();
    assert.equal(await owner.locator('.profile-identity h2').textContent(), 'Updated Workflow Student');
    const avatar = await owner.locator('.account .profile-avatar img').getAttribute('src');
    assert.equal((await owner.request.get(base + avatar)).status(), 200);
    await owner.locator('[data-remove-photo]').check(); await owner.getByRole('button', { name: 'Save changes', exact: true }).click();
    await owner.getByText('Your profile has been updated.', { exact: true }).waitFor();
    assert.equal(await owner.locator('.account .profile-avatar img').count(), 0);
    pass('profile name, photo upload and removal using actual database storage');
    await visit(owner, '/account/password');
    await owner.locator('#current-password').fill(originalPassword); await owner.locator('#new-password').fill(newPassword); await owner.locator('#confirm-password').fill(newPassword);
    await owner.getByRole('button', { name: 'Save password', exact: true }).click(); await owner.waitForURL(base + '/dashboard');
    await owner.locator('.sidebar .signout').click(); await owner.waitForURL(base + '/login');
    await signin(owner, 'workflow.student@cspc.edu.ph', originalPassword);
    await owner.getByRole('alert').filter({ hasText: 'Email or password is incorrect.' }).waitFor();
    await signin(owner, 'workflow.student@cspc.edu.ph', newPassword); await owner.waitForURL(base + '/dashboard');
    pass('password change, logout, rejection of old password, and new-password login');
    await owner.locator('.sidebar .signout').click();await owner.waitForURL(base+'/login');
    const recoveryAccount=await store.passwordAccountByEmail('workflow.student@cspc.edu.ph');
    await pool.execute('UPDATE account_action_tokens SET created_at=DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 2 MINUTE) WHERE user_id=?',[recoveryAccount.id]);
    await visit(owner,'/forgot-password');await owner.locator('#email').fill(recoveryAccount.email);await owner.getByRole('button',{name:'Send email',exact:true}).click();await owner.waitForURL(base+'/login');
    const recoveryEmail=accountEmails.filter(item=>item.email===recoveryAccount.email&&item.purpose==='reset').at(-1);assert(recoveryEmail);
    await owner.goto(base+'/reset-password?token='+recoveryEmail.token);await owner.setViewportSize({width:390,height:844});
    assert.equal(await owner.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false);
    await owner.screenshot({path:path.join(root,'docs/qa/password-recovery-mobile.png'),fullPage:true});
    const recoveredPassword='Workflow-recovered-password!';await owner.locator('#password').fill(recoveredPassword);await owner.locator('#confirm').fill(recoveredPassword);await owner.getByRole('button',{name:'Save password',exact:true}).click();await owner.waitForURL(base+'/login');
    await signin(owner,recoveryAccount.email,recoveredPassword);await owner.waitForURL(base+'/dashboard');await owner.setViewportSize({width:1440,height:1000});
    pass('forgotten-password request, emailed token, mobile reset form and recovered login');
    await visit(admin, '/admin/feedback/' + feedbackId);
    await admin.getByRole('button', { name: 'Remove from Community Feed', exact: true }).click();
    await visit(viewer, '/community/' + feedbackId, 404); await visit(viewer, '/attachments/' + feedbackId, 404);
    await visit(owner, '/feedback/' + feedbackId); assert((await owner.textContent('main')).includes(reference));
    assert.equal((await owner.request.get(base + '/attachments/' + feedbackId)).status(), 200);
    pass('unpublication blocks public access and retains the private submission');
    for (const page of [owner, admin]) {
      await page.setViewportSize({ width: 390, height: 844 });
      for (const route of page === admin ? ['/admin','/admin/feedback','/admin/comments','/admin/categories','/admin/analytics','/account'] : ['/dashboard','/feedback','/community','/account','/professor']) await visit(page, route);
    }
    assert.deepEqual(errors, []);
    pass('populated student/admin mobile pages and no uncaught browser errors');
    await fs.writeFile(path.join(root, 'docs/qa/workflow-verification.json'), JSON.stringify({ checkedAt: new Date().toISOString(),
      result: 'passed', databaseScope: 'new owned temporary database, dropped after this run', steps }, null, 2));
  } finally {
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    app?.locals.sessionStore.close?.();
    if (pool) {
      const [images] = await pool.query(`SELECT attachment_path AS filename FROM feedback WHERE attachment_path IS NOT NULL
        UNION SELECT SUBSTRING(avatar_url, 10) AS filename FROM users WHERE avatar_url LIKE '/avatars/%'`);
      for (const image of images) await require('../src/services/uploads').removeImage(image.filename);
      await pool.end();
    }
    if (originalDatabase === undefined) delete process.env.DB_NAME; else process.env.DB_NAME = originalDatabase;
    if (owned) { assert.match(database, /^cspc_feedback_test_[a-f0-9]{16}$/); await connection.query(`DROP DATABASE \`${database}\``); }
    await connection.end();
  }
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
