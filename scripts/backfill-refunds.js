#!/usr/bin/env node
require('dotenv/config');

const { Pool } = require('pg');
const Stripe = require('stripe');
const {
  createPoolConfigFromEnv,
  findPaymentForRefund,
  upsertStripeRefund
} = require('../reporting-lib');

function usage() {
  return [
    'Usage:',
    '  node scripts/backfill-refunds.js --dry-run [--from=YYYY-MM-DD]',
    '  node scripts/backfill-refunds.js --live --from=YYYY-MM-DD',
    '',
    'If --from is omitted, 2020-01-01 JST is used as the historical cutoff.'
  ].join('\n');
}

function parseArgs(argv) {
  const args = { live: false, from: '2020-01-01' };
  for (const arg of argv) {
    if (arg === '--dry-run') args.live = false;
    else if (arg === '--live') args.live = true;
    else if (arg.startsWith('--from=')) args.from = arg.slice('--from='.length);
    else if (arg === '--help' || arg === '-h') args.help = true;
    else args.unknown = arg;
  }
  return args;
}

function cutoffUnixSeconds(from) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    throw new Error('--from must be YYYY-MM-DD');
  }
  const date = new Date(`${from}T00:00:00+09:00`);
  if (!Number.isFinite(date.getTime())) {
    throw new Error('--from must be a valid JST calendar date');
  }
  return Math.floor(date.getTime() / 1000);
}

async function refundExists(pool, refundId) {
  const result = await pool.query(
    `SELECT id FROM nb_refunds WHERE stripe_refund_id = $1 LIMIT 1`,
    [refundId]
  );
  return result.rows.length > 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (args.unknown) {
    console.error(`Unknown argument: ${args.unknown}`);
    console.error(usage());
    process.exit(2);
    return;
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('STRIPE_SECRET_KEY is required');
    process.exit(2);
    return;
  }

  const createdGte = cutoffUnixSeconds(args.from);
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const pool = new Pool(createPoolConfigFromEnv());
  const counts = { seen: 0, new: 0, updated: 0, skipped: 0, orphan: 0 };
  let startingAfter = null;

  try {
    console.log(`[backfill-refunds] mode=${args.live ? 'live' : 'dry-run'} from=${args.from} created.gte=${createdGte}`);
    while (true) {
      const page = await stripe.refunds.list({
        limit: 100,
        created: { gte: createdGte },
        expand: ['data.charge'],
        ...(startingAfter ? { starting_after: startingAfter } : {})
      });

      for (const refund of page.data) {
        counts.seen++;
        const { paymentRow, pi, ch } = await findPaymentForRefund(pool, {
          ...refund,
          payment_intent: refund.payment_intent || refund.charge?.payment_intent || null
        });
        if (!paymentRow) counts.orphan++;

        if (!args.live) {
          if (await refundExists(pool, refund.id)) counts.skipped++;
          else counts.new++;
          continue;
        }

        const result = await upsertStripeRefund(pool, refund, paymentRow, {
          pi: pi || refund.charge?.payment_intent || null,
          ch
        });
        if (result.rows[0]?.inserted) counts.new++;
        else counts.updated++;
      }

      if (!page.has_more || page.data.length === 0) break;
      startingAfter = page.data[page.data.length - 1].id;
    }

    console.log(`[backfill-refunds] seen=${counts.seen} new=${counts.new} updated=${counts.updated} skipped=${counts.skipped} orphan=${counts.orphan}`);
    if (!args.live) console.log('[backfill-refunds] dry run only; rerun with --live to write nb_refunds');
  } catch (err) {
    console.error('[backfill-refunds] failed', err);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

main();
