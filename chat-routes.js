const crypto = require('crypto');
const path = require('path');

const MAX_BODY_LENGTH = 4000;
const MAX_ATTACHMENTS_PER_MESSAGE = 5;
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
const SIZE_LIMITS = {
  image: 10 * 1024 * 1024,
  pdf: 15 * 1024 * 1024,
  audio: 25 * 1024 * 1024
};

function toInt(value) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function normalizeBaseUrl(siteUrl) {
  return (siteUrl || 'https://namibarden.com').replace(/\/+$/, '');
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeFilename(filename) {
  const parsed = path.parse(filename || 'attachment');
  const base = (parsed.name || 'attachment')
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'attachment';
  const ext = (parsed.ext || '').toLowerCase().replace(/[^\w.]/g, '').slice(0, 16);
  return `${base}${ext}`;
}

// Bounded per-client write: drops the client if its write buffer exceeds the cap,
// preventing unbounded memory growth when a slow reader can't keep up.
const SSE_CLIENT_BUFFER_CAP = 256 * 1024; // 256 KB

function sseWrite(res, eventName, payload, id) {
  if (!res || res.destroyed || res.writableEnded) return false;
  // Drop the connection if the kernel/client buffer is already too backed up.
  if (typeof res.writableLength === 'number' && res.writableLength > SSE_CLIENT_BUFFER_CAP) {
    try { res.destroy(new Error('SSE backpressure cap exceeded')); } catch {}
    return false;
  }
  try {
    if (id != null) res.write(`id: ${id}\n`);
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch (err) {
    try { res.destroy(err); } catch {}
    return false;
  }
  return true;
}

function mapMessageRow(row) {
  const attachmentCount = Number(row.attachment_count) || 0;
  const messageId = Number(row.id);
  return {
    id: messageId,
    messageId,
    threadId: Number(row.thread_id),
    body: row.body || '',
    sender: row.sender,
    senderRole: row.sender,
    createdAt: row.created_at,
    hasAttachments: attachmentCount > 0,
    attachmentCount,
    channel: row.channel || 'course'
  };
}

function mapAttachment(row) {
  return {
    id: Number(row.id),
    detectedMime: row.detected_mime,
    sizeBytes: Number(row.size_bytes) || 0,
    durationSeconds: row.duration_seconds == null ? null : Number(row.duration_seconds),
    originalFilename: row.original_filename || null,
    viewUrl: `/api/chat/attachments/${row.id}/view`
  };
}

function createChatAuthHelpers({ jwt, jwtSecret }) {
  function getBearer(req) {
    return req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
  }

  function verifyCustomer(req) {
    const token = req.cookies?.nb_auth_token || getBearer(req);
    if (!token) return null;
    try {
      const decoded = jwt.verify(token, jwtSecret);
      if (decoded.role !== 'customer' || !decoded.customerId) return null;
      return decoded;
    } catch {
      return null;
    }
  }

  function verifyFullAdmin(req) {
    const token = req.cookies?.nb_admin_token || getBearer(req);
    if (!token) return null;
    try {
      const decoded = jwt.verify(token, jwtSecret);
      if (decoded.role !== 'admin' || decoded.scope) return null;
      return decoded;
    } catch {
      return null;
    }
  }

  function verifyThreadAdmin(req, threadId) {
    const id = toInt(threadId);
    if (!id) return null;
    const token = req.cookies?.[`nb_thread_admin_${id}`];
    if (!token) return null;
    try {
      const decoded = jwt.verify(token, jwtSecret, { audience: `thread-admin:${id}` });
      if (decoded.role !== 'admin' || decoded.scope !== 'thread-admin' || Number(decoded.threadId) !== id) {
        return null;
      }
      return decoded;
    } catch {
      return null;
    }
  }

  function verifyAnyThreadAdmin(req) {
    const cookies = req.cookies || {};
    for (const name of Object.keys(cookies)) {
      const match = name.match(/^nb_thread_admin_(\d+)$/);
      if (!match) continue;
      const decoded = verifyThreadAdmin(req, Number(match[1]));
      if (decoded) return decoded;
    }
    return null;
  }

  return {
    verifyCustomer,
    verifyFullAdmin,
    verifyThreadAdmin,
    verifyAnyThreadAdmin
  };
}

function createChatSseHub({ pool, logger }) {
  const adminClients = new Set();
  const studentClients = new Set();
  const activeStudentStreams = new Map();

  function incrementStream(key) {
    const current = activeStudentStreams.get(key) || 0;
    if (current >= 3) return false;
    activeStudentStreams.set(key, current + 1);
    return true;
  }

  function decrementStream(key) {
    const current = activeStudentStreams.get(key) || 0;
    if (current <= 1) activeStudentStreams.delete(key);
    else activeStudentStreams.set(key, current - 1);
  }

  function setupStream(req, res) {
    res.status(200);
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders?.();
    try { res.write(':ok\n\n'); } catch { return () => {}; }

    const heartbeat = setInterval(() => {
      if (res.destroyed || res.writableEnded) return;
      if (typeof res.writableLength === 'number' && res.writableLength > SSE_CLIENT_BUFFER_CAP) {
        try { res.destroy(new Error('SSE heartbeat buffer cap exceeded')); } catch {}
        return;
      }
      try { res.write(':heartbeat\n\n'); } catch (err) {
        try { res.destroy(err); } catch {}
      }
    }, 20000);
    heartbeat.unref?.();

    const cleanup = () => clearInterval(heartbeat);
    req.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
    req.on('error', cleanup);
    return cleanup;
  }

  async function replayAdmin(res, sinceId) {
    if (!sinceId) return;
    const rows = (await pool.query(
      `SELECT m.id, m.thread_id, m.sender, m.body, m.created_at, t.channel,
              COUNT(a.id) AS attachment_count
       FROM nb_qa_messages m
       JOIN nb_qa_threads t ON t.id = m.thread_id
       LEFT JOIN nb_qa_attachments a ON a.message_id = m.id
       WHERE m.id > $1
       GROUP BY m.id, t.channel
       ORDER BY m.id ASC
       LIMIT 101`,
      [sinceId]
    )).rows;
    if (rows.length > 100) {
      sseWrite(res, 'resync-required', { reason: 'too_many_events' });
      return;
    }
    for (const row of rows) {
      const payload = mapMessageRow(row);
      sseWrite(res, 'message', payload, payload.id);
    }
  }

  async function replayStudent(res, identity, sinceId) {
    if (!sinceId) return;
    const params = [sinceId];
    let where;
    if (identity.kind === 'customer') {
      params.push(identity.customerId, identity.accessTokens);
      where = `(t.customer_id = $2 OR t.access_token = ANY($3::varchar[]))`;
    } else {
      params.push(identity.accessTokens);
      where = `t.access_token = ANY($2::varchar[])`;
    }

    const rows = (await pool.query(
      `SELECT m.id, m.thread_id, m.sender, m.body, m.created_at, t.channel,
              COUNT(a.id) AS attachment_count
       FROM nb_qa_messages m
       JOIN nb_qa_threads t ON t.id = m.thread_id
       LEFT JOIN nb_qa_attachments a ON a.message_id = m.id
       WHERE m.id > $1 AND ${where}
       GROUP BY m.id, t.channel
       ORDER BY m.id ASC
       LIMIT 101`,
      params
    )).rows;
    if (rows.length > 100) {
      sseWrite(res, 'resync-required', { reason: 'too_many_events' });
      return;
    }
    for (const row of rows) {
      const payload = mapMessageRow(row);
      sseWrite(res, 'message', payload, payload.id);
    }
  }

  async function openAdminStream(req, res) {
    setupStream(req, res);
    const client = { res };
    adminClients.add(client);
    req.on('close', () => adminClients.delete(client));
    try {
      await replayAdmin(res, toInt(req.headers['last-event-id'] || req.query.since));
    } catch (err) {
      logger.error({ err }, 'Admin SSE replay failed');
      sseWrite(res, 'error', { error: 'replay_failed' });
    }
  }

  async function openStudentStream(req, res, identity) {
    if (!incrementStream(identity.streamKey)) {
      return res.status(429).json({ error: 'Too many streams' });
    }
    setupStream(req, res);
    const client = { res, identity };
    studentClients.add(client);
    req.on('close', () => {
      studentClients.delete(client);
      decrementStream(identity.streamKey);
    });
    try {
      await replayStudent(res, identity, toInt(req.headers['last-event-id'] || req.query.since));
    } catch (err) {
      logger.error({ err }, 'Student SSE replay failed');
      sseWrite(res, 'error', { error: 'replay_failed' });
    }
  }

  function studentCanSee(identity, message) {
    if (identity.kind === 'customer') {
      if (Number(message.customerId) === Number(identity.customerId)) return true;
      return !!message.accessToken && identity.accessTokens.includes(message.accessToken);
    }
    return !!message.accessToken && identity.accessTokens.includes(message.accessToken);
  }

  function emitMessage(message) {
    const id = Number(message.id || message.messageId);
    const payload = {
      id,
      messageId: id,
      threadId: Number(message.threadId),
      body: message.body || '',
      sender: message.sender,
      senderRole: message.sender,
      createdAt: message.createdAt,
      hasAttachments: !!message.hasAttachments,
      attachmentCount: Number(message.attachmentCount) || 0,
      channel: message.channel || 'course'
    };

    for (const client of adminClients) {
      if (!client.res.destroyed) sseWrite(client.res, 'message', payload, id);
    }
    for (const client of studentClients) {
      if (!client.res.destroyed && studentCanSee(client.identity, message)) {
        sseWrite(client.res, 'message', payload, id);
      }
    }
  }

  function emitAdminEvent(eventName, payload = {}) {
    const id = payload.id || payload.messageId || null;
    for (const client of adminClients) {
      if (!client.res.destroyed) sseWrite(client.res, eventName, payload, id);
    }
  }

  return {
    openAdminStream,
    openStudentStream,
    emitMessage,
    emitAdminEvent
  };
}

function createChatRoutes({
  app,
  pool,
  logger,
  jwt,
  jwtSecret,
  rateLimit,
  getIP,
  multer,
  r2,
  r2Bucket,
  PutObjectCommand,
  GetObjectCommand,
  getSignedUrl,
  transporter,
  smtpFrom,
  siteUrl,
  namiAlertEmail,
  courses,
  getCourseAccessRowsForToken,
  fileTypeFromBuffer,
  chatEvents,
  chatAuth
}) {
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES } }).single('file');
  const auth = chatAuth || createChatAuthHelpers({ jwt, jwtSecret });
  const baseUrl = normalizeBaseUrl(siteUrl);

  async function resolveCustomerIdentity(req) {
    const decoded = auth.verifyCustomer(req);
    if (!decoded) return null;
    const customer = (await pool.query(
      `SELECT id, email, name FROM nb_customers WHERE id = $1`,
      [decoded.customerId]
    )).rows[0];
    if (!customer) return null;
    const accessTokens = (await pool.query(
      `SELECT access_token FROM nb_course_access
       WHERE customer_id = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
      [decoded.customerId]
    )).rows.map((row) => row.access_token);
    return {
      kind: 'customer',
      role: 'student',
      customerId: Number(customer.id),
      email: customer.email,
      name: customer.name,
      accessTokens,
      streamKey: `customer:${customer.id}`,
      uploadId: `customer:${customer.id}`
    };
  }

  async function resolveTokenIdentity(rawToken) {
    if (!rawToken || !getCourseAccessRowsForToken) return null;
    const rows = await getCourseAccessRowsForToken(rawToken);
    if (!rows.length) return null;
    const first = rows[0];
    const accessTokens = Array.from(new Set(rows.map((row) => row.access_token)));
    const impersonated = !accessTokens.includes(rawToken);
    return {
      kind: 'token',
      role: 'student',
      accessToken: first.access_token,
      accessTokens,
      email: first.email,
      customerId: first.customer_id ? Number(first.customer_id) : null,
      impersonated,
      streamKey: `token:${sha256Hex(accessTokens.join('|'))}`,
      uploadId: `token:${sha256Hex(first.access_token)}`
    };
  }

  function resolveAdminIdentity(req, threadId = null) {
    const full = auth.verifyFullAdmin(req);
    if (full) {
      return { kind: 'admin', role: 'nami', full: true, uploadId: 'admin' };
    }
    if (threadId) {
      const scoped = auth.verifyThreadAdmin(req, threadId);
      if (scoped) {
        return { kind: 'admin', role: 'nami', full: false, threadId: Number(threadId), uploadId: `thread:${threadId}` };
      }
    }
    const anyScoped = auth.verifyAnyThreadAdmin(req);
    if (anyScoped) {
      return { kind: 'admin', role: 'nami', full: false, threadId: Number(anyScoped.threadId), uploadId: `thread:${anyScoped.threadId}` };
    }
    return null;
  }

  async function resolveAnyIdentity(req, options = {}) {
    if (options.allowAdmin) {
      const admin = resolveAdminIdentity(req, options.threadId);
      if (admin) return admin;
    }
    const customer = await resolveCustomerIdentity(req);
    if (customer) return customer;
    const tokenIdentity = await resolveTokenIdentity(req.query.token || req.body?.token);
    if (tokenIdentity) return tokenIdentity;
    return null;
  }

  async function loadAuthorizedThread(db, threadId, identity, lock = false) {
    const suffix = lock ? ' FOR UPDATE' : '';
    if (identity.kind === 'admin') {
      if (!identity.full && Number(identity.threadId) !== Number(threadId)) return null;
      return (await db.query(`SELECT * FROM nb_qa_threads WHERE id = $1${suffix}`, [threadId])).rows[0] || null;
    }
    if (identity.kind === 'customer') {
      return (await db.query(
        `SELECT * FROM nb_qa_threads
         WHERE id = $1 AND (customer_id = $2 OR access_token = ANY($3::varchar[]))${suffix}`,
        [threadId, identity.customerId, identity.accessTokens]
      )).rows[0] || null;
    }
    return (await db.query(
      `SELECT * FROM nb_qa_threads
       WHERE id = $1 AND channel = 'course' AND access_token = ANY($2::varchar[])${suffix}`,
      [threadId, identity.accessTokens]
    )).rows[0] || null;
  }

  async function getMessages(threadId, sinceId = 0) {
    const messages = (await pool.query(
      `SELECT id, sender, body, created_at
       FROM nb_qa_messages
       WHERE thread_id = $1 AND id > $2
       ORDER BY created_at ASC, id ASC`,
      [threadId, sinceId]
    )).rows;
    if (!messages.length) return [];
    const ids = messages.map((row) => row.id);
    const attachments = (await pool.query(
      `SELECT id, message_id, detected_mime, size_bytes, duration_seconds, original_filename
       FROM nb_qa_attachments
       WHERE message_id = ANY($1::int[])
       ORDER BY id ASC`,
      [ids]
    )).rows;
    const byMessage = new Map();
    for (const row of attachments) {
      if (!byMessage.has(row.message_id)) byMessage.set(row.message_id, []);
      byMessage.get(row.message_id).push(mapAttachment(row));
    }
    return messages.map((row) => ({
      id: Number(row.id),
      sender: row.sender,
      body: row.body || '',
      created_at: row.created_at,
      createdAt: row.created_at,
      attachments: byMessage.get(row.id) || []
    }));
  }

  function validateBodyAndAttachments(body, attachments) {
    const trimmed = (body || '').trim();
    if (trimmed.length > MAX_BODY_LENGTH) {
      const err = new Error('Message too long');
      err.statusCode = 400;
      throw err;
    }
    if (!Array.isArray(attachments)) {
      const err = new Error('Attachments must be an array');
      err.statusCode = 400;
      throw err;
    }
    if (attachments.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      const err = new Error('Maximum 5 attachments per message');
      err.statusCode = 400;
      throw err;
    }
    if (!trimmed && attachments.length === 0) {
      const err = new Error('Message or attachment required');
      err.statusCode = 400;
      throw err;
    }
    return trimmed;
  }

  function verifyUploadToken(uploadId) {
    try {
      const decoded = jwt.verify(uploadId, jwtSecret, { audience: 'chat-upload' });
      if (decoded.kind !== 'upload' || !decoded.r2Key || !decoded.mime || !decoded.sha256 || !decoded.uploader) {
        return null;
      }
      return decoded;
    } catch {
      return null;
    }
  }

  function expectedUploaderIds(identity, threadId) {
    if (identity.kind === 'admin') {
      return new Set(['admin', `thread:${threadId}`]);
    }
    return new Set([identity.uploadId]);
  }

  async function claimAttachments(client, uploadIds, identity, threadId, messageId, sender) {
    if (uploadIds.length === 0) return [];
    const claims = uploadIds.map(verifyUploadToken);
    if (claims.some((claim) => !claim)) {
      const err = new Error('Invalid attachment token');
      err.statusCode = 400;
      throw err;
    }
    const expected = expectedUploaderIds(identity, threadId);
    for (const claim of claims) {
      if (claim.uploader.role !== sender || !expected.has(claim.uploader.id)) {
        const err = new Error('Attachment does not belong to this uploader');
        err.statusCode = 403;
        throw err;
      }
    }

    const r2Keys = claims.map((claim) => claim.r2Key);
    const pending = (await client.query(
      `DELETE FROM nb_qa_pending_attachments
       WHERE r2_key = ANY($1::varchar[])
         AND uploader = $2
         AND expires_at > NOW()
       RETURNING r2_key, detected_mime, size_bytes, sha256, original_filename`,
      [r2Keys, sender]
    )).rows;
    if (pending.length !== claims.length) {
      const err = new Error('Attachment expired or already used');
      err.statusCode = 400;
      throw err;
    }

    const byKey = new Map(pending.map((row) => [row.r2_key, row]));
    const inserted = [];
    for (const claim of claims) {
      const row = byKey.get(claim.r2Key);
      if (!row || row.detected_mime !== claim.mime || row.sha256 !== claim.sha256) {
        const err = new Error('Attachment verification failed');
        err.statusCode = 400;
        throw err;
      }
      const result = await client.query(
        `INSERT INTO nb_qa_attachments
           (message_id, thread_id, uploader, r2_key, detected_mime, size_bytes, sha256, original_filename)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, detected_mime, size_bytes, duration_seconds, original_filename`,
        [messageId, threadId, sender, row.r2_key, row.detected_mime, row.size_bytes, row.sha256, row.original_filename]
      );
      inserted.push(mapAttachment(result.rows[0]));
    }
    return inserted;
  }

  async function insertMessageWithTransaction({ threadId, identity, body, uploadIds, forceNewDm = false }) {
    const sender = identity.kind === 'admin' ? 'nami' : 'student';
    if (sender === 'student' && identity.impersonated) {
      const err = new Error('Admin impersonation is read-only');
      err.statusCode = 403;
      throw err;
    }
    const client = await pool.connect();
    let committed = false;
    let thread;
    let messageId;
    let createdAt;
    let attachments = [];
    try {
      await client.query('BEGIN');

      if (forceNewDm) {
        let dm = (await client.query(
          `SELECT * FROM nb_qa_threads WHERE customer_id = $1 AND channel = 'dm' FOR UPDATE`,
          [identity.customerId]
        )).rows[0];
        if (!dm) {
          const inserted = await client.query(
            `INSERT INTO nb_qa_threads
               (access_token, customer_id, email, name, course_id, lesson_id, subject, channel, status,
                unread_for_admin, unread_for_student, last_message_at)
             VALUES (NULL, $1, $2, $3, NULL, NULL, 'DM with Nami', 'dm', 'open', TRUE, FALSE, NOW())
             ON CONFLICT DO NOTHING
             RETURNING *`,
            [identity.customerId, identity.email, identity.name || null]
          );
          dm = inserted.rows[0] || (await client.query(
            `SELECT * FROM nb_qa_threads WHERE customer_id = $1 AND channel = 'dm' FOR UPDATE`,
            [identity.customerId]
          )).rows[0];
        }
        thread = dm;
        threadId = thread.id;
      } else {
        thread = await loadAuthorizedThread(client, threadId, identity, true);
      }

      if (!thread) {
        const err = new Error('Thread not found');
        err.statusCode = 404;
        throw err;
      }

      const msg = (await client.query(
        `INSERT INTO nb_qa_messages (thread_id, sender, body)
         VALUES ($1, $2, $3)
         RETURNING id, created_at`,
        [thread.id, sender, body || '']
      )).rows[0];
      messageId = Number(msg.id);
      createdAt = msg.created_at;

      attachments = await claimAttachments(client, uploadIds, identity, thread.id, messageId, sender);

      if (sender === 'nami') {
        await client.query(
          `UPDATE nb_qa_threads
           SET status = 'answered', unread_for_student = TRUE, last_message_at = NOW()
           WHERE id = $1`,
          [thread.id]
        );
      } else {
        await client.query(
          `UPDATE nb_qa_threads
           SET status = 'open', unread_for_admin = TRUE, last_message_at = NOW()
           WHERE id = $1`,
          [thread.id]
        );
      }

      await client.query('COMMIT');
      committed = true;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    if (committed) {
      const payload = {
        id: messageId,
        messageId,
        threadId: Number(thread.id),
        body: body || '',
        sender,
        createdAt,
        hasAttachments: attachments.length > 0,
        attachmentCount: attachments.length,
        customerId: thread.customer_id,
        accessToken: thread.access_token,
        channel: thread.channel || 'course'
      };
      chatEvents.emitMessage(payload);
      chatEvents.emitAdminEvent('thread-updated', {
        threadId: Number(thread.id),
        messageId,
        channel: thread.channel || 'course',
        unreadForAdmin: sender === 'student'
      });
      if (attachments.length > 0) {
        chatEvents.emitAdminEvent('attachment-committed', {
          threadId: Number(thread.id),
          messageId,
          attachmentCount: attachments.length
        });
      }
      if (sender === 'student') {
        maybeSendNamiAlertEmail({
          threadId: Number(thread.id),
          messageId,
          body,
          attachmentCount: attachments.length
        }).catch((err) => logger.error({ err, threadId: thread.id }, 'Nami alert email failed'));
      }
    }

    return { thread, messageId, createdAt, attachments };
  }

  async function detectAllowedMime(buffer, declaredMime) {
    const textHead = buffer.subarray(0, Math.min(buffer.length, 4096)).toString('utf8').replace(/^\uFEFF/, '').toLowerCase();
    if (/<!doctype\s+html|<html[\s>]|<svg[\s>]|<script[\s>]/.test(textHead)) {
      const err = new Error('SVG and HTML attachments are not allowed');
      err.statusCode = 400;
      throw err;
    }
    const detected = await fileTypeFromBuffer(buffer.subarray(0, Math.min(buffer.length, 4100)));
    const mime = detected?.mime;
    if (!mime || mime === 'image/svg+xml' || mime === 'text/html' || mime === 'application/xhtml+xml') {
      const err = new Error('Unsupported or unsafe file type');
      err.statusCode = 400;
      throw err;
    }
    const kind = mime === 'application/pdf' ? 'pdf' : mime.startsWith('image/') ? 'image' : mime.startsWith('audio/') ? 'audio' : null;
    if (!kind) {
      const err = new Error('Unsupported file type');
      err.statusCode = 400;
      throw err;
    }
    if (buffer.length > SIZE_LIMITS[kind]) {
      const err = new Error(`${kind} attachment is too large`);
      err.statusCode = 400;
      throw err;
    }
    return {
      detectedMime: mime,
      declaredMime: declaredMime || null,
      kind
    };
  }

  async function issueThreadLinkToken(threadId, reason) {
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = sha256Hex(token);
    const result = await pool.query(
      `INSERT INTO nb_admin_thread_link_tokens (token_hash, thread_id, expires_at, created_reason)
       VALUES ($1, $2, NOW() + INTERVAL '15 minutes', $3)
       RETURNING expires_at`,
      [tokenHash, threadId, reason || null]
    );
    return {
      token,
      url: `${baseUrl}/api/admin/link-thread?token=${token}`,
      expiresAt: result.rows[0].expires_at
    };
  }

  async function maybeSendNamiAlertEmail({ threadId, body, attachmentCount }) {
    if (!transporter || !smtpFrom || !namiAlertEmail) return;
    // Conditional stamp — only proceed if the debounce window is clear.
    // CRITICAL: mark as provisionally notified inside the same atomic update so concurrent
    // student messages don't both trigger an email, but clear the stamp on send failure
    // so a retry can go out instead of burning the full 15-minute window.
    const gate = (await pool.query(
      `UPDATE nb_qa_threads
       SET last_admin_notified_at = NOW()
       WHERE id = $1
         AND (last_admin_notified_at IS NULL OR last_admin_notified_at < NOW() - INTERVAL '15 minutes')
       RETURNING id, email, name, subject, channel, course_id, lesson_id, last_admin_notified_at`,
      [threadId]
    )).rows[0];
    if (!gate) return;

    const course = courses?.[gate.course_id];
    const lesson = course?.lessons?.find((item) => item.id === gate.lesson_id);
    const channelLabel = gate.channel === 'dm' ? 'DM' : 'Course';
    const contextLine = gate.channel === 'dm'
      ? 'Direct message / ダイレクトメッセージ'
      : [course?.name, lesson?.title].filter(Boolean).join(' - ') || 'Course thread / コース質問';
    const link = await issueThreadLinkToken(threadId, 'student-message-alert');
    const preview = (body || '').slice(0, 400);
    const attachmentText = attachmentCount > 0
      ? `${attachmentCount} attachment${attachmentCount > 1 ? 's' : ''} / 添付 ${attachmentCount}件`
      : 'No attachments / 添付なし';

    try {
      await transporter.sendMail({
      from: smtpFrom,
      to: namiAlertEmail,
      replyTo: gate.email || undefined,
      subject: `[${channelLabel}] ${gate.subject || 'New student message'}`,
      html: `<div style="font-family:Georgia,'Times New Roman',serif;background:#f6f0e8;padding:28px;color:#352c26">
        <div style="max-width:640px;margin:0 auto;background:#fffdf8;border:1px solid #eadfce;border-radius:18px;padding:30px 28px">
          <p style="font:600 12px/1.2 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;letter-spacing:0.14em;text-transform:uppercase;color:#8d6f4f;margin:0 0 10px">NamiBarden Chat</p>
          <h1 style="font-size:26px;font-weight:400;margin:0 0 16px;color:#352c26">New message from ${escapeHtml(gate.name || gate.email || 'student')}</h1>
          <p style="font:400 14px/1.8 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#5f5348;margin:0 0 8px">EN: A student sent a new ${escapeHtml(channelLabel)} message.</p>
          <p style="font:400 14px/1.8 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#5f5348;margin:0 0 18px">JP: 生徒さんから新しい${gate.channel === 'dm' ? 'DM' : 'コース質問'}が届きました。</p>
          <div style="border:1px solid #eadfce;border-radius:14px;background:#fcf7f1;padding:16px 18px;margin:0 0 18px">
            <p style="font:600 13px/1.7 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#4c4035;margin:0 0 8px">${escapeHtml(contextLine)}</p>
            <p style="font:400 13px/1.7 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#7a6d60;margin:0 0 10px">${escapeHtml(gate.email || '')}</p>
            <p style="font:400 15px/1.8 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#352c26;white-space:pre-wrap;margin:0">${escapeHtml(preview)}</p>
            <p style="font:600 12px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#8d6f4f;margin:14px 0 0">${escapeHtml(attachmentText)}</p>
          </div>
          <p style="margin:0 0 18px">
            <a href="${link.url}" style="display:inline-block;background:#352c26;color:#fff;text-decoration:none;padding:12px 18px;border-radius:10px;font:600 14px/1.2 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">Open thread / スレッドを開く</a>
          </p>
          <p style="font:400 13px/1.8 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#7a6d60;margin:0">
            EN: Replying to this email goes to the student's inbox only and is not stored. Use Open thread to send and track your reply.<br>
            JP: このメールに直接返信すると生徒さんの受信箱にのみ届き、スレッドには保存されません。返信と記録には「スレッドを開く」を使ってください。
          </p>
        </div>
      </div>`
    });
    } catch (err) {
      // Send failed — roll back the debounce stamp so a retry path can send later.
      logger.error({ err, threadId }, 'Nami alert email failed; reverting debounce stamp');
      await pool.query(
        `UPDATE nb_qa_threads SET last_admin_notified_at = NULL WHERE id = $1 AND last_admin_notified_at = $2`,
        [threadId, gate.last_admin_notified_at]
      ).catch((revertErr) => logger.error({ err: revertErr, threadId }, 'Failed to revert debounce stamp'));
    }
  }

  async function authorizeAttachmentRead(req, attachmentThreadId = null) {
    const identity = await resolveAnyIdentity(req, { allowAdmin: true, threadId: attachmentThreadId });
    if (!identity) return null;
    if (!attachmentThreadId) return identity;
    const thread = await loadAuthorizedThread(pool, attachmentThreadId, identity, false);
    return thread ? identity : null;
  }

  app.post('/api/chat/dm', async (req, res) => {
    try {
      const identity = await resolveCustomerIdentity(req);
      if (!identity) return res.status(401).json({ error: 'Login required' });
      const ip = getIP(req);
      const existingDm = (await pool.query(
        `SELECT id FROM nb_qa_threads WHERE customer_id = $1 AND channel = 'dm' LIMIT 1`,
        [identity.customerId]
      )).rows[0];
      if (!existingDm && !rateLimit(`chat-dm-create-ip:${ip}`, 10, 3600000)) {
        return res.status(429).json({ error: 'Too many requests' });
      }
      if (!rateLimit(`chat-dm-customer:${identity.customerId}`, 60, 3600000)) {
        return res.status(429).json({ error: 'Too many messages' });
      }
      if (!rateLimit(`chat-dm-ip:${ip}`, 200, 86400000)) {
        return res.status(429).json({ error: 'Too many messages' });
      }
      const attachments = req.body?.attachments || [];
      const trimmed = validateBodyAndAttachments(req.body?.body, attachments);
      const result = await insertMessageWithTransaction({
        threadId: null,
        identity,
        body: trimmed,
        uploadIds: attachments,
        forceNewDm: true
      });
      chatEvents.emitAdminEvent('thread-created', { threadId: Number(result.thread.id), channel: 'dm' });
      res.status(201).json({
        threadId: Number(result.thread.id),
        messageId: result.messageId,
        createdAt: result.createdAt,
        attachments: result.attachments
      });
    } catch (err) {
      logger.error({ err }, 'Chat DM send error');
      res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Server error' });
    }
  });

  app.post('/api/chat/threads/:id/messages', async (req, res) => {
    try {
      const threadId = toInt(req.params.id);
      if (!threadId) return res.status(400).json({ error: 'Invalid thread' });
      const identity = await resolveAnyIdentity(req, { allowAdmin: true, threadId });
      if (!identity) return res.status(401).json({ error: 'Unauthorized' });
      const rateKey = identity.kind === 'customer'
        ? `chat-reply-customer:${identity.customerId}`
        : identity.kind === 'token'
        ? `chat-reply-token:${sha256Hex(identity.accessToken)}`
        : `chat-reply-admin:${threadId}`;
      const max = identity.kind === 'token' ? 30 : 60;
      if (!rateLimit(rateKey, max, 3600000)) return res.status(429).json({ error: 'Too many messages' });

      const attachments = req.body?.attachments || [];
      const trimmed = validateBodyAndAttachments(req.body?.body, attachments);
      const result = await insertMessageWithTransaction({
        threadId,
        identity,
        body: trimmed,
        uploadIds: attachments
      });
      res.status(201).json({
        threadId,
        messageId: result.messageId,
        createdAt: result.createdAt,
        attachments: result.attachments
      });
    } catch (err) {
      logger.error({ err }, 'Chat thread message error');
      res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Server error' });
    }
  });

  app.get('/api/chat/threads', async (req, res) => {
    try {
      const identity = await resolveAnyIdentity(req);
      if (!identity) return res.status(401).json({ error: 'Unauthorized' });
      const params = [];
      let where;
      if (identity.kind === 'customer') {
        params.push(identity.customerId, identity.accessTokens);
        where = `(customer_id = $1 OR access_token = ANY($2::varchar[]))`;
      } else {
        params.push(identity.accessTokens);
        where = `access_token = ANY($1::varchar[])`;
      }
      const rows = (await pool.query(
        `SELECT id, channel, course_id, lesson_id, subject, status, unread_for_student,
                last_message_at, created_at
         FROM nb_qa_threads
         WHERE ${where}
         ORDER BY last_message_at DESC, id DESC
         LIMIT 100`,
        params
      )).rows;
      res.json({
        threads: rows.map((row) => ({
          id: Number(row.id),
          channel: row.channel || 'course',
          courseId: row.course_id,
          lessonId: row.lesson_id,
          subject: row.subject,
          status: row.status,
          unread: row.unread_for_student,
          lastMessageAt: row.last_message_at,
          createdAt: row.created_at
        }))
      });
    } catch (err) {
      logger.error({ err }, 'Chat thread list error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.get('/api/chat/threads/:id', async (req, res) => {
    try {
      const threadId = toInt(req.params.id);
      if (!threadId) return res.status(400).json({ error: 'Invalid thread' });
      const identity = await resolveAnyIdentity(req, { allowAdmin: true, threadId });
      if (!identity) return res.status(401).json({ error: 'Unauthorized' });
      const thread = await loadAuthorizedThread(pool, threadId, identity, false);
      if (!thread) return res.status(404).json({ error: 'Not found' });
      const messages = await getMessages(threadId, toInt(req.query.since));
      if (identity.kind !== 'admin' && !identity.impersonated) {
        await pool.query(`UPDATE nb_qa_threads SET unread_for_student = FALSE WHERE id = $1`, [threadId]);
      }
      res.json({
        thread: {
          id: Number(thread.id),
          channel: thread.channel || 'course',
          courseId: thread.course_id,
          lessonId: thread.lesson_id,
          subject: thread.subject,
          status: thread.status,
          lastMessageAt: thread.last_message_at,
          createdAt: thread.created_at
        },
        messages
      });
    } catch (err) {
      logger.error({ err }, 'Chat thread read error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.get('/api/chat/stream', async (req, res) => {
    try {
      const identity = await resolveAnyIdentity(req);
      if (!identity) return res.status(401).json({ error: 'Unauthorized' });
      if (!rateLimit(`chat-sse-open:${identity.streamKey}`, 120, 3600000)) {
        return res.status(429).json({ error: 'Too many stream reconnects' });
      }
      await chatEvents.openStudentStream(req, res, identity);
    } catch (err) {
      logger.error({ err }, 'Chat SSE open error');
      if (!res.headersSent) res.status(500).json({ error: 'Server error' });
    }
  });

  app.post('/api/chat/attachments', (req, res) => {
    upload(req, res, async (uploadErr) => {
      try {
        if (uploadErr instanceof multer.MulterError) {
          return res.status(400).json({ error: uploadErr.code === 'LIMIT_FILE_SIZE' ? 'File must be 30 MB or smaller' : 'Invalid upload' });
        }
        if (uploadErr) return res.status(400).json({ error: 'Upload failed' });
        if (!r2 || !r2Bucket) return res.status(503).json({ error: 'Attachment storage not configured' });

        const identity = await resolveAnyIdentity(req, { allowAdmin: true });
        if (!identity) return res.status(401).json({ error: 'Unauthorized' });
        const ip = getIP(req);
        if (identity.kind === 'customer') {
          if (!rateLimit(`chat-upload-customer:${identity.customerId}`, 20, 3600000)) {
            return res.status(429).json({ error: 'Too many uploads' });
          }
        } else if (identity.kind === 'token') {
          if (!rateLimit(`chat-upload-token:${sha256Hex(identity.accessToken)}`, 10, 3600000)) {
            return res.status(429).json({ error: 'Too many uploads' });
          }
        }
        if (!rateLimit(`chat-upload-ip:${ip}`, identity.kind === 'token' ? 10 : 60, 3600000)) {
          return res.status(429).json({ error: 'Too many uploads' });
        }
        if (!req.file?.buffer?.length) return res.status(400).json({ error: 'File required' });

        const { detectedMime, declaredMime } = await detectAllowedMime(req.file.buffer, req.file.mimetype);
        const now = new Date();
        const yyyy = String(now.getUTCFullYear());
        const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(now.getUTCDate()).padStart(2, '0');
        const filename = sanitizeFilename(req.file.originalname || 'attachment');
        const key = `qa/${yyyy}/${mm}/${dd}/${crypto.randomUUID()}-${filename}`;
        const digest = crypto.createHash('sha256').update(req.file.buffer).digest('hex');

        await r2.send(new PutObjectCommand({
          Bucket: r2Bucket,
          Key: key,
          Body: req.file.buffer,
          ContentType: detectedMime
        }));

        const sender = identity.kind === 'admin' ? 'nami' : 'student';
        // Thread scope: full admins get NULL (globally viewable by a full
        // admin). Thread-scoped admins get their threadId so the view route
        // can enforce per-thread isolation on pending rows.
        const uploaderThreadId = identity.kind === 'admin' && !identity.full && identity.threadId
          ? Number(identity.threadId)
          : null;
        const pending = (await pool.query(
          `INSERT INTO nb_qa_pending_attachments
             (uploader, uploader_customer_id, uploader_access_token, uploader_thread_id, r2_key, detected_mime,
              declared_mime, size_bytes, sha256, original_filename, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW() + INTERVAL '1 hour')
           RETURNING id`,
          [
            sender,
            identity.kind === 'customer' ? identity.customerId : null,
            identity.kind === 'token' ? identity.accessToken : null,
            uploaderThreadId,
            key,
            detectedMime,
            declaredMime,
            req.file.buffer.length,
            digest,
            req.file.originalname || null
          ]
        )).rows[0];

        const uploadId = jwt.sign(
          {
            kind: 'upload',
            pendingId: Number(pending.id),
            uploader: { role: sender, id: identity.uploadId },
            r2Key: key,
            mime: detectedMime,
            size: req.file.buffer.length,
            sha256: digest,
            expPerMatch: true
          },
          jwtSecret,
          { expiresIn: '1h', audience: 'chat-upload' }
        );

        res.status(201).json({
          uploadId,
          viewUrl: `/api/chat/attachments/${pending.id}/view`,
          previewMime: detectedMime,
          sizeBytes: req.file.buffer.length,
          originalFilename: req.file.originalname || null
        });
      } catch (err) {
        logger.error({ err }, 'Chat attachment upload error');
        res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Server error' });
      }
    });
  });

  app.get('/api/chat/attachments/:id/view', async (req, res) => {
    try {
      if (!r2 || !r2Bucket) return res.status(503).json({ error: 'Attachment storage not configured' });
      const id = toInt(req.params.id);
      if (!id) return res.status(400).json({ error: 'Invalid attachment' });

      const identity = await resolveAnyIdentity(req, { allowAdmin: true });
      if (!identity) return res.status(401).json({ error: 'Unauthorized' });

      const pending = (await pool.query(
        `SELECT id, uploader, uploader_customer_id, uploader_access_token, uploader_thread_id, r2_key
         FROM nb_qa_pending_attachments
         WHERE id = $1 AND expires_at > NOW()`,
        [id]
      )).rows[0];
      if (pending) {
        // A thread-scoped admin cookie may only view its own thread's pending
        // uploads. Full admin covers everything; customer/token routes stay
        // keyed to the original uploader.
        const adminAllowed = identity.kind === 'admin' && pending.uploader === 'nami' && (
          identity.full === true ||
          (pending.uploader_thread_id != null &&
           Number(identity.threadId) === Number(pending.uploader_thread_id))
        );
        const pendingAllowed =
          adminAllowed ||
          (identity.kind === 'customer' && Number(pending.uploader_customer_id) === Number(identity.customerId)) ||
          (identity.kind === 'token' && identity.accessTokens.includes(pending.uploader_access_token));
        if (!pendingAllowed) return res.status(403).json({ error: 'Forbidden' });
        const signedUrl = await getSignedUrl(r2, new GetObjectCommand({ Bucket: r2Bucket, Key: pending.r2_key }), { expiresIn: 300 });
        res.set('Cache-Control', 'private, max-age=240');
        return res.redirect(302, signedUrl);
      }

      const attachment = (await pool.query(
        `SELECT a.id, a.thread_id, a.r2_key
         FROM nb_qa_attachments a
         WHERE a.id = $1`,
        [id]
      )).rows[0];
      if (!attachment) return res.status(404).json({ error: 'Not found' });
      const allowed = await authorizeAttachmentRead(req, attachment.thread_id);
      if (!allowed) return res.status(403).json({ error: 'Forbidden' });
      const signedUrl = await getSignedUrl(r2, new GetObjectCommand({ Bucket: r2Bucket, Key: attachment.r2_key }), { expiresIn: 300 });
      res.set('Cache-Control', 'private, max-age=240');
      res.redirect(302, signedUrl);
    } catch (err) {
      logger.error({ err }, 'Chat attachment view error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  return {
    maybeSendNamiAlertEmail,
    insertMessageWithTransaction,
    issueThreadLinkToken
  };
}

module.exports = {
  createChatRoutes,
  createChatSseHub,
  createChatAuthHelpers,
  sha256Hex
};
