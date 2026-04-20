const express = require('express');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');
const crypto = require('crypto');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const logger = require('./logger');
const { loadAppConfig } = require('./app-config');
const { registerBaseMiddleware, createRequestServices } = require('./request-services');
const { createOperationalAlerts } = require('./operational-alerts');
const { createLuminaBilling } = require('./lumina-billing');
const { createCustomerAuth } = require('./customer-auth');
const { createAdminObservability } = require('./admin-observability');
const { createAdminRoutes } = require('./admin-routes');
const { createPublicRoutes } = require('./public-routes');
const { createCourseRoutes } = require('./course-routes');
const { createCourseEngagement } = require('./course-engagement');
const { createStripeRoutes } = require('./stripe-routes');
const { createCourseReminders } = require('./course-reminders');
const { createAuthUtils } = require('./auth-utils');
const { createHealthRoutes } = require('./health-routes');
const { createSiteHelpers } = require('./site-helpers');
const { createCourseAccess } = require('./course-access');
const { createCustomerStore } = require('./customer-store');
const { createWhatsAppSender } = require('./whatsapp-sender');
const { registerGlobalErrorHandling, initializeApp, startServer } = require('./app-startup');
const COURSES = require('./course-catalog');

const uuidv4 = () => crypto.randomUUID();
const NAMI_JID = '84393251371@s.whatsapp.net';
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

let config;
try {
  config = loadAppConfig({ env: process.env, logger });
} catch {
  process.exit(1);
}

const app = express();
registerBaseMiddleware({ app, express });

const pool = new Pool(config.db);
const dbHealth = { degraded: false, recentErrors: [] };
pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected database pool error');
  const now = Date.now();
  dbHealth.recentErrors.push(now);
  // Keep only errors within the last 60 seconds
  dbHealth.recentErrors = dbHealth.recentErrors.filter((t) => now - t < 60000);
  if (dbHealth.recentErrors.length > 3) {
    dbHealth.degraded = true;
    logger.error({ errorCount: dbHealth.recentErrors.length }, 'Database pool error threshold exceeded — marking degraded');
  }
});

const transporter = nodemailer.createTransport({
  host: config.smtp.host,
  port: config.smtp.port,
  secure: config.smtp.secure,
  auth: {
    user: config.smtp.user,
    pass: config.smtp.pass
  },
  connectionTimeout: config.smtp.connectionTimeout,
  greetingTimeout: config.smtp.greetingTimeout,
  socketTimeout: config.smtp.socketTimeout
});

const smtpMonitor = {
  configured: !!(config.smtp.user && config.smtp.pass),
  status: config.smtp.user && config.smtp.pass ? 'pending' : 'disabled',
  lastError: null,
  verifiedAt: null
};

const {
  rateLimit,
  cleanupRateLimits,
  getIP,
  uploadImportCsv
} = createRequestServices({ multer });

const {
  setAuthCookie,
  clearAuthCookie,
  authMiddleware
} = createAuthUtils({
  jwt,
  jwtSecret: config.auth.jwtSecret,
  isProd: config.isProd
});

const {
  generateToken,
  buildGiftDownloadUrl,
  normalizeEmail,
  escapeHtml,
  injectTracking,
  unsubPage
} = createSiteHelpers({
  crypto,
  siteUrl: config.siteUrl
});

createHealthRoutes({
  app,
  pool,
  smtpMonitor,
  dbHealth
});

const {
  verifyCourseAccess,
  cleanupAccessCache
} = createCourseAccess({
  pool,
  logger
});

const {
  upsertCustomer
} = createCustomerStore({
  pool,
  logger,
  normalizeEmail
});

setInterval(() => {
  try {
    cleanupRateLimits();
    cleanupAccessCache();
  } catch (err) {
    logger.error({ err }, 'Cache cleanup error');
  }
}, 300000).unref();

const sendWhatsApp = createWhatsAppSender({
  overlordUrl: config.overlordUrl,
  webhookToken: config.webhookToken,
  logger
});

const {
  ensureOperationalAlertsTable,
  recordOperationalAlert,
  resolveOperationalAlert
} = createOperationalAlerts({
  pool,
  logger,
  transporter,
  smtpUser: config.smtp.user,
  smtpPass: config.smtp.pass,
  smtpFrom: config.smtp.from,
  alertEmailTo: config.alerts.emailTo,
  notifyCooldownMs: config.alerts.notifyCooldownMs,
  sendWhatsApp,
  alertWhatsAppJid: config.alerts.whatsappJid || NAMI_JID
});

const {
  getAppPlanFromProduct,
  normalizeLuminaCurrency,
  getLuminaCheckoutPrice,
  getLuminaCheckoutCopy,
  formatMoneyAmount,
  sendLuminaLifecycleEmail,
  getStripePeriodStartSeconds,
  getStripePeriodEndSeconds,
  upsertAppEntitlement,
  grantLuminaLifetime,
  getLuminaEntitlementByEmail,
  createBillingPortalSessionForEmail,
  requireLuminaBridgeAuth,
  isAllowedLuminaReturnUrl,
  defaultLuminaSuccessUrl,
  defaultLuminaCancelUrl
} = createLuminaBilling({
  pool,
  stripe: config.stripe.client,
  transporter,
  logger,
  normalizeEmail,
  escapeHtml,
  siteUrl: config.siteUrl,
  luminaSiteUrl: config.lumina.siteUrl,
  luminaAllowedHosts: config.lumina.allowedHosts,
  luminaBridgeSecret: config.lumina.bridgeSecret,
  smtpUser: config.smtp.user,
  smtpPass: config.smtp.pass,
  smtpFrom: config.smtp.from,
  products: config.lumina.products
});

const { customerAuth } = createCustomerAuth({
  app,
  pool,
  jwt,
  bcrypt,
  transporter,
  logger,
  courses: COURSES,
  jwtSecret: config.auth.jwtSecret,
  siteUrl: config.siteUrl,
  smtpFrom: config.smtp.from,
  rateLimit,
  getIP,
  generateToken,
  setAuthCookie,
  clearAuthCookie,
  normalizeEmail
});

createAdminObservability({
  app,
  pool,
  logger,
  authMiddleware
});

createAdminRoutes({
  app,
  pool,
  logger,
  authMiddleware,
  bcrypt,
  jwt,
  jwtSecret: config.auth.jwtSecret,
  setAuthCookie,
  clearAuthCookie,
  getIP,
  rateLimit,
  stringify,
  parse,
  uploadImportCsv,
  multer,
  generateToken,
  transporter,
  smtpFrom: config.smtp.from,
  siteUrl: config.siteUrl,
  uuidv4,
  injectTracking,
  sendWhatsApp,
  namiJid: NAMI_JID
});

createPublicRoutes({
  app,
  pool,
  logger,
  transporter,
  sendWhatsApp,
  namiJid: NAMI_JID,
  getIP,
  rateLimit,
  generateToken,
  escapeHtml,
  unsubPage,
  jwt,
  jwtSecret: config.auth.jwtSecret,
  siteUrl: config.siteUrl,
  smtpFrom: config.smtp.from,
  smtpMonitor,
  buildGiftDownloadUrl,
  journalPdfPath: config.journalPdfPath,
  pixel: PIXEL,
  redirectAllowlist: config.redirectAllowlist
});

createCourseRoutes({
  app,
  pool,
  logger,
  transporter,
  getIP,
  rateLimit,
  verifyCourseAccess,
  courses: COURSES,
  siteUrl: config.siteUrl,
  smtpFrom: config.smtp.from,
  escapeHtml,
  r2: config.r2.client,
  GetObjectCommand,
  getSignedUrl,
  r2Bucket: config.r2.bucket
});

const courseEngagement = createCourseEngagement({
  app,
  pool,
  logger,
  authMiddleware,
  transporter,
  smtpFrom: config.smtp.from,
  siteUrl: config.siteUrl,
  escapeHtml,
  getIP,
  rateLimit,
  verifyCourseAccess,
  courses: COURSES,
  sendWhatsApp,
  namiJid: NAMI_JID
});

const courseReminders = createCourseReminders({
  app,
  pool,
  transporter,
  logger,
  jwt,
  jwtSecret: config.auth.jwtSecret,
  siteUrl: config.siteUrl,
  smtpFrom: config.smtp.from,
  escapeHtml,
  authMiddleware,
  courses: COURSES
});

createStripeRoutes({
  app,
  pool,
  stripe: config.stripe.client,
  logger,
  rateLimit,
  getIP,
  upsertCustomer,
  generateToken,
  courses: COURSES,
  siteUrl: config.siteUrl,
  smtpFrom: config.smtp.from,
  transporter,
  sendWhatsApp,
  namiJid: NAMI_JID,
  formatMoneyAmount,
  getAppPlanFromProduct,
  upsertAppEntitlement,
  sendLuminaLifecycleEmail,
  getStripePeriodStartSeconds,
  getStripePeriodEndSeconds,
  grantLuminaLifetime,
  recordOperationalAlert,
  stripeWebhookSecret: config.stripe.webhookSecret,
  escapeHtml,
  customerAuth,
  requireLuminaBridgeAuth,
  normalizeEmail,
  getLuminaEntitlementByEmail,
  createBillingPortalSessionForEmail,
  luminaSiteUrl: config.lumina.siteUrl,
  luminaProducts: config.lumina.products,
  isAllowedLuminaReturnUrl,
  defaultLuminaSuccessUrl,
  defaultLuminaCancelUrl,
  normalizeLuminaCurrency,
  getLuminaCheckoutPrice,
  getLuminaCheckoutCopy,
  buildCourse2UpsellBlockHtml: courseReminders.buildCourse2UpsellBlockHtml,
  verifyFlashToken: courseReminders.verifyFlashToken,
  flashPrice: courseReminders.constants.FLASH_PRICE
});

registerGlobalErrorHandling({
  app,
  logger,
  recordOperationalAlert
});

initializeApp({
  pool,
  logger,
  ensureOperationalAlertsTable,
  adminPassword: config.auth.adminPassword,
  bcrypt,
  transporter,
  smtpUser: config.smtp.user,
  smtpPass: config.smtp.pass,
  smtpMonitor,
  resolveOperationalAlert,
  recordOperationalAlert
}).then(async () => {
  try {
    await courseReminders.ensureReminderTable();
    courseReminders.startScheduler();
    logger.info('Course reminder scheduler started');
  } catch (err) {
    logger.error({ err }, 'Course reminder init failed');
  }
  try {
    await courseEngagement.ensureTables();
    logger.info('Course engagement tables ready');
  } catch (err) {
    logger.error({ err }, 'Course engagement init failed');
  }
  startServer({
    app,
    port: config.port,
    logger,
    pool
  });
}).catch((err) => {
  logger.fatal({ err }, 'Init failed');
  process.exit(1);
});
