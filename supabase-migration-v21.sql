-- ================================================================
-- Lumen migration v21 — free-response questions (FRQs), graded per point
--
-- Safe to run twice. It writes no rows.
--
-- An FRQ is a test question the student answers in writing, point by
-- point, the way an AP free-response question is marked: every point is
-- worth one mark and is earned or not against the official scoring
-- guideline. Claude marks each point when the paper is handed in
-- (api/_lib/frq.js); the teacher can change any point afterwards.
--
--   test_questions.kind   'mcq' (every question so far) or 'frq'
--   test_questions.frq    what the student sees: { points: [{ label, prompt }] }
--   frq_rubrics           the scoring guideline, one row per FRQ. Its own
--                         table because students can read their test's
--                         questions, and a rubric they could read before
--                         answering would be the answers. Staff only; the
--                         grader reads it with the service key.
--   test_attempts.grading what was marked: { status, questions: { <question id>:
--                         { points: [{ label, earned, reason, by }] } } }
-- ================================================================

ALTER TABLE public.test_questions ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'mcq';
ALTER TABLE public.test_questions ADD COLUMN IF NOT EXISTS frq JSONB;
DO $$ BEGIN
  ALTER TABLE public.test_questions ADD CONSTRAINT test_questions_kind_check CHECK (kind IN ('mcq', 'frq'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.frq_rubrics (
  question_id UUID PRIMARY KEY REFERENCES public.test_questions(id) ON DELETE CASCADE,
  teacher_id  UUID NOT NULL REFERENCES public.teachers(id) ON DELETE CASCADE,
  general     TEXT,
  points      JSONB NOT NULL
);

ALTER TABLE public.frq_rubrics ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "frq_rubrics_staff_all" ON public.frq_rubrics;
CREATE POLICY "frq_rubrics_staff_all" ON public.frq_rubrics
  FOR ALL USING (public.is_staff_of(teacher_id)) WITH CHECK (public.is_staff_of(teacher_id));

ALTER TABLE public.test_attempts ADD COLUMN IF NOT EXISTS grading JSONB;
