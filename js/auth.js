// ─────────────────────────────────────────────────────────────────
// Lumen — session, tenant and page guard
//
// Loaded on every signed-in page, after js/config.js and js/ui.js:
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/…"></script>
//   <script src="/js/config.js"></script>
//   <script src="/js/ui.js"></script>
//   <script src="/js/auth.js"></script>
//
// Which tenant a signed-in user belongs to is decided by the database,
// from the `teacher_id` claim the API wrote into their token. Nothing in
// this file can widen that — it reads the same profile row the policies
// already constrain, and uses it to draw the right menu.
// ─────────────────────────────────────────────────────────────────

const SESSION_TIMEOUT_MS    = 12000;  // one session/profile read
const PAGE_GUARD_TIMEOUT_MS = 20000;  // the whole sign-in check
const LOCK_WAIT_MS          = 5000;   // waiting on another tab's token refresh

// ── The token-refresh lock ────────────────────────────────────────
// supabase-js guards token refresh with a cross-tab Web Lock so two tabs
// cannot rotate the same refresh token at once, and it waits for that lock
// forever. A tab that was closed or suspended mid-refresh can leave the
// lock held, and from then on every page hangs on its first await — no
// request in the network log, no error, just the skeleton. Wait a few
// seconds and then go ahead: a rare double refresh recovers on the next
// load, a permanent hang never does.
async function boundedLock(name, _acquireTimeout, fn) {
  if (typeof navigator === 'undefined' || !navigator.locks?.request) return await fn();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), LOCK_WAIT_MS);
  try {
    return await navigator.locks.request(name, { signal: ctl.signal }, async () => await fn());
  } catch (err) {
    if (err && err.name !== 'AbortError') throw err;
    return await fn();
  } finally {
    clearTimeout(timer);
  }
}

// The SDK comes from a CDN in the <script> before this file. When that
// request is blocked, `supabase` is undefined, this file dies on its first
// statement, and every function it defines — requireAuth among them — is
// never created, leaving the page on a skeleton with nothing to explain
// why. Notice that, and say it.
const SDK_READY = typeof supabase !== 'undefined' && typeof supabase.createClient === 'function';
const CFG = window.LUMEN_CONFIG || {};
const CONFIGURED = SDK_READY && /^https:\/\/[a-z0-9-]+\.supabase\.co/.test(CFG.SUPABASE_URL || '');

const sb = CONFIGURED ? supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, lock: boundedLock },
}) : null;

if (!SDK_READY) {
  onBodyReady(() => showOutageScreen(CONNECTION_FAILED_MESSAGE));
} else if (!CONFIGURED) {
  onBodyReady(() => showOutageScreen(
    'Lumen has not been connected to a Supabase project yet. Fill in js/config.js with your project URL and anon key — see the README.'));
}

// Give up on a promise that is taking too long, so a stalled request
// surfaces as a message instead of an endless wait.
function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out waiting for ' + what)), ms); }),
  ]);
}

// ── Which page are we on? ─────────────────────────────────────────
// The host may or may not serve the ".html" — Vercel's cleanUrls turns
// /teacher/settings.html into /teacher/settings — so no path test here
// may depend on the extension being present. Getting this wrong once
// cost a redirect loop on every teacher's first sign-in: the guard sent
// them to settings.html, the host rewrote it, the guard did not
// recognise the page it had just chosen, and round it went.
function isPage(name) {
  return new RegExp(`/${name}(\\.html)?$`).test(location.pathname);
}

// ── Where each role belongs ───────────────────────────────────────
const HOME_FOR = {
  owner:     '/admin/',
  teacher:   '/teacher/',
  assistant: '/teacher/',
  // Their courses, not a dashboard: everything a student does is on
  // that one page, so it is the page they land on.
  student:   '/portal/courses.html',
};
function homeFor(role) { return HOME_FOR[role] || '/login.html'; }

// ── Core session helpers ──────────────────────────────────────────

async function getSession() {
  const { data: { session } } = await withTimeout(sb.auth.getSession(), SESSION_TIMEOUT_MS, 'the session');
  if (session) return session;
  // Nothing in this browser. That can be a real sign-out, or Safari having
  // wiped the site's storage after a week away — so ask the server for the
  // copy it keeps before sending anybody to the sign-in page.
  return await restoreKeptSession();
}

// ── The kept sign-in ──────────────────────────────────────────────
// See api/_lib/session.js. The refresh token is copied to a cookie the server
// sets, which Safari's seven-day clean-out does not touch, and copied
// again each time it rotates. Every call here is best-effort: failing to
// keep a copy costs nothing until the day it would have been needed.
let restoreTried = false;

async function restoreKeptSession() {
  if (restoreTried || !sb) return null;
  restoreTried = true;
  try {
    const resp = await withTimeout(fetch('/api/join', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Lumen': '1' },
      body: JSON.stringify({ flow: 'session', action: 'restore' }),
    }), SESSION_TIMEOUT_MS, 'your saved sign-in');
    const data = await resp.json().catch(() => ({}));
    if (!data.restored) return null;
    const { data: set } = await sb.auth.setSession({
      access_token: data.access_token, refresh_token: data.refresh_token,
    });
    return set?.session || null;
  } catch (_) { return null; }
}

let keptToken = null;
async function keepSession(session) {
  const rt = session?.refresh_token;
  if (!rt || rt === keptToken) return;
  // Once per token, not once per page: the same token is only sent again
  // after it has rotated. Remembered across pages in this tab.
  try { if (sessionStorage.getItem('lumen_kept') === rt.slice(-12)) { keptToken = rt; return; } } catch (_) {}
  keptToken = rt;
  try {
    const resp = await fetch('/api/join', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Lumen': '1', 'Authorization': 'Bearer ' + session.access_token },
      body: JSON.stringify({ flow: 'session', action: 'keep', refresh_token: rt }),
    });
    if (resp.ok) { try { sessionStorage.setItem('lumen_kept', rt.slice(-12)); } catch (_) {} }
    else keptToken = null;
  } catch (_) { keptToken = null; }
}

function forgetKeptSession() {
  keptToken = null;
  try { sessionStorage.removeItem('lumen_kept'); } catch (_) {}
  return fetch('/api/join', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Lumen': '1' },
    body: JSON.stringify({ flow: 'session', action: 'forget' }),
    keepalive: true,
  }).catch(() => {});
}

if (sb) {
  sb.auth.onAuthStateChange((event, session) => {
    if (session && (event === 'INITIAL_SESSION' || event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED')) {
      // Off the auth callback's own turn: supabase-js warns against
      // awaiting other work inside it.
      setTimeout(() => keepSession(session), 0);
    } else if (event === 'SIGNED_OUT') {
      forgetKeptSession();
    }
  });
}

// A test sits open far longer than an access token lasts. autoRefreshToken
// renews it in the background, but a tab that was hidden or beaten to the
// refresh by another tab can come back holding no session at all —
// supabase-js drops one it could not renew rather than keep it. The next
// write then goes out as the anonymous role, auth.uid() is NULL, and
// Postgres refuses it. Call this before any write that must not be lost.
async function ensureFreshSession() {
  let session = null;
  try { session = await getSession(); } catch (_) { session = null; }
  const msLeft = session?.expires_at ? session.expires_at * 1000 - Date.now() : 0;
  if (session && msLeft > 120000) return session;
  try {
    const { data } = await withTimeout(sb.auth.refreshSession(), SESSION_TIMEOUT_MS, 'your session');
    if (data?.session) return data.session;
  } catch (_) { /* fall through to whatever we still hold */ }
  return msLeft > 0 ? session : null;
}

// Why the last profile lookup came back empty. "No such profile" and "the
// database is unreachable" both surface as null and call for opposite
// responses: sign the person out, or leave them alone until it returns.
let lastProfileError = null;

async function getProfile(uid) {
  const id = uid ?? (await getSession())?.user?.id;
  if (!id) return null;
  let data = null, error = null;
  try {
    ({ data, error } = await withTimeout(
      sb.from('profiles').select('*').eq('id', id).single(), SESSION_TIMEOUT_MS, 'your profile'));
  } catch (err) {
    error = { message: 'Failed to fetch: ' + (err?.message || err) };
  }
  lastProfileError = error || null;
  return data ?? null;
}

// The tenant this user works inside: the teacher's display name, brand
// colour and contact details. Null for Lumen's own staff, who belong to
// no tenant.
async function getTeacher(teacherId) {
  if (!teacherId) return null;
  const { data } = await sb.from('teachers').select('*').eq('id', teacherId).single();
  return data ?? null;
}

// ── Page guard ────────────────────────────────────────────────────
// Call at the top of every signed-in page:
//   const me = await requireAuth('teacher');           // one role
//   const me = await requireAuth(['teacher','assistant']);
//   const me = await requireAuth();                    // any signed-in user
// Returns the profile (with `.teacher` and `.email` attached) or null.
// On null the caller returns early — a redirect is already under way.
//
// Nothing below may hang the page or throw into nowhere. Whatever goes
// wrong, the reader ends up looking at a sentence and a "Try again"
// button rather than a skeleton that never resolves.
async function requireAuth(roles, opts) {
  if (!sb) { onBodyReady(() => showOutageScreen(CONNECTION_FAILED_MESSAGE)); return null; }
  try {
    return await withTimeout(guardPage(roles, opts || {}), PAGE_GUARD_TIMEOUT_MS, 'Lumen');
  } catch (err) {
    console.error('requireAuth failed:', err);
    showOutageScreen();
    return null;
  }
}

async function guardPage(roles, { perm } = {}) {
  const allowed = roles == null ? null : (Array.isArray(roles) ? roles : [roles]);

  const session = await getSession();
  if (!session) { location.replace('/login.html?next=' + encodeURIComponent(location.pathname)); return null; }

  const profile = await getProfile(session.user.id);
  if (!profile) {
    // Never sign someone out over an outage. Their account is fine; the
    // database just could not answer, and telling them to sign in again
    // lands them in exactly the window where signing in cannot work.
    if (lastProfileError && isServiceOutage(lastProfileError.message)) { showOutageScreen(); return null; }
    await sb.auth.signOut();
    location.replace('/login.html');
    return null;
  }

  if (!profile.is_active) {
    await sb.auth.signOut();
    location.replace('/login.html?e=inactive');
    return null;
  }

  try { localStorage.setItem('lumen_role', profile.role); } catch (_) {}

  // "View as student": a teacher or assistant opening a student page with
  // ?preview=1 sees it as their students do. The flag lasts for the tab,
  // so moving between student pages keeps the view, and leaving it is one
  // button in the banner. Nothing a preview does is saved — the pages that
  // write check `profile.preview` and stop.
  if (/[?&]preview=1\b/.test(location.search)) { try { sessionStorage.setItem('lumen_preview', '1'); } catch (_) {} }
  let previewFlag = false;
  try { previewFlag = sessionStorage.getItem('lumen_preview') === '1'; } catch (_) {}
  if (allowed && allowed.includes('student') && !allowed.includes(profile.role)
      && ['teacher', 'assistant'].includes(profile.role) && previewFlag) {
    profile.preview = true;
  } else if (allowed && !allowed.includes(profile.role)) { location.replace(homeFor(profile.role)); return null; }

  profile.email = session.user?.email || profile.email || '';
  profile.teacher = await getTeacher(profile.teacher_id);

  // A teacher whose tenant has been switched off keeps their account but
  // loses the portal, and is told why rather than bounced to a login page
  // that will let them straight back in.
  if (profile.teacher && !profile.teacher.is_active && profile.role !== 'owner') {
    onBodyReady(() => showOutageScreen(
      'This Lumen space is paused. Please contact Lumen to reactivate it — nothing has been deleted.'));
    return null;
  }

  // A first password is issued by whoever created the account, so it is
  // known to someone else until it is changed. Everything else waits.
  // Lumen's own staff have no settings page to be sent to — their
  // accounts are made by hand in Supabase, with a password of their own.
  //
  // The ".html" is optional in every path test in this file. Vercel's
  // cleanUrls redirects /teacher/settings.html to /teacher/settings, so
  // a check that insisted on the extension never matched the page it had
  // just sent the user to — and sent them again, and again.
  // Somebody who has never chosen a password gets one screen that asks
  // for one, rather than the settings page with a warning on it among
  // everything else settings does. Settings is still allowed through:
  // it is where somebody who wants to change a password they already
  // chose goes.
  if (profile.must_change_pw && profile.role !== 'owner'
      && !isPage('set-password') && !isPage('settings')) {
    location.replace('/set-password.html');
    return null;
  }

  if (profile.role === 'student') {
    // Before anything else on the page: work that could not be saved last
    // time now has a working session to go out on.
    try {
      const n = await flushPendingAttempts(profile.id);
      if (n) showToast(n === 1
        ? 'A test result that could not be saved earlier has now been saved.'
        : n + ' test results that could not be saved earlier have now been saved.', 'success');
    } catch (_) {}
    try { installContentGuard(profile); } catch (_) {}
    if (isPage('take-test')) { try { installWatermark(profile); } catch (_) {} }
  }

  if (profile.role === 'assistant') {
    // An assistant sees only the pages their teacher granted. Hiding the
    // link is presentation; this redirect is the gate.
    if (perm && !staffHasPerm(profile, perm)) { location.replace('/teacher/'); return null; }
    hideForbiddenNav(profile);
  }

  try { markActiveNav(); } catch (_) {}
  try { paintIdentity(profile); } catch (_) {}
  return profile;
}

// Fill the sidebar footer and any element tagged with a data-me-* hook,
// so no page has to repeat the same four lines.
function paintIdentity(profile) {
  const set = (sel, text) => document.querySelectorAll(sel).forEach(el => { el.textContent = text; });
  set('[data-me-name]', profile.full_name);
  set('[data-me-initials]', initials(profile.full_name));
  set('[data-me-role]', ROLE_LABEL[profile.role] || profile.role);
  set('[data-tenant-name]', profile.teacher?.display_name || 'Lumen');
}

const ROLE_LABEL = {
  owner: 'Lumen staff', teacher: 'Teacher', assistant: 'Assistant', student: 'Student',
};

// ── Assistant permissions ─────────────────────────────────────────
// A teacher has every permission on their own space. An assistant has
// only the keys in profiles.staff_perms.
const STAFF_PERMS = [
  'students', 'courses', 'questions', 'tests', 'assignments', 'announcements', 'reports',
];

// Which permission each management page needs. The dashboard, settings
// and the subscription page are not listed: the first two are always
// allowed, the third is teacher-only and guarded by its own requireAuth.
const STAFF_PAGE_PERM = {
  '/teacher/students.html':      'students',
  '/teacher/messages.html':      'students',
  '/teacher/progress.html':      'reports',
  '/teacher/courses.html':       'courses',
  '/teacher/question-bank.html': 'questions',
  '/teacher/tests.html':         'tests',
  '/teacher/marks.html':         'tests',
  '/teacher/assignments.html':   'assignments',
  '/teacher/announcements.html': 'announcements',
};

function staffHasPerm(profile, key) {
  if (!profile) return false;
  if (profile.role === 'teacher' || profile.role === 'owner') return true;
  if (profile.role !== 'assistant') return false;
  // An assistant row created before staff_perms existed has null here.
  // Never lock someone out of their own portal over a missing column.
  if (profile.staff_perms == null) return true;
  return Array.isArray(profile.staff_perms) && profile.staff_perms.includes(key);
}

function hideForbiddenNav(profile) {
  const scroll = document.querySelector('.sidebar .sidebar-scroll');
  if (!scroll) return;
  scroll.querySelectorAll('a.nav-item').forEach(a => {
    const need = STAFF_PAGE_PERM[a.getAttribute('href') || ''];
    if (need && !staffHasPerm(profile, need)) a.style.display = 'none';
  });
  // Section headers with nothing left under them.
  scroll.querySelectorAll('.nav-section').forEach(sec => {
    let n = sec.nextElementSibling, visible = false;
    while (n && !n.classList.contains('nav-section')) {
      if (n.classList.contains('nav-item') && n.style.display !== 'none') visible = true;
      n = n.nextElementSibling;
    }
    if (!visible) sec.style.display = 'none';
  });
}

// ── Work the database would not take ──────────────────────────────
// Last resort for a finished test the database refused. The work is real
// — the student did it — so it is kept on the device and re-sent on the
// next page load with a working session, rather than asked for again or
// lost. Nothing here throws: a browser with storage blocked must still be
// able to finish a test.
const PENDING_ATTEMPTS_KEY = 'lumen_pending_attempts';

function readPendingAttempts() {
  try {
    const list = JSON.parse(localStorage.getItem(PENDING_ATTEMPTS_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch (_) { return []; }
}

function writePendingAttempts(list) {
  try {
    if (!list.length) localStorage.removeItem(PENDING_ATTEMPTS_KEY);
    else localStorage.setItem(PENDING_ATTEMPTS_KEY, JSON.stringify(list.slice(-20)));
  } catch (_) {}
}

// Returns true only if the row really is on the device now — storage can
// be blocked or full, and that is the difference between telling a student
// their work is safe and telling them it is not.
function savePendingAttempt(row) {
  const list = readPendingAttempts();
  list.push(row);
  writePendingAttempts(list);
  const stored = readPendingAttempts();
  return stored.length > 0 && JSON.stringify(stored[stored.length - 1]) === JSON.stringify(row);
}

// Re-send anything this student left behind. Someone else's rows (a shared
// family computer) are left untouched for them to flush when they sign in.
async function flushPendingAttempts(studentId) {
  const list = readPendingAttempts();
  if (!list.length || !studentId) return 0;

  const mine  = list.filter(r => r && r.student_id === studentId);
  const stuck = list.filter(r => !r || r.student_id !== studentId);
  let saved = 0;

  for (const row of mine) {
    try {
      // A save that timed out may well have landed. Don't give the student
      // the same test twice in their history because of it.
      const { data: already } = await sb.from('test_attempts')
        .select('id')
        .eq('student_id', row.student_id)
        .eq('test_id', row.test_id)
        .eq('completed_at', row.completed_at)
        .limit(1);
      if (already?.length) { saved++; continue; }

      const { error } = await withTimeout(
        sb.from('test_attempts').insert(row), SESSION_TIMEOUT_MS, 'a saved result');
      if (error) { stuck.push(row); continue; }
      saved++;

      // A result that reached us late still reaches the parent. The
      // server refuses to send the same attempt twice, so asking here
      // as well as on the results page costs nothing.
      apiPost('/api/result-email', { test_id: row.test_id })
        .catch(err => console.warn('Result email not sent:', err.message));
    } catch (_) { stuck.push(row); }
  }

  writePendingAttempts(stuck);
  return saved;
}

// ── Watermark ─────────────────────────────────────────────────────
// Tiles the student's own name and email diagonally across a test page,
// light enough to read through, so a leaked screenshot is traceable.
function installWatermark(profile) {
  if (window.__wmInstalled) return;
  window.__wmInstalled = true;
  const xml = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const top = xml(profile?.full_name || profile?.email || 'Lumen');
  const sub = xml([profile?.email, profile?.phone].filter(Boolean).join('  ·  '));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="260">`
    + `<g transform="rotate(-27 250 130)" font-family="Inter, system-ui, sans-serif" fill="rgba(85,76,83,0.13)">`
    + `<text x="18" y="130" font-size="16" font-weight="700">${top}</text>`
    + (sub ? `<text x="18" y="150" font-size="13" font-weight="600">${sub}</text>` : '')
    + `</g></svg>`;

  onBodyReady(() => {
    if (document.getElementById('wm-layer')) return;
    const layer = document.createElement('div');
    layer.id = 'wm-layer';
    layer.setAttribute('aria-hidden', 'true');
    layer.style.cssText = 'position:fixed;inset:0;z-index:50;pointer-events:none;'
      + `background-image:url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}");background-repeat:repeat`;
    document.body.appendChild(layer);
  });
}

// ── Content guard ─────────────────────────────────────────────────
// Warns a student that the material is their teacher's, and records the
// attempt in the tenant's activity log for the teacher to review.
function installContentGuard(profile) {
  if (window.__guardInstalled) return;
  window.__guardInstalled = true;
  let lastWarn = 0;
  const lastLog = {};

  function warn() {
    const now = Date.now();
    if (now - lastWarn < 4000) return;
    lastWarn = now;
    let b = document.getElementById('guard-banner');
    if (!b) {
      b = document.createElement('div');
      b.id = 'guard-banner';
      b.style.cssText = 'position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:99999;'
        + 'background:#8E1D2F;color:#fff;padding:11px 18px;border-radius:10px;'
        + 'font:600 13px/1.45 Inter,system-ui,sans-serif;box-shadow:0 10px 34px rgba(0,0,0,.3);'
        + 'max-width:92vw;text-align:center;pointer-events:none';
      document.body.appendChild(b);
    }
    b.textContent = '⚠ This material belongs to your teacher. Copying or sharing it may end your access.';
    b.style.display = 'block';
    clearTimeout(b._t);
    b._t = setTimeout(() => { b.style.display = 'none'; }, 4000);
  }

  function log(type) {
    const now = Date.now();
    if (lastLog[type] && now - lastLog[type] < 15000) return;   // throttle
    lastLog[type] = now;
    try {
      sb.from('activity_log').insert({
        teacher_id: profile.teacher_id, actor_id: profile.id, actor_name: profile.full_name,
        event_type: type, page: location.pathname,
      });
    } catch (_) {}
  }

  document.addEventListener('copy', () => { warn(); log('copy'); });
  document.addEventListener('cut',  () => { warn(); log('cut'); });
}

// ── Subscription ──────────────────────────────────────────────────

// How many students this teacher may still add, straight from the
// database function so the page and the API agree on the number.
async function studentAllowance() {
  try {
    const { data, error } = await sb.rpc('my_student_allowance');
    if (error || !data?.length) return null;
    const row = data[0];
    return { used: row.used, allowed: row.allowed, status: row.status, left: Math.max(0, row.allowed - row.used) };
  } catch (_) { return null; }
}

// A banner across the top of the teacher portal when the subscription
// needs attention. Not a block — a teacher whose payment is late still
// has a class waiting on them.
function renderSubscriptionNotice(allowance) {
  if (!allowance) return;
  const { status, used, allowed } = allowance;
  let msg = '', kind = 'warning';
  if (status === 'past_due') {
    msg = 'Your Lumen subscription is past due. Please settle the latest invoice to keep new student accounts available.';
  } else if (status === 'cancelled' || status === 'paused') {
    msg = 'Your Lumen subscription is not active. Your content is safe, but you cannot add students until it is resumed.';
  } else if (allowed > 0 && used >= allowed) {
    msg = `You have used all ${allowed} student places on your plan. Contact Lumen to move up a tier.`;
  } else if (allowed > 0 && allowed - used <= 5) {
    msg = `${allowed - used} student place${allowed - used === 1 ? '' : 's'} left on your plan.`;
    kind = 'info';
  } else {
    return;
  }
  const host = document.querySelector('.content');
  if (!host || document.getElementById('sub-notice')) return;
  const el = document.createElement('div');
  el.id = 'sub-notice';
  el.className = 'alert alert-' + kind;
  el.style.marginBottom = '20px';
  el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
    <div>${escHtml(msg)} <a href="/teacher/subscription.html" style="font-weight:700;text-decoration:underline">View subscription</a></div>`;
  host.insertBefore(el, host.firstChild);
}

// ── Calling the API ───────────────────────────────────────────────
// Every api/ endpoint authenticates from the caller's own access token,
// so this is the only way a page should reach one.
async function apiPost(path, body) {
  const session = await ensureFreshSession();
  if (!session) throw new Error('Your session has expired. Please sign in again.');
  const resp = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.access_token },
    body: JSON.stringify(body || {}),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || 'That did not work. Please try again.');
  return data;
}

// ── Sign in / out ─────────────────────────────────────────────────

async function signOut() {
  try { localStorage.removeItem('lumen_role'); } catch (_) {}
  // Before the sign-out, not after: the next page must not find the
  // server's copy and quietly sign them straight back in.
  await forgetKeptSession();
  await sb.auth.signOut();
  location.replace('/login.html');
}

// Called right after a successful signInWithPassword.
async function handlePostLogin(next) {
  const profile = await getProfile();

  // A session with no profile behind it, sent back to the sign-in page
  // WITHOUT being ended, is an infinite loop: the page loads, finds the
  // session still there, calls this again, and sends them back again.
  // From the outside it is a sign-in page that never stops loading.
  //
  // It happens to a real person: a browser still holding the session of
  // an account that has since been deleted, or a profile row the
  // database will not return. So the session goes first, and the reason
  // goes on the page — the same order guardPage() uses.
  if (!profile) {
    // Unless the database is simply down. Signing somebody out over an
    // outage lands them in the one window where signing in cannot work.
    if (lastProfileError && isServiceOutage(lastProfileError.message)) {
      showOutageScreen();
      return;
    }
    try { await sb.auth.signOut(); } catch (_) { /* going to the door anyway */ }
    location.replace('/login.html?e=no_profile');
    return;
  }
  try { localStorage.setItem('lumen_role', profile.role); } catch (_) {}

  // Straight from signing in to the one thing they have not done. No
  // token needed: they are signed in, which is proof enough that the
  // account is theirs.
  if (profile.must_change_pw && profile.role !== 'owner') {
    location.replace('/set-password.html');
    return;
  }
  // Honour ?next= only when it is a path on this site. An absolute URL
  // here would turn the sign-in page into an open redirect.
  if (next && /^\/[^/\\]/.test(next)) { location.replace(next); return; }
  location.replace(homeFor(profile.role));
}

// ── Scoring rules shared by the portals ───────────────────────────

// A retake replaces the earlier try: a student is credited with their
// highest mark on each test. Every average and headline score goes
// through this, so one weak first attempt never drags down a student who
// went back and did better.
function bestAttempts(attempts) {
  const best = new Map();
  (attempts || []).forEach(a => {
    const p = parseFloat(a?.percentage);
    if (isNaN(p)) return;
    const cur = best.get(a.test_id);
    if (!cur || p > parseFloat(cur.percentage)) best.set(a.test_id, a);
  });
  return [...best.values()];
}

// Average across tests, counting only each student's best attempt.
// null when they have not finished any test yet.
function bestAverage(attempts) {
  const list = bestAttempts(attempts);
  if (!list.length) return null;
  return Math.round(list.reduce((s, a) => s + parseFloat(a.percentage), 0) / list.length);
}

// The same best attempts, added up as marks: 412/520 across every test
// they have sat. What an average is shown as, now that scores are shown as
// numbers — tests of different lengths cannot be averaged into one 18/20.
// null when they have not finished any test yet.
function bestTotals(attempts) {
  const list = bestAttempts(attempts).filter(a => a.score != null && a.max_score != null);
  if (!list.length) return null;
  return {
    score: list.reduce((s, a) => s + Number(a.score), 0),
    max: list.reduce((s, a) => s + Number(a.max_score), 0),
  };
}
function bestTotalMarks(attempts) {
  const t = bestTotals(attempts);
  return t ? marks(t.score, t.max) : null;
}
// The single best attempt — highest percentage — shown as its own marks.
function bestMark(attempts) {
  const list = bestAttempts(attempts);
  if (!list.length) return null;
  return mark(list.reduce((a, b) => (parseFloat(b.percentage) > parseFloat(a.percentage) ? b : a)));
}

// Is this test open to a student right now? The database enforces the same
// window on the questions; this is what draws the lock.
function testWindow(t, now = new Date()) {
  if (!t?.is_active) return { open: false, label: 'Closed' };
  if (t.open_at && new Date(t.open_at) > now) return { open: false, label: 'Opens ' + fmtDateTime(t.open_at) };
  if (t.close_at && new Date(t.close_at) < now) return { open: false, label: 'Closed ' + fmtDate(t.close_at) };
  return { open: true, label: t.close_at ? 'Closes ' + fmtDateTime(t.close_at) : 'Open' };
}

// A unit is visible to students once the teacher marks it done and its
// release time has passed.
function moduleOpen(m, now = new Date()) {
  return !!m?.is_done && (!m.open_at || new Date(m.open_at) <= now);
}
