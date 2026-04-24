// If already logged in (cookie-based), go to dashboard
fetch('/api/admin/check', { credentials: 'same-origin' })
  .then((r) => r.json())
  .then((d) => { if (d.ok) window.location.href = '/admin/dashboard.html'; })
  .catch(() => {});

document.getElementById('loginForm').addEventListener('submit', async function(e) {
  e.preventDefault();
  const err = document.getElementById('error');
  err.style.display = 'none';
  const btn = this.querySelector('button');
  btn.disabled = true;
  btn.textContent = 'Signing in...';
  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ password: document.getElementById('password').value })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    window.location.href = '/admin/dashboard.html';
  } catch (ex) {
    err.textContent = ex.message;
    err.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Sign In';
  }
});
