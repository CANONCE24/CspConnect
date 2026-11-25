'use strict';
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function id(value) {
  const s = String(value ?? '');
  if (!/^[1-9]\d{0,14}$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}
function bounded(value, name, min, max) {
  const result = text(value);
  if ([...result].length < min || [...result].length > max) {
    const err = new Error(name + ' must contain ' + min + '–' + max + ' characters.');
    err.status = 422; throw err;
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(result)) {
    const err = new Error(name + ' contains invalid control characters.'); err.status = 422; throw err;
  }
  return result;
}
function httpError(status, message) { const err = new Error(message); err.status = status; return err; }
module.exports = { text, id, bounded, httpError };
