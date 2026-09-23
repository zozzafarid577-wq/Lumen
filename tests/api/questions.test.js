import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@supabase/supabase-js', () => import('../helpers/supabase-mock.js'));

import {
  resetSupabaseMock, configureSupabaseMock, getSupabaseCalls,
  TEACHER_USER, ASSISTANT_USER, STUDENT_USER, TEACHER_ID, OTHER_TEACHER_ID,
} from '../helpers/supabase-mock.js';
import { asUser } from '../helpers/as.js';
import { makeReq, makeRes } from '../helpers/http.js';
import handler from '../../api/questions.js';

const TEXT = `
1. Which organelle makes ATP?
A) Ribosome
*B) Mitochondrion

2. DNA replication is…
A) conservative
*B) semi-conservative
`;

async function call(body) {
  const res = makeRes();
  await handler(makeReq({ body }), res);
  return res;
}

beforeEach(() => {
  resetSupabaseMock();
  asUser(TEACHER_USER);
});

describe('importing a batch of questions', () => {
  it('previews without writing anything', async () => {
    const res = await call({ action: 'parse', text: TEXT });

    expect(res.statusCode).toBe(200);
    expect(res.body.questions).toHaveLength(2);
    expect(getSupabaseCalls('question_bank.insert')).toHaveLength(0);
  });

  it('saves them into the caller’s own tenant', async () => {
    const res = await call({ action: 'import', text: TEXT, topic: 'Cell biology' });

    expect(res.statusCode).toBe(200);
    expect(res.body.imported).toBe(2);

    const [insert] = getSupabaseCalls('question_bank.insert');
    expect(insert.payload).toHaveLength(2);
    expect(insert.payload[0]).toMatchObject({ teacher_id: TEACHER_ID, topic: 'Cell biology', difficulty: 'medium' });
  });

  it('reports the ones it had to skip, even on success', async () => {
    const res = await call({ action: 'import', text: TEXT + '\n3. Unmarked?\nA) one\nB) two\n' });
    expect(res.statusCode).toBe(200);
    expect(res.body.imported).toBe(2);
    // A teacher who pasted three and got two needs to know which one went
    // missing, not just the count.
    expect(res.body.problems).toHaveLength(1);
    expect(res.body.problems[0]).toMatch(/Unmarked/);
  });

  it('lets a whole batch in for practice, or holds it back', async () => {
    // A teacher pasting next term's paper unticks the box once rather
    // than editing forty questions afterwards. Absent means practisable,
    // which is what every batch imported before this existed was.
    await call({ action: 'import', text: TEXT });
    expect(getSupabaseCalls('question_bank.insert')[0].payload[0].practice_ok).toBe(true);

    resetSupabaseMock();
    asUser(TEACHER_USER);
    await call({ action: 'import', text: TEXT, practice_ok: false });
    expect(getSupabaseCalls('question_bank.insert')[0].payload[0].practice_ok).toBe(false);
  });

  it('refuses a course in another tenant', async () => {
    configureSupabaseMock({
      results: { 'courses.select': { data: { id: 'c1', teacher_id: OTHER_TEACHER_ID }, error: null } },
    });
    const res = await call({ action: 'import', text: TEXT, course_id: 'c1' });
    expect(res.statusCode).toBe(403);
    expect(getSupabaseCalls('question_bank.insert')).toHaveLength(0);
  });

  it('tags the whole batch with a unit and lesson', async () => {
    configureSupabaseMock({ results: {
      'courses.select': { data: { id: 'c1', teacher_id: TEACHER_ID }, error: null },
      'modules.select': { data: { id: 'unit-1', teacher_id: TEACHER_ID }, error: null },
      'lessons.select': { data: { id: 'lesson-1', teacher_id: TEACHER_ID, module_id: 'unit-1' }, error: null },
    } });

    const res = await call({
      action: 'import', text: TEXT, course_id: 'c1', module_id: 'unit-1', lesson_id: 'lesson-1',
    });

    expect(res.statusCode).toBe(200);
    // These are what the bank's unit and lesson filters read.
    expect(getSupabaseCalls('question_bank.insert')[0].payload[0])
      .toMatchObject({ course_id: 'c1', module_id: 'unit-1', lesson_id: 'lesson-1' });
  });

  it('refuses a lesson that is not in the unit chosen with it', async () => {
    configureSupabaseMock({ results: {
      'modules.select': { data: { id: 'unit-1', teacher_id: TEACHER_ID }, error: null },
      'lessons.select': { data: { id: 'lesson-1', teacher_id: TEACHER_ID, module_id: 'unit-4' }, error: null },
    } });

    const res = await call({ action: 'import', text: TEXT, module_id: 'unit-1', lesson_id: 'lesson-1' });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/not in the unit/i);
    expect(getSupabaseCalls('question_bank.insert')).toHaveLength(0);
  });

  it('refuses a lesson in another tenant', async () => {
    configureSupabaseMock({ results: {
      'modules.select': { data: { id: 'unit-1', teacher_id: TEACHER_ID }, error: null },
      'lessons.select': { data: { id: 'lesson-1', teacher_id: OTHER_TEACHER_ID, module_id: 'unit-1' }, error: null },
    } });
    const res = await call({ action: 'import', text: TEXT, module_id: 'unit-1', lesson_id: 'lesson-1' });
    expect(res.statusCode).toBe(403);
  });

  it('tags the whole batch with a section', async () => {
    configureSupabaseMock({ results: {
      'test_sections.select': { data: { id: 'sec-1', teacher_id: TEACHER_ID }, error: null },
    } });

    const res = await call({ action: 'import', text: TEXT, section_id: 'sec-1' });

    expect(res.statusCode).toBe(200);
    expect(getSupabaseCalls('question_bank.insert')[0].payload[0].section_id).toBe('sec-1');
  });

  it('refuses a section from another teacher’s list', async () => {
    configureSupabaseMock({ results: {
      'test_sections.select': { data: { id: 'sec-1', teacher_id: OTHER_TEACHER_ID }, error: null },
    } });

    const res = await call({ action: 'import', text: TEXT, section_id: 'sec-1' });

    expect(res.statusCode).toBe(403);
    expect(getSupabaseCalls('question_bank.insert')).toHaveLength(0);
  });

  it('refuses empty text', async () => {
    const res = await call({ action: 'import', text: '   ' });
    expect(res.statusCode).toBe(400);
  });

  it('refuses text nothing could be read from', async () => {
    const res = await call({ action: 'import', text: 'just a sentence with no options' });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a paste that is far too big', async () => {
    const res = await call({ action: 'import', text: 'x'.repeat(200001) });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/batches/);
  });

  it('turns away a student', async () => {
    asUser(STUDENT_USER);
    const res = await call({ action: 'import', text: TEXT });
    expect(res.statusCode).toBe(403);
  });

  it('turns away an assistant without the questions permission', async () => {
    asUser(ASSISTANT_USER, { profile: { staff_perms: ['students'] } });
    const res = await call({ action: 'import', text: TEXT });
    expect(res.statusCode).toBe(403);
  });
});
