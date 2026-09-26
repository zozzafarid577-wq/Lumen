// ─────────────────────────────────────────────────────────────────
// Lumen — public site
//
// The pages work with no JavaScript and no database. What this file
// adds is the mobile nav and the form that writes to `leads`.
//
// It used to render the price list too, live from the `plans` table.
// Nothing public quotes a price any more — what Lumen costs is said on
// the call — so the plans stayed and their rendering went. The table is
// still the source of truth for the console and for a subscription.
// ─────────────────────────────────────────────────────────────────

const SITE_CFG = window.LUMEN_CONFIG || {};
const SITE_CONFIGURED =
  typeof supabase !== 'undefined' &&
  /^https:\/\/[a-z0-9-]+\.supabase\.co/.test(SITE_CFG.SUPABASE_URL || '');

const sbPublic = SITE_CONFIGURED
  ? supabase.createClient(SITE_CFG.SUPABASE_URL, SITE_CFG.SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

// ── Mobile nav ────────────────────────────────────────────────────
function mountNavToggle() {
  const btn = document.getElementById('nav-toggle');
  const links = document.getElementById('nav-links');
  if (!btn || !links) return;
  btn.addEventListener('click', () => {
    const open = links.classList.toggle('open');
    btn.setAttribute('aria-expanded', String(open));
  });
}

// Mark the current page in the nav.
(function markNav() {
  const here = location.pathname.replace(/\.html$/, '').replace(/\/$/, '') || '/';
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.nav-links a').forEach(a => {
      const href = (a.getAttribute('href') || '').split('#')[0].replace(/\.html$/, '').replace(/\/$/, '');
      if (href && href === here) a.classList.add('active');
    });
  });
})();

// ── Lead form ─────────────────────────────────────────────────────
// Writes straight to `leads`, which the anon role may insert into and
// nothing but Lumen staff may read back.
function mountLeadForm(formId, msgId) {
  const form = document.getElementById(formId);
  const msg = document.getElementById(msgId);
  if (!form) return;

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    const data = Object.fromEntries(new FormData(form).entries());

    if (!sbPublic) {
      say(msg, 'err', 'This site is not connected to a database yet. Please email us instead — see the footer.');
      return;
    }

    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'Sending…';
    say(msg, '', '');

    const count = parseInt(data.student_count, 10);
    const { error } = await sbPublic.from('leads').insert({
      full_name: String(data.full_name || '').trim(),
      email: String(data.email || '').trim().toLowerCase(),
      phone: String(data.phone || '').trim() || null,
      subject: String(data.subject || '').trim() || null,
      student_count: Number.isFinite(count) ? count : null,
      plan_code: data.plan_code || null,
      message: String(data.message || '').trim() || null,
    });

    btn.disabled = false;
    btn.textContent = label;

    if (error) {
      say(msg, 'err', 'We could not send that just now. Please try again, or email us directly.');
      return;
    }
    form.reset();
    say(msg, 'ok', 'Thank you — we have your details and will be in touch shortly to arrange your setup.');
  });
}

function say(el, kind, text) {
  if (!el) return;
  el.className = 'form-msg' + (kind ? ' ' + kind : '');
  el.textContent = text;
  el.style.display = text ? 'block' : 'none';
}
