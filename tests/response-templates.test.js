'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TYPES, STATUSES } = require('../src/utils/constants');
const { responseFor, templatesFor, validateUpdate } = require('../src/services/responseTemplates');

test('local response templates use actual feedback details for every existing type and status', () => {
  for (const type of TYPES) {
    const feedback = { title:'Improve classroom ventilation',category_name:'Campus Facilities',reference:'FB-2026-00001',type };
    assert.deepEqual(Object.keys(templatesFor(feedback)), STATUSES);
    for (const status of STATUSES) {
      const draft = responseFor(feedback,status);
      for (const value of [feedback.title,feedback.category_name,feedback.reference,status]) assert.ok(draft.includes(value));
      assert.ok(draft.length < 3000);
      if (status === 'Resolved') assert.match(draft,/\{\{actionTaken\}\}/);
      else if (status === 'Closed') assert.match(draft,/\{\{closureReason\}\}/);
      else assert.doesNotMatch(draft,/repaired|installed|completed|rejected|resolved/i);
    }
  }
});
test('approval validates methods, final responses, actual resolutions and closure reasons', () => {
  const base = { confirmed:true,response:'The administration is evaluating your submission.' };
  for (const method of ['web','email','both']) assert.equal(validateUpdate('Under Review',{...base,notificationMethod:method},{requireApproval:true}).notificationMethod,method);
  for (const method of ['invalid','__proto__',['both'],null,{}]) assert.throws(()=>validateUpdate('Under Review',{...base,notificationMethod:method}),{status:422});
  for (const input of [{response:base.response},{...base,response:''},{...base,response:['invalid']},{...base,response:'x'.repeat(5001)},{...base,response:'Action: {{actionTaken}}'}]) assert.throws(()=>validateUpdate('Under Review',input,{requireApproval:true}),{status:422});
  assert.throws(()=>validateUpdate('Resolved',base),{status:422});
  assert.throws(()=>validateUpdate('Resolved',{...base,actionTaken:'The ventilation has been repaired and checked.'}),{status:422});
  assert.equal(validateUpdate('Resolved',{...base,actionTaken:'The ventilation has been repaired and checked.',actionConfirmed:true}).actionTaken,'The ventilation has been repaired and checked.');
  assert.throws(()=>validateUpdate('Closed',base),{status:422});
  assert.equal(validateUpdate('Closed',{...base,closureReason:'The submission duplicates an existing request.'}).closureReason,'The submission duplicates an existing request.');
});
