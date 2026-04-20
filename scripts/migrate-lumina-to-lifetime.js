#!/usr/bin/env node
require('dotenv/config');

const { Pool } = require('pg');
const Stripe = require('stripe');
const nodemailer = require('nodemailer');
const { createLuminaBilling } = require('../lumina-billing');

const ANNUAL_PRICE_JPY = 29800;
const DAY_MS = 24 * 60 * 60 * 1000;

function parseArgs(argv) {
  const args = {};
  argv.forEach((arg) => {
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--live') args.live = true;
    else if (arg.startsWith('--confirm-count=')) args.confirmCount = Number(arg.split('=')[1]);
    else if (arg.startsWith('--only-email=')) args.onlyEmail = arg.split('=').slice(1).join('=').trim().toLowerCase();
    else if (arg.startsWith('--expect-email=')) args.expectEmail = arg.split('=').slice(1).join('=').trim().toLowerCase();
    else args.unknown = arg;
  });
  return args;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/migrate-lumina-to-lifetime.js --dry-run',
    '  node scripts/migrate-lumina-to-lifetime.js --live --confirm-count=1 --expect-email=foo@bar.com',
    '  node scripts/migrate-lumina-to-lifetime.js --live --only-email=foo@bar.com'
  ].join('\n');
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sqlString(value) {
  if (value == null) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function computeRefund(currentPeriodEnd) {
  const endMs = currentPeriodEnd ? new Date(currentPeriodEnd).getTime() : 0;
  const daysRemaining = Number.isFinite(endMs) ? Math.max(0, Math.ceil((endMs - Date.now()) / DAY_MS)) : 0;
  return {
    daysRemaining,
    refundJpy: Math.round((daysRemaining / 365) * ANNUAL_PRICE_JPY)
  };
}

function printRefundStep(candidate, refund, auditId) {
  const where = auditId
    ? `id = ${auditId}`
    : `customer_id = ${candidate.customer_id} AND old_stripe_subscription_id = ${sqlString(candidate.old_stripe_subscription_id)}`;
  console.log(`Manual refund for ${candidate.email}:`);
  console.log(`  days_remaining=${refund.daysRemaining}, formula=round((${refund.daysRemaining} / 365) * ${ANNUAL_PRICE_JPY}) => ${refund.refundJpy} JPY`);
  console.log('  After issuing the partial refund in Stripe, record it with:');
  console.log(`  UPDATE nb_lumina_migration_audit SET prorated_refund_jpy = ${refund.refundJpy}, refund_stripe_charge_id = 'ch_REPLACE_ME' WHERE ${where};`);
}

function createPool() {
  return new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'namibarden',
    user: process.env.DB_USER || 'namibarden',
    password: process.env.DB_PASSWORD || process.env.DB_PASS || '',
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    max: 5
  });
}

function createEmailSender(pool) {
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  const smtpFrom = process.env.SMTP_FROM || smtpUser;
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: false,
    auth: smtpUser && smtpPass ? { user: smtpUser, pass: smtpPass } : undefined
  });
  const logger = {
    error: (...args) => console.error(...args),
    warn: (...args) => console.warn(...args),
    info: (...args) => console.log(...args)
  };
  const billing = createLuminaBilling({
    pool,
    stripe: null,
    transporter,
    logger,
    normalizeEmail,
    escapeHtml,
    siteUrl: process.env.SITE_URL || 'https://namibarden.com',
    luminaSiteUrl: (process.env.LUMINA_URL || 'https://lumina.namibarden.com').replace(/\/+$/, ''),
    luminaAllowedHosts: ['namibarden.com', 'www.namibarden.com', 'lumina.namibarden.com'],
    luminaBridgeSecret: process.env.LUMINA_BRIDGE_SECRET || '',
    smtpUser,
    smtpPass,
    smtpFrom,
    products: {}
  });
  return {
    configured: !!(smtpUser && smtpPass && smtpFrom),
    sendLuminaLifecycleEmail: billing.sendLuminaLifecycleEmail
  };
}

async function loadCandidates(pool, onlyEmail) {
  const params = [];
  const filters = [
    "e.app_slug = 'lumina'",
    "e.status IN ('active','trialing','past_due')",
    "e.plan_code = 'annual'"
  ];
  if (onlyEmail) {
    params.push(onlyEmail);
    filters.push(`LOWER(c.email) = $${params.length}`);
  }
  const result = await pool.query(
    `SELECT
       e.customer_id,
       c.email,
       c.name,
       e.status AS old_status,
       e.plan_code AS old_plan_code,
       e.stripe_subscription_id AS old_stripe_subscription_id,
       e.current_period_end AS old_current_period_end,
       to_jsonb(s.*) AS old_subscription_row
     FROM nb_app_entitlements e
     JOIN nb_customers c ON c.id = e.customer_id
     LEFT JOIN nb_subscriptions s ON s.stripe_subscription_id = e.stripe_subscription_id
     WHERE ${filters.join(' AND ')}
     ORDER BY e.customer_id`,
    params
  );
  return result.rows;
}

async function cancelStripeSubscription(stripe, candidate) {
  const subId = candidate.old_stripe_subscription_id;
  if (!subId) throw new Error('No Stripe subscription id on entitlement');
  try {
    const result = await stripe.subscriptions.cancel(subId, {
      invoice_now: false,
      prorate: false
    });
    return `canceled:${result.status || 'unknown'}`;
  } catch (err) {
    if (err?.code === 'resource_missing' || /No such subscription/i.test(err?.message || '')) {
      return `already_missing:${err.message}`;
    }
    throw err;
  }
}

async function convertCandidate(pool, candidate, stripeCancelResult) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const snapshotResult = await client.query(
      `SELECT to_jsonb(s.*) AS old_subscription_row
       FROM nb_subscriptions s
       WHERE stripe_subscription_id = $1
       FOR UPDATE`,
      [candidate.old_stripe_subscription_id]
    );
    const oldSubscriptionRow = snapshotResult.rows[0]?.old_subscription_row || candidate.old_subscription_row || null;

    await client.query(
      `UPDATE nb_subscriptions
       SET status = 'canceled',
           canceled_at = NOW(),
           updated_at = NOW()
       WHERE stripe_subscription_id = $1`,
      [candidate.old_stripe_subscription_id]
    );

    const entitlementResult = await client.query(
      `UPDATE nb_app_entitlements
       SET status = 'lifetime',
           plan_code = 'lifetime',
           stripe_subscription_id = NULL,
           current_period_end = NULL,
           trial_end = NULL,
           cancel_at = NULL,
           canceled_at = NOW(),
           lifetime_granted_at = NOW(),
           metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
             'converted_from', status,
             'migrated_from_sub', stripe_subscription_id,
             'migrated_at', NOW()
           ),
           updated_at = NOW()
       WHERE customer_id = $1 AND app_slug = 'lumina'
       RETURNING customer_id`,
      [candidate.customer_id]
    );
    if (entitlementResult.rows.length === 0) {
      throw new Error('Lumina entitlement row was not updated');
    }

    const auditResult = await client.query(
      `INSERT INTO nb_lumina_migration_audit (
         customer_id, email, old_status, old_plan_code, old_stripe_subscription_id,
         old_current_period_end, old_subscription_row, stripe_cancel_result,
         prorated_refund_jpy, refund_stripe_charge_id
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, NULL, NULL)
       RETURNING id`,
      [
        candidate.customer_id,
        candidate.email,
        candidate.old_status,
        candidate.old_plan_code,
        candidate.old_stripe_subscription_id,
        candidate.old_current_period_end,
        oldSubscriptionRow ? JSON.stringify(oldSubscriptionRow) : null,
        stripeCancelResult
      ]
    );

    await client.query('COMMIT');
    return auditResult.rows[0].id;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    client.release();
  }
}

async function markAuditEmailSent(pool, auditId) {
  await pool.query(
    `UPDATE nb_lumina_migration_audit
     SET email_sent = TRUE
     WHERE id = $1`,
    [auditId]
  );
}

async function appendAuditError(pool, auditId, message) {
  await pool.query(
    `UPDATE nb_lumina_migration_audit
     SET error_message = COALESCE(error_message || E'\n', '') || $2
     WHERE id = $1`,
    [auditId, message]
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.unknown || args.dryRun === args.live) {
    console.error(usage());
    process.exit(1);
  }
  if (args.live && !args.onlyEmail && !Number.isInteger(args.confirmCount)) {
    console.error('--live requires --confirm-count=N or --only-email=X');
    process.exit(1);
  }

  const pool = createPool();
  try {
    const candidates = await loadCandidates(pool, args.onlyEmail);
    console.log(`Lumina lifetime migration candidates: ${candidates.length}`);
    if (args.live && args.onlyEmail && candidates.length !== 1) {
      throw new Error(`--only-email expected exactly 1 candidate, found ${candidates.length}`);
    }
    if (args.live && !args.onlyEmail && candidates.length !== args.confirmCount) {
      throw new Error(`--confirm-count=${args.confirmCount} did not match actual count ${candidates.length}`);
    }
    if (args.live && args.expectEmail) {
      const match = candidates.find((c) => normalizeEmail(c.email) === args.expectEmail);
      if (!match) {
        throw new Error(`--expect-email=${args.expectEmail} not found among candidates`);
      }
    }

    // Instantiate Stripe + email sender once, not per-candidate
    const stripe = args.live && process.env.STRIPE_SECRET_KEY
      ? new Stripe(process.env.STRIPE_SECRET_KEY)
      : null;
    if (args.live && !stripe) {
      throw new Error('STRIPE_SECRET_KEY is required for --live');
    }
    const emailSender = args.live ? createEmailSender(pool) : null;
    if (args.live && !emailSender.configured) {
      console.warn('WARNING: SMTP_USER/SMTP_PASS/SMTP_FROM not fully configured — upgrade emails will be skipped.');
    }

    for (const candidate of candidates) {
      const refund = computeRefund(candidate.old_current_period_end);
      console.log(`\n${candidate.email} (${candidate.old_plan_code}, ${candidate.old_status})`);
      console.log(`  subscription=${candidate.old_stripe_subscription_id || 'none'}`);

      if (args.dryRun) {
        printRefundStep(candidate, refund);
        console.log('  dry-run: no Stripe calls, DB writes, or emails sent');
        continue;
      }

      let cancelResult;
      try {
        cancelResult = await cancelStripeSubscription(stripe, candidate);
      } catch (err) {
        console.error(`  Stripe cancel failed for ${candidate.email}: ${err.message}`);
        continue;
      }

      let auditId;
      try {
        auditId = await convertCandidate(pool, candidate, cancelResult);
        console.log(`  converted: audit_id=${auditId}`);
        printRefundStep(candidate, refund, auditId);
      } catch (err) {
        console.error(`  DB conversion failed for ${candidate.email}: ${err.message}`);
        continue;
      }

      if (!emailSender.configured) continue;
      try {
        await emailSender.sendLuminaLifecycleEmail('lifetime_upgrade', {
          email: candidate.email,
          name: candidate.name,
          productName: 'lumina-lifetime',
          previousPlan: candidate.old_plan_code,
          refundAmountJpy: refund.refundJpy,
          throwOnError: true
        });
        await markAuditEmailSent(pool, auditId);
        console.log('  lifetime_upgrade email sent');
      } catch (err) {
        console.error(`  email failed for ${candidate.email}: ${err.message}`);
        await appendAuditError(pool, auditId, `email failed: ${err.message}`);
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
