'use strict';
const { buildFeedbackEmail, createEmailTransport } = require('./feedback-email');
function classifyError(error) {
  const code = String(error.code || 'SMTPError').replace(/[^A-Za-z0-9_-]/g,'').slice(0,40) || 'SMTPError';
  const response = Number(error.responseCode);
  if (response >= 400 && response < 500) return { temporary: true, errorCode: 'SMTP' + response };
  if (response >= 500) return { errorCode: 'SMTP' + response };
  if (['InvalidRecipient','InvalidPayload','InvalidConfiguration','EAUTH','EENVELOPE','RecipientRejected'].includes(code)) return { errorCode: code };
  if (['ECONNREFUSED','ENOTFOUND','EAI_AGAIN'].includes(code) || ['CONN','GREETING','EHLO','HELO','STARTTLS','AUTH','MAIL FROM','RCPT TO'].includes(error.command)) return { temporary: true, errorCode: code };
  // A connection lost during/after DATA may already have handed off the message.
  return { unconfirmed: true, errorCode: 'DeliveryUnconfirmed' };
}
function createEmailWorker({ outbox, config, transport = createEmailTransport(config), intervalMs = 5000, logger = console }) {
  let busy = false, stopped = false, timer;
  async function tick() {
    if (busy || stopped || !transport) return false;
    busy = true;
    try {
      await outbox.recover();
      const item = await outbox.claim(); if (!item) return false;
      let result, sending = false;
      try {
        const message = await buildFeedbackEmail(item, config);
        sending = true;
        const info = await transport.sendMail(message);
        if (!Array.isArray(info.accepted) || !info.accepted.some(address => String(address).toLowerCase() === item.recipient.toLowerCase())) throw Object.assign(new Error('Recipient rejected.'), { code: 'RecipientRejected' });
        result = { accepted: true };
      } catch (error) { result = sending ? classifyError(error) : { errorCode: ['InvalidRecipient','InvalidConfiguration'].includes(error.code) ? error.code : 'InvalidPayload' }; }
      // Database failure after SMTP handoff leaves the lease unconfirmed; never guess "delivered".
      await outbox.finish(item, result); return true;
    } catch (error) { logger.error('Feedback email worker unavailable:', error.code || error.name); return false; }
    finally { busy = false; }
  }
  function start() { if (!timer && transport) { timer = setInterval(() => void tick(), intervalMs); timer.unref(); void tick(); } }
  async function stop() { stopped = true; clearInterval(timer); while (busy) await new Promise(resolve => setTimeout(resolve, 50)); transport?.close?.(); }
  return { tick, start, stop, enabled: Boolean(transport) };
}
module.exports = { createEmailWorker, classifyError };
