'use strict';
const crypto=require('node:crypto');
const express=require('express');
const {rateLimit}=require('express-rate-limit');
const {createHash,verifyPassword}=require('../services/passwords');
const {destinationFor,prepareAffiliation}=require('../services/affiliation');
const MIN_PASSWORD_LENGTH=12,MAX_PASSWORD_BYTES=72;
const EMAIL_PATTERN=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normalizedEmail=value=>typeof value==='string'?value.trim().toLowerCase():'';
const validPassword=value=>typeof value==='string' && [...value].length>=MIN_PASSWORD_LENGTH && Buffer.byteLength(value,'utf8')<=MAX_PASSWORD_BYTES;
const flash=(req,type,message)=>{req.session.flash={type,message};};

function authRoutes(passport,config,store,security,sendAccountEmail,verification,sendCode){
  const router=express.Router();
  const googleEnabled=Boolean(config.googleClientId&&config.googleClientSecret);
  const attemptLimit=rateLimit({windowMs:15*60*1000,limit:10,standardHeaders:'draft-8',legacyHeaders:false,message:'Too many sign-in attempts. Wait a few minutes and try again.'});
  const codeLimit=rateLimit({windowMs:15*60*1000,limit:30,standardHeaders:'draft-8',legacyHeaders:false,message:'Too many verification requests. Please try again later.'});
  const resetLimit=rateLimit({windowMs:15*60*1000,limit:10,standardHeaders:'draft-8',legacyHeaders:false,message:'Too many recovery requests. Please try again later.'});
  function redirectFor(user,req){
    return destinationFor(user,req,config.cspcEmailDomains);
  }
  async function signIn(req,res,next,user){
    try { user=await prepareAffiliation(store,user,config.cspcEmailDomains); }
    catch(error) { return next(error); }
    req.logIn(user,{keepSessionInfo:true},error=>{
      if(error)return next(error);
      delete req.session.pendingGoogleLink;delete req.session.pendingRegistration;
      req.session.csrfToken=crypto.randomBytes(32).toString('hex');
      res.redirect(user.must_change_password?'/account/password':redirectFor(user,req));
    });
  }
  async function showCode(req,res,message=null,status=200){
    const row=await verification.status(req.session.pendingRegistration);
    if(!row){flash(req,'error','Start registration or sign in with your email to request a verification code.');return res.redirect('/signup');}
    return res.status(status).render('auth/verify-code',{title:'Verify your email',active:'',flash:null,email:row.email,message,
      hasError:status>=400,remaining:Math.max(0,5-row.attempts),expiresAt:row.expires_at,resendSeconds:Math.max(0,Math.ceil((new Date(row.sent_at).getTime()+60000-Date.now())/1000))});
  }
  async function deliverCode(req,item){
    req.session.pendingRegistration=item.challenge;
    try{await sendCode(item);}
    catch(error){console.error('Verification email unavailable:',error.code||error.name);throw Object.assign(new Error('We could not send the code. Please try Resend after the cooldown.'),{status:503});}
  }
  router.get('/login',(req,res)=>{
    if(req.isAuthenticated())return res.redirect(req.user.must_change_password?'/account/password':redirectFor(req.user,req));
    res.render('auth/login',{title:'Sign in',active:'',oauthEnabled:googleEnabled});
  });
  router.get('/signup',(req,res)=>{
    if(req.isAuthenticated())return res.redirect(req.user.must_change_password?'/account/password':redirectFor(req.user,req));
    res.render('auth/signup',{title:'Create account',active:'',values:{name:'',email:''}});
  });
  router.post('/auth/signup',attemptLimit,async(req,res,next)=>{
    const name=typeof req.body.name==='string'?req.body.name.trim():'';
    const email=normalizedEmail(req.body.email),password=req.body.password;
    let message='';
    if(!name||[...name].length>200)message='Enter your name using 1 to 200 characters.';
    else if(!EMAIL_PATTERN.test(email)||email.length>254)message='Enter a valid email address.';
    else if(!validPassword(password))message='Choose a password with at least 12 characters and at most 72 UTF-8 bytes.';
    else if(password!==req.body.passwordConfirmation)message='The password confirmation does not match.';
    else if(config.adminEmails.includes(email))message='This email is reserved for administrator sign-in.';
    if(message)return res.status(422).render('auth/signup',{title:'Create account',active:'',values:{name,email},flash:{type:'error',message}});
    try{
      const existing=await store.passwordAccountByEmail(email);
      if(existing&&(existing.google_id||existing.email_verified_at||existing.legacy_active))return res.status(409).render('auth/signup',{title:'Create account',active:'',values:{name,email},flash:{type:'error',message:'An account already exists for this email. Sign in to your existing account. Google linking requires confirmation.'}});
      const item=await verification.issue({name,email,passwordHash:await createHash(password)});
      await deliverCode(req,item);res.redirect('/verify-email');
    }catch(error){
      if(error.status===503)return showCode(req,res,error.message,503);
      if(error.status===429)return res.status(429).render('auth/signup',{title:'Create account',active:'',values:{name,email},flash:{type:'error',message:error.message}});
      next(error);
    }
  });
  router.get('/verify-email',(req,res)=>showCode(req,res));
  router.get('/request-verification',(_req,res)=>res.redirect('/verify-email'));
  router.post('/auth/verify-email',codeLimit,async(req,res,next)=>{
    const result=await verification.verify(req.session.pendingRegistration,req.body.code);
    if(result.error)return showCode(req,res,result.error,422);
    delete req.session.pendingRegistration;
    flash(req,'success','Email verified. Welcome to CSPConnect.');
    return signIn(req,res,next,await store.getUser(result.id));
  });
  router.post('/auth/resend-verification',codeLimit,async(req,res)=>{
    try{const item=await verification.resend(req.session.pendingRegistration);await deliverCode(req,item);return showCode(req,res,'A new code has been emailed. It expires in 5 minutes.');}
    catch(error){if([422,429,503].includes(error.status))return showCode(req,res,error.message,error.status);throw error;}
  });
  router.post('/auth/login',attemptLimit,async(req,res,next)=>{
    try{
      const email=normalizedEmail(req.body.email),password=req.body.password;
      if(!EMAIL_PATTERN.test(email)||email.length>254||typeof password!=='string'||[...password].length<12||Buffer.byteLength(password,'utf8')>128){flash(req,'error','Email or password is incorrect.');return res.redirect('/login');}
      const account=await store.passwordAccountByEmail(email);
      if(!await verifyPassword(password,account?.password_hash)||!account?.password_hash){flash(req,'error','Email or password is incorrect.');return res.redirect('/login');}
      if(!account.legacy_active && (!account.email_verified_at||!account.password_verified_at)){
        if(!validPassword(password)){flash(req,'error','Use Forgot password to choose a password within the new 72-byte limit.');return res.redirect('/login');}
        const item=await verification.issue({email,name:account.name,passwordHash:await createHash(password),expectedHash:account.password_hash,userId:account.id});
        await deliverCode(req,item);return res.redirect('/verify-email');
      }
      const role=require('../utils/emergency').roleFor(account,config);
      if(account.role!==role)await store.syncAccountRole(account.id,role);
      signIn(req,res,next,{...account,role,password_hash:undefined});
    }catch(error){
      if(error.status===503)return showCode(req,res,error.message,503);
      if(error.status===429){flash(req,'error',error.message);return res.redirect('/login');}
      next(error);
    }
  });
  router.get('/auth/google',(req,res,next)=>{
    if(!googleEnabled){flash(req,'error','Google sign-in needs to be configured in .env before you can use it.');return res.redirect('/login');}
    passport.authenticate('google',{scope:['openid','profile','email']})(req,res,next);
  });
  router.get('/auth/google/callback',(req,res,next)=>{
    if(!googleEnabled)return res.redirect('/login');
    passport.authenticate('google',(error,user,info)=>{
      if(error)return next(error);
      if(info?.pendingGoogleLink){
        req.session.pendingGoogleLink={...info.pendingGoogleLink,expiresAt:Date.now()+5*60000,nonce:crypto.randomBytes(32).toString('hex'),attempts:0};
        return res.redirect('/auth/google/link');
      }
      if(!user){flash(req,'error',info?.message||'Google sign-in was not completed.');return res.redirect('/login');}
      signIn(req,res,next,user);
    })(req,res,next);
  });
  function linkProof(req){const proof=req.session.pendingGoogleLink;return proof&&proof.expiresAt>Date.now()&&proof.attempts<5?proof:null;}
  const showLink=(req,res,message=null,status=200)=>{
    const proof=linkProof(req);if(!proof){delete req.session.pendingGoogleLink;flash(req,'error','Start Google sign-in again to confirm linking.');return res.redirect('/login');}
    return res.status(status).render('auth/link-google',{title:'Confirm Google account link',active:'',flash:null,email:proof.email,nonce:proof.nonce,message});
  };
  router.get('/auth/google/link',(req,res)=>showLink(req,res));
  router.post('/auth/google/link',attemptLimit,async(req,res,next)=>{
    const proof=linkProof(req);if(!proof)return showLink(req,res);
    if(req.body.confirm!=='1'||req.body.nonce!==proof.nonce)return showLink(req,res,'Confirm that you want to link these sign-in methods.',422);
    if(req.isAuthenticated()&&req.user.id!==proof.accountId)return showLink(req,res,'Sign out of your other CSPConnect account and start again.',403);
    try{
      const account=await store.passwordAccountByEmail(proof.email);
      if(!account||account.id!==proof.accountId||!await verifyPassword(req.body.password,account.password_hash)){
        proof.attempts++;return showLink(req,res,'The existing CSPConnect password is incorrect. Use Forgot password if you need to recover it.',422);
      }
      const user=await store.linkGoogleAccount({accountId:proof.accountId,googleId:proof.googleId,email:proof.email,expectedPasswordHash:account.password_hash,adminEmails:config.adminEmails,securityEmails:config.securityEmails||[]});
      delete req.session.pendingGoogleLink;signIn(req,res,next,user);
    }catch(error){if([409,422].includes(error.status))return showLink(req,res,error.message,error.status);next(error);}
  });
  router.get('/forgot-password',(_req,res)=>res.render('auth/request-link',{title:'Reset your password',active:'',purpose:'reset',flash:null}));
  router.post('/auth/forgot-password',resetLimit,async(req,res)=>{
    const email=normalizedEmail(req.body.email);
    if(EMAIL_PATTERN.test(email)&&email.length<=254){const item=await security.issue(email,'reset');if(item){try{await sendAccountEmail(item);}catch(error){console.error('Account email unavailable:',error.code||error.name);}}}
    flash(req,'success','If this address is eligible, a 30-minute password reset link will be emailed.');res.redirect('/login');
  });
  const showReset=(req,res,message=null,status=200)=>res.status(status).render('auth/redeem-link',{title:'Reset password',active:'',purpose:'reset',token:typeof req.query.token==='string'?req.query.token:req.body.token||'',message,flash:null});
  router.get('/reset-password',async(req,res)=>showReset(req,res,await security.inspect(req.query.token,'reset')?null:'This link is invalid or expired. Request another email.'));
  router.post('/auth/reset-password',resetLimit,async(req,res)=>{
    if(!validPassword(req.body.password)||req.body.password!==req.body.passwordConfirmation)return showReset(req,res,'Use matching passwords of at least 12 characters and at most 72 UTF-8 bytes.',422);
    try{await security.redeem(req.body.token,'reset',await createHash(req.body.password));}catch(error){if(error.status===422)return showReset(req,res,error.message,422);throw error;}
    req.logout(()=>{req.session.csrfToken=crypto.randomBytes(32).toString('hex');flash(req,'success','Your password is saved. Sign in to continue.');res.redirect('/login');});
  });
  router.get('/account/password',(req,res)=>{
    if(!req.isAuthenticated())return res.redirect('/login');
    if(!require('../services/account-security').accountReady(req.user))return res.redirect('/verify-email');
    res.render('auth/change-password',{title:'Change your password',active:'',flash:null});
  });
  router.post('/account/password',attemptLimit,async(req,res,next)=>{
    if(!req.isAuthenticated())return res.redirect('/login');
    if(!require('../services/account-security').accountReady(req.user))return res.redirect('/verify-email');
    try{
      const password=req.body.password;let message='';
      if(!validPassword(password))message='Choose a password with at least 12 characters and at most 72 UTF-8 bytes.';
      else if(password!==req.body.passwordConfirmation)message='The password confirmation does not match.';
      if(!message&&!req.user.must_change_password){const current=await store.passwordAccountByEmail(req.user.email);if(current?.password_hash&&!await verifyPassword(req.body.currentPassword,current.password_hash))message='Current password is incorrect.';}
      if(message)return res.status(422).render('auth/change-password',{title:'Change your password',active:'',flash:{type:'error',message}});
      await store.changePassword(req.user.id,await createHash(password),{expectedVersion:Number(req.user.session_version||0)});
      const updated=await store.getUser(req.user.id);signIn(req,res,next,updated);
    }catch(error){next(error);}
  });
  router.use((req,res,next)=>{
    if(!req.isAuthenticated()||!req.user.must_change_password||!require('../services/account-security').accountReady(req.user)||req.path==='/account/password'||req.path==='/logout')return next();
    res.redirect('/account/password');
  });
  router.post('/logout',(req,res,next)=>req.logout(error=>{
    if(error)return next(error);
    req.session.destroy(failure=>{if(failure)return next(failure);res.clearCookie('cspc.sid',{path:'/'});res.redirect('/login');});
  }));
  return router;
}
module.exports={authRoutes,MIN_PASSWORD_LENGTH,MAX_PASSWORD_BYTES};
