'use strict';
const {CAMPUS_AFFILIATIONS, institutionalEmail} = require('../services/affiliation');
const failure = (message, status) => Object.assign(new Error(message), {status});
function createAffiliationStore(pool) {
  // Lock the authoritative email and verification state, including concurrent profile requests.
  async function ensureAffiliation(userId, domains, choice) {
    if (choice !== undefined && !CAMPUS_AFFILIATIONS.includes(choice)) throw failure('Choose Student, Faculty, or Staff.', 422);
    const db = await pool.getConnection();
    try {
      await db.beginTransaction();
      const [[user]] = await db.execute('SELECT id,email,email_verified_at,affiliation,affiliation_email FROM users WHERE id=? FOR UPDATE', [userId]);
      if (!user) throw failure('Account was not found.', 404);
      if (!user.email_verified_at) {
        if (choice !== undefined) throw failure('Verify your email before choosing an affiliation.', 403);
        await db.commit();
        return user;
      }
      const email = user.email.trim().toLowerCase();
      const campus = institutionalEmail(email, domains);
      if (choice !== undefined && !campus) throw failure('Affiliation selection requires a verified CSPC email.', 403);
      const sameEmail = user.affiliation_email?.toLowerCase() === email;
      const compatible = campus ? CAMPUS_AFFILIATIONS.includes(user.affiliation) : user.affiliation === 'Visitor';
      // Retain a valid existing value. A changed email must be classified again.
      let affiliation = compatible && (sameEmail || !user.affiliation_email) ? user.affiliation : campus ? null : 'Visitor';
      if (choice !== undefined) {
        if (affiliation && affiliation !== choice) throw failure('Your affiliation has already been saved.', 409);
        affiliation = choice;
      }
      const affiliationEmail = affiliation ? email : null;
      if (user.affiliation !== affiliation || user.affiliation_email !== affiliationEmail) {
        await db.execute('UPDATE users SET affiliation=?,affiliation_email=? WHERE id=?', [affiliation, affiliationEmail, userId]);
      }
      await db.commit();
      return {...user, affiliation, affiliation_email: affiliationEmail};
    } catch (error) {
      await db.rollback();
      throw error;
    } finally { db.release(); }
  }
  return {ensureAffiliation};
}
module.exports = {createAffiliationStore};
