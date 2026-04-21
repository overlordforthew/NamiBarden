# Phase 4 — Revenue reporting + course completion dashboard

**Status:** post-consensus (Opus + GPT-5.4 xhigh). 1 CRITICAL + 14 HIGH + 18 MEDIUM issues from first-draft review resolved.
**Dependencies:** Phase 1 (Lumina lifetime), Phase 2 (customer detail), Phase 3 (chat) all LIVE.

## 1. Goals (unchanged from draft)

- Per-course revenue (gross, refunds, net) at day / week / month granularity.
- Refund dashboard (amounts by day, by reason).
- One-time + Lumina lifetime sales breakdown.
- Prior-period overlay (MoM, YoY).
- Completion % cohort buckets per course.
- Per-lesson drop-off (started → completed → next-started).
- Click-through drill-down: day/product cell → list of payments; completion bucket → list of students.
- CSV exports for every table.

## 2. Product decisions (post-consensus, locked)

| Item | Decision |
|---|---|
| Currency | **JPY-only** at every layer — matview base WHERE filter, endpoint SQL, CSV. Non-JPY payments captured in a separate `nonJpyDiagnostic` endpoint (count + currency breakdown). |
| Accounting model | **Cash-date model.** Refunds aggregated by the Stripe refund's `created` timestamp, NOT by the original payment date. A refund on April 20 for an April 1 payment shows as an April 20 refund event. |
| Refund event sources | `refund.created` + `refund.updated` Stripe webhooks (idempotent by `stripe_refund_id`). `charge.refunded` is **ignored** (its embedded list is unreliable; per-refund events are authoritative). |
| Refund-before-payment | Orphan refunds insert with `payment_id=NULL`, reconciled when the payment arrives. |
| `stripe_charge_id` on payments | Added in the migration so refunds can link by charge or PI. |
| Granularity | `day` / `week` / `month` only. `quarter` and `YTD` deferred — computable client-side from month buckets if needed. |
| Time zone | JST (`Asia/Tokyo`) everywhere. Matview grouping, endpoint filtering, cron scheduling all tagged explicitly. |
| Date range semantics | Half-open: `from` inclusive (JST midnight), `to` exclusive (JST midnight of the following day). |
| Matview design | Two separate matviews: `nb_revenue_daily` (pure payments) and `nb_refunds_daily` (pure refunds). NO JOIN at matview level. Endpoints stitch the two on (day, product_category). |
| Matview migration | DROP IF EXISTS + CREATE (not `CREATE IF NOT EXISTS`) so revisions actually take effect on redeploy. |
| Completion denominator | Label all cohort + drop-off output as "against current catalog." No historical snapshot in Phase 4. Add a snapshot layer in Phase 5 if Gil adds new lessons mid-cohort. |
| Refunded access in completion | Students with a refund for the course are **excluded** from the cohort denominator. Join `nb_refunds.payment_id` ↔ `nb_payments` and exclude the access row. |
| Product category map | Explicit dictionary (see §4.4). `course-1`, `course-2` map to themselves. `course-bundle` allocates 50/50 to `course-1`/`course-2` in breakdown views but shows as its own row in transaction list. `course-2-upgrade` + `course-2-flash` roll up to `course-2`. `certification-*` → `certification`. `couples-*` → `couples`. `lumina-*` → `lumina-lifetime` (since legacy keys alias to the same price now). |
| MRR panel | **Removed from dashboard.** Phase 1 migrated all active Lumina subs; MRR is structurally zero. A small "Legacy active subscriptions" diagnostic count shows only if `nb_subscriptions.status IN ('active','trialing','past_due')` has ≥1 row. |
| SQL injection | Granularity / sort / dir / compare-mode are **whitelisted** to SQL fragment maps. No string interpolation from query params. |
| CSV pattern | Reuse Phase 2's `streamRowsWithSqlCursor({ req, res, ... })` helper (close-aware, disconnect-safe). **No `pg-cursor` dep.** |
| CSV formula injection | Prefix any cell beginning with `=`, `+`, `-`, `@`, `\t`, `\r` with a leading apostrophe `'`. Applied to all PII-carrying exports. |
| Chart.js | **Vendored** at `public/vendor/chart.min.js` (pinned version), served from same-origin. No CDN, no SRI management. |
| JSON embedding | All chart data fetched via authenticated API calls (NOT inlined into HTML). Rendered via `textContent` / Chart.js setters with no `innerHTML`. |
| Admin auth | Every `/api/admin/reports/*` endpoint — including exports — uses `authMiddleware`. Responses set `Cache-Control: no-store`. |
| Matview refresh default freshness | `/api/admin/reports/revenue?live=true` default for ranges that include **today's** JST day. Matview-backed for historical ranges. Response includes `lastRefreshedAt`. |
| Cron locking | `flock -n /tmp/namibarden-reporting-refresh.lock ...`. Tagged `TZ=Asia/Tokyo`. Install script follows existing `install-monitoring-cron.sh` pattern. |

## 3. Schema changes

```sql
-- migrations/004_reporting.sql

BEGIN;

-- 1) Add stripe_charge_id to payments (non-breaking; existing rows get NULL)
ALTER TABLE nb_payments
  ADD COLUMN IF NOT EXISTS stripe_charge_id VARCHAR(255);
CREATE INDEX IF NOT EXISTS idx_payments_charge_id ON nb_payments(stripe_charge_id);

-- 2) Refunds table
CREATE TABLE IF NOT EXISTS nb_refunds (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER REFERENCES nb_customers(id) ON DELETE SET NULL,
  payment_id INTEGER REFERENCES nb_payments(id) ON DELETE SET NULL,
  stripe_refund_id VARCHAR(255) UNIQUE NOT NULL,
  stripe_charge_id VARCHAR(255),
  stripe_payment_intent_id VARCHAR(255),
  amount INTEGER NOT NULL,
  currency VARCHAR(10) NOT NULL,
  reason VARCHAR(100),
  status VARCHAR(50) NOT NULL,
  product_name VARCHAR(255),
  metadata JSONB DEFAULT '{}'::jsonb,
  stripe_created_at TIMESTAMPTZ NOT NULL,   -- authoritative refund timestamp from Stripe
  created_at TIMESTAMP DEFAULT NOW()         -- DB insert time (diagnostic only)
);

CREATE INDEX IF NOT EXISTS idx_refunds_customer ON nb_refunds(customer_id);
CREATE INDEX IF NOT EXISTS idx_refunds_payment ON nb_refunds(payment_id);
CREATE INDEX IF NOT EXISTS idx_refunds_stripe_created ON nb_refunds(stripe_created_at DESC);
CREATE INDEX IF NOT EXISTS idx_refunds_charge ON nb_refunds(stripe_charge_id);
CREATE INDEX IF NOT EXISTS idx_refunds_pi ON nb_refunds(stripe_payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_refunds_product ON nb_refunds(product_name);

-- 3) Payment daily rollup (JPY-only, successes only)
DROP MATERIALIZED VIEW IF EXISTS nb_revenue_daily;
CREATE MATERIALIZED VIEW nb_revenue_daily AS
SELECT
  (date_trunc('day', p.created_at AT TIME ZONE 'Asia/Tokyo')) AT TIME ZONE 'Asia/Tokyo' AS day,
  COALESCE(p.product_name, 'unknown') AS product_name,
  COALESCE(SUM(p.amount), 0) AS gross,
  COUNT(*) AS payment_count,
  COUNT(DISTINCT p.customer_id) AS unique_payers
FROM nb_payments p
WHERE p.status = 'succeeded'
  AND p.currency = 'jpy'
GROUP BY 1, 2;

CREATE UNIQUE INDEX IF NOT EXISTS idx_revenue_daily_unique
  ON nb_revenue_daily(day, product_name);
CREATE INDEX IF NOT EXISTS idx_revenue_daily_day
  ON nb_revenue_daily(day DESC);

-- 4) Refund daily rollup (JPY-only, succeeded refunds only, by Stripe refund date)
DROP MATERIALIZED VIEW IF EXISTS nb_refunds_daily;
CREATE MATERIALIZED VIEW nb_refunds_daily AS
SELECT
  (date_trunc('day', r.stripe_created_at AT TIME ZONE 'Asia/Tokyo')) AT TIME ZONE 'Asia/Tokyo' AS day,
  COALESCE(r.product_name, 'unknown') AS product_name,
  COALESCE(SUM(r.amount), 0) AS refund_amount,
  COUNT(*) AS refund_count
FROM nb_refunds r
WHERE r.status = 'succeeded'
  AND r.currency = 'jpy'
GROUP BY 1, 2;

CREATE UNIQUE INDEX IF NOT EXISTS idx_refunds_daily_unique
  ON nb_refunds_daily(day, product_name);
CREATE INDEX IF NOT EXISTS idx_refunds_daily_day
  ON nb_refunds_daily(day DESC);

-- 5) Non-JPY diagnostic view (not materialized; cheap on demand)
CREATE OR REPLACE VIEW nb_non_jpy_payments AS
SELECT currency, COUNT(*) AS payment_count, SUM(amount) AS total_minor_units
FROM nb_payments
WHERE status = 'succeeded' AND currency <> 'jpy'
GROUP BY currency;

COMMIT;
```

Refresh pattern (called by cron + post-deploy verification):

```sql
REFRESH MATERIALIZED VIEW CONCURRENTLY nb_revenue_daily;
REFRESH MATERIALIZED VIEW CONCURRENTLY nb_refunds_daily;
```

Unique indexes required by CONCURRENTLY are present. Fallback to non-concurrent only if a unique-index invariant is broken (rare — alert if it ever happens).

## 4. API surface

All endpoints: `authMiddleware` + `Cache-Control: no-store`.

### 4.1 Revenue summary

```
GET /api/admin/reports/revenue
  ?from=<JST calendar date YYYY-MM-DD>
  &to=<JST calendar date YYYY-MM-DD, exclusive>
  &granularity=day|week|month
  &category=<course-1|course-2|course-bundle|certification|couples|lumina-lifetime|single-session|all>
  &compare=<prior-period|yoy|none>
  &live=<bool>      default true if range includes today JST; false otherwise
```

Response:
```json
{
  "buckets": [
    { "bucket": "2026-04-01", "gross": 25000, "refunds": 0, "net": 25000, "payments": 5, "uniquePayers": 4 }
  ],
  "comparison": [...] | null,
  "totals": { "gross": ..., "refunds": ..., "net": ..., "payments": ..., "uniquePayers": ... },
  "comparisonTotals": {...} | null,
  "meta": {
    "currency": "jpy",
    "lastRefreshedAt": "2026-04-21T03:00:00+09:00",
    "source": "matview" | "live",
    "nonJpyExcluded": { "count": 0, "breakdown": [] }
  }
}
```

Server flow:
1. Validate `from`/`to` as JST dates; compute UTC half-open bounds.
2. Whitelist `granularity` → SQL fragment.
3. Whitelist `category` → product filter list (from §4.4 map).
4. If `live` OR range-includes-today: query `nb_payments` + `nb_refunds` directly with the same WHERE filters. Otherwise: read matviews.
5. If `compare=prior-period`: compute prior window of equal length.

### 4.2 Revenue by product

```
GET /api/admin/reports/revenue-by-product?from=...&to=...
```

Response: rows per product category (§4.4 mapping applied):
```json
{
  "rows": [
    { "category": "course-1", "gross": ..., "refunds": ..., "net": ..., "payments": ..., "uniquePayers": ... },
    ...
  ],
  "totals": {...},
  "meta": {...}
}
```

### 4.3 Completion cohort

```
GET /api/admin/reports/completion?course=<course-id>
```

Response:
```json
{
  "courseId": "course-1",
  "totalLessons": 12,
  "totalLessonsSource": "current-catalog",
  "buckets": [
    { "range": "0-24%",  "studentCount": 15 },
    { "range": "25-49%", "studentCount": 8 },
    { "range": "50-74%", "studentCount": 12 },
    { "range": "75-99%", "studentCount": 5 },
    { "range": "100%",   "studentCount": 3 }
  ],
  "studentTotal": 43,
  "averageCompletion": 34
}
```

Query shape (refunded students excluded):
```sql
WITH owned AS (
  SELECT ca.access_token, ca.course_id, ca.customer_id
  FROM nb_course_access ca
  WHERE ca.course_id = $1
    AND (ca.expires_at IS NULL OR ca.expires_at > NOW())
    AND NOT EXISTS (
      SELECT 1 FROM nb_refunds r
      JOIN nb_payments p ON r.payment_id = p.id
      WHERE r.status='succeeded'
        AND p.customer_id = ca.customer_id
        AND p.product_name = ca.course_id
    )
),
progress AS (
  SELECT o.access_token,
         COUNT(*) FILTER (WHERE lp.completed) AS completed_count
  FROM owned o
  LEFT JOIN nb_lesson_progress lp
    ON lp.access_token = o.access_token AND lp.course_id = o.course_id
  GROUP BY o.access_token
)
SELECT completed_count FROM progress;
```

Node layer: divide `completed_count / getCourseLessonCount(course)` and bucket into 5 ranges.

### 4.4 Completion bucket drill-down (new per Codex)

```
GET /api/admin/reports/completion/students?course=<course-id>&bucket=<0-24|25-49|50-74|75-99|100>
```

Response: list of students in that bucket with `customerId`, `email`, `name`, `completionPct`, `lastWatchedAt`.

### 4.5 Per-lesson drop-off

```
GET /api/admin/reports/dropoff?course=<course-id>
```

Response:
```json
{
  "courseId": "course-1",
  "lessons": [
    {
      "lessonId": "lesson-1",
      "order": 1,
      "startedCount": 43,
      "completedCount": 41,
      "nextStartedCount": 40,
      "dropoffCount": 1,
      "dropoffRate": 0.02
    }
  ]
}
```

`dropoffRate = 1 - (nextStartedCount / completedCount)`. Lesson order from `course-catalog.js` `lessons[]` array (filtered for playable types). ID gaps preserved.

### 4.6 Payments drill-down

```
GET /api/admin/reports/payments?date=<JST YYYY-MM-DD>&product=<category-or-all>
```

Admin-only. Response includes customer PII; explicit `Cache-Control: no-store`.

### 4.7 Non-JPY diagnostic

```
GET /api/admin/reports/non-jpy
```

Small endpoint returning current `nb_non_jpy_payments` view.

### 4.8 CSV exports (4 total)

- `/api/admin/reports/revenue/export`
- `/api/admin/reports/revenue-by-product/export`
- `/api/admin/reports/completion/export?course=...`
- `/api/admin/reports/dropoff/export?course=...`

**All use `streamRowsWithSqlCursor({ req, res, ... })` from Phase 2.**

**All apply CSV formula-injection guard** — prefix cells starting with `=`, `+`, `-`, `@`, `\t`, `\r` with `'`.

## 5. Product category mapping (§4.4)

Implemented as JS module `reporting-lib.js`:

```js
const PRODUCT_CATEGORY = {
  'course-1': 'course-1',
  'course-2': 'course-2',
  'course-2-upgrade': 'course-2',
  'course-2-flash':   'course-2',
  'course-bundle':    'course-bundle',
  'certification-monthly':  'certification',
  'certification-lumpsum':  'certification',
  'couples-monthly':  'couples',
  'couples-lumpsum':  'couples',
  'single-session':   'single-session',
  'coaching':         'coaching',
  'lumina-lifetime':  'lumina-lifetime',
  'lumina-monthly':   'lumina-lifetime',   // aliased per Phase 1 deploy-gap
  'lumina-annual':    'lumina-lifetime'
};

function categorize(productName) {
  return PRODUCT_CATEGORY[productName] || 'other';
}
```

For `revenue-by-product`, endpoint applies `categorize()` in SQL via a CASE expression. For drill-down payments, the raw `product_name` is shown.

**Bundle allocation:** for `revenue-by-product` alone, each `course-bundle` payment splits 50/50 between `course-1` and `course-2` categories. For `/api/admin/reports/revenue`, `course-bundle` stays as its own category.

## 6. Webhook handler — refund events

In `stripe-routes.js`, add TWO new cases (NOT `charge.refunded`):

```js
case 'refund.created':
case 'refund.updated': {
  const refund = event.data.object;
  try {
    const pi = refund.payment_intent;
    const ch = refund.charge;
    // Link payment by PI first, then by charge
    let paymentRow = null;
    if (pi) {
      const r = await pool.query(
        `SELECT id, customer_id, product_name FROM nb_payments WHERE stripe_payment_intent_id=$1`, [pi]);
      paymentRow = r.rows[0] || null;
    }
    if (!paymentRow && ch) {
      const r = await pool.query(
        `SELECT id, customer_id, product_name FROM nb_payments WHERE stripe_charge_id=$1`, [ch]);
      paymentRow = r.rows[0] || null;
    }

    await pool.query(
      `INSERT INTO nb_refunds (
         customer_id, payment_id, stripe_refund_id, stripe_charge_id, stripe_payment_intent_id,
         amount, currency, reason, status, product_name, metadata, stripe_created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,to_timestamp($12))
       ON CONFLICT (stripe_refund_id) DO UPDATE SET
         customer_id = COALESCE(EXCLUDED.customer_id, nb_refunds.customer_id),
         payment_id  = COALESCE(EXCLUDED.payment_id,  nb_refunds.payment_id),
         stripe_charge_id = COALESCE(EXCLUDED.stripe_charge_id, nb_refunds.stripe_charge_id),
         stripe_payment_intent_id = COALESCE(EXCLUDED.stripe_payment_intent_id, nb_refunds.stripe_payment_intent_id),
         amount = EXCLUDED.amount,
         currency = EXCLUDED.currency,
         reason = COALESCE(EXCLUDED.reason, nb_refunds.reason),
         status = EXCLUDED.status,
         product_name = COALESCE(EXCLUDED.product_name, nb_refunds.product_name),
         metadata = COALESCE(nb_refunds.metadata,'{}'::jsonb) || EXCLUDED.metadata,
         stripe_created_at = EXCLUDED.stripe_created_at`,
      [
        paymentRow?.customer_id || null,
        paymentRow?.id || null,
        refund.id, ch || null, pi || null,
        refund.amount, refund.currency, refund.reason || null,
        refund.status, paymentRow?.product_name || null,
        JSON.stringify(refund.metadata || {}),
        refund.created
      ]
    );

    if (!paymentRow) {
      logger.warn({ refundId: refund.id, pi, ch }, 'Refund recorded as orphan; will reconcile when payment arrives');
    }
  } catch (e) {
    logger.error({ err: e, eventId: event.id }, 'refund.created handler failed');
    recordOperationalAlert({...}).catch(()=>{});
    await pool.query(`DELETE FROM nb_processed_webhooks WHERE event_id=$1`, [event.id]);
    return res.status(500).json({ error: 'Refund record failed' });
  }
  break;
}
```

Same Phase 1 lifetime pattern: delete idempotency marker + 5xx on DB failure so Stripe retries.

**Reconciliation job** — nightly cron script `scripts/reconcile-orphan-refunds.js` scans `nb_refunds WHERE payment_id IS NULL`, tries to match by `stripe_charge_id` or `stripe_payment_intent_id`, fills in `customer_id + payment_id + product_name` when a match exists.

## 7. Backfill

`scripts/backfill-refunds.js`:
- `--dry-run` default; `--live` required to write.
- Calls `stripe.refunds.list({created: {gte: <cutoff>}, expand: ['data.charge']})` paginating with `starting_after`.
- Uses the same upsert SQL as the webhook handler so reruns are safe.
- Prints count of new + updated + skipped.

## 8. Admin UI — `admin/reports.html`

Top bar: JST date range picker (7d / 30d / QTD / YTD / custom), granularity selector (day/week/month), compare toggle, category multi-select.

Panels (vertical):
1. **KPIs row** — net revenue (with Δ), payments (Δ), unique payers (Δ), refund rate (Δ). Numbers only.
2. **Revenue over time** — Chart.js line chart; one series per selected category; prior-period dashed overlay.
3. **Revenue by category** — Chart.js stacked bar + table. Columns: category, gross, refunds, net, payments, % of net.
4. **Completion per course** — horizontal stacked bar of 5 buckets per course.
5. **Per-lesson drop-off** — collapsible per course, Chart.js line chart showing startedCount vs completedCount vs nextStartedCount.

Drill-downs:
- Revenue chart point click → modal listing payments for that day+category.
- Completion bucket click → modal listing students via new `/completion/students` endpoint; link into `/admin/customers.html#/c/:id`.

All data fetched via JSON APIs. No inline JSON in HTML. Chart.js vendored at `public/vendor/chart.min.js`.

## 9. Cron

`scripts/install-reporting-cron.sh` (new):

```bash
#!/bin/bash
set -euo pipefail
install -Dm644 /dev/stdin /etc/cron.d/namibarden-reporting <<'CRON'
TZ=Asia/Tokyo
0 3 * * * root flock -n /tmp/nb-reporting-refresh.lock docker exec namibarden node scripts/refresh-reporting.js >> /var/log/namibarden/reporting-refresh.log 2>&1
30 3 * * * root flock -n /tmp/nb-orphan-refunds.lock docker exec namibarden node scripts/reconcile-orphan-refunds.js --live >> /var/log/namibarden/orphan-refunds.log 2>&1
CRON
echo "Installed /etc/cron.d/namibarden-reporting"
```

`scripts/refresh-reporting.js` — runs both `REFRESH MATERIALIZED VIEW CONCURRENTLY` statements and logs timing.

## 10. Files to change

| File | Change |
|---|---|
| `schema.sql` | Append DDL from §3 |
| `migrations/004_reporting.sql` (new) | Idempotent migration |
| `stripe-routes.js` | Add `refund.created` + `refund.updated` webhook cases |
| `admin-routes.js` | 8 new endpoints per §4; all use existing `streamRowsWithSqlCursor` for CSV |
| `reporting-lib.js` (new) | `categorize()` map, bucket math, prior-period helper, JST date utilities, CSV formula-escape helper |
| `scripts/refresh-reporting.js` (new) | Nightly REFRESH CONCURRENTLY caller |
| `scripts/reconcile-orphan-refunds.js` (new) | Nightly orphan refund linker |
| `scripts/backfill-refunds.js` (new) | One-shot historical backfill |
| `scripts/install-reporting-cron.sh` (new) | Host cron install script |
| `admin/reports.html` (new) | Dashboard |
| `admin/dashboard.html` | Add Reports tile |
| `public/vendor/chart.min.js` (new, vendored) | Chart.js pinned version |
| `Dockerfile` | Append `reporting-lib.js` to COPY (scripts/ and migrations/ already covered) |

## 11. Test plan (addresses Codex's missing-coverage items)

### Unit / local
1. Matview unique index holds: duplicate same-day same-product payments aggregate (don't multi-row).
2. Non-JPY payment in `nb_payments` → excluded from `nb_revenue_daily` matview + appears in `nb_non_jpy_payments` view.
3. `refund.created` for a known PI → `nb_refunds` row with `payment_id` set, `stripe_created_at` from Stripe.
4. `refund.created` for unknown PI → orphan (`payment_id=NULL`) row; reconciliation script later fills it.
5. `refund.updated` for same refund ID → UPSERT updates status/amount.
6. Two partial refunds on same payment → `SUM(amount)` in refund matview counts both; payment matview gross unchanged.
7. Refund on April 20 for April 1 payment: matview shows April 20 refund row, April 1 gross row untouched.
8. JST boundary: payment at 23:59 UTC April 19 (= 08:59 JST April 20) → bucketed on April 20.
9. CSV formula-injection: customer name `=1+2` in export → renders as `'=1+2` (prefixed).
10. CSV client disconnect mid-stream → cursor rolled back, client released, server log shows abort.
11. Completion cohort with a refunded student: refunded student excluded from denominator.
12. Drop-off on course-2 with 23 lessons: array order preserved, non-sequential IDs OK.
13. Revenue-by-product: `course-bundle` payment of ¥14,800 shows as ¥7,400 under course-1 and ¥7,400 under course-2 in breakdown; appears as its own ¥14,800 row in `/revenue` default category.

### E2E
14. `/admin/reports.html` renders; default 30d range; KPIs match DB direct SQL.
15. Completion panel click → bucket drill-down → link to customer detail works.
16. MRR panel not rendered (confirmed no `nb_subscriptions.status='active'` rows).
17. Prior-period comparison with 0 prior-period revenue shows "—" delta, not NaN.

## 12. Deploy sequence

1. Backup DB.
2. Apply `migrations/004_reporting.sql`.
3. Deploy NamiBarden container with new routes + vendored Chart.js.
4. Run `scripts/backfill-refunds.js --dry-run` → review → `--live` (safe to rerun).
5. Run `scripts/refresh-reporting.js` once manually to populate matviews.
6. Run `scripts/install-reporting-cron.sh` on host to register cron.
7. Smoke-test `/api/admin/reports/revenue` → expect `source: "matview"` for historical day, `live` for today.
8. E2E per §11.

## 13. Follow-ups (deferred)

- Historical lesson-count snapshot for completion accuracy across catalog changes (Phase 5).
- Stripe `payout.*` webhooks for Nami's cash-flow view (separate phase).
- Custom dashboards / saved views.
- Funnel analytics (view → cart → purchase).
