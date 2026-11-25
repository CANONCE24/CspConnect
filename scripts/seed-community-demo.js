'use strict';

// Explicitly invoked presentation data. Never runs during application startup.
require('dotenv').config({ quiet: true });
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pool } = require('../src/config/db');

const manifestPath = path.resolve(__dirname, '../docs/qa/community-demo-records.json');
const names = ['Mika Reyes', 'Adrian Santos', 'Bea Mendoza', 'Carlo Rivera',
  'Janelle Cruz', 'Paolo Garcia', 'Rina Flores', 'Luis Navarro', 'Community Moderator'];
const discussions = [
  {
    owner: 0, category: 'Academic Services', type: 'Suggestion', age: 118,
    title: 'A quiet study zone and a separate space for group work',
    description: 'Could we try designating one study area for quiet individual work and another for group discussions? Both are useful, especially between classes. A small two-week trial with clear signs would help us see whether the arrangement works before requesting more space. What hours would be most useful, and how could we keep the setup fair for everyone?',
    statuses: ['Under Review'], support: [0, 1, 2, 3, 4, 5, 6, 7], against: [],
    comments: [
      [2, 'A quiet section would help during my long break before afternoon classes. Please keep a few seats available for walk-ins instead of making everything reservation-only.'],
      [1, 'Good point. Group work still needs a place too. Could the discussion area be near the entrance, with the quieter desks farther inside?'],
      [0, 'That sounds more practical than asking everyone to stay silent everywhere. Maybe signs at the entrance could show which section is for which activity.'],
      [6, 'Can we include accessible seating in both sections? Students should not have to choose between an accessible desk and the kind of study space they need.'],
      [4, 'For the trial, we could collect short feedback at the end of each week: noise level, available seats, and whether groups could still work comfortably.'],
      [0, 'Agreed. The proposal should include walk-in seating, accessible desks, and a weekly feedback check. That gives us something concrete to evaluate.']
    ],
    response: 'Demo review: the proposal has been moved to Under Review. The next step in this sample workflow is to compare available spaces, accessibility needs, and a two-week trial schedule. No campus arrangement is being announced.'
  },
  {
    owner: 1, category: 'Technology and Connectivity', type: 'Concern', age: 96,
    title: 'Could campus Wi-Fi have clearer login and connection guidance?',
    description: 'When a connection fails, it is difficult to tell whether the problem is the login page, the device, or the signal. Could we have a short connection guide and a simple way to report the location and time of a failed attempt? That would make reports more useful than just saying that the internet is slow. Please share useful troubleshooting steps without posting passwords or account details.',
    statuses: ['Under Review', 'In Progress'], support: [0, 1, 2, 4, 5, 6, 7], against: [],
    comments: [
      [5, 'A QR code near common study areas could link to the guide. It should also have a short printed address because the QR code is not useful if you cannot get online.'],
      [3, 'The report form could ask for the building, approximate time, and whether the login page opened. Those details would help identify patterns.'],
      [1, 'Yes, and it should distinguish no signal from connected but no internet. Those look similar to students but may have different causes.'],
      [6, 'Please include steps for both phones and laptops. A few screenshots would be easier to follow than a long technical explanation.'],
      [2, 'Could the guide also say what information not to share? A screenshot can accidentally include an email address or a saved password prompt.'],
      [1, 'I have added that to the idea: short device-specific steps, a location-and-time report, and a reminder to remove personal information from screenshots.']
    ],
    response: 'Demo progress update: a draft connection guide and a location-and-time reporting checklist are being evaluated in this scenario. The sample remains In Progress so the presentation can show a follow-up stage without claiming that a real network change occurred.'
  },
  {
    owner: 2, category: 'Student Services', type: 'Suggestion', age: 72,
    title: 'Show document requirements before students join a service queue',
    description: 'Could common student services have a one-page checklist of requirements, estimated processing steps, and where to ask questions? Students could check what they need before traveling or lining up. An online queue might help later, but a clear checklist seems like a smaller first step. How could we make the information easy to maintain and still available to students without mobile data?',
    statuses: ['Under Review'], support: [0, 1, 2, 3, 6, 7], against: [5],
    comments: [
      [5, 'I am less convinced about an online queue because students without data might lose their place. A printed checklist and a normal walk-in option would be more inclusive.'],
      [2, 'That is fair. The main request is the requirements checklist. Any future queue system should keep walk-ins and should not require a smartphone.'],
      [7, 'Please add a last-updated date and the responsible office to each checklist. Otherwise old copies may continue circulating.'],
      [4, 'Could it show separate lists for a first request and a follow-up? The documents needed may be different, and that is where a lot of confusion starts.'],
      [3, 'A printable version at the entrance would be useful. If something changes, the printed and online versions should be updated together.']
    ]
  },
  {
    owner: 3, category: 'Safety and Accessibility', type: 'Concern', age: 48,
    title: 'A simple way to report walkway lighting and access concerns',
    description: 'Could the feedback form offer a way to describe the exact walkway segment involved in a lighting or access concern? A nearby landmark, the time, and whether the path is difficult to use would make it easier to assess. I suggest starting with a location checklist rather than asking students to post photos of other people. What details would be useful without making a report difficult to submit?',
    statuses: [], support: [0, 2, 3, 4, 6], against: [],
    comments: [
      [6, 'Please include blocked ramps and uneven surfaces as optional items. Lighting matters, but access can be difficult even when the area is well lit.'],
      [0, 'A nearby landmark plus a brief description should be enough to start. Requiring an exact map pin could stop someone from submitting a useful report.'],
      [3, 'Agreed. Location description should be required, while a map pin or photo can stay optional. We should avoid uploading identifiable people.'],
      [7, 'It would also help to explain that urgent hazards should go directly to the appropriate campus contact. A discussion thread may not be seen immediately.']
    ]
  },
  {
    owner: 4, category: 'Campus Facilities', type: 'Complaint', age: 30,
    title: 'Waste segregation labels should show examples, not just colors',
    description: 'In this sample scenario, students are unsure which bin to use for a food-stained paper container, a plastic cup, or leftover food. Could bin labels include simple examples and match the collection arrangement? Adding more bins alone may not help if the labels remain unclear. I would like to discuss a small trial in one busy area before proposing a campus-wide change.',
    statuses: [], support: [0, 1, 2, 4], against: [3, 7],
    comments: [
      [3, 'I would not support buying extra bins yet. If the collection process mixes everything later, new labels alone will not solve the problem.'],
      [4, 'I agree that collection needs to match. The trial could start by checking the current process, then improving the labels on existing bins.'],
      [2, 'Pictures would help, but the examples need to match what the collector accepts. A generic recycling symbol may be misleading.'],
      [7, 'Can the trial include a quick check after lunch? That would show whether the labels are helping at a busy time instead of only when the bins are empty.'],
      [4, 'Good suggestion. A small before-and-after check, agreed categories, and clear examples would give us a useful basis for deciding what to change.']
    ]
  },
  {
    owner: 6, category: 'Academic Services', type: 'Appreciation', age: 12,
    title: 'Short research guides make it easier to get started',
    description: 'A clear starting guide can make a research assignment feel much more manageable. This discussion appreciates the idea of short, practical guidance on finding sources, checking credibility, and keeping citation notes. Could we build on that with a beginner-friendly checklist and examples from different courses? What would have helped you most when starting your first research paper?',
    statuses: ['Under Review', 'Resolved'], support: [0, 1, 2, 3, 4, 5, 6], against: [],
    comments: [
      [0, 'A comparison between a topic and a research question would have helped me. It is easy to pick something interesting that is still too broad to investigate.'],
      [5, 'I would add an example of keeping source notes as you read. Rebuilding a reference list at the end takes much longer.'],
      [6, 'Those could be separate one-page guides so the first checklist stays short. Students could use the extra examples when they need them.'],
      [1, 'Please include accessible text versions alongside any posters. That makes the guide easier to read on a phone and with assistive tools.']
    ],
    response: 'Demo resolution: this sample appreciation has been acknowledged and its suggestions recorded for the presentation scenario. Resolved here illustrates closing the feedback loop; it does not announce an actual guide or service.'
  }
];

async function main() {
  if (process.env.NODE_ENV === 'production' || !['127.0.0.1', 'localhost', '::1'].includes(process.env.DB_HOST || '127.0.0.1') ||
      !/^cspc_[a-z0-9_]+$/.test(process.env.DB_NAME || '')) throw new Error('Only a local CSPC development database is supported.');
  try { await fs.access(manifestPath); throw new Error('Demo manifest already exists; refusing to duplicate the demo.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const post of discussions) {
    assert(post.title.length <= 150);
    for (const [person, body] of post.comments) { assert(person < 8); assert(body.length <= 500); }
    assert.equal(new Set([...post.support, ...post.against]).size, post.support.length + post.against.length);
  }
  const connection = await pool.getConnection();
  const manifest = { purpose: 'Fictional presentation discussions and interactions; all new profiles are labeled Demo.',
    database: process.env.DB_NAME, users: [], posts: [], createdAt: new Date().toISOString() };
  let staged = false;
  let committed = false;
  try {
    await connection.query("SET time_zone = '+00:00'");
    await connection.beginTransaction();
    const [existing] = await connection.query("SELECT id FROM users WHERE email LIKE '%@community-demo.invalid' LIMIT 1");
    if (existing.length) throw new Error('Demo profiles already exist; no data was added.');
    const [categories] = await connection.query('SELECT id, name FROM categories WHERE active = 1');
    const [[clock]] = await connection.query('SELECT UTC_TIMESTAMP() AS now');
    const now = new Date(clock.now).getTime();
    const at = hours => new Date(now - hours * 3600000);
    const year = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Manila', year: 'numeric' }).format(new Date());
    for (const [index, name] of names.entries()) {
      const email = name.toLowerCase().replaceAll(' ', '.') + '@community-demo.invalid';
      const [result] = await connection.execute(`INSERT INTO users (name, email, role, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)`, [name + ' (Demo)', email, index === 8 ? 'admin' : 'student', at(144), at(144)]);
      manifest.users.push({ id: result.insertId, name: name + ' (Demo)', email });
    }
    const adminId = manifest.users[8].id;
    for (const post of discussions) {
      const category = categories.find(item => item.name === post.category);
      if (!category) throw new Error('Missing category: ' + post.category);
      const ownerId = manifest.users[post.owner].id;
      const status = post.statuses.at(-1) || 'Submitted';
      const changedAt = at(post.age - 1 - post.statuses.length);
      const [result] = await connection.execute(`INSERT INTO feedback
        (user_id, category_id, type, title, description, status, is_published, published_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      [ownerId, category.id, post.type, post.title, post.description, status, at(post.age - 0.5), at(post.age), changedAt]);
      const id = result.insertId;
      const reference = `FB-${year}-${String(id).padStart(5, '0')}`;
      await connection.execute('UPDATE feedback SET reference = ? WHERE id = ?', [reference, id]);
      await connection.execute(`INSERT INTO feedback_status_history
        (feedback_id, previous_status, status, changed_by, created_at) VALUES (?, NULL, 'Submitted', ?, ?)`, [id, ownerId, at(post.age)]);
      let previous = 'Submitted';
      for (const [index, next] of post.statuses.entries()) {
        await connection.execute(`INSERT INTO feedback_status_history
          (feedback_id, previous_status, status, changed_by, created_at) VALUES (?, ?, ?, ?, ?)`,
        [id, previous, next, adminId, at(post.age - 1 - index)]);
        previous = next;
      }
      for (const [index, [person, body]] of post.comments.entries()) {
        const timestamp = at(post.age - 2 - index * 0.75);
        await connection.execute(`INSERT INTO feedback_comments
          (feedback_id, user_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
        [id, manifest.users[person].id, body, timestamp, timestamp]);
      }
      for (const [kind, people] of [['support', post.support], ['not_helpful', post.against]]) {
        for (const [index, person] of people.entries()) {
          const timestamp = at(post.age - 1 - index * 0.4);
          await connection.execute(`INSERT INTO feedback_reactions
            (feedback_id, user_id, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
          [id, manifest.users[person].id, kind, timestamp, timestamp]);
        }
      }
      if (post.response) await connection.execute(`INSERT INTO feedback_responses
        (feedback_id, admin_id, body, created_at) VALUES (?, ?, ?, ?)`, [id, adminId, post.response, changedAt]);
      manifest.posts.push({ id, reference, title: post.title, status, support: post.support.length,
        notHelpful: post.against.length, comments: post.comments.length });
    }
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    staged = true;
    await connection.commit();
    committed = true;
    console.log(JSON.stringify(manifest, null, 2));
  } catch (error) {
    if (!committed) {
      await connection.rollback();
      if (staged) await fs.unlink(manifestPath);
    }
    throw error;
  } finally { connection.release(); }
}

if (require.main === module) main().catch(error => {
  console.error(error.message); process.exitCode = 1;
}).finally(() => pool.end());
