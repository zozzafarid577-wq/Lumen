import { admin } from './_lib/supabase.js';
import { handler, HttpError, authenticate, requireRoles, requirePerm, tenantFor, assertTenant, logActivity } from './_lib/auth.js';
import { cleanName, cleanText } from './_lib/util.js';

// Saving a test means writing the test row and replacing its whole
// question list. Doing that from the browser is two calls with a window
// between them where a student could load a test whose questions have
// been deleted but not yet rewritten. One call, server-side, closes it.
//
// It writes to `test_questions` and nowhere else. The question bank is a
// separate collection the teacher fills from the bank page, and this
// used to file every question on every saved test into it — so a paper
// pasted in from a Word file put fifty rows into a bank nobody asked to
// have fifty rows in. A test is built FROM the bank, by picking, and
// never back into it.
export default handler(async (req, res) => {
  const { profile } = await authenticate(req);
  requireRoles(profile, ['teacher', 'assistant', 'owner']);
  requirePerm(profile, 'tests');

  const body = req.body || {};
  const teacherId = tenantFor(profile, body.teacher_id);

  const title = cleanName(body.title, 'Test title');
  const questions = normaliseQuestions(body.questions);
  if (!questions.length) throw new HttpError(400, 'A test needs at least one question.');

  if (!body.course_id) throw new HttpError(400, 'Choose which course this test belongs to.');
  await assertTenant('courses', body.course_id, teacherId);
  if (body.module_id) await assertTenant('modules', body.module_id, teacherId);
  if (body.lesson_id) await assertLessonInModule(body.lesson_id, body.module_id, teacherId);
  if (body.section_id) await assertTenant('test_sections', body.section_id, teacherId);

  const openAt  = parseWhen(body.open_at, 'open');
  const closeAt = parseWhen(body.close_at, 'close');
  if (openAt && closeAt && closeAt <= openAt) {
    throw new HttpError(400, 'The test would close before it opens. Check the two dates.');
  }

  const fields = {
    teacher_id: teacherId,
    course_id: body.course_id,
    module_id: body.module_id || null,
    lesson_id: body.lesson_id || null,
    section_id: body.section_id || null,
    title,
    description: cleanText(body.description, { max: 1000 }),
    time_limit_min: positiveIntOrNull(body.time_limit_min, 'time limit'),
    passing_score_pct: clampPct(body.passing_score_pct),
    max_attempts: positiveIntOrNull(body.max_attempts, 'attempt limit'),
    open_at: openAt ? openAt.toISOString() : null,
    close_at: closeAt ? closeAt.toISOString() : null,
    is_active: body.is_active !== false,
  };

  let testId = body.test_id || null;
  if (testId) {
    await assertTenant('practice_tests', testId, teacherId);
    const { error } = await admin.from('practice_tests').update(fields).eq('id', testId);
    if (error) throw new HttpError(500, 'Could not save that test.');
  } else {
    const { data, error } = await admin.from('practice_tests').insert(fields).select('id').single();
    if (error || !data) throw new HttpError(500, 'Could not create that test.');
    testId = data.id;
  }

  // Replace rather than reconcile: the question list is small, and a
  // reconciliation that gets an edge case wrong silently loses a question.
  const { error: delErr } = await admin.from('test_questions').delete().eq('test_id', testId);
  if (delErr) throw new HttpError(500, 'Could not update the questions on that test.');

  const { error: insErr } = await admin.from('test_questions').insert(
    questions.map((q, i) => ({
      teacher_id: teacherId,
      test_id: testId,
      question_text: q.question_text,
      options: q.options,
      explanation: q.explanation,
      image_url: q.image_url,
      order_index: i,
      points: q.points,
    }))
  );
  if (insErr) throw new HttpError(500, 'The test was saved but its questions were not. Please try again.');

  await logActivity(teacherId, profile, body.test_id ? 'test_updated' : 'test_created',
    `${title} · ${questions.length} question${questions.length === 1 ? '' : 's'}`);

  return res.status(200).json({
    test_id: testId,
    question_count: questions.length,
  });
});

// A lesson names its unit, so a test tagged with both has to agree with
// itself. Without this a request could put a Unit 1 test under a Unit 4
// lesson, and the student portal would file it in two places at once.
async function assertLessonInModule(lessonId, moduleId, teacherId) {
  if (!moduleId) throw new HttpError(400, 'Choose the unit that lesson is in as well.');

  const { data, error } = await admin
    .from('lessons').select('id, teacher_id, module_id').eq('id', lessonId).single();
  if (error || !data) throw new HttpError(404, 'That lesson no longer exists.');
  if (data.teacher_id !== teacherId) throw new HttpError(403, 'That lesson belongs to another teacher.');
  if (data.module_id !== moduleId) throw new HttpError(400, 'That lesson is not in the unit you chose.');
  return data;
}

// ── Validation ────────────────────────────────────────────────────
// A question with no correct answer marks every student wrong and there
// is no way to tell from the results page that the question, not the
// class, was at fault. Refuse it here.
function normaliseQuestions(list) {
  if (!Array.isArray(list)) throw new HttpError(400, 'No questions were sent.');
  if (list.length > 300) throw new HttpError(400, 'A test can hold at most 300 questions.');

  return list.map((raw, i) => {
    const n = i + 1;
    const text = String(raw?.question_text || '').trim();
    if (!text) throw new HttpError(400, `Question ${n} has no text.`);

    const options = Array.isArray(raw?.options) ? raw.options : [];
    if (options.length < 2) throw new HttpError(400, `Question ${n} needs at least two options.`);
    if (options.length > 8) throw new HttpError(400, `Question ${n} has too many options.`);

    const cleaned = options.map((o, j) => {
      const optText = String(o?.text ?? o ?? '').trim();
      if (!optText) throw new HttpError(400, `Question ${n}, option ${j + 1} is empty.`);
      return { text: optText.slice(0, 600), correct: o?.correct === true };
    });
    if (!cleaned.some(o => o.correct)) {
      throw new HttpError(400, `Question ${n} has no correct answer marked.`);
    }

    return {
      // Room for a reading passage above the question it belongs to.
      question_text: text.slice(0, 4000),
      options: cleaned,
      explanation: cleanText(raw?.explanation, { max: 2000 }),
      image_url: cleanText(raw?.image_url, { max: 500 }),
      points: positiveIntOrNull(raw?.points, 'points') ?? 1,
    };
  });
}

function parseWhen(value, which) {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) throw new HttpError(400, `That ${which} date is not a real date.`);
  return d;
}

function positiveIntOrNull(value, what) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `The ${what} must be a whole number above zero.`);
  return n;
}

function clampPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 60;
  return Math.min(100, Math.max(0, Math.round(n)));
}
