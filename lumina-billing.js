function createLuminaBilling({
  pool,
  stripe,
  transporter,
  logger,
  normalizeEmail,
  escapeHtml,
  siteUrl,
  luminaSiteUrl,
  luminaAllowedHosts,
  luminaBridgeSecret,
  smtpUser,
  smtpPass,
  smtpFrom,
  products
}) {
  function isAllowedLuminaReturnUrl(rawUrl) {
    if (!rawUrl) return false;
    try {
      const parsed = new URL(rawUrl);
      return ['https:', 'http:'].includes(parsed.protocol) && luminaAllowedHosts.includes(parsed.hostname);
    } catch {
      return false;
    }
  }

  function defaultLuminaSuccessUrl() {
    return `${luminaSiteUrl}/?billing=success`;
  }

  function defaultLuminaCancelUrl() {
    return `${luminaSiteUrl}/?billing=cancel`;
  }

  function getAppPlanFromProduct(productName) {
    if (productName === 'lumina-monthly') return { appSlug: 'lumina', planCode: 'monthly' };
    if (productName === 'lumina-annual') return { appSlug: 'lumina', planCode: 'annual' };
    return null;
  }

  function getLuminaPlanCopy(productName) {
    if (productName === 'lumina-annual') {
      return {
        en: 'LUMINA Annual Membership',
        ja: 'LUMINA \u5e74\u9593\u30e1\u30f3\u30d0\u30fc\u30b7\u30c3\u30d7'
      };
    }
    return {
      en: 'LUMINA Monthly Membership',
      ja: 'LUMINA \u6708\u984d\u30e1\u30f3\u30d0\u30fc\u30b7\u30c3\u30d7'
    };
  }

  function normalizeLuminaCurrency(rawCurrency, lang) {
    if (rawCurrency === 'jpy' || rawCurrency === 'usd') return rawCurrency;
    return lang === 'ja' ? 'jpy' : 'usd';
  }

  function getLuminaCheckoutPrice(productName, currency) {
    const product = products[productName];
    if (!product) return null;
    const safeCurrency = normalizeLuminaCurrency(currency);
    return {
      currency: safeCurrency,
      amount: product.prices?.[safeCurrency] || product.prices?.jpy || null
    };
  }

  function getLuminaCheckoutCopy(productName, lang) {
    const product = products[productName];
    if (!product) return null;
    const useEnglish = lang === 'en';
    return {
      name: useEnglish ? (product.nameEn || product.nameJa) : (product.nameJa || product.nameEn),
      description: useEnglish ? (product.descriptionEn || product.descriptionJa) : (product.descriptionJa || product.descriptionEn)
    };
  }

  function formatMoneyAmount(amount, currency) {
    if (amount == null || !currency) return '??';
    const safeCurrency = String(currency).toUpperCase();
    const usesMinorUnits = safeCurrency !== 'JPY';
    const normalizedAmount = usesMinorUnits ? amount / 100 : amount;
    return new Intl.NumberFormat(safeCurrency === 'JPY' ? 'ja-JP' : 'en-US', {
      style: 'currency',
      currency: safeCurrency,
      minimumFractionDigits: usesMinorUnits ? 2 : 0,
      maximumFractionDigits: usesMinorUnits ? 2 : 0
    }).format(normalizedAmount);
  }

  function formatLifecycleDate(value) {
    if (!value) return null;
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  }

  async function sendLuminaLifecycleEmail(type, payload) {
    if (!smtpUser || !smtpPass) return;
    const email = normalizeEmail(payload?.email);
    if (!email) return;

    const safeName = payload?.name ? escapeHtml(payload.name) : null;
    const plan = getLuminaPlanCopy(payload?.productName);
    const appUrl = `${luminaSiteUrl}/`;
    const billingUrl = `${(siteUrl || 'https://namibarden.com').replace(/\/+$/, '')}/lumina`;
    const trialEnd = formatLifecycleDate(payload?.trialEnd);
    const periodEnd = formatLifecycleDate(payload?.currentPeriodEnd);
    let subject = 'LUMINA update';
    let title = 'LUMINA';
    let intro = '';
    let detail = '';
    let ctaLabel = 'Open Lumina';
    let ctaUrl = appUrl;

    if (type === 'activated') {
      subject = 'Your LUMINA access is active';
      title = 'Your LUMINA access is ready';
      intro = `${plan.en} is now active. ${plan.ja} \u306e\u30a2\u30af\u30bb\u30b9\u304c\u6709\u52b9\u306b\u306a\u308a\u307e\u3057\u305f\u3002`;
      detail = trialEnd
        ? `Your trial is active through <strong>${escapeHtml(trialEnd)}</strong>. \u30c8\u30e9\u30a4\u30a2\u30eb\u671f\u9593\u306f <strong>${escapeHtml(trialEnd)}</strong> \u307e\u3067\u3067\u3059\u3002`
        : periodEnd
        ? `Your current billing period runs through <strong>${escapeHtml(periodEnd)}</strong>. \u73fe\u5728\u306e\u5229\u7528\u671f\u9593\u306f <strong>${escapeHtml(periodEnd)}</strong> \u307e\u3067\u3067\u3059\u3002`
        : 'You can begin your next session in Lumina now. \u3059\u3050\u306b Lumina \u3092\u59cb\u3081\u3089\u308c\u307e\u3059\u3002';
      ctaLabel = 'Enter Lumina';
      ctaUrl = appUrl;
    } else if (type === 'cancel_scheduled') {
      subject = 'Your LUMINA cancellation is scheduled';
      title = 'Your membership is still active';
      intro = `We received a request to cancel ${plan.en}. ${plan.ja} \u306e\u89e3\u7d04\u4e88\u5b9a\u3092\u53d7\u3051\u4ed8\u3051\u307e\u3057\u305f\u3002`;
      detail = periodEnd
        ? `Your access stays active through <strong>${escapeHtml(periodEnd)}</strong>. \u305d\u308c\u307e\u3067\u306f\u5f15\u304d\u7d9a\u304d\u3054\u5229\u7528\u3044\u305f\u3060\u3051\u307e\u3059\u3002`
        : 'Your access stays active until the end of the current billing period. \u73fe\u5728\u306e\u5229\u7528\u671f\u9593\u304c\u7d42\u308f\u308b\u307e\u3067\u306f\u5f15\u304d\u7d9a\u304d\u3054\u5229\u7528\u3044\u305f\u3060\u3051\u307e\u3059\u3002';
      ctaLabel = 'Manage membership';
      ctaUrl = appUrl;
    } else if (type === 'canceled') {
      subject = 'Your LUMINA membership ended';
      title = 'Your LUMINA membership has ended';
      intro = `${plan.en} is no longer active. ${plan.ja} \u306f\u73fe\u5728\u505c\u6b62\u3057\u3066\u3044\u307e\u3059\u3002`;
      detail = periodEnd
        ? `Your last active day was <strong>${escapeHtml(periodEnd)}</strong>. \u518d\u958b\u3057\u305f\u3044\u5834\u5408\u306f\u3044\u3064\u3067\u3082\u623b\u308c\u307e\u3059\u3002`
        : 'You can return any time and start again from namibarden.com. \u3044\u3064\u3067\u3082\u518d\u958b\u3067\u304d\u307e\u3059\u3002';
      ctaLabel = 'Restart membership';
      ctaUrl = billingUrl;
    } else if (type === 'payment_failed') {
      subject = 'Update your LUMINA billing details';
      title = 'We could not process your latest payment';
      intro = `There was a billing issue for ${plan.en}. ${plan.ja} \u306e\u6700\u65b0\u306e\u304a\u652f\u6255\u3044\u3092\u51e6\u7406\u3067\u304d\u307e\u305b\u3093\u3067\u3057\u305f\u3002`;
      detail = 'Please sign in and update your billing details so access is not interrupted. \u30b5\u30a4\u30f3\u30a4\u30f3\u3057\u3066\u304a\u652f\u6255\u3044\u60c5\u5831\u3092\u3054\u78ba\u8a8d\u304f\u3060\u3055\u3044\u3002';
      ctaLabel = 'Manage billing';
      ctaUrl = appUrl;
    } else {
      return;
    }

    try {
      await transporter.sendMail({
        to: email,
        from: smtpFrom,
        subject,
        html: `
          <div style="font-family:Georgia,'Times New Roman',serif;background:#f6f0e8;padding:28px;color:#352c26">
            <div style="max-width:640px;margin:0 auto;background:#fffdf8;border:1px solid #eadfce;border-radius:22px;padding:32px 28px;box-shadow:0 12px 32px rgba(53,44,38,0.06)">
              <p style="font:600 12px/1.2 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;letter-spacing:0.18em;text-transform:uppercase;color:#8d6f4f;margin:0 0 10px">Lumina Membership</p>
              <h1 style="font-size:30px;font-weight:400;letter-spacing:0.08em;margin:0 0 14px;color:#352c26">${title}</h1>
              <p style="font:400 15px/1.8 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#5f5348;margin:0 0 16px">${safeName ? `${safeName}, ` : ''}${intro}</p>
              <div style="border:1px solid #eadfce;border-radius:16px;background:#fcf7f1;padding:16px 18px;margin:0 0 18px">
                <p style="font:600 13px/1.7 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#4c4035;margin:0">${detail}</p>
              </div>
              <p style="margin:0 0 22px">
                <a href="${ctaUrl}" style="display:inline-block;background:#352c26;color:#fff;text-decoration:none;padding:12px 18px;border-radius:12px;font:600 14px/1.2 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">${ctaLabel}</a>
              </p>
              <p style="font:400 13px/1.8 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#7a6d60;margin:0">
                Billing is managed on <a href="${billingUrl}" style="color:#7a6d60">namibarden.com</a>. Use the same email address in Lumina and at checkout.
              </p>
            </div>
          </div>`
      });
    } catch (e) {
      logger.error({ err: e, email, type }, 'Lumina lifecycle email failed');
    }
  }

  function getStripePeriodStartSeconds(sub) {
    if (!sub) return null;
    return sub.current_period_start || sub.trial_start || sub.start_date || sub.created || null;
  }

  function getStripePeriodEndSeconds(sub) {
    if (!sub) return null;
    return sub.current_period_end || sub.cancel_at || sub.trial_end || sub.canceled_at || null;
  }

  async function upsertAppEntitlement(customerId, productName, sub) {
    const appPlan = getAppPlanFromProduct(productName);
    if (!appPlan || !customerId || !sub?.id) return;
    try {
      const periodStart = getStripePeriodStartSeconds(sub);
      const periodEnd = getStripePeriodEndSeconds(sub);

      await pool.query(
        `INSERT INTO nb_app_entitlements (
            customer_id, app_slug, plan_code, status, stripe_subscription_id, source_product_name,
            current_period_start, current_period_end, trial_end, cancel_at, canceled_at, metadata
          )
          VALUES (
            $1, $2, $3, $4, $5, $6,
            to_timestamp($7), to_timestamp($8), $9, $10, $11, $12::jsonb
          )
          ON CONFLICT (customer_id, app_slug) DO UPDATE SET
            plan_code = EXCLUDED.plan_code,
            status = EXCLUDED.status,
            stripe_subscription_id = EXCLUDED.stripe_subscription_id,
            source_product_name = EXCLUDED.source_product_name,
            current_period_start = EXCLUDED.current_period_start,
            current_period_end = EXCLUDED.current_period_end,
            trial_end = EXCLUDED.trial_end,
            cancel_at = EXCLUDED.cancel_at,
            canceled_at = EXCLUDED.canceled_at,
            metadata = EXCLUDED.metadata,
            updated_at = NOW()`,
        [
          customerId,
          appPlan.appSlug,
          appPlan.planCode,
          sub.status || 'inactive',
          sub.id,
          productName,
          periodStart || Math.floor(Date.now() / 1000),
          periodEnd || Math.floor(Date.now() / 1000),
          sub.trial_end ? new Date(sub.trial_end * 1000) : null,
          sub.cancel_at ? new Date(sub.cancel_at * 1000) : null,
          sub.canceled_at ? new Date(sub.canceled_at * 1000) : null,
          JSON.stringify({
            cancel_at_period_end: !!sub.cancel_at_period_end,
            latest_invoice: sub.latest_invoice || null,
            stripe_price_id: sub.items?.data?.[0]?.price?.id || null
          })
        ]
      );
    } catch (err) {
      logger.error({ err, customerId, productName }, 'upsertAppEntitlement DB error');
      throw err;
    }
  }

  function computeEntitlementAccess(row) {
    if (!row) {
      return {
        hasAccess: false,
        accessState: 'inactive'
      };
    }

    const now = Date.now();
    const periodEnd = row.current_period_end ? new Date(row.current_period_end).getTime() : 0;
    const trialEnd = row.trial_end ? new Date(row.trial_end).getTime() : 0;
    if (row.status === 'canceled') {
      return {
        appSlug: row.app_slug,
        planCode: row.plan_code,
        status: row.status,
        hasAccess: false,
        accessState: 'expired',
        currentPeriodEnd: row.current_period_end,
        currentPeriodStart: row.current_period_start,
        trialEnd: row.trial_end,
        cancelAt: row.cancel_at,
        canceledAt: row.canceled_at,
        sourceProductName: row.source_product_name
      };
    }
    const inTrial = row.status === 'trialing' && trialEnd > now;
    const activePeriod = ['active', 'trialing', 'past_due'].includes(row.status) && Math.max(periodEnd, trialEnd) > now;
    let accessState = 'inactive';
    if (inTrial) accessState = 'trialing';
    else if (row.status === 'past_due' && periodEnd > now) accessState = 'grace';
    else if (activePeriod) accessState = 'active';

    return {
      appSlug: row.app_slug,
      planCode: row.plan_code,
      status: row.status,
      hasAccess: accessState === 'active' || accessState === 'trialing' || accessState === 'grace',
      accessState,
      currentPeriodEnd: row.current_period_end,
      currentPeriodStart: row.current_period_start,
      trialEnd: row.trial_end,
      cancelAt: row.cancel_at,
      canceledAt: row.canceled_at,
      sourceProductName: row.source_product_name
    };
  }

  async function getLuminaEntitlementByEmail(email) {
    const safeEmail = normalizeEmail(email);
    if (!safeEmail) return computeEntitlementAccess(null);

    try {
      const result = await pool.query(
        `SELECT e.app_slug, e.plan_code, e.status, e.current_period_start, e.current_period_end,
                e.trial_end, e.cancel_at, e.canceled_at, e.source_product_name
         FROM nb_customers c
         JOIN nb_app_entitlements e ON e.customer_id = c.id
         WHERE LOWER(c.email) = $1 AND e.app_slug = 'lumina'
         ORDER BY e.updated_at DESC, c.updated_at DESC
         LIMIT 1`,
        [safeEmail]
      );
      return computeEntitlementAccess(result.rows[0] || null);
    } catch (err) {
      logger.error({ err, email: safeEmail }, 'getLuminaEntitlementByEmail DB error');
      throw err;
    }
  }

  async function createBillingPortalSessionForEmail(email, returnUrl) {
    const safeEmail = normalizeEmail(email);
    if (!safeEmail) throw new Error('Email required');

    try {
      const customerResult = await pool.query(
        `SELECT stripe_customer_id
         FROM nb_customers
         WHERE LOWER(email) = $1 AND stripe_customer_id IS NOT NULL
         ORDER BY updated_at DESC
         LIMIT 1`,
        [safeEmail]
      );
      if (customerResult.rows.length === 0 || !customerResult.rows[0].stripe_customer_id) {
        throw new Error('No subscription found for this email');
      }

      return stripe.billingPortal.sessions.create({
        customer: customerResult.rows[0].stripe_customer_id,
        return_url: isAllowedLuminaReturnUrl(returnUrl) ? returnUrl : `${luminaSiteUrl}/`
      });
    } catch (err) {
      // Re-throw known business errors without extra logging
      if (err.message === 'No subscription found for this email') throw err;
      logger.error({ err, email: safeEmail }, 'createBillingPortalSessionForEmail error');
      throw err;
    }
  }

  function requireLuminaBridgeAuth(req, res, next) {
    if (!luminaBridgeSecret) {
      return res.status(503).json({ error: 'Lumina bridge not configured' });
    }
    const provided = req.headers['x-lumina-bridge-key'];
    if (provided !== luminaBridgeSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  }

  return {
    getAppPlanFromProduct,
    normalizeLuminaCurrency,
    getLuminaCheckoutPrice,
    getLuminaCheckoutCopy,
    formatMoneyAmount,
    sendLuminaLifecycleEmail,
    getStripePeriodStartSeconds,
    getStripePeriodEndSeconds,
    upsertAppEntitlement,
    getLuminaEntitlementByEmail,
    createBillingPortalSessionForEmail,
    requireLuminaBridgeAuth,
    isAllowedLuminaReturnUrl,
    defaultLuminaSuccessUrl,
    defaultLuminaCancelUrl
  };
}

module.exports = {
  createLuminaBilling
};
