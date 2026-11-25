# Login and email verification

Implemented October 21, 2026 (Asia/Manila). This update follows the revised login scope; campus approval and the broader feedback/emergency changes are deferred.

## Google sign-in

Continue with Google uses an authorization-code flow with session-bound state and PKCE. The backend verifies the returned ID token using Google's auth library: Google signature, audience, issuer and expiry are checked, followed by a strict `email_verified === true` check. The Google `sub` identifies the account. Browser-supplied email, role and account IDs are not accepted as identity proof.

A verified Google identity needs no CSPConnect OTP or administrator approval. Verified CSPC accounts with no saved affiliation first complete their profile; other verified domains become Visitors and enter the normal dashboard. New accounts always have regular permissions. Existing provisioned administrator/security roles remain subject to their server allowlists. See [affiliation classification](AFFILIATION.md).

If an email matches an existing password account without that Google identity, sign-in opens an explicit confirmation screen. It requires the current CSPConnect password, a confirmation checkbox, CSRF protection and the short-lived Google proof held in the same server session. No link is written before confirmation. Successful linking keeps the original user ID, feedback and profile; the unique email and Google-ID constraints prevent duplicate accounts. Expired proof or proof from another browser cannot link an account.

See [Google's backend verification guidance](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token).

## Regular registration

Registration details are staged with a bcrypt hash. No active user is created until the email code succeeds. Successful OTP verification signs the user in, then opens the one-time CSPC affiliation choice or automatically classifies other domains as Visitor and opens the dashboard. Subsequent password logins do not require another code.

| Setting | Value |
| --- | --- |
| Code | 6 digits, including leading zeros |
| Validity | 5 minutes |
| Attempts | 5 per issued code, enforced in MySQL |
| Resend cooldown | 60 seconds per email |
| Additional email limit | 5 sends per email per hour |
| Code storage | HMAC digest bound to a random challenge; no plaintext code in the database |
| Password storage | bcrypt, cost 12 |
| Delivery | Nodemailer; configured Gmail SMTP with TLS |

Resending invalidates the earlier code. Attempt counts survive page reloads and concurrent guesses. Failed SMTP delivery does not activate an account. Codes are not returned in the page or printed to logs.

New passwords require at least 12 characters and at most 72 UTF-8 bytes. The byte limit avoids bcrypt's input truncation; see [bcrypt's security notes](https://github.com/kelektiv/node.bcrypt.js#security-issues-and-concerns). Existing active accounts and their scrypt hashes remain usable. Pending password accounts activate only after an OTP; the resulting password uses bcrypt. Passwords over the new byte limit can be replaced through Forgot password.

## Existing installation

The login-only migration was applied after a verified database backup. Account IDs, existing password hashes, Google IDs, roles, feedback, publication state, comments, reactions and histories matched their pre-migration snapshots. The migration adds verification fields, versioned sessions and registration/token tables; it does not unpublish feedback or introduce campus approval.

Existing Google and already active email/password accounts remain directly usable, with no added OTP or approval gate. A separate compatibility flag preserves old activation without falsely marking an email as verified. New registrations require the OTP flow. Existing sessions need a fresh login. Password changes, successful recovery and explicit linking revoke prior sessions.

For another installation, back up the database, then run `npm.cmd run db:migrate-login`. The migration is repeatable. Fresh installations use the updated schema through `npm.cmd run db:setup`.

## Verification evidence

- All 90 automated tests passed, with no skips, including real MariaDB and local SMTP tests.
- Tests exercised expiry, five-attempt lockout, concurrent guesses, resend cooldown/replacement, one-time activation, bcrypt/legacy compatibility, direct Google access, explicit linking, forged identity fields, CSRF, expired/cross-session linking proof and SMTP failure.
- Google's actual JWT verifier was tested with signed test tokens, including altered signatures, wrong audience/issuer, expired tokens and unverified email claims. Provider exchange was stubbed in HTTP tests; a real Google account consent/login was not automated.
- The complete student/admin browser workflow passed, including OTP activation, mobile forms, recovery and existing feedback/community features. Screenshots: `docs/qa/email-verification-desktop.png` and `docs/qa/email-verification-mobile.png`.
- The configured Gmail SMTP connection passed TLS and authentication checks. No real verification email was sent during that connection check; real inbox delivery still needs a user registration attempt.
- Local evidence: `.local/login-tests.log`, `.local/login-migration-verification.json` and `docs/qa/workflow-verification.json`.

SMTP configuration stays in the existing private `.env`; it was not overwritten. Run `npm.cmd run email:verify` to check the connection without sending email.
