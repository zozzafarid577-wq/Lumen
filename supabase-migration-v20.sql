-- ================================================================
-- Lumen migration v20 — practice does not repeat itself
--
-- Safe to run twice. It writes no rows.
--
-- One row per question a student has answered in Practice, so the next
-- round gives them questions they have not done yet. question_key is the
-- id Practice serves: a question_bank id, or "t:<test_questions id>" for
-- a question taken from an open test. Only marks of right or wrong are
-- not kept — practice still counts for nothing.
--
-- Read and written by api/practice.js with the service key only, so
-- there is no policy: students cannot read or change it directly.
-- ================================================================

CREATE TABLE IF NOT EXISTS public.practice_seen (
  student_id   UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  teacher_id   UUID NOT NULL REFERENCES public.teachers(id) ON DELETE CASCADE,
  question_key TEXT NOT NULL,
  seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (student_id, question_key)
);

ALTER TABLE public.practice_seen ENABLE ROW LEVEL SECURITY;
