initAdminPage();
function severityBadge(severity) {
  return `<span class="badge badge-${severity || 'info'}">${escapeHtml(severity || 'info')}</span>`;
}

function renderHealthLine(data) {
  if (!data) return 'Unavailable';
  return JSON.stringify(data);
}

async function fetchPublicStatus() {
  const [healthRes, readyRes] = await Promise.all([
    fetch('/api/health', { credentials: 'same-origin' }).then((r) => r.json().catch(() => ({ status: 'error' }))),
    fetch('/api/ready', { credentials: 'same-origin' }).then((r) => r.json().catch(() => ({ status: 'error' })))
  ]);
  document.getElementById('healthStatus').textContent = renderHealthLine(healthRes);
  document.getElementById('readyStatus').textContent = renderHealthLine(readyRes);
}

async function updateAlertStatus(alertId, status) {
  await api(`/alerts/${alertId}/status`, { method: 'POST', body: { status } });
  await loadAlerts();
}

function renderActions(alert) {
  const actions = [];
  if (alert.status !== 'acknowledged') {
    actions.push(`<button class="btn btn-sm" type="button" data-alert-id="${alert.id}" data-next-status="acknowledged">Acknowledge</button>`);
  }
  if (alert.status !== 'resolved') {
    actions.push(`<button class="btn btn-sm" type="button" data-alert-id="${alert.id}" data-next-status="resolved">Resolve</button>`);
  }
  if (alert.status !== 'open') {
    actions.push(`<button class="btn btn-sm" type="button" data-alert-id="${alert.id}" data-next-status="open">Re-open</button>`);
  }
  return actions.join('');
}

async function loadAlerts() {
  const params = new URLSearchParams();
  const status = document.getElementById('statusFilter').value;
  const severity = document.getElementById('severityFilter').value;
  const source = document.getElementById('sourceFilter').value;
  if (status) params.set('status', status);
  if (severity) params.set('severity', severity);
  if (source) params.set('source', source);
  params.set('limit', '100');

  const data = await api(`/alerts?${params.toString()}`);
  document.getElementById('summaryOpen').textContent = data.summary.open || '0';
  document.getElementById('summaryAcknowledged').textContent = data.summary.acknowledged || '0';
  document.getElementById('summaryResolved').textContent = data.summary.resolved || '0';
  document.getElementById('summaryCritical').textContent = data.summary.critical_open || '0';

  const table = document.getElementById('alertsTable');
  if (!data.alerts.length) {
    table.innerHTML = '<tr><td colspan="8" class="empty">No alerts match the current filters</td></tr>';
    return;
  }

  table.innerHTML = data.alerts.map((alert) => `
    <tr>
      <td>
        <strong>${escapeHtml(alert.title)}</strong>
        <div style="margin-top:4px;color:var(--text-light)">${escapeHtml(alert.message || '')}</div>
        <details style="margin-top:8px">
          <summary class="mono">details</summary>
          <div class="details-block mono">${escapeHtml(JSON.stringify(alert.details || {}, null, 2))}</div>
        </details>
      </td>
      <td>${escapeHtml(alert.source)}</td>
      <td>${severityBadge(alert.severity)}</td>
      <td>${statusBadge(alert.status)}</td>
      <td>${alert.occurrenceCount}</td>
      <td>${formatDateTime(alert.firstSeen)}</td>
      <td>${formatDateTime(alert.lastSeen)}</td>
      <td><div class="actions">${renderActions(alert)}</div></td>
    </tr>
  `).join('');

  table.querySelectorAll('button[data-alert-id]').forEach((button) => {
    button.addEventListener('click', async function() {
      const alertsContainer = document.getElementById('alerts');
      try {
        await updateAlertStatus(this.dataset.alertId, this.dataset.nextStatus);
        showAlert(alertsContainer, `Alert marked ${this.dataset.nextStatus}.`);
      } catch (err) {
        showAlert(alertsContainer, err.message || 'Failed to update alert.', 'error');
      }
    });
  });
}

document.getElementById('statusFilter').addEventListener('change', () => loadAlerts().catch(console.error));
document.getElementById('severityFilter').addEventListener('change', () => loadAlerts().catch(console.error));
document.getElementById('sourceFilter').addEventListener('change', () => loadAlerts().catch(console.error));
document.getElementById('refreshButton').addEventListener('click', () => {
  Promise.all([loadAlerts(), fetchPublicStatus()]).catch(console.error);
});

Promise.all([loadAlerts(), fetchPublicStatus()]).catch((err) => {
  console.error(err);
  showAlert(document.getElementById('alerts'), err.message || 'Failed to load alerts.', 'error');
});
