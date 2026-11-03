// ─────────────────────────────────────────────────────────────────
// Lumen — the front page in motion
//
// Sections rise into place as they scroll into view, and the drawn phone
// screens come alive while they are on screen: the dashboard counts up,
// the mock-test clock ticks, units get picked in the question bank, the
// report's rows arrive one by one. Plus a one-time "book a call" card
// once a visitor has read half the page.
//
// Everything here is decoration on a page that already works without
// it: no JavaScript, or "reduce motion" switched on, and the page simply
// stands still.
// ─────────────────────────────────────────────────────────────────
(function () {
  const still = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  // ── Rise into view ──────────────────────────────────────────────
  const REVEAL = '.h-head, .h-who article, .h-feat > div, .h-feat > .phone, .h-grid article, .h-steps > div, .h-faq details, .h-cta';
  function reveal() {
    const els = $$(REVEAL);
    if (still || !('IntersectionObserver' in window)) return;
    document.documentElement.classList.add('motion');
    // Siblings in a row arrive one after another rather than all at once.
    els.forEach(el => {
      const sibs = Array.from(el.parentElement.children).filter(c => c.matches(REVEAL));
      el.style.setProperty('--d', (Math.max(0, sibs.indexOf(el)) % 6) * 90 + 'ms');
      el.classList.add('rv');
    });
    const io = new IntersectionObserver(entries => entries.forEach(e => {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }), { rootMargin: '0px 0px -8% 0px', threshold: .12 });
    els.forEach(el => io.observe(el));
  }

  // ── Phones that move while they are on screen ──────────────────
  const scenes = {
    // The dashboard: numbers count up, the group bars fill.
    dash(ui) {
      $$('.u-tiles b', ui).forEach(b => {
        const target = parseFloat(b.textContent.replace(/,/g, ''));
        const pct = /%/.test(b.textContent);
        const t0 = performance.now();
        const step = now => {
          const k = Math.min(1, (now - t0) / 1400), e = 1 - Math.pow(1 - k, 3);
          const v = Math.round(target * e);
          b.textContent = (pct ? v + '%' : v.toLocaleString('en-US'));
          if (k < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      ui.classList.add('play');
    },
    // The mock test: the clock runs down, the chosen answer moves on.
    mock(ui) {
      const clock = ui.querySelector('.u-timer b');
      const opts = $$('.u-opt', ui);
      let s = 35 * 60 - 1, k = 1;
      return setInterval(() => {
        s = s > 0 ? s - 1 : 35 * 60 - 1;
        clock.textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
        if (s % 3 === 0) { opts.forEach(o => o.classList.remove('on')); k = (k + 1) % opts.length; opts[k].classList.add('on'); }
      }, 1000);
    },
    // The question bank: units get picked one at a time, then it starts.
    bank(ui) {
      const units = $$('.u-chips', ui)[0];
      const chips = units ? $$('span', units) : [];
      let i = 0;
      return setInterval(() => {
        chips.forEach((c, j) => c.classList.toggle('on', j <= i % chips.length));
        i++;
        ui.classList.toggle('play', i % chips.length === 0);
      }, 900);
    },
    // The report: the rows arrive, the marks pop in.
    report(ui) { ui.classList.add('play'); },
    // Protection: the warning drops in every few seconds.
    protect(ui) {
      const w = ui.querySelector('.u-warn');
      const go = () => { w.classList.remove('drop'); void w.offsetWidth; w.classList.add('drop'); };
      go();
      return setInterval(go, 5000);
    },
  };
  function phones() {
    if (still || !('IntersectionObserver' in window)) return;
    const timers = new Map();
    const io = new IntersectionObserver(entries => entries.forEach(e => {
      const ui = e.target, name = ui.dataset.scene;
      if (e.isIntersecting && !timers.has(ui)) timers.set(ui, scenes[name](ui) || 0);
      else if (!e.isIntersecting && timers.has(ui)) { clearInterval(timers.get(ui)); timers.delete(ui); ui.classList.remove('play'); }
    }), { threshold: .3 });
    $$('.ui[data-scene]').forEach(ui => {
      $$('.u-row', ui).forEach((r, i) => r.style.setProperty('--i', i));   // the order the rows arrive in
      if (scenes[ui.dataset.scene]) io.observe(ui);
    });
  }

  // ── A gentle tilt on the hero phone, following the pointer ─────
  function tilt() {
    const wrap = document.querySelector('.h-phone-wrap');
    const phone = wrap && wrap.querySelector('.phone');
    if (still || !phone || !matchMedia('(hover: hover)').matches) return;
    document.querySelector('.h-hero').addEventListener('pointermove', e => {
      const r = wrap.getBoundingClientRect();
      const x = (e.clientX - (r.left + r.width / 2)) / r.width, y = (e.clientY - (r.top + r.height / 2)) / r.height;
      phone.style.transform = `rotate(3deg) rotateY(${(x * 10).toFixed(2)}deg) rotateX(${(-y * 8).toFixed(2)}deg)`;
    });
  }

  // ── The one-time card ───────────────────────────────────────────
  // Once a visitor is half way down the page, a small card offers the
  // call. Once per visit and closed with one tap. A student who came to
  // sign in has left from the hero long before half way.
  function nudge() {
    const KEY = 'lumen_nudge_seen';
    try { if (sessionStorage.getItem(KEY)) return; } catch (_) {}
    const card = document.getElementById('h-nudge');
    if (!card) return;
    let shown = false;
    const show = () => {
      if (shown) return;
      const half = (scrollY + innerHeight) / document.documentElement.scrollHeight > .5;
      if (!half) return;
      shown = true;
      card.hidden = false;
      requestAnimationFrame(() => card.classList.add('on'));
      try { sessionStorage.setItem(KEY, '1'); } catch (_) {}
      removeEventListener('scroll', show);
    };
    addEventListener('scroll', show, { passive: true });
    card.querySelector('.h-nudge-x').addEventListener('click', () => {
      card.classList.remove('on');
      setTimeout(() => { card.hidden = true; }, 300);
    });
  }

  // ── The nav takes a shadow once the page moves under it ────────
  function navShadow() {
    const nav = document.querySelector('.nav');
    if (!nav) return;
    const set = () => nav.classList.toggle('scrolled', scrollY > 8);
    set();
    addEventListener('scroll', set, { passive: true });
  }

  document.addEventListener('DOMContentLoaded', () => { reveal(); phones(); tilt(); nudge(); navShadow(); });
})();
