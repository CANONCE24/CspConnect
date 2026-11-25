# CSPConnect

A localhost application for Camarines Sur Polytechnic Colleges, built with Node.js, Express, EJS, MySQL/MariaDB, Google OAuth, email/password authentication, and server-side sessions. Students submit private feedback and track official responses. Administrators review submissions, maintain status history, and decide which feedback appears in the moderated Community Feed.

CSPConnect includes a top-right account menu and a **My account** page for students and administrators. Users can update their display name, upload or remove a profile picture, view their email, role, membership date, affiliation, and sign-in method, and access password settings. Profile photos are validated and normalized to 512-pixel WebP images, and custom names and uploaded pictures survive subsequent Google sign-ins. This uses existing user columns and needs no database migration. The login and sign-up screens share the CSPConnect campus identity and responsive layout.

The application starts with empty user and feedback tables. Dashboard totals come from the database. Setup creates supported categories; it does not create demonstration users, feedback, comments, or activity.

In this workspace, the database and dependencies are ready, Google OAuth and Gemini credentials are configured privately, and live Professor responses have been verified. Email/password sign-up and sign-in work alongside Google login. The local administrator account uses `admin@cspc.edu.ph`; its initial password is stored as a one-way hash and must be changed at first sign-in. Start with `npm.cmd start` or `npm.cmd run dev`. See [the verification record](docs/TESTING.md) for current evidence; the setup below is for a new installation.

On October 12, the application database was recovered into a separate local MariaDB instance after the shared XAMPP instance stopped responding. This workspace now uses `127.0.0.1:3307`, with its data in `.local/mysql-data/`. Both `npm.cmd start` and `npm.cmd run dev` automatically start this instance when needed; `npm.cmd run db:start` starts it separately. Keep `.local/` when moving or backing up this installation. The original XAMPP data files were preserved, and a complete snapshot plus the recovery export are in `C:\Users\Sam\Desktop\mysql-recovery-20261012-033416`. The shared XAMPP instance on port 3306 still needs its own repair before use by other projects. Do not run `db:setup` on the recovered database.

The separate instance uses the existing XAMPP `mysqld.exe` binary, binds only to `127.0.0.1`, and runs independently of the XAMPP Control Panel. Its startup log is `.local/mysql-console.log`. Set `LOCAL_MYSQL_BIN` in `.env` if the XAMPP binaries move. To stop it cleanly, run `C:\xampp\mysql\bin\mysqladmin.exe --no-defaults --host=127.0.0.1 --port=3307 --user=root shutdown` after stopping the app; this command uses the current local root account with no password.

On October 20, 2026, the local activity data was reset for the October 21 presentation at the user's request. It now contains 10 fictional submissions: six published Community Feed discussions and four private records, with 30 comments, 37 Support reactions, three Not Helpful reactions, and five administrative responses. Eight NBA star names appear as the student authors, without presentation labels in the application. The concerns and discussions describe normal campus issues. Working student, administrator, and security accounts and configuration were preserved. The fictional profiles have no login credentials. See [the presentation record](docs/COMMUNITY-DEMO.md) for details and the backup location.

## Requirements

- Node.js 22 or newer and npm.
- XAMPP with MySQL/MariaDB running locally on port 3306.
- A Google OAuth web client for login.
- A Gemini API key to enable Professor.

The application runs at `http://localhost:3000`. XAMPP Apache is needed only for phpMyAdmin; Express serves the application itself.

## Setup

1. Start MySQL in the XAMPP Control Panel.
2. Open a terminal in this project:

   ```powershell
   npm.cmd install
   Copy-Item .env.example .env
   ```

   On Windows, `npm.cmd` avoids PowerShell execution-policy errors involving `npm.ps1`. `npm` works normally in Command Prompt or a configured shell. If `.env` already exists, retain its configuration instead of overwriting it.

3. Edit `.env`. Keep it private and never commit it. The example contains placeholders only:

   ```dotenv
   NODE_ENV=development
   PORT=3000
   APP_URL=http://localhost:3000
   DB_HOST=localhost
   DB_PORT=3306
   DB_USER=root
   DB_PASSWORD=
   DB_NAME=cspc_feedback_db
   SESSION_SECRET=replace-with-a-random-secret-at-least-32-characters-long
   GOOGLE_CLIENT_ID=your-google-client-id
   GOOGLE_CLIENT_SECRET=your-google-client-secret
   GOOGLE_CALLBACK_URL=http://localhost:3000/auth/google/callback
   ADMIN_EMAILS=your-authorized-admin@example.com
   CSPC_EMAIL_DOMAINS=cspc.edu.ph,my.cspc.edu.ph
   GEMINI_API_KEY=
   GEMINI_MODEL=gemini-3.5-flash-lite
   ```

   Generate a strong session secret with:

   ```powershell
   node -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('hex'))"
   ```

   Use your actual database credentials. XAMPP commonly uses `root` with an empty password locally. `ADMIN_EMAILS` is a comma-separated allowlist of email addresses authorized for administration. Google sign-in still requires a verified Google address; password sign-in uses the same server-side role allowlist. Public sign-up never grants administrator access. Set `CSPC_EMAIL_DOMAINS` to the exact approved institutional domains. Verified users from these domains choose Student, Faculty or Staff once; verified users from every other domain become Visitors. Affiliation never grants elevated permissions. Existing accounts can run `npm.cmd run db:migrate-affiliation`; see [affiliation setup and verification](docs/AFFILIATION.md).

4. Create the configured application database and tables:

   ```powershell
   npm.cmd run db:setup
   ```

   This command creates a fresh database and refuses any existing `DB_NAME`. After successful setup, do not run it again. To start another fresh installation, choose a new database name beginning with `cspc_` in `.env`.

   Alternatively, start Apache, open `http://localhost/phpmyadmin`, create a new empty database whose name matches `DB_NAME`, select it, and import `schema.sql` followed by `seed.sql`. The SQL files contain table definitions and six configuration categories; they do not select a database or create users. For an existing pre-update database, run `npm.cmd run db:migrate-auth` once to add the email/password columns.

5. Configure Google OAuth below and start Express:

   ```powershell
   npm.cmd start
   ```

   For development, use nodemon to restart after changes to server code, templates, styles, browser JavaScript, or `.env` configuration:

   ```powershell
   npm.cmd run dev
   ```

   The development watcher uses a scoped Chokidar 4 dependency override to avoid the older watcher's [braces advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm). Automatic restarts were verified with this configuration.

6. Open `http://localhost:3000`. Use an allowlisted account for administration and a separate Google account for the student workflow.

## Google OAuth

Create a Google OAuth client of type **Web application** with this exact authorized redirect URI:

```text
http://localhost:3000/auth/google/callback
```

Add `http://localhost:3000` as an authorized JavaScript origin if requested by the Google client configuration. Configure the consent screen and add your demonstration accounts as test users while the consent screen is in testing mode. Paste the client ID and secret into `.env` and restart.

Google sign-in validates the Google ID token on the backend and checks its verified-email claim; Google users do not need a CSPConnect OTP. Regular registration sends a six-digit email code, valid for five minutes with five attempts and a 60-second resend cooldown. Accounts activate only after verification. New passwords use bcrypt and require at least 12 characters and at most 72 UTF-8 bytes. Matching email addresses do not automatically link accounts: Google linking requires explicit confirmation and the existing CSPConnect password. See [login verification and migration](docs/LOGIN-VERIFICATION.md). The initial administrator password is forced to change after first sign-in. Restart after changing `ADMIN_EMAILS`; public registration cannot assign the admin role.

A live login needs valid OAuth credentials and browser interaction. Isolated authenticated-route tests do not prove that Google's live consent/callback succeeds. See [the testing record](docs/TESTING.md) for actual verification status.

## Main workflow

Contact Admin provides private support tickets for students, faculty, staff and visitors. Users can send a message and follow the conversation; administrators manage the Contact Messages inbox, reply, and close or reopen tickets. Updates use the existing in-app notification menu. The login help page also offers direct email contact at `canoncesam76@gmail.com`. Existing installations run `npm.cmd run db:migrate-support`; see [the support implementation and verification notes](docs/CONTACT-ADMIN.md).

1. A student submits a Suggestion, Complaint, Concern, General Feedback, or Appreciation, with an optional image and anonymous display preference.
2. A reference number is generated and the initial Submitted status is recorded.
3. The student uses My Feedback to track private details, status history, and official responses.
4. An administrator reviews, updates status, and responds.
5. An administrator may publish to the Community Feed. Submission alone does not publish feedback.
6. Students can react with Support or Not Helpful, switch or remove their single reaction, and comment on published submissions.
7. Administrators hide or restore comments and unpublish feedback while retaining the private record.

The existing Community Feed supports **Trending**, **Most Supported**, and **Newest** sorting together with search, feedback type filters, and pagination. Newest uses the submission date. Most Supported counts all active Support reactions; Trending counts active Support reactions added or switched to Support in the past seven days, using the existing reaction `updated_at` timestamp. Ties use submission date and then record ID, newest first. Removed reactions and Not Helpful reactions do not contribute to Support rankings.

Students can react directly on feed cards or the discussion page. Clicking the selected reaction removes it; choosing the other switches it. The controls show saved selections and update counts without a page reload, using the existing reaction endpoint and database constraint. Without JavaScript, the same forms still work through the discussion page. The administrator dashboard and Analytics show the five most supported published feedback items with their type, category, Support count, and current status. Reactions do not change publication or status. This enhancement requires no database migration and preserves existing reactions.

Anonymous published feedback displays **Anonymous**. Ownership is retained internally for private tracking. Official administrative responses are separate from community comments.

## Professor

Professor answers application usage questions through the server-side Gemini API. It explains feedback types, anonymity, references, statuses, tracking, and community discussion. Its instructions require it to defer official CSPC policy questions to authorized college offices.

Set `GEMINI_API_KEY` to enable it. `GEMINI_MODEL` is configurable and defaults to `gemini-3.5-flash-lite`. Without a key, or when Gemini is unavailable, Professor displays a friendly service message. If a configured key fails, check key validity, model availability for that key, quota, and network access; restart after editing `.env`. The key is never sent to browser JavaScript. Live Gemini verification requires a valid key and API access.

## Data and security

MySQL stores users, categories, feedback, status history, official responses, reactions, comments, and persistent sessions. SQL values are parameterized. Foreign keys preserve relationships, and a unique constraint prevents duplicate reactions.

Uploaded images are stored locally and served through access-controlled routes, so unpublished attachments remain private. The upload service validates size, extension, declared type, and actual image bytes, then normalizes images to WebP with generated filenames.

New passwords are protected with per-account bcrypt hashes; legacy scrypt hashes remain readable and password sign-in attempts are rate-limited. Server validation, ownership and role checks, CSRF tokens, escaped EJS output, Helmet/CSP, and session cookies protect routes. Local HTTP uses HTTP-compatible cookies; production configuration requires HTTPS. This project runs locally without public deployment.

## Project layout

```text
src/          Express app, configuration, middleware, routes, models, services
views/        EJS authentication, student, admin, and community screens
public/       CSS, browser JavaScript, assets, and protected upload files
scripts/      Database setup and syntax checks
tests/        Isolated HTTP tests and optional database integration tests
docs/         Verification record and manual demonstration checklist
schema.sql    Fresh MySQL/MariaDB table definitions
seed.sql      Six category configuration records; no users or feedback
.env.example  Configuration placeholders
```

## Verification

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run test:browser
npm.cmd run test:workflow
```

See [docs/TESTING.md](docs/TESTING.md) for test scope, database integration commands, and manual checks. Browser QA uses an installed Chrome or Edge, without downloading a browser, and saves screenshots under `docs/qa/`. Set `BROWSER_PATH` if the executable is installed elsewhere. Fixtures live only in test processes or a dedicated temporary database; they are never startup data.

The full [function audit](docs/FUNCTION-AUDIT.md) records the latest fixes and results. `test:workflow` exercises real student/admin browser forms with a newly owned temporary MariaDB database, then removes its test database and uploaded images.

## Troubleshooting

- **Connection refused:** start XAMPP MySQL and confirm `DB_HOST`/`DB_PORT`. Another service may occupy port 3306.
- **Connection timeout:** a listening port does not guarantee a working MySQL server. Check its error log. For this workspace's recovered instance, run `npm.cmd run db:start` and inspect `.local/mysql-console.log`; do not replace the preserved XAMPP data directory or delete InnoDB files.
- **Missing database:** run `npm.cmd run db:setup` using the same `.env` as Express. If a named database already exists, setup refuses it; select a new `cspc_` name for a fresh installation.
- **OAuth redirect mismatch:** match `GOOGLE_CALLBACK_URL` exactly, including port and path.
- **Google access denied:** check consent-screen test users, redirect URLs, and verified Google identity settings.
- **Administrator tools missing:** add the verified account email to `ADMIN_EMAILS`, restart, sign out, and sign in again to update the stored account role. Removing an email from the allowlist blocks admin routes immediately after restart, including existing sessions.
- **Invalid CSRF token:** reload the form after a session change or stale page.
- **Session error:** use a random `SESSION_SECRET` at least 32 characters long.
- **Port 3000 occupied:** stop the other process or update `PORT`, `APP_URL`, and the Google callback together.
# Emergency Assistance prototype

The Emergency Assistance module adds private student reports, a dedicated security dashboard, Socket.IO alerts, automatic incoming alarms, status history, and administrator contact/escalation settings. It remains a development/testing prototype. See [setup, architecture, limits, and test instructions](docs/EMERGENCY-MODULE.md). Existing installations must run `npm run db:migrate-emergency` before starting the updated server.

# Feedback email notifications

Feedback keeps its original five statuses. One status dropdown and one optional response field save the update and automatically queue its email. All five status changes and response-only updates use a transactional SMTP outbox with retry history. Emergency reports do not send email. Configure SMTP in `.env` to enable sending; see [email setup and administrator workflow](docs/EMAIL-NOTIFICATIONS.md). Existing installations should run `npm run db:migrate-email`.

