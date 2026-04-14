function createSiteHelpers({ crypto, siteUrl }) {
  function generateToken() {
    return crypto.randomBytes(32).toString('hex');
  }

  function buildGiftDownloadUrl(token) {
    const qs = `token=${encodeURIComponent(token)}`;
    const relativeUrl = `/api/gifts/5day-journal?${qs}`;
    return siteUrl ? `${siteUrl.replace(/\/+$/, '')}${relativeUrl}` : relativeUrl;
  }

  function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
  }

  function escapeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function injectTracking(html, trackingId, unsubToken) {
    const pixel = `<img src="${siteUrl}/api/track/open/${trackingId}" width="1" height="1" style="display:none" alt="">`;
    html = html.replace('</body>', `${pixel}</body>`);
    if (!html.includes(pixel)) html += pixel;

    html = html.replace(/href="(https?:\/\/[^"]+)"/g, (match, url) => {
      if (url.includes('/api/unsubscribe') || url.includes('/api/track')) return match;
      return `href="${siteUrl}/api/track/click/${trackingId}?url=${encodeURIComponent(url)}"`;
    });

    const footer = `<div style="text-align:center; padding:20px; margin-top:30px; border-top:1px solid #eee; font-size:12px; color:#999;">
    <p>You received this email because you subscribed at namibarden.com</p>
    <p><a href="${siteUrl}/api/unsubscribe/${unsubToken}" style="color:#999;">Unsubscribe</a></p>
  </div>`;
    html = html.replace('</body>', `${footer}</body>`);
    if (!html.includes(footer)) html += footer;

    return html;
  }

  function unsubPage(title, message, token) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} â€” Nami Barden</title>
<style>
body{font-family:-apple-system,system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#FAF7F2;color:#2C2C2C}
.box{text-align:center;max-width:400px;padding:40px;background:#fff;border-radius:12px;box-shadow:0 2px 20px rgba(0,0,0,0.08)}
h2{margin-bottom:16px;color:#2C2C2C}
p{color:#666;line-height:1.6}
button{margin-top:20px;padding:12px 32px;background:#C4A882;color:#fff;border:none;border-radius:8px;font-size:1rem;cursor:pointer}
button:hover{background:#a08860}
.done{color:#4a7}
</style></head><body><div class="box">
<h2>${title}</h2><p>${message}</p>
${token ? `<button onclick="doUnsub()">Confirm Unsubscribe</button><p id="result"></p>
<script>function doUnsub(){fetch('/api/unsubscribe/${token}',{method:'POST'}).then(r=>r.json()).then(d=>{document.querySelector('button').style.display='none';document.getElementById('result').innerHTML='<span class=done>'+d.message+'</span>'}).catch(()=>{document.getElementById('result').textContent='Error. Please try again.'})}</script>` : ''}
</div></body></html>`;
  }

  return {
    generateToken,
    buildGiftDownloadUrl,
    normalizeEmail,
    escapeHtml,
    injectTracking,
    unsubPage
  };
}

module.exports = { createSiteHelpers };
