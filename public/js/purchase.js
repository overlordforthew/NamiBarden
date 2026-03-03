async function purchaseCourse(product) {
  const btn = event.target.closest('.btn');
  const origText = btn.querySelector('span').textContent;
  btn.querySelector('span').textContent = '処理中...';
  btn.style.pointerEvents = 'none';
  try {
    const res = await fetch('/api/stripe/create-checkout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product })
    });
    const data = await res.json();
    if (data.url) {
      window.location.href = data.url;
    } else {
      alert(data.error || 'エラーが発生しました');
      btn.querySelector('span').textContent = origText;
      btn.style.pointerEvents = '';
    }
  } catch {
    alert('接続エラーが発生しました');
    btn.querySelector('span').textContent = origText;
    btn.style.pointerEvents = '';
  }
}
