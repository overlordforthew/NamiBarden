BEGIN;

ALTER TABLE nb_customers
  ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_customers_last_login_at ON nb_customers(last_login_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_customers_created_at ON nb_customers(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_customers_tags ON nb_customers USING GIN (tags);

-- Supporting indexes for the nb_customer_summary LATERAL joins
CREATE INDEX IF NOT EXISTS idx_lesson_progress_customer_last ON nb_lesson_progress(customer_id, last_watched_at DESC);
CREATE INDEX IF NOT EXISTS idx_qa_threads_customer ON nb_qa_threads(customer_id);

CREATE OR REPLACE VIEW nb_customer_summary AS
SELECT
  c.id,
  c.email,
  c.name,
  c.created_at,
  c.updated_at,
  c.last_login_at,
  c.notes,
  c.tags,
  c.stripe_customer_id,
  COALESCE(p.total_paid_jpy, 0) AS total_paid_jpy,
  COALESCE(p.payment_count, 0) AS payment_count,
  p.last_payment_at,
  COALESCE(ca.course_count, 0) AS course_count,
  COALESCE(ca.course_ids, ARRAY[]::varchar[]) AS course_ids,
  l.lumina_status,
  l.lumina_plan_code,
  l.lumina_granted_at,
  COALESCE(q.thread_count, 0) AS qa_thread_count,
  COALESCE(q.unread_for_admin_count, 0) AS qa_unread_for_admin_count,
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

COMMIT;
