#!/usr/bin/env node
require('dotenv/config');

const { Pool } = require('pg');
const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const DEFAULT_LIMIT = 500;

function parseArgs(argv) {
  const args = {
    dryRun: false,
    live: false,
    limit: DEFAULT_LIMIT
  };
  for (const arg of argv) {
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--live') args.live = true;
    else if (arg.startsWith('--limit=')) args.limit = Math.max(1, parseInt(arg.split('=')[1], 10) || DEFAULT_LIMIT);
    else args.unknown = arg;
  }
  return args;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/gc-qa-attachments.js --dry-run [--limit=500]',
    '  node scripts/gc-qa-attachments.js --live [--limit=500]'
  ].join('\n');
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

function createR2Client() {
  const {
    R2_ENDPOINT,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_BUCKET
  } = process.env;

  if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
    throw new Error('Missing R2 env vars: R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET');
  }

  return {
    bucket: R2_BUCKET,
    client: new S3Client({
      region: 'auto',
      endpoint: R2_ENDPOINT,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY
      },
      forcePathStyle: true
    })
  };
}

async function loadExpiredPending(pool, limit) {
  const result = await pool.query(
    `SELECT id, r2_key, size_bytes, detected_mime, expires_at
     FROM nb_qa_pending_attachments
     WHERE expires_at < NOW()
     ORDER BY expires_at ASC, id ASC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

async function deletePendingRows(pool, ids) {
  if (ids.length === 0) return [];
  const result = await pool.query(
    `DELETE FROM nb_qa_pending_attachments
     WHERE id = ANY($1::int[]) AND expires_at < NOW()
     RETURNING id`,
    [ids]
  );
  return result.rows.map((row) => row.id);
}

async function deleteR2Objects(r2, rows) {
  const deleted = [];
  const failed = [];
  for (const row of rows) {
    try {
      await r2.client.send(new DeleteObjectCommand({
        Bucket: r2.bucket,
        Key: row.r2_key
      }));
      deleted.push(row.id);
    } catch (err) {
      failed.push({ id: row.id, r2Key: row.r2_key, error: err.message });
    }
  }
  return { deleted, failed };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.unknown || args.dryRun === args.live) {
    console.error(usage());
    process.exit(2);
  }

  const pool = createPool();
  try {
    const rows = await loadExpiredPending(pool, args.limit);
    const totalBytes = rows.reduce((sum, row) => sum + (Number(row.size_bytes) || 0), 0);
    console.log(JSON.stringify({
      mode: args.live ? 'live' : 'dry-run',
      expiredRows: rows.length,
      totalBytes
    }));

    if (!args.live) {
      rows.slice(0, 20).forEach((row) => {
        console.log(JSON.stringify({
          id: row.id,
          r2Key: row.r2_key,
          detectedMime: row.detected_mime,
          sizeBytes: Number(row.size_bytes) || 0,
          expiresAt: row.expires_at
        }));
      });
      if (rows.length > 20) console.log(JSON.stringify({ omittedRows: rows.length - 20 }));
      return;
    }

    const r2 = createR2Client();
    const r2Result = await deleteR2Objects(r2, rows);
    const deletedRows = await deletePendingRows(pool, r2Result.deleted);
    console.log(JSON.stringify({
      deletedR2Objects: r2Result.deleted.length,
      deletedDbRows: deletedRows.length,
      failedR2Deletes: r2Result.failed.length
    }));
    for (const failure of r2Result.failed) {
      console.error(JSON.stringify(failure));
    }
    if (r2Result.failed.length > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`GC failed: ${err.message}`);
  process.exit(1);
});
