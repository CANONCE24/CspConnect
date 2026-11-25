'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { validEmail } = require('../src/services/feedback-status');
const { buildFeedbackEmail, emailConfigured, createEmailTransport } = require('../src/services/feedback-email');
const { createEmailWorker, classifyError } = require('../src/services/email-worker');
const config = { appUrl: 'https://cspconnect.example.test', smtpFrom: 'notifications@example.test', smtpFromName: 'CSPConnect Team' };
const notification = kind => ({ id: randomUUID(), recipient: 'student@example.test', kind, payload_json: JSON.stringify({ name: 'Test <Student>', title: '<script>alert(1)</script>', reference: 'FB-2026-00001', feedbackId: 1, status: 'In Progress', response: 'A private response <script>test</script>', statusChanged: true, summary: 'Installed new equipment & completed repairs.', additionalMessage: 'Thank you for your patience.', rejectionReason: 'The requested change cannot proceed this term.' }) });
test('email templates contain text/HTML alternatives, escaped content, secure links, and appreciation', async () => {
  for (const kind of ['Acknowledged','Resolved','Rejected','StatusUpdated']) {
    const item = notification(kind); const message = await buildFeedbackEmail(item, config);
    assert.ok(message.subject.startsWith('CSPConnect —'));
    assert.ok(message.text.includes('CSPConnect Team'));
    assert.ok(message.text.includes('Connecting Voices, Creating Change.'));
    assert.ok(message.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(!message.html.includes('<script>'));
    assert.ok(message.html.includes('https://cspconnect.example.test/feedback/1'));
    assert.ok(!message.html.includes('/community/'));
    assert.equal(message.messageId, (await buildFeedbackEmail(item, config)).messageId);
    if (kind === 'Resolved') { assert.match(message.text, /Action Taken/); assert.match(message.text, /Your voice matters/); }
    if (kind === 'Rejected') assert.match(message.text, /Reason:/);
  }
  await assert.rejects(buildFeedbackEmail({ ...notification('Resolved'), recipient: 'bad\r\nBcc:attacker@example.test' }, config));
});
test('recipient validation and safe SMTP configuration', () => {
  for (const email of ['',null,'bad','x@example','a..b@example.test','.x@example.test','x@bad..test','x@-bad.test','x@example.test\r\n']) assert.equal(validEmail(email), false, String(email));
  assert.equal(validEmail('student+campus@example.test'), true);
  assert.equal(emailConfigured(config), false); assert.equal(createEmailTransport(config), null);
  assert.equal(emailConfigured({ ...config,smtpEnabled:true,smtpHost:'127.0.0.1',smtpPort:1025,smtpAllowInsecureLocal:true,nodeEnv:'development' }), true);
  assert.equal(emailConfigured({ ...config,smtpEnabled:true,smtpHost:'remote.example.test',smtpPort:1025,smtpAllowInsecureLocal:true,nodeEnv:'development' }), false);
});
test('worker distinguishes temporary SMTP failure, permanent rejection, and ambiguous handoff', () => {
  assert.equal(classifyError({ responseCode:451 }).temporary, true);
  assert.equal(classifyError({ responseCode:550 }).errorCode, 'SMTP550');
  assert.equal(classifyError({ code:'ECONNREFUSED' }).temporary, true);
  assert.equal(classifyError({ code:'ETIMEDOUT',command:'DATA' }).unconfirmed, true);
});
test('disabled worker does not claim queued emails; an accepted message is not labeled delivered', async () => {
  let claims = 0, finished;
  const outbox = { async recover(){},async claim(){claims++;return notification('Acknowledged');},async finish(_row,result){finished=result;} };
  const disabled = createEmailWorker({outbox,config,transport:null}); await disabled.tick(); assert.equal(claims, 0);
  const worker = createEmailWorker({outbox,config,transport:{async sendMail(){return {accepted:['student@example.test']};}}});
  await worker.tick(); assert.deepEqual(finished,{accepted:true}); await worker.stop();
});
