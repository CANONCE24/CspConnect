'use strict';
function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Sign in to continue.' });
  if (req.method === 'GET' && /^\/feedback\/[1-9]\d{0,14}$/.test(req.path)) req.session.returnTo = req.path;
  return res.redirect('/login');
}
function requireRole(role) {
  return (req, res, next) => requireAuth(req, res, () => {
    if (req.user.role === role) return next();
    const error = new Error('You do not have access to this page.'); error.status = 403; next(error);
  });
}
module.exports = { requireAuth, requireStudent: requireRole('student'), requireAdmin: requireRole('admin'), requireSecurity: requireRole('security') };
