'use strict';
const { STATUSES, TYPES } = require('../utils/constants');
const { bounded, httpError } = require('../utils/validation');
const METHODS = { web: 'Web Only', email: 'Email Only', both: 'Both' };
function responseFor(feedback, status) {
  if (!STATUSES.includes(status)) throw httpError(422, 'Choose a valid status.');
  const type = TYPES.includes(feedback.type) ? feedback.type.toLowerCase() : 'feedback';
  const opening = feedback.type === 'Appreciation' ? 'Thank you for recognizing the efforts of our campus community.' : 'Thank you for sharing your ' + type + ' with CSPConnect.';
  const subject = `Regarding “${feedback.title}” in ${feedback.category_name} (Reference: ${feedback.reference}):`;
  const messages = {
    Submitted: 'Your submission is recorded as Submitted. You can follow its status and any administrator responses in My Feedback.',
    'Under Review': 'Your submission is now Under Review. The administration is evaluating the information you provided. Any confirmed next steps will be recorded in My Feedback.',
    'In Progress': 'Your submission is now marked In Progress. Please check My Feedback for confirmed progress updates and further information from the administration.',
    Resolved: 'Your submission has been marked Resolved.\n\nAction taken: {{actionTaken}}\n\nThank you for helping improve our campus. If you have further concerns, please submit feedback with this reference number.',
    Closed: 'Your submission has been marked Closed.\n\nReason for closing: {{closureReason}}\n\nThank you for taking the time to share your feedback. You can refer to this record in My Feedback.'
  };
  return `${opening}\n\n${subject}\n\n${messages[status]}`;
}
function templatesFor(feedback) { return Object.fromEntries(STATUSES.map(status => [status, responseFor(feedback, status)])); }
function validateUpdate(status, input, { requireApproval = false } = {}) {
  if (!STATUSES.includes(status)) throw httpError(422, 'Choose a valid status.');
  const notificationMethod = input.notificationMethod === undefined ? 'both' : input.notificationMethod;
  if (typeof notificationMethod !== 'string' || !Object.hasOwn(METHODS, notificationMethod)) throw httpError(422, 'Choose Web Only, Email Only, or Both.');
  if (requireApproval && input.confirmed !== true) throw httpError(422, 'Review and confirm the update before notifying the student.');
  if (input.response !== undefined && typeof input.response !== 'string') throw httpError(422, 'Enter a valid response.');
  const response = input.response?.trim() ? bounded(input.response, 'Response', 1, 5000) : null;
  if (requireApproval && !response) throw httpError(422, 'Review or enter a response to the student.');
  if (response && /\{\{(?:actionTaken|closureReason)\}\}/.test(response)) throw httpError(422, 'Replace the action or closure placeholder with the actual details before approving.');
  const actionTaken = status === 'Resolved' ? bounded(input.actionTaken, 'Actual action taken', 10, 2000) : null;
  const closureReason = status === 'Closed' ? bounded(input.closureReason, 'Reason for closing', 10, 2000) : null;
  if (status === 'Resolved' && input.actionConfirmed !== true) throw httpError(422, 'Confirm that the action taken describes work that was actually completed.');
  return { response, notificationMethod, actionTaken, closureReason };
}
module.exports = { METHODS, responseFor, templatesFor, validateUpdate };
