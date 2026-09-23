-- ================================================================
-- Lumen migration v3 — a bank question can be kept out of practice
--
-- Run this once, in the Supabase SQL Editor, on a project that already
-- has supabase-setup.sql and migrations v1 and v2. A fresh project does
-- not need it. Every statement here is safe to run twice.
--
-- What changes and why:
--
--   Students can now practise from the bank (POST /api/practice). That
--   endpoint never sends which option is correct — but it does show the
--   answer once a student has had their go, because a wrong answer a
--   student is not shown the truth of is one they will give again.
--
--   Tests are built by copying bank rows. So a question a teacher is
--   saving for the paper must not be practised first: the student would
--   meet it in the exam already knowing the answer. Until now the only
--   gate was whether the unit had been released, which is too blunt — a
--   unit is released so its lessons can be read, not so its exam
--   questions can be rehearsed.
--
--   This is that gate, per question. It defaults to true: a teacher who
--   never touches it gets practice on everything they have written,
--   which is the behaviour they already have today. Holding a question
--   back is the deliberate act, and it is one tick in the bank.
-- ================================================================

ALTER TABLE public.question_bank
  ADD COLUMN IF NOT EXISTS practice_ok BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN public.question_bank.practice_ok IS
  'May students meet this question in practice? False keeps it for tests only. '
  'Read by api/practice.js; the bank itself is never readable by a student.';

-- The practice endpoint asks one question of this table and only one:
-- the published, practisable questions filed under a given unit. This is
-- that query.
CREATE INDEX IF NOT EXISTS idx_bank_practice
  ON public.question_bank (teacher_id, module_id)
  WHERE is_published = true AND practice_ok = true;

-- No policy is added or changed. The bank still has no student policy at
-- all, deliberately: every row in it says which option is correct.
-- practice_ok is read by the service-role handler in api/practice.js,
-- which is the only thing that ever looks at this table on a student's
-- behalf.
