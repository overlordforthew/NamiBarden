initAdminPage();
const courseIds = ['course-1', 'course-2'];
const categories = [
  ['course-1', 'Course 1 / コース1'],
  ['course-2', 'Course 2 / コース2'],
  ['course-bundle', 'Bundle / セット'],
  ['certification', 'Certification / 認定'],
  ['couples', 'Couples / カップル'],
  ['lumina-lifetime', 'Lumina lifetime'],
  ['single-session', 'Single session']
];
const colors = ['#2f6f7c', '#b56b45', '#6d7f3f', '#8d5a97', '#d89c2b', '#2b5f9e', '#7b6f62'];
const state = {
  range: '30d',
  from: '',
  to: '',
  granularity: 'day',
  compare: 'none',
  selectedCategories: ['course-1', 'course-2', 'lumina-lifetime', 'single-session']
};
const charts = {};

function partsInJst(date) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
}

function jstDate(date) {
  const p = partsInJst(date);
  return `${p.year}-${p.month}-${p.day}`;
}

function addDays(dateString, days) {
  const dt = new Date(`${dateString}T00:00:00+09:00`);
  return jstDate(new Date(dt.getTime() + days * 86400000));
}

function setRange(range) {
  state.range = range;
  const today = jstDate(new Date());
  const to = addDays(today, 1);
  const p = partsInJst(new Date());
  const month = Number(p.month);
  const quarterStartMonth = String(Math.floor((month - 1) / 3) * 3 + 1).padStart(2, '0');
  if (range === '7d') state.from = addDays(to, -7);
  else if (range === 'qtd') state.from = `${p.year}-${quarterStartMonth}-01`;
  else if (range === 'ytd') state.from = `${p.year}-01-01`;
  else if (range !== 'custom') state.from = addDays(to, -30);
  state.to = to;
  document.getElementById('fromDate').value = state.from;
  document.getElementById('toDate').value = state.to;
  document.querySelectorAll('[data-range]').forEach((button) => {
    button.classList.toggle('active', button.dataset.range === range);
  });
}

function yen(value) {
  return new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY', maximumFractionDigits: 0 }).format(Number(value) || 0);
}

function pct(value) {
  if (!Number.isFinite(value)) return '—';
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function clearNode(node) {
  node.replaceChildren();
}

function appendCell(row, text) {
  const cell = document.createElement('td');
  cell.textContent = text == null ? '' : String(text);
  row.appendChild(cell);
  return cell;
}

function setChart(key, id, config) {
  if (charts[key]) charts[key].destroy();
  const ctx = document.getElementById(id);
  charts[key] = new Chart(ctx, config);
}

function qs(extra = {}) {
  return new URLSearchParams({
    from: state.from,
    to: state.to,
    granularity: state.granularity,
    compare: state.compare,
    ...extra
  });
}

function renderKpis(summary) {
  const grid = document.getElementById('kpiGrid');
  clearNode(grid);
  const totals = summary.totals || {};
  const prior = summary.comparisonTotals || null;
  const refundRate = totals.gross ? (totals.refunds / totals.gross) * 100 : 0;
  const priorRefundRate = prior && prior.gross ? (prior.refunds / prior.gross) * 100 : null;
  const items = [
    ['Net revenue', yen(totals.net), prior ? pct(((totals.net - prior.net) / Math.max(Math.abs(prior.net), 1)) * 100) : '—'],
    ['Payments', String(totals.payments || 0), prior ? pct(((totals.payments - prior.payments) / Math.max(Math.abs(prior.payments), 1)) * 100) : '—'],
    ['Unique payers', String(totals.uniquePayers || 0), prior ? pct(((totals.uniquePayers - prior.uniquePayers) / Math.max(Math.abs(prior.uniquePayers), 1)) * 100) : '—'],
    ['Refund rate', `${refundRate.toFixed(1)}%`, priorRefundRate == null ? '—' : pct(refundRate - priorRefundRate)]
  ];
  for (const [label, value, delta] of items) {
    const card = document.createElement('div');
    card.className = 'stat-card';
    const labelEl = document.createElement('div');
    labelEl.className = 'label';
    labelEl.textContent = label;
    const valueEl = document.createElement('div');
    valueEl.className = 'kpi-value';
    valueEl.textContent = value;
    const deltaEl = document.createElement('div');
    deltaEl.className = 'kpi-delta';
    deltaEl.textContent = delta;
    card.append(labelEl, valueEl, deltaEl);
    grid.appendChild(card);
  }
  const diagnostic = document.getElementById('diagnosticLine');
  const excluded = summary.meta?.nonJpyExcluded?.count || 0;
  const legacy = summary.meta?.legacyActiveSubscriptions || 0;
  const notes = [];
  if (excluded > 0) notes.push(`${excluded} non-JPY payments excluded from reports.`);
  if (legacy > 0) notes.push(`${legacy} legacy active subscriptions detected.`);
  diagnostic.classList.toggle('show', notes.length > 0);
  diagnostic.textContent = notes.join(' ');
}

async function fetchRevenue(category) {
  return api(`/reports/revenue?${qs({ category }).toString()}`);
}

async function loadRevenue() {
  const [summary, ...series] = await Promise.all([
    fetchRevenue('all'),
    ...state.selectedCategories.map((category) => fetchRevenue(category))
  ]);
  renderKpis(summary);
  const labels = Array.from(new Set(series.flatMap((item) => item.buckets.map((row) => row.bucket)))).sort();
  const datasets = [];
  series.forEach((item, index) => {
    const category = state.selectedCategories[index];
    const byBucket = new Map(item.buckets.map((row) => [row.bucket, row.net]));
    datasets.push({
      label: categories.find((entry) => entry[0] === category)?.[1] || category,
      data: labels.map((bucket) => byBucket.get(bucket) || 0),
      borderColor: colors[index % colors.length],
      backgroundColor: colors[index % colors.length],
      tension: 0.25,
      categoryKey: category
    });
    if (item.comparison) {
      const prior = new Map(item.comparison.map((row) => [row.bucket, row.net]));
      datasets.push({
        label: `${categories.find((entry) => entry[0] === category)?.[1] || category} prior`,
        data: Array.from(prior.values()),
        borderColor: colors[index % colors.length],
        backgroundColor: colors[index % colors.length],
        borderDash: [6, 6],
        tension: 0.25,
        pointRadius: 0,
        categoryKey: category,
        comparison: true
      });
    }
  });
  setChart('revenue', 'revenueChart', {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'nearest', intersect: false },
      plugins: { tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${yen(ctx.parsed.y)}` } } },
      scales: { y: { ticks: { callback: (value) => yen(value) } } },
      onClick: (_event, elements, chart) => {
        const hit = elements[0];
        if (!hit) return;
        const dataset = chart.data.datasets[hit.datasetIndex];
        if (dataset.comparison) return;
        openPayments(chart.data.labels[hit.index], dataset.categoryKey);
      }
    }
  });
}

async function loadByProduct() {
  const data = await api(`/reports/revenue-by-product?${qs().toString()}`);
  const labels = data.rows.map((row) => row.category);
  setChart('category', 'categoryChart', {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Gross / 総売上', data: data.rows.map((row) => row.gross), backgroundColor: '#2f6f7c' },
        { label: 'Refunds / 返金', data: data.rows.map((row) => -row.refunds), backgroundColor: '#b56b45' }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: { x: { stacked: true }, y: { stacked: true, ticks: { callback: (value) => yen(value) } } },
      plugins: { tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${yen(Math.abs(ctx.parsed.y))}` } } }
    }
  });
  const body = document.getElementById('categoryTable');
  clearNode(body);
  const netTotal = Math.max(Math.abs(data.totals?.net || 0), 1);
  data.rows.forEach((row) => {
    const tr = document.createElement('tr');
    appendCell(tr, row.category);
    appendCell(tr, yen(row.gross));
    appendCell(tr, yen(row.refunds));
    appendCell(tr, yen(row.net));
    appendCell(tr, row.payments);
    appendCell(tr, `${((row.net / netTotal) * 100).toFixed(1)}%`);
    body.appendChild(tr);
  });
}

async function loadCompletion() {
  const results = await Promise.all(courseIds.map((course) => api(`/reports/completion?course=${encodeURIComponent(course)}`)));
  const bucketLabels = results[0]?.buckets.map((bucket) => bucket.range) || [];
  setChart('completion', 'completionChart', {
    type: 'bar',
    data: {
      labels: results.map((row) => row.courseId),
      datasets: bucketLabels.map((label, index) => ({
        label,
        data: results.map((row) => row.buckets[index]?.studentCount || 0),
        backgroundColor: colors[index % colors.length],
        bucketKey: label.replace('%', '')
      }))
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: 'y',
      scales: { x: { stacked: true }, y: { stacked: true } },
      onClick: (_event, elements, chart) => {
        const hit = elements[0];
        if (!hit) return;
        const course = chart.data.labels[hit.index];
        const bucket = chart.data.datasets[hit.datasetIndex].bucketKey;
        openStudents(course, bucket);
      }
    }
  });
}

async function loadDropoff() {
  const container = document.getElementById('dropoffPanels');
  clearNode(container);
  const results = await Promise.all(courseIds.map((course) => api(`/reports/dropoff?course=${encodeURIComponent(course)}`)));
  results.forEach((result, index) => {
    const details = document.createElement('details');
    details.className = 'course-dropoff';
    details.open = index === 0;
    const summary = document.createElement('summary');
    summary.textContent = result.courseId;
    const wrap = document.createElement('div');
    wrap.className = 'chart-wrap';
    const canvas = document.createElement('canvas');
    const canvasId = `dropoff-${result.courseId}`;
    canvas.id = canvasId;
    wrap.appendChild(canvas);
    details.append(summary, wrap);
    container.appendChild(details);
    setChart(canvasId, canvasId, {
      type: 'line',
      data: {
        labels: result.lessons.map((lesson) => `${lesson.order}. ${lesson.lessonId}`),
        datasets: [
          { label: 'Started / 開始', data: result.lessons.map((lesson) => lesson.startedCount), borderColor: '#2f6f7c', backgroundColor: '#2f6f7c' },
          { label: 'Completed / 完了', data: result.lessons.map((lesson) => lesson.completedCount), borderColor: '#6d7f3f', backgroundColor: '#6d7f3f' },
          { label: 'Next started / 次開始', data: result.lessons.map((lesson) => lesson.nextStartedCount), borderColor: '#b56b45', backgroundColor: '#b56b45' }
        ]
      },
      options: { responsive: true, maintainAspectRatio: false, tension: 0.2 }
    });
  });
}

function renderCategoryControls() {
  const container = document.getElementById('categoryList');
  clearNode(container);
  categories.forEach(([value, label]) => {
    const item = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = value;
    input.checked = state.selectedCategories.includes(value);
    input.addEventListener('change', () => {
      state.selectedCategories = Array.from(document.querySelectorAll('#categoryList input:checked')).map((el) => el.value);
      if (state.selectedCategories.length === 0) {
        input.checked = true;
        state.selectedCategories = [value];
      }
      refresh();
    });
    const span = document.createElement('span');
    span.textContent = label;
    item.append(input, span);
    container.appendChild(item);
  });
}

async function openPayments(date, category) {
  const data = await api(`/reports/payments?date=${encodeURIComponent(date)}&product=${encodeURIComponent(category)}&sort=created_at&dir=desc`);
  openModal(`${date} ${category}`, ['Customer', 'Product', 'Amount', 'Paid at'], data.payments, (row, payment) => {
    const customer = document.createElement('td');
    if (payment.customerId) {
      const link = document.createElement('a');
      link.href = `/admin/customers.html#/c/${payment.customerId}`;
      link.textContent = payment.email || payment.name || String(payment.customerId);
      customer.appendChild(link);
    } else {
      customer.textContent = payment.email || '';
    }
    row.appendChild(customer);
    appendCell(row, payment.productName || '');
    appendCell(row, yen(payment.amount));
    appendCell(row, formatDateTime(payment.createdAt));
  });
}

async function openStudents(course, bucket) {
  const data = await api(`/reports/completion/students?course=${encodeURIComponent(course)}&bucket=${encodeURIComponent(bucket)}`);
  openModal(`${course} ${bucket}%`, ['Student', 'Name', 'Completion', 'Last watched'], data.students, (row, student) => {
    const emailCell = document.createElement('td');
    if (student.customerId) {
      const link = document.createElement('a');
      link.href = `/admin/customers.html#/c/${student.customerId}`;
      link.textContent = student.email || String(student.customerId);
      emailCell.appendChild(link);
    } else {
      emailCell.textContent = student.email || '';
    }
    row.appendChild(emailCell);
    appendCell(row, student.name || '');
    appendCell(row, `${student.completionPct}%`);
    appendCell(row, formatDateTime(student.lastWatchedAt));
  });
}

function openModal(title, headers, rows, renderRow) {
  document.getElementById('modalTitle').textContent = title;
  const head = document.getElementById('modalHead');
  const body = document.getElementById('modalBody');
  clearNode(head);
  clearNode(body);
  const headerRow = document.createElement('tr');
  headers.forEach((header) => {
    const th = document.createElement('th');
    th.textContent = header;
    headerRow.appendChild(th);
  });
  head.appendChild(headerRow);
  rows.forEach((item) => {
    const tr = document.createElement('tr');
    renderRow(tr, item);
    body.appendChild(tr);
  });
  document.getElementById('reportsModal').classList.add('show');
}

function updateExportLinks() {
  document.getElementById('revenueExport').href = `/api/admin/reports/revenue/export?${qs({ category: 'all' }).toString()}`;
  document.getElementById('productExport').href = `/api/admin/reports/revenue-by-product/export?${qs().toString()}`;
  document.getElementById('completionExport').href = `/api/admin/reports/completion/export?course=course-1`;
  document.getElementById('dropoffExport').href = `/api/admin/reports/dropoff/export?course=course-1`;
}

async function refresh() {
  state.granularity = document.getElementById('granularity').value;
  state.compare = document.getElementById('compareToggle').checked ? 'prior-period' : 'none';
  updateExportLinks();
  await Promise.all([loadRevenue(), loadByProduct(), loadCompletion(), loadDropoff()]);
}

document.getElementById('rangeButtons').addEventListener('click', (event) => {
  const button = event.target.closest('[data-range]');
  if (!button) return;
  setRange(button.dataset.range);
  refresh();
});
document.getElementById('fromDate').addEventListener('change', (event) => {
  state.from = event.target.value;
  state.range = 'custom';
  document.querySelectorAll('[data-range]').forEach((button) => button.classList.toggle('active', button.dataset.range === 'custom'));
  refresh();
});
document.getElementById('toDate').addEventListener('change', (event) => {
  state.to = event.target.value;
  state.range = 'custom';
  document.querySelectorAll('[data-range]').forEach((button) => button.classList.toggle('active', button.dataset.range === 'custom'));
  refresh();
});
document.getElementById('granularity').addEventListener('change', refresh);
document.getElementById('compareToggle').addEventListener('change', refresh);
document.getElementById('modalClose').addEventListener('click', () => document.getElementById('reportsModal').classList.remove('show'));
document.getElementById('reportsModal').addEventListener('click', (event) => {
  if (event.target.id === 'reportsModal') event.currentTarget.classList.remove('show');
});

renderCategoryControls();
setRange('30d');
refresh().catch((err) => {
  console.error(err);
  const diagnostic = document.getElementById('diagnosticLine');
  diagnostic.classList.add('show');
  diagnostic.textContent = err.message || 'Reports failed to load';
});
