// ─────────────────────────────────────────────────────────────────
// Lumen — the app shell
//
// The sidebar and topbar are identical on every page of a portal, and a
// menu copied into eleven files is a menu that is wrong in three of them.
// Each page carries an empty <aside class="sidebar"> and calls
// renderShell(); this fills it.
// ─────────────────────────────────────────────────────────────────

const ICON = {
  dashboard: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9,22 9,12 15,12 15,22"/>',
  students:  '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  courses:   '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  bank:      '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  tests:     '<path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><line x1="9" y1="12" x2="15" y2="12"/>',
  tasks:     '<polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/>',
  chart:     '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
  bell:      '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  team:      '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/>',
  card:      '<rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/>',
  cog:       '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6 1.65 1.65 0 0 0 10 3.09V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  play:      '<polygon points="5 3 19 12 5 21 5 3"/>',
  award:     '<circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/>',
  building:  '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="14" y1="8" x2="17" y2="8"/><line x1="14" y1="12" x2="17" y2="12"/>',
  inbox:     '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
};

const NAVS = {
  teacher: [
    { section: 'Overview' },
    { href: '/teacher/',                    icon: 'dashboard', label: 'Dashboard' },
    { section: 'Class' },
    { href: '/teacher/students.html',       icon: 'students',  label: 'Students' },
    { href: '/teacher/progress.html',       icon: 'chart',     label: 'Progress' },
    { section: 'Content' },
    { href: '/teacher/courses.html',        icon: 'courses',   label: 'Courses & lessons' },
    { href: '/teacher/question-bank.html',  icon: 'bank',      label: 'Question bank' },
    { href: '/teacher/tests.html',          icon: 'tests',     label: 'Tests' },
    { href: '/teacher/assignments.html',    icon: 'tasks',     label: 'Assignments' },
    { href: '/teacher/announcements.html',  icon: 'bell',      label: 'Announcements' },
    { section: 'Your space' },
    { href: '/teacher/team.html',           icon: 'team',      label: 'Assistants', teacherOnly: true },
    { href: '/teacher/subscription.html',   icon: 'card',      label: 'Subscription', teacherOnly: true },
    { href: '/teacher/settings.html',       icon: 'cog',       label: 'Settings' },
  ],
  student: [
    { section: 'Learn' },
    { href: '/portal/',                     icon: 'dashboard', label: 'Dashboard' },
    { href: '/portal/courses.html',         icon: 'courses',   label: 'My courses' },
    { href: '/portal/lessons.html',         icon: 'play',      label: 'Lessons' },
    { section: 'Work' },
    { href: '/portal/tests.html',           icon: 'tests',     label: 'Tests' },
    { href: '/portal/assignments.html',     icon: 'tasks',     label: 'Assignments' },
    { href: '/portal/scores.html',          icon: 'award',     label: 'My scores' },
    { section: 'More' },
    { href: '/portal/announcements.html',   icon: 'bell',      label: 'Announcements' },
    { href: '/portal/settings.html',        icon: 'cog',       label: 'Settings' },
  ],
  admin: [
    { section: 'Lumen' },
    { href: '/admin/',                      icon: 'dashboard', label: 'Overview' },
    { href: '/admin/teachers.html',         icon: 'building',  label: 'Teacher spaces' },
    { href: '/admin/billing.html',          icon: 'card',      label: 'Billing' },
    { href: '/admin/leads.html',            icon: 'inbox',     label: 'Leads' },
  ],
};

// `which` is 'teacher' | 'student' | 'admin'; `profile` is what
// requireAuth returned, so the menu can leave out what this person may
// not use.
function renderShell(which, profile, { title } = {}) {
  const aside = document.getElementById('sidebar');
  if (aside) aside.innerHTML = sidebarHtml(which, profile);

  const titleEl = document.querySelector('.page-title');
  if (titleEl && title) titleEl.textContent = title;

  // The tenant name goes in the sidebar brand for teachers and students —
  // a student should see whose space they are in, not a product name.
  paintIdentity(profile);
  markActiveNav();
}

function sidebarHtml(which, profile) {
  const items = (NAVS[which] || []).filter(i => !(i.teacherOnly && profile.role === 'assistant'));

  const brandLabel = which === 'admin'
    ? '<span style="font-size:.7rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)">Console</span>'
    : `<span data-tenant-name style="font-size:.78rem;font-weight:600;color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Lumen</span>`;

  const nav = items.map(i => i.section
    ? `<div class="nav-section">${escHtml(i.section)}</div>`
    : `<a href="${i.href}" class="nav-item">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">${ICON[i.icon] || ''}</svg>${escHtml(i.label)}
       </a>`).join('');

  return `
    <a class="sidebar-brand" href="${which === 'admin' ? '/admin/' : which === 'teacher' ? '/teacher/' : '/portal/'}">
      <span class="b-dot"><svg viewBox="0 0 64 64" fill="none" aria-hidden="true">
        <path d="M17 7v24a15 15 0 0 0 30 0V7" stroke="currentColor" stroke-width="9" stroke-linecap="round"/>
        <rect x="12" y="53" width="40" height="8" rx="4" fill="currentColor"/>
      </svg></span>
      ${brandLabel}
    </a>
    <div class="sidebar-scroll">${nav}</div>
    <div class="sidebar-foot">
      <div class="user-row">
        <div class="user-avatar" data-me-initials>?</div>
        <div class="user-info">
          <div class="user-name" data-me-name>—</div>
          <div class="user-role" data-me-role>—</div>
        </div>
        <button class="logout-btn" type="button" onclick="signOut()" title="Sign out" aria-label="Sign out">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        </button>
      </div>
    </div>`;
}

// ── Small rendering helpers the pages share ───────────────────────

// A table body that says something useful when there is nothing in it,
// instead of collapsing to a 1px line.
function emptyRow(colspan, text) {
  return `<tr><td colspan="${colspan}" style="text-align:center;color:var(--muted);font-size:.82rem;padding:30px 18px">${escHtml(text)}</td></tr>`;
}

function skeletonRows(colspan, rows = 3) {
  return Array.from({ length: rows }, (_, i) =>
    `<tr><td colspan="${colspan}"><div class="skel" style="height:14px;width:${80 - i * 8}%"></div></td></tr>`).join('');
}

function emptyState(title, body, action) {
  return `<div class="empty-state">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
    <h3>${escHtml(title)}</h3>
    <p>${escHtml(body)}</p>
    ${action || ''}
  </div>`;
}

// A number that has not arrived yet reads as an em dash, never as 0 —
// "0 students" and "we haven't counted yet" are different facts.
function setStat(id, value, suffix = '') {
  const el = document.getElementById(id);
  if (el) el.textContent = value == null ? '—' : value + suffix;
}
