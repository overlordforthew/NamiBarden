BEGIN;

-- 1) channel column + consistency
ALTER TABLE nb_qa_threads
  ADD COLUMN IF NOT EXISTS channel VARCHAR(20) NOT NULL DEFAULT 'course',
  ADD COLUMN IF NOT EXISTS last_admin_notified_at TIMESTAMP;

-- Preflight: legacy rows may have NULL course_id from the pre-channel schema.
-- Any such row is reclassified to channel='dm' (with lesson_id nulled) so the
-- channel_consistency constraint below can be added without an existing-row failure.
UPDATE nb_qa_threads
SET channel = 'dm', lesson_id = NULL
WHERE channel = 'course' AND course_id IS NULL;

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

-- DM threads don't need an access_token
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

-- One DM thread per customer
CREATE UNIQUE INDEX IF NOT EXISTS idx_qa_threads_dm_one_per_customer
  ON nb_qa_threads(customer_id) WHERE channel = 'dm';

CREATE INDEX IF NOT EXISTS idx_qa_threads_channel_last
  ON nb_qa_threads(channel, last_message_at DESC);

-- 2) nb_qa_messages.body allow empty when attachments exist -- already TEXT NOT NULL;
-- use empty string '' when user sends attachment-only (not NULL). Enforced at API layer.

-- 3) pending uploads (mutated by upload endpoint, committed by message POST)
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

-- 4) committed attachments
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

-- 5) magic deep-link tokens
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

COMMIT;
