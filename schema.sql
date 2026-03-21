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

-- BlueMoon GPS tracking
CREATE TABLE IF NOT EXISTS bluemoon_tracks (
  id SERIAL PRIMARY KEY,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  accuracy DOUBLE PRECISION,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bluemoon_tracks_recorded ON bluemoon_tracks(recorded_at);
