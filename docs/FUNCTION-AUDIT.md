# CSPConnect function audit

Checked October 16, 2026 (Asia/Manila).

Four issues were reproduced and fixed:

1. Empty or unsupported request bodies could raise a TypeError and return HTTP 500. Routes now receive an empty object and apply their normal validation.
2. Password sign-in could use an outdated database role, sending a former administrator to a forbidden page. Sign-in now synchronizes the role from the server allowlist. Existing sessions that lose administrator access also synchronize the database role, keeping route and model authorization consistent. Browser-supplied role fields are ignored.
3. Password validation errors appeared twice. The shared page notification now displays the error once.
4. Byte limits rejected some multilingual feedback and official responses within the advertised character limits. Multipart text fields now allow 40 KiB and JSON/form bodies allow 64 KiB; the existing character limits and 5 MiB image limit still apply.

Verification results:

| Check | Result |
| --- | --- |
| JavaScript and template syntax | 32 JavaScript files and 33 EJS templates passed. |
| Automated HTTP, authentication, upload, security, and MariaDB tests | 45 passed, 0 failures, 0 skips. MariaDB tests used a new temporary database. |
| Existing browser suite | Desktop/mobile student and administrator screens, account menu, photo controls, reaction persistence/failure handling, sorting/filtering, Aizen fallback, and navigation passed. |
| Full browser workflow with real storage | All 11 stages passed using actual forms, password hashes, sessions, uploads, and database models in another newly owned temporary database. See `docs/qa/workflow-verification.json`. |
| Dependency audit | `npm audit --json` reported 0 known vulnerabilities. |
| Live Aizen request | Passed: the configured service returned instructions for changing a profile picture. No credentials were printed. |
| Live Google authorization | The configured button reached Google's sign-in page with HTTP 200. Completing sign-in and consent with a real Google account was not automated. Offline tests cover state validation, verified email, domain restrictions, account linking, and role checks. |
| Existing presentation data | Counts and SHA-256 hashes matched before/after for users, categories, feedback, status history, responses, reactions, and comments. Session rows were excluded because normal browsing updates them. |

The full browser workflow covers registration, private anonymous feedback with an image and reference, owner-only attachment access, forced initial administrator password change, administrative status updates and official responses, publication, public anonymity, reaction toggling and switching, comments, hide/restore moderation, category creation and deactivation, analytics, profile name/photo updates and removal, password change and new-password login, logout, unpublication, retained private records, and populated mobile layouts.

To repeat:

```powershell
npm.cmd run check
$env:TEST_DB='1'
npm.cmd test
Remove-Item Env:TEST_DB
npm.cmd run test:browser
npm.cmd run test:workflow
npm.cmd audit
```

`test:workflow` always creates and drops its own randomly named `cspc_feedback_test_<random>` database. It does not use the presentation database for test records. The installed Chrome or Edge is used; `BROWSER_PATH` can select another installed browser. No database migration is required for these fixes.
