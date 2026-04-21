# Phase 3 — Student ↔ Nami chat: SSE + DM + email alerts + attachments + magic deep-link

**Status:** post-consensus (Opus + GPT-5.4 xhigh adversarial review; 1 CRITICAL + 16 HIGH + 14 MEDIUM items resolved)
**Dependencies:** Phase 1 (Lumina lifetime) + Phase 2 (admin customer-detail) both LIVE

## 1. Goals

- **"DM Nami" channel** — one canonical DM thread per customer. Not tied to a course or lesson.
- **Server-Sent Events** — admin sees new messages without polling; students see Nami's replies without refresh; durable reconnect via `Last-Event-ID` cursor.
- **Instant email alert** with opaque magic deep-link that auto-auths Nami **scope-limited to that thread**.
- **Attachments** — images / PDFs / audio via R2, server-side magic-byte validation, pending-upload table keeps GC safe.
- **Admin UI** — extends `/admin/qa.html` with attachment uploader + SSE + DM filter + proper DOM-text rendering.
- **Student UI** — "DM Nami" tile on `/watch` + standalone `/messages` page for Lumina-only customers.
- Fixes the Phase 2 deferred regression: admin workflow for token-only Q&A threads.

## 2. Product decisions (post-consensus, locked)

| Item | Decision |
|---|---|
| DM cardinality | **One canonical DM thread per customer** (UNIQUE partial index `(customer_id) WHERE channel='dm'`). Multi-topic deferred. |
| Channel column | `channel ENUM('course','dm')` with CHECK that DM means `course_id IS NULL AND lesson_id IS NULL`; course means `course_id IS NOT NULL`. |
| DM access_token | `access_token` becomes **nullable** for `channel='dm'`. DM threads keyed by `customer_id`; old `access_token` stays NOT NULL for `channel='course'`. |
| SSE durability | Native `EventSource` reconnect + server emits `id: <messageId>` line + client resync via `GET /api/chat/threads/:id?since=<lastSeenMessageId>` on reconnect. Not Redis — single container. |
| Deep-link token | **Opaque random 32-byte hex.** Raw in URL query; SHA-256 hash in DB. Atomic consume: `UPDATE ... SET consumed_at=NOW() WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>NOW() RETURNING thread_id`. |
| Deep-link consumption | **POST-consume.** GET `/api/admin/link-thread?token=X` renders a one-tap "Open thread as Nami" button → POST `/api/admin/link-thread` with token in form body → consume + redirect. Stops email-scanner prefetch from consuming the token. |
| Deep-link admin scope | **Thread-scoped admin JWT**, 15-min TTL, audience `thread-admin:<threadId>`. Not a full 24h admin cookie. To access the rest of the admin panel, Nami still has to log in normally. |
| Reply-by-email | **No.** Nami alert email copy explicitly: "Reply to this email goes to the student's inbox only and is NOT stored. Use Open thread to send + track." `replyTo` = student email. |
| Attachment types + sizes | image/* up to **10 MB**, application/pdf up to **15 MB**, audio/* up to **25 MB** (voice notes). Audio duration enforced only if `ffprobe` available; if not, accept without duration cap. ffprobe install deferred — enforcement fails-closed only for images/PDFs. |
| Attachment MIME validation | Server-side **magic-byte check** via the `file-type` npm package (or an equivalent 200-byte-signature comparison). Reject SVG + HTML polyglots. Stored MIME = detected, not submitted. |
| Pending-upload table | `nb_qa_pending_attachments` — uploads go here first with `expires_at = NOW() + 1h`. Committed to `nb_qa_attachments` inside the message POST transaction. GC deletes pending rows + R2 keys older than expires_at. |
| Transactional commit | Message insert + attachment commit + thread update = one BEGIN/COMMIT. SSE + email fire **after** commit, on the returned `messageId + created_at`. |
| Message ordering | SQL `ORDER BY created_at ASC, id ASC`. SSE payload always includes `{id, createdAt}`. Clients de-dupe by id on resync. |
| Rate limits | See §7. Separate quotas for DM create, reply (course + DM), attachment upload, deep-link issuance. |
| Email debounce | First unread student message in a thread → email immediately. Subsequent unread messages within 15 min → coalesced (no email). Next email only after Nami opens thread OR after 15 min elapses with no reply. |
| nginx body size | Bump to **30 MB** for `/api/chat/attachments` location (covers 25 MB audio + multipart overhead). Rest of `/api/` stays at current 5 MB. |
| SSE nginx config | Dedicated `location` for `/api/chat/stream` + `/api/admin/qa/stream`: `proxy_buffering off; proxy_read_timeout 3600;` |
| Upload JWT | Dedicated signing audience `chat-upload`, separate from customer/admin auth. Claims: `{kind, uploader (role+id), r2Key, mime, size, sha256, exp=1h}`. Binds the upload to the uploader; leak risk limited to same uploader's future threads. |
| Attachment URL in SSE | Stable route `/api/chat/attachments/:id/view` (mints signed URL on demand). SSE payload never contains signed URLs. |
| Token-only Q&A regression (Phase 2 holdover) | Resolved here: new endpoint `/api/admin/qa/:id/open-as-student` issues a course-impersonation JWT for the thread's `access_token` (no raw token in response). |
| Nginx route ordering | `/api/chat/stream`, `/api/admin/qa/stream`, `/api/chat/attachments` — each **before** the catch-all `/api/` in nginx.conf. |
| ensureTables runtime | Phase 3 removes the runtime `ensureTables()` drift in course-engagement.js — `schema.sql` + `migrations/` are the only source of truth. |
| CSP | `connect-src 'self' https://*.r2.cloudflarestorage.com`, `img-src`/`media-src` likewise. Final host confirmed from current R2_ENDPOINT. |

## 3. Schema changes

```sql
-- migrations/003_chat_sse_attachments.sql

BEGIN;

-- 1) channel column + consistency
ALTER TABLE nb_qa_threads
  ADD COLUMN IF NOT EXISTS channel VARCHAR(20) NOT NULL DEFAULT 'course';

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

-- 2) nb_qa_messages.body allow empty when attachments exist — already TEXT NOT NULL;
-- use empty string '' when user sends attachment-only (not NULL). Enforced at API layer.

-- 3) pending uploads (mutated by upload endpoint, committed by message POST)
CREATE TABLE IF NOT EXISTS nb_qa_pending_attachments (
  id SERIAL PRIMARY KEY,
  uploader VARCHAR(20) NOT NULL CHECK (uploader IN ('student','nami')),
  uploader_customer_id INTEGER REFERENCES nb_customers(id) ON DELETE SET NULL,
  uploader_access_token VARCHAR(64),   -- for guest/course-token uploads
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
  token_hash CHAR(64) NOT NULL UNIQUE,          -- sha256 hex of raw token
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
```

## 4. API surface

Every route below states its **auth rule** explicitly.

### Student-facing

```
POST /api/chat/dm
Auth: customerAuth (JWT cookie) — Lumina-only customers allowed
Body: { body?: string, attachments: [<uploadId>] }
Behavior: on first call creates the DM thread (channel='dm', customer_id=req.customer.id, access_token=NULL);
          subsequent calls append to same thread.
Response: { threadId, messageId, createdAt, attachments: [{id, detectedMime, sizeBytes, durationSeconds, originalFilename}] }
Rate limit: 30 messages per customer per hour, 200 per IP per day.
Body constraint: body may be empty ("") if attachments.length > 0; else required.
```

```
POST /api/chat/threads/:id/messages
Auth rule (any):
  - admin JWT cookie; OR
  - customerAuth && thread.customer_id = req.customer.id; OR
  - ?token=<access_token> matches thread.access_token (course threads only).
Body: { body?: string, attachments: [<uploadId>] }
Rate limit: 60 per customer per hour / 30 per access_token per hour.
Transactional: message + attachment claim + thread.last_message_at + unread_for_admin/student in one BEGIN/COMMIT; SSE emit after commit.
```

```
GET /api/chat/threads
Auth: customerAuth OR ?token=<access_token>
Returns: all threads for the authenticated identity (customer_id OR access_token match), ordered by last_message_at DESC.
```

```
GET /api/chat/threads/:id
Auth rule (same as POST above — explicit ownership enforced in the same DB query that selects the thread).
Query: ?since=<lastSeenMessageId> optional; returns only messages with id > since.
Side effect: sets unread_for_student = FALSE (only if admin is not impersonating).
```

```
GET /api/chat/stream
Auth: customerAuth (for DM + customer_id-linked course threads) OR ?token=<access_token> (for specific course).
Response: text/event-stream; res.flushHeaders() immediately, initial `:ok\n\n`, heartbeat every 20s.
Events emitted:
  id: <messageId>
  event: message
  data: {threadId, messageId, body, sender, senderRole, createdAt, hasAttachments, attachmentCount}

Supports Last-Event-ID header — server replays missed messages since that id (cap 100 replay messages, else instruct client to full-refetch).
Rate limit: max 3 concurrent streams per customer/token.
```

### Attachment endpoints

```
POST /api/chat/attachments
Auth: customerAuth OR ?token=<access_token> (student); OR admin JWT (Nami).
multipart/form-data, single file "file" field, max 30 MB.
Server pipeline:
  1. Stream to buffer (multer memory, cap to declared size + 1 MB slack).
  2. Read first 4 KB, run file-type magic byte check → detected MIME.
  3. Reject if detected MIME not in allowlist (image/*, application/pdf, audio/*).
  4. Compute SHA-256.
  5. Upload to R2 (PutObjectCommand, private ACL, key: qa/<yyyy>/<mm>/<dd>/<uuid>-<sanitized>.
  6. INSERT nb_qa_pending_attachments (expires_at = NOW() + 1h).
  7. Sign uploadId JWT with audience 'chat-upload' expiring in 1h, claims:
       {kind:'upload', uploader:{role,id}, r2Key, mime:detected, size, sha256, expPerMatch:true}
Response: { uploadId, viewUrl: '/api/chat/attachments/<pendingId>/view', previewMime: detected, sizeBytes }
Rate limit: 20 uploads per customer per hour / 10 per guest IP per hour.
```

```
GET /api/chat/attachments/:id/view
Auth rule: reader must own the thread containing this attachment (committed path) OR be the original uploader of the pending upload.
Behavior: 302 → signed R2 GET URL (5 min TTL). Signed URL never appears in SSE payloads.
```

### Admin-facing

```
GET /api/admin/qa/stream
Auth: admin JWT
Events: thread-created, thread-updated, message (with id: <messageId>), status-changed, attachment-committed.
Supports Last-Event-ID like student stream.
Route registration: MUST be mounted BEFORE /api/admin/qa/:id (Express route order).
```

```
POST /api/admin/qa/:id/deep-link
Auth: admin JWT
Rate limit: 1 per thread per 30s (email resend abuse guard).
Body: { reason?: string }
Behavior:
  - token = crypto.randomBytes(32).toString('hex')
  - tokenHash = sha256(token)
  - INSERT nb_admin_thread_link_tokens (token_hash, thread_id, expires_at = NOW() + 15min)
  - Response: { url: 'https://namibarden.com/api/admin/link-thread?token=<token>', expiresAt }
  - Caller (email sender) embeds `url` in the alert mail.
```

```
GET /api/admin/link-thread?token=<raw>
Auth: none (the token IS the auth).
Behavior: ** render interstitial HTML ** with a single form that POSTs the token to the next endpoint.
          NEVER consume on GET (email security scanners would pre-consume).
```

```
POST /api/admin/link-thread
Body: { token: <raw> }  (from interstitial form)
SQL (atomic consume):
  UPDATE nb_admin_thread_link_tokens
  SET consumed_at = NOW(), consumed_ip = $2
  WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > NOW()
  RETURNING thread_id;
On hit:
  - Sign thread-scoped admin JWT: { role:'admin', scope:'thread-admin', threadId, exp: 15m }, audience 'thread-admin:<threadId>'.
  - Set cookie `nb_thread_admin_<threadId>` with that JWT, Path=/, HttpOnly, Secure, SameSite=Lax, Max-Age=900.
  - 302 → /admin/qa.html?thread=<threadId>&scope=thread-admin
On miss: 302 → /admin/?error=invalid_link
```

Admin routes that require full admin:
  - `/api/admin/qa/stream` — requires full `nb_admin_token`, NOT the thread-scoped one.
  - `/api/admin/qa/:id/reply` — accepts thread-scoped cookie IFF threadId matches, else falls back to full admin.
  - `/api/admin/qa/:id/status` — same.

```
GET /api/admin/qa/:id/open-as-student
Auth: admin JWT (full or thread-scoped matching :id)
Behavior: looks up thread.access_token server-side; for course threads, delegates to the existing /api/admin/customers/:id/open-as-student pattern; for DM threads, returns 404 (no watch page).
Fixes Phase 2 token-only Q&A regression — admin never receives the raw access_token.
```

## 5. Admin UI

Extends `/admin/qa.html`:

- New `EventSource('/api/admin/qa/stream')` client. Reconnects honor `Last-Event-ID`. On open, fetches `/api/admin/qa?since=<lastSeenMessageId>` to fill gaps.
- DM filter chip: `[DM] [Course] [All]` (All default).
- Attachment uploader: drag-drop + file input, up to 5 files per message. Each uploads to `/api/chat/attachments` → stores returned uploadIds → sent with final reply POST.
- Attachment display in thread view: inline images (max height 300px), PDF + audio as click-to-preview chips. Each uses `/api/chat/attachments/:id/view` (stable URL).
- Message rendering switched to **DOM node creation with textContent** for body + filenames (not innerHTML). Only markdown-style emoji/linebreaks from a safelist permitted.
- Thread-scoped deep-link arrivals render a banner: "Signed in for this thread only (15 min). Log in fully to access the admin panel." Hides navigation to other admin pages.

New student UI:

- `/watch` page: add "Messages" tab showing the student's threads (course + DM). SSE client: `new EventSource('/api/chat/stream?token=...')`.
- `/messages` standalone page: requires customerAuth. Shows DM thread + all owned-course threads. Magic-link flow supports `returnTo=/messages` (new query param whitelisted in `customer-auth.js:/api/auth/magic-link`).

## 6. Email alert flow

Trigger: new student message inserted (not admin-authored).

Coalesce rule (per thread):
1. Query: `SELECT MAX(created_at) as last_alert_at FROM nb_qa_thread_email_alerts WHERE thread_id=$1` (new tiny table — or reuse `nb_qa_threads.last_admin_notified_at` column, simpler).
2. If `last_alert_at < NOW() - 15 min` OR NULL → send. If Nami opened the thread (`unread_for_admin = FALSE`) since last alert → reset timer.
3. Mark `last_admin_notified_at = NOW()` on send.

Payload:
- From: `SMTP_FROM` (domain-owned)
- To: `NAMI_ALERT_EMAIL` (default `namibarden@gmail.com`, overridable via env var)
- Reply-To: **student's email** (so Nami can reply directly, but email body explains that direct email is not logged in the thread)
- Subject: `[DM|Course] <thread.subject>` (with Japanese + English in template)
- Body (bilingual sections): student name, channel + course/lesson context, first 400 chars, attachment badges, `[Open thread]` button that points to the `/api/admin/link-thread?token=<raw>` URL, plus caveat: "Reply to this email goes to the student inbox and is not stored — use Open thread to reply inside the system."

## 7. Rate limits

| Action | Limit | Scope |
|---|---|---|
| Create DM / first course Q&A | 10 per IP per hour | IP |
| DM reply | 60 per customer per hour | customer_id |
| Course reply | 30 per access_token per hour | access_token |
| Attachment upload | 20 per customer per hour; 10 per IP per hour for guests | customer_id / IP |
| SSE open | max 3 concurrent per customer/token | customer_id / access_token |
| Deep-link issue | 1 per thread per 30s (abuse guard for Nami-initiated retries) | thread_id |
| Email alert to Nami | Coalesced: 1 per thread per 15 min | thread_id |

## 8. Transactional message POST

```js
const client = await pool.connect();
try {
  await client.query('BEGIN');

  const msgRes = await client.query(
    `INSERT INTO nb_qa_messages (thread_id, sender, body) VALUES ($1, $2, $3)
     RETURNING id, created_at`,
    [threadId, sender, body || '']
  );
  const messageId = msgRes.rows[0].id;
  const createdAt = msgRes.rows[0].created_at;

  if (attachments.length > 0) {
    const pendingRes = await client.query(
      `DELETE FROM nb_qa_pending_attachments
       WHERE r2_key = ANY($1::varchar[]) AND uploader_customer_id = $2
       RETURNING r2_key, detected_mime, size_bytes, sha256, original_filename`,
      [r2Keys, req.customer.id]
    );
    for (const p of pendingRes.rows) {
      await client.query(
        `INSERT INTO nb_qa_attachments (message_id, thread_id, uploader, r2_key, detected_mime, size_bytes, sha256, original_filename)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [messageId, threadId, sender, p.r2_key, p.detected_mime, p.size_bytes, p.sha256, p.original_filename]
      );
    }
  }

  await client.query(
    `UPDATE nb_qa_threads SET last_message_at=NOW(), unread_for_admin=TRUE WHERE id=$1`,
    [threadId]
  );

  await client.query('COMMIT');

  // SSE + email fire ONLY after commit
  emitStreamEvent({ id: messageId, threadId, body, sender, createdAt, hasAttachments: attachments.length>0 });
  maybeSendAlertEmail(threadId);
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  throw err;
} finally {
  client.release();
}
```

## 9. GC script (`scripts/gc-qa-attachments.js`)

Runs nightly via host cron. Purges:
- `nb_qa_pending_attachments` rows with `expires_at < NOW()` — plus R2 keys referenced.
- Never lists R2 to find "orphans" — only deletes what the DB says is expired. **Safe by construction.**

Dry-run / live flags. Logs deleted counts.

## 10. Files to change

| File | Change |
|---|---|
| `schema.sql` | Append DDL from §3 |
| `migrations/003_chat_sse_attachments.sql` (new) | Same DDL, idempotent via `DO $$ IF NOT EXISTS` |
| `chat-routes.js` (new) | All /api/chat/* + SSE emitters |
| `admin-routes.js` | /api/admin/qa/stream (route order!), deep-link issue + consume, /api/admin/qa/:id/open-as-student |
| `course-engagement.js` | Remove runtime ensureTables schema drift; reuse SSE emitters from chat-routes; update existing Q&A POST handlers to call emit-after-commit |
| `customer-auth.js` | `/api/auth/magic-link` whitelist `returnTo=/messages` |
| `server.js` | Wire chat-routes deps (pool, jwt, multer, r2, SSE emitters shared with course-engagement) |
| `app-config.js` | New env var `NAMI_ALERT_EMAIL` (default `namibarden@gmail.com`) |
| `Dockerfile` | Append `chat-routes.js` to the COPY list; install `ffmpeg` for ffprobe IF we keep audio duration enforcement (else drop the enforcement); install `file-type` via `npm install file-type@19` in package.json |
| `nginx.conf` | Add dedicated locations `/api/chat/stream`, `/api/admin/qa/stream`, `/api/chat/attachments` before `/api/` catch-all. 30 MB body on attachments location. |
| `security-headers.conf` | Update CSP: `connect-src 'self'`, `img-src 'self' https://<r2-host>`, `media-src 'self' https://<r2-host>` (host confirmed from R2_ENDPOINT). |
| `public/watch.html` | Messages tab + SSE client |
| `public/messages.html` (new) | Standalone DM page |
| `admin/qa.html` | SSE client + DM filter + attachment uploader + DOM-text rendering + thread-scope banner |
| `scripts/gc-qa-attachments.js` (new) | Pending-table-driven GC |

## 11. Rate-limit / abuse defenses summary

Phase 3 introduces 3 new surfaces subject to abuse; all covered:
- **Email floods:** coalesce per-thread 15 min.
- **Storage floods:** 30 MB nginx cap, per-customer/IP quotas, magic-byte rejection.
- **Link token abuse:** 1 issue per thread per 30s, 15-min TTL, atomic one-time consume, POST-to-confirm (scanner-safe).

## 12. Test plan

### Schema / unit
1. DM thread with `access_token=NULL, customer_id=42, channel='dm'` inserts cleanly; second DM insert for same customer_id fails UNIQUE.
2. DM thread with `course_id='course-1'` rejected (channel_consistency CHECK).
3. Attachment upload with `multipart mime=image/png` but file body is HTML → rejected (magic-byte mismatch).
4. Deep-link: issue, GET renders interstitial without consuming, POST consumes atomically, second POST with same token returns 302 to /admin/?error=invalid_link.
5. Deep-link race: two concurrent POSTs — exactly one receives 302-success; the other errors.
6. Message POST with body='' and attachments=[] → 400. With body='' and attachments=[id] → 201.
7. SSE Last-Event-ID replay: reconnect with `Last-Event-ID: 5` returns messages 6,7,8 in order.
8. Pending upload expires at NOW()+1h → GC removes both DB row and R2 object.
9. Rate limit: 20+1 attachment uploads in an hour — 21st returns 429.
10. Token-scoped admin JWT cannot access `/api/admin/customers` (scope mismatch).

### E2E post-deploy
11. Customer DMs Nami with an image → namibarden@gmail.com receives alert with deep-link.
12. Fresh browser with no admin cookie → GET link → interstitial renders → click "Open thread" → POST consumes → redirected to `/admin/qa.html?thread=<id>&scope=thread-admin` with banner.
13. Nami replies from thread-admin session → student SSE stream receives message within 2 seconds.
14. Nami's reply navigates to `/admin/customers.html` → 401 (scope insufficient).
15. Two DMs in 3 min → only 1 email sent (coalesce).
16. Message ordering under concurrent reply: two admin replies within 100ms → student sees both, ordered by (createdAt, id).
17. Forwarded deep-link email: reuse a consumed link → 302 to /admin/?error.
18. Existing course Q&A flow still works (no regression).

## 13. Deploy sequence

1. Backup DB.
2. Apply `migrations/003_chat_sse_attachments.sql`.
3. Deploy NamiBarden container with new routes + nginx config.
4. Nginx reload inside container (automatic via entrypoint or explicit `nginx -s reload` if needed).
5. Smoke tests per §12 E2E.
6. Install host crontab entry for GC: `0 4 * * * docker exec namibarden node scripts/gc-qa-attachments.js --live >> /var/log/nb-gc.log 2>&1`.

## 14. Follow-ups (out of Phase 3 scope)

- Reply-by-email inbound processing (Phase 3.5).
- Redis pub/sub for multi-replica SSE (Phase 6+).
- Video attachments.
- Read receipts beyond unread_for_* booleans.
