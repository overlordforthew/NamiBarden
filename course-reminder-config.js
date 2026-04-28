// Editable config for automated course lifecycle emails.
// Rules live in nb_email_rules (see migrations/005_email_rules.sql). Defaults
// are seeded at startup via ON CONFLICT DO NOTHING, so admin edits survive
// redeploys. Module keeps an in-memory cache so both the reminder scheduler
// and stripe-routes can read current subject/body/delay/prices synchronously.

const RULE_KEYS = {
  UPSELL_21D: 'course-2-upsell-21d',
  FLASH_45D: 'course-2-flash-45d',
  INACTIVITY_COURSE_1: 'inactivity-course-1',
  INACTIVITY_COURSE_2: 'inactivity-course-2'
};

// ─── Default templates ────────────────────────────────────────────────────
// Kept as JS constants so "Reset to default" is a code-sourced operation and
// the migration stays schema-only. Placeholders: {{name}}, {{link}},
// {{flash_link}}, {{upsell_price}}, {{flash_price}}, {{original_price}},
// {{flash_window_hours}}, {{course_name}}, {{last_lesson_title}}.
// All placeholder values are HTML-escaped on render.

const UPSELL_21D_BODY = `<div style="max-width:600px;margin:0 auto;font-family:'Helvetica Neue',Arial,sans-serif;color:#2C2419;background:#FAF7F2;padding:40px;">
  <h2 style="font-size:1.4rem;color:#2C2419;margin-bottom:24px;">コース1はいかがでしたか？</h2>
  <p style="line-height:1.8;margin-bottom:16px;">{{name}}様</p>
  <p style="line-height:1.8;margin-bottom:16px;">「愛を引き寄せる心の授業」をご購入いただいてから3週間が経ちました。いかがお過ごしでしょうか。</p>
  <p style="line-height:1.8;margin-bottom:16px;">自分自身を愛し、受け入れるプロセスは、人生を変える最初の一歩です。そして、その愛をパートナーシップで深めていく次のステージがあります。</p>
  <p style="line-height:1.8;margin-bottom:24px;">コース1を受講してくださったあなたに、コース2「愛を深める心の授業」を特別価格でご案内します。</p>
  <hr style="border:none;border-top:1px solid #E8DFD3;margin:40px 0 28px;">
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
      <span style="text-decoration:line-through;">¥{{original_price}}</span>
      <span style="color:#A8895E;font-weight:500;font-size:1.05rem;margin-left:8px;">¥{{upsell_price}}</span>
      <span style="margin-left:4px;font-size:0.8rem;">（コース1受講者限定価格）</span>
    </p>
    <p style="margin:0;">
      <a href="{{link}}" style="display:inline-block;padding:10px 26px;background:transparent;border:1px solid #A8895E;color:#A8895E;text-decoration:none;border-radius:2px;font-size:0.88rem;letter-spacing:0.04em;">コース2の詳細を見る →</a>
    </p>
  </div>
  <p style="line-height:1.8;font-size:0.9rem;color:#8B7E6E;margin-top:32px;">この特別価格はコース1を受講いただいた方だけのご案内です。受講の感想やご質問もお気軽にお返事ください。</p>
  <hr style="border:none;border-top:1px solid #E8DFD3;margin:32px 0;">
  <p style="font-size:0.8rem;color:#A99E8F;text-align:center;">Nami Barden — namibarden.com</p>
</div>`;

const FLASH_45D_BODY = `<div style="max-width:600px;margin:0 auto;font-family:'Helvetica Neue',Arial,sans-serif;color:#2C2419;background:#FAF7F2;padding:40px;">
  <h2 style="font-size:1.4rem;color:#2C2419;margin-bottom:24px;">最後のご案内 — {{flash_window_hours}}時間限定</h2>
  <p style="line-height:1.8;margin-bottom:16px;">{{name}}様</p>
  <p style="line-height:1.8;margin-bottom:16px;">「愛を引き寄せる心の授業」からもうすぐ6週間。あなたの心の変化を、いま私はそっと願っています。</p>
  <p style="line-height:1.8;margin-bottom:16px;">コース2「愛を深める心の授業」を特別価格でご案内してきましたが、まだ迷っている方のために、最後のお得なご案内をさせてください。</p>
  <p style="line-height:1.8;margin-bottom:24px;">このメールから<strong style="color:#A8895E;">{{flash_window_hours}}時間限定</strong>で、コース2を <strong style="color:#A8895E;">¥{{flash_price}}</strong> でご受講いただけます。</p>

  <div style="background:#FBF3E8;padding:28px 24px;border-radius:4px;border:2px solid #A8895E;margin:24px 0;">
    <p style="font-size:0.72rem;color:#A8895E;letter-spacing:0.12em;margin:0 0 8px;text-transform:uppercase;">Flash Deal — {{flash_window_hours}}h Only</p>
    <h3 style="font-size:1.1rem;color:#2C2419;margin:0 0 12px;font-weight:500;">コース2「愛を深める心の授業」</h3>
    <p style="font-size:0.9rem;color:#5C4F3D;line-height:1.8;margin:0 0 14px;">パートナーシップの深い課題へ。意識の4ステップ・5つの愛の言語・男性性と女性性・許しのプロセスまで。</p>
    <p style="font-size:0.95rem;color:#8B7E6E;margin:0 0 18px;">
      <span style="text-decoration:line-through;">¥{{original_price}}</span>
      <span style="text-decoration:line-through;margin-left:10px;">¥{{upsell_price}}</span>
      <span style="color:#A8895E;font-weight:600;font-size:1.25rem;margin-left:10px;">¥{{flash_price}}</span>
    </p>
    <p style="margin:0;">
      <a href="{{flash_link}}" style="display:inline-block;padding:12px 32px;background:#A8895E;color:#fff;text-decoration:none;border-radius:2px;font-size:0.92rem;letter-spacing:0.04em;">{{flash_window_hours}}時間限定価格で申し込む →</a>
    </p>
    <p style="font-size:0.78rem;color:#A99E8F;margin:14px 0 0;">このリンクはあなた専用・{{flash_window_hours}}時間で無効になります。</p>
  </div>

  <p style="line-height:1.8;font-size:0.9rem;color:#8B7E6E;margin-top:32px;">もしご自身のタイミングではないと感じたら、無理なさらないでくださいね。あなたの心の歩みを大切に。</p>
  <hr style="border:none;border-top:1px solid #E8DFD3;margin:32px 0;">
  <p style="font-size:0.8rem;color:#A99E8F;text-align:center;">Nami Barden — namibarden.com</p>
</div>`;

const INACTIVITY_BODY = `<div style="max-width:600px;margin:0 auto;font-family:'Helvetica Neue',Arial,sans-serif;color:#2C2419;background:#FAF7F2;padding:40px;">
  <h2 style="font-size:1.4rem;color:#2C2419;margin-bottom:24px;">お元気ですか？</h2>
  <p style="line-height:1.8;margin-bottom:16px;">{{name}}様</p>
  <p style="line-height:1.8;margin-bottom:16px;">「{{course_name}}」のレッスンから少し時間が経ちましたね。日々の中でふと立ち止まる時間が、心の変化を育てます。</p>
  <p style="line-height:1.8;margin-bottom:16px;color:#8B7E6E;font-size:0.9rem;">最後に開かれていたレッスン：<span style="color:#5C4F3D;">{{last_lesson_title}}</span></p>
  <p style="line-height:1.8;margin-bottom:24px;">続きは、あなたのタイミングで大丈夫。戻ってきてくださるのを、いつでもお待ちしていますよ。</p>
  <p style="margin:0 0 8px;">
    <a href="{{link}}" style="display:inline-block;padding:12px 32px;background:#A8895E;color:#fff;text-decoration:none;border-radius:2px;font-size:0.92rem;letter-spacing:0.04em;">続きから再生する →</a>
  </p>
  <p style="line-height:1.8;font-size:0.9rem;color:#8B7E6E;margin-top:32px;">もし何か気になることがあれば、受講ページの「ナミに質問する」から、いつでも声を届けてくださいね。</p>
  <hr style="border:none;border-top:1px solid #E8DFD3;margin:32px 0;">
  <p style="font-size:0.8rem;color:#A99E8F;text-align:center;">Nami Barden — namibarden.com</p>
</div>`;

const DEFAULT_RULES = [
  {
    rule_key: RULE_KEYS.UPSELL_21D,
    name: 'Course 2 Upsell (21 days after Course 1)',
    description: 'Offers Course 2 at the upsell price to Course 1 buyers who have not purchased Course 2. Sent once per customer.',
    enabled: true,
    delay_days: 21,
    subject: '【NamiBarden】コース1はいかがでしたか？— コース2の特別ご案内',
    body_html: UPSELL_21D_BODY,
    config: { upsell_price: 7000, original_price: 9800 }
  },
  {
    rule_key: RULE_KEYS.FLASH_45D,
    name: 'Course 2 Flash Sale (45 days after Course 1)',
    description: '48-hour flash price to Course 1 buyers who still have not purchased Course 2 after the 21-day upsell. Sent once per customer.',
    enabled: true,
    delay_days: 45,
    subject: '【NamiBarden】48時間限定 — コース2 フラッシュ価格のご案内',
    body_html: FLASH_45D_BODY,
    config: { flash_price: 6500, upsell_price: 7000, original_price: 9800, flash_window_hours: 48 }
  },
  {
    rule_key: RULE_KEYS.INACTIVITY_COURSE_1,
    name: 'Course 1 Inactivity Reminder (7 days)',
    description: 'Nudges Course 1 students who have not opened a lesson in 7 days and still have unfinished lessons. Sent once per customer.',
    enabled: true,
    delay_days: 7,
    subject: '【NamiBarden】「{{course_name}}」の続き、お待ちしていますね',
    body_html: INACTIVITY_BODY,
    config: {}
  },
  {
    rule_key: RULE_KEYS.INACTIVITY_COURSE_2,
    name: 'Course 2 Inactivity Reminder (7 days)',
    description: 'Nudges Course 2 students who have not opened a lesson in 7 days and still have unfinished lessons. Sent once per customer.',
    enabled: true,
    delay_days: 7,
    subject: '【NamiBarden】「{{course_name}}」の続き、お待ちしていますね',
    body_html: INACTIVITY_BODY,
    config: {}
  }
];

// Placeholders documented per rule for the admin UI cheatsheet.
const VARIABLE_DOCS = {
  [RULE_KEYS.UPSELL_21D]: [
    { name: 'name', desc: 'Student name (HTML-escaped)' },
    { name: 'link', desc: 'URL to Course 2 landing page (tokenized)' },
    { name: 'upsell_price', desc: 'Upsell price in yen (from config.upsell_price, comma-formatted)' },
    { name: 'original_price', desc: 'Original price in yen (from config.original_price, comma-formatted)' }
  ],
  [RULE_KEYS.FLASH_45D]: [
    { name: 'name', desc: 'Student name (HTML-escaped)' },
    { name: 'flash_link', desc: 'URL to Course 2 with flash token (48h-valid)' },
    { name: 'flash_price', desc: 'Flash price in yen (from config.flash_price, comma-formatted)' },
    { name: 'upsell_price', desc: 'Upsell price in yen (from config.upsell_price, comma-formatted)' },
    { name: 'original_price', desc: 'Original price in yen (from config.original_price, comma-formatted)' },
    { name: 'flash_window_hours', desc: 'Flash deal window in hours (from config.flash_window_hours)' }
  ],
  [RULE_KEYS.INACTIVITY_COURSE_1]: [
    { name: 'name', desc: 'Student name (HTML-escaped)' },
    { name: 'link', desc: 'Resume URL (course + access token)' },
    { name: 'course_name', desc: 'Course display name' },
    { name: 'last_lesson_title', desc: 'Title of the last lesson opened by the student' }
  ],
  [RULE_KEYS.INACTIVITY_COURSE_2]: [
    { name: 'name', desc: 'Student name (HTML-escaped)' },
    { name: 'link', desc: 'Resume URL (course + access token)' },
    { name: 'course_name', desc: 'Course display name' },
    { name: 'last_lesson_title', desc: 'Title of the last lesson opened by the student' }
  ]
};

// ─── Cache ────────────────────────────────────────────────────────────────
const cache = new Map(); // rule_key → row

function invalidateCache(ruleKey) {
  if (ruleKey) cache.delete(ruleKey);
  else cache.clear();
}

function fromRow(row) {
  if (!row) return null;
  return {
    ruleKey: row.rule_key,
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    delayDays: row.delay_days,
    subject: row.subject,
    bodyHtml: row.body_html,
    config: row.config || {},
    updatedAt: row.updated_at,
    updatedBy: row.updated_by
  };
}

// ─── Public API ───────────────────────────────────────────────────────────
async function ensureSeeded(pool) {
  for (const rule of DEFAULT_RULES) {
    await pool.query(
      `INSERT INTO nb_email_rules
         (rule_key, name, description, enabled, delay_days, subject, body_html, config, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'system:seed')
       ON CONFLICT (rule_key) DO NOTHING`,
      [
        rule.rule_key,
        rule.name,
        rule.description,
        rule.enabled,
        rule.delay_days,
        rule.subject,
        rule.body_html,
        JSON.stringify(rule.config || {})
      ]
    );
  }
  await warmCache(pool);
}

async function warmCache(pool) {
  const { rows } = await pool.query(
    `SELECT rule_key, name, description, enabled, delay_days, subject, body_html, config, updated_at, updated_by
       FROM nb_email_rules`
  );
  cache.clear();
  for (const row of rows) cache.set(row.rule_key, row);
}

async function loadRule(pool, ruleKey) {
  if (cache.has(ruleKey)) return fromRow(cache.get(ruleKey));
  const { rows } = await pool.query(
    `SELECT rule_key, name, description, enabled, delay_days, subject, body_html, config, updated_at, updated_by
       FROM nb_email_rules WHERE rule_key = $1`,
    [ruleKey]
  );
  if (rows.length === 0) return null;
  cache.set(ruleKey, rows[0]);
  return fromRow(rows[0]);
}

async function loadAllRules(pool) {
  const { rows } = await pool.query(
    `SELECT rule_key, name, description, enabled, delay_days, subject, body_html, config, updated_at, updated_by
       FROM nb_email_rules
       ORDER BY rule_key`
  );
  cache.clear();
  for (const row of rows) cache.set(row.rule_key, row);
  return rows.map(fromRow);
}

async function updateRule(pool, ruleKey, fields, updatedBy) {
  const sets = [];
  const params = [];
  let idx = 1;
  if (fields.name !== undefined)        { sets.push(`name = $${idx++}`);        params.push(fields.name); }
  if (fields.description !== undefined) { sets.push(`description = $${idx++}`); params.push(fields.description); }
  if (fields.enabled !== undefined)     { sets.push(`enabled = $${idx++}`);     params.push(!!fields.enabled); }
  if (fields.delayDays !== undefined)   { sets.push(`delay_days = $${idx++}`);  params.push(fields.delayDays); }
  if (fields.subject !== undefined)     { sets.push(`subject = $${idx++}`);     params.push(fields.subject); }
  if (fields.bodyHtml !== undefined)    { sets.push(`body_html = $${idx++}`);   params.push(fields.bodyHtml); }
  if (fields.config !== undefined)      { sets.push(`config = $${idx++}::jsonb`); params.push(JSON.stringify(fields.config)); }
  if (sets.length === 0) return loadRule(pool, ruleKey);
  sets.push(`updated_by = $${idx++}`); params.push(updatedBy || null);
  params.push(ruleKey);
  const { rows } = await pool.query(
    `UPDATE nb_email_rules SET ${sets.join(', ')} WHERE rule_key = $${idx} RETURNING *`,
    params
  );
  if (rows.length === 0) return null;
  cache.set(ruleKey, rows[0]);
  return fromRow(rows[0]);
}

async function resetRule(pool, ruleKey, updatedBy) {
  const def = DEFAULT_RULES.find((r) => r.rule_key === ruleKey);
  if (!def) return null;
  const { rows } = await pool.query(
    `UPDATE nb_email_rules
        SET name = $1, description = $2, enabled = $3, delay_days = $4,
            subject = $5, body_html = $6, config = $7::jsonb, updated_by = $8
      WHERE rule_key = $9
      RETURNING *`,
    [
      def.name,
      def.description,
      def.enabled,
      def.delay_days,
      def.subject,
      def.body_html,
      JSON.stringify(def.config || {}),
      updatedBy || 'system:reset',
      ruleKey
    ]
  );
  if (rows.length === 0) return null;
  cache.set(ruleKey, rows[0]);
  return fromRow(rows[0]);
}

// ─── Pricing helper (sync, for stripe-routes) ─────────────────────────────
// Reads from cache so callers don't need to await. Cache is warmed at startup
// and refreshed on every admin update. Falls back to DEFAULT_RULES constants
// if cache is cold or a cached value is non-finite/negative (defense-in-depth
// against bad admin input — the PUT endpoint validates, but stripe checkout
// amounts must never be NaN or negative).
function pickPositiveInt(value, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : Number(fallback);
}

function getActivePricing() {
  const upsell = cache.get(RULE_KEYS.UPSELL_21D);
  const flash = cache.get(RULE_KEYS.FLASH_45D);
  const upsellCfg = (upsell && upsell.config) || {};
  const flashCfg = (flash && flash.config) || {};
  const upsellDefault = DEFAULT_RULES.find((r) => r.rule_key === RULE_KEYS.UPSELL_21D).config;
  const flashDefault = DEFAULT_RULES.find((r) => r.rule_key === RULE_KEYS.FLASH_45D).config;
  return {
    upsellPrice: pickPositiveInt(upsellCfg.upsell_price, upsellDefault.upsell_price),
    flashPrice: pickPositiveInt(flashCfg.flash_price, flashDefault.flash_price),
    originalPrice: pickPositiveInt(upsellCfg.original_price, upsellDefault.original_price),
    flashWindowHours: pickPositiveInt(flashCfg.flash_window_hours, flashDefault.flash_window_hours)
  };
}

// ─── Template rendering ───────────────────────────────────────────────────
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtmlValue(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

// Replace {{key}} with HTML-escaped value from vars. Unknown keys render empty
// so a typo in the template never leaks a raw placeholder into a sent email —
// but renderTemplateDetailed() also returns the unknown-var list so the admin
// preview UI can surface a warning.
function renderTemplateDetailed(template, vars) {
  if (!template) return { html: '', unknownVars: [] };
  const safe = vars || {};
  const unknown = new Set();
  const html = String(template).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    if (!(key in safe)) unknown.add(key);
    return escapeHtmlValue(safe[key]);
  });
  return { html, unknownVars: Array.from(unknown) };
}

function renderTemplate(template, vars) {
  return renderTemplateDetailed(template, vars).html;
}

function formatYen(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return n.toLocaleString('en-US');
}

module.exports = {
  RULE_KEYS,
  DEFAULT_RULES,
  VARIABLE_DOCS,
  ensureSeeded,
  warmCache,
  loadRule,
  loadAllRules,
  updateRule,
  resetRule,
  invalidateCache,
  getActivePricing,
  renderTemplate,
  renderTemplateDetailed,
  formatYen,
  escapeHtmlValue
};
