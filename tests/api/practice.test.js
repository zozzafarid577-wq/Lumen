import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@supabase/supabase-js', () => import('../helpers/supabase-mock.js'));

import {
  resetSupabaseMock, configureSupabaseMock, getSupabaseCalls,
  TEACHER_USER, STUDENT_USER, TEACHER_ID, OTHER_TEACHER_ID,
} from '../helpers/supabase-mock.js';
import { asUser } from '../helpers/as.js';
import { makeReq, makeRes } from '../helpers/http.js';
import handler from '../../api/practice.js';

const UNIT = 'unit-1';
const COURSE = 'course-1';

// One question with a single right answer, one with two — the marking
// rule differs between them and both have to hold.
const BANK = [
  {
    id: 'q-1', teacher_id: TEACHER_ID, module_id: UNIT, lesson_id: null,
    question_text: 'Which organelle makes ATP?', difficulty: 'easy', topic: 'Cells',
    is_published: true, practice_ok: true, explanation: 'ATP is made in the mitochondrion.',
    options: [{ text: 'Ribosome' }, { text: 'Mitochondrion', correct: true }],
  },
  {
    id: 'q-2', teacher_id: TEACHER_ID, module_id: UNIT, lesson_id: 'lesson-1',
    question_text: 'Which two are nucleotides?', difficulty: 'hard', topic: 'DNA',
    is_published: true, practice_ok: true, explanation: null,
    options: [{ text: 'Adenine', correct: true }, { text: 'Glucose' }, { text: 'Guanine', correct: true }],
  },
];

// The unit is released and the student is on its course, unless a test
// changes one of those.
function world({ unit = {}, enrolled = true, bank = BANK } = {}) {
  configureSupabaseMock({
    results: {
      'modules.select': (call) => {
        if (call.single) {
          return {
            data: {
              id: UNIT, title: 'Unit 1', teacher_id: TEACHER_ID, course_id: COURSE,
              is_done: true, open_at: null, ...unit,
            },
            error: null,
          };
        }
        return { data: [{ id: UNIT, is_done: true, open_at: null, ...unit }], error: null };
      },
      'enrollments.select': { data: enrolled ? { course_id: COURSE } : null, error: null },
      'question_bank.select': (call) => {
        if (call.single) {
          const row = bank.find(q => q.id === call.filters.id);
          return row ? { data: row, error: null } : { data: null, error: { message: 'not found' } };
        }
        return { data: bank, error: null };
      },
      'lessons.select': { data: { id: 'lesson-1', teacher_id: TEACHER_ID, module_id: UNIT }, error: null },
    },
  });
}

async function call(body) {
  const res = makeRes();
  await handler(makeReq({ body }), res);
  return res;
}

beforeEach(() => {
  resetSupabaseMock();
  asUser(STUDENT_USER);
});

describe('handing out practice questions', () => {
  it('never sends which option is correct', async () => {
    world();
    const res = await call({ module_id: UNIT });

    expect(res.statusCode).toBe(200);
    expect(res.body.questions).toHaveLength(2);

    // The whole reason this endpoint exists. A bank row reaching the
    // browser intact would hand a student the answers to every test
    // built from it.
    const json = JSON.stringify(res.body);
    expect(json).not.toMatch(/correct/);
    for (const q of res.body.questions) {
      for (const o of q.options) expect(Object.keys(o)).toEqual(['text']);
    }
  });

  it('says how many answers to tick without saying which', async () => {
    world();
    const { body } = await call({ module_id: UNIT });
    const two = body.questions.find(q => q.id === 'q-2');
    expect(two.answers).toBe(2);
  });

  it('asks only for published, practisable questions in that unit', async () => {
    world();
    await call({ module_id: UNIT });

    const [query] = getSupabaseCalls('question_bank.select');
    expect(query.filters).toMatchObject({
      teacher_id: TEACHER_ID, module_id: UNIT, is_published: true, practice_ok: true,
    });
  });

  it('narrows to one lesson when asked', async () => {
    world();
    await call({ module_id: UNIT, lesson_id: 'lesson-1' });

    const [query] = getSupabaseCalls('question_bank.select');
    expect(query.filters.lesson_id).toBe('lesson-1');
  });

  it('accepts the lessons as a list', async () => {
    world();
    await call({ module_id: UNIT, lesson_ids: ['lesson-1'] });
    const [one] = getSupabaseCalls('question_bank.select');
    expect(one.filters.lesson_id).toBe('lesson-1');
  });

  it('narrows to the sections picked — vocabulary, grammar — and ignores anything that is not an id', async () => {
    world();
    const vocab = '11111111-2222-3333-4444-555555555555';
    await call({ module_id: UNIT, section_ids: [vocab, 'drop table'] });

    const [query] = getSupabaseCalls('question_bank.select');
    expect(query.filters['in:section_id']).toEqual([vocab]);
  });

  it('will not take a lesson from another unit', async () => {
    world();
    configureSupabaseMock({
      results: { 'lessons.select': { data: { id: 'lesson-9', teacher_id: TEACHER_ID, module_id: 'unit-9' }, error: null } },
    });
    const res = await call({ module_id: UNIT, lesson_id: 'lesson-9' });
    expect(res.statusCode).toBe(403);
  });

  it('caps how many come back at once', async () => {
    world({ bank: Array.from({ length: 80 }, (_, i) => ({ ...BANK[0], id: 'q-' + i })) });
    const res = await call({ module_id: UNIT, count: 500 });
    expect(res.body.questions).toHaveLength(30);
  });
});

describe('who may practise', () => {
  it('turns away a student who is not on the course', async () => {
    world({ enrolled: false });
    const res = await call({ module_id: UNIT });

    expect(res.statusCode).toBe(403);
    expect(getSupabaseCalls('question_bank.select')).toHaveLength(0);
  });

  it('turns away a unit the teacher has not finished', async () => {
    world({ unit: { is_done: false } });
    const res = await call({ module_id: UNIT });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/not open/);
  });

  it('turns away a unit whose release time has not come', async () => {
    world({ unit: { open_at: new Date(Date.now() + 86400000).toISOString() } });
    const res = await call({ module_id: UNIT });
    expect(res.statusCode).toBe(403);
  });

  it('turns away another teacher’s unit', async () => {
    world({ unit: { teacher_id: OTHER_TEACHER_ID } });
    const res = await call({ module_id: UNIT });
    expect(res.statusCode).toBe(403);
  });

  it('lets the teacher in through "View as student", inside their own space and without enrolment', async () => {
    asUser(TEACHER_USER);
    world({ enrolled: false });
    const res = await call({ module_id: UNIT });
    expect(res.statusCode).toBe(200);
    const [query] = getSupabaseCalls('question_bank.select');
    expect(query.filters.teacher_id).toBe(TEACHER_ID);
  });

  it('still refuses a teacher another space\'s unit', async () => {
    asUser(TEACHER_USER);
    world({ unit: { teacher_id: OTHER_TEACHER_ID } });
    const res = await call({ module_id: UNIT });
    expect(res.statusCode).toBe(403);
  });
});

describe('marking one answer', () => {
  it('marks a right answer right, and hands back the explanation', async () => {
    world();
    const res = await call({ action: 'check', question_id: 'q-1', chosen: [1] });

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ correct: true, right: [1] });
    expect(res.body.explanation).toMatch(/mitochondrion/i);
  });

  it('marks a wrong answer wrong and still shows the right one', async () => {
    world();
    const res = await call({ action: 'check', question_id: 'q-1', chosen: [0] });
    expect(res.body).toMatchObject({ correct: false, right: [1] });
  });

  it('wants every answer on a two-answer question, and nothing else', async () => {
    world();
    expect((await call({ action: 'check', question_id: 'q-2', chosen: [0] })).body.correct).toBe(false);
    expect((await call({ action: 'check', question_id: 'q-2', chosen: [0, 1, 2] })).body.correct).toBe(false);
    expect((await call({ action: 'check', question_id: 'q-2', chosen: [2, 0] })).body.correct).toBe(true);
  });

  it('ignores a repeated tick rather than counting it twice', async () => {
    world();
    const res = await call({ action: 'check', question_id: 'q-2', chosen: [0, 0, 2] });
    expect(res.body.correct).toBe(true);
  });

  it('checks the unit again, not just at the start', async () => {
    // An id kept from an earlier session must not outlive the student's
    // access to the unit it came from.
    world({ enrolled: false });
    const res = await call({ action: 'check', question_id: 'q-1', chosen: [1] });
    expect(res.statusCode).toBe(403);
  });

  it('will not mark a question the teacher has held back', async () => {
    // A teacher who unticks practice while a student has the question on
    // screen must not have its answer handed over by the mark that
    // follows — the filter on the way out is not the only check.
    world({ bank: [{ ...BANK[0], practice_ok: false }] });
    const res = await call({ action: 'check', question_id: 'q-1', chosen: [1] });

    expect(res.statusCode).toBe(403);
    expect(JSON.stringify(res.body)).not.toMatch(/right|explanation/);
  });

  it('will not mark another teacher’s question', async () => {
    world({ bank: [{ ...BANK[0], teacher_id: OTHER_TEACHER_ID }] });
    const res = await call({ action: 'check', question_id: 'q-1', chosen: [1] });
    expect(res.statusCode).toBe(403);
  });
});

describe('where there is anything to practise', () => {
  it('counts the questions per open unit, and sends no question text', async () => {
    world();
    configureSupabaseMock({
      results: {
        'question_bank.select': { data: [{ module_id: UNIT }, { module_id: UNIT }], error: null },
      },
    });
    const res = await call({ action: 'available', course_id: COURSE });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ units: { [UNIT]: 2 } });
  });

  it('counts only the questions students may practise', async () => {
    world();
    await call({ action: 'available', course_id: COURSE });

    const [query] = getSupabaseCalls('question_bank.select');
    expect(query.filters).toMatchObject({ is_published: true, practice_ok: true });
  });

  it('counts nothing for a course the student is not on', async () => {
    world({ enrolled: false });
    const res = await call({ action: 'available', course_id: COURSE });
    expect(res.statusCode).toBe(403);
  });

  it('leaves out units that have not been released', async () => {
    world({ unit: { is_done: false } });
    const res = await call({ action: 'available', course_id: COURSE });

    expect(res.body).toEqual({ units: {} });
    expect(getSupabaseCalls('question_bank.select')).toHaveLength(0);
  });
});

describe('practising from the tests as well as the bank', () => {
  const TQ = {
    id: 'tq-1', test_id: 'test-1', question_text: 'She ____ to school every day.',
    explanation: null, options: [{ text: 'go' }, { text: 'goes', correct: true }],
  };

  function withTests({ bank = [], active = true } = {}) {
    world({ bank });
    configureSupabaseMock({
      results: {
        'practice_tests.select': { data: active ? [{ id: 'test-1', module_id: UNIT, lesson_id: null, section_id: null }] : [], error: null },
        'test_questions.select': (call) => call.single
          ? { data: { ...TQ, practice_tests: { teacher_id: TEACHER_ID, module_id: UNIT, is_active: active } }, error: null }
          : { data: [TQ], error: null },
      },
    });
  }

  it('offers a course with an empty bank the questions on its open tests', async () => {
    withTests();
    const res = await call({ action: 'available', course_id: COURSE });
    expect(res.body).toEqual({ units: { [UNIT]: 1 } });
  });

  it('serves a test question without its answer, and marks it', async () => {
    withTests();
    const { body } = await call({ module_id: UNIT });
    expect(body.questions).toHaveLength(1);
    expect(body.questions[0].id).toBe('t:tq-1');
    expect(JSON.stringify(body)).not.toMatch(/correct/);

    const marked = await call({ action: 'check', question_id: 't:tq-1', chosen: [1] });
    expect(marked.body.correct).toBe(true);
  });

  it('offers a question that is in the bank and on a test only once', async () => {
    withTests({ bank: [{ ...BANK[0], id: 'b-1', question_text: TQ.question_text, options: TQ.options }] });
    const { body } = await call({ module_id: UNIT });
    expect(body.questions.map(q => q.id)).toEqual(['b-1']);
  });

  it('will not mark a question from a test that has been switched off', async () => {
    withTests({ active: false });
    const res = await call({ action: 'check', question_id: 't:tq-1', chosen: [1] });
    expect(res.statusCode).toBe(403);
  });
});

describe('a course with more than a thousand questions', () => {
  it('counts every one, not just the first page the database hands back', async () => {
    world();
    let reads = 0;
    configureSupabaseMock({
      results: {
        // The database stops at 1,000 rows a request; the next page holds the rest.
        'question_bank.select': () => {
          reads++;
          const n = reads === 1 ? 1000 : 5;
          return { data: Array.from({ length: n }, (_, i) => ({ id: `q-${reads}-${i}`, module_id: UNIT })), error: null };
        },
        'practice_tests.select': { data: [], error: null },
      },
    });
    const res = await call({ action: 'available', course_id: COURSE });
    expect(res.body).toEqual({ units: { [UNIT]: 1005 } });
    expect(reads).toBe(2);
  });
});
