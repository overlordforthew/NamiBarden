initAdminPage();
let currentPage = 1;
const limit = 50;
let editingSubId = null;

async function loadSubscribers(page) {
  currentPage = page || 1;
  const search = document.getElementById('searchInput').value;
  const status = document.getElementById('statusFilter').value;
  const source = document.getElementById('sourceFilter').value;
  const params = new URLSearchParams({ page: currentPage, limit });
  if (search) params.set('search', search);
  if (status) params.set('status', status);
  if (source) params.set('source', source);

  try {
    const data = await api(`/subscribers?${params}`);
    const tb = document.getElementById('subscribersTable');
    tb.textContent = '';
    if (data.subscribers.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 7;
      td.className = 'empty';
      td.textContent = 'No subscribers found';
      tr.appendChild(td);
      tb.appendChild(tr);
    } else {
      for (const s of data.subscribers) tb.appendChild(renderSubscriberRow(s));
    }
    renderPagination(document.getElementById('pagination'), data.page, data.total, limit, loadSubscribers);
  } catch (e) {
    console.error(e);
  }
}

function renderSubscriberRow(s) {
  const tr = document.createElement('tr');
  const td = (content) => {
    const el = document.createElement('td');
    if (content instanceof Node) el.appendChild(content);
    else el.textContent = content == null ? '' : String(content);
    return el;
  };
  tr.appendChild(td(s.email));
  tr.appendChild(td(s.name || ''));
  tr.appendChild(td(s.source));
  const statusTd = document.createElement('td');
  statusTd.appendChild(statusBadgeNode(s.status));
  tr.appendChild(statusTd);
  const tagsTd = document.createElement('td');
  const tags = s.tags || [];
  if (tags.length === 0) tagsTd.textContent = '—';
  else tags.forEach((t, i) => {
    const span = document.createElement('span');
    span.className = 'tag';
    span.textContent = t;
    tagsTd.appendChild(span);
    if (i < tags.length - 1) tagsTd.appendChild(document.createTextNode(' '));
  });
  tr.appendChild(tagsTd);
  tr.appendChild(td(formatDate(s.created_at)));
  const actions = document.createElement('td');
  const group = document.createElement('div');
  group.className = 'btn-group';
  const tagsBtn = document.createElement('button');
  tagsBtn.type = 'button';
  tagsBtn.className = 'btn btn-sm';
  tagsBtn.textContent = 'Tags';
  tagsBtn.addEventListener('click', () => editTags(s.id, s.email, s.tags || []));
  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'btn btn-sm btn-danger';
  delBtn.textContent = 'Del';
  delBtn.addEventListener('click', () => deleteSub(s.id, s.email));
  group.append(tagsBtn, delBtn);
  actions.appendChild(group);
  tr.appendChild(actions);
  return tr;
}

// Debounced search
let searchTimer;
document.getElementById('searchInput').addEventListener('input', function() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadSubscribers(1), 300);
});
document.getElementById('statusFilter').addEventListener('change', () => loadSubscribers(1));
document.getElementById('sourceFilter').addEventListener('change', () => loadSubscribers(1));

function exportCSV() {
  const status = document.getElementById('statusFilter').value;
  const url = `/api/admin/subscribers/export${status ? '?status=' + status : ''}`;
  const a = document.createElement('a');
  a.href = url;
  a.download = 'subscribers.csv';
  // auth is cookie-based — see admin.js
  fetch(url, { credentials: 'same-origin' })
    .then(r => {
      if (!r.ok) throw new Error('Export failed');
      return r.blob();
    })
    .then(blob => {
      a.href = URL.createObjectURL(blob);
      a.click();
    })
    .catch(() => { alert('Failed to export subscribers'); });
}

document.getElementById('importForm').addEventListener('submit', async function(e) {
  e.preventDefault();
  const file = document.getElementById('csvFile').files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  try {
    const data = await api('/import', { method: 'POST', body: fd });
    document.getElementById('importResult').textContent = `Imported ${data.imported}, skipped ${data.skipped} of ${data.total}`;
    document.getElementById('importResult').style.color = 'var(--success)';
    loadSubscribers(1);
  } catch (e) {
    document.getElementById('importResult').textContent = e.message;
    document.getElementById('importResult').style.color = 'var(--danger)';
  }
});

function editTags(id, email, tags) {
  editingSubId = id;
  document.getElementById('tagsEmail').textContent = email;
  document.getElementById('tagsInput').value = (tags || []).join(', ');
  document.getElementById('tagsModal').classList.add('show');
}

async function saveTags() {
  const tags = document.getElementById('tagsInput').value.split(',').map(t => t.trim()).filter(Boolean);
  try {
    await api(`/subscribers/${editingSubId}/tags`, { method: 'POST', body: { tags } });
    document.getElementById('tagsModal').classList.remove('show');
    loadSubscribers(currentPage);
  } catch (e) { alert(e.message); }
}

async function deleteSub(id, email) {
  if (!confirm(`Delete subscriber ${email}?`)) return;
  try {
    await api(`/subscribers/${id}`, { method: 'DELETE' });
    loadSubscribers(currentPage);
  } catch (e) { alert(e.message); }
}

loadSubscribers(1);

// Wire static UI controls (CSP script-src drops 'unsafe-inline', so we can't
// use inline onclick attributes).
document.getElementById('exportBtn').addEventListener('click', exportCSV);
document.getElementById('openImportBtn').addEventListener('click', function() {
  document.getElementById('importModal').classList.add('show');
});
document.getElementById('importCancelBtn').addEventListener('click', function() {
  document.getElementById('importModal').classList.remove('show');
});
document.getElementById('tagsCancelBtn').addEventListener('click', function() {
  document.getElementById('tagsModal').classList.remove('show');
});
document.getElementById('tagsSaveBtn').addEventListener('click', saveTags);
