-- Migration: Add customer authentication columns
-- Run this against namibarden-db

ALTER TABLE nb_customers ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
ALTER TABLE nb_customers ADD COLUMN IF NOT EXISTS reset_token VARCHAR(64);
ALTER TABLE nb_customers ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_customers_reset_token ON nb_customers(reset_token);
