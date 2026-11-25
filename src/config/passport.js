'use strict';
const { Passport } = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;

function configurePassport(store, config,options={}) {
  const passport = new Passport();
  passport.serializeUser((user, done) => done(null, {id:user.id,version:Number(user.session_version || 0)}));
  passport.deserializeUser((identity, done) => {
    if (!identity || typeof identity !== 'object') return done(null,false);
    store.getUser(identity.id).then(async user => {
      if (!user) return done(null, false);
      if (Number(user.session_version || 0)!==identity.version) return done(null,false);
      // Re-evaluate the server allowlist on every request, including existing sessions.
      const role = require('../utils/emergency').roleFor(user, config);
      // Keep model authorization consistent with a session that has lost admin access.
      if (role !== user.role) await store.syncAccountRole(user.id, role);
      done(null, { ...user, role });
    }).catch(done);
  });
  if (config.googleClientId && config.googleClientSecret) {
    const verifyToken=options.verifyGoogleToken || require('../services/google-identity').createGoogleVerifier(config.googleClientId);
    passport.use(new GoogleStrategy({
      clientID: config.googleClientId, clientSecret: config.googleClientSecret,
      callbackURL: config.googleCallbackUrl, state: true,pkce:true,skipUserProfile:true
    }, async (_accessToken, _refreshToken, params,_profile, done) => {
      try {
        const payload=await verifyToken(params?.id_token);
        const email=payload.email?.trim().toLowerCase();
        if(typeof email !== 'string' || email.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || payload.email_verified!==true || !payload.sub)return done(null,false,{message:'A verified Google email is required.'});
        const profile={id:payload.sub,displayName:payload.name || email.split('@')[0],emails:[{value:email,verified:true}],photos:payload.picture?[{value:payload.picture}]:[],_json:{email_verified:true}};
        const result=await store.upsertGoogleUser(profile, config.adminEmails, config.securityEmails || []);
        if(result.requiresLink)return done(null,false,{pendingGoogleLink:{accountId:result.accountId,googleId:payload.sub,email}});
        done(null,result);
      } catch (error) { console.error('Google identity verification failed:',error.code || error.name);done(null,false,{message:'Google sign-in could not be verified. Please try again.'}); }
    }));
  }
  return passport;
}
module.exports = { configurePassport };
