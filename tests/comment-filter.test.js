'use strict';
const { test }=require('node:test');
const assert=require('node:assert/strict');
const { scanComment,createCommentFilter }=require('../src/services/comment-filter');
test('English and Filipino signals match boundaries, case, accents, leetspeak and simple disguises',()=>{
  for(const text of ['FUCK','f.u.c.k','f**k','sh1t','P U T A N G I N A','p*tang ina','T@NG1N@','g4g0','gágo','pakyu','b0b0','kill yourself','sana mamatay ka','women are inferior'])assert.equal(scanComment(text).flagged,true,text);
  for(const text of ['Please improve classroom ventilation.','Salamat sa tulong!','Assignment for our class.','Scunthorpe campus','Students who identify as bakla deserve respect.','https://cspc.edu.ph/','https://example.com/help','I disagree with this proposal.'])assert.equal(scanComment(text).flagged,false,text);
});
test('spam and link heuristics prioritize review without hiding all links',()=>{
  for(const text of ['http://bit.ly/test','https://example.xyz','https://safe.ph@evil.com/','http://127.0.0.1/file','https://example.com/file.exe','javascript:alert(1)','https://example.com https://example.org https://cspc.edu.ph','click here to win','aaaaaaaaaaaaaaaa'])assert.equal(scanComment(text).flagged,true,text);
  assert.match(scanComment('Please improve the library',[{body:'PLEASE improve the library!'}]).reasons.join(' '),/Repeated comment/);
  assert.equal(scanComment('🙂',[{body:'👍'}]).flagged,false);
  assert.equal(scanComment('p'+'*'.repeat(498)+'x').flagged,false);
  const custom=createCommentFilter({profanity:['customword'],repeatWindowMinutes:15});
  assert.equal(custom('customword').flagged,true);assert.equal(custom('ordinary feedback').flagged,false);
});
