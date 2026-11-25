'use strict';
const {OAuth2Client}=require('google-auth-library');
function createGoogleVerifier(clientId,client=new OAuth2Client(clientId)){
  return async token=>{
    if(typeof token!=='string'||!token)throw new Error('Google did not supply an ID token.');
    const ticket=await client.verifyIdToken({idToken:token,audience:clientId});
    const payload=ticket.getPayload();
    if(!payload || typeof payload.sub!=='string' || !payload.sub || payload.sub.length>191 || typeof payload.email!=='string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email) || payload.email_verified!==true)throw new Error('Google email is not verified.');
    return payload;
  };
}
module.exports={createGoogleVerifier};
