function createAdminRoutes({
  app,
  pool,
  logger,
  authMiddleware,
  bcrypt,
  jwt,
  jwtSecret,
  setAuthCookie,
  clearAuthCookie,
  getIP,
  rateLimit,
  stringify,
  parse,
  uploadImportCsv,
  multer,
  generateToken,
  transporter,
  smtpFrom,
  siteUrl,
  uuidv4,
  injectTracking,
  sendWhatsApp,
  namiJid
}) {
  app.post('/api/admin/login', async (req, res) => {
    try {
      const ip = getIP(req);
      if (!rateLimit(`login:${ip}`, 5, 300000)) {
        return res.status(429).json({ error: 'Too many login attempts' });
      }
      const { password } = req.body;
      if (!password) return res.status(400).json({ error: 'Password required' });

      let valid = false;
      const result = await pool.query('SELECT password_hash FROM nb_admin ORDER BY id LIMIT 1');
      if (result.rows.length > 0) {
        valid = await bcrypt.compare(password, result.rows[0].password_hash);
      }

      if (!valid) return res.status(401).json({ error: 'Invalid password' });
      const token = jwt.sign({ role: 'admin' }, jwtSecret, { expiresIn: '24h' });
      setAuthCookie(res, 'nb_admin_token', token, 24 * 60 * 60 * 1000);
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e }, 'Admin login error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.post('/api/admin/logout', (_req, res) => {
    clearAuthCookie(res, 'nb_admin_token');
    res.json({ ok: true });
  });

  app.get('/api/admin/check', authMiddleware, (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/admin/stats', authMiddleware, async (_req, res) => {
    try {
      const [subs, contacts, campaigns, recent, sources, growth, alertSummary, recentAlerts] = await Promise.all([
        pool.query(`SELECT
          COUNT(*) FILTER (WHERE status = 'active') AS active,
          COUNT(*) FILTER (WHERE status = 'unsubscribed') AS unsubscribed,
          COUNT(*) FILTER (WHERE status = 'bounced') AS bounced,
          COUNT(*) AS total
          FROM nb_subscribers`),
        pool.query('SELECT COUNT(*) AS total FROM nb_contacts'),
        pool.query(`SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE status = 'sent') AS sent,
          COALESCE(SUM(open_count), 0) AS total_opens,
          COALESCE(SUM(click_count), 0) AS total_clicks
          FROM nb_campaigns`),
        pool.query(`SELECT id, subject, status, sent_count, open_count, click_count, sent_at
          FROM nb_campaigns ORDER BY created_at DESC LIMIT 5`),
        pool.query(`SELECT source, COUNT(*) AS count FROM nb_subscribers
          WHERE status = 'active' GROUP BY source ORDER BY count DESC`),
        pool.query(`SELECT DATE(created_at) AS date, COUNT(*) AS count
          FROM nb_subscribers WHERE created_at > NOW() - INTERVAL '30 days'
          GROUP BY DATE(created_at) ORDER BY date`),
        pool.query(`SELECT
          COUNT(*) FILTER (WHERE status = 'open') AS open,
          COUNT(*) FILTER (WHERE status = 'acknowledged') AS acknowledged,
          COUNT(*) FILTER (WHERE status = 'resolved') AS resolved,
          COUNT(*) FILTER (WHERE status = 'open' AND severity = 'critical') AS critical_open
          FROM nb_operational_alerts`),
        pool.query(`SELECT id, source, severity, title, status, last_seen
          FROM nb_operational_alerts
          ORDER BY
            CASE status
              WHEN 'open' THEN 0
              WHEN 'acknowledged' THEN 1
              ELSE 2
            END,
            last_seen DESC
          LIMIT 5`)
      ]);

      res.json({
        subscribers: subs.rows[0],
        contacts: contacts.rows[0],
        campaigns: campaigns.rows[0],
        recentCampaigns: recent.rows,
        sources: sources.rows,
        growth: growth.rows,
        alerts: alertSummary.rows[0],
        recentAlerts: recentAlerts.rows.map((row) => ({
          id: row.id,
          source: row.source,
          severity: row.severity,
          title: row.title,
          status: row.status,
          lastSeen: row.last_seen
        }))
      });
    } catch (e) {
      logger.error({ err: e }, 'Stats error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.get('/api/admin/subscribers', authMiddleware, async (req, res) => {
    try {
      const { page = 1, limit = 50, status, source, search, tag } = req.query;
      const safeLimit = Math.min(Math.max(parseInt(limit) || 50, 1), 200);
      const safePage = Math.max(parseInt(page) || 1, 1);
      const offset = (safePage - 1) * safeLimit;
      const conditions = [];
      const params = [];
      let idx = 1;

      if (status) {
        conditions.push(`status = $${idx++}`);
        params.push(status);
      }
      if (source) {
        conditions.push(`source = $${idx++}`);
        params.push(source);
      }
      if (search) {
        conditions.push(`(email ILIKE $${idx} OR name ILIKE $${idx})`);
        params.push(`%${search}%`);
        idx++;
      }
      if (tag) {
        conditions.push(`$${idx++} = ANY(tags)`);
        params.push(tag);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const countQ = await pool.query(`SELECT COUNT(*) FROM nb_subscribers ${where}`, params);
      params.push(safeLimit, offset);
      const dataQ = await pool.query(
        `SELECT id, email, name, source, status, tags, created_at, updated_at
         FROM nb_subscribers ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx}`,
        params
      );

      res.json({
        subscribers: dataQ.rows,
        total: parseInt(countQ.rows[0].count, 10),
        page: safePage,
        limit: safeLimit
      });
    } catch (e) {
      logger.error({ err: e }, 'Subscribers list error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.get('/api/admin/subscribers/export', authMiddleware, async (req, res) => {
    try {
      const { status } = req.query;
      const where = status ? 'WHERE status = $1' : '';
      const params = status ? [status] : [];
      const result = await pool.query(
        `SELECT email, name, source, status, array_to_string(tags, ',') AS tags, created_at
         FROM nb_subscribers ${where} ORDER BY created_at DESC LIMIT 50000`,
        params
      );
      const csv = stringify(result.rows, { header: true });
      res.set({ 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename=subscribers.csv' });
      res.send(csv);
    } catch (e) {
      logger.error({ err: e }, 'Export error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.post('/api/admin/import', authMiddleware, (req, res) => {
    uploadImportCsv(req, res, async (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'CSV file must be 2 MB or smaller' });
        }
        return res.status(400).json({ error: 'Invalid upload. Please try again with a CSV file.' });
      }
      if (err) {
        logger.error({ err }, 'Import upload error');
        return res.status(400).json({ error: 'Upload failed. Please try again.' });
      }

      try {
        if (!req.file) return res.status(400).json({ error: 'CSV file required' });
        const records = parse(req.file.buffer.toString(), { columns: true, skip_empty_lines: true, trim: true });
        let imported = 0;
        let skipped = 0;
        for (const row of records) {
          const email = (row.email || row.Email || '').trim().toLowerCase();
          if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            skipped++;
            continue;
          }
          const name = (row.name || row.Name || '').trim() || null;
          const source = (row.source || row.Source || 'import').trim();
          const token = generateToken();
          const result = await pool.query(
            `INSERT INTO nb_subscribers (email, name, source, unsubscribe_token)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (email) DO NOTHING RETURNING id`,
            [email, name, source, token]
          );
          if (result.rows.length > 0) imported++;
          else skipped++;
        }
        res.json({ imported, skipped, total: records.length });
      } catch (e) {
        logger.error({ err: e }, 'Import error');
        res.status(500).json({ error: 'Import failed. Please check file format and try again.' });
      }
    });
  });

  app.post('/api/admin/subscribers/:id/tags', authMiddleware, async (req, res) => {
    try {
      const { tags } = req.body;
      if (!Array.isArray(tags)) return res.status(400).json({ error: 'Tags must be an array' });
      const result = await pool.query(
        'UPDATE nb_subscribers SET tags = $1, updated_at = NOW() WHERE id = $2 RETURNING id, tags',
        [tags, req.params.id]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Subscriber not found' });
      res.json(result.rows[0]);
    } catch (e) {
      logger.error({ err: e }, 'Tags error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.delete('/api/admin/subscribers/:id', authMiddleware, async (req, res) => {
    try {
      const result = await pool.query('DELETE FROM nb_subscribers WHERE id = $1 RETURNING id', [req.params.id]);
      if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e }, 'Delete subscriber error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.get('/api/admin/contacts', authMiddleware, async (req, res) => {
    try {
      const { page = 1, limit = 50 } = req.query;
      const safeLimit = Math.min(Math.max(parseInt(limit) || 50, 1), 200);
      const safePage = Math.max(parseInt(page) || 1, 1);
      const offset = (safePage - 1) * safeLimit;
      const [countQ, dataQ] = await Promise.all([
        pool.query('SELECT COUNT(*) FROM nb_contacts'),
        pool.query('SELECT * FROM nb_contacts ORDER BY created_at DESC LIMIT $1 OFFSET $2', [safeLimit, offset])
      ]);
      res.json({
        contacts: dataQ.rows,
        total: parseInt(countQ.rows[0].count, 10),
        page: safePage,
        limit: safeLimit
      });
    } catch (e) {
      logger.error({ err: e }, 'Contacts error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.get('/api/admin/campaigns', authMiddleware, async (req, res) => {
    try {
      const { page = 1, limit = 50 } = req.query;
      const safeLimit = Math.min(Math.max(parseInt(limit) || 50, 1), 200);
      const safePage = Math.max(parseInt(page) || 1, 1);
      const offset = (safePage - 1) * safeLimit;
      const [countQ, dataQ] = await Promise.all([
        pool.query('SELECT COUNT(*) FROM nb_campaigns'),
        pool.query(
          `SELECT id, subject, status, segment, total_count, sent_count, open_count, click_count,
                  bounce_count, unsub_count, created_at, sent_at
           FROM nb_campaigns ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
          [safeLimit, offset]
        )
      ]);
      res.json({
        campaigns: dataQ.rows,
        total: parseInt(countQ.rows[0].count, 10),
        page: safePage,
        limit: safeLimit
      });
    } catch (e) {
      logger.error({ err: e }, 'Campaigns error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.get('/api/admin/campaigns/:id', authMiddleware, async (req, res) => {
    try {
      const { page = 1, limit = 100 } = req.query;
      const safeLimit = Math.min(Math.max(parseInt(limit) || 100, 1), 500);
      const safePage = Math.max(parseInt(page) || 1, 1);
      const offset = (safePage - 1) * safeLimit;

      const campaign = await pool.query('SELECT * FROM nb_campaigns WHERE id = $1', [req.params.id]);
      if (campaign.rows.length === 0) return res.status(404).json({ error: 'Not found' });

      const [countQ, recipients] = await Promise.all([
        pool.query('SELECT COUNT(*) FROM nb_campaign_recipients WHERE campaign_id = $1', [req.params.id]),
        pool.query(
          `SELECT r.id, r.email, r.status, r.opened_at, r.clicked_at, r.bounced_at
           FROM nb_campaign_recipients r WHERE r.campaign_id = $1 ORDER BY r.created_at LIMIT $2 OFFSET $3`,
          [req.params.id, safeLimit, offset]
        )
      ]);

      res.json({
        campaign: campaign.rows[0],
        recipients: recipients.rows,
        recipientTotal: parseInt(countQ.rows[0].count, 10),
        page: safePage,
        limit: safeLimit
      });
    } catch (e) {
      logger.error({ err: e }, 'Campaign detail error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.post('/api/admin/campaigns', authMiddleware, async (req, res) => {
    try {
      const { subject, html_body, text_body, segment } = req.body;
      if (!subject?.trim()) return res.status(400).json({ error: 'Subject required' });
      if (!html_body?.trim()) return res.status(400).json({ error: 'HTML body required' });

      const result = await pool.query(
        `INSERT INTO nb_campaigns (subject, html_body, text_body, segment)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [subject.trim(), html_body, text_body || null, segment || 'all']
      );
      res.json(result.rows[0]);
    } catch (e) {
      logger.error({ err: e }, 'Create campaign error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.post('/api/admin/campaigns/:id/test', authMiddleware, async (req, res) => {
    try {
      const { email } = req.body;
      if (!email) return res.status(400).json({ error: 'Test email required' });

      const campaign = await pool.query('SELECT * FROM nb_campaigns WHERE id = $1', [req.params.id]);
      if (campaign.rows.length === 0) return res.status(404).json({ error: 'Campaign not found' });
      const current = campaign.rows[0];
      const testTrackingId = `test-${uuidv4()}`;
      const html = injectTracking(current.html_body, testTrackingId, 'test-token');

      await transporter.sendMail({
        from: smtpFrom,
        to: email,
        subject: `[TEST] ${current.subject}`,
        html,
        text: current.text_body || '',
        headers: { 'List-Unsubscribe': `<${siteUrl}/api/unsubscribe/test-token>` }
      });

      res.json({ ok: true, message: `Test sent to ${email}` });
    } catch (e) {
      logger.error({ err: e }, 'Test send error');
      res.status(500).json({ error: 'Failed to send test email' });
    }
  });

  app.post('/api/admin/campaigns/:id/send', authMiddleware, async (req, res) => {
    try {
      // Use advisory lock to prevent race condition on concurrent send requests
      const lockResult = await pool.query(
        `SELECT * FROM nb_campaigns WHERE id = $1 AND status IN ('draft', 'failed') FOR UPDATE SKIP LOCKED`,
        [req.params.id]
      );
      if (lockResult.rows.length === 0) {
        // Either not found, already sent, or another request holds the lock
        const exists = await pool.query('SELECT status FROM nb_campaigns WHERE id = $1', [req.params.id]);
        if (exists.rows.length === 0) return res.status(404).json({ error: 'Campaign not found' });
        return res.status(409).json({ error: `Campaign is already ${exists.rows[0].status}` });
      }
      const current = lockResult.rows[0];

      let subQuery = "SELECT id, email, name, unsubscribe_token FROM nb_subscribers WHERE status = 'active'";
      const params = [];
      if (current.segment && current.segment !== 'all') {
        subQuery += ' AND $1 = ANY(tags)';
        params.push(current.segment);
      }
      const subs = await pool.query(subQuery, params);
      if (subs.rows.length === 0) return res.status(400).json({ error: 'No active subscribers match this segment' });

      const recipientValues = [];
      const recipientParams = [];
      let paramIndex = 1;
      for (const sub of subs.rows) {
        const trackingId = uuidv4();
        recipientValues.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
        recipientParams.push(current.id, sub.id, sub.email, trackingId);
      }
      await pool.query(
        `INSERT INTO nb_campaign_recipients (campaign_id, subscriber_id, email, tracking_id) VALUES ${recipientValues.join(', ')}`,
        recipientParams
      );

      await pool.query(
        "UPDATE nb_campaigns SET status = 'sending', total_count = $1, sent_at = NOW(), updated_at = NOW() WHERE id = $2",
        [subs.rows.length, current.id]
      );

      res.json({ ok: true, total: subs.rows.length, message: 'Campaign sending started' });

      let recipients;
      try {
        recipients = await pool.query(
          'SELECT r.id, r.email, r.tracking_id, s.unsubscribe_token FROM nb_campaign_recipients r JOIN nb_subscribers s ON r.subscriber_id = s.id WHERE r.campaign_id = $1',
          [current.id]
        );
      } catch (recipientQueryErr) {
        logger.error({ err: recipientQueryErr, campaignId: current.id }, 'Campaign: failed to load recipients for sending');
        await pool.query("UPDATE nb_campaigns SET status = 'failed', updated_at = NOW() WHERE id = $1", [current.id]).catch(() => {});
        sendWhatsApp(namiJid, `Campaign "${current.subject}" failed to load recipients. Status set to failed.`).catch((e) => logger.error({ err: e }, 'WhatsApp fire-and-forget error'));
        return;
      }

      let sentCount = 0;
      for (const recipient of recipients.rows) {
        try {
          const html = injectTracking(current.html_body, recipient.tracking_id, recipient.unsubscribe_token);
          await transporter.sendMail({
            from: smtpFrom,
            to: recipient.email,
            subject: current.subject,
            html,
            text: current.text_body || '',
            headers: {
              'List-Unsubscribe': `<${siteUrl}/api/unsubscribe/${recipient.unsubscribe_token}>`,
              'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
            }
          });
          await pool.query("UPDATE nb_campaign_recipients SET status = 'sent' WHERE id = $1", [recipient.id]).catch((dbErr) => {
            logger.error({ err: dbErr, recipientId: recipient.id }, 'Campaign: failed to mark recipient as sent');
          });
          sentCount++;
          await new Promise((resolve) => setTimeout(resolve, 100));
        } catch (e) {
          logger.error({ err: e, email: recipient.email }, 'Failed to send campaign email');
          try {
            await pool.query(
              "UPDATE nb_campaign_recipients SET status = 'bounced', bounced_at = NOW() WHERE id = $1",
              [recipient.id]
            );
            await pool.query('UPDATE nb_campaigns SET bounce_count = bounce_count + 1 WHERE id = $1', [current.id]);
          } catch (dbErr) {
            logger.error({ err: dbErr, recipientId: recipient.id }, 'Campaign: failed to record bounce in DB');
          }
        }
      }

      try {
        await pool.query(
          "UPDATE nb_campaigns SET status = 'sent', sent_count = $1, updated_at = NOW() WHERE id = $2",
          [sentCount, current.id]
        );
        sendWhatsApp(namiJid, `Campaign sent: "${current.subject}"\n${sentCount}/${subs.rows.length} emails delivered`).catch((e) => logger.error({ err: e }, 'WhatsApp fire-and-forget error'));
      } catch (finalizeErr) {
        logger.error({ err: finalizeErr, campaignId: current.id, sentCount }, 'Campaign finalization DB error - emails were sent but status not updated');
        sendWhatsApp(namiJid, `Campaign "${current.subject}" sent ${sentCount} emails but failed to update status in DB. Check logs.`).catch((e) => logger.error({ err: e }, 'WhatsApp fire-and-forget error'));
      }
    } catch (e) {
      logger.error({ err: e }, 'Send campaign error');
      await pool.query("UPDATE nb_campaigns SET status = 'failed', updated_at = NOW() WHERE id = $1", [req.params.id]).catch(() => {});
      if (!res.headersSent) res.status(500).json({ error: 'Failed to send campaign' });
    }
  });
}

module.exports = { createAdminRoutes };
