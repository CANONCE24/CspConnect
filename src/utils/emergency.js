'use strict';
const { randomUUID } = require('node:crypto');
const TYPES = ['Medical', 'Fire', 'Accident', 'Security Threat', 'Other'];
const STATUSES = ['Submitted', 'Acknowledged', 'Responding', 'Resolved'];
function fail(status, message) { const error = new Error(message); error.status = status; throw error; }
function text(value, label, min, max) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) fail(422, `${label} must contain ${min}–${max} characters.`);
  return value.trim();
}
function phone(value) {
  if (typeof value !== 'string' || !/^\+?[\d ()-]{7,25}$/.test(value.trim())) return null;
  const normalized = value.trim().replace(/[ ()-]/g, '');
  return /^\+?[1-9]\d{6,14}$/.test(normalized) || /^0\d{7,14}$/.test(normalized) ? normalized : null;
}
function reportInput(input) {
  if (!TYPES.includes(input.type)) fail(422, 'Choose an emergency type.');
  const contact = input.contact_number === undefined || input.contact_number === '' ? null : phone(input.contact_number);
  if (input.contact_number && !contact) fail(422, 'Enter a valid contact number or leave it blank.');
  if (!isId(input.request_key)) fail(422, 'Refresh the form before submitting.');
  return { type: input.type, location: text(input.location, 'Location', 2, 200), description: text(input.description, 'Description', 5, 2000), contact_number: contact, request_key: input.request_key };
}
function isId(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function roleFor(user, config) {
  const email = user.email.toLowerCase();
  if (config.adminEmails.includes(email)) return user.role === 'admin' ? 'admin' : 'student';
  return user.role === 'security' && (config.securityEmails || []).includes(email) ? 'security' : 'student';
}
function settingsInput(input) {
  const number = input.guardhouse_number ? phone(input.guardhouse_number) : '';
  if (input.guardhouse_number && !number) fail(422, 'The guardhouse number is invalid. Use 7–15 digits, optionally with a leading +.');
  const minutes = Number(input.escalation_minutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120) fail(422, 'Escalation must be between 1 and 120 minutes.');
  return { guardhouse_number: number, number_verified: Boolean(number) && ['1', true].includes(input.number_verified), escalation_minutes: minutes };
}
module.exports = { TYPES, STATUSES, fail, phone, reportInput, settingsInput, isId, roleFor, randomUUID };
