function createCustomerAuth({
  app,
  pool,
  jwt,
  bcrypt,
  transporter,
  logger,
  courses,
  jwtSecret,
  siteUrl,
  smtpFrom,
  rateLimit,
  getIP,
  generateToken,
  setAuthCookie,
  clearAuthCookie,
  normalizeEmail
}) {
  const MESSAGES = {
    loginRequiredJa: '\u30ed\u30b0\u30a4\u30f3\u304c\u5fc5\u8981\u3067\u3059',
    sessionExpiredJa: '\u30bb\u30c3\u30b7\u30e7\u30f3\u304c\u671f\u9650\u5207\u308c\u3067\u3059\u3002\u518d\u5ea6\u30ed\u30b0\u30a4\u30f3\u3057\u3066\u304f\u3060\u3055\u3044\u3002',
    passwordMinJa: '\u30d1\u30b9\u30ef\u30fc\u30c9\u306f8\u6587\u5b57\u4ee5\u4e0a\u3067\u5165\u529b\u3057\u3066\u304f\u3060\u3055\u3044',
    accountExistsJa: '\u3053\u306e\u30e1\u30fc\u30eb\u30a2\u30c9\u30ec\u30b9\u306e\u30a2\u30ab\u30a6\u30f3\u30c8\u306f\u65e2\u306b\u5b58\u5728\u3057\u307e\u3059\u3002\u30ed\u30b0\u30a4\u30f3\u3057\u3066\u304f\u3060\u3055\u3044\u3002',
    tooManyLoginsJa: '\u30ed\u30b0\u30a4\u30f3\u8a66\u884c\u56de\u6570\u304c\u8d85\u3048\u307e\u3057\u305f\u30025\u5206\u5f8c\u306b\u304a\u8a66\u3057\u304f\u3060\u3055\u3044\u3002',
    invalidCredentialsJa: '\u30e1\u30fc\u30eb\u30a2\u30c9\u30ec\u30b9\u307e\u305f\u306f\u30d1\u30b9\u30ef\u30fc\u30c9\u304c\u6b63\u3057\u304f\u3042\u308a\u307e\u305b\u3093\u3002',
    forgotSuccessJa: '\u30d1\u30b9\u30ef\u30fc\u30c9\u30ea\u30bb\u30c3\u30c8\u30e1\u30fc\u30eb\u3092\u9001\u4fe1\u3057\u307e\u3057\u305f\u3002',
    resetSubjectJa: '\u3010NamiBarden\u3011\u30d1\u30b9\u30ef\u30fc\u30c9\u30ea\u30bb\u30c3\u30c8',
    resetTitleJa: '\u30d1\u30b9\u30ef\u30fc\u30c9\u30ea\u30bb\u30c3\u30c8',
    resetIntroJa: '\u30d1\u30b9\u30ef\u30fc\u30c9\u30ea\u30bb\u30c3\u30c8\u306e\u30ea\u30af\u30a8\u30b9\u30c8\u3092\u53d7\u3051\u4ed8\u3051\u307e\u3057\u305f\u3002',
    resetBodyJa: '\u4e0b\u306e\u30dc\u30bf\u30f3\u3092\u30af\u30ea\u30c3\u30af\u3057\u3066\u65b0\u3057\u3044\u30d1\u30b9\u30ef\u30fc\u30c9\u3092\u8a2d\u5b9a\u3057\u3066\u304f\u3060\u3055\u3044\u3002\u3053\u306e\u30ea\u30f3\u30af\u306f1\u6642\u9593\u6709\u52b9\u3067\u3059\u3002',
    resetButtonJa: '\u30d1\u30b9\u30ef\u30fc\u30c9\u3092\u30ea\u30bb\u30c3\u30c8',
    resetIgnoreJa: '\u3053\u306e\u30ea\u30af\u30a8\u30b9\u30c8\u306b\u5fc3\u5f53\u305f\u308a\u304c\u306a\u3044\u5834\u5408\u306f\u3001\u3053\u306e\u30e1\u30fc\u30eb\u3092\u7121\u8996\u3057\u3066\u304f\u3060\u3055\u3044\u3002',
    resetInvalidJa: '\u30ea\u30f3\u30af\u304c\u7121\u52b9\u307e\u305f\u306f\u671f\u9650\u5207\u308c\u3067\u3059\u3002\u518d\u5ea6\u30d1\u30b9\u30ef\u30fc\u30c9\u30ea\u30bb\u30c3\u30c8\u3092\u304a\u8a66\u3057\u304f\u3060\u3055\u3044\u3002'
  };

  function customerAuth(req, res, next) {
    const token = req.cookies?.nb_auth_token || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);
    if (!token) return res.status(401).json({ error: MESSAGES.loginRequiredJa });
    try {
      const decoded = jwt.verify(token, jwtSecret);
      if (decoded.role !== 'customer') return res.status(403).json({ error: 'Forbidden' });
      req.customer = decoded;
      next();
    } catch {
      res.status(401).json({ error: MESSAGES.sessionExpiredJa });
    }
  }

  function issueCustomerToken(customerId, email) {
    return jwt.sign({ role: 'customer', customerId, email }, jwtSecret, { expiresIn: '30d' });
  }

  function buildForgotPasswordEmail(resetUrl) {
    return `<div style="max-width:600px;margin:0 auto;font-family:'Helvetica Neue',Arial,sans-serif;color:#2C2419;background:#FAF7F2;padding:40px;">
        <h2 style="font-size:1.4rem;color:#2C2419;margin-bottom:24px;">${MESSAGES.resetTitleJa}</h2>
        <p style="line-height:1.8;margin-bottom:16px;">${MESSAGES.resetIntroJa}</p>
        <p style="line-height:1.8;margin-bottom:24px;">${MESSAGES.resetBodyJa}</p>
        <p style="text-align:center;margin:32px 0;">
          <a href="${resetUrl}" style="display:inline-block;padding:14px 40px;background:#A8895E;color:#fff;text-decoration:none;border-radius:2px;font-size:1rem;letter-spacing:0.05em;">${MESSAGES.resetButtonJa}</a>
        </p>
        <p style="font-size:0.85rem;color:#8B7E6E;margin-top:24px;">${MESSAGES.resetIgnoreJa}</p>
        <hr style="border:none;border-top:1px solid #E8DFD3;margin:32px 0;">
        <p style="font-size:0.8rem;color:#A99E8F;text-align:center;">Nami Barden - namibarden.com</p>
      </div>`;
  }

  app.post('/api/auth/register', async (req, res) => {
    try {
      const ip = getIP(req);
      if (!rateLimit(`auth-register:${ip}`, 5, 300000)) {
        return res.status(429).json({ error: 'Too many requests' });
      }

      const { email, password, name, subscribe } = req.body;
      if (!email?.trim() || !password) return res.status(400).json({ error: 'Email and password required' });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email' });
      if (password.length < 8) return res.status(400).json({ error: MESSAGES.passwordMinJa });

      const emailLower = normalizeEmail(email);
      const existing = await pool.query(
        'SELECT id, password_hash FROM nb_customers WHERE LOWER(email) = $1 ORDER BY updated_at DESC LIMIT 1',
        [emailLower]
      );

      if (existing.rows.length > 0 && existing.rows[0].password_hash) {
        return res.status(409).json({ error: MESSAGES.accountExistsJa });
      }

      const hash = await bcrypt.hash(password, 10);
      let customerId;
      if (existing.rows.length > 0) {
        await pool.query(
          'UPDATE nb_customers SET password_hash = $1, name = COALESCE($2, name), updated_at = NOW() WHERE id = $3',
          [hash, name?.trim() || null, existing.rows[0].id]
        );
        customerId = existing.rows[0].id;
      } else {
        const inserted = await pool.query(
          'INSERT INTO nb_customers (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id',
          [emailLower, name?.trim() || null, hash]
        );
        customerId = inserted.rows[0].id;
      }

      if (subscribe) {
        const unsubToken = generateToken();
        await pool.query(
          `INSERT INTO nb_subscribers (email, name, source, unsubscribe_token, ip)
           VALUES ($1, $2, 'course_signup', $3, $4)
           ON CONFLICT (email) DO UPDATE SET
             name = COALESCE(EXCLUDED.name, nb_subscribers.name),
             status = 'active',
             updated_at = NOW()`,
          [emailLower, name?.trim() || null, unsubToken, getIP(req)]
        );
      }

      const token = issueCustomerToken(customerId, emailLower);
      setAuthCookie(res, 'nb_auth_token', token, 30 * 24 * 60 * 60 * 1000);
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e }, 'Auth register error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    try {
      const ip = getIP(req);
      if (!rateLimit(`auth-login:${ip}`, 5, 300000)) {
        return res.status(429).json({ error: MESSAGES.tooManyLoginsJa });
      }

      const { email, password } = req.body;
      if (!email?.trim() || !password) return res.status(400).json({ error: 'Email and password required' });

      const emailLower = normalizeEmail(email);
      const result = await pool.query(
        'SELECT id, email, name, password_hash FROM nb_customers WHERE LOWER(email) = $1 AND password_hash IS NOT NULL ORDER BY updated_at DESC LIMIT 1',
        [emailLower]
      );
      if (result.rows.length === 0) return res.status(401).json({ error: MESSAGES.invalidCredentialsJa });

      const customer = result.rows[0];
      const valid = await bcrypt.compare(password, customer.password_hash);
      if (!valid) return res.status(401).json({ error: MESSAGES.invalidCredentialsJa });

      const token = issueCustomerToken(customer.id, customer.email);
      setAuthCookie(res, 'nb_auth_token', token, 30 * 24 * 60 * 60 * 1000);
      res.json({ ok: true, name: customer.name });
    } catch (e) {
      logger.error({ err: e }, 'Auth login error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.get('/api/auth/me', customerAuth, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT c.id, c.email, c.name, c.created_at,
                COALESCE(json_agg(json_build_object(
                  'course_id', ca.course_id,
                  'access_token', ca.access_token,
                  'purchased_at', ca.purchased_at
                )) FILTER (WHERE ca.id IS NOT NULL), '[]') AS courses
         FROM nb_customers c
         LEFT JOIN nb_course_access ca ON ca.customer_id = c.id AND (ca.expires_at IS NULL OR ca.expires_at > NOW())
         WHERE c.id = $1
         GROUP BY c.id`,
        [req.customer.customerId]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Customer not found' });

      const customer = result.rows[0];
      const ownedCourses = customer.courses.map((course) => ({
        id: course.course_id,
        name: courses[course.course_id]?.name || course.course_id,
        lessonCount: courses[course.course_id]?.lessons?.length || 0,
        accessToken: course.access_token,
        purchasedAt: course.purchased_at
      }));

      res.json({
        id: customer.id,
        email: customer.email,
        name: customer.name,
        memberSince: customer.created_at,
        courses: ownedCourses
      });
    } catch (e) {
      logger.error({ err: e }, 'Auth me error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.post('/api/auth/forgot-password', async (req, res) => {
    try {
      const ip = getIP(req);
      if (!rateLimit(`auth-forgot:${ip}`, 3, 3600000)) {
        return res.status(429).json({ error: 'Too many requests. Please try again later.' });
      }

      const { email } = req.body;
      if (!email?.trim()) return res.status(400).json({ error: 'Email required' });

      const emailLower = normalizeEmail(email);
      const result = await pool.query(
        'SELECT id FROM nb_customers WHERE LOWER(email) = $1 AND password_hash IS NOT NULL LIMIT 1',
        [emailLower]
      );

      if (result.rows.length === 0) {
        return res.json({ ok: true, message: MESSAGES.forgotSuccessJa });
      }

      const resetToken = generateToken();
      const expires = new Date(Date.now() + 3600000);
      await pool.query(
        'UPDATE nb_customers SET reset_token = $1, reset_token_expires = $2 WHERE id = $3',
        [resetToken, expires, result.rows[0].id]
      );

      const resetUrl = `${siteUrl}/reset-password?token=${resetToken}`;
      try {
        await transporter.sendMail({
          from: smtpFrom,
          to: emailLower,
          subject: MESSAGES.resetSubjectJa,
          html: buildForgotPasswordEmail(resetUrl)
        });
      } catch (emailErr) {
        logger.error({ err: emailErr }, 'Forgot password email send failed');
      }

      res.json({ ok: true, message: MESSAGES.forgotSuccessJa });
    } catch (e) {
      logger.error({ err: e }, 'Forgot password error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.post('/api/auth/reset-password', async (req, res) => {
    try {
      const ip = getIP(req);
      if (!rateLimit(`auth-reset:${ip}`, 5, 300000)) {
        return res.status(429).json({ error: 'Too many requests' });
      }

      const { token, password } = req.body;
      if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
      if (password.length < 8) return res.status(400).json({ error: MESSAGES.passwordMinJa });

      const result = await pool.query(
        'SELECT id, email FROM nb_customers WHERE reset_token = $1 AND reset_token_expires > NOW()',
        [token]
      );
      if (result.rows.length === 0) return res.status(400).json({ error: MESSAGES.resetInvalidJa });

      const hash = await bcrypt.hash(password, 10);
      await pool.query(
        'UPDATE nb_customers SET password_hash = $1, reset_token = NULL, reset_token_expires = NULL, updated_at = NOW() WHERE id = $2',
        [hash, result.rows[0].id]
      );

      const authToken = issueCustomerToken(result.rows[0].id, result.rows[0].email);
      setAuthCookie(res, 'nb_auth_token', authToken, 30 * 24 * 60 * 60 * 1000);
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e }, 'Reset password error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  function buildMagicLinkEmail(magicUrl, customerName) {
    const greeting = customerName ? `${customerName}さん、` : '';
    return `<div style="max-width:600px;margin:0 auto;font-family:'Helvetica Neue',Arial,sans-serif;color:#2C2419;background:#FAF7F2;padding:40px;">
        <h2 style="font-size:1.4rem;color:#2C2419;margin-bottom:24px;">ログインリンク</h2>
        <p style="line-height:1.8;margin-bottom:16px;">${greeting}NamiBardenへのログインリンクをお送りします。</p>
        <p style="line-height:1.8;margin-bottom:24px;">下のボタンをクリックすると、自動的にログインしてマイコースページに移動します。このリンクは15分間有効です。</p>
        <p style="text-align:center;margin:32px 0;">
          <a href="${magicUrl}" style="display:inline-block;padding:14px 40px;background:#A8895E;color:#fff;text-decoration:none;border-radius:2px;font-size:1rem;letter-spacing:0.05em;">ログインする</a>
        </p>
        <p style="font-size:0.85rem;color:#8B7E6E;margin-top:24px;">このリンクに心当たりがない場合は、このメールを無視してください。</p>
        <hr style="border:none;border-top:1px solid #E8DFD3;margin:32px 0;">
        <p style="font-size:0.8rem;color:#A99E8F;text-align:center;">Nami Barden - namibarden.com</p>
      </div>`;
  }

  app.post('/api/auth/magic-link', async (req, res) => {
    try {
      const ip = getIP(req);
      if (!rateLimit(`auth-magic:${ip}`, 3, 3600000)) {
        return res.status(429).json({ error: 'リクエストが多すぎます。しばらくしてからお試しください。' });
      }

      const { email } = req.body;
      if (!email?.trim()) return res.status(400).json({ error: 'Email required' });

      const emailLower = normalizeEmail(email);
      const result = await pool.query(
        'SELECT id, email, name FROM nb_customers WHERE LOWER(email) = $1 ORDER BY updated_at DESC LIMIT 1',
        [emailLower]
      );

      const successMessage = 'ログインリンクをメールで送信しました。メールをご確認ください。';
      if (result.rows.length === 0) {
        return res.json({ ok: true, message: successMessage });
      }

      const customer = result.rows[0];
      const magicToken = jwt.sign(
        { role: 'magic-link', customerId: customer.id, email: customer.email },
        jwtSecret,
        { expiresIn: '15m' }
      );
      const magicUrl = `${siteUrl}/api/auth/magic-link?token=${magicToken}`;

      try {
        await transporter.sendMail({
          from: smtpFrom,
          to: emailLower,
          subject: '【NamiBarden】ログインリンク',
          html: buildMagicLinkEmail(magicUrl, customer.name)
        });
      } catch (emailErr) {
        logger.error({ err: emailErr }, 'Magic link email send failed');
      }

      res.json({ ok: true, message: successMessage });
    } catch (e) {
      logger.error({ err: e }, 'Magic link request error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.get('/api/auth/magic-link', (req, res) => {
    const token = req.query.token;
    if (!token) return res.redirect('/login?error=invalid-link');
    try {
      const decoded = jwt.verify(token, jwtSecret);
      if (decoded.role !== 'magic-link') return res.redirect('/login?error=invalid-link');
      const authToken = issueCustomerToken(decoded.customerId, decoded.email);
      setAuthCookie(res, 'nb_auth_token', authToken, 30 * 24 * 60 * 60 * 1000);
      res.redirect('/my-courses');
    } catch {
      res.redirect('/login?error=expired-link');
    }
  });

  app.post('/api/auth/logout', (_req, res) => {
    clearAuthCookie(res, 'nb_auth_token');
    res.json({ ok: true });
  });

  app.get('/api/auth/check', (req, res) => {
    const token = req.cookies?.nb_auth_token;
    if (!token) return res.json({ authenticated: false });
    try {
      const decoded = jwt.verify(token, jwtSecret);
      if (decoded.role === 'customer') return res.json({ authenticated: true, name: decoded.email });
      res.json({ authenticated: false });
    } catch {
      res.json({ authenticated: false });
    }
  });

  return { customerAuth };
}

module.exports = { createCustomerAuth };
