initAdminPage();
const COURSE_LABEL = {
  'course-1': 'Course 1',
  'course-2': 'Course 2',
  'course-bundle': 'Bundle'
};

async function loadStudents() {
  const search = document.getElementById('searchInput').value;
  const courseId = document.getElementById('courseFilter').value;
  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (courseId) params.set('courseId', courseId);

  try {
    const data = await api(`/students?${params}`);
    const tb = document.getElementById('studentsTable');
    if (!data.students.length) {
      tb.innerHTML = '<tr><td colspan="7" class="empty">No students yet</td></tr>';
      return;
    }
    tb.innerHTML = data.students.map(s => {
      const courseChips = (s.courseIds || []).map(id => `<span class="course-chip">${escapeHtml(COURSE_LABEL[id] || id)}</span>`).join('');
      const total = s.startedCount || 0;
      const done = s.completedCount || 0;
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      const lastActive = s.lastActiveAt ? formatDateTime(s.lastActiveAt) : '—';
      const unread = s.unreadThreadCount > 0 ? `<span class="unread-badge">${s.unreadThreadCount}</span>` : '';
      const threads = s.threadCount > 0 ? `${s.threadCount} ${unread}` : '—';
      return `<tr>
        <td><div style="font-weight:500">${escapeHtml(s.name || s.email)}</div>${s.name ? `<div style="font-size:0.8rem;color:var(--text-light)">${escapeHtml(s.email)}</div>` : ''}</td>
        <td>${courseChips || '—'}</td>
        <td>
          <div style="display:flex;align-items:center;gap:10px;">
            <div class="progress-bar"><div class="progress-bar-fill" style="width:${pct}%"></div></div>
            <span style="font-size:0.82rem;color:var(--text-light);white-space:nowrap">${done}/${total || '?'} (${pct}%)</span>
          </div>
        </td>
        <td>${lastActive}</td>
        <td>${formatDate(s.lastPurchasedAt)}</td>
        <td>${threads}</td>
        <td>${s.customerId ? `<a class="btn btn-sm" href="/admin/customers.html#/c/${encodeURIComponent(s.customerId)}">Customer</a>` : '—'}</td>
      </tr>`;
    }).join('');
  } catch (e) { console.error(e); }
}

async function showDetail(token) {
  try {
    const data = await api(`/students/${token}`);
    document.getElementById('detailName').textContent = data.student.name || data.student.email;
    const el = document.getElementById('detailCourses');
    el.innerHTML = data.courses.map(course => {
      const pct = course.totalLessons > 0 ? Math.round((course.completedCount / course.totalLessons) * 100) : 0;
      const lessons = course.lessons.map(lesson => {
        if (lesson.type === 'pdf' || lesson.type === 'ending') return '';
        const status = lesson.completed ? 'completed' : (lesson.lastWatchedAt ? 'in-progress' : 'unstarted');
        const icon = lesson.completed ? '✓' : (lesson.lastWatchedAt ? '▶' : '');
        const posLabel = lesson.completed ? 'Completed' :
          lesson.lastWatchedAt ? `Stopped at ${formatSeconds(lesson.position)}${lesson.duration ? ' / ' + formatSeconds(lesson.duration) : ''}` :
          'Not started';
        const watched = lesson.lastWatchedAt ? formatDateTime(lesson.lastWatchedAt) : '';
        return `<div class="lesson-row">
          <div class="lesson-status ${status}">${icon}</div>
          <div class="lesson-meta">
            <div style="font-size:0.9rem;font-weight:500">${escapeHtml(lesson.title)}</div>
            <div class="lesson-time">${posLabel}${watched ? ` · ${watched}` : ''}</div>
          </div>
        </div>`;
      }).join('');
      return `<div class="card" style="margin-bottom:20px">
        <div class="card-header">
          <h3>${escapeHtml(course.courseName)}</h3>
          <div style="display:flex;align-items:center;gap:12px;">
            <div class="progress-bar" style="width:160px;"><div class="progress-bar-fill" style="width:${pct}%"></div></div>
            <span style="font-size:0.85rem;color:var(--text-light)">${course.completedCount}/${course.totalLessons} (${pct}%)</span>
          </div>
        </div>
        <div class="card-body">${lessons || '<p class="empty">No progress yet</p>'}</div>
      </div>`;
    }).join('');
    document.getElementById('listView').style.display = 'none';
    document.getElementById('detailView').classList.add('active');
  } catch (e) { alert(e.message); }
}

function showList() {
  document.getElementById('detailView').classList.remove('active');
  document.getElementById('listView').style.display = '';
}

function formatSeconds(s) {
  s = Math.floor(Number(s) || 0);
  const mins = Math.floor(s / 60);
  const secs = (s % 60).toString().padStart(2, '0');
  return `${mins}:${secs}`;
}

let searchTimer;
document.getElementById('searchInput').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadStudents, 300);
});
document.getElementById('courseFilter').addEventListener('change', loadStudents);

loadStudents();

document.getElementById('backBtn').addEventListener('click', showList);
