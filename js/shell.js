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
  chat:      '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  inbox:     '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
};

const NAVS = {
  teacher: [
    { section: 'Overview' },
    { href: '/teacher/',                    icon: 'dashboard', label: 'Dashboard' },
    { section: 'Class' },
    { href: '/teacher/students.html',       icon: 'students',  label: 'Students' },
    { href: '/teacher/messages.html',       icon: 'chat',      label: 'Messages' },
    { href: '/teacher/progress.html',       icon: 'chart',     label: 'Progress' },
    { href: '/teacher/results.html',        icon: 'award',     label: 'Test results' },
    { href: '/teacher/marks.html',          icon: 'tests',     label: 'In-class marks' },
    { section: 'Content' },
    { href: '/teacher/courses.html',        icon: 'courses',   label: 'Courses & lessons' },
    { href: '/teacher/question-bank.html',  icon: 'bank',      label: 'Question bank' },
    { href: '/teacher/tests.html',          icon: 'tests',     label: 'Tests' },
    { href: '/teacher/assignments.html',    icon: 'tasks',     label: 'Assignments' },
    { href: '/teacher/announcements.html',  icon: 'bell',      label: 'Announcements' },
    { href: '/portal/courses.html?preview=1', icon: 'students', label: 'View as student' },
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
    { href: '/portal/messages.html',        icon: 'chat',      label: 'Messages' },
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
  if (which === 'student' && !profile.preview) mountHelper(profile);
  if (profile.preview) mountPreviewBanner();
  // The bell, the unread count on Messages, and phone pop-ups.
  if (which !== 'admin' && !profile.preview) mountBell(which, profile);
}

// The strip across the top of every student page a teacher is
// previewing: what they are looking at, that nothing is saved, and the
// way back.
function mountPreviewBanner() {
  if (document.getElementById('preview-banner')) return;
  const bar = document.createElement('div');
  bar.id = 'preview-banner';
  bar.className = 'no-print';
  bar.style.cssText = 'position:sticky;top:0;z-index:300;display:flex;align-items:center;justify-content:center;gap:12px;'
    + 'flex-wrap:wrap;padding:9px 16px;background:#1B1519;color:#fff;font-size:.82rem;font-weight:600;text-align:center';
  bar.innerHTML = '<span>Student view — this is what your students see. Nothing you do here is saved.</span>'
    + '<button type="button" style="border:0;border-radius:9999px;padding:6px 14px;background:#fff;color:#1B1519;font:inherit;font-weight:800;cursor:pointer">Exit student view</button>';
  bar.querySelector('button').onclick = () => {
    try { sessionStorage.removeItem('lumen_preview'); } catch (_) {}
    location.href = '/teacher/';
  };
  const main = document.querySelector('.main') || document.body;
  main.insertBefore(bar, main.firstChild);
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
  const items = (NAVS[which] || []).filter(i => !(i.teacherOnly && profile.role === 'assistant'))
    // In student view the student's own settings are not the teacher's to
    // open: they are the teacher's settings underneath.
    .filter(i => !(profile.preview && ['/portal/settings.html', '/portal/messages.html'].includes(i.href)));

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

// ─────────────────────────────────────────────────────────────────
// The bell, Messages, and phone pop-ups
//
// The bell is built from what is already in the database — tests,
// lessons, announcements, deadlines, messages — read under the same
// row-level security as every other page, so a student is only ever told
// about what they can open. `profiles.notif_seen_at` is when they last
// opened it; anything newer counts towards the red dot.
//
// Every query here is allowed to fail on its own. A space that has not
// run migration v17 has no messages table and no lesson dates, and the
// rest of the bell still works without them.
// ─────────────────────────────────────────────────────────────────

const BELL = { which: null, me: null, items: [], unread: 0, open: false, timer: null };
const DAY_MS = 864e5;

function mountBell(which, profile) {
  if (document.getElementById('bell-btn') || !window.sb) return;
  const bar = document.querySelector('.topbar');
  if (!bar) return;
  BELL.which = which; BELL.me = profile;
  bellStyles();

  let right = bar.querySelector('.topbar-right');
  if (!right) { right = document.createElement('div'); right.className = 'topbar-right'; bar.appendChild(right); }
  const btn = document.createElement('button');
  btn.id = 'bell-btn'; btn.type = 'button'; btn.className = 'bell-btn'; btn.setAttribute('aria-label', 'Notifications');
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${ICON.bell}</svg><span class="bell-dot" hidden></span>`;
  btn.onclick = (e) => { e.stopPropagation(); toggleBell(); };
  right.insertBefore(btn, right.firstChild);

  const panel = document.createElement('div');
  panel.id = 'bell-panel'; panel.className = 'bell-panel'; panel.hidden = true;
  panel.onclick = (e) => e.stopPropagation();
  document.body.appendChild(panel);
  document.addEventListener('click', () => { if (BELL.open) toggleBell(false); });

  refreshBell();
  BELL.timer = setInterval(() => { if (!document.hidden) refreshBell(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshBell(); });
  listenForMessages();
  ensurePush(false);
}

function bellStyles() {
  if (document.getElementById('bell-css')) return;
  const st = document.createElement('style');
  st.id = 'bell-css';
  st.textContent = `
  .bell-btn { position: relative; width: 38px; height: 38px; border-radius: 12px; border: 1px solid var(--border);
    background: var(--card); color: var(--text-2); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; }
  .bell-btn:hover { color: var(--primary); border-color: var(--primary-line); }
  .bell-btn svg { width: 18px; height: 18px; }
  .bell-dot { position: absolute; top: -5px; right: -5px; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px;
    background: var(--danger); color: #fff; font-size: .68rem; font-weight: 800; line-height: 18px; text-align: center; box-shadow: 0 0 0 2px var(--card); }
  .bell-panel { position: fixed; top: calc(var(--top) + 6px); right: 16px; width: min(380px, calc(100vw - 32px)); max-height: min(560px, calc(100vh - 100px));
    overflow: auto; background: var(--card); border: 1px solid var(--border); border-radius: 16px; box-shadow: var(--shadow-lg); z-index: 400; }
  .bell-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px 10px; font-weight: 800; }
  .bell-item { display: flex; gap: 12px; padding: 11px 16px; text-decoration: none; color: var(--text); border-top: 1px solid var(--border); }
  .bell-item:hover { background: var(--bg); }
  .bell-item.new { background: var(--primary-soft); }
  .bell-ico { width: 34px; height: 34px; border-radius: 10px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; font-size: 1rem; background: var(--bg); }
  .bell-t { font-size: .84rem; font-weight: 700; line-height: 1.35; }
  .bell-s { font-size: .76rem; color: var(--muted); margin-top: 2px; line-height: 1.35; }
  .bell-empty { padding: 26px 16px 30px; text-align: center; color: var(--muted); font-size: .84rem; border-top: 1px solid var(--border); }
  .bell-foot { padding: 12px 16px 14px; border-top: 1px solid var(--border); font-size: .78rem; color: var(--muted); }
  .bell-foot button { margin-top: 2px; }
  .nav-count { margin-left: auto; min-width: 20px; height: 20px; padding: 0 6px; border-radius: 10px; background: var(--danger); color: #fff;
    font-size: .7rem; font-weight: 800; line-height: 20px; text-align: center; }
  .nav-item { position: relative; }
  @media (min-width: 901px) { .sidebar:not(:hover) .nav-count { position: absolute; top: 4px; left: 30px; min-width: 16px; height: 16px; line-height: 16px; padding: 0 4px; font-size: .62rem; } }
  `;
  document.head.appendChild(st);
}

async function refreshBell() {
  try {
    const items = BELL.which === 'student' ? await studentFeed(BELL.me) : await staffFeed(BELL.me);
    const seen = BELL.me.notif_seen_at ? new Date(BELL.me.notif_seen_at).getTime() : 0;
    items.forEach(i => { i.isNew = i.at > seen; });
    items.sort((a, b) => (b.isNew - a.isNew) || (b.at - a.at));
    BELL.items = items.slice(0, 30);
    const dot = document.querySelector('#bell-btn .bell-dot');
    const n = BELL.items.filter(i => i.isNew).length;
    if (dot) { dot.hidden = !n; dot.textContent = n > 9 ? '9+' : String(n); }
    setMessagesCount(BELL.unread);
    if (BELL.open) drawBell();
  } catch (err) { console.warn('bell:', err); }
}

// Each query on its own: a missing table answers with an error, and an
// error here means "nothing to say", not "the bell is broken".
async function q(promise) {
  try { const { data, error } = await promise; return error ? [] : (data || []); } catch (_) { return []; }
}

async function studentFeed(me) {
  const now = Date.now();
  const since = new Date(now - 14 * DAY_MS).toISOString();
  const nowIso = new Date(now).toISOString();
  const in3 = new Date(now + 3 * DAY_MS).toISOString();
  let [ann, tests, lessons, due, hw, msgs, tried, handed] = await Promise.all([
    q(sb.from('announcements').select('id, title, body, priority, created_at').eq('is_active', true)
      .gte('created_at', since).order('created_at', { ascending: false }).limit(15)),
    q(sb.from('practice_tests').select('*')
      .order('created_at', { ascending: false }).limit(60)),
    q(sb.from('lessons').select('id, title, created_at, modules(id, title, released_at, open_at)').limit(800)),
    q(sb.from('test_assignments').select('test_id, due_at, practice_tests(title)').gte('due_at', nowIso).lte('due_at', in3)),
    q(sb.from('assignments').select('id, title, due_at').eq('is_active', true).gte('due_at', nowIso).lte('due_at', in3)),
    q(sb.from('messages').select('id, body, created_at').eq('from_staff', true).is('read_at', null)
      .order('created_at', { ascending: false }).limit(20)),
    q(sb.from('test_attempts').select('test_id').eq('student_id', me.id)),
    q(sb.from('assignment_submissions').select('assignment_id').eq('student_id', me.id)),
  ]);
  const done = new Set(tried.map(r => r.test_id));
  const handedIn = new Set(handed.map(r => r.assignment_id));
  const items = [];
  const t = (iso) => (iso ? new Date(iso).getTime() : 0);

  BELL.unread = msgs.length;
  if (msgs.length) {
    items.push({ ico: '💬', at: t(msgs[0].created_at), url: '/portal/messages.html',
      title: msgs.length === 1 ? 'New message from your teacher' : `${msgs.length} new messages from your teacher`,
      sub: msgs[0].body });
  }

  ann.forEach(a => items.push({ ico: a.priority === 'urgent' ? '📣' : '📌', at: t(a.created_at), url: '/portal/announcements.html',
    title: a.title, sub: a.body }));

  tests = tests.filter(x => !x.is_offline);
  tests.forEach(x => {
    const opened = x.open_at && t(x.open_at) > t(x.created_at) ? t(x.open_at) : t(x.created_at);
    if (opened > now || opened < now - 14 * DAY_MS) return;
    items.push({ ico: '📝', at: opened, url: '/portal/take-test.html?id=' + x.id,
      title: 'New test: ' + x.title, sub: done.has(x.id) ? 'Done ✓' : 'Tap to start it' });
  });

  // Lessons arrive a unit at a time, so they are told a unit at a time.
  const units = new Map();
  lessons.forEach(l => {
    const m = l.modules || {};
    const at = Math.max(t(l.created_at), t(m.released_at), m.open_at && t(m.open_at) <= now ? t(m.open_at) : 0);
    if (!at || at < now - 14 * DAY_MS || at > now) return;
    const u = units.get(m.id) || { title: m.title, at: 0, n: 0 };
    u.n++; u.at = Math.max(u.at, at);
    units.set(m.id, u);
  });
  units.forEach(u => items.push({ ico: '📚', at: u.at, url: '/portal/courses.html',
    title: u.n === 1 ? 'New lesson in ' + u.title : `${u.n} new lessons in ${u.title}`, sub: 'Open your course to start' }));

  // Deadlines in the next three days for work not yet done. They count as
  // "new" from three days before they fall due.
  due.forEach(d => { if (!done.has(d.test_id)) items.push({ ico: '⏰', at: t(d.due_at) - 3 * DAY_MS, url: '/portal/take-test.html?id=' + d.test_id,
    title: 'Due ' + dueText(d.due_at) + ': ' + (d.practice_tests?.title || 'a test'), sub: 'Not done yet' }); });
  tests.forEach(x => { if (x.close_at && t(x.close_at) > now && t(x.close_at) < now + 3 * DAY_MS && !done.has(x.id))
    items.push({ ico: '⏰', at: t(x.close_at) - 3 * DAY_MS, url: '/portal/take-test.html?id=' + x.id,
      title: 'Closes ' + dueText(x.close_at) + ': ' + x.title, sub: 'Not done yet' }); });
  hw.forEach(h => { if (!handedIn.has(h.id)) items.push({ ico: '⏰', at: t(h.due_at) - 3 * DAY_MS, url: '/portal/assignments.html',
    title: 'Homework due ' + dueText(h.due_at) + ': ' + h.title, sub: 'Not handed in yet' }); });

  return items;
}

async function staffFeed(me) {
  const since = new Date(Date.now() - 3 * DAY_MS).toISOString();
  const [msgs, results] = await Promise.all([
    q(sb.from('messages').select('student_id, body, created_at').eq('teacher_id', me.teacher_id)
      .eq('from_staff', false).is('read_at', null).order('created_at', { ascending: false }).limit(200)),
    q(sb.from('test_attempts').select('id, score, max_score, passed, completed_at, profiles(full_name), practice_tests(title)')
      .eq('teacher_id', me.teacher_id).gte('completed_at', since).order('completed_at', { ascending: false }).limit(25)),
  ]);
  const items = [];
  const byStudent = new Map();
  msgs.forEach(m => { if (!byStudent.has(m.student_id)) byStudent.set(m.student_id, []); byStudent.get(m.student_id).push(m); });
  BELL.unread = byStudent.size;
  if (byStudent.size) {
    const names = new Map((await q(sb.from('profiles').select('id, full_name').in('id', [...byStudent.keys()])))
      .map(p => [p.id, p.full_name]));
    byStudent.forEach((list, sid) => items.push({ ico: '💬', at: new Date(list[0].created_at).getTime(),
      url: '/teacher/messages.html?student=' + sid,
      title: (names.get(sid) || 'A student') + (list.length > 1 ? ` · ${list.length} messages` : ''), sub: list[0].body }));
  }
  results.forEach(r => items.push({ ico: r.passed ? '✅' : '📝', at: new Date(r.completed_at).getTime(), url: '/teacher/results.html',
    title: `${r.profiles?.full_name || 'A student'} finished ${r.practice_tests?.title || 'a test'}`,
    sub: `${marks(r.score, r.max_score)}${r.passed ? ' · passed' : ''}` }));
  return items;
}

function dueText(iso) {
  const d = new Date(iso), now = new Date();
  const days = Math.round((new Date(d.toDateString()) - new Date(now.toDateString())) / DAY_MS);
  const time = d.toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit' });
  if (days <= 0) return 'today ' + time;
  if (days === 1) return 'tomorrow ' + time;
  return d.toLocaleDateString('en-GB', { weekday: 'long' }) + ' ' + time;
}

function toggleBell(force) {
  BELL.open = force ?? !BELL.open;
  const panel = document.getElementById('bell-panel');
  panel.hidden = !BELL.open;
  if (!BELL.open) return;
  drawBell();
  // Opening the bell is reading it. The highlight stays on what was new
  // until it is closed; the red dot goes now.
  const at = new Date().toISOString();
  BELL.me.notif_seen_at = at;
  const dot = document.querySelector('#bell-btn .bell-dot');
  if (dot) dot.hidden = true;
  sb.from('profiles').update({ notif_seen_at: at }).eq('id', BELL.me.id).then(() => {}, () => {});
}

function drawBell() {
  const panel = document.getElementById('bell-panel');
  const list = BELL.items.length
    ? BELL.items.map(i => `<a class="bell-item ${i.isNew ? 'new' : ''}" href="${escHtml(i.url)}">
        <span class="bell-ico">${i.ico}</span>
        <span style="min-width:0"><div class="bell-t">${escHtml(i.title)}</div>
          ${i.sub ? `<div class="bell-s">${escHtml(String(i.sub).slice(0, 120))}</div>` : ''}
          <div class="bell-s">${i.at > Date.now() - 60000 * 60 * 24 * 365 ? timeAgo(new Date(Math.min(i.at, Date.now())).toISOString()) : ''}</div></span>
      </a>`).join('')
    : `<div class="bell-empty">You're all caught up.</div>`;
  panel.innerHTML = `<div class="bell-head"><span>Notifications</span>
      <a href="${BELL.which === 'student' ? '/portal/messages.html' : '/teacher/messages.html'}" class="small" style="font-weight:700">Messages</a></div>
    ${list}${pushFooter()}`;
  const b = panel.querySelector('[data-push-on]');
  if (b) b.onclick = () => ensurePush(true);
}

// ── Unread count on the Messages menu item ────────────────────────
function setMessagesCount(n) {
  const href = BELL.which === 'student' ? '/portal/messages.html' : '/teacher/messages.html';
  const a = document.querySelector(`.sidebar a.nav-item[href="${href}"]`);
  if (!a) return;
  let c = a.querySelector('.nav-count');
  if (!n) { if (c) c.remove(); return; }
  if (!c) { c = document.createElement('span'); c.className = 'nav-count'; a.appendChild(c); }
  c.textContent = n > 99 ? '99+' : String(n);
}

// A new message lands on any open page straight away, not on the next
// minute's refresh. The Messages pages listen for `lumen:message` too.
function listenForMessages() {
  try {
    const ch = sb.channel('lumen-messages-' + BELL.me.id);
    ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
      window.dispatchEvent(new CustomEvent('lumen:message', { detail: payload.new }));
      refreshBell();
    }).subscribe();
  } catch (_) { /* polling still covers it */ }
}

// ── Phone pop-ups ─────────────────────────────────────────────────
// Browser push: Chrome on Android (in the browser, or the app added to
// the home screen), desktop browsers, and iPhones with Lumen added to the
// home screen. The Android app downloaded from Lumen runs in a web view
// that has no push, so it is not offered there.
function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function pushFooter() {
  if (!pushSupported()) return '';
  if (Notification.permission === 'granted') return '';
  if (Notification.permission === 'denied') {
    return `<div class="bell-foot">Pop-ups are blocked for Lumen in this browser's settings.</div>`;
  }
  return `<div class="bell-foot">Get a pop-up on this device for messages, new tests and deadlines.<br>
    <button type="button" class="btn btn-primary btn-sm" data-push-on>Turn on pop-ups</button></div>`;
}

function b64ToBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

// `ask` is true when the person pressed the button. Otherwise this only
// renews a subscription they already said yes to — it never prompts.
async function ensurePush(ask) {
  if (!pushSupported()) return;
  try {
    if (Notification.permission !== 'granted') {
      if (!ask) return;
      const answer = await Notification.requestPermission();
      if (answer !== 'granted') { if (BELL.open) drawBell(); return; }
    }
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const { key } = await apiPost('/api/support', { flow: 'push', action: 'key' });
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
    }
    const j = sub.toJSON();
    await sb.from('push_subscriptions').upsert({
      user_id: BELL.me.id, teacher_id: BELL.me.teacher_id || null,
      endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth,
    }, { onConflict: 'endpoint' });
    if (ask) { showToast('Pop-ups are on for this device.', 'success'); if (BELL.open) drawBell(); }
  } catch (err) {
    console.warn('push:', err);
    if (ask) showToast('Could not turn on pop-ups on this device.', 'error');
  }
}

// After a message is saved, tell the other side's phones. Fire and forget.
function pushMessage(messageId) {
  apiPost('/api/support', { flow: 'push', action: 'message', message_id: messageId }).catch(() => {});
}
