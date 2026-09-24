import { createHash } from 'node:crypto';
import { admin } from './_lib/supabase.js';
import { handler, HttpError, authenticate, requireRoles, requirePerm, tenantFor, assertTenant, logActivity } from './_lib/auth.js';
import { cleanName, cleanText } from './_lib/util.js';
import { normalizeQuestionText } from './_lib/questions.js';

// Saving a test means writing the test row and replacing its whole
// question list. Doing that from the browser is two calls with a window
// between them where a student could load a test whose questions have
// been deleted but not yet rewritten. One call, server-side, closes it.
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

  // Everything on the test goes into the bank, so a question typed once
  // is available to every test after this one — which is the whole point
  // of having a bank, and was not true while the only way in was to fill
  // it by hand first.
  //
  // Not fatal: the test exists by this line, and a bank write that fails
  // must not report a test the teacher can see as having failed to save.
  // The count comes back either way so the page can say what happened.
  const banked = await fileIntoBank(teacherId, questions, {
    course_id: body.course_id,
    module_id: body.module_id || null,
    lesson_id: body.lesson_id || null,
    section_id: body.section_id || null,
  });

  await logActivity(teacherId, profile, body.test_id ? 'test_updated' : 'test_created',
    `${title} · ${questions.length} question${questions.length === 1 ? '' : 's'}`);

  return res.status(200).json({
    test_id: testId,
    question_count: questions.length,
    banked: banked.filed,
    corrected: banked.corrected || 0,
    bank_error: banked.error || null,
  });
});

// ── Filing into the question bank ─────────────────────────────────
// A question picked onto three tests must not become three copies of
// itself in the bank, so each is identified by md5 of its text —
// `question_bank.text_key` is the same hash, generated in Postgres, and
// the index on it is what makes this a lookup rather than a scan.
//
// Hashes rather than the texts themselves because these go out as a
// query string: 300 questions of 2000 characters is a URL no proxy will
// carry, while 300 hashes chunked into hundreds is comfortably small.
const BANK_LOOKUP_CHUNK = 100;

async function fileIntoBank(teacherId, questions, tags) {
  // The same question can appear twice in one paste. The bank gets one.
  //
  // Hashed after normalising, and stored normalised, so the two agree:
  // question_bank.text_key is md5 of whatever text the row ends up
  // holding, and a trigger normalises that on the way in. Hashing the
  // raw text here would look up a hash the table never stores, decide
  // every question was new, and file the bank full of near-copies —
  // which is exactly what it used to do.
  const wanted = new Map();
  for (const q of questions) {
    const text = normalizeQuestionText(q.question_text);
    const key = createHash('md5').update(text).digest('hex');
    if (!wanted.has(key)) wanted.set(key, { ...q, question_text: text });
  }

  try {
    const existing = [];
    const keys = [...wanted.keys()];
    for (let i = 0; i < keys.length; i += BANK_LOOKUP_CHUNK) {
      const { data, error } = await admin
        .from('question_bank').select('id, text_key, course_id, module_id, section_id, options, explanation')
        .eq('teacher_id', teacherId).in('text_key', keys.slice(i, i + BANK_LOOKUP_CHUNK));
      if (error) throw new Error(error.message);
      existing.push(...(data || []));
    }

    const known = new Set(existing.map(r => r.text_key));
    const fresh = [...wanted].filter(([key]) => !known.has(key)).map(([, q]) => q);

    let filed = 0;
    if (fresh.length) {
      const row = (q) => ({
        teacher_id: teacherId,
        course_id: tags.course_id,
        module_id: tags.module_id,
        lesson_id: tags.lesson_id,
        section_id: tags.section_id,
        question_text: q.question_text,
        options: q.options,
        explanation: q.explanation,
        image_url: q.image_url,
        is_published: true,
        // Held back from practice, unlike a question written straight
        // into the bank. This one arrived on a paper: practice shows the
        // answer, and a paper that has not opened yet would be rehearsed
        // by the students about to sit it. The teacher can let it into
        // practice from the bank whenever the test is behind them.
        practice_ok: false,
      });

      const { error } = await admin.from('question_bank').insert(fresh.map(row));
      filed = fresh.length;

      // 23505 is the unique index on (teacher_id, text_key) refusing a
      // question that was already there — either because a save a moment
      // ago filed it between the lookup above and this insert, or
      // because Postgres normalised the text to something the hash here
      // did not predict. Neither is a reason to lose the other
      // forty-nine questions, so they go in one at a time and the ones
      // already present are simply not counted.
      if (error?.code === '23505') {
        filed = 0;
        for (const q of fresh) {
          const { error: one } = await admin.from('question_bank').insert(row(q));
          if (!one) filed++;
          else if (one.code !== '23505') throw new Error(one.message);
        }
      } else if (error) {
        throw new Error(error.message);
      }
    }

    // A question already filed keeps the labels it has: the same question
    // can be right for two lessons, and the last test to use it does not
    // get to overwrite where it was filed. A blank is a different matter —
    // one that was never placed adopts this test's, which is what makes
    // the filters worth anything on a bank filled before any of this
    // existed.
    //
    // Each label is decided on its own, because a question can easily
    // know its unit and not its section: filling both or neither would
    // leave half the bank unfilterable the day a teacher adds sections.
    const groups = new Map();
    for (const row of existing) {
      const patch = {};
      if (tags.module_id && !row.module_id) {
        patch.module_id = tags.module_id;
        patch.lesson_id = tags.lesson_id;
      }
      if (tags.section_id && !row.section_id) patch.section_id = tags.section_id;
      // The course goes with the unit. Setting one and not the other is
      // what left questions holding a unit and no course — and the bank
      // only offers its unit filter once a course is picked, so both
      // filters are live together and such a question matched the unit,
      // failed the course, and disappeared from a search that should
      // have found it.
      if (tags.course_id && !row.course_id) patch.course_id = tags.course_id;
      if (!Object.keys(patch).length) continue;

      // Rows wanting the same patch are updated together rather than one
      // request each: a fifty-question paper is one or two round trips.
      const key = JSON.stringify(patch);
      if (!groups.has(key)) groups.set(key, { patch, ids: [] });
      groups.get(key).ids.push(row.id);
    }

    for (const { patch, ids } of groups.values()) {
      for (let i = 0; i < ids.length; i += BANK_LOOKUP_CHUNK) {
        await admin.from('question_bank').update(patch).in('id', ids.slice(i, i + BANK_LOOKUP_CHUNK));
      }
    }

    // A correction made on the test goes back to the bank. Fixing which
    // option is right on the paper and leaving the bank wrong means the
    // next test built from it is wrong again — so the answer travels,
    // and the teacher is told how many rows it reached.
    //
    // Only the answers and the explanation. The question TEXT is what
    // identifies the row: rewording it makes a different question, which
    // is filed as new above and leaves the original alone.
    let corrected = 0;
    for (const row of existing) {
      const q = wanted.get(row.text_key);
      // No options to compare against is not the same as options that
      // differ: a row we cannot read is left exactly as it is rather
      // than being overwritten with this test's answer.
      if (!q || !Array.isArray(row.options)) continue;
      const patch = {};
      if (!sameOptions(row.options, q.options)) patch.options = q.options;
      if ((q.explanation || null) !== (row.explanation || null) && q.explanation) {
        patch.explanation = q.explanation;
      }
      if (!Object.keys(patch).length) continue;
      const { error } = await admin.from('question_bank').update(patch).eq('id', row.id);
      if (!error) corrected++;
    }

    return { filed, corrected };
  } catch (err) {
    console.error('Filing questions into the bank failed:', err);
    return { filed: 0, corrected: 0, error: 'Those questions were not added to your question bank.' };
  }
}

// Same options, in the same order, with the same ones marked correct.
// Compared field by field rather than by JSON.stringify: what comes back
// from Postgres carries whatever keys were written, and a key order that
// differs is not a difference in the question.
function sameOptions(a, b) {
  const left = Array.isArray(a) ? a : [];
  const right = Array.isArray(b) ? b : [];
  if (left.length !== right.length) return false;
  return left.every((o, i) =>
    String(o?.text ?? '') === String(right[i]?.text ?? '') &&
    !!o?.correct === !!right[i]?.correct);
}

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
      question_text: text.slice(0, 2000),
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
