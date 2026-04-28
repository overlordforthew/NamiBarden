const path = require('path');
const Stripe = require('stripe');
const { S3Client } = require('@aws-sdk/client-s3');

const REQUIRED_ENV = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'JWT_SECRET'];
const RECOMMENDED_ENV = ['SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SITE_URL', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'];
const REDIRECT_ALLOWLIST = ['namibarden.com', 'www.namibarden.com', 'youtube.com', 'www.youtube.com', 'youtu.be', 'instagram.com', 'www.instagram.com', 'amzn.to', 'amazon.co.jp', 'amazon.com'];
const LUMINA_PRODUCTS = {
  'lumina-monthly': {
    appSlug: 'lumina',
    planCode: 'lifetime',
    nameEn: 'LUMINA Lifetime Access',
    nameJa: 'LUMINA ライフタイムアクセス',
    descriptionEn: '90-day guided journey, weekly synthesis, reflection library, and all future Lumina updates',
    descriptionJa: '90日間ガイド付きジャーニー、週ごとのシンセシス、リフレクションライブラリ、今後のすべてのアップデート',
    prices: {
      jpy: 1980
    },
    mode: 'payment'
  },
  'lumina-annual': {
    appSlug: 'lumina',
    planCode: 'lifetime',
    nameEn: 'LUMINA Lifetime Access',
    nameJa: 'LUMINA ライフタイムアクセス',
    descriptionEn: '90-day guided journey, weekly synthesis, reflection library, and all future Lumina updates',
    descriptionJa: '90日間ガイド付きジャーニー、週ごとのシンセシス、リフレクションライブラリ、今後のすべてのアップデート',
    prices: {
      jpy: 1980
    },
    mode: 'payment'
  },
  'lumina-lifetime': {
    appSlug: 'lumina',
    planCode: 'lifetime',
    nameEn: 'LUMINA Lifetime Access',
    nameJa: 'LUMINA ライフタイムアクセス',
    descriptionEn: '90-day guided journey, weekly synthesis, reflection library, and all future Lumina updates',
    descriptionJa: '90日間ガイド付きジャーニー、週ごとのシンセシス、リフレクションライブラリ、今後のすべてのアップデート',
    prices: {
      jpy: 1980
    },
    mode: 'payment'
  }
};

function loadAppConfig({ env, logger }) {
  const missingRequired = REQUIRED_ENV.filter((key) => !env[key]);
  if (missingRequired.length > 0) {
    logger.fatal({ missing: missingRequired }, 'Missing required environment variables — exiting');
    throw new Error('Missing required environment variables');
  }

  const missingRecommended = RECOMMENDED_ENV.filter((key) => !env[key]);
  if (missingRecommended.length > 0) {
    logger.warn({ missing: missingRecommended }, 'Missing recommended environment variables — some features will be disabled');
  }

  const {
    DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD,
    SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM,
    JWT_SECRET, ADMIN_PASSWORD,
    OVERLORD_URL, WEBHOOK_TOKEN, SITE_URL,
    STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
    R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET,
    LUMINA_BRIDGE_SECRET, LUMINA_URL, LUMINA_ALLOWED_HOSTS: LUMINA_ALLOWED_HOSTS_ENV,
    ALERT_EMAIL_TO: ALERT_EMAIL_TO_ENV, ALERT_WHATSAPP_JID: ALERT_WHATSAPP_JID_ENV,
    NAMI_ALERT_EMAIL: NAMI_ALERT_EMAIL_ENV,
    ALERT_NOTIFY_COOLDOWN_MINUTES,
    NODE_ENV
  } = env;

  const isProdEnv = NODE_ENV === 'production';

  // Live-key guard: a non-production environment with any *_live_* Stripe key
  // would hit prod Stripe. Covers sk_live_, rk_live_, and any future variants.
  if (!isProdEnv && STRIPE_SECRET_KEY && /_live_/.test(STRIPE_SECRET_KEY)) {
    throw new Error(`STRIPE_SECRET_KEY is a live-mode key but NODE_ENV=${NODE_ENV || '<unset>'}; refusing to boot. Use a test-mode key (sk_test_* or rk_test_*) in non-production.`);
  }

  // Cookie Secure flag: COOKIE_SECURE env wins (accepts true|1|yes|on, false|0|no|off);
  // unrecognized values throw so silent downgrades can't happen; absent → isProd.
  const cookieSecureRaw = (env.COOKIE_SECURE || '').toLowerCase().trim();
  let cookieSecure;
  if (cookieSecureRaw === '') cookieSecure = isProdEnv;
  else if (['true', '1', 'yes', 'on'].includes(cookieSecureRaw)) cookieSecure = true;
  else if (['false', '0', 'no', 'off'].includes(cookieSecureRaw)) cookieSecure = false;
  else throw new Error(`COOKIE_SECURE must be one of true|false|1|0|yes|no|on|off (got "${env.COOKIE_SECURE}")`);

  const siteUrl = SITE_URL || '';
  // Lumina URL: only fall back to the prod Lumina URL when we're actually in
  // production. In non-prod, leave it pointing at an explicitly-broken sentinel
  // so any code path that tries to redirect to Lumina fails loudly instead of
  // silently bouncing the user to prod.
  const luminaSiteUrl = (
    LUMINA_URL || (isProdEnv ? 'https://lumina.namibarden.com' : 'https://lumina-not-configured-on-staging.invalid')
  ).replace(/\/+$/, '');
  // Allowed hosts: in prod include the prod Lumina host as a baseline. In
  // non-prod, only allow hosts derived from explicit configuration — so a
  // staging frontend can't smuggle a prod Lumina URL past the validator.
  const luminaAllowedHosts = Array.from(new Set(
    [
      'namibarden.com',
      'www.namibarden.com',
      ...(isProdEnv ? ['lumina.namibarden.com'] : []),
      ...(LUMINA_ALLOWED_HOSTS_ENV || '').split(',').map((host) => host.trim()).filter(Boolean)
    ].concat(
      [siteUrl, luminaSiteUrl].map((rawUrl) => {
        try {
          return rawUrl ? new URL(rawUrl).hostname : null;
        } catch {
          return null;
        }
      }).filter(Boolean)
    )
  ));

  return {
    port: 3100,
    publicRoot: '/usr/share/nginx/html',
    journalPdfPath: path.join('/usr/share/nginx/html', 'gifts', '5day-journal.pdf'),
    isProd: isProdEnv,
    cookieSecure,
    // Always include the configured SITE_URL hostname so non-prod sites
    // (staging) can use their own redirect-allowlist without manual edits.
    redirectAllowlist: (() => {
      try {
        const siteHost = siteUrl ? new URL(siteUrl).hostname : null;
        return siteHost && !REDIRECT_ALLOWLIST.includes(siteHost)
          ? [...REDIRECT_ALLOWLIST, siteHost]
          : REDIRECT_ALLOWLIST;
      } catch {
        return REDIRECT_ALLOWLIST;
      }
    })(),
    db: {
      host: DB_HOST,
      port: DB_PORT || 5432,
      database: DB_NAME,
      user: DB_USER,
      password: DB_PASSWORD,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
      max: 20
    },
    smtp: {
      host: SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(SMTP_PORT, 10) || 587,
      secure: false,
      user: SMTP_USER,
      pass: SMTP_PASS,
      from: SMTP_FROM,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 30000
    },
    auth: {
      jwtSecret: JWT_SECRET,
      adminPassword: ADMIN_PASSWORD
    },
    siteUrl,
    overlordUrl: OVERLORD_URL,
    webhookToken: WEBHOOK_TOKEN,
    stripe: {
      client: STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null,
      webhookSecret: STRIPE_WEBHOOK_SECRET
    },
    r2: {
      client: (R2_ENDPOINT && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY) ? new S3Client({
        region: 'auto',
        endpoint: R2_ENDPOINT,
        credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
        forcePathStyle: true
      }) : null,
      bucket: R2_BUCKET
    },
    lumina: {
      bridgeSecret: LUMINA_BRIDGE_SECRET,
      siteUrl: luminaSiteUrl,
      allowedHosts: luminaAllowedHosts,
      products: LUMINA_PRODUCTS
    },
    alerts: {
      emailTo: ALERT_EMAIL_TO_ENV || SMTP_USER || SMTP_FROM || '',
      namiEmail: NAMI_ALERT_EMAIL_ENV || 'namibarden@gmail.com',
      whatsappJid: ALERT_WHATSAPP_JID_ENV || '',
      notifyCooldownMs: Math.max(parseInt(ALERT_NOTIFY_COOLDOWN_MINUTES || '60', 10) || 60, 5) * 60 * 1000
    }
  };
}

module.exports = { loadAppConfig };
