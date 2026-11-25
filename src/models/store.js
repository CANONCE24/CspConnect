'use strict';

const { pool } = require('../config/db');
const { queueNotification, createNotificationStore } = require('./notifications');

const TYPES = ['Suggestion', 'Complaint', 'Concern', 'General Feedback', 'Appreciation'];
const STATUSES = ['Submitted', 'Under Review', 'In Progress', 'Resolved', 'Closed'];
const REACTIONS = ['support', 'not_helpful', 'remove'];

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  error.statusCode = status;
  throw error;
}

function idValue(value) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) fail('Invalid record identifier.');
  return result;
}

function textValue(value, min, max, label) {
  if (typeof value !== 'string') fail(`${label} is required.`);
  const result = value.trim();
  const length = [...result].length;
  if (length < min || length > max) fail(`${label} must contain ${min} to ${max} characters.`);
  return result;
}

function pageValues(page, limit) {
  const p = Number(page);
  const l = Number(limit);
  return {
    page: Number.isSafeInteger(p) && p > 0 ? p : 1,
    limit: Number.isSafeInteger(l) && l > 0 ? Math.min(l, 50) : 12
  };
}

function pagination(items, total, page, limit) {
  return { items, total: Number(total), page, pages: Math.max(1, Math.ceil(Number(total) / limit)) };
}

async function transaction(action) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await action(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function requireAdmin(connection, adminId) {
  const [rows] = await connection.execute('SELECT id FROM users WHERE id = ? AND role = ?', [idValue(adminId), 'admin']);
  if (!rows.length) fail('Administrator access is required.', 403);
}

async function requireStudent(connection, userId) {
  const [rows] = await connection.execute('SELECT id FROM users WHERE id = ? AND role = ?', [idValue(userId), 'student']);
  if (!rows.length) fail('Student access is required.', 403);
}

async function lockedFeedback(connection, id, publicOnly = false) {
  const [rows] = await connection.execute('SELECT id, status, is_published FROM feedback WHERE id = ? FOR UPDATE', [idValue(id)]);
  if (!rows.length || (publicOnly && !rows[0].is_published)) fail('Feedback was not found.', 404);
  return rows[0];
}

async function upsertGoogleUser(profile, adminEmails = [], securityEmails = []) {
  const googleId = textValue(String(profile.id || ''), 1, 191, 'Google account ID');
  const email = textValue(profile.emails?.[0]?.value || profile.email || '', 3, 254, 'Email address').toLowerCase();
  const name = textValue(profile.displayName || profile.name || email.split('@')[0], 1, 200, 'Account name');
  const avatar = profile.photos?.[0]?.value || profile.avatar_url || null;
  const avatarUrl = typeof avatar === 'string' && /^https:\/\//i.test(avatar) ? avatar.slice(0, 2048) : null;
  const allowlist = Array.isArray(adminEmails) ? adminEmails : String(adminEmails).split(',');
  let role = 'student';
  return transaction(async connection => {
    const [byGoogleId] = await connection.execute('SELECT id, google_id, role, email, email_verified_at FROM users WHERE google_id = ? FOR UPDATE', [googleId]);
    const [byEmail] = byGoogleId.length ? [byGoogleId] : await connection.execute('SELECT id, google_id, role, email_verified_at FROM users WHERE email = ? FOR UPDATE', [email]);
    if(!byGoogleId.length && byEmail.length){
      if(byEmail[0].google_id && byEmail[0].google_id!==googleId)fail('This email belongs to another linked Google identity.',409);
      return {requiresLink:true,accountId:byEmail[0].id,googleId,email};
    }
    let id;
    if (byEmail.length) {
      if (byEmail[0].role === 'admin' && allowlist.some(item => String(item).trim().toLowerCase() === email)) role = 'admin';
      if (role !== 'admin' && byEmail[0].role === 'security' && securityEmails.includes(email)) role = 'security';
      id = byEmail[0].id;
      if (byEmail[0].email?.toLowerCase() !== email) {
        // A newly verified address invalidates old recovery proofs and affiliation.
        await connection.execute('UPDATE users SET affiliation=NULL,affiliation_email=NULL,password_verified_at=NULL,legacy_active=0,email_verified_at=CURRENT_TIMESTAMP(3),session_version=session_version+1 WHERE id=?',[id]);
        await connection.execute('UPDATE account_action_tokens SET used_at=CURRENT_TIMESTAMP(3) WHERE user_id=? AND used_at IS NULL',[id]);
        await connection.execute('UPDATE email_verifications SET consumed_at=CURRENT_TIMESTAMP(3) WHERE email=? AND consumed_at IS NULL',[byEmail[0].email]);
      }
      if (byEmail[0].google_id && byEmail[0].google_id !== googleId) fail('This email is already linked to another Google account.', 409);
      // Preserve the account name and any photo selected in My account on subsequent Google logins.
      await connection.execute(`UPDATE users SET google_id = ?, email = ?,
        name=CASE WHEN email_verified_at IS NULL THEN ? ELSE name END,
        avatar_url = CASE WHEN email_verified_at IS NOT NULL AND avatar_url LIKE '/avatars/%' THEN avatar_url ELSE ? END, role = ?,
        email_verified_at=COALESCE(email_verified_at,CURRENT_TIMESTAMP(3)) WHERE id = ?`,
      [googleId, email, name,avatarUrl, role, id]);
      if (!byEmail[0].email_verified_at) await connection.execute('UPDATE account_action_tokens SET used_at=CURRENT_TIMESTAMP(3) WHERE user_id=? AND used_at IS NULL',[id]);
    } else {
      const [result] = await connection.execute('INSERT INTO users (google_id, name, email, avatar_url, role,email_verified_at) VALUES (?, ?, ?, ?, ?,CURRENT_TIMESTAMP(3))', [googleId, name, email, avatarUrl, role]);
      id = result.insertId;
    }
    const [rows] = await connection.execute('SELECT id, google_id, name, email, avatar_url, role, must_change_password, created_at,email_verified_at,password_verified_at,session_version,legacy_active,affiliation,affiliation_email FROM users WHERE id = ?', [id]);
    return rows[0];
  });
}

async function passwordAccountByEmail(email) {
  const normalizedEmail = textValue(email, 3, 254, 'Email address').toLowerCase();
  const [rows] = await pool.execute(`SELECT id, google_id, name, email, avatar_url, role, must_change_password,
    password_hash,email_verified_at,password_verified_at,session_version,legacy_active,affiliation,affiliation_email FROM users WHERE email = ? LIMIT 1`, [normalizedEmail]);
  return rows[0] || null;
}

async function linkGoogleAccount({accountId,googleId,email,expectedPasswordHash,adminEmails=[],securityEmails=[]}) {
  return transaction(async connection=>{
    const [[account]]=await connection.execute('SELECT id,email,role,google_id,password_hash FROM users WHERE id=? FOR UPDATE',[idValue(accountId)]);
    if(!account || account.email.toLowerCase()!==email || !account.password_hash || account.password_hash!==expectedPasswordHash)fail('Your account changed. Start Google sign-in again.',409);
    if(account.google_id && account.google_id!==googleId)fail('This account is already linked to another Google identity.',409);
    const [other]=await connection.execute('SELECT id FROM users WHERE google_id=? AND id<>? FOR UPDATE',[googleId,accountId]);
    if(other.length)fail('This Google identity already belongs to another account.',409);
    const role=account.role==='admin'&&adminEmails.includes(email)?'admin':account.role==='security'&&securityEmails.includes(email)?'security':'student';
    await connection.execute('UPDATE users SET google_id=?,role=?,email_verified_at=CURRENT_TIMESTAMP(3),password_verified_at=CURRENT_TIMESTAMP(3),session_version=session_version+1 WHERE id=?',[googleId,role,accountId]);
    await connection.execute('UPDATE account_action_tokens SET used_at=CURRENT_TIMESTAMP(3) WHERE user_id=? AND used_at IS NULL',[accountId]);
    await connection.execute('UPDATE email_verifications SET consumed_at=CURRENT_TIMESTAMP(3) WHERE email=? AND consumed_at IS NULL',[email]);
    const [[user]]=await connection.execute('SELECT id,google_id,name,email,avatar_url,role,must_change_password,email_verified_at,password_verified_at,session_version,affiliation,affiliation_email FROM users WHERE id=?',[accountId]);
    return user;
  });
}

async function createPasswordAccount({ name, email, passwordHash }) {
  const displayName = textValue(name, 1, 200, 'Name');
  const normalizedEmail = textValue(email, 3, 254, 'Email address').toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) fail('Enter a valid email address.');
  if (!require('../services/passwords').isPasswordHash(passwordHash)) fail('Invalid password configuration.');
  try {
    const [result] = await pool.execute(`INSERT INTO users (google_id, name, email, password_hash, role)
      VALUES (NULL, ?, ?, ?, 'student')`, [displayName, normalizedEmail, passwordHash]);
    const [rows] = await pool.execute(`SELECT id, google_id, name, email, avatar_url, role, must_change_password, created_at
      FROM users WHERE id = ?`, [result.insertId]);
    return rows[0];
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') fail('An account may already exist for this email. Try signing in or use Google.', 409);
    throw error;
  }
}

async function changePassword(userId, passwordHash,{expectedVersion}={}) {
  if (!require('../services/passwords').isPasswordHash(passwordHash)) fail('Invalid password configuration.');
  return transaction(async connection=>{
    const conditional=expectedVersion!==undefined;
    const [result] = await connection.execute('UPDATE users SET password_hash = ?, must_change_password = 0,password_verified_at=CURRENT_TIMESTAMP(3),session_version=session_version+1 WHERE id = ?'+(conditional?' AND session_version=?':''), [passwordHash, idValue(userId),...(conditional?[expectedVersion]:[])]);
    if (!result.affectedRows) fail(conditional?'Your account changed during this request. Sign in again.':'Account was not found.',conditional?409:404);
    await connection.execute('UPDATE account_action_tokens SET used_at=CURRENT_TIMESTAMP(3) WHERE user_id=? AND used_at IS NULL',[idValue(userId)]);
  });
}

async function syncAccountRole(userId, role) {
  if (!['student', 'admin', 'security'].includes(role)) fail('Invalid account role.');
  const [result] = await pool.execute('UPDATE users SET role = ? WHERE id = ?', [role, idValue(userId)]);
  if (!result.affectedRows) fail('Account was not found.', 404);
}

async function getUser(id) {
  const [rows] = await pool.execute(`SELECT id, google_id, name, email, avatar_url, role, must_change_password,
    (password_hash IS NOT NULL) AS has_password, created_at,email_verified_at,password_verified_at,session_version,legacy_active,affiliation,affiliation_email FROM users WHERE id = ?`, [idValue(id)]);
  return rows[0] || null;
}

async function updateProfile(userId, { name, avatarUrl }) {
  const displayName = textValue(name, 1, 200, 'Full name');
  if (avatarUrl !== undefined && avatarUrl !== null &&
      (typeof avatarUrl !== 'string' || !/^\/avatars\/[a-f0-9-]+\.webp$/.test(avatarUrl))) fail('Invalid profile photo.');
  const fields = avatarUrl === undefined ? 'name = ?' : 'name = ?, avatar_url = ?';
  const values = avatarUrl === undefined ? [displayName, idValue(userId)] : [displayName, avatarUrl, idValue(userId)];
  const [result] = await pool.execute(`UPDATE users SET ${fields} WHERE id = ?`, values);
  if (!result.affectedRows) fail('Account was not found.', 404);
}

async function profilePhotoExists(filename) {
  const [rows] = await pool.execute('SELECT id FROM users WHERE avatar_url = ? LIMIT 1', ['/avatars/' + filename]);
  return rows.length > 0;
}

async function categories(includeInactive = false) {
  const [rows] = await pool.execute(`SELECT id, name, active FROM categories ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY name`);
  return rows;
}

async function categorySave({ id, name, active }) {
  const label = textValue(name, 2, 80, 'Category name');
  const enabled = active === true || active === 1 || active === '1' || active === 'on' ? 1 : 0;
  try {
    if (id) {
      const [result] = await pool.execute('UPDATE categories SET name = ?, active = ? WHERE id = ?', [label, enabled, idValue(id)]);
      if (!result.affectedRows) fail('Category was not found.', 404);
      return { id: Number(id) };
    }
    const [result] = await pool.execute('INSERT INTO categories (name, active) VALUES (?, ?)', [label, enabled]);
    return { id: result.insertId };
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') fail('A category with this name already exists.');
    throw error;
  }
}

async function stats(userId = null) {
  const where = userId === null ? '' : 'WHERE user_id = ?';
  const params = userId === null ? [] : [idValue(userId)];
  const [rows] = await pool.execute(`SELECT COUNT(*) AS total,
    COALESCE(SUM(status = 'Submitted'), 0) AS submitted,
    COALESCE(SUM(status = 'Under Review'), 0) AS underReview,
    COALESCE(SUM(status = 'In Progress'), 0) AS inProgress,
    COALESCE(SUM(status = 'Resolved'), 0) AS resolved,
    COALESCE(SUM(status = 'Closed'), 0) AS closed,
    COALESCE(SUM(is_published = 1), 0) AS published FROM feedback ${where}`, params);
  const [hidden] = await pool.execute(`SELECT COUNT(*) AS count FROM feedback_comments c
    INNER JOIN feedback f ON f.id = c.feedback_id WHERE c.is_hidden = 1${userId === null ? '' : ' AND f.user_id = ?'}`, params);
  return Object.fromEntries(Object.entries({ ...rows[0], hiddenComments: hidden[0].count }).map(([key, value]) => [key, Number(value)]));
}

async function analytics() {
  const [totals, [types], [categoryCounts], [affiliationCounts]] = await Promise.all([
    stats(),
    pool.execute('SELECT type AS name, COUNT(*) AS count FROM feedback GROUP BY type ORDER BY count DESC, type ASC'),
    pool.execute(`SELECT c.name, COUNT(*) AS count FROM feedback f
      INNER JOIN categories c ON c.id = f.category_id GROUP BY c.id, c.name ORDER BY count DESC, c.name ASC`),
    pool.execute(`SELECT COALESCE(u.affiliation,'Not set') AS name,COUNT(*) AS count FROM feedback f
      INNER JOIN users u ON u.id=f.user_id GROUP BY u.affiliation ORDER BY count DESC,name ASC`)
  ]);
  return {
    ...totals,
    byType: types.map(row => ({ name: row.name, count: Number(row.count) })),
    byCategory: categoryCounts.map(row => ({ name: row.name, count: Number(row.count) })),
    byAffiliation: affiliationCounts.map(row => ({ name: row.name, count: Number(row.count) }))
  };
}

const COUNTS = `(SELECT COUNT(*) FROM feedback_reactions r WHERE r.feedback_id = f.id AND r.kind = 'support') AS support_count,
  (SELECT COUNT(*) FROM feedback_reactions r WHERE r.feedback_id = f.id AND r.kind = 'not_helpful') AS not_helpful_count,
  (SELECT COUNT(*) FROM feedback_comments cm WHERE cm.feedback_id = f.id AND cm.is_hidden = 0) AS comment_count`;

function feedbackDto(row, publicOnly) {
  const attachmentUrl = row.attachment_path ? `/attachments/${row.id}` : null;
  if (!publicOnly) return { ...row, attachment_url: attachmentUrl };
  // An explicit allowlist prevents future private columns from leaking into community views.
  return {
    id: row.id,
    reference: row.reference,
    type: row.type,
    category_name: row.category_name,
    title: row.title,
    description: row.description,
    is_anonymous: Boolean(row.is_anonymous),
    author_name: row.is_anonymous ? 'Anonymous' : row.author_name,
    status: row.status,
    is_published: Boolean(row.is_published),
    published_at: row.published_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    attachment_url: attachmentUrl,
    support_count: Number(row.support_count),
    not_helpful_count: Number(row.not_helpful_count),
    comment_count: Number(row.comment_count),
    current_reaction: row.current_reaction || null
  };
}

async function listFeedback({ userId = null, viewerId = null, publicOnly = false, visibility = '', type = '', status = '', categoryId = '', affiliation = '', search = '', sort = '', page = 1, limit = 12 } = {}) {
  ({ page, limit } = pageValues(page, limit));
  if (sort && !['trending', 'most_supported', 'newest'].includes(sort)) fail('Invalid feedback sorting.');
  const conditions = [];
  const params = [];
  if (affiliation) {
    if (publicOnly || !require('../services/affiliation').AFFILIATIONS.includes(affiliation)) fail('Invalid affiliation filter.');
    conditions.push('EXISTS (SELECT 1 FROM users au WHERE au.id=f.user_id AND au.affiliation=?)'); params.push(affiliation);
  }
  if (userId !== null) { conditions.push('f.user_id = ?'); params.push(idValue(userId)); }
  if (publicOnly) conditions.push('f.is_published = 1');
  if (visibility) {
    if (!['private', 'published'].includes(visibility)) fail('Invalid feedback visibility.');
    conditions.push('f.is_published = ?'); params.push(visibility === 'published' ? 1 : 0);
  }
  if (type) {
    if (!TYPES.includes(type)) fail('Invalid feedback type.');
    conditions.push('f.type = ?'); params.push(type);
  }
  if (status) {
    if (!STATUSES.includes(status)) fail('Invalid feedback status.');
    conditions.push('f.status = ?'); params.push(status);
  }
  if (categoryId) { conditions.push('f.category_id = ?'); params.push(idValue(categoryId)); }
  if (search) {
    const term = textValue(search, 1, 150, 'Search');
    // Parameter binding prevents injection; escape LIKE wildcards to search literal text.
    const pattern = `%${term.replace(/[!%_]/g, match => `!${match}`)}%`;
    conditions.push("(f.title LIKE ? ESCAPE '!' OR f.description LIKE ? ESCAPE '!' OR f.reference LIKE ? ESCAPE '!')");
    params.push(pattern, pattern, pattern);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const [count] = await pool.execute(`SELECT COUNT(*) AS total FROM feedback f ${where}`, params);
  const total = Number(count[0].total);
  page = Math.min(page, Math.max(1, Math.ceil(total / limit)));
  const orders = {
    trending: 'trending_support_count DESC, f.created_at DESC, f.id DESC',
    most_supported: 'support_count DESC, f.created_at DESC, f.id DESC',
    newest: 'f.created_at DESC, f.id DESC'
  };
  const order = orders[sort] || (publicOnly ? 'f.published_at DESC, f.id DESC' : orders.newest);
  // updated_at records when the current reaction became active, including switches to Support.
  const trending = sort === 'trending' ? `, (SELECT COUNT(*) FROM feedback_reactions tr
    WHERE tr.feedback_id = f.id AND tr.kind = 'support'
    AND tr.updated_at >= CURRENT_TIMESTAMP - INTERVAL 7 DAY AND tr.updated_at <= CURRENT_TIMESTAMP) AS trending_support_count` : '';
  const viewer = publicOnly && viewerId !== null;
  const selection = viewer ? ', (SELECT vr.kind FROM feedback_reactions vr WHERE vr.feedback_id = f.id AND vr.user_id = ?) AS current_reaction' : '';
  const [rows] = await pool.execute(`SELECT f.*, c.name AS category_name, u.name AS author_name, u.email AS author_email, u.affiliation AS author_affiliation, ${COUNTS}${trending}${selection}
    FROM feedback f INNER JOIN categories c ON c.id = f.category_id INNER JOIN users u ON u.id = f.user_id
    ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, [...(viewer ? [idValue(viewerId)] : []), ...params, limit, (page - 1) * limit]);
  return pagination(rows.map(row => feedbackDto(row, publicOnly)), total, page, limit);
}

async function detail(id, { userId = null, admin = false, publicOnly = false } = {}) {
  const conditions = ['f.id = ?'];
  const params = [idValue(id)];
  if (publicOnly) conditions.push('f.is_published = 1');
  else if (!admin) {
    if (userId === null) return null;
    conditions.push('f.user_id = ?'); params.push(idValue(userId));
  }
  const [rows] = await pool.execute(`SELECT f.*, c.name AS category_name, u.name AS author_name, u.email AS author_email, u.affiliation AS author_affiliation, ${COUNTS}
    FROM feedback f INNER JOIN categories c ON c.id = f.category_id INNER JOIN users u ON u.id = f.user_id
    WHERE ${conditions.join(' AND ')}`, params);
  if (!rows.length) return null;
  const result = feedbackDto(rows[0], publicOnly);
  if (publicOnly) return { ...result, history: [], responses: [] };
  const [[history], [responses]] = await Promise.all([
    pool.execute(`SELECT h.id, h.previous_status, h.previous_status AS from_status, h.status, h.status AS to_status,
      h.created_at, h.resolution_summary, h.additional_message, h.rejection_reason, u.name AS author_name, u.name AS actor_name, u.name AS admin_name
      FROM feedback_status_history h INNER JOIN users u ON u.id = h.changed_by
      WHERE h.feedback_id = ? ORDER BY h.created_at ASC, h.id ASC`, [Number(id)]),
    pool.execute(`SELECT r.id, r.body, r.created_at, u.name AS author_name, u.name AS admin_name
      FROM feedback_responses r INNER JOIN users u ON u.id = r.admin_id
      WHERE r.feedback_id = ? ORDER BY r.created_at ASC, r.id ASC`, [Number(id)])
  ]);
  return { ...result, history, responses };
}

async function submit(userId, { type, categoryId, title, description, isAnonymous = false, attachmentPath = null, attachmentMime = null }) {
  if (!TYPES.includes(type)) fail('Choose a valid feedback type.');
  const heading = textValue(title, 5, 150, 'Title');
  const body = textValue(description, 10, 10000, 'Description');
  const owner = idValue(userId);
  const category = idValue(categoryId);
  if (attachmentPath !== null && (typeof attachmentPath !== 'string' || !/^[a-zA-Z0-9_-]+\.(?:jpg|jpeg|png|webp)$/.test(attachmentPath))) fail('Invalid image attachment.');
  if (attachmentPath !== null && !['image/jpeg', 'image/png', 'image/webp'].includes(attachmentMime)) fail('Invalid image attachment type.');
  return transaction(async connection => {
    await requireStudent(connection, owner);
    const [available] = await connection.execute('SELECT id FROM categories WHERE id = ? AND active = 1 LOCK IN SHARE MODE', [category]);
    if (!available.length) fail('Choose an active category.');
    const anonymous = isAnonymous === true || isAnonymous === 1 || isAnonymous === '1' || isAnonymous === 'on' ? 1 : 0;
    const [result] = await connection.execute(`INSERT INTO feedback
      (user_id, category_id, type, title, description, is_anonymous, attachment_path, attachment_mime)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [owner, category, type, heading, body, anonymous, attachmentPath, attachmentPath ? attachmentMime : null]);
    const year = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Manila', year: 'numeric' }).format(new Date());
    const reference = `FB-${year}-${String(result.insertId).padStart(5, '0')}`;
    await connection.execute('UPDATE feedback SET reference = ? WHERE id = ?', [reference, result.insertId]);
    await connection.execute('INSERT INTO feedback_status_history (feedback_id, previous_status, status, changed_by) VALUES (?, NULL, ?, ?)', [result.insertId, 'Submitted', owner]);
    return { id: result.insertId, reference };
  });
}

async function updateStatus(id, status, adminId, options = {}) {
  return require('../services/feedback-status').changeFeedbackStatus(pool, id, status, adminId, options);
}

async function addResponse(id, adminId, body) {
  const text = textValue(body, 1, 5000, 'Response');
  return transaction(async connection => {
    await requireAdmin(connection, adminId);
    await lockedFeedback(connection, id);
    const [result] = await connection.execute('INSERT INTO feedback_responses (feedback_id, admin_id, body) VALUES (?, ?, ?)', [idValue(id), idValue(adminId), text]);
    await queueNotification(connection, idValue(id), { kind: 'AdminResponse', message: 'An administrator added a response to your submission.', eventKey: 'response:' + result.insertId });
    return { id: result.insertId };
  });
}

async function publish(id, published, adminId) {
  if (typeof published !== 'boolean') fail('Invalid publication setting.');
  return transaction(async connection => {
    await requireAdmin(connection, adminId);
    const feedback = await lockedFeedback(connection, id);
    if (Boolean(feedback.is_published) === published) return { changed: false };
    await connection.execute('UPDATE feedback SET is_published = ?, published_at = IF(? = 1, CURRENT_TIMESTAMP, NULL) WHERE id = ?', [published ? 1 : 0, published ? 1 : 0, idValue(id)]);
    await queueNotification(connection, idValue(id), { kind: published ? 'Published' : 'Unpublished',
      message: published ? 'Your submission is now published in the Community Feed.' : 'Your submission was removed from the Community Feed. You can still track it in My Feedback.' });
    return { changed: true };
  });
}

async function react(id, userId, kind, { withCounts = false } = {}) {
  if (!REACTIONS.includes(kind)) fail('Choose a valid reaction.');
  return transaction(async connection => {
    await requireStudent(connection, userId);
    await lockedFeedback(connection, id, true);
    const owner = idValue(userId);
    const [rows] = await connection.execute('SELECT kind FROM feedback_reactions WHERE feedback_id = ? AND user_id = ? FOR UPDATE', [idValue(id), owner]);
    if (kind === 'remove' || rows[0]?.kind === kind) {
      await connection.execute('DELETE FROM feedback_reactions WHERE feedback_id = ? AND user_id = ?', [idValue(id), owner]);
      kind = null;
    } else {
      await connection.execute('INSERT INTO feedback_reactions (feedback_id, user_id, kind) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE kind = VALUES(kind), updated_at = CURRENT_TIMESTAMP', [idValue(id), owner, kind]);
    }
    if (withCounts) {
      const [counts] = await connection.execute(`SELECT COALESCE(SUM(kind = 'support'), 0) AS support_count,
        COALESCE(SUM(kind = 'not_helpful'), 0) AS not_helpful_count FROM feedback_reactions WHERE feedback_id = ? FOR UPDATE`, [idValue(id)]);
      return { reaction: kind, support_count: Number(counts[0].support_count), not_helpful_count: Number(counts[0].not_helpful_count) };
    }
    return kind;
  });
}

async function reactionFor(id, userId) {
  const [rows] = await pool.execute(`SELECT r.kind FROM feedback_reactions r INNER JOIN feedback f ON f.id = r.feedback_id
    WHERE r.feedback_id = ? AND r.user_id = ? AND f.is_published = 1`, [idValue(id), idValue(userId)]);
  return rows[0]?.kind || null;
}

async function attachmentForPublished(id) {
  const [rows] = await pool.execute('SELECT attachment_path FROM feedback WHERE id = ? AND is_published = 1 AND attachment_path IS NOT NULL', [idValue(id)]);
  return rows[0] || null;
}

module.exports = {
  ...createNotificationStore(pool),
  ...require('./support').createSupportStore(pool),
  supportForConfig: config => require('./support').createSupportStore(pool,config),
  ...require('./affiliation').createAffiliationStore(pool),
  upsertGoogleUser,linkGoogleAccount, passwordAccountByEmail, createPasswordAccount, changePassword, syncAccountRole, getUser, updateProfile, profilePhotoExists,
  categories, categorySave, stats, analytics, listFeedback, detail,
  submit, updateStatus, addResponse, publish, react, reactionFor,
  attachmentForPublished, ...require('./comment-moderation').createCommentModerationStore(pool)
};
