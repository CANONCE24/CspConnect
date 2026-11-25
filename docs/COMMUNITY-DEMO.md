# Presentation data

Reset on October 20, 2026 for the October 21 presentation, at the user's explicit request.

The local application has 10 fictional feedback records: six published community discussions and four private submissions. The published discussions contain 30 comments, 37 Support reactions, and three Not Helpful reactions. Five administrative responses and complete status histories demonstrate all five feedback statuses. Text describes ordinary campus concerns and uses no Demo labels.

Student authors and commenters are LeBron James, Stephen Curry, Luka Dončić, Giannis Antetokounmpo, Nikola Jokić, Shai Gilgeous-Alexander, Anthony Edwards, and Victor Wembanyama. These are fictional presentation profiles using reserved `presentation.invalid` addresses, without passwords or Google identities. Administrative responses are attributed to the existing CSPC Administrator account. Content does not document actual campus incidents or decisions.

The private concern **FB-2026-00007**, submitted by Shai Gilgeous-Alexander, reports a flickering walkway light near the library entrance. It remains **Submitted** and unpublished, ready for the presenter to review, update, respond to, or publish from `/admin/feedback/7`. Other private records cover a restroom maintenance complaint, a consolidated service-checklist suggestion, and laboratory scheduling feedback.

Existing feedback, comments, reactions, responses, status histories, email notifications and delivery history, emergency reports and history, emergency settings history, sessions, and the previous fictional profiles were removed. The working student, administrator, and guardhouse accounts, categories, and current emergency contact configuration were retained. Clearing sessions requires signing in again. No presentation email notifications or active emergency alerts were created.

A full SQL backup taken before any deletion is stored privately at:

`.local/backups/cspc_feedback_db-before-presentation-2026-10-20T13-57-48-380Z.sql`

The exact created records are listed in `docs/qa/presentation-records-2026-10-20T13-57-48-797Z.json`. Earlier community preview/demo manifests are historical and do not describe the current database.

The explicit reset is implemented in `scripts/reset-presentation-data.js` and loads `scripts/presentation-data.js`. It never runs during startup. It checks for a local development database, creates and verifies a full SQL backup, then clears activity and inserts the replacement records in a transaction. Working sign-in accounts are retained. To deliberately replace local activity with this same presentation set again:

```powershell
node scripts/reset-presentation-data.js --reset
```

Do not use the old `seed-community-demo.js` or preview cleanup commands for this dataset. Open `/community` for the six discussions and `/admin/feedback` for all 10 submissions. The presenter's personal student account starts with no seeded reactions or comments, allowing interactions to be demonstrated live.
