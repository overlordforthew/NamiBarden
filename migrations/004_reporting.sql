BEGIN;

-- 1) Add stripe_charge_id to payments (non-breaking; existing rows get NULL)
ALTER TABLE nb_payments
  ADD COLUMN IF NOT EXISTS stripe_charge_id VARCHAR(255);
CREATE INDEX IF NOT EXISTS idx_payments_charge_id ON nb_payments(stripe_charge_id);

-- 1b) Convert created_at to TIMESTAMPTZ so JST bucketing works correctly.
-- Existing TIMESTAMP values are already UTC (postgres NOW() default); add UTC tz on conversion.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='nb_payments' AND column_name='created_at' AND data_type='timestamp without time zone'
  ) THEN
    ALTER TABLE nb_payments
      ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC';
  END IF;
END $$;

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
  stripe_created_at TIMESTAMPTZ NOT NULL,
  last_stripe_event_at TIMESTAMPTZ,    -- for event-order safety: refund UPSERT ignores older events
  created_at TIMESTAMP DEFAULT NOW()
);
-- Retro-add for existing deploys
ALTER TABLE nb_refunds
  ADD COLUMN IF NOT EXISTS last_stripe_event_at TIMESTAMPTZ;

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
