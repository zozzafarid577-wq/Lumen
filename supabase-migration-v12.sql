-- ================================================================
-- Lumen migration v12 — stop the question bank collecting duplicates,
-- and make the unit filter tell the truth
--
-- Run this once, in the Supabase SQL Editor, on a project that already
-- has supabase-setup.sql and migrations v1–v11. Every statement here is
-- safe to run twice.
--
-- NOTHING IS DELETED BY THIS FILE. It normalises text, backfills a
-- column, and ends with a read-only query that shows you the duplicates
-- you already have. Removing them is migration v13, which is separate
-- precisely so it can be read before it is run.
--
-- What changes and why:
--
--   1. A question is identified by md5 of its text, so one invisible
--      character makes a second copy of a question a teacher reads as
--      identical. These are pasted out of Word, which is full of
--      non-breaking spaces, and a batch re-pasted after a small edit
--      arrives with different spacing throughout. Text is now normalised
--      by a trigger — every writer, not only api/, because the bank page
--      writes to this table directly.
--
--   2. Filing a question that was already in the bank set its unit but
--      never its course, so a question could end up with a unit and no
--      course. The bank's unit filter only offers units once a course is
--      chosen, so both filters are active together — and such a question
--      matched the unit, failed the course, and vanished from a filter
--      that should have found it. The course is backfilled from the unit
--      it already names.
-- ================================================================

-- ────────────────────────────────────────
-- 1. ONE SPELLING OF A QUESTION
-- ────────────────────────────────────────
-- Kept deliberately narrow, and it must match normalizeQuestionText()
-- in api/_lib/questions.js character for character.
--
-- chr(160) is the non-breaking space, spelled this way rather than
-- pasted in so it survives being opened in any editor. Postgres's \s
-- does not include it; JavaScript's does — which is the whole reason
-- the two sides are written out explicitly instead of both saying \s.
--
-- Case is left alone. Upper/lower-casing is the one operation the two
-- languages disagree about across locales, and a dedup that is wrong is
-- worse than one that is narrow.
-- [[:space:]] rather than a class of backslash escapes: it is the POSIX
-- spelling, it needs no reasoning about how a string literal and a regex
-- each treat a backslash, and it covers exactly space, tab, newline,
-- vertical tab, form feed and carriage return — the same six the
-- JavaScript side lists out longhand.
CREATE OR REPLACE FUNCTION public.normalize_question_text(t TEXT)
RETURNS TEXT
LANGUAGE SQL IMMUTABLE AS $$
  SELECT btrim(regexp_replace(replace(t, chr(160), ' '), '[[:space:]]+', ' ', 'g'))
$$;

CREATE OR REPLACE FUNCTION public.question_bank_normalize()
RETURNS TRIGGER AS $$
BEGIN
  NEW.question_text := public.normalize_question_text(NEW.question_text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- On the table rather than in api/, because the bank page inserts and
-- updates question_bank straight from the browser through row-level
-- security. A rule that only api/ obeyed would be half a rule.
DROP TRIGGER IF EXISTS question_bank_normalize_text ON public.question_bank;
CREATE TRIGGER question_bank_normalize_text
  BEFORE INSERT OR UPDATE OF question_text ON public.question_bank
  FOR EACH ROW EXECUTE FUNCTION public.question_bank_normalize();

-- Existing rows, so that today's bank is spelled the way tomorrow's
-- writes will be. text_key is generated from question_text, so it
-- follows automatically — which is what makes the duplicates below
-- findable at all: two rows differing only in spacing have the same
-- hash only after this runs.
UPDATE public.question_bank
   SET question_text = public.normalize_question_text(question_text)
 WHERE question_text IS DISTINCT FROM public.normalize_question_text(question_text);

-- The same for the copies that live on tests. No dedup depends on these
-- — test_questions has no unique key and is meant to hold copies — but a
-- question should not read differently on the paper than in the bank.
UPDATE public.test_questions
   SET question_text = public.normalize_question_text(question_text)
 WHERE question_text IS DISTINCT FROM public.normalize_question_text(question_text);

-- ────────────────────────────────────────
-- 2. A QUESTION THAT KNOWS ITS UNIT KNOWS ITS COURSE
-- ────────────────────────────────────────
-- A unit belongs to exactly one course, so this invents nothing: it
-- writes down the course the question already implied.
UPDATE public.question_bank q
   SET course_id = m.course_id
  FROM public.modules m
 WHERE q.module_id = m.id
   AND q.course_id IS NULL;

-- The same hole one level down: a lesson names its unit.
UPDATE public.question_bank q
   SET module_id = l.module_id
  FROM public.lessons l
 WHERE q.lesson_id = l.id
   AND q.module_id IS NULL;

-- ────────────────────────────────────────
-- 3. WHAT YOU ARE ABOUT TO DELETE  (read-only — run this and look)
-- ────────────────────────────────────────
-- Nothing above removed a row. This shows every group of questions that
-- migration v13 would collapse into one: the text, how many copies
-- exist, when the oldest was written, and which single row v13 keeps.
--
-- Deleting a bank row cannot affect a test, an attempt or a result:
-- test_questions holds its own copy of the text and options and has no
-- foreign key to this table. Nothing in the database points at
-- question_bank at all.
--
-- Run it on its own. If the list looks right, run v13.
SELECT
  t.display_name                              AS space,
  left(q.question_text, 80)                   AS question,
  count(*)                                    AS copies,
  min(q.created_at)                           AS first_written,
  (array_agg(q.id ORDER BY q.created_at))[1]  AS row_v13_keeps
FROM public.question_bank q
JOIN public.teachers t ON t.id = q.teacher_id
GROUP BY t.display_name, q.teacher_id, q.text_key, q.question_text
HAVING count(*) > 1
ORDER BY count(*) DESC, q.question_text;
