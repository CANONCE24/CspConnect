'use strict';
const CAMPUS_AFFILIATIONS = Object.freeze(['Student', 'Faculty', 'Staff']);
const AFFILIATIONS = Object.freeze([...CAMPUS_AFFILIATIONS, 'Visitor']);
function institutionalEmail(email, domains = []) {
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return false;
  const domain = email.trim().split('@')[1].toLowerCase();
  return domains.some(value => typeof value === 'string' && value.trim().toLowerCase() === domain);
}
function needsAffiliation(user, domains) {
  return Boolean(user?.email_verified_at && institutionalEmail(user.email, domains) &&
    (!CAMPUS_AFFILIATIONS.includes(user.affiliation) || user.affiliation_email?.toLowerCase() !== user.email.trim().toLowerCase()));
}
async function prepareAffiliation(store, user, domains) {
  if (!user?.email_verified_at || !store.ensureAffiliation) return user;
  const compatible = institutionalEmail(user.email, domains) ? CAMPUS_AFFILIATIONS.includes(user.affiliation) : user.affiliation === 'Visitor';
  if (compatible && user.affiliation_email?.toLowerCase() === user.email.trim().toLowerCase()) return user;
  return {...user, ...await store.ensureAffiliation(user.id, domains)};
}
function dashboardFor(user) {
  return user.role === 'admin' ? '/admin' : user.role === 'security' ? '/security' : '/dashboard';
}
function destinationFor(user, req, domains) {
  if (user.must_change_password) return '/account/password';
  if (needsAffiliation(user, domains)) return '/complete-profile';
  const target = req.session.returnTo;
  delete req.session.returnTo;
  return user.role === 'student' && typeof target === 'string' && /^\/feedback\/[1-9]\d{0,14}$/.test(target) ? target : dashboardFor(user);
}
module.exports = {CAMPUS_AFFILIATIONS, AFFILIATIONS, institutionalEmail, needsAffiliation, prepareAffiliation, dashboardFor, destinationFor};
