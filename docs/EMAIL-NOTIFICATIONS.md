# Feedback email notifications

This module automatically emails the student whenever an administrator changes feedback status or adds a response, using Nodemailer and SMTP. It is separate from the Emergency Module: emergency reports, guard responses, escalation, and emergency history do not create emails.

## Enable email sending

The local database migration has been applied during implementation. For another existing installation, back up the database and run:

```powershell
npm install
npm run db:migrate-email
```

The migration retains existing records and the original five statuses: Submitted, Under Review, In Progress, Resolved, and Closed. It maps legacy Acknowledged records to Under Review and Rejected records to Closed while retaining history, explanations, and queued emails. It preserves historical decision explanations, adds the resolution timestamp, and creates the email outbox, attempts, and retry audit tables. It also adds the StatusUpdated email kind for automatic updates while retaining older queued email kinds. It can be rerun after a partial DDL failure. It does not backfill emails for past changes or invent explanations for historical resolutions. Fresh installations include the same schema in `schema.sql`.

Configure `.env` with the SMTP settings supplied by CSPC or your mail provider:

```dotenv
SMTP_ENABLED=true
SMTP_HOST=your-smtp-host
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-smtp-username
SMTP_PASSWORD=your-smtp-password
SMTP_FROM=notifications@your-verified-sender-domain
SMTP_FROM_NAME=CSPConnect Team
APP_URL=https://your-cspconnect-host
```

Port 587 normally uses STARTTLS (`SMTP_SECURE=false`); port 465 normally uses immediate TLS (`SMTP_SECURE=true`). Remote SMTP requires authentication and TLS, with certificate verification enabled. Use the provider's required app password or SMTP credential where applicable. Never paste credentials into frontend files or commit `.env`. Configure the sender/domain as required by your provider, including its SPF/DKIM policies. Check provider limits before using an account for bulk notifications.

Restart the app after environment changes, then verify connectivity without sending a message:

```powershell
npm run email:verify
npm start
```

Verification checks the SMTP connection and authentication. It does not prove that a sender will be accepted or that mail reaches a student's inbox. Until SMTP is explicitly enabled and configured, statuses and responses still save, and notifications remain queued. The administrator interface shows this configuration state. No live SMTP credentials were supplied during implementation; real inbox delivery must be verified after configuration.

For local development capture servers only, use `SMTP_HOST=127.0.0.1` and `SMTP_ALLOW_INSECURE_LOCAL=true`. This permits unauthenticated, unencrypted local SMTP in development/test environments; it does not disable TLS requirements for remote SMTP or production. The automated tests use an isolated local capture server and never send messages to real students. The `SMTP_ALLOW_INSECURE_LOCAL` flag must remain false for ordinary remote providers.

## Administrator workflow

- Open a feedback item under Feedback Management. The **Update feedback** form contains one status dropdown and one optional **Response to student** field.
- Choose Submitted, Under Review, In Progress, Resolved, or Closed. Add a response if needed, then select **Save update**. No additional decision fields or confirmation checkboxes are required.
- Each actual status change queues one email automatically, including changes to In Progress, Closed, or back to Submitted. Messages use the selected status and do not invent resolution details.
- If provided, the same response is saved in the student's private official responses and included in that update's email. A response can also be saved without changing status; this sends a response email.
- Saving an unchanged status with an empty response does nothing. Repeated form submissions carry a UUID action key and cannot duplicate the response or notification or undo a later action.
- **Email history** opens the separate Email Notifications page. Filter by queued, sending, accepted, or failed state; expand Attempts for details. Delivery controls are kept off the feedback editing form.
- Failed notifications can be retried when fewer than five attempts have been made and the student has a valid registered email. Every administrator retry is audited. An unconfirmed handoff requires an explicit duplicate-risk confirmation before retrying. The recipient is refreshed from the student's current registered email on manual retry.

## Delivery states and reliability

The status update, optional official response, history item, and outbox row commit in one MySQL transaction. An inability to create the outbox entry rolls back that transaction. SMTP is never called inside the request transaction. SMTP failure after the commit cannot reverse the saved feedback status.

The background worker runs in `src/server.js`, checks approximately every five seconds, and uses a transactional claim with a two-minute lease. Only one worker can claim a notification at a time. Attempts are capped at five, including manual attempts. Temporary failures retry after 1, 5, 15, and 60 minutes. Authentication errors, invalid recipients, and definitive permanent rejections remain Failed for administrator attention.

| Stored state | Interface meaning |
| --- | --- |
| Pending | Queued, possibly waiting for SMTP setup or the next scheduled retry |
| Processing | A worker is attempting the SMTP handoff |
| Sent | Accepted by the mail server; inbox delivery is not confirmed |
| Failed | Sending could not complete, attempts were exhausted, or a handoff is unconfirmed |

SMTP cannot guarantee exactly-once delivery across a process/database failure after acceptance. Every notification has a stable Message-ID, but recipients or providers are not required to deduplicate it. A lost connection during an uncertain handoff or an expired Processing lease is therefore marked **DeliveryUnconfirmed**, with no automatic resend. The administrator must decide whether to retry. Raw SMTP responses, credentials, message bodies, and student addresses are not written to worker error logs; only error categories/codes are retained.

## Privacy and templates

Recipients come from the authenticated submission owner's registered account. Invalid or missing addresses produce a Failed notification while preserving the status change. The worker validates recipients again before SMTP. The snapshot contains only the student name, feedback title/reference, selected status, optional response, and private feedback identifier needed to build that event's email.

The reusable EJS HTML template uses escaped interpolation, inline email styling, responsive width, and no remote images or tracking. Each message includes a plain-text alternative. Nodemailer file/URL attachment access is disabled. All five statuses use automatic templates. The single response section is omitted when blank. Historical queued acknowledgment, resolution, and closure templates remain supported.

Email links point to `/feedback/:id`, which uses the existing Passport session and ownership checks. An unauthenticated student signs in and is returned to that feedback item. A different account receives a denial/404. The link does not publish a submission or create anonymous access. Decision explanations and notification history are not added to public Community Feed DTOs. SMTP history and retry controls are administrator-only and CSRF-protected.

The optional satisfaction-rating form is not part of this implementation; it can be added independently later.

## Verification

```powershell
npm run check
npm test
$env:TEST_DB='1'
npm test
```

Database/browser tests need local MySQL database-creation privileges and Chrome or Edge. Set `BROWSER_PATH` for a different installation path. Each database suite creates and drops only its own random temporary database. New tests cover transactional rollback including responses, all five automatic status updates, response-only updates, MIME handoff to a real local SMTP capture server, escaped templates, duplicate actions, worker concurrency, retry backoff, invalid recipients, unconfirmed leases, retry audit, authenticated deep links, mobile HTML rendering, administrator browser forms, and Emergency Module isolation.

Screenshots: `docs/qa/feedback-email-admin.png` and `docs/qa/feedback-email-mobile.png`. Browser rendering verifies responsive HTML but does not replace provider/inbox acceptance testing in the institution's actual mail clients. Production bounce/webhook tracking and optional satisfaction ratings are not configured.
