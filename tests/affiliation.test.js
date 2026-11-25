'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {institutionalEmail, needsAffiliation} = require('../src/services/affiliation');
const domains = ['cspc.edu.ph', 'my.cspc.edu.ph'];
test('institutional affiliation uses exact case-insensitive configured domains', () => {
  for (const email of [' student@cspc.edu.ph ', 'FACULTY@MY.CSPC.EDU.PH']) assert.equal(institutionalEmail(email,domains),true);
  for (const email of ['student@cspc.edu.ph.attacker.com','student@fakecspc.edu.ph','student@dept.cspc.edu.ph',
    'cspc.edu.ph@gmail.com','student@gmail.com','student@yahoo.com','student@outlook.com','a@@cspc.edu.ph',null,{},'']) {
    assert.equal(institutionalEmail(email,domains),false, String(email));
  }
  assert.equal(institutionalEmail('user@other.edu', ['OTHER.EDU']),true);
});
test('profile completion requires verified ownership and a saved affiliation for the current email', () => {
  const user = {email:'student@my.cspc.edu.ph'};
  assert.equal(needsAffiliation(user,domains),false);
  user.email_verified_at = new Date();
  assert.equal(needsAffiliation(user,domains),true);
  Object.assign(user,{affiliation:'Faculty',affiliation_email:user.email});
  assert.equal(needsAffiliation(user,domains),false);
  user.email = 'changed@cspc.edu.ph';
  assert.equal(needsAffiliation(user,domains),true);
  user.email = 'visitor@outlook.com';
  assert.equal(needsAffiliation(user,domains),false);
});
