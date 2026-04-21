const reminderConfig = require('./course-reminder-config');

const { RULE_KEYS } = reminderConfig;

const REMINDER_TYPES = {
  [RULE_KEYS.UPSELL_21D]: 'course-2-upsell-21d',
  [RULE_KEYS.FLASH_45D]: 'course-2-flash-45d',
  [RULE_KEYS.INACTIVITY_COURSE_1]: 'inactivity-7d-course-1',
  [RULE_KEYS.INACTIVITY_COURSE_2]: 'inactivity-7d-course-2'
};

const INACTIVITY_BY_COURSE = {
  'course-1': RULE_KEYS.INACTIVITY_COURSE_1,
  'course-2': RULE_KEYS.INACTIVITY_COURSE_2
};

const SCHEDULER_INTERVAL_MS = 60 * 60 * 1000; // hourly sweep

function clampWindowHours(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return 48;
  return Math.min(n, 336); // max 14 days
}

function signFlashToken({ jwt, jwtSecret, customerId, email, windowHours }) {
  const hours = clampWindowHours(windowHours);
  return jwt.sign(
    { sub: String(customerId), email, kind: 'course-2-flash' },
    jwtSecret,
    { expiresIn: `${hours}h` }
  );
}

function verifyFlashToken({ jwt, jwtSecret, token }) {
  try {
    const payload = jwt.verify(token, jwtSecret);
    if (payload?.kind !== 'course-2-flash') return null;
    return payload;
  } catch {
    return null;
  }
}

// Renders the Course 2 upsell card used in the Course 1 purchase confirmation
// email (stripe-routes.js). Pricing always reflects the current admin-edited
// values from nb_email_rules so checkout amount and email copy stay in sync.
function buildCourse2UpsellBlockHtml({ token, siteUrl }) {
  const { upsellPrice, originalPrice } = reminderConfig.getActivePricing();
  const link = `${siteUrl}/online-course-2?token=${encodeURIComponent(token)}`;
  return `<hr style="border:none;border-top:1px solid #E8DFD3;margin:40px 0 28px;">
                <div style="background:#F0EAE0;padding:28px 24px;border-radius:4px;border-left:3px solid #A8895E;">
                  <p style="font-size:0.72rem;color:#A8895E;letter-spacing:0.12em;margin:0 0 8px;text-transform:uppercase;">Next Step</p>
                  <h3 style="font-size:1.1rem;color:#2C2419;margin:0 0 12px;font-weight:500;">コース2「愛を深める心の授業」</h3>
                  <p style="font-size:0.9rem;color:#5C4F3D;line-height:1.8;margin:0 0 14px;">コース1を終えたら、パートナーシップの深い課題へ。</p>
                  <ul style="list-style:none;padding:0;margin:0 0 18px;font-size:0.85rem;color:#5C4F3D;line-height:1.8;">
                    <li style="margin-bottom:4px;">・意見の食い違いを乗り越える「意識の4ステップ」</li>
                    <li style="margin-bottom:4px;">・5つの愛の言語 — すれ違いの本当の原因</li>
                    <li style="margin-bottom:4px;">・男性性と女性性のバランスで関係が変わる</li>
                    <li>・裏切り・許し・再構築 — 愛の深い知恵</li>
                  </ul>
                  <p style="font-size:0.85rem;color:#8B7E6E;margin:0 0 16px;">
                    <span style="text-decoration:line-through;">¥${originalPrice.toLocaleString('en-US')}</span>
                    <span style="color:#A8895E;font-weight:500;font-size:1.05rem;margin-left:8px;">¥${upsellPrice.toLocaleString('en-US')}</span>
                    <span style="margin-left:4px;font-size:0.8rem;">（コース1受講者限定価格）</span>
                  </p>
                  <p style="margin:0;">
                    <a href="${link}" style="display:inline-block;padding:10px 26px;background:transparent;border:1px solid #A8895E;color:#A8895E;text-decoration:none;border-radius:2px;font-size:0.88rem;letter-spacing:0.04em;">コース2の詳細を見る →</a>
                  </p>
                </div>`;
}

function createCourseReminders({
  app,
  pool,
  transporter,
  logger,
  jwt,
  jwtSecret,
  siteUrl,
  smtpFrom,
  authMiddleware,
  courses
}) {
  async function ensureReminderTable() {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS nb_course_reminders (
         id SERIAL PRIMARY KEY,
         customer_id INTEGER REFERENCES nb_customers(id) ON DELETE CASCADE,
         email VARCHAR(255) NOT NULL,
         reminder_type VARCHAR(50) NOT NULL,
         sent_at TIMESTAMP DEFAULT NOW(),
         UNIQUE(customer_id, reminder_type)
       )`
    );
    await pool.query('CREATE INDEX IF NOT EXISTS idx_course_reminders_customer ON nb_course_reminders(customer_id)');
  }

  // ─── Template vars + rendering ──────────────────────────────────────────
  function upsellVars({ name, token, rule }) {
    const link = `${siteUrl}/online-course-2?token=${encodeURIComponent(token)}`;
    return {
      name: name || 'お客様',
      link,
      upsell_price: reminderConfig.formatYen(rule.config.upsell_price),
      original_price: reminderConfig.formatYen(rule.config.original_price)
    };
  }

  function flashVars({ name, token, flashToken, rule }) {
    const link = `${siteUrl}/online-course-2?token=${encodeURIComponent(token)}&flash=${encodeURIComponent(flashToken)}`;
    return {
      name: name || 'お客様',
      flash_link: link,
      flash_price: reminderConfig.formatYen(rule.config.flash_price),
      upsell_price: reminderConfig.formatYen(rule.config.upsell_price),
      original_price: reminderConfig.formatYen(rule.config.original_price),
      flash_window_hours: String(rule.config.flash_window_hours ?? 48)
    };
  }

  function inactivityVars({ name, token, courseId, lastLessonTitle }) {
    const course = courses?.[courseId];
    const resumeUrl = `${siteUrl}/watch?token=${encodeURIComponent(token)}&course=${encodeURIComponent(courseId)}`;
    return {
      name: name || 'お客様',
      link: resumeUrl,
      course_name: course?.name || courseId,
      last_lesson_title: lastLessonTitle || ''
    };
  }

  function renderRule(rule, vars) {
    return {
      subject: reminderConfig.renderTemplate(rule.subject, vars),
      html: reminderConfig.renderTemplate(rule.bodyHtml, vars)
    };
  }

  // ─── Eligibility queries ────────────────────────────────────────────────
  async function findEligibleForType(reminderType, delayDays) {
    const { rows } = await pool.query(
      `SELECT a.customer_id, a.access_token, a.email, c.name
         FROM nb_course_access a
         JOIN nb_customers c ON c.id = a.customer_id
        WHERE a.course_id = 'course-1'
          AND a.purchased_at <= NOW() - ($1 || ' days')::interval
          AND NOT EXISTS (
            SELECT 1 FROM nb_course_access a2
             WHERE a2.customer_id = a.customer_id AND a2.course_id = 'course-2'
          )
          AND NOT EXISTS (
            SELECT 1 FROM nb_course_reminders r
             WHERE r.customer_id = a.customer_id AND r.reminder_type = $2
          )`,
      [String(delayDays), reminderType]
    );
    return rows;
  }

  async function findInactiveStudents({ courseId, reminderType, days }) {
    const { rows } = await pool.query(
      `SELECT a.customer_id, a.access_token, a.email, a.course_id, c.name,
              latest.last_watched_at, latest.lesson_id AS last_lesson_id
         FROM nb_course_access a
         JOIN nb_customers c ON c.id = a.customer_id
         JOIN LATERAL (
           SELECT last_watched_at, lesson_id
             FROM nb_lesson_progress lp
            WHERE lp.access_token = a.access_token AND lp.course_id = a.course_id
            ORDER BY last_watched_at DESC
            LIMIT 1
         ) latest ON TRUE
        WHERE a.course_id = $1
          AND latest.last_watched_at <= NOW() - ($2 || ' days')::interval
          AND EXISTS (
            SELECT 1 FROM nb_lesson_progress lp2
             WHERE lp2.access_token = a.access_token
               AND lp2.course_id = a.course_id
               AND lp2.completed = FALSE
          )
          AND NOT EXISTS (
            SELECT 1 FROM nb_course_reminders r
             WHERE r.customer_id = a.customer_id AND r.reminder_type = $3
          )`,
      [courseId, String(days), reminderType]
    );
    return rows;
  }

  async function markSent({ customerId, email, reminderType }) {
    if (!customerId) return;
    await pool.query(
      `INSERT INTO nb_course_reminders (customer_id, email, reminder_type)
       VALUES ($1, $2, $3)
       ON CONFLICT (customer_id, reminder_type) DO NOTHING`,
      [customerId, email, reminderType]
    );
  }

  // ─── Send helpers ───────────────────────────────────────────────────────
  async function sendUpsell21d({ email, name, token, customerId, rule }) {
    const vars = upsellVars({ name, token, rule });
    const { subject, html } = renderRule(rule, vars);
    await transporter.sendMail({ from: smtpFrom, to: email, subject, html });
    await markSent({ customerId, email, reminderType: REMINDER_TYPES[RULE_KEYS.UPSELL_21D] });
  }

  async function sendFlash45d({ email, name, token, customerId, rule }) {
    const flashToken = signFlashToken({
      jwt,
      jwtSecret,
      customerId,
      email,
      windowHours: rule.config.flash_window_hours ?? 48
    });
    const vars = flashVars({ name, token, flashToken, rule });
    const { subject, html } = renderRule(rule, vars);
    await transporter.sendMail({ from: smtpFrom, to: email, subject, html });
    await markSent({ customerId, email, reminderType: REMINDER_TYPES[RULE_KEYS.FLASH_45D] });
  }

  async function sendInactivity({ email, name, token, courseId, lastLessonId, customerId, rule }) {
    const course = courses?.[courseId];
    if (!course) throw new Error(`Unknown course: ${courseId}`);
    const lesson = course.lessons?.find((l) => l.id === lastLessonId);
    const vars = inactivityVars({
      name,
      token,
      courseId,
      lastLessonTitle: lesson?.title || ''
    });
    const { subject, html } = renderRule(rule, vars);
    await transporter.sendMail({ from: smtpFrom, to: email, subject, html });
    const ruleKey = INACTIVITY_BY_COURSE[courseId];
    if (ruleKey) await markSent({ customerId, email, reminderType: REMINDER_TYPES[ruleKey] });
  }

  // ─── Scheduler ──────────────────────────────────────────────────────────
  async function runReminderJob() {
    const summary = { upsell21d: null, flash45d: null, inactivity: {} };

    // 21d upsell + 45d flash (both gated on Course 1 purchase time)
    const postPurchaseJobs = [
      { ruleKey: RULE_KEYS.UPSELL_21D, send: sendUpsell21d, bucket: 'upsell21d' },
      { ruleKey: RULE_KEYS.FLASH_45D, send: sendFlash45d, bucket: 'flash45d' }
    ];
    for (const job of postPurchaseJobs) {
      const bucket = { attempted: 0, sent: 0, failed: 0, skipped: false };
      summary[job.bucket] = bucket;
      let rule;
      try {
        rule = await reminderConfig.loadRule(pool, job.ruleKey);
      } catch (err) {
        logger.error({ err, ruleKey: job.ruleKey }, 'Reminder: rule load failed');
        continue;
      }
      if (!rule) continue;
      if (!rule.enabled) { bucket.skipped = true; continue; }
      let eligible;
      try {
        eligible = await findEligibleForType(REMINDER_TYPES[job.ruleKey], rule.delayDays);
      } catch (err) {
        logger.error({ err, ruleKey: job.ruleKey }, 'Reminder: findEligible failed');
        continue;
      }
      bucket.attempted = eligible.length;
      for (const row of eligible) {
        try {
          await job.send({
            email: row.email,
            name: row.name,
            token: row.access_token,
            customerId: row.customer_id,
            rule
          });
          bucket.sent++;
          logger.info({ ruleKey: job.ruleKey, email: row.email, customerId: row.customer_id }, 'Course reminder sent');
        } catch (err) {
          bucket.failed++;
          logger.error({ err, ruleKey: job.ruleKey, email: row.email }, 'Course reminder send failed');
        }
      }
      if (eligible.length) logger.info({ ruleKey: job.ruleKey, ...bucket }, 'Reminder job finished');
    }

    // Inactivity (per-course)
    for (const courseId of Object.keys(INACTIVITY_BY_COURSE)) {
      const ruleKey = INACTIVITY_BY_COURSE[courseId];
      const bucket = { attempted: 0, sent: 0, failed: 0, skipped: false };
      summary.inactivity[courseId] = bucket;
      let rule;
      try {
        rule = await reminderConfig.loadRule(pool, ruleKey);
      } catch (err) {
        logger.error({ err, ruleKey }, 'Inactivity rule load failed');
        continue;
      }
      if (!rule) continue;
      if (!rule.enabled) { bucket.skipped = true; continue; }
      let eligible;
      try {
        eligible = await findInactiveStudents({
          courseId,
          reminderType: REMINDER_TYPES[ruleKey],
          days: rule.delayDays
        });
      } catch (err) {
        logger.error({ err, courseId }, 'Inactivity: findInactiveStudents failed');
        continue;
      }
      bucket.attempted = eligible.length;
      for (const row of eligible) {
        try {
          await sendInactivity({
            email: row.email,
            name: row.name,
            token: row.access_token,
            courseId: row.course_id,
            lastLessonId: row.last_lesson_id,
            customerId: row.customer_id,
            rule
          });
          bucket.sent++;
          logger.info({ courseId, email: row.email, customerId: row.customer_id }, 'Inactivity reminder sent');
        } catch (err) {
          bucket.failed++;
          logger.error({ err, courseId, email: row.email }, 'Inactivity reminder send failed');
        }
      }
      if (eligible.length) logger.info({ courseId, ...bucket }, 'Inactivity job finished');
    }

    return summary;
  }

  function startScheduler() {
    setTimeout(() => {
      runReminderJob().catch((err) => logger.error({ err }, 'Reminder job (initial) error'));
    }, 60 * 1000).unref();
    setInterval(() => {
      runReminderJob().catch((err) => logger.error({ err }, 'Reminder job (interval) error'));
    }, SCHEDULER_INTERVAL_MS).unref();
  }

  // ─── Admin: preview / test-send / status / run-now ─────────────────────
  async function renderPreviewForRule(ruleKey, overrides = {}) {
    const rule = await reminderConfig.loadRule(pool, ruleKey);
    if (!rule) return null;
    const name = overrides.name || 'ナミ';
    const token = overrides.token || 'PREVIEW_TOKEN';
    if (ruleKey === RULE_KEYS.UPSELL_21D) {
      return renderRule(rule, upsellVars({ name, token, rule }));
    }
    if (ruleKey === RULE_KEYS.FLASH_45D) {
      const flashToken = signFlashToken({
        jwt,
        jwtSecret,
        customerId: 0,
        email: 'preview@example.com',
        windowHours: rule.config.flash_window_hours ?? 48
      });
      return renderRule(rule, flashVars({ name, token, flashToken, rule }));
    }
    // Inactivity rules
    const courseId = ruleKey === RULE_KEYS.INACTIVITY_COURSE_2 ? 'course-2' : 'course-1';
    const course = courses?.[courseId];
    const lessonTitle = overrides.lastLessonTitle || course?.lessons?.[2]?.title || '';
    return renderRule(rule, inactivityVars({ name, token, courseId, lastLessonTitle: lessonTitle }));
  }

  app.get('/api/admin/reminders/preview/course-2-upsell', authMiddleware, async (req, res) => {
    const name = typeof req.query.name === 'string' ? req.query.name : 'ナミ';
    const token = typeof req.query.token === 'string' ? req.query.token : 'PREVIEW_TOKEN';
    try {
      const out = await renderPreviewForRule(RULE_KEYS.UPSELL_21D, { name, token });
      if (!out) return res.status(404).json({ error: 'Rule not found' });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(out.html);
    } catch (err) {
      logger.error({ err }, 'Preview upsell failed');
      res.status(500).json({ error: 'Preview failed' });
    }
  });

  app.get('/api/admin/reminders/preview/course-2-flash', authMiddleware, async (req, res) => {
    const name = typeof req.query.name === 'string' ? req.query.name : 'ナミ';
    const token = typeof req.query.token === 'string' ? req.query.token : 'PREVIEW_TOKEN';
    try {
      const out = await renderPreviewForRule(RULE_KEYS.FLASH_45D, { name, token });
      if (!out) return res.status(404).json({ error: 'Rule not found' });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(out.html);
    } catch (err) {
      logger.error({ err }, 'Preview flash failed');
      res.status(500).json({ error: 'Preview failed' });
    }
  });

  app.get('/api/admin/reminders/preview/inactivity', authMiddleware, async (req, res) => {
    const name = typeof req.query.name === 'string' ? req.query.name : 'ナミ';
    const token = typeof req.query.token === 'string' ? req.query.token : 'PREVIEW_TOKEN';
    const courseId = typeof req.query.course === 'string' && courses?.[req.query.course]
      ? req.query.course
      : 'course-1';
    const lastLessonTitle = typeof req.query.lesson === 'string' ? req.query.lesson : undefined;
    const ruleKey = courseId === 'course-2' ? RULE_KEYS.INACTIVITY_COURSE_2 : RULE_KEYS.INACTIVITY_COURSE_1;
    try {
      const out = await renderPreviewForRule(ruleKey, { name, token, lastLessonTitle });
      if (!out) return res.status(404).json({ error: 'Rule not found' });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(out.html);
    } catch (err) {
      logger.error({ err }, 'Preview inactivity failed');
      res.status(500).json({ error: 'Preview failed' });
    }
  });

  app.post('/api/admin/reminders/test-send', authMiddleware, async (req, res) => {
    try {
      const { email, name, token, type } = req.body || {};
      if (!email || typeof email !== 'string') {
        return res.status(400).json({ error: 'email required' });
      }
      const courseToken = token || 'TEST_TOKEN';
      let ruleKey;
      let overrides = {};
      if (type === 'flash') {
        ruleKey = RULE_KEYS.FLASH_45D;
      } else if (type === 'inactivity') {
        const courseId = req.body?.course && courses?.[req.body.course] ? req.body.course : 'course-1';
        ruleKey = courseId === 'course-2' ? RULE_KEYS.INACTIVITY_COURSE_2 : RULE_KEYS.INACTIVITY_COURSE_1;
        overrides.lastLessonTitle = req.body?.lessonTitle;
      } else {
        ruleKey = RULE_KEYS.UPSELL_21D;
      }
      const out = await renderPreviewForRule(ruleKey, { name: name || 'ナミ', token: courseToken, ...overrides });
      if (!out) return res.status(404).json({ error: 'Rule not found' });
      await transporter.sendMail({ from: smtpFrom, to: email, subject: out.subject, html: out.html });
      res.json({ ok: true, sentTo: email, type: type || 'upsell' });
    } catch (err) {
      logger.error({ err }, 'Reminder test-send failed');
      res.status(500).json({ error: 'send failed' });
    }
  });

  app.get('/api/admin/reminders/status', authMiddleware, async (_req, res) => {
    try {
      const [upsellRule, flashRule, inact1Rule, inact2Rule] = await Promise.all([
        reminderConfig.loadRule(pool, RULE_KEYS.UPSELL_21D),
        reminderConfig.loadRule(pool, RULE_KEYS.FLASH_45D),
        reminderConfig.loadRule(pool, RULE_KEYS.INACTIVITY_COURSE_1),
        reminderConfig.loadRule(pool, RULE_KEYS.INACTIVITY_COURSE_2)
      ]);

      const eligible21 = upsellRule
        ? await findEligibleForType(REMINDER_TYPES[RULE_KEYS.UPSELL_21D], upsellRule.delayDays)
        : [];
      const eligible45 = flashRule
        ? await findEligibleForType(REMINDER_TYPES[RULE_KEYS.FLASH_45D], flashRule.delayDays)
        : [];

      const { rows: counts } = await pool.query(
        `SELECT reminder_type, COUNT(*)::int AS count FROM nb_course_reminders GROUP BY reminder_type`
      );
      const totals = {};
      for (const r of counts) totals[r.reminder_type] = r.count;

      async function inactBlock(courseId, rule) {
        if (!rule) return null;
        const rows = await findInactiveStudents({
          courseId,
          reminderType: REMINDER_TYPES[INACTIVITY_BY_COURSE[courseId]],
          days: rule.delayDays
        });
        return {
          ruleKey: rule.ruleKey,
          type: REMINDER_TYPES[INACTIVITY_BY_COURSE[courseId]],
          delayDays: rule.delayDays,
          enabled: rule.enabled,
          eligibleNow: rows.length,
          totalSent: totals[REMINDER_TYPES[INACTIVITY_BY_COURSE[courseId]]] || 0,
          eligible: rows.map((r) => ({
            email: r.email,
            name: r.name,
            customerId: r.customer_id,
            lastLessonId: r.last_lesson_id,
            lastWatchedAt: r.last_watched_at
          }))
        };
      }

      res.json({
        upsell21d: upsellRule ? {
          ruleKey: upsellRule.ruleKey,
          type: REMINDER_TYPES[RULE_KEYS.UPSELL_21D],
          delayDays: upsellRule.delayDays,
          enabled: upsellRule.enabled,
          eligibleNow: eligible21.length,
          totalSent: totals[REMINDER_TYPES[RULE_KEYS.UPSELL_21D]] || 0,
          eligible: eligible21.map((r) => ({ email: r.email, name: r.name, customerId: r.customer_id }))
        } : null,
        flash45d: flashRule ? {
          ruleKey: flashRule.ruleKey,
          type: REMINDER_TYPES[RULE_KEYS.FLASH_45D],
          delayDays: flashRule.delayDays,
          enabled: flashRule.enabled,
          windowHours: flashRule.config.flash_window_hours ?? 48,
          flashPrice: flashRule.config.flash_price,
          eligibleNow: eligible45.length,
          totalSent: totals[REMINDER_TYPES[RULE_KEYS.FLASH_45D]] || 0,
          eligible: eligible45.map((r) => ({ email: r.email, name: r.name, customerId: r.customer_id }))
        } : null,
        inactivity: {
          'course-1': await inactBlock('course-1', inact1Rule),
          'course-2': await inactBlock('course-2', inact2Rule)
        }
      });
    } catch (err) {
      logger.error({ err }, 'Reminder status failed');
      res.status(500).json({ error: 'status failed' });
    }
  });

  app.post('/api/admin/reminders/run-now', authMiddleware, async (_req, res) => {
    try {
      const result = await runReminderJob();
      res.json({ ok: true, ...result });
    } catch (err) {
      logger.error({ err }, 'Reminder run-now failed');
      res.status(500).json({ error: 'run failed' });
    }
  });

  return {
    ensureReminderTable,
    runReminderJob,
    startScheduler,
    buildCourse2UpsellBlockHtml,
    verifyFlashToken: (token) => verifyFlashToken({ jwt, jwtSecret, token }),
    renderPreviewForRule,
    findEligibleForType,
    findInactiveStudents,
    REMINDER_TYPES,
    INACTIVITY_BY_COURSE
  };
}

module.exports = {
  createCourseReminders,
  buildCourse2UpsellBlockHtml
};
