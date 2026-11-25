# CSPConnect defense review

Reviewed October 21, 2026 (Asia/Manila).

Status: this is the historical findings list. The user subsequently narrowed implementation to Google sign-in, regular registration OTP and explicit account linking. See [the implemented login flow](LOGIN-VERIFICATION.md) for current behavior. The broader fixes remain deferred.

Purpose: identify specific challenges for the presentation rubric's system-output and attack/defense criteria, with evidence and honest answers. The rubric attachment is reference material. This review does not implement fixes.

## Verification

- Existing suite: 37 passed, 0 failed, 3 integration tests skipped (`TEST_DB=0; npm.cmd test`). A passing suite does not mean the gaps below are covered.
- Additional checks: `node tmp/defense-review.cjs` reproduced unverified registration granting access, retention of a preexisting password during Google linking, another session surviving a password change, duplicate feedback submissions, and the sign-in requirement on password change.
- Those checks used a newly created random `cspc_feedback_test_<hex>` MariaDB database and removed it afterward. No real email was sent. Google linking was tested at the model boundary with a simulated verified profile; no live Google consent or impersonation was performed. No presentation records were modified.
- Other findings below come from code review, not live performance, availability, or device testing.

## 1. No forgotten-password recovery

**Challenge:** “What happens if a password user forgets their password?”

**Evidence:** [auth routes](../src/routes/auth.js) implement sign-up, login, Google login and authenticated password change. `/account/password` redirects signed-out visitors to `/login`. An existing password normally requires the current password to change it. There is no forgotten-password route or reset-token storage in the schema.

**Impact:** A password-only user without access through the same Google email cannot recover access through the UI. Even when same-email Google login works, the password-change form still asks for the existing password if one is already set.

**Honest defense:** “Self-service password recovery is a confirmed missing feature. Password change works for signed-in users. Same-email Google sign-in can provide access where applicable, but it is not a complete password-reset process.”

**Proposed fix:** Add ownership-verified recovery with expiring, single-use reset tokens, a generic request response, throttling, and session revocation. Do not describe administrator password provisioning as an existing student-recovery workflow.

## 2. Email ownership is unverified; automatic linking preserves an earlier password

**Challenge:** “How do you know a registrant owns that email? What if somebody registers another person's address first?”

**Evidence:** [registration](../src/routes/auth.js) creates an account and signs it in immediately. There is no verification challenge. [upsertGoogleUser](../src/models/store.js) links a verified Google identity to an existing email record while leaving `password_hash` intact. The isolated check confirmed that the previously chosen password remains valid.

**Impact:** An unverified registrant can occupy another person's email address. If the real owner later signs in through Google and the records link, the earlier password remains an access path to that account. Existing sessions are also not revoked by linking. This is a high-priority account-security issue; Google email verification alone does not remove the earlier access path.

**Honest defense:** “Google verifies its sign-ins. Our password-registration ownership check and account-linking safeguards are incomplete.”

**Proposed fix:** Verify ownership before granting normal password-account access. Design linking to require appropriate ownership proof and remove unauthorized credentials and sessions; include a plan for existing unverified accounts. Test registration followed by legitimate Google ownership verification.

## 3. Password changes leave other sessions active

**Challenge:** “If somebody is already signed in to my account, does changing my password remove them?”

**Evidence:** [changePassword](../src/models/store.js) changes the hash and `must_change_password` flag. It does not revoke sessions or advance a credential/session version. The isolated check signed in two agents, changed the password in one, and successfully loaded the dashboard in the other afterward.

**Impact:** Changing a compromised password prevents future use of that password but does not immediately end existing access.

**Honest defense:** “The old password stops working for new logins. Revoking other active sessions on password change is currently missing.”

**Proposed fix:** Add account session invalidation on password change/reset, with deliberate treatment of the session performing the change. Include real-time connections in revocation behavior.

## 4. Duplicate feedback and limited abuse controls

**Challenge:** “What if I submit the same concern twice or repeatedly post comments?”

**Evidence:** [feedback submission](../src/routes/pages.js) and [submit/addComment](../src/models/store.js) have no per-submission idempotency key or dedicated account-level posting limit. Two concurrent identical feedback requests created two distinct records in the isolated database. The [app](../src/app.js) does have a general 500-requests-per-15-minutes IP limit; authentication and emergency reporting have additional controls.

**Impact:** Retries can create duplicate feedback; repeated comments or submissions can create moderation work within the general limit. One reaction per account does not mean one reaction per verified student.

**Honest defense:** “There is general request limiting, publication review, and comment moderation. Feedback retry deduplication and targeted posting limits need improvement.”

**Proposed fix:** Add server-enforced idempotency for feedback creation and account-level posting limits. Do not claim the system has no rate limiting.

## 5. Anonymity and publication have limits

**Challenge:** “Can administrators identify anonymous authors? Can a photo reveal the author after publication?”

**Evidence:** The [submission form](../views/student/submit.ejs) says the account remains linked. [private details](../views/partials/detail-content.ejs) show restricted author information to administrators. [public DTOs and publication](../src/models/store.js) hide the anonymous author's identity fields while publishing the original title, description and attachment. There is no separate redacted public version or per-submission publication-consent flag.

**Impact:** Anonymous means identity hidden from community readers, not administrators. Names inside text or images may identify a person despite the Anonymous label. Administrator review is the existing publication gate.

**Honest defense:** “Anonymity applies to the community display. Administrators retain ownership information, and reviewers must check identifying content before publication.”

**Proposed improvement:** Make visibility and administrator access explicit in the UI; consider author publication consent and a separate redacted public copy. This is a privacy/design limitation, not proof of a broken ownership check or a legal conclusion.

## 6. Incomplete audit trail for moderation and publication

**Challenge:** “Who hid this comment or published this complaint, and when?”

**Evidence:** [publish and moderateComment](../src/models/store.js) change current visibility. They do not record a complete actor/reason/action history. Unpublishing clears `published_at`. [schema](../schema.sql) contains status history, emergency history and settings history, but no equivalent moderation/publication event history.

**Impact:** Some administrative actions cannot be fully reconstructed from application records.

**Honest defense:** “Status changes and emergency actions have histories. Publication and comment moderation still need equivalent audit records.”

**Proposed fix:** Record actor, target, action, previous/new state, timestamp and an appropriate reason for each event. Do not claim that the whole application has no audit trail.

## 7. Email-domain acceptance does not establish campus membership

**Challenge:** “Can a person outside CSPC join and influence the feed?”

**Updated evidence (October 21):** [Affiliation classification](AFFILIATION.md) requires verified email ownership. Exact configured CSPC domains can choose a self-declared Student, Faculty or Staff affiliation; other verified domains become Visitors. Registration still has no roster check or administrator enrollment approval.

**Impact:** A student role represents application permissions, not verified enrollment. Multiple accounts can influence rankings despite the per-account unique reaction constraint.

**Honest defense:** “Roles control permissions. Our current registration does not certify CSPC enrollment.”

**Proposed improvement:** Choose and document an enrollment policy, such as verified institutional accounts or approved enrollment. Verify email ownership regardless of that policy.

## 8. Emergency alerts depend on an operating, monitored dashboard

**Challenge:** “Will help still arrive if the guard's browser is closed, audio is blocked, or the server is offline?”

**Evidence:** [emergency documentation](EMERGENCY-MODULE.md) identifies the module as a prototype. Escalation changes dashboard presentation and audit history; it does not contact another person or make a call. Standard browsers may block initial audio, and `tel:` links hand off to a device dialer. The default [host configuration](../src/config/env.js) binds to `127.0.0.1`, so another device cannot access the default localhost setup.

**Impact:** A successful report submission does not guarantee a human response. Operational deployment and mobile access require additional setup and acceptance testing.

**Honest defense:** “We can demonstrate report persistence, authorized guard alerts and status updates. This prototype does not guarantee dispatch or unattended delivery; verified official contact channels remain necessary.”

**Proposed improvement:** Establish monitoring and escalation procedures and test devices, network access, and failure behavior before operational use. Do not describe dashboard escalation as SMS, push delivery, or automatic calling.

## Other scope questions to prepare for

- **Student corrections/withdrawal:** There are no student feedback edit/withdraw routes. Record retention may be deliberate, but a correction/request process needs a defined workflow.
- **Professor access:** [Professor](../src/services/professor.js) receives the user's message and application instructions, not database records. Demonstrate navigation help; do not promise account-specific status lookup or official campus decisions. It depends on an external service.
- **Scale:** This review did not establish concurrent-user capacity or availability. Demonstration records and passing functional tests are not load-test evidence.

## What you can demonstrate in defense

The current fast suite covers private-record ownership checks, role authorization, CSRF rejection, escaped hostile text, image validation and protected attachments, password hashing, logout, public anonymity fields, and reaction rules. Demonstrate these with separate test accounts and non-sensitive sample records. Live Google login, actual email delivery and physical alarm audibility need their own demonstration; mock or unit tests do not establish those outcomes.

Fix priorities: email ownership and safe linking, recovery together with session revocation, then duplicate/abuse controls and administrative audit history. Keep claims about anonymity, enrollment, AI and emergency delivery within the actual implementation.
