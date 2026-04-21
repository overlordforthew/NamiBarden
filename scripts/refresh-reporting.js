#!/usr/bin/env node
require('dotenv/config');

const { Pool } = require('pg');
const { createPoolConfigFromEnv } = require('../reporting-lib');

const VIEWS = ['nb_revenue_daily', 'nb_refunds_daily'];

function elapsedMs(start) {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

async function main() {
  const pool = new Pool(createPoolConfigFromEnv());
  const started = process.hrtime.bigint();
  try {
    for (const view of VIEWS) {
      const viewStart = process.hrtime.bigint();
      console.log(`[reporting-refresh] refreshing ${view}`);
      await pool.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${view}`);
      console.log(`[reporting-refresh] refreshed ${view} in ${elapsedMs(viewStart).toFixed(0)}ms`);
    }
    console.log(`[reporting-refresh] complete in ${elapsedMs(started).toFixed(0)}ms`);
  } catch (err) {
    console.error('[reporting-refresh] failed', err);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

main();
