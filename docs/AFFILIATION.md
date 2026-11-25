# Verified email affiliation

Implemented October 21, 2026. Affiliation is profile information, separate from authorization. Existing accounts, password hashes, user IDs, feedback and permission roles are retained.

## Configuration and migration

```dotenv
CSPC_EMAIL_DOMAINS=cspc.edu.ph,my.cspc.edu.ph
```

These exact domains are published by CSPC: the [official college directory](https://cspc.edu.ph/college-officials/) lists `cspc.edu.ph` addresses, and the [CSPC account claiming page](https://profile.cspc.edu.ph/ClaimEmail) uses `my.cspc.edu.ph`. Matching is case-insensitive and exact; lookalikes and unlisted subdomains are external domains. Configure additional domains only after confirming institutional ownership.

The old `ALLOWED_EMAIL_DOMAIN` restriction is retired. Registration and sign-in accept other valid email domains, including Gmail, Yahoo and Outlook, as requested. The new setting classifies verified addresses; it does not grant permissions or certify enrollment.

Existing installations run:

```powershell
npm.cmd run db:migrate-affiliation
```

The migration adds only two nullable columns to `users`:

| Column | Purpose |
| --- | --- |
| `affiliation` | Student, Faculty, Staff or Visitor; initially NULL |
| `affiliation_email` | Verified email address associated with that affiliation |

It checks for each column before adding it. It does not update existing rows, passwords, roles or sessions. It has been applied to this workspace. New installations get the columns through `schema.sql`; do not run `db:setup` on an existing database.

## Workflow

- Google sign-in retains ID token validation, strict `email_verified`, state, PKCE and explicit confirmation when linking an existing password account. No extra OTP is introduced.
- Regular email registration retains the six-digit OTP, five-minute expiry, five attempts, resend cooldown and bcrypt. Successful OTP verification now signs the user in directly.
- Verified CSPC accounts without affiliation open `/complete-profile`, with Student, Faculty and Staff as the only choices. Saving opens the existing dashboard or a previously requested private feedback link. Returning users keep their choice.
- Other verified email domains automatically receive Visitor and proceed to the existing dashboard.
- Existing verified accounts follow the same flow at login or on their next authenticated request. Existing valid affiliation values are retained. Legacy unverified accounts keep their existing login compatibility, but cannot receive or select affiliation until email ownership is verified.
- All ordinary affiliations use the existing user dashboard. The internal regular role remains `student` to preserve existing authorization checks; its account label now reads User. Existing `admin` and `security` roles are unchanged. Elevated roles still require explicit provisioning and the corresponding server allowlist. An allowlisted email alone does not promote a new Google signup.

Campus affiliations are selected by the account holder and do not prove current enrollment or employment. The interface displays the affiliation without a self-declared label. Regular users see their saved affiliation beneath their name in the account header and dropdown, and on their profile badge.

## Integrity and privacy

Assignments read and lock the current email and verification state in MySQL. Values are validated on the server; Visitor, administrator labels and arbitrary strings cannot be submitted as campus choices. CSRF and existing session protections remain active. Repeated identical saves are safe; a conflicting later or concurrent selection receives HTTP 409.

The saved verified email binds the affiliation to its ownership proof. When Google verifies a changed address, the same user account is retained, old affiliation and recovery/registration proofs are invalidated, and old sessions are revoked. External addresses become Visitor; institutional addresses require a fresh choice. Normal affiliation saves do not revoke sessions.

Administrators see affiliation in feedback tables/details, can combine an affiliation filter with existing feedback filters and pagination, and see aggregate feedback counts by current submitter affiliation in Analytics. Unknown existing affiliations appear as Not set until classification. Affiliation is omitted from public Community Feed DTOs, including anonymous submissions.

## Files

- `src/services/affiliation.js`, `src/models/affiliation.js`, `src/routes/affiliation.js`: shared classification, transactional persistence, completion routes and guard.
- `src/config/env.js`, `src/config/passport.js`, `src/routes/auth.js`, `src/app.js`: configuration and integration with verified Google, password and OTP sessions.
- `src/models/store.js`, `src/routes/pages.js`: account reads, email changes, private feedback data, affiliation filtering and analytics.
- `views/auth/complete-profile.ejs`, `views/account/profile.ejs`, `views/partials/{head,sidebar,detail-content,feedback-table,filters}.ejs`, `views/admin/{feedback,analytics}.ejs`: existing-design UI and restricted displays.
- `scripts/migrate-affiliation.js`, `schema.sql`, `package.json`, `src/server.js`, `.env.example`: repeatable migration, fresh setup, startup check and settings. The local `.env` has the approved domain setting; credentials were retained.
- `src/services/emergency-realtime.js`: removes the retired domain restriction while retaining socket authentication, verified/legacy account readiness, role checks, versioned sessions and CSRF.
- `tests/affiliation.test.js`, `tests/affiliation-database.test.js`: domain and real database authentication/security cases. Existing auth/database fixtures and `scripts/workflow-qa.js` now follow the verified profile flow and explicitly provision test administrators.
- `README.md`, `docs/LOGIN-VERIFICATION.md`, `docs/DEFENSE-REVIEW.md`: updated behavior and configuration references.

## Verification

Results: **122 tests passed, 0 failures, 0 skips** with `TEST_DB=1`. `npm.cmd run check`, `npm.cmd run test:browser` and `npm.cmd run test:workflow` also passed. The local `/login` page returned HTTP 200 after the update.

Tests cover both Google and OTP paths; all three campus affiliations; Gmail, Yahoo, Outlook and other domains; lookalikes; invalid/unverified submissions; CSRF; concurrency and one-time selection; existing users and administrators; unchanged passwords and identities; email changes, revoked old sessions and recovery tokens; combined admin filtering/counts; and public privacy.

Database tests use newly owned temporary databases that are dropped afterward. Test email is captured or delivered to a local SMTP test server; no real registration emails are sent. Google provider exchange is stubbed in HTTP tests, while the existing signed-token suite checks the real JWT verifier. A live Google account consent flow was not automated.

The browser workflow exercises OTP activation, one-time Student and Faculty choices, returning users, all existing feedback/community features, notifications, profile updates and password recovery. Desktop and 390px mobile pages were checked for overflow and visually inspected. Screenshots: `docs/qa/affiliation-desktop.png` and `docs/qa/affiliation-mobile.png`. Logs: `.local/affiliation-tests.log`, `.local/affiliation-workflow.log`; workflow evidence: `docs/qa/workflow-verification.json`.
