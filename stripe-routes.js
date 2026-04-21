const {
  findPaymentForRefund,
  upsertStripeRefund
} = require('./reporting-lib');

function createStripeRoutes({
  app,
  pool,
  stripe,
  logger,
  rateLimit,
  getIP,
  upsertCustomer,
  generateToken,
  courses: COURSES,
  siteUrl: SITE_URL,
  smtpFrom: SMTP_FROM,
  transporter,
  sendWhatsApp,
  namiJid: NAMI_JID,
  formatMoneyAmount,
  getAppPlanFromProduct,
  upsertAppEntitlement,
  sendLuminaLifecycleEmail,
  getStripePeriodStartSeconds,
  getStripePeriodEndSeconds,
  grantLuminaLifetime,
  recordOperationalAlert,
  stripeWebhookSecret: STRIPE_WEBHOOK_SECRET,
  escapeHtml,
  customerAuth,
  requireLuminaBridgeAuth,
  normalizeEmail,
  getLuminaEntitlementByEmail,
  createBillingPortalSessionForEmail,
  luminaSiteUrl: LUMINA_SITE_URL,
  luminaProducts: LUMINA_PRODUCTS,
  isAllowedLuminaReturnUrl,
  defaultLuminaSuccessUrl,
  defaultLuminaCancelUrl,
  normalizeLuminaCurrency,
  getLuminaCheckoutPrice,
  getLuminaCheckoutCopy,
  buildCourse2UpsellBlockHtml,
  verifyFlashToken,
  flashPrice
}) {
function buildLuminaCheckoutUrl(rawUrl, billingState) {
  if (!isAllowedLuminaReturnUrl(rawUrl)) return null;
  try {
    const parsed = new URL(rawUrl);
    parsed.searchParams.set('billing', billingState);
    return parsed.toString();
  } catch {
    return null;
  }
}

function withCheckoutSessionId(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const hash = parsed.hash || '';
    parsed.hash = '';
    parsed.searchParams.delete('session_id');
    const baseUrl = parsed.toString();
    const separator = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${separator}session_id={CHECKOUT_SESSION_ID}${hash}`;
  } catch {
    return rawUrl;
  }
}

async function deleteWebhookIdempotencyMarker(eventId) {
  try {
    await pool.query(`DELETE FROM nb_processed_webhooks WHERE event_id=$1`, [eventId]);
  } catch (err) {
    logger.error({ err, eventId }, 'Stripe webhook idempotency marker delete failed');
  }
}

// Best-effort: resolve the Stripe charge id for a Checkout Session so we can
// store it on nb_payments for refund linkage. If Stripe is unavailable or the
// retrieve fails, returns null — refund webhook will backfill later.
async function resolveSessionChargeId(session) {
  if (!stripe || !session?.payment_intent) return null;
  try {
    const pi = await stripe.paymentIntents.retrieve(session.payment_intent, {
      expand: ['latest_charge']
    });
    const charge = pi?.latest_charge;
    if (!charge) return null;
    return typeof charge === 'string' ? charge : charge.id || null;
  } catch (err) {
    logger.warn({ err, sessionId: session.id }, 'resolveSessionChargeId failed — will backfill via refund webhook');
    return null;
  }
}

app.post('/api/stripe/create-checkout-session', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments not configured' });
  try {
    const ip = getIP(req);
    if (!rateLimit(`stripe:${ip}`, 5, 300000)) {
      return res.status(429).json({ error: 'Too many requests' });
    }

    const {
      email,
      name,
      product,
      lang,
      currency,
      token: upgradeToken,
      flash: flashToken,
      success_url: successUrl,
      cancel_url: cancelUrl,
      return_url: returnUrl
    } = req.body;
    const en = lang === 'en';

    // Validate course-2-upgrade / course-2-flash: must own course-1
    if (product === 'course-2-upgrade' || product === 'course-2-flash') {
      if (!upgradeToken) return res.status(400).json({ error: 'Token required for upgrade' });
      const check = await pool.query(
        `SELECT email, customer_id FROM nb_course_access WHERE access_token = $1 AND course_id = 'course-1' LIMIT 1`,
        [upgradeToken]
      );
      if (check.rows.length === 0) return res.status(403).json({ error: 'Course 1 ownership required' });

      if (product === 'course-2-flash') {
        if (!flashToken) return res.status(400).json({ error: 'Flash token required' });
        const payload = verifyFlashToken(flashToken);
        if (!payload) return res.status(403).json({ error: 'Flash offer expired' });
        if (String(payload.sub) !== String(check.rows[0].customer_id)) {
          return res.status(403).json({ error: 'Flash offer not valid for this account' });
        }
      }
    }

    const products = {
      coaching: {
        name: en ? 'Executive Coaching — Monthly Plan' : 'エグゼクティブ・コーチング月額プラン',
        description: en ? '1x/month 90-min Zoom session + text support + online course' : '月1回・90分Zoomセッション + テキストサポート + オンライン講座',
        amount: 88000,
        mode: 'subscription',
        interval: 'month'
      },
      'certification-monthly': {
        name: en ? 'Consciousness Coach Certification — Monthly Plan' : '意識学コーチ認定コース — 月額プラン',
        description: en ? '1x/month 60-min Zoom + text support + assignments + certificate' : '月1回・60分Zoomセッション + テキストサポート + 実践課題 + 認定証',
        amount: 50000,
        mode: 'subscription',
        interval: 'month'
      },
      'certification-lumpsum': {
        name: en ? 'Consciousness Coach Certification — One-Time Payment' : '意識学コーチ認定コース — 一括払いプラン',
        description: en ? '12-month certification program (save ¥40,000)' : '12ヶ月認定プログラム一括払い（¥40,000お得）',
        amount: 560000,
        mode: 'payment'
      },
      'course-1': {
        name: COURSES['course-1'].name,
        description: en ? '8-lesson video course — attract your ideal partnership' : '全8レッスン動画コース — 意識の4ステップで本当のパートナーシップを引き寄せる',
        amount: 7800,
        mode: 'payment'
      },
      'course-2': {
        name: COURSES['course-2'].name,
        description: en ? '14 lessons — resolve relationship issues at a deeper level' : '全14レッスン — パートナーシップの問題を心の深いレベルから解決',
        amount: 9800,
        mode: 'payment'
      },
      'course-bundle': {
        name: `${COURSES['course-1'].name} + ${COURSES['course-2'].name} ${en ? 'Bundle' : 'セット'}`,
        description: en ? '22 lessons + bonus meditation (save ¥2,800)' : '全22レッスン＋ボーナス瞑想（2,800円おトク）',
        amount: 14800,
        mode: 'payment'
      },
      'course-2-upgrade': {
        name: COURSES['course-2'].name + (en ? ' (Upgrade)' : '（コース1受講者限定）'),
        description: en ? 'Special price for Course 1 students (save ¥2,800)' : 'コース1受講者特別価格（¥2,800おトク）',
        amount: 7000,
        mode: 'payment'
      },
      'course-2-flash': {
        name: COURSES['course-2'].name + (en ? ' (Flash 48h)' : '（48時間限定フラッシュ価格）'),
        description: en ? '48-hour flash deal for Course 1 students' : '48時間限定フラッシュ価格（コース1受講者限定）',
        amount: flashPrice,
        mode: 'payment'
      },
      'single-session': {
        name: en ? 'Private Consultation Session (60 min)' : '心の相談室 — パーソナルセッション（60分）',
        description: en ? 'A private 60-minute Zoom session with Nami Barden' : 'ナミ・バーデンとの60分プライベートZoomセッション',
        amount: 20000,
        mode: 'payment'
      },
      'couples-monthly': {
        name: en ? 'Couples Coaching — Monthly Plan' : 'カップルコーチング — 月額プラン',
        description: en ? '6-month couples coaching program (¥25,000/month)' : '6ヶ月カップルコーチング（月額¥25,000）',
        amount: 25000,
        mode: 'subscription',
        recurring: { interval: 'month', interval_count: 1 }
      },
      'couples-lumpsum': {
        name: en ? 'Couples Coaching — One-Time Payment' : 'カップルコーチング — 一括払い',
        description: en ? '6-month couples coaching program (save ¥25,000)' : '6ヶ月カップルコーチング一括払い（¥25,000お得）',
        amount: 125000,
        mode: 'payment'
      },
      ...LUMINA_PRODUCTS
    };

    const selectedProduct = product || 'coaching';
    const prod = products[selectedProduct];
    if (!prod) return res.status(400).json({ error: 'Invalid product' });
    const isLuminaProduct = !!getAppPlanFromProduct(selectedProduct);
    const explicitLuminaSuccessUrl = isLuminaProduct && isAllowedLuminaReturnUrl(successUrl)
      ? successUrl
      : null;
    const explicitLuminaCancelUrl = isLuminaProduct && isAllowedLuminaReturnUrl(cancelUrl)
      ? cancelUrl
      : null;
    const baseLuminaReturnUrl = returnUrl || explicitLuminaSuccessUrl || explicitLuminaCancelUrl || successUrl || cancelUrl || null;
    const resolvedLuminaSuccessUrl = explicitLuminaSuccessUrl || buildLuminaCheckoutUrl(baseLuminaReturnUrl, 'success');
    const resolvedLuminaCancelUrl = explicitLuminaCancelUrl || buildLuminaCheckoutUrl(baseLuminaReturnUrl, 'cancel');
    const luminaPrice = isLuminaProduct ? getLuminaCheckoutPrice(selectedProduct, currency || normalizeLuminaCurrency(null, lang)) : null;
    const luminaCopy = isLuminaProduct ? getLuminaCheckoutCopy(selectedProduct, lang) : null;

    const priceData = {
      currency: isLuminaProduct ? luminaPrice.currency : 'jpy',
      product_data: {
        name: isLuminaProduct ? luminaCopy.name : prod.name,
        description: isLuminaProduct ? luminaCopy.description : prod.description
      },
      unit_amount: isLuminaProduct ? luminaPrice.amount : prod.amount
    };
    if (isLuminaProduct) priceData.tax_behavior = 'inclusive';
    if (prod.recurring) priceData.recurring = prod.recurring;
    else if (prod.interval) priceData.recurring = { interval: prod.interval };

    const sessionParams = {
      mode: prod.mode,
      payment_method_types: ['card'],
      line_items: [{
        price_data: priceData,
        quantity: 1
      }],
      success_url: isLuminaProduct && resolvedLuminaSuccessUrl
        ? withCheckoutSessionId(resolvedLuminaSuccessUrl)
        : product === 'course-2-upgrade' || product === 'course-2-flash'
        ? `${SITE_URL}/watch?token=${upgradeToken || ''}&course=course-2`
        : product === 'single-session' || product?.startsWith('couples-')
        ? `${SITE_URL}/${product?.startsWith('couples-') ? 'couples-coaching' : ('consultation' + (en ? '-en' : ''))}?paid=1&session_id={CHECKOUT_SESSION_ID}`
        : isLuminaProduct
        ? `${defaultLuminaSuccessUrl()}&session_id={CHECKOUT_SESSION_ID}`
        : `${SITE_URL}/payment-success${en ? '-en' : ''}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: isLuminaProduct && resolvedLuminaCancelUrl
        ? resolvedLuminaCancelUrl
        : product === 'course-2-upgrade' || product === 'course-2-flash'
        ? `${SITE_URL}/watch?token=${upgradeToken || ''}`
        : product === 'single-session'
        ? `${SITE_URL}/consultation${en ? '-en' : ''}`
        : product?.startsWith('couples-')
        ? `${SITE_URL}/couples-coaching`
        : isLuminaProduct
        ? defaultLuminaCancelUrl()
        : `${SITE_URL}/payment-cancel${en ? '-en' : ''}`,
      locale: isLuminaProduct ? (lang || 'auto') : 'ja',
      metadata: {
        product: selectedProduct,
        billing_currency: priceData.currency
      },
      saved_payment_method_options: { payment_method_save: 'disabled' }
    };

    if (isLuminaProduct) {
      sessionParams.adaptive_pricing = { enabled: false };
    }

    if (prod.mode === 'payment') {
      sessionParams.invoice_creation = { enabled: true };
    }
    if (isLuminaProduct && prod.mode === 'subscription') {
      sessionParams.subscription_data = {
        trial_period_days: prod.trialDays || 0,
        metadata: {
          product: selectedProduct,
          app: prod.appSlug,
          plan_code: prod.planCode,
          billing_currency: priceData.currency
        }
      };
    }
    if (isLuminaProduct) {
      sessionParams.allow_promotion_codes = true;
    }

    if (product === 'course-2-upgrade' || product === 'course-2-flash') {
      const r = await pool.query(`SELECT email FROM nb_course_access WHERE access_token = $1 LIMIT 1`, [upgradeToken]);
      if (r.rows[0]?.email) sessionParams.customer_email = r.rows[0].email;
    } else if (email) {
      const safeEmail = normalizeEmail(email);
      const existingCustomer = await pool.query(
        `SELECT stripe_customer_id
         FROM nb_customers
         WHERE LOWER(email) = $1 AND stripe_customer_id IS NOT NULL
         ORDER BY updated_at DESC
         LIMIT 1`,
        [safeEmail]
      );
      if (existingCustomer.rows[0]?.stripe_customer_id) sessionParams.customer = existingCustomer.rows[0].stripe_customer_id;
      else sessionParams.customer_email = safeEmail;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    res.json({ url: session.url });
  } catch (e) {
    logger.error({ err: e }, 'Stripe checkout error');
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// ─── GET /api/stripe/verify-session ───
// Validates that a Stripe checkout session was actually paid
app.get('/api/stripe/verify-session', async (req, res) => {
  if (!stripe) return res.status(503).json({ valid: false });
  const { session_id } = req.query;
  if (!session_id || typeof session_id !== 'string') return res.json({ valid: false });
  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    const sessionProducts = ['single-session', 'couples-monthly', 'couples-lumpsum'];
    res.json({ valid: session.payment_status === 'paid' && sessionProducts.includes(session.metadata?.product) });
  } catch {
    res.json({ valid: false });
  }
});

// ─── POST /api/stripe/webhook ───
app.post('/api/stripe/webhook', async (req, res) => {
  if (!stripe) return res.sendStatus(503);

  let event;
  try {
    const sig = req.headers['stripe-signature'];
    if (!STRIPE_WEBHOOK_SECRET) {
      logger.error('Stripe webhook secret not configured — rejecting webhook');
      recordOperationalAlert({
        alertKey: 'stripe:webhook-secret-missing',
        source: 'stripe',
        severity: 'critical',
        title: 'Stripe webhook secret missing',
        message: 'Webhook requests are being rejected because STRIPE_WEBHOOK_SECRET is not configured.',
        details: { route: '/api/stripe/webhook' }
      }).catch((alertErr) => logger.error({ err: alertErr }, 'Operational alert write failed'));
      return res.status(503).json({ error: 'Webhook signing not configured' });
    }
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    logger.error({ err: e }, 'Stripe webhook signature failed');
    recordOperationalAlert({
      alertKey: 'stripe:webhook-signature',
      source: 'stripe',
      severity: 'warning',
      title: 'Stripe webhook signature failed',
      message: 'A Stripe webhook request failed signature verification.',
      details: {
        route: '/api/stripe/webhook',
        error: e?.message || String(e)
      }
    }).catch((alertErr) => logger.error({ err: alertErr }, 'Operational alert write failed'));
    return res.status(400).json({ error: 'Webhook signature verification failed' });
  }

  try {
    const inserted = await pool.query(
      `INSERT INTO nb_processed_webhooks (event_id, event_type)
       VALUES ($1, $2)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING id`,
      [event.id, event.type]
    );
    if (inserted.rows.length === 0) {
      return res.json({ received: true, duplicate: true });
    }
  } catch (e) {
    logger.error({ err: e, eventId: event.id }, 'Stripe webhook idempotency error');
    recordOperationalAlert({
      alertKey: 'stripe:webhook-idempotency',
      source: 'stripe',
      severity: 'critical',
      title: 'Stripe webhook bookkeeping failed',
      message: 'Webhook idempotency storage failed, so webhook processing cannot continue safely.',
      details: {
        eventId: event.id,
        eventType: event.type,
        error: e?.message || String(e)
      }
    }).catch((alertErr) => logger.error({ err: alertErr }, 'Operational alert write failed'));
    return res.status(500).json({ error: 'Webhook bookkeeping failed' });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const customerId = session.customer;
        const email = session.customer_details?.email || session.customer_email;
        const name = session.customer_details?.name || null;
        const product = session.metadata?.product || 'coaching';
        const appPlan = getAppPlanFromProduct(product);

        // Lumina lifetime purchases (including legacy product aliases during rollout)
        if (session.mode === 'payment' && appPlan?.appSlug === 'lumina' && appPlan.planCode === 'lifetime') {
          let custId;
          try {
            custId = await upsertCustomer(email, name, customerId || `lifetime_${session.id}`);
          } catch (e) {
            logger.error({ err: e, email, product }, 'Lumina lifetime: upsert customer failed');
            recordOperationalAlert({
              alertKey: `stripe:lumina-lifetime-upsert:${session.id}`,
              source: 'stripe',
              severity: 'critical',
              title: 'Lumina lifetime: customer upsert failed',
              message: 'Paid customer could not be recorded. Deleting idempotency marker so Stripe retries.',
              details: { sessionId: session.id, product, email, error: e?.message || String(e) }
            }).catch((alertErr) => logger.error({ err: alertErr }, 'Operational alert write failed'));
            await deleteWebhookIdempotencyMarker(event.id);
            return res.status(500).json({ error: 'Customer upsert failed' });
          }

          try {
            const chargeId = await resolveSessionChargeId(session);
            await pool.query(
              `INSERT INTO nb_payments (customer_id, stripe_payment_intent_id, stripe_charge_id, stripe_invoice_id, amount, currency, status, product_name)
               VALUES ($1, $2, $3, $4, $5, $6, 'succeeded', $7)
               ON CONFLICT (stripe_payment_intent_id) DO NOTHING`,
              [custId, session.payment_intent, chargeId, session.invoice || null, session.amount_total, session.currency, product]
            );
          } catch (e) {
            logger.error({ err: e, email, product }, 'Lumina lifetime: payment insert failed');
          }

          let grantResult;
          try {
            grantResult = await grantLuminaLifetime(custId, {
              stripeSessionId: session.id,
              stripePaymentIntentId: session.payment_intent,
              sourceProduct: product
            });
          } catch (e) {
            logger.error({ err: e, email, product }, 'Lumina lifetime: entitlement grant failed');
            recordOperationalAlert({
              alertKey: `stripe:lumina-lifetime-grant:${session.id}`,
              source: 'stripe',
              severity: 'critical',
              title: 'Lumina lifetime: entitlement grant failed',
              message: 'Paid customer could not be granted Lumina lifetime access. Deleting idempotency marker so Stripe retries.',
              details: { sessionId: session.id, product, email, customerId: custId, error: e?.message || String(e) }
            }).catch((alertErr) => logger.error({ err: alertErr }, 'Operational alert write failed'));
            await deleteWebhookIdempotencyMarker(event.id);
            return res.status(500).json({ error: 'Entitlement grant failed' });
          }

          if (grantResult.wasNew) {
            try {
              await sendLuminaLifecycleEmail('lifetime_activated', { email, name, productName: product });
            } catch (e) {
              logger.error({ err: e, email, product }, 'Lumina lifetime: activation email failed');
            }

            sendWhatsApp(
              NAMI_JID,
              `Lumina Lifetime purchased\n${name || email}\n${formatMoneyAmount(session.amount_total, session.currency)}`
            ).catch(e => logger.error({ err: e }, 'WhatsApp fire-and-forget error'));
          }

          logger.info({ email, product, wasNew: grantResult.wasNew }, 'Stripe: Lumina lifetime purchased');
          break;
        }

        // Course purchases (one-time payment)
        if (['course-1', 'course-2', 'course-bundle', 'course-2-upgrade', 'course-2-flash'].includes(product)) {
          let custId;
          try {
            custId = await upsertCustomer(email, name, customerId || `onetime_${session.id}`);
          } catch (e) {
            logger.error({ err: e, product, email }, 'Stripe course: upsert customer failed');
            recordOperationalAlert({
              alertKey: `stripe:course-upsert-customer:${session.id}`,
              source: 'stripe',
              severity: 'critical',
              title: 'Course purchase: customer upsert failed',
              message: `Customer paid for ${product} but their account could not be created. Manual intervention required.`,
              details: { sessionId: session.id, product, email, error: e?.message || String(e) }
            }).catch((alertErr) => logger.error({ err: alertErr }, 'Operational alert write failed'));
            break;
          }

          // Record payment
          try {
            const chargeId = await resolveSessionChargeId(session);
            await pool.query(
              `INSERT INTO nb_payments (customer_id, stripe_payment_intent_id, stripe_charge_id, stripe_invoice_id, amount, currency, status, product_name)
               VALUES ($1, $2, $3, $4, $5, $6, 'succeeded', $7)
               ON CONFLICT (stripe_payment_intent_id) DO NOTHING`,
              [custId, session.payment_intent, chargeId, null, session.amount_total, session.currency, product]
            );
          } catch (e) {
            logger.error({ err: e, product, email }, 'Stripe course: payment insert failed');
          }

          // Determine which courses to grant — bundle shares one token
          const isCourse2Addon = product === 'course-2-upgrade' || product === 'course-2-flash';
          const courseIds = product === 'course-bundle' ? ['course-1', 'course-2']
            : isCourse2Addon ? ['course-2'] : [product];

          // Grant course access
          let accessToken;
          try {
            // For upgrades/flash, reuse existing token so the customer's watch link stays the same
            if (isCourse2Addon) {
              const existing = await pool.query(
                `SELECT access_token FROM nb_course_access WHERE customer_id = $1 AND course_id = 'course-1' LIMIT 1`,
                [custId]
              );
              accessToken = existing.rows[0]?.access_token || generateToken();
            } else {
              accessToken = generateToken();
            }

            for (const courseId of courseIds) {
              await pool.query(
                `INSERT INTO nb_course_access (customer_id, course_id, access_token, email, stripe_session_id)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (customer_id, course_id) DO UPDATE SET
                   access_token = EXCLUDED.access_token, stripe_session_id = EXCLUDED.stripe_session_id`,
                [custId, courseId, accessToken, email, session.id]
              );
            }
          } catch (e) {
            logger.error({ err: e, product, email }, 'Stripe course: access grant failed');
            recordOperationalAlert({
              alertKey: `stripe:course-access-grant:${session.id}`,
              source: 'stripe',
              severity: 'critical',
              title: 'Course purchase: access grant failed',
              message: `Customer paid for ${product} but course access could not be granted. Manual intervention required.`,
              details: { sessionId: session.id, product, email, customerId: custId, error: e?.message || String(e) }
            }).catch((alertErr) => logger.error({ err: alertErr }, 'Operational alert write failed'));
          }

          const token = accessToken;

          // Send access email
          const courseNames = courseIds.map(id => COURSES[id]?.name).join(' & ');
          const watchUrl = `${SITE_URL}/watch?token=${token}`;

          const course2UpsellHtml = product === 'course-1'
            ? buildCourse2UpsellBlockHtml({ token, siteUrl: SITE_URL })
            : '';

          try {
            await transporter.sendMail({
              from: SMTP_FROM,
              to: email,
              subject: `【NamiBarden】${courseNames} — ご購入ありがとうございます`,
              html: `<div style="max-width:600px;margin:0 auto;font-family:'Helvetica Neue',Arial,sans-serif;color:#2C2419;background:#FAF7F2;padding:40px;">
                <h2 style="font-size:1.4rem;color:#2C2419;margin-bottom:24px;">ご購入ありがとうございます</h2>
                <p style="line-height:1.8;margin-bottom:16px;">${name ? escapeHtml(name) + '様' : ''},</p>
                <p style="line-height:1.8;margin-bottom:16px;">「${escapeHtml(courseNames)}」のご購入、誠にありがとうございます。</p>
                <p style="line-height:1.8;margin-bottom:24px;">下のボタンをクリックして、すぐに視聴を開始できます。</p>
                <p style="text-align:center;margin:32px 0;">
                  <a href="${watchUrl}" style="display:inline-block;padding:14px 40px;background:#A8895E;color:#fff;text-decoration:none;border-radius:2px;font-size:1rem;letter-spacing:0.05em;">コースを視聴する</a>
                </p>
                <p style="line-height:1.8;margin-bottom:8px;font-size:0.9rem;color:#8B7E6E;">このリンクはあなた専用です。他の方と共有しないでください。</p>
                <p style="line-height:1.8;margin-bottom:24px;font-size:0.9rem;color:#8B7E6E;">リンクを紛失した場合は、購入時のメールアドレスで再送できます。</p>
                <div style="background:#F0EAE0;border-left:3px solid #C4A882;padding:16px 20px;margin:24px 0;border-radius:2px;">
                  <p style="line-height:1.7;margin-bottom:8px;font-size:0.92rem;color:#2C2419;"><strong>いつでもマイコースにアクセスできます</strong></p>
                  <p style="line-height:1.7;font-size:0.88rem;color:#5C4F3D;margin-bottom:10px;">パスワードを設定していなくても大丈夫。ご購入のメールアドレスだけで、ワンクリックでログインできます。</p>
                  <p style="font-size:0.88rem;"><a href="${SITE_URL}/email-login" style="color:#A8895E;text-decoration:none;">メールでログイン →</a></p>
                </div>${course2UpsellHtml}
                <hr style="border:none;border-top:1px solid #E8DFD3;margin:32px 0;">
                <p style="font-size:0.8rem;color:#A99E8F;text-align:center;">Nami Barden — namibarden.com</p>
              </div>`
            });
          } catch (e) { logger.error({ err: e }, 'Course access email failed'); }

          // WhatsApp notify Nami
          const amount = session.amount_total;
          sendWhatsApp(NAMI_JID,
            `🎓 コース購入!\n${name || email}\n${courseNames}\n¥${amount?.toLocaleString()}`).catch(e => logger.error({ err: e }, 'WhatsApp fire-and-forget error'));

          logger.info({ product, email }, "Stripe: course purchased");
          break;
        }

        // Single-session or other one-time payments (non-course)
        if (session.mode === 'payment' && ['single-session', 'certification-lumpsum', 'couples-lumpsum'].includes(product)) {
          let custId;
          try {
            custId = await upsertCustomer(email, name, customerId || `onetime_${session.id}`);
          } catch (e) {
            logger.error({ err: e, product, email }, 'Stripe payment: upsert customer failed');
            recordOperationalAlert({
              alertKey: `stripe:payment-upsert-customer:${session.id}`,
              source: 'stripe',
              severity: 'critical',
              title: 'Payment: customer upsert failed',
              message: `Customer paid for ${product} but their account could not be created. Manual intervention required.`,
              details: { sessionId: session.id, product, email, error: e?.message || String(e) }
            }).catch((alertErr) => logger.error({ err: alertErr }, 'Operational alert write failed'));
            break;
          }

          try {
            const chargeId = await resolveSessionChargeId(session);
            await pool.query(
              `INSERT INTO nb_payments (customer_id, stripe_payment_intent_id, stripe_charge_id, stripe_invoice_id, amount, currency, status, product_name)
               VALUES ($1, $2, $3, $4, $5, $6, 'succeeded', $7)
               ON CONFLICT (stripe_payment_intent_id) DO NOTHING`,
              [custId, session.payment_intent, chargeId, null, session.amount_total, session.currency, product]
            );
          } catch (e) {
            logger.error({ err: e, product, email }, 'Stripe payment: payment insert failed');
          }

          const amount = session.amount_total;
          const label = product === 'single-session' ? 'パーソナルセッション'
            : product === 'couples-lumpsum' ? 'カップルコーチング（一括）'
            : 'コーチ認定コース（一括）';
          sendWhatsApp(NAMI_JID,
            `💫 ${label}購入!\n${name || email}\n¥${amount?.toLocaleString()}`).catch(e => logger.error({ err: e }, 'WhatsApp fire-and-forget error'));

          // Send confirmation email for single session
          if (product === 'single-session' && email) {
            try {
              await transporter.sendMail({
                from: SMTP_FROM,
                to: email,
                subject: '【NamiBarden】心の相談室 — お申し込みありがとうございます',
                html: `<div style="max-width:600px;margin:0 auto;font-family:'Helvetica Neue',Arial,sans-serif;color:#2C2419;background:#FAF7F2;padding:40px;">
                  <h2 style="font-size:1.4rem;color:#2C2419;margin-bottom:24px;">お申し込みありがとうございます</h2>
                  <p style="line-height:1.8;margin-bottom:16px;">${name ? escapeHtml(name) + '様' : ''},</p>
                  <p style="line-height:1.8;margin-bottom:16px;">心の相談室 パーソナルセッション（60分）のお申し込み、誠にありがとうございます。</p>
                  <p style="line-height:1.8;margin-bottom:16px;">ナミより、24時間以内にメールにてセッション日程の調整をご連絡いたします。</p>
                  <p style="line-height:1.8;margin-bottom:24px;">ご不明な点がございましたら、このメールにご返信ください。</p>
                  <hr style="border:none;border-top:1px solid #E8DFD3;margin:32px 0;">
                  <p style="font-size:0.8rem;color:#A99E8F;text-align:center;">Nami Barden — namibarden.com</p>
                </div>`
              });
            } catch (e) { logger.error({ err: e }, 'Single session email failed'); }
          }

          logger.info({ product, email }, "Stripe: payment purchased");
          break;
        }

        // Subscription handling (coaching etc.)
        if (session.mode === 'subscription') {
          let custId;
          try {
            custId = await upsertCustomer(email, name, customerId);
          } catch (e) {
            logger.error({ err: e, product, email }, 'Stripe subscription: upsert customer failed');
            recordOperationalAlert({
              alertKey: `stripe:sub-upsert-customer:${session.id}`,
              source: 'stripe',
              severity: 'critical',
              title: 'Subscription: customer upsert failed',
              message: `Customer subscribed to ${product} but their account could not be created. Manual intervention required.`,
              details: { sessionId: session.id, product, email, error: e?.message || String(e) }
            }).catch((alertErr) => logger.error({ err: alertErr }, 'Operational alert write failed'));
            break;
          }

          // Record subscription
          let sub;
          try {
            sub = await stripe.subscriptions.retrieve(session.subscription);
            const periodStart = getStripePeriodStartSeconds(sub);
            const periodEnd = getStripePeriodEndSeconds(sub);
            const priceId = sub.items?.data?.[0]?.price?.id || null;
            await pool.query(
              `INSERT INTO nb_subscriptions (customer_id, stripe_subscription_id, stripe_price_id, status, product_name, current_period_start, current_period_end)
               VALUES ($1, $2, $3, $4, $5, to_timestamp($6), to_timestamp($7))
               ON CONFLICT (stripe_subscription_id) DO UPDATE SET
                 status = EXCLUDED.status, current_period_start = EXCLUDED.current_period_start,
                 current_period_end = EXCLUDED.current_period_end, updated_at = NOW()`,
              [custId, sub.id, priceId, sub.status, product,
               periodStart, periodEnd]
            );
          } catch (e) {
            logger.error({ err: e, product, email }, 'Stripe subscription: subscription insert failed');
            recordOperationalAlert({
              alertKey: `stripe:sub-insert:${session.id}`,
              source: 'stripe',
              severity: 'critical',
              title: 'Subscription: DB record failed',
              message: `Customer subscribed to ${product} but subscription could not be recorded in DB.`,
              details: { sessionId: session.id, product, email, subscriptionId: session.subscription, error: e?.message || String(e) }
            }).catch((alertErr) => logger.error({ err: alertErr }, 'Operational alert write failed'));
            break;
          }

          try {
            await upsertAppEntitlement(custId, product, sub);
          } catch (e) {
            logger.error({ err: e, product, email }, 'Stripe subscription: entitlement upsert failed');
          }

          if (getAppPlanFromProduct(product) && email) {
            const periodEnd = getStripePeriodEndSeconds(sub);
            try {
              await sendLuminaLifecycleEmail('activated', {
                email,
                name,
                productName: product,
                trialEnd: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
                currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null
              });
            } catch (e) {
              logger.error({ err: e, product, email }, 'Stripe subscription: lifecycle email failed');
            }
          }

          // Notify Nami
          const subLabel = product === 'couples-monthly'
            ? 'カップルコーチング'
            : getAppPlanFromProduct(product)
            ? 'LUMINA'
            : 'コーチング';
          const subItem = sub.items?.data?.[0];
          const subAmount = subItem?.price?.unit_amount;
          const subCurrency = subItem?.price?.currency || 'jpy';
          const subInterval = subItem?.price?.recurring?.interval === 'year' ? 'year' : 'month';
          sendWhatsApp(NAMI_JID,
            `💳 新規${subLabel}契約!\n${name || email}\n${formatMoneyAmount(subAmount, subCurrency)} / ${subInterval} subscription started`).catch(e => logger.error({ err: e }, 'WhatsApp fire-and-forget error'));

          logger.info({ subscriptionId: sub.id, email }, "Stripe: new subscription");
        }
        break;
      }

      case 'customer.subscription.updated': {
        try {
          const sub = event.data.object;
          const previousAttributes = event.data.previous_attributes || {};
          const periodStart = getStripePeriodStartSeconds(sub);
          const periodEnd = getStripePeriodEndSeconds(sub);
          await pool.query(
            `UPDATE nb_subscriptions SET
               status = $1, current_period_start = to_timestamp($2), current_period_end = to_timestamp($3),
               cancel_at = $4, canceled_at = $5, updated_at = NOW()
             WHERE stripe_subscription_id = $6`,
            [sub.status, periodStart, periodEnd,
             sub.cancel_at ? new Date(sub.cancel_at * 1000) : null,
             sub.canceled_at ? new Date(sub.canceled_at * 1000) : null,
             sub.id]
          );
          const subRow = await pool.query(
            `SELECT customer_id, product_name FROM nb_subscriptions WHERE stripe_subscription_id = $1 LIMIT 1`,
            [sub.id]
          );
          if (subRow.rows[0]) {
            if (getAppPlanFromProduct(subRow.rows[0].product_name)) {
              const currentEntitlement = await pool.query(
                `SELECT status FROM nb_app_entitlements
                 WHERE customer_id = $1 AND app_slug = 'lumina'
                 LIMIT 1`,
                [subRow.rows[0].customer_id]
              );
              if (currentEntitlement.rows[0]?.status === 'lifetime') {
                logger.info({ subscriptionId: sub.id, customerId: subRow.rows[0].customer_id }, 'Stripe: subscription update ignored for lifetime Lumina entitlement');
                break;
              }
            }
            await upsertAppEntitlement(subRow.rows[0].customer_id, subRow.rows[0].product_name, sub);
            if (
              getAppPlanFromProduct(subRow.rows[0].product_name) &&
              sub.cancel_at_period_end &&
              Object.prototype.hasOwnProperty.call(previousAttributes, 'cancel_at_period_end') &&
              previousAttributes.cancel_at_period_end !== true
            ) {
              const custRow = await pool.query(
                `SELECT email, name FROM nb_customers WHERE id = $1 LIMIT 1`,
                [subRow.rows[0].customer_id]
              );
              if (custRow.rows[0]?.email) {
                await sendLuminaLifecycleEmail('cancel_scheduled', {
                  email: custRow.rows[0].email,
                  name: custRow.rows[0].name,
                  productName: subRow.rows[0].product_name,
                  currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null
                });
              }
            }
          }
          logger.info({ subscriptionId: sub.id, status: sub.status }, "Stripe: subscription updated");
        } catch (e) {
          logger.error({ err: e, eventType: 'customer.subscription.updated' }, 'Stripe webhook case error');
          recordOperationalAlert({
            alertKey: 'stripe:webhook-case:customer.subscription.updated',
            source: 'stripe',
            severity: 'critical',
            title: 'Stripe subscription update handler failed',
            message: 'A customer.subscription.updated webhook could not be processed.',
            details: {
              eventId: event.id,
              subscriptionId: event.data.object?.id,
              error: e?.message || String(e)
            }
          }).catch((alertErr) => logger.error({ err: alertErr }, 'Operational alert write failed'));
        }
        break;
      }

      case 'customer.subscription.deleted': {
        try {
          const sub = event.data.object;
          const periodEnd = getStripePeriodEndSeconds(sub);
          const subRow = await pool.query(
            `SELECT customer_id, product_name FROM nb_subscriptions WHERE stripe_subscription_id = $1 LIMIT 1`,
            [sub.id]
          );
          if (subRow.rows[0] && getAppPlanFromProduct(subRow.rows[0].product_name)) {
            const currentEntitlement = await pool.query(
              `SELECT status FROM nb_app_entitlements
               WHERE customer_id = $1 AND app_slug = 'lumina'
               LIMIT 1`,
              [subRow.rows[0].customer_id]
            );
            if (currentEntitlement.rows[0]?.status === 'lifetime') {
              logger.info({ subscriptionId: sub.id, customerId: subRow.rows[0].customer_id }, 'Stripe: subscription deletion ignored for lifetime Lumina entitlement');
              break;
            }
          }

          await pool.query(
            `UPDATE nb_subscriptions SET
               status = 'canceled',
               current_period_end = COALESCE(to_timestamp($2), current_period_end),
               cancel_at = COALESCE($3, cancel_at),
               canceled_at = NOW(),
               updated_at = NOW()
             WHERE stripe_subscription_id = $1`,
            [sub.id, periodEnd, sub.cancel_at ? new Date(sub.cancel_at * 1000) : null]
          );
          if (subRow.rows[0]) {
            await upsertAppEntitlement(subRow.rows[0].customer_id, subRow.rows[0].product_name, {
              ...sub,
              status: 'canceled',
              canceled_at: sub.canceled_at || Math.floor(Date.now() / 1000)
            });
          }

          const custRow = await pool.query(
            `SELECT c.email, c.name FROM nb_customers c JOIN nb_subscriptions s ON s.customer_id = c.id
             WHERE s.stripe_subscription_id = $1`,
            [sub.id]
          );
          if (custRow.rows.length > 0) {
            const productName = subRow.rows[0]?.product_name || null;
            if (getAppPlanFromProduct(productName)) {
              await sendLuminaLifecycleEmail('canceled', {
                email: custRow.rows[0].email,
                name: custRow.rows[0].name,
                productName,
                currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null
              });
              sendWhatsApp(
                NAMI_JID,
                `LUMINA membership ended\n${custRow.rows[0].name || custRow.rows[0].email}`
              ).catch(e => logger.error({ err: e }, 'WhatsApp fire-and-forget error'));
            } else {
              sendWhatsApp(
                NAMI_JID,
                `Coaching subscription canceled\n${custRow.rows[0].name || custRow.rows[0].email}`
              ).catch(e => logger.error({ err: e }, 'WhatsApp fire-and-forget error'));
            }
          }
          logger.info({ subscriptionId: sub.id }, "Stripe: subscription canceled");
        } catch (e) {
          logger.error({ err: e, eventType: 'customer.subscription.deleted' }, 'Stripe webhook case error');
          recordOperationalAlert({
            alertKey: 'stripe:webhook-case:customer.subscription.deleted',
            source: 'stripe',
            severity: 'critical',
            title: 'Stripe subscription delete handler failed',
            message: 'A customer.subscription.deleted webhook could not be processed.',
            details: {
              eventId: event.id,
              subscriptionId: event.data.object?.id,
              error: e?.message || String(e)
            }
          }).catch((alertErr) => logger.error({ err: alertErr }, 'Operational alert write failed'));
        }
        break;
      }

      case 'refund.created':
      case 'refund.updated': {
        const refund = event.data.object;
        try {
          const { paymentRow, pi, ch } = await findPaymentForRefund(pool, refund);
          await upsertStripeRefund(pool, refund, paymentRow, { pi, ch, eventCreated: event.created });

          if (!paymentRow) {
            logger.warn({ refundId: refund.id, pi, ch }, 'Refund recorded as orphan; will reconcile when payment arrives');
          } else {
            logger.info({ refundId: refund.id, paymentId: paymentRow.id, eventType: event.type }, 'Stripe refund recorded');
          }
        } catch (e) {
          logger.error({ err: e, eventId: event.id, refundId: refund?.id, eventType: event.type }, 'Stripe refund handler failed');
          recordOperationalAlert({
            alertKey: `stripe:refund-record:${refund?.id || event.id}`,
            source: 'stripe',
            severity: 'critical',
            title: 'Stripe refund record failed',
            message: 'A refund webhook could not be recorded. Deleting the idempotency marker so Stripe retries.',
            details: {
              eventId: event.id,
              eventType: event.type,
              refundId: refund?.id || null,
              error: e?.message || String(e)
            }
          }).catch((alertErr) => logger.error({ err: alertErr }, 'Operational alert write failed'));
          await deleteWebhookIdempotencyMarker(event.id);
          return res.status(500).json({ error: 'Refund record failed' });
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        try {
          const invoice = event.data.object;
          const custRow = await pool.query(
            'SELECT id FROM nb_customers WHERE stripe_customer_id = $1',
            [invoice.customer]
          );
          if (custRow.rows.length > 0) {
            let invoiceProduct = 'coaching';
            if (invoice.subscription) {
              const subRow = await pool.query(
                'SELECT product_name FROM nb_subscriptions WHERE stripe_subscription_id = $1',
                [invoice.subscription]
              );
              if (subRow.rows[0]?.product_name) invoiceProduct = subRow.rows[0].product_name;
            }
            await pool.query(
              `INSERT INTO nb_payments (customer_id, stripe_payment_intent_id, stripe_charge_id, stripe_invoice_id, amount, currency, status, product_name)
               VALUES ($1, $2, $3, $4, $5, $6, 'succeeded', $7)
               ON CONFLICT (stripe_payment_intent_id) DO NOTHING`,
              [custRow.rows[0].id, invoice.payment_intent, invoice.charge || null, invoice.id,
               invoice.amount_paid, invoice.currency, invoiceProduct]
            );
          }
          logger.info({ invoiceId: invoice.id }, "Stripe: payment succeeded");
        } catch (e) {
          logger.error({ err: e, eventType: 'invoice.payment_succeeded' }, 'Stripe webhook case error');
          recordOperationalAlert({
            alertKey: 'stripe:webhook-case:invoice.payment_succeeded',
            source: 'stripe',
            severity: 'critical',
            title: 'Stripe invoice success handler failed',
            message: 'An invoice.payment_succeeded webhook could not be processed.',
            details: {
              eventId: event.id,
              invoiceId: event.data.object?.id,
              error: e?.message || String(e)
            }
          }).catch((alertErr) => logger.error({ err: alertErr }, 'Operational alert write failed'));
        }
        break;
      }

      case 'invoice.payment_failed': {
        try {
          const invoice = event.data.object;
          let productName = null;
          if (invoice.subscription) {
            const subRow = await pool.query(
              'SELECT product_name FROM nb_subscriptions WHERE stripe_subscription_id = $1',
              [invoice.subscription]
            );
            productName = subRow.rows[0]?.product_name || null;
          }
          const custRow = await pool.query(
            'SELECT c.email, c.name FROM nb_customers c WHERE c.stripe_customer_id = $1',
            [invoice.customer]
          );
          if (custRow.rows.length > 0) {
            if (getAppPlanFromProduct(productName)) {
              await sendLuminaLifecycleEmail('payment_failed', {
                email: custRow.rows[0].email,
                name: custRow.rows[0].name,
                productName
              });
              sendWhatsApp(
                NAMI_JID,
                `LUMINA payment failed\n${custRow.rows[0].name || custRow.rows[0].email}\nCheck the Stripe dashboard.`
              ).catch(e => logger.error({ err: e }, 'WhatsApp fire-and-forget error'));
            } else {
              sendWhatsApp(
                NAMI_JID,
                `Payment failed\n${custRow.rows[0].name || custRow.rows[0].email}\nCheck the Stripe dashboard.`
              ).catch(e => logger.error({ err: e }, 'WhatsApp fire-and-forget error'));
            }
          }
          recordOperationalAlert({
            alertKey: `stripe:invoice-payment-failed:${invoice.id}`,
            source: 'stripe',
            severity: 'warning',
            title: 'Stripe invoice payment failed',
            message: 'A subscription invoice payment failed and may need customer follow-up.',
            details: {
              invoiceId: invoice.id,
              subscriptionId: invoice.subscription || null,
              customerId: invoice.customer || null,
              productName,
              amountDue: invoice.amount_due,
              currency: invoice.currency,
              attemptCount: invoice.attempt_count
            }
          }).catch((alertErr) => logger.error({ err: alertErr }, 'Operational alert write failed'));
          logger.warn({ invoiceId: invoice.id }, "Stripe: payment failed");
        } catch (e) {
          logger.error({ err: e, eventType: 'invoice.payment_failed' }, 'Stripe webhook case error');
          recordOperationalAlert({
            alertKey: 'stripe:webhook-case:invoice.payment_failed',
            source: 'stripe',
            severity: 'critical',
            title: 'Stripe invoice failure handler failed',
            message: 'An invoice.payment_failed webhook could not be processed.',
            details: {
              eventId: event.id,
              invoiceId: event.data.object?.id,
              error: e?.message || String(e)
            }
          }).catch((alertErr) => logger.error({ err: alertErr }, 'Operational alert write failed'));
        }
        break;
      }
    }
  } catch (e) {
    logger.error({ err: e }, 'Stripe webhook processing error');
    recordOperationalAlert({
      alertKey: `stripe:webhook-processing:${event?.type || 'unknown'}`,
      source: 'stripe',
      severity: 'critical',
      title: 'Stripe webhook processing failed',
      message: 'Stripe webhook processing failed outside the per-event handlers.',
      details: {
        eventId: event?.id || null,
        eventType: event?.type || null,
        error: e?.message || String(e)
      }
    }).catch((alertErr) => logger.error({ err: alertErr }, 'Operational alert write failed'));
  }

  res.json({ received: true });
});

// ─── POST /api/stripe/customer-portal ───
app.post('/api/stripe/customer-portal', customerAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments not configured' });
  try {
    // Use the authenticated customer's email from JWT, not request body
    const email = req.customer.email;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const custRow = await pool.query(
      'SELECT stripe_customer_id FROM nb_customers WHERE email = $1', [email]
    );
    if (custRow.rows.length === 0 || !custRow.rows[0].stripe_customer_id) {
      return res.status(404).json({ error: 'No subscription found for this email' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: custRow.rows[0].stripe_customer_id,
      return_url: `${SITE_URL}/executive-coaching`
    });
    res.json({ url: session.url });
  } catch (e) {
    logger.error({ err: e }, 'Stripe portal error');
    res.status(500).json({ error: 'Failed to create portal session' });
  }
});

app.post('/api/internal/lumina/entitlement', requireLuminaBridgeAuth, async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!email) return res.status(400).json({ error: 'Email required' });
    const entitlement = await getLuminaEntitlementByEmail(email);
    res.json({ email, entitlement });
  } catch (e) {
    logger.error({ err: e }, 'Lumina entitlement bridge error');
    res.status(500).json({ error: 'Failed to load entitlement' });
  }
});

app.post('/api/internal/lumina/customer-portal', requireLuminaBridgeAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments not configured' });
  try {
    const email = normalizeEmail(req.body?.email);
    const returnUrl = req.body?.return_url || `${LUMINA_SITE_URL}/`;
    const session = await createBillingPortalSessionForEmail(email, returnUrl);
    res.json({ url: session.url });
  } catch (e) {
    logger.error({ err: e }, 'Lumina portal bridge error');
    res.status(e.message === 'No subscription found for this email' ? 404 : 500).json({ error: e.message || 'Failed to create portal session' });
  }
});
}

module.exports = { createStripeRoutes };
