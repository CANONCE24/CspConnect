# Testing and verification record

## Full function audit — October 16, 2026 (Asia/Manila)

The final suite passed **45 tests, 0 failures, 0 skips**. Four reproduced issues were fixed: unsupported/empty request-body crashes, stale account-role authorization after allowlist changes, duplicate password errors, and byte limits rejecting valid multilingual input. The existing desktop/mobile browser suite and a new 11-stage browser workflow against an isolated real MariaDB database passed. The dependency audit reported zero known vulnerabilities. Live Aizen responded successfully; Google authorization reached the provider sign-in page with HTTP 200. Existing application records matched before/after hashes across all seven non-session tables. See [the function audit](FUNCTION-AUDIT.md) for coverage, repeatable commands, and verification limits.

## CSPConnect accounts and sign-in redesign — October 16, 2026 (Asia/Manila)

Follow-up: login and sign-up were simplified at the user's request. Decorative sparkles, floating sample conversation cards, the campus drawing, and promotional headings were removed. Both pages now use the authentic CSPC college seal, downloaded from its Wikimedia Commons file and cross-checked against the official college seal page, with source and license attribution in `public/images/ATTRIBUTION.md`. Form labels and input text are larger. Desktop and mobile rendering and local seal loading were checked again.

The application is now branded CSPConnect across navigation, page titles, authentication screens, footer, server startup, and Aizen. The top-right account control is an accessible disclosure with profile details, My account, password settings, and sign-out. Students and administrators can edit their own display names and upload, replace, preview, or remove a profile photo. Account details show email, role, membership month, and sign-in method. Existing database columns are reused; no migration is needed.

Syntax checks passed for 30 JavaScript files and 33 EJS templates. The full HTTP and MariaDB suite passed **36 tests, 0 failures, 0 skips**, using a newly created temporary database that was dropped afterward. Added checks cover authenticated account information, CSRF before multipart processing, rejecting invalid image bytes, 512×512 WebP normalization, authenticated and referenced-photo access, replacement/removal cleanup, cleanup after a failed database update, attempts to change another account/email/role, and retaining custom names/photos through subsequent Google sign-in.

Desktop and mobile browser QA passed for the redesigned login and sign-up, password visibility, account menu Escape/outside-click behavior, editable profile name, local image preview, photo saving/removal, and existing student/admin/community flows. Screenshots include `docs/qa/login-desktop.png`, `login-mobile.png`, `signup-desktop.png`, `account-desktop.png`, `account-mobile.png`, and `account-menu.png`. The login and profile screenshots were visually inspected. Profile tests used isolated fixtures; existing personal accounts and presentation discussions were not edited.

## Community Feed enhancement — October 15, 2026 (Asia/Manila)

The MariaDB and HTTP suite passed **32 tests, 0 failures, 0 skips**, using a newly created temporary database that was dropped afterward. Added coverage verifies JSON reaction toggling and switching, authoritative counts under concurrent voting, persisted per-student selections, session identity, CSRF, invalid reactions, and administrator/unpublished voting rejection. Ranking tests use actual records with controlled timestamps to distinguish recent Support from older Support, verify switches refresh the active reaction timestamp, ignore Not Helpful, exclude unpublished feedback, and order Newest by submission rather than publication. Search by reference/title, combined type/category/status filters, ranked pagination, invalid sort rejection/fallback, and administrator table rendering are covered.

The normal application database was inspected read-only: its existing reaction table already has `created_at`, `updated_at`, and the unique `(feedback_id, user_id)` constraint. No schema migration or reaction backfill was needed. Test users, votes, and comments were confined to isolated fixtures or the temporary test database.

Browser QA now checks feed and detail reaction toggling/switching without navigation, selection persistence after reload, failed-request state retention, sorting with search/type filters, Apply filters and Reset, Comments navigation, admin read-only controls, and the supported-feedback table. New screenshots: `docs/qa/community-desktop.png`, `docs/qa/community-mobile.png`, and `docs/qa/admin-community-support.png`.

Verification dates: October 6–7, 2026 (Asia/Manila). Fixture tests and live integration evidence are distinguished below. MySQL integration checks used the actual local XAMPP MariaDB service and a new temporary test database.

## Commands and scope

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run test:browser
```

The syntax check parses JavaScript and compiles EJS templates. HTTP tests use a memory session store and isolated fixtures. There is no test-only login bypass, and fixture users or feedback are not inserted into the normal application database.

Browser QA launches an installed Chrome or Edge with Playwright, checks desktop and mobile pages, long feedback titles, keyboard menu behavior, and Aizen fallback, and records screenshots in `docs/qa/`. Set `BROWSER_PATH` to another installed executable if needed. Browser fixtures are isolated from the application database.

The optional MySQL integration suite creates a newly named `cspc_feedback_test_<random>` database, checks the actual store and constraints, and drops only the database it created. It never uses the application database:

```powershell
$env:TEST_DB='1'
npm.cmd test
Remove-Item Env:TEST_DB
```

The database suite also exercises the complete authenticated HTTP workflow with the actual store and `MySQLSessionStore`: submission and reference, private ownership checks, admin status/response, publication, reaction/comment, moderation, and unpublication. Its final cleanup drops only the uniquely named database it created.

October 6: `TEST_DB=1 npm.cmd test` passed **29 tests, 0 failures, 0 skips** (18 isolated HTTP/OAuth tests, 10 nested MariaDB checks, and their parent test). Syntax and desktop/mobile browser QA passed, including long titles and Aizen fallback.

October 7: `npm.cmd run check` parsed 26 JavaScript files and 26 EJS templates. Submission-success notification checks passed after isolated fixture form submissions at desktop 1440px and mobile 390px: accessible `role=status`, focus management, a single-use flash, no overflow, and contrast above 6:1. Screenshots are in `docs/qa/submission-success*.png`; fixtures are not runtime application records.

Live integrations on October 7: Google authorization returned the correct callback/scopes/state, the matching state persisted in MySQL, and an isolated Chrome session reached Google's sign-in page with HTTP 200 and no provider errors. The user completed sign-in separately; the running application database subsequently contained one Google account, one authenticated session, and one feedback submission. The agent did not enter credentials or simulate provider success. Gemini's model-list request returned HTTP 200 with the configured `gemini-3.5-flash-lite` available; the live service and an authenticated isolated Chrome `POST /api/aizen` returned HTTP 200, rendered a reply, exposed no API key, and produced no uncaught JavaScript errors.

Email/password verification on October 7 used a newly created, temporary MariaDB database and then dropped it. Gmail sign-up worked with a CSPC-only domain restriction configured; password sign-in, salted scrypt storage, verified Google account linking, generic duplicate handling, and rejection of public sign-up for the allowlisted admin email all passed. The test added no users to the normal application database. On the normal database, the requested `admin@cspc.edu.ph` account is now allowlisted with a scrypt password hash and a required first-sign-in password change. An isolated sign-in session confirmed access is gated until that change; no password change was submitted by the test. The application is running under nodemon at localhost:3000; its current login page serves Google and email/password sign-in plus sign-up.

At the user's request on October 7, three explicitly labeled anonymous Preview posts were created in the local application database and published: `FB-2026-00002`, `FB-2026-00003`, and `FB-2026-00004`. They use the existing student account without creating accounts, votes, comments, or simulated administrator actions. The existing private submission was retained. `scripts/preview-community.js` records only the created IDs/references and owner ID; its removal command validates the original records and refuses to delete subsequent student or administrator contributions.

October 12 recovery: the shared XAMPP server accepted TCP connections but did not send a MySQL handshake. Its files contained inconsistent InnoDB log sequence numbers, damaged Aria privilege tables, and replication metadata containing server log text. A stopped-server snapshot of the entire data directory was preserved at `C:\Users\Sam\Desktop\mysql-recovery-20261012-033416\original-data`. Recovery and export used a separate working copy. A clean MariaDB instance was initialized in `.local/mysql-data` on loopback port 3307, and only `cspc_feedback_db` was restored. The restored export matches the recovery export after normalizing unique-index order and the export timestamp. All eight application tables passed `mysqlcheck`: 2 users, 4 feedback records, 6 categories, 4 status-history entries, 1 comment, 1 reaction, 0 official responses, and 13 sessions at restoration. The pre-start hooks start only this dedicated instance and verify its data directory; the original shared XAMPP files are retained for separate repair.

Recovery validation on October 12: syntax checks passed for 27 JavaScript files and 26 EJS templates. The complete suite, including a separate temporary MariaDB database, passed **29 tests, 0 failures, 0 skips**. A clean shutdown followed by `npm.cmd run predev` started the dedicated database again, and `npm.cmd run prestart` reused it successfully. The existing nodemon session restarted the app, and `http://127.0.0.1:3000/login` returned HTTP 200 with its sign-in form. SHA-256 comparison confirmed all 291 original XAMPP data files still match the preserved snapshot. `.local/recovery-verification.json` records the export comparison and restoration counts privately.

## Verification status

| Requirement | Status | Evidence or remaining step |
| --- | --- | --- |
| JavaScript/EJS syntax | PASSED | `npm.cmd run check` parsed 26 JS files and compiled 26 EJS templates. |
| Isolated HTTP suite | PASSED | Automated security and feature tests. |
| Desktop/mobile browser QA | PASSED | Empty/populated views, detail pages, long titles, keyboard menu, no uncaught JavaScript errors. |
| Local MySQL connection | PASSED | Opt-in integration suite used actual XAMPP MariaDB. |
| Application startup | PASSED | `npm.cmd start`, login/static assets at localhost:3000. Initial empty DB checked October 6; user activity observed October 7. |
| Google Login | PASSED (user completed) | Account, authenticated session, and submission observed after the user's real sign-in. Agent did not enter credentials. |
| Google OAuth wiring | PASSED | Live authorization/state persistence and Google sign-in page; offline invalid-state, verified-email, domain, and allowlist checks. |
| Gmail/CSPC email sign-up and login | PASSED | Isolated MariaDB flow verified ordinary Gmail registration and password login, even with the institution restriction set. |
| Password storage and account linking | PASSED | Scrypt hash checked in the temporary database; verified Google identity linked to the same account without replacing the password. |
| Initial admin login | PASSED | Requested account is allowlisted and stored; test confirmed forced password change and blocked admin routes beforehand. |
| Student dashboard | PASSED | Browser rendering and real database ownership-scoped statistics. |
| Admin dashboard | PASSED | Browser rendering, allowlist gating, and actual aggregate statistics. |
| Feedback submission | PASSED | Real HTTP/DB submission, initial status, concurrent unique references. |
| Submission-success notification | PASSED | October 7 desktop/mobile fixture submission; reference, accessible status, focus, single-use flash, layout and contrast. |
| Anonymous feedback | PASSED | Real public DTO allowlist and rendered community HTML omit private identity. |
| Image upload | PASSED | Real upload/Sharp service: valid image, disguised executable, type/bytes mismatch, oversize input, private/static access. |
| My Feedback | PASSED | Session owner passed to query; real list excludes other owners. |
| Feedback details | PASSED | Real HTTP IDOR rejection and owner detail. |
| Status updates | PASSED | Admin HTTP/DB accepted; student denied. |
| Status history | PASSED | All five statuses, chronological persisted history, unchanged status creates no duplicate. |
| Admin response | PASSED | Real official response appears privately and is absent from public DTO/HTML. |
| Community Feed | PASSED | Actual query exposes explicitly published rows only. |
| Publish/unpublish | PASSED | Real HTTP/DB unpublication denies community access and retains private data. |
| Support reaction | PASSED | Actual author/count and student authorization. |
| Not Helpful reaction | PASSED | Actual switch and counter values. |
| Reaction switching/removal | PASSED | Real UNIQUE constraint rejects duplicate insert; concurrency preserves one row. |
| Comments | PASSED | Trim, empty/Unicode length rejection, persisted literal text and chronological order. |
| Comment moderation | PASSED | Real HTTP hide, DB hide/restore, hidden comments absent for students. |
| Search | PASSED | Literal and hostile strings stay within public/owner scope. |
| Filtering | PASSED | Actual type/status/category/visibility filters. |
| Pagination | PASSED | Real 16 published rows across bounded pages; invalid page clamps safely. |
| Aizen fallback/API wiring | PASSED | Missing key, stubbed success/network error, server-only key, policy instructions; browser fallback. |
| Live Gemini response | PASSED | October 7 model availability HTTP 200; live service and authenticated isolated browser API HTTP 200, reply rendered, key absent, no uncaught JS errors. |
| Authorization | PASSED | Anonymous, owner, other student, admin, stale role and institution restriction cases. |
| CSRF | PASSED | Missing/wrong/other-session token rejection; same-session body/header tokens accepted. |
| XSS | PASSED | Hostile feedback, accounts, categories, comments, and searches rendered escaped; CSP/security headers asserted. |
| SQL injection | PASSED | Actual parameterized search/comment input and escaped LIKE wildcards. |
| MySQL session persistence | PASSED | Two adapters, expiry, touch, destroy, and joined HTTP workflow. |

## Manual localhost demonstration

Development watcher update: `npm.cmd run dev` was verified with nodemon 3.1.14 and the scoped Chokidar 4.0.3 override. A temporary source file triggered automatic restart, and the login page returned HTTP 200 afterward on a separate verification port. The temporary file and verification server were removed; `npm.cmd audit` reported zero vulnerabilities.

Use two student Google accounts and one allowlisted admin account.

1. As Student A, submit anonymous feedback with a valid image. Check its reference, Submitted history entry, and My Feedback record.
2. As Student B, request Student A's private details and attachment. Access must fail and the unpublished record must be absent from the feed.
3. As admin, review, update status, and add an official response. Check history timestamps.
4. Publish it. Student B should see Anonymous with no owner email, Google ID, private user ID, or profile link in public HTML.
5. Support, switch to Not Helpful, and remove the reaction; compare counts and database rows.
6. Comment with whitespace, then try empty text and more than 500 characters. Forge `user_id`; the author must remain the authenticated session user.
7. Hide and restore a comment as admin. Confirm student visibility and admin moderation visibility.
8. Unpublish. Community detail, reaction/comment access, and attachment access for other students must fail. The owner record must remain.
9. Resolve and close; check history and dashboard counts.
10. Exercise search, all feedback types, category/status filters, and several pages.
11. Exercise Aizen fallback and a live response when credentials are available; it must defer policy questions to CSPC.
12. Try missing CSRF tokens, another session's token, forged roles/user IDs, and malformed IDs. Verify denied operations leave data unchanged.

Use `<script>alert(1)</script>` and `' OR 1=1 --` only in isolated test data to verify escaping and bounded searches. Record live OAuth and Gemini checks separately from fixtures and service stubs.
# Emergency module verification

See [Emergency Assistance prototype tests](EMERGENCY-MODULE.md#verification) for the database, Socket.IO, alarm, reconnection, access-control, and mobile coverage. `TEST_DB=1` includes these isolated checks in the normal test command.

Feedback email tests are documented in [Email Notifications](EMAIL-NOTIFICATIONS.md#verification). They use temporary databases and a local SMTP capture server; no messages are sent to real students.

