// ─────────────────────────────────────────────────────────────────
// Mock tests and FRQs: one page each, the same layout. Every paper of
// that kind on the student's courses, grouped by unit (a paper on the
// whole course is a "Full exam"), as cards: what it is, where they
// stand on it, and one button.
// ─────────────────────────────────────────────────────────────────
const PAPER_PAGES = {
  mock: { word: 'Mock tests', lead: 'Full papers under exam conditions. Sit one, then sit it again for a better mark.', none: 'No mock tests yet. When your teacher sets one, it appears here.' },
  frq:  { word: 'FRQs', lead: 'Free-response questions, marked point by point against the official scoring guidelines.', none: 'No FRQs yet. When your teacher sets one, it appears here.' },
};

async function drawPapers(kind) {
  const page = PAPER_PAGES[kind];
  const host = document.getElementById('papers');
  host.innerHTML = '<div class="skel" style="height:140px"></div>';

  const [{ data: tests, error }, { data: attempts }, { data: setForMe }] = await Promise.all([
    sb.from('practice_tests')
      .select('*, courses(title), modules(title, order_index), lessons(title)')
      .eq('kind', kind).eq('is_active', true).order('order_index').order('created_at'),
    sb.from('test_attempts').select('test_id, percentage, score, max_score, passed, completed_at')
      .eq('student_id', me.id).not('completed_at', 'is', null),
    sb.from('test_assignments').select('test_id, due_at'),
  ]);

  const course = (tests || [])[0]?.courses?.title || '';
  document.getElementById('hero').innerHTML = `
    <div class="crumbs"><a href="/portal/courses.html">My courses</a>${course ? `<span class="sep">›</span><span>${escHtml(course)}</span>` : ''}<span class="sep">›</span><span>${page.word}</span></div>
    <h1>${course ? `<span class="soft">${escHtml(course)}</span> ` : ''}${page.word}</h1>
    <p>${page.lead}</p>`;

  // Before the teacher's database has been updated for mock tests, the
  // kind column does not exist: that is "none yet", not an error.
  if (error || !(tests || []).length) {
    host.innerHTML = `<div class="card"><div class="card-body">${emptyState('Nothing here yet', page.none)}</div></div>`;
    return;
  }

  const best = new Map();
  (attempts || []).forEach(a => {
    const cur = best.get(a.test_id);
    if (!cur || parseFloat(a.percentage) > parseFloat(cur.percentage)) best.set(a.test_id, a);
  });
  const due = new Map();
  (setForMe || []).forEach(a => {
    if (a.due_at && (!due.get(a.test_id) || a.due_at < due.get(a.test_id))) due.set(a.test_id, a.due_at);
  });

  const groups = new Map();
  for (const t of tests.filter(t => !t.is_offline)) {
    const key = t.module_id ? 'm' + t.module_id : 'full';
    if (!groups.has(key)) groups.set(key, { title: t.modules?.title || 'Full exams', order: t.modules ? t.modules.order_index : 1e9, tests: [] });
    groups.get(key).tests.push(t);
  }

  host.innerHTML = [...groups.values()].sort((a, b) => a.order - b.order).map(g => {
    const mins = g.tests.reduce((n, t) => n + (t.time_limit_min || 0), 0);
    const doneCount = g.tests.filter(t => best.has(t.id)).length;
    return `<section class="study-group">
      <div class="group-head"><h2>${escHtml(g.title)}</h2>
        <span class="chip">${g.tests.length} paper${g.tests.length === 1 ? '' : 's'}</span>
        ${mins ? `<span class="chip">${mins >= 60 ? (mins / 60).toFixed(mins % 60 ? 1 : 0) + ' hours' : mins + ' min'}</span>` : ''}
        ${doneCount ? `<span class="chip sun">${doneCount} done</span>` : ''}</div>
      <div class="card-grid">${g.tests.map(t => paperCard(t, best.get(t.id), due.get(t.id))).join('')}</div>
    </section>`;
  }).join('');
}

function paperCard(t, best, dueAt) {
  const w = testWindow(t, new Date());
  const late = dueAt && new Date(dueAt) < new Date();
  const meta = [
    t.lessons?.title || null,
    t.time_limit_min ? t.time_limit_min + ' min' : null,
    `pass at ${t.passing_score_pct}%`,
    dueAt ? `${late ? 'was due' : 'due'} ${fmtDateTime(dueAt)}` : null,
  ].filter(Boolean).join(' · ');
  const status = best
    ? `<div class="sc-status ${best.passed ? 'ok' : 'bad'}">${best.passed ? 'Passed' : 'Not passed'} · best ${mark(best)}</div>`
    : `<div class="sc-status${late ? ' bad' : ''}">${late ? 'Late · not started' : 'Paper not started'}</div>`;
  const action = w.open
    ? `<a class="sc-btn${best ? ' again' : ''}" href="/portal/take-test.html?id=${t.id}">${best ? 'Try again' : 'Start paper'}</a>`
    : `<div class="sc-btn wait">${escHtml(w.label)}</div>`;
  return `<div class="study-card">
    <div class="sc-title">${escHtml(t.title)}</div>
    <div class="sc-meta">${escHtml(meta)}</div>
    ${status}${action}
  </div>`;
}
