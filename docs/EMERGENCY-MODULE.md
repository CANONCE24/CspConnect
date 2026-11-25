# Emergency Assistance prototype

This module is a development and testing prototype. It is **not an approved or monitored emergency response service**. A saved report or a connected dashboard does not guarantee help. Students must use CSPC's verified official contact channels for urgent assistance.

## Setup

1. Install dependencies with `npm install`.
2. Back up an existing database, then run `npm run db:migrate-emergency`. This additive, repeatable migration extends `users.role` and creates four emergency tables. It does not modify feedback records. MySQL DDL is not transactional; rerun the migration after correcting a failure. Fresh installations use the updated `schema.sql` through the existing database setup command. Do not run fresh database setup against an existing installation.
3. Have each guard create an account through normal sign-up. Put authorized guard email addresses in `SECURITY_EMAILS` in `.env`. Set `SECURITY_PROVISION_EMAIL` to one of those addresses and run `npm run security:provision` for each account. The command assigns a role to an existing non-admin account and does not change passwords. Both the stored `security` role and the allowlist are required; sign-up cannot grant security access. Remove an address from the allowlist and restart the server to revoke it.
4. Restart the application with `npm start` or `npm run dev`. Security accounts land at `/security`; students have an Emergency navigation tab at `/emergency`.
5. An authorized administrator opens **Emergency Settings** at `/admin/emergency-settings`. Enter a number verified with CSPC, check its verification box, and save. Until then, calling remains unavailable. Alternatively, before any settings have been saved, set `GUARDHOUSE_NUMBER` and `GUARDHOUSE_NUMBER_VERIFIED=true` in the environment. A saved database setting always takes precedence over environment defaults. Phone validation checks syntax; a person must verify ownership and availability with CSPC.
6. Configure escalation from 1–120 minutes in Emergency Settings (default 3). `EMERGENCY_ESCALATION_MINUTES` provides the initial default. All settings changes are audited. Restart after environment changes.

No official number is supplied by this implementation. The numbers in automated tests and screenshots are test fixture values and must not be used as verified contacts.

## Design and changed surfaces

- `src/models/emergencies.js`: parameterized SQL, transactional submission/status changes, ownership filtering, database rate limits, settings, and escalation.
- `src/routes/emergencies.js`: student forms, private report APIs, security controls, and administrator settings, protected by existing Passport authentication and CSRF middleware.
- `src/services/emergency-realtime.js`: Socket.IO on the existing HTTP server, sharing the existing session middleware. Connections require a session and its CSRF token. Browser handshakes check the configured application origin. Identity, email domain, current allowlist, and password-change requirement are rechecked before notification delivery and periodically; invalid sessions disconnect.
- `public/js/emergency.js`, `public/css/emergency.css`, `views/emergency/`: responsive student and guard views, persistent red alert cards, automatic Web Audio alarms, connection indicators, and history.
- Existing authentication, navigation, startup, and role validation now recognize security accounts. Google sign-in preserves a provisioned security role only while the account remains allowlisted. Existing feedback, community, and administrator permissions retain their prior behavior.
- New runtime dependency: `socket.io`; test dependency: `socket.io-client`. Both use the existing free/open-source stack.

Tables are separate from feedback:

| Table | Purpose |
| --- | --- |
| `emergency_reports` | UUID report ID (displayed as `EM-<UUID>`), reporter, type, location, description, optional contact, timestamps, status, acknowledging guard, escalation, and idempotency key |
| `emergency_history` | Initial submission, every status transition, and system escalation with actor and timestamp |
| `emergency_settings` | Singleton guardhouse contact verification and escalation configuration |
| `emergency_settings_history` | Administrator setting snapshots and actor |

One campus-wide guardhouse dashboard is implemented. All provisioned security accounts are assigned to this same campus dashboard and may view its reports. Students can retrieve only their own reports. Administrators configure settings but cannot access emergency reports through these routes. There is no emergency publication or community endpoint. A deployment needing multiple campuses or guard teams must add explicit assignment and filtering before use.

The emergency interface uses one active report list with All active, Needs response, and Responding filters, plus resolved history. The popup shows only the emergency details and response action. Healthy connection/audio status is hidden; offline, reconnection, and audio failures appear only when attention is needed. Report references and expandable status history are kept on the detail page.

## Data, alerts, and recovery

Submissions commit a report and its audit entry together before emitting an event. A per-form UUID prevents duplicate records on retries, including simultaneous retries. A serialized per-student database check limits submissions to five per ten minutes; an additional HTTP limiter restricts repeated attempts. The app's global limiter remains in place. Errors do not expose report content or credentials in logs.

Only server-selected recipients receive Socket.IO invalidation events: authorized guards and the reporting student. Events contain a report identifier; content is retrieved through authenticated, ownership-filtered HTTP APIs. Clients cannot choose rooms or send status changes through sockets. Logout, expired sessions, removed roles, and forced password changes invalidate subscriptions.

The browser loads reports from MySQL on initial load, every reconnect, and every 15 seconds as a delivery fallback. All unresolved reports are returned so older unacknowledged incidents cannot disappear through pagination. Resolved history uses 25 records per page. Counts come from the database. Rendering compares snapshots and report IDs to avoid duplicate cards on reconnect. Failed requests preserve displayed incidents and show a stale-data warning. Offline form submission is disabled; no sensitive report is queued in local storage.

Status history follows **Submitted ? Acknowledged ? Responding ? Resolved**. The **Respond to Emergency** action records Acknowledged and Responding together in one database transaction, including the guard ID and acknowledgment time. Guards then mark the report Resolved when assistance is complete. Repeated or simultaneous response requests are idempotent. Students receive the Responding update in real time.

Every new Submitted report opens an incoming-emergency dialog and automatically attempts a repeating two-tone alarm, approximately every 1.5 seconds. The popup has one action for each report: **Respond to Emergency**. It stops that report's alarm only after the server confirms that security is responding. Other unanswered reports remain in the popup and keep ringing. A failed response request keeps the popup and alarm active. There are no sound-enable, mute, or generic dismiss buttons. Escape and backdrop clicks do not dismiss unanswered incidents. A report accepted by another guard is removed on the next synchronized snapshot. Monitoring runs on the security dashboard, report-detail, and account pages.

Audio is attempted on page load and report arrival, and automatically retried during normal keyboard, click, or touch interaction. Standard browsers may block audio autoplay before interaction; the app displays that actual state and always shows the popup. This restriction cannot be overridden by ordinary website JavaScript. For a guardhouse workstation requiring sound with no activation click, start the application, then run:

```powershell
npm run security:monitor
```

This opens Chrome or Edge in a dedicated local monitor profile with autoplay allowed, targeting the security sign-in/dashboard. It does not change the user's normal browser profile or global settings. Set BROWSER_PATH if the browser is installed elsewhere. Keep the monitor window open and the workstation's audio audible. The launcher profile, including its separate browser session, is under the ignored .local/security-monitor-browser directory. The browser tests verify real AudioContext playback with the same autoplay flag.

Every 15 seconds the single server flags overdue Submitted reports and writes an `Escalated` audit entry, then notifies connected dashboards. Escalated incidents remain Submitted, display a stronger label, and repeat sound more frequently. This is dashboard escalation only; it does not contact another person or place calls. It recovers overdue reports from the database after a restart. Database or notification failure never acknowledges or resolves a report. A failed Socket.IO delivery does not undo a saved submission.

`tel:` links open the operating system dialer and never initiate calls automatically. The configured number is also displayed for manual dialing. Unsupported devices and missing/unverified/invalid numbers have visible fallback instructions.

## Verification

Run the fast suite with `npm test` and syntax/template checks with `npm run check`. Database/browser checks are opt-in because they require local MySQL database creation privileges and Chrome or Edge:

```powershell
$env:TEST_DB='1'
npm test
```

Use `BROWSER_PATH` if Chrome/Edge is installed elsewhere. Each database test creates a random, owned temporary database and deletes only that database afterward. It never inserts test reports into the configured application database. The emergency tests cover:

1. Valid student submission, audit persistence, UUID uniqueness, and simultaneous duplicate retries.
2. Socket.IO delivery without refresh, only to authorized guards and the owner.
3. Native AudioContext activation without a sound-enable button in the dedicated monitor configuration, repeating alarms, and accepting an emergency through the Respond action.
4. Acknowledgment, timestamp/guard attribution, sequential transitions, and simultaneous guard actions.
5. Student status updates in the browser without refresh.
6. Multiple independent pending incidents and acknowledgment of only one.
7. Offline dashboard indicators and preserved reports.
8. Reconnect snapshots and absence of duplicate alert cards.
9. Anonymous/other-student/admin denial, role revocation, session/CSRF handshake checks, and unauthorized writes.
10. Mobile form submission, responsive layout, and the configured `tel:` target. Actual device dialing is intentionally not initiated by tests.
11. Missing, malformed, and verified contact configuration.
12. Committed submission surviving simulated notification failure, plus HTTP/database recovery.
13. Database anti-spam limits, durable once-only escalation, settings audit, and repeatable migration.

Browser screenshots are generated at `docs/qa/emergency-security.png`, `docs/qa/emergency-alarm-popup.png`, and `docs/qa/emergency-student-mobile.png`. Browser tests verify audio node starts; a human must still confirm speaker audibility on each guard device. Physical device dialer handling, assistive technology behavior, institutional monitoring, and operational reliability require acceptance testing before approval.

## Approval and deployment limits

The prominent prototype banner was removed from the application pages at the user's request; prototype status remains documented here. Before operational rollout, CSPC must verify contact numbers, authorize and train security staff, define monitoring schedules and escalation procedures, test reliability and physical devices, and approve data access and retention practices. The module does not imply these approvals exist.

Run this prototype as one Node process. Socket.IO multi-process delivery requires a shared adapter and deployment-specific session/load-balancer configuration, which are not configured here. A proxy must allow Socket.IO polling and WebSocket upgrades and preserve the application origin. Use HTTPS and the existing production cookie configuration for any approved deployment. The app's global request limiter may need capacity testing for the intended number of connected clients. Restarting an already-running pre-change server is required to load the module.
