'use strict';

// Explicit local reset. Never imported or run by application startup.
require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { pool } = require('../src/config/db');
const { names, discussions, privateSubmissions } = require('./presentation-data');
const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, '..');
const tables = [
  'feedback_email_retries', 'feedback_email_attempts', 'feedback_email_outbox',
  'feedback_comments', 'feedback_reactions', 'feedback_responses', 'feedback_status_history',
  'feedback', 'emergency_history', 'emergency_reports', 'emergency_settings_history', 'sessions'
];

async function backupDatabase(database) {
  const directory = path.join(root, '.local/backups');
  await fs.mkdir(directory, { recursive: true });
  const filename = path.join(directory, `${database}-before-presentation-${new Date().toISOString().replace(/[:.]/g, '-')}.sql`);
  const dump = process.env.MYSQLDUMP_BIN || path.join(path.dirname(process.env.LOCAL_MYSQL_BIN || 'C:/xampp/mysql/bin/mysqld.exe'), 'mysqldump.exe');
  await execFileAsync(dump, [
    '--no-defaults', `--host=${process.env.DB_HOST || '127.0.0.1'}`,
    `--port=${process.env.DB_PORT || 3306}`, `--user=${process.env.DB_USER || 'root'}`,
    '--single-transaction', '--skip-lock-tables', '--hex-blob', '--routines', '--triggers',
    `--result-file=${filename}`, '--databases', database
  ], { env: { ...process.env, MYSQL_PWD: process.env.DB_PASSWORD || '' }, windowsHide: true });
  const content = await fs.readFile(filename, 'utf8');
  assert(content.includes('Dump completed on'), 'Database backup did not finish.');
  assert(content.includes('CREATE TABLE `users`'), 'Database backup is missing its schema.');
  return filename;
}

async function main() {
  const database = process.env.DB_NAME || '';
  if (process.env.NODE_ENV === 'production' || !['127.0.0.1', 'localhost', '::1'].includes(process.env.DB_HOST || '127.0.0.1') ||
      !/^cspc_[a-z0-9_]+$/.test(database)) throw new Error('Reset supports only a local CSPC development database.');
  if (!process.argv.includes('--reset')) throw new Error('Use --reset to explicitly replace the local activity data.');
  const posts = [...discussions.map(post => ({ ...post, published: true })), ...privateSubmissions];
  for (const post of posts) {
    assert(post.title.length <= 150);
    assert(post.description.length >= 20);
    assert(!/\bdemo\b|sample scenario/i.test(JSON.stringify(post)));
    assert(names[post.owner]);
    for (const [person, body] of post.comments || []) { assert(names[person]); assert(body.length <= 500); }
    const reactions = [...(post.support || []), ...(post.against || [])];
    assert.equal(new Set(reactions).size, reactions.length);
  }
  const connection = await pool.getConnection();
  let committed = false;
  let manifestPath;
  try {
    const [[lock]] = await connection.query("SELECT GET_LOCK('cspconnect_presentation_reset', 0) AS acquired");
    assert.equal(lock.acquired, 1, 'Another presentation reset is running.');
    const backup = await backupDatabase(database);
    const manifest = { purpose: 'Fictional presentation records requested for October 21, 2026.',
      database, backup, createdAt: new Date().toISOString(), preservedAccounts: [], users: [], posts: [] };
    await connection.beginTransaction();
    const [users] = await connection.query('SELECT id, name, role, password_hash, google_id FROM users FOR UPDATE');
    const preserved = users.filter(user => user.password_hash || user.google_id);
    const admin = preserved.find(user => user.role === 'admin');
    assert(admin, 'A working administrator account must exist before reset.');
    manifest.preservedAccounts = preserved.map(({ id, name, role }) => ({ id, name, role }));
    const [categories] = await connection.query('SELECT id, name FROM categories WHERE active = 1');
    for (const post of posts) assert(categories.some(category => category.name === post.category), 'Missing category: ' + post.category);
    for (const table of tables) await connection.query(`DELETE FROM \`${table}\``);
    // Keep working sign-in accounts, including the administrator and guardhouse.
    const discarded = users.filter(user => !user.password_hash && !user.google_id).map(user => user.id);
    if (discarded.length) await connection.query(`DELETE FROM users WHERE id IN (${discarded.map(() => '?').join(',')})`, discarded);
    const now = Date.now();
    const at = hours => new Date(now - hours * 3600000);
    const year = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Manila', year: 'numeric' }).format(new Date(now));
    for (const name of names) {
      const email = name.toLowerCase().replaceAll(' ', '.') + '@presentation.invalid';
      const [result] = await connection.execute(`INSERT INTO users (name, email, role, created_at, updated_at)
        VALUES (?, ?, 'student', ?, ?)`, [name, email, at(168), at(168)]);
      manifest.users.push({ id: result.insertId, name, email });
    }
    for (const [index, post] of posts.entries()) {
      const id = index + 1;
      const reference = `FB-${year}-${String(id).padStart(5, '0')}`;
      const owner = manifest.users[post.owner];
      const category = categories.find(item => item.name === post.category);
      const status = post.statuses.at(-1) || 'Submitted';
      const changedAt = at(post.age - post.statuses.length);
      await connection.execute(`INSERT INTO feedback
        (id, user_id, category_id, reference, type, title, description, status, is_published, published_at, resolved_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, owner.id, category.id, reference, post.type, post.title, post.description, status,
        post.published ? 1 : 0, post.published ? at(post.age - 0.5) : null,
        status === 'Resolved' ? changedAt : null, at(post.age), changedAt]);
      await connection.execute(`INSERT INTO feedback_status_history
        (feedback_id, previous_status, status, changed_by, created_at) VALUES (?, NULL, 'Submitted', ?, ?)`, [id, owner.id, at(post.age)]);
      let previous = 'Submitted';
      for (const [step, next] of post.statuses.entries()) {
        await connection.execute(`INSERT INTO feedback_status_history
          (feedback_id, previous_status, status, changed_by, created_at) VALUES (?, ?, ?, ?, ?)`,
        [id, previous, next, admin.id, at(post.age - 1 - step)]);
        previous = next;
      }
      for (const [step, [person, body]] of (post.comments || []).entries()) {
        const timestamp = at(post.age - 2 - step * 0.75);
        await connection.execute(`INSERT INTO feedback_comments (feedback_id, user_id, body, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)`, [id, manifest.users[person].id, body, timestamp, timestamp]);
      }
      for (const [kind, people] of [['support', post.support || []], ['not_helpful', post.against || []]]) {
        for (const [step, person] of people.entries()) {
          const timestamp = at(post.age - 1 - step * 0.4);
          await connection.execute(`INSERT INTO feedback_reactions (feedback_id, user_id, kind, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)`, [id, manifest.users[person].id, kind, timestamp, timestamp]);
        }
      }
      if (post.response) await connection.execute(`INSERT INTO feedback_responses (feedback_id, admin_id, body, created_at)
        VALUES (?, ?, ?, ?)`, [id, admin.id, post.response, changedAt]);
      manifest.posts.push({ id, reference, author: owner.name, title: post.title, type: post.type, status,
        published: Boolean(post.published), comments: (post.comments || []).length,
        support: (post.support || []).length, notHelpful: (post.against || []).length });
    }
    const [[counts]] = await connection.query(`SELECT COUNT(*) AS total, SUM(is_published = 1) AS published FROM feedback`);
    assert.equal(counts.total, posts.length);
    assert.equal(Number(counts.published), discussions.length);
    const [[oldLabels]] = await connection.query("SELECT COUNT(*) AS total FROM users WHERE name LIKE '%(Demo)%'");
    assert.equal(oldLabels.total, 0);
    manifestPath = path.join(root, 'docs/qa', `presentation-records-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    await connection.commit();
    committed = true;
    console.log(JSON.stringify({ backup, manifest: manifestPath, feedback: posts.length, published: discussions.length,
      private: privateSubmissions.length, characters: names, preservedAccounts: manifest.preservedAccounts,
      submittedConcern: manifest.posts.find(post => !post.published && post.type === 'Concern') }, null, 2));
  } catch (error) {
    if (!committed) {
      await connection.rollback();
      if (manifestPath) await fs.unlink(manifestPath).catch(() => {});
    }
    throw error;
  } finally {
    await connection.query("SELECT RELEASE_LOCK('cspconnect_presentation_reset')");
    connection.release();
  }
}

if (require.main === module) main().catch(error => {
  console.error('Presentation reset failed:', error.message); process.exitCode = 1;
}).finally(() => pool.end());
