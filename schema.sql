-- NamiBarden Newsletter & Contact Database Schema

CREATE TABLE IF NOT EXISTS nb_admin (
  id SERIAL PRIMARY KEY,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS nb_subscribers (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255),
  source VARCHAR(100) DEFAULT 'newsletter',
  status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'unsubscribed', 'bounced')),
  tags TEXT[] DEFAULT '{}',
  unsubscribe_token VARCHAR(64) UNIQUE NOT NULL,
  ip VARCHAR(45),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS nb_contacts (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  subject VARCHAR(255),
  message TEXT NOT NULL,
  ip VARCHAR(45),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS nb_campaigns (
  id SERIAL PRIMARY KEY,
  subject VARCHAR(500) NOT NULL,
  html_body TEXT,
  text_body TEXT,
  segment VARCHAR(100) DEFAULT 'all',
  status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'sending', 'sent', 'failed')),
  total_count INTEGER DEFAULT 0,
  sent_count INTEGER DEFAULT 0,
  open_count INTEGER DEFAULT 0,
  click_count INTEGER DEFAULT 0,
  bounce_count INTEGER DEFAULT 0,
  unsub_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  sent_at TIMESTAMP,
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS nb_campaign_recipients (
  id SERIAL PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES nb_campaigns(id) ON DELETE CASCADE,
  subscriber_id INTEGER NOT NULL REFERENCES nb_subscribers(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  tracking_id VARCHAR(64) UNIQUE NOT NULL,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'opened', 'clicked', 'bounced', 'unsubscribed')),
  opened_at TIMESTAMP,
  clicked_at TIMESTAMP,
  bounced_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS nb_email_events (
  id SERIAL PRIMARY KEY,
  tracking_id VARCHAR(64) NOT NULL,
  event_type VARCHAR(20) NOT NULL CHECK (event_type IN ('open', 'click', 'bounce', 'unsubscribe')),
  url TEXT,
  ip VARCHAR(45),
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscribers_email ON nb_subscribers(email);
CREATE INDEX IF NOT EXISTS idx_subscribers_status ON nb_subscribers(status);
CREATE INDEX IF NOT EXISTS idx_subscribers_source ON nb_subscribers(source);
CREATE INDEX IF NOT EXISTS idx_contacts_created ON nb_contacts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON nb_campaigns(status);
CREATE INDEX IF NOT EXISTS idx_recipients_campaign ON nb_campaign_recipients(campaign_id);
CREATE INDEX IF NOT EXISTS idx_recipients_tracking ON nb_campaign_recipients(tracking_id);
CREATE INDEX IF NOT EXISTS idx_events_tracking ON nb_email_events(tracking_id);
CREATE INDEX IF NOT EXISTS idx_events_created ON nb_email_events(created_at DESC);

-- Stripe payment tables
CREATE TABLE IF NOT EXISTS nb_customers (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  name VARCHAR(255),
  stripe_customer_id VARCHAR(255) UNIQUE,
  subscriber_id INTEGER REFERENCES nb_subscribers(id),
  password_hash VARCHAR(255),
  reset_token VARCHAR(255),
  reset_token_expires TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS nb_subscriptions (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES nb_customers(id),
  stripe_subscription_id VARCHAR(255) UNIQUE NOT NULL,
  stripe_price_id VARCHAR(255) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'incomplete',
  product_name VARCHAR(255) DEFAULT 'coaching',
  current_period_start TIMESTAMP,
  current_period_end TIMESTAMP,
  cancel_at TIMESTAMP,
  canceled_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS nb_payments (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER REFERENCES nb_customers(id),
  stripe_payment_intent_id VARCHAR(255) UNIQUE,
  stripe_invoice_id VARCHAR(255),
  amount INTEGER NOT NULL,
  currency VARCHAR(10) DEFAULT 'jpy',
  status VARCHAR(50) NOT NULL,
  product_name VARCHAR(255) DEFAULT 'coaching',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customers_email ON nb_customers(email);
CREATE INDEX IF NOT EXISTS idx_customers_stripe ON nb_customers(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_customer ON nb_subscriptions(customer_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe ON nb_subscriptions(stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON nb_subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_payments_customer ON nb_payments(customer_id);
CREATE INDEX IF NOT EXISTS idx_payments_stripe ON nb_payments(stripe_payment_intent_id);

-- App entitlements (Lumina and future apps)
CREATE TABLE IF NOT EXISTS nb_app_entitlements (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES nb_customers(id) ON DELETE CASCADE,
  app_slug VARCHAR(100) NOT NULL,
  plan_code VARCHAR(100) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'inactive',
  stripe_subscription_id VARCHAR(255),
  source_product_name VARCHAR(255),
  current_period_start TIMESTAMP,
  current_period_end TIMESTAMP,
  trial_end TIMESTAMP,
  cancel_at TIMESTAMP,
  canceled_at TIMESTAMP,
  lifetime_granted_at TIMESTAMP NULL,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(customer_id, app_slug)
);

CREATE INDEX IF NOT EXISTS idx_app_entitlements_customer ON nb_app_entitlements(customer_id);
CREATE INDEX IF NOT EXISTS idx_app_entitlements_app ON nb_app_entitlements(app_slug);
CREATE INDEX IF NOT EXISTS idx_app_entitlements_status ON nb_app_entitlements(status);
CREATE INDEX IF NOT EXISTS idx_app_entitlements_subscription ON nb_app_entitlements(stripe_subscription_id);

-- Stripe webhook idempotency
CREATE TABLE IF NOT EXISTS nb_processed_webhooks (
  id SERIAL PRIMARY KEY,
  event_id VARCHAR(255) UNIQUE NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  processed_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_processed_webhooks_type ON nb_processed_webhooks(event_type);

-- Operational alerts
CREATE TABLE IF NOT EXISTS nb_operational_alerts (
  id SERIAL PRIMARY KEY,
  alert_key VARCHAR(255) UNIQUE NOT NULL,
  source VARCHAR(100) NOT NULL,
  severity VARCHAR(20) NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
  title VARCHAR(255) NOT NULL,
  message TEXT,
  details JSONB DEFAULT '{}'::jsonb,
  status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  first_seen TIMESTAMP DEFAULT NOW(),
  last_seen TIMESTAMP DEFAULT NOW(),
  last_notified_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_operational_alerts_status_seen ON nb_operational_alerts(status, last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_operational_alerts_source_status ON nb_operational_alerts(source, status);
CREATE INDEX IF NOT EXISTS idx_operational_alerts_severity_status ON nb_operational_alerts(severity, status);

-- Course access table
CREATE TABLE IF NOT EXISTS nb_course_access (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER REFERENCES nb_customers(id),
  course_id VARCHAR(50) NOT NULL,
  access_token VARCHAR(64) UNIQUE NOT NULL,
  email VARCHAR(255) NOT NULL,
  stripe_session_id VARCHAR(255),
  purchased_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP,
  UNIQUE(customer_id, course_id)
);

CREATE INDEX IF NOT EXISTS idx_course_access_token ON nb_course_access(access_token);
CREATE INDEX IF NOT EXISTS idx_course_access_customer ON nb_course_access(customer_id);
CREATE INDEX IF NOT EXISTS idx_course_access_course ON nb_course_access(course_id);
CREATE INDEX IF NOT EXISTS idx_course_access_email ON nb_course_access(email);

-- Course lifecycle reminders (e.g. 21-day course-2 upsell follow-up)
CREATE TABLE IF NOT EXISTS nb_course_reminders (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER REFERENCES nb_customers(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  reminder_type VARCHAR(50) NOT NULL,
  sent_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(customer_id, reminder_type)
);

CREATE INDEX IF NOT EXISTS idx_course_reminders_customer ON nb_course_reminders(customer_id);

-- Per-lesson watch progress (keyed by access_token = student identity)
CREATE TABLE IF NOT EXISTS nb_lesson_progress (
  id SERIAL PRIMARY KEY,
  access_token VARCHAR(64) NOT NULL,
  course_id VARCHAR(50) NOT NULL,
  lesson_id VARCHAR(100) NOT NULL,
  email VARCHAR(255) NOT NULL,
  customer_id INTEGER REFERENCES nb_customers(id) ON DELETE SET NULL,
  position_seconds REAL DEFAULT 0,
  duration_seconds REAL DEFAULT 0,
  completed BOOLEAN DEFAULT FALSE,
  completed_at TIMESTAMP,
  first_watched_at TIMESTAMP DEFAULT NOW(),
  last_watched_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(access_token, course_id, lesson_id)
);

CREATE INDEX IF NOT EXISTS idx_lesson_progress_token ON nb_lesson_progress(access_token, course_id);
CREATE INDEX IF NOT EXISTS idx_lesson_progress_email ON nb_lesson_progress(email);
CREATE INDEX IF NOT EXISTS idx_lesson_progress_last ON nb_lesson_progress(last_watched_at DESC);

-- Q&A threads between students and Nami
CREATE TABLE IF NOT EXISTS nb_qa_threads (
  id SERIAL PRIMARY KEY,
  access_token VARCHAR(64) NOT NULL,
  customer_id INTEGER REFERENCES nb_customers(id) ON DELETE SET NULL,
  email VARCHAR(255) NOT NULL,
  name VARCHAR(255),
  course_id VARCHAR(50),
  lesson_id VARCHAR(100),
  subject VARCHAR(255),
  status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'archived')),
  unread_for_admin BOOLEAN NOT NULL DEFAULT TRUE,
  unread_for_student BOOLEAN NOT NULL DEFAULT FALSE,
  last_message_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_qa_threads_token ON nb_qa_threads(access_token);
CREATE INDEX IF NOT EXISTS idx_qa_threads_status_last ON nb_qa_threads(status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_qa_threads_email ON nb_qa_threads(email);

CREATE TABLE IF NOT EXISTS nb_qa_messages (
  id SERIAL PRIMARY KEY,
  thread_id INTEGER NOT NULL REFERENCES nb_qa_threads(id) ON DELETE CASCADE,
  sender VARCHAR(20) NOT NULL CHECK (sender IN ('student', 'nami')),
  body TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_qa_messages_thread ON nb_qa_messages(thread_id, created_at);

-- Lumina app schema (stored in the shared Nami database)
CREATE SCHEMA IF NOT EXISTS lumina;

CREATE TABLE IF NOT EXISTS lumina.users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  lang VARCHAR(10) DEFAULT 'en',
  start_date DATE DEFAULT CURRENT_DATE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lumina.progress (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES lumina.users(id) ON DELETE CASCADE,
  day_num INTEGER NOT NULL,
  completed_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, day_num)
);

CREATE TABLE IF NOT EXISTS lumina.audio (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES lumina.users(id) ON DELETE CASCADE,
  day_num INTEGER NOT NULL,
  audio_data TEXT NOT NULL,
  UNIQUE(user_id, day_num)
);

CREATE TABLE IF NOT EXISTS lumina.images (
  id SERIAL PRIMARY KEY,
  day_num INTEGER UNIQUE NOT NULL,
  image_data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lumina.checkins (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES lumina.users(id) ON DELETE CASCADE,
  day_num INTEGER NOT NULL,
  state VARCHAR(50) NOT NULL DEFAULT 'ground',
  energy INTEGER DEFAULT 3,
  intention VARCHAR(180),
  note TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, day_num)
);

CREATE TABLE IF NOT EXISTS lumina.reflections (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES lumina.users(id) ON DELETE CASCADE,
  day_num INTEGER NOT NULL,
  body TEXT DEFAULT '',
  favorite BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, day_num)
);

CREATE TABLE IF NOT EXISTS lumina.analytics_events (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES lumina.users(id) ON DELETE SET NULL,
  email VARCHAR(255),
  session_id VARCHAR(80) NOT NULL,
  event_name VARCHAR(80) NOT NULL,
  event_source VARCHAR(40) DEFAULT 'app',
  page_path VARCHAR(255),
  ip VARCHAR(80),
  user_agent TEXT,
  properties JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lumina_progress_user_day ON lumina.progress(user_id, day_num);
CREATE INDEX IF NOT EXISTS idx_lumina_checkins_user_day ON lumina.checkins(user_id, day_num);
CREATE INDEX IF NOT EXISTS idx_lumina_reflections_user_day ON lumina.reflections(user_id, day_num);
CREATE INDEX IF NOT EXISTS idx_lumina_analytics_event_created ON lumina.analytics_events(event_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lumina_analytics_email_created ON lumina.analytics_events(email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lumina_analytics_user_created ON lumina.analytics_events(user_id, created_at DESC);

-- Phase 2 admin customer detail and matrix summary
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

-- Phase 3 chat SSE + DM threads + attachments + admin deep-links
ALTER TABLE nb_qa_threads
  ADD COLUMN IF NOT EXISTS channel VARCHAR(20) NOT NULL DEFAULT 'course',
  ADD COLUMN IF NOT EXISTS last_admin_notified_at TIMESTAMP;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'nb_qa_threads_channel_chk'
  ) THEN
    ALTER TABLE nb_qa_threads
      ADD CONSTRAINT nb_qa_threads_channel_chk CHECK (channel IN ('course','dm'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'nb_qa_threads_channel_consistency'
  ) THEN
    ALTER TABLE nb_qa_threads
      ADD CONSTRAINT nb_qa_threads_channel_consistency CHECK (
        (channel = 'dm' AND course_id IS NULL AND lesson_id IS NULL)
        OR (channel = 'course' AND course_id IS NOT NULL)
      );
  END IF;
END $$;

ALTER TABLE nb_qa_threads ALTER COLUMN access_token DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'nb_qa_threads_token_required_for_course'
  ) THEN
    ALTER TABLE nb_qa_threads
      ADD CONSTRAINT nb_qa_threads_token_required_for_course CHECK (
        channel = 'dm' OR access_token IS NOT NULL
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_qa_threads_dm_one_per_customer
  ON nb_qa_threads(customer_id) WHERE channel = 'dm';

CREATE INDEX IF NOT EXISTS idx_qa_threads_channel_last
  ON nb_qa_threads(channel, last_message_at DESC);

CREATE TABLE IF NOT EXISTS nb_qa_pending_attachments (
  id SERIAL PRIMARY KEY,
  uploader VARCHAR(20) NOT NULL CHECK (uploader IN ('student','nami')),
  uploader_customer_id INTEGER REFERENCES nb_customers(id) ON DELETE SET NULL,
  uploader_access_token VARCHAR(64),
  r2_key VARCHAR(512) NOT NULL UNIQUE,
  detected_mime VARCHAR(100) NOT NULL,
  declared_mime VARCHAR(100),
  size_bytes INTEGER NOT NULL,
  sha256 CHAR(64) NOT NULL,
  original_filename VARCHAR(255),
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_qa_pending_expires
  ON nb_qa_pending_attachments(expires_at);

CREATE TABLE IF NOT EXISTS nb_qa_attachments (
  id SERIAL PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES nb_qa_messages(id) ON DELETE CASCADE,
  thread_id INTEGER NOT NULL REFERENCES nb_qa_threads(id) ON DELETE CASCADE,
  uploader VARCHAR(20) NOT NULL CHECK (uploader IN ('student','nami')),
  r2_key VARCHAR(512) NOT NULL UNIQUE,
  detected_mime VARCHAR(100) NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 CHAR(64) NOT NULL,
  original_filename VARCHAR(255),
  duration_seconds INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_qa_attachments_message ON nb_qa_attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_qa_attachments_thread ON nb_qa_attachments(thread_id);

CREATE TABLE IF NOT EXISTS nb_admin_thread_link_tokens (
  id SERIAL PRIMARY KEY,
  token_hash CHAR(64) NOT NULL UNIQUE,
  thread_id INTEGER NOT NULL REFERENCES nb_qa_threads(id) ON DELETE CASCADE,
  issued_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL,
  consumed_at TIMESTAMP,
  consumed_ip VARCHAR(45),
  created_reason VARCHAR(100)
);

CREATE INDEX IF NOT EXISTS idx_thread_link_tokens_pending
  ON nb_admin_thread_link_tokens(expires_at)
  WHERE consumed_at IS NULL;

-- Phase 4 reporting + completion dashboard
ALTER TABLE nb_payments
  ADD COLUMN IF NOT EXISTS stripe_charge_id VARCHAR(255);
CREATE INDEX IF NOT EXISTS idx_payments_charge_id ON nb_payments(stripe_charge_id);

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
  stripe_created_at TIMESTAMPTZ NOT NULL,
  last_stripe_event_at TIMESTAMPTZ,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refunds_customer ON nb_refunds(customer_id);
CREATE INDEX IF NOT EXISTS idx_refunds_payment ON nb_refunds(payment_id);
CREATE INDEX IF NOT EXISTS idx_refunds_stripe_created ON nb_refunds(stripe_created_at DESC);
CREATE INDEX IF NOT EXISTS idx_refunds_charge ON nb_refunds(stripe_charge_id);
CREATE INDEX IF NOT EXISTS idx_refunds_pi ON nb_refunds(stripe_payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_refunds_product ON nb_refunds(product_name);

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

CREATE OR REPLACE VIEW nb_non_jpy_payments AS
SELECT currency, COUNT(*) AS payment_count, SUM(amount) AS total_minor_units
FROM nb_payments
WHERE status = 'succeeded' AND currency <> 'jpy'
GROUP BY currency;
