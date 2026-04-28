BEGIN;

-- 1) Editable automated email rules for course lifecycle emails.
-- Seeded by app-startup with DEFAULT_RULES from course-reminder-config.js via
-- INSERT ... ON CONFLICT DO NOTHING, so admin edits survive redeploys.
CREATE TABLE IF NOT EXISTS nb_email_rules (
  rule_key     VARCHAR(64) PRIMARY KEY,
  name         VARCHAR(255) NOT NULL,
  description  TEXT,
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  delay_days   INTEGER NOT NULL CHECK (delay_days >= 0 AND delay_days <= 365),
  subject      TEXT NOT NULL,
  body_html    TEXT NOT NULL,
  config       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by   VARCHAR(255)
);

CREATE INDEX IF NOT EXISTS idx_email_rules_enabled
  ON nb_email_rules(enabled)
  WHERE enabled;

-- Keep updated_at fresh on any UPDATE without relying on every caller to set it.
CREATE OR REPLACE FUNCTION nb_email_rules_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_email_rules_touch_updated_at ON nb_email_rules;
CREATE TRIGGER trg_email_rules_touch_updated_at
  BEFORE UPDATE ON nb_email_rules
  FOR EACH ROW
  EXECUTE FUNCTION nb_email_rules_touch_updated_at();

COMMIT;
