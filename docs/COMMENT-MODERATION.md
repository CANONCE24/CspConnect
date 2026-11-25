# Comment moderation

New student comments and edits are screened locally using `src/config/comment-rules.json` and `src/services/comment-filter.js`. No external AI API or URL fetch is used. Administrators can adjust the word/phrase groups, link rules, repeated-comment window, and link threshold in the JSON file; restart the app after changing configuration.

Rules cover common English and Filipino/Tagalog profanity, selected harassment and discriminatory phrases, basic leetspeak/masking/separators, promotional/repetitive spam, and links requiring review (for example, shorteners, IP addresses, embedded credentials, executable downloads, and configured domains/TLDs). Pattern separators are bounded to keep screening predictable on the 500-character comment limit.

Keyword matching is a review aid, not proof of misconduct. It can miss new disguises or misunderstand context, quotations, and legitimate links. Every automatic flag records its possible reason for human review. Ordinary disagreement and identity terms are not treated as misconduct by themselves.

## Student flow

- Clean comments publish immediately. Flagged comments are retained, hidden from public discussion, and acknowledged with “Your comment has been submitted and is pending moderation.”
- Students can edit their own published or pending comments. Edits are rescanned and earlier text is retained. Editing an already pending comment does not bypass review; removed comments require administrator restoration before editing.
- The author can see their own pending comments in a private section of the published discussion. Other students cannot see that section's content. Public comment counts include only visible comments.
- **Report comment** accepts harassment/bullying, offensive language, spam, inappropriate content, or other concerns. Reports enter the queue without automatically hiding a visible comment. Each student can report a given comment once; duplicate reports do not create new review items.
- Comment changes are limited to 30 per student per 10 minutes; reports to 10 per student per 10 minutes. Retried comment submissions with the same request key return the original comment rather than creating a duplicate.

## Administrator flow

The existing Comments page has **All Comments**, **Flagged Comments**, and **Hidden Comments**. Search, tab changes, result counts, and pagination work together. The flagged counter counts distinct comments needing review, including visible reported comments. A dashboard indicator links directly to that queue.

**Approve** publishes the current version and resolves its reports. **Remove/Hide** requires confirmation and keeps the record hidden. **Restore** makes an administrator-removed comment visible again. Optional decision notes, actor, timestamp, state, version, original/edited text, and filter signals are retained in moderation history; the page shows recent history. Public community pages expose no report details or moderation history.

Version checks reject a stale decision if the text or reports changed after the form was opened. Request keys deduplicate repeated decisions. Visibility, content, review metadata, report resolution, and audit history commit together; an audit failure rolls the action back.

## Schema and verification

The existing `feedback_comments.is_hidden` remains the visibility control. Three additive tables store review state, reports, and the audit trail. The migration only creates these tables; it does not rewrite or automatically rescan existing comments or change their visibility. When a legacy comment is first edited/moderated/reported, its original text and state are recorded before mutation.

This workspace has already been migrated. For another existing installation, run `npm run db:migrate-comments`. Fresh installations include the tables in `schema.sql`. Repeating the migration preserves saved comments and review records.

Tests cover clean publication, language/link/spam flags, private pending views, approval/removal/restoration, reports and deduplication/rate limits, edits and stale decisions, counts/pagination, audit rollback, migration preservation, escaped content, and actual desktop/mobile browser forms. Database tests use new owned temporary databases and delete only those databases afterward.
