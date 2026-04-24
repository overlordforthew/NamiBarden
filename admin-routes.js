const { once } = require('events');
const crypto = require('crypto');
const express = require('express');
const courses = require('./course-catalog');
const { getCourseLessonCount } = require('./course-catalog');
const { sha256Hex } = require('./crypto-helpers');
const {
  GRANULARITY_SQL,
  COMPLETION_BUCKETS,
  productsForCategory,
  validateGranularity,
  validateReportCategory,
  validateCompareMode,
  validateSort,
  validateDir,
  assertJstDate,
  parseJstDateRange,
  formatJstDate,
  addDaysToJstDate,
  rangeIncludesTodayJst,
  computeComparisonRange,
  completionBucketForPercent,
  completionBucketLabel,
  validateCompletionBucket,
  escapeCsvRow,
  buildProductCategoryCaseSql
} = require('./reporting-lib');

const LUMINA_STATUS_VALUES = new Set(['lifetime', 'active', 'trialing', 'grace', 'expired', 'refunded', 'revoked', 'none']);
const CUSTOMER_SORTS = {
  created_at: 's.created_at',
  last_login_at: 's.last_login_at',
  total_paid_jpy: 's.total_paid_jpy',
  course_count: 's.course_count',
  last_activity_at: 's.last_activity_at'
};
const REPORT_PAYMENT_SORTS = {
  created_at: 'p.created_at',
  amount: 'p.amount',
  email: 'c.email',
  product_name: 'p.product_name'
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
    const search = String(query.search).slice(0, 200);
    conditions.push(`(s.email ILIKE $${idx} OR s.name ILIKE $${idx})`);
    params.push(`%${search}%`);
    idx++;
  }
  if (query.tag) {
    conditions.push(`$${idx++} = ANY(s.tags)`);
    params.push(String(query.tag).trim().toLowerCase().slice(0, 100));
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

function reportsNoStore(_req, res, next) {
  res.set('Cache-Control', 'no-store');
  next();
}

function assertReportCourse(courseId) {
  const value = String(courseId || '');
  if (!courses[value] || !Array.isArray(courses[value].lessons)) {
    const err = new Error('Invalid course');
    err.statusCode = 400;
    throw err;
  }
  return value;
}

function getPlayableLessons(courseId) {
  return (courses[courseId]?.lessons || []).filter((lesson) => {
    const type = lesson.type || 'video';
    return type !== 'pdf' && type !== 'ending';
  });
}

function addProductFilter({ conditions, params, alias, category }) {
  const products = productsForCategory(category);
  if (products.length === 0) return;
  conditions.push(`${alias}.product_name = ANY($${params.length + 1}::varchar[])`);
  params.push(products);
}

function numberValue(value) {
  return Number(value) || 0;
}

function formatBucket(value) {
  if (!value) return null;
  if (value instanceof Date) return formatJstDate(value);
  return String(value).slice(0, 10);
}

function mapRevenueRows(paymentRows, refundRows) {
  const byBucket = new Map();
  const ensure = (bucket) => {
    const key = formatBucket(bucket);
    if (!byBucket.has(key)) {
      byBucket.set(key, { bucket: key, gross: 0, refunds: 0, net: 0, payments: 0, uniquePayers: 0 });
    }
    return byBucket.get(key);
  };

  for (const row of paymentRows) {
    const target = ensure(row.bucket);
    target.gross += numberValue(row.gross);
    target.payments += numberValue(row.payment_count);
    target.uniquePayers += numberValue(row.unique_payers);
  }
  for (const row of refundRows) {
    const target = ensure(row.bucket);
    target.refunds += numberValue(row.refund_amount);
  }

  return Array.from(byBucket.values())
    .sort((a, b) => a.bucket.localeCompare(b.bucket))
    .map((row) => ({ ...row, net: row.gross - row.refunds }));
}

function validateCampaignPayload({ subject, html_body, text_body, segment }) {
  const normalized = {
    subject: (subject || '').trim(),
    html_body: (html_body || '').trim(),
    text_body: text_body == null ? '' : text_body,
    segment: segment || 'all'
  };

  if (!normalized.subject) {
    const err = new Error('Subject is required');
    err.statusCode = 400;
    throw err;
  }
  if (!normalized.html_body) {
    const err = new Error('HTML body is required');
    err.statusCode = 400;
    throw err;
  }
  if (normalized.subject.length > 500) {
    const err = new Error('Subject too long (max 500)');
    err.statusCode = 400;
    throw err;
  }
  if (normalized.html_body.length > 500_000) {
    const err = new Error('HTML body too large (max 500 KB)');
    err.statusCode = 413;
    throw err;
  }
  if (normalized.text_body && normalized.text_body.length > 500_000) {
    const err = new Error('Text body too large (max 500 KB)');
    err.statusCode = 413;
    throw err;
  }

  return normalized;
}

async function insertRecipientsChunked(client, campaignId, subs, makeTrackingId) {
  // Batched INSERT: Postgres caps $-placeholders at 65,535 per statement, so
  // the previous "one giant VALUES" approach broke at ~16,384 subscribers.
  // 500 rows × 4 params = 2,000 placeholders stays well under that.
  const CHUNK = 500;
  if (!subs.length) return;
  for (let i = 0; i < subs.length; i += CHUNK) {
    const slice = subs.slice(i, i + CHUNK);
    const values = slice
      .map((_, idx) => {
        const base = idx * 4;
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
      })
      .join(', ');
    const params = slice.flatMap((s) => [campaignId, s.id, s.email, makeTrackingId()]);
    await client.query(
      `INSERT INTO nb_campaign_recipients (campaign_id, subscriber_id, email, tracking_id)
       VALUES ${values}`,
      params
    );
  }
}

function totalsForRevenue(rows) {
  return rows.reduce((acc, row) => {
    acc.gross += numberValue(row.gross);
    acc.refunds += numberValue(row.refunds);
    acc.net += numberValue(row.net);
    acc.payments += numberValue(row.payments);
    acc.uniquePayers += numberValue(row.uniquePayers);
    return acc;
  }, { gross: 0, refunds: 0, net: 0, payments: 0, uniquePayers: 0 });
}

async function getNonJpyExcluded(pool) {
  const result = await pool.query(
    `SELECT currency, payment_count, total_minor_units
     FROM nb_non_jpy_payments
     ORDER BY currency ASC`
  );
  const breakdown = result.rows.map((row) => ({
    currency: row.currency,
    paymentCount: numberValue(row.payment_count),
    totalMinorUnits: numberValue(row.total_minor_units)
  }));
  return {
    count: breakdown.reduce((sum, row) => sum + row.paymentCount, 0),
    breakdown
  };
}

async function getReportingLastRefreshedAt(pool, source) {
  if (source === 'live') return new Date().toISOString();
  const result = await pool.query(
    `SELECT GREATEST(
       (SELECT MAX(day) FROM nb_revenue_daily),
       (SELECT MAX(day) FROM nb_refunds_daily)
     ) AS last_refreshed_at`
  );
  return result.rows[0]?.last_refreshed_at || null;
}

async function getLegacyActiveSubscriptionCount(pool) {
  const result = await pool.query(
    `SELECT COUNT(*) AS count
     FROM nb_subscriptions
     WHERE status IN ('active', 'trialing', 'past_due')`
  );
  return numberValue(result.rows[0]?.count);
}

async function queryRevenueBuckets(pool, { range, granularity, category, source }) {
  const paymentParams = [range.fromUtc, range.toUtc];
  const paymentConditions = [];
  const refundParams = [range.fromUtc, range.toUtc];
  const refundConditions = [];
  let paymentBucketSql;
  let refundBucketSql;
  let paymentFromSql;
  let refundFromSql;
  let paymentGrossSql;
  let paymentCountSql;
  let uniquePayersSql;
  let refundAmountSql;

  if (source === 'live') {
    paymentBucketSql = GRANULARITY_SQL[granularity]('p.created_at');
    refundBucketSql = GRANULARITY_SQL[granularity]('r.stripe_created_at');
    paymentFromSql = 'nb_payments p';
    refundFromSql = 'nb_refunds r';
    paymentGrossSql = 'p.amount';
    paymentCountSql = '1';
    uniquePayersSql = 'p.customer_id';
    refundAmountSql = 'r.amount';
    paymentConditions.push('p.status = \'succeeded\'', 'p.currency = \'jpy\'', 'p.created_at >= $1', 'p.created_at < $2');
    refundConditions.push('r.status = \'succeeded\'', 'r.currency = \'jpy\'', 'r.stripe_created_at >= $1', 'r.stripe_created_at < $2');
  } else {
    paymentBucketSql = GRANULARITY_SQL[granularity]('p.day');
    refundBucketSql = GRANULARITY_SQL[granularity]('r.day');
    paymentFromSql = 'nb_revenue_daily p';
    refundFromSql = 'nb_refunds_daily r';
    paymentGrossSql = 'p.gross';
    paymentCountSql = 'p.payment_count';
    uniquePayersSql = 'p.unique_payers';
    refundAmountSql = 'r.refund_amount';
    paymentConditions.push('p.day >= $1', 'p.day < $2');
    refundConditions.push('r.day >= $1', 'r.day < $2');
  }

  addProductFilter({ conditions: paymentConditions, params: paymentParams, alias: 'p', category });
  addProductFilter({ conditions: refundConditions, params: refundParams, alias: 'r', category });

  const paymentRows = (await pool.query(
    `SELECT ${paymentBucketSql} AS bucket,
            COALESCE(SUM(${paymentGrossSql}), 0) AS gross,
            COALESCE(SUM(${paymentCountSql}), 0) AS payment_count,
            ${source === 'live' ? `COUNT(DISTINCT ${uniquePayersSql})` : `COALESCE(SUM(${uniquePayersSql}), 0)`} AS unique_payers
     FROM ${paymentFromSql}
     WHERE ${paymentConditions.join(' AND ')}
     GROUP BY 1
     ORDER BY 1 ASC`,
    paymentParams
  )).rows;

  const refundRows = (await pool.query(
    `SELECT ${refundBucketSql} AS bucket,
            COALESCE(SUM(${refundAmountSql}), 0) AS refund_amount
     FROM ${refundFromSql}
     WHERE ${refundConditions.join(' AND ')}
     GROUP BY 1
     ORDER BY 1 ASC`,
    refundParams
  )).rows;

  return mapRevenueRows(paymentRows, refundRows);
}

async function queryRevenueByProduct(pool, range) {
  const categoryCasePayments = buildProductCategoryCaseSql('p.product_name');
  const categoryCaseRefunds = buildProductCategoryCaseSql('r.product_name');
  const paymentRows = (await pool.query(
    `WITH payment_lines AS (
       SELECT ${categoryCasePayments} AS category,
              p.amount::numeric AS gross,
              1::numeric AS payment_count,
              p.customer_id
       FROM nb_payments p
       WHERE p.status = 'succeeded'
         AND p.currency = 'jpy'
         AND (p.product_name IS NULL OR p.product_name <> 'course-bundle')
         AND p.created_at >= $1
         AND p.created_at < $2
       UNION ALL
       SELECT 'course-1' AS category, (p.amount::numeric / 2.0) AS gross, 1::numeric AS payment_count, p.customer_id
       FROM nb_payments p
       WHERE p.status = 'succeeded'
         AND p.currency = 'jpy'
         AND p.product_name = 'course-bundle'
         AND p.created_at >= $1
         AND p.created_at < $2
       UNION ALL
       SELECT 'course-2' AS category, (p.amount::numeric / 2.0) AS gross, 1::numeric AS payment_count, p.customer_id
       FROM nb_payments p
       WHERE p.status = 'succeeded'
         AND p.currency = 'jpy'
         AND p.product_name = 'course-bundle'
         AND p.created_at >= $1
         AND p.created_at < $2
     )
     SELECT category,
            COALESCE(SUM(gross), 0) AS gross,
            COALESCE(SUM(payment_count), 0) AS payment_count,
            COUNT(DISTINCT customer_id) AS unique_payers
     FROM payment_lines
     GROUP BY category`,
    [range.fromUtc, range.toUtc]
  )).rows;

  const refundRows = (await pool.query(
    `WITH refund_lines AS (
       SELECT ${categoryCaseRefunds} AS category,
              r.amount::numeric AS refund_amount,
              1::numeric AS refund_count
       FROM nb_refunds r
       WHERE r.status = 'succeeded'
         AND r.currency = 'jpy'
         AND (r.product_name IS NULL OR r.product_name <> 'course-bundle')
         AND r.stripe_created_at >= $1
         AND r.stripe_created_at < $2
       UNION ALL
       SELECT 'course-1' AS category, (r.amount::numeric / 2.0) AS refund_amount, 1::numeric AS refund_count
       FROM nb_refunds r
       WHERE r.status = 'succeeded'
         AND r.currency = 'jpy'
         AND r.product_name = 'course-bundle'
         AND r.stripe_created_at >= $1
         AND r.stripe_created_at < $2
       UNION ALL
       SELECT 'course-2' AS category, (r.amount::numeric / 2.0) AS refund_amount, 1::numeric AS refund_count
       FROM nb_refunds r
       WHERE r.status = 'succeeded'
         AND r.currency = 'jpy'
         AND r.product_name = 'course-bundle'
         AND r.stripe_created_at >= $1
         AND r.stripe_created_at < $2
     )
     SELECT category,
            COALESCE(SUM(refund_amount), 0) AS refund_amount
     FROM refund_lines
     GROUP BY category`,
    [range.fromUtc, range.toUtc]
  )).rows;

  const byCategory = new Map();
  const ensure = (category) => {
    if (!byCategory.has(category)) {
      byCategory.set(category, { category, gross: 0, refunds: 0, net: 0, payments: 0, uniquePayers: 0 });
    }
    return byCategory.get(category);
  };
  for (const row of paymentRows) {
    const target = ensure(row.category);
    target.gross += numberValue(row.gross);
    target.payments += numberValue(row.payment_count);
    target.uniquePayers += numberValue(row.unique_payers);
  }
  for (const row of refundRows) {
    const target = ensure(row.category);
    target.refunds += numberValue(row.refund_amount);
  }

  return Array.from(byCategory.values())
    .map((row) => ({ ...row, net: row.gross - row.refunds }))
    .sort((a, b) => b.net - a.net || a.category.localeCompare(b.category));
}

async function loadCompletionStudents(pool, courseId) {
  return (await pool.query(
    `WITH owned AS (
       SELECT ca.access_token, ca.course_id, ca.customer_id, ca.email, c.name
       FROM nb_course_access ca
       LEFT JOIN nb_customers c ON c.id = ca.customer_id
       WHERE ca.course_id = $1
         AND (ca.expires_at IS NULL OR ca.expires_at > NOW())
         AND NOT EXISTS (
           SELECT 1 FROM nb_refunds r
           JOIN nb_payments p ON r.payment_id = p.id
           WHERE r.status = 'succeeded'
             AND p.customer_id = ca.customer_id
             AND (p.product_name = ca.course_id OR p.product_name = 'course-bundle' OR (ca.course_id = 'course-2' AND p.product_name IN ('course-2-upgrade','course-2-flash')))
         )
     ),
     progress AS (
       SELECT o.access_token, o.course_id, o.customer_id, o.email, o.name,
              COUNT(*) FILTER (WHERE lp.completed) AS completed_count,
              MAX(lp.last_watched_at) AS last_watched_at
       FROM owned o
       LEFT JOIN nb_lesson_progress lp
         ON lp.access_token = o.access_token AND lp.course_id = o.course_id
       GROUP BY o.access_token, o.course_id, o.customer_id, o.email, o.name
     )
     SELECT access_token, customer_id, email, name, completed_count, last_watched_at
     FROM progress
     ORDER BY email ASC, access_token ASC`,
    [courseId]
  )).rows;
}

function mapCompletionStudent(row, totalLessons) {
  const completedCount = numberValue(row.completed_count);
  const completionPct = totalLessons > 0 ? Math.min(100, Math.round(100 * completedCount / totalLessons)) : 0;
  return {
    customerId: row.customer_id || null,
    email: row.email || '',
    name: row.name || '',
    completionPct,
    lastWatchedAt: row.last_watched_at || null,
    bucket: completionBucketForPercent(completionPct)
  };
}

async function queryDropoffRows(pool, courseId) {
  const lessons = getPlayableLessons(courseId);
  const lessonIds = lessons.map((lesson) => lesson.id);
  const lessonOrders = lessons.map((_, index) => index + 1);
  const lessonTitles = lessons.map((lesson) => lesson.title || lesson.id);
  const nextLessonIds = lessons.map((_, index) => lessons[index + 1]?.id || null);
  const result = await pool.query(
    `WITH lesson_catalog AS (
       SELECT *
       FROM unnest($2::varchar[], $3::int[], $4::varchar[], $5::varchar[])
         AS t(lesson_id, lesson_order, title, next_lesson_id)
     ),
     owned AS (
       SELECT ca.access_token, ca.course_id, ca.customer_id
       FROM nb_course_access ca
       WHERE ca.course_id = $1
         AND (ca.expires_at IS NULL OR ca.expires_at > NOW())
         AND NOT EXISTS (
           SELECT 1 FROM nb_refunds r
           JOIN nb_payments p ON r.payment_id = p.id
           WHERE r.status = 'succeeded'
             AND p.customer_id = ca.customer_id
             AND (p.product_name = ca.course_id OR p.product_name = 'course-bundle' OR (ca.course_id = 'course-2' AND p.product_name IN ('course-2-upgrade','course-2-flash')))
         )
     )
     SELECT lc.lesson_id, lc.lesson_order, lc.title, lc.next_lesson_id,
            COUNT(DISTINCT o.access_token) FILTER (WHERE current_lp.id IS NOT NULL) AS started_count,
            COUNT(DISTINCT o.access_token) FILTER (WHERE current_lp.completed) AS completed_count,
            COUNT(DISTINCT o.access_token) FILTER (WHERE current_lp.completed AND next_lp.id IS NOT NULL) AS next_started_count
     FROM lesson_catalog lc
     LEFT JOIN owned o ON TRUE
     LEFT JOIN nb_lesson_progress current_lp
       ON current_lp.access_token = o.access_token
      AND current_lp.course_id = o.course_id
      AND current_lp.lesson_id = lc.lesson_id
     LEFT JOIN nb_lesson_progress next_lp
       ON next_lp.access_token = o.access_token
      AND next_lp.course_id = o.course_id
      AND next_lp.lesson_id = lc.next_lesson_id
     GROUP BY lc.lesson_id, lc.lesson_order, lc.title, lc.next_lesson_id
     ORDER BY lc.lesson_order ASC`,
    [courseId, lessonIds, lessonOrders, lessonTitles, nextLessonIds]
  );

  return result.rows.map((row) => {
    const completedCount = numberValue(row.completed_count);
    const nextStartedCount = numberValue(row.next_started_count);
    const hasNext = !!row.next_lesson_id;
    const dropoffRate = completedCount > 0 && hasNext ? 1 - (nextStartedCount / completedCount) : 0;
    return {
      lessonId: row.lesson_id,
      title: row.title,
      order: numberValue(row.lesson_order),
      startedCount: numberValue(row.started_count),
      completedCount,
      nextStartedCount,
      dropoffCount: hasNext ? Math.max(completedCount - nextStartedCount, 0) : 0,
      dropoffRate
    };
  });
}

function buildRevenueExportSql({ range, granularity, category }) {
  const paymentParams = [range.fromUtc, range.toUtc];
  const paymentConditions = [
    'p.status = \'succeeded\'',
    'p.currency = \'jpy\'',
    'p.created_at >= $1',
    'p.created_at < $2'
  ];
  const refundParams = [range.fromUtc, range.toUtc];
  const refundConditions = [
    'r.status = \'succeeded\'',
    'r.currency = \'jpy\'',
    'r.stripe_created_at >= $1',
    'r.stripe_created_at < $2'
  ];
  addProductFilter({ conditions: paymentConditions, params: paymentParams, alias: 'p', category });
  addProductFilter({ conditions: refundConditions, params: refundParams, alias: 'r', category });
  const params = paymentParams;
  const refundOffsetConditions = refundConditions.map((condition) =>
    condition.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + paymentParams.length}`)
  );
  params.push(...refundParams);

  return {
    params,
    query: `WITH movements AS (
       SELECT ${GRANULARITY_SQL[granularity]('p.created_at')} AS bucket,
              COALESCE(SUM(p.amount), 0)::numeric AS gross,
              0::numeric AS refunds,
              COUNT(*)::numeric AS payments,
              COUNT(DISTINCT p.customer_id)::numeric AS unique_payers
       FROM nb_payments p
       WHERE ${paymentConditions.join(' AND ')}
       GROUP BY 1
       UNION ALL
       SELECT ${GRANULARITY_SQL[granularity]('r.stripe_created_at')} AS bucket,
              0::numeric AS gross,
              COALESCE(SUM(r.amount), 0)::numeric AS refunds,
              0::numeric AS payments,
              0::numeric AS unique_payers
       FROM nb_refunds r
       WHERE ${refundOffsetConditions.join(' AND ')}
       GROUP BY 1
     )
     SELECT bucket::date AS bucket,
            COALESCE(SUM(gross), 0) AS gross,
            COALESCE(SUM(refunds), 0) AS refunds,
            COALESCE(SUM(gross), 0) - COALESCE(SUM(refunds), 0) AS net,
            COALESCE(SUM(payments), 0) AS payments,
            COALESCE(SUM(unique_payers), 0) AS unique_payers
     FROM movements
     GROUP BY bucket
     ORDER BY bucket ASC`
  };
}

function buildRevenueByProductExportSql(range) {
  const categoryCasePayments = buildProductCategoryCaseSql('p.product_name');
  const categoryCaseRefunds = buildProductCategoryCaseSql('r.product_name');
  return {
    params: [range.fromUtc, range.toUtc],
    query: `WITH payment_lines AS (
       SELECT ${categoryCasePayments} AS category,
              p.amount::numeric AS gross,
              0::numeric AS refunds,
              1::numeric AS payments,
              p.customer_id
       FROM nb_payments p
       WHERE p.status = 'succeeded'
         AND p.currency = 'jpy'
         AND (p.product_name IS NULL OR p.product_name <> 'course-bundle')
         AND p.created_at >= $1
         AND p.created_at < $2
       UNION ALL
       SELECT 'course-1', p.amount::numeric / 2.0, 0::numeric, 1::numeric, p.customer_id
       FROM nb_payments p
       WHERE p.status = 'succeeded' AND p.currency = 'jpy' AND p.product_name = 'course-bundle'
         AND p.created_at >= $1 AND p.created_at < $2
       UNION ALL
       SELECT 'course-2', p.amount::numeric / 2.0, 0::numeric, 1::numeric, p.customer_id
       FROM nb_payments p
       WHERE p.status = 'succeeded' AND p.currency = 'jpy' AND p.product_name = 'course-bundle'
         AND p.created_at >= $1 AND p.created_at < $2
     ),
     refund_lines AS (
       SELECT ${categoryCaseRefunds} AS category,
              0::numeric AS gross,
              r.amount::numeric AS refunds,
              0::numeric AS payments,
              NULL::integer AS customer_id
       FROM nb_refunds r
       WHERE r.status = 'succeeded'
         AND r.currency = 'jpy'
         AND (r.product_name IS NULL OR r.product_name <> 'course-bundle')
         AND r.stripe_created_at >= $1
         AND r.stripe_created_at < $2
       UNION ALL
       SELECT 'course-1', 0::numeric, r.amount::numeric / 2.0, 0::numeric, NULL::integer
       FROM nb_refunds r
       WHERE r.status = 'succeeded' AND r.currency = 'jpy' AND r.product_name = 'course-bundle'
         AND r.stripe_created_at >= $1 AND r.stripe_created_at < $2
       UNION ALL
       SELECT 'course-2', 0::numeric, r.amount::numeric / 2.0, 0::numeric, NULL::integer
       FROM nb_refunds r
       WHERE r.status = 'succeeded' AND r.currency = 'jpy' AND r.product_name = 'course-bundle'
         AND r.stripe_created_at >= $1 AND r.stripe_created_at < $2
     ),
     movements AS (
       SELECT * FROM payment_lines
       UNION ALL
       SELECT * FROM refund_lines
     )
     SELECT category,
            COALESCE(SUM(gross), 0) AS gross,
            COALESCE(SUM(refunds), 0) AS refunds,
            COALESCE(SUM(gross), 0) - COALESCE(SUM(refunds), 0) AS net,
            COALESCE(SUM(payments), 0) AS payments,
            COUNT(DISTINCT customer_id) FILTER (WHERE customer_id IS NOT NULL) AS unique_payers
     FROM movements
     GROUP BY category
     ORDER BY net DESC, category ASC`
  };
}

function buildCompletionExportSql(courseId, totalLessons) {
  return {
    params: [courseId, totalLessons],
    query: `WITH owned AS (
       SELECT ca.access_token, ca.course_id, ca.customer_id
       FROM nb_course_access ca
       WHERE ca.course_id = $1
         AND (ca.expires_at IS NULL OR ca.expires_at > NOW())
         AND NOT EXISTS (
           SELECT 1 FROM nb_refunds r
           JOIN nb_payments p ON r.payment_id = p.id
           WHERE r.status = 'succeeded'
             AND p.customer_id = ca.customer_id
             AND (p.product_name = ca.course_id OR p.product_name = 'course-bundle' OR (ca.course_id = 'course-2' AND p.product_name IN ('course-2-upgrade','course-2-flash')))
         )
     ),
     progress AS (
       SELECT o.access_token,
              COUNT(*) FILTER (WHERE lp.completed) AS completed_count
       FROM owned o
       LEFT JOIN nb_lesson_progress lp
         ON lp.access_token = o.access_token AND lp.course_id = o.course_id
       GROUP BY o.access_token
     ),
     bucketed AS (
       SELECT CASE
         WHEN $2::int <= 0 THEN '0-24%'
         WHEN ROUND(100.0 * completed_count / $2::int) >= 100 THEN '100%'
         WHEN ROUND(100.0 * completed_count / $2::int) >= 75 THEN '75-99%'
         WHEN ROUND(100.0 * completed_count / $2::int) >= 50 THEN '50-74%'
         WHEN ROUND(100.0 * completed_count / $2::int) >= 25 THEN '25-49%'
         ELSE '0-24%'
       END AS range
       FROM progress
     ),
     labels AS (
       SELECT *
       FROM (VALUES
         ('0-24%', 1),
         ('25-49%', 2),
         ('50-74%', 3),
         ('75-99%', 4),
         ('100%', 5)
       ) AS l(range, sort_order)
     )
     SELECT labels.range, COALESCE(COUNT(bucketed.range), 0) AS student_count
     FROM labels
     LEFT JOIN bucketed ON bucketed.range = labels.range
     GROUP BY labels.range, labels.sort_order
     ORDER BY labels.sort_order ASC`
  };
}

function buildDropoffExportSql(courseId) {
  const lessons = getPlayableLessons(courseId);
  return {
    params: [
      courseId,
      lessons.map((lesson) => lesson.id),
      lessons.map((_, index) => index + 1),
      lessons.map((lesson) => lesson.title || lesson.id),
      lessons.map((_, index) => lessons[index + 1]?.id || null)
    ],
    query: `WITH lesson_catalog AS (
       SELECT *
       FROM unnest($2::varchar[], $3::int[], $4::varchar[], $5::varchar[])
         AS t(lesson_id, lesson_order, title, next_lesson_id)
     ),
     owned AS (
       SELECT ca.access_token, ca.course_id, ca.customer_id
       FROM nb_course_access ca
       WHERE ca.course_id = $1
         AND (ca.expires_at IS NULL OR ca.expires_at > NOW())
         AND NOT EXISTS (
           SELECT 1 FROM nb_refunds r
           JOIN nb_payments p ON r.payment_id = p.id
           WHERE r.status = 'succeeded'
             AND p.customer_id = ca.customer_id
             AND (p.product_name = ca.course_id OR p.product_name = 'course-bundle' OR (ca.course_id = 'course-2' AND p.product_name IN ('course-2-upgrade','course-2-flash')))
         )
     )
     SELECT lc.lesson_id, lc.lesson_order AS "order", lc.title, lc.next_lesson_id,
            COUNT(DISTINCT o.access_token) FILTER (WHERE current_lp.id IS NOT NULL) AS started_count,
            COUNT(DISTINCT o.access_token) FILTER (WHERE current_lp.completed) AS completed_count,
            COUNT(DISTINCT o.access_token) FILTER (WHERE current_lp.completed AND next_lp.id IS NOT NULL) AS next_started_count,
            CASE
              WHEN lc.next_lesson_id IS NULL THEN 0
              ELSE GREATEST(
                COUNT(DISTINCT o.access_token) FILTER (WHERE current_lp.completed)
                - COUNT(DISTINCT o.access_token) FILTER (WHERE current_lp.completed AND next_lp.id IS NOT NULL),
                0
              )
            END AS dropoff_count
     FROM lesson_catalog lc
     LEFT JOIN owned o ON TRUE
     LEFT JOIN nb_lesson_progress current_lp
       ON current_lp.access_token = o.access_token
      AND current_lp.course_id = o.course_id
      AND current_lp.lesson_id = lc.lesson_id
     LEFT JOIN nb_lesson_progress next_lp
       ON next_lp.access_token = o.access_token
      AND next_lp.course_id = o.course_id
      AND next_lp.lesson_id = lc.next_lesson_id
     GROUP BY lc.lesson_id, lc.lesson_order, lc.title, lc.next_lesson_id
     ORDER BY lc.lesson_order ASC`
  };
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
  dbHealth,
  rateLimit,
  stringify,
  parse,
  uploadImportCsv,
  multer,
  generateToken,
  transporter,
  smtpFrom,
  siteUrl,
  escapeHtml,
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
      setAuthCookie(res, 'nb_admin_token', token, 24 * 60 * 60 * 1000, { sameSite: 'Strict' });
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
    res.set('Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
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
      logger.info({
        event: 'admin_impersonate',
        adminId: req.admin?.sub || 'root',
        customerId: null,
        courseId: thread.course_id,
        threadId,
        ip: getIP(req)
      }, 'Admin impersonation token minted');
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
      logger.info({
        event: 'admin_impersonate',
        adminId: req.admin?.sub || 'root',
        customerId,
        courseId,
        threadId: null,
        ip: getIP(req)
      }, 'Admin impersonation token minted');
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

  app.get('/api/admin/reports/revenue', authMiddleware, reportsNoStore, async (req, res) => {
    try {
      const range = parseJstDateRange(req.query);
      const granularity = validateGranularity(req.query.granularity);
      const category = validateReportCategory(req.query.category);
      const compareMode = validateCompareMode(req.query.compare);
      const source = (parseBool(req.query.live) || rangeIncludesTodayJst(range)) ? 'live' : 'matview';
      const [buckets, nonJpyExcluded, lastRefreshedAt, legacyActiveSubscriptions] = await Promise.all([
        queryRevenueBuckets(pool, { range, granularity, category, source }),
        getNonJpyExcluded(pool),
        getReportingLastRefreshedAt(pool, source),
        getLegacyActiveSubscriptionCount(pool)
      ]);
      const comparisonRange = computeComparisonRange(range, compareMode);
      const comparisonSource = comparisonRange && (source === 'live' || rangeIncludesTodayJst(comparisonRange)) ? 'live' : source;
      const comparison = comparisonRange
        ? await queryRevenueBuckets(pool, { range: comparisonRange, granularity, category, source: comparisonSource })
        : null;

      res.json({
        buckets,
        comparison,
        totals: totalsForRevenue(buckets),
        comparisonTotals: comparison ? totalsForRevenue(comparison) : null,
        meta: {
          currency: 'jpy',
          lastRefreshedAt,
          source,
          nonJpyExcluded,
          legacyActiveSubscriptions
        }
      });
    } catch (e) {
      logger.error({ err: e }, 'Reporting revenue error');
      res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : 'Server error' });
    }
  });

  app.get('/api/admin/reports/revenue-by-product', authMiddleware, reportsNoStore, async (req, res) => {
    try {
      const range = parseJstDateRange(req.query);
      const rows = await queryRevenueByProduct(pool, range);
      const totals = totalsForRevenue(rows.map((row) => ({
        gross: row.gross,
        refunds: row.refunds,
        net: row.net,
        payments: row.payments,
        uniquePayers: row.uniquePayers
      })));
      const [nonJpyExcluded, lastRefreshedAt] = await Promise.all([
        getNonJpyExcluded(pool),
        getReportingLastRefreshedAt(pool, 'live')
      ]);
      res.json({
        rows,
        totals,
        meta: {
          currency: 'jpy',
          source: 'live',
          lastRefreshedAt,
          nonJpyExcluded
        }
      });
    } catch (e) {
      logger.error({ err: e }, 'Reporting revenue by product error');
      res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : 'Server error' });
    }
  });

  app.get('/api/admin/reports/completion', authMiddleware, reportsNoStore, async (req, res) => {
    try {
      const courseId = assertReportCourse(req.query.course);
      const totalLessons = getCourseLessonCount(courseId);
      const students = (await loadCompletionStudents(pool, courseId))
        .map((row) => mapCompletionStudent(row, totalLessons));
      const counts = new Map(COMPLETION_BUCKETS.map((bucket) => [bucket, 0]));
      let completionTotal = 0;
      for (const student of students) {
        counts.set(student.bucket, (counts.get(student.bucket) || 0) + 1);
        completionTotal += student.completionPct;
      }
      res.json({
        courseId,
        totalLessons,
        totalLessonsSource: 'current-catalog',
        buckets: COMPLETION_BUCKETS.map((bucket) => ({
          range: completionBucketLabel(bucket),
          studentCount: counts.get(bucket) || 0
        })),
        studentTotal: students.length,
        averageCompletion: students.length ? Math.round(completionTotal / students.length) : 0
      });
    } catch (e) {
      logger.error({ err: e }, 'Reporting completion error');
      res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : 'Server error' });
    }
  });

  app.get('/api/admin/reports/completion/students', authMiddleware, reportsNoStore, async (req, res) => {
    try {
      const courseId = assertReportCourse(req.query.course);
      const bucket = validateCompletionBucket(req.query.bucket);
      const totalLessons = getCourseLessonCount(courseId);
      const students = (await loadCompletionStudents(pool, courseId))
        .map((row) => mapCompletionStudent(row, totalLessons))
        .filter((student) => student.bucket === bucket)
        .map((student) => ({
          customerId: student.customerId,
          email: student.email,
          name: student.name,
          completionPct: student.completionPct,
          lastWatchedAt: student.lastWatchedAt
        }));
      res.json({ courseId, bucket, students });
    } catch (e) {
      logger.error({ err: e }, 'Reporting completion students error');
      res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : 'Server error' });
    }
  });

  app.get('/api/admin/reports/dropoff', authMiddleware, reportsNoStore, async (req, res) => {
    try {
      const courseId = assertReportCourse(req.query.course);
      const lessons = await queryDropoffRows(pool, courseId);
      res.json({ courseId, lessons });
    } catch (e) {
      logger.error({ err: e }, 'Reporting dropoff error');
      res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : 'Server error' });
    }
  });

  app.get('/api/admin/reports/payments', authMiddleware, reportsNoStore, async (req, res) => {
    try {
      const paymentDate = assertJstDate(req.query.date, 'date');
      const date = parseJstDateRange({ from: paymentDate, to: addDaysToJstDate(paymentDate, 1) });
      const category = validateReportCategory(req.query.product || 'all');
      const sortKey = validateSort(req.query.sort, REPORT_PAYMENT_SORTS, 'created_at');
      const sortSql = REPORT_PAYMENT_SORTS[sortKey];
      const dir = validateDir(req.query.dir);
      const params = [date.fromUtc, date.toUtc];
      const conditions = [
        'p.status = \'succeeded\'',
        'p.currency = \'jpy\'',
        'p.created_at >= $1',
        'p.created_at < $2'
      ];
      addProductFilter({ conditions, params, alias: 'p', category });
      const result = await pool.query(
        `SELECT p.id, p.amount, p.currency, p.status, p.product_name,
                p.stripe_payment_intent_id, p.stripe_invoice_id, p.created_at,
                c.id AS customer_id, c.email, c.name
         FROM nb_payments p
         LEFT JOIN nb_customers c ON c.id = p.customer_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY ${sortSql} ${dir} NULLS LAST, p.id DESC
         LIMIT 500`,
        params
      );
      res.json({
        date: paymentDate,
        product: category,
        payments: result.rows.map((row) => ({
          id: row.id,
          amount: numberValue(row.amount),
          currency: row.currency,
          status: row.status,
          productName: row.product_name,
          stripePaymentIntentId: row.stripe_payment_intent_id,
          stripeInvoiceId: row.stripe_invoice_id,
          stripeDashboardUrl: buildStripeDashboardUrl(row.stripe_payment_intent_id),
          createdAt: row.created_at,
          customerId: row.customer_id,
          email: row.email,
          name: row.name
        }))
      });
    } catch (e) {
      logger.error({ err: e }, 'Reporting payments drilldown error');
      res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : 'Server error' });
    }
  });

  app.get('/api/admin/reports/non-jpy', authMiddleware, reportsNoStore, async (_req, res) => {
    try {
      const result = await pool.query(
        `SELECT currency, payment_count, total_minor_units
         FROM nb_non_jpy_payments
         ORDER BY currency ASC`
      );
      res.json({
        rows: result.rows.map((row) => ({
          currency: row.currency,
          paymentCount: numberValue(row.payment_count),
          totalMinorUnits: numberValue(row.total_minor_units)
        }))
      });
    } catch (e) {
      logger.error({ err: e }, 'Reporting non-JPY diagnostic error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.get('/api/admin/reports/revenue/export', authMiddleware, reportsNoStore, async (req, res) => {
    try {
      const range = parseJstDateRange(req.query);
      const granularity = validateGranularity(req.query.granularity);
      const category = validateReportCategory(req.query.category);
      const built = buildRevenueExportSql({ range, granularity, category });
      const columns = [
        { key: 'bucket', header: 'bucket' },
        { key: 'gross', header: 'gross_jpy' },
        { key: 'refunds', header: 'refunds_jpy' },
        { key: 'net', header: 'net_jpy' },
        { key: 'payments', header: 'payments' },
        { key: 'unique_payers', header: 'unique_payers' }
      ];
      await streamRowsWithSqlCursor({
        pool,
        res,
        req,
        logger,
        query: built.query,
        params: built.params,
        columns,
        filename: 'reporting-revenue.csv',
        stringify,
        logContext: { admin: req.admin || null, exportType: 'reporting-revenue', filters: req.query },
        mapRows: (rows) => rows.map((row) => escapeCsvRow({
          bucket: formatBucket(row.bucket),
          gross: numberValue(row.gross),
          refunds: numberValue(row.refunds),
          net: numberValue(row.net),
          payments: numberValue(row.payments),
          unique_payers: numberValue(row.unique_payers)
        }))
      });
    } catch (e) {
      logger.error({ err: e }, 'Reporting revenue export setup error');
      if (!res.headersSent) res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : 'Server error' });
    }
  });

  app.get('/api/admin/reports/revenue-by-product/export', authMiddleware, reportsNoStore, async (req, res) => {
    try {
      const range = parseJstDateRange(req.query);
      const built = buildRevenueByProductExportSql(range);
      const columns = [
        { key: 'category', header: 'category' },
        { key: 'gross', header: 'gross_jpy' },
        { key: 'refunds', header: 'refunds_jpy' },
        { key: 'net', header: 'net_jpy' },
        { key: 'payments', header: 'payments' },
        { key: 'unique_payers', header: 'unique_payers' }
      ];
      await streamRowsWithSqlCursor({
        pool,
        res,
        req,
        logger,
        query: built.query,
        params: built.params,
        columns,
        filename: 'reporting-revenue-by-product.csv',
        stringify,
        logContext: { admin: req.admin || null, exportType: 'reporting-revenue-by-product', filters: req.query },
        mapRows: (rows) => rows.map((row) => escapeCsvRow({
          category: row.category,
          gross: numberValue(row.gross),
          refunds: numberValue(row.refunds),
          net: numberValue(row.net),
          payments: numberValue(row.payments),
          unique_payers: numberValue(row.unique_payers)
        }))
      });
    } catch (e) {
      logger.error({ err: e }, 'Reporting revenue by product export setup error');
      if (!res.headersSent) res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : 'Server error' });
    }
  });

  app.get('/api/admin/reports/completion/export', authMiddleware, reportsNoStore, async (req, res) => {
    try {
      const courseId = assertReportCourse(req.query.course);
      const built = buildCompletionExportSql(courseId, getCourseLessonCount(courseId));
      const columns = [
        { key: 'range', header: 'range' },
        { key: 'student_count', header: 'student_count' }
      ];
      await streamRowsWithSqlCursor({
        pool,
        res,
        req,
        logger,
        query: built.query,
        params: built.params,
        columns,
        filename: `reporting-completion-${courseId}.csv`,
        stringify,
        logContext: { admin: req.admin || null, exportType: 'reporting-completion', courseId },
        mapRows: (rows) => rows.map((row) => escapeCsvRow({
          range: row.range,
          student_count: numberValue(row.student_count)
        }))
      });
    } catch (e) {
      logger.error({ err: e }, 'Reporting completion export setup error');
      if (!res.headersSent) res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : 'Server error' });
    }
  });

  app.get('/api/admin/reports/dropoff/export', authMiddleware, reportsNoStore, async (req, res) => {
    try {
      const courseId = assertReportCourse(req.query.course);
      const built = buildDropoffExportSql(courseId);
      const columns = [
        { key: 'lesson_id', header: 'lesson_id' },
        { key: 'order', header: 'order' },
        { key: 'title', header: 'title' },
        { key: 'started_count', header: 'started_count' },
        { key: 'completed_count', header: 'completed_count' },
        { key: 'next_started_count', header: 'next_started_count' },
        { key: 'dropoff_count', header: 'dropoff_count' },
        { key: 'dropoff_rate', header: 'dropoff_rate' }
      ];
      await streamRowsWithSqlCursor({
        pool,
        res,
        req,
        logger,
        query: built.query,
        params: built.params,
        columns,
        filename: `reporting-dropoff-${courseId}.csv`,
        stringify,
        logContext: { admin: req.admin || null, exportType: 'reporting-dropoff', courseId },
        mapRows: (rows) => rows.map((row) => {
          const completedCount = numberValue(row.completed_count);
          const nextStartedCount = numberValue(row.next_started_count);
          const dropoffRate = completedCount > 0 && row.next_lesson_id ? 1 - (nextStartedCount / completedCount) : 0;
          return escapeCsvRow({
            lesson_id: row.lesson_id,
            order: numberValue(row.order),
            title: row.title || '',
            started_count: numberValue(row.started_count),
            completed_count: completedCount,
            next_started_count: nextStartedCount,
            dropoff_count: numberValue(row.dropoff_count),
            dropoff_rate: dropoffRate
          });
        })
      });
    } catch (e) {
      logger.error({ err: e }, 'Reporting dropoff export setup error');
      if (!res.headersSent) res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : 'Server error' });
    }
  });

  app.get('/api/admin/stats', authMiddleware, async (_req, res) => {
    try {
      if (dbHealth?.degraded) return res.status(503).json({ error: 'Database degraded' });
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
        if (!['active', 'unsubscribed', 'bounced'].includes(String(status))) {
          return res.status(400).json({ error: 'Invalid status' });
        }
        conditions.push(`status = $${idx++}`);
        params.push(status);
      }
      if (source) {
        conditions.push(`source = $${idx++}`);
        params.push(String(source).slice(0, 100));
      }
      if (search) {
        conditions.push(`(email ILIKE $${idx} OR name ILIKE $${idx})`);
        params.push(`%${String(search).slice(0, 200)}%`);
        idx++;
      }
      if (tag) {
        conditions.push(`$${idx++} = ANY(tags)`);
        params.push(String(tag).trim().toLowerCase().slice(0, 100));
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
      if (status && !['active', 'unsubscribed', 'bounced'].includes(String(status))) {
        return res.status(400).json({ error: 'Invalid status' });
      }
      const where = status ? 'WHERE status = $1' : '';
      const params = status ? [status] : [];
      const result = await pool.query(
        `SELECT email, name, source, status, array_to_string(tags, ',') AS tags, created_at
         FROM nb_subscribers ${where} ORDER BY created_at DESC LIMIT 50000`,
        params
      );
      // escapeCsvRow defends against =/+/-/@-prefixed formula injection in
      // Excel for fields like name that a malicious subscriber can shape.
      const safeRows = result.rows.map((row) => escapeCsvRow({
        email: row.email,
        name: row.name || '',
        source: row.source || '',
        status: row.status,
        tags: row.tags || '',
        created_at: row.created_at
      }));
      const csv = stringify(safeRows, { header: true });
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
      const subscriberId = parseInt(req.params.id, 10);
      if (!subscriberId) return res.status(400).json({ error: 'Invalid subscriber id' });
      const tags = normalizeCustomerTags(req.body?.tags);
      const result = await pool.query(
        'UPDATE nb_subscribers SET tags = $1, updated_at = NOW() WHERE id = $2 RETURNING id, tags',
        [tags, subscriberId]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Subscriber not found' });
      res.json(result.rows[0]);
    } catch (e) {
      logger.error({ err: e }, 'Tags error');
      res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : 'Server error' });
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

  // Segments named after nb_subscribers.source values (contact_form,
  // pdf_download, newsletter, import) filter on source; anything else filters
  // on tags. 'all' and empty skip segment filtering entirely.
  const SOURCE_SEGMENTS = new Set(['contact_form', 'pdf_download', 'newsletter', 'import']);
  function buildSegmentClause(segment, startIdx) {
    if (!segment || segment === 'all') return { sql: '', params: [] };
    if (SOURCE_SEGMENTS.has(segment)) {
      return { sql: ` AND source = $${startIdx}`, params: [segment] };
    }
    return { sql: ` AND $${startIdx} = ANY(tags)`, params: [segment] };
  }

  async function querySegmentSubscribers(segment) {
    const segClause = buildSegmentClause(segment, 1);
    const result = await pool.query(
      `SELECT id, email, name, unsubscribe_token
         FROM nb_subscribers
        WHERE status = 'active'${segClause.sql}`,
      segClause.params
    );
    return result.rows;
  }

  // Runs the per-recipient send loop for a campaign that's already in
  // 'sending' state with recipient rows materialised. Claims each row via
  // atomic pending→sending transition so a concurrent resume/restart can't
  // double-send. Detached from the HTTP handler — callers must not await it
  // on the request path.
  async function sendCampaignLoop(current) {
    let loopErr = null;
    try {
      const pending = await pool.query(
        `SELECT r.id, r.subscriber_id, r.email, r.tracking_id,
                s.unsubscribe_token, s.status AS sub_status
           FROM nb_campaign_recipients r
           JOIN nb_subscribers s ON r.subscriber_id = s.id
          WHERE r.campaign_id = $1 AND r.status = 'pending'
          ORDER BY r.id ASC`,
        [current.id]
      );

      for (const recipient of pending.rows) {
        // Atomic claim: only proceed if we can flip pending→sending. Losing
        // the race (e.g., second resume worker) just skips silently.
        const claim = await pool.query(
          `UPDATE nb_campaign_recipients
             SET status = 'sending'
           WHERE id = $1 AND status = 'pending'
           RETURNING id`,
          [recipient.id]
        );
        if (claim.rows.length === 0) continue;

        // Re-check subscriber status in case they unsubscribed between the
        // initial snapshot and now.
        const sub = await pool.query(
          'SELECT status FROM nb_subscribers WHERE id = $1',
          [recipient.subscriber_id]
        );
        if (sub.rows[0]?.status !== 'active') {
          await pool.query(
            "UPDATE nb_campaign_recipients SET status = 'skipped' WHERE id = $1",
            [recipient.id]
          ).catch(() => {});
          continue;
        }

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
          await pool.query(
            "UPDATE nb_campaign_recipients SET status = 'sent' WHERE id = $1",
            [recipient.id]
          ).catch((dbErr) => logger.error({ err: dbErr, recipientId: recipient.id }, 'Campaign: failed to mark recipient as sent'));
          await new Promise((resolve) => setTimeout(resolve, 100));
        } catch (err) {
          logger.error({ err, email: recipient.email, campaignId: current.id }, 'Failed to send campaign email');
          await pool.query(
            "UPDATE nb_campaign_recipients SET status = 'bounced', bounced_at = NOW() WHERE id = $1",
            [recipient.id]
          ).catch(() => {});
        }
      }
    } catch (err) {
      loopErr = err;
      logger.error({ err, campaignId: current.id }, 'Campaign send loop error');
    }

    // Rollup from the recipients table so sent_count / bounce_count reflect
    // the true delivered state even if the loop crashed mid-way.
    try {
      const rollup = await pool.query(
        `SELECT COUNT(*) FILTER (WHERE status = 'sent') AS sent,
                COUNT(*) FILTER (WHERE status = 'bounced') AS bounced,
                COUNT(*) FILTER (WHERE status IN ('pending', 'sending')) AS stuck,
                COUNT(*) AS total
           FROM nb_campaign_recipients
          WHERE campaign_id = $1`,
        [current.id]
      );
      const { sent, bounced, stuck, total } = rollup.rows[0];
      const finalStatus = loopErr ? 'failed' : (Number(stuck) > 0 ? 'sending' : 'sent');
      await pool.query(
        `UPDATE nb_campaigns
            SET status = $1,
                sent_count = $2,
                bounce_count = $3,
                updated_at = NOW()
          WHERE id = $4`,
        [finalStatus, sent, bounced, current.id]
      );
      if (finalStatus === 'sent') {
        sendWhatsApp(namiJid, `Campaign sent: "${current.subject}"\n${sent}/${total} emails delivered`)
          .catch((e) => logger.error({ err: e }, 'WhatsApp fire-and-forget error'));
      } else if (finalStatus === 'failed') {
        sendWhatsApp(namiJid, `Campaign "${current.subject}" crashed mid-send — ${sent}/${total} delivered, ${stuck} stuck. Use /resume to retry.`)
          .catch((e) => logger.error({ err: e }, 'WhatsApp fire-and-forget error'));
      }
    } catch (finalizeErr) {
      logger.error({ err: finalizeErr, campaignId: current.id }, 'Campaign finalization DB error');
    }
  }

  app.post('/api/admin/campaigns', authMiddleware, async (req, res) => {
    try {
      const payload = validateCampaignPayload(req.body || {});
      const result = await pool.query(
        `INSERT INTO nb_campaigns (subject, html_body, text_body, segment)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [payload.subject, payload.html_body, payload.text_body || null, payload.segment]
      );
      res.json(result.rows[0]);
    } catch (e) {
      if (e.statusCode) return res.status(e.statusCode).json({ error: e.message });
      logger.error({ err: e }, 'Create campaign error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.put('/api/admin/campaigns/:id', authMiddleware, async (req, res) => {
    try {
      const campaignId = parseInt(req.params.id, 10);
      if (!campaignId) return res.status(400).json({ error: 'Invalid campaign id' });
      const payload = validateCampaignPayload(req.body || {});
      const result = await pool.query(
        `UPDATE nb_campaigns
            SET subject = $1, html_body = $2, text_body = $3, segment = $4, updated_at = NOW()
          WHERE id = $5 AND status = 'draft'
          RETURNING *`,
        [payload.subject, payload.html_body, payload.text_body || null, payload.segment, campaignId]
      );
      if (result.rows.length === 0) {
        const exists = await pool.query('SELECT status FROM nb_campaigns WHERE id = $1', [campaignId]);
        if (exists.rows.length === 0) return res.status(404).json({ error: 'Campaign not found' });
        return res.status(409).json({ error: `Cannot edit campaign in status '${exists.rows[0].status}'` });
      }
      res.json(result.rows[0]);
    } catch (e) {
      if (e.statusCode) return res.status(e.statusCode).json({ error: e.message });
      logger.error({ err: e }, 'Update campaign error');
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

      // Test sends skip tracking injection — pixel and unsub link would 404
      // for a synthetic tracking id, which is worse than not tracking.
      await transporter.sendMail({
        from: smtpFrom,
        to: email,
        subject: `[TEST] ${current.subject}`,
        html: current.html_body,
        text: current.text_body || ''
      });

      res.json({ ok: true, message: `Test sent to ${email}` });
    } catch (e) {
      logger.error({ err: e }, 'Test send error');
      res.status(500).json({ error: 'Failed to send test email' });
    }
  });

  app.post('/api/admin/campaigns/:id/send', authMiddleware, async (req, res) => {
    const campaignId = parseInt(req.params.id, 10);
    if (!campaignId) return res.status(400).json({ error: 'Invalid campaign id' });
    try {
      // Atomic claim: only one concurrent POST can flip draft/failed → sending.
      // The old SELECT FOR UPDATE released the lock between statements, which
      // is why a double-click could double-send.
      const claim = await pool.query(
        `UPDATE nb_campaigns
            SET status = 'sending', sent_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND status IN ('draft', 'failed')
          RETURNING *`,
        [campaignId]
      );
      if (claim.rows.length === 0) {
        const exists = await pool.query('SELECT status FROM nb_campaigns WHERE id = $1', [campaignId]);
        if (exists.rows.length === 0) return res.status(404).json({ error: 'Campaign not found' });
        return res.status(409).json({ error: `Campaign is already ${exists.rows[0].status}` });
      }
      const current = claim.rows[0];

      let subs;
      try {
        subs = await querySegmentSubscribers(current.segment);
      } catch (err) {
        await pool.query("UPDATE nb_campaigns SET status = 'draft', updated_at = NOW() WHERE id = $1", [campaignId]).catch(() => {});
        throw err;
      }
      if (subs.length === 0) {
        // Roll back — the campaign is still a draft worth editing.
        await pool.query("UPDATE nb_campaigns SET status = 'draft', sent_at = NULL, updated_at = NOW() WHERE id = $1", [campaignId]);
        return res.status(400).json({ error: 'No active subscribers match this segment' });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await insertRecipientsChunked(client, current.id, subs, uuidv4);
        await client.query(
          'UPDATE nb_campaigns SET total_count = $1, updated_at = NOW() WHERE id = $2',
          [subs.length, current.id]
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        await pool.query(
          "UPDATE nb_campaigns SET status = 'failed', updated_at = NOW() WHERE id = $1",
          [current.id]
        ).catch(() => {});
        logger.error({ err, campaignId: current.id }, 'Campaign recipient INSERT failed');
        return res.status(500).json({ error: 'Failed to insert recipients' });
      } finally {
        client.release();
      }

      res.json({ ok: true, total: subs.length, message: 'Campaign sending started' });
      // Detach the send loop from the response. A crash mid-loop leaves
      // pending rows that /resume can pick up.
      sendCampaignLoop(current).catch((err) =>
        logger.error({ err, campaignId: current.id }, 'Campaign send loop unhandled')
      );
    } catch (e) {
      logger.error({ err: e }, 'Send campaign error');
      await pool.query(
        "UPDATE nb_campaigns SET status = 'failed', updated_at = NOW() WHERE id = $1",
        [campaignId]
      ).catch(() => {});
      if (!res.headersSent) res.status(500).json({ error: 'Failed to send campaign' });
    }
  });

  app.post('/api/admin/campaigns/:id/resume', authMiddleware, async (req, res) => {
    const campaignId = parseInt(req.params.id, 10);
    if (!campaignId) return res.status(400).json({ error: 'Invalid campaign id' });
    try {
      // Flip failed → sending so the claim semantics still apply. 'sending'
      // stays 'sending' so we don't spawn two loops for the same campaign.
      const flipped = await pool.query(
        `UPDATE nb_campaigns
            SET status = 'sending', updated_at = NOW()
          WHERE id = $1 AND status IN ('sending', 'failed')
          RETURNING *`,
        [campaignId]
      );
      if (flipped.rows.length === 0) {
        const exists = await pool.query('SELECT status FROM nb_campaigns WHERE id = $1', [campaignId]);
        if (exists.rows.length === 0) return res.status(404).json({ error: 'Campaign not found' });
        return res.status(409).json({ error: `Cannot resume campaign in status '${exists.rows[0].status}'` });
      }
      const pendingCount = await pool.query(
        "SELECT COUNT(*)::int AS c FROM nb_campaign_recipients WHERE campaign_id = $1 AND status = 'pending'",
        [campaignId]
      );
      res.json({ ok: true, pending: pendingCount.rows[0].c });
      sendCampaignLoop(flipped.rows[0]).catch((err) =>
        logger.error({ err, campaignId }, 'Campaign resume loop unhandled')
      );
    } catch (e) {
      logger.error({ err: e }, 'Resume campaign error');
      if (!res.headersSent) res.status(500).json({ error: 'Failed to resume campaign' });
    }
  });
}

module.exports = {
  createAdminRoutes,
  normalizeLuminaStatus,
  buildStripeDashboardUrl
};
