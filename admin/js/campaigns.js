initAdminPage();
// Check if viewing specific campaign
const params = new URLSearchParams(window.location.search);
if (params.get('id')) {
  loadCampaignDetail(params.get('id'));
} else {
  loadCampaigns();
}

async function loadCampaigns() {
  try {
    const data = await api('/campaigns');
    const tb = document.getElementById('campaignsTable');
    if (data.campaigns.length === 0) {
      tb.innerHTML = '<tr><td colspan="9" class="empty">No campaigns yet. <a href="/admin/compose.html" style="color:var(--gold-dark)">Create one</a></td></tr>';
      return;
    }
    tb.innerHTML = data.campaigns.map(c => {
      const openRate = c.sent_count > 0 ? Math.round(c.open_count / c.sent_count * 100) : 0;
      const clickRate = c.sent_count > 0 ? Math.round(c.click_count / c.sent_count * 100) : 0;
      return `<tr>
        <td><a href="?id=${c.id}" style="color:var(--gold-dark)">${escapeHtml(c.subject)}</a></td>
        <td>${statusBadge(c.status)}</td>
        <td>${escapeHtml(c.segment || 'all')}</td>
        <td>${c.sent_count}/${c.total_count}</td>
        <td>${c.open_count} (${openRate}%)</td>
        <td>${c.click_count} (${clickRate}%)</td>
        <td>${c.bounce_count}</td>
        <td>${formatDate(c.sent_at || c.created_at)}</td>
        <td>${c.status === 'draft' ? `<a href="/admin/compose.html?id=${c.id}" class="btn btn-sm">Edit</a>` : ''}</td>
      </tr>`;
    }).join('');
  } catch (e) { console.error(e); }
}

async function loadCampaignDetail(id) {
  document.getElementById('listView').style.display = 'none';
  document.getElementById('detailView').style.display = 'block';
  try {
    const data = await api(`/campaigns/${id}`);
    const c = data.campaign;
    document.getElementById('pageTitle').textContent = c.subject;

    const openRate = c.sent_count > 0 ? Math.round(c.open_count / c.sent_count * 100) : 0;
    const clickRate = c.sent_count > 0 ? Math.round(c.click_count / c.sent_count * 100) : 0;

    document.getElementById('detailStats').innerHTML = `
      <div class="stat-card"><div class="label">Status</div><div class="value">${statusBadge(c.status)}</div></div>
      <div class="stat-card"><div class="label">Sent</div><div class="value">${c.sent_count}/${c.total_count}</div></div>
      <div class="stat-card"><div class="label">Open Rate</div><div class="value gold">${openRate}%</div></div>
      <div class="stat-card"><div class="label">Click Rate</div><div class="value">${clickRate}%</div></div>
      <div class="stat-card"><div class="label">Bounced</div><div class="value">${c.bounce_count}</div></div>
      <div class="stat-card"><div class="label">Unsubscribed</div><div class="value">${c.unsub_count}</div></div>
    `;

    const rt = document.getElementById('recipientsTable');
    if (data.recipients.length === 0) {
      rt.innerHTML = '<tr><td colspan="4" class="empty">No recipients yet</td></tr>';
    } else {
      rt.innerHTML = data.recipients.map(r => `<tr>
        <td>${escapeHtml(r.email)}</td>
        <td>${statusBadge(r.status)}</td>
        <td>${formatDateTime(r.opened_at)}</td>
        <td>${formatDateTime(r.clicked_at)}</td>
      </tr>`).join('');
    }
  } catch (e) { console.error(e); }
}

function showList() {
  window.history.pushState({}, '', '/admin/campaigns.html');
  document.getElementById('listView').style.display = 'block';
  document.getElementById('detailView').style.display = 'none';
  document.getElementById('pageTitle').textContent = 'Campaigns';
  loadCampaigns();
}

document.getElementById('backBtn').addEventListener('click', showList);
