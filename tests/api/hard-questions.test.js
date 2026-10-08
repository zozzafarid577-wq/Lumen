import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@supabase/supabase-js', () => import('../helpers/supabase-mock.js'));

import { resetSupabaseMock, configureSupabaseMock } from '../helpers/supabase-mock.js';
import { hardestQuestions } from '../../api/_lib/hard-questions.js';

beforeEach(() => resetSupabaseMock());

const TEST = { title: 'Unit 1 - Lesson 1', is_offline: false, courses: { title: 'Senior 2' } };
const Q1 = { id: 'q1', test_id: 't1', order_index: 0, question_text: 'Easy one', options: [{ text: 'a', correct: true }, { text: 'b' }] };
const Q2 = { id: 'q2', test_id: 't1', order_index: 1, question_text: 'Hard one', options: [{ text: 'right', correct: true }, { text: 'trap' }, { text: 'other' }] };
const Q3 = { id: 'q3', test_id: 't1', order_index: 2, question_text: 'Choose two', options: [{ text: 'x', correct: true }, { text: 'y', correct: true }, { text: 'z' }] };

function world(attempts) {
  configureSupabaseMock({
    results: {
      'test_attempts.select': { data: attempts, error: null },
      'test_questions.select': { data: [Q1, Q2, Q3], error: null },
    },
  });
}

describe('the hardest questions', () => {
  it('ranks by how many students got it wrong, blanks counted as wrong', async () => {
    world([
      { id: 'a1', test_id: 't1', answers: { q1: 0, q2: 1, q3: [0, 1] }, practice_tests: TEST },
      { id: 'a2', test_id: 't1', answers: { q1: 0, q2: 1, q3: [0] }, practice_tests: TEST },
      { id: 'a3', test_id: 't1', answers: { q1: 1 }, practice_tests: TEST },
    ]);
    const r = await hardestQuestions('teacher-1', new Date(0), new Date());
    expect(r.attempts).toBe(3);
    expect(r.questions.map(q => [q.question, q.wrong, q.sat])).toEqual([
      ['Hard one', 3, 3],          // two chose the trap, one left it blank
      ['Choose two', 2, 3],        // half of a two-answer question is wrong
      ['Easy one', 1, 3],
    ]);
    expect(r.questions[0]).toMatchObject({ answer: 'right', commonWrong: 'trap (2)', blank: 1, pct: 100 });
  });

  it('leaves out papers done in class, which have no answers', async () => {
    world([{ id: 'a1', test_id: 't9', answers: null, practice_tests: { ...TEST, is_offline: true } }]);
    const r = await hardestQuestions('teacher-1', new Date(0), new Date());
    expect(r).toEqual({ attempts: 0, questions: [] });
  });
});

describe('sending on request', () => {
  it('sends even when the morning email already went, and does not mark the day', async () => {
    const { runHardQuestions } = await import('../../api/_lib/hard-questions.js');
    const { getSupabaseCalls } = await import('../helpers/supabase-mock.js');
    world([{ id: 'a1', test_id: 't1', answers: { q1: 1 }, practice_tests: TEST }]);
    configureSupabaseMock({ results: {
      'notify_log.insert': { data: null, error: { message: 'duplicate key' } },
      'groups.select': { data: [{ teacher_name: 'Ms. Abeer', teacher_email: 'abeer@example.com' }], error: null },
    } });
    const out = await runHardQuestions(new Date('2026-10-08T08:00:00Z'), { onlyTeacher: 'teacher-1', force: true });
    expect(out.teachers[0].sent.map(s => s.to)).toEqual(['abeer@example.com']);
    expect(getSupabaseCalls('notify_log.insert')).toHaveLength(0);
  });
});

describe('split by course', () => {
  it('gives each course its own tab in the sheet', async () => {
    const { runHardQuestions } = await import('../../api/_lib/hard-questions.js');
    const ExcelJS = (await import('exceljs')).default;
    let sentAttachment = null;
    const fetchMock = vi.fn(async (_u, opts) => { sentAttachment = JSON.parse(opts.body).attachment?.[0]; return { ok: true, status: 201, text: async () => '{}', json: async () => ({}) }; });
    vi.stubGlobal('fetch', fetchMock);
    process.env.BREVO_API_KEY = 'k'; process.env.BREVO_SENDER_EMAIL = 'from@example.com';
    configureSupabaseMock({ results: {
      'test_attempts.select': { data: [
        { id: 'a1', test_id: 't1', answers: { q1: 1 }, practice_tests: { ...TEST, courses: { title: 'Senior 2' } } },
        { id: 'a2', test_id: 't2', answers: { q4: 1 }, practice_tests: { ...TEST, courses: { title: 'Senior 1' } } },
      ], error: null },
      'test_questions.select': { data: [Q1, { ...Q1, id: 'q4', test_id: 't2' }], error: null },
    } });
    await runHardQuestions(new Date('2026-10-08T08:00:00Z'), { onlyTeacher: 'teacher-1', to: 'lumen@example.com' });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(sentAttachment.content, 'base64'));
    expect(wb.worksheets.map(w => w.name)).toEqual(['Senior 1', 'Senior 2']);
    vi.unstubAllGlobals();
  });
});
