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
