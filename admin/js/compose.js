initAdminPage();
// ─── State ─────────────────────────────────────────────────────────────
let campaignId = null;
let lastSaved = { subject: '', body: '', segment: 'all' };
let renderTimer = null;

const subjectEl = document.getElementById('subject');
const bodyEl = document.getElementById('body');
const segmentEl = document.getElementById('segment');
const previewEl = document.getElementById('preview');
const dirtyBadge = document.getElementById('dirtyBadge');
const alertsEl = document.getElementById('alerts');

// ─── Plain text → HTML ─────────────────────────────────────────────────
// Keep this in sync with the help text in the UI: blank line = new
// paragraph, single newline = <br>, URLs become clickable links. We
// HTML-escape first so there's no way Nami's typing can inject markup.
function escapeHtmlText(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function linkify(escaped) {
  return escaped.replace(/(https?:\/\/[^\s<]+)/g, function(url) {
    return '<a href="' + url + '" style="color:#A8895E;text-decoration:underline;">' + url + '</a>';
  });
}
function plainToHtml(plain) {
  const normalized = String(plain || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return '';
  const paragraphs = normalized.split(/\n{2,}/);
  return paragraphs.map(function(p) {
    const withBreaks = escapeHtmlText(p).replace(/\n/g, '<br>');
    return '<p style="margin:0 0 18px;line-height:1.8;">' + linkify(withBreaks) + '</p>';
  }).join('\n');
}
function wrapEmailShell(innerHtml, subject) {
  const safeSubject = escapeHtmlText(subject || 'Nami Barden');
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + safeSubject + '</title></head>' +
    '<body style="margin:0;padding:0;background:#FAF7F2;font-family:Helvetica,Arial,sans-serif;color:#2C2419;">' +
    '<div style="max-width:600px;margin:0 auto;background:#fff;">' +
    '<div style="padding:28px 32px;text-align:center;border-bottom:1px solid #E8DFD3;">' +
    '<div style="font-family:Georgia,serif;font-size:22px;color:#2C2419;letter-spacing:0.05em;">Nami Barden</div>' +
    '</div>' +
    '<div style="padding:32px;font-size:15px;color:#2C2419;">' + innerHtml + '</div>' +
    '</div></body></html>';
}
function currentHtmlBody() {
  const rendered = plainToHtml(bodyEl.value);
  return wrapEmailShell(rendered, subjectEl.value);
}

// ─── Dirty tracking ────────────────────────────────────────────────────
function snapshot() {
  return { subject: subjectEl.value, body: bodyEl.value, segment: segmentEl.value };
}
function isDirty() {
  const cur = snapshot();
  return cur.subject !== lastSaved.subject || cur.body !== lastSaved.body || cur.segment !== lastSaved.segment;
}
function updateDirtyBadge() {
  dirtyBadge.classList.toggle('show', isDirty());
}

// ─── Preview ───────────────────────────────────────────────────────────
function schedulePreview() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderPreview, 200);
  updateDirtyBadge();
}
function renderPreview() {
  // srcdoc works with sandbox="" where doc.open()/write() from the parent
  // is blocked by the same-origin guard.
  previewEl.srcdoc = currentHtmlBody();
}
[subjectEl, bodyEl, segmentEl].forEach(function(el) {
  el.addEventListener('input', schedulePreview);
  el.addEventListener('change', schedulePreview);
});

// ─── Load existing draft ───────────────────────────────────────────────
const urlParams = new URLSearchParams(window.location.search);
const editingId = urlParams.get('id');
if (editingId) {
  (async function() {
    try {
      const data = await api('/campaigns/' + encodeURIComponent(editingId));
      const c = data.campaign;
      if (!c) return;
      if (c.status !== 'draft') {
        showAlert(alertsEl, 'This campaign is already ' + c.status + ' — opening as read-only is not supported yet.', 'error');
        return;
      }
      campaignId = c.id;
      subjectEl.value = c.subject || '';
      // text_body is what Nami typed; html_body is the rendered shell
      // we generated on save. Round-trip uses text_body.
      bodyEl.value = c.text_body || '';
      segmentEl.value = c.segment || 'all';
      lastSaved = snapshot();
      renderPreview();
      updateDirtyBadge();
    } catch (e) { console.error(e); }
  })();
} else {
  renderPreview();
}

// ─── Actions ───────────────────────────────────────────────────────────
document.getElementById('saveBtn').addEventListener('click', saveDraft);
document.getElementById('testBtn').addEventListener('click', openTest);
document.getElementById('sendBtn').addEventListener('click', sendCampaign);
document.getElementById('testCancel').addEventListener('click', function() {
  document.getElementById('testModal').classList.remove('show');
});
document.getElementById('testConfirm').addEventListener('click', doSendTest);

async function saveDraft() {
  const subject = subjectEl.value.trim();
  const body = bodyEl.value;
  const segment = segmentEl.value;
  if (!subject) { showAlert(alertsEl, 'Subject is required', 'error'); return; }
  if (!body.trim()) { showAlert(alertsEl, 'Write something in the message box first', 'error'); return; }

  const payload = {
    subject: subject,
    html_body: wrapEmailShell(plainToHtml(body), subject),
    text_body: body,
    segment: segment
  };
  try {
    let data;
    if (campaignId) {
      data = await api('/campaigns/' + encodeURIComponent(campaignId), { method: 'PUT', body: payload });
    } else {
      data = await api('/campaigns', { method: 'POST', body: payload });
      campaignId = data.id;
      history.replaceState({}, '', '/admin/compose.html?id=' + campaignId);
    }
    lastSaved = snapshot();
    updateDirtyBadge();
    showAlert(alertsEl, 'Draft saved');
  } catch (e) {
    showAlert(alertsEl, e.message, 'error');
  }
}

function openTest() {
  if (!campaignId || isDirty()) {
    showAlert(alertsEl, 'Save the draft first so the test matches what will send', 'error');
    return;
  }
  document.getElementById('testModal').classList.add('show');
}

async function doSendTest() {
  const email = document.getElementById('testEmail').value.trim();
  if (!email) return;
  try {
    await api('/campaigns/' + encodeURIComponent(campaignId) + '/test', { method: 'POST', body: { email } });
    document.getElementById('testModal').classList.remove('show');
    showAlert(alertsEl, 'Test sent to ' + email);
  } catch (e) {
    showAlert(alertsEl, e.message, 'error');
  }
}

async function sendCampaign() {
  if (!campaignId) { showAlert(alertsEl, 'Save as draft first', 'error'); return; }
  if (isDirty()) { showAlert(alertsEl, 'Unsaved changes — save the draft before sending', 'error'); return; }
  if (!confirm('Send this campaign to all matching subscribers? This cannot be undone.')) return;
  try {
    const data = await api('/campaigns/' + encodeURIComponent(campaignId) + '/send', { method: 'POST' });
    showAlert(alertsEl, 'Campaign sending to ' + data.total + ' subscribers');
    setTimeout(function() { window.location.href = '/admin/campaigns.html'; }, 1500);
  } catch (e) {
    showAlert(alertsEl, e.message, 'error');
  }
}

window.addEventListener('beforeunload', function(e) {
  if (isDirty()) {
    e.preventDefault();
    e.returnValue = '';
  }
});
