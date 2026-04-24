initAdminPage();
const RULE_KEYS = {
  UPSELL_21D: 'course-2-upsell-21d',
  FLASH_45D: 'course-2-flash-45d',
  INACTIVITY_COURSE_1: 'inactivity-course-1',
  INACTIVITY_COURSE_2: 'inactivity-course-2'
};

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2200);
}

function triggerSummary(ruleKey, delayDays) {
  if (ruleKey === RULE_KEYS.UPSELL_21D) return `Sends ${delayDays} days after Course 1 purchase if the customer has not bought Course 2.`;
  if (ruleKey === RULE_KEYS.FLASH_45D) return `Sends ${delayDays} days after Course 1 purchase as a final flash-price offer (once per customer).`;
  if (ruleKey === RULE_KEYS.INACTIVITY_COURSE_1) return `Sends when a Course 1 student has ${delayDays}+ days of inactivity and still has unfinished lessons.`;
  if (ruleKey === RULE_KEYS.INACTIVITY_COURSE_2) return `Sends when a Course 2 student has ${delayDays}+ days of inactivity and still has unfinished lessons.`;
  return '';
}

function formatYen(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return '¥' + Number(n).toLocaleString('en-US');
}

function renderRuleCard(rule) {
  const cfg = rule.config || {};
  const chips = [];
  if (cfg.upsell_price != null) chips.push(`<span class="chip">Upsell ${formatYen(cfg.upsell_price)}</span>`);
  if (cfg.flash_price != null) chips.push(`<span class="chip">Flash ${formatYen(cfg.flash_price)}</span>`);
  if (cfg.original_price != null) chips.push(`<span class="chip">Original ${formatYen(cfg.original_price)}</span>`);
  if (cfg.flash_window_hours != null) chips.push(`<span class="chip">${cfg.flash_window_hours}h window</span>`);

  return `
    <div class="rule-card ${rule.enabled ? '' : 'disabled'}">
      <div class="head">
        <div>
          <h3>${escapeHtml(rule.name)}</h3>
          <div class="desc" style="margin-top:6px;">${escapeHtml(rule.description || '')}</div>
        </div>
        <label class="toggle" title="${rule.enabled ? 'Enabled' : 'Disabled'}">
          <input type="checkbox" ${rule.enabled ? 'checked' : ''} data-rule="${rule.ruleKey}" class="rule-toggle">
          <span class="slider"></span>
        </label>
      </div>

      <div class="rule-trigger">${escapeHtml(triggerSummary(rule.ruleKey, rule.delayDays))}</div>

      <div class="rule-stats">
        <div class="rule-stat"><div class="label">Delay</div><div class="value">${rule.delayDays}d</div></div>
        <div class="rule-stat"><div class="label">Eligible now</div><div class="value">${rule.eligibleNow ?? 0}</div></div>
        <div class="rule-stat"><div class="label">Total sent</div><div class="value">${rule.totalSent ?? 0}</div></div>
      </div>

      <div class="rule-subject">
        <div class="label">Subject</div>
        <div>${escapeHtml(rule.subject)}</div>
      </div>

      ${chips.length ? `<div class="rule-config">${chips.join('')}</div>` : ''}

      <div class="btn-group" style="margin-top:8px;">
        <button class="btn btn-sm" data-action="preview" data-rule="${rule.ruleKey}">Preview</button>
        <button class="btn btn-sm btn-primary" data-action="edit" data-rule="${rule.ruleKey}">Edit</button>
        <button class="btn btn-sm" data-action="test" data-rule="${rule.ruleKey}">Send test</button>
      </div>
    </div>`;
}

let rulesCache = [];
async function refreshRules() {
  try {
    const data = await api('/email-rules');
    rulesCache = data.rules || [];
    document.getElementById('rulesContainer').innerHTML = rulesCache.map(renderRuleCard).join('');
    document.getElementById('statRuleCount').textContent = rulesCache.length;
    document.getElementById('statEnabledCount').textContent = rulesCache.filter(r => r.enabled).length;
    document.getElementById('statEligibleCount').textContent = rulesCache.reduce((s, r) => s + (r.eligibleNow || 0), 0);
  } catch (err) {
    toast('Failed to load rules: ' + err.message);
  }
}

document.getElementById('rulesContainer').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (btn) {
    const key = btn.dataset.rule;
    if (btn.dataset.action === 'preview') return openPreview(key);
    if (btn.dataset.action === 'edit') return openEdit(key);
    if (btn.dataset.action === 'test') return openTest(key);
  }
});

document.getElementById('rulesContainer').addEventListener('change', async (e) => {
  const toggle = e.target.closest('input.rule-toggle');
  if (!toggle) return;
  const key = toggle.dataset.rule;
  const enabled = toggle.checked;
  try {
    await api(`/email-rules/${encodeURIComponent(key)}`, { method: 'PUT', body: { enabled } });
    toast(enabled ? 'Rule enabled' : 'Rule disabled');
    refreshRules();
  } catch (err) {
    toast('Toggle failed: ' + err.message);
    toggle.checked = !enabled;
  }
});

// Route through the server preview endpoints so the response gets the
// strict CSP header set in course-reminders.js. Cookie auth carries across
// the new-tab navigation.
function openPreview(key) {
  let path;
  if (key === RULE_KEYS.UPSELL_21D) path = '/api/admin/reminders/preview/course-2-upsell';
  else if (key === RULE_KEYS.FLASH_45D) path = '/api/admin/reminders/preview/course-2-flash';
  else if (key === RULE_KEYS.INACTIVITY_COURSE_1) path = '/api/admin/reminders/preview/inactivity?course=course-1';
  else if (key === RULE_KEYS.INACTIVITY_COURSE_2) path = '/api/admin/reminders/preview/inactivity?course=course-2';
  else return;
  const opened = window.open(path, '_blank', 'noopener');
  if (!opened) toast('Pop-up blocked');
}

// ─── Edit drawer ─────────────────────────────────────────────────────
let currentKey = null;
let currentRule = null;
let previewTimer = null;

const editOverlay = document.getElementById('editOverlay');
const fieldEnabled = document.getElementById('fieldEnabled');
const fieldDelayDays = document.getElementById('fieldDelayDays');
const fieldSubject = document.getElementById('fieldSubject');
const fieldBody = document.getElementById('fieldBody');
const cfgUpsellPrice = document.getElementById('cfgUpsellPrice');
const cfgOriginalPrice = document.getElementById('cfgOriginalPrice');
const cfgFlashPrice = document.getElementById('cfgFlashPrice');
const cfgFlashWindow = document.getElementById('cfgFlashWindow');
const cfgFlashUpsellPrice = document.getElementById('cfgFlashUpsellPrice');
const cfgFlashOriginalPrice = document.getElementById('cfgFlashOriginalPrice');
const configUpsell = document.getElementById('configUpsell');
const configFlash = document.getElementById('configFlash');
const previewFrame = document.getElementById('previewFrame');
const previewSubject = document.getElementById('previewSubject');
const variableList = document.getElementById('variableList');
const unknownVarsBox = document.getElementById('unknownVarsBox');
const editError = document.getElementById('editError');

async function openEdit(key) {
  try {
    const { rule } = await api(`/email-rules/${encodeURIComponent(key)}`);
    currentKey = key;
    currentRule = rule;
    document.getElementById('editTitle').textContent = 'Edit: ' + rule.name;
    document.getElementById('editRuleKey').textContent = `rule_key: ${rule.ruleKey} · updated ${formatDateTime(rule.updatedAt)} by ${rule.updatedBy || '—'}`;
    fieldEnabled.checked = rule.enabled;
    fieldDelayDays.value = rule.delayDays;
    fieldSubject.value = rule.subject;
    fieldBody.value = rule.bodyHtml;

    configUpsell.classList.toggle('hidden', key !== RULE_KEYS.UPSELL_21D);
    configFlash.classList.toggle('hidden', key !== RULE_KEYS.FLASH_45D);

    if (key === RULE_KEYS.UPSELL_21D) {
      cfgUpsellPrice.value = rule.config.upsell_price ?? '';
      cfgOriginalPrice.value = rule.config.original_price ?? '';
    } else if (key === RULE_KEYS.FLASH_45D) {
      cfgFlashPrice.value = rule.config.flash_price ?? '';
      cfgFlashWindow.value = rule.config.flash_window_hours ?? '';
      cfgFlashUpsellPrice.value = rule.config.upsell_price ?? '';
      cfgFlashOriginalPrice.value = rule.config.original_price ?? '';
    }

    variableList.innerHTML = (rule.variables || []).map(v =>
      `<li><code>{{${escapeHtml(v.name)}}}</code><span>${escapeHtml(v.desc)}</span></li>`
    ).join('') || '<li><em>No placeholders defined for this rule</em></li>';

    editError.classList.add('hidden');
    editOverlay.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    schedulePreview();
  } catch (err) {
    toast('Load failed: ' + err.message);
  }
}

function draftFieldsFromForm() {
  const out = {
    enabled: fieldEnabled.checked,
    delayDays: Number(fieldDelayDays.value),
    subject: fieldSubject.value,
    bodyHtml: fieldBody.value
  };
  if (currentKey === RULE_KEYS.UPSELL_21D) {
    out.config = {
      upsell_price: Number(cfgUpsellPrice.value),
      original_price: Number(cfgOriginalPrice.value)
    };
  } else if (currentKey === RULE_KEYS.FLASH_45D) {
    out.config = {
      flash_price: Number(cfgFlashPrice.value),
      flash_window_hours: Number(cfgFlashWindow.value),
      upsell_price: Number(cfgFlashUpsellPrice.value),
      original_price: Number(cfgFlashOriginalPrice.value)
    };
  }
  return out;
}

function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderLivePreview, 500);
}

async function renderLivePreview() {
  if (!currentKey) return;
  const draft = draftFieldsFromForm();
  try {
    const data = await api(`/email-rules/${encodeURIComponent(currentKey)}/preview`, {
      method: 'POST',
      body: draft
    });
    previewSubject.textContent = data.subject || '';
    previewFrame.srcdoc = `<base target="_blank">` + (data.html || '');
    if (Array.isArray(data.unknownVars) && data.unknownVars.length) {
      unknownVarsBox.textContent = 'Unknown placeholders in your template: ' + data.unknownVars.map(v => '{{' + v + '}}').join(', ');
      unknownVarsBox.classList.remove('hidden');
    } else {
      unknownVarsBox.classList.add('hidden');
    }
    editError.classList.add('hidden');
  } catch (err) {
    editError.textContent = 'Preview: ' + err.message;
    editError.classList.remove('hidden');
  }
}

[fieldEnabled, fieldDelayDays, fieldSubject, fieldBody,
 cfgUpsellPrice, cfgOriginalPrice,
 cfgFlashPrice, cfgFlashWindow, cfgFlashUpsellPrice, cfgFlashOriginalPrice]
  .forEach(el => el.addEventListener('input', schedulePreview));

function closeEdit() {
  clearTimeout(previewTimer);
  previewTimer = null;
  editOverlay.classList.add('hidden');
  document.body.style.overflow = '';
  currentKey = null;
  currentRule = null;
}

document.getElementById('editCloseBtn').addEventListener('click', closeEdit);
document.getElementById('editCancelBtn').addEventListener('click', closeEdit);
editOverlay.addEventListener('click', (e) => { if (e.target === editOverlay) closeEdit(); });

document.getElementById('saveBtn').addEventListener('click', async () => {
  if (!currentKey) return;
  const draft = draftFieldsFromForm();
  try {
    await api(`/email-rules/${encodeURIComponent(currentKey)}`, { method: 'PUT', body: draft });
    toast('Saved');
    closeEdit();
    refreshRules();
  } catch (err) {
    editError.textContent = err.message;
    editError.classList.remove('hidden');
  }
});

document.getElementById('resetBtn').addEventListener('click', async () => {
  if (!currentKey) return;
  if (!confirm('Reset this rule to built-in defaults? Your custom subject, body, timing, and prices will be overwritten.')) return;
  try {
    await api(`/email-rules/${encodeURIComponent(currentKey)}/reset`, { method: 'POST' });
    toast('Reset to defaults');
    const key = currentKey;
    closeEdit();
    await refreshRules();
    openEdit(key);
  } catch (err) {
    toast('Reset failed: ' + err.message);
  }
});

// ─── Test-send drawer ────────────────────────────────────────────────
const testOverlay = document.getElementById('testOverlay');
const testEmail = document.getElementById('testEmail');
const testName = document.getElementById('testName');
const testError = document.getElementById('testError');
const testRuleKeyLabel = document.getElementById('testRuleKey');
let testCurrentKey = null;

function openTest(key) {
  testCurrentKey = key;
  const rule = rulesCache.find(r => r.ruleKey === key);
  testRuleKeyLabel.textContent = rule ? `Rule: ${rule.name}` : `Rule: ${key}`;
  testError.classList.add('hidden');
  testOverlay.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  setTimeout(() => testEmail.focus(), 50);
}

function closeTest() {
  testOverlay.classList.add('hidden');
  document.body.style.overflow = '';
  testCurrentKey = null;
}

document.getElementById('testCloseBtn').addEventListener('click', closeTest);
document.getElementById('testCancelBtn').addEventListener('click', closeTest);
testOverlay.addEventListener('click', (e) => { if (e.target === testOverlay) closeTest(); });

document.getElementById('testSendBtn').addEventListener('click', async () => {
  if (!testCurrentKey) return;
  const email = testEmail.value.trim();
  if (!email) { testError.textContent = 'Email required'; testError.classList.remove('hidden'); return; }
  let type = 'upsell';
  let extra = {};
  if (testCurrentKey === RULE_KEYS.FLASH_45D) type = 'flash';
  else if (testCurrentKey === RULE_KEYS.INACTIVITY_COURSE_1) { type = 'inactivity'; extra.course = 'course-1'; }
  else if (testCurrentKey === RULE_KEYS.INACTIVITY_COURSE_2) { type = 'inactivity'; extra.course = 'course-2'; }
  try {
    await api('/reminders/test-send', {
      method: 'POST',
      body: { email, name: testName.value || 'ナミ', type, ...extra }
    });
    toast('Test sent to ' + email);
    closeTest();
  } catch (err) {
    testError.textContent = err.message;
    testError.classList.remove('hidden');
  }
});

// ─── Run-now ─────────────────────────────────────────────────────────
document.getElementById('runNowBtn').addEventListener('click', async () => {
  if (!confirm('Run the scheduler now? This will immediately send any emails to currently-eligible students.')) return;
  const btn = document.getElementById('runNowBtn');
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Running…';
  try {
    const result = await api('/reminders/run-now', { method: 'POST' });
    const totalSent = (result.upsell21d?.sent || 0)
      + (result.flash45d?.sent || 0)
      + (result.inactivity?.['course-1']?.sent || 0)
      + (result.inactivity?.['course-2']?.sent || 0);
    toast(`Scheduler ran — ${totalSent} email(s) sent`);
    refreshRules();
  } catch (err) {
    toast('Run failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
});

refreshRules();
