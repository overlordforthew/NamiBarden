initAdminPage();
let currentPage = 1;
const limit = 100;

function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function buildParams(page) {
  const params = new URLSearchParams({ page: page || currentPage, limit });
  const search = document.getElementById('searchInput').value.trim();
  const ownership = document.getElementById('ownershipFilter').value;
  if (search) params.set('search', search);
  if (ownership) params.set('courseOwnership', ownership);
  if (document.getElementById('includeEmptyStudents').checked) params.set('includeEmptyStudents', 'true');
  return params;
}

function renderCourseCell(td, cell) {
  const wrap = document.createElement('span');
  wrap.className = 'cell-owned';
  const mark = document.createElement('span');
  mark.className = cell.owned ? 'check' : 'missing';
  mark.textContent = cell.owned ? '✓' : '✗';
  wrap.appendChild(mark);
  if (cell.owned) {
    const pct = document.createElement('span');
    pct.className = 'pct';
    pct.textContent = `${cell.completionPct || 0}%`;
    wrap.appendChild(pct);
    td.title = `${cell.completedCount || 0}/${cell.totalLessons || 0} completed`;
  }
  td.appendChild(wrap);
}

function renderLuminaCell(td, cell) {
  const status = cell.normalizedStatus || 'none';
  if (status === 'refunded' || status === 'revoked') {
    const badge = document.createElement('span');
    badge.className = 'lumina-refunded';
    badge.textContent = '—';
    td.title = status;
    td.appendChild(badge);
    return;
  }
  const mark = document.createElement('span');
  mark.className = cell.owned ? 'lumina-active' : 'missing';
  mark.textContent = cell.owned ? (status === 'lifetime' ? '✓' : '⏳') : '✗';
  td.title = status;
  td.appendChild(mark);
  if (cell.owned && status !== 'lifetime') {
    const pct = document.createElement('span');
    pct.className = 'pct';
    pct.style.marginLeft = '6px';
    pct.textContent = status;
    td.appendChild(pct);
  }
}

async function loadMatrix(page) {
  currentPage = page || 1;
  const data = await api(`/matrix?${buildParams(currentPage)}`);
  const head = document.getElementById('matrixHead');
  const body = document.getElementById('matrixBody');
  clear(head);
  clear(body);

  const trh = document.createElement('tr');
  const first = document.createElement('th');
  first.textContent = 'Customer';
  trh.appendChild(first);
  data.columns.forEach(function(col) {
    const th = document.createElement('th');
    th.textContent = col.name;
    if (col.totalLessons) th.title = `${col.totalLessons} playable lessons`;
    trh.appendChild(th);
  });
  head.appendChild(trh);

  if (!data.rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = data.columns.length + 1;
    td.className = 'empty';
    td.textContent = 'No customers found';
    tr.appendChild(td);
    body.appendChild(tr);
  } else {
    data.rows.forEach(function(row) {
      const tr = document.createElement('tr');
      tr.onclick = function() { window.location.href = `/admin/customers.html#/c/${row.customerId}`; };
      const customer = document.createElement('td');
      const name = document.createElement('div');
      name.className = 'student-name';
      name.textContent = row.name || row.email;
      const email = document.createElement('div');
      email.className = 'student-email';
      email.textContent = row.email;
      customer.append(name, email);
      tr.appendChild(customer);
      data.columns.forEach(function(col) {
        const td = document.createElement('td');
        const cell = row.cells[col.courseId] || { owned: false };
        if (col.courseId === 'lumina') renderLuminaCell(td, cell);
        else renderCourseCell(td, cell);
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
  }
  renderPagination(document.getElementById('pagination'), data.page, data.total, limit, loadMatrix);
}

function exportCSV() {
  const params = buildParams(currentPage);
  params.delete('page');
  params.delete('limit');
  const url = `/api/admin/matrix/export?${params}`;
  fetch(url, { credentials: 'same-origin' })
    .then(function(r) { if (!r.ok) throw new Error('Export failed'); return r.blob(); })
    .then(function(blob) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'customer-matrix.csv';
      a.click();
      URL.revokeObjectURL(a.href);
    })
    .catch(function(e) { alert(e.message); });
}

let searchTimer;
document.getElementById('searchInput').addEventListener('input', function() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(function() { loadMatrix(1).catch(function(e) { alert(e.message); }); }, 300);
});
document.getElementById('ownershipFilter').addEventListener('change', function() { loadMatrix(1).catch(function(e) { alert(e.message); }); });
document.getElementById('includeEmptyStudents').addEventListener('change', function() { loadMatrix(1).catch(function(e) { alert(e.message); }); });
document.getElementById('exportBtn').addEventListener('click', exportCSV);
loadMatrix(1).catch(function(e) { alert(e.message); });
