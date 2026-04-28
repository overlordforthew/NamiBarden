#!/usr/bin/env node
require('dotenv/config');

const { Pool } = require('pg');

function parseArgs(argv) {
  const args = {};
  argv.forEach((arg) => {
    if (arg.startsWith('--email=')) args.email = arg.split('=').slice(1).join('=').trim().toLowerCase();
    else if (arg.startsWith('--reason=')) args.reason = arg.split('=').slice(1).join('=').trim();
    else args.unknown = arg;
  });
  return args;
}

function usage() {
  return 'Usage: node scripts/revoke-lumina-lifetime.js --email foo@bar.com --reason "customer requested within 7 days"';
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
    max: 3
  });
}

async function bustLuminaCache(email) {
  const rawLuminaUrl = process.env.LUMINA_URL
    || (process.env.NODE_ENV === 'production' ? 'https://lumina.namibarden.com' : null);
  if (!rawLuminaUrl) {
    throw new Error('revoke-lumina-lifetime: LUMINA_URL must be set explicitly when NODE_ENV != production');
  }
  const luminaUrl = rawLuminaUrl.replace(/\/+$/, '');
  const bridgeSecret = process.env.LUMINA_BRIDGE_SECRET || process.env.NAMI_LUMINA_BRIDGE_SECRET || '';
  if (!bridgeSecret) {
    console.warn('Cache bust skipped: LUMINA_BRIDGE_SECRET is not configured');
    return;
  }
  const response = await fetch(`${luminaUrl}/internal/lumina/entitlement-cache-bust?email=${encodeURIComponent(email)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Lumina-Bridge-Key': bridgeSecret
    },
    body: JSON.stringify({ email })
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Lumina cache bust failed: ${response.status} ${text}`);
  }
}

async function revoke(pool, email, reason) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rowResult = await client.query(
      `SELECT
         c.id AS customer_id,
         c.email,
         e.status,
         e.plan_code,
         e.stripe_subscription_id,
         e.current_period_end,
         to_jsonb(e.*) AS old_entitlement_row
       FROM nb_customers c
       JOIN nb_app_entitlements e ON e.customer_id = c.id AND e.app_slug = 'lumina'
       WHERE LOWER(c.email) = $1
       FOR UPDATE OF e`,
      [email]
    );
    if (rowResult.rows.length === 0) {
      throw new Error(`No Lumina entitlement found for ${email}`);
    }
    const row = rowResult.rows[0];
    if (row.status !== 'lifetime') {
      throw new Error(`Lumina entitlement is ${row.status}, not lifetime`);
    }

    await client.query(
      `UPDATE nb_app_entitlements
       SET status = 'refunded',
           metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
             'refunded_at', NOW(),
             'refund_reason', $2
           ),
           updated_at = NOW()
       WHERE customer_id = $1 AND app_slug = 'lumina'`,
      [row.customer_id, reason]
    );

    const auditResult = await client.query(
      `INSERT INTO nb_lumina_migration_audit (
         customer_id, email, old_status, old_plan_code, old_stripe_subscription_id,
         old_current_period_end, old_subscription_row, stripe_cancel_result,
         new_status, error_message
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, 'refunded', $9)
       RETURNING id`,
      [
        row.customer_id,
        row.email,
        row.status,
        row.plan_code,
        row.stripe_subscription_id,
        row.current_period_end,
        JSON.stringify(row.old_entitlement_row),
        'manual refund helper: no Stripe API call made',
        reason
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.unknown || !args.email || !args.reason) {
    console.error(usage());
    process.exit(1);
  }

  // Preflight: fail before any DB mutation if the cache-bust target can't
  // be resolved. Prevents partial-success runs where revoke() commits but
  // bustLuminaCache() throws on missing non-prod LUMINA_URL.
  if (!process.env.LUMINA_URL && process.env.NODE_ENV !== 'production') {
    throw new Error('revoke-lumina-lifetime: LUMINA_URL must be set explicitly when NODE_ENV != production (preflight)');
  }

  const pool = createPool();
  try {
    const auditId = await revoke(pool, args.email, args.reason);
    console.log(`Lumina lifetime access marked refunded for ${args.email}. audit_id=${auditId}`);
    console.log('No Stripe refund was issued by this script. Issue/refund-confirm in Stripe dashboard separately.');
    await bustLuminaCache(args.email);
    console.log('Lumina entitlement cache busted.');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
