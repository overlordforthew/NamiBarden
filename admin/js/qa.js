const COURSE_LABEL = {
  'course-1': 'Course 1',
  'course-2': 'Course 2',
  'course-bundle': 'Bundle'
};

const urlParams = new URLSearchParams(location.search);
const isThreadScoped = urlParams.get('scope') === 'thread-admin';
let currentStatus = '';
let currentChannel = '';
let currentThreadId = null;
let pendingUploads = [];
let adminStream = null;
let lastSeenMessageId = Number(localStorage.getItem('nb-admin-qa-last-id') || '0');

if (!isThreadScoped) {
  initAdminPage();
} else {
  document.getElementById('threadScopeBanner').classList.add('active');
  document.getElementById('backToInboxBtn').style.display = 'none';
  document.querySelectorAll('.sidebar a').forEach((link) => {
    const href = link.getAttribute('href');
    if (href !== '/admin/qa.html' && !link.closest('.sidebar-logout')) link.style.display = 'none';
  });
  // Thread-scoped sessions still show the Logout link in the sidebar, so
  // wire it up even though we skip the full initAdminPage() bootstrap.
  initLogoutLink();
}

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

async function adminApi(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body && !(opts.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(`${API}${path}`, { ...opts, headers, credentials: 'same-origin' });
  if (res.status === 401 || res.status === 403) throw new Error('Unauthorized');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

async function loadInbox() {
  if (isThreadScoped) return;
  const search = document.getElementById('searchInput').value;
  const params = new URLSearchParams();
  if (currentStatus) params.set('status', currentStatus);
  if (currentChannel) params.set('channel', currentChannel);
  if (search) params.set('search', search);
  if (lastSeenMessageId) params.set('since', lastSeenMessageId);

  try {
    const data = await adminApi(`/qa?${params}`);
    renderSummary(data.summary);
    renderChannelFilters(data.summary);
    renderThreads(data.threads);
    for (const msg of data.replayMessages || []) rememberMessageId(msg.id);
  } catch (e) { console.error(e); }
}

function rememberMessageId(id) {
  if (!id) return;
  lastSeenMessageId = Math.max(lastSeenMessageId, Number(id));
  localStorage.setItem('nb-admin-qa-last-id', String(lastSeenMessageId));
}

function renderSummary(summary) {
  const strip = document.getElementById('summaryStrip');
  strip.textContent = '';
  const items = [
    { key: '',         label: 'All' },
    { key: 'open',     label: 'Open', count: summary.open },
    { key: 'answered', label: 'Answered', count: summary.answered },
    { key: 'archived', label: 'Archived', count: summary.archived }
  ];
  for (const item of items) {
    const btn = node('button', `summary-chip${currentStatus === item.key ? ' active' : ''}`, item.label);
    btn.type = 'button';
    btn.addEventListener('click', () => setStatusFilter(item.key));
    if (typeof item.count === 'number') btn.appendChild(node('span', 'count', item.count));
    if (item.key === 'open' && summary.unread > 0) btn.appendChild(node('span', 'unread-badge', summary.unread));
    strip.appendChild(btn);
  }
}

function renderChannelFilters(summary) {
  const wrap = document.getElementById('channelFilters');
  wrap.textContent = '';
  [
    { key: '', label: 'All' },
    { key: 'dm', label: `DM ${summary.dm || 0}` },
    { key: 'course', label: `Course ${summary.course || 0}` }
  ].forEach((item) => {
    const btn = node('button', `summary-chip${currentChannel === item.key ? ' active' : ''}`, item.label);
    btn.type = 'button';
    btn.addEventListener('click', () => {
      currentChannel = item.key;
      loadInbox();
    });
    wrap.appendChild(btn);
  });
}

function setStatusFilter(status) {
  currentStatus = status;
  loadInbox();
}

function renderThreads(threads) {
  const tb = document.getElementById('threadsTable');
  tb.textContent = '';
  if (!threads || !threads.length) {
    const tr = document.createElement('tr');
    const td = node('td', 'empty', 'No questions yet');
    td.colSpan = 7;
    tr.appendChild(td);
    tb.appendChild(tr);
    return;
  }
  threads.forEach((t) => {
    const courseLabel = t.courseId ? (COURSE_LABEL[t.courseId] || t.courseId) : '';
    const contextBits = t.channel === 'dm' ? 'DM' : [courseLabel, t.lessonId].filter(Boolean).join(' - ');
    const tr = node('tr', `thread-row${t.unread ? ' unread' : ''}`);
    tr.addEventListener('click', () => showThread(t.id));
    const fromTd = document.createElement('td');
    if (t.unread) fromTd.appendChild(node('span', 'unread-badge', ''));
    fromTd.appendChild(document.createTextNode(t.name || t.email || 'Unknown'));
    if (t.name && t.email) fromTd.appendChild(node('div', '', t.email));
    tr.appendChild(fromTd);
    tr.appendChild(node('td', '', t.subject || '(no subject)'));
    const contextTd = node('td', '', contextBits || '-');
    contextTd.style.fontSize = '0.82rem';
    contextTd.style.color = 'var(--text-light)';
    tr.appendChild(contextTd);
    const statusTd = document.createElement('td');
    statusTd.appendChild(node('span', `status-pill status-${t.status}`, t.status));
    tr.appendChild(statusTd);
    tr.appendChild(node('td', '', t.messageCount));
    tr.appendChild(node('td', '', formatDateTime(t.lastMessageAt)));
    const actionTd = document.createElement('td');
    const openBtn = node('button', 'btn btn-sm', 'Open');
    openBtn.type = 'button';
    openBtn.addEventListener('click', (event) => { event.stopPropagation(); showThread(t.id); });
    actionTd.appendChild(openBtn);
    tr.appendChild(actionTd);
    tb.appendChild(tr);
  });
}

async function showThread(id) {
  currentThreadId = id;
  try {
    const data = await adminApi(`/qa/${id}`);
    const t = data.thread;
    document.getElementById('detailSubject').textContent = t.subject || '(no subject)';

    const meta = document.getElementById('threadMeta');
    meta.textContent = '';
    meta.appendChild(node('span', '', `From: ${t.name || t.email || 'Unknown'} <${t.email || ''}>`));
    meta.appendChild(node('span', '', `Channel: ${t.channel === 'dm' ? 'DM' : 'Course'}`));
    if (t.courseName) meta.appendChild(node('span', '', `Course: ${t.courseName}`));
    if (t.lessonTitle) meta.appendChild(node('span', '', `Lesson: ${t.lessonTitle}`));
    const status = node('span', '', 'Status: ');
    status.appendChild(node('span', `status-pill status-${t.status}`, t.status));
    meta.appendChild(status);
    meta.appendChild(node('span', '', `Opened: ${formatDateTime(t.createdAt)}`));

    const msgList = document.getElementById('messagesList');
    msgList.textContent = '';
    (data.messages || []).forEach((m) => {
      const isNami = m.sender === 'nami';
      const card = node('div', `msg ${isNami ? 'nami' : 'student'}`);
      const msgMeta = node('div', 'msg-meta');
      msgMeta.appendChild(node('span', '', isNami ? 'ナミ' : (t.name || t.email || 'Student')));
      msgMeta.appendChild(node('span', '', formatDateTime(m.created_at)));
      card.appendChild(msgMeta);
      card.appendChild(node('div', '', m.body || ''));
      renderMessageAttachments(card, m.attachments || []);
      msgList.appendChild(card);
      rememberMessageId(m.id);
    });

    const watchLink = document.getElementById('viewAsStudent');
    if (t.openAsStudentUrl) {
      watchLink.href = t.openAsStudentUrl;
      watchLink.style.display = '';
    } else {
      watchLink.style.display = 'none';
    }

    document.getElementById('replyBody').value = '';
    pendingUploads = [];
    renderPendingUploads();

    document.getElementById('listView').style.display = 'none';
    document.getElementById('detailView').classList.add('active');
  } catch (e) { alert(e.message); }
}

function renderMessageAttachments(container, attachments) {
  if (!attachments.length) return;
  const wrap = node('div', 'message-attachments');
  attachments.forEach((attachment) => {
    if ((attachment.detectedMime || '').startsWith('image/')) {
      const link = document.createElement('a');
      link.href = attachment.viewUrl;
      link.target = '_blank';
      link.rel = 'noopener';
      const img = document.createElement('img');
      img.className = 'attachment-img';
      img.src = attachment.viewUrl;
      img.alt = attachment.originalFilename || 'attachment';
      link.appendChild(img);
      wrap.appendChild(link);
    } else if ((attachment.detectedMime || '').startsWith('audio/')) {
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.src = attachment.viewUrl;
      wrap.appendChild(audio);
    } else {
      const link = node('a', 'attachment-chip', attachment.originalFilename || 'Attachment');
      link.href = attachment.viewUrl;
      link.target = '_blank';
      link.rel = 'noopener';
      wrap.appendChild(link);
    }
  });
  container.appendChild(wrap);
}

function showList() {
  if (isThreadScoped) return;
  document.getElementById('detailView').classList.remove('active');
  document.getElementById('listView').style.display = '';
  currentThreadId = null;
  loadInbox();
}

async function submitReply(e) {
  e.preventDefault();
  if (!currentThreadId) return;
  const body = document.getElementById('replyBody').value.trim();
  if (!body && pendingUploads.length === 0) return;
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = '送信中...';
  try {
    await adminApi(`/qa/${currentThreadId}/reply`, {
      method: 'POST',
      body: { body, attachments: pendingUploads.map((item) => item.uploadId) }
    });
    pendingUploads = [];
    renderPendingUploads();
    await showThread(currentThreadId);
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '送信する';
  }
}

async function setStatus(status) {
  if (!currentThreadId) return;
  try {
    await adminApi(`/qa/${currentThreadId}/status`, { method: 'POST', body: { status } });
    await showThread(currentThreadId);
  } catch (err) { alert(err.message); }
}

function renderPendingUploads() {
  const list = document.getElementById('uploadList');
  list.textContent = '';
  pendingUploads.forEach((item, idx) => {
    const chip = node('span', 'upload-chip', item.name || item.previewMime);
    const remove = node('button', 'btn btn-sm', 'x');
    remove.type = 'button';
    remove.addEventListener('click', () => {
      pendingUploads.splice(idx, 1);
      renderPendingUploads();
    });
    chip.appendChild(remove);
    list.appendChild(chip);
  });
}

async function uploadAttachment(file) {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/api/chat/attachments', {
    method: 'POST',
    body: form,
    credentials: 'same-origin'
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  pendingUploads.push({ ...data, name: file.name });
  renderPendingUploads();
}

async function uploadFiles(files) {
  const selected = Array.from(files || []);
  if (pendingUploads.length + selected.length > 5) {
    alert('Maximum 5 files per message.');
    return;
  }
  for (const file of selected) await uploadAttachment(file);
}

function startAdminStream() {
  if (isThreadScoped || adminStream) return;
  const url = lastSeenMessageId ? `/api/admin/qa/stream?since=${encodeURIComponent(lastSeenMessageId)}` : '/api/admin/qa/stream';
  adminStream = new EventSource(url);
  adminStream.addEventListener('open', () => loadInbox());
  adminStream.addEventListener('message', (event) => {
    const payload = JSON.parse(event.data);
    rememberMessageId(payload.id || payload.messageId);
    loadInbox();
    if (currentThreadId && Number(payload.threadId) === Number(currentThreadId)) showThread(currentThreadId);
  });
  ['thread-created', 'thread-updated', 'status-changed', 'attachment-committed', 'resync-required'].forEach((eventName) => {
    adminStream.addEventListener(eventName, () => loadInbox());
  });
}

let searchTimer;
document.getElementById('searchInput').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadInbox, 300);
});

// Deep-link support: /admin/qa.html?thread=123 and /admin/qa.html#thread-123
const hashThread = (location.hash || '').match(/^#thread-(\d+)$/);
const threadParam = parseInt(urlParams.get('thread') || (hashThread && hashThread[1]), 10);
document.getElementById('attachmentInput').addEventListener('change', (event) => {
  uploadFiles(event.target.files).catch((err) => alert(err.message));
  event.target.value = '';
});
const uploadZone = document.getElementById('uploadZone');
uploadZone.addEventListener('dragover', (event) => {
  event.preventDefault();
  uploadZone.classList.add('dragover');
});
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
uploadZone.addEventListener('drop', (event) => {
  event.preventDefault();
  uploadZone.classList.remove('dragover');
  uploadFiles(event.dataTransfer.files).catch((err) => alert(err.message));
});
if (threadParam) {
  showThread(threadParam);
} else {
  loadInbox();
}
startAdminStream();

document.getElementById('backToInboxBtn').addEventListener('click', showList);
document.getElementById('attachPickBtn').addEventListener('click', function() {
  document.getElementById('attachmentInput').click();
});
document.querySelectorAll('button[data-status]').forEach(function(btn) {
  btn.addEventListener('click', function() { setStatus(btn.dataset.status); });
});

document.getElementById('replyForm').addEventListener('submit', submitReply);
