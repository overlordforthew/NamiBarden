const PRODUCT_CATEGORY = {
  'course-1': 'course-1',
  'course-2': 'course-2',
  'course-2-upgrade': 'course-2',
  'course-2-flash': 'course-2',
  'course-bundle': 'course-bundle',
  'certification-monthly': 'certification',
  'certification-lumpsum': 'certification',
  'couples-monthly': 'couples',
  'couples-lumpsum': 'couples',
  'single-session': 'single-session',
  coaching: 'coaching',
  'lumina-lifetime': 'lumina-lifetime',
  'lumina-monthly': 'lumina-lifetime',
  'lumina-annual': 'lumina-lifetime'
};

const REPORT_CATEGORY_VALUES = new Set([
  'all',
  'course-1',
  'course-2',
  'course-bundle',
  'certification',
  'couples',
  'lumina-lifetime',
  'single-session'
]);

const GRANULARITY_SQL = {
  day: (column) => `(date_trunc('day', ${column} AT TIME ZONE 'Asia/Tokyo')) AT TIME ZONE 'Asia/Tokyo'`,
  week: (column) => `(date_trunc('week', ${column} AT TIME ZONE 'Asia/Tokyo')) AT TIME ZONE 'Asia/Tokyo'`,
  month: (column) => `(date_trunc('month', ${column} AT TIME ZONE 'Asia/Tokyo')) AT TIME ZONE 'Asia/Tokyo'`
};

const COMPARE_MODES = new Set(['none', 'prior-period', 'yoy']);
const COMPLETION_BUCKETS = ['0-24', '25-49', '50-74', '75-99', '100'];
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function categorize(productName) {
  return PRODUCT_CATEGORY[productName] || 'other';
}

function productsForCategory(category) {
  if (!category || category === 'all') return [];
  return Object.entries(PRODUCT_CATEGORY)
    .filter(([, mapped]) => mapped === category)
    .map(([product]) => product);
}

function validateGranularity(raw) {
  const value = String(raw || 'day').toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(GRANULARITY_SQL, value)) {
    const err = new Error('Invalid granularity');
    err.statusCode = 400;
    throw err;
  }
  return value;
}

function validateReportCategory(raw) {
  const value = String(raw || 'all');
  if (!REPORT_CATEGORY_VALUES.has(value)) {
    const err = new Error('Invalid category');
    err.statusCode = 400;
    throw err;
  }
  return value;
}

function validateCompareMode(raw) {
  const value = String(raw || 'none').toLowerCase();
  if (!COMPARE_MODES.has(value)) {
    const err = new Error('Invalid compare mode');
    err.statusCode = 400;
    throw err;
  }
  return value;
}

function validateSort(raw, sorts, fallback) {
  const value = String(raw || fallback);
  if (!Object.prototype.hasOwnProperty.call(sorts, value)) {
    const err = new Error('Invalid sort');
    err.statusCode = 400;
    throw err;
  }
  return value;
}

function validateDir(raw) {
  const value = String(raw || 'desc').toLowerCase();
  if (value !== 'asc' && value !== 'desc') {
    const err = new Error('Invalid dir');
    err.statusCode = 400;
    throw err;
  }
  return value === 'asc' ? 'ASC' : 'DESC';
}

function parseBool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function assertJstDate(value, label) {
  const raw = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const err = new Error(`Invalid ${label} date`);
    err.statusCode = 400;
    throw err;
  }
  const dt = new Date(`${raw}T00:00:00+09:00`);
  if (!Number.isFinite(dt.getTime()) || formatJstDate(dt) !== raw) {
    const err = new Error(`Invalid ${label} date`);
    err.statusCode = 400;
    throw err;
  }
  return raw;
}

function formatJstDate(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function jstDateToUtcDate(dateString) {
  return new Date(`${dateString}T00:00:00+09:00`);
}

function addDaysToJstDate(dateString, days) {
  const date = jstDateToUtcDate(dateString);
  return formatJstDate(new Date(date.getTime() + days * MS_PER_DAY));
}

function parseJstDateRange(query) {
  const from = assertJstDate(query.from, 'from');
  const to = assertJstDate(query.to, 'to');
  const fromUtc = jstDateToUtcDate(from);
  const toUtc = jstDateToUtcDate(to);
  if (toUtc <= fromUtc) {
    const err = new Error('to must be after from');
    err.statusCode = 400;
    throw err;
  }
  return { from, to, fromUtc, toUtc, days: Math.round((toUtc - fromUtc) / MS_PER_DAY) };
}

function todayJstDate() {
  return formatJstDate(new Date());
}

function rangeIncludesTodayJst(range) {
  const today = todayJstDate();
  return range.from <= today && today < range.to;
}

function computeComparisonRange(range, mode) {
  if (mode === 'none') return null;
  if (mode === 'prior-period') {
    const to = range.from;
    const from = addDaysToJstDate(range.from, -range.days);
    return { from, to, fromUtc: jstDateToUtcDate(from), toUtc: jstDateToUtcDate(to), days: range.days };
  }
  const fromYear = Number(range.from.slice(0, 4)) - 1;
  const toYear = Number(range.to.slice(0, 4)) - 1;
  const from = `${fromYear}${range.from.slice(4)}`;
  const to = `${toYear}${range.to.slice(4)}`;
  assertJstDate(from, 'comparison from');
  assertJstDate(to, 'comparison to');
  return { from, to, fromUtc: jstDateToUtcDate(from), toUtc: jstDateToUtcDate(to), days: range.days };
}

function completionBucketForPercent(percent) {
  const value = Number(percent) || 0;
  if (value >= 100) return '100';
  if (value >= 75) return '75-99';
  if (value >= 50) return '50-74';
  if (value >= 25) return '25-49';
  return '0-24';
}

function completionBucketLabel(bucket) {
  return bucket === '100' ? '100%' : `${bucket}%`;
}

function validateCompletionBucket(raw) {
  const bucket = String(raw || '');
  if (!COMPLETION_BUCKETS.includes(bucket)) {
    const err = new Error('Invalid completion bucket');
    err.statusCode = 400;
    throw err;
  }
  return bucket;
}

function escapeCsvCell(value) {
  if (value == null) return '';
  const text = String(value);
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

function escapeCsvRow(row) {
  const escaped = {};
  for (const [key, value] of Object.entries(row)) {
    escaped[key] = escapeCsvCell(value);
  }
  return escaped;
}

function buildProductCategoryCaseSql(column) {
  const clauses = Object.entries(PRODUCT_CATEGORY)
    .map(([product, category]) => `WHEN ${column} = '${product.replace(/'/g, "''")}' THEN '${category.replace(/'/g, "''")}'`);
  return `CASE ${clauses.join(' ')} ELSE 'other' END`;
}

const REFUND_UPSERT_SQL = `INSERT INTO nb_refunds (
   customer_id, payment_id, stripe_refund_id, stripe_charge_id, stripe_payment_intent_id,
   amount, currency, reason, status, product_name, metadata, stripe_created_at, last_stripe_event_at
 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,to_timestamp($12),to_timestamp($13))
 ON CONFLICT (stripe_refund_id) DO UPDATE SET
   customer_id = COALESCE(EXCLUDED.customer_id, nb_refunds.customer_id),
   payment_id  = COALESCE(EXCLUDED.payment_id,  nb_refunds.payment_id),
   stripe_charge_id = COALESCE(EXCLUDED.stripe_charge_id, nb_refunds.stripe_charge_id),
   stripe_payment_intent_id = COALESCE(EXCLUDED.stripe_payment_intent_id, nb_refunds.stripe_payment_intent_id),
   amount = CASE WHEN nb_refunds.last_stripe_event_at IS NULL OR EXCLUDED.last_stripe_event_at >= nb_refunds.last_stripe_event_at THEN EXCLUDED.amount ELSE nb_refunds.amount END,
   currency = CASE WHEN nb_refunds.last_stripe_event_at IS NULL OR EXCLUDED.last_stripe_event_at >= nb_refunds.last_stripe_event_at THEN EXCLUDED.currency ELSE nb_refunds.currency END,
   reason = COALESCE(EXCLUDED.reason, nb_refunds.reason),
   status = CASE WHEN nb_refunds.last_stripe_event_at IS NULL OR EXCLUDED.last_stripe_event_at >= nb_refunds.last_stripe_event_at THEN EXCLUDED.status ELSE nb_refunds.status END,
   product_name = COALESCE(EXCLUDED.product_name, nb_refunds.product_name),
   metadata = COALESCE(nb_refunds.metadata,'{}'::jsonb) || EXCLUDED.metadata,
   stripe_created_at = CASE WHEN nb_refunds.last_stripe_event_at IS NULL OR EXCLUDED.last_stripe_event_at >= nb_refunds.last_stripe_event_at THEN EXCLUDED.stripe_created_at ELSE nb_refunds.stripe_created_at END,
   last_stripe_event_at = GREATEST(nb_refunds.last_stripe_event_at, EXCLUDED.last_stripe_event_at)
 RETURNING (xmax = 0) AS inserted`;

async function findPaymentForRefund(pool, refund) {
  const pi = typeof refund.payment_intent === 'string' ? refund.payment_intent : refund.payment_intent?.id;
  const ch = typeof refund.charge === 'string' ? refund.charge : refund.charge?.id;
  let paymentRow = null;
  if (pi) {
    const result = await pool.query(
      `SELECT id, customer_id, product_name FROM nb_payments WHERE stripe_payment_intent_id=$1 LIMIT 1`,
      [pi]
    );
    paymentRow = result.rows[0] || null;
  }
  if (!paymentRow && ch) {
    const result = await pool.query(
      `SELECT id, customer_id, product_name FROM nb_payments WHERE stripe_charge_id=$1 LIMIT 1`,
      [ch]
    );
    paymentRow = result.rows[0] || null;
  }
  return { paymentRow, pi: pi || null, ch: ch || null };
}

async function upsertStripeRefund(pool, refund, paymentRow, ids = {}) {
  const pi = ids.pi || (typeof refund.payment_intent === 'string' ? refund.payment_intent : refund.payment_intent?.id) || null;
  const ch = ids.ch || (typeof refund.charge === 'string' ? refund.charge : refund.charge?.id) || null;
  // event timestamp for order-safety; callers may pass ids.eventCreated (webhook event.created)
  // Falls back to refund.created — conservative: treat as baseline if nothing newer known.
  const eventTs = ids.eventCreated || refund.created;
  return pool.query(
    REFUND_UPSERT_SQL,
    [
      paymentRow?.customer_id || null,
      paymentRow?.id || null,
      refund.id,
      ch,
      pi,
      refund.amount,
      refund.currency,
      refund.reason || null,
      refund.status,
      paymentRow?.product_name || null,
      JSON.stringify(refund.metadata || {}),
      refund.created,
      eventTs
    ]
  );
}

function createPoolConfigFromEnv() {
  return {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'namibarden',
    user: process.env.DB_USER || 'namibarden',
    password: process.env.DB_PASSWORD || process.env.DB_PASS || '',
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    max: 5
  };
}

module.exports = {
  PRODUCT_CATEGORY,
  REPORT_CATEGORY_VALUES,
  GRANULARITY_SQL,
  COMPLETION_BUCKETS,
  REFUND_UPSERT_SQL,
  categorize,
  productsForCategory,
  validateGranularity,
  validateReportCategory,
  validateCompareMode,
  validateSort,
  validateDir,
  parseBool,
  assertJstDate,
  parseJstDateRange,
  formatJstDate,
  addDaysToJstDate,
  todayJstDate,
  rangeIncludesTodayJst,
  computeComparisonRange,
  completionBucketForPercent,
  completionBucketLabel,
  validateCompletionBucket,
  escapeCsvCell,
  escapeCsvRow,
  buildProductCategoryCaseSql,
  findPaymentForRefund,
  upsertStripeRefund,
  createPoolConfigFromEnv
};
