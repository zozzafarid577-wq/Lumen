-- ================================================================
-- Lumen migration v1 — tests and bank questions know their unit and lesson
--
-- Run this once, in the Supabase SQL Editor, on a project that already
-- has supabase-setup.sql. A fresh project does not need it: the same
-- columns are in the setup file. Every statement here is safe to run
-- twice.
--
-- What changes and why:
--
--   * A test could say which unit it belonged to but not which lesson,
--     so "the quiz that goes with lesson 3" had nowhere to live.
--   * A bank question knew its course and a free-text topic, which is
--     not something you can filter a list by reliably. It now carries
--     the same unit and lesson a test does.
--   * Saving a test now files its questions into the bank. `text_key`
--     is what stops a question picked onto three tests from becoming
--     three copies of itself.
-- ================================================================

-- ── Practice tests ────────────────────────────────────────────────
ALTER TABLE public.practice_tests
  ADD COLUMN IF NOT EXISTS lesson_id UUID REFERENCES public.lessons(id) ON DELETE SET NULL;

-- ── The question bank ─────────────────────────────────────────────
ALTER TABLE public.question_bank
  ADD COLUMN IF NOT EXISTS module_id UUID REFERENCES public.modules(id) ON DELETE SET NULL;

ALTER TABLE public.question_bank
  ADD COLUMN IF NOT EXISTS lesson_id UUID REFERENCES public.lessons(id) ON DELETE SET NULL;

-- Both of those are ON DELETE SET NULL on purpose. A question outlives
-- the unit it was first written for: it is still a good question when
-- next year's units are rebuilt, and losing the whole row with the unit
-- would quietly empty a bank a teacher spent a term filling.

-- The hash the server compares against before filing a question. It is
-- md5 of the text exactly as stored — no lower(), no btrim() — because
-- the same hash has to be reproducible in JavaScript, and case folding
-- is the one operation the two languages do not agree on.
ALTER TABLE public.question_bank
  ADD COLUMN IF NOT EXISTS text_key TEXT GENERATED ALWAYS AS (md5(question_text)) STORED;

-- ── Indexes ───────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_bank_unit     ON public.question_bank(teacher_id, module_id, lesson_id);
CREATE INDEX IF NOT EXISTS idx_bank_text_key ON public.question_bank(teacher_id, text_key);

-- Deliberately not a UNIQUE index. A bank filled before this migration
-- may already hold duplicates, and a unique index would fail the whole
-- script rather than say so — leaving the teacher to guess which of
-- their questions is the problem. Duplicates are prevented from here on
-- by the server checking this index before it inserts, and the ones
-- already there are the teacher's to merge or keep.
--
-- To see whether you have any:
--
--   SELECT teacher_id, question_text, COUNT(*)
--     FROM public.question_bank
--    GROUP BY teacher_id, question_text
--   HAVING COUNT(*) > 1;
