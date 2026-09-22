// ─────────────────────────────────────────────────────────────────
// Lumen — public site
//
// The marketing pages work with no JavaScript and no database: every
// price on them is written into the HTML. What this file adds is the
// live price list, so changing a plan in Supabase changes the site, and
// the forms that write to `leads` and start a trial.
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

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str ?? '';
  return d.innerHTML;
}

function money(n) { return Number(n || 0).toLocaleString('en-US'); }

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

// ── Live price list ───────────────────────────────────────────────
// The cards already in the HTML are the current prices and are what a
// reader sees if Supabase is unreachable or not yet configured. They are
// replaced only once real rows have arrived.
async function renderPlanCards(containerId, { codes = null, featured = null } = {}) {
  const host = document.getElementById(containerId);
  if (!host || !sbPublic) return;

  let query = sbPublic.from('plans').select('*')
    .eq('is_active', true).eq('listing', 'package').order('sort_order');
  if (codes) query = query.in('code', codes);

  const { data, error } = await query;
  if (error || !data?.length) return;   // keep the written-in prices

  host.innerHTML = data.map(p => planCard(p, featured ?? (data.length > 1 ? data[data.length - 1].code : null))).join('');
}

function planCard(plan, featuredCode) {
  const isFeatured = plan.code === featuredCode;
  const features = Array.isArray(plan.features) ? plan.features : [];
  return `
    <div class="price-card${isFeatured ? ' featured' : ''}">
      ${isFeatured ? '<div class="price-flag">Full service</div>' : ''}
      <div class="price-name">${esc(plan.name)}</div>
      <div class="price-sub">${esc(plan.package === 'full' ? 'Platform + student support' : 'Basic support')} · up to ${plan.student_limit} students</div>
      <div class="price-amount">
        <span class="n">${money(plan.monthly_fee_egp)}</span>
        <span class="cur">EGP</span>
        <span class="per">/ month</span>
      </div>
      <ul class="price-list">${features.map(f => `<li>${esc(f)}</li>`).join('')}</ul>
      ${plan.blurb ? `<div class="price-best">${esc(plan.blurb)}</div>` : ''}
      <a href="/contact.html?plan=${encodeURIComponent(plan.code)}" class="btn ${isFeatured ? 'btn-primary' : 'btn-outline'} btn-block">Choose this package</a>
    </div>`;
}

// The student tiers table on the pricing page.
async function renderTierTable(tbodyId) {
  const body = document.getElementById(tbodyId);
  if (!body || !sbPublic) return;
  const { data, error } = await sbPublic
    .from('plans').select('student_limit, monthly_fee_egp')
    .eq('is_active', true).eq('listing', 'tier').order('student_limit');
  if (error || !data?.length) return;

  // One row per band, so "up to 60 / 61–100 / 101–150" reads the way the
  // service sheet does rather than repeating "up to N" three times.
  let previous = 0;
  body.innerHTML = data.map(p => {
    const label = previous === 0 ? `Up to ${p.student_limit}` : `${previous + 1} – ${p.student_limit}`;
    previous = p.student_limit;
    return `<tr><td>${esc(label)}</td><td>${money(p.monthly_fee_egp)} EGP</td></tr>`;
  }).join('');
}

// Fill a plan <select> on the contact form, and preselect ?plan=.
async function fillPlanSelect(selectId) {
  const sel = document.getElementById(selectId);
  if (!sel || !sbPublic) return;
  const { data } = await sbPublic.from('plans').select('code, name, listing, monthly_fee_egp, student_limit')
    .eq('is_active', true).order('sort_order');
  if (!data?.length) return;

  const group = (label, rows) => rows.length
    ? `<optgroup label="${esc(label)}">${rows.map(p =>
        `<option value="${esc(p.code)}">${esc(p.name)} — ${money(p.monthly_fee_egp)} EGP / month</option>`).join('')}</optgroup>`
    : '';

  sel.innerHTML = '<option value="">Not sure yet — advise me</option>'
    + group('Packages', data.filter(p => p.listing === 'package'))
    + group('By class size', data.filter(p => p.listing === 'tier'));
  const wanted = new URLSearchParams(location.search).get('plan');
  if (wanted && data.some(p => p.code === wanted)) sel.value = wanted;
}

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
