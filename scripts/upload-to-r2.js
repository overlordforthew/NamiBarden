#!/usr/bin/env node
// Upload HLS directory to Cloudflare R2
// Usage: node upload-to-r2.js <local-dir> <r2-prefix>
//
// Example: node upload-to-r2.js ./output/course-1/lesson-1 courses/course-1/lesson-1
// This uploads all .m3u8 and .ts files to R2 under the given prefix.

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = process.env;

if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
  console.error('Missing R2 env vars. Set R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET in .env');
  process.exit(1);
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY
  }
});

const MIME_TYPES = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t'
};

function getFiles(dir, base = dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...getFiles(fullPath, base));
    } else {
      const ext = path.extname(entry.name);
      if (MIME_TYPES[ext]) {
        results.push({
          localPath: fullPath,
          key: path.relative(base, fullPath),
          contentType: MIME_TYPES[ext]
        });
      }
    }
  }
  return results;
}

async function upload(localDir, r2Prefix) {
  const files = getFiles(localDir);
  console.log(`Found ${files.length} files to upload`);

  let uploaded = 0;
  for (const file of files) {
    const key = `${r2Prefix}/${file.key}`;
    const body = fs.readFileSync(file.localPath);

    await s3.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: body,
      ContentType: file.contentType
    }));

    uploaded++;
    if (uploaded % 10 === 0 || uploaded === files.length) {
      console.log(`  ${uploaded}/${files.length} uploaded`);
    }
  }

  console.log(`Done. ${uploaded} files uploaded to r2://${R2_BUCKET}/${r2Prefix}/`);
}

const [localDir, r2Prefix] = process.argv.slice(2);
if (!localDir || !r2Prefix) {
  console.error('Usage: node upload-to-r2.js <local-dir> <r2-prefix>');
  console.error('Example: node upload-to-r2.js ./output/course-1/lesson-1 courses/course-1/lesson-1');
  process.exit(1);
}

upload(localDir, r2Prefix).catch(e => {
  console.error('Upload failed:', e.message);
  process.exit(1);
});
