# Phase 1 — Lumina → ¥1,980 lifetime one-time purchase

**Status:** approved post-consensus (Opus + GPT-5.4 xhigh)
**Owner:** Gil (product), Claude (spec), Codex-spark (implementation), Claude (review+deploy)
**Blast radius:** 1 active Lumina subscriber (annual, via migration)

## 1. Product decision (locked)

| Item | Before | After |
|---|---|---|
| Pricing | Monthly ¥2,980 / Annual ¥29,800 + 7-day trial | One-time **¥1,980 lifetime, tax-inclusive** + 7-day money-back guarantee |
| Billing mode | Stripe `subscription` | Stripe `payment` (one-time) |
| Currency | JPY + USD | **JPY-only.** Overseas buyers rely on card FX. Removes tax/refund dual-currency surface |
| Stripe catalog | Stripe Price IDs (recurring) | Inline Checkout `price_data` (no new Stripe Product/Price created) |
| Tax | Inclusive-display via convention | Explicit: `price_data.tax_behavior = 'inclusive'`. ¥1,980 includes Japan consumption tax |
| Existing subs | N/A | Auto-upgrade to lifetime free; Stripe sub canceled; **proactive prorated refund** of unused annual portion |
| Access window | Period-based, trial-gated | Forever (once paid); `refunded` / `revoked` statuses are absorbing |
| Future content | N/A | Included — lifetime = all current + future Lumina content |

## 2. Grounded code inventory

### NamiBarden (`/root/projects/NamiBarden/`)

| File | Lines | Change |
|---|---|---|
| `app-config.js` | 8–39 | Replace `LUMINA_PRODUCTS`: keep `lumina-monthly`/`lumina-annual` entries as **legacy aliases** that resolve to the lifetime price (`mode: 'payment'`, `prices: { jpy: 1980 }`, no recurring, no trialDays). Add `lumina-lifetime` entry. Legacy aliases exist so the Lumina app's pre-deploy UI keeps working during the rollout gap. Drop in a follow-up PR once Lumina app is updated everywhere |
| `lumina-billing.js` | 36–38 | `getAppPlanFromProduct` — `lumina-lifetime` → `{ appSlug:'lumina', planCode:'lifetime' }`; legacy names still resolve |
| `lumina-billing.js` | 41–52 | `getLuminaPlanCopy` — add `lumina-lifetime` branch |
| `lumina-billing.js` | 103–187 | `sendLuminaLifecycleEmail` — add types `lifetime_activated` and `lifetime_upgrade`. Bilingual EN/JP |
| `lumina-billing.js` | 199–250 | `upsertAppEntitlement` — **add lifetime-absorbing guard**: the UPSERT's UPDATE clause must include `WHERE nb_app_entitlements.status != 'lifetime' AND nb_app_entitlements.status NOT IN ('refunded','revoked')`. This ensures subscription webhooks cannot downgrade a lifetime/refunded row |
| `lumina-billing.js` | 252–298 | `computeEntitlementAccess` — add branches at top: (a) `if (row.status === 'lifetime')` → `{hasAccess:true, accessState:'active', lifetimeGrantedAt: row.lifetime_granted_at}`, (b) `if (['canceled','refunded','revoked'].includes(row.status))` → `{hasAccess:false, accessState: row.status}` |
| `lumina-billing.js` | 300–320 | `getLuminaEntitlementByEmail` — **add `lifetime_granted_at` to SELECT** so UI can render "Lifetime member since X" |
| `lumina-billing.js` | 362–378 | Export new `grantLuminaLifetime(customerId, {stripeSessionId, stripePaymentIntentId, sourceProduct})` — inserts/upserts entitlement with status='lifetime', lifetime_granted_at=NOW(), metadata with session+PI. Returns `{wasNew: boolean}` (true if this call transitioned the row to lifetime). `wasNew=false` means we already granted lifetime — email callers use this to suppress duplicate sends. UPSERT includes `WHERE status NOT IN ('refunded','revoked')` so replays don't resurrect refunded rows |
| `server.js` | constructor | Wire `grantLuminaLifetime` into `createStripeRoutes(...)` params |
| `stripe-routes.js` | 1–41 | Accept `grantLuminaLifetime` param |
| `stripe-routes.js` | 250–261 | **Gate `subscription_data` on `prod.mode === 'subscription'`**. Today unconditional — breaks lifetime |
| `stripe-routes.js` | 197–240 | Set `price_data.tax_behavior = 'inclusive'` on the lumina-lifetime line item |
| `stripe-routes.js` | 369–489 | Add `checkout.session.completed` branch for `session.mode === 'payment' && product === 'lumina-lifetime'`. On grant/customer-upsert failure: `DELETE FROM nb_processed_webhooks WHERE event_id=$1` and return HTTP 5xx so Stripe retries. Email send gated on `wasNew` from `grantLuminaLifetime` |
| `stripe-routes.js` | 637–695 (`subscription.updated`) | Before calling `upsertAppEntitlement` + lifecycle emails, `SELECT status FROM nb_app_entitlements WHERE customer_id=$1 AND app_slug='lumina'`. If `lifetime`, skip entirely |
| `stripe-routes.js` | 698–765 (`subscription.deleted`) | Same check as above. If row is already `lifetime`, skip the subscriptions-table update, skip upsert, skip `sendLuminaLifecycleEmail('canceled')`, skip WhatsApp "membership ended" |
| `public/lumina.html` | full | Rebuild as bilingual page. Structure: `<body data-lang="ja">` default. Two sibling `<section lang="ja">` and `<section lang="en">` blocks server-rendered. CSS: `body[data-lang="en"] [lang="ja"] { display:none }` and vice versa. Language switcher sets cookie + attribute, NO content swap via JS |
| `public/lumina-en.html` | N/A | Do not create. Single bilingual page only |
| `public/js/lumina-billing.js` | full | Update client: single CTA per locale, money-back-guarantee copy, POST `{product:'lumina-lifetime', email, lang, currency:'jpy'}` |
| `schema.sql` | 134–156 | Add `lifetime_granted_at TIMESTAMP NULL` to `nb_app_entitlements` |
| `migrations/001_lumina_lifetime.sql` *(new)* | — | Adds `lifetime_granted_at` column + creates `nb_lumina_migration_audit` table |
| `scripts/migrate-lumina-to-lifetime.js` *(new)* | — | One-shot migration with `--dry-run` / `--live` / `--confirm-count=N` / `--only-email=X`. Defaults to `plan_code='annual'` restriction |
| `scripts/revoke-lumina-lifetime.js` *(new)* | — | Manual refund helper: flips status to `refunded` |

### Lumina app (`/root/projects/Lumina/`)

| File | Lines | Change |
|---|---|---|
| `server.js` | 660–664 | `renewalStillActive` — change from status allowlist to `!!(entitlement.hasAccess && !entitlement.cancelAt)`. Makes the check status-agnostic and future-proof |
| `src/app.jsx` | 786–787 | `statusCopy` — add `lifetime` variant: "Lifetime access — no renewal needed" / 「ライフタイム（更新不要）」 |
| `src/app.jsx` | 1479–1481 | Membership label — add lifetime branch: "Lifetime access" / 「ライフタイムアクセス」 |
| `src/app.jsx` | 1566–1575 | **Gate the entire billing-management card** on `entitlement.status !== 'lifetime'`. For lifetime users, render "Lifetime member since [lifetimeGrantedAt]" with no CTA |
| `src/app.jsx` | 597–604, 853–867, 2000–2006 | Any remaining `lumina-monthly`/`lumina-annual` product key references must be dead-code-guarded behind `status !== 'lifetime'` checks. After followup cleanup PR, these paths should route to `lumina-lifetime` |

## 3. Data model

```sql
-- migrations/001_lumina_lifetime.sql

ALTER TABLE nb_app_entitlements
  ADD COLUMN IF NOT EXISTS lifetime_granted_at TIMESTAMP;

CREATE TABLE IF NOT EXISTS nb_lumina_migration_audit (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER REFERENCES nb_customers(id),
  email VARCHAR(255),
  old_status VARCHAR(50),
  old_plan_code VARCHAR(100),
  old_stripe_subscription_id VARCHAR(255),
  old_current_period_end TIMESTAMP,
  old_subscription_row JSONB,         -- snapshot of nb_subscriptions row before change
  stripe_cancel_result TEXT,
  prorated_refund_jpy INTEGER,         -- the refund amount admin issued manually, for audit
  refund_stripe_charge_id VARCHAR(255),
  new_status VARCHAR(50) DEFAULT 'lifetime',
  email_sent BOOLEAN DEFAULT FALSE,
  error_message TEXT,
  migrated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lumina_migration_audit_customer ON nb_lumina_migration_audit(customer_id);
```

Status column remains `VARCHAR(50)` unconstrained — new values (`lifetime`, `refunded`, `revoked`) require no schema change.

### Metadata writes — null-safe

**All metadata updates use:** `metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(...)` — `NULL || {...}` returns NULL in Postgres, which silently drops the audit trail.

## 4. Migration script — `scripts/migrate-lumina-to-lifetime.js`

```
Usage:
  node scripts/migrate-lumina-to-lifetime.js --dry-run
  node scripts/migrate-lumina-to-lifetime.js --live --confirm-count=1
  node scripts/migrate-lumina-to-lifetime.js --live --only-email=foo@bar.com
```

### Guardrails

- Refuse to run without explicit `--dry-run` or `--live`.
- `--live` requires either `--confirm-count=N` (asserts the candidate count) or `--only-email=X` (asserts specific target).
- Default candidate query: `WHERE app_slug='lumina' AND status IN ('active','trialing','past_due') AND plan_code IN ('monthly','annual')`.
- If discovered count ≠ `--confirm-count`, abort before any writes. Protects against accidental scope expansion.

### Algorithm (per candidate, `--live`)

1. **Stripe cancel first** (idempotent). `stripe.subscriptions.cancel(sub_id, { invoice_now: false, prorate: false })`. Catch "already canceled" (`resource_missing`) as non-fatal. Non-retryable errors → skip this customer, log, continue batch.
2. **Transactional DB update.** In a single `BEGIN; ... COMMIT;`:
   - Snapshot `nb_subscriptions` row to a local var.
   - `UPDATE nb_subscriptions SET status='canceled', canceled_at=NOW(), updated_at=NOW() WHERE stripe_subscription_id=$1`.
   - `UPDATE nb_app_entitlements SET status='lifetime', plan_code='lifetime', stripe_subscription_id=NULL, current_period_end=NULL, trial_end=NULL, cancel_at=NULL, canceled_at=NOW(), lifetime_granted_at=NOW(), metadata=COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('converted_from', old_status, 'migrated_from_sub', old_sub_id, 'migrated_at', now()) WHERE customer_id=$1 AND app_slug='lumina'`.
   - `INSERT INTO nb_lumina_migration_audit (customer_id, email, old_status, old_plan_code, old_stripe_subscription_id, old_current_period_end, old_subscription_row, stripe_cancel_result, prorated_refund_jpy, refund_stripe_charge_id) VALUES (...)`. Admin fills `prorated_refund_jpy` + `refund_stripe_charge_id` in the audit AFTER issuing the manual refund (next step).
3. **Manual refund step** (operator, not script). Admin looks up the last annual charge in Stripe dashboard, computes `(days_remaining / 365) × ¥29,800`, refunds partially via dashboard. Records charge ID + refund JPY back into the audit row via a one-liner `UPDATE nb_lumina_migration_audit ...`. Script prints the exact computation and SQL to run.
4. **Email (outside tx).** Send `lifetime_upgrade` email. Mark `email_sent=TRUE` in audit. Failure logs but doesn't fail the migration.

### Dry-run

Logs exactly what would happen for each candidate, including the refund computation. No DB writes, no Stripe calls, no emails.

### Email copy (`lifetime_upgrade`)

Bilingual EN+JP sections side by side (existing pattern):

> EN: "Thanks for being an early Lumina member. We've converted your {annual} subscription to a lifetime one-time purchase — ¥1,980 is the new forever price. No more subscription payments. Because you paid for a year, we've refunded the unused portion (¥{X}) back to your card — check your statement in a few days."
>
> JP: equivalent translation.

## 5. Refund helper — `scripts/revoke-lumina-lifetime.js`

```
Usage: node scripts/revoke-lumina-lifetime.js --email foo@bar.com --reason "customer requested within 7 days"
```

Flips `nb_app_entitlements.status` to `refunded`, writes audit, does NOT touch Stripe (admin refunds separately in dashboard). **Cache-bust:** after flip, POST `/internal/lumina/entitlement-cache-bust?email=X` to Lumina app to clear its 60s cache, else verification sees stale `hasAccess:true`. *(If no cache-bust endpoint exists, add one. Simple: clears in-memory cache map entry by email, bridge-auth protected.)*

## 6. Checkout flow

In `stripe-routes.js` checkout handler:

```js
// Gate subscription_data on sub mode (previously unconditional for Lumina)
if (isLuminaProduct && prod.mode === 'subscription') {
  sessionParams.subscription_data = { ... };  // existing block
}
if (isLuminaProduct) {
  sessionParams.allow_promotion_codes = true;  // keep for lifetime too
}

// Tax-inclusive pricing
priceData.tax_behavior = 'inclusive';  // for lumina-lifetime (and fine to set for all JPY-only paths)
```

For lifetime: `sessionParams.mode = 'payment'`, `invoice_creation: { enabled: true }` already present at line 247.

## 7. Webhook handler — new branch

In `stripe-routes.js:369` `checkout.session.completed`, added **before** the course-purchase block:

```js
if (session.mode === 'payment' && product === 'lumina-lifetime') {
  let custId;
  try {
    custId = await upsertCustomer(email, name, customerId || `lifetime_${session.id}`);
  } catch (e) {
    logger.error({ err: e, email }, 'Lumina lifetime: upsert customer failed');
    recordOperationalAlert({
      alertKey: `stripe:lumina-lifetime-upsert:${session.id}`,
      source: 'stripe', severity: 'critical',
      title: 'Lumina lifetime: customer upsert failed',
      message: 'Paid customer could not be recorded. Deleting idempotency marker so Stripe retries.',
      details: { sessionId: session.id, email, error: e?.message }
    }).catch(() => {});
    await pool.query(`DELETE FROM nb_processed_webhooks WHERE event_id=$1`, [event.id]);
    return res.status(500).json({ error: 'Customer upsert failed' });
  }

  try {
    await pool.query(
      `INSERT INTO nb_payments (customer_id, stripe_payment_intent_id, stripe_invoice_id, amount, currency, status, product_name)
       VALUES ($1, $2, $3, $4, $5, 'succeeded', $6)
       ON CONFLICT (stripe_payment_intent_id) DO NOTHING`,
      [custId, session.payment_intent, session.invoice || null, session.amount_total, session.currency, 'lumina-lifetime']
    );
  } catch (e) {
    logger.error({ err: e, email }, 'Lumina lifetime: payment insert failed');
    // Non-fatal — payment can be backfilled from Stripe. Don't unwind idempotency for this.
  }

  let grantResult;
  try {
    grantResult = await grantLuminaLifetime(custId, {
      stripeSessionId: session.id,
      stripePaymentIntentId: session.payment_intent,
      sourceProduct: 'lumina-lifetime'
    });
  } catch (e) {
    logger.error({ err: e, email }, 'Lumina lifetime: entitlement grant failed');
    recordOperationalAlert({ /* critical */ }).catch(() => {});
    await pool.query(`DELETE FROM nb_processed_webhooks WHERE event_id=$1`, [event.id]);
    return res.status(500).json({ error: 'Entitlement grant failed' });
  }

  if (grantResult.wasNew) {
    try {
      await sendLuminaLifecycleEmail('lifetime_activated', { email, name, productName: 'lumina-lifetime' });
    } catch (e) {
      logger.error({ err: e, email }, 'Lumina lifetime: activation email failed');
      // Non-fatal
    }

    sendWhatsApp(NAMI_JID,
      `🌙 Lumina Lifetime購入!\n${name || email}\n${formatMoneyAmount(session.amount_total, session.currency)}`)
      .catch(() => {});
  }

  logger.info({ email, wasNew: grantResult.wasNew }, 'Stripe: Lumina lifetime purchased');
  break;
}
```

## 8. Bilingual pricing page — `public/lumina.html`

Structure (single file, server-renders both languages, CSS-gated):

```html
<!DOCTYPE html>
<html>
<head>
  <script>
    // Set data-lang on body BEFORE first paint, from cookie or ?lang=
    (function() {
      var p = new URLSearchParams(location.search).get('lang');
      var c = document.cookie.match(/(?:^|;\s*)nb_lang=([^;]+)/);
      document.documentElement.dataset.lang = p || (c && c[1]) || 'ja';
    })();
  </script>
  <style>
    html[data-lang="en"] [lang="ja"] { display: none; }
    html[data-lang="ja"] [lang="en"] { display: none; }
  </style>
</head>
<body>
  <section lang="ja">
    <h1>LUMINA ライフタイムアクセス</h1>
    <p class="price">¥1,980 <span class="note">（税込・一度きりのお支払い）</span></p>
    <p class="guarantee">7日間返金保証</p>
    <ul>
      <li>Lumina 90日間ガイド付きジャーニー</li>
      <li>週ごとのシンセシス</li>
      <li>リフレクションライブラリ</li>
      <li>今後のすべてのアップデートを含む</li>
    </ul>
    <button onclick="startCheckout('ja')">今すぐ購入</button>
  </section>
  <section lang="en">
    <h1>LUMINA Lifetime Access</h1>
    <p class="price">¥1,980 <span class="note">(tax-inclusive · one-time payment)</span></p>
    <p class="guarantee">7-day money-back guarantee</p>
    <ul>
      <li>90-day guided Lumina journey</li>
      <li>Weekly synthesis</li>
      <li>Reflection library</li>
      <li>All future updates included</li>
    </ul>
    <button onclick="startCheckout('en')">Purchase now</button>
  </section>
  <nav class="lang-toggle">
    <a href="?lang=ja" onclick="setLang('ja')">日本語</a>
    <a href="?lang=en" onclick="setLang('en')">English</a>
  </nav>
</body>
</html>
```

**No JavaScript content swap.** Language toggle sets cookie + `data-lang` attribute. Both language blocks are always in the DOM, always in the HTTP response, visibility is pure CSS. Eliminates the localStorage-race-condition class of bleed bugs.

## 9. Test plan

Test IDs map to the verification loop proof log.

### Unit / local
1. `computeEntitlementAccess({status:'lifetime', lifetime_granted_at:'2026-04-20'})` → `{hasAccess:true, accessState:'active', lifetimeGrantedAt:'2026-04-20'}`.
2. `computeEntitlementAccess({status:'refunded'})` → `{hasAccess:false, accessState:'refunded'}`.
3. `computeEntitlementAccess({status:'canceled'})` → `{hasAccess:false, accessState:'expired'}` (existing behavior).
4. `getAppPlanFromProduct('lumina-lifetime')` → `{appSlug:'lumina', planCode:'lifetime'}`.
5. `grantLuminaLifetime` twice with same args → first `{wasNew:true}`, second `{wasNew:false}`.
6. `grantLuminaLifetime` on a row with `status='refunded'` → no-op, returns `{wasNew:false}`, status stays `refunded`.
7. `upsertAppEntitlement` with status='canceled' when row is `lifetime` → UPDATE matches 0 rows, lifetime preserved.

### Stripe test-mode integration (local, no live DB)
8. Hit `/api/stripe/create-checkout-session` with `{product:'lumina-lifetime', email, lang:'ja'}` → returns Checkout URL with `mode=payment`, no trial, no subscription_data, tax_behavior=inclusive, amount=1980, currency=jpy.
9. Complete test checkout with Stripe test card → webhook fires → `nb_processed_webhooks` row inserted → lifetime branch runs → `nb_payments` row written (with `stripe_invoice_id` populated) → entitlement granted with `lifetime_granted_at` set → activation email sent.
10. **Webhook replay test**: `stripe events resend <event_id>` → second webhook rejected by `nb_processed_webhooks` duplicate guard, no side effects.
11. **Script-rerun duplicate test**: Simulate a second `grantLuminaLifetime` call with same payment intent (e.g., hand-crafted second event) → `wasNew:false`, no second email, no second Whatsapp.
12. Bridge query `POST /api/internal/lumina/entitlement` with that email → returns `{hasAccess:true, accessState:'active', status:'lifetime', lifetimeGrantedAt:'...'}`.
13. **Subscription.updated race test**: After grant, inject a synthetic `customer.subscription.updated` event for a pre-migration sub ID → handler sees `status='lifetime'`, skips entirely. Verify lifetime preserved.

### Migration tests
14. Dry-run against prod DB → lists exactly 1 candidate (annual), makes no changes.
15. Dry-run with `--confirm-count=2` → aborts because actual count is 1.
16. Live migration with `--confirm-count=1` → Stripe sub canceled, `nb_subscriptions.status='canceled'`, `nb_app_entitlements.status='lifetime'`, audit row inserted, upgrade email sent, no "membership ended" email received (suppression works).
17. Re-run migration → 0 candidates, script exits 0.
18. Manual refund + audit update: admin runs the SQL printed by the script to record charge_id + refund_jpy in audit.

### Post-deploy E2E (Chrome DevTools on namibarden.com)
19. `https://namibarden.com/lumina` (default, no cookie) → JP block visible, EN block in DOM but hidden, ¥1,980 with tax-inclusive note, money-back guarantee shown.
20. `https://namibarden.com/lumina?lang=en` → EN visible, JP hidden.
21. Click language toggle JP→EN→JP → no stuck strings; cookie updates; refresh preserves selection.
22. Click "今すぐ購入" → Stripe checkout loads with ¥1,980, product "LUMINA ライフタイムアクセス".
23. Lumina app as migrated user → shows "Lifetime access · Lifetime member since 2026-04-20", billing card hidden, no checkout button.
24. Revoke helper + cache-bust: run `revoke-lumina-lifetime.js --email X` → within 5s, Lumina app shows access denied. (Cache bust endpoint must work.)

## 10. Deploy sequence

1. **Pre-deploy:** backup DB — `docker exec namibarden-db pg_dump -U namibarden namibarden > /root/backups/namibarden-pre-lumina-lifetime-$(date +%Y%m%d-%H%M).sql`.
2. **Spec-compliance review** (Claude Opus) against this doc.
3. **Quality review** (code-reviewer subagent or `/precheck`) — secrets, debug leftovers, SQL safety, email template XSS.
4. **Run unit tests + Stripe test-mode integration** (items 1–13 in test plan).
5. **Deploy NamiBarden** with BOTH lifetime + legacy product keys in `LUMINA_PRODUCTS`: `cd /root/projects/NamiBarden && docker compose up -d --build`. Verify `docker logs namibarden --tail 30` clean.
6. **Deploy Lumina**: `cd /root/projects/Lumina && docker compose up -d --build`. Verify container up.
7. **Migration dry-run**: `docker exec namibarden node scripts/migrate-lumina-to-lifetime.js --dry-run`. Review output.
8. **Migration live**: `docker exec namibarden node scripts/migrate-lumina-to-lifetime.js --live --confirm-count=1`. Verify audit row.
9. **Manual prorated refund**: admin computes `(days_remaining / 365) × ¥29,800` from Stripe dashboard, refunds partially, records charge_id + refund_jpy back into `nb_lumina_migration_audit`.
10. **E2E tests 19–24** on live site. Capture proof (screenshots / curl output) into `/tmp/phase1-verify-YYYYMMDD.log`.
11. **Archive old Stripe recurring prices** in Stripe dashboard (manual, via UI).
12. **Follow-up PR**: remove legacy `lumina-monthly`/`lumina-annual` aliases from `LUMINA_PRODUCTS` (blocked until Lumina app no longer emits those keys).

## 11. Rollback

**Triggers:** webhook not granting lifetime; migrated user locked out; pricing page broken.

Steps:
1. `cd /root/projects/NamiBarden && git revert <phase1-commit-sha> && docker compose up -d --build`.
2. `cd /root/projects/Lumina && git revert <phase1-commit-sha> && docker compose up -d --build`.
3. **Audit-driven restore of entitlement + subscription rows** (DO NOT run full-DB `psql <` restore — clobbers unrelated writes):

```sql
-- Restore nb_app_entitlements
UPDATE nb_app_entitlements e
SET status = a.old_status,
    plan_code = a.old_plan_code,
    stripe_subscription_id = a.old_stripe_subscription_id,
    current_period_end = a.old_current_period_end,
    lifetime_granted_at = NULL,
    canceled_at = NULL
FROM nb_lumina_migration_audit a
WHERE e.customer_id = a.customer_id
  AND e.app_slug = 'lumina'
  AND e.status = 'lifetime';

-- Restore nb_subscriptions from the JSON snapshot
UPDATE nb_subscriptions s
SET status = (a.old_subscription_row->>'status'),
    canceled_at = NULL,
    updated_at = NOW()
FROM nb_lumina_migration_audit a
WHERE s.stripe_subscription_id = a.old_stripe_subscription_id
  AND s.status = 'canceled';
```

4. In Stripe: re-activate the archived recurring prices.
5. Recreating canceled Stripe subscriptions is not automatic — contact migrated customer directly, offer manual re-subscribe.

The DB backup from step 10 exists as a last resort; do NOT use it for normal rollback.

## 12. Non-goals

- Automated refund via Stripe API (manual via admin dashboard + revoke script).
- Admin UI for lifetime customer listing — covered in Phase 2.
- MRR transition reporting — Phase 4.
- Stripe Tax `automatic_tax` — not needed for single-currency fixed-price product.
- Multi-currency support.
- Webhook state machine refactor (pre-existing design issue) — tracked as follow-up, not Phase 1 blocker because the surgical `DELETE FROM nb_processed_webhooks` on failure mitigates the lifetime path specifically.

## 13. Follow-up items (out of Phase 1 scope)

Security / pre-existing (not introduced by Phase 1, but surfaced during review):
- Bridge auth (`lumina-billing.js:351`) uses static bearer; upgrade to HMAC with timestamp nonce.
- Return URL allowlist permits `http:` (`lumina-billing.js:17-21`); force HTTPS in production.
- Webhook raw-body URL match is exact-string (`request-services.js:18-24`); handle trailing slash / query.
- Webhook idempotency pre-marks events before fulfillment (global design flaw); migrate to processing/succeeded/failed state machine. Phase 1 lifetime branch mitigates locally via `DELETE FROM nb_processed_webhooks` on failure.

## 14. Risks accepted

- Deploy window (between NamiBarden deploy and Lumina deploy, before migration) — 1 active subscriber might see legacy UI calling lifetime-aliased legacy keys. Acceptable because: (a) legacy keys are aliased to lifetime price during rollout, (b) blast radius is 1 user, (c) window is minutes.
- Test-mode and live-mode Stripe pricing diverge during testing — standard Stripe test-mode convention; not a risk.
- Manual refund step depends on operator correctness. Mitigation: script prints the exact math + SQL; audit table captures what was actually done.
