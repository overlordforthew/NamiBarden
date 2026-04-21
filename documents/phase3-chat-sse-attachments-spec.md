# Phase 3 — Student ↔ Nami chat: SSE realtime + email alerts + magic deep-link + attachments + "DM Nami" channel

**Status:** draft pending consensus
**Dependencies:** Phase 1 (lifetime entitlement model live) + Phase 2 (admin customer-detail; not strictly blocking but overlapping files)

## 1. Goals

Transform the existing Q&A threads into something students actually use as a DM channel with Nami:

- **General "DM Nami" channel** — students can message Nami independent of any course or lesson (`course_id`/`lesson_id` NULL).
- **Server-Sent Events (SSE) realtime** — admin sees new student messages in `/admin/qa.html` without polling; students see Nami's replies without refresh.
- **Email alerts** — `namibarden@gmail.com` pings Nami within seconds of any student message, with a magic-link deep jump that auto-auths her straight into the thread.
- **Attachments** — students and Nami can attach images / PDFs / short audio; stored in R2, signed-URL delivered.
- **Magic deep-link auto-auth for Nami** — email → one click → `/admin/qa.html?thread=123` with admin cookie already set, no password re-entry.
- **Nami reply UI** — the existing admin reply textarea already works; we add attachment upload + typing indicator + unread counts + optimistic rendering.

Out of scope for Phase 3: voice/video messages, group chats, read-receipts beyond unread_for_student/admin booleans, message edit/delete.

## 2. Product decisions (locked — challenge in consensus)

| Item | Decision |
|---|---|
| General channel identifier | `course_id=NULL, lesson_id=NULL` with new `channel='dm'` enum column. Course-context threads get `channel='course'`. Schema CHECK enforces one of two. |
| Email alert strategy | Fire instantly per student message (no batching). Debounce: if Nami has already replied in the last 10 min to the same thread, suppress the email (she's actively engaged). |
| SSE vs WebSocket | SSE — one-way server → client, works on our Express+nginx stack without new infra. Nami's reply still goes through POST. Bidirectional chat illusion assembled client-side. |
| SSE scope | Per admin: one SSE stream showing all thread events (new thread, new message, status change). Per student: one SSE stream for their own threads (keyed by access_token + customer_id). |
| Attachment types | `image/*` (jpeg/png/gif/webp, max 5 MB), `application/pdf` (max 10 MB), `audio/*` (mp4/m4a/mp3, max 10 MB, length < 3 min). Reject anything else. |
| Attachment retention | Indefinite. R2 lifecycle policies deferred to ops (not spec). |
| Magic deep-link TTL | 15 minutes. One-time use (token consumed on first auth). |
| Deep-link authorization | Signed short-TTL JWT `{role:'admin', kind:'thread-deep-link', threadId, exp}`. Grants admin cookie + redirects. Rate-limited: 1 issue per thread per 30 sec (prevents email resend abuse). |
| Alert from address | `SMTP_FROM` (domain-owned). ReplyTo = `namibarden@gmail.com` so Nami can reply-in-email AND click the deep-link. |
| Admin UI scope | Extend `/admin/qa.html` — don't fork. Add attachment uploader, SSE live update, DM Nami channel filter. |
| Student UI scope | A "Messages" section on the existing watch page (`/watch?token=...`) — scoped to that student's threads. Plus a public page `/messages` where a logged-in customer can DM Nami without owning any course. |
| Unread semantics | `unread_for_admin` clears when Nami opens the thread (existing behavior). `unread_for_student` clears when student opens the thread (currently not implemented). |

## 3. Schema changes

```sql
-- migrations/003_chat_sse_attachments.sql

-- 1) channel column on threads
ALTER TABLE nb_qa_threads
  ADD COLUMN IF NOT EXISTS channel VARCHAR(20) NOT NULL DEFAULT 'course'
    CHECK (channel IN ('course', 'dm'));

-- When channel='dm', course_id and lesson_id must be NULL
ALTER TABLE nb_qa_threads
  ADD CONSTRAINT nb_qa_threads_channel_consistency
  CHECK (
    (channel = 'dm' AND course_id IS NULL AND lesson_id IS NULL)
    OR channel = 'course'
  );

CREATE INDEX IF NOT EXISTS idx_qa_threads_channel_last ON nb_qa_threads(channel, last_message_at DESC);

-- 2) attachments table
CREATE TABLE IF NOT EXISTS nb_qa_attachments (
  id SERIAL PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES nb_qa_messages(id) ON DELETE CASCADE,
  thread_id INTEGER NOT NULL REFERENCES nb_qa_threads(id) ON DELETE CASCADE,
  uploader VARCHAR(20) NOT NULL CHECK (uploader IN ('student', 'nami')),
  r2_key VARCHAR(512) NOT NULL UNIQUE,
  original_filename VARCHAR(255),
  mime_type VARCHAR(100) NOT NULL,
  size_bytes INTEGER NOT NULL,
  duration_seconds INTEGER,   -- for audio only; null otherwise
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_qa_attachments_message ON nb_qa_attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_qa_attachments_thread ON nb_qa_attachments(thread_id);

-- 3) magic deep-link tokens (one-time use, short TTL)
CREATE TABLE IF NOT EXISTS nb_admin_thread_link_tokens (
  id SERIAL PRIMARY KEY,
  token_hash VARCHAR(128) NOT NULL UNIQUE,  -- SHA-256 of the token (never store raw)
  thread_id INTEGER NOT NULL REFERENCES nb_qa_threads(id) ON DELETE CASCADE,
  issued_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL,
  consumed_at TIMESTAMP,     -- NULL until first use
  consumed_ip VARCHAR(45),
  created_reason VARCHAR(100)  -- 'email-alert' | 'manual' | etc.
);

CREATE INDEX IF NOT EXISTS idx_thread_link_tokens_expires ON nb_admin_thread_link_tokens(expires_at) WHERE consumed_at IS NULL;
```

## 4. API surface

### Student → threads

```
POST /api/chat/dm
Auth: customerAuth OR access_token OR guest (email+name, same as existing /api/courses/questions)
Body: { body: string, attachments: [<uploadId>, ...] }  // creates a new DM thread
Response: { thread: {...}, message: {...} }
```

```
POST /api/chat/threads/:id/messages
Auth: customerAuth OR access_token matching thread.access_token
Body: { body: string, attachments: [<uploadId>, ...] }
Response: { message: {...} }
```

```
GET /api/chat/threads
Auth: customerAuth OR ?token=<access_token>
Returns: list of threads belonging to this student (DM + course Q&A)
```

```
GET /api/chat/threads/:id
Returns: thread + messages + attachments (signed URLs)
Side effect: clears unread_for_student
```

```
GET /api/chat/stream
Auth: customerAuth OR ?token=<access_token>
Response: text/event-stream
Events:
  event: message   data: {threadId, messageId, body, senderRole, createdAt, attachments}
  event: status    data: {threadId, status}
```

### Attachments (shared by student + admin paths)

```
POST /api/chat/attachments
Auth: customerAuth/access_token (student) OR admin JWT
multipart/form-data, single file field "file"
Limits: type allowlist + size limits from §2
Response: { uploadId, r2Key, previewUrl (signed, 1h TTL) }
Note: attachment is uncommitted — becomes durable only when referenced from a message in POST /messages.
Uncommitted uploads older than 1 hour get garbage-collected nightly (cron job).
```

```
GET /api/chat/attachments/:id/view
Auth: student who owns the thread OR admin JWT
Response: 302 → signed R2 URL (1h TTL)
```

### Admin-facing

```
GET /api/admin/qa/stream
Auth: admin JWT
Response: text/event-stream (all threads)
Events:
  event: thread-created
  event: thread-updated
  event: message-added
  event: status-changed
```

```
POST /api/admin/qa/:id/deep-link
Auth: admin JWT
Rate limited: 1 per thread per 30 seconds
Body: { reason?: string }
Response: { url: 'https://namibarden.com/admin/link-thread?token=<raw>' }
Purpose: emit an email-friendly link. Stored as SHA-256 hash in nb_admin_thread_link_tokens.
```

```
GET /api/admin/link-thread?token=<raw>
No auth (token IS the auth)
Verifies token: exists, not expired, not consumed.
On success: sets admin JWT cookie, marks token consumed, 302 → /admin/qa.html?thread=<id>
On failure: 302 → /admin/ with error flash
```

### Attachment upload from admin

Same shared `POST /api/chat/attachments` works for both student and admin uploads (uploader inferred from auth context). Admin posts attachments in `POST /api/admin/qa/:id/reply` by passing the `uploadId`.

## 5. Email alert flow

**Trigger:** any new student message (not admin).

**Path (inside `POST /api/chat/threads/:id/messages` after insert):**

1. Check debounce: if any `nb_qa_messages.sender='nami'` row exists with `created_at > NOW() - INTERVAL '10 minutes'` for this thread → skip email.
2. Generate deep-link token (see §4). TTL 15 min.
3. Send email to `namibarden@gmail.com` (SMTP_FROM envelope, `replyTo: thread.email`).
4. Email body includes:
   - Student name + email
   - Channel: DM Nami OR course-course-1 / lesson-name
   - First 400 chars of the message
   - Attachment icons if any (`3 attachments: 2 images, 1 PDF`)
   - **"Open thread" button** → deep-link URL
   - **Reply-by-email note:** "Reply directly to this email to respond. Or open the thread to send attachments."

**Reply-by-email handling:** out of scope for Phase 3. The `replyTo: thread.email` supports a direct-reply back to the student, but threading into our DB requires inbound SMTP processing — defer.

## 6. SSE implementation

### Server

```js
// New chat-routes.js

const sseClients = {
  admin: new Set(),   // one stream per admin session
  students: new Map() // customerId → Set<res>
};

function emitAdminEvent(eventName, payload) {
  const line = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients.admin) { try { res.write(line); } catch {} }
}

function emitStudentEvent(customerId, eventName, payload) {
  const set = sseClients.students.get(customerId);
  if (!set) return;
  const line = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of set) { try { res.write(line); } catch {} }
}

// Called from within DB write paths:
// emitAdminEvent('message-added', {...})
// emitStudentEvent(thread.customer_id, 'message', {...})
```

### Connection management

- On connection: set headers `Content-Type: text/event-stream; Cache-Control: no-cache; Connection: keep-alive; X-Accel-Buffering: no`.
- Emit heartbeat `:ping\n\n` every 25s (nginx default timeout is 60s).
- Rate limit: 1 open SSE per admin session per 60s. On student side: 3 opens per customerId per 60s (accommodates multiple tabs).
- On `req.on('close')`: remove from set.
- Process restart drops all streams; clients reconnect automatically (native EventSource).

### Nginx

`proxy_buffering off;` on the `/api/chat/stream` and `/api/admin/qa/stream` locations. Already probably set globally but verify.

### Payload size

Keep each event payload under 8 KB. Attachments never inlined — only metadata + signed URL that expires 1h.

## 7. Attachment pipeline

### Upload

```
1. Client POST /api/chat/attachments (multipart/form-data, one file).
2. Server: multer memory storage (max 10 MB).
3. Validate MIME against allowlist. For audio, decode duration via ffprobe (optional — if not available, accept but flag).
4. Compute SHA-256 of file body for dedupe (optional — out of scope).
5. Key: qa/<YYYY>/<MM>/<DD>/<uuid>-<sanitized-filename>.
6. Upload to R2 via PutObjectCommand (ACL: private).
7. Return { uploadId: <signed JWT 1h TTL>, previewUrl: <signed GET URL 1h TTL> }.
```

### Attach to message

```
1. Client POST /api/chat/threads/:id/messages with body + attachments: [<uploadId>].
2. Server verifies each uploadId JWT, extracts r2Key.
3. INSERT nb_qa_attachments rows with message_id.
4. DELETE the "pending" marker (optional — see garbage-collect).
```

### Garbage collect

Nightly cron: find R2 keys under `qa/…` that have no matching `nb_qa_attachments.r2_key` row → delete from R2. Keeps orphan uploads from accruing. Implementation: new script `scripts/gc-qa-attachments.js`, invoked via `node scripts/gc-qa-attachments.js --dry-run|--live`.

## 8. Magic deep-link security

Token lifecycle:

1. `POST /api/admin/qa/:id/deep-link` — generates `raw = crypto.randomBytes(32).toString('hex')`, stores `sha256(raw)` + metadata.
2. Email includes `https://namibarden.com/admin/link-thread?token=<raw>`.
3. GET endpoint:
   - SELECT ... WHERE token_hash = sha256($token) AND consumed_at IS NULL AND expires_at > NOW().
   - If not found → log attempt, 302 → /admin/ with `?error=invalid_link`.
   - If found → UPDATE consumed_at=NOW(), consumed_ip=req.ip, SET admin cookie (24h JWT), 302 → /admin/qa.html?thread=<id>.
4. Rate-limit per thread: reject if token issued in last 30s (prevents email resend abuse).

Token format: 64 hex chars (32 bytes). SHA-256 hash stored (never raw).

## 9. Admin UI changes (`/admin/qa.html`)

Additions:

- **SSE client** — `new EventSource('/api/admin/qa/stream')`. On `message-added`: re-fetch thread list if visible, increment unread badge. On `thread-created`: prepend. On reconnect-after-disconnect: fetch last-10-min delta.
- **DM Nami filter** — add a filter chip `[DM][Course][All]`. Default All.
- **Attachment UI on reply** — drag-drop zone + file input. Previews in the compose pane. Max 5 files per message. Each file hits `POST /api/chat/attachments` for staging, returned `uploadId` sent with final POST.
- **Attachment display in thread view** — inline images with max-height 300px, PDF/audio as download chips.
- **Typing indicator** — skip for Phase 3; nice to add but requires two-way RTC; defer.

All HTML rendered via `textContent` / safe DOM; no `innerHTML` for message bodies or attachment filenames.

## 10. Student UI changes

Two contexts:

### Inside watch page (`/watch?token=...`)

Already has Q&A per lesson (student side of `course-engagement.js`). Extend to:
- New "Messages" tab next to lesson list — lists all threads (DM + course) for this student's `access_token`.
- SSE client for student's threads — auto-append Nami's replies.

### Standalone `/messages` page (new)

For customers without a course (or as a general-purpose entry):
- Requires customer auth (login OR magic link).
- Shows all threads for `req.customer.id` (by customer_id match OR access_token match across owned courses).
- Same SSE + send/attach UI as the watch-page embedded view.
- Entry link from account dropdown in the site header.

## 11. Files to change

### NamiBarden

| File | Change |
|---|---|
| `schema.sql` | Add channel column + constraints + attachments table + link-tokens table at bottom |
| `migrations/003_chat_sse_attachments.sql` (new) | Same DDL, idempotent |
| `chat-routes.js` (new) | Home for /api/chat/* endpoints + SSE emit helpers |
| `course-engagement.js` | Hook new message paths into SSE emit helpers; keep back-compat with existing POST /api/courses/questions routes (which now also emit SSE) |
| `admin-routes.js` | New /api/admin/qa/stream + /api/admin/qa/:id/deep-link + /api/admin/link-thread |
| `customer-auth.js` | No change — existing /api/auth/* still handles customer login |
| `server.js` | Mount chat-routes, wire transporter/r2/pool dependencies |
| `app-config.js` | If new env var `NAMI_ALERT_EMAIL` needed (replaces 4 hardcoded 'namibarden@gmail.com'); default to `namibarden@gmail.com` |
| `nginx.conf` | Explicit `proxy_buffering off;` on `/api/chat/stream` and `/api/admin/qa/stream` locations |
| `public/watch.html` | Add Messages tab + SSE client JS |
| `public/messages.html` (new) | Standalone DM page |
| `admin/qa.html` | Add DM filter, SSE client, attachment UI |
| `scripts/gc-qa-attachments.js` (new) | Orphan R2 cleanup |
| `Dockerfile` | Add `chat-routes.js` to COPY; add `scripts/gc-qa-attachments.js` already covered by scripts/ copy from Phase 1 fix |

## 12. Test plan

### Unit / local
1. POST DM creates thread with channel='dm', course_id=null. CHECK constraint passes.
2. POST DM with course_id set AND channel='dm' → DB rejects.
3. Attachment upload with MIME `image/png` 4 MB → accepted.
4. Attachment upload with `application/zip` → rejected (415).
5. Attachment upload 12 MB image → rejected (413).
6. Deep-link token: issue, GET → admin cookie set, consumed_at set. Second GET with same token → fail (consumed).
7. Deep-link rate limit: issue 2× within 30s → second 429.
8. SSE admin stream: open + POST student message → event emitted.
9. SSE debounce: two student messages to same thread within 10 sec of Nami reply → only 0 emails sent.
10. Completion % regression (carry-over from Phase 2): still passes.

### E2E
11. Chrome: login as customer, send DM Nami message with image, verify preview in thread, verify email sent to namibarden@gmail.com with deep-link.
12. Click deep-link from a fresh browser (no admin cookie) → lands in /admin/qa.html?thread=<id> logged in.
13. Admin replies with an attached PDF → student page receives SSE event, renders message live.
14. Open deep-link twice → second click shows "link already used" error and redirects to /admin.

## 13. Risks

- **SSE scale** — single-process Express, Map-based in-memory client sets. Won't survive multiple replicas. Current deployment is single-container → fine. If we horizontally scale later: add Redis pub/sub.
- **R2 orphan accrual** — garbage-collect cron is the mitigation. Until deployed: small leak.
- **Reply-by-email** — Nami might reply from Gmail expecting it to thread back. For Phase 3, that goes to the student's email only (no DB thread update). Document in the email footer.
- **Deep-link email forwarded** — 15 min TTL + one-time use mitigates; still, Nami should treat these as bearer tokens.
- **SSE long connections vs nginx idle timeout** — `proxy_read_timeout 3600;` on the stream locations as a safety net.

## 14. Open questions for consensus

1. Should the DM-Nami general channel allow multiple concurrent threads per customer (like Slack DMs with multiple topics), or should we coalesce to one-thread-per-customer?
2. Attachment max size: 5 MB image, 10 MB PDF / audio — too restrictive? Gil may want 20+ MB for audio voice notes.
3. Deep-link: one-time vs reusable-within-TTL? Current spec: one-time. Reusable makes email forwarding safer but still bearer-risky.
4. Should student SSE stream be keyed by `customer_id` (excludes guest access-token threads) or by `access_token` (covers both)? Spec says both. Codex to sanity-check the implementation complexity.
5. Reply-by-email inbound processing: worth planning for Phase 3.5, or is pure "click-to-open-thread" enough forever?
