'use strict';
require('dotenv').config({ quiet: true });
function loadConfig({ strict = false } = {}) {
  const e = process.env;
  const config = {
    nodeEnv: e.NODE_ENV || 'development', host: e.HOST || (e.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'),
    port: Number(e.PORT || 3000), appUrl: e.APP_URL || 'http://localhost:3000',
    dbHost: e.DATABASE_HOST || e.DB_HOST || '127.0.0.1',
    dbPort: Number(e.DATABASE_PORT || e.DB_PORT || 3306),
    dbUser: e.DATABASE_USER || e.DB_USER || 'root',
    dbPassword: e.DATABASE_PASSWORD || e.DB_PASSWORD || '',
    dbName: e.DATABASE_NAME || e.DB_NAME || 'cspc_feedback_db',
    sessionSecret: e.SESSION_SECRET || '',
    googleClientId: e.GOOGLE_CLIENT_ID || '', googleClientSecret: e.GOOGLE_CLIENT_SECRET || '',
    googleCallbackUrl: e.GOOGLE_CALLBACK_URL || 'http://localhost:3000/auth/google/callback',
    adminEmails: (e.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    securityEmails: (e.SECURITY_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    guardhouseName: (e.GUARDHOUSE_NAME || 'Guardhouse').trim().slice(0, 100),
    guardhouseNumber: e.GUARDHOUSE_NUMBER || '', guardhouseNumberVerified: e.GUARDHOUSE_NUMBER_VERIFIED === 'true',
    emergencyEscalationMinutes: Number(e.EMERGENCY_ESCALATION_MINUTES || 3),
    cspcEmailDomains: (e.CSPC_EMAIL_DOMAINS ?? 'cspc.edu.ph,my.cspc.edu.ph').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    geminiApiKey: e.GEMINI_API_KEY || '', geminiModel: e.GEMINI_MODEL || 'gemini-3.5-flash-lite',
    smtpEnabled: e.SMTP_ENABLED === 'true', smtpHost: e.SMTP_HOST || '', smtpPort: Number(e.SMTP_PORT || 587),
    smtpSecure: e.SMTP_SECURE === 'true', smtpUser: e.SMTP_USER || '', smtpPassword: e.SMTP_PASSWORD || '',
    smtpFrom: e.SMTP_FROM || '', smtpFromName: e.SMTP_FROM_NAME || 'CSPConnect Team',
    smtpAllowInsecureLocal: e.SMTP_ALLOW_INSECURE_LOCAL === 'true',
    uploadStorage: e.UPLOAD_STORAGE || (e.NODE_ENV === 'production' ? 'cloudinary' : 'local'),
    cloudinaryCloudName: e.CLOUDINARY_CLOUD_NAME || '',
    cloudinaryApiKey: e.CLOUDINARY_API_KEY || '',
    cloudinaryApiSecret: e.CLOUDINARY_API_SECRET || ''
  };
  if (strict && config.sessionSecret.length < 32) throw new Error('Set SESSION_SECRET to a random value of at least 32 characters in .env.');
  if (!['local', 'cloudinary'].includes(config.uploadStorage)) throw new Error('UPLOAD_STORAGE must be local or cloudinary.');
  if (strict && config.uploadStorage === 'cloudinary' &&
      (!config.cloudinaryCloudName || !config.cloudinaryApiKey || !config.cloudinaryApiSecret)) {
    throw new Error('Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET for image storage.');
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('PORT must be a valid port number.');
  if (!config.cspcEmailDomains.length || config.cspcEmailDomains.some(domain => !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domain))) throw new Error('CSPC_EMAIL_DOMAINS must contain exact institutional domains separated by commas.');
  if (!Number.isInteger(config.emergencyEscalationMinutes) || config.emergencyEscalationMinutes < 1 || config.emergencyEscalationMinutes > 120) throw new Error('EMERGENCY_ESCALATION_MINUTES must be 1–120.');
  if (!/^[a-zA-Z0-9._-]+$/.test(config.geminiModel)) throw new Error('GEMINI_MODEL is invalid.');
  return config;
}
module.exports = { loadConfig };
