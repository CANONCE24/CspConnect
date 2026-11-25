'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('../scripts/setup-hosted-db');

function databaseFixture({ name = 'provider_assigned_name', tables = [] } = {}) {
  const queries = [];
  let released = false;
  const pool = { async getConnection() {
    return {
      async query(sql) {
        queries.push(sql);
        if (sql === 'SELECT DATABASE() AS name') return [[{ name }]];
        if (sql === 'SHOW FULL TABLES') return [tables];
        return [{}];
      },
      release() { released = true; }
    };
  } };
  return { pool, queries, get released() { return released; } };
}

test('hosted setup requires an explicit matching target and refuses existing tables or views', async () => {
  const missing = databaseFixture();
  await assert.rejects(setup(missing.pool), /Pass --database/);
  assert.equal(missing.queries.length, 0);
  const wrong = databaseFixture();
  await assert.rejects(setup(wrong.pool, 'old_database'), /does not match/);
  assert.deepEqual(wrong.queries, ['SELECT DATABASE() AS name']);
  assert.equal(wrong.released, true);
  for (const type of ['BASE TABLE', 'VIEW']) {
    const existing = databaseFixture({ tables: [{ object: 'users', Table_type: type }] });
    await assert.rejects(setup(existing.pool, 'provider_assigned_name'), /not empty/);
    assert.deepEqual(existing.queries, ['SELECT DATABASE() AS name', 'SHOW FULL TABLES']);
    assert.equal(existing.released, true);
  }
});

test('hosted setup imports the full fresh schema into a provider-assigned empty database', async () => {
  const fixture = databaseFixture();
  const result = await setup(fixture.pool, 'provider_assigned_name');
  const writes = fixture.queries.slice(2);
  assert.equal(result.database, 'provider_assigned_name');
  assert.equal(result.statements, writes.length);
  for (const table of ['users', 'categories', 'sessions', 'feedback', 'comment_moderation',
    'email_verifications', 'support_tickets', 'feedback_notifications', 'emergency_reports']) {
    assert(writes.some(sql => new RegExp('^CREATE TABLE (?:IF NOT EXISTS )?' + table + '\\s*\\(').test(sql)), table);
  }
  assert(writes.some(sql => sql.startsWith('INSERT INTO categories')));
  assert.equal(writes.at(-1), "INSERT INTO login_migrations(name) VALUES ('email-otp-v1')");
  assert(!writes.some(sql => /^(?:DROP|TRUNCATE|ALTER|DELETE|CREATE DATABASE)\b/i.test(sql)));
  assert.equal(fixture.released, true);
});
