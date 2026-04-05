const express = require('express');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');
const crypto = require('crypto');
const Stripe = require('stripe');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const WebSocket = require('ws');
const logger = require('./logger');
const uuidv4 = () => crypto.randomUUID();

// ─── Environment Variable Validation ───
const REQUIRED_ENV = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'JWT_SECRET'];
const RECOMMENDED_ENV = ['SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SITE_URL', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'];

const missingRequired = REQUIRED_ENV.filter(v => !process.env[v]);
if (missingRequired.length > 0) {
  logger.fatal({ missing: missingRequired }, 'Missing required environment variables — exiting');
  process.exit(1);
}

const missingRecommended = RECOMMENDED_ENV.filter(v => !process.env[v]);
if (missingRecommended.length > 0) {
  logger.warn({ missing: missingRecommended }, 'Missing recommended environment variables — some features will be disabled');
}

const app = express();

// ─── Cookie parser (lightweight, no dependency) ───
app.use((req, res, next) => {
  req.cookies = {};
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    cookieHeader.split(';').forEach(pair => {
      try {
        const [name, ...rest] = pair.trim().split('=');
        if (name) req.cookies[name.trim()] = decodeURIComponent(rest.join('=').trim());
      } catch { /* ignore malformed cookie values */ }
    });
  }
  next();
});

app.use((req, res, next) => {
  if (req.originalUrl === '/api/stripe/webhook') {
    express.raw({ type: 'application/json' })(req, res, next);
  } else {
    express.json({ limit: '5mb' })(req, res, next);
  }
});
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  if (err instanceof URIError) return res.status(400).json({ error: 'Bad request' });
  next(err);
});

// ─── Config ───
const PORT = 3100;
const {
  DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD,
  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM,
  JWT_SECRET, ADMIN_PASSWORD,
  OVERLORD_URL, WEBHOOK_TOKEN, SITE_URL,
  STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
  R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
} = process.env;

// ─── Redirect allowlist (used by /api/track/click to prevent open redirects) ───
const REDIRECT_ALLOWLIST = ['namibarden.com', 'www.namibarden.com', 'youtube.com', 'www.youtube.com', 'youtu.be', 'instagram.com', 'www.instagram.com', 'amzn.to', 'amazon.co.jp', 'amazon.com'];

// ─── Stripe ───
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

// ─── R2 (Cloudflare) ───
const r2 = (R2_ENDPOINT && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY) ? new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  forcePathStyle: true
}) : null;

// ─── Course config ───
const COURSES = {
  'course-1': {
    name: '愛を引き寄せる心の授業',
    lessons: [
      { id: 'lesson-1',  title: 'はじめに', desc: 'コースの進め方と、学びを最大限に活かすためのコツをお伝えします。ノートとペンを用意して、心と向き合う旅のスタートです。' },
      { id: 'lesson-2',  title: '二つの心の状態 (1)', desc: '人間の心には「美しい状態」と「苦悩の状態」の2つがあります。恋愛の問題を解消するための、最も基本となるコンセプトを学びます。' },
      { id: 'lesson-3',  title: '二つの心の状態 (2)', desc: '2つの心の状態がどのように恋愛パターンに影響しているかを、さらに深く掘り下げます。' },
      { id: 'lesson-4',  title: '４つのステップ', desc: '苦悩の心を美しい心に戻す「4つのステップ」を習得します。気づく→思考を挙げる→苦悩の正体を知る→正しい行動を考える。このコースの核となるメソッドです。' },
      { id: 'lesson-5',  title: 'なぜパートナーが欲しいのか', desc: 'パートナーを求める本当の理由を探ります。離婚率のデータや「理想像」の罠を通して、無意識の動機に気づくレッスンです。' },
      { id: 'lesson-7',  title: 'デートがうまくいかない理由', desc: 'デートの準備で無意識にやっている「遺伝子の行動」とは？外見やテクニックに頼るデートから卒業するための心の知恵を学びます。' },
      { id: 'lesson-8',  title: '運命の相手はどこに？', desc: '「運命の人」という幻想を手放し、本当に心が通い合う相手を見つける心の在り方を学びます。' },
      { id: 'lesson-9',  title: '魅力的な自分を作る５つの心得', desc: '相手を「探す」前に、自分を「磨く」ことが先決。仕事・趣味・日常の中で内面から魅力を高める5つの実践法を紹介します。' },
      { id: 'lesson-10', title: 'パートナーと心を通わせるコツ (1)', desc: 'ミラーリングや傾聴テクニックだけでは心はつながらない。「今ここ」に意識を置き、本当の意味で相手のために存在するコミュニケーション術・前編。' },
      { id: 'lesson-11', title: 'パートナーと心を通わせるコツ (2)', desc: '日常の中で深いつながりを育てる具体的な実践法。スモールトークからビッグトークへ、心を通わせる会話の質を高めます。' },
      { id: 'bonus-bigtalk', title: 'Big Talk — 心を深める質問集', type: 'pdf', url: '/bigtalk', desc: '大切な人との会話をもっと深いものにする80の質問集です。カップル、子供、家族・友人、職場の4カテゴリーに分けて、すぐに使える質問をまとめました。ぜひダウンロードして、大切な人との時間に活用してください。' },
      { id: 'lesson-12', title: 'ビジョンを描けば現実になる (1)', desc: '「引き寄せの法則」は本当に機能するのか？漠然と願うだけでは叶わない理由と、ビジョンをクリアにする重要性を学びます。' },
      { id: 'lesson-13', title: 'ビジョンを描けば現実になる (2)', desc: '実際にビジョンボードを作るワーク。具体的に夢を描き、パートナーシップの理想を形にしていきます。' },
      { id: 'ending', title: 'コース完了おめでとうございます！', type: 'ending', desc: 'ここまで学んでくださり、ありがとうございます。次のステップへ進む準備はできていますか？' }
    ]
  },
  'course-2': {
    name: '愛を深める心の授業',
    lessons: [
      { id: 'basic-1', title: 'はじめに', desc: 'コースの進め方と、学びを最大限に活かすためのコツをお伝えします。', sourceCourse: 'course-1', sourceLesson: 'lesson-1', section: 'basic' },
      { id: 'basic-2', title: '二つの心の状態 (1)', desc: '人間の心には「美しい状態」と「苦悩の状態」の2つがあります。恋愛の問題を解消するための、最も基本となるコンセプトを学びます。', sourceCourse: 'course-1', sourceLesson: 'lesson-2', section: 'basic' },
      { id: 'basic-3', title: '二つの心の状態 (2)', desc: '2つの心の状態がどのように恋愛パターンに影響しているかを、さらに深く掘り下げます。', sourceCourse: 'course-1', sourceLesson: 'lesson-3', section: 'basic' },
      { id: 'basic-4', title: '４つのステップ', desc: '苦悩の心を美しい心に戻す「4つのステップ」を習得します。このコースの核となるメソッドです。', sourceCourse: 'course-1', sourceLesson: 'lesson-4', section: 'basic' },
      { id: 'lesson-1',  title: '意見の食い違いを解決しよう', desc: 'パートナーとの衝突の裏にある「理想像」を見つけ、意見の違いを成長のきっかけに変える方法を学びます。' },
      { id: 'lesson-2',  title: 'パートナーを一番にできるか', desc: '仕事、子ども、趣味...いつの間にかパートナーの優先順位を下げていませんか？関係が冷える本当の原因と向き合います。' },
      { id: 'lesson-3',  title: 'パートナーの愛の言語を知る', desc: '人それぞれ「愛を感じるポイント」は違います。パートナーの愛の言語を理解し、すれ違いを解消する方法を学びます。' },
      { id: 'lesson-5',  title: '男性性と女性性 (1)', desc: '誰の中にもある「男性性」と「女性性」のエネルギー。そのバランスがパートナーシップにどう影響するかを探ります。' },
      { id: 'lesson-6',  title: '男性性と女性性 (2)', desc: '男性性と女性性の理解をさらに深め、パートナーとの関係の中でそのエネルギーをどう活かすかを実践的に学びます。' },
      { id: 'lesson-7',  title: '家ではどちらの顔でいることが多い？', desc: '外と家での顔の使い分けが関係に与える影響とは？本当の自分でパートナーと向き合うための心の在り方を学びます。' },
      { id: 'lesson-12', title: 'セックスがうまくいかないワケ (1)', desc: 'セックスの問題の根っこは、体ではなく心にあります。心の状態がパートナーとの親密さにどう影響するかを学びます。' },
      { id: 'lesson-11', title: 'セックスがうまくいかないワケ (2)', desc: '心の深いレベルからセックスの問題を解消するための具体的なアプローチ。心が通い合うことで親密さが自然に戻ります。' },
      { id: 'lesson-14', title: '価値観が合わないときはどうすれば?', desc: '価値観の違いは本当に「合わない」のか？違いの奥にある本質を見つめ、互いを尊重しながら歩む方法を考えます。' },
      { id: 'lesson-15', title: '人生のピンチを乗り越える方法 (1)', desc: '裏切り、不倫、信頼の崩壊——パートナーシップ最大の危機をどう乗り越えるか。心の傷と向き合う上級レッスン・前編。' },
      { id: 'lesson-16', title: '人生のピンチを乗り越える方法 (2)', desc: '危機を経験した後、再び信頼を築いていくための具体的なステップ。痛みを成長に変える心の知恵・後編。' },
      { id: 'lesson-17', title: '複数のパートナーをもつことについて (1)', desc: '不倫・愛人・オープンリレーションシップ...心の授業的な視点で「正しい・間違い」のない問いと向き合います。' },
      { id: 'lesson-18', title: '複数のパートナーをもつことについて (2)', desc: '複数のパートナーを持つことの心理的な影響を、さらに深く掘り下げて考察します。' },
      { id: 'lesson-19', title: '怒りの手紙', desc: '心の中に溜まった怒りや悲しみを「手紙」という形で解放するワーク。書くことで心が整い、前に進む力が生まれます。' },
      { id: 'lesson-21', title: '相手を許す方法', desc: '許すとは、相手のためではなく自分のため。心の重荷を手放し、自由になるための許しのプロセスを学びます。' },
      { id: 'lesson-22', title: '愛の瞑想', desc: '自分の中にある愛を溢れさせ、パートナーや世界に届けていく美しい瞑想。コースの学びを心に定着させます。' },
      { id: 'lesson-24', title: '離婚・別れるときに気を付けること (1)', desc: '別れを考えるとき、感情に流されず心の美しい状態から決断するために。知っておくべき大切なポイント・前編。' },
      { id: 'lesson-25', title: '離婚・別れるときに気を付けること (2)', desc: '別れを選んだとき、自分も相手も傷つけすぎないために。意識の学びに基づいた別れ方と新しいスタートへの準備・後編。' },
      { id: 'lesson-26', title: '最後に', desc: 'コースを最後まで受けてくださり、ありがとうございます。ここで学んだことを日常に活かし、愛を深めていきましょう。' }
    ]
  }
};

// ─── Database ───
const pool = new Pool({
  host: DB_HOST, port: DB_PORT || 5432,
  database: DB_NAME, user: DB_USER, password: DB_PASSWORD,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 20
});

// Prevent unhandled pool errors from crashing the process
pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected database pool error');
});

// ─── SMTP ───
const transporter = nodemailer.createTransport({
  host: SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(SMTP_PORT) || 587,
  secure: false,
  auth: { user: SMTP_USER, pass: SMTP_PASS },
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 30000
});

// ─── Rate limiting ───
const rateLimits = new Map();
function rateLimit(key, maxAttempts, windowMs) {
  const now = Date.now();
  const entry = rateLimits.get(key) || { attempts: [], blocked: 0 };
  entry.attempts = entry.attempts.filter(t => now - t < windowMs);
  if (entry.attempts.length >= maxAttempts) return false;
  entry.attempts.push(now);
  rateLimits.set(key, entry);
  return true;
}
setInterval(() => {
  try {
    const now = Date.now();
    for (const [key, entry] of rateLimits) {
      entry.attempts = entry.attempts.filter(t => now - t < 3600000);
      if (entry.attempts.length === 0) rateLimits.delete(key);
    }
    for (const [key, entry] of accessCache) {
      if (now - entry.ts > ACCESS_CACHE_TTL) accessCache.delete(key);
    }
  } catch (e) {
    logger.error({ err: e }, 'Cache cleanup error');
  }
}, 300000);

function getIP(req) {
  // Use X-Real-IP set by nginx (from $remote_addr, not spoofable) instead of X-Forwarded-For
  return req.headers['x-real-ip'] || req.ip;
}

// ─── Cookie Auth Helpers ───
const IS_PROD = process.env.NODE_ENV === 'production';
const COOKIE_OPTS = {
  httpOnly: true,
  secure: IS_PROD,
  sameSite: 'Lax',
  path: '/'
};

function setAuthCookie(res, name, token, maxAgeMs) {
  const opts = [`${name}=${token}`, 'HttpOnly', `Path=/`, `SameSite=Lax`, `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
  if (IS_PROD) opts.push('Secure');
  res.append('Set-Cookie', opts.join('; '));
}

function clearAuthCookie(res, name) {
  const opts = [`${name}=`, 'HttpOnly', 'Path=/', 'SameSite=Lax', 'Max-Age=0'];
  if (IS_PROD) opts.push('Secure');
  res.append('Set-Cookie', opts.join('; '));
}

// ─── JWT Auth Middleware ───
// Reads token from cookie first, falls back to Authorization header for API compat
function authMiddleware(req, res, next) {
  const token = req.cookies?.nb_admin_token || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    req.admin = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ─── Health check ───
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', uptime: Math.floor(process.uptime()) });
  } catch {
    res.status(503).json({ status: 'unhealthy', error: 'database unreachable' });
  }
});

// ─── Upload handler ───
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

// ─── Helpers ───
function generateToken() { return crypto.randomBytes(32).toString('hex'); }

// Token validation cache for HLS (avoids ~300 DB hits per video)
const accessCache = new Map();
const ACCESS_CACHE_TTL = 120000; // 2 minutes

async function verifyCourseAccess(token, courseId) {
  const cacheKey = `${token}:${courseId}`;
  const cached = accessCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < ACCESS_CACHE_TTL) return cached.ok;

  try {
    const r = await pool.query(
      `SELECT id FROM nb_course_access
       WHERE access_token = $1 AND course_id = $2 AND (expires_at IS NULL OR expires_at > NOW())`,
      [token, courseId]
    );
    const ok = r.rows.length > 0;
    accessCache.set(cacheKey, { ok, ts: Date.now() });
    return ok;
  } catch (e) {
    logger.error({ err: e }, 'verifyCourseAccess DB error');
    return false;
  }
}

async function upsertCustomer(email, name, stripeCustomerId) {
  try {
    const r = await pool.query(
      `INSERT INTO nb_customers (email, name, stripe_customer_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (stripe_customer_id) DO UPDATE SET
         email = EXCLUDED.email, name = COALESCE(EXCLUDED.name, nb_customers.name), updated_at = NOW()
       RETURNING id`,
      [email, name, stripeCustomerId]
    );
    return r.rows[0].id;
  } catch (e) {
    logger.error({ err: e, email, stripeCustomerId }, 'upsertCustomer DB error');
    throw e;
  }
}

async function sendWhatsApp(to, text) {
  if (!OVERLORD_URL || !WEBHOOK_TOKEN) return;
  try {
    await fetch(`${OVERLORD_URL}/api/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WEBHOOK_TOKEN}` },
      body: JSON.stringify({ to, text }),
      signal: AbortSignal.timeout(10000)
    });
  } catch (e) { logger.error({ err: e }, 'WhatsApp send failed'); }
}

// Nami's WhatsApp JID
const NAMI_JID = '84393251371@s.whatsapp.net';

// 1x1 transparent PNG
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');


// ══════════════════════════════════════
// PUBLIC ENDPOINTS
// ══════════════════════════════════════

// ─── POST /api/contact ───
app.post('/api/contact', async (req, res) => {
  try {
    const ip = getIP(req);
    if (!rateLimit(`contact:${ip}`, 3, 600000)) {
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }
    const { name, email, subject, message, subscribe } = req.body;
    if (!name?.trim() || !email?.trim() || !message?.trim()) {
      return res.status(400).json({ error: 'Name, email, and message are required' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    // Save contact
    await pool.query(
      'INSERT INTO nb_contacts (name, email, subject, message, ip) VALUES ($1, $2, $3, $4, $5)',
      [name.trim(), email.trim(), subject?.trim() || null, message.trim(), ip]
    );

    // Also subscribe if checkbox checked
    if (subscribe) {
      const token = generateToken();
      await pool.query(
        `INSERT INTO nb_subscribers (email, name, source, unsubscribe_token, ip)
         VALUES ($1, $2, 'contact_form', $3, $4)
         ON CONFLICT (email) DO UPDATE SET
           name = COALESCE(EXCLUDED.name, nb_subscribers.name),
           status = 'active',
           updated_at = NOW()`,
        [email.trim(), name.trim(), token, ip]
      );
    }

    // Send email notification
    try {
      await transporter.sendMail({
        from: SMTP_FROM,
        to: 'namibarden@gmail.com',
        replyTo: email.trim(),
        subject: `New contact from ${name} — NamiBarden.com`,
        html: `<h3>New Contact Form Submission</h3>
          <p><strong>Name:</strong> ${escapeHtml(name)}</p>
          <p><strong>Email:</strong> ${escapeHtml(email)}</p>
          <p><strong>Subject:</strong> ${escapeHtml(subject || 'N/A')}</p>
          <p><strong>Message:</strong></p>
          <p>${escapeHtml(message).replace(/\n/g, '<br>')}</p>
          <hr><p style="color:#999; font-size:12px;">From namibarden.com contact form</p>`
      });
    } catch (e) { logger.error({ err: e }, 'Email send failed'); }

    // WhatsApp notification to Nami
    const snippet = message.length > 200 ? message.slice(0, 200) + '...' : message;
    sendWhatsApp(NAMI_JID, `📬 New NamiBarden contact:\n${name} <${email}>\n${subject ? `Subject: ${subject}\n` : ''}${snippet}`).catch(e => logger.error({ err: e }, 'WhatsApp fire-and-forget error'));

    res.json({ ok: true });
  } catch (e) {
    logger.error({ err: e }, 'Contact error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/subscribe ───
app.post('/api/subscribe', async (req, res) => {
  try {
    const ip = getIP(req);
    if (!rateLimit(`subscribe:${ip}`, 5, 3600000)) {
      return res.status(429).json({ error: 'Too many requests' });
    }
    const { email, name, source } = req.body;
    if (!email?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Valid email required' });
    }

    const token = generateToken();
    const result = await pool.query(
      `INSERT INTO nb_subscribers (email, name, source, unsubscribe_token, ip)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email) DO UPDATE SET
         name = COALESCE(EXCLUDED.name, nb_subscribers.name),
         source = COALESCE(EXCLUDED.source, nb_subscribers.source),
         status = 'active',
         updated_at = NOW()
       RETURNING id, xmax`,
      [email.trim(), name?.trim() || null, source || 'pdf_download', token, ip]
    );

    const isNew = result.rows[0].xmax === '0';
    if (isNew) {
      sendWhatsApp(NAMI_JID, `📬 New subscriber: ${email}${source ? ` (${source})` : ''}`).catch(e => logger.error({ err: e }, 'WhatsApp fire-and-forget error'));
    }

    res.json({ ok: true, new: isNew });
  } catch (e) {
    logger.error({ err: e }, 'Subscribe error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /api/track/open/:trackingId ───
app.get('/api/track/open/:trackingId', async (req, res) => {
  res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
  res.send(PIXEL);

  try {
    const { trackingId } = req.params;
    const ip = getIP(req);
    const ua = req.headers['user-agent'] || '';

    await pool.query(
      'INSERT INTO nb_email_events (tracking_id, event_type, ip, user_agent) VALUES ($1, $2, $3, $4)',
      [trackingId, 'open', ip, ua]
    );

    // Update recipient status + campaign count (only first open)
    const r = await pool.query(
      `UPDATE nb_campaign_recipients SET status = 'opened', opened_at = COALESCE(opened_at, NOW())
       WHERE tracking_id = $1 AND opened_at IS NULL RETURNING campaign_id`,
      [trackingId]
    );
    if (r.rows.length > 0) {
      await pool.query('UPDATE nb_campaigns SET open_count = open_count + 1 WHERE id = $1', [r.rows[0].campaign_id]);
    }
  } catch (e) { logger.error({ err: e }, 'Track open error'); }
});

// ─── GET /api/track/click/:trackingId ───
app.get('/api/track/click/:trackingId', async (req, res) => {
  const { trackingId } = req.params;
  let url = req.query.url || SITE_URL;

  // Validate redirect URL: domain allowlist — only permit known safe destinations
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
        (parsed.port && parsed.port !== '443') ||
        !REDIRECT_ALLOWLIST.includes(hostname)) {
      logger.warn({ hostname }, 'Redirect blocked — not in allowlist');
      url = SITE_URL;
    }
  } catch {
    url = SITE_URL;
  }

  try {
    const ip = getIP(req);
    const ua = req.headers['user-agent'] || '';

    await pool.query(
      'INSERT INTO nb_email_events (tracking_id, event_type, url, ip, user_agent) VALUES ($1, $2, $3, $4, $5)',
      [trackingId, 'click', url, ip, ua]
    );

    // Update recipient status + campaign count (only first click)
    const r = await pool.query(
      `UPDATE nb_campaign_recipients SET status = 'clicked', clicked_at = COALESCE(clicked_at, NOW())
       WHERE tracking_id = $1 AND clicked_at IS NULL RETURNING campaign_id`,
      [trackingId]
    );
    if (r.rows.length > 0) {
      await pool.query('UPDATE nb_campaigns SET click_count = click_count + 1 WHERE id = $1', [r.rows[0].campaign_id]);
    }
  } catch (e) { logger.error({ err: e }, 'Track click error'); }

  res.redirect(url);
});

// ─── GET /api/unsubscribe/:token ───
app.get('/api/unsubscribe/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const r = await pool.query('SELECT email FROM nb_subscribers WHERE unsubscribe_token = $1', [token]);
    if (r.rows.length === 0) return res.status(404).send(unsubPage('Link not found', 'This unsubscribe link is invalid or expired.'));
    res.send(unsubPage('Unsubscribe', `Unsubscribe <strong>${escapeHtml(r.rows[0].email)}</strong> from our mailing list?`, token));
  } catch (e) {
    logger.error({ err: e }, 'Unsubscribe page error');
    res.status(500).send(unsubPage('Error', 'Something went wrong.'));
  }
});

// ─── POST /api/unsubscribe/:token ───
app.post('/api/unsubscribe/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const r = await pool.query(
      `UPDATE nb_subscribers SET status = 'unsubscribed', updated_at = NOW()
       WHERE unsubscribe_token = $1 AND status = 'active' RETURNING id, email`,
      [token]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found or already unsubscribed' });

    // Log event for any active campaign recipients
    await pool.query(
      `UPDATE nb_campaign_recipients SET status = 'unsubscribed'
       WHERE subscriber_id = $1 AND status NOT IN ('bounced', 'unsubscribed')`,
      [r.rows[0].id]
    );

    res.json({ ok: true, message: 'You have been unsubscribed.' });
  } catch (e) {
    logger.error({ err: e }, 'Unsubscribe error');
    res.status(500).json({ error: 'Server error' });
  }
});


// ══════════════════════════════════════
// STRIPE ENDPOINTS
// ══════════════════════════════════════

// ─── POST /api/stripe/create-checkout-session ───
app.post('/api/stripe/create-checkout-session', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments not configured' });
  try {
    const ip = getIP(req);
    if (!rateLimit(`stripe:${ip}`, 5, 300000)) {
      return res.status(429).json({ error: 'Too many requests' });
    }

    const { email, name, product, lang, token: upgradeToken } = req.body;
    const en = lang === 'en';

    // Validate course-2-upgrade: must own course-1
    if (product === 'course-2-upgrade') {
      if (!upgradeToken) return res.status(400).json({ error: 'Token required for upgrade' });
      const check = await pool.query(
        `SELECT email FROM nb_course_access WHERE access_token = $1 AND course_id = 'course-1' LIMIT 1`,
        [upgradeToken]
      );
      if (check.rows.length === 0) return res.status(403).json({ error: 'Course 1 ownership required' });
    }

    const products = {
      coaching: {
        name: en ? 'Executive Coaching — Monthly Plan' : 'エグゼクティブ・コーチング月額プラン',
        description: en ? '1x/month 90-min Zoom session + text support + online course' : '月1回・90分Zoomセッション + テキストサポート + オンライン講座',
        amount: 88000,
        mode: 'subscription',
        interval: 'month'
      },
      'certification-monthly': {
        name: en ? 'Consciousness Coach Certification — Monthly Plan' : '意識学コーチ認定コース — 月額プラン',
        description: en ? '1x/month 60-min Zoom + text support + assignments + certificate' : '月1回・60分Zoomセッション + テキストサポート + 実践課題 + 認定証',
        amount: 50000,
        mode: 'subscription',
        interval: 'month'
      },
      'certification-lumpsum': {
        name: en ? 'Consciousness Coach Certification — One-Time Payment' : '意識学コーチ認定コース — 一括払いプラン',
        description: en ? '12-month certification program (save ¥40,000)' : '12ヶ月認定プログラム一括払い（¥40,000お得）',
        amount: 560000,
        mode: 'payment'
      },
      'course-1': {
        name: COURSES['course-1'].name,
        description: en ? '8-lesson video course — attract your ideal partnership' : '全8レッスン動画コース — 意識の4ステップで本当のパートナーシップを引き寄せる',
        amount: 7800,
        mode: 'payment'
      },
      'course-2': {
        name: COURSES['course-2'].name,
        description: en ? '11 lessons — resolve relationship issues at a deeper level' : '全11レッスン — パートナーシップの問題を心の深いレベルから解決',
        amount: 9800,
        mode: 'payment'
      },
      'course-bundle': {
        name: `${COURSES['course-1'].name} + ${COURSES['course-2'].name} ${en ? 'Bundle' : 'セット'}`,
        description: en ? '19 lessons + bonus meditation (save ¥2,800)' : '全19レッスン＋ボーナス瞑想（2,800円おトク）',
        amount: 14800,
        mode: 'payment'
      },
      'course-2-upgrade': {
        name: COURSES['course-2'].name + (en ? ' (Upgrade)' : '（コース1受講者限定）'),
        description: en ? 'Special price for Course 1 students (save ¥2,800)' : 'コース1受講者特別価格（¥2,800おトク）',
        amount: 7000,
        mode: 'payment'
      },
      'single-session': {
        name: en ? 'Private Consultation Session (60 min)' : '心の相談室 — パーソナルセッション（60分）',
        description: en ? 'A private 60-minute Zoom session with Nami Barden' : 'ナミ・バーデンとの60分プライベートZoomセッション',
        amount: 20000,
        mode: 'payment'
      },
      'couples-monthly': {
        name: en ? 'Couples Coaching — Monthly Plan' : 'カップルコーチング — 月額プラン',
        description: en ? '6-month couples coaching program (¥25,000/month)' : '6ヶ月カップルコーチング（月額¥25,000）',
        amount: 25000,
        mode: 'subscription',
        recurring: { interval: 'month', interval_count: 1 }
      },
      'couples-lumpsum': {
        name: en ? 'Couples Coaching — One-Time Payment' : 'カップルコーチング — 一括払い',
        description: en ? '6-month couples coaching program (save ¥25,000)' : '6ヶ月カップルコーチング一括払い（¥25,000お得）',
        amount: 125000,
        mode: 'payment'
      }
    };

    const prod = products[product || 'coaching'];
    if (!prod) return res.status(400).json({ error: 'Invalid product' });

    const priceData = {
      currency: 'jpy',
      product_data: { name: prod.name, description: prod.description },
      unit_amount: prod.amount
    };
    if (prod.recurring) priceData.recurring = prod.recurring;
    else if (prod.interval) priceData.recurring = { interval: prod.interval };

    const sessionParams = {
      mode: prod.mode,
      payment_method_types: ['card'],
      line_items: [{
        price_data: priceData,
        quantity: 1
      }],
      success_url: product === 'course-2-upgrade'
        ? `${SITE_URL}/watch?token=${upgradeToken || ''}&course=course-2`
        : product === 'single-session' || product?.startsWith('couples-')
        ? `${SITE_URL}/${product?.startsWith('couples-') ? 'couples-coaching' : ('consultation' + (en ? '-en' : ''))}?paid=1&session_id={CHECKOUT_SESSION_ID}`
        : `${SITE_URL}/payment-success${en ? '-en' : ''}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: product === 'course-2-upgrade'
        ? `${SITE_URL}/watch?token=${upgradeToken || ''}`
        : product === 'single-session'
        ? `${SITE_URL}/consultation${en ? '-en' : ''}`
        : product?.startsWith('couples-')
        ? `${SITE_URL}/couples-coaching`
        : `${SITE_URL}/payment-cancel${en ? '-en' : ''}`,
      locale: 'auto',
      metadata: { product: product || 'coaching' },
      saved_payment_method_options: { payment_method_save: 'disabled' }
    };

    if (prod.mode === 'payment') {
      sessionParams.invoice_creation = { enabled: true };
    }

    if (product === 'course-2-upgrade') {
      const r = await pool.query(`SELECT email FROM nb_course_access WHERE access_token = $1 LIMIT 1`, [upgradeToken]);
      if (r.rows[0]?.email) sessionParams.customer_email = r.rows[0].email;
    } else if (email) {
      sessionParams.customer_email = email;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    res.json({ url: session.url });
  } catch (e) {
    logger.error({ err: e }, 'Stripe checkout error');
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// ─── GET /api/stripe/verify-session ───
// Validates that a Stripe checkout session was actually paid
app.get('/api/stripe/verify-session', async (req, res) => {
  if (!stripe) return res.status(503).json({ valid: false });
  const { session_id } = req.query;
  if (!session_id || typeof session_id !== 'string') return res.json({ valid: false });
  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    const sessionProducts = ['single-session', 'couples-monthly', 'couples-lumpsum'];
    res.json({ valid: session.payment_status === 'paid' && sessionProducts.includes(session.metadata?.product) });
  } catch {
    res.json({ valid: false });
  }
});

// ─── POST /api/stripe/webhook ───
app.post('/api/stripe/webhook', async (req, res) => {
  if (!stripe) return res.sendStatus(503);

  let event;
  try {
    const sig = req.headers['stripe-signature'];
    if (!STRIPE_WEBHOOK_SECRET) {
      logger.error('Stripe webhook secret not configured — rejecting webhook');
      return res.status(503).json({ error: 'Webhook signing not configured' });
    }
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    logger.error({ err: e }, 'Stripe webhook signature failed');
    return res.status(400).json({ error: 'Webhook signature verification failed' });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const customerId = session.customer;
        const email = session.customer_details?.email || session.customer_email;
        const name = session.customer_details?.name || null;
        const product = session.metadata?.product || 'coaching';

        // Course purchases (one-time payment)
        if (['course-1', 'course-2', 'course-bundle', 'course-2-upgrade'].includes(product)) {
          const custId = await upsertCustomer(email, name, customerId || `onetime_${session.id}`);

          // Record payment
          await pool.query(
            `INSERT INTO nb_payments (customer_id, stripe_payment_intent_id, stripe_invoice_id, amount, currency, status, product_name)
             VALUES ($1, $2, $3, $4, $5, 'succeeded', $6)
             ON CONFLICT (stripe_payment_intent_id) DO NOTHING`,
            [custId, session.payment_intent, null, session.amount_total, session.currency, product]
          );

          // Determine which courses to grant — bundle shares one token
          const courseIds = product === 'course-bundle' ? ['course-1', 'course-2']
            : product === 'course-2-upgrade' ? ['course-2'] : [product];

          // For upgrades, reuse existing token so the customer's watch link stays the same
          let accessToken;
          if (product === 'course-2-upgrade') {
            const existing = await pool.query(
              `SELECT access_token FROM nb_course_access WHERE customer_id = $1 AND course_id = 'course-1' LIMIT 1`,
              [custId]
            );
            accessToken = existing.rows[0]?.access_token || generateToken();
          } else {
            accessToken = generateToken();
          }

          for (const courseId of courseIds) {
            await pool.query(
              `INSERT INTO nb_course_access (customer_id, course_id, access_token, email, stripe_session_id)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (customer_id, course_id) DO UPDATE SET
                 access_token = EXCLUDED.access_token, stripe_session_id = EXCLUDED.stripe_session_id`,
              [custId, courseId, accessToken, email, session.id]
            );
          }

          const token = accessToken;

          // Send access email
          const courseNames = courseIds.map(id => COURSES[id]?.name).join(' & ');
          const watchUrl = `${SITE_URL}/watch?token=${token}`;
          try {
            await transporter.sendMail({
              from: SMTP_FROM,
              to: email,
              subject: `【NamiBarden】${courseNames} — ご購入ありがとうございます`,
              html: `<div style="max-width:600px;margin:0 auto;font-family:'Helvetica Neue',Arial,sans-serif;color:#2C2419;background:#FAF7F2;padding:40px;">
                <h2 style="font-size:1.4rem;color:#2C2419;margin-bottom:24px;">ご購入ありがとうございます</h2>
                <p style="line-height:1.8;margin-bottom:16px;">${name ? escapeHtml(name) + '様' : ''},</p>
                <p style="line-height:1.8;margin-bottom:16px;">「${escapeHtml(courseNames)}」のご購入、誠にありがとうございます。</p>
                <p style="line-height:1.8;margin-bottom:24px;">下のボタンをクリックして、すぐに視聴を開始できます。</p>
                <p style="text-align:center;margin:32px 0;">
                  <a href="${watchUrl}" style="display:inline-block;padding:14px 40px;background:#A8895E;color:#fff;text-decoration:none;border-radius:2px;font-size:1rem;letter-spacing:0.05em;">コースを視聴する</a>
                </p>
                <p style="line-height:1.8;margin-bottom:8px;font-size:0.9rem;color:#8B7E6E;">このリンクはあなた専用です。他の方と共有しないでください。</p>
                <p style="line-height:1.8;font-size:0.9rem;color:#8B7E6E;">リンクを紛失した場合は、購入時のメールアドレスで再送できます。</p>
                <hr style="border:none;border-top:1px solid #E8DFD3;margin:32px 0;">
                <p style="font-size:0.8rem;color:#A99E8F;text-align:center;">Nami Barden — namibarden.com</p>
              </div>`
            });
          } catch (e) { logger.error({ err: e }, 'Course access email failed'); }

          // WhatsApp notify Nami
          const amount = session.amount_total;
          sendWhatsApp(NAMI_JID,
            `🎓 コース購入!\n${name || email}\n${courseNames}\n¥${amount?.toLocaleString()}`).catch(e => logger.error({ err: e }, 'WhatsApp fire-and-forget error'));

          logger.info({ product, email }, "Stripe: course purchased");
          break;
        }

        // Single-session or other one-time payments (non-course)
        if (session.mode === 'payment' && ['single-session', 'certification-lumpsum', 'couples-lumpsum'].includes(product)) {
          const custId = await upsertCustomer(email, name, customerId || `onetime_${session.id}`);

          await pool.query(
            `INSERT INTO nb_payments (customer_id, stripe_payment_intent_id, stripe_invoice_id, amount, currency, status, product_name)
             VALUES ($1, $2, $3, $4, $5, 'succeeded', $6)
             ON CONFLICT (stripe_payment_intent_id) DO NOTHING`,
            [custId, session.payment_intent, null, session.amount_total, session.currency, product]
          );

          const amount = session.amount_total;
          const label = product === 'single-session' ? 'パーソナルセッション'
            : product === 'couples-lumpsum' ? 'カップルコーチング（一括）'
            : 'コーチ認定コース（一括）';
          sendWhatsApp(NAMI_JID,
            `💫 ${label}購入!\n${name || email}\n¥${amount?.toLocaleString()}`).catch(e => logger.error({ err: e }, 'WhatsApp fire-and-forget error'));

          // Send confirmation email for single session
          if (product === 'single-session' && email) {
            try {
              await transporter.sendMail({
                from: SMTP_FROM,
                to: email,
                subject: '【NamiBarden】心の相談室 — お申し込みありがとうございます',
                html: `<div style="max-width:600px;margin:0 auto;font-family:'Helvetica Neue',Arial,sans-serif;color:#2C2419;background:#FAF7F2;padding:40px;">
                  <h2 style="font-size:1.4rem;color:#2C2419;margin-bottom:24px;">お申し込みありがとうございます</h2>
                  <p style="line-height:1.8;margin-bottom:16px;">${name ? escapeHtml(name) + '様' : ''},</p>
                  <p style="line-height:1.8;margin-bottom:16px;">心の相談室 パーソナルセッション（60分）のお申し込み、誠にありがとうございます。</p>
                  <p style="line-height:1.8;margin-bottom:16px;">ナミより、24時間以内にメールにてセッション日程の調整をご連絡いたします。</p>
                  <p style="line-height:1.8;margin-bottom:24px;">ご不明な点がございましたら、このメールにご返信ください。</p>
                  <hr style="border:none;border-top:1px solid #E8DFD3;margin:32px 0;">
                  <p style="font-size:0.8rem;color:#A99E8F;text-align:center;">Nami Barden — namibarden.com</p>
                </div>`
              });
            } catch (e) { logger.error({ err: e }, 'Single session email failed'); }
          }

          logger.info({ product, email }, "Stripe: payment purchased");
          break;
        }

        // Subscription handling (coaching etc.)
        if (session.mode === 'subscription') {
          const custId = await upsertCustomer(email, name, customerId);

          // Record subscription
          const sub = await stripe.subscriptions.retrieve(session.subscription);
          await pool.query(
            `INSERT INTO nb_subscriptions (customer_id, stripe_subscription_id, stripe_price_id, status, product_name, current_period_start, current_period_end)
             VALUES ($1, $2, $3, $4, $5, to_timestamp($6), to_timestamp($7))
             ON CONFLICT (stripe_subscription_id) DO UPDATE SET
               status = EXCLUDED.status, current_period_start = EXCLUDED.current_period_start,
               current_period_end = EXCLUDED.current_period_end, updated_at = NOW()`,
            [custId, sub.id, sub.items.data[0].price.id, sub.status, product,
             sub.current_period_start, sub.current_period_end]
          );

          // Notify Nami
          const subLabel = product === 'couples-monthly' ? 'カップルコーチング' : 'コーチング';
          const subAmount = sub.items.data[0]?.price?.unit_amount;
          sendWhatsApp(NAMI_JID,
            `💳 新規${subLabel}契約!\n${name || email}\n¥${subAmount?.toLocaleString() || '??'}/月サブスクリプション開始`).catch(e => logger.error({ err: e }, 'WhatsApp fire-and-forget error'));

          logger.info({ subscriptionId: sub.id, email }, "Stripe: new subscription");
        }
        break;
      }

      case 'customer.subscription.updated': {
        try {
          const sub = event.data.object;
          await pool.query(
            `UPDATE nb_subscriptions SET
               status = $1, current_period_start = to_timestamp($2), current_period_end = to_timestamp($3),
               cancel_at = $4, canceled_at = $5, updated_at = NOW()
             WHERE stripe_subscription_id = $6`,
            [sub.status, sub.current_period_start, sub.current_period_end,
             sub.cancel_at ? new Date(sub.cancel_at * 1000) : null,
             sub.canceled_at ? new Date(sub.canceled_at * 1000) : null,
             sub.id]
          );
          logger.info({ subscriptionId: sub.id, status: sub.status }, "Stripe: subscription updated");
        } catch (e) {
          logger.error({ err: e, eventType: 'customer.subscription.updated' }, 'Stripe webhook case error');
        }
        break;
      }

      case 'customer.subscription.deleted': {
        try {
          const sub = event.data.object;
          await pool.query(
            `UPDATE nb_subscriptions SET status = 'canceled', canceled_at = NOW(), updated_at = NOW()
             WHERE stripe_subscription_id = $1`,
            [sub.id]
          );

          // Notify Nami
          const custRow = await pool.query(
            `SELECT c.email, c.name FROM nb_customers c JOIN nb_subscriptions s ON s.customer_id = c.id
             WHERE s.stripe_subscription_id = $1`, [sub.id]
          );
          if (custRow.rows.length > 0) {
            sendWhatsApp(NAMI_JID,
              `⚠️ コーチング契約キャンセル\n${custRow.rows[0].name || custRow.rows[0].email}`).catch(e => logger.error({ err: e }, 'WhatsApp fire-and-forget error'));
          }
          logger.info({ subscriptionId: sub.id }, "Stripe: subscription canceled");
        } catch (e) {
          logger.error({ err: e, eventType: 'customer.subscription.deleted' }, 'Stripe webhook case error');
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        try {
          const invoice = event.data.object;
          const custRow = await pool.query(
            'SELECT id FROM nb_customers WHERE stripe_customer_id = $1',
            [invoice.customer]
          );
          if (custRow.rows.length > 0) {
            // Look up product name from subscription record
            let invoiceProduct = 'coaching';
            if (invoice.subscription) {
              const subRow = await pool.query(
                'SELECT product_name FROM nb_subscriptions WHERE stripe_subscription_id = $1',
                [invoice.subscription]
              );
              if (subRow.rows[0]?.product_name) invoiceProduct = subRow.rows[0].product_name;
            }
            await pool.query(
              `INSERT INTO nb_payments (customer_id, stripe_payment_intent_id, stripe_invoice_id, amount, currency, status, product_name)
               VALUES ($1, $2, $3, $4, $5, 'succeeded', $6)
               ON CONFLICT (stripe_payment_intent_id) DO NOTHING`,
              [custRow.rows[0].id, invoice.payment_intent, invoice.id,
               invoice.amount_paid, invoice.currency, invoiceProduct]
            );
          }
          logger.info({ invoiceId: invoice.id }, "Stripe: payment succeeded");
        } catch (e) {
          logger.error({ err: e, eventType: 'invoice.payment_succeeded' }, 'Stripe webhook case error');
        }
        break;
      }

      case 'invoice.payment_failed': {
        try {
          const invoice = event.data.object;
          const custRow = await pool.query(
            'SELECT c.email, c.name FROM nb_customers c WHERE c.stripe_customer_id = $1',
            [invoice.customer]
          );
          if (custRow.rows.length > 0) {
            sendWhatsApp(NAMI_JID,
              `⚠️ 支払い失敗\n${custRow.rows[0].name || custRow.rows[0].email}\nStripeダッシュボードを確認してください`).catch(e => logger.error({ err: e }, 'WhatsApp fire-and-forget error'));
          }
          logger.warn({ invoiceId: invoice.id }, "Stripe: payment failed");
        } catch (e) {
          logger.error({ err: e, eventType: 'invoice.payment_failed' }, 'Stripe webhook case error');
        }
        break;
      }
    }
  } catch (e) {
    logger.error({ err: e }, 'Stripe webhook processing error');
  }

  res.json({ received: true });
});

// ─── POST /api/stripe/customer-portal ───
app.post('/api/stripe/customer-portal', customerAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments not configured' });
  try {
    // Use the authenticated customer's email from JWT, not request body
    const email = req.customer.email;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const custRow = await pool.query(
      'SELECT stripe_customer_id FROM nb_customers WHERE email = $1', [email]
    );
    if (custRow.rows.length === 0 || !custRow.rows[0].stripe_customer_id) {
      return res.status(404).json({ error: 'No subscription found for this email' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: custRow.rows[0].stripe_customer_id,
      return_url: `${SITE_URL}/executive-coaching`
    });
    res.json({ url: session.url });
  } catch (e) {
    logger.error({ err: e }, 'Stripe portal error');
    res.status(500).json({ error: 'Failed to create portal session' });
  }
});


// ══════════════════════════════════════
// COURSE VIDEO ENDPOINTS
// ══════════════════════════════════════

// ─── GET /api/courses/verify ───
app.get('/api/courses/verify', async (req, res) => {
  try {
    const ip = getIP(req);
    if (!rateLimit(`course-verify:${ip}`, 10, 60000)) {
      return res.status(429).json({ error: 'Too many requests' });
    }
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Token required' });

    const r = await pool.query(
      `SELECT course_id, email FROM nb_course_access
       WHERE access_token = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
      [token]
    );
    if (r.rows.length === 0) return res.status(403).json({ error: 'Invalid or expired token' });

    const courses = r.rows.map(row => ({
      id: row.course_id,
      name: COURSES[row.course_id]?.name || row.course_id,
      lessonCount: COURSES[row.course_id]?.lessons?.length || 0
    }));

    // Don't expose email — token holders are not necessarily the account owner
    res.json({ ok: true, courses });
  } catch (e) {
    logger.error({ err: e }, 'Course verify error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /api/courses/:courseId/lessons ───
app.get('/api/courses/:courseId/lessons', async (req, res) => {
  try {
    const ip = getIP(req);
    if (!rateLimit(`course-lessons:${ip}`, 20, 60000)) {
      return res.status(429).json({ error: 'Too many requests' });
    }
    const { token } = req.query;
    const { courseId } = req.params;
    if (!token) return res.status(401).json({ error: 'Token required' });

    const course = COURSES[courseId];
    if (!course) return res.status(404).json({ error: 'Course not found' });

    if (!await verifyCourseAccess(token, courseId)) return res.status(403).json({ error: 'Access denied' });

    res.json({ courseId, name: course.name, lessons: course.lessons });
  } catch (e) {
    logger.error({ err: e }, 'Course lessons error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /api/preview/:courseId/:lessonId/hls/* — Public preview videos (no token required) ───
const PREVIEW_LESSONS = { 'course-1': ['promo', 'lesson-2'] };
app.get('/api/preview/:courseId/:lessonId/hls/*', async (req, res) => {
  try {
    if (!r2) return res.status(503).json({ error: 'Video hosting not configured' });
    const ip = getIP(req);
    if (!rateLimit(`preview-hls:${ip}`, 100, 60000)) {
      return res.status(429).json({ error: 'Too many requests' });
    }
    const { courseId, lessonId } = req.params;
    const filePath = req.params[0];
    const allowed = PREVIEW_LESSONS[courseId];
    if (!allowed || !allowed.includes(lessonId)) return res.status(404).json({ error: 'Not found' });

    // Block path traversal
    if (/\.\./.test(filePath) || filePath.startsWith('/')) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    const r2Key = `courses/${courseId}/${lessonId}/${filePath}`;

    if (filePath.endsWith('.ts')) {
      const obj = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: r2Key }));
      res.set('Content-Type', 'video/mp2t');
      if (obj.ContentLength) res.set('Content-Length', String(obj.ContentLength));
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      obj.Body.transformToWebStream().pipeTo(
        new WritableStream({
          write(chunk) { res.write(chunk); },
          close() { res.end(); },
          abort() { res.destroy(); }
        })
      ).catch(() => { if (!res.destroyed) res.destroy(); });
      return;
    }

    if (filePath.endsWith('.m3u8')) {
      const obj = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: r2Key }));
      let body = await obj.Body.transformToString();
      body = body.replace(/^\uFEFF/, '');
      const baseApiPath = `/api/preview/${courseId}/${lessonId}/hls`;
      const dir = filePath.includes('/') ? filePath.substring(0, filePath.lastIndexOf('/')) : '';
      body = body.replace(/^(?!#)(.+)$/gm, (match, line) => {
        const trimmed = line.trim();
        if (!trimmed) return match;
        const fullPath = dir ? `${dir}/${trimmed}` : trimmed;
        return `${baseApiPath}/${fullPath}`;
      });
      res.set({ 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache' });
      return res.send(body);
    }

    res.status(400).json({ error: 'Invalid file type' });
  } catch (e) {
    if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) {
      return res.status(404).json({ error: 'Video not found' });
    }
    logger.error({ err: e }, 'Promo HLS error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /api/courses/:courseId/:lessonId/hls/* ───
// Proxies .m3u8 playlists (rewrites segment URLs) and 302-redirects .ts segments to signed R2 URLs
app.get('/api/courses/:courseId/:lessonId/hls/*', async (req, res) => {
  try {
    if (!r2) return res.status(503).json({ error: 'Video hosting not configured' });

    const ip = getIP(req);
    if (!rateLimit(`course-hls:${ip}`, 200, 60000)) {
      return res.status(429).json({ error: 'Too many requests' });
    }
    const { token } = req.query;
    const { courseId, lessonId } = req.params;
    const filePath = req.params[0]; // e.g. "master.m3u8" or "720p/stream.m3u8" or "720p/seg001.ts"
    if (!token) return res.status(401).json({ error: 'Token required' });

    // Block path traversal — reject any segment containing ".." or starting with "/"
    if (/\.\./.test(courseId) || /\.\./.test(lessonId) || /\.\./.test(filePath) ||
        courseId.includes('/') || lessonId.includes('/')) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    // Validate access (cached — avoids ~300 DB queries per video)
    if (!await verifyCourseAccess(token, courseId)) return res.status(403).json({ error: 'Access denied' });

    // Support cross-course video references (e.g. basic knowledge lessons from course-1 in course-2)
    const course = COURSES[courseId];
    const lesson = course?.lessons?.find(l => l.id === lessonId);
    const actualCourse = lesson?.sourceCourse || courseId;
    const actualLesson = lesson?.sourceLesson || lessonId;
    const r2Key = `courses/${actualCourse}/${actualLesson}/${filePath}`;

    // .ts segments → redirect to signed R2 URL (offloads bandwidth from Node)
    if (filePath.endsWith('.ts')) {
      const signedUrl = await getSignedUrl(r2, new GetObjectCommand({ Bucket: R2_BUCKET, Key: r2Key }), { expiresIn: 3600 });
      res.set('Cache-Control', 'private, max-age=3500');
      return res.redirect(302, signedUrl);
    }

    // .m3u8 playlists → fetch from R2, rewrite URLs to go through our proxy
    if (filePath.endsWith('.m3u8')) {
      const obj = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: r2Key }));
      let body = await obj.Body.transformToString();
      body = body.replace(/^\uFEFF/, '');

      // Rewrite relative segment/playlist references to go through our proxy
      const baseApiPath = `/api/courses/${courseId}/${lessonId}/hls`;
      const dir = filePath.includes('/') ? filePath.substring(0, filePath.lastIndexOf('/')) : '';

      body = body.replace(/^(?!#)(.+)$/gm, (match, line) => {
        const trimmed = line.trim();
        if (!trimmed) return match;
        const fullPath = dir ? `${dir}/${trimmed}` : trimmed;
        return `${baseApiPath}/${fullPath}?token=${token}`;
      });

      res.set({
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-cache'
      });
      return res.send(body);
    }

    res.status(400).json({ error: 'Invalid file type' });
  } catch (e) {
    if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) {
      return res.status(404).json({ error: 'Video not found' });
    }
    logger.error({ err: e }, 'HLS proxy error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/courses/resend ───
app.post('/api/courses/resend', async (req, res) => {
  try {
    const ip = getIP(req);
    if (!rateLimit(`course-resend:${ip}`, 3, 3600000)) {
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }
    const { email } = req.body;
    if (!email?.trim()) return res.status(400).json({ error: 'Email required' });

    const r = await pool.query(
      `SELECT access_token, course_id FROM nb_course_access WHERE email = $1 LIMIT 1`,
      [email.trim()]
    );
    if (r.rows.length === 0) {
      // Don't reveal whether email exists
      return res.json({ ok: true, message: 'If a purchase exists for this email, an access link has been sent.' });
    }

    const token = r.rows[0].access_token;
    const courseIds = (await pool.query(
      'SELECT course_id FROM nb_course_access WHERE access_token = $1', [token]
    )).rows.map(row => row.course_id);

    const courseNames = courseIds.map(id => COURSES[id]?.name).join(' & ');
    const watchUrl = `${SITE_URL}/watch?token=${token}`;

    try {
      await transporter.sendMail({
        from: SMTP_FROM,
        to: email.trim(),
        subject: `【NamiBarden】コース視聴リンクの再送`,
        html: `<div style="max-width:600px;margin:0 auto;font-family:'Helvetica Neue',Arial,sans-serif;color:#2C2419;background:#FAF7F2;padding:40px;">
          <h2 style="font-size:1.4rem;color:#2C2419;margin-bottom:24px;">コース視聴リンク</h2>
          <p style="line-height:1.8;margin-bottom:16px;">「${escapeHtml(courseNames)}」の視聴リンクをお送りします。</p>
          <p style="text-align:center;margin:32px 0;">
            <a href="${watchUrl}" style="display:inline-block;padding:14px 40px;background:#A8895E;color:#fff;text-decoration:none;border-radius:2px;font-size:1rem;letter-spacing:0.05em;">コースを視聴する</a>
          </p>
          <p style="font-size:0.9rem;color:#8B7E6E;">このリンクはあなた専用です。他の方と共有しないでください。</p>
          <hr style="border:none;border-top:1px solid #E8DFD3;margin:32px 0;">
          <p style="font-size:0.8rem;color:#A99E8F;text-align:center;">Nami Barden — namibarden.com</p>
        </div>`
      });
    } catch (emailErr) {
      logger.error({ err: emailErr }, 'Course resend email failed');
    }

    // Always return success to avoid revealing whether email exists
    res.json({ ok: true, message: 'If a purchase exists for this email, an access link has been sent.' });
  } catch (e) {
    logger.error({ err: e }, 'Course resend error');
    res.status(500).json({ error: 'Server error' });
  }
});


// ══════════════════════════════════════
// CUSTOMER AUTH ENDPOINTS
// ══════════════════════════════════════

function customerAuth(req, res, next) {
  const token = req.cookies?.nb_auth_token || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);
  if (!token) return res.status(401).json({ error: 'ログインが必要です' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'customer') return res.status(403).json({ error: 'Forbidden' });
    req.customer = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'セッションが期限切れです。再度ログインしてください。' });
  }
}

// ─── POST /api/auth/register ───
app.post('/api/auth/register', async (req, res) => {
  try {
    const ip = getIP(req);
    if (!rateLimit(`auth-register:${ip}`, 5, 300000)) {
      return res.status(429).json({ error: 'Too many requests' });
    }
    const { email, password, name, subscribe } = req.body;
    if (!email?.trim() || !password) return res.status(400).json({ error: 'Email and password required' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email' });
    if (password.length < 8) return res.status(400).json({ error: 'パスワードは8文字以上で入力してください' });

    const emailLower = email.trim().toLowerCase();

    // Check if customer already has a password
    const existing = await pool.query(
      'SELECT id, password_hash FROM nb_customers WHERE LOWER(email) = $1 ORDER BY updated_at DESC LIMIT 1',
      [emailLower]
    );

    if (existing.rows.length > 0 && existing.rows[0].password_hash) {
      return res.status(409).json({ error: 'このメールアドレスのアカウントは既に存在します。ログインしてください。' });
    }

    const hash = await bcrypt.hash(password, 10);

    let customerId;
    if (existing.rows.length > 0) {
      // Set password on existing customer record
      await pool.query(
        'UPDATE nb_customers SET password_hash = $1, name = COALESCE($2, name), updated_at = NOW() WHERE id = $3',
        [hash, name?.trim() || null, existing.rows[0].id]
      );
      customerId = existing.rows[0].id;
    } else {
      // Create new customer record
      const r = await pool.query(
        'INSERT INTO nb_customers (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id',
        [emailLower, name?.trim() || null, hash]
      );
      customerId = r.rows[0].id;
    }

    // Subscribe to newsletter if opted in
    if (subscribe) {
      const unsubToken = generateToken();
      await pool.query(
        `INSERT INTO nb_subscribers (email, name, source, unsubscribe_token, ip)
         VALUES ($1, $2, 'course_signup', $3, $4)
         ON CONFLICT (email) DO UPDATE SET
           name = COALESCE(EXCLUDED.name, nb_subscribers.name),
           status = 'active',
           updated_at = NOW()`,
        [emailLower, name?.trim() || null, unsubToken, getIP(req)]
      );
    }

    const token = jwt.sign({ role: 'customer', customerId, email: emailLower }, JWT_SECRET, { expiresIn: '30d' });
    setAuthCookie(res, 'nb_auth_token', token, 30 * 24 * 60 * 60 * 1000);
    res.json({ ok: true });
  } catch (e) {
    logger.error({ err: e }, 'Auth register error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/auth/login ───
app.post('/api/auth/login', async (req, res) => {
  try {
    const ip = getIP(req);
    if (!rateLimit(`auth-login:${ip}`, 5, 300000)) {
      return res.status(429).json({ error: 'ログイン試行回数が超えました。5分後にお試しください。' });
    }
    const { email, password } = req.body;
    if (!email?.trim() || !password) return res.status(400).json({ error: 'Email and password required' });

    const emailLower = email.trim().toLowerCase();
    const r = await pool.query(
      'SELECT id, email, name, password_hash FROM nb_customers WHERE LOWER(email) = $1 AND password_hash IS NOT NULL ORDER BY updated_at DESC LIMIT 1',
      [emailLower]
    );
    if (r.rows.length === 0) return res.status(401).json({ error: 'メールアドレスまたはパスワードが正しくありません。' });

    const customer = r.rows[0];
    const valid = await bcrypt.compare(password, customer.password_hash);
    if (!valid) return res.status(401).json({ error: 'メールアドレスまたはパスワードが正しくありません。' });

    const token = jwt.sign({ role: 'customer', customerId: customer.id, email: customer.email }, JWT_SECRET, { expiresIn: '30d' });
    setAuthCookie(res, 'nb_auth_token', token, 30 * 24 * 60 * 60 * 1000);
    res.json({ ok: true, name: customer.name });
  } catch (e) {
    logger.error({ err: e }, 'Auth login error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /api/auth/me ───
app.get('/api/auth/me', customerAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT c.id, c.email, c.name, c.created_at,
              COALESCE(json_agg(json_build_object(
                'course_id', ca.course_id,
                'access_token', ca.access_token,
                'purchased_at', ca.purchased_at
              )) FILTER (WHERE ca.id IS NOT NULL), '[]') AS courses
       FROM nb_customers c
       LEFT JOIN nb_course_access ca ON ca.customer_id = c.id AND (ca.expires_at IS NULL OR ca.expires_at > NOW())
       WHERE c.id = $1
       GROUP BY c.id`,
      [req.customer.customerId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Customer not found' });

    const customer = r.rows[0];
    const courses = customer.courses.map(c => ({
      id: c.course_id,
      name: COURSES[c.course_id]?.name || c.course_id,
      lessonCount: COURSES[c.course_id]?.lessons?.length || 0,
      accessToken: c.access_token,
      purchasedAt: c.purchased_at
    }));

    res.json({
      id: customer.id,
      email: customer.email,
      name: customer.name,
      memberSince: customer.created_at,
      courses
    });
  } catch (e) {
    logger.error({ err: e }, 'Auth me error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/auth/forgot-password ───
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const ip = getIP(req);
    if (!rateLimit(`auth-forgot:${ip}`, 3, 3600000)) {
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }
    const { email } = req.body;
    if (!email?.trim()) return res.status(400).json({ error: 'Email required' });

    const emailLower = email.trim().toLowerCase();
    const r = await pool.query(
      'SELECT id FROM nb_customers WHERE LOWER(email) = $1 AND password_hash IS NOT NULL LIMIT 1',
      [emailLower]
    );

    // Always return success (don't reveal if email exists)
    if (r.rows.length === 0) {
      return res.json({ ok: true, message: 'パスワードリセットメールを送信しました。' });
    }

    const resetToken = generateToken();
    const expires = new Date(Date.now() + 3600000); // 1 hour
    await pool.query(
      'UPDATE nb_customers SET reset_token = $1, reset_token_expires = $2 WHERE id = $3',
      [resetToken, expires, r.rows[0].id]
    );

    const resetUrl = `${SITE_URL}/reset-password?token=${resetToken}`;
    try {
    await transporter.sendMail({
      from: SMTP_FROM,
      to: emailLower,
      subject: '【NamiBarden】パスワードリセット',
      html: `<div style="max-width:600px;margin:0 auto;font-family:'Helvetica Neue',Arial,sans-serif;color:#2C2419;background:#FAF7F2;padding:40px;">
        <h2 style="font-size:1.4rem;color:#2C2419;margin-bottom:24px;">パスワードリセット</h2>
        <p style="line-height:1.8;margin-bottom:16px;">パスワードリセットのリクエストを受け付けました。</p>
        <p style="line-height:1.8;margin-bottom:24px;">下のボタンをクリックして新しいパスワードを設定してください。このリンクは1時間有効です。</p>
        <p style="text-align:center;margin:32px 0;">
          <a href="${resetUrl}" style="display:inline-block;padding:14px 40px;background:#A8895E;color:#fff;text-decoration:none;border-radius:2px;font-size:1rem;letter-spacing:0.05em;">パスワードをリセット</a>
        </p>
        <p style="font-size:0.85rem;color:#8B7E6E;margin-top:24px;">このリクエストに心当たりがない場合は、このメールを無視してください。</p>
        <hr style="border:none;border-top:1px solid #E8DFD3;margin:32px 0;">
        <p style="font-size:0.8rem;color:#A99E8F;text-align:center;">Nami Barden — namibarden.com</p>
      </div>`
    });
    } catch (emailErr) {
      logger.error({ err: emailErr }, 'Forgot password email send failed');
    }

    // Always return success to avoid revealing whether email exists
    res.json({ ok: true, message: 'パスワードリセットメールを送信しました。' });
  } catch (e) {
    logger.error({ err: e }, 'Forgot password error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/auth/reset-password ───
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const ip = getIP(req);
    if (!rateLimit(`auth-reset:${ip}`, 5, 300000)) {
      return res.status(429).json({ error: 'Too many requests' });
    }
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
    if (password.length < 8) return res.status(400).json({ error: 'パスワードは8文字以上で入力してください' });

    const r = await pool.query(
      'SELECT id, email FROM nb_customers WHERE reset_token = $1 AND reset_token_expires > NOW()',
      [token]
    );
    if (r.rows.length === 0) return res.status(400).json({ error: 'リンクが無効または期限切れです。再度パスワードリセットをお試しください。' });

    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      'UPDATE nb_customers SET password_hash = $1, reset_token = NULL, reset_token_expires = NULL, updated_at = NOW() WHERE id = $2',
      [hash, r.rows[0].id]
    );

    const authToken = jwt.sign({ role: 'customer', customerId: r.rows[0].id, email: r.rows[0].email }, JWT_SECRET, { expiresIn: '30d' });
    setAuthCookie(res, 'nb_auth_token', authToken, 30 * 24 * 60 * 60 * 1000);
    res.json({ ok: true });
  } catch (e) {
    logger.error({ err: e }, 'Reset password error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/auth/logout ───
app.post('/api/auth/logout', (req, res) => {
  clearAuthCookie(res, 'nb_auth_token');
  res.json({ ok: true });
});

// ─── GET /api/auth/check ─── lightweight cookie-based auth check (no DB hit)
app.get('/api/auth/check', (req, res) => {
  const token = req.cookies?.nb_auth_token;
  if (!token) return res.json({ authenticated: false });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role === 'customer') return res.json({ authenticated: true, name: decoded.email });
    res.json({ authenticated: false });
  } catch {
    res.json({ authenticated: false });
  }
});


// ══════════════════════════════════════
// ADMIN ENDPOINTS
// ══════════════════════════════════════

// ─── POST /api/admin/login ───
app.post('/api/admin/login', async (req, res) => {
  try {
    const ip = getIP(req);
    if (!rateLimit(`login:${ip}`, 5, 300000)) {
      return res.status(429).json({ error: 'Too many login attempts' });
    }
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password required' });

    // Authenticate via DB hash only (constant-time comparison via bcrypt)
    let valid = false;
    const r = await pool.query('SELECT password_hash FROM nb_admin ORDER BY id LIMIT 1');
    if (r.rows.length > 0) {
      valid = await bcrypt.compare(password, r.rows[0].password_hash);
    }

    if (!valid) return res.status(401).json({ error: 'Invalid password' });
    const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
    setAuthCookie(res, 'nb_admin_token', token, 24 * 60 * 60 * 1000);
    res.json({ ok: true });
  } catch (e) {
    logger.error({ err: e }, 'Admin login error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/admin/logout ───
app.post('/api/admin/logout', (req, res) => {
  clearAuthCookie(res, 'nb_admin_token');
  res.json({ ok: true });
});

// ─── GET /api/admin/check ─── cookie-based auth check for frontend
app.get('/api/admin/check', authMiddleware, (req, res) => {
  res.json({ ok: true });
});

// ─── GET /api/admin/stats ───
app.get('/api/admin/stats', authMiddleware, async (req, res) => {
  try {
    const [subs, contacts, campaigns, recent, sources, growth] = await Promise.all([
      pool.query(`SELECT
        COUNT(*) FILTER (WHERE status = 'active') AS active,
        COUNT(*) FILTER (WHERE status = 'unsubscribed') AS unsubscribed,
        COUNT(*) FILTER (WHERE status = 'bounced') AS bounced,
        COUNT(*) AS total
        FROM nb_subscribers`),
      pool.query('SELECT COUNT(*) AS total FROM nb_contacts'),
      pool.query(`SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status = 'sent') AS sent,
        COALESCE(SUM(open_count), 0) AS total_opens,
        COALESCE(SUM(click_count), 0) AS total_clicks
        FROM nb_campaigns`),
      pool.query(`SELECT id, subject, status, sent_count, open_count, click_count, sent_at
        FROM nb_campaigns ORDER BY created_at DESC LIMIT 5`),
      pool.query(`SELECT source, COUNT(*) AS count FROM nb_subscribers
        WHERE status = 'active' GROUP BY source ORDER BY count DESC`),
      pool.query(`SELECT DATE(created_at) AS date, COUNT(*) AS count
        FROM nb_subscribers WHERE created_at > NOW() - INTERVAL '30 days'
        GROUP BY DATE(created_at) ORDER BY date`)
    ]);

    res.json({
      subscribers: subs.rows[0],
      contacts: contacts.rows[0],
      campaigns: campaigns.rows[0],
      recentCampaigns: recent.rows,
      sources: sources.rows,
      growth: growth.rows
    });
  } catch (e) {
    logger.error({ err: e }, 'Stats error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /api/admin/subscribers ───
app.get('/api/admin/subscribers', authMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 50, status, source, search, tag } = req.query;
    const safeLimit = Math.min(Math.max(parseInt(limit) || 50, 1), 200);
    const safePage = Math.max(parseInt(page) || 1, 1);
    const offset = (safePage - 1) * safeLimit;
    const conditions = [];
    const params = [];
    let idx = 1;

    if (status) { conditions.push(`status = $${idx++}`); params.push(status); }
    if (source) { conditions.push(`source = $${idx++}`); params.push(source); }
    if (search) { conditions.push(`(email ILIKE $${idx} OR name ILIKE $${idx})`); params.push(`%${search}%`); idx++; }
    if (tag) { conditions.push(`$${idx++} = ANY(tags)`); params.push(tag); }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const countQ = await pool.query(`SELECT COUNT(*) FROM nb_subscribers ${where}`, params);
    params.push(safeLimit, offset);
    const dataQ = await pool.query(
      `SELECT id, email, name, source, status, tags, created_at, updated_at
       FROM nb_subscribers ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx}`,
      params
    );

    res.json({
      subscribers: dataQ.rows,
      total: parseInt(countQ.rows[0].count),
      page: safePage,
      limit: safeLimit
    });
  } catch (e) {
    logger.error({ err: e }, 'Subscribers list error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /api/admin/subscribers/export ───
app.get('/api/admin/subscribers/export', authMiddleware, async (req, res) => {
  try {
    const { status } = req.query;
    const where = status ? 'WHERE status = $1' : '';
    const params = status ? [status] : [];
    const r = await pool.query(
      `SELECT email, name, source, status, array_to_string(tags, ',') AS tags, created_at
       FROM nb_subscribers ${where} ORDER BY created_at DESC LIMIT 50000`, params
    );
    const csv = stringify(r.rows, { header: true });
    res.set({ 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename=subscribers.csv' });
    res.send(csv);
  } catch (e) {
    logger.error({ err: e }, 'Export error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/admin/import ───
app.post('/api/admin/import', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'CSV file required' });
    const records = parse(req.file.buffer.toString(), { columns: true, skip_empty_lines: true, trim: true });
    let imported = 0, skipped = 0;
    for (const row of records) {
      const email = (row.email || row.Email || '').trim().toLowerCase();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { skipped++; continue; }
      const name = (row.name || row.Name || '').trim() || null;
      const source = (row.source || row.Source || 'import').trim();
      const token = generateToken();
      const r = await pool.query(
        `INSERT INTO nb_subscribers (email, name, source, unsubscribe_token)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (email) DO NOTHING RETURNING id`,
        [email, name, source, token]
      );
      if (r.rows.length > 0) imported++; else skipped++;
    }
    res.json({ imported, skipped, total: records.length });
  } catch (e) {
    logger.error({ err: e }, 'Import error');
    res.status(500).json({ error: 'Import failed. Please check file format and try again.' });
  }
});

// ─── POST /api/admin/subscribers/:id/tags ───
app.post('/api/admin/subscribers/:id/tags', authMiddleware, async (req, res) => {
  try {
    const { tags } = req.body;
    if (!Array.isArray(tags)) return res.status(400).json({ error: 'Tags must be an array' });
    const r = await pool.query(
      'UPDATE nb_subscribers SET tags = $1, updated_at = NOW() WHERE id = $2 RETURNING id, tags',
      [tags, req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Subscriber not found' });
    res.json(r.rows[0]);
  } catch (e) {
    logger.error({ err: e }, 'Tags error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── DELETE /api/admin/subscribers/:id ───
app.delete('/api/admin/subscribers/:id', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM nb_subscribers WHERE id = $1 RETURNING id', [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) {
    logger.error({ err: e }, 'Delete subscriber error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /api/admin/contacts ───
app.get('/api/admin/contacts', authMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const safeLimit = Math.min(Math.max(parseInt(limit) || 50, 1), 200);
    const safePage = Math.max(parseInt(page) || 1, 1);
    const offset = (safePage - 1) * safeLimit;
    const [countQ, dataQ] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM nb_contacts'),
      pool.query('SELECT * FROM nb_contacts ORDER BY created_at DESC LIMIT $1 OFFSET $2', [safeLimit, offset])
    ]);
    res.json({ contacts: dataQ.rows, total: parseInt(countQ.rows[0].count), page: safePage, limit: safeLimit });
  } catch (e) {
    logger.error({ err: e }, 'Contacts error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /api/admin/campaigns ───
app.get('/api/admin/campaigns', authMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const safeLimit = Math.min(Math.max(parseInt(limit) || 50, 1), 200);
    const offset = (Math.max(parseInt(page) || 1, 1) - 1) * safeLimit;

    const [countQ, dataQ] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM nb_campaigns'),
      pool.query(
        `SELECT id, subject, status, segment, total_count, sent_count, open_count, click_count,
                bounce_count, unsub_count, created_at, sent_at
         FROM nb_campaigns ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
        [safeLimit, offset]
      )
    ]);
    res.json({ campaigns: dataQ.rows, total: parseInt(countQ.rows[0].count), page: parseInt(page), limit: safeLimit });
  } catch (e) {
    logger.error({ err: e }, 'Campaigns error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /api/admin/campaigns/:id ───
app.get('/api/admin/campaigns/:id', authMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 100 } = req.query;
    const safeLimit = Math.min(Math.max(parseInt(limit) || 100, 1), 500);
    const offset = (Math.max(parseInt(page) || 1, 1) - 1) * safeLimit;

    const campaign = await pool.query('SELECT * FROM nb_campaigns WHERE id = $1', [req.params.id]);
    if (campaign.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const [countQ, recipients] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM nb_campaign_recipients WHERE campaign_id = $1', [req.params.id]),
      pool.query(
        `SELECT r.id, r.email, r.status, r.opened_at, r.clicked_at, r.bounced_at
         FROM nb_campaign_recipients r WHERE r.campaign_id = $1 ORDER BY r.created_at LIMIT $2 OFFSET $3`,
        [req.params.id, safeLimit, offset]
      )
    ]);
    res.json({
      campaign: campaign.rows[0],
      recipients: recipients.rows,
      recipientTotal: parseInt(countQ.rows[0].count),
      page: parseInt(page),
      limit: safeLimit
    });
  } catch (e) {
    logger.error({ err: e }, 'Campaign detail error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/admin/campaigns ───
app.post('/api/admin/campaigns', authMiddleware, async (req, res) => {
  try {
    const { subject, html_body, text_body, segment } = req.body;
    if (!subject?.trim()) return res.status(400).json({ error: 'Subject required' });
    if (!html_body?.trim()) return res.status(400).json({ error: 'HTML body required' });

    const r = await pool.query(
      `INSERT INTO nb_campaigns (subject, html_body, text_body, segment)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [subject.trim(), html_body, text_body || null, segment || 'all']
    );
    res.json(r.rows[0]);
  } catch (e) {
    logger.error({ err: e }, 'Create campaign error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/admin/campaigns/:id/test ───
app.post('/api/admin/campaigns/:id/test', authMiddleware, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Test email required' });

    const campaign = await pool.query('SELECT * FROM nb_campaigns WHERE id = $1', [req.params.id]);
    if (campaign.rows.length === 0) return res.status(404).json({ error: 'Campaign not found' });
    const c = campaign.rows[0];

    const testTrackingId = 'test-' + uuidv4();
    const html = injectTracking(c.html_body, testTrackingId, 'test-token');

    await transporter.sendMail({
      from: SMTP_FROM,
      to: email,
      subject: `[TEST] ${c.subject}`,
      html,
      text: c.text_body || '',
      headers: { 'List-Unsubscribe': `<${SITE_URL}/api/unsubscribe/test-token>` }
    });

    res.json({ ok: true, message: `Test sent to ${email}` });
  } catch (e) {
    logger.error({ err: e }, 'Test send error');
    res.status(500).json({ error: 'Failed to send test email' });
  }
});

// ─── POST /api/admin/campaigns/:id/send ───
app.post('/api/admin/campaigns/:id/send', authMiddleware, async (req, res) => {
  try {
    const campaign = await pool.query(
      "SELECT * FROM nb_campaigns WHERE id = $1 AND status IN ('draft', 'failed')", [req.params.id]
    );
    if (campaign.rows.length === 0) return res.status(404).json({ error: 'Campaign not found or already sent' });
    const c = campaign.rows[0];

    // Get target subscribers
    let subQuery = "SELECT id, email, name, unsubscribe_token FROM nb_subscribers WHERE status = 'active'";
    const params = [];
    if (c.segment && c.segment !== 'all') {
      subQuery += ' AND $1 = ANY(tags)';
      params.push(c.segment);
    }
    const subs = await pool.query(subQuery, params);
    if (subs.rows.length === 0) return res.status(400).json({ error: 'No active subscribers match this segment' });

    // Create recipients
    const recipientValues = [];
    const recipientParams = [];
    let pi = 1;
    for (const sub of subs.rows) {
      const trackingId = uuidv4();
      recipientValues.push(`($${pi++}, $${pi++}, $${pi++}, $${pi++})`);
      recipientParams.push(c.id, sub.id, sub.email, trackingId);
    }
    await pool.query(
      `INSERT INTO nb_campaign_recipients (campaign_id, subscriber_id, email, tracking_id) VALUES ${recipientValues.join(', ')}`,
      recipientParams
    );

    // Update campaign status
    await pool.query(
      "UPDATE nb_campaigns SET status = 'sending', total_count = $1, sent_at = NOW(), updated_at = NOW() WHERE id = $2",
      [subs.rows.length, c.id]
    );

    // Send emails in background (don't block response)
    res.json({ ok: true, total: subs.rows.length, message: 'Campaign sending started' });

    // Batch send
    const recipients = await pool.query(
      'SELECT r.id, r.email, r.tracking_id, s.unsubscribe_token FROM nb_campaign_recipients r JOIN nb_subscribers s ON r.subscriber_id = s.id WHERE r.campaign_id = $1',
      [c.id]
    );

    let sentCount = 0;
    for (const recipient of recipients.rows) {
      try {
        const html = injectTracking(c.html_body, recipient.tracking_id, recipient.unsubscribe_token);
        await transporter.sendMail({
          from: SMTP_FROM,
          to: recipient.email,
          subject: c.subject,
          html,
          text: c.text_body || '',
          headers: {
            'List-Unsubscribe': `<${SITE_URL}/api/unsubscribe/${recipient.unsubscribe_token}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
          }
        });
        await pool.query("UPDATE nb_campaign_recipients SET status = 'sent' WHERE id = $1", [recipient.id]);
        sentCount++;
        // Rate limit: ~10 emails/sec
        await new Promise(r => setTimeout(r, 100));
      } catch (e) {
        logger.error({ err: e, email: recipient.email }, 'Failed to send campaign email');
        await pool.query(
          "UPDATE nb_campaign_recipients SET status = 'bounced', bounced_at = NOW() WHERE id = $1",
          [recipient.id]
        );
        await pool.query('UPDATE nb_campaigns SET bounce_count = bounce_count + 1 WHERE id = $1', [c.id]);
      }
    }

    // Finalize campaign
    try {
      await pool.query(
        "UPDATE nb_campaigns SET status = 'sent', sent_count = $1, updated_at = NOW() WHERE id = $2",
        [sentCount, c.id]
      );
      sendWhatsApp(NAMI_JID, `📧 Campaign sent: "${c.subject}"\n${sentCount}/${subs.rows.length} emails delivered`).catch(e => logger.error({ err: e }, 'WhatsApp fire-and-forget error'));
    } catch (finErr) {
      logger.error({ err: finErr, campaignId: c.id, sentCount }, 'Campaign finalization DB error — emails were sent but status not updated');
      sendWhatsApp(NAMI_JID, `⚠️ Campaign "${c.subject}" sent ${sentCount} emails but failed to update status in DB. Check logs.`).catch(e => logger.error({ err: e }, 'WhatsApp fire-and-forget error'));
    }

  } catch (e) {
    logger.error({ err: e }, 'Send campaign error');
    await pool.query("UPDATE nb_campaigns SET status = 'failed', updated_at = NOW() WHERE id = $1", [req.params.id]).catch(() => {});
    if (!res.headersSent) res.status(500).json({ error: 'Failed to send campaign' });
  }
});

// ─── BlueMoon GPS Tracking ───
// Write/delete endpoints require BLUEMOON_API_KEY; read (GET /tracks) stays public for map viewers
const BLUEMOON_KEY = process.env.BLUEMOON_API_KEY || null;
function requireBluemoonAuth(req, res, next) {
  if (!BLUEMOON_KEY) return res.status(503).json({ error: 'BlueMoon tracking not configured' });
  const provided = req.headers['x-bluemoon-key'] || req.query.key;
  if (provided !== BLUEMOON_KEY) return res.status(401).json({ error: 'Invalid BlueMoon API key' });
  next();
}

app.post('/api/bluemoon/track', requireBluemoonAuth, async (req, res) => {
  try {
    const { lat, lng, accuracy, recorded_at } = req.body;
    if (typeof lat !== 'number' || typeof lng !== 'number' || !isFinite(lat) || !isFinite(lng)) {
      return res.status(400).json({ error: 'Valid numeric lat and lng required' });
    }
    const result = await pool.query(
      'INSERT INTO bluemoon_tracks (lat, lng, accuracy, recorded_at) VALUES ($1, $2, $3, $4) RETURNING id, lat, lng, accuracy, recorded_at',
      [lat, lng, accuracy || null, recorded_at || new Date().toISOString()]
    );
    res.json(result.rows[0]);
  } catch (err) {
    logger.error({ err }, 'Track save error');
    res.status(500).json({ error: 'Failed to save track point' });
  }
});

app.post('/api/bluemoon/track/batch', requireBluemoonAuth, async (req, res) => {
  try {
    const { points } = req.body;
    if (!Array.isArray(points) || points.length === 0) return res.status(400).json({ error: 'points array required' });
    if (points.length > 1000) return res.status(400).json({ error: 'Maximum 1000 points per batch' });
    for (const p of points) {
      if (typeof p.lat !== 'number' || typeof p.lng !== 'number' || !isFinite(p.lat) || !isFinite(p.lng)) {
        return res.status(400).json({ error: 'Each point must have valid numeric lat and lng' });
      }
    }
    const values = points.map((p, i) => {
      const off = i * 4;
      return `($${off+1}, $${off+2}, $${off+3}, $${off+4})`;
    }).join(', ');
    const params = points.flatMap(p => [p.lat, p.lng, p.accuracy || null, p.recorded_at || new Date().toISOString()]);
    const result = await pool.query(
      `INSERT INTO bluemoon_tracks (lat, lng, accuracy, recorded_at) VALUES ${values} RETURNING id, lat, lng, accuracy, recorded_at`,
      params
    );
    res.json({ saved: result.rows.length });
  } catch (err) {
    logger.error({ err }, 'Batch track save error');
    res.status(500).json({ error: 'Failed to save track points' });
  }
});

app.get('/api/bluemoon/tracks', async (req, res) => {
  try {
    const { from, to, limit = 10000 } = req.query;
    // Validate date parameters
    if (from && isNaN(Date.parse(from))) return res.status(400).json({ error: 'Invalid "from" date format' });
    if (to && isNaN(Date.parse(to))) return res.status(400).json({ error: 'Invalid "to" date format' });
    const safeLimit = Math.min(Math.max(parseInt(limit) || 10000, 1), 50000);
    let query = 'SELECT id, lat, lng, accuracy, recorded_at FROM bluemoon_tracks';
    const params = [];
    if (from) { params.push(from); query += ` WHERE recorded_at >= $${params.length}`; }
    if (to) { params.push(to); query += (params.length > 1 ? ' AND' : ' WHERE') + ` recorded_at <= $${params.length}`; }
    query += ' ORDER BY recorded_at ASC';
    params.push(safeLimit);
    query += ` LIMIT $${params.length}`;
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    logger.error({ err }, 'Track fetch error');
    res.status(500).json({ error: 'Failed to fetch tracks' });
  }
});

app.delete('/api/bluemoon/tracks', requireBluemoonAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM bluemoon_tracks');
    res.json({ cleared: true });
  } catch (err) {
    logger.error({ err }, 'Track clear error');
    res.status(500).json({ error: 'Failed to clear tracks' });
  }
});


// ══════════════════════════════════════
// HELPERS
// ══════════════════════════════════════

function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function injectTracking(html, trackingId, unsubToken) {
  // Add open tracking pixel before </body>
  const pixel = `<img src="${SITE_URL}/api/track/open/${trackingId}" width="1" height="1" style="display:none" alt="">`;
  html = html.replace('</body>', `${pixel}</body>`);
  if (!html.includes(pixel)) html += pixel; // fallback if no </body>

  // Replace links with tracked versions
  html = html.replace(/href="(https?:\/\/[^"]+)"/g, (match, url) => {
    if (url.includes('/api/unsubscribe') || url.includes('/api/track')) return match;
    return `href="${SITE_URL}/api/track/click/${trackingId}?url=${encodeURIComponent(url)}"`;
  });

  // Add unsubscribe footer
  const footer = `<div style="text-align:center; padding:20px; margin-top:30px; border-top:1px solid #eee; font-size:12px; color:#999;">
    <p>You received this email because you subscribed at namibarden.com</p>
    <p><a href="${SITE_URL}/api/unsubscribe/${unsubToken}" style="color:#999;">Unsubscribe</a></p>
  </div>`;
  html = html.replace('</body>', `${footer}</body>`);
  if (!html.includes(footer)) html += footer;

  return html;
}

function unsubPage(title, message, token) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — Nami Barden</title>
<style>
body{font-family:-apple-system,system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#FAF7F2;color:#2C2C2C}
.box{text-align:center;max-width:400px;padding:40px;background:#fff;border-radius:12px;box-shadow:0 2px 20px rgba(0,0,0,0.08)}
h2{margin-bottom:16px;color:#2C2C2C}
p{color:#666;line-height:1.6}
button{margin-top:20px;padding:12px 32px;background:#C4A882;color:#fff;border:none;border-radius:8px;font-size:1rem;cursor:pointer}
button:hover{background:#a08860}
.done{color:#4a7}
</style></head><body><div class="box">
<h2>${title}</h2><p>${message}</p>
${token ? `<button onclick="doUnsub()">Confirm Unsubscribe</button><p id="result"></p>
<script>function doUnsub(){fetch('/api/unsubscribe/${token}',{method:'POST'}).then(r=>r.json()).then(d=>{document.querySelector('button').style.display='none';document.getElementById('result').innerHTML='<span class=done>'+d.message+'</span>'}).catch(()=>{document.getElementById('result').textContent='Error. Please try again.'})}</script>` : ''}
</div></body></html>`;
}

// ─── Global error handler (final safety net) ───
app.use((err, req, res, _next) => {
  logger.error({ err, method: req.method, url: req.originalUrl }, 'Unhandled route error');
  if (!res.headersSent) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Uncaught exception / rejection handlers ───
process.on('uncaughtException', (err, origin) => {
  logger.fatal({ err, origin }, 'Uncaught exception — process will continue but may be unstable');
  // Don't exit — let the process attempt recovery. The health check will catch persistent issues.
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error({ err: reason }, 'Unhandled promise rejection');
});

// ─── Init & Start ───
async function init() {
  // Verify database connectivity before starting
  try {
    await pool.query('SELECT 1');
    logger.info('Database connection verified');
  } catch (e) {
    logger.fatal({ err: e }, 'Cannot connect to database');
    throw e;
  }

  // Ensure admin password hash exists
  try {
    const r = await pool.query('SELECT id FROM nb_admin LIMIT 1');
    if (r.rows.length === 0 && ADMIN_PASSWORD) {
      const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
      await pool.query('INSERT INTO nb_admin (password_hash) VALUES ($1)', [hash]);
      logger.info('Admin account initialized');
    }
  } catch (e) {
    if (e.message && (e.message.includes('does not exist') || e.message.includes('relation'))) {
      logger.fatal({ err: e }, 'Admin initialization failed — schema missing or relation does not exist');
      throw e;
    }
    logger.error({ err: e }, 'Admin initialization failed (non-fatal, may need schema)');
  }

  // Verify SMTP connectivity (non-blocking)
  if (SMTP_USER && SMTP_PASS) {
    transporter.verify().then(() => {
      logger.info('SMTP connection verified');
    }).catch((e) => {
      logger.warn({ err: e }, 'SMTP verification failed — email sending may not work');
    });
  }
}

// === AIS TRACKING (Blue Moon MMSI 339385000) ===
const AISSTREAM_KEY = process.env.AISSTREAM_API_KEY;
const BLUEMOON_MMSI = 339385000;
let aisReconnectTimer = null;
let aisReconnectDelay = 60000;
let aisConsecutiveFails = 0;
let lastAisSave = 0;

function startAisTracking() {
  if (!AISSTREAM_KEY) { logger.info('AIS tracking: no API key, skipping'); return; }
  logger.info({ mmsi: BLUEMOON_MMSI }, 'AIS tracking: connecting to AISStream');

  const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');

  let pingInterval = null;

  ws.on('open', () => {
    logger.info('AIS tracking: connected');
    try {
      ws.send(JSON.stringify({
        APIKey: AISSTREAM_KEY,
        BoundingBoxes: [[[-90, -180], [90, 180]]],
        FilterMessageTypes: ['PositionReport', 'StandardClassBCSPositionReport'],
        FiltersShipMMSI: [String(BLUEMOON_MMSI)]
      }));
    } catch (e) {
      logger.error({ err: e }, 'AIS tracking: failed to send subscription');
      ws.close();
      return;
    }
    // Keep connection alive with periodic pings
    pingInterval = setInterval(() => {
      try {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      } catch (e) {
        logger.error({ err: e }, 'AIS tracking: ping failed');
      }
    }, 30000);
  });

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      if (!msg.MetaData || msg.MetaData.MMSI !== BLUEMOON_MMSI) return;
      aisReconnectDelay = 60000; // Reset backoff only on matching message
      aisConsecutiveFails = 0;

      const lat = msg.MetaData.latitude;
      const lng = msg.MetaData.longitude;
      if (!lat || !lng || (lat === 0 && lng === 0)) return;

      // Throttle saves to once per 15 minutes
      const now = Date.now();
      if (now - lastAisSave < 15 * 60 * 1000) return;
      lastAisSave = now;

      await pool.query(
        'INSERT INTO bluemoon_tracks (lat, lng, accuracy, recorded_at) VALUES ($1, $2, $3, NOW())',
        [lat, lng, 10]
      );
      logger.info({ lat: lat.toFixed(4), lng: lng.toFixed(4) }, 'AIS track saved');
    } catch (err) {
      logger.error({ err }, 'AIS message error');
    }
  });

  ws.on('error', (err) => {
    if (pingInterval) clearInterval(pingInterval);
    logger.error({ err }, 'AIS tracking error');
  });

  ws.on('close', (code, reason) => {
    if (pingInterval) clearInterval(pingInterval);
    aisConsecutiveFails++;
    const delaySec = Math.round(aisReconnectDelay / 1000);
    // Only log every 10th failure after initial ones to reduce noise
    if (aisConsecutiveFails <= 5 || aisConsecutiveFails % 10 === 0) {
      logger.info({ code, reason: reason?.toString(), nextRetryS: delaySec, fails: aisConsecutiveFails }, 'AIS tracking: disconnected');
    }
    if (aisReconnectTimer) clearTimeout(aisReconnectTimer);
    aisReconnectTimer = setTimeout(startAisTracking, aisReconnectDelay);
    // Exponential backoff: 1m → 2m → 4m → 8m → max 30m
    aisReconnectDelay = Math.min(aisReconnectDelay * 2, 30 * 60 * 1000);
  });
}

init().then(() => {
  const server = app.listen(PORT, '127.0.0.1', () => {
    logger.info({ port: PORT }, 'NamiBarden API running');
    // Start AIS tracking after server is up
    setTimeout(startAisTracking, 5000);
  });

  // Graceful shutdown — close HTTP server, drain DB pool
  function shutdown(signal) {
    logger.info({ signal }, 'Shutdown signal received — draining connections');
    server.close(() => {
      pool.end().then(() => {
        logger.info('Database pool closed');
        process.exit(0);
      }).catch((err) => {
        logger.error({ err }, 'Error closing database pool');
        process.exit(1);
      });
    });
    // Force exit after 15s if graceful shutdown stalls
    setTimeout(() => {
      logger.error('Graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, 15000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}).catch(e => {
  logger.fatal({ err: e }, 'Init failed');
  process.exit(1);
});
