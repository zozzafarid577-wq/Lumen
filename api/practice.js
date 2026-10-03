import { randomInt } from 'node:crypto';
import { admin } from './_lib/supabase.js';
import { handler, HttpError, authenticate, requireRoles } from './_lib/auth.js';

// Practice from the question bank, for students.
//
// The bank itself is closed to students and stays that way: every row in
// it carries which option is correct, and tests are built by copying rows
// out of it, so a student who could read the table would hold the answers
// to every paper their teacher has set or is about to set. There is
// deliberately no row-level-security policy letting them near it.
//
// This endpoint is the only way in, and it never hands over a bank row.
// It sends question text and option text with `correct` stripped off, and
// marks one answer at a time on the server. Nothing it returns is written
// to test_attempts — practice is not a mark, and a student can do as much
// of it as they like without it counting for or against them.
//
// What a student may practise is exactly what they may already see: a
// question filed under a unit of a course they are enrolled on, where the
// unit has been released. A question on a unit still being written, or on
// a course they are not on, is not served — not filtered in the browser,
// but never sent.

const MAX_QUESTIONS = 30;

export default handler(async (req, res) => {
  const { profile } = await authenticate(req);
  requireRoles(profile, ['student']);
  if (!profile.teacher_id) throw new HttpError(403, 'This account is not attached to a teacher.');

  const body = req.body || {};
  if (body.action === 'check') return check(req, res, profile, body);
  if (body.action === 'available') return available(req, res, profile, body);
  if (body.action === 'menu') return menu(req, res, profile, body);
  return serve(req, res, profile, body);
});

// ── Where there is anything to practise ───────────────────────────
// The course page cannot count bank questions itself — the bank is closed
// to students — so it asks here, and offers Practice only on the units
// that have something in them. Counts only; no question text leaves.

async function available(req, res, profile, body) {
  const courseId = body.course_id;
  if (!courseId) throw new HttpError(400, 'Choose a course.');

  const { data: enrolment } = await admin.from('enrollments')
    .select('course_id').eq('student_id', profile.id).eq('course_id', courseId).maybeSingle();
  if (!enrolment) throw new HttpError(403, 'You are not enrolled on that course.');

  const { data: units } = await admin.from('modules')
    .select('id, is_done, open_at').eq('teacher_id', profile.teacher_id).eq('course_id', courseId);

  const now = new Date();
  const openIds = (units || []).filter(u => u.is_done && (!u.open_at || new Date(u.open_at) <= now)).map(u => u.id);
  if (!openIds.length) return res.status(200).json({ units: {} });

  const { data: rows } = await admin.from('question_bank')
    .select('module_id').eq('teacher_id', profile.teacher_id)
    .eq('is_published', true).eq('practice_ok', true).in('module_id', openIds);

  const counts = {};
  (rows || []).forEach(r => { counts[r.module_id] = (counts[r.module_id] || 0) + 1; });
  return res.status(200).json({ units: counts });
}

// ── The practice menu ─────────────────────────────────────────────
// What the practice screen offers a student, step by step: their open
// units, the lessons in each, and Vocabulary / Grammar — each with how
// many questions are behind it, so nothing on the menu leads to an empty
// page. Counts only, like `available`; no question text leaves.

async function menu(req, res, profile, body) {
  const { data: enrolments } = await admin.from('enrollments')
    .select('course_id, courses(id, title, order_index)').eq('student_id', profile.id);
  let courses = (enrolments || []).map(e => e.courses).filter(Boolean)
    .sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0) || a.title.localeCompare(b.title));
  if (body.course_id) courses = courses.filter(c => c.id === body.course_id);
  if (!courses.length) return res.status(200).json({ courses: [] });

  const now = new Date();
  const { data: units } = await admin.from('modules')
    .select('id, title, course_id, order_index, is_done, open_at, lessons(id, title, order_index)')
    .eq('teacher_id', profile.teacher_id).in('course_id', courses.map(c => c.id));
  const open = (units || []).filter(u => u.is_done && (!u.open_at || new Date(u.open_at) <= now));
  if (!open.length) return res.status(200).json({ courses: courses.map(c => ({ ...c, units: [] })) });

  const { data: rows } = await admin.from('question_bank')
    .select('module_id, lesson_id, section_id').eq('teacher_id', profile.teacher_id)
    .eq('is_published', true).eq('practice_ok', true).in('module_id', open.map(u => u.id));
  const { data: sections } = await admin.from('test_sections')
    .select('id, name, color, order_index').eq('teacher_id', profile.teacher_id);
  const sectionById = new Map((sections || []).map(s => [s.id, s]));

  const count = (list, key) => list.reduce((m, r) => { const k = key(r) || ''; m[k] = (m[k] || 0) + 1; return m; }, {});
  const byUnit = new Map();
  (rows || []).forEach(r => { if (!byUnit.has(r.module_id)) byUnit.set(r.module_id, []); byUnit.get(r.module_id).push(r); });

  const shapeUnit = (u) => {
    const mine = byUnit.get(u.id) || [];
    const lessons = (u.lessons || []).sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0))
      .map(l => {
        const here = mine.filter(r => r.lesson_id === l.id);
        return { id: l.id, title: l.title, count: here.length, sections: count(here, r => r.section_id) };
      });
    const loose = mine.filter(r => !r.lesson_id || !(u.lessons || []).some(l => l.id === r.lesson_id));
    return {
      id: u.id, title: u.title, count: mine.length,
      lessons: lessons.filter(l => l.count),
      // Questions filed on the unit but no lesson: offered as their own
      // choice rather than lost.
      unfiled: loose.length ? { count: loose.length, sections: count(loose, r => r.section_id) } : null,
    };
  };

  return res.status(200).json({
    courses: courses.map(c => ({
      id: c.id, title: c.title,
      units: open.filter(u => u.course_id === c.id)
        .sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0))
        .map(shapeUnit).filter(u => u.count),
    })),
    sections: [...new Set((rows || []).map(r => r.section_id).filter(Boolean))]
      .map(id => sectionById.get(id)).filter(Boolean)
      .sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0))
      .map(s => ({ id: s.id, name: s.name, color: s.color })),
  });
}

// ── Handing out questions ─────────────────────────────────────────

async function serve(req, res, profile, body) {
  const unit = await openUnitFor(profile, body.module_id);

  let q = admin.from('question_bank')
    .select('id, question_text, options, difficulty, topic, lesson_id')
    .eq('teacher_id', profile.teacher_id)
    .eq('module_id', unit.id)
    .eq('is_published', true)
    // Held back for the paper. See practice_ok in supabase-migration-v3.
    .eq('practice_ok', true);

  // Lessons narrow it further — one, or several picked together — for
  // practising one evening's work rather than the whole unit. 'unfiled'
  // stands for the unit's questions that sit on no lesson.
  const lessonIds = Array.isArray(body.lesson_ids) ? body.lesson_ids : (body.lesson_id ? [body.lesson_id] : []);
  const real = lessonIds.filter(id => id !== 'unfiled');
  const wantLoose = lessonIds.includes('unfiled');
  for (const id of real) await lessonInUnit(id, unit, profile.teacher_id);
  if (real.length === 1 && !wantLoose) q = q.eq('lesson_id', real[0]);
  else if (real.length && !wantLoose) q = q.in('lesson_id', real);
  else if (!real.length && wantLoose) q = q.is('lesson_id', null);
  // Lessons and the unit's loose questions together are narrowed below,
  // once the rows are in.

  // Vocabulary, Grammar, or both: by the section the teacher filed each
  // question under. No sections named means everything.
  const sectionIds = (Array.isArray(body.section_ids) ? body.section_ids : [])
    .filter(id => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id));
  if (sectionIds.length) q = q.in('section_id', sectionIds);

  const { data, error } = await q.limit(500);
  if (error) throw new HttpError(500, 'Those questions could not be loaded. Please try again.');

  const pool = real.length && wantLoose
    ? (data || []).filter(r => !r.lesson_id || real.includes(r.lesson_id))
    : (data || []);
  const rows = shuffle(pool).slice(0, clampCount(body.count));

  return res.status(200).json({
    unit: { id: unit.id, title: unit.title },
    questions: rows.map(r => ({
      id: r.id,
      question_text: r.question_text,
      difficulty: r.difficulty,
      topic: r.topic,
      // `correct` is dropped here and nowhere else. The whole point of
      // this endpoint is that the browser never receives it.
      options: (r.options || []).map(o => ({ text: o?.text ?? '' })),
      // How many to tick. Saying so gives away nothing — a student can
      // count the boxes either way — and not saying so makes a
      // two-answer question unanswerable.
      answers: (r.options || []).filter(o => o?.correct).length || 1,
    })),
  });
}

// ── Marking one answer ────────────────────────────────────────────

async function check(req, res, profile, body) {
  const { data: row, error } = await admin.from('question_bank')
    .select('id, teacher_id, module_id, options, explanation, is_published, practice_ok')
    .eq('id', body.question_id || '').single();

  if (error || !row) throw new HttpError(404, 'That question no longer exists.');
  // practice_ok is checked here as well as on the way out: a teacher who
  // holds a question back while a student has it on screen must not have
  // its answer handed over by the mark that follows.
  if (row.teacher_id !== profile.teacher_id || !row.is_published || row.practice_ok === false) {
    throw new HttpError(403, 'That question is not yours to practise.');
  }
  // Checked again on the way back, not just on the way out: an id kept
  // from an earlier session must not outlive the student's access to the
  // unit it came from.
  await openUnitFor(profile, row.module_id);

  const right = (row.options || []).map((o, i) => (o?.correct ? i : -1)).filter(i => i >= 0);
  const chosen = [...new Set(
    (Array.isArray(body.chosen) ? body.chosen : [body.chosen])
      .map(Number).filter(n => Number.isInteger(n) && n >= 0 && n < (row.options || []).length)
  )];

  // All of them and nothing else — the same rule the marked tests use, so
  // practice does not teach a student a gentler one.
  const correct = chosen.length === right.length && right.every(i => chosen.includes(i));

  return res.status(200).json({ correct, right, explanation: row.explanation || null });
}

// ── The two things that have to be true ───────────────────────────

// The unit exists, belongs to this student's teacher, sits on a course
// they are enrolled on, and has been released to them.
async function openUnitFor(profile, moduleId) {
  if (!moduleId) throw new HttpError(400, 'Choose a unit to practise.');

  const { data: unit, error } = await admin
    .from('modules').select('id, title, teacher_id, course_id, is_done, open_at')
    .eq('id', moduleId).single();

  if (error || !unit) throw new HttpError(404, 'That unit no longer exists.');
  if (unit.teacher_id !== profile.teacher_id) throw new HttpError(403, 'That unit belongs to another teacher.');

  const { data: enrolment } = await admin.from('enrollments')
    .select('course_id').eq('student_id', profile.id).eq('course_id', unit.course_id).maybeSingle();
  if (!enrolment) throw new HttpError(403, 'You are not enrolled on that course.');

  if (!unit.is_done || (unit.open_at && new Date(unit.open_at) > new Date())) {
    throw new HttpError(403, 'That unit is not open yet.');
  }
  return unit;
}

async function lessonInUnit(lessonId, unit, teacherId) {
  const { data: lesson, error } = await admin
    .from('lessons').select('id, teacher_id, module_id').eq('id', lessonId).single();
  if (error || !lesson) throw new HttpError(404, 'That lesson no longer exists.');
  if (lesson.teacher_id !== teacherId || lesson.module_id !== unit.id) {
    throw new HttpError(403, 'That lesson is not in this unit.');
  }
  return lesson;
}

function clampCount(n) {
  const count = Number.isFinite(+n) ? Math.floor(+n) : 10;
  return Math.min(Math.max(count, 1), MAX_QUESTIONS);
}

// Fisher–Yates over randomInt: a student who practises the same unit
// twice should not get the same ten questions in the same order.
function shuffle(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
