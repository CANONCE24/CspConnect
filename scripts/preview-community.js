'use strict';

// Explicitly labeled, removable local preview content. Never creates accounts or activity.
require('dotenv').config({ quiet: true });
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const store = require('../src/models/store');
const { pool } = require('../src/config/db');

const manifestPath = path.resolve(__dirname, '../docs/qa/community-preview-records.json');
const lockPath = `${manifestPath}.lock`;
const previews = [
  {
    type: 'Suggestion', category: 'Campus Facilities',
    title: 'Preview: More quiet study spaces',
    description: 'Preview content for demonstrating the Community Feed. This example suggests providing more quiet places for students to study between classes. It is sample content, not an actual student report or an official CSPC plan.'
  },
  {
    type: 'Concern', category: 'Campus Facilities',
    title: 'Preview: Walkway lighting after classes',
    description: 'Preview content for demonstrating the Community Feed. This example shows how a student could raise a concern about walkway lighting after evening classes. It does not report a verified campus issue or state an official CSPC policy.'
  },
  {
    type: 'Appreciation', category: 'Student Services',
    title: 'Preview: Helpful library support',
    description: 'Preview content for demonstrating the Community Feed. This example shows an appreciation message for helpful assistance with library resources. It is a sample message, not a testimonial from a real student.'
  }
];

function parseArgs(args) {
  if (args.includes('--help')) return { help: true };
  const action = args.shift() || 'create';
  if (!['create', 'remove'].includes(action)) throw new Error('Use create or remove, optionally followed by --owner <student-id>.');
  let ownerId = null;
  if (args.length) {
    if (args.length !== 2 || args[0] !== '--owner' || !/^[1-9]\d*$/.test(args[1])) {
      throw new Error('Use create or remove, optionally followed by --owner <student-id>.');
    }
    ownerId = Number(args[1]);
    if (!Number.isSafeInteger(ownerId)) throw new Error('Owner ID must be a valid numeric student ID.');
  }
  return { action, ownerId };
}

async function exists(filename) {
  try { await fs.access(filename); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function writeManifest(manifest) {
  const temporary = path.join(path.dirname(manifestPath), `.community-preview-${randomUUID()}.json`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    // The hard link creates the complete file atomically and fails if the final path exists.
    await fs.link(temporary, manifestPath);
  } finally {
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

function checkedManifest(value) {
  if (!value || !Number.isSafeInteger(value.ownerId) || value.ownerId < 1 ||
      !Array.isArray(value.records) || value.records.length < 1 || value.records.length > previews.length ||
      new Set(value.records.map(record => record.id)).size !== value.records.length ||
      value.records.some(record => !Number.isSafeInteger(record.id) || record.id < 1 || !/^FB-\d{4}-\d{5,}$/.test(record.reference))) {
    throw new Error('Preview manifest is invalid; no records were changed.');
  }
  return value;
}

async function withRecords(manifest, action) {
  checkedManifest(manifest);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const ids = manifest.records.map(record => record.id);
    const placeholders = ids.map(() => '?').join(',');
    const [rows] = await connection.execute(`SELECT id, user_id, reference, type, title, description,
      is_anonymous, attachment_path FROM feedback WHERE id IN (${placeholders}) FOR UPDATE`, ids);
    if (rows.length !== ids.length) throw new Error('A preview record is missing; no records were changed.');
    for (const [index, record] of manifest.records.entries()) {
      const row = rows.find(item => item.id === record.id);
      const preview = previews[index];
      if (row.user_id !== manifest.ownerId || row.reference !== record.reference || row.type !== preview.type ||
          row.title !== preview.title || row.description !== preview.description || row.is_anonymous !== 1 || row.attachment_path !== null) {
        throw new Error('A preview record no longer matches its original owner and content; no records were changed.');
      }
    }
    await action(connection, ids, placeholders);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
}

async function deleteRecords(manifest) {
  await withRecords(manifest, async (connection, ids, placeholders) => {
    // Preserve genuine student/admin contributions if anyone has interacted with the preview.
    for (const table of ['feedback_responses', 'feedback_reactions', 'feedback_comments']) {
      const [rows] = await connection.execute(`SELECT id FROM ${table} WHERE feedback_id IN (${placeholders}) LIMIT 1`, ids);
      if (rows.length) throw new Error('Preview records have responses, reactions, or comments. Cleanup refused to remove user contributions.');
    }
    const [history] = await connection.execute(`SELECT feedback_id, previous_status, status, changed_by
      FROM feedback_status_history WHERE feedback_id IN (${placeholders})`, ids);
    if (history.length !== ids.length || ids.some(id => {
      const entries = history.filter(entry => entry.feedback_id === id);
      return entries.length !== 1 || entries[0].previous_status !== null ||
        entries[0].status !== 'Submitted' || entries[0].changed_by !== manifest.ownerId;
    })) throw new Error('Preview status history has changed. Cleanup refused to remove administrator activity.');
    await connection.execute(`DELETE FROM feedback WHERE id IN (${placeholders}) AND user_id = ?`, [...ids, manifest.ownerId]);
  });
}

async function createPreview(ownerId) {
  if (await exists(manifestPath)) throw new Error('Preview manifest already exists. Remove its recorded previews before creating another set.');
  const [owners] = await pool.execute(
    `SELECT id FROM users WHERE role = 'student'${ownerId === null ? '' : ' AND id = ?'} ORDER BY id LIMIT 2`,
    ownerId === null ? [] : [ownerId]
  );
  if (owners.length !== 1) throw new Error('Creation requires exactly one existing student or an explicit eligible --owner ID.');
  ownerId = owners[0].id;
  const [duplicates] = await pool.execute('SELECT id FROM feedback WHERE title IN (?, ?, ?) LIMIT 1', previews.map(item => item.title));
  if (duplicates.length) throw new Error('Preview titles already exist. No duplicate posts were created.');
  const categories = await store.categories();
  if (!categories.length) throw new Error('At least one active category is required.');
  const manifest = { ownerId, records: [] };
  try {
    for (const item of previews) {
      const category = categories.find(value => value.name === item.category) || categories[0];
      const result = await store.submit(ownerId, {
        type: item.type, categoryId: category.id, title: item.title,
        description: item.description, isAnonymous: true
      });
      manifest.records.push({ id: Number(result.id), reference: result.reference });
    }
    await withRecords(manifest, async (connection, ids, placeholders) => {
      // A local preview fixture is intentionally published without inventing admin actions.
      await connection.execute(`UPDATE feedback SET is_published = 1, published_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`, ids);
    });
    await writeManifest(manifest);
    return manifest.records;
  } catch (error) {
    if (manifest.records.length) {
      try { await deleteRecords(manifest); }
      catch (cleanupError) {
        if (!(await exists(manifestPath))) await writeManifest(manifest);
        throw new Error(`${error.message} Cleanup refused or failed: ${cleanupError.message} Recorded IDs were preserved in the preview manifest.`);
      }
    }
    throw error;
  }
}

async function removePreview(ownerId) {
  const manifest = checkedManifest(JSON.parse(await fs.readFile(manifestPath, 'utf8')));
  if (ownerId !== null && ownerId !== manifest.ownerId) throw new Error('The requested owner does not match the preview manifest.');
  await deleteRecords(manifest);
  await fs.unlink(manifestPath);
  return manifest.records;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('node scripts/preview-community.js create [--owner <student-id>]\nnode scripts/preview-community.js remove [--owner <student-id>]');
    return;
  }
  if (process.env.NODE_ENV === 'production' || !['127.0.0.1', 'localhost', '::1'].includes(process.env.DB_HOST || '127.0.0.1')) {
    throw new Error('Community previews are restricted to a local development database.');
  }
  if (!/^cspc_[a-z0-9_]+$/.test(process.env.DB_NAME || 'cspc_feedback_db')) throw new Error('A local CSPC database is required.');
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  const lock = await fs.open(lockPath, 'wx');
  try {
    const records = options.action === 'remove' ? await removePreview(options.ownerId) : await createPreview(options.ownerId);
    console.log(JSON.stringify(records));
  } finally {
    await lock.close();
    await fs.unlink(lockPath);
  }
}

if (require.main === module) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
}

module.exports = { parseArgs, checkedManifest, previews };
