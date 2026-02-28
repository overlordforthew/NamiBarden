const express = require('express');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');
const crypto = require('crypto');
const uuidv4 = () => crypto.randomUUID();

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  next(err);
});

// ─── Config ───
const PORT = 3100;
const {
  DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD,
  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM,
  JWT_SECRET, ADMIN_PASSWORD,
  OVERLORD_URL, WEBHOOK_TOKEN, SITE_URL
} = process.env;

// ─── Database ───
const pool = new Pool({
  host: DB_HOST, port: DB_PORT || 5432,
  database: DB_NAME, user: DB_USER, password: DB_PASSWORD
});

// ─── SMTP ───
const transporter = nodemailer.createTransport({
  host: SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(SMTP_PORT) || 587,
  secure: false,
  auth: { user: SMTP_USER, pass: SMTP_PASS }
});

// ─── Rate limiting ───
const rateLimits = new Map();
function rateLimit(key, maxAttempts, windowMs) {
  const now = Date.now();
  const entry = rateLimits.get(key) || { attempts: [], blocked: 0 };
  entry.attempts = entry.attempts.filter(t => now - t < windowMs);
  if (entry.attempts.length >= maxAttempts) return false;
  entry.attempts.push(now);
  rateLimits.set(key, entry);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimits) {
    entry.attempts = entry.attempts.filter(t => now - t < 3600000);
    if (entry.attempts.length === 0) rateLimits.delete(key);
  }
}, 300000);

function getIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
}

// ─── JWT Auth Middleware ───
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.admin = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ─── Upload handler ───
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

// ─── Helpers ───
function generateToken() { return crypto.randomBytes(32).toString('hex'); }

async function sendWhatsApp(to, text) {
  if (!OVERLORD_URL || !WEBHOOK_TOKEN) return;
  try {
    await fetch(`${OVERLORD_URL}/api/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WEBHOOK_TOKEN}` },
      body: JSON.stringify({ to, text })
    });
  } catch (e) { console.error('WhatsApp send failed:', e.message); }
}

// Nami's WhatsApp JID
const NAMI_JID = '84393251371@s.whatsapp.net';

// 1x1 transparent PNG
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');


// ══════════════════════════════════════
// PUBLIC ENDPOINTS
// ══════════════════════════════════════

// ─── POST /api/contact ───
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

    // Save contact
    await pool.query(
      'INSERT INTO nb_contacts (name, email, subject, message, ip) VALUES ($1, $2, $3, $4, $5)',
      [name.trim(), email.trim(), subject?.trim() || null, message.trim(), ip]
    );

    // Also subscribe if checkbox checked
    if (subscribe) {
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
    }

    // Send email notification
    try {
      await transporter.sendMail({
        from: SMTP_FROM,
        to: 'namibarden@gmail.com',
        replyTo: email.trim(),
        subject: `New contact from ${name} — NamiBarden.com`,
        html: `<h3>New Contact Form Submission</h3>
          <p><strong>Name:</strong> ${escapeHtml(name)}</p>
          <p><strong>Email:</strong> ${escapeHtml(email)}</p>
          <p><strong>Subject:</strong> ${escapeHtml(subject || 'N/A')}</p>
          <p><strong>Message:</strong></p>
          <p>${escapeHtml(message).replace(/\n/g, '<br>')}</p>
          <hr><p style="color:#999; font-size:12px;">From namibarden.com contact form</p>`
      });
    } catch (e) { console.error('Email send failed:', e.message); }

    // WhatsApp notification to Nami
    const snippet = message.length > 200 ? message.slice(0, 200) + '...' : message;
    sendWhatsApp(NAMI_JID, `📬 New NamiBarden contact:\n${name} <${email}>\n${subject ? `Subject: ${subject}\n` : ''}${snippet}`);

    res.json({ ok: true });
  } catch (e) {
    console.error('Contact error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/subscribe ───
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
    const result = await pool.query(
      `INSERT INTO nb_subscribers (email, name, source, unsubscribe_token, ip)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email) DO UPDATE SET
         name = COALESCE(EXCLUDED.name, nb_subscribers.name),
         source = COALESCE(EXCLUDED.source, nb_subscribers.source),
         status = 'active',
         updated_at = NOW()
       RETURNING id, xmax`,
      [email.trim(), name?.trim() || null, source || 'pdf_download', token, ip]
    );

    const isNew = result.rows[0].xmax === '0';
    if (isNew) {
      sendWhatsApp(NAMI_JID, `📬 New subscriber: ${email}${source ? ` (${source})` : ''}`);
    }

    res.json({ ok: true, new: isNew });
  } catch (e) {
    console.error('Subscribe error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /api/track/open/:trackingId ───
app.get('/api/track/open/:trackingId', async (req, res) => {
  res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
  res.send(PIXEL);

  try {
    const { trackingId } = req.params;
    const ip = getIP(req);
    const ua = req.headers['user-agent'] || '';

    await pool.query(
      'INSERT INTO nb_email_events (tracking_id, event_type, ip, user_agent) VALUES ($1, $2, $3, $4)',
      [trackingId, 'open', ip, ua]
    );

    // Update recipient status + campaign count (only first open)
    const r = await pool.query(
      `UPDATE nb_campaign_recipients SET status = 'opened', opened_at = COALESCE(opened_at, NOW())
       WHERE tracking_id = $1 AND opened_at IS NULL RETURNING campaign_id`,
      [trackingId]
    );
    if (r.rows.length > 0) {
      await pool.query('UPDATE nb_campaigns SET open_count = open_count + 1 WHERE id = $1', [r.rows[0].campaign_id]);
    }
  } catch (e) { console.error('Track open error:', e.message); }
});

// ─── GET /api/track/click/:trackingId ───
app.get('/api/track/click/:trackingId', async (req, res) => {
  const { trackingId } = req.params;
  const url = req.query.url || SITE_URL;

  try {
    const ip = getIP(req);
    const ua = req.headers['user-agent'] || '';

    await pool.query(
      'INSERT INTO nb_email_events (tracking_id, event_type, url, ip, user_agent) VALUES ($1, $2, $3, $4, $5)',
      [trackingId, 'click', url, ip, ua]
    );

    // Update recipient status + campaign count (only first click)
    const r = await pool.query(
      `UPDATE nb_campaign_recipients SET status = 'clicked', clicked_at = COALESCE(clicked_at, NOW())
       WHERE tracking_id = $1 AND clicked_at IS NULL RETURNING campaign_id`,
      [trackingId]
    );
    if (r.rows.length > 0) {
      await pool.query('UPDATE nb_campaigns SET click_count = click_count + 1 WHERE id = $1', [r.rows[0].campaign_id]);
    }
  } catch (e) { console.error('Track click error:', e.message); }

  res.redirect(url);
});

// ─── GET /api/unsubscribe/:token ───
app.get('/api/unsubscribe/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const r = await pool.query('SELECT email FROM nb_subscribers WHERE unsubscribe_token = $1', [token]);
    if (r.rows.length === 0) return res.status(404).send(unsubPage('Link not found', 'This unsubscribe link is invalid or expired.'));
    res.send(unsubPage('Unsubscribe', `Unsubscribe <strong>${escapeHtml(r.rows[0].email)}</strong> from our mailing list?`, token));
  } catch (e) {
    res.status(500).send(unsubPage('Error', 'Something went wrong.'));
  }
});

// ─── POST /api/unsubscribe/:token ───
app.post('/api/unsubscribe/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const r = await pool.query(
      `UPDATE nb_subscribers SET status = 'unsubscribed', updated_at = NOW()
       WHERE unsubscribe_token = $1 AND status = 'active' RETURNING id, email`,
      [token]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found or already unsubscribed' });

    // Log event for any active campaign recipients
    await pool.query(
      `UPDATE nb_campaign_recipients SET status = 'unsubscribed'
       WHERE subscriber_id = $1 AND status NOT IN ('bounced', 'unsubscribed')`,
      [r.rows[0].id]
    );

    res.json({ ok: true, message: 'You have been unsubscribed.' });
  } catch (e) {
    console.error('Unsubscribe error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});


// ══════════════════════════════════════
// ADMIN ENDPOINTS
// ══════════════════════════════════════

// ─── POST /api/admin/login ───
app.post('/api/admin/login', async (req, res) => {
  const ip = getIP(req);
  if (!rateLimit(`login:${ip}`, 5, 300000)) {
    return res.status(429).json({ error: 'Too many login attempts' });
  }
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });

  // Check against env password first, then DB hash
  let valid = false;
  if (ADMIN_PASSWORD && password === ADMIN_PASSWORD) {
    valid = true;
  } else {
    const r = await pool.query('SELECT password_hash FROM nb_admin ORDER BY id LIMIT 1');
    if (r.rows.length > 0) {
      valid = await bcrypt.compare(password, r.rows[0].password_hash);
    }
  }

  if (!valid) return res.status(401).json({ error: 'Invalid password' });
  const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token });
});

// ─── GET /api/admin/stats ───
app.get('/api/admin/stats', authMiddleware, async (req, res) => {
  try {
    const [subs, contacts, campaigns, recent, sources, growth] = await Promise.all([
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
        GROUP BY DATE(created_at) ORDER BY date`)
    ]);

    res.json({
      subscribers: subs.rows[0],
      contacts: contacts.rows[0],
      campaigns: campaigns.rows[0],
      recentCampaigns: recent.rows,
      sources: sources.rows,
      growth: growth.rows
    });
  } catch (e) {
    console.error('Stats error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /api/admin/subscribers ───
app.get('/api/admin/subscribers', authMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 50, status, source, search, tag } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const conditions = [];
    const params = [];
    let idx = 1;

    if (status) { conditions.push(`status = $${idx++}`); params.push(status); }
    if (source) { conditions.push(`source = $${idx++}`); params.push(source); }
    if (search) { conditions.push(`(email ILIKE $${idx} OR name ILIKE $${idx})`); params.push(`%${search}%`); idx++; }
    if (tag) { conditions.push(`$${idx++} = ANY(tags)`); params.push(tag); }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const countQ = await pool.query(`SELECT COUNT(*) FROM nb_subscribers ${where}`, params);
    params.push(parseInt(limit), offset);
    const dataQ = await pool.query(
      `SELECT id, email, name, source, status, tags, created_at, updated_at
       FROM nb_subscribers ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx}`,
      params
    );

    res.json({
      subscribers: dataQ.rows,
      total: parseInt(countQ.rows[0].count),
      page: parseInt(page),
      limit: parseInt(limit)
    });
  } catch (e) {
    console.error('Subscribers list error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /api/admin/subscribers/export ───
app.get('/api/admin/subscribers/export', authMiddleware, async (req, res) => {
  try {
    const { status } = req.query;
    const where = status ? 'WHERE status = $1' : '';
    const params = status ? [status] : [];
    const r = await pool.query(
      `SELECT email, name, source, status, array_to_string(tags, ',') AS tags, created_at
       FROM nb_subscribers ${where} ORDER BY created_at DESC`, params
    );
    const csv = stringify(r.rows, { header: true });
    res.set({ 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename=subscribers.csv' });
    res.send(csv);
  } catch (e) {
    console.error('Export error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/admin/import ───
app.post('/api/admin/import', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'CSV file required' });
    const records = parse(req.file.buffer.toString(), { columns: true, skip_empty_lines: true, trim: true });
    let imported = 0, skipped = 0;
    for (const row of records) {
      const email = (row.email || row.Email || '').trim().toLowerCase();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { skipped++; continue; }
      const name = (row.name || row.Name || '').trim() || null;
      const source = (row.source || row.Source || 'import').trim();
      const token = generateToken();
      const r = await pool.query(
        `INSERT INTO nb_subscribers (email, name, source, unsubscribe_token)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (email) DO NOTHING RETURNING id`,
        [email, name, source, token]
      );
      if (r.rows.length > 0) imported++; else skipped++;
    }
    res.json({ imported, skipped, total: records.length });
  } catch (e) {
    console.error('Import error:', e);
    res.status(500).json({ error: 'Import failed: ' + e.message });
  }
});

// ─── POST /api/admin/subscribers/:id/tags ───
app.post('/api/admin/subscribers/:id/tags', authMiddleware, async (req, res) => {
  try {
    const { tags } = req.body;
    if (!Array.isArray(tags)) return res.status(400).json({ error: 'Tags must be an array' });
    const r = await pool.query(
      'UPDATE nb_subscribers SET tags = $1, updated_at = NOW() WHERE id = $2 RETURNING id, tags',
      [tags, req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Subscriber not found' });
    res.json(r.rows[0]);
  } catch (e) {
    console.error('Tags error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── DELETE /api/admin/subscribers/:id ───
app.delete('/api/admin/subscribers/:id', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM nb_subscribers WHERE id = $1 RETURNING id', [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('Delete subscriber error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /api/admin/contacts ───
app.get('/api/admin/contacts', authMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const [countQ, dataQ] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM nb_contacts'),
      pool.query('SELECT * FROM nb_contacts ORDER BY created_at DESC LIMIT $1 OFFSET $2', [parseInt(limit), offset])
    ]);
    res.json({ contacts: dataQ.rows, total: parseInt(countQ.rows[0].count), page: parseInt(page) });
  } catch (e) {
    console.error('Contacts error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /api/admin/campaigns ───
app.get('/api/admin/campaigns', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, subject, status, segment, total_count, sent_count, open_count, click_count,
              bounce_count, unsub_count, created_at, sent_at
       FROM nb_campaigns ORDER BY created_at DESC`
    );
    res.json({ campaigns: r.rows });
  } catch (e) {
    console.error('Campaigns error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /api/admin/campaigns/:id ───
app.get('/api/admin/campaigns/:id', authMiddleware, async (req, res) => {
  try {
    const campaign = await pool.query('SELECT * FROM nb_campaigns WHERE id = $1', [req.params.id]);
    if (campaign.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const recipients = await pool.query(
      `SELECT r.id, r.email, r.status, r.opened_at, r.clicked_at, r.bounced_at
       FROM nb_campaign_recipients r WHERE r.campaign_id = $1 ORDER BY r.created_at`,
      [req.params.id]
    );
    res.json({ campaign: campaign.rows[0], recipients: recipients.rows });
  } catch (e) {
    console.error('Campaign detail error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/admin/campaigns ───
app.post('/api/admin/campaigns', authMiddleware, async (req, res) => {
  try {
    const { subject, html_body, text_body, segment } = req.body;
    if (!subject?.trim()) return res.status(400).json({ error: 'Subject required' });
    if (!html_body?.trim()) return res.status(400).json({ error: 'HTML body required' });

    const r = await pool.query(
      `INSERT INTO nb_campaigns (subject, html_body, text_body, segment)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [subject.trim(), html_body, text_body || null, segment || 'all']
    );
    res.json(r.rows[0]);
  } catch (e) {
    console.error('Create campaign error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/admin/campaigns/:id/test ───
app.post('/api/admin/campaigns/:id/test', authMiddleware, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Test email required' });

    const campaign = await pool.query('SELECT * FROM nb_campaigns WHERE id = $1', [req.params.id]);
    if (campaign.rows.length === 0) return res.status(404).json({ error: 'Campaign not found' });
    const c = campaign.rows[0];

    const testTrackingId = 'test-' + uuidv4();
    const html = injectTracking(c.html_body, testTrackingId, 'test-token');

    await transporter.sendMail({
      from: SMTP_FROM,
      to: email,
      subject: `[TEST] ${c.subject}`,
      html,
      text: c.text_body || '',
      headers: { 'List-Unsubscribe': `<${SITE_URL}/api/unsubscribe/test-token>` }
    });

    res.json({ ok: true, message: `Test sent to ${email}` });
  } catch (e) {
    console.error('Test send error:', e);
    res.status(500).json({ error: 'Failed to send test: ' + e.message });
  }
});

// ─── POST /api/admin/campaigns/:id/send ───
app.post('/api/admin/campaigns/:id/send', authMiddleware, async (req, res) => {
  try {
    const campaign = await pool.query(
      "SELECT * FROM nb_campaigns WHERE id = $1 AND status IN ('draft', 'failed')", [req.params.id]
    );
    if (campaign.rows.length === 0) return res.status(404).json({ error: 'Campaign not found or already sent' });
    const c = campaign.rows[0];

    // Get target subscribers
    let subQuery = "SELECT id, email, name, unsubscribe_token FROM nb_subscribers WHERE status = 'active'";
    const params = [];
    if (c.segment && c.segment !== 'all') {
      subQuery += ' AND $1 = ANY(tags)';
      params.push(c.segment);
    }
    const subs = await pool.query(subQuery, params);
    if (subs.rows.length === 0) return res.status(400).json({ error: 'No active subscribers match this segment' });

    // Create recipients
    const recipientValues = [];
    const recipientParams = [];
    let pi = 1;
    for (const sub of subs.rows) {
      const trackingId = uuidv4();
      recipientValues.push(`($${pi++}, $${pi++}, $${pi++}, $${pi++})`);
      recipientParams.push(c.id, sub.id, sub.email, trackingId);
    }
    await pool.query(
      `INSERT INTO nb_campaign_recipients (campaign_id, subscriber_id, email, tracking_id) VALUES ${recipientValues.join(', ')}`,
      recipientParams
    );

    // Update campaign status
    await pool.query(
      "UPDATE nb_campaigns SET status = 'sending', total_count = $1, sent_at = NOW(), updated_at = NOW() WHERE id = $2",
      [subs.rows.length, c.id]
    );

    // Send emails in background (don't block response)
    res.json({ ok: true, total: subs.rows.length, message: 'Campaign sending started' });

    // Batch send
    const recipients = await pool.query(
      'SELECT r.id, r.email, r.tracking_id, s.unsubscribe_token FROM nb_campaign_recipients r JOIN nb_subscribers s ON r.subscriber_id = s.id WHERE r.campaign_id = $1',
      [c.id]
    );

    let sentCount = 0;
    for (const recipient of recipients.rows) {
      try {
        const html = injectTracking(c.html_body, recipient.tracking_id, recipient.unsubscribe_token);
        await transporter.sendMail({
          from: SMTP_FROM,
          to: recipient.email,
          subject: c.subject,
          html,
          text: c.text_body || '',
          headers: {
            'List-Unsubscribe': `<${SITE_URL}/api/unsubscribe/${recipient.unsubscribe_token}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
          }
        });
        await pool.query("UPDATE nb_campaign_recipients SET status = 'sent' WHERE id = $1", [recipient.id]);
        sentCount++;
        // Rate limit: ~10 emails/sec
        await new Promise(r => setTimeout(r, 100));
      } catch (e) {
        console.error(`Failed to send to ${recipient.email}:`, e.message);
        await pool.query(
          "UPDATE nb_campaign_recipients SET status = 'bounced', bounced_at = NOW() WHERE id = $1",
          [recipient.id]
        );
        await pool.query('UPDATE nb_campaigns SET bounce_count = bounce_count + 1 WHERE id = $1', [c.id]);
      }
    }

    // Finalize campaign
    await pool.query(
      "UPDATE nb_campaigns SET status = 'sent', sent_count = $1, updated_at = NOW() WHERE id = $2",
      [sentCount, c.id]
    );

    sendWhatsApp(NAMI_JID, `📧 Campaign sent: "${c.subject}"\n${sentCount}/${subs.rows.length} emails delivered`);

  } catch (e) {
    console.error('Send campaign error:', e);
    await pool.query("UPDATE nb_campaigns SET status = 'failed', updated_at = NOW() WHERE id = $1", [req.params.id]).catch(() => {});
    if (!res.headersSent) res.status(500).json({ error: 'Failed to send campaign' });
  }
});


// ══════════════════════════════════════
// HELPERS
// ══════════════════════════════════════

function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function injectTracking(html, trackingId, unsubToken) {
  // Add open tracking pixel before </body>
  const pixel = `<img src="${SITE_URL}/api/track/open/${trackingId}" width="1" height="1" style="display:none" alt="">`;
  html = html.replace('</body>', `${pixel}</body>`);
  if (!html.includes(pixel)) html += pixel; // fallback if no </body>

  // Replace links with tracked versions
  html = html.replace(/href="(https?:\/\/[^"]+)"/g, (match, url) => {
    if (url.includes('/api/unsubscribe') || url.includes('/api/track')) return match;
    return `href="${SITE_URL}/api/track/click/${trackingId}?url=${encodeURIComponent(url)}"`;
  });

  // Add unsubscribe footer
  const footer = `<div style="text-align:center; padding:20px; margin-top:30px; border-top:1px solid #eee; font-size:12px; color:#999;">
    <p>You received this email because you subscribed at namibarden.com</p>
    <p><a href="${SITE_URL}/api/unsubscribe/${unsubToken}" style="color:#999;">Unsubscribe</a></p>
  </div>`;
  html = html.replace('</body>', `${footer}</body>`);
  if (!html.includes(footer)) html += footer;

  return html;
}

function unsubPage(title, message, token) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — Nami Barden</title>
<style>
body{font-family:-apple-system,system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#FAF7F2;color:#2C2C2C}
.box{text-align:center;max-width:400px;padding:40px;background:#fff;border-radius:12px;box-shadow:0 2px 20px rgba(0,0,0,0.08)}
h2{margin-bottom:16px;color:#2C2C2C}
p{color:#666;line-height:1.6}
button{margin-top:20px;padding:12px 32px;background:#C4A882;color:#fff;border:none;border-radius:8px;font-size:1rem;cursor:pointer}
button:hover{background:#a08860}
.done{color:#4a7}
</style></head><body><div class="box">
<h2>${title}</h2><p>${message}</p>
${token ? `<button onclick="doUnsub()">Confirm Unsubscribe</button><p id="result"></p>
<script>function doUnsub(){fetch('/api/unsubscribe/${token}',{method:'POST'}).then(r=>r.json()).then(d=>{document.querySelector('button').style.display='none';document.getElementById('result').innerHTML='<span class=done>'+d.message+'</span>'}).catch(()=>{document.getElementById('result').textContent='Error. Please try again.'})}</script>` : ''}
</div></body></html>`;
}

// ─── Init & Start ───
async function init() {
  // Ensure admin password hash exists
  const r = await pool.query('SELECT id FROM nb_admin LIMIT 1');
  if (r.rows.length === 0 && ADMIN_PASSWORD) {
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    await pool.query('INSERT INTO nb_admin (password_hash) VALUES ($1)', [hash]);
    console.log('Admin account initialized');
  }
}

init().then(() => {
  app.listen(PORT, '127.0.0.1', () => console.log(`NamiBarden API running on port ${PORT}`));
}).catch(e => {
  console.error('Init failed:', e);
  process.exit(1);
});
