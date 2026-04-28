// ─── NamiBarden Admin — Shared Auth & API Helpers ───

const API = '/api/admin';

// Auth is now cookie-based (httpOnly) — no localStorage tokens
function requireAuth() {
  // Validate cookie with server (non-blocking — redirects on failure)
  fetch('/api/admin/check', { credentials: 'same-origin' })
    .then(function(r) { if (r.status === 401 || r.status === 403) window.location.href = '/admin/'; return r.json(); })
    .then(function(d) { if (d && !d.ok) window.location.href = '/admin/'; })
    .catch(function() {});
  return true;
}

async function api(path, opts = {}) {
  const headers = { ...opts.headers };
  if (opts.body && !(opts.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  let res;
  try {
    res = await fetch(`${API}${path}`, { ...opts, headers, credentials: 'same-origin' });
  } catch (e) {
    const wrapped = new Error('Network error — check your connection');
    wrapped.cause = e;
    throw wrapped;
  }
  if (res.status === 401) { window.location.href = '/admin/'; return; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function statusBadge(status) {
  return `<span class="badge badge-${status}">${status}</span>`;
}

function statusBadgeNode(status) {
  const span = document.createElement('span');
  span.className = `badge badge-${status}`;
  span.textContent = status;
  return span;
}

function formatDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateTime(d) {
  if (!d) return '—';
  const dt = new Date(d);
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
         dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

function showAlert(container, msg, type = 'success') {
  const el = document.createElement('div');
  el.className = `alert alert-${type}`;
  el.textContent = msg;
  container.prepend(el);
  setTimeout(() => el.remove(), 5000);
}

// Pagination helper
function renderPagination(container, page, total, limit, onPage) {
  const totalPages = Math.ceil(total / limit);
  container.innerHTML = '';
  if (totalPages <= 1) return;

  const prev = document.createElement('button');
  prev.textContent = 'Prev';
  prev.disabled = page <= 1;
  prev.onclick = () => onPage(page - 1);
  container.appendChild(prev);

  const info = document.createElement('span');
  info.textContent = `Page ${page} of ${totalPages}`;
  container.appendChild(info);

  const next = document.createElement('button');
  next.textContent = 'Next';
  next.disabled = page >= totalPages;
  next.onclick = () => onPage(page + 1);
  container.appendChild(next);
}

// Sidebar active link
function initSidebar() {
  const path = window.location.pathname;
  document.querySelectorAll('.sidebar a').forEach(a => {
    if (a.getAttribute('href') === path) a.classList.add('active');
  });
}

function logout() {
  fetch('/api/admin/logout', { method: 'POST', credentials: 'same-origin' })
    .finally(function() { window.location.href = '/admin/'; });
}

// Wires any sidebar `<a id="logoutLink">` (or `.logout-link`) to logout without
// needing an inline `onclick`, so we can tighten CSP to drop 'unsafe-inline'
// from script-src.
function initLogoutLink() {
  const links = document.querySelectorAll('#logoutLink, .logout-link');
  links.forEach(function(link) {
    link.addEventListener('click', function(e) {
      e.preventDefault();
      logout();
    });
  });
}

// Standard bootstrap every authenticated admin page calls instead of the old
// `if (!requireAuth()) throw 'auth'; initSidebar();` pair. Also wires the
// sidebar logout link.
function initAdminPage() {
  if (!requireAuth()) throw 'auth';
  initSidebar();
  initLogoutLink();
}
