# Approved automated responses

Open an administrator's Feedback Management detail page. The update form uses local JavaScript templates from `src/services/responseTemplates.js`; it does not use an AI API.

1. Choose an existing status. A draft uses the actual title, category, type, and reference.
2. Review or rewrite the response. Changing status or restoring the default asks before replacing edited text.
3. For **Resolved**, enter the actual action taken and confirm the work was completed. For **Closed**, enter the reason for closing, including a rejection explanation when applicable. No statuses or categories were added.
4. Choose **Web Only**, **Email Only**, or **Both** (default).
5. Select **Update & Notify** to review the final status, delivery method, details, and response. **Keep editing** and Escape dismiss the review without saving. **Confirm update** commits the approved update.

| Method | In-app notification | Queued email | My Feedback history and response |
| --- | --- | --- | --- |
| Web Only | Yes | No | Saved |
| Email Only | No | Yes | Saved |
| Both | Yes | Yes | Saved |

The status, history, approved response, and selected notifications commit in one database transaction. Request keys prevent concurrent duplicate submissions; identical repeated approvals also do not create duplicate notifications. Conflicting reuse of an existing request key is refused. Failed validation retains the draft for correction and creates no notification.

The existing history columns retain the approved response and any actual action or closure reason. No migration is required. Existing approved responses and history are retained; history messages can be expanded, and full official responses remain visible in My Feedback. Public community pages do not expose private responses.

New feedback-update emails contain a concise status notice and a link to the private submission, where the full response can be read after signing in as its owner. Older queued email snapshots retain their previous format. The existing SMTP worker records attempts, retries temporary failures, and exposes failed deliveries in Email history. SMTP failures do not roll back an already saved update.

Verification covers all five statuses with all three methods, editing and restoring drafts, canceled and approved reviews, actual action/closure validation, concurrent clicks, privacy, concise email rendering, local SMTP failures/retries, and desktop/mobile layouts. Database tests use owned temporary databases; browser workflow emails are captured rather than sent to real students.
