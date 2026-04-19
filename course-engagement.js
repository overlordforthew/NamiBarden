const COMPLETION_THRESHOLD = 0.9; // 90% watched counts as completed
const MAX_QUESTION_LENGTH = 4000;
const MAX_SUBJECT_LENGTH = 200;

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
  courses,
  sendWhatsApp,
  namiJid
}) {
  async function ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS nb_lesson_progress (
        id SERIAL PRIMARY KEY,
        access_token VARCHAR(64) NOT NULL,
        course_id VARCHAR(50) NOT NULL,
        lesson_id VARCHAR(100) NOT NULL,
        email VARCHAR(255) NOT NULL,
        customer_id INTEGER REFERENCES nb_customers(id) ON DELETE SET NULL,
        position_seconds REAL DEFAULT 0,
        duration_seconds REAL DEFAULT 0,
        completed BOOLEAN DEFAULT FALSE,
        completed_at TIMESTAMP,
        first_watched_at TIMESTAMP DEFAULT NOW(),
        last_watched_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(access_token, course_id, lesson_id)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_lesson_progress_token ON nb_lesson_progress(access_token, course_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_lesson_progress_email ON nb_lesson_progress(email)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_lesson_progress_last ON nb_lesson_progress(last_watched_at DESC)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS nb_qa_threads (
        id SERIAL PRIMARY KEY,
        access_token VARCHAR(64) NOT NULL,
        customer_id INTEGER REFERENCES nb_customers(id) ON DELETE SET NULL,
        email VARCHAR(255) NOT NULL,
        name VARCHAR(255),
        course_id VARCHAR(50),
        lesson_id VARCHAR(100),
        subject VARCHAR(255),
        status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'archived')),
        unread_for_admin BOOLEAN NOT NULL DEFAULT TRUE,
        unread_for_student BOOLEAN NOT NULL DEFAULT FALSE,
        last_message_at TIMESTAMP DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_qa_threads_token ON nb_qa_threads(access_token)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_qa_threads_status_last ON nb_qa_threads(status, last_message_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_qa_threads_email ON nb_qa_threads(email)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS nb_qa_messages (
        id SERIAL PRIMARY KEY,
        thread_id INTEGER NOT NULL REFERENCES nb_qa_threads(id) ON DELETE CASCADE,
        sender VARCHAR(20) NOT NULL CHECK (sender IN ('student', 'nami')),
        body TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_qa_messages_thread ON nb_qa_messages(thread_id, created_at)`);
  }

  async function lookupAccessRow(token, courseId) {
    const result = await pool.query(
      `SELECT access_token, course_id, email, customer_id
       FROM nb_course_access
       WHERE access_token = $1 AND course_id = $2
       LIMIT 1`,
      [token, courseId]
    );
    return result.rows[0] || null;
  }

  async function lookupTokenIdentity(token) {
    const result = await pool.query(
      `SELECT access_token, email, customer_id
       FROM nb_course_access
       WHERE access_token = $1
       ORDER BY purchased_at ASC
       LIMIT 1`,
      [token]
    );
    return result.rows[0] || null;
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

      const access = await lookupAccessRow(token, courseId);
      if (!access) return res.status(403).json({ error: 'Access denied' });

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
          token, courseId, lessonId, access.email, access.customer_id || null,
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

      const result = await pool.query(
        `SELECT lesson_id, position_seconds, duration_seconds, completed, last_watched_at
         FROM nb_lesson_progress
         WHERE access_token = $1 AND course_id = $2`,
        [token, courseId]
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

      const identity = await lookupTokenIdentity(token);
      if (!identity) return res.status(403).json({ error: 'Invalid token' });

      const threads = await pool.query(
        `SELECT id, course_id, lesson_id, subject, status, unread_for_student, last_message_at, created_at
         FROM nb_qa_threads
         WHERE access_token = $1
         ORDER BY last_message_at DESC
         LIMIT 100`,
        [token]
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

      const thread = await pool.query(
        `SELECT id, course_id, lesson_id, subject, status FROM nb_qa_threads WHERE id = $1 AND access_token = $2`,
        [threadId, token]
      );
      if (thread.rows.length === 0) return res.status(404).json({ error: 'Not found' });

      const msgs = await pool.query(
        `SELECT id, sender, body, created_at FROM nb_qa_messages WHERE thread_id = $1 ORDER BY created_at ASC`,
        [threadId]
      );

      await pool.query(`UPDATE nb_qa_threads SET unread_for_student = FALSE WHERE id = $1`, [threadId]);

      res.json({
        ok: true,
        thread: thread.rows[0],
        messages: msgs.rows
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

      const identity = await lookupTokenIdentity(token);
      if (!identity) return res.status(403).json({ error: 'Invalid token' });

      if (courseId && !await verifyCourseAccess(token, courseId)) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const course = courses[courseId];
      const lesson = course?.lessons?.find((l) => l.id === lessonId);
      const derivedSubject = (subject || '').trim().slice(0, MAX_SUBJECT_LENGTH) ||
        (lesson ? `${course.name} — ${lesson.title}` : 'コースへの質問');

      const threadRes = await pool.query(
        `INSERT INTO nb_qa_threads
           (access_token, customer_id, email, name, course_id, lesson_id, subject, status, unread_for_admin, last_message_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', TRUE, NOW())
         RETURNING id`,
        [token, identity.customer_id || null, identity.email, (name || '').trim() || null,
         courseId || null, lessonId || null, derivedSubject]
      );
      const threadId = threadRes.rows[0].id;

      await pool.query(
        `INSERT INTO nb_qa_messages (thread_id, sender, body) VALUES ($1, 'student', $2)`,
        [threadId, trimmedBody]
      );

      // Notify Nami via email + WhatsApp (non-blocking)
      const contextLine = lesson ? `${course.name} — ${lesson.title}` : course?.name || '(コース未指定)';
      const adminUrl = `${siteUrl}/admin/qa.html?thread=${threadId}`;
      transporter.sendMail({
        from: smtpFrom,
        to: 'namibarden@gmail.com',
        replyTo: identity.email,
        subject: `[コース質問] ${derivedSubject}`,
        html: `<div style="font-family:Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#2C2419;">
          <h2 style="font-size:1.2rem;margin:0 0 12px;">新しい質問が届きました</h2>
          <p style="color:#8B7E6E;font-size:0.9rem;margin:0 0 6px;">${escapeHtml(contextLine)}</p>
          <p style="color:#8B7E6E;font-size:0.85rem;margin:0 0 16px;">${escapeHtml(identity.email)}</p>
          <div style="background:#FAF7F2;padding:20px;border-left:3px solid #A8895E;white-space:pre-wrap;line-height:1.8;">${escapeHtml(trimmedBody)}</div>
          <p style="margin:24px 0 0;"><a href="${adminUrl}" style="display:inline-block;padding:10px 24px;background:#A8895E;color:#fff;text-decoration:none;border-radius:2px;">管理画面で返信する →</a></p>
        </div>`
      }).catch((err) => logger.error({ err }, 'QA admin notify email failed'));

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
      const ip = getIP(req);
      if (!rateLimit(`qa-student-reply:${ip}`, 20, 3600000)) {
        return res.status(429).json({ error: 'Too many requests' });
      }
      const { token, body } = req.body || {};
      const threadId = parseInt(req.params.threadId, 10);
      if (!token) return res.status(401).json({ error: 'Token required' });
      if (!threadId) return res.status(400).json({ error: 'Invalid thread' });
      const trimmed = (body || '').trim();
      if (!trimmed) return res.status(400).json({ error: 'Message required' });
      if (trimmed.length > MAX_QUESTION_LENGTH) return res.status(400).json({ error: 'Message too long' });

      const thread = await pool.query(
        `SELECT id, subject, email FROM nb_qa_threads WHERE id = $1 AND access_token = $2`,
        [threadId, token]
      );
      if (thread.rows.length === 0) return res.status(404).json({ error: 'Not found' });

      await pool.query(
        `INSERT INTO nb_qa_messages (thread_id, sender, body) VALUES ($1, 'student', $2)`,
        [threadId, trimmed]
      );
      await pool.query(
        `UPDATE nb_qa_threads SET status = 'open', unread_for_admin = TRUE, last_message_at = NOW() WHERE id = $1`,
        [threadId]
      );

      const adminUrl = `${siteUrl}/admin/qa.html?thread=${threadId}`;
      transporter.sendMail({
        from: smtpFrom,
        to: 'namibarden@gmail.com',
        replyTo: thread.rows[0].email,
        subject: `[再質問] ${thread.rows[0].subject || ''}`,
        html: `<div style="font-family:Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#2C2419;">
          <p>生徒から追加のメッセージが届きました：</p>
          <div style="background:#FAF7F2;padding:20px;border-left:3px solid #A8895E;white-space:pre-wrap;line-height:1.8;">${escapeHtml(trimmed)}</div>
          <p style="margin:20px 0 0;"><a href="${adminUrl}">管理画面で返信する →</a></p>
        </div>`
      }).catch((err) => logger.error({ err }, 'QA admin reply notify failed'));

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
          accessToken: r.access_token,
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
          accessToken: student.access_token,
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
      const { status, search } = req.query;
      const conditions = [];
      const params = [];
      let idx = 1;
      if (status && ['open', 'answered', 'archived'].includes(status)) {
        conditions.push(`t.status = $${idx++}`);
        params.push(status);
      }
      if (search) {
        conditions.push(`(t.email ILIKE $${idx} OR t.subject ILIKE $${idx})`);
        params.push(`%${search}%`);
        idx++;
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

      const threads = (await pool.query(
        `SELECT t.id, t.email, t.name, t.course_id, t.lesson_id, t.subject, t.status,
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
           COUNT(*) FILTER (WHERE unread_for_admin) AS unread_count
         FROM nb_qa_threads`
      )).rows[0];

      res.json({
        summary: {
          open: Number(summary.open_count) || 0,
          answered: Number(summary.answered_count) || 0,
          archived: Number(summary.archived_count) || 0,
          unread: Number(summary.unread_count) || 0
        },
        threads: threads.map((t) => ({
          id: t.id,
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

  app.get('/api/admin/qa/:id', authMiddleware, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ error: 'Invalid id' });

      const thread = (await pool.query(
        `SELECT id, access_token, email, name, course_id, lesson_id, subject, status,
                unread_for_admin, last_message_at, created_at
         FROM nb_qa_threads WHERE id = $1`,
        [id]
      )).rows[0];
      if (!thread) return res.status(404).json({ error: 'Not found' });

      const messages = (await pool.query(
        `SELECT id, sender, body, created_at FROM nb_qa_messages WHERE thread_id = $1 ORDER BY created_at ASC`,
        [id]
      )).rows;

      await pool.query(`UPDATE nb_qa_threads SET unread_for_admin = FALSE WHERE id = $1`, [id]);

      const course = courses[thread.course_id];
      const lesson = course?.lessons?.find((l) => l.id === thread.lesson_id);

      res.json({
        thread: {
          id: thread.id,
          email: thread.email,
          name: thread.name,
          accessToken: thread.access_token,
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

  app.post('/api/admin/qa/:id/reply', authMiddleware, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ error: 'Invalid id' });
      const trimmed = (req.body?.body || '').trim();
      if (!trimmed) return res.status(400).json({ error: 'Message required' });
      if (trimmed.length > MAX_QUESTION_LENGTH) return res.status(400).json({ error: 'Message too long' });

      const thread = (await pool.query(
        `SELECT id, access_token, email, name, subject, course_id, lesson_id FROM nb_qa_threads WHERE id = $1`,
        [id]
      )).rows[0];
      if (!thread) return res.status(404).json({ error: 'Not found' });

      await pool.query(
        `INSERT INTO nb_qa_messages (thread_id, sender, body) VALUES ($1, 'nami', $2)`,
        [id, trimmed]
      );
      await pool.query(
        `UPDATE nb_qa_threads SET status = 'answered', unread_for_student = TRUE, last_message_at = NOW() WHERE id = $1`,
        [id]
      );

      const watchUrl = `${siteUrl}/watch?token=${thread.access_token}${thread.course_id ? `&course=${thread.course_id}` : ''}`;
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

  app.post('/api/admin/qa/:id/status', authMiddleware, async (req, res) => {
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
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e }, 'Admin QA status error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  return { ensureTables };
}

module.exports = { createCourseEngagement };
