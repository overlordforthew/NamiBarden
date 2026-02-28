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
