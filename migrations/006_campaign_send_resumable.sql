BEGIN;

-- Expand status vocabulary on nb_campaign_recipients so the send pipeline
-- can atomically claim each recipient ('sending'), mark mid-send skips
-- (subscriber went inactive between snapshot and actual send → 'skipped'),
-- and resume a crashed campaign by re-scanning 'pending' rows. The old
-- vocabulary forced a single mega-INSERT + inline send loop with no per-
-- recipient idempotency.
ALTER TABLE nb_campaign_recipients
  DROP CONSTRAINT IF EXISTS nb_campaign_recipients_status_check;

ALTER TABLE nb_campaign_recipients
  ADD CONSTRAINT nb_campaign_recipients_status_check
  CHECK (status IN (
    'pending', 'sending', 'sent', 'opened', 'clicked',
    'bounced', 'unsubscribed', 'skipped'
  ));

-- Speeds up resume/pending scans and the "how many sent so far" rollup.
CREATE INDEX IF NOT EXISTS idx_recipients_campaign_status
  ON nb_campaign_recipients(campaign_id, status);

-- Scope marker on Nami's pending attachments so a thread-scoped admin cookie
-- can't view another thread's pending upload. NULL = uploaded in a full-admin
-- session (globally viewable by full admin). Set explicitly on uploads from a
-- thread-scoped session.
ALTER TABLE nb_qa_pending_attachments
  ADD COLUMN IF NOT EXISTS uploader_thread_id INTEGER NULL;

COMMIT;
