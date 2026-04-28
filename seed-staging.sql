-- NamiBarden staging fixtures — runs after schema.sql in init.
-- Idempotent so the file can be replayed safely.
-- The admin user is NOT seeded here — app-startup.js creates it from the
-- ADMIN_PASSWORD env var on first boot, so .env.staging is the single source
-- of truth for staging admin credentials.

-- Newsletter subscriber
INSERT INTO nb_subscribers (email, name, source, status, unsubscribe_token)
VALUES (
    'test-subscriber@example.test',
    'Staging Subscriber',
    'staging-fixture',
    'active',
    'staging-unsub-token-0001'
)
ON CONFLICT (email) DO NOTHING;

-- Test customer (Stripe customer-id is collision-safe — staging fixture prefix)
INSERT INTO nb_customers (email, name, stripe_customer_id)
VALUES (
    'test-customer@example.test',
    'Staging Test Customer',
    'cus_staging_fixture_0001'
)
ON CONFLICT (stripe_customer_id) DO NOTHING;

-- Contact submission
INSERT INTO nb_contacts (name, email, subject, message)
SELECT 'Staging Contact', 'test-contact@example.test', 'Staging fixture', 'This is a fixture contact message for staging.'
WHERE NOT EXISTS (
    SELECT 1 FROM nb_contacts WHERE email = 'test-contact@example.test'
);
