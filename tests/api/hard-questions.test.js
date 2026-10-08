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
