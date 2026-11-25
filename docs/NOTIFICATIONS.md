# Student notifications

Students can open **Notifications** from the account menu. An unread count appears beside that entry, and a dot appears on the account avatar. The count refreshes every 30 seconds while the page is visible and when the menu opens.

New administrator actions notify the submission's owner. Status updates and responses use the administrator's approved delivery choice: **Web Only**, **Email Only**, or **Both** (default). Only Web Only and Both create an in-app notification; Email Only and Both queue email.

- A status change, including an optional response in the same update.
- An administrator response, including a response added without a status change.
- Publication to, or removal from, the Community Feed.

Notifications are stored in MySQL in the same transaction as the administrator action. Replayed status request keys, identical repeated approved updates, and unchanged publication saves do not create extra notifications. Existing history is not backfilled. Every approved response is saved in My Feedback regardless of delivery choice. See [Automated responses](AUTOMATED-RESPONSES.md) for the approval workflow.

**View submission** marks that notification as read and opens the owner's private feedback details, including official responses. **Mark all as read** affects only the current student's notifications through the latest notification present when the page was opened. Newer updates stay unread. Lists are paginated, newest first.

The list, unread API, and read actions use the authenticated student's ID. Read actions require CSRF tokens. Notifications and private responses are never broadcast to other students.

For another existing installation, run `npm run db:migrate-notifications` before starting the updated app. This adds only the notification table and is safe to repeat. Fresh installations include the table in `schema.sql`.

Verification uses an owned temporary database and captured email delivery, without sending email to real students:

```powershell
$env:TEST_DB='1'; node --test tests/database.test.js
$env:QA_NOTIFICATIONS_ONLY='1'; npm.cmd run test:workflow
```
