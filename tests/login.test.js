'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {OAuth2Client}=require('google-auth-library');
const {createGoogleVerifier}=require('../src/services/google-identity');
const {createHash,verifyPassword}=require('../src/services/passwords');
test('Google verification checks the signed token, issuer, audience, expiry and verified-email claim',async()=>{
  const {privateKey,publicKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
  const client=new OAuth2Client('cspconnect-test-client');
  client.getFederatedSignonCertsAsync=async()=>({certs:{test:publicKey.export({type:'spki',format:'pem'})},format:'PEM'});
  const now=Math.floor(Date.now()/1000);
  const base={iss:'https://accounts.google.com',aud:'cspconnect-test-client',sub:'verified-google-subject',email:'student@gmail.com',email_verified:true,iat:now,exp:now+3600};
  function token(changes={}){const data=Buffer.from(JSON.stringify({alg:'RS256',kid:'test'})).toString('base64url')+'.'+Buffer.from(JSON.stringify({...base,...changes})).toString('base64url');return data+'.'+crypto.sign('RSA-SHA256',Buffer.from(data),privateKey).toString('base64url');}
  const verify=createGoogleVerifier('cspconnect-test-client',client);
  assert.equal((await verify(token())).sub,base.sub);
  for(const invalid of [{aud:'another-app'},{iss:'https://attacker.example'},{iat:now-7200,exp:now-3600},{email_verified:false},{sub:''}])await assert.rejects(verify(token(invalid)));
  const parts=token().split('.');parts[1]=Buffer.from(JSON.stringify({...base,email:'forged@gmail.com'})).toString('base64url');await assert.rejects(verify(parts.join('.')));
  await assert.rejects(verify(''));await assert.rejects(verify('frontend-email-is-not-a-token'));
});
test('new passwords use bcrypt without silently truncating multibyte passwords; legacy scrypt still verifies',async()=>{
  const password='A-strong-CSPConnect-password!';const hash=await createHash(password);
  assert.match(hash,/^\$2b\$12\$/);assert.equal(await verifyPassword(password,hash),true);assert.equal(await verifyPassword('Incorrect-password!',hash),false);
  await assert.rejects(createHash('a'.repeat(73)));await assert.rejects(createHash('学'.repeat(25)));
  const salt=crypto.randomBytes(16);const key=crypto.scryptSync(password,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024});
  const legacy=`scrypt$32768$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`;assert.equal(await verifyPassword(password,legacy),true);
});
