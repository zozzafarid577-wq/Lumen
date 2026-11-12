-- ================================================================
-- Lumen migration v23 — mock exams sat in timed sections
--
-- Safe to run twice. It writes no rows.
--
--   practice_tests.exam_sections  how a mock exam is split, in order:
--                                 [{ "questions": 38, "minutes": 45 }, …].
--                                 Each section is that many questions,
--                                 taken in the order of the paper, with
--                                 its own clock. Once a section is handed
--                                 in the student cannot go back to it —
--                                 the way the real exams run. Empty means
--                                 the paper is one section on the test's
--                                 own time limit.
-- ================================================================

ALTER TABLE public.practice_tests ADD COLUMN IF NOT EXISTS exam_sections JSONB;
