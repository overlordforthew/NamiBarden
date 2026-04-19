const REMINDER_21D_DAYS = 21;
const REMINDER_45D_DAYS = 45;
const FLASH_WINDOW_HOURS = 48;
const SCHEDULER_INTERVAL_MS = 60 * 60 * 1000; // hourly sweep
const REMINDER_21D_TYPE = 'course-2-upsell-21d';
const REMINDER_45D_TYPE = 'course-2-flash-45d';
const UPSELL_PRICE = 7000;
const FLASH_PRICE = 6500;
const ORIGINAL_PRICE = 9800;

function signFlashToken({ jwt, jwtSecret, customerId, email }) {
  return jwt.sign(
    { sub: String(customerId), email, kind: 'course-2-flash' },
    jwtSecret,
    { expiresIn: `${FLASH_WINDOW_HOURS}h` }
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

function buildCourse2UpsellBlockHtml({ token, siteUrl }) {
  const link = `${siteUrl}/online-course-2?token=${token}`;
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
                    <span style="text-decoration:line-through;">¥${ORIGINAL_PRICE.toLocaleString()}</span>
                    <span style="color:#A8895E;font-weight:500;font-size:1.05rem;margin-left:8px;">¥${UPSELL_PRICE.toLocaleString()}</span>
                    <span style="margin-left:4px;font-size:0.8rem;">（コース1受講者限定価格）</span>
                  </p>
                  <p style="margin:0;">
                    <a href="${link}" style="display:inline-block;padding:10px 26px;background:transparent;border:1px solid #A8895E;color:#A8895E;text-decoration:none;border-radius:2px;font-size:0.88rem;letter-spacing:0.04em;">コース2の詳細を見る →</a>
                  </p>
                </div>`;
}

function buildCourse2Reminder21dEmail({ name, token, siteUrl, escapeHtml }) {
  const greeting = name ? `${escapeHtml(name)}様` : '';
  const block = buildCourse2UpsellBlockHtml({ token, siteUrl });
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

function buildCourse2Reminder45dFlashEmail({ name, token, flashToken, siteUrl, escapeHtml }) {
  const greeting = name ? `${escapeHtml(name)}様` : '';
  const link = `${siteUrl}/online-course-2?token=${token}&flash=${flashToken}`;
  return `<div style="max-width:600px;margin:0 auto;font-family:'Helvetica Neue',Arial,sans-serif;color:#2C2419;background:#FAF7F2;padding:40px;">
                <h2 style="font-size:1.4rem;color:#2C2419;margin-bottom:24px;">最後のご案内 — 48時間限定</h2>
                <p style="line-height:1.8;margin-bottom:16px;">${greeting}</p>
                <p style="line-height:1.8;margin-bottom:16px;">「愛を引き寄せる心の授業」からもうすぐ6週間。あなたの心の変化を、いま私はそっと願っています。</p>
                <p style="line-height:1.8;margin-bottom:16px;">コース2「愛を深める心の授業」を特別価格でご案内してきましたが、まだ迷っている方のために、最後のお得なご案内をさせてください。</p>
                <p style="line-height:1.8;margin-bottom:24px;">このメールから<strong style="color:#A8895E;">48時間限定</strong>で、コース2を <strong style="color:#A8895E;">¥${FLASH_PRICE.toLocaleString()}</strong> でご受講いただけます。</p>

                <div style="background:#FBF3E8;padding:28px 24px;border-radius:4px;border:2px solid #A8895E;margin:24px 0;">
                  <p style="font-size:0.72rem;color:#A8895E;letter-spacing:0.12em;margin:0 0 8px;text-transform:uppercase;">Flash Deal — 48h Only</p>
                  <h3 style="font-size:1.1rem;color:#2C2419;margin:0 0 12px;font-weight:500;">コース2「愛を深める心の授業」</h3>
                  <p style="font-size:0.9rem;color:#5C4F3D;line-height:1.8;margin:0 0 14px;">パートナーシップの深い課題へ。意識の4ステップ・5つの愛の言語・男性性と女性性・許しのプロセスまで。</p>
                  <p style="font-size:0.95rem;color:#8B7E6E;margin:0 0 18px;">
                    <span style="text-decoration:line-through;">¥${ORIGINAL_PRICE.toLocaleString()}</span>
                    <span style="text-decoration:line-through;margin-left:10px;">¥${UPSELL_PRICE.toLocaleString()}</span>
                    <span style="color:#A8895E;font-weight:600;font-size:1.25rem;margin-left:10px;">¥${FLASH_PRICE.toLocaleString()}</span>
                  </p>
                  <p style="margin:0;">
                    <a href="${link}" style="display:inline-block;padding:12px 32px;background:#A8895E;color:#fff;text-decoration:none;border-radius:2px;font-size:0.92rem;letter-spacing:0.04em;">48時間限定価格で申し込む →</a>
                  </p>
                  <p style="font-size:0.78rem;color:#A99E8F;margin:14px 0 0;">このリンクはあなた専用・48時間で無効になります。</p>
                </div>

                <p style="line-height:1.8;font-size:0.9rem;color:#8B7E6E;margin-top:32px;">もしご自身のタイミングではないと感じたら、無理なさらないでくださいne。あなたの心の歩みを大切に。</p>
                <hr style="border:none;border-top:1px solid #E8DFD3;margin:32px 0;">
                <p style="font-size:0.8rem;color:#A99E8F;text-align:center;">Nami Barden — namibarden.com</p>
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

  async function findEligible(reminderType, delayDays) {
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

  async function markSent({ customerId, email, reminderType }) {
    if (!customerId) return;
    await pool.query(
      `INSERT INTO nb_course_reminders (customer_id, email, reminder_type)
       VALUES ($1, $2, $3)
       ON CONFLICT (customer_id, reminder_type) DO NOTHING`,
      [customerId, email, reminderType]
    );
  }

  async function send21dReminder({ email, name, token, customerId }) {
    const html = buildCourse2Reminder21dEmail({ name, token, siteUrl, escapeHtml });
    await transporter.sendMail({
      from: smtpFrom,
      to: email,
      subject: '【NamiBarden】コース1はいかがでしたか？— コース2の特別ご案内',
      html
    });
    await markSent({ customerId, email, reminderType: REMINDER_21D_TYPE });
  }

  async function send45dFlashReminder({ email, name, token, customerId }) {
    const flashToken = signFlashToken({ jwt, jwtSecret, customerId, email });
    const html = buildCourse2Reminder45dFlashEmail({ name, token, flashToken, siteUrl, escapeHtml });
    await transporter.sendMail({
      from: smtpFrom,
      to: email,
      subject: '【NamiBarden】48時間限定 — コース2 フラッシュ価格のご案内',
      html
    });
    await markSent({ customerId, email, reminderType: REMINDER_45D_TYPE });
  }

  async function runReminderJob() {
    const summary = { '21d': { attempted: 0, sent: 0, failed: 0 }, '45d': { attempted: 0, sent: 0, failed: 0 } };

    const jobs = [
      { tag: '21d', type: REMINDER_21D_TYPE, delay: REMINDER_21D_DAYS, send: send21dReminder },
      { tag: '45d', type: REMINDER_45D_TYPE, delay: REMINDER_45D_DAYS, send: send45dFlashReminder }
    ];

    for (const job of jobs) {
      let eligible;
      try {
        eligible = await findEligible(job.type, job.delay);
      } catch (err) {
        logger.error({ err, job: job.tag }, 'Course reminder: findEligible failed');
        continue;
      }
      summary[job.tag].attempted = eligible.length;
      for (const row of eligible) {
        try {
          await job.send({
            email: row.email,
            name: row.name,
            token: row.access_token,
            customerId: row.customer_id
          });
          summary[job.tag].sent++;
          logger.info({ tag: job.tag, email: row.email, customerId: row.customer_id }, 'Course reminder sent');
        } catch (err) {
          summary[job.tag].failed++;
          logger.error({ err, tag: job.tag, email: row.email }, 'Course reminder send failed');
        }
      }
      if (eligible.length) {
        logger.info({ job: job.tag, ...summary[job.tag] }, 'Course reminder job finished');
      }
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

  // ---- Admin routes ----
  app.get('/api/admin/reminders/preview/course-2-upsell', authMiddleware, (req, res) => {
    const name = typeof req.query.name === 'string' ? req.query.name : 'Nami';
    const token = typeof req.query.token === 'string' ? req.query.token : 'PREVIEW_TOKEN';
    const html = buildCourse2Reminder21dEmail({ name, token, siteUrl, escapeHtml });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });

  app.get('/api/admin/reminders/preview/course-2-flash', authMiddleware, (req, res) => {
    const name = typeof req.query.name === 'string' ? req.query.name : 'Nami';
    const token = typeof req.query.token === 'string' ? req.query.token : 'PREVIEW_TOKEN';
    const flashToken = signFlashToken({ jwt, jwtSecret, customerId: 0, email: 'preview@example.com' });
    const html = buildCourse2Reminder45dFlashEmail({ name, token, flashToken, siteUrl, escapeHtml });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });

  app.post('/api/admin/reminders/test-send', authMiddleware, async (req, res) => {
    try {
      const { email, name, token, type } = req.body || {};
      if (!email || typeof email !== 'string') {
        return res.status(400).json({ error: 'email required' });
      }
      const courseToken = token || 'TEST_TOKEN';
      if (type === 'flash') {
        await send45dFlashReminder({
          email,
          name: name || 'Nami',
          token: courseToken,
          customerId: null
        });
      } else {
        await send21dReminder({
          email,
          name: name || 'Nami',
          token: courseToken,
          customerId: null
        });
      }
      res.json({ ok: true, sentTo: email, type: type === 'flash' ? 'flash' : 'upsell' });
    } catch (err) {
      logger.error({ err }, 'Reminder test-send failed');
      res.status(500).json({ error: 'send failed' });
    }
  });

  app.get('/api/admin/reminders/status', authMiddleware, async (_req, res) => {
    try {
      const eligible21 = await findEligible(REMINDER_21D_TYPE, REMINDER_21D_DAYS);
      const eligible45 = await findEligible(REMINDER_45D_TYPE, REMINDER_45D_DAYS);
      const { rows: counts } = await pool.query(
        `SELECT reminder_type, COUNT(*)::int AS count
           FROM nb_course_reminders
          GROUP BY reminder_type`
      );
      const totals = {};
      for (const r of counts) totals[r.reminder_type] = r.count;
      res.json({
        upsell21d: {
          type: REMINDER_21D_TYPE,
          delayDays: REMINDER_21D_DAYS,
          eligibleNow: eligible21.length,
          totalSent: totals[REMINDER_21D_TYPE] || 0,
          eligible: eligible21.map((r) => ({ email: r.email, name: r.name, customerId: r.customer_id }))
        },
        flash45d: {
          type: REMINDER_45D_TYPE,
          delayDays: REMINDER_45D_DAYS,
          windowHours: FLASH_WINDOW_HOURS,
          flashPrice: FLASH_PRICE,
          eligibleNow: eligible45.length,
          totalSent: totals[REMINDER_45D_TYPE] || 0,
          eligible: eligible45.map((r) => ({ email: r.email, name: r.name, customerId: r.customer_id }))
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
    constants: {
      UPSELL_PRICE,
      FLASH_PRICE,
      ORIGINAL_PRICE,
      FLASH_WINDOW_HOURS
    }
  };
}

module.exports = {
  createCourseReminders,
  buildCourse2UpsellBlockHtml
};
