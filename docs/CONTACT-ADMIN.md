# Contact Admin and private support tickets

Implemented October 21, 2026. Contact Admin uses ordinary HTTP forms, the existing authenticated user dashboard, and the existing notification system. It does not add a chat service or dependencies.

## User workflow

The sidebar's **Contact Admin** link opens `/contact`, with New Message and My Conversations tabs. Students, faculty, staff and visitors all use their existing regular account permissions.

New tickets accept the six requested contact reasons, a subject of 3–150 characters, and a message of 1–5,000 characters. The server saves the authenticated owner, a snapshot of their affiliation, a reference such as `ST-2026-00001`, timestamps, the initial message, and history in one transaction. The sender receives a success confirmation and can read their private conversation at `/contact/:id`.

| Status | Meaning |
| --- | --- |
| Open | Submitted or awaiting administrator attention after a user follow-up |
| Pending | An administrator has replied; further action may be needed |
| Closed | The conversation has ended; further replies require an administrator to reopen it |

Replies append to the conversation. They never replace earlier messages. An administrator reply sets Pending; a user reply sets Open. Users can reply to Open and Pending tickets, and can read Closed tickets. Only administrators can explicitly change status or reopen a closed conversation.

## Administration

**Contact Messages** opens `/admin/contact`. Administrators can filter by Open, Pending and Closed, search subject/reference/sender name or email, and page through matching tickets. Ticket details show the sender, their recorded affiliation, timestamps, every message and action history. The administrator dashboard links to the Open queue and displays its count.

Administrator access requires the existing provisioned database role and server email allowlist. Affiliation does not grant administrative permissions.

## Notifications

The existing account-menu dot, unread badge, polling, Notifications page and read actions now serve regular users and administrators. Support events and their notifications commit together:

- New ticket: every currently provisioned and allowlisted administrator.
- Administrator reply: the ticket owner.
- User follow-up: authorized administrators.
- Status change, including closing and reopening: the ticket owner.

Notification previews are generic and include the ticket reference. They omit the subject and message body. Opening a notification marks it read and redirects to the appropriate private conversation; the conversation independently checks ownership or administrator access. Revoked administrators cannot read other users' ticket notifications through regular user access.

Existing feedback notifications retain their content, ordering, read state, pagination and private feedback links. Mark all as read still applies only to the recipient and the newest notification ID included when the page was loaded.

## Alternative email contact

The login page links to the public `/contact-admin` help page. This remains accessible even when a user cannot complete sign-in or profile verification. It shows the administrator email, an Email Administrator button, and a Copy email button. The same alternative contact block appears alongside the internal form and conversation pages.

```text
canoncesam76@gmail.com
mailto:canoncesam76@gmail.com?subject=CSPConnect%20Support%20Inquiry
```

The mailto link opens the browser's configured email application. It does not call the backend, send email automatically, or create a ticket. The copy button uses the Clipboard API, with a manual-copy fallback message. No SMTP credentials are exposed.

Support updates use in-app notifications. The existing SMTP outbox is specific to feedback records and remains unchanged; support ticket email alerts were not added. No real email was sent during testing, and no external email application was launched by browser QA.

## Database migration

The migration was explained before being applied to this workspace:

```powershell
npm.cmd run db:migrate-support
```

It creates three tables if missing:

- `support_tickets`: ownership, affiliation snapshot, reference, category, subject, status, version and timestamps.
- `support_messages`: append-only initial message and replies, sender and sender-role snapshot.
- `support_history`: actor, action, previous/new status, version, request identity and timestamp.

It extends `feedback_notifications` with nullable `support_ticket_id`, permits nullable `feedback_id` for support events, and appends SupportNew, SupportReply and SupportStatus to the event enum. Foreign keys retain valid relationships. Existing feedback notification IDs, values and read timestamps are preserved. It does not update users, credentials, affiliations, existing feedback, comments or reactions. The migration can be rerun after partial completion; fresh installations use the updated `schema.sql`.

Do not use `db:setup` on an existing installation. The server's startup checks now identify missing support tables/columns and direct operators to the migration.

## Security and integrity

- Internal ticket routes require authentication and existing account/profile readiness. Public help contains only the alternative contact information.
- All support model methods validate the current database role and session version. Administrator methods also check the server allowlist. The browser cannot select an owner or affiliation.
- Queries bind supplied values. Search treats `%` and `_` as literal characters. EJS escapes subjects, messages and sender information; user text is never inserted as HTML.
- CSRF protects every write, including notification read actions. New tickets are limited to five per account per ten minutes; replies/status actions share a twenty-update limit per account per ten minutes.
- Ticket writes lock the current ticket. Administrator status changes require the displayed version to prevent stale overwrites. Account locks prevent permission changes midway through a write.
- Server-generated form request keys and unique constraints make duplicate creates/replies/status actions safe. Reusing a key with a different payload is rejected. Locking reads detect completed concurrent requests; bounded transaction retries handle database deadlocks.
- Messages and audit history have no edit/delete routes. Users cannot change ownership or reopen closed tickets. Cross-user detail and reply attempts return 404.

## Files

New implementation: `src/models/support.js`, `src/routes/support.js`, `scripts/support-schema.sql`, `scripts/migrate-support.js`, seven `views/support/*.ejs` templates, and `public/js/support.js`.

Integration: `src/app.js`, `src/models/store.js`, `src/models/notifications.js`, `src/routes/notifications.js`, `src/routes/pages.js`, `src/server.js`, `views/partials/{head,sidebar}.ejs`, `views/admin/dashboard.ejs`, `views/auth/login.ejs`, `views/student/notifications.ejs`, `public/css/app.css`, `schema.sql`, `package.json`, and `README.md`.

Verification: `tests/support-database.test.js` plus the existing notification test updated to allow authorized administrators to open Notifications.

## Verification results

**132 automated tests passed, 0 failures, 0 skips**, with `TEST_DB=1`. Syntax checks and the existing complete student/admin browser workflow also passed. Tests use newly owned temporary databases, which are dropped afterward; normal application records are not used as test fixtures.

The support suite verifies all four affiliations, server-controlled identity, administrator recipients, two-way notifications, close/reopen, complete history, repeatable migration with saved notifications, CSRF, cross-user restrictions, XSS escaping, literal SQL search, filters/counts/pagination, duplicate and concurrent writes, stale status updates, and rate limits. Browser QA exercises the whole support conversation and checks the exact mailto address from the unauthenticated login/help path.

Desktop and 390px mobile screenshots were checked for overflow and visually inspected:

- `docs/qa/contact-admin-desktop.png`, `contact-admin-mobile.png`
- `docs/qa/contact-messages-desktop.png`, `contact-messages-mobile.png`
- `docs/qa/support-conversation-desktop.png`, `support-conversation-mobile.png`

Logs: `.local/support-tests.log`, `.local/support-regression.log`, `.local/support-workflow.log`, `.local/support-browser.log`.
