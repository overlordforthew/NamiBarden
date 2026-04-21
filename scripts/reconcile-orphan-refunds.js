#!/usr/bin/env node
require('dotenv/config');

const { Pool } = require('pg');
const { createPoolConfigFromEnv } = require('../reporting-lib');

function parseArgs(argv) {
  const args = { live: false };
  for (const arg of argv) {
    if (arg === '--live') args.live = true;
    else if (arg === '--dry-run') args.live = false;
    else args.unknown = arg;
  }
  return args;
}

const MATCH_RANK_CTE = `matches AS (
  SELECT
    r.id AS refund_id,
    r.stripe_refund_id,
    r.stripe_payment_intent_id,
    r.stripe_charge_id,
    p.id AS payment_id,
    p.customer_id,
    p.product_name,
    CASE
      WHEN r.stripe_payment_intent_id IS NOT NULL
       AND p.stripe_payment_intent_id = r.stripe_payment_intent_id THEN 0
      ELSE 1
    END AS match_priority
  FROM nb_refunds r
  JOIN nb_payments p ON (
    (r.stripe_payment_intent_id IS NOT NULL AND p.stripe_payment_intent_id = r.stripe_payment_intent_id)
    OR (r.stripe_charge_id IS NOT NULL AND p.stripe_charge_id = r.stripe_charge_id)
  )
  WHERE r.payment_id IS NULL
),
ranked AS (
  SELECT DISTINCT ON (refund_id)
    refund_id, stripe_refund_id, stripe_payment_intent_id, stripe_charge_id,
    payment_id, customer_id, product_name
  FROM matches
  ORDER BY refund_id, match_priority ASC, payment_id DESC
)`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.unknown) {
    console.error(`Unknown argument: ${args.unknown}`);
    process.exit(2);
    return;
  }

  const pool = new Pool(createPoolConfigFromEnv());
  try {
    if (!args.live) {
      const result = await pool.query(`WITH ${MATCH_RANK_CTE}
        SELECT * FROM ranked
        ORDER BY refund_id`);
      console.log(`[orphan-refunds] dry run: ${result.rows.length} refund(s) can be reconciled`);
      for (const row of result.rows.slice(0, 25)) {
        console.log(`[orphan-refunds] ${row.stripe_refund_id} -> payment ${row.payment_id} (${row.product_name || 'unknown'})`);
      }
      if (result.rows.length > 25) {
        console.log(`[orphan-refunds] ...${result.rows.length - 25} more`);
      }
      console.log('[orphan-refunds] rerun with --live to update rows');
      return;
    }

    const result = await pool.query(`WITH ${MATCH_RANK_CTE}
      UPDATE nb_refunds r
      SET payment_id = ranked.payment_id,
          customer_id = ranked.customer_id,
          product_name = COALESCE(ranked.product_name, r.product_name)
      FROM ranked
      WHERE r.id = ranked.refund_id
        AND r.payment_id IS NULL
      RETURNING r.stripe_refund_id, r.payment_id, r.product_name`);
    console.log(`[orphan-refunds] reconciled ${result.rowCount} refund(s)`);
    for (const row of result.rows.slice(0, 25)) {
      console.log(`[orphan-refunds] ${row.stripe_refund_id} -> payment ${row.payment_id} (${row.product_name || 'unknown'})`);
    }
    if (result.rows.length > 25) {
      console.log(`[orphan-refunds] ...${result.rows.length - 25} more`);
    }
  } catch (err) {
    console.error('[orphan-refunds] failed', err);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

main();
