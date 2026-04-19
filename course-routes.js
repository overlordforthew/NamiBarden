const PREVIEW_LESSONS = { 'course-1': ['promo', 'lesson-2', 'bridge'], 'course-2': ['promo'] };

function createCourseRoutes({
  app,
  pool,
  logger,
  transporter,
  getIP,
  rateLimit,
  verifyCourseAccess,
  courses,
  siteUrl,
  smtpFrom,
  escapeHtml,
  r2,
  GetObjectCommand,
  getSignedUrl,
  r2Bucket
}) {
  app.get('/api/courses/verify', async (req, res) => {
    try {
      const ip = getIP(req);
      if (!rateLimit(`course-verify:${ip}`, 10, 60000)) {
        return res.status(429).json({ error: 'Too many requests' });
      }
      const { token } = req.query;
      if (!token) return res.status(400).json({ error: 'Token required' });

      const result = await pool.query(
        `SELECT course_id, email FROM nb_course_access
         WHERE access_token = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
        [token]
      );
      if (result.rows.length === 0) return res.status(403).json({ error: 'Invalid or expired token' });

      const ownedCourses = result.rows.map((row) => ({
        id: row.course_id,
        name: courses[row.course_id]?.name || row.course_id,
        lessonCount: courses[row.course_id]?.lessons?.length || 0
      }));

      res.json({ ok: true, courses: ownedCourses });
    } catch (e) {
      logger.error({ err: e }, 'Course verify error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.get('/api/courses/:courseId/lessons', async (req, res) => {
    try {
      const ip = getIP(req);
      if (!rateLimit(`course-lessons:${ip}`, 20, 60000)) {
        return res.status(429).json({ error: 'Too many requests' });
      }
      const { token } = req.query;
      const { courseId } = req.params;
      if (!token) return res.status(401).json({ error: 'Token required' });

      const course = courses[courseId];
      if (!course) return res.status(404).json({ error: 'Course not found' });
      if (!await verifyCourseAccess(token, courseId)) return res.status(403).json({ error: 'Access denied' });

      res.json({ courseId, name: course.name, lessons: course.lessons });
    } catch (e) {
      logger.error({ err: e }, 'Course lessons error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.get('/api/preview/:courseId/:lessonId/hls/*', async (req, res) => {
    try {
      if (!r2) return res.status(503).json({ error: 'Video hosting not configured' });
      const ip = getIP(req);
      if (!rateLimit(`preview-hls:${ip}`, 100, 60000)) {
        return res.status(429).json({ error: 'Too many requests' });
      }

      const { courseId, lessonId } = req.params;
      const filePath = req.params[0];
      const allowed = PREVIEW_LESSONS[courseId];
      if (!allowed || !allowed.includes(lessonId)) return res.status(404).json({ error: 'Not found' });
      if (/\.\./.test(filePath) || filePath.startsWith('/')) {
        return res.status(400).json({ error: 'Invalid path' });
      }

      const r2Key = `courses/${courseId}/${lessonId}/${filePath}`;
      if (filePath.endsWith('.ts')) {
        const signedUrl = await getSignedUrl(
          r2,
          new GetObjectCommand({ Bucket: r2Bucket, Key: r2Key }),
          { expiresIn: 3600 }
        );
        res.set('Cache-Control', 'public, max-age=3500');
        return res.redirect(302, signedUrl);
      }

      if (filePath.endsWith('.m3u8')) {
        const obj = await r2.send(new GetObjectCommand({ Bucket: r2Bucket, Key: r2Key }));
        let body = await obj.Body.transformToString();
        body = body.replace(/^\uFEFF/, '');
        const baseApiPath = `/api/preview/${courseId}/${lessonId}/hls`;
        const dir = filePath.includes('/') ? filePath.substring(0, filePath.lastIndexOf('/')) : '';
        body = body.replace(/^(?!#)(.+)$/gm, (match, line) => {
          const trimmed = line.trim();
          if (!trimmed) return match;
          const fullPath = dir ? `${dir}/${trimmed}` : trimmed;
          return `${baseApiPath}/${fullPath}`;
        });
        res.set({ 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache' });
        return res.send(body);
      }

      res.status(400).json({ error: 'Invalid file type' });
    } catch (e) {
      if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) {
        return res.status(404).json({ error: 'Video not found' });
      }
      logger.error({ err: e }, 'Promo HLS error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.get('/api/courses/:courseId/:lessonId/hls/*', async (req, res) => {
    try {
      if (!r2) return res.status(503).json({ error: 'Video hosting not configured' });

      const ip = getIP(req);
      if (!rateLimit(`course-hls:${ip}`, 200, 60000)) {
        return res.status(429).json({ error: 'Too many requests' });
      }
      const { token } = req.query;
      const { courseId, lessonId } = req.params;
      const filePath = req.params[0];
      if (!token) return res.status(401).json({ error: 'Token required' });

      if (/\.\./.test(courseId) || /\.\./.test(lessonId) || /\.\./.test(filePath) ||
          courseId.includes('/') || lessonId.includes('/')) {
        return res.status(400).json({ error: 'Invalid path' });
      }

      if (!await verifyCourseAccess(token, courseId)) return res.status(403).json({ error: 'Access denied' });

      const course = courses[courseId];
      const lesson = course?.lessons?.find((item) => item.id === lessonId);
      const actualCourse = lesson?.sourceCourse || courseId;
      const actualLesson = lesson?.sourceLesson || lessonId;
      const r2Key = `courses/${actualCourse}/${actualLesson}/${filePath}`;

      if (filePath.endsWith('.ts')) {
        const signedUrl = await getSignedUrl(
          r2,
          new GetObjectCommand({ Bucket: r2Bucket, Key: r2Key }),
          { expiresIn: 3600 }
        );
        res.set('Cache-Control', 'private, max-age=3500');
        return res.redirect(302, signedUrl);
      }

      if (filePath.endsWith('.m3u8')) {
        const obj = await r2.send(new GetObjectCommand({ Bucket: r2Bucket, Key: r2Key }));
        let body = await obj.Body.transformToString();
        body = body.replace(/^\uFEFF/, '');

        const baseApiPath = `/api/courses/${courseId}/${lessonId}/hls`;
        const dir = filePath.includes('/') ? filePath.substring(0, filePath.lastIndexOf('/')) : '';

        body = body.replace(/^(?!#)(.+)$/gm, (match, line) => {
          const trimmed = line.trim();
          if (!trimmed) return match;
          const fullPath = dir ? `${dir}/${trimmed}` : trimmed;
          return `${baseApiPath}/${fullPath}?token=${token}`;
        });

        res.set({
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'no-cache'
        });
        return res.send(body);
      }

      res.status(400).json({ error: 'Invalid file type' });
    } catch (e) {
      if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) {
        return res.status(404).json({ error: 'Video not found' });
      }
      logger.error({ err: e }, 'HLS proxy error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.post('/api/courses/resend', async (req, res) => {
    try {
      const ip = getIP(req);
      if (!rateLimit(`course-resend:${ip}`, 3, 3600000)) {
        return res.status(429).json({ error: 'Too many requests. Please try again later.' });
      }
      const { email } = req.body;
      if (!email?.trim()) return res.status(400).json({ error: 'Email required' });

      const result = await pool.query(
        `SELECT access_token, course_id FROM nb_course_access WHERE email = $1 LIMIT 1`,
        [email.trim()]
      );
      if (result.rows.length === 0) {
        return res.json({ ok: true, message: 'If a purchase exists for this email, an access link has been sent.' });
      }

      const token = result.rows[0].access_token;
      const courseIds = (await pool.query(
        'SELECT course_id FROM nb_course_access WHERE access_token = $1',
        [token]
      )).rows.map((row) => row.course_id);

      const courseNames = courseIds.map((id) => courses[id]?.name).join(' & ');
      const watchUrl = `${siteUrl}/watch?token=${token}`;

      try {
        await transporter.sendMail({
          from: smtpFrom,
          to: email.trim(),
          subject: '\u3010NamiBarden\u3011\u30b3\u30fc\u30b9\u8996\u8074\u30ea\u30f3\u30af\u306e\u518d\u9001',
          html: `<div style="max-width:600px;margin:0 auto;font-family:'Helvetica Neue',Arial,sans-serif;color:#2C2419;background:#FAF7F2;padding:40px;">
            <h2 style="font-size:1.4rem;color:#2C2419;margin-bottom:24px;">\u30b3\u30fc\u30b9\u8996\u8074\u30ea\u30f3\u30af</h2>
            <p style="line-height:1.8;margin-bottom:16px;">\u300c${escapeHtml(courseNames)}\u300d\u306e\u8996\u8074\u30ea\u30f3\u30af\u3092\u304a\u9001\u308a\u3057\u307e\u3059\u3002</p>
            <p style="text-align:center;margin:32px 0;">
              <a href="${watchUrl}" style="display:inline-block;padding:14px 40px;background:#A8895E;color:#fff;text-decoration:none;border-radius:2px;font-size:1rem;letter-spacing:0.05em;">\u30b3\u30fc\u30b9\u3092\u8996\u8074\u3059\u308b</a>
            </p>
            <p style="font-size:0.9rem;color:#8B7E6E;">\u3053\u306e\u30ea\u30f3\u30af\u306f\u3042\u306a\u305f\u5c02\u7528\u3067\u3059\u3002\u4ed6\u306e\u65b9\u3068\u5171\u6709\u3057\u306a\u3044\u3067\u304f\u3060\u3055\u3044\u3002</p>
            <hr style="border:none;border-top:1px solid #E8DFD3;margin:32px 0;">
            <p style="font-size:0.8rem;color:#A99E8F;text-align:center;">Nami Barden - namibarden.com</p>
          </div>`
        });
      } catch (emailErr) {
        logger.error({ err: emailErr }, 'Course resend email failed');
      }

      res.json({ ok: true, message: 'If a purchase exists for this email, an access link has been sent.' });
    } catch (e) {
      logger.error({ err: e }, 'Course resend error');
      res.status(500).json({ error: 'Server error' });
    }
  });
}

module.exports = { createCourseRoutes };
