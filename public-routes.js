function createPublicRoutes({
  app,
  pool,
  logger,
  transporter,
  sendWhatsApp,
  namiJid,
  getIP,
  rateLimit,
  generateToken,
  escapeHtml,
  unsubPage,
  jwt,
  jwtSecret,
  siteUrl,
  smtpFrom,
  smtpMonitor,
  buildGiftDownloadUrl,
  journalPdfPath,
  pixel,
  redirectAllowlist
}) {
  app.post('/api/contact', async (req, res) => {
    try {
      const ip = getIP(req);
      if (!rateLimit(`contact:${ip}`, 3, 600000)) {
        return res.status(429).json({ error: 'Too many requests. Please try again later.' });
      }

      const { name, email, subject, message, subscribe } = req.body;
      if (!name?.trim() || !email?.trim() || !message?.trim()) {
        return res.status(400).json({ error: 'Name, email, and message are required' });
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Invalid email address' });
      }

      await pool.query(
        'INSERT INTO nb_contacts (name, email, subject, message, ip) VALUES ($1, $2, $3, $4, $5)',
        [name.trim(), email.trim(), subject?.trim() || null, message.trim(), ip]
      );

      if (subscribe) {
        try {
          const token = generateToken();
          await pool.query(
            `INSERT INTO nb_subscribers (email, name, source, unsubscribe_token, ip)
             VALUES ($1, $2, 'contact_form', $3, $4)
             ON CONFLICT (email) DO UPDATE SET
               name = COALESCE(EXCLUDED.name, nb_subscribers.name),
               status = 'active',
               updated_at = NOW()`,
            [email.trim(), name.trim(), token, ip]
          );
        } catch (subErr) {
          logger.error({ err: subErr, email: email.trim() }, 'Contact form: subscriber upsert failed (contact was saved)');
        }
      }

      try {
        if (smtpMonitor && smtpMonitor.status !== 'ready') {
          logger.warn({ smtpStatus: smtpMonitor.status }, 'SMTP not ready — attempting contact email anyway');
        }
        await transporter.sendMail({
          from: smtpFrom,
          to: 'namibarden@gmail.com',
          replyTo: email.trim(),
          subject: `New contact from ${name} - NamiBarden.com`,
          html: `<h3>New Contact Form Submission</h3>
            <p><strong>Name:</strong> ${escapeHtml(name)}</p>
            <p><strong>Email:</strong> ${escapeHtml(email)}</p>
            <p><strong>Subject:</strong> ${escapeHtml(subject || 'N/A')}</p>
            <p><strong>Message:</strong></p>
            <p>${escapeHtml(message).replace(/\n/g, '<br>')}</p>
            <hr><p style="color:#999; font-size:12px;">From namibarden.com contact form</p>`
        });
      } catch (e) {
        logger.error({ err: e }, 'Email send failed');
      }

      const snippet = message.length > 200 ? `${message.slice(0, 200)}...` : message;
      sendWhatsApp(namiJid, `New NamiBarden contact:\n${name} <${email}>\n${subject ? `Subject: ${subject}\n` : ''}${snippet}`).catch((e) => logger.error({ err: e }, 'WhatsApp fire-and-forget error'));

      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e }, 'Contact error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.post('/api/subscribe', async (req, res) => {
    try {
      const ip = getIP(req);
      if (!rateLimit(`subscribe:${ip}`, 5, 3600000)) {
        return res.status(429).json({ error: 'Too many requests' });
      }
      const { email, name, source } = req.body;
      if (!email?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Valid email required' });
      }

      const token = generateToken();
      const sourceName = source || 'pdf_download';
      const result = await pool.query(
        `INSERT INTO nb_subscribers (email, name, source, unsubscribe_token, ip)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (email) DO UPDATE SET
           name = COALESCE(EXCLUDED.name, nb_subscribers.name),
           source = COALESCE(EXCLUDED.source, nb_subscribers.source),
           status = 'active',
           updated_at = NOW()
         RETURNING id, xmax`,
        [email.trim(), name?.trim() || null, sourceName, token, ip]
      );

      const isNew = result.rows[0].xmax === '0';
      if (isNew) {
        sendWhatsApp(namiJid, `New subscriber: ${email}${sourceName ? ` (${sourceName})` : ''}`).catch((e) => logger.error({ err: e }, 'WhatsApp fire-and-forget error'));
      }

      const response = { ok: true, new: isNew };
      if (sourceName === 'pdf_download') {
        const downloadToken = jwt.sign(
          { type: 'gift_download', asset: '5day-journal', email: email.trim() },
          jwtSecret,
          { expiresIn: '15m' }
        );
        response.downloadUrl = buildGiftDownloadUrl(downloadToken);
      }

      res.json(response);
    } catch (e) {
      logger.error({ err: e }, 'Subscribe error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.get('/api/gifts/5day-journal', (req, res) => {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    if (!token) return res.status(400).json({ error: 'Missing download token' });

    try {
      const payload = jwt.verify(token, jwtSecret);
      if (payload?.type !== 'gift_download' || payload?.asset !== '5day-journal') {
        return res.status(401).json({ error: 'Invalid download token' });
      }
    } catch {
      return res.status(401).json({ error: 'Invalid or expired download token' });
    }

    res.set('Cache-Control', 'private, no-store');
    res.download(journalPdfPath, '5day-journal.pdf', (err) => {
      if (!err) return;
      logger.error({ err }, 'Gift download failed');
      if (!res.headersSent) {
        res.status(err.code === 'ENOENT' ? 404 : 500).json({ error: 'Download unavailable' });
      }
    });
  });

  app.get('/api/track/open/:trackingId', async (req, res) => {
    res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    res.send(pixel);

    try {
      const { trackingId } = req.params;
      const ip = getIP(req);
      const ua = req.headers['user-agent'] || '';

      await pool.query(
        'INSERT INTO nb_email_events (tracking_id, event_type, ip, user_agent) VALUES ($1, $2, $3, $4)',
        [trackingId, 'open', ip, ua]
      );

      const result = await pool.query(
        `UPDATE nb_campaign_recipients SET status = 'opened', opened_at = COALESCE(opened_at, NOW())
         WHERE tracking_id = $1 AND opened_at IS NULL RETURNING campaign_id`,
        [trackingId]
      );
      if (result.rows.length > 0) {
        await pool.query('UPDATE nb_campaigns SET open_count = open_count + 1 WHERE id = $1', [result.rows[0].campaign_id]);
      }
    } catch (e) {
      logger.error({ err: e }, 'Track open error');
    }
  });

  app.get('/api/track/click/:trackingId', async (req, res) => {
    const { trackingId } = req.params;
    let url = req.query.url || siteUrl;

    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.toLowerCase();
      if (
        parsed.protocol !== 'https:' ||
        parsed.username ||
        parsed.password ||
        (parsed.port && parsed.port !== '443') ||
        !redirectAllowlist.includes(hostname)
      ) {
        logger.warn({ hostname }, 'Redirect blocked - not in allowlist');
        url = siteUrl;
      }
    } catch {
      url = siteUrl;
    }

    try {
      const ip = getIP(req);
      const ua = req.headers['user-agent'] || '';

      await pool.query(
        'INSERT INTO nb_email_events (tracking_id, event_type, url, ip, user_agent) VALUES ($1, $2, $3, $4, $5)',
        [trackingId, 'click', url, ip, ua]
      );

      const result = await pool.query(
        `UPDATE nb_campaign_recipients SET status = 'clicked', clicked_at = COALESCE(clicked_at, NOW())
         WHERE tracking_id = $1 AND clicked_at IS NULL RETURNING campaign_id`,
        [trackingId]
      );
      if (result.rows.length > 0) {
        await pool.query('UPDATE nb_campaigns SET click_count = click_count + 1 WHERE id = $1', [result.rows[0].campaign_id]);
      }
    } catch (e) {
      logger.error({ err: e }, 'Track click error');
    }

    res.redirect(url);
  });

  app.get('/api/unsubscribe/:token', async (req, res) => {
    try {
      const { token } = req.params;
      const result = await pool.query('SELECT email FROM nb_subscribers WHERE unsubscribe_token = $1', [token]);
      if (result.rows.length === 0) {
        return res.status(404).send(unsubPage('Link not found', 'This unsubscribe link is invalid or expired.'));
      }
      res.send(unsubPage('Unsubscribe', `Unsubscribe <strong>${escapeHtml(result.rows[0].email)}</strong> from our mailing list?`, token));
    } catch (e) {
      logger.error({ err: e }, 'Unsubscribe page error');
      res.status(500).send(unsubPage('Error', 'Something went wrong.'));
    }
  });

  app.post('/api/unsubscribe/:token', async (req, res) => {
    try {
      const { token } = req.params;
      const result = await pool.query(
        `UPDATE nb_subscribers SET status = 'unsubscribed', updated_at = NOW()
         WHERE unsubscribe_token = $1 AND status = 'active' RETURNING id, email`,
        [token]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Not found or already unsubscribed' });

      await pool.query(
        `UPDATE nb_campaign_recipients SET status = 'unsubscribed'
         WHERE subscriber_id = $1 AND status NOT IN ('bounced', 'unsubscribed')`,
        [result.rows[0].id]
      );

      res.json({ ok: true, message: 'You have been unsubscribed.' });
    } catch (e) {
      logger.error({ err: e }, 'Unsubscribe error');
      res.status(500).json({ error: 'Server error' });
    }
  });
}

module.exports = { createPublicRoutes };
