const crypto = require('crypto');

const COMPLETION_THRESHOLD = 0.9; // 90% watched counts as completed
const MAX_QUESTION_LENGTH = 4000;
const MAX_SUBJECT_LENGTH = 200;

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function createCourseEngagement({
  app,
  pool,
  logger,
  authMiddleware,
  transporter,
  smtpFrom,
  siteUrl,
  escapeHtml,
  getIP,
  rateLimit,
  verifyCourseAccess,
  getCourseAccessRowsForToken,
  courses,
  sendWhatsApp,
  namiJid,
  chatEvents,
  chatServices,
  chatAuth
}) {
  // Returns { accessToken, courseId, email, customerId, impersonated } or null.
  // Resolves both raw access_tokens and admin-impersonation JWTs via course-access.js.
  async function resolveAccessForCourse(token, courseId) {
    if (!getCourseAccessRowsForToken) return null;
    const rows = await getCourseAccessRowsForToken(token);
    const match = rows.find((r) => r.course_id === courseId);
    if (!match) return null;
    return {
      accessToken: match.access_token,
      courseId: match.course_id,
      email: match.email,
      customerId: match.customer_id,
      impersonated: match.access_token !== token
    };
  }

  async function resolveTokenIdentity(token) {
    if (!getCourseAccessRowsForToken) return null;
    const rows = await getCourseAccessRowsForToken(token);
    if (!rows.length) return null;
    const first = rows[0];
    return {
      accessToken: first.access_token,
      email: first.email,
      customerId: first.customer_id,
      impersonated: first.access_token !== token,
      accessTokens: Array.from(new Set(rows.map((r) => r.access_token)))
    };
  }

  function qaAdminAuth(req, res, next) {
    const threadId = parseInt(req.params.id, 10);
    if (!threadId) return res.status(400).json({ error: 'Invalid id' });
    const full = chatAuth?.verifyFullAdmin ? chatAuth.verifyFullAdmin(req) : null;
    if (full) {
      req.admin = full;
      req.qaAdminScope = { full: true, uploadId: 'admin' };
      return next();
    }
    const scoped = chatAuth?.verifyThreadAdmin ? chatAuth.verifyThreadAdmin(req, threadId) : null;
    if (scoped) {
      req.admin = scoped;
      req.qaAdminScope = { full: false, threadId, uploadId: `thread:${threadId}` };
      return next();
    }
    return res.status(401).json({ error: 'Unauthorized' });
  }

  async function loadMessagesWithAttachments(threadId) {
    const messages = (await pool.query(
      `SELECT id, sender, body, created_at
       FROM nb_qa_messages
       WHERE thread_id = $1
       ORDER BY created_at ASC, id ASC`,
      [threadId]
    )).rows;
    if (messages.length === 0) return [];
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
      byMessage.get(row.message_id).push({
        id: row.id,
        detectedMime: row.detected_mime,
        sizeBytes: Number(row.size_bytes) || 0,
        durationSeconds: row.duration_seconds == null ? null : Number(row.duration_seconds),
        originalFilename: row.original_filename || null,
        viewUrl: `/api/chat/attachments/${row.id}/view`
      });
    }
    return messages.map((row) => ({
      ...row,
      attachments: byMessage.get(row.id) || []
    }));
  }

  function emitCourseMessage({ thread, messageId, body, sender, createdAt, attachmentCount = 0 }) {
    if (!chatEvents?.emitMessage) return;
    chatEvents.emitMessage({
      id: messageId,
      messageId,
      threadId: thread.id,
      body,
      sender,
      createdAt,
      hasAttachments: attachmentCount > 0,
      attachmentCount,
      customerId: thread.customer_id,
      accessToken: thread.access_token,
      channel: thread.channel || 'course'
    });
  }

  // ─── Student progress ─────────────────────────────────────────
  app.post('/api/courses/:courseId/:lessonId/progress', async (req, res) => {
    try {
      const ip = getIP(req);
      if (!rateLimit(`progress:${ip}`, 240, 60000)) {
        return res.status(429).json({ error: 'Too many requests' });
      }
      const { token, position, duration, completed } = req.body || {};
      const { courseId, lessonId } = req.params;
      if (!token) return res.status(401).json({ error: 'Token required' });
      if (!courses[courseId]) return res.status(404).json({ error: 'Course not found' });
      if (!await verifyCourseAccess(token, courseId)) return res.status(403).json({ error: 'Access denied' });

      const access = await resolveAccessForCourse(token, courseId);
      if (!access) return res.status(403).json({ error: 'Access denied' });

      // Admin-impersonation mode is read-only — don't pollute student progress metrics
      if (access.impersonated) return res.json({ ok: true, impersonated: true, skipped: true });

      const pos = Math.max(0, Number(position) || 0);
      const dur = Math.max(0, Number(duration) || 0);
      const explicitComplete = completed === true;
      const inferComplete = dur > 0 && pos / dur >= COMPLETION_THRESHOLD;
      const isComplete = explicitComplete || inferComplete;

      await pool.query(
        `INSERT INTO nb_lesson_progress
           (access_token, course_id, lesson_id, email, customer_id,
            position_seconds, duration_seconds, completed, completed_at,
            first_watched_at, last_watched_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW(), NOW())
         ON CONFLICT (access_token, course_id, lesson_id) DO UPDATE SET
           position_seconds = EXCLUDED.position_seconds,
           duration_seconds = GREATEST(nb_lesson_progress.duration_seconds, EXCLUDED.duration_seconds),
           completed = nb_lesson_progress.completed OR EXCLUDED.completed,
           completed_at = CASE
             WHEN nb_lesson_progress.completed THEN nb_lesson_progress.completed_at
             WHEN EXCLUDED.completed THEN NOW()
             ELSE nb_lesson_progress.completed_at
           END,
           last_watched_at = NOW(),
           updated_at = NOW(),
           email = EXCLUDED.email,
           customer_id = COALESCE(EXCLUDED.customer_id, nb_lesson_progress.customer_id)`,
        [
          access.accessToken, courseId, lessonId, access.email, access.customerId || null,
          pos, dur, isComplete, isComplete ? new Date() : null
        ]
      );

      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e }, 'Save progress error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.get('/api/courses/:courseId/progress', async (req, res) => {
    try {
      const ip = getIP(req);
      if (!rateLimit(`progress-get:${ip}`, 60, 60000)) {
        return res.status(429).json({ error: 'Too many requests' });
      }
      const { token } = req.query;
      const { courseId } = req.params;
      if (!token) return res.status(401).json({ error: 'Token required' });
      if (!await verifyCourseAccess(token, courseId)) return res.status(403).json({ error: 'Access denied' });

      const access = await resolveAccessForCourse(token, courseId);
      if (!access) return res.status(403).json({ error: 'Access denied' });

      const result = await pool.query(
        `SELECT lesson_id, position_seconds, duration_seconds, completed, last_watched_at
         FROM nb_lesson_progress
         WHERE access_token = $1 AND course_id = $2`,
        [access.accessToken, courseId]
      );
      res.json({
        ok: true,
        progress: result.rows.map((row) => ({
          lessonId: row.lesson_id,
          position: Number(row.position_seconds) || 0,
          duration: Number(row.duration_seconds) || 0,
          completed: row.completed,
          lastWatchedAt: row.last_watched_at
        }))
      });
    } catch (e) {
      logger.error({ err: e }, 'Get progress error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ─── Student Q&A ──────────────────────────────────────────────
  app.get('/api/courses/questions', async (req, res) => {
    try {
      const ip = getIP(req);
      if (!rateLimit(`qa-student:${ip}`, 60, 60000)) {
        return res.status(429).json({ error: 'Too many requests' });
      }
      const { token } = req.query;
      if (!token) return res.status(401).json({ error: 'Token required' });

      const identity = await resolveTokenIdentity(token);
      if (!identity) return res.status(403).json({ error: 'Invalid token' });

      const threads = await pool.query(
        `SELECT id, course_id, lesson_id, subject, status, unread_for_student, last_message_at, created_at
         FROM nb_qa_threads
         WHERE access_token = ANY($1::varchar[])
         ORDER BY last_message_at DESC
         LIMIT 100`,
        [identity.accessTokens]
      );

      res.json({
        ok: true,
        threads: threads.rows.map((row) => ({
          id: row.id,
          courseId: row.course_id,
          lessonId: row.lesson_id,
          subject: row.subject,
          status: row.status,
          unread: row.unread_for_student,
          lastMessageAt: row.last_message_at,
          createdAt: row.created_at
        }))
      });
    } catch (e) {
      logger.error({ err: e }, 'Student QA list error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.get('/api/courses/questions/:threadId', async (req, res) => {
    try {
      const ip = getIP(req);
      if (!rateLimit(`qa-student-read:${ip}`, 120, 60000)) {
        return res.status(429).json({ error: 'Too many requests' });
      }
      const { token } = req.query;
      if (!token) return res.status(401).json({ error: 'Token required' });
      const threadId = parseInt(req.params.threadId, 10);
      if (!threadId) return res.status(400).json({ error: 'Invalid thread' });

      const identity = await resolveTokenIdentity(token);
      if (!identity) return res.status(403).json({ error: 'Invalid token' });
      const thread = await pool.query(
        `SELECT id, course_id, lesson_id, subject, status FROM nb_qa_threads WHERE id = $1 AND access_token = ANY($2::varchar[])`,
        [threadId, identity.accessTokens]
      );
      if (thread.rows.length === 0) return res.status(404).json({ error: 'Not found' });

      const msgs = await loadMessagesWithAttachments(threadId);

      // Admin-impersonation reads don't clear student unread state
      if (!identity.impersonated) {
        await pool.query(`UPDATE nb_qa_threads SET unread_for_student = FALSE WHERE id = $1`, [threadId]);
      }

      res.json({
        ok: true,
        thread: thread.rows[0],
        messages: msgs
      });
    } catch (e) {
      logger.error({ err: e }, 'Student QA read error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.post('/api/courses/questions', async (req, res) => {
    try {
      const ip = getIP(req);
      if (!rateLimit(`qa-create:${ip}`, 10, 3600000)) {
        return res.status(429).json({ error: 'Too many requests. Please try again later.' });
      }

      const { token, courseId, lessonId, subject, body, name } = req.body || {};
      if (!token) return res.status(401).json({ error: 'Token required' });
      const trimmedBody = (body || '').trim();
      if (!trimmedBody) return res.status(400).json({ error: 'Question body required' });
      if (trimmedBody.length > MAX_QUESTION_LENGTH) return res.status(400).json({ error: 'Question too long' });

      const identity = await resolveTokenIdentity(token);
      if (!identity) return res.status(403).json({ error: 'Invalid token' });

      // Admin-impersonation mode is read-only — don't create threads as the customer
      if (identity.impersonated) {
        return res.status(403).json({ error: 'Admin impersonation is read-only' });
      }

      const effectiveCourseId = courseId || identity.courseId;
      if (!effectiveCourseId) return res.status(400).json({ error: 'Course required' });

      if (effectiveCourseId && !await verifyCourseAccess(token, effectiveCourseId)) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const course = courses[effectiveCourseId];
      const lesson = course?.lessons?.find((l) => l.id === lessonId);
      const derivedSubject = (subject || '').trim().slice(0, MAX_SUBJECT_LENGTH) ||
        (lesson ? `${course.name} — ${lesson.title}` : 'コースへの質問');

      const client = await pool.connect();
      let thread;
      let message;
      try {
        await client.query('BEGIN');
        thread = (await client.query(
          `INSERT INTO nb_qa_threads
             (access_token, customer_id, email, name, course_id, lesson_id, subject, channel,
              status, unread_for_admin, last_message_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'course', 'open', TRUE, NOW())
           RETURNING *`,
          [identity.accessToken, identity.customerId || null, identity.email, (name || '').trim() || null,
           effectiveCourseId, lessonId || null, derivedSubject]
        )).rows[0];
        message = (await client.query(
          `INSERT INTO nb_qa_messages (thread_id, sender, body)
           VALUES ($1, 'student', $2)
           RETURNING id, created_at`,
          [thread.id, trimmedBody]
        )).rows[0];
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
      const threadId = thread.id;

      // Notify Nami via email + WhatsApp (non-blocking)
      const contextLine = lesson ? `${course.name} — ${lesson.title}` : course?.name || '(コース未指定)';
      const adminUrl = `${siteUrl}/admin/qa.html?thread=${threadId}`;
      emitCourseMessage({ thread, messageId: message.id, body: trimmedBody, sender: 'student', createdAt: message.created_at });
      chatEvents?.emitAdminEvent?.('thread-created', { threadId, channel: 'course' });
      chatServices?.maybeSendNamiAlertEmail?.({
        threadId,
        messageId: message.id,
        body: trimmedBody,
        attachmentCount: 0
      }).catch((err) => logger.error({ err, threadId }, 'QA admin notify email failed'));

      if (sendWhatsApp && namiJid) {
        sendWhatsApp(namiJid, `💬 生徒からの新しい質問\n${identity.email}\n${contextLine}\n\n${trimmedBody.slice(0, 200)}${trimmedBody.length > 200 ? '...' : ''}\n\n${adminUrl}`)
          .catch((err) => logger.error({ err }, 'QA WhatsApp notify failed'));
      }

      res.json({ ok: true, threadId });
    } catch (e) {
      logger.error({ err: e }, 'Student QA create error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.post('/api/courses/questions/:threadId/reply', async (req, res) => {
    try {
      const { token, body } = req.body || {};
      const threadId = parseInt(req.params.threadId, 10);
      if (!token) return res.status(401).json({ error: 'Token required' });
      if (!threadId) return res.status(400).json({ error: 'Invalid thread' });
      const trimmed = (body || '').trim();
      if (!trimmed) return res.status(400).json({ error: 'Message required' });
      if (trimmed.length > MAX_QUESTION_LENGTH) return res.status(400).json({ error: 'Message too long' });

      const identity = await resolveTokenIdentity(token);
      if (!identity) return res.status(403).json({ error: 'Invalid token' });
      if (identity.impersonated) return res.status(403).json({ error: 'Admin impersonation is read-only' });
      if (!rateLimit(`qa-course-reply-token:${sha256Hex(identity.accessToken)}`, 30, 3600000)) {
        return res.status(429).json({ error: 'Too many requests' });
      }

      const thread = await pool.query(
        `SELECT * FROM nb_qa_threads WHERE id = $1 AND access_token = ANY($2::varchar[])`,
        [threadId, identity.accessTokens]
      );
      if (thread.rows.length === 0) return res.status(404).json({ error: 'Not found' });

      const client = await pool.connect();
      let message;
      try {
        await client.query('BEGIN');
        message = (await client.query(
          `INSERT INTO nb_qa_messages (thread_id, sender, body)
           VALUES ($1, 'student', $2)
           RETURNING id, created_at`,
          [threadId, trimmed]
        )).rows[0];
        await client.query(
          `UPDATE nb_qa_threads SET status = 'open', unread_for_admin = TRUE, last_message_at = NOW() WHERE id = $1`,
          [threadId]
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      const adminUrl = `${siteUrl}/admin/qa.html?thread=${threadId}`;
      emitCourseMessage({ thread: thread.rows[0], messageId: message.id, body: trimmed, sender: 'student', createdAt: message.created_at });
      chatEvents?.emitAdminEvent?.('thread-updated', { threadId, channel: thread.rows[0].channel || 'course', unreadForAdmin: true });
      chatServices?.maybeSendNamiAlertEmail?.({
        threadId,
        messageId: message.id,
        body: trimmed,
        attachmentCount: 0
      }).catch((err) => logger.error({ err, threadId }, 'QA admin reply notify failed'));

      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e }, 'Student QA reply error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ─── Admin: students ──────────────────────────────────────────
  app.get('/api/admin/students', authMiddleware, async (req, res) => {
    try {
      const { search, courseId } = req.query;
      const conditions = [];
      const params = [];
      let idx = 1;
      if (courseId) {
        conditions.push(`ca.course_id = $${idx++}`);
        params.push(courseId);
      }
      if (search) {
        conditions.push(`(ca.email ILIKE $${idx} OR c.name ILIKE $${idx})`);
        params.push(`%${search}%`);
        idx++;
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

      const rows = (await pool.query(
        `SELECT
           ca.access_token,
           ca.email,
           ca.customer_id,
           c.name AS customer_name,
           ARRAY_AGG(DISTINCT ca.course_id ORDER BY ca.course_id) AS course_ids,
           MIN(ca.purchased_at) AS first_purchased_at,
           MAX(ca.purchased_at) AS last_purchased_at,
           (SELECT MAX(last_watched_at) FROM nb_lesson_progress lp WHERE lp.access_token = ca.access_token) AS last_active_at,
           (SELECT COUNT(*) FROM nb_lesson_progress lp WHERE lp.access_token = ca.access_token AND lp.completed) AS completed_count,
           (SELECT COUNT(*) FROM nb_lesson_progress lp WHERE lp.access_token = ca.access_token) AS started_count,
           (SELECT COUNT(*) FROM nb_qa_threads t WHERE t.access_token = ca.access_token) AS thread_count,
           (SELECT COUNT(*) FROM nb_qa_threads t WHERE t.access_token = ca.access_token AND t.unread_for_admin) AS unread_thread_count
         FROM nb_course_access ca
         LEFT JOIN nb_customers c ON c.id = ca.customer_id
         ${where}
         GROUP BY ca.access_token, ca.email, ca.customer_id, c.name
         ORDER BY last_active_at DESC NULLS LAST, last_purchased_at DESC
         LIMIT 500`,
        params
      )).rows;

      res.json({
        students: rows.map((r) => ({
          email: r.email,
          customerId: r.customer_id,
          name: r.customer_name,
          courseIds: r.course_ids,
          firstPurchasedAt: r.first_purchased_at,
          lastPurchasedAt: r.last_purchased_at,
          lastActiveAt: r.last_active_at,
          completedCount: Number(r.completed_count) || 0,
          startedCount: Number(r.started_count) || 0,
          threadCount: Number(r.thread_count) || 0,
          unreadThreadCount: Number(r.unread_thread_count) || 0
        }))
      });
    } catch (e) {
      logger.error({ err: e }, 'Admin students list error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.get('/api/admin/students/:token', authMiddleware, async (req, res) => {
    try {
      const token = req.params.token;
      const accessRows = (await pool.query(
        `SELECT ca.access_token, ca.course_id, ca.email, ca.customer_id, ca.purchased_at,
                c.name AS customer_name
         FROM nb_course_access ca
         LEFT JOIN nb_customers c ON c.id = ca.customer_id
         WHERE ca.access_token = $1
         ORDER BY ca.purchased_at ASC`,
        [token]
      )).rows;
      if (accessRows.length === 0) return res.status(404).json({ error: 'Not found' });

      const progress = (await pool.query(
        `SELECT course_id, lesson_id, position_seconds, duration_seconds, completed, completed_at, first_watched_at, last_watched_at
         FROM nb_lesson_progress
         WHERE access_token = $1
         ORDER BY last_watched_at DESC`,
        [token]
      )).rows;

      const ownedCourses = accessRows.map((row) => {
        const catalog = courses[row.course_id];
        const lessons = catalog?.lessons || [];
        const totalPlayable = lessons.filter((l) => (l.type || 'video') !== 'pdf' && (l.type || 'video') !== 'ending').length;
        const progressForCourse = progress.filter((p) => p.course_id === row.course_id);
        return {
          courseId: row.course_id,
          courseName: catalog?.name || row.course_id,
          purchasedAt: row.purchased_at,
          totalLessons: totalPlayable,
          completedCount: progressForCourse.filter((p) => p.completed).length,
          startedCount: progressForCourse.length,
          lessons: lessons.map((lesson) => {
            const p = progressForCourse.find((item) => item.lesson_id === lesson.id);
            return {
              id: lesson.id,
              title: lesson.title,
              type: lesson.type || 'video',
              position: p ? Number(p.position_seconds) || 0 : 0,
              duration: p ? Number(p.duration_seconds) || 0 : 0,
              completed: !!p?.completed,
              completedAt: p?.completed_at || null,
              firstWatchedAt: p?.first_watched_at || null,
              lastWatchedAt: p?.last_watched_at || null
            };
          })
        };
      });

      const student = accessRows[0];
      res.json({
        student: {
          email: student.email,
          customerId: student.customer_id,
          name: student.customer_name
        },
        courses: ownedCourses
      });
    } catch (e) {
      logger.error({ err: e }, 'Admin student detail error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ─── Admin: Q&A ───────────────────────────────────────────────
  app.get('/api/admin/qa', authMiddleware, async (req, res) => {
    try {
      const { status, search, channel, since } = req.query;
      const conditions = [];
      const params = [];
      let idx = 1;
      if (status && ['open', 'answered', 'archived'].includes(status)) {
        conditions.push(`t.status = $${idx++}`);
        params.push(status);
      }
      if (channel && ['dm', 'course'].includes(channel)) {
        conditions.push(`t.channel = $${idx++}`);
        params.push(channel);
      }
      if (search) {
        conditions.push(`(t.email ILIKE $${idx} OR t.subject ILIKE $${idx})`);
        params.push(`%${search}%`);
        idx++;
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

      const threads = (await pool.query(
        `SELECT t.id, t.email, t.name, t.channel, t.course_id, t.lesson_id, t.subject, t.status,
                t.unread_for_admin, t.last_message_at, t.created_at,
                (SELECT COUNT(*) FROM nb_qa_messages m WHERE m.thread_id = t.id) AS message_count
         FROM nb_qa_threads t
         ${where}
         ORDER BY t.unread_for_admin DESC, t.last_message_at DESC
         LIMIT 200`,
        params
      )).rows;

      const summary = (await pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'open') AS open_count,
           COUNT(*) FILTER (WHERE status = 'answered') AS answered_count,
           COUNT(*) FILTER (WHERE status = 'archived') AS archived_count,
           COUNT(*) FILTER (WHERE channel = 'dm') AS dm_count,
           COUNT(*) FILTER (WHERE channel = 'course') AS course_count,
           COUNT(*) FILTER (WHERE unread_for_admin) AS unread_count
         FROM nb_qa_threads`
      )).rows[0];

      const sinceId = parseInt(since, 10);
      const replayMessages = Number.isFinite(sinceId) && sinceId > 0 ? (await pool.query(
        `SELECT m.id, m.thread_id, m.sender, m.body, m.created_at, t.channel,
                COUNT(a.id) AS attachment_count
         FROM nb_qa_messages m
         JOIN nb_qa_threads t ON t.id = m.thread_id
         LEFT JOIN nb_qa_attachments a ON a.message_id = m.id
         WHERE m.id > $1
         GROUP BY m.id, t.channel
         ORDER BY m.id ASC
         LIMIT 100`,
        [sinceId]
      )).rows.map((row) => ({
        id: Number(row.id),
        messageId: Number(row.id),
        threadId: Number(row.thread_id),
        body: row.body || '',
        sender: row.sender,
        senderRole: row.sender,
        createdAt: row.created_at,
        channel: row.channel || 'course',
        hasAttachments: Number(row.attachment_count) > 0,
        attachmentCount: Number(row.attachment_count) || 0
      })) : [];

      res.json({
        summary: {
          open: Number(summary.open_count) || 0,
          answered: Number(summary.answered_count) || 0,
          archived: Number(summary.archived_count) || 0,
          dm: Number(summary.dm_count) || 0,
          course: Number(summary.course_count) || 0,
          unread: Number(summary.unread_count) || 0
        },
        replayMessages,
        threads: threads.map((t) => ({
          id: t.id,
          channel: t.channel || 'course',
          email: t.email,
          name: t.name,
          courseId: t.course_id,
          lessonId: t.lesson_id,
          subject: t.subject,
          status: t.status,
          unread: t.unread_for_admin,
          messageCount: Number(t.message_count) || 0,
          lastMessageAt: t.last_message_at,
          createdAt: t.created_at
        }))
      });
    } catch (e) {
      logger.error({ err: e }, 'Admin QA list error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.get('/api/admin/qa/:id', qaAdminAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ error: 'Invalid id' });

      const thread = (await pool.query(
        `SELECT id, customer_id, email, name, channel, course_id, lesson_id, subject, status,
                unread_for_admin, last_message_at, created_at
         FROM nb_qa_threads WHERE id = $1`,
        [id]
      )).rows[0];
      if (!thread) return res.status(404).json({ error: 'Not found' });

      const messages = await loadMessagesWithAttachments(id);

      await pool.query(`UPDATE nb_qa_threads SET unread_for_admin = FALSE, last_admin_notified_at = NULL WHERE id = $1`, [id]);

      const course = courses[thread.course_id];
      const lesson = course?.lessons?.find((l) => l.id === thread.lesson_id);

      res.json({
        thread: {
          id: thread.id,
          email: thread.email,
          name: thread.name,
          openAsStudentUrl: thread.customer_id && thread.course_id
            ? `/api/admin/customers/${thread.customer_id}/open-as-student?course=${encodeURIComponent(thread.course_id)}`
            : thread.course_id
            ? `/api/admin/qa/${thread.id}/open-as-student`
            : null,
          channel: thread.channel || 'course',
          courseId: thread.course_id,
          courseName: course?.name || null,
          lessonId: thread.lesson_id,
          lessonTitle: lesson?.title || null,
          subject: thread.subject,
          status: thread.status,
          lastMessageAt: thread.last_message_at,
          createdAt: thread.created_at
        },
        messages
      });
    } catch (e) {
      logger.error({ err: e }, 'Admin QA read error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.post('/api/admin/qa/:id/reply', qaAdminAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ error: 'Invalid id' });
      const trimmed = (req.body?.body || '').trim();
      const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
      if (!trimmed && attachments.length === 0) return res.status(400).json({ error: 'Message required' });
      if (trimmed.length > MAX_QUESTION_LENGTH) return res.status(400).json({ error: 'Message too long' });
      if (attachments.length > 5) return res.status(400).json({ error: 'Maximum 5 attachments per message' });

      const thread = (await pool.query(
        `SELECT id, channel, access_token, email, name, subject, course_id, lesson_id FROM nb_qa_threads WHERE id = $1`,
        [id]
      )).rows[0];
      if (!thread) return res.status(404).json({ error: 'Not found' });

      let result;
      if (chatServices?.insertMessageWithTransaction) {
        result = await chatServices.insertMessageWithTransaction({
          threadId: id,
          identity: {
            kind: 'admin',
            role: 'nami',
            full: !!req.qaAdminScope?.full,
            threadId: id,
            uploadId: req.qaAdminScope?.uploadId || 'admin'
          },
          body: trimmed,
          uploadIds: attachments
        });
      } else {
        if (attachments.length > 0) return res.status(503).json({ error: 'Attachment service not configured' });
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const msg = await client.query(
            `INSERT INTO nb_qa_messages (thread_id, sender, body)
             VALUES ($1, 'nami', $2)
             RETURNING id, created_at`,
            [id, trimmed]
          );
          await client.query(
            `UPDATE nb_qa_threads SET status = 'answered', unread_for_student = TRUE, last_message_at = NOW() WHERE id = $1`,
            [id]
          );
          await client.query('COMMIT');
          result = { messageId: msg.rows[0].id, createdAt: msg.rows[0].created_at, attachments: [] };
          emitCourseMessage({ thread, messageId: result.messageId, body: trimmed, sender: 'nami', createdAt: result.createdAt });
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      }

      const watchUrl = thread.channel === 'dm'
        ? `${siteUrl}/messages`
        : `${siteUrl}/watch?token=${thread.access_token}${thread.course_id ? `&course=${thread.course_id}` : ''}`;
      const course = courses[thread.course_id];
      const lesson = course?.lessons?.find((l) => l.id === thread.lesson_id);
      const contextLine = lesson ? `${course.name} — ${lesson.title}` : course?.name || '';
      const greeting = thread.name ? `${escapeHtml(thread.name)}様` : 'こんにちは';

      transporter.sendMail({
        from: smtpFrom,
        to: thread.email,
        replyTo: 'namibarden@gmail.com',
        subject: `Re: ${thread.subject || 'コースへの質問'}`,
        html: `<div style="font-family:Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;color:#2C2419;background:#FAF7F2;padding:40px;">
          <h2 style="font-size:1.3rem;margin:0 0 20px;">${greeting}</h2>
          <p style="line-height:1.8;margin:0 0 16px;">いただいたご質問にお返事いたします。</p>
          ${contextLine ? `<p style="color:#8B7E6E;font-size:0.85rem;margin:0 0 12px;">${escapeHtml(contextLine)}</p>` : ''}
          <div style="background:#fff;padding:24px;border-left:3px solid #A8895E;white-space:pre-wrap;line-height:1.8;border-radius:2px;">${escapeHtml(trimmed)}</div>
          <p style="line-height:1.8;margin:24px 0 0;">続けてご質問がある場合は、このメールにそのままご返信いただくか、受講ページの「ナミに質問する」から送ってください。</p>
          <p style="margin:24px 0 0;"><a href="${watchUrl}" style="display:inline-block;padding:12px 28px;background:#A8895E;color:#fff;text-decoration:none;border-radius:2px;font-size:0.95rem;">受講ページへ戻る →</a></p>
          <hr style="border:none;border-top:1px solid #E8DFD3;margin:32px 0;">
          <p style="font-size:0.8rem;color:#A99E8F;text-align:center;">Nami Barden — namibarden.com</p>
        </div>`
      }).catch((err) => logger.error({ err }, 'QA reply email failed'));

      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e }, 'Admin QA reply error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.post('/api/admin/qa/:id/status', qaAdminAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ error: 'Invalid id' });
      const status = req.body?.status;
      if (!['open', 'answered', 'archived'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
      }
      const result = await pool.query(
        `UPDATE nb_qa_threads SET status = $1 WHERE id = $2 RETURNING id`,
        [status, id]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
      chatEvents?.emitAdminEvent?.('status-changed', { threadId: id, status });
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e }, 'Admin QA status error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  return {};
}

module.exports = { createCourseEngagement };
