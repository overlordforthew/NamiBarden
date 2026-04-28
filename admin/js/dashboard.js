initAdminPage();

function severityBadge(severity) {
  return `<span class="badge badge-${severity || 'info'}">${escapeHtml(severity || 'info')}</span>`;
}

(async function() {
  try {
    const data = await api('/stats');
    document.getElementById('statActive').textContent = data.subscribers.active;
    document.getElementById('statContacts').textContent = data.contacts.total;
    document.getElementById('statCampaigns').textContent = data.campaigns.sent;
    document.getElementById('statOpens').textContent = data.campaigns.total_opens;
    document.getElementById('statAlerts').textContent = data.alerts.open || '0';
    document.getElementById('statCriticalAlerts').textContent = `${data.alerts.critical_open || 0} critical`;

    const chart = document.getElementById('growthChart');
    if (data.growth.length > 0) {
      const max = Math.max(...data.growth.map(g => parseInt(g.count, 10)), 1);
      data.growth.forEach(g => {
        const bar = document.createElement('div');
        bar.className = 'chart-bar';
        bar.style.height = ((parseInt(g.count, 10) / max) * 100) + '%';
        bar.setAttribute('data-tooltip', `${g.date.slice(5)}: ${g.count}`);
        chart.appendChild(bar);
      });
    } else {
      chart.innerHTML = '<div class="empty" style="width:100%"><p>No data yet</p></div>';
    }

    const st = document.getElementById('sourcesTable');
    if (data.sources.length > 0) {
      st.innerHTML = data.sources.map(s => `<tr><td>${escapeHtml(s.source)}</td><td>${s.count}</td></tr>`).join('');
    } else {
      st.innerHTML = '<tr><td colspan="2" style="text-align:center; color:var(--text-light)">No subscribers yet</td></tr>';
    }

    const ct = document.getElementById('campaignsTable');
    if (data.recentCampaigns.length > 0) {
      ct.innerHTML = data.recentCampaigns.map(c => `<tr>
        <td><a href="/admin/campaigns.html?id=${c.id}" style="color:var(--gold-dark)">${escapeHtml(c.subject)}</a></td>
        <td>${statusBadge(c.status)}</td>
        <td>${c.sent_count || 0}</td>
        <td>${c.open_count || 0}</td>
        <td>${c.click_count || 0}</td>
        <td>${formatDate(c.sent_at)}</td>
      </tr>`).join('');
    } else {
      ct.innerHTML = '<tr><td colspan="6" style="text-align:center; color:var(--text-light)">No campaigns yet</td></tr>';
    }

    const at = document.getElementById('alertsTable');
    if (data.recentAlerts.length > 0) {
      at.innerHTML = data.recentAlerts.map(a => `<tr>
        <td>${escapeHtml(a.title)}</td>
        <td>${escapeHtml(a.source)}</td>
        <td>${severityBadge(a.severity)}</td>
        <td>${statusBadge(a.status)}</td>
        <td>${formatDateTime(a.lastSeen)}</td>
      </tr>`).join('');
    } else {
      at.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--text-light)">No alerts recorded</td></tr>';
    }
  } catch (e) {
    console.error(e);
  }
})();
