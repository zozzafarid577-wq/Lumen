import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseQuestionText, normalizeQuestionText } from '../../api/_lib/questions.js';

// How the bank decides two questions are the same question. A row is
// identified by md5 of its text, so anything this gets wrong becomes a
// duplicate in somebody's bank.
describe('normalizeQuestionText', () => {
  it('reads one question however Word spaced it', () => {
    const same = [
      'What is a noun?',
      '  What is a noun?  ',
      'What  is   a noun?',
      'What is a noun?',          // non-breaking space, the Word special
      'What\tis a\nnoun?',
      'What   is a noun?',
    ];
    const out = new Set(same.map(normalizeQuestionText));
    expect(out.size, [...out].join(' | ')).toBe(1);
    expect([...out][0]).toBe('What is a noun?');
  });

  it('keeps genuinely different questions different', () => {
    expect(normalizeQuestionText('What is a noun?'))
      .not.toBe(normalizeQuestionText('What is a verb?'));
  });

  it('leaves case alone', () => {
    // Deliberate. Upper/lower-casing is the one operation Postgres and
    // JavaScript disagree about across locales, and these two sides must
    // agree exactly or the hash stops matching the stored row.
    expect(normalizeQuestionText('What Is A Noun?')).toBe('What Is A Noun?');
  });

  it('survives nothing at all', () => {
    for (const empty of ['', '   ', null, undefined]) {
      expect(normalizeQuestionText(empty)).toBe('');
    }
  });

  // The trigger in migration v12 is authoritative — the bank page writes
  // to question_bank straight from the browser, never through this file.
  // If the two spellings drift, this side computes a hash the table does
  // not hold, decides every question is new, and fills the bank with
  // near-copies. That is the bug this whole change exists to fix, so the
  // agreement is asserted rather than trusted.
  it('is spelled the same way in the migration', () => {
    const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const sql = readFileSync(join(ROOT, 'supabase-migration-v12.sql'), 'utf8');

    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.normalize_question_text/);
    // The same three steps, in the same order: the non-breaking space
    // named explicitly, a run of whitespace collapsed to one, then trim.
    expect(sql).toMatch(/replace\(t, chr\(160\), ' '\)/);
    expect(sql).toMatch(/'\[\[:space:\]\]\+', ' ', 'g'/);
    expect(sql).toMatch(/btrim\(/);
    // And no case folding on either side.
    expect(sql).not.toMatch(/lower\(t\)|upper\(t\)/);
  });

  it('is applied to what the parser hands back', () => {
    const { questions } = parseQuestionText(
      'What  is   2 + 2?\nA) 3\n*B) 4');
    expect(questions[0].question_text).toBe('What is 2 + 2?');
  });
});

// The shapes teachers actually paste in. Each of these came from a real
// habit — numbered lists out of Word, dashes out of a phone, an answer
// key at the bottom of the question.
describe('reading pasted questions', () => {
  it('reads a numbered question with lettered options and a starred answer', () => {
    const { questions, problems } = parseQuestionText(`
1. Which organelle makes ATP?
A) Ribosome
*B) Mitochondrion
C) Golgi body
`);
    expect(problems).toEqual([]);
    expect(questions).toHaveLength(1);
    expect(questions[0].question_text).toBe('Which organelle makes ATP?');
    expect(questions[0].options.map(o => o.text)).toEqual(['Ribosome', 'Mitochondrion', 'Golgi body']);
    expect(questions[0].options.filter(o => o.correct).map(o => o.text)).toEqual(['Mitochondrion']);
  });

  it('reads an "Answer: B" line', () => {
    const { questions } = parseQuestionText(`
DNA replication is…
A. conservative
B. semi-conservative
C. dispersive
Answer: B
`);
    expect(questions[0].options[1].correct).toBe(true);
    expect(questions[0].options.filter(o => o.correct)).toHaveLength(1);
  });

  it('reads an answer given by number', () => {
    const { questions } = parseQuestionText(`
How many chambers has the human heart?
- two
- three
- four
Answer: 3
`);
    expect(questions[0].options[2]).toMatchObject({ text: 'four', correct: true });
  });

  it('reads an answer given as the option’s own words', () => {
    const { questions } = parseQuestionText(`
Which gas do plants take in?
- oxygen
- carbon dioxide
Answer: carbon dioxide
`);
    expect(questions[0].options[1].correct).toBe(true);
  });

  it('reads a trailing (correct) marker', () => {
    const { questions } = parseQuestionText(`
Where does photosynthesis happen?
- Mitochondrion
- Chloroplast (correct)
`);
    expect(questions[0].options[1]).toMatchObject({ text: 'Chloroplast', correct: true });
  });

  it('keeps an explanation with its question', () => {
    const { questions } = parseQuestionText(`
Q1) What is the powerhouse of the cell?
*a) Mitochondrion
b) Nucleus
Explanation: Respiration happens there.
`);
    expect(questions[0].explanation).toBe('Respiration happens there.');
  });

  it('reads several questions separated by blank lines', () => {
    const { questions } = parseQuestionText(`
1. First question?
*A) yes
B) no

2. Second question?
A) yes
*B) no
`);
    expect(questions).toHaveLength(2);
    expect(questions[1].question_text).toBe('Second question?');
  });

  it('allows more than one correct answer', () => {
    const { questions } = parseQuestionText(`
Which of these are organelles?
A) Nucleus
B) Mitochondrion
C) Table
Answer: A, B
`);
    expect(questions[0].options.filter(o => o.correct).map(o => o.text)).toEqual(['Nucleus', 'Mitochondrion']);
  });

  it('skips a question with no answer marked, and says which', () => {
    const { questions, problems } = parseQuestionText(`
Which organelle makes ATP?
A) Ribosome
B) Mitochondrion
`);
    // Silently dropping it would leave a teacher believing a question was
    // saved when it was not.
    expect(questions).toHaveLength(0);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/no correct answer/);
    expect(problems[0]).toMatch(/Which organelle/);
  });

  it('skips a question with only one option', () => {
    const { questions, problems } = parseQuestionText(`
A question?
*A) the only option
`);
    expect(questions).toHaveLength(0);
    expect(problems[0]).toMatch(/fewer than two options/);
  });

  it('keeps the good questions when one in the middle is broken', () => {
    const { questions, problems } = parseQuestionText(`
1. Good one?
*A) yes
B) no

2. Broken one?
A) no marker
B) here either

3. Another good one?
A) no
*B) yes
`);
    expect(questions.map(q => q.question_text)).toEqual(['Good one?', 'Another good one?']);
    expect(problems).toHaveLength(1);
  });

  it('returns nothing for empty or meaningless input', () => {
    for (const input of ['', '   \n\n  ', null, undefined]) {
      expect(parseQuestionText(input).questions).toEqual([]);
    }
  });

  it('ignores an option line with no question above it', () => {
    const { questions } = parseQuestionText(`
A) orphaned option
B) another
`);
    // The first line has nothing to attach to, so it becomes the question
    // and the second becomes its only option — which is then rejected.
    expect(questions).toHaveLength(0);
  });

  it('caps very long text rather than storing it whole', () => {
    const long = 'x'.repeat(5000);
    const { questions } = parseQuestionText(`${long}\n*A) ${long}\nB) no`);
    expect(questions[0].question_text.length).toBe(2000);
    expect(questions[0].options[0].text.length).toBe(600);
  });
});
