'use strict';
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const { rateLimit } = require('express-rate-limit');
const { loadConfig } = require('./config/env');
const { configurePassport } = require('./config/passport');
const { csrf } = require('./middleware/csrf');
const { TYPES, STATUSES } = require('./utils/constants');
const { authRoutes } = require('./routes/auth');
const { pagesRoutes } = require('./routes/pages');
const { accountRoutes } = require('./routes/account');
function createApp(options = {}) {
  const config = { ...loadConfig(), ...options.config };
  if (config.sessionSecret.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters.');
  const store = options.store || require('./models/store');
  const supportStore = store.supportForConfig ? store.supportForConfig(config) : store;
  const sessionStore = options.sessionStore || new (require('./services/session-store').MySQLSessionStore)(require('./config/db').pool);
  const app = express();
  app.disable('x-powered-by'); app.set('view engine','ejs'); app.set('views',path.resolve(__dirname,'../views'));
  app.locals.assetVersion = Date.now().toString(36);
  app.use(helmet({
    contentSecurityPolicy: { directives: {
      defaultSrc:["'self'"],scriptSrc:["'self'"],styleSrc:["'self'"],imgSrc:["'self'",'blob:'],
      connectSrc:["'self'"],fontSrc:["'self'"],objectSrc:["'none'"],frameAncestors:["'none'"],
      formAction:["'self'"],baseUri:["'self'"],upgradeInsecureRequests: config.nodeEnv==='production' ? [] : null
    }},
    strictTransportSecurity: config.nodeEnv==='production' ? undefined : false,
    referrerPolicy: { policy: 'no-referrer' }
  }));
  const errorLimiter = (_req,res) => res.status(429).send('Too many requests. Please wait a moment and try again.');
  app.use(rateLimit({windowMs:15*60*1000,limit:500,standardHeaders:'draft-8',legacyHeaders:false,handler:errorLimiter}));
  for (const directory of ['css','js','images']) app.use('/'+directory,express.static(path.resolve(__dirname,'../public',directory),{dotfiles:'deny',maxAge:config.nodeEnv==='development' ? 0 : 3600000}));
  app.use(express.urlencoded({extended:false,limit:'64kb'}));
  app.use(express.json({limit:'64kb'}));
  // Unsupported or empty request bodies must reach validation rather than crash a route.
  app.use((req, _res, next) => { req.body ||= {}; next(); });
  const sessionMiddleware = session({name:'cspc.sid',secret:config.sessionSecret,store:sessionStore,resave:false,saveUninitialized:false,
    cookie:{httpOnly:true,sameSite:'lax',secure:config.nodeEnv==='production',maxAge:8*60*60*1000}});
  app.use(sessionMiddleware);
  const passport=options.passport || configurePassport(store,config,{verifyGoogleToken:options.verifyGoogleToken});
  app.use(passport.initialize()); app.use(passport.session());
  app.use((req,res,next) => {
    res.set('Cache-Control','no-store');
    res.locals={...res.locals,user:req.user||null,title:'CSPConnect',active:'',flash:req.session.flash||null,types:TYPES,statuses:STATUSES,
      query:{},categories:[],unreadNotificationCount:0,formatDate:date => date ? new Intl.DateTimeFormat('en-PH',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Manila'}).format(new Date(date)) : '—'};
    delete req.session.flash; next();
  });
  app.use(csrf);
  app.get('/contact-admin',require('./routes/support').publicContactHelp);
  app.use('/auth',rateLimit({windowMs:15*60*1000,limit:30,standardHeaders:'draft-8',legacyHeaders:false,handler:errorLimiter}));
  const security=options.accountSecurity || require('./services/account-security').createAccountSecurity(require('./config/db').pool,config);
  const verification=options.emailVerification || require('./services/email-verification').createEmailVerification(require('./config/db').pool,config);
  const sendCode=options.sendVerificationEmail || require('./services/email-verification').createVerificationMailer(config);
  app.use(authRoutes(passport,config,store,security,options.sendAccountEmail || require('./services/account-security').createAccountMailer(config),verification,sendCode));
  app.use((req,res,next)=>{
    if(!req.isAuthenticated() || require('./services/account-security').accountReady(req.user)) return next();
    if(req.path.startsWith('/api/')) return res.status(403).json({error:'Verify your email before continuing.'});
    res.redirect('/login');
  });
  app.use(require('./routes/affiliation').affiliationRoutes(store,config));
  app.use(async (req,res,next) => {
    if (['student','admin'].includes(req.user?.role) && req.method === 'GET' && !req.path.startsWith('/api/') && store.unreadNotificationCount) {
      res.locals.unreadNotificationCount = await store.unreadNotificationCount(req.user.id);
    }
    next();
  });
  app.use(require('./routes/notifications').notificationRoutes(store));
  app.use(require('./routes/support').supportRoutes(supportStore));
  app.use(accountRoutes(store));
  const emergencyStore = options.emergencyStore || require('./models/emergencies').createEmergencyStore(require('./config/db').pool, config);
  app.locals.config = config;
  app.locals.accountStore = store;
  app.locals.emergencyStore = emergencyStore;
  app.locals.sessionMiddleware = sessionMiddleware;
  const emailOutbox = options.emailOutbox || require('./models/email-outbox').createEmailOutbox(require('./config/db').pool);
  app.locals.emailOutbox = emailOutbox;
  app.use(require('./routes/email-notifications').emailNotificationRoutes(emailOutbox, config));
  app.use(require('./routes/emergencies').emergencyRoutes(emergencyStore, async report => {
    try { await app.locals.publishEmergency?.(report); }
    catch (error) { console.error('Emergency live delivery failed; saved report remains available:', error.code || error.name); }
  }));
  const professorLimiter=rateLimit({windowMs:60*1000,limit:10,standardHeaders:'draft-8',legacyHeaders:false,
    keyGenerator:req => String(req.user.id),handler:(_req,res)=>res.status(429).json({error:'Please wait a minute before asking Professor again.'})});
  app.use(pagesRoutes(store,config,professorLimiter,emailOutbox,supportStore));
  app.use((_req,_res,next)=>{const err=new Error('The page you requested was not found.');err.status=404;next(err);});
  app.use((err,req,res,_next)=>{
    if(res.headersSent) return _next(err);
    let status=Number.isInteger(err.status) && err.status>=400 && err.status<=599 ? err.status : 500;
    let message=status===500?'The system could not complete your request. Please try again.':err.message;
    if(err.code?.startsWith('LIMIT_')) {status=422;message='The upload exceeds the allowed limit. Use one JPG, PNG, or WebP image up to 5 MB.';}
    if(['ECONNREFUSED','ER_NO_SUCH_TABLE','ER_BAD_DB_ERROR','ETIMEDOUT'].includes(err.code)) {status=503;message='The local database is unavailable. Start MySQL in XAMPP and complete the database setup.';}
    if(status===500) console.error('Request failed:',err.code||err.name);
    if(req.path.startsWith('/api/')) return res.status(status).json({error:message});
    res.status(status).render('error',{status,message,title:'Request could not be completed',active:'',user:req.user||null,csrfToken:req.session?.csrfToken||'',flash:null,types:TYPES,statuses:STATUSES,query:{},categories:[]});
  });
  app.locals.sessionStore=sessionStore;
  return app;
}
module.exports={createApp};
