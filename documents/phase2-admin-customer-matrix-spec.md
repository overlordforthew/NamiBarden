# Phase 2 — Admin customer-detail + students × courses matrix

**Status:** post-consensus (Opus + GPT-5.4 xhigh); blockers + meds resolved
**Owner:** Gil (product), Claude (spec), Codex (implementation), Claude (review + deploy)
**Dependencies:** Phase 1 shipped (lifetime entitlement model is live)

## 1. Goals

Bring the admin's customer view up to what Teachable/Udemy/Kajabi offer:

- **Customer list** — paginated table of paying customers (≠ newsletter subscribers) with columns: email, name, signup date, last login, total paid, course count, Lumina status, tags.
- **Customer detail** — one page showing everything about a single customer: purchases, per-course progress %, Q&A threads (with link to open thread), Lumina entitlement, last login, free-text notes, tags.
- **Students × courses matrix** — Udemy-style grid: rows = customers, columns = courses + Lumina, cells = ownership checkmark + progress %.
- **Operational** — CSV export for both the list and the matrix. Searchable / filterable like the existing subscribers page.
- **Foundation for Phase 4** — every reporting query later will start from the same `/api/admin/customers/:id` payload; this is the data layer.

Out of scope: cohort analytics, MRR reports (Phase 4), chat UI changes (Phase 3).

## 2. Product decisions (locked — please challenge in consensus)

| Item | Decision |
|---|---|
| Customer list = who? | Everyone in `nb_customers` (paying + magic-link-only accounts). Not `nb_subscribers` (newsletter). |
| Dual-identity rows? | If an email exists in both `nb_customers` and `nb_subscribers`, show once in the customer list, annotate "also on newsletter" in detail. |
| Matrix cells | Checkmark if owned, empty otherwise. Hover / secondary column shows progress % (completed lessons / **catalog total playable lessons** — NOT `nb_lesson_progress.count`). Refunded / revoked Lumina shows as distinct "refunded" state, not a plain empty cell. |
| Lumina column in matrix | Yes. Values: ✓ lifetime / ⏳ legacy active / ✗ never / — refunded. |
| "Last login" | Only real sign-in events: `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/reset-password`, `GET /api/auth/magic-link` (4 paths — confirmed from `customer-auth.js:67,127,242,336`). **NOT** JWT refresh, **NOT** `/api/auth/check`. Activity-over-time belongs to `last_course_activity_at` (new view column). |
| Lumina admin-status enum | Normalize raw entitlement status → one of: `lifetime`, `active`, `trialing`, `grace`, `expired`, `refunded`, `revoked`, `none`. Filter + UI use this enum, not raw DB values. |
| Stripe dashboard links | Inspect `stripe_payment_intent_id` prefix (`pi_live_` vs `pi_test_`) → link to `/payments/{id}` or `/test/payments/{id}`. Never hardcode live path. |
| Access-token exposure | Admin detail API **MUST NOT** return raw `nb_course_access.access_token`. Any "Open as student" link must route through a new admin-only proxy endpoint that mints a short-lived signed redirect — never leaking the raw bearer. CSV exports must never include tokens. |
| Notes | Free-text single field on `nb_customers.notes`. Not a separate table. Audit trail deferred — if Gil needs history later we move to `nb_customer_notes`. |
| Tags | Reuse the existing subscriber tag pattern: `TEXT[]` array on `nb_customers`, filterable. |
| Soft delete | Out of scope — no archive/delete. |
| Admin permissions | Same shared admin login as today. Split accounts deferred. |

## 3. Data model

### New columns on `nb_customers`

```sql
ALTER TABLE nb_customers
  ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_customers_last_login_at ON nb_customers(last_login_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_customers_created_at ON nb_customers(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_customers_tags ON nb_customers USING GIN (tags);
```

Migration: `migrations/002_admin_customer_detail.sql`.

### Canonical "customer summary" view

A SQL view to keep the aggregation logic in one place, reusable from list + detail endpoints:

```sql
CREATE OR REPLACE VIEW nb_customer_summary AS
SELECT
  c.id,
  c.email,
  c.name,
  c.created_at,
  c.updated_at,                   -- for stale-edit detection
  c.last_login_at,
  c.notes,
  c.tags,
  c.stripe_customer_id,
  -- purchase rollup (JPY-only total; non-JPY payments excluded by design)
  COALESCE(p.total_paid_jpy, 0) AS total_paid_jpy,
  COALESCE(p.payment_count, 0) AS payment_count,
  p.last_payment_at,
  -- course rollup — COALESCE guards against array_agg returning NULL
  COALESCE(ca.course_count, 0) AS course_count,
  COALESCE(ca.course_ids, ARRAY[]::varchar[]) AS course_ids,
  -- lumina rollup (drop LIMIT 1 — UNIQUE(customer_id, app_slug) already guarantees 0/1)
  l.lumina_status,
  l.lumina_plan_code,
  l.lumina_granted_at,
  -- q&a rollup — covers threads keyed by customer_id OR access_token on owned courses
  COALESCE(q.thread_count, 0) AS qa_thread_count,
  COALESCE(q.unread_for_admin_count, 0) AS qa_unread_for_admin_count,
  -- activity timestamps
  COALESCE(GREATEST(c.last_login_at, act.last_activity_at), c.last_login_at, act.last_activity_at) AS last_activity_at,
  act.last_activity_at AS last_course_activity_at
FROM nb_customers c
LEFT JOIN LATERAL (
  SELECT SUM(CASE WHEN currency='jpy' THEN amount ELSE 0 END) AS total_paid_jpy,
         COUNT(*) AS payment_count,
         MAX(created_at) AS last_payment_at
  FROM nb_payments WHERE customer_id = c.id AND status='succeeded'
) p ON TRUE
LEFT JOIN LATERAL (
  SELECT COUNT(DISTINCT course_id) AS course_count,
         array_agg(DISTINCT course_id ORDER BY course_id) AS course_ids
  FROM nb_course_access WHERE customer_id = c.id
) ca ON TRUE
LEFT JOIN LATERAL (
  SELECT status AS lumina_status, plan_code AS lumina_plan_code, lifetime_granted_at AS lumina_granted_at
  FROM nb_app_entitlements WHERE customer_id = c.id AND app_slug='lumina'
) l ON TRUE
LEFT JOIN LATERAL (
  -- threads keyed either by customer_id OR access_token on one of their owned courses
  SELECT COUNT(*) AS thread_count,
         COUNT(*) FILTER (WHERE unread_for_admin) AS unread_for_admin_count
  FROM nb_qa_threads t
  WHERE t.customer_id = c.id
     OR t.access_token IN (SELECT access_token FROM nb_course_access WHERE customer_id = c.id)
) q ON TRUE
LEFT JOIN LATERAL (
  SELECT MAX(lp.last_watched_at) AS last_activity_at
  FROM nb_lesson_progress lp
  WHERE lp.customer_id = c.id
) act ON TRUE;
```

### Per-customer course progress (CORRECT DENOMINATOR)

**Critical:** Completion % denominator is `course-catalog.js` total playable lessons, NOT the count of `nb_lesson_progress` rows. Otherwise 1/1 shows as 100% for a student who's only touched one lesson of twelve.

SQL returns `started_count` (touched) and `completed_count`. Node joins against catalog:

```sql
SELECT
  ca.course_id,
  lp.started_count,
  lp.completed_count,
  lp.last_watched_at
FROM nb_course_access ca
LEFT JOIN LATERAL (
  SELECT COUNT(*) AS started_count,
         COUNT(*) FILTER (WHERE completed) AS completed_count,
         MAX(last_watched_at) AS last_watched_at
  FROM nb_lesson_progress
  WHERE access_token = ca.access_token AND course_id = ca.course_id
) lp ON TRUE
WHERE ca.customer_id = $1;
```

Node code layer:

```js
const { getCourseLessonCount } = require('./course-catalog');

rows.forEach(row => {
  row.totalLessons = getCourseLessonCount(row.course_id);  // catalog-backed
  row.completionPct = row.totalLessons > 0
    ? Math.round(100 * row.completed_count / row.totalLessons)
    : 0;
});
```

`getCourseLessonCount(courseId)` exports the count of `type ∈ ['video', undefined]` lessons — excludes 'pdf' and 'ending'. For course-1: 12 playable. For course-2: 23 playable. Export must be added to `course-catalog.js` if not present.

**Regression test required:** 1 completed / 12 total = 8%, NOT 100%.

## 4. API surface

All endpoints under existing `authMiddleware` (JWT cookie + role='admin').

### Customer list

```
GET /api/admin/customers
  ?page=1&limit=50
  &search=<free text on email/name>
  &tag=<tag>
  &lumina=<lifetime|active|trialing|grace|expired|refunded|revoked|none>
  &course=<course-id>  (owns this course)
  &hasActivity=<30d|90d|never>  (based on last_activity_at from view)
  &sort=<created_at|last_login_at|total_paid_jpy|course_count|last_activity_at>&dir=<asc|desc>

Response:
{
  customers: [
    {
      id, email, name,
      createdAt, updatedAt, lastLoginAt, lastActivityAt,
      totalPaidJpy, paymentCount,
      courseCount, courseIds,
      luminaStatus, luminaPlanCode, luminaGrantedAt,    // luminaStatus is normalized enum
      qaThreadCount, qaUnreadForAdminCount,
      tags
    }
  ],
  total, page, limit
}
```

**Sort + dir are whitelisted.** Server maps `sort` to one of a fixed set of SQL fragments (`'created_at' → 'c.created_at'`, etc.); `dir` normalizes to boolean → `'ASC'|'DESC'`. Never interpolate raw query params into SQL.

**`lumina=none` SQL:** uses view's `lumina_status IS NULL` (NOT `NOT EXISTS`). Because `nb_app_entitlements.status` is `NOT NULL` and `UNIQUE(customer_id, app_slug)` guarantees 0-or-1 rows, NULL from the LEFT LATERAL cleanly means "no entitlement row".

**Lumina status normalization** (applied at API layer on read, not at DB):
- `'lifetime'` → `'lifetime'`
- `'active'` with no cancel_at → `'active'`
- `'trialing'` → `'trialing'`
- `'past_due'` within grace period → `'grace'`
- `'canceled'` + past current_period_end → `'expired'`
- `'refunded'` → `'refunded'`
- `'revoked'` → `'revoked'`
- row missing → `'none'`

Pagination + filter math copied from `admin-routes.js:124-171` (subscribers).

### Customer detail

```
GET /api/admin/customers/:id

Response:
{
  customer: {
    id, email, name, createdAt, updatedAt, lastLoginAt, lastActivityAt,
    notes, tags, stripeCustomerId
  },
  purchases: [
    {
      id, amount, currency, status, productName,
      stripePaymentIntentId, stripeInvoiceId,
      stripeDashboardUrl,    // ← server computed, based on pi_live_ vs pi_test_ prefix
      createdAt
    }
  ],
  courses: [
    {
      courseId, courseName,
      // NO accessToken — never leaked to client. Replaced by:
      openAsStudentUrl: '/api/admin/customers/:id/open-as-student?course=X',
      purchasedAt,
      completionPct, completedCount, startedCount, totalLessons,  // totalLessons from catalog
      lastWatchedAt
    }
  ],
  lumina: {
    normalizedStatus,    // enum above
    rawStatus, planCode, lifetimeGrantedAt, currentPeriodEnd, cancelAt,
    sourceProductName, metadata
  } | null,
  qaThreads: [
    { id, subject, courseId, lessonId, status, unreadForAdmin, lastMessageAt, messageCount }
  ],
  newsletter: {
    subscribed: bool, source, tags, status    // joined by LOWER(c.email)=LOWER(s.email)
  } | null
}
```

Endpoint fetches the 5 sub-rollups via `Promise.all` — not one mega-join.

### "Open as student" proxy route (new)

```
GET /api/admin/customers/:id/open-as-student?course=<course-id>
Auth: admin JWT
Behavior: looks up access_token server-side, issues a 302 redirect to /watch?token=<signed-one-time>&course=<id>
          where the signed token is a short-lived JWT (5 min TTL) validated by an existing token check.
          Raw nb_course_access.access_token is never placed into a URL accessible to the browser.
```

This means implementing a small validator on the `/watch` route that accepts either:
- The original `nb_course_access.access_token` (student's own bookmark) — existing behavior.
- A new 5-min admin-scoped token (JWT with `{kind:'admin-impersonate', customerId, courseId}`) — new behavior.

Keeps the passwordless student bearer off admin surfaces.

### Customer notes

```
PUT /api/admin/customers/:id/notes
Body: { notes: string }  // empty string allowed, null not allowed

Response: { id, notes, updatedAt }
```

No separate GET — notes come back in `/api/admin/customers/:id` already.

### Customer tags

```
PUT /api/admin/customers/:id/tags
Body: { tags: string[] }  // full replacement, not append

Response: { id, tags }
```

**Use `PUT` (full replacement verb). UI and API agree.**

Tag normalization enforced **in this endpoint** (don't rely on the existing subscriber endpoint, which has no such limits):
- Lowercase, trim, dedupe
- Max 32 tags per customer
- Max 40 chars per tag
- Reject tags matching `<|>|"|'|&|\x00-\x1f` (rendered as-is in admin UI via `textContent`)

### CSV export — customer list

```
GET /api/admin/customers/export?<same filters as list>&includeNotes=<bool, default false>
Content-Type: text/csv
Columns: email, name, created_at, last_login_at, last_activity_at,
         total_paid_jpy, payment_count,
         course_count, course_ids,
         lumina_status, lumina_plan_code, lumina_granted_at, lumina_owned,
         qa_thread_count, tags
         [, notes if includeNotes=true]
Limit 50,000 rows.
```

**Streaming, not buffering.** Use `pg.Cursor` or equivalent pagination inside the handler to page through result sets 1000 rows at a time, stringify + write each page to the response stream. Never materialize the full result in memory.

**No access tokens ever.** Not in list, not in export, never.

**Notes opt-in + audit log.** `includeNotes=true` required for note inclusion. Every export hit logs `{admin, timestamp, filters, rowCount, includeNotes}` to `nb_admin_export_audit` (new table, Phase 2.1 — not blocking).

### Students × courses matrix

```
GET /api/admin/matrix
  ?page=1&limit=100
  &search=<free text>
  &courseOwnership=<course-id>:<owned|missing>   // e.g. course-2:missing → shows customers who don't own course-2
  &includeEmptyStudents=<bool, default false>    // skip customers with 0 purchases; UI surfaces this toggle explicitly

Response:
{
  columns: [
    { courseId: 'course-1', name: '愛を引き寄せる心の授業', totalLessons: 12 },
    { courseId: 'course-2', name: '愛を深める心の授業', totalLessons: 23 },  // from catalog
    { courseId: 'lumina', name: 'LUMINA', totalLessons: null }
  ],
  rows: [
    {
      customerId, email, name,
      cells: {
        'course-1': { owned: true, completionPct: 67, completedCount: 8, totalLessons: 12, startedCount: 10, lastWatchedAt: '...' },
        'course-2': { owned: false },
        'lumina':   { owned: true, normalizedStatus: 'lifetime', grantedAt: '...' }
      }
    }
  ],
  total, page, limit
}
```

`columns` authoritative from `course-catalog.js` (via `getCourseLessonCount`) + a hardcoded `lumina` column. `totalLessons` is catalog count, never the touched count.

### Matrix CSV export

```
GET /api/admin/matrix/export?<filters>
Content-Type: text/csv
Columns: email, name,
         course-1_owned, course-1_completion_pct,
         course-2_owned, course-2_completion_pct,
         lumina_owned, lumina_status, lumina_granted_at
Rows: one per customer.
Limit 10,000 (tighter than list export — per-customer row has more columns).
Streaming via cursor, never buffered.
```

## 5. Auth — last login tracking

**Four code paths** (verified against `customer-auth.js`) update `nb_customers.last_login_at = NOW()`:

1. `POST /api/auth/register` (line 67) — first auto-login after signup.
2. `POST /api/auth/login` (line 127) — after bcrypt compare succeeds.
3. `POST /api/auth/reset-password` (line 242) — after successful reset + auto-login.
4. `GET /api/auth/magic-link` (line 336) — after magic-link token verified.

**Not** on `/api/auth/check` (session probe, not a real sign-in). **Not** on any future JWT refresh.

Update pattern:

```js
pool.query(
  `UPDATE nb_customers SET last_login_at=NOW(), updated_at=NOW() WHERE id=$1`,
  [customerId]
).catch(err => logger.warn({ err, customerId }, 'last_login_at update failed'));
```

Fire-and-forget with `.catch(logger.warn)` — failure doesn't break login, but we do get visibility in logs.

## 6. Admin UI

### `admin/customers.html` (new)

Two modes in one page (URL hash routed):
- `#/` — list view with filters + search + pagination, column headers sortable
- `#/c/:id` — detail view for one customer

List styling: reuse subscriber page's table/pagination CSS.

Detail view sections (top to bottom):
1. **Header card** — email, name, created_at, last_login_at, total_paid_jpy (formatted), course_count.
2. **Purchases** — table of `nb_payments` rows newest first. Stripe PI link (URL: `https://dashboard.stripe.com/payments/{payment_intent_id}`).
3. **Courses** — for each owned course: progress bar, % complete, last-watched timestamp, "Open watch page" link using the customer's access_token.
4. **Lumina** — status badge + grant date + plan code. Link to Stripe customer dashboard.
5. **Q&A threads** — table of threads with link into existing `/admin/qa.html#thread-:id`.
6. **Newsletter** — subscribed Y/N + tags + source.
7. **Tags editor** — chip input, **PUTs** `/api/admin/customers/:id/tags` on change. Rendered with `textContent` (never `innerHTML`). Must pass test: tag `<script>alert(1)</script>` renders literally, never executes.
8. **Notes editor** — textarea, autosave-on-blur + debounced save. Read-only display uses `textarea.value` only (never interpolated into innerHTML elsewhere). Must pass test: notes of `<script>alert(1)</script>` render as literal text.

Pure HTML + vanilla JS (match existing admin pattern — no frameworks).

### `admin/matrix.html` (new)

Full-width table:
- Sticky header row with course names.
- Sticky left column with customer email/name.
- Cells: ✓ / ✗ / % overlay / refunded badge.
- Click a row → open customer detail.
- Filters across top: course filter, search box, pagination.
- "Download CSV" button.

### `admin/dashboard.html` (modify)

Add two navigation tiles: **Customers** and **Matrix** alongside the existing Subscribers / Campaigns / Q&A / Alerts / Lumina links.

## 7. Implementation files

| File | Change |
|---|---|
| `schema.sql` | Add last_login_at, notes, tags to `nb_customers`; add `nb_customer_summary` VIEW creation at bottom |
| `migrations/002_admin_customer_detail.sql` (new) | Same ALTERs + CREATE INDEX + CREATE OR REPLACE VIEW |
| `customer-auth.js` | 3 fire-and-forget `UPDATE nb_customers SET last_login_at=NOW() WHERE id=$1` calls in the 3 login paths |
| `admin-routes.js` | 7 new endpoints listed in §4 |
| `admin/customers.html` (new) | List + detail view |
| `admin/matrix.html` (new) | Matrix view |
| `admin/dashboard.html` | Add nav tiles |
| `course-catalog.js` | Export `getCourseLessonCount(courseId)` helper if not already present |
| `public/js/admin-shared.js` (if exists) | Reuse existing fetch helpers |
| `Dockerfile` | `COPY admin/ /usr/share/nginx/html/admin/` already exists — new HTML auto-picked up |

## 8. Test plan

### Unit / local
1. View returns correct row shape for a customer with: 0 purchases, 1 course, bundle, Lumina lifetime, Lumina refunded.
2. `/api/admin/customers` paginates correctly (page 2 skips first `limit` rows).
3. Tag filter: `?tag=vip` returns only customers whose `tags` array contains `vip`.
4. Search matches email OR name, case-insensitive.
5. Last-login update happens on successful login, doesn't break on DB write failure (force unique-violation in a test).
6. Notes PUT rejects non-string, accepts empty string.
7. Matrix rows: customer with 1 course shows one `owned: true` and one `owned: false`.
8. Matrix refund case: Lumina `refunded` cell renders distinct state.

### E2E post-deploy
9. Login to `/admin` with admin password, navigate to `#/customers`, see the SecurityTest row.
10. Click into detail, verify Lumina section shows `lifetime` correctly (if we ever flip that row) or `active` (if we leave it).
11. Set a tag on a customer, reload, tag persists.
12. Save notes, reload, notes persist.
13. Matrix view loads, columns = course-1 + course-2 + lumina, SecurityTest's row shows his Lumina cell.
14. CSV export downloads with correct columns.
15. Search "security" finds SecurityTest, filters work.

## 9. Rollback

Schema additions (columns, view) are additive — rollback = leave them alone. Git revert is sufficient for code.

## 10. Deploy sequence

1. Pre-deploy backup: `docker exec namibarden-db pg_dump -U namibarden namibarden > /root/backups/namibarden-pre-phase2-$(date +%Y%m%d-%H%M).sql`
2. Apply migration: `docker exec -i namibarden-db psql -U namibarden -d namibarden < migrations/002_admin_customer_detail.sql`
3. Verify view + columns exist.
4. `cd /root/projects/NamiBarden && docker compose up -d --build`.
5. Smoke test: hit `/api/admin/customers` (authenticated), verify response shape.
6. Chrome DevTools walk-through via §8 E2E steps.

## 11. Risks & open questions

- **VIEW dependency risk** — if someone later alters `nb_customers` schema, the view breaks silently. Mitigation: prefer `CREATE OR REPLACE VIEW` and document dependency.
- **Stripe PI dashboard link** — URL format assumes live mode. Test mode payments would need a different prefix. Acceptable — admin is internal.
- **Performance** — no covering index on `nb_customers.created_at`. For 1k+ customers the list query with default sort is fine; if we hit 10k+, add it.
- **Unicode tags** — tag input should accept JP characters. Test with `ロイヤル` tag.
- **Notes XSS** — admin page renders notes into `<textarea>`; safe. Any read-only display must `textContent`, not `innerHTML`.
- **Customer list vs subscriber list cognitive overlap** — having both views under `/admin` is fine, but link from one to the other for cross-reference (on a customer detail page, show "also a newsletter subscriber since X").

## 12. Open questions for consensus

1. **Single VIEW vs inlined queries** — I've picked a VIEW (`nb_customer_summary`). Simpler to maintain but harder to optimize per query. Alternative: inline the joins directly in each endpoint. Codex perspective?
2. **Notes history** — Gil only asked for a notes field, not history. OK to defer an audit trail table?
3. **Matrix row truncation** — if we ever hit 10k+ customers, `GET /api/admin/matrix` returning all rows in one page kills the browser. Pagination handles this; but `export.csv` does full 50k dump. Is that limit right, or should matrix CSV cap at 10k?
4. **Dashboard navigation** — adding two tiles (Customers + Matrix). Want me to also rename "Students" page (course-engagement.js-backed) to fold into Customers, or keep them separate?
5. **Subscriber cross-reference** — if `nb_customers` has an email that matches `nb_subscribers.email`, we auto-link newsletter status on the detail page. Should we also show customer status on the subscribers page? (I say no — one direction only.)
