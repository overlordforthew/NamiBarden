const REMINDER_DELAY_DAYS = 21;
const SCHEDULER_INTERVAL_MS = 60 * 60 * 1000; // hourly sweep
const REMINDER_TYPE = 'course-2-upsell-21d';

function buildCourse2UpsellBlockHtml({ token, siteUrl, variant = 'email' }) {
  // The "Next Step" card shown in the confirmation email AND the 21-day reminder.
  // Shared so copy drifts can't happen — one source of truth.
  const link = `${siteUrl}/online-course-2?token=${token}`;
  const wrapperTop = variant === 'standalone'
    ? ''
    : `<hr style="border:none;border-top:1px solid #E8DFD3;margin:40px 0 28px;">`;
  return `${wrapperTop}
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
                    <span style="text-decoration:line-through;">¥9,800</span>
                    <span style="color:#A8895E;font-weight:500;font-size:1.05rem;margin-left:8px;">¥7,000</span>
                    <span style="margin-left:4px;font-size:0.8rem;">（コース1受講者限定価格）</span>
                  </p>
                  <p style="margin:0;">
                    <a href="${link}" style="display:inline-block;padding:10px 26px;background:transparent;border:1px solid #A8895E;color:#A8895E;text-decoration:none;border-radius:2px;font-size:0.88rem;letter-spacing:0.04em;">コース2の詳細を見る →</a>
                  </p>
                </div>`;
}

function buildCourse2ReminderEmail({ name, token, siteUrl, escapeHtml }) {
  const greeting = name ? `${escapeHtml(name)}様` : '';
  const block = buildCourse2UpsellBlockHtml({ token, siteUrl, variant: 'standalone' });
  return `<div style="max-width:600px;margin:0 auto;font-family:'Helvetica Neue',Arial,sans-serif;color:#2C2419;background:#FAF7F2;padding:40px;">
                <h2 style="font-size:1.4rem;color:#2C2419;margin-bottom:24px;">コース1はいかがでしたか？</h2>
                <p style="line-height:1.8;margin-bottom:16px;">${greeting}</p>
                <p style="line-height:1.8;margin-bottom:16px;">「愛を引き寄せる心の授業」をご購入いただいてから3週間が経ちました。いかがお過ごしでしょうか。</p>
                <p style="line-height:1.8;margin-bottom:16px;">自分自身を愛し、受け入れるプロセスは、人生を変える最初の一歩です。そして、その愛をパートナーシップで深めていく次のステージがあります。</p>
                <p style="line-height:1.8;margin-bottom:24px;">コース1を受講してくださったあなたに、コース2「愛を深める心の授業」を特別価格でご案内します。</p>
                ${block}
                <p style="line-height:1.8;font-size:0.9rem;color:#8B7E6E;margin-top:32px;">この特別価格はコース1を受講いただいた方だけのご案内です。受講の感想やご質問もお気軽にお返事ください。</p>
                <hr style="border:none;border-top:1px solid #E8DFD3;margin:32px 0;">
                <p style="font-size:0.8rem;color:#A99E8F;text-align:center;">Nami Barden — namibarden.com</p>
              </div>`;
}

function createCourseReminders({
  app,
  pool,
  transporter,
  logger,
  siteUrl,
  smtpFrom,
  escapeHtml,
  authMiddleware
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

  async function findEligible() {
    // Course-1 buyers from 21+ days ago who don't have Course 2 access
    // and haven't received this reminder yet.
    const { rows } = await pool.query(
      `SELECT a.customer_id, a.access_token, a.email, c.name
         FROM nb_course_access a
         JOIN nb_customers c ON c.id = a.customer_id
        WHERE a.course_id = 'course-1'
          AND a.purchased_at <= NOW() - INTERVAL '${REMINDER_DELAY_DAYS} days'
          AND NOT EXISTS (
            SELECT 1 FROM nb_course_access a2
             WHERE a2.customer_id = a.customer_id AND a2.course_id = 'course-2'
          )
          AND NOT EXISTS (
            SELECT 1 FROM nb_course_reminders r
             WHERE r.customer_id = a.customer_id AND r.reminder_type = $1
          )`,
      [REMINDER_TYPE]
    );
    return rows;
  }

  async function sendReminder({ email, name, token, customerId }) {
    const html = buildCourse2ReminderEmail({ name, token, siteUrl, escapeHtml });
    await transporter.sendMail({
      from: smtpFrom,
      to: email,
      subject: '【NamiBarden】コース1はいかがでしたか？— コース2の特別ご案内',
      html
    });
    if (customerId) {
      await pool.query(
        `INSERT INTO nb_course_reminders (customer_id, email, reminder_type)
         VALUES ($1, $2, $3)
         ON CONFLICT (customer_id, reminder_type) DO NOTHING`,
        [customerId, email, REMINDER_TYPE]
      );
    }
  }

  async function runReminderJob() {
    let eligible;
    try {
      eligible = await findEligible();
    } catch (err) {
      logger.error({ err }, 'Course reminder: findEligible failed');
      return { attempted: 0, sent: 0, failed: 0 };
    }
    let sent = 0;
    let failed = 0;
    for (const row of eligible) {
      try {
        await sendReminder({
          email: row.email,
          name: row.name,
          token: row.access_token,
          customerId: row.customer_id
        });
        sent++;
        logger.info({ email: row.email, customerId: row.customer_id }, 'Course 2 reminder sent');
      } catch (err) {
        failed++;
        logger.error({ err, email: row.email }, 'Course reminder send failed');
      }
    }
    if (eligible.length) {
      logger.info({ attempted: eligible.length, sent, failed }, 'Course reminder job finished');
    }
    return { attempted: eligible.length, sent, failed };
  }

  function startScheduler() {
    // Fire the first sweep 60 seconds after boot so the app isn't racing DB/SMTP warmup.
    setTimeout(() => {
      runReminderJob().catch((err) => logger.error({ err }, 'Reminder job (initial) error'));
    }, 60 * 1000).unref();
    setInterval(() => {
      runReminderJob().catch((err) => logger.error({ err }, 'Reminder job (interval) error'));
    }, SCHEDULER_INTERVAL_MS).unref();
  }

  // ---- Admin routes ----
  app.get('/api/admin/reminders/preview/course-2-upsell', authMiddleware, (req, res) => {
    const name = typeof req.query.name === 'string' ? req.query.name : 'Nami';
    const token = typeof req.query.token === 'string' ? req.query.token : 'PREVIEW_TOKEN';
    const html = buildCourse2ReminderEmail({ name, token, siteUrl, escapeHtml });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });

  app.post('/api/admin/reminders/test-send', authMiddleware, async (req, res) => {
    try {
      const { email, name, token } = req.body || {};
      if (!email || typeof email !== 'string') {
        return res.status(400).json({ error: 'email required' });
      }
      await sendReminder({
        email,
        name: name || 'Nami',
        token: token || 'TEST_TOKEN',
        customerId: null
      });
      res.json({ ok: true, sentTo: email });
    } catch (err) {
      logger.error({ err }, 'Reminder test-send failed');
      res.status(500).json({ error: 'send failed' });
    }
  });

  app.get('/api/admin/reminders/status', authMiddleware, async (_req, res) => {
    try {
      const eligible = await findEligible();
      const { rows: sentRows } = await pool.query(
        `SELECT COUNT(*)::int AS count FROM nb_course_reminders WHERE reminder_type = $1`,
        [REMINDER_TYPE]
      );
      res.json({
        reminderType: REMINDER_TYPE,
        delayDays: REMINDER_DELAY_DAYS,
        eligibleNow: eligible.length,
        totalSent: sentRows[0]?.count || 0,
        eligible: eligible.map((r) => ({
          email: r.email,
          name: r.name,
          customerId: r.customer_id
        }))
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
    buildCourse2ReminderEmail
  };
}

module.exports = {
  createCourseReminders,
  buildCourse2UpsellBlockHtml,
  buildCourse2ReminderEmail
};
