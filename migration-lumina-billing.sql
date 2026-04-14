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

CREATE TABLE IF NOT EXISTS nb_processed_webhooks (
  id SERIAL PRIMARY KEY,
  event_id VARCHAR(255) UNIQUE NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  processed_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_processed_webhooks_type ON nb_processed_webhooks(event_type);
