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
  tag:       '<path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
  inbox:     '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
};

const NAVS = {
  teacher: [
    { section: 'Overview' },
    { href: '/teacher/',                    icon: 'dashboard', label: 'Dashboard' },
    { section: 'Class' },
    { href: '/teacher/students.html',       icon: 'students',  label: 'Students' },
    { href: '/teacher/progress.html',       icon: 'chart',     label: 'Progress' },
    { href: '/teacher/results.html',        icon: 'award',     label: 'Test results' },
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
  // A student has one place to work from: their course. The units, the
  // handouts on each lesson and the papers set on them are all on that
  // page — which is why there is no Lessons tab, no Tests tab, and no
  // dashboard in front of it. Those pages all send you here.
  student: [
    { section: 'Learn' },
    { href: '/portal/courses.html',         icon: 'courses',   label: 'My courses' },
    { section: 'Work' },
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
    { href: '/admin/plans.html',            icon: 'tag',       label: 'Plans & pricing' },
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

  // Lumi rides along on every student page, not just the dashboard: a
  // page that will not load is exactly the page they are stuck on.
  if (which === 'student') mountHelper(profile);
}

// ─────────────────────────────────────────────────────────────────
// Lumi — the Lumen character
//
// A student who cannot open a PDF, or whose test will not load, has
// nowhere to say so. They will not email, and they should not have to
// find their teacher's phone number to report that a page is broken. So
// there is a face in the corner, and what they type goes through
// POST /api/support — on to Lumen's inbox, and into support_requests
// as well when that table is there.
// ─────────────────────────────────────────────────────────────────

// The lamp from the logo, given eyes. The "u" is its body and the bar
// under it is the base it stands on, so the character and the mark in
// the browser tab are recognisably the same thing.
const LUMI_SVG = `
<svg viewBox="0 0 64 64" aria-hidden="true" class="lumi-face">
  <defs>
    <linearGradient id="lumi-body" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#C77BC4"/><stop offset="1" stop-color="#8B3F89"/>
    </linearGradient>
  </defs>
  <g class="lumi-rays" stroke="currentColor" stroke-width="3" stroke-linecap="round" opacity=".5">
    <line x1="32" y1="2" x2="32" y2="7"/>
    <line x1="11" y1="9" x2="14.5" y2="12.5"/>
    <line x1="53" y1="9" x2="49.5" y2="12.5"/>
  </g>
  <rect x="11" y="12" width="42" height="36" rx="15" fill="url(#lumi-body)"/>
  <g class="lumi-eyes">
    <circle cx="24" cy="28" r="4.2" fill="#fff"/><circle cx="40" cy="28" r="4.2" fill="#fff"/>
    <circle cx="24.9" cy="29" r="1.9" fill="#3A1F39"/><circle cx="40.9" cy="29" r="1.9" fill="#3A1F39"/>
  </g>
  <path d="M25.5 37.5q6.5 5.5 13 0" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/>
  <rect x="29" y="46" width="6" height="7" fill="currentColor"/>
  <rect x="18" y="52" width="28" height="7" rx="3.5" fill="currentColor"/>
</svg>`;

const HELP_KINDS = [
  ['technical', 'Something is broken'],
  ['course',    'A question about my course'],
  ['other',     'Something else'],
];

function mountHelper(profile) {
  if (document.getElementById('lumi')) return;   // pages re-render; Lumi does not

  const host = document.createElement('div');
  host.id = 'lumi';
  host.innerHTML = `
    <button class="lumi-btn" type="button" onclick="toggleHelp()" aria-label="Ask for help">
      ${LUMI_SVG}
      <span class="lumi-bubble">Need a hand?</span>
    </button>
    <div class="lumi-panel" id="lumi-panel" role="dialog" aria-label="Ask for help">
      <div class="lumi-head">
        <div>
          <div class="lumi-name">Hi, I'm Lumi</div>
          <div class="lumi-sub">Tell us what is wrong and we will look into it.</div>
        </div>
        <button class="modal-close" type="button" onclick="toggleHelp(false)" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="lumi-body">
        <div class="alert alert-error" id="lumi-alert" style="display:none;margin-bottom:12px"></div>
        <div class="form-group">
          <label class="form-label" for="lumi-name">Your name</label>
          <input type="text" class="form-input" id="lumi-name" value="${escHtml(profile.full_name || '')}">
        </div>
        <div class="form-group">
          <label class="form-label" for="lumi-kind">What is it about?</label>
          <select class="form-select" id="lumi-kind">
            ${HELP_KINDS.map(([v, label]) => `<option value="${v}">${escHtml(label)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group" style="margin-bottom:0">
          <label class="form-label" for="lumi-msg">What happened?</label>
          <textarea class="form-textarea" id="lumi-msg" style="min-height:92px"
            placeholder="The PDF on lesson 3 will not open on my phone."></textarea>
        </div>
      </div>
      <div class="lumi-foot">
        <button class="btn btn-primary btn-sm" id="lumi-send" type="button" onclick="sendHelp()">Send to my teacher</button>
      </div>
    </div>`;
  document.body.appendChild(host);
  window.__lumiProfile = profile;
}

function toggleHelp(force) {
  const panel = document.getElementById('lumi-panel');
  if (!panel) return;
  const open = force === undefined ? !panel.classList.contains('open') : force;
  panel.classList.toggle('open', open);
  if (open) document.getElementById('lumi-msg').focus();
}

async function sendHelp() {
  const name = document.getElementById('lumi-name').value.trim();
  const message = document.getElementById('lumi-msg').value.trim();
  const alert = document.getElementById('lumi-alert');

  const say = (msg) => { alert.textContent = msg; alert.style.display = msg ? 'flex' : 'none'; };
  if (!name) { say('Put your name in so your teacher knows who asked.'); return; }
  if (message.length < 5) { say('Tell us a little about what went wrong.'); return; }

  const btn = document.getElementById('lumi-send');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  say('');

  // Through the API rather than straight at the table: the server sends
  // it on as an email, which is what makes it arrive in something
  // somebody already watches, and files the row as well when it can.
  try {
    await apiPost('/api/support', {
      name,
      message,
      kind: document.getElementById('lumi-kind').value,
    });
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Send to my teacher';
    say(err.message);
    return;
  }

  btn.disabled = false;
  btn.textContent = 'Send to my teacher';

  // The panel becomes the receipt rather than closing on them — a form
  // that empties itself and vanishes leaves a child wondering whether
  // anything happened at all.
  document.querySelector('.lumi-body').innerHTML = `
    <div style="text-align:center;padding:14px 6px">
      <div style="font-weight:700;font-size:.92rem;margin-bottom:6px">Sent</div>
      <p class="small muted">Your message is on its way to Lumen. You can close this now.</p>
    </div>`;
  document.querySelector('.lumi-foot').innerHTML =
    '<button class="btn btn-ghost btn-sm" type="button" onclick="toggleHelp(false)">Close</button>';
}

function sidebarHtml(which, profile) {
  const items = (NAVS[which] || []).filter(i => !(i.teacherOnly && profile.role === 'assistant'));

  // The supplied logo wherever there is room for it. The rail collapses
  // to 74px on desktop, where there is not — so the "u" alone stands in
  // there, the same mark as the browser tab.
  const subtitle = which === 'admin'
    ? '<span class="brand-sub">Console</span>'
    : '<span class="brand-sub" data-tenant-name></span>';

  const nav = items.map(i => i.section
    ? `<div class="nav-section">${escHtml(i.section)}</div>`
    : `<a href="${i.href}" class="nav-item">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">${ICON[i.icon] || ''}</svg>${escHtml(i.label)}
       </a>`).join('');

  return `
    <a class="sidebar-brand" href="${which === 'admin' ? '/admin/' : which === 'teacher' ? '/teacher/' : '/portal/courses.html'}" aria-label="Lumen">
      <span class="b-mark" aria-hidden="true"><svg viewBox="0 0 64 64" fill="none">
        <path d="M17 7v24a15 15 0 0 0 30 0V7" stroke="currentColor" stroke-width="9" stroke-linecap="round"/>
        <rect x="12" y="53" width="40" height="8" rx="4" fill="currentColor"/>
      </svg></span>
      <span class="b-full">
        <img src="/assets/lumen-logo.png" alt="Lumen" class="logo-side on-light">
        <img src="/assets/lumen-logo-light.png" alt="" class="logo-side on-dark">
        ${subtitle}
      </span>
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
