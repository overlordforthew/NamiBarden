const { once } = require('events');
const crypto = require('crypto');
const express = require('express');
const courses = require('./course-catalog');
const { getCourseLessonCount } = require('./course-catalog');

const LUMINA_STATUS_VALUES = new Set(['lifetime', 'active', 'trialing', 'grace', 'expired', 'refunded', 'revoked', 'none']);
const CUSTOMER_SORTS = {
  created_at: 's.created_at',
  last_login_at: 's.last_login_at',
  total_paid_jpy: 's.total_paid_jpy',
  course_count: 's.course_count',
  last_activity_at: 's.last_activity_at'
};
const TAG_BLOCKLIST = /[<>"'&\x00-\x1f]/;

function toInt(value, fallback, min, max) {
  const parsed = parseInt(value, 10);
  const safe = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(Math.max(safe, min), max);
}

function parseBool(value) {
  return String(value).toLowerCase() === 'true';
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function normalizeLuminaStatus(rawStatus, cancelAt, currentPeriodEnd) {
  if (!rawStatus) return 'none';
  const status = String(rawStatus).toLowerCase();
  const now = Date.now();
  const periodEnd = currentPeriodEnd ? new Date(currentPeriodEnd).getTime() : 0;
  const cancelTime = cancelAt ? new Date(cancelAt).getTime() : 0;

  if (status === 'lifetime') return 'lifetime';
  if (status === 'refunded') return 'refunded';
  if (status === 'revoked') return 'revoked';
  if (status === 'trialing') return 'trialing';
  if (status === 'past_due' && periodEnd > now) return 'grace';
  if (status === 'canceled') return periodEnd > now ? 'grace' : 'expired';
  if (status === 'active') {
    if (!cancelTime) return 'active';
    return !periodEnd || periodEnd > now ? 'active' : 'expired';
  }
  return 'expired';
}

function buildStripeDashboardUrl(paymentIntentId) {
  if (!paymentIntentId) return null;
  if (paymentIntentId.startsWith('pi_live_')) {
    return `https://dashboard.stripe.com/payments/${paymentIntentId}`;
  }
  if (paymentIntentId.startsWith('pi_test_')) {
    return `https://dashboard.stripe.com/test/payments/${paymentIntentId}`;
  }
  return null;
}

function isLuminaOwned(status) {
  return ['lifetime', 'active', 'trialing', 'grace'].includes(status);
}

function getCatalogCourseIds() {
  return Object.keys(courses).filter((courseId) => Array.isArray(courses[courseId]?.lessons));
}

function getCatalogColumns() {
  return getCatalogCourseIds().map((courseId) => ({
    courseId,
    name: courses[courseId].name,
    totalLessons: getCourseLessonCount(courseId)
  }));
}

function addLuminaFilter(conditions, params, idx, lumina) {
  if (!lumina) return idx;
  const normalized = String(lumina).toLowerCase();
  if (!LUMINA_STATUS_VALUES.has(normalized)) {
    const err = new Error('Invalid lumina filter');
    err.statusCode = 400;
    throw err;
  }

  if (normalized === 'none') {
    conditions.push('s.lumina_status IS NULL');
    return idx;
  }
  if (['lifetime', 'trialing', 'refunded', 'revoked'].includes(normalized)) {
    conditions.push(`LOWER(e.status) = $${idx++}`);
    params.push(normalized);
    return idx;
  }
  if (normalized === 'active') {
    conditions.push(`LOWER(e.status) = 'active' AND (e.cancel_at IS NULL OR e.current_period_end IS NULL OR e.current_period_end > NOW())`);
    return idx;
  }
  if (normalized === 'grace') {
    conditions.push(`((LOWER(e.status) = 'past_due' AND e.current_period_end > NOW()) OR (LOWER(e.status) = 'canceled' AND e.current_period_end > NOW()))`);
    return idx;
  }
  // 'expired' — matches normalizeLuminaStatus()'s expired branch:
  //   canceled + period past, past_due + period past, active+cancel_at + period past, or unknown status
  conditions.push(`(
    (LOWER(e.status) = 'canceled' AND (e.current_period_end IS NULL OR e.current_period_end <= NOW()))
    OR (LOWER(e.status) = 'past_due' AND (e.current_period_end IS NULL OR e.current_period_end <= NOW()))
    OR (LOWER(e.status) = 'active' AND e.cancel_at IS NOT NULL AND e.current_period_end IS NOT NULL AND e.current_period_end <= NOW())
    OR LOWER(e.status) NOT IN ('lifetime','active','trialing','past_due','canceled','refunded','revoked')
  )`);
  return idx;
}

function buildCustomerFilters(query, options = {}) {
  const conditions = [];
  const params = [];
  let idx = 1;

  if (query.search) {
    conditions.push(`(s.email ILIKE $${idx} OR s.name ILIKE $${idx})`);
    params.push(`%${query.search}%`);
    idx++;
  }
  if (query.tag) {
    conditions.push(`$${idx++} = ANY(s.tags)`);
    params.push(String(query.tag).trim().toLowerCase());
  }
  idx = addLuminaFilter(conditions, params, idx, query.lumina);
  if (query.course) {
    conditions.push(`$${idx++} = ANY(s.course_ids)`);
    params.push(String(query.course));
  }
  if (query.hasActivity) {
    if (query.hasActivity === '30d') conditions.push(`s.last_activity_at >= NOW() - INTERVAL '30 days'`);
    else if (query.hasActivity === '90d') conditions.push(`s.last_activity_at >= NOW() - INTERVAL '90 days'`);
    else if (query.hasActivity === 'never') conditions.push('s.last_activity_at IS NULL');
    else {
      const err = new Error('Invalid hasActivity filter');
      err.statusCode = 400;
      throw err;
    }
  }
  if (options.includeEmptyStudents === false) {
    conditions.push('s.payment_count > 0');
  }
  if (query.courseOwnership) {
    const [courseId, state] = String(query.courseOwnership).split(':');
    if (!courseId || !['owned', 'missing'].includes(state) || !courses[courseId]) {
      const err = new Error('Invalid courseOwnership filter');
      err.statusCode = 400;
      throw err;
    }
    conditions.push(state === 'owned' ? `$${idx} = ANY(s.course_ids)` : `NOT ($${idx} = ANY(s.course_ids))`);
    params.push(courseId);
    idx++;
  }

  return {
    where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
    idx
  };
}

function mapCustomerSummary(row) {
  const luminaStatus = normalizeLuminaStatus(row.lumina_status, row.lumina_cancel_at, row.lumina_current_period_end);
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
    lastActivityAt: row.last_activity_at,
    totalPaidJpy: Number(row.total_paid_jpy) || 0,
    paymentCount: Number(row.payment_count) || 0,
    courseCount: Number(row.course_count) || 0,
    courseIds: row.course_ids || [],
    luminaStatus,
    luminaPlanCode: row.lumina_plan_code,
    luminaGrantedAt: row.lumina_granted_at,
    qaThreadCount: Number(row.qa_thread_count) || 0,
    qaUnreadForAdminCount: Number(row.qa_unread_for_admin_count) || 0,
    tags: row.tags || []
  };
}

function normalizeCustomerTags(tags) {
  if (!Array.isArray(tags)) {
    const err = new Error('Tags must be an array');
    err.statusCode = 400;
    throw err;
  }
  if (tags.length > 32) {
    const err = new Error('Maximum 32 tags per customer');
    err.statusCode = 400;
    throw err;
  }

  const normalized = [];
  const seen = new Set();
  for (const tag of tags) {
    if (typeof tag !== 'string') {
      const err = new Error('Tags must be strings');
      err.statusCode = 400;
      throw err;
    }
    const value = tag.trim().toLowerCase();
    if (!value) continue;
    if (value.length > 40) {
      const err = new Error('Tags must be 40 characters or fewer');
      err.statusCode = 400;
      throw err;
    }
    if (TAG_BLOCKLIST.test(value)) {
      const err = new Error('Tags cannot contain angle brackets, quotes, ampersands, or control characters');
      err.statusCode = 400;
      throw err;
    }
    if (!seen.has(value)) {
      normalized.push(value);
      seen.add(value);
    }
  }
  return normalized;
}

function writeCsvHeader(res, columns, stringify) {
  const headerRow = {};
  for (const column of columns) headerRow[column.key] = column.header;
  res.write(stringify([headerRow], { header: false, columns: columns.map((column) => column.key) }));
}

async function streamRowsWithSqlCursor({ pool, res, req, logger, query, params, columns, filename, stringify, mapRows, logContext }) {
  const client = await pool.connect();
  const cursorName = `admin_export_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  let rowCount = 0;
  let aborted = false;
  const onClose = () => { aborted = true; };
  if (req) req.on('close', onClose);
  res.on('close', onClose);

  // Race drain against close/error so a client disconnect unblocks mid-backpressure.
  const waitForDrain = () => new Promise((resolve) => {
    if (aborted) return resolve();
    const cleanup = () => {
      res.off('drain', onDrain);
      res.off('close', onEnd);
      res.off('error', onEnd);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onEnd = () => { cleanup(); resolve(); };
    res.once('drain', onDrain);
    res.once('close', onEnd);
    res.once('error', onEnd);
  });

  try {
    await client.query('BEGIN');
    await client.query(`DECLARE ${cursorName} NO SCROLL CURSOR FOR ${query}`, params);
    res.set({
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename=${filename}`
    });
    writeCsvHeader(res, columns, stringify);

    while (!aborted) {
      const chunk = await client.query(`FETCH FORWARD 1000 FROM ${cursorName}`);
      if (chunk.rows.length === 0) break;
      rowCount += chunk.rows.length;
      const mappedRows = await mapRows(chunk.rows);
      const csv = stringify(mappedRows, { header: false, columns: columns.map((column) => column.key) });
      if (!res.write(csv)) await waitForDrain();
    }

    await client.query(`CLOSE ${cursorName}`).catch(() => {});
    if (aborted) {
      await client.query('ROLLBACK').catch(() => {});
      logger.warn({ ...logContext, rowCount }, 'Admin CSV export aborted by client disconnect');
    } else {
      await client.query('COMMIT');
      res.end();
      logger.info({ ...logContext, rowCount }, 'Admin CSV export completed');
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error({ err, ...logContext, rowCount }, 'Admin CSV export failed');
    if (!res.headersSent) {
      res.status(500).json({ error: 'Export failed' });
    } else {
      res.destroy(err);
    }
  } finally {
    if (req) req.off('close', onClose);
    res.off('close', onClose);
    client.release();
  }
}

function createAdminRoutes({
  app,
  pool,
  logger,
  authMiddleware,
  bcrypt,
  jwt,
  jwtSecret,
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
  smtpFrom,
  siteUrl,
  uuidv4,
  injectTracking,
  sendWhatsApp,
  namiJid,
  chatEvents,
  chatAuth
}) {
  app.post('/api/admin/login', async (req, res) => {
    try {
      const ip = getIP(req);
      if (!rateLimit(`login:${ip}`, 5, 300000)) {
        return res.status(429).json({ error: 'Too many login attempts' });
      }
      const { password } = req.body;
      if (!password) return res.status(400).json({ error: 'Password required' });

      let valid = false;
      const result = await pool.query('SELECT password_hash FROM nb_admin ORDER BY id LIMIT 1');
      if (result.rows.length > 0) {
        valid = await bcrypt.compare(password, result.rows[0].password_hash);
      }

      if (!valid) return res.status(401).json({ error: 'Invalid password' });
      const token = jwt.sign({ role: 'admin' }, jwtSecret, { expiresIn: '24h' });
      setAuthCookie(res, 'nb_admin_token', token, 24 * 60 * 60 * 1000);
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e }, 'Admin login error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.post('/api/admin/logout', (req, res) => {
    clearAuthCookie(res, 'nb_admin_token');
    for (const name of Object.keys(req.cookies || {})) {
      if (/^nb_thread_admin_\d+$/.test(name)) clearAuthCookie(res, name);
    }
    res.json({ ok: true });
  });

  app.get('/api/admin/check', authMiddleware, (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/admin/qa/stream', authMiddleware, async (req, res) => {
    try {
      if (!chatEvents?.openAdminStream) return res.status(503).json({ error: 'Chat stream not configured' });
      await chatEvents.openAdminStream(req, res);
    } catch (e) {
      logger.error({ err: e }, 'Admin QA stream error');
      if (!res.headersSent) res.status(500).json({ error: 'Server error' });
    }
  });

  app.post('/api/admin/qa/:id/deep-link', authMiddleware, async (req, res) => {
    try {
      const threadId = parseInt(req.params.id, 10);
      if (!threadId) return res.status(400).json({ error: 'Invalid thread id' });
      if (!rateLimit(`admin-thread-link:${threadId}`, 1, 30000)) {
        return res.status(429).json({ error: 'Please wait before issuing another link' });
      }
      const thread = (await pool.query(
        'SELECT id FROM nb_qa_threads WHERE id = $1',
        [threadId]
      )).rows[0];
      if (!thread) return res.status(404).json({ error: 'Thread not found' });

      const token = crypto.randomBytes(32).toString('hex');
      const result = await pool.query(
        `INSERT INTO nb_admin_thread_link_tokens (token_hash, thread_id, expires_at, created_reason)
         VALUES ($1, $2, NOW() + INTERVAL '15 minutes', $3)
         RETURNING expires_at`,
        [sha256Hex(token), threadId, (req.body?.reason || '').slice(0, 100) || null]
      );
      const baseUrl = (siteUrl || 'https://namibarden.com').replace(/\/+$/, '');
      res.json({
        url: `${baseUrl}/api/admin/link-thread?token=${token}`,
        expiresAt: result.rows[0].expires_at
      });
    } catch (e) {
      logger.error({ err: e }, 'Admin thread deep-link issue error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.get('/api/admin/link-thread', (req, res) => {
    const token = String(req.query.token || '');
    if (!/^[a-f0-9]{64}$/i.test(token)) return res.redirect(302, '/admin/?error=invalid_link');
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!doctype html>
      <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta name="robots" content="noindex,nofollow">
        <title>Open thread - Nami Barden</title>
        <style>
          body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#faf7f2;color:#2c2419;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:24px}
          main{max-width:520px;background:#fffdf8;border:1px solid #eadfce;border-radius:8px;padding:32px;box-shadow:0 16px 44px rgba(53,44,38,.08)}
          h1{font-family:Georgia,"Times New Roman",serif;font-weight:400;margin:0 0 14px;font-size:28px}
          p{line-height:1.7;color:#5f5348;margin:0 0 18px}
          button{border:0;background:#352c26;color:#fff;padding:12px 18px;border-radius:6px;font-weight:700;cursor:pointer}
        </style>
      </head>
      <body>
        <main>
          <h1>Open this thread as Nami</h1>
          <p>This one-time link signs you in for this thread only for 15 minutes. It is not a full admin login.</p>
          <form method="post" action="/api/admin/link-thread">
            <input type="hidden" name="token" value="${escapeHtml(token)}">
            <button type="submit">Open thread</button>
          </form>
        </main>
      </body>
      </html>`);
  });

  app.post('/api/admin/link-thread', express.urlencoded({ extended: false }), async (req, res) => {
    try {
      const token = String(req.body?.token || '');
      if (!/^[a-f0-9]{64}$/i.test(token)) return res.redirect(302, '/admin/?error=invalid_link');
      const result = await pool.query(
        `UPDATE nb_admin_thread_link_tokens
         SET consumed_at = NOW(), consumed_ip = $2
         WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > NOW()
         RETURNING thread_id`,
        [sha256Hex(token), getIP(req)]
      );
      if (result.rows.length === 0) return res.redirect(302, '/admin/?error=invalid_link');
      const threadId = Number(result.rows[0].thread_id);
      const scopedToken = jwt.sign(
        { role: 'admin', scope: 'thread-admin', threadId },
        jwtSecret,
        { expiresIn: '15m', audience: `thread-admin:${threadId}` }
      );
      setAuthCookie(res, `nb_thread_admin_${threadId}`, scopedToken, 15 * 60 * 1000);
      res.redirect(302, `/admin/qa.html?thread=${encodeURIComponent(threadId)}&scope=thread-admin`);
    } catch (e) {
      logger.error({ err: e }, 'Admin thread deep-link consume error');
      res.redirect(302, '/admin/?error=invalid_link');
    }
  });

  function requireQaAdminForThread(req, res, next) {
    const threadId = parseInt(req.params.id, 10);
    if (!threadId) return res.status(400).json({ error: 'Invalid thread id' });
    const full = chatAuth?.verifyFullAdmin ? chatAuth.verifyFullAdmin(req) : null;
    if (full) {
      req.admin = full;
      return next();
    }
    const scoped = chatAuth?.verifyThreadAdmin ? chatAuth.verifyThreadAdmin(req, threadId) : null;
    if (scoped) {
      req.admin = scoped;
      return next();
    }
    return res.status(401).json({ error: 'Unauthorized' });
  }

  app.get('/api/admin/qa/:id/open-as-student', requireQaAdminForThread, async (req, res) => {
    try {
      const threadId = parseInt(req.params.id, 10);
      const thread = (await pool.query(
        `SELECT id, channel, access_token, course_id
         FROM nb_qa_threads
         WHERE id = $1`,
        [threadId]
      )).rows[0];
      if (!thread || thread.channel === 'dm' || !thread.access_token || !thread.course_id) {
        return res.status(404).json({ error: 'Course thread not found' });
      }
      const token = jwt.sign(
        { kind: 'admin-impersonate-access', accessToken: thread.access_token, courseId: thread.course_id },
        jwtSecret,
        {
          expiresIn: '5m',
          issuer: 'namibarden-admin',
          audience: 'course-watch-impersonation'
        }
      );
      res.redirect(302, `/watch?token=${encodeURIComponent(token)}&course=${encodeURIComponent(thread.course_id)}`);
    } catch (e) {
      logger.error({ err: e }, 'QA open as student error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.get('/api/admin/customers', authMiddleware, async (req, res) => {
    try {
      const safeLimit = toInt(req.query.limit, 50, 1, 200);
      const safePage = toInt(req.query.page, 1, 1, 100000);
      const offset = (safePage - 1) * safeLimit;
      const sortSql = CUSTOMER_SORTS[req.query.sort] || CUSTOMER_SORTS.created_at;
      const dir = String(req.query.dir || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
      const { where, params, idx } = buildCustomerFilters(req.query);

      const baseFrom = `FROM nb_customer_summary s
        LEFT JOIN nb_app_entitlements e ON e.customer_id = s.id AND e.app_slug = 'lumina'`;
      const countQ = await pool.query(`SELECT COUNT(*) ${baseFrom} ${where}`, params);
      const dataParams = params.concat([safeLimit, offset]);
      const dataQ = await pool.query(
        `SELECT s.id, s.email, s.name, s.created_at, s.updated_at, s.last_login_at,
                s.last_activity_at, s.total_paid_jpy, s.payment_count, s.course_count,
                s.course_ids, s.lumina_status, s.lumina_plan_code, s.lumina_granted_at,
                s.qa_thread_count, s.qa_unread_for_admin_count, s.tags,
                e.cancel_at AS lumina_cancel_at,
                e.current_period_end AS lumina_current_period_end
         ${baseFrom}
         ${where}
         ORDER BY ${sortSql} ${dir} NULLS LAST, s.id DESC
         LIMIT $${idx} OFFSET $${idx + 1}`,
        dataParams
      );

      res.json({
        customers: dataQ.rows.map(mapCustomerSummary),
        total: parseInt(countQ.rows[0].count, 10),
        page: safePage,
        limit: safeLimit
      });
    } catch (e) {
      logger.error({ err: e }, 'Customers list error');
      res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : 'Server error' });
    }
  });

  app.get('/api/admin/customers/export', authMiddleware, async (req, res) => {
    try {
      const includeNotes = parseBool(req.query.includeNotes);
      const sortSql = CUSTOMER_SORTS[req.query.sort] || CUSTOMER_SORTS.created_at;
      const dir = String(req.query.dir || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
      const { where, params } = buildCustomerFilters(req.query);
      const columns = [
        { key: 'email', header: 'email' },
        { key: 'name', header: 'name' },
        { key: 'created_at', header: 'created_at' },
        { key: 'last_login_at', header: 'last_login_at' },
        { key: 'last_activity_at', header: 'last_activity_at' },
        { key: 'total_paid_jpy', header: 'total_paid_jpy' },
        { key: 'payment_count', header: 'payment_count' },
        { key: 'course_count', header: 'course_count' },
        { key: 'course_ids', header: 'course_ids' },
        { key: 'lumina_status', header: 'lumina_status' },
        { key: 'lumina_plan_code', header: 'lumina_plan_code' },
        { key: 'lumina_granted_at', header: 'lumina_granted_at' },
        { key: 'lumina_owned', header: 'lumina_owned' },
        { key: 'qa_thread_count', header: 'qa_thread_count' },
        { key: 'tags', header: 'tags' }
      ];
      if (includeNotes) columns.push({ key: 'notes', header: 'notes' });

      const query = `SELECT s.email, s.name, s.created_at, s.last_login_at, s.last_activity_at,
             s.total_paid_jpy, s.payment_count, s.course_count, s.course_ids,
             s.lumina_status, s.lumina_plan_code, s.lumina_granted_at,
             s.qa_thread_count, s.tags, s.notes,
             e.cancel_at AS lumina_cancel_at,
             e.current_period_end AS lumina_current_period_end
        FROM nb_customer_summary s
        LEFT JOIN nb_app_entitlements e ON e.customer_id = s.id AND e.app_slug = 'lumina'
        ${where}
        ORDER BY ${sortSql} ${dir} NULLS LAST, s.id DESC
        LIMIT 50000`;

      await streamRowsWithSqlCursor({
        pool,
        res,
        req,
        logger,
        query,
        params,
        columns,
        filename: 'customers.csv',
        stringify,
        logContext: {
          admin: req.admin || null,
          filters: req.query,
          includeNotes,
          exportType: 'customers',
          timestamp: new Date().toISOString()
        },
        mapRows: (rows) => rows.map((row) => {
          const normalized = normalizeLuminaStatus(row.lumina_status, row.lumina_cancel_at, row.lumina_current_period_end);
          const mapped = {
            email: row.email,
            name: row.name || '',
            created_at: row.created_at || '',
            last_login_at: row.last_login_at || '',
            last_activity_at: row.last_activity_at || '',
            total_paid_jpy: Number(row.total_paid_jpy) || 0,
            payment_count: Number(row.payment_count) || 0,
            course_count: Number(row.course_count) || 0,
            course_ids: (row.course_ids || []).join(','),
            lumina_status: normalized,
            lumina_plan_code: row.lumina_plan_code || '',
            lumina_granted_at: row.lumina_granted_at || '',
            lumina_owned: isLuminaOwned(normalized),
            qa_thread_count: Number(row.qa_thread_count) || 0,
            tags: (row.tags || []).join(',')
          };
          if (includeNotes) mapped.notes = row.notes || '';
          return mapped;
        })
      });
    } catch (e) {
      logger.error({ err: e }, 'Customers export setup error');
      if (!res.headersSent) res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : 'Server error' });
    }
  });

  app.get('/api/admin/customers/:id', authMiddleware, async (req, res) => {
    try {
      const customerId = parseInt(req.params.id, 10);
      if (!customerId) return res.status(400).json({ error: 'Invalid customer id' });

      const customerRow = (await pool.query(
        `SELECT id, email, name, created_at, updated_at, last_login_at, last_activity_at,
                notes, tags, stripe_customer_id
         FROM nb_customer_summary
         WHERE id = $1`,
        [customerId]
      )).rows[0];
      if (!customerRow) return res.status(404).json({ error: 'Customer not found' });

      const [purchasesQ, coursesQ, luminaQ, qaThreadsQ, newsletterQ] = await Promise.all([
        pool.query(
          `SELECT id, amount, currency, status, product_name,
                  stripe_payment_intent_id, stripe_invoice_id, created_at
           FROM nb_payments
           WHERE customer_id = $1
           ORDER BY created_at DESC`,
          [customerId]
        ),
        pool.query(
          `SELECT
             ca.course_id,
             ca.purchased_at,
             COALESCE(lp.started_count, 0) AS started_count,
             COALESCE(lp.completed_count, 0) AS completed_count,
             lp.last_watched_at
           FROM nb_course_access ca
           LEFT JOIN LATERAL (
             SELECT COUNT(*) AS started_count,
                    COUNT(*) FILTER (WHERE completed) AS completed_count,
                    MAX(last_watched_at) AS last_watched_at
             FROM nb_lesson_progress
             WHERE access_token = ca.access_token AND course_id = ca.course_id
           ) lp ON TRUE
           WHERE ca.customer_id = $1 AND (ca.expires_at IS NULL OR ca.expires_at > NOW())
           ORDER BY ca.purchased_at DESC`,
          [customerId]
        ),
        pool.query(
          `SELECT status, plan_code, lifetime_granted_at, current_period_end, cancel_at,
                  source_product_name, metadata
           FROM nb_app_entitlements
           WHERE customer_id = $1 AND app_slug = 'lumina'`,
          [customerId]
        ),
        pool.query(
          `SELECT t.id, t.subject, t.course_id, t.lesson_id, t.status,
                  t.unread_for_admin, t.last_message_at,
                  (SELECT COUNT(*) FROM nb_qa_messages m WHERE m.thread_id = t.id) AS message_count
           FROM nb_qa_threads t
           WHERE t.customer_id = $1
              OR t.access_token IN (SELECT access_token FROM nb_course_access WHERE customer_id = $1)
           ORDER BY t.last_message_at DESC
           LIMIT 200`,
          [customerId]
        ),
        pool.query(
          `SELECT source, tags, status
           FROM nb_subscribers
           WHERE LOWER(email) = LOWER($1)
           ORDER BY updated_at DESC
           LIMIT 1`,
          [customerRow.email]
        )
      ]);

      const purchases = purchasesQ.rows.map((row) => ({
        id: row.id,
        amount: row.amount,
        currency: row.currency,
        status: row.status,
        productName: row.product_name,
        stripePaymentIntentId: row.stripe_payment_intent_id,
        stripeInvoiceId: row.stripe_invoice_id,
        stripeDashboardUrl: buildStripeDashboardUrl(row.stripe_payment_intent_id),
        createdAt: row.created_at
      }));

      const ownedCourses = coursesQ.rows.map((row) => {
        const totalLessons = getCourseLessonCount(row.course_id);
        const completedCount = Number(row.completed_count) || 0;
        const startedCount = Number(row.started_count) || 0;
        return {
          courseId: row.course_id,
          courseName: courses[row.course_id]?.name || row.course_id,
          openAsStudentUrl: `/api/admin/customers/${customerId}/open-as-student?course=${encodeURIComponent(row.course_id)}`,
          purchasedAt: row.purchased_at,
          completionPct: totalLessons > 0 ? Math.round(100 * completedCount / totalLessons) : 0,
          completedCount,
          startedCount,
          totalLessons,
          lastWatchedAt: row.last_watched_at
        };
      });

      const luminaRow = luminaQ.rows[0] || null;
      const lumina = luminaRow ? {
        normalizedStatus: normalizeLuminaStatus(luminaRow.status, luminaRow.cancel_at, luminaRow.current_period_end),
        rawStatus: luminaRow.status,
        planCode: luminaRow.plan_code,
        lifetimeGrantedAt: luminaRow.lifetime_granted_at,
        currentPeriodEnd: luminaRow.current_period_end,
        cancelAt: luminaRow.cancel_at,
        sourceProductName: luminaRow.source_product_name,
        metadata: luminaRow.metadata || {}
      } : null;

      const newsletterRow = newsletterQ.rows[0] || null;
      res.json({
        customer: {
          id: customerRow.id,
          email: customerRow.email,
          name: customerRow.name,
          createdAt: customerRow.created_at,
          updatedAt: customerRow.updated_at,
          lastLoginAt: customerRow.last_login_at,
          lastActivityAt: customerRow.last_activity_at,
          notes: customerRow.notes || '',
          tags: customerRow.tags || [],
          stripeCustomerId: customerRow.stripe_customer_id
        },
        purchases,
        courses: ownedCourses,
        lumina,
        qaThreads: qaThreadsQ.rows.map((row) => ({
          id: row.id,
          subject: row.subject,
          courseId: row.course_id,
          lessonId: row.lesson_id,
          status: row.status,
          unreadForAdmin: row.unread_for_admin,
          lastMessageAt: row.last_message_at,
          messageCount: Number(row.message_count) || 0
        })),
        newsletter: newsletterRow ? {
          subscribed: newsletterRow.status === 'active',
          source: newsletterRow.source,
          tags: newsletterRow.tags || [],
          status: newsletterRow.status
        } : null
      });
    } catch (e) {
      logger.error({ err: e }, 'Customer detail error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.put('/api/admin/customers/:id/notes', authMiddleware, async (req, res) => {
    try {
      const customerId = parseInt(req.params.id, 10);
      if (!customerId) return res.status(400).json({ error: 'Invalid customer id' });
      if (typeof req.body?.notes !== 'string') return res.status(400).json({ error: 'Notes must be a string' });
      const result = await pool.query(
        `UPDATE nb_customers
         SET notes = $1, updated_at = NOW()
         WHERE id = $2
         RETURNING id, notes, updated_at`,
        [req.body.notes, customerId]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Customer not found' });
      res.json({ id: result.rows[0].id, notes: result.rows[0].notes || '', updatedAt: result.rows[0].updated_at });
    } catch (e) {
      logger.error({ err: e }, 'Customer notes update error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.put('/api/admin/customers/:id/tags', authMiddleware, async (req, res) => {
    try {
      const customerId = parseInt(req.params.id, 10);
      if (!customerId) return res.status(400).json({ error: 'Invalid customer id' });
      const tags = normalizeCustomerTags(req.body?.tags);
      const result = await pool.query(
        `UPDATE nb_customers
         SET tags = $1, updated_at = NOW()
         WHERE id = $2
         RETURNING id, tags`,
        [tags, customerId]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Customer not found' });
      res.json({ id: result.rows[0].id, tags: result.rows[0].tags || [] });
    } catch (e) {
      logger.error({ err: e }, 'Customer tags update error');
      res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : 'Server error' });
    }
  });

  app.get('/api/admin/customers/:id/open-as-student', authMiddleware, async (req, res) => {
    try {
      const customerId = parseInt(req.params.id, 10);
      const courseId = String(req.query.course || '');
      if (!customerId) return res.status(400).json({ error: 'Invalid customer id' });
      if (!courseId || !courses[courseId]) return res.status(400).json({ error: 'Invalid course' });

      const access = await pool.query(
        `SELECT id
         FROM nb_course_access
         WHERE customer_id = $1 AND course_id = $2 AND (expires_at IS NULL OR expires_at > NOW())
         LIMIT 1`,
        [customerId, courseId]
      );
      if (access.rows.length === 0) return res.status(404).json({ error: 'Course access not found' });

      const token = jwt.sign(
        { kind: 'admin-impersonate', customerId, courseId },
        jwtSecret,
        {
          expiresIn: '5m',
          issuer: 'namibarden-admin',
          audience: 'course-watch-impersonation'
        }
      );
      res.redirect(302, `/watch?token=${encodeURIComponent(token)}&course=${encodeURIComponent(courseId)}`);
    } catch (e) {
      logger.error({ err: e }, 'Open as student error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.get('/api/admin/matrix', authMiddleware, async (req, res) => {
    try {
      const safeLimit = toInt(req.query.limit, 100, 1, 500);
      const safePage = toInt(req.query.page, 1, 1, 100000);
      const offset = (safePage - 1) * safeLimit;
      const includeEmptyStudents = parseBool(req.query.includeEmptyStudents);
      const { where, params, idx } = buildCustomerFilters(req.query, { includeEmptyStudents });
      const baseFrom = `FROM nb_customer_summary s
        LEFT JOIN nb_app_entitlements e ON e.customer_id = s.id AND e.app_slug = 'lumina'`;
      const [countQ, customersQ] = await Promise.all([
        pool.query(`SELECT COUNT(*) ${baseFrom} ${where}`, params),
        pool.query(
          `SELECT s.id, s.email, s.name, s.course_ids,
                  e.status AS raw_lumina_status,
                  e.cancel_at AS lumina_cancel_at,
                  e.current_period_end AS lumina_current_period_end,
                  e.lifetime_granted_at AS lumina_granted_at
           ${baseFrom}
           ${where}
           ORDER BY s.email ASC, s.id ASC
           LIMIT $${idx} OFFSET $${idx + 1}`,
          params.concat([safeLimit, offset])
        )
      ]);

      const customerIds = customersQ.rows.map((row) => row.id);
      const progressRows = customerIds.length ? (await pool.query(
        `SELECT ca.customer_id, ca.course_id,
                COALESCE(lp.started_count, 0) AS started_count,
                COALESCE(lp.completed_count, 0) AS completed_count,
                lp.last_watched_at
         FROM nb_course_access ca
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS started_count,
                  COUNT(*) FILTER (WHERE completed) AS completed_count,
                  MAX(last_watched_at) AS last_watched_at
           FROM nb_lesson_progress
           WHERE access_token = ca.access_token AND course_id = ca.course_id
         ) lp ON TRUE
         WHERE ca.customer_id = ANY($1::int[]) AND (ca.expires_at IS NULL OR ca.expires_at > NOW())`,
        [customerIds]
      )).rows : [];

      const progressByCustomer = new Map();
      for (const row of progressRows) {
        if (!progressByCustomer.has(row.customer_id)) progressByCustomer.set(row.customer_id, new Map());
        const totalLessons = getCourseLessonCount(row.course_id);
        const completedCount = Number(row.completed_count) || 0;
        progressByCustomer.get(row.customer_id).set(row.course_id, {
          owned: true,
          completionPct: totalLessons > 0 ? Math.round(100 * completedCount / totalLessons) : 0,
          completedCount,
          startedCount: Number(row.started_count) || 0,
          totalLessons,
          lastWatchedAt: row.last_watched_at
        });
      }

      const courseColumns = getCatalogColumns();
      const rows = customersQ.rows.map((customer) => {
        const cells = {};
        const customerProgress = progressByCustomer.get(customer.id) || new Map();
        for (const column of courseColumns) {
          cells[column.courseId] = customerProgress.get(column.courseId) || { owned: false };
        }
        const normalizedStatus = normalizeLuminaStatus(customer.raw_lumina_status, customer.lumina_cancel_at, customer.lumina_current_period_end);
        cells.lumina = {
          owned: isLuminaOwned(normalizedStatus),
          normalizedStatus,
          grantedAt: customer.lumina_granted_at
        };
        return {
          customerId: customer.id,
          email: customer.email,
          name: customer.name,
          cells
        };
      });

      res.json({
        columns: courseColumns.concat([{ courseId: 'lumina', name: 'LUMINA', totalLessons: null }]),
        rows,
        total: parseInt(countQ.rows[0].count, 10),
        page: safePage,
        limit: safeLimit
      });
    } catch (e) {
      logger.error({ err: e }, 'Matrix error');
      res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : 'Server error' });
    }
  });

  app.get('/api/admin/matrix/export', authMiddleware, async (req, res) => {
    try {
      const includeEmptyStudents = parseBool(req.query.includeEmptyStudents);
      const { where, params } = buildCustomerFilters(req.query, { includeEmptyStudents });
      const courseColumns = getCatalogColumns();
      const columns = [
        { key: 'email', header: 'email' },
        { key: 'name', header: 'name' }
      ];
      for (const course of courseColumns) {
        columns.push({ key: `${course.courseId}_owned`, header: `${course.courseId}_owned` });
        columns.push({ key: `${course.courseId}_completion_pct`, header: `${course.courseId}_completion_pct` });
      }
      columns.push({ key: 'lumina_owned', header: 'lumina_owned' });
      columns.push({ key: 'lumina_status', header: 'lumina_status' });
      columns.push({ key: 'lumina_granted_at', header: 'lumina_granted_at' });

      const query = `SELECT s.id, s.email, s.name,
             e.status AS raw_lumina_status,
             e.cancel_at AS lumina_cancel_at,
             e.current_period_end AS lumina_current_period_end,
             e.lifetime_granted_at AS lumina_granted_at
        FROM nb_customer_summary s
        LEFT JOIN nb_app_entitlements e ON e.customer_id = s.id AND e.app_slug = 'lumina'
        ${where}
        ORDER BY s.email ASC, s.id ASC
        LIMIT 10000`;

      await streamRowsWithSqlCursor({
        pool,
        res,
        req,
        logger,
        query,
        params,
        columns,
        filename: 'customer-matrix.csv',
        stringify,
        logContext: {
          admin: req.admin || null,
          filters: req.query,
          includeNotes: false,
          exportType: 'matrix',
          timestamp: new Date().toISOString()
        },
        mapRows: async (rows) => {
          const customerIds = rows.map((row) => row.id);
          const progressRows = customerIds.length ? (await pool.query(
            `SELECT ca.customer_id, ca.course_id,
                    COALESCE(lp.completed_count, 0) AS completed_count
             FROM nb_course_access ca
             LEFT JOIN LATERAL (
               SELECT COUNT(*) FILTER (WHERE completed) AS completed_count
               FROM nb_lesson_progress
               WHERE access_token = ca.access_token AND course_id = ca.course_id
             ) lp ON TRUE
             WHERE ca.customer_id = ANY($1::int[]) AND (ca.expires_at IS NULL OR ca.expires_at > NOW())`,
            [customerIds]
          )).rows : [];
          const progressByCustomer = new Map();
          for (const row of progressRows) {
            if (!progressByCustomer.has(row.customer_id)) progressByCustomer.set(row.customer_id, new Map());
            const totalLessons = getCourseLessonCount(row.course_id);
            const completedCount = Number(row.completed_count) || 0;
            progressByCustomer.get(row.customer_id).set(row.course_id, {
              owned: true,
              completionPct: totalLessons > 0 ? Math.round(100 * completedCount / totalLessons) : 0
            });
          }

          return rows.map((customer) => {
            const mapped = { email: customer.email, name: customer.name || '' };
            const customerProgress = progressByCustomer.get(customer.id) || new Map();
            for (const course of courseColumns) {
              const cell = customerProgress.get(course.courseId);
              mapped[`${course.courseId}_owned`] = !!cell;
              mapped[`${course.courseId}_completion_pct`] = cell ? cell.completionPct : '';
            }
            const normalized = normalizeLuminaStatus(customer.raw_lumina_status, customer.lumina_cancel_at, customer.lumina_current_period_end);
            mapped.lumina_owned = isLuminaOwned(normalized);
            mapped.lumina_status = normalized;
            mapped.lumina_granted_at = customer.lumina_granted_at || '';
            return mapped;
          });
        }
      });
    } catch (e) {
      logger.error({ err: e }, 'Matrix export setup error');
      if (!res.headersSent) res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : 'Server error' });
    }
  });

  app.get('/api/admin/stats', authMiddleware, async (_req, res) => {
    try {
      const [subs, contacts, campaigns, recent, sources, growth, alertSummary, recentAlerts] = await Promise.all([
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
          GROUP BY DATE(created_at) ORDER BY date`),
        pool.query(`SELECT
          COUNT(*) FILTER (WHERE status = 'open') AS open,
          COUNT(*) FILTER (WHERE status = 'acknowledged') AS acknowledged,
          COUNT(*) FILTER (WHERE status = 'resolved') AS resolved,
          COUNT(*) FILTER (WHERE status = 'open' AND severity = 'critical') AS critical_open
          FROM nb_operational_alerts`),
        pool.query(`SELECT id, source, severity, title, status, last_seen
          FROM nb_operational_alerts
          ORDER BY
            CASE status
              WHEN 'open' THEN 0
              WHEN 'acknowledged' THEN 1
              ELSE 2
            END,
            last_seen DESC
          LIMIT 5`)
      ]);

      res.json({
        subscribers: subs.rows[0],
        contacts: contacts.rows[0],
        campaigns: campaigns.rows[0],
        recentCampaigns: recent.rows,
        sources: sources.rows,
        growth: growth.rows,
        alerts: alertSummary.rows[0],
        recentAlerts: recentAlerts.rows.map((row) => ({
          id: row.id,
          source: row.source,
          severity: row.severity,
          title: row.title,
          status: row.status,
          lastSeen: row.last_seen
        }))
      });
    } catch (e) {
      logger.error({ err: e }, 'Stats error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.get('/api/admin/subscribers', authMiddleware, async (req, res) => {
    try {
      const { page = 1, limit = 50, status, source, search, tag } = req.query;
      const safeLimit = Math.min(Math.max(parseInt(limit) || 50, 1), 200);
      const safePage = Math.max(parseInt(page) || 1, 1);
      const offset = (safePage - 1) * safeLimit;
      const conditions = [];
      const params = [];
      let idx = 1;

      if (status) {
        conditions.push(`status = $${idx++}`);
        params.push(status);
      }
      if (source) {
        conditions.push(`source = $${idx++}`);
        params.push(source);
      }
      if (search) {
        conditions.push(`(email ILIKE $${idx} OR name ILIKE $${idx})`);
        params.push(`%${search}%`);
        idx++;
      }
      if (tag) {
        conditions.push(`$${idx++} = ANY(tags)`);
        params.push(tag);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const countQ = await pool.query(`SELECT COUNT(*) FROM nb_subscribers ${where}`, params);
      params.push(safeLimit, offset);
      const dataQ = await pool.query(
        `SELECT id, email, name, source, status, tags, created_at, updated_at
         FROM nb_subscribers ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx}`,
        params
      );

      res.json({
        subscribers: dataQ.rows,
        total: parseInt(countQ.rows[0].count, 10),
        page: safePage,
        limit: safeLimit
      });
    } catch (e) {
      logger.error({ err: e }, 'Subscribers list error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.get('/api/admin/subscribers/export', authMiddleware, async (req, res) => {
    try {
      const { status } = req.query;
      const where = status ? 'WHERE status = $1' : '';
      const params = status ? [status] : [];
      const result = await pool.query(
        `SELECT email, name, source, status, array_to_string(tags, ',') AS tags, created_at
         FROM nb_subscribers ${where} ORDER BY created_at DESC LIMIT 50000`,
        params
      );
      const csv = stringify(result.rows, { header: true });
      res.set({ 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename=subscribers.csv' });
      res.send(csv);
    } catch (e) {
      logger.error({ err: e }, 'Export error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.post('/api/admin/import', authMiddleware, (req, res) => {
    uploadImportCsv(req, res, async (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'CSV file must be 2 MB or smaller' });
        }
        return res.status(400).json({ error: 'Invalid upload. Please try again with a CSV file.' });
      }
      if (err) {
        logger.error({ err }, 'Import upload error');
        return res.status(400).json({ error: 'Upload failed. Please try again.' });
      }

      try {
        if (!req.file) return res.status(400).json({ error: 'CSV file required' });
        const records = parse(req.file.buffer.toString(), { columns: true, skip_empty_lines: true, trim: true });
        let imported = 0;
        let skipped = 0;
        for (const row of records) {
          const email = (row.email || row.Email || '').trim().toLowerCase();
          if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            skipped++;
            continue;
          }
          const name = (row.name || row.Name || '').trim() || null;
          const source = (row.source || row.Source || 'import').trim();
          const token = generateToken();
          const result = await pool.query(
            `INSERT INTO nb_subscribers (email, name, source, unsubscribe_token)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (email) DO NOTHING RETURNING id`,
            [email, name, source, token]
          );
          if (result.rows.length > 0) imported++;
          else skipped++;
        }
        res.json({ imported, skipped, total: records.length });
      } catch (e) {
        logger.error({ err: e }, 'Import error');
        res.status(500).json({ error: 'Import failed. Please check file format and try again.' });
      }
    });
  });

  app.post('/api/admin/subscribers/:id/tags', authMiddleware, async (req, res) => {
    try {
      const { tags } = req.body;
      if (!Array.isArray(tags)) return res.status(400).json({ error: 'Tags must be an array' });
      const result = await pool.query(
        'UPDATE nb_subscribers SET tags = $1, updated_at = NOW() WHERE id = $2 RETURNING id, tags',
        [tags, req.params.id]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Subscriber not found' });
      res.json(result.rows[0]);
    } catch (e) {
      logger.error({ err: e }, 'Tags error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.delete('/api/admin/subscribers/:id', authMiddleware, async (req, res) => {
    try {
      const result = await pool.query('DELETE FROM nb_subscribers WHERE id = $1 RETURNING id', [req.params.id]);
      if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e }, 'Delete subscriber error');
      res.status(500).json({ error: 'Server error' });
    }
  });

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
      res.json({
        contacts: dataQ.rows,
        total: parseInt(countQ.rows[0].count, 10),
        page: safePage,
        limit: safeLimit
      });
    } catch (e) {
      logger.error({ err: e }, 'Contacts error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.get('/api/admin/campaigns', authMiddleware, async (req, res) => {
    try {
      const { page = 1, limit = 50 } = req.query;
      const safeLimit = Math.min(Math.max(parseInt(limit) || 50, 1), 200);
      const safePage = Math.max(parseInt(page) || 1, 1);
      const offset = (safePage - 1) * safeLimit;
      const [countQ, dataQ] = await Promise.all([
        pool.query('SELECT COUNT(*) FROM nb_campaigns'),
        pool.query(
          `SELECT id, subject, status, segment, total_count, sent_count, open_count, click_count,
                  bounce_count, unsub_count, created_at, sent_at
           FROM nb_campaigns ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
          [safeLimit, offset]
        )
      ]);
      res.json({
        campaigns: dataQ.rows,
        total: parseInt(countQ.rows[0].count, 10),
        page: safePage,
        limit: safeLimit
      });
    } catch (e) {
      logger.error({ err: e }, 'Campaigns error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.get('/api/admin/campaigns/:id', authMiddleware, async (req, res) => {
    try {
      const { page = 1, limit = 100 } = req.query;
      const safeLimit = Math.min(Math.max(parseInt(limit) || 100, 1), 500);
      const safePage = Math.max(parseInt(page) || 1, 1);
      const offset = (safePage - 1) * safeLimit;

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
        recipientTotal: parseInt(countQ.rows[0].count, 10),
        page: safePage,
        limit: safeLimit
      });
    } catch (e) {
      logger.error({ err: e }, 'Campaign detail error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.post('/api/admin/campaigns', authMiddleware, async (req, res) => {
    try {
      const { subject, html_body, text_body, segment } = req.body;
      if (!subject?.trim()) return res.status(400).json({ error: 'Subject required' });
      if (!html_body?.trim()) return res.status(400).json({ error: 'HTML body required' });

      const result = await pool.query(
        `INSERT INTO nb_campaigns (subject, html_body, text_body, segment)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [subject.trim(), html_body, text_body || null, segment || 'all']
      );
      res.json(result.rows[0]);
    } catch (e) {
      logger.error({ err: e }, 'Create campaign error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.post('/api/admin/campaigns/:id/test', authMiddleware, async (req, res) => {
    try {
      const { email } = req.body;
      if (!email) return res.status(400).json({ error: 'Test email required' });

      const campaign = await pool.query('SELECT * FROM nb_campaigns WHERE id = $1', [req.params.id]);
      if (campaign.rows.length === 0) return res.status(404).json({ error: 'Campaign not found' });
      const current = campaign.rows[0];
      const testTrackingId = `test-${uuidv4()}`;
      const html = injectTracking(current.html_body, testTrackingId, 'test-token');

      await transporter.sendMail({
        from: smtpFrom,
        to: email,
        subject: `[TEST] ${current.subject}`,
        html,
        text: current.text_body || '',
        headers: { 'List-Unsubscribe': `<${siteUrl}/api/unsubscribe/test-token>` }
      });

      res.json({ ok: true, message: `Test sent to ${email}` });
    } catch (e) {
      logger.error({ err: e }, 'Test send error');
      res.status(500).json({ error: 'Failed to send test email' });
    }
  });

  app.post('/api/admin/campaigns/:id/send', authMiddleware, async (req, res) => {
    try {
      // Use advisory lock to prevent race condition on concurrent send requests
      const lockResult = await pool.query(
        `SELECT * FROM nb_campaigns WHERE id = $1 AND status IN ('draft', 'failed') FOR UPDATE SKIP LOCKED`,
        [req.params.id]
      );
      if (lockResult.rows.length === 0) {
        // Either not found, already sent, or another request holds the lock
        const exists = await pool.query('SELECT status FROM nb_campaigns WHERE id = $1', [req.params.id]);
        if (exists.rows.length === 0) return res.status(404).json({ error: 'Campaign not found' });
        return res.status(409).json({ error: `Campaign is already ${exists.rows[0].status}` });
      }
      const current = lockResult.rows[0];

      let subQuery = "SELECT id, email, name, unsubscribe_token FROM nb_subscribers WHERE status = 'active'";
      const params = [];
      if (current.segment && current.segment !== 'all') {
        subQuery += ' AND $1 = ANY(tags)';
        params.push(current.segment);
      }
      const subs = await pool.query(subQuery, params);
      if (subs.rows.length === 0) return res.status(400).json({ error: 'No active subscribers match this segment' });

      const recipientValues = [];
      const recipientParams = [];
      let paramIndex = 1;
      for (const sub of subs.rows) {
        const trackingId = uuidv4();
        recipientValues.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
        recipientParams.push(current.id, sub.id, sub.email, trackingId);
      }
      await pool.query(
        `INSERT INTO nb_campaign_recipients (campaign_id, subscriber_id, email, tracking_id) VALUES ${recipientValues.join(', ')}`,
        recipientParams
      );

      await pool.query(
        "UPDATE nb_campaigns SET status = 'sending', total_count = $1, sent_at = NOW(), updated_at = NOW() WHERE id = $2",
        [subs.rows.length, current.id]
      );

      res.json({ ok: true, total: subs.rows.length, message: 'Campaign sending started' });

      let recipients;
      try {
        recipients = await pool.query(
          'SELECT r.id, r.email, r.tracking_id, s.unsubscribe_token FROM nb_campaign_recipients r JOIN nb_subscribers s ON r.subscriber_id = s.id WHERE r.campaign_id = $1',
          [current.id]
        );
      } catch (recipientQueryErr) {
        logger.error({ err: recipientQueryErr, campaignId: current.id }, 'Campaign: failed to load recipients for sending');
        await pool.query("UPDATE nb_campaigns SET status = 'failed', updated_at = NOW() WHERE id = $1", [current.id]).catch(() => {});
        sendWhatsApp(namiJid, `Campaign "${current.subject}" failed to load recipients. Status set to failed.`).catch((e) => logger.error({ err: e }, 'WhatsApp fire-and-forget error'));
        return;
      }

      let sentCount = 0;
      for (const recipient of recipients.rows) {
        try {
          const html = injectTracking(current.html_body, recipient.tracking_id, recipient.unsubscribe_token);
          await transporter.sendMail({
            from: smtpFrom,
            to: recipient.email,
            subject: current.subject,
            html,
            text: current.text_body || '',
            headers: {
              'List-Unsubscribe': `<${siteUrl}/api/unsubscribe/${recipient.unsubscribe_token}>`,
              'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
            }
          });
          await pool.query("UPDATE nb_campaign_recipients SET status = 'sent' WHERE id = $1", [recipient.id]).catch((dbErr) => {
            logger.error({ err: dbErr, recipientId: recipient.id }, 'Campaign: failed to mark recipient as sent');
          });
          sentCount++;
          await new Promise((resolve) => setTimeout(resolve, 100));
        } catch (e) {
          logger.error({ err: e, email: recipient.email }, 'Failed to send campaign email');
          try {
            await pool.query(
              "UPDATE nb_campaign_recipients SET status = 'bounced', bounced_at = NOW() WHERE id = $1",
              [recipient.id]
            );
            await pool.query('UPDATE nb_campaigns SET bounce_count = bounce_count + 1 WHERE id = $1', [current.id]);
          } catch (dbErr) {
            logger.error({ err: dbErr, recipientId: recipient.id }, 'Campaign: failed to record bounce in DB');
          }
        }
      }

      try {
        await pool.query(
          "UPDATE nb_campaigns SET status = 'sent', sent_count = $1, updated_at = NOW() WHERE id = $2",
          [sentCount, current.id]
        );
        sendWhatsApp(namiJid, `Campaign sent: "${current.subject}"\n${sentCount}/${subs.rows.length} emails delivered`).catch((e) => logger.error({ err: e }, 'WhatsApp fire-and-forget error'));
      } catch (finalizeErr) {
        logger.error({ err: finalizeErr, campaignId: current.id, sentCount }, 'Campaign finalization DB error - emails were sent but status not updated');
        sendWhatsApp(namiJid, `Campaign "${current.subject}" sent ${sentCount} emails but failed to update status in DB. Check logs.`).catch((e) => logger.error({ err: e }, 'WhatsApp fire-and-forget error'));
      }
    } catch (e) {
      logger.error({ err: e }, 'Send campaign error');
      await pool.query("UPDATE nb_campaigns SET status = 'failed', updated_at = NOW() WHERE id = $1", [req.params.id]).catch(() => {});
      if (!res.headersSent) res.status(500).json({ error: 'Failed to send campaign' });
    }
  });
}

module.exports = {
  createAdminRoutes,
  normalizeLuminaStatus,
  buildStripeDashboardUrl
};
