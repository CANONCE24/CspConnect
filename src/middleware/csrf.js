'use strict';
const crypto = require('node:crypto');
function csrf(req, res, next) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  res.locals.csrfToken = req.session.csrfToken;
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const queryToken = ['/feedback', '/account/profile'].includes(req.path) && req.is('multipart/form-data') ? req.query._csrf : undefined;
  const supplied = req.get('X-CSRF-Token') || req.body?._csrf || queryToken;
  const expected = req.session.csrfToken;
  if (typeof supplied !== 'string' || Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
      !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    const error = new Error('Your form session expired. Refresh the page and try again.');
    error.status = 403; return next(error);
  }
  next();
}
module.exports = { csrf };
