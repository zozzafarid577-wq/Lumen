// ─────────────────────────────────────────────────────────────────
// Lumen — page chrome and formatting helpers
//
// Everything here works without a network connection or a signed-in
// user, so it is safe to load before auth.js and to call from a page
// that is still showing its skeleton.
// ─────────────────────────────────────────────────────────────────

// ── Escaping and formatting ───────────────────────────────────────

// Every value that reaches innerHTML goes through this. Student names,
// lesson titles and a teacher's own announcement text are all user input.
function escHtml(str) {
  const d = document.createElement('div');
  d.textContent = str ?? '';
  return d.innerHTML;
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

// For <input type="datetime-local">, which wants local time with no zone.
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function timeAgo(iso) {
  if (!iso) return '';
  const secs = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (secs < 60)    return 'just now';
  if (secs < 3600)  return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 2592000) return `${Math.floor(secs / 86400)}d ago`;
  return fmtDate(iso);
}

function initials(name) {
  return (name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

// ── Groups ────────────────────────────────────────────────────────
// A group's days are stored 0–6 matching JavaScript's getDay(), so this
// is an index rather than a lookup.
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// '16:30:00' from Postgres, or '16:30' from an <input type="time">.
function fmtTime(value) {
  if (!value) return '';
  const [h, m] = String(value).split(':');
  const hour = parseInt(h, 10);
  if (!Number.isFinite(hour)) return '';
  const suffix = hour < 12 ? 'am' : 'pm';
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${m ?? '00'}${suffix}`;
}

// "Sun & Tue, 4:00pm" — how a group is said everywhere it appears. A
// group with no days set yet is not a bug: the name alone is useful
// before the timetable is settled, so this returns nothing rather than
// inventing a schedule.
function groupWhen(group) {
  if (!group) return '';
  const days = [...(group.days || [])].sort((a, b) => a - b).map(d => DAY_SHORT[d]).filter(Boolean);
  const time = fmtTime(group.start_time);
  if (!days.length) return time;
  const when = days.length > 2 ? days.join(', ') : days.join(' & ');
  return time ? `${when}, ${time}` : when;
}

// The name with its schedule after it, for a badge or a chip.
function groupLabel(group) {
  if (!group) return '';
  const when = groupWhen(group);
  return when ? `${group.name} · ${when}` : group.name;
}

// The origin to put in something a teacher hands to somebody else: an
// invite link pasted into WhatsApp, a student's sign-in details read out
// loud. LUMEN_CONFIG.SITE_URL when it is set, the current origin when it
// is not — so a deployment that has no custom domain yet still produces
// links that work.
//
// Not for navigating inside the app, which stays relative: a teacher who
// opened a preview deployment should keep browsing that preview rather
// than being thrown to the live site half way through a page.
function siteOrigin() {
  const configured = String(window.LUMEN_CONFIG?.SITE_URL || '').trim().replace(/\/+$/, '');
  if (!configured) return location.origin;
  // Tolerate "lumenlearn.site" as well as "https://lumenlearn.site".
  // This is edited by hand when a domain changes, and a missing scheme
  // would otherwise produce a link that goes nowhere.
  return /^https?:\/\//i.test(configured) ? configured : `https://${configured}`;
}

// A–Z the way a person reads a list, which is not the way Postgres
// sorts one. `.order('name')` compares text by the database's collation:
// "Group 10" lands before "Group 2" because 1 comes before 2, and a
// group typed in lower case can sort after every capitalised one. A
// teacher looking for Sunday among fifteen groups reads that as the list
// being in no order at all.
//
// numeric reads a run of digits as a number, so 2 comes before 10.
// sensitivity 'base' ignores case and accents, so "sunday" files with
// "Sunday" rather than after it.
function compareNames(a, b) {
  return String(a ?? '').localeCompare(String(b ?? ''), undefined, { numeric: true, sensitivity: 'base' });
}

// Sorted copy, never in place: the array handed in is usually the page's
// own state and something else is probably rendering from it.
function sortByName(list, name = (x) => x?.name) {
  return [...(list || [])].sort((a, b) => compareNames(name(a), name(b)));
}

// Egyptian pounds, the currency every price in Lumen is quoted in.
function egp(amount) {
  if (amount == null) return '—';
  return Number(amount).toLocaleString('en-US') + ' EGP';
}

function pct(n, digits = 0) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toFixed(digits) + '%';
}

// A mark as the marks it is — 18/20 — which is how Lumen shows every
// score. Percentages are still stored and still decide pass, colour and
// order; they are just not what anybody reads. An attempt saved without
// its marks (none should be) falls back to its percentage.
function marks(score, max) {
  if (score == null || max == null || isNaN(score) || isNaN(max)) return '—';
  return `${+score}/${+max}`;
}
// The pass mark in marks — "10/20" — once the test's total is known.
// The setting itself stays a percentage; this is only how it reads.
function passMarks(passPct, max) {
  if (passPct == null || !max) return passPct == null ? '—' : passPct + '%';
  return marks(Math.ceil((Number(passPct) / 100) * Number(max) - 1e-9), max);
}
function mark(attempt) {
  if (attempt?.score != null && attempt?.max_score != null) return marks(attempt.score, attempt.max_score);
  return pct(attempt?.percentage);
}

// ── Toasts ────────────────────────────────────────────────────────

function showToast(msg, type = '') {
  let wrap = document.getElementById('toasts');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'toasts';
    wrap.className = 'toast-wrap';
    document.body.appendChild(wrap);
  }
  const el = document.createElement('div');
  el.className = 'toast-msg' + (type ? ' toast-' + type : '');
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 3600);
}
const toast = showToast;

// ── Modals ────────────────────────────────────────────────────────

function openModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add('open', 'show');
  // Give the first field focus so a keyboard user does not have to hunt
  // for it, but never a button — that turns Enter into an accidental save.
  const first = el.querySelector('input:not([type=hidden]), select, textarea');
  if (first) setTimeout(() => first.focus(), 60);
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('open', 'show');
}

// Escape closes the topmost open modal — expected of any dialog.
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const open = [...document.querySelectorAll('.modal-backdrop.open, .modal-overlay.show')].pop();
  if (open) open.classList.remove('open', 'show');
});

// ── Sidebar (mobile) ──────────────────────────────────────────────

function toggleSidebar() {
  document.getElementById('sidebar')?.classList.toggle('open');
  document.getElementById('overlay')?.classList.toggle('show');
}

function closeSidebar() {
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('overlay')?.classList.remove('show');
}

// Mark the nav link for the page we are on, so every page does not have
// to hard-code `class="active"` on a different item.
function markActiveNav() {
  const here = location.pathname.replace(/\/index\.html$/, '/').replace(/\.html$/, '');
  document.querySelectorAll('.sidebar a.nav-item').forEach(a => {
    const href = (a.getAttribute('href') || '').replace(/\/index\.html$/, '/').replace(/\.html$/, '');
    if (href === here) a.classList.add('active');
  });
}

// ── The page could not be drawn ───────────────────────────────────
// Better than a skeleton that never resolves: say what happened, and
// leave the session alone so a reload puts them straight back.
const SERVICE_DOWN_MESSAGE =
  'Lumen is temporarily unavailable while we carry out maintenance. Nothing has been lost — your work and your students’ results are safe. Please try again in a little while.';
const CONNECTION_FAILED_MESSAGE =
  'We could not reach Lumen. Please check your internet connection and try again. Your work is safe.';

// ── Sections, and the colour a teacher gave them ──────────────────
// A section is a label — Vocabulary, Grammar, Listening — and on a unit
// with four papers the label is the only thing telling them apart. All
// of them in the same brand purple told nothing apart, so each carries
// its own colour.
//
// These eight are what a new section is offered first, in this order, so
// a teacher who never opens the picker still ends up with sections that
// differ from each other.
const SECTION_COLORS = [
  '#A2509F', '#2563EB', '#147A57', '#B4690E',
  '#C62F45', '#6D28D9', '#0E7490', '#BE185D',
];

// Black or white, whichever can actually be read on that colour. The
// teacher picks any hex they like; this is what keeps it legible in both
// themes without asking them to think about contrast.
function readableOn(hex) {
  const c = String(hex || '').replace('#', '');
  if (c.length !== 6) return '#ffffff';
  const channel = (i) => {
    const v = parseInt(c.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  return luminance > 0.45 ? '#1B1519' : '#ffffff';
}

function sectionColor(section) {
  const c = section?.color;
  return /^#[0-9a-f]{6}$/i.test(c || '') ? c : SECTION_COLORS[0];
}

// The one place a section is drawn, so the colour a teacher chose looks
// the same on their course page, in their bank, and in the student's
// portal.
function sectionBadge(section, style = '') {
  if (!section?.name) return '';
  const color = sectionColor(section);
  return `<span class="badge section-badge" style="background:${color};color:${readableOn(color)};${style}">`
    + `${escHtml(section.name)}</span>`;
}

// ── Dragging a block into a new place ─────────────────────────────
// A teacher orders their course by dragging, not by typing numbers into
// a field. The drag starts on a handle rather than anywhere on the row,
// or every attempt to click Edit would pick the row up instead.
//
// `container` is the element the items sit directly inside; `onReorder`
// is handed the ids in their new order, top to bottom.
function makeSortable(container, { itemSelector, handleSelector, onReorder }) {
  // Lists are redrawn by replacing innerHTML, so this is called again
  // after every render. A container that still carries the mark is one
  // that already has these listeners.
  if (!container || container.dataset.sortable === '1') return;
  container.dataset.sortable = '1';

  let dragged = null;

  // Nothing is draggable until a handle is pressed. Delegated, so items
  // drawn after this runs behave the same as the ones already there.
  const arm = (e) => {
    const handle = e.target.closest?.(handleSelector);
    const item = handle && handle.closest(itemSelector);
    if (item && container.contains(item)) item.draggable = true;
  };
  container.addEventListener('mousedown', arm);
  container.addEventListener('touchstart', arm, { passive: true });

  container.addEventListener('dragstart', (e) => {
    const item = e.target.closest?.(itemSelector);
    if (!item || !item.draggable) return;
    dragged = item;
    item.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    // Firefox starts no drag at all without something on the transfer.
    try { e.dataTransfer.setData('text/plain', item.dataset.id || ''); } catch (_) {}
  });

  // The row is moved as the pointer passes the halfway line of whatever
  // it is over, so what you see while dragging is what you get on drop.
  container.addEventListener('dragover', (e) => {
    if (!dragged) return;
    const over = e.target.closest?.(itemSelector);
    if (!over || over === dragged || over.parentElement !== dragged.parentElement) return;
    e.preventDefault();
    const box = over.getBoundingClientRect();
    const below = (e.clientY - box.top) > box.height / 2;
    over.parentElement.insertBefore(dragged, below ? over.nextSibling : over);
  });

  container.addEventListener('drop', (e) => e.preventDefault());

  container.addEventListener('dragend', () => {
    if (!dragged) return;
    const parent = dragged.parentElement;
    dragged.classList.remove('dragging');
    dragged.draggable = false;
    dragged = null;
    const ids = [...parent.children]
      .filter(el => el.matches?.(itemSelector))
      .map(el => el.dataset.id)
      .filter(Boolean);
    if (ids.length) onReorder(ids, parent);
  });
}

function onBodyReady(fn) {
  if (typeof document === 'undefined') return;
  if (document.body) { fn(); return; }
  document.addEventListener('DOMContentLoaded', fn, { once: true });
}

function showOutageScreen(message) {
  if (!document.body) { onBodyReady(() => showOutageScreen(message)); return; }
  if (document.getElementById('outage-screen')) return;
  const el = document.createElement('div');
  el.id = 'outage-screen';
  el.setAttribute('role', 'alert');
  el.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#FDF6F7;display:flex;align-items:center;'
    + 'justify-content:center;padding:24px;font-family:Inter,system-ui,sans-serif';
  el.innerHTML = `
    <div style="max-width:430px;background:#fff;border:1px solid #EDDDE6;border-radius:18px;padding:34px;text-align:center;box-shadow:0 10px 34px rgba(27,21,25,.09)">
      <div style="font-family:Manrope,sans-serif;font-size:1.6rem;font-weight:500;letter-spacing:-.045em;margin-bottom:16px">L<span style="color:#A2509F;font-weight:700;border-bottom:.12em solid #A2509F">u</span>men</div>
      <div style="font-family:Manrope,sans-serif;font-size:1.05rem;font-weight:800;color:#1B1519;margin-bottom:10px">Back shortly</div>
      <p style="margin:0 0 20px;font-size:.9rem;line-height:1.6;color:#554C53">${escHtml(message || SERVICE_DOWN_MESSAGE)}</p>
      <button onclick="location.reload()" style="background:#A2509F;color:#fff;border:0;border-radius:9999px;padding:12px 26px;font-size:.88rem;font-weight:600;cursor:pointer;font-family:Manrope,sans-serif">Try again</button>
    </div>`;
  document.body.appendChild(el);
}

// Supabase's own operational wording ("exceed_egress_quota") tells a
// student nothing except that something is broken. Recognise the ones
// that mean "not your fault, try later" and say that instead.
function isServiceOutage(message) {
  const m = String(message || '').toLowerCase();
  return m.includes('quota')
    || m.includes('is restricted')
    || m.includes('project is paused')
    || m.includes('violations')
    || m.includes('service unavailable')
    || m.includes('failed to fetch')
    || m.includes('networkerror')
    || m.includes('load failed');
}

function friendlyError(message) {
  return isServiceOutage(message) ? SERVICE_DOWN_MESSAGE : String(message || 'Something went wrong.');
}

// ── Theme ─────────────────────────────────────────────────────────
(function theme() {
  const KEY = 'lumen_theme';
  const MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  const SUN  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';

  const current = () => document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';

  function apply(t) {
    if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    try { localStorage.setItem(KEY, t); } catch (_) {}
    const btn = document.getElementById('theme-toggle');
    if (btn) btn.innerHTML = t === 'dark' ? SUN : MOON;
  }

  function mount() {
    // Only on the app shell. A test page or the printable review has no
    // business growing a floating button.
    if (!document.querySelector('.main') || document.getElementById('theme-toggle')) return;
    const btn = document.createElement('button');
    btn.id = 'theme-toggle';
    btn.className = 'theme-toggle no-print';
    btn.type = 'button';
    btn.title = 'Switch between light and dark';
    btn.setAttribute('aria-label', 'Switch between light and dark');
    btn.innerHTML = current() === 'dark' ? SUN : MOON;
    btn.onclick = () => apply(current() === 'dark' ? 'light' : 'dark');
    document.body.appendChild(btn);
  }

  try { if (localStorage.getItem(KEY) === 'dark') document.documentElement.setAttribute('data-theme', 'dark'); } catch (_) {}
  onBodyReady(mount);
})();

// ── Install button ────────────────────────────────────────────────
// Lumen installs like an app: added to the home screen it gets its own
// icon, opens without the browser's bars, and keeps the student signed
// in. One button offers it.
//
// Chrome on Android can install the page itself, and announces that it
// can before anything asks; the event is kept so the button can use it.
// An iPhone has no such thing — Apple lets nothing but the person add a
// site to the home screen, through Share — so there the same button
// opens a two-step picture of where to tap.
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; });

function isInstalledApp() {
  try {
    // The Lumen phone app says so in its user agent; inside it there is
    // nothing left to install.
    return /LumenApp\//.test(navigator.userAgent || '')
      || window.navigator.standalone === true
      || window.matchMedia('(display-mode: standalone)').matches;
  } catch (_) { return false; }
}

function installDevice() {
  const ua = navigator.userAgent || '';
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  return {
    ios,
    android: /Android/.test(ua),
    // Safari's Share button is at the bottom on an iPhone; the arrow
    // points at it only there.
    iphoneSafari: /iPhone|iPod/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua),
    // WhatsApp, Instagram and Facebook open links in a browser of their
    // own, which can install nothing and forgets the sign-in on close.
    inApp: /FBAN|FBAV|Instagram|WhatsApp|Line\/|Snapchat|TikTok/i.test(ua),
  };
}

const INSTALL_ICONS = {
  down:  '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><polyline points="7 10 12 15 17 10"/><path d="M5 20h14"/></svg>',
  share: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><polyline points="8 7 12 3 16 7"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>',
  plus:  '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="M12 8v8M8 12h8"/></svg>',
  dots:  '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>',
};

function installStyles() {
  if (document.getElementById('install-css')) return;
  const css = document.createElement('style');
  css.id = 'install-css';
  css.textContent = `
    .install-btn { display:inline-flex; align-items:center; justify-content:center; gap:8px;
      font: 700 .86rem/1 Manrope, system-ui, sans-serif; color:#fff; background:#A2509F;
      border:0; border-radius:9999px; padding:11px 18px; cursor:pointer;
      box-shadow:0 4px 14px rgba(162,80,159,.28); -webkit-tap-highlight-color:transparent; }
    .install-btn:active { transform:scale(.97); }
    .install-btn.block { display:flex; width:100%; padding:14px 18px; font-size:.95rem; }
    .install-btn.soft { color:#A2509F; background:rgba(162,80,159,.1); box-shadow:none; padding:9px 14px; font-size:.8rem; }
    .install-veil { position:fixed; inset:0; z-index:10000; background:rgba(20,10,22,.55);
      display:flex; align-items:flex-end; justify-content:center; animation:inst-fade .2s ease; }
    .install-sheet { width:100%; max-width:440px; background:#fff; color:#1c1720; border-radius:22px 22px 0 0;
      padding:22px 22px calc(26px + env(safe-area-inset-bottom)); box-shadow:0 -10px 40px rgba(0,0,0,.18);
      animation:inst-up .26s cubic-bezier(.2,.8,.2,1); font-family:Manrope, system-ui, sans-serif; }
    .install-sheet h3 { margin:12px 0 4px; font-size:1.15rem; font-weight:800; text-align:center; }
    .install-sheet .lead { margin:0 0 18px; color:#6f6672; font-size:.86rem; text-align:center; line-height:1.45; }
    .install-step { display:flex; align-items:center; gap:14px; padding:13px 14px; border-radius:14px;
      background:#f7f1f7; margin-bottom:10px; font-size:.92rem; line-height:1.35; }
    .install-step .n { width:26px; height:26px; flex-shrink:0; border-radius:50%; background:#A2509F; color:#fff;
      font-weight:800; font-size:.8rem; display:flex; align-items:center; justify-content:center; }
    .install-step .ic { margin-left:auto; color:#2f7cf6; display:flex; }
    .install-close { display:block; margin:16px auto 0; background:none; border:0; color:#8b8089;
      font:700 .88rem Manrope, system-ui, sans-serif; cursor:pointer; padding:8px 16px; }
    .install-arrow { position:fixed; left:50%; bottom:calc(8px + env(safe-area-inset-bottom)); z-index:10001;
      transform:translateX(-50%); color:#fff; animation:inst-bob 1s ease-in-out infinite; pointer-events:none; }
    /* With the arrow, the sheet floats clear of the bottom edge so the
       arrow can sit under it, pointing at Safari's own Share button. */
    .install-veil.with-arrow { padding:0 10px calc(64px + env(safe-area-inset-bottom)); }
    .install-veil.with-arrow .install-sheet { border-radius:22px; padding-bottom:22px; }
    @keyframes inst-fade { from { opacity:0 } }
    @keyframes inst-up { from { transform:translateY(100%) } }
    @keyframes inst-bob { 50% { transform:translate(-50%, 8px) } }
  `;
  document.head.appendChild(css);
}

function apkUrl() {
  try { return (window.LUMEN_CONFIG || {}).ANDROID_APK_URL || ''; } catch (_) { return ''; }
}

function openInstallGuide() {
  const d = installDevice();
  installStyles();
  const step = (n, text, ic) =>
    `<div class="install-step"><span class="n">${n}</span><span>${text}</span>${ic ? `<span class="ic">${ic}</span>` : ''}</div>`;

  let steps;
  if (d.inApp) {
    steps = step(1, `Tap <strong>⋯</strong> at the top of this screen`, INSTALL_ICONS.dots)
      + step(2, `Choose <strong>Open in ${d.ios ? 'Safari' : 'browser'}</strong>`)
      + step(3, `Tap <strong>Install app</strong> there`);
  } else if (d.ios) {
    steps = step(1, `Tap the <strong>Share</strong> button ${d.iphoneSafari ? 'at the bottom of the screen' : 'in the address bar'}`, INSTALL_ICONS.share)
      + step(2, `Tap <strong>Add to Home Screen</strong>`, INSTALL_ICONS.plus)
      + step(3, `Tap <strong>Add</strong>`);
  } else if (apkUrl()) {
    // The download has already started by the time this shows.
    steps = step(1, `Wait for <strong>lumen.apk</strong> to finish downloading`)
      + step(2, `Tap it to open it — if your phone asks, allow installing from this browser`)
      + step(3, `Tap <strong>Install</strong>, then <strong>Open</strong>`);
  } else {
    steps = step(1, `Tap <strong>⋮</strong> at the top right`, INSTALL_ICONS.dots)
      + step(2, `Tap <strong>Install app</strong> or <strong>Add to Home screen</strong>`, INSTALL_ICONS.plus);
  }

  const veil = document.createElement('div');
  const arrow = d.iphoneSafari && !d.inApp;
  veil.className = 'install-veil' + (arrow ? ' with-arrow' : '');
  veil.innerHTML = `
    <div class="install-sheet" role="dialog" aria-modal="true" aria-label="Install Lumen">
      <div style="text-align:center"><img src="/assets/app/icon-192.png" alt="" width="64" height="64" style="border-radius:15px"></div>
      <h3>${d.android && !d.inApp && apkUrl() ? 'Installing the Lumen app' : 'Put Lumen on your home screen'}</h3>
      <p class="lead">${d.inApp
        ? 'This app’s browser can’t install Lumen, and it forgets your sign-in.'
        : 'It opens like an app, and you stay signed in.'}</p>
      ${steps}
      <button type="button" class="install-close">${d.android && !d.inApp && apkUrl() ? 'Done' : 'Not now'}</button>
    </div>
    ${arrow ? `<div class="install-arrow">${INSTALL_ICONS.down.replace(/17/g, '34')}</div>` : ''}`;
  const close = () => veil.remove();
  veil.addEventListener('click', e => { if (e.target === veil) close(); });
  veil.querySelector('.install-close').onclick = close;
  document.body.appendChild(veil);
}

// The button. `style` is 'block' (full width, for the sign-in page),
// 'soft' (small, for a top bar) or '' (a normal pill).
function mountInstallButton(host, { style = '', label = 'Install the app' } = {}) {
  if (!host || isInstalledApp()) return;
  const d = installDevice();
  if (!d.ios && !d.android) return;   // a computer has nothing to install
  installStyles();

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'install-btn' + (style ? ' ' + style : '');
  btn.innerHTML = INSTALL_ICONS.down + `<span>${escHtml(label)}</span>`;
  btn.onclick = async () => {
    // On Android, the app itself: a file they download and install,
    // with its steps on screen while it downloads. Not from inside
    // WhatsApp or Instagram, whose browsers cannot install a file.
    if (d.android && !d.inApp && apkUrl()) {
      const a = document.createElement('a');
      a.href = apkUrl();
      a.download = 'lumen.apk';
      document.body.appendChild(a);
      a.click();
      a.remove();
      openInstallGuide();
      return;
    }
    // Where Chrome offers it, one tap is the whole thing.
    if (deferredInstall && !d.inApp) {
      const ev = deferredInstall;
      deferredInstall = null;
      ev.prompt();
      try { if ((await ev.userChoice).outcome === 'accepted') btn.remove(); } catch (_) {}
      return;
    }
    openInstallGuide();
  };
  host.appendChild(btn);
  window.addEventListener('appinstalled', () => btn.remove());
}
