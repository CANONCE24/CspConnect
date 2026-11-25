'use strict';
const path = require('node:path');
const ejs = require('ejs');
const nodemailer = require('nodemailer');
const { validEmail } = require('./feedback-status');
const { STATUSES } = require('../utils/constants');
const SUBJECTS = {
  Acknowledged: 'CSPConnect — Your Feedback Has Been Acknowledged',
  Resolved: 'CSPConnect — Your Feedback Has Been Resolved',
  StatusUpdated: 'CSPConnect \u2014 Your Feedback Status Has Been Updated',
  Rejected: 'CSPConnect — Update Regarding Your Submission'
};
function emailConfigured(config) {
  const local = config.nodeEnv !== 'production' && config.smtpAllowInsecureLocal && ['127.0.0.1','localhost','::1'].includes(config.smtpHost);
  return Boolean(config.smtpEnabled && config.smtpHost && validEmail(config.smtpFrom) && Number.isInteger(config.smtpPort) && config.smtpPort > 0 && config.smtpPort < 65536 && (local || (config.smtpUser && config.smtpPassword)));
}
function createEmailTransport(config) {
  if (!emailConfigured(config)) return null;
  const local = config.nodeEnv !== 'production' && config.smtpAllowInsecureLocal && ['127.0.0.1','localhost','::1'].includes(config.smtpHost);
  return nodemailer.createTransport({ host: config.smtpHost, port: config.smtpPort, secure: Boolean(config.smtpSecure),
    requireTLS: !config.smtpSecure && !local, auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPassword } : undefined,
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 30000,
    disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false
  });
}
async function buildFeedbackEmail(notification, config) {
  if (!validEmail(notification.recipient) || !SUBJECTS[notification.kind]) throw Object.assign(new Error('Invalid email notification.'), { code: 'InvalidRecipient' });
  const data = typeof notification.payload_json === 'string' ? JSON.parse(notification.payload_json) : notification.payload_json;
  if (!data || typeof data.name !== 'string' || typeof data.title !== 'string' || !Number.isSafeInteger(data.feedbackId) || data.feedbackId < 1) throw Object.assign(new Error('Invalid notification snapshot.'), { code: 'InvalidPayload' });
  const link = new URL('/feedback/' + data.feedbackId, config.appUrl);
  if (!['http:','https:'].includes(link.protocol)) throw Object.assign(new Error('Invalid application URL.'), { code: 'InvalidConfiguration' });
  const sections = [];
  if (notification.kind === 'Acknowledged') sections.push(
    { text: 'Thank you for sharing your feedback through CSPConnect.' },
    { text: `We would like to inform you that your submission titled "${data.title}" has been acknowledged by the administration.` },
    { text: 'Your feedback will be reviewed accordingly.' },
    { text: 'We appreciate your participation in helping improve our campus.' }
  );
  if (notification.kind === 'Resolved') {
    if (typeof data.summary !== 'string' || !data.summary.trim()) throw Object.assign(new Error('Missing resolution summary.'), { code: 'InvalidPayload' });
    sections.push({ text: `We are pleased to inform you that your feedback titled "${data.title}" has been marked as resolved.` }, { label: 'Action Taken', text: data.summary });
    if (data.additionalMessage) sections.push({ label: 'Message from the Administration', text: data.additionalMessage });
    sections.push({ text: 'Thank you for taking the initiative to help improve our campus.' }, { text: 'Your voice matters, and your participation contributes to creating a better environment for the CSPC community.' });
  }
  if (notification.kind === 'Rejected') {
    if (typeof data.rejectionReason !== 'string' || !data.rejectionReason.trim()) throw Object.assign(new Error('Missing rejection reason.'), { code: 'InvalidPayload' });
    sections.push({ text: `Thank you for submitting your feedback titled "${data.title}".` }, { text: 'Your submission has been marked as closed by the administration.' }, { label: 'Reason', text: data.rejectionReason }, { text: 'We appreciate your willingness to share your ideas and encourage you to continue participating in CSPConnect.' });
  }
  if (notification.kind === 'StatusUpdated') {
    if (!STATUSES.includes(data.status) || (data.response != null && typeof data.response !== 'string')) throw Object.assign(new Error('Invalid feedback update.'), { code: 'InvalidPayload' });
    const descriptions = {Submitted:'has been moved back to Submitted', 'Under Review':'is now under review', 'In Progress':'is now in progress', Resolved:'has been marked as resolved', Closed:'has been closed'};
    sections.push({text: data.statusChanged === false
      ? `The administration has added a response to your feedback titled "${data.title}".`
      : `Your feedback titled "${data.title}" ${descriptions[data.status]}.`}, {label:'Status',text:data.status});
    if (data.response && !data.concise) sections.push({label:'Response from the Administration',text:data.response});
    if (data.concise) sections.push({text:'Open My Feedback using the link below to read the full approved administrator response and update history.'});
    sections.push({text: data.status === 'Resolved' ? 'Thank you for helping improve our campus. Your voice matters to the CSPC community.' : 'Thank you for sharing your feedback through CSPConnect.'});
  }
  const subject = notification.kind === 'StatusUpdated' && data.statusChanged === false ? 'CSPConnect \u2014 Response to Your Feedback' : SUBJECTS[notification.kind];
  const text = [`Hello ${data.name},`, ...sections.map(section => (section.label ? section.label + ':\n' : '') + section.text), `View your submission: ${link.href}\nSign in using the account that submitted this feedback.`, 'CSPConnect Team\nConnecting Voices, Creating Change.'].join('\n\n');
  const html = await ejs.renderFile(path.join(__dirname, '../../views/email/feedback.ejs'), { name: data.name, subject, kind: notification.kind, status: data.status, reference: data.reference, sections, link: link.href });
  return { from: { name: config.smtpFromName || 'CSPConnect Team', address: config.smtpFrom }, to: notification.recipient, subject, text, html,
    messageId: `<feedback-${notification.id}@${config.smtpFrom.split('@')[1]}>`, disableFileAccess: true, disableUrlAccess: true };
}
module.exports = { SUBJECTS, emailConfigured, createEmailTransport, buildFeedbackEmail };
