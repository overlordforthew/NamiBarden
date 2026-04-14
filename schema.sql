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
  created_at TIMESTAMP DEFAULT NOW()
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
