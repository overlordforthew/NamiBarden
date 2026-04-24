initAdminPage();
function pct(part, whole) {
  if (!whole) return '0%';
  return Math.round((part / whole) * 100) + '%';
}

function titleCasePlan(plan) {
  if (!plan) return 'Unknown';
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

function renderDailyChart(rows) {
  const chart = document.getElementById('activityChart');
  chart.innerHTML = '';
  if (!rows.length) {
    chart.innerHTML = '<div class="empty" style="width:100%"><p>No Lumina event data yet</p></div>';
    return;
  }
  const max = Math.max.apply(null, rows.map(row => row.activeUsers || 0).concat([1]));
  rows.forEach((row) => {
    const bar = document.createElement('div');
    bar.className = 'chart-bar';
    bar.style.height = ((row.activeUsers || 0) / max * 100) + '%';
    bar.setAttribute('data-tooltip', `${row.day}: active ${row.activeUsers}, checkout ${row.checkoutStarts}, grants ${row.accessGrants}, check-ins ${row.checkins}, completions ${row.completions}`);
    chart.appendChild(bar);
  });
}

function renderKeyList(items) {
  return items.map(item => `
    <div class="key-item">
      <span>${escapeHtml(item.label)}</span>
      <strong>${escapeHtml(item.value)}</strong>
    </div>
  `).join('');
}

async function loadLuminaAnalytics() {
  const days = document.getElementById('windowDays').value;
  const data = await api(`/lumina/analytics?days=${encodeURIComponent(days)}`);
  document.getElementById('windowLabel').textContent = `Lumina funnel and engagement over the last ${data.windowDays} days.`;

  document.getElementById('statActiveAccess').textContent = data.subscriptions.activeAccess;
  document.getElementById('statTrialing').textContent = data.subscriptions.trialing;
  document.getElementById('statActive7d').textContent = data.engagement.active7d;
  document.getElementById('statAvgDays').textContent = data.engagement.avgCompletedDays.toFixed ? data.engagement.avgCompletedDays.toFixed(1) : data.engagement.avgCompletedDays;
  document.getElementById('statNewUsers').textContent = data.engagement.newUsersWindow;
  document.getElementById('statCheckoutStarts').textContent = (data.funnel.find(stage => stage.eventName === 'billing_checkout_started') || {}).uniqueActors || 0;
  document.getElementById('statAccessGrants').textContent = (data.funnel.find(stage => stage.eventName === 'billing_access_granted') || {}).uniqueActors || 0;
  document.getElementById('statDay7Reach').textContent = pct(data.engagement.reachedDay7, data.engagement.startedJourney || data.engagement.totalUsers);
  document.getElementById('statDay30Reach').textContent = pct(data.engagement.reachedDay30, data.engagement.startedJourney || data.engagement.totalUsers);
  document.getElementById('statReflectiveUsers').textContent = data.engagement.reflectiveUsers;
  document.getElementById('statGrace').textContent = data.subscriptions.grace;
  document.getElementById('statCancelScheduled').textContent = data.subscriptions.cancelScheduled;
  document.getElementById('statExpired').textContent = data.subscriptions.expired;

  renderDailyChart(data.daily);

  document.getElementById('engagementList').innerHTML = renderKeyList([
    { label: 'Total Lumina users', value: String(data.engagement.totalUsers) },
    { label: 'Started journey', value: `${data.engagement.startedJourney} (${pct(data.engagement.startedJourney, data.engagement.totalUsers)})` },
    { label: 'Reached day 7', value: `${data.engagement.reachedDay7} (${pct(data.engagement.reachedDay7, data.engagement.startedJourney || data.engagement.totalUsers)})` },
    { label: 'Reached day 30', value: `${data.engagement.reachedDay30} (${pct(data.engagement.reachedDay30, data.engagement.startedJourney || data.engagement.totalUsers)})` },
    { label: 'Users with check-ins', value: `${data.engagement.checkedInUsers} (${pct(data.engagement.checkedInUsers, data.engagement.totalUsers)})` },
    { label: 'Users with reflections', value: `${data.engagement.reflectiveUsers} (${pct(data.engagement.reflectiveUsers, data.engagement.totalUsers)})` }
  ]);

  let prevActors = 0;
  document.getElementById('funnelTable').innerHTML = data.funnel.map((stage, idx) => {
    const conversion = idx === 0 ? '—' : pct(stage.uniqueActors, prevActors);
    prevActors = stage.uniqueActors || prevActors;
    return `<tr>
      <td>${escapeHtml(stage.label)}</td>
      <td>${stage.uniqueActors}</td>
      <td>${stage.totalEvents}</td>
      <td>${conversion}</td>
    </tr>`;
  }).join('');

  document.getElementById('planTable').innerHTML = data.subscriptions.plans.length
    ? data.subscriptions.plans.map(plan => `<tr>
        <td>${escapeHtml(titleCasePlan(plan.planCode))}</td>
        <td>${plan.total}</td>
        <td>${plan.activeAccess}</td>
        <td>${plan.trialing}</td>
      </tr>`).join('')
    : '<tr><td colspan="4" class="empty">No Lumina entitlements yet</td></tr>';

  document.getElementById('statesList').innerHTML = data.states.length
    ? renderKeyList(data.states.map(state => ({ label: state.state, value: String(state.count) })))
    : '<div class="empty"><p>No recent check-in state data</p></div>';

  document.getElementById('eventsTable').innerHTML = data.recentEvents.length
    ? data.recentEvents.map(evt => `<tr>
        <td>${formatDateTime(evt.createdAt)}</td>
        <td><span class="mono">${escapeHtml(evt.eventName)}</span></td>
        <td>${escapeHtml(evt.email || 'anonymous')}</td>
        <td>${escapeHtml(evt.pagePath || '-')}</td>
        <td><span class="mono">${escapeHtml(JSON.stringify(evt.properties || {}))}</span></td>
      </tr>`).join('')
    : '<tr><td colspan="5" class="empty">No events recorded yet</td></tr>';
}

document.getElementById('windowDays').addEventListener('change', function() {
  loadLuminaAnalytics().catch((err) => console.error(err));
});

loadLuminaAnalytics().catch((err) => console.error(err));
