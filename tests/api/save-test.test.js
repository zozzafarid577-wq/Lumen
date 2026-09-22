import { describe, it, expect, beforeEach, vi } from 'vitest';

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
    expect(res.body).toEqual({ test_id: 'test-new', question_count: 2 });

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
