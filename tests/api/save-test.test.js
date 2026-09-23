import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';

vi.mock('@supabase/supabase-js', () => import('../helpers/supabase-mock.js'));

import {
  resetSupabaseMock, configureSupabaseMock, getSupabaseCalls,
  TEACHER_USER, ASSISTANT_USER, STUDENT_USER, TEACHER_ID, OTHER_TEACHER_ID,
} from '../helpers/supabase-mock.js';
import { asUser } from '../helpers/as.js';
import { makeReq, makeRes } from '../helpers/http.js';
import handler from '../../api/save-test.js';

const COURSE = 'course-1';
const Q = () => ({
  question_text: 'Which organelle makes ATP?',
  options: [{ text: 'Ribosome', correct: false }, { text: 'Mitochondrion', correct: true }],
});

// assertTenant reads the row back and compares its teacher_id.
function ownedBy(teacherId) {
  return {
    'courses.select':         { data: { id: COURSE, teacher_id: teacherId }, error: null },
    'modules.select':         { data: { id: 'unit-1', teacher_id: teacherId }, error: null },
    'practice_tests.select':  { data: { id: 'test-1', teacher_id: teacherId }, error: null },
    'practice_tests.insert':  { data: { id: 'test-new' }, error: null },
  };
}

async function call(body) {
  const res = makeRes();
  await handler(makeReq({ body }), res);
  return res;
}

beforeEach(() => {
  resetSupabaseMock();
  asUser(TEACHER_USER);
  configureSupabaseMock({ results: ownedBy(TEACHER_ID) });
});

describe('saving a test', () => {
  it('writes the test and its questions in one call', async () => {
    const res = await call({ title: 'Unit 1 quiz', course_id: COURSE, questions: [Q(), Q()] });

    expect(res.statusCode).toBe(200);
    // Both copies go on the test; the bank gets one, because they are
    // the same question twice.
    expect(res.body).toEqual({ test_id: 'test-new', question_count: 2, banked: 1, bank_error: null });

    const [inserted] = getSupabaseCalls('test_questions.insert');
    expect(inserted.payload).toHaveLength(2);
    expect(inserted.payload[0]).toMatchObject({ teacher_id: TEACHER_ID, test_id: 'test-new', order_index: 0 });
    expect(inserted.payload[1].order_index).toBe(1);
  });

  it('replaces the old questions when editing', async () => {
    const res = await call({ test_id: 'test-1', title: 'Unit 1 quiz', course_id: COURSE, questions: [Q()] });

    expect(res.statusCode).toBe(200);
    // Delete then insert, in that order: a student must never be able to
    // load a test whose questions are half written.
    const ops = getSupabaseCalls().filter(c => c.table === 'test_questions').map(c => c.op);
    expect(ops).toEqual(['delete', 'insert']);
  });

  it('refuses a question with no correct answer', async () => {
    const res = await call({
      title: 'Quiz', course_id: COURSE,
      questions: [{ question_text: 'Q?', options: [{ text: 'a' }, { text: 'b' }] }],
    });
    // Otherwise the whole class is marked wrong and nothing on the results
    // page says the question, not the students, was at fault.
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/no correct answer/i);
    expect(getSupabaseCalls('test_questions.insert')).toHaveLength(0);
  });

  it('names the question that is wrong', async () => {
    const res = await call({
      title: 'Quiz', course_id: COURSE,
      questions: [Q(), { question_text: 'Q?', options: [{ text: 'only one', correct: true }] }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/Question 2/);
  });

  it('refuses an empty question list', async () => {
    const res = await call({ title: 'Quiz', course_id: COURSE, questions: [] });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a course in another tenant', async () => {
    configureSupabaseMock({ results: ownedBy(OTHER_TEACHER_ID) });
    const res = await call({ title: 'Quiz', course_id: COURSE, questions: [Q()] });
    expect(res.statusCode).toBe(403);
    expect(getSupabaseCalls('practice_tests.insert')).toHaveLength(0);
  });

  it('refuses a test id in another tenant', async () => {
    configureSupabaseMock({
      results: { ...ownedBy(TEACHER_ID), 'practice_tests.select': { data: { id: 'test-1', teacher_id: OTHER_TEACHER_ID }, error: null } },
    });
    const res = await call({ test_id: 'test-1', title: 'Quiz', course_id: COURSE, questions: [Q()] });
    expect(res.statusCode).toBe(403);
  });

  it('refuses a window that closes before it opens', async () => {
    const res = await call({
      title: 'Quiz', course_id: COURSE, questions: [Q()],
      open_at: '2026-05-10T10:00:00Z', close_at: '2026-05-10T09:00:00Z',
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/close before it opens/i);
  });

  it('accepts a window the right way round', async () => {
    const res = await call({
      title: 'Quiz', course_id: COURSE, questions: [Q()],
      open_at: '2026-05-10T09:00:00Z', close_at: '2026-05-10T10:00:00Z',
    });
    expect(res.statusCode).toBe(200);
  });

  it('clamps a nonsense pass mark instead of storing it', async () => {
    const res = await call({ title: 'Quiz', course_id: COURSE, passing_score_pct: 500, questions: [Q()] });
    expect(res.statusCode).toBe(200);
    expect(getSupabaseCalls('practice_tests.insert')[0].payload.passing_score_pct).toBe(100);
  });

  it('needs a course', async () => {
    const res = await call({ title: 'Quiz', questions: [Q()] });
    expect(res.statusCode).toBe(400);
  });

  it('turns away a student', async () => {
    asUser(STUDENT_USER);
    const res = await call({ title: 'Quiz', course_id: COURSE, questions: [Q()] });
    expect(res.statusCode).toBe(403);
  });

  it('turns away an assistant without the tests permission', async () => {
    asUser(ASSISTANT_USER, { profile: { staff_perms: ['students'] } });
    const res = await call({ title: 'Quiz', course_id: COURSE, questions: [Q()] });
    expect(res.statusCode).toBe(403);
  });
});

describe('the unit and the lesson', () => {
  const inUnit = (moduleId) => ({
    'lessons.select': { data: { id: 'lesson-1', teacher_id: TEACHER_ID, module_id: moduleId }, error: null },
  });

  it('stores both on the test', async () => {
    configureSupabaseMock({ results: inUnit('unit-1') });
    const res = await call({
      title: 'Quiz', course_id: COURSE, module_id: 'unit-1', lesson_id: 'lesson-1', questions: [Q()],
    });

    expect(res.statusCode).toBe(200);
    expect(getSupabaseCalls('practice_tests.insert')[0].payload)
      .toMatchObject({ module_id: 'unit-1', lesson_id: 'lesson-1' });
  });

  it('refuses a lesson that is not in the unit chosen with it', async () => {
    // Otherwise a Unit 1 test could be filed under a Unit 4 lesson and
    // show up in two places in the student portal.
    configureSupabaseMock({ results: inUnit('unit-4') });
    const res = await call({
      title: 'Quiz', course_id: COURSE, module_id: 'unit-1', lesson_id: 'lesson-1', questions: [Q()],
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/not in the unit/i);
    expect(getSupabaseCalls('practice_tests.insert')).toHaveLength(0);
  });

  it('refuses a lesson with no unit named', async () => {
    const res = await call({ title: 'Quiz', course_id: COURSE, lesson_id: 'lesson-1', questions: [Q()] });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/unit/i);
  });

  it('refuses a lesson in another tenant', async () => {
    configureSupabaseMock({ results: {
      'lessons.select': { data: { id: 'lesson-1', teacher_id: OTHER_TEACHER_ID, module_id: 'unit-1' }, error: null },
    } });
    const res = await call({
      title: 'Quiz', course_id: COURSE, module_id: 'unit-1', lesson_id: 'lesson-1', questions: [Q()],
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('filing the questions into the bank', () => {
  it('files what the bank does not already hold, tagged with the test’s unit', async () => {
    const res = await call({
      title: 'Quiz', course_id: COURSE, module_id: 'unit-1',
      questions: [Q(), { ...Q(), question_text: 'What pairs with adenine?' }],
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.banked).toBe(2);

    const [filed] = getSupabaseCalls('question_bank.insert');
    expect(filed.payload).toHaveLength(2);
    expect(filed.payload[0]).toMatchObject({
      teacher_id: TEACHER_ID, course_id: COURSE, module_id: 'unit-1', lesson_id: null, is_published: true,
    });
  });

  it('skips a question the bank already holds', async () => {
    // md5 of the question text, matching question_bank.text_key. A
    // question picked onto three tests must not become three copies.
    const key = createHash('md5').update(Q().question_text).digest('hex');
    configureSupabaseMock({ results: {
      'question_bank.select': { data: [{ id: 'bank-1', text_key: key, module_id: 'unit-1' }], error: null },
    } });

    const res = await call({ title: 'Quiz', course_id: COURSE, module_id: 'unit-1', questions: [Q()] });

    expect(res.statusCode).toBe(200);
    expect(res.body.banked).toBe(0);
    expect(getSupabaseCalls('question_bank.insert')).toHaveLength(0);
  });

  it('gives a question that was never placed the test’s unit', async () => {
    const key = createHash('md5').update(Q().question_text).digest('hex');
    configureSupabaseMock({ results: {
      'question_bank.select': { data: [{ id: 'bank-1', text_key: key, module_id: null }], error: null },
    } });

    const res = await call({
      title: 'Quiz', course_id: COURSE, module_id: 'unit-1', lesson_id: null, questions: [Q()],
    });

    expect(res.statusCode).toBe(200);
    expect(getSupabaseCalls('question_bank.update')[0].payload)
      .toEqual({ module_id: 'unit-1', lesson_id: null });
  });

  it('leaves a question that already has a unit alone', async () => {
    // The same question can be right for two lessons, and the last test
    // to use it does not get to overwrite where it was filed.
    const key = createHash('md5').update(Q().question_text).digest('hex');
    configureSupabaseMock({ results: {
      'question_bank.select': { data: [{ id: 'bank-1', text_key: key, module_id: 'unit-9' }], error: null },
    } });

    const res = await call({ title: 'Quiz', course_id: COURSE, module_id: 'unit-1', questions: [Q()] });

    expect(res.statusCode).toBe(200);
    expect(getSupabaseCalls('question_bank.update')).toHaveLength(0);
  });

  it('saves the test even when the bank write fails', async () => {
    configureSupabaseMock({ results: {
      'question_bank.insert': { data: null, error: { message: 'boom' } },
    } });

    const res = await call({ title: 'Quiz', course_id: COURSE, questions: [Q()] });

    // The test exists by then. Reporting it as failed would have the
    // teacher build it a second time.
    expect(res.statusCode).toBe(200);
    expect(res.body.test_id).toBe('test-new');
    expect(res.body.banked).toBe(0);
    expect(res.body.bank_error).toMatch(/question bank/i);
  });
});
