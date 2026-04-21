# Phase 4 — Revenue reporting + course completion dashboard

**Status:** draft pending consensus
**Dependencies:** Phases 1–3 shipped. Phase 2 especially (customer detail + matrix share queries).

## 1. Goals

Gil's asks #5 and #6 from the original brief:

- **Monthly revenue reporting, click-through (not WhatsApp)** — dashboard showing income per course, Lumina lifetime sales, refunds, net revenue, with drill-down from month → day → individual purchase.
- **Completion % like Udemy** — per-course completion distribution, per-student progress, drop-off by lesson.

Must-haves:

- Per-course revenue table (gross, refunds, net) for day/week/month/YTD.
- MRR-equivalent for Lumina legacy subs (if any remain after Phase 1 migration).
- One-time purchase count + revenue per course.
- Compare to prior period (MoM, YoY).
- Course completion cohort view (how many students are at 0-25%, 25-50%, 50-75%, 75-100%, 100%).
- Per-lesson drop-off (of students who started lesson N, what % made it to lesson N+1).
- CSV export per table.

Out of scope for Phase 4: refund reason coding, customer LTV models, funnel analytics beyond completion, A/B-test reporting.

## 2. Product decisions (locked)

| Item | Decision |
|---|---|
| Currency | JPY only (matches Phase 1 JPY-only decision). Mixed-currency: show JPY total + side note "X non-JPY payments not included". |
| Revenue definition | `sum(nb_payments.amount) WHERE status='succeeded' AND currency='jpy' GROUP BY product_name, date_trunc(…)`. Lumina lifetime revenue sits under `product_name='lumina-lifetime'`; legacy 'lumina-monthly'/'lumina-annual' aggregate separately (small, historical). |
| Refund definition | Stripe refund events. We don't currently track refunds in DB — **Phase 4 adds `nb_refunds` table** + webhook handler for `charge.refunded`. |
| Net revenue | Gross − refunds. |
| Time zone | Asia/Tokyo for all date aggregations. |
| Completion denominator | Catalog total playable lessons per course (same helper from Phase 2 `getCourseLessonCount`). |
| "Active student" | Customer who watched any lesson within the last 30d (via `nb_lesson_progress.last_watched_at`). |
| Charts | Server-rendered JSON → client-rendered with Chart.js (CDN, no new deps in Docker image). |
| Granularity | Day / week / month / quarter / YTD. Default: last 30 days at day granularity. |
| Comparison | Prior-period overlay for every chart. Toggle on/off. |
| Drill-down | Click a day → see list of individual payments that day. Click a course cell → see list of students + their completion %. |

## 3. Schema changes

```sql
-- migrations/004_reporting.sql

-- 1) Refunds table (new)
CREATE TABLE IF NOT EXISTS nb_refunds (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER REFERENCES nb_customers(id) ON DELETE SET NULL,
  payment_id INTEGER REFERENCES nb_payments(id) ON DELETE SET NULL,
  stripe_refund_id VARCHAR(255) UNIQUE NOT NULL,
  stripe_charge_id VARCHAR(255),
  stripe_payment_intent_id VARCHAR(255),
  amount INTEGER NOT NULL,     -- in currency minor units (JPY has no decimals)
  currency VARCHAR(10) NOT NULL,
  reason VARCHAR(100),          -- 'requested_by_customer' | 'duplicate' | 'fraudulent' | null
  status VARCHAR(50) NOT NULL,  -- 'succeeded' | 'pending' | 'failed'
  product_name VARCHAR(255),     -- copied from the linked payment for fast rollup
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refunds_customer ON nb_refunds(customer_id);
CREATE INDEX IF NOT EXISTS idx_refunds_payment ON nb_refunds(payment_id);
CREATE INDEX IF NOT EXISTS idx_refunds_created_at ON nb_refunds(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_refunds_product ON nb_refunds(product_name);

-- 2) Daily revenue rollup (materialized for speed; refreshed nightly)
CREATE MATERIALIZED VIEW IF NOT EXISTS nb_revenue_daily AS
SELECT
  date_trunc('day', (p.created_at AT TIME ZONE 'Asia/Tokyo')) AT TIME ZONE 'Asia/Tokyo' AS day,
  p.product_name,
  p.currency,
  SUM(p.amount) FILTER (WHERE p.status='succeeded') AS gross,
  SUM(r.amount) FILTER (WHERE r.status='succeeded') AS refunds,
  COUNT(*) FILTER (WHERE p.status='succeeded') AS payment_count,
  COUNT(DISTINCT p.customer_id) FILTER (WHERE p.status='succeeded') AS unique_payers
FROM nb_payments p
LEFT JOIN nb_refunds r ON r.payment_id = p.id
GROUP BY 1, 2, 3;

CREATE UNIQUE INDEX IF NOT EXISTS idx_revenue_daily_unique ON nb_revenue_daily(day, product_name, currency);
CREATE INDEX IF NOT EXISTS idx_revenue_daily_day ON nb_revenue_daily(day DESC);

-- Refresh function (called by cron via scripts/refresh-reporting.js)
-- REFRESH MATERIALIZED VIEW CONCURRENTLY nb_revenue_daily;
```

### Why materialized view?

For low-thousands of payments, a regular query is fine. But Gil wants charts with date-range comparisons that re-aggregate on every filter change. Materializing keeps the dashboard instant. Refreshed nightly via cron (new `scripts/refresh-reporting.js`). Live data only lags <24h, acceptable.

Fallback: endpoints also support `?live=true` to bypass the matview and compute on demand (for day-of numbers).

## 4. API surface

### Revenue summary

```
GET /api/admin/reports/revenue
  ?from=2026-03-01&to=2026-04-20
  &granularity=day|week|month
  &product=<course-1|course-2|lumina-lifetime|all>
  &compare=<prior-period|yoy|none>
  &live=<bool>

Response:
{
  buckets: [
    { bucket: '2026-04-01', gross: 25000, refunds: 0, net: 25000, payments: 5, uniquePayers: 4 },
    ...
  ],
  comparison: [
    { bucket: '2026-03-01', gross: 18000, ... },
    ...
  ] | null,
  totals: {
    gross: ..., refunds: ..., net: ..., payments: ..., uniquePayers: ...
  },
  comparisonTotals: {...} | null,
  meta: { currency: 'jpy', nonJpyCount: 0 }
}
```

### Revenue by product (breakdown for the same window)

```
GET /api/admin/reports/revenue-by-product?from=...&to=...
Response:
{
  rows: [
    { productName: 'course-1', gross: ..., refunds: ..., net: ..., payments: ..., uniquePayers: ... },
    { productName: 'course-2', ... },
    { productName: 'lumina-lifetime', ... },
    { productName: 'course-bundle', ... },
    ...
  ],
  totals: {...}
}
```

### Course completion cohort

```
GET /api/admin/reports/completion?course=<course-id>
Response:
{
  courseId: 'course-1',
  totalLessons: 12,
  buckets: [
    { range: '0-24%', studentCount: 15 },
    { range: '25-49%', studentCount: 8 },
    { range: '50-74%', studentCount: 12 },
    { range: '75-99%', studentCount: 5 },
    { range: '100%', studentCount: 3 }
  ],
  studentTotal: 43,
  averageCompletion: 34  // percent
}
```

Computed from `nb_course_access` (students owning the course) + `nb_lesson_progress` (their completed count) + `getCourseLessonCount(courseId)` (denominator).

### Per-lesson drop-off

```
GET /api/admin/reports/dropoff?course=<course-id>
Response:
{
  courseId: 'course-1',
  lessons: [
    { lessonId: 'lesson-1', order: 1, startedCount: 43, completedCount: 41, dropoffToNext: 0 },
    { lessonId: 'lesson-2', order: 2, startedCount: 41, completedCount: 38, dropoffToNext: 3 },
    ...
  ]
}
```

### Drill-down: payments on a day

```
GET /api/admin/reports/payments?date=2026-04-20&product=course-1
Response:
{
  payments: [
    { id, customer: {id, email, name}, amount, status, stripePaymentIntentId, stripeDashboardUrl, refundedAmount, createdAt }
  ]
}
```

### CSV exports

```
GET /api/admin/reports/revenue/export?<same filters>
GET /api/admin/reports/revenue-by-product/export?<...>
GET /api/admin/reports/completion/export?course=...
GET /api/admin/reports/dropoff/export?course=...
```

All stream via `pg.Cursor` (same pattern as Phase 2).

## 5. Webhook handler — `charge.refunded`

In `stripe-routes.js`, add new case:

```js
case 'charge.refunded': {
  const charge = event.data.object;
  const pi = charge.payment_intent;
  // Find linked nb_payments row by PI
  const { rows } = await pool.query(
    `SELECT id, customer_id, product_name FROM nb_payments WHERE stripe_payment_intent_id=$1`, [pi]
  );
  if (rows[0]) {
    for (const refund of charge.refunds?.data || []) {
      await pool.query(
        `INSERT INTO nb_refunds (customer_id, payment_id, stripe_refund_id, stripe_charge_id,
           stripe_payment_intent_id, amount, currency, reason, status, product_name, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (stripe_refund_id) DO UPDATE SET
           status=EXCLUDED.status, metadata=EXCLUDED.metadata, amount=EXCLUDED.amount`,
        [rows[0].customer_id, rows[0].id, refund.id, charge.id, pi, refund.amount, refund.currency,
         refund.reason, refund.status, rows[0].product_name, JSON.stringify(refund.metadata || {})]
      );
    }
  } else {
    // payment we didn't record — log alert, keep going
    logger.warn({ pi, chargeId: charge.id }, 'Refund for unknown payment_intent');
  }
  break;
}
```

**Backfill step** for existing refunds (if any exist in Stripe that we missed): new one-shot `scripts/backfill-refunds.js` that calls `stripe.refunds.list({created: {...}})` and INSERTs rows. Safe to re-run (ON CONFLICT). Run once during deploy.

## 6. Admin UI

### `admin/reports.html` (new)

Top bar: date range picker (presets: 7d / 30d / QTD / YTD / custom), granularity selector, comparison toggle.

Panels:

1. **Revenue over time** — line chart, one line per selected product (default: all). Prior-period overlay dashed.
2. **Revenue by product** — stacked bar chart + table below. Columns: product, gross, refunds, net, payments, % of total.
3. **KPIs** — 4 big numbers: Net revenue (with Δ vs prior), Payments count (Δ), Unique payers (Δ), Refund rate (Δ).
4. **Completion by course** — horizontal stacked bar per course showing distribution across 5 cohort buckets.
5. **Per-lesson drop-off** (collapsible per course) — line chart of started vs completed per lesson index.

Click-throughs:
- Revenue chart point → drill-down payments list for that day+product.
- Completion bucket → list of students in that bucket (links to customer detail from Phase 2).

All charts use Chart.js loaded from a pinned CDN (subresource integrity hash in the script tag). No new npm deps.

### Dashboard tile

`admin/dashboard.html` gets a new "Reports" tile pointing to `/admin/reports.html`.

## 7. Files to change

| File | Change |
|---|---|
| `schema.sql` | Add `nb_refunds` + materialized view |
| `migrations/004_reporting.sql` (new) | DDL |
| `stripe-routes.js` | New `charge.refunded` webhook case |
| `admin-routes.js` | 7 new `/api/admin/reports/*` endpoints |
| `reporting-lib.js` (new) | Shared query helpers (bucket math, prior-period, cohort classifier) |
| `scripts/refresh-reporting.js` (new) | Cron-friendly REFRESH MATERIALIZED VIEW CONCURRENTLY caller |
| `scripts/backfill-refunds.js` (new) | One-shot Stripe → DB refund backfill |
| `admin/reports.html` (new) | Dashboard page |
| `admin/dashboard.html` | Add Reports nav tile |
| `Dockerfile` | `reporting-lib.js` added to COPY list |

Cron: add `0 3 * * * docker exec namibarden node scripts/refresh-reporting.js` to the host's crontab (separate from code deploy).

## 8. Test plan

### Unit / local
1. `REFRESH MATERIALIZED VIEW CONCURRENTLY nb_revenue_daily` against test data → unique index enforces no duplicate (day, product, currency) rows.
2. Revenue summary with `granularity=month` bundles correctly across DST-less JST (safe).
3. Completion cohort: 43 students across 5 buckets, averages match.
4. Drop-off: 43 students started lesson-1, 41 completed → `startedCount=43, completedCount=41`.
5. `charge.refunded` webhook inserts refund, ON CONFLICT on rerun → no-op.
6. Backfill script: populate 3 historical refunds via Stripe test API, run backfill → rows appear.

### E2E
7. `/admin/reports.html` renders with default 30d range; revenue chart displays; comparison overlay works; KPI deltas display.
8. Completion panel shows buckets summing to studentTotal.
9. Drill-down: click April 20 point → list shows the payment(s) from that day.
10. CSV export for each panel downloads and matches on-screen rows.

## 9. Risks

- **Materialized view refresh lock** — `REFRESH MATERIALIZED VIEW CONCURRENTLY` requires a unique index (have it). If concurrent is not possible, falls back to an exclusive lock briefly.
- **Historical refund completeness** — backfill script is "best effort". If Stripe pagination truncates, miss some refunds. Mitigation: run iteratively with `starting_after`.
- **Chart.js CDN** — if CDN is blocked (corporate networks), chart won't render. Mitigation: ship Chart.js in `public/vendor/` (small file). Decision needed.
- **Time-zone boundary** — aggregating at `Asia/Tokyo` means "today" in JST differs from UTC. Document on the page.
- **MRR relevance** — after Phase 1 migration, Lumina MRR is ~0. MRR becomes a non-metric; decision: show "MRR (legacy)" only if >0.

## 10. Open questions for consensus

1. Materialized view refresh frequency — nightly is probably fine, but day-of revenue lags 24h. Default to nightly, `?live=true` bypass for day-of accuracy?
2. Chart.js CDN vs vendored — vendor it (safer, no external dep)?
3. Refund reporting for past refunds we never recorded — automatic backfill on first deploy, or manual trigger?
4. Completion cohort bucket boundaries — 0-24, 25-49, 50-74, 75-99, 100 is Udemy-ish. Ok?
5. Drill-down scope — spec currently shows day + product; should it support hour-level drill for Stripe-test-mode debugging or is day-level enough?
