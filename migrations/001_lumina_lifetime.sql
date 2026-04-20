BEGIN;

ALTER TABLE nb_app_entitlements
  ADD COLUMN IF NOT EXISTS lifetime_granted_at TIMESTAMP;

CREATE TABLE IF NOT EXISTS nb_lumina_migration_audit (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER REFERENCES nb_customers(id),
  email VARCHAR(255),
  old_status VARCHAR(50),
  old_plan_code VARCHAR(100),
  old_stripe_subscription_id VARCHAR(255),
  old_current_period_end TIMESTAMP,
  old_subscription_row JSONB,
  stripe_cancel_result TEXT,
  prorated_refund_jpy INTEGER,
  refund_stripe_charge_id VARCHAR(255),
  new_status VARCHAR(50) DEFAULT 'lifetime',
  email_sent BOOLEAN DEFAULT FALSE,
  error_message TEXT,
  migrated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lumina_migration_audit_customer
  ON nb_lumina_migration_audit(customer_id);

COMMIT;
