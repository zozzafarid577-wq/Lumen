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
    expect(res.body).toEqual({ test_id: 'test-new', question_count: 2, banked: 1, corrected: 0, bank_error: null });

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

describe('the section', () => {
  const ownedSection = (teacherId) => ({
    'test_sections.select': { data: { id: 'sec-1', teacher_id: teacherId }, error: null },
  });

  it('stores which of the teacher’s sections this paper is', async () => {
    configureSupabaseMock({ results: ownedSection(TEACHER_ID) });
    const res = await call({ title: 'Quiz', course_id: COURSE, section_id: 'sec-1', questions: [Q()] });

    expect(res.statusCode).toBe(200);
    expect(getSupabaseCalls('practice_tests.insert')[0].payload.section_id).toBe('sec-1');
  });

  it('refuses a section from another teacher’s list', async () => {
    configureSupabaseMock({ results: ownedSection(OTHER_TEACHER_ID) });
    const res = await call({ title: 'Quiz', course_id: COURSE, section_id: 'sec-1', questions: [Q()] });

    expect(res.statusCode).toBe(403);
    expect(getSupabaseCalls('practice_tests.insert')).toHaveLength(0);
  });

  it('files new questions under it', async () => {
    configureSupabaseMock({ results: ownedSection(TEACHER_ID) });
    const res = await call({ title: 'Quiz', course_id: COURSE, section_id: 'sec-1', questions: [Q()] });

    expect(res.statusCode).toBe(200);
    expect(getSupabaseCalls('question_bank.insert')[0].payload[0].section_id).toBe('sec-1');
  });

  it('gives a banked question its section without touching its unit', async () => {
    // A question can easily know where it sits and not what it asks —
    // filling both or neither would leave half the bank unfilterable the
    // day a teacher adds sections.
    const key = createHash('md5').update(Q().question_text).digest('hex');
    configureSupabaseMock({ results: {
      ...ownedSection(TEACHER_ID),
      'question_bank.select': { data: [{ id: 'bank-1', text_key: key, course_id: COURSE, module_id: 'unit-9', section_id: null }], error: null },
    } });

    const res = await call({
      title: 'Quiz', course_id: COURSE, module_id: 'unit-1', section_id: 'sec-1', questions: [Q()],
    });

    expect(res.statusCode).toBe(200);
    expect(getSupabaseCalls('question_bank.update')[0].payload).toEqual({ section_id: 'sec-1' });
  });

  it('leaves a question that already has a section alone', async () => {
    const key = createHash('md5').update(Q().question_text).digest('hex');
    configureSupabaseMock({ results: {
      ...ownedSection(TEACHER_ID),
      'question_bank.select': { data: [{ id: 'bank-1', text_key: key, course_id: COURSE, module_id: 'unit-1', section_id: 'sec-9' }], error: null },
    } });

    const res = await call({
      title: 'Quiz', course_id: COURSE, module_id: 'unit-1', section_id: 'sec-1', questions: [Q()],
    });

    expect(res.statusCode).toBe(200);
    expect(getSupabaseCalls('question_bank.update')).toHaveLength(0);
  });

  it('updates rows wanting the same patch together', async () => {
    // A fifty-question paper must not become fifty round trips.
    const rows = [Q(), { ...Q(), question_text: 'Second?' }, { ...Q(), question_text: 'Third?' }];
    const banked = rows.map((q, i) => ({
      id: `bank-${i}`,
      text_key: createHash('md5').update(q.question_text).digest('hex'), course_id: COURSE,
      module_id: null, section_id: null,
    }));
    configureSupabaseMock({ results: {
      ...ownedSection(TEACHER_ID),
      'question_bank.select': { data: banked, error: null },
    } });

    const res = await call({
      title: 'Quiz', course_id: COURSE, module_id: 'unit-1', section_id: 'sec-1', questions: rows,
    });

    expect(res.statusCode).toBe(200);
    const updates = getSupabaseCalls('question_bank.update');
    expect(updates).toHaveLength(1);
    expect(updates[0].payload).toEqual({ module_id: 'unit-1', lesson_id: null, section_id: 'sec-1' });
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

  it('keeps what it files out of practice', async () => {
    // These questions arrived on a paper. Practice shows the answer, so
    // letting them straight into it would rehearse a test that may not
    // have opened yet.
    const res = await call({ title: 'Quiz', course_id: COURSE, module_id: 'unit-1', questions: [Q()] });

    expect(res.statusCode).toBe(200);
    const [filed] = getSupabaseCalls('question_bank.insert');
    expect(filed.payload[0].practice_ok).toBe(false);
  });

  it('sends a corrected answer back to the bank', async () => {
    // The whole point of editing a test's questions: fixing which option
    // is right on the paper has to reach the bank, or the next test built
    // from that question is wrong all over again.
    const key = createHash('md5').update(Q().question_text).digest('hex');
    configureSupabaseMock({ results: {
      'question_bank.select': { data: [{
        id: 'bank-1', text_key: key, course_id: COURSE, module_id: 'unit-1', section_id: null,
        // The bank has the WRONG option marked.
        options: [{ text: 'Ribosome', correct: true }, { text: 'Mitochondrion', correct: false }],
        explanation: null,
      }], error: null },
    } });

    const res = await call({ title: 'Quiz', course_id: COURSE, module_id: 'unit-1', questions: [Q()] });

    expect(res.statusCode).toBe(200);
    expect(res.body.corrected).toBe(1);
    expect(res.body.banked).toBe(0);

    const update = getSupabaseCalls('question_bank.update').find(c => c.payload.options);
    expect(update.filters.id).toBe('bank-1');
    expect(update.payload.options).toEqual(Q().options);
  });

  it('leaves the bank alone when the answer already matches', async () => {
    const key = createHash('md5').update(Q().question_text).digest('hex');
    configureSupabaseMock({ results: {
      'question_bank.select': { data: [{
        id: 'bank-1', text_key: key, course_id: COURSE, module_id: 'unit-1', section_id: null,
        options: Q().options, explanation: null,
      }], error: null },
    } });

    const res = await call({ title: 'Quiz', course_id: COURSE, module_id: 'unit-1', questions: [Q()] });

    expect(res.body.corrected).toBe(0);
    expect(getSupabaseCalls('question_bank.update').filter(c => c.payload.options)).toHaveLength(0);
  });

  it('files a reworded question as new rather than overwriting the original', async () => {
    // The text is what identifies a bank row. Rewording makes a
    // different question; the one it came from is left as it was.
    const key = createHash('md5').update(Q().question_text).digest('hex');
    configureSupabaseMock({ results: {
      'question_bank.select': { data: [{
        id: 'bank-1', text_key: key, course_id: COURSE, module_id: 'unit-1', section_id: null,
        options: Q().options, explanation: null,
      }], error: null },
    } });

    const res = await call({
      title: 'Quiz', course_id: COURSE, module_id: 'unit-1',
      questions: [{ ...Q(), question_text: 'Which organelle produces ATP?' }],
    });

    expect(res.body.banked).toBe(1);
    expect(res.body.corrected).toBe(0);
  });

  it('skips a question the bank already holds', async () => {
    // md5 of the question text, matching question_bank.text_key. A
    // question picked onto three tests must not become three copies.
    const key = createHash('md5').update(Q().question_text).digest('hex');
    configureSupabaseMock({ results: {
      'question_bank.select': { data: [{ id: 'bank-1', text_key: key, course_id: COURSE, module_id: 'unit-1' }], error: null },
    } });

    const res = await call({ title: 'Quiz', course_id: COURSE, module_id: 'unit-1', questions: [Q()] });

    expect(res.statusCode).toBe(200);
    expect(res.body.banked).toBe(0);
    expect(getSupabaseCalls('question_bank.insert')).toHaveLength(0);
  });

  it('gives a question that was never placed the test’s unit', async () => {
    const key = createHash('md5').update(Q().question_text).digest('hex');
    configureSupabaseMock({ results: {
      'question_bank.select': { data: [{ id: 'bank-1', text_key: key, course_id: COURSE, module_id: null }], error: null },
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
      'question_bank.select': { data: [{ id: 'bank-1', text_key: key, course_id: COURSE, module_id: 'unit-9' }], error: null },
    } });

    const res = await call({ title: 'Quiz', course_id: COURSE, module_id: 'unit-1', questions: [Q()] });

    expect(res.statusCode).toBe(200);
    expect(getSupabaseCalls('question_bank.update')).toHaveLength(0);
  });

  it('gives a question with a unit but no course the test’s course', async () => {
    // What made the bank's unit filter lie. The unit list only appears
    // once a course is picked, so both filters are live together — and a
    // question filed with a unit and no course matched the unit, failed
    // the course, and could not be found by either.
    const key = createHash('md5').update(Q().question_text).digest('hex');
    configureSupabaseMock({ results: {
      'question_bank.select': { data: [{ id: 'bank-1', text_key: key, course_id: null, module_id: 'unit-9' }], error: null },
    } });

    const res = await call({ title: 'Quiz', course_id: COURSE, module_id: 'unit-1', questions: [Q()] });

    expect(res.statusCode).toBe(200);
    // Its unit is still its own — only the blank is filled.
    expect(getSupabaseCalls('question_bank.update')[0].payload).toEqual({ course_id: COURSE });
  });

  it('never moves a question that already has a course', async () => {
    const key = createHash('md5').update(Q().question_text).digest('hex');
    configureSupabaseMock({ results: {
      'question_bank.select': { data: [{ id: 'bank-1', text_key: key, course_id: 'course-9', module_id: 'unit-9' }], error: null },
    } });

    const res = await call({ title: 'Quiz', course_id: COURSE, module_id: 'unit-1', questions: [Q()] });

    expect(res.statusCode).toBe(200);
    expect(getSupabaseCalls('question_bank.update')).toHaveLength(0);
  });

  it('matches a question the bank already holds despite Word’s spacing', async () => {
    // The everyday cause of duplicates: these are pasted out of Word,
    // and a non-breaking space or a double space made a question a
    // person reads as identical hash to something else entirely.
    const key = createHash('md5').update(Q().question_text).digest('hex');
    configureSupabaseMock({ results: {
      'question_bank.select': { data: [{ id: 'bank-1', text_key: key, course_id: COURSE, module_id: 'unit-1' }], error: null },
    } });

    const messy = Q().question_text.replace(/ /g, '  ');
    const res = await call({
      title: 'Quiz', course_id: COURSE, module_id: 'unit-1',
      questions: [{ ...Q(), question_text: `  ${messy}\t` }],
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.banked).toBe(0);
    expect(getSupabaseCalls('question_bank.insert')).toHaveLength(0);
  });

  it('stores the tidied text, so the hash it looked up is the one filed', async () => {
    const res = await call({
      title: 'Quiz', course_id: COURSE,
      questions: [{ ...Q(), question_text: '  What  is   2 + 2?  ' }],
    });

    expect(res.statusCode).toBe(200);
    const [insert] = getSupabaseCalls('question_bank.insert');
    expect(insert.payload[0].question_text).toBe('What is 2 + 2?');
  });

  it('files the rest of the paper when one question is already there', async () => {
    // The unique index added in migration v13 refuses a question filed
    // by a save a moment earlier. Losing the other questions over it
    // would have the teacher paste the whole batch again.
    configureSupabaseMock({ results: {
      'question_bank.insert': [
        { data: null, error: { code: '23505', message: 'duplicate key' } },  // the batch
        { data: null, error: { code: '23505', message: 'duplicate key' } },  // retried: this one is known
        { data: null, error: null },                                          // retried: this one is new
      ],
    } });

    const res = await call({
      title: 'Quiz', course_id: COURSE,
      questions: [Q(), { ...Q(), question_text: 'Second?' }],
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.banked).toBe(1);          // the one that was genuinely new
    expect(res.body.bank_error).toBeNull();   // and no alarm raised over the other
  });

  it('still reports a write failure that is not a duplicate', async () => {
    configureSupabaseMock({ results: {
      'question_bank.insert': [
        { data: null, error: { code: '23505', message: 'duplicate key' } },
        { data: null, error: { code: '08006', message: 'connection failure' } },
      ],
    } });

    const res = await call({ title: 'Quiz', course_id: COURSE, questions: [Q()] });

    expect(res.statusCode).toBe(200);         // the test itself still saved
    expect(res.body.bank_error).toMatch(/not added to your question bank/i);
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
